import { createHash } from "node:crypto";
import { types as utilTypes } from "node:util";
import { LUMIN_CLIENT_USER_AGENT } from "./lumin-client-identity.js";
import {
  LUMIN_SIGN_V1_DIRECT_UPLOAD_REFERENCE,
  LUMIN_SIGN_V1_MAPPER_CONTRACT_SHA256,
  mapLuminSignV1SignatureRequest,
} from "./lumin-sign-v1-mapper.js";

const MAX_PREPARED_PDF_BYTES = 200 * 1024 * 1024;
const MAX_PROVIDER_RESPONSE_BYTES = 256 * 1024;
const MAX_PARTICIPANTS = 100;
const MAX_AUTHORITY_LIFETIME_MS = 10 * 60 * 1000;
const DEFAULT_TIMEOUT_MS = 60_000;
const SHA256_PATTERN = /^[a-f0-9]{64}$/;
const TOKEN_PATTERN = /^[A-Za-z0-9._~+\/-]+={0,2}$/;
const IDENTIFIER_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/;
const STATUS_PATTERN = /^[A-Z][A-Z0-9_]{0,127}$/;

export const LUMIN_SIGN_V1_DIRECT_UPLOAD_CONFIRMATION =
  "I authorize PDF Tools to send this prepared PDF to Lumin and email the listed signers.";

export { LUMIN_SIGN_V1_DIRECT_UPLOAD_REFERENCE };

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

function transportError(code, message) {
  const error = new Error(`${code}: ${message}`);
  Object.defineProperty(error, "code", {
    value: code,
    enumerable: true,
    writable: false,
    configurable: false,
  });
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
    Object.defineProperty(normalized, key, {
      value: descriptor.value,
      enumerable: true,
      writable: false,
      configurable: false,
    });
  }
  return Object.freeze(normalized);
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
  return Object.freeze(normalized);
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
  const timestamp = assertString(value, { max: 32 });
  const parsed = new Date(timestamp);
  if (Number.isNaN(parsed.getTime()) || parsed.toISOString() !== timestamp) {
    throw new Error("invalid timestamp");
  }
  return parsed.getTime();
}

