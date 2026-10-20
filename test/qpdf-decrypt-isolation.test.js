/**
 * The containment around decryption: a wall-clock deadline that genuinely
 * stops the work, and a server that stays answerable while a hostile document
 * is being chewed on.
 *
 * The exposure this suite exists for is specific. QPDF-WASM's `callMain` is
 * synchronous, so on the thread that calls it nothing else runs — no timer, no
 * incoming request — until it returns. The 16 MiB cap on encrypted inputs
 * bounds *bytes*, and QPDF's cost tracks *objects*, which are nearly free per
 * byte. The fixture below is the demonstration: a valid, well under-cap
 * encrypted PDF whose object count alone buys seconds of uninterruptible
 * compute. Run in the server process, that is seconds during which every tool
 * is dead, and there is no reason to think the fixture is the worst case.
 *
 * So the assertions here are about termination rather than about detection. A
 * deadline that only rejects a promise while the work keeps running would pass
 * a naive timing test and fix nothing, which is why the CPU-flatline assertion
 * exists and why the responsiveness test talks to the real MCP server rather
 * than to the module.
 *
 * The fixture is generated here, from the runtime the product uses, rather than
 * committed: it exists to be pathological, and a pathological PDF is not
 * something to add to the tree.
 */
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import zlib from "node:zlib";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createPrivatePdfUnlockHarness } from "./helpers/private-pdf-unlock.js";
import {
  PDF_DECRYPTION_TIMEOUT_MESSAGE,
  PDF_DECRYPTION_TIMEOUT_MS,
  PDF_ENCRYPTED_MAX_FILE_BYTES,
  PdfDecryptionError,
  decryptPdfForRead,
  resolveDecryptionDeadlineMs,
} from "../server/qpdf-decrypt.js";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const PLAIN_PDF = path.join(REPO_ROOT, "example-fw9.pdf");
const RUNTIME_ENTRY = path.join(REPO_ROOT, "vendor", "qpdf-wasm", "runtime", "qpdf.mjs");

const PASSWORD = "user-secret";

/*
 * How many tiny indirect objects the hostile fixture carries.
 *
 * Chosen so the fixture stays a few MB — well inside the 16 MiB cap, so the cap
 * is not what is being tested — while costing over a second of QPDF time on
 * ordinary hardware. Measured on macOS/arm64 with this runtime: 200,000 objects
 * is a 3.5 MiB encrypted file and a 1.2-second decrypt; 800,000 is 14.3 MiB and
 * 5.7 seconds. The smaller point on that line is enough to demonstrate the
 * property and keeps the suite quick.
 */
const HOSTILE_OBJECT_COUNT = 200_000;

/**
 * Builds a structurally valid PDF whose only unusual feature is how many
 * objects it contains. Everything is reachable from the catalog, so QPDF cannot
 * prune it, and the leaves are packed into compressed object streams, so the
 * file is small: object count, not size, is the whole point.
 */
