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
 * the PDF.js-backed tools, predecodeForText() first decodes every non-image
 * stream through pdf-lib, under the same cap, and refuses a document over it
 * before PDF.js runs. The process-memory backstop in isolated-tool.mjs remains
 * the outer bound for anything else.
 *
 * The budget is per stream and per call, tracked per async context so
 * overlapping in-process calls do not share it. Only the hosted process
 * imports this module; the local server does not.
 */
import { AsyncLocalStorage } from "node:async_hooks";
import { createRequire } from "node:module";
import { decodePDFRawStream, PDFName, PDFRawStream } from "pdf-lib";

const require = createRequire(import.meta.url);
const DecodeStream = require("pdf-lib/cjs/core/streams/DecodeStream.js").default;

export const MAX_DECODED_STREAM_BYTES = 128 * 1024 * 1024;
export const MAX_DECODED_CALL_BYTES = 384 * 1024 * 1024;

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
 * Decode, under the cap, every stream PDF.js might decode while extracting
 * text: all streams in the document except images, embedded files and XMP
 * metadata, which text extraction does not decode. Enumerating every object,
 * rather than walking from the pages, avoids missing a stream PDF.js reaches
 * by a route this code does not model (annotation appearances, CMaps,
 * patterns, soft masks, fonts used from graphics states). Only the budget
 * stops the call; any other decode error is ignored here, exactly as PDF.js
 * tolerates a damaged stream.
 */
export function predecodeForText(document) {
  const skip = new Set(["/Image", "/EmbeddedFile", "/Metadata", "/XRef", "/ObjStm"]);
  for (const [, object] of document.context.enumerateIndirectObjects()) {
    if (!(object instanceof PDFRawStream)) continue;
    const type = object.dict.get(PDFName.of("Type"))?.toString();
    const subtype = object.dict.get(PDFName.of("Subtype"))?.toString();
    if (skip.has(type) || skip.has(subtype)) continue;
    try {
      decodePDFRawStream(object).decode();
    } catch (error) {
      if (error instanceof DecodeBudgetExceeded) throw error;
    }
  }
}