function validateDurableClaimAcknowledgement(value, requestIdentity, nowMs) {
  const acknowledgement = assertRecord(value, [
    "schema_version",
    "provider",
    "action",
    "commit_status",
    "authority_sha256",
    "preparation_receipt_sha256",
    "mapper_contract_sha256",
    "request_mapping_sha256",
    "prepared_document_sha256",
    "prepared_document_size_bytes",
    "participant_ids",
    "claim_started_at",
    "claim_sha256",
    "claim_file_sha256",
    "claim_file_size_bytes",
    "acknowledgement_sha256",
  ]);
  const participantIds = assertDenseArray(acknowledgement.participant_ids, {
    min: 1,
    max: MAX_PARTICIPANTS,
  });
  if (
    acknowledgement.schema_version !== 1
    || acknowledgement.provider !== "lumin_sign"
    || acknowledgement.action !== "create_signature_request"
    || acknowledgement.commit_status !== "durable_claim_committed"
    || acknowledgement.authority_sha256 !== requestIdentity.authority_sha256
    || acknowledgement.preparation_receipt_sha256 !== requestIdentity.preparation_receipt_sha256
    || acknowledgement.mapper_contract_sha256 !== requestIdentity.mapper_contract_sha256
    || acknowledgement.request_mapping_sha256 !== requestIdentity.request_mapping_sha256
    || acknowledgement.prepared_document_sha256 !== requestIdentity.prepared_document_sha256
    || acknowledgement.prepared_document_size_bytes !== requestIdentity.prepared_document_size_bytes
    || participantIds.length !== requestIdentity.participant_ids.length
    || participantIds.some((participantId, index) => participantId !== requestIdentity.participant_ids[index])
  ) {
    throw new Error("durable claim acknowledgement binding mismatch");
  }
  const startedAt = assertIsoTimestamp(acknowledgement.claim_started_at);
  if (!Number.isSafeInteger(startedAt) || startedAt !== nowMs) {
    throw new Error("invalid durable claim timestamp");
  }
  const claimUnsigned = {
    schema_version: 1,
    provider: "lumin_sign",
    action: "create_signature_request",
    operation_status: "authority_consumed",
    automatic_retry_allowed: false,
    authority_sha256: requestIdentity.authority_sha256,
    preparation_receipt_sha256: requestIdentity.preparation_receipt_sha256,
    mapper_contract_sha256: requestIdentity.mapper_contract_sha256,
    request_mapping_sha256: requestIdentity.request_mapping_sha256,
    prepared_document_sha256: requestIdentity.prepared_document_sha256,
    prepared_document_size_bytes: requestIdentity.prepared_document_size_bytes,
    participant_ids: [...participantIds],
    started_at: acknowledgement.claim_started_at,
  };
  const expectedClaimSha256 = sha256(Buffer.from(
    `pdf-tools.lumin-sign-v1-operation-claim.v1\0${canonicalJson(claimUnsigned)}`,
    "utf8",
  ));
  if (assertSha256(acknowledgement.claim_sha256) !== expectedClaimSha256) {
    throw new Error("durable claim acknowledgement digest mismatch");
  }
  const claim = { ...claimUnsigned, claim_sha256: expectedClaimSha256 };
  const claimBytes = Buffer.from(`${canonicalJson(claim)}\n`, "utf8");
  if (
    acknowledgement.claim_file_size_bytes !== claimBytes.length
    || assertSha256(acknowledgement.claim_file_sha256) !== sha256(claimBytes)
  ) {
    throw new Error("durable claim file acknowledgement mismatch");
  }
  const unsigned = { ...acknowledgement };
  delete unsigned.acknowledgement_sha256;
  const expectedAcknowledgementSha256 = sha256(Buffer.from(
    `pdf-tools.lumin-sign-v1-durable-claim-acknowledgement.v1\0${canonicalJson(unsigned)}`,
    "utf8",
  ));
  if (assertSha256(acknowledgement.acknowledgement_sha256) !== expectedAcknowledgementSha256) {
    throw new Error("durable claim acknowledgement identity mismatch");
  }
  return acknowledgement;
}

function isolateOutput(value) {
  if (Array.isArray(value)) {
    const normalized = new Array(value.length);
    Object.setPrototypeOf(normalized, null);
    for (let index = 0; index < value.length; index += 1) {
      Object.defineProperty(normalized, String(index), {
        value: isolateOutput(value[index]),
        enumerable: true,
        writable: true,
        configurable: true,
      });
    }
    return normalized;
  }
  if (!value || typeof value !== "object") return value;
  const normalized = Object.create(null);
  for (const key of Object.keys(value)) {
    Object.defineProperty(normalized, key, {
      value: isolateOutput(value[key]),
      enumerable: true,
      writable: true,
      configurable: true,
    });
  }
  return normalized;
}

function deepFreeze(value) {
  if (!value || typeof value !== "object" || Object.isFrozen(value)) return value;
  for (const key of Reflect.ownKeys(value)) deepFreeze(value[key]);
  return Object.freeze(value);
}

