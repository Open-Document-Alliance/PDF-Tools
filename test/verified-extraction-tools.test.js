import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { extractPdfLayoutForMarkdown } from "../server/layout-extraction.js";
import {
  VERIFIED_EXTRACTION_TOOL_DEFINITIONS,
  createVerifiedExtractionToolHandler,
} from "../server/verified-extraction-tools.js";
import { validateStructuredToolResult } from "../server/output-schemas.js";
import { canonicalWorkspaceJson, readExtractionReviewState } from "../scripts/verified-extraction-workspace.mjs";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const SOURCE_PATH = path.join(
  REPO_ROOT,
  "test/fixtures/eval/extraction/synthetic/born-digital-flat.pdf",
);

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

function expectValidOutput(toolName, structuredContent) {
  const result = { content: [], structuredContent };
  expect(validateStructuredToolResult(toolName, result)).toBe(result);
}

describe("verified extraction MCP lifecycle", () => {
  let pdfjsLib;
  let parentPath;
  let workspaceRoot;
  let handle;
  let extractionCalls;
  let sourceReads;

  beforeAll(async () => {
    pdfjsLib = await import("pdfjs-dist/legacy/build/pdf.mjs");
  }, 60_000);

  beforeEach(async () => {
    parentPath = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "pdf-tools-mcp-e9e7-")));
    await fs.chmod(parentPath, 0o700);
    workspaceRoot = path.join(parentPath, "workspaces");
    extractionCalls = 0;
    sourceReads = 0;
    handle = createVerifiedExtractionToolHandler({
      workspaceRoot,
      resolvePdfPath: value => path.resolve(value),
      readPdfBytes: filename => { sourceReads += 1; return fs.readFile(filename); },
      extractLayouts: async ({ resolvedPath, sourceBytes, maxPages }) => {
        extractionCalls += 1;
        const sourceSha256 = sha256(sourceBytes);
        const first = await extractPdfLayoutForMarkdown({
          pdfjsLib,
          pdfBytes: sourceBytes,
          sourcePath: resolvedPath,
          sourceFileName: path.basename(resolvedPath),
          sourceSha256,
          requestedStartPage: 1,
          requestedEndPage: 1,
          maxItems: 5000,
          maxCharacters: 100000,
          maxOutputCharacters: 200000,
          deadlineMs: 20000,
        });
        expect(first.page_range.total_pages).toBeLessThanOrEqual(maxPages);
        return [first];
      },
    });
  });

  afterEach(async () => {
    await fs.rm(parentPath, { recursive: true, force: true });
  });

  it("ships eight bounded tools and persists a source-replayed exact value", async () => {
    expect(VERIFIED_EXTRACTION_TOOL_DEFINITIONS.map(tool => tool.name)).toEqual([
      "create_extraction_workspace",
      "inspect_extraction_state",
      "read_extraction_workspace",
      "read_extraction_chunk",
      "submit_extraction_proposal",
      "verify_extraction_proposal",
      "verify_extraction_batch",
      "delete_extraction_workspace",
    ]);
    const created = await handle("create_extraction_workspace", {
      pdf_path: SOURCE_PATH,
      workspace_id: "invoice-extraction",
      schema: {
        type: "object",
        additionalProperties: false,
        required: ["invoice_id"],
        properties: { invoice_id: { type: "string" } },
      },
    });
    expect(created).toMatchObject({
      state: "complete",
      generation_sequence: 0,
      leaf_obligations: ["/invoice_id"],
    });
    expectValidOutput("create_extraction_workspace", created);

    const chunkPage = await handle("read_extraction_workspace", {
      workspace_id: "invoice-extraction",
      workspace_identity_sha256: created.workspace_identity_sha256,
      collection: "document_map_chunks",
      limit: 10,
    });
    expect(chunkPage.items).toHaveLength(1);
    expectValidOutput("read_extraction_workspace", chunkPage);
    const chunk = await handle("read_extraction_chunk", {
      pdf_path: SOURCE_PATH,
      workspace_id: "invoice-extraction",
      workspace_identity_sha256: created.workspace_identity_sha256,
      chunk_id: chunkPage.items[0].chunk_id,
    });
    expectValidOutput("read_extraction_chunk", chunk);
    const quote = Buffer.from("INV-1001", "utf8");
    const content = Buffer.from(chunk.content, "utf8");
    const start = content.indexOf(quote);
    expect(start).toBeGreaterThanOrEqual(0);

    const proposed = await handle("submit_extraction_proposal", {
      workspace_id: "invoice-extraction",
      workspace_identity_sha256: created.workspace_identity_sha256,
      parent_generation_sha256: created.generation_sha256,
      leaf_pointer: "/invoice_id",
      proposed_value: "INV-1001",
      chunk_ids: [chunk.chunk_id],
    });
    expectValidOutput("submit_extraction_proposal", proposed);
    const verified = await handle("verify_extraction_proposal", {
      pdf_path: SOURCE_PATH,
      workspace_id: "invoice-extraction",
      workspace_identity_sha256: created.workspace_identity_sha256,
      proposal_generation_sha256: proposed.generation_sha256,
      proposal_event_id: proposed.event.event_id,
      citations: [{
        chunk_id: chunk.chunk_id,
        start_utf8_byte: start,
        end_utf8_byte: start + quote.length,
        quote_sha256: sha256(quote),
      }],
      method: { kind: "exact_projection", citation_index: 0, normalization: "identity" },
    });
    expect(verified).toMatchObject({
      generation_sequence: 2,
      result: { status: "verified_exact", derived_value: "INV-1001" },
    });
    expectValidOutput("verify_extraction_proposal", verified);
    expect(extractionCalls).toBe(1);
    expect(sourceReads).toBe(3);
    const pending = await handle("read_extraction_workspace", {
      workspace_id: "invoice-extraction",
      workspace_identity_sha256: created.workspace_identity_sha256,
      collection: "pending_leaves",
      limit: 10,
    });
    expect(pending.items).toEqual([]);
    const inspection = await handle("inspect_extraction_state", {
      workspace_id: "invoice-extraction",
      workspace_identity_sha256: created.workspace_identity_sha256,
    });
    expect(inspection).toMatchObject({
      state: "complete",
      current_generation_sha256: verified.generation_sha256,
      current_generation_sequence: 2,
    });
    expectValidOutput("inspect_extraction_state", inspection);
    const deleted = await handle("delete_extraction_workspace", {
      workspace_id: "invoice-extraction",
      workspace_identity_sha256: created.workspace_identity_sha256,
      current_generation_sha256: verified.generation_sha256,
      confirm: "DELETE",
    });
    expect(deleted).toMatchObject({ state: "deleted", recoverable: false });
    expectValidOutput("delete_extraction_workspace", deleted);
  }, 60_000);

  it("atomically retains ordered batch results and continues single-proposal history", async () => {
    const created = await handle("create_extraction_workspace", {
      pdf_path: SOURCE_PATH, workspace_id: "batch-workspace",
      schema: { type: "object", properties: {
        first: { type: "string" }, second: { type: "string" }, missing: { type: "null" },
      } },
    });
    const bound = { workspace_id: "batch-workspace", workspace_identity_sha256: created.workspace_identity_sha256 };
    const chunks = await handle("read_extraction_workspace", { ...bound, collection: "document_map_chunks" });
    const chunkId = chunks.items[0].chunk_id;
    const chunk = await handle("read_extraction_chunk", { ...bound, pdf_path: SOURCE_PATH, chunk_id: chunkId });
    const quote = Buffer.from("INV-1001");
    const start = Buffer.from(chunk.content).indexOf(quote);
    expect(start).toBeGreaterThanOrEqual(0);
    const citation = { chunk_id: chunkId, start_utf8_byte: start, end_utf8_byte: start + quote.length,
      quote_sha256: sha256(quote) };
    const method = { kind: "exact_projection", citation_index: 0, normalization: "identity" };
    let parent = created.generation_sha256;
    const proposals = [];
    for (const leaf of ["first", "second", "missing"]) {
      const proposed = await handle("submit_extraction_proposal", { ...bound,
        parent_generation_sha256: parent, leaf_pointer: `/${leaf}`,
        proposed_value: leaf === "missing" ? null : "INV-1001", chunk_ids: [chunkId] });
      proposals.push(proposed.event);
      parent = proposed.generation_sha256;
    }
    const input = { ...bound, pdf_path: SOURCE_PATH, parent_generation_sha256: parent, items: [
      { proposal_event_id: proposals[0].event_id, citations: [citation], method },
      { proposal_event_id: proposals[1].event_id, citations: [{ ...citation, quote_sha256: "0".repeat(64) }], method },
      { proposal_event_id: proposals[2].event_id, citations: [], method: { kind: "not_found" } },
    ] };
    const generationsPath = path.join(created.workspace_path, "generations");
    const oldNames = await fs.readdir(generationsPath);
    expect(oldNames).toHaveLength(4);
    const retainedFiles = [];
    for (const name of oldNames) {
      for (const file of await fs.readdir(path.join(generationsPath, name))) {
        const filename = path.join(generationsPath, name, file);
        retainedFiles.push([filename, await fs.readFile(filename)]);
      }
    }
    expect(retainedFiles.length).toBeGreaterThan(0);
    const malformed = structuredClone(input);
    malformed.items[1].method = { kind: "invented" };
    malformed.items[1].citations = [citation];
    await expect(handle("verify_extraction_batch", malformed)).rejects.toThrow(/batch item 1/);
    await expect(handle("verify_extraction_batch", { ...input, items: [input.items[0], input.items[0]] }))
      .rejects.toThrow(/batch item 1.*duplicate/);
    await expect(handle("verify_extraction_batch", { ...input, items: [] })).rejects.toThrow(/1 through 32/);
    await expect(handle("verify_extraction_batch", { ...input, items: Array(33).fill(input.items[0]) }))
      .rejects.toThrow(/1 through 32/);
    expect(await fs.readdir(generationsPath)).toEqual(oldNames);
    expect(await fs.readdir(created.workspace_path)).not.toContain("writer-claim.v1.json");
    const batch = await handle("verify_extraction_batch", input);
    expectValidOutput("verify_extraction_batch", batch);
    expect(batch).toMatchObject({ state: "complete", parent_generation_sha256: parent, generation_sequence: 4 });
    expect(batch.events.map(event => event.event_sequence)).toEqual([4, 5, 6]);
    expect(batch.results.map(result => result.status)).toEqual([
      "verified_exact", "citation_mismatch", "unverified_reasoning",
    ]);
    expect(batch.results.every(result => result.generation_sha256 === parent)).toBe(true);
    const batchName = (await fs.readdir(generationsPath)).find(name => name.includes(batch.generation_sha256));
    const manifest = JSON.parse(await fs.readFile(path.join(generationsPath, batchName, "generation-manifest.v1.json")));
    expect(manifest).toMatchObject({ contract: { version: "1.1.0-experimental" }, sequence: 4, event_count: 6 });
    const pending = await handle("read_extraction_workspace", { ...bound, collection: "pending_leaves" });
    expect(pending.items).toEqual(["/missing", "/second"]);
    await expect(handle("verify_extraction_batch", input)).rejects.toThrow(/exact complete current generation/);
    const correction = await handle("submit_extraction_proposal", { ...bound,
      parent_generation_sha256: batch.generation_sha256, leaf_pointer: "/second",
      proposed_value: "INV-1001", chunk_ids: [chunkId] });
    const corrected = await handle("verify_extraction_proposal", { ...bound, pdf_path: SOURCE_PATH,
      proposal_generation_sha256: correction.generation_sha256,
      proposal_event_id: correction.event.event_id, citations: [citation], method });
    expect(corrected).toMatchObject({ generation_sequence: 6, result: { status: "verified_exact" } });
    expectValidOutput("verify_extraction_proposal", corrected);
    for (const [filename, bytes] of retainedFiles) expect(await fs.readFile(filename)).toEqual(bytes);
    const snapshotArgs = { rootPath: workspaceRoot, workspaceId: bound.workspace_id,
      expectedWorkspaceIdentitySha256: bound.workspace_identity_sha256 };
    const snapshot = await readExtractionReviewState(snapshotArgs);
    expect(snapshot.events).toHaveLength(8);
    expect(snapshot.current_state).toMatchObject({ generation_sequence: 6, event_count: 8 });
    snapshot.events.length = 0;
    const historical = await readExtractionReviewState({ ...snapshotArgs, expectedGenerationSha256: parent });
    expect(historical.events).toHaveLength(3);
    expect((await readExtractionReviewState(snapshotArgs)).events).toHaveLength(8);
    expect(extractionCalls).toBe(1);
    expect(sourceReads).toBeGreaterThan(6);
    const manifestPath = path.join(generationsPath, batchName, "generation-manifest.v1.json");
    await fs.writeFile(manifestPath, `${canonicalWorkspaceJson({ ...manifest, event_count: 7 })}\n`);
    await expect(readExtractionReviewState(snapshotArgs)).rejects.toThrow(/event count does not replay/);
  }, 60_000);

  it("rejects unknown arguments for every verified-extraction tool", async () => {
    for (const { name } of VERIFIED_EXTRACTION_TOOL_DEFINITIONS) {
      await expect(handle(name, { unexpected_argument: true }))
        .rejects.toThrow(/unknown argument/u);
    }
  });

  it("rejects stale generations, source drift, and deletion without exact confirmation", async () => {
    const created = await handle("create_extraction_workspace", {
      pdf_path: SOURCE_PATH,
      workspace_id: "hostile-workspace",
      schema: { type: "object", properties: { invoice_id: { type: "string" } } },
    });
    const chunks = await handle("read_extraction_workspace", {
      workspace_id: "hostile-workspace",
      workspace_identity_sha256: created.workspace_identity_sha256,
      collection: "document_map_chunks",
      limit: 10,
    });
    const proposed = await handle("submit_extraction_proposal", {
      workspace_id: "hostile-workspace",
      workspace_identity_sha256: created.workspace_identity_sha256,
      parent_generation_sha256: created.generation_sha256,
      leaf_pointer: "/invoice_id",
      proposed_value: "INV-1001",
      chunk_ids: [chunks.items[0].chunk_id],
    });
    await expect(handle("submit_extraction_proposal", {
      workspace_id: "hostile-workspace",
      workspace_identity_sha256: created.workspace_identity_sha256,
      parent_generation_sha256: created.generation_sha256,
      leaf_pointer: "/invoice_id",
      proposed_value: "forged",
      chunk_ids: [chunks.items[0].chunk_id],
    })).rejects.toThrow(/exact expected parent/u);
    await expect(handle("delete_extraction_workspace", {
      workspace_id: "hostile-workspace",
      workspace_identity_sha256: created.workspace_identity_sha256,
      current_generation_sha256: proposed.generation_sha256,
      confirm: "NO",
    })).rejects.toThrow(/literal DELETE/u);

    const changedPath = path.join(parentPath, "changed.pdf");
    await fs.writeFile(changedPath, Buffer.concat([await fs.readFile(SOURCE_PATH), Buffer.from([0])]));
    await expect(handle("read_extraction_chunk", {
      pdf_path: changedPath,
      workspace_id: "hostile-workspace",
      workspace_identity_sha256: created.workspace_identity_sha256,
      chunk_id: chunks.items[0].chunk_id,
    })).rejects.toThrow(/source|hash|byte|different inputs/u);
  }, 60_000);
});
