// The only module that loads pdfium.dll, and the only place PDFium's C API is
// called. It never runs on the server's own thread or process. It has two
// entry points that share one rendering routine:
//
// - Subprocess entry (argv-driven): spawned as a disposable child process by
//   server/pdfjs-subprocess.js's runSystemCommand, the same sandboxed spawn
//   path already used for qlmanage/sips on darwin (whitelisted, shell:false,
//   argument-shape validation, a hard timeout, one system-render child at a
//   time). Used whenever process.execPath is a genuine Node executable — the
//   ordinary Windows host (Cursor, a plain CLI run).
// - Worker entry (workerData-driven): run on a dedicated worker_threads.Worker
//   by server/pdfjs-worker.js's systemRenderPageWindows, terminated on a hard
//   deadline, the same isolation pattern already proven in this codebase for
//   the QPDF WebAssembly decryption worker and for pdf-lib mutations inside
//   Claude Desktop's embedded Electron UtilityProcess. Used there instead of a
//   subprocess
//   because relaunching process.execPath as a child process inside that host
//   is not reliable (see the comment on selectPdfjsIsolationMode's embedded
//   host detection in server/pdfjs-subprocess.js): its process.execPath is
//   the Electron/Claude binary, not a plain node.exe.
//
// Either way, a hang or crash inside pdfium.dll is bounded from the outside
// (SIGKILL for the subprocess case, Worker#terminate() for the worker case)
// and never takes down anything else. PNG encoding happens in pure
// JavaScript (server/png-encoder.js): PDFium's C API renders into a raw
// bitmap, it does not encode image files.
import { readFile, writeFile } from "node:fs/promises";
import { isMainThread, parentPort, workerData } from "node:worker_threads";
import koffi from "koffi";
import { encodeRgbaToPng } from "./png-encoder.js";

const FPDFBitmap_BGRA = 4;
const FPDF_ANNOT = 0x01;

const loadedLibraries = new Map();

function pdfiumFunctions(dllPath) {
  let lib = loadedLibraries.get(dllPath);
  if (lib) return lib;
  const handle = koffi.load(dllPath);
  lib = {
    handle,
    FPDF_InitLibrary: handle.func("void FPDF_InitLibrary()"),
    FPDF_DestroyLibrary: handle.func("void FPDF_DestroyLibrary()"),
    FPDF_GetLastError: handle.func("unsigned long FPDF_GetLastError()"),
    FPDF_LoadMemDocument64: handle.func(
      "void *FPDF_LoadMemDocument64(const void *data_buf, size_t size, const char *password)",
    ),
    FPDF_CloseDocument: handle.func("void FPDF_CloseDocument(void *document)"),
    FPDF_GetPageCount: handle.func("int FPDF_GetPageCount(void *document)"),
    FPDF_LoadPage: handle.func("void *FPDF_LoadPage(void *document, int page_index)"),
    FPDF_ClosePage: handle.func("void FPDF_ClosePage(void *page)"),
    FPDFBitmap_CreateEx: handle.func(
      "void *FPDFBitmap_CreateEx(int width, int height, int format, void *first_scan, int stride)",
    ),
    FPDFBitmap_FillRect: handle.func(
      "bool FPDFBitmap_FillRect(void *bitmap, int left, int top, int width, int height, uint32_t color)",
    ),
    FPDF_RenderPageBitmap: handle.func(
      "void FPDF_RenderPageBitmap(void *bitmap, void *page, int start_x, int start_y, int size_x, int size_y, int rotate, int flags)",
    ),
    FPDFBitmap_GetBuffer: handle.func("void *FPDFBitmap_GetBuffer(void *bitmap)"),
    FPDFBitmap_GetStride: handle.func("int FPDFBitmap_GetStride(void *bitmap)"),
    FPDFBitmap_Destroy: handle.func("void FPDFBitmap_Destroy(void *bitmap)"),
  };
  loadedLibraries.set(dllPath, lib);
  return lib;
}

