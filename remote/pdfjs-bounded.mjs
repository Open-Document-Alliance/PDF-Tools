/**
 * PDF.js for the hosted service, with its stream decoder bounded.
 *
 * PDF.js decodes streams with its own DecodeStream class inside its worker
 * module, which the hosted service runs in-thread (the "fake worker"). The
 * pdf-lib bound in decode-budget.mjs cannot reach it, and checking a
 * document with pdf-lib first is not enough, because the two parsers can
 * resolve the same file to different objects. So the hosted service loads the
 * pinned worker module with a guard line added to each decode growth path
 * (see HOOKS), calling the same guard as the pdf-lib bound. PDF.js uses a worker module
 * already present on globalThis.pdfjsWorker instead of importing its own.
 *
 * The patch must match the pinned source exactly once; anything else fails
 * closed rather than running PDF.js unbounded. Only the hosted service loads
 * this module.
 */
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";

import { guardDecodeGrowth } from "./decode-budget.mjs";

const require = createRequire(import.meta.url);

/**
 * Each hook is an exact span of the pinned source and the guard line added
 * after it. The synchronous decoders grow through ensureBuffer; FlateStream
 * also tries an asynchronous DecompressionStream path that collects chunks,
 * and falls back to the synchronous path if that path throws, so both are
 * guarded.
 */
const HOOKS = [
  {
    after: [
      "  ensureBuffer(requested) {",
      "    const buffer = this.buffer;",
      "    if (requested <= buffer.byteLength) {",
      "      return buffer;",
      "    }",
      "    let size = this.minBufferLength;",
      "    while (size < requested) {",
      "      size *= 2;",
      "    }",
      "",
    ].join("\n"),
    add: "    globalThis.__pdfToolsGuardDecodeGrowth(size, buffer.byteLength);\n",
  },
  {
    after: [
      "      for await (const chunk of readable) {",
      "        chunks.push(chunk);",
      "        totalLength += chunk.byteLength;",
      "",
    ].join("\n"),
    add: "        globalThis.__pdfToolsGuardDecodeGrowth(totalLength, totalLength - chunk.byteLength);\n",
  },
];

export class BoundedPdfjsUnavailable extends Error {}

/** The patched worker source, or a thrown error if the pinned hook is not found exactly once. */
export function boundedWorkerSource(source) {
  let patched = source;
  for (const hook of HOOKS) {
    const pieces = patched.split(hook.after);
    if (pieces.length !== 2) throw new BoundedPdfjsUnavailable("PDF.js decoder hook not found exactly once");
    patched = pieces[0] + hook.after + hook.add + pieces[1];
  }
  return patched;
}

let loading = null;

/** Load PDF.js with the bounded worker installed first. Use instead of importing pdfjs-dist directly. */
export function loadBoundedPdfjs() {
  loading ??= (async () => {
    globalThis.__pdfToolsGuardDecodeGrowth = guardDecodeGrowth;
    if (globalThis.pdfjsWorker && !globalThis.pdfjsWorker.__pdfToolsBounded) {
      // An unbounded worker is already registered in this thread; do not run.
      throw new BoundedPdfjsUnavailable("an unbounded PDF.js worker is already loaded");
    }
    if (!globalThis.pdfjsWorker) {
      const source = readFileSync(require.resolve("pdfjs-dist/legacy/build/pdf.worker.mjs"), "utf8");
      const patched = boundedWorkerSource(source);
      // The module registers itself on globalThis.pdfjsWorker when evaluated.
      await import(`data:text/javascript;base64,${Buffer.from(patched, "utf8").toString("base64")}`);
      if (!globalThis.pdfjsWorker?.WorkerMessageHandler) throw new BoundedPdfjsUnavailable("bounded PDF.js worker did not register");
      Object.defineProperty(globalThis.pdfjsWorker, "__pdfToolsBounded", { value: true });
    }
    return import("pdfjs-dist/legacy/build/pdf.mjs");
  })();
  return loading;
}
