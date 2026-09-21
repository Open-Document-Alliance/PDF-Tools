import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import {
  PDF_CONCURRENT_MODIFICATION_CODE,
  PDF_RESOURCE_LIMIT_CODE,
  createPdfLibInspectionRequest,
  runPdfLibInspection,
  runPdfLibMutation,
  terminateAllPdfLibMutations,
  terminateAllPdfLibOperations,
} from "../server/pdf-lib-subprocess.js";
import {
  executePdfLibMutationRequest,
  executePdfLibOperationRequest,
} from "../server/pdf-lib-worker.js";
import { inspectPdfAccessibilityBytes } from "../server/accessibility-inspection.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, "..");
const SCREEN_PASS_FIXTURE = path.join(
  REPO_ROOT,
  "test/fixtures/eval/accessibility/synthetic/screen-pass-not-conformance.pdf",
);
const ENCRYPTED_FIXTURE = path.join(
  REPO_ROOT,
  "test/fixtures/golden-forms/encrypted-rotated-signature.pdf",
);
const roots = [];

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

async function rootDirectory(prefix = "pdf-tools-accessibility-worker-") {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), prefix)));
  roots.push(root);
  return root;
}

async function sourceBinding(bytes, name = "source.pdf") {
  const root = await rootDirectory();
  const sourcePath = path.join(root, name);
  await fs.writeFile(sourcePath, bytes, { mode: 0o600 });
  const stats = await fs.lstat(sourcePath, { bigint: true });
  return {
    root,
    sourcePath,
    source: {
      canonical_path: sourcePath,
      file_identity: { device: String(stats.dev), inode: String(stats.ino) },
      size_bytes: bytes.length,
      sha256: sha256(bytes),
    },
  };
}

async function directRequest(bytes) {
  const fixture = await sourceBinding(bytes);
  const stageDirectory = path.join(fixture.root, "stage");
  await fs.mkdir(stageDirectory, { mode: 0o700 });
  return {
    ...fixture,
    stageDirectory,
    request: {
      protocol_version: 1,
      operation: "inspect_pdf_accessibility",
      sources: [fixture.source],
      password: null,
      options: {},
      force_xfa: false,
      stage_directory: stageDirectory,
    },
  };
}

function monitoredWorker(source) {
  const monitorUrl = pathToFileURL(
    path.join(REPO_ROOT, "server/pdf-lib-rss-monitor.js"),
  ).href;
  return `
import { startPdfLibRssMonitor } from ${JSON.stringify(monitorUrl)};
const monitor = startPdfLibRssMonitor();
${source}
`;
}

async function workerScript(source) {
  const root = await rootDirectory("pdf-tools-accessibility-mock-worker-");
  const workerPath = path.join(root, "worker.mjs");
  await fs.writeFile(workerPath, monitoredWorker(source), { mode: 0o600 });
  return workerPath;
}

function successResponseScript(result, extra = "") {
  return `
const chunks = [];
for await (const chunk of process.stdin) chunks.push(chunk);
const request = JSON.parse(Buffer.concat(chunks).toString("utf8"));
${extra}
process.stdout.write(JSON.stringify({
  protocol_version: 1,
  operation: request.operation,
  status: "ok",
  manifest: [],
  result: ${JSON.stringify(result)},
}));
await monitor.stop();
`;
}

afterEach(async () => {
  await terminateAllPdfLibOperations();
  await Promise.all(roots.splice(0).map(root => fs.rm(root, { recursive: true, force: true })));
});

