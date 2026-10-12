import { createHash, randomBytes } from "node:crypto";
import {
  access,
  constants,
  lstat,
  link,
  mkdir,
  open,
  readdir,
  realpath,
  rename,
  rm,
  rmdir,
  stat,
  unlink,
} from "node:fs/promises";
import path from "node:path";

import {
  DEFAULT_DOCUMENT_MAP_CHUNK_POLICY,
  validateSourceBoundDocumentMap,
} from "../server/document-map.js";

export const EXTRACTION_WORKSPACE_IDENTITY = Object.freeze({
  name: "pdf-tools.verified-extraction-workspace",
  version: "1.1.0-experimental",
});

export const EXTRACTION_WORKSPACE_CURSOR_IDENTITY = Object.freeze({
  name: "pdf-tools.verified-extraction-workspace-cursor",
  version: "1.0.0-experimental",
});

export const DEFAULT_EXTRACTION_WORKSPACE_POLICY = Object.freeze({
  name: "pdf-tools.verified-extraction-workspace-policy",
  version: "1.0.0-experimental",
  max_leaf_obligations: 10000,
  max_generations: 512,
  max_proposals: 50000,
  max_event_utf8_bytes: 65536,
  max_value_depth: 16,
  max_value_nodes: 2000,
  max_string_utf8_bytes: 16384,
  max_chunk_refs_per_proposal: 32,
  max_page_items: 100,
  max_page_utf8_bytes: 262144,
});

const WORKSPACE_ID = /^[a-z0-9](?:[a-z0-9_-]{0,62}[a-z0-9])?$/u;
const TRANSACTION_ID = /^[a-f0-9]{32,64}$/u;
const SHA256 = /^[a-f0-9]{64}$/u;
const CHUNK_ID = /^chunk\.[a-f0-9]{64}$/u;
const EVENT_ID = /^event\.[a-f0-9]{64}$/u;
const JSON_POINTER = /^(?:\/(?:[^~/]|~[01])*)*$/u;
const GENERATION_NAME = /^generation-([0-9]{8})-([a-f0-9]{64})$/u;
const STAGING_NAME = /^\.staging-([a-f0-9]{32,64})$/u;
const ABANDONED_NAME = /^\.abandoned-([a-f0-9]{32,64})$/u;
const ABANDONED_CLAIM_NAME = /^abandoned-claim-([a-f0-9]{32,64})\.json$/u;
const POLICY_KEYS = Object.freeze(Object.keys(DEFAULT_EXTRACTION_WORKSPACE_POLICY).sort());
const IDENTITY_FILE = "workspace-identity.v1.json";
const MAP_FILE = "document-map.v1.json";
const SCHEMA_FILE = "schema.source.json";
const LEAVES_FILE = "leaf-obligations.v1.json";
const POINTER_FILE = "workspace-pointer.v1.json";
const DELETION_INTENT_CONTRACT = Object.freeze({
  name: "pdf-tools.verified-extraction-workspace-deletion-intent",
  version: "1.0.0-experimental",
});
const CLAIM_FILE = "writer-claim.v1.json";
const CREATOR_CLAIM_SUFFIX = ".creator-claim.v1.json";
const CREATOR_ABANDONMENT_SUFFIX = ".creator-abandonment.v1.json";
const EVENTS_FILE = "events.v1.jsonl";
const STATE_FILE = "state.v1.json";
const MANIFEST_FILE = "generation-manifest.v1.json";
const MAX_STATIC_BYTES = 32 * 1024 * 1024;
const MAX_GENERATION_FILE_BYTES = 64 * 1024 * 1024;
export const MAX_RETAINED_WORKSPACE_BYTES = 256 * 1024 * 1024;
const NOFOLLOW = constants.O_NOFOLLOW ?? 0;
const VERIFICATION_STATUSES = Object.freeze([
  "verified_exact",
  "source_supported",
  "computed_with_inputs",
  "ambiguous",
  "not_found",
  "citation_mismatch",
  "unverified_reasoning",
  "chunk_missing",
]);
const SETTLED_VERIFICATION_STATUSES = new Set([
  "verified_exact",
  "computed_with_inputs",
]);
// Retained v1.0 generations must replay byte-for-byte under their original
// policy. New uncertain results remain pending, and a new proposal may reopen
// legacy uncertainty without rewriting its result or generation.
const LEGACY_SETTLED_VERIFICATION_STATUSES = new Set([
  ...SETTLED_VERIFICATION_STATUSES,
  "source_supported",
  "ambiguous",
  "not_found",
  "unverified_reasoning",
]);

function fail(message) {
  throw new Error(`Invalid extraction workspace: ${message}`);
}

function assertion(condition, message) {
  if (!condition) fail(message);
}

function compareCodePoints(left, right) {
  return left < right ? -1 : left > right ? 1 : 0;
}

export function canonicalWorkspaceJson(value) {
  if (value === null || typeof value === "boolean" || typeof value === "string") {
    return JSON.stringify(value);
  }
  if (typeof value === "number") {
    assertion(Number.isFinite(value), "canonical JSON contains a non-finite number");
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) return `[${value.map(canonicalWorkspaceJson).join(",")}]`;
  assertion(value && typeof value === "object" && Object.getPrototypeOf(value) === Object.prototype,
    "canonical JSON contains a non-plain object");
  return `{${Object.keys(value).sort(compareCodePoints).map(key => (
    `${JSON.stringify(key)}:${canonicalWorkspaceJson(value[key])}`
  )).join(",")}}`;
}

