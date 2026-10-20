import fs from "fs/promises";
import { createHash } from "crypto";
import path from "path";
import { fileURLToPath } from "url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { PDFDocument, PDFName } from "pdf-lib";
import { createTestTempDirectory, removeTestTempDirectory } from "./helpers/temp-directory.js";
import { createPrivatePdfUnlockHarness } from "./helpers/private-pdf-unlock.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.join(__dirname, "..");
const EXAMPLE_PDF = path.join(REPO_ROOT, "example-fw9.pdf");
const ENCRYPTED_ORACLE = path.join(
  REPO_ROOT,
  "test",
  "fixtures",
  "golden-forms",
  "encrypted-rotated-signature.pdf",
);
const ENCRYPTED_PROVENANCE = ENCRYPTED_ORACLE.replace(/\.pdf$/, ".provenance.json");
let TMP_DIR;
let encryptedPdfPath;
let encryptedProvenance;
let unresolvedWidgetPdfPath;

function textFromToolResult(result) {
  return result.content
    .filter(item => item.type === "text")
    .map(item => item.text)
    .join("\n");
}

describe("detect_signature_zones tool result", () => {
  let client;
  let transport;
  let unlock;

  beforeAll(async () => {
    TMP_DIR = await createTestTempDirectory(REPO_ROOT, "detect-zones-tool");
    encryptedProvenance = JSON.parse(await fs.readFile(ENCRYPTED_PROVENANCE, "utf8"));
    const committedBytes = await fs.readFile(ENCRYPTED_ORACLE);
    expect(createHash("sha256").update(committedBytes).digest("hex"))
      .toBe(encryptedProvenance.encrypted_fixture.sha256);
    expect(committedBytes).toHaveLength(encryptedProvenance.encrypted_fixture.bytes);
    const sourceBytes = await fs.readFile(path.join(REPO_ROOT, encryptedProvenance.source_fixture.path));
    expect(createHash("sha256").update(sourceBytes).digest("hex"))
      .toBe(encryptedProvenance.source_fixture.sha256);
    expect(sourceBytes).toHaveLength(encryptedProvenance.source_fixture.bytes);
    encryptedPdfPath = ENCRYPTED_ORACLE;

    const unresolvedDocument = await PDFDocument.create();
    const unresolvedPage = unresolvedDocument.addPage([612, 792]);
    const unresolvedField = unresolvedDocument.getForm().createTextField("Signature1");
    unresolvedField.addToPage(unresolvedPage, { x: 100, y: 100, width: 200, height: 30 });
    unresolvedField.acroField.getWidgets()[0].dict.delete(PDFName.of("P"));
    unresolvedPage.node.delete(PDFName.of("Annots"));
    unresolvedWidgetPdfPath = path.join(TMP_DIR, "unresolved-widget.pdf");
    await fs.writeFile(unresolvedWidgetPdfPath, await unresolvedDocument.save(), { mode: 0o600 });

    unlock = await createPrivatePdfUnlockHarness(TMP_DIR);
    client = new Client({ name: "pdf-tools-detect-zones-tool-test-client", version: "1.0.0" });
    transport = new StdioClientTransport({
      command: process.execPath,
      args: [path.join(REPO_ROOT, "server", "index.js")],
      cwd: REPO_ROOT,
      env: {
        ...unlock.env,
        ALLOWED_DIRECTORIES: `${TMP_DIR}${path.delimiter}${REPO_ROOT}`,
        DEFAULT_PROFILES_DIR: path.join(TMP_DIR, "profiles"),
      },
      stderr: "pipe",
    });
    await client.connect(transport);
  }, 30_000);

  it("advertises partial encrypted text detection rather than claiming it is unsupported", async () => {
    const { tools } = await client.listTools();
    const tool = tools.find(entry => entry.name === "detect_signature_zones");
    expect(tool.description).toContain("Authenticated text detection may return partial results");
    expect(tool.description).toContain("encrypted AcroForm scanning unavailable");
    expect(tool.description).not.toContain("Encrypted PDFs remain unsupported");
    expect(tool.inputSchema.properties).not.toHaveProperty("password");
  });

  it("surfaces an unresolved-widget warning without fabricating page 1", async () => {
    const result = await client.callTool({
      name: "detect_signature_zones",
      arguments: { pdf_path: unresolvedWidgetPdfPath },
    });
    expect(result.isError).not.toBe(true);
    expect(result.structuredContent).toMatchObject({
      detection_status: "partial",
      zones: [],
      warnings: [{
        code: "ACROFORM_WIDGET_PAGE_UNRESOLVED",
        message: "Skipped an AcroForm signing widget because its page could not be resolved. No page location was guessed.",
        occurrences: 1,
      }],
    });
    const text = textFromToolResult(result);
    expect(text).toContain("Detection warnings:");
    expect(text).toContain("No page location was guessed.");
    expect(text).not.toMatch(/SIGNATURE p1/);
  }, 30_000);

  afterAll(async () => {
    try {
      await transport?.close();
    } finally {
      await removeTestTempDirectory(TMP_DIR);
    }
  });

  it("includes exact model-readable coordinates in the visible text response", async () => {
    const result = await client.callTool({
      name: "detect_signature_zones",
      arguments: {
        pdf_path: EXAMPLE_PDF,
      },
    });

    const text = textFromToolResult(result);
    expect(text).toContain("Detected zones (top-left origin, points; use these exact coordinates, do not guess):");
    expect(text).toMatch(/SIGNATURE p1 x=130\.7 y=513\.8 width=244\.9 height=16\.0/);
    expect(text).toMatch(/DATE p1 x=410\.2 y=513\.8 width=110\.0 height=16\.0/);
    expect(text).toContain("Use apply_text at returned NAME and DATE zones.");
    expect(result.structuredContent).toMatchObject({
      detection_status: "complete",
      warnings: [],
    });
    expect(result.structuredContent.zones).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          type: "signature",
          page: 1,
          x: expect.closeTo(130.7, 1),
          y: expect.closeTo(513.8, 1),
          width: expect.closeTo(244.9, 1),
          height: 16,
        }),
        expect.objectContaining({
          type: "date",
          page: 1,
          x: expect.closeTo(410.2, 1),
          y: expect.closeTo(513.8, 1),
          width: 110,
          height: 16,
        }),
      ])
    );
  }, 30_000);

  it("uses the real password path and reports the encrypted AcroForm limitation", async () => {
    for (const password of [
      encryptedProvenance.passwords.user,
      encryptedProvenance.passwords.owner,
    ]) {
      await unlock.enter(client, encryptedPdfPath, password);
      const result = await client.callTool({
        name: "detect_signature_zones",
        arguments: { pdf_path: encryptedPdfPath },
      });
      expect(result.isError).not.toBe(true);
      expect(result.structuredContent).toMatchObject({
        detection_status: "partial",
        zones: expect.arrayContaining([
          expect.objectContaining(encryptedProvenance.expected_zone),
        ]),
        warnings: [{
          code: "ENCRYPTED_ACROFORM_SCAN_UNAVAILABLE",
          message: "Encrypted PDF zone detection used the authenticated text layer. AcroForm widgets were not scanned.",
          occurrences: 1,
        }],
      });
      const text = textFromToolResult(result);
      expect(text).toContain("Detection warnings:");
      expect(text).toContain("SIGNATURE p1 x=72.0 y=181.0 width=240.0 height=18.0");
      expect(text).not.toContain(password);
    }
  }, 30_000);

  it("returns a typed locked result after missing or rejected private entry", async () => {
    for (const password of [undefined, encryptedProvenance.passwords.wrong_password_oracle]) {
      if (password === undefined) await unlock.lock(client, encryptedPdfPath);
      else await unlock.enter(client, encryptedPdfPath, password, { accepted: false });
      const result = await client.callTool({
        name: "detect_signature_zones",
        arguments: { pdf_path: encryptedPdfPath },
      });
      expect(result.isError).toBe(true);
      expect(result.structuredContent).toEqual({
        status: "failed",
        error: { error_schema_version: 1, code: "PASSWORD_REQUIRED" },
      });
      const text = textFromToolResult(result);
      expect(text).toContain("unlock_pdf");
      if (password) expect(text).not.toContain(password);
    }
  }, 30_000);
});
