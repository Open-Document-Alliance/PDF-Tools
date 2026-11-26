/**
 * The Vercel OIDC token for the request being served. Vercel puts it on each
 * function request as `x-vercel-oidc-token`; the Files store exchanges it for
 * short-lived AWS credentials (Vercel Marketplace S3), so no AWS key is stored
 * anywhere. Outside a request it falls back to VERCEL_OIDC_TOKEN (local runs
 * with `vercel env pull`).
 */
import { AsyncLocalStorage } from "node:async_hooks";

const tokens = new AsyncLocalStorage();

export function withOidcToken(request, fn) {
  return tokens.run(request?.headers?.get?.("x-vercel-oidc-token") || null, fn);
}

export function currentOidcToken(env = process.env) {
  return tokens.getStore() || env.VERCEL_OIDC_TOKEN || null;
}
