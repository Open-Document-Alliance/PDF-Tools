import { createHash } from "node:crypto";
import { once } from "node:events";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { LoggingMessageNotificationSchema } from "@modelcontextprotocol/sdk/types.js";
import { PDFDocument, PDFName, PDFNumber, StandardFonts, degrees } from "pdf-lib";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  extractPdfLayout,
  inspectType3GlyphEvidenceForPage,
  pdfjsFactoryDirectory,
  type3CharProcSha256,
  type3FontPaintOrientation,
  type3GlyphEvidenceSha256,
  uniqueComputerModernFamily,
  validatePdfLayoutSemantics,
  validatePdfLayoutSourceEvidence,
} from "../server/layout-extraction.js";
import { CM_CODEPOINTS, CM_WITNESS_CODEPOINTS } from "../server/type3-cm-reference.js";
import {
  TOOL_OUTPUT_SCHEMAS,
  TOOL_SUCCESS_OUTPUT_SCHEMAS,
  validateStructuredToolResult,
} from "../server/output-schemas.js";
import { AjvJsonSchemaValidator } from "@modelcontextprotocol/sdk/validation/ajv";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const require = createRequire(import.meta.url);
const TWO_COLUMN = path.join(REPO_ROOT, "test/fixtures/eval/extraction/synthetic/two-column-order.pdf");
const MIXED = path.join(REPO_ROOT, "test/fixtures/eval/extraction/synthetic/mixed-text-raster.pdf");
const ROTATED_CROP = path.join(REPO_ROOT, "test/fixtures/golden-forms/rotated-signature.pdf");
const ENCRYPTED_LAYOUT = path.join(REPO_ROOT, "test/fixtures/eval/extraction/oracles/layout-encrypted-qpdf-r4.pdf");
const ENCRYPTED_LAYOUT_PROVENANCE = path.join(REPO_ROOT, "test/fixtures/eval/extraction/oracles/layout-encrypted-qpdf-r4.provenance.json");
const STDERR_SENTINEL_HELPER = path.join(REPO_ROOT, "test/helpers/mcp-stderr-sentinel.mjs");
const RAW_PAGE_SPACE = { basis: "pdf_default_user_space", unit: "pdf_user_unit", stage: "before_user_unit_and_page_rotation" };
const ITEM_SPACE = { origin: "top_left", unit: "points_1_72_in_after_user_unit", reference_box: "pdfjs_display_viewport" };
const HORIZONTAL_GEOMETRY_PROVENANCE = {
  formula: "pdfjs_text_item_style_metric_advance_box_approximation",
  quad_order: "anchor_top_terminal_top_anchor_bottom_terminal_bottom",
  advance_source: "item_width",
  ascent_source: "style_ascent",
  ascent_ratio: 0.905,
};

