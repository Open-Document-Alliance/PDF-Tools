import { createHash, randomBytes } from "node:crypto";
import { PDFBool, PDFDocument, PDFName, StandardFonts } from "pdf-lib";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { callTool, listTools, testing } from "../remote/server.mjs";

// Exercise the real resolver/policy without egress. Production uses the
// pinned Node transport, separately exercised by remote-fetch-guard tests.
vi.mock("../remote/fetch-guard.mjs", async importOriginal => {
  const original = await importOriginal();
  return { ...original, fetchPdfBytes: (url, options = {}) => original.fetchPdfBytes(url, {
    ...options, fetchImpl: (...args) => globalThis.fetch(...args),
  }) };
});

const sha = bytes => createHash("sha256").update(bytes).digest("hex");
let bytes;
let base64;
beforeAll(async () => {
  const document = await PDFDocument.create();
  const font = await document.embedFont(StandardFonts.Helvetica);
  for (let page = 1; page <= 3; page++) {
    document.addPage([300 + page * 10, 400]).drawText(`Synthetic page ${page}: alpha beta`, { x: 20, y: 350, size: 12, font });
  }
  bytes = Buffer.from(await document.save());
  base64 = bytes.toString("base64");
});
afterEach(() => vi.unstubAllGlobals());
const file = id => ({ download_url: `https://93.184.216.34/${id}.pdf`, file_id: id, file_name: `${id}.pdf`, mime_type: "application/pdf" });
const success = result => { expect(result.isError, JSON.stringify(result.content)).toBeFalsy(); return result.structuredContent; };
const refusal = (result, code) => { expect(result.isError).toBe(true); expect(result.content[0].text).toMatch(new RegExp(`^${code}:`)); };

describe("hosted attachment input", () => {
  it("declares all four host file properties on each attachment parameter", () => {
    for (const tool of listTools().tools) {
      const names = tool._meta["openai/fileParams"];
      expect(names).toEqual(tool.name === "merge_pdfs" ? ["files"] : ["file"]);
      for (const name of names) {
        const schema = tool.inputSchema.properties[name];
        const object = schema.type === "array" ? schema.items : schema;
        expect(Object.keys(object.properties).sort()).toEqual(["download_url", "file_id", "file_name", "mime_type"]);
        expect(object.required).toEqual(["download_url", "file_id"]);
        expect(object.additionalProperties).toBe(false);
      }
    }
  });
  it("uses the actual file resolver and fetch guard without a real network request", async () => {
    const fetch = vi.fn(async () => new Response(bytes, { headers: { "content-type": "application/pdf" } }));
    vi.stubGlobal("fetch", fetch);
    const result = success(await callTool("get_pdf_info", { file: file("test") }));
    expect(result.source.sha256).toBe(sha(bytes));
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(String(fetch.mock.calls[0][0])).toBe(file("test").download_url);
  });
  it.each([
    null, {}, { ...file("a"), file_id: "" }, { ...file("a"), download_url: "file:///tmp/a.pdf" },
    { ...file("a"), download_url: "http://93.184.216.34/a.pdf" },
    { ...file("a"), download_url: "https://user:secret@example.com/a.pdf" },
    { ...file("a"), mime_type: "text/plain" }, { ...file("a"), file_name: "a.txt" },
    { ...file("a"), unexpected: "value" },
  ])("refuses malformed or non-PDF attachment %j", async input => {
    refusal(await callTool("get_pdf_info", { file: input }), "INVALID_FILE");
  });
  it("does not let a host file bypass private-address denial", async () => {
    refusal(await callTool("get_pdf_info", { file: { ...file("a"), download_url: "https://127.0.0.1/a.pdf" } }), "PRIVATE_ADDRESS");
  });
  it("refuses attachment plus inline input before fetching", async () => {
    const fetch = vi.fn(); vi.stubGlobal("fetch", fetch);
    refusal(await callTool("get_pdf_info", { file: file("a"), pdf_base64: base64 }), "AMBIGUOUS_INPUT");
    expect(fetch).not.toHaveBeenCalled();
  });
  it.each(["!!!!", "YQ=", "YR==", "YQ==\n"])("refuses noncanonical base64 %s", async value => {
    refusal(await callTool("get_pdf_info", { pdf_base64: value }), "INVALID_BASE64");
  });
});

