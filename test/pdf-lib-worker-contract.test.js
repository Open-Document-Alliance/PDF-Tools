import { afterEach, describe, expect, it } from "vitest";
import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import zlib from "node:zlib";
import { fileURLToPath } from "node:url";
import {
  PDFArray,
  PDFDict,
  PDFDocument,
  PDFHexString,
  PDFInvalidObject,
  PDFName,
  PDFNumber,
  PDFRawStream,
  PDFRef,
  PDFString,
} from "pdf-lib";
import {
  __testOnlyCopyPdfPagesForRebuiltOutput,
  assertBoundedPdfStructure,
  assertBoundedPdfStreamDecodes,
  assertSafeParsedPdfComplexity,
  assertSafeParsedPdfDecodeChains,
  enforceSafeParsedPdfGraph,
  executePdfLibMutationRequest,
  isExpectedMalformedStreamDecodeError,
  loadPdfForMutation,
  savePdfDocumentSafely,
} from "../server/pdf-lib-worker.js";
import {
  buildPdf,
  makeDeepMalformedFixtures,
} from "./helpers/deep-malformed-fixtures.js";

const roots = [];
const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const STRUCTURE_BOUNDARY_BYTES = 1024 * 1024;
const PDF_LIB_FLATE_CJS_SHA256 =
  "e5e279bd3642c8fd52582605f61514162cdff563523ae0963664a7aa05ff4f03";
const PDF_LIB_OBJECT_COPIER_CJS_SHA256 =
  "5945e1d9bd61e763b540b5fc9ef3feb4bdc08349bafcb7fbebb04bc95f0a248a";
const typedSlot = (...segments) => segments
  .map(([kind, value = null]) => JSON.stringify([kind, value]))
  .join("\n")
  + (segments.length > 0 ? "\n" : "");

// Build the cross-reference-stream fixture in the test rather than committing
// a binary: pdf-lib's own object-stream writer emits a conforming /Type /XRef
// dictionary, and only its /W array is rewritten. The /W array sits after the
// byte offset that startxref points at, so rewriting it cannot disturb any
// other structure the parser depends on.
async function xrefStreamPdfWithByteWidths(widths) {
  const document = await PDFDocument.create();
  document.addPage([200, 200]);
  const written = Buffer.from(await document.save({ useObjectStreams: true }));
  const text = written.toString("latin1");
  if (!/\/Type\s*\/XRef/.test(text) || !/\/W\s*\[[^\]]*\]/.test(text)) {
    throw new Error("pdf-lib no longer writes a cross-reference stream with a /W array.");
  }
  if (widths === null) return written;
  return Buffer.from(text.replace(/\/W\s*\[[^\]]*\]/, widths), "latin1");
}

// Keep the expansion fixture reproducible and tied to the exact parser/writer
// combination under test. A referenced PDFString is eligible for pdf-lib's
// own object-stream writer, which emits the same eager /ObjStm decode path the
// production loader uses.
async function pdfLibObjectStreamExpansionPdf(decodedStringBytes) {
  const document = await PDFDocument.create();
  document.addPage([100, 100]);
  const ref = document.context.register(PDFString.of("A".repeat(decodedStringBytes)));
  document.catalog.set(PDFName.of("ExpansionFixture"), ref);
  const bytes = Buffer.from(await document.save({ useObjectStreams: true }));
  expect(bytes.toString("latin1")).toMatch(/\/Type\s*\/ObjStm/);
  return bytes;
}

function sparseDeclarationAcrossBoundary(prefix, suffix) {
  const header = Buffer.from("%PDF-1.7\n", "ascii");
  const declarationPrefix = Buffer.from(prefix, "ascii");
  const padding = Buffer.alloc(
    STRUCTURE_BOUNDARY_BYTES - header.length - declarationPrefix.length,
    0x20,
  );
  return Buffer.concat([
    header,
    padding,
    declarationPrefix,
    Buffer.alloc(8193, 0x20),
    Buffer.from(`${suffix}\n%%EOF\n`, "ascii"),
  ]);
}

function parsedStreamPdf(filterDeclaration = null, {
  payload = "q Q",
  extraObjects = [],
} = {}) {
  const filter = filterDeclaration === null
    ? ""
    : ` /Filter ${filterDeclaration}`;
  return buildPdf([
    [1, "<< /Type /Catalog /Pages 2 0 R >>"],
    [2, "<< /Type /Pages /Kids [3 0 R] /Count 1 >>"],
    [3, "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 100 100] "
      + "/Resources <<>> /Contents 4 0 R >>"],
    [4, `<< /Length ${Buffer.byteLength(payload, "latin1")}${filter} >>`
      + `\nstream\n${payload}\nendstream`],
    ...extraObjects,
  ], 1);
}

function flateContentPdf(expandedBytes) {
  const payload = zlib.deflateSync(Buffer.alloc(expandedBytes, 0x41), { level: 9 });
  return buildPdf([
    [1, "<< /Type /Catalog /Pages 2 0 R >>"],
    [2, "<< /Type /Pages /Kids [3 0 R] /Count 1 >>"],
    [3, "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 100 100] "
      + "/Resources <<>> /Contents 4 0 R >>"],
    [4, `<< /Length ${payload.length} /Filter /FlateDecode >>`
      + `\nstream\n${payload.toString("latin1")}\nendstream`],
  ], 1);
}

async function requestFor(bytes) {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "pdflib-worker-contract-")));
  roots.push(root);
  const sourcePath = path.join(root, "source.pdf");
  const stageDirectory = path.join(root, "stage");
  await fs.writeFile(sourcePath, bytes, { mode: 0o600 });
  await fs.mkdir(stageDirectory, { mode: 0o700 });
  const stats = await fs.lstat(sourcePath, { bigint: true });
  return {
    stageDirectory,
    request: {
      protocol_version: 1,
      operation: "rotate_pdf_pages",
      sources: [{
        canonical_path: sourcePath,
        file_identity: { device: String(stats.dev), inode: String(stats.ino) },
        size_bytes: bytes.length,
        sha256: createHash("sha256").update(bytes).digest("hex"),
      }],
      password: null,
      options: { pages: [], degrees: 90 },
      force_xfa: false,
      stage_directory: stageDirectory,
    },
  };
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map(root => fs.rm(root, { recursive: true, force: true })));
});

