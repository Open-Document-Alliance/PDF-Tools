import { createHash } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import {
  LUMIN_SIGNING_DISCLOSURE,
  LUMIN_SIGNING_TOOL_DEFINITIONS,
  createLuminSigningToolHandler,
  formatLuminSigningToolText,
} from "../server/lumin-signing-tools.js";
import { validateStructuredToolResult } from "../server/output-schemas.js";
import { LUMIN_SIGN_V1_DIRECT_UPLOAD_CONFIRMATION } from "../server/lumin-sign-v1-transport.js";

const NOW_MS = Date.parse("2030-01-01T00:00:30.000Z");
const PDF_BYTES = Buffer.from("%PDF-1.7\n%%EOF\n", "ascii");
const PDF_SHA256 = createHash("sha256").update(PDF_BYTES).digest("hex");
const PDF_PATH = "/synthetic/prepared.pdf";
const STATE_ROOT = "/synthetic/private-state";
const ACCESS_TOKEN = "access-token-that-must-never-escape";
const SIGNED_URL = "https://download.example/agreement.pdf?secret=must-never-escape";

function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
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
      canonical_path: PDF_PATH,
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

function prepareInput(overrides = {}) {
  return {
    pdf_path: PDF_PATH,
    preparation_receipt: preparationReceipt(),
    authorization_session_id: "authorization.session",
    title: "Synthetic signing request",
    expires_at: "2030-01-02T00:00:00.000Z",
    signers: [{
      participant_id: "signer.client",
      name: "Client Signer",
      email_address: "client@example.com",
    }],
    viewers: [{
      participant_id: "viewer.audit",
      name: "Audit Viewer",
      email_address: "audit@example.com",
    }],
    ...overrides,
  };
}

function workflow(overrides = {}) {
  const ids = ["authorization.session", "preparation.request"];
  const createOAuthSession = vi.fn(async () => ({
    authorizationUrl: "https://auth.luminpdf.com/oauth2/auth?opaque=one",
    waitForCallback: vi.fn(async () => ({ code: "one-time", redirectUri: "http://127.0.0.1:12345/callback" })),
    exchangeToken: vi.fn(async () => ({
      accessToken: ACCESS_TOKEN,
      refreshToken: "refresh-token-that-must-never-escape",
      expiresIn: 3600,
      scope: "openid profile.read sign:requests sign:requests.read",
      tokenType: "Bearer",
    })),
    close: vi.fn(async () => {}),
  }));
  const dependencies = {
    clientId: "public-client-id",
    stateRoot: STATE_ROOT,
    readPreparedPdf: vi.fn(async () => ({ canonicalPath: PDF_PATH, bytes: Buffer.from(PDF_BYTES) })),
    resolveOutputPath: vi.fn(value => value),
    downloadSignedPdf: vi.fn(async ({ outputPath }) => ({
      canonicalPath: outputPath,
      bytes: PDF_BYTES.length,
      sha256: PDF_SHA256,
    })),
    createOAuthSession,
    openExternal: vi.fn(async () => {}),
    executeCreate: vi.fn(async input => ({
      result: {
        response: {
          signature_request_id: "sigreq.synthetic-123",
          status: "WAITING_FOR_PROCESSING",
          created_at: 1_893_456_030,
        },
      },
      operation: { operation_status: "request_created" },
      receivedToken: input.access_token,
    })),
    pollStatus: vi.fn(async () => ({
      authority_sha256: "a".repeat(64),
      signature_request_id: "sigreq.synthetic-123",
      status: "APPROVED",
      observed_at: new Date(NOW_MS).toISOString(),
      observation_sha256: "b".repeat(64),
    })),
    requestArtifact: vi.fn(async () => ({
      file_type: "agreement",
      signed_url: SIGNED_URL,
      expires_at: Math.floor(NOW_MS / 1000) + 600,
      observation: { observation_sha256: "c".repeat(64) },
    })),
    fetchImpl: vi.fn(),
    now: () => NOW_MS,
    idFactory: () => ids.shift(),
    ...overrides,
  };
  return { dependencies, handle: createLuminSigningToolHandler(dependencies) };
}

