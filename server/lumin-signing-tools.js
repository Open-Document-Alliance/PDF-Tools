import { createHash, randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import path from "node:path";
import { platform as osPlatform } from "node:os";
import { types as utilTypes } from "node:util";
import { createLuminOAuthLoopbackSession } from "./lumin-oauth-loopback.js";
import {
  LUMIN_SIGN_V1_MAPPER_CONTRACT_SHA256,
  mapLuminSignV1SignatureRequest,
} from "./lumin-sign-v1-mapper.js";
import {
  executeDurableLuminSignV1DirectUpload,
  pollAndRecordLuminSignV1Status,
  requestAndRecordLuminSignV1ArtifactAccess,
} from "./lumin-sign-v1-operation.js";
import {
  LUMIN_SIGN_V1_DIRECT_UPLOAD_CONFIRMATION,
  validateLuminSignV1DirectUploadPreparation,
} from "./lumin-sign-v1-transport.js";

const SHA256_PATTERN = /^[a-f0-9]{64}$/;
const IDENTIFIER_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const AUTHORIZATION_SCOPES = Object.freeze([
  "openid",
  "profile.read",
  "sign:requests",
  "sign:requests.read",
]);
const MAX_PENDING_AUTHORIZATIONS = 8;
const MAX_CONNECTIONS = 8;
const MAX_PREPARATIONS = 64;
const MAX_PREPARATION_RECEIPT_BYTES = 4 * 1024 * 1024;
const AUTHORIZATION_TIMEOUT_MS = 5 * 60 * 1000;
const AUTHORIZATION_COMPLETION_WAIT_MS = 45 * 1000;
const REQUEST_PREPARATION_LIFETIME_MS = 30 * 60 * 1000;
const USER_CONFIRMATION_LIFETIME_MS = 10 * 60 * 1000;
const EXECUTION_AUTHORITY_LIFETIME_MS = 10 * 60 * 1000;

export const LUMIN_SIGNING_DISCLOSURE =
  "The prepared PDF and the listed signer and viewer names and email addresses will leave this device and be handled by Lumin.";

export const LUMIN_SIGNING_TOOL_NAMES = Object.freeze([
  "start_lumin_authorization",
  "finish_lumin_authorization",
  "prepare_lumin_request",
  "send_lumin_request",
  "check_lumin_status",
  "download_lumin_artifact",
]);

export const LUMIN_SIGNING_TOOL_DEFINITIONS = Object.freeze([
  {
    name: "start_lumin_authorization",
    description:
      "Connect a Lumin account through secure browser login using OAuth PKCE. Follow the returned next_step instructions. Account creation and passwords belong on Lumin's website, never in tool arguments or chat. If this installation is not configured, ask its maintainer to enable the integration rather than asking the user to create a developer app. This does not send a PDF or create a signing request. Call finish_lumin_authorization after the user finishes in the browser.",
    inputSchema: {
      type: "object",
      properties: {},
      additionalProperties: false,
    },
    annotations: {
      title: "Connect Lumin Account",
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: false,
      openWorldHint: true,
    },
  },
  {
    name: "finish_lumin_authorization",
    description:
      "Finish a browser login started by start_lumin_authorization. The Lumin access token is held only in this running PDF Tools process and is never returned, logged, or written to disk. Restarting PDF Tools requires connecting again.",
    inputSchema: {
      type: "object",
      properties: {
        authorization_session_id: {
          type: "string",
          description: "Opaque session ID returned by start_lumin_authorization.",
        },
      },
      required: ["authorization_session_id"],
      additionalProperties: false,
    },
    annotations: {
      title: "Finish Lumin Connection",
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: false,
      openWorldHint: true,
    },
  },
  {
    name: "prepare_lumin_request",
    description:
      "Prepare and preview a Lumin signing request locally. Requires a provider-ready receipt from prepare_signing_packet. This validates the exact prepared PDF, recipients, and expiry, then returns the disclosure and exact confirmation text required for sending. It does not contact Lumin or send anything.",
    inputSchema: {
      type: "object",
      properties: {
        pdf_path: { type: "string", description: "Exact prepared PDF path returned by prepare_signing_packet." },
        preparation_receipt: { type: "object", description: "Exact preparation_receipt returned by prepare_signing_packet." },
        authorization_session_id: { type: "string", description: "Connected Lumin session returned by finish_lumin_authorization. The prepared confirmation is bound to this session." },
        title: { type: "string", maxLength: 255, description: "Title recipients will see in Lumin." },
        expires_at: { type: "string", format: "date-time", description: "ISO-8601 time after which the Lumin request expires." },
        signers: {
          type: "array",
          minItems: 1,
          maxItems: 100,
          items: {
            type: "object",
            properties: {
              participant_id: { type: "string", pattern: "^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$" },
              name: { type: "string", maxLength: 255 },
              email_address: { type: "string", maxLength: 320 },
            },
            required: ["participant_id", "name", "email_address"],
            additionalProperties: false,
          },
        },
        viewers: {
          type: "array",
          maxItems: 100,
          items: {
            type: "object",
            properties: {
              participant_id: { type: "string", pattern: "^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$" },
              name: { type: "string", maxLength: 255 },
              email_address: { type: "string", maxLength: 320 },
            },
            required: ["participant_id", "name", "email_address"],
            additionalProperties: false,
          },
        },
      },
      required: ["pdf_path", "preparation_receipt", "authorization_session_id", "title", "expires_at", "signers"],
      additionalProperties: false,
    },
    annotations: {
      title: "Prepare Lumin Signing Request",
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: false,
      openWorldHint: false,
    },
  },
  {
    name: "send_lumin_request",
    description:
      "NEVER FABRICATE confirmation_statement OR user_confirmed_at. Ask the user to confirm the exact disclosure returned by prepare_lumin_request, then pass their exact confirmation text and timestamp. This makes one nonretryable provider request that uploads the prepared PDF to Lumin and emails the listed signers. An ambiguous outcome remains consumed and is never automatically retried.",
    inputSchema: {
      type: "object",
      properties: {
        request_preparation_id: { type: "string", description: "Opaque preparation ID returned by prepare_lumin_request." },
        authorization_session_id: { type: "string", description: "Connected session ID returned by finish_lumin_authorization." },
        confirmation_sha256: { type: "string", pattern: "^[a-f0-9]{64}$", description: "Exact confirmation digest returned by prepare_lumin_request." },
        confirmation_statement: { type: "string", description: "The user's verbatim confirmation_statement_required value. Never invent or paraphrase it." },
        user_confirmed_at: { type: "string", format: "date-time", description: "When the user personally confirmed, within the last 10 minutes." },
      },
      required: ["request_preparation_id", "authorization_session_id", "confirmation_sha256", "confirmation_statement", "user_confirmed_at"],
      additionalProperties: false,
    },
    annotations: {
      title: "Send Lumin Signing Request",
      readOnlyHint: false,
      destructiveHint: true,
      idempotentHint: false,
      openWorldHint: true,
    },
  },
  {
    name: "check_lumin_status",
    description:
      "Check an existing Lumin signing request and retain a local, digest-bound status observation. This cannot create or retry a signing request. A failed read may be retried safely.",
    inputSchema: {
      type: "object",
      properties: {
        authority_sha256: { type: "string", pattern: "^[a-f0-9]{64}$" },
        authorization_session_id: { type: "string" },
      },
      required: ["authority_sha256", "authorization_session_id"],
      additionalProperties: false,
    },
    annotations: {
      title: "Check Lumin Signing Status",
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: true,
    },
  },
  {
    name: "download_lumin_artifact",
    description:
      "Download an existing Lumin signing artifact to an allowed local folder without overwriting a file. The temporary signed download URL is consumed internally and is never returned, logged, or persisted. This cannot create or retry a signing request.",
    inputSchema: {
      type: "object",
      properties: {
        authority_sha256: { type: "string", pattern: "^[a-f0-9]{64}$" },
        authorization_session_id: { type: "string" },
        file_type: { type: "string", enum: ["agreement", "coc", "merged"] },
        output_path: { type: "string", description: "Preferred local PDF path. Existing files are never replaced." },
      },
      required: ["authority_sha256", "authorization_session_id", "file_type", "output_path"],
      additionalProperties: false,
    },
    annotations: {
      title: "Download Lumin Signing Artifact",
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: false,
      openWorldHint: true,
    },
  },
]);

// Keep connection guidance in text as well as structuredContent for clients
// that primarily expose the text content of tool results to users/models.
export function formatLuminSigningToolText(name, result) {
  const summary = name === "start_lumin_authorization"
    ? "Opened Lumin authorization in the browser."
    : name === "finish_lumin_authorization"
      ? "Connected the Lumin account for this PDF Tools session."
      : name === "prepare_lumin_request"
        ? "Prepared the Lumin signing request locally. Nothing was sent."
        : name === "send_lumin_request"
          ? `Created Lumin signing request ${result.signature_request_id}.`
          : name === "check_lumin_status"
            ? `Lumin signing status: ${result.provider_status}.`
            : `Downloaded the Lumin ${result.file_type} PDF to ${result.pdf_path}.`;
  return (name === "start_lumin_authorization" || name === "finish_lumin_authorization")
    ? `${summary} ${result.next_step}`
    : summary;
}

function toolError(code, message) {
  const error = new Error(`${code}: ${message}`);
  error.code = code;
  return error;
}

function sanitizedDependencyError(error, fallbackCode, message) {
  const code = typeof error?.code === "string" && /^LUMIN_[A-Z0-9_]+$/.test(error.code)
    ? error.code
    : fallbackCode;
  return toolError(code, message);
}

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

function domainSha256(domain, value) {
  return createHash("sha256").update(`${domain}\0${canonicalJson(value)}`, "utf8").digest("hex");
}

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

function assertRecord(value, required, optional = []) {
  if (!value || typeof value !== "object" || Array.isArray(value) || utilTypes.isProxy(value)) {
    throw toolError("LUMIN_WORKFLOW_INPUT_INVALID", "The Lumin workflow input is invalid.");
  }
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) {
    throw toolError("LUMIN_WORKFLOW_INPUT_INVALID", "The Lumin workflow input is invalid.");
  }
  const keys = Reflect.ownKeys(value);
  const allowed = [...required, ...optional].sort();
  if (
    keys.some(key => typeof key !== "string")
    || keys.length < required.length
    || keys.length > allowed.length
    || keys.some(key => !allowed.includes(key))
    || required.some(key => !keys.includes(key))
  ) {
    throw toolError("LUMIN_WORKFLOW_INPUT_INVALID", "The Lumin workflow input is invalid.");
  }
  return value;
}

