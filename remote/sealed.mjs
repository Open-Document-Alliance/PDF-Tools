/**
 * Sealed, client-held values for the hosted signing surface.
 *
 * See docs/REMOTE_SIGNING_PROFILE_2026-11-25.md, property S1. Every OAuth
 * artifact the signing surface issues (client registration, authorization
 * state, authorization code, access token, refresh token) is one of these:
 * AES-256-GCM over a JSON payload, with the purpose bound as additional
 * authenticated data so a value minted for one purpose is refused as another.
 * The server keeps no table of them. It opens one per request and forgets it.
 *
 * Keys come from PDF_TOOLS_SIGN_SEALING_KEYS as "kid:hex64[,kid:hex64]". The
 * first key seals; every listed key opens, so a rotation can keep the previous
 * key for a window. Removing a key invalidates everything it sealed.
 */
import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";

export const SEAL_PURPOSES = Object.freeze(["client", "state", "code", "access", "refresh"]);
export const MAX_SEALED_LENGTH = 8192;

const PREFIX = "ods1";
const IV_BYTES = 12;
const TAG_BYTES = 16;
const KID_PATTERN = /^[a-z0-9]{1,16}$/;
const SEALED_PATTERN = /^ods1\.([a-z0-9]{1,16})\.([A-Za-z0-9_-]+)$/;

export class SealRefused extends Error {
  constructor(reason) {
    super("The sealed value was not accepted.");
    this.reason = reason;
  }
}

/** Parse the key list. Malformed configuration means the surface is unavailable, never a weak key. */
export function parseSealingKeys(value) {
  if (typeof value !== "string" || !value) return null;
  const entries = value.split(",");
  if (entries.length > 4) return null;
  const keys = [];
  const seen = new Set();
  for (const entry of entries) {
    const match = /^([a-z0-9]{1,16}):([a-f0-9]{64})$/.exec(entry.trim());
    if (!match || seen.has(match[1])) return null;
    seen.add(match[1]);
    keys.push(Object.freeze({ kid: match[1], key: Buffer.from(match[2], "hex") }));
  }
  return Object.freeze(keys);
}

function aad(purpose, kid) {
  return Buffer.from(`pdf-tools-sign:${PREFIX}:${purpose}:${kid}`);
}

function assertPurpose(purpose) {
  if (!SEAL_PURPOSES.includes(purpose)) throw new TypeError("unknown seal purpose");
}

/**
 * Seal a JSON payload for one purpose with an absolute expiry in Unix seconds.
 * The expiry is inside the ciphertext, so it cannot be edited without breaking
 * the tag.
 */
export function seal(purpose, payload, { keys, expiresAt }) {
  assertPurpose(purpose);
  if (!Array.isArray(keys) || keys.length === 0) throw new SealRefused("unconfigured");
  if (!Number.isSafeInteger(expiresAt)) throw new TypeError("expiresAt must be Unix seconds");
  if (!payload || typeof payload !== "object" || Array.isArray(payload) || "exp" in payload) {
    throw new TypeError("payload must be a plain object without exp");
  }
  const { kid, key } = keys[0];
  if (!KID_PATTERN.test(kid)) throw new TypeError("invalid key id");
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  cipher.setAAD(aad(purpose, kid));
  const plaintext = Buffer.from(JSON.stringify({ ...payload, exp: expiresAt }));
  const body = Buffer.concat([iv, cipher.update(plaintext), cipher.final(), cipher.getAuthTag()]);
  const sealed = `${PREFIX}.${kid}.${body.toString("base64url")}`;
  if (sealed.length > MAX_SEALED_LENGTH) throw new SealRefused("too_large");
  return sealed;
}

/**
 * Open a sealed value for the purpose the caller expects. Every failure is the
 * same SealRefused to the outside; `reason` is for tests, never for logs that
 * include the value.
 */
export function open(purpose, sealed, { keys, now = Math.floor(Date.now() / 1000) }) {
  assertPurpose(purpose);
  if (!Array.isArray(keys) || keys.length === 0) throw new SealRefused("unconfigured");
  if (typeof sealed !== "string" || sealed.length > MAX_SEALED_LENGTH) throw new SealRefused("malformed");
  const match = SEALED_PATTERN.exec(sealed);
  if (!match) throw new SealRefused("malformed");
  const entry = keys.find(candidate => candidate.kid === match[1]);
  if (!entry) throw new SealRefused("unknown_key");
  const body = Buffer.from(match[2], "base64url");
  if (body.toString("base64url") !== match[2] || body.length < IV_BYTES + TAG_BYTES + 2) {
    throw new SealRefused("malformed");
  }
  const iv = body.subarray(0, IV_BYTES);
  const tag = body.subarray(body.length - TAG_BYTES);
  const ciphertext = body.subarray(IV_BYTES, body.length - TAG_BYTES);
  let plaintext;
  try {
    const decipher = createDecipheriv("aes-256-gcm", entry.key, iv, { authTagLength: TAG_BYTES });
    decipher.setAAD(aad(purpose, entry.kid));
    decipher.setAuthTag(tag);
    plaintext = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
  } catch {
    throw new SealRefused("forged");
  }
  let payload;
  try { payload = JSON.parse(plaintext.toString("utf8")); } catch { throw new SealRefused("forged"); }
  if (!payload || typeof payload !== "object" || Array.isArray(payload) || !Number.isSafeInteger(payload.exp)) {
    throw new SealRefused("forged");
  }
  if (payload.exp <= now) throw new SealRefused("expired");
  const { exp, ...rest } = payload;
  return Object.freeze({ ...rest, expiresAt: exp });
}
