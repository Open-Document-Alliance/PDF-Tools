// set_pdf_metadata changes the document title, author, subject and keywords
// in the Info dictionary and the XMP packet together, and by default appends
// the change as an incremental update so the original bytes (and any
// signature over them) are untouched. Before it, PDF Tools had no way
// to change document metadata at all.
//
// Results are read back with PDF.js, an independent parser, and signatures
// are verified with `openssl cms` over their byte range when openssl exists.

import { execFileSync } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { deflateSync } from "node:zlib";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { PDFDocument, PDFName, PDFString, StandardFonts } from "pdf-lib";
import { validateStructuredToolResult } from "../server/output-schemas.js";
import {
  IncrementalUpdateRefusal,
  buildIncrementalUpdate,
  keepsPrefix,
  locateLastCrossReference,
  snapshotIndirectObjects,
} from "../server/incremental-update.js";
import {
  XMP_MAX_BYTES,
  XmpUnsupported,
  editXmpDocumentFields,
  readXmpDocumentFields,
  readXmpStreamBytes,
} from "../server/xmp-metadata.js";
import { inspectSignatureState, isFieldLocked } from "../server/signature-state.js";
import { createTestTempDirectory, removeTestTempDirectory } from "./helpers/temp-directory.js";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const SIGNED_FIXTURE = path.join(REPO_ROOT, "test/fixtures/signing/signed-form.pdf");

const packet = body => `<?xpacket begin="﻿" id="W5M0MpCehiHzreSzNTczkc9d"?>
<x:xmpmeta xmlns:x="adobe:ns:meta/"><rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#">
${body}
</rdf:RDF></x:xmpmeta>
<?xpacket end="w"?>`;

const STANDARD_XMP = packet(`<rdf:Description rdf:about="" xmlns:dc="http://purl.org/dc/elements/1.1/"
  xmlns:pdf="http://ns.adobe.com/pdf/1.3/" xmlns:xmp="http://ns.adobe.com/xap/1.0/"
  pdf:Keywords="alpha, beta" xmp:ModifyDate="2020-01-01T00:00:00Z">
<dc:title><rdf:Alt><rdf:li xml:lang="x-default">Old Title</rdf:li><rdf:li xml:lang="fr">Ancien titre</rdf:li></rdf:Alt></dc:title>
<dc:creator><rdf:Seq><rdf:li>Example Corp Records</rdf:li></rdf:Seq></dc:creator>
<dc:subject><rdf:Bag><rdf:li>alpha</rdf:li><rdf:li>beta</rdf:li></rdf:Bag></dc:subject>
</rdf:Description>`);

