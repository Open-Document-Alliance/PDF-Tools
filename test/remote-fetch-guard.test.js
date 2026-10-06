import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { createServer } from "node:http";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createFetchBudget, fetchPdfBytes, MAX_PDF_BYTES, testing } from "../remote/fetch-guard.mjs";

const transport = vi.hoisted(() => ({ request: vi.fn() }));
vi.mock("node:https", () => ({ request: transport.request }));
afterEach(() => { vi.useRealTimers(); transport.request.mockReset(); });
const publicLookup = async () => [{ address: "8.8.8.8", family: 4 }];
const pdf = () => new Response("%PDF synthetic");

describe("public-only address admission", () => {
  it.each([
    ["0.1.2.3", 4], ["10.0.0.1", 4], ["100.100.100.100", 4], ["127.0.0.1", 4],
    ["169.254.169.254", 4], ["172.31.0.1", 4], ["192.168.0.1", 4],
    ["192.0.0.1", 4], ["192.0.2.1", 4], ["192.88.99.1", 4],
    ["198.18.0.1", 4], ["198.51.100.1", 4], ["203.0.113.1", 4], ["224.1.2.3", 4],
    ["::ffff:7f00:1", 6], ["0:0:0:0:0:ffff:127.0.0.1", 6], ["fe90::1", 6],
    ["64:ff9b::a00:1", 6], ["2002:7f00:1::", 6], ["2001:db8::1", 6], ["3fff::1", 6],
    ["8.8.8.8", 6], ["not-an-address", 4],
  ])("refuses special or malformed %s", (address, family) => {
    expect(testing.isBlockedAddress(address, family)).toBe(true);
  });
  it("admits normal public IPv4/IPv6", () => {
    expect(testing.isBlockedAddress("8.8.8.8", 4)).toBe(false);
    expect(testing.isBlockedAddress("2606:4700::1111", 6)).toBe(false);
    expect(testing.isBlockedAddress("2001:4860:4860::8888", 6)).toBe(false);
  });
  it("rejects a mixed public/private DNS answer before issuing a request", async () => {
    const fetchImpl = vi.fn();
    await expect(fetchPdfBytes("https://pdf.example/a", { fetchImpl, lookupImpl: async () => [
      { address: "8.8.8.8", family: 4 }, { address: "127.0.0.1", family: 4 },
    ] })).rejects.toMatchObject({ code: "PRIVATE_ADDRESS" });
    expect(fetchImpl).not.toHaveBeenCalled();
  });
  it("refuses credentials on initial URLs and redirects", async () => {
    await expect(fetchPdfBytes("https://user:secret@8.8.8.8/a")).rejects.toMatchObject({ code: "INVALID_URL" });
    await expect(fetchPdfBytes("https://8.8.8.8/a", { fetchImpl: async () => new Response(null, {
      status: 302, headers: { location: "https://user:secret@8.8.8.8/b" },
    }) })).rejects.toMatchObject({ code: "INVALID_URL" });
  });
});

describe("production Node connection pin", () => {
  it("uses the actual HTTP socket lookup for a controlled local fixture without DNS fallback", async () => {
    let observedHost;
    const server = createServer((request, response) => {
      observedHost = request.headers.host;
      response.end("%PDF local transport fixture");
    });
    await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
    const port = server.address().port;
    const budget = createFetchBudget(2000);
    try {
      // Deliberately test the transport below policy. Public fetchPdfBytes
      // refuses this local address; no production admission is bypassed.
      const response = await testing.pinnedResponse(new URL(`http://no-dns-fallback.invalid:${port}/a`), {
        address: "127.0.0.1", family: 4, signal: budget.signal,
      });
      const reader = response.body.getReader();
      const chunks = [];
      for (;;) { const { done, value } = await reader.read(); if (done) break; chunks.push(Buffer.from(value)); }
      expect(Buffer.concat(chunks).toString()).toBe("%PDF local transport fixture");
      expect(observedHost).toBe(`no-dns-fallback.invalid:${port}`);
      reader.releaseLock(); response.dispose();
    } finally {
      budget.close();
      await new Promise(resolve => server.close(resolve));
    }
  });
  it("passes only the admitted DNS address to the actual transport and retains the TLS hostname", async () => {
    let optionsSeen;
    transport.request.mockImplementation((url, options, callback) => {
      expect(url.hostname).toBe("pdf.example");
      optionsSeen = options;
      const request = new EventEmitter();
      request.end = () => {
        const response = new PassThrough();
        response.statusCode = 200; response.rawHeaders = ["Content-Type", "application/pdf"];
        callback(response); response.end("%PDF synthetic");
      };
      return request;
    });
    const lookupImpl = vi.fn(publicLookup);
    expect(Buffer.from(await fetchPdfBytes("https://pdf.example/a", { lookupImpl })).toString()).toBe("%PDF synthetic");
    expect(lookupImpl).toHaveBeenCalledTimes(1);
    expect(optionsSeen).toMatchObject({ agent: false, family: 4, autoSelectFamily: false });
    const single = vi.fn(); optionsSeen.lookup("pdf.example", {}, single);
    expect(single).toHaveBeenCalledWith(null, "8.8.8.8", 4);
    const all = vi.fn(); optionsSeen.lookup("pdf.example", { all: true }, all);
    expect(all).toHaveBeenCalledWith(null, [{ address: "8.8.8.8", family: 4 }]);
    expect(transport.request).toHaveBeenCalledTimes(1);
  });
  it("re-resolves redirects and closes the previous response", async () => {
    const dispose = vi.fn();
    const lookupImpl = vi.fn().mockResolvedValueOnce([{ address: "8.8.8.8", family: 4 }])
      .mockResolvedValueOnce([{ address: "127.0.0.1", family: 4 }]);
    const fetchImpl = vi.fn(async () => ({ status: 302, headers: new Headers({ location: "/b" }), dispose }));
    await expect(fetchPdfBytes("https://pdf.example/a", { lookupImpl, fetchImpl })).rejects.toMatchObject({ code: "PRIVATE_ADDRESS" });
    expect(dispose).toHaveBeenCalledTimes(1);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(fetchImpl.mock.calls[0][1]).toMatchObject({ address: "8.8.8.8", family: 4 });
  });
});

