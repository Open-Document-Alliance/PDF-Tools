import crypto from "node:crypto";
import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { PDFDocument } from "pdf-lib";
import {
  PDF_MUTATION_FILE_LIMIT_MESSAGE,
  PDF_MUTATION_MAX_FILE_BYTES,
} from "../server/bounded-pdf-file.js";
import {
  createTestTempDirectory,
  removeTestTempDirectory,
} from "./helpers/temp-directory.js";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const RUNTIMES = [
  { name: "source runtime", root: REPO_ROOT },
  { name: "share runtime", root: path.join(REPO_ROOT, "pdf-toolkit-mcp-share") },
];
const TOOL_CALL_TIMEOUT_MS = 5_000;
const EXPECTED_ERROR = `Error: ${PDF_MUTATION_FILE_LIMIT_MESSAGE}`;
const CRASH_CHILD = path.join(REPO_ROOT, "test", "helpers", "atomic-output-crash-child.mjs");

const MUTATING_PDF_TOOLS = [
  {
    name: "fill_pdf",
    argumentsFor: ({ inputPath, outputPath }) => ({
      pdf_path: inputPath,
      output_path: outputPath,
      field_data: {},
    }),
  },
  {
    name: "bulk_fill_from_csv",
    argumentsFor: ({ inputPath, outputDirectory, csvPath }) => ({
      pdf_path: inputPath,
      csv_path: csvPath,
      output_directory: outputDirectory,
      filename_column: "filename",
    }),
  },
  {
    name: "fill_with_profile",
    argumentsFor: ({ inputPath, outputPath }) => ({
      pdf_path: inputPath,
      output_path: outputPath,
      profile_name: "limit-profile",
    }),
  },
  {
    name: "set_pdf_metadata",
    argumentsFor: ({ inputPath, outputPath }) => ({
      pdf_path: inputPath,
      output_path: outputPath,
      title: "Retitled",
    }),
  },
  {
    name: "merge_pdfs",
    argumentsFor: ({ inputPath, outputPath, validControlPath }) => ({
      input_paths: [inputPath, validControlPath],
      output_path: outputPath,
    }),
  },
  {
    name: "split_pdf",
    argumentsFor: ({ inputPath, outputDirectory }) => ({
      input_path: inputPath,
      page_ranges: "1",
      output_directory: outputDirectory,
    }),
  },
  {
    name: "rotate_pdf_pages",
    argumentsFor: ({ inputPath, outputPath }) => ({
      input_path: inputPath,
      output_path: outputPath,
      degrees: 90,
    }),
  },
  {
    name: "reorder_pdf_pages",
    argumentsFor: ({ inputPath, outputPath }) => ({
      input_path: inputPath,
      output_path: outputPath,
      page_order: [1],
    }),
  },
  {
    name: "apply_page_plan",
    argumentsFor: ({ inputPath, outputPath }) => ({
      input_path: inputPath,
      output_path: outputPath,
      plan: { page_order: [1], rotations: {} },
    }),
  },
  {
    name: "add_signature_field",
    argumentsFor: ({ inputPath, outputPath }) => ({
      pdf_path: inputPath,
      output_path: outputPath,
      page: 1,
      x: 72,
      y: 72,
      width: 160,
      height: 40,
    }),
  },
  {
    name: "apply_signature",
    argumentsFor: ({ inputPath, outputPath }) => ({
      pdf_path: inputPath,
      output_path: outputPath,
      signature_name: "limit-signer",
      page: 1,
      x: 72,
      y: 72,
      width: 160,
      height: 40,
      user_intent_statement: "I intend to sign this resource-limit test fixture.",
      user_confirmed_at: new Date().toISOString(),
    }),
  },
  {
    name: "prepare_signing_packet",
    argumentsFor: ({ inputPath, outputPath }) => ({
      pdf_path: inputPath,
      output_path: outputPath,
      field_values: {},
      signature_locations: [{
        label: "Resource-limit test signature",
        page: 1,
        x: 72,
        y: 72,
        width: 160,
        height: 40,
      }],
    }),
  },
  {
    name: "apply_text",
    argumentsFor: ({ inputPath, outputPath }) => ({
      pdf_path: inputPath,
      output_path: outputPath,
      page: 1,
      x: 72,
      y: 72,
      width: 160,
      height: 24,
      text: "resource limit fixture",
    }),
  },
];

