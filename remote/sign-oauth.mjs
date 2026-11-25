/**
 * OAuth for the hosted signing surface, as a stateless proxy in front of Lumin.
 * See docs/REMOTE_SIGNING_PROFILE_2026-11-25.md ("OAuth shape").
 *
 * This server is the authorization server Claude talks to and a client of
 * Lumin's. Every artifact it issues is a sealed value from ./sealed.mjs, so it
 * keeps no client table, no code table and no token table. Claude never sees a
 * Lumin token in the clear; the server opens the sealed access token per
 * request and forgets it.
 *
 * Redirect URIs are limited to Claude's own callbacks and loopback addresses.
 * Open registration with arbitrary redirects would let anyone register a
 * client, send a person an authorize link, and receive a code for that
 * person's Lumin authorization.
 */
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";

import { exchangeLuminToken, LUMIN_OAUTH_AUTHORIZATION_ENDPOINT } from "../server/lumin-oauth-loopback.js";
import { open, parseSealingKeys, seal, SealRefused } from "./sealed.mjs";

export const LUMIN_SCOPES = Object.freeze(["openid", "profile.read", "sign:requests"]);
export const SIGN_SCOPE = "sign";
export const SIGN_RESOURCE_PATH = "/mcp/sign";
export const LUMIN_CALLBACK_PATH = "/oauth/lumin/callback";

const CLIENT_TTL_SECONDS = 365 * 24 * 60 * 60;
const STATE_TTL_SECONDS = 10 * 60;
const CODE_TTL_SECONDS = 60;
const MAX_ACCESS_TTL_SECONDS = 60 * 60;
const REFRESH_TTL_SECONDS = 30 * 24 * 60 * 60;
const MAX_FORM_BYTES = 16 * 1024;
const MAX_REGISTRATION_BYTES = 8 * 1024;
const MAX_REDIRECT_URIS = 5;
const PKCE_PATTERN = /^[A-Za-z0-9._~-]{43,128}$/;
const CHALLENGE_PATTERN = /^[A-Za-z0-9_-]{43}$/;
const STATE_PATTERN = /^[\x21-\x7e]{1,512}$/;

const ALLOWED_HTTPS_CALLBACKS = Object.freeze([
  "https://claude.ai/api/mcp/auth_callback",
  "https://claude.com/api/mcp/auth_callback",
]);

const JSON_HEADERS = Object.freeze({
  "content-type": "application/json",
  "cache-control": "no-store",
  pragma: "no-cache",
  "x-content-type-options": "nosniff",
});

/** Read configuration once per request. Missing pieces mean the surface is unavailable. */
export function signingConfig(env = process.env) {
  const keys = parseSealingKeys(env.PDF_TOOLS_SIGN_SEALING_KEYS);
  const luminClientId = typeof env.PDF_TOOLS_LUMIN_CLIENT_ID === "string" && /^[\x21-\x7e]{1,512}$/.test(env.PDF_TOOLS_LUMIN_CLIENT_ID)
    ? env.PDF_TOOLS_LUMIN_CLIENT_ID : null;
  const luminClientSecret = typeof env.PDF_TOOLS_LUMIN_CLIENT_SECRET === "string" && env.PDF_TOOLS_LUMIN_CLIENT_SECRET
    ? env.PDF_TOOLS_LUMIN_CLIENT_SECRET : null;
  if (!keys || !luminClientId || env.PDF_TOOLS_SIGN_ENABLED !== "1") return null;
  return Object.freeze({ keys, luminClientId, luminClientSecret });
}

/** The externally visible origin. Vercel sets the host header to the requested domain. */
function originOf(request) {
  const url = new URL(request.url);
  return `https://${url.host}`;
}