function canonicalBytes(value) {
  return Buffer.from(`${canonicalWorkspaceJson(value)}\n`, "utf8");
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function sha256Canonical(value) {
  return sha256(Buffer.from(canonicalWorkspaceJson(value), "utf8"));
}

function exactKeys(value, keys, label) {
  assertion(value && typeof value === "object" && !Array.isArray(value), `${label} must be an object`);
  assertion(canonicalWorkspaceJson(Object.keys(value).sort()) === canonicalWorkspaceJson([...keys].sort()),
    `${label} keys are invalid`);
}

function boundedInteger(value, label, minimum, maximum) {
  assertion(Number.isSafeInteger(value) && value >= minimum && value <= maximum,
    `${label} must be an integer from ${minimum} through ${maximum}`);
  return value;
}

function normalizePolicy(value) {
  exactKeys(value, POLICY_KEYS, "workspace policy");
  assertion(value.name === DEFAULT_EXTRACTION_WORKSPACE_POLICY.name
    && value.version === DEFAULT_EXTRACTION_WORKSPACE_POLICY.version,
  "workspace policy identity is unsupported");
  return {
    name: value.name,
    version: value.version,
    max_leaf_obligations: boundedInteger(value.max_leaf_obligations,
      "max_leaf_obligations", 1, 50000),
    max_generations: boundedInteger(value.max_generations, "max_generations", 2, 4096),
    max_proposals: boundedInteger(value.max_proposals, "max_proposals", 1, 200000),
    max_event_utf8_bytes: boundedInteger(value.max_event_utf8_bytes,
      "max_event_utf8_bytes", 1024, 1024 * 1024),
    max_value_depth: boundedInteger(value.max_value_depth, "max_value_depth", 1, 64),
    max_value_nodes: boundedInteger(value.max_value_nodes, "max_value_nodes", 1, 100000),
    max_string_utf8_bytes: boundedInteger(value.max_string_utf8_bytes,
      "max_string_utf8_bytes", 1, 1024 * 1024),
    max_chunk_refs_per_proposal: boundedInteger(value.max_chunk_refs_per_proposal,
      "max_chunk_refs_per_proposal", 1, 1024),
    max_page_items: boundedInteger(value.max_page_items, "max_page_items", 1, 10000),
    max_page_utf8_bytes: boundedInteger(value.max_page_utf8_bytes,
      "max_page_utf8_bytes", 4096, 8 * 1024 * 1024),
  };
}

function validateJsonValue(value, policy) {
  let nodes = 0;
  const visit = (candidate, depth) => {
    nodes += 1;
    assertion(nodes <= policy.max_value_nodes, "proposed value exceeds its node limit");
    assertion(depth <= policy.max_value_depth, "proposed value exceeds its depth limit");
    if (candidate === null || typeof candidate === "boolean") return candidate;
    if (typeof candidate === "number") {
      assertion(Number.isFinite(candidate), "proposed value contains a non-finite number");
      return candidate;
    }
    if (typeof candidate === "string") {
      assertion(Buffer.byteLength(candidate, "utf8") <= policy.max_string_utf8_bytes,
        "proposed value contains an oversized string");
      return candidate;
    }
    if (Array.isArray(candidate)) return candidate.map(item => visit(item, depth + 1));
    assertion(candidate && typeof candidate === "object"
      && Object.getPrototypeOf(candidate) === Object.prototype,
    "proposed value contains a non-plain object");
    const result = {};
    for (const key of Object.keys(candidate).sort(compareCodePoints)) {
      assertion(Buffer.byteLength(key, "utf8") <= policy.max_string_utf8_bytes,
        "proposed value contains an oversized key");
      result[key] = visit(candidate[key], depth + 1);
    }
    return result;
  };
  return visit(value, 0);
}

function normalizeLeaves(value, policy) {
  assertion(Array.isArray(value) && value.length > 0, "leaf obligations must be a non-empty array");
  assertion(value.length <= policy.max_leaf_obligations, "leaf obligations exceed the policy limit");
  const leaves = value.map(item => {
    assertion(typeof item === "string" && JSON_POINTER.test(item),
      "leaf obligation is not a canonical JSON pointer");
    assertion(Buffer.byteLength(item, "utf8") <= 4096, "leaf obligation is oversized");
    return item;
  });
  assertion(new Set(leaves).size === leaves.length, "leaf obligations contain a duplicate");
  return [...leaves].sort(compareCodePoints);
}

function workspaceDirectoryName(workspaceId) {
  assertion(typeof workspaceId === "string" && WORKSPACE_ID.test(workspaceId), "workspace_id is invalid");
  return `workspace-${sha256(Buffer.from(workspaceId, "utf8")).slice(0, 32)}`;
}

function resolvedAbsolute(value, label) {
  assertion(typeof value === "string" && path.isAbsolute(value), `${label} must be an absolute path`);
  assertion(path.resolve(value) === value, `${label} must already be normalized`);
  return value;
}

function modeBits(metadata) {
  return Number(metadata.mode & 0o777n);
}

function zeroDevice(value) {
  return value === 0 || value === 0n;
}

export function workspacePrivateModeMatchesForPlatform(metadata, expectedMode,
  platform = process.platform) {
  return platform === "win32" || modeBits(metadata) === expectedMode;
}

export function workspaceDirectoryFsyncSupportedForPlatform(platform = process.platform) {
  return platform !== "win32";
}

export function sameWorkspaceFileIdentityForPlatform(left, right,
  platform = process.platform) {
  const deviceMatchesExactly = left.dev === right.dev;
  const deviceMatches = deviceMatchesExactly || (
    platform === "win32" && (zeroDevice(left.dev) !== zeroDevice(right.dev))
  );
  return deviceMatches && left.ino === right.ino && left.size === right.size
    && left.mode === right.mode && left.nlink === right.nlink
    && left.mtimeNs === right.mtimeNs && left.ctimeNs === right.ctimeNs
    && (deviceMatchesExactly || left.birthtimeNs === right.birthtimeNs);
}

function sameFileIdentity(left, right) {
  return sameWorkspaceFileIdentityForPlatform(left, right);
}

export function sameWorkspaceDirectoryIdentityForPlatform(left, right,
  platform = process.platform) {
  const deviceMatches = left.dev === right.dev || (
    platform === "win32" && (zeroDevice(left.dev) !== zeroDevice(right.dev))
  );
  // A shared root's entries may change while another creator publishes its
  // claim. Size, link count and modification/change times describe that mutable
  // inventory, not replacement of the directory. Keep object identity, owner,
  // permissions and birth time exact. Retained files still use the full guard.
  return deviceMatches && left.ino === right.ino && left.mode === right.mode
    && left.uid === right.uid && left.gid === right.gid
    && left.birthtimeNs === right.birthtimeNs;
}

async function assertPrivateDirectory(directory, label, {
  concurrentEntries = false,
  faultInjector = null,
} = {}) {
  const resolved = resolvedAbsolute(directory, label);
  const before = await lstat(resolved, { bigint: true });
  assertion(before.isDirectory() && !before.isSymbolicLink(), `${label} is not a physical directory`);
  assertion(workspacePrivateModeMatchesForPlatform(before, 0o700),
    `${label} mode must be 0700`);
  if (label === "workspace root") {
    await inject(faultInjector, "after_workspace_root_lstat", { directory: resolved });
  }
  assertion(await realpath(resolved) === resolved, `${label} uses a symlinked or aliased path`);
  const after = await lstat(resolved, { bigint: true });
  assertion(after.isDirectory() && !after.isSymbolicLink(), `${label} is not a physical directory`);
  assertion(concurrentEntries
    ? sameWorkspaceDirectoryIdentityForPlatform(before, after)
    : sameFileIdentity(before, after), `${label} changed during inspection`);
  return before;
}

async function ensurePrivateRoot(rootPath, faultInjector = null) {
  const resolved = resolvedAbsolute(rootPath, "workspace root");
  try {
    await access(resolved, constants.F_OK);
  } catch {
    const parent = path.dirname(resolved);
    await assertPrivateDirectory(parent, "workspace root parent", { concurrentEntries: true });
    await mkdir(resolved, { mode: 0o700 });
  }
  await assertPrivateDirectory(resolved, "workspace root", { concurrentEntries: true, faultInjector });
  return resolved;
}

async function fsyncDirectory(directory) {
  // Node cannot open NTFS directories for fsync. Individual retained files are
  // still flushed before publication; Windows directory-metadata durability is
  // therefore an explicit host limitation rather than a false POSIX claim.
  if (!workspaceDirectoryFsyncSupportedForPlatform()) return;
  const handle = await open(directory, constants.O_RDONLY | NOFOLLOW);
  try {
    const metadata = await handle.stat({ bigint: true });
    assertion(metadata.isDirectory(), "fsync target is not a directory");
    await handle.sync();
  } finally {
    await handle.close();
  }
}

async function readRegularFile(filename, maximumBytes, { allowEmpty = false } = {}) {
  const beforePath = await lstat(filename, { bigint: true });
  assertion(beforePath.isFile() && !beforePath.isSymbolicLink(), `${path.basename(filename)} is not a physical file`);
  assertion(workspacePrivateModeMatchesForPlatform(beforePath, 0o600),
    `${path.basename(filename)} mode must be 0600`);
  assertion(beforePath.size <= BigInt(maximumBytes)
    && (allowEmpty || beforePath.size > 0n), `${path.basename(filename)} size is invalid`);
  const handle = await open(filename, constants.O_RDONLY | NOFOLLOW);
  try {
    const opened = await handle.stat({ bigint: true });
    assertion(sameFileIdentity(beforePath, opened), `${path.basename(filename)} changed before open`);
    const bytes = await handle.readFile();
    const afterOpen = await handle.stat({ bigint: true });
    const afterPath = await lstat(filename, { bigint: true });
    assertion(sameFileIdentity(opened, afterOpen) && sameFileIdentity(afterOpen, afterPath),
      `${path.basename(filename)} changed while read`);
    assertion(await realpath(filename) === filename, `${path.basename(filename)} path is aliased`);
    return bytes;
  } finally {
    await handle.close();
  }
}

async function writeExclusiveFile(filename, bytes) {
  assertion(Buffer.isBuffer(bytes), "exclusive write requires exact bytes");
  const handle = await open(filename,
    constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | NOFOLLOW, 0o600);
  try {
    await handle.writeFile(bytes);
    await handle.sync();
  } finally {
    await handle.close();
  }
  const reread = await readRegularFile(filename, Math.max(bytes.length, 1), { allowEmpty: true });
  assertion(reread.equals(bytes), `${path.basename(filename)} differs after its fsync`);
}

function parseCanonicalJson(bytes, label) {
  assertion(bytes.length > 0 && bytes.at(-1) === 0x0a, `${label} is not newline terminated`);
  let value;
  try {
    value = JSON.parse(bytes.toString("utf8"));
  } catch {
    fail(`${label} is not JSON`);
  }
  assertion(canonicalBytes(value).equals(bytes), `${label} is not canonical JSON`);
  return value;
}

function parseEvents(bytes, identity, policy) {
  if (bytes.length === 0) return [];
  assertion(bytes.at(-1) === 0x0a, "events JSONL is not newline terminated");
  const lines = bytes.toString("utf8").slice(0, -1).split("\n");
  assertion(lines.length <= policy.max_proposals, "events exceed the proposal limit");
  return lines.map((line, index) => {
    let event;
    try {
      event = JSON.parse(line);
    } catch {
      fail(`event ${index + 1} is not JSON`);
    }
    assertion(canonicalWorkspaceJson(event) === line, `event ${index + 1} is not canonical JSON`);
    validateStoredEvent(event, identity, policy, index + 1);
    return event;
  });
}

function eventBytes(events) {
  if (events.length === 0) return Buffer.alloc(0);
  return Buffer.from(`${events.map(canonicalWorkspaceJson).join("\n")}\n`, "utf8");
}

function validateStoredEvent(event, identity, policy, expectedSequence) {
  assertion(event.contract?.name === "pdf-tools.verified-extraction-workspace-event"
    && event.contract?.version === "1.1.0-experimental", "event contract is unsupported");
  assertion(event.workspace_identity_sha256 === identity.workspace_identity_sha256,
    "event workspace binding drifted");
  assertion(event.event_sequence === expectedSequence, "event sequence is not append-only");
  assertion(identity.leaf_obligations.includes(event.leaf_pointer), "event leaf is not admitted");
  if (event.kind === "proposal_submitted") {
    exactKeys(event, [
      "contract", "event_id", "event_sequence", "kind", "workspace_identity_sha256",
      "leaf_pointer", "proposed_value", "chunk_ids", "verification",
    ], "workspace proposal event");
    assertion(Array.isArray(event.chunk_ids) && event.chunk_ids.length > 0
      && event.chunk_ids.length <= policy.max_chunk_refs_per_proposal,
    "event chunk references are invalid");
    assertion(new Set(event.chunk_ids).size === event.chunk_ids.length
      && event.chunk_ids.every(item => CHUNK_ID.test(item)
        && identity.returned_chunk_ids.includes(item)),
    "event references an unknown, duplicate, or omitted chunk");
    exactKeys(event.verification, ["status", "reason"], "event verification");
    assertion(event.verification.status === "unverified"
      && event.verification.reason === "not_replayed",
    "persisted proposal was promoted without deterministic replay");
    validateJsonValue(event.proposed_value, policy);
  } else if (event.kind === "proposal_verified") {
    exactKeys(event, [
      "contract", "event_id", "event_sequence", "kind", "workspace_identity_sha256",
      "leaf_pointer", "proposal_event_id", "verification_result",
    ], "workspace verification event");
    assertion(EVENT_ID.test(event.proposal_event_id ?? ""),
      "verification event proposal identity is invalid");
    validateRetainedVerificationResult(event.verification_result, identity, policy);
    assertion(event.verification_result.proposal_event_id === event.proposal_event_id
      && event.verification_result.leaf_pointer === event.leaf_pointer,
    "verification event result binding drifted");
  } else {
    fail("event kind is unsupported");
  }
  const body = { ...event };
  delete body.event_id;
  assertion(event.event_id === `event.${sha256Canonical(body)}`, "event digest is invalid");
  assertion(Buffer.byteLength(canonicalWorkspaceJson(event), "utf8") <= policy.max_event_utf8_bytes,
    "event exceeds its byte limit");
}

function validateRetainedVerificationResult(result, identity, policy) {
  assertion(result && typeof result === "object" && !Array.isArray(result),
    "verification result must be an object");
  assertion(result.workspace_identity_sha256 === identity.workspace_identity_sha256
    && result.source?.sha256 === identity.source.sha256
    && result.schema?.sha256 === identity.schema.sha256
    && result.document_map_sha256 === identity.document_map_sha256,
  "verification result static binding drifted");
  assertion(EVENT_ID.test(result.proposal_event_id ?? "")
    && identity.leaf_obligations.includes(result.leaf_pointer)
    && VERIFICATION_STATUSES.includes(result.status),
  "verification result identity or status is invalid");
  assertion(SHA256.test(result.verification_sha256 ?? ""),
    "verification result digest is invalid");
  const body = { ...result };
  delete body.verification_sha256;
  assertion(result.verification_sha256 === sha256Canonical(body),
    "verification result digest does not replay");
  validateJsonValue(result, policy);
  return result;
}

function deriveState(identity, events, generationSequence) {
  const proposalEvents = events.filter(event => event.kind === "proposal_submitted");
  const verificationEvents = events.filter(event => event.kind === "proposal_verified");
  const proposals = proposalEvents.map(event => ({
    event_id: event.event_id,
    leaf_pointer: event.leaf_pointer,
    proposed_value: event.proposed_value,
    chunk_ids: event.chunk_ids,
    verification: event.verification,
  }));
  const results = verificationEvents.map(event => event.verification_result);
  const latestEvents = new Map(events.map(event => [event.leaf_pointer, event]));
  const settledLeaves = new Set([...latestEvents.values()]
    .filter(event => event.kind === "proposal_verified")
    .filter(({ verification_result: result }) => (
      result.contract?.version === "1.0.0-experimental"
        ? LEGACY_SETTLED_VERIFICATION_STATUSES : SETTLED_VERIFICATION_STATUSES
    ).has(result.status))
    .map(event => event.leaf_pointer));
  const pendingLeaves = identity.leaf_obligations.filter(pointer => !settledLeaves.has(pointer));
  return {
    contract: {
      name: "pdf-tools.verified-extraction-workspace-state",
      version: "1.1.0-experimental",
    },
    workspace_identity_sha256: identity.workspace_identity_sha256,
    generation_sequence: generationSequence,
    event_count: events.length,
    proposal_count: proposals.length,
    pending_leaf_count: pendingLeaves.length,
    result_count: results.length,
    pending_leaves: pendingLeaves,
    proposals,
    results,
  };
}

function generationSha256(manifestBytes) {
  return sha256(Buffer.concat([
    Buffer.from("pdf-tools.verified-extraction-workspace-generation.v1\0", "utf8"),
    manifestBytes,
  ]));
}

function artifactRecord(role, filename, bytes) {
  return { role, filename, bytes: bytes.length, sha256: sha256(bytes), mode: "0600" };
}

function generationName(sequence, digest) {
  return `generation-${String(sequence).padStart(8, "0")}-${digest}`;
}

async function readWorkspaceStatic(workspacePath, expectedWorkspaceIdentitySha256 = null) {
  await assertPrivateDirectory(workspacePath, "workspace directory");
  const identityBytes = await readRegularFile(path.join(workspacePath, IDENTITY_FILE), MAX_STATIC_BYTES);
  const mapBytes = await readRegularFile(path.join(workspacePath, MAP_FILE), MAX_STATIC_BYTES);
  const schemaBytes = await readRegularFile(path.join(workspacePath, SCHEMA_FILE), MAX_STATIC_BYTES);
  const leavesBytes = await readRegularFile(path.join(workspacePath, LEAVES_FILE), MAX_STATIC_BYTES);
  const pointerBytes = await readRegularFile(path.join(workspacePath, POINTER_FILE), MAX_STATIC_BYTES);
  const identity = parseCanonicalJson(identityBytes, "workspace identity");
  const documentMap = parseCanonicalJson(mapBytes, "workspace document map");
  const leavesArtifact = parseCanonicalJson(leavesBytes, "workspace leaf obligations");
  const pointer = parseCanonicalJson(pointerBytes, "workspace retained pointer");
  exactKeys(identity, [
    "contract", "workspace_id", "workspace_identity_sha256", "source", "schema",
    "document_map_sha256", "document_map_contract", "renderer", "chunk_policy_sha256",
    "leaf_obligations", "leaf_obligations_sha256", "workspace_policy",
    "workspace_policy_sha256", "genesis_transaction_id", "workspace_directory_name",
    "package_inclusion",
  ], "workspace identity");
  assertion(canonicalWorkspaceJson(identity.contract) === canonicalWorkspaceJson(EXTRACTION_WORKSPACE_IDENTITY),
    "workspace contract is unsupported");
  assertion(WORKSPACE_ID.test(identity.workspace_id), "stored workspace_id is invalid");
  assertion(SHA256.test(identity.workspace_identity_sha256), "workspace identity digest is invalid");
  const identityBody = { ...identity };
  delete identityBody.workspace_identity_sha256;
  assertion(identity.workspace_identity_sha256 === sha256Canonical(identityBody),
    "workspace identity digest drifted");
  assertion(TRANSACTION_ID.test(identity.genesis_transaction_id),
    "workspace genesis transaction binding is invalid");
  const expectedDirectoryPrefix = `.initializing-${workspaceDirectoryName(identity.workspace_id)}-`
    + `${identity.genesis_transaction_id}-`;
  assertion(identity.workspace_directory_name.startsWith(expectedDirectoryPrefix)
    && /^[a-f0-9]{32}$/u.test(identity.workspace_directory_name.slice(expectedDirectoryPrefix.length)),
  "workspace directory identity is invalid");
  if (expectedWorkspaceIdentitySha256 !== null) {
    assertion(expectedWorkspaceIdentitySha256 === identity.workspace_identity_sha256,
      "workspace differs from its exact expected identity");
  }
  assertion(documentMap.document_map_sha256 === identity.document_map_sha256,
    "document map artifact drifted");
  const documentMapBody = { ...documentMap };
  delete documentMapBody.document_map_sha256;
  assertion(documentMap.document_map_sha256 === sha256Canonical(documentMapBody),
    "document map digest does not match the retained map bytes");
  assertion(canonicalWorkspaceJson(documentMap.contract) === canonicalWorkspaceJson(identity.document_map_contract)
    && canonicalWorkspaceJson(documentMap.bindings.source) === canonicalWorkspaceJson(identity.source)
    && canonicalWorkspaceJson(documentMap.bindings.schema) === canonicalWorkspaceJson(identity.schema)
    && canonicalWorkspaceJson(documentMap.bindings.renderer) === canonicalWorkspaceJson(identity.renderer)
    && documentMap.bindings.chunk_policy.sha256 === identity.chunk_policy_sha256,
  "document map artifact bindings drifted");
  assertion(schemaBytes.length === identity.schema.size_bytes
    && sha256(schemaBytes) === identity.schema.sha256,
  "workspace schema artifact drifted");
  exactKeys(leavesArtifact, ["contract", "items", "items_sha256"], "leaf obligations artifact");
  assertion(leavesArtifact.contract?.name === "pdf-tools.verified-extraction-leaf-obligations"
    && leavesArtifact.contract?.version === "1.0.0-experimental",
  "leaf obligations artifact contract is unsupported");
  assertion(leavesArtifact.items_sha256 === sha256Canonical(leavesArtifact.items)
    && leavesArtifact.items_sha256 === identity.leaf_obligations_sha256
    && canonicalWorkspaceJson(leavesArtifact.items) === canonicalWorkspaceJson(identity.leaf_obligations),
  "leaf obligations artifact drifted");
  const policy = normalizePolicy(identity.workspace_policy);
  assertion(identity.workspace_policy_sha256 === sha256Canonical(policy), "workspace policy digest drifted");
  assertion(identity.package_inclusion === "enabled_experimental", "workspace package boundary drifted");
  validateWorkspacePointer(pointer, {
    workspaceId: identity.workspace_id,
    expectedWorkspaceIdentitySha256: identity.workspace_identity_sha256,
  });
  assertion(pointer.workspace_directory_name === identity.workspace_directory_name,
    "workspace retained pointer directory binding drifted");
  return {
    identity,
    identityBytes,
    documentMap,
    mapBytes,
    schemaBytes,
    leavesArtifact,
    leavesBytes,
    pointer,
    pointerBytes,
    policy,
  };
}

async function inspectGenerationDirectory(generationPath, staticContext, { staging = false } = {}) {
  await assertPrivateDirectory(generationPath, staging ? "staging generation" : "published generation");
  const entries = (await readdir(generationPath, { withFileTypes: true }))
    .sort((left, right) => compareCodePoints(left.name, right.name));
  const names = entries.map(entry => entry.name);
  assertion(entries.every(entry => entry.isFile() && !entry.isSymbolicLink()
    && [EVENTS_FILE, STATE_FILE, MANIFEST_FILE].includes(entry.name)),
  "generation contains an unexpected entry, type, or symlink");
  for (const entry of entries) {
    const metadata = await lstat(path.join(generationPath, entry.name), { bigint: true });
    assertion(metadata.isFile() && !metadata.isSymbolicLink()
      && workspacePrivateModeMatchesForPlatform(metadata, 0o600),
      "generation artifact is not a physical 0600 file");
  }
  if (!names.includes(MANIFEST_FILE)) {
    return { state: "incomplete", reason: "commit_marker_missing", path: generationPath, names };
  }
  assertion(canonicalWorkspaceJson(names) === canonicalWorkspaceJson([
    EVENTS_FILE, MANIFEST_FILE, STATE_FILE,
  ].sort(compareCodePoints)), "generation file set is invalid");
  const eventsBytes = await readRegularFile(path.join(generationPath, EVENTS_FILE),
    MAX_GENERATION_FILE_BYTES, { allowEmpty: true });
  const stateBytes = await readRegularFile(path.join(generationPath, STATE_FILE), MAX_GENERATION_FILE_BYTES);
  const manifestBytes = await readRegularFile(path.join(generationPath, MANIFEST_FILE), MAX_STATIC_BYTES);
  const manifest = parseCanonicalJson(manifestBytes, "generation manifest");
  exactKeys(manifest, [
    "contract", "workspace_identity_sha256", "sequence", "transaction_id",
    "parent_generation_sha256", "state", "static_artifacts", "artifacts",
    ...(manifest.contract?.version === "1.1.0-experimental" ? ["event_count"] : []),
  ], "generation manifest");
  assertion(manifest.contract?.name === "pdf-tools.verified-extraction-workspace-generation"
    && ["1.0.0-experimental", "1.1.0-experimental"].includes(manifest.contract?.version),
  "generation manifest contract is unsupported");
  assertion(manifest.workspace_identity_sha256 === staticContext.identity.workspace_identity_sha256,
    "generation workspace binding drifted");
  boundedInteger(manifest.sequence, "generation sequence", 0,
    staticContext.policy.max_generations - 1);
  assertion(TRANSACTION_ID.test(manifest.transaction_id), "generation transaction_id is invalid");
  assertion(manifest.sequence === 0
    ? manifest.parent_generation_sha256 === null
    : SHA256.test(manifest.parent_generation_sha256 ?? ""),
  "generation parent binding is invalid");
  assertion(manifest.state === "complete", "generation manifest is not complete");
  const expectedStatic = [
    artifactRecord("workspace_identity", IDENTITY_FILE, staticContext.identityBytes),
    artifactRecord("document_map", MAP_FILE, staticContext.mapBytes),
    artifactRecord("schema", SCHEMA_FILE, staticContext.schemaBytes),
    artifactRecord("leaf_obligations", LEAVES_FILE, staticContext.leavesBytes),
    artifactRecord("workspace_pointer", POINTER_FILE, staticContext.pointerBytes),
  ].sort((left, right) => compareCodePoints(left.role, right.role));
  const expectedArtifacts = [
    artifactRecord("events", EVENTS_FILE, eventsBytes),
    artifactRecord("state", STATE_FILE, stateBytes),
  ].sort((left, right) => compareCodePoints(left.role, right.role));
  assertion(canonicalWorkspaceJson(manifest.static_artifacts) === canonicalWorkspaceJson(expectedStatic)
    && canonicalWorkspaceJson(manifest.artifacts) === canonicalWorkspaceJson(expectedArtifacts),
  "generation artifact inventory drifted");
  const events = parseEvents(eventsBytes, staticContext.identity, staticContext.policy);
  if (manifest.contract.version === "1.0.0-experimental") {
    assertion(events.length === manifest.sequence, "generation event count does not match its sequence");
  } else {
    boundedInteger(manifest.event_count, "generation event count", manifest.sequence,
      staticContext.policy.max_proposals);
    assertion(events.length === manifest.event_count, "generation event count does not replay");
    assertion(manifest.sequence > 0, "batch manifest cannot replace genesis");
  }
  const state = parseCanonicalJson(stateBytes, "generation state");
  const expectedState = deriveState(staticContext.identity, events, manifest.sequence);
  assertion(canonicalWorkspaceJson(state) === canonicalWorkspaceJson(expectedState),
    "generation state does not replay from append-only events");
  const digest = generationSha256(manifestBytes);
  if (staging) {
    const match = path.basename(generationPath).match(STAGING_NAME);
    assertion(match && match[1] === manifest.transaction_id,
      "staging generation transaction identity drifted");
  } else {
    const match = path.basename(generationPath).match(GENERATION_NAME);
    assertion(match && Number(match[1]) === manifest.sequence && match[2] === digest,
      "published generation directory identity drifted");
  }
  return {
    state: "complete",
    path: generationPath,
    manifest,
    manifestBytes,
    generation_sha256: digest,
    events,
    eventsBytes,
    currentState: state,
    stateByteLength: stateBytes.length,
  };
}

function validateWriterClaim(claim, label = "writer claim") {
  exactKeys(claim, [
    "contract", "workspace_identity_sha256", "transaction_id", "sequence",
    "parent_generation_sha256",
  ], label);
  assertion(claim.contract?.name === "pdf-tools.verified-extraction-workspace-claim"
    && claim.contract?.version === "1.0.0-experimental", `${label} contract is unsupported`);
  assertion(TRANSACTION_ID.test(claim.transaction_id), `${label} transaction_id is invalid`);
  return claim;
}

async function claimStatus(workspacePath) {
  const filename = path.join(workspacePath, CLAIM_FILE);
  try {
    const bytes = await readRegularFile(filename, MAX_STATIC_BYTES);
    const claim = validateWriterClaim(parseCanonicalJson(bytes, "writer claim"));
    return { present: true, filename, claim, bytes };
  } catch (error) {
    if (error?.code === "ENOENT") return { present: false, filename };
    throw error;
  }
}

async function scanWorkspace(workspacePath, staticContext, {
  allowClaim = false, maxRetainedWorkspaceBytes = MAX_RETAINED_WORKSPACE_BYTES,
} = {}) {
  boundedInteger(maxRetainedWorkspaceBytes, "retained workspace byte limit", 1,
    MAX_RETAINED_WORKSPACE_BYTES);
  const workspaceEntries = (await readdir(workspacePath, { withFileTypes: true }))
    .sort((left, right) => compareCodePoints(left.name, right.name));
  const archivedClaimTransactions = [];
  for (const entry of workspaceEntries) {
    const isStaticFile = [
      IDENTITY_FILE,
      MAP_FILE,
      SCHEMA_FILE,
      LEAVES_FILE,
      POINTER_FILE,
    ].includes(entry.name);
    const isClaim = entry.name === CLAIM_FILE;
    const isArchivedClaim = ABANDONED_CLAIM_NAME.test(entry.name);
    const isGenerations = entry.name === "generations";
    assertion((isStaticFile || isClaim || isArchivedClaim)
      ? entry.isFile() && !entry.isSymbolicLink()
      : isGenerations && entry.isDirectory() && !entry.isSymbolicLink(),
    "workspace contains an unexpected entry, type, or symlink");
    if (isArchivedClaim) {
      const bytes = await readRegularFile(path.join(workspacePath, entry.name), MAX_STATIC_BYTES);
      const archived = parseCanonicalJson(bytes, "abandoned writer claim");
      exactKeys(archived, [
        "contract", "workspace_identity_sha256", "transaction_id", "sequence",
        "parent_generation_sha256",
      ], "abandoned writer claim");
      assertion(archived.contract?.name === "pdf-tools.verified-extraction-workspace-claim"
        && archived.contract?.version === "1.0.0-experimental"
        && archived.workspace_identity_sha256 === staticContext.identity.workspace_identity_sha256
        && archived.transaction_id === entry.name.match(ABANDONED_CLAIM_NAME)[1],
      "abandoned writer claim binding drifted");
      boundedInteger(archived.sequence, "abandoned writer claim sequence", 0,
        staticContext.policy.max_generations - 1);
      assertion(archived.sequence === 0
        ? archived.parent_generation_sha256 === null
        : SHA256.test(archived.parent_generation_sha256 ?? ""),
      "abandoned writer claim parent binding is invalid");
      archivedClaimTransactions.push(archived.transaction_id);
    }
  }
  assertion([IDENTITY_FILE, MAP_FILE, SCHEMA_FILE, LEAVES_FILE, POINTER_FILE, "generations"]
    .every(name => workspaceEntries.some(entry => entry.name === name)),
  "workspace static inventory is incomplete");
  const generationsPath = path.join(workspacePath, "generations");
  await assertPrivateDirectory(generationsPath, "generations directory");
  const entries = (await readdir(generationsPath, { withFileTypes: true }))
    .sort((left, right) => compareCodePoints(left.name, right.name));
  // Preflight aggregate sizes before allocating any generation payloads.
  // Abandoned directories are not replayed or retained in memory.
  let preflightBytes = 0;
  for (const entry of entries) {
    if (!GENERATION_NAME.test(entry.name) && !STAGING_NAME.test(entry.name)) continue;
    assertion(entry.isDirectory() && !entry.isSymbolicLink(), "generation is not a physical directory");
    const generationPath = path.join(generationsPath, entry.name);
    await assertPrivateDirectory(generationPath, "generation directory");
    const files = await readdir(generationPath, { withFileTypes: true });
    assertion(files.length <= 3, "generation artifact inventory is oversized");
    for (const file of files) {
      assertion([EVENTS_FILE, STATE_FILE, MANIFEST_FILE].includes(file.name)
        && file.isFile() && !file.isSymbolicLink(), "generation contains an unexpected entry, type, or symlink");
      const metadata = await lstat(path.join(generationPath, file.name));
      assertion(metadata.isFile() && !metadata.isSymbolicLink(), "generation artifact is not a physical file");
      preflightBytes += metadata.size;
      assertion(preflightBytes <= maxRetainedWorkspaceBytes, "retained workspace byte limit exceeded");
    }
  }
  const complete = [];
  const incomplete = [];
  const abandoned = [];
  let retainedBytes = 0;
  const accountInspection = inspection => {
    if (inspection.state !== "complete") return;
    retainedBytes += inspection.eventsBytes.length + inspection.stateByteLength
      + inspection.manifestBytes.length;
    assertion(retainedBytes <= maxRetainedWorkspaceBytes, "retained workspace byte limit exceeded");
  };
  for (const entry of entries) {
    assertion(entry.isDirectory() && !entry.isSymbolicLink(), "generations contains a non-directory or symlink");
    const entryPath = path.join(generationsPath, entry.name);
    if (GENERATION_NAME.test(entry.name)) {
      const inspection = await inspectGenerationDirectory(entryPath, staticContext);
      assertion(inspection.state === "complete", "published generation lacks its commit marker");
      accountInspection(inspection);
      complete.push(inspection);
    } else if (STAGING_NAME.test(entry.name)) {
      const inspection = await inspectGenerationDirectory(entryPath, staticContext, { staging: true });
      accountInspection(inspection);
      incomplete.push(inspection);
    } else if (ABANDONED_NAME.test(entry.name)) {
      await assertNoLinksRecursively(entryPath);
      abandoned.push(entry.name);
    } else {
      fail("generations contains an unexpected entry");
    }
  }
  complete.sort((left, right) => left.manifest.sequence - right.manifest.sequence);
  if (complete.length === 0) {
    assertion(allowClaim, "workspace has no committed genesis generation");
  }
  for (let index = 0; index < complete.length; index += 1) {
    const generation = complete[index];
    assertion(generation.manifest.sequence === index, "generation sequence is missing, duplicated, or branched");
    assertion(index === 0
      ? generation.manifest.parent_generation_sha256 === null
      : generation.manifest.parent_generation_sha256 === complete[index - 1].generation_sha256,
    "generation parent chain drifted");
    if (index > 0) {
      const addedEvents = generation.events.length - complete[index - 1].events.length;
      assertion(addedEvents >= 1 && addedEvents <= 32,
        "generation must append 1 through 32 events");
      assertion(generation.eventsBytes.subarray(0, complete[index - 1].eventsBytes.length)
        .equals(complete[index - 1].eventsBytes), "event log is not an append-only prefix");
    }
  }
  const claim = await claimStatus(workspacePath);
  if (claim.present) {
    assertion(claim.claim.workspace_identity_sha256 === staticContext.identity.workspace_identity_sha256,
      "writer claim workspace binding drifted");
    boundedInteger(claim.claim.sequence, "writer claim sequence", 0,
      staticContext.policy.max_generations - 1);
    assertion(claim.claim.sequence === 0
      ? claim.claim.parent_generation_sha256 === null
      : SHA256.test(claim.claim.parent_generation_sha256 ?? ""),
    "writer claim parent binding is invalid");
  }
  if (!allowClaim) assertion(!claim.present, "workspace has an active or crash-retained writer claim");
  return {
    complete,
    retainedBytes: Math.max(preflightBytes, retainedBytes),
    current: complete.at(-1) ?? null,
    incomplete,
    abandoned,
    abandonedTransactionIds: [...new Set([
      ...archivedClaimTransactions,
      ...abandoned.map(name => name.match(ABANDONED_NAME)[1]),
    ])].sort(compareCodePoints),
    claim,
    state: complete.length === 0
      ? (claim.present || incomplete.length > 0
        ? "durability_uncertain"
        : "initialization_recovery_required")
      : (claim.present || incomplete.length > 0 ? "durability_uncertain" : "complete"),
  };
}

function makeManifest(staticContext, sequence, transactionId, parentDigest, eventsBytes, stateBytes, eventCount = sequence) {
  const hasBatchHistory = eventCount !== sequence;
  return {
    contract: {
      name: "pdf-tools.verified-extraction-workspace-generation",
      version: hasBatchHistory ? "1.1.0-experimental" : "1.0.0-experimental",
    },
    ...(hasBatchHistory ? { event_count: eventCount } : {}),
    workspace_identity_sha256: staticContext.identity.workspace_identity_sha256,
    sequence,
    transaction_id: transactionId,
    parent_generation_sha256: parentDigest,
    state: "complete",
    static_artifacts: [
      artifactRecord("workspace_identity", IDENTITY_FILE, staticContext.identityBytes),
      artifactRecord("document_map", MAP_FILE, staticContext.mapBytes),
      artifactRecord("schema", SCHEMA_FILE, staticContext.schemaBytes),
      artifactRecord("leaf_obligations", LEAVES_FILE, staticContext.leavesBytes),
      artifactRecord("workspace_pointer", POINTER_FILE, staticContext.pointerBytes),
    ].sort((left, right) => compareCodePoints(left.role, right.role)),
    artifacts: [
      artifactRecord("events", EVENTS_FILE, eventsBytes),
      artifactRecord("state", STATE_FILE, stateBytes),
    ].sort((left, right) => compareCodePoints(left.role, right.role)),
  };
}

async function inject(faultInjector, phase, context) {
  if (faultInjector) await faultInjector(phase, context);
}

async function workspaceOperationAuthorityStatus(rootPath, workspaceId) {
  const filename = workspaceDeletionIntentPathFor(rootPath, workspaceId);
  try {
    const bytes = await readRegularFile(filename, MAX_STATIC_BYTES, { allowEmpty: true });
    try {
      const value = parseCanonicalJson(bytes, "workspace operation authority");
      if (value.contract?.name === "pdf-tools.verified-extraction-workspace-claim") {
        return {
          present: true,
          kind: "writer",
          filename,
          bytes,
          claim: validateWriterClaim(value, "external writer authority"),
        };
      }
    } catch {
      // A torn or non-writer authority remains deletion-shaped and fail-closed.
    }
    return { present: true, kind: "deletion", filename, bytes };
  } catch (error) {
    if (error?.code === "ENOENT") return { present: false, kind: "absent", filename };
    throw error;
  }
}

async function acquireWriterAuthority({
  workspacePath,
  staticContext,
  claim,
  faultInjector,
}) {
  const root = path.dirname(workspacePath);
  const claimPath = path.join(workspacePath, CLAIM_FILE);
  const authorityPath = workspaceDeletionIntentPathFor(root, staticContext.identity.workspace_id);
  const claimBytes = canonicalBytes(claim);
  await inject(faultInjector, "before_writer_authority", { claim, claimPath, authorityPath });
  await writeExclusiveFile(claimPath, claimBytes);
  await fsyncDirectory(workspacePath);
  await inject(faultInjector, "after_internal_claim_before_writer_authority", {
    claim,
    claimPath,
    authorityPath,
  });
  try {
    await link(claimPath, authorityPath);
  } catch (error) {
    try {
      await unlink(claimPath);
    } catch (cleanupError) {
      if (cleanupError?.code !== "ENOENT") throw cleanupError;
    }
    await fsyncDirectory(workspacePath);
    throw error;
  }
  await inject(faultInjector, "after_writer_authority_link_before_fsync", {
    claim,
    claimPath,
    authorityPath,
  });
  await fsyncDirectory(root);
  const authorityBytes = await readRegularFile(authorityPath, MAX_STATIC_BYTES);
  assertion(authorityBytes.equals(claimBytes), "external writer authority differs from its retained claim");
  return { claimPath, authorityPath, claimBytes };
}

async function releaseWriterAuthority({
  workspacePath,
  staticContext,
  claimBytes,
  claimPath = path.join(workspacePath, CLAIM_FILE),
  allowMissingAuthority = false,
}) {
  const root = path.dirname(workspacePath);
  const authorityPath = workspaceDeletionIntentPathFor(root, staticContext.identity.workspace_id);
  try {
    const authorityBytes = await readRegularFile(authorityPath, MAX_STATIC_BYTES);
    assertion(authorityBytes.equals(claimBytes), "external writer authority changed before release");
    await unlink(authorityPath);
    await fsyncDirectory(root);
  } catch (error) {
    if (!(allowMissingAuthority && error?.code === "ENOENT")) throw error;
  }
  await unlink(claimPath);
  await fsyncDirectory(workspacePath);
}

async function publishGeneration({
  workspacePath,
  staticContext,
  events,
  transactionId,
  expectedParentGenerationSha256,
  faultInjector = null,
  maxRetainedWorkspaceBytes = MAX_RETAINED_WORKSPACE_BYTES,
}) {
  assertion(TRANSACTION_ID.test(transactionId), "transaction_id is invalid");
  const before = await scanWorkspace(workspacePath, staticContext, { maxRetainedWorkspaceBytes });
  assertion(before.current.generation_sha256 === expectedParentGenerationSha256,
    "current generation differs from the exact expected parent");
  const sequence = before.current.manifest.sequence + 1;
  assertion(sequence < staticContext.policy.max_generations,
    "workspace generation retention limit reached; explicit deletion is required");
  const addedEvents = events.length - before.current.events.length;
  assertion(addedEvents >= 1 && addedEvents <= 32 && events.length <= staticContext.policy.max_proposals,
    "event sequence or proposal limit is invalid");
  const eventsBytes = eventBytes(events);
  const stateBytes = canonicalBytes(deriveState(staticContext.identity, events, sequence));
  assertion(eventsBytes.subarray(0, before.current.eventsBytes.length).equals(before.current.eventsBytes),
    "event log is not an append-only prefix");
  assertion(eventsBytes.length <= MAX_GENERATION_FILE_BYTES
    && stateBytes.length <= MAX_GENERATION_FILE_BYTES,
  "generation exceeds the retained byte limit");
  assertion(!before.complete.some(item => item.manifest.transaction_id === transactionId),
    "transaction_id was already consumed");
  assertion(!before.abandonedTransactionIds.includes(transactionId),
    "transaction_id was already abandoned and cannot be replaced");
  const manifest = makeManifest(staticContext, sequence, transactionId,
    expectedParentGenerationSha256, eventsBytes, stateBytes, events.length);
  const manifestBytes = canonicalBytes(manifest);
  assertion(before.retainedBytes + eventsBytes.length + stateBytes.length + manifestBytes.length
    <= maxRetainedWorkspaceBytes, "retained workspace byte limit exceeded");
  const claim = {
    contract: { name: "pdf-tools.verified-extraction-workspace-claim", version: "1.0.0-experimental" },
    workspace_identity_sha256: staticContext.identity.workspace_identity_sha256,
    transaction_id: transactionId,
    sequence,
    parent_generation_sha256: expectedParentGenerationSha256,
  };
  const writerAuthority = await acquireWriterAuthority({
    workspacePath,
    staticContext,
    claim,
    faultInjector,
  });
  const claimed = await scanWorkspace(workspacePath, staticContext, {
    allowClaim: true, maxRetainedWorkspaceBytes,
  });
  assertion(claimed.claim.present
    && canonicalWorkspaceJson(claimed.claim.claim) === canonicalWorkspaceJson(claim),
  "writer claim changed after exclusive acquisition");
  assertion(claimed.current?.generation_sha256 === expectedParentGenerationSha256
    && claimed.current?.manifest.sequence + 1 === sequence,
  "workspace advanced before the writer claim became authoritative");
  assertion(claimed.retainedBytes + eventsBytes.length + stateBytes.length + manifestBytes.length
    <= maxRetainedWorkspaceBytes, "retained workspace byte limit exceeded");
  await inject(faultInjector, "after_claim", { claim });
  const generationsPath = path.join(workspacePath, "generations");
  const stagingPath = path.join(generationsPath, `.staging-${transactionId}`);
  await mkdir(stagingPath, { mode: 0o700 });
  await assertPrivateDirectory(stagingPath, "staging generation");
  await inject(faultInjector, "after_staging_directory", { stagingPath });
  await writeExclusiveFile(path.join(stagingPath, EVENTS_FILE), eventsBytes);
  await writeExclusiveFile(path.join(stagingPath, STATE_FILE), stateBytes);
  await inject(faultInjector, "after_generation_artifacts", { stagingPath });
  const digest = generationSha256(manifestBytes);
  await writeExclusiveFile(path.join(stagingPath, MANIFEST_FILE), manifestBytes);
  await fsyncDirectory(stagingPath);
  await inject(faultInjector, "after_commit_marker", { stagingPath, digest });
  const stagingInspection = await inspectGenerationDirectory(stagingPath, staticContext, { staging: true });
  assertion(stagingInspection.generation_sha256 === digest, "staging generation digest drifted");
  const finalPath = path.join(generationsPath, generationName(sequence, digest));
  await rename(stagingPath, finalPath);
  await fsyncDirectory(generationsPath);
  await inject(faultInjector, "after_generation_rename", { finalPath, digest });
  const finalInspection = await inspectGenerationDirectory(finalPath, staticContext);
  assertion(finalInspection.generation_sha256 === digest, "published generation digest drifted");
  await releaseWriterAuthority({
    workspacePath,
    staticContext,
    claimBytes: writerAuthority.claimBytes,
    claimPath: writerAuthority.claimPath,
  });
  await inject(faultInjector, "after_claim_cleanup", { finalPath, digest });
  const terminal = await scanWorkspace(workspacePath, staticContext, { maxRetainedWorkspaceBytes });
  assertion(terminal.current.generation_sha256 === digest, "terminal generation drifted");
  return terminal.current;
}

async function publishGenesis({ workspacePath, staticContext, transactionId, faultInjector }) {
  assertion(TRANSACTION_ID.test(transactionId), "genesis transaction_id is invalid");
  const claim = {
    contract: { name: "pdf-tools.verified-extraction-workspace-claim", version: "1.0.0-experimental" },
    workspace_identity_sha256: staticContext.identity.workspace_identity_sha256,
    transaction_id: transactionId,
    sequence: 0,
    parent_generation_sha256: null,
  };
  const writerAuthority = await acquireWriterAuthority({
    workspacePath,
    staticContext,
    claim,
    faultInjector,
  });
  await inject(faultInjector, "after_claim", { claim });
  const generationsPath = path.join(workspacePath, "generations");
  const stagingPath = path.join(generationsPath, `.staging-${transactionId}`);
  await mkdir(stagingPath, { mode: 0o700 });
  const eventsBytes = Buffer.alloc(0);
  const stateBytes = canonicalBytes(deriveState(staticContext.identity, [], 0));
  assertion(stateBytes.length <= MAX_GENERATION_FILE_BYTES,
    "genesis state exceeds the retained byte limit");
  await writeExclusiveFile(path.join(stagingPath, EVENTS_FILE), eventsBytes);
  await writeExclusiveFile(path.join(stagingPath, STATE_FILE), stateBytes);
  await inject(faultInjector, "after_generation_artifacts", { stagingPath });
  const manifestBytes = canonicalBytes(makeManifest(staticContext, 0, transactionId, null,
    eventsBytes, stateBytes));
  const digest = generationSha256(manifestBytes);
  await writeExclusiveFile(path.join(stagingPath, MANIFEST_FILE), manifestBytes);
  await fsyncDirectory(stagingPath);
  await inject(faultInjector, "after_commit_marker", { stagingPath, digest });
  const finalPath = path.join(generationsPath, generationName(0, digest));
  await rename(stagingPath, finalPath);
  await fsyncDirectory(generationsPath);
  await inject(faultInjector, "after_generation_rename", { finalPath, digest });
  await inspectGenerationDirectory(finalPath, staticContext);
  await releaseWriterAuthority({
    workspacePath,
    staticContext,
    claimBytes: writerAuthority.claimBytes,
    claimPath: writerAuthority.claimPath,
  });
  const terminal = await scanWorkspace(workspacePath, staticContext);
  return terminal.current;
}

function workspacePointerPathFor(rootPath, workspaceId) {
  return path.join(rootPath, `${workspaceDirectoryName(workspaceId)}.pointer.v1.json`);
}

function workspaceDeletionIntentPathFor(rootPath, workspaceId) {
  return path.join(rootPath, `${workspaceDirectoryName(workspaceId)}.deletion-intent.v1.json`);
}

function creatorAuthorityStem(workspaceId, transactionId) {
  workspaceDirectoryName(workspaceId);
  assertion(TRANSACTION_ID.test(transactionId ?? ""), "creator authority transaction_id is invalid");
  return sha256(Buffer.from(`${workspaceId}\0${transactionId}`, "utf8"));
}

function initializationCreatorClaimPath(rootPath, workspaceId, transactionId) {
  return path.join(rootPath, `.creator-${creatorAuthorityStem(workspaceId, transactionId)}${CREATOR_CLAIM_SUFFIX}`);
}

function initializationAbandonmentPath(rootPath, workspaceId, transactionId) {
  return path.join(rootPath,
    `.creator-${creatorAuthorityStem(workspaceId, transactionId)}${CREATOR_ABANDONMENT_SUFFIX}`);
}

function creatorOperationLeasePath(rootPath, workspaceId, transactionId) {
  return path.join(rootPath,
    `.creator-${creatorAuthorityStem(workspaceId, transactionId)}.operation-lease.v1.json`);
}

function creatorOperationLeaseBody({ workspaceId, transactionId, token }) {
  return {
    contract: {
      name: "pdf-tools.verified-extraction-workspace-creator-operation-lease",
      version: "1.0.0-experimental",
    },
    workspace_id: workspaceId,
    transaction_id: transactionId,
    owner_pid: process.pid,
    token,
  };
}

function validateCreatorOperationLease(lease, expected) {
  exactKeys(lease, [
    "contract", "workspace_id", "transaction_id", "owner_pid", "token",
  ], "workspace creator operation lease");
  assertion(lease.contract?.name
    === "pdf-tools.verified-extraction-workspace-creator-operation-lease"
    && lease.contract?.version === "1.0.0-experimental",
  "workspace creator operation lease contract is unsupported");
  assertion(lease.workspace_id === expected.workspaceId
    && lease.transaction_id === expected.transactionId
    && Number.isSafeInteger(lease.owner_pid) && lease.owner_pid > 0
    && typeof lease.token === "string" && /^[a-f0-9]{32}$/u.test(lease.token),
  "workspace creator operation lease binding is invalid");
  return lease;
}

function processAppearsAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    if (error?.code === "ESRCH") return false;
    return true;
  }
}

