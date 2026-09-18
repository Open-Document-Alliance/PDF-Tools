#!/usr/bin/env node

import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { constants as fsConstants } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { AjvJsonSchemaValidator } from "@modelcontextprotocol/sdk/validation/ajv";

const SHA256 = /^[a-f0-9]{64}$/;
const MAX_ARTIFACT_BYTES = 512 * 1024 * 1024;
const MAX_METADATA_BYTES = 1024 * 1024;
const MAX_STDERR_BYTES = 1024 * 1024;
const execFileAsync = promisify(execFile);
const PACKED_RUNTIME_FILES = [
  ["package_json", "package.json"],
  ["server_entry", "server/index.js"],
  ["output_schemas", "server/output-schemas.js"],
  ["pdfjs_subprocess", "server/pdfjs-subprocess.js"],
  ["pdfjs_worker", "server/pdfjs-worker.js"],
  ["layout_extraction", "server/layout-extraction.js"],
  ["type3_cm_reference", "server/type3-cm-reference.js"],
  ["markdown_conversion", "server/markdown-conversion.js"],
  ["markdown_transaction", "server/markdown-output-transaction.js"],
];
const REQUIRED_OPTIONS = [
  "--artifact",
  "--artifact-sha256",
  "--manifest",
  "--manifest-sha256",
  "--output",
  "--receipt",
  "--receipt-sha256",
  "--receipt-schema",
  "--receipt-schema-sha256",
];

export function validateMarkdownDiscovery(tools) {
  if (!Array.isArray(tools)
    || tools.length !== 43
    || !tools.some(tool => tool.name === "convert_pdf_to_markdown")
    || !tools.some(tool => tool.name === "inspect_pdf_accessibility")) {
    throw new Error("Packed Markdown bakeoff discovery differs from the current 43-tool contract");
  }
}

export function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function exactOptions(argv) {
  if (argv.length !== REQUIRED_OPTIONS.length * 2) {
    throw new Error(`Expected exactly: ${REQUIRED_OPTIONS.join(", ")}`);
  }
  const values = {};
  for (let index = 0; index < argv.length; index += 2) {
    const name = argv[index];
    const value = argv[index + 1];
    if (!REQUIRED_OPTIONS.includes(name) || Object.hasOwn(values, name) || !value) {
      throw new Error(`Unknown, duplicate, or empty option: ${name}`);
    }
    values[name] = value;
  }
  if (Object.keys(values).length !== REQUIRED_OPTIONS.length) throw new Error("Required bakeoff options are missing");
  return values;
}

async function canonicalDirectory(filename, label) {
  if (!path.isAbsolute(filename) || path.resolve(filename) !== filename) {
    throw new Error(`${label} must be an absolute normalized path`);
  }
  const [real, metadata] = await Promise.all([fs.realpath(filename), fs.lstat(filename)]);
  if (real !== filename || !metadata.isDirectory() || metadata.isSymbolicLink()) {
    throw new Error(`${label} must be a canonical regular directory`);
  }
  return filename;
}

async function stableFile(filename, maximumBytes, label) {
  if (!path.isAbsolute(filename) || path.resolve(filename) !== filename || typeof fsConstants.O_NOFOLLOW !== "number") {
    throw new Error(`${label} path or runtime support is invalid`);
  }
  const real = await fs.realpath(filename);
  if (real !== filename) throw new Error(`${label} must be a canonical regular file`);
  const pathnameBefore = await fs.lstat(filename, { bigint: true });
  if (!pathnameBefore.isFile() || pathnameBefore.isSymbolicLink() || pathnameBefore.nlink !== 1n
    || pathnameBefore.size < 1n || pathnameBefore.size > BigInt(maximumBytes)) {
    throw new Error(`${label} violates its bounded regular-file contract`);
  }
  const handle = await fs.open(filename, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW);
  try {
    const descriptorBefore = await handle.stat({ bigint: true });
    const sameIdentity = (left, right) => ["dev", "ino", "size", "mtimeNs", "ctimeNs"]
      .every(key => String(left[key]) === String(right[key]));
    if (!descriptorBefore.isFile() || !sameIdentity(pathnameBefore, descriptorBefore)) {
      throw new Error(`${label} pathname differs from its open descriptor`);
    }
    const bytes = await handle.readFile();
    const [descriptorAfter, pathnameAfter] = await Promise.all([
      handle.stat({ bigint: true }),
      fs.lstat(filename, { bigint: true }),
    ]);
    if (!sameIdentity(descriptorBefore, descriptorAfter) || !sameIdentity(descriptorBefore, pathnameAfter)
      || BigInt(bytes.length) !== descriptorBefore.size) {
      throw new Error(`${label} changed while read`);
    }
    return bytes;
  } finally {
    await handle.close();
  }
}

