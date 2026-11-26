import { transferStoreFromEnv } from "../remote/file-store.mjs";
import { handleSweepRequest } from "../remote/files-sweeper.mjs";
import { withOidcToken } from "../remote/oidc-context.mjs";

export const config = { runtime: "nodejs", maxDuration: 60 };

/** Sweeps whenever the bucket is connected, even with Files switched off. */
export function GET(request) {
  return withOidcToken(request, () => handleSweepRequest(request, { store: transferStoreFromEnv() }));
}

export const POST = GET;
