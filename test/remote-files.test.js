import { createHash, randomBytes } from "node:crypto";
import { createMcpHandler } from "@modelcontextprotocol/server";
import { PDFDocument } from "pdf-lib";
import { describe, expect, it } from "vitest";

import { createMemoryFileStore, fileStoreFromEnv } from "../remote/file-store.mjs";
import { createFilesHandler, MAX_UPLOAD_BYTES } from "../remote/files.mjs";
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
