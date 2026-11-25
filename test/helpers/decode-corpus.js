// Run a decode corpus against one runtime and compare each case with its
// expected outcome. Shared by the local server's and the hosted service's
// tests, so one corpus and one manifest serve both.
//
// Manifest (JSON): { "schema": 1, "cases": [ {
//   "id": "...",
//   "file": "relative/to/manifest.pdf"  or  "builder": "relative/builder.mjs",
//   "entry": "get_pdf_info" | "render_pdf_page" | ...,
//   "expected": { "<runtime>": { "outcome": "ok" | "gap" | "refused", "code": "..." | null, "maxPeakMiB": 600 } }
// } ] }
//
// A builder module exports `build()`, returning the PDF bytes. A case with no
// expectation for this runtime is skipped. run(bytes, caseDef) performs the
// entry and resolves to { outcome, code, peakRssBytes }.

import fs from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";

const MIB = 1024 * 1024;

export async function loadDecodeCorpus(manifestPath) {
  const manifest = JSON.parse(await fs.readFile(manifestPath, "utf8"));
  if (manifest.schema !== 1 || !Array.isArray(manifest.cases)) {
    throw new Error("Unsupported decode corpus manifest.");
  }
  return manifest;
}

async function caseBytes(manifestPath, caseDef) {
  const base = path.dirname(manifestPath);
  if (typeof caseDef.file === "string") return await fs.readFile(path.resolve(base, caseDef.file));
  if (typeof caseDef.builder === "string") {
    const builder = await import(pathToFileURL(path.resolve(base, caseDef.builder)).href);
    return Buffer.from(await builder.build(caseDef));
  }
  throw new Error(`Decode corpus case ${caseDef.id} names neither a file nor a builder.`);
}

/**
 * Returns one entry per case that has an expectation for this runtime:
 * { id, entry, expected, actual, mismatches }, where mismatches lists what
 * differed (empty when the case passed).
 */
export async function runDecodeCorpus({ manifestPath, runtime, run, entries = null }) {
  const manifest = await loadDecodeCorpus(manifestPath);
  const results = [];
  for (const caseDef of manifest.cases) {
    const expected = caseDef.expected?.[runtime];
    if (!expected || (entries && !entries.includes(caseDef.entry))) continue;
    const actual = await run(await caseBytes(manifestPath, caseDef), caseDef);
    const mismatches = [];
    if (actual.outcome !== expected.outcome) mismatches.push(`outcome ${actual.outcome}, expected ${expected.outcome}`);
    if ((expected.code ?? null) !== (actual.code ?? null)) mismatches.push(`code ${actual.code}, expected ${expected.code}`);
    if (Number.isFinite(expected.maxPeakMiB) && Number.isFinite(actual.peakRssBytes)
        && actual.peakRssBytes > expected.maxPeakMiB * MIB) {
      mismatches.push(`peak ${(actual.peakRssBytes / MIB).toFixed(0)} MiB over ${expected.maxPeakMiB} MiB`);
    }
    results.push({ id: caseDef.id, entry: caseDef.entry, expected, actual, mismatches });
  }
  return results;
}
