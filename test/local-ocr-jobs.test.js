import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";
import { createLocalOcrJobHandlers, LOCAL_OCR_JOB_TOOL_DEFINITIONS } from "../server/local-ocr-jobs.js";
import { createLocalOcrToolHandler } from "../server/local-ocr-tools.js";
import { validateStructuredToolResult } from "../server/output-schemas.js";

const sha = bytes => createHash("sha256").update(bytes).digest("hex");
const encoded = value => Buffer.from(`${JSON.stringify(value)}\n`);
const source = Buffer.from("%PDF-1.7\nSynthetic multipage job contract fixture, not an OCR sample\n%%EOF\n");
const helper = Buffer.from("synthetic helper fixture; no executable OCR");
const roots = [];
afterEach(async () => { await Promise.all(roots.splice(0).map(root => fs.rm(root, { recursive: true, force: true }))); });

async function fixture() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "pdf-tools-ocr-jobs-test-"));
  roots.push(root);
  const input = path.join(root, "input.pdf");
  const helperPath = path.join(root, "helper.py");
  await fs.writeFile(input, source, { mode: 0o600 });
  await fs.writeFile(helperPath, helper, { mode: 0o600 });
  const configuration = { engine: "tesseract", pythonPath: process.execPath,
    tesseractPath: process.execPath, helperPath };
  const pagesRun = [];
  const controls = { beforeGenerate: async () => {}, beforeReplay: async () => {} };
  const shared = {
    configuration, platform: "linux", expectedHelperSha256: sha(helper),
    resolvePdfPath: candidate => { assert.equal(candidate, input); return candidate; },
    readPdfBytes: candidate => fs.readFile(candidate),
  };
  const single = createLocalOcrToolHandler({ ...shared, stateRoot: path.join(root, "proposals"),
    invokeAdapter: async (_python, _helper, args) => {
      const value = key => args[args.indexOf(key) + 1];
      if (args.includes("--output-dir")) {
        const page = Number(value("--page"));
        pagesRun.push(page);
        await controls.beforeGenerate(page);
        const directory = value("--output-dir");
        await fs.mkdir(directory, { mode: 0o700 });
        const image = Buffer.from(`synthetic PNG bytes for page ${page}`);
        const proposal = { schema: "pdf-tools.local-ocr-proposal.v1", status: "unverified_ocr_proposal",
          page_number: page, source_pdf_sha256: sha(source), render_png_sha256: sha(image),
          proposal_sha256: sha(`proposal ${page}`), proposals: [{ observation_index: 0,
            text_proposal: `unverified page ${page}`, engine_confidence_unverified: 0.5,
            box_top_left_pixels: [1, 2, 3, 4] }] };
        await fs.writeFile(path.join(directory, "render.png"), image, { mode: 0o600 });
        await fs.writeFile(path.join(directory, "proposal.json"), encoded(proposal), { mode: 0o600 });
        await fs.writeFile(path.join(directory, "commit.json"), encoded({
          schema: "pdf-tools.local-ocr-commit.v1", proposal_sha256: proposal.proposal_sha256,
          proposal_file_sha256: sha(encoded(proposal)), render_png_sha256: sha(image),
        }), { mode: 0o600 });
        return { status: "unverified_ocr_proposal", source_pdf_sha256: sha(source),
          proposal_sha256: proposal.proposal_sha256 };
      }
      const proposal = JSON.parse(await fs.readFile(path.join(value("--verify-proposal-dir"), "proposal.json")));
      await controls.beforeReplay(proposal.page_number);
      const review = Buffer.from(`<p>UNVERIFIED fixture page ${proposal.page_number}</p>`);
      await fs.writeFile(value("--review-html"), review, { mode: 0o600 });
      return { status: "source_render_replayed_ocr_unverified", source_pdf_sha256: sha(source),
        proposal_sha256: proposal.proposal_sha256, render_png_sha256: proposal.render_png_sha256,
        page_number: proposal.page_number, observation_count: 1, review_html_sha256: sha(review) };
    } });
  const options = { ...shared, stateRoot: path.join(root, "jobs"),
    proposalStateRoot: path.join(root, "proposals"), runPage: single };
  const handlers = createLocalOcrJobHandlers(options);
  const startArgs = { pdf_path: input, pages: [1, 2, 3], expected_source_sha256: sha(source), confirm_local_ocr: true };
  const start = async (overrides = {}) => handlers.start_pdf_ocr_job({ ...startArgs, ...overrides });
  return { root, input, options, configuration, handlers, single, start, startArgs, pagesRun, controls };
}

