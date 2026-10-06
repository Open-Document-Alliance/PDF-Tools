// URL-only sibling package. Never stages the local server or dependencies.
import { chmodSync, cpSync, existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const source = path.join(root, "plugins/pdf-forms");
const output = path.resolve(process.argv[2] || path.join(root, "dist-plugin/pdf-forms"));
if (existsSync(output) || existsSync(`${output}.zip`)) throw new Error("Output already exists; choose a fresh output path.");
mkdirSync(output, { recursive: true, mode: 0o700 });
cpSync(source, output, { recursive: true });
mkdirSync(path.join(output, "assets"), { mode: 0o700 });
cpSync(path.join(root, "icon.png"), path.join(output, "assets/pdf-tools.png"));
const sourceSha = spawnSync("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8" });
if (sourceSha.status !== 0) throw new Error("Cannot identify package source.");
const entries = [];
function inventory(dir) {
  for (const entry of readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
    const full = path.join(dir, entry.name);
    if (entry.isSymbolicLink()) throw new Error("Symlinks are not allowed in this package.");
    if (entry.isDirectory()) { chmodSync(full, 0o700); inventory(full); }
    else if (entry.isFile()) {
      chmodSync(full, 0o600);
      entries.push({ path: path.relative(output, full).split(path.sep).join("/"), bytes: statSync(full).size, sha256: createHash("sha256").update(readFileSync(full)).digest("hex") });
    } else throw new Error("Unsupported package entry.");
  }
}
inventory(output);
writeFileSync(path.join(output, "PROVENANCE.json"), JSON.stringify({ source_commit: sourceSha.stdout.trim(), source_dirty: spawnSync("git", ["status", "--porcelain"], { cwd: root, encoding: "utf8" }).stdout.trim() !== "", profile: "hosted-five-tool-forms", endpoint: "https://mcp.opendocuments.ai/mcp", artifacts: entries }, null, 2) + "\n", { mode: 0o600, flag: "wx" });
const zipped = spawnSync("zip", ["-q", "-r", `${output}.zip`, "."], { cwd: output, encoding: "utf8" });
if (zipped.status !== 0) throw new Error(`ZIP failed: ${zipped.stderr}`);
chmodSync(`${output}.zip`, 0o600);
console.log(JSON.stringify({ ok: true, profile: "hosted-five-tool-forms", directory: output, zip: `${output}.zip`, sha256: createHash("sha256").update(readFileSync(`${output}.zip`)).digest("hex"), files: entries.length + 1 }));
