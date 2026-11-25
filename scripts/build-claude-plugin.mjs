// Build the PDF Tools Claude plugin: one listing for every Claude surface.
//
//   claude.ai and the Claude apps   -> the hosted connector (remote MCP)
//   Claude Code and local Cowork    -> the full local server, plus the hosted connector
//   everywhere                      -> the pdf-tools and pdf-tools-workflow skills
//
// Unlike the Agent Plugins build (scripts/build-agent-plugin.mjs), this bundle
// carries no node_modules. The Claude directory stops validating a repository
// over 50 MiB and holds any non-text binary for review, and the vendored
// production graph is ~177 MB because it carries five native canvas builds.
// Instead the bundle ships the same first-party source the MCPB ships
// (copyRuntimeSource) with package.json and package-lock.json, and
// runtime/start.mjs installs the locked graph into ${CLAUDE_PLUGIN_DATA} on
// first run. npm then fetches only this machine's canvas build, which is also
// what lets each supported platform work without shipping every build.
//
// Usage: node scripts/build-claude-plugin.mjs [output-dir] [--no-smoke] [--marketplace <owner>/<repo>]
//   default output: dist-plugin/claude-pdf-tools
//   --marketplace adds the README's install line for the repository that
//   lists the plugin. Leave it out until that repository is decided.

import { createHash } from "node:crypto";
import { spawn, spawnSync } from "node:child_process";
import {
  cpSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { copyRuntimeSource } from "./build-mcpb.mjs";
import { derivePluginVersion } from "./plugin-version.mjs";

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(SCRIPT_DIR, "..");
const CLAUDE_SOURCE = path.join(SCRIPT_DIR, "claude-plugin");
const WORKFLOW_SKILL = path.join(REPO_ROOT, "plugins", "pdf-tools-workflow", "skills", "pdf-tools-workflow", "SKILL.md");
const PACKAGE_JSON = JSON.parse(readFileSync(path.join(REPO_ROOT, "package.json"), "utf8"));

export const PLUGIN_NAME = "pdf-tools";
export const HOSTED_URL = "https://mcp.opendocuments.ai/mcp";

// Remote connectors this plugin references, keyed by the server name Claude
// shows. Another remote connector is one more entry here, so the README, the
// .mcp.json and the tests all follow from one list.
export const REMOTE_CONNECTORS = Object.freeze([
  Object.freeze({ name: "pdf-tools-hosted", url: HOSTED_URL, operator: "Open Document Alliance" }),
]);

const DESCRIPTION =
  "Read, search, convert, fill, merge, split, rotate and compare PDFs. Chat uses the hosted service, which processes each request without storing documents; Claude Code and local Cowork also get the full local server, which keeps files on your machine.";

// Files that are part of the plugin's own surface, not the server payload.
const PLUGIN_SURFACE = new Set([".claude-plugin", ".mcp.json", "hooks", "skills", "runtime", "README.md", "assets"]);

// Directory limits from https://claude.com/docs/plugins/pre-submission-checklist.md
const LIMITS = Object.freeze({
  maxFiles: 512,
  maxTextBytes: 256 * 1024,
  maxAnyFileBytes: 5 * 1024 * 1024,
  imageOrFont: /\.(png|jpe?g|gif|webp|svg|woff2?|ttf|otf)$/i,
  reservedWindowsNames: /^(con|prn|aux|nul|com[0-9]|lpt[0-9])(\..*)?$/i,
  junk: new Set([".DS_Store", "Thumbs.db", "desktop.ini", "__MACOSX"]),
});

function run(command, args, options = {}) {
  const result = spawnSync(command, args, { cwd: REPO_ROOT, stdio: "inherit", ...options });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`${command} ${args.join(" ")} exited ${result.status}`);
}

function walk(root, relative = "") {
  const out = [];
  for (const entry of readdirSync(path.join(root, relative), { withFileTypes: true })) {
    const rel = relative ? `${relative}/${entry.name}` : entry.name;
    if (entry.isSymbolicLink()) throw new Error(`symlink in plugin: ${rel}`);
    if (entry.isDirectory()) out.push(...walk(root, rel));
    else if (entry.isFile()) out.push(rel);
    else throw new Error(`special file in plugin: ${rel}`);
  }
  return out.sort();
}

