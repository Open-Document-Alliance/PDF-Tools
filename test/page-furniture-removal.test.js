import { createHash } from "node:crypto";
import { PDFDocument } from "pdf-lib";
import { describe, expect, it } from "vitest";
import { extractPdfLayout } from "../server/layout-extraction.js";
import {
  renderPdfLayoutToMarkdown,
  validateMarkdownConversionSemantics,
} from "../server/markdown-conversion.js";
import { TOOL_OUTPUT_SCHEMAS } from "../server/output-schemas.js";
import { AjvJsonSchemaValidator } from "@modelcontextprotocol/sdk/validation/ajv";

const FURNITURE_CODE = "PAGE_FURNITURE_REMOVED";

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

function textItem(text, {
  top,
  left = 50,
  width = Math.max(20, text.length * 6),
  fontSize = 12,
  fontName = "f1",
  eol = true,
} = {}) {
  return {
    str: text,
    dir: "ltr",
    width,
    height: fontSize,
    transform: [fontSize, 0, 0, fontSize, left, 792 - top - fontSize],
    fontName,
    hasEOL: eol,
  };
}

function fakePdfjs(pageConfigs) {
  const pages = pageConfigs.map(config => ({
    view: [0, 0, 612, 792],
    userUnit: 1,
    rotate: 0,
    getViewport: () => ({ scale: 1, width: 612, height: 792, transform: [1, 0, 0, -1, 0, 792] }),
    getTextContent: async () => ({
      items: config.items ?? [],
      styles: {
        f1: { fontFamily: "Test Sans", ascent: 0.8, descent: -0.2, vertical: false },
        f2: { fontFamily: "Test Serif", ascent: 0.8, descent: -0.2, vertical: false },
      },
    }),
    getOperatorList: async () => ({ fnArray: [], argsArray: [] }),
    getAnnotations: async () => [],
    cleanup: () => {},
  }));
  return {
    version: "5.4.624",
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
    getDocument: () => ({
      promise: Promise.resolve({
        numPages: pages.length,
        getPage: async pageNumber => pages[pageNumber - 1],
        destroy: async () => {},
      }),
      destroy: async () => {},
    }),
  };
}

async function syntheticLayout(pageConfigs) {
  const document = await PDFDocument.create();
  for (let index = 0; index < pageConfigs.length; index += 1) document.addPage([612, 792]);
  const bytes = await document.save({ useObjectStreams: false });
  return extractPdfLayout({
    pdfjsLib: fakePdfjs(pageConfigs),
    pdfBytes: bytes,
    sourcePath: "/validated/page-furniture.pdf",
    sourceFileName: "page-furniture.pdf",
    sourceSha256: createHash("sha256").update(bytes).digest("hex"),
    sourceSizeBytes: bytes.length,
    requestedStartPage: 1,
    requestedEndPage: pageConfigs.length,
    maxOutputCharacters: 200000,
  });
}

function body(prefix = "Body") {
  return [
    textItem(`${prefix} paragraph one provides enough ordinary source text.`, { top: 130 }),
    textItem(`${prefix} paragraph two remains part of the document body.`, { top: 160 }),
    textItem(`${prefix} paragraph three establishes the body text block.`, { top: 190 }),
  ];
}

