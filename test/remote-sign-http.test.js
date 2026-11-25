import { describe, expect, it } from "vitest";

import { handleMcpFetch } from "../remote/http.mjs";
import { seal, parseSealingKeys } from "../remote/sealed.mjs";
import { handleSignFetch } from "../remote/sign-http.mjs";

const ORIGIN = "https://mcp.opendocuments.ai";
const NOW = Math.floor(Date.now() / 1000);
const KEYS = `k1:${"e".repeat(64)}`;
const ENV = { PDF_TOOLS_SIGN_ENABLED: "1", PDF_TOOLS_SIGN_SEALING_KEYS: KEYS, PDF_TOOLS_LUMIN_CLIENT_ID: "synthetic-client" };
const MCP_HEADERS = { "content-type": "application/json", accept: "application/json, text/event-stream", "mcp-protocol-version": "2025-11-25" };

async function mcp(handler, path, message, headers = {}) {
  const response = await handler(new Request(`${ORIGIN}${path}`, { method: "POST", headers: { ...MCP_HEADERS, ...headers }, body: JSON.stringify(message) }));
  const raw = await response.text();
  const data = raw.startsWith("{") ? raw : raw.split(/\r?\n/).filter(line => line.startsWith("data: ")).map(line => line.slice(6)).join("");
  return { status: response.status, headers: response.headers, message: data ? JSON.parse(data) : null };
}

describe("hosted signing HTTP surface", () => {
  it("is unavailable when not configured, whatever the path", async () => {
    for (const path of ["/mcp/sign", "/oauth/register", "/oauth/token"]) {
      const response = await handleSignFetch(new Request(`${ORIGIN}${path}`, { method: "POST" }), { env: {} });
      expect(response.status, path).toBe(503);
    }
    // Discovery stays "no auth here" so clients of the public /mcp are unaffected.
    for (const path of ["/.well-known/oauth-authorization-server", "/.well-known/oauth-protected-resource/mcp/sign"]) {
      const response = await handleSignFetch(new Request(`${ORIGIN}${path}`), { env: {} });
      expect(response.status, path).toBe(404);
    }
  });

  it("serves OAuth metadata and challenges unauthenticated MCP calls", async () => {
    const metadata = await handleSignFetch(new Request(`${ORIGIN}/.well-known/oauth-protected-resource/mcp/sign`), { env: ENV });
    expect((await metadata.json()).resource).toBe(`${ORIGIN}/mcp/sign`);
    const { status, headers } = await mcp(request => handleSignFetch(request, { env: ENV }), "/mcp/sign", { jsonrpc: "2.0", id: 1, method: "tools/list", params: {} });
    expect(status).toBe(401);
    expect(headers.get("www-authenticate")).toContain("resource_metadata=");
  });

  it("lists the signing tools for an authorized caller and carries the token into the isolated worker", async () => {
    const access = seal("access", { a: "synthetic-lumin-access" }, { keys: parseSealingKeys(KEYS), expiresAt: NOW + 600 });
    const handler = request => handleSignFetch(request, { env: ENV, now: NOW });
    const auth = { authorization: `Bearer ${access}` };
    const listed = await mcp(handler, "/mcp/sign", { jsonrpc: "2.0", id: 1, method: "tools/list", params: {} }, auth);
    expect(listed.status).toBe(200);
    const names = listed.message.result.tools.map(tool => tool.name);
    expect(names).toHaveLength(16);
    expect(names).toContain("send_lumin_request");
    // A refusal that is only reachable once the worker sees the Lumin connection.
    const called = await mcp(handler, "/mcp/sign", { jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "send_lumin_request", arguments: { preparation_token: "nope", confirmation_statement: "x", user_confirmed_at: new Date().toISOString() } } }, auth);
    expect(called.message.result.content[0].text).toMatch(/^(SIGNING_UNAVAILABLE|PREPARATION_INVALID)/);
    expect(called.message.result.content[0].text).not.toMatch(/LUMIN_NOT_CONNECTED|UNKNOWN_TOOL/);
  }, 60_000);

  it("leaves the public endpoint without signing tools", async () => {
    const listed = await mcp(handleMcpFetch, "/mcp", { jsonrpc: "2.0", id: 1, method: "tools/list", params: {} });
    expect(listed.message.result.tools).toHaveLength(12);
  });
});
