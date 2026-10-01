/**
 * PDF Tools Viewer — MCP App
 *
 * Interactive PDF viewer with form field sidebar.
 * Uses ext-apps SDK for host communication.
 * PDF.js for rendering with TextLayer for text selection.
 */

import {
  App,
  type McpUiHostContext,
  applyDocumentTheme,
  applyHostStyleVariables,
} from "@modelcontextprotocol/ext-apps";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import * as pdfjsLib from "pdfjs-dist";
import { TextLayer } from "pdfjs-dist";
import "./mcp-app.css";
import {
  type PageBox,
  pdfPointToZonePoint,
  resolvePageBox,
  zoneToPdfRect,
} from "./page-box.js";
import { buildManagedPdfPath, getHostBaseName } from "./path-utils";
import { isPdfWorkspaceResult, PDF_WORKSPACE_TASKS } from "./workspace";
import {
  LatestPathRequestState,
  getCanvasBufferSize,
  getSignPanelStatus,
  getWrappedFocusIndex,
  getZoneDescriptorKey,
} from "./sign-mode-utils";
import {
  type PdfToolLoadData,
  type PdfToolInputData,
  getDisplayPdfTextFileName,
  getPdfToolInputData,
  getToolResultText,
  parsePdfToolLoadData,
} from "./tool-result";

// Bundle the worker INTO this component rather than pointing pdf.js at a
// separate URL.
//
// `?url` made Vite emit the worker as a ~2.7 MB `data:text/javascript` module
// and set it as workerSrc. ChatGPT desktop's component sandbox refuses to load
// a secondary `data:` module, so `new Worker(dataUrl, {type:"module"})` failed,
// pdf.js fell back to its fake worker, and that fallback re-imported the same
// rejected URL. The user saw "Setting up fake worker failed: Failed to fetch
// dynamically imported module". Claude Desktop happened to allow it, which is
// why this survived until the viewer was first run on a non-Anthropic host.
//
// Importing the module for its side effect registers
// globalThis.pdfjsWorker.WorkerMessageHandler at the top level, which is the
// branch pdf.js takes when it needs no URL at all. Nothing is fetched, so no
// host CSP or sandbox policy is involved. Do not reintroduce `?url` here; a
// regression test asserts the built bundle contains no data: worker URL.
import "pdfjs-dist/build/pdf.worker.mjs";

const MAX_CHUNK_BYTES = 524288; // 512KB — must match server
const MAX_MODEL_CONTEXT_LENGTH = 15000;
const MAX_ZOOM = 3.0;
const MIN_ZOOM = 0.5;
const ZOOM_STEP = 0.25;
const BRIDGE_CONNECT_TIMEOUT_MS = 15000;
const BRIDGE_RESULT_TIMEOUT_MS = 90000;

// ─── State ───────────────────────────────────────────────────────────────────

let pdfDocument: pdfjsLib.PDFDocumentProxy | null = null;
let currentPage = 1;
let totalPages = 0;
let scale = 1.0;
let pdfPath = "";
let viewUUID: string | undefined;
let currentRenderTask: { cancel: () => void } | null = null;
let isRendering = false;
let pendingPage: number | null = null;
let currentDisplayMode: "inline" | "fullscreen" = "inline";
let currentViewport: any = null;
let currentViewportPage = 0;

// Manage pages state
type ManageMode = "view" | "manage" | "sign";
let manageMode: ManageMode = "view";

// Signature zones (Sign mode)
interface SignatureZone {
  type: "signature" | "initials" | "name" | "date";
  label: string;
  page: number;
  x: number;        // native top-left origin, points
  y: number;
  width: number;
  height: number;
  confidence: number;
  source: string;
  id?: string;      // assigned client-side for DOM linking
  applied?: boolean;
  // For plain-text zones, retain the stamped value for the overlay badge.
  appliedValue?: string;
}
interface ZoneDetectionWarning {
  code: string;
  message: string;
  occurrences: number;
}
// The page box zone coordinates are measured against. PDF.js exposes only the
// view (CropBox intersected with MediaBox), so the server sends this alongside
// the zones; without it, overlays are displaced on any page where the two
// boxes differ.
interface PageGeometry {
  page: number;
  origin_x: number;
  origin_y: number;
  width: number;
  height: number;
}
let signatureZones: SignatureZone[] = [];
const zoneWarningsByPath = new Map<string, ZoneDetectionWarning[]>();
const pageGeometryByPage = new Map<number, PageGeometry>();
let activeBackupPath: string | null = null;
// Remember which zones we've stamped so page navigation / mode toggles don't
// lose the ✓ Signed indicator. Key: `${pdfPath}|${type}|${page}|${x}|${y}`.
const appliedZoneKeys = new Set<string>();
// Cache last-fetched zones per pdfPath so re-entering sign mode doesn't
// re-run detection unnecessarily.
const zoneRequests = new LatestPathRequestState<SignatureZone[]>();

interface SavedSignatureSummary {
  name: string;
  style: string;
  display_name: string | null;
  preview_data_url?: string | null;
}

interface ZonePreviewState {
  zoneId: string;
  mode: SignModalMode;
  text?: string;
  imageDataUrl?: string;
  displayName?: string;
}

interface RegionPreviewState {
  page: number;
  x: number;
  y: number;
  width: number;
  height: number;
  imageDataUrl: string;
  zoneType?: SignatureZone["type"];
}

let savedSignatures: SavedSignatureSummary[] = [];
let activeZonePreview: ZonePreviewState | null = null;
const signaturePreviewCache = new Map<string, SavedSignatureSummary>();
let inspectRegionArmed = false;
let activeRegionPreview: RegionPreviewState | null = null;
let inspectPreviewRequestSeq = 0;
let inspectPreviewInFlight = false;
let activeZoneOriginalType: SignatureZone["type"] | null = null;

function zoneKey(pdfPath: string, z: { type: string; page: number; x: number; y: number }): string {
  return getZoneDescriptorKey(pdfPath, z);
}

