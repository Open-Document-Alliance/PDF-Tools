import { describe, it, expect, beforeAll, afterAll } from "vitest";
import fs from "fs/promises";
import path from "path";
import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import { fileURLToPath } from "url";
import {
  downloadPdfFromUrl,
  sanitizePdfFilename,
  findUniquePath,
  isPrivateHost,
  writePdfDownloadAtomic,
} from "../server/helpers.js";
import { PDFDocument } from "pdf-lib";
import { createTestTempDirectory, removeTestTempDirectory } from "./helpers/temp-directory.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.join(__dirname, "..");
const EXAMPLE_PDF = path.join(REPO_ROOT, "example-fw9.pdf");
const DOWNLOAD_WRITE_CHILD = path.join(
  REPO_ROOT,
  "test",
  "helpers",
  "pdf-download-write-child.mjs",
);
const OUTPUT_LOCK_HOLDER = path.join(
  REPO_ROOT,
  "test",
  "helpers",
  "atomic-output-lock-holder.mjs",
);
let TMP_DIR;

async function expectedOutputIdentity(targetPath) {
  const [canonicalPath, bytes, stat] = await Promise.all([
    fs.realpath(targetPath),
    fs.readFile(targetPath),
    fs.stat(targetPath),
  ]);
  return {
    canonicalPath,
    sizeBytes: stat.size,
    sha256: createHash("sha256").update(bytes).digest("hex"),
  };
}

beforeAll(async () => {
  TMP_DIR = await createTestTempDirectory(REPO_ROOT, "fetch");
});

afterAll(async () => {
  await removeTestTempDirectory(TMP_DIR);
});

// Build a fake fetch that returns a given body + headers + status.
function makeFakeFetch({ body, contentType = "application/pdf", status = 200, statusText = "OK" }) {
  return async () => ({
    ok: status >= 200 && status < 300,
    status,
    statusText,
    headers: {
      get(name) {
        const n = name.toLowerCase();
        if (n === "content-type") return contentType;
        if (n === "content-length") return body ? String(body.length) : null;
        return null;
      },
    },
    body: new ReadableStream({
      start(controller) {
        if (body?.length) controller.enqueue(new Uint8Array(body));
        controller.close();
      },
    }),
  });
}