describe("qualified legacy Type-3 glyph evidence", () => {
  const streamObject = (data) => Buffer.concat([
    Buffer.from(`<< /Length ${data.length} >>\nstream\n`, "latin1"),
    data,
    Buffer.from("\nendstream", "latin1"),
  ]);

  function assemblePdf(bodies) {
    const header = Buffer.from("%PDF-1.4\n%\xE2\xE3\xCF\xD3\n", "latin1");
    const chunks = [header];
    const offsets = [];
    let offset = header.length;
    bodies.forEach((body, index) => {
      const prefix = Buffer.from(`${index + 1} 0 obj\n`, "latin1");
      const suffix = Buffer.from("\nendobj\n", "latin1");
      offsets.push(offset);
      chunks.push(prefix, body, suffix);
      offset += prefix.length + body.length + suffix.length;
    });
    let xref = `xref\n0 ${bodies.length + 1}\n0000000000 65535 f \n`;
    for (const value of offsets) xref += `${String(value).padStart(10, "0")} 00000 n \n`;
    xref += `trailer\n<< /Size ${bodies.length + 1} /Root 1 0 R >>\n`
      + `startxref\n${offset}\n%%EOF\n`;
    chunks.push(Buffer.from(xref, "latin1"));
    return new Uint8Array(Buffer.concat(chunks));
  }

  const minusCharProc = () => ({
    fnArray: [49, 10, 12, 91, 11],
    argsArray: [
      [52, 0, 5, 15, 46, 18],
      null,
      [41, 0, 0, 3, 5.1, 14.9],
      [
        94,
        [new Float32Array([0, 0, 1, 1, 0, 0, 1, 1, 0, 1, 1, 1, 1, 0, 1])],
        new Float32Array([0, 0, 41, 3]),
      ],
      null,
    ],
  });

  it("pins the exact reviewed glyph program and refuses a one-value near match", () => {
    expect(type3CharProcSha256(minusCharProc())).toBe(
      "b32276d22e1dd4133c20888ade044d27e59f2cbdfca0901c3b9d46006ed7dee9",
    );
    const nearMatch = minusCharProc();
    nearMatch.argsArray[3][1][0][14] = 0;
    expect(type3CharProcSha256(nearMatch)).not.toBe(
      "b32276d22e1dd4133c20888ade044d27e59f2cbdfca0901c3b9d46006ed7dee9",
    );
    expect(type3CharProcSha256({ fnArray: [49], argsArray: [new Float32Array(100001)] })).toBeNull();
  });

  /**
   * The shipped recovery key: the stored sample grid of a Type-3 glyph's inline
   * image mask, cropped to its ink. `minusCharProc` is a real dvipdfmx-shaped
   * Type-3 glyph: one 41x3 inline image mask, placed by a `cm` inside a `q`/`Q`,
   * under a y-flipping FontMatrix. Everything asserted below is a property of
   * the decoded mask, and everything varied below is a property of the producer.
   */
  describe("producer-independent Type-3 glyph shape key", () => {
    // PDF.js operator numbers, taken from the pinned build rather than typed,
    // so an upstream renumbering fails here instead of silently keying on the
    // wrong operators. The module itself is kept so the built fixtures below
    // are parsed by the same pinned build the server uses.
    let pdfjsLib = null;
    let OPS = null;
    beforeAll(async () => {
      pdfjsLib = await import("pdfjs-dist/legacy/build/pdf.mjs");
      ({ OPS } = pdfjsLib);
    });
    const FLIPPED = [1, 0, 0, -1, 0, 0];
    const packageDirectory = path.dirname(require.resolve("pdfjs-dist/package.json"));
    /*
     * The fourth argument is the font's unanimous CharProc-local determinant
     * sign, which `type3FontPaintOrientation` computes over the whole
     * /CharProcs dictionary and which the mask lane requires. Every fixture
     * below is a one-glyph font, so the font's sign is just that glyph's own:
     * `FLIPPED` over a positive-scale `cm` composes to -1, an upright
     * FontMatrix over the same `cm` to +1. The two are equal-and-opposite on
     * purpose — passing each font its own sign is exactly what production
     * does, and the keys still have to agree across them.
     */
    const FLIPPED_FONT = -1;
    const UPRIGHT_FONT = 1;

    it("keys the same raster identically across producer idiom and placement", () => {
      const key = type3GlyphEvidenceSha256(minusCharProc(), FLIPPED, OPS, FLIPPED_FONT);
      expect(key).toMatch(/^[0-9a-f]{64}$/);

      // Same mask, moved: a different producer would not put the bitmap at the
      // same offset, and the old CharProc digest folded that offset in.
      const moved = minusCharProc();
      moved.argsArray[2] = [41, 0, 0, 3, 12, 30.25];
      expect(type3GlyphEvidenceSha256(moved, FLIPPED, OPS, FLIPPED_FONT)).toBe(key);

      // Same mask, no q/Q wrapper and different declared glyph metrics: the
      // dvips idiom rather than the dvipdfmx one.
      const bare = {
        fnArray: [OPS.setCharWidthAndBounds, OPS.transform, OPS.constructPath],
        argsArray: [[52, 0, 0, 0, 41, 3], [41, 0, 0, 3, 0, 0], minusCharProc().argsArray[3]],
      };
      expect(type3GlyphEvidenceSha256(bare, [1, 0, 0, 1, 0, 0], OPS, UPRIGHT_FONT)).toBe(key);

      // The v1 CharProc digests of the same three programs all differ, which
      // is exactly the portability defect this key exists to remove.
      expect(new Set([minusCharProc(), moved, bare].map(type3CharProcSha256)).size).toBe(3);
    });

    /**
     * The defect this replaces a pair of tests for.
     *
     * The withdrawn revision keyed on `sign(FontMatrix x CharProc cm)` and
     * called the result the glyph's painted orientation. It is not: the text
     * matrix and the page CTM are the other half of that product and neither is
     * reachable from inside a CharProc. Two producers that render a
     * pixel-identical glyph by splitting the y-flip differently between the
     * FontMatrix and the text matrix — which is exactly how a dvipdfmx-shaped
     * document and a Ghostscript-shaped one differ — got different keys.
     *
     * So this builds both documents rather than asserting on a hand-picked
     * raster: the same eight mask bytes, reached through genuinely different
     * producer idioms, landing on the page in exactly the same place.
     */
    describe("two producers, one bitmap", () => {
      // An asymmetric 8x8 "F": not its own mirror in either axis, so a key that
      // reorients the grid cannot pass these by accident.
      const INK_ROWS = Object.freeze([0xfe, 0x80, 0x80, 0xf8, 0x80, 0x80, 0x80, 0x80]);

      function buildType3MaskPdf({ fontMatrix, glyphName, charCode, charProc, textMatrix }) {
        return assemblePdf([
          Buffer.from("<< /Type /Catalog /Pages 2 0 R >>", "latin1"),
          Buffer.from("<< /Type /Pages /Kids [3 0 R] /Count 1 >>", "latin1"),
          Buffer.from("<< /Type /Page /Parent 2 0 R /MediaBox [0 0 100 100] "
            + "/Resources << /Font << /F1 5 0 R >> >> /Contents 4 0 R >>", "latin1"),
          // No page-level `cm`, and a font size of 1, so the only placement the
          // page contributes is the text matrix asserted on below.
          streamObject(Buffer.from(
            `BT /F1 1 Tf ${textMatrix.join(" ")} Tm `
            + `<${charCode.toString(16).padStart(2, "0")}> Tj ET\n`,
            "latin1",
          )),
          Buffer.from("<< /Type /Font /Subtype /Type3 /FontBBox [0 0 8 8] "
            + `/FontMatrix [${fontMatrix.join(" ")}] /CharProcs 6 0 R `
            + `/Encoding << /Type /Encoding /Differences [${charCode} /${glyphName}] >> `
            + `/FirstChar ${charCode} /LastChar ${charCode} /Widths [10] `
            + "/Resources << >> >>", "latin1"),
          Buffer.from(`<< /${glyphName} 7 0 R >>`, "latin1"),
          streamObject(charProc),
        ]);
      }

      // dvipdfmx-shaped: a `q`/`Q` wrapper, an upright hundredths FontMatrix,
      // the default /Decode, and raw binary samples (0 paints, so the bytes are
      // the complement of the ink).
      const dvipdfmxCharProc = (rows = INK_ROWS) => Buffer.concat([
        Buffer.from("1000 0 0 0 800 800 d1\nq 800 0 0 800 0 0 cm\n"
          + "BI /IM true /W 8 /H 8 /BPC 1 ID ", "latin1"),
        Buffer.from(rows.map(row => ~row & 0xff)),
        Buffer.from("\nEI\nQ\n", "latin1"),
      ]);
      // Ghostscript-shaped: no wrapper, a y-flipping unit FontMatrix, an
      // inverted /Decode, and ASCIIHex-filtered samples (1 paints, so the bytes
      // are the ink itself). Every byte of this program differs from the one
      // above; the mask they decode to does not.
      const ghostscriptCharProc = (rows = INK_ROWS) => Buffer.concat([
        Buffer.from("10 0 0 -8 8 0 d1\n8 0 0 8 0 -8 cm\n"
          + "BI /IM true /W 8 /H 8 /BPC 1 /D [1 0] /F /AHx ID ", "latin1"),
        Buffer.from(`${Buffer.from(rows).toString("hex")}>`, "latin1"),
        Buffer.from("\nEI\n", "latin1"),
      ]);

      const DVIPDFMX = Object.freeze({
        fontMatrix: [0.01, 0, 0, 0.01, 0, 0],
        glyphName: "shape",
        charCode: 65,
        textMatrix: [1, 0, 0, 1, 20, 60],
      });
      const GHOSTSCRIPT = Object.freeze({
        fontMatrix: [1, 0, 0, -1, 0, 0],
        glyphName: "Fbitmap",
        charCode: 97,
        textMatrix: [1, 0, 0, -1, 20, 68],
      });

      const compose = (outer, inner) => [
        outer[0] * inner[0] + outer[2] * inner[1],
        outer[1] * inner[0] + outer[3] * inner[1],
        outer[0] * inner[2] + outer[2] * inner[3],
        outer[1] * inner[2] + outer[3] * inner[3],
        outer[0] * inner[4] + outer[2] * inner[5] + outer[4],
        outer[1] * inner[4] + outer[3] * inner[5] + outer[5],
      ];

      /**
       * Loads one built document through the pinned PDF.js and reports what the
       * key is computed from, plus the two matrices that decide where the glyph
       * actually lands. Nothing here is hand-typed: the CharProc operator list,
       * the FontMatrix, and the text matrix all come back out of the parser.
       */
      async function measureBuiltDocument(bytes) {
        const document = await pdfjsLib.getDocument({
          data: bytes,
          useWorkerFetch: false,
          isEvalSupported: false,
          cMapUrl: pdfjsFactoryDirectory(path.join(packageDirectory, "cmaps")),
          cMapPacked: true,
          standardFontDataUrl: pdfjsFactoryDirectory(path.join(packageDirectory, "standard_fonts")),
        }).promise;
        try {
          const page = await document.getPage(1);
          const operators = await page.getOperatorList();
          let fontId = null;
          let fontSize = null;
          let textMatrix = null;
          let pageTransforms = 0;
          for (let index = 0; index < operators.fnArray.length; index += 1) {
            const operation = operators.fnArray[index];
            const args = operators.argsArray[index];
            if (operation === OPS.setFont) [fontId, fontSize] = args;
            if (operation === OPS.setTextMatrix) textMatrix = [...args[0]];
            if (operation === OPS.transform) pageTransforms += 1;
          }
          const font = page.commonObjs.get(fontId);
          const entries = Object.entries(font.charProcOperatorList ?? {});
          expect(entries).toHaveLength(1);
          const [, charProc] = entries[0];
          // The CharProc-local matrix the mask lane's guard inspects: the
          // FontMatrix composed with this glyph program's own `cm`.
          let local = [...font.fontMatrix];
          for (let index = 0; index < charProc.fnArray.length; index += 1) {
            if (charProc.fnArray[index] === OPS.transform) {
              local = compose(local, charProc.argsArray[index]);
            }
          }
          return {
            font_size: fontSize,
            page_transform_count: pageTransforms,
            font_matrix: [...font.fontMatrix],
            local_matrix: local,
            placement: compose(textMatrix, local),
            // A one-glyph font, so its unanimous paint orientation is this
            // glyph's own CharProc-local determinant sign.
            evidence_sha256: type3GlyphEvidenceSha256(
              charProc, font.fontMatrix, OPS, Math.sign(local[0] * local[3]),
            ),
            charproc_sha256: type3CharProcSha256(charProc),
          };
        } finally {
          await document.destroy();
        }
      }

      const measureIdiom = (idiom, charProc) =>
        measureBuiltDocument(buildType3MaskPdf({ ...idiom, charProc }));

      it("gives one bitmap one key across two producer idioms that paint it identically", async () => {
        const dvipdfmx = await measureIdiom(DVIPDFMX, dvipdfmxCharProc());
        const ghostscript = await measureIdiom(GHOSTSCRIPT, ghostscriptCharProc());

        // Both documents put the same 8x8 mask on the same eight points of the
        // page, at the same scale and the same way up, so any renderer produces
        // identical pixels. Nothing outside the text matrix moves the glyph:
        // there is no page-level `cm` and the font size is 1 in both.
        for (const measured of [dvipdfmx, ghostscript]) {
          expect(measured.page_transform_count).toBe(0);
          expect(measured.font_size).toBe(1);
        }
        expect(dvipdfmx.placement).toEqual([8, 0, 0, 8, 20, 60]);
        expect(ghostscript.placement).toEqual(dvipdfmx.placement);

        // They are nonetheless different programs from different producers, and
        // they split that identical placement across the FontMatrix, the `cm`
        // and the text matrix in opposite ways. The withdrawn key read the sign
        // of `local_matrix` and so separated them; this asserts the two signs
        // really are opposite, so the test cannot pass vacuously.
        expect(dvipdfmx.font_matrix).not.toEqual(ghostscript.font_matrix);
        expect(Math.sign(dvipdfmx.local_matrix[3]))
          .toBe(-Math.sign(ghostscript.local_matrix[3]));
        expect(dvipdfmx.charproc_sha256).not.toBe(ghostscript.charproc_sha256);

        expect(dvipdfmx.evidence_sha256).toMatch(/^[0-9a-f]{64}$/);
        expect(ghostscript.evidence_sha256).toBe(dvipdfmx.evidence_sha256);
      });

      it("still separates two bitmaps that differ, in either axis or in ink", async () => {
        const baseline = (await measureIdiom(DVIPDFMX, dvipdfmxCharProc())).evidence_sha256;
        const keyOf = async rows => {
          // Measured through both producers every time, so a variant that only
          // one idiom separates would fail here rather than look distinct.
          const first = await measureIdiom(DVIPDFMX, dvipdfmxCharProc(rows));
          const second = await measureIdiom(GHOSTSCRIPT, ghostscriptCharProc(rows));
          expect(second.evidence_sha256).toBe(first.evidence_sha256);
          return first.evidence_sha256;
        };

        const oneBitFewer = [...INK_ROWS];
        oneBitFewer[0] &= ~0x02;
        const upsideDown = [...INK_ROWS].reverse();
        const backToFront = INK_ROWS.map(row => {
          let flipped = 0;
          for (let bit = 0; bit < 8; bit += 1) if (row & (1 << bit)) flipped |= 128 >> bit;
          return flipped;
        });

        const distinct = await Promise.all([oneBitFewer, upsideDown, backToFront].map(keyOf));
        // Reversing the stored rows or the stored columns is a different
        // bitmap, not a different view of this one, and must not collide with
        // it or with each other.
        expect(new Set([baseline, ...distinct]).size).toBe(4);
      });

      /**
       * The attack the grid key on its own cannot see, and the safeguard that
       * does: reflection relative to a font's own siblings.
       *
       * Nothing above distinguishes a glyph from its mirror image, and it must
       * not: an upright document and a y-flipped one are two producers writing
       * the same character. But mirroring is not always a re-orientation of the
       * same character. In Computer Modern it is usually a DIFFERENT enrolled
       * character — every cmex parenthesis and bracket pair is one raster and
       * its mirror — so a CharProc that stores the `]` raster and negates the x
       * scale of its own `cm` paints a `[` while keying as `]`. Reproduced on
       * the Shannon reference document by editing exactly that one number and
       * leaving the mask bytes byte-identical: it kept emitting `]` eleven
       * times, with no gap reported.
       *
       * The two documents below are the same font twice, holding the same two
       * copies of the same 8x8 mask, differing only in whether the second
       * glyph's `cm` is reflected. Absolute orientation is not consulted and
       * cannot be — the page's text matrix is not visible from a CharProc — so
       * the whole of the evidence is that one glyph disagrees with its
       * siblings.
       */
      describe("one font, one glyph reflected relative to its siblings", () => {
        function buildTwoGlyphType3MaskPdf({ mirrorSecondGlyph }) {
          const proc = placement => Buffer.concat([
            Buffer.from(`1000 0 0 0 800 800 d1\nq ${placement} cm\n`
              + "BI /IM true /W 8 /H 8 /BPC 1 ID ", "latin1"),
            Buffer.from(INK_ROWS.map(row => ~row & 0xff)),
            Buffer.from("\nEI\nQ\n", "latin1"),
          ]);
          return assemblePdf([
            Buffer.from("<< /Type /Catalog /Pages 2 0 R >>", "latin1"),
            Buffer.from("<< /Type /Pages /Kids [3 0 R] /Count 1 >>", "latin1"),
            Buffer.from("<< /Type /Page /Parent 2 0 R /MediaBox [0 0 100 100] "
              + "/Resources << /Font << /F1 5 0 R >> >> /Contents 4 0 R >>", "latin1"),
            streamObject(Buffer.from("BT /F1 1 Tf 1 0 0 1 20 60 Tm <4142> Tj ET\n", "latin1")),
            Buffer.from("<< /Type /Font /Subtype /Type3 /FontBBox [0 0 8 8] "
              + "/FontMatrix [0.01 0 0 0.01 0 0] /CharProcs 6 0 R "
              + "/Encoding << /Type /Encoding /Differences [65 /upright /sibling] >> "
              + "/FirstChar 65 /LastChar 66 /Widths [10 10] /Resources << >> >>", "latin1"),
            Buffer.from("<< /upright 7 0 R /sibling 8 0 R >>", "latin1"),
            streamObject(proc("800 0 0 800 0 0")),
            // Same eight mask bytes either way. The only difference between the
            // two documents is the sign of this one number, and the matching
            // translation that puts the reflected ink back in the same box.
            streamObject(proc(mirrorSecondGlyph ? "-800 0 0 800 800 0" : "800 0 0 800 0 0")),
          ]);
        }

        async function measureFont(mirrorSecondGlyph) {
          const document = await pdfjsLib.getDocument({
            data: buildTwoGlyphType3MaskPdf({ mirrorSecondGlyph }),
            useWorkerFetch: false,
            isEvalSupported: false,
            cMapUrl: pdfjsFactoryDirectory(path.join(packageDirectory, "cmaps")),
            cMapPacked: true,
            standardFontDataUrl: pdfjsFactoryDirectory(path.join(packageDirectory, "standard_fonts")),
          }).promise;
          try {
            const page = await document.getPage(1);
            const operators = await page.getOperatorList();
            let fontId = null;
            for (let index = 0; index < operators.fnArray.length; index += 1) {
              if (operators.fnArray[index] === OPS.setFont) [fontId] = operators.argsArray[index];
            }
            const font = page.commonObjs.get(fontId);
            expect(Object.keys(font.charProcOperatorList ?? {})).toEqual(["upright", "sibling"]);
            const orientation = type3FontPaintOrientation(font, OPS);
            const keyFor = (glyphId, assumedOrientation) => type3GlyphEvidenceSha256(
              font.charProcOperatorList[glyphId], font.fontMatrix, OPS, assumedOrientation,
            );
            return {
              orientation,
              upright: keyFor("upright", orientation),
              sibling: keyFor("sibling", orientation),
              // What the sibling keys as when its OWN sign is taken for its
              // font's convention, which is all a per-glyph check could ever
              // ask. The reflected `cm` makes that sign -1 and the unreflected
              // one +1, so this is the mask-lane key in both documents.
              sibling_self_signed: keyFor("sibling", mirrorSecondGlyph ? -1 : 1),
              operator_upright: type3CharProcSha256(font.charProcOperatorList.upright),
              operator_sibling: type3CharProcSha256(font.charProcOperatorList.sibling),
            };
          } finally {
            await document.destroy();
          }
        }

        it("keys both glyphs on the grid when the font agrees with itself", async () => {
          const uniform = await measureFont(false);
          // A real, unanimous convention, and both glyphs reach the mask lane.
          expect(uniform.orientation).toBe(1);
          expect(uniform.upright).toMatch(/^[0-9a-f]{64}$/);
          // Same stored grid, so the same key. This is the behaviour the whole
          // producer-independent scheme exists for and it is not weakened.
          expect(uniform.sibling).toBe(uniform.upright);
          expect(uniform.upright).not.toBe(uniform.operator_upright);
        });

        it("refuses the grid key to a whole font that disagrees with itself", async () => {
          const uniform = await measureFont(false);
          const mirrored = await measureFont(true);

          // The mask bytes are untouched, so the reflected glyph's stored grid
          // is still bit-for-bit the upright one's. Keyed on its own sign it
          // would collide with the upright glyph exactly as before — which is
          // the defect, since the ink now paints mirrored.
          expect(mirrored.sibling_self_signed).toBe(uniform.upright);

          // The font has no convention, so no glyph of it is grid-keyed.
          expect(mirrored.orientation).toBeNull();
          expect(mirrored.sibling).not.toBe(uniform.upright);
          expect(mirrored.upright).not.toBe(uniform.upright);
          // Not silence: both fall to the placement-bearing operator lane,
          // which is domain-separated from every mask-keyed registry entry and
          // therefore recovers nothing.
          expect(mirrored.sibling).toMatch(/^[0-9a-f]{64}$/);
          expect(mirrored.sibling).not.toBe(mirrored.operator_sibling);
          expect(mirrored.sibling).not.toBe(mirrored.upright);
        });
      });
    });

    it("refuses to conflate a different raster or a different grid", () => {
      const key = type3GlyphEvidenceSha256(minusCharProc(), FLIPPED, OPS, FLIPPED_FONT);
      const oneBit = minusCharProc();
      oneBit.argsArray[3][1][0][14] = 0;
      expect(type3GlyphEvidenceSha256(oneBit, FLIPPED, OPS, FLIPPED_FONT)).not.toBe(key);
      const wider = minusCharProc();
      wider.argsArray[3][2] = new Float32Array([0, 0, 82, 3]);
      expect(type3GlyphEvidenceSha256(wider, FLIPPED, OPS, FLIPPED_FONT)).not.toBe(key);
      // A mask key and an operator-lane key are domain-separated and cannot
      // collide even when they cover the same glyph program.
      expect(key).not.toBe(type3CharProcSha256(minusCharProc()));
    });

    /**
     * A mask with no ink has no shape, so it cannot be keyed as one. Left
     * unguarded it cropped to 0x0 and every blank glyph of every font hashed to
     * the single digest of an empty buffer.
     */
    it("sends an inkless mask to the placement-bearing operator lane", () => {
      // A degenerate loop: two coincident vertical edges of opposite winding,
      // which is a well-formed traced outline that fills nothing.
      const blank = metrics => ({
        fnArray: [OPS.setCharWidthAndBounds, OPS.transform, OPS.constructPath],
        argsArray: [
          metrics,
          [41, 0, 0, 3, 0, 0],
          [94, [new Float32Array([0, 0, 1, 1, 0, 0, 1, 0, 1, 4])], new Float32Array([0, 0, 41, 3])],
        ],
      });
      const inked = type3GlyphEvidenceSha256(minusCharProc(), FLIPPED, OPS, FLIPPED_FONT);
      const first = type3GlyphEvidenceSha256(blank([52, 0, 0, 0, 41, 3]), FLIPPED, OPS, FLIPPED_FONT);
      const second = type3GlyphEvidenceSha256(blank([31, 0, 0, 0, 41, 3]), FLIPPED, OPS, FLIPPED_FONT);
      expect(first).toMatch(/^[0-9a-f]{64}$/);
      expect(first).not.toBe(inked);
      // The mask lane ignores declared metrics, so two blank programs that
      // differ only there proves the fallback actually happened.
      expect(second).not.toBe(first);
      expect(first).not.toBe(type3CharProcSha256(blank([52, 0, 0, 0, 41, 3])));
    });

    it("falls back to the exact operator digest for a program it cannot decode", () => {
      const outline = { fnArray: [OPS.setCharWidthAndBounds, OPS.fill], argsArray: [[52, 0, 0, 0, 4, 4], null] };
      const outlineKey = type3GlyphEvidenceSha256(outline, FLIPPED, OPS, FLIPPED_FONT);
      expect(outlineKey).toMatch(/^[0-9a-f]{64}$/);
      expect(outlineKey).not.toBe(type3CharProcSha256(outline));
      // Two painted objects are not a single decodable mask, and a CharProc
      // that rotates its own bitmap is outside the plain axis-aligned bitmap
      // idiom the mask lane is held to. Both take the operator digest instead
      // of being keyed on a guess.
      const twice = minusCharProc();
      twice.fnArray = [...twice.fnArray, 91];
      twice.argsArray = [...twice.argsArray, minusCharProc().argsArray[3]];
      expect(type3GlyphEvidenceSha256(twice, FLIPPED, OPS, FLIPPED_FONT)).toBe(
        type3GlyphEvidenceSha256(
          { fnArray: twice.fnArray, argsArray: twice.argsArray }, [0, 1, -1, 0, 0, 0], OPS, FLIPPED_FONT,
        ),
      );
      const rotated = type3GlyphEvidenceSha256(minusCharProc(), [0, 1, -1, 0, 0, 0], OPS, FLIPPED_FONT);
      expect(rotated).not.toBe(type3GlyphEvidenceSha256(minusCharProc(), FLIPPED, OPS, FLIPPED_FONT));
      expect(type3GlyphEvidenceSha256(null, FLIPPED, OPS, FLIPPED_FONT)).toBeNull();
    });
  });

  it("requires one unique official Computer Modern encoding family", () => {
    expect(uniqueComputerModernFamily([[0, 52], [21, 52], [112, 55]]))
      .toBe("computer-modern-math-symbol");
    expect(uniqueComputerModernFamily([[11, 45], [25, 41], [26, 36], [33, 44]]))
      .toBe("computer-modern-math-italic");
    expect(uniqueComputerModernFamily([[58, 18], [59, 18], [61, 33]]))
      .toBe("computer-modern-math-italic");
    expect(uniqueComputerModernFamily([[0, 52]])).toBeNull();
    expect(uniqueComputerModernFamily([[40, 32], [41, 32]])).toBeNull();
  });

  /**
   * The linker's uniqueness pool is the WHOLE page's Type-3 fonts, not the
   * recoverable subset of them.
   *
   * PDF.js hands back a glyph's code, advance and CharProc name but not the
   * font dictionary it came from, so the raw font has to be re-identified from
   * the page by matching those three. Two fonts on one page can answer to the
   * same evidence, and when they do the honest answer is that the linker does
   * not know which one it is holding.
   *
   * The two kinds of font that are themselves ineligible are exactly the ones
   * it is tempting to drop from that pool: a font carrying its own /ToUnicode,
   * whose producer-supplied mapping is deliberately left alone, and a font
   * declaring codes past 127, which no official Computer Modern encoding
   * reaches. Dropping either would silently resolve the ambiguity in favour of
   * the recoverable font. They stay in the pool as competitors and stay
   * ineligible themselves, and both halves are asserted below.
   */
  describe("whole-page Type-3 link competition", () => {
    const MASK_ROWS = Object.freeze([0xfe, 0x80, 0x80, 0xf8, 0x80, 0x80, 0x80, 0x80]);
    const charProcBody = Buffer.concat([
      Buffer.from("1000 0 0 0 800 800 d1\nq 800 0 0 800 0 0 cm\n"
        + "BI /IM true /W 8 /H 8 /BPC 1 ID ", "latin1"),
      Buffer.from(MASK_ROWS.map(row => ~row & 0xff)),
      Buffer.from("\nEI\nQ\n", "latin1"),
    ]);
    // A Type-3 font body with the shared identity the linker matches on: the
    // same two codes, the same two advances and the same two CharProc names.
    const type3Font = extra => Buffer.from("<< /Type /Font /Subtype /Type3 /FontBBox [0 0 8 8] "
      + "/FontMatrix [0.01 0 0 0.01 0 0] /CharProcs 6 0 R "
      + "/Encoding << /Type /Encoding /Differences [65 /upright /sibling] >> "
      + `${extra} /Resources << >> >>`, "latin1");
    const RECOVERABLE = "/FirstChar 65 /LastChar 66 /Widths [10 10]";
    // Ineligible because PDF.js already maps it. `/Widths` is identical, so it
    // is indistinguishable from the recoverable font on the linker's evidence.
    const HAS_TO_UNICODE = `${RECOVERABLE} /ToUnicode 9 0 R`;
    // Ineligible because no official Computer Modern encoding reaches past
    // 127. Same two advances at the same two codes; the extra slots are the
    // out-of-range declaration itself.
    const OUT_OF_RANGE = `/FirstChar 65 /LastChar 200 /Widths [${["10", "10", ...Array(134).fill("7")].join(" ")}]`;

    const TO_UNICODE_CMAP = Buffer.from(
      "/CIDInit /ProcSet findresource begin 12 dict begin begincmap\n"
      + "/CMapName /Custom def /CMapType 2 def\n"
      + "1 begincodespacerange <00> <ff> endcodespacerange\n"
      + "1 beginbfrange <41> <42> <0041> endbfrange\n"
      + "endcmap CMapName currentdict /CMap defineresource pop end end\n", "latin1");

    // `fonts` names exactly which of the two font dictionaries the page's
    // /Resources offers, so a page can hold the recoverable font alone, the
    // ineligible font alone, or both in competition.
    function buildCompetitionPdf({ competitor, fonts, drawWith }) {
      const resources = fonts.map(name => `/${name} ${name === "F1" ? "5" : "8"} 0 R`).join(" ");
      return assemblePdf([
        Buffer.from("<< /Type /Catalog /Pages 2 0 R >>", "latin1"),
        Buffer.from("<< /Type /Pages /Kids [3 0 R] /Count 1 >>", "latin1"),
        Buffer.from("<< /Type /Page /Parent 2 0 R /MediaBox [0 0 100 100] "
          + `/Resources << /Font << ${resources} >> >> /Contents 4 0 R >>`, "latin1"),
        streamObject(Buffer.from(`BT /${drawWith} 1 Tf 1 0 0 1 20 60 Tm <4142> Tj ET\n`, "latin1")),
        type3Font(RECOVERABLE),
        Buffer.from("<< /upright 7 0 R /sibling 7 0 R >>", "latin1"),
        streamObject(charProcBody),
        type3Font(competitor ?? RECOVERABLE),
        streamObject(TO_UNICODE_CMAP),
      ]);
    }

    async function inspectCompetition(options) {
      const bytes = buildCompetitionPdf(options);
      const pdfLibDocument = await PDFDocument.load(bytes, { ignoreEncryption: true, updateMetadata: false });
      const packageDirectory = path.dirname(require.resolve("pdfjs-dist/package.json"));
      const pdfjsLib = await import("pdfjs-dist/legacy/build/pdf.mjs");
      const document = await pdfjsLib.getDocument({
        data: bytes,
        useWorkerFetch: false,
        isEvalSupported: false,
        cMapUrl: pdfjsFactoryDirectory(path.join(packageDirectory, "cmaps")),
        cMapPacked: true,
        standardFontDataUrl: pdfjsFactoryDirectory(path.join(packageDirectory, "standard_fonts")),
      }).promise;
      try {
        const page = await document.getPage(1);
        const [textContent, operators] = await Promise.all([
          page.getTextContent({ includeMarkedContent: false, disableNormalization: false }),
          page.getOperatorList(),
        ]);
        const inventory = inspectType3GlyphEvidenceForPage({
          textContent,
          operators,
          pdfjsPage: page,
          pdfLibPage: pdfLibDocument.getPage(0),
          pdfjsLib,
        });
        return {
          occurrence_count: inventory.occurrences.length,
          unlinked: inventory.omissions
            .filter(omission => omission.reason === "raw_type3_font_link_ambiguous_or_unavailable")
            .reduce((total, omission) => total + omission.count, 0),
        };
      } finally {
        await document.destroy();
      }
    }

    it("links the recoverable font when it is the only Type-3 font on the page", async () => {
      // The positive control. Without this the ambiguity assertions below
      // could pass because the fixture never links at all.
      const alone = await inspectCompetition({ competitor: null, fonts: ["F1"], drawWith: "F1" });
      expect(alone.unlinked).toBe(0);
      expect(alone.occurrence_count).toBe(2);
    });

    for (const [label, competitor] of [["a /ToUnicode font", HAS_TO_UNICODE], ["an out-of-range font", OUT_OF_RANGE]]) {
      it(`refuses to link when ${label} answers to the same evidence`, async () => {
        const contested = await inspectCompetition({ competitor, fonts: ["F1", "F2"], drawWith: "F1" });
        // The competitor is never drawn and can never be recovered from. It
        // still makes the drawn font's identity ambiguous, and ambiguous is
        // reported rather than resolved.
        expect(contested.occurrence_count).toBe(0);
        expect(contested.unlinked).toBe(2);
      });

      it(`keeps ${label} ineligible when it is the only font on the page`, async () => {
        // Alone, so nothing competes with it and the link is unambiguous. What
        // refuses it here is its own ineligibility and nothing else.
        const drawn = await inspectCompetition({ competitor, fonts: ["F2"], drawWith: "F2" });
        expect(drawn.occurrence_count).toBe(0);
        expect(drawn.unlinked).toBe(2);
      });
    }
  });

  /**
   * A /Differences glyph name is bytes, and PDF names escape an irregular byte
   * as `#` plus two hexadecimal digits in either letter case. pdf-lib's
   * `decodeText()` unescapes digits and UPPERCASE A-F only, so the linker sees
   * a different string from PDF.js exactly when a producer wrote lowercase hex
   * — which dvips-era Ghostscript does for every Computer Modern glyph it
   * names after its own raw encoding byte.
   *
   * Both readings are asserted, because they pull in opposite directions and a
   * fix for one is the obvious way to break the other. `/#0b` is an escape
   * pdf-lib missed and its glyph is really U+000B; `/#230b` is an escaped
   * `#` and its glyph is really the three-character name `#0b`, which pdf-lib
   * and PDF.js already agree on. Unescaping every residual `#hh` would link
   * the first and break the second.
   */
  describe("hex-escaped Type-3 glyph names", () => {
    const MASK_ROWS = Object.freeze([0xfe, 0x80, 0x80, 0xf8, 0x80, 0x80, 0x80, 0x80]);
    const escapedCharProc = Buffer.concat([
      Buffer.from("1000 0 0 0 800 800 d1\nq 800 0 0 800 0 0 cm\n"
        + "BI /IM true /W 8 /H 8 /BPC 1 ID ", "latin1"),
      Buffer.from(MASK_ROWS.map(row => ~row & 0xff)),
      Buffer.from("\nEI\nQ\n", "latin1"),
    ]);

    /**
     * One page, one Type-3 font, two drawn codes, and `names` written verbatim
     * into both the /Differences array and the /CharProcs dictionary so the
     * fixture varies nothing but the on-disk spelling of the glyph name.
     */
    function buildEscapedNamePdf(names) {
      return assemblePdf([
        Buffer.from("<< /Type /Catalog /Pages 2 0 R >>", "latin1"),
        Buffer.from("<< /Type /Pages /Kids [3 0 R] /Count 1 >>", "latin1"),
        Buffer.from("<< /Type /Page /Parent 2 0 R /MediaBox [0 0 100 100] "
          + "/Resources << /Font << /F1 5 0 R >> >> /Contents 4 0 R >>", "latin1"),
        streamObject(Buffer.from("BT /F1 1 Tf 1 0 0 1 20 60 Tm <4142> Tj ET\n", "latin1")),
        Buffer.from("<< /Type /Font /Subtype /Type3 /FontBBox [0 0 8 8] "
          + "/FontMatrix [0.01 0 0 0.01 0 0] /CharProcs 6 0 R "
          + `/Encoding << /Type /Encoding /Differences [65 /${names[0]} /${names[1]}] >> `
          + "/FirstChar 65 /LastChar 66 /Widths [10 10] /Resources << >> >>", "latin1"),
        Buffer.from(`<< /${names[0]} 7 0 R /${names[1]} 7 0 R >>`, "latin1"),
        streamObject(escapedCharProc),
      ]);
    }

    async function inspectEscapedNames(names) {
      const bytes = buildEscapedNamePdf(names);
      const pdfLibDocument = await PDFDocument.load(bytes, { ignoreEncryption: true, updateMetadata: false });
      const packageDirectory = path.dirname(require.resolve("pdfjs-dist/package.json"));
      const pdfjsLib = await import("pdfjs-dist/legacy/build/pdf.mjs");
      const document = await pdfjsLib.getDocument({
        data: bytes,
        useWorkerFetch: false,
        isEvalSupported: false,
        cMapUrl: pdfjsFactoryDirectory(path.join(packageDirectory, "cmaps")),
        cMapPacked: true,
        standardFontDataUrl: pdfjsFactoryDirectory(path.join(packageDirectory, "standard_fonts")),
      }).promise;
      try {
        const page = await document.getPage(1);
        const [textContent, operators] = await Promise.all([
          page.getTextContent({ includeMarkedContent: false, disableNormalization: false }),
          page.getOperatorList(),
        ]);
        const inventory = inspectType3GlyphEvidenceForPage({
          textContent,
          operators,
          pdfjsPage: page,
          pdfLibPage: pdfLibDocument.getPage(0),
          pdfjsLib,
        });
        return {
          occurrence_count: inventory.occurrences.length,
          digests: inventory.occurrences.map(occurrence => occurrence.glyph_sha256),
          unlinked: inventory.omissions
            .filter(omission => omission.reason === "raw_type3_font_link_ambiguous_or_unavailable")
            .reduce((total, omission) => total + omission.count, 0),
        };
      } finally {
        await document.destroy();
      }
    }

    it("links a font whose names are plain and keys both drawn glyphs", async () => {
      // Positive control: no escape anywhere, so nothing below can pass
      // because the fixture never links in the first place.
      const plain = await inspectEscapedNames(["upright", "sibling"]);
      expect(plain.unlinked).toBe(0);
      expect(plain.occurrence_count).toBe(2);
      expect(plain.digests.every(digest => typeof digest === "string" && digest.length === 64)).toBe(true);
    });

    it("links a font whose names are lowercase hex escapes pdf-lib leaves undecoded", async () => {
      const escaped = await inspectEscapedNames(["#0b", "#0c"]);
      expect(escaped.unlinked).toBe(0);
      expect(escaped.occurrence_count).toBe(2);
      // Same font, same rasters: resolving the name must not change what the
      // glyph keys to, only whether the font can be found at all.
      const plain = await inspectEscapedNames(["upright", "sibling"]);
      expect(escaped.digests).toEqual(plain.digests);
    });

    it("links a font whose names really are three characters beginning with a hash", async () => {
      // `/#230b` is an escaped hash, so the glyph's name is `#0b`. pdf-lib and
      // PDF.js already agree here; re-unescaping the residual would break it.
      const literal = await inspectEscapedNames(["#230b", "#230c"]);
      expect(literal.unlinked).toBe(0);
      expect(literal.occurrence_count).toBe(2);
    });

    it("keys nothing when one code's two readings both name a CharProcs entry", async () => {
      // A font that writes /#230b for one code and /#0b for another gives
      // pdf-lib the same string, `#0b`, for the first, whose two readings then
      // both exist in /CharProcs. Which raster belongs to the code is no longer
      // decidable, so no digest is offered for it.
      const collided = await inspectEscapedNames(["#230b", "#0b"]);
      expect(collided.occurrence_count).toBe(2);
      expect(collided.digests[0]).toBeNull();
    });
  });

  it("keeps ordinary punctuation and already-correct Unicode byte-for-byte unchanged", async () => {
    const { result } = await runFake([{ items: [textItem({ text: "!:=,-−", x: 20, top: 20 })] }]);
    const item = result.pages[0].raw_items[0];
    expect(item.text).toBe("!:=,-−");
    expect(item).not.toHaveProperty("source_text");
    expect(item).not.toHaveProperty("glyph_recoveries");
  });

  it("binds the generated labeled reference to its checked-in provenance", async () => {
    const fixture = path.join(REPO_ROOT, "test/fixtures/eval/extraction/type3-cm-reference.pdf");
    const module = path.join(REPO_ROOT, "server/type3-cm-reference.js");
    const shareModule = path.join(REPO_ROOT, "pdf-toolkit-mcp-share/server/type3-cm-reference.js");
    const provenance = JSON.parse(await fs.readFile(
      path.join(REPO_ROOT, "test/fixtures/eval/extraction/type3-cm-reference.provenance.json"),
      "utf8",
    ));
    const digest = bytes => createHash("sha256").update(bytes).digest("hex");
    expect(digest(await fs.readFile(fixture))).toBe(provenance.outputs["test/fixtures/eval/extraction/type3-cm-reference.pdf"]);
    expect(digest(await fs.readFile(module))).toBe(provenance.outputs["server/type3-cm-reference.js"]);
    expect(digest(await fs.readFile(shareModule))).toBe(provenance.outputs["pdf-toolkit-mcp-share/server/type3-cm-reference.js"]);
    expect(provenance.reviewed_slot_labels["computer-modern-math-italic"][33]).toBe("omega");
    expect(provenance.reviewed_slot_labels["computer-modern-math-symbol"][0]).toBe("minus");
    expect(provenance.reviewed_slot_labels["computer-modern-math-symbol"][6]).toBe("plus-or-minus");
    expect(provenance.reviewed_slot_labels["computer-modern-math-symbol"][33]).toBe("right-arrow");
    // The fixture is the labeled artifact, so what it actually draws is pinned
    // separately from what has been reviewed. Enrolling a slot must not quietly
    // imply this PDF demonstrates it. Both slot sets are measured out of the
    // emitted PDF by the generator, so this checks them against the shipped
    // encoding tables rather than against a second copy of the same numbers:
    // a wrong literal in the provenance cannot satisfy CM_CODEPOINTS.
    const families = Object.keys(CM_CODEPOINTS);
    expect(families).toEqual([
      "computer-modern-math-italic",
      "computer-modern-math-symbol",
      "computer-modern-math-extension",
    ]);
    expect(Object.keys(provenance.fixture_drawn_slots)).toEqual(families);
    for (const family of families) {
      const enrolled = Object.keys(CM_CODEPOINTS[family]).map(Number).sort((left, right) => left - right);
      const drawnSlots = provenance.fixture_drawn_slots[family];
      const undrawableSlots = provenance.fixture_undrawable_slots[family];
      // Every enrolled slot is accounted for exactly once: either the fixture
      // draws it, or the CTAN ps-type3 widths cannot co-draw it without
      // costing its font a family. Neither list may quietly lose a slot.
      expect([...drawnSlots, ...undrawableSlots].sort((left, right) => left - right)).toEqual(enrolled);
      // As of this revision the fixture draws all of them: the family's slots
      // are partitioned across several embedded fonts, so nothing is left over.
      expect(undrawableSlots).toEqual([]);
      expect(drawnSlots).toEqual(enrolled);
      expect(Object.keys(provenance.reviewed_slot_labels[family]).map(Number).sort((left, right) => left - right))
        .toEqual(enrolled);
      expect(drawnSlots.length).toBeGreaterThan(1);
      // Drawn is still not the same claim as resolved. It happens to hold for
      // every drawn slot in this revision, which has to be asserted rather
      // than assumed, and is re-measured from the PDF itself in
      // test/type3-glyph-inventory.test.js.
      expect(provenance.fixture_family_resolving_slots[family]).toEqual(drawnSlots);
    }
    // Coarse regression guard on the size of the demonstration, so a
    // regenerated fixture that silently drew fewer slots would fail here.
    expect(Object.values(provenance.fixture_drawn_slots).flat()).toHaveLength(41);
    // Both were corroboration-only until a reviewed raster backed them. They are
    // enrolled now, and an enrolled codepoint is still usable as a witness, so
    // no slot is witness-only.
    expect(CM_WITNESS_CODEPOINTS["computer-modern-math-symbol"]).toBeUndefined();
    expect(CM_CODEPOINTS["computer-modern-math-symbol"][6]).toBe("±");
    expect(CM_CODEPOINTS["computer-modern-math-symbol"][33]).toBe("→");
  });
});