async function acquireCreatorOperationLease(rootPath, workspaceId, transactionId) {
  const leasePath = creatorOperationLeasePath(rootPath, workspaceId, transactionId);
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const token = randomBytes(16).toString("hex");
    const candidatePath = `${leasePath}.candidate-${token}`;
    const leaseBytes = canonicalBytes(creatorOperationLeaseBody({
      workspaceId,
      transactionId,
      token,
    }));
    await writeExclusiveFile(candidatePath, leaseBytes);
    let published = false;
    try {
      await link(candidatePath, leasePath);
      published = true;
      await unlink(candidatePath);
      await fsyncDirectory(rootPath);
      const retained = await readRegularFile(leasePath, MAX_STATIC_BYTES);
      assertion(retained.equals(leaseBytes),
        "workspace creator operation lease changed after acquisition");
      const acquiredIdentity = await lstat(leasePath, { bigint: true });
      let released = false;
      return async () => {
        assertion(!released, "workspace creator operation lease was released twice");
        const currentIdentity = await lstat(leasePath, { bigint: true });
        assertion(sameFileIdentity(acquiredIdentity, currentIdentity),
          "workspace creator operation lease physical identity changed before release");
        const current = await readRegularFile(leasePath, MAX_STATIC_BYTES);
        assertion(current.equals(leaseBytes),
          "workspace creator operation lease changed before release");
        await unlink(leasePath);
        await fsyncDirectory(rootPath);
        released = true;
      };
    } catch (error) {
      if (published) {
        try {
          const publishedBytes = await readRegularFile(leasePath, MAX_STATIC_BYTES);
          assertion(publishedBytes.equals(leaseBytes),
            "published creator operation lease changed during failed acquisition");
          await unlink(leasePath);
          try {
            await unlink(candidatePath);
          } catch (candidateError) {
            if (candidateError?.code !== "ENOENT") throw candidateError;
          }
          await fsyncDirectory(rootPath);
        } catch (cleanupError) {
          throw new AggregateError(
            [error, cleanupError],
            "Failed to clean a published creator operation lease after acquisition failure",
          );
        }
        throw error;
      } else {
        try {
          await unlink(candidatePath);
        } catch (cleanupError) {
          if (cleanupError?.code !== "ENOENT") throw cleanupError;
        }
      }
      if (error?.code !== "EEXIST") throw error;
      const activeBytes = await readRegularFile(leasePath, MAX_STATIC_BYTES);
      const activeLease = validateCreatorOperationLease(
        parseCanonicalJson(activeBytes, "workspace creator operation lease"),
        { workspaceId, transactionId },
      );
      if (processAppearsAlive(activeLease.owner_pid)) {
        fail("workspace creator or abandonment operation is already active");
      }
      const before = await lstat(leasePath, { bigint: true });
      const stalePath = `${leasePath}.stale-${token}`;
      await rename(leasePath, stalePath);
      const after = await lstat(stalePath, { bigint: true });
      assertion(before.dev === after.dev && before.ino === after.ino && before.size === after.size,
        "workspace creator operation lease changed during stale recovery");
      const staleBytes = await readRegularFile(stalePath, MAX_STATIC_BYTES);
      assertion(staleBytes.equals(activeBytes),
        "workspace creator operation lease bytes changed during stale recovery");
      await unlink(stalePath);
      await fsyncDirectory(rootPath);
    }
  }
  fail("workspace creator operation lease could not be acquired");
}