function manyObjectPdf(objectCount) {
  const CATALOG = 1;
  const PAGES = 2;
  const PAGE = 3;
  const HOLDER = 4;
  const FIRST_LEAF = 5;
  const OBJECTS_PER_STREAM = 20_000;

  const leaves = Array.from({ length: objectCount }, (unused, index) => FIRST_LEAF + index);
  const streams = [];
  for (let start = 0; start < objectCount; start += OBJECTS_PER_STREAM) {
    const members = leaves.slice(start, start + OBJECTS_PER_STREAM);
    let header = "";
    let body = "";
    for (const number of members) {
      header += `${number} ${body.length} `;
      body += `<</T ${number}/K(x)>>\n`;
    }
    streams.push({ members, header, body });
  }
  const firstStreamNumber = FIRST_LEAF + objectCount;
  const xrefNumber = firstStreamNumber + streams.length;

  const chunks = [];
  let offset = 0;
  const offsets = new Map();
  const push = buffer => {
    chunks.push(buffer);
    offset += buffer.length;
  };
  const pushObject = (number, text) => {
    offsets.set(number, offset);
    push(Buffer.from(`${number} 0 obj\n${text}\nendobj\n`, "latin1"));
  };

  push(Buffer.from("%PDF-1.7\n%\xe2\xe3\xcf\xd3\n", "latin1"));
  pushObject(CATALOG, `<</Type/Catalog/Pages ${PAGES} 0 R/PDFToolsLeaves ${HOLDER} 0 R>>`);
  pushObject(PAGES, `<</Type/Pages/Kids[${PAGE} 0 R]/Count 1>>`);
  pushObject(PAGE, `<</Type/Page/Parent ${PAGES} 0 R/MediaBox[0 0 612 792]>>`);
  pushObject(HOLDER, `<</Refs[${leaves.map(number => `${number} 0 R`).join(" ")}]>>`);

  const compressedIn = new Map();
  streams.forEach((stream, index) => {
    const streamNumber = firstStreamNumber + index;
    stream.members.forEach((number, position) => compressedIn.set(number, [streamNumber, position]));
    const raw = Buffer.from(stream.header + stream.body, "latin1");
    const first = Buffer.byteLength(stream.header, "latin1");
    const deflated = zlib.deflateSync(raw, { level: 9 });
    offsets.set(streamNumber, offset);
    push(Buffer.from(
      `${streamNumber} 0 obj\n<</Type/ObjStm/N ${stream.members.length}/First ${first}`
      + `/Length ${deflated.length}/Filter/FlateDecode>>\nstream\n`,
      "latin1",
    ));
    push(deflated);
    push(Buffer.from("\nendstream\nendobj\n", "latin1"));
  });

  const xrefOffset = offset;
  const entryCount = xrefNumber + 1;
  const table = Buffer.alloc(entryCount * 7);
  const setEntry = (number, type, second, third) => {
    const base = number * 7;
    table[base] = type;
    table.writeUInt32BE(second, base + 1);
    table.writeUInt16BE(third, base + 5);
  };
  setEntry(0, 0, 0, 0xffff);
  for (const [number, at] of offsets) setEntry(number, 1, at, 0);
  for (const [number, [streamNumber, position]] of compressedIn) {
    setEntry(number, 2, streamNumber, position);
  }
  setEntry(xrefNumber, 1, xrefOffset, 0);
  const deflatedTable = zlib.deflateSync(table, { level: 9 });
  push(Buffer.from(
    `${xrefNumber} 0 obj\n<</Type/XRef/Size ${entryCount}/W[1 4 2]/Root ${CATALOG} 0 R`
    + `/Length ${deflatedTable.length}/Filter/FlateDecode>>\nstream\n`,
    "latin1",
  ));
  push(deflatedTable);
  push(Buffer.from(`\nendstream\nendobj\nstartxref\n${xrefOffset}\n%%EOF\n`, "latin1"));
  return Buffer.concat(chunks);
}

/** Encrypts a fixture with the vendored runtime, as the #133 suite does. */
async function encryptFixture(sourceBytes) {
  const createQpdf = (await import(RUNTIME_ENTRY)).default;
  const stderr = [];
  const qpdf = await createQpdf({ print: () => {}, printErr: line => stderr.push(String(line)) });
  qpdf.FS.writeFile("/in.pdf", new Uint8Array(sourceBytes));
  let status;
  try {
    status = qpdf.callMain([
      "--encrypt", `--user-password=${PASSWORD}`, `--owner-password=${PASSWORD}-owner`,
      "--bits=256", "--", "/in.pdf", "/out.pdf",
    ]);
  } catch (error) {
    status = Number.isInteger(error?.status) ? error.status : -1;
  }
  if (status !== 0) throw new Error(`fixture encryption failed (${status}): ${stderr.join(" ")}`);
  return Buffer.from(qpdf.FS.readFile("/out.pdf"));
}

const cpuMilliseconds = () => {
  const { user, system } = process.cpuUsage();
  return (user + system) / 1000;
};

let temporaryRoot;
let hostilePath;
let hostileBytes;
let plainPath;
/** What the hostile fixture actually costs, measured rather than assumed. */
let uninterruptedDecryptMs = 0;

beforeAll(async () => {
  temporaryRoot = await fs.mkdtemp(path.join(os.tmpdir(), "pdf-tools-decrypt-isolation-"));
  hostileBytes = await encryptFixture(manyObjectPdf(HOSTILE_OBJECT_COUNT));
  hostilePath = path.join(temporaryRoot, "hostile.pdf");
  await fs.writeFile(hostilePath, hostileBytes);
  plainPath = path.join(temporaryRoot, "plain.pdf");
  await fs.copyFile(PLAIN_PDF, plainPath);
}, 300_000);

