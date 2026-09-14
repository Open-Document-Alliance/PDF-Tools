import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { PDFDocument } from "pdf-lib";
import { PDF_LIB_ENCRYPTED_MESSAGE } from "../server/helpers.js";
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

function callToolBounded(client, request) {
  return client.callTool(request, undefined, {
    timeout: TOOL_CALL_TIMEOUT_MS,
    maxTotalTimeout: TOOL_CALL_TIMEOUT_MS,
  });
}

function sha256(bytes) {
  return crypto.createHash("sha256").update(bytes).digest("hex");
}

function makePdfBytes(objects, rootObjectNumber) {
  const chunks = ["%PDF-1.7\n"];
  const offsets = [0];
  const objectByNumber = new Map(objects);
  const maximumObjectNumber = Math.max(...objectByNumber.keys());
  for (let objectNumber = 1; objectNumber <= maximumObjectNumber; objectNumber += 1) {
    const body = objectByNumber.get(objectNumber);
    if (body === undefined) continue;
    offsets[objectNumber] = Buffer.byteLength(chunks.join(""), "latin1");
    chunks.push(`${objectNumber} 0 obj\n${body}\nendobj\n`);
  }
  const xrefOffset = Buffer.byteLength(chunks.join(""), "latin1");
  const xrefEntries = ["0000000000 65535 f "];
  for (let objectNumber = 1; objectNumber <= maximumObjectNumber; objectNumber += 1) {
    xrefEntries.push(offsets[objectNumber] === undefined
      ? "0000000000 00000 f "
      : `${String(offsets[objectNumber]).padStart(10, "0")} 00000 n `);
  }
  chunks.push(
    `xref\n0 ${maximumObjectNumber + 1}\n${xrefEntries.join("\n")}\n` +
      `trailer\n<< /Size ${maximumObjectNumber + 1} /Root ${rootObjectNumber} 0 R >>\n` +
      `startxref\n${xrefOffset}\n%%EOF\n`,
  );
  return Buffer.from(chunks.join(""), "latin1");
}

function makeZeroPagePdfBytes() {
  return makePdfBytes([
    [1, "<< /Type /Pages /Kids [] /Count 0 >>"],
    [2, "<< /Type /Catalog /Pages 1 0 R >>"],
  ], 2);
}

