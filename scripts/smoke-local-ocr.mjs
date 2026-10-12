#!/usr/bin/env node
// Optional real-engine qualification on a generated, non-private raster PDF.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createCanvas } from "@napi-rs/canvas";
import { PDFDocument } from "pdf-lib";
import { createLocalOcrToolHandler, LOCAL_OCR_HELPER_SHA256 } from "../server/local-ocr-tools.js";

const options = {};
for (let i = 2; i < process.argv.length; i += 2) {
  const key = process.argv[i];
  if (!["--python", "--tesseract", "--report"].includes(key) || options[key] || !process.argv[i + 1]) {
    throw new Error("Usage: smoke-local-ocr.mjs --python /absolute/python --tesseract /absolute/tesseract [--report /absolute/new.json]");
  }
  options[key] = process.argv[i + 1];
  assert.ok(path.isAbsolute(options[key]), "Use absolute paths.");
}
assert.ok(options["--python"] && options["--tesseract"], "Explicit Python and Tesseract paths are required.");
const root = await fs.mkdtemp(path.join(os.tmpdir(), "pdf-tools-ocr-smoke-"));
const sha = bytes => createHash("sha256").update(bytes).digest("hex");
try {
  const canvas = createCanvas(1200, 600);
  const context = canvas.getContext("2d");
  context.fillStyle = "white";
  context.fillRect(0, 0, 1200, 600);
  context.fillStyle = "black";
  context.font = "52px sans-serif";
  context.fillText("INVOICE 1001", 90, 130);
  context.fillText("Total: 1250.00", 90, 250);
  context.fillText("Local OCR qualification fixture", 90, 370);
  const pdf = await PDFDocument.create();
  pdf.setCreationDate(new Date("2026-01-01T00:00:00Z"));
  pdf.setModificationDate(new Date("2026-01-01T00:00:00Z"));
  const image = await pdf.embedPng(canvas.toBuffer("image/png"));
  pdf.addPage([600, 300]).drawImage(image, { x: 0, y: 0, width: 600, height: 300 });
  const bytes = Buffer.from(await pdf.save());
  const input = path.join(root, "synthetic-invoice.pdf");
  await fs.writeFile(input, bytes, { mode: 0o600, flag: "wx" });
  const handler = createLocalOcrToolHandler({
    configuration: {
      engine: "tesseract", pythonPath: options["--python"], tesseractPath: options["--tesseract"],
      helperPath: fileURLToPath(new URL("./local-ocr-proposal.py", import.meta.url)),
    },
    stateRoot: path.join(root, "state"),
    resolvePdfPath: candidate => { assert.equal(candidate, input); return candidate; },
    readPdfBytes: candidate => fs.readFile(candidate),
  });
  const started = performance.now();
  const result = await handler({ pdf_path: input, page: 1,
    expected_source_sha256: sha(bytes), confirm_local_ocr: true });
  const elapsed = performance.now() - started;
  const payload = result.structuredContent;
  const words = payload.proposals.map(item => item.text_proposal).join(" ");
  assert.match(words, /INVOICE\s+1001/u);
  assert.match(words, /1250\.00/u);
  assert.equal(payload.status, "source_render_replayed_ocr_unverified");
  assert.equal(sha(await fs.readFile(input)), sha(bytes));
  const proposal = JSON.parse(await fs.readFile(path.join(payload.proposal_directory, "proposal.json"), "utf8"));
  const report = {
    schema: "pdf-tools.local-ocr-smoke.v1", status: "passed", fixture: "generated-raster-invoice",
    platform: process.platform, architecture: process.arch, node: process.version,
    engine: proposal.engine, helper_sha256: LOCAL_OCR_HELPER_SHA256,
    source_sha256: sha(bytes), proposal_sha256: payload.proposal_sha256,
    render_png_sha256: payload.render_png_sha256, duration_ms: Math.round(elapsed),
    checks: { invoice_id_recognized: true, total_recognized: true, source_unchanged: true,
      source_render_replayed: true, words_remain_unverified: true },
    limitation: "One synthetic fixture; not general OCR accuracy or installed-host qualification.",
  };
  const serialized = `${JSON.stringify(report, null, 2)}\n`;
  if (options["--report"]) await fs.writeFile(options["--report"], serialized, { mode: 0o600, flag: "wx" });
  process.stdout.write(serialized);
} finally {
  await fs.rm(root, { recursive: true, force: true });
}
