import { spawn } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import {
  closeSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { chmod, lstat, mkdtemp, realpath, rm } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { Worker } from "node:worker_threads";

export const PDF_RESOURCE_LIMIT_CODE = "PDF_RESOURCE_LIMIT_EXCEEDED";

const SERVER_DIR = dirname(fileURLToPath(import.meta.url));
// The Windows system-render fallback never invokes pdfium.dll directly: it
// spawns this trusted, repository-owned helper script as a disposable Node
// child process, exactly the isolation qlmanage/sips get on darwin. Only this
// exact absolute path is ever accepted as args[0] below.
const PDFIUM_RENDER_HOST_PATH = join(SERVER_DIR, "pdfium-render-host.mjs");
// Only these two exact, repository-owned DLL paths are ever accepted as
// args[1]. Neither is influenced by PDF content or by the caller.
const PDFIUM_DLL_PATHS = new Map([
  ["x64", join(SERVER_DIR, "..", "vendor", "pdfium", "runtime", "win-x64", "pdfium.dll")],
  ["arm64", join(SERVER_DIR, "..", "vendor", "pdfium", "runtime", "win-arm64", "pdfium.dll")],
]);
// Mirrors the identically named set in server/pdfjs-worker.js. Duplicated
// rather than imported, matching how PDF_RESOURCE_LIMIT_CODE is already
// duplicated across this worker/controller boundary in both files.
const SYSTEM_RENDERER_LABELS = new Set(["macOS", "Windows"]);

const PROTOCOL_VERSION = 1;
const DEFAULT_TIMEOUT_MS = 30_000;
const DEFAULT_MAX_RESULT_BYTES = 24 * 1024 * 1024;
const DEFAULT_MAX_BINARY_BYTES = 16 * 1024 * 1024;
const DEFAULT_MAX_STDERR_BYTES = 64 * 1024;
const DEFAULT_MAX_OLD_SPACE_MB = 384;
const MAX_REQUEST_BYTES = 64 * 1024;
const MAX_QUEUED_OPERATIONS = 8;
const TERMINATION_GRACE_MS = 1000;
const OPERATION_SHUTDOWN_TIMEOUT_MS = 15_000;
const PDFJS_OPERATIONS = new Set([
  "analyze_pages",
  "detect_signature_zones",
  "extract_layout",
  "extract_layout_for_markdown",
  "observe_document",
  "read_content",
  "read_pages",
  "render_comparison_page",
  "render_page",
  "render_region",
  "search_text",
]);
const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const WORKER_ERROR = Symbol("pdfjs-worker-error");

let activeOperationCount = 0;
const queuedOperations = [];
const activeOperations = new Set();
const activeChildren = new Set();
const activeThreadWorkers = new Set();
const activeThreadSystemChildren = new Set();
let inProcessWorkerModulePromise = null;
let inProcessWorkerModule = null;
let inProcessCanvasGuardInstalled = false;
// The native-canvas attempt this process armed, if any: { markerPath, token }.
// The token is held only in memory, which is what makes ownership decidable -
// no other process can ever present it, so no other process can clear a marker
// it does not own.
let activeNativeCanvasAttempt = null;
// Why the last native-canvas load was refused, for the renderer error path.
// It cannot travel on the thrown error: @napi-rs/canvas catches whatever dlopen
// throws and reports its own "Cannot find native binding" instead, discarding
// ours. This is read back through a bound probe, see pdfjs-worker.js.
let lastNativeCanvasBlockReason = null;
let shutdownInProgress = false;
let shutdownTerminal = false;
let gracefulShutdownPromise = null;

export function selectPdfjsIsolationMode({
  electronVersion = process.versions.electron ?? null,
  processType = process.type ?? null,
  hasElectronParentPort = process.parentPort != null,
  executable = process.execPath,
} = {}) {
  const executableName = typeof executable === "string" ? basename(executable) : "";
  const embeddedElectronHost = typeof electronVersion === "string"
    || processType === "utility"
    || hasElectronParentPort
    || /(?:^electron$|^claude(?: helper(?: \(plugin\))?)?(?:\.exe)?$)/i.test(executableName);
  return embeddedElectronHost ? "in_process" : "subprocess";
}

const DEFAULT_ISOLATION_MODE = selectPdfjsIsolationMode();
console.error("[PDF Tools] PDF.js execution host", JSON.stringify({
  argv0: basename(process.argv0 ?? ""),
  electron: typeof process.versions.electron === "string",
  executable: basename(process.execPath),
  mode: DEFAULT_ISOLATION_MODE,
  parent_port: process.parentPort != null,
  process_type: typeof process.type === "string" ? process.type : null,
  utility_arg: [...process.execArgv, ...process.argv]
    .some(argument => /^--(?:type=utility|utility-sub-type=)/.test(argument)),
}));

function exactKeys(value, expected, label) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError(`${label} must be an object.`);
  }
  const actual = Object.keys(value).sort();
  const wanted = [...expected].sort();
  if (actual.length !== wanted.length || actual.some((key, index) => key !== wanted[index])) {
    throw new TypeError(`${label} has an invalid shape.`);
  }
}

function nonEmptyString(value, label, maximum = 32_768) {
  if (typeof value !== "string" || value.length === 0 || value.length > maximum) {
    throw new TypeError(`${label} must be a non-empty string of at most ${maximum} characters.`);
  }
  return value;
}

function boundedInteger(value, label, minimum, maximum) {
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
    throw new TypeError(`${label} must be an integer from ${minimum} to ${maximum}.`);
  }
  return value;
}

function validateSource(source) {
  exactKeys(
    source,
    ["canonical_path", "file_identity", "sha256", "size_bytes"],
    "PDF.js source binding",
  );
  nonEmptyString(source.canonical_path, "source.canonical_path");
  boundedInteger(source.size_bytes, "source.size_bytes", 1, 250 * 1024 * 1024);
  if (!/^[a-f0-9]{64}$/.test(source.sha256)) {
    throw new TypeError("source.sha256 must be a lowercase SHA-256 digest.");
  }
  exactKeys(source.file_identity, ["device", "inode"], "source.file_identity");
  nonEmptyString(source.file_identity.device, "source.file_identity.device", 128);
  nonEmptyString(source.file_identity.inode, "source.file_identity.inode", 128);
}

function validateRequest(request) {
  exactKeys(
    request,
    [
      "allowed_directories",
      "operation",
      "options",
      "password",
      "protocol_version",
      "source",
    ],
    "PDF.js subprocess request",
  );
  if (request.protocol_version !== PROTOCOL_VERSION) {
    throw new TypeError(`PDF.js subprocess protocol_version must be ${PROTOCOL_VERSION}.`);
  }
  if (!PDFJS_OPERATIONS.has(request.operation)) {
    throw new TypeError(`Unsupported PDF.js subprocess operation: ${request.operation}.`);
  }
  validateSource(request.source);
  if (
    !Array.isArray(request.allowed_directories)
    || request.allowed_directories.length < 1
    || request.allowed_directories.length > 64
  ) {
    throw new TypeError("allowed_directories must contain from 1 to 64 canonical directories.");
  }
  for (const [index, directory] of request.allowed_directories.entries()) {
    nonEmptyString(directory, `allowed_directories[${index}]`);
  }
  if (request.password !== null) {
    nonEmptyString(request.password, "password", 4096);
  }
  if (!request.options || typeof request.options !== "object" || Array.isArray(request.options)) {
    throw new TypeError("options must be an object.");
  }
  const encoded = Buffer.from(JSON.stringify(request), "utf8");
  if (encoded.length > MAX_REQUEST_BYTES) {
    throw new TypeError(`PDF.js subprocess request exceeds ${MAX_REQUEST_BYTES} bytes.`);
  }
  return encoded;
}

function resourceLimitError(reason, cause = null) {
  const error = new Error(
    "PDF processing exceeded its isolated resource budget. "
    + "The operation was stopped and the main PDF Tools server remains available. "
    + "Try a narrower page range, smaller render size, or a simpler PDF.",
    cause ? { cause } : undefined,
  );
  error.name = "PdfResourceLimitError";
  error.code = PDF_RESOURCE_LIMIT_CODE;
  error.reason = reason;
  return error;
}

