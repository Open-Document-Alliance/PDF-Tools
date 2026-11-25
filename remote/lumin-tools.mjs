/**
 * Lumin signing tools for the hosted /mcp/sign surface.
 * See docs/REMOTE_SIGNING_PROFILE_2026-11-25.md (S1 to S6).
 *
 * Nothing is stored. prepare_lumin_request draws visible "Sign here" boxes the
 * same way the local prepare_signing_packet does, and returns a sealed
 * preparation token that carries the exact recipients, title, expiry, box
 * placements and the prepared PDF's digest. send_lumin_request takes the same
 * source document and that token, prepares it again, refuses unless the bytes
 * match what the person previewed, and makes one request to Lumin.
 *
 * The Lumin access token arrives in a separate context from the authenticated
 * route, never in tool arguments, and never appears in results or logs.
 */
import { createHash } from "node:crypto";
import { PDFDocument } from "pdf-lib";

import {
  assertParsedXfaMutationAllowed,
  detectExistingSignatures,
  drawSignatureFieldOnPage,
} from "../server/helpers.js";
import { LUMIN_CLIENT_USER_AGENT } from "../server/lumin-client-identity.js";
import { mapLuminSignV1SignatureRequest } from "../server/lumin-sign-v1-mapper.js";
import { LUMIN_SIGN_V1_DIRECT_UPLOAD_CONFIRMATION } from "../server/lumin-sign-v1-transport.js";
import { fetchPdfBytes } from "./fetch-guard.mjs";
import { open, parseSealingKeys, seal } from "./sealed.mjs";

export const LUMIN_TOOL_NAMES = Object.freeze([
  "prepare_lumin_request", "send_lumin_request", "check_lumin_status", "download_lumin_artifact",
]);
export const LUMIN_CONFIRMATION_STATEMENT = LUMIN_SIGN_V1_DIRECT_UPLOAD_CONFIRMATION;
export const LUMIN_DISCLOSURE =
  "Sending uploads this prepared PDF and the listed signer and viewer names and email addresses to Lumin, and Lumin emails the signers. From then on Lumin's terms and privacy policy apply to the document. PDF Tools keeps no copy.";

const LUMIN_API = "https://api.luminpdf.com/v1";
const PREPARATION_TTL_SECONDS = 30 * 60;
const CONFIRMATION_WINDOW_MS = 10 * 60 * 1000;
const LUMIN_TIMEOUT_MS = 30_000;
/**
 * The per-call worker is terminated at 45 s (isolated-tool.mjs). A send must
 * finish, or give up cleanly, before that, so a termination can never land in
 * the middle of the Lumin upload. If too little time is left after fetching
 * and preparing the source, nothing is sent.
 */
const SEND_BUDGET_MS = 40_000;
const MIN_SEND_WINDOW_MS = 8_000;
const MAX_PARTICIPANTS = 10;
const MAX_LOCATIONS = 40;
const MAX_PROVIDER_RESPONSE_BYTES = 256 * 1024;
const MAX_EXPIRY_MS = 365 * 24 * 60 * 60 * 1000;
const ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/;
const PARTICIPANT_PATTERN = "^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$";
const STATUS_PATTERN = /^[A-Z][A-Z0-9_]{0,127}$/;
const FILE_TYPES = ["agreement", "coc", "merged"];

