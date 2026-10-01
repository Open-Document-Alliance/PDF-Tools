import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createHash } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { PDFDocument } from "pdf-lib";
import { decodeHostPdfImport, importHostPdf, HOST_PDF_IMPORT_MAX_BASE64_CHARS } from "../server/host-pdf-import.js";
import { writePdfOutputAtomic } from "../server/helpers.js";
import { hashBoundedPdfFileSafely } from "../server/bounded-pdf-file.js";
import { validateStructuredToolResult } from "../server/output-schemas.js";
import { createTestTempDirectory, removeTestTempDirectory } from "./helpers/temp-directory.js";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const hash = bytes => createHash("sha256").update(bytes).digest("hex");
const minimalHeader = Buffer.from("%PDF-1.7\n").toString("base64");

describe("bounded host PDF byte transport", () => {
  it.each(["", "Zg", "Zg==\n", "Zg-_", "Zh==", "data:application/pdf;base64,Zg==", "====", 123])(
    "rejects malformed or noncanonical base64 %j", encoded => {
      expect(() => decodeHostPdfImport({ pdf_base64: encoded })).toThrow();
    },
  );
  it("rejects excess encoded size before Buffer.from allocation", () => {
    const encoded = "A".repeat(HOST_PDF_IMPORT_MAX_BASE64_CHARS + 4);
    const allocation = vi.spyOn(Buffer, "from");
    try {
      expect(() => decodeHostPdfImport({ pdf_base64: encoded })).toThrow("16 MiB");
      expect(allocation).not.toHaveBeenCalled();
    } finally { allocation.mockRestore(); }
  });
  it("checks decoded size at the maximum encoded-length boundary", () => {
    expect(() => decodeHostPdfImport({ pdf_base64: "A".repeat(HOST_PDF_IMPORT_MAX_BASE64_CHARS) })).toThrow("16 MiB");
  });
  it.each([{ source_uri: "https://example.com/file.pdf" }, { output_path: "../../outside.pdf" }, { password: "secret" }])(
    "rejects undeclared input authority %j", extra => {
      expect(() => decodeHostPdfImport({ pdf_base64: minimalHeader, ...extra })).toThrow("accepts only");
    },
  );
  it.each(["bad\nname", "\u0000", "x".repeat(256), 42, "", null])("rejects malformed display labels %j", display_name => {
    expect(() => decodeHostPdfImport({ pdf_base64: minimalHeader, display_name })).toThrow("inert label");
  });
  it("requires the existing header window and does not treat a label as a path", () => {
    expect(() => decodeHostPdfImport({ pdf_base64: Buffer.from("not a PDF").toString("base64") })).toThrow("1,024 bytes");
    expect(() => decodeHostPdfImport({ pdf_base64: Buffer.concat([Buffer.alloc(1024), Buffer.from("%PDF-1.7")]).toString("base64") })).toThrow("1,024 bytes");
    const bytes = Buffer.concat([Buffer.from("prefix\n"), Buffer.from("%PDF-1.7\n")]);
    expect(decodeHostPdfImport({ pdf_base64: bytes.toString("base64"), display_name: "../../outside.pdf" }))
      .toMatchObject({ displayName: "../../outside.pdf", sha256: hash(bytes), sizeBytes: bytes.length });
  });
});