// Renders page 0 of a single-page, already-decrypted plaintext PDF (the
// caller uses pdf-lib to both select the page and strip any password before
// this ever runs, exactly like the macOS system renderer does for qlmanage)
// to a tightly packed RGBA PNG buffer at an exact pixel size.
export async function renderPdfiumPageToPng({ dllPath, sourcePdfPath, widthPx, heightPx }) {
  if (!Number.isInteger(widthPx) || !Number.isInteger(heightPx) || widthPx <= 0 || heightPx <= 0) {
    throw new TypeError("widthPx and heightPx must be positive integers.");
  }
  const fn = pdfiumFunctions(dllPath);
  const sourceBytes = await readFile(sourcePdfPath);
  fn.FPDF_InitLibrary();
  let document = null;
  let page = null;
  let bitmap = null;
  try {
    document = fn.FPDF_LoadMemDocument64(sourceBytes, sourceBytes.length, null);
    if (!document) {
      throw new Error(`PDFium failed to load the document (error ${fn.FPDF_GetLastError()}).`);
    }
    if (fn.FPDF_GetPageCount(document) < 1) {
      throw new Error("PDFium reported zero pages in the single-page render source.");
    }
    page = fn.FPDF_LoadPage(document, 0);
    if (!page) {
      throw new Error(`PDFium failed to load the page (error ${fn.FPDF_GetLastError()}).`);
    }
    // No external buffer, so pass stride 0 per fpdfview.h's own guidance ("When
    // not using an external buffer, it is recommended for the caller to pass in
    // 0") and read back whatever stride PDFium actually chose below, rather than
    // assuming it is the tightly packed width * 4.
    bitmap = fn.FPDFBitmap_CreateEx(widthPx, heightPx, FPDFBitmap_BGRA, null, 0);
    if (!bitmap) {
      throw new Error("PDFium failed to create the render bitmap.");
    }
    fn.FPDFBitmap_FillRect(bitmap, 0, 0, widthPx, heightPx, 0xffffffff);
    fn.FPDF_RenderPageBitmap(bitmap, page, 0, 0, widthPx, heightPx, 0, FPDF_ANNOT);
    const bufferPointer = fn.FPDFBitmap_GetBuffer(bitmap);
    const actualStride = fn.FPDFBitmap_GetStride(bitmap);
    if (!bufferPointer || actualStride < widthPx * 4) {
      throw new Error("PDFium returned an unusable render buffer.");
    }
    // koffi.decode() copies the bytes out rather than viewing external memory
    // in place: koffi.view() is documented to throw inside some runtimes
    // (Electron among them), and the worker-thread render path runs inside
    // Claude Desktop's own Electron process.
    const bgra = Buffer.from(koffi.decode(bufferPointer, "uint8_t", actualStride * heightPx));
    const rgba = Buffer.alloc(widthPx * heightPx * 4);
    for (let row = 0; row < heightPx; row += 1) {
      const rowStart = row * actualStride;
      for (let column = 0; column < widthPx; column += 1) {
        const sourceOffset = rowStart + column * 4;
        const destOffset = (row * widthPx + column) * 4;
        rgba[destOffset] = bgra[sourceOffset + 2]; // R
        rgba[destOffset + 1] = bgra[sourceOffset + 1]; // G
        rgba[destOffset + 2] = bgra[sourceOffset]; // B
        rgba[destOffset + 3] = bgra[sourceOffset + 3]; // A
      }
    }
    return encodeRgbaToPng(rgba, widthPx, heightPx);
  } finally {
    if (bitmap) fn.FPDFBitmap_Destroy(bitmap);
    if (page) fn.FPDF_ClosePage(page);
    if (document) fn.FPDF_CloseDocument(document);
    fn.FPDF_DestroyLibrary();
  }
}

async function runAsWorker() {
  try {
    const { dllPath, heightPx, outputPngPath, sourcePdfPath, widthPx } = workerData;
    const png = await renderPdfiumPageToPng({ dllPath, heightPx, sourcePdfPath, widthPx });
    await writeFile(outputPngPath, png);
    parentPort.postMessage({ status: "ok" });
  } catch (error) {
    parentPort.postMessage({
      status: "error",
      message: error instanceof Error ? error.message : String(error),
    });
  }
}

async function runAsSubprocess() {
  const [dllPath, sourcePdfPath, widthArg, heightArg, outputPngPath] = process.argv.slice(2);
  const widthPx = Number(widthArg);
  const heightPx = Number(heightArg);
  const png = await renderPdfiumPageToPng({ dllPath, heightPx, sourcePdfPath, widthPx });
  await writeFile(outputPngPath, png);
}

if (!isMainThread && workerData?.pdf_tools_worker === "pdfium_render") {
  await runAsWorker();
} else if (isMainThread && process.argv[1]?.endsWith("pdfium-render-host.mjs")) {
  await runAsSubprocess();
}