function subprocessFailure(message, cause = null) {
  const error = new Error(message, cause ? { cause } : undefined);
  error.code = "PDFJS_SUBPROCESS_FAILED";
  return error;
}

function abortError() {
  const error = new Error("The isolated PDF operation was cancelled.");
  error.name = "AbortError";
  error.code = "ABORT_ERR";
  return error;
}

function childEnvironment(environment, platform, operationDirectory) {
  const selected = {
    PATH: environment.PATH ?? "",
    PDF_TOOLS_DISABLE_SYSTEM_RENDERER: "1",
    TEMP: operationDirectory,
    TMP: operationDirectory,
    TMPDIR: operationDirectory,
  };
  for (const name of ["HOME", "LANG", "LC_ALL"]) {
    if (typeof environment[name] === "string") selected[name] = environment[name];
  }
  if (platform === "win32") {
    for (const name of ["SystemRoot", "WINDIR"]) {
      if (typeof environment[name] === "string") selected[name] = environment[name];
    }
  }
  return selected;
}

function boundedCollector(maximumBytes, onOverflow) {
  const chunks = [];
  let bytes = 0;
  let overflowed = false;
  return {
    add(chunk) {
      const value = Buffer.from(chunk);
      const remaining = Math.max(0, maximumBytes - bytes);
      if (remaining > 0) chunks.push(value.subarray(0, remaining));
      bytes += value.length;
      if (bytes > maximumBytes && !overflowed) {
        overflowed = true;
        onOverflow();
      }
    },
    result() {
      return {
        bytes: Buffer.concat(chunks),
        observedBytes: bytes,
        overflowed,
      };
    },
  };
}

function signalChild(child, signal) {
  if (!child?.pid) return false;
  try {
    return child.kill(signal);
  } catch {
    return false;
  }
}

function parseWorkerResponse(bytes, operation) {
  const encoded = bytes.toString("utf8");
  if (encoded.length === 0 || encoded.trim() !== encoded) {
    throw subprocessFailure("The isolated PDF worker returned an invalid response frame.");
  }
  let response;
  try {
    response = JSON.parse(encoded);
  } catch (error) {
    throw subprocessFailure("The isolated PDF worker returned an invalid response.", error);
  }
  try {
    if (response?.status === "ok") {
      exactKeys(
        response,
        ["binary", "operation", "protocol_version", "result", "status"],
        "PDF.js worker response",
      );
      if (response.protocol_version !== PROTOCOL_VERSION || response.operation !== operation) {
        throw new TypeError("The worker response does not match the request.");
      }
      if (!response.result || typeof response.result !== "object" || Array.isArray(response.result)) {
        throw new TypeError("The worker result must be an object.");
      }
      if (response.binary !== null) {
        exactKeys(response.binary, ["bytes", "mime_type", "sha256"], "PDF.js worker binary");
        boundedInteger(response.binary.bytes, "worker binary bytes", 1, DEFAULT_MAX_BINARY_BYTES);
        if (
          !new Set(["image/png", "application/x-pdf-tools-rgba"])
            .has(response.binary.mime_type)
          || !/^[a-f0-9]{64}$/.test(response.binary.sha256)
        ) {
          throw new TypeError("The worker binary descriptor is invalid.");
        }
      }
      return { binary: response.binary, result: response.result };
    }
    if (response?.status === "error") {
      exactKeys(
        response,
        ["error", "operation", "protocol_version", "status"],
        "PDF.js worker error",
      );
      exactKeys(response.error, ["code", "message", "name"], "PDF.js worker error detail");
      if (response.protocol_version !== PROTOCOL_VERSION || response.operation !== operation) {
        throw new TypeError("The worker error does not match the request.");
      }
      const error = new Error(nonEmptyString(response.error.message, "worker error message", 4096));
      error.name = nonEmptyString(response.error.name, "worker error name", 256);
      error[WORKER_ERROR] = true;
      if (response.error.code !== null) {
        error.code = nonEmptyString(response.error.code, "worker error code", 256);
      }
      throw error;
    }
  } catch (error) {
    if (error?.[WORKER_ERROR]) throw error;
    throw subprocessFailure("The isolated PDF worker returned an invalid response shape.", error);
  }
  throw subprocessFailure("The isolated PDF worker returned an unknown response shape.");
}

function validateThreadMessage(message, operation, maxResultBytes, maxBinaryBytes) {
  try {
    exactKeys(message, ["binary", "frame"], "PDF.js thread response");
    const encoded = Buffer.from(JSON.stringify(message.frame), "utf8");
    if (encoded.length > maxResultBytes) {
      throw resourceLimitError("worker_output_limit");
    }
    const parsed = parseWorkerResponse(encoded, operation);
    const binaryBytes = message.binary === null ? Buffer.alloc(0) : Buffer.from(message.binary);
    return parsed.binary === null
      ? parsed.result
      : {
          ...parsed.result,
          binary: validateBinaryResult(
            binaryBytes,
            parsed.binary,
            parsed.result,
            maxBinaryBytes,
          ),
        };
  } catch (error) {
    if (error?.code === PDF_RESOURCE_LIMIT_CODE || error?.code === "PDFJS_SUBPROCESS_FAILED") {
      throw error;
    }
    throw subprocessFailure("The isolated PDF worker thread returned an invalid response.", error);
  }
}

function validateBinaryResult(binaryBytes, descriptor, result, maximumBytes) {
  if (descriptor === null) {
    if (binaryBytes.length !== 0) {
      throw subprocessFailure("The isolated PDF worker returned unexpected binary output.");
    }
    return null;
  }
  if (
    descriptor.bytes !== binaryBytes.length
    || binaryBytes.length > maximumBytes
    || createHash("sha256").update(binaryBytes).digest("hex") !== descriptor.sha256
  ) {
    throw subprocessFailure("The isolated PDF worker returned mismatched binary output.");
  }
  if (!Number.isSafeInteger(result.width) || !Number.isSafeInteger(result.height)) {
    throw subprocessFailure("The isolated PDF worker returned invalid binary dimensions.");
  }
  if (descriptor.mime_type === "application/x-pdf-tools-rgba") {
    if (binaryBytes.length !== result.width * result.height * 4) {
      throw subprocessFailure("The isolated PDF worker returned mismatched RGBA dimensions.");
    }
  } else {
    if (
      binaryBytes.length < 24
      || !binaryBytes.subarray(0, PNG_SIGNATURE.length).equals(PNG_SIGNATURE)
    ) {
      throw subprocessFailure("The isolated PDF worker returned invalid PNG output.");
    }
    const pngWidth = binaryBytes.readUInt32BE(16);
    const pngHeight = binaryBytes.readUInt32BE(20);
    if (result.width !== pngWidth || result.height !== pngHeight) {
      throw subprocessFailure("The isolated PDF worker returned mismatched PNG dimensions.");
    }
  }
  return Buffer.from(binaryBytes);
}

function looksLikeHeapExhaustion(stderr) {
  return /heap out of memory|allocation failed|fatal process out of memory|reached heap limit/i.test(
    stderr.toString("utf8"),
  );
}

function removeQueuedOperation(waiter) {
  const index = queuedOperations.indexOf(waiter);
  if (index >= 0) queuedOperations.splice(index, 1);
}

function releaseOperationSlot() {
  activeOperationCount = Math.max(0, activeOperationCount - 1);
  if (shutdownInProgress) return;
  while (queuedOperations.length > 0 && activeOperationCount < 1) {
    const waiter = queuedOperations.shift();
    if (waiter.settled) continue;
    waiter.settled = true;
    clearTimeout(waiter.timer);
    waiter.signal?.removeEventListener("abort", waiter.onAbort);
    activeOperationCount += 1;
    waiter.resolve(releaseOperationSlot);
  }
}

