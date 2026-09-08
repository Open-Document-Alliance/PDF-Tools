#!/usr/bin/env node
// Fetches, verifies, and promotes the prebuilt PDFium Windows binaries pinned
// in vendor/pdfium/sources.lock.json. PDFium is not built from source here —
// bblanchon/pdfium-binaries already publishes official Google Chromium PDFium
// builds, so this script's job is narrower than
// scripts/vendor-qpdf-wasm-runtime.mjs: download the pinned release asset for
// each Windows architecture, verify both the archive and the extracted DLL
// against the pinned SHA-256, and copy the DLL plus the release's own bundled
// third-party license notices into vendor/pdfium/runtime and
// vendor/pdfium/licenses. It refuses to promote anything that does not match
// the lock file, so a tampered or wrong-version download cannot become the
// shipped artifact.
//
// Usage: node scripts/vendor-pdfium-runtime.mjs
import { createHash } from "node:crypto";
import { createWriteStream } from "node:fs";
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { pipeline } from "node:stream/promises";
import { spawn } from "node:child_process";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const VENDOR_DIR = path.join(REPO_ROOT, "vendor", "pdfium");
const LOCK_PATH = path.join(VENDOR_DIR, "sources.lock.json");

async function sha256File(filePath) {
  const hash = createHash("sha256");
  const buffer = await readFile(filePath);
  hash.update(buffer);
  return hash.digest("hex");
}

async function downloadTo(url, destPath) {
  const response = await fetch(url, { redirect: "follow" });
  if (!response.ok || !response.body) {
    throw new Error(`Download failed (${response.status}) for ${url}`);
  }
  await pipeline(response.body, createWriteStream(destPath));
}

async function extractTarGz(archivePath, destDir) {
  await mkdir(destDir, { recursive: true });
  await new Promise((resolve, reject) => {
    const child = spawn("tar", ["-xzf", archivePath, "-C", destDir], { stdio: "inherit" });
    child.once("error", reject);
    child.once("close", code => {
      if (code === 0) resolve();
      else reject(new Error(`tar extraction failed with exit code ${code}`));
    });
  });
}

async function promoteAsset(asset, workDir) {
  const archivePath = path.join(workDir, `${asset.arch}.tgz`);
  console.log(`Downloading ${asset.arch} from ${asset.url}`);
  await downloadTo(asset.url, archivePath);

  const archiveHash = await sha256File(archivePath);
  if (archiveHash !== asset.archive_sha256) {
    throw new Error(
      `${asset.arch}: archive SHA-256 mismatch. Expected ${asset.archive_sha256}, got ${archiveHash}. `
      + "Refusing to promote an unpinned download.",
    );
  }

  const extractDir = path.join(workDir, `${asset.arch}-extracted`);
  await extractTarGz(archivePath, extractDir);

  const dllPath = path.join(extractDir, asset.extracted_file);
  const dllHash = await sha256File(dllPath);
  if (dllHash !== asset.extracted_sha256) {
    throw new Error(
      `${asset.arch}: pdfium.dll SHA-256 mismatch. Expected ${asset.extracted_sha256}, got ${dllHash}.`,
    );
  }

  const runtimeDir = path.join(VENDOR_DIR, "runtime", asset.arch);
  await mkdir(runtimeDir, { recursive: true });
  await writeFile(path.join(runtimeDir, "pdfium.dll"), await readFile(dllPath));

  return { extractDir };
}

async function promoteLicenses(extractDir) {
  const licensesSourceDir = path.join(extractDir, "licenses");
  const licensesDestDir = path.join(VENDOR_DIR, "licenses");
  await mkdir(licensesDestDir, { recursive: true });
  const entries = await readdir(licensesSourceDir);
  for (const entry of entries) {
    const bytes = await readFile(path.join(licensesSourceDir, entry));
    await writeFile(path.join(licensesDestDir, entry), bytes);
  }
}

async function writeLicenseManifest() {
  const licensesDestDir = path.join(VENDOR_DIR, "licenses");
  const entries = (await readdir(licensesDestDir))
    .filter(name => name !== "manifest.json")
    .sort();
  const notices = [];
  for (const name of entries) {
    const filePath = path.join(licensesDestDir, name);
    const bytes = await readFile(filePath);
    notices.push({
      file: name,
      sha256: createHash("sha256").update(bytes).digest("hex"),
      size_bytes: bytes.length,
    });
  }
  await writeFile(
    path.join(licensesDestDir, "manifest.json"),
    `${JSON.stringify({ schema_version: 1, notices }, null, 2)}\n`,
  );
}

async function main() {
  const lock = JSON.parse(await readFile(LOCK_PATH, "utf8"));
  const workDir = await mkdtemp(path.join(tmpdir(), "pdfium-vendor-"));
  try {
    let lastExtractDir = null;
    for (const asset of lock.assets) {
      const { extractDir } = await promoteAsset(asset, workDir);
      lastExtractDir = extractDir;
    }
    // Every architecture ships the identical license set for a given tag
    // (verified against upstream at pin time), so one extraction's licenses/
    // directory is authoritative for all of them.
    await promoteLicenses(lastExtractDir);
    await writeLicenseManifest();
    console.log("PDFium runtime promoted from pinned, verified sources.");
  } finally {
    await rm(workDir, { recursive: true, force: true });
  }
}

await main();
