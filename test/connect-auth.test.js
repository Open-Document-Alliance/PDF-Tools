import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import test from "node:test";
import { handleKeyIssuance, handleProtectedMcp, KEY_TTL_SECONDS, mintApiKey, verifyApiKey } from "../remote/connect-auth.mjs";

// Deliberately public test fixture; never a deployed signing secret.
const secret = "a".repeat(64);
const now = 1_790_812_000;
const options = { secret, now };
const issuanceUrl = "https://mcp.opendocuments.ai/api/connect-key";
const mcpUrl = "https://mcp.opendocuments.ai/mcp/connect";
function issueRequest(body = "{}", headers = {}) {
  return new Request(issuanceUrl, { method: "POST", headers: { "content-type": "application/json", ...headers }, body });
}
function mcpRequest(key, body = '{"jsonrpc":"2.0","id":1,"method":"tools/list"}') {
  return new Request(mcpUrl, { method: "POST", headers: key === undefined ? {} : { authorization: `Bearer ${key}`, "content-type": "application/json" }, body });
}

test("issued capabilities are unique, signed, and expire after 90 days", () => {
  const a = mintApiKey(secret, now);
  const b = mintApiKey(secret, now);
  assert.notEqual(a.apiKey, b.apiKey);
  assert.equal(a.expiresAt, now + KEY_TTL_SECONDS);
  assert.equal(verifyApiKey(a.apiKey, secret, now), true);
  assert.equal(verifyApiKey(a.apiKey, secret, now + KEY_TTL_SECONDS - 1), true);
  assert.equal(verifyApiKey(a.apiKey, secret, now + KEY_TTL_SECONDS), false);
  assert.equal(verifyApiKey(a.apiKey, secret, now - 30), true);
});

test("tampering, forged signatures, wrong secrets, and noncanonical keys are refused", () => {
  const { apiKey } = mintApiKey(secret, now);
  assert.equal(verifyApiKey(apiKey, "b".repeat(64), now), false);
  for (const key of [apiKey.replace("odapdf_v1", "odapdf_v2"), apiKey + "=", apiKey + " ", " " + apiKey, apiKey.slice(0, -1), apiKey.split(".").slice(0, 3).join(".") + "." + "A".repeat(43)]) {
    assert.equal(verifyApiKey(key, secret, now), false);
  }
  const parts = apiKey.split(".");
  parts[1] = (now + KEY_TTL_SECONDS + 1000).toString(36);
  assert.equal(verifyApiKey(parts.join("."), secret, now), false);
});

test("keys with a valid MAC but excessive lifetime or wrong audience are refused", () => {
  const unsigned = `odapdf_v1.${(now + KEY_TTL_SECONDS + 1000).toString(36)}.${"c".repeat(32)}`;
  const signature = createHmac("sha256", Buffer.from(secret, "hex")).update(`pdf-tools-connect:mcp:${unsigned}`).digest("base64url");
  assert.equal(verifyApiKey(`${unsigned}.${signature}`, secret, now), false);
  const validUnsigned = mintApiKey(secret, now).apiKey.split(".").slice(0, 3).join(".");
  const otherScope = createHmac("sha256", Buffer.from(secret, "hex")).update(`other-service:${validUnsigned}`).digest("base64url");
  assert.equal(verifyApiKey(`${validUnsigned}.${otherScope}`, secret, now), false);
});

test("missing or malformed signing configuration fails closed", async () => {
  for (const bad of [null, "", "short", "g".repeat(64), "a".repeat(63)]) {
    assert.throws(() => mintApiKey(bad, now));
    assert.equal(verifyApiKey("arbitrary", bad, now), false);
    assert.equal((await handleKeyIssuance(issueRequest(), { secret: bad, now })).status, 503);
    const response = await handleProtectedMcp(mcpRequest(), () => assert.fail("PDF handler must not run"), { secret: bad, now });
    assert.equal(response.status, 503);
  }
});

