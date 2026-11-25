/** Wall-clock termination for hosted fetch/parser/mutation work, not an OS sandbox. */
import { Worker } from "node:worker_threads";
import { requestsInFlight } from "./inflight.mjs";

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
 * process while workers run and stops work before the instance reaches its
 * platform limit (2 GB on the current Vercel configuration), which would end
 * every request on the instance at once.
 *
 * - Growth since work started is limited, not absolute RSS alone, because
 *   memory freed by a stopped worker is not always returned to the OS.
 * - Ordinary calls are stopped first; an outcome-sensitive call is stopped
 *   only if memory stays over the limit for several more samples.
 * - Above the absolute ceiling, new calls are refused before any work starts,
 *   and an idle process above it exits so the platform replaces it.
 */
export const PROCESS_MEMORY_CEILING_BYTES = 1700 * 1024 * 1024;
export const PROCESS_MEMORY_GROWTH_BYTES = 1100 * 1024 * 1024;
export const MEMORY_SAMPLE_MS = 25;
const SENSITIVE_GRACE_SAMPLES = 8;

export function createIsolatedDispatcher({
  workerFactory = options => new Worker(new URL("./tool-worker.mjs", import.meta.url), options),
  deadlineMs = TOOL_DEADLINE_MS,
  maxWorkers = MAX_ACTIVE_TOOL_WORKERS,
  memoryCeilingBytes = PROCESS_MEMORY_CEILING_BYTES,
  memoryGrowthBytes = PROCESS_MEMORY_GROWTH_BYTES,
  sampleMs = MEMORY_SAMPLE_MS,
  readRss = () => process.memoryUsage.rss(),
  recycle = () => process.exit(0),
  busy = () => requestsInFlight() > 0,
} = {}) {
  let active = 0;
  const running = new Set();
  let watchdog = null;
  let baseline = 0;
  let overSamples = 0;
  const safeRss = () => { try { return readRss(); } catch { return 0; } };
  const memoryFailure = () => failure("MEMORY_LIMIT", "That document needs more memory than the hosted service allows, so the operation was stopped. Use local PDF Tools for it: https://github.com/Open-Document-Alliance/PDF-Tools");
  const over = rss => rss > memoryCeilingBytes || rss - baseline > memoryGrowthBytes;
  const startWatchdog = () => {
    if (watchdog) return;
    baseline = safeRss();
    overSamples = 0;
    watchdog = setInterval(() => {
      const rss = safeRss();
      if (!over(rss)) { overSamples = 0; return; }
      overSamples++;
      const ordinary = [...running].filter(entry => !entry.sensitive && !entry.stopping);
      if (ordinary.length) { for (const entry of ordinary) entry.stop(); return; }
      // Wait for stopped workers to be gone before judging what remains.
      if ([...running].some(entry => entry.stopping)) return;
      if (overSamples > SENSITIVE_GRACE_SAMPLES) for (const entry of running) entry.stop();
    }, sampleMs);
    watchdog.unref?.();
  };
  const stopWatchdogIfIdle = () => {
    if (running.size !== 0 || !watchdog) return;
    clearInterval(watchdog);
    watchdog = null;
    // Memory a stopped worker held may stay mapped. If the idle process is
    // still above the ceiling, let the platform replace it.
    const admissionRss = safeRss();
    if (admissionRss > memoryCeilingBytes || (watchdog && admissionRss - baseline > memoryGrowthBytes)) {
      const timer = setTimeout(() => { if (active === 0 && !busy() && safeRss() > memoryCeilingBytes) recycle(); }, 1000);
      timer.unref?.();
    }
  };
  return async (name, args = {}, { signal, lumin } = {}) => {
    if (signal?.aborted) return failure("CANCELLED", "The document operation was cancelled before it started.");
    if (active >= maxWorkers) return failure("SERVICE_BUSY", "This service is busy. No document work was started.");
    const admissionRss = safeRss();
    if (admissionRss > memoryCeilingBytes || (watchdog && admissionRss - baseline > memoryGrowthBytes)) {
      return OUTCOME_SENSITIVE_TOOLS.has(name)
        ? failure("SEND_NOT_STARTED", "This service is short of memory right now, so nothing was sent to Lumin. Sending again in a moment is safe.")
        : failure("SERVICE_BUSY", "This service is short of memory right now. No document work was started; try again in a moment.");
    }
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
        entry = {
          sensitive,
          stopping: false,
          stop: () => {
            if (entry.stopping) return;
            entry.stopping = true;
            void finish(sensitive ? unknownOutcome() : memoryFailure()).then(() => {
              // Memory a stopped worker held may stay mapped; measure the
              // remaining calls from here so it is not counted against them.
              baseline = safeRss();
              overSamples = 0;
            });
          },
        };
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