function creatorClaimBody({ workspaceId, transactionId, initializationDirectoryName,
  workspaceIdentitySha256 }) {
  return {
    contract: { name: "pdf-tools.verified-extraction-workspace-creator-claim", version: "1.0.0-experimental" },
    workspace_id: workspaceId,
    transaction_id: transactionId,
    initialization_directory_name: initializationDirectoryName,
    workspace_identity_sha256: workspaceIdentitySha256,
  };
}

function validateCreatorClaim(claim, expected) {
  exactKeys(claim, [
    "contract", "workspace_id", "transaction_id", "initialization_directory_name",
    "workspace_identity_sha256",
  ], "workspace creator claim");
  assertion(claim.contract?.name === "pdf-tools.verified-extraction-workspace-creator-claim"
    && claim.contract?.version === "1.0.0-experimental",
  "workspace creator claim contract is unsupported");
  assertion(claim.workspace_id === expected.workspaceId
    && claim.transaction_id === expected.transactionId
    && claim.initialization_directory_name === expected.initializationDirectoryName
    && claim.workspace_identity_sha256 === expected.workspaceIdentitySha256,
  "workspace creator claim binding drifted");
  return claim;
}

function creatorAbandonmentBody({ workspaceId, transactionId, initializationDirectoryName,
  workspaceIdentitySha256, creatorClaimSha256 }) {
  return {
    contract: {
      name: "pdf-tools.verified-extraction-workspace-creator-abandonment",
      version: "1.0.0-experimental",
    },
    workspace_id: workspaceId,
    transaction_id: transactionId,
    initialization_directory_name: initializationDirectoryName,
    workspace_identity_sha256: workspaceIdentitySha256,
    creator_claim_sha256: creatorClaimSha256,
    transaction_reusable: false,
  };
}

