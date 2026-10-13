import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { PDFDocument, StandardFonts } from "pdf-lib";

import { SHARE_FILES } from "../package-for-friend.js";
import { SERVER_FILES } from "../scripts/build-mcpb.mjs";
import {
  compileExtractionLeafObligations,
  validateExtractionProposalVerificationResult,
  verifyWorkspaceExtractionProposal,
  verifyWorkspaceExtractionBatch,
} from "../scripts/verified-extraction-proposal.mjs";
import {
  appendVerifiedWorkspaceResult,
  appendVerifiedWorkspaceResults,
  readExtractionReviewState,
  recoverExtractionWorkspace,
  appendUnverifiedWorkspaceProposal,
  canonicalWorkspaceJson,
  createExtractionWorkspace,
  readExtractionWorkspacePage,
} from "../scripts/verified-extraction-workspace.mjs";
import {
  buildSourceBoundDocumentMap,
  readSourceBoundDocumentChunk,
} from "../server/document-map.js";
import { extractPdfLayoutForMarkdown } from "../server/layout-extraction.js";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const SOURCE_PATH = path.join(
  REPO_ROOT,
  "test/fixtures/eval/extraction/synthetic/born-digital-flat.pdf",
);
const SCHEMA = {
  type: "object",
  additionalProperties: false,
  properties: {
    invoice_id: { type: "string" },
    vendor: { type: "string" },
    amount: { type: "number" },
    computed: { type: "number" },
    interpretation: { type: "string" },
    ambiguous: { type: "string" },
    missing: { type: "null" },
    unique_codes: { type: "array", uniqueItems: true, items: { type: "string" } },
    records: {
      type: "array",
      "x-key": "code",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["code", "value"],
        properties: { code: { type: "string" }, value: { type: "number" } },
      },
    },
  },
};
const SCHEMA_BYTES = Buffer.from(JSON.stringify(SCHEMA), "utf8");
const LEAVES = [
  "/ambiguous",
  "/amount",
  "/computed",
  "/interpretation",
  "/invoice_id",
  "/missing",
  "/records",
  "/unique_codes",
  "/vendor",
];

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

async function snapshotGenerations(workspacePath) {
  const snapshots = [];
  const generationsPath = path.join(workspacePath, "generations");
  const generations = (await fs.readdir(generationsPath)).filter(name => name.startsWith("generation-"));
  expect(generations.length).toBeGreaterThan(0);
  for (const directory of generations) {
    const filenames = await fs.readdir(path.join(generationsPath, directory));
    expect(filenames.length).toBeGreaterThan(0);
    for (const filename of filenames) {
      const absolute = path.join(generationsPath, directory, filename);
      snapshots.push([absolute, await fs.readFile(absolute)]);
    }
  }
  return snapshots;
}

async function expectGenerationsUnchanged(snapshots) {
  expect(snapshots.length).toBeGreaterThan(0);
  for (const [filename, bytes] of snapshots) expect(await fs.readFile(filename)).toEqual(bytes);
}

