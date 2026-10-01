// Build a self-contained Agent Plugins 1.0.0 plugin directory.
//
// The plugin is a directory that carries the server and its locked
// dependencies, launched through a plugin-owned Node resolver with no npm, no
// npx, and no install step on the host. It reuses the MCPB build's staging
// verbatim —
// locked production deps, integrity-verified native canvas packages, a secret
// scan, and a symlink ban — so the two artifacts cannot drift. On top of that
// stage it drops a root `plugin.json`, an `mcp.json`, and the workflow skill,
// and removes the MCPB-only `manifest.json`.
//
// Usage: node scripts/build-agent-plugin.mjs [output-dir]
//   default output: dist-plugin/pdf-tools
//
// Coverage: this ships the same five native canvas platforms the MCPB ships,
// so rasterization works everywhere the MCPB does. A smaller no-render variant
// is a planned build flag, not yet implemented.

import {
  chmodSync,
  cpSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { spawn } from "child_process";
import { prepareCleanStage } from "./build-mcpb.mjs";
import { derivePluginVersion } from "./plugin-version.mjs";
import { createOpenAIPluginMetadata } from "./openai-plugin-metadata.mjs";

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(SCRIPT_DIR, "..");
const SKILLS_SOURCE = path.join(REPO_ROOT, "plugins", "pdf-tools-workflow", "skills");
const LAUNCHERS_SOURCE = path.join(REPO_ROOT, "scripts", "agent-plugin-launchers");
const PACKAGE_JSON = JSON.parse(
  (await import("fs")).readFileSync(path.join(REPO_ROOT, "package.json"), "utf8"),
);

// The version a host displays must identify the bytes, not the last release.
//
// package.json only moves at release time, so every publish between releases
// claimed the previous version while carrying different server code. That is not
// hypothetical: the published plugin read 0.10.0 while built from ffe9130, which
// is 86 commits past that tag and includes a signalled-shutdown behaviour change.
// PROVENANCE.md recorded the truth, but nothing a host shows the user did.
//
// Build metadata after "+" is valid semver and is ignored for version precedence,
// so a build made at a tag still reads 0.11.0 while one made after it reads
// 0.11.0+94.g4953297.
//
// The count is git describe's, which means commits since the tag along its
// default walk. `rev-list --count` and `--first-parent` answer different
// questions and give different numbers for the same pair, so the measure is
// named here rather than left for someone to guess.
//
// The grammar itself lives in ./plugin-version.mjs, because the publisher has to
// read these strings back and decide whether a build belongs to the tree it is
// about to stamp. Two independent readings of one grammar is how they drift.
const PLUGIN_VERSION = derivePluginVersion(PACKAGE_JSON.version, {
  cwd: REPO_ROOT,
  onUnavailable: () =>
    console.error(
      "[plugin] git describe unavailable, version falls back to package.json. "
        + "In CI this usually means the checkout needs fetch-depth: 0.",
    ),
}).version;

const PLUGIN_MANIFEST_NAME = "pdf-tools";
// Leads with the words a person actually types. A user asking to "open a PDF"
// was told the assistant had no filesystem access, while this server was
// installed and holding 43 tools that do exactly that: the host matches a
// request against this string before any tool is loaded, and the previous
// wording ("inspect, fill, sign, merge...") shared no words with the request.
const PLUGIN_DESCRIPTION =
  "Open PDFs on your computer and work with them: read and search, fill and sign forms, extract data, merge, split, and compare. File operations stay local; content returned to your host follows its data terms.";

const PLUGIN_MANIFEST = {
  $schema: "https://agent-plugins.org/schemas/1.0.0/plugin.schema.json",
  name: PLUGIN_MANIFEST_NAME,
  version: PLUGIN_VERSION,
  description: PLUGIN_DESCRIPTION,
  author: {
    name: "Open Document Alliance",
    url: "https://www.opendocuments.ai",
  },
  // The install-facing page, not the source tree: this is what a plugin
  // browser links to, and the reader has just installed and needs the
  // first-run and troubleshooting notes.
  homepage: "https://github.com/Open-Document-Alliance/pdf-tools-plugin",
  repository: "https://github.com/Open-Document-Alliance/PDF-Tools",
  license: "MIT",
  keywords: ["pdf", "forms", "signature", "extraction", "accessibility", "mcp"],
  extensions: {
    "com.openai": createOpenAIPluginMetadata(),
  },
};

// The Agent Plugins manifest schema is closed and carries no icon or
// presentation field, so a plugin shipping only `plugin.json` renders in a
// host's plugin browser with a placeholder icon, no description, and an empty
// website field. That metadata belongs in a namespaced sibling manifest.
// Measured against the 180 plugins in OpenAI's curated marketplace on
// 2026-08-09: 179 set `interface.logo` and 177 set `interface.composerIcon`,
// PNG in 167 and 150 cases. This follows that convention rather than inventing
// one, and it is emitted here so a release cannot silently drop it.
const CODEX_MANIFEST = {
  name: PLUGIN_MANIFEST_NAME,
  version: PLUGIN_VERSION,
  description: PLUGIN_DESCRIPTION,
  author: { name: "Open Document Alliance", url: "https://www.opendocuments.ai" },
  homepage: "https://github.com/Open-Document-Alliance/pdf-tools-plugin",
  repository: "https://github.com/Open-Document-Alliance/PDF-Tools",
  license: "MIT",
  keywords: ["pdf", "forms", "signature", "extraction", "accessibility", "mcp"],
  skills: "./skills/",
  mcpServers: "./mcp.json",
  ...createOpenAIPluginMetadata(),
};

const MCP_CONFIG = {
  $schema: "https://agent-plugins.org/schemas/1.0.0/mcp.schema.json",
  mcpServers: {
    "pdf-tools": {
      type: "stdio",
      // Codex and other GUI-launched hosts may sanitize PATH. The contained
      // launcher resolves a compatible runtime from PATH or the user's Node
      // version manager without depending on shell startup files. Codex adds
      // `.cmd` through PATHEXT on Windows and executes this file directly on
      // POSIX hosts, so the same manifest remains portable.
      command: "./bin/pdf-tools-launch",
      args: [],
      cwd: "${PLUGIN_ROOT}",
    },
  },
};

function directoryStats(root) {
  let files = 0;
  let bytes = 0;
  const walk = (dir) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.isFile()) { files += 1; bytes += statSync(full).size; }
    }
  };
  walk(root);
  return { files, bytes };
}

