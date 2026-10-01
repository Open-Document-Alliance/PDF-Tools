import { handleKeyIssuance } from "../remote/connect-auth.mjs";

export const config = { runtime: "nodejs", maxDuration: 10 };
export const POST = handleKeyIssuance;
export const GET = handleKeyIssuance;
export const DELETE = handleKeyIssuance;
export const OPTIONS = handleKeyIssuance;
