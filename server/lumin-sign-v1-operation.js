import { createHash, createHmac, randomUUID, timingSafeEqual } from "node:crypto";
import { constants as fsConstants } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { types as utilTypes } from "node:util";
import { LUMIN_CLIENT_USER_AGENT } from "./lumin-client-identity.js";
import { executeAuthorizedLuminSignV1DirectUpload } from "./lumin-sign-v1-transport.js";

const SHA256_PATTERN = /^[a-f0-9]{64}$/;
const TOKEN_PATTERN = /^[A-Za-z0-9._~+\/-]+={0,2}$/;
const IDENTIFIER_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/;
const STATUS_VALUE_LIST = Object.freeze([
  "NEED_TO_SIGN",
  "WAITING_FOR_OTHERS",
  "APPROVED",
  "REJECTED",
  "WAITING_FOR_PROCESSING",
  "FAILED",
  "CANCELLED",
]);
const ARTIFACT_FILE_TYPE_LIST = Object.freeze(["agreement", "coc", "merged"]);
const STATUS_VALUES = new Set(STATUS_VALUE_LIST);
const ARTIFACT_FILE_TYPES = new Set(ARTIFACT_FILE_TYPE_LIST);
const WEBHOOK_EVENT_TYPES = new Set([
  "signature_request_approved",
  "signature_request_cancel_failed",
  "signature_request_canceled",
  "signature_request_created",
  "signature_request_declined",
  "signature_request_downloadable",
  "signature_request_due_date_updated",
  "signature_request_invalid",
  "signature_request_signed",
  "signature_request_viewed",
]);
const OPERATION_DIRECTORY = "lumin-sign-v1-operations";
const STAGING_DIRECTORY = ".staging";
const QUARANTINE_DIRECTORY = ".quarantine";
const CLAIM_FILE = "claim.v1.json";
const OUTCOME_FILE = "outcome.v1.json";
const OBSERVATIONS_DIRECTORY = "observations";
const MAX_RETAINED_POLL_OBSERVATIONS = 64;
const POLL_OBSERVATION_FILE_PATTERN = /^poll-([a-f0-9]{64})\.v1\.json$/;
const MAX_STATE_FILE_BYTES = 1024 * 1024;
const MAX_PROVIDER_RESPONSE_BYTES = 256 * 1024;
const MAX_WEBHOOK_BYTES = 1024 * 1024;
const DEFAULT_TIMEOUT_MS = 60_000;
const STAGING_QUARANTINE_AFTER_MS = 5 * 60 * 1000;
const STAGING_FUTURE_MTIME_TOLERANCE_MS = 60_000;
const STAGING_FILE_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,220}-[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\.tmp$/;
const TERMINAL_STATE_ERROR_DETAILS = Object.freeze({
  reconciliation_class: "terminal_state_invalid",
  read_retry_safe: false,
  create_retry_allowed: false,
});
const TERMINAL_UNRECONCILABLE_ERROR_DETAILS = Object.freeze({
  reconciliation_class: "terminal_unreconcilable",
  read_retry_safe: false,
  create_retry_allowed: false,
});
const RETRYABLE_READ_ERROR_DETAILS = Object.freeze({
  reconciliation_class: "retryable_read_failure",
  read_retry_safe: true,
  create_retry_allowed: false,
});
// A committed claim with no outcome file is either a create still in flight or
// a process that stopped between claim and outcome. The retained state cannot
// tell those apart, so the class names only what was observed: nothing has been
// retained. Re-reading is safe; creating again never is.
const OUTCOME_NOT_RETAINED_ERROR_DETAILS = Object.freeze({
  reconciliation_class: "outcome_not_retained",
  read_retry_safe: true,
  create_retry_allowed: false,
});
const OUTCOME_NOT_RETAINED_MESSAGE =
  "This Lumin operation consumed its authority, but no create outcome has been retained. "
  + "The create may still be in flight, or the process may have stopped before retaining its outcome; "
  + "the retained state cannot distinguish them. Re-reading is safe and never creates a second signing request.";

export const LUMIN_SIGN_V1_OPERATION_REFERENCES = deepFreeze({
  observed_at: "2026-09-04",
  openapi: {
    url: "https://developers.luminpdf.com/tabs/api-reference/openapi.json",
    sha256: "8842b7938870ea05b8c8d5869a33cc16b33b2eb0b8f2b1c60607203e39bfd037",
    status_path: "/signature_request/{signature_request_id}",
    artifact_path: "/signature_request/{signature_request_id}/file",
    status_values: [...STATUS_VALUE_LIST].sort(),
    artifact_file_types: [...ARTIFACT_FILE_TYPE_LIST].sort(),
  },
  app_webhooks: {
    url: "https://developers.luminpdf.com/tabs/guides/webhooks/app-webhooks",
    signature_header: "X-Signature",
    verification: "HMAC-SHA256 of the exact raw request body with the app signing secret",
    supported_app_type: "private_server_only",
    current_public_pkce_client_compatible: false,
    activation_status: "future_server_contract_only",
  },
  webhook_overview: {
    url: "https://developers.luminpdf.com/tabs/guides/webhooks/overview",
    idempotency: "signature_request_id plus event_type",
  },
});

function canonicalJson(value) {
  if (Array.isArray(value)) {
    const items = [];
    for (let index = 0; index < value.length; index += 1) items.push(canonicalJson(value[index]));
    return `[${items.join(",")}]`;
  }
  if (value && typeof value === "object") {
    return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function lifecycleDigest(domain, value) {
  return sha256(Buffer.from(`${domain}\0${canonicalJson(value)}`, "utf8"));
}

function operationError(code, message, details = null) {
  const error = new Error(`${code}: ${message}`);
  Object.defineProperty(error, "code", {
    value: code,
    enumerable: true,
    writable: false,
    configurable: false,
  });
  if (details !== null) {
    for (const [key, value] of Object.entries(details)) {
      Object.defineProperty(error, key, {
        value,
        enumerable: true,
        writable: false,
        configurable: false,
      });
    }
  }
  return error;
}

function assertRecord(value, required, optional = []) {
  if (!value || typeof value !== "object" || Array.isArray(value) || utilTypes.isProxy(value)) {
    throw new Error("invalid object");
  }
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) throw new Error("invalid object prototype");
  const ownKeys = Reflect.ownKeys(value);
  const allowed = [...required, ...optional].sort();
  if (
    ownKeys.length < required.length
    || ownKeys.length > allowed.length
    || ownKeys.some(key => typeof key !== "string")
  ) {
    throw new Error("invalid object keys");
  }
  const actual = [...ownKeys].sort();
  if (actual.some(key => !allowed.includes(key)) || required.some(key => !actual.includes(key))) {
    throw new Error("invalid object keys");
  }
  const normalized = Object.create(null);
  for (const key of actual) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor?.enumerable || !("value" in descriptor)) throw new Error("invalid object property");
    normalized[key] = descriptor.value;
  }
  return normalized;
}

function assertJsonRecord(value) {
  if (!value || typeof value !== "object" || Array.isArray(value) || utilTypes.isProxy(value)) {
    throw new Error("invalid JSON object");
  }
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) throw new Error("invalid JSON object prototype");
  return value;
}

function assertDenseArray(value, { min = 0, max }) {
  const prototype = value && typeof value === "object" ? Object.getPrototypeOf(value) : undefined;
  if (
    !Array.isArray(value)
    || utilTypes.isProxy(value)
    || (prototype !== Array.prototype && prototype !== null)
  ) {
    throw new Error("invalid array");
  }
  if (!Number.isSafeInteger(value.length) || value.length < min || value.length > max) {
    throw new Error("invalid array length");
  }
  const ownKeys = Reflect.ownKeys(value);
  if (ownKeys.length !== value.length + 1 || ownKeys.some(key => typeof key !== "string")) {
    throw new Error("invalid array keys");
  }
  const normalized = [];
  for (let index = 0; index < value.length; index += 1) {
    const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
    if (!descriptor?.enumerable || !("value" in descriptor)) throw new Error("invalid array element");
    normalized.push(descriptor.value);
  }
  return normalized;
}

