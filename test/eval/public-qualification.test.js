import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";
import { buildUpstreamRequest, requireScorerProcessSuccess, runScorerProcess, scorerEnvironment, summarizeUpstream } from "../../scripts/eval-olmocr-upstream.mjs";
import { WORKFLOW_OBLIGATIONS, scoreWorkflow } from "../../scripts/eval-workflow-score.mjs";

const exec = promisify(execFile);
const cleanup = [];
afterEach(async () => { await Promise.all(cleanup.splice(0).map(directory => fs.rm(directory, { recursive: true, force: true }))); });
const tests = [{ id: "alpha", tests: [{ id: "a", pdf: "one.pdf", page: 1, type: "present", text: "A" }] },
  { id: "beta", tests: [{ id: "b", pdf: "two.pdf", page: 1, type: "absent", text: "B" }, { id: "c", pdf: "two.pdf", page: 1, type: "present", text: "C" }] }];
const records = [{ pdf: "one.pdf", ok: true, outcome: "converted", markdown: "**A**\n" },
  { pdf: "two.pdf", ok: true, outcome: "converted", markdown: "C" }];

describe("bounded upstream scorer process", () => {
  const environment = { PATH: path.dirname(process.execPath) };
  it("drains diagnostics beyond the former 8 MiB cap with exact bounded prefixes and stream hashes", async () => {
    const count = 9 * 1024 * 1024;
    const result = await runScorerProcess(process.execPath, ["-e",
      `process.stdout.write(Buffer.alloc(${count}, 65)); process.stderr.write(Buffer.alloc(${count}, 66));`],
    { environment, timeoutMs: 3000 });
    expect(() => requireScorerProcessSuccess(result)).not.toThrow();
    for (const [stream, byte] of [["stdout", 65], ["stderr", 66]]) {
      expect(result[stream]).toMatchObject({ bytes: count, retained_bytes: 65536,
        omitted_bytes: count - 65536,
        sha256: createHash("sha256").update(Buffer.alloc(count, byte)).digest("hex") });
      expect(Buffer.from(result[stream].prefix_base64, "base64")).toEqual(Buffer.alloc(65536, byte));
    }
  });
  it("refuses nonzero exit even when the child wrote an apparent response", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "pdf-scorer-failed-response-")); cleanup.push(root);
    const response = path.join(root, "response.json");
    const result = await runScorerProcess(process.execPath, ["-e",
      `require('node:fs').writeFileSync(${JSON.stringify(response)}, '{"status":"completed"}'); process.exitCode = 7;`],
    { environment, timeoutMs: 3000 });
    expect(result.exit_code).toBe(7);
    expect(JSON.parse(await fs.readFile(response, "utf8")).status).toBe("completed");
    expect(() => requireScorerProcessSuccess(result)).toThrow("did not complete");
  });
  it("reports startup failure and refuses invalid or enlarged bounds", async () => {
    const result = await runScorerProcess(path.join(os.tmpdir(), "nonexistent-pdf-scorer-executable"), [],
      { environment, timeoutMs: 500 });
    expect(result.start_error).toBeTruthy();
    expect(() => requireScorerProcessSuccess(result)).toThrow();
    for (const invalid of [{ timeoutMs: 3600001 }, { timeoutMs: 0 }, { diagnosticBytes: 65537 }]) {
      expect(() => runScorerProcess(process.execPath, [], { environment, ...invalid })).toThrow();
    }
  });
  it("retains timeout and cancellation as failures", async () => {
    const timed = await runScorerProcess(process.execPath, ["-e", "setInterval(() => {}, 1000)"],
      { environment, timeoutMs: 100 });
    expect(timed.timed_out).toBe(true);
    expect(() => requireScorerProcessSuccess(timed)).toThrow();
    const controller = new AbortController();
    const running = runScorerProcess(process.execPath, ["-e", "setInterval(() => {}, 1000)"],
      { environment, timeoutMs: 3000, abortSignal: controller.signal });
    controller.abort();
    const cancelled = await running;
    expect(cancelled.cancelled_signal).toBe("ABORT");
    expect(() => requireScorerProcessSuccess(cancelled)).toThrow();
    expect(() => runScorerProcess(process.execPath, [],
      { environment, abortSignal: controller.signal })).toThrow("before start");
  });
  it.skipIf(process.platform === "win32")("reaps a descendant holding output pipes after its root exits", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "pdf-scorer-descendant-")); cleanup.push(root);
    const pidFile = path.join(root, "child.pid");
    const script = `const child = require('node:child_process').spawn(process.execPath,
      ['-e', 'setInterval(() => {}, 1000)'], { stdio: ['ignore', 1, 2] });
      require('node:fs').writeFileSync(${JSON.stringify(pidFile)}, String(child.pid)); process.exit(0);`;
    const result = await runScorerProcess(process.execPath, ["-e", script], { environment, timeoutMs: 3000 });
    expect(() => requireScorerProcessSuccess(result)).not.toThrow();
    const pid = Number(await fs.readFile(pidFile, "utf8"));
    const running = async () => {
      try {
        if (process.platform === "linux") {
          const stat = await fs.readFile(`/proc/${pid}/stat`, "utf8");
          return stat.slice(stat.lastIndexOf(")") + 2).split(" ")[0] !== "Z";
        }
        process.kill(pid, 0);
        return true;
      } catch (error) { if (["ESRCH", "ENOENT"].includes(error.code)) return false; throw error; }
    };
    for (let attempt = 0; attempt < 50 && await running(); attempt += 1) {
      await new Promise(resolve => setTimeout(resolve, 20));
    }
    expect(await running()).toBe(false);
  });
});