describe("pdf-lib mutation worker contract", () => {
  describe("pre-parse object-stream expansion budget", () => {
    it("refuses a pdf-lib-written object stream above the production ceiling", {
      timeout: 30_000,
    }, async () => {
      const bytes = await pdfLibObjectStreamExpansionPdf(17 * 1024 * 1024);
      await expect(assertBoundedPdfStreamDecodes(bytes)).rejects.toMatchObject({
        name: "PdfResourceLimitError",
        code: "PDF_RESOURCE_LIMIT_EXCEEDED",
        reason: "unsafe_object_stream_expansion",
      });
    });

    it("runs the decoded ceiling before the production mutation parser", {
      timeout: 30_000,
    }, async () => {
      const bytes = await pdfLibObjectStreamExpansionPdf(17 * 1024 * 1024);
      await expect(loadPdfForMutation(bytes)).rejects.toMatchObject({
        reason: "unsafe_object_stream_expansion",
      });
    });

    it("enforces an injected small ceiling without coupling the test to a huge allocation", async () => {
      const bytes = await pdfLibObjectStreamExpansionPdf(2 * 1024 * 1024);
      await expect(assertBoundedPdfStreamDecodes(bytes, {
        maximumDecodedObjectStreamBytes: 1024 * 1024,
      })).rejects.toMatchObject({
        code: "PDF_RESOURCE_LIMIT_EXCEEDED",
        reason: "unsafe_object_stream_expansion",
      });
    });

    it("accepts a highly compressible object stream below the byte ceiling", async () => {
      const bytes = await pdfLibObjectStreamExpansionPdf(8 * 1024 * 1024);
      expect(bytes.length).toBeLessThan(32 * 1024);
      await expect(assertBoundedPdfStreamDecodes(bytes)).resolves.toBeUndefined();
      await expect(loadPdfForMutation(bytes)).resolves.toBeDefined();
    });

    it("accepts an ordinary pdf-lib object-stream PDF", async () => {
      const document = await PDFDocument.create();
      for (let index = 0; index < 100; index += 1) document.addPage([200, 200]);
      const bytes = Buffer.from(await document.save({ useObjectStreams: true }));
      await expect(assertBoundedPdfStreamDecodes(bytes)).resolves.toBeUndefined();
      await expect(loadPdfForMutation(bytes)).resolves.toBeDefined();
    });

    it("accepts an ordinary well-formed compressed content stream", async () => {
      const bytes = flateContentPdf(4 * 1024 * 1024);
      await expect(assertBoundedPdfStreamDecodes(bytes)).resolves.toBeUndefined();
      await expect(loadPdfForMutation(bytes)).resolves.toBeDefined();
    });

    it("leaves a non-object stream with an image-only filter to existing controls", async () => {
      const bytes = parsedStreamPdf("/DCTDecode", { payload: "not-decoded-by-this-preflight" });
      await expect(assertBoundedPdfStreamDecodes(bytes)).resolves.toBeUndefined();
    });

    it.each([
      ["an indirect Type", "/Type 5 0 R /Filter /FlateDecode"],
      ["an indirect Filter", "/Type /ObjStm /Filter 5 0 R"],
      ["an unsupported object-stream filter", "/Type /ObjStm /Filter /LZWDecode"],
    ])("fails closed before parsing %s", async (_label, declaration) => {
      const payload = zlib.deflateSync(Buffer.from("5 0 (safe)", "ascii"));
      const bytes = buildPdf([
        [1, "<< /Type /Catalog /Pages 2 0 R >>"],
        [2, "<< /Type /Pages /Kids [3 0 R] /Count 1 >>"],
        [3, "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 100 100] /Resources <<>> >>"],
        [4, `<< ${declaration} /N 1 /First 4 /Length ${payload.length} >>`
          + `\nstream\n${payload.toString("latin1")}\nendstream`],
        [5, "/FlateDecode"],
      ], 1);
      await expect(assertBoundedPdfStreamDecodes(bytes)).rejects.toMatchObject({
        code: "PDF_RESOURCE_LIMIT_EXCEEDED",
        reason: "unsafe_object_stream_decode",
      });
    });
  });

  it.each([
    "sparse-high-object-numbers",
    "sparse-xref-range-overflow",
    "sparse-enormous-declared-size",
  ])("rejects %s before pdf-lib parsing", name => {
    const fixture = makeDeepMalformedFixtures({ scale: "quick" }).find(item => item.name === name);
    expect(() => assertBoundedPdfStructure(fixture.bytes)).toThrow(
      expect.objectContaining({
        code: "PDF_RESOURCE_LIMIT_EXCEEDED",
        reason: "sparse_pdf_structure",
      }),
    );
  });

  it("rejects a sparse object declaration in the middle of a large PDF", () => {
    const padding = Buffer.alloc(9 * 1024 * 1024, 0x20);
    const bytes = Buffer.concat([
      Buffer.from("%PDF-1.7\n", "ascii"),
      padding,
      Buffer.from("\n9999999 0 obj\n<<>>\nendobj\n", "ascii"),
      padding,
      Buffer.from("\n%%EOF\n", "ascii"),
    ]);
    expect(() => assertBoundedPdfStructure(bytes)).toThrow(
      expect.objectContaining({
        code: "PDF_RESOURCE_LIMIT_EXCEEDED",
        reason: "sparse_pdf_structure",
      }),
    );
  });

  it.each([
    ["object number", "9999999", "0 obj"],
    ["object reference", "9999999", "0 R "],
    ["trailer Size", "/Size", "9999999"],
    ["xref range", "xref", "9999999 1"],
    ["xref-stream Index", "/Index", "[9999999 1]"],
  ])("rejects a sparse %s split at the scan boundary by more than the old overlap", (
    _kind,
    prefix,
    suffix,
  ) => {
    expect(() => assertBoundedPdfStructure(
      sparseDeclarationAcrossBoundary(prefix, suffix),
    )).toThrow(expect.objectContaining({
      code: "PDF_RESOURCE_LIMIT_EXCEEDED",
      reason: "sparse_pdf_structure",
    }));
  });

  it("rejects a hostile later classic-xref subsection when the first subsection and Size are safe", () => {
    const bytes = Buffer.from(`%PDF-1.7
xref
0 1
0000000000 65535 f
9999999 1
0000000009 00000 n
trailer
<< /Size 2 >>
startxref
0
%%EOF
`, "ascii");
    expect(() => assertBoundedPdfStructure(bytes)).toThrow(expect.objectContaining({
      code: "PDF_RESOURCE_LIMIT_EXCEEDED",
      reason: "sparse_pdf_structure",
    }));
  });

  it("accepts multiple bounded classic-xref subsections", () => {
    const bytes = Buffer.from(`%PDF-1.7
xref
0 1
0000000000 65535 f
2 1
0000000009 00000 n
trailer
<< /Size 3 >>
startxref
0
%%EOF
`, "ascii");
    expect(() => assertBoundedPdfStructure(bytes)).not.toThrow();
  });

  it("retains classic-xref subsection state across a chunk split, long whitespace, and a comment", () => {
    const prefix = Buffer.from(`%PDF-1.7
xref
0 1
0000000000 65535 f
`, "ascii");
    const bytes = Buffer.concat([
      prefix,
      Buffer.alloc(STRUCTURE_BOUNDARY_BYTES - prefix.length - 1, 0x20),
      Buffer.from(`%${"c".repeat(8193)}
`, "ascii"),
      Buffer.from("9999999", "ascii"),
      Buffer.alloc(8193, 0x20),
      Buffer.from(`1
0000000009 00000 n
trailer
<< /Size 2 >>
startxref
0
%%EOF
`, "ascii"),
    ]);
    expect(() => assertBoundedPdfStructure(bytes)).toThrow(expect.objectContaining({
      code: "PDF_RESOURCE_LIMIT_EXCEEDED",
      reason: "sparse_pdf_structure",
    }));
  });

  it("does not interpret sparse structural spellings inside comments or string objects", () => {
    const bytes = Buffer.from(`%PDF-1.7
% 9999999 0 obj 9999999 0 R /Size 9999999 xref 9999999 1 /Index [9999999 1]
(outer (9999999 0 obj) \\) /Size 9999999 xref 9999999 1 /Index [9999999 1])
<2f53697a652039393939393939>
1 0 obj
<< /Size 2 >>
endobj
%%EOF
`, "ascii");
    expect(() => assertBoundedPdfStructure(bytes)).not.toThrow();
  });

  // Hopding/pdf-lib#1776 (CWE-190): PDFXRefStreamParser copies /W straight
  // into its per-entry read loops. The upstream fix (PR #1781) is unmerged and
  // the issue was closed by a stale bot, so the bound is ours to enforce.
  // Measured against the pinned pdf-lib 1.17.1: on a ~1 KiB file, /W [1 2e8 1]
  // holds PDFDocument.load for 3.9s, /W [1 1e9 1] for 198s, and /W [1 2e9 1]
  // for over 400s, with resident memory flat near 160 MiB throughout. A
  // flat-memory spin is invisible to the RSS monitor, so before this bound the
  // only thing between a hostile document and a wedged worker was the 30s
  // subprocess deadline.
  describe("cross-reference stream byte widths", () => {
    it.each([
      ["a width beyond the Table 17 field size", "/W [100 100 100]"],
      ["a width that overflows the accumulator", "/W [1 2000000000 1]"],
      ["a width beyond safe integer precision", "/W [1 9007199254740991 1]"],
      ["a hostile width spelled as a PDF real", "/W [1 2000000000.0 1]"],
      ["a width longer than one structure token", `/W [1 ${"9".repeat(300)} 1]`],
      ["a negative width", "/W [-1 -1 -1]"],
      ["a width one byte past the field bound", "/W [1 9 2]"],
    ])("rejects %s before pdf-lib parsing", async (_kind, hostileWidths) => {
      const bytes = await xrefStreamPdfWithByteWidths(hostileWidths);
      expect(() => assertBoundedPdfStructure(bytes)).toThrow(expect.objectContaining({
        code: "PDF_RESOURCE_LIMIT_EXCEEDED",
        reason: "unsafe_xref_byte_width",
      }));
      await expect(loadPdfForMutation(bytes)).rejects.toThrow(expect.objectContaining({
        reason: "unsafe_xref_byte_width",
      }));
    });

    it("checks the widths when /Type /XRef is written after /W", () => {
      const bytes = Buffer.from(`%PDF-1.7
2 0 obj
<< /W [ 1 2000000000 1 ] /Size 3 /Index [0 3] /Type /XRef /Length 0 >>
stream
endstream
endobj
%%EOF
`, "ascii");
      expect(() => assertBoundedPdfStructure(bytes)).toThrow(expect.objectContaining({
        reason: "unsafe_xref_byte_width",
      }));
    });

    it("accepts the real cross-reference stream widths this repository ships", async () => {
      const fw9 = await fs.readFile(path.join(REPO_ROOT, "example-fw9.pdf"));
      expect(fw9.toString("latin1")).toMatch(/\/Type\s*\/XRef/);
      expect(fw9.toString("latin1")).toMatch(/\/W\s*\[\s*1 3 2\s*\]/);
      expect(() => assertBoundedPdfStructure(fw9)).not.toThrow();
      await expect(loadPdfForMutation(fw9)).resolves.toBeDefined();

      const written = await xrefStreamPdfWithByteWidths(null);
      expect(() => assertBoundedPdfStructure(written)).not.toThrow();
    });

    it.each([
      ["the widest conforming entry", "/W [8 8 8]"],
      ["a non-canonical real spelling", "/W [1.0 4.0 2.0]"],
      ["a short width array", "/W [1 2]"],
    ])("accepts %s", async (_kind, widths) => {
      const bytes = await xrefStreamPdfWithByteWidths(widths);
      expect(() => assertBoundedPdfStructure(bytes)).not.toThrow();
    });

    // The shared structure lexer treats an unpaired "<" or "(" as the start of
    // a hex or literal string and skips to the next ">" or ")". Compressed
    // payload bytes contain those characters routinely, which silently
    // swallowed the following cross-reference dictionary until the byte-width
    // pass was given its own stream-skipping view of the file.
    it.each([
      ["an unpaired hex-string opener", "<"],
      ["an unpaired literal-string opener", "("],
      ["a comment opener", "%"],
    ])("still sees the widths behind a payload containing %s", (_kind, opener) => {
      const payload = Buffer.from(`${opener}${"·".repeat(40)}`, "latin1");
      const bytes = Buffer.concat([
        Buffer.from(`%PDF-1.7\n1 0 obj\n<< /Length ${payload.length} >>\nstream\n`, "ascii"),
        payload,
        Buffer.from(`\nendstream\nendobj\n2 0 obj
<< /Type /XRef /W [ 1 2000000000 1 ] /Size 3 /Index [0 3] /Length 0 >>
stream
endstream
endobj
%%EOF
`, "ascii"),
      ]);
      expect(() => assertBoundedPdfStructure(bytes)).toThrow(expect.objectContaining({
        reason: "unsafe_xref_byte_width",
      }));
    });

    it("is not desynchronized by a dictionary-closing spelling inside a string value", () => {
      const bytes = Buffer.from(`%PDF-1.7
2 0 obj
<< /Type /XRef /Note (>> << >>) /W [ 1 2000000000 1 ] /Size 3 /Index [0 3] /Length 0 >>
stream
endstream
endobj
%%EOF
`, "ascii");
      expect(() => assertBoundedPdfStructure(bytes)).toThrow(expect.objectContaining({
        reason: "unsafe_xref_byte_width",
      }));
    });

    it("does not mistake a CIDFont glyph-width array for cross-reference byte widths", () => {
      const bytes = Buffer.from(`%PDF-1.7
1 0 obj
<< /Type /Font /Subtype /CIDFontType2 /W [ 120 [ 400 325 500 ] 200 300 722 ] >>
endobj
2 0 obj
<< /Type /XRef /W [ 1 2 1 ] /Size 3 /Index [0 3] /Length 0 >>
stream
endstream
endobj
%%EOF
`, "ascii");
      expect(() => assertBoundedPdfStructure(bytes)).not.toThrow();
    });
  });

  it("inspects parsed stream dictionaries, not comments, strings, or raw payload spellings", async () => {
    const filters = Array.from({ length: 12 }, () => "/FlateDecode").join(" ");
    const bytes = parsedStreamPdf(null, {
      payload: `q\n% /Filter [${filters}]\n(${filters})\nQ`,
      extraObjects: [[5, `(${filters})`]],
    });
    const document = await PDFDocument.load(bytes);
    expect(() => assertSafeParsedPdfDecodeChains(document)).not.toThrow();
  });

  it("allows a common parsed decoder chain and resolves an indirect Filter name", async () => {
    const direct = await PDFDocument.load(
      parsedStreamPdf("[/ASCII85Decode /FlateDecode]"),
    );
    expect(() => assertSafeParsedPdfDecodeChains(direct)).not.toThrow();

    const expandingBoundary = await PDFDocument.load(
      parsedStreamPdf("[/FlateDecode /LZWDecode]"),
    );
    expect(() => assertSafeParsedPdfDecodeChains(expandingBoundary)).not.toThrow();

    const indirect = await PDFDocument.load(parsedStreamPdf("5 0 R", {
      extraObjects: [[5, "/FlateDecode"]],
    }));
    expect(() => assertSafeParsedPdfDecodeChains(indirect)).not.toThrow();
  });

  it("rejects excess expanding stages, long indirect chains, and malformed parsed Filter values", async () => {
    const aliases = await PDFDocument.load(
      parsedStreamPdf("[/Fl /FlateDecode /F#6CateDecode]"),
    );
    expect(() => assertSafeParsedPdfDecodeChains(aliases)).toThrow(
      expect.objectContaining({
        code: "PDF_RESOURCE_LIMIT_EXCEEDED",
        reason: "unsafe_decode_chain",
      }),
    );

    const distinct = await PDFDocument.load(
      parsedStreamPdf("[/FlateDecode /DCTDecode /LZWDecode]"),
    );
    expect(() => assertSafeParsedPdfDecodeChains(distinct)).toThrow(
      expect.objectContaining({ reason: "unsafe_decode_chain" }),
    );

    const filters = Array.from({ length: 12 }, () => "/FlateDecode").join(" ");
    const indirect = await PDFDocument.load(parsedStreamPdf("5 0 R", {
      extraObjects: [[5, `[${filters}]`]],
    }));
    expect(() => assertSafeParsedPdfDecodeChains(indirect)).toThrow(
      expect.objectContaining({ reason: "unsafe_decode_chain" }),
    );

    const malformed = await PDFDocument.load(parsedStreamPdf("5"));
    expect(() => assertSafeParsedPdfDecodeChains(malformed)).toThrow(
      expect.objectContaining({ reason: "unsafe_decode_chain" }),
    );
  });

  it("rejects excessive direct object depth while preserving a realistic bounded depth", async () => {
    const safe = await PDFDocument.load(buildPdf([
      [1, "<< /Type /Catalog /Pages 2 0 R >>"],
      [2, "<< /Type /Pages /Kids [3 0 R] /Count 1 >>"],
      [3, "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 100 100] /Resources <<>> >>"],
      [4, `${"[".repeat(128)}0${"]".repeat(128)}`],
    ], 1));
    expect(() => assertSafeParsedPdfComplexity(safe)).not.toThrow();

    const hostile = makeDeepMalformedFixtures({ scale: "quick" })
      .find(item => item.name === "deep-nested-arrays");
    const hostileDocument = await PDFDocument.load(hostile.bytes);
    expect(() => assertSafeParsedPdfComplexity(hostileDocument)).toThrow(
      expect.objectContaining({
        code: "PDF_RESOURCE_LIMIT_EXCEEDED",
        reason: "unsafe_pdf_complexity",
      }),
    );
  });

  it.each([
    "deep-nested-arrays",
    "deep-nested-dictionaries",
  ])("prunes full-scale unreachable %s recovered as an opaque invalid object", async name => {
    const hostile = makeDeepMalformedFixtures({
      scale: "full",
      only: name,
    })[0];
    const hostileDocument = await PDFDocument.load(hostile.bytes);
    expect(
      hostileDocument.context.enumerateIndirectObjects()
        .some(([, object]) => object instanceof PDFInvalidObject),
    ).toBe(true);
    expect(enforceSafeParsedPdfGraph(hostileDocument)).toMatchObject({
      removed_tainted_orphan_objects: 1,
    });
    expect(
      hostileDocument.context.enumerateIndirectObjects()
        .some(([, object]) => object instanceof PDFInvalidObject),
    ).toBe(false);
  });

  it("prunes an unreachable opaque invalid object instead of serializing it", async () => {
    const document = await PDFDocument.create();
    document.addPage([100, 100]);
    document.context.assign(
      document.context.nextRef(),
      PDFInvalidObject.of(new Uint8Array(16 * 1024)),
    );
    expect(enforceSafeParsedPdfGraph(document)).toMatchObject({
      removed_tainted_orphan_objects: 1,
    });
    const bytes = await savePdfDocumentSafely(document, {
      expectedPageCount: 1,
      expectedPageRotations: [0],
    });
    const verified = await PDFDocument.load(bytes, { updateMetadata: false });
    expect(
      verified.context.enumerateIndirectObjects()
        .some(([, object]) => object instanceof PDFInvalidObject),
    ).toBe(false);
  });

  it.each([
    "catalog",
    "page-resources",
    "acroform",
    "info",
    "stream-dictionary",
    "multi-hop",
  ])("rejects an opaque invalid object reachable through %s", async location => {
    const document = await PDFDocument.create();
    const page = document.addPage([100, 100]);
    const invalidRef = document.context.nextRef();
    document.context.assign(
      invalidRef,
      PDFInvalidObject.of(new Uint8Array([0x5b, 0x5d])),
    );
    if (location === "catalog") {
      document.catalog.set(PDFName.of("PrivateBad"), invalidRef);
    } else if (location === "page-resources") {
      page.node.set(
        PDFName.of("Resources"),
        document.context.obj({ PrivateBad: invalidRef }),
      );
    } else if (location === "acroform") {
      document.catalog.set(
        PDFName.of("AcroForm"),
        document.context.obj({ PrivateBad: invalidRef }),
      );
    } else if (location === "info") {
      document.context.trailerInfo.Info = invalidRef;
    } else if (location === "stream-dictionary") {
      const stream = document.context.flateStream(Buffer.from("safe"));
      stream.dict.set(PDFName.of("PrivateBad"), invalidRef);
      document.catalog.set(
        PDFName.of("PrivateStream"),
        document.context.register(stream),
      );
    } else {
      const middle = document.context.obj({
        Next: document.context.obj([invalidRef]),
      });
      document.catalog.set(
        PDFName.of("PrivateMiddle"),
        document.context.register(middle),
      );
    }
    expect(() => enforceSafeParsedPdfGraph(document)).toThrow(
      expect.objectContaining({
        code: "PDF_RESOURCE_LIMIT_EXCEEDED",
        reason: "unsafe_pdf_integrity",
      }),
    );
  });

  it("removes the complete tainted orphan predecessor closure", async () => {
    const document = await PDFDocument.create();
    document.addPage([100, 100]);
    const invalidRef = document.context.nextRef();
    document.context.assign(
      invalidRef,
      PDFInvalidObject.of(new Uint8Array([0x5b, 0x5d])),
    );
    const predecessorRef = document.context.register(
      document.context.obj({ PrivateBad: invalidRef }),
    );
    const result = enforceSafeParsedPdfGraph(document);
    expect(result.removed_tainted_orphan_objects).toBe(2);
    const retained = new Set(
      document.context.enumerateIndirectObjects()
        .map(([ref]) => ref.toString()),
    );
    expect(retained.has(invalidRef.toString())).toBe(false);
    expect(retained.has(predecessorRef.toString())).toBe(false);
  });

  it("retains an orphan reference to an undefined object as standards-defined null", async () => {
    const document = await PDFDocument.create();
    document.addPage([100, 100]);
    const missing = document.context.nextRef();
    const predecessorRef = document.context.register(
      document.context.obj({ PrivateMissing: missing }),
    );
    const result = enforceSafeParsedPdfGraph(document);
    expect(result).toMatchObject({
      removed_tainted_orphan_objects: 0,
      spec_null_reference_edges: 1,
      spec_null_reachable_edges: 0,
      spec_null_orphan_edges: 1,
      spec_null_trailer_edges: 0,
      spec_null_reference_slot_encoding: "typed-json-sequence.v1",
      spec_null_reference_samples_truncated: false,
      spec_null_reference_sample: [{
        owner: predecessorRef.toString(),
        slot: typedSlot(["dict_key", "PrivateMissing"]),
        target: missing.toString(),
        reachability: "orphan",
        container_kind: "dict",
      }],
    });
    expect(
      document.context.enumerateIndirectObjects()
        .some(([ref]) => ref.toString() === predecessorRef.toString()),
    ).toBe(true);
  });

  it("accepts a reachable reference to an undefined object as standards-defined null", async () => {
    const document = await PDFDocument.create();
    document.addPage([100, 100]);
    const missing = document.context.nextRef();
    document.catalog.set(PDFName.of("PrivateMissing"), missing);
    expect(enforceSafeParsedPdfGraph(document, {
      pruneUnreachableInvalid: false,
    })).toMatchObject({
      removed_tainted_orphan_objects: 0,
      spec_null_reference_edges: 1,
      spec_null_reachable_edges: 1,
      spec_null_orphan_edges: 0,
      spec_null_trailer_edges: 0,
      spec_null_reference_slot_encoding: "typed-json-sequence.v1",
      spec_null_reference_samples_truncated: false,
      spec_null_reference_sample: [{
        owner: document.context.trailerInfo.Root.toString(),
        slot: typedSlot(["dict_key", "PrivateMissing"]),
        target: missing.toString(),
        reachability: "reachable",
        container_kind: "dict",
      }],
    });
  });

  it("audits trailer, array, repeated, and generation-mismatched null references", async () => {
    const document = await PDFDocument.create();
    document.addPage([100, 100]);
    const missing = document.context.nextRef();
    const generationMismatch = PDFRef.of(
      document.context.trailerInfo.Root.objectNumber,
      document.context.trailerInfo.Root.generationNumber + 1,
    );
    document.context.trailerInfo.Info = missing;
    document.catalog.set(
      PDFName.of("PrivateArray"),
      document.context.obj([missing, missing, generationMismatch]),
    );
    const result = enforceSafeParsedPdfGraph(document);
    expect(result).toMatchObject({
      removed_tainted_orphan_objects: 0,
      spec_null_reference_edges: 4,
      spec_null_reachable_edges: 3,
      spec_null_orphan_edges: 0,
      spec_null_trailer_edges: 1,
      spec_null_reference_slot_encoding: "typed-json-sequence.v1",
      spec_null_reference_samples_truncated: false,
    });
    expect(result.spec_null_reference_sample).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          owner: "trailer",
          slot: typedSlot(["trailer_field", "Info"]),
          target: missing.toString(),
          reachability: "trailer",
          container_kind: "trailer",
        }),
        expect.objectContaining({
          slot: typedSlot(
            ["dict_key", "PrivateArray"],
            ["array_index", 0],
          ),
          target: missing.toString(),
          reachability: "reachable",
          container_kind: "array",
        }),
        expect.objectContaining({
          slot: typedSlot(
            ["dict_key", "PrivateArray"],
            ["array_index", 1],
          ),
          target: missing.toString(),
          reachability: "reachable",
          container_kind: "array",
        }),
        expect.objectContaining({
          slot: typedSlot(
            ["dict_key", "PrivateArray"],
            ["array_index", 2],
          ),
          target: generationMismatch.toString(),
          reachability: "reachable",
          container_kind: "array",
        }),
      ]),
    );
  });

  it("still removes an orphan predecessor that also points to an opaque invalid object", async () => {
    const document = await PDFDocument.create();
    document.addPage([100, 100]);
    const missing = document.context.nextRef();
    const invalidRef = document.context.nextRef();
    document.context.assign(
      invalidRef,
      PDFInvalidObject.of(new Uint8Array([0x5b, 0x5d])),
    );
    const predecessorRef = document.context.register(
      document.context.obj({
        PrivateMissing: missing,
        PrivateBad: invalidRef,
      }),
    );
    const result = enforceSafeParsedPdfGraph(document);
    expect(result).toMatchObject({
      removed_tainted_orphan_objects: 2,
      spec_null_reference_edges: 0,
    });
    const retained = new Set(
      document.context.enumerateIndirectObjects()
        .map(([ref]) => ref.toString()),
    );
    expect(retained.has(invalidRef.toString())).toBe(false);
    expect(retained.has(predecessorRef.toString())).toBe(false);
  });

  it("preserves a loaded source null-reference inventory and rejects mutation of it", async () => {
    const source = buildPdf([
      [1, "<< /Type /Catalog /Pages 2 0 R /PrivateMissing 9 0 R >>"],
      [2, "<< /Type /Pages /Kids [3 0 R] /Count 1 >>"],
      [3, "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 100 100] /Resources <<>> >>"],
    ], 1);
    const unchanged = await loadPdfForMutation(source);
    const unchangedBytes = await savePdfDocumentSafely(unchanged, {
      expectedPageCount: 1,
      expectedPageRotations: [0],
    });
    const verified = await PDFDocument.load(unchangedBytes, {
      updateMetadata: false,
    });
    expect(enforceSafeParsedPdfGraph(verified)).toMatchObject({
      spec_null_reference_edges: 1,
    });

    const altered = await loadPdfForMutation(source);
    altered.catalog.set(PDFName.of("PrivateMissing"), PDFRef.of(10, 0));
    await expect(savePdfDocumentSafely(altered, {
      expectedPageCount: 1,
      expectedPageRotations: [0],
    })).rejects.toMatchObject({
      code: "PDF_RESOURCE_LIMIT_EXCEEDED",
      reason: "unsafe_pdf_integrity",
    });
  });

  it("rejects a null reference in a rebuilt output without mapped source provenance", async () => {
    const target = await PDFDocument.create();
    target.addPage([100, 100]);
    target.catalog.set(
      PDFName.of("PrivateMissing"),
      target.context.nextRef(),
    );
    await expect(savePdfDocumentSafely(target, {
      expectedPageCount: 1,
      expectedPageRotations: [0],
    })).rejects.toMatchObject({
      code: "PDF_RESOURCE_LIMIT_EXCEEDED",
      reason: "unsafe_pdf_integrity",
    });
  });

  it("uses injective typed slots and rejects equal-count relocation", async () => {
    const source = buildPdf([
      [1, "<< /Type /Catalog /Pages 2 0 R /A#2FB 9 0 R >>"],
      [2, "<< /Type /Pages /Kids [3 0 R] /Count 1 >>"],
      [3, "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 100 100] /Resources <<>> >>"],
    ], 1);
    const document = await loadPdfForMutation(source);
    const directPolicy = enforceSafeParsedPdfGraph(document);
    document.catalog.delete(PDFName.of("A/B"));
    document.catalog.set(
      PDFName.of("A"),
      document.context.obj({ B: PDFRef.of(9, 0) }),
    );
    const nestedPolicy = enforceSafeParsedPdfGraph(document);
    expect(directPolicy.spec_null_reference_edges).toBe(1);
    expect(nestedPolicy.spec_null_reference_edges).toBe(1);
    expect(directPolicy.spec_null_reference_inventory_sha256)
      .not.toBe(nestedPolicy.spec_null_reference_inventory_sha256);
    await expect(savePdfDocumentSafely(document, {
      expectedPageCount: 1,
      expectedPageRotations: [0],
    })).rejects.toMatchObject({
      code: "PDF_RESOURCE_LIMIT_EXCEEDED",
      reason: "unsafe_pdf_integrity",
    });
  });

  it("counts each serialized occurrence of a shared direct container", async () => {
    const document = await PDFDocument.create();
    document.addPage([100, 100]);
    const missing = document.context.nextRef();
    const shared = document.context.obj([missing]);
    document.catalog.set(PDFName.of("A"), shared);
    document.catalog.set(PDFName.of("B"), shared);
    const policy = enforceSafeParsedPdfGraph(document);
    expect(policy.spec_null_reference_edges).toBe(2);
    expect(policy.spec_null_reference_sample).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          slot: typedSlot(["dict_key", "A"], ["array_index", 0]),
        }),
        expect.objectContaining({
          slot: typedSlot(["dict_key", "B"], ["array_index", 0]),
        }),
      ]),
    );
  });

  it("canonicalizes dictionary insertion order without losing duplicate occurrences", async () => {
    const document = await PDFDocument.create();
    document.addPage([100, 100]);
    const missing = document.context.nextRef();
    document.catalog.set(PDFName.of("Z"), missing);
    document.catalog.set(PDFName.of("A"), missing);
    const first = enforceSafeParsedPdfGraph(document);
    document.catalog.delete(PDFName.of("Z"));
    document.catalog.delete(PDFName.of("A"));
    document.catalog.set(PDFName.of("A"), missing);
    document.catalog.set(PDFName.of("Z"), missing);
    const second = enforceSafeParsedPdfGraph(document);
    expect(first.spec_null_reference_edges).toBe(2);
    expect(second.spec_null_reference_edges).toBe(2);
    expect(second.spec_null_reference_inventory_sha256)
      .toBe(first.spec_null_reference_inventory_sha256);
  });

  it("preserves loaded authority across a dictionary-order-only mutation", async () => {
    const source = buildPdf([
      [1, "<< /Type /Catalog /Pages 2 0 R /Z 9 0 R /A 10 0 R >>"],
      [2, "<< /Type /Pages /Kids [3 0 R] /Count 1 >>"],
      [3, "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 100 100] /Resources <<>> >>"],
    ], 1);
    const document = await loadPdfForMutation(source);
    const a = document.catalog.get(PDFName.of("A"));
    const z = document.catalog.get(PDFName.of("Z"));
    document.catalog.delete(PDFName.of("A"));
    document.catalog.delete(PDFName.of("Z"));
    document.catalog.set(PDFName.of("Z"), z);
    document.catalog.set(PDFName.of("A"), a);
    await expect(savePdfDocumentSafely(document, {
      expectedPageCount: 1,
      expectedPageRotations: [0],
    })).resolves.toBeInstanceOf(Uint8Array);
  });

  it("classifies a missing reference directly in a stream dictionary", async () => {
    const document = await PDFDocument.create();
    document.addPage([100, 100]);
    const missing = document.context.nextRef();
    const stream = document.context.flateStream(Buffer.from("safe"));
    stream.dict.set(PDFName.of("PrivateMissing"), missing);
    const streamRef = document.context.register(stream);
    document.catalog.set(PDFName.of("PrivateStream"), streamRef);
    const policy = enforceSafeParsedPdfGraph(document);
    expect(policy.spec_null_reference_sample).toContainEqual(
      expect.objectContaining({
        owner: streamRef.toString(),
        slot: typedSlot(
          ["stream_dict", null],
          ["dict_key", "PrivateMissing"],
        ),
        target: missing.toString(),
        container_kind: "stream_dict",
      }),
    );
  });

  it("bounds samples at 32 while hashing every repeated null-reference edge deterministically", async () => {
    const document = await PDFDocument.create();
    document.addPage([100, 100]);
    const missing = document.context.nextRef();
    document.catalog.set(
      PDFName.of("PrivateMany"),
      document.context.obj(Array.from({ length: 40 }, () => missing)),
    );
    const first = enforceSafeParsedPdfGraph(document);
    const second = enforceSafeParsedPdfGraph(document);
    expect(first.spec_null_reference_edges).toBe(40);
    expect(first.spec_null_reference_sample).toHaveLength(32);
    expect(first.spec_null_reference_samples_truncated).toBe(true);
    expect(second.spec_null_reference_inventory_sha256)
      .toBe(first.spec_null_reference_inventory_sha256);
  });

  it("accepts spec-null but rejects an orphan opaque invalid object when pruning is disabled", async () => {
    const document = await PDFDocument.create();
    document.addPage([100, 100]);
    document.catalog.set(PDFName.of("PrivateMissing"), document.context.nextRef());
    document.context.assign(
      document.context.nextRef(),
      PDFInvalidObject.of(new Uint8Array([0x5b, 0x5d])),
    );
    expect(() => enforceSafeParsedPdfGraph(document, {
      pruneUnreachableInvalid: false,
    })).toThrow(
      expect.objectContaining({
        code: "PDF_RESOURCE_LIMIT_EXCEEDED",
        reason: "unsafe_pdf_integrity",
      }),
    );
  });

  it("keeps an undefined array reference in position across save and reparse", async () => {
    const source = buildPdf([
      [1, "<< /Type /Catalog /Pages 2 0 R /PrivateArray [9 0 R /Marker] >>"],
      [2, "<< /Type /Pages /Kids [3 0 R] /Count 1 >>"],
      [3, "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 100 100] /Resources <<>> >>"],
    ], 1);
    const document = await loadPdfForMutation(source);
    const bytes = await savePdfDocumentSafely(document, {
      expectedPageCount: 1,
      expectedPageRotations: [0],
    });
    const verified = await PDFDocument.load(bytes, { updateMetadata: false });
    const array = verified.catalog.lookup(PDFName.of("PrivateArray"), PDFArray);
    expect(array.size()).toBe(2);
    expect(array.get(0)).toEqual(PDFRef.of(9, 0));
    expect(verified.context.lookup(array.get(0))).toBeUndefined();
    expect(array.get(1).decodeText()).toBe("Marker");
  });

  it("accepts omitted, explicit-null, and undefined optional catalog entries", async () => {
    const omitted = await PDFDocument.create();
    omitted.addPage([100, 100]);
    const explicitNull = await PDFDocument.create();
    explicitNull.addPage([100, 100]);
    explicitNull.catalog.set(
      PDFName.of("PrivateOptional"),
      explicitNull.context.obj(null),
    );
    const undefinedRef = await PDFDocument.create();
    undefinedRef.addPage([100, 100]);
    const missing = undefinedRef.context.nextRef();
    undefinedRef.catalog.set(PDFName.of("PrivateOptional"), missing);

    expect(enforceSafeParsedPdfGraph(omitted)).toMatchObject({
      spec_null_reference_edges: 0,
    });
    expect(enforceSafeParsedPdfGraph(explicitNull)).toMatchObject({
      spec_null_reference_edges: 0,
    });
    expect(enforceSafeParsedPdfGraph(undefinedRef)).toMatchObject({
      spec_null_reference_edges: 1,
    });
    expect(undefinedRef.context.lookup(missing)).toBeUndefined();
  });

  it("keeps Root and page-tree references strict despite generic null semantics", async () => {
    const document = await PDFDocument.create();
    document.addPage([100, 100]);
    document.context.trailerInfo.Root = document.context.nextRef();
    expect(() => enforceSafeParsedPdfGraph(document)).toThrow(
      expect.objectContaining({
        code: "PDF_RESOURCE_LIMIT_EXCEEDED",
        reason: "unsafe_pdf_integrity",
      }),
    );

    const danglingPage = buildPdf([
      [1, "<< /Type /Catalog /Pages 2 0 R >>"],
      [2, "<< /Type /Pages /Kids [9 0 R] /Count 1 >>"],
    ], 1);
    const { request, stageDirectory } = await requestFor(danglingPage);
    await expect(executePdfLibMutationRequest(request)).rejects.toThrow(
      /malformed|incomplete|unsupported/i,
    );
    expect(await fs.readdir(stageDirectory)).toEqual([]);
  });

  it("fails a signature-placement operation with no output when its required page is absent", async () => {
    const document = await PDFDocument.create();
    document.addPage([100, 100]);
    const { request, stageDirectory } = await requestFor(
      await document.save({ useObjectStreams: false }),
    );
    request.operation = "add_signature_field";
    request.options = {
      allow_resign: false,
      placement: {
        page: 2,
        x: 10,
        y: 10,
        width: 40,
        height: 20,
        label: "Sign here",
      },
    };
    await expect(executePdfLibMutationRequest(request)).rejects.toThrow(
      /out of range/i,
    );
    expect(await fs.readdir(stageDirectory)).toEqual([]);
  });

  it("materializes deferred font resources before graph provenance verification", async () => {
    const document = await PDFDocument.create();
    document.addPage([400, 500]);
    const { request, stageDirectory } = await requestFor(
      await document.save(),
    );
    request.operation = "add_signature_field";
    request.options = {
      allow_resign: false,
      placement: {
        page: 1,
        x: 72,
        y: 72,
        width: 160,
        height: 40,
        label: "Sign here",
      },
    };
    const response = await executePdfLibMutationRequest(request);
    expect(response.status).toBe("ok");
    expect(response.manifest).toHaveLength(1);
    const output = await PDFDocument.load(
      await fs.readFile(path.join(stageDirectory, response.manifest[0].filename)),
      { updateMetadata: false },
    );
    expect(enforceSafeParsedPdfGraph(output, {
      pruneUnreachableInvalid: false,
    })).toMatchObject({
      spec_null_reference_edges: 0,
    });
  });

  it.each([
    ["merge_pdfs", {}],
    ["split_pdf", { page_ranges: "1-1" }],
    ["reorder_pdf_pages", { page_order: [1], rotations: {} }],
    ["apply_page_plan", { page_order: [1], rotations: {} }],
  ])("emits no unproven null references from the %s rebuild path", async (
    operation,
    options,
  ) => {
    const source = buildPdf([
      [1, "<< /Type /Catalog /Pages 2 0 R /PrivateMissing 9 0 R >>"],
      [2, "<< /Type /Pages /Kids [3 0 R] /Count 1 >>"],
      [3, "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 100 100] /Resources <<>> >>"],
    ], 1);
    const { request, stageDirectory } = await requestFor(source);
    request.operation = operation;
    request.options = options;
    const response = await executePdfLibMutationRequest(request);
    expect(response.status).toBe("ok");
    expect(response.manifest).toHaveLength(1);
    const output = await PDFDocument.load(
      await fs.readFile(path.join(stageDirectory, response.manifest[0].filename)),
      { updateMetadata: false },
    );
    expect(enforceSafeParsedPdfGraph(output, {
      pruneUnreachableInvalid: false,
    })).toMatchObject({
      spec_null_reference_edges: 0,
    });
  });

  it.each([
    ["merge_pdfs", {}],
    ["split_pdf", { page_ranges: "1-1" }],
    ["reorder_pdf_pages", { page_order: [1], rotations: {} }],
    ["apply_page_plan", { page_order: [1], rotations: {} }],
  ])("maps selected-page null-target provenance through the %s rebuild path", async (
    operation,
    options,
  ) => {
    const source = buildPdf([
      [1, "<< /Type /Catalog /Pages 2 0 R >>"],
      [2, "<< /Type /Pages /Kids [3 0 R] /Count 1 >>"],
      [3, "<< /Type /Page /Parent 2 0 R /PrivateMissing 9 0 R "
        + "/MediaBox [0 0 100 100] /Resources <<>> >>"],
    ], 1);
    const { request, stageDirectory } = await requestFor(source);
    request.operation = operation;
    request.options = options;
    const response = await executePdfLibMutationRequest(request);
    expect(response.status).toBe("ok");
    expect(response.manifest).toHaveLength(1);
    const output = await PDFDocument.load(
      await fs.readFile(path.join(stageDirectory, response.manifest[0].filename)),
      { updateMetadata: false },
    );
    expect(enforceSafeParsedPdfGraph(output, {
      pruneUnreachableInvalid: false,
    })).toMatchObject({
      spec_null_reference_edges: 1,
      spec_null_reachable_edges: 1,
    });
  });

  it("maps same-number null targets independently across a multi-source merge", async () => {
    const source = buildPdf([
      [1, "<< /Type /Catalog /Pages 2 0 R >>"],
      [2, "<< /Type /Pages /Kids [3 0 R] /Count 1 >>"],
      [3, "<< /Type /Page /Parent 2 0 R /PrivateMissing 9 0 R "
        + "/MediaBox [0 0 100 100] /Resources <<>> >>"],
    ], 1);
    const first = await requestFor(source);
    const second = await requestFor(source);
    first.request.operation = "merge_pdfs";
    first.request.options = {};
    first.request.sources.push(second.request.sources[0]);
    const response = await executePdfLibMutationRequest(first.request);
    expect(response.status).toBe("ok");
    expect(response.manifest).toHaveLength(1);
    const output = await PDFDocument.load(
      await fs.readFile(path.join(
        first.stageDirectory,
        response.manifest[0].filename,
      )),
      { updateMetadata: false },
    );
    expect(output.getPageCount()).toBe(2);
    expect(enforceSafeParsedPdfGraph(output, {
      pruneUnreachableInvalid: false,
    })).toMatchObject({
      spec_null_reference_edges: 2,
      spec_null_reachable_edges: 2,
    });
  });

  it("maps a null target copied from the single-source Info dictionary", async () => {
    const source = buildPdf([
      [1, "<< /Type /Catalog /Pages 2 0 R >>"],
      [2, "<< /Type /Pages /Kids [3 0 R] /Count 1 >>"],
      [3, "<< /Type /Page /Parent 2 0 R "
        + "/MediaBox [0 0 100 100] /Resources <<>> >>"],
      [4, "<< /Title (Info provenance) /PrivateMissing 9 0 R >>"],
    ], 1, " /Info 4 0 R");
    const { request, stageDirectory } = await requestFor(source);
    request.operation = "merge_pdfs";
    request.options = {};
    const response = await executePdfLibMutationRequest(request);
    expect(response.status).toBe("ok");
    const output = await PDFDocument.load(
      await fs.readFile(path.join(stageDirectory, response.manifest[0].filename)),
      { updateMetadata: false },
    );
    expect(output.getTitle()).toBe("Info provenance");
    expect(enforceSafeParsedPdfGraph(output, {
      pruneUnreachableInvalid: false,
    })).toMatchObject({
      spec_null_reference_edges: 1,
      spec_null_reachable_edges: 1,
    });
  });

  it("maps a null target copied from an AcroForm default during field repair", async () => {
    const source = buildPdf([
      [1, "<< /Type /Catalog /Pages 2 0 R /AcroForm 5 0 R >>"],
      [2, "<< /Type /Pages /Kids [3 0 R] /Count 1 >>"],
      [3, "<< /Type /Page /Parent 2 0 R /Annots [4 0 R] "
        + "/MediaBox [0 0 100 100] /Resources <<>> >>"],
      [4, "<< /Type /Annot /Subtype /Widget /FT /Tx /T (Field1) "
        + "/Rect [10 10 80 30] /P 3 0 R >>"],
      [5, "<< /Fields [4 0 R] /Q 9 0 R >>"],
    ], 1);
    const { request, stageDirectory } = await requestFor(source);
    request.operation = "merge_pdfs";
    request.options = {};
    const response = await executePdfLibMutationRequest(request);
    expect(response.status).toBe("ok");
    expect(response.result.form_info.fields).toHaveLength(1);
    const output = await PDFDocument.load(
      await fs.readFile(path.join(stageDirectory, response.manifest[0].filename)),
      { updateMetadata: false },
    );
    expect(enforceSafeParsedPdfGraph(output, {
      pruneUnreachableInvalid: false,
    })).toMatchObject({
      spec_null_reference_edges: 1,
      spec_null_reachable_edges: 1,
    });
  });

  it.each([
    ["1", 1],
    ["2", 0],
  ])("maps only null targets from the selected split subset %s", async (
    pageRanges,
    expectedEdges,
  ) => {
    const source = buildPdf([
      [1, "<< /Type /Catalog /Pages 2 0 R >>"],
      [2, "<< /Type /Pages /Kids [3 0 R 4 0 R] /Count 2 >>"],
      [3, "<< /Type /Page /Parent 2 0 R /PrivateMissing 9 0 R "
        + "/MediaBox [0 0 100 100] /Resources <<>> >>"],
      [4, "<< /Type /Page /Parent 2 0 R "
        + "/MediaBox [0 0 100 100] /Resources <<>> >>"],
    ], 1);
    const { request, stageDirectory } = await requestFor(source);
    request.operation = "split_pdf";
    request.options = { page_ranges: pageRanges };
    const response = await executePdfLibMutationRequest(request);
    expect(response.status).toBe("ok");
    const output = await PDFDocument.load(
      await fs.readFile(path.join(stageDirectory, response.manifest[0].filename)),
      { updateMetadata: false },
    );
    expect(output.getPageCount()).toBe(1);
    expect(enforceSafeParsedPdfGraph(output, {
      pruneUnreachableInvalid: false,
    })).toMatchObject({
      spec_null_reference_edges: expectedEdges,
    });
  });

  it("rejects a second destination occurrence reusing a sanctioned null target", async () => {
    const sourceBytes = buildPdf([
      [1, "<< /Type /Catalog /Pages 2 0 R >>"],
      [2, "<< /Type /Pages /Kids [3 0 R] /Count 1 >>"],
      [3, "<< /Type /Page /Parent 2 0 R /PrivateMissing 9 0 R "
        + "/MediaBox [0 0 100 100] /Resources <<>> >>"],
    ], 1);
    const source = await loadPdfForMutation(sourceBytes);
    const target = await PDFDocument.create();
    const [copiedPage] = await __testOnlyCopyPdfPagesForRebuiltOutput(
      target,
      source,
      [0],
      {
        sourceAuthorityLabel: createHash("sha256").update(sourceBytes).digest("hex"),
      },
    );
    const copiedMissing = copiedPage.node.get(PDFName.of("PrivateMissing"));
    expect(copiedMissing).toBeInstanceOf(PDFRef);
    target.catalog.set(PDFName.of("PrivateReuse"), copiedMissing);
    await expect(savePdfDocumentSafely(target, {
      expectedPageCount: 1,
      expectedPageRotations: [0],
    })).rejects.toMatchObject({
      code: "PDF_RESOURCE_LIMIT_EXCEEDED",
      reason: "unsafe_pdf_integrity",
    });
  });

  it("rejects a sanctioned null target removed from every destination occurrence", async () => {
    const sourceBytes = buildPdf([
      [1, "<< /Type /Catalog /Pages 2 0 R >>"],
      [2, "<< /Type /Pages /Kids [3 0 R] /Count 1 >>"],
      [3, "<< /Type /Page /Parent 2 0 R /PrivateMissing 9 0 R "
        + "/MediaBox [0 0 100 100] /Resources <<>> >>"],
    ], 1);
    const source = await loadPdfForMutation(sourceBytes);
    const target = await PDFDocument.create();
    const [copiedPage] = await __testOnlyCopyPdfPagesForRebuiltOutput(
      target,
      source,
      [0],
      {
        sourceAuthorityLabel: createHash("sha256").update(sourceBytes).digest("hex"),
      },
    );
    copiedPage.node.delete(PDFName.of("PrivateMissing"));
    await expect(savePdfDocumentSafely(target, {
      expectedPageCount: 1,
      expectedPageRotations: [0],
    })).rejects.toMatchObject({
      code: "PDF_RESOURCE_LIMIT_EXCEEDED",
      reason: "unsafe_pdf_integrity",
    });
  });

  it("rejects equal-count relocation of a sanctioned null target", async () => {
    const sourceBytes = buildPdf([
      [1, "<< /Type /Catalog /Pages 2 0 R >>"],
      [2, "<< /Type /Pages /Kids [3 0 R] /Count 1 >>"],
      [3, "<< /Type /Page /Parent 2 0 R /PrivateMissing 9 0 R "
        + "/MediaBox [0 0 100 100] /Resources <<>> >>"],
    ], 1);
    const source = await loadPdfForMutation(sourceBytes);
    const target = await PDFDocument.create();
    const [copiedPage] = await __testOnlyCopyPdfPagesForRebuiltOutput(
      target,
      source,
      [0],
      {
        sourceAuthorityLabel: createHash("sha256").update(sourceBytes).digest("hex"),
      },
    );
    const copiedMissing = copiedPage.node.get(PDFName.of("PrivateMissing"));
    copiedPage.node.delete(PDFName.of("PrivateMissing"));
    target.catalog.set(PDFName.of("PrivateRelocated"), copiedMissing);
    await expect(savePdfDocumentSafely(target, {
      expectedPageCount: 1,
      expectedPageRotations: [0],
    })).rejects.toMatchObject({
      code: "PDF_RESOURCE_LIMIT_EXCEEDED",
      reason: "unsafe_pdf_integrity",
    });
  });

  it("rejects a rebuilt copier label that does not match its loaded source bytes", async () => {
    const sourceBytes = buildPdf([
      [1, "<< /Type /Catalog /Pages 2 0 R >>"],
      [2, "<< /Type /Pages /Kids [3 0 R] /Count 1 >>"],
      [3, "<< /Type /Page /Parent 2 0 R "
        + "/MediaBox [0 0 100 100] /Resources <<>> >>"],
    ], 1);
    const source = await loadPdfForMutation(sourceBytes);
    const target = await PDFDocument.create();
    await expect(__testOnlyCopyPdfPagesForRebuiltOutput(
      target,
      source,
      [0],
      { sourceAuthorityLabel: "a".repeat(64) },
    )).rejects.toMatchObject({
      code: "PDF_RESOURCE_LIMIT_EXCEEDED",
      reason: "unsafe_pdf_integrity",
    });
    expect(target.getPageCount()).toBe(0);
  });

  it("rejects caller-supplied provenance that was not captured by a sanctioned copier", async () => {
    const target = await PDFDocument.create();
    target.addPage([100, 100]);
    const missing = target.context.nextRef();
    target.catalog.set(PDFName.of("PrivateMissing"), missing);
    await expect(savePdfDocumentSafely(target, {
      rebuiltSpecNullTargetProvenance: new Map([[
        missing.toString(),
        {
          source_authority: "a".repeat(64),
          source_ref: "9 0 R",
        },
      ]]),
      expectedPageCount: 1,
      expectedPageRotations: [0],
    })).rejects.toThrow(/unknown authority/i);
  });

  it("bounds direct-container DAG amplification during occurrence-complete audit", {
    timeout: 30_000,
  }, async () => {
    const document = await PDFDocument.create();
    document.addPage([100, 100]);
    const missing = document.context.nextRef();
    let shared = document.context.obj([missing]);
    for (let depth = 0; depth < 20; depth += 1) {
      shared = document.context.obj([shared, shared]);
    }
    document.catalog.set(PDFName.of("PrivateDag"), shared);
    expect(() => enforceSafeParsedPdfGraph(document)).toThrow(
      expect.objectContaining({
        code: "PDF_RESOURCE_LIMIT_EXCEEDED",
        reason: "unsafe_pdf_integrity",
      }),
    );
  });

  it("fails closed on a direct-container cycle", async () => {
    const document = await PDFDocument.create();
    document.addPage([100, 100]);
    const cycle = document.context.obj({});
    cycle.set(PDFName.of("Self"), cycle);
    document.catalog.set(PDFName.of("PrivateCycle"), cycle);
    expect(() => enforceSafeParsedPdfGraph(document)).toThrow(
      expect.objectContaining({
        code: "PDF_RESOURCE_LIMIT_EXCEEDED",
        reason: "unsafe_pdf_integrity",
      }),
    );
  });

  it("bounds supported decoded stream expansion before mutation or save", async () => {
    const safe = await PDFDocument.load(flateContentPdf(4 * 1024 * 1024));
    expect(() => assertSafeParsedPdfComplexity(safe)).not.toThrow();

    const hostile = await PDFDocument.load(flateContentPdf(20 * 1024 * 1024));
    expect(() => assertSafeParsedPdfComplexity(hostile)).toThrow(
      expect.objectContaining({
        code: "PDF_RESOURCE_LIMIT_EXCEEDED",
        reason: "unsafe_stream_expansion",
      }),
    );
  });

  it("decodes standard abbreviations and indirect Filter names through canonical clones", async () => {
    const payload = zlib.deflateSync(Buffer.alloc(1024 * 1024, 0x41))
      .toString("latin1");
    const abbreviated = await PDFDocument.load(
      parsedStreamPdf("/Fl", { payload }),
    );
    expect(() => assertSafeParsedPdfComplexity(abbreviated)).not.toThrow();

    const indirect = await PDFDocument.load(
      parsedStreamPdf("5 0 R", {
        payload,
        extraObjects: [[5, "/Fl"]],
      }),
    );
    expect(() => assertSafeParsedPdfComplexity(indirect)).not.toThrow();
  });

  it("leaves mixed unsupported decoder chains to topology and worker controls", async () => {
    const payload = zlib.deflateSync(Buffer.alloc(1024 * 1024, 0x41))
      .toString("latin1");
    const document = await PDFDocument.load(
      parsedStreamPdf("[/FlateDecode /DCTDecode]", { payload }),
    );
    expect(() => assertSafeParsedPdfDecodeChains(document)).not.toThrow();
    expect(assertSafeParsedPdfComplexity(document)).toMatchObject({
      expansion_probe: "indeterminate",
      indeterminate_streams: 1,
    });
  });

  it("checks every supported stream without an ordering-dependent aggregate cap", async () => {
    const payload = zlib.deflateSync(Buffer.alloc(1024 * 1024, 0x41))
      .toString("latin1");
    const extraObjects = Array.from({ length: 129 }, (_, index) => [
      index + 10,
      `<< /Length ${Buffer.byteLength(payload, "latin1")} `
        + `/Filter /FlateDecode >>\nstream\n${payload}\nendstream`,
    ]);
    const document = await PDFDocument.load(
      parsedStreamPdf(null, { extraObjects }),
    );
    expect(assertSafeParsedPdfComplexity(document)).toMatchObject({
      expansion_probe: "within_bound",
      indeterminate_streams: 0,
      decoded_inspection_bytes: 129 * 1024 * 1024,
    });
  });

  it.each(["first", "last"])(
    "rejects an over-expanding supported stream when ordered %s",
    async position => {
      const safe = zlib.deflateSync(Buffer.alloc(1024 * 1024, 0x41))
        .toString("latin1");
      const bomb = zlib.deflateSync(Buffer.alloc(20 * 1024 * 1024, 0x42))
        .toString("latin1");
      const body = payload => (
        `<< /Length ${Buffer.byteLength(payload, "latin1")} `
        + `/Filter /FlateDecode >>\nstream\n${payload}\nendstream`
      );
      const payloads = [
        ...Array.from({ length: 128 }, () => safe),
        bomb,
      ];
      if (position === "first") {
        payloads.unshift(payloads.pop());
      }
      const document = await PDFDocument.load(
        parsedStreamPdf(null, {
          extraObjects: payloads.map((payload, index) => [
            index + 10,
            body(payload),
          ]),
        }),
      );
      expect(() => assertSafeParsedPdfComplexity(document)).toThrow(
        expect.objectContaining({
          code: "PDF_RESOURCE_LIMIT_EXCEEDED",
          reason: "unsafe_stream_expansion",
        }),
      );
    },
  );

  it("treats a bounded decoder exception as indeterminate", async () => {
    const document = await PDFDocument.load(
      parsedStreamPdf("/FlateDecode", { payload: "not-a-flate-stream" }),
    );
    expect(assertSafeParsedPdfComplexity(document)).toMatchObject({
      expansion_probe: "indeterminate",
      indeterminate_streams: 1,
    });
  });

  it("classifies only exact known malformed-input decoder failures as indeterminate", async () => {
    for (const message of [
      "Invalid header in flate stream: 120, -1",
      "Unknown compression method in flate stream: 229, 58",
      "Bad FCHECK in flate stream: 120, 193",
      "FDICT bit set in flate stream: 104, 98",
      "Bad block header in flate stream",
      "Bad uncompressed block length in flate stream",
      "Unknown block type in flate stream",
      "Bad encoding in flate stream",
    ]) {
      expect(isExpectedMalformedStreamDecodeError(new Error(message))).toBe(true);
    }
    class DecoderSubclassError extends Error {}
    for (const error of [
      new TypeError("Bad encoding in flate stream"),
      new DecoderSubclassError("Bad encoding in flate stream"),
      new Error("Bad encoding in flate stream\n"),
      new Error("prefix Bad encoding in flate stream"),
      new Error("Bad encoding in flate stream suffix"),
      new Error("FDICT bit set in flate stream: 256, 0"),
      new Error("Bad FCHECK in flate stream: 01, 2"),
      new Error("Invalid header in flate stream: -2, 120"),
      new Error("Invalid header in flate stream: 0, 0"),
      new Error("Unknown compression method in flate stream: 120, 0"),
      new Error("Bad FCHECK in flate stream: 120, 156"),
      new Error("FDICT bit set in flate stream: 120, 156"),
      new Error("Unexpected decoder invariant"),
      "Bad encoding in flate stream",
    ]) {
      expect(isExpectedMalformedStreamDecodeError(error)).toBe(false);
    }
  });

  it("binds malformed-Flate classification to the exact dependency authority", async () => {
    const require = createRequire(import.meta.url);
    const pdfLibPackage = require.resolve("pdf-lib/package.json");
    const flateCjs = path.join(
      path.dirname(pdfLibPackage),
      "cjs/core/streams/FlateStream.js",
    );
    const objectCopierCjs = path.join(
      path.dirname(pdfLibPackage),
      "cjs/core/PDFObjectCopier.js",
    );
    const installedManifest = JSON.parse(
      await fs.readFile(pdfLibPackage, "utf8"),
    );
    expect(installedManifest).toMatchObject({
      name: "pdf-lib",
      version: "1.17.1",
      main: "cjs/index.js",
    });
    expect(require.resolve("pdf-lib")).toBe(
      path.join(path.dirname(pdfLibPackage), "cjs/index.js"),
    );
    expect(createHash("sha256").update(await fs.readFile(flateCjs)).digest("hex"))
      .toBe(PDF_LIB_FLATE_CJS_SHA256);
    expect(
      createHash("sha256")
        .update(await fs.readFile(objectCopierCjs))
        .digest("hex"),
    ).toBe(PDF_LIB_OBJECT_COPIER_CJS_SHA256);
    for (const prefix of ["", "pdf-toolkit-mcp-share/"]) {
      const manifest = JSON.parse(
        await fs.readFile(path.join(REPO_ROOT, prefix, "package.json"), "utf8"),
      );
      const lock = JSON.parse(
        await fs.readFile(path.join(REPO_ROOT, prefix, "package-lock.json"), "utf8"),
      );
      expect(manifest.dependencies["pdf-lib"]).toBe("1.17.1");
      expect(lock.packages[""].dependencies["pdf-lib"]).toBe("1.17.1");
      expect(lock.packages["node_modules/pdf-lib"]).toMatchObject({
        version: "1.17.1",
        integrity:
          "sha512-V/mpyJAoTsN4cnP31vc0wfNA1+p20evqqnap0KLoRUN0Yk/p3wN52DOEsL4oBFcLdb76hlpKPtzJIgo67j/XLw==",
      });
    }
  });

  it("propagates an unexpected decoder implementation failure", async () => {
    const document = await PDFDocument.load(
      parsedStreamPdf("/FlateDecode", {
        payload: zlib.deflateSync(Buffer.from("safe")).toString("latin1"),
      }),
    );
    const unexpected = new TypeError("Unexpected decoder invariant");
    expect(() => assertSafeParsedPdfComplexity(document, {
      decodeStream() {
        throw unexpected;
      },
    })).toThrow(unexpected);
  });

  it.each([
    ["deep direct objects", () => makeDeepMalformedFixtures({ scale: "quick" })
      .find(item => item.name === "deep-nested-dictionaries").bytes],
    ["compressed expansion", () => flateContentPdf(20 * 1024 * 1024)],
  ])("returns a typed error without staging output for %s", async (_label, fixture) => {
    const { request, stageDirectory } = await requestFor(fixture());
    await expect(executePdfLibMutationRequest(request)).rejects.toMatchObject({
      code: "PDF_RESOURCE_LIMIT_EXCEEDED",
    });
    expect(await fs.readdir(stageDirectory)).toEqual([]);
  });

  it.each([
    "deep-nested-arrays",
    "deep-nested-dictionaries",
  ])("removes unreachable opaque %s before producing a verified mutation", async name => {
    const fixture = makeDeepMalformedFixtures({
      scale: "full",
      only: name,
    })[0];
    const { request, stageDirectory } = await requestFor(fixture.bytes);
    await expect(executePdfLibMutationRequest(request)).resolves.toBeDefined();
    const staged = await fs.readdir(stageDirectory);
    expect(staged).toHaveLength(1);
    const output = await PDFDocument.load(
      await fs.readFile(path.join(stageDirectory, staged[0])),
      { updateMetadata: false },
    );
    expect(output.getPageCount()).toBe(1);
    expect(output.getPage(0).getRotation().angle).toBe(90);
    expect(
      output.context.enumerateIndirectObjects()
        .some(([, object]) => object instanceof PDFInvalidObject),
    ).toBe(false);
  });

  it("rechecks a mutated output context immediately before save", async () => {
    const document = await PDFDocument.load(parsedStreamPdf());
    expect(() => assertSafeParsedPdfDecodeChains(document)).not.toThrow();
    const stream = document.context.enumerateIndirectObjects()
      .find(([, object]) => object instanceof PDFRawStream)?.[1];
    expect(stream).toBeInstanceOf(PDFRawStream);
    stream.dict.set(
      PDFName.of("Filter"),
      document.context.obj([
        PDFName.of("FlateDecode"),
        PDFName.of("DCTDecode"),
        PDFName.of("LZWDecode"),
      ]),
    );
    await expect(savePdfDocumentSafely(document, {
      expectedPageCount: 1,
      expectedPageRotations: [0],
    })).rejects.toMatchObject({
      code: "PDF_RESOURCE_LIMIT_EXCEEDED",
      reason: "unsafe_decode_chain",
    });
  });

  it("returns a typed error before output for a campaign-shaped 12x Flate chain", async () => {
    const filters = Array.from({ length: 12 }, () => "/FlateDecode").join(" ");
    const { request, stageDirectory } = await requestFor(
      parsedStreamPdf(`[${filters}]`),
    );
    await expect(executePdfLibMutationRequest(request)).rejects.toMatchObject({
      code: "PDF_RESOURCE_LIMIT_EXCEEDED",
      reason: "unsafe_decode_chain",
    });
    expect(await fs.readdir(stageDirectory)).toEqual([]);
  });

  it("rejects a valid zero-page source without staging a default page", async () => {
    const document = await PDFDocument.create();
    const bytes = await document.save({ addDefaultPage: false });
    const { request, stageDirectory } = await requestFor(bytes);
    await expect(executePdfLibMutationRequest(request)).rejects.toThrow(/zero pages/i);
    expect(await fs.readdir(stageDirectory)).toEqual([]);
  });

  it("keeps stored signature pdf-lib renderability probes out of the parent", async () => {
    const source = await fs.readFile(path.join(REPO_ROOT, "server", "index.js"), "utf8");
    const normalizer = source.slice(
      source.indexOf("async function normalizeStoredSignatureRecord"),
      source.indexOf("async function normalizeStoredSignatureSummary"),
    );
    const applySignature = source.slice(
      source.indexOf('case "apply_signature"'),
      source.indexOf('case "prepare_signing_packet"'),
    );
    expect(normalizer).not.toMatch(/PDFDocument\.create|embedPng|embedJpg|embedFont/);
    expect(applySignature).toContain('operation: "apply_signature"');
    expect(applySignature).not.toMatch(/PDFDocument\.create|embedPng|embedJpg|embedFont/);
  });
});

