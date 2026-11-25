#!/usr/bin/env node
// Start the local PDF Tools server inside a Claude plugin.
//
// The Claude plugin directory cannot carry node_modules: it stops validating a
// repository over 50 MiB, and the five native canvas binaries alone are about
// 140 MB. So the plugin ships readable source plus package.json and
// package-lock.json, and this launcher installs the locked production graph
// into the plugin's persistent data directory on first run.
//
// What it does, in order:
//   1. Refuses an unsupported Node version with a readable message.
//   2. Picks a runtime folder keyed by the SHA-256 of the shipped payload, so a
//      plugin update gets a fresh install and an unchanged plugin reuses it.
//   3. If that folder is not ready, copies the payload into it and runs
//      `npm ci --omit=dev --ignore-scripts` there. npm checks every package
//      against the lockfile's integrity hash and installs only the native canvas
//      package for this machine's platform. No install scripts run.
//   4. Starts server/index.js from that folder with stdio passed through, and
//      exits with its exit code.
//
// stdout is the MCP channel, so everything this file prints goes to stderr.
//
// `--prepare` runs steps 1-3 and exits; the plugin's SessionStart hook uses it
// so the first install usually finishes before a PDF tool is needed.

import { spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  cpSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const PLUGIN_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const PAYLOAD_MANIFEST = path.join(PLUGIN_ROOT, "runtime", "payload.json");
const READY_MARKER = ".pdf-tools-ready";
const LOCK_STALE_MS = 10 * 60 * 1000;
const LOCK_WAIT_MS = 5 * 60 * 1000;

const log = message => process.stderr.write(`[pdf-tools] ${message}\n`);

function supportedNode(version) {
  const [major, minor] = String(version).split(".").map(Number);
  return (major === 20 && minor >= 19) || (major === 22 && minor >= 12) || major > 22;
}

// Claude Code sets CLAUDE_PLUGIN_DATA. A value still holding "${" means the
// host did not expand it, which is treated the same as absent.
function usable(value) {
  return typeof value === "string" && value.length > 0 && !value.includes("${");
}

function dataDirectory() {
  if (usable(process.env.CLAUDE_PLUGIN_DATA)) return path.resolve(process.env.CLAUDE_PLUGIN_DATA);
  if (usable(process.env.PLUGIN_DATA)) return path.resolve(process.env.PLUGIN_DATA);
  return path.join(homedir(), ".pdf-tools", "claude-plugin");
}

function sha256(file) {
  return createHash("sha256").update(readFileSync(file)).digest("hex");
}

function readPayload() {
  const manifest = JSON.parse(readFileSync(PAYLOAD_MANIFEST, "utf8"));
  if (manifest.version !== 1 || !Array.isArray(manifest.files) || typeof manifest.digest !== "string") {
    throw new Error("runtime/payload.json is not a version 1 payload manifest");
  }
  for (const entry of manifest.files) {
    if (typeof entry.path !== "string" || entry.path.startsWith("/") || entry.path.split("/").includes("..")) {
      throw new Error(`payload path is not contained: ${entry.path}`);
    }
  }
  return manifest;
}

// Locate npm's own entry point next to the running Node, so npm runs as
// `node npm-cli.js` with no shell and no reliance on PATH (GUI-launched hosts
// often sanitize it).
function npmCli() {
  const nodeDir = path.dirname(process.execPath);
  const candidates = [
    process.env.npm_execpath,
    path.join(nodeDir, "node_modules", "npm", "bin", "npm-cli.js"),
    path.join(nodeDir, "..", "lib", "node_modules", "npm", "bin", "npm-cli.js"),
  ];
  for (const candidate of candidates) {
    if (candidate && candidate.endsWith(".js") && existsSync(candidate)) return candidate;
  }
  return null;
}

function acquireLock(lockDir) {
  const deadline = Date.now() + LOCK_WAIT_MS;
  for (;;) {
    try {
      mkdirSync(lockDir);
      writeFileSync(path.join(lockDir, "owner"), `${process.pid}\n`);
      return;
    } catch (error) {
      if (error.code !== "EEXIST") throw error;
      let age = 0;
      try { age = Date.now() - statSync(lockDir).mtimeMs; } catch { continue; }
      if (age > LOCK_STALE_MS) { rmSync(lockDir, { recursive: true, force: true }); continue; }
      if (Date.now() > deadline) throw new Error(`another install still holds ${lockDir}`);
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 500);
    }
  }
}

function verifyPayloadCopy(root, manifest) {
  for (const entry of manifest.files) {
    const file = path.join(root, ...entry.path.split("/"));
    if (!existsSync(file) || sha256(file) !== entry.sha256) {
      throw new Error(`payload file does not match its manifest: ${entry.path}`);
    }
  }
}

