import { afterEach, describe, expect, it } from "vitest";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, promises as fs, writeFileSync } from "node:fs";
import { EventEmitter } from "node:events";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { PDFDocument, StandardFonts } from "pdf-lib";
import {
  PDF_RESOURCE_LIMIT_CODE,
  createPdfjsSubprocessRequest,
  runPdfjsSubprocess,
  selectPdfjsIsolationMode,
  settleAllShutdownOperations,
  terminateAllPdfjsSubprocesses,
} from "../server/pdfjs-subprocess.js";

const roots = [];

async function fixtureWorker(body) {
  const root = await fs.realpath(
    await fs.mkdtemp(path.join(os.tmpdir(), "pdfjs-boundary-test-")),
  );
  roots.push(root);
  const workerPath = path.join(root, "worker.mjs");
  await fs.writeFile(workerPath, body, { mode: 0o600 });
  return workerPath;
}

async function nestedSystemWorker() {
  const root = await fs.realpath(
    await fs.mkdtemp(path.join(os.tmpdir(), "pdfjs-nested-renderer-test-")),
  );
  roots.push(root);
  const rendererPath = path.join(root, "renderer.mjs");
  const rendererInfoPath = path.join(root, "renderer.json");
  await fs.writeFile(rendererPath, `
import fs from "node:fs";
process.on("SIGTERM", () => {});
fs.writeFileSync(process.argv[2], JSON.stringify({
  pid: process.pid,
  cwd: process.cwd(),
}));
setInterval(() => {}, 1000);
`, { mode: 0o600 });
  const moduleUrl = pathToFileURL(
    path.resolve("server/pdfjs-worker.js"),
  ).href;
  const workerPath = await fixtureWorker(`
import {
  installSystemChildTerminationHandlers,
  runSystemCommand,
} from ${JSON.stringify(moduleUrl)};
installSystemChildTerminationHandlers();
await runSystemCommand(process.execPath, [
  ${JSON.stringify(rendererPath)},
  ${JSON.stringify(rendererInfoPath)},
], { timeoutMs: 30000 });
`);
  return { rendererInfoPath, workerPath };
}

async function waitForFile(filename, timeoutMs = 5000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    try {
      return await fs.readFile(filename, "utf8");
    } catch (error) {
      if (error?.code !== "ENOENT" || Date.now() >= deadline) throw error;
      await new Promise(resolve => setTimeout(resolve, 20));
    }
  }
}