describe("app-only host PDF import", () => {
  let temp, pdfBytes;
  beforeAll(async () => {
    temp = await createTestTempDirectory(ROOT, "host-pdf-import");
    const pdf = await PDFDocument.create();
    pdf.addPage([100, 120]);
    pdfBytes = Buffer.from(await pdf.save());
  });
  afterAll(async () => { await removeTestTempDirectory(temp); });

  async function withServer(name, env, run) {
    const home = path.join(temp, name, "home");
    await fs.mkdir(home, { recursive: true });
    const transport = new StdioClientTransport({ command: process.execPath,
      args: [path.join(ROOT, "server/index.js")], cwd: ROOT,
      env: { PATH: process.env.PATH ?? "", HOME: home, ...env }, stderr: "ignore" });
    const client = new Client({ name: `host-import-${name}`, version: "1.0.0" });
    try { await client.connect(transport); return await run(client); }
    finally { await transport.close(); }
  }
  const args = () => ({ pdf_base64: pdfBytes.toString("base64"), display_name: "../../original.pdf" });

  it("registers app-only import with truthful local write annotations", async () => {
    await withServer("catalog", {}, async client => {
      const { tools } = await client.listTools();
      expect(tools.find(tool => tool.name === "import_host_pdf")).toMatchObject({
        inputSchema: { required: ["pdf_base64"], additionalProperties: false },
        annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
        _meta: { ui: { visibility: ["app"], resourceUri: "ui://pdf-toolkit/viewer" } },
      });
    });
  });
  it("imports a new exact copy, replays its identity and streams it through existing viewer tools", async () => {
    const pluginData = path.join(temp, "success", "plugin-data");
    await withServer("success", { PLUGIN_DATA: pluginData }, async client => {
      const result = await client.callTool({ name: "import_host_pdf", arguments: args() });
      expect(result.isError).not.toBe(true);
      const payload = result.structuredContent;
      expect(path.dirname(payload.active_path)).toBe(await fs.realpath(path.join(pluginData, "workspace")));
      expect(path.basename(payload.active_path)).toMatch(/^host-import-[a-f0-9-]{36}\.pdf$/);
      expect(payload).toMatchObject({ totalBytes: pdfBytes.length, totalPages: 1, initialPage: 1,
        host_import: { status: "imported", size_bytes: pdfBytes.length, sha256: hash(pdfBytes), display_name: "../../original.pdf" } });
      expect(await fs.readFile(payload.active_path)).toEqual(pdfBytes);
      expect((await fs.stat(payload.active_path)).mode & 0o777).toBe(0o600);
      const identity = await client.callTool({ name: "get_pdf_identity", arguments: { pdf_path: payload.active_path } });
      expect(identity.structuredContent).toEqual(payload.source);
      for (const mutate of [
        p => { p.host_import.sha256 = "f".repeat(64); },
        p => { p.host_import.size_bytes += 1; },
        p => { p.active_path = "/different.pdf"; },
        p => { p.totalBytes += 1; },
        p => { p.fieldCount += 1; },
      ]) {
        const drifted = structuredClone(result); mutate(drifted.structuredContent);
        expect(validateStructuredToolResult("import_host_pdf", drifted))
          .toMatchObject({ isError: true, structuredContent: { error: { code: "internal_validation_error" } } });
      }
      const streamed = await client.callTool({ name: "read_pdf_bytes", arguments: { pdf_path: payload.active_path } });
      expect(streamed.isError).not.toBe(true);
      const second = await client.callTool({ name: "import_host_pdf", arguments: args() });
      expect(second.structuredContent.active_path).not.toBe(payload.active_path);
      expect(await fs.readFile(payload.active_path)).toEqual(pdfBytes);
    });
  }, 30_000);
  it("fails without PLUGIN_DATA, preserving the active document", async () => {
    await withServer("no-data", { ALLOWED_DIRECTORIES: ROOT }, async client => {
      const before = await client.callTool({ name: "get_active_document", arguments: {} });
      const result = await client.callTool({ name: "import_host_pdf", arguments: args() });
      expect(result).toMatchObject({ isError: true, structuredContent: { error: { code: "HOST_IMPORT_WORKSPACE_UNAVAILABLE" } } });
      expect(await client.callTool({ name: "get_active_document", arguments: {} })).toEqual(before);
    });
  });
  it("does not create an excluded workspace, widen permissions, or copy to the first allowed folder", async () => {
    const pluginData = path.join(temp, "excluded", "plugin-data");
    const allowed = path.join(temp, "excluded", "allowed");
    await fs.mkdir(allowed, { recursive: true });
    await withServer("excluded", { PLUGIN_DATA: pluginData, ALLOWED_DIRECTORIES: allowed }, async client => {
      const result = await client.callTool({ name: "import_host_pdf", arguments: args() });
      expect(result).toMatchObject({ isError: true, structuredContent: { error: { code: "HOST_IMPORT_WORKSPACE_UNAVAILABLE" } } });
      expect(await fs.readdir(allowed)).toEqual([]);
      await expect(fs.lstat(path.join(pluginData, "workspace"))).rejects.toMatchObject({ code: "ENOENT" });
      expect((await client.callTool({ name: "get_allowed_directories", arguments: {} })).structuredContent.source).toBe("environment");
    });
  });
  it("rejects a symlinked workspace without touching its target", async () => {
    const pluginData = path.join(temp, "symlink", "plugin-data"), outside = path.join(temp, "symlink", "outside");
    await fs.mkdir(pluginData, { recursive: true }); await fs.mkdir(outside, { recursive: true });
    await fs.symlink(outside, path.join(pluginData, "workspace"));
    await withServer("symlink", { PLUGIN_DATA: pluginData, ALLOWED_DIRECTORIES: outside }, async client => {
      expect(await client.callTool({ name: "import_host_pdf", arguments: args() }))
        .toMatchObject({ isError: true, structuredContent: { error: { code: "HOST_IMPORT_WORKSPACE_UNAVAILABLE" } } });
      expect(await fs.readdir(outside)).toEqual([]);
    });
  });
  it.each(["malformed", "encrypted"])("rejects %s PDF bytes before output publication", async kind => {
    const bytes = kind === "encrypted"
      ? await fs.readFile(path.join(ROOT, "test/fixtures/eval/extraction/oracles/layout-encrypted-qpdf-r4.pdf"))
      : Buffer.from("%PDF-1.7\nnot a document\n");
    const pluginData = path.join(temp, kind, "plugin-data");
    await withServer(kind, { PLUGIN_DATA: pluginData }, async client => {
      const result = await client.callTool({ name: "import_host_pdf", arguments: { pdf_base64: bytes.toString("base64") } });
      expect(result).toMatchObject({ isError: true, structuredContent: { error: { code: "HOST_IMPORT_INVALID_PDF" } } });
      expect(await fs.readdir(path.join(pluginData, "workspace"))).toEqual([]);
      expect((await client.callTool({ name: "get_active_document", arguments: {} })).structuredContent.active_path).toBeNull();
    });
  });
  it("refuses a generated-name collision without replacing prior bytes", async () => {
    const workspacePath = path.join(temp, "collision", "workspace");
    await fs.mkdir(workspacePath, { recursive: true });
    const id = "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa", target = path.join(workspacePath, `host-import-${id}.pdf`);
    const sentinel = Buffer.from("existing file"); await fs.writeFile(target, sentinel);
    await expect(importHostPdf(args(), { workspacePath, assertPathAllowed: () => {}, validatePdf: async () => ({}),
      writePdfOutputAtomic, hashPdfFile: p => hashBoundedPdfFileSafely(p, 16 * 1024 * 1024), makeId: () => id })).rejects.toThrow();
    expect(await fs.readFile(target)).toEqual(sentinel);
  });
  it("rejects a workspace replacement during PDF validation before writing", async () => {
    const workspacePath = path.join(temp, "replacement", "workspace");
    await fs.mkdir(workspacePath, { recursive: true });
    const write = vi.fn();
    await expect(importHostPdf(args(), { workspacePath, assertPathAllowed: () => {},
      validatePdf: async () => {
        await fs.rename(workspacePath, `${workspacePath}-original`);
        await fs.mkdir(workspacePath);
        return {};
      }, writePdfOutputAtomic: write, hashPdfFile: vi.fn() })).rejects.toMatchObject({ code: "HOST_IMPORT_WORKSPACE_UNAVAILABLE" });
    expect(write).not.toHaveBeenCalled();
    expect(await fs.readdir(workspacePath)).toEqual([]);
  });
});