function validatePreparationReceipt(value) {
  const receipt = assertRecord(value, [
    "schema_version",
    "preparation_engine",
    "source_document",
    "prepared_document",
    "source_preservation",
    "output_commit",
    "page_count",
    "geometry_policy",
    "pages",
    "field_outcomes",
    "zones",
    "existing_signature_observation",
    "xfa_observation",
    "handoff_status",
    "missing_inputs",
    "limitations",
    "provider_execution_status",
    "receipt_sha256",
  ]);
  if (
    receipt.schema_version !== "1.0"
    || receipt.preparation_engine !== "pdf-tools.prepare-signing-packet.v1"
    || receipt.handoff_status !== "ready_for_provider_mapping"
    || receipt.provider_execution_status !== "not_requested"
  ) {
    throw new Error("invalid preparation state");
  }
  if (!Number.isSafeInteger(receipt.page_count) || receipt.page_count < 1) {
    throw new Error("invalid page count");
  }
  const pages = assertDenseArray(receipt.pages, { min: receipt.page_count, max: receipt.page_count });
  const missingInputs = assertDenseArray(receipt.missing_inputs, { max: 0 });
  if (pages.length !== receipt.page_count || missingInputs.length !== 0) {
    throw new Error("incomplete preparation");
  }
  const preparedDocument = assertRecord(receipt.prepared_document, [
    "canonical_path",
    "size_bytes",
    "sha256",
    "identity_method",
  ]);
  assertString(preparedDocument.canonical_path, { max: 32_768 });
  assertSha256(preparedDocument.sha256);
  if (
    !Number.isSafeInteger(preparedDocument.size_bytes)
    || preparedDocument.size_bytes < 1
    || preparedDocument.size_bytes > MAX_PREPARED_PDF_BYTES
    || preparedDocument.identity_method !== "race_aware_descriptor_sha256"
  ) {
    throw new Error("invalid prepared document");
  }
  const outputCommit = assertRecord(receipt.output_commit, [
    "status",
    "protocol",
    "target_mode",
    "source_binding_verified_at_commit",
    "prepared_identity_verified_after_commit",
    "replacement_identity_supplied",
  ]);
  if (
    outputCommit.status !== "committed"
    || outputCommit.protocol !== "pdf-tools.atomic-output-transaction.v1"
    || outputCommit.source_binding_verified_at_commit !== true
    || outputCommit.prepared_identity_verified_after_commit !== true
  ) {
    throw new Error("uncommitted preparation");
  }
  const zones = assertDenseArray(receipt.zones, { min: 1, max: MAX_PARTICIPANTS * 10 });
  const signerParticipantIds = [];
  for (const rawZone of zones) {
    const zone = assertRecord(rawZone, [
      "zone_id",
      "label",
      "field_type",
      "page",
      "native_region",
      "display_region",
      "visibility_status",
      "coordinate_space_version",
      "evidence_source",
      "evidence_binding_status",
      "participant_binding",
    ]);
    if (zone.field_type === "unspecified" || zone.visibility_status !== "visible") {
      throw new Error("invalid provider zone");
    }
    const binding = assertRecord(zone.participant_binding, [
      "status",
      "participant_id",
      "participant_role",
    ]);
    if (
      binding.status !== "bound"
      || binding.participant_role !== "signer"
      || !IDENTIFIER_PATTERN.test(binding.participant_id)
    ) {
      throw new Error("invalid signer binding");
    }
    signerParticipantIds.push(binding.participant_id);
  }
  const receiptSha256 = assertSha256(receipt.receipt_sha256);
  const unsigned = Object.create(null);
  for (const key of Object.keys(receipt)) {
    if (key !== "receipt_sha256") unsigned[key] = receipt[key];
  }
  const canonical = canonicalJson(unsigned);
  if (Buffer.byteLength(canonical, "utf8") > 4 * 1024 * 1024) throw new Error("oversized receipt");
  const expected = sha256(Buffer.from(`pdf-tools.signing-preparation-receipt.v1\0${canonical}`, "utf8"));
  if (receiptSha256 !== expected) throw new Error("preparation digest mismatch");
  return Object.freeze({
    receiptSha256,
    preparedDocument,
    signerParticipantIds: Object.freeze([...new Set(signerParticipantIds)].sort()),
  });
}

