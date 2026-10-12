import { readFileSync } from "node:fs";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createExtractionReviewToolHandler } from "../server/extraction-review.js";
import { evidenceFixture } from "./helpers/evidence-review-fixture.js";

const harness = vi.hoisted(() => ({ app: null as any, getDocument: null as any, callTool: null as any, capabilities: {} as any, messages: [] as any[] }));
vi.mock("@modelcontextprotocol/ext-apps", () => ({
  App: class {
    constructor() { harness.app = this; }
    async connect() {}
    getHostContext() { return undefined; }
    getHostCapabilities() { return harness.capabilities; }
    async sendMessage(message: any) { harness.messages.push(message); return {}; }
    callServerTool(request: any) { return harness.callTool(request); }
    async updateModelContext() {}
    async sendSizeChanged() {}
  },
  applyDocumentTheme() {},
  applyHostStyleVariables() {},
}));
vi.mock("@openai/mcp-extensions/app", () => ({
  OpenAIExtensions: class {},
  OpenAIFileEntrypointInputSchema: {},
}));
vi.mock("pdfjs-dist/build/pdf.worker.mjs", () => ({}));
vi.mock("pdfjs-dist", () => ({
  version: "test-renderer",
  GlobalWorkerOptions: {},
  PDFDataRangeTransport: class { constructor(public length: number) {} },
  getDocument: (options: any) => harness.getDocument(options),
  TextLayer: class {
    constructor(private options: any) {}
    async render() {
      this.options.container.textContent = "";
      for (const item of this.options.textContentSource.items) {
        const span = document.createElement("span");
        span.textContent = item.str;
        this.options.container.appendChild(span);
      }
    }
    cancel() {}
  },
}));

function deferred<T = any>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

// DOM operations remain observable. This is an app/transport integration test
// with a controlled renderer, not browser layout or native-host evidence.
class Element {
  style: any = { setProperty() {} };
  dataset: any = {};
  value = "";
  text = "";
  get textContent(): string { return this.text + this.children.map(child => child.textContent).join(""); }
  set textContent(value: string) { this.text = value; this.children = []; }
  disabled = false;
  hidden = false;
  width = 600;
  height = 800;
  offsetHeight = 20;
  children: Element[] = [];
  parentElement: Element | null = null;
  listeners = new Map<string, Function[]>();
  classes = new Set<string>();
  classList = {
    add: (...names: string[]) => names.forEach(name => this.classes.add(name)),
    remove: (...names: string[]) => names.forEach(name => this.classes.delete(name)),
    contains: (name: string) => this.classes.has(name),
    toggle: (name: string, enabled = !this.classes.has(name)) => enabled ? this.classes.add(name) : this.classes.delete(name),
  };
  constructor(public tagName = "DIV") {}
  get firstChild() { return this.children[0]; }
  appendChild(child: Element) { child.parentElement = this; this.children.push(child); return child; }
  append(...children: Element[]) { children.forEach(child => this.appendChild(child)); }
  removeChild(child: Element) { this.children.splice(this.children.indexOf(child), 1); }
  remove() { this.parentElement?.removeChild(this); }
  addEventListener(type: string, listener: Function) { this.listeners.set(type, [...this.listeners.get(type) || [], listener]); }
  removeEventListener(type: string, listener: Function) { this.listeners.set(type, (this.listeners.get(type) || []).filter(value => value !== listener)); }
  setPointerCapture() {}
  releasePointerCapture() {}
  cloneNode() { return new Element(this.tagName); }
  closest() { return null; }
  setAttribute(name: string, value: string) { (this as any)[name] = value; }
  toggleAttribute() {}
  querySelectorAll(selector: string): Element[] {
    return this.children.flatMap(child => [
      ...((selector === "span" && child.tagName === "SPAN") || (selector.startsWith(".") && child.classes.has(selector.slice(1))) ? [child] : []),
      ...child.querySelectorAll(selector),
    ]);
  }
  querySelector() { return new Element(); }
  getBoundingClientRect() { return { width: 600, height: 800, top: 0, left: 0 }; }
  getContext() { return { scale() {}, fillRect() {} }; }
  toDataURL() { return "data:image/png;base64,AA=="; }
  click() {
    for (let node: Element | null = this; node; node = node.parentElement) {
      if (node.hidden || node.style.display === "none") throw new Error("Cannot click a hidden control");
    }
    if (!this.disabled) this.listeners.get("click")?.forEach(listener => listener({ target: this }));
  }
}