/**
 * The existing-signature resign guard, asserted as a property rather than as a
 * remembered list.
 *
 * `assertMayResave` refuses to re-save a PDF that already carries cryptographic
 * signature fields, because pdf-lib rewrites the whole file and a detached
 * signature's /ByteRange stops covering it. The refusal is escapable through
 * one option, `allow_resign`, which the worker's own OPTION_KEYS map declares
 * per operation.
 *
 * Those two facts are maintained in different places — a map literal near the
 * top of the worker and a single call site deep inside the mutation branch —
 * and nothing tied them together. A declaration without a call site is the bad
 * direction: the option is accepted, documented as a safety escape hatch, and
 * silently does nothing, which reads to a caller as a guard that exists. The
 * opposite direction, a call site without a declaration, is a refusal a caller
 * cannot get past.
 *
 * So the assertion below is an iff, derived twice and independently: the set of
 * operations whose OPTION_KEYS entry names `allow_resign` (read out of the
 * worker source) must equal the set that actually refuses a signed document
 * (measured by running each operation). It holds for whatever the guarded set
 * is, so widening the guard to more operations keeps it green; only a
 * half-wired change turns it red.
 *
 * What it deliberately does NOT assert is that the current partition is the
 * right one. At the time of writing, eight mutations — fill_pdf,
 * fill_with_profile, bulk_fill_from_csv, merge_pdfs, split_pdf,
 * rotate_pdf_pages, reorder_pdf_pages and apply_page_plan — neither declare
 * `allow_resign` nor refuse, so they re-save a signed document silently. That
 * is a coverage gap, not an invariant, and pinning it here would make a later
 * fix read as a regression.
 */