function validateDirectUploadMapping(value, nowMs) {
  const mapping = assertRecord(value, [
    "schema_version",
    "provider",
    "provider_api_path_version",
    "mapper_contract_sha256",
    "request_mapping_status",
    "official_reference_identity_status",
    "official_reference",
    "transport_allowed",
    "transport_status",
    "provider_execution_status",
    "field_mapping_status",
    "idempotency_status",
    "automatic_retry_allowed",
    "request",
    "bindings",
    "limitations",
  ]);
  if (
    mapping.schema_version !== 1
    || mapping.provider !== "lumin_sign"
    || mapping.provider_api_path_version !== "v1"
    || mapping.request_mapping_status !== "provisional_unverified"
    || mapping.transport_allowed !== false
    || mapping.transport_status !== "not_requested"
    || mapping.provider_execution_status !== "not_requested"
    || mapping.automatic_retry_allowed !== false
  ) {
    throw new Error("invalid mapping state");
  }
  const mapperContractSha256 = assertSha256(mapping.mapper_contract_sha256);
  if (mapperContractSha256 !== LUMIN_SIGN_V1_MAPPER_CONTRACT_SHA256) {
    throw new Error("mapper contract mismatch");
  }
  const request = assertRecord(mapping.request, [
    "base_url",
    "method",
    "path",
    "content_type",
    "file_transfer",
    "authentication_alternatives",
    "body",
  ]);
  if (
    request.base_url !== "https://api.luminpdf.com/v1"
    || request.method !== "POST"
    || request.path !== "/signature_request/send"
    || request.content_type !== "multipart/form-data"
  ) {
    throw new Error("invalid request target");
  }
  const fileTransfer = assertRecord(request.file_transfer, [
    "kind",
    "form_field",
    "filename",
    "media_type",
  ]);
  if (
    fileTransfer.kind !== "direct_file"
    || fileTransfer.form_field !== "file"
    || fileTransfer.filename !== "prepared-document.pdf"
    || fileTransfer.media_type !== "application/pdf"
  ) {
    throw new Error("invalid file transfer");
  }
  const body = assertRecord(request.body, [
    "title",
    "signers",
    "expires_at",
    "use_text_tags",
    "signing_type",
  ], ["viewers"]);
  if (body.use_text_tags !== true || body.signing_type !== "SAME_TIME") {
    throw new Error("unsupported signing mode");
  }
  const signers = assertDenseArray(body.signers, { min: 1, max: MAX_PARTICIPANTS });
  const viewers = body.viewers === undefined
    ? Object.freeze([])
    : assertDenseArray(body.viewers, { max: MAX_PARTICIPANTS });
  if (signers.length + viewers.length > MAX_PARTICIPANTS) throw new Error("too many participants");
  const bindings = assertRecord(mapping.bindings, [
    "prepared_document_sha256",
    "prepared_document_size_bytes",
    "signer_participant_ids",
    "viewer_participant_ids",
    "participant_ids",
  ]);
  const signerParticipantIds = assertDenseArray(bindings.signer_participant_ids, {
    min: signers.length,
    max: signers.length,
  });
  const viewerParticipantIds = assertDenseArray(bindings.viewer_participant_ids, {
    min: viewers.length,
    max: viewers.length,
  });
  const participantIds = assertDenseArray(bindings.participant_ids, {
    min: signers.length + viewers.length,
    max: signers.length + viewers.length,
  });
  const joined = [...signerParticipantIds, ...viewerParticipantIds];
  if (
    joined.some((participantId, index) => participantId !== participantIds[index])
    || new Set(participantIds).size !== participantIds.length
    || participantIds.some(participantId => !IDENTIFIER_PATTERN.test(participantId))
  ) {
    throw new Error("invalid participant bindings");
  }
  if (
    !Number.isSafeInteger(bindings.prepared_document_size_bytes)
    || bindings.prepared_document_size_bytes < 1
    || bindings.prepared_document_size_bytes > MAX_PREPARED_PDF_BYTES
  ) {
    throw new Error("invalid prepared document size");
  }
  const signerValues = signers.map((person, index) => {
    const record = assertRecord(person, ["email_address", "name"]);
    return {
      participant_id: signerParticipantIds[index],
      email_address: assertString(record.email_address, { max: 320 }),
      name: assertString(record.name, { max: 255 }),
    };
  });
  const viewerValues = viewers.map((person, index) => {
    const record = assertRecord(person, ["email_address", "name"]);
    return {
      participant_id: viewerParticipantIds[index],
      email_address: assertString(record.email_address, { max: 320 }),
      name: assertString(record.name, { max: 255 }),
    };
  });
  const replayed = mapLuminSignV1SignatureRequest({
    schema_version: 1,
    prepared_document: {
      sha256: bindings.prepared_document_sha256,
      size_bytes: bindings.prepared_document_size_bytes,
      transfer: { kind: "direct_file" },
    },
    field_mapping: {
      method: "lumin_text_tags",
      evidence_status: "caller_asserted",
    },
    title: body.title,
    expires_at_ms: body.expires_at,
    signing_type: body.signing_type,
    signers: signerValues,
    ...(viewerValues.length ? { viewers: viewerValues } : {}),
  }, { nowMs });
  if (canonicalJson(replayed) !== canonicalJson(mapping)) {
    throw new Error("mapping replay mismatch");
  }
  const requestMappingSha256 = sha256(Buffer.from(
    `pdf-tools.lumin-sign-v1-request-mapping.v1\0${canonicalJson(replayed)}`,
    "utf8",
  ));
  return Object.freeze({
    mapping: replayed,
    mapperContractSha256,
    request: replayed.request,
    body: replayed.request.body,
    signers: signerValues,
    viewers: viewerValues,
    signerParticipantIds,
    participantIds,
    requestMappingSha256,
    preparedDocumentSha256: assertSha256(bindings.prepared_document_sha256),
    preparedDocumentSizeBytes: bindings.prepared_document_size_bytes,
  });
}

