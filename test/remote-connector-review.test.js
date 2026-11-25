import { randomBytes } from "node:crypto";
import { PDFDocument, StandardFonts } from "pdf-lib";
import { describe, expect, it } from "vitest";

import { handleMcpFetch, MAX_HANDLER_BODY_BYTES } from "../remote/http.mjs";
import { MAX_INLINE_PDF_BYTES } from "../remote/server.mjs";

const HEADERS = { "content-type": "application/json", accept: "application/json, text/event-stream", "mcp-protocol-version": "2025-11-25" };

async function post(body) {
  const response = await handleMcpFetch(new Request("http://localhost/mcp", { method: "POST", headers: HEADERS, body }));
  const raw = await response.text();
  const data = response.headers.get("content-type")?.includes("text/event-stream")
    ? raw.split(/\r?\n/).filter(line => line.startsWith("data: ")).map(line => line.slice(6)).join("")
    : raw;
  return { status: response.status, message: JSON.parse(data) };
}

const rpc = (id, method, params) => post(JSON.stringify({ jsonrpc: "2.0", id, method, params }));

/** A conspicuously synthetic PDF padded with an attachment to land just under `target` bytes. */
async function paddedPdf(target, label) {
  const doc = await PDFDocument.create();
  doc.setTitle(`SYNTHETIC ${label}`);
  const page = doc.addPage([612, 792]);
  page.drawText(`Synthetic ${label}`, { x: 72, y: 700, size: 14, font: await doc.embedFont(StandardFonts.Helvetica) });
  const base = (await doc.save({ useObjectStreams: false })).length;
  await doc.attach(randomBytes(target - base - 4096), "padding.bin", { mimeType: "application/octet-stream" });
  const bytes = await doc.save({ useObjectStreams: false });
  expect(bytes.length).toBeLessThanOrEqual(target);
  expect(bytes.length).toBeGreaterThan(target - 8 * 1024);
  return bytes;
}

describe("hosted connector review requirements", () => {
  it("gives every tool a human-readable annotation title and explicit hints", async () => {
    const { message } = await rpc(1, "tools/list", {});
    const tools = message.result.tools;
    expect(tools).toHaveLength(12);
    for (const tool of tools) {
      expect(typeof tool.annotations?.title, tool.name).toBe("string");
      expect(tool.annotations.title.trim().length, tool.name).toBeGreaterThan(0);
      expect(typeof tool.annotations.readOnlyHint, tool.name).toBe("boolean");
      expect(typeof tool.annotations.destructiveHint, tool.name).toBe("boolean");
      expect(typeof tool.annotations.openWorldHint, tool.name).toBe("boolean");
    }
    expect(new Set(tools.map(tool => tool.annotations.title)).size).toBe(tools.length);
  });

  it("points encrypted documents at the local server, not the retired desktop extension wording", async () => {
    const { message } = await rpc(1, "initialize", { protocolVersion: "2025-11-25", capabilities: {}, clientInfo: { name: "synthetic-review-test", version: "0" } });
    expect(message.result.instructions).not.toMatch(/desktop extension/i);
    expect(message.result.instructions).toMatch(/local PDF Tools server \(Claude plugin or desktop app\)/);
  });
});

describe("hosted inline-size boundary over HTTP", () => {
  it("leaves the host as the outer body limit, above a full 3 MiB inline document", () => {
    const largestInlineBody = 4 * Math.ceil(MAX_INLINE_PDF_BYTES / 3) + 1024;
    expect(MAX_HANDLER_BODY_BYTES).toBeGreaterThan(largestInlineBody);
  });

  it("accepts an inline document of exactly the documented limit", async () => {
    // Exactly 3 MiB: base64 alone is then 4 MiB, so the SDK's default ceiling
    // refused this request before the handler limit was raised.
    const padded = await paddedPdf(MAX_INLINE_PDF_BYTES, "AT LIMIT");
    const bytes = Buffer.concat([Buffer.from(padded), Buffer.from(`\n%${" ".repeat(MAX_INLINE_PDF_BYTES - padded.length - 2)}`)]);
    expect(bytes.length).toBe(MAX_INLINE_PDF_BYTES);
    const { status, message } = await rpc(1, "tools/call", { name: "get_pdf_info", arguments: { pdf_base64: Buffer.from(bytes).toString("base64") } });
    expect(status).toBe(200);
    expect(message.result.isError).toBeFalsy();
    expect(message.result.structuredContent.source.size_bytes).toBe(MAX_INLINE_PDF_BYTES);
  }, 60_000);

  it("answers just above the limit with this service's own guidance, not a bare 413", async () => {
    const bytes = await paddedPdf(MAX_INLINE_PDF_BYTES + 64 * 1024, "OVER LIMIT");
    expect(bytes.length).toBeGreaterThan(MAX_INLINE_PDF_BYTES);
    const { status, message } = await rpc(1, "tools/call", { name: "get_pdf_info", arguments: { pdf_base64: Buffer.from(bytes).toString("base64") } });
    expect(status).toBe(200);
    expect(message.result.isError).toBe(true);
    expect(message.result.content[0].text).toMatch(/^TOO_LARGE_INLINE: /);
    expect(message.result.content[0].text).toMatch(/pdf_url|file/);
  }, 60_000);

  it("still refuses a body above the handler ceiling", async () => {
    const body = JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "get_pdf_info", arguments: { pdf_base64: "A".repeat(MAX_HANDLER_BODY_BYTES) } } });
    const { status } = await post(body);
    expect(status).toBe(413);
  });
});

describe("one server per request (GHSA-jm63-cq47-j5jp)", () => {
  it("returns each concurrent caller its own result when JSON-RPC ids collide", async () => {
    const make = async pages => {
      const doc = await PDFDocument.create();
      doc.setTitle(`SYNTHETIC ${pages}-PAGE`);
      for (let index = 0; index < pages; index++) doc.addPage([612, 792]);
      return Buffer.from(await doc.save()).toString("base64");
    };
    const [three, one] = await Promise.all([make(3), make(1)]);
    const [a, b] = await Promise.all([three, one].map(pdf_base64 => rpc(7, "tools/call", { name: "get_pdf_info", arguments: { pdf_base64 } })));
    expect(a.message.id).toBe(7);
    expect(b.message.id).toBe(7);
    expect(a.message.result.structuredContent.source.page_count).toBe(3);
    expect(b.message.result.structuredContent.source.page_count).toBe(1);
  }, 60_000);
});
