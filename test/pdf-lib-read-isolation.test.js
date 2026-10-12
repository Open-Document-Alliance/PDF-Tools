import { afterAll, beforeAll, describe, expect, it } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import { fileURLToPath, pathToFileURL } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { PDFDocument } from "pdf-lib";
import { runPdfLibInspection, inspectHostPdfBytes } from "../server/pdf-lib-subprocess.js";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
let temp, source, hostile, normal;
const digest = bytes => createHash("sha256").update(bytes).digest("hex");

beforeAll(async () => {
  temp = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "pdf-tools-read-isolation-")));
  const document = await PDFDocument.create();
  document.setCreationDate(new Date("2026-01-01T00:00:00Z"));
  document.setModificationDate(new Date("2026-01-01T00:00:00Z"));
  document.addPage([200, 200]);
  normal = Buffer.from(await document.save({ useObjectStreams: true }));
  // The reported ~580-byte attack: a tiny, otherwise normal PDF whose xref
  // field width asks pdf-lib to spin for minutes without increasing RSS.
  hostile = Buffer.from(normal.toString("latin1").replace(/\/W\s*\[[^\]]*\]/, "/W [1 2000000000 1]"), "latin1");
  expect(hostile.length).toBeLessThan(1024);
  expect(hostile.equals(normal)).toBe(false);
  const sourcePath = path.join(temp, "normal.pdf");
  await fs.writeFile(sourcePath, normal);
  await fs.writeFile(path.join(temp, "hostile.pdf"), hostile);
  const stats = await fs.stat(sourcePath, { bigint: true });
  source = { canonical_path: sourcePath, size_bytes: normal.length, sha256: digest(normal),
    file_identity: { device: String(stats.dev), inode: String(stats.ino) } };
});
afterAll(async () => { await fs.rm(temp, { recursive: true, force: true }); });

async function withServer(prefix, fn) {
  // Keep config outside the admitted source folder: the product deliberately
  // rejects directory grants that would let a tool rewrite its own policy.
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "pdf-tools-read-home-"));
  const transport = new StdioClientTransport({ command: process.execPath,
    args: [path.join(ROOT, prefix, "server/index.js")], cwd: ROOT,
    env: { HOME: home, PATH: process.env.PATH ?? "", ALLOWED_DIRECTORIES: [temp, ROOT].join(path.delimiter),
      PLUGIN_DATA: path.join(home, "plugin") }, stderr: "ignore" });
  const client = new Client({ name: "read-isolation-regression", version: "1.0.0" });
  try { await client.connect(transport); await fn(client); }
  finally { await transport.close(); await fs.rm(home, { recursive: true, force: true }); }
}

// Wire semantics and containment are checked on both actually shipped trees.
for (const prefix of ["", "pdf-toolkit-mcp-share"]) {
  describe(`isolated read tools (${prefix || "source"})`, () => {
    it("refuses hostile parser work while ping remains responsive on every former main-thread route", async () => {
      await withServer(prefix, async client => {
        const pdf_path = path.join(temp, "hostile.pdf");
        const calls = [
          ["read_pdf_fields", { pdf_path }],
          ["validate_pdf", { pdf_path }],
          ["display_pdf", { pdf_path }],
          ["set_active_document", { pdf_path }],
          ["extract_to_csv", { pdf_paths: [pdf_path], output_csv: path.join(temp, `refused-${prefix ? "share" : "source"}.csv`) }],
        ];
        for (const [name, args] of calls) {
          const pending = client.callTool({ name, arguments: args });
          await new Promise(resolve => setTimeout(resolve, 25));
          const pingAt = performance.now();
          await client.ping();
          expect(performance.now() - pingAt, name).toBeLessThan(1500);
          const result = await pending;
          expect(result.isError, name).toBe(true);
          if (name !== "validate_pdf") {
            // These tools retain their existing public error schema while
            // reporting the worker's bounded refusal, not a policy denial.
            expect(result.structuredContent.error.code, name).toBe("tool_execution_failed");
            expect(result.content[0].text, name).toContain("PDF processing exceeded its isolated resource budget");
          }
        }
        // Active-document lookup can encounter different bytes at a previously
        // healthy path. It must not reintroduce a main-thread parser there.
        const activePath = path.join(temp, `active-${prefix ? "share" : "source"}.pdf`);
        await fs.writeFile(activePath, normal);
        const activate = await client.callTool({ name: "set_active_document", arguments: { pdf_path: activePath } });
        expect(activate.isError, JSON.stringify(activate)).not.toBe(true);
        await fs.writeFile(activePath, hostile);
        const active = client.callTool({ name: "get_active_document", arguments: {} });
        await new Promise(resolve => setTimeout(resolve, 25));
        await client.ping();
        expect((await active).isError).toBe(true);
        await expect(fs.stat(path.join(temp, `refused-${prefix ? "share" : "source"}.csv`)))
          .rejects.toMatchObject({ code: "ENOENT" });
        const fields = await client.callTool({ name: "read_pdf_fields", arguments: { pdf_path: path.join(ROOT, "example-fw9.pdf") } });
        expect(fields.isError).not.toBe(true);
        expect(fields.structuredContent.fieldCount).toBeGreaterThan(0);
        expect(fields.structuredContent.fields.some(field => field.type === "checkbox")).toBe(true);
        const validation = await client.callTool({ name: "validate_pdf", arguments: { pdf_path: path.join(ROOT, "example-fw9.pdf") } });
        expect(validation.isError).not.toBe(true);
        expect(validation.structuredContent.total_field_count).toBe(fields.structuredContent.fieldCount);
      });
    }, 45_000);
  });
}

