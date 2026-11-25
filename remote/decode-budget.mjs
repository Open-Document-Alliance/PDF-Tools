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
 * and under the same per-stream cap, every stream PDF.js might decode (chosen
 * by how streams are referenced, not by their labels), and refuses a document
 * over the cap before PDF.js runs. The process-memory backstop in isolated-tool.mjs remains
 * the outer bound for anything else.
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
/** Pre-decoded streams are discarded one at a time, so their total bounds time, not memory. */
export const MAX_PREDECODED_TOTAL_BYTES = 1024 * 1024 * 1024;

export class DecodeBudgetExceeded extends Error {
  constructor() {
    super("decoded data exceeds the hosted limit");
    this.code = "DOCUMENT_TOO_LARGE_DECODED";
  }
}

const storage = new AsyncLocalStorage();
const fallback = { usedBytes: 0, exceeded: false, predecoding: false };
const budget = () => storage.getStore() ?? fallback;

/** Run fn with a fresh per-call budget. */
export function withCallBudget(fn) {
  return storage.run({ usedBytes: 0, exceeded: false, predecoding: false }, fn);
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
      if (size > MAX_DECODED_STREAM_BYTES) {
        state.exceeded = true;
        throw new DecodeBudgetExceeded();
      }
      // Pre-decoding has its own total of decoded bytes (see predecodeForText).
      if (!state.predecoding) {
        if (state.usedBytes + (size - current) > MAX_DECODED_CALL_BYTES) {
          state.exceeded = true;
          throw new DecodeBudgetExceeded();
        }
        state.usedBytes += size - current;
      }
    }
    return original.call(this, requested);
  };
  Object.defineProperty(DecodeStream.prototype, "__pdfToolsBounded", { value: true });
}

/**
 * Where a stream may be skipped: every reference to it must be one of these
 * uses, which text extraction does not decode, and the stream's own type must
 * agree with that use. A stream's label alone is never trusted, because PDF.js
 * decodes a stream according to how it is referenced.
 */
const SKIPPABLE_USES = [
  { parent: "XObject", subtype: "/Image" },
  { key: "SMask", subtype: "/Image" },
  { key: "Mask", subtype: "/Image" },
  { key: "Thumb" },
  { parent: "EF", type: "/EmbeddedFile" },
  { key: "Metadata", type: "/Metadata", subtype: "/XML" },
];

function skippableUse(use, stream) {
  const type = stream.dict.get(PDFName.of("Type"))?.toString();
  const subtype = stream.dict.get(PDFName.of("Subtype"))?.toString();
  return SKIPPABLE_USES.some(rule =>
    (rule.parent === undefined || rule.parent === use.parent)
    && (rule.key === undefined || rule.key === use.key)
    && (rule.parent !== undefined || rule.key !== undefined)
    && (rule.type === undefined || rule.type === type)
    && (rule.subtype === undefined || rule.subtype === subtype));
}

/**
 * Decode, under the per-stream cap and a total of decoded bytes, every stream
 * PDF.js might decode while extracting text: every referenced stream except
 * those referenced only as images, soft masks, thumbnails, embedded files or
 * XMP metadata (decided by use, see SKIPPABLE_USES). Unreferenced streams are
 * unreachable and skipped; cross-reference and object streams were already
 * decoded, under the cap, when the document loaded. Only the budget stops the
 * call; any other decode error is ignored here, as PDF.js tolerates damaged
 * streams.
 */
export function predecodeForText(document) {
  const context = document.context;
  const uses = new Map();
  const record = (ref, use) => {
    const target = context.lookup(ref);
    if (!(target instanceof PDFRawStream)) return;
    if (!uses.has(ref)) uses.set(ref, []);
    uses.get(ref).push(use);
  };
  const scan = (value, parent, key, depth) => {
    if (depth > 64) return;
    if (value instanceof PDFRef) { record(value, { parent, key }); return; }
    if (value instanceof PDFDict) {
      for (const [name, child] of value.entries()) scan(child, key, name.asString().slice(1), depth + 1);
    } else if (value instanceof PDFArray) {
      for (const child of value.asArray()) scan(child, parent, key, depth + 1);
    }
  };
  for (const [, object] of context.enumerateIndirectObjects()) {
    scan(object instanceof PDFRawStream ? object.dict : object, undefined, undefined, 0);
  }
  scan(context.trailerInfo.Root, undefined, "Root", 0);

  const state = budget();
  let total = 0;
  state.predecoding = true;
  try {
    for (const [ref, refUses] of uses) {
      const stream = context.lookup(ref);
      const type = stream.dict.get(PDFName.of("Type"))?.toString();
      if (type === "/XRef" || type === "/ObjStm") continue;
      if (refUses.every(use => skippableUse(use, stream))) continue;
      let decoded;
      try {
        decoded = decodePDFRawStream(stream).decode();
      } catch (error) {
        if (error instanceof DecodeBudgetExceeded) throw error;
        continue;
      }
      total += decoded.length;
      if (total > MAX_PREDECODED_TOTAL_BYTES) {
        state.exceeded = true;
        throw new DecodeBudgetExceeded();
      }
    }
  } finally {
    state.predecoding = false;
  }
}