describe("isolated read-only PDF-lib accessibility operation", () => {
  it("constructs one strict source-bound request with no password or options authority", async () => {
    const bytes = await fs.readFile(SCREEN_PASS_FIXTURE);
    const { source } = await sourceBinding(bytes);
    expect(createPdfLibInspectionRequest({
      operation: "inspect_pdf_accessibility",
      sources: [source],
    })).toEqual({
      operation: "inspect_pdf_accessibility",
      sources: [source],
      options: {},
      password: null,
      // A read-only inspection never forces past the XFA guard; it carries
      // the field so the request shape is one shape, not two.
      force_xfa: false,
    });
    for (const request of [
      { operation: "inspect_pdf_accessibility", sources: [source], password: "secret" },
      { operation: "inspect_pdf_accessibility", sources: [source], options: {} },
      { operation: "rotate_pdf_pages", sources: [source] },
      { operation: "inspect_pdf_accessibility", sources: [] },
      { operation: "inspect_pdf_accessibility", sources: [source, source] },
    ]) {
      expect(() => createPdfLibInspectionRequest(request)).toThrow();
    }
  });

  it("executes with an empty manifest and cannot be entered through the mutation wrapper", async () => {
    const bytes = await fs.readFile(SCREEN_PASS_FIXTURE);
    const { request, stageDirectory } = await directRequest(bytes);
    const response = await executePdfLibOperationRequest(request);

    expect(response.status).toBe("ok");
    expect(response.operation).toBe("inspect_pdf_accessibility");
    expect(response.manifest).toEqual([]);
    expect(await fs.readdir(stageDirectory)).toEqual([]);
    expect(response.result.result).toBe("no_findings_detected");
    await expect(executePdfLibMutationRequest(request)).rejects.toThrow(
      "Read-only inspection is not a mutation request.",
    );
    await expect(executePdfLibOperationRequest({
      ...request,
      password: "not-authorized",
    })).rejects.toThrow("does not accept a password");
    await expect(executePdfLibOperationRequest({
      ...request,
      options: { unexpected: true },
    })).rejects.toThrow("options has an invalid shape");
  });

  it("runs in a subprocess and worker thread while preserving source bytes and file metadata", async () => {
    const bytes = await fs.readFile(SCREEN_PASS_FIXTURE);
    for (const isolationMode of ["subprocess", "worker_thread"]) {
      const { source, sourcePath } = await sourceBinding(bytes, `${isolationMode}.pdf`);
      const before = await fs.lstat(sourcePath, { bigint: true });
      const result = await runPdfLibInspection({
        operation: "inspect_pdf_accessibility",
        sources: [source],
      }, { isolationMode });
      const after = await fs.lstat(sourcePath, { bigint: true });
      const afterBytes = await fs.readFile(sourcePath);

      expect(result.result).toBe("no_findings_detected");
      expect(result.source.sha256).toBe(source.sha256);
      expect(afterBytes.equals(bytes)).toBe(true);
      expect({
        dev: after.dev,
        ino: after.ino,
        size: after.size,
        mode: after.mode,
        nlink: after.nlink,
        uid: after.uid,
        gid: after.gid,
        mtimeNs: after.mtimeNs,
      }).toEqual({
        dev: before.dev,
        ino: before.ino,
        size: before.size,
        mode: before.mode,
        nlink: before.nlink,
        uid: before.uid,
        gid: before.gid,
        mtimeNs: before.mtimeNs,
      });
    }
  });

  it("returns the fixed encrypted abstention through the real isolation boundary", async () => {
    const bytes = await fs.readFile(ENCRYPTED_FIXTURE);
    const { source, sourcePath } = await sourceBinding(bytes, "encrypted.pdf");
    let error;
    try {
      await runPdfLibInspection({
        operation: "inspect_pdf_accessibility",
        sources: [source],
      });
    } catch (caught) {
      error = caught;
    }
    expect(error).toMatchObject({
      name: "AccessibilityInspectionError",
      code: "PDF_ENCRYPTED_INSPECTION_UNAVAILABLE",
      message: "Encrypted PDF inspection is unavailable because this operation does not accept a password.",
    });
    expect(error.message).not.toContain(sourcePath);
  });

  it("allows headerless read-only classification while mutation revalidation still rejects it", async () => {
    const malformedBytes = Buffer.from("not a PDF /private/var/folders/parser-canary");
    const { source } = await sourceBinding(malformedBytes, "malformed.pdf");
    const inspection = await runPdfLibInspection({
      operation: "inspect_pdf_accessibility",
      sources: [source],
    });
    expect(inspection).toMatchObject({
      inspection_status: "partial",
      result: "indeterminate",
    });
    expect(inspection.checks[0]).toMatchObject({
      id: "parseable_pdf",
      status: "missing",
      observation_code: "PARSE_FAILED",
    });
    expect(inspection.checks.slice(1).every(item => (
      item.status === "unavailable"
      && item.observation_code === "NOT_INSPECTED"
      && item.reason_code === "STRICT_PARSE_FAILED"
    ))).toBe(true);

    const stagedBytes = await fs.readFile(SCREEN_PASS_FIXTURE);
    const mutationWorker = await workerScript(`
import { createHash } from "node:crypto";
import fs from "node:fs/promises";
const chunks = [];
for await (const chunk of process.stdin) chunks.push(chunk);
const request = JSON.parse(Buffer.concat(chunks).toString("utf8"));
const output = Buffer.from(${JSON.stringify(stagedBytes.toString("base64"))}, "base64");
const filename = "output-0001.pdf";
const outputPath = request.stage_directory + "/" + filename;
await fs.writeFile(outputPath, output, { flag: "wx", mode: 0o600 });
const stats = await fs.lstat(outputPath, { bigint: true });
process.stdout.write(JSON.stringify({
  protocol_version: 1,
  operation: request.operation,
  status: "ok",
  manifest: [{
    filename,
    size_bytes: output.length,
    sha256: createHash("sha256").update(output).digest("hex"),
    file_identity: { device: String(stats.dev), inode: String(stats.ino) },
  }],
  result: {},
}));
await monitor.stop();
`);
    await expect(runPdfLibMutation({
      operation: "rotate_pdf_pages",
      sources: [source],
      options: { degrees: 90, pages: [] },
      password: null,
    }, async () => ({}), { workerPath: mutationWorker })).rejects.toMatchObject({
      code: "PDF_INVALID_HEADER",
    });
  });

  it("revalidates the exact source after a successful worker response and cleans the private directory", async () => {
    const bytes = await fs.readFile(SCREEN_PASS_FIXTURE);
    const { source, sourcePath } = await sourceBinding(bytes);
    const result = await inspectPdfAccessibilityBytes(bytes, { source_file_name: "source.pdf" });
    const changed = Buffer.from(bytes);
    changed[changed.length - 1] ^= 1;
    const workerPath = await workerScript(successResponseScript(result, `
await fs.writeFile(request.sources[0].canonical_path, Buffer.from(${JSON.stringify(changed.toString("base64"))}, "base64"));
` ).replace(
      "const chunks = [];",
      'import fs from "node:fs/promises";\nconst chunks = [];',
    ));
    let operationDirectory;
    await expect(runPdfLibInspection({
      operation: "inspect_pdf_accessibility",
      sources: [source],
    }, {
      workerPath,
      spawnProcess(command, args, options) {
        operationDirectory = options.cwd;
        return spawn(command, args, options);
      },
    })).rejects.toMatchObject({
      // Source drift is a concurrent modification, not a resource condition.
      // The refusal is identical whichever layer makes it, so this must not
      // drift back to PDF_RESOURCE_LIMIT_CODE: that told the caller to try a
      // smaller PDF, and it made save-lifecycle's concurrency assertion depend
      // on which detector machine load let win.
      code: PDF_CONCURRENT_MODIFICATION_CODE,
      reason: "source_drift_before_activation",
    });
    expect(await fs.readFile(sourcePath)).toEqual(changed);
    await expect(fs.lstat(operationDirectory)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("rejects staged output and semantically invalid control results for the read-only operation", async () => {
    const bytes = await fs.readFile(SCREEN_PASS_FIXTURE);
    const { source } = await sourceBinding(bytes);
    const valid = await inspectPdfAccessibilityBytes(bytes, { source_file_name: "source.pdf" });
    const stageWorker = await workerScript(`
import { createHash } from "node:crypto";
import fs from "node:fs/promises";
const chunks = [];
for await (const chunk of process.stdin) chunks.push(chunk);
const request = JSON.parse(Buffer.concat(chunks).toString("utf8"));
const output = Buffer.from("%PDF-1.7\\noutput\\n%%EOF\\n");
const filename = "output-0001.pdf";
await fs.writeFile(request.stage_directory + "/" + filename, output, { flag: "wx", mode: 0o600 });
const stats = await fs.lstat(request.stage_directory + "/" + filename, { bigint: true });
process.stdout.write(JSON.stringify({
  protocol_version: 1,
  operation: request.operation,
  status: "ok",
  manifest: [{
    filename,
    size_bytes: output.length,
    sha256: createHash("sha256").update(output).digest("hex"),
    file_identity: { device: String(stats.dev), inode: String(stats.ino) },
  }],
  result: ${JSON.stringify(valid)},
}));
await monitor.stop();
`);
    await expect(runPdfLibInspection({
      operation: "inspect_pdf_accessibility",
      sources: [source],
    }, { workerPath: stageWorker })).rejects.toMatchObject({
      code: PDF_RESOURCE_LIMIT_CODE,
      reason: "invalid_stage_manifest",
    });

    const invalidResults = [
      (() => {
        const invalid = structuredClone(valid);
        invalid.human_review.status = "not_required";
        return invalid;
      })(),
      (() => {
        const invalid = structuredClone(valid);
        invalid.source.sha256 = "0".repeat(64);
        return invalid;
      })(),
    ];
    for (const invalid of invalidResults) {
      const invalidWorker = await workerScript(successResponseScript(invalid));
      await expect(runPdfLibInspection({
        operation: "inspect_pdf_accessibility",
        sources: [source],
      }, { workerPath: invalidWorker })).rejects.toMatchObject({
        code: PDF_RESOURCE_LIMIT_CODE,
        reason: "invalid_read_only_result",
      });
    }
  });

  it("cancels, times out, bounds output, contains crashes, and cleans every private directory", async () => {
    const bytes = await fs.readFile(SCREEN_PASS_FIXTURE);
    const slowWorker = await workerScript("await new Promise(resolve => setTimeout(resolve, 60_000));");
    const overflowWorker = await workerScript(`
process.stdout.write("x".repeat(1024 * 1024 + 1));
await monitor.stop();
`);
    const crashWorker = await workerScript("await monitor.stop(); process.exitCode = 17;");
    const cases = [
      {
        workerPath: slowWorker,
        options: controller => ({ signal: controller.signal }),
        activate: controller => setTimeout(() => controller.abort(), 30),
        reason: "operation_cancelled",
      },
      {
        workerPath: slowWorker,
        options: () => ({ timeoutMs: 40 }),
        activate: () => {},
        reasonPattern: /^(?:timeout|rss_monitor_startup_timeout)$/,
      },
      {
        workerPath: overflowWorker,
        options: () => ({}),
        activate: () => {},
        reason: "stdout_overflow",
      },
      {
        workerPath: crashWorker,
        options: () => ({}),
        activate: () => {},
        reasonPattern: /worker_exit_17|rss_monitor/,
      },
    ];
    for (const testCase of cases) {
      const { source } = await sourceBinding(bytes);
      const controller = new AbortController();
      let operationDirectory;
      testCase.activate(controller);
      let error;
      try {
        await runPdfLibInspection({
          operation: "inspect_pdf_accessibility",
          sources: [source],
        }, {
          workerPath: testCase.workerPath,
          ...testCase.options(controller),
          spawnProcess(command, args, options) {
            operationDirectory = options.cwd;
            return spawn(command, args, options);
          },
        });
      } catch (caught) {
        error = caught;
      }
      expect(error?.code).toBe(PDF_RESOURCE_LIMIT_CODE);
      if (testCase.reason) expect(error.reason).toBe(testCase.reason);
      if (testCase.reasonPattern) expect(error.reason).toMatch(testCase.reasonPattern);
      await expect(fs.lstat(operationDirectory)).rejects.toMatchObject({ code: "ENOENT" });
    }
  });

  it("drains read-only work through the general shutdown and retains the mutation alias", async () => {
    const bytes = await fs.readFile(SCREEN_PASS_FIXTURE);
    const { source } = await sourceBinding(bytes);
    const slowWorker = await workerScript("await new Promise(resolve => setTimeout(resolve, 60_000));");
    const pending = runPdfLibInspection({
      operation: "inspect_pdf_accessibility",
      sources: [source],
    }, { workerPath: slowWorker });
    await new Promise(resolve => setTimeout(resolve, 40));
    await terminateAllPdfLibOperations();
    await expect(pending).rejects.toMatchObject({ code: PDF_RESOURCE_LIMIT_CODE });
    await expect(terminateAllPdfLibMutations()).resolves.toBeUndefined();
  });
});