describe("read worker containment independent of known malformed patterns", () => {
  it.each(["subprocess", "worker_thread"])("terminates noncooperative %s work without blocking the calling thread", async isolationMode => {
    const workerPath = path.join(temp, `noncooperative-${isolationMode}.mjs`);
    const monitor = pathToFileURL(path.join(ROOT, "server/pdf-lib-rss-monitor.js")).href;
    await fs.writeFile(workerPath, isolationMode === "subprocess"
      ? `import { startPdfLibRssMonitor } from ${JSON.stringify(monitor)};\nstartPdfLibRssMonitor();\nfor await (const chunk of process.stdin) {}\nwhile (true) {}\n`
      : "while (true) {}\n");
    let ticks = 0;
    const timer = setInterval(() => { ticks += 1; }, 20);
    const start = performance.now();
    try {
      await expect(runPdfLibInspection({ operation: "read_pdf_fields", sources: [source] }, {
        workerPath, isolationMode, timeoutMs: 1000,
      })).rejects.toMatchObject({ code: "PDF_RESOURCE_LIMIT_EXCEEDED", reason: "timeout" });
      expect(ticks).toBeGreaterThan(5);
      expect(performance.now() - start).toBeLessThan(5000);
    } finally { clearInterval(timer); }
    // Containment also releases the admission slot, so another read works.
    const next = await runPdfLibInspection({ operation: "read_pdf_fields", sources: [source] }, { isolationMode });
    expect(next.form_info).toEqual({ fields: [], fieldCount: 0, hasFormFields: false });
  }, 15_000);

  it.each(["field_count", "source", "extra_bytes"])("rejects an invalid %s observation from the worker", async kind => {
    const workerPath = path.join(temp, `invalid-${kind}.mjs`);
    await fs.writeFile(workerPath, `
      import { parentPort, workerData } from "node:worker_threads";
      const request = workerData.request, source = request.sources[0];
      const result = {
        source: { canonical_path: source.canonical_path, size_bytes: source.size_bytes, sha256: source.sha256 },
        total_pages: 1, form_info: { fields: [], fieldCount: 0, hasFormFields: false },
      };
      if (${JSON.stringify(kind)} === "field_count") result.form_info.fieldCount = 1;
      if (${JSON.stringify(kind)} === "source") result.source.sha256 = "f".repeat(64);
      if (${JSON.stringify(kind)} === "extra_bytes") result.plaintext = "not part of the protocol";
      parentPort.postMessage({ kind: "response", response: {
        protocol_version: 1, operation: request.operation, status: "ok", manifest: [], result,
      }});
      parentPort.close();
    `);
    await expect(runPdfLibInspection({ operation: "read_pdf_fields", sources: [source] }, {
      workerPath, isolationMode: "worker_thread",
    })).rejects.toMatchObject({ code: "PDF_RESOURCE_LIMIT_EXCEEDED", reason: "invalid_read_only_result" });
  });

  it("rejects hostile imported bytes before publication and preserves ordinary import metadata", async () => {
    await expect(inspectHostPdfBytes(hostile)).rejects.toMatchObject({ code: "PDF_RESOURCE_LIMIT_EXCEEDED" });
    const result = await inspectHostPdfBytes(normal);
    expect(result.total_pages).toBe(1);
    expect(result.source.sha256).toBe(digest(normal));
    expect(result.form_info).toEqual({ fields: [], fieldCount: 0, hasFormFields: false });
    await expect(fs.stat(result.source.canonical_path)).rejects.toMatchObject({ code: "ENOENT" });
    await expect(fs.stat(path.dirname(result.source.canonical_path))).rejects.toMatchObject({ code: "ENOENT" });
    let failedSource;
    class FailingWorker {
      constructor(_path, options) {
        failedSource = options.workerData.request.sources[0].canonical_path;
        throw new Error("Injected worker startup failure");
      }
    }
    await expect(inspectHostPdfBytes(normal, {
      isolationMode: "worker_thread", workerClass: FailingWorker,
    })).rejects.toMatchObject({ code: "PDF_RESOURCE_LIMIT_EXCEEDED", reason: "worker_spawn_failed" });
    await expect(fs.stat(failedSource)).rejects.toMatchObject({ code: "ENOENT" });
    await expect(fs.stat(path.dirname(failedSource))).rejects.toMatchObject({ code: "ENOENT" });
  }, 15_000);

  it("keeps pdf-lib parsing and decryption out of both MCP entrypoints", async () => {
    for (const prefix of ["", "pdf-toolkit-mcp-share"]) {
      const sourceText = await fs.readFile(path.join(ROOT, prefix, "server/index.js"), "utf8");
      expect(sourceText).not.toMatch(/\b(?:PDFDocument\.load|loadPdfForMutation|decryptPdfForRead)\s*\(/);
      expect(sourceText).not.toMatch(/from ["']pdf-lib["']/);
    }
  });
});