function multiply(left, right) {
  return [
    left[0] * right[0] + left[2] * right[1],
    left[1] * right[0] + left[3] * right[1],
    left[0] * right[2] + left[2] * right[3],
    left[1] * right[2] + left[3] * right[3],
    left[0] * right[4] + left[2] * right[5] + left[4],
    left[1] * right[4] + left[3] * right[5] + left[5],
  ];
}

function textItem({ text, x, top, width = 60, direction = "ltr", hasEOL = true, transform = null }) {
  return {
    str: text,
    dir: direction,
    width,
    height: 12,
    transform: transform ?? [12, 0, 0, 12, x, 792 - top - 12],
    fontName: "f1",
    hasEOL,
  };
}

function rectPath(paintOp, x = 10, y = 20, width = 20, height = 30) {
  return [
    paintOp,
    [new Float32Array([0, x, y, 1, x + width, y, 1, x + width, y + height, 1, x, y + height, 4])],
    new Float32Array([x, y, x + width, y + height]),
  ];
}

function linePath(paintOp, x1, y1, x2, y2) {
  return [
    paintOp,
    [new Float32Array([0, x1, y1, 1, x2, y2])],
    new Float32Array([Math.min(x1, x2), Math.min(y1, y2), Math.max(x1, x2), Math.max(y1, y2)]),
  ];
}

function curvePath(paintOp) {
  return [
    paintOp,
    [new Float32Array([0, 10, 20, 2, 20, 30, 30, 40, 50, 60])],
    new Float32Array([10, 20, 50, 60]),
  ];
}

function fakeOperatorFixture(operations, argsArray) {
  return { operations, argsArray };
}

async function pdfBytes(pageCount = 1) {
  const document = await PDFDocument.create();
  for (let index = 0; index < pageCount; index += 1) document.addPage([612, 792]);
  return document.save({ useObjectStreams: false });
}

function fakePdfjs(pageConfigs, { requiredPassword = null, neverLoad = false } = {}) {
  const state = { loading_destroyed: false, document_destroyed: false, page_cleanups: 0, document_options: null };
  const pages = pageConfigs.map(config => ({
    view: config.view ?? [0, 0, 612, 792],
    userUnit: config.userUnit ?? 1,
    rotate: config.rotate ?? 0,
    getViewport: () => config.viewport ?? { scale: 1, width: 612, height: 792, transform: [1, 0, 0, -1, 0, 792] },
    getTextContent: async () => {
      if (config.textError) throw config.textError;
      return {
        items: config.items ?? [],
        styles: config.styles ?? { f1: { fontFamily: "Test Sans", ascent: 0.8, descent: -0.2, vertical: false } },
      };
    },
    getOperatorList: async () => {
      if (config.operatorError) throw config.operatorError;
      return {
        fnArray: config.operations ?? [],
        argsArray: config.argsArray ?? config.operatorArgs ?? (config.operations ?? []).map(() => null),
      };
    },
    getAnnotations: async () => {
      if (config.annotationError) throw config.annotationError;
      return config.annotations ?? [];
    },
    cleanup: () => { state.page_cleanups += 1; },
  }));
  const pdfjs = {
    version: "5.4.624",
    PasswordResponses: { NEED_PASSWORD: 1, INCORRECT_PASSWORD: 2 },
    OPS: {
      save: 10,
      restore: 11,
      transform: 12,
      clip: 29,
      eoClip: 30,
      paintFormXObjectBegin: 74,
      paintFormXObjectEnd: 75,
      paintImageXObject: 1,
      paintJpegXObject: 5,
      paintImageMaskXObject: 6,
      paintImageMaskXObjectGroup: 7,
      paintInlineImageXObject: 8,
      paintInlineImageXObjectGroup: 9,
      paintImageXObjectRepeat: 13,
      paintImageMaskXObjectRepeat: 14,
      constructPath: 2,
      stroke: 4,
      closeStroke: 15,
      fill: 3,
      eoFill: 16,
      fillStroke: 17,
      eoFillStroke: 18,
      closeFillStroke: 19,
      closeEOFillStroke: 20,
      endPath: 21,
      paintSolidColorImageMask: 76,
    },
    Util: { transform: multiply },
    getDocument: documentOptions => {
      state.document_options = documentOptions;
      const { password } = documentOptions;
      const loadingTask = {
        destroy: async () => { state.loading_destroyed = true; },
      };
      if (neverLoad) loadingTask.promise = new Promise(() => {});
      else if (requiredPassword !== null && password !== requiredPassword) {
        const error = new Error("Synthetic password failure");
        error.name = "PasswordException";
        error.code = password ? 2 : 1;
        loadingTask.promise = Promise.reject(error);
      } else {
        loadingTask.promise = Promise.resolve({
          numPages: pages.length,
          getPage: async pageNumber => pages[pageNumber - 1],
          destroy: async () => { state.document_destroyed = true; },
        });
      }
      return loadingTask;
    },
  };
  return { pdfjs, state };
}

function instrumentRealPdfjs(actualPdfjs) {
  const state = { loading_destroyed: 0, document_destroyed: 0, page_cleanups: 0 };
  const bind = (target, value) => typeof value === "function" ? value.bind(target) : value;
  const wrapPage = page => new Proxy(page, {
    get(target, property) {
      if (property === "cleanup") {
        return (...args) => {
          state.page_cleanups += 1;
          return target.cleanup(...args);
        };
      }
      return bind(target, Reflect.get(target, property, target));
    },
  });
  const wrapDocument = document => new Proxy(document, {
    get(target, property) {
      if (property === "getPage") return async pageNumber => wrapPage(await target.getPage(pageNumber));
      if (property === "destroy") {
        return async (...args) => {
          state.document_destroyed += 1;
          return target.destroy(...args);
        };
      }
      return bind(target, Reflect.get(target, property, target));
    },
  });
  return {
    state,
    pdfjs: {
      ...actualPdfjs,
      getDocument(options) {
        const loadingTask = actualPdfjs.getDocument(options);
        return new Proxy(loadingTask, {
          get(target, property) {
            if (property === "promise") return target.promise.then(wrapDocument);
            if (property === "destroy") {
              return async (...args) => {
                state.loading_destroyed += 1;
                return target.destroy(...args);
              };
            }
            return bind(target, Reflect.get(target, property, target));
          },
        });
      },
    },
  };
}

function completeErrorSurface(error) {
  if (!error) return null;
  return {
    name: error.name,
    message: error.message,
    stack: error.stack,
    code: error.code,
    data: error.data,
    cause: completeErrorSurface(error.cause),
    enumerable: { ...error },
  };
}

async function runFake(pageConfigs, options = {}) {
  const bytes = options.pdfBytes ?? await pdfBytes(pageConfigs.length);
  const { pdfjs, state } = fakePdfjs(pageConfigs, options.fakeOptions);
  const result = await extractPdfLayout({
    pdfjsLib: pdfjs,
    pdfBytes: bytes,
    sourcePath: "/synthetic/fake.pdf",
    sourceFileName: "fake.pdf",
    sourceSha256: createHash("sha256").update(bytes).digest("hex"),
    requestedStartPage: options.startPage ?? 1,
    requestedEndPage: options.endPage ?? pageConfigs.length,
    maxItems: options.maxItems ?? 1000,
    maxCharacters: options.maxCharacters ?? 50000,
    maxOutputCharacters: options.maxOutputCharacters ?? 200000,
    deadlineMs: options.deadlineMs ?? 20000,
    password: options.password ?? null,
  });
  return { result, state, bytes };
}

function shiftPageGeometryX(page, delta) {
  for (const item of page.raw_items) {
    item.quad = item.quad.map(point => ({ ...point, x: point.x + delta }));
    item.bbox.x += delta;
    item.x += delta;
  }
  for (const line of page.lines) line.x += delta;
  page.spatial_text = page.lines
    .map(line => `[${line.id} x=${line.x} y=${line.y} w=${line.width} h=${line.height}] ${line.text}`)
    .join("\n");
}

describe("PDF.js factory directory contract", () => {
  it("always ends factory directories with a forward slash, including Windows-shaped paths", () => {
    // PDF.js validates factory URLs with a literal .endsWith("/") check, so
    // the backslash-terminated paths fileURLToPath yields on Windows failed
    // it and broke every layout operation on win32 (caught by the Windows
    // runtime CI lane, run 30670798499).
    expect(pdfjsFactoryDirectory("C:\\Users\\runner\\ext\\node_modules\\pdfjs-dist\\cmaps\\"))
      .toBe("C:/Users/runner/ext/node_modules/pdfjs-dist/cmaps/");
    expect(pdfjsFactoryDirectory("C:\\ext\\cmaps")).toBe("C:/ext/cmaps/");
    expect(pdfjsFactoryDirectory("/opt/ext/node_modules/pdfjs-dist/cmaps/"))
      .toBe("/opt/ext/node_modules/pdfjs-dist/cmaps/");
    expect(pdfjsFactoryDirectory("/opt/ext/cmaps")).toBe("/opt/ext/cmaps/");
    for (const value of [
      pdfjsFactoryDirectory("C:\\a\\b\\"),
      pdfjsFactoryDirectory("/a/b"),
    ]) {
      expect(value.endsWith("/")).toBe(true);
      expect(value.includes("\\")).toBe(false);
    }
  });
});

