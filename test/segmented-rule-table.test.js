import { createHash } from "node:crypto";
import { PDFDocument, StandardFonts } from "pdf-lib";
import * as pdfjsLib from "pdfjs-dist/legacy/build/pdf.mjs";
import { describe, expect, it } from "vitest";
import { extractPdfLayoutForMarkdown } from "../server/layout-extraction.js";
import { renderPdfLayoutToMarkdown, validateMarkdownConversionSemantics } from "../server/markdown-conversion.js";

async function fixture(options = {}) {
  const document = await PDFDocument.create();
  const font = await document.embedFont(StandardFonts.Helvetica);
  for (let number = 0; number < (options.pages ?? 1); number += 1) {
    const page = document.addPage([612, 792]);
    const text = (value, x, top, size = 8) => page.drawText(value, { x, y: 792 - top - size, size, font });
    const rule = (x1, x2, top) => page.drawLine({ start: { x: x1, y: 792 - top }, end: { x: x2, y: 792 - top }, thickness: 0.5 });
    if (!options.noCaption) text(number ? "TABLE. (Continued) Example" : "TABLE. Example", 50, 75, 10);
    rule(50, 500, 100);
    if (options.unsegmented) rule(50, 500, 140);
    else {
      rule(50, options.brokenRule ? 178 : 180, 140);
      rule(180, 330, 140);
      rule(330, 500, 140);
    }
    if (!options.noBottom) {
      rule(50, 180, 270); rule(180, 330, 270); rule(330, 500, 270);
    }
    if (options.extraRule) rule(180, 330, 220);
    if (options.verticalRule) page.drawLine({ start: { x: 220, y: 640 }, end: { x: 220, y: 525 }, thickness: 0.5 });
    text(options.numericHeader ? "2020" : "Characteristic", 55, 123);
    text(options.numericHeader ? "111" : "Average monthly", 195, 108);
    if (!options.missingHeader) text(options.numericHeader ? "222" : "visits", 210, 121);
    if (!options.emptyHeaderColumn && !(number === 1 && options.missingSecondHeader)) {
      text(options.numericHeader ? "333" : number === 1 && options.changedSecondHeader ? "Rate" : "Ratio",
        options.spanningHeader ? 323 : 370, options.headerCrossesRule ? 136 : 123);
    }
    if (options.headerOverprint) text("OVERPRINT", 370, 123);
    text("Age groups", 55, 148);
    text("20-29", 55, 160);
    const data = [["2021", "1,234", "Ref"], ["2022", "987", "0.98 (0.9-1.1)"], ["2023", "1,087", "1.01 (1.0-1.1)"], ["2024", "1,187", "a|b <c>"]];
    data.forEach((row, rowIndex) => row.forEach((value, column) => {
      if (options.missingCell && rowIndex === 1 && column === 1) return;
      if (options.bareDataLabel && rowIndex === 1 && column > 0) return;
      const right = [100, 285, 445][column];
      text(value, options.crossingCell && rowIndex === 1 && column === 1 ? 175 : right - font.widthOfTextAtSize(value, 8), 180 + rowIndex * 20);
    }));
    if (options.bodyOverprint) text("999", 278, 200);
    if (options.bodyCrossesRule) text("straddles", 55, 267);
    if (options.trailingLabel) text("Unattached group", 55, 257);
    text("Footnote outside the closing rule.", 50, 280);
  }
  const pdfBytes = await document.save({ useObjectStreams: false });
  const layout = await extractPdfLayoutForMarkdown({ pdfjsLib, pdfBytes,
    sourcePath: "/synthetic/segmented-rule.pdf", sourceFileName: "segmented-rule.pdf",
    sourceSha256: createHash("sha256").update(pdfBytes).digest("hex"),
    sourceSizeBytes: pdfBytes.length, requestedEndPage: options.pages ?? 1,
    maxItems: 5000, maxCharacters: 100000, maxOutputCharacters: 200000 });
  const result = renderPdfLayoutToMarkdown(layout, { includePageBoundaries: false });
  expect(validateMarkdownConversionSemantics(result, { layout })).toBe(result);
  return result;
}

describe("captioned segmented-rule tables", () => {
  it("retains multiline headers, source label rows, right-aligned values and escaped content", async () => {
    const result = await fixture();
    expect(result.markdown).toContain("| Characteristic | Average monthly<br>visits | Ratio |\n| --- | --- | --- |");
    expect(result.markdown).toContain("| Age groups |  |  |\n| 20-29 |  |  |\n| 2021 | 1,234 | Ref |");
    expect(result.markdown).toContain("| 2022 | 987 | 0.98 (0.9-1.1) |");
    expect(result.markdown).toContain("| 2024 | 1,187 | a\\|b &lt;c&gt; |");
    expect(result.markdown).toContain("Footnote outside the closing rule.");
    expect(result.markdown).not.toContain("| Footnote");
    expect(result.gaps.map(gap => gap.code)).not.toContain("TABLE_TOPOLOGY_UNKNOWN");
  });

  it("rebuilds each continuation page from its own repeated header", async () => {
    const result = await fixture({ pages: 2, changedSecondHeader: true });
    expect(result.markdown.match(/\| Characteristic \|/gu)).toHaveLength(2);
    expect(result.markdown.match(/\| 2021 \| 1,234 \| Ref \|/gu)).toHaveLength(2);
    expect(result.markdown).toContain("TABLE. (Continued) Example");
    expect(result.markdown).toContain("| Characteristic | Average monthly<br>visits | Ratio |");
    expect(result.markdown).toContain("| Characteristic | Average monthly<br>visits | Rate |");
  });

  it("does not inherit a first-page header to complete the next page", async () => {
    const result = await fixture({ pages: 2, missingSecondHeader: true });
    expect(result.markdown.match(/\| Characteristic \|/gu)).toHaveLength(1);
    expect(result.markdown.match(/\| 2021 \| 1,234 \| Ref \|/gu)).toHaveLength(1);
  });

  it.each([
    "noCaption", "noBottom", "unsegmented", "brokenRule", "extraRule",
    "verticalRule", "emptyHeaderColumn", "numericHeader", "spanningHeader",
    "missingCell", "bareDataLabel", "crossingCell", "trailingLabel",
    "headerOverprint", "bodyOverprint", "headerCrossesRule", "bodyCrossesRule",
  ])("does not invent a table when %s removes or contradicts evidence", async option => {
    const result = await fixture({ [option]: true });
    expect(result.markdown).not.toContain("| --- | --- | --- |");
    expect(result.markdown).toContain("2021");
    expect(result.markdown).toContain("1,234");
    expect(result.markdown).toContain("Footnote outside the closing rule.");
  });
});