function validateCreatorAbandonment(abandonment, expected) {
  exactKeys(abandonment, [
    "contract", "workspace_id", "transaction_id", "initialization_directory_name",
    "workspace_identity_sha256", "creator_claim_sha256", "transaction_reusable",
  ], "workspace creator abandonment");
  assertion(abandonment.contract?.name
    === "pdf-tools.verified-extraction-workspace-creator-abandonment"
    && abandonment.contract?.version === "1.0.0-experimental",
  "workspace creator abandonment contract is unsupported");
  assertion(abandonment.workspace_id === expected.workspaceId
    && abandonment.transaction_id === expected.transactionId
    && abandonment.initialization_directory_name === expected.initializationDirectoryName
    && abandonment.workspace_identity_sha256 === expected.workspaceIdentitySha256
    && abandonment.creator_claim_sha256 === expected.creatorClaimSha256
    && abandonment.transaction_reusable === false,
  "workspace creator abandonment binding drifted");
  return abandonment;
}

function validateInitializationIdentity(identity, expected) {
  exactKeys(identity, [
    "contract", "workspace_id", "workspace_identity_sha256", "source", "schema",
    "document_map_sha256", "document_map_contract", "renderer", "chunk_policy_sha256",
    "leaf_obligations", "leaf_obligations_sha256", "workspace_policy",
    "workspace_policy_sha256", "genesis_transaction_id", "workspace_directory_name",
    "package_inclusion",
  ], "workspace initialization identity");
  assertion(canonicalWorkspaceJson(identity.contract)
    === canonicalWorkspaceJson(EXTRACTION_WORKSPACE_IDENTITY),
  "workspace initialization contract is unsupported");
  const identityBody = { ...identity };
  delete identityBody.workspace_identity_sha256;
  assertion(identity.workspace_identity_sha256 === sha256Canonical(identityBody),
    "workspace initialization identity digest drifted");
  assertion(identity.workspace_id === expected.workspaceId
    && identity.genesis_transaction_id === expected.transactionId
    && identity.workspace_directory_name === expected.initializationDirectoryName
    && identity.workspace_identity_sha256 === expected.workspaceIdentitySha256,
  "workspace initialization identity binding drifted");
  return identity;
}

async function assertPathAbsent(filename, label) {
  try {
    await lstat(filename);
    fail(`${label} already exists`);
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
  }
}

function validateWorkspacePointer(pointer, { workspaceId, expectedWorkspaceIdentitySha256 }) {
  exactKeys(pointer, [
    "contract", "workspace_id", "workspace_identity_sha256", "workspace_directory_name",
  ], "workspace pointer");
  assertion(pointer.contract?.name === "pdf-tools.verified-extraction-workspace-pointer"
    && pointer.contract?.version === "1.0.0-experimental",
  "workspace pointer contract is unsupported");
  assertion(pointer.workspace_id === workspaceId, "workspace pointer workspace_id drifted");
  assertion(pointer.workspace_identity_sha256 === expectedWorkspaceIdentitySha256,
    "workspace differs from its exact expected identity");
  const prefix = `.initializing-${workspaceDirectoryName(workspaceId)}-`;
  assertion(typeof pointer.workspace_directory_name === "string"
    && pointer.workspace_directory_name.startsWith(prefix)
    && /^[a-f0-9]{32,64}-[a-f0-9]{32}$/u.test(
      pointer.workspace_directory_name.slice(prefix.length)),
  "workspace pointer directory identity is invalid");
  return pointer;
}

function initializationDirectoryNameFor(workspaceId, transactionId) {
  return [
    ".initializing",
    workspaceDirectoryName(workspaceId),
    transactionId,
    randomBytes(16).toString("hex"),
  ].join("-");
}

function normalizeTransactionId(value) {
  const result = value ?? randomBytes(16).toString("hex");
  assertion(TRANSACTION_ID.test(result), "transaction_id is invalid");
  return result;
}

export async function createExtractionWorkspace({
  rootPath,
  workspaceId,
  documentMap,
  sourceBytes,
  schemaBytes,
  layouts,
  chunkPolicy = DEFAULT_DOCUMENT_MAP_CHUNK_POLICY,
  leafObligations,
  workspacePolicy = DEFAULT_EXTRACTION_WORKSPACE_POLICY,
  transactionId = null,
  faultInjector = null,
}) {
  const root = await ensurePrivateRoot(rootPath, faultInjector);
  workspaceDirectoryName(workspaceId);
  const policy = normalizePolicy(workspacePolicy);
  const leaves = normalizeLeaves(leafObligations, policy);
  const genesisTransactionId = normalizeTransactionId(transactionId);
  const dataDirectoryName = initializationDirectoryNameFor(workspaceId, genesisTransactionId);
  const deletionIntentPath = workspaceDeletionIntentPathFor(root, workspaceId);
  await assertPathAbsent(deletionIntentPath, "workspace deletion intent");
  validateSourceBoundDocumentMap(documentMap, {
    sourceBytes, schemaBytes, layouts, chunkPolicy,
  });
  const returnedChunkIds = documentMap.chunks.descriptors.map(item => item.chunk_id);
  assertion(new Set(returnedChunkIds).size === returnedChunkIds.length,
    "document map contains duplicate returned chunks");
  const identityBody = {
    contract: { ...EXTRACTION_WORKSPACE_IDENTITY },
    workspace_id: workspaceId,
    source: documentMap.bindings.source,
    schema: documentMap.bindings.schema,
    document_map_sha256: documentMap.document_map_sha256,
    document_map_contract: documentMap.contract,
    renderer: documentMap.bindings.renderer,
    chunk_policy_sha256: documentMap.bindings.chunk_policy.sha256,
    leaf_obligations: leaves,
    leaf_obligations_sha256: sha256Canonical(leaves),
    workspace_policy: policy,
    workspace_policy_sha256: sha256Canonical(policy),
    genesis_transaction_id: genesisTransactionId,
    workspace_directory_name: dataDirectoryName,
    package_inclusion: "enabled_experimental",
  };
  const identity = {
    ...identityBody,
    workspace_identity_sha256: sha256Canonical(identityBody),
  };
  const pointer = {
    contract: { name: "pdf-tools.verified-extraction-workspace-pointer", version: "1.0.0-experimental" },
    workspace_id: workspaceId,
    workspace_identity_sha256: identity.workspace_identity_sha256,
    workspace_directory_name: dataDirectoryName,
  };
  const pointerPath = workspacePointerPathFor(root, workspaceId);
  const initializationPath = path.join(root, dataDirectoryName);
  const creatorClaimPath = initializationCreatorClaimPath(root, workspaceId, genesisTransactionId);
  const creatorAbandonmentPath = initializationAbandonmentPath(
    root,
    workspaceId,
    genesisTransactionId,
  );
  const creatorClaimBytes = canonicalBytes(creatorClaimBody({
    workspaceId,
    transactionId: genesisTransactionId,
    initializationDirectoryName: dataDirectoryName,
    workspaceIdentitySha256: identity.workspace_identity_sha256,
  }));
  const releaseCreatorOperation = await acquireCreatorOperationLease(
    root,
    workspaceId,
    genesisTransactionId,
  );
  try {
    await assertPathAbsent(creatorAbandonmentPath,
      "workspace creator transaction abandonment tombstone");
    await inject(faultInjector, "after_creator_abandonment_check", {
    creatorClaimPath,
    creatorAbandonmentPath,
    initializationPath,
    pointerPath,
    workspaceIdentitySha256: identity.workspace_identity_sha256,
    creatorClaimSha256: sha256(creatorClaimBytes),
    transactionId: genesisTransactionId,
  });
    await writeExclusiveFile(creatorClaimPath, creatorClaimBytes);
    let abandonmentAppeared = false;
    try {
      await lstat(creatorAbandonmentPath);
      abandonmentAppeared = true;
    } catch (error) {
      if (error?.code !== "ENOENT") throw error;
    }
    if (abandonmentAppeared) {
      try {
        const retainedClaimBytes = await readRegularFile(creatorClaimPath, MAX_STATIC_BYTES);
        assertion(retainedClaimBytes.equals(creatorClaimBytes),
          "creator claim changed while rejecting an abandoned transaction");
        await unlink(creatorClaimPath);
      } catch (error) {
        if (error?.code !== "ENOENT") throw error;
      }
      await fsyncDirectory(root);
      fail("workspace creator transaction abandonment tombstone appeared during claim acquisition");
    }
    await inject(faultInjector, "after_creator_claim_abandonment_recheck", {
      creatorClaimPath,
      creatorAbandonmentPath,
      initializationPath,
      pointerPath,
      workspaceIdentitySha256: identity.workspace_identity_sha256,
      creatorClaimSha256: sha256(creatorClaimBytes),
      transactionId: genesisTransactionId,
    });
    await fsyncDirectory(root);
    await inject(faultInjector, "after_creator_claim", {
    creatorClaimPath,
    initializationPath,
    pointerPath,
    workspaceIdentitySha256: identity.workspace_identity_sha256,
    creatorClaimSha256: sha256(creatorClaimBytes),
    transactionId: genesisTransactionId,
  });
    await mkdir(initializationPath, { mode: 0o700 });
  await assertPrivateDirectory(initializationPath, "workspace initialization directory");
  await inject(faultInjector, "after_initialization_directory", {
    initializationPath,
    pointerPath,
    workspaceIdentitySha256: identity.workspace_identity_sha256,
    transactionId: genesisTransactionId,
  });
  const generationsPath = path.join(initializationPath, "generations");
  await mkdir(generationsPath, { mode: 0o700 });
  await fsyncDirectory(initializationPath);
  await inject(faultInjector, "after_initialization_generations_directory", {
    initializationPath,
    pointerPath,
    workspaceIdentitySha256: identity.workspace_identity_sha256,
    transactionId: genesisTransactionId,
  });
  const leavesArtifact = {
    contract: { name: "pdf-tools.verified-extraction-leaf-obligations", version: "1.0.0-experimental" },
    items: leaves,
    items_sha256: sha256Canonical(leaves),
  };
  const identityBytes = canonicalBytes(identity);
  const mapBytes = canonicalBytes(documentMap);
  const retainedSchemaBytes = Buffer.from(schemaBytes);
  const leavesBytes = canonicalBytes(leavesArtifact);
  const pointerBytes = canonicalBytes(pointer);
  assertion(identityBytes.length <= MAX_STATIC_BYTES && mapBytes.length <= MAX_STATIC_BYTES
    && retainedSchemaBytes.length <= MAX_STATIC_BYTES
    && leavesBytes.length <= MAX_STATIC_BYTES && pointerBytes.length <= MAX_STATIC_BYTES,
  "workspace static artifact exceeds its byte limit");
  await writeExclusiveFile(path.join(initializationPath, IDENTITY_FILE), identityBytes);
  await inject(faultInjector, "after_initialization_identity", {
    initializationPath,
    pointerPath,
    workspaceIdentitySha256: identity.workspace_identity_sha256,
    transactionId: genesisTransactionId,
  });
  await writeExclusiveFile(path.join(initializationPath, MAP_FILE), mapBytes);
  await inject(faultInjector, "after_initialization_map", {
    initializationPath,
    pointerPath,
    workspaceIdentitySha256: identity.workspace_identity_sha256,
    transactionId: genesisTransactionId,
  });
  await writeExclusiveFile(path.join(initializationPath, SCHEMA_FILE), retainedSchemaBytes);
  await inject(faultInjector, "after_initialization_schema", {
    initializationPath,
    pointerPath,
    workspaceIdentitySha256: identity.workspace_identity_sha256,
    transactionId: genesisTransactionId,
  });
  await writeExclusiveFile(path.join(initializationPath, LEAVES_FILE), leavesBytes);
  await inject(faultInjector, "after_initialization_leaves", {
    initializationPath,
    pointerPath,
    workspaceIdentitySha256: identity.workspace_identity_sha256,
    transactionId: genesisTransactionId,
  });
  const retainedPointerPath = path.join(initializationPath, POINTER_FILE);
  await writeExclusiveFile(retainedPointerPath, pointerBytes);
  await inject(faultInjector, "after_initialization_pointer", {
    initializationPath,
    pointerPath,
    workspaceIdentitySha256: identity.workspace_identity_sha256,
    transactionId: genesisTransactionId,
  });
  await fsyncDirectory(initializationPath);
  await fsyncDirectory(root);
  await inject(faultInjector, "after_initialization_fsync", {
    initializationPath,
    pointerPath,
    workspaceIdentitySha256: identity.workspace_identity_sha256,
    transactionId: genesisTransactionId,
  });
  await inject(faultInjector, "before_workspace_publish", {
    initializationPath,
    pointerPath,
    workspaceIdentitySha256: identity.workspace_identity_sha256,
    transactionId: genesisTransactionId,
  });
  await assertPathAbsent(deletionIntentPath, "workspace deletion intent");
  await link(retainedPointerPath, pointerPath);
  await inject(faultInjector, "after_workspace_pointer_link", {
    initializationPath,
    pointerPath,
    workspaceIdentitySha256: identity.workspace_identity_sha256,
    transactionId: genesisTransactionId,
  });
  await fsyncDirectory(root);
  const workspacePath = initializationPath;
  await assertPrivateDirectory(workspacePath, "workspace directory");
  await inject(faultInjector, "after_static_artifacts", {
    workspacePath,
    pointerPath,
    workspaceIdentitySha256: identity.workspace_identity_sha256,
    transactionId: genesisTransactionId,
  });
  const staticContext = await readWorkspaceStatic(workspacePath, identity.workspace_identity_sha256);
  staticContext.identity.returned_chunk_ids = returnedChunkIds;
  const genesis = await publishGenesis({
    workspacePath,
    staticContext,
    transactionId: genesisTransactionId,
    faultInjector,
  });
  await unlink(creatorClaimPath);
  await fsyncDirectory(root);
    return {
      workspace_id: workspaceId,
      workspace_path: workspacePath,
      workspace_identity_sha256: identity.workspace_identity_sha256,
      workspace_pointer_sha256: sha256(pointerBytes),
      creator_claim_sha256: sha256(creatorClaimBytes),
      generation_sha256: genesis.generation_sha256,
      generation_sequence: 0,
      state: "complete",
    };
  } finally {
    await releaseCreatorOperation();
  }
}