async function makeMalformedFixtures() {
  const validDocument = await PDFDocument.create();
  validDocument.addPage([400, 500]);
  const fixedMetadataDate = new Date("2026-07-23T00:00:00.000Z");
  validDocument.setTitle("ODA malformed-input fixture source");
  validDocument.setAuthor("Open Document Alliance");
  validDocument.setCreator("Open Document Alliance deterministic test");
  validDocument.setProducer("Open Document Alliance deterministic test");
  validDocument.setCreationDate(fixedMetadataDate);
  validDocument.setModificationDate(fixedMetadataDate);
  const validBytes = Buffer.from(await validDocument.save({ useObjectStreams: false }));
  const pageLeaf = "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 100 100] /Resources <<>> >>";

  const fixtures = [
    ["empty", Buffer.alloc(0)],
    [
      "dangling-page-child",
      makePdfBytes([
        [1, "<< /Type /Catalog /Pages 2 0 R >>"],
        [2, "<< /Type /Pages /Kids [9 0 R] /Count 1 >>"],
      ], 1),
    ],
    [
      "self-referential-page-tree",
      makePdfBytes([
        [1, "<< /Type /Catalog /Pages 2 0 R >>"],
        [2, "<< /Type /Pages /Kids [2 0 R] /Count 1 >>"],
      ], 1),
    ],
    [
      "root-page-tree-with-parent",
      makePdfBytes([
        [1, "<< /Type /Catalog /Pages 2 0 R >>"],
        [2, "<< /Type /Pages /Parent 2 0 R /Kids [] /Count 0 >>"],
      ], 1),
    ],
    [
      "direct-page-dictionary-child",
      makePdfBytes([
        [1, "<< /Type /Catalog /Pages 2 0 R >>"],
        [2, `<< /Type /Pages /Kids [${pageLeaf}] /Count 1 >>`],
      ], 1),
    ],
    [
      "invalid-page-child-type",
      makePdfBytes([
        [1, "<< /Type /Catalog /Pages 2 0 R >>"],
        [2, "<< /Type /Pages /Kids [3 0 R] /Count 1 >>"],
        [3, "<< /Type /NotAPage >>"],
      ], 1),
    ],
    [
      "duplicate-page-child",
      makePdfBytes([
        [1, "<< /Type /Catalog /Pages 2 0 R >>"],
        [2, "<< /Type /Pages /Kids [3 0 R 3 0 R] /Count 2 >>"],
        [3, pageLeaf],
      ], 1),
    ],
    [
      "incorrect-page-parent",
      makePdfBytes([
        [1, "<< /Type /Catalog /Pages 2 0 R >>"],
        [2, "<< /Type /Pages /Kids [3 0 R] /Count 1 >>"],
        [3, "<< /Type /Page /Parent 4 0 R /MediaBox [0 0 100 100] /Resources <<>> >>"],
        [4, "<< /Type /Pages /Kids [] /Count 0 >>"],
      ], 1),
    ],
    ["pdf-header-only", Buffer.from("%PDF-1.7\n")],
    [
      "dangling-page-child-count-zero",
      makePdfBytes([
        [1, "<< /Type /Catalog /Pages 2 0 R >>"],
        [2, "<< /Type /Pages /Kids [9 0 R] /Count 0 >>"],
      ], 1),
    ],
    [
      "page-tree-count-mismatch",
      makePdfBytes([
        [1, "<< /Type /Catalog /Pages 2 0 R >>"],
        [2, "<< /Type /Pages /Kids [3 0 R] /Count 2 >>"],
        [3, pageLeaf],
      ], 1),
    ],
    ["unterminated-object", Buffer.from("%PDF-1.7\n1 0 obj\n<< /Type /Catalog\n")],
    [
      "trailer-without-root",
      Buffer.from(
        "%PDF-1.7\nxref\n0 1\n0000000000 65535 f \n" +
          "trailer\n<< /Size 1 >>\nstartxref\n9\n%%EOF\n",
      ),
    ],
    [
      "catalog-without-pages",
      Buffer.from(
        "%PDF-1.7\n1 0 obj\n<< /Type /Catalog >>\nendobj\n" +
          "trailer\n<< /Root 1 0 R /Size 2 >>\n%%EOF\n",
      ),
    ],
    [
      "page-tree-without-kids",
      Buffer.from(
        "%PDF-1.7\n1 0 obj\n<< /Type /Catalog /Pages 2 0 R >>\nendobj\n" +
          "2 0 obj\n<< /Type /Pages /Count 1 >>\nendobj\n%%EOF\n",
      ),
    ],
    [
      "nested-page-tree-count-mismatch",
      makePdfBytes([
        [1, "<< /Type /Catalog /Pages 2 0 R >>"],
        [2, "<< /Type /Pages /Kids [3 0 R] /Count 1 >>"],
        [3, "<< /Type /Pages /Parent 2 0 R /Kids [4 0 R] /Count 2 >>"],
        [4, "<< /Type /Page /Parent 3 0 R /MediaBox [0 0 100 100] /Resources <<>> >>"],
      ], 1),
    ],
    [
      "root-page-tree-with-null-parent",
      makePdfBytes([
        [1, "<< /Type /Catalog /Pages 2 0 R >>"],
        [2, "<< /Type /Pages /Parent null /Kids [] /Count 0 >>"],
      ], 1),
    ],
    [
      "truncated-stream",
      Buffer.from(
        "%PDF-1.7\n1 0 obj\n<< /Length 1000000 >>\nstream\nshort",
      ),
    ],
    [
      "valid-document-quarter-prefix",
      validBytes.subarray(0, Math.max(1, Math.floor(validBytes.length / 4))),
    ],
    [
      "invalid-page-child-type-count-zero",
      makePdfBytes([
        [1, "<< /Type /Catalog /Pages 2 0 R >>"],
        [2, "<< /Type /Pages /Kids [3 0 R] /Count 0 >>"],
        [3, "<< /Type /NotAPage >>"],
      ], 1),
    ],
  ].map(([name, bytes]) => ({ name, bytes: Buffer.from(bytes) }));

  const distinctDigests = new Set(fixtures.map(({ bytes }) => sha256(bytes)));
  if (fixtures.length !== 20 || distinctDigests.size !== fixtures.length) {
    throw new Error("Malformed fixture corpus must contain 20 distinct byte sequences.");
  }
  return fixtures;
}

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
      profile_name: "fuzz-profile",
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
      signature_name: "fuzz-signer",
      page: 1,
      x: 72,
      y: 72,
      width: 160,
      height: 40,
      user_intent_statement: "I intend to sign this malformed-input safety fixture.",
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
        label: "Safety fixture signature",
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
      text: "safety fixture",
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
const SAME_FILE_REJECTING_TOOLS = new Set([
  "merge_pdfs",
  "rotate_pdf_pages",
  "reorder_pdf_pages",
  "apply_page_plan",
]);
const NON_PDF_OUTPUT_TOOLS = new Set(["convert_pdf_to_markdown"]);

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
        && !NON_PDF_OUTPUT_TOOLS.has(tool.name);
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
    return path.join(outputDirectory, "bulk-fuzz.pdf");
  }
  if (toolName === "split_pdf") {
    return path.join(
      outputDirectory,
      `${path.basename(inputPath, ".pdf")}_pages_1-1.pdf`,
    );
  }
  return outputPath;
}