describe("source-backed hosted reading", () => {
  it("reports exact immutable identity and page geometry", async () => {
    const result = success(await callTool("get_pdf_info", { pdf_base64: base64 }));
    expect(result.source).toEqual({ sha256: sha(bytes), size_bytes: bytes.length, page_count: 3 });
    expect(result.pages.map(page => page.width)).toEqual([310, 320, 330]);
  });
  it("reads a bounded selection without claiming whole-document coverage", async () => {
    const result = success(await callTool("read_pdf_pages", { pdf_base64: base64, start_page: 2, end_page: 3 }));
    expect(result.pages.map(page => page.page)).toEqual([2, 3]);
    expect(result.pages[0].text).toContain("Synthetic page 2");
    expect(result.coverage).toEqual({ start_page: 2, end_page: 3, total_pages: 3, unselected_pages: 1, whole_document_selected: false });
    expect(result.ocr_performed).toBe(false);
    expect(result.source.sha256).toBe(sha(bytes));
  });
  it.each([{ start_page: 0 }, { end_page: 4 }, { start_page: 3, end_page: 2 }, { start_page: 1.5 }])("refuses range %j", async range => {
    refusal(await callTool("read_pdf_pages", { pdf_base64: base64, ...range }), "INVALID_PAGE_RANGE");
  });
  it("searches exact selected text with page-bound evidence", async () => {
    const result = success(await callTool("search_pdf_text", { pdf_base64: base64, start_page: 2, end_page: 3, query: "alpha" }));
    expect(result.observed_matches).toBe(2);
    expect(result.omitted_matches).toBe(0);
    expect(result.matches.map(match => match.page)).toEqual([2, 3]);
    expect(result.matches.every(match => match.quote.includes("alpha"))).toBe(true);
  });
  it("uses the existing Markdown renderer and exposes its source provenance", async () => {
    const result = success(await callTool("convert_pdf_to_markdown", { pdf_base64: base64, end_page: 3 }));
    expect(result.markdown).toContain("Synthetic page 1");
    expect(result.markdown).toContain("Synthetic page 3");
    expect(result.source.sha256).toBe(sha(bytes));
    expect(result.provenance).toBeTruthy();
    expect(result.coverage.whole_document_selected).toBe(true);
  });
  it("returns explicit non-OCR evidence for a textless page", async () => {
    const document = await PDFDocument.create(); document.addPage();
    const result = success(await callTool("read_pdf_pages", { pdf_base64: Buffer.from(await document.save()).toString("base64") }));
    expect(result.pages[0].text).toBe("");
    expect(result.ocr_performed).toBe(false);
    expect(result.pages[0].limitations.length).toBeGreaterThan(0);
  });
  it("returns an actionable refusal for oversized Markdown rather than a parser failure", async () => {
    const document = await PDFDocument.create();
    const font = await document.embedFont(StandardFonts.Helvetica);
    for (let page = 0; page < 3; page++) {
      const target = document.addPage([612, 792]);
      for (let row = 0; row < 6; row++) target.drawText(`Page ${page} row ${row} ${"*".repeat(4000)}`, { x: 20, y: 740 - row * 20, size: 0.1, font });
    }
    refusal(await callTool("convert_pdf_to_markdown", { pdf_base64: Buffer.from(await document.save()).toString("base64"), end_page: 3 }), "OUTPUT_TOO_LARGE");
  });
});