describe("one DNS/header/redirect/body download budget", () => {
  it("times out unresolved DNS and cannot issue a late request", async () => {
    vi.useFakeTimers();
    let resolveLookup;
    const lookupImpl = () => new Promise(resolve => { resolveLookup = resolve; });
    const fetchImpl = vi.fn();
    const outcome = expect(fetchPdfBytes("https://pdf.example/a", { lookupImpl, fetchImpl })).rejects.toMatchObject({ code: "TIMEOUT" });
    await vi.advanceTimersByTimeAsync(15001);
    await outcome;
    resolveLookup(await publicLookup());
    await Promise.resolve();
    expect(fetchImpl).not.toHaveBeenCalled();
  });
  it("does not clear the deadline at headers and cancels a stalled body", async () => {
    vi.useFakeTimers();
    const cancelled = vi.fn();
    const fetchImpl = async () => new Response(new ReadableStream({
      start(controller) { controller.enqueue(new TextEncoder().encode("%PDF")); }, cancel: cancelled,
    }));
    const outcome = expect(fetchPdfBytes("https://8.8.8.8/a", { fetchImpl })).rejects.toMatchObject({ code: "TIMEOUT" });
    await vi.advanceTimersByTimeAsync(15001);
    await outcome;
    expect(cancelled).toHaveBeenCalledTimes(1);
  });
  it("closes a response which arrives after its header timeout", async () => {
    vi.useFakeTimers();
    let respond;
    const cancelled = vi.fn();
    const outcome = expect(fetchPdfBytes("https://8.8.8.8/a", {
      fetchImpl: () => new Promise(resolve => { respond = resolve; }),
    })).rejects.toMatchObject({ code: "TIMEOUT" });
    await vi.advanceTimersByTimeAsync(15001); await outcome;
    respond(new Response(new ReadableStream({ cancel: cancelled })));
    await Promise.resolve();
    expect(cancelled).toHaveBeenCalledTimes(1);
  });
  it("does not renew the time limit after redirect headers", async () => {
    vi.useFakeTimers();
    let calls = 0;
    const fetchImpl = async () => {
      calls++;
      await new Promise(resolve => setTimeout(resolve, 8000));
      return calls === 1 ? new Response(null, { status: 302, headers: { location: "/b" } }) : pdf();
    };
    const outcome = expect(fetchPdfBytes("https://8.8.8.8/a", { fetchImpl })).rejects.toMatchObject({ code: "TIMEOUT" });
    await vi.advanceTimersByTimeAsync(15001); await outcome;
    expect(calls).toBe(2);
    await vi.advanceTimersByTimeAsync(1000);
  });
  it("shares one budget across multiple merge-style input downloads", async () => {
    vi.useFakeTimers();
    const budget = createFetchBudget();
    const fetchImpl = async () => { await new Promise(resolve => setTimeout(resolve, 8000)); return pdf(); };
    try {
      const first = fetchPdfBytes("https://8.8.8.8/a", { fetchImpl, budget });
      await vi.advanceTimersByTimeAsync(8000); await first;
      const second = expect(fetchPdfBytes("https://8.8.8.8/b", { fetchImpl, budget })).rejects.toMatchObject({ code: "TIMEOUT" });
      await vi.advanceTimersByTimeAsync(7001); await second;
      await vi.advanceTimersByTimeAsync(1000);
    } finally { budget.close(); }
  });
  it("cancels oversized declared and actual bodies without trusting length", async () => {
    for (const declared of [String(MAX_PDF_BYTES + 1), "1"]) {
      const cancelled = vi.fn();
      const fetchImpl = async () => new Response(new ReadableStream({
        start(controller) { controller.enqueue(new Uint8Array(MAX_PDF_BYTES + 1)); }, cancel: cancelled,
      }), { headers: { "content-length": declared } });
      await expect(fetchPdfBytes("https://8.8.8.8/a", { fetchImpl })).rejects.toMatchObject({ code: "TOO_LARGE" });
      expect(cancelled).toHaveBeenCalledTimes(1);
    }
  });
});