function parseJson(bytes, label) {
  try {
    return JSON.parse(bytes.toString("utf8"));
  } catch (error) {
    throw new Error(`${label} is not JSON: ${error.message}`);
  }
}

async function extractArtifact(artifactPath, outputRoot) {
  const extractionRoot = await fs.mkdtemp(path.join(outputRoot, ".mcpb-extract-"));
  await fs.chmod(extractionRoot, 0o700);
  const options = {
    env: { LANG: "C", LC_ALL: "C", PATH: "/usr/bin:/bin" },
    maxBuffer: MAX_STDERR_BYTES,
    timeout: 120000,
  };
  try {
    await execFileAsync("/usr/bin/unzip", ["-tqq", artifactPath], options);
    await execFileAsync("/usr/bin/unzip", ["-q", artifactPath, "-d", extractionRoot], options);
    return await canonicalDirectory(extractionRoot, "fresh MCPB extraction root");
  } catch (error) {
    await fs.rm(extractionRoot, { recursive: true, force: true }).catch(() => {});
    throw new Error(`MCPB extraction failed: ${error.message}`);
  }
}

export function validateReceipt(receipt, schema) {
  // A calibration-bootstrap handoff exists solely to re-measure a stale
  // supervisor calibration; its receipt must never feed this runner's scored
  // bakeoff report. Same trust decision, same ordering, as the capture
  // runner's refusal: before shape validation.
  if (receipt?.calibration_bootstrap === true) {
    throw new Error(
      "Docling receipt was produced by a calibration-bootstrap handoff and cannot produce qualifying or scored evidence",
    );
  }
  const validation = new AjvJsonSchemaValidator().getValidator(schema)(receipt);
  if (!validation.valid) throw new Error(`Docling receipt schema validation failed: ${validation.errorMessage}`);
  const identityDigest = sha256(Buffer.from(
    `pdf-tools.docling-macos-handoff.v1\0${canonicalJson(receipt.identity)}`,
  ));
  if (identityDigest !== receipt.handoff_id) throw new Error("Docling receipt identity digest is invalid");
  if (canonicalJson(receipt.identity.inputs) !== canonicalJson(receipt.inputs)
    || canonicalJson(receipt.identity.fixtures) !== canonicalJson(receipt.fixtures)) {
    throw new Error("Docling receipt identity does not bind the exact retained inventories");
  }
}

export function validateFixtureBindings(manifest, receipt) {
  if (manifest?.suite_id !== "pdf-tools.extraction.phase0" || !Array.isArray(manifest.fixtures)
    || manifest.manifest_version !== 1 || manifest.suite_version !== "v0.1.0"
    || manifest.fixtures.length !== 8
    || !Array.isArray(receipt?.fixtures) || receipt.fixtures.length !== manifest.fixtures.length
    || receipt.protocol !== "pdf-tools.docling-macos-handoff.v1" || !SHA256.test(receipt.handoff_id ?? "")) {
    throw new Error("Manifest and receipt fixture sets are invalid");
  }
  return manifest.fixtures.map((fixture, index) => {
    const retained = receipt.fixtures[index];
    const digestPrefix = typeof fixture?.sha256 === "string" ? fixture.sha256.slice(0, 12) : "";
    const expectedFilename = `source-${String(index + 1).padStart(3, "0")}-${digestPrefix}.pdf`;
    if (!fixture || typeof fixture.id !== "string" || typeof fixture.category !== "string"
      || typeof fixture.partition !== "string"
      || !SHA256.test(fixture.sha256 ?? "") || !retained || retained.ordinal !== index + 1
      || retained.filename !== expectedFilename
      || retained.sha256 !== fixture.sha256 || !Number.isSafeInteger(retained.bytes) || retained.bytes < 1) {
      throw new Error(`Manifest and receipt differ at fixture ${index + 1}`);
    }
    const pageCount = fixture.expected?.pages?.length;
    if (!Number.isSafeInteger(pageCount) || pageCount < 1 || pageCount > 10) {
      throw new Error(`Fixture ${fixture.id} has an invalid bounded page count`);
    }
    return { fixture, retained, pageCount };
  });
}

