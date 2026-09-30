import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { test } from "node:test";
import {
  createLocalOcrToolHandler, LOCAL_OCR_TOOL_DEFINITION,
  LOCAL_OCR_HELPER_SHA256, runLocalOcrAdapter,
} from "../server/local-ocr-tools.js";
import { validateLocalOcrResult } from "../server/output-schemas.js";

const digest = bytes => createHash("sha256").update(bytes).digest("hex");
const source = Buffer.from("%PDF-1.7\nsynthetic wrapper fixture\n%%EOF\n");
const helperBytes = Buffer.from("synthetic adapter fixture, NOT OCR");
const canonical = value => Buffer.from(JSON.stringify(value) + "\n");
const args = { pdf_path: "/allowed/source.pdf", page: 1,
  expected_source_sha256: digest(source), confirm_local_ocr: true };

async function fixture(t, { observations = 2, change = async () => {}, pngBytes = 12 } = {}) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "pdf-tools-ocr-unit-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const helperPath = path.join(root, "helper.py");
  await fs.writeFile(helperPath, helperBytes, { mode: 0o600 });
  let readCount = 0;
  let invokeCount = 0;
  let job;
  const options = {
    configuration: { pythonPath: process.execPath, helperPath },
    expectedHelperSha256: digest(helperBytes), platform: "darwin",
    stateRoot: path.join(root, "state"),
    resolvePdfPath: file => { assert.equal(file, args.pdf_path); return file; },
    readPdfBytes: async () => { readCount += 1; return source; },
    invokeAdapter: async (_python, capturedHelper, arguments_, deadline) => {
      invokeCount += 1;
      assert.ok(deadline > Date.now());
      assert.deepEqual(await fs.readFile(capturedHelper), helperBytes);
      assert.notEqual(capturedHelper, helperPath);
      const value = key => arguments_[arguments_.indexOf(key) + 1];
      assert.deepEqual(await fs.readFile(value("--pdf")), source);
      const directory = value(invokeCount === 1 ? "--output-dir" : "--verify-proposal-dir");
      job = path.dirname(directory);
      if (invokeCount === 1) {
        await fs.mkdir(directory, { mode: 0o700 });
        const image = Buffer.alloc(pngBytes);
        Buffer.from("89504e470d0a1a0a", "hex").copy(image);
        const proposal = { schema: "pdf-tools.local-ocr-proposal.v1", status: "unverified_ocr_proposal",
          source_pdf_sha256: digest(source), page_number: 1,
          render_png_sha256: digest(image), proposal_sha256: "a".repeat(64),
          proposals: Array.from({ length: observations }, (_, index) => ({ observation_index: index,
            text_proposal: "UNVERIFIED word", engine_confidence_unverified: 0.9,
            box_top_left_pixels: [1, 2, 3, 4] })) };
        const proposalBytes = canonical(proposal);
        await fs.writeFile(path.join(directory, "render.png"), image, { mode: 0o600 });
        await fs.writeFile(path.join(directory, "proposal.json"), proposalBytes, { mode: 0o600 });
        await fs.writeFile(path.join(directory, "commit.json"), canonical({
          schema: "pdf-tools.local-ocr-commit.v1", proposal_sha256: proposal.proposal_sha256,
          proposal_file_sha256: digest(proposalBytes), render_png_sha256: digest(image),
        }), { mode: 0o600 });
        return { status: "unverified_ocr_proposal", source_pdf_sha256: digest(source),
          proposal_sha256: proposal.proposal_sha256 };
      }
      const review = Buffer.from("<!doctype html><p>synthetic wrapper fixture, NOT OCR</p>");
      await fs.writeFile(value("--review-html"), review, { mode: 0o600 });
      const proposal = JSON.parse(await fs.readFile(path.join(directory, "proposal.json"), "utf8"));
      await change({ root, job, directory, helperPath });
      return { status: "source_render_replayed_ocr_unverified", source_pdf_sha256: digest(source),
        proposal_sha256: proposal.proposal_sha256, render_png_sha256: proposal.render_png_sha256,
        page_number: 1, observation_count: observations, review_html_sha256: digest(review) };
    },
  };
  return { root, options, handler: createLocalOcrToolHandler(options),
    counts: () => ({ readCount, invokeCount }), job: () => job };
}

