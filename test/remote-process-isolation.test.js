import { spawn, spawnSync } from "node:child_process";
import { EventEmitter } from "node:events";
import { readFileSync } from "node:fs";
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
    const failing = createIsolationSelector({ check: async () => ({ ok: false, reason: "ulimit_failed" }), log: line => lines.push(line) });
    expect(await failing()).toBe("thread");
    expect(await failing()).toBe("thread");
    expect(lines).toEqual(["ERROR pdf-tools: process isolation unavailable (ulimit_failed); using worker threads\n"]);
    const throwing = createIsolationSelector({ check: () => { throw new Error("boom"); }, log: line => lines.push(line) });
    expect(await throwing()).toBe("thread");
    const passing = createIsolationSelector({ check: async () => ({ ok: true, reason: "ok" }), log: line => lines.push(line) });
    expect(await passing()).toBe("process");
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
      setImmediate(() => child.emit("error", Object.assign(new Error("spawn /bin/sh EAGAIN"), { code: "EAGAIN" })));
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
    const [kind, rss] = buffers.stdout.trim().split(" ");
    expect(kind).toBe("RangeError");
    expect(Number(rss)).toBeLessThan(CHILD_DATA_LIMIT_BYTES);
    const wasm = underLimit(`try{const m=new WebAssembly.Memory({initial:256,maximum:65536});for(let i=0;i<64;i++){m.grow(1024);new Uint8Array(m.buffer).fill(1)}console.log("unbounded")}catch(e){console.log(e.constructor.name)}`);
    expect(wasm.stdout.trim()).toBe("RangeError");
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

  it("pins the hosted functions to one Node major, and CI tests that major (set HOSTED_NODE_PIN_CHECK=1)", () => {
    const pinned = JSON.parse(readFileSync(new URL("../api/package.json", import.meta.url), "utf8")).engines?.node;
    expect(pinned).toMatch(/^\d+\.x$/);
    if (process.env.HOSTED_NODE_PIN_CHECK === "1") {
      // The hosted-runtime CI job runs this file on the pinned major; changing one without the other fails here.
      expect(`${process.versions.node.split(".")[0]}.x`).toBe(pinned);
    }
  });
});

