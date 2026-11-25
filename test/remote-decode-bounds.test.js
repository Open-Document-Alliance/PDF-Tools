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

/** One page whose content stream decodes to the given size. */
function pdfWithPageContent(decodedBytes) {
  const body = Buffer.alloc(decodedBytes, 0x20);
  body.write("BT ET", decodedBytes - 6, "latin1");
  const compressed = deflateSync(body, { level: 9 });
  const parts = [];
  const offsets = [];
  let position = 0;
  const push = value => { const bytes = Buffer.isBuffer(value) ? value : Buffer.from(value, "latin1"); parts.push(bytes); position += bytes.length; };
  push("%PDF-1.7\n");
  offsets[1] = position; push("1 0 obj\n<< /Type /Catalog /Pages 2 0 R >>\nendobj\n");
  offsets[2] = position; push("2 0 obj\n<< /Type /Pages /Kids [3 0 R] /Count 1 >>\nendobj\n");
  offsets[3] = position; push("3 0 obj\n<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 4 0 R >>\nendobj\n");
  offsets[4] = position; push(`4 0 obj\n<< /Filter /FlateDecode /Length ${compressed.length} >>\nstream\n`);
  push(compressed); push("\nendstream\nendobj\n");
  const xref = position;
  let table = "xref\n0 5\n0000000000 65535 f \n";
  for (let index = 1; index <= 4; index++) table += `${String(offsets[index]).padStart(10, "0")} 00000 n \n`;
  push(`${table}trailer\n<< /Size 5 /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`);
  return Buffer.concat(parts);
}


