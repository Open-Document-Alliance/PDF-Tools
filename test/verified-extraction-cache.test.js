import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { beforeAll, describe, expect, it } from "vitest";
import { extractPdfLayoutForMarkdown } from "../server/layout-extraction.js";
import { createVerifiedExtractionLayoutCache } from "../server/verified-extraction-tools.js";

const sourcePath = fileURLToPath(new URL("./fixtures/eval/extraction/synthetic/born-digital-flat.pdf", import.meta.url));
let sourceBytes;
let layouts;
let input;
beforeAll(async () => {
  sourceBytes = await fs.readFile(sourcePath);
  const pdfjsLib = await import("pdfjs-dist/legacy/build/pdf.mjs");
  layouts = [await extractPdfLayoutForMarkdown({ pdfjsLib, pdfBytes: sourceBytes,
    sourcePath, sourceFileName: path.basename(sourcePath),
    sourceSha256: createHash("sha256").update(sourceBytes).digest("hex"),
    requestedStartPage: 1, requestedEndPage: 1, maxItems: 5000,
    maxCharacters: 100000, maxOutputCharacters: 200000, deadlineMs: 20000 })];
  input = { resolvedPath: sourcePath, sourceBytes, password: null, maxPages: 200 };
}, 60_000);

describe("source-bound layout cache", () => {
  it("reuses exact context and returns independent defensive copies", async () => {
    const cache = createVerifiedExtractionLayoutCache({ extractLayouts: async () => layouts });
    const first = await cache.extract(input);
    first[0].page_range.total_pages = 999;
    const second = await cache.extract(input);
    expect(second).toEqual(layouts);
    expect(second).not.toBe(layouts);
    expect(second[0]).not.toBe(layouts[0]);
    expect(cache.stats()).toMatchObject({ loads: 1, hits: 1, entries: 1, inflight: 0 });
    await expect(cache.extract({ ...input, unknown_parser_option: true })).rejects.toThrow(/unknown argument/);
  });

  it("separates passwords, paths, page limits, and fresh source bytes", async () => {
    const cache = createVerifiedExtractionLayoutCache({ extractLayouts: async () => layouts });
    await cache.extract(input);
    await cache.extract({ ...input, password: "secret" });
    await cache.extract({ ...input, resolvedPath: `${sourcePath}.alias` });
    await cache.extract({ ...input, maxPages: 100 });
    // An old layout cannot satisfy a changed byte identity, even for the same path.
    await expect(cache.extract({ ...input, sourceBytes: Buffer.concat([sourceBytes, Buffer.from([0])]) }))
      .rejects.toThrow(/source|hash|byte/iu);
    expect(cache.stats()).toMatchObject({ loads: 5, hits: 0, entries: 4, failures: 1 });
  });

  it("never satisfies a wrong-password request using an unlocked cached layout", async () => {
    const cache = createVerifiedExtractionLayoutCache({ extractLayouts: async ({ password }) => {
      if (password !== "correct") throw new Error("incorrect password");
      return layouts;
    } });
    await cache.extract({ ...input, password: "correct" });
    await expect(cache.extract({ ...input, password: "wrong" })).rejects.toThrow("incorrect password");
    expect(cache.stats()).toMatchObject({ entries: 1, loads: 2, hits: 0, inflight: 0 });
  });

  it("coalesces identical work, bounds distinct in-flight work, and clears failures", async () => {
    let release;
    let fail = true;
    const cache = createVerifiedExtractionLayoutCache({ maxInflight: 1, extractLayouts: async () => {
      await new Promise(resolve => { release = resolve; });
      if (fail) throw new Error("parse failed");
      return layouts;
    } });
    const first = cache.extract(input);
    const shared = cache.extract(input);
    const rejection = Promise.allSettled([first, shared]);
    await expect(cache.extract({ ...input, password: "other" })).rejects.toThrow(/Concurrent/);
    release();
    expect((await rejection).map(result => result.status)).toEqual(["rejected", "rejected"]);
    expect(cache.stats()).toMatchObject({ loads: 1, shared_inflight: 1, inflight: 0, entries: 0 });
    fail = false;
    const retried = cache.extract(input);
    await Promise.resolve();
    release();
    expect(await retried).toEqual(layouts);
    expect(cache.stats()).toMatchObject({ loads: 2, entries: 1, inflight: 0 });
  });

  it("evicts by entry and serialized-byte budgets and skips oversized entries", async () => {
    const bytes = Buffer.byteLength(JSON.stringify(layouts), "utf8");
    const cache = createVerifiedExtractionLayoutCache({ maxEntries: 2, maxRetainedBytes: bytes * 2,
      extractLayouts: async () => layouts });
    await cache.extract(input);
    await cache.extract({ ...input, password: "a" });
    await cache.extract(input); // Make the no-password entry the most recently used.
    await cache.extract({ ...input, password: "b" });
    await cache.extract({ ...input, password: "a" });
    expect(cache.stats()).toMatchObject({ loads: 4, hits: 1, entries: 2, evictions: 2,
      retained_bytes: bytes * 2 });
    const bounded = createVerifiedExtractionLayoutCache({ maxRetainedBytes: bytes,
      extractLayouts: async () => layouts });
    await bounded.extract(input);
    await bounded.extract({ ...input, password: "a" });
    expect(bounded.stats()).toMatchObject({ entries: 1, evictions: 1, retained_bytes: bytes });
    const oversized = createVerifiedExtractionLayoutCache({ maxRetainedBytes: bytes - 1,
      extractLayouts: async () => layouts });
    await oversized.extract(input);
    await oversized.extract(input);
    expect(oversized.stats()).toMatchObject({ entries: 0, loads: 2, retained_bytes: 0 });
  });

  it("rejects a parser that mutates the isolated source snapshot", async () => {
    const cache = createVerifiedExtractionLayoutCache({ extractLayouts: async ({ sourceBytes: bytes }) => {
      bytes[0] ^= 1;
      return layouts;
    } });
    await expect(cache.extract(input)).rejects.toThrow(/mutated/);
    expect(sourceBytes[0]).toBe(37);
    expect(cache.stats()).toMatchObject({ entries: 0, inflight: 0, failures: 1 });
  });
});