function assertString(value, { max, pattern = null }) {
  if (
    typeof value !== "string"
    || value !== value.trim()
    || value.length < 1
    || value.length > max
    || (pattern && !pattern.test(value))
  ) {
    throw new Error("invalid string");
  }
  return value;
}

function assertSha256(value) {
  return assertString(value, { max: 64, pattern: SHA256_PATTERN });
}

function assertIsoTimestamp(value) {
  const text = assertString(value, { max: 32 });
  const parsed = new Date(text);
  if (Number.isNaN(parsed.getTime()) || parsed.toISOString() !== text) throw new Error("invalid timestamp");
  return parsed.getTime();
}

function isoTimestamp(nowMs) {
  if (!Number.isSafeInteger(nowMs) || nowMs < 0) throw new Error("invalid clock");
  return new Date(nowMs).toISOString();
}

function deepFreeze(value) {
  if (!value || typeof value !== "object" || Object.isFrozen(value)) return value;
  for (const key of Reflect.ownKeys(value)) deepFreeze(value[key]);
  return Object.freeze(value);
}

function isolateOutput(value) {
  if (Array.isArray(value)) {
    const output = [];
    for (let index = 0; index < value.length; index += 1) {
      output.push(isolateOutput(value[index]));
    }
    Object.setPrototypeOf(output, null);
    return output;
  }
  if (!value || typeof value !== "object") return value;
  const output = Object.create(null);
  for (const key of Object.keys(value)) output[key] = isolateOutput(value[key]);
  return output;
}

function parseStrictJson(value, label) {
  const text = Buffer.isBuffer(value) ? value.toString("utf8") : String(value);
  let index = 0;

  function skipWhitespace() {
    while (/\s/.test(text[index] ?? "")) index += 1;
  }

  function scanString() {
    const start = index;
    if (text[index] !== "\"") throw new Error(`${label} is not valid JSON`);
    index += 1;
    while (index < text.length) {
      const character = text[index];
      if (character === "\\") {
        index += 2;
      } else if (character === "\"") {
        index += 1;
        return JSON.parse(text.slice(start, index));
      } else {
        index += 1;
      }
    }
    throw new Error(`${label} is not valid JSON`);
  }

  function scanPrimitive() {
    const match = text.slice(index).match(/^(?:true|false|null|-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?)/);
    if (!match) throw new Error(`${label} is not valid JSON`);
    index += match[0].length;
  }

  function scanValue() {
    skipWhitespace();
    if (text[index] === "{") scanObject();
    else if (text[index] === "[") scanArray();
    else if (text[index] === "\"") scanString();
    else scanPrimitive();
  }

  function scanArray() {
    index += 1;
    skipWhitespace();
    if (text[index] === "]") {
      index += 1;
      return;
    }
    while (index < text.length) {
      scanValue();
      skipWhitespace();
      if (text[index] === "]") {
        index += 1;
        return;
      }
      if (text[index] !== ",") throw new Error(`${label} is not valid JSON`);
      index += 1;
      skipWhitespace();
    }
    throw new Error(`${label} is not valid JSON`);
  }

  function scanObject() {
    index += 1;
    const keys = new Set();
    skipWhitespace();
    if (text[index] === "}") {
      index += 1;
      return;
    }
    while (index < text.length) {
      const key = scanString();
      if (keys.has(key)) throw new Error(`${label} contains a duplicate object member`);
      keys.add(key);
      skipWhitespace();
      if (text[index] !== ":") throw new Error(`${label} is not valid JSON`);
      index += 1;
      scanValue();
      skipWhitespace();
      if (text[index] === "}") {
        index += 1;
        return;
      }
      if (text[index] !== ",") throw new Error(`${label} is not valid JSON`);
      index += 1;
      skipWhitespace();
    }
    throw new Error(`${label} is not valid JSON`);
  }

  scanValue();
  skipWhitespace();
  if (index !== text.length) throw new Error(`${label} is not valid JSON`);
  return JSON.parse(text);
}

function validateStateRoot(value) {
  if (process.platform === "win32") throw new Error("unsupported durable state platform");
  const stateRoot = assertString(value, { max: 32_768 });
  if (!path.isAbsolute(stateRoot) || path.resolve(stateRoot) !== stateRoot) {
    throw new Error("invalid state root");
  }
  return stateRoot;
}

function assertPrivateMode(stats, expected, label) {
  if (process.platform !== "win32" && (stats.mode & 0o777) !== expected) {
    throw new Error(`${label} has unsafe permissions`);
  }
  if (process.platform !== "win32") {
    const userId = typeof process.geteuid === "function"
      ? process.geteuid()
      : typeof process.getuid === "function"
        ? process.getuid()
        : null;
    if (userId === null || stats.uid !== userId) {
      throw new Error(`${label} is owned by another user`);
    }
  }
}

async function ensurePrivateDirectory(directoryPath, { create }) {
  if (create) {
    try {
      await fs.mkdir(directoryPath, { mode: 0o700 });
    } catch (error) {
      if (error?.code !== "EEXIST") throw error;
    }
  }
  const stats = await fs.lstat(directoryPath);
  if (!stats.isDirectory() || stats.isSymbolicLink()) throw new Error("state path is not a physical directory");
  assertPrivateMode(stats, 0o700, "state directory");
  if (await fs.realpath(directoryPath) !== directoryPath) throw new Error("state directory path is not canonical");
  return stats;
}

async function syncDirectory(directoryPath) {
  // Node cannot open NTFS directories for fsync. Retained files are flushed
  // before publication, but Windows directory-metadata durability remains an
  // explicit host limitation rather than a false POSIX guarantee.
  if (process.platform === "win32") return;
  let handle;
  try {
    handle = await fs.open(directoryPath, fsConstants.O_RDONLY);
    await handle.sync();
  } finally {
    await handle?.close().catch(() => {});
  }
}

async function writeExclusiveJson(filePath, value) {
  const bytes = Buffer.from(`${canonicalJson(value)}\n`, "utf8");
  if (bytes.length > MAX_STATE_FILE_BYTES) throw new Error("state file exceeds limit");
  let handle;
  try {
    handle = await fs.open(
      filePath,
      fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL | (fsConstants.O_NOFOLLOW ?? 0),
      0o600,
    );
    await handle.writeFile(bytes);
    await handle.sync();
  } finally {
    await handle?.close().catch(() => {});
  }
  const stats = await fs.lstat(filePath);
  if (!stats.isFile() || stats.isSymbolicLink() || stats.size !== bytes.length) {
    throw new Error("state file did not retain exact bytes");
  }
  assertPrivateMode(stats, 0o600, "state file");
  return bytes;
}

async function commitExclusiveJson(filePath, value, stagingRoot, { allowPrunedPoll = false } = {}) {
  await ensurePrivateDirectory(stagingRoot, { create: false });
  const stagedPath = path.join(
    stagingRoot,
    `${path.basename(filePath)}-${randomUUID()}.tmp`,
  );
  let staged = false;
  try {
    const bytes = await writeExclusiveJson(stagedPath, value);
    staged = true;
    await fs.link(stagedPath, filePath);
    await syncDirectory(path.dirname(filePath));
    let committed;
    try {
      committed = await readPrivateJson(filePath);
    } catch (error) {
      // A poll's exact staged bytes have already been atomically linked and
      // the directory flushed. Another poll may now prune that older entry.
      // Only disposable poll observations permit this race; claims, outcomes,
      // artifacts, and webhooks still require the published-file readback.
      if (allowPrunedPoll && error?.code === "ENOENT") return bytes;
      throw error;
    }
    if (
      committed.bytes.length !== bytes.length
      || !timingSafeEqual(committed.bytes, bytes)
      || canonicalJson(committed.value) !== canonicalJson(value)
    ) {
      throw new Error("committed state does not match staged bytes");
    }
    return bytes;
  } finally {
    if (staged) {
      try {
        await fs.unlink(stagedPath);
        await syncDirectory(stagingRoot);
      } catch {
        // The committed link is authoritative; an unused private staging link
        // must not turn a verified provider outcome into an unknown one.
      }
    }
  }
}