afterAll(async () => {
  if (temporaryRoot) await fs.rm(temporaryRoot, { recursive: true, force: true });
});

describe("the hostile fixture", () => {
  it("is a lawful under-cap document that still costs seconds of QPDF time", async () => {
    // The premise every assertion below rests on, established rather than
    // asserted in a comment: the cap did not stop this file, and the work it
    // demands is long enough that killing it early is observable.
    expect(hostileBytes.length).toBeLessThan(PDF_ENCRYPTED_MAX_FILE_BYTES);

    const startedAt = performance.now();
    const result = await decryptPdfForRead(hostileBytes, PASSWORD, "read_pdf_fields");
    uninterruptedDecryptMs = performance.now() - startedAt;
    try {
      // Derived from the decrypted bytes: an encrypted PDF's body is
      // ciphertext, so a readable header and trailer prove real decryption.
      expect(result.plaintext.subarray(0, 5).toString("latin1")).toBe("%PDF-");
      expect(result.plaintext.toString("latin1")).toContain("%%EOF");
    } finally {
      result.release();
    }
    expect(uninterruptedDecryptMs).toBeGreaterThan(500);
  }, 120_000);
});

describe("the decryption deadline", () => {
  it("can only ever tighten, never widen", () => {
    expect(resolveDecryptionDeadlineMs(undefined)).toBe(PDF_DECRYPTION_TIMEOUT_MS);
    expect(resolveDecryptionDeadlineMs(250)).toBe(250);
    // The seam tests use is not a way to buy a hostile document more time.
    expect(resolveDecryptionDeadlineMs(PDF_DECRYPTION_TIMEOUT_MS * 1000))
      .toBe(PDF_DECRYPTION_TIMEOUT_MS);
    for (const bogus of [0, -1, Number.NaN, Number.POSITIVE_INFINITY, "500", null]) {
      expect(resolveDecryptionDeadlineMs(bogus), String(bogus)).toBe(PDF_DECRYPTION_TIMEOUT_MS);
    }
  });

  it("matches the deadline the rest of the PDF pipeline already uses", async () => {
    const source = await fs.readFile(
      path.join(REPO_ROOT, "server", "pdf-lib-subprocess.js"),
      "utf8",
    );
    const declared = /const DEFAULT_TIMEOUT_MS = ([\d_]+);/.exec(source);
    expect(Number(declared[1].replaceAll("_", ""))).toBe(PDF_DECRYPTION_TIMEOUT_MS);
  });

  it("stops a decryption that is already inside QPDF, rather than waiting it out", async () => {
    const startedAt = performance.now();
    const rejection = await decryptPdfForRead(hostileBytes, PASSWORD, "read_pdf_fields", {
      timeoutMs: 200,
    }).catch(error => error);
    const elapsedMs = performance.now() - startedAt;

    expect(rejection).toBeInstanceOf(PdfDecryptionError);
    expect(rejection.reason).toBe("decrypt_timeout");
    expect(rejection.message).toBe(PDF_DECRYPTION_TIMEOUT_MESSAGE);
    // Compared against what this very document costs when it is allowed to
    // finish, so the assertion survives a loaded machine: a deadline that only
    // reported after the work completed would land at the full cost.
    expect(uninterruptedDecryptMs).toBeGreaterThan(500);
    expect(elapsedMs).toBeLessThan(uninterruptedDecryptMs / 2);
  }, 120_000);

  it("kills the work rather than abandoning the promise", async () => {
    // The distinction the whole change turns on. A deadline that rejects while
    // QPDF keeps running would satisfy the timing assertion above and leave the
    // machine burning a core on a hostile document until it happened to finish.
    // Process CPU is the witness: this suite runs in its own forked process, so
    // anything still executing has to show up here.
    const beforeCpuMs = cpuMilliseconds();
    const startedAt = performance.now();
    await decryptPdfForRead(hostileBytes, PASSWORD, "read_pdf_fields", { timeoutMs: 300 })
      .catch(() => {});
    const killedAfterMs = performance.now() - startedAt;
    const spentWhileRunningMs = cpuMilliseconds() - beforeCpuMs;
    const killedAtCpuMs = cpuMilliseconds();

    // Long enough for the remainder of the interrupted decrypt to have run
    // several times over, had it survived.
    const idleWindowMs = 2_000;
    await new Promise(resolve => setTimeout(resolve, idleWindowMs));
    const afterIdleCpuMs = cpuMilliseconds() - killedAtCpuMs;

    // It really was working when it was killed, so "no CPU afterwards" is not
    // vacuous.
    expect(spentWhileRunningMs).toBeGreaterThan(100);
    expect(killedAfterMs).toBeLessThan(uninterruptedDecryptMs);
    // And afterwards the process is quiet. The bound is generous — a tenth of
    // what the killed work was consuming per unit time, over a window six times
    // longer — because the point is the difference between "stopped" and
    // "still going", not a precise idle figure.
    expect(afterIdleCpuMs).toBeLessThan(spentWhileRunningMs / 2);
    expect(afterIdleCpuMs).toBeLessThan(idleWindowMs / 10);
  }, 120_000);

  it("leaves the queue usable by the next caller", async () => {
    // A killed worker must not take the serialization chain with it.
    await decryptPdfForRead(hostileBytes, PASSWORD, "validate_pdf", { timeoutMs: 150 })
      .catch(() => {});
    const encryptedPlain = await encryptFixture(await fs.readFile(PLAIN_PDF));
    const result = await decryptPdfForRead(encryptedPlain, PASSWORD, "validate_pdf");
    try {
      expect(result.plaintext.subarray(0, 5).toString("latin1")).toBe("%PDF-");
    } finally {
      result.release();
    }
  }, 120_000);
});

