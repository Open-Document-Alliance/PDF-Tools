import { createHash, randomBytes } from "node:crypto";
import { createMcpHandler } from "@modelcontextprotocol/server";
import { PDFDocument } from "pdf-lib";
import { describe, expect, it } from "vitest";

import { presignUrl, signHeaders } from "../remote/aws-s3.mjs";
import { createS3FileStore, fileStoreFromEnv, ROLE_SESSION_SECONDS } from "../remote/file-store.mjs";
import { createFilesHandler, DOWNLOAD_SECONDS, UPLOAD_TARGET_SECONDS } from "../remote/files.mjs";
import { sweepTransfers } from "../remote/files-sweeper.mjs";
import { currentOidcToken, withOidcToken } from "../remote/oidc-context.mjs";
import { parseSealingKeys } from "../remote/sealed.mjs";
import { createRemoteServer } from "../remote/server.mjs";

const BUCKET = "synthetic-test-bucket";
const BUCKET_HOST = `${BUCKET}.s3.us-east-1.amazonaws.com`;
const ORIGIN = "https://files.example.test";
const ROLE = "arn:aws:iam::000000000000:role/synthetic-files-role";
const OIDC = "synthetic-oidc-token";
const KEYS = parseSealingKeys(`f1:${"b2".repeat(32)}`);
const MODERN = "2026-07-28";

/**
 * A small stand-in for STS and one S3 bucket: role sessions of at most an
 * hour (like the Marketplace role), If-None-Match writes, signed-size uploads,
 * claim markers, listing with pagination, and batch delete. It checks that every
 * S3 call is signed with the current session's token, and that presigned
 * uploads carry the headers they were signed with.
 */