async function readPrivateJson(filePath) {
  let handle;
  try {
    handle = await fs.open(filePath, fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW ?? 0));
    const stats = await handle.stat();
    if (!stats.isFile() || stats.size < 2 || stats.size > MAX_STATE_FILE_BYTES) {
      throw new Error("invalid state file");
    }
    assertPrivateMode(stats, 0o600, "state file");
    const bytes = await handle.readFile();
    if (bytes.length !== stats.size || bytes[bytes.length - 1] !== 0x0a) throw new Error("invalid state bytes");
    return { bytes, stats, value: parseStrictJson(bytes, "state file") };
  } finally {
    await handle?.close().catch(() => {});
  }
}

async function validateStagingEntry(filePath) {
  const stats = await fs.lstat(filePath);
  if (!stats.isFile() || stats.isSymbolicLink()) throw new Error("invalid staging entry");
  assertPrivateMode(stats, 0o600, "staging file");
  if (!Number.isSafeInteger(stats.nlink) || stats.nlink < 1 || stats.nlink > 2) {
    throw new Error("invalid staging link count");
  }
  if (!Number.isFinite(stats.mtimeMs)) throw new Error("invalid staging timestamp");
  return stats;
}

function sameFileIdentity(left, right) {
  return left.dev === right.dev && left.ino === right.ino;
}

async function unlinkMatchingStagingEntry(filePath, expectedStats) {
  let currentStats;
  try {
    currentStats = await validateStagingEntry(filePath);
  } catch (error) {
    if (error?.code === "ENOENT") return false;
    throw error;
  }
  if (!sameFileIdentity(currentStats, expectedStats)) {
    throw new Error("staging entry identity changed before cleanup");
  }
  try {
    await fs.unlink(filePath);
    return true;
  } catch (error) {
    if (error?.code === "ENOENT") return false;
    throw error;
  }
}

async function reconcileStagingRoot(stagingRoot) {
  const entries = await fs.readdir(stagingRoot, { withFileTypes: true });
  const quarantineEntry = entries.find(entry => entry.name === QUARANTINE_DIRECTORY);
  if (quarantineEntry) {
    if (!quarantineEntry.isDirectory() || quarantineEntry.isSymbolicLink()) {
      throw new Error("invalid staging quarantine");
    }
    const quarantinePath = path.join(stagingRoot, QUARANTINE_DIRECTORY);
    await ensurePrivateDirectory(quarantinePath, { create: false });
  }
  const observedAt = Date.now();
  for (const entry of entries) {
    if (entry.name === QUARANTINE_DIRECTORY) continue;
    if (!STAGING_FILE_PATTERN.test(entry.name) || !entry.isFile() || entry.isSymbolicLink()) {
      throw new Error("invalid staging entry");
    }
    const stagedPath = path.join(stagingRoot, entry.name);
    let stats;
    try {
      stats = await validateStagingEntry(stagedPath);
    } catch (error) {
      if (error?.code === "ENOENT") continue;
      throw error;
    }
    if (stats.nlink === 2) {
      if (await unlinkMatchingStagingEntry(stagedPath, stats)) {
        await syncDirectory(stagingRoot);
      }
      continue;
    }
    if (stats.mtimeMs > observedAt + STAGING_FUTURE_MTIME_TOLERANCE_MS) {
      throw new Error("staging timestamp is in the future");
    }
    if (observedAt - stats.mtimeMs < STAGING_QUARANTINE_AFTER_MS) continue;
    const quarantinePath = path.join(stagingRoot, QUARANTINE_DIRECTORY);
    await ensurePrivateDirectory(quarantinePath, { create: true });
    const quarantinedPath = path.join(quarantinePath, entry.name);
    try {
      await fs.link(stagedPath, quarantinedPath);
    } catch (error) {
      if (!new Set(["EEXIST", "ENOENT"]).has(error?.code)) throw error;
      // Something already occupies the quarantine name. Only the same inode
      // (a concurrent reconciler's link) may proceed; a symlink, a foreign
      // file, or an unsafe entry at that exact name fails this create closed
      // and is left in place for operator review.
      const quarantinedStats = await validateStagingEntry(quarantinedPath);
      if (!sameFileIdentity(quarantinedStats, stats)) {
        throw new Error("staging quarantine identity collision");
      }
    }
    await unlinkMatchingStagingEntry(stagedPath, stats);
    await syncDirectory(quarantinePath);
    await syncDirectory(stagingRoot);
  }
}

async function prepareStateRoot(stateRoot) {
  await ensurePrivateDirectory(stateRoot, { create: true });
  const operationsRoot = path.join(stateRoot, OPERATION_DIRECTORY);
  await ensurePrivateDirectory(operationsRoot, { create: true });
  const stagingRoot = path.join(operationsRoot, STAGING_DIRECTORY);
  await ensurePrivateDirectory(stagingRoot, { create: true });
  await reconcileStagingRoot(stagingRoot);
  await syncDirectory(stateRoot);
  await syncDirectory(operationsRoot);
  return { operationsRoot, stagingRoot };
}

function buildDurableClaimAcknowledgement(identity, claim, claimBytes) {
  const unsigned = {
    schema_version: 1,
    provider: "lumin_sign",
    action: "create_signature_request",
    commit_status: "durable_claim_committed",
    authority_sha256: identity.authority_sha256,
    preparation_receipt_sha256: identity.preparation_receipt_sha256,
    mapper_contract_sha256: identity.mapper_contract_sha256,
    request_mapping_sha256: identity.request_mapping_sha256,
    prepared_document_sha256: identity.prepared_document_sha256,
    prepared_document_size_bytes: identity.prepared_document_size_bytes,
    participant_ids: [...identity.participant_ids],
    claim_started_at: claim.started_at,
    claim_sha256: claim.claim_sha256,
    claim_file_sha256: sha256(claimBytes),
    claim_file_size_bytes: claimBytes.length,
  };
  return deepFreeze(isolateOutput({
    ...unsigned,
    acknowledgement_sha256: lifecycleDigest(
      "pdf-tools.lumin-sign-v1-durable-claim-acknowledgement.v1",
      unsigned,
    ),
  }));
}

function validateRequestIdentity(value) {
  const identity = assertRecord(value, [
    "schema_version",
    "provider",
    "action",
    "authority_sha256",
    "preparation_receipt_sha256",
    "mapper_contract_sha256",
    "request_mapping_sha256",
    "prepared_document_sha256",
    "prepared_document_size_bytes",
    "participant_ids",
  ]);
  if (
    identity.schema_version !== 1
    || identity.provider !== "lumin_sign"
    || identity.action !== "create_signature_request"
  ) {
    throw new Error("invalid request identity");
  }
  for (const key of [
    "authority_sha256",
    "preparation_receipt_sha256",
    "mapper_contract_sha256",
    "request_mapping_sha256",
    "prepared_document_sha256",
  ]) assertSha256(identity[key]);
  if (!Number.isSafeInteger(identity.prepared_document_size_bytes) || identity.prepared_document_size_bytes < 1) {
    throw new Error("invalid prepared document size");
  }
  const participantIds = assertDenseArray(identity.participant_ids, { min: 1, max: 100 });
  if (new Set(participantIds).size !== participantIds.length) throw new Error("duplicate participant identity");
  participantIds.forEach(participantId => assertString(participantId, { max: 256, pattern: IDENTIFIER_PATTERN }));
  return { ...identity, participant_ids: [...participantIds] };
}

