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
//   3. If that folder is not ready, starts a detached installer (this file with
//      `--prepare-now`) and waits for it. The installer copies the payload,
//      verifies every hash, and runs `npm ci --omit=dev --ignore-scripts`. npm
//      checks every package against the lockfile's integrity hash and installs
//      the native canvas packages for this machine's platform. No install
//      scripts run. The install goes ahead only if the canvas build this machine
//      loads is one of the five the release reviews (REVIEWED_CANVAS; the Canvas
//      archive policy in docs/MAINTAINERS.md), and any other canvas build npm
//      fetched is deleted. The installer is detached so that it finishes
//      even if the host stops this launcher at its MCP startup timeout; the
//      next connection then finds the runtime ready.
//   4. Starts server/index.js from that folder with stdio passed through, and
//      exits with its exit code.
//
// stdout is the MCP channel, so everything this file prints goes to stderr.
//
// `--prepare` (the plugin's SessionStart hook) starts the detached installer
// when needed and returns at once, so the first install usually finishes
// before a PDF tool is needed.

import { spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  closeSync,
  cpSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  readdirSync,
  realpathSync,
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
const NPM_TIMEOUT_MS = 10 * 60 * 1000;
// Longer than a payload copy plus the npm timeout, so a live install is never
// taken for stale. An installer that died is detected by its PID at once.
const LOCK_STALE_MS = 30 * 60 * 1000;
const LOCK_WAIT_MS = 5 * 60 * 1000;

// The native canvas builds the release reviews (docs/MAINTAINERS.md, "Canvas
// archive policy"). npm picks the build for this machine from the lockfile;
// any other build is refused rather than run unreviewed.
export const REVIEWED_CANVAS = Object.freeze([
  "canvas-darwin-arm64",
  "canvas-darwin-x64",
  "canvas-linux-x64-gnu",
  "canvas-win32-arm64-msvc",
  "canvas-win32-x64-msvc",
]);

const log = message => process.stderr.write(`[pdf-tools] ${message}\n`);
const sleep = ms => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);

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

// A payload path is relative, forward-slashed, and stays inside the plugin on
// every platform (no drive letters, backslashes or "..").
function containedPayloadPath(rel) {
  if (typeof rel !== "string" || rel.length === 0 || rel.includes("\\") || rel.includes(":") || rel.startsWith("/")) return false;
  const parts = rel.split("/");
  return !parts.some(part => part === "" || part === "." || part === "..");
}

export function readPayload(manifestFile = PAYLOAD_MANIFEST) {
  const manifest = JSON.parse(readFileSync(manifestFile, "utf8"));
  if (manifest.version !== 1 || !Array.isArray(manifest.files) || typeof manifest.digest !== "string") {
    throw new Error("runtime/payload.json is not a version 1 payload manifest");
  }
  for (const entry of manifest.files) {
    if (!containedPayloadPath(entry?.path) || typeof entry.sha256 !== "string") {
      throw new Error(`payload path is not contained: ${entry?.path}`);
    }
  }
  if (createHash("sha256").update(JSON.stringify(manifest.files)).digest("hex") !== manifest.digest) {
    throw new Error("runtime/payload.json digest does not match its file list");
  }
  return manifest;
}

