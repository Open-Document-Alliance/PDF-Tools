import { createRequire } from "node:module";
import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import { closeSync, existsSync, writeSync } from "node:fs";
import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
  isMainThread,
  parentPort,
  workerData,
} from "node:worker_threads";
import { PDFDocument } from "pdf-lib";
import {
  analyzePdfPages,
  deriveTextIntegrityForRouting,
  measureTextVisibility,
  detectSignatureZones,
  getPageBoxGeometry,
  getPageRenderScale,
  isPdfLibEncryptedError,
  PDF_LIB_ENCRYPTED_MESSAGE,
  validatePdfRegionBox,
} from "./helpers.js";
import {
  extractPdfLayout,
  extractPdfLayoutForMarkdown,
} from "./layout-extraction.js";
import {
  PDF_OBSERVATION_LIMITS,
  buildAnnotationObservation,
  buildDocumentObservation,
  buildFormFieldObservation,
  buildMetadataObservation,
  buildPageObservation,
  pageGeometryFromPdfLib,
  pageViewFromPdfjs,
} from "./pdf-observations.js";
import { withBoundedPdfFileSafely } from "./bounded-pdf-file.js";

const PROTOCOL_VERSION = 1;
const MAX_REQUEST_BYTES = 64 * 1024;
const MAX_RESPONSE_BYTES = 24 * 1024 * 1024;
const MAX_BINARY_BYTES = 16 * 1024 * 1024;
const MAX_CANVAS_AXIS_PX = 8192;
const MAX_CANVAS_PIXELS = 16 * 1024 * 1024;
const MAX_PASSWORD_CHARACTERS = 4096;
const SYSTEM_COMMAND_TIMEOUT_MS = 15_000;
const PDF_RESOURCE_LIMIT_CODE = "PDF_RESOURCE_LIMIT_EXCEEDED";
// The two reasons systemRendererShutdownError() can carry. A rejection with one
// of these says "we tore this renderer down", never "this renderer broke".
const SYSTEM_RENDERER_SHUTDOWN_REASONS = new Set([
  "system_renderer_shutdown",
  "system_renderer_shutdown_terminal",
]);
const _require = createRequire(import.meta.url);
const activeSystemChildren = new Set();
const activeSystemRenderWorkspaces = new Set();
const threadSystemCommandWaiters = new Map();
let systemChildTermination = null;
let systemChildTerminationFault = false;
let systemChildTerminationHandlersInstalled = false;
let systemRenderShutdownStarted = false;
let systemRenderShutdownTerminal = false;
let systemCommandSpawnCount = 0;
let systemRendererControllerShutdownProbe = null;
// Why the embedded-host guard last refused to load the native canvas binding.
// Bound from pdfjs-subprocess.js, which owns that decision. It cannot travel on
// the thrown error: @napi-rs/canvas catches whatever dlopen throws and reports
// its own "Cannot find native binding" instead, discarding ours.
let nativeCanvasBlockReasonProbe = null;
let nextThreadSystemCommandId = 1;

const OPERATION_OPTION_KEYS = new Map([
  ["analyze_pages", ["max_pages"]],
  ["detect_signature_zones", []],
  ["observe_document", ["max_output_characters", "max_pages"]],
  [
    "extract_layout",
    [
      "end_page",
      "max_characters",
      "max_items",
      "max_output_characters",
      "source_file_name",
      "source_path",
      "start_page",
    ],
  ],
  [
    "extract_layout_for_markdown",
    [
      "end_page",
      "max_characters",
      "max_items",
      "max_output_characters",
      "source_file_name",
      "source_path",
      "start_page",
    ],
  ],
  ["read_content", ["max_pages"]],
  ["read_pages", ["end_page", "max_chars_per_page", "start_page"]],
  [
    "render_page",
    ["max_dimension_px", "page", "renderer_policy", "scale_override"],
  ],
  [
    "render_comparison_page",
    ["max_dimension_px", "page", "renderer_policy", "scale_override"],
  ],
  [
    "render_region",
    ["height", "max_dimension_px", "page", "renderer_policy", "width", "x", "y"],
  ],
  ["search_text", ["context_chars", "max_results", "query"]],
]);

function exactKeys(value, expected, label) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError(`${label} must be an object.`);
  }
  const actual = Object.keys(value).sort();
  const wanted = [...expected].sort();
  if (actual.length !== wanted.length || actual.some((key, index) => key !== wanted[index])) {
    throw new TypeError(`${label} has an invalid shape.`);
  }
}

function boundedString(value, label, maximum, { nullable = false } = {}) {
  if (nullable && value === null) return value;
  if (typeof value !== "string" || value.length === 0 || value.length > maximum) {
    throw new TypeError(`${label} must be a non-empty string of at most ${maximum} characters.`);
  }
  return value;
}

function boundedInteger(value, label, minimum, maximum, { nullable = false } = {}) {
  if (nullable && value === null) return value;
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
    throw new TypeError(`${label} must be an integer from ${minimum} to ${maximum}.`);
  }
  return value;
}

function boundedNumber(value, label, minimum, maximum) {
  if (!Number.isFinite(value) || value < minimum || value > maximum) {
    throw new TypeError(`${label} must be a finite number from ${minimum} to ${maximum}.`);
  }
  return value;
}

function rendererPolicy(value) {
  if (![
    "forced_unavailable",
    "native",
    "native_with_system_fallback",
    "system",
  ].includes(value)) {
    throw new TypeError("renderer_policy is invalid.");
  }
  return value;
}

function validateOptions(operation, options) {
  const expected = OPERATION_OPTION_KEYS.get(operation);
  if (!expected) throw new TypeError(`Unsupported PDF.js operation: ${operation}.`);
  exactKeys(options, expected, `${operation} options`);
  switch (operation) {
    case "read_content":
      boundedInteger(options.max_pages, "max_pages", 1, 1_000_000, { nullable: true });
      break;
    case "read_pages":
      boundedInteger(options.start_page, "start_page", 1, 1_000_000);
      boundedInteger(options.end_page, "end_page", options.start_page, 1_000_000);
      boundedInteger(options.max_chars_per_page, "max_chars_per_page", 1, 20_000);
      break;
    case "search_text":
      boundedString(options.query, "query", 4096);
      boundedInteger(options.max_results, "max_results", 1, 100);
      boundedInteger(options.context_chars, "context_chars", 10, 2000);
      break;
    case "extract_layout":
    case "extract_layout_for_markdown":
      boundedString(options.source_path, "source_path", 32_768);
      boundedString(options.source_file_name, "source_file_name", 4096);
      boundedInteger(options.start_page, "start_page", 1, 1_000_000);
      boundedInteger(options.end_page, "end_page", options.start_page, 1_000_000);
      boundedInteger(options.max_items, "max_items", 1, 5000);
      boundedInteger(options.max_characters, "max_characters", 1, 100_000);
      boundedInteger(
        options.max_output_characters,
        "max_output_characters",
        20_000,
        200_000,
      );
      break;
    case "render_page":
    case "render_comparison_page":
      boundedInteger(options.page, "page", 1, 1_000_000);
      rendererPolicy(options.renderer_policy);
      boundedInteger(
        options.max_dimension_px,
        "max_dimension_px",
        64,
        8192,
        { nullable: true },
      );
      if (options.scale_override !== null) {
        boundedNumber(options.scale_override, "scale_override", 0.01, 4);
      }
      if ((options.max_dimension_px === null) === (options.scale_override === null)) {
        throw new TypeError(
          "render_page requires exactly one of max_dimension_px or scale_override.",
        );
      }
      break;
    case "render_region":
      boundedInteger(options.page, "page", 1, 1_000_000);
      rendererPolicy(options.renderer_policy);
      boundedInteger(options.max_dimension_px, "max_dimension_px", 64, 8192);
      boundedNumber(options.x, "x", 0, 10_000_000);
      boundedNumber(options.y, "y", 0, 10_000_000);
      boundedNumber(options.width, "width", 0.001, 10_000_000);
      boundedNumber(options.height, "height", 0.001, 10_000_000);
      break;
    case "analyze_pages":
      boundedInteger(options.max_pages, "max_pages", 1, 200);
      break;
    case "observe_document":
      boundedInteger(options.max_pages, "max_pages", 1, 200);
      boundedInteger(
        options.max_output_characters,
        "max_output_characters",
        20_000,
        200_000,
      );
      break;
    case "detect_signature_zones":
      break;
  }
}

function validateRequest(request) {
  exactKeys(
    request,
    [
      "allowed_directories",
      "operation",
      "options",
      "password",
      "protocol_version",
      "source",
    ],
    "PDF.js worker request",
  );
  if (request.protocol_version !== PROTOCOL_VERSION) {
    throw new TypeError(`protocol_version must be ${PROTOCOL_VERSION}.`);
  }
  if (!OPERATION_OPTION_KEYS.has(request.operation)) {
    throw new TypeError(`Unsupported PDF.js operation: ${request.operation}.`);
  }
  exactKeys(
    request.source,
    ["canonical_path", "file_identity", "sha256", "size_bytes"],
    "source",
  );
  boundedString(request.source.canonical_path, "source.canonical_path", 32_768);
  boundedInteger(request.source.size_bytes, "source.size_bytes", 1, 250 * 1024 * 1024);
  if (!/^[a-f0-9]{64}$/.test(request.source.sha256)) {
    throw new TypeError("source.sha256 must be a lowercase SHA-256 digest.");
  }
  exactKeys(request.source.file_identity, ["device", "inode"], "source.file_identity");
  boundedString(request.source.file_identity.device, "source.file_identity.device", 128);
  boundedString(request.source.file_identity.inode, "source.file_identity.inode", 128);
  if (
    !Array.isArray(request.allowed_directories)
    || request.allowed_directories.length < 1
    || request.allowed_directories.length > 64
  ) {
    throw new TypeError("allowed_directories has an invalid shape.");
  }
  request.allowed_directories.forEach((directory, index) => {
    boundedString(directory, `allowed_directories[${index}]`, 32_768);
  });
  boundedString(
    request.password,
    "password",
    MAX_PASSWORD_CHARACTERS,
    { nullable: true },
  );
  validateOptions(request.operation, request.options);
  return request;
}