export function isAllowedRedirectUri(value) {
  if (typeof value !== "string" || value.length > 2048) return false;
  if (ALLOWED_HTTPS_CALLBACKS.includes(value)) return true;
  let url;
  try { url = new URL(value); } catch { return false; }
  // Native and CLI clients (Claude Code) use a loopback listener on any port.
  return url.protocol === "http:"
    && (url.hostname === "127.0.0.1" || url.hostname === "localhost" || url.hostname === "[::1]")
    && !url.username && !url.password && !url.hash && url.href === value;
}

const sha256 = value => createHash("sha256").update(value).digest();
const b64url = buffer => Buffer.from(buffer).toString("base64url");
const clientDigest = clientId => b64url(sha256(`pdf-tools-sign:client:${clientId}`)).slice(0, 22);

function equalStrings(a, b) {
  const left = Buffer.from(String(a));
  const right = Buffer.from(String(b));
  return left.length === right.length && timingSafeEqual(left, right);
}

function json(status, body, extraHeaders = {}) {
  return new Response(JSON.stringify(body), { status, headers: { ...JSON_HEADERS, ...extraHeaders } });
}

function oauthError(status, error, description) {
  return json(status, { error, error_description: description });
}

function unavailable() {
  return json(503, { error: "temporarily_unavailable", error_description: "Hosted signing is not enabled on this deployment." });
}

/** A plain page for errors that must not redirect, because the redirect target is not trusted yet. */
function errorPage(status, message) {
  const body = `<!doctype html><meta charset="utf-8"><title>PDF Tools signing</title><p>${message.replace(/[<>&"]/g, "")}</p>`;
  return new Response(body, { status, headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store", "x-content-type-options": "nosniff", "content-security-policy": "default-src 'none'" } });
}

function redirect(location) {
  return new Response(null, { status: 302, headers: { location, "cache-control": "no-store", "referrer-policy": "no-referrer" } });
}

async function readBoundedText(request, limit) {
  const declared = request.headers.get("content-length");
  if (declared !== null && (!/^\d+$/.test(declared) || Number(declared) > limit)) return null;
  if (!request.body) return "";
  const reader = request.body.getReader();
  const chunks = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > limit) { await reader.cancel(); return null; }
    chunks.push(Buffer.from(value));
  }
  return Buffer.concat(chunks, total).toString("utf8");
}

export function protectedResourceMetadata(request) {
  const origin = originOf(request);
  return json(200, {
    resource: `${origin}${SIGN_RESOURCE_PATH}`,
    authorization_servers: [origin],
    scopes_supported: [SIGN_SCOPE],
    bearer_methods_supported: ["header"],
    resource_name: "PDF Tools signing (Lumin Sign)",
  });
}

export function authorizationServerMetadata(request) {
  const origin = originOf(request);
  return json(200, {
    issuer: origin,
    authorization_endpoint: `${origin}/oauth/authorize`,
    token_endpoint: `${origin}/oauth/token`,
    registration_endpoint: `${origin}/oauth/register`,
    response_types_supported: ["code"],
    grant_types_supported: ["authorization_code", "refresh_token"],
    code_challenge_methods_supported: ["S256"],
    token_endpoint_auth_methods_supported: ["none"],
    scopes_supported: [SIGN_SCOPE],
    authorization_response_iss_parameter_supported: true,
  });
}

