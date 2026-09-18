import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import path from "node:path";
import { PDFDocument, PDFName, PDFNumber, StandardFonts, degrees } from "pdf-lib";
import * as pdfjsLib from "pdfjs-dist/legacy/build/pdf.mjs";
import { describe, expect, it } from "vitest";
import * as sourceLayout from "../server/layout-extraction.js";
import * as shareLayout from "../pdf-toolkit-mcp-share/server/layout-extraction.js";
import { renderPdfLayoutToMarkdown as sourceMarkdown } from "../server/markdown-conversion.js";
import { renderPdfLayoutToMarkdown as shareMarkdown } from "../pdf-toolkit-mcp-share/server/markdown-conversion.js";

const require = createRequire(import.meta.url);
const standardFontDataUrl = sourceLayout.pdfjsFactoryDirectory(path.join(
  path.dirname(require.resolve("pdfjs-dist/package.json")), "standard_fonts",
));
// The unbuilt share source has no installed asset tree of its own. Both
// mirrors must parse with the same real pinned font assets, not silently
// compare a loaded standard font against PDF.js fallback metrics.
const parser = {
  ...pdfjsLib,
  getDocument: options => pdfjsLib.getDocument({ ...options, standardFontDataUrl }),
};

async function splitRunPdf({ rotation, offset, gap, short }) {
  const document = await PDFDocument.create();
  const regular = await document.embedFont(StandardFonts.Helvetica);
  const bold = await document.embedFont(StandardFonts.HelveticaBold);
  const page = document.addPage([612, 792]);
  page.setRotation(degrees(rotation));
  if (offset) {
    page.setMediaBox(-10, -20, 612, 792);
    page.setCropBox(30, 40, 550, 700);
    page.node.set(PDFName.of("UserUnit"), PDFNumber.of(2));
  }
  const first = short ? "." : "Alpha";
  const second = short ? "." : "Beta";
  page.drawText(first, { x: 80, y: 650, size: 12, font: regular });
  page.drawText(second, {
    x: 80 + regular.widthOfTextAtSize(first, 12) + gap,
    y: 650,
    size: 12,
    font: bold,
  });
  return document.save({ useObjectStreams: false });
}

const cases = [0, 90, 180, 270].flatMap(rotation => [false, true].flatMap(offset =>
  [false, true].flatMap(short => [short ? 2.5 : 4, 0, -1].map(gap => ({ rotation, offset, gap, short }))),
));

describe("source-backed word spacing under page rotation", () => {
  it.each(cases)("preserves split runs at $rotation degrees, offset=$offset, gap=$gap, short=$short", async ({ rotation, offset, gap, short }) => {
    const bytes = await splitRunPdf({ rotation, offset, gap, short });
    const options = {
      pdfjsLib: parser,
      pdfBytes: bytes,
      sourcePath: "/synthetic/rotated-split-runs.pdf",
      sourceFileName: "rotated-split-runs.pdf",
      sourceSha256: createHash("sha256").update(bytes).digest("hex"),
      maxOutputCharacters: 200000,
    };
    const source = await sourceLayout.extractPdfLayout(options);
    const share = await shareLayout.extractPdfLayout(options);
    expect(share).toEqual(source);
    await sourceLayout.validatePdfLayoutSourceEvidence(source, { pdfjsLib: parser, sourceBytes: bytes });
    const page = source.pages[0];
    expect(page.geometry).toMatchObject({ display_rotation: rotation, user_unit: offset ? 2 : 1 });
    expect(page.raw_items.filter(item => !item.is_whitespace).map(item => item.text)).toEqual(short ? [".", "."] : ["Alpha", "Beta"]);
    if (gap > 0) expect(page.raw_items.some(item => item.text === " ")).toBe(true);
    // Line grouping is unchanged. Long quarter-turned runs stay on separate
    // source-order lines; short ones can already share a line and must retain
    // their positive gaps too. Touching/overlapping runs gain no separator.
    const expected = short
      ? gap > 0 ? ". ." : ".."
      : rotation === 90 || rotation === 270
        ? "Alpha\nBeta"
        : gap > 0 ? "Alpha Beta" : "AlphaBeta";
    expect(page.flow_text).toBe(expected);
    const rendered = sourceMarkdown(source, { includePageBoundaries: false });
    expect(shareMarkdown(share, { includePageBoundaries: false })).toEqual(rendered);
    expect(rendered.markdown.split("\n\n## Conversion")[0]).toBe(expected);
  });
});