describe("pinned upstream bridge denominator", () => {
  it("retains the installed browser while isolating equation caches and ambient credentials", () => {
    const environment = scorerEnvironment("/evidence/run", { home: "/original/home", platform: "linux", environment: { PATH: "/bin", OPENAI_API_KEY: "must-not-inherit" } });
    expect(environment.HOME).toBe("/evidence/run");
    expect(environment.PLAYWRIGHT_BROWSERS_PATH).toBe("/original/home/.cache/ms-playwright");
    expect(environment.OPENAI_API_KEY).toBeUndefined();
    expect(scorerEnvironment("/evidence", { home: "/home", platform: "darwin", environment: {} }).PLAYWRIGHT_BROWSERS_PATH)
      .toBe("/home/Library/Caches/ms-playwright");
    expect(scorerEnvironment("/evidence", { environment: { PLAYWRIGHT_BROWSERS_PATH: "0" } }).PLAYWRIGHT_BROWSERS_PATH).toBe("0");
  });
  it("preserves exact Markdown, categories, and the default baseline for every PDF", () => {
    const request = buildUpstreamRequest(tests, records);
    expect(request.tests).toHaveLength(5);
    expect(request.tests[0].markdown).toBe("**A**\n");
    expect(request.tests.slice(3).map(row => row.id)).toEqual(["one.pdf_baseline", "two.pdf_baseline"]);
  });
  it("does not duplicate baseline tests already present in the upstream annotations", () => {
    const request = buildUpstreamRequest([{ id: "annotated", tests: [
      { id: "existing-base", pdf: "one.pdf", page: 1, type: "baseline" },
      { id: "text", pdf: "two.pdf", page: 1, type: "present", text: "C" },
    ] }], records);
    expect(request.tests).toHaveLength(3);
    expect(request.tests.filter(row => row.test.type === "baseline").map(row => row.test.pdf))
      .toEqual(["one.pdf", "two.pdf"]);
  });
  it("uses the upstream category macro-average instead of a micro-average", () => {
    const request = buildUpstreamRequest(tests, records);
    const response = { status: "completed", results: request.tests.map((row, index) => ({ id: row.id, category: row.category, status: index === 0 ? "failed" : "passed" })) };
    const score = summarizeUpstream(request, response);
    expect(score.upstream_macro_average).toBeCloseTo(2 / 3);
    expect(score.passed / score.total).toBe(4 / 5);
  });
  it("keeps failures, missing PDFs and unavailable scoring in the fixed denominator", () => {
    const request = buildUpstreamRequest(tests, records.slice(0, 1));
    expect(request.tests.filter(row => row.markdown === null)).toHaveLength(3);
    const unavailable = summarizeUpstream(request, { status: "unavailable" });
    expect(unavailable).toMatchObject({ total: 5, not_run: 5, complete: false, upstream_macro_average: null });
    expect(() => summarizeUpstream(request, { status: "completed", results: [] })).toThrow("denominator");
    const invented = { status: "completed", results: request.tests.map(row => ({ id: row.id, category: row.category, status: "passed" })) };
    expect(() => summarizeUpstream(request, invented)).toThrow("Unattempted");
  });
  it("rejects reordered, duplicated, skipped and extra identities", () => {
    expect(() => buildUpstreamRequest([...tests, tests[0]], records)).toThrow();
    expect(() => buildUpstreamRequest(tests, [...records, records[0]])).toThrow();
    expect(() => buildUpstreamRequest(tests, [...records, { pdf: "extra.pdf" }])).toThrow();
    const request = buildUpstreamRequest(tests, records);
    const rows = request.tests.map(row => ({ id: row.id, category: row.category, status: "passed" }));
    expect(() => summarizeUpstream(request, { status: "completed", results: [...rows].reverse() })).toThrow();
    rows[0].status = "not_run";
    expect(() => summarizeUpstream(request, { status: "completed", results: rows })).toThrow("silently skipped");
  });
  it("executes imported upstream test classes and preserves exceptions without inventing scores", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "pdf-upstream-bridge-test-")); cleanup.push(root);
    const moduleDirectory = path.join(root, "olmocr", "bench");
    await fs.mkdir(moduleDirectory, { recursive: true });
    await fs.writeFile(path.join(root, "olmocr", "__init__.py"), "");
    await fs.writeFile(path.join(moduleDirectory, "__init__.py"), "");
    await fs.writeFile(path.join(moduleDirectory, "tests.py"), `
def render_equation(value):
    assert value == r"x^2+1"
    return object()
class Test:
    def __init__(self, data): self.data = data
    def run(self, markdown):
        if self.data["id"] == "c": raise RuntimeError("synthetic scorer failure")
        return markdown == "**A**\\n", "wire check"
def load_single_test(data): return Test(data)
`);
    const request = buildUpstreamRequest(tests, records);
    const input = path.join(root, "request.json"), output = path.join(root, "response.json");
    await fs.writeFile(input, JSON.stringify(request));
    await exec("python3", [path.resolve("scripts/eval-olmocr-upstream.py"), root, input, output], { timeout: 10000 });
    const response = JSON.parse(await fs.readFile(output, "utf8"));
    expect(response.results[0].status).toBe("passed");
    expect(response.results[1].status).toBe("failed");
    expect(response.results[2].status).toBe("scorer_error");
    expect(summarizeUpstream(request, response)).toMatchObject({ complete: false, scorer_error: 1, upstream_macro_average: null });
  });
});