function localDateString(date = new Date()) {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

interface PageState {
  originalIndex: number; // 1-indexed
  rotation: number; // cumulative degrees: 0, 90, 180, 270
  deleted: boolean;
  selected: boolean;
  thumbnailDataUrl: string | null;
}
let pageStates: PageState[] = [];
let dragSourceIndex: number | null = null;
let hasUnsavedChanges = false;

// Form fields
interface FieldInfo {
  name: string;
  type: string;
  options: string[];
  currentValue: string | boolean;
}
let fields: FieldInfo[] = [];
let selectedField: string | null = null;
let sidebarVisible = false;

// Search
let searchOpen = false;
let searchQuery = "";
let searchDebounceTimer: ReturnType<typeof setTimeout> | null = null;
const pageTextCache = new Map<number, string>();
let allMatches: { pageNum: number; index: number; length: number }[] = [];
let currentMatchIndex = -1;
let fieldMatches: { fieldName: string; fieldIndex: number }[] = [];

// Preloading
let preloadPaused = false;
let pagesLoaded = 0;
let lastLoadedResultKey = "";
let pendingLoadResultKey = "";
// Bumped whenever the underlying pdfDocument is replaced so an in-flight
// preloader from a previous generation aborts instead of polluting caches
// belonging to the new doc.
let pdfGeneration = 0;

// ─── DOM ─────────────────────────────────────────────────────────────────────

const $ = (id: string) => document.getElementById(id)!;

const mainEl = document.querySelector(".main") as HTMLElement;
const workspaceEl = $("workspace");
const workspaceTasksEl = $("workspace-tasks");
const workspaceStatusEl = $("workspace-status");
const loadingEl = $("loading");
const loadingTextEl = $("loading-text");
const progressBar = $("progress-bar");
const errorEl = $("error");
const errorMessageEl = $("error-message");
const errorDetailEl = $("error-detail");
const viewerEl = $("viewer");
const canvasContainerEl = document.querySelector(".canvas-container") as HTMLElement;
const canvasEl = $("pdf-canvas") as HTMLCanvasElement;
const textLayerEl = $("text-layer");
const highlightLayerEl = $("highlight-layer");
const zoneLayerEl = $("zone-layer");
const titleEl = $("pdf-title");
const pageInputEl = $("page-input") as HTMLInputElement;
const totalPagesEl = $("total-pages");
const prevBtn = $("prev-btn") as HTMLButtonElement;
const nextBtn = $("next-btn") as HTMLButtonElement;
const zoomOutBtn = $("zoom-out-btn") as HTMLButtonElement;
const zoomInBtn = $("zoom-in-btn") as HTMLButtonElement;
const zoomLevelEl = $("zoom-level");
const searchBtn = $("search-btn") as HTMLButtonElement;
const fullscreenBtn = $("fullscreen-btn") as HTMLButtonElement;
const loadingIndicatorEl = $("loading-indicator");
const loadingIndicatorArc = loadingIndicatorEl.querySelector(".loading-indicator-arc") as SVGCircleElement;
const sidebarToggleBtn = $("sidebar-toggle-btn") as HTMLButtonElement;
const searchBarEl = $("search-bar");
const searchInputEl = $("search-input") as HTMLInputElement;
const searchMatchCountEl = $("search-match-count");
const searchPrevBtn = $("search-prev-btn") as HTMLButtonElement;
const searchNextBtn = $("search-next-btn") as HTMLButtonElement;
const searchCloseBtn = $("search-close-btn") as HTMLButtonElement;
const sidebarEl = $("sidebar");
const fieldsListEl = $("fields-list");
const fieldCountEl = $("field-count");
const fieldFilterEl = $("field-filter") as HTMLInputElement;
const fillProgressEl = $("fill-progress");
const fillProgressValueEl = $("fill-progress-value");
const fillProgressTextEl = $("fill-progress-text");

// ─── App ─────────────────────────────────────────────────────────────────────

const app = new App(
  { name: "PDF Tools Viewer", version: "1.0.0" },
  {},
  { autoResize: false, strict: true },
);

let isTearingDown = false;
let teardownPromise: Promise<Record<string, never>> | null = null;
let viewerLifecycleEpoch = 0;
let latestToolInput: PdfToolInputData | null = null;
let hasReceivedToolInput = false;
let toolInputConflict = false;
let connectTimeout: ReturnType<typeof setTimeout> | null = null;
let toolResultTimeout: ReturnType<typeof setTimeout> | null = null;
let hasReceivedToolResult = false;
let authoritativePayloadVersion = 0;
let lastRecoveredDisplayResultText = "";
let fallbackLoad:
  | { key: string; pdfPath: string; promise: Promise<boolean> }
  | null = null;

// ─── UI State ────────────────────────────────────────────────────────────────

function showLoading(text: string) {
  workspaceEl.style.display = "none";
  loadingTextEl.textContent = text;
  loadingEl.style.display = "flex";
  errorEl.style.display = "none";
  viewerEl.style.display = "none";
}

// Runtime facts that identify which build is failing and why an asset load was
// refused. Derived at runtime on purpose rather than injected at build time:
// this repository gates on two clean builds being byte-identical, and baking a
// timestamp or ambient commit into the bundle would break that.
//
// The workerSrc line is the one that matters. When the viewer shipped a
// `data:` worker it rendered blank on a sandboxed host and the message said
// only "Failed to fetch dynamically imported module", with no indication of
// which asset or why. Reporting the scheme and length, rather than 2.7 MB of
// base64, turns that into a one-glance diagnosis.
function describeViewerEnvironment(): string {
  const parts: string[] = [];
  try {
    if (pdfjsLib.version) parts.push(`pdf.js ${pdfjsLib.version}`);
  } catch { /* version is best-effort */ }
  try {
    const source = pdfjsLib.GlobalWorkerOptions?.workerSrc;
    if (source) {
      const text = String(source);
      const scheme = /^[a-z][a-z0-9+.-]*:/i.exec(text)?.[0] ?? "relative";
      parts.push(`workerSrc ${scheme} (${text.length} chars)`);
    } else {
      parts.push("workerSrc unset");
    }
  } catch { /* workerSrc is best-effort */ }
  parts.push(
    (globalThis as { pdfjsWorker?: unknown }).pdfjsWorker
      ? "worker registered in-realm"
      : "worker NOT registered in-realm",
  );
  return parts.join(" · ");
}

function showError(message: string) {
  workspaceEl.style.display = "none";
  errorMessageEl.textContent = message;
  const detail = describeViewerEnvironment();
  errorDetailEl.textContent = detail;
  errorDetailEl.style.display = detail ? "block" : "none";
  // Also to the console, where a host's devtools or log capture will keep it
  // even if the surface is torn down.
  console.error(`[viewer] ${message} | ${detail}`);
  loadingEl.style.display = "none";
  errorEl.style.display = "block";
  viewerEl.style.display = "none";
}

function showViewer() {
  workspaceEl.style.display = "none";
  loadingEl.style.display = "none";
  errorEl.style.display = "none";
  viewerEl.style.display = "flex";
}

function showWorkspace() {
  // A late entrypoint result may not replace a document already being reviewed.
  if (pdfDocument) { showViewer(); return; }
  loadingEl.style.display = "none";
  errorEl.style.display = "none";
  viewerEl.style.display = "none";
  workspaceEl.style.display = "block";
}

for (const task of PDF_WORKSPACE_TASKS) {
  const button = document.createElement("button");
  button.type = "button";
  button.className = "workspace-task";
  const title = document.createElement("strong");
  title.textContent = task.title;
  const detail = document.createElement("span");
  detail.textContent = task.description;
  button.append(title, detail);
  button.addEventListener("click", async () => {
    if (isTearingDown) return;
    const lifecycle = captureViewerLifecycle();
    // Keep the exact prompt visible and selectable on every host, including
    // hosts without ui/message. A click requests guidance, never a tool write.
    workspaceStatusEl.textContent = "You can send this request in the conversation:";
    const prompt = document.createElement("span");
    prompt.className = "workspace-prompt";
    prompt.textContent = task.prompt;
    workspaceStatusEl.appendChild(prompt);
    if (!app.getHostCapabilities()?.message?.text) return;
    const buttons = workspaceTasksEl.querySelectorAll<HTMLButtonElement>("button");
    buttons.forEach(item => { item.disabled = true; });
    try {
      const delivered = await app.sendMessage({ role: "user", content: [{ type: "text", text: task.prompt }] });
      if (!isViewerLifecycleCurrent(lifecycle)) return;
      if (delivered.isError) return;
      workspaceStatusEl.textContent = "Request sent. Continue in the conversation to choose your PDF.";
    } catch {
      // The fallback is already visible. Do not retry a chat submission.
    } finally {
      if (isViewerLifecycleCurrent(lifecycle)) buttons.forEach(item => { item.disabled = false; });
    }
  });
  workspaceTasksEl.appendChild(button);
}

function clearConnectTimeout() {
  if (connectTimeout) {
    clearTimeout(connectTimeout);
    connectTimeout = null;
  }
}

function clearToolResultTimeout() {
  if (toolResultTimeout) {
    clearTimeout(toolResultTimeout);
    toolResultTimeout = null;
  }
}

function startToolResultTimeout() {
  clearToolResultTimeout();
  const lifecycle = viewerLifecycleEpoch;
  toolResultTimeout = setTimeout(() => {
    toolResultTimeout = null;
    if (!isViewerLifecycleCurrent(lifecycle) || pdfDocument) return;
    showError(
      "Claude did not deliver the completed PDF tool result to the viewer. Retry opening the PDF.",
    );
  }, BRIDGE_RESULT_TIMEOUT_MS);
}

function updateControls() {
  titleEl.textContent = getHostBaseName(pdfPath);
  titleEl.title = pdfPath;
  pageInputEl.value = String(currentPage);
  pageInputEl.max = String(totalPages);
  totalPagesEl.textContent = `of ${totalPages}`;
  prevBtn.disabled = currentPage <= 1;
  nextBtn.disabled = currentPage >= totalPages;
  zoomLevelEl.textContent = `${Math.round(scale * 100)}%`;
}

// ─── DOM Helpers ─────────────────────────────────────────────────────────────

function clearChildren(el: HTMLElement) {
  while (el.firstChild) el.removeChild(el.firstChild);
}

// ─── Chunked Loading ─────────────────────────────────────────────────────────

const rangeCache = new Map<string, { bytes: Uint8Array; totalBytes: number }>();
const inflightRequests = new Map<string, Promise<{ bytes: Uint8Array; totalBytes: number }>>();
const pathCacheEpochs = new Map<string, number>();
const activePdfLoadingTasks = new Set<pdfjsLib.PDFDocumentLoadingTask>();

class ViewerLifecycleEndedError extends Error {
  constructor() {
    super("The PDF viewer lifecycle has ended.");
    this.name = "ViewerLifecycleEndedError";
  }
}

function captureViewerLifecycle() {
  if (isTearingDown) throw new ViewerLifecycleEndedError();
  return viewerLifecycleEpoch;
}

function assertViewerLifecycle(lifecycle: number) {
  if (isTearingDown || lifecycle !== viewerLifecycleEpoch) {
    throw new ViewerLifecycleEndedError();
  }
}

function isViewerLifecycleCurrent(lifecycle: number) {
  return !isTearingDown && lifecycle === viewerLifecycleEpoch;
}

function isViewerLifecycleEnded(err: unknown) {
  return isTearingDown || err instanceof ViewerLifecycleEndedError;
}

type ServerToolRequest = Parameters<typeof app.callServerTool>[0];

async function callServerToolDuringLifecycle(
  request: ServerToolRequest,
  lifecycle = captureViewerLifecycle(),
) {
  assertViewerLifecycle(lifecycle);
  const result = await app.callServerTool(request);
  assertViewerLifecycle(lifecycle);
  return result;
}

function getPathCacheEpoch(filePath: string) {
  return pathCacheEpochs.get(filePath) ?? 0;
}

function buildRangeCacheKey(filePath: string, begin: number, end: number, epoch = getPathCacheEpoch(filePath)) {
  return `${filePath}@${epoch}:${begin}-${end}`;
}

function invalidateRangeCacheForPath(filePath: string) {
  const nextEpoch = getPathCacheEpoch(filePath) + 1;
  pathCacheEpochs.set(filePath, nextEpoch);
  const prefix = `${filePath}@`;
  for (const key of Array.from(rangeCache.keys())) {
    if (key.startsWith(prefix)) rangeCache.delete(key);
  }
  for (const key of Array.from(inflightRequests.keys())) {
    if (key.startsWith(prefix)) inflightRequests.delete(key);
  }
}

async function fetchChunk(path: string, begin: number, end: number) {
  if (isTearingDown) throw new ViewerLifecycleEndedError();
  const epoch = getPathCacheEpoch(path);
  const key = buildRangeCacheKey(path, begin, end, epoch);
  if (rangeCache.has(key)) return rangeCache.get(key)!;
  if (inflightRequests.has(key)) return inflightRequests.get(key)!;

  const request = (async () => {
    try {
      const result = await callServerToolDuringLifecycle({
        name: "read_pdf_bytes",
        arguments: { pdf_path: path, offset: begin, byteCount: end - begin },
      });
      if (isTearingDown || getPathCacheEpoch(path) !== epoch) {
        throw new ViewerLifecycleEndedError();
      }

      if (result.isError) {
        const text = result.content?.map((c: any) => ("text" in c ? c.text : "")).join(" ") || "";
        throw new Error(text);
      }

      const sc = result.structuredContent as any;
      if (!sc?.bytes) throw new Error("No bytes in response");

      const raw = atob(sc.bytes);
      const bytes = new Uint8Array(raw.length);
      for (let i = 0; i < raw.length; i++) bytes[i] = raw.charCodeAt(i);

      const entry = { bytes, totalBytes: sc.totalBytes };
      if (isTearingDown || getPathCacheEpoch(path) !== epoch) {
        throw new ViewerLifecycleEndedError();
      }
      rangeCache.set(key, entry);
      return entry;
    } finally {
      inflightRequests.delete(key);
    }
  })();

  inflightRequests.set(key, request);
  return request;
}

async function fetchRange(path: string, begin: number, end: number) {
  const size = end - begin;
  if (size <= MAX_CHUNK_BYTES) return fetchChunk(path, begin, end);

  const chunks: { begin: number; end: number }[] = [];
  for (let off = begin; off < end; off += MAX_CHUNK_BYTES) {
    chunks.push({ begin: off, end: Math.min(off + MAX_CHUNK_BYTES, end) });
  }

  const results = await Promise.all(chunks.map(c => fetchChunk(path, c.begin, c.end)));
  const totalLen = results.reduce((s, r) => s + r.bytes.length, 0);
  const combined = new Uint8Array(totalLen);
  let pos = 0;
  for (const r of results) { combined.set(r.bytes, pos); pos += r.bytes.length; }
  return { bytes: combined, totalBytes: results[0].totalBytes };
}

async function loadPdfProgressively(filePath: string, fileSize: number, generation: number) {
  if (isTearingDown || generation !== pdfGeneration) {
    throw new ViewerLifecycleEndedError();
  }

  class AppRangeTransport extends pdfjsLib.PDFDataRangeTransport {
    requestDataRange(begin: number, end: number) {
      fetchRange(filePath, begin, end)
        .then(r => this.onDataRange(begin, r.bytes))
        .catch(err => {
          if (!isTearingDown && generation === pdfGeneration) {
            console.error("[viewer] Range fetch error:", err);
          }
        });
    }
  }

  const transport = new AppRangeTransport(fileSize, null);
  const loadingTask = pdfjsLib.getDocument({ range: transport });
  activePdfLoadingTasks.add(loadingTask);
  try {
    const document = await loadingTask.promise;
    if (isTearingDown || generation !== pdfGeneration) {
      try { await document.destroy(); } catch { /* best-effort */ }
      throw new ViewerLifecycleEndedError();
    }
    return document;
  } finally {
    activePdfLoadingTasks.delete(loadingTask);
  }
}

// ─── Page Rendering ──────────────────────────────────────────────────────────

async function renderPage() {
  if (!pdfDocument || isTearingDown) return;

  if (isRendering) {
    pendingPage = currentPage;
    if (currentRenderTask) currentRenderTask.cancel();
    return;
  }

  isRendering = true;
  pendingPage = null;
  currentViewport = null;
  currentViewportPage = 0;
  const renderDocument = pdfDocument;
  const renderGeneration = pdfGeneration;
  const renderIsStale = () =>
    isTearingDown ||
    renderGeneration !== pdfGeneration ||
    renderDocument !== pdfDocument;

  try {
    const pageNum = currentPage;
    const page = await renderDocument.getPage(pageNum);
    if (renderIsStale()) return;
    const viewport = page.getViewport({ scale });
    const dpr = window.devicePixelRatio || 1;
    const ctx = canvasEl.getContext("2d")!;

    canvasEl.width = viewport.width * dpr;
    canvasEl.height = viewport.height * dpr;
    canvasEl.style.width = `${viewport.width}px`;
    canvasEl.style.height = `${viewport.height}px`;
    ctx.scale(dpr, dpr);

    clearChildren(textLayerEl);
    textLayerEl.style.setProperty("--scale-factor", `${scale}`);

    const renderTask = (page as any).render({ canvasContext: ctx, viewport });
    currentRenderTask = renderTask;

    try {
      await renderTask.promise;
    } catch (err: any) {
      if (err?.name === "RenderingCancelledException") return;
      throw err;
    } finally {
      currentRenderTask = null;
    }

    if (renderIsStale() || pageNum !== currentPage) return;
    currentViewport = viewport;
    currentViewportPage = pageNum;

    // TextLayer for selection
    const textContent = await page.getTextContent();
    if (renderIsStale()) return;
    const textLayer = new TextLayer({
      textContentSource: textContent,
      container: textLayerEl,
      viewport,
    });
    await textLayer.render();
    if (renderIsStale()) return;

    // Cache page text
    if (!pageTextCache.has(pageNum)) {
      const items = (textContent.items as { str?: string }[]).map(i => i.str || "");
      pageTextCache.set(pageNum, items.join(""));
    }

    // Highlight layer
    highlightLayerEl.style.width = `${viewport.width}px`;
    highlightLayerEl.style.height = `${viewport.height}px`;

    if (searchOpen && searchQuery) renderHighlights();
    if (manageMode === "sign") renderZoneOverlay();

    updateControls();
    updatePageContext();
    requestFitToContent();
  } catch (err: any) {
    if (renderIsStale()) return;
    console.error("[viewer] Render error:", err);
    showError(`Failed to render page ${currentPage}`);
  } finally {
    preloadPaused = false;
    isRendering = false;

    if (!isTearingDown && pendingPage !== null) {
      const next = pendingPage;
      pendingPage = null;
      currentPage = next;
      renderPage();
    }
  }
}

function requestFitToContent() {
  if (currentDisplayMode === "fullscreen") return;

  // Defer to next frame so the browser has reflowed after canvas resize
  requestAnimationFrame(() => {
    if (isTearingDown) return;
    const toolbarEl = document.querySelector(".toolbar") as HTMLElement;
    const pageWrapperEl = document.querySelector(".page-wrapper") as HTMLElement;
    if (!toolbarEl || !pageWrapperEl) return;

    const containerStyle = getComputedStyle(canvasContainerEl);
    const paddingTop = parseFloat(containerStyle.paddingTop);
    const paddingBottom = parseFloat(containerStyle.paddingBottom);
    const searchBarHeight = searchOpen ? (document.getElementById("search-bar")?.offsetHeight || 0) : 0;

    // Use the actual canvas CSS height as the most reliable measurement
    const canvasHeight = parseFloat(canvasEl.style.height) || pageWrapperEl.offsetHeight;
    const total = toolbarEl.offsetHeight + searchBarHeight + paddingTop + canvasHeight + paddingBottom + 16;

    // Minimum 400px so the viewer is always usable
    const height = Math.max(400, Math.min(total, 900));
    void app.sendSizeChanged({ height }).catch((err: unknown) => {
      if (!isTearingDown) console.warn("[viewer] Size update failed:", err);
    });
  });
}

// ─── Navigation ──────────────────────────────────────────────────────────────

function goToPage(page: number) {
  const target = Math.max(1, Math.min(page, totalPages));
  if (target !== currentPage) {
    preloadPaused = true;
    currentPage = target;
    saveCurrentPage();
    renderPage();
  }
  pageInputEl.value = String(currentPage);
}

function saveCurrentPage() {
  if (viewUUID) {
    try { localStorage.setItem(viewUUID, String(currentPage)); } catch {}
  }
}

function loadSavedPage(): number | null {
  if (!viewUUID) return null;
  try {
    const v = localStorage.getItem(viewUUID);
    if (v) { const p = parseInt(v, 10); if (!isNaN(p) && p >= 1) return p; }
  } catch {}
  return null;
}

// ─── Zoom ────────────────────────────────────────────────────────────────────

function zoomIn() { scale = Math.min(scale + ZOOM_STEP, MAX_ZOOM); renderPage(); }
function zoomOut() { scale = Math.max(scale - ZOOM_STEP, MIN_ZOOM); renderPage(); }
function resetZoom() { scale = 1.0; renderPage(); }

// ─── Fullscreen ──────────────────────────────────────────────────────────────

async function toggleFullscreen() {
  if (isTearingDown) return;
  const lifecycle = captureViewerLifecycle();
  const ctx = app.getHostContext();
  if (!ctx?.availableDisplayModes?.includes("fullscreen")) return;
  const newMode = currentDisplayMode === "fullscreen" ? "inline" : "fullscreen";
  try {
    const result = await app.requestDisplayMode({ mode: newMode });
    assertViewerLifecycle(lifecycle);
    currentDisplayMode = result.mode as "inline" | "fullscreen";
    mainEl.classList.toggle("fullscreen", currentDisplayMode === "fullscreen");
    fullscreenBtn.title = currentDisplayMode === "fullscreen" ? "Exit fullscreen" : "Fullscreen";
  } catch {}
}

// ─── Model Context ───────────────────────────────────────────────────────────

async function updatePageContext() {
  if (!pdfDocument || isTearingDown) return;
  const lifecycle = captureViewerLifecycle();
  try {
    const pageText = pageTextCache.get(currentPage) || "";
    const sel = window.getSelection();
    const selectedText = sel?.toString().trim();
    let content = pageText.slice(0, MAX_MODEL_CONTEXT_LENGTH);
    if (pageText.length > MAX_MODEL_CONTEXT_LENGTH) content += "\n<truncated-content/>";

    if (selectedText && selectedText.length > 2) {
      const idx = content.indexOf(selectedText);
      if (idx >= 0) {
        content = content.slice(0, idx) + `<pdf-selection>${selectedText}</pdf-selection>` + content.slice(idx + selectedText.length);
      }
    }

    const fileName = getHostBaseName(pdfPath);
    const header = `PDF Tools Viewer | "${fileName}" | Page ${currentPage}/${totalPages}`;
    let contextText = `${header}\n\nPage content:\n${content}`;
    contextText += `\n\nActive document path: ${pdfPath}`;
    if (activeBackupPath) {
      contextText += `\nOriginal backup preserved at: ${activeBackupPath}`;
    }

    if (selectedField) {
      contextText += `\n\nSelected form field: ${selectedField}`;
    }

    await app.updateModelContext({ content: [{ type: "text", text: contextText }] });
    assertViewerLifecycle(lifecycle);
  } catch {}
}

async function syncActiveDocumentState() {
  if (!pdfPath || isTearingDown) return;
  const lifecycle = captureViewerLifecycle();
  try {
    await callServerToolDuringLifecycle({
      name: "set_active_document",
      arguments: {
        pdf_path: pdfPath,
        ...(activeBackupPath ? { backup_path: activeBackupPath } : {}),
      },
    }, lifecycle);
  } catch (err) {
    if (!isViewerLifecycleEnded(err)) {
      console.warn("[viewer] set_active_document failed:", err);
    }
  }
}

// ─── Search ──────────────────────────────────────────────────────────────────

function performSearch(query: string) {
  allMatches = [];
  currentMatchIndex = -1;
  searchQuery = query;

  if (!query) {
    updateSearchUI();
    clearHighlights();
    fieldMatches = [];
    if (fields.length > 0) renderFields();
    return;
  }

  const lower = query.toLowerCase();
  for (let p = 1; p <= totalPages; p++) {
    const text = pageTextCache.get(p);
    if (!text) continue;
    const lt = text.toLowerCase();
    let idx = 0;
    while (true) {
      const found = lt.indexOf(lower, idx);
      if (found === -1) break;
      allMatches.push({ pageNum: p, index: found, length: query.length });
      idx = found + 1;
    }
  }

  // Also search form field names and values
  fieldMatches = [];
  if (fields.length > 0) {
    for (let i = 0; i < fields.length; i++) {
      const f = fields[i];
      const val = String(f.currentValue || "").toLowerCase();
      const name = f.name.toLowerCase();
      if ((val && val.includes(lower)) || name.includes(lower)) {
        fieldMatches.push({ fieldName: f.name, fieldIndex: i });
      }
    }
    if (fieldMatches.length > 0) {
      renderFields();
      if (!sidebarVisible) showSidebar();
    }
  }

  if (allMatches.length > 0) {
    const i = allMatches.findIndex(m => m.pageNum >= currentPage);
    currentMatchIndex = i >= 0 ? i : 0;
  }

  updateSearchUI();
  renderHighlights();

  if (allMatches.length > 0 && currentMatchIndex >= 0) {
    const m = allMatches[currentMatchIndex];
    if (m.pageNum !== currentPage) goToPage(m.pageNum);
  }
}

function renderHighlights() {
  clearHighlights();
  if (!searchQuery || allMatches.length === 0) return;

  const spans = Array.from(textLayerEl.querySelectorAll("span")) as HTMLElement[];
  if (spans.length === 0) return;

  const pageMatches = allMatches.filter(m => m.pageNum === currentPage);
  if (pageMatches.length === 0) return;

  const lower = searchQuery.toLowerCase();
  const wrapperEl = textLayerEl.parentElement!;
  const wrapperRect = wrapperEl.getBoundingClientRect();
  let matchOrd = 0;

  for (const span of spans) {
    const text = span.textContent || "";
    if (!text) continue;
    const lt = text.toLowerCase();
    if (!lt.includes(lower)) continue;

    const textNode = span.firstChild;
    if (!textNode || textNode.nodeType !== Node.TEXT_NODE) continue;

    let pos = 0;
    while (true) {
      const idx = lt.indexOf(lower, pos);
      if (idx === -1) break;

      const isCurrent = matchOrd < pageMatches.length &&
        allMatches.indexOf(pageMatches[matchOrd]) === currentMatchIndex;

      try {
        const range = document.createRange();
        range.setStart(textNode, idx);
        range.setEnd(textNode, Math.min(idx + lower.length, text.length));
        const rects = range.getClientRects();
        for (let r = 0; r < rects.length; r++) {
          const rect = rects[r];
          const div = document.createElement("div");
          div.className = "search-highlight" + (isCurrent ? " current" : "");
          div.style.position = "absolute";
          div.style.left = `${rect.left - wrapperRect.left}px`;
          div.style.top = `${rect.top - wrapperRect.top}px`;
          div.style.width = `${rect.width}px`;
          div.style.height = `${rect.height}px`;
          highlightLayerEl.appendChild(div);
        }
      } catch {}

      matchOrd++;
      pos = idx + 1;
    }
  }

  const currentHL = highlightLayerEl.querySelector(".search-highlight.current") as HTMLElement;
  if (currentHL) currentHL.scrollIntoView({ block: "center", behavior: "smooth" });
}

function clearHighlights() {
  clearChildren(highlightLayerEl);
}

function updateSearchUI() {
  const hasQuery = searchQuery.length > 0;
  const loading = totalPages > 0 && pagesLoaded < totalPages;
  const suffix = loading ? " (loading\u2026)" : "";
  const textCount = allMatches.length;
  const fCount = fieldMatches.length;

  if (textCount === 0 && fCount === 0) {
    searchMatchCountEl.textContent = hasQuery ? `No matches${suffix}` : "";
  } else {
    const parts: string[] = [];
    if (textCount > 0) parts.push(`${currentMatchIndex + 1} of ${textCount}`);
    if (fCount > 0) parts.push(`${fCount} field${fCount !== 1 ? "s" : ""}`);
    searchMatchCountEl.textContent = parts.join(", ") + suffix;
  }
  searchPrevBtn.disabled = allMatches.length === 0;
  searchNextBtn.disabled = allMatches.length === 0;
}

function openSearch() {
  if (searchOpen) { searchInputEl.focus(); searchInputEl.select(); return; }
  searchOpen = true;
  searchBarEl.style.display = "flex";
  updateSearchUI();
  searchInputEl.focus();
}

function closeSearch() {
  if (!searchOpen) return;
  searchOpen = false;
  searchBarEl.style.display = "none";
  searchQuery = "";
  searchInputEl.value = "";
  allMatches = [];
  currentMatchIndex = -1;
  fieldMatches = [];
  clearHighlights();
  if (fields.length > 0) renderFields();
}

function goToNextMatch() {
  if (allMatches.length === 0) return;
  currentMatchIndex = (currentMatchIndex + 1) % allMatches.length;
  updateSearchUI();
  const m = allMatches[currentMatchIndex];
  if (m.pageNum !== currentPage) goToPage(m.pageNum); else renderHighlights();
}

function goToPrevMatch() {
  if (allMatches.length === 0) return;
  currentMatchIndex = (currentMatchIndex - 1 + allMatches.length) % allMatches.length;
  updateSearchUI();
  const m = allMatches[currentMatchIndex];
  if (m.pageNum !== currentPage) goToPage(m.pageNum); else renderHighlights();
}

// ─── Form Field Sidebar ─────────────────────────────────────────────────────

function showSidebar() {
  sidebarVisible = true;
  sidebarEl.style.display = "flex";
  sidebarToggleBtn.textContent = "Hide Fields";
}

function hideSidebar() {
  sidebarVisible = false;
  sidebarEl.style.display = "none";
  sidebarToggleBtn.textContent = "Fields";
}

function toggleSidebar() {
  if (sidebarVisible) hideSidebar(); else showSidebar();
}

function renderFields() {
  clearChildren(fieldsListEl);
  fillProgressEl.style.display = "none";

  if (fields.length === 0) {
    const el = document.createElement("div");
    el.className = "empty-state";
    el.textContent = "No form fields found";
    fieldsListEl.appendChild(el);
    fieldCountEl.textContent = "0 fields";
    return;
  }

  fieldCountEl.textContent = `${fields.length} field${fields.length !== 1 ? "s" : ""}`;

  const filled = fields.filter(f => f.currentValue !== "" && f.currentValue !== false).length;
  if (filled > 0 || fields.length > 0) {
    fillProgressEl.style.display = "flex";
    fillProgressValueEl.style.width = `${(filled / fields.length) * 100}%`;
    fillProgressTextEl.textContent = `${filled} of ${fields.length} filled`;
  }

  for (const field of fields) {
    const icons: Record<string, string> = { text: "T", checkbox: "\u2611", radio: "\u25C9", dropdown: "\u25BE", unknown: "?" };

    const item = document.createElement("div");
    const isSearchMatch = fieldMatches.some(fm => fm.fieldName === field.name);
    item.className = `field-item${selectedField === field.name ? " selected" : ""}${isSearchMatch ? " search-match" : ""}`;

    const header = document.createElement("div");
    header.className = "field-header";

    const badge = document.createElement("span");
    badge.className = `field-type-badge type-${field.type}`;
    badge.textContent = icons[field.type] || "?";

    const name = document.createElement("span");
    name.className = "field-name";
    name.title = field.name;
    name.textContent = field.name;

    header.append(badge, name);

    const details = document.createElement("div");
    details.className = "field-details";

    const typeLabel = document.createElement("span");
    typeLabel.className = "field-type-label";
    typeLabel.textContent = field.type;
    details.appendChild(typeLabel);

    if (field.currentValue !== "" && field.currentValue !== false) {
      const val = document.createElement("span");
      val.className = "field-value";
      val.title = String(field.currentValue);
      val.textContent = `= ${String(field.currentValue)}`;
      details.appendChild(val);
    } else {
      const empty = document.createElement("span");
      empty.className = "field-empty";
      empty.textContent = "empty";
      details.appendChild(empty);
    }

    item.append(header, details);

    if (field.options.length > 0) {
      const opts = document.createElement("div");
      opts.className = "field-options";
      opts.textContent = `Options: ${field.options.join(", ")}`;
      item.appendChild(opts);
    }

    item.addEventListener("click", () => {
      selectedField = field.name;
      renderFields();
      updatePageContext();
    });

    fieldsListEl.appendChild(item);
  }
}

// ─── Background Preloader ────────────────────────────────────────────────────

const CIRCLE_CIRCUMFERENCE = 2 * Math.PI * 8;

function updateLoadingIndicator() {
  if (totalPages <= 0) return;
  const pct = pagesLoaded / totalPages;
  loadingIndicatorArc.style.strokeDashoffset = String(CIRCLE_CIRCUMFERENCE * (1 - pct));
  loadingIndicatorEl.style.display = "inline-flex";
  loadingIndicatorEl.title = `${pagesLoaded}/${totalPages} pages indexed`;
}

async function startPreloading() {
  if (!pdfDocument) return;
  const myGen = pdfGeneration;
  for (let i = 1; i <= totalPages; i++) {
    // A reload bumped the generation — abandon this run. The new run will
    // index the new doc from scratch.
    if (myGen !== pdfGeneration) return;
    if (pageTextCache.has(i)) { pagesLoaded++; updateLoadingIndicator(); continue; }
    while (preloadPaused) {
      await new Promise(r => setTimeout(r, 50));
      if (myGen !== pdfGeneration) return;
    }
    try {
      const page = await pdfDocument.getPage(i);
      if (myGen !== pdfGeneration) return;
      const tc = await page.getTextContent();
      if (myGen !== pdfGeneration) return;
      const items = (tc.items as { str?: string }[]).map(it => it.str || "");
      pageTextCache.set(i, items.join(""));
      pagesLoaded++;
      updateLoadingIndicator();
    } catch (err) {
      if (!isTearingDown && myGen === pdfGeneration) {
        console.error("[viewer] Preload error page", i, err);
      }
    }
  }

  // Done — fade out indicator
  setTimeout(() => {
    if (isTearingDown || myGen !== pdfGeneration) return;
    loadingIndicatorEl.style.opacity = "0";
    setTimeout(() => {
      if (isTearingDown || myGen !== pdfGeneration) return;
      loadingIndicatorEl.style.display = "none";
      loadingIndicatorEl.style.opacity = "";
    }, 300);
  }, 500);

  // Refresh search if active
  if (searchOpen && searchQuery) performSearch(searchQuery);
}

// ─── Manage Pages DOM ────────────────────────────────────────────────────────

const modeTabsEl = $("mode-tabs");
const modeViewBtn = $("mode-view-btn") as HTMLButtonElement;
const modeManageBtn = $("mode-manage-btn") as HTMLButtonElement;
const modeSignBtn = $("mode-sign-btn") as HTMLButtonElement;
const managePanelEl = $("manage-panel");
const signPanelEl = $("sign-panel");
const signPanelStatusEl = $("sign-panel-status");
const signPanelListEl = $("sign-panel-list");
const signZoneCountEl = $("sign-zone-count");
const signPanelWorkingCopyEl = $("sign-panel-working-copy");
const signPanelWorkingCopyPathEl = $("sign-panel-working-copy-path");
const signPanelWorkingCopyRevealBtn = $("sign-panel-working-copy-reveal") as HTMLButtonElement;
const signPanelWorkingCopyCopyBtn = $("sign-panel-working-copy-copy") as HTMLButtonElement;
const signModalEl = $("sign-modal");
const signModalDocEl = $("sign-modal-doc");
const signModalZoneEl = $("sign-modal-zone");
const signModalTypeRowEl = $("sign-modal-type-row");
const signModalTypeEl = $("sign-modal-type") as HTMLSelectElement;
const signModalNameEl = $("sign-modal-name") as HTMLInputElement;
const signModalExistingEl = $("sign-modal-existing") as HTMLSelectElement;
const signModalExistingRowEl = $("sign-modal-existing-row");
const signModalStatementEl = $("sign-modal-statement");
const signModalErrorEl = $("sign-modal-error");
const signModalCancelBtn = $("sign-modal-cancel") as HTMLButtonElement;
const signModalConfirmBtn = $("sign-modal-confirm") as HTMLButtonElement;
const signModalCloseBtn = $("sign-modal-close") as HTMLButtonElement;
const signModalTitleEl = $("sign-modal-title");
const signModalNameLabelEl = $("sign-modal-name-label");
const signModalIdentityRowsEl = $("sign-modal-identity-rows");
const signModalDateRowEl = $("sign-modal-date-row");
const signModalDateInputEl = $("sign-modal-date") as HTMLInputElement;
const signPanelDrawBtn = $("sign-panel-draw-btn") as HTMLButtonElement;
const signPanelInspectBtn = $("sign-panel-inspect-btn") as HTMLButtonElement;
const drawModalEl = $("draw-modal");
const drawCanvasEl = $("draw-canvas") as HTMLCanvasElement;
const drawNameInputEl = $("draw-name-input") as HTMLInputElement;
const drawLegalNameInputEl = $("draw-legal-name-input") as HTMLInputElement;
const drawUndoBtn = $("draw-undo-btn") as HTMLButtonElement;
const drawClearBtn = $("draw-clear-btn") as HTMLButtonElement;
const drawSaveBtn = $("draw-modal-save") as HTMLButtonElement;
const drawCancelBtn = $("draw-modal-cancel") as HTMLButtonElement;
const drawCloseBtn = $("draw-modal-close") as HTMLButtonElement;
const drawErrorEl = $("draw-modal-error");
const regionPreviewModalEl = $("region-preview-modal");
const regionPreviewDocEl = $("region-preview-doc");
const regionPreviewCoordsEl = $("region-preview-coords");
const regionPreviewZoneTypeEl = $("region-preview-zone-type") as HTMLSelectElement;
const regionPreviewImageEl = $("region-preview-image") as HTMLImageElement;
const regionPreviewCopyBtn = $("region-preview-copy") as HTMLButtonElement;
const regionPreviewCreateZoneBtn = $("region-preview-create-zone") as HTMLButtonElement;
const regionPreviewDoneBtn = $("region-preview-done") as HTMLButtonElement;
const regionPreviewCloseBtn = $("region-preview-close") as HTMLButtonElement;
const manageGridEl = $("manage-grid");
const manageStatusEl = $("manage-status");
const manageRotateCwBtn = $("manage-rotate-cw") as HTMLButtonElement;
const manageRotateCcwBtn = $("manage-rotate-ccw") as HTMLButtonElement;
const manageDeleteBtn = $("manage-delete") as HTMLButtonElement;
const manageResetBtn = $("manage-reset") as HTMLButtonElement;
const manageApplyBtn = $("manage-apply") as HTMLButtonElement;

const modalElements = [signModalEl, drawModalEl, regionPreviewModalEl];
interface ModalFocusReturn {
  element: HTMLElement;
  zoneKey: string | null;
  zoneControl: string | null;
}
const modalPreviousFocus = new WeakMap<HTMLElement, ModalFocusReturn>();
const MODAL_FOCUSABLE_SELECTOR = [
  "button:not([disabled])",
  "input:not([disabled])",
  "select:not([disabled])",
  "textarea:not([disabled])",
  "a[href]",
  "[tabindex]:not([tabindex='-1'])",
].join(",");

function getModalFocusableElements(modal: HTMLElement) {
  return Array.from(modal.querySelectorAll<HTMLElement>(MODAL_FOCUSABLE_SELECTOR))
    .filter(el => el.getClientRects().length > 0 && getComputedStyle(el).visibility !== "hidden");
}

function setViewerModalInert() {
  viewerEl.toggleAttribute("inert", modalElements.some(modal => modal.style.display === "flex"));
}

function isVisibleFocusTarget(element: HTMLElement | null): element is HTMLElement {
  return !!element?.isConnected &&
    element.matches(MODAL_FOCUSABLE_SELECTOR) &&
    element.getClientRects().length > 0 &&
    getComputedStyle(element).visibility !== "hidden" &&
    !(element instanceof HTMLButtonElement && element.disabled);
}

function findZoneRowByKey(key: string) {
  return Array.from(signPanelListEl.querySelectorAll<HTMLElement>(".sign-panel-item"))
    .find(item => item.dataset.zoneKey === key) ?? null;
}

function findZoneControl(row: HTMLElement | null, control: string | null) {
  if (!row || !control) return null;
  return Array.from(row.querySelectorAll<HTMLElement>("[data-zone-control]"))
    .find(element => element.dataset.zoneControl === control) ?? null;
}

function findVisibleModalFallback(modal: HTMLElement) {
  const candidates = modal === regionPreviewModalEl
    ? [signPanelInspectBtn, signPanelDrawBtn, modeSignBtn]
    : modal === signModalEl
      ? [signPanelDrawBtn, signPanelInspectBtn, modeSignBtn]
      : [];
  return candidates
    .find(isVisibleFocusTarget) ?? null;
}

function openModal(modal: HTMLElement, initialFocus: HTMLElement) {
  const active = document.activeElement;
  if (active instanceof HTMLElement && !modal.contains(active)) {
    const zoneRow = active.closest<HTMLElement>("[data-zone-key]");
    modalPreviousFocus.set(modal, {
      element: active,
      zoneKey: zoneRow?.dataset.zoneKey ?? null,
      zoneControl: active.dataset.zoneControl ?? null,
    });
  }
  modal.style.display = "flex";
  setViewerModalInert();
  setTimeout(() => {
    if (modal.style.display === "flex") initialFocus.focus();
  }, 20);
}

function closeModal(modal: HTMLElement) {
  modal.style.display = "none";
  setViewerModalInert();
  const previousFocus = modalPreviousFocus.get(modal) ?? null;
  modalPreviousFocus.delete(modal);
  const replacementZone = previousFocus?.zoneKey
    ? findZoneRowByKey(previousFocus.zoneKey)
    : null;
  const replacementControl = findZoneControl(replacementZone, previousFocus?.zoneControl ?? null);
  const focusTarget = isVisibleFocusTarget(previousFocus?.element ?? null)
    ? previousFocus!.element
    : isVisibleFocusTarget(replacementControl)
      ? replacementControl
      : isVisibleFocusTarget(replacementZone)
        ? replacementZone
        : findVisibleModalFallback(modal);
  focusTarget?.focus();
}

function trapModalFocus(modal: HTMLElement, event: KeyboardEvent) {
  if (event.key !== "Tab") return;
  const focusable = getModalFocusableElements(modal);
  if (focusable.length === 0) {
    event.preventDefault();
    return;
  }
  const currentIndex = focusable.indexOf(document.activeElement as HTMLElement);
  const nextIndex = getWrappedFocusIndex(currentIndex, focusable.length, event.shiftKey);
  event.preventDefault();
  focusable[nextIndex].focus();
}

// ─── Manage Pages Logic ─────────────────────────────────────────────────────

function initPageStates() {
  pageStates = [];
  for (let i = 1; i <= totalPages; i++) {
    pageStates.push({
      originalIndex: i,
      rotation: 0,
      deleted: false,
      selected: false,
      thumbnailDataUrl: null,
    });
  }
  hasUnsavedChanges = false;
}

// ─── Signature zones (Sign mode) ─────────────────────────────────────────────

async function fetchSignatureZones(force = false) {
  if (isTearingDown) return;
  const lifecycle = captureViewerLifecycle();
  const requestedPath = pdfPath;
  if (!requestedPath) return;
  // If we already have zones cached for this exact file, reuse them — don't
  // throw away the user's ✓ Signed flags on every mode toggle.
  if (!force && zoneRequests.hasValue(requestedPath)) {
    if (pdfPath === requestedPath) {
      signatureZones = zoneRequests.getValue(requestedPath)!;
      renderSignPanel();
      renderZoneOverlay();
    }
    return;
  }
  // Guard against multiple concurrent fetches for the same file
  if (zoneRequests.isLoading(requestedPath)) return;
  const request = zoneRequests.begin(requestedPath);
  if (pdfPath === requestedPath) renderSignPanel();

  try {
    const result = await callServerToolDuringLifecycle({
      name: "detect_signature_zones",
      arguments: { pdf_path: requestedPath },
    }, lifecycle);
    assertViewerLifecycle(lifecycle);
    if (result.isError) {
      const text = result.content?.map((c: any) => ("text" in c ? c.text : "")).join(" ") || "Unknown error";
      throw new Error(text);
    }
    const sc = result.structuredContent as {
      zones?: SignatureZone[];
      warnings?: ZoneDetectionWarning[];
      page_geometry?: PageGeometry[];
    } | undefined;
    zoneWarningsByPath.set(requestedPath, sc?.warnings ?? []);
    // Zones are measured against each page's MediaBox, which PDF.js does not
    // expose, so retain the geometry that came with them.
    pageGeometryByPage.clear();
    for (const geometry of sc?.page_geometry ?? []) {
      pageGeometryByPage.set(geometry.page, geometry);
    }
    const zones = (sc?.zones ?? []).map((z, i) => ({
      ...z,
      id: `zone-${i}`,
      // Carry forward the applied flag if we've stamped this same zone before.
      // Key is stable across re-fetches: requested path + type + page + rounded coords.
      applied: appliedZoneKeys.has(zoneKey(requestedPath, z)),
    }));
    if (zoneRequests.succeedForCurrent(request, pdfPath, zones)) {
      signatureZones = zones;
    }
  } catch (err: any) {
    if (isViewerLifecycleEnded(err)) return;
    console.error("[viewer] detect_signature_zones failed:", err);
    if (zoneRequests.failForCurrent(request, pdfPath, err?.message ?? String(err))) {
      signatureZones = [];
      zoneWarningsByPath.delete(requestedPath);
    }
  } finally {
    if (!isTearingDown && lifecycle === viewerLifecycleEpoch && zoneRequests.finishForCurrent(request, pdfPath)) {
      renderSignPanel();
      renderZoneOverlay();
    }
  }
}

function clearZoneOverlay() {
  // Preserve an in-progress drag draft so zoom / re-render during a drag
  // doesn't cancel the user's drag gesture (Phase B review B2).
  const preserve = activeDrag?.draftEl;
  const children = Array.from(zoneLayerEl.children);
  for (const child of children) {
    if (child !== preserve) zoneLayerEl.removeChild(child);
  }
}

function getSavedSignatureByName(name: string) {
  return signaturePreviewCache.get(name) || savedSignatures.find(sig => sig.name === name) || null;
}

function updateZonePreviewState() {
  if (!activeSignZone || signModalEl.style.display !== "flex") {
    activeZonePreview = null;
    renderZoneOverlay();
    return;
  }

  if (activeModalMode === "date" || activeModalMode === "name") {
    const value = activeModalMode === "date"
      ? signModalDateInputEl.value
      : signModalNameEl.value.trim();
    activeZonePreview = value ? {
      zoneId: activeSignZone.id || "",
      mode: activeModalMode,
      text: value,
    } : null;
    renderZoneOverlay();
    return;
  }

  const existing = signModalExistingEl.value;
  const name = signModalNameEl.value.trim();
  const saved = existing ? getSavedSignatureByName(existing) : null;
  if (saved?.preview_data_url) {
    activeZonePreview = {
      zoneId: activeSignZone.id || "",
      mode: activeModalMode,
      imageDataUrl: saved.preview_data_url,
      displayName: saved.display_name || name || saved.name,
    };
  } else if (name) {
    activeZonePreview = {
      zoneId: activeSignZone.id || "",
      mode: activeModalMode,
      text: name,
      displayName: name,
    };
  } else {
    activeZonePreview = null;
  }
  renderZoneOverlay();
}

function buildZonePreviewGhost(zone: SignatureZone) {
  if (!activeZonePreview || activeZonePreview.zoneId !== (zone.id || "") || zone.applied) return null;

  const ghost = document.createElement("div");
  ghost.className = "sig-zone-preview-ghost";
  placeZoneContentInNativeBox(ghost, zone);

  if (activeZonePreview.imageDataUrl) {
    const img = document.createElement("img");
    img.className = "sig-zone-preview-image";
    img.src = activeZonePreview.imageDataUrl;
    img.alt = activeZonePreview.displayName || "Signature preview";
    ghost.appendChild(img);
    return ghost;
  }

  if (activeZonePreview.text) {
    const text = document.createElement("div");
    text.className = `sig-zone-preview-text ${activeZonePreview.mode}`;
    text.textContent = activeZonePreview.text;
    const widthPx = zone.width * scale;
    const heightPx = zone.height * scale;
    const estimated = widthPx / Math.max(activeZonePreview.text.length * 0.58, 1);
    const fontSize = Math.max(
      9,
      Math.min(["date", "name"].includes(activeZonePreview.mode) ? 18 : 30, heightPx * 0.72, estimated)
    );
    text.style.fontSize = `${fontSize}px`;
    ghost.appendChild(text);
    return ghost;
  }

  return null;
}

/**
 * The page box zone coordinates are measured against.
 *
 * Zones arrive as top-left origin points relative to the page MediaBox. PDF.js
 * exposes only the view (CropBox intersected with MediaBox) through
 * viewport.viewBox, so on a page whose CropBox differs from its MediaBox the
 * viewer cannot reconstruct the right box on its own. The server therefore
 * sends page_geometry with detect_signature_zones and it is preferred here.
 *
 * The viewBox fallback covers early-load states before geometry has arrived.
 * It is correct only when the two boxes coincide, which is why it is a fallback
 * rather than the source of truth.
 */
function currentPageBox(): PageBox {
  return resolvePageBox(
    pageGeometryByPage.get(currentPage),
    currentViewport?.viewBox,
    canvasEl.height / (window.devicePixelRatio || 1) / scale,
  );
}

function currentNativePageHeight(): number {
  return currentPageBox().height;
}

function currentPageRotation(): number {
  const rotation = Number(currentViewport?.rotation ?? 0) % 360;
  return rotation < 0 ? rotation + 360 : rotation;
}

function nativeRectToViewportRect(rect: Pick<SignatureZone, "x" | "y" | "width" | "height">) {
  if (!currentViewport?.convertToViewportRectangle) {
    return {
      left: rect.x * scale,
      top: rect.y * scale,
      width: rect.width * scale,
      height: rect.height * scale,
    };
  }

  // convertToViewportRectangle expects ABSOLUTE user-space coordinates, so the
  // page box origin has to be added back after the top-left flip. Omitting it
  // displaced every overlay by the box origin.
  const pdfRect = zoneToPdfRect(rect, currentPageBox());
  const viewportRect = currentViewport.convertToViewportRectangle(pdfRect);
  const [x1, y1, x2, y2] = viewportRect;
  return {
    left: Math.min(x1, x2),
    top: Math.min(y1, y2),
    width: Math.abs(x2 - x1),
    height: Math.abs(y2 - y1),
  };
}

function placeElementAtViewportRect(
  el: HTMLElement,
  rect: { left: number; top: number; width: number; height: number },
) {
  el.style.left = `${rect.left}px`;
  el.style.top = `${rect.top}px`;
  el.style.width = `${rect.width}px`;
  el.style.height = `${rect.height}px`;
}

function placeZoneContentInNativeBox(
  el: HTMLElement,
  zone: SignatureZone,
  { fitBox = true }: { fitBox?: boolean } = {},
) {
  const rotation = currentPageRotation();
  el.style.position = "absolute";
  el.style.inset = "auto";
  el.style.left = "50%";
  el.style.top = "50%";
  el.style.maxWidth = `${zone.width * scale}px`;
  if (fitBox) {
    el.style.width = `${zone.width * scale}px`;
    el.style.height = `${zone.height * scale}px`;
    el.style.display = "flex";
    el.style.alignItems = "center";
    el.style.justifyContent = "center";
  }
  el.style.transformOrigin = "center center";
  el.style.transform = `translate(-50%, -50%) rotate(${rotation}deg)`;
}

function renderZoneOverlay() {
  clearZoneOverlay();
  if (manageMode !== "sign") return;
  if (!pdfDocument) return;
  if (!currentViewport) return;
  if (currentViewportPage !== currentPage) return;

  // Size overlay to match canvas
  zoneLayerEl.style.width = canvasEl.style.width;
  zoneLayerEl.style.height = canvasEl.style.height;

  // If scale changed mid-drag, update the draft rectangle so it stays
  // visually consistent with the new zoom.
  if (activeDrag) updateDraftRectangle();

  const pageZones = signatureZones.filter(z => z.page === currentPage);
  for (const z of pageZones) {
    const el = document.createElement("div");
    el.className = "sig-zone";
    el.dataset.type = z.type;
    el.dataset.zoneId = z.id || "";
    if (z.applied) {
      el.dataset.applied = "true";
      // Badge default is floated above the zone (-16px). If the zone is near
      // the top of the page, it'd be clipped off-canvas — dock it inside
      // instead. Threshold: zone top is within 20 CSS px of canvas top.
      if (nativeRectToViewportRect(z).top < 20) el.dataset.labelPlacement = "inside";
    }
    // Zone coords are native top-left PDF points. Map them through PDF.js'
    // viewport so overlays track rotated pages exactly like the canvas does.
    placeElementAtViewportRect(el, nativeRectToViewportRect(z));
    el.title = `${z.label} (conf ${(z.confidence * 100).toFixed(0)}%)`;

    if (z.width * scale > 48) {
      const label = document.createElement("span");
      label.className = "sig-zone-label";
      if (z.applied) {
        // For date zones, surface the actual value that was stamped; for
        // signatures/initials the canvas now shows the stamp itself, so a
        // compact "✓ Signed / Initialed" badge is the most useful hint.
        if ((z.type === "date" || z.type === "name") && z.appliedValue) {
          label.textContent = `✓ ${z.appliedValue}`;
        } else if (z.type === "initials") {
          label.textContent = "✓ Initialed";
        } else {
          label.textContent = "✓ Signed";
        }
        placeZoneContentInNativeBox(label, z, { fitBox: false });
      } else {
        label.textContent = z.type === "signature" ? "Sign here" :
                            z.type === "initials"  ? "Initials" :
                            z.type === "name" ? "Print name" : "Date";
        placeZoneContentInNativeBox(label, z);
      }
      el.appendChild(label);
    }

    const previewGhost = buildZonePreviewGhost(z);
    if (previewGhost) {
      el.appendChild(previewGhost);
    }

    // Applied zones are inert — no click handler, no pointer events (CSS handles cursor).
    if (!z.applied) {
      el.addEventListener("click", () => onZoneClick(z));
    }

    // User-created zones get a ✕ delete button in the corner (detected zones
    // aren't deletable — removing them would mask the form's real sign-here
    // spots). Zones already signed skip the delete too (audit-trail risk).
    if (z.source === "user-drag" && !z.applied) {
      const del = document.createElement("button");
      del.className = "sig-zone-delete";
      del.type = "button";
      del.setAttribute("aria-label", "Delete this custom zone");
      del.title = "Remove this zone";
      del.textContent = "✕";
      del.addEventListener("click", (ev) => {
        ev.stopPropagation();
        deleteCustomZone(z);
      });
      el.appendChild(del);
    }
    zoneLayerEl.appendChild(el);
  }
}

function deleteCustomZone(zone: SignatureZone) {
  const idx = signatureZones.indexOf(zone);
  if (idx < 0) return;
  signatureZones.splice(idx, 1);
  renderZoneOverlay();
  renderSignPanel();
}

function onZoneClick(zone: SignatureZone) {
  if (zone.applied) return; // already signed
  openSignModal(zone);
}

// ─── Drag-to-create custom zone (Sign mode) ──────────────────────────────────

interface DragState {
  // Start position stored in PDF points (native, scale-invariant) — so that
  // mid-drag zoom doesn't skew the resulting zone (Phase B review B1).
  startXpts: number;
  startYpts: number;
  currentXpts: number;
  currentYpts: number;
  pointerId: number;
  draftEl: HTMLElement;
}
let activeDrag: DragState | null = null;
// Raised from 20×10 to 60×15 — the old threshold was so low that casual clicks
// with any mouse jitter produced stray zones, which then cluttered the PDF.
// 60×15 still accepts a clearly-intentional drag (most signature lines are
// 150pt+ wide) while filtering out accidental pointer twitches.
const MIN_CUSTOM_ZONE_WIDTH = 60;
const MIN_CUSTOM_ZONE_HEIGHT = 15;
const MIN_INSPECT_REGION_WIDTH = 12;
const MIN_INSPECT_REGION_HEIGHT = 12;

function getZoneLayerPointerPoints(e: PointerEvent): [number, number] {
  const rect = zoneLayerEl.getBoundingClientRect();
  const x = e.clientX - rect.left;
  const y = e.clientY - rect.top;
  if (currentViewport?.convertToPdfPoint && currentViewportPage === currentPage) {
    // convertToPdfPoint returns ABSOLUTE user space, so the origin has to come
    // back off to land in the box-relative space zones are expressed in. This
    // is the inverse of nativeRectToViewportRect and must move with it: fixing
    // only one direction leaves drawing and reading disagreeing.
    const [pdfX, pdfY] = currentViewport.convertToPdfPoint(x, y);
    return pdfPointToZonePoint(pdfX, pdfY, currentPageBox());
  }
  // Fallback for early-load states before PDF.js exposes a viewport.
  return [x / scale, y / scale];
}

function updateDraftRectangle() {
  if (!activeDrag) return;
  const xPts = Math.min(activeDrag.startXpts, activeDrag.currentXpts);
  const yPts = Math.min(activeDrag.startYpts, activeDrag.currentYpts);
  const widthPts = Math.abs(activeDrag.currentXpts - activeDrag.startXpts);
  const heightPts = Math.abs(activeDrag.currentYpts - activeDrag.startYpts);
  placeElementAtViewportRect(
    activeDrag.draftEl,
    nativeRectToViewportRect({ x: xPts, y: yPts, width: widthPts, height: heightPts }),
  );
}

function onZoneLayerPointerDown(e: PointerEvent) {
  if (manageMode !== "sign") return;
  // Only primary button / primary pointer — ignore secondary touches and right-clicks.
  if (!e.isPrimary) return;
  if (e.button !== 0 && (e.pointerType === "mouse" || e.pointerType === "pen")) return;
  // If the target is a sig-zone or its descendant, let the zone's own handler take it.
  if ((e.target as HTMLElement).closest(".sig-zone")) return;
  e.preventDefault();

  const [xPts, yPts] = getZoneLayerPointerPoints(e);
  const draft = document.createElement("div");
  draft.className = "sig-zone-draft";
  zoneLayerEl.appendChild(draft);

  activeDrag = {
    startXpts: xPts, startYpts: yPts,
    currentXpts: xPts, currentYpts: yPts,
    pointerId: e.pointerId,
    draftEl: draft,
  };
  updateDraftRectangle();
  zoneLayerEl.classList.add("dragging");
  try { zoneLayerEl.setPointerCapture(e.pointerId); } catch { /* ignore */ }
}

function onZoneLayerPointerMove(e: PointerEvent) {
  if (!activeDrag || e.pointerId !== activeDrag.pointerId) return;
  const [xPts, yPts] = getZoneLayerPointerPoints(e);
  activeDrag.currentXpts = xPts;
  activeDrag.currentYpts = yPts;
  updateDraftRectangle();
}

function onZoneLayerPointerUp(e: PointerEvent) {
  if (!activeDrag || e.pointerId !== activeDrag.pointerId) return;
  try { zoneLayerEl.releasePointerCapture(e.pointerId); } catch { /* ignore */ }

  // Final bbox in PDF points — scale-invariant regardless of mid-drag zoom.
  const xPts = Math.min(activeDrag.startXpts, activeDrag.currentXpts);
  const yPts = Math.min(activeDrag.startYpts, activeDrag.currentYpts);
  const widthPts = Math.abs(activeDrag.currentXpts - activeDrag.startXpts);
  const heightPts = Math.abs(activeDrag.currentYpts - activeDrag.startYpts);

  try { activeDrag.draftEl.remove(); } catch { /* may already be detached */ }
  activeDrag = null;
  zoneLayerEl.classList.remove("dragging");

  const minWidth = inspectRegionArmed ? MIN_INSPECT_REGION_WIDTH : MIN_CUSTOM_ZONE_WIDTH;
  const minHeight = inspectRegionArmed ? MIN_INSPECT_REGION_HEIGHT : MIN_CUSTOM_ZONE_HEIGHT;
  if (widthPts < minWidth || heightPts < minHeight) {
    return; // too small — stray click, don't create a zone
  }

  if (inspectRegionArmed) {
    inspectRegionSelection({
      page: currentPage,
      x: xPts, y: yPts,
      width: widthPts, height: heightPts,
    });
    return;
  }

  const newZone: SignatureZone = {
    type: "signature",
    label: "Custom zone",
    page: currentPage,
    x: xPts, y: yPts,
    width: widthPts, height: heightPts,
    confidence: 1.0,
    source: "user-drag",
    id: `zone-custom-${Date.now()}`,
    applied: false,
  };
  signatureZones.push(newZone);
  renderZoneOverlay();
  renderSignPanel();
  openSignModal(newZone);
}

function onZoneLayerPointerCancel(e: PointerEvent) {
  if (!activeDrag || e.pointerId !== activeDrag.pointerId) return;
  try { activeDrag.draftEl.remove(); } catch { /* ignore */ }
  activeDrag = null;
  zoneLayerEl.classList.remove("dragging");
}

// ─── Confirm modal ───────────────────────────────────────────────────────────

type SignModalMode = "signature" | "initials" | "name" | "date";

let activeSignZone: SignatureZone | null = null;
let activeModalMode: SignModalMode = "signature";
let signingInFlight = false;

// Per-mode copy + layout configuration. Centralized so we don't scatter
// "is it a date?" branches across the codebase.
const MODAL_MODE_CONFIG: Record<SignModalMode, {
  title: string;
  buttonLabel: string;
  signingLabel: string;
  showIdentity: boolean;
  showSavedSignatures: boolean;
  showDate: boolean;
  nameLabel: string;
  verb: string;
  attestationHeading: string;
  attestationEmpty: string;
}> = {
  signature: {
    title: "Confirm signature",
    buttonLabel: "Sign",
    signingLabel: "Signing…",
    showIdentity: true,
    showSavedSignatures: true,
    showDate: false,
    nameLabel: "Type your full name",
    verb: "sign",
    attestationHeading: "You are attesting:",
    attestationEmpty: "Type your name above to see the attestation.",
  },
  initials: {
    title: "Confirm initials",
    buttonLabel: "Stamp initials",
    signingLabel: "Stamping…",
    showIdentity: true,
    showSavedSignatures: true,
    showDate: false,
    nameLabel: "Type your full name — we'll stamp it compressed to fit the initials box. For a proper \"M.S.\"-style asset, use \"Draw signature\" first and pick it from the dropdown.",
    verb: "initial",
    attestationHeading: "You are attesting:",
    attestationEmpty: "Type your name above to see the attestation.",
  },
  date: {
    title: "Insert date",
    buttonLabel: "Insert date",
    signingLabel: "Stamping…",
    showIdentity: false,
    showSavedSignatures: false,
    showDate: true,
    nameLabel: "",
    verb: "",
    attestationHeading: "You are inserting:",
    attestationEmpty: "Pick a date above.",
  },
  name: {
    title: "Insert printed name",
    buttonLabel: "Insert name",
    signingLabel: "Stamping…",
    showIdentity: true,
    showSavedSignatures: false,
    showDate: false,
    nameLabel: "Name to insert",
    verb: "",
    attestationHeading: "You are inserting:",
    attestationEmpty: "Type the name to insert above.",
  },
};

function modeForZoneType(type: SignatureZone["type"]): SignModalMode {
  // Exhaustive guard — if detection evolves to emit a new type (e.g. "name"),
  // fail loudly rather than silently falling back to signature mode (Phase B2
  // review F3). Cast to string so TS doesn't narrow us away from the check.
  const t = type as string;
  if (t === "signature") return "signature";
  if (t === "initials") return "initials";
  if (t === "name") return "name";
  if (t === "date") return "date";
  throw new Error(`Unknown zone type "${t}" — viewer doesn't know how to sign it. Update modeForZoneType.`);
}

function applyModalMode(mode: SignModalMode) {
  const cfg = MODAL_MODE_CONFIG[mode];
  signModalTitleEl.textContent = cfg.title;
  signModalConfirmBtn.textContent = cfg.buttonLabel;
  signModalNameLabelEl.textContent = cfg.nameLabel;
  signModalIdentityRowsEl.style.display = cfg.showIdentity ? "" : "none";
  signModalExistingRowEl.style.display = cfg.showSavedSignatures ? "flex" : "none";
  signModalDateRowEl.style.display = cfg.showDate ? "flex" : "none";
  const heading = document.getElementById("sign-modal-attestation-heading");
  if (heading) heading.textContent = cfg.attestationHeading;
}

function refreshActiveZoneCopy() {
  if (!activeSignZone) return;
  signModalZoneEl.textContent = `${activeSignZone.type} on page ${activeSignZone.page} — ${activeSignZone.label}`;
}

async function openSignModal(zone: SignatureZone) {
  // Guard: if a sign is already underway, don't swap the active zone (Phase B review B4).
  if (signingInFlight || isTearingDown) return;
  const lifecycle = captureViewerLifecycle();
  setInspectRegionArmed(false);
  activeSignZone = zone;
  activeZoneOriginalType = zone.source === "user-drag" ? zone.type : null;
  activeModalMode = modeForZoneType(zone.type);
  signModalTypeRowEl.style.display = zone.source === "user-drag" ? "flex" : "none";
  signModalTypeEl.value = zone.type;
  applyModalMode(activeModalMode);

  signModalErrorEl.style.display = "none";
  signModalErrorEl.textContent = "";

  // Populate readonly fields
  const baseName = pdfPath.split(/[\/\\]/).pop() || "document.pdf";
  signModalDocEl.textContent = baseName;
  refreshActiveZoneCopy();

  // Reset inputs per mode
  signModalNameEl.value = "";
  delete signModalNameEl.dataset.autofilledFrom;
  signModalExistingEl.selectedIndex = 0;
  if (activeModalMode === "date") {
    // Default to today's date
    signModalDateInputEl.value = localDateString();
  }
  signModalConfirmBtn.disabled = true;
  updateStatementPreview();

  // Load saved signatures only when identity fields are visible
  if (activeModalMode === "signature" || activeModalMode === "initials") {
    await populateSavedSignatures();
    if (!isViewerLifecycleCurrent(lifecycle)) return;
  }

  // Show modal + focus the right field
  updateZonePreviewState();
  openModal(signModalEl, activeModalMode === "date" ? signModalDateInputEl : signModalNameEl);
}

function closeSignModal(revertCustomType = true) {
  if (revertCustomType && activeSignZone?.source === "user-drag" && activeZoneOriginalType && activeSignZone.type !== activeZoneOriginalType) {
    activeSignZone.type = activeZoneOriginalType;
    renderSignPanel();
    renderZoneOverlay();
  }
  closeModal(signModalEl);
  activeZonePreview = null;
  activeSignZone = null;
  activeZoneOriginalType = null;
  signModalErrorEl.style.display = "none";
  renderZoneOverlay();
}

function setSignModalControlsLocked(locked: boolean) {
  signModalTypeEl.disabled = locked;
  signModalNameEl.disabled = locked;
  signModalExistingEl.disabled = locked;
  signModalDateInputEl.disabled = locked;
  signModalCancelBtn.disabled = locked;
  signModalCloseBtn.disabled = locked;
}

function requestCloseSignModal() {
  if (signingInFlight) return;
  closeSignModal();
}

async function populateSavedSignatures() {
  if (isTearingDown) return;
  const lifecycle = captureViewerLifecycle();
  // Clear all but the default option
  while (signModalExistingEl.options.length > 1) signModalExistingEl.remove(1);
  try {
    const result = await callServerToolDuringLifecycle({
      name: "list_signatures",
      arguments: {},
    }, lifecycle);
    assertViewerLifecycle(lifecycle);
    if (result.isError) {
      savedSignatures = [];
      return;
    }
    const sc = result.structuredContent as { signatures?: SavedSignatureSummary[] } | undefined;
    const sigs = sc?.signatures ?? [];
    savedSignatures = sigs;
    signaturePreviewCache.clear();
    for (const s of sigs) {
      const opt = document.createElement("option");
      opt.value = s.name;
      // Stash display_name so the selector can auto-fill the typed-name field
      // when the user picks a saved signature (avoids the "sign button stays greyed" trap).
      opt.dataset.displayName = s.display_name ?? "";
      const displayPart = s.display_name ? ` — ${s.display_name}` : "";
      opt.textContent = `${s.name} (${s.style}${displayPart})`;
      signModalExistingEl.appendChild(opt);
    }
  } catch (err) {
    if (!isViewerLifecycleEnded(err)) {
      console.warn("[viewer] list_signatures failed (modal still usable):", err);
      savedSignatures = [];
    }
  }
}

async function ensureSavedSignaturePreview(signatureName: string) {
  if (isTearingDown) throw new ViewerLifecycleEndedError();
  const lifecycle = captureViewerLifecycle();
  if (!signatureName) return null;
  const cached = signaturePreviewCache.get(signatureName);
  if (cached?.preview_data_url || cached?.style === "typed") return cached;

  const result = await callServerToolDuringLifecycle({
    name: "load_signature",
    arguments: { signature_name: signatureName },
  }, lifecycle);
  assertViewerLifecycle(lifecycle);
  if (result.isError) {
    const text = result.content?.map((c: any) => ("text" in c ? c.text : "")).join(" ") || "load_signature failed";
    throw new Error(text);
  }
  const sc = result.structuredContent as SavedSignatureSummary | undefined;
  if (!sc) return null;
  signaturePreviewCache.set(signatureName, sc);
  return sc;
}

// When the user picks a saved signature, auto-fill the typed-name field from
// the signature's display_name so the attestation preview + Sign button are
// immediately usable — no "why is this still greyed out?" moment.
async function onSavedSignatureChange() {
  if (isTearingDown) return;
  const lifecycle = captureViewerLifecycle();
  const opt = signModalExistingEl.selectedOptions[0];
  if (!opt) return;
  const displayName = opt.dataset.displayName || "";
  // Only overwrite the name field if it's empty OR still matches a previous
  // display-name auto-fill (don't trample user input).
  const current = signModalNameEl.value.trim();
  if (!current || current === signModalNameEl.dataset.autofilledFrom) {
    signModalNameEl.value = displayName;
    signModalNameEl.dataset.autofilledFrom = displayName;
  }
  try {
    if (opt.value) {
      await ensureSavedSignaturePreview(opt.value);
      assertViewerLifecycle(lifecycle);
    }
  } catch (err) {
    if (isViewerLifecycleEnded(err)) return;
    console.warn("[viewer] load_signature failed (preview omitted):", err);
  }
  if (!isViewerLifecycleCurrent(lifecycle)) return;
  updateStatementPreview();
  updateZonePreviewState();
}

function onCustomZoneTypeChange() {
  if (signingInFlight) return;
  if (!activeSignZone || activeSignZone.source !== "user-drag") return;
  const nextType = signModalTypeEl.value as SignatureZone["type"];
  activeSignZone.type = nextType;
  activeModalMode = modeForZoneType(nextType);
  applyModalMode(activeModalMode);
  refreshActiveZoneCopy();
  if (activeModalMode === "date" && !signModalDateInputEl.value) {
    signModalDateInputEl.value = localDateString();
  }
  renderSignPanel();
  updateStatementPreview();
}

// A "meaningful" name has ≥3 alphanumeric characters. Rejects 2-char
// placeholders ("XY"), pure punctuation (".."), and zero-width junk.
// Server's validateSigningIntent enforces an 8-char floor on the full
// statement, which is trivially padded by the boilerplate ("I, {name}, sign
// {filename} on {date}."), so the real defense has to happen here (Phase B B5).
function isMeaningfulName(name: string): boolean {
  const alnum = name.replace(/[^\p{L}\p{N}]/gu, "");
  return alnum.length >= 3;
}

function updateStatementPreview() {
  const cfg = MODAL_MODE_CONFIG[activeModalMode];
  const baseName = (pdfPath.split(/[\/\\]/).pop() || "this document");

  if (activeModalMode === "date") {
    const picked = signModalDateInputEl.value;
    if (!picked) {
      signModalStatementEl.textContent = cfg.attestationEmpty;
      signModalStatementEl.classList.add("empty");
      signModalConfirmBtn.disabled = true;
      return;
    }
    signModalStatementEl.textContent = `Stamping "${picked}" at this location on ${baseName}.`;
    signModalStatementEl.classList.remove("empty");
    signModalConfirmBtn.disabled = false;
    updateZonePreviewState();
    return;
  }
  if (activeModalMode === "name") {
    const name = signModalNameEl.value.trim();
    signModalStatementEl.textContent = name
      ? `Stamping "${name}" at this location on ${baseName}.`
      : cfg.attestationEmpty;
    signModalStatementEl.classList.toggle("empty", !name);
    signModalConfirmBtn.disabled = !name;
    updateZonePreviewState();
    return;
  }

  // signature + initials share identity-based flow
  const name = signModalNameEl.value.trim();
  const existing = signModalExistingEl.value;
  const today = localDateString();

  if (!name) {
    if (existing) {
      // User picked a saved sig but that sig has no display_name (image sigs
      // drawn in older versions, mostly). Be specific about why we still need
      // a typed name.
      const opt = signModalExistingEl.selectedOptions[0];
      const savedHasName = !!(opt?.dataset.displayName);
      signModalStatementEl.textContent = savedHasName
        ? `Pick a saved signature above or type your name — the attestation must reference you.`
        : `This saved signature doesn't have a legal name saved — type yours above to finish the attestation. (Tip: when drawing a signature, fill in "Your full legal name" so this isn't needed every time.)`;
    } else {
      signModalStatementEl.textContent = cfg.attestationEmpty;
    }
    signModalStatementEl.classList.add("empty");
    signModalConfirmBtn.disabled = true;
    updateZonePreviewState();
    return;
  }

  signModalStatementEl.textContent = `I, ${name}, ${cfg.verb} ${baseName} on ${today}.`;
  signModalStatementEl.classList.remove("empty");
  signModalConfirmBtn.disabled = !isMeaningfulName(name);
  updateZonePreviewState();
}

async function onConfirmSign() {
  if (!activeSignZone || signingInFlight || isTearingDown) return;
  const lifecycle = captureViewerLifecycle();
  const liveZone = activeSignZone;
  const zone = Object.freeze({
    type: liveZone.type,
    label: liveZone.label,
    page: liveZone.page,
    x: liveZone.x,
    y: liveZone.y,
    width: liveZone.width,
    height: liveZone.height,
    confidence: liveZone.confidence,
    source: liveZone.source,
    id: liveZone.id,
  });
  const operationMode = modeForZoneType(zone.type);
  const cfg = MODAL_MODE_CONFIG[operationMode];
  const baseName = (pdfPath.split(/[\/\\]/).pop() || "this document");

  // Preflight validation per mode
  if (operationMode === "date") {
    if (!signModalDateInputEl.value) return;
  } else if (operationMode === "name") {
    if (!signModalNameEl.value.trim()) return;
  } else {
    const name = signModalNameEl.value.trim();
    if (!isMeaningfulName(name)) return;
  }

  signingInFlight = true;
  setSignModalControlsLocked(true);
  signModalConfirmBtn.disabled = true;
  signModalConfirmBtn.textContent = cfg.signingLabel;
  signModalErrorEl.style.display = "none";

  try {
    // The canonical document path stays stable. Mutations write back to that
    // same file, and the server creates a one-time backup on the first edit.
    const inputForApply = pdfPath;
    const outputPath = pdfPath;

    if (operationMode === "date" || operationMode === "name") {
      // Plain text paths use apply_text and never invoke signature intent.
      const textValue = operationMode === "date"
        ? signModalDateInputEl.value
        : signModalNameEl.value.trim();
      const applyResult = await callServerToolDuringLifecycle({
        name: "apply_text",
        arguments: {
          pdf_path: inputForApply,
          output_path: outputPath,
          page: zone.page,
          x: zone.x, y: zone.y, width: zone.width, height: zone.height,
          text: textValue,
        },
      }, lifecycle);
      assertViewerLifecycle(lifecycle);
      if (applyResult.isError) {
        const text = applyResult.content?.map((c: any) => ("text" in c ? c.text : "")).join(" ") || "apply_text failed";
        throw new Error(text);
      }
      liveZone.applied = true;
      liveZone.appliedValue = textValue;
      appliedZoneKeys.add(zoneKey(pdfPath, liveZone));
      const sc = applyResult.structuredContent as { pdf_path?: string; backup_path?: string | null } | undefined;
      activeBackupPath = sc?.backup_path ?? activeBackupPath;
      // Invalidate the tool-result short-circuit so a replay of the original
      // display_pdf result forces a clean reload (Codex P1-B).
      lastLoadedResultKey = "";
      updateWorkingCopyBanner();
      let reloadOk = true;
      let reloadErr: string | undefined;
      try {
        await reloadPdfForStamp(pdfPath, lifecycle);
        assertViewerLifecycle(lifecycle);
      } catch (err: any) {
        if (isViewerLifecycleEnded(err)) throw err;
        reloadOk = false;
        reloadErr = err?.message ?? String(err);
        console.warn("[viewer] post-stamp reload failed:", err);
      }
      renderZoneOverlay();
      renderSignPanel();
      if (reloadOk) {
        showStampToast(sc?.pdf_path ?? outputPath, operationMode);
      } else {
        // Stamp IS on disk; viewer just couldn't re-render. Tell the user.
        showStampToast(
          sc?.pdf_path ?? outputPath,
          operationMode,
          "warning",
          `Reload failed — switch modes or reopen to see it. (${reloadErr ?? "unknown error"})`,
        );
      }
      closeSignModal(false);
      return;
    }

    // ─── Signature / initials path → apply_signature ───
    const name = signModalNameEl.value.trim();
    const existing = signModalExistingEl.value;
    const timestamp = new Date().toISOString();
    const today = localDateString();
    const statement = `I, ${name}, ${cfg.verb} ${baseName} on ${today}.`;

    let signatureName = existing;
    if (!signatureName) {
      const quickName = "__pdf-tools-quick-typed__";
      const createResult = await callServerToolDuringLifecycle({
        name: "create_signature",
        arguments: { name: quickName, display_name: name, overwrite: true },
      }, lifecycle);
      assertViewerLifecycle(lifecycle);
      if (createResult.isError) {
        const text = createResult.content?.map((c: any) => ("text" in c ? c.text : "")).join(" ") || "create_signature failed";
        throw new Error(text);
      }
      signatureName = quickName;
    }

    const applyResult = await callServerToolDuringLifecycle({
      name: "apply_signature",
      arguments: {
        pdf_path: inputForApply,
        output_path: outputPath,
        signature_name: signatureName,
        page: zone.page,
        x: zone.x, y: zone.y, width: zone.width, height: zone.height,
        user_intent_statement: statement,
        user_confirmed_at: timestamp,
        signing_mode: operationMode === "initials" ? "initials" : "signature",
      },
    }, lifecycle);
    assertViewerLifecycle(lifecycle);
    if (applyResult.isError) {
      const text = applyResult.content?.map((c: any) => ("text" in c ? c.text : "")).join(" ") || "apply_signature failed";
      throw new Error(text);
    }

    liveZone.applied = true;
    appliedZoneKeys.add(zoneKey(pdfPath, liveZone));
    const sc = applyResult.structuredContent as { pdf_path?: string; backup_path?: string | null } | undefined;
    activeBackupPath = sc?.backup_path ?? activeBackupPath;
    // Invalidate the tool-result short-circuit so a replay of the original
    // display_pdf result forces a clean reload (Codex P1-B).
    lastLoadedResultKey = "";
    updateWorkingCopyBanner();
    let reloadOk = true;
    let reloadErr: string | undefined;
    try {
      await reloadPdfForStamp(pdfPath, lifecycle);
      assertViewerLifecycle(lifecycle);
    } catch (err: any) {
      if (isViewerLifecycleEnded(err)) throw err;
      reloadOk = false;
      reloadErr = err?.message ?? String(err);
      console.warn("[viewer] post-stamp reload failed:", err);
    }
    renderZoneOverlay();
    renderSignPanel();
    const toastMode = operationMode === "initials" ? "initials" : "signature";
    if (reloadOk) {
      showStampToast(sc?.pdf_path ?? outputPath, toastMode);
    } else {
      showStampToast(
        sc?.pdf_path ?? outputPath,
        toastMode,
        "warning",
        `Reload failed — switch modes or reopen to see it. (${reloadErr ?? "unknown error"})`,
      );
    }
    closeSignModal(false);
  } catch (err: any) {
    if (isViewerLifecycleEnded(err)) return;
    signModalErrorEl.textContent = err?.message ?? String(err);
    signModalErrorEl.style.display = "block";
    signModalConfirmBtn.disabled = false;
    signModalConfirmBtn.textContent = cfg.buttonLabel;
  } finally {
    if (!isTearingDown && lifecycle === viewerLifecycleEpoch) {
      signingInFlight = false;
      setSignModalControlsLocked(false);
    }
  }
}

// ─── Drawing canvas (Sign mode) ──────────────────────────────────────────────

interface Stroke { points: Array<[number, number]>; }
let drawStrokes: Stroke[] = [];
let drawCurrentStroke: Stroke | null = null;
let drawCanvasCtx: CanvasRenderingContext2D | null = null;
let drawPointerId: number | null = null;

function getDrawCtx(): CanvasRenderingContext2D {
  if (!drawCanvasCtx) {
    drawCanvasCtx = drawCanvasEl.getContext("2d", { willReadFrequently: false })!;
    drawCanvasCtx.lineCap = "round";
    drawCanvasCtx.lineJoin = "round";
  }
  return drawCanvasCtx;
}

function clearDrawCanvas() {
  const ctx = getDrawCtx();
  // Reset transform in case DPR scaling was applied previously
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.clearRect(0, 0, drawCanvasEl.width, drawCanvasEl.height);
  // Redraw a white background so saved PNG has white (not transparent) bg
  ctx.fillStyle = "#ffffff";
  ctx.fillRect(0, 0, drawCanvasEl.width, drawCanvasEl.height);
}

function resizeDrawCanvasForDpr() {
  const rect = drawCanvasEl.getBoundingClientRect();
  const cssWidth = rect.width || 560;
  const cssHeight = rect.height || 200;
  const { width, height } = getCanvasBufferSize(cssWidth, cssHeight, window.devicePixelRatio || 1);
  if (drawCanvasEl.width !== width || drawCanvasEl.height !== height) {
    drawCanvasEl.width = width;
    drawCanvasEl.height = height;
    drawCanvasCtx = null;
  }
}

function redrawAllStrokes() {
  clearDrawCanvas();
  const ctx = getDrawCtx();
  const rect = drawCanvasEl.getBoundingClientRect();
  const pixelScale = rect.width > 0 ? drawCanvasEl.width / rect.width : 1;
  ctx.strokeStyle = "#111111";
  ctx.lineWidth = 2.5 * pixelScale;
  for (const stroke of drawStrokes) {
    if (stroke.points.length === 0) continue;
    ctx.beginPath();
    ctx.moveTo(stroke.points[0][0], stroke.points[0][1]);
    for (let i = 1; i < stroke.points.length; i++) {
      ctx.lineTo(stroke.points[i][0], stroke.points[i][1]);
    }
    if (stroke.points.length === 1) {
      const [x, y] = stroke.points[0];
      ctx.arc(x, y, 1.25 * pixelScale, 0, Math.PI * 2);
      ctx.fillStyle = "#111111";
      ctx.fill();
    } else {
      ctx.stroke();
    }
  }
  updateDrawSaveState();
}

function pointerCoordsRelativeToCanvas(e: PointerEvent): [number, number] {
  const rect = drawCanvasEl.getBoundingClientRect();
  const scaleX = drawCanvasEl.width / rect.width;
  const scaleY = drawCanvasEl.height / rect.height;
  return [(e.clientX - rect.left) * scaleX, (e.clientY - rect.top) * scaleY];
}

function onDrawPointerDown(e: PointerEvent) {
  if (drawModalEl.style.display === "none" || drawPointerId !== null || !e.isPrimary) return;
  e.preventDefault();
  drawPointerId = e.pointerId;
  drawCanvasEl.setPointerCapture(e.pointerId);
  drawCurrentStroke = { points: [pointerCoordsRelativeToCanvas(e)] };
  drawStrokes.push(drawCurrentStroke);
  redrawAllStrokes();
}

function onDrawPointerMove(e: PointerEvent) {
  if (!drawCurrentStroke || e.pointerId !== drawPointerId) return;
  if (e.pointerType === "mouse" && e.buttons === 0) {
    onDrawPointerUp(e);
    return;
  }
  drawCurrentStroke.points.push(pointerCoordsRelativeToCanvas(e));
  redrawAllStrokes();
}

function onDrawPointerUp(e: PointerEvent) {
  if (!drawCurrentStroke || e.pointerId !== drawPointerId) return;
  try { drawCanvasEl.releasePointerCapture(e.pointerId); } catch { /* ignore */ }
  drawCurrentStroke = null;
  drawPointerId = null;
  redrawAllStrokes();
}

function openDrawModal() {
  setInspectRegionArmed(false);
  drawStrokes = [];
  drawCurrentStroke = null;
  drawPointerId = null;
  drawNameInputEl.value = "";
  drawLegalNameInputEl.value = "";
  drawErrorEl.style.display = "none";
  drawErrorEl.textContent = "";
  openModal(drawModalEl, drawCanvasEl);
  resizeDrawCanvasForDpr();
  clearDrawCanvas();
  updateDrawSaveState();
}

function closeDrawModal() {
  closeModal(drawModalEl);
  drawCurrentStroke = null;
  drawPointerId = null;
}

function updateDrawSaveState() {
  const hasStrokes = drawStrokes.some(s => s.points.length > 0);
  const hasLabel = drawNameInputEl.value.trim().length >= 2;
  // Legal name is optional but strongly recommended — if omitted, users have
  // to retype on every sign. Allow save either way but warn via the hint text.
  drawSaveBtn.disabled = !hasStrokes || !hasLabel;
}

async function onSaveDrawnSignature() {
  if (isTearingDown) return;
  const lifecycle = captureViewerLifecycle();
  const name = drawNameInputEl.value.trim();
  const legalName = drawLegalNameInputEl.value.trim();
  if (!name) return;
  if (drawStrokes.every(s => s.points.length === 0)) return;

  drawSaveBtn.disabled = true;
  drawSaveBtn.textContent = "Saving…";
  drawErrorEl.style.display = "none";

  try {
    const dataUrl = drawCanvasEl.toDataURL("image/png");
    const createArgs: Record<string, unknown> = {
      name,
      image_data_url: dataUrl,
      overwrite: false,
    };
    // Pass legal name through as display_name so the confirm modal can
    // auto-fill the attestation field when this signature is picked later.
    if (legalName) createArgs.display_name = legalName;
    const result = await callServerToolDuringLifecycle({
      name: "create_signature",
      arguments: createArgs,
    }, lifecycle);
    assertViewerLifecycle(lifecycle);
    if (result.isError) {
      const text = result.content?.map((c: any) => ("text" in c ? c.text : "")).join(" ") || "create_signature failed";
      throw new Error(text);
    }
    closeDrawModal();
    // If the confirm modal is open, refresh its dropdown so the new signature appears immediately.
    if (signModalEl.style.display === "flex") {
      await populateSavedSignatures();
      assertViewerLifecycle(lifecycle);
      signModalExistingEl.value = name;
      await onSavedSignatureChange();
      assertViewerLifecycle(lifecycle);
      updateStatementPreview();
    }
  } catch (err: any) {
    if (isViewerLifecycleEnded(err)) return;
    drawErrorEl.textContent = err?.message ?? String(err);
    drawErrorEl.style.display = "block";
  } finally {
    if (!isTearingDown && lifecycle === viewerLifecycleEpoch) {
      drawSaveBtn.disabled = false;
      drawSaveBtn.textContent = "Save signature";
      updateDrawSaveState();
    }
  }
}

// Reload the renderer from the stamped output so the canvas shows the actual
// signatures/dates the server wrote to disk. Keeps `pdfPath` as the original
// (that's the logical identity for zone keys + output-path stems); only the
// bytes feeding pdfjs change. Preserves currentPage + scale.
async function reloadPdfForStamp(
  stampedPath: string,
  lifecycle = captureViewerLifecycle(),
) {
  assertViewerLifecycle(lifecycle);
  // Cancel any in-flight render so we don't tear down the old doc mid-raster.
  if (currentRenderTask) {
    try { currentRenderTask.cancel(); } catch { /* ignore */ }
    currentRenderTask = null;
  }
  isRendering = false;
  pendingPage = null;

  // Bump generation FIRST so any in-flight preloader from the old doc sees
  // it mismatch on the next iteration and aborts cleanly (Codex P2-A).
  const loadGeneration = ++pdfGeneration;
  const oldDoc = pdfDocument;
  pdfDocument = null;
  if (oldDoc) {
    try { await oldDoc.destroy(); } catch { /* best-effort */ }
    assertViewerLifecycle(lifecycle);
  }

  // Content-specific caches: page text may include our new stamp text.
  pageTextCache.clear();
  pagesLoaded = 0;
  invalidateRangeCacheForPath(stampedPath);

  try {
    const probe = await callServerToolDuringLifecycle({
      name: "read_pdf_bytes",
      arguments: { pdf_path: stampedPath, offset: 0, byteCount: 1 },
    }, lifecycle);
    assertViewerLifecycle(lifecycle);
    if (probe.isError) {
      const text = probe.content?.map((c: any) => ("text" in c ? c.text : "")).join(" ") || "Stamped-file probe failed";
      throw new Error(text);
    }
    const probeSc = probe.structuredContent as { totalBytes?: number } | undefined;
    if (!probeSc?.totalBytes) throw new Error("Stamped file has no size reported");

    pdfDocument = await loadPdfProgressively(stampedPath, probeSc.totalBytes, loadGeneration);
    assertViewerLifecycle(lifecycle);
    // New doc should have the same page count — guard defensively.
    totalPages = pdfDocument.numPages;
    if (currentPage > totalPages) currentPage = totalPages;
    await renderPage();
    assertViewerLifecycle(lifecycle);
    // Re-index the new doc so search + model context reflect stamped content.
    startPreloading();
  } catch (err: any) {
    if (isViewerLifecycleEnded(err) || loadGeneration !== pdfGeneration) return;
    console.error("[viewer] reloadPdfForStamp failed:", err);
    // Best-effort: reload from original so we don't leave the viewer empty.
    try {
      invalidateRangeCacheForPath(pdfPath);
      assertViewerLifecycle(lifecycle);
      const probe = await callServerToolDuringLifecycle({
        name: "read_pdf_bytes",
        arguments: { pdf_path: pdfPath, offset: 0, byteCount: 1 },
      }, lifecycle);
      assertViewerLifecycle(lifecycle);
      const probeSc = probe.structuredContent as { totalBytes?: number } | undefined;
      if (probeSc?.totalBytes) {
        pdfDocument = await loadPdfProgressively(pdfPath, probeSc.totalBytes, loadGeneration);
        assertViewerLifecycle(lifecycle);
        totalPages = pdfDocument.numPages;
        if (currentPage > totalPages) currentPage = totalPages;
        await renderPage();
        assertViewerLifecycle(lifecycle);
        startPreloading();
      }
    } catch (fallbackErr) {
      if (isViewerLifecycleEnded(fallbackErr)) return;
      /* give up - error already logged */
    }
    throw err;
  }
}

function updateWorkingCopyBanner() {
  if (!activeBackupPath) {
    signPanelWorkingCopyEl.style.display = "none";
    return;
  }
  signPanelWorkingCopyEl.style.display = "";
  signPanelWorkingCopyPathEl.textContent = activeBackupPath;
  signPanelWorkingCopyPathEl.title = activeBackupPath;
}

async function onRevealWorkingCopy() {
  if (!activeBackupPath || isTearingDown) return;
  const lifecycle = captureViewerLifecycle();
  try {
    const result = await callServerToolDuringLifecycle({
      name: "reveal_in_finder",
      arguments: { path: activeBackupPath },
    }, lifecycle);
    assertViewerLifecycle(lifecycle);
    if (result.isError) {
      const text = result.content?.map((c: any) => ("text" in c ? c.text : "")).join(" ") || "Reveal failed";
      console.warn("[viewer] reveal_in_finder error:", text);
    }
  } catch (err) {
    if (!isViewerLifecycleEnded(err)) {
      console.warn("[viewer] reveal_in_finder call failed:", err);
    }
  }
}

async function onCopyWorkingCopyPath() {
  if (!activeBackupPath) return;
  const original = signPanelWorkingCopyCopyBtn.textContent ?? "Copy path";
  const flash = (msg: string) => {
    signPanelWorkingCopyCopyBtn.textContent = msg;
    setTimeout(() => { signPanelWorkingCopyCopyBtn.textContent = original; }, 1800);
  };

  // Clipboard API isn't always available (non-secure contexts, sandboxed
  // webviews). Fall back to a hidden textarea + execCommand so the user sees
  // a real confirmation — silent failure here makes the button look broken.
  try {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(activeBackupPath);
      flash("Copied");
      return;
    }
    throw new Error("clipboard API unavailable");
  } catch (err) {
    try {
      const ta = document.createElement("textarea");
      ta.value = activeBackupPath;
      ta.setAttribute("readonly", "");
      ta.style.position = "absolute";
      ta.style.left = "-9999px";
      document.body.appendChild(ta);
      ta.select();
      const ok = document.execCommand("copy");
      document.body.removeChild(ta);
      flash(ok ? "Copied" : "Copy failed");
    } catch (fallbackErr) {
      console.warn("[viewer] clipboard fallback failed:", fallbackErr, err);
      flash("Copy failed");
    }
  }
}

