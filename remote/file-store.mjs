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
 *   presignUpload(key, { size, mimeType, lifetimeSeconds }) -> { url, method, headers, expiresAt }
 *       The URL accepts exactly one write of exactly `size` bytes, ever: the
 *       write is conditional on the key being absent, and the key never becomes
 *       absent again while the URL is valid (see take()).
 *   head(key) -> { size } | null
 *   take(key) -> Uint8Array | null
 *       At most once per key: a write-once claim decides the single winner. The
 *       PDF bytes are then replaced by an empty tombstone, so no PDF stays
 *       stored after use and the upload URL still cannot write again.
 *   putResult(key, bytes, { mimeType }) -> void
 *   presignDownload(key, { lifetimeSeconds }) -> { url, expiresAt }
 *   list(prefix) -> async iterable of { key, lastModified }   lastModified in epoch ms
 *   delete(keys) -> void                 at most 1,000 keys per call (the S3 batch limit)
 *
 * `expiresAt` (epoch seconds) is the expiry the URL was actually signed with.
 * list() and delete() serve only the sweeper (files-sweeper.mjs), which works
 * only under FILES_PREFIXES.
 */
import { assumeRoleWithWebIdentity, createS3Client, presignUrl } from "./aws-s3.mjs";
import { parseQuotaRules } from "./files-quota.mjs";
import { currentOidcToken } from "./oidc-context.mjs";

/** The Marketplace role's maximum session (measured 2026-11-26: 3601 s is refused). */
export const ROLE_SESSION_SECONDS = 3600;
/** Every key the Files extension writes lives under one of these. */
export const FILES_PREFIXES = Object.freeze(["up/", "dl/", "claimed/"]);
const SESSION_MARGIN_SECONDS = 60;
const DEFAULT_MAX_OBJECT_BYTES = 25 * 1024 * 1024;
const WRITE_ONCE = "*";
const EMPTY = new Uint8Array(0);
const claimKey = key => `claimed/${key}`;

export function createMemoryFileStore({ origin = "https://files.test.invalid", clock = Date.now } = {}) {
  const objects = new Map();
  const modified = new Map();
  const uploads = new Map();
  const write = (key, bytes) => { objects.set(key, Uint8Array.from(bytes)); modified.set(key, clock()); };
  const remove = key => { objects.delete(key); modified.delete(key); };
  const expiry = lifetimeSeconds => Math.floor(clock() / 1000) + lifetimeSeconds;
  return {
    kind: "memory",
    async presignUpload(key, { size, mimeType, lifetimeSeconds }) {
      uploads.set(key, { size, mimeType });
      return { url: `${origin}/up/${encodeURIComponent(key)}`, method: "PUT", headers: { "Content-Type": mimeType, "If-None-Match": WRITE_ONCE }, expiresAt: expiry(lifetimeSeconds) };
    },
    /** Test helper: what the client does with the presigned URL. Like S3 with If-None-Match, a second write is refused. */
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
      if (objects.has(claimKey(key))) return null;
      write(claimKey(key), EMPTY);
      const bytes = objects.get(key) ?? null;
      if (bytes) objects.set(key, EMPTY);
      return bytes;
    },
    async putResult(key, bytes) {
      if (objects.has(key)) throw new Error("result key already exists");
      write(key, bytes);
    },
    async presignDownload(key, { lifetimeSeconds }) {
      return { url: `${origin}/dl/${encodeURIComponent(key)}`, expiresAt: expiry(lifetimeSeconds) };
    },
    /** Test helper: what the client does with a download URL. */
    fetchDownload(key) {
      return objects.get(key) ?? null;
    },
    async *list(prefix) {
      for (const [key, lastModified] of [...modified]) if (key.startsWith(prefix)) yield { key, lastModified };
    },
    async delete(keys) {
      if (keys.length > 1000) throw new Error("at most 1000 keys per delete");
      for (const key of keys) { remove(key); uploads.delete(key); }
    },
    /** Test helper: how many objects still hold PDF bytes (claims and tombstones are empty). */
    size: () => [...objects.values()].filter(bytes => bytes.length > 0).length,
    /** Test helper: every key, PDF or not. */
    keys: () => [...objects.keys()],
  };
}

/**
 * The production store: the Vercel Marketplace S3 bucket.
 *
 * Credentials come from AssumeRoleWithWebIdentity with the request's Vercel
 * OIDC token. A presigned URL dies with the session that signed it, and the
 * role allows sessions of at most one hour, so every presign uses a session
 * that outlives the URL, assuming a fresh one when the cached one is too old.
 * That is why one upload target (25 minutes) and downloads (55 minutes) work,
 * and why several targets in one call (75 minutes required by the Files spec)
 * cannot until the role's maximum session is raised.
 *
 * Upload URLs sign Content-Length, Content-Type and If-None-Match: *, so each
 * takes exactly one write of exactly the declared size (verified through the
 * Vercel rewrite on 2026-11-26: 412 on a second write, 403 on another size).
 */
