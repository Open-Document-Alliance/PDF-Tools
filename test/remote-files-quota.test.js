import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { createMcpHandler } from "@modelcontextprotocol/server";
import { PDFDocument } from "pdf-lib";
import { afterEach, describe, expect, it, vi } from "vitest";

import { createMemoryFileStore } from "../remote/file-store.mjs";
import { createIssuanceQuota, issuanceQuotaFromEnv, parseQuotaRules, QUOTA_GLOBAL_KEY } from "../remote/files-quota.mjs";
import { createFilesHandler } from "../remote/files.mjs";
import { currentRequestHeaders, withOidcToken } from "../remote/oidc-context.mjs";
import { parseSealingKeys } from "../remote/sealed.mjs";
import { createRemoteServer } from "../remote/server.mjs";
import { checkRateLimit } from "../remote/vendor/vercel-firewall-1.2.6/rate-limit.cjs";

const MODERN = "2026-07-28";
const KEYS = parseSealingKeys(`q1:${"c3".repeat(32)}`);
const REQUEST_HEADERS = new Headers({
  host: "mcp.example.test", "x-real-ip": "203.0.113.7", "x-forwarded-for": "203.0.113.7", "x-vercel-ja4-digest": "t13d1516h2_synthetic",
  authorization: "Bearer must-not-forward", "x-vercel-oidc-token": "must-not-forward", cookie: "other=must-not-forward; _vercel_jwt=synthetic-jwt",
});

describe("Vendored @vercel/firewall 1.2.6", () => {
  it("is byte-identical to the files recorded from the npm tarball", () => {
    const dir = new URL("../remote/vendor/vercel-firewall-1.2.6/", import.meta.url);
    const provenance = JSON.parse(readFileSync(new URL("provenance.json", dir), "utf8"));
    expect(provenance).toMatchObject({ package: "@vercel/firewall", version: "1.2.6", license: "Apache-2.0" });
    expect(provenance.tarballIntegrity).toBe("sha512-89ybsa2rnVNdw6RI3jGOVvqUJaBj6Umm4IagC1o3PKtr/MXxBKOLek+yyUgF0csA0O5W+dzcpdIhKxVXhgVVtA==");
    for (const [name, { sha256 }] of Object.entries(provenance.files)) {
      expect(createHash("sha256").update(readFileSync(new URL(name, dir))).digest("hex")).toBe(sha256);
    }
  });

  describe("talks to the firewall the way the quota assumes", () => {
    afterEach(() => vi.unstubAllGlobals());
    const call = async (status, options = {}) => {
      const seen = [];
      vi.stubGlobal("fetch", async (url, init) => { seen.push({ url, headers: init.headers }); return new Response(null, { status }); });
      const result = await checkRateLimit("files-upload-ip", { headers: new Headers({ host: "mcp.example.test", "x-real-ip": "203.0.113.7" }), firewallHostForDevelopment: "ignore-for-testing", ...options });
      return { result, seen };
    };
    it("asks the request's own host, keyed by client address unless a key is given", async () => {
      const { result, seen } = await call(204);
      expect(result).toEqual({ rateLimited: false });
      expect(seen[0].url).toBe("https://mcp.example.test/.well-known/vercel/rate-limit-api/files-upload-ip");
      expect(seen[0].headers.get("x-vercel-rate-limit-key")).toMatch(/^203\.0\.113\.7-[0-9a-f]{64}$/);
      const global = await call(204, { rateLimitKey: QUOTA_GLOBAL_KEY });
      expect(global.seen[0].headers.get("x-vercel-rate-limit-key").startsWith(`${QUOTA_GLOBAL_KEY}-`)).toBe(true);
    });
    it("reports 429 as limited, 403 as blocked, and an unknown rule as not limited (fail-open, which the quota closes)", async () => {
      expect((await call(429)).result).toEqual({ rateLimited: true });
      expect((await call(403)).result).toEqual({ rateLimited: true, error: "blocked" });
      expect((await call(404)).result).toEqual({ rateLimited: false, error: "not-found" });
      await expect(call(500)).rejects.toThrow(/Unexpected rate-limit API response/);
    });
  });
});

