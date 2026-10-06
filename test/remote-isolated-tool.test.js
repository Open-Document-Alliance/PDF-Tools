import { EventEmitter } from "node:events";
import { Worker } from "node:worker_threads";
import { PDFDocument } from "pdf-lib";
import { afterEach, describe, expect, it, vi } from "vitest";
import { callToolIsolated, createIsolatedDispatcher, TOOL_DEADLINE_MS } from "../remote/isolated-tool.mjs";

afterEach(() => vi.useRealTimers());
const code = result => result.content[0].text.split(":")[0];

describe("hosted worker boundary", () => {
  it("runs a real PDF operation in the production worker and preserves its exact result", async () => {
    const document = await PDFDocument.create(); document.addPage([310, 420]);
    const result = await callToolIsolated("get_pdf_info", { pdf_base64: Buffer.from(await document.save()).toString("base64") });
    expect(result.isError).toBeFalsy();
    expect(result.structuredContent.pages[0]).toMatchObject({ width: 310, height: 420 });
    expect(TOOL_DEADLINE_MS).toBeLessThan(60_000);
  });
  it("preserves content-free typed refusals", async () => {
    expect(code(await callToolIsolated("get_pdf_info", { pdf_base64: "not PDF secret" }))).toBe("INVALID_BASE64");
  });
  it("actually terminates a CPU-bound worker, not just a cooperative promise", async () => {
    const started = new Int32Array(new SharedArrayBuffer(4));
    let terminated;
    const dispatch = createIsolatedDispatcher({ deadlineMs: 500, workerFactory: options => {
      const worker = new Worker("const {workerData}=require('node:worker_threads'); const started=new Int32Array(workerData.started); Atomics.store(started,0,1); while(true) {}", {
        ...options, eval: true, workerData: { started: started.buffer },
      });
      terminated = new Promise(resolve => worker.once("exit", resolve));
      return worker;
    } });
    const result = await dispatch("synthetic-stuck-parser");
    expect(Atomics.load(started, 0)).toBe(1);
    expect(code(result)).toBe("PROCESSING_TIMEOUT");
    expect(await terminated).not.toBe(0);
  });
  it("does not release capacity until termination completes and does not queue a PDF", async () => {
    vi.useFakeTimers();
    const worker = new EventEmitter();
    let release;
    worker.terminate = vi.fn(() => new Promise(resolve => { release = resolve; }));
    const factory = vi.fn(() => worker);
    const dispatch = createIsolatedDispatcher({ deadlineMs: 10, maxWorkers: 1, workerFactory: factory });
    const active = dispatch("a");
    expect(code(await dispatch("b"))).toBe("SERVICE_BUSY");
    await vi.advanceTimersByTimeAsync(11);
    expect(code(await dispatch("c"))).toBe("SERVICE_BUSY");
    expect(factory).toHaveBeenCalledTimes(1);
    release();
    expect(code(await active)).toBe("PROCESSING_TIMEOUT");
    worker.terminate = vi.fn(async () => 0);
    const next = dispatch("d"); worker.emit("message", { content: [], structuredContent: { synthetic: true } });
    expect((await next).structuredContent.synthetic).toBe(true);
    expect(factory.mock.calls[0][0]).toMatchObject({ stdout: true, stderr: true, resourceLimits: { maxOldGenerationSizeMb: 256 } });
  });
  it("returns opaque errors on startup, worker crash and premature exit", async () => {
    const startup = createIsolatedDispatcher({ workerFactory: () => { throw new Error("document secret"); } });
    expect(code(await startup("a"))).toBe("PROCESSING_FAILED");
    for (const event of ["error", "exit"]) {
      const worker = new EventEmitter(); worker.terminate = vi.fn(async () => 1);
      const dispatch = createIsolatedDispatcher({ workerFactory: () => worker });
      const result = dispatch("a"); worker.emit(event, new Error("document secret"));
      const failure = await result;
      expect(code(failure)).toBe("PROCESSING_FAILED");
      expect(JSON.stringify(failure)).not.toContain("document secret");
    }
  });
  it("terminates on MCP cancellation and starts no worker for an already-cancelled request", async () => {
    const worker = new EventEmitter(); worker.terminate = vi.fn(async () => 1);
    const factory = vi.fn(() => worker);
    const dispatch = createIsolatedDispatcher({ workerFactory: factory });
    const controller = new AbortController();
    const result = dispatch("a", {}, { signal: controller.signal });
    controller.abort();
    expect(code(await result)).toBe("CANCELLED");
    expect(worker.terminate).toHaveBeenCalledTimes(1);
    expect(code(await dispatch("b", {}, { signal: controller.signal }))).toBe("CANCELLED");
    expect(factory).toHaveBeenCalledTimes(1);
  });
  it("keeps the slot occupied if termination cannot be confirmed", async () => {
    const worker = new EventEmitter(); worker.terminate = vi.fn(async () => { throw new Error("termination uncertain"); });
    const factory = vi.fn(() => worker);
    const dispatch = createIsolatedDispatcher({ maxWorkers: 1, workerFactory: factory });
    const result = dispatch("a"); worker.emit("error", new Error("failure"));
    expect(code(await result)).toBe("PROCESSING_FAILED");
    expect(code(await dispatch("b"))).toBe("SERVICE_BUSY");
    expect(factory).toHaveBeenCalledTimes(1);
  });
});
