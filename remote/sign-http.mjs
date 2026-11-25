/**
 * HTTP entry for the hosted signing surface: OAuth endpoints and /mcp/sign.
 * Disabled (503) unless signingConfig() finds the feature flag, sealing keys
 * and the hosted Lumin client ID. The public /mcp handler is separate and
 * unchanged; nothing here is reachable through it.
 */
import { createMcpHandler } from "@modelcontextprotocol/server";

import { callToolIsolated } from "./isolated-tool.mjs";
import { MAX_HANDLER_BODY_BYTES } from "./http.mjs";
import { createRemoteServer } from "./server.mjs";
import {
  authenticate, authorizationServerMetadata, authorize, authorizeDecision, luminCallback, protectedResourceMetadata,
  register, signingConfig, token,
} from "./sign-oauth.mjs";

const unavailable = () => new Response(
  JSON.stringify({ error: "temporarily_unavailable", error_description: "Hosted signing is not enabled on this deployment." }),
  { status: 503, headers: { "content-type": "application/json", "cache-control": "no-store" } },
);
const notFound = () => new Response(JSON.stringify({ error: "not_found" }), { status: 404, headers: { "content-type": "application/json" } });
const methodNotAllowed = allow => new Response(JSON.stringify({ error: "method_not_allowed" }), { status: 405, headers: { "content-type": "application/json", allow } });

/** Errors are reported without request content or credentials (P4, S4). */
const onerror = error => process.stderr.write(`sign error: ${error?.name ?? "Error"}\n`);

async function handleSignedMcp(request, config, now) {
  const auth = authenticate(request, config, now);
  if (auth.response) return auth.response;
  // A handler per request: the Lumin token belongs to this request only.
  const handler = createMcpHandler(
    () => createRemoteServer({ dispatchTool: callToolIsolated, signing: { luminAccessToken: auth.luminAccessToken } }),
    { maxRequestBodySize: MAX_HANDLER_BODY_BYTES, onerror },
  );
  return handler.fetch(request);
}

export async function handleSignFetch(request, { env = process.env, now = Math.floor(Date.now() / 1000), fetchFn } = {}) {
  const config = signingConfig(env);
  const { pathname } = new URL(request.url);
  const method = request.method;
  if (!config) return unavailable();
  switch (pathname) {
    case "/.well-known/oauth-protected-resource/mcp/sign":
      return method === "GET" ? protectedResourceMetadata(request) : methodNotAllowed("GET");
    case "/.well-known/oauth-authorization-server":
      return method === "GET" ? authorizationServerMetadata(request) : methodNotAllowed("GET");
    case "/oauth/register":
      return method === "POST" ? register(request, config, now) : methodNotAllowed("POST");
    case "/oauth/authorize":
      if (method === "GET") return authorize(request, config, now);
      return method === "POST" ? authorizeDecision(request, config, now) : methodNotAllowed("GET, POST");
    case "/oauth/lumin/callback":
      return method === "GET" ? luminCallback(request, config, now, fetchFn ? { fetchFn } : {}) : methodNotAllowed("GET");
    case "/oauth/token":
      return method === "POST" ? token(request, config, now, fetchFn ? { fetchFn } : {}) : methodNotAllowed("POST");
    case "/mcp/sign":
      return method === "POST" ? handleSignedMcp(request, config, now) : methodNotAllowed("POST");
    default:
      return notFound();
  }
}
