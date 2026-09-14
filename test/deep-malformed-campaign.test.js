/**
 * Resource-isolated deep malformed PDF campaign (bead pdf-toolkit-mcp-33l).
 *
 * The fast matrix in fuzz-malformed-pdfs.test.js proves structural containment
 * with cheap inputs. This campaign covers the expensive classes it omits, where
 * a small file provokes disproportionate work: deep nesting, sparse object
 * spaces, decompression bombs, and extreme declared geometry.
 *
 * The property under test is not "the tool rejects these". A tool is free to
 * succeed. The property is that the server stays bounded and honest:
 *
 *   1. it survives, and remains responsive to a following control call;
 *   2. it never leaves a partial or corrupt output artifact behind;
 *   3. it answers within a wall-clock bound rather than hanging;
 *   4. its peak resident memory stays bounded even when a fixture asks for a
 *      512 MiB inflate from 522 KiB of input.
 *
 * Point 4 is measured, not assumed. On Linux /proc/<pid>/status VmHWM reports
 * the true high-water mark of the child, so the assertion is against observed
 * peak RSS rather than a proxy. Where that file is unavailable the memory
 * assertion is skipped explicitly instead of silently passing.
 *
 * Cost control: the default run uses the quick corpus against the mutating
 * tools most likely to allocate. Set DEEP_FUZZ=1 for the full-scale corpus,
 * which includes the 512 MiB inflate and the 50,000-deep nesting fixtures.
 */

import fs from "node:fs/promises";
import fsSync from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import zlib from "node:zlib";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { PDFDocument } from "pdf-lib";
import {
  createTestTempDirectory,
  removeTestTempDirectory,
} from "./helpers/temp-directory.js";
import {
  DEEP_FIXTURE_CLASSES,
  DEEP_FIXTURE_NAMES,
  makeDeepMalformedFixture,
  makeDeepMalformedFixtures,
} from "./helpers/deep-malformed-fixtures.js";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const FULL_SCALE = process.env.DEEP_FUZZ === "1";
const SCALE = FULL_SCALE ? "full" : "quick";

// These are harness observation ceilings, not product latency guarantees.
// read_pdf_content can run two independent 30s PDF.js stages; the other
// PDF.js reads use one. Each stage has a 1s termination grace. Keep the
// observer outside those existing bounds so it sees typed resource rejection.
const CONTROL_TIMEOUT_MS = 35_000;
const CASE_CLEANUP_MARGIN_MS = 10_000;
const TOOL_CALL_TIMEOUT_MS = Object.freeze({
  read_pdf_content: 65_000,
  get_pdf_info: 35_000,
  get_page_analysis: 35_000,
  // PDF-lib's 30s worker deadline excludes parent validation and commit.
  // 45s is a whole-call harness hang ceiling, not a mutation runtime SLA.
  read_pdf_fields: 45_000,
  rotate_pdf_pages: 45_000,
  split_pdf: 45_000,
});
// The largest fixture asks for a 512 MiB inflate. A server that honors it
// naively lands well above this; one that bounds decoding stays far below.
const PEAK_RSS_LIMIT_BYTES = 1_536 * 1024 * 1024;

/** Tools that read an arbitrary input path and are most likely to allocate. */
const PROBE_TOOLS = [
  { name: "get_pdf_info", args: p => ({ pdf_path: p }) },
  { name: "read_pdf_fields", args: p => ({ pdf_path: p }) },
  { name: "read_pdf_content", args: p => ({ pdf_path: p }) },
  { name: "get_page_analysis", args: p => ({ pdf_path: p }) },
  { name: "rotate_pdf_pages", args: (p, out) => ({ input_path: p, output_path: out, degrees: 90 }) },
  {
    name: "split_pdf",
    args: (p, out) => ({ input_path: p, page_ranges: "1", output_directory: path.dirname(out) }),
    // split writes its own filenames into the directory, so there is no single
    // predictable output path to inspect.
    producesNamedOutput: false,
  },
];

function readPeakRssBytes(pid) {
  try {
    const status = fsSync.readFileSync(`/proc/${pid}/status`, "utf8");
    const match = status.match(/^VmHWM:\s+(\d+)\s+kB$/m);
    return match ? Number(match[1]) * 1024 : null;
  } catch {
    return null;
  }
}

