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
import { request as httpRequest } from "node:http";
import { request as httpsRequest } from "node:https";
import { Readable } from "node:stream";

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
  if (isIP(address) !== family) return true;
  if (family === 4) {
    const [a, b, c] = address.split(".").map(Number);
    if (a === 0 || a === 10 || a === 127) return true;
    if (a === 169 && b === 254) return true; // link-local, includes cloud metadata
    if (a === 172 && b >= 16 && b <= 31) return true;
    if (a === 192 && b === 168) return true;
    if (a === 100 && b >= 64 && b <= 127) return true; // carrier-grade NAT, tailnets
    if (a === 192 && b === 0 && (c === 0 || c === 2)) return true;
    if (a === 192 && b === 88 && c === 99) return true;
    if (a === 198 && (b === 18 || b === 19 || (b === 51 && c === 100))) return true;
    if (a === 203 && b === 0 && c === 113) return true;
    if (a >= 224) return true; // multicast and reserved
    return false;
  }
  // Only global unicast 2000::/3 is admitted. This also refuses IPv4-mapped,
  // NAT64, scoped/link-local and other special addresses, including hex forms.
  const [a, b = "0"] = address.toLowerCase().split(":");
  const first = parseInt(a, 16);
  const second = parseInt(b || "0", 16);
  if (!(first >= 0x2000 && first <= 0x3fff)) return true;
  if (first === 0x2001 && (second <= 0x1ff || second === 0xdb8)) return true;
  if (first === 0x2002 || first === 0x3fff) return true; // 6to4, documentation
  return false;
}

async function assertPublicHost(hostname, lookupImpl = lookup) {
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
    return { address: candidate, family: literal };
  }
  let records;
  try {
    records = await lookupImpl(hostname, { all: true });
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
  return records[0];
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
  if (url.username || url.password) throw new FetchRefused("INVALID_URL", "URLs with embedded credentials are not supported.");
  return url;
}

function timeoutError() {
  return new FetchRefused("TIMEOUT", "The document download exceeded its time limit.");
}

function abortable(promise, signal) {
  if (signal.aborted) {
    void Promise.resolve(promise).catch(() => {});
    return Promise.reject(timeoutError());
  }
  return new Promise((resolve, reject) => {
    const abort = () => reject(timeoutError());
    signal.addEventListener("abort", abort, { once: true });
    Promise.resolve(promise).then(resolve, reject).finally(() => signal.removeEventListener("abort", abort));
  });
}

/** One shared download deadline, also used across all inputs to a merge. */
export function createFetchBudget(timeoutMs = FETCH_TIMEOUT_MS) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  return { signal: controller.signal, close: () => clearTimeout(timer) };
}

/** No pooled socket or second DNS lookup: keep Host/SNI, pin the connection. */
function pinnedResponse(url, { signal, address, family, requestImpl = url.protocol === "https:" ? httpsRequest : httpRequest }) {
  return new Promise((resolve, reject) => {
    const request = requestImpl(url, {
      agent: false, signal, family, autoSelectFamily: false,
      lookup: (_hostname, options, callback) => {
        if (options.all) callback(null, [{ address, family }]);
        else callback(null, address, family);
      },
      headers: { Accept: "application/pdf", "Accept-Encoding": "identity" },
    }, response => {
      const headers = new Headers();
      for (let index = 0; index < response.rawHeaders.length; index += 2) headers.append(response.rawHeaders[index], response.rawHeaders[index + 1]);
      resolve({
        status: response.statusCode, ok: response.statusCode >= 200 && response.statusCode < 300,
        headers, body: Readable.toWeb(response), dispose: () => response.destroy(),
      });
    });
    request.once("error", reject);
    request.end();
  });
}

function dispose(response) {
  response?.dispose?.();
  if (response?.body && !response.body.locked) void response.body.cancel().catch(() => {});
}

function looksLikePdf(bytes) {
  return bytes.length > 4 && bytes[0] === 0x25 && bytes[1] === 0x50 && bytes[2] === 0x44 && bytes[3] === 0x46;
}

/**
 * Fetch a PDF by URL, following redirects manually so each hop is re-checked.
 * Returns the bytes only when they are actually a PDF, so this cannot be used
 * to read arbitrary internal content through a PDF-shaped tool.
 */
export async function fetchPdfBytes(rawUrl, { fetchImpl = pinnedResponse, lookupImpl = lookup, budget } = {}) {
  let url = assertHttpUrl(rawUrl);
  const ownedBudget = budget ? null : createFetchBudget();
  const { signal } = budget || ownedBudget;
  try {
    for (let hop = 0; hop <= MAX_REDIRECTS; hop += 1) {
      const approved = await abortable(assertPublicHost(url.hostname, lookupImpl), signal);
      if (signal.aborted) throw timeoutError();
      let response;
      try {
        // If a test/transport resolves after timeout, its body is still closed.
        const pending = Promise.resolve(fetchImpl(url, { redirect: "manual", signal, ...approved }));
        pending.then(late => { if (signal.aborted) dispose(late); }, () => {});
        response = await abortable(pending, signal);
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
        const buffer = await readBounded(response, MAX_PDF_BYTES, signal);
        if (!looksLikePdf(buffer)) throw new FetchRefused("NOT_A_PDF", "That URL did not return a PDF.");
        return buffer;
      } catch (error) {
        if (signal.aborted || error?.name === "AbortError") throw timeoutError();
        if (error instanceof FetchRefused) throw error;
        throw new FetchRefused("FETCH_FAILED", "That URL could not be fetched.");
      } finally {
        dispose(response);
      }
    }
    throw new FetchRefused("TOO_MANY_REDIRECTS", "That URL redirected too many times.");
  } finally {
    ownedBudget?.close();
  }
}

/** Read a response body without trusting its declared length. */
async function readBounded(response, limit, signal) {
  const reader = response.body?.getReader();
  if (!reader) {
    const bytes = new Uint8Array(await abortable(response.arrayBuffer(), signal));
    if (bytes.length > limit) throw new FetchRefused("TOO_LARGE", "That document exceeds the size limit.");
    return bytes;
  }
  const chunks = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await abortable(reader.read(), signal);
      if (done) break;
      total += value.length;
      if (total > limit) throw new FetchRefused("TOO_LARGE", `That document is larger than the ${limit / 1024 / 1024} MB limit.`);
      chunks.push(value);
    }
    const bytes = new Uint8Array(total);
    let offset = 0;
    for (const chunk of chunks) {
      bytes.set(chunk, offset);
      offset += chunk.length;
    }
    return bytes;
  } finally {
    // Do not wait for a stalled producer to acknowledge cancellation.
    void reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}

export const testing = { isBlockedAddress, assertPublicHost, assertHttpUrl, looksLikePdf, pinnedResponse };