// Keep the new runtime and the most recent previous one: another session that
// started before the plugin updated may still be running from it. Anything
// older goes. A runtime that cannot be removed (in use on Windows) stays for
// the next install to try again; pruning never fails a start.
function pruneRuntimes(runtimeRoot, keep) {
  try {
    const others = readdirSync(runtimeRoot)
      .filter(name => name !== keep && !name.startsWith("."))
      .map(name => ({ name, mtime: statSync(path.join(runtimeRoot, name)).mtimeMs }))
      .sort((a, b) => b.mtime - a.mtime);
    for (const { name } of others.slice(1)) {
      try { rmSync(path.join(runtimeRoot, name), { recursive: true, force: true }); } catch {}
    }
  } catch {}
}

function install(dataDir, manifest) {
  const runtimeRoot = path.join(dataDir, "runtime");
  const target = path.join(runtimeRoot, manifest.digest.slice(0, 16));
  if (existsSync(path.join(target, READY_MARKER))) return target;

  mkdirSync(runtimeRoot, { recursive: true });
  const lockDir = path.join(runtimeRoot, ".install-lock");
  acquireLock(lockDir);
  try {
    if (existsSync(path.join(target, READY_MARKER))) return target;
    const cli = npmCli();
    if (!cli) {
      throw new Error("npm was not found next to this Node runtime. Install Node.js with npm (20.19+ or 22.12+) and restart.");
    }
    const staging = path.join(runtimeRoot, `.staging-${process.pid}`);
    rmSync(staging, { recursive: true, force: true });
    for (const entry of manifest.files) {
      const destination = path.join(staging, ...entry.path.split("/"));
      mkdirSync(path.dirname(destination), { recursive: true });
      cpSync(path.join(PLUGIN_ROOT, ...entry.path.split("/")), destination);
    }
    verifyPayloadCopy(staging, manifest);

    log("First run for this version: installing locked dependencies (one time, about 45 MB download)…");
    const result = spawnSync(process.execPath, [
      cli, "ci", "--omit=dev", "--ignore-scripts", "--no-audit", "--no-fund", "--update-notifier=false", "--loglevel=error",
    ], {
      cwd: staging,
      // npm's progress and errors go to stderr; its stdout must never reach the MCP channel.
      stdio: ["ignore", "pipe", "pipe"],
      encoding: "utf8",
      timeout: LOCK_STALE_MS,
    });
    if (result.stdout) process.stderr.write(result.stdout);
    if (result.stderr) process.stderr.write(result.stderr);
    if (result.error || result.status !== 0) {
      rmSync(staging, { recursive: true, force: true });
      throw new Error(`dependency install failed (${result.error?.message ?? `npm exited ${result.status}`}). It needs network access to registry.npmjs.org on first run.`);
    }
    writeFileSync(path.join(staging, READY_MARKER), `${manifest.digest}\n`);
    rmSync(target, { recursive: true, force: true });
    renameSync(staging, target);

    log("Dependencies installed.");
    pruneRuntimes(runtimeRoot, path.basename(target));
    return target;
  } finally {
    rmSync(lockDir, { recursive: true, force: true });
  }
}

function startServer(runtimeDir, dataDir) {
  const child = spawn(process.execPath, [path.join(runtimeDir, "server", "index.js"), ...process.argv.slice(2)], {
    cwd: runtimeDir,
    windowsHide: true,
    // The server keeps its folder config and private import workspace in
    // PLUGIN_DATA, the Agent Plugins name for the same directory.
    env: { ...process.env, PLUGIN_DATA: dataDir },
    stdio: "inherit",
  });
  for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"]) {
    process.on(signal, () => { if (!child.killed) child.kill(signal); });
  }
  child.on("error", error => { log(`could not start the server: ${error.message}`); process.exit(1); });
  child.on("exit", (code, signal) => process.exit(code ?? (signal ? 1 : 0)));
}

function main() {
  if (!supportedNode(process.versions.node)) {
    log(`Node.js ${process.versions.node} is too old. PDF Tools needs Node.js 20.19+ or 22.12+.`);
    process.exit(1);
  }
  const prepareOnly = process.argv.includes("--prepare") || process.argv.includes("--prepare-now");
  const dataDir = dataDirectory();
  const manifest = readPayload();
  // The SessionStart hook must not hold up the session: when an install is
  // needed it hands the work to a detached copy of this script and returns.
  if (process.argv.includes("--prepare")) {
    const ready = path.join(dataDir, "runtime", manifest.digest.slice(0, 16), READY_MARKER);
    if (!existsSync(ready)) {
      spawn(process.execPath, [fileURLToPath(import.meta.url), "--prepare-now"], {
        detached: true,
        stdio: "ignore",
        windowsHide: true,
        env: process.env,
      }).unref();
    }
    return;
  }
  let runtimeDir;
  try {
    runtimeDir = install(dataDir, manifest);
  } catch (error) {
    log(error.message);
    process.exit(prepareOnly ? 0 : 1);
  }
  if (prepareOnly) return;
  startServer(runtimeDir, dataDir);
}

main();
