import http from "node:http";
import { createHash } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import { LUMIN_CLIENT_USER_AGENT } from "../server/lumin-client-identity.js";
import {
  LUMIN_OAUTH_AUTHORIZATION_ENDPOINT,
  LUMIN_OAUTH_REGISTERED_REDIRECT_URI,
  LUMIN_OAUTH_TOKEN_ENDPOINT,
  createLuminOAuthLoopbackSession,
} from "../server/lumin-oauth-loopback.js";

const sessions = new Set();

async function createSession(options = {}) {
  const session = await createLuminOAuthLoopbackSession({
    clientId: "pdf-tools-public-client",
    scopes: ["openid", "profile.read", "sign:requests", "sign:requests.read"],
    timeoutMs: 10_000,
    ...options,
  });
  sessions.add(session);
  return session;
}

async function request(url, options = {}) {
  const response = await fetch(url, { redirect: "manual", ...options });
  return { status: response.status, text: await response.text() };
}

async function rawRequest({ port, path, method = "GET", host }) {
  return new Promise((resolve, reject) => {
    const request = http.request({
      host: "127.0.0.1",
      port,
      path,
      method,
      headers: host === undefined ? undefined : { host },
    }, response => {
      const chunks = [];
      response.on("data", chunk => chunks.push(chunk));
      response.on("end", () => resolve({
        status: response.statusCode,
        text: Buffer.concat(chunks).toString("utf8"),
      }));
    });
    request.on("error", reject);
    request.end();
  });
}

function callbackParameters(session) {
  const authorizationUrl = new URL(session.authorizationUrl);
  return {
    state: authorizationUrl.searchParams.get("state"),
    challenge: authorizationUrl.searchParams.get("code_challenge"),
  };
}

afterEach(async () => {
  await Promise.all([...sessions].map(session => session.close()));
  sessions.clear();
});

