import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import http from "node:http";
import { LUMIN_CLIENT_USER_AGENT } from "./lumin-client-identity.js";

export const LUMIN_OAUTH_AUTHORIZATION_ENDPOINT = "https://auth.luminpdf.com/oauth2/auth";
export const LUMIN_OAUTH_TOKEN_ENDPOINT = "https://auth.luminpdf.com/oauth2/token";
export const LUMIN_OAUTH_REGISTERED_REDIRECT_URI = "http://127.0.0.1/callback";

const CALLBACK_HOST = "127.0.0.1";
const CALLBACK_PATH = "/callback";
const MAX_CALLBACK_URL_BYTES = 8 * 1024;
const MAX_TOKEN_RESPONSE_BYTES = 64 * 1024;
const MAX_CLIENT_ID_BYTES = 512;
const MAX_CODE_BYTES = 4096;
const MAX_ERROR_BYTES = 256;
const MAX_SCOPES = 32;
const MIN_TIMEOUT_MS = 10;
const MAX_TIMEOUT_MS = 10 * 60 * 1000;
const SCOPE_PATTERN = /^[A-Za-z0-9][A-Za-z0-9:._-]{0,127}$/;

function oauthError(code, message) {
  const error = new Error(message);
  Object.defineProperty(error, "code", {
    value: code,
    enumerable: true,
    writable: false,
    configurable: false,
  });
  return error;
}

function assertBoundedString(value, { maxBytes, name }) {
  if (typeof value !== "string" || value !== value.trim() || value.length === 0) {
    throw oauthError("LUMIN_OAUTH_CONFIGURATION_INVALID", `Invalid ${name}.`);
  }
  if (Buffer.byteLength(value, "utf8") > maxBytes) {
    throw oauthError("LUMIN_OAUTH_CONFIGURATION_INVALID", `Invalid ${name}.`);
  }
  return value;
}

function validateClientId(value) {
  const clientId = assertBoundedString(value, { maxBytes: MAX_CLIENT_ID_BYTES, name: "client ID" });
  if (/\s/.test(clientId) || /[\u0000-\u001f\u007f]/.test(clientId)) {
    throw oauthError("LUMIN_OAUTH_CONFIGURATION_INVALID", "Invalid client ID.");
  }
  return clientId;
}

function validateScopes(value) {
  if (!Array.isArray(value) || value.length === 0 || value.length > MAX_SCOPES) {
    throw oauthError("LUMIN_OAUTH_CONFIGURATION_INVALID", "Invalid OAuth scopes.");
  }
  const scopes = value.map(scope => {
    if (typeof scope !== "string" || !SCOPE_PATTERN.test(scope)) {
      throw oauthError("LUMIN_OAUTH_CONFIGURATION_INVALID", "Invalid OAuth scopes.");
    }
    return scope;
  });
  if (new Set(scopes).size !== scopes.length) {
    throw oauthError("LUMIN_OAUTH_CONFIGURATION_INVALID", "Invalid OAuth scopes.");
  }
  return Object.freeze([...scopes]);
}

function validateTimeoutMs(value) {
  if (!Number.isSafeInteger(value) || value < MIN_TIMEOUT_MS || value > MAX_TIMEOUT_MS) {
    throw oauthError("LUMIN_OAUTH_CONFIGURATION_INVALID", "Invalid OAuth callback timeout.");
  }
  return value;
}

function base64Url(bytes) {
  return Buffer.from(bytes).toString("base64url");
}

function secureEqual(left, right) {
  const leftBytes = Buffer.from(left, "utf8");
  const rightBytes = Buffer.from(right, "utf8");
  return leftBytes.length === rightBytes.length && timingSafeEqual(leftBytes, rightBytes);
}

function onlyValue(searchParams, name) {
  const values = searchParams.getAll(name);
  return values.length === 1 ? values[0] : null;
}

function hasOnlyCallbackParameters(searchParams) {
  const allowed = new Set(["code", "error", "error_description", "scope", "state"]);
  for (const key of searchParams.keys()) {
    if (!allowed.has(key)) return false;
  }
  for (const key of allowed) {
    if (searchParams.getAll(key).length > 1) return false;
  }
  return true;
}

