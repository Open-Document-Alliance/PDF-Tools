/**
 * Binds the committed vendor/pdfium/ runtime to its own provenance and lock
 * file, mirroring test/qpdf-wasm-runtime-artifact.test.js for the other
 * vendored runtime. Unlike QPDF, PDFium is not built from source here (see
 * vendor/pdfium/README.md), so there is no reproducibility gate to bind to —
 * just the pinned download hashes in sources.lock.json and the release's own
 * bundled license notices.
 *
 * The one part of this suite that actually loads pdfium.dll and renders a
 * page is gated to win32: koffi cannot load a Windows PE binary on any other
 * platform, so that coverage is real only when this suite runs on
 * windows-latest (see .github/workflows/windows-render.yml).
 */
import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const VENDOR_DIR = path.join(REPO_ROOT, "vendor", "pdfium");

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

async function readJson(...segments) {
  return JSON.parse(await fs.readFile(path.join(...segments), "utf8"));
}

const sourcesLock = await readJson(VENDOR_DIR, "sources.lock.json");
const provenance = await readJson(VENDOR_DIR, "runtime.provenance.json");
const licenseManifest = await readJson(VENDOR_DIR, "licenses", "manifest.json");

describe("committed PDFium runtime", () => {
  it("matches the pinned DLL hash and size for every architecture in sources.lock.json", async () => {
    expect(sourcesLock.assets.map(asset => asset.arch).sort()).toEqual(["win-arm64", "win-x64"]);
    for (const asset of sourcesLock.assets) {
      const dllPath = path.join(VENDOR_DIR, "runtime", asset.arch, "pdfium.dll");
      const bytes = await fs.readFile(dllPath);
      expect(bytes.length, `${asset.arch} pdfium.dll size`).toBe(asset.extracted_size_bytes);
      expect(sha256(bytes), `${asset.arch} pdfium.dll sha256`).toBe(asset.extracted_sha256);
    }
  });

  it("agrees with runtime.provenance.json about the same two files", async () => {
    for (const file of provenance.runtime_assets.files) {
      const bytes = await fs.readFile(path.join(REPO_ROOT, ...file.path.split("/")));
      expect(bytes.length, `${file.path} size`).toBe(file.size_bytes);
      expect(sha256(bytes), `${file.path} sha256`).toBe(file.sha256);
    }
    expect(provenance.runtime_assets.files.map(file => file.path).sort()).toEqual([
      "vendor/pdfium/runtime/win-arm64/pdfium.dll",
      "vendor/pdfium/runtime/win-x64/pdfium.dll",
    ]);
  });

  it("is reachable from exactly one server module", async () => {
    const referencing = [];
    for (const filename of await fs.readdir(path.join(REPO_ROOT, "server"))) {
      if (!filename.endsWith(".js") && !filename.endsWith(".mjs")) continue;
      const source = await fs.readFile(path.join(REPO_ROOT, "server", filename), "utf8");
      if (source.includes("vendor/pdfium") || source.includes("vendor\", \"pdfium\"")) {
        referencing.push(`server/${filename}`);
      }
    }
    // server/index.js only checks the DLL exists to decide the renderer
    // policy (see systemRendererAvailableOnThisHost); server/pdfjs-worker.js
    // computes the DLL path and picks the subprocess-vs-worker isolation
    // strategy; server/pdfjs-subprocess.js validates the same path in its
    // sandboxed spawn whitelist. None of them load pdfium.dll themselves.
    expect(referencing.sort()).toEqual([
      "server/index.js",
      "server/pdfjs-subprocess.js",
      "server/pdfjs-worker.js",
    ]);
    // pdfium-render-host.mjs never constructs the vendor path itself (it
    // receives dllPath as a parameter from its callers above); it is the only
    // module that actually loads whatever path it is given.
    const loaders = [];
    for (const filename of await fs.readdir(path.join(REPO_ROOT, "server"))) {
      if (!filename.endsWith(".js") && !filename.endsWith(".mjs")) continue;
      const source = await fs.readFile(path.join(REPO_ROOT, "server", filename), "utf8");
      if (source.includes("koffi.load(")) loaders.push(`server/${filename}`);
    }
    expect(loaders).toEqual(["server/pdfium-render-host.mjs"]);
  });
});

describe("PDFium runtime notices", () => {
  it("ships every notice the license manifest binds, byte-identical to what is committed", async () => {
    for (const entry of licenseManifest.notices) {
      const bytes = await fs.readFile(path.join(VENDOR_DIR, "licenses", entry.file));
      expect(bytes.length, `${entry.file} size`).toBe(entry.size_bytes);
      expect(sha256(bytes), `${entry.file} sha256`).toBe(entry.sha256);
    }
  });

  it("covers PDFium and every statically linked component, with no copyleft license", () => {
    const components = provenance.notices.components;
    const componentNames = components.map(entry => entry.component).sort();
    expect(componentNames).toEqual([
      "Abseil",
      "Anti-Grain Geometry (agg23)",
      "FreeType",
      "ICU",
      "LLVM libc",
      "Little CMS (lcms)",
      "OpenJPEG",
      "PDFium",
      "fast_float",
      "libjpeg-turbo",
      "libjpeg-turbo (IJG README)",
      "libpng",
      "pdfium-binaries build scripts",
      "simdutf",
      "zlib",
    ]);
    for (const entry of components) {
      expect(entry.spdx, entry.component).not.toMatch(/GPL/);
    }
  });

  it("builds without V8 or XFA, so no additional V8 licenses apply", () => {
    expect(sourcesLock.upstream.build_flags).toEqual({
      pdf_enable_v8: false,
      pdf_enable_xfa: false,
    });
    expect(provenance.notices.components.map(entry => entry.component)).not.toContain("V8");
  });
});

describe.skipIf(process.platform !== "win32")(
  "PDFium runtime execution (win32 only)",
  () => {
    it("loads the committed DLL for this host's architecture and renders a page", async () => {
      const { renderPdfiumPageToPng } = await import("../server/pdfium-render-host.mjs");
      const dllArch = process.arch === "arm64" ? "win-arm64" : "win-x64";
      const dllPath = path.join(VENDOR_DIR, "runtime", dllArch, "pdfium.dll");
      const png = await renderPdfiumPageToPng({
        dllPath,
        sourcePdfPath: path.join(REPO_ROOT, "example-fw9.pdf"),
        widthPx: 200,
        heightPx: 260,
      });
      expect(png.subarray(0, 8)).toEqual(
        Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
      );
    }, 30000);
  },
);
