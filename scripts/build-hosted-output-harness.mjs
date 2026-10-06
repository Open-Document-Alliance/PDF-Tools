// A synthetic local bridge simulation for browser/download QA, not ChatGPT proof.
import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { createHash } from "node:crypto";
import { PDFDocument, StandardFonts } from "pdf-lib";
import { handleMcpFetch } from "../remote/http.mjs";
import { OUTPUT_CARD_HTML } from "../remote/output-card.mjs";

const output = path.resolve(process.argv[2] || "dist-plugin/hosted-core-output-harness");
await mkdir(path.dirname(output), { recursive: true, mode: 0o700 });
await mkdir(output, { mode: 0o700 });
const document = await PDFDocument.create();
const font = await document.embedFont(StandardFonts.Helvetica);
for (let page = 1; page <= 3; page++) document.addPage([300 + page * 10, 400]).drawText(`SYNTHETIC PDF TOOLS TEST ONLY, PAGE ${page}`, { x: 15, y: 350, size: 10, font });
const original = Buffer.from(await document.save());
const response = await handleMcpFetch(new Request("http://localhost/mcp", { method: "POST", headers: { "content-type": "application/json", accept: "application/json, text/event-stream" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "select_pdf_pages", arguments: { pdf_base64: original.toString("base64"), page_numbers: [3, 1], output_mode: "download" } } }) }));
assert.equal(response.status, 200);
const raw = await response.text();
const envelope = response.headers.get("content-type")?.includes("text/event-stream")
  ? raw.split(/\r?\n/).filter(line => line.startsWith("data: ")).map(line => JSON.parse(line.slice(6))).find(message => message.id === 1)
  : JSON.parse(raw);
assert.equal(envelope.error, undefined);
assert.equal(envelope.result.isError, undefined);
const selected = Buffer.from(envelope.result._meta.pdf_file.pdf_base64, "base64");
assert.deepEqual((await PDFDocument.load(selected)).getPages().map(page => page.getWidth()), [330, 310]);
const safeJson = value => JSON.stringify(value).replace(/</g, "\\u003c");
const attribute = value => value.replaceAll("&", "&amp;").replaceAll('"', "&quot;").replaceAll("<", "&lt;");
const harness = `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>PDF Tools local bridge simulation</title></head><body style="font:16px system-ui;max-width:700px;margin:40px auto"><h1>PDF Tools output test</h1><p>Local synthetic MCP Apps bridge simulation. This is not ChatGPT acceptance.</p><iframe id="card" title="PDF Tools output" sandbox="allow-scripts allow-same-origin allow-downloads" style="border:1px solid #ddd;border-radius:12px;width:100%;height:340px" srcdoc="${attribute(OUTPUT_CARD_HTML)}"></iframe><script>
const card = document.getElementById("card");
window.addEventListener("message", event => {
  if(event.source !== card.contentWindow || event.data?.jsonrpc !== "2.0") return;
  if(event.data.method === "ui/initialize") card.contentWindow.postMessage({jsonrpc:"2.0",id:event.data.id,result:{protocolVersion:"2026-01-26",hostCapabilities:{},hostContext:{}}},"*");
  if(event.data.method === "ui/notifications/initialized") card.contentWindow.postMessage({jsonrpc:"2.0",method:"ui/notifications/tool-result",params:${safeJson(envelope.result)}},"*");
});</script></body></html>`;
for (const [name, bytes] of [["source.pdf", original], ["expected-copy.pdf", selected], ["bridge-simulation.html", harness]]) await writeFile(path.join(output, name), bytes, { mode: 0o600, flag: "wx" });
const report = { scope: "synthetic-local-HTTP-and-bridge-simulation", created_at: new Date().toISOString(), source_sha256: createHash("sha256").update(original).digest("hex"), output_sha256: createHash("sha256").update(selected).digest("hex"), selected_page_numbers: [3, 1], native_chatgpt_accepted: false, output_download_observed: false };
await writeFile(path.join(output, "simulation.json"), JSON.stringify(report, null, 2) + "\n", { mode: 0o600, flag: "wx" });
console.log(JSON.stringify({ ...report, directory: output }));