async function acquireOperationClaim(stateRoot, rawIdentity, startedAt) {
  const identity = validateRequestIdentity(rawIdentity);
  const { operationsRoot, stagingRoot } = await prepareStateRoot(stateRoot);
  const operationPath = path.join(operationsRoot, identity.authority_sha256);
  await ensurePrivateDirectory(operationPath, { create: true });
  await syncDirectory(operationsRoot);
  const existingEntries = await fs.readdir(operationPath);
  if (existingEntries.includes(CLAIM_FILE)) {
    throw operationError(
      "LUMIN_OPERATION_ALREADY_CONSUMED",
      "This exact Lumin signing authority has already been consumed and cannot be retried.",
    );
  }
  if (existingEntries.length !== 0) {
    throw new Error("operation directory is not empty before claim publication");
  }
  const unsigned = {
    schema_version: 1,
    provider: "lumin_sign",
    action: "create_signature_request",
    operation_status: "authority_consumed",
    automatic_retry_allowed: false,
    authority_sha256: identity.authority_sha256,
    preparation_receipt_sha256: identity.preparation_receipt_sha256,
    mapper_contract_sha256: identity.mapper_contract_sha256,
    request_mapping_sha256: identity.request_mapping_sha256,
    prepared_document_sha256: identity.prepared_document_sha256,
    prepared_document_size_bytes: identity.prepared_document_size_bytes,
    participant_ids: [...identity.participant_ids],
    started_at: startedAt,
  };
  const claim = {
    ...unsigned,
    claim_sha256: lifecycleDigest("pdf-tools.lumin-sign-v1-operation-claim.v1", unsigned),
  };
  try {
    const claimBytes = await commitExclusiveJson(path.join(operationPath, CLAIM_FILE), claim, stagingRoot);
    const acknowledgement = buildDurableClaimAcknowledgement(identity, claim, claimBytes);
    return {
      acknowledgement,
      claim: deepFreeze(isolateOutput(claim)),
      operationPath,
      stagingRoot,
    };
  } catch (error) {
    if (error?.code === "EEXIST") {
      throw operationError(
        "LUMIN_OPERATION_ALREADY_CONSUMED",
        "This exact Lumin signing authority has already been consumed and cannot be retried.",
      );
    }
    throw error;
  }
}

function buildOutcome({ claim, completedAt, result, failureCode }) {
  const operationStatus = result
    ? "request_created"
    : failureCode === "LUMIN_CREATE_REJECTED"
      ? "request_rejected"
      : "outcome_unknown";
  const unsigned = {
    schema_version: 1,
    provider: "lumin_sign",
    action: "create_signature_request",
    operation_status: operationStatus,
    authority_sha256: claim.authority_sha256,
    claim_sha256: claim.claim_sha256,
    completed_at: completedAt,
    attempt_count: 1,
    automatic_retry_performed: false,
    transport_receipt: result ? isolateOutput(result) : null,
    failure_code: result ? null : failureCode,
  };
  return deepFreeze(isolateOutput({
    ...unsigned,
    outcome_sha256: lifecycleDigest("pdf-tools.lumin-sign-v1-operation-outcome.v1", unsigned),
  }));
}

function validateClaim(value, authoritySha256) {
  const claim = assertRecord(value, [
    "schema_version",
    "provider",
    "action",
    "operation_status",
    "automatic_retry_allowed",
    "authority_sha256",
    "preparation_receipt_sha256",
    "mapper_contract_sha256",
    "request_mapping_sha256",
    "prepared_document_sha256",
    "prepared_document_size_bytes",
    "participant_ids",
    "started_at",
    "claim_sha256",
  ]);
  if (
    claim.schema_version !== 1
    || claim.provider !== "lumin_sign"
    || claim.action !== "create_signature_request"
    || claim.operation_status !== "authority_consumed"
    || claim.automatic_retry_allowed !== false
    || claim.authority_sha256 !== authoritySha256
  ) throw new Error("invalid operation claim");
  assertIsoTimestamp(claim.started_at);
  validateRequestIdentity({
    schema_version: claim.schema_version,
    provider: claim.provider,
    action: claim.action,
    authority_sha256: claim.authority_sha256,
    preparation_receipt_sha256: claim.preparation_receipt_sha256,
    mapper_contract_sha256: claim.mapper_contract_sha256,
    request_mapping_sha256: claim.request_mapping_sha256,
    prepared_document_sha256: claim.prepared_document_sha256,
    prepared_document_size_bytes: claim.prepared_document_size_bytes,
    participant_ids: claim.participant_ids,
  });
  const unsigned = { ...claim };
  delete unsigned.claim_sha256;
  if (assertSha256(claim.claim_sha256) !== lifecycleDigest(
    "pdf-tools.lumin-sign-v1-operation-claim.v1",
    unsigned,
  )) throw new Error("operation claim digest mismatch");
  return claim;
}

function validateTransportReceipt(receipt, claim) {
  const value = assertJsonRecord(receipt);
  if (
    value.schema_version !== 1
    || value.provider !== "lumin_sign"
    || value.action !== "create_signature_request"
    || value.provider_execution_status !== "request_created"
    || value.attempt_count !== 1
    || value.automatic_retry_performed !== false
  ) throw new Error("invalid transport receipt");
  const request = assertJsonRecord(value.request);
  assertSha256(request.durable_claim_acknowledgement_sha256);
  if (
    request.execution_authority_sha256 !== claim.authority_sha256
    || request.durable_claim_sha256 !== claim.claim_sha256
    || request.preparation_receipt_sha256 !== claim.preparation_receipt_sha256
    || request.mapper_contract_sha256 !== claim.mapper_contract_sha256
    || request.request_mapping_sha256 !== claim.request_mapping_sha256
    || request.prepared_document_sha256 !== claim.prepared_document_sha256
  ) throw new Error("transport receipt binding mismatch");
  const digest = assertSha256(value.transport_receipt_sha256);
  const unsigned = { ...value };
  delete unsigned.transport_receipt_sha256;
  if (digest !== lifecycleDigest("pdf-tools.lumin-sign-v1-transport-receipt.v1", unsigned)) {
    throw new Error("transport receipt digest mismatch");
  }
  const response = assertJsonRecord(value.response);
  assertString(response.signature_request_id, { max: 256, pattern: IDENTIFIER_PATTERN });
  return value;
}

function validateOutcome(value, claim) {
  const outcome = assertRecord(value, [
    "schema_version",
    "provider",
    "action",
    "operation_status",
    "authority_sha256",
    "claim_sha256",
    "completed_at",
    "attempt_count",
    "automatic_retry_performed",
    "transport_receipt",
    "failure_code",
    "outcome_sha256",
  ]);
  if (
    outcome.schema_version !== 1
    || outcome.provider !== "lumin_sign"
    || outcome.action !== "create_signature_request"
    || !["request_created", "request_rejected", "outcome_unknown"].includes(outcome.operation_status)
    || outcome.authority_sha256 !== claim.authority_sha256
    || outcome.claim_sha256 !== claim.claim_sha256
    || outcome.attempt_count !== 1
    || outcome.automatic_retry_performed !== false
    || assertIsoTimestamp(outcome.completed_at) < assertIsoTimestamp(claim.started_at)
  ) throw new Error("invalid operation outcome");
  if (outcome.operation_status === "request_created") {
    if (outcome.failure_code !== null) throw new Error("invalid created outcome");
    validateTransportReceipt(outcome.transport_receipt, claim);
  } else {
    if (
      outcome.transport_receipt !== null
      || !["LUMIN_CREATE_REJECTED", "LUMIN_CREATE_OUTCOME_UNKNOWN", "LUMIN_OPERATION_OUTCOME_UNKNOWN"]
        .includes(outcome.failure_code)
    ) throw new Error("invalid failed outcome");
  }
  const unsigned = { ...outcome };
  delete unsigned.outcome_sha256;
  if (assertSha256(outcome.outcome_sha256) !== lifecycleDigest(
    "pdf-tools.lumin-sign-v1-operation-outcome.v1",
    unsigned,
  )) throw new Error("operation outcome digest mismatch");
  return outcome;
}