export function validateMarkdownResult(result, binding) {
  if (!result || result.isError === true || !result.structuredContent) {
    throw new Error(`Markdown conversion failed for ${binding.fixture.id}`);
  }
  const value = result.structuredContent;
  if (value.renderer?.name !== "pdf-tools.layout-markdown-renderer" || value.renderer?.version !== "1.21.0"
    || value.options?.include_page_boundaries !== true || value.limits?.max_markdown_bytes !== 200000
    || value.provenance?.source?.file_name !== binding.retained.filename
    || value.provenance?.source?.sha256 !== binding.retained.sha256
    || value.provenance?.source?.size_bytes !== binding.retained.bytes
    || value.provenance?.layout?.parser_name !== "pdfjs-dist"
    || value.provenance?.layout?.parser_version !== "5.4.624"
    || value.provenance?.layout?.page_range?.start_page !== 1
    || value.provenance?.layout?.page_range?.end_page !== binding.pageCount
    || value.provenance?.layout?.page_range?.total_pages !== binding.pageCount
    || value.saved_output !== null || typeof value.markdown !== "string"
    || value.markdown_bytes !== Buffer.byteLength(value.markdown, "utf8")
    || value.markdown_sha256 !== sha256(Buffer.from(value.markdown, "utf8"))
    || !["complete", "partial", "failed"].includes(value.conversion_status)
    || !Array.isArray(value.pages) || value.pages.length !== binding.pageCount
    || value.pages.some((page, index) => page?.page !== index + 1
      || !["complete", "partial", "failed"].includes(page.conversion_status)
      || !Number.isSafeInteger(page.markdown_bytes) || page.markdown_bytes < 0
      || !Number.isSafeInteger(page.line_count) || page.line_count < 0
      || !Number.isSafeInteger(page.rendered_line_count) || page.rendered_line_count < 0
      || !Array.isArray(page.gaps))
    || !Array.isArray(value.gaps) || !Array.isArray(value.limitations)) {
    throw new Error(`Markdown result evidence is invalid for ${binding.fixture.id}`);
  }
  return value;
}

async function runOne({ extensionRoot, fixtureRoot, fixturePath, outputRoot, binding }) {
  const stderrChunks = [];
  let stderrBytes = 0;
  const stateRoot = await fs.mkdtemp(path.join(outputRoot, ".markdown-state-"));
  await fs.chmod(stateRoot, 0o700);
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [path.join(extensionRoot, "server", "index.js")],
    cwd: extensionRoot,
    env: {
      ALLOWED_DIRECTORIES: fixtureRoot,
      DEFAULT_DOWNLOAD_DIR: stateRoot,
      DEFAULT_PDF_DIR: fixtureRoot,
      DEFAULT_PROFILES_DIR: path.join(stateRoot, "profiles"),
      HOME: stateRoot,
      LANG: "C",
      LC_ALL: "C",
      PATH: "/usr/bin:/bin",
      PDF_TOOLS_DISABLE_SYSTEM_RENDERER: "1",
    },
    stderr: "pipe",
  });
  transport.stderr?.on("data", chunk => {
    stderrBytes += chunk.length;
    if (stderrBytes <= MAX_STDERR_BYTES) stderrChunks.push(chunk);
  });
  const client = new Client({ name: "pdf-tools-markdown-bakeoff", version: "1.0.0" });
  const startedAt = process.hrtime.bigint();
  let value;
  let pid;
  let elapsedMs;
  try {
    await client.connect(transport, { timeout: 30000, maxTotalTimeout: 30000 });
    pid = transport.pid;
    if (!Number.isSafeInteger(pid) || pid < 1) throw new Error("Packed Markdown server PID is unavailable");
    const discovery = await client.listTools();
    validateMarkdownDiscovery(discovery.tools);
    const result = await client.callTool({
      name: "convert_pdf_to_markdown",
      arguments: {
        pdf_path: fixturePath,
        start_page: 1,
        end_page: binding.pageCount,
        include_page_boundaries: true,
        max_items: 5000,
        max_characters: 100000,
        max_markdown_bytes: 200000,
      },
    }, undefined, { timeout: 120000, maxTotalTimeout: 120000 });
    value = validateMarkdownResult(result, binding);
    elapsedMs = Number(process.hrtime.bigint() - startedAt) / 1e6;
  } finally {
    await client.close().catch(() => {});
    await transport.close().catch(() => {});
    await fs.rm(stateRoot, { recursive: true, force: true });
    if (stderrBytes > MAX_STDERR_BYTES) throw new Error("Packed Markdown server stderr exceeded 1 MiB");
  }
  const stderr = Buffer.concat(stderrChunks);
  return {
    elapsed_ms: elapsedMs,
    pid,
    result: value,
    result_sha256: sha256(Buffer.from(canonicalJson(value))),
    stderr: { bytes: stderr.length, sha256: sha256(stderr) },
  };
}