function fakeAws({ clock, maxSession = ROLE_SESSION_SECONDS, pageSize = 1000 } = {}) {
  const objects = new Map();
  const sessions = new Map();
  const calls = { sts: 0, s3: [] };
  let issued = 0;

  const xml = (status, body) => new Response(body, { status, headers: { "content-type": "application/xml" } });
  const error = (status, code) => xml(status, `<Error><Code>${code}</Code></Error>`);

  async function fetchImpl(input, init = {}) {
    const url = new URL(input);
    const method = init.method ?? "GET";
    const headers = new Headers(init.headers);
    if (url.hostname === "sts.us-east-1.amazonaws.com") {
      calls.sts += 1;
      const form = new URLSearchParams(String(init.body));
      if (form.get("WebIdentityToken") !== OIDC || form.get("RoleArn") !== ROLE) return error(403, "AccessDenied");
      const seconds = Number(form.get("DurationSeconds"));
      if (seconds > maxSession) return error(400, "ValidationError");
      const id = `ASIASYNTHETIC${++issued}`;
      const token = `session-token-${issued}`;
      const expiresAt = clock() + seconds * 1000;
      sessions.set(id, { token, expiresAt });
      return xml(200, `<AssumeRoleWithWebIdentityResponse><AssumeRoleWithWebIdentityResult><Credentials><AccessKeyId>${id}</AccessKeyId><SecretAccessKey>secret-${issued}</SecretAccessKey><SessionToken>${token}</SessionToken><Expiration>${new Date(expiresAt).toISOString()}</Expiration></Credentials></AssumeRoleWithWebIdentityResult></AssumeRoleWithWebIdentityResponse>`);
    }

    let key = decodeURIComponent(url.pathname.slice(1));
    let accessKey;
    let presigned = false;
    if (url.hostname === new URL(ORIGIN).hostname) {
      // The files host: the Vercel rewrite forwards /up/ and /dl/ to the bucket unchanged.
      if (!/^(up|dl)\//.test(key)) return new Response("not found", { status: 404 });
      presigned = true;
      accessKey = url.searchParams.get("X-Amz-Credential")?.split("/")[0];
      const session = sessions.get(accessKey);
      if (!session || session.token !== url.searchParams.get("X-Amz-Security-Token")) return error(403, "InvalidToken");
      const signedAt = Date.parse(url.searchParams.get("X-Amz-Date").replace(/(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})Z/, "$1-$2-$3T$4:$5:$6Z"));
      if (clock() > signedAt + Number(url.searchParams.get("X-Amz-Expires")) * 1000 || clock() > session.expiresAt) return error(403, "AccessDenied");
      const signed = url.searchParams.get("X-Amz-SignedHeaders").split(";");
      if (method === "PUT") {
        if (signed.join(";") !== "content-length;content-type;host;if-none-match") return error(403, "SignatureDoesNotMatch");
        if (headers.get("if-none-match") !== "*" || headers.get("content-type") !== "application/pdf") return error(403, "SignatureDoesNotMatch");
      }
    } else if (url.hostname === BUCKET_HOST) {
      const auth = headers.get("authorization") ?? "";
      accessKey = auth.match(/Credential=([^/]+)\//)?.[1];
      const session = sessions.get(accessKey);
      if (!session || headers.get("x-amz-security-token") !== session.token || clock() > session.expiresAt) return error(403, "InvalidToken");
    } else {
      throw new Error(`unexpected host ${url.hostname}`);
    }
    calls.s3.push({ method, key: url.pathname === "/" ? url.search : key, presigned });

    if (url.pathname === "/" && method === "GET") {
      const prefix = url.searchParams.get("prefix") ?? "";
      if (!prefix) return error(400, "PrefixRequiredByThisTest");
      const all = [...objects.keys()].filter(k => k.startsWith(prefix)).sort();
      const start = Number(url.searchParams.get("continuation-token") ?? 0);
      const page = all.slice(start, start + pageSize);
      const truncated = start + pageSize < all.length;
      return xml(200, `<ListBucketResult>${page.map(k => `<Contents><Key>${k.replace(/&/g, "&amp;")}</Key><LastModified>${new Date(objects.get(k).modified).toISOString()}</LastModified></Contents>`).join("")}<IsTruncated>${truncated}</IsTruncated>${truncated ? `<NextContinuationToken>${start + pageSize}</NextContinuationToken>` : ""}</ListBucketResult>`);
    }
    if (url.pathname === "/" && method === "POST" && url.searchParams.has("delete")) {
      const body = String(init.body);
      if (headers.get("content-md5") !== createHash("md5").update(body).digest("base64")) return error(400, "InvalidDigest");
      for (const [, k] of body.matchAll(/<Key>(.*?)<\/Key>/g)) objects.delete(k.replace(/&amp;/g, "&"));
      return xml(200, "<DeleteResult></DeleteResult>");
    }
    if (method === "PUT") {
      const body = init.body === undefined ? new Uint8Array(0) : new Uint8Array(await new Response(init.body).arrayBuffer());
      if (headers.get("if-none-match") === "*" && objects.has(key)) return error(412, "PreconditionFailed");
      if (headers.has("content-length") && Number(headers.get("content-length")) !== body.length) return error(400, "IncompleteBody");
      objects.set(key, { bytes: body, modified: clock() });
      return new Response(null, { status: 200 });
    }
    const object = objects.get(key);
    if (method === "HEAD") return object ? new Response(null, { status: 200, headers: { "content-length": String(object.bytes.length) } }) : new Response(null, { status: 404 });
    if (method === "GET") return object ? new Response(object.bytes, { status: 200, headers: { "content-length": String(object.bytes.length) } }) : error(404, "NoSuchKey");
    if (method === "DELETE") { objects.delete(key); return new Response(null, { status: 204 }); }
    return error(405, "MethodNotAllowed");
  }

  return { fetchImpl, objects, calls };
}

function harness({ startAt = Date.UTC(2026, 10, 26, 12), ...options } = {}) {
  let now = startAt;
  const clock = () => now;
  const aws = fakeAws({ clock, ...options });
  const store = createS3FileStore({ bucket: BUCKET, region: "us-east-1", roleArn: ROLE, origin: ORIGIN, oidcToken: () => OIDC, fetchImpl: aws.fetchImpl, clock });
  return { aws, store, clock, advance: ms => { now += ms; } };
}

/** What Claude does with an upload target: PUT exactly the listed headers, with Content-Length set to the size. */
async function hostUpload(aws, target, bytes) {
  return aws.fetchImpl(target.url, { method: target.method, headers: { ...target.headers, "content-length": String(bytes.length) }, body: bytes });
}

describe("AWS Signature Version 4", () => {
  const credentials = { accessKeyId: "AKIAIOSFODNN7EXAMPLE", secretAccessKey: "wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY" };
  const now = new Date("2013-05-24T00:00:00Z");

  it("matches AWS's published presigned-URL example", () => {
    const url = presignUrl({ method: "GET", host: "examplebucket.s3.amazonaws.com", path: "/test.txt", credentials, region: "us-east-1", expiresIn: 86400, now });
    expect(url).toMatch(/X-Amz-Signature=aeeed9bbccd4d02ee5c0109b86d86835f995330da4c265957d157751f604d404$/);
  });

  it("matches AWS's published Authorization-header example", () => {
    const headers = signHeaders({ method: "GET", host: "examplebucket.s3.amazonaws.com", path: "/test.txt", headers: { range: "bytes=0-9" }, credentials, region: "us-east-1", now });
    expect(headers.authorization).toBe("AWS4-HMAC-SHA256 Credential=AKIAIOSFODNN7EXAMPLE/20130524/us-east-1/s3/aws4_request, SignedHeaders=host;range;x-amz-content-sha256;x-amz-date, Signature=f0e8bdb87c964420e857bd35b5d6ed310bd44f0170aba48dd91039c6036bdb41");
  });
});

describe("Files S3 store configuration", () => {
  const complete = { PDF_TOOLS_FILES_ENABLED: "1", S3_BUCKET_NAME: BUCKET, AWS_REGION: "us-east-1", AWS_ROLE_ARN: ROLE, PDF_TOOLS_FILES_ORIGIN: ORIGIN, CRON_SECRET: "synthetic" };

  it("is selected only when enabled with a complete configuration and an https origin", () => {
    expect(fileStoreFromEnv({ ...complete, PDF_TOOLS_FILES_ENABLED: undefined })).toBeNull();
    for (const missing of ["S3_BUCKET_NAME", "AWS_REGION", "AWS_ROLE_ARN", "PDF_TOOLS_FILES_ORIGIN", "CRON_SECRET"]) {
      expect(fileStoreFromEnv({ ...complete, [missing]: undefined })).toBeNull();
    }
    for (const origin of ["http://files.example.test", "https://files.example.test/", "https://files.example.test/path", "https://localhost"]) {
      expect(fileStoreFromEnv({ ...complete, PDF_TOOLS_FILES_ORIGIN: origin })).toBeNull();
    }
    expect(fileStoreFromEnv(complete).kind).toBe("s3");
  });

  it("takes the OIDC token from the request being served, without leaking it between requests", async () => {
    const request = new Request("https://mcp.example.test/mcp", { headers: { "x-vercel-oidc-token": "per-request" } });
    expect(await withOidcToken(request, async () => currentOidcToken({}))).toBe("per-request");
    expect(currentOidcToken({})).toBeNull();
    expect(currentOidcToken({ VERCEL_OIDC_TOKEN: "local" })).toBe("local");
  });

  it("refuses to work without a token, and reports AWS failures by code only", async () => {
    const aws = fakeAws({ clock: Date.now });
    const noToken = createS3FileStore({ bucket: BUCKET, region: "us-east-1", roleArn: ROLE, origin: ORIGIN, oidcToken: () => null, fetchImpl: aws.fetchImpl });
    await expect(noToken.head("up/x")).rejects.toThrow(/OIDC token/);
    const wrongToken = createS3FileStore({ bucket: BUCKET, region: "us-east-1", roleArn: ROLE, origin: ORIGIN, oidcToken: () => "not-the-token", fetchImpl: aws.fetchImpl });
    const failure = await wrongToken.head("up/x").catch(error => error);
    expect(failure).toMatchObject({ name: "AwsError", code: "AccessDenied", status: 403 });
    expect(failure.message).not.toContain("not-the-token");
  });
});

describe("Files S3 store", () => {
  it("presigns one write of exactly the declared size on the files host, never the bucket host", async () => {
    const { aws, store, clock } = harness();
    const target = await store.presignUpload("up/abc", { size: 10, mimeType: "application/pdf", lifetimeSeconds: UPLOAD_TARGET_SECONDS });
    const signedAt = Date.parse(new URL(target.url).searchParams.get("X-Amz-Date").replace(/(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})Z/, "$1-$2-$3T$4:$5:$6Z")) / 1000;
    expect(target.expiresAt).toBe(signedAt + UPLOAD_TARGET_SECONDS);
    const url = new URL(target.url);
    expect(url.origin).toBe(ORIGIN);
    expect(url.pathname).toBe("/up/abc");
    expect(target.url).not.toContain(BUCKET);
    expect(url.searchParams.get("X-Amz-SignedHeaders")).toBe("content-length;content-type;host;if-none-match");
    expect(url.searchParams.get("X-Amz-Expires")).toBe(String(UPLOAD_TARGET_SECONDS));
    expect(target).toMatchObject({ method: "PUT", headers: { "Content-Type": "application/pdf", "If-None-Match": "*" } });

    const bytes = randomBytes(10);
    expect((await hostUpload(aws, target, bytes)).status).toBe(200);
    expect((await hostUpload(aws, target, bytes)).status).toBe(412);
    expect(await store.head("up/abc")).toEqual({ size: 10 });
  });

  it("keeps every URL inside the one-hour role session, and cannot sign the 75 minutes several uploads need", async () => {
    const { aws, store, clock, advance } = harness();
    const seconds = () => Math.floor(clock() / 1000);
    await store.presignUpload("up/a", { size: 1, mimeType: "application/pdf", lifetimeSeconds: UPLOAD_TARGET_SECONDS });
    await store.presignUpload("up/b", { size: 1, mimeType: "application/pdf", lifetimeSeconds: UPLOAD_TARGET_SECONDS });
    await store.presignDownload("dl/a", { lifetimeSeconds: DOWNLOAD_SECONDS });
    expect(aws.calls.sts).toBe(1);

    advance(10 * 60 * 1000);
    await store.presignUpload("up/c", { size: 1, mimeType: "application/pdf", lifetimeSeconds: UPLOAD_TARGET_SECONDS });
    expect(aws.calls.sts).toBe(1);
    await store.presignDownload("dl/b", { lifetimeSeconds: DOWNLOAD_SECONDS });
    expect(aws.calls.sts).toBe(2);

    await expect(store.presignUpload("up/d", { size: 1, mimeType: "application/pdf", lifetimeSeconds: 75 * 60 })).rejects.toThrow(/session is shorter/);
  });

  it("takes an upload at most once, even when two repeats race", async () => {
    const { aws, store, clock } = harness();
    const target = await store.presignUpload("up/race", { size: 4, mimeType: "application/pdf", lifetimeSeconds: 600 });
    await hostUpload(aws, target, new Uint8Array([1, 2, 3, 4]));
    const results = await Promise.all([store.take("up/race"), store.take("up/race")]);
    expect(results.filter(Boolean)).toHaveLength(1);
    expect([...results.find(Boolean)]).toEqual([1, 2, 3, 4]);
    expect(aws.objects.get("up/race").bytes.length).toBe(0);
    expect(await store.take("up/race")).toBeNull();
    expect((await hostUpload(aws, target, new Uint8Array([5, 6, 7, 8]))).status).toBe(412);
    expect(aws.objects.get("up/race").bytes.length).toBe(0);
  });

  it("writes results once and serves them as attachments through the files host", async () => {
    const { aws, store, clock } = harness();
    await store.putResult("dl/r", new Uint8Array([9, 9]), { mimeType: "application/pdf" });
    await expect(store.putResult("dl/r", new Uint8Array([1]), { mimeType: "application/pdf" })).rejects.toThrow(/already exists/);
    const { url } = await store.presignDownload("dl/r", { lifetimeSeconds: DOWNLOAD_SECONDS });
    const parsed = new URL(url);
    expect(parsed.origin).toBe(ORIGIN);
    expect(parsed.searchParams.get("response-content-disposition")).toBe("attachment");
    expect(parsed.searchParams.get("response-cache-control")).toBe("private, no-store");
    const response = await aws.fetchImpl(url);
    expect([...new Uint8Array(await response.arrayBuffer())]).toEqual([9, 9]);
  });

  it("lets the sweeper list every page and delete in batches, claim markers included", async () => {
    const { aws, store, advance } = harness({ pageSize: 2 });
    await store.putResult("dl/1", new Uint8Array([1]));
    await store.putResult("dl/2", new Uint8Array([2]));
    await store.putResult("dl/a&b", new Uint8Array([3]));
    await store.putResult("up/x", new Uint8Array([4]));
    expect(await store.take("up/x")).not.toBeNull();
    expect([...aws.objects.keys()]).toContain("claimed/up/x");
    advance(106 * 60 * 1000);
    await store.putResult("dl/new", new Uint8Array([5]));
    aws.objects.set("unrelated/keep", { bytes: new Uint8Array([7]), modified: 0 });
    expect(await sweepTransfers(store, { now: Date.UTC(2026, 10, 26, 12) + 106 * 60 * 1000 })).toMatchObject({ deleted: 5, kept: 1 });
    expect([...aws.objects.keys()].sort()).toEqual(["dl/new", "unrelated/keep"]);
  });
});