async function loadOperation(stateRoot, authoritySha256) {
  const root = validateStateRoot(stateRoot);
  const authority = assertSha256(authoritySha256);
  await ensurePrivateDirectory(root, { create: false });
  const operationsRoot = path.join(root, OPERATION_DIRECTORY);
  await ensurePrivateDirectory(operationsRoot, { create: false });
  const operationPath = path.join(operationsRoot, authority);
  await ensurePrivateDirectory(operationPath, { create: false });
  const entries = await fs.readdir(operationPath, { withFileTypes: true });
  const allowed = new Set([CLAIM_FILE, OUTCOME_FILE, OBSERVATIONS_DIRECTORY]);
  if (entries.some(entry => !allowed.has(entry.name))) throw new Error("unexpected operation state entry");
  const claimRead = await readPrivateJson(path.join(operationPath, CLAIM_FILE));
  const claim = validateClaim(claimRead.value, authority);
  let outcome = null;
  try {
    const outcomeRead = await readPrivateJson(path.join(operationPath, OUTCOME_FILE));
    outcome = validateOutcome(outcomeRead.value, claim);
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
  }
  return { claim, operationPath, outcome };
}

export async function executeDurableLuminSignV1DirectUpload(input, options = {}) {
  let validatedOptions;
  let stateRoot;
  try {
    validatedOptions = assertRecord(options, ["fetchImpl", "stateRoot"], ["nowMs", "timeoutMs"]);
    stateRoot = validateStateRoot(validatedOptions.stateRoot);
  } catch {
    throw operationError("LUMIN_OPERATION_INPUT_INVALID", "The Lumin operation configuration is invalid.");
  }
  // One clock instant for the whole create. The claim's started_at and the
  // transport's acknowledgement check must read the same millisecond; letting
  // the transport sample Date.now() again would commit the claim and then
  // refuse provider entry whenever the two reads straddled a tick.
  const startedMs = validatedOptions.nowMs === undefined ? Date.now() : validatedOptions.nowMs;
  let claimed = null;
  let claimError = null;
  try {
    const result = await executeAuthorizedLuminSignV1DirectUpload(input, {
      fetchImpl: validatedOptions.fetchImpl,
      nowMs: startedMs,
      ...(validatedOptions.timeoutMs === undefined ? {} : { timeoutMs: validatedOptions.timeoutMs }),
      beforeRequest: async requestIdentity => {
        try {
          claimed = await acquireOperationClaim(stateRoot, requestIdentity, isoTimestamp(startedMs));
        } catch (error) {
          claimError = error?.code?.startsWith?.("LUMIN_")
            ? error
            : operationError(
                "LUMIN_OPERATION_STATE_REJECTED",
                "The durable operation claim could not be committed before any provider call.",
              );
          throw claimError;
        }
        return claimed.acknowledgement;
      },
    });
    if (!claimed) throw new Error("provider result exists without durable claim");
    const completedMs = validatedOptions.nowMs === undefined ? Date.now() : validatedOptions.nowMs;
    const outcome = buildOutcome({
      claim: claimed.claim,
      completedAt: isoTimestamp(Math.max(completedMs, startedMs)),
      result,
      failureCode: null,
    });
    await commitExclusiveJson(
      path.join(claimed.operationPath, OUTCOME_FILE),
      outcome,
      claimed.stagingRoot,
    );
    return deepFreeze(isolateOutput({ result, operation: outcome }));
  } catch (error) {
    if (claimError) throw claimError;
    if (!claimed) throw error;
    const failureCode = ["LUMIN_CREATE_REJECTED", "LUMIN_CREATE_OUTCOME_UNKNOWN"].includes(error?.code)
      ? error.code
      : "LUMIN_OPERATION_OUTCOME_UNKNOWN";
    const completedMs = validatedOptions.nowMs === undefined ? Date.now() : validatedOptions.nowMs;
    const outcome = buildOutcome({
      claim: claimed.claim,
      completedAt: isoTimestamp(Math.max(completedMs, startedMs)),
      result: null,
      failureCode,
    });
    try {
      await commitExclusiveJson(
        path.join(claimed.operationPath, OUTCOME_FILE),
        outcome,
        claimed.stagingRoot,
      );
    } catch {
      throw operationError(
        "LUMIN_OPERATION_STATE_INCOMPLETE",
        "The Lumin request authority remains consumed, but its final outcome could not be retained.",
      );
    }
    throw error;
  }
}

function classifyRetainedOutcome(outcome) {
  if (outcome === null) return OUTCOME_NOT_RETAINED_ERROR_DETAILS.reconciliation_class;
  if (outcome.operation_status === "request_created") return "reconcilable_by_request_id";
  return TERMINAL_UNRECONCILABLE_ERROR_DETAILS.reconciliation_class;
}

export async function inspectLuminSignV1Operation(input) {
  let request;
  try {
    request = assertRecord(input, ["state_root", "authority_sha256"]);
    const loaded = await loadOperation(request.state_root, request.authority_sha256);
    // "outcome_unknown" is a retained, terminal verdict written by the wrapper.
    // A claim with no outcome file is not that: it is the claim's own status,
    // authority_consumed, with nothing retained yet or ever.
    return deepFreeze(isolateOutput({
      schema_version: 1,
      provider: "lumin_sign",
      authority_sha256: loaded.claim.authority_sha256,
      claim_sha256: loaded.claim.claim_sha256,
      operation_status: loaded.outcome ? loaded.outcome.operation_status : loaded.claim.operation_status,
      outcome_status: loaded.outcome ? "retained" : "not_retained",
      reconciliation_class: classifyRetainedOutcome(loaded.outcome),
      outcome_sha256: loaded.outcome?.outcome_sha256 ?? null,
      transport_receipt: loaded.outcome?.transport_receipt ?? null,
      automatic_retry_allowed: false,
      create_retry_allowed: false,
    }));
  } catch (error) {
    if (error?.code?.startsWith?.("LUMIN_")) throw error;
    throw operationError("LUMIN_OPERATION_STATE_INVALID", "The retained Lumin operation state is missing or invalid.");
  }
}

async function readBoundedProviderJson(response, label) {
  const contentType = response.headers?.get?.("content-type")?.split(";", 1)[0]?.trim()?.toLowerCase();
  if (contentType !== "application/json") {
    await response.body?.cancel?.().catch(() => {});
    throw new Error("invalid provider response type");
  }
  const declaredLength = response.headers.get("content-length");
  if (declaredLength !== null && (!/^\d+$/.test(declaredLength) || Number(declaredLength) > MAX_PROVIDER_RESPONSE_BYTES)) {
    await response.body?.cancel?.().catch(() => {});
    throw new Error("invalid provider response length");
  }
  const reader = response.body?.getReader?.();
  if (!reader) {
    await response.body?.cancel?.().catch(() => {});
    throw new Error("invalid provider response body");
  }
  const chunks = [];
  let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!(value instanceof Uint8Array)) throw new Error("invalid provider response chunk");
      total += value.byteLength;
      if (total > MAX_PROVIDER_RESPONSE_BYTES) throw new Error("provider response exceeds limit");
      chunks.push(Buffer.from(value));
    }
  } catch (error) {
    await reader.cancel().catch(() => {});
    throw error;
  }
  const bytes = Buffer.concat(chunks, total);
  return { bytes, value: parseStrictJson(bytes, label) };
}

