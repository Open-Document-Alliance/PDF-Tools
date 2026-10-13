#!/usr/bin/env node
// Informational local timing demonstration; not an extraction-quality benchmark.
import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { performance } from "node:perf_hooks";
import { PDFDocument, StandardFonts } from "pdf-lib";
import { extractPdfLayoutForMarkdown } from "../server/layout-extraction.js";
import { createVerifiedExtractionToolHandler } from "../server/verified-extraction-tools.js";

const sha256 = bytes => createHash("sha256").update(bytes).digest("hex");
const pdfjsLib = await import("pdfjs-dist/legacy/build/pdf.mjs");
const parent = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "pdf-tools-cache-timing-")));
await fs.chmod(parent, 0o700);

async function generatePdf(pageCount) {
  const pdf = await PDFDocument.create();
  const fixedDate = new Date("2026-01-01T00:00:00Z");
  pdf.setCreationDate(fixedDate);
  pdf.setModificationDate(fixedDate);
  const font = await pdf.embedFont(StandardFonts.Helvetica);
  for (let page = 1; page <= pageCount; page += 1) {
    const sheet = pdf.addPage([612, 792]);
    sheet.drawText(`Invoice INV-1001 - page ${page} of ${pageCount}`, { x: 40, y: 740, font, size: 12 });
    for (let row = 0; row < 8; row += 1) {
      sheet.drawText(`Line ${row + 1}: bounded local extraction timing example.`,
        { x: 40, y: 710 - row * 20, font, size: 10 });
    }
  }
  return Buffer.from(await pdf.save());
}

async function run(pageCount, bytes, enabled) {
  const sourcePath = path.join(parent, `source-${pageCount}-${enabled ? "cache" : "baseline"}.pdf`);
  await fs.writeFile(sourcePath, bytes);
  let layoutLoads = 0;
  let pageExtractions = 0;
  let sourceReads = 0;
  const handle = createVerifiedExtractionToolHandler({
    workspaceRoot: path.join(parent, `workspaces-${pageCount}-${enabled}`),
    resolvePdfPath: filename => path.resolve(filename),
    readPdfBytes: async filename => { sourceReads += 1; return fs.readFile(filename); },
    layoutCacheOptions: enabled ? {} : { maxRetainedBytes: 1 },
    extractLayouts: async ({ resolvedPath, sourceBytes, maxPages }) => {
      layoutLoads += 1;
      const layouts = [];
      for (let page = 1; page <= pageCount; page += 1) {
        pageExtractions += 1;
        const layout = await extractPdfLayoutForMarkdown({ pdfjsLib,
          pdfBytes: sourceBytes, sourcePath: resolvedPath, sourceFileName: path.basename(resolvedPath),
          sourceSha256: sha256(sourceBytes), requestedStartPage: page, requestedEndPage: page,
          maxItems: 5000, maxCharacters: 100000, maxOutputCharacters: 200000, deadlineMs: 20000 });
        if (layout.page_range.total_pages > maxPages) throw new Error("page bound exceeded");
        layouts.push(layout);
      }
      return layouts;
    },
  });
  const timings = {};
  const timed = async (label, operation) => {
    const start = performance.now();
    const result = await operation();
    timings[label] = Number((performance.now() - start).toFixed(2));
    return result;
  };
  const created = await timed("create_ms", () => handle("create_extraction_workspace", {
    pdf_path: sourcePath, workspace_id: "timing",
    schema: { type: "object", properties: { first: { type: "string" }, second: { type: "string" } } },
  }));
  const bound = { workspace_id: "timing", workspace_identity_sha256: created.workspace_identity_sha256 };
  const descriptors = await handle("read_extraction_workspace", { ...bound, collection: "document_map_chunks", limit: 1 });
  const chunkId = descriptors.items[0].chunk_id;
  const readArgs = { ...bound, pdf_path: sourcePath, chunk_id: chunkId };
  const chunk = await timed("first_chunk_ms", () => handle("read_extraction_chunk", readArgs));
  await timed("repeat_chunk_ms", () => handle("read_extraction_chunk", readArgs));
  const quote = Buffer.from("INV-1001");
  const start = Buffer.from(chunk.content).indexOf(quote);
  if (start < 0) throw new Error("generated source quote missing");
  let generation = created.generation_sha256;
  const items = [];
  for (const leaf of ["first", "second"]) {
    const proposed = await handle("submit_extraction_proposal", { ...bound,
      parent_generation_sha256: generation, leaf_pointer: `/${leaf}`,
      proposed_value: "INV-1001", chunk_ids: [chunkId] });
    generation = proposed.generation_sha256;
    items.push({ proposal_event_id: proposed.event.event_id,
      citations: [{ chunk_id: chunkId, start_utf8_byte: start, end_utf8_byte: start + quote.length,
        quote_sha256: sha256(quote) }],
      method: { kind: "exact_projection", citation_index: 0, normalization: "identity" } });
  }
  const batch = await timed("verify_two_ms", () => handle("verify_extraction_batch", { ...bound,
    pdf_path: sourcePath, parent_generation_sha256: generation, items }));
  if (!batch.results.every(result => result.status === "verified_exact")) throw new Error("verification failed");
  const measured = { page_count: pageCount, cache_enabled: enabled, pdf_bytes: bytes.length,
    source_reads: sourceReads, layout_loads: layoutLoads, page_extractions: pageExtractions, ...timings };
  if (enabled) {
    await fs.writeFile(sourcePath, Buffer.concat([bytes, Buffer.from("\n")]));
    let rejected = false;
    try { await handle("read_extraction_chunk", readArgs); } catch (error) {
      if (!/source|hash|byte|different inputs/iu.test(error.message)) throw error;
      rejected = true;
    }
    if (!rejected || layoutLoads !== measured.layout_loads + 1) throw new Error("source drift was not reparsed and rejected");
    measured.same_path_source_drift = { rejected, additional_layout_loads: layoutLoads - measured.layout_loads,
      additional_source_reads: sourceReads - measured.source_reads };
  }
  return measured;
}

try {
  const results = [];
  for (const pageCount of [20, 100]) {
    const bytes = await generatePdf(pageCount);
    results.push(await run(pageCount, bytes, false));
    results.push(await run(pageCount, bytes, true));
  }
  process.stdout.write(`${JSON.stringify({ contract: "pdf-tools.verified-extraction-cache-timing.v1",
    runtime: { node: process.version, platform: process.platform, arch: process.arch },
    note: "Single local synthetic run; in-process PDF.js extractor with production per-page limits. Timings are informational, not a quality or cross-machine speed claim. Cache-disabled baseline uses a one-byte retention budget. Workspace I/O, source hashing, map/citation replay and defensive cloning remain measured; worker startup is not measured.",
    results }, null, 2)}\n`);
} finally {
  await fs.rm(parent, { recursive: true, force: true });
}