async function readRequest() {
  const chunks = [];
  let bytes = 0;
  for await (const chunk of process.stdin) {
    bytes += chunk.length;
    if (bytes > MAX_REQUEST_BYTES) {
      throw resourceLimitError("worker_request_limit");
    }
    chunks.push(Buffer.from(chunk));
  }
  const encoded = Buffer.concat(chunks).toString("utf8");
  if (encoded.length === 0 || encoded.trim() !== encoded) {
    throw new TypeError("The PDF.js worker request frame is invalid.");
  }
  return validateRequest(JSON.parse(encoded));
}

function isPathInsideDirectory(candidatePath, directoryPath) {
  const relative = path.relative(directoryPath, candidatePath);
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

function createPathPolicy(request) {
  const allowedDirectories = request.allowed_directories.map(directory => path.resolve(directory));
  return candidate => {
    const resolved = path.resolve(candidate);
    if (!allowedDirectories.some(directory => isPathInsideDirectory(resolved, directory))) {
      const error = new Error("The PDF source is outside the configured allowed directories.");
      error.code = "path_policy_denied";
      throw error;
    }
    return resolved;
  };
}

function sameSourceBinding(actual, expected) {
  return actual.canonicalPath === expected.canonical_path
    && actual.sizeBytes === expected.size_bytes
    && actual.sha256 === expected.sha256
    && actual.fileIdentity.device === expected.file_identity.device
    && actual.fileIdentity.inode === expected.file_identity.inode;
}

function sourceChangedError() {
  const error = new Error("The PDF source changed before isolated processing began. Retry the call.");
  error.code = "PDF_CHANGED_DURING_READ";
  return error;
}

function resourceLimitError(reason) {
  const error = new Error(
    "PDF processing exceeded its isolated resource budget. Try a narrower page range, "
    + "smaller render size, or a simpler PDF.",
  );
  error.name = "PdfResourceLimitError";
  error.code = PDF_RESOURCE_LIMIT_CODE;
  error.reason = reason;
  return error;
}

function installThreadNativeModuleGuard() {
  if (isMainThread) return;
  process.dlopen = () => {
    const error = new Error(
      "Native Node modules are disabled inside the PDF.js worker thread.",
    );
    error.code = "PDFJS_THREAD_NATIVE_MODULE_DISABLED";
    throw error;
  };
}

function installBrowserPolyfills() {
  if (typeof globalThis.DOMMatrix === "undefined") {
    globalThis.DOMMatrix = class DOMMatrix {
      constructor(init) {
        const value = Array.isArray(init) || ArrayBuffer.isView(init)
          ? init
          : init && typeof init === "object"
            ? [init.a, init.b, init.c, init.d, init.e, init.f]
            : [1, 0, 0, 1, 0, 0];
        [this.a, this.b, this.c, this.d, this.e, this.f] = value;
        if (![this.a, this.b, this.c, this.d, this.e, this.f].every(Number.isFinite)) {
          throw new TypeError("DOMMatrix requires six finite 2D matrix values.");
        }
        this.#syncFlags();
      }
      #syncFlags() {
        this.is2D = true;
        this.isIdentity = this.a === 1 && this.b === 0 && this.c === 0
          && this.d === 1 && this.e === 0 && this.f === 0;
      }
      #set(value) {
        [this.a, this.b, this.c, this.d, this.e, this.f] = value;
        this.#syncFlags();
        return this;
      }
      multiplySelf(other) {
        const right = DOMMatrix.fromMatrix(other);
        const { a, b, c, d, e, f } = this;
        return this.#set([
          a * right.a + c * right.b,
          b * right.a + d * right.b,
          a * right.c + c * right.d,
          b * right.c + d * right.d,
          a * right.e + c * right.f + e,
          b * right.e + d * right.f + f,
        ]);
      }
      preMultiplySelf(other) {
        const left = DOMMatrix.fromMatrix(other);
        const current = new DOMMatrix(this);
        return this.#set(left.multiplySelf(current).toArray());
      }
      translateSelf(tx = 0, ty = 0) {
        return this.multiplySelf(new DOMMatrix([1, 0, 0, 1, tx, ty]));
      }
      scaleSelf(scaleX = 1, scaleY = scaleX, _scaleZ = 1, originX = 0, originY = 0) {
        return this.translateSelf(originX, originY)
          .multiplySelf(new DOMMatrix([scaleX, 0, 0, scaleY, 0, 0]))
          .translateSelf(-originX, -originY);
      }
      rotateSelf(angle = 0) {
        const radians = angle * Math.PI / 180;
        const cosine = Math.cos(radians);
        const sine = Math.sin(radians);
        return this.multiplySelf(new DOMMatrix([cosine, sine, -sine, cosine, 0, 0]));
      }
      invertSelf() {
        const { a, b, c, d, e, f } = this;
        const determinant = a * d - b * c;
        if (determinant === 0) return this.#set([NaN, NaN, NaN, NaN, NaN, NaN]);
        return this.#set([
          d / determinant,
          -b / determinant,
          -c / determinant,
          a / determinant,
          (c * f - d * e) / determinant,
          (b * e - a * f) / determinant,
        ]);
      }
      multiply(other) { return new DOMMatrix(this).multiplySelf(other); }
      translate(tx = 0, ty = 0) { return new DOMMatrix(this).translateSelf(tx, ty); }
      scale(scaleX = 1, scaleY = scaleX) { return new DOMMatrix(this).scaleSelf(scaleX, scaleY); }
      rotate(angle = 0) { return new DOMMatrix(this).rotateSelf(angle); }
      inverse() { return new DOMMatrix(this).invertSelf(); }
      transformPoint(point = {}) {
        const x = Number(point.x ?? 0);
        const y = Number(point.y ?? 0);
        return {
          x: this.a * x + this.c * y + this.e,
          y: this.b * x + this.d * y + this.f,
          z: Number(point.z ?? 0),
          w: Number(point.w ?? 1),
        };
      }
      toArray() { return [this.a, this.b, this.c, this.d, this.e, this.f]; }
      static fromMatrix(value) {
        return new DOMMatrix([value.a, value.b, value.c, value.d, value.e, value.f]);
      }
      static fromFloat32Array(value) { return new DOMMatrix(Array.from(value)); }
      static fromFloat64Array(value) { return new DOMMatrix(Array.from(value)); }
    };
  }
  if (typeof globalThis.Path2D === "undefined") {
    globalThis.Path2D = class Path2D {
      addPath() {}
      closePath() {}
      moveTo() {}
      lineTo() {}
      bezierCurveTo() {}
      quadraticCurveTo() {}
      arc() {}
      arcTo() {}
      ellipse() {}
      rect() {}
    };
  }
  if (typeof globalThis.ImageData === "undefined") {
    globalThis.ImageData = class ImageData {
      constructor(width, height) {
        const pixels = validateCanvasDimensions(width, height);
        this.width = pixels.width;
        this.height = pixels.height;
        this.data = new Uint8ClampedArray(pixels.rgbaBytes);
      }
    };
  }
}

let pdfjsLib = null;
let createCanvas = null;

async function importPdfjsForNodeCompatibleElectronHost() {
  const electronDescriptor = Object.getOwnPropertyDescriptor(
    process.versions,
    "electron",
  );
  const requiresNodeCompatibilityImport = typeof electronDescriptor?.value === "string"
    && process.type
    && process.type !== "browser";
  if (!requiresNodeCompatibilityImport) {
    return await import("pdfjs-dist/legacy/build/pdf.mjs");
  }
  if (!electronDescriptor.configurable) {
    const error = new Error(
      "The embedded PDF host cannot safely disable PDF.js Web Worker detection.",
    );
    error.code = "PDFJS_EMBEDDED_HOST_UNSUPPORTED";
    throw error;
  }
  delete process.versions.electron;
  try {
    return await import("pdfjs-dist/legacy/build/pdf.mjs");
  } finally {
    Object.defineProperty(process.versions, "electron", electronDescriptor);
  }
}

async function loadPdfjs() {
  if (pdfjsLib) return pdfjsLib;
  installBrowserPolyfills();
  const imported = await importPdfjsForNodeCompatibleElectronHost();
  pdfjsLib = imported.default || imported;
  pdfjsLib.GlobalWorkerOptions.workerSrc = pathToFileURL(
    _require.resolve("pdfjs-dist/legacy/build/pdf.worker.mjs"),
  ).href;
  pdfjsLib.GlobalWorkerOptions.isEvalSupported = false;
  return pdfjsLib;
}

// Maintenance scripts use the production loader so glyph-program evidence is
// never computed under a different DOM/canvas implementation than the worker.
export async function loadPdfjsForMaintenance() {
  return await loadPdfjs();
}

function nativeCanvasBindingCandidate() {
  const packageByPlatform = {
    "darwin-arm64": "@napi-rs/canvas-darwin-arm64",
    "darwin-x64": "@napi-rs/canvas-darwin-x64",
    "win32-arm64": "@napi-rs/canvas-win32-arm64-msvc",
    "win32-x64": "@napi-rs/canvas-win32-x64-msvc",
    "linux-arm64": "@napi-rs/canvas-linux-arm64-gnu",
    "linux-x64": "@napi-rs/canvas-linux-x64-gnu",
  };
  const packageName = packageByPlatform[`${process.platform}-${process.arch}`];
  if (!packageName) return null;
  try {
    return _require.resolve(packageName);
  } catch {
    try {
      const canvasDirectory = path.dirname(_require.resolve("@napi-rs/canvas/package.json"));
      const packageDirectory = path.dirname(canvasDirectory);
      const nativeFile = packageName.split("/").pop().replace("canvas-", "skia.") + ".node";
      const candidate = path.join(
        packageDirectory,
        packageName.split("/").pop(),
        nativeFile,
      );
      return existsSync(candidate) ? candidate : null;
    } catch {
      return null;
    }
  }
}

