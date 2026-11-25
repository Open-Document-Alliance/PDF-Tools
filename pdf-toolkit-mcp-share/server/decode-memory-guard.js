/**
 * Process-memory backstop for bounded decoding, shared by the local server
 * and the hosted service.
 *
 * The deterministic caps in budget.js stop decoding before any large
 * allocation. This guard is the backstop for whatever those caps do not
 * cover: it watches resident memory while work runs and stops the work (by
 * killing a subprocess or terminating a worker; the caller supplies how)
 * once memory grows past a limit.
 *
 * - Growth since the work started is limited, as well as absolute memory,
 *   because memory a stopped worker held is not always returned to the OS.
 * - After a stop, the baseline is taken again, so freed-but-mapped memory is
 *   not counted against later work.
 * - Work is refused at admission when memory is already over a limit.
 */
import {
  PDF_LIB_RSS_READY,
  PdfLibRssFrameParser,
} from "./pdf-lib-rss-monitor.js";

const MIB = 1024 * 1024;

export const MEMORY_SAMPLE_MS = 25;
export const MEMORY_GROWTH_BYTES = 900 * MIB;
export const MEMORY_CEILING_BYTES = 1500 * MIB;

/** The outcome of one bounded decode, the same for both runtimes. */
export const DECODE_OUTCOME_STATUSES = Object.freeze(["ok", "decode_limit", "memory_limit", "timeout", "failed"]);

export function decodeOutcome({ status, peakRssBytes = null, reasonCode = null }) {
  if (!DECODE_OUTCOME_STATUSES.includes(status)) throw new TypeError(`Unknown decode outcome: ${status}`);
  return { status, peak_rss_bytes: peakRssBytes, reason_code: reasonCode };
}

/** Whether rss is past the ceiling, or has grown past the limit since baseline. */
export function memoryOverLimit(rss, baseline, {
  growthBytes = MEMORY_GROWTH_BYTES,
  ceilingBytes = MEMORY_CEILING_BYTES,
} = {}) {
  return rss > ceilingBytes || rss - baseline > growthBytes;
}

/**
 * Watch the memory frames a subprocess's monitor thread writes (the frame
 * protocol of pdf-lib-rss-monitor.js). The baseline is the child's memory
 * when its monitor reported ready. onBreach is called once, when a frame is
 * over a limit or the frames cannot be trusted; the caller then stops the
 * child. peakRssBytes() reports the highest value seen.
 */
export function createSubprocessMemoryWatch({
  growthBytes = MEMORY_GROWTH_BYTES,
  ceilingBytes = MEMORY_CEILING_BYTES,
  onReady = () => {},
  onBreach,
}) {
  if (typeof onBreach !== "function") throw new TypeError("onBreach must be a function.");
  let baseline = null;
  let breach = null;
  const breached = reason => {
    if (breach !== null) return;
    breach = reason;
    onBreach(reason);
  };
  const parser = new PdfLibRssFrameParser({
    // The parser enforces the absolute ceiling itself; growth is checked here.
    maximumRssBytes: ceilingBytes,
    onFrame: ({ type, rssBytes }) => {
      if (type === PDF_LIB_RSS_READY) {
        baseline = rssBytes;
        onReady();
        return;
      }
      if (baseline !== null && memoryOverLimit(rssBytes, baseline, { growthBytes, ceilingBytes })) {
        breached("memory_limit");
      }
    },
  });
  return {
    add(chunk) {
      if (breach !== null) return;
      try {
        parser.add(chunk);
      } catch (error) {
        breached(error?.code === "PDF_LIB_RSS_LIMIT" ? "memory_limit" : "memory_monitor_failed");
      }
    },
    fail(reason = "memory_monitor_failed") {
      breached(reason);
    },
    get ready() {
      return baseline !== null;
    },
    get breach() {
      return breach;
    },
    peakRssBytes() {
      return parser.maximumObservedRss || null;
    },
  };
}