function sha256File(file) {
  return createHash("sha256").update(readFileSync(file)).digest("hex");
}

export function pluginManifest(version) {
  return {
    name: PLUGIN_NAME,
    displayName: "PDF Tools",
    version,
    description: DESCRIPTION,
    author: { name: "Open Document Alliance", url: "https://www.opendocuments.ai" },
    homepage: "https://github.com/Open-Document-Alliance/PDF-Tools",
    repository: "https://github.com/Open-Document-Alliance/PDF-Tools",
    license: "MIT",
    // 1024x1024 PNG. The portal takes the listing icon from this file only the
    // first time the plugin is saved or submitted, so it must be right then.
    icon: "assets/icon.png",
    privacyPolicyUrl: "https://www.opendocuments.ai/privacy-policy",
    // Every fixed host any part of the plugin can reach; README.md says when.
    // fetch_pdf_from_url also reaches the URL the user supplies.
    network: {
      hosts: [
        ...REMOTE_CONNECTORS.map(connector => new URL(connector.url).hostname),
        "registry.npmjs.org",
        "auth.luminpdf.com",
        "api.luminpdf.com",
      ],
    },
    keywords: ["pdf", "forms", "documents", "markdown", "signature", "extraction"],
  };
}

export function mcpConfig() {
  const servers = {
    // A plain file run with plain arguments, rooted at ${CLAUDE_PLUGIN_ROOT}:
    // the shape the directory validator can follow without a reviewer.
    "pdf-tools": { command: "node", args: ["${CLAUDE_PLUGIN_ROOT}/runtime/start.mjs"] },
  };
  for (const connector of REMOTE_CONNECTORS) servers[connector.name] = { type: "http", url: connector.url };
  return { mcpServers: servers };
}

export function hooksConfig() {
  return {
    hooks: {
      SessionStart: [
        { hooks: [{ type: "command", command: "node \"${CLAUDE_PLUGIN_ROOT}/runtime/start.mjs\" --prepare" }] },
      ],
    },
  };
}