const SAME_PATH_MUTATING_TOOLS = new Set([
  "fill_pdf",
  "fill_with_profile",
  "add_signature_field",
  "apply_signature",
  "prepare_signing_packet",
  "apply_text",
]);

function callToolBounded(client, request) {
  return client.callTool(request, undefined, {
    timeout: TOOL_CALL_TIMEOUT_MS,
    maxTotalTimeout: TOOL_CALL_TIMEOUT_MS,
  });
}

function sha256(bytes) {
  return crypto.createHash("sha256").update(bytes).digest("hex");
}

async function runCrashChild(directoryPath, transition) {
  return await new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [CRASH_CHILD, directoryPath, transition], {
      cwd: REPO_ROOT,
      stdio: ["ignore", "pipe", "pipe"],
    });
    const stderr = [];
    child.stderr.on("data", chunk => stderr.push(chunk));
    child.on("error", reject);
    child.on("close", (code, signal) => resolve({
      code,
      signal,
      stderr: Buffer.concat(stderr).toString("utf8"),
    }));
  });
}

function discoverPdfProducingMutators(tools) {
  return tools
    .filter(tool => {
      const properties = new Set(Object.keys(tool.inputSchema?.properties ?? {}));
      const consumesPdf = ["pdf_path", "input_path", "input_paths"]
        .some(property => properties.has(property));
      const declaresOutputPath = properties.has("output_path")
        || properties.has("output_directory");
      return tool.annotations?.destructiveHint === true
        && consumesPdf
        && declaresOutputPath
        && tool.name !== "convert_pdf_to_markdown";
    })
    .map(tool => tool.name)
    .sort();
}

function expectedPrimaryOutput(toolName, {
  inputPath,
  outputPath,
  outputDirectory,
}) {
  if (toolName === "bulk_fill_from_csv") {
    return path.join(outputDirectory, "limit-output.pdf");
  }
  if (toolName === "split_pdf") {
    return path.join(
      outputDirectory,
      `${path.basename(inputPath, ".pdf")}_pages_1-1.pdf`,
    );
  }
  return outputPath;
}

function activeIdentity(result) {
  return {
    active_path: result.structuredContent?.active_path ?? null,
    backup_path: result.structuredContent?.backup_path ?? null,
    last_mutation_tool: result.structuredContent?.last_mutation_tool ?? null,
    last_mutation_at: result.structuredContent?.last_mutation_at ?? null,
  };
}

async function outputIdentity(outputPath) {
  try {
    const [stats, bytes] = await Promise.all([
      fs.lstat(outputPath, { bigint: true }),
      fs.readFile(outputPath),
    ]);
    return {
      exists: true,
      device: String(stats.dev),
      inode: String(stats.ino),
      size: String(stats.size),
      mode: Number(stats.mode & 0o777n),
      sha256: sha256(bytes),
    };
  } catch (error) {
    if (error?.code === "ENOENT") return { exists: false };
    throw error;
  }
}

async function sparseInputIdentity(inputPath) {
  const stats = await fs.lstat(inputPath, { bigint: true });
  return {
    device: String(stats.dev),
    inode: String(stats.ino),
    size: String(stats.size),
    blocks: String(stats.blocks),
    mode: Number(stats.mode & 0o777n),
    mtimeNs: String(stats.mtimeNs),
    ctimeNs: String(stats.ctimeNs),
  };
}