const TOAST_TITLES: Record<string, string> = {
  signature: "✓ Signed",
  initials:  "✓ Initialed",
  name:      "✓ Name inserted",
  date:      "✓ Date inserted",
};

type StampToastVariant = "success" | "warning";

function showStampToast(
  outputPath: string,
  mode: string,
  variant: StampToastVariant = "success",
  extraBody?: string,
) {
  const toast = document.createElement("div");
  toast.className = variant === "warning" ? "sign-toast sign-toast-warning" : "sign-toast";
  const title = document.createElement("div");
  title.className = "sign-toast-title";
  if (variant === "warning") {
    title.textContent = "⚠︎ Saved — viewer needs refresh";
  } else {
    title.textContent = TOAST_TITLES[mode] ?? "✓ Done";
  }
  const body = document.createElement("div");
  body.className = "sign-toast-body";
  body.textContent = `Saved to: ${outputPath}`;
  toast.appendChild(title);
  toast.appendChild(body);
  if (extraBody) {
    const extra = document.createElement("div");
    extra.className = "sign-toast-body";
    extra.style.marginTop = "4px";
    extra.style.fontFamily = "inherit";
    extra.textContent = extraBody;
    toast.appendChild(extra);
  }
  document.body.appendChild(toast);
  // Warning toasts linger longer — the user needs to read the guidance.
  setTimeout(() => toast.remove(), variant === "warning" ? 8000 : 4500);
}

