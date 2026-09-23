import { createHash, createHmac } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { LUMIN_CLIENT_USER_AGENT } from "../server/lumin-client-identity.js";
import {
  LUMIN_SIGN_V1_MAPPER_CONTRACT_SHA256,
  mapLuminSignV1SignatureRequest,
} from "../server/lumin-sign-v1-mapper.js";
import {
  executeAuthorizedLuminSignV1DirectUpload,
  LUMIN_SIGN_V1_DIRECT_UPLOAD_CONFIRMATION,
  LUMIN_SIGN_V1_DIRECT_UPLOAD_REFERENCE,
} from "../server/lumin-sign-v1-transport.js";
import {
  executeDurableLuminSignV1DirectUpload,
  inspectLuminSignV1Operation,
  LUMIN_SIGN_V1_OPERATION_REFERENCES,
  pollAndRecordLuminSignV1Status,
  requestAndRecordLuminSignV1ArtifactAccess,
  verifyAndRecordLuminSignV1Webhook,
} from "../server/lumin-sign-v1-operation.js";

const NOW_MS = Date.parse("2030-01-01T00:00:30.000Z");
const PDF_BYTES = Buffer.from("%PDF-1.7\n%%EOF\n", "ascii");
const PDF_SHA256 = createHash("sha256").update(PDF_BYTES).digest("hex");
const ACCESS_TOKEN = "test-access-token-never-returned";

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

function preparationReceipt() {
  const receipt = {
    schema_version: "1.0",
    preparation_engine: "pdf-tools.prepare-signing-packet.v1",
    source_document: {
      canonical_path: "/synthetic/source.pdf",
      size_bytes: PDF_BYTES.length,
      sha256: PDF_SHA256,
      identity_method: "race_aware_descriptor_sha256",
    },
    prepared_document: {
      canonical_path: "/synthetic/prepared.pdf",
      size_bytes: PDF_BYTES.length,
      sha256: PDF_SHA256,
      identity_method: "race_aware_descriptor_sha256",
    },
    source_preservation: {
      mode: "source_path_unchanged",
      source_path_reverified_after_commit: true,
      backup_identity_verified_after_commit: false,
      backup_path: null,
      backup_document: null,
    },
    output_commit: {
      status: "committed",
      protocol: "pdf-tools.atomic-output-transaction.v1",
      target_mode: "new_path",
      source_binding_verified_at_commit: true,
      prepared_identity_verified_after_commit: true,
      replacement_identity_supplied: false,
    },
    page_count: 1,
    geometry_policy: {
      native_coordinate_space: "pdf-tools.media-box-top-left-points.v1",
      display_coordinate_space: "pdf-tools.crop-box-rotated-top-left-points.v1",
      page_box_basis: "MediaBox",
      crop_box_observed: true,
      rotation_policy: "clockwise_quarter_turns",
    },
    pages: [{ page: 1 }],
    field_outcomes: [],
    zones: [{
      zone_id: "signature.client",
      label: "Client signature",
      field_type: "signature",
      page: 1,
      native_region: { x: 10, y: 20, width: 100, height: 30 },
      display_region: { x: 10, y: 20, width: 100, height: 30 },
      visibility_status: "visible",
      coordinate_space_version: "pdf-tools.media-box-top-left-points.v1",
      evidence_source: "caller_supplied",
      evidence_binding_status: "caller_declared",
      participant_binding: {
        status: "bound",
        participant_id: "signer.client",
        participant_role: "signer",
      },
    }],
    existing_signature_observation: {
      present: false,
      field_count: 0,
      field_names: [],
      allow_resign: false,
    },
    xfa_observation: {
      present: false,
      force_xfa: false,
      stripping_authorized: false,
    },
    handoff_status: "ready_for_provider_mapping",
    missing_inputs: [],
    limitations: ["synthetic fixture"],
    provider_execution_status: "not_requested",
  };
  return {
    ...receipt,
    receipt_sha256: createHash("sha256")
      .update(`pdf-tools.signing-preparation-receipt.v1\0${canonicalJson(receipt)}`)
      .digest("hex"),
  };
}

function mapping() {
  return mapLuminSignV1SignatureRequest({
    schema_version: 1,
    prepared_document: {
      sha256: PDF_SHA256,
      size_bytes: PDF_BYTES.length,
      transfer: { kind: "direct_file" },
    },
    field_mapping: {
      method: "lumin_text_tags",
      evidence_status: "caller_asserted",
    },
    title: "Synthetic signing test",
    expires_at_ms: NOW_MS + 86_400_000,
    signing_type: "SAME_TIME",
    signers: [{
      participant_id: "signer.client",
      email_address: "client@example.com",
      name: "Client Signer",
    }],
    viewers: [{
      participant_id: "viewer.audit",
      email_address: "audit@example.com",
      name: "Audit Viewer",
    }],
  }, { nowMs: NOW_MS });
}

function authority(receipt = preparationReceipt(), mapped = mapping()) {
  const participantIds = Array.from(
    { length: mapped.bindings.participant_ids.length },
    (_, index) => mapped.bindings.participant_ids[index],
  );
  return {
    schema_version: 1,
    provider: "lumin_sign",
    action: "create_signature_request",
    transport: "direct_pdf_multipart",
    confirmation: LUMIN_SIGN_V1_DIRECT_UPLOAD_CONFIRMATION,
    approved_at: "2030-01-01T00:00:00.000Z",
    expires_at: "2030-01-01T00:05:00.000Z",
    preparation_receipt_sha256: receipt.receipt_sha256,
    mapper_contract_sha256: LUMIN_SIGN_V1_MAPPER_CONTRACT_SHA256,
    request_mapping_sha256: createHash("sha256")
      .update(`pdf-tools.lumin-sign-v1-request-mapping.v1\0${canonicalJson(mapped)}`)
      .digest("hex"),
    prepared_document_sha256: PDF_SHA256,
    participant_ids: participantIds,
    automatic_retry_allowed: false,
  };
}

function authoritySha256(value) {
  return createHash("sha256")
    .update(`pdf-tools.lumin-sign-v1-execution-authority.v1\0${canonicalJson(value)}`)
    .digest("hex");
}

function input() {
  const receipt = preparationReceipt();
  const mapped = structuredClone(mapping());
  return {
    access_token: ACCESS_TOKEN,
    execution_authority: authority(receipt, mapped),
    mapping: mapped,
    preparation_receipt: receipt,
    prepared_pdf_bytes: Buffer.from(PDF_BYTES),
  };
}

function successResponse(overrides = {}) {
  return new Response(JSON.stringify({
    signature_request: {
      signature_request_id: "sigreq.synthetic-123",
      status: "WAITING_FOR_PROCESSING",
      created_at: 1_893_456_030,
      ...overrides,
    },
  }), {
    status: 201,
    headers: { "content-type": "application/json" },
  });
}

