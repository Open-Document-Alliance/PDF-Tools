import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { classifyEvidencePrecondition } from "../helpers/evidence-preconditions.js";
import { prepareDoclingMacHandoffForTest } from "./extraction-docling-handoff.js";
import {
  canonicalJson,
  runMarkdownBakeoff,
  validateMarkdownDiscovery,
  validateFixtureBindings,
  validateMarkdownResult,
} from "../../scripts/eval-run-markdown-bakeoff.mjs";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const SOURCE_MANIFEST = path.join(REPO_ROOT, "test/fixtures/eval/extraction/manifest.v1.json");
const RECEIPT_SCHEMA = path.join(REPO_ROOT, "test/fixtures/eval/extraction/phase1/docling-handoff.schema.json");
const execFileAsync = promisify(execFile);

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

const FAKE_PACKED_SERVER = String.raw`import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";

const MUTATE_SOURCE = false;

function digest(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

function send(id, result) {
  process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id, result }) + "\n");
}

async function handle(message) {
  if (!Object.hasOwn(message, "id")) return;
  if (message.method === "initialize") {
    send(message.id, {
      protocolVersion: message.params.protocolVersion,
      capabilities: { tools: {} },
      serverInfo: { name: "packed-bakeoff-fixture", version: "1.0.0" },
    });
    return;
  }
  if (message.method === "tools/list") {
    const tools = Array.from({ length: 40 }, (_, index) => ({
      name: "fixture_tool_" + String(index + 1).padStart(2, "0"),
      inputSchema: { type: "object" },
    }));
    tools.push({ name: "convert_pdf_to_markdown", inputSchema: { type: "object" } });
    tools.push({ name: "inspect_pdf_accessibility", inputSchema: { type: "object" } });
    send(message.id, { tools });
    return;
  }
  if (message.method === "tools/call" && message.params.name === "convert_pdf_to_markdown") {
    const args = message.params.arguments;
    const source = await fs.readFile(args.pdf_path);
    const pageCount = args.end_page;
    const pageBoundaries = Array.from({ length: pageCount }, (_, index) => "<!-- PDF page " + (index + 1) + " -->");
    const markdown = pageBoundaries.join("\n\n") + "\n\nINV-1001 fixture evidence\n";
    const value = {
      renderer: { name: "pdf-tools.layout-markdown-renderer", version: "1.20.1" },
      conversion_status: "complete",
      markdown,
      markdown_sha256: digest(Buffer.from(markdown)),
      markdown_bytes: Buffer.byteLength(markdown),
      options: { include_page_boundaries: true },
      limits: { max_markdown_bytes: 200000 },
      pages: Array.from({ length: pageCount }, (_, index) => ({
        page: index + 1,
        conversion_status: "complete",
        markdown_bytes: 1,
        line_count: 1,
        rendered_line_count: 1,
        gaps: [],
      })),
      gaps: [],
      limitations: [],
      provenance: {
        source: { file_name: path.basename(args.pdf_path), sha256: digest(source), size_bytes: source.length },
        layout: {
          name: "pdf-tools.extraction-ir",
          version: "1.0.0",
          parser_name: "pdfjs-dist",
          parser_version: "5.4.624",
          page_range: { start_page: 1, end_page: pageCount, total_pages: pageCount },
        },
      },
      saved_output: null,
    };
    if (MUTATE_SOURCE) await fs.appendFile(args.pdf_path, "changed");
    send(message.id, { content: [{ type: "text", text: "fixture" }], structuredContent: value });
    return;
  }
  send(message.id, { tools: [] });
}

let pending = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", chunk => {
  pending += chunk;
  while (pending.includes("\n")) {
    const boundary = pending.indexOf("\n");
    const line = pending.slice(0, boundary);
    pending = pending.slice(boundary + 1);
    if (line) handle(JSON.parse(line)).catch(error => process.stderr.write(error.message + "\n"));
  }
});
`;

describe("Markdown bakeoff discovery binding", () => {
  const currentTools = [
    ...Array.from({ length: 41 }, (_, index) => ({ name: `fixture_tool_${index}` })),
    { name: "convert_pdf_to_markdown" },
    { name: "inspect_pdf_accessibility" },
  ];

  it("accepts only the current 43-tool discovery", () => {
    expect(() => validateMarkdownDiscovery(currentTools)).not.toThrow();
    expect(() => validateMarkdownDiscovery(currentTools.slice(1))).toThrow(/43-tool contract/);
  });

  it("requires both current lane tools", () => {
    expect(() => validateMarkdownDiscovery(
      currentTools.map(tool => tool.name === "inspect_pdf_accessibility" ? { name: "stale_tool" } : tool),
    )).toThrow(/43-tool contract/);
  });
});

