#!/usr/bin/env node
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { isDeepStrictEqual, promisify } from "node:util";
import { runOlmocrBench, validateRunReport, canonicalJson } from "./eval-olmocr-bench.mjs";
import { parseStrictJson } from "./eval-strict-json.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const MANIFEST = path.join(ROOT, "test/fixtures/eval/olmocr/manifest.v1.json");
const exec = promisify(execFile);
const hash = bytes => createHash("sha256").update(bytes).digest("hex");
export const UPSTREAM_REVISION = "f7cfe4c22098b154c76b6ec950d1c0a464eecf8d";

export function scorerEnvironment(destination, { environment = process.env, platform = process.platform, home = os.homedir() } = {}) {
  const browserCache = platform === "darwin"
    ? path.join(home, "Library", "Caches", "ms-playwright")
    : path.join(environment.XDG_CACHE_HOME || path.join(home, ".cache"), "ms-playwright");
  return { PATH: environment.PATH ?? "", HOME: destination,
    PYTHONNOUSERSITE: "1", PYTHONDONTWRITEBYTECODE: "1", PYTHONHASHSEED: "0",
    // Keep equation caches fresh without hiding the browser installed in the
    // original user's cache. Explicit hermetic/custom Playwright paths win.
    PLAYWRIGHT_BROWSERS_PATH: environment.PLAYWRIGHT_BROWSERS_PATH ?? browserCache };
}

export function buildUpstreamRequest(categories, records) {
  if (!Array.isArray(categories) || !categories.length || !Array.isArray(records)) throw new Error("A nonempty category denominator is required");
  const pdfs = new Set(categories.flatMap(category => category.tests.map(test => test.pdf)));
  const recordMap = new Map();
  for (const record of records) {
    if (!pdfs.has(record.pdf) || recordMap.has(record.pdf)) throw new Error("Unexpected or duplicate candidate PDF");
    if (record.ok && (record.outcome !== "converted" || typeof record.markdown !== "string")) throw new Error("Contradictory candidate conversion");
    recordMap.set(record.pdf, record);
  }
  const rows = [], ids = new Set(), seenCategories = new Set();
  const append = (category, test) => {
    if (!test.id || ids.has(test.id) || test.page !== 1) throw new Error("Duplicate test identity or unsupported page");
    ids.add(test.id);
    const record = recordMap.get(test.pdf);
    rows.push({ id: test.id, category, test, markdown: record?.ok ? record.markdown : null });
  };
  for (const category of categories) {
    if (!category.id || seenCategories.has(category.id) || category.id === "baseline" || !category.tests.length) throw new Error("Invalid category denominator");
    seenCategories.add(category.id);
    for (const test of category.tests) append(category.id, test);
  }
  // Exactly the default upstream baseline policy, rather than silently using
  // --skip_baseline or reporting a micro-average as the upstream headline.
  for (const pdf of [...pdfs].sort()) {
    if (!rows.some(row => row.test.pdf === pdf && row.test.type === "baseline")) {
      append("baseline", { id: `${pdf}_baseline`, pdf, page: 1, type: "baseline" });
    }
  }
  return { schema: "pdf-tools.olmocr-upstream-request.v1", tests: rows };
}

export function summarizeUpstream(request, response) {
  const unavailable = response.status === "unavailable";
  if (!unavailable && response.status !== "completed") throw new Error("Invalid scorer status");
  const rows = unavailable ? request.tests.map(test => ({ id: test.id, category: test.category, status: "not_run" })) : response.results;
  if (!Array.isArray(rows) || rows.length !== request.tests.length) throw new Error("Scorer omitted denominator rows");
  const categories = {}, counts = { total: rows.length, passed: 0, failed: 0, not_run: 0, scorer_error: 0 };
  for (const [index, row] of rows.entries()) {
    const expected = request.tests[index];
    if (row.id !== expected.id || row.category !== expected.category
      || !["passed", "failed", "not_run", "scorer_error"].includes(row.status)) throw new Error("Scorer row identity or outcome mismatch");
    if (expected.markdown === null && row.status !== "not_run") throw new Error("Unattempted extraction cannot receive a score");
    if (!unavailable && expected.markdown !== null && row.status === "not_run") throw new Error("Attempted extraction silently skipped");
    categories[row.category] ??= { total: 0, passed: 0, failed: 0, not_run: 0, scorer_error: 0 };
    categories[row.category].total += 1;
    categories[row.category][row.status] += 1;
    counts[row.status] += 1;
  }
  const macro = Object.values(categories).reduce((sum, category) => sum + category.passed / category.total, 0) / Object.keys(categories).length;
  const complete = !unavailable && counts.not_run === 0 && counts.scorer_error === 0;
  return { ...counts, categories, complete, upstream_macro_average: complete ? macro : null,
    conservative_macro_average_all_planned_tests: macro, results: rows };
}