async function snapshotRecoveryState(root) {
  const snapshot = {};

  async function visit(directoryPath, relativeDirectory = "") {
    const entries = await fs.readdir(directoryPath, { withFileTypes: true });
    entries.sort((left, right) => left.name.localeCompare(right.name));
    for (const entry of entries) {
      const relativePath = path.join(relativeDirectory, entry.name);
      const absolutePath = path.join(directoryPath, entry.name);
      const stats = await fs.lstat(absolutePath, { bigint: true });
      const identity = {
        device: String(stats.dev),
        inode: String(stats.ino),
        mode: Number(stats.mode & 0o777n),
        size: String(stats.size),
        mtimeNs: String(stats.mtimeNs),
        ctimeNs: String(stats.ctimeNs),
      };
      if (entry.isDirectory()) {
        snapshot[`${relativePath}/`] = { type: "directory", ...identity };
        await visit(absolutePath, relativePath);
      } else if (entry.isFile()) {
        snapshot[relativePath] = {
          type: "file",
          ...identity,
          ...(stats.size <= 1024n * 1024n
            ? { sha256: sha256(await fs.readFile(absolutePath)) }
            : { sparse_large_file: true, blocks: String(stats.blocks) }),
        };
      } else {
        snapshot[relativePath] = {
          type: entry.isSymbolicLink() ? "symlink" : "other",
          ...identity,
        };
      }
    }
  }

  await visit(root);
  return snapshot;
}

function expectCleanLimitError(result, hasOutputSchema, privateRoot) {
  expect(result.isError).toBe(true);
  expect(result.content).toEqual([{ type: "text", text: EXPECTED_ERROR }]);
  expect(result.content[0].text).not.toContain(privateRoot);
  if (hasOutputSchema) {
    expect(result.structuredContent).toEqual({
      status: "failed",
      error: {
        error_schema_version: 1,
        code: "tool_execution_failed",
      },
    });
  } else {
    expect(result.structuredContent).toBeUndefined();
  }
}