async function writeObservation(operationPath, prefix, observation) {
  const observationsPath = path.join(operationPath, OBSERVATIONS_DIRECTORY);
  await ensurePrivateDirectory(observationsPath, { create: true });
  const filePath = path.join(observationsPath, `${prefix}-${observation.observation_sha256}.v1.json`);
  try {
    await commitExclusiveJson(
      filePath,
      observation,
      path.join(path.dirname(operationPath), STAGING_DIRECTORY),
      { allowPrunedPoll: prefix === "poll" },
    );
  } catch (error) {
    if (error?.code !== "EEXIST") throw error;
    let existing;
    try {
      existing = await readPrivateJson(filePath);
    } catch (readError) {
      // A duplicate older poll can disappear after EEXIST for the same
      // reason as a newly published older poll: concurrent retention removed
      // it. Other observation types still require exact collision readback.
      if (prefix === "poll" && readError?.code === "ENOENT") return observation;
      throw readError;
    }
    if (`${canonicalJson(existing.value)}\n` !== existing.bytes.toString("utf8") || canonicalJson(existing.value) !== canonicalJson(observation)) {
      throw new Error("observation identity collision");
    }
  }
  return observation;
}

function validateStatusObservation(value, binding, expectedDigest) {
  const observation = assertRecord(value, [
    "schema_version",
    "provider",
    "observation_source",
    "authority_sha256",
    "claim_sha256",
    "outcome_sha256",
    "signature_request_id",
    "status",
    "observed_at",
    "endpoint_path",
    "provider_response_sha256",
    "access_token_persisted",
    "response_body_persisted",
    "automatic_retry_performed",
    "observation_sha256",
  ]);
  if (
    observation.schema_version !== 1
    || observation.provider !== "lumin_sign"
    || observation.observation_source !== "authenticated_poll"
    || observation.authority_sha256 !== binding.authority_sha256
    || observation.claim_sha256 !== binding.claim_sha256
    || observation.outcome_sha256 !== binding.outcome_sha256
    || observation.signature_request_id !== binding.signature_request_id
    || !STATUS_VALUES.has(observation.status)
    || observation.endpoint_path !== "/signature_request/{signature_request_id}"
    || observation.access_token_persisted !== false
    || observation.response_body_persisted !== false
    || observation.automatic_retry_performed !== false
  ) throw new Error("invalid status observation");
  const observedAtMs = assertIsoTimestamp(observation.observed_at);
  assertSha256(observation.provider_response_sha256);
  const digest = assertSha256(observation.observation_sha256);
  const unsigned = { ...observation };
  delete unsigned.observation_sha256;
  if (
    digest !== expectedDigest
    || digest !== lifecycleDigest("pdf-tools.lumin-sign-v1-status-observation.v1", unsigned)
  ) throw new Error("status observation digest mismatch");
  return { observedAtMs };
}

async function readRetainedPollObservations(operationPath, binding) {
  const observationsPath = path.join(operationPath, OBSERVATIONS_DIRECTORY);
  await ensurePrivateDirectory(observationsPath, { create: true });
  const directoryEntries = await fs.readdir(observationsPath, { withFileTypes: true });
  const retained = [];
  for (const directoryEntry of directoryEntries) {
    if (!directoryEntry.name.startsWith("poll-")) continue;
    const match = directoryEntry.name.match(POLL_OBSERVATION_FILE_PATTERN);
    if (!match || !directoryEntry.isFile() || directoryEntry.isSymbolicLink()) {
      throw new Error("invalid retained poll observation entry");
    }
    const filePath = path.join(observationsPath, directoryEntry.name);
    let read;
    try {
      read = await readPrivateJson(filePath);
    } catch (error) {
      if (error?.code === "ENOENT") continue;
      throw error;
    }
    const { observedAtMs } = validateStatusObservation(read.value, binding, match[1]);
    retained.push({
      digest: match[1],
      filePath,
      observedAtMs,
      stats: read.stats,
    });
  }
  retained.sort((left, right) => left.observedAtMs - right.observedAtMs
    || (left.digest < right.digest ? -1 : left.digest > right.digest ? 1 : 0));
  return { observationsPath, retained };
}

async function unlinkRetainedPollObservation(observation) {
  let currentStats;
  try {
    currentStats = await fs.lstat(observation.filePath);
  } catch (error) {
    if (error?.code === "ENOENT") return false;
    throw error;
  }
  if (!currentStats.isFile() || currentStats.isSymbolicLink()) {
    throw new Error("retained poll observation changed before cleanup");
  }
  assertPrivateMode(currentStats, 0o600, "state file");
  if (!sameFileIdentity(currentStats, observation.stats)) {
    throw new Error("retained poll observation identity changed before cleanup");
  }
  try {
    await fs.unlink(observation.filePath);
    return true;
  } catch (error) {
    if (error?.code === "ENOENT") return false;
    throw error;
  }
}

async function prunePollObservations(operationPath, binding, retainedLimit) {
  if (!Number.isSafeInteger(retainedLimit) || retainedLimit < 2 || retainedLimit > MAX_RETAINED_POLL_OBSERVATIONS) {
    throw new Error("invalid poll observation retention limit");
  }
  const { observationsPath, retained } = await readRetainedPollObservations(operationPath, binding);
  if (retained.length <= retainedLimit) return;
  const keep = new Set([retained[0].filePath]);
  for (const observation of retained.slice(-(retainedLimit - 1))) keep.add(observation.filePath);
  let deleted = false;
  try {
    for (const observation of retained) {
      if (keep.has(observation.filePath)) continue;
      deleted = await unlinkRetainedPollObservation(observation) || deleted;
    }
  } finally {
    if (deleted) await syncDirectory(observationsPath);
  }
}

