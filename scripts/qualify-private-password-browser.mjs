// Explicit local-only qualification, not part of automatic test discovery.
// Uses an isolated agent-browser session and a repository-owned synthetic PDF.
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { createPrivatePdfUnlockHarness } from "../test/helpers/private-pdf-unlock.js";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const server = path.resolve(process.argv[2] ?? path.join(root, "server/index.js"));
const fixture = path.join(root, "test/fixtures/eval/extraction/oracles/layout-encrypted-qpdf-r4.pdf");
const provenance = JSON.parse(await fs.readFile(fixture.replace(/\.pdf$/, ".provenance.json"), "utf8"));
const state = await fs.mkdtemp(path.join(os.tmpdir(), "pdf-private-browser-"));
const harness = await createPrivatePdfUnlockHarness(state);
const session = `pdf-private-password-${process.pid}`;
const browser = process.env.PDF_TOOLS_QUALIFICATION_BROWSER ?? "agent-browser";
const browserArgs = ["--session", session];
const browserEnv = { ...process.env, AGENT_BROWSER_ALLOWED_DOMAINS: "127.0.0.1", AGENT_BROWSER_IDLE_TIMEOUT_MS: "60000" };
const run = (...args) => execFileSync(browser, [...browserArgs, ...args], {
  env: browserEnv, encoding: "utf8", timeout: 45_000, stdio: ["ignore", "pipe", "pipe"],
});
const transport = new StdioClientTransport({ command: process.execPath, args: [server],
  env: { ...harness.env, ALLOWED_DIRECTORIES: root, DEFAULT_PROFILES_DIR: path.join(state, "profiles") }, stderr: "pipe" });
const logs = [];
transport.stderr.on("data", chunk => logs.push(chunk.toString()));
const client = new Client({ name: "private-password-browser-qualification", version: "1" });
let phase = "connect";
try {
  await client.connect(transport);
  const before = await harness.call(client, "get_pdf_info", { pdf_path: fixture });
  assert.equal(before.structuredContent.error.code, "PASSWORD_REQUIRED");
  await harness.call(client, "unlock_pdf", { pdf_path: fixture });
  let url;
  for (let count = 0; count < 100; count += 1) {
    url = await fs.readFile(path.join(state, "private-unlock-test/opened-url"), "utf8").catch(() => "");
    if (url) break;
    await delay(20);
  }
  assert.ok(url);
  const capability = new URL(url).hash.slice(1);
  phase = "open_private_page";
  run("batch", `open ${url}`, "wait --text 'Enter this document'", "snapshot -i");
  assert.ok(!run("get", "url").includes(capability), "page must remove its capability from history");
  phase = "wrong_password";
  run("batch", `fill '#password' '${provenance.passwords.wrong_password_oracle}'`, "click '#unlock'",
    "wait --text 'could not be unlocked'");
  assert.equal(JSON.parse((await harness.call(client, "get_pdf_unlock_status", { pdf_path: fixture })).content[0].text).status, "awaiting_password");
  phase = "valid_password";
  run("batch", `fill '#password' '${provenance.passwords.user}'`, "click '#unlock'",
    "wait --text 'Document unlocked'");
  const unlocked = await harness.call(client, "get_pdf_info", { pdf_path: fixture });
  phase = "source_and_input_check";
  assert.notEqual(unlocked.isError, true);
  assert.equal(unlocked.structuredContent.source.sha256, provenance.encrypted_fixture.sha256);
  assert.equal(run("get", "value", "#password").trim(), "");
  phase = "visible_lock";
  run("batch", "click '#lock'", "wait --text 'Document locked'");
  const locked = await harness.call(client, "get_pdf_info", { pdf_path: fixture });
  assert.equal(locked.structuredContent.error.code, "PASSWORD_REQUIRED");
  const captured = [...harness.responses, ...logs].join("\n");
  for (const secret of [...Object.values(provenance.passwords), capability]) assert.ok(!captured.includes(secret));
  console.log(JSON.stringify({ passed: true, host: os.hostname(), platform: process.platform, arch: process.arch,
    node: process.version, server_sha256: createHash("sha256").update(await fs.readFile(server)).digest("hex"),
    source_sha256: unlocked.structuredContent.source.sha256,
    checks: ["missing_password", "real_page_script_and_csp", "fragment_removed", "wrong_password", "private_unlock", "source_bound_read", "input_cleared", "visible_lock", "locked_read_refused", "no_secrets_in_mcp_or_stderr"],
    limitation: "Isolated browser and real MCP server; platform opener substituted by test harness, not a native Claude or ChatGPT host acceptance run." }));
} catch (error) {
  // A browser CLI error can carry the URL or synthetic credential in argv.
  console.error(`Private password browser qualification failed at ${phase}: ${error?.code ?? error?.name ?? "unknown"}.`);
  process.exitCode = 1;
} finally {
  try { run("close"); } catch {}
  await client.close().catch(() => {});
  await transport.close().catch(() => {});
  await fs.rm(state, { recursive: true, force: true });
}