describe.each(RUNTIMES)("$name mutation PDF input limits", ({ root }) => {
  let stateRoot;
  let profilesDirectory;
  let backupsDirectory;
  let csvPath;
  let validControlPath;
  let oversizeInputPath;
  let oversizeIdentity;
  let client;
  let transport;
  let serverPid;
  let serverClosedUnexpectedly;
  let transportErrors;
  let closingTransport;
  let stderrText;
  let toolsWithOutputSchema;
  let baselineActiveIdentity;
  let baselineBackups;

  beforeAll(async () => {
    stateRoot = await createTestTempDirectory(REPO_ROOT, "mutation-input-limits");
    profilesDirectory = path.join(stateRoot, "profiles");
    backupsDirectory = path.join(profilesDirectory, "backups");
    csvPath = path.join(stateRoot, "limit-row.csv");
    validControlPath = path.join(stateRoot, "valid-control.pdf");
    oversizeInputPath = path.join(stateRoot, "oversize.pdf");

    await fs.writeFile(csvPath, "filename,unused\nlimit-output,value\n", { mode: 0o600 });
    const validDocument = await PDFDocument.create();
    validDocument.addPage([400, 500]);
    await fs.writeFile(validControlPath, await validDocument.save(), { mode: 0o600 });
    const sparseHandle = await fs.open(oversizeInputPath, "w", 0o600);
    try {
      await sparseHandle.truncate(PDF_MUTATION_MAX_FILE_BYTES + 1);
    } finally {
      await sparseHandle.close();
    }
    oversizeIdentity = await sparseInputIdentity(oversizeInputPath);
    expect(Number(oversizeIdentity.size)).toBe(PDF_MUTATION_MAX_FILE_BYTES + 1);
    expect(Number(oversizeIdentity.blocks) * 512).toBeLessThan(1024 * 1024);

    stderrText = "";
    serverClosedUnexpectedly = false;
    transportErrors = [];
    closingTransport = false;
    transport = new StdioClientTransport({
      command: process.execPath,
      args: [path.join(root, "server", "index.js")],
      cwd: root,
      env: {
        ALLOWED_DIRECTORIES: stateRoot,
        DEFAULT_PDF_DIR: stateRoot,
        DEFAULT_DOWNLOAD_DIR: stateRoot,
        DEFAULT_PROFILES_DIR: profilesDirectory,
      },
      stderr: "pipe",
    });
    transport.stderr?.on("data", chunk => {
      stderrText += chunk.toString("utf8");
    });
    client = new Client({ name: "pdf-tools-mutation-limit-client", version: "1.0.0" });
    await client.connect(transport);
    serverPid = transport.pid;
    const clientOnClose = transport.onclose;
    const clientOnError = transport.onerror;
    transport.onclose = () => {
      if (!closingTransport) serverClosedUnexpectedly = true;
      clientOnClose?.();
    };
    transport.onerror = error => {
      transportErrors.push(error);
      clientOnError?.(error);
    };

    const listedTools = (await client.listTools(
      {},
      { timeout: TOOL_CALL_TIMEOUT_MS, maxTotalTimeout: TOOL_CALL_TIMEOUT_MS },
    )).tools;
    toolsWithOutputSchema = new Set(
      listedTools
        .filter(tool => tool.outputSchema !== undefined)
        .map(tool => tool.name),
    );
    expect(discoverPdfProducingMutators(listedTools)).toEqual(
      MUTATING_PDF_TOOLS.map(tool => tool.name).sort(),
    );

    expect((await callToolBounded(client, {
      name: "save_profile",
      arguments: { profile_name: "limit-profile", field_data: {} },
    })).isError).not.toBe(true);
    expect((await callToolBounded(client, {
      name: "create_signature",
      arguments: { name: "limit-signer", display_name: "Limit Signer" },
    })).isError).not.toBe(true);
    const active = await callToolBounded(client, {
      name: "set_active_document",
      arguments: { pdf_path: validControlPath },
    });
    expect(active.isError).not.toBe(true);
    baselineActiveIdentity = activeIdentity(active);
    baselineBackups = (await fs.readdir(backupsDirectory)).sort();
  }, 30_000);

  afterAll(async () => {
    closingTransport = true;
    try {
      await client?.close();
      await transport?.close();
    } finally {
      await removeTestTempDirectory(stateRoot);
    }
  });

  it("rejects every discovered mutator before absent or preexisting outputs can change", async () => {
    for (const tool of MUTATING_PDF_TOOLS) {
      for (const outputMode of ["absent", "preexisting"]) {
        const caseRoot = path.join(stateRoot, "cases", tool.name, outputMode);
        const outputDirectory = path.join(caseRoot, "outputs");
        const outputPath = path.join(outputDirectory, "result.pdf");
        await fs.mkdir(outputDirectory, { recursive: true });
        const primaryOutput = expectedPrimaryOutput(tool.name, {
          inputPath: oversizeInputPath,
          outputPath,
          outputDirectory,
        });
        if (outputMode === "preexisting") {
          await fs.writeFile(primaryOutput, "preexisting resource-limit sentinel", { mode: 0o600 });
        }
        const outputBefore = await outputIdentity(primaryOutput);

        const result = await callToolBounded(client, {
          name: tool.name,
          arguments: tool.argumentsFor({
            inputPath: oversizeInputPath,
            outputPath,
            outputDirectory,
            csvPath,
            validControlPath,
          }),
        });
        expectCleanLimitError(
          result,
          toolsWithOutputSchema.has(tool.name),
          stateRoot,
        );
        expect(await outputIdentity(primaryOutput)).toEqual(outputBefore);
        expect(await sparseInputIdentity(oversizeInputPath)).toEqual(oversizeIdentity);
        expect((await fs.readdir(backupsDirectory)).sort()).toEqual(baselineBackups);
        const active = await callToolBounded(client, {
          name: "get_active_document",
          arguments: {},
        });
        expect(activeIdentity(active)).toEqual(baselineActiveIdentity);
        expect(transport.pid).toBe(serverPid);
        expect(serverClosedUnexpectedly).toBe(false);
        expect(transportErrors).toEqual([]);
      }
    }
  }, 30_000);

  it("rejects an oversized source without recovering a real interrupted output transaction", async () => {
    const recoveryRoot = path.join(stateRoot, "oversize-recovery-state");
    const firstPath = path.join(recoveryRoot, "first.pdf");
    const secondPath = path.join(recoveryRoot, "second.pdf");
    const oversizedPath = path.join(recoveryRoot, "oversized.pdf");
    const outputPath = path.join(recoveryRoot, "must-not-exist.pdf");
    await fs.mkdir(recoveryRoot, { recursive: true });
    await fs.writeFile(firstPath, "first original", { mode: 0o600 });
    await fs.writeFile(secondPath, "second original", { mode: 0o600 });
    const oversizedHandle = await fs.open(oversizedPath, "w", 0o600);
    try {
      await oversizedHandle.truncate(PDF_MUTATION_MAX_FILE_BYTES + 1);
    } finally {
      await oversizedHandle.close();
    }
    expect(await runCrashChild(recoveryRoot, "activate_0")).toEqual({
      code: 86,
      signal: null,
      stderr: "",
    });
    await expect(fs.readFile(firstPath, "utf8")).resolves.toBe("first replacement");
    const before = await snapshotRecoveryState(recoveryRoot);
    expect(
      Object.keys(before).some(name => name.endsWith("-transaction.json")),
    ).toBe(true);

    const result = await callToolBounded(client, {
      name: "rotate_pdf_pages",
      arguments: {
        input_path: oversizedPath,
        output_path: outputPath,
        degrees: 90,
      },
    });
    expectCleanLimitError(
      result,
      toolsWithOutputSchema.has("rotate_pdf_pages"),
      stateRoot,
    );
    expect(await snapshotRecoveryState(recoveryRoot)).toEqual(before);
    await expect(fs.lstat(outputPath)).rejects.toMatchObject({ code: "ENOENT" });
    const active = await callToolBounded(client, {
      name: "get_active_document",
      arguments: {},
    });
    expect(activeIdentity(active)).toEqual(baselineActiveIdentity);
  }, 15_000);

  it("recovers a temporarily missing accepted input before its bounded descriptor read", async () => {
    const recoveryRoot = path.join(stateRoot, "missing-input-recovery");
    const firstPath = path.join(recoveryRoot, "first.pdf");
    const secondPath = path.join(recoveryRoot, "second.pdf");
    const outputPath = path.join(recoveryRoot, "rotated.pdf");
    await fs.mkdir(recoveryRoot, { recursive: true });
    const firstDocument = await PDFDocument.create();
    firstDocument.addPage([400, 500]);
    const firstBytes = Buffer.from(await firstDocument.save());
    const secondDocument = await PDFDocument.create();
    secondDocument.addPage([300, 300]);
    const secondBytes = Buffer.from(await secondDocument.save());
    await fs.writeFile(firstPath, firstBytes, { mode: 0o600 });
    await fs.writeFile(secondPath, secondBytes, { mode: 0o600 });
    expect(await runCrashChild(recoveryRoot, "rollback_0")).toEqual({
      code: 86,
      signal: null,
      stderr: "",
    });
    await expect(fs.lstat(firstPath)).rejects.toMatchObject({ code: "ENOENT" });

    const result = await callToolBounded(client, {
      name: "rotate_pdf_pages",
      arguments: {
        input_path: firstPath,
        output_path: outputPath,
        degrees: 90,
      },
    });
    expect(result.isError).not.toBe(true);
    expect(Buffer.from(await fs.readFile(firstPath)).equals(firstBytes)).toBe(true);
    expect(Buffer.from(await fs.readFile(secondPath)).equals(secondBytes)).toBe(true);
    const outputDocument = await PDFDocument.load(await fs.readFile(outputPath));
    expect(outputDocument.getPage(0).getRotation().angle).toBe(90);
    expect(
      (await fs.readdir(recoveryRoot)).filter(name => name.startsWith(".pdf-tools-")),
    ).toEqual([]);

    const resetActive = await callToolBounded(client, {
      name: "set_active_document",
      arguments: { pdf_path: validControlPath },
    });
    expect(resetActive.isError).not.toBe(true);
    baselineActiveIdentity = activeIdentity(resetActive);
  }, 15_000);

  it.runIf(process.platform !== "win32")(
    "binds symlinked inputs to the canonical interrupted-transaction directory before parsing",
    async () => {
      const caseRoot = path.join(stateRoot, "symlinked-recovery-input");
      const actualRoot = path.join(caseRoot, "actual");
      const aliasesRoot = path.join(caseRoot, "aliases");
      const firstPath = path.join(actualRoot, "first.pdf");
      const secondPath = path.join(actualRoot, "second.pdf");
      const aliasPath = path.join(aliasesRoot, "input.pdf");
      const outputPath = path.join(actualRoot, "rotated.pdf");
      await fs.mkdir(actualRoot, { recursive: true });
      await fs.mkdir(aliasesRoot, { recursive: true });

      const firstDocument = await PDFDocument.create();
      firstDocument.addPage([400, 500]);
      firstDocument.setTitle("canonical recovery source");
      const firstBytes = Buffer.from(await firstDocument.save());
      const secondDocument = await PDFDocument.create();
      secondDocument.addPage([300, 300]);
      const secondBytes = Buffer.from(await secondDocument.save());
      await fs.writeFile(firstPath, firstBytes, { mode: 0o600 });
      await fs.writeFile(secondPath, secondBytes, { mode: 0o600 });
      await fs.symlink(firstPath, aliasPath);

      expect(await runCrashChild(actualRoot, "activate_0")).toEqual({
        code: 86,
        signal: null,
        stderr: "",
      });
      await expect(fs.readFile(firstPath, "utf8")).resolves.toBe("first replacement");
      expect(
        (await fs.readdir(actualRoot)).some(name => name.endsWith("-transaction.json")),
      ).toBe(true);
      expect(
        (await fs.readdir(aliasesRoot)).filter(name => name.startsWith(".pdf-tools-")),
      ).toEqual([]);

      const result = await callToolBounded(client, {
        name: "rotate_pdf_pages",
        arguments: {
          input_path: aliasPath,
          output_path: outputPath,
          degrees: 90,
        },
      });
      expect(result.isError).not.toBe(true);
      expect(Buffer.from(await fs.readFile(firstPath)).equals(firstBytes)).toBe(true);
      expect(Buffer.from(await fs.readFile(secondPath)).equals(secondBytes)).toBe(true);
      expect(
        (await fs.readdir(actualRoot)).filter(name => name.startsWith(".pdf-tools-")),
      ).toEqual([]);
      const outputDocument = await PDFDocument.load(await fs.readFile(outputPath));
      expect(outputDocument.getTitle()).toBe("canonical recovery source");
      expect(outputDocument.getPage(0).getRotation().angle).toBe(90);

      const resetActive = await callToolBounded(client, {
        name: "set_active_document",
        arguments: { pdf_path: validControlPath },
      });
      expect(resetActive.isError).not.toBe(true);
      baselineActiveIdentity = activeIdentity(resetActive);
    },
    15_000,
  );

  it.runIf(process.platform !== "win32")(
    "recovers a dangling input alias in its bound target directory before parsing",
    async () => {
      const caseRoot = path.join(stateRoot, "dangling-symlink-recovery-input");
      const actualRoot = path.join(caseRoot, "actual");
      const aliasesRoot = path.join(caseRoot, "aliases");
      const firstPath = path.join(actualRoot, "first.pdf");
      const secondPath = path.join(actualRoot, "second.pdf");
      const aliasPath = path.join(aliasesRoot, "input.pdf");
      const outputPath = path.join(actualRoot, "rotated.pdf");
      const persistedOutputPath = path.join(actualRoot, "filled.pdf");
      await fs.mkdir(actualRoot, { recursive: true });
      await fs.mkdir(aliasesRoot, { recursive: true });

      const firstDocument = await PDFDocument.create();
      firstDocument.addPage([400, 500]);
      firstDocument.setTitle("dangling canonical recovery source");
      const firstBytes = Buffer.from(await firstDocument.save());
      const secondDocument = await PDFDocument.create();
      secondDocument.addPage([300, 300]);
      const secondBytes = Buffer.from(await secondDocument.save());
      await fs.writeFile(firstPath, firstBytes, { mode: 0o600 });
      await fs.writeFile(secondPath, secondBytes, { mode: 0o600 });
      await fs.symlink(path.relative(aliasesRoot, firstPath), aliasPath);

      expect(await runCrashChild(actualRoot, "rollback_0")).toEqual({
        code: 86,
        signal: null,
        stderr: "",
      });
      await expect(fs.lstat(firstPath)).rejects.toMatchObject({ code: "ENOENT" });
      await expect(fs.lstat(aliasPath)).resolves.toMatchObject({});
      expect(
        (await fs.readdir(actualRoot)).some(name => name.endsWith("-transaction.json")),
      ).toBe(true);
      expect(
        (await fs.readdir(aliasesRoot)).filter(name => name.startsWith(".pdf-tools-")),
      ).toEqual([]);

      const result = await callToolBounded(client, {
        name: "rotate_pdf_pages",
        arguments: {
          input_path: aliasPath,
          output_path: outputPath,
          degrees: 90,
        },
      });
      expect(result.isError).not.toBe(true);
      expect(Buffer.from(await fs.readFile(firstPath)).equals(firstBytes)).toBe(true);
      expect(Buffer.from(await fs.readFile(secondPath)).equals(secondBytes)).toBe(true);
      expect(
        (await fs.readdir(actualRoot)).filter(name => name.startsWith(".pdf-tools-")),
      ).toEqual([]);
      expect(
        (await fs.readdir(aliasesRoot)).filter(name => name.startsWith(".pdf-tools-")),
      ).toEqual([]);
      const outputDocument = await PDFDocument.load(await fs.readFile(outputPath));
      expect(outputDocument.getTitle()).toBe("dangling canonical recovery source");
      expect(outputDocument.getPage(0).getRotation().angle).toBe(90);

      const persisted = await callToolBounded(client, {
        name: "fill_pdf",
        arguments: {
          pdf_path: aliasPath,
          output_path: persistedOutputPath,
          field_data: {},
        },
      });
      expect(persisted.isError).not.toBe(true);
      const persistedDocument = await PDFDocument.load(await fs.readFile(persistedOutputPath));
      expect(persistedDocument.getTitle()).toBe("dangling canonical recovery source");
      expect(
        (await fs.readdir(actualRoot)).filter(name => name.startsWith(".pdf-tools-")),
      ).toEqual([]);

      const resetActive = await callToolBounded(client, {
        name: "set_active_document",
        arguments: { pdf_path: validControlPath },
      });
      expect(resetActive.isError).not.toBe(true);
      baselineActiveIdentity = activeIdentity(resetActive);
    },
    15_000,
  );

  it("rejects all supported same-path mutations before changing the sparse source or backup state", async () => {
    for (const tool of MUTATING_PDF_TOOLS.filter(candidate =>
      SAME_PATH_MUTATING_TOOLS.has(candidate.name))) {
      const result = await callToolBounded(client, {
        name: tool.name,
        arguments: tool.argumentsFor({
          inputPath: oversizeInputPath,
          outputPath: oversizeInputPath,
          outputDirectory: path.dirname(oversizeInputPath),
          csvPath,
          validControlPath,
        }),
      });
      expectCleanLimitError(
        result,
        toolsWithOutputSchema.has(tool.name),
        stateRoot,
      );
      expect(await sparseInputIdentity(oversizeInputPath)).toEqual(oversizeIdentity);
      expect((await fs.readdir(backupsDirectory)).sort()).toEqual(baselineBackups);
      const active = await callToolBounded(client, {
        name: "get_active_document",
        arguments: {},
      });
      expect(activeIdentity(active)).toEqual(baselineActiveIdentity);
    }
  }, 15_000);

  it("remains live and successfully mutates a valid PDF after the rejection campaign", async () => {
    const outputPath = path.join(stateRoot, "liveness-output.pdf");
    const result = await callToolBounded(client, {
      name: "rotate_pdf_pages",
      arguments: {
        input_path: validControlPath,
        output_path: outputPath,
        degrees: 90,
      },
    });
    expect(result.isError).not.toBe(true);
    const outputDocument = await PDFDocument.load(await fs.readFile(outputPath));
    expect(outputDocument.getPageCount()).toBe(1);
    expect(outputDocument.getPage(0).getRotation().angle).toBe(90);
    expect((await client.listTools(
      {},
      { timeout: TOOL_CALL_TIMEOUT_MS, maxTotalTimeout: TOOL_CALL_TIMEOUT_MS },
    )).tools.length).toBeGreaterThan(0);
    expect(serverClosedUnexpectedly).toBe(false);
    expect(transportErrors).toEqual([]);
    expect(stderrText).not.toMatch(/fatal error|uncaught|unhandled rejection/i);
  }, 15_000);
});
