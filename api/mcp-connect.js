import { handleProtectedMcp } from "../remote/connect-auth.mjs";

export const config = { runtime: "nodejs", maxDuration: 60 };

function handle(request) {
  return handleProtectedMcp(request, async (authorizedRequest) => {
    const { handleMcpFetch } = await import("../remote/http.mjs");
    return handleMcpFetch(authorizedRequest);
  });
}

export const POST = handle;
export const GET = handle;
export const DELETE = handle;
export const OPTIONS = handle;