async function acquireOperationSlot(deadlineAt, signal) {
  if (signal?.aborted) throw abortError();
  if (shutdownInProgress) throw resourceLimitError("worker_shutdown_in_progress");
  if (activeOperationCount < 1) {
    activeOperationCount += 1;
    return releaseOperationSlot;
  }
  if (queuedOperations.length >= MAX_QUEUED_OPERATIONS) {
    throw resourceLimitError("worker_queue_limit");
  }
  return await new Promise((resolve, reject) => {
    const waiter = {
      onAbort: null,
      reject: null,
      resolve,
      settled: false,
      signal,
      timer: null,
    };
    const rejectWaiter = error => {
      if (waiter.settled) return;
      waiter.settled = true;
      clearTimeout(waiter.timer);
      removeQueuedOperation(waiter);
      signal?.removeEventListener("abort", waiter.onAbort);
      reject(error);
    };
    waiter.reject = rejectWaiter;
    waiter.onAbort = () => rejectWaiter(abortError());
    signal?.addEventListener("abort", waiter.onAbort, { once: true });
    waiter.timer = setTimeout(
      () => rejectWaiter(resourceLimitError("worker_queue_timeout")),
      Math.max(0, deadlineAt - Date.now()),
    );
    waiter.timer.unref();
    queuedOperations.push(waiter);
  });
}

async function runSpawnedWorker({
  environment,
  executable,
  maxBinaryBytes,
  maxOldSpaceMb,
  maxResultBytes,
  maxStderrBytes,
  operationDirectory,
  platform,
  request,
  requestBytes,
  signal,
  spawnProcess,
  timeoutMs,
  workerPath,
}) {
  return await new Promise((resolve, reject) => {
    let child;
    let settled = false;
    let timedOut = false;
    let aborted = false;
    let terminationStarted = false;
    let terminationTimer = null;
    let deadlineTimer = null;
    let spawnError = null;
    let exitCode = null;
    let exitSignal = null;
    let activeEntry = null;

    const terminate = reason => {
      if (!child || terminationStarted) return;
      terminationStarted = true;
      if (reason === "timeout") timedOut = true;
      if (reason === "abort") aborted = true;
      signalChild(child, "SIGTERM");
      terminationTimer = setTimeout(() => {
        signalChild(child, "SIGKILL");
      }, TERMINATION_GRACE_MS);
      terminationTimer.unref();
    };

    const stdout = boundedCollector(maxResultBytes, () => terminate("stdout"));
    const stderr = boundedCollector(maxStderrBytes, () => terminate("stderr"));
    const binary = boundedCollector(maxBinaryBytes, () => terminate("binary"));

    const finish = async () => {
      if (settled) return;
      settled = true;
      clearTimeout(deadlineTimer);
      clearTimeout(terminationTimer);
      signal?.removeEventListener?.("abort", onAbort);
      if (activeEntry) activeChildren.delete(activeEntry);

      const stdoutResult = stdout.result();
      const stderrResult = stderr.result();
      const binaryResult = binary.result();
      if (spawnError) {
        reject(subprocessFailure("The isolated PDF worker could not be started.", spawnError));
        return;
      }
      if (aborted) {
        reject(abortError());
        return;
      }
      if (timedOut) {
        reject(resourceLimitError("wall_timeout"));
        return;
      }
      if (stdoutResult.overflowed || stderrResult.overflowed || binaryResult.overflowed) {
        reject(resourceLimitError("worker_output_limit"));
        return;
      }
      if (exitSignal || looksLikeHeapExhaustion(stderrResult.bytes)) {
        reject(resourceLimitError("worker_memory_or_signal_limit"));
        return;
      }
      if (exitCode !== 0) {
        reject(subprocessFailure("The isolated PDF worker failed safely."));
        return;
      }
      try {
        const parsed = parseWorkerResponse(stdoutResult.bytes, request.operation);
        const validatedBinary = validateBinaryResult(
          binaryResult.bytes,
          parsed.binary,
          parsed.result,
          maxBinaryBytes,
        );
        resolve(validatedBinary === null
          ? parsed.result
          : { ...parsed.result, binary: validatedBinary });
      } catch (error) {
        reject(error);
      }
    };

    const onAbort = () => terminate("abort");

    try {
      child = spawnProcess(
        executable,
        [`--max-old-space-size=${maxOldSpaceMb}`, workerPath],
        {
          cwd: operationDirectory,
          // Stay in the enclosing host's process session. A detached worker can
          // evade host-level lifecycle and resource supervision on POSIX.
          detached: false,
          env: childEnvironment(environment, platform, operationDirectory),
          shell: false,
          stdio: ["pipe", "pipe", "pipe", "pipe"],
          windowsHide: true,
        },
      );
    } catch (error) {
      spawnError = error;
      void finish();
      return;
    }

    activeEntry = { child };
    activeChildren.add(activeEntry);
    child.once("error", error => {
      spawnError = error;
      if (!child.pid) queueMicrotask(() => void finish());
    });
    child.stdout.on("data", chunk => stdout.add(chunk));
    child.stderr.on("data", chunk => stderr.add(chunk));
    if (!child.stdio[3]) {
      spawnError = subprocessFailure("The isolated PDF worker binary channel is unavailable.");
      terminate("binary");
    } else {
      child.stdio[3].on("data", chunk => binary.add(chunk));
    }
    child.once("close", (code, signalName) => {
      exitCode = code;
      exitSignal = signalName;
      void finish();
    });
    child.stdin.on("error", error => {
      if (error?.code !== "EPIPE") spawnError = spawnError || error;
    });
    child.stdin.end(requestBytes);

    signal?.addEventListener?.("abort", onAbort, { once: true });
    deadlineTimer = setTimeout(() => terminate("timeout"), timeoutMs);
    deadlineTimer.unref();
  });
}

