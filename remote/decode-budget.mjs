/**
 * Bounds on decoded stream data in the hosted service (profile P5: caps
 * enforced during parsing, failing closed with a typed error).
 *
 * Every pdf-lib stream decoder grows its output through
 * DecodeStream.prototype.ensureBuffer, whatever the filter. Capping growth
 * there bounds decoding however a stream is written. The worker's V8 heap
 * limit does not cover this memory: decoded bytes live in ArrayBuffer backing
 * stores outside the heap.
 *
 * The cap applies per stream and per call. Each hosted tool call runs in its
 * own worker, and callTool() resets the per-call state with beginCall().
 * pdf-lib may catch a parse error and skip the object, so the module also
 * records that the limit was reached; callTool() refuses the call afterwards
 * rather than return a result built from a partly read document.
 *
 * Only the hosted process imports this module; the local server does not.
 */
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

let liveBytes = 0;
let exceeded = false;

/** Start a fresh per-call budget. */
export function beginCall() {
  liveBytes = 0;
  exceeded = false;
}

/** Whether any decode in this call reached a limit, even if pdf-lib swallowed the error. */
export function decodeLimitReached() {
  return exceeded;
}

if (!DecodeStream.prototype.__pdfToolsBounded) {
  const original = DecodeStream.prototype.ensureBuffer;
  DecodeStream.prototype.ensureBuffer = function boundedEnsureBuffer(requested) {
    const current = this.buffer?.byteLength ?? 0;
    if (requested > current) {
      // The same doubling the original applies, computed before it allocates.
      let size = this.minBufferLength || 512;
      while (size < requested) size *= 2;
      if (size > MAX_DECODED_STREAM_BYTES || liveBytes + (size - current) > MAX_DECODED_CALL_BYTES) {
        exceeded = true;
        throw new DecodeBudgetExceeded();
      }
      liveBytes += size - current;
    }
    return original.call(this, requested);
  };
  Object.defineProperty(DecodeStream.prototype, "__pdfToolsBounded", { value: true });
}