describe("Files upload issuance quota", () => {
  const ctx = fn => withOidcToken(new Request("https://mcp.example.test/mcp", { headers: REQUEST_HEADERS }), fn);

  it("parses rule lists and refuses malformed ones", () => {
    expect(parseQuotaRules("files-upload-ip:ip,files-upload-global:global")).toEqual([{ id: "files-upload-ip", scope: "ip" }, { id: "files-upload-global", scope: "global" }]);
    for (const bad of [undefined, "", "x", "files:user", "Files:ip", "a:ip,", ":ip"]) expect(parseQuotaRules(bad)).toBeNull();
    expect(issuanceQuotaFromEnv({})).toBeNull();
    expect(issuanceQuotaFromEnv({ PDF_TOOLS_FILES_QUOTA_RULES: "files-upload-ip:ip" }).rules).toEqual([{ id: "files-upload-ip", scope: "ip" }]);
  });

  it("forwards only what identifies the client, and uses one fixed key for the global rule", async () => {
    const calls = [];
    const quota = createIssuanceQuota({ rules: parseQuotaRules("files-upload-ip:ip,files-upload-global:global"), check: async (id, options) => { calls.push({ id, options }); return { rateLimited: false }; } });
    expect(await ctx(() => quota.admit())).toEqual({ ok: true });
    expect(calls.map(call => call.id)).toEqual(["files-upload-ip", "files-upload-global"]);
    expect(calls[0].options.rateLimitKey).toBeUndefined();
    expect(calls[1].options.rateLimitKey).toBe(QUOTA_GLOBAL_KEY);
    expect(calls[0].options.timeout).toBe(2000);
    const sent = Object.fromEntries(calls[0].options.headers.entries());
    expect(sent).toEqual({ host: "mcp.example.test", "x-real-ip": "203.0.113.7", "x-forwarded-for": "203.0.113.7", "x-vercel-ja4-digest": "t13d1516h2_synthetic", cookie: "_vercel_jwt=synthetic-jwt" });
  });

  it("refuses when any rule is over its limit, and closes on a missing rule, an error, a timeout or no request", async () => {
    const logs = [];
    const log = line => logs.push(line);
    const quotaFor = check => createIssuanceQuota({ rules: parseQuotaRules("files-upload-ip:ip,files-upload-global:global"), check, log });
    expect(await ctx(() => quotaFor(async id => ({ rateLimited: id === "files-upload-global" })).admit())).toEqual({ ok: false, reason: "rate_limited" });
    expect(await ctx(() => quotaFor(async () => ({ rateLimited: true, error: "blocked" })).admit())).toEqual({ ok: false, reason: "rate_limited" });
    expect(await ctx(() => quotaFor(async () => ({ rateLimited: false, error: "not-found" })).admit())).toEqual({ ok: false, reason: "unavailable" });
    expect(await ctx(() => quotaFor(async () => { throw new Error("boom"); }).admit())).toEqual({ ok: false, reason: "unavailable" });
    expect(await ctx(() => quotaFor(async () => { throw Object.assign(new Error("slow"), { name: "TimeoutError" }); }).admit())).toEqual({ ok: false, reason: "unavailable" });
    expect(await quotaFor(async () => ({ rateLimited: false })).admit()).toEqual({ ok: false, reason: "unavailable" });
    expect(logs.every(line => line.startsWith("pdf-tools: ERROR files upload quota"))).toBe(true);
    expect(logs.join("\n")).toMatch(/not configured in the Vercel Firewall/);
    expect(logs.join("\n")).toMatch(/TimeoutError/);
    expect(logs.join("\n")).not.toMatch(/must-not-forward|203\.0\.113/);
  });

  it("keeps the request headers scoped to the request", async () => {
    expect(await ctx(async () => currentRequestHeaders()?.get("host"))).toBe("mcp.example.test");
    expect(currentRequestHeaders()).toBeNull();
  });
});

describe("Files with the quota, over the MCP handler", () => {
  async function syntheticPdf() {
    const doc = await PDFDocument.create();
    doc.addPage([612, 792]);
    return Buffer.from(await doc.save({ useObjectStreams: false }));
  }
  function setup() {
    let limited = false;
    const checks = [];
    const store = createMemoryFileStore();
    const quota = createIssuanceQuota({ rules: [{ id: "files-upload-ip", scope: "ip" }], check: async id => { checks.push(id); return { rateLimited: limited }; }, headers: () => REQUEST_HEADERS });
    const handler = createMcpHandler(({ era }) => createRemoteServer({ era, files: createFilesHandler({ store, keys: KEYS, quota }) }));
    let id = 0;
    const rpc = async (name, args, requestState) => {
      const params = { name, arguments: args, ...(requestState ? { requestState } : {}), _meta: {
        "io.modelcontextprotocol/protocolVersion": MODERN,
        "io.modelcontextprotocol/clientInfo": { name: "synthetic-quota-test", version: "0" },
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
    return { store, rpc, checks, limit: value => { limited = value; } };
  }
  const keyFromUrl = url => decodeURIComponent(new URL(url).pathname.split("/").pop());

  it("refuses a new target when over the limit, with no target issued and nothing stored", async () => {
    const { store, rpc, checks, limit } = setup();
    limit(true);
    const response = await rpc("get_pdf_info", { upload: { id: "a", mimeType: "application/pdf", size: 100 } });
    expect(response.result.isError).toBe(true);
    expect(response.result.content[0].text).toMatch(/^UPLOAD_RATE_LIMITED: .*Try again in a minute/);
    expect(response.result.uploads).toBeUndefined();
    expect(response.result.requestState).toBeUndefined();
    expect(store.keys()).toEqual([]);
    expect(checks).toEqual(["files-upload-ip"]);
  });

  it("never consults the quota for ordinary calls, finishing an issued upload, invalid uploads or downloads", async () => {
    const { store, rpc, checks, limit } = setup();
    const bytes = await syntheticPdf();
    const args = { upload: { id: "a", mimeType: "application/pdf", size: bytes.length } };
    const first = await rpc("get_pdf_info", args);
    expect(first.result.resultType).toBe("upload_required");
    expect(checks).toHaveLength(1);
    store.acceptUpload(keyFromUrl(first.result.uploads[0].url), bytes);

    limit(true);
    const second = await rpc("get_pdf_info", args, first.result.requestState);
    expect(second.result.isError).toBeFalsy();
    expect(second.result.structuredContent.source.page_count).toBe(1);
    const ordinary = await rpc("get_pdf_info", { pdf_base64: bytes.toString("base64") });
    expect(ordinary.result.isError).toBeFalsy();
    const download = await rpc("select_pdf_pages", { pdf_base64: bytes.toString("base64"), page_numbers: [1] });
    expect(download.result._meta["io.modelcontextprotocol/files"].downloads).toHaveLength(1);
    const invalid = await rpc("get_pdf_info", { upload: { id: "a", mimeType: "image/png", size: 10 } });
    expect(invalid.result.content[0].text).toMatch(/^INVALID_UPLOAD/);
    const wrongTool = await rpc("merge_pdfs", { upload: { id: "a", mimeType: "application/pdf", size: 10 } });
    expect(wrongTool.result.content[0].text).toMatch(/^UPLOAD_UNSUPPORTED_TOOL/);
    expect(checks).toHaveLength(1);
  });
});