function formatRegionCoords(region: Pick<RegionPreviewState, "page" | "x" | "y" | "width" | "height">) {
  return `Page ${region.page} — x:${region.x.toFixed(1)} y:${region.y.toFixed(1)} w:${region.width.toFixed(1)} h:${region.height.toFixed(1)} pt`;
}

function setInspectRegionArmed(next: boolean) {
  inspectRegionArmed = next;
  signPanelInspectBtn.classList.toggle("active", next);
  signPanelInspectBtn.disabled = inspectPreviewInFlight;
  signPanelInspectBtn.textContent = next ? "Cancel inspect" : "🔍 Inspect region";
  zoneLayerEl.classList.toggle("inspect-armed", next && manageMode === "sign");
}

async function copyRegionCoords() {
  if (!activeRegionPreview) return;
  const text = formatRegionCoords(activeRegionPreview);
  const original = regionPreviewCopyBtn.textContent ?? "Copy coordinates";
  const flash = (msg: string) => {
    regionPreviewCopyBtn.textContent = msg;
    setTimeout(() => { regionPreviewCopyBtn.textContent = original; }, 1800);
  };

  try {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(text);
      flash("Copied");
      return;
    }
    throw new Error("clipboard API unavailable");
  } catch {
    try {
      const ta = document.createElement("textarea");
      ta.value = text;
      ta.setAttribute("readonly", "");
      ta.style.position = "absolute";
      ta.style.left = "-9999px";
      document.body.appendChild(ta);
      ta.select();
      const ok = document.execCommand("copy");
      document.body.removeChild(ta);
      flash(ok ? "Copied" : "Copy failed");
    } catch {
      flash("Copy failed");
    }
  }
}