/** One page plus extra stream objects (dict text, decoded size or raw bytes), unreferenced or referenced by the page. */
function pdfWithStreams({ contents = null, extra = [] }) {
  const objects = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792]${contents ? " /Contents 4 0 R" : ""} >>`,
  ];
  const streams = [];
  if (contents) streams.push(contents);
  streams.push(...extra);
  const parts = [];
  const offsets = [];
  let position = 0;
  const push = value => { const bytes = Buffer.isBuffer(value) ? value : Buffer.from(value, "latin1"); parts.push(bytes); position += bytes.length; };
  push("%PDF-1.7\n");
  objects.forEach((text, index) => { offsets[index + 1] = position; push(`${index + 1} 0 obj\n${text}\nendobj\n`); });
  streams.forEach((stream, index) => {
    const number = objects.length + index + 1;
    const data = stream.raw ?? deflateSync(Buffer.alloc(stream.decoded, 0x20), { level: 9 });
    offsets[number] = position;
    push(`${number} 0 obj\n<< ${stream.dict ?? ""} /Filter /FlateDecode /Length ${data.length} >>\nstream\n`);
    push(data); push("\nendstream\nendobj\n");
  });
  const total = objects.length + streams.length;
  const xref = position;
  let table = `xref\n0 ${total + 1}\n0000000000 65535 f \n`;
  for (let index = 1; index <= total; index++) table += `${String(offsets[index]).padStart(10, "0")} 00000 n \n`;
  push(`${table}trailer\n<< /Size ${total + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`);
  return Buffer.concat(parts);
}

describe("decoded data bounds for text extraction", () => {
  it("checks page content under the cap before PDF.js reads it", async () => {
    const pdf = pdfWithPageContent(MAX_DECODED_STREAM_BYTES + 8 * 1024 * 1024);
    for (const name of ["read_pdf_pages", "search_pdf_text", "convert_pdf_to_markdown"]) {
      const result = await callTool(name, { pdf_base64: pdf.toString("base64"), start_page: 1, end_page: 1, ...(name === "search_pdf_text" ? { query: "x" } : {}) });
      expect(result.content[0].text, name).toMatch(/^DOCUMENT_TOO_LARGE_DECODED: /);
    }
    const zones = await callTool("detect_signature_zones", { pdf_base64: pdf.toString("base64") });
    expect(zones.content[0].text).toMatch(/^DOCUMENT_TOO_LARGE_DECODED: /);
  }, 120_000);

  it("refuses an oversized stream wherever it sits in the document, not only in page contents", async () => {
    const pdf = pdfWithStreams({ contents: { decoded: 64 }, extra: [{ dict: "/Type /XObject /Subtype /Form /BBox [0 0 10 10]", decoded: MAX_DECODED_STREAM_BYTES + 4 * 1024 * 1024 }] });
    const result = await callTool("read_pdf_pages", { pdf_base64: pdf.toString("base64"), start_page: 1, end_page: 1 });
    expect(result.content[0].text).toMatch(/^DOCUMENT_TOO_LARGE_DECODED: /);
  }, 60_000);

  it("does not decode image streams for text extraction", async () => {
    const pdf = pdfWithStreams({ contents: { decoded: 64 }, extra: [{ dict: "/Type /XObject /Subtype /Image /Width 1 /Height 1 /ColorSpace /DeviceGray /BitsPerComponent 8", decoded: MAX_DECODED_STREAM_BYTES + 4 * 1024 * 1024 }] });
    const result = await callTool("read_pdf_pages", { pdf_base64: pdf.toString("base64"), start_page: 1, end_page: 1 });
    expect(result.isError).toBeFalsy();
  }, 60_000);

  it("still reads a document with a damaged stream, as before", async () => {
    const pdf = pdfWithStreams({ contents: { decoded: 64 }, extra: [{ dict: "", raw: Buffer.from([0x78, 0x9c, 0x01, 0x02, 0x03, 0xff, 0xfe]) }] });
    const result = await callTool("read_pdf_pages", { pdf_base64: pdf.toString("base64"), start_page: 1, end_page: 1 });
    expect(result.content[0].text).not.toMatch(/^(INTERNAL_ERROR|DOCUMENT_TOO_LARGE_DECODED)/);
  });

  it("keeps budgets separate for overlapping calls", async () => {
    const large = pdfWithObjectStream(MAX_DECODED_STREAM_BYTES + 4 * 1024 * 1024).toString("base64");
    const small = pdfWithObjectStream(1024 * 1024).toString("base64");
    const [refused, fine] = await Promise.all([callTool("get_pdf_info", { pdf_base64: large }), callTool("get_pdf_info", { pdf_base64: small })]);
    expect(refused.content[0].text).toMatch(/^DOCUMENT_TOO_LARGE_DECODED/);
    expect(fine.isError).toBeFalsy();
  }, 60_000);
});

describe("process memory backstop", () => {
  const silentWorker = () => Object.assign(new EventEmitter(), { terminate: async () => {}, stdout: null, stderr: null });
  const replying = (delay = 30) => () => {
    const worker = Object.assign(new EventEmitter(), { terminate: async () => {}, stdout: null, stderr: null });
    setTimeout(() => worker.emit("message", { content: [{ type: "text", text: "done" }] }), delay);
    return worker;
  };
  const limits = { memoryCeilingBytes: 10_000, memoryGrowthBytes: 1_000, sampleMs: 5, deadlineMs: 5_000 };

  it("stops a call whose memory grows past the limit", async () => {
    let rss = 100;
    const dispatch = createIsolatedDispatcher({ ...limits, workerFactory: silentWorker, readRss: () => rss });
    const pending = dispatch("read_pdf_pages", {});
    setTimeout(() => { rss = 1_200; }, 20);
    expect((await pending).content[0].text).toMatch(/^MEMORY_LIMIT: /);
  });

  it("does not lock out the next call when memory stays raised after a stop", async () => {
    let rss = 100;
    let calls = 0;
    const factory = () => (calls++ === 0 ? silentWorker() : replying()());
    const dispatch = createIsolatedDispatcher({ ...limits, workerFactory: factory, readRss: () => rss, recycle: () => {} });
    const first = dispatch("read_pdf_pages", {});
    setTimeout(() => { rss = 1_200; }, 20);
    expect((await first).content[0].text).toMatch(/^MEMORY_LIMIT/);
    // The stopped worker's memory is not returned to the OS: still raised,
    // above the old growth limit but below the ceiling. The next call runs.
    expect((await dispatch("read_pdf_pages", {})).content[0].text).toBe("done");
  });

  it("refuses new work above the ceiling before starting it, and says a send was not made", async () => {
    let started = 0;
    const factory = () => { started++; return silentWorker(); };
    const dispatch = createIsolatedDispatcher({ ...limits, workerFactory: factory, readRss: () => 20_000 });
    expect((await dispatch("read_pdf_pages", {})).content[0].text).toMatch(/^SERVICE_BUSY: .*No document work was started/);
    expect((await dispatch("send_lumin_request", {}, { lumin: { accessToken: "t" } })).content[0].text).toMatch(/^SEND_NOT_STARTED: .*nothing was sent/);
    expect(started).toBe(0);
  });

  it("stops ordinary calls before an outcome-sensitive one", async () => {
    let rss = 100;
    const dispatch = createIsolatedDispatcher({ ...limits, maxWorkers: 2, workerFactory: silentWorker, readRss: () => rss });
    const send = dispatch("send_lumin_request", {}, { lumin: { accessToken: "t" } });
    const read = dispatch("read_pdf_pages", {});
    setTimeout(() => { rss = 1_200; }, 20);
    expect((await read).content[0].text).toMatch(/^MEMORY_LIMIT/);
    setTimeout(() => { rss = 200; }, 0);
    const outcome = await Promise.race([send.then(result => result.content[0].text), new Promise(resolve => setTimeout(() => resolve("still running"), 150))]);
    expect(outcome).toBe("still running");
  });

  it("measures later calls from after a stop, so a concurrent send and the next calls are unaffected", async () => {
    let rss = 100;
    let calls = 0;
    const factory = () => (calls++ === 0 ? silentWorker() : replying(120)());
    const dispatch = createIsolatedDispatcher({ ...limits, maxWorkers: 2, workerFactory: factory, readRss: () => rss, recycle: () => {} });
    const hog = dispatch("read_pdf_pages", {});
    const send = dispatch("send_lumin_request", {}, { lumin: { accessToken: "t" } });
    setTimeout(() => { rss = 1_200; }, 20);
    expect((await hog).content[0].text).toMatch(/^MEMORY_LIMIT/);
    // The stopped worker's memory stays mapped; rss does not fall back.
    expect((await send).content[0].text).toBe("done");
    expect((await dispatch("read_pdf_pages", {})).content[0].text).toBe("done");
  });

  it("refuses new work while growth is already over the limit", async () => {
    let rss = 100;
    let started = 0;
    const dispatch = createIsolatedDispatcher({ ...limits, maxWorkers: 2, sampleMs: 1_000, workerFactory: () => { started++; return silentWorker(); }, readRss: () => rss });
    const first = dispatch("read_pdf_pages", {});
    rss = 1_500;
    const second = await dispatch("read_pdf_pages", {});
    expect(second.content[0].text).toMatch(/^SERVICE_BUSY/);
    expect(started).toBe(1);
    rss = 100;
    void first;
  });

  it("does not replace the process while any request is in flight", async () => {
    let rss = 100;
    let recycled = 0;
    const dispatch = createIsolatedDispatcher({ ...limits, workerFactory: silentWorker, readRss: () => rss, recycle: () => { recycled++; }, busy: () => true });
    const pending = dispatch("read_pdf_pages", {});
    setTimeout(() => { rss = 12_000; }, 20);
    await pending;
    await new Promise(resolve => setTimeout(resolve, 1_200));
    expect(recycled).toBe(0);
  });

  it("asks the platform to replace an idle process left above the ceiling", async () => {
    let rss = 100;
    let recycled = 0;
    const dispatch = createIsolatedDispatcher({ ...limits, workerFactory: silentWorker, readRss: () => rss, recycle: () => { recycled++; }, busy: () => false });
    const pending = dispatch("read_pdf_pages", {});
    setTimeout(() => { rss = 12_000; }, 20);
    await pending;
    await new Promise(resolve => setTimeout(resolve, 1_200));
    expect(recycled).toBe(1);
  });

  it("leaves work alone below the limits and frees its slot afterwards", async () => {
    const dispatch = createIsolatedDispatcher({ ...limits, maxWorkers: 1, workerFactory: replying(), readRss: () => 500 });
    expect((await dispatch("read_pdf_pages", {})).content[0].text).toBe("done");
    expect((await dispatch("read_pdf_pages", {})).content[0].text).toBe("done");
  });
});