async function startDownloadWriteChild(targetPath, sourcePath, barrierPath) {
  const child = spawn(
    process.execPath,
    [DOWNLOAD_WRITE_CHILD, targetPath, sourcePath, barrierPath],
    {
      cwd: REPO_ROOT,
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  let stdout = "";
  let stderr = "";
  let spawnError = null;
  let readyResolve;
  let readyReject;
  const ready = new Promise((resolve, reject) => {
    readyResolve = resolve;
    readyReject = reject;
  });
  child.stdout.on("data", chunk => {
    stdout += chunk.toString("utf8");
    if (stdout.includes("READY\n")) readyResolve();
  });
  child.stderr.on("data", chunk => {
    stderr += chunk.toString("utf8");
  });
  child.once("error", error => {
    spawnError = error;
    readyReject(error);
  });
  const closed = new Promise(resolve => {
    child.once("close", (code, signal) => resolve({ code, signal }));
  });
  let timeoutId;
  const timeout = new Promise((_, reject) => {
    timeoutId = setTimeout(
      () => reject(new Error(`Timed out waiting for download child. stderr: ${stderr}`)),
      10_000,
    );
  });
  try {
    await Promise.race([
      ready,
      closed.then(({ code, signal }) => {
        throw new Error(
          `Download child exited before ready (${code ?? signal}). stderr: ${stderr}`,
        );
      }),
      timeout,
    ]);
  } catch (error) {
    if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
    await closed;
    throw spawnError ?? error;
  } finally {
    clearTimeout(timeoutId);
  }
  const result = closed.then(({ code, signal }) => {
    if (spawnError) throw spawnError;
    if (code !== 0) {
      throw new Error(`Download child exited ${code ?? signal}. stderr: ${stderr}`);
    }
    const resultLine = stdout.trim().split("\n").find(line => line.startsWith("{"));
    if (!resultLine) {
      throw new Error(`Download child returned no result. stdout: ${stdout}`);
    }
    return JSON.parse(resultLine);
  });
  return { child, closed, result };
}

async function startOutputLockHolder(directoryPath) {
  const child = spawn(process.execPath, [OUTPUT_LOCK_HOLDER, directoryPath], {
    cwd: REPO_ROOT,
    stdio: ["pipe", "pipe", "pipe"],
  });
  let stdout = "";
  let stderr = "";
  let readyResolve;
  let readyReject;
  const ready = new Promise((resolve, reject) => {
    readyResolve = resolve;
    readyReject = reject;
  });
  child.stdout.on("data", chunk => {
    stdout += chunk.toString("utf8");
    if (stdout.includes("READY\n")) readyResolve();
  });
  child.stderr.on("data", chunk => {
    stderr += chunk.toString("utf8");
  });
  child.once("error", readyReject);
  const closed = new Promise(resolve => {
    child.once("close", (code, signal) => resolve({ code, signal }));
  });
  let timeoutId;
  try {
    await Promise.race([
      ready,
      closed.then(({ code, signal }) => {
        throw new Error(
          `Output lock holder exited before ready (${code ?? signal}). stderr: ${stderr}`,
        );
      }),
      new Promise((_, reject) => {
        timeoutId = setTimeout(
          () => reject(new Error(`Timed out waiting for output lock holder. stderr: ${stderr}`)),
          10_000,
        );
      }),
    ]);
  } catch (error) {
    if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
    await closed;
    throw error;
  } finally {
    clearTimeout(timeoutId);
  }
  return { child, closed };
}

async function killAndReapChild(state) {
  if (!state) return;
  if (state.child.exitCode === null && state.child.signalCode === null) {
    state.child.kill("SIGKILL");
  }
  await state.closed;
}

describe("sanitizePdfFilename", () => {
  it("appends .pdf if missing", () => {
    expect(sanitizePdfFilename("report")).toBe("report.pdf");
  });
  it("keeps existing .pdf", () => {
    expect(sanitizePdfFilename("report.pdf")).toBe("report.pdf");
  });
  it("strips path components", () => {
    expect(sanitizePdfFilename("../../etc/passwd")).toBe("passwd.pdf");
  });
  it("replaces illegal chars", () => {
    expect(sanitizePdfFilename("a<b>c:d|e.pdf")).toBe("a_b_c_d_e.pdf");
  });
  it("handles empty input", () => {
    expect(sanitizePdfFilename("")).toBe("download.pdf");
    expect(sanitizePdfFilename(null)).toBe("download.pdf");
  });
  it("strips leading dots", () => {
    expect(sanitizePdfFilename("...hidden.pdf")).toBe("hidden.pdf");
  });
});

describe("isPrivateHost", () => {
  it("flags loopback", () => {
    expect(isPrivateHost("localhost")).toBe(true);
    expect(isPrivateHost("127.0.0.1")).toBe(true);
    expect(isPrivateHost("127.10.20.30")).toBe(true);
    expect(isPrivateHost("::1")).toBe(true);
  });
  it("flags RFC1918 ranges", () => {
    expect(isPrivateHost("10.0.0.1")).toBe(true);
    expect(isPrivateHost("192.168.1.1")).toBe(true);
    expect(isPrivateHost("172.16.0.1")).toBe(true);
    expect(isPrivateHost("172.31.255.255")).toBe(true);
  });
  it("flags AWS metadata link-local", () => {
    expect(isPrivateHost("169.254.169.254")).toBe(true);
  });
  it("does NOT flag 172.15 or 172.32 (outside RFC1918)", () => {
    expect(isPrivateHost("172.15.0.1")).toBe(false);
    expect(isPrivateHost("172.32.0.1")).toBe(false);
  });
  it("does NOT flag public addresses", () => {
    expect(isPrivateHost("up.sandyspringsga.gov")).toBe(false);
    expect(isPrivateHost("8.8.8.8")).toBe(false);
    expect(isPrivateHost("example.com")).toBe(false);
  });
  it("flags .local and .localhost suffixes", () => {
    expect(isPrivateHost("printer.local")).toBe(true);
    expect(isPrivateHost("web.localhost")).toBe(true);
  });
});

describe("findUniquePath", () => {
  it("returns target unchanged when file doesn't exist", async () => {
    const target = path.join(TMP_DIR, "brand-new.pdf");
    expect(await findUniquePath(target)).toBe(target);
  });
  it("appends (2) when file exists", async () => {
    const target = path.join(TMP_DIR, "exists.pdf");
    await fs.writeFile(target, "x");
    const unique = await findUniquePath(target);
    expect(unique).toBe(path.join(TMP_DIR, "exists (2).pdf"));
  });
  it("appends (3) when (2) also exists", async () => {
    const target = path.join(TMP_DIR, "twice.pdf");
    await fs.writeFile(target, "x");
    await fs.writeFile(path.join(TMP_DIR, "twice (2).pdf"), "x");
    const unique = await findUniquePath(target);
    expect(unique).toBe(path.join(TMP_DIR, "twice (3).pdf"));
  });
});

describe("writePdfDownloadAtomic", () => {
  it("retries only the exact locked target-exists classification", async () => {
    const policy = async () => {};
    const conflict = Object.assign(new Error("different conflict"), {
      code: "ATOMIC_OUTPUT_CONFLICT",
    });
    let selections = 0;
    let writes = 0;

    await expect(
      writePdfDownloadAtomic(path.join(TMP_DIR, "classified.pdf"), Buffer.from("%PDF-1.7"), {
        assertPathAllowed: policy,
        findUniquePathFn: async target => {
          selections++;
          return target;
        },
        writePdfOutputAtomicFn: async (target, bytes, options) => {
          writes++;
          expect(target).toBe(path.join(TMP_DIR, "classified.pdf"));
          expect(bytes.equals(Buffer.from("%PDF-1.7"))).toBe(true);
          expect(options).toEqual({
            assertPathAllowed: policy,
            overwrite: false,
          });
          throw conflict;
        },
      }),
    ).rejects.toBe(conflict);
    expect(selections).toBe(1);
    expect(writes).toBe(1);
  });

  it("waits on exact lock transients without consuming the filename-collision budget", async () => {
    const policy = async () => {};
    const candidates = [];
    let writes = 0;
    let now = 1_000;
    const sleeps = [];
    const outcomes = [
      "ATOMIC_OUTPUT_CONCURRENT",
      "ATOMIC_OUTPUT_LOCK_FAILED",
      "ATOMIC_OUTPUT_TARGET_EXISTS",
      "success",
    ];

    const result = await writePdfDownloadAtomic(
      path.join(TMP_DIR, "contention.pdf"),
      Buffer.from("%PDF-1.7"),
      {
        assertPathAllowed: policy,
        maxFilenameCollisions: 2,
        contentionTimeoutMs: 100,
        nowFn: () => now,
        sleepFn: async delayMs => {
          sleeps.push(delayMs);
          now += delayMs;
        },
        findUniquePathFn: async target => {
          const candidate = `${target}.${candidates.length + 1}`;
          candidates.push(candidate);
          return candidate;
        },
        writePdfOutputAtomicFn: async (target, bytes, options) => {
          expect(bytes.equals(Buffer.from("%PDF-1.7"))).toBe(true);
          expect(options).toEqual({
            assertPathAllowed: policy,
            overwrite: false,
          });
          const outcome = outcomes[writes++];
          if (outcome === "success") {
            return { targetPath: path.join(TMP_DIR, "canonical-contention.pdf") };
          }
          throw Object.assign(new Error(outcome), { code: outcome });
        },
      },
    );

    expect(result).toEqual({
      targetPath: path.join(TMP_DIR, "canonical-contention.pdf"),
    });
    expect(candidates).toHaveLength(4);
    expect(writes).toBe(4);
    expect(sleeps).toEqual([5, 10]);
  });

  it("stops after the filename namespace's bounded locked target collisions", async () => {
    const exhaustionDir = path.join(TMP_DIR, "collision-exhaustion");
    await fs.mkdir(exhaustionDir);
    const targetPath = path.join(exhaustionDir, "bounded.pdf");
    let selections = 0;

    await expect(
      writePdfDownloadAtomic(targetPath, Buffer.from("%PDF-1.7"), {
        maxFilenameCollisions: 1,
        findUniquePathFn: async target => {
          selections++;
          await fs.writeFile(target, "competing writer");
          return target;
        },
      }),
    ).rejects.toMatchObject({
      code: "PDF_DOWNLOAD_UNIQUE_PATH_RETRY_EXHAUSTED",
      cause: { code: "ATOMIC_OUTPUT_TARGET_EXISTS" },
    });
    expect(selections).toBe(1);
    await expect(fs.readFile(targetPath, "utf8")).resolves.toBe("competing writer");
    expect(
      (await fs.readdir(exhaustionDir)).filter(name => name.startsWith(".pdf-tools-")),
    ).toEqual([]);
  });

  it("bounds lock contention by elapsed time without busy-looping", async () => {
    let now = 0;
    const sleeps = [];
    let writes = 0;

    await expect(
      writePdfDownloadAtomic(path.join(TMP_DIR, "contention-timeout.pdf"), Buffer.from("%PDF-1.7"), {
        contentionTimeoutMs: 12,
        nowFn: () => now,
        sleepFn: async delayMs => {
          sleeps.push(delayMs);
          now += delayMs;
        },
        writePdfOutputAtomicFn: async () => {
          writes++;
          throw Object.assign(new Error("live owner"), {
            code: "ATOMIC_OUTPUT_CONCURRENT",
          });
        },
      }),
    ).rejects.toMatchObject({
      code: "PDF_DOWNLOAD_OUTPUT_CONTENTION_TIMEOUT",
      cause: { code: "ATOMIC_OUTPUT_CONCURRENT" },
    });
    expect(writes).toBe(3);
    expect(sleeps).toEqual([5, 7]);
  });

  it.each([
    "EEXIST",
    "ATOMIC_OUTPUT_CONFLICT",
    "ATOMIC_OUTPUT_ARTIFACT_COLLISION",
    "ATOMIC_OUTPUT_LOCK_INVALID",
    "ATOMIC_OUTPUT_LOCK_CHANGED",
    "ATOMIC_OUTPUT_LOCK_CLEANUP_FAILED",
    "ATOMIC_OUTPUT_COMMITTED_CLEANUP_FAILED",
    "PDF_RECOVERY_DIRECTORY_CHANGED",
    "PATH_POLICY_DENIED",
  ])("does not retry non-transient error %s", async code => {
    let selections = 0;
    let writes = 0;
    const failure = Object.assign(new Error(code), { code });
    await expect(
      writePdfDownloadAtomic(path.join(TMP_DIR, `${code}.pdf`), Buffer.from("%PDF-1.7"), {
        findUniquePathFn: async target => {
          selections++;
          return target;
        },
        writePdfOutputAtomicFn: async () => {
          writes++;
          throw failure;
        },
      }),
    ).rejects.toBe(failure);
    expect(selections).toBe(1);
    expect(writes).toBe(1);
  });

  it("keeps overwrite mode single-shot even under lock contention", async () => {
    let selections = 0;
    let writes = 0;
    const failure = Object.assign(new Error("live owner"), {
      code: "ATOMIC_OUTPUT_CONCURRENT",
    });
    await expect(
      writePdfDownloadAtomic(path.join(TMP_DIR, "overwrite-contention.pdf"), Buffer.from("%PDF-1.7"), {
        overwrite: true,
        expectedExistingIdentity: {
          canonicalPath: path.join(TMP_DIR, "overwrite-contention.pdf"),
          sizeBytes: 1,
          sha256: "0".repeat(64),
        },
        findUniquePathFn: async target => {
          selections++;
          return target;
        },
        writePdfOutputAtomicFn: async () => {
          writes++;
          throw failure;
        },
      }),
    ).rejects.toBe(failure);
    expect(selections).toBe(0);
    expect(writes).toBe(1);
  });

  it("rejects invalid retry bounds before selecting a path", async () => {
    let selected = false;
    await expect(
      writePdfDownloadAtomic(path.join(TMP_DIR, "invalid-bound.pdf"), Buffer.from("%PDF-1.7"), {
        maxFilenameCollisions: 0,
        findUniquePathFn: async target => {
          selected = true;
          return target;
        },
      }),
    ).rejects.toThrow(/maxFilenameCollisions/);
    await expect(
      writePdfDownloadAtomic(path.join(TMP_DIR, "invalid-timeout.pdf"), Buffer.from("%PDF-1.7"), {
        contentionTimeoutMs: -1,
      }),
    ).rejects.toThrow(/contentionTimeoutMs/);
    await expect(
      writePdfDownloadAtomic(path.join(TMP_DIR, "oversized-bound.pdf"), Buffer.from("%PDF-1.7"), {
        maxFilenameCollisions: 1_000,
      }),
    ).rejects.toThrow(/1 to 999/);
    expect(selected).toBe(false);
  });
});

describe("downloadPdfFromUrl", () => {
  let examplePdfBuffer;

  beforeAll(async () => {
    examplePdfBuffer = await fs.readFile(EXAMPLE_PDF);
  });

  it("downloads a valid PDF and returns metadata", async () => {
    const result = await downloadPdfFromUrl("https://example.com/fw9.pdf", {
      destinationDir: TMP_DIR,
      filename: "happy-path.pdf",
      fetchFn: makeFakeFetch({ body: examplePdfBuffer }),
    });
    expect(result.path).toBe(path.join(TMP_DIR, "happy-path.pdf"));
    expect(result.bytes).toBe(examplePdfBuffer.length);
    expect(result.contentType).toBe("application/pdf");
    expect(result.sourceUrl).toBe("https://example.com/fw9.pdf");

    const saved = await fs.readFile(result.path);
    expect(saved.subarray(0, 5).toString("ascii")).toBe("%PDF-");
  });

  it("derives filename from URL when not provided", async () => {
    const result = await downloadPdfFromUrl("https://example.com/path/to/Business%20License.pdf", {
      destinationDir: TMP_DIR,
      fetchFn: makeFakeFetch({ body: examplePdfBuffer }),
    });
    expect(path.basename(result.path)).toBe("Business License.pdf");
  });

  it("appends (2) when file exists and overwrite=false", async () => {
    const first = await downloadPdfFromUrl("https://example.com/dup.pdf", {
      destinationDir: TMP_DIR,
      fetchFn: makeFakeFetch({ body: examplePdfBuffer }),
    });
    const second = await downloadPdfFromUrl("https://example.com/dup.pdf", {
      destinationDir: TMP_DIR,
      fetchFn: makeFakeFetch({ body: examplePdfBuffer }),
    });
    expect(first.path).not.toBe(second.path);
    expect(second.path).toMatch(/dup \(2\)\.pdf$/);
  });

  it("commits ten concurrent same-name downloads to distinct readable PDFs", async () => {
    const destinationDir = path.join(TMP_DIR, "concurrent");
    await fs.mkdir(destinationDir);
    const distinctBodies = [];
    for (let index = 0; index < 10; index++) {
      const document = await PDFDocument.load(examplePdfBuffer);
      document.setSubject(`concurrent-download-${index}`);
      distinctBodies.push(Buffer.from(await document.save()));
    }
    let fetchCalls = 0;

    const results = await Promise.all(
      distinctBodies.map(body => downloadPdfFromUrl(
        "https://example.com/concurrent.pdf",
        {
          destinationDir,
          fetchFn: async (...args) => {
            fetchCalls++;
            return makeFakeFetch({ body })(...args);
          },
        },
      )),
    );

    const expectedNames = new Set([
      "concurrent.pdf",
      ...Array.from({ length: 9 }, (_, index) => `concurrent (${index + 2}).pdf`),
    ]);
    const resultNames = results.map(result => path.basename(result.path));
    expect(fetchCalls).toBe(10);
    expect(new Set(resultNames)).toEqual(expectedNames);
    expect(new Set(results.map(result => result.path)).size).toBe(10);

    for (let index = 0; index < results.length; index++) {
      const result = results[index];
      const saved = await fs.readFile(result.path);
      expect(saved.equals(distinctBodies[index])).toBe(true);
      const parsed = await PDFDocument.load(saved);
      expect(parsed.getPageCount()).toBeGreaterThan(0);
    }

    const directoryEntries = await fs.readdir(destinationDir);
    expect(new Set(directoryEntries)).toEqual(expectedNames);
  }, 30_000);

  it("keeps concurrent different basenames unsuffixed", async () => {
    const destinationDir = path.join(TMP_DIR, "different-basenames");
    await fs.mkdir(destinationDir);
    const fetchFn = makeFakeFetch({ body: examplePdfBuffer });
    const [alpha, beta] = await Promise.all([
      downloadPdfFromUrl("https://example.com/alpha.pdf", { destinationDir, fetchFn }),
      downloadPdfFromUrl("https://example.com/beta.pdf", { destinationDir, fetchFn }),
    ]);
    expect(path.basename(alpha.path)).toBe("alpha.pdf");
    expect(path.basename(beta.path)).toBe("beta.pdf");
    expect(new Set(await fs.readdir(destinationDir))).toEqual(
      new Set(["alpha.pdf", "beta.pdf"]),
    );
  });

  it.runIf(process.platform !== "win32")(
    "returns the canonical committed path through a destination alias",
    async () => {
      const realDirectory = path.join(TMP_DIR, "canonical-real");
      const aliasDirectory = path.join(TMP_DIR, "canonical-alias");
      await fs.mkdir(realDirectory);
      await fs.symlink(realDirectory, aliasDirectory);
      const policyCalls = [];
      const result = await downloadPdfFromUrl("https://example.com/canonical.pdf", {
        destinationDir: aliasDirectory,
        fetchFn: makeFakeFetch({ body: examplePdfBuffer }),
        assertPathAllowed: async candidate => {
          policyCalls.push(candidate);
        },
      });
      expect(result.path).toBe(path.join(await fs.realpath(realDirectory), "canonical.pdf"));
      expect(policyCalls.length).toBeGreaterThan(0);
      await expect(fs.readFile(result.path)).resolves.toEqual(examplePdfBuffer);
    },
  );

  it.runIf(process.platform !== "win32")(
    "waits for a child-owned directory lock before committing",
    async () => {
      const destinationDir = path.join(TMP_DIR, "child-lock-contention");
      await fs.mkdir(destinationDir);
      const holder = await startOutputLockHolder(destinationDir);
      let contentionWaits = 0;
      let released = false;
      try {
        const committed = await writePdfDownloadAtomic(
          path.join(destinationDir, "download.pdf"),
          examplePdfBuffer,
          {
            sleepFn: async delayMs => {
              contentionWaits++;
              if (!released) {
                released = true;
                holder.child.stdin.end("release\n");
              }
              await new Promise(resolve => setTimeout(resolve, delayMs));
            },
          },
        );
        expect(contentionWaits).toBeGreaterThan(0);
        expect(committed.targetPath).toBe(path.join(destinationDir, "download.pdf"));
        await expect(fs.readFile(committed.targetPath)).resolves.toEqual(examplePdfBuffer);
      } finally {
        if (
          !released
          && holder.child.exitCode === null
          && holder.child.signalCode === null
        ) {
          holder.child.stdin.end("release\n");
        }
        const outcome = await holder.closed;
        expect(outcome).toEqual({ code: 0, signal: null });
      }
      expect(
        (await fs.readdir(destinationDir)).filter(name => name.startsWith(".pdf-tools-")),
      ).toEqual([]);
    },
    30_000,
  );

  it.runIf(process.platform !== "win32")(
    "resolves a same-directory child-process filename collision",
    async () => {
      const destinationDir = path.join(TMP_DIR, "child-process");
      const barrierPath = path.join(TMP_DIR, "child-process-start");
      const sourceOne = path.join(TMP_DIR, "child-source-one.pdf");
      const sourceTwo = path.join(TMP_DIR, "child-source-two.pdf");
      await fs.mkdir(destinationDir);
      const documentOne = await PDFDocument.load(examplePdfBuffer);
      documentOne.setSubject("child-one");
      const documentTwo = await PDFDocument.load(examplePdfBuffer);
      documentTwo.setSubject("child-two");
      const bodyOne = Buffer.from(await documentOne.save());
      const bodyTwo = Buffer.from(await documentTwo.save());
      await fs.writeFile(sourceOne, bodyOne);
      await fs.writeFile(sourceTwo, bodyTwo);
      const targetPath = path.join(destinationDir, "child.pdf");

      let one;
      let two;
      let results;
      try {
        one = await startDownloadWriteChild(targetPath, sourceOne, barrierPath);
        two = await startDownloadWriteChild(targetPath, sourceTwo, barrierPath);
        await fs.writeFile(barrierPath, "start");
        results = await Promise.all([one.result, two.result]);
      } finally {
        await Promise.all([killAndReapChild(one), killAndReapChild(two)]);
      }

      expect(new Set(results.map(result => path.basename(result.targetPath)))).toEqual(
        new Set(["child.pdf", "child (2).pdf"]),
      );
      const committedBodies = await Promise.all(
        results.map(result => fs.readFile(result.targetPath)),
      );
      expect(
        new Set(committedBodies.map(body => body.toString("base64"))),
      ).toEqual(new Set([bodyOne.toString("base64"), bodyTwo.toString("base64")]));
      expect(new Set(await fs.readdir(destinationDir))).toEqual(
        new Set(["child.pdf", "child (2).pdf"]),
      );
    },
    30_000,
  );

  it("overwrites when overwrite=true", async () => {
    const p = path.join(TMP_DIR, "overwrite.pdf");
    await fs.writeFile(p, "not a pdf");
    const result = await downloadPdfFromUrl("https://example.com/overwrite.pdf", {
      destinationDir: TMP_DIR,
      overwrite: true,
      expectedOutputIdentity: await expectedOutputIdentity(p),
      fetchFn: makeFakeFetch({ body: examplePdfBuffer }),
    });
    expect(result.path).toBe(p);
    const saved = await fs.readFile(p);
    expect(saved.subarray(0, 5).toString("ascii")).toBe("%PDF-");
  });

  it("rejects non-http(s) protocols", async () => {
    await expect(
      downloadPdfFromUrl("file:///etc/passwd", { destinationDir: TMP_DIR })
    ).rejects.toThrow(/http and https/);
    await expect(
      downloadPdfFromUrl("data:application/pdf;base64,JVBERi0x", { destinationDir: TMP_DIR })
    ).rejects.toThrow(/http and https/);
  });

  it("rejects private hosts by default", async () => {
    await expect(
      downloadPdfFromUrl("http://localhost:8080/x.pdf", { destinationDir: TMP_DIR })
    ).rejects.toThrow(/private\/loopback/);
    await expect(
      downloadPdfFromUrl("http://169.254.169.254/metadata", { destinationDir: TMP_DIR })
    ).rejects.toThrow(/private\/loopback/);
  });

  it("allows private hosts when opted in", async () => {
    const result = await downloadPdfFromUrl("http://192.168.1.50/internal.pdf", {
      destinationDir: TMP_DIR,
      allowPrivateHosts: true,
      fetchFn: makeFakeFetch({ body: examplePdfBuffer }),
    });
    expect(result.bytes).toBeGreaterThan(0);
  });

  it("rejects HTML response (non-PDF content)", async () => {
    const html = Buffer.from("<!doctype html><html><body>Not found</body></html>");
    await expect(
      downloadPdfFromUrl("https://example.com/fake.pdf", {
        destinationDir: TMP_DIR,
        fetchFn: makeFakeFetch({ body: html, contentType: "text/html" }),
      })
    ).rejects.toThrow(/did not return a PDF/);
  });

  it("rejects HTTP error status", async () => {
    await expect(
      downloadPdfFromUrl("https://example.com/missing.pdf", {
        destinationDir: TMP_DIR,
        fetchFn: makeFakeFetch({ body: Buffer.from(""), status: 404, statusText: "Not Found" }),
      })
    ).rejects.toThrow(/HTTP 404/);
  });

  it("rejects oversize PDF via content-length", async () => {
    // Fake fetch advertises a 200MB content-length
    const fetchFn = async () => ({
      ok: true,
      status: 200,
      statusText: "OK",
      headers: {
        get(name) {
          const n = name.toLowerCase();
          if (n === "content-type") return "application/pdf";
          if (n === "content-length") return String(200 * 1024 * 1024);
          return null;
        },
      },
      arrayBuffer: async () => new ArrayBuffer(0),
    });
    await expect(
      downloadPdfFromUrl("https://example.com/huge.pdf", {
        destinationDir: TMP_DIR,
        maxSizeMb: 100,
        fetchFn,
      })
    ).rejects.toThrow(/exceeds 100 MB/);
  });

  it("rejects invalid URL", async () => {
    await expect(
      downloadPdfFromUrl("not a url", { destinationDir: TMP_DIR })
    ).rejects.toThrow(/Invalid URL/);
  });

  it("reports network error clearly", async () => {
    const fetchFn = async () => { throw new Error("ECONNREFUSED"); };
    await expect(
      downloadPdfFromUrl("https://example.com/x.pdf", {
        destinationDir: TMP_DIR,
        fetchFn,
      })
    ).rejects.toThrow(/Could not reach example\.com: ECONNREFUSED/);
  });

  it("preserves .pdf extension when URL has no filename", async () => {
    const result = await downloadPdfFromUrl("https://example.com/", {
      destinationDir: TMP_DIR,
      fetchFn: makeFakeFetch({ body: examplePdfBuffer }),
    });
    expect(result.path).toMatch(/\.pdf$/);
  });
});

// ─── Redirect-based SSRF (v0.8.0 blocker fix) ────────────────────────────────

function makeRedirectFetch(redirects) {
  // redirects: array of { from, to } objects; final call returns the body.
  // Example: [{ from: "https://public.com/x.pdf", to: "http://169.254.169.254/..." }]
  let callIndex = 0;
  return async (url) => {
    const hop = redirects[callIndex];
    callIndex++;
    if (hop && hop.from === url) {
      return {
        ok: false,
        status: 302,
        statusText: "Found",
        headers: {
          get(name) {
            if (name.toLowerCase() === "location") return hop.to;
            return null;
          },
        },
        arrayBuffer: async () => new ArrayBuffer(0),
      };
    }
    // Final non-redirect response — return a valid PDF body
    const body = redirects._body;
    return {
      ok: true,
      status: 200,
      statusText: "OK",
      headers: {
        get(name) {
          if (name.toLowerCase() === "content-type") return "application/pdf";
          if (name.toLowerCase() === "content-length") return String(body.length);
          return null;
        },
      },
      body: new ReadableStream({
        start(controller) { controller.enqueue(new Uint8Array(body)); controller.close(); },
      }),
    };
  };
}

describe("downloadPdfFromUrl — redirect SSRF protection", () => {
  let examplePdfBuffer;

  beforeAll(async () => {
    examplePdfBuffer = await fs.readFile(EXAMPLE_PDF);
  });

  it("rejects redirect to AWS metadata endpoint (169.254.169.254)", async () => {
    const fetchFn = makeRedirectFetch(Object.assign(
      [{ from: "https://public-cdn.example.com/x.pdf", to: "http://169.254.169.254/latest/meta-data/" }],
      { _body: examplePdfBuffer }
    ));
    await expect(
      downloadPdfFromUrl("https://public-cdn.example.com/x.pdf", {
        destinationDir: TMP_DIR,
        fetchFn,
      })
    ).rejects.toThrow(/private\/loopback host "169\.254\.169\.254"/);
  });

  it("rejects redirect to localhost", async () => {
    const fetchFn = makeRedirectFetch(Object.assign(
      [{ from: "https://public-cdn.example.com/x.pdf", to: "http://localhost:8080/secret.pdf" }],
      { _body: examplePdfBuffer }
    ));
    await expect(
      downloadPdfFromUrl("https://public-cdn.example.com/x.pdf", {
        destinationDir: TMP_DIR,
        fetchFn,
      })
    ).rejects.toThrow(/private\/loopback host "localhost"/);
  });

  it("rejects redirect to RFC1918 internal network", async () => {
    const fetchFn = makeRedirectFetch(Object.assign(
      [{ from: "https://public-cdn.example.com/x.pdf", to: "http://10.0.0.1/intranet.pdf" }],
      { _body: examplePdfBuffer }
    ));
    await expect(
      downloadPdfFromUrl("https://public-cdn.example.com/x.pdf", {
        destinationDir: TMP_DIR,
        fetchFn,
      })
    ).rejects.toThrow(/private\/loopback host "10\.0\.0\.1"/);
  });

  it("follows a public-to-public redirect successfully", async () => {
    const fetchFn = makeRedirectFetch(Object.assign(
      [{ from: "https://short.example.com/fw9", to: "https://www.irs.gov/pub/irs-pdf/fw9.pdf" }],
      { _body: examplePdfBuffer }
    ));
    const result = await downloadPdfFromUrl("https://short.example.com/fw9", {
      destinationDir: TMP_DIR,
      filename: "redirected.pdf",
      fetchFn,
    });
    expect(result.bytes).toBe(examplePdfBuffer.length);
    expect(result.redirectHops).toBe(1);
    expect(result.finalUrl).toBe("https://www.irs.gov/pub/irs-pdf/fw9.pdf");
  });

  it("rejects redirect loop exceeding maxRedirects", async () => {
    const manyHops = Array.from({ length: 10 }, (_, i) => ({
      from: `https://hop${i}.example.com/`,
      to: `https://hop${i + 1}.example.com/`,
    }));
    const fetchFn = makeRedirectFetch(Object.assign(manyHops, { _body: examplePdfBuffer }));
    await expect(
      downloadPdfFromUrl("https://hop0.example.com/", {
        destinationDir: TMP_DIR,
        fetchFn,
        maxRedirects: 5,
      })
    ).rejects.toThrow(/Too many redirects/);
  });

  it("resolves relative Location headers against the current URL", async () => {
    const fetchFn = makeRedirectFetch(Object.assign(
      [{ from: "https://example.com/old/x.pdf", to: "/new/x.pdf" }],
      { _body: examplePdfBuffer }
    ));
    const result = await downloadPdfFromUrl("https://example.com/old/x.pdf", {
      destinationDir: TMP_DIR,
      filename: "relative.pdf",
      fetchFn,
    });
    expect(result.finalUrl).toBe("https://example.com/new/x.pdf");
  });

  it("does NOT write a file when redirect is rejected", async () => {
    const before = await fs.readdir(TMP_DIR).catch(() => []);
    const fetchFn = makeRedirectFetch(Object.assign(
      [{ from: "https://public-cdn.example.com/x.pdf", to: "http://127.0.0.1/" }],
      { _body: Buffer.from("") }
    ));
    await expect(
      downloadPdfFromUrl("https://public-cdn.example.com/x.pdf", {
        destinationDir: TMP_DIR,
        fetchFn,
      })
    ).rejects.toThrow();
    const after = await fs.readdir(TMP_DIR).catch(() => []);
    expect(after.length).toBe(before.length);
  });
});
