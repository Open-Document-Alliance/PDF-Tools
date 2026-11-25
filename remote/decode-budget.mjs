/**
 * Bounds on decoded stream data in the hosted service (profile P5: caps
 * enforced during parsing, failing closed with a typed error).
 *
 * pdf-lib: every pdf-lib stream decoder grows its output through
 * DecodeStream.prototype.ensureBuffer, whatever the filter, so capping growth
 * there bounds all pdf-lib decoding. The worker's V8 heap limit does not
 * cover this memory: decoded bytes live in ArrayBuffer backing stores.
 *
 * PDF.js: its decoders live inside its worker module. pdfjs-bounded.mjs loads
 * that module with the same guard added to its DecodeStream.ensureBuffer, so
 * both libraries share one budget.
 *
 * The budget is per stream and per call, tracked per async context so
 * overlapping in-process calls do not share it. Only the hosted process
 * imports this module; the local server does not.
 */
import { AsyncLocalStorage } from "node:async_hooks";
import { createRequire } from "node:module";

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

/**
 * The shared growth check for both decoders: a buffer about to grow from
 * `current` to `size` bytes. Throws DecodeBudgetExceeded over a limit.
 */
export function guardDecodeGrowth(size, current) {
  if (size <= current) return;
  const state = budget();
  if (size > MAX_DECODED_STREAM_BYTES || state.usedBytes + (size - current) > MAX_DECODED_CALL_BYTES) {
    state.exceeded = true;
    throw new DecodeBudgetExceeded();
  }
  state.usedBytes += size - current;
}

if (!DecodeStream.prototype.__pdfToolsBounded) {
  const original = DecodeStream.prototype.ensureBuffer;
  DecodeStream.prototype.ensureBuffer = function boundedEnsureBuffer(requested) {
    const current = this.buffer?.byteLength ?? 0;
    if (requested > current) {
      // The same doubling the original applies, computed before it allocates.
      let size = this.minBufferLength || 512;
      while (size < requested) size *= 2;
      guardDecodeGrowth(size, current);
    }
    return original.call(this, requested);
  };
  Object.defineProperty(DecodeStream.prototype, "__pdfToolsBounded", { value: true });
}
