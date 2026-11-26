import { fileStoreFromEnv } from "../remote/file-store.mjs";
import { handleSweepRequest } from "../remote/files-sweeper.mjs";
import { withOidcToken } from "../remote/oidc-context.mjs";

export const config = { runtime: "nodejs", maxDuration: 60 };

export function GET(request) {
  return withOidcToken(request, () => handleSweepRequest(request, { store: fileStoreFromEnv() }));
}

export const POST = GET;
