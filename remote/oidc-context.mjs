/**
 * The request being served, for code that runs deep inside a tool call.
 *
 * - The Vercel OIDC token: Vercel puts it on each function request as
 *   `x-vercel-oidc-token`; the Files store exchanges it for short-lived AWS
 *   credentials (Vercel Marketplace S3), so no AWS key is stored anywhere.
 *   Outside a request it falls back to VERCEL_OIDC_TOKEN (local runs with
 *   `vercel env pull`).
 * - The request headers: the Files upload quota (files-quota.mjs) needs the
 *   host and client address to ask the Vercel Firewall.
 */
import { AsyncLocalStorage } from "node:async_hooks";

const requests = new AsyncLocalStorage();

export function withOidcToken(request, fn) {
  const headers = request?.headers instanceof Headers ? request.headers : null;
  return requests.run({ token: headers?.get("x-vercel-oidc-token") || null, headers }, fn);
}

export function currentOidcToken(env = process.env) {
  return requests.getStore()?.token || env.VERCEL_OIDC_TOKEN || null;
}

export function currentRequestHeaders() {
  return requests.getStore()?.headers ?? null;
}
