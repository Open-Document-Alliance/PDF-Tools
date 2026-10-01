/** Optional, account-free API keys for the separate Connect endpoint.
 * Keys are signed capabilities for stateless PDF processing, not user identity
 * or access to stored documents. Individual keys are never persisted.
 */
import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";

export const KEY_TTL_SECONDS = 90 * 24 * 60 * 60;
const KEY_PREFIX = "odapdf_v1";
const MAX_ISSUE_BODY_BYTES = 512;
const HEADERS = {
  "content-type": "application/json",
  "cache-control": "no-store, private",
  "x-content-type-options": "nosniff",
};

function configured(secret) {
  return typeof secret === "string" && /^[a-f0-9]{64}$/.test(secret);
}

function sign(unsigned, secret) {
  return createHmac("sha256", Buffer.from(secret, "hex"))
    .update(`pdf-tools-connect:mcp:${unsigned}`)
    .digest("base64url");
}

export function mintApiKey(secret, now = Math.floor(Date.now() / 1000)) {
  if (!configured(secret)) throw new Error("Connect key issuance is unavailable.");
  const expiresAt = now + KEY_TTL_SECONDS;
  const unsigned = `${KEY_PREFIX}.${expiresAt.toString(36)}.${randomBytes(16).toString("hex")}`;
  return { apiKey: `${unsigned}.${sign(unsigned, secret)}`, expiresAt };
}

export function verifyApiKey(key, secret, now = Math.floor(Date.now() / 1000)) {
  if (!configured(secret) || typeof key !== "string" || key.length > 160) return false;
  const match = /^(odapdf_v1)\.([0-9a-z]{1,12})\.([a-f0-9]{32})\.([A-Za-z0-9_-]{43})$/.exec(key);
  if (!match) return false;
  const expiresAt = Number.parseInt(match[2], 36);
  if (!Number.isSafeInteger(expiresAt) || expiresAt.toString(36) !== match[2]
    || expiresAt <= now || expiresAt > now + KEY_TTL_SECONDS + 60) return false;
  const expected = sign(key.slice(0, key.lastIndexOf(".")), secret);
  // Compare the canonical ASCII encodings so noncanonical base64 is refused.
  return timingSafeEqual(Buffer.from(match[4]), Buffer.from(expected));
}

function response(status, error, extraHeaders = {}) {
  return new Response(JSON.stringify({ error }), { status, headers: { ...HEADERS, ...extraHeaders } });
}

export async function handleProtectedMcp(request, delegate, {
  secret = process.env.PDF_TOOLS_CONNECT_SIGNING_SECRET,
  now = Math.floor(Date.now() / 1000),
} = {}) {
  if (request.method !== "POST") return response(405, "Use POST.", { allow: "POST" });
  if (!configured(secret)) return response(503, "Connect authentication is unavailable.");
  const authorization = request.headers.get("authorization") ?? "";
  const match = /^Bearer ([^\s]+)$/i.exec(authorization);
  if (!match || !verifyApiKey(match[1], secret, now)) {
    return response(401, "A valid, unexpired PDF Tools app key is required.", {
      "www-authenticate": 'Bearer realm="pdf-tools-connect"',
    });
  }
  // Remove credentials before the PDF handler sees them. Authorize before
  // loading its dependencies or reading any document bytes.
  const headers = new Headers(request.headers);
  headers.delete("authorization");
  const authorizedRequest = new Request(request, { headers });
  const result = await delegate(authorizedRequest);
  const resultHeaders = new Headers(result.headers);
  resultHeaders.set("cache-control", "no-store, private");
  return new Response(result.body, { status: result.status, statusText: result.statusText, headers: resultHeaders });
}

export async function handleKeyIssuance(request, {
  secret = process.env.PDF_TOOLS_CONNECT_SIGNING_SECRET,
  now = Math.floor(Date.now() / 1000),
  allowedOrigin = "https://mcp.opendocuments.ai",
} = {}) {
  if (request.method !== "POST") return response(405, "Use POST.", { allow: "POST" });
  if (!configured(secret)) return response(503, "Key issuance is unavailable. The public /mcp endpoint remains available.");
  const origin = request.headers.get("origin");
  if (origin && origin !== allowedOrigin) return response(403, "Cross-origin key issuance is refused.");
  if (request.headers.get("content-type")?.split(";", 1)[0].trim().toLowerCase() !== "application/json") {
    return response(415, "Send application/json with an empty object.");
  }
  const length = request.headers.get("content-length");
  if (length !== null && (!/^\d+$/.test(length) || Number(length) > MAX_ISSUE_BODY_BYTES)) {
    return response(413, "Key requests must contain only an empty JSON object.");
  }
  let text = "";
  if (request.body) {
    const reader = request.body.getReader();
    const decoder = new TextDecoder("utf-8", { fatal: true });
    let size = 0;
    try {
      while (true) {
        const chunk = await reader.read();
        if (chunk.done) break;
        size += chunk.value.byteLength;
        if (size > MAX_ISSUE_BODY_BYTES) {
          await reader.cancel();
          return response(413, "Key requests must contain only an empty JSON object.");
        }
        text += decoder.decode(chunk.value, { stream: true });
      }
      text += decoder.decode();
    } catch {
      await reader.cancel().catch(() => {});
      return response(400, "Send an empty JSON object.");
    } finally {
      reader.releaseLock();
    }
  }
  // No account, identifiers, PDF, or other caller data belongs in issuance.
  if (!/^\s*\{\s*\}\s*$/.test(text)) return response(400, "Send an empty JSON object.");
  const { apiKey, expiresAt } = mintApiKey(secret, now);
  return new Response(JSON.stringify({ apiKey, expiresAt: new Date(expiresAt * 1000).toISOString() }), {
    status: 201, headers: HEADERS,
  });
}
