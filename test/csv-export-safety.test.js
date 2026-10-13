import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createHash } from "node:crypto";
import { PDFDocument } from "pdf-lib";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { writeCsvExport } from "../server/csv-export.js";
import { PDF_MUTATION_MAX_FILE_BYTES, readBoundedPdfFileSafely } from "../server/bounded-pdf-file.js";
import { createTestTempDirectory, removeTestTempDirectory } from "./helpers/temp-directory.js";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const hash = bytes => createHash("sha256").update(bytes).digest("hex");

async function formBytes(value) {
  const document = await PDFDocument.create();
  const page = document.addPage([300, 200]);
  const field = document.getForm().createTextField("company");
  field.addToPage(page, { x: 20, y: 100, width: 250, height: 24 });
  field.setText(value);
  return Buffer.from(await document.save());
}

describe("CSV export source preservation over MCP", () => {
  let root;
  let client;
  let transport;
  let sourcePaths;
  let originalBytes;
  const exportCsv = output => client.callTool({
    name: "extract_to_csv",
    arguments: { pdf_paths: sourcePaths, output_csv: output },
  });

  beforeAll(async () => {
    root = await createTestTempDirectory(REPO_ROOT, "csv-export-safety-mcp");
    originalBytes = await Promise.all([formBytes('Acme, "North"'), formBytes("Second Company")]);
    sourcePaths = [path.join(root, "one.pdf"), path.join(root, "two.pdf")];
    await Promise.all(sourcePaths.map((file, index) => fs.writeFile(file, originalBytes[index])));
    client = new Client({ name: "csv-safety-test", version: "1.0.0" });
    transport = new StdioClientTransport({
      command: process.execPath,
      args: [path.join(REPO_ROOT, "server/index.js")],
      cwd: REPO_ROOT,
      env: { ALLOWED_DIRECTORIES: root },
      stderr: "pipe",
    });
    await client.connect(transport);
  }, 30_000);

  afterEach(async () => {
    for (let index = 0; index < sourcePaths.length; index++) {
      expect(await fs.readFile(sourcePaths[index])).toEqual(originalBytes[index]);
    }
  });
  afterAll(async () => {
    await transport?.close();
    await removeTestTempDirectory(root);
  });

  it("exports two PDFs and preserves CSV commas and escaped quotes", async () => {
    const output = path.join(root, "success.csv");
    const result = await exportCsv(output);
    expect(result.isError).not.toBe(true);
    expect(result.structuredContent).toMatchObject({ source_pdf_count: 2, row_count: 2, field_count: 1 });
    const csv = await fs.readFile(output, "utf8");
    expect(csv).toContain('"Acme, ""North"""');
    expect(csv).toBe('"_filename","company"\n"one.pdf","Acme, ""North"""\n"two.pdf","Second Company"');
  });

  it("refuses to export over the second source path", async () => {
    const result = await exportCsv(sourcePaths[1]);
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain("output_csv refers to a source PDF");
  });

  it("refuses a hardlink alias of any source", async () => {
    const output = path.join(root, "hardlink.csv");
    await fs.link(sourcePaths[1], output);
    const result = await exportCsv(output);
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain("output_csv refers to a source PDF");
    expect(await fs.readFile(output)).toEqual(originalBytes[1]);
  });

  it("refuses a symlink output without following it", async () => {
    const output = path.join(root, "symlink.csv");
    await fs.symlink(sourcePaths[0], output);
    expect((await exportCsv(output)).isError).toBe(true);
    expect((await fs.lstat(output)).isSymbolicLink()).toBe(true);
    expect(await fs.readlink(output)).toBe(sourcePaths[0]);
  });

  it("recognizes source aliases through a symlinked parent directory", async () => {
    const directoryAlias = path.join(root, "directory-alias");
    await fs.symlink(root, directoryAlias, "dir");
    const result = await exportCsv(path.join(directoryAlias, "two.pdf"));
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain("output_csv refers to a source PDF");
  });

  it("refuses an existing CSV without replacing its bytes", async () => {
    const output = path.join(root, "existing.csv");
    await fs.writeFile(output, "keep this exact output\n");
    const result = await exportCsv(output);
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain("ATOMIC_OUTPUT_TARGET_EXISTS");
    expect(await fs.readFile(output, "utf8")).toBe("keep this exact output\n");
  });

  it("rejects an oversized source before allocating or creating an output", async () => {
    const oversized = path.join(root, "oversized.pdf");
    const output = path.join(root, "oversized.csv");
    const handle = await fs.open(oversized, "wx");
    await handle.truncate(PDF_MUTATION_MAX_FILE_BYTES + 1);
    await handle.close();
    const result = await client.callTool({
      name: "extract_to_csv",
      arguments: { pdf_paths: [oversized], output_csv: output },
    });
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain("250 MiB");
    await expect(fs.access(output)).rejects.toMatchObject({ code: "ENOENT" });
  });
});