describe("Extraction IR v1.2.0 evidence blocks", () => {
  it("captures only normalized stroke-bearing axis-aligned ruling segments with typed cap accounting", async () => {
    const basic = await runFake([fakeOperatorFixture(
      [2, 2, 2, 2, 2],
      [
        linePath(4, 30, 40, 10, 40),
        linePath(4, 20, 60, 20, 20),
        linePath(4, 10.2, 40.2, 30.2, 40.2),
        linePath(4, 10, 10, 30, 30),
        curvePath(4),
      ],
    )]);
    expect(basic.result.pages[0].ruling_segments).toEqual({
      status: "available",
      truncated: false,
      observed_count: 2,
      returned_count: 2,
      items: [
        { orientation: "horizontal", x1: 10, y1: 752, x2: 30, y2: 752, source_operator_index: 0 },
        { orientation: "vertical", x1: 20, y1: 732, x2: 20, y2: 772, source_operator_index: 1 },
      ],
    });

    const nearAxis = await runFake([fakeOperatorFixture(
      [2, 2],
      [
        linePath(4, 10.0004, 40.0004, 30.0004, 39.5004),
        linePath(4, 20.0004, 60.0004, 20.5004, 20.0004),
      ],
    )]);
    expect(nearAxis.result.pages[0].ruling_segments.items).toEqual([
      { orientation: "horizontal", x1: 10, y1: 752.25, x2: 30, y2: 752.25, source_operator_index: 0 },
      { orientation: "vertical", x1: 20.25, y1: 732, x2: 20.25, y2: 772, source_operator_index: 1 },
    ]);
    for (const segment of nearAxis.result.pages[0].ruling_segments.items) {
      if (segment.orientation === "horizontal") {
        expect(segment.y1).toBe(segment.y2);
        expect(segment.x2 - segment.x1).toBeGreaterThanOrEqual(2);
      } else {
        expect(segment.x1).toBe(segment.x2);
        expect(segment.y2 - segment.y1).toBeGreaterThanOrEqual(2);
      }
    }

    const operations = [];
    const argsArray = [];
    for (let index = 0; index < 1025; index += 1) {
      operations.push(2);
      argsArray.push(linePath(4, 10, index * 0.6, 20, index * 0.6));
    }
    const capped = await runFake([fakeOperatorFixture(operations, argsArray)]);
    expect(capped.result.pages[0].ruling_segments).toMatchObject({
      status: "available",
      truncated: true,
      observed_count: 1025,
      returned_count: 1024,
    });
    expect(capped.result.pages[0].ruling_segments.items).toHaveLength(1024);

    const outputBounded = await runFake(
      [fakeOperatorFixture(operations, argsArray)],
      { maxOutputCharacters: 20000 },
    );
    expect(outputBounded.result.pages[0].ruling_segments).toEqual({
      status: "unavailable",
      truncated: true,
      observed_count: 1025,
      returned_count: 0,
      items: [],
    });
    expect(JSON.stringify(outputBounded.result).length).toBeLessThanOrEqual(20000);
  });

  it("tracks CTM/Form scopes, classifies paints, drops degenerate paths, deduplicates, and counts operators", async () => {
    const fixture = fakeOperatorFixture(
      [10, 12, 2, 11, 74, 2, 75, 29, 2, 1, 5, 13, 2],
      [
        null,
        [2, 0, 0, 2, 10, 20],
        rectPath(3),
        null,
        [new Float32Array([1, 0, 0, 1, 50, 60]), null],
        rectPath(4, 10, 20, 20, 30),
        [],
        null,
        rectPath(21, 10, 20, 20, 30),
        null,
        null,
        null,
        rectPath(3, 10, 20, 4, 30),
      ],
    );
    const { result } = await runFake([fixture]);
    const page = result.pages[0];
    expect(page.ruled_rects).toMatchObject({ status: "available", observed_count: 3, returned_count: 3 });
    expect(page.ruled_rects.items.map(item => item.verb)).toEqual(["fill", "stroke", "clip"]);
    expect(page.ruled_rects.items[0]).toEqual({ x: 30, y: 672, width: 40, height: 60, verb: "fill" });
    expect(page.ruled_rects.items[1]).toEqual({ x: 60, y: 682, width: 20, height: 30, verb: "stroke" });
    expect(page.ruled_rects.items[2]).toEqual({ x: 10, y: 742, width: 20, height: 30, verb: "clip" });
    expect(page.operator_counts).toEqual({ image_paint_ops: 3, path_segments: 20, path_construct_ops: 4 });
  });

  it("treats a matrix-less Form XObject as identity instead of failing the page", async () => {
    const fixture = fakeOperatorFixture(
      [74, 2, 75],
      [
        [null, null],
        rectPath(3, 30, 40, 20, 30),
        null,
      ],
    );
    const { result } = await runFake([fixture]);
    const page = result.pages[0];
    expect(page.ruled_rects).toMatchObject({ status: "available", observed_count: 1, returned_count: 1 });
    expect(page.ruled_rects.items[0]).toEqual({ x: 30, y: 722, width: 20, height: 30, verb: "fill" });
    expect(page.errors.some(error => error.stage === "ruled_rects")).toBe(false);
  });

  it("retains source-bound ruled rectangles outside the visible viewport", async () => {
    const fixture = fakeOperatorFixture([2], [rectPath(3, -20, 20, 10, 10)]);
    const { result, bytes } = await runFake([fixture]);
    expect(result.pages[0].ruled_rects.items).toEqual([
      { x: -20, y: 762, width: 10, height: 10, verb: "fill" },
    ]);

    const validated = validateStructuredToolResult("read_pdf_layout", {
      content: [{ type: "text", text: "signed ruled-rectangle viewport origin" }],
      structuredContent: result,
    });
    expect(validated.structuredContent).toEqual(result);

    const { pdfjs } = fakePdfjs([fixture]);
    await expect(validatePdfLayoutSourceEvidence(result, { pdfjsLib: pdfjs, sourceBytes: bytes }))
      .resolves.toEqual(result);
  });

  it("accepts an annotations-stage page error through structured-output validation (zyx.8)", async () => {
    const { result } = await runFake([{ items: [], annotationError: new Error("synthetic annotation failure") }]);
    const annotationEntry = result.pages[0].errors.find(error => error.stage === "annotations");
    expect(annotationEntry).toMatchObject({ stage: "annotations", message: "synthetic annotation failure" });
    const validated = validateStructuredToolResult("read_pdf_layout", {
      content: [{ type: "text", text: "annotation-stage regression" }],
      structuredContent: result,
    });
    expect(validated.structuredContent).toEqual(result);
  });

  it("leaves the CTM unchanged when restore underflows", async () => {
    const fixture = fakeOperatorFixture(
      [12, 11, 2],
      [
        [2, 0, 0, 2, 10, 20],
        null,
        rectPath(3),
      ],
    );
    const { result } = await runFake([fixture]);
    expect(result.pages[0].ruled_rects.items).toEqual([
      { x: 30, y: 672, width: 40, height: 60, verb: "fill" },
    ]);
  });

  it("keeps an unmatched restore inside a Form XObject from escaping its outer CTM", async () => {
    const fixture = fakeOperatorFixture(
      [12, 74, 11, 75, 2],
      [
        [2, 0, 0, 2, 10, 20],
        [new Float32Array([1, 0, 0, 1, 50, 60]), null],
        null,
        null,
        rectPath(3),
      ],
    );
    const { result } = await runFake([fixture]);
    expect(result.pages[0].ruled_rects.items).toEqual([
      { x: 30, y: 672, width: 40, height: 60, verb: "fill" },
    ]);
  });

  it("deduplicates on the half-point grid and reports a self-contained cap", async () => {
    const duplicateFixture = fakeOperatorFixture(
      [2, 2, 2],
      [rectPath(3), rectPath(3, 10.2, 20.2, 20.2, 30.2), rectPath(3, 10, 20, 4, 30)],
    );
    const deduplicated = await runFake([duplicateFixture]);
    expect(deduplicated.result.pages[0].ruled_rects).toMatchObject({
      status: "available",
      observed_count: 1,
      returned_count: 1,
    });

    const operations = [];
    const argsArray = [];
    for (let index = 0; index < 513; index += 1) {
      operations.push(2);
      argsArray.push(rectPath(3, 10 + (index % 32) * 8, 20 + Math.floor(index / 32) * 8, 6, 6));
    }
    const capped = await runFake([fakeOperatorFixture(operations, argsArray)]);
    const rects = capped.result.pages[0].ruled_rects;
    expect(rects.status).toBe("truncated");
    expect(rects.observed_count).toBe(513);
    expect(rects.returned_count).toBe(512);
    expect(rects.items).toHaveLength(512);
    expect(capped.result.pages[0].errors).toEqual([
      expect.objectContaining({ stage: "ruled_rects", code: "RULED_RECT_PAGE_LIMIT" }),
    ]);
  });

  it("applies text-integrity thresholds over raw PDF.js item text", async () => {
    const run = async text => (await runFake([{ items: [textItem({ text, x: 50, top: 50 })] }])).result.pages[0].text_integrity;
    const runItems = async texts => (await runFake([{ items: texts.map((text, index) => textItem({ text, x: 50, top: 50 + index * 20 })) }])).result.pages[0].text_integrity;
    expect((await run("\uFFFD")).status).toBe("ok");
    expect((await run("\uFFFD\uFFFD"))).toMatchObject({ status: "suspect", signals: [{ kind: "replacement_characters", count: 2 }] });
    expect((await run(`\uFFFD\uFFFD${"a".repeat(78)}`)).status).toBe("suspect");
    expect((await run(`\uFFFD\uFFFD${"a".repeat(79)}`)).status).toBe("ok");
    expect((await run(`${"\uFFFDa".repeat(12)}${"b".repeat(216)}`)).status).toBe("suspect");
    expect((await run(`${"\uFFFDa".repeat(12)}${"b".repeat(217)}`)).status).toBe("ok");
    expect((await run("\uE000\uE001\uE002ab")).status).toBe("suspect");
    expect((await run("\uE000abcd")).status).toBe("ok");
    expect((await run("\uE000a\uE001bc")).status).toBe("ok");
    expect((await run("\uE000a\uE001b\uE002c")).status).toBe("suspect");
    expect((await run("\uE000a\uE001bcd")).status).toBe("ok");
    expect((await run("\uE000a\uE001b\uE002")).status).toBe("suspect");
    expect((await run("\uE000a\uE001\uE002")).status).toBe("ok");
    expect((await run("aa\u0080\u0081")).status).toBe("ok");
    expect((await run("aaa\u0080\u0081")).status).toBe("suspect");
    expect((await run("abcd\u0080")).status).toBe("ok");
    expect((await run("abc\u0080\u0081")).status).toBe("suspect");
    expect((await run(`${"a".repeat(38)}\u0080\u0081`)).status).toBe("suspect");
    expect((await run(`${"a".repeat(39)}\u0080\u0081`)).status).toBe("ok");
    expect((await runItems([
      `\uFFFD\uFFFD${"a".repeat(38)}`,
      `\uFFFD\uFFFD${"a".repeat(37)}`,
      `\uFFFD\uFFFD${"a".repeat(37)}`,
    ])).status).toBe("suspect");
    expect((await runItems([
      `\uFFFD\uFFFD${"a".repeat(38)}`,
      `\uFFFD\uFFFD${"a".repeat(37)}`,
      `\uFFFD\uFFFD${"a".repeat(38)}`,
    ])).status).toBe("ok");
    expect((await run(`${"\uFFFD".repeat(8)}${"a".repeat(312)}`)).status).toBe("suspect");
    expect((await run(`${"\uFFFD".repeat(8)}${"a".repeat(313)}`)).status).toBe("ok");
    expect((await run("!".repeat(50))).signals).toEqual([{ kind: "non_alphanumeric_dominance", count: 1 }]);
    expect((await run(".".repeat(50))).status).toBe("ok");
    expect((await run(`${"a".repeat(27)}${"!".repeat(27)}._·`)).status).toBe("ok");
    expect((await run(`${"a".repeat(27)}${"!".repeat(27)}._`)).status).toBe("suspect");
  });

  it("rejects independent replay forgeries for every new evidence block and is deterministic", async () => {
    const fixture = fakeOperatorFixture([2, 1], [rectPath(4), null]);
    const sourceBytes = await pdfBytes(1);
    const page = { ...fixture, items: [textItem({ text: "evidence", x: 50, top: 50 })] };
    const first = await runFake([page], { pdfBytes: sourceBytes });
    const second = await runFake([page], { pdfBytes: sourceBytes });
    expect(second.result).toEqual(first.result);
    const mutations = [
      layout => { layout.pages[0].ruled_rects.items[0].x += 1; },
      layout => { layout.pages[0].ruling_segments.items[0].x1 += 1; },
      layout => { layout.pages[0].text_integrity.status = "suspect"; },
      layout => { layout.pages[0].operator_counts.path_segments += 1; },
    ];
    for (const mutate of mutations) {
      const forged = structuredClone(first.result);
      mutate(forged);
      const { pdfjs } = fakePdfjs([{ ...fixture, items: [textItem({ text: "evidence", x: 50, top: 50 })] }]);
      await expect(validatePdfLayoutSourceEvidence(forged, { pdfjsLib: pdfjs, sourceBytes: first.bytes }))
        .rejects.toThrow(/dedicated operator evidence|text-integrity evidence/);
    }
  });
});