test("optional definition requires explicit source pin and opt-in; no executable arguments", () => {
  assert.deepEqual(LOCAL_OCR_TOOL_DEFINITION.inputSchema.required,
    ["pdf_path", "page", "expected_source_sha256", "confirm_local_ocr"]);
  assert.equal(LOCAL_OCR_TOOL_DEFINITION.inputSchema.additionalProperties, false);
  assert.equal(LOCAL_OCR_TOOL_DEFINITION.annotations.openWorldHint, false);
});

test("adapter pin matches exact reviewed Python helper", async () => {
  const helper = await fs.readFile(new URL("../scripts/local-ocr-proposal.py", import.meta.url));
  assert.equal(digest(helper), LOCAL_OCR_HELPER_SHA256);
});

test("valid fixture snapshots source/helper, replays, returns image and explicit unverified words", async t => {
  const f = await fixture(t);
  const result = await f.handler(args);
  assert.equal(result.structuredContent.status, "source_render_replayed_ocr_unverified");
  assert.equal(result.structuredContent.observation_count, 2);
  assert.equal(result.content[1].type, "image");
  assert.match(result.content[0].text, /UNVERIFIED/);
  assert.deepEqual(f.counts(), { readCount: 2, invokeCount: 2 });
  assert.equal((await fs.stat(path.join(f.job(), "source.pdf"))).mode & 0o777, 0o600);
  assert.equal((await fs.stat(f.job())).mode & 0o777, 0o700);
  validateLocalOcrResult(result.structuredContent);
});

test("empty result is explicit, not invented", async t => {
  const result = await (await fixture(t, { observations: 0 })).handler(args);
  assert.equal(result.structuredContent.observation_count, 0);
  assert.deepEqual(result.structuredContent.proposals, []);
});

test("return ceiling retains full inventory and counts omitted observations", async t => {
  const f = await fixture(t, { observations: 205 });
  const result = await f.handler(args);
  assert.equal(result.structuredContent.returned_observation_count, 200);
  assert.equal(result.structuredContent.omitted_observation_count, 5);
  assert.equal(JSON.parse(await fs.readFile(path.join(f.job(), "proposal/proposal.json"))).proposals.length, 205);
});

test("oversize inline image is omitted explicitly but retained for offline review", async t => {
  const result = await (await fixture(t, { pngBytes: 4 * 1024 * 1024 + 1 })).handler(args);
  assert.equal(result.structuredContent.inline_image_returned, false);
  assert.equal(result.content.length, 1);
});

for (const [label, changed] of [
  ["missing confirmation", { confirm_local_ocr: undefined }],
  ["false confirmation", { confirm_local_ocr: false }],
  ["fractional page", { page: 1.1 }], ["missing source pin", { expected_source_sha256: undefined }],
  ["unknown executable argument", { python_path: "/malicious" }],
]) test(`rejects ${label} before source or output`, async t => {
  const f = await fixture(t);
  await assert.rejects(f.handler({ ...args, ...changed }));
  assert.deepEqual(f.counts(), { readCount: 0, invokeCount: 0 });
  await assert.rejects(fs.stat(f.options.stateRoot), { code: "ENOENT" });
});

test("default-disabled and unsupported platform do not inspect adapters", async () => {
  await assert.rejects(createLocalOcrToolHandler({ configuration: null })(args), /not configured/);
  await assert.rejects(createLocalOcrToolHandler({ configuration: {}, platform: "win32" })(args), /macOS/);
});

test("changed helper and stale source both reject before output creation", async t => {
  const f = await fixture(t);
  await fs.writeFile(f.options.configuration.helperPath, "changed");
  await assert.rejects(f.handler(args), /reviewed version/);
  await fs.writeFile(f.options.configuration.helperPath, helperBytes);
  await assert.rejects(f.handler({ ...args, expected_source_sha256: "f".repeat(64) }), /source bytes/);
  await assert.rejects(fs.stat(f.options.stateRoot), { code: "ENOENT" });
});

test("allowlist rejection reaches neither adapter nor output", async t => {
  const f = await fixture(t);
  f.options.resolvePdfPath = () => { throw new Error("outside allowed folder"); };
  await assert.rejects(createLocalOcrToolHandler(f.options)(args), /outside allowed folder/);
  assert.equal(f.counts().invokeCount, 0);
});