async function exactReplacementArguments(toolName, outputPath) {
  const [canonicalPath, bytes, stats] = await Promise.all([
    fs.realpath(outputPath),
    fs.readFile(outputPath),
    fs.stat(outputPath),
  ]);
  const identity = {
    canonical_path: canonicalPath,
    size_bytes: stats.size,
    sha256: sha256(bytes),
  };
  if (toolName === "bulk_fill_from_csv" || toolName === "split_pdf") {
    return {
      expected_output_identities: [{
        output_path: outputPath,
        ...identity,
      }],
    };
  }
  return { expected_output_identity: identity };
}

function activeDocumentIdentity(result) {
  return {
    active_path: result.structuredContent?.active_path ?? null,
    backup_path: result.structuredContent?.backup_path ?? null,
    last_mutation_tool: result.structuredContent?.last_mutation_tool ?? null,
    last_mutation_at: result.structuredContent?.last_mutation_at ?? null,
  };
}

async function snapshotTree(root) {
  const snapshot = {};

  async function visit(directory, relativeDirectory = "") {
    const entries = await fs.readdir(directory, { withFileTypes: true });
    entries.sort((left, right) => left.name.localeCompare(right.name));
    for (const entry of entries) {
      const relativePath = path.join(relativeDirectory, entry.name);
      const absolutePath = path.join(directory, entry.name);
      if (entry.isDirectory()) {
        const stats = await fs.stat(absolutePath);
        snapshot[`${relativePath}/`] = {
          type: "directory",
          mode: stats.mode & 0o777,
        };
        await visit(absolutePath, relativePath);
      } else if (entry.isFile()) {
        const [bytes, stats] = await Promise.all([
          fs.readFile(absolutePath),
          fs.stat(absolutePath),
        ]);
        snapshot[relativePath] = {
          type: "file",
          sha256: sha256(bytes),
          size: stats.size,
          mode: stats.mode & 0o777,
          mtime_ms: stats.mtimeMs,
          ctime_ms: stats.ctimeMs,
          inode: stats.ino,
        };
      } else {
        snapshot[relativePath] = `unexpected:${entry.isSymbolicLink() ? "symlink" : "other"}`;
      }
    }
  }

  await visit(root);
  return snapshot;
}

function expectCleanToolError(
  result,
  fixtureName,
  toolName,
  hasOutputSchema,
  prohibitedAbsolutePath,
) {
  expect(result.isError, `${fixtureName}/${toolName} must be a protocol error`).toBe(true);
  expect(result.content, `${fixtureName}/${toolName} error content`).toHaveLength(1);
  const message = result.content?.[0]?.text;
  expect(typeof message, `${fixtureName}/${toolName} error text type`).toBe("string");
  expect(message, `${fixtureName}/${toolName} error prefix`).toMatch(/^Error: \S/);
  expect(message.length, `${fixtureName}/${toolName} bounded error`).toBeLessThanOrEqual(2_000);
  expect(message, `${fixtureName}/${toolName} must not disclose the private case path`).not.toContain(
    prohibitedAbsolutePath,
  );
  expect(message, `${fixtureName}/${toolName} must not expose a stack or invalid rendering`).not.toMatch(
    /\n\s*at\s|\bundefined\b|\[object Object\]|fatal error|uncaught|unhandled rejection/i,
  );
  if (hasOutputSchema) {
    expect(result.structuredContent, `${fixtureName}/${toolName} structured failure`).toEqual({
      status: "failed",
      error: {
        error_schema_version: 1,
        code: expect.stringMatching(
          /^(?:PDF_RESOURCE_LIMIT_EXCEEDED|tool_execution_failed)$/,
        ),
      },
    });
  } else {
    expect(result.structuredContent, `${fixtureName}/${toolName} text-only failure`).toBeUndefined();
  }
}

