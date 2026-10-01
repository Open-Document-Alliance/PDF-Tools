import { createHash } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { HostPdfSession, decodeHostPdfBlob, encodeHostPdfBlob, parseHostPdfInput } from "../ui/src/host-pdf";

const input = { file: { name: "fixture.pdf", resourceUri: "host-resource://opaque-not-a-path" } };
const bytes = new TextEncoder().encode("%PDF-1.7\nsynthetic-test-only\n%%EOF");
const sha = (value = bytes) => createHash("sha256").update(value).digest("hex");
const deferred = () => { let resolve!: (value?: any) => void; const promise = new Promise<any>(done => { resolve = done; }); return { promise, resolve }; };

function harness(options: Record<string, any> = {}) {
  let path = "";
  let update: ((notification: any) => void) | undefined;
  let state: any;
  const localPath = "/private/workspace/host-import-generated.pdf";
  const importResult: any = { content: [], structuredContent: { pdfPath: localPath, active_path: localPath, totalBytes: bytes.length, initialPage: 1, fields: [], fieldCount: 0, hasFormFields: false, source: { canonical_path: localPath, sha256: sha(), size_bytes: bytes.length }, host_import: { version: 1, status: "imported", sha256: sha(), size_bytes: bytes.length } } };
  const remove = vi.fn(() => { update = undefined; });
  const resources: any = {
    addUpdateHandler: vi.fn((handler: any) => { update = handler; return remove; }),
    subscribe: vi.fn(async () => { if (options.subscribeFails) throw new Error("Unsupported"); }),
    unsubscribe: vi.fn(async () => ({})),
    read: vi.fn(async () => ({ contents: [{ uri: input.file.resourceUri, blob: encodeHostPdfBlob(bytes), openaiMetadata: { writable: options.writable ?? true, etag: options.etag ?? "version-1" } }] })),
    write: vi.fn(async () => options.outcome || { outcome: "saved", etag: "version-2" }),
  };
  const callTool = vi.fn(async (request: any) => {
    if (request.name === "import_host_pdf") return importResult;
    if (request.name === "get_pdf_identity") return { content: [], structuredContent: { canonical_path: path, size_bytes: bytes.length, sha256: sha() } };
    if (request.name === "read_pdf_bytes") return { content: [], structuredContent: { pdfPath: path, totalBytes: bytes.length, byteCount: bytes.length, offset: 0, bytes: encodeHostPdfBlob(bytes) } };
    throw new Error("Unexpected tool");
  });
  const session = new HostPdfSession({ resources: () => options.unsupported ? undefined : resources, callTool, currentPath: () => path, readyToSave: () => options.blocked || null, load: async () => { path = localPath; session.viewerPathChanged(path); return true; }, onState: value => { state = value; } });
  return { session, resources, callTool, importResult, remove, get state() { return state; }, get path() { return path; }, setPath: (value: string) => { path = value; }, update: (uri = input.file.resourceUri) => update?.({ method: "notifications/resources/updated", params: { uri } }) };
}

describe("OpenAI host PDF input and bounded bytes", () => {
  it("keeps the opaque URI literal and rejects extra fields rather than SDK stripping", () => {
    expect(parseHostPdfInput(input)).toEqual(input);
    expect(parseHostPdfInput({ pdf_path: "/local.pdf" })).toBeNull();
    expect(() => parseHostPdfInput({ ...input, pdf_path: "/secret.pdf" })).toThrow();
    expect(() => parseHostPdfInput({ file: { ...input.file, path: "/secret.pdf" } })).toThrow();
  });
  it.each(["../fixture.pdf", "a/b.pdf", "a\\b.pdf", "fixture.txt", "fixture.pdf\n", "", "x".repeat(256) + ".pdf"])("refuses path-like or non-PDF names %s", name => {
    expect(() => parseHostPdfInput({ file: { ...input.file, name } })).toThrow();
  });
  it.each(["", " ", "a", "a===", "YWJj\n", "YR==", "YWI= ", "____"])("refuses noncanonical base64 %s", blob => {
    expect(() => decodeHostPdfBlob(blob)).toThrow();
  });
  it("bounds before decoding and roundtrips bytes", () => {
    expect(decodeHostPdfBlob(encodeHostPdfBlob(bytes))).toEqual(bytes);
    expect(() => decodeHostPdfBlob(encodeHostPdfBlob(bytes), bytes.length - 1)).toThrow();
  });
});

