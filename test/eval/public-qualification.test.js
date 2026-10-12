import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";
import { buildUpstreamRequest, summarizeUpstream } from "../../scripts/eval-olmocr-upstream.mjs";
import { WORKFLOW_OBLIGATIONS, scoreWorkflow } from "../../scripts/eval-workflow-score.mjs";

const exec = promisify(execFile);
const cleanup = [];
afterEach(async () => { await Promise.all(cleanup.splice(0).map(directory => fs.rm(directory, { recursive: true, force: true }))); });
const tests = [{ id: "alpha", tests: [{ id: "a", pdf: "one.pdf", page: 1, type: "present", text: "A" }] },
  { id: "beta", tests: [{ id: "b", pdf: "two.pdf", page: 1, type: "absent", text: "B" }, { id: "c", pdf: "two.pdf", page: 1, type: "present", text: "C" }] }];
const records = [{ pdf: "one.pdf", ok: true, outcome: "converted", markdown: "**A**\n" },
  { pdf: "two.pdf", ok: true, outcome: "converted", markdown: "C" }];

describe("pinned upstream bridge denominator", () => {
  it("preserves exact Markdown, categories, and the default baseline for every PDF", () => {
    const request = buildUpstreamRequest(tests, records);
    expect(request.tests).toHaveLength(5);
    expect(request.tests[0].markdown).toBe("**A**\n");
    expect(request.tests.slice(3).map(row => row.id)).toEqual(["one.pdf_baseline", "two.pdf_baseline"]);
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
