import { describe, expect, it } from "vitest";

import { MAX_SEALED_LENGTH, open, parseSealingKeys, seal, SealRefused } from "../remote/sealed.mjs";

const KEY_A = "a".repeat(64);
const KEY_B = "b".repeat(64);
const NOW = 1_800_000_000;
const keys = parseSealingKeys(`k1:${KEY_A}`);

function refusal(fn) {
  try { fn(); } catch (error) { expect(error).toBeInstanceOf(SealRefused); return error.reason; }
  throw new Error("expected a refusal");
}

describe("sealed client-held values (signing profile S1)", () => {
  it("round-trips a payload for its own purpose and reports the expiry", () => {
    const sealed = seal("access", { lumin: "synthetic-token" }, { keys, expiresAt: NOW + 60 });
    expect(sealed).toMatch(/^ods1\.k1\.[A-Za-z0-9_-]+$/);
    expect(sealed).not.toContain("synthetic-token");
    expect(open("access", sealed, { keys, now: NOW })).toEqual({ lumin: "synthetic-token", expiresAt: NOW + 60 });
  });

  it("produces a different value each time for the same payload", () => {
    const options = { keys, expiresAt: NOW + 60 };
    expect(seal("code", { a: 1 }, options)).not.toBe(seal("code", { a: 1 }, options));
  });

  it("refuses a value presented for another purpose", () => {
    const code = seal("code", { lumin: "synthetic" }, { keys, expiresAt: NOW + 60 });
    expect(refusal(() => open("access", code, { keys, now: NOW }))).toBe("forged");
    expect(refusal(() => open("refresh", code, { keys, now: NOW }))).toBe("forged");
  });

  it("refuses expired values, including at the exact expiry second", () => {
    const sealed = seal("state", { s: 1 }, { keys, expiresAt: NOW + 10 });
    expect(open("state", sealed, { keys, now: NOW + 9 }).s).toBe(1);
    expect(refusal(() => open("state", sealed, { keys, now: NOW + 10 }))).toBe("expired");
  });

  it("refuses any single-character tamper of the body", () => {
    const sealed = seal("client", { redirect_uris: ["https://claude.ai/api/mcp/auth_callback"] }, { keys, expiresAt: NOW + 60 });
    const prefix = sealed.lastIndexOf(".") + 1;
    for (let index = prefix; index < sealed.length; index += 7) {
      const swapped = sealed[index] === "A" ? "B" : "A";
      const tampered = sealed.slice(0, index) + swapped + sealed.slice(index + 1);
      expect(() => open("client", tampered, { keys, now: NOW })).toThrow(SealRefused);
    }
  });

  it("refuses values sealed under a key that is no longer configured", () => {
    const sealed = seal("access", { a: 1 }, { keys, expiresAt: NOW + 60 });
    expect(refusal(() => open("access", sealed, { keys: parseSealingKeys(`k2:${KEY_B}`), now: NOW }))).toBe("unknown_key");
    expect(refusal(() => open("access", sealed, { keys: parseSealingKeys(`k1:${KEY_B}`), now: NOW }))).toBe("forged");
  });

  it("opens values from the previous key during a rotation and seals with the new one", () => {
    const old = seal("refresh", { r: 1 }, { keys, expiresAt: NOW + 60 });
    const rotated = parseSealingKeys(`k2:${KEY_B},k1:${KEY_A}`);
    expect(open("refresh", old, { keys: rotated, now: NOW }).r).toBe(1);
    expect(seal("refresh", { r: 2 }, { keys: rotated, expiresAt: NOW + 60 })).toMatch(/^ods1\.k2\./);
  });

  it("treats missing or malformed key configuration as unavailable, never as a weak key", () => {
    for (const value of [undefined, "", "k1", `k1:${"a".repeat(63)}`, `K1:${KEY_A}`, `k1:${KEY_A},k1:${KEY_B}`, `k1:${KEY_A}g`]) {
      expect(parseSealingKeys(value)).toBeNull();
    }
    expect(refusal(() => seal("access", { a: 1 }, { keys: null, expiresAt: NOW + 60 }))).toBe("unconfigured");
    expect(refusal(() => open("access", "ods1.k1.AAAA", { keys: [], now: NOW }))).toBe("unconfigured");
  });

  it("refuses malformed, noncanonical and oversized inputs before decrypting", () => {
    expect(refusal(() => open("access", "not-a-seal", { keys, now: NOW }))).toBe("malformed");
    expect(refusal(() => open("access", "ods1.k1.", { keys, now: NOW }))).toBe("malformed");
    expect(refusal(() => open("access", `ods1.k1.${"A".repeat(MAX_SEALED_LENGTH)}`, { keys, now: NOW }))).toBe("malformed");
    const sealed = seal("access", { a: 1 }, { keys, expiresAt: NOW + 60 });
    expect(refusal(() => open("access", `${sealed}=`, { keys, now: NOW }))).toBe("malformed");
  });

  it("rejects unknown purposes and payloads that try to set their own expiry", () => {
    expect(() => seal("session", { a: 1 }, { keys, expiresAt: NOW + 60 })).toThrow(TypeError);
    expect(() => seal("access", { exp: NOW + 99999 }, { keys, expiresAt: NOW + 60 })).toThrow(TypeError);
    expect(() => open("session", "ods1.k1.AAAA", { keys, now: NOW })).toThrow(TypeError);
  });

  it("does not put the payload or key into the refusal message", () => {
    const sealed = seal("access", { lumin: "synthetic-secret-value" }, { keys, expiresAt: NOW - 1 + 1 });
    try { open("access", sealed, { keys, now: NOW + 5 }); } catch (error) {
      expect(error.message).toBe("The sealed value was not accepted.");
      expect(error.message).not.toContain("synthetic-secret-value");
    }
  });
});