function hasOpenssl() {
  try {
    execFileSync("openssl", ["version"], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

function hasQpdf() {
  try {
    execFileSync("qpdf", ["--version"], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

// Checks that need an outside tool are skipped, visibly, without it.
const OPENSSL = hasOpenssl();
const QPDF = hasQpdf();

/** Verify the first signature in the file over its own byte range. */
async function signatureVerifies(file, directory) {
  const bytes = await fs.readFile(file);
  const latin = bytes.toString("latin1");
  const range = /\/ByteRange\s*\[\s*(\d+)\s+(\d+)\s+(\d+)\s+(\d+)\s*\]/.exec(latin).slice(1).map(Number);
  const hex = latin.slice(range[1] + 1, range[2] - 1);
  const der = Buffer.from(hex, "hex");
  const length = der[1] & 0x80 ? 2 + (der[1] & 0x7f) + der.readUIntBE(2, der[1] & 0x7f) : 2 + der[1];
  const derPath = path.join(directory, "verify.der");
  const contentPath = path.join(directory, "verify.bin");
  await fs.writeFile(derPath, der.subarray(0, length));
  await fs.writeFile(contentPath, Buffer.concat([
    bytes.subarray(range[0], range[0] + range[1]),
    bytes.subarray(range[2], range[2] + range[3]),
  ]));
  try {
    execFileSync("openssl", ["cms", "-verify", "-binary", "-inform", "DER", "-in", derPath,
      "-content", contentPath, "-noverify", "-out", process.platform === "win32" ? "NUL" : "/dev/null"], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

async function pdfjsMetadata(bytes) {
  const lib = await import("pdfjs-dist/legacy/build/pdf.mjs");
  const task = lib.getDocument({ data: new Uint8Array(bytes), isEvalSupported: false, useSystemFonts: false });
  const document = await task.promise;
  try {
    const { info, metadata } = await document.getMetadata();
    return {
      title: info.Title ?? null,
      author: info.Author ?? null,
      subject: info.Subject ?? null,
      keywords: info.Keywords ?? null,
      xmpTitle: metadata?.get("dc:title") ?? null,
      xmpCreator: metadata?.get("dc:creator") ?? null,
      pages: document.numPages,
    };
  } finally {
    await task.destroy();
  }
}

async function buildDocument({ xmp = STANDARD_XMP, objectStreams = false, certified = null } = {}) {
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  doc.addPage([300, 300]).drawText("METADATA-SENTINEL", { x: 30, y: 250, size: 12, font });
  doc.setTitle("Old Title");
  doc.setAuthor("Example Corp Records");
  doc.setSubject("Quarterly report");
  doc.setKeywords(["alpha, beta"]);
  if (xmp) {
    doc.catalog.set(PDFName.of("Metadata"), doc.context.register(
      doc.context.stream(new TextEncoder().encode(xmp), { Type: "Metadata", Subtype: "XML" }),
    ));
  }
  if (certified !== null) {
    const context = doc.context;
    const signature = context.register(context.obj({
      Type: "Sig",
      Reference: [context.obj({
        Type: "SigRef",
        TransformMethod: "DocMDP",
        TransformParams: context.obj({ Type: "TransformParams", P: certified, V: "1.2" }),
      })],
    }));
    doc.catalog.set(PDFName.of("Perms"), context.obj({ DocMDP: signature }));
  }
  return doc.save({ useObjectStreams: objectStreams });
}

describe("XMP document fields", () => {
  it("decodes a metadata stream under a cap instead of inflating all of it first", async () => {
    const doc = await PDFDocument.create();
    const reason = stream => {
      try {
        readXmpStreamBytes(stream);
        return null;
      } catch (error) {
        expect(error).toBeInstanceOf(XmpUnsupported);
        return error.reason;
      }
    };
    const packetBytes = new TextEncoder().encode(STANDARD_XMP);
    const plain = doc.context.stream(packetBytes, { Type: "Metadata", Subtype: "XML" });
    const flate = doc.context.flateStream(packetBytes, { Type: "Metadata", Subtype: "XML" });
    expect(new TextDecoder().decode(readXmpStreamBytes(plain))).toBe(STANDARD_XMP);
    expect(new TextDecoder().decode(readXmpStreamBytes(flate))).toBe(STANDARD_XMP);
    // 8 MiB of spaces, twice the cap, compresses to a few KB; reading stops at the cap.
    const bomb = doc.context.stream(deflateSync(Buffer.alloc(2 * XMP_MAX_BYTES, 0x20)), {
      Type: "Metadata", Subtype: "XML", Filter: "FlateDecode",
    });
    expect(bomb.getContents().length).toBeLessThan(1024 * 1024);
    expect(reason(bomb)).toBe("xmp_too_large");
    expect(reason(doc.context.stream(packetBytes, { Subtype: "XML" }))).toBe("xmp_unreadable");
    expect(reason(doc.context.stream(packetBytes, { Type: "Metadata", Subtype: "XML", Filter: "LZWDecode" })))
      .toBe("xmp_unreadable");
    expect(reason(doc.context.obj({}))).toBe("xmp_unreadable");
  });

  it("reads Alt, Seq and attribute-form properties", () => {
    expect(readXmpDocumentFields(STANDARD_XMP)).toEqual({
      title: { state: "value", value: "Old Title" },
      author: { state: "value", value: "Example Corp Records" },
      subject: { state: "absent" },
      keywords: { state: "value", value: "alpha, beta" },
    });
  });

  it("resolves namespace prefixes instead of assuming dc:", () => {
    const xml = packet(`<rdf:Description rdf:about="" xmlns:purl="http://purl.org/dc/elements/1.1/">
<purl:title><rdf:Alt><rdf:li xml:lang="x-default">Prefixed</rdf:li></rdf:Alt></purl:title></rdf:Description>`);
    expect(readXmpDocumentFields(xml).title).toEqual({ state: "value", value: "Prefixed" });
    const edited = editXmpDocumentFields(xml, { title: "Renamed" });
    expect(edited).toContain("<purl:title><rdf:Alt><rdf:li xml:lang=\"x-default\">Renamed</rdf:li></rdf:Alt></purl:title>");
  });

  it("edits in step: title, keywords (pdf:Keywords and the dc:subject bag), dates", () => {
    const edited = editXmpDocumentFields(STANDARD_XMP, { title: "Q3 <rev 2> & more", keywords: "gamma; delta" }, {
      modifiedAt: "2026-11-25T00:00:00.000Z",
    });
    expect(readXmpDocumentFields(edited)).toMatchObject({
      title: { state: "value", value: "Q3 <rev 2> & more" },
      author: { state: "value", value: "Example Corp Records" },
      keywords: { state: "value", value: "gamma; delta" },
    });
    expect(edited).toContain("&lt;rev 2&gt; &amp; more");
    expect(edited).toContain("<rdf:Bag><rdf:li>gamma</rdf:li><rdf:li>delta</rdf:li></rdf:Bag>");
    expect(edited).toContain("xmp:ModifyDate=\"2026-11-25T00:00:00.000Z\"");
  });

  it("changes only the default title, keeping the other languages of an rdf:Alt", () => {
    const xml = packet(`<rdf:Description rdf:about="" xmlns:dc="http://purl.org/dc/elements/1.1/">
<dc:title><rdf:Alt><rdf:li xml:lang="x-default">Annual Report</rdf:li><rdf:li xml:lang="fr-FR">Rapport annuel</rdf:li></rdf:Alt></dc:title>
</rdf:Description>`);
    const edited = editXmpDocumentFields(xml, { title: "Annual Report 2026" });
    expect(readXmpDocumentFields(edited).title).toEqual({ state: "value", value: "Annual Report 2026" });
    expect(edited).toContain('<rdf:li xml:lang="fr-FR">Rapport annuel</rdf:li>');
    expect(edited).not.toContain(">Annual Report<");
  });

  it("adds a property the packet lacks, and removes one on null", () => {
    const added = editXmpDocumentFields(STANDARD_XMP, { subject: "Now described" });
    expect(readXmpDocumentFields(added).subject).toEqual({ state: "value", value: "Now described" });
    const removed = editXmpDocumentFields(STANDARD_XMP, { title: null });
    expect(readXmpDocumentFields(removed).title).toEqual({ state: "absent" });
  });

  it("refuses a repeated property instead of guessing which one is meant", () => {
    const xml = packet(`<rdf:Description rdf:about="" xmlns:dc="http://purl.org/dc/elements/1.1/">
<dc:title><rdf:Alt><rdf:li xml:lang="x-default">One</rdf:li></rdf:Alt></dc:title>
<dc:title><rdf:Alt><rdf:li xml:lang="x-default">Two</rdf:li></rdf:Alt></dc:title></rdf:Description>`);
    expect(readXmpDocumentFields(xml).title).toEqual({ state: "unsupported", reason: "xmp_property_repeated" });
    expect(() => editXmpDocumentFields(xml, { title: "Three" })).toThrow(XmpUnsupported);
  });
});

describe("XMP scope and values", () => {
  it("edits only the document's own properties, not one nested in a pantry ingredient", () => {
    const xml = packet(`<rdf:Description rdf:about="" xmlns:dc="http://purl.org/dc/elements/1.1/"
  xmlns:xmpTPg="http://ns.adobe.com/xap/1.0/t/pg/">
<xmpTPg:Pantry><rdf:Bag><rdf:li><rdf:Description>
<dc:title><rdf:Alt><rdf:li xml:lang="x-default">Placed artwork</rdf:li></rdf:Alt></dc:title>
</rdf:Description></rdf:li></rdf:Bag></xmpTPg:Pantry>
</rdf:Description>`);
    expect(readXmpDocumentFields(xml).title).toEqual({ state: "absent" });
    const edited = editXmpDocumentFields(xml, { title: "Document title" });
    expect(edited).toContain("Placed artwork");
    expect(readXmpDocumentFields(edited).title).toEqual({ state: "value", value: "Document title" });
  });

  it("refuses a control character instead of writing a packet XML cannot parse", () => {
    expect(() => editXmpDocumentFields(STANDARD_XMP, { title: "bad\u0001char" }))
      .toThrow(expect.objectContaining({ reason: "xmp_value_illegal_character" }));
  });

  it("writes an author list as separate creators, so it reads back the same", () => {
    const edited = editXmpDocumentFields(STANDARD_XMP, { author: "Alice Example; Bob Example" });
    expect(edited).toContain("<rdf:Seq><rdf:li>Alice Example</rdf:li><rdf:li>Bob Example</rdf:li></rdf:Seq>");
    expect(readXmpDocumentFields(edited).author).toEqual({ state: "value", value: "Alice Example; Bob Example" });
  });
});

describe("incremental update writer", () => {
  for (const objectStreams of [false, true]) {
    it(`appends to a ${objectStreams ? "cross-reference stream" : "classic table"} original and keeps its bytes`, async () => {
      const original = await buildDocument({ objectStreams });
      expect(locateLastCrossReference(original).kind).toBe(objectStreams ? "stream" : "table");
      const doc = await PDFDocument.load(original, { updateMetadata: false });
      const snapshot = snapshotIndirectObjects(doc, original);
      doc.setTitle("Appended Title");
      const { bytes, summary } = buildIncrementalUpdate(doc, original, snapshot);
      expect(summary).toMatchObject({ appended_objects: 1, cross_reference: objectStreams ? "stream" : "table" });
      expect(keepsPrefix(bytes, original)).toBe(true);
      const read = await pdfjsMetadata(bytes);
      expect(read).toMatchObject({ title: "Appended Title", author: "Example Corp Records", pages: 1 });
    });
  }

  it("numbers new objects above every number the original uses, so no object stream is shadowed", async () => {
    // pdf-lib drops a parsed object stream and the cross-reference stream
    // from its context, so its own next number would reuse theirs.
    const original = await buildDocument({ objectStreams: true });
    const { size } = locateLastCrossReference(original);
    const doc = await PDFDocument.load(original, { updateMetadata: false });
    const snapshot = snapshotIndirectObjects(doc, original);
    const added = doc.context.register(doc.context.obj({ Note: "new object" }));
    expect(added.objectNumber).toBeGreaterThanOrEqual(size);
    doc.getInfoDict().set(PDFName.of("PdfToolsTestNote"), added);
    const { bytes } = buildIncrementalUpdate(doc, original, snapshot);
    const reloaded = await PDFDocument.load(bytes, { updateMetadata: false });
    expect(reloaded.getPageCount()).toBe(1);
    expect((await pdfjsMetadata(bytes)).title).toBe("Old Title");
  });

  it("refuses when nothing changed, and when the startxref is damaged", async () => {
    const original = await buildDocument();
    const doc = await PDFDocument.load(original, { updateMetadata: false });
    expect(() => buildIncrementalUpdate(doc, original, snapshotIndirectObjects(doc, original)))
      .toThrow(expect.objectContaining({ reason: "no_change" }));
    const damaged = Buffer.from(original);
    const at = damaged.lastIndexOf("startxref");
    damaged.write("startxref\n17      ", at, "latin1");
    expect(() => locateLastCrossReference(damaged)).toThrow(IncrementalUpdateRefusal);
  });
});

describe("signature state", () => {
  it("tells signed fields from empty ones, and reads certification", async () => {
    const signed = await PDFDocument.load(await fs.readFile(SIGNED_FIXTURE), { updateMetadata: false });
    expect(inspectSignatureState(signed)).toMatchObject({
      signed: [{ name: "approver_signature", locks: [] }],
      unsigned: [],
      certification: null,
    });
    expect(isFieldLocked(inspectSignatureState(signed), "full_name")).toBe(false);
    const certified = await PDFDocument.load(await buildDocument({ certified: 2 }), { updateMetadata: false });
    expect(inspectSignatureState(certified).certification).toBe(2);
  });

  it("reads FieldMDP and DocMDP from the signature's own references, and locks cover child fields", async () => {
    const doc = await PDFDocument.load(await fs.readFile(SIGNED_FIXTURE), { updateMetadata: false });
    const fields = doc.context.lookup(doc.catalog.lookup(PDFName.of("AcroForm")).get(PDFName.of("Fields")));
    const signatureField = fields.asArray().map(ref => doc.context.lookup(ref))
      .find(field => field.get(PDFName.of("FT")) === PDFName.of("Sig"));
    const signature = doc.context.lookup(signatureField.get(PDFName.of("V")));
    signature.set(PDFName.of("Reference"), doc.context.obj([
      doc.context.obj({
        Type: "SigRef", TransformMethod: "FieldMDP",
        TransformParams: doc.context.obj({ Type: "TransformParams", Action: "Include", Fields: [PDFString.of("grp")] }),
      }),
      doc.context.obj({
        Type: "SigRef", TransformMethod: "DocMDP",
        TransformParams: doc.context.obj({ Type: "TransformParams", P: 1 }),
      }),
    ]));
    const state = inspectSignatureState(doc);
    expect(state.certification).toBe(1);
    expect(isFieldLocked(state, "grp.company")).toBe(true);
    expect(isFieldLocked(state, "grp")).toBe(true);
    expect(isFieldLocked(state, "group")).toBe(false);
  });
});

describe("set_pdf_metadata (stdio)", () => {
  let client;
  let transport;
  let directory;

  async function call(args) {
    return client.callTool({ name: "set_pdf_metadata", arguments: args });
  }

  async function succeed(args) {
    const result = await call(args);
    expect(result.isError, JSON.stringify(result.content)).toBeFalsy();
    expect(validateStructuredToolResult("set_pdf_metadata", result).isError).toBeFalsy();
    return { text: result.content.map(block => block.text ?? "").join("\n"), structured: result.structuredContent };
  }

  async function refuse(args) {
    const result = await call(args);
    expect(result.isError).toBe(true);
    return result.content.map(block => block.text ?? "").join("\n");
  }

  beforeAll(async () => {
    directory = await createTestTempDirectory(REPO_ROOT, "set-pdf-metadata");
    transport = new StdioClientTransport({
      command: process.execPath,
      args: [path.join(REPO_ROOT, "server/index.js")],
      cwd: REPO_ROOT,
      env: {
        ...process.env,
        ALLOWED_DIRECTORIES: directory,
        DEFAULT_PROFILES_DIR: path.join(directory, "state"),
      },
      stderr: "pipe",
    });
    client = new Client({ name: "set-pdf-metadata-test", version: "1.0.0" });
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

  it("retitles in place: Info and XMP agree, the original bytes are a prefix, nothing else moves", async () => {
    const file = path.join(directory, "report.pdf");
    const original = await buildDocument();
    await fs.writeFile(file, original);
    const title = "Rapport Q3 — révisé ✓";
    const { text, structured } = await succeed({ pdf_path: file, output_path: file, title });
    expect(structured).toMatchObject({
      save_mode: "incremental",
      xmp: "updated",
      signatures_kept: 0,
      changes: [{ field: "title", before: "Old Title", after: title }],
    });
    expect(text).toContain("Info and XMP metadata were both updated.");
    expect(text).toContain("previous values remain in the file's revision history");
    const bytes = await fs.readFile(file);
    expect(keepsPrefix(new Uint8Array(bytes), original)).toBe(true);
    expect(await pdfjsMetadata(bytes)).toMatchObject({
      title,
      // PDF.js joins every rdf:Alt entry into one string; the French title
      // is kept, so it follows the new default one.
      xmpTitle: `${title}Ancien titre`,
      author: "Example Corp Records",
      xmpCreator: ["Example Corp Records"],
      subject: "Quarterly report",
      keywords: "alpha, beta",
      pages: 1,
    });
    const doc = await PDFDocument.load(bytes, { updateMetadata: false });
    const xmp = new TextDecoder().decode(doc.context.lookup(doc.catalog.get(PDFName.of("Metadata"))).getContents());
    expect(readXmpDocumentFields(xmp).title).toEqual({ state: "value", value: title });
    expect(xmp).toContain('<rdf:li xml:lang="fr">Ancien titre</rdf:li>');
  });

  it("stores an author list the way it reads back, in Info and XMP alike", async () => {
    for (const [index, [author, stored, creators]] of [
      ["Alice Example;Bob Example", "Alice Example; Bob Example", ["Alice Example", "Bob Example"]],
      ["Smith, J. ", "Smith, J.", ["Smith, J."]],
    ].entries()) {
      const file = path.join(directory, `authors-${index}.pdf`);
      await fs.writeFile(file, await buildDocument());
      const { structured } = await succeed({ pdf_path: file, output_path: file, author });
      expect(structured.changes).toEqual([{ field: "author", before: "Example Corp Records", after: stored }]);
      expect(await pdfjsMetadata(await fs.readFile(file))).toMatchObject({ author: stored, xmpCreator: creators });
    }
  });

  it("removes a field from both records on null, and rewrite mode drops the earlier revision", async () => {
    const file = path.join(directory, "rewrite.pdf");
    const output = path.join(directory, "rewrite-out.pdf");
    await fs.writeFile(file, await buildDocument());
    const { structured, text } = await succeed({
      pdf_path: file, output_path: output, keywords: null, save_mode: "rewrite",
    });
    expect(structured).toMatchObject({ save_mode: "rewrite", appended_objects: 0 });
    expect(text).toContain("does not keep the earlier revision");
    const bytes = await fs.readFile(output);
    const read = await pdfjsMetadata(bytes);
    expect(read.keywords).toBeNull();
    const doc = await PDFDocument.load(bytes, { updateMetadata: false });
    const xmp = new TextDecoder().decode(doc.context.lookup(doc.catalog.get(PDFName.of("Metadata"))).getContents());
    expect(readXmpDocumentFields(xmp).keywords).toEqual({ state: "absent" });
    expect(xmp).not.toContain("<rdf:Bag>");
  });

  it.skipIf(!OPENSSL)("keeps an existing signature verifying, and refuses to rewrite a signed file", async () => {
    const file = path.join(directory, "signed.pdf");
    await fs.copyFile(SIGNED_FIXTURE, file);
    const original = await fs.readFile(file);
    const refusal = await refuse({ pdf_path: file, output_path: file, title: "Nope", save_mode: "rewrite" });
    expect(refusal).toMatch(/would invalidate them/);
    expect((await fs.readFile(file)).equals(original)).toBe(true);

    const { structured, text } = await succeed({ pdf_path: file, output_path: file, title: "Signed and retitled" });
    expect(structured).toMatchObject({ save_mode: "incremental", signatures_kept: 1, xmp: "absent" });
    expect(text).toContain("1 existing signature(s) still cover their original bytes");
    const bytes = await fs.readFile(file);
    expect(keepsPrefix(new Uint8Array(bytes), new Uint8Array(original))).toBe(true);
    expect((await pdfjsMetadata(bytes)).title).toBe("Signed and retitled");
    expect(await signatureVerifies(file, directory)).toBe(true);
  });

  it("refuses a certified document and changes nothing", async () => {
    const file = path.join(directory, "certified.pdf");
    const original = await buildDocument({ certified: 2 });
    await fs.writeFile(file, original);
    const refusal = await refuse({ pdf_path: file, output_path: file, title: "Nope" });
    expect(refusal).toMatch(/certified \(DocMDP level 2\)/);
    expect((await fs.readFile(file)).equals(Buffer.from(original))).toBe(true);
  });

  it("refuses a metadata stream that would inflate past the cap, and leaves the file alone", async () => {
    const file = path.join(directory, "bomb.pdf");
    const doc = await PDFDocument.load(await buildDocument({ xmp: null }));
    doc.catalog.set(PDFName.of("Metadata"), doc.context.register(doc.context.stream(
      deflateSync(Buffer.alloc(2 * XMP_MAX_BYTES, 0x20)), { Type: "Metadata", Subtype: "XML", Filter: "FlateDecode" },
    )));
    const original = await doc.save();
    await fs.writeFile(file, original);
    const refusal = await refuse({ pdf_path: file, output_path: file, title: "Nope" });
    expect(refusal).toMatch(/xmp_too_large/);
    expect((await fs.readFile(file)).equals(Buffer.from(original))).toBe(true);
  });

  it("refuses XMP it cannot edit safely rather than leaving Info and XMP disagreeing", async () => {
    const file = path.join(directory, "ambiguous.pdf");
    const xmp = packet(`<rdf:Description rdf:about="" xmlns:dc="http://purl.org/dc/elements/1.1/">
<dc:title><rdf:Alt><rdf:li xml:lang="x-default">One</rdf:li></rdf:Alt></dc:title>
<dc:title><rdf:Alt><rdf:li xml:lang="x-default">Two</rdf:li></rdf:Alt></dc:title></rdf:Description>`);
    const original = await buildDocument({ xmp });
    await fs.writeFile(file, original);
    const refusal = await refuse({ pdf_path: file, output_path: file, title: "Three" });
    expect(refusal).toMatch(/xmp_property_repeated/);
    expect((await fs.readFile(file)).equals(Buffer.from(original))).toBe(true);
  });

  it.skipIf(!QPDF)("keeps the document Info of a linearized file with cross-reference streams", async () => {
    // pdf-lib keeps the first-page trailer of such a file, which has no /Info;
    // the edit must not mistake that for a document without metadata.
    const plain = path.join(directory, "plain-for-linearize.pdf");
    const file = path.join(directory, "linearized.pdf");
    await fs.writeFile(plain, await buildDocument({ xmp: null }));
    execFileSync("qpdf", ["--linearize", "--object-streams=generate", plain, file]);
    const { structured } = await succeed({ pdf_path: file, output_path: file, subject: "Linearized subject" });
    expect(structured.changes).toEqual([{ field: "subject", before: "Quarterly report", after: "Linearized subject" }]);
    expect(await pdfjsMetadata(await fs.readFile(file))).toMatchObject({
      title: "Old Title", author: "Example Corp Records", subject: "Linearized subject",
    });
  });

  it("refuses a control character in a value", async () => {
    const file = path.join(directory, "control.pdf");
    await fs.writeFile(file, await buildDocument());
    expect(await refuse({ pdf_path: file, output_path: file, title: "bad\u0001" })).toMatch(/control character/);
  });

  it("asks for at least one field", async () => {
    const file = path.join(directory, "empty-edit.pdf");
    await fs.writeFile(file, await buildDocument());
    expect(await refuse({ pdf_path: file, output_path: file })).toMatch(/at least one of title, author, subject or keywords/);
  });
});
