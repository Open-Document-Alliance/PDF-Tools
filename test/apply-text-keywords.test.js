// apply_text used to append an audit line to the document's Keywords on
// every stamp, changing descriptive metadata the user never asked to change.
// Keywords are now left alone unless record_audit_in_keywords is true, and
// the stamp is appended as an incremental update.

import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { PDFDocument, PDFName, StandardFonts } from "pdf-lib";
import { validateStructuredToolResult } from "../server/output-schemas.js";
import { keepsPrefix } from "../server/incremental-update.js";
import { readXmpDocumentFields } from "../server/xmp-metadata.js";
import { createTestTempDirectory, removeTestTempDirectory } from "./helpers/temp-directory.js";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const XMP = `<?xpacket begin="﻿" id="W5M0MpCehiHzreSzNTczkc9d"?>
<x:xmpmeta xmlns:x="adobe:ns:meta/"><rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#">
<rdf:Description rdf:about="" xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:pdf="http://ns.adobe.com/pdf/1.3/" pdf:Keywords="quarterly, report">
<dc:title><rdf:Alt><rdf:li xml:lang="x-default">Stamp Test</rdf:li></rdf:Alt></dc:title>
</rdf:Description></rdf:RDF></x:xmpmeta>
<?xpacket end="w"?>`;

const DATED_XMP = XMP.replace(
  'xmlns:pdf="http://ns.adobe.com/pdf/1.3/"',
  'xmlns:pdf="http://ns.adobe.com/pdf/1.3/" xmlns:xmp="http://ns.adobe.com/xap/1.0/" xmp:ModifyDate="2020-01-01T00:00:00Z"',
);

function packetOf(doc) {
  return new TextDecoder().decode(doc.context.lookup(doc.catalog.get(PDFName.of("Metadata"))).getContents());
}

async function sourceDocument(xmp = XMP) {
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  doc.addPage([612, 792]).drawText("Page one", { x: 72, y: 700, size: 12, font });
  doc.addPage([612, 792]).drawText("Page two", { x: 72, y: 700, size: 12, font });
  doc.setTitle("Stamp Test");
  doc.setKeywords(["quarterly, report"]);
  doc.catalog.set(PDFName.of("Metadata"), doc.context.register(
    doc.context.stream(new TextEncoder().encode(xmp), { Type: "Metadata", Subtype: "XML" }),
  ));
  return doc.save();
}

describe("apply_text leaves Keywords alone unless asked (stdio)", () => {
  let client;
  let transport;
  let directory;

  async function stamp(args) {
    const result = await client.callTool({ name: "apply_text", arguments: args });
    expect(result.isError, JSON.stringify(result.content)).toBeFalsy();
    expect(validateStructuredToolResult("apply_text", result).isError).toBeFalsy();
    return { result, text: result.content.map(block => block.text ?? "").join("\n") };
  }

  beforeAll(async () => {
    directory = await createTestTempDirectory(REPO_ROOT, "apply-text-keywords");
    transport = new StdioClientTransport({
      command: process.execPath,
      args: [path.join(REPO_ROOT, "server/index.js")],
      cwd: REPO_ROOT,
      env: { ...process.env, ALLOWED_DIRECTORIES: directory, DEFAULT_PROFILES_DIR: path.join(directory, "state") },
      stderr: "pipe",
    });
    client = new Client({ name: "apply-text-keywords-test", version: "1.0.0" });
    await client.connect(transport);
  }, 30_000);

  afterAll(async () => {
    try {
      await client?.close();
      await transport?.close();
    } finally {
      await removeTestTempDirectory(directory);
    }
  });

  it("stamps without touching Keywords or XMP, appended to the original", async () => {
    const source = path.join(directory, "report.pdf");
    const output = path.join(directory, "stamped.pdf");
    const original = await sourceDocument();
    await fs.writeFile(source, original);
    const { result } = await stamp({
      pdf_path: source, output_path: output, page: 2, x: 72, y: 40, width: 200, height: 20, text: "APPROVED 2026-11-25",
    });
    expect(result.structuredContent).toMatchObject({ save_mode: "incremental", audit_in_keywords: false });
    const bytes = await fs.readFile(output);
    expect(keepsPrefix(new Uint8Array(bytes), original)).toBe(true);
    const doc = await PDFDocument.load(bytes, { updateMetadata: false });
    expect(doc.getKeywords()).toBe("quarterly, report");
    expect(doc.getTitle()).toBe("Stamp Test");
    const packet = new TextDecoder().decode(doc.context.lookup(doc.catalog.get(PDFName.of("Metadata"))).getContents());
    expect(packet).toBe(XMP);
  });

  it("adds the audit line to Keywords only when record_audit_in_keywords is true", async () => {
    const source = path.join(directory, "audit.pdf");
    const output = path.join(directory, "audit-stamped.pdf");
    await fs.writeFile(source, await sourceDocument());
    const { result, text } = await stamp({
      pdf_path: source, output_path: output, page: 1, x: 72, y: 40, width: 200, height: 20,
      text: "Initials JQE", record_audit_in_keywords: true,
    });
    expect(result.structuredContent.audit_in_keywords).toBe(true);
    expect(text).toContain("audit line was added to the document's Keywords");
    const doc = await PDFDocument.load(await fs.readFile(output), { updateMetadata: false });
    const keywords = doc.getKeywords();
    expect(keywords.startsWith("quarterly, report\n")).toBe(true);
    expect(keywords).toMatch(/stamped text via pdf-toolkit; text="Initials JQE"/);
    // XMP keeps the same keywords as Info, so readers that prefer it agree.
    expect(readXmpDocumentFields(packetOf(doc)).keywords).toEqual({ state: "value", value: keywords });
  });

  it("moves the XMP modification date with Info's, so the two records agree", async () => {
    const source = path.join(directory, "dated.pdf");
    const output = path.join(directory, "dated-stamped.pdf");
    await fs.writeFile(source, await sourceDocument(DATED_XMP));
    const { result } = await stamp({
      pdf_path: source, output_path: output, page: 1, x: 72, y: 40, width: 200, height: 20, text: "RECEIVED",
    });
    expect(result.structuredContent.save_mode).toBe("incremental");
    const doc = await PDFDocument.load(await fs.readFile(output), { updateMetadata: false });
    const xmpDate = /xmp:ModifyDate="([^"]+)"/.exec(packetOf(doc))[1];
    expect(xmpDate).not.toBe("2020-01-01T00:00:00Z");
    // Info dates carry whole seconds; XMP keeps the milliseconds.
    expect(Math.floor(Date.parse(xmpDate) / 1000)).toBe(doc.getModificationDate().getTime() / 1000);
    expect(readXmpDocumentFields(packetOf(doc))).toMatchObject({
      title: { state: "value", value: "Stamp Test" },
      keywords: { state: "value", value: "quarterly, report" },
    });
  });
});
