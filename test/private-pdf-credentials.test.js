import http from "node:http";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createPrivatePdfCredentials } from "../server/private-pdf-credentials.js";

const activeServices = new Set();
const SECRET = "synthetic-test-password";

function source(name = "one", change = {}) {
  return { canonical_path: `/synthetic/${name}.pdf`, file_identity: { device: 1, inode: name },
    sha256: "a".repeat(64), size_bytes: 100, ...change };
}

function deferred() {
  let resolve;
  const promise = new Promise(done => { resolve = done; });
  return { promise, resolve };
}

function fixture(options = {}) {
  let clock = 100_000;
  const sources = new Map([["/synthetic/one.pdf", source()]]);
  const urls = [];
  const validator = vi.fn(async (_source, password) => password === SECRET);
  const service = createPrivatePdfCredentials({
    bindSource: async name => {
      const value = sources.get(name);
      if (!value) throw new Error("sensitive source details");
      return structuredClone(value);
    },
    validatePassword: validator,
    openWindow: async url => { urls.push(new URL(url)); },
    now: () => clock,
    ...options,
  });
  activeServices.add(service);
  return { service, sources, urls, validator, advance: milliseconds => { clock += milliseconds; },
    async open(name = "/synthetic/one.pdf") { await service.requestUnlock(name); return urls.at(-1); } };
}

async function post(url, route = "/unlock", values = { password: SECRET }, options = {}) {
  const response = await fetch(`${url.origin}${route}`, {
    method: "POST", headers: { Origin: url.origin, "Content-Type": "application/json", ...options.headers },
    body: JSON.stringify({ token: url.hash.slice(1), ...values }), ...options,
  });
  return { status: response.status, body: await response.json() };
}

afterEach(async () => {
  await Promise.all([...activeServices].map(service => service.close()));
  activeServices.clear();
});