function statusResponse(status = "APPROVED") {
  return new Response(JSON.stringify({
    signature_request: {
      signature_request_id: "sigreq.synthetic-123",
      status,
    },
  }), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

function durableClaimAcknowledgement(requestIdentity, startedAt = new Date(NOW_MS).toISOString()) {
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
    participant_ids: Array.from(requestIdentity.participant_ids),
    started_at: startedAt,
  };
  const claimSha256 = createHash("sha256")
    .update(`pdf-tools.lumin-sign-v1-operation-claim.v1\0${canonicalJson(claimUnsigned)}`)
    .digest("hex");
  const claimBytes = Buffer.from(`${canonicalJson({ ...claimUnsigned, claim_sha256: claimSha256 })}\n`);
  const unsigned = {
    schema_version: 1,
    provider: "lumin_sign",
    action: "create_signature_request",
    commit_status: "durable_claim_committed",
    authority_sha256: requestIdentity.authority_sha256,
    preparation_receipt_sha256: requestIdentity.preparation_receipt_sha256,
    mapper_contract_sha256: requestIdentity.mapper_contract_sha256,
    request_mapping_sha256: requestIdentity.request_mapping_sha256,
    prepared_document_sha256: requestIdentity.prepared_document_sha256,
    prepared_document_size_bytes: requestIdentity.prepared_document_size_bytes,
    participant_ids: Array.from(requestIdentity.participant_ids),
    claim_started_at: startedAt,
    claim_sha256: claimSha256,
    claim_file_sha256: createHash("sha256").update(claimBytes).digest("hex"),
    claim_file_size_bytes: claimBytes.length,
  };
  return {
    ...unsigned,
    acknowledgement_sha256: createHash("sha256")
      .update(`pdf-tools.lumin-sign-v1-durable-claim-acknowledgement.v1\0${canonicalJson(unsigned)}`)
      .digest("hex"),
  };
}

async function execute(value, fetchImpl) {
  return executeAuthorizedLuminSignV1DirectUpload(value, {
    beforeRequest: async requestIdentity => durableClaimAcknowledgement(requestIdentity),
    fetchImpl,
    nowMs: NOW_MS,
    timeoutMs: 5_000,
  });
}

describe("executeAuthorizedLuminSignV1DirectUpload", () => {
  it("pins the exact official direct-upload example used by the transport contract", () => {
    expect(LUMIN_SIGN_V1_DIRECT_UPLOAD_REFERENCE).toEqual({
      repository: "https://github.com/luminpdf/lumin-sign-api-docs",
      commit: "cd8ddd73e32c016038691dad21d0e4594c8eeebb",
      path: "src/theme/ApiDemoPanel/signature-request.multipart.js",
      bytes: 7_288,
      sha256: "8b82481c0c06bd560e1e107c08ed90b31640d9bd4cd3941635bbf4d328c814c4",
    });
  });
  it("sends one exact direct-file request and returns a token-free identity receipt", async () => {
    let calls = 0;
    const result = await execute(input(), async (url, options) => {
      calls += 1;
      expect(url).toBe("https://api.luminpdf.com/v1/signature_request/send");
      expect(options).toMatchObject({ method: "POST", redirect: "error" });
      expect(options.headers).toEqual({
        accept: "application/json",
        authorization: `Bearer ${ACCESS_TOKEN}`,
        "user-agent": LUMIN_CLIENT_USER_AGENT,
      });
      expect(options.headers).not.toHaveProperty("content-type");
      expect(options.body).toBeInstanceOf(FormData);
      expect([...options.body.keys()]).toEqual([
        "file",
        "title",
        "expires_at",
        "signers[0][email_address]",
        "signers[0][name]",
        "viewers[0][email_address]",
        "viewers[0][name]",
        "use_text_tags",
        "signing_type",
      ]);
      const file = options.body.get("file");
      expect(file).toBeInstanceOf(Blob);
      expect(file.name).toBe("prepared-document.pdf");
      expect(file.type).toBe("application/pdf");
      expect(Buffer.from(await file.arrayBuffer())).toEqual(PDF_BYTES);
      expect(options.body.get("title")).toBe("Synthetic signing test");
      expect(options.body.get("signers[0][email_address]")).toBe("client@example.com");
      expect(options.body.get("use_text_tags")).toBe("true");
      return successResponse();
    });

    expect(calls).toBe(1);
    expect(result).toMatchObject({
      schema_version: 1,
      provider: "lumin_sign",
      provider_execution_status: "request_created",
      attempt_count: 1,
      automatic_retry_performed: false,
      request: {
        prepared_document_sha256: PDF_SHA256,
        prepared_document_size_bytes: PDF_BYTES.length,
        participant_ids: ["signer.client", "viewer.audit"],
        direct_upload_reference: LUMIN_SIGN_V1_DIRECT_UPLOAD_REFERENCE,
        request_mapping_sha256: createHash("sha256")
          .update(`pdf-tools.lumin-sign-v1-request-mapping.v1\0${canonicalJson(mapping())}`)
          .digest("hex"),
        durable_claim_sha256: expect.stringMatching(/^[a-f0-9]{64}$/),
        durable_claim_acknowledgement_sha256: expect.stringMatching(/^[a-f0-9]{64}$/),
      },
      response: {
        status_code: 201,
        signature_request_id: "sigreq.synthetic-123",
        status: "WAITING_FOR_PROCESSING",
      },
      transport_receipt_sha256: expect.stringMatching(/^[a-f0-9]{64}$/),
    });
    expect(JSON.stringify(result)).not.toContain(ACCESS_TOKEN);
    expect(JSON.stringify(result)).not.toContain("client@example.com");
    expect(Object.isFrozen(result)).toBe(true);
    expect(Object.getPrototypeOf(result)).toBeNull();
  });

  it.each([
    ["prepared bytes", value => { value.prepared_pdf_bytes = Buffer.from("%PDF-drift"); }],
    ["receipt digest", value => { value.preparation_receipt.receipt_sha256 = "f".repeat(64); }],
    ["prepared binding", value => { value.mapping.bindings.prepared_document_sha256 = "f".repeat(64); }],
    ["mapper contract", value => {
      value.mapping.mapper_contract_sha256 = "f".repeat(64);
      value.execution_authority.mapper_contract_sha256 = "f".repeat(64);
    }],
    ["malformed signer", value => { value.mapping.request.body.signers[0].email_address = "not-an-email"; }],
    ["signer binding", value => { value.preparation_receipt.zones[0].participant_binding.participant_id = "signer.other"; }],
    ["authority confirmation", value => { value.execution_authority.confirmation = "yes"; }],
    ["authority participant", value => { value.execution_authority.participant_ids[0] = "signer.other"; }],
    ["authority request mapping", value => { value.mapping.request.body.title = "Unapproved title"; }],
    ["expired authority", value => { value.execution_authority.expires_at = "2030-01-01T00:00:20.000Z"; }],
    ["retry authority", value => { value.execution_authority.automatic_retry_allowed = true; }],
    ["token whitespace", value => { value.access_token = ` ${ACCESS_TOKEN}`; }],
    ["extra key", value => { value.client_secret = "must-not-be-consumed"; }],
  ])("rejects %s before transport", async (_label, mutate) => {
    const value = input();
    mutate(value);
    let calls = 0;
    await expect(execute(value, async () => {
      calls += 1;
      return successResponse();
    })).rejects.toMatchObject({
      code: "LUMIN_TRANSPORT_INPUT_INVALID",
      message: "LUMIN_TRANSPORT_INPUT_INVALID: The Lumin signing request failed local validation before any provider call.",
    });
    expect(calls).toBe(0);
  });

  it("requires an injected transport and never defaults to live fetch", async () => {
    await expect(executeAuthorizedLuminSignV1DirectUpload(input())).rejects.toMatchObject({
      code: "LUMIN_TRANSPORT_INPUT_INVALID",
    });
  });

  it("requires a pre-request persistence hook before any provider entry", async () => {
    let calls = 0;
    await expect(executeAuthorizedLuminSignV1DirectUpload(input(), {
      fetchImpl: async () => {
        calls += 1;
        return successResponse();
      },
    })).rejects.toMatchObject({ code: "LUMIN_TRANSPORT_INPUT_INVALID" });
    expect(calls).toBe(0);
  });

  it("rejects a no-op or drifted durable-claim acknowledgement before provider entry", async () => {
    for (const beforeRequest of [
      async () => undefined,
      async requestIdentity => ({
        ...durableClaimAcknowledgement(requestIdentity),
        claim_file_sha256: "f".repeat(64),
      }),
    ]) {
      let calls = 0;
      await expect(executeAuthorizedLuminSignV1DirectUpload(input(), {
        beforeRequest,
        fetchImpl: async () => {
          calls += 1;
          return successResponse();
        },
        nowMs: NOW_MS,
      })).rejects.toMatchObject({ code: "LUMIN_OPERATION_STATE_REJECTED" });
      expect(calls).toBe(0);
    }
  });

  it("materializes the validated PDF before the asynchronous persistence hook", async () => {
    const value = input();
    const expectedBytes = Buffer.from(value.prepared_pdf_bytes);
    const originalBuffer = value.prepared_pdf_bytes;
    const result = await executeAuthorizedLuminSignV1DirectUpload(value, {
      nowMs: NOW_MS,
      timeoutMs: 5_000,
      beforeRequest: async requestIdentity => {
        originalBuffer.fill(0x58);
        value.prepared_pdf_bytes = Buffer.from("%PDF-substituted\n%%EOF\n");
        return durableClaimAcknowledgement(requestIdentity);
      },
      fetchImpl: async (_url, options) => {
        const uploaded = Buffer.from(await options.body.get("file").arrayBuffer());
        expect(uploaded).toEqual(expectedBytes);
        expect(createHash("sha256").update(uploaded).digest("hex")).toBe(PDF_SHA256);
        return successResponse();
      },
    });
    expect(result.request.prepared_document_sha256).toBe(PDF_SHA256);
  });

  it("accepts RFC bearer padding without exposing the access token", async () => {
    const value = input();
    value.access_token = "synthetic-token==";
    const result = await execute(value, async () => successResponse());
    expect(JSON.stringify(result)).not.toContain(value.access_token);
  });

  it("keeps the timeout active while reading the provider response body", async () => {
    let calls = 0;
    await expect(executeAuthorizedLuminSignV1DirectUpload(input(), {
      beforeRequest: async requestIdentity => durableClaimAcknowledgement(requestIdentity),
      nowMs: NOW_MS,
      timeoutMs: 5,
      fetchImpl: async (_url, options) => {
        calls += 1;
        const body = new ReadableStream({
          start(controller) {
            options.signal.addEventListener("abort", () => controller.error(new Error("aborted")));
          },
        });
        return new Response(body, {
          status: 201,
          headers: { "content-type": "application/json" },
        });
      },
    })).rejects.toMatchObject({ code: "LUMIN_CREATE_OUTCOME_UNKNOWN" });
    expect(calls).toBe(1);
  });

  it("preserves an ambiguous one-attempt outcome without retrying or leaking causes", async () => {
    let calls = 0;
    const sentinel = "provider-secret-sentinel";
    await expect(execute(input(), async () => {
      calls += 1;
      throw new Error(sentinel);
    })).rejects.toMatchObject({
      code: "LUMIN_CREATE_OUTCOME_UNKNOWN",
      message: "LUMIN_CREATE_OUTCOME_UNKNOWN: The Lumin request outcome is unknown. It was not retried automatically.",
    });
    expect(calls).toBe(1);
  });

  it.each([
    ["wrong status", () => new Response(JSON.stringify({ error: "no" }), {
      status: 400,
      headers: { "content-type": "application/json" },
    }), "LUMIN_CREATE_REJECTED"],
    ["wrong media", () => new Response("no", {
      status: 201,
      headers: { "content-type": "text/plain" },
    }), "LUMIN_CREATE_OUTCOME_UNKNOWN"],
    ["invalid JSON", () => new Response("{", {
      status: 201,
      headers: { "content-type": "application/json" },
    }), "LUMIN_CREATE_OUTCOME_UNKNOWN"],
    ["extra response key", () => new Response(JSON.stringify({
      signature_request: {
        signature_request_id: "sigreq.synthetic-123",
        status: "WAITING_FOR_PROCESSING",
        created_at: 1_893_456_030,
        access_token: "secret",
      },
    }), {
      status: 201,
      headers: { "content-type": "application/json" },
    }), "LUMIN_CREATE_OUTCOME_UNKNOWN"],
    ["oversized declaration", () => new Response("{}", {
      status: 201,
      headers: {
        "content-type": "application/json",
        "content-length": String(256 * 1024 + 1),
      },
    }), "LUMIN_CREATE_OUTCOME_UNKNOWN"],
  ])("fails closed on %s", async (_label, response, code) => {
    let calls = 0;
    await expect(execute(input(), async () => {
      calls += 1;
      return response();
    })).rejects.toMatchObject({ code });
    expect(calls).toBe(1);
  });

  it("keeps the source and share transport bytes identical", async () => {
    const repoRoot = path.resolve(import.meta.dirname, "..");
    const [source, share, operationSource, operationShare] = await Promise.all([
      fs.readFile(path.join(repoRoot, "server/lumin-sign-v1-transport.js")),
      fs.readFile(path.join(repoRoot, "pdf-toolkit-mcp-share/server/lumin-sign-v1-transport.js")),
      fs.readFile(path.join(repoRoot, "server/lumin-sign-v1-operation.js")),
      fs.readFile(path.join(repoRoot, "pdf-toolkit-mcp-share/server/lumin-sign-v1-operation.js")),
    ]);
    expect(share.equals(source)).toBe(true);
    expect(operationShare.equals(operationSource)).toBe(true);
  });

  it("keeps the provider transport internal and absent from both MCP entry points", async () => {
    const repoRoot = path.resolve(import.meta.dirname, "..");
    const [sourceIndex, shareIndex] = await Promise.all([
      fs.readFile(path.join(repoRoot, "server/index.js"), "utf8"),
      fs.readFile(path.join(repoRoot, "pdf-toolkit-mcp-share/server/index.js"), "utf8"),
    ]);
    expect(sourceIndex).not.toContain("lumin-sign-v1-transport");
    expect(sourceIndex).not.toContain("executeAuthorizedLuminSignV1DirectUpload");
    expect(sourceIndex).not.toContain("lumin-sign-v1-operation");
    expect(sourceIndex).not.toContain("executeDurableLuminSignV1DirectUpload");
    expect(shareIndex).not.toContain("lumin-sign-v1-transport");
    expect(shareIndex).not.toContain("executeAuthorizedLuminSignV1DirectUpload");
    expect(shareIndex).not.toContain("lumin-sign-v1-operation");
    expect(shareIndex).not.toContain("executeDurableLuminSignV1DirectUpload");
  });
});

async function withLifecycleState(operation) {
  const temporaryRoot = await fs.realpath(os.tmpdir());
  const parent = await fs.mkdtemp(path.join(temporaryRoot, "pdf-tools-lumin-operation-"));
  await fs.chmod(parent, 0o700);
  const stateRoot = path.join(parent, "state");
  try {
    return await operation({ parent, stateRoot });
  } finally {
    await fs.rm(parent, { recursive: true, force: true });
  }
}

async function createDurableOperation(stateRoot) {
  const value = input();
  const durable = await executeDurableLuminSignV1DirectUpload(value, {
    stateRoot,
    nowMs: NOW_MS,
    timeoutMs: 5_000,
    fetchImpl: async () => successResponse(),
  });
  return { authoritySha256: authoritySha256(value.execution_authority), durable, value };
}

describe("durable Lumin Sign v1 operation lifecycle", () => {
  it("pins the exact OpenAPI identity and official lifecycle documentation used by the contract", () => {
    expect(LUMIN_SIGN_V1_OPERATION_REFERENCES).toEqual({
      observed_at: "2026-09-04",
      openapi: {
        url: "https://developers.luminpdf.com/tabs/api-reference/openapi.json",
        sha256: "8842b7938870ea05b8c8d5869a33cc16b33b2eb0b8f2b1c60607203e39bfd037",
        status_path: "/signature_request/{signature_request_id}",
        artifact_path: "/signature_request/{signature_request_id}/file",
        status_values: [
          "APPROVED",
          "CANCELLED",
          "FAILED",
          "NEED_TO_SIGN",
          "REJECTED",
          "WAITING_FOR_OTHERS",
          "WAITING_FOR_PROCESSING",
        ],
        artifact_file_types: ["agreement", "coc", "merged"],
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
  });

  it("durably consumes the exact authority before request entry and refuses every reuse", async () => {
    await withLifecycleState(async ({ stateRoot }) => {
      const value = input();
      const authorityDigest = authoritySha256(value.execution_authority);
      let calls = 0;
      const first = await executeDurableLuminSignV1DirectUpload(value, {
        stateRoot,
        nowMs: NOW_MS,
        timeoutMs: 5_000,
        fetchImpl: async () => {
          calls += 1;
          const entered = await inspectLuminSignV1Operation({
            state_root: stateRoot,
            authority_sha256: authorityDigest,
          });
          expect(entered).toMatchObject({
            authority_sha256: authorityDigest,
            operation_status: "authority_consumed",
            outcome_status: "not_retained",
            reconciliation_class: "outcome_not_retained",
            automatic_retry_allowed: false,
            create_retry_allowed: false,
          });
          return successResponse();
        },
      });
      expect(calls).toBe(1);
      expect(first.operation).toMatchObject({
        operation_status: "request_created",
        authority_sha256: authorityDigest,
        attempt_count: 1,
        automatic_retry_performed: false,
      });
      const operationPath = path.join(stateRoot, "lumin-sign-v1-operations", authorityDigest);
      const retainedText = (await Promise.all([
        fs.readFile(path.join(operationPath, "claim.v1.json"), "utf8"),
        fs.readFile(path.join(operationPath, "outcome.v1.json"), "utf8"),
      ])).join("\n");
      expect(retainedText).not.toContain(ACCESS_TOKEN);
      expect(retainedText).not.toContain("client@example.com");
      expect(retainedText).not.toContain("audit@example.com");
      expect((await fs.lstat(stateRoot)).mode & 0o777).toBe(0o700);
      const claimStats = await fs.lstat(path.join(operationPath, "claim.v1.json"));
      const outcomeStats = await fs.lstat(path.join(operationPath, "outcome.v1.json"));
      expect(claimStats.mode & 0o777).toBe(0o600);
      expect(outcomeStats.mode & 0o777).toBe(0o600);
      expect(claimStats.nlink).toBe(1);
      expect(outcomeStats.nlink).toBe(1);
      await expect(fs.readdir(path.join(
        stateRoot,
        "lumin-sign-v1-operations",
        ".staging",
      ))).resolves.toEqual([]);

      await expect(executeDurableLuminSignV1DirectUpload(input(), {
        stateRoot,
        nowMs: NOW_MS,
        timeoutMs: 5_000,
        fetchImpl: async () => {
          calls += 1;
          return successResponse();
        },
      })).rejects.toMatchObject({ code: "LUMIN_OPERATION_ALREADY_CONSUMED" });
      expect(calls).toBe(1);
    });
  });

  it("uses one exact clock observation for the durable claim and transport acknowledgement", async () => {
    await withLifecycleState(async ({ stateRoot }) => {
      const clock = vi.spyOn(Date, "now")
        .mockReturnValueOnce(NOW_MS)
        .mockReturnValueOnce(NOW_MS + 1)
        .mockReturnValue(NOW_MS + 2);
      let calls = 0;
      try {
        await expect(executeDurableLuminSignV1DirectUpload(input(), {
          stateRoot,
          timeoutMs: 5_000,
          fetchImpl: async () => {
            calls += 1;
            return successResponse();
          },
        })).resolves.toMatchObject({
          operation: { operation_status: "request_created" },
        });
      } finally {
        clock.mockRestore();
      }
      expect(calls).toBe(1);
    });
  });

  it("allows exactly one provider entry under concurrent same-authority callers", async () => {
    await withLifecycleState(async ({ stateRoot }) => {
      let calls = 0;
      const invoke = () => executeDurableLuminSignV1DirectUpload(input(), {
        stateRoot,
        nowMs: NOW_MS,
        timeoutMs: 5_000,
        fetchImpl: async () => {
          calls += 1;
          await new Promise(resolve => setTimeout(resolve, 10));
          return successResponse();
        },
      });
      const settled = await Promise.allSettled([invoke(), invoke()]);
      expect(settled.filter(result => result.status === "fulfilled")).toHaveLength(1);
      expect(settled.filter(result => result.status === "rejected")).toHaveLength(1);
      expect(settled.find(result => result.status === "rejected").reason).toMatchObject({
        code: "LUMIN_OPERATION_ALREADY_CONSUMED",
      });
      expect(calls).toBe(1);
    });
  });

  it("retains an unknown create outcome and never turns it into retry authority", async () => {
    await withLifecycleState(async ({ stateRoot }) => {
      const value = input();
      const authorityDigest = authoritySha256(value.execution_authority);
      let calls = 0;
      await expect(executeDurableLuminSignV1DirectUpload(value, {
        stateRoot,
        nowMs: NOW_MS,
        timeoutMs: 5_000,
        fetchImpl: async () => {
          calls += 1;
          throw new Error("private transport cause");
        },
      })).rejects.toMatchObject({ code: "LUMIN_CREATE_OUTCOME_UNKNOWN" });
      expect(calls).toBe(1);
      await expect(inspectLuminSignV1Operation({
        state_root: stateRoot,
        authority_sha256: authorityDigest,
      })).resolves.toMatchObject({
        operation_status: "outcome_unknown",
        automatic_retry_allowed: false,
      });
      await expect(executeDurableLuminSignV1DirectUpload(input(), {
        stateRoot,
        nowMs: NOW_MS,
        fetchImpl: async () => {
          calls += 1;
          return successResponse();
        },
      })).rejects.toMatchObject({ code: "LUMIN_OPERATION_ALREADY_CONSUMED" });
      expect(calls).toBe(1);
    });
  });

  it("retains a definite provider rejection without permitting a second create", async () => {
    await withLifecycleState(async ({ stateRoot }) => {
      const value = input();
      const authorityDigest = authoritySha256(value.execution_authority);
      let calls = 0;
      await expect(executeDurableLuminSignV1DirectUpload(value, {
        stateRoot,
        nowMs: NOW_MS,
        fetchImpl: async () => {
          calls += 1;
          return new Response(JSON.stringify({ error: "synthetic rejection" }), {
            status: 400,
            headers: { "content-type": "application/json" },
          });
        },
      })).rejects.toMatchObject({ code: "LUMIN_CREATE_REJECTED" });
      await expect(inspectLuminSignV1Operation({
        state_root: stateRoot,
        authority_sha256: authorityDigest,
      })).resolves.toMatchObject({ operation_status: "request_rejected" });
      await expect(executeDurableLuminSignV1DirectUpload(input(), {
        stateRoot,
        nowMs: NOW_MS,
        fetchImpl: async () => {
          calls += 1;
          return successResponse();
        },
      })).rejects.toMatchObject({ code: "LUMIN_OPERATION_ALREADY_CONSUMED" });
      expect(calls).toBe(1);
    });
  });

  it("recovers an empty pre-claim directory without creating a second provider attempt", async () => {
    await withLifecycleState(async ({ stateRoot }) => {
      const value = input();
      const authorityDigest = authoritySha256(value.execution_authority);
      const operationsRoot = path.join(stateRoot, "lumin-sign-v1-operations");
      await fs.mkdir(stateRoot, { mode: 0o700 });
      await fs.mkdir(operationsRoot, { mode: 0o700 });
      await fs.mkdir(path.join(operationsRoot, authorityDigest), { mode: 0o700 });
      let calls = 0;
      await expect(executeDurableLuminSignV1DirectUpload(value, {
        stateRoot,
        nowMs: NOW_MS,
        fetchImpl: async () => {
          calls += 1;
          return successResponse();
        },
      })).resolves.toMatchObject({
        operation: { operation_status: "request_created" },
      });
      expect(calls).toBe(1);
      await expect(inspectLuminSignV1Operation({
        state_root: stateRoot,
        authority_sha256: authorityDigest,
      })).resolves.toMatchObject({ operation_status: "request_created" });
      await expect(executeDurableLuminSignV1DirectUpload(input(), {
        stateRoot,
        nowMs: NOW_MS,
        fetchImpl: async () => {
          calls += 1;
          return successResponse();
        },
      })).rejects.toMatchObject({ code: "LUMIN_OPERATION_ALREADY_CONSUMED" });
      expect(calls).toBe(1);
    });
  });

  it("rejects an outcome-shaped pre-claim directory before provider entry", async () => {
    await withLifecycleState(async ({ stateRoot }) => {
      const value = input();
      const authorityDigest = authoritySha256(value.execution_authority);
      const operationPath = path.join(
        stateRoot,
        "lumin-sign-v1-operations",
        authorityDigest,
      );
      await fs.mkdir(operationPath, { recursive: true, mode: 0o700 });
      await fs.writeFile(
        path.join(operationPath, "outcome.v1.json"),
        "{\"operation_status\":\"forged_without_claim\"}\n",
        { mode: 0o600 },
      );
      let calls = 0;
      await expect(executeDurableLuminSignV1DirectUpload(value, {
        stateRoot,
        nowMs: NOW_MS,
        fetchImpl: async () => {
          calls += 1;
          return successResponse();
        },
      })).rejects.toMatchObject({ code: "LUMIN_OPERATION_STATE_REJECTED" });
      expect(calls).toBe(0);
      await expect(fs.lstat(path.join(operationPath, "claim.v1.json")))
        .rejects.toMatchObject({ code: "ENOENT" });
    });
  });

  it("does not create durable state for a locally invalid request", async () => {
    await withLifecycleState(async ({ stateRoot }) => {
      const value = input();
      value.prepared_pdf_bytes = Buffer.from("not a PDF");
      let calls = 0;
      await expect(executeDurableLuminSignV1DirectUpload(value, {
        stateRoot,
        nowMs: NOW_MS,
        fetchImpl: async () => {
          calls += 1;
          return successResponse();
        },
      })).rejects.toMatchObject({ code: "LUMIN_TRANSPORT_INPUT_INVALID" });
      expect(calls).toBe(0);
      await expect(fs.lstat(stateRoot)).rejects.toMatchObject({ code: "ENOENT" });
    });
  });

  it("returns a stable typed error when private state cannot be established", async () => {
    await withLifecycleState(async ({ stateRoot }) => {
      await fs.mkdir(stateRoot, { mode: 0o755 });
      let calls = 0;
      await expect(executeDurableLuminSignV1DirectUpload(input(), {
        stateRoot,
        nowMs: NOW_MS,
        fetchImpl: async () => {
          calls += 1;
          return successResponse();
        },
      })).rejects.toMatchObject({
        code: "LUMIN_OPERATION_STATE_REJECTED",
        message: "LUMIN_OPERATION_STATE_REJECTED: The durable operation claim could not be committed before any provider call.",
      });
      expect(calls).toBe(0);
    });
  });

  it("rejects private state owned by a different effective POSIX user before provider entry", async () => {
    if (process.platform === "win32" || typeof process.getuid !== "function") return;
    await withLifecycleState(async ({ stateRoot }) => {
      const userIdMethod = typeof process.geteuid === "function" ? "geteuid" : "getuid";
      const actualUid = process[userIdMethod]();
      const getuid = vi.spyOn(process, userIdMethod).mockReturnValue(actualUid + 1);
      let calls = 0;
      try {
        await expect(executeDurableLuminSignV1DirectUpload(input(), {
          stateRoot,
          nowMs: NOW_MS,
          fetchImpl: async () => {
            calls += 1;
            return successResponse();
          },
        })).rejects.toMatchObject({ code: "LUMIN_OPERATION_STATE_REJECTED" });
      } finally {
        getuid.mockRestore();
      }
      expect(calls).toBe(0);
    });
  });

  it("quarantines a stale uncommitted stage without blocking a new exact authority", async () => {
    await withLifecycleState(async ({ stateRoot }) => {
      const operationsRoot = path.join(stateRoot, "lumin-sign-v1-operations");
      const stagingRoot = path.join(operationsRoot, ".staging");
      await fs.mkdir(stateRoot, { mode: 0o700 });
      await fs.mkdir(operationsRoot, { mode: 0o700 });
      await fs.mkdir(stagingRoot, { mode: 0o700 });
      const stageName = "claim.v1.json-11111111-1111-4111-8111-111111111111.tmp";
      const stagePath = path.join(stagingRoot, stageName);
      await fs.writeFile(stagePath, "{\"stale\":true}\n", { mode: 0o600 });
      await fs.utimes(stagePath, new Date(0), new Date(0));
      let calls = 0;
      await expect(executeDurableLuminSignV1DirectUpload(input(), {
        stateRoot,
        nowMs: NOW_MS,
        fetchImpl: async () => {
          calls += 1;
          return successResponse();
        },
      })).resolves.toMatchObject({ operation: { operation_status: "request_created" } });
      expect(calls).toBe(1);
      await expect(fs.lstat(stagePath)).rejects.toMatchObject({ code: "ENOENT" });
      const quarantinedPath = path.join(stagingRoot, ".quarantine", stageName);
      const quarantined = await fs.lstat(quarantinedPath);
      expect(quarantined.isFile()).toBe(true);
      expect(quarantined.mode & 0o777).toBe(0o600);
      expect(quarantined.nlink).toBe(1);
    });
  });

  it("reconciles one stale stage concurrently without blocking distinct authorities", async () => {
    await withLifecycleState(async ({ stateRoot }) => {
      const operationsRoot = path.join(stateRoot, "lumin-sign-v1-operations");
      const stagingRoot = path.join(operationsRoot, ".staging");
      await fs.mkdir(stagingRoot, { recursive: true, mode: 0o700 });
      const stageName = "claim.v1.json-aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa.tmp";
      const stagePath = path.join(stagingRoot, stageName);
      await fs.writeFile(stagePath, "{\"stale\":true}\n", { mode: 0o600 });
      await fs.utimes(stagePath, new Date(0), new Date(0));
      const values = Array.from({ length: 4 }, (_, index) => {
        const value = input();
        value.execution_authority.approved_at = new Date(
          Date.parse("2030-01-01T00:00:00.000Z") + index,
        ).toISOString();
        return value;
      });
      let calls = 0;
      const settled = await Promise.allSettled(values.map(value =>
        executeDurableLuminSignV1DirectUpload(value, {
          stateRoot,
          nowMs: NOW_MS,
          fetchImpl: async () => {
            calls += 1;
            return successResponse();
          },
        })));
      expect(settled.every(result => result.status === "fulfilled")).toBe(true);
      expect(calls).toBe(4);
      await expect(fs.lstat(stagePath)).rejects.toMatchObject({ code: "ENOENT" });
      await expect(fs.lstat(path.join(stagingRoot, ".quarantine", stageName)))
        .resolves.toMatchObject({ nlink: 1 });
    });
  });

  it("treats quarantine contents as inert operator evidence", async () => {
    await withLifecycleState(async ({ stateRoot }) => {
      const quarantineRoot = path.join(
        stateRoot,
        "lumin-sign-v1-operations",
        ".staging",
        ".quarantine",
      );
      await fs.mkdir(quarantineRoot, { recursive: true, mode: 0o700 });
      const notePath = path.join(quarantineRoot, "operator-review.txt");
      await fs.writeFile(notePath, "retained for manual review\n", { mode: 0o600 });
      let calls = 0;
      await expect(executeDurableLuminSignV1DirectUpload(input(), {
        stateRoot,
        nowMs: NOW_MS,
        fetchImpl: async () => {
          calls += 1;
          return successResponse();
        },
      })).resolves.toMatchObject({ operation: { operation_status: "request_created" } });
      expect(calls).toBe(1);
      await expect(fs.readFile(notePath, "utf8")).resolves.toBe("retained for manual review\n");
    });
  });

  it("rejects a staging timestamp materially in the future", async () => {
    await withLifecycleState(async ({ stateRoot }) => {
      const stagingRoot = path.join(stateRoot, "lumin-sign-v1-operations", ".staging");
      await fs.mkdir(stagingRoot, { recursive: true, mode: 0o700 });
      const stagePath = path.join(
        stagingRoot,
        "claim.v1.json-bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb.tmp",
      );
      await fs.writeFile(stagePath, "{\"future\":true}\n", { mode: 0o600 });
      const future = new Date(Date.now() + 2 * 60 * 1000);
      await fs.utimes(stagePath, future, future);
      let calls = 0;
      await expect(executeDurableLuminSignV1DirectUpload(input(), {
        stateRoot,
        nowMs: NOW_MS,
        fetchImpl: async () => {
          calls += 1;
          return successResponse();
        },
      })).rejects.toMatchObject({ code: "LUMIN_OPERATION_STATE_REJECTED" });
      expect(calls).toBe(0);
    });
  });

  it("leaves a fresh unlinked stage untouched so reconciliation cannot race its writer", async () => {
    await withLifecycleState(async ({ stateRoot }) => {
      const stagingRoot = path.join(stateRoot, "lumin-sign-v1-operations", ".staging");
      await fs.mkdir(stagingRoot, { recursive: true, mode: 0o700 });
      const stageName = "outcome.v1.json-22222222-2222-4222-8222-222222222222.tmp";
      const stagePath = path.join(stagingRoot, stageName);
      await fs.writeFile(stagePath, "{\"active\":true}\n", { mode: 0o600 });
      let calls = 0;
      await expect(executeDurableLuminSignV1DirectUpload(input(), {
        stateRoot,
        nowMs: NOW_MS,
        fetchImpl: async () => {
          calls += 1;
          return successResponse();
        },
      })).resolves.toMatchObject({ operation: { operation_status: "request_created" } });
      expect(calls).toBe(1);
      await expect(fs.readFile(stagePath, "utf8")).resolves.toBe("{\"active\":true}\n");
      await expect(fs.lstat(path.join(stagingRoot, ".quarantine")))
        .rejects.toMatchObject({ code: "ENOENT" });
    });
  });

  it("rejects unsafe staging entries before a provider call", async () => {
    await withLifecycleState(async ({ stateRoot }) => {
      const stagingRoot = path.join(stateRoot, "lumin-sign-v1-operations", ".staging");
      await fs.mkdir(stagingRoot, { recursive: true, mode: 0o700 });
      await fs.writeFile(path.join(stagingRoot, "unexpected.txt"), "unsafe\n", { mode: 0o600 });
      let calls = 0;
      await expect(executeDurableLuminSignV1DirectUpload(input(), {
        stateRoot,
        nowMs: NOW_MS,
        fetchImpl: async () => {
          calls += 1;
          return successResponse();
        },
      })).rejects.toMatchObject({ code: "LUMIN_OPERATION_STATE_REJECTED" });
      expect(calls).toBe(0);
    });
  });

  it("rejects retained state drift, unsafe modes, and symlink substitution", async () => {
    await withLifecycleState(async ({ stateRoot }) => {
      const { authoritySha256: authorityDigest } = await createDurableOperation(stateRoot);
      const operationPath = path.join(stateRoot, "lumin-sign-v1-operations", authorityDigest);
      const claimPath = path.join(operationPath, "claim.v1.json");
      const original = await fs.readFile(claimPath);
      await fs.writeFile(claimPath, Buffer.concat([original.subarray(0, -2), Buffer.from(" \n")]));
      await expect(inspectLuminSignV1Operation({
        state_root: stateRoot,
        authority_sha256: authorityDigest,
      })).rejects.toMatchObject({ code: "LUMIN_OPERATION_STATE_INVALID" });
      await fs.writeFile(claimPath, original, { mode: 0o600 });
      await fs.chmod(stateRoot, 0o755);
      await expect(inspectLuminSignV1Operation({
        state_root: stateRoot,
        authority_sha256: authorityDigest,
      })).rejects.toMatchObject({ code: "LUMIN_OPERATION_STATE_INVALID" });
      await fs.chmod(stateRoot, 0o700);
      const target = path.join(operationPath, "claim-target.json");
      await fs.rename(claimPath, target);
      await fs.symlink(target, claimPath);
      await expect(inspectLuminSignV1Operation({
        state_root: stateRoot,
        authority_sha256: authorityDigest,
      })).rejects.toMatchObject({ code: "LUMIN_OPERATION_STATE_INVALID" });
    });
  });

  it("polls the exact created request and persists only a privacy-safe status observation", async () => {
    await withLifecycleState(async ({ stateRoot }) => {
      const { authoritySha256: authorityDigest } = await createDurableOperation(stateRoot);
      let calls = 0;
      const observation = await pollAndRecordLuminSignV1Status({
        access_token: ACCESS_TOKEN,
        authority_sha256: authorityDigest,
        state_root: stateRoot,
      }, {
        nowMs: NOW_MS + 1_000,
        timeoutMs: 5_000,
        fetchImpl: async (url, options) => {
          calls += 1;
          expect(url).toBe("https://api.luminpdf.com/v1/signature_request/sigreq.synthetic-123");
          expect(options).toMatchObject({ method: "GET", redirect: "error" });
          expect(options.headers.authorization).toBe(`Bearer ${ACCESS_TOKEN}`);
          expect(options.headers["user-agent"]).toBe(LUMIN_CLIENT_USER_AGENT);
          return new Response(JSON.stringify({
            signature_request: {
              signature_request_id: "sigreq.synthetic-123",
              title: "Private title not retained",
              status: "APPROVED",
              signers: [{ email_address: "private@example.com" }],
            },
          }), { status: 200, headers: { "content-type": "application/json" } });
        },
      });
      expect(calls).toBe(1);
      expect(observation).toMatchObject({
        observation_source: "authenticated_poll",
        signature_request_id: "sigreq.synthetic-123",
        status: "APPROVED",
        access_token_persisted: false,
        response_body_persisted: false,
      });
      const operationBytes = await fs.readFile(path.join(
        stateRoot,
        "lumin-sign-v1-operations",
        authorityDigest,
        "observations",
        `poll-${observation.observation_sha256}.v1.json`,
      ), "utf8");
      expect(operationBytes).not.toContain(ACCESS_TOKEN);
      expect(operationBytes).not.toContain("private@example.com");
      expect(operationBytes).not.toContain("Private title");
    });
  });

  // These atomic retention/race scenarios deliberately perform 64–70 durable
  // polls (including filesystem syncs), measured at 6.5–7.6 s on darwin/x64.
  // Their aggregate ceiling does not change any provider request deadline.
  it("retains the audit origin and newest 63 polls without removing artifact observations", async () => {
    await withLifecycleState(async ({ stateRoot }) => {
      const { authoritySha256: authorityDigest } = await createDurableOperation(stateRoot);
      const artifact = await requestAndRecordLuminSignV1ArtifactAccess({
        access_token: ACCESS_TOKEN,
        authority_sha256: authorityDigest,
        file_type: "merged",
        state_root: stateRoot,
      }, {
        nowMs: NOW_MS + 500,
        fetchImpl: async () => new Response(JSON.stringify({
          signed_url: "https://files.luminpdf.com/download/synthetic.pdf?token=private",
          expires_at: Math.floor((NOW_MS + 500) / 1000) + 1_800,
        }), { status: 200, headers: { "content-type": "application/json" } }),
      });
      const observations = [];
      for (let index = 0; index < 70; index += 1) {
        observations.push(await pollAndRecordLuminSignV1Status({
          access_token: ACCESS_TOKEN,
          authority_sha256: authorityDigest,
          state_root: stateRoot,
        }, {
          nowMs: NOW_MS + 1_000 + index,
          fetchImpl: async () => statusResponse(index % 2 === 0 ? "APPROVED" : "WAITING_FOR_OTHERS"),
        }));
      }
      const observationsPath = path.join(
        stateRoot,
        "lumin-sign-v1-operations",
        authorityDigest,
        "observations",
      );
      const retainedNames = await fs.readdir(observationsPath);
      const retainedPollNames = retainedNames.filter(name => name.startsWith("poll-")).sort();
      const expectedPollNames = [observations[0], ...observations.slice(-63)]
        .map(observation => `poll-${observation.observation_sha256}.v1.json`)
        .sort();
      expect(retainedPollNames).toEqual(expectedPollNames);
      expect(retainedNames).toContain(
        `artifact-merged-${artifact.observation.observation_sha256}.v1.json`,
      );
    });
  }, 20_000);

  it("concurrent polling converges on the same bounded history", async () => {
    await withLifecycleState(async ({ stateRoot }) => {
      const { authoritySha256: authorityDigest } = await createDurableOperation(stateRoot);
      const observations = await Promise.all(Array.from({ length: 70 }, async (_value, index) => (
        pollAndRecordLuminSignV1Status({
          access_token: ACCESS_TOKEN,
          authority_sha256: authorityDigest,
          state_root: stateRoot,
        }, {
          nowMs: NOW_MS + 10_000 + index,
          fetchImpl: async () => statusResponse(index % 2 === 0 ? "APPROVED" : "WAITING_FOR_OTHERS"),
        })
      )));
      const retainedNames = (await fs.readdir(path.join(
        stateRoot,
        "lumin-sign-v1-operations",
        authorityDigest,
        "observations",
      ))).filter(name => name.startsWith("poll-")).sort();
      const expectedNames = [observations[0], ...observations.slice(-63)]
        .map(observation => `poll-${observation.observation_sha256}.v1.json`)
        .sort();
      expect(retainedNames).toEqual(expectedNames);
    });
  });

  it("keeps a full history intact when a provider read fails", async () => {
    await withLifecycleState(async ({ stateRoot }) => {
      const { authoritySha256: authorityDigest } = await createDurableOperation(stateRoot);
      const request = {
        access_token: ACCESS_TOKEN,
        authority_sha256: authorityDigest,
        state_root: stateRoot,
      };
      for (let index = 0; index < 64; index += 1) {
        await pollAndRecordLuminSignV1Status(request, {
          nowMs: NOW_MS + 1_000 + index,
          fetchImpl: async () => statusResponse(),
        });
      }
      const observationsPath = path.join(stateRoot, "lumin-sign-v1-operations", authorityDigest, "observations");
      const namesBefore = (await fs.readdir(observationsPath)).sort();
      expect(namesBefore).toHaveLength(64);
      await expect(pollAndRecordLuminSignV1Status(request, {
        nowMs: NOW_MS + 2_000,
        fetchImpl: async () => { throw new Error("synthetic outage"); },
      })).rejects.toMatchObject({ code: "LUMIN_STATUS_OBSERVATION_RETRYABLE" });
      expect((await fs.readdir(observationsPath)).sort()).toEqual(namesBefore);
      // Repeating the same exact observation also needs no new history slot.
      await pollAndRecordLuminSignV1Status(request, {
        nowMs: NOW_MS + 1_063,
        fetchImpl: async () => statusResponse(),
      });
      expect((await fs.readdir(observationsPath)).sort()).toEqual(namesBefore);
    });
  }, 20_000);

  it("allows an older published poll to finish after concurrent checks prune its receipt", async () => {
    await withLifecycleState(async ({ stateRoot }) => {
      const { authoritySha256: authorityDigest } = await createDurableOperation(stateRoot);
      const request = {
        access_token: ACCESS_TOKEN,
        authority_sha256: authorityDigest,
        state_root: stateRoot,
      };
      const origin = await pollAndRecordLuminSignV1Status(request, {
        nowMs: NOW_MS + 1_000,
        fetchImpl: async () => statusResponse(),
      });
      const realLink = fs.link.bind(fs);
      let releasePublication;
      let markPublished;
      const published = new Promise(resolve => { markPublished = resolve; });
      const resume = new Promise(resolve => { releasePublication = resolve; });
      let pausedPath;
      const linkSpy = vi.spyOn(fs, "link").mockImplementation(async (source, destination) => {
        await realLink(source, destination);
        if (!pausedPath && path.basename(destination).startsWith("poll-")) {
          pausedPath = destination;
          markPublished();
          await resume;
        }
      });
      const delayed = pollAndRecordLuminSignV1Status(request, {
        nowMs: NOW_MS + 2_000,
        fetchImpl: async () => statusResponse("WAITING_FOR_OTHERS"),
      });
      // Attach a handler immediately so cleanup also settles a failing run.
      const settled = delayed.then(value => ({ value }), error => ({ error }));
      try {
        await published;
        for (let index = 0; index < 64; index += 1) {
          await pollAndRecordLuminSignV1Status(request, {
            nowMs: NOW_MS + 3_000 + index,
            fetchImpl: async () => statusResponse(),
          });
        }
        await expect(fs.lstat(pausedPath)).rejects.toMatchObject({ code: "ENOENT" });
        releasePublication();
        expect(await settled).toMatchObject({ value: { status: "WAITING_FOR_OTHERS" } });
        const names = await fs.readdir(path.dirname(pausedPath));
        expect(names).toHaveLength(64);
        expect(names).toContain(`poll-${origin.observation_sha256}.v1.json`);
      } finally {
        releasePublication();
        await settled;
        linkSpy.mockRestore();
      }
    });
  }, 20_000);

  it("allows a duplicate poll to finish when cleanup wins its collision readback", async () => {
    await withLifecycleState(async ({ stateRoot }) => {
      const { authoritySha256: authorityDigest } = await createDurableOperation(stateRoot);
      const request = { access_token: ACCESS_TOKEN, authority_sha256: authorityDigest, state_root: stateRoot };
      const observations = [];
      for (let index = 0; index < 64; index += 1) {
        observations.push(await pollAndRecordLuminSignV1Status(request, {
          nowMs: NOW_MS + 1_000 + index,
          fetchImpl: async () => statusResponse(),
        }));
      }
      const duplicatePath = path.join(stateRoot, "lumin-sign-v1-operations", authorityDigest,
        "observations", `poll-${observations[1].observation_sha256}.v1.json`);
      const realLink = fs.link.bind(fs);
      let markCollision;
      let releaseCollision;
      const collided = new Promise(resolve => { markCollision = resolve; });
      const resume = new Promise(resolve => { releaseCollision = resolve; });
      const linkSpy = vi.spyOn(fs, "link").mockImplementation(async (source, destination) => {
        try {
          await realLink(source, destination);
        } catch (error) {
          if (destination === duplicatePath && error.code === "EEXIST") {
            markCollision();
            await resume;
          }
          throw error;
        }
      });
      const settled = pollAndRecordLuminSignV1Status(request, {
        nowMs: NOW_MS + 1_001,
        fetchImpl: async () => statusResponse(),
      }).then(value => ({ value }), error => ({ error }));
      try {
        await collided;
        await pollAndRecordLuminSignV1Status(request, {
          nowMs: NOW_MS + 2_000,
          fetchImpl: async () => statusResponse(),
        });
        await expect(fs.lstat(duplicatePath)).rejects.toMatchObject({ code: "ENOENT" });
        releaseCollision();
        expect(await settled).toMatchObject({ value: observations[1] });
        expect(await fs.readdir(path.dirname(duplicatePath))).toHaveLength(64);
      } finally {
        releaseCollision();
        await settled;
        linkSpy.mockRestore();
      }
    });
  }, 20_000);

  it.each(["invalid content", "invalid name", "unsafe mode", "symlink"])(
    "rejects retained poll history with %s before another provider read", async kind => {
    await withLifecycleState(async ({ stateRoot }) => {
      const { authoritySha256: authorityDigest } = await createDurableOperation(stateRoot);
      const original = await pollAndRecordLuminSignV1Status({
        access_token: ACCESS_TOKEN,
        authority_sha256: authorityDigest,
        state_root: stateRoot,
      }, {
        nowMs: NOW_MS + 1_000,
        fetchImpl: async () => statusResponse(),
      });
      const observationsPath = path.join(
        stateRoot,
        "lumin-sign-v1-operations",
        authorityDigest,
        "observations",
      );
      const corruptPath = path.join(observationsPath,
        kind === "invalid name" ? "poll-invalid.json" : `poll-${"a".repeat(64)}.v1.json`);
      if (kind === "symlink") {
        await fs.symlink(path.join(observationsPath, `poll-${original.observation_sha256}.v1.json`), corruptPath);
      } else {
        await fs.writeFile(corruptPath, "{}\n", { mode: 0o600 });
        if (kind === "unsafe mode") await fs.chmod(corruptPath, 0o644);
      }
      const namesBefore = (await fs.readdir(observationsPath)).sort();
      let calls = 0;
      await expect(pollAndRecordLuminSignV1Status({
        access_token: ACCESS_TOKEN,
        authority_sha256: authorityDigest,
        state_root: stateRoot,
      }, {
        nowMs: NOW_MS + 2_000,
        fetchImpl: async () => {
          calls += 1;
          return statusResponse();
        },
      })).rejects.toMatchObject({
        code: "LUMIN_STATUS_OBSERVATION_RETRYABLE",
        reconciliation_class: "retryable_read_failure",
        read_retry_safe: true,
        create_retry_allowed: false,
      });
      expect(calls).toBe(0);
      expect((await fs.readdir(observationsPath)).sort()).toEqual(namesBefore);
      await expect(inspectLuminSignV1Operation({
        state_root: stateRoot,
        authority_sha256: authorityDigest,
      })).resolves.toMatchObject({
        operation_status: "request_created",
        create_retry_allowed: false,
      });
    });
  });

  it("distinguishes an unreconcilable create from retry-safe status and artifact reads", async () => {
    await withLifecycleState(async ({ stateRoot }) => {
      const value = input();
      const authorityDigest = authoritySha256(value.execution_authority);
      await expect(executeDurableLuminSignV1DirectUpload(value, {
        stateRoot,
        nowMs: NOW_MS,
        fetchImpl: async () => {
          throw new Error("synthetic ambiguous create");
        },
      })).rejects.toMatchObject({ code: "LUMIN_CREATE_OUTCOME_UNKNOWN" });
      let readCalls = 0;
      await expect(pollAndRecordLuminSignV1Status({
        access_token: ACCESS_TOKEN,
        authority_sha256: authorityDigest,
        state_root: stateRoot,
      }, {
        nowMs: NOW_MS + 1_000,
        fetchImpl: async () => {
          readCalls += 1;
          return new Response("{}");
        },
      })).rejects.toMatchObject({
        code: "LUMIN_OPERATION_UNRECONCILABLE",
        reconciliation_class: "terminal_unreconcilable",
        read_retry_safe: false,
        create_retry_allowed: false,
      });
      await expect(requestAndRecordLuminSignV1ArtifactAccess({
        access_token: ACCESS_TOKEN,
        authority_sha256: authorityDigest,
        file_type: "merged",
        state_root: stateRoot,
      }, {
        nowMs: NOW_MS + 1_000,
        fetchImpl: async () => {
          readCalls += 1;
          return new Response("{}");
        },
      })).rejects.toMatchObject({
        code: "LUMIN_OPERATION_UNRECONCILABLE",
        reconciliation_class: "terminal_unreconcilable",
        read_retry_safe: false,
        create_retry_allowed: false,
      });
      expect(readCalls).toBe(0);
    });

    await withLifecycleState(async ({ stateRoot }) => {
      const { authoritySha256: authorityDigest } = await createDurableOperation(stateRoot);
      let readCalls = 0;
      const unavailable = async () => {
        readCalls += 1;
        throw new Error("synthetic read outage");
      };
      await expect(pollAndRecordLuminSignV1Status({
        access_token: ACCESS_TOKEN,
        authority_sha256: authorityDigest,
        state_root: stateRoot,
      }, {
        nowMs: NOW_MS + 1_000,
        fetchImpl: unavailable,
      })).rejects.toMatchObject({
        code: "LUMIN_STATUS_OBSERVATION_RETRYABLE",
        reconciliation_class: "retryable_read_failure",
        read_retry_safe: true,
        create_retry_allowed: false,
      });
      await expect(requestAndRecordLuminSignV1ArtifactAccess({
        access_token: ACCESS_TOKEN,
        authority_sha256: authorityDigest,
        file_type: "merged",
        state_root: stateRoot,
      }, {
        nowMs: NOW_MS + 1_000,
        fetchImpl: unavailable,
      })).rejects.toMatchObject({
        code: "LUMIN_ARTIFACT_OBSERVATION_RETRYABLE",
        reconciliation_class: "retryable_read_failure",
        read_retry_safe: true,
        create_retry_allowed: false,
      });
      expect(readCalls).toBe(2);
      await expect(inspectLuminSignV1Operation({
        state_root: stateRoot,
        authority_sha256: authorityDigest,
      })).resolves.toMatchObject({ operation_status: "request_created" });
    });
  });

  it("classifies reads during an in-flight create as safe to retry without allowing create retry", async () => {
    await withLifecycleState(async ({ stateRoot }) => {
      const value = input();
      const authorityDigest = authoritySha256(value.execution_authority);
      let releaseCreate;
      let markEntered;
      const entered = new Promise(resolve => { markEntered = resolve; });
      const creation = executeDurableLuminSignV1DirectUpload(value, {
        stateRoot,
        nowMs: NOW_MS,
        fetchImpl: async () => {
          markEntered();
          return new Promise(resolve => { releaseCreate = () => resolve(successResponse()); });
        },
      });
      await entered;
      let readCalls = 0;
      for (const read of [
        () => pollAndRecordLuminSignV1Status({
          access_token: ACCESS_TOKEN,
          authority_sha256: authorityDigest,
          state_root: stateRoot,
        }, {
          nowMs: NOW_MS + 1,
          fetchImpl: async () => { readCalls += 1; return new Response("{}"); },
        }),
        () => requestAndRecordLuminSignV1ArtifactAccess({
          access_token: ACCESS_TOKEN,
          authority_sha256: authorityDigest,
          file_type: "merged",
          state_root: stateRoot,
        }, {
          nowMs: NOW_MS + 1,
          fetchImpl: async () => { readCalls += 1; return new Response("{}"); },
        }),
      ]) {
        await expect(read()).rejects.toMatchObject({
          code: "LUMIN_OPERATION_OUTCOME_NOT_RETAINED",
          reconciliation_class: "outcome_not_retained",
          read_retry_safe: true,
          create_retry_allowed: false,
        });
      }
      expect(readCalls).toBe(0);
      releaseCreate();
      await expect(creation).resolves.toMatchObject({
        operation: { operation_status: "request_created" },
      });
    });
  });

  it("rejects ambiguous duplicate members and request-ID drift in status responses", async () => {
    await withLifecycleState(async ({ stateRoot }) => {
      const { authoritySha256: authorityDigest } = await createDurableOperation(stateRoot);
      for (const body of [
        '{"signature_request":{"signature_request_id":"wrong","signature_request_id":"sigreq.synthetic-123","status":"APPROVED"}}',
        '{"signature_request":{"signature_request_id":"wrong","status":"APPROVED"}}',
      ]) {
        await expect(pollAndRecordLuminSignV1Status({
          access_token: ACCESS_TOKEN,
          authority_sha256: authorityDigest,
          state_root: stateRoot,
        }, {
          nowMs: NOW_MS + 1_000,
          fetchImpl: async () => new Response(body, {
            status: 200,
            headers: { "content-type": "application/json" },
          }),
        })).rejects.toMatchObject({ code: "LUMIN_STATUS_OBSERVATION_RETRYABLE" });
      }
    });
  });

  it.each(["seconds", "milliseconds", "live-milliseconds-with-download-url"])("records %s artifact access without persisting URLs or token", async (shape) => {
    await withLifecycleState(async ({ stateRoot }) => {
      const { authoritySha256: authorityDigest } = await createDurableOperation(stateRoot);
      const signedUrl = "https://files.luminpdf.com/download/synthetic.pdf?token=private";
      const downloadUrl = "https://files.luminpdf.com/download/synthetic.pdf?token=other-private";
      const expiresAtSeconds = Math.floor((NOW_MS + 1_000) / 1000) + 1_800;
      const artifact = await requestAndRecordLuminSignV1ArtifactAccess({
        access_token: ACCESS_TOKEN,
        authority_sha256: authorityDigest,
        file_type: "merged",
        state_root: stateRoot,
      }, {
        nowMs: NOW_MS + 1_000,
        fetchImpl: async (url, options) => {
          expect(url).toBe("https://api.luminpdf.com/v1/signature_request/sigreq.synthetic-123/file?type=merged");
          expect(options.headers.authorization).toBe(`Bearer ${ACCESS_TOKEN}`);
          expect(options.headers["user-agent"]).toBe(LUMIN_CLIENT_USER_AGENT);
          return new Response(JSON.stringify({
            signed_url: signedUrl,
            expires_at: shape === "seconds" ? expiresAtSeconds : expiresAtSeconds * 1000 + 123,
            ...(shape === "live-milliseconds-with-download-url" ? { download_url: downloadUrl } : {}),
          }), { status: 200, headers: { "content-type": "application/json" } });
        },
      });
      expect(artifact.signed_url).toBe(signedUrl);
      expect(artifact.expires_at).toBe(expiresAtSeconds);
      expect(artifact.observation.access_url_expires_at).toBe(expiresAtSeconds);
      expect(artifact).not.toHaveProperty("download_url");
      expect(artifact.persistence_policy).toBe("ephemeral_caller_consumption_only");
      const observationPath = path.join(
        stateRoot,
        "lumin-sign-v1-operations",
        authorityDigest,
        "observations",
        `artifact-merged-${artifact.observation.observation_sha256}.v1.json`,
      );
      const retained = await fs.readFile(observationPath, "utf8");
      expect(retained).not.toContain(signedUrl);
      expect(retained).not.toContain(downloadUrl);
      expect(retained).not.toContain(ACCESS_TOKEN);
      expect(retained).toContain(createHash("sha256").update(signedUrl).digest("hex"));
    });
  });

  it.each([
    ["non-HTTPS URL", { signed_url: "http://files.luminpdf.com/private", expires_at: Math.floor((NOW_MS + 1_000) / 1000) + 1_800 }],
    ["overlong expiry", { signed_url: "https://files.luminpdf.com/private", expires_at: Math.floor((NOW_MS + 1_000) / 1000) + 3_600 }],
    ["overlong millisecond expiry", { signed_url: "https://files.luminpdf.com/private", expires_at: NOW_MS + 3_600_000 }],
    ["expired millisecond expiry", { signed_url: "https://files.luminpdf.com/private", expires_at: NOW_MS }],
    ["fractional millisecond expiry", { signed_url: "https://files.luminpdf.com/private", expires_at: NOW_MS + 900_000.5 }],
    ["string expiry", { signed_url: "https://files.luminpdf.com/private", expires_at: String(NOW_MS + 900_000) }],
    ["non-HTTPS alternate URL", { signed_url: "https://files.luminpdf.com/private", download_url: "http://files.luminpdf.com/private", expires_at: NOW_MS + 900_000 }],
    ["malformed alternate URL", { signed_url: "https://files.luminpdf.com/private", download_url: 17, expires_at: NOW_MS + 900_000 }],
    ["credential-bearing alternate URL", { signed_url: "https://files.luminpdf.com/private", download_url: "https://user:pass@files.luminpdf.com/private", expires_at: NOW_MS + 900_000 }],
    ["extra envelope field", { signed_url: "https://files.luminpdf.com/private", extra: true, expires_at: NOW_MS + 900_000 }],
  ])("rejects %s artifact access without persisting it", async (_label, providerBody) => {
    await withLifecycleState(async ({ stateRoot }) => {
      const { authoritySha256: authorityDigest } = await createDurableOperation(stateRoot);
      await expect(requestAndRecordLuminSignV1ArtifactAccess({
        access_token: ACCESS_TOKEN,
        authority_sha256: authorityDigest,
        file_type: "agreement",
        state_root: stateRoot,
      }, {
        nowMs: NOW_MS + 1_000,
        fetchImpl: async () => new Response(JSON.stringify(providerBody), {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
      })).rejects.toMatchObject({ code: "LUMIN_ARTIFACT_OBSERVATION_RETRYABLE" });
      const observationsPath = path.join(
        stateRoot,
        "lumin-sign-v1-operations",
        authorityDigest,
        "observations",
      );
      await expect(fs.lstat(observationsPath)).rejects.toMatchObject({ code: "ENOENT" });
    });
  });

  it("verifies webhook HMAC over exact raw bytes and deduplicates by request plus event type", async () => {
    await withLifecycleState(async ({ stateRoot }) => {
      const { authoritySha256: authorityDigest } = await createDurableOperation(stateRoot);
      const secret = Buffer.from("synthetic-app-signing-secret");
      const rawBody = Buffer.from(JSON.stringify({
        event: { event_time: NOW_MS + 2_000, event_type: "signature_request_approved" },
        signature_request: {
          signature_request_id: "sigreq.synthetic-123",
          title: "Private title not retained",
          status: "APPROVED",
          signers: [{ email_address: "private@example.com" }],
        },
      }));
      const signature = createHmac("sha256", secret).update(rawBody).digest("hex");
      const first = await verifyAndRecordLuminSignV1Webhook({
        authority_sha256: authorityDigest,
        raw_body: rawBody,
        signing_secret: secret,
        state_root: stateRoot,
        x_signature: signature,
      }, { nowMs: NOW_MS + 3_000 });
      const duplicate = await verifyAndRecordLuminSignV1Webhook({
        authority_sha256: authorityDigest,
        raw_body: rawBody,
        signing_secret: secret,
        state_root: stateRoot,
        x_signature: signature,
      }, { nowMs: NOW_MS + 4_000 });
      expect(duplicate).toEqual(first);
      expect(first).toMatchObject({
        observation_source: "verified_app_webhook",
        signature_request_id: "sigreq.synthetic-123",
        event_type: "signature_request_approved",
        status: "APPROVED",
        signing_secret_persisted: false,
        raw_body_persisted: false,
      });
      const retained = await fs.readFile(path.join(
        stateRoot,
        "lumin-sign-v1-operations",
        authorityDigest,
        "observations",
        `webhook-${first.idempotency_sha256}.v1.json`,
      ), "utf8");
      expect(retained).not.toContain(secret.toString("utf8"));
      expect(retained).not.toContain("private@example.com");
      expect(retained).not.toContain("Private title");
    });
  });

  it("rejects conflicting webhook bytes for an already consumed provider idempotency pair", async () => {
    await withLifecycleState(async ({ stateRoot }) => {
      const { authoritySha256: authorityDigest } = await createDurableOperation(stateRoot);
      const secret = Buffer.from("synthetic-app-signing-secret");
      const build = title => {
        const rawBody = Buffer.from(JSON.stringify({
          event: { event_time: NOW_MS + 2_000, event_type: "signature_request_approved" },
          signature_request: {
            signature_request_id: "sigreq.synthetic-123",
            title,
            status: "APPROVED",
          },
        }));
        return {
          authority_sha256: authorityDigest,
          raw_body: rawBody,
          signing_secret: secret,
          state_root: stateRoot,
          x_signature: createHmac("sha256", secret).update(rawBody).digest("hex"),
        };
      };
      await expect(verifyAndRecordLuminSignV1Webhook(build("first"), {
        nowMs: NOW_MS + 3_000,
      })).resolves.toMatchObject({ event_type: "signature_request_approved" });
      await expect(verifyAndRecordLuminSignV1Webhook(build("conflicting duplicate"), {
        nowMs: NOW_MS + 4_000,
      })).rejects.toMatchObject({ code: "LUMIN_WEBHOOK_REJECTED" });
    });
  });

  it.each([
    ["wrong HMAC", value => { value.x_signature = "f".repeat(64); }],
    ["wrong request", value => {
      const parsed = JSON.parse(value.raw_body.toString("utf8"));
      parsed.signature_request.signature_request_id = "sigreq.other";
      value.raw_body = Buffer.from(JSON.stringify(parsed));
      value.x_signature = createHmac("sha256", value.signing_secret).update(value.raw_body).digest("hex");
    }],
    ["duplicate member", value => {
      value.raw_body = Buffer.from('{"event":{"event_time":1893456032000,"event_type":"signature_request_approved"},"signature_request":{"signature_request_id":"wrong","signature_request_id":"sigreq.synthetic-123","status":"APPROVED"}}');
      value.x_signature = createHmac("sha256", value.signing_secret).update(value.raw_body).digest("hex");
    }],
  ])("rejects %s webhook evidence without durable observation", async (_label, mutate) => {
    await withLifecycleState(async ({ stateRoot }) => {
      const { authoritySha256: authorityDigest } = await createDurableOperation(stateRoot);
      const signingSecret = Buffer.from("synthetic-app-signing-secret");
      const rawBody = Buffer.from(JSON.stringify({
        event: { event_time: NOW_MS + 2_000, event_type: "signature_request_approved" },
        signature_request: { signature_request_id: "sigreq.synthetic-123", status: "APPROVED" },
      }));
      const value = {
        authority_sha256: authorityDigest,
        raw_body: rawBody,
        signing_secret: signingSecret,
        state_root: stateRoot,
        x_signature: createHmac("sha256", signingSecret).update(rawBody).digest("hex"),
      };
      mutate(value);
      await expect(verifyAndRecordLuminSignV1Webhook(value, {
        nowMs: NOW_MS + 3_000,
      })).rejects.toMatchObject({ code: "LUMIN_WEBHOOK_REJECTED" });
    });
  });
});
