#!/usr/bin/env node

// Isolated stdio qualification, not a Claude Desktop installation or host test.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { LOCAL_OCR_HELPER_SHA256 } from "../server/local-ocr-tools.js";

const options = {};
const keys = new Set(["--pdf", "--expect-source-sha256", "--python", "--helper", "--encrypted-pdf", "--output-dir"]);
for (let index = 2; index < process.argv.length; index += 2) {
  const key = process.argv[index];
  assert(keys.has(key) && !(key in options) && process.argv[index + 1], "Unknown, duplicate or missing smoke argument");
  options[key] = process.argv[index + 1];
}
for (const key of keys) assert(options[key], `Required ${key}`);
assert(process.platform === "darwin", "Real OCR smoke requires macOS");
for (const key of ["--pdf", "--python", "--helper", "--encrypted-pdf", "--output-dir"]) {
  assert(path.isAbsolute(options[key]), `Absolute path required: ${key}`);
}
const sha = bytes => createHash("sha256").update(bytes).digest("hex");
const sourceBefore = await fs.readFile(options["--pdf"]);
assert.equal(sha(sourceBefore), options["--expect-source-sha256"]);
assert.equal(sha(await fs.readFile(options["--helper"])), LOCAL_OCR_HELPER_SHA256);
const root = options["--output-dir"];
await fs.mkdir(root, { mode: 0o700 }); // No reuse of a previous smoke.
const home = path.join(root, "home");
const pluginData = path.join(root, "plugin-data");
const profiles = path.join(root, "profiles");
for (const folder of [home, pluginData, profiles]) await fs.mkdir(folder, { mode: 0o700 });
const configPath = path.join(pluginData, "config.json");
const config = { allowedDirectories: [...new Set([path.dirname(options["--pdf"]), path.dirname(options["--encrypted-pdf"])])] };
const writeConfig = () => fs.writeFile(configPath, JSON.stringify(config), { mode: 0o600 });
await writeConfig();
const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const opened = [];
async function connect(label) {
  const transport = new StdioClientTransport({
    command: process.execPath, args: [path.join(repo, "server/index.js")], cwd: repo,
    env: { PATH: "/usr/bin:/bin", HOME: home, PLUGIN_DATA: pluginData, DEFAULT_PROFILES_DIR: profiles },
    stderr: "pipe",
  });
  const client = new Client({ name: `local-ocr-smoke-${label}`, version: "1.0.0" });
  opened.push({ client, transport });
  await client.connect(transport);
  return client;
}
const text = response => response.content?.filter(item => item.type === "text").map(item => item.text).join("\n") || "";
const request = { pdf_path: options["--pdf"], page: 1, expected_source_sha256: sha(sourceBefore), confirm_local_ocr: true };
const jobsPath = path.join(profiles, "local-ocr-proposals");
const jobs = async () => fs.readdir(jobsPath).catch(error => { if (error.code === "ENOENT") return []; throw error; });
try {
  const disabled = await connect("disabled");
  const defaultTools = (await disabled.listTools()).tools;
  assert.equal(defaultTools.length, 57);
  assert(!defaultTools.some(tool => tool.name === "propose_pdf_ocr"));
  const defaultDigest = sha(JSON.stringify(defaultTools));
  assert.equal(defaultDigest, "2edabecaa5aa61e9ee533f8811180e8661a9423dddaee8ba59fec19cb846ab7d");
  const disabledResult = await disabled.callTool({ name: "propose_pdf_ocr", arguments: request });
  assert.equal(disabledResult.isError, true);
  assert.match(text(disabledResult), /not configured/);
  assert.deepEqual(await jobs(), []);
  await disabled.close();

  config.localOCR = { pythonPath: options["--python"], helperPath: options["--helper"] };
  await writeConfig();
  const enabled = await connect("enabled");
  const enabledTools = (await enabled.listTools()).tools;
  assert.equal(enabledTools.length, 58);
  assert(enabledTools.some(tool => tool.name === "propose_pdf_ocr" && tool.outputSchema));
  const identity = await enabled.callTool({ name: "get_pdf_identity", arguments: { pdf_path: request.pdf_path } });
  assert.notEqual(identity.isError, true);
  assert.equal(identity.structuredContent.sha256, request.expected_source_sha256);
  for (const arguments_ of [
    { ...request, confirm_local_ocr: false },
    { ...request, expected_source_sha256: "0".repeat(64) },
  ]) {
    const result = await enabled.callTool({ name: "propose_pdf_ocr", arguments: arguments_ });
    assert.equal(result.isError, true);
    assert.deepEqual(await jobs(), []);
  }
  const encrypted = await fs.readFile(options["--encrypted-pdf"]);
  const encryptionResult = await enabled.callTool({ name: "propose_pdf_ocr", arguments: {
    ...request, pdf_path: options["--encrypted-pdf"], expected_source_sha256: sha(encrypted),
  } });
  assert.equal(encryptionResult.isError, true);
  const failedJobs = await jobs();
  assert.equal(failedJobs.length, 1);
  await assert.rejects(fs.stat(path.join(jobsPath, failedJobs[0], "proposal/commit.json")), { code: "ENOENT" });

  const response = await enabled.callTool({ name: "propose_pdf_ocr", arguments: request }, undefined, { timeout: 125_000 });
  assert.notEqual(response.isError, true, text(response));
  const result = response.structuredContent;
  assert.equal(result.status, "source_render_replayed_ocr_unverified");
  assert.equal(result.source_pdf_sha256, request.expected_source_sha256);
  assert(result.observation_count > 0);
  assert.equal(result.returned_observation_count + result.omitted_observation_count, result.observation_count);
  assert.match(text(response), /UNVERIFIED/);
  const proposalBytes = await fs.readFile(path.join(result.proposal_directory, "proposal.json"));
  const proposal = JSON.parse(proposalBytes);
  assert.deepEqual(result.proposals, proposal.proposals.slice(0, 200));
  assert.equal(proposal.proposal_sha256, result.proposal_sha256);
  assert.equal(sha(await fs.readFile(result.review_html_path)), result.review_html_sha256);
  assert.equal(sha(await fs.readFile(path.join(result.proposal_directory, "render.png"))), result.render_png_sha256);
  for (const file of [result.review_html_path, ...["proposal.json", "commit.json", "render.png"].map(name => path.join(result.proposal_directory, name))]) {
    const stat = await fs.lstat(file); assert(stat.isFile() && !stat.isSymbolicLink()); assert.equal(stat.mode & 0o777, 0o600);
  }
  assert.equal(sha(await fs.readFile(request.pdf_path)), sha(sourceBefore));
  const receipt = {
    schema_version: 1, scope: "isolated_source_stdio_real_macos_ocr_not_installed_desktop",
    observed_at: new Date().toISOString(), platform: process.platform, arch: process.arch, node_version: process.version,
    default_tool_count: 57, default_tool_contract_sha256: defaultDigest, configured_tool_count: 58,
    source_pdf_sha256: sha(sourceBefore), encrypted_fixture_sha256: sha(encrypted), encrypted_fixture_rejected: true,
    explicit_confirmation_and_stale_source_rejected: true, original_source_unchanged: true,
    result, engine: proposal.engine, source_server_sha256: sha(await fs.readFile(path.join(repo, "server/index.js"))),
    installed_desktop_qualified: false, word_correctness_verified: false,
  };
  await fs.writeFile(path.join(root, "receipt.json"), `${JSON.stringify(receipt, null, 2)}\n`, { flag: "wx", mode: 0o600 });
  console.log(JSON.stringify({ ok: true, receipt_sha256: sha(await fs.readFile(path.join(root, "receipt.json"))), receipt }));
} finally {
  for (const { client, transport } of opened.reverse()) { await client.close().catch(() => {}); await transport.close().catch(() => {}); }
}