function assertString(value, name, { max = 4096, pattern = null } = {}) {
  if (
    typeof value !== "string"
    || value !== value.trim()
    || value.length < 1
    || value.length > max
    || (pattern && !pattern.test(value))
  ) throw toolError("LUMIN_WORKFLOW_INPUT_INVALID", `Invalid ${name}.`);
  return value;
}

function assertIsoTimestamp(value, name) {
  const timestamp = assertString(value, name, { max: 32 });
  const parsed = new Date(timestamp);
  if (Number.isNaN(parsed.getTime()) || parsed.toISOString() !== timestamp) {
    throw toolError("LUMIN_WORKFLOW_INPUT_INVALID", `Invalid ${name}.`);
  }
  return parsed.getTime();
}

function cloneJson(value) {
  return JSON.parse(JSON.stringify(value));
}

function arrayValues(value) {
  return Array.from({ length: value.length }, (_, index) => value[index]);
}

function validateParticipant(value) {
  const participant = assertRecord(value, ["email_address", "name", "participant_id"]);
  return {
    participant_id: assertString(participant.participant_id, "participant ID", { max: 128, pattern: IDENTIFIER_PATTERN }),
    name: assertString(participant.name, "participant name", { max: 255 }),
    email_address: assertString(participant.email_address, "participant email address", { max: 320, pattern: EMAIL_PATTERN }),
  };
}