function validateExecutionAuthority(value, validated, nowMs) {
  const authority = assertRecord(value, [
    "schema_version",
    "provider",
    "action",
    "transport",
    "confirmation",
    "approved_at",
    "expires_at",
    "preparation_receipt_sha256",
    "mapper_contract_sha256",
    "request_mapping_sha256",
    "prepared_document_sha256",
    "participant_ids",
    "automatic_retry_allowed",
  ]);
  if (
    authority.schema_version !== 1
    || authority.provider !== "lumin_sign"
    || authority.action !== "create_signature_request"
    || authority.transport !== "direct_pdf_multipart"
    || authority.confirmation !== LUMIN_SIGN_V1_DIRECT_UPLOAD_CONFIRMATION
    || authority.automatic_retry_allowed !== false
  ) {
    throw new Error("invalid execution authority");
  }
  const approvedAt = assertIsoTimestamp(authority.approved_at);
  const expiresAt = assertIsoTimestamp(authority.expires_at);
  if (
    approvedAt > nowMs
    || expiresAt <= nowMs
    || expiresAt <= approvedAt
    || expiresAt - approvedAt > MAX_AUTHORITY_LIFETIME_MS
  ) {
    throw new Error("invalid authority chronology");
  }
  const participantIds = assertDenseArray(authority.participant_ids, {
    min: validated.mapping.participantIds.length,
    max: validated.mapping.participantIds.length,
  });
  if (
    authority.preparation_receipt_sha256 !== validated.preparation.receiptSha256
    || authority.mapper_contract_sha256 !== validated.mapping.mapperContractSha256
    || authority.request_mapping_sha256 !== validated.mapping.requestMappingSha256
    || authority.prepared_document_sha256 !== validated.mapping.preparedDocumentSha256
    || participantIds.some((participantId, index) => participantId !== validated.mapping.participantIds[index])
  ) {
    throw new Error("authority binding mismatch");
  }
  return Object.freeze({
    authority,
    authoritySha256: sha256(Buffer.from(
      `pdf-tools.lumin-sign-v1-execution-authority.v1\0${canonicalJson(authority)}`,
      "utf8",
    )),
  });
}

