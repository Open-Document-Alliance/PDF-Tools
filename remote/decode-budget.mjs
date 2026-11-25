/**
 * Bounds on decoded stream data in the hosted service (profile P5: caps
 * enforced during parsing, failing closed with a typed error).
 *
 * pdf-lib: every pdf-lib stream decoder grows its output through
 * DecodeStream.prototype.ensureBuffer, whatever the filter, so capping growth
 * there bounds all pdf-lib decoding. The worker's V8 heap limit does not
 * cover this memory: decoded bytes live in ArrayBuffer backing stores.
 *
 * PDF.js: its decoders are internal and are not covered by that patch. For
 * the PDF.js-backed tools, predecodeForText() first decodes, through pdf-lib
 * and so under the same cap, the streams PDF.js needs to extract text from
 * the selected pages (page contents, form XObjects, font programs, Type 3
 * glyph procedures). A document over the cap is refused before PDF.js runs.
 * Image streams are not decoded for text extraction and are not checked here;
 * the process-memory backstop in isolated-tool.mjs remains the outer bound.
 *
 * The budget is per stream and per call, tracked per async context so
 * overlapping in-process calls do not share it. Only the hosted process
 * imports this module; the local server does not.
 */
import { AsyncLocalStorage } from "node:async_hooks";
import { createRequire } from "node:module";
import { decodePDFRawStream, PDFArray, PDFDict, PDFName, PDFRawStream, PDFRef } from "pdf-lib";

const require = createRequire(import.meta.url);
const DecodeStream = require("pdf-lib/cjs/core/streams/DecodeStream.js").default;

export const MAX_DECODED_STREAM_BYTES = 128 * 1024 * 1024;
export const MAX_DECODED_CALL_BYTES = 384 * 1024 * 1024;
const MAX_FORM_DEPTH = 4;
const MAX_PREDECODED_STREAMS = 2000;

export class DecodeBudgetExceeded extends Error {
  constructor() {
    super("decoded data exceeds the hosted limit");
    this.code = "DOCUMENT_TOO_LARGE_DECODED";
  }
}

const storage = new AsyncLocalStorage();
const fallback = { usedBytes: 0, exceeded: false };
const budget = () => storage.getStore() ?? fallback;

/** Run fn with a fresh per-call budget. */
export function withCallBudget(fn) {
  return storage.run({ usedBytes: 0, exceeded: false }, fn);
}

/** Whether any decode in this call reached a limit, even if pdf-lib swallowed the error. */
export function decodeLimitReached() {
  return budget().exceeded;
}

if (!DecodeStream.prototype.__pdfToolsBounded) {
  const original = DecodeStream.prototype.ensureBuffer;
  DecodeStream.prototype.ensureBuffer = function boundedEnsureBuffer(requested) {
    const current = this.buffer?.byteLength ?? 0;
    if (requested > current) {
      const state = budget();
      // The same doubling the original applies, computed before it allocates.
      let size = this.minBufferLength || 512;
      while (size < requested) size *= 2;
      if (size > MAX_DECODED_STREAM_BYTES || state.usedBytes + (size - current) > MAX_DECODED_CALL_BYTES) {
        state.exceeded = true;
        throw new DecodeBudgetExceeded();
      }
      state.usedBytes += size - current;
    }
    return original.call(this, requested);
  };
  Object.defineProperty(DecodeStream.prototype, "__pdfToolsBounded", { value: true });
}

/**
 * Decode, under the cap, every stream PDF.js will need to extract text from
 * the given 1-based pages of a pdf-lib document. Throws DecodeBudgetExceeded.
 */
export function predecodeForText(document, pageNumbers) {
  const context = document.context;
  const seen = new Set();
  let count = 0;
  const lookup = value => (value instanceof PDFRef ? context.lookup(value) : value);
  const decode = (value, key) => {
    const object = lookup(value);
    if (!(object instanceof PDFRawStream)) return object;
    const id = key ?? object;
    if (seen.has(id)) return object;
    seen.add(id);
    if (++count > MAX_PREDECODED_STREAMS) {
      budget().exceeded = true;
      throw new DecodeBudgetExceeded();
    }
    decodePDFRawStream(object).decode();
    return object;
  };
  const streamsOf = value => {
    const object = lookup(value);
    if (object instanceof PDFArray) return object.asArray();
    return object ? [value] : [];
  };
  const visitResources = (resources, depth) => {
    const dict = lookup(resources);
    if (!(dict instanceof PDFDict) || depth > MAX_FORM_DEPTH) return;
    const xobjects = lookup(dict.get(PDFName.of("XObject")));
    if (xobjects instanceof PDFDict) {
      for (const [, ref] of xobjects.entries()) {
        const xobject = lookup(ref);
        if (!(xobject instanceof PDFRawStream)) continue;
        if (xobject.dict.get(PDFName.of("Subtype"))?.toString() !== "/Form") continue;
        if (seen.has(ref)) continue;
        decode(ref, ref instanceof PDFRef ? ref : undefined);
        visitResources(xobject.dict.get(PDFName.of("Resources")), depth + 1);
      }
    }
    const fonts = lookup(dict.get(PDFName.of("Font")));
    if (fonts instanceof PDFDict) {
      for (const [, ref] of fonts.entries()) visitFont(lookup(ref), depth);
    }
  };
  const visitFont = (font, depth) => {
    if (!(font instanceof PDFDict)) return;
    const descendants = lookup(font.get(PDFName.of("DescendantFonts")));
    if (descendants instanceof PDFArray) for (const child of descendants.asArray()) visitFont(lookup(child), depth);
    const descriptor = lookup(font.get(PDFName.of("FontDescriptor")));
    if (descriptor instanceof PDFDict) {
      for (const name of ["FontFile", "FontFile2", "FontFile3"]) {
        const file = descriptor.get(PDFName.of(name));
        if (file) decode(file, file instanceof PDFRef ? file : undefined);
      }
    }
    const procs = lookup(font.get(PDFName.of("CharProcs")));
    if (procs instanceof PDFDict) for (const [, ref] of procs.entries()) decode(ref, ref instanceof PDFRef ? ref : undefined);
    visitResources(font.get(PDFName.of("Resources")), depth + 1);
  };
  const pages = document.getPages();
  for (const number of pageNumbers) {
    const page = pages[number - 1];
    if (!page) continue;
    for (const ref of streamsOf(page.node.get(PDFName.of("Contents")))) decode(ref, ref instanceof PDFRef ? ref : undefined);
    visitResources(page.node.Resources(), 0);
  }
}