describe("private PDF password entry", () => {
  it("opens only a loopback capability window and returns password-free public status", async () => {
    const item = fixture();
    const pending = await item.service.requestUnlock("/synthetic/one.pdf");
    const url = item.urls[0];
    expect(url.hostname).toBe("127.0.0.1");
    expect(url.hash).toMatch(/^#[a-f0-9]{64}$/);
    expect(pending).toEqual({ status: "awaiting_password" });
    const shell = await fetch(url.origin);
    const html = await shell.text();
    expect(shell.headers.get("content-security-policy")).toContain("frame-ancestors 'none'");
    expect(shell.headers.get("cache-control")).toBe("no-store");
    expect(html).toContain('history.replaceState(null, "", location.pathname)');
    expect(html).toContain('type="password"');
    expect(html).not.toContain(url.hash.slice(1));
    expect(html).not.toContain("one.pdf");
    const unlocked = await post(url);
    expect(unlocked.status).toBe(200);
    expect(unlocked.body).toEqual({ status: "unlocked", expires_at: new Date(700_000).toISOString() });
    expect(await item.service.status("/synthetic/one.pdf")).toEqual(unlocked.body);
    expect(item.service.passwordForSource(source())).toBe(SECRET);
    expect(item.validator).toHaveBeenCalledWith(source(), SECRET);
    expect(JSON.stringify([pending, unlocked, html])).not.toContain(SECRET);
  });

  it("exposes source identity only after capability authentication", async () => {
    const item = fixture();
    const url = await item.open();
    expect(await post(url, "/session", {})).toEqual({ status: 200, body: {
      status: "awaiting_password", filename: "one.pdf", source_sha256: "a".repeat(64),
    } });
    expect((await post(url, "/session", { token: "f".repeat(64) })).status).toBe(403);
    expect((await fetch(`${url.origin}/session`)).status).toBe(403);
  });

  it.each([
    ["foreign Origin", { Origin: "https://example.invalid", "Content-Type": "application/json" }],
    ["missing Origin", { "Content-Type": "application/json" }],
    ["form content type", { Origin: "bad", "Content-Type": "application/x-www-form-urlencoded" }],
  ])("rejects %s before validator execution", async (_name, headers) => {
    const item = fixture();
    const url = await item.open();
    expect((await post(url, "/unlock", { password: SECRET }, { headers })).status).toBe(403);
    expect(item.validator).not.toHaveBeenCalled();
  });

  it("rejects forged Host even with a correct capability and Origin", async () => {
    const item = fixture();
    const url = await item.open();
    const status = await new Promise((resolve, reject) => {
      const request = http.request({ hostname: "127.0.0.1", port: url.port, path: "/unlock", method: "POST",
        headers: { Host: `localhost:${url.port}`, Origin: url.origin, "Content-Type": "application/json" } }, response => {
        response.resume(); response.on("end", () => resolve(response.statusCode));
      });
      request.on("error", reject);
      request.end(JSON.stringify({ token: url.hash.slice(1), password: SECRET }));
    });
    expect(status).toBe(403);
    expect(item.validator).not.toHaveBeenCalled();
  });

  it("rejects bad capabilities, extra fields, password limits and oversized bodies", async () => {
    const item = fixture();
    const url = await item.open();
    expect((await post(url, "/unlock", { password: SECRET, token: "f".repeat(64) })).status).toBe(403);
    expect((await post(url, "/unlock", { password: SECRET, source: "other.pdf" })).status).toBe(400);
    expect((await post(url, "/unlock", { password: "" })).status).toBe(400);
    expect((await post(url, "/unlock", { password: "a".repeat(1025) })).status).toBe(400);
    expect((await post(url, "/unlock", { password: "🧪".repeat(300) })).status).toBe(400);
    expect((await post(url, "/unlock", { password: "a".repeat(5000) })).status).toBe(403);
    expect(item.validator).not.toHaveBeenCalled();
  });

  it("limits wrong-password attempts and never echoes callback errors", async () => {
    const item = fixture({ validatePassword: async () => { throw new Error(SECRET); } });
    const url = await item.open();
    for (let count = 0; count < 5; count += 1) {
      const response = await post(url);
      expect(response.status).toBe(403);
      expect(JSON.stringify(response)).not.toContain(SECRET);
    }
    expect((await post(url)).status).toBe(409);
    expect(item.service.passwordForSource(source())).toBeUndefined();
  });

  it("allows a corrected password after an ordinary wrong password", async () => {
    const item = fixture();
    const url = await item.open();
    expect((await post(url, "/unlock", { password: "wrong" })).status).toBe(403);
    expect((await post(url)).status).toBe(200);
    expect((await post(url)).status).toBe(409);
    expect(item.validator).toHaveBeenCalledTimes(2);
  });

  it.each(["sha256", "inode", "size_bytes"])("invalidates changed source %s before use", async field => {
    const item = fixture();
    const url = await item.open();
    await post(url);
    const changed = source();
    if (field === "inode") changed.file_identity.inode = "replacement";
    else changed[field] = field === "sha256" ? "b".repeat(64) : 101;
    item.sources.set(changed.canonical_path, changed);
    expect(item.service.passwordForSource(changed)).toBeUndefined();
    expect(item.service.passwordForSource(source())).toBeUndefined();
    expect((await post(url, "/session", {})).status).toBe(403);
  });

  it("rechecks exact source after validation before installing any password", async () => {
    let item;
    item = fixture({ validatePassword: async () => {
      item.sources.set("/synthetic/one.pdf", source("one", { sha256: "b".repeat(64) }));
      return true;
    } });
    const url = await item.open();
    expect((await post(url)).status).toBe(403);
    expect(item.service.passwordForSource(source())).toBeUndefined();
  });

  it("rejects source replacement before calling the password validator", async () => {
    const item = fixture();
    const url = await item.open();
    item.sources.set("/synthetic/one.pdf", source("one", { sha256: "b".repeat(64) }));
    expect((await post(url)).status).toBe(403);
    expect(item.validator).not.toHaveBeenCalled();
    expect(item.service.passwordForSource(source())).toBeUndefined();
  });

  it("expires the window and the credential at their separate fixed deadlines", async () => {
    const item = fixture();
    const expiredUrl = await item.open();
    item.advance(5 * 60_000);
    expect((await post(expiredUrl)).status).toBe(403);
    expect(await item.service.status("/synthetic/one.pdf")).toEqual({ status: "expired" });
    const url = await item.open();
    await post(url);
    item.advance(5 * 60_000);
    expect(item.service.passwordForSource(source())).toBe(SECRET);
    expect((await post(url, "/session", {})).status).toBe(403);
    item.advance(5 * 60_000);
    expect(item.service.passwordForSource(source())).toBeUndefined();
    expect(await item.service.status("/synthetic/one.pdf")).toEqual({ status: "expired" });
  });

  it("never uses one source's password for a second source, even with equal bytes", async () => {
    const item = fixture();
    item.sources.set("/synthetic/two.pdf", source("two"));
    await post(await item.open());
    expect(item.service.passwordForSource(source("two"))).toBeUndefined();
    expect(() => item.service.passwordForSources([source(), source("two")])).toThrow();
    await post(await item.open("/synthetic/two.pdf"));
    expect(item.service.passwordForSources([source(), source("two")])).toBe(SECRET);
    await item.service.lock("/synthetic/one.pdf");
    expect(item.service.passwordForSource(source("two"))).toBe(SECRET);
    expect(item.service.passwordForSource(source())).toBeUndefined();
  });

  it("refuses different unlocked passwords for a shared-password operation", async () => {
    const item = fixture({ validatePassword: async () => true });
    item.sources.set("/synthetic/two.pdf", source("two"));
    await post(await item.open());
    await post(await item.open("/synthetic/two.pdf"), "/unlock", { password: "other-password" });
    expect(() => item.service.passwordForSources([source(), source("two")])).toThrow();
  });

  it("does not accept another service's capability or transfer its password", async () => {
    const first = fixture();
    const second = fixture();
    const a = await first.open();
    const b = await second.open();
    expect((await post(b, "/unlock", { token: a.hash.slice(1), password: SECRET })).status).toBe(403);
    await post(a);
    expect(second.service.passwordForSource(source())).toBeUndefined();
  });

  it("serializes validation and lock prevents a late credential install", async () => {
    const entered = deferred();
    const finish = deferred();
    const item = fixture({ validatePassword: async () => { entered.resolve(); await finish.promise; return true; } });
    const url = await item.open();
    const first = post(url);
    await entered.promise;
    expect((await post(url)).status).toBe(409);
    expect(await post(url, "/lock", {})).toEqual({ status: 200, body: { status: "locked" } });
    finish.resolve();
    expect((await first).status).toBe(403);
    expect(item.service.passwordForSource(source())).toBeUndefined();
  });

  it("source lock during validation invalidates the pending install", async () => {
    const entered = deferred();
    const finish = deferred();
    const item = fixture({ validatePassword: async () => { entered.resolve(); await finish.promise; return true; } });
    const url = await item.open();
    const first = post(url);
    await entered.promise;
    await item.service.lock("/synthetic/one.pdf");
    finish.resolve();
    expect((await first).status).toBe(403);
    expect(item.service.passwordForSource(source())).toBeUndefined();
  });

  it("caps active documents and reuses capacity after explicit cancel", async () => {
    const item = fixture();
    for (let index = 0; index < 8; index += 1) {
      const current = source(String(index));
      item.sources.set(current.canonical_path, current);
      await item.open(current.canonical_path);
    }
    await expect(item.service.requestUnlock("/synthetic/one.pdf")).rejects.toMatchObject({ code: "PRIVATE_PDF_CAPACITY_REACHED" });
    await post(item.urls[0], "/cancel", {});
    await expect(item.service.requestUnlock("/synthetic/one.pdf")).resolves.toEqual({ status: "awaiting_password" });
  });

  it("invalidates the old window when the same document is requested again", async () => {
    const item = fixture();
    const first = await item.open();
    const second = await item.open();
    expect(first.hash).not.toBe(second.hash);
    expect((await post(first)).status).toBe(403);
    expect((await post(second)).status).toBe(200);
  });

  it("bounds total attempts even when a caller repeatedly opens new windows", async () => {
    const item = fixture();
    for (let index = 0; index < 20; index += 1) {
      expect((await post(await item.open(), "/unlock", { password: "wrong" })).status).toBe(403);
    }
    expect((await post(await item.open())).status).toBe(429);
    expect(item.validator).toHaveBeenCalledTimes(20);
    item.advance(60_000);
    expect((await post(await item.open())).status).toBe(200);
  });

  it("rejects source/open failures with fixed errors", async () => {
    const item = fixture();
    await expect(item.service.status("/missing.pdf")).rejects.toMatchObject({ code: "PRIVATE_PDF_SOURCE_UNAVAILABLE" });
    const failed = fixture({ openWindow: async () => { throw new Error(SECRET); } });
    await expect(failed.open()).rejects.not.toThrow(SECRET);
    expect(await failed.service.status("/synthetic/one.pdf")).toEqual({ status: "locked" });
  });

  it("clears credentials immediately on close and closes the socket", async () => {
    const item = fixture();
    const url = await item.open();
    await post(url);
    const closing = item.service.close();
    expect(item.service.passwordForSource(source())).toBeUndefined();
    await closing;
    await expect(fetch(url.origin)).rejects.toThrow();
    await expect(item.service.requestUnlock("/synthetic/one.pdf")).rejects.toThrow();
  });
});
