import { describe, expect, it } from "vitest";
import { PDFDocument, StandardFonts, setTextRenderingMode, pushGraphicsState, popGraphicsState } from "pdf-lib";
import * as pdfjs from "pdfjs-dist/legacy/build/pdf.mjs";
import { analyzePdfPages, classifyPageRouting, deriveTextIntegrityForRouting, measureTextVisibility } from "../server/helpers.js";
import { readContentFromDocument } from "../server/pdfjs-worker.js";

const { OPS } = pdfjs;
const show = value => [OPS.showText, [[{ unicode: value }]]];
const mode = value => [OPS.setTextRenderingMode, [value]];
const ops = entries => ({ fnArray: entries.map(entry => entry[0]), argsArray: entries.map(entry => entry[1]) });
const measure = entries => measureTextVisibility(pdfjs, ops(entries));

describe("invisible text routing without OCR or language judgments", () => {
  it.each(["Ordinary English", "日本語の文章", "العربية", "हिन्दी", "Ελληνικά", "математика", "x + y = 2"])("does not judge visible %s", text => {
    expect(measure([show(text)])).toEqual({ status: "available", invisible_text_show_count: 0, other_text_show_count: 1 });
    expect(deriveTextIntegrityForRouting([text]).status).toBe("ok");
  });

  it("distinguishes hidden from mixed text without claiming corruption", () => {
    expect(measure([mode(3), show("accurate searchable transcription"), mode(0), show("visible caption")]))
      .toEqual({ status: "available", invisible_text_show_count: 1, other_text_show_count: 1 });
    expect(measure([mode(3), show("\n "), [OPS.showText, [[120, -20]]]])).toMatchObject({ invisible_text_show_count: 0 });
  });

  it("tracks saved state and forms, but beginText does not reset text rendering mode", () => {
    expect(measure([
      mode(3), [OPS.save, []], mode(0), show("visible"), [OPS.restore, []],
      [OPS.beginText, []], show("hidden"), [OPS.paintFormXObjectBegin, []],
      mode(0), show("form visible"), [OPS.paintFormXObjectEnd, []], show("hidden again"),
    ])).toEqual({ status: "available", invisible_text_show_count: 2, other_text_show_count: 2 });
  });

  it("does not confuse clipping-only mode 7 with invisible mode 3", () => {
    expect(measure([mode(7), show("clip")])).toMatchObject({ invisible_text_show_count: 0, other_text_show_count: 1 });
  });

  it("does not let transparency-group state leak or erase inherited invisibility", () => {
    for (const entries of [
      [[OPS.beginGroup, []], mode(3), show("hidden in group"), [OPS.endGroup, []], show("outside")],
      [mode(3), [OPS.beginGroup, []], mode(0), show("group"), [OPS.endGroup, []], show("outside")],
    ]) expect(measure(entries).status).toBe("unavailable");
  });

  it("abstains on optional-content state, but not ordinary semantic marked content", () => {
    expect(measure([[OPS.beginMarkedContentProps, ["OC", {}]], mode(3), show("layer")]).status).toBe("unavailable");
    expect(measure([[OPS.beginMarkedContentProps, null], show("layer")]).status).toBe("unavailable");
    expect(measure([[OPS.beginMarkedContentProps, ["Span", {}]], mode(3), show("text")])).toMatchObject({ status: "available", invisible_text_show_count: 1 });
  });

  it("routes unmeasured visibility without calling successful text extraction failed", () => {
    const page = { content_analysis_status: "complete", text_extraction_status: "complete",
      image_detection_status: "complete", graphics_detection_status: "complete",
      text_length: 200, image_op_count: 0, path_op_count: 0, path_segment_count: 0,
      text_integrity: { status: "ok", signals: [] }, text_visibility: measureTextVisibility(null, null) };
    expect(classifyPageRouting(page)).toEqual({ text_bearing: true, reasons: ["text_visibility_unavailable"] });
  });

  it.each([
    [[OPS.restore, []]], [[OPS.save, []]], [mode(8)], [mode("3")],
    [[OPS.showText, [null]]], [[OPS.beginAnnotation, []]],
  ])("keeps unsupported or malformed state unavailable: %j", (...entries) => {
    expect(measure(entries).status).toBe("unavailable");
  });

  it("does not present absent operators as a measured zero", () => {
    expect(measureTextVisibility(null, ops([])).status).toBe("unavailable");
    expect(measureTextVisibility(pdfjs, { fnArray: [OPS.showText], argsArray: [] }).status).toBe("unavailable");
  });

  it("preserves text and distinguishes failed visibility analysis from failed text extraction", async () => {
    const result = await readContentFromDocument({ numPages: 1, getPage: async () => ({
      getTextContent: async () => ({ items: [{ str: "Keep this exact text" }] }),
      getOperatorList: async () => { throw new Error("bounded operator failure"); }, cleanup() {},
    }) }, { max_pages: null }, pdfjs);
    expect(result.output_text).toBe("Keep this exact text");
    expect(result.pages_read).toBe(1);
    expect(result.page_read_error).toBe(null);
    expect(result.pages_with_unavailable_text_visibility).toEqual([1]);
    expect(result.pages_with_invisible_text).toEqual([]);
  });

  it("routes only read pages and preserves earlier invisible evidence on later read failure", async () => {
    const document = { numPages: 2, getPage: async page => {
      if (page === 2) throw new Error("read failure");
      return { getTextContent: async () => ({ items: [{ str: "Exact hidden text" }] }),
        getOperatorList: async () => ops([mode(3), show("Exact hidden text")]), cleanup() {} };
    } };
    const result = await readContentFromDocument(document, { max_pages: null }, pdfjs);
    expect(result.pages_with_invisible_text).toEqual([{ page: 1, status: "available", invisible_text_show_count: 1, other_text_show_count: 0 }]);
    expect(result.page_read_error.page).toBe(2);
    expect((await readContentFromDocument(document, { max_pages: 1 }, pdfjs)).page_read_error).toBe(null);
  });

  it("measures a real searchable PDF, preserves its text and does not call it bad OCR", async () => {
    const doc = await PDFDocument.create();
    const font = await doc.embedFont(StandardFonts.Helvetica);
    const image = await doc.embedPng(Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScLttAAAAABJRU5ErkJggg==", "base64"));
    const hidden = doc.addPage([200, 200]);
    hidden.drawImage(image, { x: 0, y: 0, width: 200, height: 200 });
    hidden.pushOperators(pushGraphicsState(), setTextRenderingMode(3));
    hidden.drawText("Accurate searchable text", { x: 10, y: 100, size: 10, font });
    hidden.pushOperators(popGraphicsState());
    const visible = doc.addPage([200, 200]);
    visible.drawImage(image, { x: 0, y: 0, width: 10, height: 10 });
    visible.drawText("Clean native text with a small image", { x: 10, y: 100, size: 8, font });
    const bytes = await doc.save();
    const parsed = await pdfjs.getDocument({ data: bytes.slice(), verbosity: 0 }).promise;
    try {
      const read = await readContentFromDocument(parsed, { max_pages: null }, pdfjs);
      expect(read.output_text).toContain("Accurate searchable text");
      expect(read.pages_with_invisible_text.map(page => page.page)).toEqual([1]);
      expect(read.pages_with_suspected_text_integrity).toEqual([]);
      expect(read.pages_with_unavailable_text_visibility).toEqual([]);
    } finally { await parsed.destroy(); }
    const analysis = await analyzePdfPages({ pdfLibPages: doc.getPages(), pdfBytes: bytes, pdfjsLib: pdfjs });
    expect(analysis.pages[0].text_integrity.status).toBe("ok");
    expect(classifyPageRouting(analysis.pages[0]).reasons).toContain("invisible_text_layer");
    expect(classifyPageRouting(analysis.pages[1]).reasons).not.toContain("invisible_text_layer");
  });
});
