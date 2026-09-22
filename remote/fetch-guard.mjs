/**
 * URL fetch guard for the remote stateless profile (threat T1 in
 * docs/REMOTE_STATELESS_PROFILE_2026-09-19.md).
 *
 * The local product fetches URLs on the user's own machine, where reaching a
 * private address is the user's own business and is gated behind an explicit
 * `allow_private_hosts` flag. On a public endpoint the same tool becomes a
 * request forger that anyone on the internet can aim at cloud metadata
 * services and internal networks, so there is no flag here: private
 * destinations are refused, and the refusal is rechecked after every redirect
 * because DNS can resolve differently on a later lookup.
 */

import { lookup } from "node:dns/promises";
import { isIP } from "node:net";

export const MAX_PDF_BYTES = 25 * 1024 * 1024;
export const MAX_REDIRECTS = 3;
export const FETCH_TIMEOUT_MS = 15_000;

export class FetchRefused extends Error {
  constructor(code, message) {
    super(message);
    this.name = "FetchRefused";
    this.code = code;
  }
}

/** Address ranges that a public fetcher must never reach. */
function isBlockedAddress(address, family) {
  if (family === 4) {
    const [a, b] = address.split(".").map(Number);
    if (a === 0 || a === 10 || a === 127) return true;
    if (a === 169 && b === 254) return true; // link-local, includes cloud metadata
    if (a === 172 && b >= 16 && b <= 31) return true;
    if (a === 192 && b === 168) return true;
    if (a === 100 && b >= 64 && b <= 127) return true; // carrier-grade NAT, tailnets
    if (a >= 224) return true; // multicast and reserved
    return false;
  }
  const value = address.toLowerCase();
  if (value === "::" || value === "::1") return true;
  if (value.startsWith("fe80") || value.startsWith("fc") || value.startsWith("fd")) return true;
  if (value.startsWith("ff")) return true;
  if (value.startsWith("::ffff:")) {
    const mapped = value.slice(7);
    if (isIP(mapped) === 4) return isBlockedAddress(mapped, 4);
  }
  return false;
}

async function assertPublicHost(hostname) {
  // `URL` keeps the brackets on an IPv6 literal, and `isIP` does not accept
  // them, so an unstripped `[::1]` would fall through to a DNS lookup and be
  // refused as an unresolvable name rather than as the loopback address it is.
  const candidate = hostname.startsWith("[") && hostname.endsWith("]")
    ? hostname.slice(1, -1)
    : hostname;
  const literal = isIP(candidate);
  if (literal) {
    if (isBlockedAddress(candidate, literal)) {
      throw new FetchRefused("PRIVATE_ADDRESS", "That address is not reachable from this service.");
    }
    return;
  }
  let records;
  try {
    records = await lookup(hostname, { all: true });
  } catch {
    throw new FetchRefused("DNS_FAILED", "That hostname could not be resolved.");
  }
  if (records.length === 0) {
    throw new FetchRefused("DNS_FAILED", "That hostname could not be resolved.");
  }
  for (const record of records) {
    if (isBlockedAddress(record.address, record.family)) {
      throw new FetchRefused("PRIVATE_ADDRESS", "That address is not reachable from this service.");
    }
  }
}

function assertHttpUrl(value) {
  let url;
  try {
    url = new URL(value);
  } catch {
    throw new FetchRefused("INVALID_URL", "That is not a valid URL.");
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") {
    throw new FetchRefused("UNSUPPORTED_SCHEME", "Only http and https URLs are supported.");
  }
  return url;
}

function looksLikePdf(bytes) {
  return bytes.length > 4 && bytes[0] === 0x25 && bytes[1] === 0x50 && bytes[2] === 0x44 && bytes[3] === 0x46;
}

/**
 * Fetch a PDF by URL, following redirects manually so each hop is re-checked.
 * Returns the bytes only when they are actually a PDF, so this cannot be used
 * to read arbitrary internal content through a PDF-shaped tool.
 */
export async function fetchPdfBytes(rawUrl, { fetchImpl = fetch } = {}) {
  let url = assertHttpUrl(rawUrl);
  for (let hop = 0; hop <= MAX_REDIRECTS; hop += 1) {
    await assertPublicHost(url.hostname);
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
    let response;
    try {
      response = await fetchImpl(url, { redirect: "manual", signal: controller.signal });
    } catch (error) {
      if (error?.name === "AbortError") throw new FetchRefused("TIMEOUT", "That URL took too long to respond.");
      throw new FetchRefused("FETCH_FAILED", "That URL could not be fetched.");
    } finally {
      clearTimeout(timer);
    }

    if (response.status >= 300 && response.status < 400) {
      const location = response.headers.get("location");
      if (!location) throw new FetchRefused("FETCH_FAILED", "That URL redirected without a destination.");
      url = assertHttpUrl(new URL(location, url).toString());
      continue;
    }
    if (!response.ok) {
      throw new FetchRefused("HTTP_ERROR", `That URL returned HTTP ${response.status}.`);
    }

    const declared = Number(response.headers.get("content-length"));
    if (Number.isFinite(declared) && declared > MAX_PDF_BYTES) {
      throw new FetchRefused("TOO_LARGE", `That document is larger than the ${MAX_PDF_BYTES / 1024 / 1024} MB limit.`);
    }

    const buffer = await readBounded(response, MAX_PDF_BYTES);
    if (!looksLikePdf(buffer)) {
      throw new FetchRefused("NOT_A_PDF", "That URL did not return a PDF.");
    }
    return buffer;
  }
  throw new FetchRefused("TOO_MANY_REDIRECTS", "That URL redirected too many times.");
}

/** Read a response body without trusting its declared length. */
async function readBounded(response, limit) {
  const reader = response.body?.getReader();
  if (!reader) {
    const bytes = new Uint8Array(await response.arrayBuffer());
    if (bytes.length > limit) throw new FetchRefused("TOO_LARGE", "That document exceeds the size limit.");
    return bytes;
  }
  const chunks = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.length;
    if (total > limit) {
      await reader.cancel();
      throw new FetchRefused("TOO_LARGE", `That document is larger than the ${limit / 1024 / 1024} MB limit.`);
    }
    chunks.push(value);
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.length;
  }
  return bytes;
}

export const testing = { isBlockedAddress, assertPublicHost, assertHttpUrl, looksLikePdf };