async function writeExclusive(filename, bytes) {
  const parent = await canonicalDirectory(path.dirname(filename), "output parent");
  const handle = await fs.open(filename, fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL | fsConstants.O_NOFOLLOW, 0o600);
  try {
    await handle.writeFile(bytes);
    await handle.sync();
  } finally {
    await handle.close();
  }
  const metadata = await fs.lstat(filename);
  if (!metadata.isFile() || metadata.isSymbolicLink() || metadata.nlink !== 1 || (metadata.mode & 0o777) !== 0o600
    || await fs.realpath(path.dirname(filename)) !== parent) {
    throw new Error("Bakeoff output violates its private regular-file contract");
  }
}

export async function runMarkdownBakeoff(options) {
  const artifactSha256 = options["--artifact-sha256"];
  const manifestSha256 = options["--manifest-sha256"];
  const receiptSha256 = options["--receipt-sha256"];
  const receiptSchemaSha256 = options["--receipt-schema-sha256"];
  if (![artifactSha256, manifestSha256, receiptSha256, receiptSchemaSha256].every(value => SHA256.test(value ?? ""))) {
    throw new Error("One or more expected SHA-256 values are invalid");
  }
  const artifactPath = path.resolve(options["--artifact"]);
  const manifestPath = path.resolve(options["--manifest"]);
  const receiptPath = path.resolve(options["--receipt"]);
  const receiptSchemaPath = path.resolve(options["--receipt-schema"]);
  const outputPath = path.resolve(options["--output"]);
  const outputRoot = await canonicalDirectory(path.dirname(outputPath), "output parent");
  const [artifactBytes, manifestBytes, receiptBytes, receiptSchemaBytes] = await Promise.all([
    stableFile(artifactPath, MAX_ARTIFACT_BYTES, "MCPB artifact"),
    stableFile(manifestPath, MAX_METADATA_BYTES, "manifest"),
    stableFile(receiptPath, MAX_METADATA_BYTES, "receipt"),
    stableFile(receiptSchemaPath, MAX_METADATA_BYTES, "receipt schema"),
  ]);
  if (sha256(artifactBytes) !== artifactSha256 || sha256(manifestBytes) !== manifestSha256
    || sha256(receiptBytes) !== receiptSha256 || sha256(receiptSchemaBytes) !== receiptSchemaSha256) {
    throw new Error("One or more retained inputs differ from their expected SHA-256 values");
  }
  const manifest = parseJson(manifestBytes, "manifest");
  const receipt = parseJson(receiptBytes, "receipt");
  const receiptSchema = parseJson(receiptSchemaBytes, "receipt schema");
  validateReceipt(receipt, receiptSchema);
  const bindings = validateFixtureBindings(manifest, receipt);
  const fixtureRoot = await canonicalDirectory(path.join(path.dirname(receiptPath), "fixtures"), "retained fixture root");
  const sourceBytesById = new Map();
  for (const binding of bindings) {
    const fixturePath = path.join(fixtureRoot, binding.retained.filename);
    const fixtureBytes = await stableFile(fixturePath, 1024 * 1024 * 1024, `fixture ${binding.fixture.id}`);
    if (fixtureBytes.length !== binding.retained.bytes || sha256(fixtureBytes) !== binding.retained.sha256) {
      throw new Error(`Retained fixture bytes differ for ${binding.fixture.id}`);
    }
    sourceBytesById.set(binding.fixture.id, fixtureBytes);
  }
  const extensionRoot = await extractArtifact(artifactPath, outputRoot);
  let reportBytes;
  let caseCount;
  try {
    const runtimeBytes = await Promise.all(PACKED_RUNTIME_FILES.map(([, relativePath]) => stableFile(
      path.join(extensionRoot, relativePath),
      MAX_METADATA_BYTES,
      `packed runtime file ${relativePath}`,
    )));
    const packageJson = parseJson(runtimeBytes[0], "packed package");
    if (packageJson.dependencies?.["pdfjs-dist"] !== "5.4.624") {
      throw new Error("Packed PDF.js pin differs from 5.4.624");
    }
    const cases = [];
    for (const binding of bindings) {
      const fixturePath = path.join(fixtureRoot, binding.retained.filename);
      const runs = [];
      for (let repetition = 1; repetition <= 3; repetition += 1) {
        const observed = await runOne({ extensionRoot, fixtureRoot, fixturePath, outputRoot, binding });
        runs.push({
          repetition,
          pid: observed.pid,
          elapsed_ms: observed.elapsed_ms,
          result_sha256: observed.result_sha256,
          stderr: observed.stderr,
        });
        if (repetition === 1) runs[0].result = observed.result;
      }
      if (new Set(runs.map(run => run.result_sha256)).size !== 1
        || new Set(runs.map(run => run.pid)).size !== 3) {
        throw new Error(`Fresh packed process evidence is invalid for ${binding.fixture.id}`);
      }
      cases.push({
        case_id: binding.fixture.id,
        category: binding.fixture.category,
        partition: binding.fixture.partition,
        page_count: binding.pageCount,
        source_bytes: binding.retained.bytes,
        source_sha256: binding.retained.sha256,
        source_reopened_verified: true,
        stable: true,
        runs,
      });
    }
    for (const binding of bindings) {
      const reopened = await stableFile(
        path.join(fixtureRoot, binding.retained.filename),
        1024 * 1024 * 1024,
        `reopened fixture ${binding.fixture.id}`,
      );
      if (!reopened.equals(sourceBytesById.get(binding.fixture.id))) {
        throw new Error(`Retained fixture changed during the bakeoff: ${binding.fixture.id}`);
      }
    }
    const reopenedRuntimeBytes = await Promise.all(PACKED_RUNTIME_FILES.map(([, relativePath]) => stableFile(
      path.join(extensionRoot, relativePath),
      MAX_METADATA_BYTES,
      `reopened packed runtime file ${relativePath}`,
    )));
    const runtimeFiles = Object.fromEntries(PACKED_RUNTIME_FILES.map(([name, relativePath], index) => {
      const before = runtimeBytes[index];
      const after = reopenedRuntimeBytes[index];
      if (!before.equals(after)) throw new Error(`Packed runtime file changed during the bakeoff: ${relativePath}`);
      return [name, {
        path: relativePath,
        bytes: before.length,
        sha256: sha256(before),
        reopened_verified: true,
      }];
    }));
    const report = {
      protocol: "pdf-tools.markdown-bakeoff.v1",
      artifact: {
        sha256: artifactSha256,
        bytes: artifactBytes.length,
        extraction: { method: "/usr/bin/unzip", archive_crc_verified: true, fresh: true, cleaned: true },
        pdfjs_dist: packageJson.dependencies["pdfjs-dist"],
        runtime_files: runtimeFiles,
      },
      source_bindings: {
        handoff_id: receipt.handoff_id,
        receipt_sha256: receiptSha256,
        receipt_schema_sha256: receiptSchemaSha256,
        manifest_sha256: manifestSha256,
      },
      runtime: { node: process.version, platform: process.platform, architecture: process.arch },
      repetitions_per_case: 3,
      cases,
    };
    caseCount = cases.length;
    reportBytes = Buffer.from(`${canonicalJson(report)}\n`);
  } finally {
    await fs.rm(extensionRoot, { recursive: true, force: true });
  }
  await writeExclusive(outputPath, reportBytes);
  return { output: outputPath, bytes: reportBytes.length, sha256: sha256(reportBytes), cases: caseCount };
}

async function main() {
  const result = await runMarkdownBakeoff(exactOptions(process.argv.slice(2)));
  process.stdout.write(`${JSON.stringify(result)}\n`);
}

if (path.resolve(process.argv[1] ?? "") === fileURLToPath(import.meta.url)) {
  main().catch(error => {
    process.stderr.write(`Markdown bakeoff failed: ${error.message}\n`);
    process.exitCode = 1;
  });
}
