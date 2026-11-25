/**
 * Per-call child processes with an operating-system memory limit.
 *
 * The decode hooks (decode-budget.mjs, pdfjs-bounded.mjs) are the primary
 * defence and keep normal documents far below any limit here. This is the
 * structural backstop behind them: each hosted tool call runs in its own Node
 * process started under RLIMIT_DATA, so an allocation path the hooks do not
 * cover fails inside that one process instead of taking the instance, and
 * every other request on it, down.
 *
 * - The limit is set by `/bin/sh -c 'ulimit -d'` before `exec node`, because
 *   Node has no setrlimit and the Vercel image has no prlimit. bash's `ulimit`
 *   sets the soft and hard limits together, so the child cannot raise it.
 * - RLIMIT_AS is not used: V8 reserves large virtual regions for WebAssembly,
 *   which PDF.js uses for JPX and JBIG2, so an address-space limit breaks
 *   ordinary scans.
 * - At the limit, ArrayBuffer and WebAssembly.Memory growth throw RangeError
 *   (reported as MEMORY_LIMIT by the tool) and V8 heap exhaustion aborts the
 *   child (SIGABRT, reported as MEMORY_LIMIT by the dispatcher).
 * - V8 reserves part of the data limit at startup (about 0.5 GiB on Node 26),
 *   so usable memory is roughly the limit minus that reservation. It reserves
 *   more when the limit allows it (about 1 GiB more under 2 GiB), so measure
 *   VmData under the real limit, on the real host, before changing it. On the
 *   Vercel host the heaviest call the decode budgets allow peaks near 1 GB of
 *   VmData under this limit, and budget refusals arrive first. A boot check
 *   proves a child starts under the limit and that the kernel applied it. If it
 *   fails, calls fall back to per-call worker threads with the in-process hooks
 *   and the RSS watchdog, and an error-level log line says so.
 * - The child gets only the environment it needs. Signing secrets are passed
 *   only to calls on the authenticated signing route.
 */
import { spawn } from "node:child_process";
import { EventEmitter } from "node:events";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

export const CHILD_DATA_LIMIT_BYTES = 1536 * 1024 * 1024;
export const CHILD_OLD_SPACE_MB = 256;
export const CHILD_SEMI_SPACE_MB = 16;
const BOOT_CHECK_TIMEOUT_MS = 10_000;
const TERMINATION_CONFIRM_MS = 5_000;
const ULIMIT_FAILED_EXIT = 97;
const CHILD_ENTRY = fileURLToPath(new URL("./tool-child.mjs", import.meta.url));

const ENV_ALLOWLIST = [
  "PATH", "HOME", "LANG", "LC_ALL", "TZ", "TMPDIR", "NODE_ENV", "LD_LIBRARY_PATH",
  "NAPI_RS_NATIVE_LIBRARY_PATH", "PDF_TOOLS_FORCE_SYSTEM_RENDERER", "PDF_TOOLS_DISABLE_SYSTEM_RENDERER", "PDF_TOOLS_EMBEDDED_NATIVE_CANVAS",
];
const SIGNING_ENV = ["PDF_TOOLS_SIGN_SEALING_KEYS"];

export function childEnvironment({ signing = false } = {}, source = process.env) {
  const env = {};
  for (const name of signing ? [...ENV_ALLOWLIST, ...SIGNING_ENV] : ENV_ALLOWLIST) {
    if (source[name] !== undefined) env[name] = source[name];
  }
  return env;
}

/** Live children, so the parent's memory watchdog can count their RSS. */
const live = new Set();
const PAGE_BYTES = 4096;

function residentBytes(pid) {
  try { return Number(readFileSync(`/proc/${pid}/statm`, "utf8").split(" ")[1]) * PAGE_BYTES || 0; } catch { return 0; }
}

/** Parent RSS plus the RSS of every live tool child. */
export function instanceRss() {
  let total = process.memoryUsage.rss();
  for (const pid of live) total += residentBytes(pid);
  return total;
}

/** A V8 heap abort, or an exit the shell reported for one, is a memory stop. */
export function isMemoryExit(code, signal) {
  return signal === "SIGABRT" || signal === "SIGTRAP" || code === 134 || code === 133;
}

