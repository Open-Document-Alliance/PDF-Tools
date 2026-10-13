#!/usr/bin/env node
// Local-only qualification of persisted two-page OCR jobs; no engine installation.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createCanvas } from "@napi-rs/canvas";
import { PDFDocument } from "pdf-lib";
import { createLocalOcrToolHandler, LOCAL_OCR_HELPER_SHA256 } from "../server/local-ocr-tools.js";
import { createLocalOcrJobHandlers } from "../server/local-ocr-jobs.js";
import { validateStructuredToolResult } from "../server/output-schemas.js";

const options = {};
for (let i = 2; i < process.argv.length; i += 2) {
  const key = process.argv[i];
  if (!["--python", "--tesseract", "--report"].includes(key) || options[key] || !process.argv[i + 1]) {
    throw new Error("Usage: smoke-local-ocr-jobs.mjs --python /absolute/python --tesseract /absolute/tesseract [--report /absolute/new.json]");
  }
  options[key] = process.argv[i + 1];
  assert.ok(path.isAbsolute(options[key]), "Use absolute paths.");
}
assert.ok(options["--python"] && options["--tesseract"], "Explicit Python and Tesseract paths are required.");
const root = await fs.mkdtemp(path.join(os.tmpdir(), "pdf-tools-ocr-jobs-smoke-"));
const sha = bytes => createHash("sha256").update(bytes).digest("hex");
try {
  const pdf = await PDFDocument.create();
  pdf.setCreationDate(new Date("2026-01-01T00:00:00Z"));
  pdf.setModificationDate(new Date("2026-01-01T00:00:00Z"));
  for (let page = 1; page <= 2; page += 1) {
    const canvas = createCanvas(1200, 600);
    const context = canvas.getContext("2d");
    context.fillStyle = "white";
    context.fillRect(0, 0, 1200, 600);
    context.fillStyle = "black";
    context.font = "52px sans-serif";
    context.fillText(`INVOICE ${2000 + page}`, 90, 130);
    context.fillText("Total: 1250.00", 90, 250);
    context.fillText(`Local OCR job page ${page}`, 90, 370);
    const image = await pdf.embedPng(canvas.toBuffer("image/png"));
    pdf.addPage([600, 300]).drawImage(image, { x: 0, y: 0, width: 600, height: 300 });
  }
  const bytes = Buffer.from(await pdf.save());
  const input = path.join(root, "synthetic-invoices.pdf");
  await fs.writeFile(input, bytes, { mode: 0o600, flag: "wx" });
  const shared = {
    configuration: { engine: "tesseract", pythonPath: options["--python"], tesseractPath: options["--tesseract"],
      helperPath: fileURLToPath(new URL("./local-ocr-proposal.py", import.meta.url)) },
    resolvePdfPath: candidate => { assert.equal(candidate, input); return candidate; },
    readPdfBytes: candidate => fs.readFile(candidate),
  };
  const pageCalls = [];
  const makeHandlers = () => {
    const single = createLocalOcrToolHandler({ ...shared, stateRoot: path.join(root, "proposals") });
    return createLocalOcrJobHandlers({ ...shared, stateRoot: path.join(root, "jobs"),
      proposalStateRoot: path.join(root, "proposals"), runPage: async args => {
        pageCalls.push(args.page);
        return single(args);
      } });
  };
  const startedAt = performance.now();
  const firstHandlers = makeHandlers();
  const started = await firstHandlers.start_pdf_ocr_job({ pdf_path: input, pages: [1, 2],
    expected_source_sha256: sha(bytes), confirm_local_ocr: true });
  const args = { job_id: started.structuredContent.job_id,
    expected_job_identity_sha256: started.structuredContent.job_identity_sha256, confirm_local_ocr: true };
  const first = await firstHandlers.resume_pdf_ocr_job(args);
  assert.equal(first.structuredContent.completed_count, 1);
  const restarted = makeHandlers();
  const complete = await restarted.resume_pdf_ocr_job(args);
  assert.equal(complete.structuredContent.status, "ocr_job_complete");
  assert.equal(complete.structuredContent.completed_count, 2);
  assert.equal(validateStructuredToolResult("resume_pdf_ocr_job", complete), complete);
  const repeated = await restarted.resume_pdf_ocr_job(args);
  assert.equal(repeated.structuredContent.processed_this_call, 0);
  assert.deepEqual(pageCalls, [1, 2]);
  const pages = [];
  let engine;
  for (const page of complete.structuredContent.completed_pages) {
    const proposal = JSON.parse(await fs.readFile(path.join(page.proposal_directory, "proposal.json"), "utf8"));
    const words = proposal.proposals.map(item => item.text_proposal).join(" ");
    assert.match(words, new RegExp(`INVOICE\\s+${2000 + page.page_number}`, "u"));
    assert.match(words, /1250\.00/u);
    assert.equal(sha(await fs.readFile(page.review_html_path)), page.review_html_sha256);
    engine = proposal.engine;
    pages.push({ page_number: page.page_number, observation_count: page.observation_count,
      proposal_sha256: page.proposal_sha256, render_png_sha256: page.render_png_sha256 });
  }
  assert.equal(sha(await fs.readFile(input)), sha(bytes));
  const report = { schema: "pdf-tools.local-ocr-jobs-smoke.v1", status: "passed",
    fixture: "generated-two-page-raster-invoices", platform: process.platform, architecture: process.arch,
    node: process.version, engine, helper_sha256: LOCAL_OCR_HELPER_SHA256, source_sha256: sha(bytes), pages,
    duration_ms: Math.round(performance.now() - startedAt),
    checks: { resumed_across_handler_instances: true, completed_pages_not_rerun: true,
      invoice_ids_recognized: true, totals_recognized: true, review_hashes_match: true,
      source_unchanged: true, words_remain_unverified: true },
    limitation: "Two synthetic pages; not general OCR accuracy or installed-host qualification." };
  const serialized = `${JSON.stringify(report, null, 2)}\n`;
  if (options["--report"]) await fs.writeFile(options["--report"], serialized, { mode: 0o600, flag: "wx" });
  process.stdout.write(serialized);
} finally { await fs.rm(root, { recursive: true, force: true }); }
