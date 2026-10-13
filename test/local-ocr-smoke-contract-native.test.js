import assert from "node:assert/strict";
import { test } from "node:test";
import { assertLocalOcrSmokeCatalog, assertLocalOcrSmokeProgress } from "../scripts/local-ocr-smoke-contract.mjs";

const defaults = [{ name: "read_pdf_content" }, { name: "get_pdf_identity" }];
const optional = ["propose_pdf_ocr", "start_pdf_ocr_job", "resume_pdf_ocr_job", "read_pdf_ocr_job"]
  .map(name => ({ name, inputSchema: { type: "object", additionalProperties: false },
    annotations: { readOnlyHint: name === "read_pdf_ocr_job" } }));
const configured = [...defaults, ...optional.map(tool => ({ ...tool, outputSchema: { type: "object" } }))];

test("smoke follows exact current default and four optional tool names without historical counts", () => {
  assert.equal(assertLocalOcrSmokeCatalog(defaults, defaults, optional, false), 2);
  assert.equal(assertLocalOcrSmokeCatalog([...configured].reverse(), defaults, optional, true), 6);
});
for (const [name, mutate] of [
  ["missing job tool", tools => tools.pop()],
  ["extra tool", tools => tools.push({ name: "unexpected" })],
  ["duplicate tool", tools => tools.push(tools[0])],
  ["optional schema drift", tools => { tools[2].inputSchema.additionalProperties = true; }],
  ["optional annotation drift", tools => { tools[2].annotations.readOnlyHint = true; }],
  ["missing output schema", tools => { delete tools[2].outputSchema; }],
]) {
  test(`catalog rejects ${name}`, () => {
    const tools = structuredClone(configured); mutate(tools);
    assert.throws(() => assertLocalOcrSmokeCatalog(tools, defaults, optional, true));
  });
}
test("default catalog cannot silently enable OCR", () => {
  assert.throws(() => assertLocalOcrSmokeCatalog(configured, defaults, optional, false));
});

const expectation = { pages: [1, 2], completed: [1], processed: 1, sourceSha256: "a".repeat(64),
  job: { job_id: "fixture-job", job_identity_sha256: "b".repeat(64) } };
const paused = { ...expectation.job, verification_status: "unverified_ocr_proposals", source_pdf_sha256: expectation.sourceSha256,
  page_count: 2, completed_count: 1, remaining_count: 1, completed_pages: [{ page_number: 1 }], remaining_pages: [2],
  processed_this_call: 1, failed_page: null, failure_code: null, status: "ocr_job_paused" };
test("progress accepts the exact retained page partition", () => {
  assertLocalOcrSmokeProgress(paused, expectation);
});
for (const [key, value] of Object.entries({ verification_status: "verified", source_pdf_sha256: "c".repeat(64),
  job_identity_sha256: "c".repeat(64), completed_count: 2, remaining_pages: [], processed_this_call: 0,
  failed_page: 2, status: "ocr_job_complete" })) {
  test(`progress rejects substituted ${key}`, () => {
    assert.throws(() => assertLocalOcrSmokeProgress({ ...paused, [key]: value }, expectation));
  });
}
