// Metadata decoding in get_pdf_info (and compare_pdfs, which shares the same
// observation) is bounded: PDF.js's getMetadata() is called only when every
// stream it could decode as XMP is small enough, judged from the file's raw
// bytes (server/metadata-stream-bound.js). Otherwise Info and XMP are
// reported unavailable with METADATA_STREAM_UNBOUNDED.

import { execFileSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { once } from "node:events";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createDeflate, deflateSync } from "node:zlib";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { PDFDocument, PDFName } from "pdf-lib";
import { METADATA_FLATE_RAW_LIMIT, metadataStreamsBounded } from "../server/metadata-stream-bound.js";
import { createTestTempDirectory, removeTestTempDirectory } from "./helpers/temp-directory.js";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const OBSERVE = path.join(REPO_ROOT, "test/helpers/observe-document-rss.mjs");
const PEAK_RSS_LIMIT_BYTES = 400 * 1024 * 1024;

function hasQpdf() {
  try {
    execFileSync("qpdf", ["--version"], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}
const QPDF = hasQpdf();

const XMP = title => `<?xpacket begin="﻿" id="W5M0MpCehiHzreSzNTczkc9d"?>
<x:xmpmeta xmlns:x="adobe:ns:meta/"><rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#">
<rdf:Description rdf:about="" xmlns:dc="http://purl.org/dc/elements/1.1/">
<dc:title><rdf:Alt><rdf:li xml:lang="x-default">${title}</rdf:li></rdf:Alt></dc:title>
</rdf:Description></rdf:RDF></x:xmpmeta>
<?xpacket end="w"?>`;

/** Raw bytes of a file holding these objects; the gate needs no xref. */
function rawPdf(...objects) {
  const parts = [Buffer.from("%PDF-1.7\n")];
  for (const object of objects) parts.push(Buffer.isBuffer(object) ? object : Buffer.from(object, "latin1"));
  parts.push(Buffer.from("trailer\n<< /Root 1 0 R >>\n%%EOF\n"));
  return Buffer.concat(parts);
}

function streamObject(number, dictionary, data, { length = data.length } = {}) {
  return Buffer.concat([
    Buffer.from(`${number} 0 obj\n<< ${dictionary} /Length ${length} >>\nstream\n`, "latin1"),
    data,
    Buffer.from("\nendstream\nendobj\n", "latin1"),
  ]);
}

/** A Flate stream of the given number of spaces, deflated in chunks. */
async function deflatedSpaces(totalBytes) {
  const deflate = createDeflate({ level: 9 });
  const chunks = [];
  deflate.on("data", chunk => chunks.push(chunk));
  const ended = once(deflate, "end");
  const block = Buffer.alloc(1024 * 1024, 0x20);
  for (let written = 0; written < totalBytes; written += block.length) {
    if (!deflate.write(block)) await once(deflate, "drain");
  }
  deflate.end();
  await ended;
  return Buffer.concat(chunks);
}

async function documentWithMetadata(stream, { title = "Info Title" } = {}) {
  const doc = await PDFDocument.create();
  doc.addPage([200, 200]);
  doc.setTitle(title);
  doc.catalog.set(PDFName.of("Metadata"), doc.context.register(stream(doc.context)));
  return Buffer.from(await doc.save());
}

function observe(file) {
  const stdout = execFileSync(process.execPath, [OBSERVE, file], {
    cwd: REPO_ROOT,
    encoding: "utf8",
    maxBuffer: 16 * 1024 * 1024,
    stdio: ["ignore", "pipe", "ignore"],
    timeout: 120_000,
  });
  return JSON.parse(stdout.slice(stdout.indexOf("{\"reason_codes\"")));
}

describe("metadataStreamsBounded", () => {
  it("clears ordinary documents, plain or compressed, with or without object streams", async () => {
    const plain = await documentWithMetadata(context => context.stream(new TextEncoder().encode(XMP("Plain")), {
      Type: "Metadata", Subtype: "XML",
    }));
    const flate = await documentWithMetadata(context => context.flateStream(new TextEncoder().encode(XMP("Flate")), {
      Type: "Metadata", Subtype: "XML",
    }), { title: "Upstream stream\n notes" });
    expect(metadataStreamsBounded(plain)).toEqual({ bounded: true });
    expect(metadataStreamsBounded(flate)).toEqual({ bounded: true });
    const reloaded = await PDFDocument.load(flate);
    expect(metadataStreamsBounded(Buffer.from(await reloaded.save({ useObjectStreams: false })))).toEqual({ bounded: true });
    expect(metadataStreamsBounded(await fs.readFile(path.join(REPO_ROOT, "example-fw9.pdf")))).toEqual({ bounded: true });
  });

  it("allows Flate XMP up to the raw limit and refuses one past it", () => {
    const below = randomBytes(METADATA_FLATE_RAW_LIMIT - 1024);
    const above = randomBytes(METADATA_FLATE_RAW_LIMIT + 1024);
    const typed = "/Type /Metadata /Subtype /XML /Filter /FlateDecode";
    expect(metadataStreamsBounded(rawPdf(streamObject(2, typed, below)))).toEqual({ bounded: true });
    expect(metadataStreamsBounded(rawPdf(streamObject(2, typed, above))))
      .toEqual({ bounded: false, reason: "stream_too_large" });
    // A stream not marked as XMP is never decoded as metadata.
    expect(metadataStreamsBounded(rawPdf(streamObject(2, "/Type /XObject /Subtype /Image /Filter /FlateDecode", above))))
      .toEqual({ bounded: true });
  });

  it("checks every candidate in the file, not only the one a parser resolves", () => {
    // Two definitions of object 2: whichever one a reader picks, both count.
    const small = streamObject(2, "/Type /Metadata /Subtype /XML /Filter /FlateDecode", randomBytes(100));
    const large = streamObject(2, "/Type /Metadata /Subtype /XML /Filter /FlateDecode", randomBytes(METADATA_FLATE_RAW_LIMIT + 1));
    expect(metadataStreamsBounded(rawPdf(large, small))).toEqual({ bounded: false, reason: "stream_too_large" });
    expect(metadataStreamsBounded(rawPdf(small, large))).toEqual({ bounded: false, reason: "stream_too_large" });
    // An indirect /Type or /Subtype could resolve to the XMP names.
    expect(metadataStreamsBounded(rawPdf(
      streamObject(2, "/Type 7 0 R /Subtype /XML /Filter /FlateDecode", randomBytes(METADATA_FLATE_RAW_LIMIT + 1)),
    ))).toEqual({ bounded: false, reason: "stream_too_large" });
  });

  it("counts a stream whose end cannot be determined as unbounded", () => {
    const typed = "/Type /Metadata /Subtype /XML /Filter /FlateDecode";
    // No endstream anywhere after the data.
    expect(metadataStreamsBounded(rawPdf(`2 0 obj\n<< ${typed} /Length 10 >>\nstream\n0123456789`)))
      .toEqual({ bounded: false, reason: "stream_end_unknown" });
    // An indirect /Length defined once is read; twice or never is ambiguous.
    const data = randomBytes(200);
    const indirect = streamObject(2, typed, data, { length: "9 0 R" });
    expect(metadataStreamsBounded(rawPdf(indirect, `9 0 obj\n${data.length}\nendobj\n`))).toEqual({ bounded: true });
    expect(metadataStreamsBounded(rawPdf(indirect, `9 0 obj\n${data.length}\nendobj\n`, "9 0 obj\n999999\nendobj\n")))
      .toEqual({ bounded: false, reason: "stream_end_unknown" });
    expect(metadataStreamsBounded(rawPdf(indirect))).toEqual({ bounded: false, reason: "stream_end_unknown" });
  });

  it("refuses other or chained filters, and a dictionary it cannot read before a stream", () => {
    const data = randomBytes(64);
    expect(metadataStreamsBounded(rawPdf(streamObject(2, "/Type /Metadata /Subtype /XML /Filter /LZWDecode", data))))
      .toEqual({ bounded: false, reason: "filter_unsupported" });
    expect(metadataStreamsBounded(rawPdf(streamObject(2, "/Type /Metadata /Subtype /XML /Filter [/FlateDecode /FlateDecode]", data))))
      .toEqual({ bounded: false, reason: "filter_unsupported" });
    expect(metadataStreamsBounded(rawPdf("2 0 obj\n<< /Type /Metadata /Subtype /XML /Length 3 ] >>\nstream\nabc\nendstream\nendobj\n")))
      .toEqual({ bounded: false, reason: "dictionary_unreadable" });
  });

  it("scans a large ordinary file in linear time", () => {
    const object = Buffer.from(`1 0 obj\n<< /Length 1000 >>\nstream\n${"x".repeat(1000)}\nendstream\nendobj\n`, "latin1");
    const bytes = Buffer.alloc(240 * 1024 * 1024);
    bytes.fill(object);
    const started = performance.now();
    expect(metadataStreamsBounded(bytes)).toEqual({ bounded: true });
    // About half a second on a development machine; the bound leaves room.
    expect(performance.now() - started).toBeLessThan(5_000);
  }, 60_000);

  it("stops recording markers past its limit instead of allocating without bound", () => {
    const dense = Buffer.alloc(64 * 1024 * 1024);
    dense.fill(Buffer.from("1 0 obj stream\n"));
    expect(metadataStreamsBounded(dense)).toEqual({ bounded: false, reason: "too_many_objects" });
  }, 60_000);
});

describe("get_pdf_info metadata decoding (observe_document, in process)", () => {
  let directory;
  let compressed;

  beforeAll(async () => {
    directory = await createTestTempDirectory(REPO_ROOT, "metadata-bound");
    // 256 MiB of spaces: about 250 KB once deflated, far past the raw limit.
    compressed = await deflatedSpaces(256 * 1024 * 1024);
    expect(compressed.length).toBeGreaterThan(METADATA_FLATE_RAW_LIMIT);
  }, 60_000);

  afterAll(async () => {
    await removeTestTempDirectory(directory);
  });

  it("reports metadata as unavailable for an unbounded stream, with bounded memory", async () => {
    const file = path.join(directory, "large-metadata.pdf");
    await fs.writeFile(file, await documentWithMetadata(context => context.stream(compressed, {
      Type: "Metadata", Subtype: "XML", Filter: "FlateDecode",
    })));
    const result = observe(file);
    expect(result.reason_codes).toContain("METADATA_STREAM_UNBOUNDED");
    expect(result.info).toEqual({});
    expect(result.xmp).toEqual({});
    expect(result.max_rss_bytes).toBeLessThan(PEAK_RSS_LIMIT_BYTES);
  }, 120_000);

  it.skipIf(!QPDF)("does the same for an encrypted file that opens without a password", async () => {
    const plain = path.join(directory, "large-metadata-plain.pdf");
    const file = path.join(directory, "large-metadata-encrypted.pdf");
    await fs.writeFile(plain, await documentWithMetadata(context => context.stream(compressed, {
      Type: "Metadata", Subtype: "XML", Filter: "FlateDecode",
    })));
    execFileSync("qpdf", ["--encrypt", "", "owner-secret", "256", "--", plain, file]);
    const result = observe(file);
    expect(result.reason_codes).toContain("METADATA_STREAM_UNBOUNDED");
    // compare_pdfs still learns the file is encrypted, from the trailer.
    expect(result.info).toEqual({ EncryptFilterName: "Standard" });
    expect(result.max_rss_bytes).toBeLessThan(PEAK_RSS_LIMIT_BYTES);
  }, 120_000);

  it("reads an ordinary packet, and one near the raw limit, exactly as before", async () => {
    const ordinary = path.join(directory, "ordinary.pdf");
    await fs.writeFile(ordinary, await documentWithMetadata(context => context.flateStream(
      new TextEncoder().encode(XMP("Annual Report")), { Type: "Metadata", Subtype: "XML" },
    ), { title: "Annual Report" }));
    const plainResult = observe(ordinary);
    expect(plainResult.reason_codes).toEqual([]);
    expect(plainResult.info).toMatchObject({ Title: "Annual Report", PDFFormatVersion: "1.7" });
    expect(plainResult.xmp).toMatchObject({ "dc:title": "Annual Report" });

    // About 60 KiB once deflated: base64 of random bytes compresses to 3/4.
    const filler = randomBytes(58 * 1024).toString("base64");
    const packet = XMP("Large Packet").replace("</rdf:Description>", `<dc:source>${filler}</dc:source></rdf:Description>`);
    const raw = deflateSync(Buffer.from(packet, "utf8"));
    expect(raw.length).toBeGreaterThan(55 * 1024);
    expect(raw.length).toBeLessThan(METADATA_FLATE_RAW_LIMIT);
    const large = path.join(directory, "large-packet.pdf");
    await fs.writeFile(large, await documentWithMetadata(context => context.stream(raw, {
      Type: "Metadata", Subtype: "XML", Filter: "FlateDecode",
    }), { title: "Large Packet" }));
    const largeResult = observe(large);
    expect(largeResult.reason_codes).not.toContain("METADATA_STREAM_UNBOUNDED");
    expect(largeResult.xmp).toMatchObject({ "dc:title": "Large Packet" });
  }, 120_000);
});
