#!/usr/bin/env node
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { isDeepStrictEqual, promisify } from "node:util";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { PDFDocument, StandardFonts } from "pdf-lib";
import { WORKFLOW_OBLIGATIONS, scoreWorkflow } from "./eval-workflow-score.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const exec = promisify(execFile);
const digest = bytes => createHash("sha256").update(bytes).digest("hex");
const now = () => new Date().toISOString();

async function sourceBinding() {
  const { stdout: revision } = await exec("git", ["rev-parse", "HEAD"], { cwd: ROOT });
  const { stdout: status } = await exec("git", ["status", "--porcelain"], { cwd: ROOT });
  const { stdout: filenames } = await exec("git", ["ls-files", "server", "scripts", "package.json", "package-lock.json"], { cwd: ROOT });
  const entries = [];
  for (const filename of filenames.trim().split("\n").filter(Boolean)) {
    entries.push({ path: filename, sha256: digest(await fs.readFile(path.join(ROOT, filename))) });
  }
  return { revision: revision.trim(), clean: !status.trim(), files_sha256: digest(JSON.stringify(entries)), files: entries };
}

async function sampleProcessTree(rootPid) {
  if (process.platform !== "linux" || !rootPid) return null;
  const parentStatus = await fs.readFile("/proc/self/status", "utf8");
  const parentHostPid = Number(parentStatus.match(/^Pid:\s+(\d+)/m)?.[1]);
  const processes = [];
  for (const name of await fs.readdir("/proc")) {
    if (!/^\d+$/.test(name)) continue;
    try {
      const status = await fs.readFile(`/proc/${name}/status`, "utf8");
      processes.push({ pid: Number(name), ppid: Number(status.match(/^PPid:\s+(\d+)/m)?.[1]),
        namespacePid: Number(status.match(/^NSpid:\s+(.+)$/m)?.[1].trim().split(/\s+/).at(-1) ?? name),
        rss: Number(status.match(/^VmRSS:\s+(\d+)/m)?.[1] ?? 0) * 1024 });
    } catch { /* Process exited between inventory and read. */ }
  }
  // /proc may expose outer-namespace PIDs while child_process reports the
  // inner PID. Match the direct parent and namespace PID, never PID alone.
  const roots = processes.filter(item => item.ppid === parentHostPid && item.namespacePid === rootPid);
  if (roots.length !== 1) return null;
  const observedRootPid = roots[0].pid;
  const descendants = new Set([observedRootPid]);
  let size;
  do {
    size = descendants.size;
    for (const item of processes) if (descendants.has(item.ppid)) descendants.add(item.pid);
  } while (size !== descendants.size);
  return processes.filter(item => descendants.has(item.pid)).reduce((sum, item) => sum + item.rss, 0);
}

