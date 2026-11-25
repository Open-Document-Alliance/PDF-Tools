/**
 * Bounds on decoded stream data, shared by the local server and the hosted
 * service: caps enforced while decoding, failing closed with a typed error.
 *
 * pdf-lib: every pdf-lib stream decoder grows its output through
 * DecodeStream.prototype.ensureBuffer, whatever the filter, so capping growth
 * there bounds all pdf-lib decoding. A V8 heap limit does not cover this
 * memory: decoded bytes live in ArrayBuffer backing stores.
 *
 * PDF.js: its decoders live inside its worker module. pdfjs-bounded.js loads
 * that module with the same guard added to its decode paths, so both
 * libraries share one budget.
 *
 * The budget is per stream and per call, tracked per async context so
 * overlapping in-process calls do not share it. Run each operation inside
 * withCallBudget. Outside one, only the per-stream limit applies: a
 * long-running process must not accumulate one budget across calls. Importing
 * this module installs the pdf-lib bound for the whole process.
 */
import { AsyncLocalStorage } from "node:async_hooks";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const DecodeStream = require("pdf-lib/cjs/core/streams/DecodeStream.js").default;

export const MAX_DECODED_STREAM_BYTES = 128 * 1024 * 1024;
export const MAX_DECODED_CALL_BYTES = 384 * 1024 * 1024;

export class DecodeBudgetExceeded extends Error {
  constructor() {
    super("decoded data exceeds the decode limit");
    this.code = "DOCUMENT_TOO_LARGE_DECODED";
  }
}

const storage = new AsyncLocalStorage();

/** Run fn with a fresh per-call budget. */
export function withCallBudget(fn) {
  return storage.run({ usedBytes: 0, exceeded: false, imagesSkipped: 0 }, fn);
}

/** Whether any decode in this call reached a limit, even if pdf-lib swallowed the error. */
export function decodeLimitReached() {
  return storage.getStore()?.exceeded ?? false;
}

/**
 * The shared growth check for both decoders: a buffer about to grow from
 * `current` to `size` bytes. Throws DecodeBudgetExceeded over a limit.
 */
export function guardDecodeGrowth(size, current) {
  if (size <= current) return;
  const state = storage.getStore();
  if (size > MAX_DECODED_STREAM_BYTES || (state && state.usedBytes + (size - current) > MAX_DECODED_CALL_BYTES)) {
    if (state) state.exceeded = true;
    throw new DecodeBudgetExceeded();
  }
  if (state) state.usedBytes += size - current;
}

/**
 * Images are bounded per image, not per call: a scanned document is many
 * ordinary images, each decoded and released in turn. An image over these
 * limits is not decoded; PDF.js skips it as it skips a damaged image, and the
 * call continues. Memory across many images is the process-memory
 * backstop's job (decode-memory-guard.js), and these per-image limits keep any one
 * allocation small enough for that backstop to act before the platform limit.
 */
export const MAX_IMAGE_PIXELS = 64 * 1024 * 1024;
export const MAX_IMAGE_ALLOCATION_BYTES = 256 * 1024 * 1024;

export class ImageTooLarge extends Error {
  constructor() {
    super("image exceeds the decode limit and was not decoded");
  }
}

/**
 * How many images this call skipped at the image limits. Skipping an image is
 * not a decode failure (decodeLimitReached stays false), but a tool that
 * reads or renders the page can report it as partial coverage.
 */
export function imagesSkippedAtLimit() {
  return storage.getStore()?.imagesSkipped ?? 0;
}

function skipImage() {
  const state = storage.getStore();
  if (state) state.imagesSkipped += 1;
  throw new ImageTooLarge();
}

export function guardImagePixels(width, height) {
  if (!(width * height <= MAX_IMAGE_PIXELS)) skipImage();
}

export function guardImageAllocation(bytes) {
  if (!(bytes <= MAX_IMAGE_ALLOCATION_BYTES)) skipImage();
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
