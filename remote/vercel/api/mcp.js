/**
 * Vercel entry point for the remote stateless MCP endpoint.
 *
 * The handler is Web-standard `fetch(Request) => Response`, and a fresh server
 * is built per request, so a serverless invocation behaves exactly like the
 * local listener in remote/http.mjs. Nothing is written to the function's
 * filesystem, which is what keeps property P1 true here as well.
 */

import { handleMcpFetch } from "../../http.mjs";

export const config = {
  runtime: "nodejs",
  maxDuration: 60,
};

export default async function handler(request) {
  return handleMcpFetch(request);
}