describe("read_pdf_layout MCP tool", () => {
  let client;
  let transport;
  let temporaryRoot;

  beforeAll(async () => {
    temporaryRoot = await fs.mkdtemp(path.join(os.tmpdir(), "pdf-tools-layout-"));
    transport = new StdioClientTransport({
      command: process.execPath,
      args: [path.join(REPO_ROOT, "server/index.js")],
      cwd: REPO_ROOT,
      env: { ALLOWED_DIRECTORIES: [REPO_ROOT, temporaryRoot].join(path.delimiter) },
      stderr: "ignore",
    });
    client = new Client({ name: "pdf-layout-test", version: "1.0.0" });
    await client.connect(transport);
  }, 30_000);

  afterAll(async () => {
    await client?.close();
    await transport?.close();
    await fs.rm(temporaryRoot, { recursive: true, force: true });
  });

  it("discovers a strict read-only v1 contract and returns deterministic bytes and IDs", async () => {
    const { tools } = await client.listTools();
    const tool = tools.find(entry => entry.name === "read_pdf_layout");
    expect(tool).toMatchObject({
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
      outputSchema: TOOL_OUTPUT_SCHEMAS.read_pdf_layout,
    });
    const request = { name: "read_pdf_layout", arguments: { pdf_path: TWO_COLUMN, max_output_characters: 200000 } };
    const first = await client.callTool(request);
    const second = await client.callTool(request);
    expect(first.isError).not.toBe(true);
    expect(JSON.stringify(first.structuredContent)).toBe(JSON.stringify(second.structuredContent));
    expect(first.structuredContent).toMatchObject({
      ir: { name: "pdf-tools.extraction-ir", version: "1.6.0" },
      parser: { name: "pdfjs-dist", version: "5.4.624" },
      source: { sha256: expect.stringMatching(/^[a-f0-9]{64}$/) },
      id_scope: {
        kind: "source_parser_ir_options",
        source_sha256: expect.stringMatching(/^[a-f0-9]{64}$/),
        parser_version: "5.4.624",
        ir_version: "1.6.0",
        max_output_characters: 200000,
      },
      page_range: { requested_start_page: 1, requested_end_page: 1, start_page: 1, end_page: 1, total_pages: 1 },
    });
    expect(first.structuredContent.source.size_bytes).toBe((await fs.stat(TWO_COLUMN)).size);
    expect(first.structuredContent.source.sha256).toBe(
      createHash("sha256").update(await fs.readFile(TWO_COLUMN)).digest("hex"),
    );
    const rawItems = first.structuredContent.pages[0].raw_items;
    expect(rawItems.map(item => item.source_index)).toEqual([...rawItems.keys()]);
    expect(new Set(rawItems.map(item => item.id)).size).toBe(rawItems.length);
    expect(first.content[0].text).toContain("not interchangeable with render_pdf_region or signing coordinates");
    expect(first.structuredContent.pages[0].flow_text.split("\n")).toEqual([
      "TWO COLUMN NOTICE",
      "LEFT-1 Coverage begins July 1.",
      "LEFT-2 Claims close July 31.",
      "RIGHT-1 Review starts August 2.",
      "RIGHT-2 Decision follows review.",
    ]);
  });

  it("keeps mixed image-only candidates and visual-inspection gaps explicit", async () => {
    const result = await client.callTool({
      name: "read_pdf_layout",
      arguments: { pdf_path: MIXED, start_page: 1, end_page: 2, max_output_characters: 200000 },
    });
    expect(result.structuredContent.extraction_status).toBe("partial");
    expect(result.structuredContent.pages[0]).toMatchObject({ text_layer_status: "present" });
    expect(result.structuredContent.pages[1]).toMatchObject({
      text_layer_status: "empty",
      modality_hint: "image-only-candidate",
      extraction_status: "partial",
      needs_visual_inspection: true,
    });
    expect(result.structuredContent.pages[1].limitations.join(" ")).toContain("not raster-content proof");
  });

  it("preserves rotated CropBox and PDF.js viewport geometry without coordinate aliasing", async () => {
    const result = await client.callTool({ name: "read_pdf_layout", arguments: { pdf_path: ROTATED_CROP, max_output_characters: 200000 } });
    const page = result.structuredContent.pages[0];
    expect(page.geometry).toEqual({
      page: 1,
      media_box: { x: 0, y: 0, width: 480, height: 360 },
      crop_box: { x: 20, y: 24, width: 430, height: 300 },
      pdfjs_view: [20, 24, 450, 324],
      user_unit: 1,
      raw_pdf_rotation: 90,
      display_rotation: 90,
      rotation_matches_raw: true,
      display_width: 300,
      display_height: 430,
      viewport_transform: [0, 1, 1, 0, -24, -20],
      raw_page_space: { basis: "pdf_default_user_space", unit: "pdf_user_unit", stage: "before_user_unit_and_page_rotation" },
      item_space: { origin: "top_left", unit: "points_1_72_in_after_user_unit", reference_box: "pdfjs_display_viewport" },
    });
    for (const point of page.raw_items[0].quad) {
      expect(point.x).toBeGreaterThanOrEqual(0);
      expect(point.x).toBeLessThanOrEqual(page.geometry.display_width);
      expect(point.y).toBeGreaterThanOrEqual(0);
      expect(point.y).toBeLessThanOrEqual(page.geometry.display_height);
    }
  });

  it("binds hand-audited real-PDF item geometry across rotations, CropBox, and UserUnit", async () => {
    const document = await PDFDocument.create();
    const font = await document.embedFont(StandardFonts.Helvetica);
    for (const rotation of [0, 90, 180, 270]) {
      const page = document.addPage([200, 300]);
      page.setRotation(degrees(rotation));
      page.drawText("X", { x: 72, y: 100, size: 12, font });
    }
    const offset = document.addPage([420, 540]);
    offset.setMediaBox(10, 20, 400, 500);
    offset.setCropBox(30, 40, 300, 400);
    offset.node.set(PDFName.of("UserUnit"), PDFNumber.of(2));
    offset.drawText("X", { x: 72, y: 100, size: 12, font });
    const offsetUnit1 = document.addPage([420, 540]);
    offsetUnit1.setMediaBox(10, 20, 400, 500);
    offsetUnit1.setCropBox(30, 40, 300, 400);
    offsetUnit1.drawText("X", { x: 72, y: 100, size: 12, font });
    for (const [rotation, userUnit] of [[0, 1], [90, 1.3335], [180, 1.9995], [270, 2]]) {
      const hostile = document.addPage([400, 500]);
      hostile.setMediaBox(-100.5, -50.75, 400.75, 500.5);
      hostile.setCropBox(-80.125, -30.375, 300.5, 400.25);
      hostile.setRotation(degrees(rotation));
      hostile.node.set(PDFName.of("UserUnit"), PDFNumber.of(userUnit));
      hostile.drawText("X", { x: 72, y: 100, size: 12, font });
    }
    const fixture = path.join(temporaryRoot, "rotations-userunit.pdf");
    await fs.writeFile(fixture, await document.save({ useObjectStreams: false }));

    const rotations = await client.callTool({ name: "read_pdf_layout", arguments: { pdf_path: fixture, start_page: 1, end_page: 4, max_output_characters: 200000 } });
    // Independent arithmetic oracle, not a snapshot of read_pdf_layout:
    // PDF.js supplies raw [12, 0, 0, 12, 72, 100], width 8.004, height 12,
    // and ascent 0.905 after the contract's three-decimal normalization. Each
    // literal quad below is viewport * raw, with top offset 12 * 0.905 = 10.86.
    const expectedRotationGeometry = [
      {
        page: 1,
        rotation: 0,
        display_width: 200,
        display_height: 300,
        viewport_transform: [1, 0, 0, -1, 0, 300],
        quad: [{ x: 72, y: 189.14 }, { x: 80.004, y: 189.14 }, { x: 72, y: 201.14 }, { x: 80.004, y: 201.14 }],
        bbox: { x: 72, y: 189.14, width: 8.004, height: 12 },
      },
      {
        page: 2,
        rotation: 90,
        display_width: 300,
        display_height: 200,
        viewport_transform: [0, 1, 1, 0, 0, 0],
        quad: [{ x: 110.86, y: 72 }, { x: 110.86, y: 80.004 }, { x: 98.86, y: 72 }, { x: 98.86, y: 80.004 }],
        bbox: { x: 98.86, y: 72, width: 12, height: 8.004 },
      },
      {
        page: 3,
        rotation: 180,
        display_width: 200,
        display_height: 300,
        viewport_transform: [-1, 0, 0, 1, 200, 0],
        quad: [{ x: 128, y: 110.86 }, { x: 119.996, y: 110.86 }, { x: 128, y: 98.86 }, { x: 119.996, y: 98.86 }],
        bbox: { x: 119.996, y: 98.86, width: 8.004, height: 12 },
      },
      {
        page: 4,
        rotation: 270,
        display_width: 300,
        display_height: 200,
        viewport_transform: [0, -1, -1, 0, 300, 200],
        quad: [{ x: 189.14, y: 128 }, { x: 189.14, y: 119.996 }, { x: 201.14, y: 128 }, { x: 201.14, y: 119.996 }],
        bbox: { x: 189.14, y: 119.996, width: 12, height: 8.004 },
      },
    ];
    expect(rotations.isError).not.toBe(true);
    expect(rotations.structuredContent.parser).toEqual({ name: "pdfjs-dist", version: "5.4.624" });
    expect(rotations.structuredContent.pages).toHaveLength(4);
    for (const expected of expectedRotationGeometry) {
      const page = rotations.structuredContent.pages[expected.page - 1];
      expect(page.geometry).toEqual({
        page: expected.page,
        media_box: { x: 0, y: 0, width: 200, height: 300 },
        crop_box: { x: 0, y: 0, width: 200, height: 300 },
        pdfjs_view: [0, 0, 200, 300],
        user_unit: 1,
        raw_pdf_rotation: expected.rotation,
        display_rotation: expected.rotation,
        rotation_matches_raw: true,
        display_width: expected.display_width,
        display_height: expected.display_height,
        viewport_transform: expected.viewport_transform,
        raw_page_space: RAW_PAGE_SPACE,
        item_space: ITEM_SPACE,
      });
      expect(page.raw_items).toHaveLength(1);
      expect(page.raw_items[0]).toEqual(expect.objectContaining({
        text: "X",
        raw_transform: [12, 0, 0, 12, 72, 100],
        raw_width: 8.004,
        raw_height: 12,
        font: { family: "sans-serif", ascent: 0.905, descent: -0.212, vertical: false },
        geometry_kind: "pdfjs_text_run_advance_box",
        geometry_valid: true,
        bbox_status: "valid",
        geometry_provenance: HORIZONTAL_GEOMETRY_PROVENANCE,
        quad: expected.quad,
        bbox: expected.bbox,
        x: expected.bbox.x,
        y: expected.bbox.y,
        width: expected.bbox.width,
        height: expected.bbox.height,
        line_height: 12,
        direction: "ltr",
      }));
    }
    expect(rotations.structuredContent.limitations.join(" ")).toContain("not DOM TextLayer or glyph ink bounds");
    expect(rotations.structuredContent.limitations.join(" ")).toContain("not interchangeable with render_pdf_region or signing coordinates");

    const units = await client.callTool({ name: "read_pdf_layout", arguments: { pdf_path: fixture, start_page: 5, end_page: 6, max_output_characters: 200000 } });
    // UserUnit 2 doubles the viewport matrix, advance, font size, and ascent
    // offset. The UserUnit 1 page is the exact offset-CropBox control.
    const expectedUnitGeometry = [
      {
        page: 5,
        user_unit: 2,
        display_width: 600,
        display_height: 800,
        viewport_transform: [2, 0, 0, -2, -60, 880],
        quad: [{ x: 84, y: 658.28 }, { x: 100.008, y: 658.28 }, { x: 84, y: 682.28 }, { x: 100.008, y: 682.28 }],
        bbox: { x: 84, y: 658.28, width: 16.008, height: 24 },
        line_height: 24,
      },
      {
        page: 6,
        user_unit: 1,
        display_width: 300,
        display_height: 400,
        viewport_transform: [1, 0, 0, -1, -30, 440],
        quad: [{ x: 42, y: 329.14 }, { x: 50.004, y: 329.14 }, { x: 42, y: 341.14 }, { x: 50.004, y: 341.14 }],
        bbox: { x: 42, y: 329.14, width: 8.004, height: 12 },
        line_height: 12,
      },
    ];
    expect(units.isError).not.toBe(true);
    for (const [index, expected] of expectedUnitGeometry.entries()) {
      const page = units.structuredContent.pages[index];
      expect(page.geometry).toEqual({
        page: expected.page,
        media_box: { x: 10, y: 20, width: 400, height: 500 },
        crop_box: { x: 30, y: 40, width: 300, height: 400 },
        pdfjs_view: [30, 40, 330, 440],
        user_unit: expected.user_unit,
        raw_pdf_rotation: 0,
        display_rotation: 0,
        rotation_matches_raw: true,
        display_width: expected.display_width,
        display_height: expected.display_height,
        viewport_transform: expected.viewport_transform,
        raw_page_space: RAW_PAGE_SPACE,
        item_space: ITEM_SPACE,
      });
      expect(page.raw_items).toHaveLength(1);
      expect(page.raw_items[0]).toEqual(expect.objectContaining({
        text: "X",
        raw_transform: [12, 0, 0, 12, 72, 100],
        raw_width: 8.004,
        raw_height: 12,
        font: { family: "sans-serif", ascent: 0.905, descent: -0.212, vertical: false },
        geometry_provenance: HORIZONTAL_GEOMETRY_PROVENANCE,
        quad: expected.quad,
        bbox: expected.bbox,
        x: expected.bbox.x,
        y: expected.bbox.y,
        width: expected.bbox.width,
        height: expected.bbox.height,
        line_height: expected.line_height,
      }));
    }

    const hostile = await client.callTool({ name: "read_pdf_layout", arguments: { pdf_path: fixture, start_page: 7, end_page: 10, max_output_characters: 200000 } });
    // Independent literals for CropBox [-80.125, -30.375, 220.375,
    // 369.875]. The PDF stores UserUnit 1.3335 and 1.9995; the public IR
    // rounds the parser values to 1.333 and 2 before its arithmetic checks.
    const hostileExpected = [
      {
        page: 7, rotation: 0, user_unit: 1,
        display_width: 300.5, display_height: 400.25,
        viewport_transform: [1, 0, 0, -1, 80.125, 369.875],
        quad: [{ x: 152.125, y: 259.015 }, { x: 160.129, y: 259.015 }, { x: 152.125, y: 271.015 }, { x: 160.129, y: 271.015 }],
        bbox: { x: 152.125, y: 259.015, width: 8.004, height: 12 }, line_height: 12,
      },
      {
        page: 8, rotation: 90, user_unit: 1.333,
        display_width: 533.733, display_height: 400.717,
        viewport_transform: [0, 1.333, 1.333, 0, 40.505, 106.847],
        quad: [{ x: 188.281, y: 202.823 }, { x: 188.281, y: 213.492 }, { x: 172.285, y: 202.823 }, { x: 172.285, y: 213.492 }],
        bbox: { x: 172.285, y: 202.823, width: 15.996, height: 10.669 }, line_height: 15.996,
      },
      {
        page: 9, rotation: 180, user_unit: 2,
        display_width: 600.85, display_height: 800.3,
        viewport_transform: [-2, 0, 0, 2, 440.64, 60.735],
        quad: [{ x: 296.64, y: 282.455 }, { x: 280.632, y: 282.455 }, { x: 296.64, y: 258.455 }, { x: 280.632, y: 258.455 }],
        bbox: { x: 280.632, y: 258.455, width: 16.008, height: 24 }, line_height: 24,
      },
      {
        page: 10, rotation: 270, user_unit: 2,
        display_width: 800.5, display_height: 601,
        viewport_transform: [0, -2, -2, 0, 739.75, 440.75],
        quad: [{ x: 518.03, y: 296.75 }, { x: 518.03, y: 280.742 }, { x: 542.03, y: 296.75 }, { x: 542.03, y: 280.742 }],
        bbox: { x: 518.03, y: 280.742, width: 24, height: 16.008 }, line_height: 24,
      },
    ];
    expect(hostile.isError).not.toBe(true);
    for (const [index, expected] of hostileExpected.entries()) {
      const page = hostile.structuredContent.pages[index];
      expect(page.geometry).toEqual({
        page: expected.page,
        media_box: { x: -100.5, y: -50.75, width: 400.75, height: 500.5 },
        crop_box: { x: -80.125, y: -30.375, width: 300.5, height: 400.25 },
        pdfjs_view: [-80.125, -30.375, 220.375, 369.875],
        user_unit: expected.user_unit,
        raw_pdf_rotation: expected.rotation,
        display_rotation: expected.rotation,
        rotation_matches_raw: true,
        display_width: expected.display_width,
        display_height: expected.display_height,
        viewport_transform: expected.viewport_transform,
        raw_page_space: RAW_PAGE_SPACE,
        item_space: ITEM_SPACE,
      });
      expect(page.raw_items[0]).toEqual(expect.objectContaining({
        text: "X",
        raw_transform: [12, 0, 0, 12, 72, 100],
        raw_width: 8.004,
        raw_height: 12,
        quad: expected.quad,
        bbox: expected.bbox,
        x: expected.bbox.x,
        y: expected.bbox.y,
        width: expected.bbox.width,
        height: expected.bbox.height,
        line_height: expected.line_height,
      }));
    }

    const roundedSpan = 369.875 - (-30.375);
    const roundedScale = 1.333;
    const roundedExpectedWidth = roundedSpan * roundedScale;
    const roundingTolerance = 0.001 + Math.abs(roundedSpan) * 0.0005
      + Math.abs(roundedScale) * 0.001 + 0.0000005;
    const justInside = structuredClone(hostile.structuredContent);
    justInside.pages[1].geometry.display_width = roundedExpectedWidth + roundingTolerance - 0.000001;
    expect(() => validatePdfLayoutSemantics(justInside)).not.toThrow();
    const justOutside = structuredClone(hostile.structuredContent);
    justOutside.pages[1].geometry.display_width = roundedExpectedWidth + roundingTolerance + 0.000001;
    expect(() => validatePdfLayoutSemantics(justOutside)).toThrow(/display size\/view mismatch/);

  });

  it("rejects coordinated page-view and raw-TextItem forgeries against reparsed source bytes", async () => {
    const document = await PDFDocument.create();
    const font = await document.embedFont(StandardFonts.Helvetica);
    const page = document.addPage([200, 300]);
    page.drawText("X", { x: 72, y: 100, size: 12, font });
    const bytes = await document.save({ useObjectStreams: false });
    const pdfjs = await import("pdfjs-dist/legacy/build/pdf.mjs");
    const result = await extractPdfLayout({
      pdfjsLib: pdfjs,
      pdfBytes: bytes,
      sourcePath: "/synthetic/source-bound.pdf",
      sourceFileName: "source-bound.pdf",
      sourceSha256: createHash("sha256").update(bytes).digest("hex"),
      requestedStartPage: 1,
      requestedEndPage: 1,
      maxOutputCharacters: 200000,
    });
    await expect(validatePdfLayoutSourceEvidence(result, { pdfjsLib: pdfjs, sourceBytes: bytes })).resolves.toBe(result);

    const translatedView = structuredClone(result);
    translatedView.pages[0].geometry.pdfjs_view[0] += 10;
    translatedView.pages[0].geometry.pdfjs_view[2] += 10;
    translatedView.pages[0].geometry.viewport_transform[4] -= 10;
    shiftPageGeometryX(translatedView.pages[0], -10);
    expect(() => validatePdfLayoutSemantics(translatedView, { sourceBytes: bytes })).not.toThrow();
    await expect(validatePdfLayoutSourceEvidence(translatedView, { pdfjsLib: pdfjs, sourceBytes: bytes }))
      .rejects.toThrow(/pdfjs_view differs from reparsed source/);

    const translatedRawItem = structuredClone(result);
    translatedRawItem.pages[0].raw_items[0].raw_transform[4] += 100;
    shiftPageGeometryX(translatedRawItem.pages[0], 100);
    expect(() => validatePdfLayoutSemantics(translatedRawItem, { sourceBytes: bytes })).not.toThrow();
    await expect(validatePdfLayoutSourceEvidence(translatedRawItem, { pdfjsLib: pdfjs, sourceBytes: bytes }))
      .rejects.toThrow(/raw_transform differs from reparsed source/);

    const forgedImageEvidence = structuredClone(result);
    forgedImageEvidence.pages[0].has_image_operations = true;
    forgedImageEvidence.pages[0].image_detection_status = "detected";
    forgedImageEvidence.pages[0].modality_hint = "mixed-content-candidate";
    forgedImageEvidence.pages[0].extraction_status = "partial";
    forgedImageEvidence.pages[0].needs_visual_inspection = true;
    forgedImageEvidence.extraction_status = "partial";
    expect(() => validatePdfLayoutSemantics(forgedImageEvidence, { sourceBytes: bytes })).not.toThrow();
    await expect(validatePdfLayoutSourceEvidence(forgedImageEvidence, { pdfjsLib: pdfjs, sourceBytes: bytes }))
      .rejects.toThrow(/operator evidence differs from reparsed source/);
  });

  it("captures bounded solid-mask rectangles and binds them to source operators", async () => {
    const config = {
      items: [textItem({ text: "Cell", x: 110, top: 100 })],
      operations: [10, 12, 76, 11],
      operatorArgs: [null, [40, 0, 0, -0.5, 100, 700], [], null],
    };
    const { result, bytes } = await runFake([config]);
    expect(result.pages[0].painted_rectangles).toEqual({
      status: "available",
      truncated: false,
      observed_count: 1,
      returned_count: 1,
      items: [{
        id: "p0001-r000003",
        source_operation_index: 2,
        source_kind: "solid_color_image_mask",
        graphics_transform: [40, 0, 0, -0.5, 100, 700],
        quad: [
          { x: 100, y: 92 },
          { x: 140, y: 92 },
          { x: 140, y: 92.5 },
          { x: 100, y: 92.5 },
        ],
        bbox: { x: 100, y: 92, width: 40, height: 0.5 },
      }],
    });
    const { pdfjs } = fakePdfjs([config]);
    await expect(validatePdfLayoutSourceEvidence(result, { pdfjsLib: pdfjs, sourceBytes: bytes }))
      .resolves.toBe(result);

    const translated = structuredClone(result);
    const painted = translated.pages[0].painted_rectangles.items[0];
    painted.graphics_transform[4] += 5;
    painted.quad = painted.quad.map(point => ({ ...point, x: point.x + 5 }));
    painted.bbox.x += 5;
    expect(() => validatePdfLayoutSemantics(translated, { sourceBytes: bytes })).not.toThrow();
    await expect(validatePdfLayoutSourceEvidence(translated, { pdfjsLib: pdfjs, sourceBytes: bytes }))
      .rejects.toThrow(/painted_rectangles|operator evidence differs/);
  });

  it("retains the full painted-rectangle transform under large UserUnit scaling", async () => {
    const graphicsTransform = [1.23456, 0, 0, -0.5, 100.12345, 700.67891];
    const viewport = {
      scale: 75,
      width: 45_900,
      height: 59_400,
      transform: [75, 0, 0, -75, 0, 59_400],
    };
    const config = {
      userUnit: 75,
      viewport,
      items: [textItem({ text: "Scaled", x: 110, top: 100 })],
      operations: [10, 12, 76, 11],
      operatorArgs: [null, graphicsTransform, [], null],
    };
    const { result, bytes } = await runFake([config]);
    expect(result.pages[0].painted_rectangles.items[0].graphics_transform).toEqual(graphicsTransform);
    expect(() => validatePdfLayoutSemantics(result, { sourceBytes: bytes })).not.toThrow();
    const { pdfjs } = fakePdfjs([config]);
    await expect(validatePdfLayoutSourceEvidence(result, { pdfjsLib: pdfjs, sourceBytes: bytes }))
      .resolves.toBe(result);
  });

  it("caps painted rectangle evidence without accepting it as complete", async () => {
    const operations = [];
    const operatorArgs = [];
    for (let index = 0; index < 501; index += 1) {
      operations.push(10, 12, 76, 11);
      operatorArgs.push(null, [20, 0, 0, -0.5, 20, 700 - index * 0.01], [], null);
    }
    const { result } = await runFake([{
      items: [textItem({ text: "Bounded", x: 50, top: 50 })],
      operations,
      operatorArgs,
    }]);
    expect(result.pages[0].painted_rectangles).toMatchObject({
      status: "available",
      truncated: true,
      observed_count: 501,
      returned_count: 500,
    });
    expect(result.pages[0].extraction_status).toBe("partial");
    expect(result.pages[0].needs_visual_inspection).toBe(true);
  });

  it("fails closed on retention/output limits and keeps references non-dangling", async () => {
    const limited = await client.callTool({
      name: "read_pdf_layout",
      arguments: { pdf_path: TWO_COLUMN, max_items: 1, max_characters: 100000, max_output_characters: 200000 },
    });
    const page = limited.structuredContent.pages[0];
    expect(page.truncation).toMatchObject({ truncated: true, reasons: ["max_items"], first_omitted_source_index: 1 });
    expect(limited.structuredContent.truncation).toMatchObject({ truncated: true, first_omitted_page: 1, first_omitted_source_index: 1 });
    const itemIds = new Set(page.raw_items.map(item => item.id));
    expect(page.lines.flatMap(line => line.item_ids).every(id => itemIds.has(id))).toBe(true);
    const lineIds = new Set(page.lines.map(line => line.id));
    expect(page.blocks.flatMap(block => block.line_ids).every(id => lineIds.has(id))).toBe(true);

    const pressureDocument = await PDFDocument.create();
    const pressureFont = await pressureDocument.embedFont(StandardFonts.Helvetica);
    const pressurePage = pressureDocument.addPage([612, 4000]);
    pressurePage.drawText(Array.from({ length: 100 }, (_, index) => `Budget item ${index}`).join("\n"), {
      x: 40,
      y: 3950,
      size: 10,
      lineHeight: 30,
      font: pressureFont,
    });
    const pressureFixture = path.join(temporaryRoot, "output-pressure.pdf");
    await fs.writeFile(pressureFixture, await pressureDocument.save({ useObjectStreams: false }));
    const outputLimited = await client.callTool({
      name: "read_pdf_layout",
      arguments: { pdf_path: pressureFixture, max_items: 5000, max_output_characters: 20000 },
    });
    expect(JSON.stringify(outputLimited.structuredContent).length).toBeLessThanOrEqual(20000);
    expect(outputLimited.structuredContent.truncation.reasons).toContain("max_output_characters");
    expect(outputLimited.structuredContent.pages[0].reading_order).toMatchObject({
      strategy: "unavailable_output_omitted",
      column_count: 0,
    });
    expect(outputLimited.structuredContent.truncation.omitted_items).toBe(
      outputLimited.structuredContent.pages.reduce((sum, value) => sum + value.truncation.omitted_items, 0),
    );
    const pressureBytes = await fs.readFile(pressureFixture);
    const pdfjs = await import("pdfjs-dist/legacy/build/pdf.mjs");
    const relabeledOutputBudget = structuredClone(outputLimited.structuredContent);
    relabeledOutputBudget.limits.max_output_characters = 200000;
    relabeledOutputBudget.id_scope.max_output_characters = 200000;
    expect(() => validatePdfLayoutSemantics(relabeledOutputBudget, { sourceBytes: pressureBytes })).not.toThrow();
    await expect(validatePdfLayoutSourceEvidence(relabeledOutputBudget, { pdfjsLib: pdfjs, sourceBytes: pressureBytes }))
      .rejects.toThrow(/output omission differs from independent budget replay/);
    const roomy = await client.callTool({
      name: "read_pdf_layout",
      arguments: { pdf_path: pressureFixture, max_items: 5000, max_output_characters: 200000 },
    });
    expect(roomy.structuredContent.pages[0].truncation.reasons).not.toContain("max_output_characters");
    expect(roomy.structuredContent.pages[0].raw_items.length).toBeGreaterThan(0);
    const understatedOutputBudget = structuredClone(roomy.structuredContent);
    understatedOutputBudget.limits.max_output_characters = 20000;
    understatedOutputBudget.id_scope.max_output_characters = 20000;
    expect(() => validatePdfLayoutSemantics(understatedOutputBudget, { sourceBytes: pressureBytes }))
      .toThrow(/serialized output exceeds its declared limit/);
  });

  it("bounds page count, high page selection, and source size before parsing", async () => {
    const document = await PDFDocument.create();
    for (let index = 0; index < 900; index += 1) document.addPage([72, 72]);
    const manyPages = path.join(temporaryRoot, "many-pages.pdf");
    await fs.writeFile(manyPages, await document.save());
    const page900 = await client.callTool({ name: "read_pdf_layout", arguments: { pdf_path: manyPages, start_page: 900, end_page: 900 } });
    expect(page900.structuredContent.page_range).toMatchObject({ start_page: 900, end_page: 900, total_pages: 900 });
    expect(page900.structuredContent.pages.map(page => page.page)).toEqual([900]);

    const tooMany = await client.callTool({ name: "read_pdf_layout", arguments: { pdf_path: manyPages, start_page: 1, end_page: 11 } });
    expect(tooMany.isError).toBe(true);
    expect(tooMany.content[0].text).toContain("at most 10 pages");

    const oversized = path.join(temporaryRoot, "oversized.pdf");
    const handle = await fs.open(oversized, "w");
    await handle.truncate(250 * 1024 * 1024 + 1);
    await handle.close();
    const tooLarge = await client.callTool({ name: "read_pdf_layout", arguments: { pdf_path: oversized } });
    expect(tooLarge.isError).toBe(true);
    expect(tooLarge.content[0].text).toContain("up to 250 MiB");
  }, 30_000);

  it("proves missing, wrong, and correct passwords through MCP with the provenance-bound ODA QPDF fixture", async () => {
    const provenance = JSON.parse(await fs.readFile(ENCRYPTED_LAYOUT_PROVENANCE, "utf8"));
    const encryptedBytes = await fs.readFile(ENCRYPTED_LAYOUT);
    const sourceBytes = await fs.readFile(path.join(REPO_ROOT, provenance.source_fixture.path));
    expect(createHash("sha256").update(sourceBytes).digest("hex")).toBe(provenance.source_fixture.sha256);
    expect(createHash("sha256").update(encryptedBytes).digest("hex")).toBe(provenance.encrypted_fixture.sha256);
    expect(provenance).toMatchObject({
      schema_version: 1,
      ownership: "Open Document Alliance generated synthetic fixture",
      qpdf: { version: "12.3.2" },
      generation: { reproducible_across_two_runs: true, test_only_insecure_flags: ["--static-id", "--static-aes-iv"] },
    });
    const sentinel = "__PDF_TOOLS_ENCRYPTED_STDERR_FULLY_DRAINED__";
    const dedicatedStderr = [];
    const protocolLogs = [];
    const rawProtocol = [];
    const dedicatedTransport = new StdioClientTransport({
      command: process.execPath,
      args: [STDERR_SENTINEL_HELPER],
      cwd: REPO_ROOT,
      env: {
        ALLOWED_DIRECTORIES: [REPO_ROOT, temporaryRoot].join(path.delimiter),
        PDF_TOOLS_TEST_STDERR_SENTINEL: sentinel,
      },
      stderr: "pipe",
    });
    dedicatedTransport.stderr.on("data", chunk => dedicatedStderr.push(Buffer.from(chunk)));
    const stderrEnded = once(dedicatedTransport.stderr, "end");
    const dedicatedClient = new Client({ name: "pdf-layout-encrypted-leak-test", version: "1.0.0" });
    dedicatedClient.setNotificationHandler(LoggingMessageNotificationSchema, notification => {
      protocolLogs.push(structuredClone(notification));
    });
    let closed = false;
    const callTraced = async arguments_ => {
      const start = rawProtocol.length;
      let result = null;
      let error = null;
      try {
        result = await dedicatedClient.callTool({ name: "read_pdf_layout", arguments: arguments_ }, undefined, { timeout: 5_000, maxTotalTimeout: 5_000 });
      } catch (caught) {
        error = caught;
      }
      return { result, error, rawProtocol: rawProtocol.slice(start) };
    };
    let missingTrace;
    let wrongTrace;
    let userTrace;
    let ownerTrace;
    try {
      await dedicatedClient.connect(dedicatedTransport);
      const receiveProtocolMessage = dedicatedTransport.onmessage;
      dedicatedTransport.onmessage = (message, extra) => {
        rawProtocol.push(structuredClone(message));
        receiveProtocolMessage?.(message, extra);
      };
      missingTrace = await callTraced({ pdf_path: ENCRYPTED_LAYOUT });
      wrongTrace = await callTraced({
        pdf_path: ENCRYPTED_LAYOUT,
        password: provenance.passwords.wrong_password_oracle,
      });
      userTrace = await callTraced({
        pdf_path: ENCRYPTED_LAYOUT,
        password: provenance.passwords.user,
        max_output_characters: 200000,
      });
      ownerTrace = await callTraced({
        pdf_path: ENCRYPTED_LAYOUT,
        password: provenance.passwords.owner,
        max_output_characters: 200000,
      });
      await dedicatedClient.listTools();
      await dedicatedClient.close();
      closed = true;
      await stderrEnded;
    } finally {
      if (!closed) await dedicatedClient.close().catch(() => {});
    }

    const missing = missingTrace.result;
    expect(missingTrace.error).toBeNull();
    expect(missing).toMatchObject({
      isError: true,
      structuredContent: { status: "failed", error: { error_schema_version: 1, code: "PASSWORD_REQUIRED" } },
    });
    expect(JSON.stringify(missing)).not.toContain(provenance.passwords.user);

    const wrong = wrongTrace.result;
    expect(wrongTrace.error).toBeNull();
    expect(wrong).toMatchObject({
      isError: true,
      structuredContent: { status: "failed", error: { error_schema_version: 1, code: "PASSWORD_INCORRECT" } },
    });
    const correctUser = userTrace.result;
    expect(userTrace.error).toBeNull();
    expect(correctUser.isError).not.toBe(true);
    expect(correctUser.structuredContent.source.sha256).toBe(provenance.encrypted_fixture.sha256);
    expect(correctUser.structuredContent.extraction_status).toBe("partial");
    expect(correctUser.structuredContent.pages[0]).toMatchObject({
      extraction_status: "partial",
      geometry: {
        media_box: null,
        crop_box: null,
        raw_pdf_rotation: null,
        pdfjs_view: [0, 0, 612, 792],
        display_width: 612,
        display_height: 792,
      },
      errors: [expect.objectContaining({ code: "RAW_PAGE_GEOMETRY_UNAVAILABLE" })],
    });
    expect(correctUser.structuredContent.pages[0].flow_text).toContain("TWO COLUMN NOTICE");

    const correctOwner = ownerTrace.result;
    expect(ownerTrace.error).toBeNull();
    expect(correctOwner.isError).not.toBe(true);
    expect(correctOwner.structuredContent.source.sha256).toBe(provenance.encrypted_fixture.sha256);
    expect(correctOwner.structuredContent.pages[0].flow_text).toContain("TWO COLUMN NOTICE");
    const completeStderr = Buffer.concat(dedicatedStderr).toString("utf8");
    const stderrLines = completeStderr.trimEnd().split(/\r?\n/);
    expect(stderrLines.at(-1)).toBe(sentinel);
    expect(stderrLines.filter(line => line === sentinel)).toHaveLength(1);
    for (const trace of [missingTrace, wrongTrace, userTrace, ownerTrace]) {
      expect(trace.rawProtocol.some(message => "result" in message || "error" in message)).toBe(true);
    }

    const leakSurfaces = {
      complete_result_objects: { missing, wrong, correctUser, correctOwner },
      result_content: [missing.content, wrong.content, correctUser.content, correctOwner.content],
      result_structured_content: [missing.structuredContent, wrong.structuredContent, correctUser.structuredContent, correctOwner.structuredContent],
      result_meta: [missing._meta, wrong._meta, correctUser._meta, correctOwner._meta],
      complete_error_objects: {
        missing: { call_error: completeErrorSurface(missingTrace.error), result_error: missing.structuredContent?.error },
        wrong: { call_error: completeErrorSurface(wrongTrace.error), result_error: wrong.structuredContent?.error },
        user: { call_error: completeErrorSurface(userTrace.error), result_error: correctUser.structuredContent?.error },
        owner: { call_error: completeErrorSurface(ownerTrace.error), result_error: correctOwner.structuredContent?.error },
      },
      complete_raw_protocol: {
        missing: missingTrace.rawProtocol,
        wrong: wrongTrace.rawProtocol,
        user: userTrace.rawProtocol,
        owner: ownerTrace.rawProtocol,
        all: rawProtocol,
      },
      protocol_logs: protocolLogs,
      complete_stderr: completeStderr,
    };
    for (const password of Object.values(provenance.passwords)) {
      for (const [surface, value] of Object.entries(leakSurfaces)) {
        expect(JSON.stringify(value), `${surface} exposed a test password`).not.toContain(password);
      }
    }
  // Four individually bounded password calls plus startup and full stderr drain.
  }, 30_000);
});

