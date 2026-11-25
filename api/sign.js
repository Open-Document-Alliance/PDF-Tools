/**
 * Vercel entry for the hosted signing surface (/mcp/sign and its OAuth
 * endpoints). Returns 503 until hosted signing is configured; see
 * docs/REMOTE_SIGNING_PROFILE_2026-11-25.md. Named method exports select the
 * Web fetch style, as in api/mcp.js.
 *
 * Vercel rewrites the public path to /api/sign; the original path arrives in
 * the x-pdf-tools-path query parameter set by the rewrite, so routing sees the
 * path the client actually used.
 */
import { handleSignFetch } from "../remote/sign-http.mjs";
import { isolationMode } from "../remote/isolated-tool.mjs";

// Start the per-instance isolation boot check when the function loads, so the
// first request does not wait for it (it takes about 0.6 s on Vercel).
void isolationMode();

export const config = { runtime: "nodejs", maxDuration: 60 };

function withOriginalPath(request) {
  const url = new URL(request.url);
  const original = url.searchParams.get("x-pdf-tools-path");
  if (!original || !/^\/(?:mcp\/sign|oauth\/[a-z/]+|\.well-known\/[a-z/-]+)$/.test(original)) return request;
  url.searchParams.delete("x-pdf-tools-path");
  url.pathname = original;
  return new Request(url, request);
}

const handle = request => handleSignFetch(withOriginalPath(request));
export const GET = handle;
export const POST = handle;
