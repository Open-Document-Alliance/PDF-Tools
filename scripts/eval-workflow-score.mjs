// This public synthetic qualification is deliberately independent of the
// private agent campaigns. Fixed obligations cannot disappear after a failure.
export const WORKFLOW_OBLIGATIONS = Object.freeze([
  { id: "import.exact_bytes", kind: "correctness" },
  { id: "inspect.fields", kind: "correctness" },
  { id: "fill.independent_fields", kind: "correctness" },
  { id: "fill.original_unchanged", kind: "correctness" },
  { id: "return.exact_bytes", kind: "correctness" },
  { id: "return.independent_fields", kind: "correctness" },
  { id: "reorder.independent_pages", kind: "correctness" },
  { id: "reorder.original_unchanged", kind: "correctness" },
  { id: "textless.explicit_gap", kind: "abstention" },
  { id: "invalid_import.refused", kind: "refusal" },
  { id: "invalid_reorder.refused", kind: "refusal" },
  { id: "invalid_reorder.no_output", kind: "correctness" },
]);

export function scoreWorkflow(observations) {
  if (!Array.isArray(observations) || observations.length !== WORKFLOW_OBLIGATIONS.length) {
    throw new Error("The complete frozen obligation denominator is required");
  }
  const counts = { passed: 0, failed: 0, not_run: 0 };
  const byKind = {};
  for (const [index, expected] of WORKFLOW_OBLIGATIONS.entries()) {
    const item = observations[index];
    if (item?.id !== expected.id || item.kind !== expected.kind
      || !Object.hasOwn(counts, item.status)) throw new Error("Obligation identity, order, or status mismatch");
    if (expected.kind === "refusal"
      && ((item.status === "not_run" && item.accepted !== null)
        || (item.status !== "not_run" && typeof item.accepted !== "boolean")
        || (item.status === "passed" && item.accepted)
        || (item.status === "failed" && !item.accepted))) {
      throw new Error("Refusal status contradicts observed acceptance");
    }
    counts[item.status] += 1;
    byKind[expected.kind] ??= { total: 0, passed: 0, failed: 0, not_run: 0 };
    byKind[expected.kind].total += 1;
    byKind[expected.kind][item.status] += 1;
  }
  const negative = observations.filter(item => item.kind === "refusal");
  const falseAcceptances = negative.filter(item => item.accepted === true).length;
  return {
    total: observations.length, ...counts, by_kind: byKind,
    pass_rate_all_obligations: counts.passed / observations.length,
    coverage: (counts.passed + counts.failed) / observations.length,
    false_acceptance: {
      accepted: falseAcceptances, total: negative.length,
      attempted: negative.filter(item => item.status !== "not_run").length,
      rate_all_negative_cases: falseAcceptances / negative.length,
      // A zero rate without full coverage is explicitly not a clean pass.
      fully_observed: negative.every(item => item.status !== "not_run"),
    },
    passed_all: counts.passed === observations.length,
  };
}