async function createFakeArtifact(root, label = "approved", mutateSource = false) {
  const staging = path.join(root, `packed-staging-${label}`);
  const server = path.join(staging, "server");
  await fs.mkdir(server, { recursive: true, mode: 0o700 });
  const packageJson = {
    name: "packed-bakeoff-fixture",
    version: "1.0.0",
    type: "module",
    dependencies: { "pdfjs-dist": "5.4.624" },
  };
  await Promise.all([
    fs.writeFile(path.join(staging, "package.json"), `${JSON.stringify(packageJson)}\n`),
    fs.writeFile(
      path.join(server, "index.js"),
      FAKE_PACKED_SERVER.replace("const MUTATE_SOURCE = false;", `const MUTATE_SOURCE = ${mutateSource};`),
    ),
    fs.writeFile(path.join(server, "output-schemas.js"), "export const schemas = {};\n"),
    fs.writeFile(path.join(server, "pdfjs-subprocess.js"), "export const subprocess = {};\n"),
    fs.writeFile(path.join(server, "pdfjs-worker.js"), "export const worker = {};\n"),
    fs.writeFile(path.join(server, "layout-extraction.js"), "export const layout = {};\n"),
    fs.writeFile(path.join(server, "type3-cm-reference.js"), "export const reference = {};\n"),
    fs.writeFile(path.join(server, "markdown-conversion.js"), "export const markdown = {};\n"),
    fs.writeFile(path.join(server, "markdown-output-transaction.js"), "export const transaction = {};\n"),
  ]);
  const artifact = path.join(root, `${label}.mcpb`);
  await execFileAsync("/usr/bin/zip", ["-q", "-r", artifact, "."], { cwd: staging });
  return artifact;
}

function resultFor(binding) {
  const markdown = "<!-- PDF page 1 -->\n\nFixture text\n";
  return {
    structuredContent: {
      renderer: { name: "pdf-tools.layout-markdown-renderer", version: "1.20.1" },
      conversion_status: "complete",
      markdown,
      markdown_sha256: sha256(Buffer.from(markdown)),
      markdown_bytes: Buffer.byteLength(markdown),
      options: { include_page_boundaries: true },
      limits: { max_markdown_bytes: 200000 },
      pages: [{
        page: 1,
        conversion_status: "complete",
        markdown_bytes: Buffer.byteLength(markdown),
        line_count: 1,
        rendered_line_count: 1,
        gaps: [],
      }],
      gaps: [],
      limitations: [],
      provenance: {
        source: {
          file_name: binding.retained.filename,
          sha256: binding.retained.sha256,
          size_bytes: binding.retained.bytes,
        },
        layout: {
          name: "pdf-tools.extraction-ir",
          version: "1.0.0",
          parser_name: "pdfjs-dist",
          parser_version: "5.4.624",
          page_range: { start_page: 1, end_page: 1, total_pages: 1 },
        },
      },
      saved_output: null,
    },
  };
}

// Independent of the Docling handoff setup below, so a blocked or skipped
// packed bakeoff can never again hide a stale renderer version pin. Runs
// standalone with -t "renderer version".
describe("Markdown bakeoff renderer version binding", () => {
  const markdown = "# Title\n";
  const sourceBytes = Buffer.from("%PDF-1.7\n", "utf8");
  const binding = {
    fixture: { id: "renderer-version-guard" },
    retained: {
      filename: "guard.pdf",
      sha256: createHash("sha256").update(sourceBytes).digest("hex"),
      bytes: sourceBytes.length,
    },
    pageCount: 1,
  };
  const resultFor = version => ({
    isError: false,
    structuredContent: {
      renderer: { name: "pdf-tools.layout-markdown-renderer", version },
      options: { include_page_boundaries: true },
      limits: { max_markdown_bytes: 200000 },
      provenance: {
        source: {
          file_name: binding.retained.filename,
          sha256: binding.retained.sha256,
          size_bytes: binding.retained.bytes,
        },
        layout: {
          parser_name: "pdfjs-dist",
          parser_version: "5.4.624",
          page_range: { start_page: 1, end_page: 1, total_pages: 1 },
        },
      },
      saved_output: null,
      markdown,
      markdown_bytes: Buffer.byteLength(markdown, "utf8"),
      markdown_sha256: createHash("sha256").update(Buffer.from(markdown, "utf8")).digest("hex"),
      conversion_status: "complete",
      pages: [{
        page: 1,
        conversion_status: "complete",
        markdown_bytes: Buffer.byteLength(markdown, "utf8"),
        line_count: 1,
        rendered_line_count: 1,
        gaps: [],
      }],
      gaps: [],
      limitations: [],
    },
  });

  it("accepts the current renderer version and rejects all superseded ones", () => {
    expect(validateMarkdownResult(resultFor("1.20.1"), binding).renderer.version).toBe("1.20.1");
    for (const stale of ["1.0.0", "1.1.0", "1.2.0", "1.3.0", "1.4.0", "1.5.0", "1.6.0", "1.7.0", "1.8.0", "1.9.0", "1.10.0", "1.11.0", "1.12.0", "1.13.0", "1.14.0", "1.15.0", "1.16.0", "1.17.0", "1.18.0", "1.19.0", "1.20.0"]) {
      expect(() => validateMarkdownResult(resultFor(stale), binding), stale)
        .toThrow(/Markdown result evidence is invalid/u);
    }
  });
});

