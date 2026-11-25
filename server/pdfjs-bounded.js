/**
 * PDF.js with its decoders bounded, for the local server and the hosted
 * service.
 *
 * PDF.js decodes streams inside its worker module, which both runtimes run
 * in-thread (the "fake worker"). The pdf-lib bound in budget.js cannot reach
 * it, and checking a document with pdf-lib first is not enough, because the
 * two parsers can resolve the same file to different objects. So the pinned
 * worker module is loaded with a guard line added to each decode growth path
 * (see HOOKS), calling the same guards as the pdf-lib bound. PDF.js uses a
 * worker module already present on globalThis.pdfjsWorker instead of
 * importing its own.
 *
 * The patch must match the pinned source exactly once; anything else fails
 * closed rather than running PDF.js unbounded. Install it before anything
 * imports pdfjs-dist in the process.
 */
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

import { guardDecodeGrowth, guardImageAllocation, guardImagePixels } from "./decode-budget.js";

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
  {
    // JPEG: per-component block buffers sized from the codestream's own frame header.
    after: [
      "    const blocksBufferSize = 64 * blocksPerColumnForMcu * (blocksPerLineForMcu + 1);",
      "",
    ].join("\n"),
    add: "    globalThis.__pdfToolsGuardImagePixels(frame.samplesPerLine, frame.scanLines);\n    globalThis.__pdfToolsGuardImageAllocation(blocksBufferSize * 2);\n",
  },
  {
    // JBIG2: the page bitmap sized from the page information segment.
    after: [
      "  onPageInformation(info) {",
      "    this.currentPageInfo = info;",
      "    const rowSize = info.width + 7 >> 3;",
      "",
    ].join("\n"),
    add: "    globalThis.__pdfToolsGuardImageAllocation(rowSize * info.height);\n",
  },
  {
    // Every image, soft mask and mask: after PDF.js settles its dimensions
    // (preferring the image data's own size over the dictionary's).
    after: [
      "    this.width = width;",
      "    this.height = height;",
      "    this.interpolate = dict.get(\"I\", \"Interpolate\");",
      "",
    ].join("\n"),
    add: "    globalThis.__pdfToolsGuardImagePixels(width, height);\n",
  },
  {
    // Image masks (including inline and Type 3 glyph masks) are built by
    // createMask, which never constructs a PDFImage and allocates from the
    // declared size alone.
    after: [
      "    const computedLength = (width + 7 >> 3) * height;",
      "",
    ].join("\n"),
    add: "    globalThis.__pdfToolsGuardImagePixels(width, height);\n",
  },
];

/** getDocument options every bounded PDF.js call uses: no parser warnings carrying document values into logs. */
export function boundedDocumentOptions(options) {
  return { ...options, verbosity: 0 };
}

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

/**
 * Evaluate the patched worker so it registers globalThis.pdfjsWorker. A data:
 * URL import is tried first; a host that refuses one gets the same source from
 * a private temporary file, removed once it has loaded.
 */
async function importPatchedWorker(patched) {
  try {
    await import(`data:text/javascript;base64,${Buffer.from(patched, "utf8").toString("base64")}`);
    return;
  } catch (error) {
    if (globalThis.pdfjsWorker) throw error;
  }
  const directory = mkdtempSync(path.join(tmpdir(), "pdf-tools-pdfjs-bounded-"));
  try {
    const file = path.join(directory, "pdf.worker.bounded.mjs");
    writeFileSync(file, patched, { mode: 0o600 });
    await import(pathToFileURL(file).href);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

let installing = null;

/**
 * Register the bounded PDF.js worker in this process. Refuses when an
 * unbounded worker is already registered. Call before importing pdfjs-dist.
 */
export function installBoundedPdfjsWorker() {
  installing ??= (async () => {
    globalThis.__pdfToolsGuardDecodeGrowth = guardDecodeGrowth;
    globalThis.__pdfToolsGuardImageAllocation = guardImageAllocation;
    globalThis.__pdfToolsGuardImagePixels = guardImagePixels;
    if (globalThis.pdfjsWorker && !globalThis.pdfjsWorker.__pdfToolsBounded) {
      // An unbounded worker is already registered in this thread; do not run.
      throw new BoundedPdfjsUnavailable("an unbounded PDF.js worker is already loaded");
    }
    if (!globalThis.pdfjsWorker) {
      const source = readFileSync(require.resolve("pdfjs-dist/legacy/build/pdf.worker.mjs"), "utf8");
      await importPatchedWorker(boundedWorkerSource(source));
      if (!globalThis.pdfjsWorker?.WorkerMessageHandler) throw new BoundedPdfjsUnavailable("bounded PDF.js worker did not register");
      Object.defineProperty(globalThis.pdfjsWorker, "__pdfToolsBounded", { value: true });
    }
  })();
  return installing;
}

let loading = null;

/** Load PDF.js with the bounded worker installed first. Use instead of importing pdfjs-dist directly. */
export function loadBoundedPdfjs() {
  loading ??= (async () => {
    await installBoundedPdfjsWorker();
    const pdfjs = await import("pdfjs-dist/legacy/build/pdf.mjs");
    // Every getDocument call gets the bounded options.
    return { ...pdfjs, getDocument: options => pdfjs.getDocument(boundedDocumentOptions(options)) };
  })();
  return loading;
}