async function loadWorkspace({
  rootPath,
  workspaceId,
  expectedWorkspaceIdentitySha256,
  allowDeletionIntent = false,
}) {
  const root = await ensurePrivateRoot(rootPath);
  const operationAuthority = await workspaceOperationAuthorityStatus(root, workspaceId);
  if (!allowDeletionIntent && operationAuthority.kind === "deletion") {
    fail("workspace deletion intent already exists");
  }
  assertion(SHA256.test(expectedWorkspaceIdentitySha256 ?? ""),
    "expected workspace identity digest is invalid");
  const pointerPath = workspacePointerPathFor(root, workspaceId);
  const pointerBytes = await readRegularFile(pointerPath, MAX_STATIC_BYTES);
  const pointer = parseCanonicalJson(pointerBytes, "workspace pointer");
  validateWorkspacePointer(pointer, { workspaceId, expectedWorkspaceIdentitySha256 });
  const basicPrefix = `.initializing-${workspaceDirectoryName(workspaceId)}-`;
  const workspacePath = path.join(root, pointer.workspace_directory_name);
  const staticContext = await readWorkspaceStatic(workspacePath, expectedWorkspaceIdentitySha256);
  assertion(pointerBytes.equals(staticContext.pointerBytes),
    "published pointer differs from its retained atomic source");
  const exactPrefix = `${basicPrefix}${staticContext.identity.genesis_transaction_id}-`;
  assertion(pointer.workspace_directory_name.startsWith(exactPrefix)
    && /^[a-f0-9]{32}$/u.test(pointer.workspace_directory_name.slice(exactPrefix.length)),
  "workspace pointer genesis binding drifted");
  assertion(pointer.workspace_directory_name === staticContext.identity.workspace_directory_name,
    "workspace pointer directory binding drifted");
  if (operationAuthority.kind === "writer") {
    const retainedClaim = await claimStatus(workspacePath);
    assertion(retainedClaim.present && retainedClaim.bytes.equals(operationAuthority.bytes),
      "external writer authority differs from the exact retained claim");
    assertion(operationAuthority.claim.workspace_identity_sha256
      === staticContext.identity.workspace_identity_sha256,
    "external writer authority workspace binding drifted");
  }
  staticContext.identity.returned_chunk_ids = staticContext.documentMap.chunks.descriptors
    .map(item => item.chunk_id);
  return { root, workspacePath, pointerPath, staticContext, operationAuthority };
}

export async function appendUnverifiedWorkspaceProposal({
  rootPath,
  workspaceId,
  expectedWorkspaceIdentitySha256,
  expectedParentGenerationSha256,
  leafPointer,
  proposedValue,
  chunkIds,
  transactionId = null,
  faultInjector = null,
}) {
  assertion(SHA256.test(expectedParentGenerationSha256 ?? ""),
    "expected parent generation digest is invalid");
  const { workspacePath, staticContext } = await loadWorkspace({
    rootPath, workspaceId, expectedWorkspaceIdentitySha256,
  });
  const scan = await scanWorkspace(workspacePath, staticContext);
  assertion(scan.current.generation_sha256 === expectedParentGenerationSha256,
    "current generation differs from the exact expected parent");
  assertion(scan.current.events.length < staticContext.policy.max_proposals,
    "workspace proposal limit reached");
  assertion(typeof leafPointer === "string" && staticContext.identity.leaf_obligations.includes(leafPointer),
    "proposal leaf is not admitted");
  const priorProposals = scan.current.events.filter(event => event.kind === "proposal_submitted"
    && event.leaf_pointer === leafPointer);
  const priorResults = scan.current.events.filter(event => event.kind === "proposal_verified"
    && event.leaf_pointer === leafPointer);
  const verifiedProposalIds = new Set(priorResults.map(event => event.proposal_event_id));
  assertion(!priorProposals.some(event => !verifiedProposalIds.has(event.event_id)),
    "proposal leaf already has an unverified pending proposal");
  assertion(!priorResults.some(event => SETTLED_VERIFICATION_STATUSES
    .has(event.verification_result.status)),
  "proposal leaf is already settled by a retained verification result");
  assertion(Array.isArray(chunkIds) && chunkIds.length > 0
    && chunkIds.length <= staticContext.policy.max_chunk_refs_per_proposal,
  "proposal chunk references are invalid");
  const normalizedChunkIds = [...chunkIds];
  assertion(new Set(normalizedChunkIds).size === normalizedChunkIds.length
    && normalizedChunkIds.every(item => CHUNK_ID.test(item)
      && staticContext.identity.returned_chunk_ids.includes(item)),
  "proposal references an unknown, duplicate, or omitted chunk");
  const eventBody = {
    contract: { name: "pdf-tools.verified-extraction-workspace-event", version: "1.1.0-experimental" },
    event_sequence: scan.current.events.length + 1,
    kind: "proposal_submitted",
    workspace_identity_sha256: staticContext.identity.workspace_identity_sha256,
    leaf_pointer: leafPointer,
    proposed_value: validateJsonValue(proposedValue, staticContext.policy),
    chunk_ids: normalizedChunkIds,
    verification: { status: "unverified", reason: "not_replayed" },
  };
  const event = { ...eventBody, event_id: `event.${sha256Canonical(eventBody)}` };
  validateStoredEvent(event, staticContext.identity, staticContext.policy, eventBody.event_sequence);
  const generation = await publishGeneration({
    workspacePath,
    staticContext,
    events: [...scan.current.events, event],
    transactionId: normalizeTransactionId(transactionId),
    expectedParentGenerationSha256,
    faultInjector,
  });
  return {
    workspace_identity_sha256: staticContext.identity.workspace_identity_sha256,
    generation_sha256: generation.generation_sha256,
    generation_sequence: generation.manifest.sequence,
    event,
    state: "complete",
  };
}

export async function appendVerifiedWorkspaceResult({
  rootPath,
  workspaceId,
  expectedWorkspaceIdentitySha256,
  expectedParentGenerationSha256,
  verificationResult,
  transactionId = null,
  faultInjector = null,
}) {
  const retained = await appendVerifiedWorkspaceResults({
    rootPath, workspaceId, expectedWorkspaceIdentitySha256, expectedParentGenerationSha256,
    verificationResults: [verificationResult], transactionId, faultInjector,
  });
  return {
    workspace_identity_sha256: retained.workspace_identity_sha256,
    generation_sha256: retained.generation_sha256,
    generation_sequence: retained.generation_sequence,
    event: retained.events[0],
    result: retained.results[0],
    state: retained.state,
  };
}

// All results bind the same exact parent. Validate every item before acquiring
// publication authority, then publish all events in one atomic generation.
export async function appendVerifiedWorkspaceResults({
  rootPath,
  workspaceId,
  expectedWorkspaceIdentitySha256,
  expectedParentGenerationSha256,
  verificationResults,
  transactionId = null,
  faultInjector = null,
  maxRetainedWorkspaceBytes = MAX_RETAINED_WORKSPACE_BYTES,
}) {
  assertion(SHA256.test(expectedParentGenerationSha256 ?? ""),
    "expected parent generation digest is invalid");
  assertion(Array.isArray(verificationResults) && verificationResults.length >= 1
    && verificationResults.length <= 32, "verification batch must contain 1 through 32 results");
  const { workspacePath, staticContext } = await loadWorkspace({
    rootPath, workspaceId, expectedWorkspaceIdentitySha256,
  });
  const scan = await scanWorkspace(workspacePath, staticContext, { maxRetainedWorkspaceBytes });
  assertion(scan.current.generation_sha256 === expectedParentGenerationSha256,
    "current generation differs from the exact expected parent");
  assertion(scan.current.events.length + verificationResults.length <= staticContext.policy.max_proposals,
    "workspace event limit reached");
  const proposalIds = new Set();
  const leaves = new Set();
  const events = verificationResults.map((verificationResult, index) => {
    try {
      const result = validateRetainedVerificationResult(
        verificationResult, staticContext.identity, staticContext.policy,
      );
      assertion(result.generation_sha256 === expectedParentGenerationSha256,
        "verification result belongs to a different workspace generation");
      assertion(!proposalIds.has(result.proposal_event_id) && !leaves.has(result.leaf_pointer),
        "verification batch contains a duplicate proposal or leaf");
      proposalIds.add(result.proposal_event_id);
      leaves.add(result.leaf_pointer);
      const proposal = scan.current.events.find(event => event.kind === "proposal_submitted"
        && event.event_id === result.proposal_event_id);
      assertion(proposal && proposal.leaf_pointer === result.leaf_pointer,
        "verification result proposal is absent from the exact parent generation");
      assertion(scan.current.events.filter(event => event.leaf_pointer === result.leaf_pointer).at(-1)?.event_id
        === result.proposal_event_id, "verification result proposal is already verified or superseded");
      assertion(!scan.current.events.some(event => event.kind === "proposal_verified"
        && event.proposal_event_id === result.proposal_event_id),
      "proposal already has a retained verification result");
      const body = {
        contract: { name: "pdf-tools.verified-extraction-workspace-event", version: "1.1.0-experimental" },
        event_sequence: scan.current.events.length + index + 1,
        kind: "proposal_verified",
        workspace_identity_sha256: staticContext.identity.workspace_identity_sha256,
        leaf_pointer: result.leaf_pointer,
        proposal_event_id: result.proposal_event_id,
        verification_result: result,
      };
      const event = { ...body, event_id: `event.${sha256Canonical(body)}` };
      validateStoredEvent(event, staticContext.identity, staticContext.policy, body.event_sequence);
      return event;
    } catch (error) {
      fail(`verification batch item ${index}: ${error.message}`);
    }
  });
  const generation = await publishGeneration({
    workspacePath,
    staticContext,
    events: [...scan.current.events, ...events],
    transactionId: normalizeTransactionId(transactionId),
    expectedParentGenerationSha256,
    faultInjector,
    maxRetainedWorkspaceBytes,
  });
  return {
    workspace_identity_sha256: staticContext.identity.workspace_identity_sha256,
    parent_generation_sha256: expectedParentGenerationSha256,
    generation_sha256: generation.generation_sha256,
    generation_sequence: generation.manifest.sequence,
    events,
    results: events.map(event => event.verification_result),
    state: "complete",
  };
}

export async function readExtractionWorkspaceContext({
  rootPath,
  workspaceId,
  expectedWorkspaceIdentitySha256,
}) {
  const { staticContext } = await loadWorkspace({
    rootPath, workspaceId, expectedWorkspaceIdentitySha256,
  });
  const workspaceIdentity = structuredClone(staticContext.identity);
  delete workspaceIdentity.returned_chunk_ids;
  return {
    workspace_identity: workspaceIdentity,
    document_map: structuredClone(staticContext.documentMap),
    schema_bytes: Buffer.from(staticContext.schemaBytes),
  };
}

// Internal bounded snapshot for source replay and review adapters. The entire
// retained chain is validated once; callers must paginate the returned data
// before exposing it over a tool/UI transport.
export async function readExtractionReviewState({
  rootPath,
  workspaceId,
  expectedWorkspaceIdentitySha256,
  expectedGenerationSha256 = null,
  maxRetainedWorkspaceBytes = MAX_RETAINED_WORKSPACE_BYTES,
}) {
  if (expectedGenerationSha256 !== null) {
    assertion(SHA256.test(expectedGenerationSha256), "expected generation digest is invalid");
  }
  const { workspacePath, staticContext } = await loadWorkspace({
    rootPath, workspaceId, expectedWorkspaceIdentitySha256,
  });
  const scan = await scanWorkspace(workspacePath, staticContext, { maxRetainedWorkspaceBytes });
  assertion(scan.state === "complete", "review requires a complete workspace");
  const generation = expectedGenerationSha256 === null ? scan.current
    : scan.complete.find(item => item.generation_sha256 === expectedGenerationSha256);
  assertion(generation, "expected generation is absent from the retained workspace");
  const workspaceIdentity = structuredClone(staticContext.identity);
  delete workspaceIdentity.returned_chunk_ids;
  return {
    workspace_identity: workspaceIdentity,
    document_map: structuredClone(staticContext.documentMap),
    schema_bytes: Buffer.from(staticContext.schemaBytes),
    generation_sha256: generation.generation_sha256,
    generation_sequence: generation.manifest.sequence,
    events: structuredClone(generation.events),
    current_state: structuredClone(generation.currentState),
  };
}

export async function inspectExtractionWorkspace({
  rootPath,
  workspaceId,
  expectedWorkspaceIdentitySha256,
}) {
  const { workspacePath, staticContext } = await loadWorkspace({
    rootPath, workspaceId, expectedWorkspaceIdentitySha256,
  });
  const scan = await scanWorkspace(workspacePath, staticContext, { allowClaim: true });
  return {
    workspace_id: workspaceId,
    workspace_identity_sha256: staticContext.identity.workspace_identity_sha256,
    state: scan.state,
    current_generation_sha256: scan.current?.generation_sha256 ?? null,
    current_generation_sequence: scan.current?.manifest.sequence ?? null,
    complete_generations: scan.complete.length,
    incomplete_generations: scan.incomplete.map(item => ({
      name: path.basename(item.path), state: item.state, reason: item.reason ?? null,
    })),
    abandoned_generations: [...scan.abandoned],
    active_transaction_id: scan.claim.present ? scan.claim.claim.transaction_id : null,
    retention: {
      maximum_generations: staticContext.policy.max_generations,
      remaining_generations: staticContext.policy.max_generations - scan.complete.length,
      automatic_pruning: false,
      deletion_requires_exact_current_generation: true,
    },
  };
}

function cursorToken(payload) {
  const payloadBytes = Buffer.from(canonicalWorkspaceJson(payload), "utf8");
  const encoded = payloadBytes.toString("base64url");
  const digest = sha256(Buffer.concat([
    Buffer.from("pdf-tools.verified-extraction-workspace-cursor.v1\0", "utf8"),
    payloadBytes,
  ]));
  return `cursor.${encoded}.${digest}`;
}

function parseCursor(value) {
  assertion(typeof value === "string" && value.length <= 8192, "cursor is invalid");
  const match = value.match(/^cursor\.([A-Za-z0-9_-]+)\.([a-f0-9]{64})$/u);
  assertion(match, "cursor is invalid");
  let bytes;
  try {
    bytes = Buffer.from(match[1], "base64url");
  } catch {
    fail("cursor payload is invalid");
  }
  assertion(bytes.toString("base64url") === match[1], "cursor payload encoding is not canonical");
  const digest = sha256(Buffer.concat([
    Buffer.from("pdf-tools.verified-extraction-workspace-cursor.v1\0", "utf8"),
    bytes,
  ]));
  assertion(digest === match[2], "cursor digest is invalid");
  let payload;
  try {
    payload = JSON.parse(bytes.toString("utf8"));
  } catch {
    fail("cursor payload is not JSON");
  }
  assertion(canonicalWorkspaceJson(payload) === bytes.toString("utf8"), "cursor payload is not canonical");
  exactKeys(payload, [
    "contract", "workspace_identity_sha256", "generation_sha256", "collection",
    "collection_sha256", "offset", "limit",
  ], "cursor payload");
  assertion(canonicalWorkspaceJson(payload.contract) === canonicalWorkspaceJson(EXTRACTION_WORKSPACE_CURSOR_IDENTITY),
    "cursor contract is unsupported");
  return payload;
}

function generationCollections(staticContext, generation) {
  return {
    document_map_chunks: staticContext.documentMap.chunks.descriptors,
    pending_leaves: generation.currentState.pending_leaves,
    events: generation.events,
    proposals: generation.currentState.proposals,
    results: generation.currentState.results,
  };
}

