#!/usr/bin/env node

import { execFileSync } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { AjvJsonSchemaValidator } from "@modelcontextprotocol/sdk/validation/ajv";
import { PDFDocument } from "pdf-lib";
import {
  canonicalJson,
  loadExtractionManifest,
  resolveExtractionFixture,
  sha256,
} from "../test/eval/extraction-manifest.js";
import { scoreExtractionCase } from "../test/eval/extraction-scorer.js";
import { captureChildCurrentRssReader, maximumRssOrUnavailable } from "./child-process-rss.mjs";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const DEFAULT_MANIFEST = path.join(REPO_ROOT, "test", "fixtures", "eval", "extraction", "manifest.v1.json");
const DEFAULT_MANIFEST_SCHEMA = path.join(REPO_ROOT, "test", "fixtures", "eval", "extraction", "manifest.schema.json");
const DEFAULT_REPORT_SCHEMA = path.join(REPO_ROOT, "test", "fixtures", "eval", "extraction", "report.schema.json");
const DEFAULT_OUTPUT = path.join(REPO_ROOT, "docs", "evidence", "extraction-phase0-current-product.v1.json");
const TOOL_TIMEOUT_MS = 20_000;
const SHA256 = /^[a-f0-9]{64}$/;

function option(name, fallback) {
  const index = process.argv.indexOf(name);
  if (index < 0) return fallback;
  if (!process.argv[index + 1]) throw new Error(`${name} requires a value`);
  return process.argv[index + 1];
}

function clockMs() {
  return Number(process.hrtime.bigint()) / 1_000_000;
}

