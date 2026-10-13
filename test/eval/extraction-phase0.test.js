import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { AjvJsonSchemaValidator } from "@modelcontextprotocol/sdk/validation/ajv";
import { generateExtractionFixtures } from "../../scripts/eval-generate-extraction-fixtures.mjs";
import {
  classifyCaseError,
  runExtractionBaseline,
  verifyExtractionReport,
} from "../../scripts/eval-run-extraction-baseline.mjs";
import {
  canonicalJson,
  loadExtractionManifest,
  resolveExtractionFixture,
  sha256,
} from "./extraction-manifest.js";
import { scoreExtractionCase } from "./extraction-scorer.js";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const EXTRACTION_ROOT = path.join(REPO_ROOT, "test", "fixtures", "eval", "extraction");
const MANIFEST_PATH = path.join(EXTRACTION_ROOT, "manifest.v1.json");
const MANIFEST_SCHEMA_PATH = path.join(EXTRACTION_ROOT, "manifest.schema.json");
const REPORT_SCHEMA_PATH = path.join(EXTRACTION_ROOT, "report.schema.json");
const temporaryDirectories = [];

async function temporaryDirectory() {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "pdf-tools-extraction-test-"));
  temporaryDirectories.push(directory);
  return directory;
}

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map(directory => fs.rm(directory, { recursive: true, force: true })));
});

