import { createHash } from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { loadComparisonManifest, resolveComparisonDocumentPath } from "./comparison-manifest.js";
import { buildProductPrimitiveReport } from "./comparison-product-baseline.js";
import { buildControllerObservationRegistry, registerControllerObservationRecords } from "./comparison-observation-registry.js";
import { scoreComparisonReport, validateComparisonReport } from "./comparison-scorer.js";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const MANIFEST_PATH = path.join(REPO_ROOT, "test", "fixtures", "eval", "comparison", "manifest.v1.json");

const manifest = await loadComparisonManifest(MANIFEST_PATH);
const documents = new Map(manifest.documents.map(document => [document.id, document]));
const pairs = manifest.pairs.map(pair => ({
  pairId: pair.id,
  beforePath: resolveComparisonDocumentPath(MANIFEST_PATH, documents.get(pair.before_document_id)),
  afterPath: resolveComparisonDocumentPath(MANIFEST_PATH, documents.get(pair.after_document_id)),
  beforeSha256: documents.get(pair.before_document_id).sha256,
  afterSha256: documents.get(pair.after_document_id).sha256,
}));

describe("current PDF Tools compare_pdfs baseline", () => {
  const pairReports = new Map();
  // All 42 original calls remain: one warmup and five measured repetitions per
  // pair. Give each pair its own bounded case and process so a corpus-wide
  // throughput deadline cannot abandon work and race the next test's cleanup.
  it.each(pairs)("records six deterministic comparisons for $pairId", async pair => {
    const report = await buildProductPrimitiveReport({
      benchmarkId: manifest.benchmark_id,
      benchmarkVersion: manifest.benchmark_version,
      renderer: manifest.canonical_renderer,
      repositoryRoot: REPO_ROOT,
      host: "local-test-host-stdio",
      pairs: [pair],
    });
    const pairManifest = { ...manifest, pairs: manifest.pairs.filter(item => item.id === pair.pairId) };
    expect(validateComparisonReport(pairManifest, report)).toEqual([]);
    expect(report.pairs).toHaveLength(1);
    expect(report.pairs[0].tool_calls).toBe(6);
    expect(report.pairs[0].iteration_costs).toHaveLength(5);
    pairReports.set(pair.pairId, report);
  }, 120_000);

  it("records the seven-channel product contract without promoting calibration to a benchmark claim", () => {
    expect([...pairReports.keys()].sort()).toEqual(pairs.map(pair => pair.pairId).sort());
    const reports = pairs.map(pair => pairReports.get(pair.pairId));
    const report = structuredClone(reports[0]);
    report.pairs = reports.flatMap(item => item.pairs);
    // Recombine the independently retained controller evidence, never invent
    // evidence from scorer truth. Account for the seven actual server runs.
    report.engine.external_processes = reports.reduce((sum, item) => sum + item.engine.external_processes, 0);
    report.isolation.allowed_directory_evidence_sha256 = createHash("sha256")
      .update(pairs.flatMap(pair => [pair.beforeSha256, pair.afterSha256]).sort().join("|"))
      .digest("hex");
    registerControllerObservationRecords(report, reports.flatMap(item =>
      buildControllerObservationRegistry(item).pairs.flatMap(pair => pair.retained_raw_results)));
    expect(validateComparisonReport(manifest, report)).toEqual([]);
    const scored = scoreComparisonReport(manifest, report, buildControllerObservationRegistry(report));
    expect(scored.valid).toBe(true);
    expect(scored.passed).toBe(false);
    expect(scored.aggregate.pairs_total).toBe(7);
    for (const channel of ["semantic", "text", "structure", "form_field", "annotation", "metadata"]) {
      expect(scored.aggregate.channel_metrics[channel].f1, channel).toBe(1);
    }
    // The seven authored PDFs contain mixed text/vector pages. compare_pdfs
    // now truthfully marks the semantic and text channels partial; the frozen
    // v1 evaluation schema projects that state to `unavailable` while keeping
    // the channels that were fully observed supported.
    expect(report.pairs.every(pair => pair.channel_status.semantic === "unavailable"
      && pair.channel_status.text === "unavailable")).toBe(true);
    for (const channel of ["structure", "form_field", "annotation", "metadata", "visual"]) {
      expect(report.pairs.every(pair => pair.channel_status[channel] === "supported"), channel).toBe(true);
    }
    expect(report.pairs.every(pair => pair.tool_calls === 6)).toBe(true);
    expect(report.pairs.every(pair => pair.iteration_costs.length === 5)).toBe(true);
    expect(report.pairs.every(pair => pair.peak_rss_bytes === null
      && pair.resource_measurement_status === "unavailable")).toBe(true);
    expect(report.engine.provenance).toContain("compare_pdfs output gated");
    expect(report.engine.network_requests).toBe(0);
    expect(report.benchmark_claim_ready).toBe(false);
    expect(report.platform.host).toBe("local-test-host-stdio");
  });
});
