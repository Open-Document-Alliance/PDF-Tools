import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { EventEmitter } from "node:events";
import { Readable } from "node:stream";
import { gzipSync } from "node:zlib";
import { downloadPdfFromUrl } from "../server/helpers.js";
import {
  fetchPdfDownloadResponse,
  isBlockedDownloadAddress,
  resolvePdfDownloadAddress,
} from "../server/download-transport.js";

// All transports and resolvers in this file are synthetic. No socket is opened.
const PDF_BYTES = Buffer.from("%PDF-1.7\nsynthetic transport fixture\n");
const pdfResponse = () => new Response(PDF_BYTES, {
  headers: { "content-type": "application/pdf" },
});
const redirectResponse = location => new Response(null, {
  status: 302,
  headers: { location },
});
let directory;
beforeEach(async () => { directory = await fs.mkdtemp(path.join(os.tmpdir(), "pdf-download-test-")); });
afterEach(async () => {
  vi.useRealTimers();
  await fs.rm(directory, { recursive: true, force: true });
});

describe("local download transport policy", () => {
  it("classifies ordinary public and special-use addresses without resolving them", () => {
    for (const address of ["8.8.8.8", "2606:4700:4700::1111"]) {
      expect(isBlockedDownloadAddress(address)).toBe(false);
    }
    for (const address of ["127.0.0.1", "192.168.1.1", "100.64.0.1", "::1", "::ffff:7f00:1", "fe80::1", "2001:db8::1"]) {
      expect(isBlockedDownloadAddress(address)).toBe(true);
    }
  });

  it("validates every synthetic DNS answer before selecting one", async () => {
    const lookupFn = vi.fn(async () => [
      { address: "8.8.8.8", family: 4 },
      { address: "192.168.1.1", family: 4 },
    ]);
    await expect(resolvePdfDownloadAddress("document.example", { lookupFn }))
      .rejects.toThrow(/private\/loopback or reserved/);
    await expect(resolvePdfDownloadAddress("document.example", { lookupFn, allowPrivateHosts: true }))
      .resolves.toEqual({ address: "8.8.8.8", family: 4 });
    expect(lookupFn).toHaveBeenCalledWith("document.example", { all: true });
  });

  it("passes one approved address to both supported lookup callback forms", async () => {
    let options;
    let target;
    const lookupFn = vi.fn(async () => [{ address: "8.8.8.8", family: 4 }]);
    const requestFn = vi.fn((url, requestOptions, callback) => {
      target = url;
      options = requestOptions;
      const request = new EventEmitter();
      request.end = () => {
        const incoming = Readable.from([PDF_BYTES]);
        Object.assign(incoming, { statusCode: 200, statusMessage: "OK", rawHeaders: ["Content-Type", "application/pdf"] });
        callback(incoming);
      };
      return request;
    });
    const response = await fetchPdfDownloadResponse("https://document.example/a.pdf", {
      lookupFn, requestFn, headers: { "x-request-label": "document-review" },
    });
    expect(target.hostname).toBe("document.example");
    expect(options).toMatchObject({ agent: false, family: 4, autoSelectFamily: false });
    expect(options.headers).toMatchObject({ host: "document.example", "accept-encoding": "identity" });
    const single = vi.fn();
    const all = vi.fn();
    options.lookup("document.example", {}, single);
    options.lookup("document.example", { all: true }, all);
    expect(single).toHaveBeenCalledWith(null, "8.8.8.8", 4);
    expect(all).toHaveBeenCalledWith(null, [{ address: "8.8.8.8", family: 4 }]);
    expect(lookupFn).toHaveBeenCalledTimes(1);
    expect(Buffer.from(await new Response(response.body).arrayBuffer())).toEqual(PDF_BYTES);
    response.dispose();
  });

  it("does not create a request when cancellation occurs during synthetic resolution", async () => {
    const controller = new AbortController();
    const requestFn = vi.fn();
    const operation = fetchPdfDownloadResponse("https://document.example/a.pdf", {
      signal: controller.signal,
      lookupFn: async () => {
        controller.abort(new Error("cancelled"));
        return [{ address: "8.8.8.8", family: 4 }];
      },
      requestFn,
    });
    await expect(operation).rejects.toThrow("cancelled");
    expect(requestFn).not.toHaveBeenCalled();
  });

  it("decodes a small compressed synthetic response before the caller counts bytes", async () => {
    const response = await fetchPdfDownloadResponse("https://document.example/a.pdf", {
      lookupFn: async () => [{ address: "8.8.8.8", family: 4 }],
      requestFn: (_url, _options, callback) => {
        const request = new EventEmitter();
        request.end = () => {
          const incoming = Readable.from([gzipSync(PDF_BYTES)]);
          Object.assign(incoming, { statusCode: 200, statusMessage: "OK", rawHeaders: ["Content-Encoding", "gzip"] });
          callback(incoming);
        };
        return request;
      },
    });
    expect(Buffer.from(await new Response(response.body).arrayBuffer())).toEqual(PDF_BYTES);
    response.dispose();
  });
});