async function runThreadWorker({
  environment,
  maxBinaryBytes,
  maxOldSpaceMb,
  maxResultBytes,
  operationDirectory,
  platform,
  request,
  signal,
  spawnProcess,
  timeoutMs,
  workerClass,
  workerPath,
}) {
  return await new Promise((resolve, reject) => {
    let worker;
    let settled = false;
    let timedOut = false;
    let aborted = false;
    let response = null;
    let workerError = null;
    let deadlineTimer = null;
    let terminationPromise = null;
    let terminationStarted = false;
    const systemChildren = new Set();

    const terminateSystemChildren = async () => {
      await Promise.all([...systemChildren].map(async child => {
        let cleanupTimer;
        const closed = new Promise((resolve, reject) => {
          child.once("close", resolve);
          cleanupTimer = setTimeout(
            () => reject(resourceLimitError("system_renderer_cleanup_unproven")),
            TERMINATION_GRACE_MS,
          );
          cleanupTimer.unref();
        });
        signalChild(child, "SIGKILL");
        try {
          await closed;
        } finally {
          clearTimeout(cleanupTimer);
        }
      }));
    };

    const validateQuickLookRequest = async args => {
      try {
        if (
          args.length !== 6
          || args[0] !== "-t"
          || args[1] !== "-s"
          || !/^\d{1,5}$/.test(args[2])
          || Number(args[2]) < 1
          || Number(args[2]) > 8192
          || args[3] !== "-o"
          || basename(args[4]) === args[4]
          || basename(args[5]) !== "source.pdf"
          || !basename(args[4]).startsWith("pdf-tools-system-render-")
        ) {
          throw new Error("invalid Quick Look request shape");
        }
        const [
          canonicalOperationDirectory,
          canonicalOutputDirectory,
          canonicalSourcePath,
          outputStats,
          sourceStats,
        ] = await Promise.all([
          realpath(operationDirectory),
          realpath(args[4]),
          realpath(args[5]),
          lstat(args[4]),
          lstat(args[5]),
        ]);
        if (
          outputStats.isSymbolicLink()
          || !outputStats.isDirectory()
          || sourceStats.isSymbolicLink()
          || !sourceStats.isFile()
          || sourceStats.size < 1
          || sourceStats.size > 250 * 1024 * 1024
          || dirname(canonicalOutputDirectory) !== canonicalOperationDirectory
          || dirname(canonicalSourcePath) !== canonicalOutputDirectory
        ) {
          throw new Error("Quick Look paths leave the operation directory");
        }
      } catch {
        throw subprocessFailure(
          "The PDF.js worker requested an invalid Quick Look workspace.",
        );
      }
    };

    const validatePdfiumRenderRequest = async args => {
      try {
        const expectedDllPath = PDFIUM_DLL_PATHS.get(process.arch);
        if (
          args.length !== 5
          || expectedDllPath === undefined
          || args[0] !== expectedDllPath
          || basename(args[1]) !== "source.pdf"
          || !/^\d{1,5}$/.test(args[2])
          || Number(args[2]) < 1
          || Number(args[2]) > 8192
          || !/^\d{1,5}$/.test(args[3])
          || Number(args[3]) < 1
          || Number(args[3]) > 8192
          || basename(args[4]) !== "source.pdf.png"
        ) {
          throw new Error("invalid PDFium render request shape");
        }
        const [
          canonicalOperationDirectory,
          canonicalDllPath,
          canonicalSourcePath,
          dllStats,
          sourceStats,
          outputStats,
        ] = await Promise.all([
          realpath(operationDirectory),
          realpath(args[0]),
          realpath(args[1]),
          lstat(args[0]),
          lstat(args[1]),
          lstat(args[4]).catch(error => {
            if (error?.code === "ENOENT") return null;
            throw error;
          }),
        ]);
        if (
          canonicalDllPath !== expectedDllPath
          || dllStats.isSymbolicLink()
          || !dllStats.isFile()
          || sourceStats.isSymbolicLink()
          || !sourceStats.isFile()
          || sourceStats.size < 1
          || sourceStats.size > 250 * 1024 * 1024
          || dirname(canonicalSourcePath) !== canonicalOperationDirectory
          || dirname(args[4]) !== operationDirectory
          || (outputStats !== null && outputStats.isSymbolicLink())
        ) {
          throw new Error("PDFium render paths leave the operation directory");
        }
      } catch {
        throw subprocessFailure(
          "The PDF.js worker requested an invalid PDFium render workspace.",
        );
      }
    };

    const isWhitelistedSystemCommand = message => {
      if (platform === "darwin") {
        return new Set(["/usr/bin/qlmanage", "/usr/bin/sips"]).has(message.command);
      }
      if (platform === "win32") {
        return message.command === process.execPath
          && Array.isArray(message.args)
          && message.args[0] === PDFIUM_RENDER_HOST_PATH;
      }
      return false;
    };

    const runSystemCommand = async message => {
      exactKeys(
        message,
        ["args", "command", "id", "kind", "renderer_label", "timeout_ms"],
        "PDF.js system-command frame",
      );
      if (
        !isWhitelistedSystemCommand(message)
        || !Array.isArray(message.args)
        || message.args.length > 128
        || message.args.some(argument => typeof argument !== "string" || argument.length > 32_768)
      ) {
        throw subprocessFailure("The PDF.js worker requested an unsupported system command.");
      }
      const rendererLabel = SYSTEM_RENDERER_LABELS.has(message.renderer_label)
        ? message.renderer_label
        : "macOS";
      boundedInteger(message.id, "PDF.js system-command id", 1, 2 ** 31 - 1);
      boundedInteger(message.timeout_ms, "PDF.js system-command timeout", 100, 30_000);
      if (shutdownInProgress || terminationStarted) throw abortError();
      if (message.command === "/usr/bin/qlmanage") {
        await validateQuickLookRequest(message.args);
      }
      if (platform === "win32") {
        await validatePdfiumRenderRequest(message.args.slice(1));
      }
      if (shutdownInProgress || terminationStarted) throw abortError();
      if (systemChildren.size >= 1) {
        throw resourceLimitError("system_renderer_concurrency_limit");
      }
      return await new Promise((resolveCommand, rejectCommand) => {
        let child;
        let settled = false;
        let timedOut = false;
        let outputOverflow = false;
        let childError = null;
        let stdoutBytes = 0;
        let stderrBytes = 0;
        let deadline = null;
        const finishCommand = error => {
          if (settled) return;
          settled = true;
          clearTimeout(deadline);
          if (child) {
            systemChildren.delete(child);
            activeThreadSystemChildren.delete(child);
          }
          if (error) rejectCommand(error);
          else resolveCommand();
        };
        try {
          child = spawnProcess(message.command, message.args, {
            cwd: operationDirectory,
            detached: false,
            env: childEnvironment(environment, platform, operationDirectory),
            shell: false,
            stdio: ["ignore", "pipe", "pipe"],
            windowsHide: true,
          });
        } catch (error) {
          rejectCommand(error);
          return;
        }
        systemChildren.add(child);
        activeThreadSystemChildren.add(child);
        child.stdout.on("data", chunk => {
          stdoutBytes += chunk.length;
          if (stdoutBytes > DEFAULT_MAX_STDERR_BYTES) {
            outputOverflow = true;
            signalChild(child, "SIGKILL");
          }
        });
        child.stderr.on("data", chunk => {
          stderrBytes += chunk.length;
          if (stderrBytes > DEFAULT_MAX_STDERR_BYTES) {
            outputOverflow = true;
            signalChild(child, "SIGKILL");
          }
        });
        child.once("error", error => {
          childError = error;
          if (!child.pid) finishCommand(error);
          else signalChild(child, "SIGKILL");
        });
        child.once("close", (code, signalName) => {
          if (childError) {
            finishCommand(childError);
          } else if (timedOut) {
            finishCommand(resourceLimitError("system_renderer_timeout"));
          } else if (outputOverflow) {
            finishCommand(resourceLimitError("system_renderer_output_limit"));
          } else if (code !== 0 || signalName !== null) {
            finishCommand(subprocessFailure(`The ${rendererLabel} system PDF renderer could not render this page.`));
          } else {
            finishCommand(null);
          }
        });
        deadline = setTimeout(() => {
          timedOut = true;
          signalChild(child, "SIGKILL");
        }, message.timeout_ms);
        deadline.unref();
      });
    };

    const replyToSystemCommand = (id, status, error = null) => {
      try {
        worker.postMessage({
          kind: "system_command_result",
          id,
          status,
          error: error === null
            ? null
            : {
                name: typeof error?.name === "string" ? error.name.slice(0, 256) : "Error",
                code: typeof error?.code === "string" ? error.code.slice(0, 256) : null,
                message: typeof error?.message === "string"
                  ? error.message.slice(0, 4096)
                  : "The macOS system PDF renderer could not complete this operation.",
              },
        });
      } catch {}
    };

    const finish = async code => {
      if (settled) return;
      settled = true;
      clearTimeout(deadlineTimer);
      signal?.removeEventListener?.("abort", onAbort);
      if (worker) activeThreadWorkers.delete(worker);
      try {
        if (terminationPromise) {
          await terminationPromise;
        } else if (systemChildren.size > 0) {
          await terminateSystemChildren();
        }
      } catch (error) {
        reject(resourceLimitError("system_renderer_cleanup_unproven", error));
        return;
      }
      if (aborted) {
        reject(abortError());
        return;
      }
      if (timedOut) {
        reject(resourceLimitError("wall_timeout"));
        return;
      }
      if (workerError?.code === "PDFJS_SUBPROCESS_FAILED") {
        reject(workerError);
        return;
      }
      if (workerError || code !== 0 || response === null) {
        reject(resourceLimitError("worker_memory_or_signal_limit", workerError));
        return;
      }
      try {
        resolve(validateThreadMessage(
          response,
          request.operation,
          maxResultBytes,
          maxBinaryBytes,
        ));
      } catch (error) {
        reject(error);
      }
    };

    const terminate = reason => {
      if (!worker || terminationStarted) return;
      terminationStarted = true;
      if (reason === "timeout") timedOut = true;
      if (reason === "abort") aborted = true;
      terminationPromise = terminateSystemChildren()
        .finally(() => worker.terminate());
    };
    const onAbort = () => terminate("abort");

    try {
      worker = new workerClass(workerPath, {
        env: childEnvironment(environment, platform, operationDirectory),
        resourceLimits: {
          maxOldGenerationSizeMb: maxOldSpaceMb,
        },
        workerData: {
          pdf_tools_worker: "pdfjs",
          request,
        },
      });
      activeThreadWorkers.add(worker);
    } catch (error) {
      reject(subprocessFailure("The isolated PDF worker thread could not be started.", error));
      return;
    }
    worker.on("message", message => {
      try {
        if (message?.kind === "system_command") {
          const id = message.id;
          void runSystemCommand(message).then(
            () => replyToSystemCommand(id, "ok"),
            error => replyToSystemCommand(id, "error", error),
          );
          return;
        }
        exactKeys(message, ["kind", "response"], "PDF.js thread message");
        if (message.kind !== "response" || response !== null) {
          throw subprocessFailure("The isolated PDF worker thread returned an invalid response sequence.");
        }
        response = message.response;
      } catch (error) {
        workerError = error?.code === "PDFJS_SUBPROCESS_FAILED"
          ? error
          : subprocessFailure(
              "The isolated PDF worker thread returned an invalid control message.",
              error,
            );
        terminate("protocol");
      }
    });
    worker.once("messageerror", error => {
      workerError = subprocessFailure(
        "The isolated PDF worker thread returned an unreadable control message.",
        error,
      );
      terminate("protocol");
    });
    worker.once("error", error => {
      workerError = error;
    });
    worker.once("exit", code => {
      void finish(code);
    });
    signal?.addEventListener?.("abort", onAbort, { once: true });
    deadlineTimer = setTimeout(() => terminate("timeout"), timeoutMs);
    deadlineTimer.unref();
  });
}