async function readBoundedJsonResponse(response) {
  const contentType = response.headers?.get?.("content-type")?.split(";", 1)[0]?.trim()?.toLowerCase();
  if (contentType !== "application/json") throw new Error("invalid response media type");
  const declaredLength = response.headers.get("content-length");
  if (declaredLength !== null) {
    if (!/^\d+$/.test(declaredLength) || Number(declaredLength) > MAX_PROVIDER_RESPONSE_BYTES) {
      throw new Error("invalid response length");
    }
  }
  const reader = response.body?.getReader?.();
  if (!reader) throw new Error("invalid response body");
  const chunks = [];
  let total = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    if (!(value instanceof Uint8Array)) throw new Error("invalid response chunk");
    total += value.byteLength;
    if (total > MAX_PROVIDER_RESPONSE_BYTES) {
      await reader.cancel().catch(() => {});
      throw new Error("provider response too large");
    }
    chunks.push(Buffer.from(value));
  }
  const bytes = Buffer.concat(chunks, total);
  let parsed;
  try {
    parsed = JSON.parse(bytes.toString("utf8"));
  } catch {
    throw new Error("invalid provider JSON");
  }
  return { bytes, parsed };
}

function validateCreateResponse(value) {
  const envelope = assertRecord(value, ["signature_request"]);
  const request = assertRecord(envelope.signature_request, [
    "signature_request_id",
    "status",
    "created_at",
  ]);
  const signatureRequestId = assertString(request.signature_request_id, {
    max: 256,
    pattern: IDENTIFIER_PATTERN,
  });
  const status = assertString(request.status, { max: 128, pattern: STATUS_PATTERN });
  if (!Number.isSafeInteger(request.created_at) || request.created_at < 0) {
    throw new Error("invalid provider timestamp");
  }
  return Object.freeze({ signatureRequestId, status, createdAt: request.created_at });
}

function appendPerson(form, prefix, person) {
  form.append(`${prefix}[email_address]`, person.email_address);
  form.append(`${prefix}[name]`, person.name);
}

function validateDirectUploadPreparation({
  mapping,
  preparationReceipt,
  preparedPdfBytes,
  nowMs,
}) {
  if (!Buffer.isBuffer(preparedPdfBytes)) throw new Error("invalid PDF bytes");
  const isolatedPdfBytes = Buffer.from(preparedPdfBytes);
  if (
    isolatedPdfBytes.length < 5
    || isolatedPdfBytes.length > MAX_PREPARED_PDF_BYTES
    || isolatedPdfBytes.subarray(0, 5).toString("ascii") !== "%PDF-"
  ) {
    throw new Error("invalid PDF bytes");
  }
  const preparation = validatePreparationReceipt(preparationReceipt);
  const validatedMapping = validateDirectUploadMapping(mapping, nowMs);
  if (
    preparation.preparedDocument.sha256 !== validatedMapping.preparedDocumentSha256
    || preparation.preparedDocument.size_bytes !== validatedMapping.preparedDocumentSizeBytes
    || isolatedPdfBytes.length !== validatedMapping.preparedDocumentSizeBytes
    || sha256(isolatedPdfBytes) !== validatedMapping.preparedDocumentSha256
  ) {
    throw new Error("prepared document binding mismatch");
  }
  const mappedSignerIds = [...validatedMapping.signerParticipantIds].sort();
  if (
    mappedSignerIds.length !== preparation.signerParticipantIds.length
    || mappedSignerIds.some((participantId, index) => participantId !== preparation.signerParticipantIds[index])
  ) {
    throw new Error("signer zone binding mismatch");
  }
  return Object.freeze({
    preparation,
    mapping: validatedMapping,
    preparedPdfBytes: isolatedPdfBytes,
  });
}

