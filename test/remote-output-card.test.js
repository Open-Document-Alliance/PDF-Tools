import vm from "node:vm";
import { webcrypto, createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { installOutputCard, outputResource, OUTPUT_RESOURCE_URI, OUTPUT_TOOL_NAMES } from "../remote/output-card.mjs";
import { listTools, callTool } from "../remote/server.mjs";
import { PDFDocument } from "pdf-lib";

function card() {
  const listeners = {};
  const posted = [];
  const revoked = [];
  const elements = Object.fromEntries(["status", "download", "identity"].map(id => [id, { textContent: "", hidden: true, removeAttribute(name) { delete this[name]; } }]));
  const parent = { postMessage: message => posted.push(message) };
  const window = { parent, addEventListener: (name, callback) => { listeners[name] = callback; } };
  const context = vm.createContext({ window, document: { getElementById: id => elements[id], documentElement: { scrollWidth: 400, scrollHeight: 180 } },
    URL: { createObjectURL: () => "blob:verified-output", revokeObjectURL: url => revoked.push(url) }, Blob,
    crypto: webcrypto, atob: value => Buffer.from(value, "base64").toString("binary"), Uint8Array,
  });
  vm.runInContext(`(${installOutputCard.toString()})()`, context);
  const message = data => listeners.message({ source: parent, data: { jsonrpc: "2.0", ...data } });
  return { elements, posted, revoked, message, listeners, parent };
}
async function result() {
  const document = await PDFDocument.create(); document.addPage();
  const bytes = Buffer.from(await document.save());
  return { structuredContent: { pdf_base64: bytes.toString("base64"), output: { size_bytes: bytes.length, sha256: createHash("sha256").update(bytes).digest("hex") } } };
}
async function settled() { await new Promise(resolve => setTimeout(resolve, 20)); }

describe("bounded PDF output card", () => {
  it("registers a self-contained MCP Apps resource with no network connection", () => {
    const resource = outputResource().contents[0];
    expect(resource.uri).toBe(OUTPUT_RESOURCE_URI);
    expect(resource.mimeType).toBe("text/html;profile=mcp-app");
    expect(resource._meta.ui.csp.connectDomains).toEqual([]);
    expect(resource.text).not.toMatch(/<script[^>]+src=|localStorage|innerHTML|fetch\(/);
    for (const tool of listTools().tools) expect(tool._meta.ui?.resourceUri).toBe(OUTPUT_TOOL_NAMES.has(tool.name) ? OUTPUT_RESOURCE_URI : undefined);
  });
  it("waits for the host handshake, verifies bytes and offers a real blob download", async () => {
    const view = card();
    expect(view.posted[0].method).toBe("ui/initialize");
    view.message({ method: "ui/notifications/tool-result", params: await result() });
    expect(view.elements.download.hidden).toBe(true);
    view.message({ id: "pdf-tools-initialize", result: { protocolVersion: "2026-01-26" } });
    await settled();
    expect(view.posted[1].method).toBe("ui/notifications/initialized");
    expect(view.elements.download.href).toBe("blob:verified-output");
    expect(view.elements.download.download).toBe("pdf-tools-copy.pdf");
    expect(view.elements.download.hidden).toBe(false);
    expect(view.elements.identity.textContent).toContain("SHA-256");
  });
  it.each(["hash", "size", "bytes"])("withholds the download when %s is substituted", async drift => {
    const view = card(); view.message({ id: "pdf-tools-initialize", result: {} });
    const data = await result();
    if (drift === "hash") data.structuredContent.output.sha256 = "f".repeat(64);
    if (drift === "size") data.structuredContent.output.size_bytes++;
    if (drift === "bytes") data.structuredContent.pdf_base64 = "SGVsbG8=";
    view.message({ method: "ui/notifications/tool-result", params: data }); await settled();
    expect(view.elements.download.hidden).toBe(true);
    expect(view.elements.status.textContent).toMatch(/could not be verified/);
  });
  it("revokes bytes on cancellation and does not accept another window's messages", async () => {
    const view = card(); view.message({ id: "pdf-tools-initialize", result: {} });
    view.listeners.message({ source: {}, data: { jsonrpc: "2.0", method: "ui/notifications/tool-result", params: await result() } });
    await settled(); expect(view.elements.download.hidden).toBe(true);
    view.message({ method: "ui/notifications/tool-result", params: await result() }); await settled();
    view.message({ method: "ui/notifications/tool-cancelled" });
    expect(view.revoked).toEqual(["blob:verified-output"]);
    expect(view.elements.download.hidden).toBe(true);
  });
  it.each(["cancel", "teardown", "pagehide", "initialize-error"])("does not resurrect a pre-init result after %s", async ending => {
    const view = card();
    view.message({ method: "ui/notifications/tool-result", params: await result() });
    if (ending === "cancel") view.message({ method: "ui/notifications/tool-cancelled" });
    if (ending === "teardown") view.message({ id: "teardown", method: "ui/resource-teardown" });
    if (ending === "pagehide") view.listeners.pagehide();
    if (ending === "initialize-error") view.message({ id: "pdf-tools-initialize", error: { code: -1 } });
    view.message({ id: "pdf-tools-initialize", result: {} }); await settled();
    expect(view.elements.download.hidden).toBe(true);
    expect(view.elements.download.href).toBeUndefined();
  });
  it("binds every actual returned PDF's digest for the output card", async () => {
    const original = await result();
    const output = await callTool("rotate_pdf_pages", { pdf_base64: original.structuredContent.pdf_base64, page_numbers: [1], rotation: 90 });
    expect(output.isError).toBeFalsy();
    const bytes = Buffer.from(output.structuredContent.pdf_base64, "base64");
    expect(output.structuredContent.output).toMatchObject({ sha256: createHash("sha256").update(bytes).digest("hex"), size_bytes: bytes.length });
  });
  it("keeps bytes out of model-visible output in download mode and renders widget metadata", async () => {
    const original = await result();
    const output = await callTool("rotate_pdf_pages", { pdf_base64: original.structuredContent.pdf_base64, page_numbers: [1], rotation: 90, output_mode: "download" });
    expect(output.structuredContent.pdf_base64).toBeUndefined();
    expect(output._meta.pdf_file.pdf_base64).toBeTypeOf("string");
    const view = card(); view.message({ id: "pdf-tools-initialize", result: {} });
    view.message({ method: "ui/notifications/tool-result", params: output }); await settled();
    expect(view.elements.download.hidden).toBe(false);
  });
  it("rejects an unsupported handoff mode", async () => {
    expect((await callTool("rotate_pdf_pages", { output_mode: "store-forever" })).content[0].text).toMatch(/^INVALID_OUTPUT_MODE/);
  });
});