async function runIsolatedToolCorpus({ root, tool, fixtures }) {
  const stateRoot = await createTestTempDirectory(REPO_ROOT, "malformed-isolated");
  const profilesDirectory = path.join(stateRoot, "profiles");
  const csvPath = path.join(stateRoot, "fuzz-row.csv");
  const validControlPath = path.join(stateRoot, "valid-control.pdf");
  let client;
  let transport;
  let closingTransport = false;
  let serverClosedUnexpectedly = false;
  const serverErrors = [];
  let stderrText = "";

  try {
    await fs.writeFile(csvPath, "filename,unused\nbulk-fuzz,value\n", { mode: 0o600 });
    const validControl = await PDFDocument.create();
    validControl.addPage([400, 500]);
    await fs.writeFile(validControlPath, await validControl.save(), { mode: 0o600 });

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
    client = new Client({
      name: `pdf-tools-isolated-${tool.name}`,
      version: "1.0.0",
    });
    await client.connect(transport);
    const serverPid = transport.pid;
    const clientOnClose = transport.onclose;
    const clientOnError = transport.onerror;
    transport.onclose = () => {
      if (!closingTransport) serverClosedUnexpectedly = true;
      clientOnClose?.();
    };
    transport.onerror = error => {
      serverErrors.push(error);
      clientOnError?.(error);
    };
    expect(serverPid).toEqual(expect.any(Number));

    const listedTools = (await client.listTools(
      {},
      { timeout: TOOL_CALL_TIMEOUT_MS, maxTotalTimeout: TOOL_CALL_TIMEOUT_MS },
    )).tools;
    const toolsWithOutputSchema = new Set(
      listedTools.filter(candidate => candidate.outputSchema !== undefined)
        .map(candidate => candidate.name),
    );
    expect(listedTools.map(candidate => candidate.name)).toContain(tool.name);

    expect((await callToolBounded(client, {
      name: "save_profile",
      arguments: {
        profile_name: "fuzz-profile",
        field_data: {},
      },
    })).isError).not.toBe(true);
    expect((await callToolBounded(client, {
      name: "create_signature",
      arguments: {
        name: "fuzz-signer",
        display_name: "Fuzz Signer",
      },
    })).isError).not.toBe(true);

    const positiveDirectory = path.join(stateRoot, "positive");
    const positiveOutputDirectory = path.join(positiveDirectory, "outputs");
    const positiveOutputPath = path.join(positiveOutputDirectory, "result.pdf");
    await fs.mkdir(positiveOutputDirectory, { recursive: true });
    const positiveResult = await callToolBounded(client, {
      name: tool.name,
      arguments: tool.argumentsFor({
        inputPath: validControlPath,
        outputPath: positiveOutputPath,
        outputDirectory: positiveOutputDirectory,
        csvPath,
        validControlPath,
      }),
    });
    expect(positiveResult.isError, `${tool.name} isolated positive control`).not.toBe(true);
    const positiveOutput = expectedPrimaryOutput(tool.name, {
      inputPath: validControlPath,
      outputPath: positiveOutputPath,
      outputDirectory: positiveOutputDirectory,
    });
    const positiveDocument = await PDFDocument.load(await fs.readFile(positiveOutput));
    expect(positiveDocument.getPageCount()).toBe(tool.name === "merge_pdfs" ? 2 : 1);

    for (const fixture of fixtures) {
      const caseDirectory = path.join(stateRoot, "cases", fixture.name);
      const outputDirectory = path.join(caseDirectory, "outputs");
      const inputPath = path.join(caseDirectory, "malformed.pdf");
      const outputPath = path.join(outputDirectory, "result.pdf");
      await fs.mkdir(outputDirectory, { recursive: true });
      await fs.writeFile(inputPath, fixture.bytes, { mode: 0o600 });
      const before = await snapshotTree(caseDirectory);
      const result = await callToolBounded(client, {
        name: tool.name,
        arguments: tool.argumentsFor({
          inputPath,
          outputPath,
          outputDirectory,
          csvPath,
          validControlPath,
        }),
      });
      expectCleanToolError(
        result,
        fixture.name,
        `${tool.name}-isolated`,
        toolsWithOutputSchema.has(tool.name),
        stateRoot,
      );
      expect(await snapshotTree(caseDirectory)).toEqual(before);
      expect(serverClosedUnexpectedly, `${fixture.name}/${tool.name} isolated close`).toBe(false);
      expect(serverErrors, `${fixture.name}/${tool.name} isolated transport errors`).toEqual([]);
      expect(transport.pid, `${fixture.name}/${tool.name} isolated stable pid`).toBe(serverPid);
      expect(
        (await client.listTools(
          {},
          { timeout: TOOL_CALL_TIMEOUT_MS, maxTotalTimeout: TOOL_CALL_TIMEOUT_MS },
        )).tools.length,
        `${fixture.name}/${tool.name} isolated canary`,
      ).toBeGreaterThan(0);
    }

    expect(Buffer.byteLength(stderrText, "utf8")).toBeLessThanOrEqual(1_000_000);
    expect(stderrText).not.toMatch(/fatal error|uncaught|unhandled rejection/i);
  } finally {
    closingTransport = true;
    try {
      await client?.close();
      await transport?.close();
    } finally {
      await removeTestTempDirectory(stateRoot);
    }
  }
}

// Keep every corpus case on every host. Each tool call retains its five-second
// containment deadline; test boundaries report the failing tool or fixture
// instead of timing out one giant host-throughput loop and leaving it running.
const MALFORMED_FIXTURES = await makeMalformedFixtures();