// Checks the parts of the pre-submission checklist that `claude plugin
// validate` does not: file count, sizes, names, junk files, README length.
// Returns { blocks, held } so the build can fail on blocks and report holds.
export function directoryCheck(pluginDir) {
  const blocks = [];
  const held = [];
  const files = walk(pluginDir);
  if (files.length > LIMITS.maxFiles) held.push(`${files.length} files (more than ${LIMITS.maxFiles})`);
  const lowerSeen = new Map();
  for (const rel of files) {
    const size = statSync(path.join(pluginDir, rel)).size;
    for (const part of rel.split("/")) {
      if (LIMITS.junk.has(part)) blocks.push(`junk file: ${rel}`);
      if (/[:<>"|?*]/.test(part) || /[. ]$/.test(part) || LIMITS.reservedWindowsNames.test(part)) {
        blocks.push(`name not valid on Windows: ${rel}`);
      }
    }
    const lower = rel.toLowerCase();
    if (lowerSeen.has(lower)) blocks.push(`names differ only by case: ${rel} / ${lowerSeen.get(lower)}`);
    lowerSeen.set(lower, rel);
    if (size > LIMITS.maxAnyFileBytes) blocks.push(`over 5 MiB: ${rel} (${size} bytes)`);
    else if (!LIMITS.imageOrFont.test(rel) && size > LIMITS.maxTextBytes) held.push(`over 256 KiB: ${rel} (${size} bytes)`);
    if (!LIMITS.imageOrFont.test(rel) && /\.(wasm|node|exe|dll|so|dylib|zip|pdf|ico)$/i.test(rel)) held.push(`binary: ${rel}`);
    if (/(^|\/)\.npmrc$|(^|\/)bunfig\.toml$|(^|\/)uv\.toml$/.test(rel)) blocks.push(`package-manager config: ${rel}`);
  }
  if (existsSync(path.join(pluginDir, "bin"))) blocks.push("top-level bin/ stops claude.ai and Cowork from installing the plugin");
  const readme = readFileSync(path.join(pluginDir, "README.md"), "utf8").replace(/```[\s\S]*?```/g, "");
  const words = readme.split(/\s+/).filter(Boolean).length;
  if (words < 40) blocks.push(`README has ${words} words outside code blocks (needs 40)`);
  if (existsSync(path.join(pluginDir, "package.json")) && existsSync(path.join(pluginDir, "package-lock.json"))) {
    held.push("package.json beside package-lock.json (dependencies install from a lockfile)");
  }
  return { blocks, held, files: files.length };
}

function smoke(pluginDir) {
  const dataDir = mkdtempSync(path.join(tmpdir(), "pdf-tools-claude-data-"));
  const started = Date.now();
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [path.join(pluginDir, "runtime", "start.mjs")], {
      cwd: dataDir,
      env: { PATH: process.env.PATH, HOME: process.env.HOME, CLAUDE_PLUGIN_ROOT: pluginDir, CLAUDE_PLUGIN_DATA: dataDir },
      stdio: ["pipe", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    const done = (error, value) => {
      clearTimeout(timer);
      child.kill("SIGKILL");
      rmSync(dataDir, { recursive: true, force: true });
      if (error) reject(error); else resolve(value);
    };
    const timer = setTimeout(() => done(new Error(`smoke timed out.\nstderr:\n${stderr.slice(-2000)}`)), 180000);
    child.stdout.on("data", chunk => {
      stdout += chunk;
      // Only complete lines: a chunk can end part-way through a message.
      for (const line of stdout.split("\n").slice(0, -1)) {
        if (!line.includes('"id":2')) continue;
        const message = JSON.parse(line);
        const tools = message.result?.tools ?? [];
        done(null, { tools: tools.length, seconds: (Date.now() - started) / 1000, stderr });
        return;
      }
    });
    child.stderr.on("data", chunk => { stderr += chunk; });
    child.on("exit", code => { if (!stdout.includes('"id":2')) done(new Error(`exited ${code} before listing tools.\nstderr:\n${stderr.slice(-2000)}`)); });
    const send = message => child.stdin.write(`${JSON.stringify(message)}\n`);
    send({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-11-25", capabilities: {}, clientInfo: { name: "claude-plugin-smoke", version: "1" } } });
    send({ jsonrpc: "2.0", method: "notifications/initialized" });
    send({ jsonrpc: "2.0", id: 2, method: "tools/list", params: {} });
  });
}

// The listing README: the source README with the icon under the title and,
// once the listing repository is known, an Install section naming it.
export function pluginReadme(source, marketplace = null) {
  let readme = source.replace(/^# PDF Tools\n/, "# PDF Tools\n\n![PDF Tools](assets/icon.png)\n");
  if (marketplace === null) return readme;
  if (!/^[A-Za-z0-9-]+\/[A-Za-z0-9._-]+$/.test(marketplace)) throw new Error(`--marketplace must be <owner>/<repo>, got ${marketplace}`);
  const install = [
    "## Install",
    "",
    "In Claude Code:",
    "",
    "```",
    `/plugin install ${PLUGIN_NAME} --marketplace ${marketplace}`,
    "```",
    "",
    "In claude.ai, the Claude apps and Cowork, add PDF Tools from the Claude directory.",
    "",
    "",
  ].join("\n");
  const at = readme.indexOf("\n## ");
  if (at === -1) throw new Error("plugin README has no section to put Install before");
  return `${readme.slice(0, at + 1)}${install}${readme.slice(at + 1)}`;
}

export function parseBuildArgs(args) {
  let marketplace = null;
  let smoke = true;
  const positional = [];
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === "--no-smoke") smoke = false;
    else if (arg === "--marketplace") {
      marketplace = args[index + 1];
      if (!marketplace || marketplace.startsWith("--")) throw new Error("--marketplace needs <owner>/<repo>");
      index += 1;
    } else if (arg.startsWith("--")) throw new Error(`unknown option ${arg}`);
    else positional.push(arg);
  }
  if (positional.length > 1) throw new Error(`expected at most one output folder, got ${positional.join(" ")}`);
  return {
    outputDir: path.resolve(positional[0] || path.join(REPO_ROOT, "dist-plugin", `claude-${PLUGIN_NAME}`)),
    marketplace,
    smoke,
  };
}

async function main() {
  const args = process.argv.slice(2);
  const { outputDir, marketplace, smoke: runSmoke } = parseBuildArgs(args);
  const version = derivePluginVersion(PACKAGE_JSON.version, { cwd: REPO_ROOT }).version;
  console.error(`[claude-plugin] building ${PLUGIN_NAME}@${version} -> ${outputDir}`);

  run(process.platform === "win32" ? "npm.cmd" : "npm", ["run", "build:ui"]);
  const stage = mkdtempSync(path.join(tmpdir(), "pdf-tools-claude-plugin-"));
  try {
    copyRuntimeSource(stage, { includeMcpbManifest: false });
    // The MCPB copies the icon to the root for its manifest. Here it is a
    // listing image, shown in the README as the checklist asks.
    rmSync(path.join(stage, "icon.png"));
    mkdirSync(path.join(stage, "assets"));
    cpSync(path.join(REPO_ROOT, "icon.png"), path.join(stage, "assets", "icon.png"));

    // Server payload: everything copied so far except the listing image.
    // README.md is replaced below by the plugin README, so it is not payload.
    const payloadFiles = walk(stage).filter(rel => !PLUGIN_SURFACE.has(rel.split("/")[0]));
    rmSync(path.join(stage, "README.md"), { force: true });
    const payload = payloadFiles.filter(rel => rel !== "README.md").map(rel => ({ path: rel, sha256: sha256File(path.join(stage, rel)) }));
    const digest = createHash("sha256").update(JSON.stringify(payload)).digest("hex");

    mkdirSync(path.join(stage, ".claude-plugin"));
    writeFileSync(path.join(stage, ".claude-plugin", "plugin.json"), `${JSON.stringify(pluginManifest(version), null, 2)}\n`);
    writeFileSync(path.join(stage, ".mcp.json"), `${JSON.stringify(mcpConfig(), null, 2)}\n`);
    mkdirSync(path.join(stage, "hooks"));
    writeFileSync(path.join(stage, "hooks", "hooks.json"), `${JSON.stringify(hooksConfig(), null, 2)}\n`);
    mkdirSync(path.join(stage, "runtime"));
    cpSync(path.join(CLAUDE_SOURCE, "runtime", "start.mjs"), path.join(stage, "runtime", "start.mjs"));
    writeFileSync(path.join(stage, "runtime", "payload.json"), `${JSON.stringify({ version: 1, plugin: version, digest, files: payload }, null, 2)}\n`);
    mkdirSync(path.join(stage, "skills", "pdf-tools"), { recursive: true });
    cpSync(path.join(CLAUDE_SOURCE, "skills", "pdf-tools", "SKILL.md"), path.join(stage, "skills", "pdf-tools", "SKILL.md"));
    mkdirSync(path.join(stage, "skills", "pdf-tools-workflow"), { recursive: true });
    cpSync(WORKFLOW_SKILL, path.join(stage, "skills", "pdf-tools-workflow", "SKILL.md"));
    writeFileSync(path.join(stage, "README.md"), pluginReadme(readFileSync(path.join(CLAUDE_SOURCE, "README.md"), "utf8"), marketplace));

    for (const rel of walk(stage)) {
      if (lstatSync(path.join(stage, rel)).isSymbolicLink()) throw new Error(`symlink: ${rel}`);
    }
    const check = directoryCheck(stage);
    if (check.blocks.length) throw new Error(`directory checklist blocks:\n  ${check.blocks.join("\n  ")}`);

    rmSync(outputDir, { recursive: true, force: true });
    mkdirSync(path.dirname(outputDir), { recursive: true });
    cpSync(stage, outputDir, { recursive: true });
    console.error(`[claude-plugin] ${check.files} files; payload digest ${digest.slice(0, 16)}`);
    for (const item of check.held) console.error(`[claude-plugin] held for a reviewer: ${item}`);

    if (runSmoke) {
      console.error("[claude-plugin] smoke: first-run install into an empty data folder, then tools/list…");
      const result = await smoke(outputDir);
      console.error(`[claude-plugin] smoke: ${result.tools} tools listed after ${result.seconds.toFixed(1)} s (includes the install)`);
    }
  } finally {
    rmSync(stage, { recursive: true, force: true });
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch(error => {
    console.error(`[claude-plugin] build failed: ${error.message}`);
    process.exit(1);
  });
}