describe("non-destructive page operations", () => {
  it("selects and reorders actual pages, binds output bytes, preserves source", async () => {
    const originalSha = sha(bytes);
    const result = success(await callTool("select_pdf_pages", { pdf_base64: base64, page_numbers: [3, 1] }));
    const output = Buffer.from(result.pdf_base64, "base64");
    expect(result.output.sha256).toBe(sha(output));
    expect((await PDFDocument.load(output)).getPages().map(page => page.getWidth())).toEqual([330, 310]);
    expect(result.omitted_page_numbers).toEqual([2]);
    expect(result.limitations.join(" ")).toMatch(/form structure/);
    expect(sha(bytes)).toBe(originalSha);
  });
  it("rotates only selected pages", async () => {
    const result = success(await callTool("rotate_pdf_pages", { pdf_base64: base64, page_numbers: [2], rotation: 90 }));
    const output = await PDFDocument.load(Buffer.from(result.pdf_base64, "base64"));
    expect(output.getPages().map(page => page.getRotation().angle)).toEqual([0, 90, 0]);
    expect((await PDFDocument.load(bytes)).getPages().map(page => page.getRotation().angle)).toEqual([0, 0, 0]);
  });
  it.each([[], [1, 1], [0], [4], [1.5]])("refuses ambiguous or invalid pages %j", async page_numbers => {
    refusal(await callTool("select_pdf_pages", { pdf_base64: base64, page_numbers }), "INVALID_PAGES");
  });
  it("refuses unsupported rotation", async () => {
    refusal(await callTool("rotate_pdf_pages", { pdf_base64: base64, page_numbers: [1], rotation: 45 }), "INVALID_ROTATION");
  });
  it("refuses a real signature-field structure", async () => {
    const document = await PDFDocument.load(bytes);
    const field = document.getForm().createTextField("synthetic-signature");
    field.acroField.dict.set(PDFName.of("FT"), PDFName.of("Sig"));
    const pdf_base64 = Buffer.from(await document.save()).toString("base64");
    refusal(await callTool("select_pdf_pages", { pdf_base64, page_numbers: [1] }), "SIGNED_DOCUMENT");
    refusal(await callTool("fill_form", { pdf_base64, fields: {} }), "ALREADY_SIGNED");
    refusal(await callTool("flatten_form", { pdf_base64 }), "ALREADY_SIGNED");
    refusal(await callTool("apply_signature", { pdf_base64, display_name: "Synthetic", page: 1, x: 20, y: 20, width: 50, height: 20, intent_statement: "Synthetic test only, no legal effect. I request this simulated visible stamp.", confirmed_at: new Date().toISOString() }), "ALREADY_SIGNED");
  });
  it.each([false, true])("refuses compressed XFA sources (dynamic=%s) across all page mutations", async dynamic => {
    const document = await PDFDocument.load(bytes);
    document.getForm().createTextField("test");
    document.catalog.lookup(PDFName.of("AcroForm")).set(PDFName.of("XFA"), document.context.register(document.context.flateStream("<xfa>synthetic</xfa>")));
    document.catalog.set(PDFName.of("NeedsRendering"), dynamic ? PDFBool.True : PDFBool.False);
    const xfa = Buffer.from(await document.save({ useObjectStreams: true, updateFieldAppearances: false }));
    const input = { pdf_base64: xfa.toString("base64"), page_numbers: [1] };
    refusal(await callTool("select_pdf_pages", input), "XFA_DOCUMENT");
    refusal(await callTool("rotate_pdf_pages", { ...input, rotation: 90 }), "XFA_DOCUMENT");
    vi.stubGlobal("fetch", vi.fn(async () => new Response(xfa)));
    refusal(await callTool("merge_pdfs", { files: [file("a"), file("b")] }), "XFA_DOCUMENT");
  });
  it("merges actual attachments in order, retaining all source identities", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(bytes)));
    const result = success(await callTool("merge_pdfs", { files: [file("a"), file("b")] }));
    expect(result.source).toHaveLength(2);
    expect(result.source.every(source => source.sha256 === sha(bytes))).toBe(true);
    const output = await PDFDocument.load(Buffer.from(result.pdf_base64, "base64"));
    expect(output.getPages().map(page => page.getWidth())).toEqual([310, 320, 330, 310, 320, 330]);
  });
  it.each([[], [file("a")], Array.from({ length: 6 }, () => file("a"))])("refuses invalid merge size %j", async files => {
    refusal(await callTool("merge_pdfs", { files }), "INVALID_FILES");
  });
  it("enforces output bytes before returning a large page copy", async () => {
    const document = await PDFDocument.create();
    // Uncompressible embedded attachment makes output exceed the inline cap.
    document.addPage();
    await document.attach(randomBytes(3 * 1024 * 1024 + 100), "synthetic.bin");
    const large = await document.save();
    vi.stubGlobal("fetch", vi.fn(async () => new Response(large)));
    refusal(await callTool("rotate_pdf_pages", { file: file("large"), page_numbers: [1], rotation: 90 }), "OUTPUT_TOO_LARGE");
  });
});
