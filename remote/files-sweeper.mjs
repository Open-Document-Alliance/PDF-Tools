/**
 * The sweeper behind the Files retention promise: "held up to 2 hours for
 * transfer, then deleted automatically" (docs/REMOTE_FILES_PROFILE_2026-11-25.md).
 *
 * The server already deletes an upload when the second call consumes it. This
 * catches everything else: uploads nobody finalized and downloads nobody
 * fetched. A Vercel cron calls it every 15 minutes and it deletes every object
 * older than 105 minutes, so no object outlives 2 hours. A bucket lifecycle
 * rule (whole days only in S3) stays as the backstop if the cron ever stops.
 *
 * Responses and logs carry counts only: never object keys or URLs.
 */
import { createHash, timingSafeEqual } from "node:crypto";

export const SWEEP_INTERVAL_MS = 15 * 60 * 1000;
export const SWEEP_MAX_AGE_MS = 105 * 60 * 1000;
export const RETENTION_PROMISE_MS = 2 * 60 * 60 * 1000;
const DELETE_BATCH = 1000;

/** Delete every object older than maxAgeMs. Returns counts only. */
export async function sweepTransfers(store, { now = Date.now(), maxAgeMs = SWEEP_MAX_AGE_MS } = {}) {
  const stale = [];
  let kept = 0;
  for await (const { key, lastModified } of store.list()) {
    if (!Number.isFinite(lastModified) || now - lastModified > maxAgeMs) stale.push(key);
    else kept += 1;
  }
  for (let start = 0; start < stale.length; start += DELETE_BATCH) {
    await store.delete(stale.slice(start, start + DELETE_BATCH));
  }
  return { deleted: stale.length, kept };
}

const digest = value => createHash("sha256").update(String(value)).digest();

/** Vercel sends `Authorization: Bearer $CRON_SECRET` on cron requests. */
function authorized(request, secret) {
  if (!secret) return false;
  return timingSafeEqual(digest(request.headers.get("authorization") ?? ""), digest(`Bearer ${secret}`));
}

const json = (status, body) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", "cache-control": "no-store" } });

/**
 * The cron endpoint. With Files switched off there is nothing to sweep and it
 * answers without touching storage. With Files on it requires CRON_SECRET,
 * failing closed if the secret is not configured.
 */
export async function handleSweepRequest(request, { store, env = process.env, now = Date.now(), log = console.error } = {}) {
  if (request.method !== "GET") return json(405, { error: "method_not_allowed" });
  if (!store) return json(200, { files: "disabled" });
  if (!env.CRON_SECRET) {
    log("pdf-tools: ERROR files sweep refused: CRON_SECRET is not configured, so transfer objects are not being swept");
    return json(503, { error: "not_configured" });
  }
  if (!authorized(request, env.CRON_SECRET)) return json(401, { error: "unauthorized" });
  try {
    const result = await sweepTransfers(store, { now });
    return json(200, { files: "swept", ...result });
  } catch (error) {
    log(`pdf-tools: ERROR files sweep failed: ${error?.name ?? "Error"}`);
    return json(500, { error: "sweep_failed" });
  }
}