export async function runWorkflows({ output, seed = "qualification-v1", python = "python3" }) {
  output = path.resolve(output);
  if (output === ROOT || output.startsWith(`${ROOT}${path.sep}`)) throw new Error("Evidence must be outside the repository");
  await fs.mkdir(output, { mode: 0o700 }); // Exclusive run directory; never replace evidence.
  const initialSource = await sourceBinding();
  const started = now();
  const observations = WORKFLOW_OBLIGATIONS.map(item => ({ ...item, status: "not_run", ...(item.kind === "refusal" ? { accepted: null } : {}) }));
  const calls = [];
  const transcript = [];
  const oracleReads = [];
  const errors = [];
  const artifacts = [];
  const record = (id, passed, detail = {}) => {
    const row = observations.find(item => item.id === id);
    if (!row || row.status !== "not_run") throw new Error(`Duplicate or unknown obligation ${id}`);
    Object.assign(row, { status: passed ? "passed" : "failed", ...detail });
  };
  const stage = async (name, run) => {
    try { await run(); }
    catch (error) { errors.push({ stage: name, message: String(error.message).slice(0, 1500) }); }
  };
  const home = path.join(output, "home");
  const pluginData = path.join(output, "plugin-data");
  const data = path.join(output, "artifacts");
  await fs.mkdir(home);
  await fs.mkdir(pluginData);
  await fs.mkdir(data);
  await fs.mkdir(path.join(pluginData, "workspace"));
  const transport = new StdioClientTransport({
    command: process.execPath, args: [path.join(ROOT, "server/index.js")], cwd: ROOT,
    env: { PATH: process.env.PATH ?? "", HOME: home, PLUGIN_DATA: pluginData,
      ALLOWED_DIRECTORIES: JSON.stringify([data, path.join(pluginData, "workspace")]) }, stderr: "pipe",
  });
  let stderr = "";
  transport.stderr?.on("data", chunk => { stderr = (stderr + chunk).slice(-16000); });
  const client = new Client({ name: "pdf-tools-public-workflow-qualification", version: "1.0.0" });
  let peakRss = null, samples = 0, sampleInFlight = false, memoryError = null;
  const timer = setInterval(async () => {
    if (sampleInFlight) return;
    sampleInFlight = true;
    try { const rss = await sampleProcessTree(transport.pid); if (rss !== null) { peakRss = Math.max(peakRss ?? 0, rss); samples += 1; } }
    catch (error) { memoryError = String(error.message).slice(0, 500); }
    finally { sampleInFlight = false; }
  }, 100);
  const call = async (name, args, allowError = false) => {
    const startedAt = now(), start = performance.now();
    let response;
    try {
      response = await client.callTool({ name, arguments: args }, undefined, { timeout: 30000 });
      transcript.push({ name, arguments: args, result: response });
      calls.push({ name, started_at: startedAt, completed_at: now(), elapsed_ms: performance.now() - start,
        outcome: response.isError ? "product_error" : "completed", response_sha256: digest(JSON.stringify(response)) });
    } catch (error) {
      transcript.push({ name, arguments: args, error: String(error.message) });
      calls.push({ name, started_at: startedAt, completed_at: now(), elapsed_ms: performance.now() - start,
        outcome: "transport_error", message: String(error.message).slice(0, 500) });
      throw error;
    }
    if (response.isError && !allowError) throw new Error(`${name}: ${JSON.stringify(response).slice(0, 1000)}`);
    return response;
  };
  const save = async (name, bytes) => {
    const filename = path.join(data, name);
    await fs.writeFile(filename, bytes, { flag: "wx", mode: 0o600 });
    artifacts.push({ path: `artifacts/${name}`, size_bytes: bytes.length, sha256: digest(bytes) });
    return filename;
  };
  const oracle = async filename => {
    const { stdout } = await exec(python, [path.join(ROOT, "scripts/eval-workflow-oracle.py"), filename], { timeout: 30000, maxBuffer: 1024 * 1024 });
    const observed = JSON.parse(stdout);
    oracleReads.push({ path: path.relative(output, filename), source_sha256: digest(await fs.readFile(filename)), observed });
    return observed;
  };
  let oracleVersion = null;
  try {
    await client.connect(transport);
    const token = digest(seed).slice(0, 12);
    const expected = { Customer: `Synthetic, Example ${token}`, Reference: `REF-${token}` };
    const pdf = await PDFDocument.create();
    const font = await pdf.embedFont(StandardFonts.Helvetica);
    const created = new Date("2026-01-01T00:00:00Z");
    pdf.setCreationDate(created); pdf.setModificationDate(created);
    for (const [index, label] of ["FIRST", "SECOND"].entries()) {
      const page = pdf.addPage([420 + index * 20, 600]);
      page.drawText(`${label} ${token}`, { x: 30, y: 550, font, size: 14 });
    }
    for (const [index, name] of Object.keys(expected).entries()) {
      const field = pdf.getForm().createTextField(name);
      field.addToPage(pdf.getPage(0), { x: 30, y: 450 - index * 50, width: 330, height: 25, font });
    }
    const sourceBytes = Buffer.from(await pdf.save());
    await save("source-form.pdf", sourceBytes);
    let importedPath, filledPath;
    await stage("import_and_fill", async () => {
      const imported = await call("import_host_pdf", { pdf_base64: sourceBytes.toString("base64"), display_name: "Synthetic qualification" });
      importedPath = imported.structuredContent.active_path;
      record("import.exact_bytes", Buffer.from(await fs.readFile(importedPath)).equals(sourceBytes));
      const fields = await call("read_pdf_fields", { pdf_path: importedPath });
      const fieldNames = fields.structuredContent?.fields?.map(field => field.name).sort();
      record("inspect.fields", JSON.stringify(fieldNames) === JSON.stringify(Object.keys(expected).sort()));
      filledPath = path.join(data, "filled-form.pdf");
      await call("fill_pdf", { pdf_path: importedPath, output_path: filledPath, field_data: expected });
      const reopened = await oracle(filledPath);
      oracleVersion = reopened.version;
      record("fill.independent_fields", isDeepStrictEqual(reopened.fields, expected) && reopened.pages.length === 2);
      record("fill.original_unchanged", Buffer.from(await fs.readFile(importedPath)).equals(sourceBytes));
      const streamed = await call("read_pdf_bytes", { pdf_path: filledPath });
      const wire = streamed.structuredContent;
      const returned = Buffer.from(wire.bytes, "base64");
      record("return.exact_bytes", wire.hasMore === false && wire.offset === 0 && wire.totalBytes === returned.length
        && returned.equals(await fs.readFile(filledPath)));
      const returnedPath = await save("returned-form.pdf", returned);
      const independent = await oracle(returnedPath);
      record("return.independent_fields", isDeepStrictEqual(independent.fields, expected)
        && independent.pages.length === 2 && independent.pages.every((page, index) => page.text.includes(`${["FIRST", "SECOND"][index]} ${token}`)));
    });
    await stage("reorder", async () => {
      assert.ok(importedPath, "import did not provide a source");
      const target = path.join(data, "reordered.pdf");
      await call("reorder_pdf_pages", { input_path: importedPath, output_path: target, page_order: [2, 1] });
      const readback = await oracle(target);
      oracleVersion = readback.version;
      record("reorder.independent_pages", readback.pages.length === 2
        && readback.pages[0].text.includes(`SECOND ${token}`) && readback.pages[0].width === 440
        && readback.pages[1].text.includes(`FIRST ${token}`) && readback.pages[1].width === 420);
      record("reorder.original_unchanged", Buffer.from(await fs.readFile(importedPath)).equals(sourceBytes));
    });
    await stage("textless", async () => {
      const blank = await PDFDocument.create();
      blank.setCreationDate(created); blank.setModificationDate(created);
      blank.addPage([200, 200]).drawRectangle({ x: 10, y: 10, width: 100, height: 100 });
      const filename = await save("textless.pdf", Buffer.from(await blank.save()));
      const result = await call("convert_pdf_to_markdown", { pdf_path: filename });
      const body = result.structuredContent;
      record("textless.explicit_gap", body.conversion_status !== "complete"
        && body.gaps.some(gap => ["TEXT_LAYER_EMPTY", "OCR_NOT_PERFORMED"].includes(gap.code)));
    });
    await stage("invalid_import", async () => {
      const response = await call("import_host_pdf", { pdf_base64: Buffer.from("This is not a PDF").toString("base64") }, true);
      record("invalid_import.refused", response.isError === true, { accepted: response.isError !== true });
    });
    await stage("invalid_reorder", async () => {
      assert.ok(importedPath, "import did not provide a source");
      const target = path.join(data, "invalid-reorder.pdf");
      const response = await call("reorder_pdf_pages", { input_path: importedPath, output_path: target, page_order: [1, 1] }, true);
      record("invalid_reorder.refused", response.isError === true, { accepted: response.isError !== true });
      let exists = true;
      try { await fs.stat(target); } catch (error) { if (error.code !== "ENOENT") throw error; exists = false; }
      record("invalid_reorder.no_output", !exists && Buffer.from(await fs.readFile(importedPath)).equals(sourceBytes));
    });
  } catch (error) { errors.push({ stage: "setup", message: String(error.message).slice(0, 1500) }); }
  finally { clearInterval(timer); await client.close().catch(() => {}); }
  const elapsed = calls.map(item => item.elapsed_ms).sort((a, b) => a - b);
  const percentile = fraction => elapsed.length ? elapsed[Math.ceil(fraction * elapsed.length) - 1] : null;
  const source = await sourceBinding();
  const sourceStable = isDeepStrictEqual(initialSource, source);
  const metrics = scoreWorkflow(observations);
  const report = {
    schema: "pdf-tools.public-workflow-qualification.v1", started_at: started, completed_at: now(),
    scope: "generated-synthetic-stdio-with-independent-pypdf-oracle", seed,
    generator_sha256: digest(await fs.readFile(fileURLToPath(import.meta.url))),
    oracle_sha256: digest(await fs.readFile(path.join(ROOT, "scripts/eval-workflow-oracle.py"))),
    oracle_version: oracleVersion, source: initialSource, source_after: source,
    source_stable: sourceStable,
    qualified: metrics.passed_all && sourceStable && initialSource.clean,
    claim_boundary: { benchmark_claim_ready: false, native_host_accepted: false, unseen_holdout: false,
      real_signature_executed: false, model_calls: 0, note: "Public generator, deterministic fixtures, no extraction superiority or native UI claim." },
    runtime: { node: process.version, platform: process.platform, architecture: process.arch },
    metrics, observations, calls, errors, artifacts, oracle_reads: oracleReads,
    resources: { latency_p50_ms: percentile(0.5), latency_p95_ms: percentile(0.95),
      server_tree_rss_sampled_max_bytes: peakRss, samples, memory_error: memoryError,
      memory_scope: "Linux /proc current RSS sum of observed server descendants every 100ms; sampled, not peak/limit; excludes independent oracle" },
  };
  const transcriptBytes = transcript.map(item => JSON.stringify(item)).join("\n") + "\n";
  report.transcript_sha256 = digest(transcriptBytes);
  await fs.writeFile(path.join(output, "transcript.jsonl"), transcriptBytes, { flag: "wx", mode: 0o600 });
  await fs.writeFile(path.join(output, "server-stderr.txt"), stderr, { flag: "wx", mode: 0o600 });
  await fs.writeFile(path.join(output, "report.json"), `${JSON.stringify(report, null, 2)}\n`, { flag: "wx", mode: 0o600 });
  return report;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [output, seed, python] = process.argv.slice(2);
  if (!output) { console.error("Usage: node scripts/eval-workflows.mjs NEW_ABSOLUTE_OUTPUT_DIRECTORY [SEED] [PYTHON]"); process.exitCode = 1; }
  else runWorkflows({ output, seed, python }).then(report => {
    console.log(JSON.stringify({ report: path.join(path.resolve(output), "report.json"), qualified: report.qualified, source_stable: report.source_stable, metrics: report.metrics, resources: report.resources }, null, 2));
    if (!report.qualified) process.exitCode = 2;
  }).catch(error => { console.error(error.stack); process.exitCode = 1; });
}