export function createS3FileStore({
  bucket, region, roleArn, origin = null, sessionSeconds = ROLE_SESSION_SECONDS, maxObjectBytes = DEFAULT_MAX_OBJECT_BYTES,
  oidcToken = currentOidcToken, fetchImpl = fetch, clock = Date.now,
}) {
  let session = null;
  let pending = null;

  async function assume() {
    const token = oidcToken();
    if (!token) throw new Error("Files storage needs a Vercel OIDC token");
    return assumeRoleWithWebIdentity({ roleArn, webIdentityToken: token, durationSeconds: sessionSeconds, region, fetchImpl });
  }

  /** Credentials that stay valid until at least `untilSeconds` (epoch), plus a margin. */
  async function credentialsUntil(untilSeconds) {
    const needed = (untilSeconds + SESSION_MARGIN_SECONDS) * 1000;
    if (session && session.expiresAt >= needed) return session;
    pending ??= assume().finally(() => { pending = null; });
    const fresh = await pending;
    if (!session || fresh.expiresAt > session.expiresAt) session = fresh;
    if (session.expiresAt < needed) throw new Error("Files storage session is shorter than the URL lifetime it must sign");
    return session;
  }

  const s3 = createS3Client({ bucket, region, credentials: () => credentialsUntil(Math.floor(clock() / 1000)), fetchImpl, clock: () => new Date(clock()) });
  const publicUrl = signed => {
    if (!origin) throw new Error("Files storage has no public origin");
    const url = new URL(signed);
    return `${origin}${url.pathname}${url.search}`;
  };

  /** Sign at one instant, and report the expiry S3 will enforce: X-Amz-Date (whole seconds) plus X-Amz-Expires. */
  async function presign({ key, method, headers, query, lifetimeSeconds }) {
    const signedAt = Math.floor(clock() / 1000);
    const expiresAt = signedAt + lifetimeSeconds;
    const credentials = await credentialsUntil(expiresAt);
    const url = presignUrl({ method, host: s3.host, path: s3.objectPath(key), region, credentials, expiresIn: lifetimeSeconds, now: new Date(signedAt * 1000), headers, query });
    return { url: publicUrl(url), expiresAt };
  }

  return {
    kind: "s3",
    async presignUpload(key, { size, mimeType, lifetimeSeconds }) {
      const { url, expiresAt } = await presign({
        key, method: "PUT", lifetimeSeconds,
        headers: { "content-length": String(size), "content-type": mimeType, "if-none-match": WRITE_ONCE },
      });
      return { url, method: "PUT", headers: { "Content-Type": mimeType, "If-None-Match": WRITE_ONCE }, expiresAt };
    },
    head: key => s3.head(key),
    async take(key) {
      if (!(await s3.putIfAbsent(claimKey(key), EMPTY))) return null;
      let absent = false;
      try {
        const bytes = await s3.get(key, { maxBytes: maxObjectBytes });
        absent = bytes === null;
        return bytes;
      } finally {
        // Overwrite, never delete: the key must stay present so the upload URL's
        // If-None-Match keeps refusing writes until the URL expires. A failed
        // read is tombstoned too, so no PDF bytes wait for the sweeper.
        if (!absent) await s3.put(key, EMPTY);
      }
    },
    async putResult(key, bytes, { mimeType = "application/pdf" } = {}) {
      if (!(await s3.putIfAbsent(key, bytes, { contentType: mimeType }))) throw new Error("result key already exists");
    },
    presignDownload: (key, { lifetimeSeconds }) => presign({
      key, method: "GET", lifetimeSeconds,
      query: { "response-cache-control": "private, no-store", "response-content-disposition": "attachment" },
    }),
    list: prefix => s3.list(prefix),
    delete: keys => s3.deleteObjects(keys),
  };
}

const ORIGIN_PATTERN = /^https:\/\/[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/;

/**
 * The bucket, whenever the Marketplace integration is connected, whether or
 * not Files is enabled. The sweeper uses this, so turning Files off never
 * stops the cleanup of transfers already stored.
 */
export function transferStoreFromEnv(env = process.env, { fetchImpl } = {}) {
  if (!env.S3_BUCKET_NAME || !env.AWS_REGION || !env.AWS_ROLE_ARN) return null;
  const origin = ORIGIN_PATTERN.test(env.PDF_TOOLS_FILES_ORIGIN ?? "") ? env.PDF_TOOLS_FILES_ORIGIN : null;
  return createS3FileStore({
    bucket: env.S3_BUCKET_NAME, region: env.AWS_REGION, roleArn: env.AWS_ROLE_ARN, origin,
    oidcToken: () => currentOidcToken(env), ...(fetchImpl ? { fetchImpl } : {}),
  });
}

/**
 * The store for admitting transfers. Returns null (Files not advertised) unless
 * explicitly enabled, with a public origin, with the cleanup configured
 * (CRON_SECRET), so nothing is accepted that the sweeper could not delete, and
 * with an issuance quota (PDF_TOOLS_FILES_QUOTA_RULES).
 * The memory store needs an injected instance; it is never selected by
 * environment alone.
 */
export function fileStoreFromEnv(env = process.env, { injected = null, fetchImpl } = {}) {
  if (env.PDF_TOOLS_FILES_ENABLED !== "1") return null;
  if (injected) return injected;
  if (!env.CRON_SECRET || !ORIGIN_PATTERN.test(env.PDF_TOOLS_FILES_ORIGIN ?? "") || !parseQuotaRules(env.PDF_TOOLS_FILES_QUOTA_RULES)) return null;
  return transferStoreFromEnv(env, { fetchImpl });
}