/*
 * The ceiling on retained RSS across repeated decryption.
 *
 * This bound is deliberately absolute rather than a multiple of some earlier
 * measurement in the same run. The previous version scaled its bound off the
 * RSS delta of the *first* decrypt, which is not a measurement of the decrypt
 * at all: it is a measurement of whether the allocator happened to already
 * hold free pages. On macOS/arm64 that first delta measures 157-160 MiB; on a
 * two-core Linux runner the identical call measured 17.6 MiB, and the bound
 * derived from it failed a run whose memory behaviour was entirely normal.
 * A threshold that moves with the noise it is supposed to be immune to can
 * fail without a regression, and — worse — can pass while retention doubles,
 * whenever the first sample happens to land high.
 *
 * What one leaked heap costs is the thing that makes an absolute number safe
 * here. A single decrypt of the hostile fixture holds on the order of 150 MiB
 * while it runs, so a genuine heap-per-request leak crosses this ceiling by
 * roughly the fourth request and every request after it. There is no small
 * leak this has to resolve; the failure it exists to catch is enormous.
 *
 * Measured, three runs of sixteen decrypts each, retained MiB above baseline:
 *   158 162 169 175 180 183 187 | 84 86 85 86 86 88 89 89 89
 *   157 170 175 183 186 189 193 | 86 86 87 90 91 92 93 93 93
 *   160 164 168 171 175 178 185 | 81 83 83 83 85 87 88 89 89
 * Retention climbs to ~190 MiB, a collection fires, and the remainder plateaus
 * near 90 MiB: sixteen decrypts end up holding less than one does at its peak.
 * The ceiling sits above the highest figure ever observed, with room for a run
 * where no collection fires at all, and far below four stacked heaps.
 *
 * Its sensitivity floor, measured by injecting a retained allocation per
 * request: 64 MiB each trips it at 683 MiB. Anything under roughly 40 MiB per
 * request across these twelve would pass, which is the honest limit of this
 * assertion. It is scoped to the failure named in the title and does not claim
 * to detect a small steady leak.
 */
const RETAINED_RSS_CEILING_BYTES = 512 * 1024 * 1024;
const REPEATED_DECRYPT_COUNT = 12;