describe("packed Markdown bakeoff runner", () => {
  let evidenceSkipReason = null;
  let root;
  let bindings;
  let fixtureRoot;
  let manifest;
  let receipt;
  let options;

  beforeAll(async () => {
    try {
      root = await fs.realpath(
        await fs.mkdtemp(path.join(os.tmpdir(), "pdf-tools-markdown-bakeoff-")),
      );
      await fs.chmod(root, 0o700);
      const outputRoot = path.join(root, "output");
      await fs.mkdir(outputRoot, { mode: 0o700 });
      const manifestBytes = await fs.readFile(SOURCE_MANIFEST);
      const receiptSchemaBytes = await fs.readFile(RECEIPT_SCHEMA);
      manifest = JSON.parse(manifestBytes.toString("utf8"));
      const fixturePaths = manifest.fixtures.map(fixture => path.resolve(
        path.dirname(SOURCE_MANIFEST),
        fixture.path,
      ));
      const uvPath = path.join(root, "uv-test-binary");
      const uvVersion = "uv 0.11.29 (901092ee1 2026-07-15 aarch64-apple-darwin)";
      await fs.writeFile(uvPath, `#!/bin/sh\nprintf '%s\\n' '${uvVersion}'\n`, { mode: 0o700, flag: "wx" });
      const handoff = await prepareDoclingMacHandoffForTest({
        cacheRoot: path.join(root, "Library/Caches/oda-pdf-tools-extraction"),
        sidecarRoot: path.join(root, "Sites/pdf-tools-extraction-sidecars"),
        protectedRoots: [path.join(root, "Documents"), path.join(root, "Dropbox")],
        fixturePaths,
        testOnlyHost: {
          platform: "darwin",
          architecture: "arm64",
          os_build: "25G5065a",
          kernel_release: "25.6.0",
          node_version: process.version,
        },
        testOnlySupervisorBuild: {
          binaryBytes: Buffer.from("pdf-tools-test-only-supervisor-binary\n"),
        },
        testOnlyUv: { path: uvPath, version: uvVersion },
      });
      receipt = handoff.receipt;
      fixtureRoot = path.join(path.dirname(handoff.receiptPath), "fixtures");
      bindings = validateFixtureBindings(manifest, receipt);
      const artifactPath = await createFakeArtifact(root);
      const artifactBytes = await fs.readFile(artifactPath);
      options = {
        "--artifact": artifactPath,
        "--artifact-sha256": sha256(artifactBytes),
        "--manifest": SOURCE_MANIFEST,
        "--manifest-sha256": sha256(manifestBytes),
        "--output": path.join(outputRoot, "report.json"),
        "--receipt": handoff.receiptPath,
        "--receipt-sha256": handoff.receipt_sha256,
        "--receipt-schema": RECEIPT_SCHEMA,
        "--receipt-schema-sha256": sha256(receiptSchemaBytes),
      };
    } catch (error) {
      // An unmet evidence precondition is reported as a skip that names
      // what is required. Anything else still fails.
      const classified = classifyEvidencePrecondition(error);
      if (classified === null) throw error;
      evidenceSkipReason = classified.kind === "stale"
        ? `sealed evidence needs re-approval: ${classified.reason}`
        : `host is not provisioned: ${classified.reason}`;
    }
  });

  beforeEach(context => {
    if (evidenceSkipReason) context.skip(evidenceSkipReason);
  });

  afterAll(async () => {
    if (root) await fs.rm(root, { recursive: true, force: true });
  });

  it("rejects receipt drift and malformed Markdown evidence", () => {
    const [binding] = bindings;
    const drifted = structuredClone(receipt);
    drifted.fixtures[0].sha256 = "b".repeat(64);
    expect(() => validateFixtureBindings(manifest, drifted)).toThrow(/differ/);

    expect(validateMarkdownResult(resultFor(binding), binding).markdown).toContain("Fixture text");
    const duplicatePage = resultFor(binding);
    duplicatePage.structuredContent.pages[0].page = 2;
    expect(() => validateMarkdownResult(duplicatePage, binding)).toThrow(/evidence is invalid/);
  });

  it("rejects an artifact whose bytes differ from the approved digest", async () => {
    await expect(runMarkdownBakeoff({
      ...options,
      "--artifact-sha256": "c".repeat(64),
    })).rejects.toThrow(/retained inputs differ/);
  });

  it("rejects a schema-valid receipt whose identity digest was replaced", async () => {
    const forged = { ...receipt, handoff_id: "c".repeat(64) };
    const forgedBytes = Buffer.from(`${JSON.stringify(forged)}\n`);
    const forgedPath = path.join(root, "forged-receipt.json");
    await fs.writeFile(forgedPath, forgedBytes, { mode: 0o600, flag: "wx" });
    await expect(runMarkdownBakeoff({
      ...options,
      "--receipt": forgedPath,
      "--receipt-sha256": sha256(forgedBytes),
    })).rejects.toThrow(/identity digest is invalid/);
  });

  it("rejects a valid identity digest that does not bind the top-level fixture inventory", async () => {
    const forged = structuredClone(receipt);
    forged.identity.fixtures[0].sha256 = "b".repeat(64);
    forged.handoff_id = sha256(Buffer.from(
      `pdf-tools.docling-macos-handoff.v1\0${canonicalJson(forged.identity)}`,
    ));
    const forgedBytes = Buffer.from(`${JSON.stringify(forged)}\n`);
    const forgedPath = path.join(root, "split-inventory-receipt.json");
    await fs.writeFile(forgedPath, forgedBytes, { mode: 0o600, flag: "wx" });
    await expect(runMarkdownBakeoff({
      ...options,
      "--receipt": forgedPath,
      "--receipt-sha256": sha256(forgedBytes),
    })).rejects.toThrow(/does not bind the exact retained inventories/);
  });

  it("runs three distinct packed server processes and writes private canonical evidence", async () => {
    const summary = await runMarkdownBakeoff(options);
    expect(summary).toMatchObject({ cases: 8, output: options["--output"] });
    const bytes = await fs.readFile(options["--output"]);
    expect(summary.sha256).toBe(sha256(bytes));
    expect(bytes.at(-1)).toBe(0x0a);

    const report = JSON.parse(bytes.toString("utf8"));
    expect(report).toMatchObject({
      protocol: "pdf-tools.markdown-bakeoff.v1",
      repetitions_per_case: 3,
      artifact: {
        sha256: options["--artifact-sha256"],
        extraction: { archive_crc_verified: true, fresh: true, cleaned: true },
        pdfjs_dist: "5.4.624",
        runtime_files: {
          markdown_conversion: { path: "server/markdown-conversion.js", reopened_verified: true },
          markdown_transaction: { path: "server/markdown-output-transaction.js", reopened_verified: true },
          server_entry: { path: "server/index.js", reopened_verified: true },
        },
      },
    });
    expect(report.cases).toHaveLength(8);
    for (const reportCase of report.cases) {
      expect(reportCase.source_reopened_verified).toBe(true);
      expect(new Set(reportCase.runs.map(run => run.pid)).size).toBe(3);
      expect(new Set(reportCase.runs.map(run => run.result_sha256)).size).toBe(1);
    }
    expect(report.cases[0].runs[0].result.markdown).toContain("INV-1001");
    expect((await fs.lstat(options["--output"])).mode & 0o777).toBe(0o600);
    expect((await fs.readdir(fixtureRoot)).sort()).toEqual(
      receipt.fixtures.map(item => item.filename).sort(),
    );
    expect((await fs.readdir(path.dirname(options["--output"]))).sort()).toEqual(["report.json"]);
  }, 120000);

  it("refuses evidence if an extracted server changes a retained fixture", async () => {
    const copiedRunRoot = path.join(root, "mutating-run");
    const mutationOutputRoot = path.join(root, "mutating-output");
    await fs.cp(path.dirname(options["--receipt"]), copiedRunRoot, { recursive: true });
    await fs.mkdir(mutationOutputRoot, { mode: 0o700 });
    const artifactPath = await createFakeArtifact(root, "mutating", true);
    const artifactBytes = await fs.readFile(artifactPath);
    const mutationOptions = {
      ...options,
      "--artifact": artifactPath,
      "--artifact-sha256": sha256(artifactBytes),
      "--output": path.join(mutationOutputRoot, "report.json"),
      "--receipt": path.join(copiedRunRoot, path.basename(options["--receipt"])),
    };
    await expect(runMarkdownBakeoff(mutationOptions)).rejects.toThrow(/evidence is invalid|changed during/);
    await expect(fs.access(mutationOptions["--output"])).rejects.toMatchObject({ code: "ENOENT" });
  }, 120000);
});