async function loadCanvas() {
  await loadPdfjs();
  if (createCanvas) return createCanvas;
  const candidate = nativeCanvasBindingCandidate();
  if (candidate) process.env.NAPI_RS_NATIVE_LIBRARY_PATH = candidate;
  try {
    const canvas = await import("@napi-rs/canvas");
    createCanvas = canvas.createCanvas;
    if (canvas.DOMMatrix) globalThis.DOMMatrix = canvas.DOMMatrix;
    if (canvas.Path2D) globalThis.Path2D = canvas.Path2D;
    if (canvas.ImageData) globalThis.ImageData = canvas.ImageData;
    return createCanvas;
  } finally {
    delete process.env.NAPI_RS_NATIVE_LIBRARY_PATH;
  }
}

function validateCanvasDimensions(rawWidth, rawHeight) {
  if (
    !Number.isFinite(rawWidth)
    || !Number.isFinite(rawHeight)
    || rawWidth <= 0
    || rawHeight <= 0
  ) {
    throw resourceLimitError("invalid_canvas_dimensions");
  }
  const width = Math.ceil(rawWidth);
  const height = Math.ceil(rawHeight);
  if (
    !Number.isSafeInteger(width)
    || !Number.isSafeInteger(height)
    || width > MAX_CANVAS_AXIS_PX
    || height > MAX_CANVAS_AXIS_PX
  ) {
    throw resourceLimitError("canvas_axis_limit");
  }
  const pixels = width * height;
  const rgbaBytes = pixels * 4;
  if (
    !Number.isSafeInteger(pixels)
    || !Number.isSafeInteger(rgbaBytes)
    || pixels > MAX_CANVAS_PIXELS
  ) {
    throw resourceLimitError("canvas_pixel_limit");
  }
  return { height, pixels, rgbaBytes, width };
}

class PdfToolsCanvasFactory {
  create(width, height) {
    const pixels = validateCanvasDimensions(width, height);
    const canvas = createCanvas(pixels.width, pixels.height);
    return {
      canvas,
      context: canvas.getContext("2d", { willReadFrequently: true }),
    };
  }

  reset(canvasAndContext, width, height) {
    if (!canvasAndContext.canvas) throw new Error("Canvas is not specified.");
    const pixels = validateCanvasDimensions(width, height);
    canvasAndContext.canvas.width = pixels.width;
    canvasAndContext.canvas.height = pixels.height;
  }

  destroy(canvasAndContext) {
    if (!canvasAndContext.canvas) throw new Error("Canvas is not specified.");
    canvasAndContext.canvas.width = 0;
    canvasAndContext.canvas.height = 0;
    canvasAndContext.canvas = null;
    canvasAndContext.context = null;
  }
}

class PdfToolsFilterFactory {
  addFilter() { return "none"; }
  addHCMFilter() { return "none"; }
  addAlphaFilter() { return "none"; }
  addLuminosityFilter() { return "none"; }
  addHighlightHCMFilter() { return "none"; }
  destroy() {}
}

function nodeRenderingOptions() {
  return {
    CanvasFactory: PdfToolsCanvasFactory,
    FilterFactory: PdfToolsFilterFactory,
    isOffscreenCanvasSupported: false,
    isImageDecoderSupported: false,
  };
}

function pdfjsDocumentOptions(bytes, password, { render = false } = {}) {
  return {
    data: new Uint8Array(bytes),
    password: password || undefined,
    ...(render ? nodeRenderingOptions() : {}),
    useSystemFonts: true,
    disableFontFace: true,
    disableAutoFetch: true,
    useWorkerFetch: false,
    isEvalSupported: false,
    verbosity: 0,
  };
}

