import fs from "node:fs/promises";
import http from "node:http";
import path from "node:path";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { PDFDocument, StandardFonts, degrees } from "pdf-lib";
import { createAgentBrowserSessionRunner, evalJson } from "./dev-ui-smoke-helpers.mjs";

// Real bundled viewer, official SDK bridge, synthetic host and PDF fixtures.
// This does not prove installed ChatGPT support or authorize any real file send.
const document = await PDFDocument.create();
const font = await document.embedFont(StandardFonts.Helvetica);
for (const label of ["SYNTHETIC HOST PDF PAGE ONE", "SYNTHETIC HOST PDF PAGE TWO"]) {
  document.addPage([420, 560]).drawText(label, { x: 30, y: 500, size: 14, font });
}
const original = Buffer.from(await document.save({ useObjectStreams: false }));
document.getPage(0).setRotation(degrees(90));
const edited = Buffer.from(await document.save({ useObjectStreams: false }));
const hash = bytes => createHash("sha256").update(bytes).digest("hex");
const originalPath = "/private/workspace/host-import-synthetic.pdf";
const managedPath = "/private/workspace/host-import-synthetic-managed.pdf";
const viewer = await fs.readFile(path.join(process.cwd(), "dist-ui/index.html"));
const runBrowser = createAgentBrowserSessionRunner(`pdf-host-file-${Date.now()}`);

const payload = (pdfPath, bytes, imported = false) => ({ content: [{ type: "text", text: "Synthetic PDF ready." }], structuredContent: {
  pdfPath, active_path: pdfPath, totalBytes: bytes.length, initialPage: 1, fields: [], fieldCount: 0, hasFormFields: false,
  ...(imported ? { source: { canonical_path: pdfPath, sha256: hash(bytes), size_bytes: bytes.length }, host_import: { version: 1, status: "imported", sha256: hash(bytes), size_bytes: bytes.length } } : {}),
} });

const host = `<!doctype html><html><body style="margin:0"><iframe title="PDF host resource test" src="/viewer" style="width:100%;height:100vh;border:0"></iframe><script>
const frame = document.querySelector('iframe');
const mode = new URL(location.href).searchParams.get('mode') || 'saved';
const uri = 'host-resource://opaque-synthetic-pdf';
window.state = { calls: [], reads: [], writes: [], subscriptions: 0, unsubscriptions: 0, teardown: false };
const send = message => frame.contentWindow.postMessage(message, location.origin);
const reply = (id, result) => send({jsonrpc:'2.0',id,result});
window.updated = () => send({jsonrpc:'2.0',method:'notifications/resources/updated',params:{uri}});
window.switchDocument = () => send({jsonrpc:'2.0',method:'ui/notifications/tool-result',params:${JSON.stringify(payload("/private/workspace/unrelated.pdf", original))}});
window.teardown = () => send({jsonrpc:'2.0',id:900,method:'ui/resource-teardown',params:{}});
window.click = id => frame.contentDocument.getElementById(id).click();
window.rotate = () => { const doc = frame.contentDocument; doc.querySelector('.manage-thumb-actions button[title="Rotate CW"]').click(); };
window.releasePendingApply = () => fetch('/release-apply');
window.snapshot = () => {
  const doc = frame.contentDocument;
  const button = doc?.getElementById('host-file-save');
  return {...window.state, status:doc?.getElementById('host-file-status').innerText, saveDisabled:button?.disabled, saveHidden:button?.hidden,
    viewerVisible:!!doc && getComputedStyle(doc.getElementById('viewer')).display !== 'none',
    error:doc?.getElementById('error-message').innerText,
    canvasWidth:doc?.getElementById('pdf-canvas').width,
    title:doc?.getElementById('pdf-title').innerText,
    manageReady:!!doc?.querySelector('.manage-thumb-actions button'),
    overflow:doc ? doc.documentElement.scrollWidth > doc.documentElement.clientWidth : false};
};
window.addEventListener('message', async event => {
  if (event.source !== frame.contentWindow || event.origin !== location.origin) return;
  const message = event.data;
  if (message.id === 900 && !message.method) { window.state.teardown = !message.error; return; }
  if (message.method === 'ui/initialize') reply(message.id,{protocolVersion:'2026-01-26',hostInfo:{name:'Synthetic host resource bridge',version:'1'},hostCapabilities:{serverTools:{},serverResources:{},updateModelContext:{text:{}},...(mode === 'unsupported' ? {} : {experimental:{'openai/resource':{}}})},hostContext:{theme:'light',displayMode:'inline'}});
  else if (message.method === 'ui/notifications/initialized') {
    send({jsonrpc:'2.0',method:'ui/notifications/tool-input',params:{arguments:{file:{name:'synthetic.pdf',resourceUri:uri}}}});
    send({jsonrpc:'2.0',method:'ui/notifications/tool-result',params:{content:[],structuredContent:{pdfWorkspace:{version:1,state:'empty'}}}});
  } else if (message.method === 'resources/subscribe') { window.state.subscriptions++; reply(message.id,{}); }
  else if (message.method === 'resources/unsubscribe') { window.state.unsubscriptions++; reply(message.id,{}); }
  else if (message.method === 'resources/read') {
    window.state.reads.push(message.params);
    reply(message.id,{contents:[{uri,blob:${JSON.stringify(original.toString("base64"))},_meta:{'openai/resource':{writable:mode !== 'readonly',etag:'version-1'}}}]});
  } else if (message.method === 'openai/resources/write') {
    const params = message.params;
    const response = await fetch('/verify-write',{method:'POST',body:JSON.stringify(params)});
    const verified = await response.json();
    window.state.writes.push({uri:params.uri,ifMatch:params.ifMatch,...verified});
    if (mode === 'own-event') window.updated();
    reply(message.id,mode === 'conflict' ? {outcome:'conflict',etag:'other-version'} : mode === 'too-large' ? {outcome:'too-large',maxBytes:1} : {outcome:'saved',etag:'version-2'});
  } else if (message.method === 'tools/call') {
    window.state.calls.push({name:message.params.name,arguments:message.params.name === 'import_host_pdf' ? {display_name:message.params.arguments.display_name,blob_supplied:!!message.params.arguments.pdf_base64} : message.params.arguments});
    const response = await fetch('/tool',{method:'POST',body:JSON.stringify({...message.params,__test_mode:mode})});
    reply(message.id,await response.json());
  } else if (message.id !== undefined) reply(message.id,{});
});
</script></body></html>`;