/** RFC 7591 registration. The client_id carries its own redirect URIs. */
export async function register(request, config, now) {
  if (!config) return unavailable();
  const text = await readBoundedText(request, MAX_REGISTRATION_BYTES);
  let body;
  try { body = text === null ? null : JSON.parse(text); } catch { body = null; }
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    return oauthError(400, "invalid_client_metadata", "Registration needs a JSON object.");
  }
  const uris = body.redirect_uris;
  if (!Array.isArray(uris) || uris.length < 1 || uris.length > MAX_REDIRECT_URIS || new Set(uris).size !== uris.length) {
    return oauthError(400, "invalid_redirect_uri", "Supply 1 to 5 distinct redirect URIs.");
  }
  if (!uris.every(isAllowedRedirectUri)) {
    return oauthError(400, "invalid_redirect_uri", "Redirect URIs must be Claude's own callback or a loopback address.");
  }
  if (body.token_endpoint_auth_method !== undefined && body.token_endpoint_auth_method !== "none") {
    return oauthError(400, "invalid_client_metadata", "Only public clients with PKCE are supported.");
  }
  const clientName = typeof body.client_name === "string" ? body.client_name.slice(0, 100) : undefined;
  const issuedAt = now;
  const clientId = seal("client", { r: uris, ...(clientName ? { n: clientName } : {}) }, { keys: config.keys, expiresAt: issuedAt + CLIENT_TTL_SECONDS });
  return json(201, {
    client_id: clientId,
    client_id_issued_at: issuedAt,
    client_id_expires_at: issuedAt + CLIENT_TTL_SECONDS,
    redirect_uris: uris,
    ...(clientName ? { client_name: clientName } : {}),
    token_endpoint_auth_method: "none",
    grant_types: ["authorization_code", "refresh_token"],
    response_types: ["code"],
    scope: SIGN_SCOPE,
  });
}

function openClient(clientId, config, now) {
  try { return open("client", clientId, { keys: config.keys, now }); } catch { return null; }
}

/** Step 3: check the client, then send the person to Lumin with our own PKCE pair. */
export function authorize(request, config, now) {
  if (!config) return unavailable();
  const params = new URL(request.url).searchParams;
  const one = name => (params.getAll(name).length === 1 ? params.get(name) : null);
  const clientId = one("client_id");
  const redirectUri = one("redirect_uri");
  const client = clientId && openClient(clientId, config, now);
  if (!client || !redirectUri || !client.r.includes(redirectUri) || !isAllowedRedirectUri(redirectUri)) {
    return errorPage(400, "This sign-in link is not valid. Start again from Claude.");
  }
  const fail = (error, description) => {
    const target = new URL(redirectUri);
    target.searchParams.set("error", error);
    target.searchParams.set("error_description", description);
    if (params.get("state")) target.searchParams.set("state", params.get("state"));
    target.searchParams.set("iss", originOf(request));
    return redirect(target.href);
  };
  if (one("response_type") !== "code") return fail("unsupported_response_type", "Only the code flow is supported.");
  const challenge = one("code_challenge");
  if (one("code_challenge_method") !== "S256" || !challenge || !CHALLENGE_PATTERN.test(challenge)) {
    return fail("invalid_request", "PKCE with S256 is required.");
  }
  const state = params.get("state");
  if (state !== null && !STATE_PATTERN.test(state)) return fail("invalid_request", "Invalid state.");
  const scope = params.get("scope");
  if (scope !== null && scope.split(" ").some(item => item && item !== SIGN_SCOPE)) {
    return fail("invalid_scope", `The only scope is ${SIGN_SCOPE}.`);
  }
  const resource = params.get("resource");
  const expectedResource = `${originOf(request)}${SIGN_RESOURCE_PATH}`;
  if (resource !== null && resource !== expectedResource) return fail("invalid_target", "Unknown resource.");

  // Our own consent step comes before Lumin's (see the profile: confused deputy).
  const nonce = b64url(randomBytes(16));
  const pending = seal("consent", {
    c: clientDigest(clientId), u: redirectUri, s: state ?? undefined, x: challenge, h: b64url(sha256(`consent:${nonce}`)),
  }, { keys: config.keys, expiresAt: now + CONSENT_TTL_SECONDS });
  return consentPage({ pending, nonce, clientName: client.n, redirectUri });
}