let elements: Map<string, Element>;
let observers: any[];
let documents: any[];
let tasks: any[];
let bytes: string;
let readCalls: any[];
let readOverride: ((request: any, response: any) => any) | null;
let destroyOverride: ((document: any) => any) | null;
let getDataOverride: ((text: string) => any) | null;

const result = (uuid: string, path = "/fixtures/current.pdf") => ({
  content: [],
  structuredContent: { pdfPath: path, totalBytes: bytes.length, initialPage: 1 },
  _meta: { viewUUID: uuid },
});
const element = (id: string) => elements.get(id)!;

beforeEach(async () => {
  vi.resetModules();
  elements = new Map();
  // Keep the controls' actual initial display values from the shipped markup.
  const html = readFileSync("ui/index.html", "utf8");
  for (const match of html.matchAll(/<([a-z]+)[^>]*\bid="([^"]+)"[^>]*>/g)) {
    const node = new Element(match[1].toUpperCase());
    const display = match[0].match(/style="[^"]*display:\s*([^;" ]+)/)?.[1];
    if (display) node.style.display = display;
    elements.set(match[2], node);
  }
  for (const id of ["mode-view-btn", "mode-manage-btn", "mode-sign-btn"]) element(id).parentElement = element("mode-tabs");
  element("mode-tabs").parentElement = element("viewer");
  const structural = new Map<string, Element>();
  const dom = {
    getElementById: (id: string) => elements.get(id),
    querySelector: (selector: string) => { if (!structural.has(selector)) structural.set(selector, new Element()); return structural.get(selector); },
    querySelectorAll: () => [],
    createElement: (tag: string) => new Element(tag.toUpperCase()),
    addEventListener() {},
    body: new Element("BODY"),
    documentElement: new Element("HTML"),
  };
  vi.stubGlobal("document", dom);
  vi.stubGlobal("window", { devicePixelRatio: 1, getSelection: () => null });
  vi.stubGlobal("getComputedStyle", () => ({ paddingTop: "0", paddingBottom: "0", visibility: "visible" }));
  vi.stubGlobal("requestAnimationFrame", (callback: Function) => queueMicrotask(() => callback(0)));
  observers = [];
  vi.stubGlobal("IntersectionObserver", class {
    observed: Element[] = [];
    disconnect = vi.fn();
    constructor(public callback: Function) { observers.push(this); }
    observe(element: Element) { this.observed.push(element); }
    unobserve() {}
    fire() { this.callback(this.observed.map(target => ({ target, isIntersecting: true }))); }
  });
  vi.stubGlobal("localStorage", { getItem: () => null });
  documents = [];
  tasks = [];
  bytes = "OLD";
  readCalls = [];
  readOverride = null;
  destroyOverride = null;
  getDataOverride = null;
  harness.capabilities = {};
  harness.messages = [];
  harness.callTool = async (request: any) => {
    if (request.name !== "read_pdf_bytes") return { content: [], structuredContent: { zones: [], pages: [], signatures: [] } };
    readCalls.push(request);
    const { pdf_path, offset, byteCount } = request.arguments;
    const chunk = bytes.slice(offset, offset + byteCount);
    const response = { content: [], structuredContent: { pdfPath: pdf_path, offset, byteCount: chunk.length, totalBytes: bytes.length, bytes: btoa(chunk) } };
    return readOverride ? readOverride(request, response) : response;
  };
  harness.getDocument = vi.fn(({ range }: any) => {
    const loaded = deferred();
    // Match PDF.js: destroy can resolve without settling the public load promise.
    const task = { promise: loaded.promise, destroy: vi.fn(async () => {}), range, resolve: loaded.resolve };
    tasks.push(task);
    range.onDataRange = vi.fn((_offset: number, data: Uint8Array) => {
      const text = new TextDecoder().decode(data);
      const document = {
        numPages: 1,
        text,
        getData: async () => getDataOverride ? getDataOverride(text) : new TextEncoder().encode(text),
        destroy: vi.fn(async () => { if (destroyOverride) await destroyOverride(document); }),
        getPage: async () => ({
          getViewport: () => ({ width: 600, height: 800 }),
          getTextContent: async () => ({ items: [{ str: text }] }),
          render: () => ({ promise: Promise.resolve(), cancel() {} }),
        }),
      };
      documents.push(document);
      loaded.resolve(document);
    });
    queueMicrotask(() => range.requestDataRange(0, range.length));
    return task;
  });
  await import("../ui/src/mcp-app");
});

afterEach(async () => {
  destroyOverride = null;
  await harness.app?.onteardown?.();
  vi.unstubAllGlobals();
});

describe("viewer document sessions", () => {
  it("keeps Sign and Manage reachable for a one-page PDF", async () => {
    await harness.app.ontoolresult(result("single"));
    element("mode-sign-btn").click();
    expect(element("sign-panel").style.display).toBe("flex");
    element("mode-manage-btn").click();
    expect(element("manage-panel").style.display).toBe("flex");
    expect(element("manage-grid").children).toHaveLength(1);
    expect((element("manage-grid").children[0] as any).className).toBe("manage-thumb-item");
  });

  it("preserves a thumbnail through pointerup so the following click selects its page", async () => {
    await harness.app.ontoolresult(result("single"));
    element("mode-manage-btn").click();
    const grid = element("manage-grid");
    const thumbnail = grid.children[0];
    expect(element("manage-rotate-cw").disabled).toBe(true);
    thumbnail.listeners.get("pointerdown")!.forEach(listener => listener({
      target: thumbnail, currentTarget: thumbnail, pointerId: 1, clientX: 20, clientY: 20,
    }));
    thumbnail.listeners.get("pointerup")!.slice().forEach(listener => listener({ pointerId: 1 }));
    expect(grid.children[0]).toBe(thumbnail);
    thumbnail.click();
    expect(element("manage-rotate-cw").disabled).toBe(false);
    element("manage-rotate-cw").click();
    expect(element("manage-status").textContent).toContain("1 rotated");
  });

  it("reloads changed same-path bytes for a new view and destroys the previous document", async () => {
    await harness.app.ontoolresult(result("first"));
    await vi.waitFor(() => expect(element("text-layer").textContent).toBe("OLD"));
    bytes = "NEW";
    await harness.app.ontoolresult(result("second"));
    await vi.waitFor(() => expect(element("text-layer").textContent).toBe("NEW"));
    expect(readCalls).toHaveLength(2);
    expect(documents[0].destroy).toHaveBeenCalledTimes(1);
  });

  it("does not reload a duplicate result for the same completed view", async () => {
    await harness.app.ontoolresult(result("first"));
    await harness.app.ontoolresult(result("first"));
    expect(readCalls).toHaveLength(1);
    expect(documents[0].destroy).not.toHaveBeenCalled();
  });

  it("drops late ranges from a cancelled load even when the replacement has the same path", async () => {
    const held = deferred();
    readOverride = (_request, response) => held.promise.then(() => response);
    const first = harness.app.ontoolresult(result("first"));
    await vi.waitFor(() => expect(readCalls).toHaveLength(1));
    readOverride = null;
    bytes = "NEW";
    await harness.app.ontoolresult(result("second"));
    held.resolve(undefined);
    await first;
    await vi.waitFor(() => expect(element("text-layer").textContent).toBe("NEW"));
    expect(tasks[0].destroy).toHaveBeenCalled();
    expect(tasks[0].range.onDataRange).not.toHaveBeenCalled();
    expect(element("error").style.display).toBe("none");
  });

  it("destroys a parsed document that resolves after its load was cancelled", async () => {
    const held = deferred();
    readOverride = (_request, response) => held.promise.then(() => response);
    const first = harness.app.ontoolresult(result("first"));
    await vi.waitFor(() => expect(readCalls).toHaveLength(1));
    readOverride = null;
    bytes = "NEW";
    await harness.app.ontoolresult(result("second"));
    await first;
    const late = { destroy: vi.fn(async () => {}) };
    tasks[0].resolve(late);
    held.resolve(undefined);
    await vi.waitFor(() => expect(late.destroy).toHaveBeenCalledTimes(1));
    expect(element("error").style.display).toBe("none");
  });

  it("serializes disposal and lets only the newest replacement begin loading", async () => {
    await harness.app.ontoolresult(result("first"));
    const held = deferred();
    destroyOverride = () => held.promise;
    bytes = "MID";
    const second = harness.app.ontoolresult(result("second"));
    bytes = "NEW";
    const third = harness.app.ontoolresult(result("third", "/fixtures/other.pdf"));
    await Promise.resolve();
    expect(harness.getDocument).toHaveBeenCalledTimes(1);
    held.resolve(undefined);
    await Promise.all([second, third]);
    await vi.waitFor(() => expect(element("text-layer").textContent).toBe("NEW"));
    expect(harness.getDocument).toHaveBeenCalledTimes(2);
    expect(readCalls[1].arguments.pdf_path).toBe("/fixtures/other.pdf");
    expect(element("error").style.display).toBe("none");
  });

  it("ignores an old page request that completes after the replacement rendered", async () => {
    await harness.app.ontoolresult(result("first"));
    await vi.waitFor(() => expect(element("text-layer").textContent).toBe("OLD"));
    const held = deferred();
    const oldPage = await documents[0].getPage(1);
    const oldRender = vi.spyOn(oldPage, "render");
    documents[0].getPage = () => held.promise;
    element("zoom-in-btn").click();
    bytes = "NEW";
    await harness.app.ontoolresult(result("second"));
    await vi.waitFor(() => expect(element("text-layer").textContent).toBe("NEW"));
    held.resolve(oldPage);
    await Promise.resolve();
    await Promise.resolve();
    expect(oldRender).not.toHaveBeenCalled();
    expect(element("text-layer").textContent).toBe("NEW");
  });

  it("cancels the active canvas render and waits for its disposal before replacement", async () => {
    await harness.app.ontoolresult(result("first"));
    await vi.waitFor(() => expect(element("text-layer").textContent).toBe("OLD"));
    const held = deferred();
    const oldPage = await documents[0].getPage(1);
    const cancel = vi.fn(() => held.reject(Object.assign(new Error("Cancelled"), { name: "RenderingCancelledException" })));
    oldPage.render = () => ({ promise: held.promise, cancel });
    const getPage = vi.fn(async () => oldPage);
    documents[0].getPage = getPage;
    element("zoom-in-btn").click();
    await vi.waitFor(() => expect(getPage).toHaveBeenCalled());
    bytes = "NEW";
    await harness.app.ontoolresult(result("second"));
    await vi.waitFor(() => expect(element("text-layer").textContent).toBe("NEW"));
    expect(cancel).toHaveBeenCalledTimes(1);
    expect(documents[0].destroy).toHaveBeenCalledTimes(1);
    expect(element("error").style.display).toBe("none");
  });

  it("cancels a held thumbnail render and disconnects its observer on replacement", async () => {
    await harness.app.ontoolresult(result("first"));
    await vi.waitFor(() => expect(element("text-layer").textContent).toBe("OLD"));
    const held = deferred();
    const oldPage = await documents[0].getPage(1);
    const cancel = vi.fn(() => held.reject(Object.assign(new Error("Cancelled"), { name: "RenderingCancelledException" })));
    const render = vi.fn(() => ({ promise: held.promise, cancel }));
    oldPage.render = render;
    documents[0].getPage = async () => oldPage;
    element("mode-manage-btn").click();
    const observer = observers[0];
    observer.fire();
    await vi.waitFor(() => expect(render).toHaveBeenCalled());
    bytes = "NEW";
    await harness.app.ontoolresult(result("second"));
    await vi.waitFor(() => expect(element("text-layer").textContent).toBe("NEW"));
    expect(cancel).toHaveBeenCalledTimes(1);
    expect(observer.disconnect).toHaveBeenCalled();
    observer.fire();
    expect(render).toHaveBeenCalledTimes(1);
    expect(element("error").style.display).toBe("none");
  });

  it("allows a stable canonical path for an authorized alias", async () => {
    readOverride = (_request, response) => {
      response.structuredContent.pdfPath = "/fixtures/canonical.pdf";
      return response;
    };
    await harness.app.ontoolresult(result("alias", "/fixtures/alias.pdf"));
    await vi.waitFor(() => expect(element("text-layer").textContent).toBe("OLD"));
  });

  it("refuses a canonical-path change between chunks in the same load", async () => {
    bytes = "X".repeat(524291);
    readOverride = (request, response) => {
      response.structuredContent.pdfPath = request.arguments.offset === 0 ? "/first.pdf" : "/second.pdf";
      return response;
    };
    await harness.app.ontoolresult(result("path-change"));
    expect(readCalls).toHaveLength(2);
    expect(tasks[0].range.onDataRange).not.toHaveBeenCalled();
    expect(element("error").style.display).toBe("block");
  });

  it("tears down without waiting for a held tool response or publishing its late bytes", async () => {
    const held = deferred();
    readOverride = (_request, response) => held.promise.then(() => response);
    const first = harness.app.ontoolresult(result("pending"));
    await vi.waitFor(() => expect(readCalls).toHaveLength(1));
    await harness.app.onteardown();
    held.resolve(undefined);
    await first;
    expect(tasks[0].destroy).toHaveBeenCalled();
    expect(tasks[0].range.onDataRange).not.toHaveBeenCalled();
    expect(documents).toHaveLength(0);
  });

  it.each(["offset", "byteCount", "totalBytes", "bytes"])("rejects a mismatched %s instead of hanging a range load", async field => {
    readOverride = (_request, response) => {
      response.structuredContent[field] = field === "bytes" ? "AA==" : 999;
      return response;
    };
    await harness.app.ontoolresult(result("invalid"));
    expect(element("error").style.display).toBe("block");
    expect(tasks[0].destroy).toHaveBeenCalled();
    expect(tasks[0].range.onDataRange).not.toHaveBeenCalled();
  });
});

describe("Evidence mode through the app entrypoint", () => {
  const button = (label: string): Element | undefined => {
    const visit = (root: Element): Element | undefined => root.tagName === "BUTTON" && root.textContent === label
      ? root : root.children.map(visit).find(Boolean);
    return visit(element("evidence-panel"));
  };
  async function openEvidence() {
    const fixture = evidenceFixture(Buffer.from("OLD"));
    const handle = createExtractionReviewToolHandler({
      workspaceRoot: "/workspaces", resolvePdfPath: value => value,
      readPdfBytes: async () => Buffer.from(bytes), readReviewState: async () => fixture.retained,
    });
    const transport = harness.callTool;
    const reviewCalls: any[] = [];
    harness.callTool = async (request: any) => {
      if (request.name !== "review_extraction_workspace") return transport(request);
      reviewCalls.push(request);
      return handle(request.arguments);
    };
    await harness.app.ontoolresult(await handle(fixture.args));
    return { ...fixture, handle, reviewCalls };
  }

  it("opens values bound to loaded bytes, shows coverage, and highlights an exact citation", async () => {
    await openEvidence();
    const panel = element("evidence-panel");
    expect(panel.style.display).toBe("flex");
    expect(panel.textContent).toContain("Loaded PDF bytes match");
    expect(panel.textContent).toContain("1 of 3 exact or computed · 1 unresolved");
    expect(panel.textContent).toContain("source_supported");
    button("Page coverage")!.click();
    await vi.waitFor(() => expect(panel.textContent).toContain("Visual inspection needed"));
    expect(panel.textContent).toContain("IMAGE_REQUIRES_INSPECTION");
    button("Values")!.click();
    await vi.waitFor(() => expect(button("History and citations (1)")).toBeDefined());
    button("History and citations (1)")!.click();
    await vi.waitFor(() => expect(button("View citation on page 1")).toBeDefined());
    button("View citation on page 1")!.click();
    expect(panel.textContent).toContain("one exact quote match");
    expect(element("text-layer").children[0].classList.contains("evidence-citation-highlight")).toBe(true);
    element("mode-view-btn").click();
    expect(element("text-layer").children[0].classList.contains("evidence-citation-highlight")).toBe(false);
  });

  it("keeps uncertain values unresolved and sends a generation-bound correction request only after a click", async () => {
    const fixture = await openEvidence();
    harness.capabilities = { message: { text: true } };
    expect(harness.messages).toHaveLength(0);
    button("Ask agent to correct")!.click();
    await vi.waitFor(() => expect(harness.messages).toHaveLength(1));
    const prompt = harness.messages[0].content[0].text;
    expect(prompt).toContain(fixture.retained.generation_sha256);
    expect(prompt).toContain(fixture.retained.workspace_identity.source.sha256);
    expect(prompt).toContain("source_supported");
    expect(prompt).toContain("append a correction proposal");
    expect(fixture.reviewCalls).toHaveLength(1);
    expect(fixture.reviewCalls[0].arguments.expected_generation_sha256).toBe(fixture.retained.generation_sha256);
    expect(element("evidence-panel").textContent).toContain("source_supported");
  });

  it("blocks stale generation corrections and refreshes without promoting historical results", async () => {
    const fixture = await openEvidence();
    harness.capabilities = { message: { text: true } };
    fixture.propose("/field_0", "corrected proposal");
    fixture.retained.generation_sha256 = "9".repeat(64);
    button("Ask agent to correct")!.click();
    await vi.waitFor(() => expect(element("evidence-panel").textContent).toContain("Workspace changed"));
    expect(harness.messages).toHaveLength(0);
    expect(button("Ask agent to correct")!.disabled).toBe(true);
    button("Refresh")!.click();
    await vi.waitFor(() => expect(element("evidence-panel").textContent).toContain("corrected proposal"));
    expect(element("evidence-panel").textContent).toContain("Current · unverified");
    expect(button("Ask agent to verify")!.disabled).toBe(false);
  });

  it("refuses evidence from equal-size but different loaded PDF bytes", async () => {
    const fixture = evidenceFixture(Buffer.from("OLD"));
    const handle = createExtractionReviewToolHandler({ workspaceRoot: "/workspaces", resolvePdfPath: value => value, readPdfBytes: async () => Buffer.from("OLD"), readReviewState: async () => fixture.retained });
    bytes = "NEW";
    await harness.app.ontoolresult(await handle(fixture.args));
    expect(element("evidence-panel").textContent).toContain("loaded PDF bytes do not match");
    expect(button("Ask agent to correct")).toBeUndefined();
    expect(button("Page coverage")).toBeUndefined();
  });

  it("discards a held review response when another document replaces the source", async () => {
    await openEvidence();
    const transport = harness.callTool;
    const held = deferred();
    harness.callTool = async (request: any) => {
      const response = await transport(request);
      if (request.name === "review_extraction_workspace") await held.promise;
      return response;
    };
    button("Page coverage")!.click();
    bytes = "NEW";
    await harness.app.ontoolresult(result("replacement", "/fixtures/other.pdf"));
    held.resolve(undefined);
    await Promise.resolve();
    element("mode-evidence-btn").click();
    expect(element("evidence-panel").textContent).not.toContain("IMAGE_REQUIRES_INSPECTION");
    expect(element("evidence-panel").textContent).toContain("Open an extraction workspace");
  });

  it("discards source verification still in flight when another document loads", async () => {
    const held = deferred<Uint8Array>();
    getDataOverride = () => held.promise;
    const opening = openEvidence();
    await vi.waitFor(() => expect(element("evidence-panel").textContent).toContain("Checking that the loaded PDF bytes"));
    getDataOverride = null;
    bytes = "NEW";
    await harness.app.ontoolresult(result("other-document", "/fixtures/other.pdf"));
    held.resolve(new TextEncoder().encode("OLD"));
    await opening;
    element("mode-evidence-btn").click();
    expect(element("evidence-panel").textContent).not.toContain("Source matched");
    expect(element("evidence-panel").textContent).toContain("Open an extraction workspace");
  });

  it("labels truncated citation previews and never highlights a guessed region", async () => {
    const fixture = await openEvidence();
    fixture.retained.events[1].verification_result.citations[0].quote = "OLD".repeat(1000);
    button("History and citations (1)")!.click();
    await vi.waitFor(() => expect(button("View citation on page 1")).toBeDefined());
    button("View citation on page 1")!.click();
    expect(element("evidence-panel").textContent).toContain("Quote preview is truncated");
    expect(element("text-layer").children[0].classList.contains("evidence-citation-highlight")).toBe(false);
  });
});
