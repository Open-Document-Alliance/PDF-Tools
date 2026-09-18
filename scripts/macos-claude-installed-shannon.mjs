#!/usr/bin/env node

import { createHash } from "node:crypto";
import { readFile, realpath } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";

const extensionDirectory = path.resolve(process.argv[2] || "");
const sourceArgument = path.resolve(process.argv[3] || "");
if (!process.argv[2] || !process.argv[3]) {
  throw new Error("Usage: macos-claude-installed-shannon.mjs <installed-extension-dir> <shannon-pdf>");
}

// Pins recaptured 2026-08-15 against the shipped v0.11.0 MCPB
// (sha256 24179fb68790014407d3af34bb1da68b15cfe31907f7ff733df45d013f3e2dd4),
// unpacked and driven over stdio with the Shannon paper fetched from the URL in
// test/fixtures/eval/shannon/manifest.v1.json.
//
// The previous pins were captured before the Type-3 recovery and superscript
// work and had drifted a long way: 68 gaps against 26, and 434 replacement
// characters against 6. Those two numbers are a quality measurement, so stale
// pins here understate the product by a factor of four and seventy.
//
const EXPECTED_SOURCE_SHA256 = "6e4e3411984f3edf99dbfe8b941cb5e8a321379ff0cae6ae5c1f592ad8882ca8";
const EXPECTED_MARKDOWN_SHA256 = "b9bd7ca7db26fe807f294565c39de8d4fe9337908afa74cd7e2896a800c92991";
const EXPECTED_TOOL_CONTRACT_SHA256 = "cefcfff3fc76324826e1eedcd4e2694d311cfcd1ab7daa9f43dc9e2f496eae5d";
const EXPECTED_PAGE_COUNT = 55;
const EXPECTED_GAP_COUNT = 26;
const EXPECTED_REPLACEMENT_CHARACTER_COUNT = 6;
const EXPECTED_ALPHA_COUNT = 49;
const EXPECTED_MARKDOWN_BYTES = 187663;
const PAGE_SPAN = 10;

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

const sourcePath = await realpath(sourceArgument);
assert(sourcePath === sourceArgument, "Shannon PDF path must be canonical");
const sourceBytes = await readFile(sourcePath);
const sourceSha256 = sha256(sourceBytes);
assert(sourceSha256 === EXPECTED_SOURCE_SHA256, "Shannon PDF bytes differ from the reviewed source");

const sdkDirectory = path.join(extensionDirectory, "node_modules", "@modelcontextprotocol", "sdk", "dist", "esm");
const { Client } = await import(pathToFileURL(path.join(sdkDirectory, "client", "index.js")));
const { StdioClientTransport } = await import(pathToFileURL(path.join(sdkDirectory, "client", "stdio.js")));
const serverPath = path.join(extensionDirectory, "server", "index.js");
const sourceDirectory = path.dirname(sourcePath);
const client = new Client({ name: "installed-claude-shannon-proof", version: "1.0.0" });
const transport = new StdioClientTransport({
  command: process.execPath,
  args: [serverPath, "--allowed-directories", sourceDirectory],
  cwd: extensionDirectory,
  env: {
    ...process.env,
    ALLOWED_DIRECTORIES: JSON.stringify([sourceDirectory]),
    DEFAULT_PDF_DIR: sourceDirectory,
    DEFAULT_DOWNLOAD_DIR: sourceDirectory,
  },
  stderr: "pipe",
});

const started = process.hrtime.bigint();
const chunks = [];
try {
  await client.connect(transport);
  const tools = await client.listTools();
  assert(tools.tools.length === 44, `Expected 44 installed tools, received ${tools.tools.length}`);
  assert(
    sha256(Buffer.from(JSON.stringify(tools.tools))) === EXPECTED_TOOL_CONTRACT_SHA256,
    "Installed tool contract differs from the reviewed build",
  );

  for (let startPage = 1; startPage <= EXPECTED_PAGE_COUNT; startPage += PAGE_SPAN) {
    const endPage = Math.min(EXPECTED_PAGE_COUNT, startPage + PAGE_SPAN - 1);
    const result = await client.callTool({
      name: "convert_pdf_to_markdown",
      arguments: {
        pdf_path: sourcePath,
        start_page: startPage,
        end_page: endPage,
        max_items: 5000,
        max_characters: 100000,
        max_markdown_bytes: 200000,
        include_page_boundaries: true,
      },
    });
    const value = result.structuredContent;
    assert(!result.isError && value, `Installed conversion failed for pages ${startPage}-${endPage}`);
    assert(value.renderer?.version === "1.20.1", "Installed Markdown renderer version differs");
    assert(value.provenance?.layout?.parser_version === "5.4.624", "Installed PDF parser version differs");
    assert(value.provenance?.source?.sha256 === sourceSha256, "Installed conversion source identity differs");
    assert(value.provenance?.layout?.page_range?.start_page === startPage, "Installed conversion start page differs");
    assert(value.provenance?.layout?.page_range?.end_page === endPage, "Installed conversion end page differs");
    assert(value.provenance?.layout?.page_range?.total_pages === EXPECTED_PAGE_COUNT, "Installed page count differs");
    assert(value.markdown_sha256 === sha256(Buffer.from(value.markdown, "utf8")), "Installed chunk digest differs");
    chunks.push(value);
  }
} finally {
  await transport.close();
}

const markdown = chunks.map(chunk => chunk.markdown).join("\n\n");
const markdownSha256 = sha256(Buffer.from(markdown, "utf8"));
const alphaCount = [...markdown].filter(character => character === "α").length;
const gapCount = chunks.reduce((total, chunk) => total + chunk.gaps.length, 0);
const replacementCharacterCount = [...markdown].filter(character => character === "\uFFFD").length;
const markdownBytes = Buffer.byteLength(markdown, "utf8");
assert(
  markdownSha256 === EXPECTED_MARKDOWN_SHA256,
  `Installed Shannon Markdown differs from the reviewed output: expected ${EXPECTED_MARKDOWN_SHA256}, received ${markdownSha256}`,
);
assert(alphaCount === EXPECTED_ALPHA_COUNT, `Installed Shannon alpha count differs: expected ${EXPECTED_ALPHA_COUNT}, received ${alphaCount}`);
assert(gapCount === EXPECTED_GAP_COUNT, `Installed Shannon gap count differs: expected ${EXPECTED_GAP_COUNT}, received ${gapCount}`);
assert(
  replacementCharacterCount === EXPECTED_REPLACEMENT_CHARACTER_COUNT,
  `Installed Shannon replacement-character count differs: expected ${EXPECTED_REPLACEMENT_CHARACTER_COUNT}, received ${replacementCharacterCount}`,
);
assert(markdownBytes === EXPECTED_MARKDOWN_BYTES, `Installed Shannon byte count differs: expected ${EXPECTED_MARKDOWN_BYTES}, received ${markdownBytes}`);

process.stdout.write(`${JSON.stringify({
  installed_extension: extensionDirectory,
  source_sha256: sourceSha256,
  page_count: EXPECTED_PAGE_COUNT,
  page_calls: chunks.map(chunk => chunk.provenance.layout.page_range),
  conversion_statuses: [...new Set(chunks.map(chunk => chunk.conversion_status))].sort(),
  total_gap_count: gapCount,
  replacement_character_count: replacementCharacterCount,
  alpha_count: alphaCount,
  markdown_bytes: markdownBytes,
  markdown_sha256: markdownSha256,
  elapsed_ms: Number(process.hrtime.bigint() - started) / 1e6,
}, null, 2)}\n`);