function normalizeText(value) {
  return String(value ?? "")
    .replace(/\r\n/g, "\n")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

async function pageText(page) {
  const content = await page.getTextContent();
  return content.items.map(item => item.str).join("");
}

async function withPdfjsDocument(bytes, password, action, { render = false } = {}) {
  const pdfjs = await loadPdfjs();
  if (render) await loadCanvas();
  const loadingTask = pdfjs.getDocument(pdfjsDocumentOptions(bytes, password, { render }));
  let document = null;
  try {
    document = await loadingTask.promise;
    return await action(document, pdfjs);
  } finally {
    try {
      await document?.destroy();
    } catch {}
    try {
      await loadingTask.destroy();
    } catch {}
  }
}

export async function readContentFromDocument(document, options, pdfjs = null) {
  const pagesRead = options.max_pages === null
    ? document.numPages
    : Math.min(options.max_pages, document.numPages);
  let sourceLength = 0;
  let prefix = "";
  let textFound = false;
  let previewRemaining = 12_000;
  let previewTruncated = false;
  const pagePreviews = [];
  const pagesWithoutText = [];
  const pagesWithSuspectedTextIntegrity = [];
  const pagesWithInvisibleText = [];
  const pagesWithUnavailableTextVisibility = [];
  let pagesReadSuccessfully = 0;
  let pageReadError = null;
  for (let pageNumber = 1; pageNumber <= pagesRead; pageNumber += 1) {
    let page = null;
    try {
      page = await document.getPage(pageNumber);
      const textContent = await page.getTextContent();
      const textItems = textContent.items
        .filter(item => typeof item?.str === "string")
        .map(item => item.str);
      const rawText = textItems.join("");
      const textIntegrity = deriveTextIntegrityForRouting(textItems);
      if (textIntegrity.status === "suspect") {
        pagesWithSuspectedTextIntegrity.push({ page: pageNumber, signals: textIntegrity.signals });
      }
      if (pageNumber > 1) {
        sourceLength += 2;
        if (prefix.length < 50_000) prefix += "\n\n".slice(0, 50_000 - prefix.length);
      }
      sourceLength += rawText.length;
      if (prefix.length < 50_000) prefix += rawText.slice(0, 50_000 - prefix.length);
      const hasText = rawText.trim().length > 0;
      if (hasText) {
        let visibility = measureTextVisibility(null, null);
        try {
          visibility = measureTextVisibility(pdfjs, await page.getOperatorList());
        } catch { /* Preserve extracted text; unavailable is not a clean bill of health. */ }
        if (visibility.status === "unavailable") pagesWithUnavailableTextVisibility.push(pageNumber);
        else if (visibility.invisible_text_show_count > 0) {
          pagesWithInvisibleText.push({ page: pageNumber, ...visibility });
        }
      }
      if (hasText) textFound = true;
      else pagesWithoutText.push(pageNumber);

      const normalized = normalizeText(rawText);
      const available = Math.max(Math.min(previewRemaining, 2000), 0);
      const returned = normalized.slice(0, available);
      const truncated = returned.length < normalized.length;
      previewTruncated ||= truncated;
      pagePreviews.push({
        page: pageNumber,
        char_count: normalized.length,
        returned_chars: returned.length,
        truncated,
        text: returned,
      });
      previewRemaining -= returned.length;
      pagesReadSuccessfully += 1;
    } catch {
      pageReadError = {
        page: pageNumber,
        code: "PDFJS_PAGE_READ_FAILED",
      };
      break;
    } finally {
      try {
        page?.cleanup();
      } catch {}
    }
  }
  return {
    output_text: prefix,
    page_previews: pagePreviews,
    pages_without_text: pagesWithoutText,
    pages_with_suspected_text_integrity: pagesWithSuspectedTextIntegrity,
    pages_with_invisible_text: pagesWithInvisibleText,
    pages_with_unavailable_text_visibility: pagesWithUnavailableTextVisibility,
    page_read_error: pageReadError,
    pages_read: pagesReadSuccessfully,
    preview_truncated: previewTruncated,
    source_length: sourceLength,
    text_found: textFound,
    text_truncated: sourceLength > 50_000,
    total_pages: document.numPages,
  };
}

async function readContent(bytes, password, options) {
  return await withPdfjsDocument(bytes, password, (document, pdfjs) =>
    readContentFromDocument(document, options, pdfjs));
}

async function readPages(bytes, password, options) {
  return await withPdfjsDocument(bytes, password, async document => {
    if (options.start_page > document.numPages || options.end_page > document.numPages) {
      throw new Error(
        `Requested pages ${options.start_page}-${options.end_page} are out of range `
        + `(1-${document.numPages}).`,
      );
    }
    const pages = [];
    let remaining = 16_000;
    let truncated = false;
    for (
      let pageNumber = options.start_page;
      pageNumber <= options.end_page;
      pageNumber += 1
    ) {
      const page = await document.getPage(pageNumber);
      try {
        const normalized = normalizeText(await pageText(page));
        const available = Math.max(Math.min(remaining, options.max_chars_per_page), 0);
        const returned = normalized.slice(0, available);
        const pageTruncated = returned.length < normalized.length;
        truncated ||= pageTruncated;
        pages.push({
          page: pageNumber,
          char_count: normalized.length,
          returned_chars: returned.length,
          truncated: pageTruncated,
          text: returned,
        });
        remaining -= returned.length;
      } finally {
        page.cleanup();
      }
    }
    return {
      pages,
      text_found: pages.some(page => page.text.trim().length > 0),
      total_pages: document.numPages,
      truncated,
    };
  });
}

function matchSnippet(text, matchIndex, matchLength, contextCharacters) {
  const start = Math.max(0, matchIndex - contextCharacters);
  const end = Math.min(text.length, matchIndex + matchLength + contextCharacters);
  let snippet = text.slice(start, end).replace(/\s+/g, " ").trim();
  if (start > 0) snippet = `...${snippet}`;
  if (end < text.length) snippet = `${snippet}...`;
  return snippet;
}

async function searchText(bytes, password, options) {
  return await withPdfjsDocument(bytes, password, async document => {
    const normalizedQuery = options.query.trim();
    const loweredQuery = normalizedQuery.toLowerCase();
    const matches = [];
    for (
      let pageNumber = 1;
      pageNumber <= document.numPages && matches.length < options.max_results;
      pageNumber += 1
    ) {
      const page = await document.getPage(pageNumber);
      try {
        const text = normalizeText(await pageText(page));
        const lowered = text.toLowerCase();
        let fromIndex = 0;
        while (matches.length < options.max_results) {
          const matchIndex = lowered.indexOf(loweredQuery, fromIndex);
          if (matchIndex < 0) break;
          matches.push({
            page: pageNumber,
            char_index: matchIndex,
            match_text: text.slice(matchIndex, matchIndex + normalizedQuery.length),
            snippet: matchSnippet(
              text,
              matchIndex,
              normalizedQuery.length,
              options.context_chars,
            ),
          });
          fromIndex = matchIndex + normalizedQuery.length;
        }
      } finally {
        page.cleanup();
      }
    }
    return {
      match_count: matches.length,
      matches,
      query: normalizedQuery,
      total_pages: document.numPages,
      truncated: matches.length >= options.max_results,
    };
  });
}

async function layoutOperation(bytes, source, password, options, forMarkdown) {
  const pdfjs = await loadPdfjs();
  const extractor = forMarkdown ? extractPdfLayoutForMarkdown : extractPdfLayout;
  return {
    layout: await extractor({
      pdfjsLib: pdfjs,
      pdfBytes: bytes,
      sourcePath: options.source_path,
      sourceFileName: options.source_file_name,
      sourceSha256: source.sha256,
      sourceSizeBytes: source.size_bytes,
      password,
      requestedStartPage: options.start_page,
      requestedEndPage: options.end_page,
      maxItems: options.max_items,
      maxCharacters: options.max_characters,
      maxOutputCharacters: options.max_output_characters,
    }),
  };
}

function fallbackPageGeometry(pdfjsPage) {
  const view = Array.isArray(pdfjsPage?.view) && pdfjsPage.view.length === 4
    ? pdfjsPage.view.map(value => Number(value))
    : [0, 0, 0, 0];
  return {
    geometry_source: "pdfjs-view-fallback",
    media_box: null,
    crop_box: view,
    width_points: Math.abs(view[2] - view[0]),
    height_points: Math.abs(view[3] - view[1]),
    rotation: Number.isFinite(pdfjsPage?.rotate) ? Number(pdfjsPage.rotate) : 0,
    user_unit: Number.isFinite(pdfjsPage?.userUnit) && pdfjsPage.userUnit > 0
      ? Number(pdfjsPage.userUnit)
      : 1,
    coordinate_space: "pdf_user_space_bottom_left_points",
  };
}

function fieldRows(fieldObjects) {
  const rows = [];
  for (const name of Object.keys(fieldObjects ?? {}).sort()) {
    const entries = Array.isArray(fieldObjects[name]) ? fieldObjects[name] : [];
    for (const entry of entries) {
      if (!entry || typeof entry !== "object") continue;
      if ((entry.type ?? "") === "" && (!Number.isInteger(entry.page) || entry.page < 0)) continue;
      rows.push({ ...entry, name: String(entry.name ?? name) });
    }
  }
  return rows;
}

async function observeDocument(bytes, source, password, options) {
  let rawPages = null;
  const coverageReasons = {};
  const addCoverageReason = (channel, reason) => {
    coverageReasons[channel] = [...(coverageReasons[channel] ?? []), reason];
  };
  try {
    const rawDocument = await PDFDocument.load(bytes, {
      ignoreEncryption: true,
      updateMetadata: false,
    });
    rawPages = rawDocument.getPages();
  } catch {
    addCoverageReason("pages", "RAW_PAGE_GEOMETRY_UNAVAILABLE");
  }

  return await withPdfjsDocument(bytes, password, async document => {
    const pagesToObserve = Math.min(document.numPages, options.max_pages);
    const pageItems = [];
    const annotations = [];
    const pageViewports = new Map();
    const widgetsByRetainedFieldId = new Map();
    const retainedUnmatchedWidgets = [];
    let pageFailureCount = 0;
    let annotationFailureCount = 0;
    let annotationEncounteredCount = 0;
    let widgetCount = 0;
    let matchedWidgetCount = 0;
    let unmatchedWidgetCount = 0;

    let rows = [];
    try {
      rows = fieldRows(await document.getFieldObjects());
    } catch {
      addCoverageReason("form_fields", "FORM_FIELD_PARSE_UNAVAILABLE");
    }
    const fieldsBeyondPageLimit = rows.some(
      field => Number.isInteger(field.page) && field.page >= pagesToObserve,
    );
    if (fieldsBeyondPageLimit) {
      addCoverageReason("form_fields", "FORM_FIELD_PAGE_LIMIT_REACHED");
    }
    const eligibleRows = rows.filter(
      field => !Number.isInteger(field.page) || field.page < pagesToObserve,
    );
    const retainedRows = eligibleRows.slice(0, PDF_OBSERVATION_LIMITS.max_fields);
    const knownFieldIds = new Set(rows
      .map(field => typeof field.id === "string" ? field.id : null)
      .filter(Boolean));
    const retainedFieldIds = new Set(retainedRows
      .map(field => typeof field.id === "string" ? field.id : null)
      .filter(Boolean));

    for (let pageNumber = 1; pageNumber <= pagesToObserve; pageNumber += 1) {
      let page = null;
      try {
        page = await document.getPage(pageNumber);
        const geometry = rawPages?.[pageNumber - 1]
          ? pageGeometryFromPdfLib(rawPages[pageNumber - 1])
          : fallbackPageGeometry(page);
        pageItems.push(buildPageObservation(source.sha256, pageNumber, geometry));
        const viewport = page.getViewport({ scale: 1 });
        pageViewports.set(pageNumber - 1, viewport);
        try {
          const pageAnnotations = await page.getAnnotations({ intent: "display" });
          for (const annotation of pageAnnotations) {
            if (annotation?.subtype === "Widget") {
              widgetCount += 1;
              const widget = { ...annotation, page: pageNumber - 1 };
              const recognized = typeof annotation.id === "string"
                && knownFieldIds.has(annotation.id);
              if (recognized) {
                matchedWidgetCount += 1;
                if (
                  retainedFieldIds.has(annotation.id)
                  && !widgetsByRetainedFieldId.has(annotation.id)
                ) {
                  widgetsByRetainedFieldId.set(annotation.id, widget);
                }
              } else {
                unmatchedWidgetCount += 1;
                if (retainedUnmatchedWidgets.length < PDF_OBSERVATION_LIMITS.max_fields) {
                  retainedUnmatchedWidgets.push(widget);
                }
              }
              continue;
            }
            annotationEncounteredCount += 1;
            if (annotations.length < PDF_OBSERVATION_LIMITS.max_annotations) {
              annotations.push(buildAnnotationObservation({
                sourceSha256: source.sha256,
                annotation,
                page: pageNumber,
                viewport,
                ordinal: annotationEncounteredCount,
              }));
            }
          }
        } catch {
          annotationFailureCount += 1;
        }
      } catch {
        pageFailureCount += 1;
        annotationFailureCount += 1;
      } finally {
        try { page?.cleanup(); } catch {}
      }
    }

    if (pageFailureCount > 0) {
      addCoverageReason(
        "pages",
        pageFailureCount === pagesToObserve ? "PAGE_PARSE_UNAVAILABLE" : "PAGE_PARSE_PARTIAL",
      );
    }
    if (document.numPages > pagesToObserve) {
      addCoverageReason("annotations", "ANNOTATION_PAGE_LIMIT_REACHED");
    }

    let info = {};
    let xmp = {};
    try {
      const rawMetadata = await document.getMetadata();
      info = rawMetadata?.info ?? {};
      xmp = rawMetadata?.metadata?.getAll?.() ?? {};
    } catch {
      addCoverageReason("metadata", "METADATA_PARSE_UNAVAILABLE");
    }
    const metadata = buildMetadataObservation(
      source.sha256,
      info,
      xmp,
      PDF_OBSERVATION_LIMITS.max_metadata_characters,
    );

    if (pageFailureCount > 0 && rows.some(
      field => Number.isInteger(field.page) && !pageViewports.has(field.page),
    )) {
      addCoverageReason("form_fields", "FORM_FIELD_PAGE_GEOMETRY_PARTIAL");
    }
    const formFields = [];
    let representedWidgetCount = 0;
    for (const field of retainedRows) {
      const matchedWidget = typeof field.id === "string"
        ? widgetsByRetainedFieldId.get(field.id) ?? null
        : null;
      if (matchedWidget) representedWidgetCount += 1;
      const pageIndex = Number.isInteger(matchedWidget?.page) ? matchedWidget.page : field.page;
      const viewport = Number.isInteger(pageIndex) && pageIndex >= 0
        ? pageViewports.get(pageIndex) ?? null
        : null;
      formFields.push(buildFormFieldObservation({
        sourceSha256: source.sha256,
        field,
        widget: matchedWidget ?? field,
        viewport,
        ordinal: formFields.length + 1,
        recordKind: "field",
      }));
    }
    const remainingFieldCapacity = PDF_OBSERVATION_LIMITS.max_fields - formFields.length;
    for (const widget of retainedUnmatchedWidgets.slice(0, remainingFieldCapacity)) {
      const pageIndex = Number.isInteger(widget.page) ? widget.page : null;
      const viewport = pageIndex === null ? null : pageViewports.get(pageIndex) ?? null;
      formFields.push(buildFormFieldObservation({
        sourceSha256: source.sha256,
        field: widget,
        widget,
        viewport,
        ordinal: formFields.length + 1,
        recordKind: "unmatched_widget",
      }));
      representedWidgetCount += 1;
    }
    const totalFormFields = eligibleRows.length + unmatchedWidgetCount;
    const fieldLimitReached = totalFormFields > PDF_OBSERVATION_LIMITS.max_fields;
    const omittedWidgetCount = Math.max(0, widgetCount - representedWidgetCount);
    const fieldsTruncated = formFields.length < totalFormFields
      || fieldsBeyondPageLimit
      || omittedWidgetCount > 0;

    if (annotationFailureCount > 0) {
      addCoverageReason(
        "annotations",
        annotationFailureCount === pagesToObserve
          ? "ANNOTATION_PARSE_UNAVAILABLE"
          : "ANNOTATION_PAGE_PARSE_PARTIAL",
      );
    }
    return buildDocumentObservation({
      source: {
        ...source,
        file_name: path.basename(source.canonical_path),
      },
      totalPages: document.numPages,
      pageItems,
      pageTruncated: pageItems.length < document.numPages,
      pageLimitReached: document.numPages > pagesToObserve,
      metadata,
      formFields,
      fieldObjectCount: eligibleRows.length,
      totalFormFields,
      fieldsTruncated,
      fieldsLimitReached: fieldLimitReached,
      widgetCount,
      matchedWidgetCount,
      unmatchedWidgetCount,
      omittedWidgetCount,
      annotations,
      annotationEncounteredCount,
      annotationsTruncated: annotations.length < annotationEncounteredCount
        || document.numPages > pagesToObserve,
      annotationsLimitReached:
        annotationEncounteredCount > PDF_OBSERVATION_LIMITS.max_annotations,
      coverageReasons,
      maxPages: options.max_pages,
      maxOutputCharacters: options.max_output_characters,
    });
  });
}

function pngResult(buffer, result) {
  if (!Buffer.isBuffer(buffer) || buffer.length < 24 || buffer.length > MAX_BINARY_BYTES) {
    throw resourceLimitError("png_output_limit");
  }
  return { binary: buffer, result };
}

function pngDimensions(buffer) {
  if (
    !Buffer.isBuffer(buffer)
    || buffer.length < 24
    || buffer[0] !== 0x89
    || buffer.subarray(1, 4).toString("ascii") !== "PNG"
  ) {
    throw new Error("The system PDF renderer returned invalid PNG bytes.");
  }
  return {
    width: buffer.readUInt32BE(16),
    height: buffer.readUInt32BE(20),
  };
}

function errorChain(error, maximumDepth = 6) {
  const messages = [];
  let current = error;
  for (let depth = 0; current && depth < maximumDepth; depth += 1) {
    messages.push(`${current.name || "Error"}: ${current.message || String(current)}`);
    current = current.cause;
  }
  return messages.join(" <- ");
}

function canvasDependencyError(error) {
  const message = errorChain(error);
  return message.includes("Canvas dependency")
    || message.includes("Cannot find native binding")
    || message.includes("ERR_DLOPEN_FAILED")
    || message.includes("different Team IDs");
}

function waitForChildClose(child) {
  return new Promise(resolve => child.once("close", resolve));
}

function killSystemChild(child) {
  try {
    return child.kill("SIGKILL");
  } catch {
    return false;
  }
}

function isPdfjsThreadRuntime() {
  return !isMainThread
    && workerData?.pdf_tools_worker === "pdfjs"
    && parentPort !== null;
}

function installThreadSystemCommandHandler() {
  parentPort.on("message", message => {
    if (
      !message
      || message.kind !== "system_command_result"
      || !Number.isSafeInteger(message.id)
    ) {
      return;
    }
    const waiter = threadSystemCommandWaiters.get(message.id);
    if (!waiter) return;
    threadSystemCommandWaiters.delete(message.id);
    if (message.status === "ok") {
      waiter.resolve();
      return;
    }
    const error = new Error(
      typeof message.error?.message === "string"
        ? message.error.message
        : "The macOS system PDF renderer could not complete this operation.",
    );
    if (typeof message.error?.code === "string") error.code = message.error.code;
    error.name = typeof message.error?.name === "string"
      ? message.error.name
      : "Error";
    waiter.reject(error);
  });
}

async function runThreadSystemCommand(command, args, timeoutMs) {
  const id = nextThreadSystemCommandId;
  nextThreadSystemCommandId += 1;
  if (!Number.isSafeInteger(id) || id > 2 ** 31 - 1) {
    throw resourceLimitError("system_renderer_request_limit");
  }
  return await new Promise((resolve, reject) => {
    threadSystemCommandWaiters.set(id, { reject, resolve });
    try {
      parentPort.postMessage({
        kind: "system_command",
        id,
        command,
        args,
        timeout_ms: timeoutMs,
      });
    } catch (error) {
      threadSystemCommandWaiters.delete(id);
      reject(error);
    }
  });
}

async function terminateActiveSystemChildren() {
  const children = [...activeSystemChildren];
  await Promise.all(children.map(async child => {
    const closed = waitForChildClose(child);
    killSystemChild(child);
    await closed;
  }));
}

function systemRendererShutdownError() {
  return resourceLimitError(
    systemRenderShutdownTerminal
      ? "system_renderer_shutdown_terminal"
      : "system_renderer_shutdown",
  );
}

function controllerShutdownInProgress() {
  if (systemRendererControllerShutdownProbe === null) return false;
  try {
    const result = systemRendererControllerShutdownProbe();
    return typeof result === "boolean" ? result : true;
  } catch {
    return true;
  }
}

function assertSystemRendererControllerRunning() {
  if (controllerShutdownInProgress()) {
    throw resourceLimitError("system_renderer_controller_shutdown");
  }
}

function assertSystemRendererRunning() {
  if (systemRenderShutdownStarted) throw systemRendererShutdownError();
  assertSystemRendererControllerRunning();
}

function registerSystemRenderWorkspace() {
  let settle;
  const lifecycle = {
    completion: new Promise(resolve => {
      settle = resolve;
    }),
  };
  activeSystemRenderWorkspaces.add(lifecycle);
  return cleanupError => {
    activeSystemRenderWorkspaces.delete(lifecycle);
    settle(cleanupError);
  };
}

async function awaitSystemRenderWorkspaceCleanup() {
  const cleanupErrors = [];
  while (activeSystemRenderWorkspaces.size > 0) {
    const completed = await Promise.all(
      [...activeSystemRenderWorkspaces].map(lifecycle => lifecycle.completion),
    );
    cleanupErrors.push(...completed.filter(error => error !== null));
  }
  if (cleanupErrors.length > 0) throw cleanupErrors[0];
}

export async function withPrivateSystemRenderWorkspace(operation) {
  if (typeof operation !== "function") {
    throw new TypeError("system render workspace operation must be a function.");
  }
  assertSystemRendererRunning();
  const completeLifecycle = registerSystemRenderWorkspace();
  let renderDirectory = null;
  let renderError = null;
  let renderResult = null;
  try {
    renderDirectory = await mkdtemp(path.join(tmpdir(), "pdf-tools-system-render-"));
    await chmod(renderDirectory, 0o700);
    assertSystemRendererRunning();
    renderResult = await operation({
      assertSystemRendererRunning,
      renderDirectory,
    });
  } catch (error) {
    renderError = error?.code === PDF_RESOURCE_LIMIT_CODE
      ? error
      : new Error("The macOS system PDF renderer could not render this page.");
  }
  let cleanupError = null;
  if (renderDirectory !== null) {
    try {
      await rm(renderDirectory, {
        force: true,
        maxRetries: 3,
        recursive: true,
        retryDelay: 25,
      });
    } catch {
      cleanupError = resourceLimitError("system_renderer_cleanup_unproven");
    }
  }
  completeLifecycle(cleanupError);
  if (cleanupError !== null) throw cleanupError;
  if (renderError !== null) throw renderError;
  return renderResult;
}

export function poisonPdfjsWorkerSystemRenderer() {
  systemRenderShutdownTerminal = true;
  systemRenderShutdownStarted = true;
}

export function bindPdfjsWorkerSystemRendererControllerProbe(probe) {
  if (typeof probe !== "function") {
    throw new TypeError("system renderer controller probe must be a function.");
  }
  if (systemRendererControllerShutdownProbe !== null) {
    throw new TypeError("system renderer controller probe is already bound.");
  }
  systemRendererControllerShutdownProbe = probe;
}

export function bindPdfjsWorkerNativeCanvasBlockReasonProbe(probe) {
  if (typeof probe !== "function") {
    throw new TypeError("native canvas block reason probe must be a function.");
  }
  if (nativeCanvasBlockReasonProbe !== null) {
    throw new TypeError("native canvas block reason probe is already bound.");
  }
  nativeCanvasBlockReasonProbe = probe;
}

// Turn a refusal reason into something the user can act on.
//
// The generic unavailable-renderer message below is true but inert: it tells
// someone their renderer is missing and that reinstalling will not help, and
// then leaves them there. When the cause is the crash latch, there is a specific
// thing to do, and this is the only place it can be said - the guard's own error
// never survives @napi-rs/canvas.
function nativeCanvasBlockRemediation() {
  let reason = null;
  try {
    reason = nativeCanvasBlockReasonProbe?.() ?? null;
  } catch {
    // A probe that throws must not turn a renderer error into a probe error.
    return "";
  }
  if (reason === "latched") {
    return " Native page rendering was disabled automatically because a previous"
      + " attempt to load it never returned, which usually means it crashed this"
      + " host. Set PDF_TOOLS_EMBEDDED_NATIVE_CANVAS=force to try it again.";
  }
  if (reason === "concurrent") {
    return " Another PDF Tools server on this machine is loading the same binding"
      + " right now. Retry in a moment.";
  }
  if (reason === "marker_unwritable") {
    return " Native page rendering was refused because its crash-recovery marker"
      + " could not be written, so a crash could not have been detected. Check"
      + " that the profiles directory is writable.";
  }
  return "";
}

export async function beginPdfjsWorkerSystemShutdown({ terminal = false } = {}) {
  if (typeof terminal !== "boolean") {
    throw new TypeError("terminal must be a boolean.");
  }
  if (terminal) poisonPdfjsWorkerSystemRenderer();
  systemRenderShutdownStarted = true;
  await terminateActiveSystemChildren();
  await awaitSystemRenderWorkspaceCleanup();
}

export function reopenPdfjsWorkerSystemRenderer() {
  if (systemRenderShutdownTerminal) {
    throw resourceLimitError("system_renderer_shutdown_terminal");
  }
  assertSystemRendererControllerRunning();
  if (activeSystemChildren.size > 0 || activeSystemRenderWorkspaces.size > 0) {
    throw resourceLimitError("system_renderer_shutdown_incomplete");
  }
  systemRenderShutdownStarted = false;
}

export function snapshotPdfjsWorkerSystemRendererState() {
  return {
    admission_closed: systemRenderShutdownStarted,
    active_children: activeSystemChildren.size,
    active_workspaces: activeSystemRenderWorkspaces.size,
    controller_shutdown: controllerShutdownInProgress(),
    spawn_count: systemCommandSpawnCount,
    terminal: systemRenderShutdownTerminal,
  };
}

export function forceTerminateAllPdfjsWorkerSystemChildren() {
  poisonPdfjsWorkerSystemRenderer();
  for (const child of activeSystemChildren) killSystemChild(child);
}

// A terminal signal decides this process's exit code, but the shutdown it starts
// also kills every in-flight system renderer child on purpose, and each kill
// rejects the render its caller was awaiting. Nothing is left to catch those
// rejections - the caller is exactly what the shutdown is dismantling - so Node
// applies its default policy and makes them fatal. On Node 20 that fatal path
// runs before the deliberate process.exit() below, so an orderly shutdown exits
// 1 and prints a stack trace: a supervisor reads a requested termination as a
// crash, and the log reads like one too. On Node 22 the deliberate exit wins.
// Neither ordering is promised on either runtime, so the signal-to-exit-code
// contract was only ever holding by luck.
//
// Node delivers these as uncaughtException with origin "unhandledRejection" -
// including the entry module's own rejected top-level await, which never reaches
// an "unhandledRejection" listener at all - so this is the one place the fault
// can be seen. Swallow exactly the faults this shutdown manufactured, named by
// the typed shutdown limit runSystemCommand raises for a child we killed
// ourselves. Re-raise anything else on the default path and stand the deliberate
// exit down, so a cleanup that could not be proven, or a bug, still crashes with
// exit code 1 and Node's own report rather than being buried under a tidy 143.
function installTerminalShutdownFaultGuard() {
  const guard = (error, origin) => {
    if (
      origin === "unhandledRejection"
      && error?.code === PDF_RESOURCE_LIMIT_CODE
      && SYSTEM_RENDERER_SHUTDOWN_REASONS.has(error?.reason)
    ) {
      return;
    }
    process.removeListener("uncaughtException", guard);
    systemChildTerminationFault = true;
    process.nextTick(() => {
      throw error;
    });
  };
  process.on("uncaughtException", guard);
}

export function installSystemChildTerminationHandlers() {
  if (systemChildTerminationHandlersInstalled) return;
  systemChildTerminationHandlersInstalled = true;
  const exitCodes = new Map([
    ["SIGHUP", 129],
    ["SIGINT", 130],
    ["SIGTERM", 143],
  ]);
  for (const [signal, exitCode] of exitCodes) {
    process.once(signal, () => {
      if (systemChildTermination !== null) return;
      // The exit code is decided the moment the signal is accepted. Record it
      // before any teardown runs, so a shutdown that drains the event loop
      // without reaching the explicit exit below still reports the signal.
      process.exitCode = exitCode;
      installTerminalShutdownFaultGuard();
      systemChildTermination = beginPdfjsWorkerSystemShutdown({ terminal: true });
      void systemChildTermination.finally(() => {
        if (systemChildTerminationFault) return;
        process.exit(exitCode);
      });
    });
  }
}

export async function runSystemCommand(command, args, {
  spawnProcess = spawn,
  timeoutMs = SYSTEM_COMMAND_TIMEOUT_MS,
  workingDirectory = process.cwd(),
} = {}) {
  boundedString(command, "system command", 32_768);
  boundedInteger(timeoutMs, "system command timeout", 100, 30_000);
  boundedString(workingDirectory, "system command working directory", 32_768);
  if (!path.isAbsolute(workingDirectory)) {
    throw new TypeError("system command working directory must be absolute.");
  }
  if (
    !Array.isArray(args)
    || args.length > 128
    || args.some(argument => typeof argument !== "string" || argument.length > 32_768)
  ) {
    throw new TypeError("system command arguments are invalid.");
  }
  if (isPdfjsThreadRuntime()) {
    return await runThreadSystemCommand(command, args, timeoutMs);
  }
  await new Promise((resolve, reject) => {
    systemCommandSpawnCount += 1;
    const child = spawnProcess(command, args, {
      cwd: workingDirectory,
      env: {
        PATH: process.env.PATH ?? "",
        HOME: process.env.HOME ?? "",
        LANG: process.env.LANG ?? "",
        TMPDIR: workingDirectory,
      },
      shell: false,
      stdio: ["ignore", "pipe", "pipe"],
    });
    activeSystemChildren.add(child);
    let stdoutBytes = 0;
    let stderrBytes = 0;
    let outputOverflow = false;
    let timedOut = false;
    let settled = false;
    let deadline = null;
    let childError = null;
    const finish = error => {
      if (settled) return;
      settled = true;
      clearTimeout(deadline);
      activeSystemChildren.delete(child);
      if (error) reject(error);
      else resolve();
    };
    child.stdout.on("data", chunk => {
      stdoutBytes += chunk.length;
      if (stdoutBytes > 64 * 1024) {
        outputOverflow = true;
        killSystemChild(child);
      }
    });
    child.stderr.on("data", chunk => {
      stderrBytes += chunk.length;
      if (stderrBytes > 64 * 1024) {
        outputOverflow = true;
        killSystemChild(child);
      }
    });
    child.once("error", error => {
      childError = error;
      if (!child.pid) finish(error);
      else killSystemChild(child);
    });
    child.once("close", (code, signal) => {
      if (childError) {
        finish(childError);
      } else if (timedOut) {
        finish(resourceLimitError("system_renderer_timeout"));
      } else if (outputOverflow) {
        finish(resourceLimitError("system_renderer_output_limit"));
      } else if (code !== 0 || signal !== null) {
        // A child that died after renderer shutdown began died because we killed
        // it, so it did not fail in any sense the caller should hear. Blaming the
        // renderer there invents a fault during an orderly teardown and buries
        // the one fact the caller can act on. Report the same typed shutdown
        // limit the admission gate raises for a call arriving one moment later.
        // A child that failed on its own still rejects exactly as before.
        finish(systemRenderShutdownStarted
          ? systemRendererShutdownError()
          : new Error("The macOS system PDF renderer could not render this page."));
      } else {
        finish(null);
      }
    });
    deadline = setTimeout(() => {
      timedOut = true;
      killSystemChild(child);
    }, timeoutMs);
    deadline.unref();
  });
}

// Rendering and page analysis decrypt their text through PDF.js but still take
// page geometry from pdf-lib, which cannot decrypt anything. Left raw, pdf-lib's
// own error tells the caller to retry with { ignoreEncryption: true }, which
// produces an unusable document — advice that cannot work. Report the real
// limit instead.
async function loadPdfLibGeometry(bytes, password) {
  try {
    return await PDFDocument.load(bytes, password ? { password } : {});
  } catch (error) {
    if (isPdfLibEncryptedError(error)) throw new Error(PDF_LIB_ENCRYPTED_MESSAGE);
    throw error;
  }
}

async function writeSinglePagePdf(bytes, pageNumber, password, targetPath, cropBox = null) {
  const source = await loadPdfLibGeometry(bytes, password);
  const target = await PDFDocument.create();
  const [page] = await target.copyPages(source, [pageNumber - 1]);
  if (cropBox !== null) {
    const [left, bottom, right, top] = cropBox;
    page.setCropBox(left, bottom, right - left, top - bottom);
  }
  target.addPage(page);
  await writeFile(targetPath, await target.save());
}

async function inspectPdfjsPageView(bytes, password, pageNumber, viewRegion = null) {
  return await withPdfjsDocument(bytes, password, async document => {
    if (pageNumber > document.numPages) {
      throw new Error(`Page ${pageNumber} is out of range (1-${document.numPages}).`);
    }
    const page = await document.getPage(pageNumber);
    try {
      const pageView = pageViewFromPdfjs(page);
      let pdfCropBox = null;
      if (viewRegion !== null) {
        validatePdfRegionBox({
          pageWidth: pageView.width_points,
          pageHeight: pageView.height_points,
          ...viewRegion,
        });
        const viewport = page.getViewport({ scale: 1 });
        const corners = [
          viewport.convertToPdfPoint(viewRegion.x, viewRegion.y),
          viewport.convertToPdfPoint(
            viewRegion.x + viewRegion.width,
            viewRegion.y + viewRegion.height,
          ),
        ];
        const xValues = corners.map(point => point[0]);
        const yValues = corners.map(point => point[1]);
        pdfCropBox = [
          Math.min(...xValues),
          Math.min(...yValues),
          Math.max(...xValues),
          Math.max(...yValues),
        ];
      }
      return { pageView, pdfCropBox, totalPages: document.numPages };
    } finally {
      page.cleanup();
    }
  });
}

async function systemRenderPage(bytes, password, options) {
  if (process.platform !== "darwin") {
    throw new Error("The macOS system PDF renderer is unavailable on this platform.");
  }
  const geometryDocument = await loadPdfLibGeometry(bytes, password);
  if (options.page > geometryDocument.getPageCount()) {
    throw new Error(
      `Page ${options.page} is out of range (1-${geometryDocument.getPageCount()}).`,
    );
  }
  const geometryPage = geometryDocument.getPages()[options.page - 1];
  const geometry = geometryPage.getSize();
  const pageGeometry = pageGeometryFromPdfLib(geometryPage);
  const requestedRegion = options.view_region ?? null;
  const { pageView, pdfCropBox, totalPages } = await inspectPdfjsPageView(
    bytes,
    password,
    options.page,
    requestedRegion,
  );
  const renderedView = requestedRegion ?? {
    x: 0,
    y: 0,
    width: pageView.width_points,
    height: pageView.height_points,
  };
  const scale = options.scale_override ?? getPageRenderScale({
    width: renderedView.width,
    height: renderedView.height,
    maxDimensionPx: options.max_dimension_px,
  });
  validateCanvasDimensions(renderedView.width * scale, renderedView.height * scale);
  return await withPrivateSystemRenderWorkspace(async ({
    assertSystemRendererRunning,
    renderDirectory,
  }) => {
    const sourcePath = path.join(renderDirectory, "source.pdf");
    const outputPath = path.join(renderDirectory, "source.pdf.png");
    await writeSinglePagePdf(bytes, options.page, password, sourcePath, pdfCropBox);
    assertSystemRendererRunning();
    const maximumDimension = Math.max(
      1,
      Math.round(Math.max(renderedView.width, renderedView.height) * scale),
    );
    await runSystemCommand("/usr/bin/qlmanage", [
      "-t", "-s", String(maximumDimension), "-o", renderDirectory, sourcePath,
    ], { workingDirectory: renderDirectory });
    const buffer = await readFile(outputPath);
    const pixels = pngDimensions(buffer);
    validateCanvasDimensions(pixels.width, pixels.height);
    return pngResult(buffer, {
      height: pixels.height,
      height_points: geometry.height,
      renderer: "macos-quicklook",
      page_geometry: pageGeometry,
      page_view: pageView,
      requested_region: renderedView,
      rendered_region: { x: 0, y: 0, width: pixels.width, height: pixels.height },
      raw_pixel_sha256: null,
      raw_pixel_status: "unavailable",
      scale,
      total_pages: totalPages,
      width: pixels.width,
      width_points: geometry.width,
    });
  });
}

async function nativeRenderPage(bytes, password, options) {
  const geometryDocument = await loadPdfLibGeometry(bytes, password);
  if (options.page > geometryDocument.getPageCount()) {
    throw new Error(
      `Page ${options.page} is out of range (1-${geometryDocument.getPageCount()}).`,
    );
  }
  const geometryPage = geometryDocument.getPages()[options.page - 1];
  const geometry = geometryPage.getSize();
  const pageGeometry = pageGeometryFromPdfLib(geometryPage);
  return await withPdfjsDocument(bytes, password, async document => {
    if (options.page > document.numPages) {
      throw new Error(`Page ${options.page} is out of range (1-${document.numPages}).`);
    }
    const page = await document.getPage(options.page);
    try {
      const pageView = pageViewFromPdfjs(page);
      const scale = options.scale_override ?? getPageRenderScale({
        width: pageView.width_points,
        height: pageView.height_points,
        maxDimensionPx: options.max_dimension_px,
      });
      const viewport = page.getViewport({ scale });
      const pixels = validateCanvasDimensions(viewport.width, viewport.height);
      const canvas = createCanvas(pixels.width, pixels.height);
      const context = canvas.getContext("2d");
      context.fillStyle = "white";
      context.fillRect(0, 0, pixels.width, pixels.height);
      await page.render({ canvasContext: context, viewport }).promise;
      const rawPixels = Buffer.from(
        context.getImageData(0, 0, pixels.width, pixels.height).data,
      );
      const buffer = canvas.toBuffer("image/png");
      return pngResult(buffer, {
        comparison_view: {
          raw_width_pixels: viewport.width,
          raw_height_pixels: viewport.height,
        },
        height: pixels.height,
        height_points: geometry.height,
        page_geometry: pageGeometry,
        page_view: pageView,
        requested_region: {
          x: 0,
          y: 0,
          width: pageView.width_points,
          height: pageView.height_points,
        },
        rendered_region: { x: 0, y: 0, width: pixels.width, height: pixels.height },
        raw_pixel_sha256: createHash("sha256").update(rawPixels).digest("hex"),
        raw_pixel_status: "available",
        renderer: "native-canvas",
        scale,
        total_pages: document.numPages,
        width: pixels.width,
        width_points: geometry.width,
      });
    } finally {
      page.cleanup();
    }
  }, { render: true });
}

export async function runRendererPolicy(policy, {
  nativeRenderer,
  systemRenderer,
}) {
  rendererPolicy(policy);
  if (typeof nativeRenderer !== "function" || typeof systemRenderer !== "function") {
    throw new TypeError("renderer implementations must be functions.");
  }
  if (policy === "forced_unavailable") {
    throw new Error("The requested system PDF renderer is unavailable.");
  }
  if (policy === "system") {
    return await systemRenderer();
  }
  try {
    return await nativeRenderer();
  } catch (error) {
    if (
      policy === "native_with_system_fallback"
      && error?.code !== PDF_RESOURCE_LIMIT_CODE
      && canvasDependencyError(error)
    ) {
      return await systemRenderer();
    }
    // Embedded hosts deliberately block the native canvas binding, and the
    // canvas library reports that as its own "cannot find native binding"
    // message, which tells the caller to reinstall packages. That remediation
    // is wrong and cannot succeed. Replace it with the true cause when no
    // system fallback is available for this host.
    if (error?.code !== PDF_RESOURCE_LIMIT_CODE && canvasDependencyError(error)) {
      const unavailable = new Error(
        "No PDF page renderer is available in this host. The native canvas "
        + "binding is unavailable or blocked, and no system renderer fallback "
        + "is configured. Reinstalling dependencies does not resolve this."
        // Appends nothing unless the embedded-host guard refused for a reason
        // the user can act on, so the message every existing caller and the
        // Windows CI probe assert against is byte-identical when it does not.
        + nativeCanvasBlockRemediation(),
      );
      unavailable.code = "PDF_RENDERER_UNAVAILABLE";
      unavailable.cause = error;
      throw unavailable;
    }
    throw error;
  }
}

async function renderPage(bytes, password, options) {
  return await runRendererPolicy(options.renderer_policy, {
    nativeRenderer: async () => await nativeRenderPage(bytes, password, options),
    systemRenderer: async () => await systemRenderPage(bytes, password, options),
  });
}

async function renderComparisonPage(bytes, password, options) {
  const rendered = await renderPage(bytes, password, options);
  const imported = _require("@pdf-lib/upng");
  const upng = imported?.default?.default ?? imported?.default ?? imported;
  const decoded = upng.decode(rendered.binary.buffer.slice(
    rendered.binary.byteOffset,
    rendered.binary.byteOffset + rendered.binary.byteLength,
  ));
  const frames = upng.toRGBA8(decoded);
  if (!Array.isArray(frames) || frames.length !== 1) {
    throw new Error("The comparison renderer requires a single-frame PNG.");
  }
  const rgba = Buffer.from(frames[0]);
  const expectedBytes = rendered.result.width * rendered.result.height * 4;
  if (rgba.length !== expectedBytes || rgba.length > MAX_BINARY_BYTES) {
    throw resourceLimitError("comparison_rgba_output_limit");
  }
  const rgbaSha256 = createHash("sha256").update(rgba).digest("hex");
  if (
    rendered.result.raw_pixel_status === "available"
    && rendered.result.raw_pixel_sha256 !== rgbaSha256
  ) {
    throw new Error("The comparison PNG does not reproduce the rendered raw pixels.");
  }
  return {
    binary: rgba,
    result: {
      ...rendered.result,
      raw_pixel_sha256: rgbaSha256,
      raw_pixel_status: "available",
    },
  };
}

async function nativeRenderRegion(bytes, password, options) {
  const geometryDocument = await loadPdfLibGeometry(bytes, password);
  if (options.page > geometryDocument.getPageCount()) {
    throw new Error(
      `Page ${options.page} is out of range (1-${geometryDocument.getPageCount()}).`,
    );
  }
  const geometryPage = geometryDocument.getPages()[options.page - 1];
  const pageGeometry = pageGeometryFromPdfLib(geometryPage);
  const scale = getPageRenderScale({
    width: options.width,
    height: options.height,
    maxDimensionPx: options.max_dimension_px,
    minScale: 0.1,
    maxScale: 4,
  });
  return await withPdfjsDocument(bytes, password, async document => {
    if (options.page > document.numPages) {
      throw new Error(`Page ${options.page} is out of range (1-${document.numPages}).`);
    }
    const page = await document.getPage(options.page);
    try {
      const pageView = pageViewFromPdfjs(page);
      validatePdfRegionBox({
        pageWidth: pageView.width_points,
        pageHeight: pageView.height_points,
        x: options.x,
        y: options.y,
        width: options.width,
        height: options.height,
      });
      const viewport = page.getViewport({ scale });
      const crop = {
        height: Math.max(1, Math.round(options.height * scale)),
        left: Math.round(options.x * scale),
        top: Math.round(options.y * scale),
        width: Math.max(1, Math.round(options.width * scale)),
      };
      if (
        !Number.isFinite(viewport.width)
        || !Number.isFinite(viewport.height)
        || viewport.width <= 0
        || viewport.height <= 0
        || viewport.width > 10_000_000
        || viewport.height > 10_000_000
      ) {
        throw resourceLimitError("invalid_page_viewport");
      }
      const fullWidth = Math.ceil(viewport.width);
      const fullHeight = Math.ceil(viewport.height);
      const cropPixels = validateCanvasDimensions(crop.width, crop.height);
      if (
        crop.left < 0
        || crop.top < 0
        || crop.left + cropPixels.width > fullWidth
        || crop.top + cropPixels.height > fullHeight
      ) {
        throw new Error("The requested render region falls outside the page.");
      }
      const canvas = createCanvas(cropPixels.width, cropPixels.height);
      const context = canvas.getContext("2d");
      context.fillStyle = "white";
      context.fillRect(0, 0, cropPixels.width, cropPixels.height);
      await page.render({
        canvasContext: context,
        transform: [1, 0, 0, 1, -crop.left, -crop.top],
        viewport,
      }).promise;
      const rawPixels = Buffer.from(
        context.getImageData(0, 0, cropPixels.width, cropPixels.height).data,
      );
      const buffer = canvas.toBuffer("image/png");
      return pngResult(buffer, {
        height: cropPixels.height,
        page_geometry: pageGeometry,
        page_view: pageView,
        requested_region: {
          x: options.x,
          y: options.y,
          width: options.width,
          height: options.height,
        },
        rendered_region: {
          x: crop.left,
          y: crop.top,
          width: cropPixels.width,
          height: cropPixels.height,
        },
        raw_pixel_sha256: createHash("sha256").update(rawPixels).digest("hex"),
        raw_pixel_status: "available",
        renderer: "native-canvas",
        scale,
        total_pages: document.numPages,
        width: cropPixels.width,
      });
    } finally {
      page.cleanup();
    }
  }, { render: true });
}

async function systemRenderRegion(bytes, password, options) {
  const page = await systemRenderPage(bytes, password, {
    page: options.page,
    max_dimension_px: null,
    renderer_policy: "system",
    scale_override: getPageRenderScale({
      width: options.width,
      height: options.height,
      maxDimensionPx: options.max_dimension_px,
      minScale: 0.1,
      maxScale: 4,
    }),
    view_region: {
      x: options.x,
      y: options.y,
      width: options.width,
      height: options.height,
    },
  });
  return pngResult(page.binary, {
    height: page.result.height,
    page_geometry: page.result.page_geometry,
    page_view: page.result.page_view,
    requested_region: page.result.requested_region,
    rendered_region: page.result.rendered_region,
    raw_pixel_sha256: null,
    raw_pixel_status: "unavailable",
    renderer: "macos-quicklook",
    scale: page.result.scale,
    total_pages: page.result.total_pages,
    width: page.result.width,
  });
}

async function renderRegion(bytes, password, options) {
  return await runRendererPolicy(options.renderer_policy, {
    nativeRenderer: async () => await nativeRenderRegion(bytes, password, options),
    systemRenderer: async () => await systemRenderRegion(bytes, password, options),
  });
}

async function analyzePages(bytes, password, options) {
  const pdfjs = await loadPdfjs();
  const pdfDocument = await loadPdfLibGeometry(bytes, password);
  return {
    analysis: await analyzePdfPages({
      pdfLibPages: pdfDocument.getPages(),
      pdfBytes: bytes,
      pdfjsLib: pdfjs,
      password,
      maxPages: options.max_pages,
    }),
  };
}

async function signatureZones(bytes, password) {
  const pdfjs = await loadPdfjs();
  let pdfDocument;
  let scanAcroForm = true;
  const warningCounts = new Map();
  const recordWarning = warning => {
    const code = warning?.code;
    if (typeof code !== "string") return;
    warningCounts.set(code, Math.min((warningCounts.get(code) || 0) + 1, 1_000_000));
  };
  try {
    pdfDocument = await PDFDocument.load(bytes, { updateMetadata: false });
  } catch (error) {
    if (!isPdfLibEncryptedError(error)) throw error;
    pdfDocument = await PDFDocument.load(bytes, {
      ignoreEncryption: true,
      updateMetadata: false,
    });
    scanAcroForm = false;
    recordWarning({ code: "ENCRYPTED_ACROFORM_SCAN_UNAVAILABLE" });
  }
  const buildResult = async () => {
    const zones = await detectSignatureZones({
      pdfDoc: pdfDocument,
      pdfBytes: bytes,
      pdfjsLib: pdfjs,
      password,
      onWarning: recordWarning,
      scanAcroForm,
    });
    return {
      page_geometry: pdfDocument.getPages().map((page, index) => {
        const box = getPageBoxGeometry(page);
        return {
          height: box.height,
          origin_x: box.originX,
          origin_y: box.originY,
          page: index + 1,
          width: box.width,
        };
      }),
      warning_counts: [...warningCounts.entries()].map(([code, occurrences]) => ({
        code,
        occurrences,
      })),
      zones,
    };
  };
  if (scanAcroForm) return await buildResult();
  // On the ignoreEncryption fallback pdf-lib may hand back a document whose
  // page tree cannot be read at all — AES-256 fails with "Expected instance of
  // PDFDict". Report the real limit rather than that internal detail.
  try {
    return await buildResult();
  } catch (error) {
    // A genuine PDF.js password failure still has to reach the caller as
    // itself: a missing or wrong password is the one case where asking for the
    // password is the correct advice.
    if (error?.name === "PasswordException" || typeof error?.code === "string") throw error;
    throw new Error(PDF_LIB_ENCRYPTED_MESSAGE);
  }
}

async function performOperation(request, sourceBytes) {
  switch (request.operation) {
    case "read_content":
      return { binary: null, result: await readContent(
        sourceBytes,
        request.password,
        request.options,
      ) };
    case "read_pages":
      return { binary: null, result: await readPages(
        sourceBytes,
        request.password,
        request.options,
      ) };
    case "search_text":
      return { binary: null, result: await searchText(
        sourceBytes,
        request.password,
        request.options,
      ) };
    case "extract_layout":
      return { binary: null, result: await layoutOperation(
        sourceBytes,
        request.source,
        request.password,
        request.options,
        false,
      ) };
    case "extract_layout_for_markdown":
      return { binary: null, result: await layoutOperation(
        sourceBytes,
        request.source,
        request.password,
        request.options,
        true,
      ) };
    case "observe_document":
      return { binary: null, result: await observeDocument(
        sourceBytes,
        request.source,
        request.password,
        request.options,
      ) };
    case "render_page":
      return await renderPage(sourceBytes, request.password, request.options);
    case "render_comparison_page":
      return await renderComparisonPage(sourceBytes, request.password, request.options);
    case "render_region":
      return await renderRegion(sourceBytes, request.password, request.options);
    case "analyze_pages":
      return { binary: null, result: await analyzePages(
        sourceBytes,
        request.password,
        request.options,
      ) };
    case "detect_signature_zones":
      return { binary: null, result: await signatureZones(
        sourceBytes,
        request.password,
      ) };
  }
  throw new TypeError(`Unsupported PDF.js operation: ${request.operation}.`);
}

function passwordError(error, pdfjs) {
  if (error?.name !== "PasswordException" || !pdfjs?.PasswordResponses) return null;
  if (error.code === pdfjs.PasswordResponses.NEED_PASSWORD) {
    const mapped = new Error(
      "This PDF requires a password. Provide it with the password parameter and try again.",
    );
    mapped.code = "PASSWORD_REQUIRED";
    return mapped;
  }
  if (error.code === pdfjs.PasswordResponses.INCORRECT_PASSWORD) {
    const mapped = new Error(
      "The PDF password was not accepted. Check the password and try again.",
    );
    mapped.code = "PASSWORD_INCORRECT";
    return mapped;
  }
  return null;
}

async function writeStream(stream, bytes) {
  await new Promise((resolve, reject) => {
    stream.write(bytes, error => error ? reject(error) : resolve());
  });
}

function writeBinary(bytes) {
  let offset = 0;
  while (offset < bytes.length) {
    offset += writeSync(3, bytes, offset, bytes.length - offset);
  }
  closeSync(3);
}

async function writeSuccess(operation, operationResult) {
  const binary = operationResult.binary;
  const descriptor = binary === null
    ? null
    : {
        bytes: binary.length,
        mime_type: operation === "render_comparison_page"
          ? "application/x-pdf-tools-rgba"
          : "image/png",
        sha256: createHash("sha256").update(binary).digest("hex"),
      };
  const encoded = Buffer.from(JSON.stringify({
    status: "ok",
    protocol_version: PROTOCOL_VERSION,
    operation,
    result: operationResult.result,
    binary: descriptor,
  }), "utf8");
  if (encoded.length > MAX_RESPONSE_BYTES) {
    throw resourceLimitError("worker_response_limit");
  }
  await writeStream(process.stdout, encoded);
  if (binary !== null) writeBinary(binary);
}

async function writeError(operation, inputError) {
  const mappedPasswordError = passwordError(inputError, pdfjsLib);
  const error = mappedPasswordError || inputError;
  const code = typeof error?.code === "string" && error.code.length <= 256
    ? error.code
    : null;
  const message = typeof error?.message === "string" && error.message.length <= 4096
    ? error.message
    : "The isolated PDF parser could not complete this operation.";
  const encoded = Buffer.from(JSON.stringify({
    status: "error",
    protocol_version: PROTOCOL_VERSION,
    operation,
    error: {
      name: typeof error?.name === "string" && error.name.length <= 256
        ? error.name
        : "Error",
      code,
      message,
    },
  }), "utf8");
  await writeStream(process.stdout, encoded);
}

export async function executePdfjsWorkerRequest(inputRequest) {
  const request = validateRequest(inputRequest);
  const assertPathAllowed = createPathPolicy(request);
  assertPathAllowed(request.source.canonical_path);
  return await withBoundedPdfFileSafely(
    request.source.canonical_path,
    request.source.size_bytes,
    {
      assertPathAllowed,
      createSizeLimitError: () => sourceChangedError(),
    },
    async actualSource => {
      if (!sameSourceBinding(actualSource, request.source)) throw sourceChangedError();
      return await performOperation(request, actualSource.bytes);
    },
  );
}

function workerErrorDetail(inputError) {
  const mappedPasswordError = passwordError(inputError, pdfjsLib);
  const error = mappedPasswordError || inputError;
  return {
    name: typeof error?.name === "string" && error.name.length <= 256
      ? error.name
      : "Error",
    code: typeof error?.code === "string" && error.code.length <= 256
      ? error.code
      : null,
    message: typeof error?.message === "string" && error.message.length <= 4096
      ? error.message
      : "The isolated PDF parser could not complete this operation.",
  };
}

function threadResponse(operation, operationResult) {
  const binary = operationResult.binary;
  if (binary !== null && binary.length > MAX_BINARY_BYTES) {
    throw resourceLimitError("worker_binary_limit");
  }
  const descriptor = binary === null
    ? null
    : {
        bytes: binary.length,
        mime_type: operation === "render_comparison_page"
          ? "application/x-pdf-tools-rgba"
          : "image/png",
        sha256: createHash("sha256").update(binary).digest("hex"),
      };
  const frame = {
    status: "ok",
    protocol_version: PROTOCOL_VERSION,
    operation,
    result: operationResult.result,
    binary: descriptor,
  };
  if (Buffer.byteLength(JSON.stringify(frame), "utf8") > MAX_RESPONSE_BYTES) {
    throw resourceLimitError("worker_response_limit");
  }
  return { frame, binary };
}

async function threadMain() {
  let operation = "unknown";
  try {
    // Electron warns that loading native Node modules from a worker can crash
    // the enclosing process. PDF.js probes @napi-rs/canvas during import even
    // for text-only operations, so fail that probe safely. Rendering can still
    // use the controller-owned macOS system renderer.
    installThreadNativeModuleGuard();
    installThreadSystemCommandHandler();
    const request = validateRequest(workerData.request);
    operation = request.operation;
    const response = threadResponse(
      operation,
      await executePdfjsWorkerRequest(request),
    );
    parentPort.postMessage({ kind: "response", response });
  } catch (error) {
    parentPort.postMessage({
      kind: "response",
      response: {
        frame: {
          status: "error",
          protocol_version: PROTOCOL_VERSION,
          operation,
          error: workerErrorDetail(error),
        },
        binary: null,
      },
    });
  } finally {
    parentPort.close();
  }
}

async function main() {
  let operation = "unknown";
  try {
    const request = await readRequest();
    operation = request.operation;
    await writeSuccess(operation, await executePdfjsWorkerRequest(request));
  } catch (error) {
    await writeError(operation, error);
  }
}

if (
  !isMainThread
  && workerData?.pdf_tools_worker === "pdfjs"
  && parentPort
) {
  await threadMain();
} else if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  installSystemChildTerminationHandlers();
  await main();
}