async function settlementBeforeDelay(promise, delayMs = 100) {
  let timer;
  try {
    return await Promise.race([
      promise.then(
        () => "settled",
        () => "settled",
      ),
      new Promise(resolve => {
        timer = setTimeout(() => resolve("pending"), delayMs);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

async function runNodeFixture(body, args = []) {
  const workerPath = await fixtureWorker(body);
  return await new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [workerPath, ...args], {
      cwd: process.cwd(),
      env: process.env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    const stdout = [];
    const stderr = [];
    child.stdout.on("data", chunk => stdout.push(chunk));
    child.stderr.on("data", chunk => stderr.push(chunk));
    child.once("error", reject);
    child.once("close", (code, signal) => resolve({
      code,
      signal,
      stderr: Buffer.concat(stderr).toString("utf8"),
      stdout: Buffer.concat(stdout).toString("utf8"),
    }));
  });
}

function request(operation = "read_content", options = { max_pages: null }) {
  return createPdfjsSubprocessRequest({
    operation,
    source: {
      canonical_path: path.join(os.tmpdir(), "source.pdf"),
      file_identity: { device: "1", inode: "2" },
      sha256: "a".repeat(64),
      size_bytes: 1,
    },
    password: null,
    options,
    allowedDirectories: [os.tmpdir()],
  });
}

function success(result = { value: "ok" }, binary = null) {
  return JSON.stringify({
    status: "ok",
    protocol_version: 1,
    operation: "read_content",
    result,
    binary,
  });
}

async function createThreadPdfRequest({
  operation = "read_content",
  options = { max_pages: null },
} = {}) {
  const root = await fs.realpath(
    await fs.mkdtemp(path.join(os.tmpdir(), "pdfjs-thread-test-")),
  );
  roots.push(root);
  const filename = path.join(root, "source.pdf");
  const document = await PDFDocument.create();
  const font = await document.embedFont(StandardFonts.Helvetica);
  const page = document.addPage([300, 200]);
  page.drawText("Thread host conversion", { x: 24, y: 120, size: 14, font });
  const bytes = Buffer.from(await document.save({ useObjectStreams: false }));
  await fs.writeFile(filename, bytes, { mode: 0o600 });
  const stats = await fs.stat(filename, { bigint: true });
  return createPdfjsSubprocessRequest({
    operation,
    source: {
      canonical_path: filename,
      file_identity: {
        device: String(stats.dev),
        inode: String(stats.ino),
      },
      sha256: createHash("sha256").update(bytes).digest("hex"),
      size_bytes: bytes.length,
    },
    password: null,
    options,
    allowedDirectories: [root],
  });
}

afterEach(async () => {
  await Promise.all(
    roots.splice(0).map(root => fs.rm(root, { force: true, recursive: true })),
  );
});

describe.sequential("PDF.js subprocess boundary", () => {
  it("never relaunches an Electron host executable as Node", () => {
    expect(selectPdfjsIsolationMode({
      electronVersion: "39.0.0",
      processType: "utility",
      hasElectronParentPort: true,
      executable: "/Applications/Claude.app/Contents/MacOS/Claude",
    })).toBe("in_process");
    expect(selectPdfjsIsolationMode({
      electronVersion: "39.0.0",
      processType: "browser",
      hasElectronParentPort: false,
      executable: "/Applications/Claude.app/Contents/MacOS/Claude",
    })).toBe("in_process");
    expect(selectPdfjsIsolationMode({
      electronVersion: null,
      processType: null,
      hasElectronParentPort: true,
      executable: "/Applications/Claude.app/Contents/Frameworks/Claude Helper (Plugin)",
    })).toBe("in_process");
    expect(selectPdfjsIsolationMode({
      electronVersion: null,
      processType: null,
      hasElectronParentPort: false,
      executable: "/Applications/Claude.app/Contents/Frameworks/Claude Helper (Plugin)",
    })).toBe("in_process");
    expect(selectPdfjsIsolationMode({
      electronVersion: null,
      processType: null,
      hasElectronParentPort: false,
      executable: "/Applications/Claude.app/Contents/MacOS/Claude",
    })).toBe("in_process");
    expect(selectPdfjsIsolationMode({
      electronVersion: null,
      processType: null,
      hasElectronParentPort: false,
      executable: "/Applications/Example.app/Contents/Resources/node",
    })).toBe("subprocess");
    expect(selectPdfjsIsolationMode({
      electronVersion: null,
      processType: null,
      hasElectronParentPort: false,
      executable: process.execPath,
    })).toBe("subprocess");
  });

  it("keeps PDF.js in process while PDF-lib keeps a worker boundary on the same host", async () => {
    const { selectPdfLibIsolationMode } = await import("../server/pdf-lib-subprocess.js");
    // One embedded Electron host, described identically to both selectors.
    const embeddedHost = {
      electronVersion: "34.0.0",
      processType: "utility",
      hasElectronParentPort: true,
      executable: "/Applications/Claude.app/Contents/MacOS/Claude Helper (Plugin)",
    };
    // The asymmetry is deliberate and evidenced, not an oversight. PDF.js
    // crashed this host in both isolated modes, while PDF-lib has completed
    // live rotate, merge, and split mutations here through a worker thread.
    // Harmonizing these two would either crash the host or silently drop a
    // proven boundary, so both directions are pinned.
    expect(selectPdfjsIsolationMode(embeddedHost)).toBe("in_process");
    expect(selectPdfLibIsolationMode(embeddedHost)).toBe("worker_thread");

    const ordinaryNodeHost = {
      electronVersion: null,
      processType: null,
      hasElectronParentPort: false,
      executable: "/usr/local/bin/node",
    };
    expect(selectPdfjsIsolationMode(ordinaryNodeHost)).toBe("subprocess");
    expect(selectPdfLibIsolationMode(ordinaryNodeHost)).toBe("subprocess");
  });

  it("runs a source-bound request without spawning or threading in an embedded host", async () => {
    const failIfUsed = () => {
      throw new Error("The embedded host must not launch another executable.");
    };
    const priorElectron = Object.getOwnPropertyDescriptor(process.versions, "electron");
    const priorProcessType = Object.getOwnPropertyDescriptor(process, "type");
    const priorWorker = Object.getOwnPropertyDescriptor(globalThis, "Worker");
    let webWorkerConstructions = 0;
    Object.defineProperty(process.versions, "electron", {
      configurable: true,
      enumerable: true,
      value: "39.0.0",
    });
    Object.defineProperty(process, "type", {
      configurable: true,
      value: "utility",
    });
    Object.defineProperty(globalThis, "Worker", {
      configurable: true,
      value: class {
        constructor() {
          webWorkerConstructions += 1;
          throw new Error("PDF.js must not create an Electron Web Worker.");
        }
      },
    });
    let result;
    try {
      result = await runPdfjsSubprocess(
        await createThreadPdfRequest(),
        {
          isolationMode: "in_process",
          spawnProcess: failIfUsed,
          workerClass: class {
            constructor() {
              failIfUsed();
            }
          },
        },
      );
    } finally {
      if (priorElectron) {
        Object.defineProperty(process.versions, "electron", priorElectron);
      } else {
        delete process.versions.electron;
      }
      if (priorProcessType) Object.defineProperty(process, "type", priorProcessType);
      else delete process.type;
      if (priorWorker) Object.defineProperty(globalThis, "Worker", priorWorker);
      else delete globalThis.Worker;
    }
    expect(webWorkerConstructions).toBe(0);
    expect(process.versions.electron).toBeUndefined();
    expect(process.type).toBeUndefined();
    expect(result).toMatchObject({
      pages_read: 1,
      text_found: true,
      total_pages: 1,
    });
    expect(result.output_text).toContain("Thread host conversion");
  });

  it("blocks embedded native canvas and renders through the tracked system child", async () => {
    if (process.platform !== "darwin") return;
    const result = await runPdfjsSubprocess(
      await createThreadPdfRequest({
        operation: "render_page",
        options: {
          max_dimension_px: 512,
          page: 1,
          renderer_policy: "native_with_system_fallback",
          scale_override: null,
        },
      }),
      { isolationMode: "in_process" },
    );
    expect(result).toMatchObject({ renderer: "macos-quicklook" });
    expect(result.binary.subarray(0, 8)).toEqual(
      Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    );
  });

  it("runs a source-bound PDF.js request in the Electron-host worker-thread fallback", async () => {
    const result = await runPdfjsSubprocess(
      await createThreadPdfRequest(),
      { isolationMode: "worker_thread" },
    );
    expect(result).toMatchObject({
      pages_read: 1,
      text_found: true,
      total_pages: 1,
    });
    expect(result.output_text).toContain("Thread host conversion");
  });

  it("keeps native modules out of the Electron-host worker and renders through the controller", async () => {
    if (process.platform !== "darwin") return;
    const result = await runPdfjsSubprocess(
      await createThreadPdfRequest({
        operation: "render_page",
        options: {
          max_dimension_px: 512,
          page: 1,
          renderer_policy: "native_with_system_fallback",
          scale_override: null,
        },
      }),
      { isolationMode: "worker_thread" },
    );
    expect(result).toMatchObject({ renderer: "macos-quicklook" });
    expect(result.binary.subarray(0, 8)).toEqual(
      Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    );
  });

  it("bounds a stalled Electron-host worker thread by the same wall deadline", async () => {
    const workerPath = await fixtureWorker(`
setInterval(() => {}, 1000);
`);
    await expect(runPdfjsSubprocess(request(), {
      isolationMode: "worker_thread",
      timeoutMs: 150,
      workerPath,
    })).rejects.toMatchObject({
      code: PDF_RESOURCE_LIMIT_CODE,
      reason: "wall_timeout",
    });
  });

  it("rejects a malformed Electron-host worker-thread response", async () => {
    const workerPath = await fixtureWorker(`
import { parentPort } from "node:worker_threads";
parentPort.postMessage({ frame: {}, binary: null, unexpected: true });
parentPort.close();
`);
    await expect(runPdfjsSubprocess(request(), {
      isolationMode: "worker_thread",
      workerPath,
    })).rejects.toMatchObject({
      code: "PDFJS_SUBPROCESS_FAILED",
    });
  });

  it("classifies an Electron-host worker-thread heap death as a resource failure", async () => {
    const workerPath = await fixtureWorker(`
const retained = [];
for (;;) retained.push(new Array(100000).fill("bounded-worker"));
`);
    await expect(runPdfjsSubprocess(request(), {
      isolationMode: "worker_thread",
      maxOldSpaceMb: 64,
      timeoutMs: 10_000,
      workerPath,
    })).rejects.toMatchObject({
      code: PDF_RESOURCE_LIMIT_CODE,
      reason: "worker_memory_or_signal_limit",
    });
  });

  it("does not orphan a system child when the Electron-host worker thread is terminated", async () => {
    if (process.platform === "win32") return;
    const rendererPath = await fixtureWorker(`
process.on("SIGTERM", () => {});
setInterval(() => {}, 1000);
`);
    const workerPath = await fixtureWorker(`
import { parentPort } from "node:worker_threads";
parentPort.postMessage({
  kind: "system_command",
  id: 1,
  command: "/usr/bin/sips",
  args: ["synthetic"],
  timeout_ms: 30000,
});
setInterval(() => {}, 1000);
`);
    let rendererPid = null;
    const operation = runPdfjsSubprocess(request(), {
      isolationMode: "worker_thread",
      // The production command allowlist is intentionally macOS-only. This
      // fixture substitutes the child executable, so pin the injected platform
      // to the boundary under test instead of inheriting the test host.
      platform: "darwin",
      spawnProcess(_command, _args, options) {
        const child = spawn(process.execPath, [rendererPath], options);
        rendererPid = child.pid;
        return child;
      },
      timeoutMs: 500,
      workerPath,
    });
    // Observe the rejection immediately while delaying the assertion until the
    // fixture has captured the nested child PID.
    void operation.catch(() => {});
    const deadline = Date.now() + 2000;
    while (rendererPid === null && Date.now() < deadline) {
      await new Promise(resolve => setTimeout(resolve, 20));
    }
    expect(rendererPid).not.toBeNull();
    await expect(operation).rejects.toMatchObject({
      code: PDF_RESOURCE_LIMIT_CODE,
      reason: "wall_timeout",
    });
    expect(() => process.kill(rendererPid, 0)).toThrow(
      expect.objectContaining({ code: "ESRCH" }),
    );
  });

  it("rejects a worker-thread Quick Look path outside its controller-owned workspace", async () => {
    const outsidePath = path.join(os.tmpdir(), "pdf-tools-untrusted-quicklook-source.pdf");
    const workerPath = await fixtureWorker(`
import { parentPort } from "node:worker_threads";
parentPort.once("message", message => {
  parentPort.postMessage({
    kind: "response",
    response: {
      frame: {
        status: "error",
        protocol_version: 1,
        operation: "read_content",
        error: message.error,
      },
      binary: null,
    },
  });
});
parentPort.postMessage({
  kind: "system_command",
  id: 1,
  command: "/usr/bin/qlmanage",
  args: ["-t", "-s", "512", "-o", ${JSON.stringify(os.tmpdir())}, ${JSON.stringify(outsidePath)}],
  timeout_ms: 30000,
});
`);
    let spawnCalls = 0;
    let failure;
    try {
      await runPdfjsSubprocess(request(), {
        isolationMode: "worker_thread",
        platform: "darwin",
        spawnProcess() {
          spawnCalls += 1;
          throw new Error("unreachable spawn");
        },
        workerPath,
      });
    } catch (error) {
      failure = error;
    }
    expect(spawnCalls).toBe(0);
    expect(failure).toMatchObject({
      code: "PDFJS_SUBPROCESS_FAILED",
      message: "The PDF.js worker requested an invalid Quick Look workspace.",
    });
    expect(failure.message).not.toContain(outsidePath);
  });

  it("accepts one strict response only after the worker exits and removes its private cwd", async () => {
    const workerPath = await fixtureWorker(`
await new Promise(resolve => process.stdin.on("end", resolve).resume());
process.stdout.write(JSON.stringify({
  status: "ok",
  protocol_version: 1,
  operation: "read_content",
  result: { cwd: process.cwd() },
  binary: null,
}));
`);
    const result = await runPdfjsSubprocess(request(), { workerPath });
    expect(path.basename(result.cwd)).toMatch(/^pdf-tools-pdfjs-/);
    await expect(fs.access(result.cwd)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("propagates a validated generic worker error rather than mistaking it for protocol corruption", async () => {
    const response = JSON.stringify({
      status: "error",
      protocol_version: 1,
      operation: "read_content",
      error: {
        name: "PdfParseError",
        code: null,
        message: "The parser rejected this fixture.",
      },
    });
    const workerPath = await fixtureWorker(`
await new Promise(resolve => process.stdin.on("end", resolve).resume());
process.stdout.write(${JSON.stringify(response)});
`);
    await expect(runPdfjsSubprocess(request(), { workerPath })).rejects.toMatchObject({
      name: "PdfParseError",
      message: "The parser rejected this fixture.",
    });
  });

  it.each([
    ["malformed JSON", "process.stdout.write('{');"],
    ["trailing bytes", `process.stdout.write(${JSON.stringify(success())} + "\\n");`],
    ["mismatched operation", `process.stdout.write(${JSON.stringify(JSON.stringify({
      status: "ok",
      protocol_version: 1,
      operation: "read_pages",
      result: { value: "wrong" },
      binary: null,
    }))});`],
  ])("rejects %s without accepting a partial result", async (_label, outputStatement) => {
    const workerPath = await fixtureWorker(`
await new Promise(resolve => process.stdin.on("end", resolve).resume());
${outputStatement}
`);
    await expect(runPdfjsSubprocess(request(), { workerPath })).rejects.toMatchObject({
      code: "PDFJS_SUBPROCESS_FAILED",
    });
  });

  it("classifies a wall timeout as a typed resource failure", async () => {
    const workerPath = await fixtureWorker(`
process.on("SIGTERM", () => {});
await new Promise(resolve => process.stdin.on("end", resolve).resume());
setInterval(() => {}, 1000);
`);
    await expect(runPdfjsSubprocess(request(), {
      timeoutMs: 150,
      workerPath,
    })).rejects.toMatchObject({
      code: PDF_RESOURCE_LIMIT_CODE,
      reason: "wall_timeout",
    });
  });

  it("caps stdout before parsing and returns no worker-controlled bytes", async () => {
    const workerPath = await fixtureWorker(`
await new Promise(resolve => process.stdin.on("end", resolve).resume());
process.stdout.write("x".repeat(4096));
setInterval(() => {}, 1000);
`);
    await expect(runPdfjsSubprocess(request(), {
      maxResultBytes: 1024,
      timeoutMs: 1000,
      workerPath,
    })).rejects.toMatchObject({
      code: PDF_RESOURCE_LIMIT_CODE,
      reason: "worker_output_limit",
    });
  });

  it("keeps the worker inside the enclosing host process session", async () => {
    let observedOptions = null;
    const workerPath = await fixtureWorker(`
await new Promise(resolve => process.stdin.on("end", resolve).resume());
process.stdout.write(${JSON.stringify(success())});
`);
    const result = await runPdfjsSubprocess(request(), {
      spawnProcess(executable, args, options) {
        observedOptions = options;
        return spawn(executable, args, options);
      },
      workerPath,
    });
    expect(result).toEqual({ value: "ok" });
    expect(observedOptions).toMatchObject({ detached: false, shell: false });
  });

  it("reaps a nested system renderer during parent deadline escalation", async () => {
    if (process.platform === "win32") return;
    const { rendererInfoPath, workerPath } = await nestedSystemWorker();
    // Allow worker imports and the nested Node process to start, then prove
    // the stubborn renderer is alive before the real parent deadline fires.
    const operation = runPdfjsSubprocess(request(), {
      timeoutMs: 5_000,
      workerPath,
    }).then(value => ({ value }), error => ({ error }));
    try {
      const renderer = JSON.parse(await waitForFile(rendererInfoPath, 2_000));
      expect(() => process.kill(renderer.pid, 0)).not.toThrow();
      expect(await operation).toMatchObject({
        error: { code: PDF_RESOURCE_LIMIT_CODE, reason: "wall_timeout" },
      });
      expect(() => process.kill(renderer.pid, 0)).toThrow(
        expect.objectContaining({ code: "ESRCH" }),
      );
      await expect(fs.access(renderer.cwd)).rejects.toMatchObject({ code: "ENOENT" });
    } finally {
      // A failed readiness assertion must not race afterEach's directory cleanup.
      await operation;
    }
  }, 10_000);

  it("reaps a nested system renderer during graceful server shutdown", async () => {
    if (process.platform === "win32") return;
    const { rendererInfoPath, workerPath } = await nestedSystemWorker();
    const operation = expect(runPdfjsSubprocess(request(), {
      timeoutMs: 30_000,
      workerPath,
    })).rejects.toMatchObject({
      code: "PDFJS_SUBPROCESS_FAILED",
    });
    const renderer = JSON.parse(await waitForFile(rendererInfoPath));
    await terminateAllPdfjsSubprocesses({ reopenAfterSuccessfulDrain: true });
    await operation;
    expect(() => process.kill(renderer.pid, 0)).toThrow(
      expect.objectContaining({ code: "ESRCH" }),
    );
    await expect(fs.access(renderer.cwd)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("closes admission, rejects queued work, and drains an admitted pre-spawn operation", async () => {
    let releasePreSpawn;
    let markPreSpawnStarted;
    const preSpawnStarted = new Promise(resolve => {
      markPreSpawnStarted = resolve;
    });
    const preSpawnRelease = new Promise(resolve => {
      releasePreSpawn = resolve;
    });
    let spawnCalls = 0;
    const removedDirectories = [];
    const held = runPdfjsSubprocess(request(), {
      beforeSpawn: async () => {
        markPreSpawnStarted();
        await preSpawnRelease;
      },
      removeOperationDirectory: async (directory, options) => {
        removedDirectories.push(directory);
        await fs.rm(directory, options);
      },
      spawnProcess() {
        spawnCalls += 1;
        throw new Error("spawn must remain closed during shutdown");
      },
    });
    void held.catch(() => {});
    await preSpawnStarted;
    const queued = runPdfjsSubprocess(request(), {
      spawnProcess() {
        spawnCalls += 1;
        throw new Error("queued operation must not be promoted");
      },
    });
    void queued.catch(() => {});
    let shutdownSettled = false;
    const shutdown = terminateAllPdfjsSubprocesses({
      reopenAfterSuccessfulDrain: true,
    }).finally(() => {
      shutdownSettled = true;
    });
    expect(await settlementBeforeDelay(shutdown)).toBe("pending");
    expect(shutdownSettled).toBe(false);
    releasePreSpawn();
    await expect(held).rejects.toMatchObject({
      code: PDF_RESOURCE_LIMIT_CODE,
      reason: "worker_shutdown_in_progress",
    });
    await expect(queued).rejects.toMatchObject({
      code: PDF_RESOURCE_LIMIT_CODE,
      reason: "worker_shutdown_in_progress",
    });
    await expect(shutdown).resolves.toBeUndefined();
    expect(spawnCalls).toBe(0);
    expect(removedDirectories).toHaveLength(1);
    await expect(fs.access(removedDirectories[0])).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("holds the in-process renderer gate through the execute-to-workspace shutdown race", async () => {
    if (process.platform !== "darwin") return;
    const renderRequest = await createThreadPdfRequest({
      operation: "render_page",
      options: {
        max_dimension_px: 512,
        page: 1,
        renderer_policy: "system",
        scale_override: null,
      },
    });
    const workerModule = await import("../server/pdfjs-worker.js");
    const initialState = workerModule.snapshotPdfjsWorkerSystemRendererState();
    const initialWorkspaces = new Set(
      (await fs.readdir(os.tmpdir()))
        .filter(name => name.startsWith("pdf-tools-system-render-")),
    );
    const originalLoad = PDFDocument.load;
    let loadCalls = 0;
    let releaseExecute;
    let markExecuteStarted;
    const executeStarted = new Promise(resolve => {
      markExecuteStarted = resolve;
    });
    const executeRelease = new Promise(resolve => {
      releaseExecute = resolve;
    });
    let releaseCleanup;
    let markCleanupStarted;
    const cleanupStarted = new Promise(resolve => {
      markCleanupStarted = resolve;
    });
    const cleanupRelease = new Promise(resolve => {
      releaseCleanup = resolve;
    });
    let operationDirectory = null;
    PDFDocument.load = async function heldPdfLoad(...args) {
      loadCalls += 1;
      if (loadCalls === 1) {
        markExecuteStarted();
        await executeRelease;
      }
      return await originalLoad.apply(this, args);
    };
    let operation;
    let shutdown;
    try {
      operation = runPdfjsSubprocess(renderRequest, {
        isolationMode: "in_process",
        removeOperationDirectory: async (directory, options) => {
          operationDirectory = directory;
          markCleanupStarted();
          await cleanupRelease;
          await fs.rm(directory, options);
        },
      });
      void operation.catch(() => {});
      await executeStarted;
      shutdown = terminateAllPdfjsSubprocesses({ reopenAfterSuccessfulDrain: true });
      void shutdown.catch(() => {});
      let rawReopenFailure;
      try {
        workerModule.reopenPdfjsWorkerSystemRenderer();
      } catch (error) {
        rawReopenFailure = error;
      }
      expect(rawReopenFailure).toMatchObject({
        code: PDF_RESOURCE_LIMIT_CODE,
        reason: "system_renderer_controller_shutdown",
      });
      expect(rawReopenFailure.message).not.toContain(renderRequest.source.canonical_path);
      expect(workerModule.snapshotPdfjsWorkerSystemRendererState()).toMatchObject({
        admission_closed: true,
        active_children: 0,
        active_workspaces: 0,
        controller_shutdown: true,
        spawn_count: initialState.spawn_count,
      });
      expect(await settlementBeforeDelay(shutdown)).toBe("pending");
      releaseExecute();
      await cleanupStarted;
      expect(await settlementBeforeDelay(shutdown)).toBe("pending");
      expect(workerModule.snapshotPdfjsWorkerSystemRendererState()).toMatchObject({
        admission_closed: true,
        active_children: 0,
        active_workspaces: 0,
        controller_shutdown: true,
        spawn_count: initialState.spawn_count,
      });
      const workspacesDuringCleanup = (await fs.readdir(os.tmpdir()))
        .filter(name => name.startsWith("pdf-tools-system-render-"));
      expect(new Set(workspacesDuringCleanup)).toEqual(initialWorkspaces);
      releaseCleanup();
      let operationFailure;
      try {
        await operation;
      } catch (error) {
        operationFailure = error;
      }
      expect(operationFailure).toMatchObject({
        code: PDF_RESOURCE_LIMIT_CODE,
        reason: "system_renderer_shutdown",
      });
      expect(operationFailure.message).not.toContain(renderRequest.source.canonical_path);
      expect(operationFailure.message).not.toContain(operationDirectory);
      await expect(shutdown).resolves.toBeUndefined();
      expect(workerModule.snapshotPdfjsWorkerSystemRendererState()).toMatchObject({
        admission_closed: false,
        active_children: 0,
        active_workspaces: 0,
        controller_shutdown: false,
        spawn_count: initialState.spawn_count,
      });
      let reopenedDirectory = null;
      await workerModule.withPrivateSystemRenderWorkspace(async ({ renderDirectory }) => {
        reopenedDirectory = renderDirectory;
        await fs.writeFile(path.join(renderDirectory, "bounded.txt"), "reopened");
      });
      await expect(fs.access(reopenedDirectory)).rejects.toMatchObject({ code: "ENOENT" });
      await expect(fs.access(operationDirectory)).rejects.toMatchObject({ code: "ENOENT" });
    } finally {
      PDFDocument.load = originalLoad;
      releaseExecute?.();
      releaseCleanup?.();
      if (operation !== undefined) await operation.catch(() => {});
      if (shutdown !== undefined) await shutdown.catch(() => {});
    }
  });

  it.each(["throws", "non_boolean"])(
    "fails closed when the bound controller probe %s and rejects rebinding",
    async mode => {
      const workerUrl = pathToFileURL(
        path.resolve("server/pdfjs-worker.js"),
      ).href;
      const result = await runNodeFixture(`
import {
  bindPdfjsWorkerSystemRendererControllerProbe,
  reopenPdfjsWorkerSystemRenderer,
  snapshotPdfjsWorkerSystemRendererState,
  withPrivateSystemRenderWorkspace,
} from ${JSON.stringify(workerUrl)};

const mode = process.argv[2];
bindPdfjsWorkerSystemRendererControllerProbe(
  mode === "throws"
    ? () => { throw new Error("untrusted probe failure"); }
    : () => "not a boolean",
);
let callbackCalls = 0;
let admissionFailure;
try {
  await withPrivateSystemRenderWorkspace(async () => { callbackCalls += 1; });
} catch (error) {
  admissionFailure = error;
}
let reopenFailure;
try { reopenPdfjsWorkerSystemRenderer(); } catch (error) { reopenFailure = error; }
let rebindFailure;
try {
  bindPdfjsWorkerSystemRendererControllerProbe(() => false);
} catch (error) {
  rebindFailure = error;
}
console.log(JSON.stringify({
  admission: { code: admissionFailure?.code, reason: admissionFailure?.reason },
  callbackCalls,
  rebind: { message: rebindFailure?.message, name: rebindFailure?.name },
  reopen: { code: reopenFailure?.code, reason: reopenFailure?.reason },
  state: snapshotPdfjsWorkerSystemRendererState(),
}));
`, [mode]);
      expect(result).toMatchObject({ code: 0, signal: null });
      const receipt = JSON.parse(result.stdout.trim().split("\n").at(-1));
      expect(receipt.admission).toEqual({
        code: PDF_RESOURCE_LIMIT_CODE,
        reason: "system_renderer_controller_shutdown",
      });
      expect(receipt.reopen).toEqual({
        code: PDF_RESOURCE_LIMIT_CODE,
        reason: "system_renderer_controller_shutdown",
      });
      expect(receipt.callbackCalls).toBe(0);
      expect(receipt.rebind).toEqual({
        message: "system renderer controller probe is already bound.",
        name: "TypeError",
      });
      expect(receipt.state).toMatchObject({
        active_children: 0,
        active_workspaces: 0,
        controller_shutdown: true,
      });
    },
  );

  it("keeps outer and inner admission closed after a bounded shutdown timeout", async () => {
    const sourceRequest = await createThreadPdfRequest();
    const subprocessUrl = pathToFileURL(
      path.resolve("server/pdfjs-subprocess.js"),
    ).href;
    const workerUrl = pathToFileURL(
      path.resolve("server/pdfjs-worker.js"),
    ).href;
    const result = await runNodeFixture(`
import {
  PDF_RESOURCE_LIMIT_CODE,
  runPdfjsSubprocess,
  terminateAllPdfjsSubprocesses,
} from ${JSON.stringify(subprocessUrl)};
import {
  snapshotPdfjsWorkerSystemRendererState,
  withPrivateSystemRenderWorkspace,
} from ${JSON.stringify(workerUrl)};

const request = JSON.parse(process.argv[2]);
await runPdfjsSubprocess(request, { isolationMode: "in_process" });
let releasePreSpawn;
let markPreSpawnStarted;
const preSpawnStarted = new Promise(resolve => { markPreSpawnStarted = resolve; });
const preSpawnRelease = new Promise(resolve => { releasePreSpawn = resolve; });
const held = runPdfjsSubprocess(request, {
  beforeSpawn: async () => {
    markPreSpawnStarted();
    await preSpawnRelease;
  },
  isolationMode: "in_process",
});
void held.catch(() => {});
await preSpawnStarted;
let shutdownFailure;
const keepalive = setInterval(() => {}, 1000);
try {
  await terminateAllPdfjsSubprocesses({ shutdownTimeoutMs: 20 });
} catch (error) {
  shutdownFailure = error;
} finally {
  clearInterval(keepalive);
}
releasePreSpawn();
let heldFailure;
try {
  await held;
} catch (error) {
  heldFailure = error;
}
let resurrectionFailure;
try {
  await terminateAllPdfjsSubprocesses({ reopenAfterSuccessfulDrain: true });
} catch (error) {
  resurrectionFailure = error;
}
let outerFailure;
try {
  await runPdfjsSubprocess(request, { isolationMode: "in_process" });
} catch (error) {
  outerFailure = error;
}
let innerFailure;
try {
  await withPrivateSystemRenderWorkspace(async () => {
    throw new Error("closed inner admission executed its callback");
  });
} catch (error) {
  innerFailure = error;
}
const state = snapshotPdfjsWorkerSystemRendererState();
console.log(JSON.stringify({
  held: { code: heldFailure?.code, reason: heldFailure?.reason },
  inner: { code: innerFailure?.code, message: innerFailure?.message, reason: innerFailure?.reason },
  outer: { code: outerFailure?.code, message: outerFailure?.message, reason: outerFailure?.reason },
  resurrection: { code: resurrectionFailure?.code, reason: resurrectionFailure?.reason },
  resourceCode: PDF_RESOURCE_LIMIT_CODE,
  shutdown: { code: shutdownFailure?.code, reason: shutdownFailure?.reason },
  state,
}));
`, [JSON.stringify(sourceRequest)]);
    expect(result).toMatchObject({ code: 0, signal: null });
    const receipt = JSON.parse(result.stdout.trim().split("\n").at(-1));
    expect(receipt.shutdown).toEqual({
      code: PDF_RESOURCE_LIMIT_CODE,
      reason: "worker_shutdown_timeout",
    });
    expect(receipt.held).toEqual({
      code: PDF_RESOURCE_LIMIT_CODE,
      reason: "worker_shutdown_in_progress",
    });
    expect(receipt.outer).toMatchObject({
      code: PDF_RESOURCE_LIMIT_CODE,
      reason: "worker_shutdown_in_progress",
    });
    expect(receipt.resurrection).toEqual({
      code: PDF_RESOURCE_LIMIT_CODE,
      reason: "worker_shutdown_terminal",
    });
    expect(receipt.inner).toMatchObject({
      code: PDF_RESOURCE_LIMIT_CODE,
      reason: "system_renderer_shutdown_terminal",
    });
    expect(receipt.outer.message).not.toContain(sourceRequest.source.canonical_path);
    expect(receipt.inner.message).not.toContain(sourceRequest.source.canonical_path);
    expect(receipt.state).toMatchObject({
      admission_closed: true,
      active_children: 0,
      active_workspaces: 0,
      terminal: true,
    });
  });

  it.each([
    "termination_failure",
    "concurrent_default",
    "force",
  ])("cannot resurrect terminal renderer state after %s", async mode => {
    const sourceRequest = await createThreadPdfRequest();
    const subprocessUrl = pathToFileURL(
      path.resolve("server/pdfjs-subprocess.js"),
    ).href;
    const workerUrl = pathToFileURL(
      path.resolve("server/pdfjs-worker.js"),
    ).href;
    const result = await runNodeFixture(`
import { EventEmitter } from "node:events";
import {
  forceTerminateAllPdfjsSubprocesses,
  runPdfjsSubprocess,
  terminateAllPdfjsSubprocesses,
} from ${JSON.stringify(subprocessUrl)};
import {
  snapshotPdfjsWorkerSystemRendererState,
  withPrivateSystemRenderWorkspace,
} from ${JSON.stringify(workerUrl)};

const request = JSON.parse(process.argv[2]);
const mode = process.argv[3];
await runPdfjsSubprocess(request, { isolationMode: "in_process" });
let firstFailure = null;
let sharedPromise = null;
if (mode === "termination_failure") {
  let markWorkerReady;
  const workerReady = new Promise(resolve => { markWorkerReady = resolve; });
  class RejectingTerminationWorker extends EventEmitter {
    constructor() {
      super();
      queueMicrotask(markWorkerReady);
    }
    postMessage() {}
    terminate() {
      this.emit("exit", 1);
      return Promise.reject(new Error("forced thread termination failure"));
    }
  }
  const operation = runPdfjsSubprocess(request, {
    isolationMode: "worker_thread",
    timeoutMs: 30_000,
    workerClass: RejectingTerminationWorker,
  });
  void operation.catch(() => {});
  await workerReady;
  try {
    await terminateAllPdfjsSubprocesses({ reopenAfterSuccessfulDrain: true });
  } catch (error) {
    firstFailure = error;
  }
  await operation.catch(() => {});
} else if (mode === "concurrent_default") {
  let releasePreSpawn;
  let markPreSpawnStarted;
  const preSpawnStarted = new Promise(resolve => { markPreSpawnStarted = resolve; });
  const preSpawnRelease = new Promise(resolve => { releasePreSpawn = resolve; });
  const operation = runPdfjsSubprocess(request, {
    beforeSpawn: async () => {
      markPreSpawnStarted();
      await preSpawnRelease;
    },
    isolationMode: "in_process",
  });
  void operation.catch(() => {});
  await preSpawnStarted;
  const reusableDrain = terminateAllPdfjsSubprocesses({ reopenAfterSuccessfulDrain: true });
  void reusableDrain.catch(() => {});
  const terminalDrain = terminateAllPdfjsSubprocesses();
  void terminalDrain.catch(() => {});
  sharedPromise = reusableDrain === terminalDrain;
  releasePreSpawn();
  try { await reusableDrain; } catch (error) { firstFailure = error; }
  await operation.catch(() => {});
} else if (mode === "force") {
  forceTerminateAllPdfjsSubprocesses();
} else {
  throw new Error("unknown terminal-state fixture mode");
}
let resurrectionFailure;
try {
  await terminateAllPdfjsSubprocesses({ reopenAfterSuccessfulDrain: true });
} catch (error) {
  resurrectionFailure = error;
}
let outerFailure;
try {
  await runPdfjsSubprocess(request, { isolationMode: "in_process" });
} catch (error) {
  outerFailure = error;
}
let innerFailure;
try {
  await withPrivateSystemRenderWorkspace(async () => {
    throw new Error("closed inner admission executed its callback");
  });
} catch (error) {
  innerFailure = error;
}
console.log(JSON.stringify({
  first: { code: firstFailure?.code, message: firstFailure?.message, reason: firstFailure?.reason },
  inner: { code: innerFailure?.code, reason: innerFailure?.reason },
  outer: { code: outerFailure?.code, reason: outerFailure?.reason },
  resurrection: { code: resurrectionFailure?.code, reason: resurrectionFailure?.reason },
  sharedPromise,
  state: snapshotPdfjsWorkerSystemRendererState(),
}));
`, [JSON.stringify(sourceRequest), mode]);
    expect(result).toMatchObject({ code: 0, signal: null });
    const receipt = JSON.parse(result.stdout.trim().split("\n").at(-1));
    expect(receipt.resurrection).toEqual({
      code: PDF_RESOURCE_LIMIT_CODE,
      reason: "worker_shutdown_terminal",
    });
    expect(receipt.outer).toMatchObject({
      code: PDF_RESOURCE_LIMIT_CODE,
    });
    expect(receipt.inner).toEqual({
      code: PDF_RESOURCE_LIMIT_CODE,
      reason: "system_renderer_shutdown_terminal",
    });
    expect(receipt.state).toMatchObject({
      admission_closed: true,
      active_children: 0,
      active_workspaces: 0,
      terminal: true,
    });
    if (mode === "termination_failure") {
      expect(receipt.first.message).toBe("forced thread termination failure");
    } else if (mode === "concurrent_default") {
      expect(receipt.sharedPromise).toBe(true);
      expect(receipt.first).toMatchObject({
        code: PDF_RESOURCE_LIMIT_CODE,
        reason: "worker_shutdown_terminal",
      });
    }
  });

  it("does not spawn a late worker-thread system-command frame after shutdown starts", async () => {
    let markWorkerReady;
    const workerReady = new Promise(resolve => {
      markWorkerReady = resolve;
    });
    let operationDirectory = null;
    let spawnCalls = 0;
    class LateFrameWorker extends EventEmitter {
      constructor(_workerPath, options) {
        super();
        operationDirectory = options.env.TMPDIR;
        this.renderDirectory = path.join(
          operationDirectory,
          "pdf-tools-system-render-late-frame",
        );
        mkdirSync(this.renderDirectory, { mode: 0o700 });
        writeFileSync(path.join(this.renderDirectory, "source.pdf"), "bounded");
        this.termination = null;
        markWorkerReady();
      }

      postMessage() {}

      terminate() {
        if (this.termination !== null) return this.termination;
        this.emit("message", {
          kind: "system_command",
          id: 1,
          command: "/usr/bin/qlmanage",
          args: [
            "-t",
            "-s",
            "512",
            "-o",
            this.renderDirectory,
            path.join(this.renderDirectory, "source.pdf"),
          ],
          timeout_ms: 30_000,
        });
        this.termination = new Promise(resolve => {
          setTimeout(() => {
            this.emit("exit", 0);
            resolve(0);
          }, 20);
        });
        return this.termination;
      }
    }
    const operation = runPdfjsSubprocess(request(), {
      isolationMode: "worker_thread",
      spawnProcess() {
        spawnCalls += 1;
        throw new Error("late frame must not spawn");
      },
      workerClass: LateFrameWorker,
    });
    void operation.catch(() => {});
    await workerReady;
    const shutdown = terminateAllPdfjsSubprocesses({ reopenAfterSuccessfulDrain: true });
    await expect(operation).rejects.toMatchObject({ code: PDF_RESOURCE_LIMIT_CODE });
    await expect(shutdown).resolves.toBeUndefined();
    expect(spawnCalls).toBe(0);
    await expect(fs.access(operationDirectory)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("propagates a typed cleanup failure only after the shutdown drain settles", async () => {
    const sourceRequest = await createThreadPdfRequest();
    const subprocessUrl = pathToFileURL(
      path.resolve("server/pdfjs-subprocess.js"),
    ).href;
    const workerUrl = pathToFileURL(
      path.resolve("server/pdfjs-worker.js"),
    ).href;
    const result = await runNodeFixture(`
import { rm } from "node:fs/promises";
import {
  runPdfjsSubprocess,
  terminateAllPdfjsSubprocesses,
} from ${JSON.stringify(subprocessUrl)};
import {
  snapshotPdfjsWorkerSystemRendererState,
  withPrivateSystemRenderWorkspace,
} from ${JSON.stringify(workerUrl)};

const request = JSON.parse(process.argv[2]);
await runPdfjsSubprocess(request, { isolationMode: "in_process" });
let releasePreSpawn;
let markPreSpawnStarted;
const preSpawnStarted = new Promise(resolve => { markPreSpawnStarted = resolve; });
const preSpawnRelease = new Promise(resolve => { releasePreSpawn = resolve; });
let removedDirectory = null;
const operation = runPdfjsSubprocess(request, {
  beforeSpawn: async () => {
    markPreSpawnStarted();
    await preSpawnRelease;
  },
  isolationMode: "in_process",
  removeOperationDirectory: async (directory, options) => {
    removedDirectory = directory;
    await rm(directory, options);
    throw new Error("forced cleanup receipt failure");
  },
});
void operation.catch(() => {});
await preSpawnStarted;
const shutdown = terminateAllPdfjsSubprocesses();
void shutdown.catch(() => {});
releasePreSpawn();
let operationFailure;
try { await operation; } catch (error) { operationFailure = error; }
let shutdownFailure;
try { await shutdown; } catch (error) { shutdownFailure = error; }
let resurrectionFailure;
try {
  await terminateAllPdfjsSubprocesses({ reopenAfterSuccessfulDrain: true });
} catch (error) {
  resurrectionFailure = error;
}
let outerFailure;
try {
  await runPdfjsSubprocess(request, { isolationMode: "in_process" });
} catch (error) {
  outerFailure = error;
}
let innerFailure;
try {
  await withPrivateSystemRenderWorkspace(async () => {
    throw new Error("closed inner admission executed its callback");
  });
} catch (error) {
  innerFailure = error;
}
console.log(JSON.stringify({
  inner: { code: innerFailure?.code, message: innerFailure?.message, reason: innerFailure?.reason },
  operation: { code: operationFailure?.code, reason: operationFailure?.reason },
  outer: { code: outerFailure?.code, message: outerFailure?.message, reason: outerFailure?.reason },
  removedDirectory,
  resurrection: { code: resurrectionFailure?.code, reason: resurrectionFailure?.reason },
  shutdown: { code: shutdownFailure?.code, message: shutdownFailure?.message, reason: shutdownFailure?.reason },
  state: snapshotPdfjsWorkerSystemRendererState(),
}));
`, [JSON.stringify(sourceRequest)]);
    expect(result).toMatchObject({ code: 0, signal: null });
    const receipt = JSON.parse(result.stdout.trim().split("\n").at(-1));
    expect(receipt.operation).toEqual({
      code: PDF_RESOURCE_LIMIT_CODE,
      reason: "operation_directory_cleanup_unproven",
    });
    expect(receipt.shutdown).toMatchObject({
      code: PDF_RESOURCE_LIMIT_CODE,
      reason: "operation_directory_cleanup_unproven",
    });
    expect(receipt.outer).toMatchObject({
      code: PDF_RESOURCE_LIMIT_CODE,
      reason: "worker_shutdown_in_progress",
    });
    expect(receipt.resurrection).toEqual({
      code: PDF_RESOURCE_LIMIT_CODE,
      reason: "worker_shutdown_terminal",
    });
    expect(receipt.inner).toMatchObject({
      code: PDF_RESOURCE_LIMIT_CODE,
      reason: "system_renderer_shutdown_terminal",
    });
    expect(receipt.shutdown.message).not.toContain(receipt.removedDirectory);
    expect(receipt.outer.message).not.toContain(sourceRequest.source.canonical_path);
    expect(receipt.inner.message).not.toContain(sourceRequest.source.canonical_path);
    expect(receipt.state).toMatchObject({
      admission_closed: true,
      active_children: 0,
      active_workspaces: 0,
      terminal: true,
    });
    await expect(fs.access(receipt.removedDirectory)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("waits for every subsystem cleanup before propagating one rejection", async () => {
    let releaseCleanup;
    const delayedCleanup = new Promise(resolve => {
      releaseCleanup = resolve;
    });
    const subsystemFailure = new Error("forced subsystem rejection");
    let settled = false;
    const shutdown = settleAllShutdownOperations([
      Promise.reject(subsystemFailure),
      delayedCleanup,
    ]).finally(() => {
      settled = true;
    });
    void shutdown.catch(() => {});
    expect(await settlementBeforeDelay(shutdown)).toBe("pending");
    expect(settled).toBe(false);
    releaseCleanup();
    await expect(shutdown).rejects.toBe(subsystemFailure);
    expect(settled).toBe(true);
  });

  it("does not inherit Node injection flags or unrelated secrets", async () => {
    const workerPath = await fixtureWorker(`
await new Promise(resolve => process.stdin.on("end", resolve).resume());
process.stdout.write(JSON.stringify({
  status: "ok",
  protocol_version: 1,
  operation: "read_content",
  result: {
    node_options: process.env.NODE_OPTIONS ?? null,
    secret: process.env.PDF_TOOLS_TEST_SECRET ?? null,
  },
  binary: null,
}));
`);
    const result = await runPdfjsSubprocess(request(), {
      environment: {
        ...process.env,
        NODE_OPTIONS: "--inspect",
        PDF_TOOLS_TEST_SECRET: "must-not-cross",
      },
      workerPath,
    });
    expect(result).toEqual({ node_options: null, secret: null });
  });
});
