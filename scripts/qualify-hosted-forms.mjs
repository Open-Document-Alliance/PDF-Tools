// Direct endpoint qualification, not a ChatGPT host or legal-signature test.
// All document content and the stamp identity are conspicuously synthetic.
import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { createHash } from "node:crypto";
import { PDFDocument, StandardFonts } from "pdf-lib";

const endpoint = "https://mcp.opendocuments.ai/mcp";
const output = path.resolve(process.argv[2] || "dist-plugin/hosted-forms-qualification");
await mkdir(output, { mode: 0o700 });
const digest = (bytes) => createHash("sha256").update(bytes).digest("hex");
const startedAt = new Date().toISOString();
let id = 0;
const observations = [];
async function rpc(method, params) {
  const response = await fetch(endpoint, { method: "POST", headers: { "Content-Type": "application/json", Accept: "application/json, text/event-stream" }, body: JSON.stringify({ jsonrpc: "2.0", id: ++id, method, params }), signal: AbortSignal.timeout(45000) });
  assert.equal(response.status, 200, `HTTP ${response.status}`);
  const raw = await response.text();
  const data = response.headers.get("content-type")?.includes("text/event-stream")
    ? raw.split(/\r?\n/).filter(line => line.startsWith("data: ")).map(line => JSON.parse(line.slice(6))).find(message => message.id === id)
    : JSON.parse(raw);
  assert(data, "Missing RPC response");
  assert.equal(data.id, id);
  assert.equal(data.error, undefined, JSON.stringify(data.error));
  return data.result;
}
async function call(name, args, expectedError = false) {
  const start = new Date().toISOString();
  const result = await rpc("tools/call", { name, arguments: args });
  assert.equal(result.isError === true, expectedError, `${name}: ${JSON.stringify(result.content)}`);
  observations.push({ tool: name, started_at: start, completed_at: new Date().toISOString(), is_error: result.isError === true, response_sha256: digest(JSON.stringify(result)), text: (result.content || []).filter(c => c.type === "text").map(c => c.text).join("\n") });
  return result;
}
const document = await PDFDocument.create();
const page = document.addPage([612, 792]);
const font = await document.embedFont(StandardFonts.Helvetica);
page.drawText("PDF FORMS SYNTHETIC TEST - NO LEGAL EFFECT", { x: 40, y: 750, size: 16, font });
page.drawText("Name", { x: 40, y: 700, size: 12, font });
page.drawText("Company", { x: 40, y: 640, size: 12, font });
page.drawText("Signature: __________________________", { x: 40, y: 140, size: 12, font });
const form = document.getForm();
form.createTextField("test_name").addToPage(page, { x: 40, y: 665, width: 250, height: 24 });
form.createTextField("test_company").addToPage(page, { x: 40, y: 605, width: 250, height: 24 });
form.createCheckBox("test_checkbox").addToPage(page, { x: 40, y: 565, width: 16, height: 16 });
const original = Buffer.from(await document.save());
const pdfInput = { pdf_base64: original.toString("base64") };
await writeFile(path.join(output, "synthetic-form.pdf"), original, { mode: 0o600, flag: "wx" });
const initialized = await rpc("initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "pdf-forms-qualification", version: "0.1.0" } });
const discovery = await rpc("tools/list", {});
assert.deepEqual(discovery.tools.map(t => t.name).sort(), ["apply_signature", "detect_signature_zones", "fill_form", "flatten_form", "read_form_fields"]);
await writeFile(path.join(output, "discovery.json"), JSON.stringify(discovery, null, 2) + "\n", { mode: 0o600, flag: "wx" });
const cases = [];
const read = await call("read_form_fields", pdfInput);
assert.equal(read.structuredContent.page_count, 1);
assert.deepEqual(read.structuredContent.fields.map(f => f.name).sort(), ["test_checkbox", "test_company", "test_name"]);
cases.push({ name: "read_fields", passed: true });
const filled = await call("fill_form", { ...pdfInput, fields: { test_name: "Synthetic Example", test_company: "Example, Test Only", test_checkbox: true } });
assert.equal(filled.structuredContent.filled.length, 3);
assert.deepEqual(filled.structuredContent.not_filled, []);
const filledBytes = Buffer.from(filled.structuredContent.pdf_base64, "base64");
const filledPdf = await PDFDocument.load(filledBytes);
assert.equal(filledPdf.getForm().getTextField("test_name").getText(), "Synthetic Example");
assert.equal(filledPdf.getForm().getTextField("test_company").getText(), "Example, Test Only");
assert.equal(filledPdf.getForm().getCheckBox("test_checkbox").isChecked(), true);
await writeFile(path.join(output, "filled-form.pdf"), filledBytes, { mode: 0o600, flag: "wx" });
cases.push({ name: "fill_and_independent_readback", passed: true });
const zones = await call("detect_signature_zones", { pdf_base64: filled.structuredContent.pdf_base64 });
const zone = zones.structuredContent.zones.find(z => z.type === "signature");
assert(zone, "Synthetic printed Signature label was not detected");
cases.push({ name: "detect_signature_zone", passed: true });
const stampArgs = { pdf_base64: filled.structuredContent.pdf_base64, display_name: "SYNTHETIC TEST ONLY", page: zone.page, x: zone.x, y: zone.y, width: zone.width, height: zone.height };
// An automated simulation statement is never reused as a real person's intent.
const stamped = await call("apply_signature", { ...stampArgs, intent_statement: "AUTOMATED SYNTHETIC TEST ONLY. This simulated stamp is not a person's signature and has no legal effect.", confirmed_at: new Date().toISOString() });
assert.match(stamped.content[0].text, /not a cryptographic signature/);
const stampedBytes = Buffer.from(stamped.structuredContent.pdf_base64, "base64");
const stampedPdf = await PDFDocument.load(stampedBytes);
assert.match(stampedPdf.getKeywords(), /AUTOMATED SYNTHETIC TEST ONLY/);
await writeFile(path.join(output, "stamped-test-form.pdf"), stampedBytes, { mode: 0o600, flag: "wx" });
cases.push({ name: "synthetic_visible_stamp", passed: true, real_human_signature: false });
const flat = await call("flatten_form", { pdf_base64: filled.structuredContent.pdf_base64 });
const flatBytes = Buffer.from(flat.structuredContent.pdf_base64, "base64");
assert.equal((await PDFDocument.load(flatBytes)).getForm().getFields().length, 0);
await writeFile(path.join(output, "flattened-form.pdf"), flatBytes, { mode: 0o600, flag: "wx" });
cases.push({ name: "flatten_and_independent_readback", passed: true });
const absent = await call("read_form_fields", {}, true);
assert.match(absent.content[0].text, /MISSING_INPUT/);
cases.push({ name: "missing_pdf_refused", passed: true });
const noIntent = await call("apply_signature", stampArgs, true);
assert.match(noIntent.content[0].text, /intent|confirm/i);
cases.push({ name: "missing_stamp_intent_refused", passed: true });
const privateUrl = await call("read_form_fields", { pdf_url: "http://127.0.0.1/private.pdf" }, true);
assert.match(privateUrl.content[0].text, /PRIVATE_ADDRESS|private|loopback|refused/i);
cases.push({ name: "private_address_refused", passed: true });
const report = { ok: true, scope: "direct-endpoint-synthetic-only-not-native-host", endpoint, started_at: startedAt, completed_at: new Date().toISOString(), runtime: process.version, server_info: initialized.serverInfo, cases, source_sha256: digest(original), returned_artifacts: { filled: digest(filledBytes), stamped_test: digest(stampedBytes), flattened: digest(flatBytes) }, observations, chatgpt_host_accepted: false, real_signature_executed: false, public_submission_complete: false };
await writeFile(path.join(output, "qualification.json"), JSON.stringify(report, null, 2) + "\n", { mode: 0o600, flag: "wx" });
console.log(JSON.stringify({ ok: true, cases: cases.length, endpoint, report: path.join(output, "qualification.json"), scope: report.scope }));
