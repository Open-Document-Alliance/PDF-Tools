import { afterEach, describe, expect, it } from "vitest";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { PDFDocument } from "pdf-lib";
import {
  PDF_CONCURRENT_MODIFICATION_CODE,
  PDF_RESOURCE_LIMIT_CODE,
  createPdfLibMutationRequest,
  pdfLibStageDeviceMatches,
  runPdfLibMutation,
  selectPdfLibIsolationMode,
  terminateAllPdfLibMutations,
} from "../server/pdf-lib-subprocess.js";
import { makeDeepMalformedFixtures } from "./helpers/deep-malformed-fixtures.js";

const roots = [];
const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

describe("PDF-lib staged file identity", () => {
  it("accepts only the Windows one-missing-device descriptor shape", () => {
    expect(pdfLibStageDeviceMatches(0, 2660852064, "win32")).toBe(true);
    expect(pdfLibStageDeviceMatches(2660852064, 0, "win32")).toBe(true);
    expect(pdfLibStageDeviceMatches(4, 4, "win32")).toBe(true);
    expect(pdfLibStageDeviceMatches(4, 5, "win32")).toBe(false);
    expect(pdfLibStageDeviceMatches(0, 2660852064, "linux")).toBe(false);
  });
});

async function fixtureRoot() {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "pdflib-boundary-")));
  roots.push(root);
  const sourcePath = path.join(root, "source.pdf");
  const bytes = Buffer.from("%PDF-1.7\nfixture\n%%EOF\n");
  await fs.writeFile(sourcePath, bytes, { mode: 0o600 });
  const stats = await fs.lstat(sourcePath, { bigint: true });
  return {
    root,
    sourcePath,
    source: {
      canonical_path: sourcePath,
      file_identity: { device: String(stats.dev), inode: String(stats.ino) },
      size_bytes: bytes.length,
      sha256: createHash("sha256").update(bytes).digest("hex"),
    },
  };
}

function monitoredWorkerBody(body) {
  const monitorUrl = pathToFileURL(
    path.join(REPO_ROOT, "server", "pdf-lib-rss-monitor.js"),
  ).href;
  return `
import { startPdfLibRssMonitor } from ${JSON.stringify(monitorUrl)};
const __pdfLibRssMonitor = startPdfLibRssMonitor();
${body}
await __pdfLibRssMonitor.stop();
`;
}

async function worker(body, { monitor = true } = {}) {
  const { root, ...fixture } = await fixtureRoot();
  const workerPath = path.join(root, "worker.mjs");
  await fs.writeFile(
    workerPath,
    monitor ? monitoredWorkerBody(body) : body,
    { mode: 0o600 },
  );
  return { root, workerPath, ...fixture };
}

async function threadWorker(body) {
  const { root, ...fixture } = await fixtureRoot();
  const workerPath = path.join(root, "thread-worker.mjs");
  await fs.writeFile(workerPath, body, { mode: 0o600 });
  return { root, workerPath, ...fixture };
}

const OPTIONS = {
  fill_pdf: { field_data: {} },
  fill_with_profile: { field_data: {} },
  bulk_fill_from_csv: { records: [{}] },
  merge_pdfs: {},
  split_pdf: { page_ranges: "1" },
  rotate_pdf_pages: { pages: [], degrees: 90 },
  reorder_pdf_pages: { page_labels: "positional", page_order: [1], rotations: {} },
  apply_page_plan: { page_labels: "positional", page_order: [1], rotations: {} },
  add_signature_field: {
    allow_resign: false,
    placement: { page: 1, x: 0, y: 0, width: 10, height: 10, label: "Sign" },
  },
  apply_signature: {
    allow_resign: false,
    audit_line: "audit",
    audit_text: "audit",
    draw_audit_line: true,
    modification_at: "2026-07-29T00:00:00.000Z",
    placement: { page: 1, x: 0, y: 0, width: 10, height: 10 },
    signature: { name: "test", style: "typed", display_name: "Test", created_at: null },
  },
  prepare_signing_packet: {
    allow_resign: false,
    field_values: {},
    require_provider_ready: false,
    signature_locations: [{
      page: 1,
      x: 0,
      y: 0,
      width: 10,
      height: 10,
      label: "Sign",
      zone_id: "zone-test",
      field_type: "unspecified",
      participant_id: null,
      participant_role: null,
      evidence_source: "caller_supplied",
    }],
  },
  apply_text: {
    allow_resign: false,
    audit_line: "audit",
    font_style: "normal",
    modification_at: "2026-07-29T00:00:00.000Z",
    placement: { page: 1, x: 0, y: 0, width: 10, height: 10 },
    text: "text",
  },
};

