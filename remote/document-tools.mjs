/** Stateless adapters over the existing PDF Tools byte and extraction engines. */
import { createHash } from "node:crypto";
import { PDFDocument, degrees } from "pdf-lib";
import { detectXfaFormInDocument, detectExistingSignatures } from "../server/helpers.js";
import { extractPdfLayoutForMarkdown } from "../server/layout-extraction.js";
import { renderPdfLayoutToMarkdown } from "../server/markdown-conversion.js";

export const MAX_READ_PAGES = 10;
export const MAX_RETURNED_TEXT_BYTES = 50_000;
export const MAX_MERGE_DOCUMENTS = 5;
const MAX_MERGE_BYTES = 25 * 1024 * 1024;
const sha256 = bytes => createHash("sha256").update(bytes).digest("hex");
const RANGE_PROPERTIES = {
  start_page: { type: "integer", minimum: 1, description: "First page, starting at 1. Default 1." },
  end_page: { type: "integer", minimum: 1, description: "Last page inclusive. Default first page. At most 10 pages per call." },
};

export function createDocumentTools({ PDF_INPUT_PROPERTIES, resolveBytes, loadDocument, ok, ToolRefusal, MAX_PAGES, MAX_INLINE_PDF_BYTES }) {
  const fail = (code, message) => { throw new ToolRefusal(code, message); };
  function pageSelection(value, total) {
    if (!Array.isArray(value) || !value.length || value.length > MAX_PAGES
      || value.some(page => !Number.isSafeInteger(page) || page < 1 || page > total)
      || new Set(value).size !== value.length) {
      fail("INVALID_PAGES", "Supply unique 1-based page numbers within the document.");
    }
    return value;
  }
  function range(args, total) {
    const start = args.start_page ?? 1;
    const end = args.end_page ?? start;
    if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start < 1 || end < start || end > total || end - start + 1 > MAX_READ_PAGES) {
      fail("INVALID_PAGE_RANGE", "Request a valid inclusive range of at most 10 pages.");
    }
    return [start, end];
  }
  async function input(args) {
    const bytes = await resolveBytes(args);
    const document = await loadDocument(bytes);
    return { bytes, document, source: { sha256: sha256(bytes), size_bytes: bytes.length, page_count: document.getPageCount() } };
  }
  async function layout(args) {
    const { bytes, document, source } = await input(args);
    const [start, end] = range(args, document.getPageCount());
    const pdfjs = await import("pdfjs-dist/legacy/build/pdf.mjs");
    // Prevent parser warnings from placing document-derived values in logs.
    const pdfjsLib = { ...pdfjs, getDocument: options => pdfjs.getDocument({ ...options, verbosity: 0 }) };
    const extracted = await extractPdfLayoutForMarkdown({
      pdfjsLib, pdfBytes: bytes, sourcePath: "request.pdf", sourceFileName: "request.pdf",
      sourceSha256: source.sha256, requestedStartPage: start, requestedEndPage: end,
      maxItems: 2000, maxCharacters: 40000, maxOutputCharacters: 100000, deadlineMs: 20000,
    });
    return { extracted, source, coverage: {
      start_page: start, end_page: end, total_pages: source.page_count,
      unselected_pages: source.page_count - (end - start + 1),
      whole_document_selected: start === 1 && end === source.page_count,
    } };
  }
  function boundedText(text) {
    if (Buffer.byteLength(text, "utf8") > MAX_RETURNED_TEXT_BYTES) {
      fail("OUTPUT_TOO_LARGE", "The selected text exceeds the output limit. Request fewer pages.");
    }
    return text;
  }
  function mutationAllowed(document) {
    if (detectXfaFormInDocument(document).present) fail("XFA_DOCUMENT", "Page changes are refused for XFA PDFs because this engine cannot preserve the XFA layer.");
    if (detectExistingSignatures(document).present) {
      fail("SIGNED_DOCUMENT", "This PDF has a detected signature field. Page changes could invalidate it; use the local review workflow.");
    }
  }
  async function output(document, source, extra) {
    const bytes = await document.save();
    if (bytes.length > MAX_INLINE_PDF_BYTES) fail("OUTPUT_TOO_LARGE", "The result exceeds the 3 MB output limit. Select fewer pages or use local PDF Tools.");
    return ok("Created a new PDF copy. The source was not changed.", {
      ...extra, source, output: { sha256: sha256(bytes), size_bytes: bytes.length, page_count: document.getPageCount() },
      pdf_base64: Buffer.from(bytes).toString("base64"),
    });
  }
  const readTool = (name, description, properties, required, handler) => ({
    name, description, inputSchema: { type: "object", properties: { ...PDF_INPUT_PROPERTIES, ...properties }, required },
    annotations: { readOnlyHint: true }, handler,
  });
  const pagesSchema = { type: "array", minItems: 1, maxItems: MAX_PAGES, uniqueItems: true, items: { type: "integer", minimum: 1 } };
  return [
    readTool("get_pdf_info", "Use this to inspect an explicitly supplied PDF's page count, page sizes, rotation, form count and exact source identity. Runs remotely without storing the PDF.", {}, [], async args => {
      const { document, source } = await input(args);
      return ok(`PDF with ${source.page_count} pages.`, { source,
        pages: document.getPages().map((page, index) => ({ page: index + 1, ...page.getSize(), rotation: page.getRotation().angle })),
        form_field_count: document.getForm().getFields().length,
      });
    }),
    readTool("read_pdf_pages", "Use this to read text from up to 10 selected PDF pages. Reports exact source, page coverage, extraction errors and truncation. No OCR; empty text is not proof of an empty page.", RANGE_PROPERTIES, [], async args => {
      const { extracted, source, coverage } = await layout(args);
      const pages = extracted.pages.map(page => ({ page: page.page, text: page.flow_text, extraction_status: page.extraction_status, truncation: page.truncation, errors: page.errors, limitations: page.limitations }));
      const text = boundedText(pages.map(page => `Page ${page.page}\n${page.text}`).join("\n\n"));
      return ok(text || "No text layer was returned. OCR was not performed.", { source, coverage, pages, extraction_status: extracted.extraction_status, truncation: extracted.truncation, ocr_performed: false });
    }),
    readTool("search_pdf_text", "Use this to find literal text in up to 10 selected PDF pages, with page numbers and excerpts. A no-match result applies only to the selected extracted text, not unseen or image-only content.", { ...RANGE_PROPERTIES, query: { type: "string", minLength: 1, maxLength: 200 } }, ["query"], async args => {
      if (typeof args.query !== "string" || !args.query.trim() || args.query.length > 200) fail("INVALID_QUERY", "Supply nonempty literal text of at most 200 characters.");
      const { extracted, source, coverage } = await layout(args);
      const matches = [];
      let observed = 0;
      for (const page of extracted.pages) {
        let offset = 0;
        for (;;) {
          const found = page.flow_text.indexOf(args.query, offset);
          if (found === -1) break;
          observed++;
          if (matches.length < 100) matches.push({ page: page.page, offset: found, quote: page.flow_text.slice(Math.max(0, found - 80), found + args.query.length + 80) });
          offset = found + args.query.length;
        }
      }
      return ok(`Found ${observed} literal matches in the selected text. Unselected and image-only content was not searched.`, {
        source, coverage, matches, observed_matches: observed, omitted_matches: observed - matches.length,
        extraction_status: extracted.extraction_status, truncation: extracted.truncation, ocr_performed: false,
      });
    }),
    readTool("convert_pdf_to_markdown", "Use this to convert up to 10 PDF pages to source-backed Markdown with the existing PDF Tools renderer. Reports gaps for ambiguous tables, math, images and absent text. No OCR or completeness claim.", RANGE_PROPERTIES, [], async args => {
      const { extracted, source, coverage } = await layout(args);
      let conversion;
      try {
        conversion = renderPdfLayoutToMarkdown(extracted, { maxMarkdownBytes: MAX_RETURNED_TEXT_BYTES });
      } catch (error) {
        if (error instanceof RangeError && /^Markdown output is .* exceeds maxMarkdownBytes/.test(error.message)) {
          fail("OUTPUT_TOO_LARGE", "The selected Markdown exceeds the output limit. Request fewer pages.");
        }
        throw error;
      }
      return ok(conversion.markdown, { source, coverage, ...conversion, ocr_performed: false });
    }),
    {
      name: "select_pdf_pages", description: "Use this to split or reorder a PDF by listing the exact pages to keep in their desired order. Returns a new copy, never modifies the source. Duplicate pages and signed/XFA documents are refused.",
      inputSchema: { type: "object", properties: { ...PDF_INPUT_PROPERTIES, page_numbers: pagesSchema }, required: ["page_numbers"] },
      annotations: { readOnlyHint: false }, async handler(args) {
        const { document, source } = await input(args);
        mutationAllowed(document);
        const selected = pageSelection(args.page_numbers, source.page_count);
        const copy = await PDFDocument.create();
        for (const page of await copy.copyPages(document, selected.map(number => number - 1))) copy.addPage(page);
        return output(copy, source, { selected_page_numbers: selected, omitted_page_numbers: Array.from({ length: source.page_count }, (_, i) => i + 1).filter(page => !selected.includes(page)), limitations: ["Copies page content, not the original document's form structure, bookmarks or document metadata."] });
      },
    },
    {
      name: "rotate_pdf_pages", description: "Use this to rotate selected pages clockwise by 90, 180 or 270 degrees and return a new PDF copy. Supply exact page numbers. Signed and XFA documents are refused.",
      inputSchema: { type: "object", properties: { ...PDF_INPUT_PROPERTIES, page_numbers: pagesSchema, rotation: { type: "integer", enum: [90, 180, 270] } }, required: ["page_numbers", "rotation"] },
      annotations: { readOnlyHint: false }, async handler(args) {
        const { document, source } = await input(args);
        mutationAllowed(document);
        const selected = pageSelection(args.page_numbers, source.page_count);
        if (![90, 180, 270].includes(args.rotation)) fail("INVALID_ROTATION", "Use 90, 180 or 270 clockwise degrees.");
        for (const number of selected) {
          const page = document.getPage(number - 1);
          page.setRotation(degrees((page.getRotation().angle + args.rotation) % 360));
        }
        return output(document, source, { rotated_page_numbers: selected, clockwise_degrees: args.rotation });
      },
    },
    {
      name: "merge_pdfs", description: "Use this to combine 2 to 5 explicitly supplied PDF attachments in the listed order. Returns a new copy. Combined input is limited to 25 MB/200 pages and output to 3 MB. Signed or XFA sources are refused.",
      inputSchema: { type: "object", properties: { files: { type: "array", minItems: 2, maxItems: MAX_MERGE_DOCUMENTS, items: PDF_INPUT_PROPERTIES.file } }, required: ["files"] },
      annotations: { readOnlyHint: false }, async handler(args) {
        if (!Array.isArray(args.files) || args.files.length < 2 || args.files.length > MAX_MERGE_DOCUMENTS) fail("INVALID_FILES", "Supply 2 to 5 PDF attachments in the desired order.");
        const combined = await PDFDocument.create();
        const sources = [];
        let bytes = 0;
        for (const file of args.files) {
          const admitted = await input({ file });
          bytes += admitted.source.size_bytes;
          if (bytes > MAX_MERGE_BYTES || combined.getPageCount() + admitted.source.page_count > MAX_PAGES) fail("MERGE_LIMIT", "Combined input exceeds 25 MB or 200 pages.");
          mutationAllowed(admitted.document);
          for (const page of await combined.copyPages(admitted.document, admitted.document.getPageIndices())) combined.addPage(page);
          sources.push(admitted.source);
        }
        return output(combined, sources, { limitations: ["Copies page content, not the source documents' form structures, bookmarks or document metadata."] });
      },
    },
  ];
}