describe("structured extraction Phase 0", () => {
  it("preserves the v1 report contract and scores when current RSS measurements are unavailable", async () => {
    const [historical, schema, loaded] = await Promise.all([
      fs.readFile(path.join(REPO_ROOT, "docs", "evidence", "extraction-phase0-current-product.v1.json"), "utf8").then(JSON.parse),
      fs.readFile(REPORT_SCHEMA_PATH, "utf8").then(JSON.parse),
      loadExtractionManifest(MANIFEST_PATH, MANIFEST_SCHEMA_PATH),
    ]);
    const validate = new AjvJsonSchemaValidator().getValidator(schema);
    const verify = report => verifyExtractionReport(report, {
      manifest: loaded.manifest,
      manifestSha256: loaded.manifest_sha256,
      schemaSha256: loaded.schema_sha256,
    });
    expect(validate(historical).valid).toBe(true);
    expect(verify(historical)).toBe(true);
    const current = structuredClone(historical);
    for (const item of current.cases) {
      for (const call of item.calls) call.peak_rss_bytes = null;
      item.resources.peak_rss_bytes = null;
      item.bindings.raw_result_sha256 = sha256(Buffer.from(canonicalJson(item.calls)));
    }
    expect(validate(current).valid).toBe(true);
    expect(verify(current)).toBe(true);
    expect(current.report_schema_version).toBe(1);
    expect(current.denominator).toEqual(historical.denominator);
    expect(current.aggregate_metrics).toEqual(historical.aggregate_metrics);
    expect(current.cases.map(item => item.metrics)).toEqual(historical.cases.map(item => item.metrics));
  });

  it("validates eight exact licensed and private-safe fixture contracts", async () => {
    const { manifest } = await loadExtractionManifest(MANIFEST_PATH, MANIFEST_SCHEMA_PATH);
    expect(manifest.fixtures).toHaveLength(8);
    expect(new Set(manifest.fixtures.map(fixture => fixture.id)).size).toBe(8);
    expect(new Set(manifest.fixtures.map(fixture => fixture.category))).toEqual(new Set([
      "flat_schema",
      "nested_schema",
      "layout_order",
      "table",
      "ocr_clean",
      "ocr_degraded",
      "mixed_modality",
      "no_answer_contradiction",
    ]));
    for (const fixture of manifest.fixtures) {
      expect(fixture.license.redistribution).toBe("allowed");
      expect(fixture.privacy.contains_personal_data).toBe(false);
      expect(fixture.expected.page_geometry.every(page => page.media_box && page.crop_box)).toBe(true);
      expect(sha256(await fs.readFile(resolveExtractionFixture(MANIFEST_PATH, fixture)))).toBe(fixture.sha256);
    }
  });

  it("regenerates all eight synthetic PDFs byte for byte", async () => {
    const output = await temporaryDirectory();
    const { manifest } = await loadExtractionManifest(MANIFEST_PATH, MANIFEST_SCHEMA_PATH);
    expect(await generateExtractionFixtures(output)).toHaveLength(8);
    for (const fixture of manifest.fixtures) {
      const generated = await fs.readFile(path.join(output, path.basename(fixture.path)));
      expect(sha256(generated), fixture.id).toBe(fixture.sha256);
    }
  });

  it("rejects manifest license, privacy, hash, schema, and denominator mutations", async () => {
    const [manifest, schema] = await Promise.all([
      fs.readFile(MANIFEST_PATH, "utf8").then(JSON.parse),
      fs.readFile(MANIFEST_SCHEMA_PATH, "utf8").then(JSON.parse),
    ]);
    const validator = new AjvJsonSchemaValidator().getValidator(schema);
    const mutants = [
      value => { value.fixtures[0].license.redistribution = "unknown"; },
      value => { value.fixtures[0].privacy.contains_personal_data = true; },
      value => { value.fixtures[0].sha256 = "not-a-digest"; },
      value => { delete value.fixtures[0].target_schema; },
      value => { value.fixtures.pop(); },
    ];
    for (const mutate of mutants) {
      const mutant = structuredClone(manifest);
      mutate(mutant);
      expect(validator(mutant).valid).toBe(false);
    }
  });

  it("rejects a schema-shaped manifest whose fixture digest is forged", async () => {
    const root = await temporaryDirectory();
    await fs.cp(path.join(EXTRACTION_ROOT, "synthetic"), path.join(root, "synthetic"), { recursive: true });
    const manifest = JSON.parse(await fs.readFile(MANIFEST_PATH, "utf8"));
    manifest.fixtures[0].sha256 = "0".repeat(64);
    const manifestPath = path.join(root, "manifest.json");
    await fs.writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
    await expect(loadExtractionManifest(manifestPath, MANIFEST_SCHEMA_PATH)).rejects.toThrow(/hash mismatch/);
  });

  it("rejects semantic manifest mutations that can corrupt scoring truth", async () => {
    const root = await temporaryDirectory();
    await fs.cp(path.join(EXTRACTION_ROOT, "synthetic"), path.join(root, "synthetic"), { recursive: true });
    const manifest = JSON.parse(await fs.readFile(MANIFEST_PATH, "utf8"));
    const mutants = [
      value => { value.fixtures[0].expected.facts[1].id = value.fixtures[0].expected.facts[0].id; },
      value => { value.fixtures[0].expected.facts[0].field_path = "/missing/value"; },
      value => { value.fixtures[0].expected.facts[0].page = 99; },
      value => { value.fixtures[0].expected.facts[0].bbox.x = 600; },
      value => { value.fixtures[0].expected.facts[0].anchor_text = "NOT PRESENT"; },
      value => { value.fixtures[1].category = value.fixtures[0].category; },
      value => { for (const fixture of value.fixtures) fixture.partition = "development"; },
      value => { value.fixtures.find(fixture => fixture.category === "table").expected.table.cells[0].row = 99; },
      value => {
        const table = value.fixtures.find(fixture => fixture.category === "table").expected.table;
        table.cells.push(structuredClone(table.cells[0]));
      },
      value => { value.fixtures.find(fixture => fixture.category === "table").expected.table.merged_cells[0] = "not-a-range"; },
      value => {
        const table = value.fixtures.find(fixture => fixture.category === "table").expected.table;
        table.merged_cells.push(table.merged_cells[0]);
      },
      value => { value.fixtures.find(fixture => fixture.category === "table").expected.table.merged_cells[0] = "R1C1:R1C4"; },
      value => { value.fixtures[0].expected.answer_state = "contradictory_and_absent"; },
      value => { value.fixtures.find(fixture => fixture.category === "no_answer_contradiction").expected.answer_state = "answerable"; },
    ];
    for (const [index, mutate] of mutants.entries()) {
      const mutant = structuredClone(manifest);
      mutate(mutant);
      const manifestPath = path.join(root, `manifest-${index}.json`);
      await fs.writeFile(manifestPath, `${JSON.stringify(mutant, null, 2)}\n`);
      await expect(loadExtractionManifest(manifestPath, MANIFEST_SCHEMA_PATH)).rejects.toThrow();
    }
  });

  it("reports unconditional field precision, recall, F1, missing, and spurious counts", async () => {
    const { manifest } = await loadExtractionManifest(MANIFEST_PATH, MANIFEST_SCHEMA_PATH);
    const fixture = manifest.fixtures[0];
    const exact = scoreExtractionCase(fixture, {
      structured_candidate: fixture.ground_truth,
      page_texts: [{ page: 1, text: fixture.expected.pages[0].transcript }],
      page_result_sha256: "a".repeat(64),
      evidence: [],
    }, manifest.evaluation_policy);
    expect(exact.field_correctness).toMatchObject({
      true_positive: 5,
      missing: 0,
      spurious: 0,
      precision: 1,
      recall: 1,
      f1: 1,
    });

    const hostile = structuredClone(fixture.ground_truth);
    delete hostile.vendor;
    hostile.unplanned = "invented";
    const scored = scoreExtractionCase(fixture, { structured_candidate: hostile }, manifest.evaluation_policy);
    expect(scored.schema_validity.score).toBe(0);
    expect(scored.field_correctness.missing).toBe(1);
    expect(scored.field_correctness.spurious).toBe(1);
    expect(scored.field_correctness.f1).toBeLessThan(1);
  });

  it("penalizes spurious table cells with precision, recall, and F1", async () => {
    const { manifest } = await loadExtractionManifest(MANIFEST_PATH, MANIFEST_SCHEMA_PATH);
    const fixture = manifest.fixtures.find(item => item.category === "table");
    const tableCandidate = structuredClone(fixture.expected.table);
    tableCandidate.cells.push({ row: 99, column: 99, value: "invented" });
    const scored = scoreExtractionCase(fixture, { table_candidate: tableCandidate }, manifest.evaluation_policy);
    expect(scored.table_cells).toMatchObject({
      true_positive: fixture.expected.table.cells.length,
      missing: 0,
      spurious: 1,
      recall: 1,
    });
    expect(scored.table_cells.precision).toBeLessThan(1);
    expect(scored.table_cells.f1).toBeLessThan(1);
    expect(scored.table_cells.score).toBe(scored.table_cells.f1);
  });

  it("attributes unknown post-handoff failures to the product", () => {
    expect(classifyCaseError(new Error("server disconnected"), { handoffComplete: true })).toBe("product_failure");
    expect(classifyCaseError({ code: "PRODUCT_TIMEOUT" }, { handoffComplete: true })).toBe("product_timeout");
    expect(classifyCaseError({ code: "INVALID_PRODUCT_OUTPUT" }, { handoffComplete: true })).toBe("invalid_output");
    expect(classifyCaseError(new Error("controller setup"), { handoffComplete: false })).toBe("harness_failure");
  });

  it("requires evidence source and result digests and bounds any claimed box", async () => {
    const { manifest } = await loadExtractionManifest(MANIFEST_PATH, MANIFEST_SCHEMA_PATH);
    const fixture = manifest.fixtures[0];
    const fact = fixture.expected.facts[0];
    const resultDigest = "a".repeat(64);
    const base = {
      structured_candidate: fixture.ground_truth,
      page_result_sha256: resultDigest,
      evidence: [{
        id: "evidence.bound",
        kind: "page",
        source_sha256: fixture.sha256,
        result_sha256: resultDigest,
        page: fact.page,
        text: fact.anchor_text,
        bbox: fact.bbox,
        fact_ids: [fact.id],
      }],
    };
    const valid = scoreExtractionCase(fixture, base, manifest.evaluation_policy);
    expect(valid.evidence_page.numerator).toBe(1);
    expect(valid.evidence_fact.numerator).toBe(1);
    expect(valid.evidence_bbox.numerator).toBe(1);
    expect(valid.evidence_answer).toMatchObject({ availability: "unavailable", numerator: 0, score: 0 });

    const pageOnly = structuredClone(base);
    pageOnly.evidence[0].fact_ids = [];
    expect(scoreExtractionCase(fixture, pageOnly, manifest.evaluation_policy)).toMatchObject({
      evidence_page: { numerator: 1, availability: "measured" },
      evidence_fact: { numerator: 0, availability: "unavailable" },
      evidence_bbox: { numerator: 0, availability: "unavailable" },
    });

    const forged = structuredClone(base);
    forged.evidence[0].source_sha256 = "0".repeat(64);
    expect(scoreExtractionCase(fixture, forged, manifest.evaluation_policy).evidence_page.numerator).toBe(0);

    const wrongButInPage = structuredClone(base);
    wrongButInPage.evidence[0].bbox.x = 350;
    expect(scoreExtractionCase(fixture, wrongButInPage, manifest.evaluation_policy).evidence_bbox.numerator).toBe(0);

    const fullPage = structuredClone(base);
    const pageBox = fixture.expected.page_geometry[0].media_box;
    fullPage.evidence[0].bbox = { ...pageBox, coordinate_space: "top_left_pdf_points" };
    expect(scoreExtractionCase(fixture, fullPage, manifest.evaluation_policy).evidence_bbox.numerator).toBe(0);

    const outOfBounds = structuredClone(base);
    outOfBounds.evidence[0].bbox.x = 700;
    expect(scoreExtractionCase(fixture, outOfBounds, manifest.evaluation_policy).evidence_bbox.numerator).toBe(0);
  });

  describe("live baseline report", () => {
    let liveReport;

    // Both consumers inspect the same live eight-fixture run. Keeping setup in
    // this suite also runs it when either consumer is selected on its own.
    beforeAll(async () => {
      const directory = await fs.mkdtemp(path.join(os.tmpdir(), "pdf-tools-extraction-live-test-"));
      try {
        liveReport = await runExtractionBaseline({
          manifestPath: MANIFEST_PATH,
          manifestSchemaPath: MANIFEST_SCHEMA_PATH,
          reportSchemaPath: REPORT_SCHEMA_PATH,
          outputPath: path.join(directory, "report.json"),
        });
      } finally {
        await fs.rm(directory, { recursive: true, force: true });
      }
    }, 30_000);

    it("retains the full attempted denominator and counts unavailable required extraction as product failure", async () => {
      const report = structuredClone(liveReport);
      expect(report.benchmark_claim_ready).toBe(false);
      expect(report.calibration_claim_ready).toBe(false);
      expect(report.denominator).toMatchObject({
        planned: 8,
        attempted: 8,
        completed: 0,
        product_failures: 8,
        product_timeouts: 0,
        invalid_outputs: 0,
        harness_failures: 0,
      });
      expect(report.cases).toHaveLength(8);
      expect(report.cases.every(item => item.outcome === "product_failure")).toBe(true);
      expect(report.aggregate_metrics.ocr).toMatchObject({
        applicable_cases: 3,
        measured_cases: 0,
        unavailable_cases: 3,
        scored_cases: 3,
        mean_score_over_applicable: 0,
      });
      expect(report.aggregate_metrics.raster_render).toMatchObject({
        applicable_cases: 3,
        measured_cases: 3,
        mean_score_over_applicable: 1,
      });
      expect(report.aggregate_metrics.table_topology.unavailable_cases).toBe(1);
      expect(report.aggregate_metrics.field_correctness.unavailable_cases).toBe(8);
      expect(report.aggregate_metrics.evidence_fact).toMatchObject({
        applicable_cases: 8,
        measured_cases: 0,
        unavailable_cases: 8,
        mean_score_over_applicable: 0,
      });
    }, 30_000);

    it("rejects case, binding, denominator, readiness, and aggregate report tampering", async () => {
      const report = structuredClone(liveReport);
      const loaded = await loadExtractionManifest(MANIFEST_PATH, MANIFEST_SCHEMA_PATH);
      const verify = mutant => verifyExtractionReport(mutant, {
        manifest: loaded.manifest,
        manifestSha256: loaded.manifest_sha256,
        schemaSha256: loaded.schema_sha256,
      });
      expect(verify(report)).toBe(true);
      const mutants = [
        value => { value.cases.pop(); },
        value => { [value.cases[0], value.cases[1]] = [value.cases[1], value.cases[0]]; },
        value => { value.cases[0].source.sha256 = "0".repeat(64); },
        value => { value.cases[0].calls[0].result_sha256 = "0".repeat(64); },
        value => { value.cases[0].bindings.page_result_sha256 = "0".repeat(64); },
        value => { value.cases[0].category = "table"; },
        value => { value.cases[0].partition = "held_out_calibration"; },
        value => { value.cases[0].source.independent_geometry[0].media_box.width = 611; },
        value => { value.cases[0].source.observed_geometry[0].width = 611; },
        value => { value.cases[0].bindings.evidence_ids.pop(); },
        value => { value.benchmark_claim_ready = true; },
        value => { value.denominator.attempted = 7; },
        value => { value.aggregate_metrics.ocr.measured_cases = 1; },
        value => { value.aggregate_metrics.evidence_page.mean_score_over_applicable = 1; },
        value => {
          value.cases[4].metrics.evidence_page.numerator = 1;
          value.cases[4].metrics.evidence_page.score = 1;
          value.aggregate_metrics.evidence_page.mean_score_over_applicable += 0.125;
        },
      ];
      for (const mutate of mutants) {
        const mutant = structuredClone(report);
        mutate(mutant);
        expect(() => verify(mutant)).toThrow();
      }
    }, 30_000);
  });
});
