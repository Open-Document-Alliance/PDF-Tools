/**
 * Transfer storage for the MCP Files extension (docs/REMOTE_FILES_PROFILE_2026-11-25.md).
 *
 * A store holds an uploaded PDF from the first tools/call until the second
 * one finalizes it, and a returned PDF until the client downloads it. Nothing
 * else. Two stores exist:
 *
 * - S3 (production): the Vercel Marketplace bucket, reached with credentials
 *   from the Marketplace role through Vercel OIDC, and served to clients at
 *   PDF_TOOLS_FILES_ORIGIN (https://files.opendocuments.ai), whose Vercel
 *   project rewrites /up/ and /dl/ to the bucket (files-host/vercel.json).
 * - Memory: for tests only, never selected by environment, because serverless
 *   instances do not share memory.
 *
 * Interface:
 *   presignUpload(key, { size, mimeType, expiresAt }) -> { url, method, headers }
 *       The URL accepts exactly one write of exactly `size` bytes.
 *   head(key) -> { size } | null
 *   take(key) -> Uint8Array | null      read and delete, at most once per key (consumption)
 *   putResult(key, bytes, { mimeType }) -> void
 *   presignDownload(key, { expiresAt }) -> { url }
 *   list() -> async iterable of { key, lastModified }   lastModified in epoch ms
 *   delete(keys) -> void                 at most 1,000 keys per call (the S3 batch limit)
 *
 * list() and delete() serve only the sweeper (files-sweeper.mjs).
 */
import { assumeRoleWithWebIdentity, createS3Client, presignUrl } from "./aws-s3.mjs";
import { currentOidcToken } from "./oidc-context.mjs";

/** The Marketplace role's maximum session (measured 2026-11-26: 3601 s is refused). */
export const ROLE_SESSION_SECONDS = 3600;
const SESSION_MARGIN_SECONDS = 60;
const DEFAULT_MAX_OBJECT_BYTES = 25 * 1024 * 1024;
const WRITE_ONCE = "*";

export function createMemoryFileStore({ origin = "https://files.test.invalid", clock = Date.now } = {}) {
  const objects = new Map();
  const modified = new Map();
  const write = (key, bytes) => { objects.set(key, Uint8Array.from(bytes)); modified.set(key, clock()); };
  const remove = key => { objects.delete(key); modified.delete(key); };
  const uploads = new Map();
  return {
    kind: "memory",
    async presignUpload(key, { size, mimeType, expiresAt }) {
      uploads.set(key, { size, mimeType, expiresAt });
      return { url: `${origin}/u/${encodeURIComponent(key)}`, method: "PUT", headers: { "Content-Type": mimeType, "If-None-Match": WRITE_ONCE } };
    },
    /** Test helper: what the client does with the presigned URL. Like S3, a second write is refused. */
    acceptUpload(key, bytes) {
      if (!uploads.has(key)) throw new Error("no such upload target");
      if (objects.has(key)) throw new Error("precondition failed: already written");
      write(key, bytes);
    },
    async head(key) {
      const bytes = objects.get(key);
      return bytes ? { size: bytes.length } : null;
    },
    async take(key) {
      const bytes = objects.get(key) ?? null;
      remove(key);
      uploads.delete(key);
      return bytes;
    },
    async putResult(key, bytes) {
      write(key, bytes);
    },
    async presignDownload(key) {
      return { url: `${origin}/d/${encodeURIComponent(key)}` };
    },
    /** Test helper: what the client does with a download URL. */
    fetchDownload(key) {
      return objects.get(key) ?? null;
    },
    async *list() {
      for (const [key, lastModified] of [...modified]) yield { key, lastModified };
    },
    async delete(keys) {
      if (keys.length > 1000) throw new Error("at most 1000 keys per delete");
      for (const key of keys) { remove(key); uploads.delete(key); }
    },
    size: () => objects.size,
  };
}

/**
 * The production store: the Vercel Marketplace S3 bucket.
 *
 * Credentials come from AssumeRoleWithWebIdentity with the request's Vercel
 * OIDC token. A presigned URL dies with the session that signed it, and the
 * role allows sessions of at most one hour, so every presign uses a session
 * with at least the URL's lifetime left, assuming a fresh one when the cached
 * one is too old. That is why one upload target (20 minutes) and downloads (55
 * minutes) work, and why several targets in one call (75 minutes required by
 * the Files spec) cannot until the role's maximum session is raised.
 *
 * Upload URLs sign Content-Length, Content-Type and If-None-Match: *, so each
 * takes exactly one write of exactly the declared size (verified through the
 * Vercel rewrite on 2026-11-26: 412 on a second write, 403 on another size).
 * take() first writes a claim marker with If-None-Match, so two concurrent
 * repeats of the same call cannot both run; the sweeper removes markers.
 */
