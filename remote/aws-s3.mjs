/**
 * The few AWS calls the Files store needs, with no AWS SDK: Signature Version 4
 * (header and presigned), STS AssumeRoleWithWebIdentity, and the S3 object
 * calls. Keeping this dependency-free leaves package.json, and so every shipped
 * artifact, unchanged.
 *
 * Nothing here logs. Errors carry the AWS error code and HTTP status only,
 * never a key, URL, token or credential.
 */
import { createHash, createHmac } from "node:crypto";

const ALGORITHM = "AWS4-HMAC-SHA256";
const UNSIGNED_PAYLOAD = "UNSIGNED-PAYLOAD";
const S3_TIMEOUT_MS = 20_000;
const STS_TIMEOUT_MS = 10_000;

export const sha256Hex = data => createHash("sha256").update(data).digest("hex");
const hmac = (key, data) => createHmac("sha256", key).update(data).digest();

/** RFC 3986 encoding, as SigV4 requires. */
export function uriEncode(value, { slash = true } = {}) {
  const encoded = encodeURIComponent(value).replace(/[!'()*]/g, c => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);
  return slash ? encoded : encoded.replace(/%2F/g, "/");
}

export function amzDate(date) {
  return date.toISOString().replace(/[-:]/g, "").replace(/\.\d{3}/, "");
}

function canonicalQuery(params) {
  return Object.keys(params).sort().map(key => `${uriEncode(key)}=${uriEncode(String(params[key]))}`).join("&");
}

function signature({ secretAccessKey, region, service, date, canonicalRequest }) {
  const day = date.slice(0, 8);
  const scope = `${day}/${region}/${service}/aws4_request`;
  const stringToSign = [ALGORITHM, date, scope, sha256Hex(canonicalRequest)].join("\n");
  let key = hmac(`AWS4${secretAccessKey}`, day);
  for (const part of [region, service, "aws4_request"]) key = hmac(key, part);
  return { scope, signature: createHmac("sha256", key).update(stringToSign).digest("hex") };
}

function canonicalHeaders(headers) {
  const entries = Object.entries(headers).map(([name, value]) => [name.toLowerCase(), String(value).trim().replace(/\s+/g, " ")]);
  entries.sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return { text: entries.map(([name, value]) => `${name}:${value}\n`).join(""), signed: entries.map(([name]) => name).join(";") };
}

/**
 * A presigned URL. `headers` (with `host`) are signed and must be sent exactly
 * as given. Session credentials add X-Amz-Security-Token to the query.
 */
export function presignUrl({ method, host, path, query = {}, headers = {}, credentials, region, service = "s3", expiresIn, now = new Date() }) {
  const date = amzDate(now);
  const all = { host, ...headers };
  const { text, signed } = canonicalHeaders(all);
  const day = date.slice(0, 8);
  const params = {
    ...query,
    "X-Amz-Algorithm": ALGORITHM,
    "X-Amz-Credential": `${credentials.accessKeyId}/${day}/${region}/${service}/aws4_request`,
    "X-Amz-Date": date,
    "X-Amz-Expires": String(expiresIn),
    "X-Amz-SignedHeaders": signed,
  };
  if (credentials.sessionToken) params["X-Amz-Security-Token"] = credentials.sessionToken;
  const canonicalRequest = [method, path, canonicalQuery(params), text, signed, UNSIGNED_PAYLOAD].join("\n");
  const { signature: sig } = signature({ secretAccessKey: credentials.secretAccessKey, region, service, date, canonicalRequest });
  return `https://${host}${path}?${canonicalQuery(params)}&X-Amz-Signature=${sig}`;
}

/** Headers for a request signed in the Authorization header. */
export function signHeaders({ method, host, path, query = {}, headers = {}, body, credentials, region, service = "s3", now = new Date(), payloadHash }) {
  const date = amzDate(now);
  const hash = payloadHash ?? sha256Hex(body ?? "");
  const all = { ...headers, host, "x-amz-date": date };
  if (service === "s3") all["x-amz-content-sha256"] = hash;
  if (credentials.sessionToken) all["x-amz-security-token"] = credentials.sessionToken;
  const { text, signed } = canonicalHeaders(all);
  const canonicalRequest = [method, path, canonicalQuery(query), text, signed, hash].join("\n");
  const { scope, signature: sig } = signature({ secretAccessKey: credentials.secretAccessKey, region, service, date, canonicalRequest });
  const out = { ...all, authorization: `${ALGORITHM} Credential=${credentials.accessKeyId}/${scope}, SignedHeaders=${signed}, Signature=${sig}` };
  delete out.host;
  return out;
}

export class AwsError extends Error {
  constructor(code, status) {
    super(`AWS ${code ?? "error"} (${status})`);
    this.name = "AwsError";
    this.code = code ?? null;
    this.status = status;
  }
}

const xmlValue = (xml, tag) => {
  const match = xml.match(new RegExp(`<${tag}>([\\s\\S]*?)</${tag}>`));
  return match ? unescapeXml(match[1]) : null;
};
export const unescapeXml = text => text.replace(/&(lt|gt|quot|apos|amp|#(\d+)|#x([0-9a-fA-F]+));/g, (_, name, dec, hex) =>
  dec ? String.fromCodePoint(Number(dec)) : hex ? String.fromCodePoint(parseInt(hex, 16)) : { lt: "<", gt: ">", quot: "\"", apos: "'", amp: "&" }[name]);
const escapeXml = text => text.replace(/[<>&'"]/g, c => ({ "<": "&lt;", ">": "&gt;", "&": "&amp;", "'": "&apos;", "\"": "&quot;" })[c]);

/** STS AssumeRoleWithWebIdentity. The token travels in a POST body, never a URL. */
export async function assumeRoleWithWebIdentity({ roleArn, webIdentityToken, durationSeconds, sessionName = "pdf-tools-files", region = "us-east-1", fetchImpl = fetch }) {
  const body = new URLSearchParams({
    Action: "AssumeRoleWithWebIdentity", Version: "2011-06-15", RoleArn: roleArn, RoleSessionName: sessionName,
    WebIdentityToken: webIdentityToken, DurationSeconds: String(durationSeconds),
  });
  const response = await fetchImpl(`https://sts.${region}.amazonaws.com/`, {
    method: "POST", body, headers: { "content-type": "application/x-www-form-urlencoded", accept: "application/xml" }, signal: AbortSignal.timeout(STS_TIMEOUT_MS),
  });
  const xml = await response.text();
  if (!response.ok) throw new AwsError(xmlValue(xml, "Code"), response.status);
  const credentials = {
    accessKeyId: xmlValue(xml, "AccessKeyId"),
    secretAccessKey: xmlValue(xml, "SecretAccessKey"),
    sessionToken: xmlValue(xml, "SessionToken"),
    expiresAt: Date.parse(xmlValue(xml, "Expiration") ?? ""),
  };
  if (!credentials.accessKeyId || !credentials.secretAccessKey || !credentials.sessionToken || !Number.isFinite(credentials.expiresAt)) throw new AwsError("MalformedStsResponse", response.status);
  return credentials;
}

/** S3 calls on one virtual-hosted bucket. `credentials()` returns live session credentials. */
export function createS3Client({ bucket, region, credentials, fetchImpl = fetch, clock = () => new Date() }) {
  const host = `${bucket}.s3.${region}.amazonaws.com`;
  const objectPath = key => `/${uriEncode(key, { slash: false })}`;

  async function call(method, path, { query = {}, headers = {}, body, maxBytes } = {}) {
    const signed = signHeaders({ method, host, path, query, headers, body, credentials: await credentials(), region, now: clock() });
    const search = Object.keys(query).length ? `?${canonicalQuery(query)}` : "";
    const response = await fetchImpl(`https://${host}${path}${search}`, { method, headers: signed, body, signal: AbortSignal.timeout(S3_TIMEOUT_MS) });
    if (maxBytes !== undefined && response.ok) {
      const length = Number(response.headers.get("content-length"));
      if (!Number.isFinite(length) || length > maxBytes) {
        await response.body?.cancel();
        throw new AwsError("ObjectTooLarge", response.status);
      }
    }
    return response;
  }
  const fail = async response => {
    const xml = await response.text().catch(() => "");
    return new AwsError(xmlValue(xml, "Code") ?? (response.status === 404 ? "NotFound" : null), response.status);
  };

  return {
    host,
    objectPath,
    async head(key) {
      const response = await call("HEAD", objectPath(key));
      if (response.status === 404) return null;
      if (!response.ok) throw await fail(response);
      return { size: Number(response.headers.get("content-length")) };
    },
    async get(key, { maxBytes }) {
      const response = await call("GET", objectPath(key), { maxBytes });
      if (response.status === 404) { await response.body?.cancel(); return null; }
      if (!response.ok) throw await fail(response);
      const bytes = new Uint8Array(await response.arrayBuffer());
      if (bytes.length > maxBytes) throw new AwsError("ObjectTooLarge", response.status);
      return bytes;
    },
    /** Write-once: returns false if the key already exists. */
    async putIfAbsent(key, body, { contentType = "application/octet-stream" } = {}) {
      const response = await call("PUT", objectPath(key), { body, headers: { "content-type": contentType, "content-length": String(body.length), "if-none-match": "*" } });
      if (response.status === 412) { await response.body?.cancel(); return false; }
      if (!response.ok) throw await fail(response);
      await response.body?.cancel();
      return true;
    },
    /** Unconditional write (replaces whatever is there). */
    async put(key, body, { contentType = "application/octet-stream" } = {}) {
      const response = await call("PUT", objectPath(key), { body, headers: { "content-type": contentType, "content-length": String(body.length) } });
      if (!response.ok) throw await fail(response);
      await response.body?.cancel();
    },
    async deleteObject(key) {
      const response = await call("DELETE", objectPath(key));
      if (!response.ok && response.status !== 404) throw await fail(response);
      await response.body?.cancel();
    },
    async deleteObjects(keys) {
      if (keys.length === 0) return;
      if (keys.length > 1000) throw new Error("at most 1000 keys per delete");
      const body = `<?xml version="1.0" encoding="UTF-8"?><Delete><Quiet>true</Quiet>${keys.map(key => `<Object><Key>${escapeXml(key)}</Key></Object>`).join("")}</Delete>`;
      const md5 = createHash("md5").update(body).digest("base64");
      const response = await call("POST", "/", { query: { delete: "" }, body, headers: { "content-type": "application/xml", "content-md5": md5 } });
      const xml = await response.text();
      if (!response.ok) throw new AwsError(xmlValue(xml, "Code"), response.status);
      if (/<Error>/.test(xml)) throw new AwsError(xmlValue(xml.slice(xml.indexOf("<Error>")), "Code") ?? "DeleteObjectsPartialFailure", response.status);
    },
    /** Every object under `prefix` (required: nothing outside the given prefix is ever listed). */
    async *list(prefix) {
      if (typeof prefix !== "string" || prefix.length === 0) throw new Error("list needs a prefix");
      let token;
      do {
        const query = { "list-type": "2", "max-keys": "1000", prefix };
        if (token) query["continuation-token"] = token;
        const response = await call("GET", "/", { query });
        const xml = await response.text();
        if (!response.ok) throw new AwsError(xmlValue(xml, "Code"), response.status);
        for (const [, entry] of xml.matchAll(/<Contents>([\s\S]*?)<\/Contents>/g)) {
          yield { key: xmlValue(entry, "Key"), lastModified: Date.parse(xmlValue(entry, "LastModified") ?? "") };
        }
        token = xmlValue(xml, "IsTruncated") === "true" ? xmlValue(xml, "NextContinuationToken") : null;
      } while (token);
    },
  };
}