// Locate npm's own entry point, so npm runs as `node npm-cli.js` with no shell.
// Next to the running Node first (GUI-launched hosts often sanitize PATH),
// then an `npm` on PATH followed to its entry point, then the usual system
// locations.
export function npmCli({ execPath = process.execPath, env = process.env } = {}) {
  const nodeDir = path.dirname(execPath);
  const isCli = candidate => Boolean(candidate) && path.basename(candidate) === "npm-cli.js" && existsSync(candidate);
  const nearNode = [
    env.npm_execpath,
    // Windows installer
    path.join(nodeDir, "node_modules", "npm", "bin", "npm-cli.js"),
    // Official tarballs, nvm, distribution packages under /usr
    path.join(nodeDir, "..", "lib", "node_modules", "npm", "bin", "npm-cli.js"),
    // Homebrew, where Node resolves to its Cellar folder
    path.join(nodeDir, "..", "libexec", "lib", "node_modules", "npm", "bin", "npm-cli.js"),
  ];
  for (const candidate of nearNode) if (isCli(candidate)) return candidate;

  for (const dir of String(env.PATH ?? env.Path ?? "").split(path.delimiter)) {
    if (!dir) continue;
    for (const name of ["npm", path.join("node_modules", "npm", "bin", "npm-cli.js")]) {
      try {
        const real = realpathSync(path.join(dir, name));
        if (isCli(real)) return real;
      } catch {}
    }
  }

  const system = [
    "/opt/homebrew/lib/node_modules/npm/bin/npm-cli.js",
    "/usr/local/lib/node_modules/npm/bin/npm-cli.js",
    // Debian's npm package
    "/usr/share/nodejs/npm/bin/npm-cli.js",
  ];
  for (const candidate of system) if (isCli(candidate)) return candidate;
  return null;
}

// True only when the process is known not to exist. EPERM means it exists
// under another user.
function pidIsGone(pid) {
  if (!Number.isInteger(pid) || pid <= 0 || pid === process.pid) return false;
  try {
    process.kill(pid, 0);
    return false;
  } catch (error) {
    return error.code === "ESRCH";
  }
}

// A missing or unreadable owner file means the owner may still be writing it,
// so it is not treated as gone; the age limit covers that case.
function lockOwnerIsGone(lockDir) {
  try {
    return pidIsGone(Number.parseInt(readFileSync(path.join(lockDir, "owner"), "utf8"), 10));
  } catch {
    return false;
  }
}

export function acquireLock(lockDir, { waitMs = LOCK_WAIT_MS } = {}) {
  const deadline = Date.now() + waitMs;
  for (;;) {
    try {
      mkdirSync(lockDir);
      writeFileSync(path.join(lockDir, "owner"), `${process.pid}\n`);
      return;
    } catch (error) {
      if (error.code !== "EEXIST") throw error;
      let age = 0;
      try { age = Date.now() - statSync(lockDir).mtimeMs; } catch { continue; }
      // An installer that was killed leaves its lock behind; take it over at
      // once rather than making every launcher wait out the age limit.
      if (age > LOCK_STALE_MS || lockOwnerIsGone(lockDir)) { rmSync(lockDir, { recursive: true, force: true }); continue; }
      if (Date.now() > deadline) throw new Error(`another install still holds ${lockDir}`);
      sleep(500);
    }
  }
}

// The canvas package @napi-rs/canvas loads on this machine.
export function hostCanvasPackage({
  platform = process.platform,
  arch = process.arch,
  glibc = platform === "linux" ? Boolean(process.report?.getReport?.().header?.glibcVersionRuntime) : false,
} = {}) {
  if (platform === "win32") return `canvas-win32-${arch}-msvc`;
  if (platform === "linux") return `canvas-linux-${arch}-${glibc ? "gnu" : "musl"}`;
  return `canvas-${platform}-${arch}`;
}

function lockUsesCanvas(root) {
  try {
    return Boolean(JSON.parse(readFileSync(path.join(root, "package-lock.json"), "utf8")).packages?.["node_modules/@napi-rs/canvas"]);
  } catch {
    return false;
  }
}

// The native canvas packages npm installed that the release has not reviewed.
// On Linux npm fetches the musl build beside the glibc one; it is never loaded
// there, and it is deleted so nothing unreviewed stays on disk.
export function unreviewedCanvas(runtimeDir) {
  let names;
  try { names = readdirSync(path.join(runtimeDir, "node_modules", "@napi-rs")); } catch { return []; }
  return names.filter(name => name.startsWith("canvas-") && !REVIEWED_CANVAS.includes(name));
}