function successWorker(extra = "") {
  return `
import { createHash } from "node:crypto";
import fs from "node:fs/promises";
const chunks = [];
for await (const chunk of process.stdin) chunks.push(chunk);
const request = JSON.parse(Buffer.concat(chunks).toString("utf8"));
const filename = "output-0001.pdf";
const outputPath = request.stage_directory + "/" + filename;
const bytes = Buffer.from("%PDF-1.7\\noutput\\n%%EOF\\n");
await fs.writeFile(outputPath, bytes, { flag: "wx", mode: 0o600 });
${extra}
const stats = await fs.lstat(outputPath, { bigint: true });
process.stdout.write(JSON.stringify({
  protocol_version: 1,
  operation: request.operation,
  status: "ok",
  manifest: [{
    filename,
    size_bytes: bytes.length,
    sha256: createHash("sha256").update(bytes).digest("hex"),
    file_identity: { device: String(stats.dev), inode: String(stats.ino) },
  }],
  result: { operation: request.operation, operation_directory: process.cwd() },
}));
`;
}

function successThreadWorker(extra = "") {
  return `
import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import { parentPort, workerData } from "node:worker_threads";
const request = workerData.request;
const filename = "output-0001.pdf";
const outputPath = request.stage_directory + "/" + filename;
const bytes = Buffer.from("%PDF-1.7\\noutput\\n%%EOF\\n");
await fs.writeFile(outputPath, bytes, { flag: "wx", mode: 0o600 });
${extra}
const stats = await fs.lstat(outputPath, { bigint: true });
parentPort.postMessage({
  kind: "response",
  response: {
    protocol_version: 1,
    operation: request.operation,
    status: "ok",
    manifest: [{
      filename,
      size_bytes: bytes.length,
      sha256: createHash("sha256").update(bytes).digest("hex"),
      file_identity: { device: String(stats.dev), inode: String(stats.ino) },
    }],
    result: { operation: request.operation },
  },
});
parentPort.close();
`;
}

async function waitForMarker(markerPath) {
  for (let attempt = 0; attempt < 50; attempt += 1) {
    try {
      await fs.access(markerPath);
      return;
    } catch {}
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  throw new Error(`Worker did not create marker: ${markerPath}`);
}

function deferred() {
  let resolve;
  const promise = new Promise(settle => { resolve = settle; });
  return { promise, resolve };
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map(root => fs.rm(root, { recursive: true, force: true })));
});

