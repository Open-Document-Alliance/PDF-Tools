// The Claude plugin bundle: its generated config, and the first-run launcher.
//
// The config tests pin the shapes the Claude directory's pre-submission
// checklist accepts without a block: a local server started as a plain file
// rooted at ${CLAUDE_PLUGIN_ROOT}, https remote connectors, no top-level bin/.
// The launcher tests run runtime/start.mjs against a stub server with no
// dependencies, so they need no network and no native canvas.

import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";

import {
  HOSTED_URL,
  REMOTE_CONNECTORS,
  directoryCheck,
  hooksConfig,
  mcpConfig,
  pluginManifest,
} from "../scripts/build-claude-plugin.mjs";

const REPO_ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const LAUNCHER = path.join(REPO_ROOT, "scripts", "claude-plugin", "runtime", "start.mjs");
const temporary = [];

function tempDir(prefix) {
  const dir = mkdtempSync(path.join(tmpdir(), prefix));
  temporary.push(dir);
  return dir;
}

afterEach(() => {
  while (temporary.length) rmSync(temporary.pop(), { recursive: true, force: true });
});

describe("Claude plugin config", () => {
  it("keeps the permanent name and the directory-required fields", () => {
    const manifest = pluginManifest("1.2.3");
    expect(manifest.name).toBe("pdf-tools");
    expect(manifest.name).toMatch(/^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$/);
    expect(manifest).toMatchObject({ version: "1.2.3", license: "MIT", icon: "assets/icon.png" });
    expect(manifest.author.name).toBe("Open Document Alliance");
    expect(manifest.network.hosts).toEqual(expect.arrayContaining(["mcp.opendocuments.ai", "registry.npmjs.org"]));
  });

  it("starts the local server as a plain plugin file and every remote over https", () => {
    const { mcpServers } = mcpConfig();
    expect(mcpServers["pdf-tools"]).toEqual({ command: "node", args: ["${CLAUDE_PLUGIN_ROOT}/runtime/start.mjs"] });
    expect(mcpServers["pdf-tools-hosted"]).toEqual({ type: "http", url: HOSTED_URL });
    for (const connector of REMOTE_CONNECTORS) {
      expect(new URL(connector.url).protocol).toBe("https:");
      expect(mcpServers[connector.name].url).toBe(connector.url);
    }
  });

  it("prepares from a SessionStart hook rooted at the plugin", () => {
    const [entry] = hooksConfig().hooks.SessionStart;
    expect(entry.hooks).toEqual([{ type: "command", command: "node \"${CLAUDE_PLUGIN_ROOT}/runtime/start.mjs\" --prepare" }]);
  });

  it("blocks what the directory blocks", () => {
    const dir = tempDir("claude-plugin-check-");
    writeFileSync(path.join(dir, "README.md"), "too short");
    mkdirSync(path.join(dir, "bin"));
    writeFileSync(path.join(dir, "bin", "run"), "");
    writeFileSync(path.join(dir, ".DS_Store"), "");
    const { blocks } = directoryCheck(dir);
    expect(blocks.join("\n")).toMatch(/README has 2 words/);
    expect(blocks.join("\n")).toMatch(/top-level bin\//);
    expect(blocks.join("\n")).toMatch(/junk file: \.DS_Store/);
  });
});

// A minimal plugin root: the real launcher plus a stub server that answers
// one line on stdin with one line on stdout, and reports PLUGIN_DATA.
function stubPlugin() {
  const root = tempDir("claude-plugin-root-");
  mkdirSync(path.join(root, "runtime"));
  cpSync(LAUNCHER, path.join(root, "runtime", "start.mjs"));
  mkdirSync(path.join(root, "server"));
  writeFileSync(path.join(root, "server", "index.js"),
    "process.stdin.once('data', () => { process.stdout.write(JSON.stringify({ ok: true, data: process.env.PLUGIN_DATA, cwd: process.cwd() }) + '\\n'); process.exit(0); });\n");
  writeFileSync(path.join(root, "package.json"), JSON.stringify({ name: "stub", version: "1.0.0", type: "module", dependencies: {} }));
  writeFileSync(path.join(root, "package-lock.json"), JSON.stringify({
    name: "stub", version: "1.0.0", lockfileVersion: 3, requires: true,
    packages: { "": { name: "stub", version: "1.0.0", dependencies: {} } },
  }));
  const files = ["package-lock.json", "package.json", "server/index.js"].map(rel => ({
    path: rel,
    sha256: createHash("sha256").update(readFileSync(path.join(root, rel))).digest("hex"),
  }));
  const digest = createHash("sha256").update(JSON.stringify(files)).digest("hex");
  writeFileSync(path.join(root, "runtime", "payload.json"), JSON.stringify({ version: 1, plugin: "test", digest, files }));
  return { root, digest };
}

function launch(root, dataDir, args = []) {
  return spawnSync(process.execPath, [path.join(root, "runtime", "start.mjs"), ...args], {
    input: "{}\n",
    encoding: "utf8",
    env: { PATH: process.env.PATH, HOME: process.env.HOME, CLAUDE_PLUGIN_DATA: dataDir, npm_config_cache: path.join(dataDir, ".npm-cache") },
    timeout: 60000,
  });
}

describe("Claude plugin launcher", () => {
  it("installs into the data folder once, then starts the server with stdout clean", () => {
    const { root, digest } = stubPlugin();
    const data = tempDir("claude-plugin-data-");

    const first = launch(root, data);
    expect(first.status, first.stderr).toBe(0);
    const reply = JSON.parse(first.stdout.trim());
    const runtime = path.join(data, "runtime", digest.slice(0, 16));
    expect(reply).toEqual({ ok: true, data: path.resolve(data), cwd: runtime });
    expect(first.stderr).toMatch(/First run for this version/);
    expect(existsSync(path.join(runtime, ".pdf-tools-ready"))).toBe(true);

    const second = launch(root, data);
    expect(second.status, second.stderr).toBe(0);
    expect(second.stderr).not.toMatch(/First run/);
    expect(JSON.parse(second.stdout.trim()).ok).toBe(true);
  });

  it("refuses a payload that does not match its manifest", () => {
    const { root } = stubPlugin();
    const data = tempDir("claude-plugin-data-");
    writeFileSync(path.join(root, "server", "index.js"), "process.stdout.write('tampered\\n');\n");
    const result = launch(root, data);
    expect(result.status).toBe(1);
    expect(result.stdout).toBe("");
    expect(result.stderr).toMatch(/payload file does not match its manifest: server\/index\.js/);
  });

  it("installs a new runtime per payload and keeps only the previous one", () => {
    const data = tempDir("claude-plugin-data-");
    const runtimes = () => readdirSync(path.join(data, "runtime")).filter(name => !name.startsWith(".")).sort();
    const version = n => {
      const plugin = stubPlugin();
      writeFileSync(path.join(plugin.root, "server", "index.js"),
        `process.stdin.once('data', () => { process.stdout.write('{"v":${n}}\\n'); process.exit(0); });\n`);
      const files = JSON.parse(readFileSync(path.join(plugin.root, "runtime", "payload.json"), "utf8")).files.map(entry => (
        entry.path === "server/index.js"
          ? { ...entry, sha256: createHash("sha256").update(readFileSync(path.join(plugin.root, "server", "index.js"))).digest("hex") }
          : entry));
      const digest = createHash("sha256").update(JSON.stringify(files)).digest("hex");
      writeFileSync(path.join(plugin.root, "runtime", "payload.json"), JSON.stringify({ version: 1, plugin: `v${n}`, digest, files }));
      return { root: plugin.root, id: digest.slice(0, 16) };
    };
    const [v1, v2, v3] = [1, 2, 3].map(version);
    for (const [plugin, n] of [[v1, 1], [v2, 2]]) {
      const result = launch(plugin.root, data);
      expect(result.status, result.stderr).toBe(0);
      expect(result.stdout.trim()).toBe(`{"v":${n}}`);
    }
    expect(runtimes()).toEqual([v1.id, v2.id].sort());
    expect(launch(v3.root, data).stdout.trim()).toBe('{"v":3}');
    expect(runtimes()).toEqual([v2.id, v3.id].sort());
  });
});