export async function readExtractionWorkspacePage({
  rootPath,
  workspaceId,
  expectedWorkspaceIdentitySha256,
  collection,
  limit = 50,
  cursor = null,
}) {
  assertion(["document_map_chunks", "pending_leaves", "events", "proposals", "results"]
    .includes(collection), "collection is unsupported");
  const { workspacePath, staticContext } = await loadWorkspace({
    rootPath, workspaceId, expectedWorkspaceIdentitySha256,
  });
  const scan = await scanWorkspace(workspacePath, staticContext);
  let generation = scan.current;
  let offset = 0;
  let pageLimit = boundedInteger(limit, "pagination limit", 1, staticContext.policy.max_page_items);
  let cursorPayload = null;
  if (cursor !== null) {
    cursorPayload = parseCursor(cursor);
    assertion(cursorPayload.workspace_identity_sha256 === staticContext.identity.workspace_identity_sha256,
      "cursor belongs to a different workspace");
    assertion(cursorPayload.collection === collection, "cursor belongs to a different collection");
    generation = scan.complete.find(item => item.generation_sha256 === cursorPayload.generation_sha256);
    assertion(generation, "cursor generation is not retained");
    offset = boundedInteger(cursorPayload.offset, "cursor offset", 0, Number.MAX_SAFE_INTEGER);
    pageLimit = boundedInteger(cursorPayload.limit, "cursor limit", 1, staticContext.policy.max_page_items);
    assertion(limit === pageLimit, "cursor pagination limit drifted");
  }
  const items = generationCollections(staticContext, generation)[collection];
  const collectionSha256 = sha256Canonical(items);
  if (cursorPayload) assertion(cursorPayload.collection_sha256 === collectionSha256,
    "cursor collection binding drifted");
  assertion(offset <= items.length, "cursor offset is outside the collection");
  let returnedItems = items.slice(offset, offset + pageLimit);
  const build = selected => {
    const nextOffset = offset + selected.length;
    const nextCursor = nextOffset < items.length ? cursorToken({
      contract: { ...EXTRACTION_WORKSPACE_CURSOR_IDENTITY },
      workspace_identity_sha256: staticContext.identity.workspace_identity_sha256,
      generation_sha256: generation.generation_sha256,
      collection,
      collection_sha256: collectionSha256,
      offset: nextOffset,
      limit: pageLimit,
    }) : null;
    return {
      contract: { name: "pdf-tools.verified-extraction-workspace-page", version: "1.0.0-experimental" },
      workspace_identity_sha256: staticContext.identity.workspace_identity_sha256,
      generation_sha256: generation.generation_sha256,
      collection,
      collection_sha256: collectionSha256,
      counts: {
        total: items.length,
        offset,
        returned: selected.length,
        omitted_before: offset,
        omitted_after: items.length - nextOffset,
      },
      items: selected,
      next_cursor: nextCursor,
    };
  };
  let response = build(returnedItems);
  if (Buffer.byteLength(canonicalWorkspaceJson(response), "utf8")
    > staticContext.policy.max_page_utf8_bytes) {
    let lower = 0;
    let upper = returnedItems.length;
    while (lower < upper) {
      const candidateLength = Math.ceil((lower + upper) / 2);
      const candidate = build(returnedItems.slice(0, candidateLength));
      if (Buffer.byteLength(canonicalWorkspaceJson(candidate), "utf8")
        <= staticContext.policy.max_page_utf8_bytes) lower = candidateLength;
      else upper = candidateLength - 1;
    }
    returnedItems = returnedItems.slice(0, lower);
    response = build(returnedItems);
  }
  assertion(returnedItems.length > 0 || offset === items.length,
    "one retained item exceeds the pagination byte limit");
  assertion(Buffer.byteLength(canonicalWorkspaceJson(response), "utf8")
    <= staticContext.policy.max_page_utf8_bytes, "paginated response exceeds its byte limit");
  return response;
}

export async function recoverExtractionWorkspace({
  rootPath,
  workspaceId,
  expectedWorkspaceIdentitySha256,
  transactionId,
  expectedCreatorClaimSha256 = null,
  action = "inspect",
}) {
  assertion(["inspect", "initialize_genesis", "publish_if_complete", "abandon_incomplete"]
    .includes(action),
    "recovery action is unsupported");
  assertion(TRANSACTION_ID.test(transactionId ?? ""), "recovery transaction_id is invalid");
  const { root, workspacePath, staticContext, operationAuthority } = await loadWorkspace({
    rootPath, workspaceId, expectedWorkspaceIdentitySha256,
  });
  await assertPathAbsent(initializationAbandonmentPath(root, workspaceId, transactionId),
    "workspace creator transaction abandonment tombstone");
  const scan = await scanWorkspace(workspacePath, staticContext, { allowClaim: true });
  if (action === "initialize_genesis") {
    const releaseCreatorOperation = await acquireCreatorOperationLease(
      root,
      workspaceId,
      transactionId,
    );
    try {
      await assertPathAbsent(initializationAbandonmentPath(root, workspaceId, transactionId),
        "workspace creator transaction abandonment tombstone");
      const genesisScan = await scanWorkspace(workspacePath, staticContext, { allowClaim: true });
      assertion(transactionId === staticContext.identity.genesis_transaction_id,
        "genesis recovery transaction differs from the workspace identity");
      assertion(!genesisScan.claim.present && genesisScan.complete.length === 0
        && genesisScan.incomplete.length === 0 && genesisScan.abandoned.length === 0,
      "genesis recovery requires an exact unclaimed pre-genesis workspace");
      assertion(SHA256.test(expectedCreatorClaimSha256 ?? ""),
        "genesis recovery requires the exact creator claim digest");
      const creatorClaimPath = initializationCreatorClaimPath(root, workspaceId, transactionId);
      const creatorClaimBytes = await readRegularFile(creatorClaimPath, MAX_STATIC_BYTES);
      assertion(sha256(creatorClaimBytes) === expectedCreatorClaimSha256,
        "genesis recovery creator claim digest drifted");
      validateCreatorClaim(parseCanonicalJson(creatorClaimBytes, "workspace creator claim"), {
        workspaceId,
        transactionId,
        initializationDirectoryName: staticContext.identity.workspace_directory_name,
        workspaceIdentitySha256: staticContext.identity.workspace_identity_sha256,
      });
      const genesis = await publishGenesis({
        workspacePath,
        staticContext,
        transactionId,
        faultInjector: null,
      });
      await unlink(creatorClaimPath);
      await fsyncDirectory(root);
      return {
        state: "recovered_genesis",
        transaction_id: transactionId,
        generation_sha256: genesis.generation_sha256,
        generation_sequence: 0,
      };
    } finally {
      await releaseCreatorOperation();
    }
  }
  assertion(scan.claim.present && scan.claim.claim.transaction_id === transactionId,
    "recovery does not own the exact active transaction");
  assertion(scan.claim.claim.workspace_identity_sha256 === staticContext.identity.workspace_identity_sha256,
    "recovery claim workspace binding drifted");
  const existing = scan.complete.find(item => item.manifest.transaction_id === transactionId);
  const generationsPath = path.join(workspacePath, "generations");
  const stagingPath = path.join(generationsPath, `.staging-${transactionId}`);
  let staging = null;
  try {
    staging = await inspectGenerationDirectory(stagingPath, staticContext, { staging: true });
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
  }
  if (action === "inspect") {
    return {
      state: existing ? "published_claim_retained" : staging?.state ?? "claim_without_generation",
      transaction_id: transactionId,
      generation_sha256: existing?.generation_sha256 ?? staging?.generation_sha256 ?? null,
      promotion_authorized: false,
    };
  }
  if (action === "abandon_incomplete") {
    assertion(!existing && (!staging || staging.state === "incomplete"),
      "complete or published generation cannot be abandoned");
    if (staging) {
      await rename(stagingPath, path.join(generationsPath, `.abandoned-${transactionId}`));
      await fsyncDirectory(generationsPath);
    }
    const claimArchive = path.join(workspacePath, `abandoned-claim-${transactionId}.json`);
    try {
      await writeExclusiveFile(claimArchive, scan.claim.bytes);
    } catch (error) {
      if (error?.code !== "EEXIST") throw error;
      const archivedBytes = await readRegularFile(claimArchive, MAX_STATIC_BYTES);
      assertion(archivedBytes.equals(scan.claim.bytes),
        "existing abandoned claim differs from the active transaction");
    }
    await releaseWriterAuthority({
      workspacePath,
      staticContext,
      claimBytes: scan.claim.bytes,
      claimPath: scan.claim.filename,
      allowMissingAuthority: operationAuthority.kind === "absent",
    });
    return { state: "abandoned_incomplete", transaction_id: transactionId, promotion_authorized: false };
  }
  if (existing) {
    assertion(existing.generation_sha256 === scan.current.generation_sha256,
      "published recovery target is not the current generation");
    await releaseWriterAuthority({
      workspacePath,
      staticContext,
      claimBytes: scan.claim.bytes,
      claimPath: scan.claim.filename,
      allowMissingAuthority: operationAuthority.kind === "absent",
    });
    return { state: "recovered_published", transaction_id: transactionId,
      generation_sha256: existing.generation_sha256 };
  }
  assertion(staging?.state === "complete", "incomplete generation cannot be promoted");
  assertion(staging.manifest.sequence === scan.claim.claim.sequence
    && staging.manifest.parent_generation_sha256 === scan.claim.claim.parent_generation_sha256,
  "staging generation differs from its recovery claim");
  assertion(staging.manifest.sequence === 0
    ? scan.current === null && staging.manifest.parent_generation_sha256 === null
    : scan.current?.generation_sha256 === staging.manifest.parent_generation_sha256,
  "staging generation parent is no longer current");
  if (scan.current) {
    assertion(staging.manifest.sequence === scan.current.manifest.sequence + 1,
      "staging generation sequence is not the next generation");
    const addedEvents = staging.events.length - scan.current.events.length;
    assertion(addedEvents >= 1 && addedEvents <= 32
      && staging.eventsBytes.subarray(0, scan.current.eventsBytes.length).equals(scan.current.eventsBytes),
    "staging generation is not a bounded append-only successor");
  }
  const finalPath = path.join(generationsPath,
    generationName(staging.manifest.sequence, staging.generation_sha256));
  await rename(stagingPath, finalPath);
  await fsyncDirectory(generationsPath);
  const published = await inspectGenerationDirectory(finalPath, staticContext);
  await releaseWriterAuthority({
    workspacePath,
    staticContext,
    claimBytes: scan.claim.bytes,
    claimPath: scan.claim.filename,
    allowMissingAuthority: operationAuthority.kind === "absent",
  });
  const terminal = await scanWorkspace(workspacePath, staticContext);
  assertion(terminal.current.generation_sha256 === published.generation_sha256,
    "recovered generation did not become current");
  return { state: "recovered_complete", transaction_id: transactionId,
    generation_sha256: published.generation_sha256 };
}

async function assertNoLinksRecursively(directory) {
  await assertPrivateDirectory(directory, "deletion directory");
  const entries = await readdir(directory, { withFileTypes: true });
  for (const entry of entries) {
    const entryPath = path.join(directory, entry.name);
    const metadata = await lstat(entryPath, { bigint: true });
    assertion(!metadata.isSymbolicLink(), "workspace deletion refuses a symlink");
    if (metadata.isDirectory()) await assertNoLinksRecursively(entryPath);
    else assertion(metadata.isFile()
      && workspacePrivateModeMatchesForPlatform(metadata, 0o600),
      "workspace deletion refuses an unexpected file type or mode");
  }
}

function validateDeletionIntent(intent, {
  workspaceId,
  expectedWorkspaceIdentitySha256,
  expectedCurrentGenerationSha256,
  expectedWorkspacePointerSha256,
  expectedWorkspaceDataDirectoryName = null,
}) {
  exactKeys(intent, [
    "contract", "workspace_id", "workspace_identity_sha256", "workspace_directory_name",
    "final_generation_sha256", "workspace_pointer_sha256",
  ], "workspace deletion intent");
  assertion(canonicalWorkspaceJson(intent.contract) === canonicalWorkspaceJson(DELETION_INTENT_CONTRACT),
    "workspace deletion intent contract is unsupported");
  assertion(intent.workspace_id === workspaceId, "workspace deletion intent workspace_id drifted");
  assertion(intent.workspace_identity_sha256 === expectedWorkspaceIdentitySha256,
    "workspace deletion intent identity drifted");
  assertion(intent.final_generation_sha256 === expectedCurrentGenerationSha256,
    "workspace deletion intent final generation drifted");
  assertion(intent.workspace_pointer_sha256 === expectedWorkspacePointerSha256,
    "workspace deletion intent pointer digest drifted");
  const prefix = `.initializing-${workspaceDirectoryName(workspaceId)}-`;
  assertion(typeof intent.workspace_directory_name === "string"
    && intent.workspace_directory_name.startsWith(prefix)
    && /^[a-f0-9]{32,64}-[a-f0-9]{32}$/u.test(intent.workspace_directory_name.slice(prefix.length)),
  "workspace deletion intent directory identity is invalid");
  if (expectedWorkspaceDataDirectoryName !== null) {
    assertion(intent.workspace_directory_name === expectedWorkspaceDataDirectoryName,
      "workspace deletion intent directory drifted");
  }
  return intent;
}

async function removePrivateTreeResumably(directory, { root, faultInjector, deletionIntent }) {
  let initial;
  try {
    initial = await lstat(directory, { bigint: true });
  } catch (error) {
    if (error?.code === "ENOENT") return;
    throw error;
  }
  assertion(initial.isDirectory() && !initial.isSymbolicLink()
    && workspacePrivateModeMatchesForPlatform(initial, 0o700),
    "resumable deletion target is not a physical 0700 directory");
  await assertNoLinksRecursively(directory);

  const removeDirectory = async current => {
    const entries = (await readdir(current, { withFileTypes: true }))
      .sort((left, right) => compareCodePoints(left.name, right.name));
    for (const entry of entries) {
      const entryPath = path.join(current, entry.name);
      if (entry.isDirectory() && !entry.isSymbolicLink()) {
        await removeDirectory(entryPath);
      } else {
        const metadata = await lstat(entryPath, { bigint: true });
        assertion(metadata.isFile() && !metadata.isSymbolicLink()
          && workspacePrivateModeMatchesForPlatform(metadata, 0o600),
          "resumable deletion refuses an unexpected file type, mode, or symlink");
        await unlink(entryPath);
        await fsyncDirectory(current);
        await inject(faultInjector, "after_workspace_deletion_entry", {
          entry_kind: "file",
          entry_relative_path: path.relative(directory, entryPath),
          deletion_intent: deletionIntent,
        });
      }
    }
    await rmdir(current);
    const parent = path.dirname(current);
    await fsyncDirectory(parent);
    await inject(faultInjector, "after_workspace_deletion_entry", {
      entry_kind: "directory",
      entry_relative_path: path.relative(directory, current) || ".",
      deletion_intent: deletionIntent,
    });
  };

  await removeDirectory(directory);
  await fsyncDirectory(root);
}

