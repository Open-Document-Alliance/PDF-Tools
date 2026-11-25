import { writeSync } from "node:fs";
import {
  Worker,
  isMainThread,
  parentPort,
  workerData,
} from "node:worker_threads";

export const PDF_LIB_RSS_FRAME_BYTES = 16;
export const PDF_LIB_RSS_MAGIC = Buffer.from("PDRS", "ascii");
export const PDF_LIB_RSS_PROTOCOL_VERSION = 1;
export const PDF_LIB_RSS_READY = 1;
export const PDF_LIB_RSS_SAMPLE = 2;
export const PDF_LIB_RSS_TERMINAL = 3;
export const PDF_LIB_RSS_SAMPLE_INTERVAL_MS = 25;

// Fixed 16-byte big-endian frame:
//   0..3 magic "PDRS"; 4 version; 5 type; 6..7 u16 sequence;
//   8..15 u64 process RSS bytes.
export function encodePdfLibRssFrame(type, sequence, rssBytes) {
  if (![PDF_LIB_RSS_READY, PDF_LIB_RSS_SAMPLE, PDF_LIB_RSS_TERMINAL].includes(type)
      || !Number.isSafeInteger(sequence) || sequence < 0 || sequence > 0xffff
      || !Number.isSafeInteger(rssBytes) || rssBytes < 0) {
    throw new TypeError("Invalid PDF RSS monitor frame.");
  }
  const frame = Buffer.allocUnsafe(PDF_LIB_RSS_FRAME_BYTES);
  PDF_LIB_RSS_MAGIC.copy(frame, 0);
  frame[4] = PDF_LIB_RSS_PROTOCOL_VERSION;
  frame[5] = type;
  frame.writeUInt16BE(sequence, 6);
  frame.writeBigUInt64BE(BigInt(rssBytes), 8);
  return frame;
}

export function writePdfLibRssFrameCompletely(
  fd,
  bytes,
  write = writeSync,
) {
  let offset = 0;
  while (offset < bytes.length) {
    try {
      const written = write(fd, bytes, offset, bytes.length - offset);
      if (written < 1) throw new Error("PDF RSS monitor write made no progress.");
      offset += written;
    } catch (error) {
      if (error?.code !== "EINTR") throw error;
    }
  }
}

export class PdfLibRssFrameParser {
  constructor({ maximumRssBytes, onReady = () => {}, onFrame = () => {} }) {
    if (!Number.isSafeInteger(maximumRssBytes) || maximumRssBytes < 1
        || typeof onReady !== "function" || typeof onFrame !== "function") {
      throw new TypeError("Invalid PDF RSS parser configuration.");
    }
    this.maximumRssBytes = maximumRssBytes;
    this.onReady = onReady;
    this.onFrame = onFrame;
    this.pending = Buffer.alloc(0);
    this.frames = 0;
    this.lastSequence = -1;
    this.ready = false;
    this.terminal = false;
    this.maximumObservedRss = 0;
  }

  add(chunk) {
    const bytes = Buffer.from(chunk);
    if (bytes.length === 0) return;
    if (bytes.length > PDF_LIB_RSS_FRAME_BYTES * 0x10000) {
      throw new Error("PDF RSS monitor chunk exceeds its frame ceiling.");
    }
    const available = this.pending.length
      ? Buffer.concat([this.pending, bytes])
      : bytes;
    let offset = 0;
    while (available.length - offset >= PDF_LIB_RSS_FRAME_BYTES) {
      const frame = available.subarray(offset, offset + PDF_LIB_RSS_FRAME_BYTES);
      this.#frame(frame);
      offset += PDF_LIB_RSS_FRAME_BYTES;
    }
    this.pending = Buffer.from(available.subarray(offset));
  }