async function connect(handle) {
  const started = await handle("start_lumin_authorization", {});
  const connected = await handle("finish_lumin_authorization", {
    authorization_session_id: started.authorization_session_id,
  });
  return connected.authorization_session_id;
}

function expectValidStructuredOutput(toolName, structuredContent) {
  const result = {
    content: [{ type: "text", text: `${toolName} completed` }],
    structuredContent,
  };
  expect(validateStructuredToolResult(toolName, result)).toBe(result);
}

describe("public Lumin signing workflow", () => {
  it("exposes a complete, explicitly annotated public workflow", () => {
    expect(LUMIN_SIGNING_TOOL_DEFINITIONS.map(tool => tool.name)).toEqual([
      "start_lumin_authorization",
      "finish_lumin_authorization",
      "prepare_lumin_request",
      "send_lumin_request",
      "check_lumin_status",
      "download_lumin_artifact",
    ]);
    expect(LUMIN_SIGNING_TOOL_DEFINITIONS.find(tool => tool.name === "send_lumin_request")?.annotations)
      .toEqual({
        title: "Send Lumin Signing Request",
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: false,
        openWorldHint: true,
      });
    expect(LUMIN_SIGNING_TOOL_DEFINITIONS.find(tool => tool.name === "prepare_lumin_request")?.annotations)
      .toEqual({
        title: "Prepare Lumin Signing Request",
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: false,
      });
  });

  it("starts and completes PKCE without returning or persisting credentials", async () => {
    const { dependencies, handle } = workflow();
    const started = await handle("start_lumin_authorization", {});
    expect(dependencies.createOAuthSession).toHaveBeenCalledWith({
      clientId: "public-client-id",
      scopes: ["openid", "profile.read", "sign:requests", "sign:requests.read"],
      timeoutMs: 300_000,
    });
    expect(dependencies.openExternal).toHaveBeenCalledWith("https://auth.luminpdf.com/oauth2/auth?opaque=one");
    expect(JSON.stringify(started)).not.toContain("auth.luminpdf.com");
    expect(started.next_step).toContain("create one on Lumin's website");
    expect(started.next_step).toContain("Never paste passwords");
    expect(formatLuminSigningToolText("start_lumin_authorization", started)).toContain(started.next_step);
    expect(formatLuminSigningToolText("start_lumin_authorization", started)).not.toContain(started.authorization_session_id);
    expectValidStructuredOutput("start_lumin_authorization", started);
    const completed = await handle("finish_lumin_authorization", {
      authorization_session_id: started.authorization_session_id,
    });
    expect(completed).toMatchObject({
      status: "connected",
      authorization_session_id: "authorization.session",
      access_token_persisted: false,
      refresh_token_persisted: false,
      pdf_sent: false,
    });
    expect(JSON.stringify(completed)).not.toContain("token-that-must-never-escape");
    expect(completed.next_step).toContain("no PDF or signing request has been sent");
    expect(completed.next_step).toContain("check_lumin_status");
    expect(formatLuminSigningToolText("finish_lumin_authorization", completed)).toContain(completed.next_step);
    expect(formatLuminSigningToolText("finish_lumin_authorization", completed)).not.toContain(ACCESS_TOKEN);
    expect(dependencies.executeCreate).not.toHaveBeenCalled();
    expect(dependencies.readPreparedPdf).not.toHaveBeenCalled();
    expectValidStructuredOutput("finish_lumin_authorization", completed);
  });

  it("refuses an unconfigured client before creating a callback or opening a browser", async () => {
    const { dependencies, handle } = workflow({ clientId: null });
    await expect(handle("start_lumin_authorization", {})).rejects.toMatchObject({
      code: "LUMIN_OAUTH_NOT_CONFIGURED",
      message: expect.stringContaining("Creating a personal Lumin account will not fix"),
    });
    expect(dependencies.createOAuthSession).not.toHaveBeenCalled();
    expect(dependencies.openExternal).not.toHaveBeenCalled();
    expect(dependencies.fetchImpl).not.toHaveBeenCalled();
    expect(dependencies.executeCreate).not.toHaveBeenCalled();
  });

  it("rejects account credentials and signup parameters without starting authorization", async () => {
    const { dependencies, handle } = workflow();
    for (const args of [{ password: "do-not-send" }, { email: "user@example.test" }, { signup: true }]) {
      await expect(handle("start_lumin_authorization", args)).rejects.toMatchObject({ code: "LUMIN_WORKFLOW_INPUT_INVALID" });
    }
    expect(dependencies.createOAuthSession).not.toHaveBeenCalled();
    expect(dependencies.openExternal).not.toHaveBeenCalled();
    expect(dependencies.fetchImpl).not.toHaveBeenCalled();
  });

  it("preserves non-connection text without appending unrelated provider fields", () => {
    const extra = { next_step: ACCESS_TOKEN };
    expect(formatLuminSigningToolText("prepare_lumin_request", extra))
      .toBe("Prepared the Lumin signing request locally. Nothing was sent.");
    expect(formatLuminSigningToolText("send_lumin_request", { ...extra, signature_request_id: "request.1" }))
      .toBe("Created Lumin signing request request.1.");
    expect(formatLuminSigningToolText("check_lumin_status", { ...extra, provider_status: "APPROVED" }))
      .toBe("Lumin signing status: APPROVED.");
    expect(formatLuminSigningToolText("download_lumin_artifact", { ...extra, file_type: "agreement", pdf_path: "/synthetic/result.pdf" }))
      .toBe("Downloaded the Lumin agreement PDF to /synthetic/result.pdf.");
  });

  it("closes an expired signup connection before advising a fresh browser attempt", async () => {
    let nowMs = NOW_MS;
    const { dependencies, handle } = workflow({ now: () => nowMs });
    const started = await handle("start_lumin_authorization", {});
    const session = await dependencies.createOAuthSession.mock.results[0].value;
    nowMs += 300_000;
    await expect(handle("finish_lumin_authorization", { authorization_session_id: started.authorization_session_id }))
      .rejects.toMatchObject({ code: "LUMIN_AUTHORIZATION_SESSION_INVALID", message: expect.stringContaining("new session ID") });
    expect(session.close).toHaveBeenCalledOnce();
    expect(session.exchangeToken).not.toHaveBeenCalled();
    expect(dependencies.executeCreate).not.toHaveBeenCalled();
    const fresh = await handle("start_lumin_authorization", {});
    expect(fresh.authorization_session_id).not.toBe(started.authorization_session_id);
    expect(fresh.pdf_sent).toBe(false);
  });

  it("allows a new connection after cancellation without replaying the old session or leaking provider text", async () => {
    const { dependencies, handle } = workflow();
    const started = await handle("start_lumin_authorization", {});
    const session = await dependencies.createOAuthSession.mock.results[0].value;
    session.waitForCallback.mockRejectedValue(Object.assign(new Error(ACCESS_TOKEN), { code: "LUMIN_OAUTH_PROVIDER_ERROR" }));
    await expect(handle("finish_lumin_authorization", { authorization_session_id: started.authorization_session_id }))
      .rejects.toMatchObject({ code: "LUMIN_OAUTH_PROVIDER_ERROR", message: expect.stringContaining("leave it disconnected") });
    expect(session.close).toHaveBeenCalledOnce();
    expect(session.exchangeToken).not.toHaveBeenCalled();
    await expect(handle("finish_lumin_authorization", { authorization_session_id: started.authorization_session_id }))
      .rejects.toMatchObject({ code: "LUMIN_AUTHORIZATION_SESSION_INVALID" });
    const fresh = await handle("start_lumin_authorization", {});
    const connected = await handle("finish_lumin_authorization", { authorization_session_id: fresh.authorization_session_id });
    expect(connected.status).toBe("connected");
    expect(JSON.stringify(connected)).not.toContain(ACCESS_TOKEN);
    expect(dependencies.executeCreate).not.toHaveBeenCalled();
    expect(dependencies.fetchImpl).not.toHaveBeenCalled();
  });

  it("explains reconnecting an expired token without resending an existing request", async () => {
    let nowMs = NOW_MS;
    const { dependencies, handle } = workflow({ now: () => nowMs });
    await connect(handle);
    nowMs += 3_600_000;
    await expect(handle("check_lumin_status", { authority_sha256: "a".repeat(64), authorization_session_id: "authorization.session" }))
      .rejects.toMatchObject({ code: "LUMIN_AUTHORIZATION_REQUIRED", message: expect.stringContaining("not send_lumin_request") });
    expect(dependencies.pollStatus).not.toHaveBeenCalled();
    expect(dependencies.executeCreate).not.toHaveBeenCalled();
  });

  it("closes the callback and gives safe recovery when a browser cannot be opened", async () => {
    const { dependencies, handle } = workflow({ openExternal: vi.fn(async () => { throw new Error(ACCESS_TOKEN); }) });
    await expect(handle("start_lumin_authorization", {})).rejects.toMatchObject({
      code: "LUMIN_BROWSER_OPEN_FAILED", message: expect.stringContaining("Check your default browser"),
    });
    const session = await dependencies.createOAuthSession.mock.results[0].value;
    expect(session.close).toHaveBeenCalledOnce();
    expect(session.exchangeToken).not.toHaveBeenCalled();
    expect(dependencies.executeCreate).not.toHaveBeenCalled();
  });

  it("sanitizes authorization startup failures", async () => {
    const { handle } = workflow({
      createOAuthSession: vi.fn(async () => {
        const error = new Error(`callback failed with ${ACCESS_TOKEN}`);
        error.code = "LUMIN_OAUTH_CALLBACK_UNAVAILABLE";
        throw error;
      }),
    });
    const attempt = handle("start_lumin_authorization", {});
    await expect(attempt).rejects.toMatchObject({ code: "LUMIN_OAUTH_CALLBACK_UNAVAILABLE" });
    await expect(attempt).rejects.not.toThrow(ACCESS_TOKEN);
  });

  it("fails closed on Windows before opening OAuth or durable signing state", async () => {
    const { dependencies, handle } = workflow({ platform: "win32" });
    await expect(handle("start_lumin_authorization", {})).rejects.toMatchObject({
      code: "LUMIN_SIGNING_PLATFORM_UNSUPPORTED",
    });
    expect(dependencies.createOAuthSession).not.toHaveBeenCalled();
    expect(dependencies.openExternal).not.toHaveBeenCalled();
    expect(dependencies.executeCreate).not.toHaveBeenCalled();
  });

  it("prunes expired unfinished OAuth sessions before applying the pending limit", async () => {
    let observedNow = NOW_MS;
    let sequence = 0;
    const closed = [];
    const { handle } = workflow({
      now: () => observedNow,
      idFactory: () => `authorization.session.${sequence += 1}`,
      createOAuthSession: vi.fn(async () => ({
        authorizationUrl: "https://auth.luminpdf.com/oauth2/auth?opaque=one",
        waitForCallback: vi.fn(() => new Promise(() => {})),
        exchangeToken: vi.fn(),
        close: vi.fn(async () => closed.push(true)),
      })),
    });
    for (let index = 0; index < 8; index += 1) {
      await handle("start_lumin_authorization", {});
    }
    observedNow += 300_001;
    await expect(handle("start_lumin_authorization", {})).resolves.toMatchObject({
      authorization_session_id: "authorization.session.9",
    });
    expect(closed).toHaveLength(8);
  });

  it("bounds each finish call without discarding a callback that is still pending", async () => {
    let resolveCallback;
    const callbackPromise = new Promise(resolve => {
      resolveCallback = resolve;
    });
    const session = {
      authorizationUrl: "https://auth.luminpdf.com/oauth2/auth?opaque=one",
      waitForCallback: vi.fn(() => callbackPromise),
      exchangeToken: vi.fn(async () => ({
        accessToken: ACCESS_TOKEN,
        refreshToken: null,
        expiresIn: 3600,
      })),
      close: vi.fn(async () => {}),
    };
    const { handle } = workflow({
      authorizationCompletionWaitMs: 1,
      createOAuthSession: vi.fn(async () => session),
    });
    const started = await handle("start_lumin_authorization", {});
    await expect(handle("finish_lumin_authorization", {
      authorization_session_id: started.authorization_session_id,
    })).rejects.toMatchObject({ code: "LUMIN_AUTHORIZATION_PENDING" });
    resolveCallback({ code: "one-time", redirectUri: "http://127.0.0.1:12345/callback" });
    await expect(handle("finish_lumin_authorization", {
      authorization_session_id: started.authorization_session_id,
    })).resolves.toMatchObject({ status: "connected" });
    expect(session.exchangeToken).toHaveBeenCalledTimes(1);
  });

  it("prepares locally and binds the exact PDF, receipt, recipients, disclosure, and confirmation", async () => {
    const { dependencies, handle } = workflow();
    await connect(handle);
    const prepared = await handle("prepare_lumin_request", prepareInput());
    expect(prepared).toMatchObject({
      status: "ready_for_user_confirmation",
      request_preparation_id: "preparation.request",
      authorization_session_id: "authorization.session",
      disclosure: LUMIN_SIGNING_DISCLOSURE,
      confirmation_statement_required: LUMIN_SIGN_V1_DIRECT_UPLOAD_CONFIRMATION,
      prepared_document: { canonical_path: PDF_PATH, sha256: PDF_SHA256 },
      provider_contacted: false,
      pdf_sent: false,
    });
    expect(prepared.signers).toEqual(prepareInput().signers);
    expect(dependencies.executeCreate).not.toHaveBeenCalled();
    expect(dependencies.fetchImpl).not.toHaveBeenCalled();
    expectValidStructuredOutput("prepare_lumin_request", prepared);
  });

  it("rejects a changed PDF or receipt before preparing a send", async () => {
    const changed = workflow({
      readPreparedPdf: vi.fn(async () => ({ canonicalPath: PDF_PATH, bytes: Buffer.from("%PDF-changed", "ascii") })),
    });
    await connect(changed.handle);
    await expect(changed.handle("prepare_lumin_request", prepareInput())).rejects.toMatchObject({
      code: "LUMIN_PREPARED_PDF_CHANGED",
    });

    const drifted = preparationReceipt();
    drifted.handoff_status = "needs_input";
    const { handle } = workflow();
    await connect(handle);
    await expect(handle("prepare_lumin_request", prepareInput({ preparation_receipt: drifted })))
      .rejects.toMatchObject({ code: "LUMIN_PREPARATION_NOT_READY" });
  });

  it("rejects signer zones that are not bound to the proposed Lumin signers", async () => {
    const receipt = preparationReceipt();
    receipt.zones[0].participant_binding.participant_id = "signer.someone-else";
    const unsigned = { ...receipt };
    delete unsigned.receipt_sha256;
    receipt.receipt_sha256 = createHash("sha256")
      .update(`pdf-tools.signing-preparation-receipt.v1\0${canonicalJson(unsigned)}`)
      .digest("hex");
    const { dependencies, handle } = workflow();
    await connect(handle);
    await expect(handle("prepare_lumin_request", prepareInput({ preparation_receipt: receipt })))
      .rejects.toMatchObject({ code: "LUMIN_PREPARATION_NOT_PROVIDER_READY" });
    expect(dependencies.executeCreate).not.toHaveBeenCalled();
  });

  it("requires an exact fresh user confirmation before the sole create attempt", async () => {
    const { dependencies, handle } = workflow();
    const authorizationId = await connect(handle);
    const prepared = await handle("prepare_lumin_request", prepareInput());
    const input = {
      request_preparation_id: prepared.request_preparation_id,
      authorization_session_id: authorizationId,
      confirmation_sha256: prepared.confirmation_sha256,
      confirmation_statement: LUMIN_SIGN_V1_DIRECT_UPLOAD_CONFIRMATION,
      user_confirmed_at: new Date(NOW_MS).toISOString(),
    };
    await expect(handle("send_lumin_request", {
      ...input,
      authorization_session_id: "another.session",
    })).rejects.toMatchObject({ code: "LUMIN_AUTHORIZATION_SESSION_CHANGED" });
    await expect(handle("send_lumin_request", {
      ...input,
      confirmation_statement: "Yes, send it",
    })).rejects.toMatchObject({ code: "LUMIN_USER_CONFIRMATION_INVALID" });
    expect(dependencies.executeCreate).not.toHaveBeenCalled();

    const result = await handle("send_lumin_request", input);
    expect(result).toMatchObject({
      status: "request_created",
      signature_request_id: "sigreq.synthetic-123",
      attempt_count: 1,
      automatic_retry_performed: false,
      create_retry_allowed: false,
      access_token_persisted: false,
    });
    expect(result.authority_sha256).toMatch(/^[a-f0-9]{64}$/);
    expect(dependencies.executeCreate).toHaveBeenCalledTimes(1);
    const [createInput, createOptions] = dependencies.executeCreate.mock.calls[0];
    expect(createInput.access_token).toBe(ACCESS_TOKEN);
    expect(createInput.execution_authority).toMatchObject({
      confirmation: LUMIN_SIGN_V1_DIRECT_UPLOAD_CONFIRMATION,
      automatic_retry_allowed: false,
    });
    expect(createOptions).toMatchObject({ stateRoot: STATE_ROOT, nowMs: NOW_MS });
    expect(JSON.stringify(result)).not.toContain(ACCESS_TOKEN);
    expectValidStructuredOutput("send_lumin_request", result);
  });

  it("rejects stale confirmation without touching the provider", async () => {
    const { dependencies, handle } = workflow();
    const authorizationId = await connect(handle);
    const prepared = await handle("prepare_lumin_request", prepareInput());
    await expect(handle("send_lumin_request", {
      request_preparation_id: prepared.request_preparation_id,
      authorization_session_id: authorizationId,
      confirmation_sha256: prepared.confirmation_sha256,
      confirmation_statement: LUMIN_SIGN_V1_DIRECT_UPLOAD_CONFIRMATION,
      user_confirmed_at: new Date(NOW_MS - 600_000).toISOString(),
    })).rejects.toMatchObject({ code: "LUMIN_USER_CONFIRMATION_EXPIRED" });
    expect(dependencies.executeCreate).not.toHaveBeenCalled();
  });

  it("consumes the confirmation before an ambiguous create failure", async () => {
    const { dependencies, handle } = workflow({
      executeCreate: vi.fn(async () => {
        const error = new Error(`LUMIN_CREATE_OUTCOME_UNKNOWN: ${ACCESS_TOKEN}`);
        error.code = "LUMIN_CREATE_OUTCOME_UNKNOWN";
        throw error;
      }),
    });
    const authorizationId = await connect(handle);
    const prepared = await handle("prepare_lumin_request", prepareInput());
    const input = {
      request_preparation_id: prepared.request_preparation_id,
      authorization_session_id: authorizationId,
      confirmation_sha256: prepared.confirmation_sha256,
      confirmation_statement: LUMIN_SIGN_V1_DIRECT_UPLOAD_CONFIRMATION,
      user_confirmed_at: new Date(NOW_MS).toISOString(),
    };
    const firstAttempt = handle("send_lumin_request", input);
    await expect(firstAttempt).rejects.toMatchObject({ code: "LUMIN_CREATE_OUTCOME_UNKNOWN" });
    await expect(firstAttempt).rejects.not.toThrow(ACCESS_TOKEN);
    await expect(handle("send_lumin_request", input)).rejects.toMatchObject({
      code: "LUMIN_REQUEST_PREPARATION_EXPIRED",
    });
    expect(dependencies.executeCreate).toHaveBeenCalledTimes(1);
  });

  it("consumes a confirmation before the first await so concurrent sends cannot both run", async () => {
    let readCount = 0;
    let releaseSecondRead;
    const secondRead = new Promise(resolve => {
      releaseSecondRead = resolve;
    });
    const { dependencies, handle } = workflow({
      readPreparedPdf: vi.fn(async () => {
        readCount += 1;
        if (readCount === 2) await secondRead;
        return { canonicalPath: PDF_PATH, bytes: Buffer.from(PDF_BYTES) };
      }),
    });
    const authorizationId = await connect(handle);
    const prepared = await handle("prepare_lumin_request", prepareInput());
    const input = {
      request_preparation_id: prepared.request_preparation_id,
      authorization_session_id: authorizationId,
      confirmation_sha256: prepared.confirmation_sha256,
      confirmation_statement: LUMIN_SIGN_V1_DIRECT_UPLOAD_CONFIRMATION,
      user_confirmed_at: new Date(NOW_MS).toISOString(),
    };
    const first = handle("send_lumin_request", input);
    await vi.waitFor(() => expect(readCount).toBe(2));
    await expect(handle("send_lumin_request", input)).rejects.toMatchObject({
      code: "LUMIN_REQUEST_PREPARATION_EXPIRED",
    });
    releaseSecondRead();
    await expect(first).resolves.toMatchObject({ status: "request_created" });
    expect(dependencies.executeCreate).toHaveBeenCalledTimes(1);
  });

  it("polls an existing request without exposing the token or authorizing create retry", async () => {
    const { dependencies, handle } = workflow();
    const authorizationId = await connect(handle);
    const result = await handle("check_lumin_status", {
      authority_sha256: "a".repeat(64),
      authorization_session_id: authorizationId,
    });
    expect(result).toMatchObject({
      status: "observed",
      provider_status: "APPROVED",
      read_retry_safe: true,
      create_retry_allowed: false,
      access_token_persisted: false,
    });
    expect(dependencies.pollStatus).toHaveBeenCalledWith({
      access_token: ACCESS_TOKEN,
      authority_sha256: "a".repeat(64),
      state_root: STATE_ROOT,
    }, expect.objectContaining({ nowMs: NOW_MS }));
    expect(JSON.stringify(result)).not.toContain(ACCESS_TOKEN);
    expectValidStructuredOutput("check_lumin_status", result);
  });

  it("consumes a signed artifact URL internally and returns only a local PDF identity", async () => {
    const { dependencies, handle } = workflow();
    const authorizationId = await connect(handle);
    const result = await handle("download_lumin_artifact", {
      authority_sha256: "a".repeat(64),
      authorization_session_id: authorizationId,
      file_type: "agreement",
      output_path: "/synthetic/downloads/agreement.pdf",
    });
    expect(dependencies.downloadSignedPdf).toHaveBeenCalledWith({
      signedUrl: SIGNED_URL,
      outputPath: "/synthetic/downloads/agreement.pdf",
    });
    expect(result).toMatchObject({
      status: "downloaded",
      pdf_path: "/synthetic/downloads/agreement.pdf",
      sha256: PDF_SHA256,
      access_url_persisted: false,
      access_url_returned: false,
      access_token_persisted: false,
      create_retry_allowed: false,
    });
    expect(JSON.stringify(result)).not.toContain("must-never-escape");
    expectValidStructuredOutput("download_lumin_artifact", result);
  });

  it("sanitizes signed URL failures", async () => {
    const { handle } = workflow({
      downloadSignedPdf: vi.fn(async ({ signedUrl }) => {
        throw new Error(`failed ${signedUrl}`);
      }),
    });
    const authorizationId = await connect(handle);
    await expect(handle("download_lumin_artifact", {
      authority_sha256: "a".repeat(64),
      authorization_session_id: authorizationId,
      file_type: "agreement",
      output_path: "/synthetic/downloads/agreement.pdf",
    })).rejects.toMatchObject({
      code: "LUMIN_ARTIFACT_DOWNLOAD_FAILED",
      message: expect.not.stringContaining("must-never-escape"),
    });
  });

  it("sanitizes a URL-bearing Lumin artifact error while preserving its code", async () => {
    const { handle } = workflow({
      requestArtifact: vi.fn(async () => {
        const error = new Error(`LUMIN_ARTIFACT_OBSERVATION_RETRYABLE: ${SIGNED_URL}`);
        error.code = "LUMIN_ARTIFACT_OBSERVATION_RETRYABLE";
        throw error;
      }),
    });
    const authorizationId = await connect(handle);
    const attempt = handle("download_lumin_artifact", {
      authority_sha256: "a".repeat(64),
      authorization_session_id: authorizationId,
      file_type: "agreement",
      output_path: "/synthetic/downloads/agreement.pdf",
    });
    await expect(attempt).rejects.toMatchObject({ code: "LUMIN_ARTIFACT_OBSERVATION_RETRYABLE" });
    await expect(attempt).rejects.not.toThrow("must-never-escape");
  });
});