describe("Files over S3, end to end through the MCP handler", () => {
  async function syntheticPdf(pages) {
    const doc = await PDFDocument.create();
    for (let index = 0; index < pages; index++) doc.addPage([612, 792]);
    return Buffer.from(await doc.save({ useObjectStreams: false }));
  }
  function rpcFor(files) {
    const handler = createMcpHandler(({ era }) => createRemoteServer({ era, files }));
    let id = 0;
    return async (name, args, requestState) => {
      const params = { name, arguments: args, ...(requestState ? { requestState } : {}), _meta: {
        "io.modelcontextprotocol/protocolVersion": MODERN,
        "io.modelcontextprotocol/clientInfo": { name: "synthetic-files-s3-test", version: "0" },
        "io.modelcontextprotocol/clientCapabilities": { extensions: { "io.modelcontextprotocol/files": { upload: {}, download: {} } } },
      } };
      const response = await handler.fetch(new Request("http://localhost/mcp", {
        method: "POST",
        headers: { "content-type": "application/json", accept: "application/json, text/event-stream", "mcp-protocol-version": MODERN, "mcp-method": "tools/call", "mcp-name": name },
        body: JSON.stringify({ jsonrpc: "2.0", id: ++id, method: "tools/call", params }),
      }));
      const raw = await response.text();
      return JSON.parse(raw.startsWith("{") ? raw : raw.split(/\r?\n/).filter(line => line.startsWith("data: ")).map(line => line.slice(6)).join(""));
    };
  }

  it("uploads, runs once on the exact bytes, refuses a replay, and returns a downloadable PDF", async () => {
    const { aws, store } = harness({ startAt: Date.now() });
    const rpc = rpcFor(createFilesHandler({ store, keys: KEYS }));
    const bytes = await syntheticPdf(3);
    const digest = createHash("sha256").update(bytes).digest("base64url");
    const args = { upload: { id: "f1", mimeType: "application/pdf", size: bytes.length, digest: { algorithm: "sha-256", value: digest } } };

    const first = await rpc("get_pdf_info", args);
    expect(first.result.resultType).toBe("upload_required");
    const [target] = first.result.uploads;
    expect(new URL(target.url).origin).toBe(ORIGIN);
    expect((await hostUpload(aws, target, bytes)).status).toBe(200);

    const second = await rpc("get_pdf_info", args, first.result.requestState);
    expect(second.result.isError).toBeFalsy();
    expect(second.result.structuredContent.source.page_count).toBe(3);
    expect([...aws.objects].filter(([key, object]) => key.startsWith("up/") && object.bytes.length > 0)).toEqual([]);
    expect((await rpc("get_pdf_info", args, first.result.requestState)).error?.code).toBe(-32602);

    const selectArgs = { upload: { id: "f2", mimeType: "application/pdf", size: bytes.length }, page_numbers: [3, 1] };
    const selectFirst = await rpc("select_pdf_pages", selectArgs);
    await hostUpload(aws, selectFirst.result.uploads[0], bytes);
    const selected = await rpc("select_pdf_pages", selectArgs, selectFirst.result.requestState);
    const [download] = selected.result._meta["io.modelcontextprotocol/files"].downloads;
    expect(new URL(download.url).origin).toBe(ORIGIN);
    const fetched = new Uint8Array(await (await aws.fetchImpl(download.url)).arrayBuffer());
    expect(fetched.length).toBe(download.size);
    expect(createHash("sha256").update(fetched).digest("base64url")).toBe(download.digest.value);
    expect((await PDFDocument.load(fetched)).getPageCount()).toBe(2);
  });

  it("refuses bytes that do not match the declared digest, and processes nothing", async () => {
    const { aws, store } = harness({ startAt: Date.now() });
    const rpc = rpcFor(createFilesHandler({ store, keys: KEYS }));
    const bytes = await syntheticPdf(1);
    const args = { upload: { id: "f1", mimeType: "application/pdf", size: bytes.length, digest: { algorithm: "sha-256", value: "A".repeat(43) } } };
    const first = await rpc("get_pdf_info", args);
    await hostUpload(aws, first.result.uploads[0], bytes);
    const second = await rpc("get_pdf_info", args, first.result.requestState);
    expect(second.result.isError).toBe(true);
    expect(second.result.content[0].text).toMatch(/^UPLOAD_MISMATCH/);
    expect([...aws.objects].filter(([key, object]) => key.startsWith("up/") && object.bytes.length > 0)).toEqual([]);
  });
});

