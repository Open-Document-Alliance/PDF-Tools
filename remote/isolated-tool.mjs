/** Wall-clock termination for hosted fetch/parser/mutation work, not an OS sandbox. */
import { Worker } from "node:worker_threads";

export const TOOL_DEADLINE_MS = 45_000;
export const MAX_ACTIVE_TOOL_WORKERS = 2;
const failure = (code, message) => ({ isError: true, content: [{ type: "text", text: `${code}: ${message}` }] });

export function createIsolatedDispatcher({
  workerFactory = options => new Worker(new URL("./tool-worker.mjs", import.meta.url), options),
  deadlineMs = TOOL_DEADLINE_MS,
  maxWorkers = MAX_ACTIVE_TOOL_WORKERS,
} = {}) {
  let active = 0;
  return async (name, args = {}, { signal } = {}) => {
    if (signal?.aborted) return failure("CANCELLED", "The document operation was cancelled before it started.");
    if (active >= maxWorkers) return failure("SERVICE_BUSY", "This service is busy. No document work was started.");
    active++;
    let worker;
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
        timer = setTimeout(() => { void finish(failure("PROCESSING_TIMEOUT", "That operation exceeded the hosted processing time limit.")); }, deadlineMs);
        try {
          worker = workerFactory({
            workerData: { name, args },
            resourceLimits: { maxOldGenerationSizeMb: 256, maxYoungGenerationSizeMb: 32, stackSizeMb: 4 },
            stdout: true, stderr: true,
          });
          // Never forward document-derived parser logs into hosted application logs.
          worker.stdout?.resume(); worker.stderr?.resume();
          worker.once("message", result => { void finish(result); });
          worker.once("error", () => { void finish(failure("PROCESSING_FAILED", "That document could not be processed.")); });
          worker.once("exit", () => { void finish(failure("PROCESSING_FAILED", "The document operation ended without a result.")); });
          cancel = () => { void finish(failure("CANCELLED", "The document operation was cancelled.")); };
          signal?.addEventListener("abort", cancel, { once: true });
          if (signal?.aborted) cancel();
        } catch {
          void finish(failure("PROCESSING_FAILED", "The document operation could not be started."));
        }
      });
    } finally {
      if (cancel) signal?.removeEventListener("abort", cancel);
      // Conservatively hold capacity if thread termination cannot be confirmed.
      if (!terminationFailed) active--;
    }
  };
}

export const callToolIsolated = createIsolatedDispatcher();
