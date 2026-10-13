import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { describe, afterEach, expect, it } from "vitest";
import {
  prepareDoclingMacHandoff,
  prepareDoclingMacHandoffForTest,
  doclingCalibrationStatus,
} from "./extraction-docling-handoff.js";
import { validateReceipt } from "../../scripts/eval-capture-docling-bakeoff.mjs";
import { validateReceipt as validateBakeoffRunnerReceipt } from "../../scripts/eval-run-markdown-bakeoff.mjs";

// Regression coverage for the calibration-bootstrap bypass. Deliberately NOT
// gated on calibration currency: this suite tests the staleness machinery
// itself. The two pipeline tests need the attestation to actually be stale,
// which is the repository's current state; if a future re-approval makes the
// calibration current, they skip by construction because the stale branch no
// longer exists to exercise.

const SCHEMA_PATH = path.resolve(
  "test/fixtures/eval/extraction/phase1/docling-handoff.schema.json",
);

const DARWIN_ARM64 = {
  platform: "darwin",
  architecture: "arm64",
  os_build: "25G5065a",
  kernel_release: "25.6.0",
  node_version: process.version,
};

const roots = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map(
    root => fs.rm(root, { recursive: true, force: true }),
  ));
});

async function temporaryRoot(prefix) {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), prefix)));
  roots.push(root);
  await fs.chmod(root, 0o700);
  return root;
}

async function fixture(root) {
  const filename = path.join(root, "fixture.pdf");
  await fs.writeFile(filename, "%PDF-1.7\ntruth-free bootstrap fixture\n%%EOF\n", { mode: 0o600 });
  return filename;
}

async function options(root, calibrationBootstrap) {
  const uvPath = path.join(root, "uv-test-binary");
  const uvVersion = "uv 0.11.29 (901092ee1 2026-07-15 aarch64-apple-darwin)";
  await fs.writeFile(uvPath, `#!/bin/sh\nprintf '%s\\n' '${uvVersion}'\n`, { mode: 0o700, flag: "wx" });
  return {
    cacheRoot: path.join(root, "Library/Caches/oda-pdf-tools-extraction"),
    sidecarRoot: path.join(root, "Sites/pdf-tools-extraction-sidecars"),
    protectedRoots: [path.join(root, "Documents"), path.join(root, "Dropbox")],
    fixturePaths: [await fixture(root)],
    calibrationBootstrap,
    testOnlyHost: DARWIN_ARM64,
    testOnlyUv: { path: uvPath, version: uvVersion },
    testOnlySupervisorBuild: {
      binaryBytes: Buffer.from("pdf-tools-test-only-supervisor-binary\n"),
    },
  };
}

const calibrationIsStale = !doclingCalibrationStatus().current;

describe("Docling calibration-bootstrap bypass", () => {
  it("keeps the production entry point closed to injected facts even with the bootstrap flag", async () => {
    await expect(prepareDoclingMacHandoff({
      calibrationBootstrap: true,
      testOnlyHost: DARWIN_ARM64,
    })).rejects.toThrow(/does not accept injected/);
  });

  it.skipIf(!calibrationIsStale)("still raises the typed stale error when the flag is off", async () => {
    const root = await temporaryRoot("pdf-tools-bootstrap-off-");
    const error = await prepareDoclingMacHandoffForTest(await options(root, false))
      .then(() => null, raised => raised);
    expect(error).not.toBeNull();
    expect(error.code).toBe("EVAL_ATTESTATION_STALE");
    expect(error.message).toMatch(/re-approval requirement, not a product defect/);
  });

  // Not gated on staleness: the marker is stamped whenever the flag is
  // passed, drifted calibration or not, so this coverage must survive a
  // future re-approval.
  it("stamps the bootstrap marker into the durable receipt bytes and both scored runners refuse it", async () => {
    const root = await temporaryRoot("pdf-tools-bootstrap-on-");
    const handoff = await prepareDoclingMacHandoffForTest(await options(root, true));

    // In-memory result and durable receipt object both carry the marker.
    expect(handoff.calibration_bootstrap).toBe(true);
    expect(handoff.receipt.calibration_bootstrap).toBe(true);

    // The marker survives in the exact bytes on disk, so a cross-process
    // consumer reading the receipt by path can see it.
    const persisted = JSON.parse(await fs.readFile(handoff.receiptPath, "utf8"));
    expect(persisted.calibration_bootstrap).toBe(true);

    // Every scored path refuses the receipt outright: the bakeoff capture
    // and the markdown bakeoff runner, which validates receipts on its own.
    const schema = JSON.parse(await fs.readFile(SCHEMA_PATH, "utf8"));
    expect(() => validateReceipt(persisted, schema))
      .toThrow(/calibration-bootstrap handoff and cannot produce qualifying or scored evidence/);
    expect(() => validateBakeoffRunnerReceipt(persisted, schema))
      .toThrow(/calibration-bootstrap handoff and cannot produce qualifying or scored evidence/);
  });

  it("surfaces the taint in the authority verify success envelope", async () => {
    const root = await temporaryRoot("pdf-tools-bootstrap-verify-");
    const handoff = await prepareDoclingMacHandoffForTest(await options(root, true));
    const command = handoff.receipt.setup.authority_command.map(value => value === "setup" ? "verify"
      : value === "$OUT_OF_BAND_RECEIPT_SHA256" ? handoff.receipt_sha256
        : value === "$OUT_OF_BAND_PROTECTED_ROOTS_JSON" ? handoff.protected_roots_json : value);
    const result = spawnSync(command[0], command.slice(1), {
      encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], env: process.env,
      timeout: 10_000,
    });
    expect(result.status, result.stderr).toBe(0);
    const envelope = JSON.parse(result.stdout);
    expect(envelope.verified).toBe(true);
    expect(envelope.calibration_bootstrap).toBe(true);
    expect(envelope.qualifying).toBe(false);
    // This verifies a retained snapshot through another Node process, not a
    // product-latency contract. Allow bounded setup plus the bounded child on
    // supported macOS hosts rather than the generic five-second unit budget.
  }, 15_000);

  it("keeps the taint in the authority setup envelope by construction", async () => {
    // The setup action runs the full uv toolchain, which a unit bank cannot,
    // so the setup envelope's taint is asserted at source: both success
    // envelopes must spread the same taint object derived from the receipt.
    const source = await fs.readFile(
      path.resolve("scripts/eval-docling-authority.mjs"), "utf8",
    );
    const spreads = source.match(/\.\.\.taint/g) ?? [];
    expect(spreads.length).toBe(2);
    expect(source).toContain("calibration_bootstrap: true, qualifying: false");
  });

  it("refuses a bootstrap-marked receipt before shape validation in both runners", () => {
    expect(() => validateReceipt({ calibration_bootstrap: true }, { type: "object" }))
      .toThrow(/cannot produce qualifying or scored evidence/);
    expect(() => validateBakeoffRunnerReceipt({ calibration_bootstrap: true }, { type: "object" }))
      .toThrow(/cannot produce qualifying or scored evidence/);
  });
});