function verifyPayloadCopy(root, manifest) {
  for (const entry of manifest.files) {
    const file = path.join(root, ...entry.path.split("/"));
    if (!existsSync(file) || sha256(file) !== entry.sha256) {
      throw new Error(`payload file does not match its manifest: ${entry.path}`);
    }
  }
}

// Antivirus scanning a fresh node_modules can make a rename fail for a moment
// on Windows; retry briefly, as graceful-fs does.
function renameWithRetry(from, to) {
  for (let attempt = 1; ; attempt += 1) {
    try {
      renameSync(from, to);
      return;
    } catch (error) {
      if (attempt >= 10 || !["EPERM", "EBUSY", "EACCES"].includes(error.code)) throw error;
      sleep(100 * attempt);
    }
  }
}

// Keep the new runtime and the most recent previous one: another session that
// started before the plugin updated may still be running from it. Anything
// older goes, as do staging folders and logs left by installers that died. A
// folder that cannot be removed (in use on Windows) stays for the next install
// to try again; pruning never fails a start.
function pruneRuntimes(runtimeRoot, keep) {
  try {
    const names = readdirSync(runtimeRoot);
    for (const name of names) {
      const owner = /^\.(?:staging|install)-(\d+)(?:\.log)?$/.exec(name);
      if (owner && pidIsGone(Number(owner[1]))) {
        try { rmSync(path.join(runtimeRoot, name), { recursive: true, force: true }); } catch {}
      }
    }
    const others = names
      .filter(name => name !== keep && !name.startsWith("."))
      .map(name => ({ name, mtime: statSync(path.join(runtimeRoot, name)).mtimeMs }))
      .sort((a, b) => b.mtime - a.mtime);
    for (const { name } of others.slice(1)) {
      try { rmSync(path.join(runtimeRoot, name), { recursive: true, force: true }); } catch {}
    }
  } catch {}
}

function runtimePaths(dataDir, manifest) {
  const runtimeRoot = path.join(dataDir, "runtime");
  const target = path.join(runtimeRoot, manifest.digest.slice(0, 16));
  return { runtimeRoot, target, ready: path.join(target, READY_MARKER) };
}

function install(dataDir, manifest) {
  const { runtimeRoot, target, ready } = runtimePaths(dataDir, manifest);
  if (existsSync(ready)) return target;

  mkdirSync(runtimeRoot, { recursive: true });
  const lockDir = path.join(runtimeRoot, ".install-lock");
  acquireLock(lockDir);
  try {
    if (existsSync(ready)) return target;
    const canvas = lockUsesCanvas(PLUGIN_ROOT) ? hostCanvasPackage() : null;
    if (canvas && !REVIEWED_CANVAS.includes(canvas)) {
      throw new Error(`this platform's canvas build (@napi-rs/${canvas}) is not one PDF Tools has reviewed. The local server supports macOS (Apple silicon and Intel), Windows (x64 and arm64) and Linux x64 with glibc.`);
    }
    const cli = npmCli();
    if (!cli) {
      throw new Error("npm was not found for this Node runtime. Install Node.js with npm (20.19+ or 22.12+) and restart.");
    }
    const staging = path.join(runtimeRoot, `.staging-${process.pid}`);
    rmSync(staging, { recursive: true, force: true });
    try {
      for (const entry of manifest.files) {
        const destination = path.join(staging, ...entry.path.split("/"));
        mkdirSync(path.dirname(destination), { recursive: true });
        cpSync(path.join(PLUGIN_ROOT, ...entry.path.split("/")), destination);
      }
      verifyPayloadCopy(staging, manifest);

      const result = spawnSync(process.execPath, [
        cli, "ci", "--omit=dev", "--ignore-scripts", "--no-audit", "--no-fund", "--update-notifier=false", "--loglevel=error",
      ], {
        cwd: staging,
        // npm's progress and errors go to stderr; its stdout must never reach the MCP channel.
        stdio: ["ignore", "pipe", "pipe"],
        encoding: "utf8",
        timeout: NPM_TIMEOUT_MS,
        windowsHide: true,
      });
      if (result.stdout) process.stderr.write(result.stdout);
      if (result.stderr) process.stderr.write(result.stderr);
      if (result.error || result.status !== 0) {
        throw new Error(`dependency install failed (${result.error?.message ?? `npm exited ${result.status}`}). It needs network access to registry.npmjs.org on first run.`);
      }
      const canvasDir = path.join(staging, "node_modules", "@napi-rs");
      if (canvas && !existsSync(path.join(canvasDir, canvas))) {
        throw new Error(`npm did not install @napi-rs/${canvas}, the canvas build for this machine.`);
      }
      for (const name of unreviewedCanvas(staging)) rmSync(path.join(canvasDir, name), { recursive: true, force: true });
      writeFileSync(path.join(staging, READY_MARKER), `${manifest.digest}\n`);
      // If another installer finished the same payload meanwhile, keep its
      // copy: a server may already be running from it.
      if (existsSync(ready)) {
        rmSync(staging, { recursive: true, force: true });
        return target;
      }
      rmSync(target, { recursive: true, force: true });
      renameWithRetry(staging, target);
    } catch (error) {
      rmSync(staging, { recursive: true, force: true });
      throw error;
    }

    pruneRuntimes(runtimeRoot, path.basename(target));
    return target;
  } finally {
    rmSync(lockDir, { recursive: true, force: true });
  }
}