async function assertPreGenesisInitializationScratch(directory) {
  await assertNoLinksRecursively(directory);
  const allowed = new Set([
    IDENTITY_FILE,
    MAP_FILE,
    SCHEMA_FILE,
    LEAVES_FILE,
    POINTER_FILE,
    "generations",
  ]);
  const entries = await readdir(directory, { withFileTypes: true });
  for (const entry of entries) {
    assertion(allowed.has(entry.name),
      "initialization abandonment refuses transaction history or an unexpected artifact");
    if (entry.name === "generations") {
      assertion(entry.isDirectory() && !entry.isSymbolicLink(),
        "initialization abandonment generations entry is invalid");
      const generations = await readdir(path.join(directory, entry.name));
      assertion(generations.length === 0,
        "initialization abandonment refuses committed or in-progress generation history");
    } else {
      assertion(entry.isFile() && !entry.isSymbolicLink(),
        "initialization abandonment static artifact is invalid");
    }
  }
}

async function clearUnadmittedWriterClaimDuringDeletion(workspacePath, staticContext) {
  const scan = await scanWorkspace(workspacePath, staticContext, { allowClaim: true });
  if (!scan.claim.present) return scan;
  const transactionId = scan.claim.claim.transaction_id;
  assertion(!scan.complete.some(item => item.manifest.transaction_id === transactionId)
    && !scan.incomplete.some(item => path.basename(item.path) === `.staging-${transactionId}`),
  "writer progressed without the shared operation authority");
  await unlink(scan.claim.filename);
  await fsyncDirectory(workspacePath);
  return scanWorkspace(workspacePath, staticContext);
}

export async function abandonExtractionWorkspaceInitialization({
  rootPath,
  workspaceId,
  transactionId,
  initializationDirectoryName,
  expectedInitializationWorkspaceIdentitySha256,
  expectedCreatorClaimSha256,
  expectedCurrentWorkspaceIdentitySha256 = null,
}) {
  assertion(TRANSACTION_ID.test(transactionId ?? ""),
    "initialization abandonment transaction_id is invalid");
  assertion(SHA256.test(expectedInitializationWorkspaceIdentitySha256 ?? ""),
    "initialization abandonment requires the exact initialization workspace identity");
  assertion(SHA256.test(expectedCreatorClaimSha256 ?? ""),
    "initialization abandonment requires the exact creator claim digest");
  const expectedPrefix = `.initializing-${workspaceDirectoryName(workspaceId)}-${transactionId}-`;
  assertion(typeof initializationDirectoryName === "string"
    && initializationDirectoryName.startsWith(expectedPrefix)
    && /^[a-f0-9]{32}$/u.test(initializationDirectoryName.slice(expectedPrefix.length)),
  "initialization abandonment directory identity is invalid");
  const root = await ensurePrivateRoot(rootPath);
  await assertPathAbsent(workspaceDeletionIntentPathFor(root, workspaceId),
    "workspace deletion intent");
  const releaseCreatorOperation = await acquireCreatorOperationLease(
    root,
    workspaceId,
    transactionId,
  );
  try {
    const pointerPath = workspacePointerPathFor(root, workspaceId);
    try {
    const pointerBytes = await readRegularFile(pointerPath, MAX_STATIC_BYTES);
    const pointer = parseCanonicalJson(pointerBytes, "workspace pointer during initialization abandonment");
    assertion(SHA256.test(expectedCurrentWorkspaceIdentitySha256 ?? ""),
      "initialization abandonment requires the exact current workspace identity when a pointer exists");
    validateWorkspacePointer(pointer, {
      workspaceId,
      expectedWorkspaceIdentitySha256: expectedCurrentWorkspaceIdentitySha256,
    });
    const authoritativePath = path.join(root, pointer.workspace_directory_name);
    const authoritativeStatic = await readWorkspaceStatic(
      authoritativePath,
      pointer.workspace_identity_sha256,
    );
    assertion(pointerBytes.equals(authoritativeStatic.pointerBytes),
      "workspace pointer during initialization abandonment differs from its retained source");
    assertion(authoritativeStatic.identity.workspace_id === workspaceId
      && authoritativeStatic.identity.workspace_directory_name === pointer.workspace_directory_name,
    "workspace pointer during initialization abandonment drifted from its authoritative workspace");
    assertion(pointer.workspace_directory_name !== initializationDirectoryName,
      "initialization abandonment refuses the authoritative workspace directory");
    } catch (error) {
      if (error?.code !== "ENOENT") throw error;
    }
    const creatorClaimPath = initializationCreatorClaimPath(root, workspaceId, transactionId);
  const abandonmentPath = initializationAbandonmentPath(root, workspaceId, transactionId);
  const abandonmentBytes = canonicalBytes(creatorAbandonmentBody({
    workspaceId,
    transactionId,
    initializationDirectoryName,
    workspaceIdentitySha256: expectedInitializationWorkspaceIdentitySha256,
    creatorClaimSha256: expectedCreatorClaimSha256,
  }));
  let abandonmentExists = false;
  try {
    const retainedAbandonmentBytes = await readRegularFile(abandonmentPath, MAX_STATIC_BYTES);
    const retainedAbandonment = parseCanonicalJson(
      retainedAbandonmentBytes,
      "workspace creator abandonment",
    );
    validateCreatorAbandonment(retainedAbandonment, {
      workspaceId,
      transactionId,
      initializationDirectoryName,
      workspaceIdentitySha256: expectedInitializationWorkspaceIdentitySha256,
      creatorClaimSha256: expectedCreatorClaimSha256,
    });
    assertion(retainedAbandonmentBytes.equals(abandonmentBytes),
      "workspace creator abandonment differs from the exact expected tombstone");
    abandonmentExists = true;
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
  }
  const initializationPath = path.join(root, initializationDirectoryName);
  if (!abandonmentExists) {
    let creatorClaimBytes;
    try {
      creatorClaimBytes = await readRegularFile(creatorClaimPath, MAX_STATIC_BYTES);
    } catch (error) {
      if (error?.code === "ENOENT") {
        fail("initialization abandonment exact physical creator claim is missing");
      }
      throw error;
    }
    assertion(sha256(creatorClaimBytes) === expectedCreatorClaimSha256,
      "initialization abandonment creator claim digest drifted");
    validateCreatorClaim(parseCanonicalJson(creatorClaimBytes, "workspace creator claim"), {
      workspaceId,
      transactionId,
      initializationDirectoryName,
      workspaceIdentitySha256: expectedInitializationWorkspaceIdentitySha256,
    });
    try {
      const identityBytes = await readRegularFile(path.join(initializationPath, IDENTITY_FILE),
        MAX_STATIC_BYTES);
      validateInitializationIdentity(
        parseCanonicalJson(identityBytes, "workspace initialization identity"),
        {
          workspaceId,
          transactionId,
          initializationDirectoryName,
          workspaceIdentitySha256: expectedInitializationWorkspaceIdentitySha256,
        },
      );
    } catch (error) {
      if (error?.code !== "ENOENT") throw error;
    }
    await writeExclusiveFile(abandonmentPath, abandonmentBytes);
    await fsyncDirectory(root);
  }
  try {
    await lstat(initializationPath);
    await assertPreGenesisInitializationScratch(initializationPath);
    await rm(initializationPath, { recursive: true, force: false });
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
  }
  try {
    await unlink(creatorClaimPath);
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
  }
  await fsyncDirectory(root);
    return {
      state: "abandoned_initialization",
      workspace_id: workspaceId,
      transaction_id: transactionId,
      initialization_directory_name: initializationDirectoryName,
      creator_abandonment_sha256: sha256(abandonmentBytes),
      transaction_reusable: false,
      recoverable: false,
    };
  } finally {
    await releaseCreatorOperation();
  }
}

export async function deleteExtractionWorkspace({
  rootPath,
  workspaceId,
  expectedWorkspaceIdentitySha256,
  expectedCurrentGenerationSha256,
  faultInjector = null,
}) {
  assertion(SHA256.test(expectedCurrentGenerationSha256 ?? ""),
    "expected current generation digest is invalid");
  const { root, workspacePath, pointerPath, staticContext } = await loadWorkspace({
    rootPath, workspaceId, expectedWorkspaceIdentitySha256,
  });
  const scan = await scanWorkspace(workspacePath, staticContext);
  assertion(scan.current.generation_sha256 === expectedCurrentGenerationSha256,
    "workspace deletion expected generation is stale");
  await assertNoLinksRecursively(workspacePath);
  const deletionIntentPath = workspaceDeletionIntentPathFor(root, workspaceId);
  const deletionIntent = {
    contract: { ...DELETION_INTENT_CONTRACT },
    workspace_id: workspaceId,
    workspace_identity_sha256: expectedWorkspaceIdentitySha256,
    workspace_directory_name: path.basename(workspacePath),
    final_generation_sha256: expectedCurrentGenerationSha256,
    workspace_pointer_sha256: sha256(staticContext.pointerBytes),
  };
  await inject(faultInjector, "before_workspace_deletion_intent", {
    workspacePath,
    pointerPath,
    deletionIntentPath,
    deletionIntent,
  });
  await writeExclusiveFile(deletionIntentPath, canonicalBytes(deletionIntent));
  await fsyncDirectory(root);
  await inject(faultInjector, "after_workspace_deletion_intent", {
    workspacePath,
    pointerPath,
    deletionIntentPath,
    deletionIntent,
  });
  const revalidated = await loadWorkspace({
    rootPath,
    workspaceId,
    expectedWorkspaceIdentitySha256,
    allowDeletionIntent: true,
  });
  assertion(revalidated.workspacePath === workspacePath,
    "workspace deletion target changed after intent publication");
  const revalidatedScan = await clearUnadmittedWriterClaimDuringDeletion(
    revalidated.workspacePath,
    revalidated.staticContext,
  );
  assertion(revalidatedScan.current.generation_sha256 === expectedCurrentGenerationSha256,
    "workspace advanced after deletion intent publication");
  await unlink(pointerPath);
  await fsyncDirectory(root);
  await inject(faultInjector, "after_workspace_unpublish", {
    workspacePath,
    pointerPath,
    workspaceIdentitySha256: expectedWorkspaceIdentitySha256,
    generationSha256: expectedCurrentGenerationSha256,
  });
  await removePrivateTreeResumably(workspacePath, { root, faultInjector, deletionIntent });
  await inject(faultInjector, "after_workspace_data_removal", {
    workspacePath,
    deletionIntentPath,
    deletionIntent,
  });
  await unlink(deletionIntentPath);
  await fsyncDirectory(root);
  return {
    state: "deleted",
    workspace_id: workspaceId,
    workspace_identity_sha256: expectedWorkspaceIdentitySha256,
    final_generation_sha256: expectedCurrentGenerationSha256,
    recoverable: false,
  };
}

export async function completeExtractionWorkspaceDeletion({
  rootPath,
  workspaceId,
  workspaceDataDirectoryName,
  expectedWorkspaceIdentitySha256,
  expectedCurrentGenerationSha256,
  expectedWorkspacePointerSha256,
  faultInjector = null,
}) {
  assertion(SHA256.test(expectedWorkspaceIdentitySha256 ?? ""),
    "deletion completion expected workspace identity is invalid");
  assertion(SHA256.test(expectedCurrentGenerationSha256 ?? ""),
    "deletion completion expected generation is invalid");
  assertion(SHA256.test(expectedWorkspacePointerSha256 ?? ""),
    "deletion completion expected pointer digest is invalid");
  const root = await ensurePrivateRoot(rootPath);
  const deletionIntentPath = workspaceDeletionIntentPathFor(root, workspaceId);
  const deletionIntentBytes = await readRegularFile(deletionIntentPath, MAX_STATIC_BYTES);
  const deletionIntent = validateDeletionIntent(
    parseCanonicalJson(deletionIntentBytes, "workspace deletion intent"),
    {
      workspaceId,
      expectedWorkspaceIdentitySha256,
      expectedCurrentGenerationSha256,
      expectedWorkspacePointerSha256,
      expectedWorkspaceDataDirectoryName: workspaceDataDirectoryName,
    },
  );
  const pointerPath = workspacePointerPathFor(root, workspaceId);
  try {
    const pointerBytes = await readRegularFile(pointerPath, MAX_STATIC_BYTES);
    assertion(sha256(pointerBytes) === expectedWorkspacePointerSha256,
      "active workspace pointer differs from the deletion intent authority");
    const active = await loadWorkspace({
      rootPath,
      workspaceId,
      expectedWorkspaceIdentitySha256,
      allowDeletionIntent: true,
    });
    assertion(path.basename(active.workspacePath) === workspaceDataDirectoryName,
      "active workspace pointer directory differs from the deletion intent authority");
    const scan = await clearUnadmittedWriterClaimDuringDeletion(
      active.workspacePath,
      active.staticContext,
    );
    assertion(scan.current.generation_sha256 === expectedCurrentGenerationSha256,
      "active workspace generation differs from the deletion intent authority");
    await unlink(pointerPath);
    await fsyncDirectory(root);
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
  }
  const workspacePath = path.join(root, workspaceDataDirectoryName);
  await removePrivateTreeResumably(workspacePath, { root, faultInjector, deletionIntent });
  await unlink(deletionIntentPath);
  await fsyncDirectory(root);
  return {
    state: "deleted_after_unpublish",
    workspace_id: workspaceId,
    workspace_identity_sha256: expectedWorkspaceIdentitySha256,
    final_generation_sha256: expectedCurrentGenerationSha256,
    recoverable: false,
  };
}

export async function abandonExtractionWorkspaceDeletionIntent({
  rootPath,
  workspaceId,
  expectedWorkspaceIdentitySha256,
  expectedCurrentGenerationSha256,
}) {
  assertion(SHA256.test(expectedWorkspaceIdentitySha256 ?? ""),
    "deletion intent abandonment expected workspace identity is invalid");
  assertion(SHA256.test(expectedCurrentGenerationSha256 ?? ""),
    "deletion intent abandonment expected generation is invalid");
  const { root, workspacePath, staticContext } = await loadWorkspace({
    rootPath, workspaceId, expectedWorkspaceIdentitySha256, allowDeletionIntent: true,
  });
  const scan = await scanWorkspace(workspacePath, staticContext);
  assertion(scan.current.generation_sha256 === expectedCurrentGenerationSha256,
    "deletion intent abandonment expected generation is stale");
  const deletionIntentPath = workspaceDeletionIntentPathFor(root, workspaceId);
  const deletionIntentBytes = await readRegularFile(
    deletionIntentPath,
    MAX_STATIC_BYTES,
    { allowEmpty: true },
  );
  let completeIntent = false;
  try {
    validateDeletionIntent(parseCanonicalJson(deletionIntentBytes, "workspace deletion intent"), {
      workspaceId,
      expectedWorkspaceIdentitySha256,
      expectedCurrentGenerationSha256,
      expectedWorkspacePointerSha256: sha256(staticContext.pointerBytes),
      expectedWorkspaceDataDirectoryName: path.basename(workspacePath),
    });
    completeIntent = true;
  } catch {
    completeIntent = false;
  }
  assertion(!completeIntent,
    "a complete deletion intent cannot be abandoned; exact deletion completion is required");
  await unlink(deletionIntentPath);
  await fsyncDirectory(root);
  return {
    state: "abandoned_deletion_intent",
    workspace_id: workspaceId,
    workspace_identity_sha256: expectedWorkspaceIdentitySha256,
    final_generation_sha256: expectedCurrentGenerationSha256,
    recoverable: false,
  };
}
