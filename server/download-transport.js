// Local download transport. The address policy and connection pinning follow
// remote/fetch-guard.mjs; only the local tool has an explicit private-host opt-in.
import { lookup } from "node:dns/promises";
import { isIP } from "node:net";
import { request as httpRequest } from "node:http";
import { request as httpsRequest } from "node:https";
import { Readable, pipeline } from "node:stream";
import { createBrotliDecompress, createGunzip, createInflate } from "node:zlib";

export function isBlockedDownloadAddress(address, family = isIP(address)) {
  if (!family || isIP(address) !== family) return true;
  if (family === 4) {
    const [a, b, c] = address.split(".").map(Number);
    if (a === 0 || a === 10 || a === 127) return true;
    if (a === 169 && b === 254) return true;
    if (a === 172 && b >= 16 && b <= 31) return true;
    if (a === 192 && b === 168) return true;
    if (a === 100 && b >= 64 && b <= 127) return true;
    if (a === 192 && b === 0 && (c === 0 || c === 2)) return true;
    if (a === 192 && b === 88 && c === 99) return true;
    if (a === 198 && (b === 18 || b === 19 || (b === 51 && c === 100))) return true;
    if (a === 203 && b === 0 && c === 113) return true;
    return a >= 224;
  }
  // Admit global unicast only. In particular, IPv4-mapped, scoped/link-local,
  // NAT64, multicast and other special addresses cannot evade the IPv4 policy.
  const [a, b = "0"] = address.toLowerCase().split(":");
  const first = parseInt(a, 16);
  const second = parseInt(b || "0", 16);
  if (!(first >= 0x2000 && first <= 0x3fff)) return true;
  if (first === 0x2001 && (second <= 0x1ff || second === 0xdb8)) return true;
  return first === 0x2002 || first === 0x3fff;
}

export async function resolvePdfDownloadAddress(hostname, {
  allowPrivateHosts = false,
  lookupFn = lookup,
} = {}) {
  const candidate = hostname.replace(/^\[|\]$/g, "");
  const family = isIP(candidate);
  const records = family
    ? [{ address: candidate, family }]
    : await lookupFn(candidate, { all: true });
  if (!Array.isArray(records) || records.length === 0) {
    throw new Error("The download hostname could not be resolved.");
  }
  for (const record of records) {
    if (!record || ![4, 6].includes(record.family) || isIP(record.address) !== record.family) {
      throw new Error("The download hostname returned an invalid address.");
    }
    if (allowPrivateHosts !== true && isBlockedDownloadAddress(record.address, record.family)) {
      throw new Error("Refusing to download from a private/loopback or reserved address. "
        + "Set allow_private_hosts=true only for a trusted destination.");
    }
  }
  return records[0];
}

export async function fetchPdfDownloadResponse(rawUrl, {
  signal,
  headers = {},
  allowPrivateHosts = false,
  lookupFn = lookup,
  requestFn,
} = {}) {
  const url = new URL(rawUrl);
  if (!["http:", "https:"].includes(url.protocol) || url.username || url.password) {
    throw new Error("Only HTTP(S) URLs without embedded credentials are supported.");
  }
  signal?.throwIfAborted();
  const { address, family } = await resolvePdfDownloadAddress(url.hostname, { allowPrivateHosts, lookupFn });
  // A resolver may finish after cancellation. It must never start a late socket.
  signal?.throwIfAborted();
  const requestImpl = requestFn ?? (url.protocol === "https:" ? httpsRequest : httpRequest);
  return new Promise((resolve, reject) => {
    const request = requestImpl(url, {
      agent: false,
      signal,
      family,
      autoSelectFamily: false,
      lookup: (_hostname, options, callback) => {
        if (options.all) callback(null, [{ address, family }]);
        else callback(null, address, family);
      },
      // No connection pool or second DNS resolution. Keep URL-derived Host/SNI
      // even when callers supply additional headers. Prefer uncompressed bytes.
      headers: { ...headers, host: url.host, "accept-encoding": "identity" },
    }, response => {
      let decoder;
      try {
        const responseHeaders = new Headers();
        for (let index = 0; index < response.rawHeaders.length; index += 2) {
          responseHeaders.append(response.rawHeaders[index], response.rawHeaders[index + 1]);
        }
        const encoding = (responseHeaders.get("content-encoding") || "identity").toLowerCase().trim();
        // Some servers compress despite Accept-Encoding. The downstream limit
        // counts decoded bytes, including this path, rather than wire length.
        if (encoding === "gzip" || encoding === "x-gzip") decoder = createGunzip();
        else if (encoding === "deflate") decoder = createInflate();
        else if (encoding === "br") decoder = createBrotliDecompress();
        else if (encoding !== "identity") throw new Error("Unsupported download content encoding.");
        if (decoder) pipeline(response, decoder, () => {});
        resolve({
          status: response.statusCode,
          statusText: response.statusMessage || "",
          ok: response.statusCode >= 200 && response.statusCode < 300,
          headers: responseHeaders,
          body: Readable.toWeb(decoder || response, {
            strategy: { highWaterMark: 64 * 1024, size: chunk => chunk.byteLength },
          }),
          dispose: () => { decoder?.destroy(); response.destroy(); },
        });
      } catch (error) {
        decoder?.destroy();
        response.destroy();
        reject(error);
      }
    });
    request.once("error", reject);
    request.end();
  });
}