function expandPluginValue(value, pluginDir) {
  return value.replaceAll("${PLUGIN_ROOT}", pluginDir);
}

function pluginLaunchCommand(pluginDir) {
  const config = JSON.parse(readFileSync(path.join(pluginDir, "mcp.json"), "utf8"));
  const server = config?.mcpServers?.["pdf-tools"];
  if (!server || server.type !== "stdio") {
    throw new Error("built mcp.json does not contain the pdf-tools stdio server");
  }
  if (typeof server.command !== "string" || !server.command.startsWith("./")) {
    throw new Error("built mcp.json must use a contained ./ launcher command");
  }
  let command = path.resolve(pluginDir, server.command.slice(2));
  if (!command.startsWith(`${path.resolve(pluginDir)}${path.sep}`)) {
    throw new Error("built mcp.json launcher command escapes the plugin directory");
  }
  if (process.platform === "win32" && existsSync(`${command}.cmd`)) command += ".cmd";
  const args = (server.args ?? []).map(value => expandPluginValue(value, pluginDir));
  const cwd = expandPluginValue(server.cwd ?? "${PLUGIN_ROOT}", pluginDir);
  return { command, args, cwd };
}

// Launch the built server through the command in its generated mcp.json and
// confirm it lists tools. This proves the package's real startup path works —
// including the plugin-owned runtime resolver — rather than bypassing that
// path with the Node executable that happened to run this build.
function smokeLaunch(pluginDir) {
  return new Promise((resolve, reject) => {
    const { command, args, cwd } = pluginLaunchCommand(pluginDir);
    const coreEnvironmentNames = [
      "HOME", "LOGNAME", "PATH", "SHELL", "USER", "LANG", "LC_ALL", "TERM", "TMPDIR", "TZ",
      "PATHEXT", "COMSPEC", "SYSTEMROOT", "SYSTEMDRIVE", "USERNAME", "USERDOMAIN", "USERPROFILE",
      "HOMEDRIVE", "HOMEPATH", "PROGRAMFILES", "PROGRAMFILES(X86)", "PROGRAMW6432", "PROGRAMDATA",
      "LOCALAPPDATA", "APPDATA", "TEMP", "TMP", "POWERSHELL", "PWSH",
    ];
    const env = Object.fromEntries(coreEnvironmentNames.flatMap(name => (
      process.env[name] === undefined ? [] : [[name, process.env[name]]]
    )));
    const child = spawn(command, args, {
      cwd,
      // The smoke environment has no PLUGIN_DATA, so it exercises the generic
      // stdio fail-closed posture. Agent Plugin hosts supply PLUGIN_DATA and get
      // the private import workspace covered by the runtime tests.
      env,
      stdio: ["pipe", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => { child.kill("SIGKILL"); reject(new Error("smoke launch timed out")); }, 20000);
    child.stdout.on("data", (chunk) => {
      stdout += chunk.toString();
      if (stdout.includes('"tools"')) {
        clearTimeout(timer);
        child.kill("SIGKILL");
        resolve({ ok: true });
      }
    });
    child.stderr.on("data", (chunk) => { stderr += chunk.toString(); });
    child.on("error", (error) => { clearTimeout(timer); reject(error); });
    child.on("exit", (code) => {
      clearTimeout(timer);
      if (!stdout.includes('"tools"')) {
        reject(new Error(`server exited (code ${code}) without listing tools.\nstderr:\n${stderr.slice(0, 2000)}`));
      }
    });
    // JSON-RPC: initialize, then tools/list.
    const initialize = {
      jsonrpc: "2.0", id: 1, method: "initialize",
      params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "plugin-smoke", version: "1.0.0" } },
    };
    child.stdin.write(JSON.stringify(initialize) + "\n");
    child.stdin.write(JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }) + "\n");
    child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/list", params: {} }) + "\n");
  });
}

