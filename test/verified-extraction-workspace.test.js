import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { SHARE_FILES } from "../package-for-friend.js";
import { SERVER_FILES } from "../scripts/build-mcpb.mjs";
import {
  abandonExtractionWorkspaceDeletionIntent,
  abandonExtractionWorkspaceInitialization,
  appendUnverifiedWorkspaceProposal,
  canonicalWorkspaceJson,
  completeExtractionWorkspaceDeletion,
  createExtractionWorkspace,
  DEFAULT_EXTRACTION_WORKSPACE_POLICY,
  deleteExtractionWorkspace,
  inspectExtractionWorkspace,
  readExtractionWorkspacePage,
  recoverExtractionWorkspace,
  sameWorkspaceDirectoryIdentityForPlatform,
  sameWorkspaceFileIdentityForPlatform,
  workspaceDirectoryFsyncSupportedForPlatform,
  workspacePrivateModeMatchesForPlatform,
} from "../scripts/verified-extraction-workspace.mjs";
import {
  buildSourceBoundDocumentMap,
  DEFAULT_DOCUMENT_MAP_CHUNK_POLICY,
} from "../server/document-map.js";
import { extractPdfLayoutForMarkdown } from "../server/layout-extraction.js";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const SOURCE_PATH = path.join(
  REPO_ROOT,
  "test/fixtures/eval/extraction/synthetic/mixed-text-raster.pdf",
);
const SCHEMA_BYTES = Buffer.from(JSON.stringify({
  type: "object",
  additionalProperties: false,
  properties: {
    agency: { type: "string" },
    amount: { type: "number" },
  },
  required: ["agency", "amount"],
}), "utf8");
const LEAVES = ["/agency", "/amount"];
const GENESIS_TX = "1".repeat(32);

function portableWorkspaceStat(overrides = {}) {
  return {
    dev: 41n,
    ino: 9001n,
    size: 1024n,
    mode: 0o100600n,
    nlink: 1n,
    mtimeNs: 123456789n,
    ctimeNs: 123456780n,
    birthtimeNs: 123456700n,
    uid: 501n,
    gid: 20n,
    ...overrides,
  };
}

describe("verified extraction platform filesystem contracts", () => {
  it("separates mutable directory entries from the retained-file identity guard", () => {
    const before = portableWorkspaceStat({ mode: 0o40700n });
    const after = { ...before, size: 4096n, nlink: 4n, mtimeNs: 999n, ctimeNs: 1000n };
    for (const platform of ["darwin", "linux", "win32"]) {
      expect(sameWorkspaceDirectoryIdentityForPlatform(before, after, platform)).toBe(true);
      expect(sameWorkspaceFileIdentityForPlatform(before, after, platform)).toBe(false);
      for (const drift of [
        { dev: 42n }, { ino: 9002n }, { mode: 0o40755n },
        { uid: 502n }, { gid: 21n }, { birthtimeNs: 123456701n },
      ]) {
        expect(sameWorkspaceDirectoryIdentityForPlatform(before, { ...after, ...drift }, platform))
          .toBe(false);
      }
    }
    expect(sameWorkspaceDirectoryIdentityForPlatform(
      { ...before, dev: 0n }, { ...after, dev: 2660852064n }, "win32",
    )).toBe(true);
    expect(sameWorkspaceDirectoryIdentityForPlatform(
      { ...before, dev: 0n }, { ...after, dev: 2660852064n, birthtimeNs: 1n }, "win32",
    )).toBe(false);
  });
  it("uses NTFS physical identity facts when POSIX device and mode bits are unavailable", () => {
    expect(workspaceDirectoryFsyncSupportedForPlatform("win32")).toBe(false);
    expect(workspaceDirectoryFsyncSupportedForPlatform("darwin")).toBe(true);
    expect(workspacePrivateModeMatchesForPlatform(
      portableWorkspaceStat({ mode: 0o100666n }),
      0o600,
      "win32",
    )).toBe(true);
    expect(workspacePrivateModeMatchesForPlatform(
      portableWorkspaceStat({ mode: 0o100666n }),
      0o600,
      "linux",
    )).toBe(false);
    expect(sameWorkspaceFileIdentityForPlatform(
      portableWorkspaceStat({ dev: 0n }),
      portableWorkspaceStat({ dev: 2660852064n }),
      "win32",
    )).toBe(true);
  });

  it("rejects Windows fallback identity drift and nonzero volume substitution", () => {
    const pathname = portableWorkspaceStat({ dev: 0n });
    const descriptor = portableWorkspaceStat({ dev: 2660852064n });
    for (const drift of [
      { ino: 9002n },
      { size: 1025n },
      { mode: 0o100644n },
      { nlink: 2n },
      { mtimeNs: 123456790n },
      { ctimeNs: 123456781n },
      { birthtimeNs: 123456701n },
    ]) {
      expect(sameWorkspaceFileIdentityForPlatform(
        pathname,
        { ...descriptor, ...drift },
        "win32",
      )).toBe(false);
    }
    expect(sameWorkspaceFileIdentityForPlatform(
      portableWorkspaceStat({ dev: 41n }),
      portableWorkspaceStat({ dev: 42n }),
      "win32",
    )).toBe(false);
  });
});

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

function canonicalBytes(value) {
  return Buffer.from(`${canonicalWorkspaceJson(value)}\n`, "utf8");
}

function generationSha256(manifestBytes) {
  return sha256(Buffer.concat([
    Buffer.from("pdf-tools.verified-extraction-workspace-generation.v1\0", "utf8"),
    manifestBytes,
  ]));
}

async function physicalMode(filename) {
  return (await fs.lstat(filename)).mode & 0o777;
}

async function readJson(filename) {
  return JSON.parse(await fs.readFile(filename, "utf8"));
}

async function workspaceFromRoot(rootPath) {
  const names = await fs.readdir(rootPath);
  const [pointerName] = names.filter(item => item.startsWith("workspace-")
    && item.endsWith(".pointer.v1.json"));
  expect(pointerName).toBeTruthy();
  const pointer = await readJson(path.join(rootPath, pointerName));
  const workspacePath = path.join(rootPath, pointer.workspace_directory_name);
  const identity = await readJson(path.join(workspacePath, "workspace-identity.v1.json"));
  return { workspacePath, identity, pointerName, pointer };
}

async function creatorAuthority(rootPath, workspaceId, transactionId) {
  const stem = sha256(Buffer.from(`${workspaceId}\0${transactionId}`, "utf8"));
  const filename = path.join(rootPath, `.creator-${stem}.creator-claim.v1.json`);
  const bytes = await fs.readFile(filename);
  const claim = JSON.parse(bytes.toString("utf8"));
  return {
    filename,
    claim,
    expectedInitializationWorkspaceIdentitySha256: claim.workspace_identity_sha256,
    expectedCreatorClaimSha256: sha256(bytes),
  };
}

async function initializationAbandonmentAuthority(rootPath, workspaceId, transactionId) {
  const authority = await creatorAuthority(rootPath, workspaceId, transactionId);
  return {
    expectedInitializationWorkspaceIdentitySha256:
      authority.expectedInitializationWorkspaceIdentitySha256,
    expectedCreatorClaimSha256: authority.expectedCreatorClaimSha256,
  };
}

async function assertPrivateTree(directory) {
  expect(await physicalMode(directory)).toBe(0o700);
  for (const entry of await fs.readdir(directory, { withFileTypes: true })) {
    const filename = path.join(directory, entry.name);
    expect(entry.isSymbolicLink()).toBe(false);
    if (entry.isDirectory()) await assertPrivateTree(filename);
    else {
      expect(entry.isFile()).toBe(true);
      expect(await physicalMode(filename)).toBe(0o600);
    }
  }
}