describe.sequential("pdf-lib subprocess boundary", () => {
  it("never relaunches an Electron host executable as Node", () => {
    expect(selectPdfLibIsolationMode({
      electronVersion: "39.0.0",
      processType: "utility",
      hasElectronParentPort: true,
      executable: "/Applications/Claude.app/Contents/Frameworks/Claude Helper (Plugin)",
    })).toBe("worker_thread");
    expect(selectPdfLibIsolationMode({
      electronVersion: null,
      processType: null,
      hasElectronParentPort: false,
      executable: process.execPath,
    })).toBe("subprocess");
  });

  it("uses the staged protocol without spawning in an embedded host", async () => {
    const fixture = await threadWorker(successThreadWorker());
    const result = await runPdfLibMutation({
      operation: "rotate_pdf_pages",
      sources: [fixture.source],
      password: null,
      options: OPTIONS.rotate_pdf_pages,
    }, async ({ result, outputs, atomicTransition }) => {
      expect((await outputs[0].readBytes()).subarray(0, 5).toString()).toBe("%PDF-");
      await atomicTransition("journal_prepared");
      return result.operation;
    }, {
      isolationMode: "worker_thread",
      workerPath: fixture.workerPath,
      spawnProcess() {
        throw new Error("Embedded mutation must not launch process.execPath.");
      },
    });
    expect(result).toBe("rotate_pdf_pages");
  });

  it.each([
    [
      "malformed control output",
      `import { parentPort } from "node:worker_threads";
parentPort.postMessage({ unexpected: true });
parentPort.close();`,
      "malformed_control_output",
      1_000,
    ],
    ["wall timeout", `setInterval(() => {}, 1000);`, "timeout", 150],
  ])("fails closed on worker-thread %s", async (_label, body, reason, timeoutMs) => {
    const fixture = await threadWorker(body);
    await expect(runPdfLibMutation({
      operation: "rotate_pdf_pages",
      sources: [fixture.source],
      password: null,
      options: OPTIONS.rotate_pdf_pages,
    }, async () => {
      throw new Error("must not consume");
    }, {
      isolationMode: "worker_thread",
      timeoutMs,
      workerPath: fixture.workerPath,
    })).rejects.toMatchObject({
      code: PDF_RESOURCE_LIMIT_CODE,
      reason,
    });
  });

  it("terminates a worker thread when its host RSS delta exceeds the budget", async () => {
    const fixture = await threadWorker(`setInterval(() => {}, 1000);`);
    let rssReads = 0;
    await expect(runPdfLibMutation({
      operation: "rotate_pdf_pages",
      sources: [fixture.source],
      password: null,
      options: OPTIONS.rotate_pdf_pages,
    }, async () => {
      throw new Error("must not consume");
    }, {
      isolationMode: "worker_thread",
      rssLimitCalculator: () => 1024,
      rssReader: () => {
        rssReads += 1;
        return rssReads === 1 ? 1024 : 4096;
      },
      timeoutMs: 2000,
      workerPath: fixture.workerPath,
    })).rejects.toMatchObject({
      code: PDF_RESOURCE_LIMIT_CODE,
      reason: "rss_limit_exceeded",
    });
  });

  it("executes a real pdf-lib rotation in the bounded worker thread", async () => {
    const { root } = await fixtureRoot();
    const sourcePath = path.join(root, "real-source.pdf");
    const sourceBytes = await fs.readFile(path.join(REPO_ROOT, "example-fw9.pdf"));
    await fs.writeFile(sourcePath, sourceBytes, { mode: 0o600 });
    const stats = await fs.lstat(sourcePath, { bigint: true });
    const source = {
      canonical_path: sourcePath,
      file_identity: { device: String(stats.dev), inode: String(stats.ino) },
      size_bytes: sourceBytes.length,
      sha256: createHash("sha256").update(sourceBytes).digest("hex"),
    };
    const rotations = await runPdfLibMutation({
      operation: "rotate_pdf_pages",
      sources: [source],
      password: null,
      options: { pages: [1], degrees: 90 },
    }, async ({ outputs, atomicTransition }) => {
      const output = await PDFDocument.load(await outputs[0].readBytes());
      const values = output.getPages().map(page => page.getRotation().angle);
      await atomicTransition("journal_prepared");
      return values;
    }, { isolationMode: "worker_thread" });
    expect(rotations[0]).toBe(90);
  });

  it("admits only one embedded mutation worker at a time", async () => {
    const first = await threadWorker(`setInterval(() => {}, 1000);`);
    const second = await threadWorker(successThreadWorker());
    const firstCall = runPdfLibMutation({
      operation: "rotate_pdf_pages",
      sources: [first.source],
      password: null,
      options: OPTIONS.rotate_pdf_pages,
    }, async () => {
      throw new Error("must not consume");
    }, {
      isolationMode: "worker_thread",
      timeoutMs: 250,
      workerPath: first.workerPath,
    });
    await expect(runPdfLibMutation({
      operation: "rotate_pdf_pages",
      sources: [second.source],
      password: null,
      options: OPTIONS.rotate_pdf_pages,
    }, async () => {
      throw new Error("must not consume");
    }, {
      isolationMode: "worker_thread",
      workerPath: second.workerPath,
    })).rejects.toMatchObject({
      code: PDF_RESOURCE_LIMIT_CODE,
      reason: "mutation_concurrency_limit",
    });
    await firstCall.catch(() => {});
  });

  it("tracks and terminates an embedded mutation through shutdown", async () => {
    const fixture = await threadWorker("");
    const marker = `${fixture.workerPath}.ready`;
    await fs.writeFile(fixture.workerPath, `
import fs from "node:fs/promises";
await fs.writeFile(${JSON.stringify(marker)}, "ready");
setInterval(() => {}, 1000);
`, { mode: 0o600 });
    const pending = runPdfLibMutation({
      operation: "rotate_pdf_pages",
      sources: [fixture.source],
      password: null,
      options: OPTIONS.rotate_pdf_pages,
    }, async () => {
      throw new Error("must not consume");
    }, {
      isolationMode: "worker_thread",
      timeoutMs: 5000,
      workerPath: fixture.workerPath,
    });
    await waitForMarker(marker);
    await terminateAllPdfLibMutations();
    await expect(pending).rejects.toMatchObject({ code: PDF_RESOURCE_LIMIT_CODE });
  });

  it.each(Object.entries(OPTIONS))(
    "uses the strict staged protocol for %s",
    async (operation, options) => {
      const fixture = await worker(successWorker());
      const result = await runPdfLibMutation({
        operation,
        sources: operation === "merge_pdfs" ? [fixture.source, fixture.source] : [fixture.source],
        password: null,
        options,
      }, async ({ result, outputs, atomicTransition }) => {
        expect(outputs).toHaveLength(1);
        expect((await outputs[0].readBytes()).subarray(0, 5).toString()).toBe("%PDF-");
        await atomicTransition("journal_prepared");
        return result.operation;
      }, { workerPath: fixture.workerPath });
      expect(result).toBe(operation);
    },
  );

  it("rejects options with undeclared keys before spawning", () => {
    expect(() => createPdfLibMutationRequest({
      operation: "rotate_pdf_pages",
      sources: [{
        canonical_path: path.join(os.tmpdir(), "source.pdf"),
        file_identity: { device: "1", inode: "2" },
        size_bytes: 1,
        sha256: "a".repeat(64),
      }],
      password: null,
      options: { pages: [], degrees: 90, fallback: true },
    })).toThrow(/invalid shape/);
  });

  it.each([
    ["malformed control output", `process.stdout.write("{");`, "malformed_control_output"],
    [
      "wall timeout",
      `process.on("SIGTERM", () => {}); await new Promise(() => {});`,
      "timeout",
    ],
  ])("fails closed on %s", async (_label, statement, reason) => {
    const fixture = await worker(`
for await (const _chunk of process.stdin) {}
${statement}
`);
    await expect(runPdfLibMutation({
      operation: "rotate_pdf_pages",
      sources: [fixture.source],
      password: null,
      options: OPTIONS.rotate_pdf_pages,
    }, async () => {
      throw new Error("must not consume");
    // Leave enough headroom for the separately supervised RSS monitor to
    // become ready on supported Intel Macs. This test is for the worker's
    // post-activation failure, not for monitor-startup timeout behavior.
    }, { timeoutMs: 1000, workerPath: fixture.workerPath })).rejects.toMatchObject({
      code: PDF_RESOURCE_LIMIT_CODE,
      reason,
    });
  });

  it.each([
    ["protocol version", 2, "rotate_pdf_pages"],
    ["operation", 1, "split_pdf"],
  ])("rejects an error frame with a mismatched %s", async (_label, protocolVersion, operation) => {
    const fixture = await worker(`
for await (const _chunk of process.stdin) {}
process.stdout.write(JSON.stringify({
  protocol_version: ${protocolVersion},
  operation: ${JSON.stringify(operation)},
  status: "error",
  error: { name: "Error", code: null, message: "untrusted", reason: null },
}));
process.exitCode = 1;
`);
    await expect(runPdfLibMutation({
      operation: "rotate_pdf_pages",
      sources: [fixture.source],
      password: null,
      options: OPTIONS.rotate_pdf_pages,
    }, async () => {
      throw new Error("must not consume");
    }, { workerPath: fixture.workerPath })).rejects.toMatchObject({
      code: PDF_RESOURCE_LIMIT_CODE,
      reason: "mismatched_control_output",
    });
  });

  it("escalates an overflowing worker one grace interval after overflow", async () => {
    const fixture = await worker(`
for await (const _chunk of process.stdin) {}
process.on("SIGTERM", () => {});
process.stdout.write("x".repeat(1024 * 1024 + 1));
setInterval(() => {}, 1000);
`);
    const startedAt = Date.now();
    await expect(runPdfLibMutation({
      operation: "rotate_pdf_pages",
      sources: [fixture.source],
      password: null,
      options: OPTIONS.rotate_pdf_pages,
    }, async () => {
      throw new Error("must not consume");
    }, { timeoutMs: 5000, workerPath: fixture.workerPath })).rejects.toMatchObject({
      code: PDF_RESOURCE_LIMIT_CODE,
      reason: "stdout_overflow",
    });
    expect(Date.now() - startedAt).toBeLessThan(2500);
  });

  it.each([
    ["worker signal", "process.kill(process.pid, \"SIGKILL\");", /rss_monitor_premature_end/],
    ["V8-style nonzero exit", "process.exit(134);", /rss_monitor_premature_end/],
  ])("fails closed on %s", async (_label, statement, reason) => {
    const fixture = await worker(`
for await (const _chunk of process.stdin) {}
${statement}
`);
    await expect(runPdfLibMutation({
      operation: "rotate_pdf_pages",
      sources: [fixture.source],
      password: null,
      options: OPTIONS.rotate_pdf_pages,
    }, async () => {
      throw new Error("must not consume");
    }, { workerPath: fixture.workerPath })).rejects.toMatchObject({
      code: PDF_RESOURCE_LIMIT_CODE,
      reason: expect.stringMatching(reason),
    });
  });

  it("rejects an incomplete manifest with a missing staged output", async () => {
    const fixture = await worker(`
for await (const chunk of process.stdin) {}
process.stdout.write(JSON.stringify({
  protocol_version: 1,
  operation: "rotate_pdf_pages",
  status: "ok",
  manifest: [{
    filename: "output-0001.pdf",
    size_bytes: 20,
    sha256: "${"a".repeat(64)}",
    file_identity: { device: "1", inode: "2" },
  }],
  result: {},
}));
`);
    await expect(runPdfLibMutation({
      operation: "rotate_pdf_pages",
      sources: [fixture.source],
      password: null,
      options: OPTIONS.rotate_pdf_pages,
    }, async () => {
      throw new Error("must not consume");
    }, { workerPath: fixture.workerPath })).rejects.toMatchObject({
      code: PDF_RESOURCE_LIMIT_CODE,
      reason: "incomplete_or_extra_stage",
    });
  });

  it.runIf(process.platform !== "win32")(
    "rejects a staged symlink before hashing or consumption",
    async () => {
      const fixture = await worker(successWorker(`
const outside = request.stage_directory + ".outside.pdf";
await fs.rename(outputPath, outside);
await fs.symlink(outside, outputPath);
`));
      await expect(runPdfLibMutation({
        operation: "rotate_pdf_pages",
        sources: [fixture.source],
        password: null,
        options: OPTIONS.rotate_pdf_pages,
      }, async () => {
        throw new Error("must not consume");
      }, { workerPath: fixture.workerPath })).rejects.toMatchObject({
        code: PDF_RESOURCE_LIMIT_CODE,
        reason: "unsafe_or_changed_stage",
      });
    },
  );

  it.runIf(process.platform !== "win32")(
    "rejects a staged FIFO before hashing or consumption",
    async () => {
      const fixture = await worker(`
import { spawnSync } from "node:child_process";
import fs from "node:fs/promises";
const chunks = [];
for await (const chunk of process.stdin) chunks.push(chunk);
const request = JSON.parse(Buffer.concat(chunks).toString("utf8"));
const filename = "output-0001.pdf";
const outputPath = request.stage_directory + "/" + filename;
const created = spawnSync("mkfifo", [outputPath]);
if (created.status !== 0) throw new Error("mkfifo failed");
const stats = await fs.lstat(outputPath, { bigint: true });
process.stdout.write(JSON.stringify({
  protocol_version: 1,
  operation: request.operation,
  status: "ok",
  manifest: [{
    filename,
    size_bytes: 1,
    sha256: "${"a".repeat(64)}",
    file_identity: { device: String(stats.dev), inode: String(stats.ino) },
  }],
  result: {},
}));
`);
      await expect(runPdfLibMutation({
        operation: "rotate_pdf_pages",
        sources: [fixture.source],
        password: null,
        options: OPTIONS.rotate_pdf_pages,
      }, async () => {
        throw new Error("must not consume");
      }, { workerPath: fixture.workerPath })).rejects.toMatchObject({
        code: PDF_RESOURCE_LIMIT_CODE,
        reason: "unsafe_or_changed_stage",
      });
    },
  );

  it("does not retry a failed worker", async () => {
    const fixture = await worker(`
for await (const _chunk of process.stdin) {}
process.stdout.write("{");
`);
    let spawnCount = 0;
    await expect(runPdfLibMutation({
      operation: "rotate_pdf_pages",
      sources: [fixture.source],
      password: null,
      options: OPTIONS.rotate_pdf_pages,
    }, async () => {
      throw new Error("must not consume");
    }, {
      workerPath: fixture.workerPath,
      spawnProcess(...args) {
        spawnCount += 1;
        return spawn(...args);
      },
    })).rejects.toMatchObject({ code: PDF_RESOURCE_LIMIT_CODE });
    expect(spawnCount).toBe(1);
  });

  it("reports a high monitor sample before parsing an already-written worker error", async () => {
    const monitorUrl = pathToFileURL(
      path.join(REPO_ROOT, "server", "pdf-lib-rss-monitor.js"),
    ).href;
    const fixture = await worker(`
import { writeSync } from "node:fs";
import {
  PDF_LIB_RSS_READY,
  PDF_LIB_RSS_SAMPLE,
  encodePdfLibRssFrame,
} from ${JSON.stringify(monitorUrl)};
writeSync(3, encodePdfLibRssFrame(PDF_LIB_RSS_READY, 0, 100));
for await (const _chunk of process.stdin) {}
process.stdout.write(JSON.stringify({
  protocol_version: 1,
  operation: "rotate_pdf_pages",
  status: "error",
  error: { name: "Error", code: null, message: "must lose", reason: null },
}));
writeSync(3, encodePdfLibRssFrame(
  PDF_LIB_RSS_SAMPLE,
  1,
  513 * 1024 * 1024,
));
process.on("SIGTERM", () => {});
setInterval(() => {}, 1000);
`, { monitor: false });
    let consumed = false;
    const signals = [];
    await expect(runPdfLibMutation({
      operation: "rotate_pdf_pages",
      sources: [fixture.source],
      password: null,
      options: OPTIONS.rotate_pdf_pages,
    }, async () => { consumed = true; }, {
      workerPath: fixture.workerPath,
      spawnProcess(...args) {
        const child = spawn(...args);
        const kill = child.kill.bind(child);
        child.kill = signal => {
          signals.push(signal);
          return kill(signal);
        };
        return child;
      },
    })).rejects.toMatchObject({
      code: PDF_RESOURCE_LIMIT_CODE,
      reason: "rss_limit_exceeded",
    });
    expect(consumed).toBe(false);
    expect(signals).toEqual(["SIGKILL"]);
  });

  it("hard-kills a synchronously blocked external-buffer worker after a high sample", async () => {
    const fixture = await worker(`
for await (const _chunk of process.stdin) {}
process.on("SIGTERM", () => {});
const retained = [];
for (;;) retained.push(Buffer.alloc(8 * 1024 * 1024, 0x5a));
`);
    const signals = [];
    const startedAt = Date.now();
    await expect(runPdfLibMutation({
      operation: "rotate_pdf_pages",
      sources: [fixture.source],
      password: null,
      options: OPTIONS.rotate_pdf_pages,
    }, async () => {
      throw new Error("must not consume");
    }, {
      workerPath: fixture.workerPath,
      rssLimitCalculator: () => 160 * 1024 * 1024,
      spawnProcess(...args) {
        const child = spawn(...args);
        const kill = child.kill.bind(child);
        child.kill = signal => {
          signals.push(signal);
          return kill(signal);
        };
        return child;
      },
    })).rejects.toMatchObject({
      code: PDF_RESOURCE_LIMIT_CODE,
      reason: "rss_limit_exceeded",
    });
    expect(signals).toEqual(["SIGKILL"]);
    expect(Date.now() - startedAt).toBeLessThan(750);
  });

  it("rejects a terminal frame before activation without sending stdin", async () => {
    const monitorUrl = pathToFileURL(
      path.join(REPO_ROOT, "server", "pdf-lib-rss-monitor.js"),
    ).href;
    const marker = path.join(os.tmpdir(), `pdflib-stdin-${process.pid}-${Date.now()}`);
    roots.push(marker);
    const fixture = await worker(`
import { writeSync } from "node:fs";
import fs from "node:fs/promises";
import {
  PDF_LIB_RSS_READY,
  PDF_LIB_RSS_TERMINAL,
  encodePdfLibRssFrame,
} from ${JSON.stringify(monitorUrl)};
process.stdin.once("data", async () => {
  await fs.writeFile(${JSON.stringify(marker)}, "unexpected");
});
writeSync(3, Buffer.concat([
  encodePdfLibRssFrame(PDF_LIB_RSS_READY, 0, 100),
  encodePdfLibRssFrame(PDF_LIB_RSS_TERMINAL, 1, 100),
]));
setInterval(() => {}, 1000);
`, { monitor: false });
    await expect(runPdfLibMutation({
      operation: "rotate_pdf_pages",
      sources: [fixture.source],
      password: null,
      options: OPTIONS.rotate_pdf_pages,
    }, async () => {
      throw new Error("must not consume");
    }, { workerPath: fixture.workerPath })).rejects.toMatchObject({
      code: PDF_RESOURCE_LIMIT_CODE,
      reason: "rss_monitor_terminal_before_activation",
    });
    await expect(fs.access(marker)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("fails promptly when fd3 ends before a terminal frame", async () => {
    const monitorUrl = pathToFileURL(
      path.join(REPO_ROOT, "server", "pdf-lib-rss-monitor.js"),
    ).href;
    const fixture = await worker(`
import { closeSync, writeSync } from "node:fs";
import {
  PDF_LIB_RSS_READY,
  encodePdfLibRssFrame,
} from ${JSON.stringify(monitorUrl)};
writeSync(3, encodePdfLibRssFrame(PDF_LIB_RSS_READY, 0, 100));
closeSync(3);
for await (const _chunk of process.stdin) {}
setInterval(() => {}, 1000);
`, { monitor: false });
    await expect(runPdfLibMutation({
      operation: "rotate_pdf_pages",
      sources: [fixture.source],
      password: null,
      options: OPTIONS.rotate_pdf_pages,
    }, async () => {
      throw new Error("must not consume");
    }, { timeoutMs: 5000, workerPath: fixture.workerPath })).rejects.toMatchObject({
      code: PDF_RESOURCE_LIMIT_CODE,
      reason: "rss_monitor_premature_end",
    });
  });

  it("bounds an activated child that emits an early terminal frame and hangs", async () => {
    const monitorUrl = pathToFileURL(
      path.join(REPO_ROOT, "server", "pdf-lib-rss-monitor.js"),
    ).href;
    const fixture = await worker(`
import { writeSync } from "node:fs";
import {
  PDF_LIB_RSS_READY,
  PDF_LIB_RSS_TERMINAL,
  encodePdfLibRssFrame,
} from ${JSON.stringify(monitorUrl)};
writeSync(3, encodePdfLibRssFrame(PDF_LIB_RSS_READY, 0, 100));
for await (const _chunk of process.stdin) {}
writeSync(3, encodePdfLibRssFrame(PDF_LIB_RSS_TERMINAL, 1, 100));
process.on("SIGTERM", () => {});
setInterval(() => {}, 1000);
`, { monitor: false });
    const startedAt = Date.now();
    await expect(runPdfLibMutation({
      operation: "rotate_pdf_pages",
      sources: [fixture.source],
      password: null,
      options: OPTIONS.rotate_pdf_pages,
    }, async () => {
      throw new Error("must not consume");
    }, { timeoutMs: 5000, workerPath: fixture.workerPath })).rejects.toMatchObject({
      code: PDF_RESOURCE_LIMIT_CODE,
      reason: "rss_monitor_terminal_child_stall",
    });
    expect(Date.now() - startedAt).toBeLessThan(2500);
  });

  it("removes the parent-created operation directory before returning", async () => {
    const fixture = await worker(successWorker());
    const operationDirectory = await runPdfLibMutation({
      operation: "rotate_pdf_pages",
      sources: [fixture.source],
      password: null,
      options: OPTIONS.rotate_pdf_pages,
    }, async ({ result, outputs, atomicTransition }) => {
      await outputs[0].readBytes();
      await atomicTransition("journal_prepared");
      return result.operation_directory;
    }, { workerPath: fixture.workerPath });
    expect(path.basename(operationDirectory)).toMatch(/^pdf-tools-pdflib-/);
    await expect(fs.access(operationDirectory)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("admits no more than two active mutations", async () => {
    const first = await worker("");
    const second = await worker("");
    for (const fixture of [first, second]) {
      const marker = `${fixture.workerPath}.ready`;
      await fs.writeFile(fixture.workerPath, monitoredWorkerBody(`
import fs from "node:fs/promises";
for await (const _chunk of process.stdin) {}
await fs.writeFile(${JSON.stringify(marker)}, "ready");
setInterval(() => {}, 1000);
`), { mode: 0o600 });
    }
    const third = await worker(successWorker());
    const invoke = fixture => runPdfLibMutation({
      operation: "rotate_pdf_pages",
      sources: [fixture.source],
      password: null,
      options: OPTIONS.rotate_pdf_pages,
    }, async () => {}, { timeoutMs: 500, workerPath: fixture.workerPath });
    const [firstCall, secondCall, thirdCall] = [first, second, third].map(invoke);
    await expect(thirdCall).rejects.toMatchObject({
      code: PDF_RESOURCE_LIMIT_CODE,
      reason: "mutation_concurrency_limit",
    });
    await Promise.all([waitForMarker(`${first.workerPath}.ready`), waitForMarker(`${second.workerPath}.ready`)]);
    await Promise.all([firstCall, secondCall].map(operation => operation.catch(() => {})));
  });

  it("rejects a same-bytes path ABA before consuming staged output", async () => {
    const fixture = await worker(successWorker());
    await expect(runPdfLibMutation({
      operation: "rotate_pdf_pages",
      sources: [fixture.source],
      password: null,
      options: OPTIONS.rotate_pdf_pages,
    }, async ({ outputs }) => {
      const originalPath = outputs[0].path;
      const displacedPath = `${originalPath}.displaced`;
      await fs.rename(originalPath, displacedPath);
      await fs.copyFile(displacedPath, originalPath);
      await outputs[0].readBytes();
    }, { workerPath: fixture.workerPath })).rejects.toMatchObject({
      code: PDF_RESOURCE_LIMIT_CODE,
      reason: "stage_changed_before_read",
    });
  });

  it("terminates an active mutation through the shutdown path", async () => {
    const fixture = await worker("");
    const marker = `${fixture.workerPath}.ready`;
    await fs.writeFile(fixture.workerPath, monitoredWorkerBody(`
import fs from "node:fs/promises";
for await (const _chunk of process.stdin) {}
await fs.writeFile(${JSON.stringify(marker)}, "ready");
setInterval(() => {}, 1000);
`), { mode: 0o600 });
    const pending = runPdfLibMutation({
      operation: "rotate_pdf_pages",
      sources: [fixture.source],
      password: null,
      options: OPTIONS.rotate_pdf_pages,
    }, async () => {
      throw new Error("must not consume");
    }, { timeoutMs: 5000, workerPath: fixture.workerPath });
    await waitForMarker(marker);
    await terminateAllPdfLibMutations();
    await expect(pending).rejects.toMatchObject({ code: PDF_RESOURCE_LIMIT_CODE });
  });

  it("does not finish shutdown until post-worker consume, cleanup, and reservation release settle", async () => {
    const fixture = await worker(successWorker());
    const consumeStarted = deferred();
    const releaseConsume = deferred();
    let operationDirectory;
    const pending = runPdfLibMutation({
      operation: "rotate_pdf_pages",
      sources: [fixture.source],
      password: null,
      options: OPTIONS.rotate_pdf_pages,
    }, async ({ result, outputs, atomicTransition }) => {
      operationDirectory = result.operation_directory;
      await outputs[0].readBytes();
      consumeStarted.resolve();
      await releaseConsume.promise;
      await atomicTransition("journal_prepared");
      return "consumed";
    }, { workerPath: fixture.workerPath });

    await consumeStarted.promise;
    await expect(fs.access(operationDirectory)).resolves.toBeUndefined();
    let shutdownSettled = false;
    const shutdown = terminateAllPdfLibMutations().then(() => { shutdownSettled = true; });
    await new Promise(resolve => setImmediate(resolve));
    expect(shutdownSettled).toBe(false);

    await expect(runPdfLibMutation({
      operation: "rotate_pdf_pages",
      sources: [fixture.source],
      password: null,
      options: OPTIONS.rotate_pdf_pages,
    }, async () => {}, { workerPath: fixture.workerPath })).rejects.toMatchObject({
      code: PDF_RESOURCE_LIMIT_CODE,
      reason: "mutation_shutdown_in_progress",
    });

    releaseConsume.resolve();
    await shutdown;
    expect(shutdownSettled).toBe(true);
    await expect(fs.access(operationDirectory)).rejects.toMatchObject({ code: "ENOENT" });

    const reusable = await worker(successWorker());
    await expect(runPdfLibMutation({
      operation: "rotate_pdf_pages",
      sources: [reusable.source],
      password: null,
      options: OPTIONS.rotate_pdf_pages,
    }, async ({ atomicTransition }) => {
      await atomicTransition("journal_prepared");
      return "reused";
    }, { workerPath: reusable.workerPath })).resolves.toBe("reused");
    expect(await pending).toBe("consumed");
  });

  it("drains an admitted pre-spawn operation without creating a late worker", async () => {
    const fixture = await worker(successWorker());
    const beforeSpawnReached = deferred();
    const releaseBeforeSpawn = deferred();
    let spawned = false;
    const pending = runPdfLibMutation({
      operation: "rotate_pdf_pages",
      sources: [fixture.source],
      password: null,
      options: OPTIONS.rotate_pdf_pages,
    }, async () => {
      throw new Error("must not consume");
    }, {
      workerPath: fixture.workerPath,
      beforeSpawn: async () => {
        beforeSpawnReached.resolve();
        await releaseBeforeSpawn.promise;
      },
      spawnProcess: (...args) => {
        spawned = true;
        return spawn(...args);
      },
    });

    await beforeSpawnReached.promise;
    let shutdownSettled = false;
    const shutdown = terminateAllPdfLibMutations().then(() => { shutdownSettled = true; });
    await new Promise(resolve => setImmediate(resolve));
    expect(shutdownSettled).toBe(false);

    releaseBeforeSpawn.resolve();
    await shutdown;
    expect(shutdownSettled).toBe(true);
    expect(spawned).toBe(false);
    await expect(pending).rejects.toMatchObject({
      code: PDF_RESOURCE_LIMIT_CODE,
      reason: "mutation_shutdown_in_progress",
    });
  });

  it("rejects an extra staged file and removes the private operation directory", async () => {
    const fixture = await worker(successWorker(`
await fs.writeFile(request.stage_directory + "/extra.pdf", bytes, { mode: 0o600 });
`));
    let consumed = false;
    await expect(runPdfLibMutation({
      operation: "rotate_pdf_pages",
      sources: [fixture.source],
      password: null,
      options: OPTIONS.rotate_pdf_pages,
    }, async () => { consumed = true; }, { workerPath: fixture.workerPath })).rejects.toMatchObject({
      code: PDF_RESOURCE_LIMIT_CODE,
      reason: "incomplete_or_extra_stage",
    });
    expect(consumed).toBe(false);
  });

  it("revalidates source identity immediately before activation", async () => {
    const fixture = await worker(successWorker());
    await expect(runPdfLibMutation({
      operation: "rotate_pdf_pages",
      sources: [fixture.source],
      password: null,
      options: OPTIONS.rotate_pdf_pages,
    }, async ({ outputs, atomicTransition }) => {
      await outputs[0].readBytes();
      await fs.writeFile(fixture.sourcePath, "%PDF-1.7\nchanged\n%%EOF\n");
      await atomicTransition("journal_prepared");
    }, { workerPath: fixture.workerPath })).rejects.toMatchObject({
      // Source drift is a concurrent modification, not a resource condition.
      // The refusal is identical whichever layer makes it, so this must not
      // drift back to PDF_RESOURCE_LIMIT_CODE: that told the caller to try a
      // smaller PDF, and it made save-lifecycle's concurrency assertion depend
      // on which detector machine load let win.
      code: PDF_CONCURRENT_MODIFICATION_CODE,
      reason: "source_drift_before_activation",
    });
  });

  it("rejects a staged symlink or hardlink before any consumer runs", async () => {
    const fixture = await worker(successWorker(`
const replacement = request.stage_directory + "/replacement.pdf";
await fs.writeFile(replacement, bytes, { mode: 0o600 });
await fs.rm(outputPath);
await fs.link(replacement, outputPath);
`));
    await expect(runPdfLibMutation({
      operation: "rotate_pdf_pages",
      sources: [fixture.source],
      password: null,
      options: OPTIONS.rotate_pdf_pages,
    }, async () => {
      throw new Error("must not consume");
    }, { workerPath: fixture.workerPath })).rejects.toMatchObject({
      code: PDF_RESOURCE_LIMIT_CODE,
    });
  });

  it("keeps the same MCP server responsive after an isolated resource failure", async () => {
    const { root } = await fixtureRoot();
    const fixture = makeDeepMalformedFixtures({ scale: "quick" })
      .find(item => item.name === "sparse-high-object-numbers");
    const malformedPath = path.join(root, "sparse.pdf");
    const outputPath = path.join(root, "must-not-exist.pdf");
    await fs.writeFile(malformedPath, fixture.bytes, { mode: 0o600 });
    const transport = new StdioClientTransport({
      command: process.execPath,
      args: [path.join(REPO_ROOT, "server", "index.js")],
      cwd: REPO_ROOT,
      env: {
        ALLOWED_DIRECTORIES: root,
        DEFAULT_PDF_DIR: root,
        DEFAULT_DOWNLOAD_DIR: root,
        DEFAULT_PROFILES_DIR: path.join(root, "profiles"),
      },
      stderr: "ignore",
    });
    const client = new Client({ name: "pdflib-same-server-canary", version: "1.0.0" });
    try {
      await client.connect(transport);
      const failed = await client.callTool({
        name: "rotate_pdf_pages",
        arguments: {
          input_path: malformedPath,
          output_path: outputPath,
          degrees: 90,
        },
      });
      expect(failed.isError).toBe(true);
      expect(failed.structuredContent.error.code).toBe(PDF_RESOURCE_LIMIT_CODE);
      await expect(fs.access(outputPath)).rejects.toMatchObject({ code: "ENOENT" });
      const tools = await client.listTools();
      expect(tools.tools.some(tool => tool.name === "rotate_pdf_pages")).toBe(true);
    } finally {
      await client.close().catch(() => {});
      await transport.close().catch(() => {});
    }
  });
});