describe("files.opendocuments.ai proxy configuration", () => {
  it("exposes only the upload and download prefixes, to one dotless bucket, uncached", async () => {
    const { readFile } = await import("node:fs/promises");
    const config = JSON.parse(await readFile(new URL("../files-host/vercel.json", import.meta.url), "utf8"));
    expect(config.rewrites.map(rule => rule.source)).toEqual(["/up/:path*", "/dl/:path*"]);
    const hosts = new Set(config.rewrites.map(rule => new URL(rule.destination.replace(":path*", "x")).host));
    expect(hosts.size).toBe(1);
    const [host] = hosts;
    expect(host).toMatch(/^[a-z0-9-]+\.s3\.us-east-1\.amazonaws\.com$/);
    for (const rule of config.rewrites) {
      const prefix = rule.source.split("/")[1];
      expect(rule.destination).toBe(`https://${host}/${prefix}/:path*`);
    }
    expect(config.redirects).toBeUndefined();
    expect(config.trailingSlash).toBeUndefined();
    for (const source of ["/up/:path*", "/dl/:path*"]) {
      const headers = Object.fromEntries(config.headers.find(rule => rule.source === source).headers.map(({ key, value }) => [key, value]));
      expect(headers).toMatchObject({ "Cache-Control": "private, no-store", "Vercel-CDN-Cache-Control": "no-store" });
    }
  });
});