describe.each(RUNTIMES)("$name malformed PDF containment", ({ root }) => {
  let client;
  let transport;
  let stateRoot;
  let fixtures;
  let csvPath;
  let profilesDirectory;
  let validControlPath;
  let controlActiveDocument;
  let serverClosedUnexpectedly;
  let serverErrors;
  let stderrText;
  let closingTransport;
  let serverPid;
  let toolsWithOutputSchema;
  let discoveredMutatingPdfTools;

  beforeAll(async () => {
    stateRoot = await createTestTempDirectory(REPO_ROOT, "malformed-pdfs");
    fixtures = MALFORMED_FIXTURES;
    csvPath = path.join(stateRoot, "fuzz-row.csv");
    await fs.writeFile(csvPath, "filename,unused\nbulk-fuzz,value\n", { mode: 0o600 });

    profilesDirectory = path.join(stateRoot, "profiles");
    validControlPath = path.join(stateRoot, "valid-control.pdf");
    const validControl = await PDFDocument.create();
    validControl.addPage([400, 500]);
    await fs.writeFile(validControlPath, await validControl.save(), { mode: 0o600 });

    stderrText = "";
    serverClosedUnexpectedly = false;
    serverErrors = [];
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

    client = new Client({ name: "pdf-tools-malformed-fuzz-client", version: "1.0.0" });
    await client.connect(transport);
    serverPid = transport.pid;
    const clientOnClose = transport.onclose;
    const clientOnError = transport.onerror;
    transport.onclose = () => {
      if (!closingTransport) serverClosedUnexpectedly = true;
      clientOnClose?.();
    };
    transport.onerror = error => {
      serverErrors.push(error);
      clientOnError?.(error);
    };
    expect(serverPid).toEqual(expect.any(Number));
    const listedTools = (await client.listTools(
      {},
      { timeout: TOOL_CALL_TIMEOUT_MS, maxTotalTimeout: TOOL_CALL_TIMEOUT_MS },
    )).tools;
    expect(listedTools.length).toBeGreaterThan(0);
    toolsWithOutputSchema = new Set(
      listedTools.filter(tool => tool.outputSchema !== undefined).map(tool => tool.name),
    );
    discoveredMutatingPdfTools = discoverPdfProducingMutators(listedTools);

    const savedProfile = await callToolBounded(client, {
      name: "save_profile",
      arguments: {
        profile_name: "fuzz-profile",
        field_data: {},
      },
    });
    expect(savedProfile.isError).not.toBe(true);
    const savedSignature = await callToolBounded(client, {
      name: "create_signature",
      arguments: {
        name: "fuzz-signer",
        display_name: "Fuzz Signer",
      },
    });
    expect(savedSignature.isError).not.toBe(true);

    for (const tool of MUTATING_PDF_TOOLS) {
      const controlDirectory = path.join(stateRoot, "positive-controls", tool.name);
      const outputDirectory = path.join(controlDirectory, "outputs");
      const outputPath = path.join(outputDirectory, "result.pdf");
      await fs.mkdir(outputDirectory, { recursive: true });
      const result = await callToolBounded(client, {
        name: tool.name,
        arguments: tool.argumentsFor({
          inputPath: validControlPath,
          outputPath,
          outputDirectory,
          csvPath,
          validControlPath,
        }),
      });
      expect(result.isError, `${tool.name} positive control`).not.toBe(true);

      const expectedOutput = expectedPrimaryOutput(tool.name, {
        inputPath: validControlPath,
        outputPath,
        outputDirectory,
      });
      const outputBytes = await fs.readFile(expectedOutput);
      const outputDocument = await PDFDocument.load(outputBytes);
      expect(outputDocument.getPageCount(), `${tool.name} positive output page count`).toBe(
        tool.name === "merge_pdfs" ? 2 : 1,
      );
    }

    const zeroPagePath = path.join(stateRoot, "valid-zero-page.pdf");
    const zeroPageBytes = makeZeroPagePdfBytes();
    expect((await PDFDocument.load(zeroPageBytes)).getPageCount()).toBe(0);
    await fs.writeFile(zeroPagePath, zeroPageBytes, { mode: 0o600 });
    const zeroPageResult = await callToolBounded(client, {
      name: "read_pdf_fields",
      arguments: { pdf_path: zeroPagePath },
    });
    expect(zeroPageResult.isError, "valid zero-page control").not.toBe(true);

    const validControlBytes = await fs.readFile(validControlPath);
    const eofOffset = validControlBytes.lastIndexOf(Buffer.from("%%EOF", "ascii"));
    expect(eofOffset).toBeGreaterThan(0);
    const recoverableControls = [
      {
        name: "missing-eof",
        bytes: validControlBytes.subarray(0, eofOffset),
      },
      {
        name: "trailing-garbage",
        bytes: Buffer.concat([
          validControlBytes,
          Buffer.from("\nrecoverable trailing bytes\n", "ascii"),
        ]),
      },
    ];
    for (const control of recoverableControls) {
      const inputPath = path.join(stateRoot, `recoverable-${control.name}.pdf`);
      const outputPath = path.join(stateRoot, `recoverable-${control.name}-output.pdf`);
      await fs.writeFile(inputPath, control.bytes, { mode: 0o600 });
      const result = await callToolBounded(client, {
        name: "fill_pdf",
        arguments: {
          pdf_path: inputPath,
          output_path: outputPath,
          field_data: {},
        },
      });
      expect(result.isError, `${control.name} recoverable control`).not.toBe(true);
      expect((await PDFDocument.load(await fs.readFile(outputPath))).getPageCount()).toBe(1);
    }

    const encryptedPath = path.join(stateRoot, "encrypted-control.pdf");
    const encryptedBytes = await fs.readFile(path.join(
      REPO_ROOT,
      "test",
      "fixtures",
      "eval",
      "extraction",
      "oracles",
      "layout-encrypted-qpdf-r4.pdf",
    ));
    Buffer.from("%PDF-", "ascii").copy(encryptedBytes, 0);
    expect(sha256(encryptedBytes)).toBe(
      "23dd0051ce9932f47fa27e39ce4590ea3b589d5c586b679b251f1c6d0a1d431b",
    );
    await fs.writeFile(encryptedPath, encryptedBytes, { mode: 0o600 });
    for (const password of [
      undefined,
      "definitely-wrong-layout-password",
      "oda-layout-user-2026",
    ]) {
      const result = await callToolBounded(client, {
        name: "fill_pdf",
        arguments: {
          pdf_path: encryptedPath,
          output_path: path.join(
            stateRoot,
            `encrypted-${password === undefined ? "missing" : sha256(password).slice(0, 8)}.pdf`,
          ),
          field_data: {},
          ...(password === undefined ? {} : { password }),
        },
      });
      // fill_pdf decrypts now, and restores the document's protection before
      // saving, so the three cases no longer agree — they must each describe
      // what actually happened. test/encrypted-pdf-password-truth.test.js owns
      // the wording; this pins the containment property that matters here: a
      // password is never echoed back, and only the correct one writes a file.
      const text = result.content?.[0]?.text ?? "";
      if (password === "oda-layout-user-2026") {
        expect(result.isError, "correct password").not.toBe(true);
      } else {
        expect(result.isError, "missing or wrong password").toBe(true);
        expect(text).not.toBe(`Error: ${PDF_LIB_ENCRYPTED_MESSAGE}`);
      }
      if (password !== undefined) {
        expect(text, "must never echo the password").not.toContain(password);
      }
    }

    const activeAfterControls = await callToolBounded(client, {
      name: "get_active_document",
      arguments: {},
    });
    expect(activeAfterControls.isError).not.toBe(true);
    controlActiveDocument = activeDocumentIdentity(activeAfterControls);
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

  it("defines exactly twenty distinct malformed inputs and the complete mutating surface", () => {
    expect(fixtures).toHaveLength(20);
    expect(new Set(fixtures.map(({ bytes }) => sha256(bytes))).size).toBe(20);
    expect(MUTATING_PDF_TOOLS.map(({ name }) => name).sort()).toEqual(
      discoveredMutatingPdfTools,
    );
  });

  it.each(MUTATING_PDF_TOOLS)("isolates $name corpus in a fresh bounded server subprocess", async tool => {
    await runIsolatedToolCorpus({ root, tool, fixtures });
  }, 60_000);

  describe.each(MALFORMED_FIXTURES)("$name mutation containment", fixture => {
    it.each(MUTATING_PDF_TOOLS)("rejects $name with absent and preexisting targets", async tool => {
        for (const targetMode of ["absent", "preexisting"]) {
          const caseDirectory = path.join(
            stateRoot,
            "cases",
            fixture.name,
            tool.name,
            targetMode,
          );
          const outputDirectory = path.join(caseDirectory, "outputs");
          const inputPath = path.join(caseDirectory, "malformed.pdf");
          const outputPath = path.join(outputDirectory, "result.pdf");
          await fs.mkdir(outputDirectory, { recursive: true });
          await fs.writeFile(inputPath, fixture.bytes, { mode: 0o600 });
          const expectedOutput = expectedPrimaryOutput(tool.name, {
            inputPath,
            outputPath,
            outputDirectory,
          });
          if (targetMode === "preexisting") {
            await fs.writeFile(expectedOutput, "preexisting output sentinel", { mode: 0o600 });
          }
          await fs.writeFile(
            path.join(outputDirectory, "unrelated-sentinel.txt"),
            "must remain unchanged",
            { mode: 0o600 },
          );
          const before = await snapshotTree(caseDirectory);
          const replacementArguments = targetMode === "preexisting"
            ? await exactReplacementArguments(tool.name, expectedOutput)
            : {};

          const result = await callToolBounded(client, {
            name: tool.name,
            arguments: {
              ...tool.argumentsFor({
                inputPath,
                outputPath,
                outputDirectory,
                csvPath,
                validControlPath,
              }),
              ...replacementArguments,
            },
          });

          expectCleanToolError(
            result,
            fixture.name,
            `${tool.name}-${targetMode}`,
            toolsWithOutputSchema.has(tool.name),
            stateRoot,
          );
          expect(
            await snapshotTree(caseDirectory),
            `${fixture.name}/${tool.name}/${targetMode} must preserve the complete file inventory`,
          ).toEqual(before);
          expect(serverClosedUnexpectedly, `${fixture.name}/${tool.name} server close`).toBe(false);
          expect(serverErrors, `${fixture.name}/${tool.name} transport errors`).toEqual([]);
          expect(transport.pid, `${fixture.name}/${tool.name} stable server pid`).toBe(serverPid);
        }
    }, 15_000);

    it("preserves secondary-input, directory, same-file and active-document state", async () => {
      const mergeCaseDirectory = path.join(
        stateRoot,
        "cases",
        fixture.name,
        "merge_pdfs-malformed-second",
      );
      for (const targetMode of ["absent", "preexisting"]) {
        const modeDirectory = path.join(mergeCaseDirectory, targetMode);
        const modeOutputDirectory = path.join(modeDirectory, "outputs");
        const modeInputPath = path.join(modeDirectory, "malformed.pdf");
        const modeOutputPath = path.join(modeOutputDirectory, "result.pdf");
        await fs.mkdir(modeOutputDirectory, { recursive: true });
        await fs.writeFile(modeInputPath, fixture.bytes, { mode: 0o600 });
        if (targetMode === "preexisting") {
          await fs.writeFile(modeOutputPath, "preexisting merge sentinel", { mode: 0o600 });
        }
        const mergeBefore = await snapshotTree(modeDirectory);
        const replacementArguments = targetMode === "preexisting"
          ? await exactReplacementArguments("merge_pdfs", modeOutputPath)
          : {};
        const mergeSecondResult = await callToolBounded(client, {
          name: "merge_pdfs",
          arguments: {
            input_paths: [validControlPath, modeInputPath],
            output_path: modeOutputPath,
            ...replacementArguments,
          },
        });
        expectCleanToolError(
          mergeSecondResult,
          fixture.name,
          `merge_pdfs-malformed-second-${targetMode}`,
          toolsWithOutputSchema.has("merge_pdfs"),
          stateRoot,
        );
        expect(await snapshotTree(modeDirectory)).toEqual(mergeBefore);
      }

      const splitAbsentRoot = path.join(
        stateRoot,
        "directory-timing-cases",
        fixture.name,
        "split_pdf",
      );
      const splitAbsentInput = path.join(splitAbsentRoot, "malformed.pdf");
      const splitAbsentOutput = path.join(splitAbsentRoot, "not-created");
      await fs.mkdir(splitAbsentRoot, { recursive: true });
      await fs.writeFile(splitAbsentInput, fixture.bytes, { mode: 0o600 });
      const splitAbsentBefore = await snapshotTree(splitAbsentRoot);
      const splitAbsentResult = await callToolBounded(client, {
        name: "split_pdf",
        arguments: {
          input_path: splitAbsentInput,
          page_ranges: "1",
          output_directory: splitAbsentOutput,
        },
      });
      expectCleanToolError(
        splitAbsentResult,
        fixture.name,
        "split_pdf-absent-output-directory",
        toolsWithOutputSchema.has("split_pdf"),
        stateRoot,
      );
      expect(await snapshotTree(splitAbsentRoot)).toEqual(splitAbsentBefore);
      await expect(fs.access(splitAbsentOutput)).rejects.toMatchObject({ code: "ENOENT" });

      const bulkAbsentRoot = path.join(
        stateRoot,
        "directory-timing-cases",
        fixture.name,
        "bulk_fill_from_csv",
      );
      const bulkAbsentInput = path.join(bulkAbsentRoot, "malformed.pdf");
      const bulkAbsentOutput = path.join(bulkAbsentRoot, "created-empty");
      await fs.mkdir(bulkAbsentRoot, { recursive: true });
      await fs.writeFile(bulkAbsentInput, fixture.bytes, { mode: 0o600 });
      const bulkAbsentBefore = await snapshotTree(bulkAbsentRoot);
      const bulkAbsentResult = await callToolBounded(client, {
        name: "bulk_fill_from_csv",
        arguments: {
          pdf_path: bulkAbsentInput,
          csv_path: csvPath,
          output_directory: bulkAbsentOutput,
          filename_column: "filename",
        },
      });
      expectCleanToolError(
        bulkAbsentResult,
        fixture.name,
        "bulk_fill_from_csv-absent-output-directory",
        toolsWithOutputSchema.has("bulk_fill_from_csv"),
        stateRoot,
      );
      const bulkAbsentAfter = await snapshotTree(bulkAbsentRoot);
      expect(bulkAbsentAfter["malformed.pdf"]).toEqual(bulkAbsentBefore["malformed.pdf"]);
      expect(Object.keys(bulkAbsentAfter).sort()).toEqual([
        "created-empty/",
        "malformed.pdf",
      ]);
      await expect(fs.readdir(bulkAbsentOutput)).resolves.toEqual([]);

      for (const tool of MUTATING_PDF_TOOLS.filter(({ name }) =>
        SAME_PATH_MUTATING_TOOLS.has(name))) {
        const samePathDirectory = path.join(
          stateRoot,
          "same-path-cases",
          fixture.name,
          tool.name,
        );
        const inputPath = path.join(samePathDirectory, "malformed.pdf");
        await fs.mkdir(samePathDirectory, { recursive: true });
        await fs.writeFile(inputPath, fixture.bytes, { mode: 0o600 });
        const caseBefore = await snapshotTree(samePathDirectory);
        const backupsBefore = await snapshotTree(path.join(profilesDirectory, "backups"));
        const result = await callToolBounded(client, {
          name: tool.name,
          arguments: tool.argumentsFor({
            inputPath,
            outputPath: inputPath,
            outputDirectory: samePathDirectory,
            csvPath,
            validControlPath,
          }),
        });
        expectCleanToolError(
          result,
          fixture.name,
          `${tool.name}-same-path`,
          toolsWithOutputSchema.has(tool.name),
          stateRoot,
        );
        expect(
          await snapshotTree(samePathDirectory),
          `${fixture.name}/${tool.name} same-path input must remain byte-identical`,
        ).toEqual(caseBefore);
        expect(
          await snapshotTree(path.join(profilesDirectory, "backups")),
          `${fixture.name}/${tool.name} must not create a malformed-input backup`,
        ).toEqual(backupsBefore);
        expect(serverClosedUnexpectedly, `${fixture.name}/${tool.name} same-path close`).toBe(false);
        expect(serverErrors, `${fixture.name}/${tool.name} same-path transport errors`).toEqual([]);
        expect(transport.pid, `${fixture.name}/${tool.name} same-path stable pid`).toBe(serverPid);
      }

      for (const tool of MUTATING_PDF_TOOLS.filter(({ name }) =>
        SAME_FILE_REJECTING_TOOLS.has(name))) {
        const sameFileDirectory = path.join(
          stateRoot,
          "same-file-rejection-cases",
          fixture.name,
          tool.name,
        );
        const inputPath = path.join(sameFileDirectory, "malformed.pdf");
        await fs.mkdir(sameFileDirectory, { recursive: true });
        await fs.writeFile(inputPath, fixture.bytes, { mode: 0o600 });
        const caseBefore = await snapshotTree(sameFileDirectory);
        const backupsBefore = await snapshotTree(path.join(profilesDirectory, "backups"));
        const result = await callToolBounded(client, {
          name: tool.name,
          arguments: tool.argumentsFor({
            inputPath,
            outputPath: inputPath,
            outputDirectory: sameFileDirectory,
            csvPath,
            validControlPath,
          }),
        });
        expect(result.isError, `${fixture.name}/${tool.name} same-file policy`).toBe(true);
        expect(result.content?.[0]?.text).toMatch(/^Error: .*must be different/i);
        expect(result.content?.[0]?.text).not.toContain(stateRoot);
        if (toolsWithOutputSchema.has(tool.name)) {
          expect(result.structuredContent).toEqual({
            status: "failed",
            error: {
              error_schema_version: 1,
              code: "tool_execution_failed",
            },
          });
        }
        expect(await snapshotTree(sameFileDirectory)).toEqual(caseBefore);
        expect(await snapshotTree(path.join(profilesDirectory, "backups"))).toEqual(backupsBefore);
        expect(serverClosedUnexpectedly, `${fixture.name}/${tool.name} same-file close`).toBe(false);
        expect(serverErrors, `${fixture.name}/${tool.name} same-file transport errors`).toEqual([]);
        expect(transport.pid, `${fixture.name}/${tool.name} same-file stable pid`).toBe(serverPid);
      }

      const activeAfterFixture = await callToolBounded(client, {
        name: "get_active_document",
        arguments: {},
      });
      expect(activeAfterFixture.isError).not.toBe(true);
      expect(
        activeDocumentIdentity(activeAfterFixture),
        `${fixture.name} must not change active-document state`,
      ).toEqual(controlActiveDocument);
      expect(
        (await client.listTools(
          {},
          { timeout: TOOL_CALL_TIMEOUT_MS, maxTotalTimeout: TOOL_CALL_TIMEOUT_MS },
        )).tools.length,
        `${fixture.name} liveness probe`,
      ).toBeGreaterThan(0);
    expect(Buffer.byteLength(stderrText, "utf8")).toBeLessThanOrEqual(1_000_000);
    expect(stderrText).not.toMatch(/fatal error|uncaught|unhandled rejection/i);
    }, 60_000);
  });
});
