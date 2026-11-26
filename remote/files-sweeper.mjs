/**
 * The sweeper behind the Files retention promise: "held up to 2 hours for
 * transfer, then deleted automatically" (docs/REMOTE_FILES_PROFILE_2026-11-25.md).
 *
 * A Vercel cron calls it every 10 minutes. It deletes every Files object (only
 * under FILES_PREFIXES) older than 65 minutes. Nothing legitimate needs an
 * object that long: upload sessions end at 60 minutes and download URLs at 55.
 * An object is therefore gone 75 minutes after it was written when every run
 * happens, and still within 2 hours if up to four runs in a row are missed
 * (Vercel cron can skip or delay an invocation). A run that finds an object
 * that outlived the schedule logs an ERROR line, so missed runs are visible.
 * A bucket lifecycle rule (whole days only in S3) is the backstop.
 *
 * It runs whenever the bucket is connected, whether or not Files is enabled,
 * so switching Files off never strands stored transfers.
 *
 * Responses and logs carry counts and ages only: never object keys or URLs.
 */
import { createHash, timingSafeEqual } from "node:crypto";

import { FILES_PREFIXES } from "./file-store.mjs";

export const SWEEP_INTERVAL_MS = 10 * 60 * 1000;
export const SWEEP_SCHEDULE = "*/10 * * * *";
export const SWEEP_MAX_AGE_MS = 65 * 60 * 1000;
export const MISSED_RUNS_TOLERATED = 4;
export const RETENTION_PROMISE_MS = 2 * 60 * 60 * 1000;
/** Older than this at deletion means at least one scheduled run did not happen. */
export const LATE_AGE_MS = SWEEP_MAX_AGE_MS + 2 * SWEEP_INTERVAL_MS;
const DELETE_BATCH = 1000;
const MINUTE = 60 * 1000;

/** Delete every Files object older than maxAgeMs. Returns counts and the oldest deleted age. */
export async function sweepTransfers(store, { now = Date.now(), maxAgeMs = SWEEP_MAX_AGE_MS, prefixes = FILES_PREFIXES } = {}) {
  const stale = [];
  let kept = 0;
  let oldestMs = 0;
  for (const prefix of prefixes) {
    for await (const { key, lastModified } of store.list(prefix)) {
      if (!key?.startsWith(prefix)) continue;
      const age = Number.isFinite(lastModified) ? now - lastModified : Infinity;
      if (age > maxAgeMs) {
        stale.push(key);
        oldestMs = Math.max(oldestMs, age);
      } else {
        kept += 1;
      }
    }
  }
  for (let start = 0; start < stale.length; start += DELETE_BATCH) {
    await store.delete(stale.slice(start, start + DELETE_BATCH));
  }
  return { deleted: stale.length, kept, oldestDeletedMinutes: stale.length ? Math.round(Math.min(oldestMs, 10 * RETENTION_PROMISE_MS) / MINUTE) : 0, late: oldestMs > LATE_AGE_MS };
}

const digest = value => createHash("sha256").update(String(value)).digest();

/** Vercel sends `Authorization: Bearer $CRON_SECRET` on cron requests. */
function authorized(request, secret) {
  if (!secret) return false;
  return timingSafeEqual(digest(request.headers.get("authorization") ?? ""), digest(`Bearer ${secret}`));
}

const json = (status, body) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", "cache-control": "no-store" } });

/**
 * The cron endpoint. Without a connected bucket there is nothing to sweep and
 * it answers without touching storage. With one, it requires CRON_SECRET,
 * failing closed with an ERROR line if the secret is not configured.
 */
export async function handleSweepRequest(request, { store, env = process.env, now = Date.now(), log = console.error, info = console.log } = {}) {
  if (request.method !== "GET") return json(405, { error: "method_not_allowed" });
  if (!store) return json(200, { files: "no_bucket" });
  if (!env.CRON_SECRET) {
    log("pdf-tools: ERROR files sweep refused: CRON_SECRET is not configured, so transfer objects are not being swept");
    return json(503, { error: "not_configured" });
  }
  if (!authorized(request, env.CRON_SECRET)) return json(401, { error: "unauthorized" });
  try {
    const result = await sweepTransfers(store, { now });
    if (result.late) {
      log(`pdf-tools: ERROR files sweep found objects ${result.oldestDeletedMinutes} minutes old; scheduled runs were missed (deleted now)`);
    } else {
      info(`pdf-tools: files sweep deleted ${result.deleted}, kept ${result.kept}`);
    }
    return json(200, { files: "swept", ...result });
  } catch (error) {
    log(`pdf-tools: ERROR files sweep failed: ${error?.name ?? "Error"}${error?.code ? ` ${error.code}` : ""}`);
    return json(500, { error: "sweep_failed" });
  }
}