const jobArgs = result => ({ job_id: result.structuredContent.job_id,
  expected_job_identity_sha256: result.structuredContent.job_identity_sha256 });
const resumeArgs = result => ({ ...jobArgs(result), confirm_local_ocr: true });
const valid = (tool, result) => expect(validateStructuredToolResult(tool, result)).toBe(result);
const jobDirectory = (f, start) => path.join(f.options.stateRoot, start.structuredContent.job_id);

describe.skipIf(!["linux", "darwin"].includes(process.platform))("resumable local OCR jobs", () => {
  it("starts without OCR, requires explicit opt-in, pins a private immutable manifest", async () => {
    const f = await fixture();
    const started = await f.start({ pages: [3, 1, 2] });
    expect(f.pagesRun).toEqual([]);
    valid("start_pdf_ocr_job", started);
    expect(started.structuredContent).toMatchObject({ completed_count: 0, remaining_count: 3,
      status: "ocr_job_ready", remaining_pages: [1, 2, 3], next_action: "resume_pdf_ocr_job" });
    const directory = jobDirectory(f, started);
    expect((await fs.stat(directory)).mode & 0o777).toBe(0o700);
    expect((await fs.stat(path.join(directory, "manifest.json"))).mode & 0o777).toBe(0o600);
    expect(sha(await fs.readFile(path.join(directory, "manifest.json")))).toBe(jobArgs(started).expected_job_identity_sha256);
    for (const definition of LOCAL_OCR_JOB_TOOL_DEFINITIONS) {
      expect(definition.inputSchema.additionalProperties).toBe(false);
      expect(definition.annotations.openWorldHint).toBe(false);
    }
  });

  it("checkpoints at most two pages and resumes across handler instances without rerunning completed pages", async () => {
    const f = await fixture();
    const started = await f.start();
    const first = await f.handlers.resume_pdf_ocr_job({ ...resumeArgs(started), max_pages: 2 });
    valid("resume_pdf_ocr_job", first);
    expect(first.structuredContent).toMatchObject({ completed_count: 2, remaining_count: 1,
      processed_this_call: 2, status: "ocr_job_paused", remaining_pages: [3] });
    expect(f.pagesRun).toEqual([1, 2]);
    const restarted = createLocalOcrJobHandlers(f.options);
    const completed = await restarted.resume_pdf_ocr_job(resumeArgs(started));
    valid("resume_pdf_ocr_job", completed);
    expect(completed.structuredContent).toMatchObject({ completed_count: 3, remaining_count: 0,
      processed_this_call: 1, status: "ocr_job_complete", verification_status: "unverified_ocr_proposals" });
    expect(f.pagesRun).toEqual([1, 2, 3]);
    const again = await restarted.resume_pdf_ocr_job(resumeArgs(started));
    expect(again.structuredContent.processed_this_call).toBe(0);
    expect(f.pagesRun).toEqual([1, 2, 3]);
    const read = await restarted.read_pdf_ocr_job(jobArgs(started));
    valid("read_pdf_ocr_job", read);
    expect(JSON.stringify(read)).not.toContain("text_proposal");
    expect(JSON.stringify(read).length).toBeLessThan(6000);
    for (const page of read.structuredContent.completed_pages) {
      expect((await fs.readFile(page.review_html_path, "utf8"))).toContain("UNVERIFIED");
    }
  });

  it("leaves a partially generated page incomplete, ignores uncommitted staging and retries only that page", async () => {
    const f = await fixture();
    const started = await f.start();
    f.controls.beforeReplay = async page => { if (page === 2) throw new Error("synthetic interruption"); };
    const interrupted = await f.handlers.resume_pdf_ocr_job({ ...resumeArgs(started), max_pages: 2 });
    valid("resume_pdf_ocr_job", interrupted);
    expect(interrupted.structuredContent).toMatchObject({ completed_count: 1, processed_this_call: 1,
      remaining_pages: [2, 3], failed_page: 2, failure_code: "page_attempt_failed" });
    await expect(fs.stat(path.join(jobDirectory(f, started), "page-2.json"))).rejects.toMatchObject({ code: "ENOENT" });
    await fs.writeFile(path.join(jobDirectory(f, started), ".checkpoint-interrupted"), "{", { mode: 0o600 });
    f.controls.beforeReplay = async () => {};
    const resumed = await createLocalOcrJobHandlers(f.options).resume_pdf_ocr_job(resumeArgs(started));
    expect(resumed.structuredContent).toMatchObject({ completed_count: 2, remaining_pages: [3], failed_page: null });
    expect(f.pagesRun).toEqual([1, 2, 2]);
  });

  it("recovers a real dead process lock while preserving earlier completed checkpoints", async () => {
    const f = await fixture();
    const started = await f.start();
    await f.handlers.resume_pdf_ocr_job(resumeArgs(started));
    const module = fileURLToPath(new URL("../server/local-ocr-jobs.js", import.meta.url));
    const script = `import fs from 'node:fs/promises';
      import { createLocalOcrJobHandlers } from ${JSON.stringify(new URL(`file://${module}`).href)};
      const input = JSON.parse(process.argv[1]);
      const handlers = createLocalOcrJobHandlers({ ...input.options,
        resolvePdfPath: candidate => { if (candidate !== input.input) throw Error('outside fixture'); return candidate; },
        readPdfBytes: candidate => fs.readFile(candidate), runPage: async () => process.exit(29) });
      await handlers.resume_pdf_ocr_job(input.args);`;
    await expect(promisify(execFile)(process.execPath, ["--input-type=module", "-e", script,
      JSON.stringify({ input: f.input, options: f.options, args: resumeArgs(started) })], { timeout: 10000 }))
      .rejects.toMatchObject({ code: 29 });
    const directory = jobDirectory(f, started);
    expect((await fs.readdir(path.join(directory, "active.lock"))).length).toBe(1);
    const resumed = await createLocalOcrJobHandlers(f.options).resume_pdf_ocr_job(resumeArgs(started));
    expect(resumed.structuredContent.completed_count).toBe(2);
    expect(f.pagesRun).toEqual([1, 2]);
    await expect(fs.stat(path.join(directory, "active.lock"))).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("refuses a visible checkpoint with uncertain durability until recovery can sync it", async () => {
    const f = await fixture();
    const started = await f.start();
    const directory = jobDirectory(f, started);
    const checkpoint = path.join(directory, "page-1.json");
    const originalOpen = fs.open;
    fs.open = async (file, ...args) => {
      const handle = await originalOpen.call(fs, file, ...args);
      if (file === directory) {
        const originalSync = handle.sync.bind(handle);
        handle.sync = async () => {
          const visible = await fs.stat(checkpoint).then(() => true, error => {
            if (error.code === "ENOENT") return false;
            throw error;
          });
          if (visible) throw Object.assign(new Error("synthetic directory fsync failure"), { code: "EIO" });
          return originalSync();
        };
      }
      return handle;
    };
    try {
      await expect(f.handlers.resume_pdf_ocr_job(resumeArgs(started))).rejects.toThrow(/durability/iu);
      expect(f.pagesRun).toEqual([1]);
      expect((await fs.stat(checkpoint)).isFile()).toBe(true);
      await expect(createLocalOcrJobHandlers(f.options).resume_pdf_ocr_job(resumeArgs(started)))
        .rejects.toThrow(/durability/iu);
      expect(f.pagesRun).toEqual([1]);
    } finally { fs.open = originalOpen; }
    const resumed = await createLocalOcrJobHandlers(f.options).resume_pdf_ocr_job(resumeArgs(started));
    valid("resume_pdf_ocr_job", resumed);
    expect(resumed.structuredContent).toMatchObject({ completed_count: 2, processed_this_call: 1,
      remaining_pages: [3], failed_page: null });
    expect(f.pagesRun).toEqual([1, 2]);
  });

  it("refuses concurrent owners and shares the existing direct single-page operation lock", async () => {
    const f = await fixture();
    const started = await f.start();
    let entered;
    const entering = new Promise(resolve => { entered = resolve; });
    let release;
    const blocking = new Promise(resolve => { release = resolve; });
    f.controls.beforeGenerate = async () => { entered(); await blocking; };
    const first = f.handlers.resume_pdf_ocr_job(resumeArgs(started));
    await entering;
    try {
      await expect(f.handlers.resume_pdf_ocr_job(resumeArgs(started))).rejects.toThrow(/operation is active/u);
      await expect(createLocalOcrJobHandlers(f.options).resume_pdf_ocr_job(resumeArgs(started)))
        .rejects.toThrow(/owns this job/u);
      await expect(f.single({ pdf_path: f.input, page: 2, expected_source_sha256: sha(source), confirm_local_ocr: true }))
        .rejects.toThrow(/request is active/u);
      expect((await f.handlers.read_pdf_ocr_job(jobArgs(started))).structuredContent.completed_count).toBe(0);
    } finally { release(); }
    expect((await first).structuredContent.completed_count).toBe(1);
    expect(f.pagesRun).toEqual([1]);
  });

  for (const [label, change, pattern] of [
    ["source content drift", async f => fs.writeFile(f.input, "%PDF-changed"), /source changed/u],
    ["missing source", async f => fs.unlink(f.input), /ENOENT/u],
    ["changed configured executable", async f => { f.configuration.tesseractPath = "/missing/new-tesseract"; }, /ENOENT/u],
    ["helper byte drift", async f => fs.appendFile(f.configuration.helperPath, "changed"), /reviewed version/u],
  ]) it(`refuses ${label} without another page attempt`, async () => {
    const f = await fixture();
    const started = await f.start();
    await f.handlers.resume_pdf_ocr_job(resumeArgs(started));
    await change(f);
    await expect(f.handlers.resume_pdf_ocr_job(resumeArgs(started))).rejects.toThrow(pattern);
    await expect(f.handlers.read_pdf_ocr_job(jobArgs(started))).rejects.toThrow(pattern);
    expect(f.pagesRun).toEqual([1]);
  });

  it("pins the configured executable invocation path even when both paths reach the same binary", async () => {
    const f = await fixture();
    const started = await f.start();
    const alternate = path.join(f.root, "same-interpreter");
    await fs.symlink(process.execPath, alternate);
    f.configuration.pythonPath = alternate;
    await expect(f.handlers.resume_pdf_ocr_job(resumeArgs(started))).rejects.toThrow(/configuration changed/u);
    expect(f.pagesRun).toEqual([]);
  });

  it("refuses source drift during an attempt and does not count the partially produced page", async () => {
    const f = await fixture();
    const started = await f.start();
    f.controls.beforeReplay = async () => fs.writeFile(f.input, "%PDF-drifted-during-ocr");
    await expect(f.handlers.resume_pdf_ocr_job(resumeArgs(started))).rejects.toThrow(/source changed/u);
    await expect(fs.stat(path.join(jobDirectory(f, started), "page-1.json"))).rejects.toMatchObject({ code: "ENOENT" });
    await fs.writeFile(f.input, source);
    expect((await f.handlers.read_pdf_ocr_job(jobArgs(started))).structuredContent.completed_count).toBe(0);
  });

  for (const [label, change] of [
    ["changed", async file => fs.appendFile(file, "changed")],
    ["missing", async file => fs.unlink(file)],
    ["nonprivate", async file => fs.chmod(file, 0o644)],
  ]) it(`refuses a ${label} completed artifact rather than skipping it as valid`, async () => {
    const f = await fixture();
    const started = await f.start();
    const first = await f.handlers.resume_pdf_ocr_job(resumeArgs(started));
    await change(first.structuredContent.completed_pages[0].review_html_path);
    await expect(f.handlers.resume_pdf_ocr_job(resumeArgs(started))).rejects.toThrow();
    await expect(f.handlers.read_pdf_ocr_job(jobArgs(started))).rejects.toThrow();
    expect(f.pagesRun).toEqual([1]);
  });

  it("rejects job traversal, wrong identity and foreign retained paths", async () => {
    const f = await fixture();
    const started = await f.start();
    await expect(f.handlers.read_pdf_ocr_job({ ...jobArgs(started), job_id: "../other" })).rejects.toThrow(/exact/u);
    await expect(f.handlers.read_pdf_ocr_job({ ...jobArgs(started), expected_job_identity_sha256: "f".repeat(64) }))
      .rejects.toThrow(/does not match/u);
    await f.handlers.resume_pdf_ocr_job(resumeArgs(started));
    const checkpoint = path.join(jobDirectory(f, started), "page-1.json");
    const value = JSON.parse(await fs.readFile(checkpoint));
    value.proposal_id = "../../foreign";
    await fs.writeFile(checkpoint, encoded(value));
    await expect(f.handlers.read_pdf_ocr_job(jobArgs(started))).rejects.toThrow(/proposal ID/u);
  });

  it("does not reclaim a malformed lock or follow symlinked private job directories", async () => {
    const f = await fixture();
    const started = await f.start();
    const directory = jobDirectory(f, started);
    const lock = path.join(directory, "active.lock");
    await fs.mkdir(lock, { mode: 0o700 });
    await fs.writeFile(path.join(lock, "owner-invalid.json"), "{}", { mode: 0o600 });
    await expect(f.handlers.resume_pdf_ocr_job(resumeArgs(started))).rejects.toThrow(/lock is invalid/u);
    expect(f.pagesRun).toEqual([]);
    const alternate = path.join(f.options.stateRoot, randomUUID());
    await fs.rename(directory, alternate);
    await fs.symlink(alternate, directory);
    await expect(f.handlers.read_pdf_ocr_job(jobArgs(started))).rejects.toThrow(/physical/u);
  });

  it("enforces page/argument budgets before work and requires fresh confirmation for resume", async () => {
    const f = await fixture();
    for (const override of [{ pages: [] }, { pages: [1, 1] }, { pages: [0] }, { pages: [10001] },
      { pages: [1.5] }, { pages: Array.from({ length: 21 }, (_, index) => index + 1) },
      { confirm_local_ocr: false }, { unexpected: true }]) {
      await expect(f.start(override)).rejects.toThrow();
    }
    const started = await f.start();
    for (const override of [{ max_pages: 0 }, { max_pages: 3 }, { max_pages: 1.5 },
      { confirm_local_ocr: false }, { confirm_local_ocr: undefined }, { python_path: "/foreign" }]) {
      await expect(f.handlers.resume_pdf_ocr_job({ ...resumeArgs(started), ...override })).rejects.toThrow();
    }
    expect(f.pagesRun).toEqual([]);
  });

  it("rejects inconsistent output counts and any claim that OCR text was verified", async () => {
    const f = await fixture();
    const started = await f.start();
    for (const override of [{ verification_status: "verified" }, { completed_count: 1 },
      { processed_this_call: 1 }, { next_action: "review_unverified_proposals" }, { failed_page: 1 }]) {
      expect(validateStructuredToolResult("start_pdf_ocr_job", {
        ...started, structuredContent: { ...started.structuredContent, ...override },
      }).isError).toBe(true);
    }
  });
});