describe("public synthetic workflow score", () => {
  const pass = () => WORKFLOW_OBLIGATIONS.map(item => ({ ...item, status: "passed", ...(item.kind === "refusal" ? { accepted: false } : {}) }));
  it("requires every obligation including all negative controls", () => {
    expect(scoreWorkflow(pass())).toMatchObject({ passed: 12, passed_all: true, coverage: 1 });
    expect(() => scoreWorkflow(pass().slice(1))).toThrow("denominator");
    expect(() => scoreWorkflow(pass().reverse())).toThrow("identity");
    const rows = pass(); rows[0] = rows[1];
    expect(() => scoreWorkflow(rows)).toThrow("identity");
  });
  it("never treats missing negative controls as evidence of zero false acceptance", () => {
    const rows = pass();
    const negative = rows.find(row => row.kind === "refusal");
    negative.status = "not_run"; negative.accepted = null;
    expect(scoreWorkflow(rows)).toMatchObject({ passed_all: false, not_run: 1, false_acceptance: { fully_observed: false, total: 2, attempted: 1 } });
    negative.status = "failed"; negative.accepted = true;
    expect(scoreWorkflow(rows).false_acceptance).toMatchObject({ accepted: 1, rate_all_negative_cases: 0.5, fully_observed: true });
    negative.status = "passed";
    expect(() => scoreWorkflow(rows)).toThrow("contradicts");
  });
});