describe("evidence-bounded page furniture removal", () => {
  it.each(["footer", "header"])("retains competing bare numbers in the %s across repeated pages", async band => {
    const top = band === "footer" ? 712 : 22;
    const pages = [1, 2].map(() => ({ items: [
      ...body(),
      textItem("4", { top, left: 50, width: 8, fontSize: 9 }),
      textItem("5", { top: top + 24, left: 50, width: 8, fontSize: 9 }),
      textItem("9", { top: top + 1, left: 350, width: 8, fontSize: 9 }),
      textItem("10", { top: top + 25, left: 350, width: 12, fontSize: 9 }),
    ] }));
    const layout = await syntheticLayout(pages);
    for (const compact of [false, true]) {
      for (const removePageFurniture of [false, true]) {
        const result = renderPdfLayoutToMarkdown(layout, { includePageBoundaries: false, compact, removePageFurniture });
        for (const value of ["4", "5", "9", "10"]) {
          expect(result.markdown.split("\n").filter(line => line === value)).toHaveLength(2);
        }
        expect(result.normalizations.page_number_lines_removed).toBe(0);
        expect(result.normalizations.running_header_lines_removed).toBe(0);
        expect(result.normalizations.running_footer_lines_removed).toBe(0);
        expect(validateMarkdownConversionSemantics(structuredClone(result), { layout })).toEqual(result);
      }
    }
  });

  it("counts a protected oversized label when deciding if its neighbour is ambiguous", async () => {
    const layout = await syntheticLayout([{ items: [
      ...body(),
      textItem("IV", { top: 710, fontSize: 24 }),
      textItem("V", { top: 742, fontSize: 9 }),
      textItem("VI", { top: 764, fontSize: 9 }),
    ] }]);
    const result = renderPdfLayoutToMarkdown(layout, { includePageBoundaries: false, compact: true });
    expect(result.markdown).toContain("IV");
    expect(result.markdown).toMatch(/^VI$/mu);
    expect(result.normalizations.page_number_lines_removed).toBe(0);
  });

  it("retains an ordinary isolated bare page number removal and a labelled footer alongside ambiguous numbers", async () => {
    const layout = await syntheticLayout([{ items: [
      textItem("7", { top: 22, fontSize: 9 }),
      ...body(),
      textItem("4", { top: 710, fontSize: 9 }),
      textItem("5", { top: 735, fontSize: 9 }),
      textItem("Page 7 of 12", { top: 765, fontSize: 9 }),
    ] }]);
    const result = renderPdfLayoutToMarkdown(layout, { includePageBoundaries: false });
    expect(result.markdown).toMatch(/^4$/mu);
    expect(result.markdown).toMatch(/^5$/mu);
    expect(result.markdown).not.toMatch(/^7$/mu);
    expect(result.markdown).not.toContain("Page 7 of 12");
    expect(result.normalizations.page_number_lines_removed).toBe(2);
  });

  it("removes explicit page/provenance furniture by default and reports every kind", async () => {
    const layout = await syntheticLayout([{
      items: [
        ...body(),
        textItem("© 2026 Example Journal. All rights reserved.", { top: 735, fontSize: 9 }),
        textItem("Page 6 / 12", { top: 765, left: 275, width: 62, fontSize: 9 }),
      ],
    }]);
    const result = renderPdfLayoutToMarkdown(layout, { includePageBoundaries: false });

    expect(result.markdown).not.toContain("Example Journal");
    expect(result.markdown).not.toContain("Page 6 / 12");
    expect(result.markdown).toContain("Body paragraph one");
    expect(result.gaps).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: FURNITURE_CODE, page: 1 }),
    ]));
    expect(result.normalizations).toMatchObject({
      page_number_lines_removed: 1,
      running_header_lines_removed: 0,
      running_footer_lines_removed: 1,
      page_furniture_pages: [1],
    });
    expect(result.pages[0]).toMatchObject({ line_count: 5, rendered_line_count: 3 });
    expect(validateMarkdownConversionSemantics(structuredClone(result), { layout })).toEqual(result);

    const successSchema = TOOL_OUTPUT_SCHEMAS.convert_pdf_to_markdown.anyOf[0];
    const schemaResult = new AjvJsonSchemaValidator().getValidator({
      type: "object",
      properties: {
        renderer: successSchema.properties.renderer,
        options: successSchema.properties.options,
        pages: successSchema.properties.pages,
        gaps: successSchema.properties.gaps,
        normalizations: successSchema.properties.normalizations,
      },
      required: ["renderer", "options", "pages", "gaps", "normalizations"],
      additionalProperties: false,
    })({
      renderer: result.renderer,
      options: result.options,
      pages: result.pages,
      gaps: result.gaps,
      normalizations: result.normalizations,
    });
    expect(schemaResult.valid).toBe(true);
  });

  it("uses same-band cross-page repetition for arbitrary running text", async () => {
    const layout = await syntheticLayout([
      {
        items: [
          textItem("Quarterly Operations Review", { top: 24, fontSize: 9 }),
          ...body("First"),
          textItem("Confidential 2026", { top: 762, fontSize: 9 }),
        ],
      },
      {
        items: [
          textItem("Quarterly Operations Review", { top: 24, fontSize: 9 }),
          ...body("Second"),
          textItem("Confidential 2027", { top: 762, fontSize: 9 }),
        ],
      },
    ]);
    const result = renderPdfLayoutToMarkdown(layout, { includePageBoundaries: false });

    expect(result.markdown).not.toContain("Quarterly Operations Review");
    expect(result.markdown).not.toContain("Confidential");
    expect(result.markdown).toContain("First paragraph one");
    expect(result.markdown).toContain("Second paragraph one");
    expect(result.normalizations).toMatchObject({
      running_header_lines_removed: 2,
      running_footer_lines_removed: 2,
      page_furniture_pages: [1, 2],
    });
    expect(result.gaps.filter(gap => gap.code === FURNITURE_CODE)).toHaveLength(2);
  });

  it("preserves a genuine top heading and a reconstructed table row near the bottom margin", async () => {
    const tableItems = [
      ["REGION", "TOTAL"],
      ["North", "120"],
      ["South", "95"],
    ].flatMap((row, rowIndex) => row.map((value, columnIndex) => textItem(value, {
      top: 680 + rowIndex * 28,
      left: 70 + columnIndex * 190,
      width: 90,
      fontSize: rowIndex === 0 ? 14 : 11,
      eol: columnIndex === row.length - 1,
    })));
    const layout = await syntheticLayout([{
      items: [
        textItem("Annual Safety Report", { top: 28, left: 170, width: 272, fontSize: 24, fontName: "f2" }),
        ...body(),
        ...tableItems,
      ],
    }]);
    const result = renderPdfLayoutToMarkdown(layout, { includePageBoundaries: false });

    expect(result.markdown).toContain("# Annual Safety Report");
    expect(result.markdown).toContain("| REGION | TOTAL |");
    expect(result.markdown).toContain("| South | 95 |");
    expect(result.gaps.map(gap => gap.code)).not.toContain(FURNITURE_CODE);
    expect(result.normalizations.page_furniture_pages).toEqual([]);
  });

  it("preserves an ambiguous bare Roman glyph instead of guessing it is a page number", async () => {
    const layout = await syntheticLayout([{
      items: [
        ...body(),
        textItem("I", { top: 762, left: 72, width: 8, fontSize: 9 }),
      ],
    }]);
    const result = renderPdfLayoutToMarkdown(layout, { includePageBoundaries: false });

    expect(result.markdown).toContain("I");
    expect(result.gaps.map(gap => gap.code)).not.toContain(FURNITURE_CODE);
    expect(result.normalizations.page_number_lines_removed).toBe(0);
  });

  it("preserves a long provenance sentence that may carry referenced content", async () => {
    const provenance = "© 2019 Example Publisher. All rights reserved. Document downloaded on 19 May 2019; redistribution is prohibited by the source.";
    const layout = await syntheticLayout([{
      items: [
        ...body(),
        textItem(provenance, { top: 762, left: 36, width: 540, fontSize: 9 }),
      ],
    }]);
    const result = renderPdfLayoutToMarkdown(layout, { includePageBoundaries: false });

    expect(result.markdown).toContain(provenance);
    expect(result.gaps.map(gap => gap.code)).not.toContain(FURNITURE_CODE);
    expect(result.normalizations.running_footer_lines_removed).toBe(0);
  });

  it("offers an exact opt-out that preserves every source line", async () => {
    const layout = await syntheticLayout([{
      items: [
        textItem("ARTICLE IN PRESS", { top: 22, fontSize: 9 }),
        ...body(),
        textItem("Page 2 of 8", { top: 762, fontSize: 9 }),
      ],
    }]);
    const result = renderPdfLayoutToMarkdown(layout, {
      includePageBoundaries: false,
      removePageFurniture: false,
    });

    expect(result.markdown).toContain("ARTICLE IN PRESS");
    expect(result.markdown).toContain("Page 2 of 8");
    expect(result.options.remove_page_furniture).toBe(false);
    expect(result.gaps.map(gap => gap.code)).not.toContain(FURNITURE_CODE);
    expect(result.normalizations).toMatchObject({
      page_number_lines_removed: 0,
      running_header_lines_removed: 0,
      running_footer_lines_removed: 0,
      page_furniture_pages: [],
    });
  });
});