async function loadInProcessWorkerModule() {
  inProcessWorkerModulePromise ??= import("./pdfjs-worker.js").then(worker => {
    worker.bindPdfjsWorkerSystemRendererControllerProbe(() => shutdownInProgress);
    worker.bindPdfjsWorkerNativeCanvasBlockReasonProbe(() => lastNativeCanvasBlockReason);
    inProcessWorkerModule = worker;
    return worker;
  });
  return await inProcessWorkerModulePromise;
}

// Native canvas inside an embedded (Electron) host.
//
// History, because the reasoning matters more than the switch. The block was
// inherited from the worker-thread path, and that one was itself precautionary:
// it came from an Electron documentation warning that loading native modules
// from a worker can crash the process, not from an observed crash. The one
// canvas failure actually measured was macOS-specific and was not a crash at all
// - ERR_DLOPEN_FAILED because the binding's code signature has a different Team
// ID from the host process (docs/CLAUDE_DESKTOP_TEST_RUN_2026-04-23.md:394).
// That has no Windows analogue.
//
// Blocking it is what leaves an embedded host with no renderer when there is no
// system fallback, which is the Windows shape. An earlier version of this
// comment claimed "the renderer policy already falls back to the system
// renderer, so an unsafe native attempt degrades rather than failing the call."
// That is FALSE off macOS: index.js's pdfjsRendererPolicy() returns bare
// "native" for every non-darwin platform, so on Windows and Linux there is
// nothing to degrade to.
//
// Measured 2026-08-06 on Windows 11 / Claude Desktop 1.25927.0, and independently
// in CI (run 31051499142, artifact windows-render-probe.json: block in force ->
// error, block lifted -> renderer "native-canvas"): with the block lifted the
// binding loads and renders, with no host instability observed.
//
// That is not enough on its own to trust a default, because the failure this
// guards against is a hard host crash that no in-process handler can catch. So
// the default stays OFF on every platform. What follows is the durable recovery
// a default would need, kept load-bearing for the opt-in users who are the only
// available source of the soak evidence a flip requires.
//
// A win32 default was implemented and reverted once. The adversarial review that
// killed it found the crash-survival latch cleared its marker the moment dlopen
// returned, so it covered only the link step - the one step two positive
// datapoints already existed for. The instability this guards against, in a
// Chromium process that already has its own Skia, characteristically appears at
// first draw. The mechanism also had no ownership, so two servers sharing one
// home directory could erase each other's in-flight marker, and concurrency was
// the exact condition named publicly on issue #42 as a prerequisite for
// flipping. Both defects are addressed below.

// Platforms where native canvas is ON by default inside an embedded host.
// EMPTY ON PURPOSE. This array is the switch; adding "win32" is the whole flip,
// and it must not be added until every gate is met:
//
//   [MET 2026-08-11] >= 20 renders across page sizes on a real Windows Claude
//     Desktop with no host crash. 23 renders, 12 page sizes, two rotations.
//   [MET 2026-08-11] isolation observed as in-process. Not by reading a log
//     line - the flag A/B changes the outcome (=1 renders, =0 returns the typed
//     unavailable error), and the guard only exists on the in-process path.
//   [MET 2026-08-11] the latch observed latching after a real host crash: the
//     process was hard-killed mid-draw, the marker survived, and the restart
//     refused with the remediation text.
//   [OPEN] a genuinely concurrent pair on a real host. The chat surface
//     serialises tool calls and cannot batch two calls to one tool in a turn, so
//     this has only been proven process-to-process in tests, not host-side.
//
// macOS is excluded, and this is a decision rather than a missing measurement:
// largest installed base, a working system-renderer fallback it can degrade to,
// and the only platform with an observed canvas-attributed failure. Do not add
// "darwin" here without new evidence that overturns that.
//
// Linux is not a criterion. There is no embedded Electron host to measure it on,
// so waiting for a Linux datapoint would be waiting for something nobody intends
// to produce. It stays off by absence, not by pending judgement.
const NATIVE_CANVAS_DEFAULT_PLATFORMS = [];

// Marker phases. Both mean "a process entered a window it might not return
// from"; they differ only in which window, which is worth recording because it
// is the first thing anyone debugging a latched install will want to know.
const NATIVE_CANVAS_PHASE_LINKING = "linking";
const NATIVE_CANVAS_PHASE_DRAWING = "drawing";

// Where the crash-survival marker lives. Mirrors index.js's PROFILES_DIR so it
// sits with the rest of this server's durable state. An unsubstituted manifest
// template is treated as absent rather than creating a directory named "${...}".
export function nativeCanvasMarkerPath(env = process.env) {
  const configured = typeof env.DEFAULT_PROFILES_DIR === "string"
    && env.DEFAULT_PROFILES_DIR
    && !env.DEFAULT_PROFILES_DIR.includes("${")
    ? env.DEFAULT_PROFILES_DIR
    : join(homedir(), ".pdf-toolkit-files");
  return join(configured, "native-canvas-attempt.json");
}

function nativeCanvasMarkerPayload(phase, token) {
  return JSON.stringify({
    phase,
    token,
    pid: process.pid,
    attempted_at: new Date().toISOString(),
    platform: process.platform,
    arch: process.arch,
  });
}

// Create the marker, and fail if one already exists.
//
// This is what closes the race between reading the latch state and writing the
// marker. Two servers sharing a home directory can both read "clear" before
// either has written, and the previous version simply let the second overwrite
// the first. That mattered: if the first then crashed mid-draw, the surviving
// marker carried the second's token and a live pid, so the crash read as
// `concurrent` rather than `latched` and went uncaught. With an exclusive
// create only one process can win, and the loser refuses instead of erasing a
// marker whose owner may be about to die under it.
//
// A plain truncating create is correct HERE, unlike the phase advance. The file
// is new, so a crash mid-write leaves a zero-length marker, and empty correctly
// reads as "no marker" - at this point dlopen has not run and nothing needs
// latching. The advance cannot use this, because it is replacing a marker that
// is already load-bearing.
// The caller creates the directory first. Keeping mkdir out of here matters:
// mkdirSync also raises EEXIST when a path component is a plain file, and this
// function's EEXIST must mean one thing only - another process owns the marker.
function createNativeCanvasMarker(markerPath, phase, token) {
  const handle = openSync(markerPath, "wx");
  try {
    writeFileSync(handle, nativeCanvasMarkerPayload(phase, token));
    fsyncSync(handle);
  } finally {
    closeSync(handle);
  }
}

