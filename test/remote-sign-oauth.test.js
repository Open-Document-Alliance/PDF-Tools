import { createHash, randomBytes } from "node:crypto";
import { describe, expect, it } from "vitest";

import {
  authenticate, authorizationServerMetadata, authorize, authorizeDecision, isAllowedRedirectUri, luminCallback,
  protectedResourceMetadata, register, signingConfig, token,
} from "../remote/sign-oauth.mjs";

const ORIGIN = "https://mcp.opendocuments.ai";
const NOW = 1_800_000_000;
const CALLBACK = "https://claude.ai/api/mcp/auth_callback";
const ENV = {
  PDF_TOOLS_SIGN_ENABLED: "1",
  PDF_TOOLS_SIGN_SEALING_KEYS: `k1:${"c".repeat(64)}`,
  PDF_TOOLS_LUMIN_CLIENT_ID: "synthetic-lumin-client",
  PDF_TOOLS_LUMIN_CLIENT_SECRET: "synthetic-lumin-secret",
};
const config = signingConfig(ENV);
const b64url = buffer => Buffer.from(buffer).toString("base64url");
const challengeOf = verifier => b64url(createHash("sha256").update(verifier).digest());

/** A fake Lumin token endpoint that records what it was sent. */
function fakeLumin({ accessToken = "synthetic-lumin-access", refreshToken = "synthetic-lumin-refresh", expiresIn = 3600, status = 200 } = {}) {
  const calls = [];
  const fetchFn = async (url, init) => {
    calls.push({ url, init, form: new URLSearchParams(init.body) });
    return new Response(JSON.stringify({ access_token: accessToken, refresh_token: refreshToken, token_type: "bearer", expires_in: expiresIn, scope: "openid profile.read sign:requests" }), {
      status, headers: { "content-type": "application/json" },
    });
  };
  return { fetchFn, calls };
}

async function registerClient(redirectUris = [CALLBACK], clientName = "Claude") {
  const response = await register(new Request(`${ORIGIN}/oauth/register`, {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ redirect_uris: redirectUris, client_name: clientName }),
  }), config, NOW);
  return { status: response.status, body: await response.json() };
}

function authorizeUrl(clientId, overrides = {}) {
  const verifier = overrides.verifier ?? b64url(randomBytes(32));
  const url = new URL(`${ORIGIN}/oauth/authorize`);
  const params = { response_type: "code", client_id: clientId, redirect_uri: CALLBACK, code_challenge: challengeOf(verifier), code_challenge_method: "S256", state: "claude-state-1", scope: "sign", resource: `${ORIGIN}/mcp/sign`, ...overrides.params };
  for (const [key, value] of Object.entries(params)) if (value !== null) url.searchParams.set(key, value);
  return { url: url.href, verifier };
}

/** Read the consent page: the sealed pending value and the cookie set with it. */
async function consent(page) {
  const html = await page.text();
  const pending = /name="pending" value="([^"]+)"/.exec(html)[1];
  const cookie = page.headers.get("set-cookie").split(";")[0];
  return { html, pending, cookie };
}

function decide({ pending, cookie, decision = "allow" }) {
  return authorizeDecision(new Request(`${ORIGIN}/oauth/authorize`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded", ...(cookie ? { cookie } : {}) },
    body: new URLSearchParams({ pending, decision }).toString(),
  }), config, NOW + 2);
}

async function fullFlow(lumin = fakeLumin()) {
  const { body: client } = await registerClient();
  const { url, verifier } = authorizeUrl(client.client_id);
  const page = authorize(new Request(url), config, NOW);
  const toLumin = await decide(await consent(page));
  const luminUrl = new URL(toLumin.headers.get("location"));
  const callback = await luminCallback(new Request(`${ORIGIN}/oauth/lumin/callback?code=synthetic-lumin-code&state=${encodeURIComponent(luminUrl.searchParams.get("state"))}`), config, NOW + 5, { fetchFn: lumin.fetchFn });
  const back = new URL(callback.headers.get("location"));
  const tokenResponse = await token(new Request(`${ORIGIN}/oauth/token`, {
    method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ grant_type: "authorization_code", code: back.searchParams.get("code"), code_verifier: verifier, redirect_uri: CALLBACK, client_id: client.client_id }).toString(),
  }), config, NOW + 10, { fetchFn: lumin.fetchFn });
  return { client, verifier, toLumin, luminUrl, callback, back, tokenResponse, lumin };
}

