import { EventEmitter } from "node:events";
import { deflateSync } from "node:zlib";
import { PDFDocument } from "pdf-lib";
import { describe, expect, it } from "vitest";

import { MAX_DECODED_STREAM_BYTES } from "../remote/decode-budget.mjs";
import { createIsolatedDispatcher } from "../remote/isolated-tool.mjs";
import { callTool } from "../remote/server.mjs";

/** A minimal synthetic PDF with one compressed object stream of the given decoded size. */
function pdfWithObjectStream(decodedBytes) {
  const header = "9 0 ";
  const body = Buffer.alloc(decodedBytes, 0x20);
  body.write(header, 0, "latin1");
  body.write("<< >>", decodedBytes - 6, "latin1");
  const compressed = deflateSync(body, { level: 9 });
  const parts = [];
  const offsets = [];
  let position = 0;
  const push = value => { const bytes = Buffer.isBuffer(value) ? value : Buffer.from(value, "latin1"); parts.push(bytes); position += bytes.length; };
  push("%PDF-1.7\n");
  offsets[1] = position; push("1 0 obj\n<< /Type /Catalog /Pages 2 0 R >>\nendobj\n");
  offsets[2] = position; push("2 0 obj\n<< /Type /Pages /Kids [3 0 R] /Count 1 >>\nendobj\n");
  offsets[3] = position; push("3 0 obj\n<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] >>\nendobj\n");
  offsets[4] = position; push(`4 0 obj\n<< /Type /ObjStm /N 1 /First ${header.length} /Filter /FlateDecode /Length ${compressed.length} >>\nstream\n`);
  push(compressed); push("\nendstream\nendobj\n");
  const xref = position;
  let table = "xref\n0 5\n0000000000 65535 f \n";
  for (let index = 1; index <= 4; index++) table += `${String(offsets[index]).padStart(10, "0")} 00000 n \n`;
  push(`${table}trailer\n<< /Size 5 /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`);
  return Buffer.concat(parts);
}

describe("decoded data bounds", () => {
  it("processes an ordinary compressed object stream", async () => {
    const result = await callTool("get_pdf_info", { pdf_base64: pdfWithObjectStream(1024 * 1024).toString("base64") });
    expect(result.isError).toBeFalsy();
    expect(result.structuredContent.source.page_count).toBe(1);
  });

  it("refuses a stream whose decoded size exceeds the per-stream limit, with a typed answer", async () => {
    const pdf = pdfWithObjectStream(MAX_DECODED_STREAM_BYTES + 16 * 1024 * 1024);
    expect(pdf.length).toBeLessThan(1024 * 1024);
    const before = process.memoryUsage().arrayBuffers;
    const result = await callTool("get_pdf_info", { pdf_base64: pdf.toString("base64") });
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toMatch(/^DOCUMENT_TOO_LARGE_DECODED: /);
    expect(process.memoryUsage().arrayBuffers - before).toBeLessThan(MAX_DECODED_STREAM_BYTES * 2);
  }, 60_000);

  it("resets the budget for the next call", async () => {
    await callTool("get_pdf_info", { pdf_base64: pdfWithObjectStream(MAX_DECODED_STREAM_BYTES + 1024 * 1024).toString("base64") });
    const result = await callTool("get_pdf_info", { pdf_base64: pdfWithObjectStream(1024 * 1024).toString("base64") });
    expect(result.isError).toBeFalsy();
  }, 60_000);

  it("still reads ordinary documents unchanged", async () => {
    const doc = await PDFDocument.create();
    doc.addPage().drawText("Synthetic bounded read");
    const result = await callTool("read_pdf_pages", { pdf_base64: Buffer.from(await doc.save()).toString("base64"), start_page: 1, end_page: 1 });
    expect(result.isError).toBeFalsy();
    expect(JSON.stringify(result.structuredContent)).toContain("Synthetic bounded read");
  });
});

describe("process memory backstop", () => {
  const silentWorker = () => Object.assign(new EventEmitter(), { terminate: async () => {}, stdout: null, stderr: null });

  it("stops running work once process memory passes the limit", async () => {
    let rss = 100;
    const dispatch = createIsolatedDispatcher({ workerFactory: silentWorker, deadlineMs: 5_000, memoryLimitBytes: 1_000, sampleMs: 5, readRss: () => rss });
    const pending = dispatch("read_pdf_pages", {});
    setTimeout(() => { rss = 2_000; }, 20);
    const result = await pending;
    expect(result.content[0].text).toMatch(/^MEMORY_LIMIT: /);
  });

  it("reports an interrupted send as an unknown outcome rather than a memory refusal", async () => {
    const dispatch = createIsolatedDispatcher({ workerFactory: silentWorker, deadlineMs: 5_000, memoryLimitBytes: 1_000, sampleMs: 5, readRss: () => 2_000 });
    const result = await dispatch("send_lumin_request", {}, { lumin: { accessToken: "t" } });
    expect(result.content[0].text).toMatch(/^LUMIN_CREATE_OUTCOME_UNKNOWN: /);
  });

  it("leaves work alone below the limit and frees its slot afterwards", async () => {
    const replying = () => {
      const worker = Object.assign(new EventEmitter(), { terminate: async () => {}, stdout: null, stderr: null });
      setTimeout(() => worker.emit("message", { content: [{ type: "text", text: "done" }] }), 30);
      return worker;
    };
    const dispatch = createIsolatedDispatcher({ workerFactory: replying, deadlineMs: 5_000, memoryLimitBytes: 1_000, sampleMs: 5, readRss: () => 500, maxWorkers: 1 });
    expect((await dispatch("read_pdf_pages", {})).content[0].text).toBe("done");
    expect((await dispatch("read_pdf_pages", {})).content[0].text).toBe("done");
  });
});
