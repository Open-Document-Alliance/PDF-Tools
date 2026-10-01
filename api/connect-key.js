import { handleKeyIssuance } from "../remote/connect-auth.mjs";

export const config = { runtime: "nodejs", maxDuration: 10 };

function handle(request) {
  return handleKeyIssuance(request);
}

export const POST = handle;
export const GET = handle;
export const DELETE = handle;
export const OPTIONS = handle;