test("protected route rejects absent, expired, malformed, and forged credentials before reading the body", async () => {
  const expired = mintApiKey(secret, now - KEY_TTL_SECONDS).apiKey;
  for (const key of [undefined, "", "not-a-key", expired, mintApiKey("b".repeat(64), now).apiKey]) {
    const request = mcpRequest(key);
    const response = await handleProtectedMcp(request, () => assert.fail("unauthorized handler ran"), options);
    assert.equal(response.status, 401);
    assert.equal(request.bodyUsed, false);
    assert.match(response.headers.get("www-authenticate"), /Bearer/);
    assert.equal(response.headers.get("cache-control"), "no-store, private");
    const text = await response.text();
    if (key) assert.equal(text.includes(key), false);
  }
});

test("authorized delegation preserves MCP bytes, removes the key, and retains streaming response headers", async () => {
  const { apiKey } = mintApiKey(secret, now);
  const body = '{"jsonrpc":"2.0","id":17,"method":"tools/call","params":{"name":"read_form_fields","arguments":{"pdf_base64":"synthetic"}}}';
  let calls = 0;
  const response = await handleProtectedMcp(mcpRequest(apiKey, body), async (request) => {
    calls++;
    assert.equal(request.headers.has("authorization"), false);
    assert.equal(await request.text(), body);
    return new Response('event: message\ndata: {"jsonrpc":"2.0","id":17,"result":{}}\n\n', { headers: { "content-type": "text/event-stream", "x-test": "preserved" } });
  }, options);
  assert.equal(calls, 1);
  assert.equal(response.headers.get("content-type"), "text/event-stream");
  assert.equal(response.headers.get("x-test"), "preserved");
  assert.equal(response.headers.get("cache-control"), "no-store, private");
  assert.match(await response.text(), /"id":17/);
});

test("GET, DELETE, and OPTIONS cannot issue keys or invoke the PDF handler", async () => {
  for (const method of ["GET", "DELETE", "OPTIONS"]) {
    const response = await handleKeyIssuance(new Request(issuanceUrl, { method }), options);
    assert.equal(response.status, 405);
    assert.equal(response.headers.get("allow"), "POST");
    assert.equal((await handleProtectedMcp(new Request(mcpUrl, { method }), () => assert.fail("handler must not run"), options)).status, 405);
  }
});

test("issuance returns a working credential, expiry, no-store headers, and no CORS grant", async () => {
  const response = await handleKeyIssuance(issueRequest("{}", { origin: "https://mcp.opendocuments.ai" }), options);
  assert.equal(response.status, 201);
  const result = await response.json();
  assert.equal(verifyApiKey(result.apiKey, secret, now), true);
  assert.equal(Date.parse(result.expiresAt), (now + KEY_TTL_SECONDS) * 1000);
  assert.equal(response.headers.get("cache-control"), "no-store, private");
  assert.equal(response.headers.has("access-control-allow-origin"), false);
  assert.equal(Object.keys(result).length, 2);
  assert.equal((await handleKeyIssuance(issueRequest(), options)).status, 201);
});

test("cross-origin requests, non-JSON requests, caller identifiers, and malformed bodies are refused", async () => {
  assert.equal((await handleKeyIssuance(issueRequest("{}", { origin: "https://other.x1wealth.com" }), options)).status, 403);
  assert.equal((await handleKeyIssuance(issueRequest("{}", { "content-type": "text/plain" }), options)).status, 415);
  for (const body of ['{"email":"test@x1wealth.com"}', '{"pdf_base64":"anything"}', "[]", "null", "", "{"]) {
    assert.equal((await handleKeyIssuance(issueRequest(body), options)).status, 400);
  }
});

test("oversized bodies are refused with and without Content-Length", async () => {
  assert.equal((await handleKeyIssuance(issueRequest("{}", { "content-length": "513" }), options)).status, 413);
  assert.equal((await handleKeyIssuance(issueRequest(" ".repeat(513)), options)).status, 413);
  assert.equal((await handleKeyIssuance(issueRequest("{}", { "content-length": "invalid" }), options)).status, 413);
});
