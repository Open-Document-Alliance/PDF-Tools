import { PDFDocument, StandardFonts } from "pdf-lib";
import { beforeAll, describe, expect, it } from "vitest";
import { handleMcpFetch } from "../remote/http.mjs";
import { OUTPUT_RESOURCE_URI } from "../remote/output-card.mjs";

let base64;
let id = 0;
beforeAll(async () => {
  const document = await PDFDocument.create();
  const font = await document.embedFont(StandardFonts.Helvetica);
  for (let page = 1; page <= 3; page++) document.addPage([300 + page * 10, 400]).drawText(`Synthetic HTTP page ${page}`, { x: 20, y: 350, size: 12, font });
  base64 = Buffer.from(await document.save()).toString("base64");
});
async function rpc(method, params) {
  const requestId = ++id;
  const response = await handleMcpFetch(new Request("http://localhost/mcp", {
    method: "POST", headers: { "content-type": "application/json", accept: "application/json, text/event-stream" },
    body: JSON.stringify({ jsonrpc: "2.0", id: requestId, method, params }),
  }));
  expect(response.status).toBe(200);
  const raw = await response.text();
  const envelope = response.headers.get("content-type")?.includes("text/event-stream")
    ? raw.split(/\r?\n/).filter(line => line.startsWith("data: ")).map(line => JSON.parse(line.slice(6))).find(message => message.id === requestId)
    : JSON.parse(raw);
  expect(envelope.id).toBe(requestId);
  expect(envelope.error).toBeUndefined();
  return envelope.result;
}

describe("broader hosted core over the actual MCP HTTP transport", () => {
  it("initializes with explicit UI-resource capability and discovers attachment-aware tools", async () => {
    const initialized = await rpc("initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "synthetic-core-test", version: "0.2.0" } });
    expect(initialized.serverInfo.version).toBe("0.2.0");
    expect(initialized.capabilities.resources).toBeTruthy();
    const { tools } = await rpc("tools/list", {});
    expect(tools).toHaveLength(12);
    expect(tools.find(tool => tool.name === "merge_pdfs")._meta["openai/fileParams"]).toEqual(["files"]);
  });
  it("returns real selected output bytes only in widget metadata in download mode", async () => {
    const result = await rpc("tools/call", { name: "select_pdf_pages", arguments: { pdf_base64: base64, page_numbers: [3, 1], output_mode: "download" } });
    expect(result.isError).toBeFalsy();
    expect(result.structuredContent.pdf_base64).toBeUndefined();
    expect(result.structuredContent.selected_page_numbers).toEqual([3, 1]);
    const output = await PDFDocument.load(Buffer.from(result._meta.pdf_file.pdf_base64, "base64"));
    expect(output.getPages().map(page => page.getWidth())).toEqual([330, 310]);
  });
  it("serves the exact MCP Apps output card resource", async () => {
    expect((await rpc("resources/list", {})).resources.map(resource => resource.uri)).toEqual([OUTPUT_RESOURCE_URI]);
    const { contents } = await rpc("resources/read", { uri: OUTPUT_RESOURCE_URI });
    expect(contents).toHaveLength(1);
    expect(contents[0].mimeType).toBe("text/html;profile=mcp-app");
    expect(contents[0].text).toContain("Download PDF copy");
    expect(contents[0]._meta.ui.csp.connectDomains).toEqual([]);
  });
  it("carries source-backed reading and typed refusal over HTTP", async () => {
    const result = await rpc("tools/call", { name: "read_pdf_pages", arguments: { pdf_base64: base64, start_page: 2, end_page: 3 } });
    expect(result.isError).toBeFalsy();
    expect(result.structuredContent.pages[0].text).toContain("Synthetic HTTP page 2");
    expect(result.structuredContent.coverage.unselected_pages).toBe(1);
    const failed = await rpc("tools/call", { name: "rotate_pdf_pages", arguments: { pdf_base64: base64, page_numbers: [2], rotation: 1 } });
    expect(failed.isError).toBe(true);
    expect(failed.content[0].text).toMatch(/^INVALID_ROTATION/);
  });
});