// Replace an existing marker atomically, for the phase advance.
//
// Truncating in place is not survivable here. `openSync(path, "w")` empties the
// file immediately, so a host that hard-crashes between the truncate and the
// completed write leaves a zero-length marker - and an empty marker reads as
// "no marker". The advance destroys a valid `linking` marker in order to write
// `drawing`, and a crash inside that window is exactly the link-to-first-draw
// crash this whole mechanism exists to catch. Renaming is atomic, so what is on
// disk is always either the previous valid marker or the new one.
function replaceNativeCanvasMarker(markerPath, phase, token) {
  mkdirSync(dirname(markerPath), { recursive: true });
  const tempPath = `${markerPath}.${process.pid}.${token.slice(0, 8)}.tmp`;
  const handle = openSync(tempPath, "w");
  try {
    writeFileSync(handle, nativeCanvasMarkerPayload(phase, token));
    // fsync the contents before the rename, otherwise the rename can land while
    // the bytes are still only in the page cache.
    fsyncSync(handle);
  } finally {
    closeSync(handle);
  }
  // If the write above threw, this is never reached and the temp file is left
  // behind. That is inert: nothing ever reads a `.tmp` path, and the caller
  // treats the throw as "could not advance" and leaves the linking marker, which
  // still latches.
  renameSync(tempPath, markerPath);
}

function processIsAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    // EPERM means the pid exists but belongs to another user, which is still
    // alive for our purposes.
    return error?.code === "EPERM";
  }
}

// "clear"      - no evidence of an unfinished attempt; proceed.
// "latched"    - a previous process armed a marker and never came back. Refuse,
//                durably, until an operator intervenes.
// "concurrent" - another *live* process is mid-attempt. Refuse this load, but do
//                not treat it as a crash: nothing has died.
//
// The one imprecision worth naming: if a crashed process's pid has since been
// reused by an unrelated live process, this reports "concurrent" rather than
// "latched". That still refuses the load, and the next boot with that pid gone
// latches correctly. It fails toward retryable rather than toward loading.
export function nativeCanvasLatchState(markerPath = nativeCanvasMarkerPath()) {
  let raw;
  try {
    raw = readFileSync(markerPath, "utf8");
  } catch {
    return "clear";
  }
  if (raw.trim() === "") return "clear";
  let record;
  try {
    record = JSON.parse(raw);
  } catch {
    // An unparseable marker is still evidence that some process armed one and
    // did not clean up. Treat it as a latch rather than reasoning past it.
    return "latched";
  }
  if (
    record?.phase !== NATIVE_CANVAS_PHASE_LINKING
    && record?.phase !== NATIVE_CANVAS_PHASE_DRAWING
  ) {
    return "latched";
  }
  // Our own in-flight attempt, re-entered. Not a latch, and not a competitor.
  if (activeNativeCanvasAttempt && record.token === activeNativeCanvasAttempt.token) {
    return "clear";
  }
  return processIsAlive(record.pid) ? "concurrent" : "latched";
}

// Returns "armed", "contended" (someone else holds the marker), or "unwritable".
//
// `force` exists to recover a latched install, and the latch it overrides IS a
// marker on disk. Without removing it first the exclusive create below would
// refuse and =force could not force anything, which would leave a crashed
// install with no way back short of deleting state by hand.
export function armNativeCanvasAttempt(markerPath, { force = false } = {}) {
  if (force) {
    try {
      rmSync(markerPath, { force: true });
    } catch {
      // If it cannot be removed the create below fails and reports contended,
      // which is the honest outcome.
    }
  }
  // Re-entry, not contention. This process may load the binding more than once
  // before the triggering request settles, and its own in-flight marker must not
  // be mistaken for a competitor's - the exclusive create below would otherwise
  // refuse us our own file.
  const existing = activeNativeCanvasAttempt;
  if (existing && existing.markerPath === markerPath && !force) return "armed";

  try {
    mkdirSync(dirname(markerPath), { recursive: true });
  } catch {
    activeNativeCanvasAttempt = null;
    return "unwritable";
  }
  const token = randomBytes(16).toString("hex");
  try {
    createNativeCanvasMarker(markerPath, NATIVE_CANVAS_PHASE_LINKING, token);
    activeNativeCanvasAttempt = { markerPath, token };
    return "armed";
  } catch (error) {
    // If the marker cannot be written, a crash cannot be detected, so the load
    // must not be attempted at all. Failing closed is the point of the exercise.
    activeNativeCanvasAttempt = null;
    return error?.code === "EEXIST" ? "contended" : "unwritable";
  }
}

function advanceNativeCanvasAttempt(phase) {
  const attempt = activeNativeCanvasAttempt;
  if (!attempt) return;
  try {
    replaceNativeCanvasMarker(attempt.markerPath, phase, attempt.token);
  } catch {
    // The linking-phase marker is still on disk and still attributable to this
    // process, so a crash from here is still caught. Nothing to recover.
  }
}

function clearNativeCanvasAttempt() {
  const attempt = activeNativeCanvasAttempt;
  if (!attempt) return;
  activeNativeCanvasAttempt = null;
  let record;
  try {
    record = JSON.parse(readFileSync(attempt.markerPath, "utf8"));
  } catch {
    // Gone, or unreadable. If it is unreadable it may belong to someone else,
    // so leave it: a stale marker costs a conservative latch, erasing another
    // process's in-flight marker costs a missed crash.
    return;
  }
  if (record?.token !== attempt.token) return;
  try {
    rmSync(attempt.markerPath, { force: true });
  } catch {
    // A stale marker only costs a conservative latch on the next boot.
  }
}

// Called when the request that triggered a native-canvas load has completed,
// either way. Completion means this process survived both the link and the first
// draw, which is the entire window the marker exists to cover.
//
// It does not cover teardown. Covering teardown would mean holding the marker to
// process exit, which cannot distinguish a canvas-attributed crash from a user
// force-quitting the host - and force-quit is common enough that it would latch
// off nearly every install. That limit is real and is not claimed away.
export function settleNativeCanvasAttempt() {
  clearNativeCanvasAttempt();
}

// Policy, in order:
//   PDF_TOOLS_EMBEDDED_NATIVE_CANVAS=0      always blocks (kill switch)
//   PDF_TOOLS_EMBEDDED_NATIVE_CANVAS=force  always allows, bypassing the latch,
//                                           so a latched install can be
//                                           recovered without deleting state by
//                                           hand
//   PDF_TOOLS_EMBEDDED_NATIVE_CANVAS=1      opt in, still subject to the latch
//   platform in NATIVE_CANVAS_DEFAULT_PLATFORMS   same, and currently never
//   everything else                         blocks
//
// "=1" deliberately respects the latch. In the reverted design the flag bypassed
// it, which left the entire mechanism dead code for as long as the default was
// off - it could only ever run on a population that did not yet exist. Binding
// the flag to the latch instead means today's Windows opt-in users exercise the
// recovery path, which is where the evidence for a future flip has to come from.
export function embeddedNativeCanvasAllowed({
  env = process.env,
  platform = process.platform,
  markerPath = null,
} = {}) {
  const override = env.PDF_TOOLS_EMBEDDED_NATIVE_CANVAS;
  if (override === "0") return false;
  if (override === "force") return true;
  const requested = override === "1"
    || NATIVE_CANVAS_DEFAULT_PLATFORMS.includes(platform);
  if (!requested) return false;
  return nativeCanvasLatchState(markerPath ?? nativeCanvasMarkerPath(env)) === "clear";
}

// The reason a load was refused, for the renderer error path to turn into
// remediation the user can act on. Null when nothing has been refused.
export function nativeCanvasBlockReason() {
  return lastNativeCanvasBlockReason;
}

function refuseNativeCanvasLoad(reason) {
  lastNativeCanvasBlockReason = reason;
  const error = new Error(
    "The native canvas binding is disabled in this embedded PDF host.",
  );
  error.code = "PDFJS_EMBEDDED_NATIVE_CANVAS_DISABLED";
  return error;
}

