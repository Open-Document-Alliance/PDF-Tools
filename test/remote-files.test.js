import { createHash, randomBytes } from "node:crypto";
import { createMcpHandler } from "@modelcontextprotocol/server";
import { PDFDocument } from "pdf-lib";
import { describe, expect, it } from "vitest";

import { createMemoryFileStore, fileStoreFromEnv, transferStoreFromEnv } from "../remote/file-store.mjs";
import { createFilesHandler, DOWNLOAD_SECONDS, MAX_UPLOAD_BYTES, MIN_UPLOAD_TARGET_SECONDS, STATE_SECONDS, UPLOAD_TARGET_SECONDS } from "../remote/files.mjs";
import { handleSweepRequest, MISSED_RUNS_TOLERATED, RETENTION_PROMISE_MS, SWEEP_INTERVAL_MS, SWEEP_MAX_AGE_MS, SWEEP_SCHEDULE, sweepTransfers } from "../remote/files-sweeper.mjs";
import { handleMcpFetch } from "../remote/http.mjs";
import { parseSealingKeys } from "../remote/sealed.mjs";
import { createRemoteServer } from "../remote/server.mjs";

const MODERN = "2026-07-28";
const KEYS = parseSealingKeys(`f1:${"a1".repeat(32)}`);

function meta(files) {
  return {
    "io.modelcontextprotocol/protocolVersion": MODERN,
    "io.modelcontextprotocol/clientInfo": { name: "synthetic-files-test", version: "0" },
    "io.modelcontextprotocol/clientCapabilities": files ? { extensions: { "io.modelcontextprotocol/files": files } } : {},
  };
}

function client(fetchImpl) {
  let id = 0;
  return async (method, params = {}, { files = { upload: {}, download: {} } } = {}) => {
    const body = { jsonrpc: "2.0", id: ++id, method, params: { ...params, _meta: meta(files) } };
    const headers = { "content-type": "application/json", accept: "application/json, text/event-stream", "mcp-protocol-version": MODERN, "mcp-method": method };
    if (params.name) headers["mcp-name"] = params.name;
    const response = await fetchImpl(new Request("http://localhost/mcp", { method: "POST", headers, body: JSON.stringify(body) }));
    const raw = await response.text();
    const data = raw.startsWith("{") ? raw : raw.split(/\r?\n/).filter(line => line.startsWith("data: ")).map(line => line.slice(6)).join("");
    return JSON.parse(data);
  };
}

function withFiles() {
  const store = createMemoryFileStore();
  const files = createFilesHandler({ store, keys: KEYS });
  const handler = createMcpHandler(({ era }) => createRemoteServer({ era, files }));
  return { store, rpc: client(request => handler.fetch(request)) };
}

async function syntheticPdf(pages = 2, padTo = 0) {
  const doc = await PDFDocument.create();
  doc.setTitle("SYNTHETIC FILES TEST");
  for (let index = 0; index < pages; index++) doc.addPage([612, 792]);
  if (padTo) await doc.attach(randomBytes(padTo), "padding.bin", { mimeType: "application/octet-stream" });
  return Buffer.from(await doc.save({ useObjectStreams: false }));
}

const keyFromUrl = url => decodeURIComponent(new URL(url).pathname.split("/").pop());
const sha256b64url = bytes => createHash("sha256").update(bytes).digest("base64url");

describe("MCP Files extension, switched off", () => {
  it("is not advertised and adds no upload argument by default", async () => {
    const rpc = client(handleMcpFetch);
    const discover = await rpc("server/discover");
    expect(discover.result.capabilities.extensions?.["io.modelcontextprotocol/files"]).toBeUndefined();
    const tools = (await rpc("tools/list")).result.tools;
    expect(tools.some(tool => tool.inputSchema.properties.upload)).toBe(false);
    expect(fileStoreFromEnv({ PDF_TOOLS_FILES_ENABLED: "1" })).toBeNull();
  });
});

