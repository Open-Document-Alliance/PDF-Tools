// Decoded data is bounded (server/decode-budget.js, server/pdfjs-bounded.js): PDF.js's pinned worker is
// loaded with a guard in each decode growth path, pdf-lib's stream decoder is
// capped, and every PDF.js operation runs with its own budget. get_pdf_info
// reports document metadata it could not decode within the limit as a
// coverage gap.

import { execFileSync } from "node:child_process";
import { once } from "node:events";
import { readFileSync } from "node:fs";
import fs from "node:fs/promises";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createDeflate, deflateSync } from "node:zlib";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import {
  PDFDocument,
  PDFName,
  concatTransformationMatrix,
  drawObject,
  popGraphicsState,
  pushGraphicsState,
} from "pdf-lib";
import { validateStructuredToolResult } from "../server/output-schemas.js";
import {
  DecodeBudgetExceeded,
  MAX_DECODED_CALL_BYTES,
  MAX_DECODED_STREAM_BYTES,
  decodeLimitReached,
  guardDecodeGrowth,
  withCallBudget,
} from "../server/decode-budget.js";
import { BoundedPdfjsUnavailable, boundedWorkerSource } from "../server/pdfjs-bounded.js";
import { hashBoundedPdfFileSafely } from "../server/bounded-pdf-file.js";
import { PDF_RESOURCE_LIMIT_CODE, createPdfjsSubprocessRequest, runPdfjsSubprocess } from "../server/pdfjs-subprocess.js";
import { createTestTempDirectory, removeTestTempDirectory } from "./helpers/temp-directory.js";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const OBSERVE = path.join(REPO_ROOT, "test/helpers/observe-document-in-process.mjs");
const require = createRequire(import.meta.url);
const MIB = 1024 * 1024;

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

/** Flate data that decodes to the given number of spaces, built in chunks. */
async function deflatedSpaces(totalBytes) {
  const deflate = createDeflate({ level: 9 });
  const chunks = [];
  deflate.on("data", chunk => chunks.push(chunk));
  const ended = once(deflate, "end");
  const block = Buffer.alloc(MIB, 0x20);
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
    maxBuffer: 16 * MIB,
    stdio: ["ignore", "pipe", "ignore"],
    timeout: 120_000,
  });
  return JSON.parse(stdout.slice(stdout.indexOf("{\"reason_codes\"")));
}