// A client timeout does not guarantee cancellation of server-side work. The
// observer must let the bounded parser stages settle before probing liveness;
// these tests make no claim that cancellation prevents mutations or writes.
describe(`deep malformed campaign (${SCALE} scale)`, () => {
  let stateRoot;
  let client;
  let transport;
  let serverPid;
  let serverClosedUnexpectedly = false;
  let closingTransport = false;
  let controlPdfPath;
  const fixtures = makeDeepMalformedFixtures({ scale: SCALE });

  beforeAll(async () => {
    stateRoot = await createTestTempDirectory(REPO_ROOT, "deep-malformed");
    const profilesDirectory = path.join(stateRoot, "profiles");
    await fs.mkdir(profilesDirectory, { recursive: true });

    // A known-good document, used to prove the server is still healthy after
    // each adversary rather than merely still running.
    controlPdfPath = path.join(stateRoot, "control.pdf");
    const control = await PDFDocument.create();
    control.addPage([200, 200]);
    await fs.writeFile(controlPdfPath, await control.save(), { mode: 0o600 });

    for (const fixture of fixtures) {
      await fs.writeFile(path.join(stateRoot, `${fixture.name}.pdf`), fixture.bytes, { mode: 0o600 });
    }

    transport = new StdioClientTransport({
      command: process.execPath,
      args: [path.join(REPO_ROOT, "server", "index.js")],
      cwd: REPO_ROOT,
      env: {
        ALLOWED_DIRECTORIES: stateRoot,
        DEFAULT_PDF_DIR: stateRoot,
        DEFAULT_DOWNLOAD_DIR: stateRoot,
        DEFAULT_PROFILES_DIR: profilesDirectory,
      },
      stderr: "pipe",
    });
    transport.onclose = () => {
      if (!closingTransport) serverClosedUnexpectedly = true;
    };
    client = new Client({ name: "pdf-tools-deep-malformed", version: "1.0.0" });
    await client.connect(transport);
    serverPid = transport.pid;
    expect(serverPid).toEqual(expect.any(Number));
  }, 180_000);

  afterAll(async () => {
    closingTransport = true;
    await client?.close().catch(() => {});
    await transport?.close().catch(() => {});
    await removeTestTempDirectory(stateRoot);
  });

  it("covers every declared adversary class", () => {
    const classes = new Set(fixtures.map(f => f.klass));
    for (const klass of DEEP_FIXTURE_CLASSES) expect(classes).toContain(klass);
    // Distinct bytes, so no fixture is silently duplicated.
    expect(new Set(fixtures.map(f => f.bytes.toString("latin1"))).size).toBe(fixtures.length);
  });

  // This is an identity proof, not a latency assertion. Rebuilding every
  // compressed fixture can exceed Vitest's generic 5-second timeout when the
  // ordinary project is exercising several process-heavy files in parallel.
  it("keeps targeted supervised-row generation identical to the campaign corpus", () => {
    expect(fixtures.map(fixture => fixture.name)).toEqual(DEEP_FIXTURE_NAMES);
    for (const fixture of fixtures) {
      const targeted = makeDeepMalformedFixture({
        scale: SCALE,
        name: fixture.name,
      });
      expect(targeted.name).toBe(fixture.name);
      expect(targeted.klass).toBe(fixture.klass);
      expect(targeted.note).toBe(fixture.note);
      expect(targeted.bytes).toEqual(fixture.bytes);
    }
  }, 30_000);

  it("keeps every deep fixture small enough to pass the input size limits", () => {
    // The whole premise: these are cheap to accept and expensive to honor, so
    // input-size limits alone cannot defend against them.
    for (const fixture of fixtures) {
      expect(fixture.bytes.length).toBeLessThan(250 * 1024 * 1024);
    }
  });

  it("isolates single-filter declaration form as a causal attribution pair", () => {
    const pair = fixtures
      .filter(fixture => fixture.attributionPair === "single-filter-declaration-form")
      .sort((left, right) => left.filterForm.localeCompare(right.filterForm));
    expect(pair.map(fixture => fixture.filterForm)).toEqual(["array", "name"]);
    expect(new Set(pair.map(fixture => fixture.compressedLength)).size).toBe(1);
    expect(new Set(pair.map(fixture => fixture.expandedLength)).size).toBe(1);

    const beforeXref = fixture => fixture.bytes
      .toString("latin1")
      .split("\nxref\n", 1)[0]
      .replace("/Filter [/FlateDecode]", "/Filter /FlateDecode");
    expect(beforeXref(pair[0])).toBe(beforeXref(pair[1]));
  });

  it("isolates expanded operator semantics from Flate decoder depth", () => {
    const invalid = fixtures.find(fixture => fixture.name === "compressed-inflate-bomb");
    const valid = fixtures.find(fixture => fixture.name === "compressed-valid-operator-bomb");
    const delimited = fixtures.find(fixture => fixture.name === "compressed-delimited-paint-operators");
    const discarded = fixtures.find(
      fixture => fixture.name === "compressed-discarded-compatibility-operators",
    );
    expect(invalid).toBeTruthy();
    expect(valid).toBeTruthy();
    expect(delimited).toBeTruthy();
    expect(discarded).toBeTruthy();
    expect(invalid.compressedLength).toBe(valid.compressedLength);
    expect(invalid.expandedLength).toBe(valid.expandedLength);
    expect([invalid.expandedFillByte, valid.expandedFillByte]).toEqual([0x41, 0x42]);
    expect([valid.operatorPattern, delimited.operatorPattern, discarded.operatorPattern])
      .toEqual(["B", "B\\n", "BX\\n"]);

    const parts = fixture => {
      const startMarker = Buffer.from("stream\n", "latin1");
      const endMarker = Buffer.from("\nendstream", "latin1");
      const start = fixture.bytes.indexOf(startMarker) + startMarker.length;
      const end = fixture.bytes.indexOf(endMarker, start);
      expect(start).toBeGreaterThan(startMarker.length - 1);
      expect(end).toBeGreaterThan(start);
      return {
        prefix: fixture.bytes.subarray(0, start),
        payload: fixture.bytes.subarray(start, end),
        suffix: fixture.bytes.subarray(end),
      };
    };
    const invalidParts = parts(invalid);
    const validParts = parts(valid);
    expect(invalidParts.prefix).toEqual(validParts.prefix);
    expect(invalidParts.suffix).toEqual(validParts.suffix);

    const invalidExpanded = zlib.inflateSync(invalidParts.payload);
    const validExpanded = zlib.inflateSync(validParts.payload);
    expect(new Set(invalidExpanded)).toEqual(new Set([0x41]));
    expect(new Set(validExpanded)).toEqual(new Set([0x42]));
    expect(invalidExpanded.length).toBe(validExpanded.length);

    for (const fixture of [delimited, discarded]) {
      const expanded = zlib.inflateSync(parts(fixture).payload);
      const pattern = Buffer.from(fixture.operatorPattern.replace("\\n", "\n"), "latin1");
      expect(expanded.length).toBe(fixture.expandedLength);
      expect(expanded.length % pattern.length).toBe(0);
      const expected = Buffer.allocUnsafe(expanded.length);
      for (let offset = 0; offset < expected.length; offset += pattern.length) {
        pattern.copy(expected, offset);
      }
      expect(expanded.equals(expected)).toBe(true);
      expect(fixture.operatorCount).toBe(expanded.length / pattern.length);
    }
  });

  for (const fixture of makeDeepMalformedFixtures({ scale: SCALE })) {
    for (const tool of PROBE_TOOLS) {
      const callTimeoutMs = TOOL_CALL_TIMEOUT_MS[tool.name];
      it(`${tool.name} stays bounded on ${fixture.name}`, async () => {
        const inputPath = path.join(stateRoot, `${fixture.name}.pdf`);
        const outputPath = path.join(stateRoot, `out-${tool.name}-${fixture.name}.pdf`);
        const before = Date.now();

        let threw = null;
        try {
          await client.callTool(
            { name: tool.name, arguments: tool.args(inputPath, outputPath) },
            undefined,
            { timeout: callTimeoutMs, maxTotalTimeout: callTimeoutMs },
          );
        } catch (error) {
          // A transport-level rejection is an acceptable fail-closed outcome.
          // A timeout is not: that means the call never bounded itself.
          threw = error;
        }
        const elapsed = Date.now() - before;

        // Collect control, source and output evidence even when the primary
        // observation exceeded its bound. A healthy control cannot erase that
        // primary failure, and its own full allowance fits the outer timeout.
        let control;
        let controlError = null;
        try {
          control = await client.callTool(
            { name: "get_pdf_info", arguments: { pdf_path: controlPdfPath } },
            undefined,
            { timeout: CONTROL_TIMEOUT_MS, maxTotalTimeout: CONTROL_TIMEOUT_MS },
          );
        } catch (error) {
          controlError = error;
        }
        let sourceBytes = null;
        let outputError = null;
        try {
          sourceBytes = await fs.readFile(inputPath);
          const written = tool.producesNamedOutput === false
            ? null
            : await fs.readFile(outputPath).catch(error => {
              if (error.code === "ENOENT") return null;
              throw error;
            });
          if (written !== null) {
            await PDFDocument.load(written, { ignoreEncryption: true });
          }
        } catch (error) {
          outputError = error;
        }

        expect.soft(serverClosedUnexpectedly, "server process died").toBe(false);
        expect.soft(controlError, "post-adversary control failed").toBeNull();
        expect.soft(control, "post-adversary control is absent").toBeDefined();
        expect.soft(control?.isError, "post-adversary control rejected").not.toBe(true);
        expect.soft(sourceBytes?.equals(fixture.bytes), "source bytes changed").toBe(true);
        expect.soft(outputError, "source or output integrity failed").toBeNull();
        expect.soft(elapsed, "call exceeded its harness observation ceiling")
          .toBeLessThan(callTimeoutMs);
        if (threw) {
          expect.soft(String(threw.message ?? threw)).not.toMatch(/timed out|timeout/i);
        }
      }, callTimeoutMs + CONTROL_TIMEOUT_MS + CASE_CLEANUP_MARGIN_MS);
    }
  }

  it("holds peak resident memory within bounds across the whole campaign", () => {
    const peak = readPeakRssBytes(serverPid);
    if (peak === null) {
      // Explicit rather than a silent pass on platforms without /proc.
      expect(process.platform).not.toBe("linux");
      return;
    }
    expect(
      peak,
      `peak RSS ${(peak / 1024 / 1024).toFixed(0)} MiB exceeded the bound; ` +
        "a fixture's declared expansion was likely honored unbounded",
    ).toBeLessThan(PEAK_RSS_LIMIT_BYTES);
  });
});