describe("Lumin OAuth loopback PKCE", () => {
  it("binds only an ephemeral IPv4 loopback port and builds Lumin's confirmed redirect pattern", async () => {
    const session = await createSession();
    const authorizationUrl = new URL(session.authorizationUrl);
    const { challenge, state } = callbackParameters(session);

    expect(authorizationUrl.origin + authorizationUrl.pathname).toBe(LUMIN_OAUTH_AUTHORIZATION_ENDPOINT);
    expect(session.registeredRedirectUri).toBe(LUMIN_OAUTH_REGISTERED_REDIRECT_URI);
    expect(session.redirectUri).toBe(`http://127.0.0.1:${session.callbackPort}/callback`);
    expect(session.callbackPort).toBeGreaterThan(0);
    expect(authorizationUrl.searchParams.get("client_id")).toBe("pdf-tools-public-client");
    expect(authorizationUrl.searchParams.get("redirect_uri")).toBe(session.redirectUri);
    expect(authorizationUrl.searchParams.get("response_type")).toBe("code");
    expect(authorizationUrl.searchParams.get("scope")).toBe(
      "openid profile.read sign:requests sign:requests.read",
    );
    expect(authorizationUrl.searchParams.get("code_challenge_method")).toBe("S256");
    expect(challenge).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(state).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(challenge).not.toBe(state);
  });

  it("accepts one exact state-bound callback and closes the listener", async () => {
    const session = await createSession();
    const { state } = callbackParameters(session);
    const response = await request(`${session.redirectUri}?code=authorization-code&state=${state}`);
    const result = await session.waitForCallback();

    expect(response).toEqual({
      status: 200,
      text: "Lumin authorization completed. You can close this window.\n",
    });
    expect(result).toEqual({ code: "authorization-code", redirectUri: session.redirectUri });
    await expect(fetch(session.redirectUri)).rejects.toThrow();
  });

  it("accepts Lumin's exact granted scope callback without weakening scope binding", async () => {
    const session = await createSession();
    const { state } = callbackParameters(session);
    const grantedScope = "openid profile.read sign:requests sign:requests.read";
    const response = await request(
      `${session.redirectUri}?code=authorization-code&scope=${encodeURIComponent(grantedScope)}&state=${state}`,
    );

    expect(response.status).toBe(200);
    await expect(session.waitForCallback()).resolves.toEqual({
      code: "authorization-code",
      redirectUri: session.redirectUri,
    });
  });

  it("does not consume the session on wrong path, method, host, state, or unknown parameters", async () => {
    const session = await createSession();
    const { state } = callbackParameters(session);
    expect((await request(`http://127.0.0.1:${session.callbackPort}/wrong?code=x&state=${state}`)).status).toBe(404);
    expect((await rawRequest({ port: session.callbackPort, path: `/callback?code=x&state=${state}`, method: "POST" })).status).toBe(405);
    expect((await rawRequest({ port: session.callbackPort, path: `/callback?code=x&state=${state}`, host: "attacker.example" })).status).toBe(400);
    expect((await request(`${session.redirectUri}?code=x&state=wrong`)).status).toBe(400);
    expect((await request(`${session.redirectUri}?code=x&state=${state}&credential=smuggled`)).status).toBe(400);

    expect((await request(`${session.redirectUri}?code=right&state=${state}`)).status).toBe(200);
    await expect(session.waitForCallback()).resolves.toMatchObject({ code: "right" });
  });

  it("rejects duplicate, mixed, missing, and oversized callback values without consuming the session", async () => {
    const session = await createSession();
    const { state } = callbackParameters(session);
    const attacks = [
      `?code=one&code=two&state=${state}`,
      `?code=one&state=${state}&state=${state}`,
      `?code=one&error=denied&state=${state}`,
      `?state=${state}`,
      `?code=${"x".repeat(4097)}&state=${state}`,
      `?code=one&scope=&state=${state}`,
      `?code=one&scope=openid&state=${state}`,
      `?code=one&scope=${encodeURIComponent("openid profile.read sign:requests sign:requests.read extra")}&state=${state}`,
      `?code=one&scope=${encodeURIComponent("openid profile.read sign:requests sign:requests")}&state=${state}`,
      `?code=one&scope=${encodeURIComponent("openid profile.read sign:requests bad/scope")}&state=${state}`,
      `?code=one&scope=openid&scope=openid&state=${state}`,
      `?error=access_denied&scope=${encodeURIComponent("openid profile.read sign:requests sign:requests.read")}&state=${state}`,
    ];
    for (const query of attacks) {
      expect((await request(`${session.redirectUri}${query}`)).status).toBe(400);
    }
    expect((await request(`${session.redirectUri}?code=valid&state=${state}`)).status).toBe(200);
    await expect(session.waitForCallback()).resolves.toMatchObject({ code: "valid" });
  });

  it("returns a sanitized failure for an exact state-bound provider denial", async () => {
    const session = await createSession();
    const { state } = callbackParameters(session);
    const response = await request(
      `${session.redirectUri}?error=access_denied&error_description=${encodeURIComponent("secret provider detail")}&state=${state}`,
    );
    expect(response.status).toBe(400);
    await expect(session.waitForCallback()).rejects.toMatchObject({
      code: "LUMIN_OAUTH_PROVIDER_ERROR",
      message: "Lumin authorization was not completed.",
    });
  });

  it("times out or closes without leaving a listening callback", async () => {
    const timed = await createSession({ timeoutMs: 20 });
    await expect(timed.waitForCallback()).rejects.toMatchObject({ code: "LUMIN_OAUTH_CALLBACK_TIMEOUT" });
    await expect(fetch(timed.redirectUri)).rejects.toThrow();

    const closed = await createSession();
    const wait = closed.waitForCallback();
    await closed.close();
    await expect(wait).rejects.toMatchObject({ code: "LUMIN_OAUTH_SESSION_CLOSED" });
    await expect(fetch(closed.redirectUri)).rejects.toThrow();
  });

  it("exchanges the exact callback code with PKCE and no client secret", async () => {
    const session = await createSession();
    const { state, challenge } = callbackParameters(session);
    await request(`${session.redirectUri}?code=one-time-code&state=${state}`);
    const callback = await session.waitForCallback();
    const fetchFn = vi.fn(async (url, options) => {
      const body = new URLSearchParams(options.body);
      const verifier = body.get("code_verifier");
      expect(url).toBe(LUMIN_OAUTH_TOKEN_ENDPOINT);
      expect(options).toMatchObject({
        method: "POST",
        redirect: "error",
        headers: {
          accept: "application/json",
          "content-type": "application/x-www-form-urlencoded",
          "user-agent": LUMIN_CLIENT_USER_AGENT,
        },
      });
      expect(body.get("client_id")).toBe("pdf-tools-public-client");
      expect(body.get("code")).toBe("one-time-code");
      expect(body.get("grant_type")).toBe("authorization_code");
      expect(body.get("redirect_uri")).toBe(session.redirectUri);
      expect(body.has("client_secret")).toBe(false);
      expect(verifier).toMatch(/^[A-Za-z0-9_-]{43}$/);
      expect(createHash("sha256").update(verifier, "ascii").digest("base64url")).toBe(challenge);
      return new Response(JSON.stringify({
        access_token: "access-token",
        expires_in: 3600,
        refresh_token: "refresh-token",
        scope: "sign:requests.read sign:requests profile.read openid",
        token_type: "bearer",
      }), { headers: { "content-type": "application/json" } });
    });

    await expect(session.exchangeToken(callback, { fetchFn })).resolves.toEqual({
      accessToken: "access-token",
      expiresIn: 3600,
      refreshToken: "refresh-token",
      scope: "openid profile.read sign:requests sign:requests.read",
      tokenType: "Bearer",
    });
    expect(fetchFn).toHaveBeenCalledTimes(1);
    await expect(session.exchangeToken(callback, { fetchFn })).rejects.toMatchObject({
      code: "LUMIN_OAUTH_TOKEN_REQUEST_INVALID",
    });
    expect(fetchFn).toHaveBeenCalledTimes(1);
  });

  it("will not exchange a copied, forged, or pre-callback authorization code", async () => {
    const session = await createSession();
    await expect(session.exchangeToken({ code: "forged", redirectUri: session.redirectUri }, {
      fetchFn: vi.fn(),
    })).rejects.toMatchObject({ code: "LUMIN_OAUTH_TOKEN_REQUEST_INVALID" });
    const { state } = callbackParameters(session);
    await request(`${session.redirectUri}?code=real&state=${state}`);
    const callback = await session.waitForCallback();
    await expect(session.exchangeToken({ ...callback }, { fetchFn: vi.fn() })).rejects.toMatchObject({
      code: "LUMIN_OAUTH_TOKEN_REQUEST_INVALID",
    });
  });

  it("fails closed on transport, status, media type, size, JSON, and token-shape errors", async () => {
    async function acceptedSession() {
      const session = await createSession();
      const { state } = callbackParameters(session);
      await request(`${session.redirectUri}?code=real&state=${state}`);
      return { session, callback: await session.waitForCallback() };
    }
    const cases = [
      async () => { throw new Error("network detail"); },
      async () => new Response("denied", { status: 401, headers: { "content-type": "application/json" } }),
      async () => new Response("{}", { headers: { "content-type": "text/html" } }),
      async () => new Response("{}", {
        headers: { "content-length": String(64 * 1024 + 1), "content-type": "application/json" },
      }),
      async () => new Response("{", { headers: { "content-type": "application/json" } }),
      async () => new Response(JSON.stringify({ expires_in: 3600, token_type: "Bearer" }), {
        headers: { "content-type": "application/json" },
      }),
      async () => new Response(JSON.stringify({
        access_token: "x",
        expires_in: 3600,
        scope: "openid",
        token_type: "Bearer",
      }), { headers: { "content-type": "application/json" } }),
      async () => new Response(JSON.stringify({ access_token: "x", expires_in: 3600, token_type: "MAC" }), {
        headers: { "content-type": "application/json" },
      }),
    ];
    for (const fetchFn of cases) {
      const { session, callback } = await acceptedSession();
      await expect(session.exchangeToken(callback, { fetchFn })).rejects.toMatchObject({
        code: expect.stringMatching(/^LUMIN_OAUTH_TOKEN_/),
      });
    }
  });

  it("fails closed on malformed local configuration", async () => {
    await expect(createLuminOAuthLoopbackSession({ clientId: " id ", scopes: ["openid"] })).rejects.toMatchObject({
      code: "LUMIN_OAUTH_CONFIGURATION_INVALID",
    });
    await expect(createLuminOAuthLoopbackSession({ clientId: "id", scopes: ["openid", "openid"] })).rejects.toMatchObject({
      code: "LUMIN_OAUTH_CONFIGURATION_INVALID",
    });
    await expect(createLuminOAuthLoopbackSession({ clientId: "id", scopes: ["bad scope"] })).rejects.toMatchObject({
      code: "LUMIN_OAUTH_CONFIGURATION_INVALID",
    });
    await expect(createLuminOAuthLoopbackSession({ clientId: "id", scopes: ["openid"], timeoutMs: 0 })).rejects.toMatchObject({
      code: "LUMIN_OAUTH_CONFIGURATION_INVALID",
    });
  });
});
