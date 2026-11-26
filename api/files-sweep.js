import { fileStoreFromEnv } from "../remote/file-store.mjs";
import { handleSweepRequest } from "../remote/files-sweeper.mjs";

export const config = { runtime: "nodejs", maxDuration: 60 };

export function GET(request) {
  return handleSweepRequest(request, { store: fileStoreFromEnv() });
}

export const POST = GET;