function closeRegionPreviewModal() {
  closeModal(regionPreviewModalEl);
  activeRegionPreview = null;
  regionPreviewImageEl.src = "";
}

function updateRegionPreviewCreateButton() {
  const type = regionPreviewZoneTypeEl.value as SignatureZone["type"];
  const label = type === "signature"
    ? "Create signature zone"
    : type === "initials"
      ? "Create initials zone"
      : type === "name"
        ? "Create name zone"
        : "Create date zone";
  regionPreviewCreateZoneBtn.textContent = label;
}

function createCustomSignatureZoneFromPreview(preview: RegionPreviewState): SignatureZone {
  const type = regionPreviewZoneTypeEl.value as SignatureZone["type"];
  const label = type === "signature"
    ? "Custom signature zone"
    : type === "initials"
      ? "Custom initials zone"
      : type === "name"
        ? "Custom name zone"
        : "Custom date zone";
  return {
    type,
    label,
    page: preview.page,
    x: preview.x,
    y: preview.y,
    width: preview.width,
    height: preview.height,
    confidence: 1.0,
    source: "user-drag",
    id: `zone-custom-${Date.now()}`,
    applied: false,
  };
}

function useRegionPreviewAsSignatureZone() {
  if (!activeRegionPreview) return;
  const zone = createCustomSignatureZoneFromPreview(activeRegionPreview);
  signatureZones.push(zone);
  closeRegionPreviewModal();
  renderZoneOverlay();
  renderSignPanel();
  openSignModal(zone);
}