async function main() {
  const outputDir = path.resolve(process.argv[2] || path.join(REPO_ROOT, "dist-plugin", "pdf-tools"));
  console.error(`[plugin] building Agent Plugins bundle → ${outputDir}`);

  if (!existsSync(SKILLS_SOURCE)) {
    throw new Error(`workflow skills not found at ${SKILLS_SOURCE}`);
  }
  if (!existsSync(LAUNCHERS_SOURCE)) {
    throw new Error(`Agent Plugin launchers not found at ${LAUNCHERS_SOURCE}`);
  }

  const { stagingDir } = prepareCleanStage();
  try {
    // The stage is the verified MCPB payload. Convert it to a plugin:
    // drop the MCPB manifest, add the Agent Plugins manifests and the skill.
    rmSync(path.join(stagingDir, "manifest.json"), { force: true });
    writeFileSync(path.join(stagingDir, "plugin.json"), JSON.stringify(PLUGIN_MANIFEST, null, 2) + "\n");
    writeFileSync(path.join(stagingDir, "mcp.json"), JSON.stringify(MCP_CONFIG, null, 2) + "\n");
    cpSync(SKILLS_SOURCE, path.join(stagingDir, "skills"), { recursive: true });
    cpSync(LAUNCHERS_SOURCE, path.join(stagingDir, "bin"), { recursive: true });
    // Git preserves this bit on Unix, but the builder makes the artifact
    // invariant explicit. Windows ignores the Unix mode and resolves the
    // adjacent `.cmd` file instead.
    chmodSync(path.join(stagingDir, "bin", "pdf-tools-launch"), 0o755);
    chmodSync(path.join(stagingDir, "bin", "check-node-version.cjs"), 0o644);
    chmodSync(path.join(stagingDir, "bin", "pdf-tools-launch.cmd"), 0o644);

    // Listing presentation for hosts that read a namespaced sibling manifest.
    const iconSource = path.join(REPO_ROOT, "icon.png");
    if (!existsSync(iconSource)) throw new Error(`plugin icon not found at ${iconSource}`);
    mkdirSync(path.join(stagingDir, "assets"), { recursive: true });
    cpSync(iconSource, path.join(stagingDir, "assets", "pdf-tools.png"));
    mkdirSync(path.join(stagingDir, ".codex-plugin"), { recursive: true });
    writeFileSync(
      path.join(stagingDir, ".codex-plugin", "plugin.json"),
      JSON.stringify(CODEX_MANIFEST, null, 2) + "\n",
    );

    console.error("[plugin] smoke-launching the staged server over stdio…");
    await smokeLaunch(stagingDir);
    console.error("[plugin] server listed tools from its own directory.");

    rmSync(outputDir, { recursive: true, force: true });
    mkdirSync(path.dirname(outputDir), { recursive: true });
    cpSync(stagingDir, outputDir, { recursive: true });

    const { files, bytes } = directoryStats(outputDir);
    console.error(`[plugin] done: ${files} files, ${(bytes / 1024 / 1024).toFixed(1)} MB uncompressed`);
    console.error(`[plugin] layout: plugin.json, mcp.json, .codex-plugin/, assets/, bin/, server/, skills/, node_modules/, dist-ui/`);
    console.error(`[plugin] note: a fresh install uses \${PLUGIN_DATA}/workspace as a private import workspace.`);
    console.error(`[plugin]       Optional direct folder access is configured in \${PLUGIN_DATA}/config.json.`);
  } finally {
    rmSync(stagingDir, { recursive: true, force: true });
  }
}

main().catch((error) => {
  console.error(`[plugin] build failed: ${error.message}`);
  process.exit(1);
});