// The installer runs detached, so stopping this launcher does not stop it.
// Its output goes to a log file rather than a pipe, which would break if this
// launcher went away mid-install.
function spawnInstaller(runtimeRoot, logFile) {
  mkdirSync(runtimeRoot, { recursive: true });
  const fd = logFile ? openSync(logFile, "w") : "ignore";
  try {
    return spawn(process.execPath, [fileURLToPath(import.meta.url), "--prepare-now"], {
      detached: true,
      stdio: ["ignore", fd, fd],
      windowsHide: true,
      env: process.env,
    });
  } finally {
    if (typeof fd === "number") closeSync(fd);
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
  const dataDir = dataDirectory();
  let manifest;
  try {
    manifest = readPayload();
  } catch (error) {
    log(error.message);
    process.exit(1);
  }
  const { runtimeRoot, target, ready } = runtimePaths(dataDir, manifest);

  // SessionStart hook: never hold up the session.
  if (process.argv.includes("--prepare")) {
    if (!existsSync(ready)) spawnInstaller(runtimeRoot, null).unref();
    return;
  }
  // The detached installer itself.
  if (process.argv.includes("--prepare-now")) {
    try {
      install(dataDir, manifest);
    } catch (error) {
      log(error.message);
      process.exit(1);
    }
    return;
  }

  if (existsSync(ready)) {
    startServer(target, dataDir);
    return;
  }
  log("First run for this version: installing locked dependencies (one time, about 45 MB download)…");
  const logFile = path.join(runtimeRoot, `.install-${process.pid}.log`);
  const installer = spawnInstaller(runtimeRoot, logFile);
  installer.on("error", error => { log(`could not start the installer: ${error.message}`); process.exit(1); });
  installer.on("exit", code => {
    let output = "";
    try { output = readFileSync(logFile, "utf8"); } catch {}
    rmSync(logFile, { force: true });
    if (code === 0 && existsSync(ready)) {
      log("Dependencies installed.");
      startServer(target, dataDir);
      return;
    }
    if (output) process.stderr.write(output);
    log("The first-run install did not finish. Fix the problem above and reconnect PDF Tools.");
    process.exit(1);
  });
}

// Run only as a script, so tests can import the helpers above.
function invokedDirectly() {
  try {
    return Boolean(process.argv[1]) && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
}

if (invokedDirectly()) main();