function installInProcessCanvasNativeGuard({ dlopen = null } = {}) {
  if (inProcessCanvasGuardInstalled) return;
  inProcessCanvasGuardInstalled = true;
  // Installed unconditionally, unlike the previous version which returned early
  // when canvas was allowed. The guard is no longer only a blocker: on an
  // allowed load it is what arms and phases the crash marker, so skipping it
  // when allowed would skip the entire recovery mechanism.
  const originalDlopen = dlopen ?? process.dlopen;
  process.dlopen = function guardedDlopen(module, filename, ...args) {
    const normalizedFilename = String(filename ?? "").replaceAll("\\", "/");
    const isNativeCanvas = normalizedFilename.includes("/node_modules/@napi-rs/canvas")
      || /\/skia\.[^/]+\.node$/i.test(normalizedFilename);
    if (!isNativeCanvas) {
      return originalDlopen.call(this, module, filename, ...args);
    }

    // Re-evaluated per load rather than cached at install time, so a latch
    // written by a previous boot is honoured and an operator override takes
    // effect without a restart of this code path.
    const markerPath = nativeCanvasMarkerPath();
    const latchState = nativeCanvasLatchState(markerPath);
    if (!embeddedNativeCanvasAllowed({ markerPath })) {
      throw refuseNativeCanvasLoad(
        latchState === "clear" ? "disabled_by_policy" : latchState,
      );
    }
    // Arming is exclusive, so it can lose to another server that armed between
    // the latch read above and this line. Losing is reported as contention, not
    // as a crash: nothing has died, and the next attempt may well win.
    const armed = armNativeCanvasAttempt(markerPath, {
      force: process.env.PDF_TOOLS_EMBEDDED_NATIVE_CANVAS === "force",
    });
    if (armed !== "armed") {
      throw refuseNativeCanvasLoad(armed === "contended" ? "concurrent" : "marker_unwritable");
    }

    lastNativeCanvasBlockReason = null;
    try {
      const loaded = originalDlopen.call(this, module, filename, ...args);
      // The link survived. The remaining exposure is the first draw, so the
      // marker stays on disk and only changes phase. settleNativeCanvasAttempt()
      // clears it once the request that triggered this load completes.
      advanceNativeCanvasAttempt(NATIVE_CANVAS_PHASE_DRAWING);
      return loaded;
    } catch (error) {
      // A raised error is survival: the host is intact, so this must not latch
      // and permanently disable a recoverable environment problem such as a
      // missing VC++ runtime or an architecture mismatch.
      clearNativeCanvasAttempt();
      throw error;
    }
  };
}

// Test seam. The guard rewrites process.dlopen, which is process-global and
// installed once, so a suite cannot exercise it without a way to inject a fake
// loader and put the real one back.
export function __installCanvasGuardForTest({ dlopen }) {
  inProcessCanvasGuardInstalled = false;
  activeNativeCanvasAttempt = null;
  lastNativeCanvasBlockReason = null;
  const savedDlopen = process.dlopen;
  installInProcessCanvasNativeGuard({ dlopen });
  const guarded = process.dlopen;
  return {
    guardedDlopen: guarded,
    restore() {
      process.dlopen = savedDlopen;
      inProcessCanvasGuardInstalled = false;
      activeNativeCanvasAttempt = null;
      lastNativeCanvasBlockReason = null;
    },
  };
}

async function runInProcessWorker({
  maxBinaryBytes,
  maxResultBytes,
  request,
  signal,
}) {
  // Both isolated PDF.js paths were measured to crash Claude's embedded
  // UtilityProcess. Its process.execPath is Claude Helper (Plugin) rather than
  // a Node binary, so relaunching it produced SIGTRAP helper crashes, and
  // ELECTRON_RUN_AS_NODE=1 exited 133 on a direct probe. The Node worker-thread
  // fallback made Electron create a helper process and crash as well, which is
  // specific to this library's native-canvas probe and browser-like runtime
  // classification. It is NOT a general claim that the host cannot create a
  // Node worker: PDF-lib keeps a worker_thread boundary on this same host and
  // has completed live rotate, merge, and split mutations there.
  //
  // This compatibility path retains source binding, allowed-directory checks,
  // request, path, queue, output, and binary bounds, native-canvas blocking,
  // and macOS system-child reaping. It is not a separate heap or process
  // boundary and cannot forcibly stop synchronous parser work.
  if (signal?.aborted) throw abortError();
  installInProcessCanvasNativeGuard();
  const workerModule = await loadInProcessWorkerModule();
  if (shutdownInProgress) throw resourceLimitError("worker_shutdown_in_progress");
  let operationResult;
  try {
    operationResult = await workerModule.executePdfjsWorkerRequest(request);
  } finally {
    // The request that triggered any native-canvas load has now completed, one
    // way or the other. Either outcome means this process survived the link and
    // the first draw, so the crash marker has done its job and comes off. A
    // thrown error is survival too: the host is intact enough to report it.
    settleNativeCanvasAttempt();
  }
  if (signal?.aborted) throw abortError();
  const encodedResult = Buffer.from(JSON.stringify(operationResult.result), "utf8");
  if (encodedResult.length > maxResultBytes) {
    throw resourceLimitError("worker_output_limit");
  }
  if (operationResult.binary === null) return operationResult.result;
  const binary = Buffer.from(operationResult.binary);
  const descriptor = {
    bytes: binary.length,
    mime_type: request.operation === "render_comparison_page"
      ? "application/x-pdf-tools-rgba"
      : "image/png",
    sha256: createHash("sha256").update(binary).digest("hex"),
  };
  return {
    ...operationResult.result,
    binary: validateBinaryResult(
      binary,
      descriptor,
      operationResult.result,
      maxBinaryBytes,
    ),
  };
}

export async function runPdfjsSubprocess(request, {
  timeoutMs = DEFAULT_TIMEOUT_MS,
  maxResultBytes = DEFAULT_MAX_RESULT_BYTES,
  maxBinaryBytes = DEFAULT_MAX_BINARY_BYTES,
  maxStderrBytes = DEFAULT_MAX_STDERR_BYTES,
  maxOldSpaceMb = DEFAULT_MAX_OLD_SPACE_MB,
  workerPath = fileURLToPath(new URL("./pdfjs-worker.js", import.meta.url)),
  executable = process.execPath,
  environment = process.env,
  platform = process.platform,
  spawnProcess = spawn,
  isolationMode = DEFAULT_ISOLATION_MODE,
  workerClass = Worker,
  beforeSpawn = null,
  removeOperationDirectory = rm,
  signal = null,
} = {}) {
  const requestBytes = validateRequest(request);
  boundedInteger(timeoutMs, "timeoutMs", 100, 5 * 60_000);
  boundedInteger(maxResultBytes, "maxResultBytes", 1024, 64 * 1024 * 1024);
  boundedInteger(maxBinaryBytes, "maxBinaryBytes", 1024, DEFAULT_MAX_BINARY_BYTES);
  boundedInteger(maxStderrBytes, "maxStderrBytes", 1024, 1024 * 1024);
  boundedInteger(maxOldSpaceMb, "maxOldSpaceMb", 64, 4096);
  nonEmptyString(workerPath, "workerPath");
  nonEmptyString(executable, "executable");
  if (beforeSpawn !== null && typeof beforeSpawn !== "function") {
    throw new TypeError("beforeSpawn must be a function or null.");
  }
  if (typeof removeOperationDirectory !== "function") {
    throw new TypeError("removeOperationDirectory must be a function.");
  }
  if (!["in_process", "subprocess", "worker_thread"].includes(isolationMode)) {
    throw new TypeError("isolationMode must be in_process, subprocess, or worker_thread.");
  }
  if (shutdownInProgress) throw resourceLimitError("worker_shutdown_in_progress");

  const deadlineAt = Date.now() + timeoutMs;
  let settleOperation;
  const operationSettlement = new Promise(resolve => {
    settleOperation = resolve;
  });
  activeOperations.add(operationSettlement);
  let releaseSlot = null;
  let operationDirectory = null;
  let operationError = null;
  let result;
  try {
    releaseSlot = await acquireOperationSlot(deadlineAt, signal);
    if (shutdownInProgress) throw resourceLimitError("worker_shutdown_in_progress");
    operationDirectory = await mkdtemp(join(tmpdir(), "pdf-tools-pdfjs-"));
    await chmod(operationDirectory, 0o700);
    if (shutdownInProgress) throw resourceLimitError("worker_shutdown_in_progress");
    if (signal?.aborted) throw abortError();
    if (beforeSpawn !== null) await beforeSpawn();
    if (shutdownInProgress) throw resourceLimitError("worker_shutdown_in_progress");
    if (signal?.aborted) throw abortError();
    const remainingMs = deadlineAt - Date.now();
    if (remainingMs < 100) throw resourceLimitError("worker_queue_timeout");
    result = isolationMode === "in_process"
      ? await runInProcessWorker({
          maxBinaryBytes,
          maxResultBytes,
          request,
          signal,
        })
      : isolationMode === "worker_thread"
        ? await runThreadWorker({
          environment,
          maxBinaryBytes,
          maxOldSpaceMb,
          maxResultBytes,
          operationDirectory,
          platform,
          request,
          signal,
          spawnProcess,
          timeoutMs: remainingMs,
          workerClass,
          workerPath,
        })
      : await runSpawnedWorker({
          environment,
          executable,
          maxBinaryBytes,
          maxOldSpaceMb,
          maxResultBytes,
          maxStderrBytes,
          operationDirectory,
          platform,
          request,
          requestBytes,
          signal,
          spawnProcess,
          timeoutMs: remainingMs,
          workerPath,
        });
  } catch (error) {
    operationError = error;
  }

  let cleanupError = null;
  if (operationDirectory !== null) {
    try {
      await removeOperationDirectory(operationDirectory, { force: true, recursive: true });
    } catch (error) {
      cleanupError = error;
    }
  }
  if (releaseSlot !== null) releaseSlot();
  const finalCleanupError = cleanupError
    ? resourceLimitError("operation_directory_cleanup_unproven", cleanupError)
    : null;
  activeOperations.delete(operationSettlement);
  settleOperation(finalCleanupError);
  if (finalCleanupError) throw finalCleanupError;
  if (operationError) throw operationError;
  return result;
}