describe("Extraction IR hostile reconstruction", () => {
  it("preserves whitespace, empty EOL, zero width, ligatures, repeats, styles, and source order", async () => {
    const items = [
      textItem({ text: " ", x: 10, top: 20, width: 4, hasEOL: false }),
      textItem({ text: "office ﬁ", x: 20, top: 20, width: 60, hasEOL: false }),
      textItem({ text: "", x: 85, top: 20, width: 0, hasEOL: true }),
      textItem({ text: "repeat", x: 10, top: 50, hasEOL: false }),
      textItem({ text: "repeat", x: 80, top: 50, hasEOL: true }),
    ];
    const { result } = await runFake([{ items }]);
    const raw = result.pages[0].raw_items;
    expect(raw.map(item => item.text)).toEqual([" ", "office ﬁ", "", "repeat", "repeat"]);
    expect(raw.map(item => item.source_index)).toEqual([0, 1, 2, 3, 4]);
    expect(raw[0].is_whitespace).toBe(true);
    expect(raw[0].text_kind).toBe("whitespace");
    expect(raw[2]).toMatchObject({ has_eol: true, text_kind: "empty", raw_width: 0, width: 0, bbox_status: "degenerate" });
    expect(raw[1].font).toEqual({ family: "Test Sans", ascent: 0.8, descent: -0.2, vertical: false });
    expect(result.pages[0].limitations.join(" ")).toContain("hidden, clipped, duplicated");
  });

  it("rejects invented glyph-recovery provenance", async () => {
    const { result } = await runFake([{ items: [textItem({ text: "A", x: 10, top: 20 })] }]);
    const forged = structuredClone(result);
    const item = forged.pages[0].raw_items[0];
    item.source_text = "A";
    item.text = "−";
    item.glyph_recoveries = [{
      source_utf16_start: 0,
      source_utf16_end: 1,
      output_utf16_start: 0,
      output_utf16_end: 1,
      original_char_code: 0,
      source_unicode: "A",
      operator_unicode: "A",
      target_unicode: "−",
      binding_kind: "exact_text_scalar",
      operator_advance_width: null,
      operator_anchor_span_width: null,
      operator_raw_transform: null,
      font_name: item.font_name,
      registry_id: "cmsy-pk-raster-minus-v1",
      qualification: "ctan-cm-encoding-plus-reviewed-pk-raster-v1",
      glyph_sha256: "3f6fdf2abc68f5693f9ea7cdec4d94214a57fb953fb66c747b86dd1f6293d807",
      witness_glyph_sha256: [
        "cf5071eb6c006bc80cf9399c28dc00f7e12d8e7f090942de46cb06d404481dd6",
        "da5345f465509486a66762b6cf8918a3ba5c937f4ca8c7bc4657f4f905d0b4be",
      ],
      tfm_reference_version: "ctan-cm-tfm-9c0f99fa34c7",
      glyph_evidence_version: "pdfjs-type3-glyph-evidence-v2",
    }];
    expect(() => validatePdfLayoutSemantics(forged)).toThrow(/registry evidence is invalid/);
  });

  it("replays the source operators instead of trusting a well-formed recovery claim", async () => {
    const sourceItem = textItem({ text: "\u0000", x: 10, top: 20 });
    const { result, bytes } = await runFake([{ items: [sourceItem] }]);
    const forged = structuredClone(result);
    const item = forged.pages[0].raw_items[0];
    item.source_text = "\u0000";
    item.text = "−";
    item.glyph_recoveries = [{
      source_utf16_start: 0,
      source_utf16_end: 1,
      output_utf16_start: 0,
      output_utf16_end: 1,
      original_char_code: 0,
      source_unicode: "\u0000",
      operator_unicode: "\u0000",
      target_unicode: "−",
      binding_kind: "exact_text_scalar",
      operator_advance_width: null,
      operator_anchor_span_width: null,
      operator_raw_transform: null,
      font_name: item.font_name,
      registry_id: "cmsy-pk-raster-minus-v1",
      qualification: "ctan-cm-encoding-plus-reviewed-pk-raster-v1",
      glyph_sha256: "3f6fdf2abc68f5693f9ea7cdec4d94214a57fb953fb66c747b86dd1f6293d807",
      witness_glyph_sha256: [
        "cf5071eb6c006bc80cf9399c28dc00f7e12d8e7f090942de46cb06d404481dd6",
        "da5345f465509486a66762b6cf8918a3ba5c937f4ca8c7bc4657f4f905d0b4be",
      ],
      tfm_reference_version: "ctan-cm-tfm-9c0f99fa34c7",
      glyph_evidence_version: "pdfjs-type3-glyph-evidence-v2",
    }];
    forged.pages[0].lines[0].text = "−";
    forged.pages[0].flow_text = "−";
    forged.pages[0].spatial_text = forged.pages[0].spatial_text.replace("\u0000", "−");
    expect(() => validatePdfLayoutSemantics(forged, { sourceBytes: bytes })).not.toThrow();
    await expect(validatePdfLayoutSourceEvidence(forged, {
      pdfjsLib: fakePdfjs([{ items: [sourceItem] }]).pdfjs,
      sourceBytes: bytes,
    })).rejects.toThrow(/differs from reparsed source/);
  });

  it("binds truncation to the exact parser-order TextItem prefix", async () => {
    const document = await PDFDocument.create();
    const font = await document.embedFont(StandardFonts.Helvetica);
    const page = document.addPage([300, 400]);
    page.drawText("A\nB\nC\nD\nE", { x: 40, y: 340, size: 12, lineHeight: 30, font });
    const bytes = await document.save({ useObjectStreams: false });
    const pdfjs = await import("pdfjs-dist/legacy/build/pdf.mjs");
    const common = {
      pdfjsLib: pdfjs,
      pdfBytes: bytes,
      sourcePath: "/synthetic/five-entry-prefix.pdf",
      sourceFileName: "five-entry-prefix.pdf",
      sourceSha256: createHash("sha256").update(bytes).digest("hex"),
      maxCharacters: 50000,
      maxOutputCharacters: 200000,
    };
    const full = await extractPdfLayout({ ...common, maxItems: 100 });
    const truncated = await extractPdfLayout({ ...common, maxItems: 2 });
    expect(full.pages[0].raw_items.map(item => item.text)).toEqual(["A", "B", "C", "D", "E"]);
    expect(truncated.pages[0].raw_items.map(item => item.source_index)).toEqual([0, 1]);
    expect(truncated.pages[0].truncation).toMatchObject({ omitted_items: 3, first_omitted_source_index: 2 });

    const understatedItems = structuredClone(full);
    understatedItems.limits.max_items = 1;
    understatedItems.id_scope.max_items = 1;
    expect(() => validatePdfLayoutSemantics(understatedItems, { sourceBytes: bytes })).not.toThrow();
    await expect(validatePdfLayoutSourceEvidence(understatedItems, { pdfjsLib: pdfjs, sourceBytes: bytes }))
      .rejects.toThrow(/independently replayed limits/);

    const understatedCharacters = structuredClone(full);
    understatedCharacters.limits.max_characters = 1;
    understatedCharacters.id_scope.max_characters = 1;
    expect(() => validatePdfLayoutSemantics(understatedCharacters, { sourceBytes: bytes })).not.toThrow();
    await expect(validatePdfLayoutSourceEvidence(understatedCharacters, { pdfjsLib: pdfjs, sourceBytes: bytes }))
      .rejects.toThrow(/independently replayed limits/);

    const relabeledTruncation = structuredClone(truncated);
    relabeledTruncation.limits.max_items = 5;
    relabeledTruncation.id_scope.max_items = 5;
    expect(() => validatePdfLayoutSemantics(relabeledTruncation, { sourceBytes: bytes })).not.toThrow();
    await expect(validatePdfLayoutSourceEvidence(relabeledTruncation, { pdfjsLib: pdfjs, sourceBytes: bytes }))
      .rejects.toThrow(/independently replayed limits/);

    const missing = structuredClone(truncated);
    missing.pages[0].raw_items.splice(1, 1);
    missing.pages[0].counts.returned_items = 1;
    missing.pages[0].counts.returned_non_whitespace_items = 1;
    missing.pages[0].counts.returned_characters = 1;
    missing.pages[0].truncation.omitted_items = 4;
    missing.pages[0].truncation.omitted_non_whitespace_items = 4;
    missing.pages[0].truncation.omitted_characters = 4;
    expect(() => validatePdfLayoutSemantics(missing)).toThrow(/prefix boundary|dangling/);

    const reordered = structuredClone(truncated);
    reordered.pages[0].raw_items.reverse();
    expect(() => validatePdfLayoutSemantics(reordered)).toThrow(/exact source prefix/);

    const duplicate = structuredClone(truncated);
    duplicate.pages[0].raw_items[1] = structuredClone(duplicate.pages[0].raw_items[0]);
    expect(() => validatePdfLayoutSemantics(duplicate)).toThrow(/exact source prefix|duplicate ID/);

    // Exact reproduction of the formerly accepted interior omission: retain
    // source entries [0, 3], keep observed=5/returned=2/omitted=3, and claim
    // the first omission is 4. The prefix contract now rejects it before any
    // derived line data can legitimize the omission.
    const laterSubstitution = structuredClone(truncated);
    laterSubstitution.pages[0].raw_items[1] = structuredClone(full.pages[0].raw_items[3]);
    laterSubstitution.pages[0].counts.returned_items = 2;
    laterSubstitution.pages[0].counts.returned_non_whitespace_items = 2;
    laterSubstitution.pages[0].counts.returned_characters = 2;
    laterSubstitution.pages[0].truncation.omitted_items = 3;
    laterSubstitution.pages[0].truncation.omitted_non_whitespace_items = 3;
    laterSubstitution.pages[0].truncation.omitted_characters = 3;
    laterSubstitution.pages[0].truncation.first_omitted_source_index = 4;
    laterSubstitution.truncation.first_omitted_source_index = 4;
    expect(() => validatePdfLayoutSemantics(laterSubstitution, { sourceBytes: bytes })).toThrow(/exact source prefix/);
    await expect(validatePdfLayoutSourceEvidence(laterSubstitution, { pdfjsLib: pdfjs, sourceBytes: bytes }))
      .rejects.toThrow(/exact source prefix/);
  });

  it("replays item and character retention globally across page order", async () => {
    const document = await PDFDocument.create();
    const font = await document.embedFont(StandardFonts.Helvetica);
    for (const text of ["A\nB", "C\nD"]) {
      const page = document.addPage([300, 400]);
      page.drawText(text, { x: 40, y: 340, size: 12, lineHeight: 30, font });
    }
    const bytes = await document.save({ useObjectStreams: false });
    const pdfjs = await import("pdfjs-dist/legacy/build/pdf.mjs");
    const common = {
      pdfjsLib: pdfjs,
      pdfBytes: bytes,
      sourcePath: "/synthetic/global-retention.pdf",
      sourceFileName: "global-retention.pdf",
      sourceSha256: createHash("sha256").update(bytes).digest("hex"),
      requestedStartPage: 1,
      requestedEndPage: 2,
      maxOutputCharacters: 200000,
    };
    const itemLimited = await extractPdfLayout({ ...common, maxItems: 3, maxCharacters: 50000 });
    expect(itemLimited.pages.map(page => page.raw_items.map(item => item.text))).toEqual([["A", "B"], ["C"]]);
    expect(itemLimited.pages[1].truncation).toMatchObject({
      reasons: ["max_items"],
      omitted_items: 1,
      omitted_characters: 1,
      first_omitted_source_index: 1,
    });

    const characterLimited = await extractPdfLayout({ ...common, maxItems: 100, maxCharacters: 3 });
    expect(characterLimited.pages.map(page => page.raw_items.map(item => item.text))).toEqual([["A", "B"], ["C"]]);
    expect(characterLimited.pages[1].truncation.reasons).toEqual(["max_characters"]);

    const resetPerPageForgery = structuredClone(itemLimited);
    resetPerPageForgery.limits.max_items = 2;
    resetPerPageForgery.id_scope.max_items = 2;
    expect(() => validatePdfLayoutSemantics(resetPerPageForgery, { sourceBytes: bytes })).not.toThrow();
    await expect(validatePdfLayoutSourceEvidence(resetPerPageForgery, { pdfjsLib: pdfjs, sourceBytes: bytes }))
      .rejects.toThrow(/independently replayed limits/);
  });

  it("source-binds empty, Unicode whitespace, astral code units, and ranges beginning after page one", async () => {
    const boundaryItems = [
      textItem({ text: "", x: 10, top: 20, width: 0, hasEOL: true }),
      textItem({ text: "\u2003", x: 10, top: 50, width: 8, hasEOL: true }),
      textItem({ text: "😀", x: 10, top: 80, width: 20, hasEOL: true }),
      textItem({ text: "Z", x: 10, top: 110, width: 8, hasEOL: true }),
    ];
    const atThree = await runFake([{ items: boundaryItems }], { maxCharacters: 3 });
    expect(atThree.result.pages[0].raw_items.map(item => [item.text, item.text_kind, item.text.length])).toEqual([
      ["", "empty", 0],
      ["\u2003", "whitespace", 1],
      ["😀", "non_whitespace", 2],
    ]);
    expect(atThree.result.pages[0].truncation).toMatchObject({
      reasons: ["max_characters"],
      omitted_items: 1,
      omitted_characters: 1,
      first_omitted_source_index: 3,
    });
    const atTwo = await runFake([{ items: boundaryItems }], { maxCharacters: 2 });
    expect(atTwo.result.pages[0].raw_items.map(item => item.text)).toEqual(["", "\u2003"]);
    expect(atTwo.result.pages[0].truncation).toMatchObject({
      omitted_items: 2,
      omitted_characters: 3,
      first_omitted_source_index: 2,
    });

    const selected = await runFake([
      { items: [textItem({ text: "unselected", x: 10, top: 20 })] },
      { items: boundaryItems.slice(0, 2) },
      { items: boundaryItems.slice(2) },
    ], { startPage: 2, endPage: 3, maxCharacters: 3 });
    expect(selected.result.page_range).toMatchObject({ start_page: 2, end_page: 3, total_pages: 3 });
    expect(selected.result.pages.map(page => page.page)).toEqual([2, 3]);
    expect(selected.result.pages.map(page => page.raw_items.map(item => item.text))).toEqual([
      ["", "\u2003"],
      ["😀"],
    ]);
    expect(selected.result.pages[1].truncation).toMatchObject({
      reasons: ["max_characters"],
      omitted_items: 1,
      omitted_characters: 1,
      first_omitted_source_index: 1,
    });
  });

  it("handles RTL spacing and falls back for TTB, skew, and ambiguous indents", async () => {
    const rtl = await runFake([{ items: [
      textItem({ text: "A", x: 200, top: 20, width: 40, direction: "rtl", hasEOL: false }),
      textItem({ text: "B", x: 150, top: 20, width: 40, direction: "rtl", hasEOL: true }),
    ] }]);
    expect(rtl.result.pages[0].flow_text).toBe("A B");

    const ttb = await runFake([{ items: [textItem({ text: "vertical", x: 50, top: 20, direction: "ttb" })] }]);
    expect(ttb.result.pages[0].reading_order.strategy).toBe("source_order_fallback");
    const skew = await runFake([{ items: [textItem({ text: "skew", x: 50, top: 20, transform: [12, 2, 0, 12, 50, 760] })] }]);
    expect(skew.result.pages[0].reading_order.strategy).toBe("source_order_fallback");
    const skewItem = skew.result.pages[0].raw_items[0];
    expect(Math.abs(Math.hypot(
      skewItem.quad[1].x - skewItem.quad[0].x,
      skewItem.quad[1].y - skewItem.quad[0].y,
    ) - skewItem.raw_width)).toBeLessThan(0.002);

    const vertical = await runFake([{ items: [textItem({ text: "vertical", x: 50, top: 20, width: 12 })], styles: {
      f1: { fontFamily: "Vertical Test", ascent: 0.75, descent: -0.25, vertical: true },
    } }]);
    const verticalItem = vertical.result.pages[0].raw_items[0];
    expect(verticalItem.geometry_provenance).toEqual({
      formula: "pdfjs_text_item_style_metric_advance_box_approximation",
      quad_order: "anchor_top_terminal_top_anchor_bottom_terminal_bottom",
      advance_source: "item_height",
      ascent_source: "style_ascent",
      ascent_ratio: 0.75,
    });
    expect(Math.hypot(
      verticalItem.quad[1].x - verticalItem.quad[0].x,
      verticalItem.quad[1].y - verticalItem.quad[0].y,
    )).toBeCloseTo(12, 3);

    const indented = [];
    for (const top of [100, 130, 160]) indented.push(textItem({ text: `wide-${top}`, x: 50, top, width: 260 }));
    for (const top of [105, 135, 165]) indented.push(textItem({ text: `indent-${top}`, x: 200, top, width: 80 }));
    const ambiguous = await runFake([{ items: indented }]);
    expect(ambiguous.result.pages[0].reading_order.strategy).not.toBe("two_column_left_to_right");
  });

  it.each(["ltr", "rtl"])("projects inverted %s run gaps without requiring a whitespace item", async lineDirection => {
    for (const gap of [10, 0, -1]) {
      // Page-space advances point left. RTL reverses which run edge borders
      // the next run, independently of the viewport's coordinate direction.
      const firstX = 200;
      const secondX = lineDirection === "rtl" ? firstX + 40 + gap : firstX - 40 - gap;
      const { result } = await runFake([{ items: [
        textItem({ text: "A", x: firstX, top: 20, width: 40, direction: lineDirection,
          hasEOL: false, transform: [-12, 0, 0, -12, firstX, 760] }),
        textItem({ text: "B", x: secondX, top: 20, width: 40, direction: lineDirection,
          hasEOL: true, transform: [-12, 0, 0, -12, secondX, 760] }),
      ] }]);
      expect(result.pages[0].raw_items.map(item => item.text)).toEqual(["A", "B"]);
      expect(result.pages[0].flow_text).toBe(gap > 0 ? "A B" : "AB");
    }
  });

  it("does not bridge equal-baseline column gutters and makes source fallback truly source segmented", async () => {
    const equalBaseline = [];
    for (const top of [100, 130, 160]) {
      equalBaseline.push(textItem({ text: `L${top}`, x: 50, top, width: 80, hasEOL: false }));
      equalBaseline.push(textItem({ text: `R${top}`, x: 350, top, width: 80, hasEOL: false }));
    }
    const columns = await runFake([{ items: equalBaseline }]);
    expect(columns.result.pages[0].lines).toHaveLength(6);
    expect(columns.result.pages[0].reading_order.strategy).toBe("two_column_left_to_right");

    const tableLike = [
      textItem({ text: "TITLE", x: 200, top: 60, width: 80, hasEOL: true }),
    ];
    for (const top of [100, 130, 160]) {
      tableLike.push(textItem({ text: `A${top}`, x: 50, top, width: 40, hasEOL: false }));
      tableLike.push(textItem({ text: `B${top}`, x: 250, top, width: 40, hasEOL: false }));
      tableLike.push(textItem({ text: `C${top}`, x: 400, top, width: 40, hasEOL: true }));
    }
    const segmented = await runFake([{ items: tableLike }]);
    expect(segmented.result.pages[0].reading_order).toMatchObject({
      strategy: "source_order_fallback",
      column_count: 1,
    });
    expect(segmented.result.pages[0].reading_order.limitations[0]).toMatch(/table-like or segmented content/);
    expect(segmented.result.pages[0].flow_text).toBe(
      "TITLE\nA100 B100 C100\nA130 B130 C130\nA160 B160 C160",
    );

    const sourceFallback = await runFake([{ items: [
      textItem({ text: "A", x: 10, top: 300, width: 10, hasEOL: false, transform: [12, 2, 0, 12, 10, 480] }),
      textItem({ text: "B", x: 30, top: 100, width: 10, hasEOL: false }),
      textItem({ text: "C", x: 50, top: 200, width: 10, hasEOL: true }),
      textItem({ text: "D", x: 10, top: 20, width: 10, hasEOL: true }),
    ] }]);
    expect(sourceFallback.result.pages[0].reading_order.strategy).toBe("source_order_fallback");
    expect(sourceFallback.result.pages[0].flow_text).toBe("A\nB\nC\nD");

    const staircaseItems = [100, 105, 110, 115, 120].map((top, index) => textItem({
      text: `S${index + 1}`,
      x: 10 + index * 20,
      top,
      width: 12,
      hasEOL: index === 4,
      transform: [12, 2, 0, 12, 10 + index * 20, 792 - top - 12],
    }));
    const staircase = await runFake([{ items: staircaseItems }]);
    expect(staircase.result.pages[0].reading_order.strategy).toBe("source_order_fallback");
    expect(staircase.result.pages[0].lines.length).toBeGreaterThan(1);
    expect(Math.max(...staircase.result.pages[0].lines.map(line => line.item_ids.length))).toBeLessThanOrEqual(2);
    expect(staircase.result.pages[0].flow_text).toBe("S1 S2\nS3 S4\nS5");
  });

  it("accepts only persistent columns with a real gutter and an external spanning heading", async () => {
    const items = [textItem({ text: "SPANNING HEADER", x: 40, top: 20, width: 520 })];
    for (const top of [100, 130, 160]) items.push(textItem({ text: `L${top}`, x: 50, top, width: 100 }));
    for (const top of [100, 130, 160]) items.push(textItem({ text: `R${top}`, x: 350, top, width: 100 }));
    const { result } = await runFake([{ items }]);
    expect(result.pages[0].reading_order).toMatchObject({
      strategy: "two_column_left_to_right",
      confidence: "not_calibrated",
      column_count: 2,
    });
    expect(result.pages[0].flow_text.split("\n")[0]).toBe("SPANNING HEADER");
  });

  it("marks non-finite geometry and per-page failures without NaN or missing flow text", async () => {
    const invalid = textItem({ text: "bad", x: 10, top: 10, transform: [Number.NaN, 0, 0, 12, 10, 760] });
    const { result } = await runFake([
      { textError: new Error("synthetic page failure") },
      { items: [invalid], operations: [1, 2] },
    ]);
    expect(result.pages[0]).toMatchObject({ text_layer_status: "failed", extraction_status: "failed", flow_text: "" });
    expect(result.pages[1]).toMatchObject({ extraction_status: "partial", modality_hint: "mixed-content-candidate" });
    expect(result.pages[1].raw_items[0]).toMatchObject({ geometry_valid: false, quad: null, bbox: null, x: null });
    expect(JSON.stringify(result)).not.toContain("NaN");
  });

  it("fails raw pdf-lib box enrichment soft after PDF.js has authenticated the document", async () => {
    const invalidForPdfLib = Buffer.from("not-a-pdf-but-the-fake-pdfjs-parser-accepted-it");
    const { result } = await runFake([{ items: [textItem({ text: "authenticated", x: 10, top: 20 })] }], {
      pdfBytes: invalidForPdfLib,
    });
    expect(result.pages[0]).toMatchObject({
      extraction_status: "partial",
      geometry: {
        media_box: null,
        crop_box: null,
        raw_pdf_rotation: null,
        display_rotation: 0,
        rotation_matches_raw: null,
      },
      errors: [expect.objectContaining({ code: "RAW_PAGE_GEOMETRY_UNAVAILABLE" })],
    });
    expect(result.pages[0].flow_text).toBe("authenticated");

    const forgedRawGeometry = structuredClone(result);
    forgedRawGeometry.pages[0].geometry.media_box = { x: 0, y: 0, width: 612, height: 792 };
    forgedRawGeometry.pages[0].geometry.crop_box = { x: 0, y: 0, width: 612, height: 792 };
    forgedRawGeometry.pages[0].geometry.raw_pdf_rotation = 0;
    forgedRawGeometry.pages[0].geometry.rotation_matches_raw = true;
    expect(() => validatePdfLayoutSemantics(forgedRawGeometry, { sourceBytes: invalidForPdfLib }))
      .toThrow(/unavailable raw geometry contains claims/);
    await expect(validatePdfLayoutSourceEvidence(forgedRawGeometry, {
      pdfjsLib: fakePdfjs([{ items: [textItem({ text: "authenticated", x: 10, top: 20 })] }]).pdfjs,
      sourceBytes: invalidForPdfLib,
    })).rejects.toThrow(/unavailable raw geometry contains claims/);
  });

  it("fails closed and cleans every source-proof resource when TextItem reparse reaches its deadline", async () => {
    const { result, bytes } = await runFake([{ textError: new Error("synthetic page failure") }]);
    const cleanup = { page: 0, document: 0, loading: 0 };
    const neverResolvingPdfjs = {
      version: "5.4.624",
      getDocument: () => ({
        promise: Promise.resolve({
          numPages: 1,
          getPage: async () => ({
            view: [0, 0, 612, 792],
            userUnit: 1,
            rotate: 0,
            getViewport: () => ({ width: 612, height: 792, transform: [1, 0, 0, -1, 0, 792] }),
            getTextContent: () => new Promise(() => {}),
            getAnnotations: async () => [],
            cleanup: () => { cleanup.page += 1; },
          }),
          destroy: async () => { cleanup.document += 1; },
        }),
        destroy: async () => { cleanup.loading += 1; },
      }),
    };
    const startedAt = Date.now();
    await expect(validatePdfLayoutSourceEvidence(result, {
      pdfjsLib: neverResolvingPdfjs,
      sourceBytes: bytes,
      deadlineAt: startedAt + 40,
    })).rejects.toMatchObject({ code: "LAYOUT_DEADLINE" });
    expect(Date.now() - startedAt).toBeGreaterThanOrEqual(30);
    expect(cleanup).toEqual({ page: 1, document: 1, loading: 1 });

    for (const fatalError of [
      Object.assign(new Error("source reparse cancelled"), { name: "AbortError" }),
      Object.assign(new Error("source reparse resource exhausted"), { code: "ENOMEM" }),
    ]) {
      const fatalCleanup = { page: 0, document: 0, loading: 0 };
      const fatalPdfjs = {
        version: "5.4.624",
        getDocument: () => ({
          promise: Promise.resolve({
            numPages: 1,
            getPage: async () => ({
              view: [0, 0, 612, 792],
              userUnit: 1,
              rotate: 0,
              getViewport: () => ({ width: 612, height: 792, transform: [1, 0, 0, -1, 0, 792] }),
              getTextContent: async () => { throw fatalError; },
              getAnnotations: async () => [],
              cleanup: () => { fatalCleanup.page += 1; },
            }),
            destroy: async () => { fatalCleanup.document += 1; },
          }),
          destroy: async () => { fatalCleanup.loading += 1; },
        }),
      };
      await expect(validatePdfLayoutSourceEvidence(result, {
        pdfjsLib: fatalPdfjs,
        sourceBytes: bytes,
      })).rejects.toBe(fatalError);
      expect(fatalCleanup).toEqual({ page: 1, document: 1, loading: 1 });
    }
  });

  it("binds operator failures and propagates fatal operator-list errors with exact cleanup", async () => {
    const ordinaryFailure = await runFake([{ operatorError: new Error("synthetic operator failure") }]);
    expect(ordinaryFailure.result.pages[0]).toMatchObject({
      has_image_operations: null,
      has_vector_paint_operations: null,
      image_detection_status: "failed",
      modality_hint: "unknown",
      extraction_status: "partial",
      needs_visual_inspection: true,
      errors: [expect.objectContaining({ stage: "operators", message: "synthetic operator failure" })],
    });

    const successful = await runFake([{ items: [] }]);
    const cases = [
      { kind: "deadline", error: null },
      { kind: "abort", error: Object.assign(new Error("operator reparse cancelled"), { name: "AbortError" }) },
      { kind: "resource", error: Object.assign(new Error("operator reparse resource exhausted"), { code: "ENOMEM" }) },
    ];
    for (const testCase of cases) {
      const cleanup = { page: 0, document: 0, loading: 0 };
      const fatalPdfjs = {
        version: "5.4.624",
        OPS: { paintImageXObject: 1, constructPath: 2 },
        getDocument: () => ({
          promise: Promise.resolve({
            numPages: 1,
            getPage: async () => ({
              view: [0, 0, 612, 792],
              userUnit: 1,
              rotate: 0,
              getViewport: () => ({ width: 612, height: 792, transform: [1, 0, 0, -1, 0, 792] }),
              getTextContent: async () => ({ items: [], styles: {} }),
              getAnnotations: async () => [],
              getOperatorList: testCase.kind === "deadline"
                ? () => new Promise(() => {})
                : async () => { throw testCase.error; },
              cleanup: () => { cleanup.page += 1; },
            }),
            destroy: async () => { cleanup.document += 1; },
          }),
          destroy: async () => { cleanup.loading += 1; },
        }),
      };
      const deadlineAt = Date.now() + (testCase.kind === "deadline" ? 40 : 20000);
      const rejection = expect(validatePdfLayoutSourceEvidence(successful.result, {
        pdfjsLib: fatalPdfjs,
        sourceBytes: successful.bytes,
        deadlineAt,
      })).rejects;
      if (testCase.kind === "deadline") await rejection.toMatchObject({ code: "LAYOUT_DEADLINE" });
      else await rejection.toBe(testCase.error);
      expect(cleanup).toEqual({ page: 1, document: 1, loading: 1 });
    }
  });

  it("replays ordinary getPage and getViewport failures as failed-page IR with balanced parse lifecycles", async () => {
    const bytes = await pdfBytes(1);
    for (const stage of ["getPage", "getViewport"]) {
      const cleanup = { page: 0, document: 0, loading: 0 };
      const ordinaryError = new Error(`synthetic ordinary ${stage} failure`);
      const pdfjs = {
        version: "5.4.624",
        OPS: {},
        getDocument: () => ({
          promise: Promise.resolve({
            numPages: 1,
            getPage: async () => {
              if (stage === "getPage") throw ordinaryError;
              return {
                view: [0, 0, 612, 792],
                userUnit: 1,
                rotate: 0,
                getViewport: () => { throw ordinaryError; },
                cleanup: () => { cleanup.page += 1; },
              };
            },
            destroy: async () => { cleanup.document += 1; },
          }),
          destroy: async () => { cleanup.loading += 1; },
        }),
      };
      const result = await extractPdfLayout({
        pdfjsLib: pdfjs,
        pdfBytes: bytes,
        sourcePath: `/synthetic/${stage}-failure.pdf`,
        sourceFileName: `${stage}-failure.pdf`,
        sourceSha256: createHash("sha256").update(bytes).digest("hex"),
        maxOutputCharacters: 200000,
      });
      expect(result.pages[0]).toMatchObject({
        text_layer_status: "failed",
        image_detection_status: "failed",
        modality_hint: "unknown",
        extraction_status: "failed",
        needs_visual_inspection: true,
        raw_items: [],
        has_image_operations: null,
        has_vector_paint_operations: null,
        errors: [{ stage: "page", code: "Error", message: ordinaryError.message }],
      });
      expect(cleanup).toEqual({
        page: stage === "getViewport" ? 2 : 0,
        document: 2,
        loading: 2,
      });

      if (stage === "getPage") {
        // Exact formerly accepted relabel: inject one observed/omitted UTF-16
        // code unit into an honest failed page and mirror document aggregates.
        const injectedCharacter = structuredClone(result);
        injectedCharacter.pages[0].counts.observed_characters = 1;
        injectedCharacter.pages[0].truncation = {
          truncated: true,
          reasons: ["max_characters"],
          omitted_items: 0,
          omitted_non_whitespace_items: 0,
          omitted_characters: 1,
          first_omitted_source_index: 0,
        };
        injectedCharacter.truncation = {
          truncated: true,
          reasons: ["max_characters"],
          omitted_items: 0,
          omitted_characters: 1,
          first_omitted_page: 1,
          first_omitted_source_index: 0,
        };
        expect(() => validatePdfLayoutSemantics(injectedCharacter, { sourceBytes: bytes })).not.toThrow();
        await expect(validatePdfLayoutSourceEvidence(injectedCharacter, { pdfjsLib: pdfjs, sourceBytes: bytes }))
          .rejects.toThrow(/ordinary page failure differs from reparsed source/);

        const injectedItemCount = structuredClone(result);
        injectedItemCount.pages[0].counts.observed_items = 1;
        injectedItemCount.pages[0].counts.observed_non_whitespace_items = 1;
        injectedItemCount.pages[0].truncation = {
          truncated: true,
          reasons: ["max_items"],
          omitted_items: 1,
          omitted_non_whitespace_items: 1,
          omitted_characters: 0,
          first_omitted_source_index: 0,
        };
        injectedItemCount.truncation = {
          truncated: true,
          reasons: ["max_items"],
          omitted_items: 1,
          omitted_characters: 0,
          first_omitted_page: 1,
          first_omitted_source_index: 0,
        };
        expect(() => validatePdfLayoutSemantics(injectedItemCount, { sourceBytes: bytes })).not.toThrow();
        await expect(validatePdfLayoutSourceEvidence(injectedItemCount, { pdfjsLib: pdfjs, sourceBytes: bytes }))
          .rejects.toThrow(/ordinary page failure differs from reparsed source/);

        const forgedKnownGeometry = structuredClone(result);
        forgedKnownGeometry.pages[0].geometry.pdfjs_view = [0, 0, 612, 792];
        forgedKnownGeometry.pages[0].geometry.user_unit = 1;
        forgedKnownGeometry.pages[0].geometry.display_rotation = 0;
        forgedKnownGeometry.pages[0].geometry.rotation_matches_raw = true;
        await expect(validatePdfLayoutSourceEvidence(forgedKnownGeometry, { pdfjsLib: pdfjs, sourceBytes: bytes }))
          .rejects.toThrow(/pdfjs_view differs from reparsed source/);
      } else {
        const forgedViewport = structuredClone(result);
        forgedViewport.pages[0].geometry.display_width = 612;
        forgedViewport.pages[0].geometry.display_height = 792;
        forgedViewport.pages[0].geometry.viewport_transform = [1, 0, 0, -1, 0, 792];
        expect(() => validatePdfLayoutSemantics(forgedViewport, { sourceBytes: bytes })).not.toThrow();
        await expect(validatePdfLayoutSourceEvidence(forgedViewport, { pdfjsLib: pdfjs, sourceBytes: bytes }))
          .rejects.toThrow(/display_width differs from reparsed source/);
      }
    }
  });

  it("uses PDF.js as password authority, never echoes passwords, and destroys tasks/documents", async () => {
    const bytes = await pdfBytes(1);
    const missingRuntime = fakePdfjs([{ items: [] }], { requiredPassword: "correct-secret" });
    let missingError;
    try {
      await extractPdfLayout({
        pdfjsLib: missingRuntime.pdfjs,
        pdfBytes: bytes,
        sourcePath: "/fake.pdf",
        sourceFileName: "fake.pdf",
        sourceSha256: "0".repeat(64),
      });
    } catch (error) {
      missingError = error;
    }
    expect(missingError).toBeInstanceOf(Error);
    expect(missingError.code).toBe("PASSWORD_REQUIRED");
    expect(missingError.message).not.toContain("correct-secret");
    expect(missingRuntime.state.loading_destroyed).toBe(true);

    const wrongRuntime = fakePdfjs([{ items: [] }], { requiredPassword: "correct-secret" });
    let wrongError;
    try {
      await extractPdfLayout({
        pdfjsLib: wrongRuntime.pdfjs,
        pdfBytes: bytes,
        sourcePath: "/fake.pdf",
        sourceFileName: "fake.pdf",
        sourceSha256: "0".repeat(64),
        password: "wrong-secret",
      });
    } catch (error) {
      wrongError = error;
    }
    expect(wrongError).toBeInstanceOf(Error);
    expect(wrongError.code).toBe("PASSWORD_INCORRECT");
    expect(wrongError.message).not.toContain("wrong-secret");
    expect(wrongRuntime.state.loading_destroyed).toBe(true);

    const correctRuntime = fakePdfjs([{ items: [] }], { requiredPassword: "correct-secret" });
    const actualSha256 = createHash("sha256").update(bytes).digest("hex");
    await extractPdfLayout({
      pdfjsLib: correctRuntime.pdfjs,
      pdfBytes: bytes,
      sourcePath: "/fake.pdf",
      sourceFileName: "fake.pdf",
      sourceSha256: actualSha256,
      password: "correct-secret",
      maxOutputCharacters: 200000,
    });
    expect(correctRuntime.state).toMatchObject({ loading_destroyed: true, document_destroyed: true, page_cleanups: 2 });
    expect(correctRuntime.state.document_options).toMatchObject({
      cMapPacked: true,
      useWorkerFetch: false,
    });
    expect(correctRuntime.state.document_options.cMapUrl).toContain("pdfjs-dist/cmaps/");
    expect(correctRuntime.state.document_options.standardFontDataUrl).toContain("pdfjs-dist/standard_fonts/");
    expect(correctRuntime.state.document_options.wasmUrl).toContain("pdfjs-dist/wasm/");
  });

  it("cleans up the real PDF.js task, authenticated document, and page for the encrypted fail-soft oracle", async () => {
    const actualPdfjs = await import("pdfjs-dist/legacy/build/pdf.mjs");
    const bytes = await fs.readFile(ENCRYPTED_LAYOUT);
    const provenance = JSON.parse(await fs.readFile(ENCRYPTED_LAYOUT_PROVENANCE, "utf8"));
    for (const password of [provenance.passwords.user, provenance.passwords.owner]) {
      const { pdfjs, state } = instrumentRealPdfjs(actualPdfjs);
      const result = await extractPdfLayout({
        pdfjsLib: pdfjs,
        pdfBytes: bytes,
        sourcePath: ENCRYPTED_LAYOUT,
        sourceFileName: path.basename(ENCRYPTED_LAYOUT),
        sourceSha256: createHash("sha256").update(bytes).digest("hex"),
        password,
        requestedStartPage: 1,
        requestedEndPage: 1,
        maxOutputCharacters: 200000,
      });
      expect(state).toEqual({ loading_destroyed: 2, document_destroyed: 2, page_cleanups: 2 });
      expect(result.pages[0]).toMatchObject({
        extraction_status: "partial",
        geometry: { media_box: null, crop_box: null, pdfjs_view: [0, 0, 612, 792] },
        errors: [expect.objectContaining({ code: "RAW_PAGE_GEOMETRY_UNAVAILABLE" })],
      });
      expect(result.pages[0].flow_text).toContain("TWO COLUMN NOTICE");
      for (const testPassword of Object.values(provenance.passwords)) {
        expect(JSON.stringify(result)).not.toContain(testPassword);
      }
    }
  });

  it("destroys each real PDF.js password task exactly once on missing and wrong passwords", async () => {
    const actualPdfjs = await import("pdfjs-dist/legacy/build/pdf.mjs");
    const bytes = await fs.readFile(ENCRYPTED_LAYOUT);
    const provenance = JSON.parse(await fs.readFile(ENCRYPTED_LAYOUT_PROVENANCE, "utf8"));
    for (const testCase of [
      { password: null, code: "PASSWORD_REQUIRED" },
      { password: provenance.passwords.wrong_password_oracle, code: "PASSWORD_INCORRECT" },
    ]) {
      const { pdfjs, state } = instrumentRealPdfjs(actualPdfjs);
      await expect(extractPdfLayout({
        pdfjsLib: pdfjs,
        pdfBytes: bytes,
        sourcePath: ENCRYPTED_LAYOUT,
        sourceFileName: path.basename(ENCRYPTED_LAYOUT),
        sourceSha256: createHash("sha256").update(bytes).digest("hex"),
        password: testCase.password,
        requestedStartPage: 1,
        requestedEndPage: 1,
        maxOutputCharacters: 200000,
      })).rejects.toMatchObject({ code: testCase.code });
      expect(state).toEqual({ loading_destroyed: 1, document_destroyed: 0, page_cleanups: 0 });
    }
  });

  it("destroys a loading task on deadline", async () => {
    const bytes = await pdfBytes(1);
    const runtime = fakePdfjs([{ items: [] }], { neverLoad: true });
    await expect(extractPdfLayout({
      pdfjsLib: runtime.pdfjs,
      pdfBytes: bytes,
      sourcePath: "/fake.pdf",
      sourceFileName: "fake.pdf",
      sourceSha256: "0".repeat(64),
      deadlineMs: 5,
    })).rejects.toThrow(/deadline/);
    expect(runtime.state.loading_destroyed).toBe(true);
  });

  it("rejects strict semantic output mutations", async () => {
    const { result, bytes } = await runFake([{ items: [textItem({ text: "one", x: 10, top: 20 })] }]);
    const validator = new AjvJsonSchemaValidator().getValidator(TOOL_SUCCESS_OUTPUT_SCHEMAS.read_pdf_layout);
    expect(validator(result).valid).toBe(true);
    const mutants = [
      value => { value.ir.version = "unversioned"; },
      value => { value.parser.version = "latest"; },
      value => { value.pages[0].geometry.item_space.reference_box = "signing"; },
      value => { value.pages[0].raw_items[0].unexpected = true; },
      value => { value.pages[0].raw_items[0].bbox_status = "probably"; },
      value => { value.pages[0].reading_order.confidence = 0.9; },
    ];
    for (const mutate of mutants) {
      const mutant = structuredClone(result);
      mutate(mutant);
      expect(validator(mutant).valid).toBe(false);
    }

    const semanticMutants = [
      value => { value.id_scope.source_sha256 = "f".repeat(64); },
      value => { value.page_range.end_page = 2; },
      value => { value.pages[0].id = "p9999"; },
      value => { value.pages[0].geometry.page = 2; },
      value => { value.pages[0].geometry.display_width = -1; },
      value => { value.pages[0].geometry.viewport_transform[0] = 9; },
      value => { value.pages[0].geometry.viewport_transform[4] += 1; },
      value => {
        value.pages[0].geometry.raw_pdf_rotation = 90;
        value.pages[0].geometry.display_rotation = 90;
      },
      value => { value.pages[0].geometry.rotation_matches_raw = false; },
      value => { value.pages[0].geometry.pdfjs_view[0] += 1; },
      value => { value.pages[0].raw_items[0].id = value.pages[0].id; },
      value => { value.pages[0].raw_items[0].raw_width += 100; },
      value => { value.pages[0].raw_items[0].raw_height += 100; },
      value => { value.pages[0].raw_items[0].raw_transform[1] += 1; },
      value => { value.pages[0].raw_items[0].raw_transform[4] += 100; },
      value => { value.pages[0].raw_items[0].font.vertical = true; },
      value => { value.pages[0].raw_items[0].font.ascent = 0.25; },
      value => { value.pages[0].lines[0].item_ids[0] = "p0001-i999999"; },
      value => { value.pages[0].counts.returned_items = 999999; },
      value => { value.pages[0].counts.returned_non_whitespace_items = 999999; },
      value => { value.pages[0].truncation.reasons = ["unknown_limit"]; },
      value => { value.pages[0].raw_items[0].geometry_provenance.quad_order = "terminal_first"; },
      value => { [value.pages[0].raw_items[0].quad[0], value.pages[0].raw_items[0].quad[1]] = [value.pages[0].raw_items[0].quad[1], value.pages[0].raw_items[0].quad[0]]; },
      value => { value.pages[0].raw_items[0].bbox.x += 1; },
      value => { value.pages[0].raw_items[0].bbox.width += 1; },
      value => { value.pages[0].raw_items[0].geometry_valid = false; },
      value => { value.pages[0].raw_items[0].geometry_provenance.advance_source = "item_height"; },
      value => { value.pages[0].raw_items[0].line_id = null; },
      value => { value.pages[0].raw_items[0].reading_order_index = 99; },
      value => { value.pages[0].lines[0].text = "mutated"; },
      value => { value.pages[0].lines[0].width += 1; },
      value => { value.pages[0].lines[0].direction = "rtl"; },
      value => { value.pages[0].blocks[0].line_ids[0] = "p0001-l999999"; },
      value => { value.pages[0].blocks[0].kind = "column_flow"; },
      value => { value.pages[0].reading_order.column_count = 2; },
      value => { value.pages[0].flow_text = "mutated"; },
      value => { value.pages[0].text_layer_status = "empty"; },
      value => { value.pages[0].image_detection_status = "detected"; },
      value => { value.pages[0].modality_hint = "image-only-candidate"; },
      value => { value.pages[0].needs_visual_inspection = true; },
      value => { value.pages[0].errors.push({ stage: "geometry", code: "X", message: "x".repeat(501) }); },
      value => { value.truncation.omitted_items = 1; },
      value => { value.limits.max_items = value.id_scope.max_items = 5001; },
      value => {
        value.pages[0].extraction_status = "complete";
        value.pages[0].truncation = {
          truncated: true,
          reasons: ["max_items"],
          omitted_items: 1,
          omitted_characters: 0,
          first_omitted_source_index: 1,
        };
      },
    ];
    for (const mutate of semanticMutants) {
      const mutant = structuredClone(result);
      mutate(mutant);
      expect(() => validatePdfLayoutSemantics(mutant)).toThrow(/Invalid Extraction IR semantics/);
    }
    const actualByteMutants = [
      value => { value.source.sha256 = value.id_scope.source_sha256 = "f".repeat(64); },
      value => { value.source.size_bytes += 1; },
    ];
    for (const mutate of actualByteMutants) {
      const mutant = structuredClone(result);
      mutate(mutant);
      expect(() => validatePdfLayoutSemantics(mutant, { sourceBytes: bytes })).toThrow(/Invalid Extraction IR semantics/);
    }
    const boundaryMutants = [
      value => { value.pages[0].counts.returned_items = 999999; },
      value => { value.pages[0].raw_items[0].raw_width += 100; },
      value => { value.pages[0].raw_items[0].raw_height += 100; },
      value => { value.pages[0].raw_items[0].raw_transform[1] += 1; },
      value => { value.pages[0].raw_items[0].raw_transform[4] += 100; },
      value => { value.pages[0].geometry.viewport_transform[0] = 9; },
      value => { value.pages[0].geometry.viewport_transform[4] += 1; },
      value => {
        value.pages[0].geometry.raw_pdf_rotation = 90;
        value.pages[0].geometry.display_rotation = 90;
      },
      value => { value.pages[0].geometry.pdfjs_view[0] += 1; },
      value => { value.pages[0].raw_items[0].font.vertical = true; },
      value => { value.pages[0].raw_items[0].font.ascent = 0.25; },
      value => { value.pages[0].raw_items[0].geometry_provenance.quad_order = "terminal_first"; },
      value => { [value.pages[0].raw_items[0].quad[0], value.pages[0].raw_items[0].quad[1]] = [value.pages[0].raw_items[0].quad[1], value.pages[0].raw_items[0].quad[0]]; },
      value => { value.pages[0].raw_items[0].bbox.x += 1; },
    ];
    for (const mutate of boundaryMutants) {
      const boundaryMutant = structuredClone(result);
      mutate(boundaryMutant);
      const rejected = validateStructuredToolResult("read_pdf_layout", {
        content: [{ type: "text", text: "mutant" }],
        structuredContent: boundaryMutant,
      });
      expect(rejected).toEqual({
        content: [{
          type: "text",
          text:
            "Internal output validation failed for read_pdf_layout. "
            + "No unvalidated structured result was returned.",
        }],
        structuredContent: {
          status: "failed",
          error: {
            error_schema_version: 1,
            code: "internal_validation_error",
          },
        },
        isError: true,
      });
    }
  });

  it("rejects an otherwise reconstructed line whose baseline staircase exceeds the stable spread", async () => {
    const staircaseItems = [100, 105, 110, 115, 120].map((top, index) => textItem({
      text: `S${index + 1}`,
      x: 10 + index * 20,
      top,
      width: 12,
      hasEOL: index === 4,
      transform: [12, 2, 0, 12, 10 + index * 20, 792 - top - 12],
    }));
    const { result } = await runFake([{ items: staircaseItems }]);
    const mutant = structuredClone(result);
    const page = mutant.pages[0];
    const items = page.raw_items;
    const left = Math.min(...items.map(item => item.x));
    const top = Math.min(...items.map(item => item.y));
    const right = Math.max(...items.map(item => item.x + item.width));
    const bottom = Math.max(...items.map(item => item.y + item.height));
    const merged = {
      ...page.lines[0],
      text: "S1 S2 S3 S4 S5",
      x: Number(left.toFixed(3)),
      y: Number(top.toFixed(3)),
      width: Number((right - left).toFixed(3)),
      height: Number((bottom - top).toFixed(3)),
      item_ids: items.map(item => item.id),
    };
    page.lines = [merged];
    items.forEach((item, index) => {
      item.line_id = merged.id;
      item.column_index = 0;
      item.reading_order_index = index;
    });
    page.blocks = [{ ...page.blocks[0], kind: "page_flow", column_index: 0, line_ids: [merged.id] }];
    page.flow_text = merged.text;
    page.spatial_text = `[${merged.id} x=${merged.x} y=${merged.y} w=${merged.width} h=${merged.height}] ${merged.text}`;
    expect(() => validatePdfLayoutSemantics(mutant)).toThrow(/baseline spread mismatch/);
  });

  it("splits source-order runs when a small first glyph would make the final baseline spread invalid", async () => {
    const item = (text, x, top, size, hasEOL) => ({
      ...textItem({
        text,
        x,
        top,
        width: 10,
        hasEOL,
        transform: [size, 0, 0, size, x, 792 - top - size],
      }),
      height: size,
    });
    const { result } = await runFake([{ items: [
      item("A", 10, 98.6, 2, false),
      item("B", 25, 87, 20, false),
      item("C", 50, 89, 20, true),
    ] }]);

    expect(result.pages[0].reading_order.strategy).toBe("source_order_fallback");
    expect(result.pages[0].lines.map(line => line.item_ids)).toEqual([
      ["p0001-i000001", "p0001-i000002"],
      ["p0001-i000003"],
    ]);
    expect(() => validatePdfLayoutSemantics(result)).not.toThrow();
  });
});