function openRegionPreviewModal(preview: RegionPreviewState) {
  activeRegionPreview = preview;
  regionPreviewDocEl.textContent = getHostBaseName(pdfPath);
  regionPreviewCoordsEl.textContent = formatRegionCoords(preview);
  regionPreviewZoneTypeEl.value = preview.zoneType || "signature";
  updateRegionPreviewCreateButton();
  regionPreviewImageEl.src = preview.imageDataUrl;
  openModal(regionPreviewModalEl, regionPreviewDoneBtn);
}

async function inspectRegionSelection(region: Pick<RegionPreviewState, "page" | "x" | "y" | "width" | "height" | "zoneType">) {
  if (!pdfPath || isTearingDown) return;
  const lifecycle = captureViewerLifecycle();
  const requestId = ++inspectPreviewRequestSeq;
  inspectPreviewInFlight = true;
  setInspectRegionArmed(false);
  signPanelStatusEl.textContent = "Rendering region preview…";
  signPanelStatusEl.classList.remove("empty");
  try {
    const result = await callServerToolDuringLifecycle({
      name: "render_pdf_region",
      arguments: {
        pdf_path: pdfPath,
        page: region.page,
        x: region.x,
        y: region.y,
        width: region.width,
        height: region.height,
      },
    }, lifecycle);
    assertViewerLifecycle(lifecycle);
    if (result.isError) {
      const text = result.content?.map((c: any) => ("text" in c ? c.text : "")).join(" ") || "Region preview failed";
      throw new Error(text);
    }
    const imageItem = result.content?.find((c: any) => c.type === "image");
    if (!imageItem?.data) {
      throw new Error("Region preview returned no image.");
    }
    if (requestId !== inspectPreviewRequestSeq) return;
    openRegionPreviewModal({
      ...region,
      imageDataUrl: `data:${imageItem.mimeType || "image/png"};base64,${imageItem.data}`,
    });
    renderSignPanel();
  } catch (err: any) {
    if (isViewerLifecycleEnded(err)) return;
    if (requestId !== inspectPreviewRequestSeq) return;
    console.error("[viewer] render_pdf_region failed:", err);
    signPanelStatusEl.textContent = `Region preview failed: ${err?.message ?? err}`;
    signPanelStatusEl.classList.remove("empty");
  } finally {
    if (!isTearingDown && lifecycle === viewerLifecycleEpoch && requestId === inspectPreviewRequestSeq) {
      inspectPreviewInFlight = false;
      signPanelInspectBtn.disabled = false;
    }
  }
}

async function previewExistingZone(zone: SignatureZone) {
  if (isTearingDown) return;
  const lifecycle = captureViewerLifecycle();
  if (zone.page !== currentPage) {
    currentPage = zone.page;
    await renderPage();
    if (!isViewerLifecycleCurrent(lifecycle)) return;
  }
  await inspectRegionSelection({
    page: zone.page,
    x: zone.x,
    y: zone.y,
    width: zone.width,
    height: zone.height,
    zoneType: zone.type,
  });
  if (!isViewerLifecycleCurrent(lifecycle)) return;
}

function renderSignPanel() {
  const count = signatureZones.length;
  signZoneCountEl.textContent = `${count} zone${count === 1 ? "" : "s"}`;
  clearChildren(signPanelListEl);

  const status = getSignPanelStatus({
    count,
    loading: zoneRequests.isLoading(pdfPath),
    detectionError: zoneRequests.getError(pdfPath),
    inspectArmed: inspectRegionArmed,
  });
  const warnings = zoneWarningsByPath.get(pdfPath) ?? [];
  signPanelStatusEl.textContent = warnings.length > 0
    ? `${status.message} Warning: ${warnings.map(warning => warning.message).join(" ")}`
    : status.message;
  signPanelStatusEl.classList.toggle("empty", status.tone === "empty");
  signPanelStatusEl.classList.toggle("error", status.tone === "error");

  if (count === 0) {
    return;
  }

  for (const z of signatureZones) {
    const item = document.createElement("div");
    item.className = "sign-panel-item";
    item.setAttribute("role", "button");
    item.tabIndex = 0;
    item.dataset.zoneId = z.id || "";
    item.dataset.zoneKey = zoneKey(pdfPath, z);

    const header = document.createElement("div");
    header.className = "sign-panel-item-header";

    const typeBadge = document.createElement("span");
    typeBadge.className = "sign-panel-item-type";
    typeBadge.dataset.type = z.type;
    typeBadge.textContent = z.type;
    header.appendChild(typeBadge);

    const pageLabel = document.createElement("span");
    pageLabel.className = "sign-panel-item-page";
    pageLabel.textContent = `p${z.page}`;
    header.appendChild(pageLabel);

    const previewBtn = document.createElement("button");
    previewBtn.className = "sign-panel-item-preview";
    previewBtn.type = "button";
    previewBtn.dataset.zoneControl = "preview";
    previewBtn.textContent = "Preview";
    previewBtn.title = "Preview this zone";
    previewBtn.addEventListener("click", async (e) => {
      e.stopPropagation();
      await previewExistingZone(z);
    });
    header.appendChild(previewBtn);

    item.appendChild(header);

    const label = document.createElement("div");
    label.className = "sign-panel-item-label";
    label.textContent = z.label || "(no label)";
    item.appendChild(label);

    if (z.applied) {
      const status = document.createElement("div");
      status.className = "sign-panel-item-status";
      status.textContent = (z.type === "date" || z.type === "name") && z.appliedValue
        ? `✓ ${z.appliedValue}`
        : z.type === "initials"
          ? "✓ Initialed"
          : "✓ Signed";
      item.appendChild(status);
    }

    const activate = () => {
      // Jump to the page the zone lives on
      if (z.page !== currentPage) {
        currentPage = z.page;
        renderPage();
      }
      onZoneClick(z);
    };
    item.addEventListener("click", activate);
    item.addEventListener("keydown", (e) => {
      if (e.target !== item) return;
      if (e.key === "Enter" || e.key === " ") {
        e.preventDefault();
        activate();
      }
    });

    signPanelListEl.appendChild(item);
  }
}