async function withTimeout(operation, timeoutMs) {
  let timer;
  try {
    return await Promise.race([
      operation,
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(Object.assign(new Error(`Tool call timed out after ${timeoutMs}ms`), { code: "PRODUCT_TIMEOUT" })), timeoutMs);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

async function measuredCall(client, readRssBytes, request) {
  const started = clockMs();
  let peakRss = maximumRssOrUnavailable([readRssBytes()]);
  const sample = () => { peakRss = maximumRssOrUnavailable([peakRss, readRssBytes()]); };
  const sampler = setInterval(sample, 5);
  try {
    const result = await withTimeout(client.callTool(request), TOOL_TIMEOUT_MS);
    sample();
    const raw = canonicalJson(result);
    return {
      ok: result.isError !== true,
      is_error: result.isError === true,
      result,
      result_sha256: sha256(Buffer.from(raw)),
      structured_sha256: result.structuredContent === undefined
        ? null
        : sha256(Buffer.from(canonicalJson(result.structuredContent))),
      latency_ms: Number((clockMs() - started).toFixed(3)),
      peak_rss_bytes: peakRss,
    };
  } finally {
    clearInterval(sampler);
  }
}

function retainedCall(name, measured, extra = {}) {
  return {
    name,
    ok: measured.ok,
    is_error: measured.is_error,
    result_sha256: measured.result_sha256,
    structured_sha256: measured.structured_sha256,
    latency_ms: measured.latency_ms,
    peak_rss_bytes: measured.peak_rss_bytes,
    ...extra,
  };
}

function aggregateMetrics(cases) {
  const names = new Set(cases.flatMap(item => Object.keys(item.metrics ?? {})));
  const aggregate = {};
  for (const name of [...names].sort()) {
    const applicable = cases.map(item => item.metrics?.[name]).filter(metric => metric?.applicable);
    const measured = applicable.filter(metric => metric.availability === "measured");
    const scored = applicable.filter(metric => typeof metric.score === "number");
    aggregate[name] = {
      applicable_cases: applicable.length,
      measured_cases: measured.length,
      unavailable_cases: applicable.filter(metric => metric.availability === "unavailable").length,
      scored_cases: scored.length,
      mean_score_over_applicable: applicable.length
        ? applicable.reduce((sum, metric) => sum + (typeof metric.score === "number" ? metric.score : 0), 0) / applicable.length
        : null,
    };
  }
  return aggregate;
}

function assertEqual(actual, expected, message) {
  if (canonicalJson(actual) !== canonicalJson(expected)) throw new Error(message);
}

export function verifyExtractionReport(report, {
  manifest,
  manifestSha256,
  schemaSha256,
}) {
  if (report.benchmark_claim_ready !== false || report.calibration_claim_ready !== false) {
    throw new Error("Extraction report readiness flags must remain false");
  }
  if (report.suite_id !== manifest.suite_id || report.suite_version !== manifest.suite_version) {
    throw new Error("Extraction report suite identity does not match its manifest");
  }
  if (report.manifest_sha256 !== manifestSha256 || report.schema_sha256 !== schemaSha256) {
    throw new Error("Extraction report manifest or schema binding is invalid");
  }

  const expectedIds = manifest.fixtures.map(fixture => fixture.id);
  const observedIds = report.cases?.map(item => item.id) ?? [];
  assertEqual(observedIds, expectedIds, "Extraction report case IDs are missing, duplicated, or reordered");
  assertEqual(report.denominator.planned_case_ids, expectedIds, "Extraction report planned case IDs do not match the manifest");
  assertEqual(report.denominator.observed_case_ids, expectedIds, "Extraction report observed case IDs do not match the retained cases");

  const counts = Object.fromEntries([
    ["completed", "completed"],
    ["product_failures", "product_failure"],
    ["product_timeouts", "product_timeout"],
    ["invalid_outputs", "invalid_output"],
    ["harness_failures", "harness_failure"],
  ].map(([field, outcome]) => [field, report.cases.filter(item => item.outcome === outcome).length]));
  const retained = Object.values(counts).reduce((sum, count) => sum + count, 0);
  if (report.denominator.planned !== expectedIds.length
    || report.denominator.attempted !== expectedIds.length
    || retained !== expectedIds.length) {
    throw new Error("Extraction report denominator does not retain every planned case exactly once");
  }
  for (const [field, count] of Object.entries(counts)) {
    if (report.denominator[field] !== count) throw new Error(`Extraction report denominator field is inconsistent: ${field}`);
  }

  for (let index = 0; index < manifest.fixtures.length; index += 1) {
    const fixture = manifest.fixtures[index];
    const retainedCase = report.cases[index];
    if (retainedCase.category !== fixture.category || retainedCase.partition !== fixture.partition) {
      throw new Error(`Extraction report category or partition binding is invalid for ${fixture.id}`);
    }
    if (retainedCase.source?.path !== fixture.path
      || retainedCase.source?.sha256 !== fixture.sha256
      || retainedCase.source?.immutable !== true) {
      throw new Error(`Extraction report source binding is invalid for ${fixture.id}`);
    }
    if (!Array.isArray(retainedCase.calls) || !retainedCase.bindings || !retainedCase.metrics || !retainedCase.scoring_input) {
      throw new Error(`Extraction report is missing retained calls, bindings, scoring input, or metrics for ${fixture.id}`);
    }
    const expectedIndependentGeometry = fixture.expected.page_geometry.map(page => ({
      page: page.page,
      media_box: page.media_box,
      crop_box: page.crop_box,
      rotation: page.rotation,
    }));
    assertEqual(retainedCase.source.independent_geometry, expectedIndependentGeometry, `Extraction report independent geometry is invalid for ${fixture.id}`);
    assertEqual(retainedCase.source.observed_geometry, retainedCase.scoring_input.observed_geometry, `Extraction report observed geometry is not bound to retained input for ${fixture.id}`);
    if (retainedCase.source.observed_geometry.length > 0) {
      const expectedObservedGeometry = fixture.expected.page_geometry.map(page => ({
        page: page.page,
        width: page.width,
        height: page.height,
        rotation: page.rotation,
      }));
      assertEqual(retainedCase.source.observed_geometry, expectedObservedGeometry, `Extraction report observed geometry is invalid for ${fixture.id}`);
    }
    for (const call of retainedCase.calls) {
      if (!SHA256.test(call.result_sha256)) throw new Error(`Extraction report contains an invalid call digest for ${fixture.id}`);
    }
    const expectedRawDigest = sha256(Buffer.from(canonicalJson(retainedCase.calls)));
    if (retainedCase.bindings.raw_result_sha256 !== expectedRawDigest) {
      throw new Error(`Extraction report raw-result binding is invalid for ${fixture.id}`);
    }
    const expectedScoringInputDigest = sha256(Buffer.from(canonicalJson(retainedCase.scoring_input)));
    if (retainedCase.bindings.scoring_input_sha256 !== expectedScoringInputDigest) {
      throw new Error(`Extraction report scoring-input binding is invalid for ${fixture.id}`);
    }
    const pageCall = retainedCase.calls.find(call => call.name === "read_pdf_pages");
    if ((pageCall && retainedCase.bindings.page_result_sha256 !== pageCall.result_sha256)
      || (!pageCall && retainedCase.bindings.page_result_sha256 !== null)) {
      throw new Error(`Extraction report page-result binding is invalid for ${fixture.id}`);
    }
    if (retainedCase.scoring_input.page_result_sha256 !== retainedCase.bindings.page_result_sha256) {
      throw new Error(`Extraction report scorer page-result binding is invalid for ${fixture.id}`);
    }
    const retainedEvidenceIds = (retainedCase.scoring_input.evidence ?? []).map(item => item.id);
    if (new Set(retainedEvidenceIds).size !== retainedEvidenceIds.length) {
      throw new Error(`Extraction report contains duplicate retained evidence IDs for ${fixture.id}`);
    }
    assertEqual(retainedCase.bindings.evidence_ids, retainedEvidenceIds, `Extraction report evidence IDs are not bound to retained evidence for ${fixture.id}`);
    const rescoredMetrics = scoreExtractionCase(fixture, retainedCase.scoring_input, manifest.evaluation_policy);
    assertEqual(retainedCase.metrics, rescoredMetrics, `Extraction report case metrics do not match retained scoring input for ${fixture.id}`);
  }

  const recomputedAggregate = aggregateMetrics(report.cases);
  assertEqual(report.aggregate_metrics, recomputedAggregate, "Extraction report aggregate metrics do not match retained case metrics");
  return true;
}

export function classifyCaseError(error, { handoffComplete }) {
  if (!handoffComplete) return "harness_failure";
  if (error?.code === "PRODUCT_TIMEOUT") return "product_timeout";
  if (error?.code === "INVALID_PRODUCT_OUTPUT") return "invalid_output";
  return "product_failure";
}

async function runCase({ fixture, fixturePath, client, readRssBytes, evaluationPolicy }) {
  const sourceBytes = await fs.readFile(fixturePath);
  const beforeSha = sha256(sourceBytes);
  const calls = [];
  const started = clockMs();

  const readPages = await measuredCall(client, readRssBytes, {
    name: "read_pdf_pages",
    arguments: {
      pdf_path: fixturePath,
      start_page: 1,
      end_page: fixture.expected.page_geometry.length,
      max_chars_per_page: 12000,
    },
  });
  calls.push(retainedCall("read_pdf_pages", readPages));
  const readContent = await measuredCall(client, readRssBytes, {
    name: "read_pdf_content",
    arguments: { pdf_path: fixturePath, max_pages: fixture.expected.page_geometry.length },
  });
  calls.push(retainedCall("read_pdf_content", readContent, {
    extraction_mode: readContent.result.structuredContent?.extraction_mode ?? null,
    extraction_status: readContent.result.structuredContent?.extraction_status ?? null,
  }));
  const analysis = await measuredCall(client, readRssBytes, {
    name: "get_page_analysis",
    arguments: { pdf_path: fixturePath },
  });
  calls.push(retainedCall("get_page_analysis", analysis));

  const rasterPages = [];
  for (const expectedPage of fixture.expected.pages.filter(page => page.modality === "raster")) {
    const rendered = await measuredCall(client, readRssBytes, {
      name: "render_pdf_page",
      arguments: { pdf_path: fixturePath, page: expectedPage.page, max_dimension_px: 1200 },
    });
    const hasPng = rendered.result.content?.some(item => item.type === "image" && item.mimeType === "image/png") === true;
    calls.push(retainedCall("render_pdf_page", rendered, { page: expectedPage.page, png_observed: hasPng }));
    rasterPages.push({ page: expectedPage.page, ok: rendered.ok && hasPng });
  }

  if (!Array.isArray(readPages.result.structuredContent?.pages)) {
    const error = new Error("read_pdf_pages omitted its declared pages array");
    error.code = "INVALID_PRODUCT_OUTPUT";
    throw error;
  }
  const pageTexts = readPages.result.structuredContent.pages.map(page => ({ page: page.page, text: page.text }));
  const pageResultHash = readPages.result_sha256;
  const evidence = pageTexts.map(page => ({
    evidence_schema_version: 1,
    id: `evidence.${fixture.id.split(".").pop()}.page-${page.page}`,
    kind: "page",
    source_sha256: fixture.sha256,
    result_sha256: pageResultHash,
    page: page.page,
    text: page.text,
    text_sha256: sha256(Buffer.from(page.text)),
    bbox: null,
    fact_ids: [],
  }));
  const independentPdf = await PDFDocument.load(sourceBytes, { updateMetadata: false });
  const independentGeometry = independentPdf.getPages().map((page, index) => ({
    page: index + 1,
    media_box: page.getMediaBox(),
    crop_box: page.getCropBox(),
    rotation: page.getRotation().angle,
  }));
  const observedGeometry = analysis.result.structuredContent?.pages?.map(page => ({
    page: page.page,
    width: page.width,
    height: page.height,
    rotation: page.rotation,
  })) ?? [];
  const observation = {
    structured_candidate: null,
    structured_candidate_raw: null,
    table_candidate: null,
    ocr_texts: [],
    page_texts: pageTexts,
    raster_pages: rasterPages,
    evidence,
    page_result_sha256: pageResultHash,
    observed_geometry: observedGeometry,
  };
  const afterSha = sha256(await fs.readFile(fixturePath));
  const callFailures = calls.filter(call => !call.ok).length;
  const requiredCapabilityMissing = observation.structured_candidate === null;
  return {
    id: fixture.id,
    partition: fixture.partition,
    category: fixture.category,
    outcome: callFailures > 0 || requiredCapabilityMissing ? "product_failure" : "completed",
    outcome_reason: callFailures > 0
      ? `${callFailures} required direct tool call(s) failed`
      : "No general structured candidate was returned for the required extraction job",
    source: {
      path: fixture.path,
      sha256: beforeSha,
      immutable: beforeSha === afterSha && beforeSha === fixture.sha256,
      size_bytes: sourceBytes.length,
      independent_geometry: independentGeometry,
      observed_geometry: observedGeometry,
    },
    bindings: {
      raw_result_sha256: sha256(Buffer.from(canonicalJson(calls))),
      page_result_sha256: pageResultHash,
      scoring_input_sha256: sha256(Buffer.from(canonicalJson(observation))),
      evidence_ids: evidence.map(item => item.id),
    },
    calls,
    scoring_input: observation,
    metrics: scoreExtractionCase(fixture, observation, evaluationPolicy),
    resources: {
      latency_ms: Number((clockMs() - started).toFixed(3)),
      peak_rss_bytes: maximumRssOrUnavailable(calls.map(call => call.peak_rss_bytes)),
    },
    privacy: {
      source_immutable: beforeSha === afterSha,
      external_requests_observed: null,
      score: null,
      limitation: "The local stdio runner restricts filesystem paths but does not instrument network syscalls.",
    },
    license: {
      fixture_license_complete: Boolean(fixture.license.spdx_id && fixture.license.url),
      redistribution_allowed: fixture.license.redistribution === "allowed",
      score: 1,
    },
    bundle: {
      applicable: false,
      current_artifact_bytes: null,
      candidate_delta_bytes: null,
      score: null,
      limitation: "Source-server Phase 0 does not build or compare an MCPB artifact.",
    },
  };
}

export async function runExtractionBaseline({
  manifestPath = DEFAULT_MANIFEST,
  manifestSchemaPath = DEFAULT_MANIFEST_SCHEMA,
  reportSchemaPath = DEFAULT_REPORT_SCHEMA,
  outputPath = null,
} = {}) {
  const loaded = await loadExtractionManifest(manifestPath, manifestSchemaPath);
  const planned = loaded.manifest.fixtures.map(fixture => fixture.id);
  const packageJson = JSON.parse(await fs.readFile(path.join(REPO_ROOT, "package.json"), "utf8"));
  const stateRoot = await fs.mkdtemp(path.join(os.tmpdir(), "pdf-tools-extraction-phase0-"));
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [path.join(REPO_ROOT, "server", "index.js")],
    cwd: REPO_ROOT,
    env: {
      ALLOWED_DIRECTORIES: path.dirname(manifestPath),
      DEFAULT_PROFILES_DIR: path.join(stateRoot, "profiles"),
      PDF_TOOLS_DISABLE_SYSTEM_RENDERER: "1",
    },
    stderr: "ignore",
  });
  const client = new Client({ name: "pdf-tools-extraction-phase0", version: "1.0.0" });
  const cases = [];
  let tools;
  try {
    await client.connect(transport);
    const readRssBytes = captureChildCurrentRssReader(transport.pid);
    tools = await client.listTools();
    for (const fixture of loaded.manifest.fixtures) {
      try {
        cases.push(await runCase({
          fixture,
          fixturePath: resolveExtractionFixture(manifestPath, fixture),
          client,
          readRssBytes,
          evaluationPolicy: loaded.manifest.evaluation_policy,
        }));
      } catch (error) {
        const outcome = classifyCaseError(error, { handoffComplete: true });
        const fixturePath = resolveExtractionFixture(manifestPath, fixture);
        const sourceBytes = await fs.readFile(fixturePath);
        const sourceDigest = sha256(sourceBytes);
        const emptyCalls = [];
        const independentPdf = await PDFDocument.load(sourceBytes, { updateMetadata: false });
        const independentGeometry = independentPdf.getPages().map((page, index) => ({
          page: index + 1,
          media_box: page.getMediaBox(),
          crop_box: page.getCropBox(),
          rotation: page.getRotation().angle,
        }));
        const scoringInput = {
          structured_candidate: null,
          structured_candidate_raw: null,
          table_candidate: null,
          ocr_texts: [],
          page_texts: [],
          raster_pages: [],
          evidence: [],
          page_result_sha256: null,
          observed_geometry: [],
        };
        cases.push({
          id: fixture.id,
          partition: fixture.partition,
          category: fixture.category,
          outcome,
          error_code: error.code ?? "PRODUCT_FAILURE",
          source: {
            path: fixture.path,
            sha256: sourceDigest,
            immutable: sourceDigest === fixture.sha256,
            size_bytes: sourceBytes.length,
            independent_geometry: independentGeometry,
            observed_geometry: [],
          },
          bindings: {
            raw_result_sha256: sha256(Buffer.from(canonicalJson(emptyCalls))),
            page_result_sha256: null,
            scoring_input_sha256: sha256(Buffer.from(canonicalJson(scoringInput))),
            evidence_ids: [],
          },
          calls: emptyCalls,
          scoring_input: scoringInput,
          metrics: scoreExtractionCase(fixture, scoringInput, loaded.manifest.evaluation_policy),
        });
      }
    }
  } finally {
    await client.close().catch(() => {});
    await transport.close().catch(() => {});
    await fs.rm(stateRoot, { recursive: true, force: true });
  }

  const count = outcome => cases.filter(item => item.outcome === outcome).length;
  const report = {
    report_schema_version: 1,
    suite_id: loaded.manifest.suite_id,
    suite_version: loaded.manifest.suite_version,
    benchmark_claim_ready: false,
    calibration_claim_ready: false,
    claim_boundary: loaded.manifest.claim_boundary,
    manifest_sha256: loaded.manifest_sha256,
    schema_sha256: loaded.schema_sha256,
    run: {
      runtime_version: packageJson.version,
      runtime_commit: execFileSync("git", ["rev-parse", "HEAD"], { cwd: REPO_ROOT, encoding: "utf8" }).trim(),
      node_version: process.version,
      platform: process.platform,
      architecture: process.arch,
      tool_contract_sha256: sha256(Buffer.from(canonicalJson(tools.tools))),
      tools_observed: tools.tools.length,
    },
    denominator: {
      planned: planned.length,
      attempted: cases.length,
      completed: count("completed"),
      product_failures: count("product_failure"),
      product_timeouts: count("product_timeout"),
      invalid_outputs: count("invalid_output"),
      harness_failures: count("harness_failure"),
      planned_case_ids: planned,
      observed_case_ids: cases.map(item => item.id),
    },
    aggregate_metrics: aggregateMetrics(cases),
    cases,
    limitations: [
      "This is a synthetic local source-server calibration, not a benchmark claim.",
      "The runner does not invoke a model and does not convert extracted text into schema, table, answer, or bbox outputs.",
      "PDF Tools has no bundled OCR engine. Image fallback and page rendering are raster availability, not OCR.",
      "All fixtures use default-origin MediaBox and CropBox geometry. Rotated, cropped, UserUnit, and hostile geometry remain outside Phase 0.",
      "Privacy is bounded by source immutability and filesystem allowlisting; network syscalls are not instrumented.",
      "Bundle cost and native-host behavior are not measured in this source-server run.",
    ],
  };
  const reportSchema = JSON.parse(await fs.readFile(reportSchemaPath, "utf8"));
  const validation = new AjvJsonSchemaValidator().getValidator(reportSchema)(report);
  if (!validation.valid) throw new Error(`Invalid extraction report: ${validation.errorMessage}`);
  verifyExtractionReport(report, {
    manifest: loaded.manifest,
    manifestSha256: loaded.manifest_sha256,
    schemaSha256: loaded.schema_sha256,
  });
  if (outputPath) {
    await fs.mkdir(path.dirname(outputPath), { recursive: true });
    await fs.writeFile(outputPath, `${JSON.stringify(report, null, 2)}\n`);
  }
  return report;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const report = await runExtractionBaseline({
    manifestPath: path.resolve(option("--manifest", DEFAULT_MANIFEST)),
    manifestSchemaPath: path.resolve(option("--manifest-schema", DEFAULT_MANIFEST_SCHEMA)),
    reportSchemaPath: path.resolve(option("--report-schema", DEFAULT_REPORT_SCHEMA)),
    outputPath: path.resolve(option("--output", DEFAULT_OUTPUT)),
  });
  process.stdout.write(`${JSON.stringify({
    output: path.resolve(option("--output", DEFAULT_OUTPUT)),
    denominator: report.denominator,
    aggregate_metrics: report.aggregate_metrics,
  }, null, 2)}\n`);
}