describe("MCP Files extension, switched on with a test store", () => {
  it("advertises uploads and adds an x-mcp-file argument to single-document tools", async () => {
    const { rpc } = withFiles();
    expect((await rpc("server/discover")).result.capabilities.extensions["io.modelcontextprotocol/files"]).toEqual({ upload: {} });
    const tools = (await rpc("tools/list")).result.tools;
    const info = tools.find(tool => tool.name === "get_pdf_info");
    expect(info.inputSchema.properties.upload["x-mcp-file"]).toEqual({ accept: ["application/pdf"], maxSize: MAX_UPLOAD_BYTES });
    expect(tools.find(tool => tool.name === "merge_pdfs").inputSchema.properties.upload).toBeUndefined();
  });

  it("takes a PDF larger than the inline limit through upload_required, then runs on exactly those bytes once", async () => {
    const { store, rpc } = withFiles();
    const bytes = await syntheticPdf(3, 4 * 1024 * 1024);
    expect(bytes.length).toBeGreaterThan(4 * 1024 * 1024);
    const args = { upload: { id: "file-1", name: "synthetic.pdf", mimeType: "application/pdf", size: bytes.length, digest: { algorithm: "sha-256", value: sha256b64url(bytes) } } };
    const first = await rpc("tools/call", { name: "get_pdf_info", arguments: args });
    expect(first.result.resultType).toBe("upload_required");
    expect(first.result.content).toEqual([]);
    const [target] = first.result.uploads;
    expect(target).toMatchObject({ fileId: "file-1", method: "PUT", credentials: "omit" });
    expect(first.result.requestState).toMatch(/^ods1\./);

    store.acceptUpload(keyFromUrl(target.url), bytes);
    const second = await rpc("tools/call", { name: "get_pdf_info", arguments: args, requestState: first.result.requestState });
    expect(second.result.isError).toBeFalsy();
    expect(second.result.structuredContent.source.page_count).toBe(3);
    expect(second.result.structuredContent.source.size_bytes).toBe(bytes.length);
    expect(store.size()).toBe(0);

    const replay = await rpc("tools/call", { name: "get_pdf_info", arguments: args, requestState: first.result.requestState });
    expect(replay.error?.code).toBe(-32602);
  });

  it("refuses a repeat that changes the call, and bytes that do not match the declaration", async () => {
    const { store, rpc } = withFiles();
    const bytes = await syntheticPdf(1);
    const args = { upload: { id: "file-1", mimeType: "application/pdf", size: bytes.length } };
    const first = await rpc("tools/call", { name: "get_pdf_info", arguments: args });
    store.acceptUpload(keyFromUrl(first.result.uploads[0].url), bytes);
    const otherTool = await rpc("tools/call", { name: "read_form_fields", arguments: args, requestState: first.result.requestState });
    expect(otherTool.error?.code).toBe(-32602);
    const otherArgs = await rpc("tools/call", { name: "get_pdf_info", arguments: { upload: { ...args.upload, id: "file-2" } }, requestState: first.result.requestState });
    expect(otherArgs.error?.code).toBe(-32602);

    const second = await rpc("tools/call", { name: "get_pdf_info", arguments: { upload: { id: "x", mimeType: "application/pdf", size: bytes.length + 1 } } });
    store.acceptUpload(keyFromUrl(second.result.uploads[0].url), bytes);
    const mismatch = await rpc("tools/call", { name: "get_pdf_info", arguments: { upload: { id: "x", mimeType: "application/pdf", size: bytes.length + 1 } }, requestState: second.result.requestState });
    expect(mismatch.result.content[0].text).toMatch(/^UPLOAD_MISMATCH/);
  });

  it("refuses uploads the client did not declare, wrong types, and oversized files before issuing a target", async () => {
    const { store, rpc } = withFiles();
    const undeclared = await rpc("tools/call", { name: "get_pdf_info", arguments: { upload: { id: "a", mimeType: "application/pdf", size: 10 } } }, { files: { download: {} } });
    expect(undeclared.result.content[0].text).toMatch(/^UPLOAD_UNSUPPORTED/);
    const wrongType = await rpc("tools/call", { name: "get_pdf_info", arguments: { upload: { id: "a", mimeType: "image/png", size: 10 } } });
    expect(wrongType.result.content[0].text).toMatch(/^INVALID_UPLOAD/);
    const tooBig = await rpc("tools/call", { name: "get_pdf_info", arguments: { upload: { id: "a", mimeType: "application/pdf", size: MAX_UPLOAD_BYTES + 1 } } });
    expect(tooBig.result.content[0].text).toMatch(/^INVALID_UPLOAD/);
    const both = await rpc("tools/call", { name: "get_pdf_info", arguments: { upload: { id: "a", mimeType: "application/pdf", size: 10 }, pdf_url: "https://example.com/a.pdf" } });
    expect(both.result.content[0].text).toMatch(/^AMBIGUOUS_INPUT/);
    expect(store.size()).toBe(0);
  });

  it("returns a new PDF as a download target, not inline bytes, when the client declared download", async () => {
    const { store, rpc } = withFiles();
    const bytes = await syntheticPdf(3);
    const result = await rpc("tools/call", { name: "select_pdf_pages", arguments: { pdf_base64: bytes.toString("base64"), page_numbers: [3, 1] } });
    expect(result.result.isError).toBeFalsy();
    expect(result.result.structuredContent.pdf_base64).toBeUndefined();
    const [download] = result.result._meta["io.modelcontextprotocol/files"].downloads;
    expect(download).toMatchObject({ mimeType: "application/pdf", credentials: "omit" });
    expect(JSON.stringify(result.result.content)).not.toContain(download.url);
    const fetched = store.fetchDownload(keyFromUrl(download.url));
    expect(fetched.length).toBe(download.size);
    expect(sha256b64url(fetched)).toBe(download.digest.value);
    expect((await PDFDocument.load(fetched)).getPageCount()).toBe(2);
  });

  it("keeps results inline when the client did not declare download", async () => {
    const { rpc } = withFiles();
    const bytes = await syntheticPdf(2);
    const result = await rpc("tools/call", { name: "select_pdf_pages", arguments: { pdf_base64: bytes.toString("base64"), page_numbers: [2] } }, { files: { upload: {} } });
    expect(result.result.structuredContent.pdf_base64).toBeTruthy();
    expect(result.result._meta?.["io.modelcontextprotocol/files"]).toBeUndefined();
  });
});

