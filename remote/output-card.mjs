// Adapted from OpenAI's vanilla MCP Apps bridge example, not the local viewer.
// No external scripts, storage, network requests or document text in HTML.
export const OUTPUT_RESOURCE_URI = "ui://pdf-tools/output-v1.html";
export const OUTPUT_TOOL_NAMES = new Set(["fill_form", "flatten_form", "apply_signature", "select_pdf_pages", "rotate_pdf_pages", "merge_pdfs"]);

export function installOutputCard() {
  const status = document.getElementById("status");
  const download = document.getElementById("download");
  const identity = document.getElementById("identity");
  let objectUrl;
  let generation = 0;
  let initialized = false;
  let waiting;
  let closed = false;
  const notify = (method, params) => window.parent.postMessage({ jsonrpc: "2.0", method, params }, "*");
  function clear() {
    if (objectUrl) URL.revokeObjectURL(objectUrl);
    objectUrl = undefined;
    download.hidden = true;
    download.removeAttribute("href");
    identity.textContent = "";
  }
  async function render(result) {
    if (closed) return;
    const current = ++generation;
    clear();
    if (result?.isError) { status.textContent = "No output copy was created. See the tool's refusal in the conversation."; return; }
    const data = result?._meta?.pdf_file ?? result?.structuredContent;
    const base64 = data?.pdf_base64;
    try {
      if (typeof base64 !== "string" || base64.length > 4 * 1024 * 1024
        || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(base64)) throw new Error("invalid output");
      const decoded = atob(base64);
      const bytes = Uint8Array.from(decoded, char => char.charCodeAt(0));
      if (bytes.length !== data.output?.size_bytes || String.fromCharCode(...bytes.slice(0, 5)) !== "%PDF-") throw new Error("invalid output");
      const hash = Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", bytes)), value => value.toString(16).padStart(2, "0")).join("");
      if (hash !== data.output?.sha256) throw new Error("changed output");
      if (closed || current !== generation) return;
      objectUrl = URL.createObjectURL(new Blob([bytes], { type: "application/pdf" }));
      download.href = objectUrl;
      download.download = "pdf-tools-copy.pdf";
      download.hidden = false;
      status.textContent = "Your new PDF copy is ready. The source was not changed.";
      identity.textContent = `${bytes.length.toLocaleString()} bytes · SHA-256 ${hash}`;
    } catch {
      if (current === generation) status.textContent = "The output copy could not be verified here. Do not treat it as a completed download.";
    }
    notify("ui/notifications/size-changed", { width: document.documentElement.scrollWidth, height: document.documentElement.scrollHeight });
  }
  window.addEventListener("message", event => {
    if (event.source !== window.parent || event.data?.jsonrpc !== "2.0") return;
    const message = event.data;
    if (closed) return;
    if (message.id === "pdf-tools-initialize" && !initialized) {
      if (message.error) { generation++; waiting = undefined; closed = true; clear(); status.textContent = "This host did not initialize the PDF result card."; return; }
      initialized = true;
      notify("ui/notifications/initialized", {});
      if (waiting) { void render(waiting); waiting = undefined; }
    } else if (message.method === "ui/notifications/tool-result") {
      if (initialized) void render(message.params); else waiting = message.params;
    } else if (message.method === "ui/notifications/tool-cancelled") {
      generation++; waiting = undefined; clear(); status.textContent = "The operation was cancelled. No output is available here.";
    } else if (message.method === "ui/resource-teardown") {
      generation++; waiting = undefined; closed = true; clear();
      window.parent.postMessage({ jsonrpc: "2.0", id: message.id, result: {} }, "*");
    } else if (message.method === "ping") {
      window.parent.postMessage({ jsonrpc: "2.0", id: message.id, result: {} }, "*");
    }
  });
  window.addEventListener("pagehide", () => { generation++; waiting = undefined; closed = true; clear(); });
  window.parent.postMessage({ jsonrpc: "2.0", id: "pdf-tools-initialize", method: "ui/initialize", params: {
    protocolVersion: "2026-01-26", appInfo: { name: "PDF Tools output", version: "0.2.0" }, appCapabilities: { availableDisplayModes: ["inline"] },
  } }, "*");
}

export const OUTPUT_CARD_HTML = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>PDF Tools output</title><style>
body{font:14px system-ui,sans-serif;color:var(--color-text-primary,#222);background:var(--color-background-primary,#fff);margin:0;padding:20px}h1{font-size:18px;margin:0 0 12px}p{line-height:1.5}a{display:inline-block;background:#1565c0;color:white;padding:10px 16px;border-radius:8px;text-decoration:none}a[hidden]{display:none}small{display:block;overflow-wrap:anywhere;margin-top:16px;color:var(--color-text-secondary,#666)}
</style></head><body><h1>PDF Tools</h1><p id="status" role="status">Waiting for the finished PDF copy.</p><a id="download" hidden>Download PDF copy</a><small id="identity"></small><p>The file stays in this result card's memory. Download support depends on your host. Review the copy before using it.</p><script>(${installOutputCard.toString()})()</script></body></html>`;

export function outputResource() {
  return { contents: [{ uri: OUTPUT_RESOURCE_URI, mimeType: "text/html;profile=mcp-app", text: OUTPUT_CARD_HTML,
    _meta: { ui: { prefersBorder: true, domain: "https://mcp.opendocuments.ai", csp: { connectDomains: [], resourceDomains: ["blob:"] } }, "openai/widgetDescription": "Shows a verified new PDF copy with a user-initiated download action. Does not overwrite the source or store files on the server." },
  }] };
}
