"use strict";
var __defProp = Object.defineProperty;
var __getOwnPropDesc = Object.getOwnPropertyDescriptor;
var __getOwnPropNames = Object.getOwnPropertyNames;
var __hasOwnProp = Object.prototype.hasOwnProperty;
var __export = (target, all) => {
  for (var name in all)
    __defProp(target, name, { get: all[name], enumerable: true });
};
var __copyProps = (to, from, except, desc) => {
  if (from && typeof from === "object" || typeof from === "function") {
    for (let key of __getOwnPropNames(from))
      if (!__hasOwnProp.call(to, key) && key !== except)
        __defProp(to, key, { get: () => from[key], enumerable: !(desc = __getOwnPropDesc(from, key)) || desc.enumerable });
  }
  return to;
};
var __toCommonJS = (mod) => __copyProps(__defProp({}, "__esModule", { value: true }), mod);
var rate_limit_exports = {};
__export(rate_limit_exports, {
  checkRateLimit: () => checkRateLimit,
  unstable_checkRateLimit: () => checkRateLimit
});
module.exports = __toCommonJS(rate_limit_exports);
async function checkRateLimit(rateLimitId, options) {
  if (process.env.NODE_ENV !== "production" && !options?.firewallHostForDevelopment) {
    console.warn(
      "Provide the `firewallHostForDevelopment` option to support rate-limiting in development mode"
    );
    return {
      rateLimited: false
    };
  }
  let requestHeaders = options?.headers || options?.request?.headers;
  if (requestHeaders && !(requestHeaders instanceof Headers)) {
    requestHeaders = new Headers(requestHeaders);
  }
  if (!requestHeaders) {
    const context = getContext();
    if (context.headers) {
      requestHeaders = new Headers(context.headers);
    }
  }
  if (!requestHeaders) {
    throw new Error("`headers` or `request` options are required");
  }
  let firewallHost = requestHeaders.get("host") || void 0;
  if (process.env.NODE_ENV !== "production") {
    firewallHost = options?.firewallHostForDevelopment !== "ignore-for-testing" ? options?.firewallHostForDevelopment : firewallHost;
  }
  let fullRateLimitKey = options?.rateLimitKey;
  if (!fullRateLimitKey) {
    fullRateLimitKey = requestHeaders.get("x-real-ip") || void 0;
    if (!fullRateLimitKey) {
      throw new Error(
        "Could not determine rate limit key. `rateLimitKey` option is not provided and the client IP is not available."
      );
    }
  }
  let pathPrefix = process.env.PUBLIC_VERCEL_FIREWALL_PATH_PREFIX || process.env.NEXT_PUBLIC_VERCEL_FIREWALL_PATH_PREFIX || "";
  if (pathPrefix && !pathPrefix.startsWith("/")) {
    pathPrefix = `/${pathPrefix}`;
  }
  const url = `https://${firewallHost}${pathPrefix}/.well-known/vercel/rate-limit-api/${encodeURIComponent(rateLimitId)}`;
  fullRateLimitKey = `${fullRateLimitKey}-${await hashString(
    fullRateLimitKey + rateLimitId + (process.env.VERCEL_AUTOMATION_BYPASS_SECRET || "") + (process.env.RATE_LIMIT_SECRET || "")
  )}`;
  const rateLimitHeaders = new Headers({
    "x-vercel-rate-limit-api": rateLimitId,
    "x-vercel-rate-limit-key": fullRateLimitKey,
    "user-agent": "Bot/Vercel Rate Limit Checker",
    "x-forwarded-for": requestHeaders.get("x-forwarded-for") || "",
    "x-real-ip": requestHeaders.get("x-real-ip") || "",
    "x-vercel-protection-bypass": process.env.VERCEL_AUTOMATION_BYPASS_SECRET || ""
  });
  const cookies = parseCookies(requestHeaders);
  if (cookies._vercel_jwt) {
    rateLimitHeaders.append("cookie", `_vercel_jwt=${cookies._vercel_jwt}`);
  }
  for (const [key, value] of requestHeaders.entries()) {
    rateLimitHeaders.append(`x-rr-${key}`, value);
  }
  const response = await fetch(url, {
    method: "GET",
    headers: rateLimitHeaders,
    redirect: "manual",
    signal: options?.timeout === void 0 ? void 0 : AbortSignal.timeout(options.timeout)
  });
  if (response.status === 204) {
    return {
      rateLimited: false
    };
  }
  if (response.status === 429) {
    return {
      rateLimited: true
    };
  }
  if (response.status === 403) {
    return {
      rateLimited: true,
      error: "blocked"
    };
  }
  if (response.status === 404) {
    console.warn(`Rate-limit ID '${rateLimitId}' not configured`);
    return {
      rateLimited: false,
      error: "not-found"
    };
  }
  throw new Error(
    `Unexpected rate-limit API response status '${rateLimitId}': ${response.status}`
  );
}
async function hashString(input) {
  const encoder = new TextEncoder();
  const data = encoder.encode(input);
  const subtle = globalThis.crypto.subtle;
  const hashBuffer = await subtle.digest("SHA-256", data);
  const hashArray = Array.from(new Uint8Array(hashBuffer));
  const hashHex = hashArray.map((byte) => byte.toString(16).padStart(2, "0")).join("");
  return hashHex;
}
const SYMBOL_FOR_REQ_CONTEXT = Symbol.for("@vercel/request-context");
function getContext() {
  const fromSymbol = globalThis;
  return fromSymbol[SYMBOL_FOR_REQ_CONTEXT]?.get?.() ?? {};
}
function parseCookies(requestHeaders) {
  const cookies = requestHeaders.get("cookie");
  if (!cookies) {
    return {};
  }
  return cookies.split(";").reduce(
    (acc, cookie) => {
      const trimmedCookie = cookie.trim();
      const equalIndex = trimmedCookie.indexOf("=");
      if (equalIndex === -1) {
        acc[trimmedCookie] = "";
      } else {
        const key = trimmedCookie.slice(0, equalIndex);
        const value = trimmedCookie.slice(equalIndex + 1);
        acc[key] = value;
      }
      return acc;
    },
    {}
  );
}
// Annotate the CommonJS export names for ESM import in node:
0 && (module.exports = {
  checkRateLimit,
  unstable_checkRateLimit
});