describe("MCP Files: single write, upload tool set, and target lifetime", () => {
  it("keeps the upload URL write-once after the upload is used, and holds no PDF bytes after use", async () => {
    const { store, rpc } = withFiles();
    const bytes = await syntheticPdf(1);
    const args = { upload: { id: "file-1", mimeType: "application/pdf", size: bytes.length } };
    const first = await rpc("tools/call", { name: "get_pdf_info", arguments: args });
    const key = keyFromUrl(first.result.uploads[0].url);
    store.acceptUpload(key, bytes);
    const second = await rpc("tools/call", { name: "get_pdf_info", arguments: args, requestState: first.result.requestState });
    expect(second.result.isError).toBeFalsy();
    expect(store.size()).toBe(0);
    expect(() => store.acceptUpload(key, bytes)).toThrow(/precondition failed/);
    const replay = await rpc("tools/call", { name: "get_pdf_info", arguments: args, requestState: first.result.requestState });
    expect(replay.error?.code).toBe(-32602);
  });

  it("runs once when two repeats of the same call race", async () => {
    const { store, rpc } = withFiles();
    const bytes = await syntheticPdf(1);
    const args = { upload: { id: "file-1", mimeType: "application/pdf", size: bytes.length } };
    const first = await rpc("tools/call", { name: "get_pdf_info", arguments: args });
    store.acceptUpload(keyFromUrl(first.result.uploads[0].url), bytes);
    const repeats = await Promise.all([1, 2].map(() => rpc("tools/call", { name: "get_pdf_info", arguments: args, requestState: first.result.requestState })));
    expect(repeats.filter(response => response.result && !response.result.isError)).toHaveLength(1);
    expect(repeats.filter(response => response.error?.code === -32602)).toHaveLength(1);
  });

  it("opens the upload flow only for tools that advertise upload, before issuing any target", async () => {
    const { store, rpc } = withFiles();
    const tools = (await rpc("tools/list")).result.tools;
    const advertised = new Set(tools.filter(tool => tool.inputSchema.properties.upload).map(tool => tool.name));
    expect(advertised.has("merge_pdfs")).toBe(false);
    const upload = { id: "a", mimeType: "application/pdf", size: 10 };
    for (const name of ["merge_pdfs", "no_such_tool"]) {
      const response = await rpc("tools/call", { name, arguments: { upload } });
      expect(response.result.isError).toBe(true);
      expect(response.result.content[0].text).toMatch(/^UPLOAD_UNSUPPORTED_TOOL/);
      expect(response.result.resultType).not.toBe("upload_required");
      expect(response.result.uploads).toBeUndefined();
    }
    expect(store.keys()).toEqual([]);
  });

  it("is not offered on the signing route, even if a store is passed", async () => {
    const files = createFilesHandler({ store: createMemoryFileStore(), keys: KEYS });
    const handler = createMcpHandler(({ era }) => createRemoteServer({ era, files, signing: { luminAccessToken: "synthetic-not-used" } }));
    const rpc = client(request => handler.fetch(request));
    expect((await rpc("server/discover")).result.capabilities.extensions?.["io.modelcontextprotocol/files"]).toBeUndefined();
    const tools = (await rpc("tools/list")).result.tools;
    expect(tools.some(tool => tool.name === "send_lumin_request")).toBe(true);
    expect(tools.some(tool => tool.inputSchema.properties.upload)).toBe(false);
  });

  it("states an upload expiry at least 20 minutes after the response, with margin", async () => {
    const { rpc } = withFiles();
    const before = Date.now();
    const first = await rpc("tools/call", { name: "get_pdf_info", arguments: { upload: { id: "a", mimeType: "application/pdf", size: 10 } } });
    const expires = Date.parse(first.result.uploads[0].expiresAt);
    expect(UPLOAD_TARGET_SECONDS).toBeGreaterThanOrEqual(MIN_UPLOAD_TARGET_SECONDS + 4 * 60);
    expect(expires - Date.now()).toBeGreaterThanOrEqual((MIN_UPLOAD_TARGET_SECONDS + 4 * 60) * 1000);
    expect(expires - before).toBeLessThanOrEqual(UPLOAD_TARGET_SECONDS * 1000);
  });
});