const CONSENT_COOKIE = "__Host-pdftools_consent";
const CONSENT_TTL_SECONDS = 10 * 60;
const escapeHtml = value => String(value).replace(/[&<>"']/g, ch => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[ch]);

function consentPage({ pending, nonce, clientName, redirectUri }) {
  const where = new URL(redirectUri);
  const app = clientName ? escapeHtml(clientName) : "An AI app";
  const destination = escapeHtml(where.host);
  const body = `<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>Connect PDF Tools to Lumin</title>
<style>body{font:16px/1.5 system-ui,sans-serif;max-width:32rem;margin:3rem auto;padding:0 1rem;color:#1a1a1a}h1{font-size:1.3rem}ul{padding-left:1.2rem}button{font:inherit;padding:.6rem 1.2rem;margin-right:.5rem;border-radius:.4rem;border:1px solid #888;background:#fff;cursor:pointer}button[value=allow]{background:#1a1a1a;color:#fff;border-color:#1a1a1a}small{color:#555}</style>
<h1>Connect PDF Tools to your Lumin account?</h1>
<p><strong>${app}</strong> (returning to <strong>${destination}</strong>) is asking to use PDF Tools to send PDFs for signature with Lumin Sign on your behalf.</p>
<ul><li>You sign in to Lumin next. PDF Tools never sees your password.</li><li>Nothing is sent until you confirm each request in the conversation.</li><li>PDF Tools keeps no copy of your documents or your Lumin access.</li></ul>
<p>Only continue if you started connecting PDF Tools yourself just now.</p>
<form method="post" action="/oauth/authorize"><input type="hidden" name="pending" value="${escapeHtml(pending)}">
<button type="submit" name="decision" value="allow">Continue to Lumin</button><button type="submit" name="decision" value="deny">Cancel</button></form>
<p><small>Open Document Alliance. <a href="https://www.opendocuments.ai/privacy-policy">Privacy</a></small></p></html>`;
  return new Response(body, {
    status: 200,
    headers: {
      "content-type": "text/html; charset=utf-8",
      "cache-control": "no-store",
      "x-content-type-options": "nosniff",
      "x-frame-options": "DENY",
      "referrer-policy": "no-referrer",
      "content-security-policy": "default-src 'none'; style-src 'unsafe-inline'; form-action 'self' https://auth.luminpdf.com https://claude.ai https://claude.com http://localhost:* http://127.0.0.1:* http://[::1]:*; frame-ancestors 'none'; base-uri 'none'",
      "set-cookie": `${CONSENT_COOKIE}=${nonce}; Path=/; Secure; HttpOnly; SameSite=Strict; Max-Age=${CONSENT_TTL_SECONDS}`,
    },
  });
}

function readCookie(request, name) {
  for (const part of (request.headers.get("cookie") ?? "").split(";")) {
    const [key, ...rest] = part.trim().split("=");
    if (key === name) return rest.join("=");
  }
  return null;
}

const clearConsentCookie = `${CONSENT_COOKIE}=; Path=/; Secure; HttpOnly; SameSite=Strict; Max-Age=0`;

/**
 * The consent form's POST. It must carry the cookie set with the page, which a
 * cross-site auto-submitted form does not (SameSite=Strict), so a link someone
 * else started cannot skip the page.
 */
export async function authorizeDecision(request, config, now) {
  if (!config) return unavailable();
  const type = request.headers.get("content-type")?.split(";", 1)[0].trim().toLowerCase();
  const text = type === "application/x-www-form-urlencoded" ? await readBoundedText(request, MAX_FORM_BYTES) : null;
  const form = new URLSearchParams(text ?? "");
  let pending;
  try { pending = open("consent", form.get("pending") ?? "", { keys: config.keys, now }); } catch {
    return errorPage(400, "This sign-in has expired or is not valid. Start again from Claude.");
  }
  const nonce = readCookie(request, CONSENT_COOKIE);
  if (!nonce || !equalStrings(b64url(sha256(`consent:${nonce}`)), pending.h)) {
    return errorPage(403, "This sign-in could not be confirmed in this browser. Start again from Claude.");
  }
  const back = fields => {
    const target = new URL(pending.u);
    for (const [key, value] of Object.entries(fields)) target.searchParams.set(key, value);
    if (pending.s !== undefined) target.searchParams.set("state", pending.s);
    target.searchParams.set("iss", originOf(request));
    return new Response(null, { status: 303, headers: { location: target.href, "cache-control": "no-store", "referrer-policy": "no-referrer", "set-cookie": clearConsentCookie } });
  };
  if (form.get("decision") !== "allow") return back({ error: "access_denied", error_description: "The person cancelled." });

  const luminVerifier = b64url(randomBytes(32));
  const sealedState = seal("state", {
    c: pending.c, u: pending.u, s: pending.s, x: pending.x, v: luminVerifier,
  }, { keys: config.keys, expiresAt: now + STATE_TTL_SECONDS });
  const target = new URL(LUMIN_OAUTH_AUTHORIZATION_ENDPOINT);
  target.searchParams.set("client_id", config.luminClientId);
  target.searchParams.set("redirect_uri", `${originOf(request)}${LUMIN_CALLBACK_PATH}`);
  target.searchParams.set("response_type", "code");
  target.searchParams.set("scope", LUMIN_SCOPES.join(" "));
  target.searchParams.set("state", sealedState);
  target.searchParams.set("code_challenge", b64url(sha256(luminVerifier)));
  target.searchParams.set("code_challenge_method", "S256");
  return new Response(null, { status: 303, headers: { location: target.href, "cache-control": "no-store", "referrer-policy": "no-referrer", "set-cookie": clearConsentCookie } });
}

function luminForm(config, fields) {
  const form = new URLSearchParams({ client_id: config.luminClientId, ...fields });
  if (config.luminClientSecret) form.set("client_secret", config.luminClientSecret);
  return form;
}

/** Step 4: Lumin returns here. Exchange its code, then hand Claude a sealed code. */
export async function luminCallback(request, config, now, { fetchFn = globalThis.fetch } = {}) {
  if (!config) return unavailable();
  const params = new URL(request.url).searchParams;
  let state;
  try { state = open("state", params.get("state") ?? "", { keys: config.keys, now }); } catch {
    return errorPage(400, "This sign-in has expired or is not valid. Start again from Claude.");
  }
  const back = fields => {
    const target = new URL(state.u);
    for (const [key, value] of Object.entries(fields)) target.searchParams.set(key, value);
    if (state.s !== undefined) target.searchParams.set("state", state.s);
    target.searchParams.set("iss", originOf(request));
    return redirect(target.href);
  };
  if (params.get("error")) return back({ error: "access_denied", error_description: "Lumin authorization was not completed." });
  const code = params.get("code");
  if (!code || code.length > 4096) return back({ error: "server_error", error_description: "Lumin returned no authorization code." });
  let tokens;
  try {
    tokens = await exchangeLuminToken(luminForm(config, {
      grant_type: "authorization_code", code, code_verifier: state.v,
      redirect_uri: `${originOf(request)}${LUMIN_CALLBACK_PATH}`,
    }), { fetchFn, expectedScopes: [...LUMIN_SCOPES] });
  } catch {
    return back({ error: "server_error", error_description: "The Lumin token exchange failed." });
  }
  let sealedCode;
  try {
    sealedCode = seal("code", {
      c: state.c, u: state.u, x: state.x,
      a: tokens.accessToken, r: tokens.refreshToken ?? undefined, e: now + tokens.expiresIn,
    }, { keys: config.keys, expiresAt: now + CODE_TTL_SECONDS });
  } catch {
    return back({ error: "server_error", error_description: "The Lumin authorization could not be carried back." });
  }
  return back({ code: sealedCode });
}

function issueTokens(config, now, { access, refresh, luminExpiresAt, client }) {
  const accessExpiresAt = Math.min(luminExpiresAt, now + MAX_ACCESS_TTL_SECONDS);
  if (accessExpiresAt <= now) return oauthError(400, "invalid_grant", "The Lumin authorization has expired.");
  const body = {
    access_token: seal("access", { a: access }, { keys: config.keys, expiresAt: accessExpiresAt }),
    token_type: "Bearer",
    expires_in: accessExpiresAt - now,
    scope: SIGN_SCOPE,
  };
  if (refresh) body.refresh_token = seal("refresh", { r: refresh, c: client }, { keys: config.keys, expiresAt: now + REFRESH_TTL_SECONDS });
  return json(200, body);
}

/** Step 5 and 6: code exchange with PKCE, and refresh. */
export async function token(request, config, now, { fetchFn = globalThis.fetch } = {}) {
  if (!config) return unavailable();
  const type = request.headers.get("content-type")?.split(";", 1)[0].trim().toLowerCase();
  const text = type === "application/x-www-form-urlencoded" ? await readBoundedText(request, MAX_FORM_BYTES) : null;
  if (text === null) return oauthError(400, "invalid_request", "Send a form-encoded token request.");
  const form = new URLSearchParams(text);
  const clientId = form.get("client_id");
  if (!clientId || !openClient(clientId, config, now)) return oauthError(401, "invalid_client", "Unknown client.");
  const grant = form.get("grant_type");
  if (grant === "authorization_code") {
    let code;
    try { code = open("code", form.get("code") ?? "", { keys: config.keys, now }); } catch (error) {
      if (error instanceof SealRefused) return oauthError(400, "invalid_grant", "The authorization code is not valid or has expired.");
      throw error;
    }
    const verifier = form.get("code_verifier");
    if (!equalStrings(code.c, clientDigest(clientId)) || form.get("redirect_uri") !== code.u
      || !verifier || !PKCE_PATTERN.test(verifier) || !equalStrings(b64url(sha256(verifier)), code.x)) {
      return oauthError(400, "invalid_grant", "The authorization code does not match this request.");
    }
    return issueTokens(config, now, { access: code.a, refresh: code.r, luminExpiresAt: code.e, client: code.c });
  }
  if (grant === "refresh_token") {
    let refresh;
    try { refresh = open("refresh", form.get("refresh_token") ?? "", { keys: config.keys, now }); } catch (error) {
      if (error instanceof SealRefused) return oauthError(400, "invalid_grant", "The refresh token is not valid or has expired.");
      throw error;
    }
    if (!equalStrings(refresh.c, clientDigest(clientId))) return oauthError(400, "invalid_grant", "The refresh token belongs to another client.");
    let tokens;
    try {
      tokens = await exchangeLuminToken(luminForm(config, { grant_type: "refresh_token", refresh_token: refresh.r }), { fetchFn, expectedScopes: [...LUMIN_SCOPES] });
    } catch {
      return oauthError(400, "invalid_grant", "Lumin did not refresh this authorization. Connect again.");
    }
    return issueTokens(config, now, { access: tokens.accessToken, refresh: tokens.refreshToken ?? refresh.r, luminExpiresAt: now + tokens.expiresIn, client: refresh.c });
  }
  return oauthError(400, "unsupported_grant_type", "Use authorization_code or refresh_token.");
}

/**
 * Resource-server check for /mcp/sign. Returns the Lumin access token for this
 * request only, or a 401 that points the client at the metadata.
 */
export function authenticate(request, config, now) {
  const challenge = `Bearer resource_metadata="${originOf(request)}/.well-known/oauth-protected-resource${SIGN_RESOURCE_PATH}", scope="${SIGN_SCOPE}"`;
  const match = /^Bearer ([A-Za-z0-9._-]{1,16384})$/.exec(request.headers.get("authorization") ?? "");
  if (!match) return { response: json(401, { error: "invalid_token", error_description: "Connect PDF Tools to Lumin to use signing." }, { "www-authenticate": challenge }) };
  try {
    return { luminAccessToken: open("access", match[1], { keys: config.keys, now }).a };
  } catch {
    return { response: json(401, { error: "invalid_token", error_description: "The signing authorization has expired. Reconnect." }, { "www-authenticate": `${challenge}, error="invalid_token"` }) };
  }
}
