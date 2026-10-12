// Optional real-browser check of the built viewer. Requires Playwright supplied
// by the developer environment (or PDF_TOOLS_PLAYWRIGHT_MODULE). No native-host
// qualification is implied. Usage: node scripts/dev-ui-document-session-smoke.mjs [viewer.html]
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import http from "node:http";
import path from "node:path";
import { PDFDocument, StandardFonts } from "pdf-lib";

const { chromium } = await import(process.env.PDF_TOOLS_PLAYWRIGHT_MODULE || "playwright");
const viewer = await fs.readFile(path.resolve(process.argv[2] || "dist-ui/index.html"));
async function fixture(marker) {
  const document = await PDFDocument.create();
  document.setCreationDate(new Date("2026-01-01T00:00:00Z"));
  document.setModificationDate(new Date("2026-01-01T00:00:00Z"));
  const font = await document.embedFont(StandardFonts.Helvetica);
  document.addPage([612, 792]).drawText(marker, { x: 72, y: 680, size: 18, font });
  return Buffer.from(await document.save({ useObjectStreams: false }));
}
const original = await fixture("ORIGINAL-VIEW-MARKER");
const replacement = await fixture("REPLACED-VIEW-MARKER");
// Legal trailing whitespace removes size as a cache-invalidation signal.
const size = Math.max(original.length, replacement.length);
const oldBytes = Buffer.concat([original, Buffer.alloc(size - original.length, 32)]);
const newBytes = Buffer.concat([replacement, Buffer.alloc(size - replacement.length, 32)]);
assert.equal(oldBytes.length, newBytes.length, "The reload must exercise equal-size files");
const html = `<!doctype html><html><body><iframe id="viewer" src="/viewer" style="width:1000px;height:900px;border:0"></iframe><script>
const frame = document.getElementById('viewer');
const fixtures = ${JSON.stringify([oldBytes.toString("base64"), newBytes.toString("base64")])};
let fixture = 0, holding = false, invalid = false;
const held = [];
window.state = { initialized: false, reads: 0, held: 0, errors: [] };
const send = value => frame.contentWindow.postMessage({ jsonrpc: '2.0', ...value }, '*');
window.view = (next, uuid, options = {}) => {
  fixture = next; holding = !!options.hold; invalid = !!options.invalid;
  send({ method: 'ui/notifications/tool-result', params: { content: [], structuredContent: { pdfPath: '/fixture.pdf', totalBytes: atob(fixtures[fixture]).length, initialPage: 1 }, _meta: { viewUUID: uuid } } });
};
window.release = () => held.splice(0).forEach(reply => reply());
window.addEventListener('message', event => {
  if (event.source !== frame.contentWindow) return;
  const request = event.data;
  if (!request || request.jsonrpc !== '2.0') return;
  const reply = result => send({ id: request.id, result });
  if (request.method === 'ui/notifications/initialized') { state.initialized = true; return; }
  if (!('id' in request)) return;
  if (request.method === 'ui/initialize') {
    reply({ protocolVersion: '2026-01-26', hostInfo: { name: 'local-browser-regression', version: '1' }, hostCapabilities: { serverTools: {}, updateModelContext: { text: {} } }, hostContext: { theme: 'light', displayMode: 'inline', availableDisplayModes: ['inline'], platform: 'desktop' } });
  } else if (request.method === 'tools/call') {
    const {name, arguments: args} = request.params;
    if (name === 'read_pdf_bytes') {
      state.reads++;
      const raw = atob(fixtures[fixture]);
      const chunk = raw.slice(args.offset, args.offset + args.byteCount);
      const response = { content: [], structuredContent: { pdfPath: args.pdf_path, totalBytes: raw.length, offset: invalid ? args.offset + 1 : args.offset, byteCount: chunk.length, bytes: btoa(chunk) } };
      if (holding) { state.held++; held.push(() => reply(response)); } else reply(response);
    } else if (name === 'detect_signature_zones') {
      reply({ content: [], structuredContent: { zones: [], pages: [], warnings: [] } });
    } else reply({ content: [], structuredContent: {} });
  } else if (request.method === 'ui/update-model-context') reply({});
  else send({ id: request.id, error: { code: -32601, message: 'Unsupported test method' } });
});
</script></body></html>`;
const server = http.createServer((request, response) => {
  response.writeHead(200, { "content-type": "text/html" });
  response.end(request.url === "/viewer" ? viewer : html);
});
await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
let browser;
try {
  browser = await chromium.launch({ headless: true });
  const page = await browser.newPage();
  const pageErrors = [];
  page.on("pageerror", error => pageErrors.push(error.message));
  await page.goto(`http://127.0.0.1:${server.address().port}/`);
  await page.waitForFunction(() => window.state.initialized);
  const frame = page.frameLocator("#viewer");
  const waitMarker = marker => frame.locator("#text-layer").getByText(marker, { exact: true }).waitFor();
  await page.evaluate(() => window.view(0, "one"));
  await waitMarker("ORIGINAL-VIEW-MARKER");
  // Locator clicks require actual visible controls; DOM .click() would miss
  // the one-page regression by activating a button in a hidden container.
  await frame.locator("#mode-sign-btn").click();
  assert.equal(await frame.locator("#sign-panel").isVisible(), true);
  await frame.locator("#mode-manage-btn").click();
  assert.equal(await frame.locator("#manage-grid .manage-thumb-item").count(), 1);
  await frame.locator("#manage-grid .manage-thumb-item").click();
  await frame.locator("#manage-rotate-cw").click();
  assert.match(await frame.locator("#manage-status").textContent(), /rotated/);
  const firstReads = await page.evaluate(() => window.state.reads);
  await page.evaluate(() => window.view(1, "two"));
  await waitMarker("REPLACED-VIEW-MARKER");
  assert.equal(await frame.locator("#text-layer").getByText("ORIGINAL-VIEW-MARKER", { exact: true }).count(), 0);
  assert.ok(await page.evaluate(() => window.state.reads) > firstReads);
  await page.evaluate(() => window.view(0, "held", { hold: true }));
  await page.waitForFunction(() => window.state.held > 0);
  await page.evaluate(() => window.view(1, "replacement"));
  await waitMarker("REPLACED-VIEW-MARKER");
  await page.evaluate(() => window.release());
  // Round-trip through the frame so the held response and its microtasks have
  // been handled before checking for stale content or an error screen.
  await frame.locator("#mode-sign-btn").click();
  assert.equal(await frame.locator("#error").isVisible(), false);
  await page.evaluate(() => window.view(0, "bad-range", { invalid: true }));
  await frame.locator("#error").waitFor({ state: "visible" });
  assert.match(await frame.locator("#error-message").textContent(), /does not match the current document range/);
  assert.deepEqual(pageErrors, []);
  console.log(JSON.stringify({ result: "passed", cases: ["one-page-visible-sign", "one-page-rotation", "same-path-equal-size-reload", "cancelled-range-late-response", "invalid-range-fails-visibly"], ...await page.evaluate(() => window.state) }, null, 2));
} finally {
  await browser?.close();
  await new Promise(resolve => server.close(resolve));
}