for (const [label, change] of [
  ["missing commit", async ({ directory }) => fs.unlink(path.join(directory, "commit.json"))],
  ["extra artifact", async ({ directory }) => fs.writeFile(path.join(directory, "extra"), "x")],
  ["mode drift", async ({ directory }) => fs.chmod(path.join(directory, "proposal.json"), 0o644)],
  ["byte drift", async ({ directory }) => fs.appendFile(path.join(directory, "proposal.json"), " ")],
  ["symlink substitution", async ({ directory, root }) => {
    const file = path.join(directory, "render.png");
    const alternate = path.join(root, "alternate.png");
    await fs.rename(file, alternate); await fs.symlink(alternate, file);
  }],
  ["review substitution", async ({ job }) => fs.writeFile(path.join(job, "review.html"), "different")],
]) test(`rejects retained ${label}`, async t => {
  const f = await fixture(t, { change });
  await assert.rejects(f.handler(args));
});

test("original mutation during OCR suppresses returned proposal", async t => {
  const f = await fixture(t);
  let reads = 0;
  f.options.readPdfBytes = async () => ++reads === 1 ? source : Buffer.from("%PDF-changed");
  await assert.rejects(createLocalOcrToolHandler(f.options)(args), /original PDF changed/);
});

test("one active request serializes adapter use and releases after failure", async t => {
  const f = await fixture(t);
  let enter;
  const entered = new Promise(done => { enter = done; });
  let release;
  const pending = new Promise(done => { release = done; });
  f.options.readPdfBytes = async () => { enter(); await pending; throw new Error("fixture failure"); };
  const handler = createLocalOcrToolHandler(f.options);
  const first = handler(args);
  await entered;
  await assert.rejects(handler(args), /request is active/);
  release(); await assert.rejects(first, /fixture failure/);
  await assert.rejects(handler(args), /fixture failure/);
});

let python;
try { python = execFileSync("/usr/bin/which", ["python3"], { encoding: "utf8" }).trim(); } catch {}

test("real subprocess has no host secrets and ignores Python environment hooks", { skip: !python }, async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "pdf-tools-ocr-process-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const helper = path.join(root, "adapter.py");
  await fs.writeFile(helper, 'import json, os, sys\nprint(json.dumps({"secret":os.environ.get("PDF_TOOLS_SYNTHETIC_SECRET"),"isolated":sys.flags.isolated,"bytecode":sys.dont_write_bytecode}))\n');
  process.env.PDF_TOOLS_SYNTHETIC_SECRET = "synthetic-do-not-forward";
  t.after(() => { delete process.env.PDF_TOOLS_SYNTHETIC_SECRET; });
  const result = await runLocalOcrAdapter(python, helper, [], Date.now() + 10_000);
  assert.deepEqual(result, { secret: null, isolated: 1, bytecode: true });
});

test("real subprocess timeout and duplicate JSON fail closed", { skip: !python }, async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "pdf-tools-ocr-process-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const helper = path.join(root, "adapter.py");
  await fs.writeFile(helper, "import time\ntime.sleep(60)\n");
  await assert.rejects(runLocalOcrAdapter(python, helper, [], Date.now() + 150), /time limit/);
  await fs.writeFile(helper, 'print(\'{"status":1,"status":2}\')\n');
  await assert.rejects(runLocalOcrAdapter(python, helper, [], Date.now() + 10_000), /duplicate/);
  await assert.rejects(runLocalOcrAdapter("/nonexistent-python", helper, [], Date.now() + 10_000), /could not start/);
});

test("ordinary adapter completion terminates redirected same-group descendants", { skip: !python }, async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "pdf-tools-ocr-process-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const helper = path.join(root, "adapter.py");
  const sentinel = path.join(root, "descendant-survived");
  await fs.writeFile(helper, [
    "import json, subprocess, sys",
    "code = 'import pathlib,sys,time; time.sleep(0.4); pathlib.Path(sys.argv[1]).write_text(\"survived\")'",
    "subprocess.Popen([sys.executable, '-I', '-c', code, sys.argv[1]], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)",
    "print(json.dumps({'ok': True}))",
  ].join("\n"));
  assert.deepEqual(await runLocalOcrAdapter(python, helper, [sentinel], Date.now() + 10_000), { ok: true });
  await new Promise(done => setTimeout(done, 600));
  await assert.rejects(fs.stat(sentinel), { code: "ENOENT" });
});