describe("hosted signing OAuth (stateless proxy to Lumin)", () => {
  it("is unavailable unless explicitly enabled and fully configured", async () => {
    expect(signingConfig({ ...ENV, PDF_TOOLS_SIGN_ENABLED: undefined })).toBeNull();
    expect(signingConfig({ ...ENV, PDF_TOOLS_SIGN_SEALING_KEYS: "bad" })).toBeNull();
    expect(signingConfig({ ...ENV, PDF_TOOLS_LUMIN_CLIENT_ID: "" })).toBeNull();
    const response = await register(new Request(`${ORIGIN}/oauth/register`, { method: "POST", body: "{}" }), null, NOW);
    expect(response.status).toBe(503);
  });

  it("publishes resource and authorization-server metadata for the signing path", async () => {
    const resource = await protectedResourceMetadata(new Request(`${ORIGIN}/.well-known/oauth-protected-resource/mcp/sign`)).json();
    expect(resource).toMatchObject({ resource: `${ORIGIN}/mcp/sign`, authorization_servers: [ORIGIN], scopes_supported: ["sign"] });
    const server = await authorizationServerMetadata(new Request(`${ORIGIN}/.well-known/oauth-authorization-server`)).json();
    expect(server).toMatchObject({ issuer: ORIGIN, code_challenge_methods_supported: ["S256"], token_endpoint_auth_methods_supported: ["none"] });
  });

  it("only registers Claude callbacks and loopback redirect URIs", async () => {
    expect(isAllowedRedirectUri(CALLBACK)).toBe(true);
    expect(isAllowedRedirectUri("https://claude.com/api/mcp/auth_callback")).toBe(true);
    expect(isAllowedRedirectUri("http://127.0.0.1:33418/callback")).toBe(true);
    expect(isAllowedRedirectUri("http://localhost:8080/cb")).toBe(true);
    for (const bad of ["https://evil.example/cb", "https://claude.ai.evil.example/api/mcp/auth_callback", "http://claude.ai/api/mcp/auth_callback", "http://10.0.0.1/cb", "http://user@127.0.0.1/cb", "javascript:alert(1)"]) {
      expect(isAllowedRedirectUri(bad), bad).toBe(false);
    }
    expect((await registerClient(["https://evil.example/cb"])).status).toBe(400);
    expect((await registerClient([CALLBACK, "https://evil.example/cb"])).status).toBe(400);
  });

  it("completes register, authorize, Lumin callback and code exchange without storing anything", async () => {
    const { toLumin, luminUrl, back, tokenResponse, lumin } = await fullFlow();
    expect(toLumin.status).toBe(303);
    expect(luminUrl.origin + luminUrl.pathname).toBe("https://auth.luminpdf.com/oauth2/auth");
    expect(luminUrl.searchParams.get("client_id")).toBe("synthetic-lumin-client");
    expect(luminUrl.searchParams.get("redirect_uri")).toBe(`${ORIGIN}/oauth/lumin/callback`);
    expect(luminUrl.searchParams.get("scope")).toBe("openid profile.read sign:requests");
    expect(luminUrl.searchParams.get("code_challenge_method")).toBe("S256");
    expect(back.origin + back.pathname).toBe(CALLBACK);
    expect(back.searchParams.get("state")).toBe("claude-state-1");
    expect(back.searchParams.get("iss")).toBe(ORIGIN);
    expect(back.searchParams.get("code")).not.toContain("synthetic-lumin-access");

    const [exchange] = lumin.calls;
    expect(exchange.init.headers["user-agent"]).toMatch(/^PDF-Tools\/\d+\.\d+\.\d+/);
    expect(exchange.form.get("grant_type")).toBe("authorization_code");
    expect(exchange.form.get("client_secret")).toBe("synthetic-lumin-secret");
    expect(challengeOf(exchange.form.get("code_verifier"))).toBe(luminUrl.searchParams.get("code_challenge"));

    expect(tokenResponse.status).toBe(200);
    const tokens = await tokenResponse.json();
    expect(tokens).toMatchObject({ token_type: "Bearer", scope: "sign" });
    expect(tokens.expires_in).toBeLessThanOrEqual(3600);
    expect(JSON.stringify(tokens)).not.toContain("synthetic-lumin");
    const authorized = authenticate(new Request(`${ORIGIN}/mcp/sign`, { headers: { authorization: `Bearer ${tokens.access_token}` } }), config, NOW + 20);
    expect(authorized.luminAccessToken).toBe("synthetic-lumin-access");
  });

  it("refuses a code exchange with the wrong verifier, client or redirect", async () => {
    const { client, back } = await fullFlow();
    const { body: other } = await registerClient();
    const attempt = fields => token(new Request(`${ORIGIN}/oauth/token`, {
      method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ grant_type: "authorization_code", code: back.searchParams.get("code"), redirect_uri: CALLBACK, client_id: client.client_id, code_verifier: b64url(randomBytes(32)), ...fields }).toString(),
    }), config, NOW + 10);
    expect((await attempt({})).status).toBe(400);
    expect((await attempt({ client_id: other.client_id })).status).toBe(400);
    expect((await attempt({ redirect_uri: "http://127.0.0.1:1/cb" })).status).toBe(400);
    expect((await attempt({ client_id: "not-a-client" })).status).toBe(401);
  });

  it("expires codes after a minute and refuses a code presented as an access token", async () => {
    const { client, verifier, back } = await fullFlow();
    const late = await token(new Request(`${ORIGIN}/oauth/token`, {
      method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ grant_type: "authorization_code", code: back.searchParams.get("code"), code_verifier: verifier, redirect_uri: CALLBACK, client_id: client.client_id }).toString(),
    }), config, NOW + 5 + 61);
    expect(late.status).toBe(400);
    const misuse = authenticate(new Request(`${ORIGIN}/mcp/sign`, { headers: { authorization: `Bearer ${back.searchParams.get("code")}` } }), config, NOW + 10);
    expect(misuse.response.status).toBe(401);
    expect(misuse.response.headers.get("www-authenticate")).toContain(`resource_metadata="${ORIGIN}/.well-known/oauth-protected-resource/mcp/sign"`);
  });

  it("never redirects to an unregistered URI, even with a valid client", async () => {
    const { body: client } = await registerClient();
    const { url } = authorizeUrl(client.client_id, { params: { redirect_uri: "http://127.0.0.1:9999/cb" } });
    const response = authorize(new Request(url), config, NOW);
    expect(response.status).toBe(400);
    expect(response.headers.get("location")).toBeNull();
  });

  it("returns authorize errors to the registered client and requires S256 PKCE", async () => {
    const { body: client } = await registerClient();
    const plain = authorize(new Request(authorizeUrl(client.client_id, { params: { code_challenge_method: "plain" } }).url), config, NOW);
    expect(new URL(plain.headers.get("location")).searchParams.get("error")).toBe("invalid_request");
    const scope = authorize(new Request(authorizeUrl(client.client_id, { params: { scope: "admin" } }).url), config, NOW);
    expect(new URL(scope.headers.get("location")).searchParams.get("error")).toBe("invalid_scope");
    const target = authorize(new Request(authorizeUrl(client.client_id, { params: { resource: "https://other.example/mcp" } }).url), config, NOW);
    expect(new URL(target.headers.get("location")).searchParams.get("error")).toBe("invalid_target");
  });

  it("shows its own consent page before Lumin, bound to the browser that saw it", async () => {
    const { body: client } = await registerClient([CALLBACK], "<script>alert(1)</script> Claude");
    const page = authorize(new Request(authorizeUrl(client.client_id).url), config, NOW);
    expect(page.status).toBe(200);
    expect(page.headers.get("x-frame-options")).toBe("DENY");
    expect(page.headers.get("content-security-policy")).toContain("frame-ancestors 'none'");
    expect(page.headers.get("set-cookie")).toMatch(/^__Host-pdftools_consent=[A-Za-z0-9_-]+; Path=\/; Secure; HttpOnly; SameSite=Strict/);
    const seen = await consent(page);
    expect(seen.html).not.toContain("<script>");
    expect(seen.html).toContain("&lt;script&gt;");
    expect(seen.html).toContain("claude.ai");

    const withoutCookie = await decide({ pending: seen.pending, cookie: null });
    expect(withoutCookie.status).toBe(403);
    expect(withoutCookie.headers.get("location")).toBeNull();
    const otherBrowser = await decide({ pending: seen.pending, cookie: "__Host-pdftools_consent=someone-elses-nonce" });
    expect(otherBrowser.status).toBe(403);
    const cancelled = await decide({ ...seen, decision: "deny" });
    expect(new URL(cancelled.headers.get("location")).searchParams.get("error")).toBe("access_denied");
    const late = await authorizeDecision(new Request(`${ORIGIN}/oauth/authorize`, {
      method: "POST", headers: { "content-type": "application/x-www-form-urlencoded", cookie: seen.cookie },
      body: new URLSearchParams({ pending: seen.pending, decision: "allow" }).toString(),
    }), config, NOW + 601);
    expect(late.status).toBe(400);
  });

  it("refuses a tampered or expired Lumin callback state without redirecting", async () => {
    const { luminUrl } = await fullFlow();
    const state = luminUrl.searchParams.get("state");
    const tampered = await luminCallback(new Request(`${ORIGIN}/oauth/lumin/callback?code=x&state=${encodeURIComponent(state.slice(0, -2) + "AA")}`), config, NOW);
    expect(tampered.status).toBe(400);
    expect(tampered.headers.get("location")).toBeNull();
    // The Lumin state is sealed at the consent decision (NOW + 2) for 10 minutes.
    const expired = await luminCallback(new Request(`${ORIGIN}/oauth/lumin/callback?code=x&state=${encodeURIComponent(state)}`), config, NOW + 2 + 600);
    expect(expired.status).toBe(400);
  });

  it("reports a declined Lumin authorization and a failed exchange back to Claude", async () => {
    const { luminUrl } = await fullFlow();
    const state = encodeURIComponent(luminUrl.searchParams.get("state"));
    const declined = await luminCallback(new Request(`${ORIGIN}/oauth/lumin/callback?error=access_denied&state=${state}`), config, NOW);
    expect(new URL(declined.headers.get("location")).searchParams.get("error")).toBe("access_denied");
    const failed = await luminCallback(new Request(`${ORIGIN}/oauth/lumin/callback?code=x&state=${state}`), config, NOW, { fetchFn: fakeLumin({ status: 400 }).fetchFn });
    expect(new URL(failed.headers.get("location")).searchParams.get("error")).toBe("server_error");
  });

  it("refreshes through Lumin and keeps the refresh token bound to its client", async () => {
    const { client, tokenResponse } = await fullFlow();
    const { refresh_token: refreshToken } = await tokenResponse.json();
    const lumin = fakeLumin({ accessToken: "synthetic-lumin-access-2", refreshToken: "synthetic-lumin-refresh-2" });
    const refreshed = await token(new Request(`${ORIGIN}/oauth/token`, {
      method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ grant_type: "refresh_token", refresh_token: refreshToken, client_id: client.client_id }).toString(),
    }), config, NOW + 4000, { fetchFn: lumin.fetchFn });
    expect(refreshed.status).toBe(200);
    expect(lumin.calls[0].form.get("refresh_token")).toBe("synthetic-lumin-refresh");
    const next = await refreshed.json();
    expect(authenticate(new Request(`${ORIGIN}/mcp/sign`, { headers: { authorization: `Bearer ${next.access_token}` } }), config, NOW + 4001).luminAccessToken).toBe("synthetic-lumin-access-2");
    const { body: other } = await registerClient();
    const stolen = await token(new Request(`${ORIGIN}/oauth/token`, {
      method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ grant_type: "refresh_token", refresh_token: refreshToken, client_id: other.client_id }).toString(),
    }), config, NOW + 4000, { fetchFn: lumin.fetchFn });
    expect(stolen.status).toBe(400);
  });

  it("asks for authorization with a pointer to the metadata when no token is sent", () => {
    const { response } = authenticate(new Request(`${ORIGIN}/mcp/sign`), config, NOW);
    expect(response.status).toBe(401);
    expect(response.headers.get("www-authenticate")).toMatch(/^Bearer resource_metadata="/);
  });
});
