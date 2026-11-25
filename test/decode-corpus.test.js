// The shared decode corpus, run against the local server. The corpus is kept
// outside the repository; set PDF_TOOLS_DECODE_CORPUS to its manifest to run
// it. Without it these tests are skipped.

import { execFileSync } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { runDecodeCorpus } from "./helpers/decode-corpus.js";
import { createTestTempDirectory, removeTestTempDirectory } from "./helpers/temp-directory.js";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const OBSERVE = path.join(REPO_ROOT, "test/helpers/observe-document-in-process.mjs");
const OPERATE = path.join(REPO_ROOT, "test/helpers/run-pdfjs-operation-in-process.mjs");
// The PDF.js operation behind each text tool, with the options the tool uses.
const OPERATIONS = {
  read_pdf_pages: ["read_pages", { start_page: 1, end_page: 1, max_chars_per_page: 4000 }],
  convert_pdf_to_markdown: ["extract_layout_for_markdown", {
    source_path: "$SOURCE_PATH",
    source_file_name: "$SOURCE_NAME",
    start_page: 1,
    end_page: 1,
    max_items: 5000,
    max_characters: 100_000,
    max_output_characters: 200_000,
  }],
};

function runInChild(args) {
  const stdout = execFileSync(process.execPath, args, {
    cwd: REPO_ROOT,
    encoding: "utf8",
    maxBuffer: 16 * 1024 * 1024,
    stdio: ["ignore", "pipe", "ignore"],
    timeout: 240_000,
  });
  return JSON.parse(stdout.slice(stdout.indexOf("{")));
}
const MANIFEST = process.env.PDF_TOOLS_DECODE_CORPUS ?? null;

describe.skipIf(!MANIFEST)("shared decode corpus (local)", () => {
  let directory;

  beforeAll(async () => {
    directory = await createTestTempDirectory(REPO_ROOT, "decode-corpus");
  });

  afterAll(async () => {
    await removeTestTempDirectory(directory);
  });

  it("meets every local expectation", async () => {
    const results = await runDecodeCorpus({
      manifestPath: MANIFEST,
      runtime: "local",
      run: async (bytes, caseDef) => {
        const file = path.join(directory, `${caseDef.id}.pdf`);
        await fs.writeFile(file, bytes);
        try {
          if (caseDef.entry === "get_pdf_info") {
            const observed = runInChild([OBSERVE, file]);
            const gap = observed.reason_codes.includes("METADATA_STREAM_UNBOUNDED");
            return {
              outcome: gap ? "gap" : "ok",
              code: gap ? "METADATA_STREAM_UNBOUNDED" : null,
              peakRssBytes: observed.max_rss_bytes,
            };
          }
          const [operation, options] = OPERATIONS[caseDef.entry];
          const outcome = runInChild([OPERATE, operation, JSON.stringify(options), file]);
          return {
            outcome: outcome.status === "ok" ? "ok" : "refused",
            code: outcome.code,
            peakRssBytes: outcome.max_rss_bytes,
          };
        } finally {
          await fs.rm(file, { force: true });
        }
      },
    });
    expect(results.length).toBeGreaterThan(0);
    expect(results.filter(result => result.mismatches.length > 0)
      .map(result => `${result.id}: ${result.mismatches.join("; ")}`)).toEqual([]);
  }, 1_800_000);
});