export function createS3FileStore({
  bucket, region, roleArn, origin, sessionSeconds = ROLE_SESSION_SECONDS, maxObjectBytes = DEFAULT_MAX_OBJECT_BYTES,
  oidcToken = currentOidcToken, fetchImpl = fetch, clock = Date.now,
}) {
  let session = null;
  let pending = null;

  async function assume() {
    const token = oidcToken();
    if (!token) throw new Error("Files storage needs a Vercel OIDC token");
    return assumeRoleWithWebIdentity({ roleArn, webIdentityToken: token, durationSeconds: sessionSeconds, region, fetchImpl });
  }

  /** Credentials valid for at least `seconds` more (plus a margin). */
  async function credentialsFor(seconds) {
    const needed = (seconds + SESSION_MARGIN_SECONDS) * 1000;
    if (session && session.expiresAt - clock() >= needed) return session;
    pending ??= assume().finally(() => { pending = null; });
    const fresh = await pending;
    if (!session || fresh.expiresAt > session.expiresAt) session = fresh;
    if (session.expiresAt - clock() < needed) throw new Error("Files storage session is shorter than the URL lifetime it must sign");
    return session;
  }

  const s3 = createS3Client({ bucket, region, credentials: () => credentialsFor(0), fetchImpl, clock: () => new Date(clock()) });
  const publicUrl = signed => {
    const url = new URL(signed);
    return `${origin}${url.pathname}${url.search}`;
  };
  const secondsUntil = expiresAt => Math.max(1, Math.floor(expiresAt - clock() / 1000));

  return {
    kind: "s3",
    async presignUpload(key, { size, mimeType, expiresAt }) {
      const expiresIn = secondsUntil(expiresAt);
      const credentials = await credentialsFor(expiresIn);
      const url = presignUrl({
        method: "PUT", host: s3.host, path: s3.objectPath(key), region, credentials, expiresIn, now: new Date(clock()),
        headers: { "content-length": String(size), "content-type": mimeType, "if-none-match": WRITE_ONCE },
      });
      return { url: publicUrl(url), method: "PUT", headers: { "Content-Type": mimeType, "If-None-Match": WRITE_ONCE } };
    },
    head: key => s3.head(key),
    async take(key) {
      if (!(await s3.putIfAbsent(`claimed/${key}`, new Uint8Array(0)))) return null;
      try {
        return await s3.get(key, { maxBytes: maxObjectBytes });
      } finally {
        await s3.deleteObject(key);
      }
    },
    async putResult(key, bytes, { mimeType = "application/pdf" } = {}) {
      if (!(await s3.putIfAbsent(key, bytes, { contentType: mimeType }))) throw new Error("result key already exists");
    },
    async presignDownload(key, { expiresAt }) {
      const expiresIn = secondsUntil(expiresAt);
      const credentials = await credentialsFor(expiresIn);
      const url = presignUrl({
        method: "GET", host: s3.host, path: s3.objectPath(key), region, credentials, expiresIn, now: new Date(clock()),
        query: { "response-cache-control": "private, no-store", "response-content-disposition": "attachment" },
      });
      return { url: publicUrl(url) };
    },
    list: () => s3.list(),
    delete: keys => s3.deleteObjects(keys),
  };
}

const ORIGIN_PATTERN = /^https:\/\/[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/;

/**
 * Pick the store from configuration. Returns null (Files not advertised) unless
 * explicitly enabled with a complete S3 configuration. The memory store needs
 * an injected instance; it is never selected by environment alone.
 */
export function fileStoreFromEnv(env = process.env, { injected = null, fetchImpl } = {}) {
  if (env.PDF_TOOLS_FILES_ENABLED !== "1") return null;
  if (injected) return injected;
  const origin = env.PDF_TOOLS_FILES_ORIGIN;
  if (!env.S3_BUCKET_NAME || !env.AWS_REGION || !env.AWS_ROLE_ARN || !ORIGIN_PATTERN.test(origin ?? "")) return null;
  return createS3FileStore({
    bucket: env.S3_BUCKET_NAME, region: env.AWS_REGION, roleArn: env.AWS_ROLE_ARN, origin,
    oidcToken: () => currentOidcToken(env), ...(fetchImpl ? { fetchImpl } : {}),
  });
}
