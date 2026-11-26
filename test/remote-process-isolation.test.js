import { spawn, spawnSync } from "node:child_process";
import { EventEmitter } from "node:events";
import { PDFDocument } from "pdf-lib";
import { describe, expect, it } from "vitest";
import { createIsolatedDispatcher, createIsolationSelector } from "../remote/isolated-tool.mjs";
import {
  CHILD_DATA_LIMIT_BYTES, checkChildIsolation, childEnvironment, createChildToolFactory, instanceRss, isMemoryExit,
} from "../remote/process-isolation.mjs";
import { isAllocationFailure, MEMORY_LIMIT_CODE } from "../remote/decode-budget.mjs";

const linux = process.platform === "linux";
const code = result => result.content[0].text.split(":")[0];
const MiB = 1024 * 1024;

/** Runs a script in a Node child under the same shell limit the hosted factory uses. */
function underLimit(script, dataLimitBytes = CHILD_DATA_LIMIT_BYTES) {
  return spawnSync("/bin/sh", ["-c", 'ulimit -d "$0" || exit 97; exec "$@"', String(dataLimitBytes / 1024), process.execPath, "-e", script], {
    encoding: "utf8", timeout: 60_000, env: { PATH: process.env.PATH ?? "" },
  });
}

describe("hosted child-process isolation", () => {
  it("passes only the allowlisted environment, and signing secrets only to signing calls", () => {
    const source = { PATH: "/bin", PDF_TOOLS_SIGN_SEALING_KEYS: "k1:aa", PDF_TOOLS_CONNECT_SIGNING_SECRET: "s", VERCEL_OIDC_TOKEN: "t", AWS_SECRET_ACCESS_KEY: "a", PDF_TOOLS_EMBEDDED_NATIVE_CANVAS: "force" };
    expect(childEnvironment({}, source)).toEqual({ PATH: "/bin", PDF_TOOLS_EMBEDDED_NATIVE_CANVAS: "force" });
    expect(childEnvironment({ signing: true }, source)).toEqual({ PATH: "/bin", PDF_TOOLS_EMBEDDED_NATIVE_CANVAS: "force", PDF_TOOLS_SIGN_SEALING_KEYS: "k1:aa" });
  });

  it("classifies a V8 heap abort as a memory stop and an ordinary failure as not", () => {
    expect(isMemoryExit(null, "SIGABRT")).toBe(true);
    expect(isMemoryExit(134, null)).toBe(true);
    expect(isMemoryExit(1, null)).toBe(false);
    expect(isMemoryExit(null, "SIGKILL")).toBe(false);
    expect(isAllocationFailure(new RangeError("Array buffer allocation failed"))).toBe(true);
    expect(isAllocationFailure(new RangeError("WebAssembly.Memory.grow(): Unable to grow instance memory"))).toBe(true);
    expect(isAllocationFailure(new RangeError("Invalid array length"))).toBe(false);
    expect(isAllocationFailure(new Error("Array buffer allocation failed"))).toBe(false);
  });

  it("falls back to worker threads, loudly, when the boot check fails", async () => {
    const lines = [];
    const infos = [];
    const failing = createIsolationSelector({ check: async () => ({ ok: false, reason: "ulimit_failed" }), log: line => lines.push(line), info: line => infos.push(line) });
    expect(await failing()).toBe("thread");
    expect(await failing()).toBe("thread");
    expect(lines).toEqual(["ERROR pdf-tools: process isolation unavailable (ulimit_failed); using worker threads\n"]);
    expect(infos).toEqual([`pdf-tools: tool isolation thread on node ${process.versions.node}\n`]);
    const throwing = createIsolationSelector({ check: () => { throw new Error("boom"); }, log: line => lines.push(line), info: () => {} });
    expect(await throwing()).toBe("thread");
    const passing = createIsolationSelector({ check: async () => ({ ok: true, reason: "ok" }), log: line => lines.push(line), info: line => infos.push(line) });
    expect(await passing()).toBe("process");
    expect(infos.at(-1)).toBe(`pdf-tools: tool isolation process on node ${process.versions.node}\n`);
    expect(lines).toHaveLength(2);
  });

  it("reports a failed boot when a child cannot start", async () => {
    const result = await checkChildIsolation({ spawnImpl: () => { throw new Error("no shell"); } });
    expect(result).toEqual({ ok: false, reason: "spawn_failed" });
  });

  it("settles and frees the slot when a child never starts and emits only an error", async () => {
    const neverStarted = () => {
      const child = new EventEmitter();
      Object.assign(child, { pid: undefined, exitCode: null, signalCode: null, stdout: null, stderr: null, kill: () => false,
        send: () => { throw Object.assign(new Error("channel closed"), { code: "ERR_IPC_CHANNEL_CLOSED" }); } });
      // Two errors, as Node can emit when a kill follows a failed spawn; the second must not throw.
      setImmediate(() => {
        child.emit("error", Object.assign(new Error("spawn /bin/sh EAGAIN"), { code: "EAGAIN" }));
        child.emit("error", Object.assign(new Error("kill ESRCH"), { code: "ESRCH" }));
      });
      return child;
    };
    const dispatch = createIsolatedDispatcher({ maxWorkers: 1, workerFactory: createChildToolFactory({ spawnImpl: neverStarted }), readRss: () => 0 });
    expect(code(await dispatch("get_pdf_info", {}))).toBe("PROCESSING_FAILED");
    // The single slot is free again: a second call is attempted, not refused as busy.
    expect(code(await dispatch("get_pdf_info", {}))).toBe("PROCESSING_FAILED");
    const sensitive = createIsolatedDispatcher({ maxWorkers: 1, workerFactory: createChildToolFactory({ spawnImpl: neverStarted }), readRss: () => 0 });
    expect(code(await sensitive("send_lumin_request", {}, { lumin: { accessToken: "t" } }))).toBe("LUMIN_CREATE_OUTCOME_UNKNOWN");
  });

  it.runIf(linux)("boots a child under the limit on this Node, with the limit applied by the kernel", async () => {
    expect(await checkChildIsolation()).toEqual({ ok: true, reason: "ok" });
  });

  it.runIf(linux)("bounds buffers and WebAssembly memory inside the child, and kills only the child on heap exhaustion", () => {
    const buffers = underLimit(`const p=[];try{for(let i=0;i<256;i++){const b=new Uint8Array(16<<20);b.fill(1);p.push(b)}console.log("unbounded")}catch(e){console.log(e.constructor.name, process.memoryUsage().rss)}`);
    // Node 22 and later throw RangeError at the limit; Node 20 aborts the child instead. Either way the
    // growth stops inside the child, below the limit, and never reaches "unbounded".
    const stoppedInside = (run, expectRss) => {
      if (isMemoryExit(run.status, run.signal)) return;
      const [kind, rss] = run.stdout.trim().split(" ");
      expect(kind).toBe("RangeError");
      if (expectRss) expect(Number(rss)).toBeLessThan(CHILD_DATA_LIMIT_BYTES);
    };
    stoppedInside(buffers, true);
    const wasm = underLimit(`try{const m=new WebAssembly.Memory({initial:256,maximum:65536});for(let i=0;i<64;i++){m.grow(1024);new Uint8Array(m.buffer).fill(1)}console.log("unbounded")}catch(e){console.log(e.constructor.name)}`);
    stoppedInside(wasm, false);
    if (Number(process.versions.node.split(".")[0]) >= 22) {
      expect(buffers.stdout.trim().split(" ")[0]).toBe("RangeError");
      expect(wasm.stdout.trim()).toBe("RangeError");
    }
    // Old space is left at its default here so the data limit, not the heap flag, is what stops it.
    const heap = underLimit(`const p=[];for(let i=0;i<1e6;i++)p.push(new Array(131072).fill(i));`, 768 * MiB);
    expect(isMemoryExit(heap.status, heap.signal)).toBe(true);
  }, 120_000);

  it.runIf(linux)("runs a real tool call in a limited child and returns its exact result", async () => {
    const dispatch = createIsolatedDispatcher({ workerFactory: createChildToolFactory(), readRss: instanceRss });
    const document = await PDFDocument.create(); document.addPage([310, 420]);
    const result = await dispatch("get_pdf_info", { pdf_base64: Buffer.from(await document.save()).toString("base64") });
    expect(result.isError).toBeFalsy();
    expect(result.structuredContent.pages[0]).toMatchObject({ width: 310, height: 420 });
    expect(code(await dispatch("get_pdf_info", { pdf_base64: "not PDF secret" }))).toBe("INVALID_BASE64");
  }, 60_000);

  it.runIf(linux)("gives the child the worker's stack depth, so deeply nested valid PDFs still read", async () => {
    // A valid page whose dictionary holds an array nested 5,000 deep: fine on a 4 MB stack, lost on a 1 MB one.
    const nested = `${"[".repeat(5000)}1${"]".repeat(5000)}`;
    const body = "BT /F1 12 Tf 72 720 Td (Deep) Tj ET";
    const objects = ["<< /Type /Catalog /Pages 2 0 R >>", "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
      `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> /Deep ${nested} >>`,
      `<< /Length ${body.length} >>\nstream\n${body}\nendstream`, "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>"];
    let pdf = "%PDF-1.7\n";
    const offsets = objects.map((object, index) => { const at = pdf.length; pdf += `${index + 1} 0 obj\n${object}\nendobj\n`; return at; });
    const xref = pdf.length;
    pdf += `xref\n0 6\n0000000000 65535 f \n${offsets.map(at => `${String(at).padStart(10, "0")} 00000 n \n`).join("")}trailer\n<< /Size 6 /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
    const dispatch = createIsolatedDispatcher({ workerFactory: createChildToolFactory(), readRss: instanceRss });
    const pdf_base64 = Buffer.from(pdf, "latin1").toString("base64");
    const result = await dispatch("read_pdf_pages", { pdf_base64, start_page: 1, end_page: 1 });
    expect(result.isError).toBeFalsy();
    expect(JSON.stringify(result.structuredContent)).toContain("Deep");
    const rotated = await dispatch("rotate_pdf_pages", { pdf_base64, page_numbers: [1], rotation: 90 });
    expect(rotated.isError).toBeFalsy();
  }, 60_000);

  it.runIf(linux)("reports a child that dies at its memory limit as MEMORY_LIMIT, and a send as outcome unknown", async () => {
    const aborting = () => createChildToolFactory({
      dataLimitBytes: 768 * MiB,
      spawnImpl: (command, args, options) => {
        // Same shell, same limit, but the child exhausts its heap instead of running a tool.
        const script = "process.once('message',()=>{const p=[];for(let i=0;i<1e6;i++)p.push(new Array(131072).fill(i))})";
        const index = args.indexOf(process.execPath);
        return spawn(command, [...args.slice(0, index + 1), "-e", script], options);
      },
    });
    const dispatch = createIsolatedDispatcher({ workerFactory: aborting(), readRss: () => 0 });
    expect(code(await dispatch("get_pdf_info", {}))).toBe(MEMORY_LIMIT_CODE);
    const sensitive = createIsolatedDispatcher({ workerFactory: aborting(), readRss: () => 0 });
    expect(code(await sensitive("send_lumin_request", {}, { lumin: { accessToken: "t" } }))).toBe("LUMIN_CREATE_OUTCOME_UNKNOWN");
  }, 120_000);

});