describe("bounded download lifecycle", () => {
  it("retains benign request labels on same-origin redirects and drops them on origin changes", async () => {
    const fetchFn = vi.fn()
      .mockResolvedValueOnce(redirectResponse("/second.pdf"))
      .mockResolvedValueOnce(redirectResponse("https://cdn.example/document.pdf"))
      .mockResolvedValueOnce(pdfResponse());
    const result = await downloadPdfFromUrl("https://document.example/first.pdf", {
      headers: { "x-request-label": "document-review" },
      destinationDir: directory,
      fetchFn,
    });
    expect(fetchFn.mock.calls[0][1].headers).toEqual({ "x-request-label": "document-review" });
    expect(fetchFn.mock.calls[1][1].headers).toEqual({ "x-request-label": "document-review" });
    expect(fetchFn.mock.calls[2][1].headers).toEqual({});
    expect(result.redirectHops).toBe(2);
    expect(await fs.readFile(result.path)).toEqual(PDF_BYTES);
  });

  it("refuses a transport downgrade without making the next request", async () => {
    const fetchFn = vi.fn().mockResolvedValue(redirectResponse("http://document.example/document.pdf"));
    await expect(downloadPdfFromUrl("https://document.example/first.pdf", {
      destinationDir: directory, fetchFn,
    })).rejects.toThrow(/HTTPS-to-HTTP/);
    expect(fetchFn).toHaveBeenCalledTimes(1);
    expect(await fs.readdir(directory)).toEqual([]);
  });

  it("stops reading and cancels as soon as decoded bytes exceed the limit", async () => {
    const cancel = vi.fn();
    const chunks = [Buffer.from("%PDF-"), Buffer.from("1234"), Buffer.from("unread")];
    let reads = 0;
    const body = new ReadableStream({
      pull(controller) { controller.enqueue(chunks[reads++]); },
      cancel,
    }, { highWaterMark: 0 });
    await expect(downloadPdfFromUrl("https://document.example/bounded.pdf", {
      maxSizeMb: 8 / (1024 * 1024),
      destinationDir: directory,
      fetchFn: async () => ({ ok: true, status: 200, headers: new Headers(), body }),
    })).rejects.toThrow(/exceeds/);
    expect(reads).toBe(2);
    expect(cancel).toHaveBeenCalled();
    expect(await fs.readdir(directory)).toEqual([]);
  });

  it("accepts a chunked document exactly at the limit with no declared length", async () => {
    const result = await downloadPdfFromUrl("https://document.example/exact.pdf", {
      maxSizeMb: PDF_BYTES.length / (1024 * 1024),
      destinationDir: directory,
      fetchFn: async () => pdfResponse(),
    });
    expect(await fs.readFile(result.path)).toEqual(PDF_BYTES);
  });

  it("requires streaming instead of falling back to an unbounded whole-body read", async () => {
    const arrayBuffer = vi.fn();
    await expect(downloadPdfFromUrl("https://document.example/a.pdf", {
      destinationDir: directory,
      fetchFn: async () => ({ ok: true, status: 200, headers: new Headers(), arrayBuffer }),
    })).rejects.toThrow(/readable response stream/);
    expect(arrayBuffer).not.toHaveBeenCalled();
  });

  it("cancels a stalled response body when its shared deadline expires", async () => {
    vi.useFakeTimers();
    const cancel = vi.fn();
    let receivedSignal;
    const operation = downloadPdfFromUrl("https://document.example/a.pdf", {
      destinationDir: directory, timeoutMs: 10,
      fetchFn: async (_url, { signal }) => {
        receivedSignal = signal;
        return { ok: true, status: 200, headers: new Headers(), body: new ReadableStream({ cancel }) };
      },
    });
    const result = expect(operation).rejects.toMatchObject({ code: "PDF_DOWNLOAD_TIMEOUT" });
    await vi.advanceTimersByTimeAsync(10);
    await result;
    expect(receivedSignal.aborted).toBe(true);
    expect(cancel).toHaveBeenCalled();
  });

  it("uses one deadline across redirects and closes a late transport response", async () => {
    vi.useFakeTimers();
    const cancel = vi.fn();
    let resolveLate;
    const fetchFn = vi.fn()
      .mockImplementationOnce(() => new Promise(resolve => setTimeout(() => resolve(redirectResponse("/next.pdf")), 8)))
      .mockImplementationOnce(() => new Promise(resolve => { resolveLate = resolve; }));
    const operation = downloadPdfFromUrl("https://document.example/a.pdf", {
      destinationDir: directory, timeoutMs: 10, fetchFn,
    });
    const result = expect(operation).rejects.toMatchObject({ code: "PDF_DOWNLOAD_TIMEOUT" });
    await vi.advanceTimersByTimeAsync(10);
    await result;
    expect(fetchFn).toHaveBeenCalledTimes(2);
    resolveLate({ body: new ReadableStream({ cancel }) });
    await Promise.resolve();
    expect(cancel).toHaveBeenCalled();
  });

  it("honors caller cancellation before starting a transport", async () => {
    const controller = new AbortController();
    controller.abort();
    const fetchFn = vi.fn();
    await expect(downloadPdfFromUrl("https://document.example/a.pdf", {
      destinationDir: directory, signal: controller.signal, fetchFn,
    })).rejects.toMatchObject({ code: "PDF_DOWNLOAD_CANCELLED" });
    expect(fetchFn).not.toHaveBeenCalled();
  });
});