export function createPdfjsSubprocessRequest({
  operation,
  source,
  options = {},
  password = null,
  allowedDirectories,
}) {
  const request = {
    protocol_version: PROTOCOL_VERSION,
    operation,
    source,
    password,
    options,
    allowed_directories: allowedDirectories,
  };
  validateRequest(request);
  return request;
}

function terminateTrackedChild(child) {
  return new Promise(resolve => {
    if (child.exitCode !== null || child.signalCode !== null) {
      resolve();
      return;
    }
    const escalation = setTimeout(
      () => signalChild(child, "SIGKILL"),
      TERMINATION_GRACE_MS,
    );
    escalation.unref();
    child.once("close", () => {
      clearTimeout(escalation);
      resolve();
    });
    signalChild(child, "SIGTERM");
  });
}

export async function settleAllShutdownOperations(operations) {
  if (
    !Array.isArray(operations)
    || operations.some(operation => operation === null || typeof operation?.then !== "function")
  ) {
    throw new TypeError("shutdown operations must be promises.");
  }
  const settled = await Promise.allSettled(operations);
  const failure = settled.find(outcome => outcome.status === "rejected")?.reason ?? null;
  if (failure !== null) throw failure;
}

function poisonPdfjsShutdown() {
  shutdownTerminal = true;
  shutdownInProgress = true;
  if (inProcessWorkerModule !== null) {
    inProcessWorkerModule.poisonPdfjsWorkerSystemRenderer();
  } else if (inProcessWorkerModulePromise !== null) {
    void inProcessWorkerModulePromise.then(
      worker => worker.poisonPdfjsWorkerSystemRenderer(),
      () => {},
    );
  }
}

export function terminateAllPdfjsSubprocesses({
  reopenAfterSuccessfulDrain = false,
  shutdownTimeoutMs = OPERATION_SHUTDOWN_TIMEOUT_MS,
} = {}) {
  if (typeof reopenAfterSuccessfulDrain !== "boolean") {
    throw new TypeError("reopenAfterSuccessfulDrain must be a boolean.");
  }
  boundedInteger(shutdownTimeoutMs, "shutdownTimeoutMs", 1, 60_000);
  if (!reopenAfterSuccessfulDrain) poisonPdfjsShutdown();
  if (gracefulShutdownPromise !== null) return gracefulShutdownPromise;
  if (shutdownTerminal && reopenAfterSuccessfulDrain) {
    return Promise.reject(resourceLimitError("worker_shutdown_terminal"));
  }
  shutdownInProgress = true;
  const shutdownError = resourceLimitError("worker_shutdown_in_progress");
  for (const waiter of [...queuedOperations]) waiter.reject(shutdownError);
  const operations = [...activeOperations];
  const childTerminations = [...activeChildren]
    .map(({ child }) => terminateTrackedChild(child));
  const threadTerminations = [...activeThreadWorkers]
    .map(worker => Promise.resolve().then(() => worker.terminate()));
  const threadChildTerminations = [...activeThreadSystemChildren]
    .map(child => terminateTrackedChild(child));
  let inProcessWorkerAtShutdown = null;
  let inProcessTermination = [];
  if (inProcessWorkerModule !== null) {
    inProcessWorkerAtShutdown = Promise.resolve(inProcessWorkerModule);
    inProcessTermination = [inProcessWorkerModule.beginPdfjsWorkerSystemShutdown({
      terminal: shutdownTerminal,
    })];
  } else if (inProcessWorkerModulePromise !== null) {
    inProcessWorkerAtShutdown = inProcessWorkerModulePromise;
    inProcessTermination = [inProcessWorkerModulePromise.then(
      worker => worker.beginPdfjsWorkerSystemShutdown({ terminal: shutdownTerminal }),
    )];
  }
  gracefulShutdownPromise = (async () => {
    let timer;
    try {
      const timeout = new Promise((_, reject) => {
        timer = setTimeout(
          () => reject(resourceLimitError("worker_shutdown_timeout")),
          shutdownTimeoutMs,
        );
        timer.unref();
      });
      const settled = await Promise.race([
        Promise.allSettled([
          ...childTerminations,
          ...threadTerminations,
          ...threadChildTerminations,
          ...inProcessTermination,
          ...operations,
        ]),
        timeout,
      ]);
      const failure = settled.find(outcome => outcome.status === "rejected")?.reason
        ?? settled.find(outcome => outcome.status === "fulfilled" && outcome.value instanceof Error)
          ?.value
        ?? null;
      if (failure !== null) throw failure;
      if (reopenAfterSuccessfulDrain && shutdownTerminal) {
        throw resourceLimitError("worker_shutdown_terminal");
      }
      if (reopenAfterSuccessfulDrain) {
        if (activeOperations.size !== 0 || queuedOperations.length !== 0) {
          throw resourceLimitError("worker_shutdown_incomplete");
        }
        shutdownInProgress = false;
        if (inProcessWorkerAtShutdown !== null) {
          inProcessWorkerModule.reopenPdfjsWorkerSystemRenderer();
        }
      }
    } catch (error) {
      poisonPdfjsShutdown();
      throw error;
    } finally {
      clearTimeout(timer);
      gracefulShutdownPromise = null;
    }
  })();
  return gracefulShutdownPromise;
}

export function forceTerminateAllPdfjsSubprocesses() {
  poisonPdfjsShutdown();
  for (const { child } of activeChildren) {
    signalChild(child, "SIGKILL");
  }
  for (const worker of activeThreadWorkers) {
    void worker.terminate();
  }
  for (const child of activeThreadSystemChildren) {
    signalChild(child, "SIGKILL");
  }
  if (inProcessWorkerModulePromise !== null) {
    void inProcessWorkerModulePromise.then(
      worker => worker.forceTerminateAllPdfjsWorkerSystemChildren(),
      () => {},
    );
  }
}