export async function pollAndRecordLuminSignV1Status(input, options = {}) {
  let accessToken;
  let controller;
  let failureClass = "input";
  let timer;
  try {
    const request = assertRecord(input, ["access_token", "authority_sha256", "state_root"]);
    const validatedOptions = assertRecord(options, ["fetchImpl"], ["nowMs", "timeoutMs"]);
    if (typeof validatedOptions.fetchImpl !== "function") throw new Error("missing polling transport");
    const nowMs = validatedOptions.nowMs === undefined ? Date.now() : validatedOptions.nowMs;
    const timeoutMs = validatedOptions.timeoutMs === undefined ? DEFAULT_TIMEOUT_MS : validatedOptions.timeoutMs;
    if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > DEFAULT_TIMEOUT_MS) {
      throw new Error("invalid polling timeout");
    }
    accessToken = assertString(request.access_token, { max: 8192, pattern: TOKEN_PATTERN });
    failureClass = "state";
    const loaded = await loadOperation(request.state_root, request.authority_sha256);
    if (loaded.outcome === null) {
      failureClass = "not_retained";
      throw new Error("operation outcome is not retained");
    }
    failureClass = "unreconcilable";
    if (loaded.outcome.operation_status !== "request_created") throw new Error("operation is not reconcilable by ID");
    const transportReceipt = validateTransportReceipt(loaded.outcome.transport_receipt, loaded.claim);
    const signatureRequestId = transportReceipt.response.signature_request_id;
    failureClass = "retryable";
    const observationBinding = {
      authority_sha256: loaded.claim.authority_sha256,
      claim_sha256: loaded.claim.claim_sha256,
      outcome_sha256: loaded.outcome.outcome_sha256,
      signature_request_id: signatureRequestId,
    };
    // Compact before contacting the provider so invalid retained state cannot
    // cause another network read or continue growing. Do not reserve a slot:
    // failed or duplicate reads must not evict useful retained history.
    await prunePollObservations(
      loaded.operationPath,
      observationBinding,
      MAX_RETAINED_POLL_OBSERVATIONS,
    );
    controller = new AbortController();
    timer = setTimeout(() => controller.abort(), timeoutMs);
    const response = await validatedOptions.fetchImpl(
      `https://api.luminpdf.com/v1/signature_request/${encodeURIComponent(signatureRequestId)}`,
      {
        method: "GET",
        headers: {
          accept: "application/json",
          authorization: `Bearer ${accessToken}`,
          "user-agent": LUMIN_CLIENT_USER_AGENT,
        },
        redirect: "error",
        signal: controller.signal,
      },
    );
    if (response.status !== 200) {
      await response.body?.cancel?.().catch(() => {});
      throw new Error("status request rejected");
    }
    const provider = await readBoundedProviderJson(response, "Lumin status response");
    const envelope = assertRecord(provider.value, ["signature_request"]);
    const statusRequest = assertJsonRecord(envelope.signature_request);
    if (
      assertString(statusRequest.signature_request_id, { max: 256, pattern: IDENTIFIER_PATTERN }) !== signatureRequestId
      || !STATUS_VALUES.has(statusRequest.status)
    ) throw new Error("status response binding mismatch");
    const unsigned = {
      schema_version: 1,
      provider: "lumin_sign",
      observation_source: "authenticated_poll",
      authority_sha256: loaded.claim.authority_sha256,
      claim_sha256: loaded.claim.claim_sha256,
      outcome_sha256: loaded.outcome.outcome_sha256,
      signature_request_id: signatureRequestId,
      status: statusRequest.status,
      observed_at: isoTimestamp(nowMs),
      endpoint_path: "/signature_request/{signature_request_id}",
      provider_response_sha256: sha256(provider.bytes),
      access_token_persisted: false,
      response_body_persisted: false,
      automatic_retry_performed: false,
    };
    const observation = deepFreeze(isolateOutput({
      ...unsigned,
      observation_sha256: lifecycleDigest("pdf-tools.lumin-sign-v1-status-observation.v1", unsigned),
    }));
    await writeObservation(loaded.operationPath, "poll", observation);
    await prunePollObservations(
      loaded.operationPath,
      observationBinding,
      MAX_RETAINED_POLL_OBSERVATIONS,
    );
    return observation;
  } catch {
    if (failureClass === "input") {
      throw operationError("LUMIN_STATUS_INPUT_INVALID", "The Lumin status request is invalid.");
    }
    if (failureClass === "state") {
      throw operationError(
        "LUMIN_OPERATION_STATE_INVALID",
        "The retained Lumin operation state is missing or invalid and cannot be reconciled.",
        TERMINAL_STATE_ERROR_DETAILS,
      );
    }
    if (failureClass === "unreconcilable") {
      throw operationError(
        "LUMIN_OPERATION_UNRECONCILABLE",
        "This operation has no verified Lumin request identity and cannot be reconciled by polling.",
        TERMINAL_UNRECONCILABLE_ERROR_DETAILS,
      );
    }
    if (failureClass === "not_retained") {
      throw operationError(
        "LUMIN_OPERATION_OUTCOME_NOT_RETAINED",
        OUTCOME_NOT_RETAINED_MESSAGE,
        OUTCOME_NOT_RETAINED_ERROR_DETAILS,
      );
    }
    throw operationError(
      "LUMIN_STATUS_OBSERVATION_RETRYABLE",
      "The existing Lumin request status could not be verified or retained. Retrying this read will not create a new signing request.",
      RETRYABLE_READ_ERROR_DETAILS,
    );
  } finally {
    if (timer) clearTimeout(timer);
    accessToken = null;
  }
}

export async function requestAndRecordLuminSignV1ArtifactAccess(input, options = {}) {
  let accessToken;
  let accessUrl;
  let controller;
  let failureClass = "input";
  let timer;
  try {
    const request = assertRecord(input, ["access_token", "authority_sha256", "file_type", "state_root"]);
    const validatedOptions = assertRecord(options, ["fetchImpl"], ["nowMs", "timeoutMs"]);
    if (typeof validatedOptions.fetchImpl !== "function") throw new Error("missing artifact transport");
    const nowMs = validatedOptions.nowMs === undefined ? Date.now() : validatedOptions.nowMs;
    const timeoutMs = validatedOptions.timeoutMs === undefined ? DEFAULT_TIMEOUT_MS : validatedOptions.timeoutMs;
    if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > DEFAULT_TIMEOUT_MS) {
      throw new Error("invalid artifact timeout");
    }
    const fileType = assertString(request.file_type, { max: 16 });
    if (!ARTIFACT_FILE_TYPES.has(fileType)) throw new Error("invalid artifact type");
    accessToken = assertString(request.access_token, { max: 8192, pattern: TOKEN_PATTERN });
    failureClass = "state";
    const loaded = await loadOperation(request.state_root, request.authority_sha256);
    if (loaded.outcome === null) {
      failureClass = "not_retained";
      throw new Error("operation outcome is not retained");
    }
    failureClass = "unreconcilable";
    if (loaded.outcome.operation_status !== "request_created") throw new Error("operation has no provider identity");
    const transportReceipt = validateTransportReceipt(loaded.outcome.transport_receipt, loaded.claim);
    const signatureRequestId = transportReceipt.response.signature_request_id;
    failureClass = "retryable";
    controller = new AbortController();
    timer = setTimeout(() => controller.abort(), timeoutMs);
    const response = await validatedOptions.fetchImpl(
      `https://api.luminpdf.com/v1/signature_request/${encodeURIComponent(signatureRequestId)}/file?type=${fileType}`,
      {
        method: "GET",
        headers: {
          accept: "application/json",
          authorization: `Bearer ${accessToken}`,
          "user-agent": LUMIN_CLIENT_USER_AGENT,
        },
        redirect: "error",
        signal: controller.signal,
      },
    );
    if (response.status !== 200) {
      await response.body?.cancel?.().catch(() => {});
      throw new Error("artifact request rejected");
    }
    const provider = await readBoundedProviderJson(response, "Lumin artifact response");
    const envelope = assertRecord(provider.value, ["expires_at", "signed_url"], ["download_url"]);
    // The live endpoint also supplies a download URL. Validate its shape but
    // use only signed_url; neither URL may enter durable state or tool output.
    if (Object.hasOwn(envelope, "download_url")) {
      const downloadUrl = new URL(assertString(envelope.download_url, { max: 4096 }));
      if (downloadUrl.protocol !== "https:" || downloadUrl.username || downloadUrl.password || downloadUrl.hash || !downloadUrl.hostname) {
        throw new Error("invalid optional artifact download URL");
      }
    }
    accessUrl = assertString(envelope.signed_url, { max: 4096 });
    const parsedUrl = new URL(accessUrl);
    if (
      parsedUrl.protocol !== "https:"
      || parsedUrl.username
      || parsedUrl.password
      || parsedUrl.hash
      || !parsedUrl.hostname
    ) throw new Error("invalid artifact access URL");
    if (!Number.isSafeInteger(envelope.expires_at)) throw new Error("invalid artifact expiry");
    // The documented epoch value historically used seconds; live responses
    // use milliseconds. Admit only a uniquely valid interpretation within the
    // same short lifetime, and retain seconds for existing observation readers.
    const expiryCandidates = [envelope.expires_at, Math.floor(envelope.expires_at / 1000)]
      .filter(value => value > Math.floor(nowMs / 1000) && value <= Math.ceil(nowMs / 1000) + (31 * 60));
    if (expiryCandidates.length !== 1) throw new Error("invalid artifact expiry");
    const expiresAt = expiryCandidates[0];
    const unsigned = {
      schema_version: 1,
      provider: "lumin_sign",
      observation_source: "authenticated_artifact_access",
      authority_sha256: loaded.claim.authority_sha256,
      claim_sha256: loaded.claim.claim_sha256,
      outcome_sha256: loaded.outcome.outcome_sha256,
      signature_request_id: signatureRequestId,
      file_type: fileType,
      observed_at: isoTimestamp(nowMs),
      endpoint_path: "/signature_request/{signature_request_id}/file",
      provider_response_sha256: sha256(provider.bytes),
      access_url_sha256: sha256(Buffer.from(accessUrl, "utf8")),
      access_url_expires_at: expiresAt,
      access_token_persisted: false,
      access_url_persisted: false,
      response_body_persisted: false,
      automatic_retry_performed: false,
    };
    const observation = deepFreeze(isolateOutput({
      ...unsigned,
      observation_sha256: lifecycleDigest("pdf-tools.lumin-sign-v1-artifact-observation.v1", unsigned),
    }));
    await writeObservation(loaded.operationPath, `artifact-${fileType}`, observation);
    return deepFreeze(isolateOutput({
      schema_version: 1,
      file_type: fileType,
      signed_url: accessUrl,
      expires_at: expiresAt,
      observation,
      persistence_policy: "ephemeral_caller_consumption_only",
    }));
  } catch {
    if (failureClass === "input") {
      throw operationError("LUMIN_ARTIFACT_INPUT_INVALID", "The Lumin artifact request is invalid.");
    }
    if (failureClass === "state") {
      throw operationError(
        "LUMIN_OPERATION_STATE_INVALID",
        "The retained Lumin operation state is missing or invalid and cannot be reconciled.",
        TERMINAL_STATE_ERROR_DETAILS,
      );
    }
    if (failureClass === "unreconcilable") {
      throw operationError(
        "LUMIN_OPERATION_UNRECONCILABLE",
        "This operation has no verified Lumin request identity and cannot provide signed artifacts.",
        TERMINAL_UNRECONCILABLE_ERROR_DETAILS,
      );
    }
    if (failureClass === "not_retained") {
      throw operationError(
        "LUMIN_OPERATION_OUTCOME_NOT_RETAINED",
        OUTCOME_NOT_RETAINED_MESSAGE,
        OUTCOME_NOT_RETAINED_ERROR_DETAILS,
      );
    }
    throw operationError(
      "LUMIN_ARTIFACT_OBSERVATION_RETRYABLE",
      "The existing Lumin request artifact could not be verified or safely retained. Retrying this read will not create a new signing request.",
      RETRYABLE_READ_ERROR_DETAILS,
    );
  } finally {
    if (timer) clearTimeout(timer);
    accessToken = null;
    accessUrl = null;
  }
}