async function verifyUpstream(upstream) {
  const { stdout: revision } = await exec("git", ["rev-parse", "HEAD"], { cwd: upstream });
  const { stdout: status } = await exec("git", ["status", "--porcelain", "--untracked-files=all"], { cwd: upstream });
  if (revision.trim() !== UPSTREAM_REVISION || status.trim()) throw new Error("Upstream scorer must be the exact pinned, clean checkout");
  const { stdout: names } = await exec("git", ["ls-files"], { cwd: upstream });
  const files = [];
  for (const name of names.trim().split("\n").filter(name => /\.(py|js|css|toml)$/.test(name))) {
    const bytes = await fs.readFile(path.join(upstream, name));
    const { stdout: pinned } = await exec("git", ["show", `${UPSTREAM_REVISION}:${name}`],
      { cwd: upstream, encoding: "buffer", maxBuffer: Math.max(bytes.length * 2, 1024 * 1024) });
    if (!bytes.equals(pinned)) throw new Error(`Upstream source differs from pinned Git bytes: ${name}`);
    files.push({ path: name, sha256: hash(bytes) });
  }
  return { repository: "https://github.com/allenai/olmocr", revision: UPSTREAM_REVISION,
    source_sha256: hash(canonicalJson(files)), files };
}

export async function runUpstream(options) {
  const { output, upstream, benchRoot, runPath, runSha256, python = "python3", preflight = false } = options;
  const destination = path.resolve(output);
  if (destination === ROOT || destination.startsWith(`${ROOT}${path.sep}`)) throw new Error("Write evidence outside the repository");
  await fs.mkdir(destination, { mode: 0o700 });
  const manifestBytes = await fs.readFile(MANIFEST);
  const manifest = parseStrictJson(manifestBytes.toString(), "pinned manifest");
  const report = { schema: "pdf-tools.olmocr-upstream-score.v1", status: "not_run",
    upstream_revision: UPSTREAM_REVISION, dataset_revision: manifest.source.revision,
    planned_pdf_count: manifest.execution.required_pdf_count,
    planned_annotated_test_count: manifest.execution.required_test_count,
    planned_default_baseline_test_count: manifest.execution.required_pdf_count,
    benchmark_claim_ready: false, native_host_accepted: false,
    claim_note: "Upstream test-class adapter; public claims additionally require complete audited corpus, execution, runtime, and rights evidence.",
    reasons: [], metrics: null };
  const save = async () => fs.writeFile(path.join(destination, "report.json"), `${JSON.stringify(report, null, 2)}\n`, { flag: "wx", mode: 0o600 });
  try {
    // Preflight exposes the same containment requirement as the existing full
    // converter; do not run a weakened fallback if this host cannot provide it.
    if (process.platform === "linux") {
      await exec("/usr/bin/bwrap", ["--unshare-net", "--die-with-parent", "--ro-bind", "/", "/", "--dev", "/dev", "--proc", "/proc", "true"], { timeout: 10000 });
    } else if (process.platform === "darwin") {
      await exec("/usr/bin/sandbox-exec", ["-p", "(version 1)(allow default)(deny network*)", "/usr/bin/true"], { timeout: 10000 });
    } else throw new Error("Existing corpus converter requires Linux or macOS process-tree isolation");
    report.containment = "available";
  } catch (error) { report.containment = "unavailable"; report.reasons.push(`Conversion containment: ${error.message}`); }
  try {
    const { stdout } = await exec(python, ["-c", "import importlib.util,json; print(json.dumps({m:importlib.util.find_spec(m) is not None for m in ['fuzzysearch','rapidfuzz','tqdm','bs4','playwright']}))"], { timeout: 10000 });
    report.python_dependencies = JSON.parse(stdout);
    const missing = Object.entries(report.python_dependencies).filter(([, available]) => !available).map(([name]) => name);
    if (missing.length) report.reasons.push(`Missing upstream Python dependencies: ${missing.join(", ")}`);
  } catch (error) { report.reasons.push(`Python preflight: ${error.message}`); }
  if (upstream) {
    try { report.upstream = await verifyUpstream(path.resolve(upstream)); }
    catch (error) { report.reasons.push(`Pinned upstream: ${error.message}`); }
  } else report.reasons.push("Supply --upstream with the pinned clean upstream checkout");
  if (preflight) { await save(); return report; }
  try {
    if (!report.upstream) throw new Error("Pinned upstream unavailable");
    if (!benchRoot || !runPath || !/^[a-f0-9]{64}$/.test(runSha256 ?? "")) throw new Error("--bench-root, --run and independently retained --run-sha256 are required");
    await runOlmocrBench(["verify", "--bench-root", path.resolve(benchRoot)]);
    const runBytes = await fs.readFile(path.resolve(runPath));
    if (hash(runBytes) !== runSha256) throw new Error("Run digest mismatch");
    const run = validateRunReport(parseStrictJson(runBytes.toString(), "retained run"));
    if (run.manifest_sha256 !== hash(manifestBytes)) throw new Error("Run manifest mismatch");
    if (run.corpus.pdf_inventory_sha256 !== manifest.source.pdf_inventory.canonical_inventory_sha256
      || run.corpus.upstream_revision !== manifest.source.revision) throw new Error("Run corpus mismatch");
    const { stdout: currentHead } = await exec("git", ["rev-parse", "HEAD"], { cwd: ROOT });
    const { stdout: currentStatus } = await exec("git", ["status", "--porcelain"], { cwd: ROOT });
    report.candidate_revision_matches_clean_head = run.candidate.git_revision === currentHead.trim() && !currentStatus.trim();
    const categories = [];
    for (const category of manifest.source.categories) {
      const bytes = await fs.readFile(path.join(benchRoot, category.file));
      if (hash(bytes) !== category.sha256) throw new Error("Category changed after verification");
      categories.push({ id: category.id, tests: bytes.toString().split(/\r?\n/).filter(line => line.trim()).map(line => parseStrictJson(line, category.id)) });
    }
    const request = buildUpstreamRequest(categories, run.records);
    const requestPath = path.join(destination, "request.json");
    const responsePath = path.join(destination, "upstream-response.json");
    await fs.writeFile(requestPath, JSON.stringify(request), { flag: "wx", mode: 0o600 });
    report.run_sha256 = runSha256;
    report.candidate = run.candidate;
    report.candidate_qualifying = run.qualifying;
    report.request_sha256 = hash(await fs.readFile(requestPath));
    report.bridge_sha256 = hash(await fs.readFile(path.join(ROOT, "scripts/eval-olmocr-upstream.py")));
    const environment = scorerEnvironment(destination);
    const { stdout: pythonVersion } = await exec(python, ["--version"], { env: environment });
    const { stdout: packages } = await exec(python, ["-m", "pip", "list", "--format=json"], { env: environment, maxBuffer: 4 * 1024 * 1024 });
    report.runtime = { python: pythonVersion.trim(), packages: JSON.parse(packages) };
    let response;
    try {
      await exec(python, [path.join(ROOT, "scripts/eval-olmocr-upstream.py"), path.resolve(upstream), requestPath, responsePath],
        { env: environment, timeout: 60 * 60 * 1000, maxBuffer: 8 * 1024 * 1024 });
      const bytes = await fs.readFile(responsePath);
      report.response_sha256 = hash(bytes);
      response = parseStrictJson(bytes.toString(), "upstream response");
    } catch (error) { response = { status: "unavailable", reason: error.message }; }
    report.upstream_after = await verifyUpstream(path.resolve(upstream));
    report.upstream_source_stable = isDeepStrictEqual(report.upstream, report.upstream_after);
    if (!report.upstream_source_stable) throw new Error("Upstream scorer source changed during execution");
    report.metrics = summarizeUpstream(request, response);
    report.status = report.metrics.complete ? "completed" : "incomplete";
    if (response.reason) report.reasons.push(response.reason);
    report.upstream_compatible_score_complete = report.metrics.complete && run.qualifying;
    report.current_head_score_complete = report.upstream_compatible_score_complete && report.candidate_revision_matches_clean_head;
  } catch (error) { report.reasons.push(error.message); }
  await save();
  return report;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2), options = {};
  const names = { "--output": "output", "--upstream": "upstream", "--bench-root": "benchRoot", "--run": "runPath", "--run-sha256": "runSha256", "--python": "python" };
  try {
    for (let index = 0; index < args.length; index += 1) {
      if (args[index] === "--preflight") { options.preflight = true; continue; }
      const key = names[args[index]];
      if (!key || options[key] || !args[index + 1]) throw new Error(`Invalid option ${args[index]}`);
      options[key] = args[++index];
    }
    if (!options.output) throw new Error("--output NEW_DIRECTORY is required");
    await runUpstream(options).then(report => {
      console.log(JSON.stringify({ status: report.status, report: path.join(path.resolve(options.output), "report.json"), reasons: report.reasons }, null, 2));
      if (!report.upstream_compatible_score_complete) process.exitCode = 2;
    });
  } catch (error) { console.error(error.stack); process.exitCode = 1; }
}