let releasePendingApply;
let pendingApplyReleased = false;
const server = http.createServer(async (request, response) => {
  try {
    if (request.url === "/release-apply") {
      pendingApplyReleased = true;
      releasePendingApply?.();
      response.writeHead(200);
      response.end("released");
      return;
    }
    if (request.method === "POST") {
      const chunks = [];
      for await (const chunk of request) chunks.push(chunk);
      const value = JSON.parse(Buffer.concat(chunks).toString());
      let result;
      if (request.url === "/verify-write") {
        const output = Buffer.from(value.blob, "base64");
        result = { sha256: hash(output), exact_edited_bytes: output.equals(edited), size: output.length };
      } else {
        const args = value.arguments;
        const bytes = args.pdf_path === managedPath ? edited : original;
        if (value.name === "import_host_pdf") {
          if (!Buffer.from(args.pdf_base64, "base64").equals(original) || Object.keys(args).sort().join(",") !== "display_name,pdf_base64") throw new Error("Import did not receive the exact host blob without URI/path.");
          result = payload(originalPath, original, true);
        } else if (value.name === "read_pdf_bytes") {
          const chunk = bytes.subarray(args.offset, Math.min(args.offset + args.byteCount, bytes.length));
          result = { content: [], structuredContent: { pdfPath: args.pdf_path, totalBytes: bytes.length, offset: args.offset, byteCount: chunk.length, bytes: chunk.toString("base64") } };
        } else if (value.name === "get_pdf_identity") result = { content: [], structuredContent: { canonical_path: args.pdf_path, sha256: hash(bytes), size_bytes: bytes.length } };
        else if (value.name === "apply_page_plan") {
          if (args.plan.rotations["1"] !== 90) throw new Error("The actual UI did not request the page edit.");
          result = payload(managedPath, edited);
          if (value.__test_mode === "pending-apply" && !pendingApplyReleased) await new Promise(resolve => { releasePendingApply = resolve; });
        } else if (value.name === "set_active_document") result = { content: [] };
        else throw new Error(`Unexpected tool ${value.name}`);
      }
      response.writeHead(200, { "Content-Type": "application/json" });
      response.end(JSON.stringify(result));
      return;
    }
    response.writeHead(200, { "Content-Type": "text/html", "Cache-Control": "no-store" });
    response.end(request.url === "/viewer" ? viewer : host);
  } catch (error) {
    response.writeHead(500, { "Content-Type": "application/json" });
    response.end(JSON.stringify({ isError: true, content: [{ type: "text", text: String(error) }] }));
  }
});
const assert = (condition, message) => { if (!condition) throw new Error(message); };
await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
const origin = `http://127.0.0.1:${server.address().port}`;
spawnSync("hview", [origin], { stdio: "ignore" });
const snapshot = () => evalJson(runBrowser, "JSON.stringify(window.snapshot())");
try {
  const cases = [];
  for (const mode of ["saved", "pending-apply", "conflict", "too-large", "own-event", "readonly", "stale", "switch", "teardown", "unsupported"]) {
    await runBrowser(["batch", "set viewport 1000 850", `open ${origin}?mode=${mode}`]);
    if (mode === "unsupported") {
      await runBrowser(["wait", "--fn", "window.snapshot().error.includes('does not support native PDF')"]);
      const state = await snapshot();
      assert(state.calls.length === 0 && state.writes.length === 0, "Unsupported host issued a server or write call");
      cases.push({ mode, state });
      continue;
    }
    await runBrowser(["wait", "--fn", "window.snapshot().viewerVisible && window.snapshot().status.startsWith('Working on a private copy') && window.snapshot().canvasWidth > 0"]);
    let state = await snapshot();
    assert(state.reads.length === 1 && state.reads[0]._meta["openai/resource"].representation === "blob", "Official SDK did not request exact blob representation");
    assert(state.subscriptions === 1 && !state.overflow, "Subscription or layout failed");
    assert(state.calls.filter(call => call.name === "import_host_pdf").length === 1 && state.writes.length === 0, "Import duplicated or auto-saved");
    if (mode === "readonly") assert(state.saveDisabled, "Read-only resource enabled save");
    else if (mode === "stale") {
      await runBrowser(["eval", "window.updated()"]);
      await runBrowser(["wait", "--fn", "window.snapshot().status.includes('original file changed') && window.snapshot().saveDisabled"]);
    } else if (mode === "switch") {
      await runBrowser(["eval", "window.switchDocument()"]);
      await runBrowser(["wait", "--fn", "window.snapshot().unsubscriptions === 1 && window.snapshot().saveHidden"]);
    } else if (mode === "teardown") {
      await runBrowser(["eval", "window.teardown()"]);
      await runBrowser(["wait", "--fn", "window.snapshot().teardown && window.snapshot().unsubscriptions === 1"]);
      await runBrowser(["eval", "window.updated()"]);
    } else {
      // Exercise a real viewer edit and load its changed local PDF before save.
      await runBrowser(["eval", "window.click('mode-manage-btn')"]);
      await runBrowser(["wait", "--fn", "window.snapshot().manageReady"]);
      await runBrowser(["eval", "window.rotate()"]);
      state = await snapshot();
      assert(state.saveDisabled && state.status.includes("Save your page changes as a local copy first"), "Uncommitted page arrangement enabled a misleading save-back");
      await runBrowser(["eval", "window.click('manage-apply')"]);
      if (mode === "pending-apply") {
        await runBrowser(["wait", "--fn", "window.snapshot().calls.some(c => c.name === 'apply_page_plan')"]);
        await runBrowser(["eval", "window.click('manage-reset')"]);
        state = await snapshot();
        assert(state.saveDisabled && state.status.includes("finish saving locally"), "Reset cleared the in-flight page mutation's saveback barrier");
        await runBrowser(["eval", "window.click('host-file-save')"]);
        state = await snapshot();
        assert(state.writes.length === 0, "Pending page mutation wrote the old host file");
        await runBrowser(["eval", "window.releasePendingApply()"]);
      }
      await runBrowser(["wait", "--fn", "window.snapshot().calls.some(c => c.name === 'apply_page_plan') && window.snapshot().calls.some(c => c.name === 'read_pdf_bytes' && c.arguments.pdf_path.includes('managed')) && !window.snapshot().saveDisabled"]);
      await runBrowser(["eval", "window.click('host-file-save')"]);
      await runBrowser(["wait", "--fn", "window.snapshot().writes.length === 1 && !window.snapshot().status.includes('Verifying')"]);
      state = await snapshot();
      assert(state.writes[0].exact_edited_bytes && state.writes[0].ifMatch === "version-1", "Save did not bind exact edited bytes to the original ETag");
      assert(state.calls.filter(call => call.name === "get_pdf_identity").length === 2, "Save did not reconcile fresh local identities");
      if (mode === "saved") assert(state.status.startsWith("Saved back"), "Successful save was not confirmed");
      if (mode === "own-event") assert(state.status.includes("host confirmed the save") && state.saveDisabled, "Own write update was misreported or allowed stale reuse");
      if (mode === "conflict") assert(state.status.includes("Not saved") && state.saveDisabled, "Conflict did not retain a stale-blocked working copy");
      if (mode === "too-large") assert(state.status.includes("size limit"), "Host size failure was not reported");
    }
    state = await snapshot();
    if (["readonly", "stale", "switch", "teardown"].includes(mode)) assert(state.writes.length === 0, `${mode} attempted a write`);
    cases.push({ mode, state });
  }
  console.log(JSON.stringify({ status: "pass", qualification: "synthetic_host_not_installed_chatgpt", runtime: process.version, original_sha256: hash(original), edited_sha256: hash(edited), cases }, null, 2));
} finally {
  await runBrowser(["close"]).catch(() => {});
  await new Promise(resolve => server.close(resolve));
}