describe("CSV export transaction races", () => {
  let root;
  let sourcePath;
  let sourceBytes;
  let request;

  beforeEach(async () => {
    root = await createTestTempDirectory(REPO_ROOT, "csv-export-race");
    sourcePath = path.join(root, "source.pdf");
    sourceBytes = await formBytes("Safe Source");
    await fs.writeFile(sourcePath, sourceBytes);
    const assertPathAllowed = candidate => {
      if (candidate !== root && !candidate.startsWith(`${root}${path.sep}`)) throw new Error("path policy denied");
    };
    const source = await readBoundedPdfFileSafely(sourcePath, PDF_MUTATION_MAX_FILE_BYTES, { assertPathAllowed });
    request = {
      outputPath: path.join(root, "export.csv"),
      bytes: Buffer.from("_filename,company\nsource.pdf,Safe Source"),
      sources: [{ path: sourcePath, ...source, sha256: hash(sourceBytes) }],
      assertPathAllowed,
    };
  });
  afterEach(async () => await removeTestTempDirectory(root));

  it.each(["regular file", "source hardlink", "source symlink"])(
    "does not overwrite a %s introduced at the activation syscall",
    async kind => {
      let injected = false;
      const fsOps = {
        ...fs,
        async link(from, to) {
          if (to === request.outputPath && !injected) {
            injected = true;
            if (kind === "source hardlink") await fs.link(sourcePath, to);
            else if (kind === "source symlink") await fs.symlink(sourcePath, to);
            else await fs.writeFile(to, "other writer");
          }
          return await fs.link(from, to);
        },
      };
      // The shared transaction intentionally retains recovery evidence if a
      // symlink now occupies a target; it must never follow or remove it.
      await expect(writeCsvExport(request, { fsOps })).rejects.toMatchObject({
        code: kind === "source symlink" ? "ATOMIC_OUTPUT_ROLLBACK_FAILED" : "ATOMIC_OUTPUT_CONFLICT",
      });
      expect(injected).toBe(true);
      expect(await fs.readFile(sourcePath)).toEqual(sourceBytes);
      expect(await fs.readFile(request.outputPath)).toEqual(kind === "regular file" ? Buffer.from("other writer") : sourceBytes);
      if (kind === "source symlink") expect((await fs.lstat(request.outputPath)).isSymbolicLink()).toBe(true);
    },
  );

  it("leaves no output when staging fails", async () => {
    await expect(writeCsvExport(request, {
      async onTransition(phase) {
        if (phase === "stage_0") throw new Error("injected staging failure");
      },
    })).rejects.toThrow("injected staging failure");
    expect(await fs.readFile(sourcePath)).toEqual(sourceBytes);
    expect((await fs.readdir(root)).sort()).toEqual(["source.pdf"]);
  });

  it("refuses a substituted output directory without writing through its symlink", async () => {
    const outputDirectory = path.join(root, "exports");
    const substitutedDirectory = path.join(root, "unrelated");
    await fs.mkdir(outputDirectory);
    await fs.mkdir(substitutedDirectory);
    await fs.writeFile(path.join(substitutedDirectory, "keep.txt"), "keep");
    request.outputPath = path.join(outputDirectory, "export.csv");
    await expect(writeCsvExport(request, {
      async onTransition(phase) {
        if (phase !== "journal_prepared") return;
        await fs.rename(outputDirectory, path.join(root, "moved-exports"));
        await fs.symlink(substitutedDirectory, outputDirectory, "dir");
      },
    })).rejects.toThrow();
    expect(await fs.readFile(sourcePath)).toEqual(sourceBytes);
    expect(await fs.readdir(substitutedDirectory)).toEqual(["keep.txt"]);
    expect(await fs.readFile(path.join(substitutedDirectory, "keep.txt"), "utf8")).toBe("keep");
  });

  it("rolls back the CSV if a source changes after staging", async () => {
    const replacement = await formBytes("Changed by another writer");
    await expect(writeCsvExport(request, {
      async onTransition(phase) {
        if (phase === "stage_0") await fs.writeFile(sourcePath, replacement);
      },
    })).rejects.toMatchObject({ code: "CSV_SOURCE_CHANGED" });
    expect(await fs.readFile(sourcePath)).toEqual(replacement);
    await expect(fs.access(request.outputPath)).rejects.toMatchObject({ code: "ENOENT" });
  });
});