function hasExactReturnedScopes(value, expectedScopes) {
  if (
    typeof value !== "string"
    || value !== value.trim()
    || value.length === 0
    || Buffer.byteLength(value, "utf8") > 4096
  ) return false;
  const returnedScopes = value.split(/\s+/);
  return (
    returnedScopes.every(scope => SCOPE_PATTERN.test(scope))
    && returnedScopes.length === expectedScopes.length
    && new Set(returnedScopes).size === returnedScopes.length
    && expectedScopes.every(scope => returnedScopes.includes(scope))
  );
}

function respond(response, statusCode, message) {
  const body = `${message}\n`;
  response.writeHead(statusCode, {
    "cache-control": "no-store",
    "content-length": Buffer.byteLength(body),
    "content-type": "text/plain; charset=utf-8",
    "x-content-type-options": "nosniff",
  });
  response.end(body);
}

async function listenOnLoopback(server) {
  await new Promise((resolve, reject) => {
    const onError = error => {
      server.off("listening", onListening);
      reject(error);
    };
    const onListening = () => {
      server.off("error", onError);
      resolve();
    };
    server.once("error", onError);
    server.once("listening", onListening);
    server.listen({ host: CALLBACK_HOST, port: 0, exclusive: true });
  });
}

async function closeServer(server) {
  if (!server.listening) return;
  await new Promise(resolve => server.close(() => resolve()));
}

async function readBoundedResponse(response) {
  const declaredLength = response.headers.get("content-length");
  if (declaredLength !== null) {
    if (!/^\d+$/.test(declaredLength) || Number(declaredLength) > MAX_TOKEN_RESPONSE_BYTES) {
      throw oauthError("LUMIN_OAUTH_TOKEN_RESPONSE_INVALID", "Lumin returned an invalid token response.");
    }
  }
  if (!response.body || typeof response.body.getReader !== "function") {
    throw oauthError("LUMIN_OAUTH_TOKEN_RESPONSE_INVALID", "Lumin returned an invalid token response.");
  }
  const reader = response.body.getReader();
  const chunks = [];
  let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!(value instanceof Uint8Array)) {
        throw oauthError("LUMIN_OAUTH_TOKEN_RESPONSE_INVALID", "Lumin returned an invalid token response.");
      }
      total += value.byteLength;
      if (total > MAX_TOKEN_RESPONSE_BYTES) {
        throw oauthError("LUMIN_OAUTH_TOKEN_RESPONSE_INVALID", "Lumin returned an invalid token response.");
      }
      chunks.push(Buffer.from(value));
    }
  } finally {
    reader.releaseLock();
  }
  return Buffer.concat(chunks, total).toString("utf8");
}

function normalizeTokenResponse(value, expectedScopes) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw oauthError("LUMIN_OAUTH_TOKEN_RESPONSE_INVALID", "Lumin returned an invalid token response.");
  }
  let accessToken;
  let refreshToken = null;
  let scope = expectedScopes.join(" ");
  try {
    accessToken = assertBoundedString(value.access_token, {
      maxBytes: 16 * 1024,
      name: "access token",
    });
    if (value.refresh_token !== undefined) {
      refreshToken = assertBoundedString(value.refresh_token, {
        maxBytes: 16 * 1024,
        name: "refresh token",
      });
    }
    if (value.scope !== undefined) {
      const observedScope = assertBoundedString(value.scope, { maxBytes: 4096, name: "token scope" });
      const observedScopes = observedScope.split(/\s+/);
      if (
        observedScopes.length !== expectedScopes.length
        || new Set(observedScopes).size !== observedScopes.length
        || expectedScopes.some(expectedScope => !observedScopes.includes(expectedScope))
      ) {
        throw new Error("scope mismatch");
      }
    }
  } catch {
    throw oauthError("LUMIN_OAUTH_TOKEN_RESPONSE_INVALID", "Lumin returned an invalid token response.");
  }
  if (typeof value.token_type !== "string" || value.token_type.toLowerCase() !== "bearer") {
    throw oauthError("LUMIN_OAUTH_TOKEN_RESPONSE_INVALID", "Lumin returned an invalid token response.");
  }
  if (!Number.isSafeInteger(value.expires_in) || value.expires_in <= 0 || value.expires_in > 31_536_000) {
    throw oauthError("LUMIN_OAUTH_TOKEN_RESPONSE_INVALID", "Lumin returned an invalid token response.");
  }
  return Object.freeze({
    accessToken,
    expiresIn: value.expires_in,
    refreshToken,
    scope,
    tokenType: "Bearer",
  });
}

