/*
 * The PDFium Windows runtime definition, paralleling qpdf-wasm-runtime.mjs.
 *
 * Vendored official Google Chromium PDFium prebuilt binaries for Windows platforms,
 * downloaded and promoted by scripts/vendor-pdfium-runtime.mjs. The runtime is
 * staged into the MCPB for Windows targets only (win32-x64 and win32-arm64);
 * darwin and linux targets do not receive it.
 *
 * Every entry carries the size and SHA-256 of the bytes that were promoted,
 * so a packager can assert that what it staged is what was reviewed instead of
 * merely asserting that a file of the right name exists. That is the check that
 * distinguishes a shipped artifact from a present one.
 *
 * The runtime is loaded only on Windows by server/pdfjs-subprocess.js's
 * runSystemCommand, which spawns server/pdfium-render-host.mjs as a disposable
 * child process. The child loads pdfium.dll via the koffi FFI library and
 * renders a page to an in-memory RGBA bitmap, which is encoded to PNG in pure
 * JavaScript and returned. The pdfium.dll binary never returns to the server;
 * only the PNG bytes cross the process boundary.
 */

import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(SCRIPT_DIR, "..");

export const PDFIUM_RUNTIME_DIRECTORY = "vendor/pdfium/runtime";
export const PDFIUM_RUNTIME_PROVENANCE_PATH = "vendor/pdfium/runtime.provenance.json";

export const PDFIUM_RUNTIME_PROVENANCE = Object.freeze(JSON.parse(readFileSync(
  path.join(REPO_ROOT, ...PDFIUM_RUNTIME_PROVENANCE_PATH.split("/")),
  "utf8",
)));

/*
 * Repository-relative paths, which are also the archive-relative paths in the MCPB.
 * Windows platforms only.
 */
export const PDFIUM_RUNTIME_ASSETS = Object.freeze(
  PDFIUM_RUNTIME_PROVENANCE.runtime_assets.files.map(asset => Object.freeze({
    path: asset.path,
    sha256: asset.sha256,
    size_bytes: asset.size_bytes,
  })),
);

export const PDFIUM_RUNTIME_FILES = Object.freeze(
  PDFIUM_RUNTIME_ASSETS.map(asset => asset.path),
);

/**
 * Verify that the promoted pdfium runtime at `rootDir` matches the provenance
 * record. Used against the checkout and against a staged MCPB.
 */
export function verifyPdfiumRuntime(rootDir, label = "checkout") {
  const inventory = PDFIUM_RUNTIME_ASSETS;
  for (const asset of inventory) {
    const absolutePath = path.join(rootDir, ...asset.path.split("/"));
    let bytes;
    try {
      bytes = readFileSync(absolutePath);
    } catch (error) {
      throw new Error(
        `PDFium runtime verification (${label}) failed: ${asset.path} is not readable: ${error.message}`,
      );
    }
    const digest = createHash("sha256").update(bytes).digest("hex");
    if (bytes.length !== asset.size_bytes || digest !== asset.sha256) {
      throw new Error(
        `PDFium runtime verification (${label}) failed: ${asset.path} digest or size disagrees `
        + `(expected ${asset.size_bytes} bytes/${asset.sha256}, found ${bytes.length} bytes/${digest})`,
      );
    }
  }
}
