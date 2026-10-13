import { createHash } from "node:crypto";

export const hash = value => createHash("sha256").update(value).digest("hex");
export function evidenceFixture(bytes = Buffer.from("OLD"), count = 3) {
  const leaves = Array.from({ length: count }, (_, index) => `/field_${index}`);
  const retained = {
    workspace_identity: {
      workspace_identity_sha256: "a".repeat(64),
      source: { sha256: hash(bytes), size_bytes: bytes.length },
      schema: { sha256: "b".repeat(64) },
      leaf_obligations: leaves,
    },
    generation_sha256: "c".repeat(64), generation_sequence: 4,
    document_map: {
      document_map_sha256: "d".repeat(64), page_count: 1,
      pages: [{ page: 1, extraction_status: "complete", text_layer_status: "present", modality_hint: "text", needs_visual_inspection: true, gap_codes: ["IMAGE_REQUIRES_INSPECTION"], chunk_counts: { returned: 1, omitted: 0 }, counts: { layout_omitted_items: 0, layout_omitted_characters: 0 } }],
    },
    events: [], current_state: {}, schema_bytes: Buffer.from("{}"),
  };
  const propose = (leaf, value) => {
    const event = { kind: "proposal_submitted", event_sequence: retained.events.length + 1, event_id: `event.${hash(String(retained.events.length))}`, leaf_pointer: leaf, proposed_value: value };
    retained.events.push(event);
    return event;
  };
  const verify = (proposal, status, quote = "OLD") => {
    const verification_result = {
      status, method: { kind: "source_support" }, verification_sha256: "e".repeat(64),
      reason_codes: status === "source_supported" ? ["SEMANTIC_INTERPRETATION_NOT_MECHANICALLY_PROVEN"] : [],
      citations: [{ status: "replayed", page: 1, chunk_id: `chunk.${"f".repeat(64)}`, start_utf8_byte: 0, end_utf8_byte: Buffer.byteLength(quote), quote, quote_sha256: hash(quote) }],
    };
    retained.events.push({ kind: "proposal_verified", proposal_event_id: proposal.event_id, verification_result });
    return verification_result;
  };
  verify(propose(leaves[0], "uncertain value"), "source_supported");
  if (count > 1) verify(propose(leaves[1], "OLD"), "verified_exact");
  return { retained, propose, verify, args: { pdf_path: "/fixtures/current.pdf", workspace_id: "review-fixture", workspace_identity_sha256: retained.workspace_identity.workspace_identity_sha256 } };
}
