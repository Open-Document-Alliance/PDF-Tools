const URL_ = "http://127.0.0.1:8787/mcp";
let id = 0;
async function rpc(method, params) {
  const r = await fetch(URL_, { method: "POST", headers: { "content-type": "application/json", accept: "application/json, text/event-stream" }, body: JSON.stringify({ jsonrpc: "2.0", id: ++id, method, params }) });
  const text = await r.text();
  const line = text.split("\n").find(l => l.startsWith("data: ")) ?? text;
  return JSON.parse(line.replace(/^data: /, ""));
}
await rpc("initialize", { protocolVersion: "2026-07-28", capabilities: {}, clientInfo: { name: "smoke", version: "0" } });
const list = await rpc("tools/list", {});
console.log("tools:", (list.result?.tools ?? []).map(t => t.name).join(", "));
const call = async (name, args) => { const t0 = Date.now(); const r = await rpc("tools/call", { name, arguments: args }); const res = r.result ?? r.error; const text = (res.content ?? []).map(c => c.text).join("\n"); console.log(`\n## ${name} (${Date.now() - t0}ms) err=${!!res.isError}\n${text.slice(0, 350)}`); return res.structuredContent; };
const W9 = "https://www.irs.gov/pub/irs-pdf/fw9.pdf";
await call("read_form_fields", { pdf_url: W9 });
const filled = await call("fill_form", { pdf_url: W9, fields: { "topmostSubform[0].Page1[0].f1_01[0]": "Jordan Sample", "topmostSubform[0].Page1[0].f1_02[0]": "Sample Studio LLC" } });
const zones = await call("detect_signature_zones", { pdf_base64: filled.pdf_base64 });
const zone = zones.zones.find(z => z.type === "signature");
const signed = await call("apply_signature", { pdf_base64: filled.pdf_base64, display_name: "Jordan Sample", page: zone.page, x: zone.x, y: zone.y, width: zone.width, height: zone.height, intent_statement: "SIMULATION: I, Jordan Sample (synthetic test identity), sign this W-9.", confirmed_at: new Date().toISOString() });
if (signed?.pdf_base64) { const fs = await import("node:fs"); fs.writeFileSync("/tmp/remote-signed.pdf", Buffer.from(signed.pdf_base64, "base64")); console.log("\nwrote /tmp/remote-signed.pdf", fs.statSync("/tmp/remote-signed.pdf").size, "bytes"); }
console.log("\n--- guard checks");
for (const bad of ["http://169.254.169.254/latest/meta-data/", "http://127.0.0.1:8787/mcp", "file:///etc/passwd", "http://10.0.0.1/x.pdf", "https://example.com/not-a.pdf"]) {
  const r = await rpc("tools/call", { name: "read_form_fields", arguments: { pdf_url: bad } });
  const res = r.result ?? r.error;
  console.log(" ", bad, "=>", ((res.content ?? []).map(c => c.text).join("") || JSON.stringify(res)).slice(0, 60));
}