describe("bounded decode budget", () => {
  it("applies every PDF.js hook exactly once to the pinned worker, and refuses a source it does not match", () => {
    expect(require("pdfjs-dist/package.json").version).toBe("5.4.624");
    const source = readFileSync(require.resolve("pdfjs-dist/legacy/build/pdf.worker.mjs"), "utf8");
    const patched = boundedWorkerSource(source);
    expect(patched.match(/globalThis\.__pdfToolsGuardDecodeGrowth\(/g)).toHaveLength(2);
    expect(patched.match(/globalThis\.__pdfToolsGuardImagePixels\(/g)).toHaveLength(3);
    expect(patched.match(/globalThis\.__pdfToolsGuardImageAllocation\(/g)).toHaveLength(2);
    expect(() => boundedWorkerSource(source.replace("  ensureBuffer(requested) {", "  ensureBuffer(n) {")))
      .toThrow(BoundedPdfjsUnavailable);
  });

  it("limits each stream and each call, and records that a limit was reached", async () => {
    await withCallBudget(async () => {
      expect(() => guardDecodeGrowth(MAX_DECODED_STREAM_BYTES + 1, 0)).toThrow(DecodeBudgetExceeded);
      expect(decodeLimitReached()).toBe(true);
    });
    await withCallBudget(async () => {
      for (let used = 0; used + 64 * MIB <= MAX_DECODED_CALL_BYTES; used += 64 * MIB) guardDecodeGrowth(64 * MIB, 0);
      expect(decodeLimitReached()).toBe(false);
      expect(() => guardDecodeGrowth(64 * MIB, 0)).toThrow(DecodeBudgetExceeded);
      expect(decodeLimitReached()).toBe(true);
    });
    await withCallBudget(async () => expect(decodeLimitReached()).toBe(false));
  });

  it("does not accumulate one budget across work outside a call", () => {
    // A long-running local server decodes far more than one call's budget
    // over its lifetime; only the per-stream limit applies outside a call.
    for (let index = 0; index < 16; index += 1) guardDecodeGrowth(64 * MIB, 0);
    expect(() => guardDecodeGrowth(MAX_DECODED_STREAM_BYTES + 1, 0)).toThrow(DecodeBudgetExceeded);
    expect(decodeLimitReached()).toBe(false);
  });

  it("caps pdf-lib's stream decoder", async () => {
    const data = deflateSync(Buffer.alloc(MAX_DECODED_STREAM_BYTES + 16 * MIB, 0x20), { level: 9 });
    const doc = await PDFDocument.create();
    const stream = doc.context.stream(data, { Filter: "FlateDecode" });
    const { decodePDFRawStream } = await import("pdf-lib");
    await withCallBudget(async () => {
      expect(() => decodePDFRawStream(stream).decode()).toThrow(DecodeBudgetExceeded);
      expect(decodeLimitReached()).toBe(true);
    });
  }, 60_000);
});

describe("get_pdf_info metadata decoding (observe_document, in process)", () => {
  let directory;
  let compressed;

  beforeAll(async () => {
    directory = await createTestTempDirectory(REPO_ROOT, "bounded-decode");
    compressed = await deflatedSpaces(512 * MIB);
  }, 60_000);

  afterAll(async () => {
    await removeTestTempDirectory(directory);
  });

  it("reports metadata it cannot decode within the limit as a gap, keeps Info, and stays bounded", async () => {
    const file = path.join(directory, "metadata-over-limit.pdf");
    await fs.writeFile(file, await documentWithMetadata(context => context.stream(compressed, {
      Type: "Metadata", Subtype: "XML", Filter: "FlateDecode",
    }), { title: "Kept Title" }));
    const result = observe(file);
    expect(result.reason_codes).toContain("METADATA_STREAM_UNBOUNDED");
    expect(result.info).toMatchObject({ Title: "Kept Title" });
    expect(result.xmp).toEqual({});
    expect(result.max_rss_bytes).toBeLessThan(MAX_DECODED_STREAM_BYTES + 384 * MIB);
  }, 120_000);

  it.skipIf(!QPDF)("does the same for an encrypted file that opens without a password", async () => {
    const plain = path.join(directory, "metadata-over-limit-plain.pdf");
    const file = path.join(directory, "metadata-over-limit-encrypted.pdf");
    await fs.writeFile(plain, await documentWithMetadata(context => context.stream(compressed, {
      Type: "Metadata", Subtype: "XML", Filter: "FlateDecode",
    }), { title: "Kept Title" }));
    execFileSync("qpdf", ["--encrypt", "", "owner-secret", "256", "--", plain, file]);
    const result = observe(file);
    expect(result.reason_codes).toContain("METADATA_STREAM_UNBOUNDED");
    expect(result.info).toMatchObject({ Title: "Kept Title", EncryptFilterName: "Standard" });
    expect(result.max_rss_bytes).toBeLessThan(MAX_DECODED_STREAM_BYTES + 384 * MIB);
  }, 120_000);

  it("stops a PDF.js subprocess whose memory grows past the backstop limit", async () => {
    const file = path.join(REPO_ROOT, "example-fw9.pdf");
    const sourceFile = await hashBoundedPdfFileSafely(file, 250 * MIB, { assertPathAllowed: candidate => candidate });
    const request = () => createPdfjsSubprocessRequest({
      operation: "observe_document",
      source: {
        canonical_path: sourceFile.canonicalPath,
        file_identity: sourceFile.fileIdentity,
        sha256: sourceFile.sha256,
        size_bytes: sourceFile.sizeBytes,
      },
      password: null,
      allowedDirectories: [path.dirname(file)],
      options: { max_pages: 1, max_output_characters: 20_000 },
    });
    // With the ordinary limits the same read succeeds.
    await expect(runPdfjsSubprocess(request(), { isolationMode: "subprocess", timeoutMs: 60_000 }))
      .resolves.toMatchObject({ coverage: expect.any(Object) });
    await expect(runPdfjsSubprocess(request(), {
      isolationMode: "subprocess",
      timeoutMs: 60_000,
      memoryGrowthBytes: MIB,
    })).rejects.toMatchObject({ code: PDF_RESOURCE_LIMIT_CODE, reason: "worker_memory_limit" });
  }, 120_000);

  it("reads ordinary metadata exactly as before", async () => {
    const file = path.join(directory, "ordinary.pdf");
    await fs.writeFile(file, await documentWithMetadata(context => context.flateStream(
      new TextEncoder().encode(XMP("Annual Report")), { Type: "Metadata", Subtype: "XML" },
    ), { title: "Annual Report" }));
    const result = observe(file);
    expect(result.reason_codes).toEqual([]);
    expect(result.info).toMatchObject({ Title: "Annual Report", PDFFormatVersion: "1.7" });
    expect(result.xmp).toMatchObject({ "dc:title": "Annual Report" });
  }, 120_000);
});

/** One page drawing a gray image of the given pixel size, Flate-encoded. */
async function documentWithImage(width, height) {
  const doc = await PDFDocument.create();
  const page = doc.addPage([612, 792]);
  const data = deflateSync(Buffer.alloc(width * height, 0xcc), { level: 9 });
  const image = doc.context.register(doc.context.stream(data, {
    Type: "XObject",
    Subtype: "Image",
    Width: width,
    Height: height,
    ColorSpace: "DeviceGray",
    BitsPerComponent: 8,
    Filter: "FlateDecode",
  }));
  page.node.setXObject(PDFName.of("Im1"), image);
  page.pushOperators(
    pushGraphicsState(),
    concatTransformationMatrix(512, 0, 0, 692, 50, 50),
    drawObject("Im1"),
    popGraphicsState(),
  );
  page.drawText("Poster caption", { x: 50, y: 760, size: 12 });
  return Buffer.from(await doc.save());
}

describe("images over the image limit (stdio)", () => {
  let client;
  let transport;
  let directory;
  let posterPath;

  beforeAll(async () => {
    directory = await createTestTempDirectory(REPO_ROOT, "bounded-decode-images");
    posterPath = path.join(directory, "poster.pdf");
    // 8200 x 8200 is just over the 64M-pixel image limit.
    await fs.writeFile(posterPath, await documentWithImage(8200, 8200));
    transport = new StdioClientTransport({
      command: process.execPath,
      args: [path.join(REPO_ROOT, "server/index.js")],
      cwd: REPO_ROOT,
      env: { ...process.env, ALLOWED_DIRECTORIES: directory, DEFAULT_PROFILES_DIR: path.join(directory, "state") },
      stderr: "pipe",
    });
    client = new Client({ name: "bounded-decode-images-test", version: "1.0.0" });
    await client.connect(transport);
  }, 60_000);

  afterAll(async () => {
    try {
      await client?.close();
      await transport?.close();
    } finally {
      await removeTestTempDirectory(directory);
    }
  });

  it("renders the rest of the page and says the image was not drawn", async () => {
    const result = await client.callTool({ name: "render_pdf_page", arguments: { pdf_path: posterPath, page: 1 } });
    expect(result.isError, JSON.stringify(result.content?.[0])).toBeFalsy();
    expect(validateStructuredToolResult("render_pdf_page", result).isError).toBeFalsy();
    expect(result.structuredContent.images_skipped_at_limit).toBe(1);
    expect(result.content[0].text).toMatch(/Incomplete render: 1 image\(s\) on this page exceed the image size limit/);
  }, 120_000);

  it("renders a page whose scan is larger than the renderer can draw, and says so", async () => {
    // About 600 dpi A4: within the decode limits, beyond the 16-megapixel canvas.
    const scan = path.join(directory, "scan-600dpi.pdf");
    await fs.writeFile(scan, await documentWithImage(4961, 7016));
    const result = await client.callTool({ name: "render_pdf_page", arguments: { pdf_path: scan, page: 1 } });
    expect(result.isError, JSON.stringify(result.content?.[0])).toBeFalsy();
    expect(result.structuredContent.images_skipped_at_limit).toBe(1);
    expect(result.content[0].text).toMatch(/at most 16 megapixels/);
  }, 120_000);

  it("leaves an ordinary render's result without the field", async () => {
    const ordinary = path.join(directory, "ordinary.pdf");
    await fs.writeFile(ordinary, await documentWithImage(400, 400));
    const result = await client.callTool({ name: "render_pdf_page", arguments: { pdf_path: ordinary, page: 1 } });
    expect(result.isError).toBeFalsy();
    expect(result.structuredContent).not.toHaveProperty("images_skipped_at_limit");
    expect(result.content[0].text).not.toMatch(/Incomplete render/);
  }, 120_000);

  it("refuses page text past the decode limit with a typed, explained error", async () => {
    const doc = await PDFDocument.create();
    const page = doc.addPage([612, 792]);
    const body = Buffer.alloc(MAX_DECODED_STREAM_BYTES + 2 * MIB, 0x20);
    body.write("BT ET", body.length - 6, "latin1");
    page.node.set(PDFName.of("Contents"), doc.context.register(
      doc.context.stream(deflateSync(body, { level: 9 }), { Filter: "FlateDecode" }),
    ));
    const file = path.join(directory, "large-content.pdf");
    await fs.writeFile(file, await doc.save());
    const result = await client.callTool({
      name: "read_pdf_pages",
      arguments: { pdf_path: file, start_page: 1, end_page: 1 },
    });
    expect(result.isError).toBe(true);
    expect(result.structuredContent.error.code).toBe("PDF_RESOURCE_LIMIT_EXCEEDED");
    expect(result.content[0].text).toMatch(/decodes to more than PDF Tools processes \(128 MiB per stream/);
  }, 120_000);

  it("marks a visual comparison partial when an image was not drawn", async () => {
    const copy = path.join(directory, "poster-copy.pdf");
    await fs.copyFile(posterPath, copy);
    const result = await client.callTool({
      name: "compare_pdfs",
      arguments: { before_pdf_path: posterPath, after_pdf_path: copy, include_visual: true },
    });
    expect(result.isError, JSON.stringify(result.content?.[0])).toBeFalsy();
    expect(result.structuredContent.coverage.visual).toMatchObject({ status: "partial" });
    expect(result.structuredContent.coverage.visual.reason_codes).toContain("VISUAL_IMAGES_SKIPPED_AT_LIMIT");
  }, 180_000);
});