describe("transactional verified extraction workspace", () => {
  let sourceBytes;
  let layouts;
  let documentMap;
  let parentPath;
  let rootPath;

  beforeAll(async () => {
    sourceBytes = await fs.readFile(SOURCE_PATH);
    const pdfjsLib = await import("pdfjs-dist/legacy/build/pdf.mjs");
    const sourceSha256 = sha256(sourceBytes);
    layouts = [];
    for (const page of [1, 2]) {
      layouts.push(await extractPdfLayoutForMarkdown({
        pdfjsLib,
        pdfBytes: sourceBytes,
        sourcePath: SOURCE_PATH,
        sourceFileName: path.basename(SOURCE_PATH),
        sourceSha256,
        requestedStartPage: page,
        requestedEndPage: page,
        maxItems: 5000,
        maxCharacters: 100000,
        maxOutputCharacters: 200000,
        deadlineMs: 20000,
      }));
    }
    documentMap = buildSourceBoundDocumentMap({
      sourceBytes,
      schemaBytes: SCHEMA_BYTES,
      layouts,
    });
  }, 60000);

  beforeEach(async () => {
    parentPath = await fs.mkdtemp(path.join(os.tmpdir(), "pdf-tools-e9e4-"));
    parentPath = await fs.realpath(parentPath);
    await fs.chmod(parentPath, 0o700);
    rootPath = path.join(parentPath, "private-workspaces");
  });

  afterEach(async () => {
    await fs.rm(parentPath, { recursive: true, force: true });
  });

  const create = (overrides = {}) => createExtractionWorkspace({
    rootPath,
    workspaceId: "test-workspace",
    documentMap,
    sourceBytes,
    schemaBytes: SCHEMA_BYTES,
    layouts,
    leafObligations: LEAVES,
    transactionId: GENESIS_TX,
    ...overrides,
  });

  const append = (created, overrides = {}) => appendUnverifiedWorkspaceProposal({
    rootPath,
    workspaceId: "test-workspace",
    expectedWorkspaceIdentitySha256: created.workspace_identity_sha256,
    expectedParentGenerationSha256: created.generation_sha256,
    leafPointer: "/agency",
    proposedValue: "Office of Example Programs",
    chunkIds: [documentMap.chunks.descriptors[0].chunk_id],
    transactionId: "2".repeat(32),
    ...overrides,
  });

  it("creates a private source/schema-bound genesis with an experimental package identity", async () => {
    const created = await create();
    expect(created).toMatchObject({ state: "complete", generation_sequence: 0 });
    const inspection = await inspectExtractionWorkspace({
      rootPath,
      workspaceId: "test-workspace",
      expectedWorkspaceIdentitySha256: created.workspace_identity_sha256,
    });
    expect(inspection).toMatchObject({
      state: "complete",
      current_generation_sha256: created.generation_sha256,
      current_generation_sequence: 0,
      complete_generations: 1,
      incomplete_generations: [],
      active_transaction_id: null,
      retention: { automatic_pruning: false, deletion_requires_exact_current_generation: true },
    });
    expect(SERVER_FILES).not.toContain("verified-extraction-workspace.mjs");
    expect(SHARE_FILES).toContain("scripts/verified-extraction-workspace.mjs");
    await assertPrivateTree(created.workspace_path);

    const identity = await readJson(path.join(created.workspace_path, "workspace-identity.v1.json"));
    expect(identity).toMatchObject({
      source: documentMap.bindings.source,
      schema: documentMap.bindings.schema,
      document_map_sha256: documentMap.document_map_sha256,
      package_inclusion: "enabled_experimental",
    });
    const externalPointer = await fs.lstat(path.join(rootPath,
      `workspace-${sha256(Buffer.from("test-workspace", "utf8")).slice(0, 32)}.pointer.v1.json`),
    { bigint: true });
    const retainedPointer = await fs.lstat(path.join(created.workspace_path, "workspace-pointer.v1.json"),
      { bigint: true });
    expect([externalPointer.dev, externalPointer.ino]).toEqual([retainedPointer.dev, retainedPointer.ino]);
    await expect(abandonExtractionWorkspaceInitialization({
      rootPath,
      workspaceId: "test-workspace",
      transactionId: GENESIS_TX,
      initializationDirectoryName: path.basename(created.workspace_path),
      expectedInitializationWorkspaceIdentitySha256: created.workspace_identity_sha256,
      expectedCreatorClaimSha256: created.creator_claim_sha256,
      expectedCurrentWorkspaceIdentitySha256: created.workspace_identity_sha256,
    })).rejects.toThrow(/refuses the authoritative workspace directory/u);
  });

  it("publishes one immutable generation per unverified proposal and replays canonical state", async () => {
    const created = await create();
    const generationsPath = path.join(created.workspace_path, "generations");
    const [genesisName] = await fs.readdir(generationsPath);
    const genesisEvents = await fs.readFile(path.join(generationsPath, genesisName, "events.v1.jsonl"));
    const next = await append(created);
    expect(next).toMatchObject({
      generation_sequence: 1,
      state: "complete",
      event: { verification: { status: "unverified", reason: "not_replayed" } },
    });
    const names = (await fs.readdir(generationsPath)).sort();
    expect(names).toHaveLength(2);
    const currentName = names.find(name => name.includes(next.generation_sha256));
    const currentEvents = await fs.readFile(path.join(generationsPath, currentName, "events.v1.jsonl"));
    expect(currentEvents.subarray(0, genesisEvents.length).equals(genesisEvents)).toBe(true);
    const state = await readJson(path.join(generationsPath, currentName, "state.v1.json"));
    expect(state).toMatchObject({
      generation_sequence: 1,
      event_count: 1,
      proposal_count: 1,
      pending_leaf_count: 2,
      result_count: 0,
      proposals: [{ verification: { status: "unverified", reason: "not_replayed" } }],
      results: [],
    });
  });

  it("binds stable opaque cursors to workspace, generation, collection, limit, and exact counts", async () => {
    const created = await create();
    const first = await append(created);
    const page1 = await readExtractionWorkspacePage({
      rootPath,
      workspaceId: "test-workspace",
      expectedWorkspaceIdentitySha256: created.workspace_identity_sha256,
      collection: "pending_leaves",
      limit: 1,
    });
    expect(page1.counts).toEqual({ total: 2, offset: 0, returned: 1, omitted_before: 0, omitted_after: 1 });
    expect(page1.next_cursor).toMatch(/^cursor\./u);

    const second = await append({ ...created, generation_sha256: first.generation_sha256 }, {
      leafPointer: "/amount",
      proposedValue: 42,
      transactionId: "3".repeat(32),
    });
    const page2 = await readExtractionWorkspacePage({
      rootPath,
      workspaceId: "test-workspace",
      expectedWorkspaceIdentitySha256: created.workspace_identity_sha256,
      collection: "pending_leaves",
      limit: 1,
      cursor: page1.next_cursor,
    });
    expect(page2.generation_sha256).toBe(first.generation_sha256);
    expect(page2.counts).toEqual({ total: 2, offset: 1, returned: 1, omitted_before: 1, omitted_after: 0 });
    expect(page2.next_cursor).toBeNull();
    expect(second.generation_sequence).toBe(2);

    await expect(readExtractionWorkspacePage({
      rootPath,
      workspaceId: "test-workspace",
      expectedWorkspaceIdentitySha256: created.workspace_identity_sha256,
      collection: "events",
      limit: 1,
      cursor: page1.next_cursor,
    })).rejects.toThrow(/different collection/u);
    await expect(readExtractionWorkspacePage({
      rootPath,
      workspaceId: "test-workspace",
      expectedWorkspaceIdentitySha256: created.workspace_identity_sha256,
      collection: "pending_leaves",
      limit: 2,
      cursor: page1.next_cursor,
    })).rejects.toThrow(/limit drifted/u);
    const tampered = `${page1.next_cursor.slice(0, -1)}${page1.next_cursor.endsWith("0") ? "1" : "0"}`;
    await expect(readExtractionWorkspacePage({
      rootPath,
      workspaceId: "test-workspace",
      expectedWorkspaceIdentitySha256: created.workspace_identity_sha256,
      collection: "pending_leaves",
      limit: 1,
      cursor: tampered,
    })).rejects.toThrow(/cursor digest/u);
  });

  it("rejects cursor reuse across workspaces", async () => {
    const first = await create();
    const page = await readExtractionWorkspacePage({
      rootPath,
      workspaceId: "test-workspace",
      expectedWorkspaceIdentitySha256: first.workspace_identity_sha256,
      collection: "pending_leaves",
      limit: 1,
    });
    const second = await create({ workspaceId: "other-workspace", transactionId: "4".repeat(32) });
    await expect(readExtractionWorkspacePage({
      rootPath,
      workspaceId: "other-workspace",
      expectedWorkspaceIdentitySha256: second.workspace_identity_sha256,
      collection: "pending_leaves",
      limit: 1,
      cursor: page.next_cursor,
    })).rejects.toThrow(/different workspace/u);
  });

  it("fails closed on source, schema, map, leaf, policy, chunk, and output-bound drift", async () => {
    await expect(create({ sourceBytes: Buffer.concat([sourceBytes, Buffer.from([0])]) }))
      .rejects.toThrow(/document-map/u);
    await expect(create({ schemaBytes: Buffer.from("{}", "utf8") }))
      .rejects.toThrow(/document-map/u);
    await expect(create({ documentMap: { ...documentMap, document_map_sha256: "f".repeat(64) } }))
      .rejects.toThrow(/document-map/u);
    await expect(create({ leafObligations: ["/agency", "/agency"] }))
      .rejects.toThrow(/duplicate/u);
    await expect(create({ workspacePolicy: { ...DEFAULT_EXTRACTION_WORKSPACE_POLICY, extra: true } }))
      .rejects.toThrow(/policy keys/u);

    const created = await create();
    await expect(append(created, { chunkIds: [`chunk.${"f".repeat(64)}`] }))
      .rejects.toThrow(/unknown, duplicate, or omitted/u);
    await expect(append(created, { chunkIds: [
      documentMap.chunks.descriptors[0].chunk_id,
      documentMap.chunks.descriptors[0].chunk_id,
    ] })).rejects.toThrow(/unknown, duplicate, or omitted/u);
    await expect(append(created, { leafPointer: "/not-admitted" }))
      .rejects.toThrow(/leaf is not admitted/u);

    const boundedPolicy = {
      ...DEFAULT_EXTRACTION_WORKSPACE_POLICY,
      max_string_utf8_bytes: 6000,
      max_page_utf8_bytes: 4096,
    };
    const bounded = await create({
      workspaceId: "bounded-workspace",
      workspacePolicy: boundedPolicy,
      transactionId: "5".repeat(32),
    });
    await append({ ...bounded, generation_sha256: bounded.generation_sha256 }, {
      workspaceId: "bounded-workspace",
      proposedValue: "x".repeat(5000),
      transactionId: "6".repeat(32),
    });
    await expect(readExtractionWorkspacePage({
      rootPath,
      workspaceId: "bounded-workspace",
      expectedWorkspaceIdentitySha256: bounded.workspace_identity_sha256,
      collection: "proposals",
      limit: 1,
    })).rejects.toThrow(/one retained item exceeds/u);
  });

  it("rejects retained document-map forgery even when the generation chain is re-authored", async () => {
    const created = await create();
    const mapPath = path.join(created.workspace_path, "document-map.v1.json");
    const forgedMap = await readJson(mapPath);
    forgedMap.limitations = [...forgedMap.limitations];
    forgedMap.limitations[0] = "forged retained document-map content";
    const forgedMapBytes = canonicalBytes(forgedMap);
    await fs.writeFile(mapPath, forgedMapBytes, { mode: 0o600 });

    const generationsPath = path.join(created.workspace_path, "generations");
    const [originalGenerationName] = await fs.readdir(generationsPath);
    const originalGenerationPath = path.join(generationsPath, originalGenerationName);
    const manifestPath = path.join(originalGenerationPath, "generation-manifest.v1.json");
    const manifest = await readJson(manifestPath);
    const mapRecord = manifest.static_artifacts.find(record => record.role === "document_map");
    mapRecord.bytes = forgedMapBytes.length;
    mapRecord.sha256 = sha256(forgedMapBytes);
    const manifestBytes = canonicalBytes(manifest);
    await fs.writeFile(manifestPath, manifestBytes, { mode: 0o600 });
    const forgedGenerationDigest = generationSha256(manifestBytes);
    await fs.rename(
      originalGenerationPath,
      path.join(generationsPath, `generation-00000000-${forgedGenerationDigest}`),
    );

    await expect(inspectExtractionWorkspace({
      rootPath,
      workspaceId: "test-workspace",
      expectedWorkspaceIdentitySha256: created.workspace_identity_sha256,
    })).rejects.toThrow(/document map digest does not match the retained map bytes/u);
  });

  it("recovers the bound genesis after the complete pointer is linked but before any writer claim", async () => {
    const transactionId = "f".repeat(32);
    await expect(create({
      transactionId,
      faultInjector: phase => {
        if (phase === "after_workspace_pointer_link") throw new Error("pre-genesis crash");
      },
    })).rejects.toThrow(/pre-genesis crash/u);
    const { identity } = await workspaceFromRoot(rootPath);
    const genesisCreatorAuthority = await creatorAuthority(
      rootPath,
      "test-workspace",
      transactionId,
    );
    expect(identity.genesis_transaction_id).toBe(transactionId);
    const before = await inspectExtractionWorkspace({
      rootPath,
      workspaceId: "test-workspace",
      expectedWorkspaceIdentitySha256: identity.workspace_identity_sha256,
    });
    expect(before).toMatchObject({
      state: "initialization_recovery_required",
      current_generation_sha256: null,
      complete_generations: 0,
      incomplete_generations: [],
      active_transaction_id: null,
    });
    await expect(recoverExtractionWorkspace({
      rootPath,
      workspaceId: "test-workspace",
      expectedWorkspaceIdentitySha256: identity.workspace_identity_sha256,
      transactionId: "0".repeat(32),
      expectedCreatorClaimSha256: genesisCreatorAuthority.expectedCreatorClaimSha256,
      action: "initialize_genesis",
    })).rejects.toThrow(/differs from the workspace identity/u);
    const recovered = await recoverExtractionWorkspace({
      rootPath,
      workspaceId: "test-workspace",
      expectedWorkspaceIdentitySha256: identity.workspace_identity_sha256,
      transactionId,
      expectedCreatorClaimSha256: genesisCreatorAuthority.expectedCreatorClaimSha256,
      action: "initialize_genesis",
    });
    expect(recovered).toMatchObject({
      state: "recovered_genesis",
      transaction_id: transactionId,
      generation_sequence: 0,
    });
    const after = await inspectExtractionWorkspace({
      rootPath,
      workspaceId: "test-workspace",
      expectedWorkspaceIdentitySha256: identity.workspace_identity_sha256,
    });
    expect(after).toMatchObject({ state: "complete", complete_generations: 1 });
    await expect(recoverExtractionWorkspace({
      rootPath,
      workspaceId: "test-workspace",
      expectedWorkspaceIdentitySha256: identity.workspace_identity_sha256,
      transactionId,
      expectedCreatorClaimSha256: genesisCreatorAuthority.expectedCreatorClaimSha256,
      action: "initialize_genesis",
    })).rejects.toThrow(/exact unclaimed pre-genesis workspace/u);
  });

  it("never exposes or strands a partially written static workspace", async () => {
    await fs.mkdir(rootPath, { mode: 0o700 });
    const phases = [
      "after_initialization_directory",
      "after_initialization_generations_directory",
      "after_initialization_identity",
      "after_initialization_map",
      "after_initialization_leaves",
      "after_initialization_pointer",
      "after_initialization_fsync",
      "before_workspace_publish",
    ];
    for (const [index, faultPhase] of phases.entries()) {
      const workspaceId = `partial-${index}`;
      const transactionId = String(index + 1).repeat(32);
      const beforeCrash = await fs.readdir(rootPath);
      const finalCount = beforeCrash.filter(name => name.startsWith("workspace-")).length;
      await expect(create({
        workspaceId,
        transactionId,
        faultInjector: phase => {
          if (phase === faultPhase) throw new Error(`partial static crash at ${faultPhase}`);
        },
      })).rejects.toThrow(new RegExp(`partial static crash at ${faultPhase}`, "u"));
      const afterCrash = await fs.readdir(rootPath);
      expect(afterCrash.filter(name => name.startsWith("workspace-"))).toHaveLength(finalCount);
      const initializationNames = afterCrash.filter(name => name.startsWith(".initializing-")
        && !beforeCrash.includes(name));
      expect(initializationNames).toHaveLength(1);
      const [initializationDirectoryName] = initializationNames;
      const abandonmentAuthority = await initializationAbandonmentAuthority(
        rootPath,
        workspaceId,
        transactionId,
      );
      if (index === 0) {
        await expect(abandonExtractionWorkspaceInitialization({
          rootPath,
          workspaceId,
          transactionId: "f".repeat(32),
          initializationDirectoryName,
          ...abandonmentAuthority,
        })).rejects.toThrow(/directory identity is invalid/u);
      }
      expect(await abandonExtractionWorkspaceInitialization({
        rootPath,
        workspaceId,
        transactionId,
        initializationDirectoryName,
        ...abandonmentAuthority,
      })).toMatchObject({
        state: "abandoned_initialization",
        workspace_id: workspaceId,
        transaction_id: transactionId,
        initialization_directory_name: initializationDirectoryName,
        recoverable: false,
        transaction_reusable: false,
      });
      await expect(create({ workspaceId, transactionId }))
        .rejects.toThrow(/creator transaction abandonment tombstone already exists/u);
      const replacementTransactionId = (index + 8).toString(16).slice(-1).repeat(32);
      const created = await create({ workspaceId, transactionId: replacementTransactionId });
      const inspection = await inspectExtractionWorkspace({
        rootPath,
        workspaceId,
        expectedWorkspaceIdentitySha256: created.workspace_identity_sha256,
      });
      expect(inspection).toMatchObject({
        state: "complete",
        current_generation_sha256: created.generation_sha256,
        complete_generations: 1,
      });
    }
    const remainingNames = await fs.readdir(rootPath);
    const remainingDirectories = remainingNames.filter(name => name.startsWith(".initializing-")).sort();
    const referencedDirectories = (await Promise.all(remainingNames
      .filter(name => name.endsWith(".pointer.v1.json"))
      .map(async name => (await readJson(path.join(rootPath, name))).workspace_directory_name))).sort();
    expect(remainingDirectories).toEqual(referencedDirectories);
  }, 30_000);

  it("persists and abandons the creator claim before initialization becomes visible", async () => {
    const transactionId = "e".repeat(32);
    await expect(create({
      transactionId,
      faultInjector: phase => {
        if (phase === "after_creator_claim") throw new Error("creator claim crash");
      },
    })).rejects.toThrow(/creator claim crash/u);
    const entries = await fs.readdir(rootPath);
    const claimName = entries.find(name => name.startsWith(".creator-"));
    expect(claimName).toBeTruthy();
    const claim = await readJson(path.join(rootPath, claimName));
    const abandonmentAuthority = await initializationAbandonmentAuthority(
      rootPath,
      "test-workspace",
      transactionId,
    );
    expect(claim).toMatchObject({
      transaction_id: transactionId,
      workspace_id: "test-workspace",
    });
    await expect(abandonExtractionWorkspaceInitialization({
      rootPath,
      workspaceId: "test-workspace",
      transactionId,
      initializationDirectoryName: claim.initialization_directory_name,
      ...abandonmentAuthority,
    })).resolves.toMatchObject({
      state: "abandoned_initialization",
      recoverable: false,
    });
    expect((await fs.readdir(rootPath)).some(name => name === claimName)).toBe(false);
  });

  it("requires the exact creator claim and permanently consumes an abandoned transaction", async () => {
    const workspaceId = "creator-authority-hostile";
    const transactionId = "c".repeat(32);
    await expect(create({
      workspaceId,
      transactionId,
      faultInjector: phase => {
        if (phase === "after_creator_claim") throw new Error("creator authority hostile fixture");
      },
    })).rejects.toThrow(/creator authority hostile fixture/u);
    const authority = await creatorAuthority(rootPath, workspaceId, transactionId);
    const originalBytes = await fs.readFile(authority.filename);
    const substitutedBytes = canonicalBytes({
      ...authority.claim,
      workspace_identity_sha256: "f".repeat(64),
    });
    await fs.writeFile(authority.filename, substitutedBytes, { mode: 0o600 });
    await expect(abandonExtractionWorkspaceInitialization({
      rootPath,
      workspaceId,
      transactionId,
      initializationDirectoryName: authority.claim.initialization_directory_name,
      expectedInitializationWorkspaceIdentitySha256: authority.claim.workspace_identity_sha256,
      expectedCreatorClaimSha256: sha256(substitutedBytes),
    })).rejects.toThrow(/creator claim binding drifted/u);

    await fs.unlink(authority.filename);
    await expect(abandonExtractionWorkspaceInitialization({
      rootPath,
      workspaceId,
      transactionId,
      initializationDirectoryName: authority.claim.initialization_directory_name,
      expectedInitializationWorkspaceIdentitySha256: authority.claim.workspace_identity_sha256,
      expectedCreatorClaimSha256: sha256(originalBytes),
    })).rejects.toThrow(/exact physical creator claim is missing/u);

    await fs.writeFile(authority.filename, originalBytes, { mode: 0o600, flag: "wx" });
    const exactAuthority = {
      expectedInitializationWorkspaceIdentitySha256: authority.claim.workspace_identity_sha256,
      expectedCreatorClaimSha256: sha256(originalBytes),
    };
    await expect(abandonExtractionWorkspaceInitialization({
      rootPath,
      workspaceId,
      transactionId,
      initializationDirectoryName: authority.claim.initialization_directory_name,
      ...exactAuthority,
    })).resolves.toMatchObject({
      state: "abandoned_initialization",
      transaction_reusable: false,
    });
    await expect(abandonExtractionWorkspaceInitialization({
      rootPath,
      workspaceId,
      transactionId,
      initializationDirectoryName: authority.claim.initialization_directory_name,
      ...exactAuthority,
    })).resolves.toMatchObject({ state: "abandoned_initialization" });
    await expect(create({ workspaceId, transactionId }))
      .rejects.toThrow(/creator transaction abandonment tombstone already exists/u);
    const tombstones = (await fs.readdir(rootPath))
      .filter(name => name.endsWith(".creator-abandonment.v1.json"));
    expect(tombstones).toHaveLength(1);
    expect(await physicalMode(path.join(rootPath, tombstones[0]))).toBe(0o600);
  });

  it("reconciles retained static identity before recording creator abandonment", async () => {
    const workspaceId = "creator-static-reconciliation";
    const transactionId = "d".repeat(32);
    await expect(create({
      workspaceId,
      transactionId,
      faultInjector: phase => {
        if (phase === "after_initialization_identity") {
          throw new Error("static reconciliation fixture");
        }
      },
    })).rejects.toThrow(/static reconciliation fixture/u);
    const authority = await creatorAuthority(rootPath, workspaceId, transactionId);
    const initializationPath = path.join(rootPath, authority.claim.initialization_directory_name);
    const identityPath = path.join(initializationPath, "workspace-identity.v1.json");
    const originalIdentityBytes = await fs.readFile(identityPath);
    const substitutedIdentityBody = {
      ...JSON.parse(originalIdentityBytes.toString("utf8")),
      workspace_id: "substituted-static-identity",
    };
    delete substitutedIdentityBody.workspace_identity_sha256;
    const substitutedIdentity = {
      ...substitutedIdentityBody,
      workspace_identity_sha256: sha256(Buffer.from(
        canonicalWorkspaceJson(substitutedIdentityBody),
        "utf8",
      )),
    };
    await fs.writeFile(identityPath, canonicalBytes(substitutedIdentity), { mode: 0o600 });
    const exactAuthority = {
      expectedInitializationWorkspaceIdentitySha256: authority.claim.workspace_identity_sha256,
      expectedCreatorClaimSha256: authority.expectedCreatorClaimSha256,
    };
    await expect(abandonExtractionWorkspaceInitialization({
      rootPath,
      workspaceId,
      transactionId,
      initializationDirectoryName: authority.claim.initialization_directory_name,
      ...exactAuthority,
    })).rejects.toThrow(/initialization identity binding drifted/u);
    await fs.writeFile(identityPath, originalIdentityBytes, { mode: 0o600 });
    await expect(abandonExtractionWorkspaceInitialization({
      rootPath,
      workspaceId,
      transactionId,
      initializationDirectoryName: authority.claim.initialization_directory_name,
      ...exactAuthority,
    })).resolves.toMatchObject({ state: "abandoned_initialization" });
  });

  it("serializes abandonment after the creator claim and tombstone check", async () => {
    const workspaceId = "creator-abandonment-race";
    const transactionId = "e".repeat(32);
    let interleavingReached = false;
    const created = await create({
      workspaceId,
      transactionId,
      faultInjector: async (phase, context) => {
        if (phase !== "after_creator_claim_abandonment_recheck") return;
        interleavingReached = true;
        await expect(abandonExtractionWorkspaceInitialization({
          rootPath,
          workspaceId,
          transactionId,
          initializationDirectoryName: path.basename(context.initializationPath),
          expectedInitializationWorkspaceIdentitySha256:
            context.workspaceIdentitySha256,
          expectedCreatorClaimSha256: context.creatorClaimSha256,
        })).rejects.toThrow(/creator or abandonment operation is already active/u);
      },
    });
    expect(interleavingReached).toBe(true);
    expect(created).toMatchObject({ state: "complete", generation_sequence: 0 });
    const entries = await fs.readdir(rootPath);
    expect(entries.some(name => name.endsWith(".creator-claim.v1.json"))).toBe(false);
    expect(entries.some(name => name.endsWith(".operation-lease.v1.json"))).toBe(false);
    expect(entries.filter(name => name.endsWith(".creator-abandonment.v1.json")))
      .toHaveLength(0);
  });

  it("reclaims only an exact dead creator-operation lease", async () => {
    await fs.mkdir(rootPath, { mode: 0o700 });
    const workspaceId = "dead-creator-lease";
    const transactionId = "f".repeat(32);
    const stem = sha256(Buffer.from(`${workspaceId}\0${transactionId}`, "utf8"));
    const leasePath = path.join(rootPath, `.creator-${stem}.operation-lease.v1.json`);
    await fs.writeFile(leasePath, canonicalBytes({
      contract: {
        name: "pdf-tools.verified-extraction-workspace-creator-operation-lease",
        version: "1.0.0-experimental",
      },
      workspace_id: workspaceId,
      transaction_id: transactionId,
      owner_pid: 2147483647,
      token: "a".repeat(32),
    }), { mode: 0o600, flag: "wx" });
    await expect(create({ workspaceId, transactionId }))
      .resolves.toMatchObject({ state: "complete" });
    const entries = await fs.readdir(rootPath);
    expect(entries.some(name => name.includes(".operation-lease.v1.json"))).toBe(false);
  });

  it.each([
    ["regular file", async pointerPath => fs.writeFile(pointerPath, "occupied", { mode: 0o600 })],
    ["symlink", async pointerPath => fs.symlink(path.join(rootPath, "missing-target"), pointerPath)],
    ["empty directory", async pointerPath => fs.mkdir(pointerPath, { mode: 0o700 })],
    ["non-empty directory", async pointerPath => {
      await fs.mkdir(pointerPath, { mode: 0o700 });
      await fs.writeFile(path.join(pointerPath, "sentinel"), "occupied", { mode: 0o600 });
    }],
  ])("publishes through an exclusive pointer without replacing an existing %s", async (_label, occupy) => {
    await fs.mkdir(rootPath, { mode: 0o700 });
    const workspaceId = "pointer-collision";
    const pointerName = `workspace-${sha256(Buffer.from(workspaceId, "utf8")).slice(0, 32)}.pointer.v1.json`;
    const pointerPath = path.join(rootPath, pointerName);
    await occupy(pointerPath);
    const before = await fs.lstat(pointerPath, { bigint: true });
    await expect(create({ workspaceId, transactionId: "a".repeat(32) }))
      .rejects.toMatchObject({ code: "EEXIST" });
    const after = await fs.lstat(pointerPath, { bigint: true });
    expect(after.mode).toBe(before.mode);
    expect(after.ino).toBe(before.ino);

    const initializationNames = (await fs.readdir(rootPath))
      .filter(name => name.startsWith(".initializing-") && name.includes("a".repeat(32)));
    expect(initializationNames).toHaveLength(1);
    const abandonmentAuthority = await initializationAbandonmentAuthority(
      rootPath,
      workspaceId,
      "a".repeat(32),
    );
    await expect(abandonExtractionWorkspaceInitialization({
      rootPath,
      workspaceId,
      transactionId: "a".repeat(32),
      initializationDirectoryName: initializationNames[0],
      ...abandonmentAuthority,
    })).rejects.toThrow(/workspace pointer during initialization abandonment|not a physical file/u);
    await fs.rm(pointerPath, { recursive: true, force: false });
    await expect(abandonExtractionWorkspaceInitialization({
      rootPath,
      workspaceId,
      transactionId: "a".repeat(32),
      initializationDirectoryName: initializationNames[0],
      ...abandonmentAuthority,
    })).resolves.toMatchObject({ state: "abandoned_initialization" });
  });

  it.each(["completed", "genesis-held"])("keeps a prepared concurrent loser recoverable with winner %s", async winnerPhase => {
    await fs.mkdir(rootPath, { mode: 0o700 });
    const workspaceId = "concurrent-pointer";
    const transactionIds = ["a".repeat(32), "b".repeat(32)];
    let releaseLoser;
    let reachedLoser;
    let releaseWinner;
    let reachedWinner;
    const loserBarrier = new Promise(resolve => { releaseLoser = resolve; });
    const loserReady = new Promise(resolve => { reachedLoser = resolve; });
    const winnerBarrier = new Promise(resolve => { releaseWinner = resolve; });
    const winnerReady = new Promise(resolve => { reachedWinner = resolve; });
    const settle = promise => promise.then(
      value => ({ status: "fulfilled", value }),
      reason => ({ status: "rejected", reason }),
    );
    const loserOutcome = settle(create({
      workspaceId,
      transactionId: transactionIds[0],
      faultInjector: async phase => {
        if (phase === "before_workspace_publish") {
          reachedLoser();
          await loserBarrier;
        }
      },
    }));
    await Promise.race([loserReady, loserOutcome.then(() => {
      throw new Error("Loser ended before its publication barrier");
    })]);
    const winnerOutcome = settle(create({
      workspaceId,
      transactionId: transactionIds[1],
      faultInjector: async phase => {
        if (winnerPhase === "genesis-held" && phase === "after_claim") {
          reachedWinner();
          await winnerBarrier;
        }
      },
    }));
    let outcomes;
    try {
      if (winnerPhase === "genesis-held") {
        await Promise.race([winnerReady, winnerOutcome.then(() => {
          throw new Error("Winner ended before its genesis barrier");
        })]);
      } else {
        expect(await winnerOutcome).toMatchObject({ status: "fulfilled" });
      }
      releaseLoser();
      const loser = await loserOutcome;
      expect(loser.status).toBe("rejected");
      if (winnerPhase === "completed") {
        expect(loser.reason).toMatchObject({ code: "EEXIST" });
      } else {
        // Writer authority and deletion intent share the same exclusive path.
        expect(loser.reason.message).toBe("Invalid extraction workspace: workspace deletion intent already exists");
      }
    } finally {
      releaseLoser();
      releaseWinner();
      outcomes = await Promise.all([loserOutcome, winnerOutcome]);
    }
    expect(outcomes.filter(item => item.status === "fulfilled")).toHaveLength(1);
    const rejected = outcomes.filter(item => item.status === "rejected");
    expect(rejected).toHaveLength(1);

    const { pointer } = await workspaceFromRoot(rootPath);
    const privateDirectories = (await fs.readdir(rootPath))
      .filter(name => name.startsWith(".initializing-"));
    expect(privateDirectories).toHaveLength(2);
    const loserDirectory = privateDirectories.find(name => name !== pointer.workspace_directory_name);
    expect(loserDirectory).toBeTruthy();
    const loserTransactionId = transactionIds.find(item => loserDirectory.includes(`-${item}-`));
    expect(loserTransactionId).toBeTruthy();
    const loserAbandonmentAuthority = await initializationAbandonmentAuthority(
      rootPath,
      workspaceId,
      loserTransactionId,
    );
    await expect(abandonExtractionWorkspaceInitialization({
      rootPath,
      workspaceId,
      transactionId: loserTransactionId,
      initializationDirectoryName: loserDirectory,
      ...loserAbandonmentAuthority,
      expectedCurrentWorkspaceIdentitySha256: pointer.workspace_identity_sha256,
    })).resolves.toMatchObject({ state: "abandoned_initialization" });
    await expect(inspectExtractionWorkspace({
      rootPath,
      workspaceId,
      expectedWorkspaceIdentitySha256: pointer.workspace_identity_sha256,
    })).resolves.toMatchObject({ state: "complete" });
  });

  it("rejects an early concurrent creator without scratch while genesis writer authority is held", async () => {
    await fs.mkdir(rootPath, { mode: 0o700 });
    const workspaceId = "early-concurrent-pointer";
    let releaseWinner;
    let reachedWinner;
    const barrier = new Promise(resolve => { releaseWinner = resolve; });
    const ready = new Promise(resolve => { reachedWinner = resolve; });
    const winner = create({
      workspaceId,
      transactionId: "b".repeat(32),
      faultInjector: async phase => {
        if (phase === "after_claim") {
          reachedWinner();
          await barrier;
        }
      },
    });
    let completed;
    try {
      await Promise.race([ready, winner.then(() => {
        throw new Error("Winner ended before its genesis barrier");
      })]);
      const before = (await fs.readdir(rootPath)).sort();
      await expect(create({ workspaceId, transactionId: "a".repeat(32) }))
        .rejects.toThrow("Invalid extraction workspace: workspace deletion intent already exists");
      expect((await fs.readdir(rootPath)).sort()).toEqual(before);
    } finally {
      releaseWinner();
      completed = await winner;
    }
    await expect(inspectExtractionWorkspace({
      rootPath,
      workspaceId,
      expectedWorkspaceIdentitySha256: completed.workspace_identity_sha256,
    })).resolves.toMatchObject({ state: "complete" });
  });

  it("retains a recoverable loser when another creator publishes during root inspection", async () => {
    await fs.mkdir(rootPath, { mode: 0o700 });
    let releaseInspection;
    const inspectionBarrier = new Promise(resolve => { releaseInspection = resolve; });
    let enteredInspection;
    const entered = new Promise(resolve => { enteredInspection = resolve; });
    const loserTransactionId = "a".repeat(32);
    const workspaceId = "root-inspection-race";
    const loser = create({
      workspaceId,
      transactionId: loserTransactionId,
      faultInjector: async phase => {
        if (phase === "after_workspace_root_lstat") {
          enteredInspection();
          await inspectionBarrier;
        }
      },
    }).then(value => ({ value }), error => ({ error }));
    await entered;
    let winner;
    try {
      winner = await create({ workspaceId, transactionId: "b".repeat(32) });
    } finally {
      releaseInspection();
    }
    expect((await loser).error).toMatchObject({ code: "EEXIST" });
    const { pointer } = await workspaceFromRoot(rootPath);
    const initializations = (await fs.readdir(rootPath)).filter(name => name.startsWith(".initializing-"));
    expect(initializations).toHaveLength(2);
    const loserDirectory = initializations.find(name => name !== pointer.workspace_directory_name);
    const authority = await initializationAbandonmentAuthority(rootPath, workspaceId, loserTransactionId);
    await expect(abandonExtractionWorkspaceInitialization({
      rootPath,
      workspaceId,
      transactionId: loserTransactionId,
      initializationDirectoryName: loserDirectory,
      ...authority,
      expectedCurrentWorkspaceIdentitySha256: winner.workspace_identity_sha256,
    })).resolves.toMatchObject({ state: "abandoned_initialization" });
    expect((await inspectExtractionWorkspace({
      rootPath,
      workspaceId,
      expectedWorkspaceIdentitySha256: winner.workspace_identity_sha256,
    })).state).toBe("complete");
  });

  it.each(["replacement", "symlink", "file", ...(process.platform === "win32" ? [] : ["mode"])])(
    "rejects %s of the shared root during inspection without publishing a claim",
    async kind => {
      await fs.mkdir(rootPath, { mode: 0o700 });
      const originalPath = path.join(parentPath, "original-root");
      await expect(create({
        faultInjector: async phase => {
          if (phase !== "after_workspace_root_lstat") return;
          if (kind === "mode") {
            await fs.chmod(rootPath, 0o755);
            return;
          }
          await fs.rename(rootPath, originalPath);
          if (kind === "replacement") await fs.mkdir(rootPath, { mode: 0o700 });
          else if (kind === "symlink") await fs.symlink(originalPath, rootPath, "junction");
          else await fs.writeFile(rootPath, "not a directory", { mode: 0o600, flag: "wx" });
        },
      })).rejects.toThrow(/changed during inspection|symlinked or aliased|not a physical directory/u);
      const physicalRoot = kind === "mode" ? rootPath : originalPath;
      expect(await fs.readdir(physicalRoot)).toEqual([]);
    },
  );

  it("binds the pointer to the exact private data directory in the workspace identity", async () => {
    const created = await create();
    const { pointerName, pointer } = await workspaceFromRoot(rootPath);
    const pointerPath = path.join(rootPath, pointerName);
    const originalPointerBytes = await fs.readFile(pointerPath);
    const substitutedDirectoryName = `${pointer.workspace_directory_name.slice(0, -32)}${"b".repeat(32)}`;
    const substitutedPath = path.join(rootPath, substitutedDirectoryName);
    await fs.rename(created.workspace_path, substitutedPath);
    await fs.writeFile(pointerPath, canonicalBytes({
      ...pointer,
      workspace_directory_name: substitutedDirectoryName,
    }), { mode: 0o600 });
    await expect(inspectExtractionWorkspace({
      rootPath,
      workspaceId: "test-workspace",
      expectedWorkspaceIdentitySha256: created.workspace_identity_sha256,
    })).rejects.toThrow(/pointer directory binding drifted/u);
    await fs.rename(substitutedPath, created.workspace_path);
    await fs.writeFile(pointerPath, originalPointerBytes, { mode: 0o600 });
    await expect(inspectExtractionWorkspace({
      rootPath,
      workspaceId: "test-workspace",
      expectedWorkspaceIdentitySha256: created.workspace_identity_sha256,
    })).resolves.toMatchObject({ state: "complete" });
  });

  it("cannot use a valid concurrent-loser pointer to abandon committed history", async () => {
    await fs.mkdir(rootPath, { mode: 0o700 });
    const workspaceId = "cleanup-substitution";
    const transactionIds = ["a".repeat(32), "b".repeat(32)];
    const outcomes = await Promise.allSettled(transactionIds.map(transactionId => (
      create({ workspaceId, transactionId })
    )));
    const winner = outcomes.find(item => item.status === "fulfilled").value;
    const pointerName = `workspace-${sha256(Buffer.from(workspaceId, "utf8")).slice(0, 32)}.pointer.v1.json`;
    const pointerPath = path.join(rootPath, pointerName);
    const winnerPointerBytes = await fs.readFile(pointerPath);
    const directories = (await fs.readdir(rootPath)).filter(name => name.startsWith(".initializing-"));
    const loserDirectory = directories.find(name => name !== path.basename(winner.workspace_path));
    const loserIdentity = await readJson(path.join(rootPath, loserDirectory, "workspace-identity.v1.json"));
    const loserPointerBytes = await fs.readFile(path.join(rootPath, loserDirectory, "workspace-pointer.v1.json"));
    const winnerTransactionId = path.basename(winner.workspace_path).split("-").at(-2);
    const winnerCreatorClaimSha256 = winner.creator_claim_sha256;
    await fs.unlink(pointerPath);
    await fs.writeFile(pointerPath, loserPointerBytes, { mode: 0o600 });

    await expect(abandonExtractionWorkspaceInitialization({
      rootPath,
      workspaceId,
      transactionId: winnerTransactionId,
      initializationDirectoryName: path.basename(winner.workspace_path),
      expectedInitializationWorkspaceIdentitySha256: winner.workspace_identity_sha256,
      expectedCreatorClaimSha256: winnerCreatorClaimSha256,
      expectedCurrentWorkspaceIdentitySha256: winner.workspace_identity_sha256,
    })).rejects.toThrow(/exact expected identity/u);
    await expect(abandonExtractionWorkspaceInitialization({
      rootPath,
      workspaceId,
      transactionId: winnerTransactionId,
      initializationDirectoryName: path.basename(winner.workspace_path),
      expectedInitializationWorkspaceIdentitySha256: winner.workspace_identity_sha256,
      expectedCreatorClaimSha256: winnerCreatorClaimSha256,
      expectedCurrentWorkspaceIdentitySha256: loserIdentity.workspace_identity_sha256,
    })).rejects.toThrow(/exact physical creator claim is missing/u);
    expect(await fs.access(winner.workspace_path).then(() => true)).toBe(true);

    await fs.unlink(pointerPath);
    await fs.writeFile(pointerPath, winnerPointerBytes, { mode: 0o600 });
    await expect(inspectExtractionWorkspace({
      rootPath,
      workspaceId,
      expectedWorkspaceIdentitySha256: winner.workspace_identity_sha256,
    })).resolves.toMatchObject({ state: "complete" });
    const loserTransactionId = transactionIds.find(item => loserDirectory.includes(`-${item}-`));
    const loserAbandonmentAuthority = await initializationAbandonmentAuthority(
      rootPath,
      workspaceId,
      loserTransactionId,
    );
    await expect(abandonExtractionWorkspaceInitialization({
      rootPath,
      workspaceId,
      transactionId: loserTransactionId,
      initializationDirectoryName: loserDirectory,
      ...loserAbandonmentAuthority,
      expectedCurrentWorkspaceIdentitySha256: winner.workspace_identity_sha256,
    })).resolves.toMatchObject({ state: "abandoned_initialization" });
  });

  it("exposes and explicitly abandons an incomplete post-genesis transaction", async () => {
    const created = await create();
    const transactionId = "7".repeat(32);
    await expect(append(created, {
      transactionId,
      faultInjector: phase => {
        if (phase === "after_generation_artifacts") throw new Error("simulated crash");
      },
    })).rejects.toThrow(/simulated crash/u);
    const inspection = await inspectExtractionWorkspace({
      rootPath,
      workspaceId: "test-workspace",
      expectedWorkspaceIdentitySha256: created.workspace_identity_sha256,
    });
    expect(inspection).toMatchObject({
      state: "durability_uncertain",
      current_generation_sha256: created.generation_sha256,
      incomplete_generations: [{ state: "incomplete", reason: "commit_marker_missing" }],
      active_transaction_id: transactionId,
    });
    await expect(recoverExtractionWorkspace({
      rootPath,
      workspaceId: "test-workspace",
      expectedWorkspaceIdentitySha256: created.workspace_identity_sha256,
      transactionId,
      action: "publish_if_complete",
    })).rejects.toThrow(/incomplete generation/u);
    const claimBytes = await fs.readFile(path.join(created.workspace_path, "writer-claim.v1.json"));
    await fs.writeFile(
      path.join(created.workspace_path, `abandoned-claim-${transactionId}.json`),
      claimBytes,
      { mode: 0o600 },
    );
    expect(await recoverExtractionWorkspace({
      rootPath,
      workspaceId: "test-workspace",
      expectedWorkspaceIdentitySha256: created.workspace_identity_sha256,
      transactionId,
      action: "abandon_incomplete",
    })).toMatchObject({ state: "abandoned_incomplete", promotion_authorized: false });
    const after = await inspectExtractionWorkspace({
      rootPath,
      workspaceId: "test-workspace",
      expectedWorkspaceIdentitySha256: created.workspace_identity_sha256,
    });
    expect(after).toMatchObject({ state: "complete", current_generation_sha256: created.generation_sha256 });
    expect(after.abandoned_generations).toEqual([`.abandoned-${transactionId}`]);
    await expect(append(created, { transactionId }))
      .rejects.toThrow(/already abandoned and cannot be replaced/u);
  });

  it("rejects links and unexpected files even inside crash-retained staging", async () => {
    const created = await create();
    const transactionId = "0".repeat(32);
    await expect(append(created, {
      transactionId,
      faultInjector: phase => {
        if (phase === "after_staging_directory") throw new Error("empty staging crash");
      },
    })).rejects.toThrow(/empty staging crash/u);
    const stagingPath = path.join(created.workspace_path, "generations", `.staging-${transactionId}`);
    await fs.symlink("../missing-target", path.join(stagingPath, "injected-link"));
    await expect(inspectExtractionWorkspace({
      rootPath,
      workspaceId: "test-workspace",
      expectedWorkspaceIdentitySha256: created.workspace_identity_sha256,
    })).rejects.toThrow(/unexpected entry, type, or symlink/u);
  });

  it("recovers committed staging and renamed generations without replacement", async () => {
    const created = await create();
    const stagedTx = "8".repeat(32);
    await expect(append(created, {
      transactionId: stagedTx,
      faultInjector: phase => {
        if (phase === "after_commit_marker") throw new Error("staged crash");
      },
    })).rejects.toThrow(/staged crash/u);
    const staged = await recoverExtractionWorkspace({
      rootPath,
      workspaceId: "test-workspace",
      expectedWorkspaceIdentitySha256: created.workspace_identity_sha256,
      transactionId: stagedTx,
      action: "publish_if_complete",
    });
    expect(staged).toMatchObject({ state: "recovered_complete" });

    const renamedTx = "9".repeat(32);
    await expect(append({ ...created, generation_sha256: staged.generation_sha256 }, {
      leafPointer: "/amount",
      proposedValue: 12,
      transactionId: renamedTx,
      faultInjector: phase => {
        if (phase === "after_generation_rename") throw new Error("renamed crash");
      },
    })).rejects.toThrow(/renamed crash/u);
    const renamed = await recoverExtractionWorkspace({
      rootPath,
      workspaceId: "test-workspace",
      expectedWorkspaceIdentitySha256: created.workspace_identity_sha256,
      transactionId: renamedTx,
      action: "publish_if_complete",
    });
    expect(renamed).toMatchObject({ state: "recovered_published" });
    const final = await inspectExtractionWorkspace({
      rootPath,
      workspaceId: "test-workspace",
      expectedWorkspaceIdentitySha256: created.workspace_identity_sha256,
    });
    expect(final).toMatchObject({ state: "complete", complete_generations: 3,
      current_generation_sha256: renamed.generation_sha256 });
  });

  it("recovers a crash-retained genesis without guessing completion", async () => {
    const transactionId = "a".repeat(32);
    await expect(create({
      transactionId,
      faultInjector: phase => {
        if (phase === "after_commit_marker") throw new Error("genesis crash");
      },
    })).rejects.toThrow(/genesis crash/u);
    const { identity } = await workspaceFromRoot(rootPath);
    const before = await inspectExtractionWorkspace({
      rootPath,
      workspaceId: "test-workspace",
      expectedWorkspaceIdentitySha256: identity.workspace_identity_sha256,
    });
    expect(before).toMatchObject({
      state: "durability_uncertain",
      current_generation_sha256: null,
      complete_generations: 0,
      active_transaction_id: transactionId,
    });
    const recovered = await recoverExtractionWorkspace({
      rootPath,
      workspaceId: "test-workspace",
      expectedWorkspaceIdentitySha256: identity.workspace_identity_sha256,
      transactionId,
      action: "publish_if_complete",
    });
    expect(recovered).toMatchObject({ state: "recovered_complete" });
  });

  it("serializes writers with an exclusive durable claim", async () => {
    const created = await create();
    let releaseClaim;
    let claimObserved;
    const released = new Promise(resolve => { releaseClaim = resolve; });
    const observed = new Promise(resolve => { claimObserved = resolve; });
    const first = append(created, {
      transactionId: "b".repeat(32),
      faultInjector: async phase => {
        if (phase === "after_claim") {
          claimObserved();
          await released;
        }
      },
    });
    await observed;
    await expect(append(created, { transactionId: "c".repeat(32) }))
      .rejects.toThrow(/active or crash-retained writer claim/u);
    releaseClaim();
    await expect(first).resolves.toMatchObject({ generation_sequence: 1 });
  });

  it("recovers writer admission interrupted before or after the shared authority link", async () => {
    const created = await create();
    const internalOnlyTransaction = "5".repeat(32);
    await expect(append(created, {
      transactionId: internalOnlyTransaction,
      faultInjector: phase => {
        if (phase === "after_internal_claim_before_writer_authority") {
          throw new Error("internal-only admission interruption");
        }
      },
    })).rejects.toThrow(/internal-only admission interruption/u);
    expect((await fs.readdir(rootPath)).some(name => name.endsWith(".deletion-intent.v1.json")))
      .toBe(false);
    await expect(recoverExtractionWorkspace({
      rootPath,
      workspaceId: "test-workspace",
      expectedWorkspaceIdentitySha256: created.workspace_identity_sha256,
      transactionId: internalOnlyTransaction,
      action: "abandon_incomplete",
    })).resolves.toMatchObject({ state: "abandoned_incomplete" });

    const linkedTransaction = "6".repeat(32);
    await expect(append(created, {
      transactionId: linkedTransaction,
      faultInjector: phase => {
        if (phase === "after_writer_authority_link_before_fsync") {
          throw new Error("linked admission interruption");
        }
      },
    })).rejects.toThrow(/linked admission interruption/u);
    expect((await fs.readdir(rootPath)).filter(name => name.endsWith(".deletion-intent.v1.json")))
      .toHaveLength(1);
    await expect(inspectExtractionWorkspace({
      rootPath,
      workspaceId: "test-workspace",
      expectedWorkspaceIdentitySha256: created.workspace_identity_sha256,
    })).resolves.toMatchObject({
      state: "durability_uncertain",
      active_transaction_id: linkedTransaction,
    });
    await expect(recoverExtractionWorkspace({
      rootPath,
      workspaceId: "test-workspace",
      expectedWorkspaceIdentitySha256: created.workspace_identity_sha256,
      transactionId: linkedTransaction,
      action: "abandon_incomplete",
    })).resolves.toMatchObject({ state: "abandoned_incomplete" });
    expect((await fs.readdir(rootPath)).some(name => name.endsWith(".deletion-intent.v1.json")))
      .toBe(false);
  });

  it("rejects symlink, unexpected-entry, artifact mutation, and stale-parent attacks", async () => {
    const created = await create();
    const rootAlias = path.join(parentPath, "root-alias");
    await fs.symlink(rootPath, rootAlias, "dir");
    await expect(inspectExtractionWorkspace({
      rootPath: rootAlias,
      workspaceId: "test-workspace",
      expectedWorkspaceIdentitySha256: created.workspace_identity_sha256,
    })).rejects.toThrow(/not a physical directory|symlinked or aliased path/u);
    await fs.unlink(rootAlias);

    await fs.symlink("workspace-identity.v1.json", path.join(created.workspace_path, "unexpected-link"));
    await expect(inspectExtractionWorkspace({
      rootPath,
      workspaceId: "test-workspace",
      expectedWorkspaceIdentitySha256: created.workspace_identity_sha256,
    })).rejects.toThrow(/unexpected entry, type, or symlink/u);
    await fs.unlink(path.join(created.workspace_path, "unexpected-link"));

    const identityPath = path.join(created.workspace_path, "workspace-identity.v1.json");
    const original = await fs.readFile(identityPath);
    const identityBackup = path.join(parentPath, "identity-backup.json");
    await fs.writeFile(identityBackup, original, { mode: 0o600 });
    await fs.rename(identityPath, path.join(created.workspace_path, "identity-physical-backup.json"));
    await fs.symlink(identityBackup, identityPath);
    await expect(inspectExtractionWorkspace({
      rootPath,
      workspaceId: "test-workspace",
      expectedWorkspaceIdentitySha256: created.workspace_identity_sha256,
    })).rejects.toThrow(/not a physical file/u);
    await fs.unlink(identityPath);
    await fs.rename(path.join(created.workspace_path, "identity-physical-backup.json"), identityPath);

    await fs.writeFile(identityPath, Buffer.concat([original.subarray(0, -1), Buffer.from(" \n")]), { mode: 0o600 });
    await expect(inspectExtractionWorkspace({
      rootPath,
      workspaceId: "test-workspace",
      expectedWorkspaceIdentitySha256: created.workspace_identity_sha256,
    })).rejects.toThrow(/canonical JSON/u);
    await fs.writeFile(identityPath, original, { mode: 0o600 });

    const next = await append(created);
    await expect(append(created, { transactionId: "d".repeat(32) }))
      .rejects.toThrow(/exact expected parent/u);
    expect(next.generation_sequence).toBe(1);
  });

  it("enforces the frozen generation ceiling without silent pruning", async () => {
    const policy = { ...DEFAULT_EXTRACTION_WORKSPACE_POLICY, max_generations: 2 };
    const created = await create({ workspacePolicy: policy });
    const next = await append(created);
    await expect(append({ ...created, generation_sha256: next.generation_sha256 }, {
      leafPointer: "/amount",
      proposedValue: 1,
      transactionId: "e".repeat(32),
    })).rejects.toThrow(/retention limit reached; explicit deletion is required/u);
    const inspection = await inspectExtractionWorkspace({
      rootPath,
      workspaceId: "test-workspace",
      expectedWorkspaceIdentitySha256: created.workspace_identity_sha256,
    });
    expect(inspection).toMatchObject({ complete_generations: 2,
      retention: { remaining_generations: 0, automatic_pruning: false } });
  });

  it("requires exact identity and generation for explicit irreversible deletion", async () => {
    const created = await create();
    await expect(deleteExtractionWorkspace({
      rootPath,
      workspaceId: "test-workspace",
      expectedWorkspaceIdentitySha256: created.workspace_identity_sha256,
      expectedCurrentGenerationSha256: "f".repeat(64),
    })).rejects.toThrow(/expected generation is stale/u);
    await expect(deleteExtractionWorkspace({
      rootPath,
      workspaceId: "test-workspace",
      expectedWorkspaceIdentitySha256: "f".repeat(64),
      expectedCurrentGenerationSha256: created.generation_sha256,
    })).rejects.toThrow(/exact expected identity/u);
    const deleted = await deleteExtractionWorkspace({
      rootPath,
      workspaceId: "test-workspace",
      expectedWorkspaceIdentitySha256: created.workspace_identity_sha256,
      expectedCurrentGenerationSha256: created.generation_sha256,
    });
    expect(deleted).toEqual({
      state: "deleted",
      workspace_id: "test-workspace",
      workspace_identity_sha256: created.workspace_identity_sha256,
      final_generation_sha256: created.generation_sha256,
      recoverable: false,
    });
    await expect(fs.access(created.workspace_path)).rejects.toMatchObject({ code: "ENOENT" });
    expect((await fs.readdir(rootPath)).filter(name => name.endsWith(".pointer.v1.json"))).toEqual([]);
  });

  it("durably unpublishes before deletion and explicitly completes an interrupted deletion", async () => {
    const created = await create();
    await expect(deleteExtractionWorkspace({
      rootPath,
      workspaceId: "test-workspace",
      expectedWorkspaceIdentitySha256: created.workspace_identity_sha256,
      expectedCurrentGenerationSha256: created.generation_sha256,
      faultInjector: phase => {
        if (phase === "after_workspace_unpublish") throw new Error("delete interruption");
      },
    })).rejects.toThrow(/delete interruption/u);
    expect((await fs.readdir(rootPath)).filter(name => name.endsWith(".pointer.v1.json"))).toEqual([]);
    expect(await fs.access(created.workspace_path).then(() => true)).toBe(true);
    await expect(create({ transactionId: "f".repeat(32) }))
      .rejects.toThrow(/workspace deletion intent already exists/u);
    await expect(completeExtractionWorkspaceDeletion({
      rootPath,
      workspaceId: "test-workspace",
      workspaceDataDirectoryName: path.basename(created.workspace_path),
      expectedWorkspaceIdentitySha256: created.workspace_identity_sha256,
      expectedCurrentGenerationSha256: "f".repeat(64),
      expectedWorkspacePointerSha256: created.workspace_pointer_sha256,
    })).rejects.toThrow(/final generation drifted/u);
    await expect(completeExtractionWorkspaceDeletion({
      rootPath,
      workspaceId: "test-workspace",
      workspaceDataDirectoryName: path.basename(created.workspace_path),
      expectedWorkspaceIdentitySha256: created.workspace_identity_sha256,
      expectedCurrentGenerationSha256: created.generation_sha256,
      expectedWorkspacePointerSha256: "f".repeat(64),
    })).rejects.toThrow(/pointer digest drifted/u);
    let interrupted = false;
    await expect(completeExtractionWorkspaceDeletion({
      rootPath,
      workspaceId: "test-workspace",
      workspaceDataDirectoryName: path.basename(created.workspace_path),
      expectedWorkspaceIdentitySha256: created.workspace_identity_sha256,
      expectedCurrentGenerationSha256: created.generation_sha256,
      expectedWorkspacePointerSha256: created.workspace_pointer_sha256,
      faultInjector: phase => {
        if (!interrupted && phase === "after_workspace_deletion_entry") {
          interrupted = true;
          throw new Error("partial recursive deletion");
        }
      },
    })).rejects.toThrow(/partial recursive deletion/u);
    expect(interrupted).toBe(true);
    expect((await fs.readdir(rootPath)).some(name => name.endsWith(".deletion-intent.v1.json"))).toBe(true);
    await expect(completeExtractionWorkspaceDeletion({
      rootPath,
      workspaceId: "test-workspace",
      workspaceDataDirectoryName: path.basename(created.workspace_path),
      expectedWorkspaceIdentitySha256: created.workspace_identity_sha256,
      expectedCurrentGenerationSha256: created.generation_sha256,
      expectedWorkspacePointerSha256: created.workspace_pointer_sha256,
    })).resolves.toEqual({
      state: "deleted_after_unpublish",
      workspace_id: "test-workspace",
      workspace_identity_sha256: created.workspace_identity_sha256,
      final_generation_sha256: created.generation_sha256,
      recoverable: false,
    });
    await expect(fs.access(created.workspace_path)).rejects.toMatchObject({ code: "ENOENT" });
    const recreated = await create({ transactionId: "f".repeat(32) });
    expect(recreated.state).toBe("complete");
    await expect(deleteExtractionWorkspace({
      rootPath,
      workspaceId: "test-workspace",
      expectedWorkspaceIdentitySha256: recreated.workspace_identity_sha256,
      expectedCurrentGenerationSha256: recreated.generation_sha256,
      faultInjector: phase => {
        if (phase === "after_workspace_data_removal") throw new Error("intent cleanup interruption");
      },
    })).rejects.toThrow(/intent cleanup interruption/u);
    await expect(fs.access(recreated.workspace_path)).rejects.toMatchObject({ code: "ENOENT" });
    await expect(completeExtractionWorkspaceDeletion({
      rootPath,
      workspaceId: "test-workspace",
      workspaceDataDirectoryName: path.basename(recreated.workspace_path),
      expectedWorkspaceIdentitySha256: recreated.workspace_identity_sha256,
      expectedCurrentGenerationSha256: recreated.generation_sha256,
      expectedWorkspacePointerSha256: recreated.workspace_pointer_sha256,
    })).resolves.toMatchObject({ state: "deleted_after_unpublish" });
    expect((await fs.readdir(rootPath)).some(name => name.endsWith(".deletion-intent.v1.json"))).toBe(false);
  });

  it("explicitly abandons a torn deletion intent only while the exact workspace remains authoritative", async () => {
    const created = await create();
    const deletionIntentPath = path.join(rootPath,
      `workspace-${sha256(Buffer.from("test-workspace", "utf8")).slice(0, 32)}.deletion-intent.v1.json`);
    await fs.writeFile(deletionIntentPath, Buffer.alloc(0), { mode: 0o600 });
    await expect(deleteExtractionWorkspace({
      rootPath,
      workspaceId: "test-workspace",
      expectedWorkspaceIdentitySha256: created.workspace_identity_sha256,
      expectedCurrentGenerationSha256: created.generation_sha256,
    })).rejects.toThrow(/workspace deletion intent already exists/u);
    await expect(abandonExtractionWorkspaceDeletionIntent({
      rootPath,
      workspaceId: "test-workspace",
      expectedWorkspaceIdentitySha256: created.workspace_identity_sha256,
      expectedCurrentGenerationSha256: "f".repeat(64),
    })).rejects.toThrow(/expected generation is stale/u);
    await expect(abandonExtractionWorkspaceDeletionIntent({
      rootPath,
      workspaceId: "test-workspace",
      expectedWorkspaceIdentitySha256: created.workspace_identity_sha256,
      expectedCurrentGenerationSha256: created.generation_sha256,
    })).resolves.toMatchObject({ state: "abandoned_deletion_intent" });
    await expect(inspectExtractionWorkspace({
      rootPath,
      workspaceId: "test-workspace",
      expectedWorkspaceIdentitySha256: created.workspace_identity_sha256,
    })).resolves.toMatchObject({ state: "complete" });

    await expect(deleteExtractionWorkspace({
      rootPath,
      workspaceId: "test-workspace",
      expectedWorkspaceIdentitySha256: created.workspace_identity_sha256,
      expectedCurrentGenerationSha256: created.generation_sha256,
      faultInjector: phase => {
        if (phase === "after_workspace_deletion_intent") throw new Error("complete intent retained");
      },
    })).rejects.toThrow(/complete intent retained/u);
    await expect(append(created)).rejects.toThrow(/workspace deletion intent already exists/u);
    await expect(abandonExtractionWorkspaceDeletionIntent({
      rootPath,
      workspaceId: "test-workspace",
      expectedWorkspaceIdentitySha256: created.workspace_identity_sha256,
      expectedCurrentGenerationSha256: created.generation_sha256,
    })).rejects.toThrow(/complete deletion intent cannot be abandoned/u);
    await expect(completeExtractionWorkspaceDeletion({
      rootPath,
      workspaceId: "test-workspace",
      workspaceDataDirectoryName: path.basename(created.workspace_path),
      expectedWorkspaceIdentitySha256: created.workspace_identity_sha256,
      expectedCurrentGenerationSha256: created.generation_sha256,
      expectedWorkspacePointerSha256: created.workspace_pointer_sha256,
    })).resolves.toMatchObject({ state: "deleted_after_unpublish" });
  });

  it("serializes writer claims and complete deletion intents in both race directions", async () => {
    const writerFirst = await create({ workspaceId: "writer-first", transactionId: "a".repeat(32) });
    let releaseWriter;
    let writerClaimed;
    const writerRelease = new Promise(resolve => { releaseWriter = resolve; });
    const writerObserved = new Promise(resolve => { writerClaimed = resolve; });
    const writing = append(writerFirst, {
      workspaceId: "writer-first",
      transactionId: "b".repeat(32),
      faultInjector: async phase => {
        if (phase === "after_claim") {
          writerClaimed();
          await writerRelease;
        }
      },
    });
    await writerObserved;
    await expect(deleteExtractionWorkspace({
      rootPath,
      workspaceId: "writer-first",
      expectedWorkspaceIdentitySha256: writerFirst.workspace_identity_sha256,
      expectedCurrentGenerationSha256: writerFirst.generation_sha256,
    })).rejects.toThrow(/active or crash-retained writer claim/u);
    releaseWriter();
    await expect(writing).resolves.toMatchObject({ state: "complete", generation_sequence: 1 });

    const deleteFirst = await create({ workspaceId: "delete-first", transactionId: "c".repeat(32) });
    let releaseDeletion;
    let intentWritten;
    const deletionRelease = new Promise(resolve => { releaseDeletion = resolve; });
    const intentObserved = new Promise(resolve => { intentWritten = resolve; });
    const deleting = deleteExtractionWorkspace({
      rootPath,
      workspaceId: "delete-first",
      expectedWorkspaceIdentitySha256: deleteFirst.workspace_identity_sha256,
      expectedCurrentGenerationSha256: deleteFirst.generation_sha256,
      faultInjector: async phase => {
        if (phase === "after_workspace_deletion_intent") {
          intentWritten();
          await deletionRelease;
        }
        if (phase === "after_workspace_unpublish") throw new Error("delete-first interruption");
      },
    });
    await intentObserved;
    await expect(append(deleteFirst, {
      workspaceId: "delete-first",
      transactionId: "d".repeat(32),
    })).rejects.toThrow(/workspace deletion intent already exists/u);
    await expect(abandonExtractionWorkspaceDeletionIntent({
      rootPath,
      workspaceId: "delete-first",
      expectedWorkspaceIdentitySha256: deleteFirst.workspace_identity_sha256,
      expectedCurrentGenerationSha256: deleteFirst.generation_sha256,
    })).rejects.toThrow(/complete deletion intent cannot be abandoned/u);
    releaseDeletion();
    await expect(deleting).rejects.toThrow(/delete-first interruption/u);
    await expect(completeExtractionWorkspaceDeletion({
      rootPath,
      workspaceId: "delete-first",
      workspaceDataDirectoryName: path.basename(deleteFirst.workspace_path),
      expectedWorkspaceIdentitySha256: deleteFirst.workspace_identity_sha256,
      expectedCurrentGenerationSha256: deleteFirst.generation_sha256,
      expectedWorkspacePointerSha256: deleteFirst.workspace_pointer_sha256,
    })).resolves.toMatchObject({ state: "deleted_after_unpublish" });
  });

  it("atomically arbitrates writers and deletion after either side has already scanned", async () => {
    const deletionWins = await create({
      workspaceId: "deletion-wins-after-writer-scan",
      transactionId: "1".repeat(32),
    });
    let releaseWriterBeforeAuthority;
    let writerScanned;
    const writerRelease = new Promise(resolve => { releaseWriterBeforeAuthority = resolve; });
    const writerObserved = new Promise(resolve => { writerScanned = resolve; });
    const losingWriter = append(deletionWins, {
      workspaceId: "deletion-wins-after-writer-scan",
      transactionId: "2".repeat(32),
      faultInjector: async phase => {
        if (phase === "before_writer_authority") {
          writerScanned();
          await writerRelease;
        }
      },
    });
    await writerObserved;
    let releaseDeletionIntent;
    let deletionIntentWritten;
    const deletionRelease = new Promise(resolve => { releaseDeletionIntent = resolve; });
    const deletionObserved = new Promise(resolve => { deletionIntentWritten = resolve; });
    const winningDeletion = deleteExtractionWorkspace({
      rootPath,
      workspaceId: "deletion-wins-after-writer-scan",
      expectedWorkspaceIdentitySha256: deletionWins.workspace_identity_sha256,
      expectedCurrentGenerationSha256: deletionWins.generation_sha256,
      faultInjector: async phase => {
        if (phase === "after_workspace_deletion_intent") {
          deletionIntentWritten();
          await deletionRelease;
        }
      },
    });
    await deletionObserved;
    releaseWriterBeforeAuthority();
    await expect(losingWriter).rejects.toMatchObject({ code: "EEXIST" });
    releaseDeletionIntent();
    await expect(winningDeletion).resolves.toMatchObject({ state: "deleted" });

    const writerWins = await create({
      workspaceId: "writer-wins-after-deletion-scan",
      transactionId: "3".repeat(32),
    });
    let releaseDeletionBeforeAuthority;
    let deletionScanned;
    const deletionBeforeAuthorityRelease = new Promise(resolve => {
      releaseDeletionBeforeAuthority = resolve;
    });
    const deletionBeforeAuthorityObserved = new Promise(resolve => { deletionScanned = resolve; });
    const losingDeletion = deleteExtractionWorkspace({
      rootPath,
      workspaceId: "writer-wins-after-deletion-scan",
      expectedWorkspaceIdentitySha256: writerWins.workspace_identity_sha256,
      expectedCurrentGenerationSha256: writerWins.generation_sha256,
      faultInjector: async phase => {
        if (phase === "before_workspace_deletion_intent") {
          deletionScanned();
          await deletionBeforeAuthorityRelease;
        }
      },
    });
    await deletionBeforeAuthorityObserved;
    let releaseAdmittedWriter;
    let writerClaimed;
    const admittedWriterRelease = new Promise(resolve => { releaseAdmittedWriter = resolve; });
    const admittedWriterObserved = new Promise(resolve => { writerClaimed = resolve; });
    const winningWriter = append(writerWins, {
      workspaceId: "writer-wins-after-deletion-scan",
      transactionId: "4".repeat(32),
      faultInjector: async phase => {
        if (phase === "after_claim") {
          writerClaimed();
          await admittedWriterRelease;
        }
      },
    });
    await admittedWriterObserved;
    releaseDeletionBeforeAuthority();
    await expect(losingDeletion).rejects.toMatchObject({ code: "EEXIST" });
    releaseAdmittedWriter();
    await expect(winningWriter).resolves.toMatchObject({ state: "complete", generation_sequence: 1 });
    await expect(inspectExtractionWorkspace({
      rootPath,
      workspaceId: "writer-wins-after-deletion-scan",
      expectedWorkspaceIdentitySha256: writerWins.workspace_identity_sha256,
    })).resolves.toMatchObject({ state: "complete", complete_generations: 2 });
  });
});