describe("MCP Files transfer sweeper", () => {
  const MINUTE = 60 * 1000;

  it("deletes within 2 hours even after missed runs, and never before a session or download can end", () => {
    expect(SWEEP_MAX_AGE_MS + (MISSED_RUNS_TOLERATED + 1) * SWEEP_INTERVAL_MS).toBeLessThanOrEqual(RETENTION_PROMISE_MS);
    expect(MISSED_RUNS_TOLERATED).toBeGreaterThanOrEqual(3);
    expect(STATE_SECONDS * 1000 + 5 * MINUTE).toBeLessThanOrEqual(SWEEP_MAX_AGE_MS);
    expect(DOWNLOAD_SECONDS * 1000 + 5 * MINUTE).toBeLessThanOrEqual(SWEEP_MAX_AGE_MS);
    expect(UPLOAD_TARGET_SECONDS).toBeLessThan(STATE_SECONDS);
    expect(SWEEP_INTERVAL_MS).toBe(10 * MINUTE);
  });

  it("deletes old Files objects, claims and tombstones included, and keeps newer ones", async () => {
    let now = 0;
    const store = createMemoryFileStore({ clock: () => now });
    await store.presignUpload("up/old", { size: 3, mimeType: "application/pdf", lifetimeSeconds: 60 });
    store.acceptUpload("up/old", [1, 2, 3]);
    expect(await store.take("up/old")).not.toBeNull();
    now = 30 * MINUTE;
    await store.putResult("dl/new", [4, 5]);
    now = 66 * MINUTE;
    expect(await sweepTransfers(store, { now })).toMatchObject({ deleted: 2, kept: 1, late: false });
    expect(store.keys()).toEqual(["dl/new"]);
    now = 140 * MINUTE;
    expect(await sweepTransfers(store, { now })).toMatchObject({ deleted: 1, kept: 0, late: true });
    expect(store.keys()).toEqual([]);
  });

  it("lists only the Files prefixes and never deletes anything else in the bucket", async () => {
    const listed = [];
    const deleted = [];
    const store = {
      async *list(prefix) {
        listed.push(prefix);
        yield { key: `${prefix}x`, lastModified: 0 };
      },
      async delete(keys) { deleted.push(...keys); },
    };
    await sweepTransfers(store, { now: 200 * MINUTE });
    expect(listed).toEqual(["up/", "dl/", "claimed/"]);
    expect(deleted).toEqual(["up/x", "dl/x", "claimed/x"]);
  });

  it("deletes in batches the S3 API accepts", async () => {
    const deletes = [];
    const keys = Array.from({ length: 2500 }, (_, index) => `up/${index}`);
    const store = {
      async *list(prefix) { if (prefix === "up/") for (const key of keys) yield { key, lastModified: 0 }; },
      async delete(batch) { deletes.push(batch.length); },
    };
    expect(await sweepTransfers(store, { now: 200 * MINUTE })).toMatchObject({ deleted: 2500, kept: 0 });
    expect(deletes).toEqual([1000, 1000, 500]);
  });

  it("answers without storage when no bucket is connected, and fails closed without the cron secret", async () => {
    const get = headers => new Request("http://localhost/api/files-sweep", { headers });
    const none = await handleSweepRequest(get(), { store: null, env: {} });
    expect(none.status).toBe(200);
    expect(await none.json()).toEqual({ files: "no_bucket" });

    const store = createMemoryFileStore({ clock: () => 0 });
    await store.putResult("dl/x", [1]);
    const logged = [];
    const log = line => logged.push(line);
    const unset = await handleSweepRequest(get(), { store, env: {}, now: 200 * MINUTE, log });
    expect(unset.status).toBe(503);
    expect(logged.join("\n")).toMatch(/ERROR files sweep refused/);
    expect(store.size()).toBe(1);

    const wrong = await handleSweepRequest(get({ authorization: "Bearer nope" }), { store, env: { CRON_SECRET: "s3cret-for-tests" }, now: 200 * MINUTE });
    expect(wrong.status).toBe(401);
    expect(store.size()).toBe(1);

    const right = await handleSweepRequest(get({ authorization: "Bearer s3cret-for-tests" }), { store, env: { CRON_SECRET: "s3cret-for-tests" }, now: 200 * MINUTE, log, info: () => {} });
    expect(right.status).toBe(200);
    const body = await right.json();
    expect(body).toMatchObject({ files: "swept", deleted: 1, kept: 0, late: true });
    expect(JSON.stringify(body)).not.toContain("dl/");
    expect(logged.at(-1)).toMatch(/ERROR files sweep found objects 200 minutes old; scheduled runs were missed/);
    expect(store.size()).toBe(0);
  });

  it("keeps sweeping with Files switched off, and Files cannot switch on without the cleanup", async () => {
    const bucket = { S3_BUCKET_NAME: "synthetic-bucket", AWS_REGION: "us-east-1", AWS_ROLE_ARN: "arn:aws:iam::000000000000:role/synthetic" };
    expect(transferStoreFromEnv(bucket)?.kind).toBe("s3");
    expect(transferStoreFromEnv({ ...bucket, PDF_TOOLS_FILES_ENABLED: "0" })?.kind).toBe("s3");
    const enabled = { ...bucket, PDF_TOOLS_FILES_ENABLED: "1", PDF_TOOLS_FILES_ORIGIN: "https://files.example.test" };
    expect(fileStoreFromEnv(enabled)).toBeNull();
    expect(fileStoreFromEnv({ ...enabled, CRON_SECRET: "set" })?.kind).toBe("s3");
  });

  it("is scheduled every 10 minutes in the Vercel configuration", async () => {
    const { readFile } = await import("node:fs/promises");
    const config = JSON.parse(await readFile(new URL("../vercel.json", import.meta.url), "utf8"));
    expect(config.crons).toContainEqual({ path: "/api/files-sweep", schedule: SWEEP_SCHEDULE });
    expect(SWEEP_SCHEDULE).toBe("*/10 * * * *");
    expect(config.functions["api/files-sweep.js"]).toBeDefined();
  });
});
