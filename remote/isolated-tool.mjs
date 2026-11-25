/** Wall-clock termination for hosted fetch/parser/mutation work, not an OS sandbox. */
import { Worker } from "node:worker_threads";

export const TOOL_DEADLINE_MS = 45_000;
export const MAX_ACTIVE_TOOL_WORKERS = 2;
const failure = (code, message) => ({ isError: true, content: [{ type: "text", text: `${code}: ${message}` }] });

/**
 * Tools whose interruption can leave an external side effect in an unknown
 * state. For these a timeout, cancellation or crash must never read as "no
 * work was done", or the caller's obvious next step is a duplicate.
 */
const OUTCOME_SENSITIVE_TOOLS = new Set(["send_lumin_request"]);
const unknownOutcome = () => failure(
  "LUMIN_CREATE_OUTCOME_UNKNOWN",
  "The send was interrupted, so the Lumin request may or may not exist. It was not retried. Check the Lumin dashboard or the signers' inboxes before sending again.",
);

/**
 * Process-memory backstop. The worker heap limit does not bound ArrayBuffer
 * memory (decoded streams, rendered pixels), so the parent samples the whole
 * process while workers run and stops them before the instance reaches its
 * platform limit (2 GB on the current Vercel configuration), which would end
 * every request on the instance at once.
 */
export const PROCESS_MEMORY_LIMIT_BYTES = 1400 * 1024 * 1024;
export const MEMORY_SAMPLE_MS = 25;

export function createIsolatedDispatcher({
  workerFactory = options => new Worker(new URL("./tool-worker.mjs", import.meta.url), options),
  deadlineMs = TOOL_DEADLINE_MS,
  maxWorkers = MAX_ACTIVE_TOOL_WORKERS,
  memoryLimitBytes = PROCESS_MEMORY_LIMIT_BYTES,
  sampleMs = MEMORY_SAMPLE_MS,
  readRss = () => process.memoryUsage.rss(),
} = {}) {
  let active = 0;
  const running = new Set();
  let watchdog = null;
  const memoryFailure = () => failure("MEMORY_LIMIT", "That document needs more memory than the hosted service allows, so the operation was stopped. Use local PDF Tools for it: https://github.com/Open-Document-Alliance/PDF-Tools");
  const startWatchdog = () => {
    if (watchdog) return;
    watchdog = setInterval(() => {
      let rss;
      try { rss = readRss(); } catch { return; }
      if (rss <= memoryLimitBytes) return;
      for (const entry of running) entry.stop();
    }, sampleMs);
    watchdog.unref?.();
  };
  const stopWatchdogIfIdle = () => {
    if (running.size === 0 && watchdog) { clearInterval(watchdog); watchdog = null; }
  };
  return async (name, args = {}, { signal, lumin } = {}) => {
    if (signal?.aborted) return failure("CANCELLED", "The document operation was cancelled before it started.");
    if (active >= maxWorkers) return failure("SERVICE_BUSY", "This service is busy. No document work was started.");
    active++;
    let worker;
    let entry;
    let timer;
    let cancel;
    let terminationFailed = false;
    try {
      return await new Promise(resolve => {
        let settled = false;
        const finish = async result => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          // Do not free the concurrency slot until the worker is actually gone.
          try { await worker?.terminate(); } catch { terminationFailed = true; }
          resolve(result);
        };
        const sensitive = OUTCOME_SENSITIVE_TOOLS.has(name);
        entry = { stop: () => { void finish(sensitive ? unknownOutcome() : memoryFailure()); } };
        running.add(entry);
        startWatchdog();
        timer = setTimeout(() => { void finish(sensitive ? unknownOutcome() : failure("PROCESSING_TIMEOUT", "That operation exceeded the hosted processing time limit.")); }, deadlineMs);
        try {
          worker = workerFactory({
            // The Lumin token crosses into the worker as data only, never as an argument the model sees.
            workerData: { name, args, context: lumin ? { lumin: { accessToken: lumin.accessToken } } : {} },
            resourceLimits: { maxOldGenerationSizeMb: 256, maxYoungGenerationSizeMb: 32, stackSizeMb: 4 },
            stdout: true, stderr: true,
          });
          // Never forward document-derived parser logs into hosted application logs.
          worker.stdout?.resume(); worker.stderr?.resume();
          worker.once("message", result => { void finish(result); });
          worker.once("error", () => { void finish(sensitive ? unknownOutcome() : failure("PROCESSING_FAILED", "That document could not be processed.")); });
          worker.once("exit", () => { void finish(sensitive ? unknownOutcome() : failure("PROCESSING_FAILED", "The document operation ended without a result.")); });
          cancel = () => { void finish(sensitive ? unknownOutcome() : failure("CANCELLED", "The document operation was cancelled.")); };
          signal?.addEventListener("abort", cancel, { once: true });
          if (signal?.aborted) cancel();
        } catch {
          void finish(failure("PROCESSING_FAILED", "The document operation could not be started."));
        }
      });
    } finally {
      if (entry) running.delete(entry);
      stopWatchdogIfIdle();
      if (cancel) signal?.removeEventListener("abort", cancel);
      // Conservatively hold capacity if thread termination cannot be confirmed.
      if (!terminationFailed) active--;
    }
  };
}

export const callToolIsolated = createIsolatedDispatcher();