describe("source-replayed verified extraction proposals", () => {
  let sourceBytes;
  let pdfjsLib;
  let layouts;
  let documentMap;
  let chunk;
  let parentPath;
  let rootPath;

  beforeAll(async () => {
    sourceBytes = await fs.readFile(SOURCE_PATH);
    pdfjsLib = await import("pdfjs-dist/legacy/build/pdf.mjs");
    layouts = [await extractPdfLayoutForMarkdown({
      pdfjsLib,
      pdfBytes: sourceBytes,
      sourcePath: SOURCE_PATH,
      sourceFileName: path.basename(SOURCE_PATH),
      sourceSha256: sha256(sourceBytes),
      requestedStartPage: 1,
      requestedEndPage: 1,
      maxItems: 5000,
      maxCharacters: 100000,
      maxOutputCharacters: 200000,
      deadlineMs: 20000,
    })];
    documentMap = buildSourceBoundDocumentMap({
      sourceBytes,
      schemaBytes: SCHEMA_BYTES,
      layouts,
    });
    chunk = readSourceBoundDocumentChunk({
      documentMap,
      chunkId: documentMap.chunks.descriptors[0].chunk_id,
      sourceBytes,
      schemaBytes: SCHEMA_BYTES,
      layouts,
    });
  }, 60000);

  beforeEach(async () => {
    parentPath = await fs.mkdtemp(path.join(os.tmpdir(), "pdf-tools-e9e5-"));
    parentPath = await fs.realpath(parentPath);
    await fs.chmod(parentPath, 0o700);
    rootPath = path.join(parentPath, "workspaces");
  });

  afterEach(async () => {
    await fs.rm(parentPath, { recursive: true, force: true });
  });

  async function create() {
    const created = await createExtractionWorkspace({
      rootPath,
      workspaceId: "proposal-verifier",
      documentMap,
      sourceBytes,
      schemaBytes: SCHEMA_BYTES,
      layouts,
      leafObligations: LEAVES,
      transactionId: "1".repeat(32),
    });
    const workspaceIdentity = JSON.parse(await fs.readFile(
      path.join(created.workspace_path, "workspace-identity.v1.json"),
      "utf8",
    ));
    return { ...created, workspaceIdentity };
  }

  async function append(created, {
    leafPointer,
    proposedValue,
    transactionId = "2".repeat(32),
    chunkIds = [chunk.chunk_id],
  }) {
    return appendUnverifiedWorkspaceProposal({
      rootPath,
      workspaceId: "proposal-verifier",
      expectedWorkspaceIdentitySha256: created.workspace_identity_sha256,
      expectedParentGenerationSha256: created.generation_sha256,
      leafPointer,
      proposedValue,
      chunkIds,
      transactionId,
    });
  }

  function citation(text, occurrence = 1) {
    return citationFromChunk(chunk, text, occurrence);
  }

  function citationFromChunk(sourceChunk, text, occurrence = 1) {
    const bytes = Buffer.from(sourceChunk.content, "utf8");
    const needle = Buffer.from(text, "utf8");
    let offset = -1;
    let from = 0;
    for (let index = 0; index < occurrence; index += 1) {
      offset = bytes.indexOf(needle, from);
      if (offset < 0) throw new Error(`Missing source quote: ${text}`);
      from = offset + needle.length;
    }
    return {
      chunk_id: sourceChunk.chunk_id,
      start_utf8_byte: offset,
      end_utf8_byte: offset + needle.length,
      quote_sha256: sha256(needle),
    };
  }

  async function createCustomProposal({
    customSourceBytes = sourceBytes,
    customLayouts = layouts,
    customSchemaBytes,
    leafPointer,
    proposedValue,
    createTransactionId = "8".repeat(32),
    appendTransactionId = "9".repeat(32),
  }) {
    const customMap = buildSourceBoundDocumentMap({
      sourceBytes: customSourceBytes,
      schemaBytes: customSchemaBytes,
      layouts: customLayouts,
    });
    const customChunk = readSourceBoundDocumentChunk({
      documentMap: customMap,
      chunkId: customMap.chunks.descriptors[0].chunk_id,
      sourceBytes: customSourceBytes,
      schemaBytes: customSchemaBytes,
      layouts: customLayouts,
    });
    const created = await createExtractionWorkspace({
      rootPath,
      workspaceId: "proposal-verifier",
      documentMap: customMap,
      sourceBytes: customSourceBytes,
      schemaBytes: customSchemaBytes,
      layouts: customLayouts,
      leafObligations: [leafPointer],
      transactionId: createTransactionId,
    });
    const workspaceIdentity = JSON.parse(await fs.readFile(
      path.join(created.workspace_path, "workspace-identity.v1.json"),
      "utf8",
    ));
    const appended = await appendUnverifiedWorkspaceProposal({
      rootPath,
      workspaceId: "proposal-verifier",
      expectedWorkspaceIdentitySha256: created.workspace_identity_sha256,
      expectedParentGenerationSha256: created.generation_sha256,
      leafPointer,
      proposedValue,
      chunkIds: [customChunk.chunk_id],
      transactionId: appendTransactionId,
    });
    return { created, appended, workspaceIdentity, customMap, customChunk };
  }

  const verify = (created, appended, overrides = {}) => verifyWorkspaceExtractionProposal({
    rootPath,
    workspaceId: "proposal-verifier",
    expectedWorkspaceIdentitySha256: created.workspace_identity_sha256,
    expectedGenerationSha256: appended.generation_sha256,
    workspaceIdentity: created.workspaceIdentity,
    proposalEventId: appended.event.event_id,
    documentMap,
    sourceBytes,
    schemaBytes: SCHEMA_BYTES,
    layouts,
    citations: [citation("INV-1001")],
    method: { kind: "exact_projection", citation_index: 0, normalization: "identity" },
    ...overrides,
  });

  it("replays an exact value from the immutable workspace and fresh source bytes", async () => {
    const created = await create();
    const appended = await append(created, { leafPointer: "/invoice_id", proposedValue: "INV-1001" });
    const result = await verify(created, appended);
    expect(validateExtractionProposalVerificationResult(result)).toBe(result);
    expect(result).toMatchObject({
      status: "verified_exact",
      leaf_pointer: "/invoice_id",
      derived_value: "INV-1001",
      source_replayed: true,
      schema_replayed: true,
      caller_text_accepted_as_proof: false,
      caller_geometry_accepted_as_proof: false,
      caller_confidence_accepted_as_proof: false,
      table_topology_proven: false,
      package_inclusion: "enabled_experimental",
    });
    expect(result.proposal_event).toEqual(appended.event);
    expect(result.citations[0]).toMatchObject({ quote: "INV-1001", status: "replayed", page: 1 });
    expect(SERVER_FILES).not.toContain("verified-extraction-proposal.mjs");
    expect(SHARE_FILES).toContain("scripts/verified-extraction-proposal.mjs");
  });

  it("compiles schema leaves and durably settles an exact verified result", async () => {
    expect(compileExtractionLeafObligations(SCHEMA_BYTES)).toEqual(LEAVES);
    const created = await create();
    const appended = await append(created, {
      leafPointer: "/invoice_id",
      proposedValue: "INV-1001",
    });
    const result = await verify(created, appended);
    const retained = await appendVerifiedWorkspaceResult({
      rootPath,
      workspaceId: "proposal-verifier",
      expectedWorkspaceIdentitySha256: created.workspace_identity_sha256,
      expectedParentGenerationSha256: appended.generation_sha256,
      verificationResult: result,
      transactionId: "3".repeat(32),
    });
    expect(retained).toMatchObject({
      generation_sequence: 2,
      result: { status: "verified_exact", leaf_pointer: "/invoice_id" },
    });
    const results = await readExtractionWorkspacePage({
      rootPath,
      workspaceId: "proposal-verifier",
      expectedWorkspaceIdentitySha256: created.workspace_identity_sha256,
      collection: "results",
      limit: 10,
    });
    expect(results.items).toEqual([result]);
    const pending = await readExtractionWorkspacePage({
      rootPath,
      workspaceId: "proposal-verifier",
      expectedWorkspaceIdentitySha256: created.workspace_identity_sha256,
      collection: "pending_leaves",
      limit: 20,
    });
    expect(pending.items).not.toContain("/invoice_id");
    expect(pending.counts.total).toBe(LEAVES.length - 1);
    await expect(appendVerifiedWorkspaceResult({
      rootPath,
      workspaceId: "proposal-verifier",
      expectedWorkspaceIdentitySha256: created.workspace_identity_sha256,
      expectedParentGenerationSha256: retained.generation_sha256,
      verificationResult: result,
      transactionId: "4".repeat(32),
    })).rejects.toThrow(/different workspace generation|already has/u);
  });

  it("replays typed decimal projection and exact rational calculations", async () => {
    const amountCreated = await create();
    const amount = await append(amountCreated, { leafPointer: "/amount", proposedValue: 42.5 });
    await expect(verify(amountCreated, amount, {
      citations: [citation("42.50")],
      method: { kind: "exact_projection", citation_index: 0, normalization: "decimal_ascii" },
    })).resolves.toMatchObject({ status: "verified_exact", derived_value: 42.5 });

    await fs.rm(parentPath, { recursive: true, force: true });
    parentPath = await fs.mkdtemp(path.join(os.tmpdir(), "pdf-tools-e9e5-"));
    parentPath = await fs.realpath(parentPath);
    await fs.chmod(parentPath, 0o700);
    rootPath = path.join(parentPath, "workspaces");
    const calculationCreated = await create();
    const calculation = await append(calculationCreated, {
      leafPointer: "/computed",
      proposedValue: 1043.5,
    });
    const calculated = await verify(calculationCreated, calculation, {
      citations: [citation("1001"), citation("42.50")],
      method: {
        kind: "calculation",
        operator: "sum",
        citation_indices: [0, 1],
        input_normalization: "decimal_ascii",
      },
    });
    expect(calculated).toMatchObject({
      status: "computed_with_inputs",
      calculation: { operator: "sum", result_fraction: { numerator: "2087", denominator: "2" } },
    });
    await expect(verify(calculationCreated, calculation, {
      citations: [citation("1001"), citation("42.50")],
      method: {
        kind: "calculation",
        operator: "difference",
        citation_indices: [0, 1],
        input_normalization: "decimal_ascii",
      },
    })).resolves.toMatchObject({
      status: "citation_mismatch",
      reason_codes: ["CALCULATION_RESULT_DOES_NOT_MATCH_PROPOSAL"],
    });
    await expect(verify(calculationCreated, calculation, {
      citations: [citation("42.50")],
      method: {
        kind: "calculation",
        operator: "sum",
        citation_indices: [0],
        input_normalization: "decimal_ascii",
      },
    })).rejects.toThrow(/calculation citation indices/u);
    await expect(verify(calculationCreated, calculation, {
      citations: [citation("42.50"), citation("0")],
      method: {
        kind: "calculation",
        operator: "quotient",
        citation_indices: [0, 1],
        input_normalization: "decimal_ascii",
      },
    })).rejects.toThrow(/divides by zero/u);
    const retainedCalculation = await appendVerifiedWorkspaceResult({
      rootPath, workspaceId: "proposal-verifier",
      expectedWorkspaceIdentitySha256: calculationCreated.workspace_identity_sha256,
      expectedParentGenerationSha256: calculation.generation_sha256,
      verificationResult: calculated, transactionId: "3".repeat(32),
    });
    await expect(append({ ...calculationCreated, generation_sha256: retainedCalculation.generation_sha256 }, {
      leafPointer: "/computed", proposedValue: 0, transactionId: "4".repeat(32),
    })).rejects.toThrow(/already settled/u);
  });

  it("bounds aggregate history before writes and recovers an entire batch after a commit-marker crash", async () => {
    const created = await create();
    const first = await append(created, { leafPointer: "/invoice_id", proposedValue: "INV-1001" });
    const second = await append({ ...created, generation_sha256: first.generation_sha256 }, {
      leafPointer: "/vendor", proposedValue: "Northwind Paper", transactionId: "3".repeat(32),
    });
    const results = await verifyWorkspaceExtractionBatch({
      rootPath, workspaceId: "proposal-verifier",
      expectedWorkspaceIdentitySha256: created.workspace_identity_sha256,
      expectedGenerationSha256: second.generation_sha256,
      workspaceIdentity: created.workspaceIdentity,
      documentMap, sourceBytes, schemaBytes: SCHEMA_BYTES, layouts,
      items: [
        { proposal_event_id: first.event.event_id, citations: [citation("INV-1001")],
          method: { kind: "exact_projection", citation_index: 0, normalization: "identity" } },
        { proposal_event_id: second.event.event_id, citations: [citation("Northwind Paper")],
          method: { kind: "source_supported", reason: "semantic label assignment" } },
      ],
    });
    const before = await snapshotGenerations(created.workspace_path);
    const total = before.reduce((sum, [, bytes]) => sum + bytes.length, 0);
    const readArgs = { rootPath, workspaceId: "proposal-verifier",
      expectedWorkspaceIdentitySha256: created.workspace_identity_sha256 };
    await expect(readExtractionReviewState({ ...readArgs, maxRetainedWorkspaceBytes: total }))
      .resolves.toMatchObject({ generation_sha256: second.generation_sha256 });
    await expect(readExtractionReviewState({ ...readArgs, maxRetainedWorkspaceBytes: total - 1 }))
      .rejects.toThrow(/retained workspace byte limit exceeded/);
    const appendArgs = { ...readArgs, expectedParentGenerationSha256: second.generation_sha256,
      verificationResults: results, transactionId: "4".repeat(32) };
    await expect(appendVerifiedWorkspaceResults({ ...appendArgs, maxRetainedWorkspaceBytes: total }))
      .rejects.toThrow(/retained workspace byte limit exceeded/);
    expect(await fs.readdir(created.workspace_path)).not.toContain("writer-claim.v1.json");
    expect(await snapshotGenerations(created.workspace_path)).toHaveLength(before.length);
    await expectGenerationsUnchanged(before);
    await expect(appendVerifiedWorkspaceResults({ ...appendArgs,
      faultInjector: phase => { if (phase === "after_commit_marker") throw new Error("batch crash"); },
    })).rejects.toThrow("batch crash");
    await expect(readExtractionReviewState(readArgs)).rejects.toThrow(/writer claim/);
    const recovered = await recoverExtractionWorkspace({ ...readArgs,
      transactionId: appendArgs.transactionId, action: "publish_if_complete" });
    expect(recovered.state).toBe("recovered_complete");
    const snapshot = await readExtractionReviewState(readArgs);
    expect(snapshot.generation_sequence).toBe(3);
    expect(snapshot.events.map(event => event.event_sequence)).toEqual([1, 2, 3, 4]);
    expect(snapshot.events.slice(-2).map(event => event.verification_result)).toEqual(results);
    expect(snapshot.current_state.pending_leaves).not.toContain("/invoice_id");
    expect(snapshot.current_state.pending_leaves).toContain("/vendor");
    await expectGenerationsUnchanged(before);
  });

  it("types semantic support, ambiguity, and unverified reasoning without promoting them", async () => {
    for (const scenario of [
      ["/vendor", "Northwind Paper", { kind: "source_supported", reason: "label association requires judgment" },
        "source_supported"],
      ["/ambiguous", "Northwind Paper", { kind: "ambiguous", reason: "two labels are plausible", alternative_count: 2 },
        "ambiguous"],
      ["/interpretation", "Northwind Paper", { kind: "unverified_reasoning", reason: "entity role is semantic" },
        "unverified_reasoning"],
    ]) {
      const created = await create();
      const appended = await append(created, { leafPointer: scenario[0], proposedValue: scenario[1] });
      await expect(verify(created, appended, {
        citations: [citation("Northwind Paper")],
        method: scenario[2],
      })).resolves.toMatchObject({ status: scenario[3], derived_value: null });
      await fs.rm(parentPath, { recursive: true, force: true });
      parentPath = await fs.mkdtemp(path.join(os.tmpdir(), "pdf-tools-e9e5-"));
      parentPath = await fs.realpath(parentPath);
      await fs.chmod(parentPath, 0o700);
      rootPath = path.join(parentPath, "workspaces");
    }
  });

  it("retains a complete-scope absence declaration as unverified reasoning", async () => {
    const created = await create();
    const appended = await append(created, {
      leafPointer: "/missing",
      proposedValue: null,
      chunkIds: documentMap.chunks.descriptors.map(item => item.chunk_id),
    });
    const result = await verify(created, appended, {
      citations: [],
      method: { kind: "not_found" },
    });
    expect(result).toMatchObject({
      status: "unverified_reasoning",
      reason_codes: ["ABSENCE_NOT_MECHANICALLY_PROVEN"],
      citations: [],
      derived_value: null,
      search_scope: {
        document_map_sha256: documentMap.document_map_sha256,
        chunks: {
          omitted: 0,
          omitted_content_utf8_bytes: 0,
          omitted_admitted_item_references: 0,
        },
      },
    });
    const driftedScope = structuredClone(result);
    driftedScope.search_scope.pages[0].needs_visual_inspection = true;
    const { verification_sha256: ignored, ...driftedScopeBody } = driftedScope;
    void ignored;
    driftedScope.verification_sha256 = sha256(Buffer.from(
      canonicalWorkspaceJson(driftedScopeBody), "utf8",
    ));
    expect(() => validateExtractionProposalVerificationResult(driftedScope))
      .toThrow(/search scope page is incomplete/u);
    const truncatedMap = structuredClone(documentMap);
    truncatedMap.chunks.omitted = 1;
    await expect(verify(created, appended, {
      documentMap: truncatedMap,
      citations: [],
      method: { kind: "not_found" },
    })).rejects.toThrow(/document map is stale|document-map digest/u);
  });

  it.each([
    { anyOf: [{ type: "string" }, { type: "string", minLength: 1 }] },
    { title: "Invoice identifier", anyOf: [
      { anyOf: [{ type: "string", minLength: 1 }, { type: "null" }] },
      { type: "string", maxLength: 20 },
    ] },
  ])("accepts overlapping anyOf branches for the same exact source value: %j", async leaf => {
    const schemaBytes = Buffer.from(JSON.stringify({
      type: "object", properties: { invoice_id: leaf },
    }), "utf8");
    const { created, appended, workspaceIdentity, customMap, customChunk } = await createCustomProposal({
      customSchemaBytes: schemaBytes, leafPointer: "/invoice_id", proposedValue: "INV-1001",
    });
    await expect(verifyWorkspaceExtractionProposal({
      rootPath, workspaceId: "proposal-verifier",
      expectedWorkspaceIdentitySha256: created.workspace_identity_sha256,
      expectedGenerationSha256: appended.generation_sha256,
      workspaceIdentity, proposalEventId: appended.event.event_id,
      documentMap: customMap, sourceBytes, schemaBytes, layouts,
      citations: [citationFromChunk(customChunk, "INV-1001")],
      method: { kind: "exact_projection", citation_index: 0, normalization: "identity" },
    })).resolves.toMatchObject({ status: "verified_exact", derived_value: "INV-1001" });
  });

  it("rejects an anyOf value that satisfies no branch", async () => {
    const schemaBytes = Buffer.from(JSON.stringify({
      type: "object", properties: { invoice_id: {
        anyOf: [{ type: "string", minLength: 20 }, { type: "null" }],
      } },
    }), "utf8");
    const { created, appended, workspaceIdentity, customMap, customChunk } = await createCustomProposal({
      customSchemaBytes: schemaBytes, leafPointer: "/invoice_id", proposedValue: "INV-1001",
    });
    await expect(verifyWorkspaceExtractionProposal({
      rootPath, workspaceId: "proposal-verifier",
      expectedWorkspaceIdentitySha256: created.workspace_identity_sha256,
      expectedGenerationSha256: appended.generation_sha256,
      workspaceIdentity, proposalEventId: appended.event.event_id,
      documentMap: customMap, sourceBytes, schemaBytes, layouts,
      citations: [citationFromChunk(customChunk, "INV-1001")],
      method: { kind: "exact_projection", citation_index: 0, normalization: "identity" },
    })).rejects.toThrow(/does not conform/u);
  });

  it.each([
    { type: "string" }, { minLength: 20 }, { enum: ["a different value"] },
    { pattern: "^different" }, { allOf: [{ type: "null" }] },
  ])("rejects unsupported anyOf sibling constraints rather than bypassing them: %j", sibling => {
    const schemaBytes = Buffer.from(JSON.stringify({
      type: "object", properties: { invoice_id: {
        anyOf: [{ type: "string" }, { type: "null" }], ...sibling,
      } },
    }), "utf8");
    expect(() => compileExtractionLeafObligations(schemaBytes)).toThrow(/keys are invalid/u);
  });

  it("does not prove absence of a present invoice and permits a source-cited correction", async () => {
    const schemaBytes = Buffer.from(JSON.stringify({
      type: "object", properties: { invoice_id: { anyOf: [{ type: "string" }, { type: "null" }] } },
    }), "utf8");
    const { created, appended, workspaceIdentity, customMap, customChunk } = await createCustomProposal({
      customSchemaBytes: schemaBytes, leafPointer: "/invoice_id", proposedValue: null,
    });
    expect(customChunk.content).toContain("INV-1001");
    const verifyInput = {
      rootPath, workspaceId: "proposal-verifier",
      expectedWorkspaceIdentitySha256: created.workspace_identity_sha256,
      expectedGenerationSha256: appended.generation_sha256,
      workspaceIdentity, proposalEventId: appended.event.event_id,
      documentMap: customMap, sourceBytes, schemaBytes, layouts,
      citations: [], method: { kind: "not_found" },
    };
    const result = await verifyWorkspaceExtractionProposal(verifyInput);
    expect(result).toMatchObject({
      contract: { version: "1.1.0-experimental" },
      status: "unverified_reasoning", reason_codes: ["ABSENCE_NOT_MECHANICALLY_PROVEN"],
      derived_value: null, source_replayed: true,
    });
    for (const mutate of [
      value => { value.status = "not_found"; value.reason_codes = []; },
      value => { value.status = "verified_exact"; },
      value => { value.reason_codes = []; },
      value => { value.search_scope = null; },
    ]) {
      const forged = structuredClone(result);
      mutate(forged);
      const { verification_sha256: ignored, ...body } = forged;
      void ignored;
      forged.verification_sha256 = sha256(Buffer.from(canonicalWorkspaceJson(body), "utf8"));
      expect(() => validateExtractionProposalVerificationResult(forged)).toThrow();
    }
    const retained = await appendVerifiedWorkspaceResult({
      rootPath, workspaceId: "proposal-verifier",
      expectedWorkspaceIdentitySha256: created.workspace_identity_sha256,
      expectedParentGenerationSha256: appended.generation_sha256,
      verificationResult: result, transactionId: "a".repeat(32),
    });
    const pendingInput = { rootPath, workspaceId: "proposal-verifier",
      expectedWorkspaceIdentitySha256: created.workspace_identity_sha256,
      collection: "pending_leaves", limit: 10 };
    expect((await readExtractionWorkspacePage(pendingInput)).items).toEqual(["/invoice_id"]);
    const corrected = await appendUnverifiedWorkspaceProposal({
      rootPath, workspaceId: "proposal-verifier",
      expectedWorkspaceIdentitySha256: created.workspace_identity_sha256,
      expectedParentGenerationSha256: retained.generation_sha256,
      leafPointer: "/invoice_id", proposedValue: "INV-1001",
      chunkIds: [customChunk.chunk_id], transactionId: "b".repeat(32),
    });
    const exact = await verifyWorkspaceExtractionProposal({
      ...verifyInput, expectedGenerationSha256: corrected.generation_sha256,
      proposalEventId: corrected.event.event_id,
      citations: [citationFromChunk(customChunk, "INV-1001")],
      method: { kind: "exact_projection", citation_index: 0, normalization: "identity" },
    });
    expect(exact.status).toBe("verified_exact");
    await appendVerifiedWorkspaceResult({
      rootPath, workspaceId: "proposal-verifier",
      expectedWorkspaceIdentitySha256: created.workspace_identity_sha256,
      expectedParentGenerationSha256: corrected.generation_sha256,
      verificationResult: exact, transactionId: "c".repeat(32),
    });
    expect((await readExtractionWorkspacePage(pendingInput)).items).toEqual([]);
    expect((await readExtractionWorkspacePage({ ...pendingInput, collection: "results" })).items)
      .toEqual([result, exact]);
  });

  it("rejects stale source, schema, layout, generation, and fabricated proposal bindings", async () => {
    const created = await create();
    const appended = await append(created, { leafPointer: "/invoice_id", proposedValue: "INV-1001" });
    await expect(verify(created, appended, {
      sourceBytes: Buffer.concat([sourceBytes, Buffer.from("\n% drift\n")]),
    })).rejects.toThrow(/document-map|source identity|stale|different inputs/u);
    await expect(verify(created, appended, {
      schemaBytes: Buffer.from(JSON.stringify({ type: "object" }), "utf8"),
    })).rejects.toThrow(/document-map|schema/u);
    const driftedLayouts = structuredClone(layouts);
    driftedLayouts[0].source.sha256 = "f".repeat(64);
    await expect(verify(created, appended, { layouts: driftedLayouts }))
      .rejects.toThrow(/layout source identity|document-map|source hash mismatch/u);
    await expect(verify(created, appended, { expectedGenerationSha256: "f".repeat(64) }))
      .rejects.toThrow(/exact complete current generation/u);
    await expect(verify(created, appended, { proposalEventId: `event.${"f".repeat(64)}` }))
      .rejects.toThrow(/absent from the exact workspace generation/u);
  });

  it("returns citation mismatch for forged, out-of-range, and value-mismatched evidence", async () => {
    const created = await create();
    const appended = await append(created, { leafPointer: "/invoice_id", proposedValue: "INV-1001" });
    const forged = citation("INV-1001");
    forged.quote_sha256 = "f".repeat(64);
    await expect(verify(created, appended, { citations: [forged] }))
      .resolves.toMatchObject({ status: "citation_mismatch" });
    const outside = citation("INV-1001");
    outside.end_utf8_byte = chunk.content_utf8_bytes + 1;
    await expect(verify(created, appended, { citations: [outside] }))
      .resolves.toMatchObject({ status: "citation_mismatch" });
    await expect(verify(created, appended, {
      citations: [citation("Northwind Paper")],
    })).resolves.toMatchObject({
      status: "citation_mismatch",
      reason_codes: ["PROPOSED_VALUE_DOES_NOT_REPLAY"],
    });
  });

  it("rejects duplicate citations, undeclared chunks, and concurrent leaf proposals", async () => {
    const created = await create();
    const first = await append(created, { leafPointer: "/invoice_id", proposedValue: "INV-1001" });
    const exact = citation("INV-1001");
    await expect(verify(created, first, { citations: [exact, exact] }))
      .rejects.toThrow(/duplicate entry/u);
    await expect(verify(created, first, {
      citations: [{ ...exact, chunk_id: `chunk.${"f".repeat(64)}` }],
    })).rejects.toThrow(/undeclared chunk/u);
    await expect(append({ ...created, generation_sha256: first.generation_sha256 }, {
      leafPointer: "/invoice_id",
      proposedValue: "INV-1001",
      transactionId: "3".repeat(32),
    })).rejects.toThrow(/unverified pending proposal/u);
  });

  it("allows a new exact proposal after a retained citation failure but not after settlement", async () => {
    const created = await create();
    const first = await append(created, { leafPointer: "/invoice_id", proposedValue: "INV-1001" });
    const forged = citation("INV-1001");
    forged.quote_sha256 = "f".repeat(64);
    const failedResult = await verify(created, first, { citations: [forged] });
    const failed = await appendVerifiedWorkspaceResult({
      rootPath,
      workspaceId: "proposal-verifier",
      expectedWorkspaceIdentitySha256: created.workspace_identity_sha256,
      expectedParentGenerationSha256: first.generation_sha256,
      verificationResult: failedResult,
      transactionId: "3".repeat(32),
    });
    const retry = await append({ ...created, generation_sha256: failed.generation_sha256 }, {
      leafPointer: "/invoice_id",
      proposedValue: "INV-1001",
      transactionId: "4".repeat(32),
    });
    const exactResult = await verify(created, retry);
    const settled = await appendVerifiedWorkspaceResult({
      rootPath,
      workspaceId: "proposal-verifier",
      expectedWorkspaceIdentitySha256: created.workspace_identity_sha256,
      expectedParentGenerationSha256: retry.generation_sha256,
      verificationResult: exactResult,
      transactionId: "5".repeat(32),
    });
    await expect(append({ ...created, generation_sha256: settled.generation_sha256 }, {
      leafPointer: "/invoice_id",
      proposedValue: "INV-1001",
      transactionId: "6".repeat(32),
    })).rejects.toThrow(/already settled/u);
  });

  it.each([
    { kind: "source_supported", reason: "field assignment still requires judgment" },
    { kind: "ambiguous", reason: "two assignments remain plausible", alternative_count: 2 },
    { kind: "unverified_reasoning", reason: "field assignment has not been checked" },
  ])("permits append-only correction after an uncertain %j result", async method => {
    const created = await create();
    const first = await append(created, { leafPointer: "/invoice_id", proposedValue: "Northwind Paper" });
    const uncertainResult = await verify(created, first, { citations: [citation("Northwind Paper")], method });
    const uncertain = await appendVerifiedWorkspaceResult({
      rootPath, workspaceId: "proposal-verifier",
      expectedWorkspaceIdentitySha256: created.workspace_identity_sha256,
      expectedParentGenerationSha256: first.generation_sha256,
      verificationResult: uncertainResult, transactionId: "3".repeat(32),
    });
    const snapshots = await snapshotGenerations(created.workspace_path);
    const readInput = { rootPath, workspaceId: "proposal-verifier",
      expectedWorkspaceIdentitySha256: created.workspace_identity_sha256, limit: 20 };
    expect((await readExtractionWorkspacePage({ ...readInput, collection: "pending_leaves" })).items)
      .toContain("/invoice_id");
    await expect(append({ ...created, generation_sha256: first.generation_sha256 }, {
      leafPointer: "/invoice_id", proposedValue: "INV-1001", transactionId: "4".repeat(32),
    })).rejects.toThrow(/exact expected parent/u);
    const retry = await append({ ...created, generation_sha256: uncertain.generation_sha256 }, {
      leafPointer: "/invoice_id", proposedValue: "INV-1001", transactionId: "4".repeat(32),
    });
    await expect(append({ ...created, generation_sha256: retry.generation_sha256 }, {
      leafPointer: "/invoice_id", proposedValue: "INV-1001", transactionId: "5".repeat(32),
    })).rejects.toThrow(/unverified pending proposal/u);
    const correctedResult = await verify(created, retry);
    const corrected = await appendVerifiedWorkspaceResult({
      rootPath, workspaceId: "proposal-verifier",
      expectedWorkspaceIdentitySha256: created.workspace_identity_sha256,
      expectedParentGenerationSha256: retry.generation_sha256,
      verificationResult: correctedResult, transactionId: "5".repeat(32),
    });
    expect((await readExtractionWorkspacePage({ ...readInput, collection: "results" })).items)
      .toEqual([uncertainResult, correctedResult]);
    expect((await readExtractionWorkspacePage({ ...readInput, collection: "pending_leaves" })).items)
      .not.toContain("/invoice_id");
    await expect(append({ ...created, generation_sha256: corrected.generation_sha256 }, {
      leafPointer: "/invoice_id", proposedValue: "different", transactionId: "6".repeat(32),
    })).rejects.toThrow(/already settled/u);
    await expectGenerationsUnchanged(snapshots);
  });

  it("preserves a legacy absence generation while permitting an append-only correction", async () => {
    const schemaBytes = Buffer.from(JSON.stringify({
      type: "object", properties: { invoice_id: { anyOf: [{ type: "string" }, { type: "null" }] } },
    }), "utf8");
    const { created, appended, workspaceIdentity, customMap, customChunk } = await createCustomProposal({
      customSchemaBytes: schemaBytes, leafPointer: "/invoice_id", proposedValue: null,
    });
    const current = await verifyWorkspaceExtractionProposal({
      rootPath, workspaceId: "proposal-verifier",
      expectedWorkspaceIdentitySha256: created.workspace_identity_sha256,
      expectedGenerationSha256: appended.generation_sha256,
      workspaceIdentity, proposalEventId: appended.event.event_id,
      documentMap: customMap, sourceBytes, schemaBytes, layouts,
      citations: [], method: { kind: "not_found" },
    });
    // Reproduce the exact pre-v1.1 result fields; the historical generation
    // must stay readable, not be rewritten with today's interpretation.
    const legacy = structuredClone(current);
    legacy.contract.version = "1.0.0-experimental";
    legacy.status = "not_found";
    legacy.reason_codes = [];
    legacy.claim_boundary = "Citations are reconstructed from fresh source-bound chunks. Exact projections and allowlisted calculations are mechanically replayed. Source-supported, ambiguous, and unverified-reasoning statuses preserve semantic uncertainty. Caller text, geometry, confidence, and table topology are never accepted as proof.";
    const { verification_sha256: ignored, ...legacyBody } = legacy;
    void ignored;
    legacy.verification_sha256 = sha256(Buffer.from(canonicalWorkspaceJson(legacyBody), "utf8"));
    expect(() => validateExtractionProposalVerificationResult(legacy)).toThrow(/contract is unsupported/u);
    const retained = await appendVerifiedWorkspaceResult({
      rootPath, workspaceId: "proposal-verifier",
      expectedWorkspaceIdentitySha256: created.workspace_identity_sha256,
      expectedParentGenerationSha256: appended.generation_sha256,
      verificationResult: legacy, transactionId: "a".repeat(32),
    });
    const readInput = { rootPath, workspaceId: "proposal-verifier",
      expectedWorkspaceIdentitySha256: created.workspace_identity_sha256, limit: 20 };
    expect((await readExtractionWorkspacePage({ ...readInput, collection: "pending_leaves" })).items)
      .toEqual([]);
    const snapshots = await snapshotGenerations(created.workspace_path);
    await appendUnverifiedWorkspaceProposal({
      rootPath, workspaceId: "proposal-verifier",
      expectedWorkspaceIdentitySha256: created.workspace_identity_sha256,
      expectedParentGenerationSha256: retained.generation_sha256,
      leafPointer: "/invoice_id", proposedValue: "INV-1001",
      chunkIds: [customChunk.chunk_id], transactionId: "b".repeat(32),
    });
    expect((await readExtractionWorkspacePage({ ...readInput, collection: "pending_leaves" })).items)
      .toEqual(["/invoice_id"]);
    expect((await readExtractionWorkspacePage({ ...readInput, collection: "results" })).items)
      .toEqual([legacy]);
    await expectGenerationsUnchanged(snapshots);
  });

  it("rejects schema-invalid arrays and does not let caller metadata or table claims become proof", async () => {
    const created = await create();
    const appended = await append(created, {
      leafPointer: "/unique_codes",
      proposedValue: ["INV-1001", "INV-1001"],
    });
    await expect(verify(created, appended)).rejects.toThrow(/does not conform/u);

    await fs.rm(parentPath, { recursive: true, force: true });
    parentPath = await fs.mkdtemp(path.join(os.tmpdir(), "pdf-tools-e9e5-"));
    parentPath = await fs.realpath(parentPath);
    await fs.chmod(parentPath, 0o700);
    rootPath = path.join(parentPath, "workspaces");
    const keyedCreated = await create();
    const keyed = await append(keyedCreated, {
      leafPointer: "/records",
      proposedValue: [{ code: "A", value: 1 }, { code: "A", value: 2 }],
    });
    await expect(verify(keyedCreated, keyed)).rejects.toThrow(/does not conform/u);

    await fs.rm(parentPath, { recursive: true, force: true });
    parentPath = await fs.mkdtemp(path.join(os.tmpdir(), "pdf-tools-e9e5-"));
    parentPath = await fs.realpath(parentPath);
    await fs.chmod(parentPath, 0o700);
    rootPath = path.join(parentPath, "workspaces");
    const cleanCreated = await create();
    const clean = await append(cleanCreated, { leafPointer: "/invoice_id", proposedValue: "INV-1001" });
    await expect(verify(cleanCreated, clean, {
      citations: [{ ...citation("INV-1001"), quote: "INV-1001" }],
    })).rejects.toThrow(/keys are invalid/u);
    await expect(verify(cleanCreated, clean, {
      method: {
        kind: "exact_projection",
        citation_index: 0,
        normalization: "identity",
        confidence: 1,
      },
    })).rejects.toThrow(/keys are invalid/u);
    await expect(verify(cleanCreated, clean, {
      method: {
        kind: "exact_projection",
        citation_index: 0,
        normalization: "identity",
        table_topology: "accepted",
      },
    })).rejects.toThrow(/keys are invalid/u);
  });

  it("rejects duplicate JSON schema members and unsupported schema semantics", async () => {
    const duplicateSchemaBytes = Buffer.from(
      "{\"type\":\"object\",\"properties\":{\"invoice_id\":{\"type\":\"string\"}},"
      + "\"properties\":{\"invoice_id\":{\"type\":\"string\"}}}",
      "utf8",
    );
    const duplicateMap = buildSourceBoundDocumentMap({
      sourceBytes,
      schemaBytes: duplicateSchemaBytes,
      layouts,
    });
    const duplicateChunk = readSourceBoundDocumentChunk({
      documentMap: duplicateMap,
      chunkId: duplicateMap.chunks.descriptors[0].chunk_id,
      sourceBytes,
      schemaBytes: duplicateSchemaBytes,
      layouts,
    });
    const created = await createExtractionWorkspace({
      rootPath,
      workspaceId: "proposal-verifier",
      documentMap: duplicateMap,
      sourceBytes,
      schemaBytes: duplicateSchemaBytes,
      layouts,
      leafObligations: ["/invoice_id"],
      transactionId: "4".repeat(32),
    });
    const workspaceIdentity = JSON.parse(await fs.readFile(
      path.join(created.workspace_path, "workspace-identity.v1.json"),
      "utf8",
    ));
    const appended = await appendUnverifiedWorkspaceProposal({
      rootPath,
      workspaceId: "proposal-verifier",
      expectedWorkspaceIdentitySha256: created.workspace_identity_sha256,
      expectedParentGenerationSha256: created.generation_sha256,
      leafPointer: "/invoice_id",
      proposedValue: "INV-1001",
      chunkIds: [duplicateChunk.chunk_id],
      transactionId: "5".repeat(32),
    });
    await expect(verifyWorkspaceExtractionProposal({
      rootPath,
      workspaceId: "proposal-verifier",
      expectedWorkspaceIdentitySha256: created.workspace_identity_sha256,
      expectedGenerationSha256: appended.generation_sha256,
      workspaceIdentity,
      proposalEventId: appended.event.event_id,
      documentMap: duplicateMap,
      sourceBytes,
      schemaBytes: duplicateSchemaBytes,
      layouts,
      citations: [],
      method: { kind: "not_found" },
    })).rejects.toThrow(/duplicate object key/u);

    await fs.rm(parentPath, { recursive: true, force: true });
    parentPath = await fs.mkdtemp(path.join(os.tmpdir(), "pdf-tools-e9e5-"));
    parentPath = await fs.realpath(parentPath);
    await fs.chmod(parentPath, 0o700);
    rootPath = path.join(parentPath, "workspaces");
    const unsupportedSchemaBytes = Buffer.from(JSON.stringify({
      type: "object",
      properties: { invoice_id: { type: "string", pattern: "^INV-" } },
    }), "utf8");
    const unsupportedMap = buildSourceBoundDocumentMap({
      sourceBytes,
      schemaBytes: unsupportedSchemaBytes,
      layouts,
    });
    const unsupportedChunk = unsupportedMap.chunks.descriptors[0].chunk_id;
    const unsupportedCreated = await createExtractionWorkspace({
      rootPath,
      workspaceId: "proposal-verifier",
      documentMap: unsupportedMap,
      sourceBytes,
      schemaBytes: unsupportedSchemaBytes,
      layouts,
      leafObligations: ["/invoice_id"],
      transactionId: "6".repeat(32),
    });
    const unsupportedIdentity = JSON.parse(await fs.readFile(
      path.join(unsupportedCreated.workspace_path, "workspace-identity.v1.json"),
      "utf8",
    ));
    const unsupportedProposal = await appendUnverifiedWorkspaceProposal({
      rootPath,
      workspaceId: "proposal-verifier",
      expectedWorkspaceIdentitySha256: unsupportedCreated.workspace_identity_sha256,
      expectedParentGenerationSha256: unsupportedCreated.generation_sha256,
      leafPointer: "/invoice_id",
      proposedValue: "INV-1001",
      chunkIds: [unsupportedChunk],
      transactionId: "7".repeat(32),
    });
    await expect(verifyWorkspaceExtractionProposal({
      rootPath,
      workspaceId: "proposal-verifier",
      expectedWorkspaceIdentitySha256: unsupportedCreated.workspace_identity_sha256,
      expectedGenerationSha256: unsupportedProposal.generation_sha256,
      workspaceIdentity: unsupportedIdentity,
      proposalEventId: unsupportedProposal.event.event_id,
      documentMap: unsupportedMap,
      sourceBytes,
      schemaBytes: unsupportedSchemaBytes,
      layouts,
      citations: [citation("INV-1001")],
      method: { kind: "exact_projection", citation_index: 0, normalization: "identity" },
    })).rejects.toThrow(/schema node.*keys are invalid/u);
  });

  it("uses Unicode code-point lengths and rejects inexact schema-number constraints", async () => {
    const unicodeSchemaBytes = Buffer.from(JSON.stringify({
      type: "object",
      additionalProperties: false,
      properties: { emoji: { type: "string", minLength: 2 } },
    }), "utf8");
    const unicode = await createCustomProposal({
      customSchemaBytes: unicodeSchemaBytes,
      leafPointer: "/emoji",
      proposedValue: "😀",
    });
    await expect(verifyWorkspaceExtractionProposal({
      rootPath,
      workspaceId: "proposal-verifier",
      expectedWorkspaceIdentitySha256: unicode.created.workspace_identity_sha256,
      expectedGenerationSha256: unicode.appended.generation_sha256,
      workspaceIdentity: unicode.workspaceIdentity,
      proposalEventId: unicode.appended.event.event_id,
      documentMap: unicode.customMap,
      sourceBytes,
      schemaBytes: unicodeSchemaBytes,
      layouts,
      citations: [citationFromChunk(unicode.customChunk, "INV-1001")],
      method: { kind: "source_supported", reason: "semantic assignment remains unverified" },
    })).rejects.toThrow(/does not conform/u);

    await fs.rm(parentPath, { recursive: true, force: true });
    parentPath = await fs.mkdtemp(path.join(os.tmpdir(), "pdf-tools-e9e5-"));
    parentPath = await fs.realpath(parentPath);
    await fs.chmod(parentPath, 0o700);
    rootPath = path.join(parentPath, "workspaces");
    const unsafeSchemaBytes = Buffer.from(
      "{\"type\":\"object\",\"additionalProperties\":false,\"properties\":{"
        + "\"amount\":{\"type\":\"number\",\"minimum\":9007199254740993}}}",
      "utf8",
    );
    const unsafe = await createCustomProposal({
      customSchemaBytes: unsafeSchemaBytes,
      leafPointer: "/amount",
      proposedValue: 9007199254740992,
      createTransactionId: "a".repeat(32),
      appendTransactionId: "b".repeat(32),
    });
    await expect(verifyWorkspaceExtractionProposal({
      rootPath,
      workspaceId: "proposal-verifier",
      expectedWorkspaceIdentitySha256: unsafe.created.workspace_identity_sha256,
      expectedGenerationSha256: unsafe.appended.generation_sha256,
      workspaceIdentity: unsafe.workspaceIdentity,
      proposalEventId: unsafe.appended.event.event_id,
      documentMap: unsafe.customMap,
      sourceBytes,
      schemaBytes: unsafeSchemaBytes,
      layouts,
      citations: [citationFromChunk(unsafe.customChunk, "INV-1001")],
      method: { kind: "source_supported", reason: "semantic assignment remains unverified" },
    })).rejects.toThrow(/exact safe-integer subset|minimum is invalid/u);

    for (const [rawConstraint, proposedValue] of [
      ["\"minimum\":1.0000000000000001", 1],
      ["\"const\":1.0000000000000001", 1],
      ["\"enum\":[1e-324]", 0],
      ["\"maximum\":1e0", 1],
      ["\"minimum\":-0", 0],
    ]) {
      await fs.rm(parentPath, { recursive: true, force: true });
      parentPath = await fs.mkdtemp(path.join(os.tmpdir(), "pdf-tools-e9e5-"));
      parentPath = await fs.realpath(parentPath);
      await fs.chmod(parentPath, 0o700);
      rootPath = path.join(parentPath, "workspaces");
      const rawSchemaBytes = Buffer.from(
        `{"type":"object","additionalProperties":false,"properties":{`
          + `"amount":{"type":"number",${rawConstraint}}}}`,
        "utf8",
      );
      const raw = await createCustomProposal({
        customSchemaBytes: rawSchemaBytes,
        leafPointer: "/amount",
        proposedValue,
      });
      await expect(verifyWorkspaceExtractionProposal({
        rootPath,
        workspaceId: "proposal-verifier",
        expectedWorkspaceIdentitySha256: raw.created.workspace_identity_sha256,
        expectedGenerationSha256: raw.appended.generation_sha256,
        workspaceIdentity: raw.workspaceIdentity,
        proposalEventId: raw.appended.event.event_id,
        documentMap: raw.customMap,
        sourceBytes,
        schemaBytes: rawSchemaBytes,
        layouts,
        citations: [citationFromChunk(raw.customChunk, "INV-1001")],
        method: { kind: "source_supported", reason: "semantic assignment remains unverified" },
      })).rejects.toThrow(/non-canonical or inexact numeric token/u);
    }
  }, 30_000);

  it("never promotes a lossy decimal projection to verified exact", async () => {
    const document = await PDFDocument.create();
    const page = document.addPage([612, 792]);
    const font = await document.embedFont(StandardFonts.Helvetica);
    page.drawText("0.10000000000000001", { x: 72, y: 720, size: 12, font });
    const decimalSourceBytes = Buffer.from(await document.save({
      useObjectStreams: false,
      addDefaultPage: false,
      updateFieldAppearances: false,
    }));
    const decimalSourceSha256 = sha256(decimalSourceBytes);
    const decimalSourcePath = "/synthetic/e9e5-exact-decimal.pdf";
    const decimalLayouts = [await extractPdfLayoutForMarkdown({
      pdfjsLib,
      pdfBytes: decimalSourceBytes,
      sourcePath: decimalSourcePath,
      sourceFileName: path.basename(decimalSourcePath),
      sourceSha256: decimalSourceSha256,
      requestedStartPage: 1,
      requestedEndPage: 1,
      maxItems: 5000,
      maxCharacters: 100000,
      maxOutputCharacters: 200000,
      deadlineMs: 20000,
    })];
    const decimalSchemaBytes = Buffer.from(JSON.stringify({
      type: "object",
      additionalProperties: false,
      properties: { amount: { type: "number" } },
    }), "utf8");
    const decimal = await createCustomProposal({
      customSourceBytes: decimalSourceBytes,
      customLayouts: decimalLayouts,
      customSchemaBytes: decimalSchemaBytes,
      leafPointer: "/amount",
      proposedValue: 0.1,
      createTransactionId: "c".repeat(32),
      appendTransactionId: "d".repeat(32),
    });
    await expect(verifyWorkspaceExtractionProposal({
      rootPath,
      workspaceId: "proposal-verifier",
      expectedWorkspaceIdentitySha256: decimal.created.workspace_identity_sha256,
      expectedGenerationSha256: decimal.appended.generation_sha256,
      workspaceIdentity: decimal.workspaceIdentity,
      proposalEventId: decimal.appended.event.event_id,
      documentMap: decimal.customMap,
      sourceBytes: decimalSourceBytes,
      schemaBytes: decimalSchemaBytes,
      layouts: decimalLayouts,
      citations: [citationFromChunk(decimal.customChunk, "0.10000000000000001")],
      method: { kind: "exact_projection", citation_index: 0, normalization: "decimal_ascii" },
    })).resolves.toMatchObject({
      status: "citation_mismatch",
      reason_codes: ["PROPOSED_VALUE_DOES_NOT_REPLAY"],
      derived_value: null,
    });
  });

  it("binds every returned field in a tamper-evident canonical result digest", async () => {
    const created = await create();
    const appended = await append(created, { leafPointer: "/invoice_id", proposedValue: "INV-1001" });
    const result = await verify(created, appended);
    for (const mutate of [
      value => { value.status = "source_supported"; },
      value => { value.citations[0].quote = "forged"; },
      value => { value.generation_sha256 = "f".repeat(64); },
      value => { value.caller_confidence_accepted_as_proof = true; },
    ]) {
      const changed = structuredClone(result);
      mutate(changed);
      expect(() => validateExtractionProposalVerificationResult(changed)).toThrow();
    }

    const resign = changed => {
      const { verification_sha256: ignored, ...body } = changed;
      void ignored;
      changed.verification_sha256 = sha256(Buffer.from(canonicalWorkspaceJson(body), "utf8"));
      return changed;
    };
    const forgedDerived = structuredClone(result);
    forgedDerived.derived_value = "FORGED";
    expect(() => validateExtractionProposalVerificationResult(resign(forgedDerived)))
      .toThrow(/deterministically replay/u);
    const impossibleFailure = structuredClone(result);
    impossibleFailure.status = "chunk_missing";
    impossibleFailure.reason_codes = ["FORGED_CHUNK_FAILURE"];
    expect(() => validateExtractionProposalVerificationResult(resign(impossibleFailure)))
      .toThrow(/chunk-missing result semantics/u);
    const duplicateCitation = structuredClone(result);
    duplicateCitation.citations.push(structuredClone(duplicateCitation.citations[0]));
    expect(() => validateExtractionProposalVerificationResult(resign(duplicateCitation)))
      .toThrow(/duplicate binding/u);
    const impossibleRange = structuredClone(result);
    impossibleRange.citations[0].end_utf8_byte += 1;
    expect(() => validateExtractionProposalVerificationResult(resign(impossibleRange)))
      .toThrow(/replay is invalid/u);

    const reauthoredProposal = structuredClone(result);
    reauthoredProposal.proposed_value = "Northwind Paper";
    reauthoredProposal.proposed_value_sha256 = sha256(Buffer.from(
      canonicalWorkspaceJson(reauthoredProposal.proposed_value), "utf8",
    ));
    reauthoredProposal.citations[0].quote = "Northwind Paper";
    reauthoredProposal.citations[0].quote_sha256 = sha256(Buffer.from("Northwind Paper", "utf8"));
    reauthoredProposal.citations[0].end_utf8_byte = reauthoredProposal.citations[0].start_utf8_byte
      + Buffer.byteLength("Northwind Paper", "utf8");
    reauthoredProposal.derived_value = "Northwind Paper";
    expect(() => validateExtractionProposalVerificationResult(resign(reauthoredProposal)))
      .toThrow(/proposed value drifted from its event/u);

    const reauthoredEvent = structuredClone(result);
    reauthoredEvent.proposal_event.proposed_value = "Northwind Paper";
    expect(() => validateExtractionProposalVerificationResult(resign(reauthoredEvent)))
      .toThrow(/proposal event ID does not replay/u);

    const reasonDrift = structuredClone(result);
    const replayed = reasonDrift.citations[0];
    reasonDrift.status = "citation_mismatch";
    reasonDrift.reason_codes = ["FORGED_REASON"];
    reasonDrift.citations = [{
      status: "citation_mismatch",
      citation: {
        chunk_id: replayed.chunk_id,
        start_utf8_byte: replayed.start_utf8_byte,
        end_utf8_byte: replayed.end_utf8_byte,
        quote_sha256: replayed.quote_sha256,
      },
      error: "actual replay failure",
    }];
    reasonDrift.derived_value = null;
    expect(() => validateExtractionProposalVerificationResult(resign(reasonDrift)))
      .toThrow(/deterministically replay/u);

    const unreachableChunkFailure = structuredClone(reasonDrift);
    unreachableChunkFailure.status = "chunk_missing";
    unreachableChunkFailure.reason_codes = ["missing chunk"];
    unreachableChunkFailure.citations[0].status = "chunk_missing";
    unreachableChunkFailure.citations[0].error = "missing chunk";
    unreachableChunkFailure.method = { kind: "not_found" };
    expect(() => validateExtractionProposalVerificationResult(resign(unreachableChunkFailure)))
      .toThrow(/deterministically replay|chunk-missing result semantics|unverified absence result semantics/u);

    await fs.rm(parentPath, { recursive: true, force: true });
    parentPath = await fs.mkdtemp(path.join(os.tmpdir(), "pdf-tools-e9e5-"));
    parentPath = await fs.realpath(parentPath);
    await fs.chmod(parentPath, 0o700);
    rootPath = path.join(parentPath, "workspaces");
    const calculationCreated = await create();
    const calculationProposal = await append(calculationCreated, {
      leafPointer: "/computed",
      proposedValue: 1043.5,
    });
    const calculationResult = await verify(calculationCreated, calculationProposal, {
      citations: [citation("1001"), citation("42.50")],
      method: {
        kind: "calculation",
        operator: "sum",
        citation_indices: [0, 1],
        input_normalization: "decimal_ascii",
      },
    });
    calculationResult.derived_value = 7;
    calculationResult.calculation.operator = "product";
    calculationResult.calculation.result_fraction = { numerator: "7", denominator: "1" };
    expect(() => validateExtractionProposalVerificationResult(resign(calculationResult)))
      .toThrow(/deterministically replay/u);
  });
});