function switchMode(mode: ManageMode) {
  if (mode !== "sign" && inspectRegionArmed) {
    setInspectRegionArmed(false);
  }
  manageMode = mode;
  modeViewBtn.classList.toggle("active", mode === "view");
  modeManageBtn.classList.toggle("active", mode === "manage");
  modeSignBtn.classList.toggle("active", mode === "sign");

  const canvasContainer = document.querySelector(".canvas-container") as HTMLElement;
  const pageWrapper = document.querySelector(".page-wrapper") as HTMLElement;
  pageWrapper?.classList.toggle("mode-sign", mode === "sign");
  zoneLayerEl.classList.toggle("inspect-armed", inspectRegionArmed && mode === "sign");
  const searchBar = $("search-bar");

  if (mode === "manage") {
    canvasContainer.style.display = "none";
    managePanelEl.style.display = "flex";
    signPanelEl.style.display = "none";
    sidebarEl.style.display = "none";
    searchBar.style.display = "none";
    clearZoneOverlay();
    if (pageStates.length === 0) initPageStates();
    renderManageGrid();
  } else if (mode === "sign") {
    canvasContainer.style.display = "";
    managePanelEl.style.display = "none";
    signPanelEl.style.display = "flex";
    sidebarEl.style.display = "none";
    searchBar.style.display = "none";
    updateWorkingCopyBanner();
    renderPage();
    fetchSignatureZones();
  } else {
    // view
    canvasContainer.style.display = "";
    managePanelEl.style.display = "none";
    signPanelEl.style.display = "none";
    clearZoneOverlay();
    renderPage();
  }
}

function getSelectedPages(): number[] {
  return pageStates
    .map((ps, i) => ps.selected && !ps.deleted ? i : -1)
    .filter(i => i >= 0);
}

function updateManageActions() {
  const selected = getSelectedPages();
  const hasSelection = selected.length > 0;
  manageRotateCwBtn.disabled = !hasSelection;
  manageRotateCcwBtn.disabled = !hasSelection;
  manageDeleteBtn.disabled = !hasSelection;

  const changes: string[] = [];
  const deletedCount = pageStates.filter(p => p.deleted).length;
  const rotatedCount = pageStates.filter(p => p.rotation !== 0).length;
  const reordered = pageStates.some((ps, i) => ps.originalIndex !== i + 1);
  if (deletedCount > 0) changes.push(`${deletedCount} deleted`);
  if (rotatedCount > 0) changes.push(`${rotatedCount} rotated`);
  if (reordered) changes.push("reordered");
  hasUnsavedChanges = changes.length > 0;
  manageResetBtn.disabled = !hasUnsavedChanges;
  manageApplyBtn.disabled = !hasUnsavedChanges;
  manageStatusEl.textContent = hasUnsavedChanges ? `\u26A0\uFE0F ${changes.join(", ")}` : "";
}

async function renderThumbnail(pageNum: number): Promise<string> {
  if (!pdfDocument) return "";
  const page = await pdfDocument.getPage(pageNum);
  const baseViewport = page.getViewport({ scale: 1 });
  const thumbScale = 120 / baseViewport.width;
  const viewport = page.getViewport({ scale: thumbScale });

  const canvas = document.createElement("canvas");
  canvas.width = Math.floor(viewport.width);
  canvas.height = Math.floor(viewport.height);
  const ctx = canvas.getContext("2d")!;
  ctx.fillStyle = "white";
  ctx.fillRect(0, 0, canvas.width, canvas.height);

  await page.render({ canvasContext: ctx, viewport }).promise;
  return canvas.toDataURL("image/jpeg", 0.7);
}

function createThumbItem(ps: PageState, idx: number, observer: IntersectionObserver): HTMLElement {
  const item = document.createElement("div");
  item.className = "manage-thumb-item";
  item.dataset.idx = String(idx);
  item.setAttribute("role", "option");
  item.setAttribute("aria-label", `Page ${ps.originalIndex}`);
  item.setAttribute("aria-selected", String(ps.selected));
  item.tabIndex = 0;

  if (ps.selected) item.classList.add("selected");
  if (ps.deleted) item.classList.add("deleted");

  // Image or placeholder
  const img = document.createElement("img");
  img.className = "manage-thumb-img";
  img.alt = `Page ${ps.originalIndex}`;
  img.draggable = false;
  if (ps.thumbnailDataUrl) {
    img.src = ps.thumbnailDataUrl;
  } else {
    img.style.display = "none";
    const placeholder = document.createElement("div");
    placeholder.className = "manage-thumb-placeholder";
    item.appendChild(placeholder);
    observer.observe(item);
  }
  item.appendChild(img);

  // Page number label
  const label = document.createElement("span");
  label.className = "manage-thumb-label";
  label.textContent = String(ps.originalIndex);
  item.appendChild(label);

  // Rotation badge
  if (ps.rotation > 0) {
    const badge = document.createElement("span");
    badge.className = "manage-thumb-badge";
    badge.textContent = `\u21BB${ps.rotation}\u00B0`;
    item.appendChild(badge);
  }

  // Hover action buttons
  const actions = document.createElement("div");
  actions.className = "manage-thumb-actions";

  const cwBtn = document.createElement("button");
  cwBtn.className = "thumb-action";
  cwBtn.title = "Rotate CW";
  cwBtn.textContent = "\u21BB";
  cwBtn.addEventListener("click", (e) => { e.stopPropagation(); ps.rotation = (ps.rotation + 90) % 360; renderManageGrid(); updateManageActions(); });

  const ccwBtn = document.createElement("button");
  ccwBtn.className = "thumb-action";
  ccwBtn.title = "Rotate CCW";
  ccwBtn.textContent = "\u21BA";
  ccwBtn.addEventListener("click", (e) => { e.stopPropagation(); ps.rotation = (ps.rotation + 270) % 360; renderManageGrid(); updateManageActions(); });

  const delBtn = document.createElement("button");
  delBtn.className = "thumb-action";
  delBtn.title = ps.deleted ? "Restore" : "Delete";
  delBtn.textContent = ps.deleted ? "\u21A9" : "\u2715";
  delBtn.addEventListener("click", (e) => { e.stopPropagation(); ps.deleted = !ps.deleted; ps.selected = false; renderManageGrid(); updateManageActions(); });

  actions.appendChild(cwBtn);
  actions.appendChild(ccwBtn);
  actions.appendChild(delBtn);
  item.appendChild(actions);

  // Click to select
  item.addEventListener("click", (e) => {
    if ((e.target as HTMLElement).closest(".thumb-action")) return;
    handleThumbClick(idx, e);
  });

  // Keyboard nav
  item.addEventListener("keydown", (e) => {
    if (e.key === " ") { e.preventDefault(); handleThumbClick(idx, e); }
    if (e.key === "ArrowRight") focusThumb(idx + 1);
    if (e.key === "ArrowLeft") focusThumb(idx - 1);
    if (e.key === "ArrowDown") focusThumb(idx + 3);
    if (e.key === "ArrowUp") focusThumb(idx - 3);
  });

  // Pointer-based drag
  if (!ps.deleted) {
    item.addEventListener("pointerdown", (e) => {
      if ((e.target as HTMLElement).closest(".thumb-action")) return;
      startDrag(idx, e);
    });
  }

  return item;
}

function renderManageGrid() {
  clearChildren(manageGridEl);

  if (totalPages <= 1) {
    const empty = document.createElement("div");
    empty.className = "manage-empty";
    const text = document.createElement("div");
    text.className = "manage-empty-text";
    text.textContent = "Only 1 page \u2014 nothing to rearrange.";
    const btn = document.createElement("button");
    btn.className = "manage-empty-btn";
    btn.textContent = "Back to View";
    btn.addEventListener("click", () => switchMode("view"));
    empty.appendChild(text);
    empty.appendChild(btn);
    manageGridEl.appendChild(empty);
    updateManageActions();
    return;
  }

  const observer = new IntersectionObserver((entries) => {
    for (const entry of entries) {
      if (entry.isIntersecting) {
        const el = entry.target as HTMLElement;
        const idx = parseInt(el.dataset.idx!, 10);
        const ps = pageStates[idx];
        if (!ps.thumbnailDataUrl) {
          renderThumbnail(ps.originalIndex).then(url => {
            ps.thumbnailDataUrl = url;
            const img = el.querySelector(".manage-thumb-img") as HTMLImageElement;
            if (img) { img.src = url; img.style.display = ""; }
            const placeholder = el.querySelector(".manage-thumb-placeholder");
            if (placeholder) placeholder.remove();
          });
        }
        observer.unobserve(el);
      }
    }
  }, { rootMargin: "100px" });

  pageStates.forEach((ps, idx) => {
    manageGridEl.appendChild(createThumbItem(ps, idx, observer));
  });

  updateManageActions();
}

function focusThumb(idx: number) {
  const items = manageGridEl.querySelectorAll(".manage-thumb-item");
  const clamped = Math.max(0, Math.min(idx, items.length - 1));
  (items[clamped] as HTMLElement).focus();
}

function handleThumbClick(idx: number, e: MouseEvent | KeyboardEvent) {
  if (e.shiftKey) {
    const lastSelected = pageStates.findIndex(p => p.selected);
    const start = Math.min(lastSelected >= 0 ? lastSelected : idx, idx);
    const end = Math.max(lastSelected >= 0 ? lastSelected : idx, idx);
    pageStates.forEach((ps, i) => { ps.selected = i >= start && i <= end && !ps.deleted; });
  } else if (e.ctrlKey || e.metaKey) {
    pageStates[idx].selected = !pageStates[idx].selected;
  } else {
    pageStates.forEach(ps => { ps.selected = false; });
    pageStates[idx].selected = !pageStates[idx].deleted;
  }
  renderManageGrid();
}

// ─── Pointer Drag ────────────────────────────────────────────────────────────

let dragClone: HTMLElement | null = null;
let dragOverIdx: number | null = null;

function startDrag(idx: number, e: PointerEvent) {
  dragSourceIndex = idx;
  const item = e.currentTarget as HTMLElement;
  item.setPointerCapture(e.pointerId);

  const rect = item.getBoundingClientRect();
  dragClone = item.cloneNode(true) as HTMLElement;
  dragClone.classList.add("manage-drag-clone");
  dragClone.style.width = `${rect.width}px`;
  dragClone.style.height = `${rect.height}px`;
  dragClone.style.left = `${e.clientX - rect.width / 2}px`;
  dragClone.style.top = `${e.clientY - rect.height / 2}px`;
  document.body.appendChild(dragClone);

  item.classList.add("dragging");

  const onMove = (me: PointerEvent) => {
    if (!dragClone) return;
    dragClone.style.left = `${me.clientX - rect.width / 2}px`;
    dragClone.style.top = `${me.clientY - rect.height / 2}px`;

    const items = manageGridEl.querySelectorAll(".manage-thumb-item");
    let newOverIdx: number | null = null;
    items.forEach((el, i) => {
      const r = el.getBoundingClientRect();
      if (me.clientX >= r.left && me.clientX <= r.right && me.clientY >= r.top && me.clientY <= r.bottom) {
        newOverIdx = i;
      }
      el.classList.remove("drop-before", "drop-after");
    });

    if (newOverIdx !== null && newOverIdx !== dragSourceIndex) {
      dragOverIdx = newOverIdx;
      const target = items[newOverIdx] as HTMLElement;
      target.classList.add(newOverIdx < dragSourceIndex! ? "drop-before" : "drop-after");
    } else {
      dragOverIdx = null;
    }
  };

  const onUp = () => {
    item.releasePointerCapture(e.pointerId);
    item.removeEventListener("pointermove", onMove);
    item.removeEventListener("pointerup", onUp);
    item.classList.remove("dragging");

    if (dragClone) { dragClone.remove(); dragClone = null; }

    if (dragOverIdx !== null && dragSourceIndex !== null && dragOverIdx !== dragSourceIndex) {
      const [moved] = pageStates.splice(dragSourceIndex, 1);
      pageStates.splice(dragOverIdx, 0, moved);
    }

    dragSourceIndex = null;
    dragOverIdx = null;
    manageGridEl.querySelectorAll(".manage-thumb-item").forEach(el => el.classList.remove("drop-before", "drop-after"));

    renderManageGrid();
    updateManageActions();
  };

  item.addEventListener("pointermove", onMove);
  item.addEventListener("pointerup", onUp);
}

// ─── Manage Actions ─────────────────────────────────────────────────────────

function rotateSelected(deg: number) {
  for (const idx of getSelectedPages()) {
    pageStates[idx].rotation = (pageStates[idx].rotation + deg) % 360;
  }
  renderManageGrid();
  updateManageActions();
}

function deleteSelected() {
  for (const idx of getSelectedPages()) {
    pageStates[idx].deleted = true;
    pageStates[idx].selected = false;
  }
  renderManageGrid();
  updateManageActions();
}

function resetPages() {
  initPageStates();
  renderManageGrid();
  updateManageActions();
}

async function applyPagePlan() {
  if (!hasUnsavedChanges || !pdfPath || isTearingDown) return;
  const lifecycle = captureViewerLifecycle();

  const activePages = pageStates.filter(ps => !ps.deleted);
  const page_order = activePages.map(ps => ps.originalIndex);
  const rotations: Record<string, number> = {};
  for (const ps of activePages) {
    if (ps.rotation > 0) rotations[String(ps.originalIndex)] = ps.rotation;
  }

  const output_path = buildManagedPdfPath(pdfPath);

  manageApplyBtn.disabled = true;
  manageApplyBtn.textContent = "Saving...";
  manageStatusEl.textContent = "Saving...";

  try {
    const result = await callServerToolDuringLifecycle({
      name: "apply_page_plan",
      arguments: {
        input_path: pdfPath,
        output_path,
        plan: { page_order, rotations },
      },
    }, lifecycle);
    assertViewerLifecycle(lifecycle);

    if (result.isError) {
      const errText = result.content?.map((c: any) => ("text" in c ? c.text : "")).join(" ") || "Unknown error";
      manageStatusEl.textContent = `\u274C ${errText}`;
      manageApplyBtn.textContent = "Save as new file";
      manageApplyBtn.disabled = false;
      return;
    }

    await loadPdfFromToolResult(result);
    assertViewerLifecycle(lifecycle);
    manageStatusEl.textContent = `\u2705 Saved to ${output_path}`;
    manageApplyBtn.textContent = "Save as new file";
    manageGridEl.classList.add("manage-success-flash");
    setTimeout(() => manageGridEl.classList.remove("manage-success-flash"), 500);
  } catch (err: any) {
    if (isViewerLifecycleEnded(err)) return;
    manageStatusEl.textContent = `\u274C Save failed: ${err.message}`;
    manageApplyBtn.textContent = "Save as new file";
    manageApplyBtn.disabled = false;
  }
}

// ─── Event Listeners ─────────────────────────────────────────────────────────

prevBtn.addEventListener("click", () => goToPage(currentPage - 1));
nextBtn.addEventListener("click", () => goToPage(currentPage + 1));
zoomOutBtn.addEventListener("click", zoomOut);
zoomInBtn.addEventListener("click", zoomIn);
searchBtn.addEventListener("click", () => { if (searchOpen) closeSearch(); else openSearch(); });
searchCloseBtn.addEventListener("click", closeSearch);
searchPrevBtn.addEventListener("click", goToPrevMatch);
searchNextBtn.addEventListener("click", goToNextMatch);
fullscreenBtn.addEventListener("click", toggleFullscreen);
sidebarToggleBtn.addEventListener("click", toggleSidebar);

// Manage mode listeners
modeViewBtn.addEventListener("click", () => switchMode("view"));
modeManageBtn.addEventListener("click", () => switchMode("manage"));
modeSignBtn.addEventListener("click", () => switchMode("sign"));

// Confirm modal wiring
signModalNameEl.addEventListener("input", () => {
  // Manual typing voids the auto-fill lock so picking a different saved sig
  // won't clobber the user's hand-typed name.
  delete signModalNameEl.dataset.autofilledFrom;
  updateStatementPreview();
});
signModalTypeEl.addEventListener("change", onCustomZoneTypeChange);
signModalExistingEl.addEventListener("change", onSavedSignatureChange);
signModalDateInputEl.addEventListener("input", updateStatementPreview);
signModalDateInputEl.addEventListener("change", updateStatementPreview);
signModalCancelBtn.addEventListener("click", requestCloseSignModal);
signModalCloseBtn.addEventListener("click", requestCloseSignModal);
signModalConfirmBtn.addEventListener("click", onConfirmSign);
signModalEl.addEventListener("keydown", (e: Event) => {
  const keyEvent = e as KeyboardEvent;
  trapModalFocus(signModalEl, keyEvent);
  if (keyEvent.key === "Escape" && !signingInFlight) {
    requestCloseSignModal();
  } else if (keyEvent.key === "Enter" && !signModalConfirmBtn.disabled) {
    // Let the native button click fire — but only if focus isn't on a textarea
    if ((keyEvent.target as HTMLElement).tagName !== "TEXTAREA") {
      keyEvent.preventDefault();
      onConfirmSign();
    }
  }
});
// Click on backdrop cancels
signModalEl.addEventListener("click", (e) => {
  if ((e.target as HTMLElement).classList.contains("sign-modal-backdrop")) requestCloseSignModal();
});

// Drag-to-create wiring (only actively listens — handlers no-op when not in sign mode)
zoneLayerEl.addEventListener("pointerdown", onZoneLayerPointerDown);
zoneLayerEl.addEventListener("pointermove", onZoneLayerPointerMove);
zoneLayerEl.addEventListener("pointerup", onZoneLayerPointerUp);
zoneLayerEl.addEventListener("pointercancel", onZoneLayerPointerCancel);
document.addEventListener("keydown", (e) => {
  if (e.key === "Escape" && activeDrag) {
    activeDrag.draftEl.remove();
    activeDrag = null;
    zoneLayerEl.classList.remove("dragging");
  } else if (e.key === "Escape" && inspectRegionArmed) {
    setInspectRegionArmed(false);
    renderSignPanel();
  }
});

// Working-copy banner wiring
signPanelWorkingCopyRevealBtn.addEventListener("click", onRevealWorkingCopy);
signPanelWorkingCopyCopyBtn.addEventListener("click", onCopyWorkingCopyPath);
signPanelInspectBtn.addEventListener("click", () => {
  setInspectRegionArmed(!inspectRegionArmed);
  renderSignPanel();
});

