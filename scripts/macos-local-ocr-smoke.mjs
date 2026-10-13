#!/usr/bin/env node

// Isolated stdio qualification, not a Claude Desktop installation or host test.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { LOCAL_OCR_HELPER_SHA256, LOCAL_OCR_TOOL_DEFINITION } from "../server/local-ocr-tools.js";
import { LOCAL_OCR_JOB_TOOL_DEFINITIONS } from "../server/local-ocr-jobs.js";
import { withToolOutputSchema } from "../server/output-schemas.js";
import { assertLocalOcrSmokeCatalog, assertLocalOcrSmokeEncryptedRefusal, assertLocalOcrSmokeProgress } from "./local-ocr-smoke-contract.mjs";

const options = {};
const requiredKeys = ["--pdf", "--expect-source-sha256", "--python", "--helper", "--encrypted-pdf", "--output-dir"];
const keys = new Set([...requiredKeys, "--job-pages"]);
for (let index = 2; index < process.argv.length; index += 2) {
  const key = process.argv[index];
  assert(keys.has(key) && !(key in options) && process.argv[index + 1], "Unknown, duplicate or missing smoke argument");
  options[key] = process.argv[index + 1];
}
for (const key of requiredKeys) assert(options[key], `Required ${key}`);
let jobPages;
if (options["--job-pages"]) {
  assert(/^[1-9][0-9]*,[1-9][0-9]*$/u.test(options["--job-pages"]), "Use two distinct ascending job pages");
  jobPages = options["--job-pages"].split(",").map(Number);
  assert(jobPages[0] < jobPages[1] && jobPages[1] <= 10000, "Use two distinct ascending job pages");
}
assert(process.platform === "darwin", "Real OCR smoke requires macOS");
for (const key of ["--pdf", "--python", "--helper", "--encrypted-pdf", "--output-dir"]) {
  assert(path.isAbsolute(options[key]), `Absolute path required: ${key}`);
}
const sha = bytes => createHash("sha256").update(bytes).digest("hex");
const sourceBefore = await fs.readFile(options["--pdf"]);
assert.equal(sha(sourceBefore), options["--expect-source-sha256"]);
const helperBytes = await fs.readFile(options["--helper"]);
assert.equal(sha(helperBytes), LOCAL_OCR_HELPER_SHA256);
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
const manifestBytes = await fs.readFile(path.join(repo, "manifest.json"));
const manifestTools = JSON.parse(manifestBytes).tools;
const optionalTools = [LOCAL_OCR_TOOL_DEFINITION, ...LOCAL_OCR_JOB_TOOL_DEFINITIONS].map(withToolOutputSchema);
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
async function retainedPage(result) {
  assert.equal(sha(await fs.readFile(result.review_html_path)), result.review_html_sha256);
  assert.equal(sha(await fs.readFile(path.join(result.proposal_directory, "render.png"))), result.render_png_sha256);
  const proposalBytes = await fs.readFile(path.join(result.proposal_directory, "proposal.json"));
  const proposal = JSON.parse(proposalBytes);
  const commit = JSON.parse(await fs.readFile(path.join(result.proposal_directory, "commit.json"), "utf8"));
  assert.equal(commit.proposal_file_sha256, sha(proposalBytes));
  assert.equal(commit.proposal_sha256, result.proposal_sha256);
  assert.equal(commit.render_png_sha256, result.render_png_sha256);
  assert.equal(proposal.source_pdf_sha256, request.expected_source_sha256);
  assert.equal(proposal.page_number, result.page_number);
  assert.equal(proposal.proposal_sha256, result.proposal_sha256);
  assert.equal(proposal.proposals.length, result.observation_count);
  for (const file of [result.review_html_path, ...["proposal.json", "commit.json", "render.png"].map(name => path.join(result.proposal_directory, name))]) {
    const stat = await fs.lstat(file); assert(stat.isFile() && !stat.isSymbolicLink()); assert.equal(stat.mode & 0o777, 0o600);
  }
  return proposal;
}
try {
  const disabled = await connect("disabled");
  const defaultTools = (await disabled.listTools()).tools;
  const defaultCount = assertLocalOcrSmokeCatalog(defaultTools, manifestTools, optionalTools, false);
  const defaultDigest = sha(JSON.stringify(defaultTools));
  const disabledResult = await disabled.callTool({ name: "propose_pdf_ocr", arguments: request });
  assert.equal(disabledResult.isError, true);
  assert.match(text(disabledResult), /not configured/);
  assert.deepEqual(await jobs(), []);
  await disabled.close();

  config.localOCR = { pythonPath: options["--python"], helperPath: options["--helper"] };
  await writeConfig();
  const enabled = await connect("enabled");
  const enabledTools = (await enabled.listTools()).tools;
  const configuredCount = assertLocalOcrSmokeCatalog(enabledTools, manifestTools, optionalTools, true);
  const identity = await enabled.callTool({ name: "get_pdf_identity", arguments: { pdf_path: request.pdf_path } });
  assert.notEqual(identity.isError, true);
  assert.equal(identity.structuredContent.sha256, request.expected_source_sha256);
  for (const [arguments_, reason] of [
    [{ ...request, confirm_local_ocr: false }, /confirm_local_ocr|confirmation/iu],
    [{ ...request, expected_source_sha256: "0".repeat(64) }, /source bytes do not match/iu],
  ]) {
    const result = await enabled.callTool({ name: "propose_pdf_ocr", arguments: arguments_ });
    assert.equal(result.isError, true);
    assert.match(text(result), reason);
    assert.deepEqual(await jobs(), []);
  }
  const encrypted = await fs.readFile(options["--encrypted-pdf"]);
  // The public wrapper intentionally gives generic adapter diagnostics. Prove
  // this fixture's exact encryption refusal independently, using hashed helper
  // bytes and no host credentials, before labelling the negative control.
  const negativeHelper = path.join(root, "encrypted-negative-adapter.py");
  await fs.writeFile(negativeHelper, helperBytes, { flag: "wx", mode: 0o600 });
  let encryptedDiagnostic;
  try {
    await promisify(execFile)(options["--python"], ["-I", "-B", negativeHelper,
      "--pdf", options["--encrypted-pdf"], "--page", "1", "--expect-source-sha256", sha(encrypted),
      "--output-dir", path.join(root, "encrypted-negative-output")],
    { timeout: 15_000, maxBuffer: 256 * 1024, env: { PATH: "/usr/bin:/bin", PYTHONDONTWRITEBYTECODE: "1" } });
    assert.fail("Encrypted adapter fixture unexpectedly succeeded");
  } catch (error) {
    assertLocalOcrSmokeEncryptedRefusal(error);
    encryptedDiagnostic = error.stderr;
  }
  await assert.rejects(fs.stat(path.join(root, "encrypted-negative-output")), { code: "ENOENT" });
  await fs.writeFile(path.join(root, "encrypted-adapter.stderr"), encryptedDiagnostic, { flag: "wx", mode: 0o600 });
  const encryptionResult = await enabled.callTool({ name: "propose_pdf_ocr", arguments: {
    ...request, pdf_path: options["--encrypted-pdf"], expected_source_sha256: sha(encrypted),
  } });
  assert.equal(encryptionResult.isError, true);
  assert.match(text(encryptionResult), /Optional local OCR adapter failed/u);
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
  const proposal = await retainedPage(result);
  assert.deepEqual(result.proposals, proposal.proposals.slice(0, 200));
  let jobReceipt = null;
  if (jobPages) {
    const call = async (client, name, args, timeout = 125_000) => {
      const response = await client.callTool({ name, arguments: args }, undefined, { timeout });
      assert.notEqual(response.isError, true, text(response));
      return response.structuredContent;
    };
    const beforeStart = (await jobs()).sort();
    const started = await call(enabled, "start_pdf_ocr_job", { pdf_path: request.pdf_path,
      pages: jobPages, expected_source_sha256: request.expected_source_sha256, confirm_local_ocr: true });
    const progress = { pages: jobPages, sourceSha256: request.expected_source_sha256, job: started };
    assertLocalOcrSmokeProgress(started, { ...progress, completed: [], processed: 0 });
    assert.deepEqual((await jobs()).sort(), beforeStart, "Job creation must not run OCR");
    const jobArgs = { job_id: started.job_id, expected_job_identity_sha256: started.job_identity_sha256 };
    const denied = await enabled.callTool({ name: "resume_pdf_ocr_job", arguments: { ...jobArgs, confirm_local_ocr: false } });
    assert.equal(denied.isError, true);
    const first = await call(enabled, "resume_pdf_ocr_job", { ...jobArgs, confirm_local_ocr: true });
    assertLocalOcrSmokeProgress(first, { ...progress, completed: [jobPages[0]], processed: 1 });
    await retainedPage(first.completed_pages[0]);
    await enabled.close(); // A new server process must use the retained checkpoint.
    const restarted = await connect("resumed");
    assertLocalOcrSmokeCatalog((await restarted.listTools()).tools, manifestTools, optionalTools, true);
    const read = await call(restarted, "read_pdf_ocr_job", jobArgs);
    assertLocalOcrSmokeProgress(read, { ...progress, completed: [jobPages[0]], processed: 0 });
    assert.deepEqual(read.completed_pages, first.completed_pages);
    const complete = await call(restarted, "resume_pdf_ocr_job", { ...jobArgs, confirm_local_ocr: true });
    assertLocalOcrSmokeProgress(complete, { ...progress, completed: jobPages, processed: 1 });
    assert.deepEqual(complete.completed_pages[0], first.completed_pages[0]);
    for (const page of complete.completed_pages) await retainedPage(page);
    const beforeRepeated = (await jobs()).sort();
    const repeated = await call(restarted, "resume_pdf_ocr_job", { ...jobArgs, confirm_local_ocr: true });
    assertLocalOcrSmokeProgress(repeated, { ...progress, completed: jobPages, processed: 0 });
    assert.deepEqual(repeated.completed_pages, complete.completed_pages);
    assert.deepEqual((await jobs()).sort(), beforeRepeated, "Completed resume must not create a new OCR attempt");
    jobReceipt = { started, first, after_server_restart: read, completed: complete, repeated,
      resumed_across_server_processes: true, completed_pages_not_rerun: true };
  }
  assert.equal(sha(await fs.readFile(request.pdf_path)), sha(sourceBefore));
  const receipt = {
    schema_version: 1, scope: "isolated_source_stdio_real_macos_ocr_not_installed_desktop",
    observed_at: new Date().toISOString(), platform: process.platform, arch: process.arch, node_version: process.version,
    default_tool_count: defaultCount, default_tool_contract_sha256: defaultDigest, configured_tool_count: configuredCount,
    manifest_sha256: sha(manifestBytes), optional_tool_names: optionalTools.map(tool => tool.name),
    source_pdf_sha256: sha(sourceBefore), encrypted_fixture_sha256: sha(encrypted), encrypted_fixture_rejected: true,
    encrypted_adapter_stderr_sha256: sha(encryptedDiagnostic),
    explicit_confirmation_and_stale_source_rejected: true, original_source_unchanged: true,
    result, job: jobReceipt, engine: proposal.engine, source_server_sha256: sha(await fs.readFile(path.join(repo, "server/index.js"))),
    installed_desktop_qualified: false, word_correctness_verified: false,
  };
  await fs.writeFile(path.join(root, "receipt.json"), `${JSON.stringify(receipt, null, 2)}\n`, { flag: "wx", mode: 0o600 });
  console.log(JSON.stringify({ ok: true, receipt_sha256: sha(await fs.readFile(path.join(root, "receipt.json"))), receipt }));
} finally {
  for (const { client, transport } of opened.reverse()) { await client.close().catch(() => {}); await transport.close().catch(() => {}); }
}