export function validateLuminSignV1DirectUploadPreparation(input, options = {}) {
  try {
    const value = assertRecord(input, [
      "mapping",
      "preparation_receipt",
      "prepared_pdf_bytes",
    ]);
    const validatedOptions = assertRecord(options, [], ["nowMs"]);
    const nowMs = validatedOptions.nowMs === undefined ? Date.now() : validatedOptions.nowMs;
    if (!Number.isSafeInteger(nowMs) || nowMs < 0) throw new Error("invalid clock");
    const validated = validateDirectUploadPreparation({
      mapping: value.mapping,
      preparationReceipt: value.preparation_receipt,
      preparedPdfBytes: value.prepared_pdf_bytes,
      nowMs,
    });
    return deepFreeze(isolateOutput({
      preparation_receipt_sha256: validated.preparation.receiptSha256,
      request_mapping_sha256: validated.mapping.requestMappingSha256,
      prepared_document_sha256: validated.mapping.preparedDocumentSha256,
      signer_participant_ids: [...validated.mapping.signerParticipantIds],
    }));
  } catch {
    throw transportError(
      "LUMIN_TRANSPORT_INPUT_INVALID",
      "The Lumin signing request failed local validation before any provider call.",
    );
  }
}

export async function executeAuthorizedLuminSignV1DirectUpload(input, options = {}) {
  let validated;
  let accessToken;
  let durableClaimAcknowledgement;
  let fetchImpl;
  let beforeRequest;
  let preparedPdfBytes;
  let nowMs;
  let timeoutMs;
  try {
    const execution = assertRecord(input, [
      "access_token",
      "execution_authority",
      "mapping",
      "preparation_receipt",
      "prepared_pdf_bytes",
    ]);
    const validatedOptions = assertRecord(options, ["fetchImpl"], ["beforeRequest", "nowMs", "timeoutMs"]);
    fetchImpl = validatedOptions.fetchImpl;
    if (typeof fetchImpl !== "function") throw new Error("missing transport implementation");
    beforeRequest = validatedOptions.beforeRequest;
    if (typeof beforeRequest !== "function") throw new Error("missing pre-request hook");
    nowMs = validatedOptions.nowMs === undefined ? Date.now() : validatedOptions.nowMs;
    timeoutMs = validatedOptions.timeoutMs === undefined ? DEFAULT_TIMEOUT_MS : validatedOptions.timeoutMs;
    if (!Number.isSafeInteger(nowMs) || nowMs < 0) throw new Error("invalid clock");
    if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > DEFAULT_TIMEOUT_MS) {
      throw new Error("invalid timeout");
    }
    accessToken = assertString(execution.access_token, { max: 8192, pattern: TOKEN_PATTERN });
    const preparationValidation = validateDirectUploadPreparation({
      mapping: execution.mapping,
      preparationReceipt: execution.preparation_receipt,
      preparedPdfBytes: execution.prepared_pdf_bytes,
      nowMs,
    });
    preparedPdfBytes = preparationValidation.preparedPdfBytes;
    validated = {
      preparation: preparationValidation.preparation,
      mapping: preparationValidation.mapping,
    };
    validated.authority = validateExecutionAuthority(
      execution.execution_authority,
      validated,
      nowMs,
    );
  } catch {
    throw transportError(
      "LUMIN_TRANSPORT_INPUT_INVALID",
      "The Lumin signing request failed local validation before any provider call.",
    );
  }

  const form = new FormData();
  form.append(
    validated.mapping.request.file_transfer.form_field,
    new Blob([preparedPdfBytes], { type: "application/pdf" }),
    validated.mapping.request.file_transfer.filename,
  );
  form.append("title", validated.mapping.body.title);
  form.append("expires_at", String(validated.mapping.body.expires_at));
  validated.mapping.signers.forEach((person, index) => appendPerson(form, `signers[${index}]`, person));
  validated.mapping.viewers.forEach((person, index) => appendPerson(form, `viewers[${index}]`, person));
  form.append("use_text_tags", "true");
  form.append("signing_type", "SAME_TIME");

  const requestIdentity = deepFreeze(isolateOutput({
      schema_version: 1,
      provider: "lumin_sign",
      action: "create_signature_request",
      authority_sha256: validated.authority.authoritySha256,
      preparation_receipt_sha256: validated.preparation.receiptSha256,
      mapper_contract_sha256: validated.mapping.mapperContractSha256,
      request_mapping_sha256: validated.mapping.requestMappingSha256,
      prepared_document_sha256: validated.mapping.preparedDocumentSha256,
      prepared_document_size_bytes: validated.mapping.preparedDocumentSizeBytes,
      participant_ids: [...validated.mapping.participantIds],
  }));
  try {
    const acknowledgement = await beforeRequest(requestIdentity);
    durableClaimAcknowledgement = validateDurableClaimAcknowledgement(
      acknowledgement,
      requestIdentity,
      nowMs,
    );
  } catch {
    throw transportError(
      "LUMIN_OPERATION_STATE_REJECTED",
      "The durable operation claim could not be committed before any provider call.",
    );
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    let response;
    try {
      response = await fetchImpl("https://api.luminpdf.com/v1/signature_request/send", {
        method: "POST",
        headers: {
          accept: "application/json",
          authorization: `Bearer ${accessToken}`,
          "user-agent": LUMIN_CLIENT_USER_AGENT,
        },
        body: form,
        redirect: "error",
        signal: controller.signal,
      });
    } catch {
      throw transportError(
        "LUMIN_CREATE_OUTCOME_UNKNOWN",
        "The Lumin request outcome is unknown. It was not retried automatically.",
      );
    }

    if (response.status !== 201) {
      await response.body?.cancel?.().catch(() => {});
      throw transportError(
        "LUMIN_CREATE_REJECTED",
        "Lumin did not accept the signing request. It was not retried automatically.",
      );
    }

    let responseBytes;
    let responseValue;
    try {
      const bounded = await readBoundedJsonResponse(response);
      responseBytes = bounded.bytes;
      responseValue = bounded.parsed;
    } catch {
      throw transportError(
        "LUMIN_CREATE_OUTCOME_UNKNOWN",
        "Lumin may have created the signing request, but its response could not be verified. It was not retried automatically.",
      );
    }

    let created;
    try {
      created = validateCreateResponse(responseValue);
    } catch {
      throw transportError(
        "LUMIN_CREATE_OUTCOME_UNKNOWN",
        "Lumin may have created the signing request, but its response could not be verified. It was not retried automatically.",
      );
    }
    const receipt = isolateOutput({
      schema_version: 1,
      provider: "lumin_sign",
      action: "create_signature_request",
      provider_execution_status: "request_created",
      attempt_count: 1,
      automatic_retry_performed: false,
      request: {
        method: "POST",
        url: "https://api.luminpdf.com/v1/signature_request/send",
        content_type: "multipart/form-data",
        preparation_receipt_sha256: validated.preparation.receiptSha256,
        prepared_document_sha256: validated.mapping.preparedDocumentSha256,
        prepared_document_size_bytes: validated.mapping.preparedDocumentSizeBytes,
        mapper_contract_sha256: validated.mapping.mapperContractSha256,
        request_mapping_sha256: validated.mapping.requestMappingSha256,
        direct_upload_reference: LUMIN_SIGN_V1_DIRECT_UPLOAD_REFERENCE,
        execution_authority_sha256: validated.authority.authoritySha256,
        durable_claim_sha256: durableClaimAcknowledgement.claim_sha256,
        durable_claim_acknowledgement_sha256: durableClaimAcknowledgement.acknowledgement_sha256,
        participant_ids: [...validated.mapping.participantIds],
      },
      response: {
        status_code: 201,
        body_sha256: sha256(responseBytes),
        signature_request_id: created.signatureRequestId,
        status: created.status,
        created_at: created.createdAt,
      },
    });
    const transportReceiptSha256 = sha256(Buffer.from(
      `pdf-tools.lumin-sign-v1-transport-receipt.v1\0${canonicalJson(receipt)}`,
      "utf8",
    ));
    return deepFreeze(isolateOutput({
      ...receipt,
      transport_receipt_sha256: transportReceiptSha256,
    }));
  } finally {
    clearTimeout(timer);
    accessToken = null;
  }
}