export async function verifyAndRecordLuminSignV1Webhook(input, options = {}) {
  let secretBytes;
  try {
    const request = assertRecord(input, [
      "authority_sha256",
      "raw_body",
      "signing_secret",
      "state_root",
      "x_signature",
    ]);
    const validatedOptions = assertRecord(options, [], ["nowMs"]);
    const nowMs = validatedOptions.nowMs === undefined ? Date.now() : validatedOptions.nowMs;
    isoTimestamp(nowMs);
    if (!Buffer.isBuffer(request.raw_body) || request.raw_body.length < 2 || request.raw_body.length > MAX_WEBHOOK_BYTES) {
      throw new Error("invalid webhook bytes");
    }
    if (!Buffer.isBuffer(request.signing_secret) || request.signing_secret.length < 16 || request.signing_secret.length > 8192) {
      throw new Error("invalid webhook secret");
    }
    const suppliedSignature = Buffer.from(assertSha256(request.x_signature), "hex");
    secretBytes = Buffer.from(request.signing_secret);
    const expectedSignature = createHmac("sha256", secretBytes).update(request.raw_body).digest();
    if (!timingSafeEqual(expectedSignature, suppliedSignature)) throw new Error("webhook signature mismatch");
    const loaded = await loadOperation(request.state_root, request.authority_sha256);
    if (loaded.outcome?.operation_status !== "request_created") throw new Error("operation is not webhook-reconcilable");
    const transportReceipt = validateTransportReceipt(loaded.outcome.transport_receipt, loaded.claim);
    const parsed = parseStrictJson(request.raw_body, "Lumin webhook");
    const envelope = assertRecord(parsed, ["event", "signature_request"]);
    const event = assertRecord(envelope.event, ["event_time", "event_type"], ["event_metadata"]);
    const signatureRequest = assertJsonRecord(envelope.signature_request);
    if (!Number.isSafeInteger(event.event_time) || event.event_time < 0 || !WEBHOOK_EVENT_TYPES.has(event.event_type)) {
      throw new Error("invalid webhook event");
    }
    const signatureRequestId = assertString(signatureRequest.signature_request_id, {
      max: 256,
      pattern: IDENTIFIER_PATTERN,
    });
    if (signatureRequestId !== transportReceipt.response.signature_request_id) {
      throw new Error("webhook request binding mismatch");
    }
    const status = signatureRequest.status === undefined ? null : signatureRequest.status;
    if (status !== null && !STATUS_VALUES.has(status)) throw new Error("invalid webhook status");
    const rawBodySha256 = sha256(request.raw_body);
    const idempotencySha256 = lifecycleDigest("pdf-tools.lumin-sign-v1-webhook-idempotency.v1", {
      signature_request_id: signatureRequestId,
      event_type: event.event_type,
    });
    const unsigned = {
      schema_version: 1,
      provider: "lumin_sign",
      observation_source: "verified_app_webhook",
      authority_sha256: loaded.claim.authority_sha256,
      claim_sha256: loaded.claim.claim_sha256,
      outcome_sha256: loaded.outcome.outcome_sha256,
      signature_request_id: signatureRequestId,
      event_type: event.event_type,
      event_time: event.event_time,
      status,
      received_at: isoTimestamp(nowMs),
      raw_body_sha256: rawBodySha256,
      signature_sha256: sha256(suppliedSignature),
      idempotency_sha256: idempotencySha256,
      signature_verification: "hmac_sha256_raw_body_constant_time",
      signing_secret_persisted: false,
      raw_body_persisted: false,
    };
    const observation = deepFreeze(isolateOutput({
      ...unsigned,
      observation_sha256: lifecycleDigest("pdf-tools.lumin-sign-v1-webhook-observation.v1", unsigned),
    }));
    const observationsPath = path.join(loaded.operationPath, OBSERVATIONS_DIRECTORY);
    await ensurePrivateDirectory(observationsPath, { create: true });
    const filePath = path.join(observationsPath, `webhook-${idempotencySha256}.v1.json`);
    try {
      await commitExclusiveJson(
        filePath,
        observation,
        path.join(path.dirname(loaded.operationPath), STAGING_DIRECTORY),
      );
    } catch (error) {
      if (error?.code !== "EEXIST") throw error;
      const existing = await readPrivateJson(filePath);
      if (
        existing.value?.raw_body_sha256 !== rawBodySha256
        || existing.value?.signature_request_id !== signatureRequestId
        || existing.value?.event_type !== event.event_type
        || existing.value?.idempotency_sha256 !== idempotencySha256
      ) {
        throw new Error("conflicting webhook delivery");
      }
      return deepFreeze(isolateOutput(existing.value));
    }
    return observation;
  } catch {
    throw operationError(
      "LUMIN_WEBHOOK_REJECTED",
      "The Lumin webhook was not authenticated, bound, or durably retained.",
    );
  } finally {
    secretBytes?.fill(0);
    secretBytes = null;
  }
}
