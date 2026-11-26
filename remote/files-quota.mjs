/**
 * The quota on issuing new upload targets (docs/REMOTE_FILES_PROFILE_2026-11-25.md).
 *
 * It is consulted at exactly one place: the first call of an upload, after the
 * tool and the upload metadata are validated and before a new URL is signed.
 * Ordinary tool calls, second calls that finish an upload already issued, and
 * downloads never consult it, so a busy period cannot break work in progress.
 *
 * Counting is done by the Vercel Firewall through its rate-limit SDK
 * (`@vercel/firewall` 1.2.6, vendored byte-for-byte under ./vendor so no
 * shipped package changes). Each rule is a project firewall rule whose
 * condition is `@vercel/firewall` with the same ID; its window and limit live
 * in the firewall configuration, not here. Two scopes:
 *
 * - `ip`: keyed by client address. Claude's requests come from shared
 *   egress, so for Claude this bounds all its users together.
 * - `global`: one fixed key, so it bounds all issuance together. Vercel counts
 *   per region, so the real ceiling is the configured limit times the number
 *   of regions that receive traffic.
 *
 * Failure closes issuance only: a missing rule, an error or a timeout refuses
 * the new target with a retryable answer and an ERROR line, and every other
 * call keeps working.
 */
import { checkRateLimit } from "./vendor/vercel-firewall-1.2.6/rate-limit.cjs";
import { currentRequestHeaders } from "./oidc-context.mjs";

export const QUOTA_GLOBAL_KEY = "pdf-tools-files-upload-issuance";
const DEFAULT_TIMEOUT_MS = 2_000;
const RULE_PATTERN = /^([a-z0-9][a-z0-9-]{0,62}):(ip|global)$/;
/** What the firewall needs to identify the client; never tokens, authorization or other cookies. */
const FORWARDED_HEADERS = ["host", "x-real-ip", "x-forwarded-for", "x-vercel-ja4-digest"];

/** "files-upload-ip:ip,files-upload-global:global" -> [{ id, scope }], or null if malformed or empty. */
export function parseQuotaRules(value) {
  if (typeof value !== "string" || value.trim() === "") return null;
  const rules = [];
  for (const part of value.split(",")) {
    const match = part.trim().match(RULE_PATTERN);
    if (!match) return null;
    rules.push({ id: match[1], scope: match[2] });
  }
  return rules;
}

function forwardedHeaders(source) {
  const headers = new Headers();
  for (const name of FORWARDED_HEADERS) {
    const value = source.get(name);
    if (value) headers.set(name, value);
  }
  // Protected previews authenticate the check with the deployment's own session cookie.
  const jwt = (source.get("cookie") ?? "").split(";").map(part => part.trim()).find(part => part.startsWith("_vercel_jwt="));
  if (jwt) headers.set("cookie", jwt);
  return headers;
}

export function createIssuanceQuota({ rules, check = checkRateLimit, headers = currentRequestHeaders, timeoutMs = DEFAULT_TIMEOUT_MS, log = console.error }) {
  if (!Array.isArray(rules) || rules.length === 0) throw new Error("an issuance quota needs at least one rule");
  return {
    rules: rules.map(rule => ({ ...rule })),
    /** { ok: true } or { ok: false, reason: "rate_limited" | "unavailable" } */
    async admit() {
      const source = headers();
      if (!source) {
        log("pdf-tools: ERROR files upload quota unavailable: no request context");
        return { ok: false, reason: "unavailable" };
      }
      const forwarded = forwardedHeaders(source);
      for (const rule of rules) {
        let result;
        try {
          result = await check(rule.id, { headers: forwarded, timeout: timeoutMs, ...(rule.scope === "global" ? { rateLimitKey: QUOTA_GLOBAL_KEY } : {}) });
        } catch (error) {
          log(`pdf-tools: ERROR files upload quota check failed for ${rule.id}: ${error?.name ?? "Error"}`);
          return { ok: false, reason: "unavailable" };
        }
        if (result?.error === "not-found") {
          log(`pdf-tools: ERROR files upload quota rule ${rule.id} is not configured in the Vercel Firewall`);
          return { ok: false, reason: "unavailable" };
        }
        if (result?.rateLimited) return { ok: false, reason: "rate_limited" };
      }
      return { ok: true };
    },
  };
}

export function issuanceQuotaFromEnv(env = process.env, options = {}) {
  const rules = parseQuotaRules(env.PDF_TOOLS_FILES_QUOTA_RULES);
  return rules ? createIssuanceQuota({ rules, ...options }) : null;
}