  #frame(frame) {
    if (!frame.subarray(0, 4).equals(PDF_LIB_RSS_MAGIC)
        || frame[4] !== PDF_LIB_RSS_PROTOCOL_VERSION) {
      throw new Error("PDF RSS monitor frame header is invalid.");
    }
    const type = frame[5];
    const sequence = frame.readUInt16BE(6);
    const rssBig = frame.readBigUInt64BE(8);
    if (rssBig > BigInt(Number.MAX_SAFE_INTEGER)) {
      throw new Error("PDF RSS monitor value is not safely representable.");
    }
    const rssBytes = Number(rssBig);
    if (rssBytes === 0) {
      throw new Error("PDF RSS monitor value must be positive.");
    }
    if (this.frames >= 0x10000 || sequence !== this.lastSequence + 1) {
      throw new Error("PDF RSS monitor sequence is invalid.");
    }
    if (!this.ready) {
      if (type !== PDF_LIB_RSS_READY || sequence !== 0) {
        throw new Error("PDF RSS monitor did not begin with READY.");
      }
      this.ready = true;
    } else if (this.terminal || type === PDF_LIB_RSS_READY
        || ![PDF_LIB_RSS_SAMPLE, PDF_LIB_RSS_TERMINAL].includes(type)) {
      throw new Error("PDF RSS monitor frame type is invalid.");
    } else if (type === PDF_LIB_RSS_TERMINAL) {
      this.terminal = true;
    }
    this.frames += 1;
    this.lastSequence = sequence;
    this.maximumObservedRss = Math.max(this.maximumObservedRss, rssBytes);
    if (rssBytes > this.maximumRssBytes) {
      const error = new Error("PDF RSS monitor observed a limit breach.");
      error.code = "PDF_LIB_RSS_LIMIT";
      throw error;
    }
    this.onFrame({ type, sequence, rssBytes });
    if (type === PDF_LIB_RSS_READY) this.onReady();
  }

  finish() {
    if (this.pending.length !== 0) {
      throw new Error("PDF RSS monitor ended with a partial frame.");
    }
    if (!this.ready || !this.terminal || this.frames < 2) {
      throw new Error("PDF RSS monitor lifecycle is incomplete.");
    }
    return {
      frames: this.frames,
      lastSequence: this.lastSequence,
      maximumObservedRss: this.maximumObservedRss,
    };
  }
}

function monitorThread() {
  const fd = workerData?.fd;
  const intervalMs = workerData?.interval_ms;
  if (!Number.isSafeInteger(fd) || fd < 3
      || !Number.isSafeInteger(intervalMs) || intervalMs < 5 || intervalMs > 1000) {
    throw new TypeError("Invalid PDF RSS monitor configuration.");
  }
  let sequence = 0;
  let timer = null;
  let stopped = false;
  const write = type => {
    if (sequence > 0xffff) {
      throw new Error("PDF RSS monitor sequence exhausted.");
    }
    writePdfLibRssFrameCompletely(
      fd,
      encodePdfLibRssFrame(type, sequence, process.memoryUsage.rss()),
    );
    sequence += 1;
  };
  const sample = () => {
    if (stopped) return;
    write(PDF_LIB_RSS_SAMPLE);
    timer = setTimeout(sample, intervalMs);
    timer.unref();
  };
  write(PDF_LIB_RSS_READY);
  timer = setTimeout(sample, intervalMs);
  timer.unref();
  parentPort.once("message", () => {
    if (stopped) return;
    stopped = true;
    if (timer) clearTimeout(timer);
    write(PDF_LIB_RSS_TERMINAL);
    parentPort.postMessage(1);
    parentPort.close();
  });
}

export function startPdfLibRssMonitor({
  fd = 3,
  sampleIntervalMs = PDF_LIB_RSS_SAMPLE_INTERVAL_MS,
  WorkerClass = Worker,
} = {}) {
  if (!Number.isSafeInteger(fd) || fd < 3
      || !Number.isSafeInteger(sampleIntervalMs)
      || sampleIntervalMs < 5 || sampleIntervalMs > 1000
      || typeof WorkerClass !== "function") {
    throw new TypeError("Invalid PDF RSS monitor startup configuration.");
  }
  const worker = new WorkerClass(new URL(import.meta.url), {
    workerData: {
      pdf_tools_worker: "pdf-lib-rss-monitor",
      fd,
      interval_ms: sampleIntervalMs,
    },
  });
  let acknowledged = false;
  const completion = new Promise((resolve, reject) => {
    worker.once("message", message => {
      if (message !== 1) {
        reject(new Error("PDF RSS monitor returned an invalid acknowledgement."));
        return;
      }
      acknowledged = true;
    });
    worker.once("error", reject);
    worker.once("exit", code => {
      if (code !== 0 || !acknowledged) {
        reject(new Error("PDF RSS monitor stopped unexpectedly."));
        return;
      }
      resolve();
    });
  });
  completion.catch(() => {});
  let stopping = null;
  return {
    stop() {
      if (stopping) return stopping;
      worker.postMessage(0);
      stopping = completion;
      return stopping;
    },
  };
}

if (!isMainThread && workerData?.pdf_tools_worker === "pdf-lib-rss-monitor") {
  monitorThread();
}
