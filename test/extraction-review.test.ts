import { describe, expect, it, vi } from "vitest";
import { createExtractionReviewToolHandler, EXTRACTION_REVIEW_OUTPUT_SCHEMA, EXTRACTION_REVIEW_TOOL_DEFINITION } from "../server/extraction-review.js";
import { parseEvidenceReview, findUniqueCitationSpans } from "../ui/src/evidence-review";
import { evidenceFixture } from "./helpers/evidence-review-fixture.js";
import { AjvJsonSchemaValidator } from "@modelcontextprotocol/server/validators/ajv";

function fixture(count = 3) {
  const data = evidenceFixture(Buffer.from("OLD"), count);
  const readPdfBytes = vi.fn(async () => Buffer.from("OLD"));
  const readReviewState = vi.fn(async () => data.retained);
  const handle = createExtractionReviewToolHandler({ workspaceRoot: "/workspace", resolvePdfPath: value => value, readPdfBytes, readReviewState });
  return { ...data, handle, readPdfBytes, readReviewState };
}
const review = (result: any) => parseEvidenceReview(result.structuredContent.extractionReview);

describe("extraction evidence projection", () => {
  it("exposes a read-only bounded tool and schema-valid unresolved/current values", async () => {
    const f = fixture();
    const result = await f.handle(f.args);
    expect(EXTRACTION_REVIEW_TOOL_DEFINITION.annotations.readOnlyHint).toBe(true);
    const validation = new AjvJsonSchemaValidator().getValidator(EXTRACTION_REVIEW_OUTPUT_SCHEMA)(result.structuredContent);
    expect(validation).toMatchObject({ valid: true });
    const data = review(result);
    expect(data.summary).toEqual({ leaves: 3, settled: 1, unresolved: 1, unproposed: 1, awaiting_verification: 0 });
    expect(data.items[0]).toMatchObject({ status: "source_supported", settled: false, correction_allowed: true, citation_count: 1, citations: [] });
    expect(data.items[1]).toMatchObject({ status: "verified_exact", settled: true, correction_allowed: false });
    expect(f.readReviewState).toHaveBeenCalledTimes(1);
    expect(result._meta.viewUUID).toContain(data.generation_sha256);
  });

  it("keeps a historical result historical when a new proposal is still unverified", async () => {
    const f = fixture();
    const latest = f.propose("/field_0", "replacement");
    const data = review(await f.handle({ ...f.args, view: "history", leaf_pointer: "/field_0" }));
    expect(data.summary).toMatchObject({ awaiting_verification: 1, unresolved: 0 });
    expect(data.items[0]).toMatchObject({ current: true, status: "unverified", proposal_event_id: latest.event_id, correction_allowed: false, citations: [] });
    expect(data.items[1]).toMatchObject({ current: false, status: "source_supported", correction_allowed: false, citations: [{ status: "replayed", page: 1, quote: "OLD" }] });
  });

  it("binds pagination to workspace, generation, source, collection and limit", async () => {
    const f = fixture(24);
    const first = review(await f.handle({ ...f.args, limit: 20 }));
    expect(first.items).toHaveLength(20);
    const second = review(await f.handle({ ...f.args, cursor: first.next_cursor }));
    expect(second.items).toHaveLength(4);
    expect(second.counts.offset).toBe(20);
    expect(second.next_cursor).toBeNull();
    await expect(f.handle({ ...f.args, cursor: first.next_cursor, view: "pages" })).rejects.toThrow(/different source, view, or generation/);
    await expect(f.handle({ ...f.args, cursor: first.next_cursor, limit: 19 })).rejects.toThrow(/different source, view, or generation/);
    f.retained.generation_sha256 = "9".repeat(64);
    await expect(f.handle({ ...f.args, cursor: first.next_cursor })).rejects.toThrow(/different source, view, or generation/);
    await expect(f.handle({ ...f.args, expected_generation_sha256: first.generation_sha256 })).rejects.toThrow(/Workspace changed/);
  });

  it("rejects changed same-size source bytes and malformed inputs", async () => {
    const f = fixture();
    f.readPdfBytes.mockResolvedValue(Buffer.from("NEW"));
    await expect(f.handle(f.args)).rejects.toThrow(/no longer matches/);
    for (const args of [{ ...f.args, approve: true }, { ...f.args, view: "history" }, { ...f.args, leaf_pointer: "/field_0" }, { ...f.args, view: "" }, { ...f.args, workspace_id: 1 }, { ...f.args, limit: 21 }]) {
      await expect(f.handle(args)).rejects.toThrow();
    }
  });

  it("returns retained page coverage including unresolved gaps", async () => {
    const f = fixture();
    const data = review(await f.handle({ ...f.args, view: "pages" }));
    expect(data.items).toEqual([{ kind: "page", page: 1, extraction_status: "complete", text_layer_status: "present", modality_hint: "text", needs_visual_inspection: true, gap_codes: ["IMAGE_REQUIRES_INSPECTION"], returned_chunks: 1, omitted_chunks: 0, omitted_items: 0, omitted_characters: 0 }]);
  });

  it("bounds large Unicode values, citations and history without slicing UTF-8 characters", async () => {
    const f = fixture();
    for (let index = 0; index < 24; index++) {
      const proposal = f.propose("/field_0", "😀".repeat(1000));
      const result = f.verify(proposal, "ambiguous", "😀".repeat(1000));
      result.citations = Array.from({ length: 32 }, () => result.citations[0]);
    }
    const result = await f.handle({ ...f.args, view: "history", leaf_pointer: "/field_0" });
    const data = review(result);
    expect(Buffer.byteLength(JSON.stringify(data))).toBeLessThanOrEqual(131072);
    expect(data.items.length).toBeGreaterThan(0);
    expect(data.items.length).toBeLessThan(20);
    expect(data.next_cursor).not.toBeNull();
    const leaf: any = data.items[0];
    expect(leaf.value_truncated).toBe(true);
    expect(leaf.citations[0].quote_truncated).toBe(true);
    expect(leaf.citations[0].quote).not.toContain("�");
    expect(Buffer.byteLength(leaf.citations[0].quote)).toBeLessThanOrEqual(2000);
  });
});

describe("citation display boundaries", () => {
  it("finds one exact quote across text spans and abstains on repeated or normalized text", () => {
    expect(findUniqueCitationSpans(["Invoice ", "123", " total"], "Invoice 123")).toEqual([0, 1]);
    expect(findUniqueCitationSpans(["123 ", "123"], "123")).toBeNull();
    expect(findUniqueCitationSpans(["Invoice\n123"], "Invoice 123")).toBeNull();
    expect(findUniqueCitationSpans(["123"], "")).toBeNull();
  });
  it("rejects a metadata claim promoting uncertainty to settled", async () => {
    const f = fixture();
    const data: any = review(await f.handle(f.args));
    data.items[0].settled = true;
    expect(() => parseEvidenceReview(data)).toThrow(/invalid/);
  });
  it.each(["page", "chunk_id", "start_utf8_byte", "end_utf8_byte", "quote_sha256"])("rejects replayed citation metadata without %s", async key => {
    const f = fixture();
    const data: any = review(await f.handle({ ...f.args, view: "history", leaf_pointer: "/field_0" }));
    data.items[0].citations[0][key] = null;
    expect(() => parseEvidenceReview(data)).toThrow(/invalid/);
  });
});