function spawnLimited(mode, { dataLimitBytes, env, spawnImpl = spawn }) {
  const kib = String(Math.floor(dataLimitBytes / 1024));
  return spawnImpl("/bin/sh", [
    "-c", `ulimit -d "$0" || exit ${ULIMIT_FAILED_EXIT}; exec "$@"`, kib,
    process.execPath, `--max-old-space-size=${CHILD_OLD_SPACE_MB}`, `--max-semi-space-size=${CHILD_SEMI_SPACE_MB}`, CHILD_ENTRY, mode,
  ], { stdio: ["ignore", "pipe", "pipe", "ipc"], serialization: "advanced", env });
}

/**
 * The same surface the dispatcher uses from a worker_threads Worker:
 * `message`, `error` and `exit` events, `terminate()`, and stdout/stderr.
 * `memoryLimited` is true once the child has died at its memory limit.
 */
class ChildToolProcess extends EventEmitter {
  constructor(child) {
    super();
    this.child = child;
    this.stdout = child.stdout;
    this.stderr = child.stderr;
    this.memoryLimited = false;
    this.exited = new Promise(resolve => {
      child.once("exit", (code, signal) => {
        live.delete(child.pid);
        this.memoryLimited = isMemoryExit(code, signal);
        resolve();
        this.emit("exit", code);
      });
      // A child that never started (no shell, EAGAIN, ENOMEM) emits "error"
      // and may never emit "exit"; nothing is running, so it has exited.
      child.once("error", error => {
        if (!child.pid) resolve();
        this.emit("error", error);
      });
    });
    if (child.pid) live.add(child.pid);
    child.once("message", message => this.emit("message", message));
  }

  /** Resolves once the child is gone; throws if that cannot be confirmed, so the dispatcher keeps the slot. */
  async terminate() {
    if (this.child.pid && this.child.exitCode === null && this.child.signalCode === null) this.child.kill("SIGKILL");
    let timer;
    try {
      await Promise.race([this.exited, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error("child termination unconfirmed")), TERMINATION_CONFIRM_MS); })]);
    } finally {
      clearTimeout(timer);
    }
  }
}

export function createChildToolFactory({ dataLimitBytes = CHILD_DATA_LIMIT_BYTES, spawnImpl } = {}) {
  return ({ workerData }) => {
    const signing = Boolean(workerData?.context?.lumin);
    const child = spawnLimited("tool", { dataLimitBytes, env: childEnvironment({ signing }), spawnImpl });
    const wrapped = new ChildToolProcess(child);
    // The request crosses as an IPC message, never as an argument or variable.
    // A failed send leaves the child without work, so stop it; its exit settles the call.
    const stop = () => { wrapped.terminate().catch(() => {}); };
    try { child.send(workerData, error => { if (error) stop(); }); } catch { stop(); }
    return wrapped;
  };
}

/**
 * Boot check: a child must start under the limit, see the limit applied by the
 * kernel, and answer over IPC. Resolves { ok, reason } and never throws.
 */
export function checkChildIsolation({ dataLimitBytes = CHILD_DATA_LIMIT_BYTES, spawnImpl, timeoutMs = BOOT_CHECK_TIMEOUT_MS } = {}) {
  return new Promise(resolve => {
    let child;
    let done = false;
    const finish = result => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      try { child?.kill("SIGKILL"); } catch {}
      resolve(result);
    };
    const timer = setTimeout(() => finish({ ok: false, reason: "boot_check_timeout" }), timeoutMs);
    timer.unref?.();
    try {
      child = spawnLimited("probe", { dataLimitBytes, env: childEnvironment(), spawnImpl });
    } catch {
      return finish({ ok: false, reason: "spawn_failed" });
    }
    child.stdout?.resume();
    child.stderr?.resume();
    child.once("error", () => finish({ ok: false, reason: "spawn_failed" }));
    child.once("message", message => {
      if (message?.probe !== true) return finish({ ok: false, reason: "probe_unexpected_reply" });
      if (message.dataLimitBytes !== Math.floor(dataLimitBytes / 1024) * 1024) return finish({ ok: false, reason: "limit_not_applied" });
      finish({ ok: true, reason: "ok" });
    });
    child.once("exit", (code, signal) => finish({
      ok: false,
      reason: code === ULIMIT_FAILED_EXIT ? "ulimit_failed" : isMemoryExit(code, signal) ? "child_cannot_start_under_limit" : "probe_exited",
    }));
  });
}