function validateParticipantArray(value, { required }) {
  if (!Array.isArray(value) || value.length < (required ? 1 : 0) || value.length > 100) {
    throw toolError("LUMIN_WORKFLOW_INPUT_INVALID", "Invalid Lumin participants.");
  }
  const participants = value.map(validateParticipant);
  if (new Set(participants.map(participant => participant.participant_id)).size !== participants.length) {
    throw toolError("LUMIN_WORKFLOW_INPUT_INVALID", "Participant IDs must be unique.");
  }
  return participants;
}

function validatePreparationReceipt(value, preparedDocument) {
  const receipt = assertRecord(value, [
    "existing_signature_observation",
    "field_outcomes",
    "geometry_policy",
    "handoff_status",
    "limitations",
    "missing_inputs",
    "output_commit",
    "page_count",
    "pages",
    "preparation_engine",
    "prepared_document",
    "provider_execution_status",
    "receipt_sha256",
    "schema_version",
    "source_document",
    "source_preservation",
    "xfa_observation",
    "zones",
  ]);
  if (receipt.handoff_status !== "ready_for_provider_mapping" || receipt.provider_execution_status !== "not_requested") {
    throw toolError("LUMIN_PREPARATION_NOT_READY", "The signing packet is not ready for provider mapping.");
  }
  const receiptUnsigned = cloneJson(receipt);
  delete receiptUnsigned.receipt_sha256;
  const canonicalReceipt = canonicalJson(receiptUnsigned);
  if (Buffer.byteLength(canonicalReceipt, "utf8") > MAX_PREPARATION_RECEIPT_BYTES) {
    throw toolError("LUMIN_PREPARATION_RECEIPT_INVALID", "The signing preparation receipt is too large.");
  }
  const expectedReceiptSha256 = createHash("sha256")
    .update(`pdf-tools.signing-preparation-receipt.v1\0${canonicalReceipt}`, "utf8")
    .digest("hex");
  if (receipt.receipt_sha256 !== expectedReceiptSha256) {
    throw toolError("LUMIN_PREPARATION_RECEIPT_INVALID", "The signing preparation receipt does not match its contents.");
  }
  if (
    receipt.prepared_document?.canonical_path !== preparedDocument.canonicalPath
    || receipt.prepared_document?.size_bytes !== preparedDocument.bytes.length
    || receipt.prepared_document?.sha256 !== sha256(preparedDocument.bytes)
  ) {
    throw toolError("LUMIN_PREPARED_PDF_CHANGED", "The prepared PDF no longer matches its preparation receipt.");
  }
  return cloneJson(receipt);
}