// Region preview modal wiring
regionPreviewCopyBtn.addEventListener("click", copyRegionCoords);
regionPreviewZoneTypeEl.addEventListener("change", updateRegionPreviewCreateButton);
regionPreviewCreateZoneBtn.addEventListener("click", useRegionPreviewAsSignatureZone);
regionPreviewDoneBtn.addEventListener("click", closeRegionPreviewModal);
regionPreviewCloseBtn.addEventListener("click", closeRegionPreviewModal);
regionPreviewModalEl.addEventListener("click", (e) => {
  if ((e.target as HTMLElement).classList.contains("sign-modal-backdrop")) closeRegionPreviewModal();
});
regionPreviewModalEl.addEventListener("keydown", (e: Event) => {
  const keyEvent = e as KeyboardEvent;
  trapModalFocus(regionPreviewModalEl, keyEvent);
  if (keyEvent.key === "Escape") closeRegionPreviewModal();
});

// Draw-signature modal wiring
signPanelDrawBtn.addEventListener("click", openDrawModal);
drawCanvasEl.addEventListener("pointerdown", onDrawPointerDown);
drawCanvasEl.addEventListener("pointermove", onDrawPointerMove);
drawCanvasEl.addEventListener("pointerup", onDrawPointerUp);
drawCanvasEl.addEventListener("pointercancel", onDrawPointerUp);
drawUndoBtn.addEventListener("click", () => {
  drawStrokes.pop();
  redrawAllStrokes();
});
drawClearBtn.addEventListener("click", () => {
  drawStrokes = [];
  redrawAllStrokes();
});
drawNameInputEl.addEventListener("input", updateDrawSaveState);
drawLegalNameInputEl.addEventListener("input", updateDrawSaveState);
drawSaveBtn.addEventListener("click", onSaveDrawnSignature);
drawCancelBtn.addEventListener("click", closeDrawModal);
drawCloseBtn.addEventListener("click", closeDrawModal);
drawModalEl.addEventListener("click", (e) => {
  if ((e.target as HTMLElement).classList.contains("sign-modal-backdrop")) closeDrawModal();
});
drawModalEl.addEventListener("keydown", (e: Event) => {
  const keyEvent = e as KeyboardEvent;
  trapModalFocus(drawModalEl, keyEvent);
  if (keyEvent.key === "Escape") closeDrawModal();
});
manageRotateCwBtn.addEventListener("click", () => rotateSelected(90));
manageRotateCcwBtn.addEventListener("click", () => rotateSelected(270));
manageDeleteBtn.addEventListener("click", deleteSelected);
manageResetBtn.addEventListener("click", resetPages);
manageApplyBtn.addEventListener("click", applyPagePlan);

searchInputEl.addEventListener("input", () => {
  if (searchDebounceTimer) clearTimeout(searchDebounceTimer);
  searchDebounceTimer = setTimeout(() => performSearch(searchInputEl.value), 300);
});

searchInputEl.addEventListener("keydown", (e) => {
  if (e.key === "Enter") { e.preventDefault(); e.shiftKey ? goToPrevMatch() : goToNextMatch(); }
  else if (e.key === "Escape") { e.preventDefault(); closeSearch(); }
});

pageInputEl.addEventListener("change", () => {
  const p = parseInt(pageInputEl.value, 10);
  if (!isNaN(p)) goToPage(p); else pageInputEl.value = String(currentPage);
});

pageInputEl.addEventListener("keydown", (e) => { if (e.key === "Enter") pageInputEl.blur(); });

// Keyboard shortcuts
document.addEventListener("keydown", (e) => {
  if (!pdfDocument) return;
  if ((e.ctrlKey || e.metaKey) && e.key === "f") {
    if (!searchOpen) { e.preventDefault(); openSearch(); }
    else if (document.activeElement === searchInputEl) { closeSearch(); }
    else { e.preventDefault(); searchInputEl.focus(); searchInputEl.select(); }
    return;
  }

  // Bail if any editable element has focus (modal inputs, page input, search input, etc.)
  // so shortcuts like space-bar-to-next-page don't steal typed characters from a form field.
  const active = document.activeElement as HTMLElement | null;
  if (active && (active.tagName === "INPUT" || active.tagName === "TEXTAREA" || active.tagName === "SELECT" || active.isContentEditable)) return;

  // Also bail when any modal is open — modals should own keyboard focus entirely.
  if (signModalEl.style.display === "flex" || drawModalEl.style.display === "flex" || regionPreviewModalEl.style.display === "flex") return;

  if ((e.ctrlKey || e.metaKey) && e.key === "0") { resetZoom(); e.preventDefault(); return; }

  switch (e.key) {
    case "Escape":
      if (searchOpen) { closeSearch(); e.preventDefault(); }
      else if (currentDisplayMode === "fullscreen") { toggleFullscreen(); e.preventDefault(); }
      break;
    case "ArrowLeft": case "PageUp": goToPage(currentPage - 1); e.preventDefault(); break;
    case "ArrowRight": case "PageDown": case " ": goToPage(currentPage + 1); e.preventDefault(); break;
    case "+": case "=": zoomIn(); e.preventDefault(); break;
    case "-": zoomOut(); e.preventDefault(); break;
  }
});

// Text selection → update context
let selectionTimer: ReturnType<typeof setTimeout> | null = null;
document.addEventListener("selectionchange", () => {
  if (selectionTimer) clearTimeout(selectionTimer);
  selectionTimer = setTimeout(() => {
    const sel = window.getSelection();
    if (sel?.toString().trim()?.length && sel.toString().trim().length > 2) updatePageContext();
  }, 300);
});

// Horizontal scroll/swipe for page navigation (at 1x zoom)
let hScrollAcc = 0;
canvasContainerEl.addEventListener("wheel", (e) => {
  if (Math.abs(e.deltaX) <= Math.abs(e.deltaY)) return;
  if (scale > 1.0) return;
  e.preventDefault();
  hScrollAcc += e.deltaX;
  if (hScrollAcc > 50) { goToPage(currentPage + 1); hScrollAcc = 0; }
  else if (hScrollAcc < -50) { goToPage(currentPage - 1); hScrollAcc = 0; }
}, { passive: false });

// Field filter
fieldFilterEl.addEventListener("input", () => {
  const q = fieldFilterEl.value.toLowerCase();
  document.querySelectorAll(".field-item").forEach(el => {
    const name = el.querySelector(".field-name")?.textContent?.toLowerCase() || "";
    (el as HTMLElement).style.display = name.includes(q) ? "" : "none";
  });
});

// ─── Tool Result Handler ─────────────────────────────────────────────────────

app.ontoolinput = params => {
  if (isTearingDown) return;
  console.log("[viewer] Tool input:", params);
  if (hasReceivedToolResult || hasReceivedToolInput) {
    toolInputConflict = true;
    latestToolInput = null;
    console.error("[viewer] Refusing duplicate, late, or interleaved tool input.");
    return;
  }
  hasReceivedToolInput = true;
  latestToolInput = getPdfToolInputData(params);
  startToolResultTimeout();
};

function applyLegacyFieldResult(result: CallToolResult) {
  const textContent = result.content?.find((content: any) => content.type === "text");
  if (!textContent) return false;
  const jsonMatch = ((textContent as any).text as string).match(/\[[\s\S]*\]/);
  if (!jsonMatch) return false;

  const parsedFields = JSON.parse(jsonMatch[0]);
  if (!Array.isArray(parsedFields)) return false;
  fields = parsedFields;
  renderFields();
  showSidebar();
  sidebarToggleBtn.style.display = "";
  return true;
}

function recoverDisplayPdfFromToolInput(
  input: PdfToolInputData,
  originalResult: CallToolResult,
  lifecycle: number,
) {
  const key = `${input.pdfPath}:${input.initialPage}`;
  if (fallbackLoad?.key === key) return fallbackLoad.promise;
  const payloadVersion = authoritativePayloadVersion;

  const promise = (async () => {
    showLoading("Recovering PDF viewer metadata...");
    try {
      const probe = await callServerToolDuringLifecycle({
        name: "read_pdf_bytes",
        arguments: { pdf_path: input.pdfPath, offset: 0, byteCount: 1 },
      }, lifecycle);
      assertViewerLifecycle(lifecycle);

      if (probe.isError) {
        throw new Error(getToolResultText(probe) || "The PDF byte proxy rejected the file.");
      }
      const probeData = probe.structuredContent as any;
      if (!Number.isSafeInteger(probeData?.totalBytes) || probeData.totalBytes <= 0) {
        throw new Error("The PDF byte proxy did not return a valid file length.");
      }

      // A complete result that arrived while the compatibility probe was
      // pending is authoritative. Do not race it with the fallback load.
      if (payloadVersion !== authoritativePayloadVersion) return true;

      const loaded = await loadPdfFromToolResult({
        content: originalResult.content || [],
        structuredContent: {
          pdfPath: input.pdfPath,
          totalBytes: probeData.totalBytes,
          initialPage: input.initialPage,
          fields: [],
          fieldCount: 0,
          hasFormFields: false,
        },
      } as CallToolResult);
      if (loaded && pdfDocument) {
        lastRecoveredDisplayResultText = getToolResultText(originalResult);
      }
      return loaded;
    } catch (err: any) {
      if (isViewerLifecycleEnded(err)) return true;
      console.error("[viewer] Failed to recover PDF viewer metadata:", err);
      showError(
        `Claude did not provide complete PDF viewer metadata, and recovery failed: ${
          err?.message || String(err)
        }`,
      );
      return true;
    }
  })();

  fallbackLoad = { key, pdfPath: input.pdfPath, promise };
  void promise.finally(() => {
    if (fallbackLoad?.promise === promise) fallbackLoad = null;
  });
  return promise;
}

app.ontoolresult = async (result: CallToolResult) => {
  if (isTearingDown) return;
  const lifecycle = captureViewerLifecycle();
  console.log("[viewer] Tool result:", result);
  const inputForResult = toolInputConflict ? null : latestToolInput;
  latestToolInput = null;
  hasReceivedToolResult = true;
  clearToolResultTimeout();

  if (result.isError) {
    const detail = getToolResultText(result);
    showError(detail ? `PDF Toolkit could not open this PDF: ${detail}` : "PDF Toolkit could not open this PDF.");
    return;
  }

  const parsedLoadData = parsePdfToolLoadData(result);
  if (isPdfWorkspaceResult(result)) {
    showWorkspace();
    return;
  }
  if (parsedLoadData.ok) {
    authoritativePayloadVersion++;
    await loadPdfFromToolResult(result, parsedLoadData.data);
    return;
  }
  if (!isViewerLifecycleCurrent(lifecycle)) return;
  const displayFileName = getDisplayPdfTextFileName(result);
  if (
    pdfDocument &&
    displayFileName &&
    getHostBaseName(pdfPath) === displayFileName &&
    getToolResultText(result) === lastRecoveredDisplayResultText
  ) {
    return;
  }

  // Claude Desktop versions that project only the text content of display_pdf
  // omit the structured load payload. Stable MCP Apps still guarantees the
  // complete tool input first, so use that exact path only for the distinctive,
  // read-only display_pdf result. Never apply this fallback to mutation results.
  if (
    (parsedLoadData.kind === "missing" || parsedLoadData.kind === "incomplete") &&
    displayFileName &&
    fallbackLoad &&
    !toolInputConflict &&
    !inputForResult &&
    getHostBaseName(fallbackLoad.pdfPath) === displayFileName
  ) {
    await fallbackLoad.promise;
    return;
  }
  if (
    (parsedLoadData.kind === "missing" || parsedLoadData.kind === "incomplete") &&
    inputForResult &&
    displayFileName &&
    getHostBaseName(inputForResult.pdfPath) === displayFileName &&
    (
      !parsedLoadData.recoverablePdfPath ||
      parsedLoadData.recoverablePdfPath === inputForResult.pdfPath
    )
  ) {
    await recoverDisplayPdfFromToolInput(inputForResult, result, lifecycle);
    return;
  }

  if (parsedLoadData.kind === "conflict" || parsedLoadData.kind === "invalid") {
    showError(parsedLoadData.message);
    return;
  }

  // Retain legacy field-only responses only when a document is already loaded.
  // They may enrich the sidebar, but must never expose an uninitialized viewer.
  try {
    const appliedFields = applyLegacyFieldResult(result);
    if (pdfDocument) {
      if (appliedFields) updatePageContext();
      return;
    }
    showError(
      "Claude did not provide the PDF viewer with complete load metadata. Retry opening the PDF.",
    );
  } catch (err: any) {
    if (isTearingDown) return;
    console.error("[viewer] Error processing tool result:", err);
    showError(err.message || "Error processing result");
  }
};

async function loadPdfFromToolResult(
  result: CallToolResult,
  parsedPayload?: PdfToolLoadData,
) {
  if (isTearingDown) return true;
  const lifecycle = captureViewerLifecycle();
  const parsed = parsedPayload ? { ok: true as const, data: parsedPayload } : parsePdfToolLoadData(result);
  if (!parsed.ok) return false;
  const payload = parsed.data;
  const nextPdfPath = payload.activePath || payload.pdfPath;
  if (payload.key === lastLoadedResultKey && pdfDocument && pdfPath === nextPdfPath) return true;
  if (payload.key === pendingLoadResultKey) return true;

  lastLoadedResultKey = payload.key;
  pendingLoadResultKey = payload.key;
  pdfPath = nextPdfPath;
  viewUUID = payload.viewUUID;
  activeBackupPath = payload.backupPath ?? null;

  if (payload.hasFormFields && payload.fieldCount > 0) {
    sidebarToggleBtn.style.display = "";
    sidebarToggleBtn.textContent = `Fields (${payload.fieldCount})`;
    fields = payload.fields as FieldInfo[];
    renderFields();
  } else {
    fields = [];
    selectedField = null;
    renderFields();
    hideSidebar();
    sidebarToggleBtn.style.display = "none";
    fillProgressEl.style.display = "none";
  }

  showLoading("Loading PDF...");

  try {
    // New doc → new preload generation so any straggler preloader from a
    // previous load (including reloadPdfForStamp) drops out.
    const loadGeneration = ++pdfGeneration;
    pdfDocument = await loadPdfProgressively(pdfPath, payload.totalBytes, loadGeneration);
    assertViewerLifecycle(lifecycle);
    totalPages = pdfDocument.numPages;

    const saved = loadSavedPage();
    currentPage = (saved && saved <= totalPages) ? saved : payload.initialPage;

    pagesLoaded = 0;
    pageTextCache.clear();
    pageStates = [];
    hasUnsavedChanges = false;

    // Reset signing state — a fresh document starts a new stamp chain.
    appliedZoneKeys.clear();
    signatureZones = [];
    zoneRequests.deletePath(pdfPath);
    updateWorkingCopyBanner();

    showViewer();
    modeTabsEl.style.display = totalPages > 1 ? "" : "none";
    if (totalPages > 1) {
      initPageStates();
    }
    updateManageActions();
    manageStatusEl.textContent = "";
    manageApplyBtn.textContent = "Save as new file";
    switchMode("view");
    syncActiveDocumentState();
    startPreloading();
  } catch (err: any) {
    if (isTearingDown || err instanceof ViewerLifecycleEndedError) return true;
    lastLoadedResultKey = "";
    console.error("[viewer] Load error:", err);
    showError(err.message || "Failed to load PDF");
  } finally {
    if (pendingLoadResultKey === payload.key) pendingLoadResultKey = "";
  }

  return true;
}

app.onerror = (err: unknown) => {
  console.error("[viewer] App error:", err);
  if (isTearingDown) return;
  showError(err instanceof Error ? err.message : String(err));
};

async function teardownViewer(): Promise<Record<string, never>> {
  isTearingDown = true;
  viewerLifecycleEpoch++;
  inspectPreviewRequestSeq++;
  zoneRequests.clear();
  clearConnectTimeout();
  clearToolResultTimeout();
  fallbackLoad = null;

  // Stop asynchronous render and preload work before acknowledging teardown.
  // The host may remove the iframe immediately after the response.
  pdfGeneration++;
  preloadPaused = false;
  pendingPage = null;
  if (searchDebounceTimer) {
    clearTimeout(searchDebounceTimer);
    searchDebounceTimer = null;
  }
  if (selectionTimer) {
    clearTimeout(selectionTimer);
    selectionTimer = null;
  }
  if (currentRenderTask) {
    try { currentRenderTask.cancel(); } catch { /* best-effort */ }
    currentRenderTask = null;
  }
  isRendering = false;

  const documentToDestroy = pdfDocument;
  pdfDocument = null;
  const loadingTasksToDestroy = [...activePdfLoadingTasks];
  await Promise.allSettled([
    ...loadingTasksToDestroy.map(loadingTask => loadingTask.destroy()),
    ...(documentToDestroy ? [documentToDestroy.destroy()] : []),
  ]);

  rangeCache.clear();
  inflightRequests.clear();
  pathCacheEpochs.clear();
  pageTextCache.clear();
  zoneWarningsByPath.clear();
  signaturePreviewCache.clear();
  return {};
}

app.onteardown = () => {
  teardownPromise ??= teardownViewer();
  return teardownPromise;
};

// ─── Host Context ────────────────────────────────────────────────────────────

function handleHostContext(ctx: McpUiHostContext) {
  if (isTearingDown) return;
  if (ctx.theme) applyDocumentTheme(ctx.theme);
  if (ctx.styles?.variables) applyHostStyleVariables(ctx.styles.variables);
  if (ctx.displayMode) {
    currentDisplayMode = ctx.displayMode as "inline" | "fullscreen";
    mainEl.classList.toggle("fullscreen", currentDisplayMode === "fullscreen");
    fullscreenBtn.title = currentDisplayMode === "fullscreen" ? "Exit fullscreen" : "Fullscreen";
    if (currentDisplayMode === "inline" && pdfDocument) requestFitToContent();
  }
}

app.onhostcontextchanged = handleHostContext;

// ─── Connect ─────────────────────────────────────────────────────────────────

connectTimeout = setTimeout(() => {
  connectTimeout = null;
  if (!isTearingDown) {
    showError("Claude did not initialize the PDF viewer connection. Retry opening the PDF.");
  }
}, BRIDGE_CONNECT_TIMEOUT_MS);

app.connect()
  .then(() => {
    clearConnectTimeout();
    console.log("[viewer] Connected");
    const ctx = app.getHostContext();
    if (ctx) handleHostContext(ctx);
    if (pdfPath) {
      syncActiveDocumentState();
    }
    if (!hasReceivedToolResult) startToolResultTimeout();
  })
  .catch((err: unknown) => {
    clearConnectTimeout();
    clearToolResultTimeout();
    console.error("[viewer] Connection failed:", err);
    if (!isTearingDown) {
      showError(err instanceof Error ? err.message : String(err));
    }
  });