describe("existing-signature resign guard coverage", () => {
  // Read-only inspection shares the option map but is not routed through the
  // mutation entry point at all, so it carries no resign guard by construction.
  // The exclusion is measured below rather than asserted.
  const NON_MUTATION_OPERATIONS = new Set(["inspect_pdf_accessibility"]);

  const PLACEMENT = { page: 1, x: 50, y: 50, width: 120, height: 40 };
  const LABELLED_PLACEMENT = { ...PLACEMENT, label: "Sign here" };

  // The smallest option payload each operation's validator admits, minus the
  // `allow_resign` key, which is added back only for the operations that
  // declare it. Keyed by operation so the table can be checked for completeness
  // against the worker's own map instead of being trusted.
  const BASE_OPTIONS = new Map([
    ["fill_pdf", { field_data: { Name: "Bob" } }],
    ["fill_with_profile", { field_data: { Name: "Bob" } }],
    ["bulk_fill_from_csv", { records: [{ Name: "Bob" }] }],
    ["merge_pdfs", {}],
    ["split_pdf", { page_ranges: "1" }],
    ["rotate_pdf_pages", { degrees: 90, pages: [] }],
    ["reorder_pdf_pages", { page_order: [2, 1], rotations: {} }],
    ["apply_page_plan", { page_order: [2, 1], rotations: {} }],
    ["add_signature_field", { placement: LABELLED_PLACEMENT }],
    ["apply_signature", {
      audit_line: "Signed by Alice",
      audit_text: "Signed by Alice",
      draw_audit_line: false,
      modification_at: "2026-09-21T08:00:00.000Z",
      placement: PLACEMENT,
      signature: { name: "alice", style: "typed", display_name: "Alice Example" },
    }],
    ["prepare_signing_packet", {
      field_values: { Name: "Bob" },
      require_provider_ready: false,
      signature_locations: [{
        evidence_source: "caller_supplied",
        field_type: "signature",
        height: 40,
        label: "Sign here",
        page: 1,
        participant_id: null,
        participant_role: null,
        width: 120,
        x: 50,
        y: 50,
        zone_id: "zone-1",
      }],
    }],
    ["apply_text", {
      audit_line: "Text applied",
      font_style: "normal",
      modification_at: "2026-09-21T08:00:00.000Z",
      placement: PLACEMENT,
      text: "Alice Example",
    }],
  ]);
  const SOURCE_COPIES = new Map([["merge_pdfs", 2]]);

  const workerSource = readFileSync(path.join(REPO_ROOT, "server", "pdf-lib-worker.js"), "utf8");

  // The declaring side, read out of the worker's own map literal rather than
  // restated here. A rename or a reshaping of that map fails loudly instead of
  // silently emptying the set and making every assertion below vacuous.
  function declaredOptionKeys() {
    const start = workerSource.indexOf("const OPTION_KEYS = new Map([");
    const end = workerSource.indexOf("\n]);", start);
    if (start < 0 || end < 0) {
      throw new Error("pdf-lib-worker.js no longer declares OPTION_KEYS as a Map literal.");
    }
    const entries = new Map();
    for (const [, operation, keys] of workerSource.slice(start, end).matchAll(/\["([a-z_]+)",\s*\[([^\]]*)\]\]/g)) {
      entries.set(operation, [...keys.matchAll(/"([a-z_]+)"/g)].map(match => match[1]));
    }
    return entries;
  }

  const optionKeys = declaredOptionKeys();
  const mutationOperations = [...optionKeys.keys()].filter(operation => !NON_MUTATION_OPERATIONS.has(operation));
  const declaresAllowResign = operation => optionKeys.get(operation).includes("allow_resign");

  async function signableDocument() {
    const document = await PDFDocument.create();
    document.addPage([612, 792]);
    document.addPage([612, 792]);
    document.getForm().createTextField("Name")
      .addToPage(document.getPage(0), { x: 50, y: 700, width: 200, height: 20 });
    return document;
  }

  // A document carrying one real /FT /Sig widget with a /V signature dictionary
  // and /SigFlags 3, built through pdf-lib's own object model so the mutation
  // parser sees a document it could have written itself.
  async function signedPdfBytes() {
    const document = await signableDocument();
    const context = document.context;
    const signatureValueRef = context.register(context.obj({
      Type: PDFName.of("Sig"),
      Filter: PDFName.of("Adobe.PPKLite"),
      SubFilter: PDFName.of("adbe.pkcs7.detached"),
      ByteRange: context.obj([0, 0, 0, 0]),
      Contents: PDFHexString.of("00"),
      M: PDFString.of("D:20260101000000Z"),
    }));
    const widgetRef = context.register(context.obj({
      Type: PDFName.of("Annot"),
      Subtype: PDFName.of("Widget"),
      FT: PDFName.of("Sig"),
      T: PDFString.of("Signature1"),
      Rect: context.obj([100, 100, 300, 150]),
      F: PDFNumber.of(4),
      P: document.getPage(0).ref,
      V: signatureValueRef,
    }));
    document.getPage(0).node.set(PDFName.of("Annots"), context.obj([widgetRef]));
    const acroForm = document.catalog.lookup(PDFName.of("AcroForm"), PDFDict);
    acroForm.lookup(PDFName.of("Fields"), PDFArray).push(widgetRef);
    acroForm.set(PDFName.of("SigFlags"), PDFNumber.of(3));
    return Buffer.from(await document.save());
  }

  async function unsignedPdfBytes() {
    return Buffer.from(await (await signableDocument()).save());
  }

  async function mutationRequestFor(bytes, operation, { allowResign = null } = {}) {
    const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "resign-guard-")));
    roots.push(root);
    const stageDirectory = path.join(root, "stage");
    await fs.mkdir(stageDirectory, { mode: 0o700 });
    const sources = [];
    for (let index = 0; index < (SOURCE_COPIES.get(operation) ?? 1); index += 1) {
      const sourcePath = path.join(root, `source-${index}.pdf`);
      await fs.writeFile(sourcePath, bytes, { mode: 0o600 });
      const stats = await fs.lstat(sourcePath, { bigint: true });
      sources.push({
        canonical_path: sourcePath,
        file_identity: { device: String(stats.dev), inode: String(stats.ino) },
        size_bytes: bytes.length,
        sha256: createHash("sha256").update(bytes).digest("hex"),
      });
    }
    const options = { ...BASE_OPTIONS.get(operation) };
    if (declaresAllowResign(operation)) options.allow_resign = allowResign === true;
    return {
      stageDirectory,
      request: {
        protocol_version: 1,
        operation,
        sources,
        password: null,
        force_xfa: false,
        options,
        stage_directory: stageDirectory,
      },
    };
  }

  // Runs one operation and reports only what this suite is about: did the
  // resign guard fire? Any other throw is surfaced verbatim so a broken option
  // payload cannot masquerade as a refusal.
  async function resignOutcome(bytes, operation, options) {
    const { request } = await mutationRequestFor(bytes, operation, options);
    try {
      const response = await executePdfLibMutationRequest(request);
      return { operation, refused: false, status: response.status };
    } catch (error) {
      if (/cryptographic signature field/.test(error.message)) {
        return { operation, refused: true, message: error.message };
      }
      return { operation, refused: false, unexpectedError: error.message };
    }
  }

  it("covers every mutation operation the worker's own option map names", () => {
    expect(optionKeys.size).toBeGreaterThan(10);
    expect([...BASE_OPTIONS.keys()].sort()).toEqual([...mutationOperations].sort());
    for (const operation of NON_MUTATION_OPERATIONS) expect(optionKeys.has(operation)).toBe(true);
    expect(mutationOperations.filter(declaresAllowResign).length).toBeGreaterThanOrEqual(4);
  });

  it("routes the non-mutation operation away from the mutation entry point", async () => {
    const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "resign-guard-")));
    roots.push(root);
    const stageDirectory = path.join(root, "stage");
    await fs.mkdir(stageDirectory, { mode: 0o700 });
    const bytes = await unsignedPdfBytes();
    const sourcePath = path.join(root, "source.pdf");
    await fs.writeFile(sourcePath, bytes, { mode: 0o600 });
    const stats = await fs.lstat(sourcePath, { bigint: true });
    await expect(executePdfLibMutationRequest({
      protocol_version: 1,
      operation: "inspect_pdf_accessibility",
      sources: [{
        canonical_path: sourcePath,
        file_identity: { device: String(stats.dev), inode: String(stats.ino) },
        size_bytes: bytes.length,
        sha256: createHash("sha256").update(bytes).digest("hex"),
      }],
      password: null,
      options: {},
      stage_directory: stageDirectory,
    })).rejects.toThrow(/not a mutation request/i);
  });

  it("enforces the guard for exactly the operations that declare allow_resign", {
    timeout: 60_000,
  }, async () => {
    const bytes = await signedPdfBytes();
    const outcomes = [];
    for (const operation of mutationOperations) outcomes.push(await resignOutcome(bytes, operation));
    for (const outcome of outcomes) {
      expect(outcome.unexpectedError, `${outcome.operation} failed for an unrelated reason`).toBeUndefined();
    }
    const enforced = outcomes.filter(outcome => outcome.refused).map(outcome => outcome.operation).sort();
    const declared = mutationOperations.filter(declaresAllowResign).sort();
    expect(enforced).toEqual(declared);
    for (const outcome of outcomes.filter(o => o.refused)) expect(outcome.message).toContain("Signature1");
  });

  it("lets allow_resign through for every operation that declares it", {
    timeout: 60_000,
  }, async () => {
    const bytes = await signedPdfBytes();
    for (const operation of mutationOperations.filter(declaresAllowResign)) {
      const outcome = await resignOutcome(bytes, operation, { allowResign: true });
      expect(outcome, `${operation} refused despite allow_resign`).toMatchObject({ refused: false, status: "ok" });
    }
  });

  it("does not fire on a document with no signature field", {
    timeout: 60_000,
  }, async () => {
    const bytes = await unsignedPdfBytes();
    for (const operation of mutationOperations) {
      const outcome = await resignOutcome(bytes, operation);
      expect(outcome, `${operation} refused an unsigned document`).toMatchObject({ refused: false, status: "ok" });
    }
  });
});