function defaultOpenExternal(url, platform = osPlatform()) {
  let command;
  let args;
  if (platform === "darwin") {
    command = "open";
    args = [url];
  } else if (platform === "win32") {
    command = "rundll32.exe";
    args = ["url.dll,FileProtocolHandler", url];
  } else {
    command = "xdg-open";
    args = [url];
  }
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { detached: true, stdio: "ignore" });
    child.once("error", reject);
    child.once("spawn", () => {
      child.unref();
      resolve();
    });
  });
}

export function createLuminSigningToolHandler({
  clientId,
  stateRoot,
  readPreparedPdf,
  resolveOutputPath,
  downloadSignedPdf,
  createOAuthSession = createLuminOAuthLoopbackSession,
  openExternal = defaultOpenExternal,
  executeCreate = executeDurableLuminSignV1DirectUpload,
  pollStatus = pollAndRecordLuminSignV1Status,
  requestArtifact = requestAndRecordLuminSignV1ArtifactAccess,
  fetchImpl = globalThis.fetch,
  now = Date.now,
  idFactory = randomUUID,
  platform = osPlatform(),
  authorizationCompletionWaitMs = AUTHORIZATION_COMPLETION_WAIT_MS,
} = {}) {
  const pendingAuthorizations = new Map();
  const connections = new Map();
  const preparations = new Map();
  if (
    !Number.isSafeInteger(authorizationCompletionWaitMs)
    || authorizationCompletionWaitMs < 1
    || authorizationCompletionWaitMs > AUTHORIZATION_COMPLETION_WAIT_MS
  ) {
    throw toolError("LUMIN_WORKFLOW_CONFIGURATION_INVALID", "The Lumin authorization wait limit is invalid.");
  }

  function currentMs() {
    const value = now();
    if (!Number.isSafeInteger(value) || value < 0) throw toolError("LUMIN_WORKFLOW_CLOCK_INVALID", "The local clock is invalid.");
    return value;
  }

  function requireConfigured() {
    if (platform === "win32") {
      throw toolError(
        "LUMIN_SIGNING_PLATFORM_UNSUPPORTED",
        "Lumin signing is not available on Windows in this release.",
      );
    }
    if (typeof clientId !== "string" || !clientId || clientId.includes("${")) {
      throw toolError(
        "LUMIN_OAUTH_NOT_CONFIGURED",
        "Lumin signing is not enabled in this PDF Tools installation. Ask its maintainer to configure the public Lumin OAuth app. Creating a personal Lumin account will not fix this installation setting. Do not share a password, API key, or client secret in chat. Local PDF tools remain available.",
      );
    }
    if (typeof stateRoot !== "string" || !path.isAbsolute(stateRoot)) {
      throw toolError("LUMIN_STATE_NOT_CONFIGURED", "The private Lumin operation store is unavailable.");
    }
  }

  function requireConnection(sessionId) {
    const id = assertString(sessionId, "authorization session ID", { max: 128, pattern: IDENTIFIER_PATTERN });
    const connection = connections.get(id);
    if (!connection || connection.expiresAtMs <= currentMs() + 30_000) {
      connections.delete(id);
      throw toolError("LUMIN_AUTHORIZATION_REQUIRED", "Connect the Lumin account again with start_lumin_authorization, then finish_lumin_authorization. This does not resend any signing request. Use check_lumin_status for an existing request, not send_lumin_request.");
    }
    return connection;
  }

  async function handleStart(value) {
    assertRecord(value, []);
    requireConfigured();
    const nowMs = currentMs();
    const expired = [];
    for (const [id, pending] of pendingAuthorizations) {
      if (pending.expiresAtMs <= nowMs) {
        pendingAuthorizations.delete(id);
        expired.push(pending.session.close().catch(() => {}));
      }
    }
    await Promise.all(expired);
    if (pendingAuthorizations.size >= MAX_PENDING_AUTHORIZATIONS) {
      throw toolError("LUMIN_AUTHORIZATION_LIMIT_REACHED", "Too many Lumin authorization sessions are already pending.");
    }
    let session;
    try {
      session = await createOAuthSession({
        clientId,
        scopes: [...AUTHORIZATION_SCOPES],
        timeoutMs: AUTHORIZATION_TIMEOUT_MS,
      });
    } catch (error) {
      throw sanitizedDependencyError(
        error,
        "LUMIN_OAUTH_CALLBACK_UNAVAILABLE",
        "Lumin authorization could not be started safely.",
      );
    }
    const id = idFactory();
    const startedAtMs = currentMs();
    try {
      await openExternal(session.authorizationUrl);
    } catch {
      await session.close();
      throw toolError("LUMIN_BROWSER_OPEN_FAILED", "PDF Tools could not open Lumin in your browser. Check your default browser, then try start_lumin_authorization again. No PDF or signing request was sent.");
    }
    pendingAuthorizations.set(id, {
      session,
      expiresAtMs: startedAtMs + AUTHORIZATION_TIMEOUT_MS,
    });
    return {
      status: "awaiting_user_authorization",
      provider: "lumin_sign",
      authorization_session_id: id,
      callback_expires_at: new Date(startedAtMs + AUTHORIZATION_TIMEOUT_MS).toISOString(),
      browser_opened: true,
      pdf_sent: false,
      next_step: "Sign in on the Lumin page opened in your browser and review its access request. If you do not have an account, create one on Lumin's website, then return here. If signup does not return to this connection before it expires, run start_lumin_authorization again. Once you approve access in the browser, call finish_lumin_authorization with this session ID. Never paste passwords or browser callback URLs into chat.",
    };
  }

  async function handleComplete(value) {
    const args = assertRecord(value, ["authorization_session_id"]);
    requireConfigured();
    const id = assertString(args.authorization_session_id, "authorization session ID", { max: 128, pattern: IDENTIFIER_PATTERN });
    const pending = pendingAuthorizations.get(id);
    if (!pending || pending.expiresAtMs <= currentMs()) {
      pendingAuthorizations.delete(id);
      if (pending) await pending.session.close().catch(() => {});
      throw toolError("LUMIN_AUTHORIZATION_SESSION_INVALID", "This Lumin connection attempt is missing or expired. Run start_lumin_authorization again, finish in the browser, then call finish_lumin_authorization with the new session ID. No signing request was sent.");
    }
    if (pending.completionInProgress) {
      throw toolError("LUMIN_AUTHORIZATION_PENDING", "Lumin authorization is still waiting for the browser callback.");
    }
    pending.completionInProgress = true;
    let token;
    try {
      let timer;
      const outcome = await Promise.race([
        pending.session.waitForCallback().then(
          callback => ({ kind: "callback", callback }),
          error => ({ kind: "error", error }),
        ),
        new Promise(resolve => {
          timer = setTimeout(() => resolve({ kind: "pending" }), authorizationCompletionWaitMs);
          timer.unref?.();
        }),
      ]);
      clearTimeout(timer);
      if (outcome.kind === "pending") {
        pending.completionInProgress = false;
        throw toolError(
          "LUMIN_AUTHORIZATION_PENDING",
          "Lumin authorization is still waiting for the browser callback. Call this tool again after finishing in the browser.",
        );
      }
      pendingAuthorizations.delete(id);
      if (outcome.kind === "error") throw outcome.error;
      const callback = outcome.callback;
      token = await pending.session.exchangeToken(callback, { fetchFn: fetchImpl });
    } catch (error) {
      if (error?.code === "LUMIN_AUTHORIZATION_PENDING") throw error;
      pendingAuthorizations.delete(id);
      throw sanitizedDependencyError(
        error,
        "LUMIN_OAUTH_TOKEN_REQUEST_FAILED",
        "Lumin authorization was not completed. You can leave it disconnected or run start_lumin_authorization again when ready. No PDF or signing request was sent. Do not paste passwords or browser callback URLs into chat.",
      );
    } finally {
      if (!pendingAuthorizations.has(id)) await pending.session.close().catch(() => {});
    }
    if (connections.size >= MAX_CONNECTIONS) {
      const oldest = connections.keys().next().value;
      connections.delete(oldest);
    }
    const connectedAtMs = currentMs();
    connections.set(id, {
      accessToken: token.accessToken,
      expiresAtMs: connectedAtMs + (token.expiresIn * 1000),
    });
    token = null;
    return {
      status: "connected",
      provider: "lumin_sign",
      authorization_session_id: id,
      token_expires_at: new Date(connections.get(id).expiresAtMs).toISOString(),
      access_token_persisted: false,
      refresh_token_persisted: false,
      pdf_sent: false,
      next_step: "Lumin is connected, but no PDF or signing request has been sent. For a new request, prepare the PDF with prepare_signing_packet, preview it with prepare_lumin_request, and obtain the user's exact sending confirmation before send_lumin_request. For an existing request, use check_lumin_status or download_lumin_artifact without sending again.",
    };
  }

  async function handlePrepare(value) {
    const args = assertRecord(value, [
      "authorization_session_id",
      "expires_at",
      "pdf_path",
      "preparation_receipt",
      "signers",
      "title",
    ], ["viewers"]);
    requireConfigured();
    const authorizationSessionId = assertString(
      args.authorization_session_id,
      "authorization session ID",
      { max: 128, pattern: IDENTIFIER_PATTERN },
    );
    requireConnection(authorizationSessionId);
    const preparedDocument = await readPreparedPdf(assertString(args.pdf_path, "PDF path", { max: 32_768 }));
    if (!preparedDocument || typeof preparedDocument.canonicalPath !== "string" || !Buffer.isBuffer(preparedDocument.bytes)) {
      throw toolError("LUMIN_PREPARED_PDF_INVALID", "The prepared PDF could not be read safely.");
    }
    const receipt = validatePreparationReceipt(args.preparation_receipt, preparedDocument);
    const signers = validateParticipantArray(args.signers, { required: true });
    const viewers = args.viewers === undefined ? [] : validateParticipantArray(args.viewers, { required: false });
    const participantIds = [...signers, ...viewers].map(participant => participant.participant_id);
    if (new Set(participantIds).size !== participantIds.length) {
      throw toolError("LUMIN_WORKFLOW_INPUT_INVALID", "Participant IDs must be unique across signers and viewers.");
    }
    const nowMs = currentMs();
    const requestExpiresAtMs = assertIsoTimestamp(args.expires_at, "request expiry");
    const mapping = mapLuminSignV1SignatureRequest({
      schema_version: 1,
      prepared_document: {
        sha256: sha256(preparedDocument.bytes),
        size_bytes: preparedDocument.bytes.length,
        transfer: { kind: "direct_file" },
      },
      field_mapping: { method: "lumin_text_tags", evidence_status: "caller_asserted" },
      title: assertString(args.title, "title", { max: 255 }),
      expires_at_ms: requestExpiresAtMs,
      signing_type: "SAME_TIME",
      signers,
      ...(viewers.length ? { viewers } : {}),
    }, { nowMs });
    try {
      validateLuminSignV1DirectUploadPreparation({
        mapping,
        preparation_receipt: receipt,
        prepared_pdf_bytes: preparedDocument.bytes,
      }, { nowMs });
    } catch {
      throw toolError(
        "LUMIN_PREPARATION_NOT_PROVIDER_READY",
        "The signing packet is not ready for the Lumin request.",
      );
    }
    for (const [id, preparation] of preparations) {
      if (preparation.expiresAtMs <= nowMs) preparations.delete(id);
    }
    if (preparations.size >= MAX_PREPARATIONS) {
      throw toolError("LUMIN_REQUEST_PREPARATION_LIMIT_REACHED", "Too many Lumin signing requests are awaiting confirmation.");
    }
    const requestPreparationId = idFactory();
    const confirmation = {
      schema_version: 1,
      provider: "lumin_sign",
      action: "create_signature_request",
      request_preparation_id: requestPreparationId,
      authorization_session_id: authorizationSessionId,
      preparation_receipt_sha256: receipt.receipt_sha256,
      request_mapping_sha256: domainSha256("pdf-tools.lumin-sign-v1-request-mapping.v1", mapping),
      prepared_document_sha256: sha256(preparedDocument.bytes),
      participant_ids: arrayValues(mapping.bindings.participant_ids),
      disclosure: LUMIN_SIGNING_DISCLOSURE,
      confirmation_statement_required: LUMIN_SIGN_V1_DIRECT_UPLOAD_CONFIRMATION,
    };
    const confirmationSha256 = domainSha256("pdf-tools.lumin-signing-confirmation.v1", confirmation);
    preparations.set(requestPreparationId, {
      createdAtMs: nowMs,
      expiresAtMs: nowMs + REQUEST_PREPARATION_LIFETIME_MS,
      pdfPath: preparedDocument.canonicalPath,
      authorizationSessionId,
      receipt,
      mapping: cloneJson(mapping),
      confirmationSha256,
    });
    return {
      status: "ready_for_user_confirmation",
      provider: "lumin_sign",
      request_preparation_id: requestPreparationId,
      authorization_session_id: authorizationSessionId,
      confirmation_sha256: confirmationSha256,
      confirmation_expires_at: new Date(nowMs + REQUEST_PREPARATION_LIFETIME_MS).toISOString(),
      disclosure: LUMIN_SIGNING_DISCLOSURE,
      confirmation_statement_required: LUMIN_SIGN_V1_DIRECT_UPLOAD_CONFIRMATION,
      prepared_document: {
        canonical_path: preparedDocument.canonicalPath,
        size_bytes: preparedDocument.bytes.length,
        sha256: sha256(preparedDocument.bytes),
      },
      title: mapping.request.body.title,
      request_expires_at: new Date(mapping.request.body.expires_at).toISOString(),
      signers: signers.map(({ participant_id, name, email_address }) => ({ participant_id, name, email_address })),
      viewers: viewers.map(({ participant_id, name, email_address }) => ({ participant_id, name, email_address })),
      provider_contacted: false,
      pdf_sent: false,
    };
  }

  async function handleSend(value) {
    const args = assertRecord(value, [
      "authorization_session_id",
      "confirmation_sha256",
      "confirmation_statement",
      "request_preparation_id",
      "user_confirmed_at",
    ]);
    requireConfigured();
    const authorizationSessionId = assertString(
      args.authorization_session_id,
      "authorization session ID",
      { max: 128, pattern: IDENTIFIER_PATTERN },
    );
    const preparationId = assertString(args.request_preparation_id, "request preparation ID", { max: 128, pattern: IDENTIFIER_PATTERN });
    const preparation = preparations.get(preparationId);
    const nowMs = currentMs();
    if (!preparation || preparation.expiresAtMs <= nowMs) {
      preparations.delete(preparationId);
      throw toolError("LUMIN_REQUEST_PREPARATION_EXPIRED", "Prepare the Lumin signing request again before sending.");
    }
    if (authorizationSessionId !== preparation.authorizationSessionId) {
      throw toolError(
        "LUMIN_AUTHORIZATION_SESSION_CHANGED",
        "The connected Lumin session does not match the confirmed request preparation.",
      );
    }
    const connection = requireConnection(authorizationSessionId);
    if (
      args.confirmation_sha256 !== preparation.confirmationSha256
      || args.confirmation_statement !== LUMIN_SIGN_V1_DIRECT_UPLOAD_CONFIRMATION
    ) {
      throw toolError("LUMIN_USER_CONFIRMATION_INVALID", "The exact Lumin sending confirmation was not supplied.");
    }
    const confirmedAtMs = assertIsoTimestamp(args.user_confirmed_at, "user confirmation time");
    if (confirmedAtMs > nowMs || nowMs - confirmedAtMs >= USER_CONFIRMATION_LIFETIME_MS) {
      throw toolError("LUMIN_USER_CONFIRMATION_EXPIRED", "The user confirmation is missing, future-dated, or older than 10 minutes.");
    }
    // The user's exact confirmation is a one-shot capability. Consume it
    // synchronously before the first await so concurrent sends cannot both
    // pass validation or enter local/provider work.
    preparations.delete(preparationId);
    const preparedDocument = await readPreparedPdf(preparation.pdfPath);
    validatePreparationReceipt(preparation.receipt, preparedDocument);
    const mapped = mapLuminSignV1SignatureRequest({
      schema_version: 1,
      prepared_document: {
        sha256: sha256(preparedDocument.bytes),
        size_bytes: preparedDocument.bytes.length,
        transfer: { kind: "direct_file" },
      },
      field_mapping: { method: "lumin_text_tags", evidence_status: "caller_asserted" },
      title: preparation.mapping.request.body.title,
      expires_at_ms: preparation.mapping.request.body.expires_at,
      signing_type: "SAME_TIME",
      signers: arrayValues(preparation.mapping.bindings.signer_participant_ids).map((participantId, index) => ({
        participant_id: participantId,
        ...preparation.mapping.request.body.signers[index],
      })),
      ...(preparation.mapping.bindings.viewer_participant_ids.length ? {
        viewers: arrayValues(preparation.mapping.bindings.viewer_participant_ids).map((participantId, index) => ({
          participant_id: participantId,
          ...preparation.mapping.request.body.viewers[index],
        })),
      } : {}),
    }, { nowMs });
    const requestMappingSha256 = domainSha256("pdf-tools.lumin-sign-v1-request-mapping.v1", mapped);
    if (requestMappingSha256 !== domainSha256("pdf-tools.lumin-sign-v1-request-mapping.v1", preparation.mapping)) {
      throw toolError("LUMIN_REQUEST_PREPARATION_CHANGED", "The prepared Lumin request no longer matches the confirmed preview.");
    }
    const authority = {
      schema_version: 1,
      provider: "lumin_sign",
      action: "create_signature_request",
      transport: "direct_pdf_multipart",
      confirmation: LUMIN_SIGN_V1_DIRECT_UPLOAD_CONFIRMATION,
      approved_at: new Date(confirmedAtMs).toISOString(),
      expires_at: new Date(confirmedAtMs + EXECUTION_AUTHORITY_LIFETIME_MS).toISOString(),
      preparation_receipt_sha256: preparation.receipt.receipt_sha256,
      mapper_contract_sha256: LUMIN_SIGN_V1_MAPPER_CONTRACT_SHA256,
      request_mapping_sha256: requestMappingSha256,
      prepared_document_sha256: sha256(preparedDocument.bytes),
      participant_ids: arrayValues(mapped.bindings.participant_ids),
      automatic_retry_allowed: false,
    };
    const authoritySha256 = domainSha256("pdf-tools.lumin-sign-v1-execution-authority.v1", authority);
    let execution;
    try {
      execution = await executeCreate({
        access_token: connection.accessToken,
        execution_authority: authority,
        mapping: cloneJson(mapped),
        preparation_receipt: cloneJson(preparation.receipt),
        prepared_pdf_bytes: Buffer.from(preparedDocument.bytes),
      }, {
        fetchImpl,
        stateRoot,
        nowMs,
      });
    } catch (error) {
      throw sanitizedDependencyError(
        error,
        "LUMIN_CREATE_OUTCOME_UNKNOWN",
        "The Lumin signing request did not complete. Its create authority remains consumed and PDF Tools will not retry it.",
      );
    }
    return {
      status: "request_created",
      provider: "lumin_sign",
      authority_sha256: authoritySha256,
      operation_status: execution.operation.operation_status,
      signature_request_id: execution.result.response.signature_request_id,
      provider_status: execution.result.response.status,
      created_at: execution.result.response.created_at,
      attempt_count: 1,
      automatic_retry_performed: false,
      create_retry_allowed: false,
      access_token_persisted: false,
    };
  }

  async function handleStatus(value) {
    const args = assertRecord(value, ["authority_sha256", "authorization_session_id"]);
    requireConfigured();
    const connection = requireConnection(args.authorization_session_id);
    const authoritySha256 = assertString(args.authority_sha256, "authority SHA-256", { max: 64, pattern: SHA256_PATTERN });
    let result;
    try {
      result = await pollStatus({
        access_token: connection.accessToken,
        authority_sha256: authoritySha256,
        state_root: stateRoot,
      }, { fetchImpl, nowMs: currentMs() });
    } catch (error) {
      throw sanitizedDependencyError(
        error,
        "LUMIN_STATUS_OBSERVATION_RETRYABLE",
        "The Lumin signing status could not be checked safely.",
      );
    }
    return {
      status: "observed",
      provider: "lumin_sign",
      authority_sha256: result.authority_sha256,
      signature_request_id: result.signature_request_id,
      provider_status: result.status,
      observed_at: result.observed_at,
      observation_sha256: result.observation_sha256,
      read_retry_safe: true,
      create_retry_allowed: false,
      access_token_persisted: false,
    };
  }

  async function handleDownload(value) {
    const args = assertRecord(value, ["authority_sha256", "authorization_session_id", "file_type", "output_path"]);
    requireConfigured();
    const connection = requireConnection(args.authorization_session_id);
    const authoritySha256 = assertString(args.authority_sha256, "authority SHA-256", { max: 64, pattern: SHA256_PATTERN });
    const outputPath = resolveOutputPath(assertString(args.output_path, "output path", { max: 32_768 }));
    let artifact;
    try {
      artifact = await requestArtifact({
        access_token: connection.accessToken,
        authority_sha256: authoritySha256,
        file_type: assertString(args.file_type, "file type", { max: 16 }),
        state_root: stateRoot,
      }, { fetchImpl, nowMs: currentMs() });
      const downloaded = await downloadSignedPdf({ signedUrl: artifact.signed_url, outputPath });
      return {
        status: "downloaded",
        provider: "lumin_sign",
        authority_sha256: authoritySha256,
        file_type: artifact.file_type,
        pdf_path: downloaded.canonicalPath,
        size_bytes: downloaded.bytes,
        sha256: downloaded.sha256,
        artifact_observation_sha256: artifact.observation.observation_sha256,
        access_url_persisted: false,
        access_url_returned: false,
        access_token_persisted: false,
        create_retry_allowed: false,
      };
    } catch (error) {
      throw sanitizedDependencyError(
        error,
        "LUMIN_ARTIFACT_DOWNLOAD_FAILED",
        "The Lumin artifact could not be downloaded safely.",
      );
    } finally {
      artifact = null;
    }
  }

  return async function handleLuminSigningTool(name, args = {}) {
    switch (name) {
      case "start_lumin_authorization": return handleStart(args);
      case "finish_lumin_authorization": return handleComplete(args);
      case "prepare_lumin_request": return handlePrepare(args);
      case "send_lumin_request": return handleSend(args);
      case "check_lumin_status": return handleStatus(args);
      case "download_lumin_artifact": return handleDownload(args);
      default: throw toolError("LUMIN_WORKFLOW_TOOL_UNKNOWN", "Unknown Lumin signing tool.");
    }
  };
}