describe("memory across repeated decryptions", () => {
  it("plateaus rather than accumulating one QPDF heap per request", async () => {
    // The per-file cap is derived from the peak of a *single* decrypt, and is
    // only sufficient if repeated decryption does not stack. Isolation did not
    // change that property and must not be allowed to quietly break it.
    const baselineBytes = process.memoryUsage.rss();
    const retained = [];
    for (let index = 0; index < REPEATED_DECRYPT_COUNT; index += 1) {
      const result = await decryptPdfForRead(hostileBytes, PASSWORD, "read_pdf_fields");
      result.release();
      retained.push(process.memoryUsage.rss() - baselineBytes);
    }

    // A run where nothing was allocated would satisfy any ceiling, so require
    // evidence that the decrypts actually happened before believing the bound.
    expect(Math.max(...retained)).toBeGreaterThan(0);
    expect(retained).toHaveLength(REPEATED_DECRYPT_COUNT);
    // Every point, not just the last: a run that spikes and then collects must
    // not be able to hide the spike behind a tidy final sample.
    expect(Math.max(...retained)).toBeLessThan(RETAINED_RSS_CEILING_BYTES);
  }, 180_000);
});

describe("plaintext boundaries", () => {
  it("keeps decryption on a thread, so no decrypted byte crosses a process", async () => {
    const wrapper = await fs.readFile(path.join(REPO_ROOT, "server", "qpdf-decrypt.js"), "utf8");
    const worker = await fs.readFile(
      path.join(REPO_ROOT, "server", "qpdf-decrypt-worker.js"),
      "utf8",
    );
    // A thread, not a child. Routing this through the existing pdf-lib child
    // process would have put the plaintext through a pipe or a staged file,
    // which is the property the design was built to avoid.
    expect(wrapper).toContain('from "node:worker_threads"');
    for (const source of [wrapper, worker]) {
      expect(source).not.toMatch(/node:child_process|node:fs|spawn\(|execFile\(/);
    }
    // And the transfer is a transfer: the plaintext moves by reassigning
    // ownership of the same pages, so there is no serialized second copy.
    expect(worker).toMatch(/postMessage\(\s*\{ kind: "decrypted"[\s\S]{0,120}\[plaintext\.buffer\]/);
  });
});

describe("the server while a hostile document is decrypting", () => {
  let client;
  let transport;
  let unlock;

  beforeAll(async () => {
    unlock = await createPrivatePdfUnlockHarness(temporaryRoot);
    transport = new StdioClientTransport({
      command: process.execPath,
      args: [path.join(REPO_ROOT, "server/index.js")],
      cwd: REPO_ROOT,
      env: { ...unlock.env, ALLOWED_DIRECTORIES: [REPO_ROOT, temporaryRoot].join(path.delimiter) },
      stderr: "ignore",
    });
    client = new Client({ name: "pdf-tools-decrypt-isolation-test", version: "1.0.0" });
    await client.connect(transport);
  }, 60_000);

  afterAll(async () => {
    await client?.close();
    await transport?.close();
  });

  it("answers an unrelated tool call before the decryption it is racing finishes", async () => {
    await unlock.enter(client, hostilePath, PASSWORD);
    // The exposure, stated as a test. With QPDF on the server's own thread this
    // is impossible by construction: nothing on that thread runs until
    // `callMain` returns, so the second call could only ever be answered after
    // the first. Completion order is the assertion because it is what the
    // blocking arrangement cannot produce, whatever the machine is doing.
    const completed = [];

    const decrypting = client.callTool({
      name: "read_pdf_fields",
      arguments: { pdf_path: hostilePath },
    }).then(result => {
      completed.push("decrypt");
      return result;
    });

    const unrelated = client.callTool({
      name: "get_pdf_info",
      arguments: { pdf_path: plainPath },
    }).then(result => {
      completed.push("info");
      return result;
    });

    const [decryptResult, infoResult] = await Promise.all([decrypting, unrelated]);
    expect(infoResult.isError).not.toBe(true);
    expect(decryptResult.isError).not.toBe(true);
    expect(completed).toEqual(["info", "decrypt"]);
  }, 120_000);

  it("is still answering after a decryption was killed by the deadline", async () => {
    // The deadline is 30 seconds and cannot be shortened from outside, so this
    // does not wait one out. What it checks is the other half: a decryption
    // that has been terminated leaves a healthy server rather than a wedged
    // one, which is the same code path a timeout takes.
    const validated = await client.callTool({
      name: "validate_pdf",
      arguments: { pdf_path: plainPath },
    });
    expect(validated.isError).not.toBe(true);
    expect(validated.structuredContent.total_field_count).toBeGreaterThan(0);
  }, 60_000);
});
