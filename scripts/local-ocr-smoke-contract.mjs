import assert from "node:assert/strict";

export function assertLocalOcrSmokeEncryptedRefusal(error) {
  assert.equal(error.code, 2, "Encryption control failed for an unexpected reason");
  assert.equal(error.stdout, "");
  assert.deepEqual(JSON.parse(error.stderr), { status: "ocr_proposal_failed",
    message: "Optional OCR does not accept encrypted PDFs" });
}

// Check the current default name inventory, not a historical tool count.
// Optional input/output schemas and annotations match the source definitions.
export function assertLocalOcrSmokeCatalog(tools, manifestTools, optionalTools, enabled) {
  const names = definitions => {
    assert(Array.isArray(definitions) && definitions.length > 0, "Tool inventory must be nonempty");
    const result = definitions.map(tool => {
      assert(typeof tool.name === "string" && tool.name.length > 0, "Invalid tool name");
      return tool.name;
    });
    assert.equal(new Set(result).size, result.length, "Duplicate tool name");
    return result.sort();
  };
  const defaults = names(manifestTools);
  const optional = names(optionalTools);
  assert(!optional.some(name => defaults.includes(name)), "Optional tool in default inventory");
  const expected = enabled ? [...defaults, ...optional].sort() : defaults;
  assert.deepEqual(names(tools), expected, "Live tool catalog differs from the current source inventory");
  if (enabled) {
    for (const definition of optionalTools) {
      const observed = tools.find(tool => tool.name === definition.name);
      assert.deepEqual(observed.inputSchema, definition.inputSchema, "Optional input schema drift");
      assert.deepEqual(observed.annotations, definition.annotations, "Optional annotations drift");
      assert(definition.outputSchema?.type === "object", "Expected optional output schema missing");
      assert.deepEqual(observed.outputSchema, definition.outputSchema, "Optional output schema drift");
    }
  }
  return expected.length;
}

export function assertLocalOcrSmokeProgress(result, { pages, completed, processed, sourceSha256, job }) {
  assert(result && result.verification_status === "unverified_ocr_proposals", "OCR words must remain unverified");
  assert.equal(result.source_pdf_sha256, sourceSha256);
  if (job) {
    assert.equal(result.job_id, job.job_id);
    assert.equal(result.job_identity_sha256, job.job_identity_sha256);
  }
  const remaining = pages.filter(page => !completed.includes(page));
  assert.equal(result.page_count, pages.length);
  assert.equal(result.completed_count, completed.length);
  assert.equal(result.remaining_count, remaining.length);
  assert.deepEqual(result.completed_pages.map(page => page.page_number), completed);
  assert.deepEqual(result.remaining_pages, remaining);
  assert.equal(result.processed_this_call, processed);
  assert.equal(result.failed_page, null, "An OCR page failed");
  assert.equal(result.failure_code, null, "An OCR page failed");
  assert.equal(result.status, remaining.length === 0 ? "ocr_job_complete"
    : completed.length === 0 ? "ocr_job_ready" : "ocr_job_paused");
}
