/**
 * Transfer storage for the MCP Files extension (docs/REMOTE_FILES_PROFILE_2026-11-25.md).
 *
 * A store holds an uploaded PDF from the first tools/call until the second
 * one finalizes it, and a returned PDF until the client downloads it. Nothing
 * else. Production storage (S3 or R2 behind an approved own-domain host) is
 * not chosen yet, so only the in-memory store exists; it is for tests and is
 * refused outside them, because serverless instances do not share memory.
 *
 * Interface:
 *   presignUpload(key, { size, mimeType, expiresAt }) -> { url, method, headers }
 *   head(key) -> { size, sha256 } | null
 *   take(key) -> Uint8Array | null      read and delete in one step (consumption)
 *   putResult(key, bytes, { mimeType }) -> void
 *   presignDownload(key, { expiresAt }) -> { url }
 */
import { createHash } from "node:crypto";

export function createMemoryFileStore({ origin = "https://files.test.invalid" } = {}) {
  const objects = new Map();
  const uploads = new Map();
  return {
    kind: "memory",
    presignUpload(key, { size, mimeType, expiresAt }) {
      uploads.set(key, { size, mimeType, expiresAt });
      return { url: `${origin}/u/${encodeURIComponent(key)}`, method: "PUT", headers: { "Content-Type": mimeType } };
    },
    /** Test helper: what the client does with the presigned URL. */
    acceptUpload(key, bytes) {
      if (!uploads.has(key)) throw new Error("no such upload target");
      objects.set(key, Uint8Array.from(bytes));
    },
    async head(key) {
      const bytes = objects.get(key);
      return bytes ? { size: bytes.length, sha256: createHash("sha256").update(bytes).digest("base64url") } : null;
    },
    async take(key) {
      const bytes = objects.get(key) ?? null;
      objects.delete(key);
      uploads.delete(key);
      return bytes;
    },
    async putResult(key, bytes) {
      objects.set(key, Uint8Array.from(bytes));
    },
    presignDownload(key) {
      return { url: `${origin}/d/${encodeURIComponent(key)}` };
    },
    /** Test helper: what the client does with a download URL. */
    fetchDownload(key) {
      return objects.get(key) ?? null;
    },
    size: () => objects.size,
  };
}

/**
 * Pick the store from configuration. Returns null (Files not advertised) unless
 * explicitly enabled with a usable store. The memory store needs an injected
 * instance; it is never selected by environment alone.
 */
export function fileStoreFromEnv(env = process.env, { injected = null } = {}) {
  if (env.PDF_TOOLS_FILES_ENABLED !== "1") return null;
  if (injected) return injected;
  // An S3-compatible store is added once the storage host is decided.
  return null;
}
