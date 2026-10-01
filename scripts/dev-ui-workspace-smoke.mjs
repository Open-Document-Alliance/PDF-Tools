import fs from "node:fs/promises";
import http from "node:http";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { createAgentBrowserSessionRunner, evalJson } from "./dev-ui-smoke-helpers.mjs";

// Synthetic MCP Apps bridge test of the real bundled UI. This is not proof of
// OpenAI/Claude host support, and it never reads a PDF or invokes a product tool.
const runBrowser = createAgentBrowserSessionRunner(`pdf-workspace-${Date.now()}`);
const viewer = await fs.readFile(path.join(process.cwd(), "dist-ui/index.html"));
const host = `<!doctype html><html><body style="margin:0"><iframe title="PDF Workspace" src="/viewer" style="width:100%;height:100vh;border:0"></iframe><script>
const frame = document.querySelector('iframe');
const mode = new URL(location.href).searchParams.get('message') || 'text';
window.state = { calls: [], messages: [], initialized: false };
const send = message => frame.contentWindow.postMessage(message, location.origin);
window.addEventListener('message', event => {
  if (event.source !== frame.contentWindow || event.origin !== location.origin) return;
  const message = event.data;
  if (message.method === 'ui/initialize') {
    send({jsonrpc:'2.0', id:message.id, result:{ protocolVersion:'2026-01-26', hostInfo:{name:'Synthetic workspace bridge',version:'1'}, hostCapabilities:mode === 'none' ? {} : {message:{text:{}}}, hostContext:{theme:'light',displayMode:'inline'} }});
  } else if (message.method === 'ui/notifications/initialized') {
    window.state.initialized = true;
    send({jsonrpc:'2.0',method:'ui/notifications/tool-input',params:{arguments:{}}});
    send({jsonrpc:'2.0',method:'ui/notifications/tool-result',params:{ content:[{type:'text',text:'PDF Workspace is ready. No PDF has been opened.'}], structuredContent:{pdfWorkspace:{version:1,state:'empty'}} }});
  } else if (message.method === 'ui/message') {
    window.state.messages.push(message.params);
    send({jsonrpc:'2.0',id:message.id,result:mode === 'reject' ? {isError:true} : {}});
  } else if (message.method === 'tools/call') {
    window.state.calls.push(message.params);
    send({jsonrpc:'2.0',id:message.id,error:{code:-32601,message:'No tool call is authorized in this starting-screen test'}});
  } else if (message.id !== undefined) {
    send({jsonrpc:'2.0',id:message.id,result:{}});
  }
});
window.snapshot = () => {
  const doc = frame.contentDocument;
  const workspace = doc?.getElementById('workspace');
  return { ...window.state,
    workspaceVisible: !!workspace && getComputedStyle(workspace).display !== 'none',
    viewerVisible: !!doc && getComputedStyle(doc.getElementById('viewer')).display !== 'none',
    errorVisible: !!doc && getComputedStyle(doc.getElementById('error')).display !== 'none',
    buttons: doc?.querySelectorAll('#workspace-tasks button').length || 0,
    text: workspace?.innerText || '',
    overflow: workspace ? workspace.scrollWidth > workspace.clientWidth : false,
    columns: workspace ? getComputedStyle(doc.getElementById('workspace-tasks')).gridTemplateColumns.split(' ').length : 0,
    status: doc?.getElementById('workspace-status').innerText || '' };
};
</script></body></html>`;
const server = http.createServer((request, response) => {
  const ui = request.url === "/viewer";
  response.writeHead(200, { "Content-Type": "text/html", "Cache-Control": "no-store" });
  response.end(ui ? viewer : host);
});
const assert = (condition, message) => { if (!condition) throw new Error(message); };
await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
const origin = `http://127.0.0.1:${server.address().port}`;
spawnSync("hview", [origin], { stdio: "ignore" });
const snapshot = () => evalJson(runBrowser, "JSON.stringify(window.snapshot())");
try {
  const cases = [];
  for (const [mode, width] of [["text", 1000], ["none", 375], ["reject", 1000]]) {
    await runBrowser(["batch", `set viewport ${width} 850`, `open ${origin}?message=${mode}`, "wait --fn window.snapshot().workspaceVisible"]);
    const before = await snapshot();
    assert(before.initialized && before.workspaceVisible && before.buttons === 5, "Workspace did not initialize with its five real task choices");
    assert(!before.viewerVisible && !before.errorVisible && before.calls.length === 0, "Opening the workspace exposed a PDF shell or invoked a product tool");
    assert(before.text.includes("No PDF open") && !before.overflow, "Empty workspace is misleading or overflows");
    assert(before.columns === (width === 375 ? 1 : 2), "Workspace layout does not respond to the host width");
    // Native keyboard activation proves the viewer's PDF shortcuts do not
    // swallow Space on the initial screen. No synthetic click is substituted.
    const focusFirstTask = Buffer.from("document.querySelector('iframe').contentDocument.querySelector('#workspace-tasks button').focus()").toString("base64");
    await runBrowser(["batch", `eval -b ${focusFirstTask}`, "press Space"]);
    await runBrowser(["wait", "--fn", "window.snapshot().status !== 'Choose a task to start in the conversation.'"]);
    if (mode !== "none") await runBrowser(["wait", "--fn", "window.state.messages.length === 1 && !document.querySelector('iframe').contentDocument.querySelector('#workspace-tasks button').disabled"]);
    if (mode === "text") await runBrowser(["wait", "--fn", "window.snapshot().status.startsWith('Request sent.')"]);
    const after = await snapshot();
    assert(after.calls.length === 0, "Choosing a task invoked a product tool");
    assert(after.messages.length === (mode === "none" ? 0 : 1), "Task guidance was duplicated or sent without host support");
    if (mode !== "text") assert(after.status.includes("Do not guess a file or scan folders"), "Rejected/unsupported message lost its selectable prompt fallback");
    cases.push({ mode, width, before, after });
  }
  console.log(JSON.stringify({ status: "pass", runtime: process.version, host: process.platform, architecture: process.arch, qualification: "synthetic_bridge_not_installed_host", cases }, null, 2));
} finally {
  await runBrowser(["close"]).catch(() => {});
  await new Promise(resolve => server.close(resolve));
}