export async function createLuminOAuthLoopbackSession({
  clientId,
  scopes,
  timeoutMs = 5 * 60 * 1000,
}) {
  const validatedClientId = validateClientId(clientId);
  const validatedScopes = validateScopes(scopes);
  const validatedTimeoutMs = validateTimeoutMs(timeoutMs);
  const codeVerifier = base64Url(randomBytes(32));
  const codeChallenge = base64Url(createHash("sha256").update(codeVerifier, "ascii").digest());
  const expectedState = base64Url(randomBytes(32));
  let consumed = false;
  let callbackResult = null;
  let tokenExchangeStarted = false;
  let timeout = null;
  let settleCallback;
  let rejectCallback;

  const callbackPromise = new Promise((resolve, reject) => {
    settleCallback = resolve;
    rejectCallback = reject;
  });
  callbackPromise.catch(() => {});

  const server = http.createServer((request, response) => {
    const rejectRequest = (statusCode, message) => respond(response, statusCode, message);
    if (consumed) {
      rejectRequest(410, "This authorization callback has already been used.");
      return;
    }
    if (request.socket.remoteAddress !== CALLBACK_HOST) {
      rejectRequest(403, "Authorization callback rejected.");
      return;
    }
    if (request.method !== "GET") {
      rejectRequest(405, "Authorization callback rejected.");
      return;
    }
    if (typeof request.url !== "string" || Buffer.byteLength(request.url, "utf8") > MAX_CALLBACK_URL_BYTES) {
      rejectRequest(414, "Authorization callback rejected.");
      return;
    }
    const address = server.address();
    if (!address || typeof address === "string") {
      rejectRequest(500, "Authorization callback unavailable.");
      return;
    }
    const expectedHost = `${CALLBACK_HOST}:${address.port}`;
    if (request.headers.host !== expectedHost) {
      rejectRequest(400, "Authorization callback rejected.");
      return;
    }
    let callbackUrl;
    try {
      callbackUrl = new URL(request.url, `http://${expectedHost}`);
    } catch {
      rejectRequest(400, "Authorization callback rejected.");
      return;
    }
    if (callbackUrl.pathname !== CALLBACK_PATH) {
      rejectRequest(404, "Authorization callback rejected.");
      return;
    }
    if (!hasOnlyCallbackParameters(callbackUrl.searchParams)) {
      rejectRequest(400, "Authorization callback rejected.");
      return;
    }
    const state = onlyValue(callbackUrl.searchParams, "state");
    if (!state || !secureEqual(state, expectedState)) {
      rejectRequest(400, "Authorization callback rejected.");
      return;
    }
    const code = onlyValue(callbackUrl.searchParams, "code");
    const providerError = onlyValue(callbackUrl.searchParams, "error");
    const hasReturnedScope = callbackUrl.searchParams.has("scope");
    const returnedScope = onlyValue(callbackUrl.searchParams, "scope");
    if ((code && providerError) || (!code && !providerError)) {
      rejectRequest(400, "Authorization callback rejected.");
      return;
    }
    if (hasReturnedScope && (!code || !hasExactReturnedScopes(returnedScope, validatedScopes))) {
      rejectRequest(400, "Authorization callback rejected.");
      return;
    }
    if (code && Buffer.byteLength(code, "utf8") > MAX_CODE_BYTES) {
      rejectRequest(400, "Authorization callback rejected.");
      return;
    }
    if (providerError && Buffer.byteLength(providerError, "utf8") > MAX_ERROR_BYTES) {
      rejectRequest(400, "Authorization callback rejected.");
      return;
    }
    consumed = true;
    clearTimeout(timeout);
    if (providerError) {
      respond(response, 400, "Lumin authorization was not completed. You can close this window.");
      rejectCallback(oauthError("LUMIN_OAUTH_PROVIDER_ERROR", "Lumin authorization was not completed."));
    } else {
      callbackResult = Object.freeze({ code, redirectUri });
      respond(response, 200, "Lumin authorization completed. You can close this window.");
      settleCallback(callbackResult);
    }
    void closeServer(server);
  });
  server.requestTimeout = 10_000;
  server.headersTimeout = 10_000;
  server.keepAliveTimeout = 1_000;
  server.maxRequestsPerSocket = 10;

  try {
    await listenOnLoopback(server);
  } catch {
    throw oauthError("LUMIN_OAUTH_CALLBACK_UNAVAILABLE", "Unable to open the local Lumin authorization callback.");
  }
  const address = server.address();
  if (!address || typeof address === "string" || address.address !== CALLBACK_HOST || address.port <= 0) {
    await closeServer(server);
    throw oauthError("LUMIN_OAUTH_CALLBACK_UNAVAILABLE", "Unable to open the local Lumin authorization callback.");
  }
  const redirectUri = `http://${CALLBACK_HOST}:${address.port}${CALLBACK_PATH}`;
  const authorizationUrl = new URL(LUMIN_OAUTH_AUTHORIZATION_ENDPOINT);
  authorizationUrl.searchParams.set("client_id", validatedClientId);
  authorizationUrl.searchParams.set("code_challenge", codeChallenge);
  authorizationUrl.searchParams.set("code_challenge_method", "S256");
  authorizationUrl.searchParams.set("redirect_uri", redirectUri);
  authorizationUrl.searchParams.set("response_type", "code");
  authorizationUrl.searchParams.set("scope", validatedScopes.join(" "));
  authorizationUrl.searchParams.set("state", expectedState);

  server.on("error", () => {
    if (consumed) return;
    consumed = true;
    clearTimeout(timeout);
    rejectCallback(oauthError("LUMIN_OAUTH_CALLBACK_UNAVAILABLE", "The local Lumin authorization callback failed."));
  });

  timeout = setTimeout(() => {
    if (consumed) return;
    consumed = true;
    rejectCallback(oauthError("LUMIN_OAUTH_CALLBACK_TIMEOUT", "Lumin authorization timed out."));
    void closeServer(server);
  }, validatedTimeoutMs);
  timeout.unref();

  return Object.freeze({
    authorizationUrl: authorizationUrl.href,
    callbackPort: address.port,
    redirectUri,
    registeredRedirectUri: LUMIN_OAUTH_REGISTERED_REDIRECT_URI,
    scopes: validatedScopes,
    async close() {
      if (!consumed) {
        consumed = true;
        clearTimeout(timeout);
        rejectCallback(oauthError("LUMIN_OAUTH_SESSION_CLOSED", "Lumin authorization was closed."));
      }
      await closeServer(server);
    },
    async exchangeToken(result, { fetchFn = globalThis.fetch } = {}) {
      if (!callbackResult || result !== callbackResult || tokenExchangeStarted || typeof fetchFn !== "function") {
        throw oauthError("LUMIN_OAUTH_TOKEN_REQUEST_INVALID", "Invalid Lumin token request.");
      }
      tokenExchangeStarted = true;
      const form = new URLSearchParams();
      form.set("client_id", validatedClientId);
      form.set("code", callbackResult.code);
      form.set("code_verifier", codeVerifier);
      form.set("grant_type", "authorization_code");
      form.set("redirect_uri", redirectUri);
      let response;
      try {
        response = await fetchFn(LUMIN_OAUTH_TOKEN_ENDPOINT, {
          method: "POST",
          headers: {
            accept: "application/json",
            "content-type": "application/x-www-form-urlencoded",
            "user-agent": LUMIN_CLIENT_USER_AGENT,
          },
          body: form.toString(),
          redirect: "error",
        });
      } catch {
        throw oauthError("LUMIN_OAUTH_TOKEN_REQUEST_FAILED", "Lumin token exchange failed.");
      }
      if (!(response instanceof Response) || !response.ok) {
        throw oauthError("LUMIN_OAUTH_TOKEN_REQUEST_FAILED", "Lumin token exchange failed.");
      }
      const contentType = response.headers.get("content-type")?.split(";", 1)[0].trim().toLowerCase();
      if (contentType !== "application/json") {
        throw oauthError("LUMIN_OAUTH_TOKEN_RESPONSE_INVALID", "Lumin returned an invalid token response.");
      }
      let parsed;
      try {
        parsed = JSON.parse(await readBoundedResponse(response));
      } catch (error) {
        if (error?.code === "LUMIN_OAUTH_TOKEN_RESPONSE_INVALID") throw error;
        throw oauthError("LUMIN_OAUTH_TOKEN_RESPONSE_INVALID", "Lumin returned an invalid token response.");
      }
      return normalizeTokenResponse(parsed, validatedScopes);
    },
    waitForCallback() {
      return callbackPromise;
    },
  });
}
