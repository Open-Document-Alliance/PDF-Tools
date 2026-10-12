import { createHash } from "node:crypto";
import { canonicalWorkspaceJson } from "../scripts/verified-extraction-workspace.mjs";

const SHA = /^[a-f0-9]{64}$/u;
const WORKSPACE = /^[a-z0-9](?:[a-z0-9_-]{0,62}[a-z0-9])?$/u;
const TERMINAL = new Set(["verified_exact", "computed_with_inputs"]);
const MAX_RESPONSE_BYTES = 128 * 1024;
const VIEWS = ["leaves", "pages", "history"];
const digest = value => createHash("sha256").update(value).digest("hex");
const hashJson = value => digest(canonicalWorkspaceJson(value));
const assert = (condition, message) => { if (!condition) throw new Error(message); };
const boundedText = (value, maximum = 1000) => {
  const text = String(value);
  let bytes = 0, preview = "";
  for (const character of text) {
    const count = Buffer.byteLength(character, "utf8");
    if (bytes + count > maximum) break;
    preview += character;
    bytes += count;
  }
  return { text: preview, truncated: preview.length !== text.length };
};

export const EXTRACTION_REVIEW_TOOL_DEFINITION = Object.freeze({
  name: "review_extraction_workspace",
  description: "Open a source-bound Evidence view for a verified-extraction workspace. Shows current values, unresolved leaves, append-only history, replayed citations and page coverage. Read-only; never accepts or approves a proposed value. Subsequent views are bounded to 20 items and pinned to the current workspace generation; refresh after a change.",
  inputSchema: {
    type: "object", additionalProperties: false,
    properties: {
      pdf_path: { type: "string" },
      workspace_id: { type: "string", pattern: WORKSPACE.source },
      workspace_identity_sha256: { type: "string", pattern: SHA.source },
      expected_generation_sha256: { type: "string", pattern: SHA.source },
      view: { type: "string", enum: VIEWS },
      leaf_pointer: { type: "string", maxLength: 4096 },
      limit: { type: "integer", minimum: 1, maximum: 20 },
      cursor: { type: "string", maxLength: 4096 },
    },
    required: ["pdf_path", "workspace_id", "workspace_identity_sha256"],
  },
  annotations: { title: "Review Extraction Evidence", readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  _meta: { ui: { resourceUri: "ui://pdf-toolkit/viewer" } },
});

function token(value) {
  const json = canonicalWorkspaceJson(value);
  return `review.${Buffer.from(json).toString("base64url")}.${digest(json)}`;
}
function parseToken(value) {
  assert(typeof value === "string" && value.length <= 4096, "Review cursor is invalid.");
  const match = /^review\.([A-Za-z0-9_-]+)\.([a-f0-9]{64})$/u.exec(value);
  assert(match, "Review cursor is invalid.");
  const bytes = Buffer.from(match[1], "base64url");
  assert(bytes.toString("base64url") === match[1] && digest(bytes) === match[2], "Review cursor is invalid.");
  const parsed = JSON.parse(bytes.toString("utf8"));
  assert(canonicalWorkspaceJson(parsed) === bytes.toString("utf8"), "Review cursor is not canonical.");
  return parsed;
}

function citationPreview(citation) {
  const replayed = citation.status === "replayed";
  const reference = replayed ? citation : citation.citation || {};
  const quote = boundedText(replayed ? citation.quote : "", 2000);
  return {
    status: replayed ? "replayed" : "unavailable",
    page: replayed ? citation.page : null,
    chunk_id: reference.chunk_id || null,
    start_utf8_byte: reference.start_utf8_byte ?? null,
    end_utf8_byte: reference.end_utf8_byte ?? null,
    quote_sha256: reference.quote_sha256 || null,
    quote: quote.text,
    quote_truncated: quote.truncated,
    reason: replayed ? null : boundedText(citation.error || citation.status || "Citation was not replayed.").text,
  };
}
function proposalRow(pointer, proposal, result, current = true) {
  const preview = boundedText(proposal ? canonicalWorkspaceJson(proposal.proposed_value) : "", 2000);
  const status = result?.status || (proposal ? "unverified" : "not_proposed");
  const settled = TERMINAL.has(status);
  return {
    kind: "leaf", leaf_pointer: pointer, current, status,
    settled, correction_allowed: current && !settled && status !== "unverified",
    proposal_event_id: proposal?.event_id || null,
    event_sequence: proposal?.event_sequence || null,
    verification_sha256: result?.verification_sha256 || null,
    value_preview: preview.text, value_truncated: preview.truncated,
    value_sha256: proposal ? hashJson(proposal.proposed_value) : null,
    method: result?.method?.kind || null,
    reason_codes: (result?.reason_codes || []).slice(0, 16).map(reason => boundedText(reason, 1000).text),
    citation_count: result?.citations?.length || 0,
    citations: current ? [] : (result?.citations || []).map(citationPreview),
  };
}

export function createExtractionReviewToolHandler({ workspaceRoot, resolvePdfPath, readPdfBytes, readReviewState }) {
  assert(typeof readReviewState === "function" && typeof resolvePdfPath === "function" && typeof readPdfBytes === "function", "Review dependencies are incomplete.");
  return async function reviewExtractionWorkspace(args = {}) {
    assert(args && typeof args === "object" && !Array.isArray(args), "Review input must be an object.");
    for (const key of Object.keys(args)) assert(Object.hasOwn(EXTRACTION_REVIEW_TOOL_DEFINITION.inputSchema.properties, key), `Unknown review argument: ${key}.`);
    assert(typeof args.pdf_path === "string" && args.pdf_path.length > 0, "pdf_path is required.");
    assert(typeof args.workspace_id === "string" && WORKSPACE.test(args.workspace_id), "workspace_id is invalid.");
    assert(typeof args.workspace_identity_sha256 === "string" && SHA.test(args.workspace_identity_sha256), "Workspace identity is invalid.");
    assert(args.expected_generation_sha256 === undefined || (typeof args.expected_generation_sha256 === "string" && SHA.test(args.expected_generation_sha256)), "Expected generation is invalid.");
    const view = args.view ?? "leaves";
    const limit = args.limit ?? 20;
    const pointer = args.leaf_pointer ?? null;
    assert(VIEWS.includes(view) && Number.isInteger(limit) && limit >= 1 && limit <= 20, "Review view or limit is invalid.");
    assert(pointer === null || (typeof pointer === "string" && pointer.length <= 4096), "Leaf pointer is invalid.");
    assert(view === "history" ? pointer !== null : pointer === null, "Only history accepts a leaf pointer, and requires one.");
    const retained = await readReviewState({ rootPath: workspaceRoot, workspaceId: args.workspace_id, expectedWorkspaceIdentitySha256: args.workspace_identity_sha256 });
    assert(retained.workspace_identity.workspace_identity_sha256 === args.workspace_identity_sha256, "Workspace identity changed.");
    const generation = retained.generation_sha256;
    assert(!args.expected_generation_sha256 || generation === args.expected_generation_sha256, "Workspace changed. Refresh the Evidence view before continuing.");
    const path = resolvePdfPath(args.pdf_path);
    const sourceBytes = await readPdfBytes(path);
    const source = { canonical_path: path, size_bytes: sourceBytes.length, sha256: digest(sourceBytes) };
    assert(source.sha256 === retained.workspace_identity.source.sha256 && source.size_bytes === retained.workspace_identity.source.size_bytes, "The PDF no longer matches this extraction workspace. Open its original source before reviewing evidence.");
    const binding = { workspace: args.workspace_identity_sha256, generation, source: source.sha256, view, leaf: pointer, limit };
    let offset = 0;
    if (args.cursor !== undefined) {
      const parsed = parseToken(args.cursor);
      assert(Object.keys(parsed).length === 7 && Number.isSafeInteger(parsed.offset) && parsed.offset >= 0, "Review cursor shape is invalid.");
      offset = parsed.offset;
      delete parsed.offset;
      assert(canonicalWorkspaceJson(parsed) === canonicalWorkspaceJson(binding), "Review cursor belongs to a different source, view, or generation. Refresh the Evidence view.");
    }
    const proposals = retained.events.filter(event => event.kind === "proposal_submitted");
    const results = new Map(retained.events.filter(event => event.kind === "proposal_verified").map(event => [event.proposal_event_id, event.verification_result]));
    const latest = new Map(proposals.map(proposal => [proposal.leaf_pointer, proposal]));
    const rows = retained.workspace_identity.leaf_obligations.map(leaf => {
      const proposal = latest.get(leaf);
      return proposalRow(leaf, proposal, results.get(proposal?.event_id));
    });
    const summary = {
      leaves: rows.length, settled: rows.filter(row => row.settled).length,
      unproposed: rows.filter(row => row.status === "not_proposed").length,
      awaiting_verification: rows.filter(row => row.status === "unverified").length,
      unresolved: rows.filter(row => !row.settled && !["not_proposed", "unverified"].includes(row.status)).length,
    };
    let items;
    if (view === "leaves") items = rows;
    else if (view === "history") {
      assert(retained.workspace_identity.leaf_obligations.includes(pointer), "This leaf does not belong to the workspace.");
      const current = latest.get(pointer);
      items = proposals.filter(proposal => proposal.leaf_pointer === pointer).reverse().map(proposal => {
        const result = results.get(proposal.event_id);
        const row = proposalRow(pointer, proposal, result, false);
        row.current = proposal === current;
        row.correction_allowed = row.current && !row.settled && row.status !== "unverified";
        return row;
      });
    } else items = retained.document_map.pages.map(page => ({
      kind: "page", page: page.page, extraction_status: page.extraction_status,
      text_layer_status: page.text_layer_status, modality_hint: page.modality_hint,
      needs_visual_inspection: page.needs_visual_inspection,
      gap_codes: page.gap_codes.slice(0, 64),
      returned_chunks: page.chunk_counts.returned, omitted_chunks: page.chunk_counts.omitted,
      omitted_items: page.counts.layout_omitted_items,
      omitted_characters: page.counts.layout_omitted_characters,
    }));
    assert(offset <= items.length, "Review cursor is outside this collection.");
    const selected = items.slice(offset, offset + limit);
    const make = () => ({
      version: 1, workspace_id: args.workspace_id, workspace_identity_sha256: args.workspace_identity_sha256,
      generation_sha256: generation, generation_sequence: retained.generation_sequence,
      source, schema_sha256: retained.workspace_identity.schema.sha256,
      document_map_sha256: retained.document_map.document_map_sha256,
      page_count: retained.document_map.page_count, summary, view, leaf_pointer: pointer,
      counts: { total: items.length, offset, returned: selected.length }, items: selected,
      next_cursor: offset + selected.length < items.length ? token({ ...binding, offset: offset + selected.length }) : null,
      claim_boundary: "Replay status is not approval, semantic completeness, or proof of absence. Page coverage describes the retained extraction. Citation highlighting is a viewer aid, not evidence of unique placement.",
    });
    let review = make();
    while (Buffer.byteLength(JSON.stringify(review), "utf8") > MAX_RESPONSE_BYTES && selected.length > 1) { selected.pop(); review = make(); }
    assert(Buffer.byteLength(JSON.stringify(review), "utf8") <= MAX_RESPONSE_BYTES, "A review item exceeds the bounded response size.");
    const payload = { pdfPath: path, totalBytes: source.size_bytes, initialPage: 1, fields: [], fieldCount: 0, hasFormFields: false, extractionReview: review };
    return {
      content: [{ type: "text", text: `Evidence review: ${summary.settled}/${summary.leaves} leaves exact or computed; ${summary.unresolved} unresolved, ${summary.awaiting_verification} awaiting replay, ${summary.unproposed} not proposed. Showing ${selected.length} ${view} items. ${review.claim_boundary}` }],
      structuredContent: payload,
      _meta: { ui: { resourceUri: "ui://pdf-toolkit/viewer" }, viewUUID: `review-${args.workspace_identity_sha256}-${generation}` },
    };
  };
}

const string = { type: "string" }, integer = { type: "integer", minimum: 0 }, bool = { type: "boolean" };
const sha = { type: "string", pattern: SHA.source };
const nullable = value => ({ anyOf: [value, { type: "null" }] });
const array = value => ({ type: "array", items: value });
const object = properties => ({ type: "object", additionalProperties: false, properties, required: Object.keys(properties) });
const citationSchema = { anyOf: [
  object({ status: { const: "replayed" }, page: { type: "integer", minimum: 1 }, chunk_id: { type: "string", pattern: "^chunk\\.[a-f0-9]{64}$" }, start_utf8_byte: integer, end_utf8_byte: { type: "integer", minimum: 1 }, quote_sha256: sha, quote: { type: "string", minLength: 1 }, quote_truncated: bool, reason: { type: "null" } }),
  object({ status: { const: "unavailable" }, page: { type: "null" }, chunk_id: nullable(string), start_utf8_byte: nullable(integer), end_utf8_byte: nullable(integer), quote_sha256: nullable(sha), quote: { const: "" }, quote_truncated: { const: false }, reason: string }),
] };
const leafSchema = object({ kind: { const: "leaf" }, leaf_pointer: string, current: bool, status: string, settled: bool, correction_allowed: bool, proposal_event_id: nullable(string), event_sequence: nullable(integer), verification_sha256: nullable(sha), value_preview: string, value_truncated: bool, value_sha256: nullable(sha), method: nullable(string), reason_codes: array(string), citation_count: integer, citations: array(citationSchema) });
const pageSchema = object({ kind: { const: "page" }, page: integer, extraction_status: string, text_layer_status: string, modality_hint: string, needs_visual_inspection: bool, gap_codes: array(string), returned_chunks: integer, omitted_chunks: integer, omitted_items: integer, omitted_characters: integer });
export const EXTRACTION_REVIEW_OUTPUT_SCHEMA = object({
  pdfPath: string, totalBytes: integer, initialPage: integer, fields: { type: "array", maxItems: 0 }, fieldCount: { const: 0 }, hasFormFields: { const: false },
  extractionReview: object({
    version: { const: 1 }, workspace_id: string, workspace_identity_sha256: sha, generation_sha256: sha, generation_sequence: integer,
    source: object({ canonical_path: string, size_bytes: integer, sha256: sha }), schema_sha256: sha, document_map_sha256: sha, page_count: integer,
    summary: object({ leaves: integer, settled: integer, unproposed: integer, awaiting_verification: integer, unresolved: integer }),
    view: { enum: VIEWS }, leaf_pointer: nullable(string), counts: object({ total: integer, offset: integer, returned: integer }),
    items: { type: "array", maxItems: 20, items: { anyOf: [leafSchema, pageSchema] } }, next_cursor: nullable(string), claim_boundary: string,
  }),
});
