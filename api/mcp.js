/**
 * Vercel entry point for the remote stateless MCP endpoint.
 *
 * Named method exports on purpose. A `default` export in `api/` is given the
 * Node `(req, res)` signature and its return value is ignored, so a handler
 * that returns a `Response` hangs until the function times out. Exporting
 * `POST` selects the Web `fetch` style, which is what `handleMcpFetch` speaks.
 *
 * A fresh server is built per request, so a serverless invocation behaves
 * exactly like the local listener in remote/http.mjs, and nothing is written to
 * the function's filesystem, which is what keeps property P1 true here too.
 */

import { handleMcpFetch } from "../remote/http.mjs";

export const config = {
  runtime: "nodejs",
  maxDuration: 60,
};

export function POST(request) {
  return handleMcpFetch(request);
}

/** Stateless serving has no session to resume or delete, so say so plainly. */
function methodNotAllowed() {
  return new Response(
    JSON.stringify({ jsonrpc: "2.0", error: { code: -32000, message: "Use POST." }, id: null }),
    { status: 405, headers: { "content-type": "application/json", allow: "POST" } },
  );
}

export const GET = methodNotAllowed;
export const DELETE = methodNotAllowed;