describe("OpenAI host file session", () => {
  it("imports the exact host blob without leaking URI or selecting a destination, then version-saves explicitly", async () => {
    const h = harness();
    await h.session.open(input);
    expect(h.resources.read).toHaveBeenCalledWith({ uri: input.file.resourceUri, representation: "blob" });
    expect(h.callTool).toHaveBeenCalledExactlyOnceWith({ name: "import_host_pdf", arguments: { pdf_base64: encodeHostPdfBlob(bytes), display_name: "fixture.pdf" } });
    expect(h.resources.write).not.toHaveBeenCalled();
    expect(h.state.canSave).toBe(true);
    await h.session.save();
    expect(h.resources.write).toHaveBeenCalledExactlyOnceWith(input.file.resourceUri, { blob: encodeHostPdfBlob(bytes), ifMatch: "version-1" });
    expect(h.state.message).toMatch(/^Saved back/);
    await h.session.save();
    expect(h.resources.write.mock.calls[1][1].ifMatch).toBe("version-2");
  });
  it.each([{ writable: false }, { etag: "" }, { etag: "  " }, { subscribeFails: true }])("retains a readable local copy without unsafe write authority %j", async options => {
    const h = harness(options);
    await h.session.open(input);
    expect(h.state.associated).toBe(true);
    expect(h.state.canSave).toBe(false);
    await expect(h.session.save()).rejects.toThrow();
    expect(h.resources.write).not.toHaveBeenCalled();
  });
  it("does not call any server tool when the extension is unsupported", async () => {
    const h = harness({ unsupported: true });
    await expect(h.session.open(input)).rejects.toThrow(/display_pdf/);
    expect(h.callTool).not.toHaveBeenCalled();
    expect(h.state.associated).toBe(false);
  });
  it.each(["uri", "text", "duplicate", "digest", "size", "source", "error"])("refuses mismatched host/import representation %s", async kind => {
    const h = harness();
    if (kind === "uri") h.resources.read.mockResolvedValue({ contents: [{ uri: "host-resource://different", blob: encodeHostPdfBlob(bytes) }] });
    if (kind === "text") h.resources.read.mockResolvedValue({ contents: [{ uri: input.file.resourceUri, text: "not-binary" }] });
    if (kind === "duplicate") h.resources.read.mockResolvedValue({ contents: [{ uri: input.file.resourceUri, blob: encodeHostPdfBlob(bytes) }, { uri: input.file.resourceUri, blob: encodeHostPdfBlob(bytes) }] });
    if (kind === "digest") h.importResult.structuredContent.host_import.sha256 = "f".repeat(64);
    if (kind === "size") h.importResult.structuredContent.host_import.size_bytes++;
    if (kind === "source") h.importResult.structuredContent.source.sha256 = "f".repeat(64);
    if (kind === "error") h.importResult.isError = true;
    await expect(h.session.open(input)).rejects.toThrow();
    expect(h.state.canSave).toBe(false);
    expect(h.resources.write).not.toHaveBeenCalled();
  });
  it.each([{ outcome: "conflict", etag: "new-host-version" }, { outcome: "too-large", maxBytes: 1 }])("retains the local copy on host outcome %j without retry", async outcome => {
    const h = harness({ outcome });
    await h.session.open(input);
    await h.session.save();
    expect(h.resources.write).toHaveBeenCalledTimes(1);
    expect(h.path).toContain("host-import-generated.pdf");
    expect(h.state.message).toContain("local copy is retained");
    if (outcome.outcome === "conflict") expect(h.state.canSave).toBe(false);
  });
  it("removes handlers/unsubscribes on unrelated document loads and teardown", async () => {
    const h = harness();
    await h.session.open(input);
    h.setPath("/different.pdf");
    h.session.viewerPathChanged(h.path);
    await Promise.resolve();
    expect(h.remove).toHaveBeenCalledTimes(1);
    expect(h.resources.unsubscribe).toHaveBeenCalledWith({ uri: input.file.resourceUri });
    expect(h.state.associated).toBe(false);
    await h.session.dispose();
    await expect(h.session.open(input)).rejects.toThrow();
  });
  it("allows only an explicit local mutation to carry association to a new output", async () => {
    const h = harness();
    await h.session.open(input);
    h.session.viewerPathChanged("/private/workspace/managed.pdf", h.path);
    h.setPath("/private/workspace/managed.pdf");
    h.session.viewerPathChanged(h.path);
    expect(h.state.canSave).toBe(true);
  });
  it("blocks stale files without dropping the local copy", async () => {
    const h = harness();
    await h.session.open(input);
    h.update("host-resource://other");
    expect(h.state.canSave).toBe(true);
    h.update();
    expect(h.state.stale).toBe(true);
    await expect(h.session.save()).rejects.toThrow();
    expect(h.resources.write).not.toHaveBeenCalled();
  });
  it("does not allow two synchronous open calls through the clear await", async () => {
    const h = harness();
    const first = h.session.open(input);
    await expect(h.session.open(input)).rejects.toThrow(/already active/);
    await first;
    expect(h.callTool).toHaveBeenCalledTimes(1);
  });
  it.each(["Save your page changes as a local copy first", "Local document mutation pending", "PDF load failed"])("blocks save when the actual viewer reports %s", async blocked => {
    const options: Record<string, any> = {};
    const h = harness(options);
    await h.session.open(input);
    options.blocked = blocked;
    h.session.refresh();
    expect(h.state.canSave).toBe(false);
    expect(h.state.blockedReason).toBe(blocked);
    await expect(h.session.save()).rejects.toThrow(blocked);
    expect(h.resources.write).not.toHaveBeenCalled();
  });
  it("rechecks pending UI edits immediately before host write", async () => {
    const options: Record<string, any> = {};
    const h = harness(options);
    await h.session.open(input);
    const original = h.callTool.getMockImplementation()!;
    h.callTool.mockImplementation(async (request: any) => {
      const result = await original(request);
      if (request.name === "read_pdf_bytes") options.blocked = "Save your page changes as a local copy first";
      return result;
    });
    await expect(h.session.save()).rejects.toThrow(/page changes/);
    expect(h.resources.write).not.toHaveBeenCalled();
  });
  it("cleans a late successful subscription after teardown without reading or importing", async () => {
    const h = harness();
    const gate = deferred();
    h.resources.subscribe.mockImplementation(() => gate.promise);
    const opening = h.session.open(input);
    await vi.waitFor(() => expect(h.resources.subscribe).toHaveBeenCalledTimes(1));
    await h.session.dispose();
    gate.resolve({});
    await expect(opening).rejects.toThrow(/session ended/);
    expect(h.resources.unsubscribe).toHaveBeenCalledTimes(1);
    expect(h.resources.read).not.toHaveBeenCalled();
  });
  it("cancels a synchronous open-plus-dispose before any resource subscription", async () => {
    const h = harness();
    const opening = h.session.open(input);
    await h.session.dispose();
    await expect(opening).rejects.toThrow(/session ended/);
    expect(h.resources.subscribe).not.toHaveBeenCalled();
    expect(h.resources.read).not.toHaveBeenCalled();
    expect(h.callTool).not.toHaveBeenCalled();
  });
  it("refuses a stale notification between the subscription and read", async () => {
    const h = harness();
    h.resources.read.mockImplementation(async () => { h.update(); return { contents: [{ uri: input.file.resourceUri, blob: encodeHostPdfBlob(bytes), openaiMetadata: { writable: true, etag: "v1" } }] }; });
    await h.session.open(input);
    expect(h.state.stale).toBe(true);
    expect(h.state.canSave).toBe(false);
  });
  it("truthfully reports an own-write update delivered before the successful response", async () => {
    const h = harness();
    await h.session.open(input);
    h.resources.write.mockImplementation(async () => { h.update(); return { outcome: "saved", etag: "version-2" }; });
    await h.session.save();
    expect(h.state.message).toContain("host confirmed the save");
    expect(h.state.canSave).toBe(false);
    expect(h.resources.write).toHaveBeenCalledTimes(1);
  });
  it.each(["bytes", "identity", "path", "stale", "teardown"])("prevents writes if %s changes during save assembly", async kind => {
    const h = harness();
    await h.session.open(input);
    const original = h.callTool.getMockImplementation()!;
    h.callTool.mockImplementation(async (request: any) => {
      const result: any = await original(request);
      if (request.name === "read_pdf_bytes") {
        if (kind === "bytes") result.structuredContent.bytes = encodeHostPdfBlob(new Uint8Array(bytes.length).fill(32));
        if (kind === "identity") result.structuredContent.totalBytes++;
        if (kind === "path") { h.setPath("/other.pdf"); h.session.viewerPathChanged(h.path); }
        if (kind === "stale") h.update();
        if (kind === "teardown") await h.session.dispose();
      }
      return result;
    });
    await expect(h.session.save()).rejects.toThrow();
    expect(h.resources.write).not.toHaveBeenCalled();
  });
});