const sha256 = bytes => createHash("sha256").update(bytes).digest("hex");
function canonicalJson(value) {
  // The mapper's isolated output uses null-prototype arrays, so index directly as the transport does.
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
/** Same domain-separated digest as server/lumin-sign-v1-transport.js uses for a request mapping. */
const mappingDigest = mapped => sha256(Buffer.from(`pdf-tools.lumin-sign-v1-request-mapping.v1\0${canonicalJson(mapped)}`, "utf8"));

const personSchema = {
  type: "object",
  properties: {
    participant_id: { type: "string", pattern: PARTICIPANT_PATTERN },
    name: { type: "string", minLength: 1, maxLength: 255 },
    email_address: { type: "string", minLength: 3, maxLength: 320 },
  },
  required: ["participant_id", "name", "email_address"],
  additionalProperties: false,
};

export function createLuminTools({ PDF_INPUT_PROPERTIES, resolveBytes, loadDocument, ok, ToolRefusal, MAX_INLINE_PDF_BYTES }) {
  const fail = (code, message) => { throw new ToolRefusal(code, message); };

  function keys() {
    const parsed = parseSealingKeys(process.env.PDF_TOOLS_SIGN_SEALING_KEYS);
    if (!parsed) fail("SIGNING_UNAVAILABLE", "Hosted signing is not configured on this deployment.");
    return parsed;
  }

  function lumin(context) {
    const token = context?.lumin?.accessToken;
    if (typeof token !== "string" || !token) fail("LUMIN_NOT_CONNECTED", "Connect PDF Tools to Lumin before using signing.");
    // fetchImpl and artifactFetch are injected only by tests; the hosted route passes the token alone.
    return { token, fetchImpl: context.lumin.fetchImpl ?? globalThis.fetch, artifactFetch: context.lumin.artifactFetch ?? {} };
  }

  function documentInput(args) {
    const input = {};
    for (const key of ["file", "pdf_url", "pdf_base64"]) if (args[key] !== undefined) input[key] = args[key];
    return input;
  }

  /** Validate the request plan into a compact, sealable form. */
  function plan(args, nowMs) {
    if (typeof args.title !== "string" || !args.title.trim() || args.title.length > 255) fail("INVALID_TITLE", "Give a title of at most 255 characters.");
    const expiresAtMs = Date.parse(args.expires_at);
    if (typeof args.expires_at !== "string" || !Number.isFinite(expiresAtMs) || expiresAtMs <= nowMs + 60 * 60 * 1000 || expiresAtMs > nowMs + MAX_EXPIRY_MS) {
      fail("INVALID_EXPIRY", "expires_at must be an ISO-8601 time between one hour and one year from now.");
    }
    const signers = Array.isArray(args.signers) ? args.signers : [];
    const viewers = args.viewers === undefined ? [] : Array.isArray(args.viewers) ? args.viewers : null;
    if (!signers.length || viewers === null || signers.length + viewers.length > MAX_PARTICIPANTS) {
      fail("INVALID_RECIPIENTS", `Give 1 or more signers and at most ${MAX_PARTICIPANTS} people in total.`);
    }
    const locations = Array.isArray(args.signature_locations) ? args.signature_locations : [];
    if (!locations.length || locations.length > MAX_LOCATIONS) fail("INVALID_LOCATIONS", `Give 1 to ${MAX_LOCATIONS} signature locations.`);
    const signerIds = new Set(signers.map(person => person?.participant_id));
    for (const location of locations) {
      if (!location || typeof location !== "object" || !signerIds.has(location.participant_id)) {
        fail("INVALID_LOCATIONS", "Every signature location must name the participant_id of one of the signers.");
      }
      for (const key of ["page", "x", "y", "width", "height"]) {
        if (typeof location[key] !== "number" || !Number.isFinite(location[key]) || location[key] < 0) fail("INVALID_LOCATIONS", `Location ${key} must be a non-negative number.`);
      }
      if (!Number.isInteger(location.page) || location.page < 1 || location.width < 20 || location.height < 10 || location.width > 600 || location.height > 300) {
        fail("INVALID_LOCATIONS", "Locations need a page number and a box at least 20 by 10 points.");
      }
      if (location.label !== undefined && (typeof location.label !== "string" || !location.label.trim() || location.label.length > 100)) {
        fail("INVALID_LOCATIONS", "A location label must be non-blank text of at most 100 characters.");
      }
    }
    for (const id of signerIds) {
      if (!locations.some(location => location.participant_id === id)) fail("INVALID_LOCATIONS", "Every signer needs at least one signature location.");
    }
    return {
      title: args.title.trim(),
      expiresAtMs,
      signers: signers.map(({ participant_id, name, email_address }) => ({ participant_id, name, email_address })),
      viewers: viewers.map(({ participant_id, name, email_address }) => ({ participant_id, name, email_address })),
      locations: locations.map(({ page, x, y, width, height, participant_id, label }) => ({ page, x, y, width, height, participant_id, ...(label ? { label } : {}) })),
    };
  }

  /**
   * Prepare deterministically: same source bytes and plan, same output bytes.
   * pdf-lib is told not to update metadata, so nothing time-dependent enters.
   */
  async function prepare(source, requestPlan) {
    const document = await loadDocument(source);
    if (detectExistingSignatures(document).present) fail("SIGNED_DOCUMENT", "That PDF already carries a cryptographic signature; preparing it would invalidate it.");
    assertParsedXfaMutationAllowed(document);
    const names = new Map(requestPlan.signers.map(person => [person.participant_id, person.name]));
    for (const location of requestPlan.locations) {
      try {
        await drawSignatureFieldOnPage(document, { ...location, label: location.label ?? `${names.get(location.participant_id)}: sign here` });
      } catch {
        fail("INVALID_LOCATIONS", "A signature location falls outside its page.");
      }
    }
    const bytes = await document.save({ updateFieldAppearances: false });
    if (bytes.length > MAX_INLINE_PDF_BYTES) fail("OUTPUT_TOO_LARGE", "The prepared PDF exceeds the 3 MB hosted limit. Use local PDF Tools.");
    return bytes;
  }

  function mapping(requestPlan, bytes, nowMs) {
    try {
      return mapLuminSignV1SignatureRequest({
        schema_version: 1,
        prepared_document: { sha256: sha256(bytes), size_bytes: bytes.length, transfer: { kind: "direct_file" } },
        field_mapping: { method: "lumin_text_tags", evidence_status: "caller_asserted" },
        title: requestPlan.title,
        expires_at_ms: requestPlan.expiresAtMs,
        signing_type: "SAME_TIME",
        signers: requestPlan.signers,
        ...(requestPlan.viewers.length ? { viewers: requestPlan.viewers } : {}),
      }, { nowMs });
    } catch {
      return fail("INVALID_RECIPIENTS", "Each person needs a unique participant_id, a name and a valid email address.");
    }
  }

  async function luminJson(fetchImpl, url, init, timeoutMs = LUMIN_TIMEOUT_MS) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const response = await fetchImpl(url, { ...init, redirect: "error", signal: controller.signal });
      const type = response.headers.get("content-type")?.split(";", 1)[0].trim().toLowerCase();
      const declared = response.headers.get("content-length");
      if (declared !== null && (!/^\d+$/.test(declared) || Number(declared) > MAX_PROVIDER_RESPONSE_BYTES)) throw new Error("too large");
      const text = await response.text();
      if (Buffer.byteLength(text) > MAX_PROVIDER_RESPONSE_BYTES) throw new Error("too large");
      return { status: response.status, value: type === "application/json" ? JSON.parse(text) : null };
    } finally {
      clearTimeout(timer);
    }
  }

  const headers = token => ({ accept: "application/json", authorization: `Bearer ${token}`, "user-agent": LUMIN_CLIENT_USER_AGENT });
  const requestIdSchema = { type: "string", pattern: "^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$", description: "The signature_request_id returned by send_lumin_request." };

  return [
    {
      name: "prepare_lumin_request",
      description: "Prepare a PDF for Lumin signing and preview exactly what would be sent. Draws a visible 'sign here' box at each location (find them with detect_signature_zones), then returns the prepared PDF, the disclosure and the exact confirmation statement the person must give. Sends nothing and contacts no one.",
      inputSchema: {
        type: "object",
        properties: {
          ...PDF_INPUT_PROPERTIES,
          title: { type: "string", maxLength: 255, description: "Title the signers will see in Lumin." },
          expires_at: { type: "string", format: "date-time", description: "When the request expires: between one hour and one year from now." },
          signers: { type: "array", minItems: 1, maxItems: MAX_PARTICIPANTS, items: personSchema },
          viewers: { type: "array", maxItems: MAX_PARTICIPANTS - 1, items: personSchema },
          signature_locations: {
            type: "array", minItems: 1, maxItems: MAX_LOCATIONS,
            items: {
              type: "object",
              properties: {
                participant_id: { type: "string", pattern: PARTICIPANT_PATTERN, description: "Which signer signs here." },
                page: { type: "integer", minimum: 1 },
                x: { type: "number", minimum: 0, description: "Points from the left edge." },
                y: { type: "number", minimum: 0, description: "Points from the top edge." },
                width: { type: "number", minimum: 20, maximum: 600 },
                height: { type: "number", minimum: 10, maximum: 300 },
                label: { type: "string", maxLength: 100 },
              },
              required: ["participant_id", "page", "x", "y", "width", "height"],
              additionalProperties: false,
            },
          },
        },
        required: ["title", "expires_at", "signers", "signature_locations"],
      },
      annotations: { title: "Prepare Lumin Signing Request", readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true },
      async handler(args, context) {
        lumin(context);
        const nowMs = Date.now();
        const requestPlan = plan(args, nowMs);
        const source = await resolveBytes(documentInput(args));
        const bytes = await prepare(source, requestPlan);
        const mapped = mapping(requestPlan, bytes, nowMs);
        const preparationToken = seal("prepare", {
          i: Math.floor(nowMs / 1000), s: sha256(source), d: sha256(bytes), n: bytes.length, m: mappingDigest(mapped), p: requestPlan,
        }, { keys: keys(), expiresAt: Math.floor(nowMs / 1000) + PREPARATION_TTL_SECONDS });
        const recipients = [
          ...requestPlan.signers.map(person => `${person.name} <${person.email_address}> (signer)`),
          ...requestPlan.viewers.map(person => `${person.name} <${person.email_address}> (viewer)`),
        ];
        return ok(
          `Prepared "${requestPlan.title}" with ${requestPlan.locations.length} signature box(es). Nothing has been sent.\n`
            + `Recipients:\n${recipients.join("\n")}\n\n${LUMIN_DISCLOSURE}\n\n`
            + `To send, the person must confirm with exactly this statement:\n${LUMIN_CONFIRMATION_STATEMENT}`,
          {
            preparation_token: preparationToken,
            preparation_expires_in_seconds: PREPARATION_TTL_SECONDS,
            disclosure: LUMIN_DISCLOSURE,
            confirmation_statement_required: LUMIN_CONFIRMATION_STATEMENT,
            recipients: { signers: requestPlan.signers, viewers: requestPlan.viewers },
            source: { sha256: sha256(source), size_bytes: source.length },
            output: { sha256: sha256(bytes), size_bytes: bytes.length },
            pdf_base64: Buffer.from(bytes).toString("base64"),
            provider_execution_status: "not_requested",
          },
        );
      },
    },
    {
      name: "send_lumin_request",
      description: "NEVER FABRICATE confirmation_statement OR user_confirmed_at. Show the person the disclosure from prepare_lumin_request and ask them to confirm with the exact statement, then pass their words and the time they confirmed. Supply the same source PDF used for preparation. Makes one request that uploads the prepared PDF to Lumin and emails the signers. It is never retried; if the outcome is unknown, check Lumin before sending again.",
      inputSchema: {
        type: "object",
        properties: {
          ...PDF_INPUT_PROPERTIES,
          preparation_token: { type: "string", description: "The preparation_token from prepare_lumin_request." },
          confirmation_statement: { type: "string", description: "The person's verbatim confirmation. Never invent or paraphrase it." },
          user_confirmed_at: { type: "string", format: "date-time", description: "When the person confirmed, within the last 10 minutes." },
        },
        required: ["preparation_token", "confirmation_statement", "user_confirmed_at"],
      },
      annotations: { title: "Send Lumin Signing Request", readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true },
      async handler(args, context) {
        const { token, fetchImpl } = lumin(context);
        const startedMs = Date.now();
        const nowMs = startedMs;
        let prepared;
        try { prepared = open("prepare", String(args.preparation_token ?? ""), { keys: keys(), now: Math.floor(nowMs / 1000) }); } catch {
          fail("PREPARATION_INVALID", "That preparation is not valid or has expired. Prepare the request again.");
        }
        if (args.confirmation_statement !== LUMIN_CONFIRMATION_STATEMENT) {
          fail("CONFIRMATION_MISMATCH", "The confirmation must be the person's own words, exactly the required statement.");
        }
        const confirmedAt = Date.parse(args.user_confirmed_at);
        if (!Number.isSafeInteger(prepared.i)) fail("PREPARATION_INVALID", "That preparation is not valid. Prepare the request again.");
        if (typeof args.user_confirmed_at !== "string" || !Number.isFinite(confirmedAt) || confirmedAt > nowMs + 60_000 || nowMs - confirmedAt > CONFIRMATION_WINDOW_MS) {
          fail("CONFIRMATION_STALE", "The confirmation must have been given within the last 10 minutes.");
        }
        if (confirmedAt < prepared.i * 1000 - 60_000) {
          fail("CONFIRMATION_BEFORE_PREVIEW", "The confirmation predates this preview. Show the person the preview and ask them to confirm it.");
        }
        const source = await resolveBytes(documentInput(args));
        if (sha256(source) !== prepared.s) fail("SOURCE_CHANGED", "That is not the PDF that was prepared. Supply the same document or prepare again.");
        const bytes = await prepare(source, prepared.p);
        if (sha256(bytes) !== prepared.d || bytes.length !== prepared.n) fail("PREPARATION_MISMATCH", "The prepared PDF did not reproduce exactly. Nothing was sent; prepare again.");
        const mapped = mapping(prepared.p, bytes, nowMs);
        if (mappingDigest(mapped) !== prepared.m) fail("PREPARATION_MISMATCH", "The request no longer matches the preview. Nothing was sent; prepare again.");

        const form = new FormData();
        form.append(mapped.request.file_transfer.form_field, new Blob([bytes], { type: "application/pdf" }), mapped.request.file_transfer.filename);
        form.append("title", mapped.request.body.title);
        form.append("expires_at", String(mapped.request.body.expires_at));
        Array.prototype.forEach.call(mapped.request.body.signers, (person, index) => { form.append(`signers[${index}][email_address]`, person.email_address); form.append(`signers[${index}][name]`, person.name); });
        Array.prototype.forEach.call(mapped.request.body.viewers ?? [], (person, index) => { form.append(`viewers[${index}][email_address]`, person.email_address); form.append(`viewers[${index}][name]`, person.name); });
        form.append("use_text_tags", "true");
        form.append("signing_type", "SAME_TIME");

        const remainingMs = SEND_BUDGET_MS - (Date.now() - startedMs);
        if (remainingMs < MIN_SEND_WINDOW_MS) {
          fail("SEND_NOT_STARTED", "Preparing the document took too long, so nothing was sent to Lumin. Sending again is safe.");
        }
        let response;
        try {
          response = await luminJson(fetchImpl, `${LUMIN_API}/signature_request/send`, { method: "POST", headers: headers(token), body: form }, Math.min(LUMIN_TIMEOUT_MS, remainingMs));
        } catch {
          fail("LUMIN_CREATE_OUTCOME_UNKNOWN", "The Lumin request may or may not have been created. It was not retried. Check the Lumin dashboard or the signers' inboxes before sending again.");
        }
        if (response.status >= 400 && response.status < 500) {
          fail("LUMIN_CREATE_REJECTED", `Lumin refused the request (HTTP ${response.status}). It was not retried.`);
        }
        if (response.status !== 201) {
          fail("LUMIN_CREATE_OUTCOME_UNKNOWN", `Lumin answered HTTP ${response.status}, so the request may or may not exist. It was not retried. Check the Lumin dashboard or the signers' inboxes before sending again.`);
        }
        const created = response.value?.signature_request;
        if (!created || !ID_PATTERN.test(created.signature_request_id ?? "") || !STATUS_PATTERN.test(created.status ?? "")) {
          fail("LUMIN_CREATE_OUTCOME_UNKNOWN", "Lumin may have created the request, but its response could not be verified. It was not retried. Check Lumin before sending again.");
        }
        return ok(`Sent to Lumin. Request ${created.signature_request_id} is ${created.status}. Lumin emails the signers.`, {
          signature_request_id: created.signature_request_id,
          status: created.status,
          provider_execution_status: "request_created",
          attempt_count: 1,
          automatic_retry_performed: false,
          prepared_document: { sha256: prepared.d, size_bytes: prepared.n },
        });
      },
    },
    {
      name: "check_lumin_status",
      description: "Read the status of an existing Lumin signing request. Cannot create or resend a request; safe to repeat.",
      inputSchema: { type: "object", properties: { signature_request_id: requestIdSchema }, required: ["signature_request_id"], additionalProperties: false },
      annotations: { title: "Check Lumin Signing Status", readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
      async handler(args, context) {
        const { token, fetchImpl } = lumin(context);
        if (!ID_PATTERN.test(args.signature_request_id ?? "")) fail("INVALID_REQUEST_ID", "Supply the signature_request_id returned by send_lumin_request.");
        let response;
        try {
          response = await luminJson(fetchImpl, `${LUMIN_API}/signature_request/${encodeURIComponent(args.signature_request_id)}`, { method: "GET", headers: headers(token) });
        } catch {
          fail("LUMIN_STATUS_UNAVAILABLE", "The status could not be read. Retrying is safe and creates nothing.");
        }
        const request = response.value?.signature_request;
        if (response.status !== 200 || request?.signature_request_id !== args.signature_request_id || !STATUS_PATTERN.test(request?.status ?? "")) {
          fail("LUMIN_STATUS_UNAVAILABLE", `Lumin did not return a status for that request (HTTP ${response.status}). Retrying is safe.`);
        }
        return ok(`Request ${request.signature_request_id} is ${request.status}.`, { signature_request_id: request.signature_request_id, status: request.status });
      },
    },
    {
      name: "download_lumin_artifact",
      description: "Return a file from an existing Lumin signing request: the signed agreement, the certificate of completion (coc), or both merged. The temporary download link is used once inside this call and never returned. Cannot create or resend a request.",
      inputSchema: {
        type: "object",
        properties: { signature_request_id: requestIdSchema, file_type: { type: "string", enum: FILE_TYPES } },
        required: ["signature_request_id", "file_type"],
        additionalProperties: false,
      },
      annotations: { title: "Download Lumin Signed PDF", readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
      async handler(args, context) {
        const { token, fetchImpl, artifactFetch } = lumin(context);
        if (!ID_PATTERN.test(args.signature_request_id ?? "") || !FILE_TYPES.includes(args.file_type)) {
          fail("INVALID_REQUEST", "Supply a signature_request_id and file_type agreement, coc or merged.");
        }
        let response;
        try {
          response = await luminJson(fetchImpl, `${LUMIN_API}/signature_request/${encodeURIComponent(args.signature_request_id)}/file?type=${args.file_type}`, { method: "GET", headers: headers(token) });
        } catch {
          fail("LUMIN_ARTIFACT_UNAVAILABLE", "Lumin did not provide the file. Retrying is safe.");
        }
        const signedUrl = response.value?.signed_url;
        if (response.status !== 200 || typeof signedUrl !== "string" || !signedUrl.startsWith("https://") || signedUrl.length > 4096) {
          fail("LUMIN_ARTIFACT_UNAVAILABLE", `Lumin did not provide the file (HTTP ${response.status}). It may not be complete yet; check the status.`);
        }
        const bytes = await fetchPdfBytes(signedUrl, artifactFetch);
        if (bytes.length > MAX_INLINE_PDF_BYTES) fail("OUTPUT_TOO_LARGE", "That file exceeds the 3 MB hosted limit. Download it from Lumin directly.");
        const document = await PDFDocument.load(bytes, { updateMetadata: false });
        return ok(`Downloaded the ${args.file_type} PDF (${document.getPageCount()} pages).`, {
          signature_request_id: args.signature_request_id,
          file_type: args.file_type,
          output: { sha256: sha256(bytes), size_bytes: bytes.length, page_count: document.getPageCount() },
          pdf_base64: Buffer.from(bytes).toString("base64"),
        });
      },
    },
  ];
}
