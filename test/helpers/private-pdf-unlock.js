import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";

// Only the test opener sees this environment variable. Production opens the
// user's browser normally and has no test hook or credential-bearing MCP call.
export async function createPrivatePdfUnlockHarness(directory) {
  const root = path.join(directory, "private-unlock-test");
  const bin = path.join(root, "bin");
  const capture = path.join(root, "opened-url");
  await fs.mkdir(bin, { recursive: true, mode: 0o700 });
  // Explicit type also lets Node execute the simulated Windows command name
  // instead of rejecting its .exe extension inside an ESM parent package.
  await fs.writeFile(path.join(bin, "package.json"), '{"type":"commonjs"}\n', { mode: 0o600 });
  const opener = `#!${process.execPath}\n`
    // Dynamic import is valid in both CommonJS and ESM. Extensionless openers
    // inherit a surrounding package's type when fixtures live under the repo.
    + 'import("node:fs").then(({ default: fs }) => {\n'
    + 'const url = process.argv.find(value => /^http:\\/\\/127\\.0\\.0\\.1:\\d+\\/#/.test(value));\n'
    + 'if (!url) process.exit(2);\n'
    + 'fs.writeFileSync(process.env.PDF_TOOLS_TEST_OPENER_CAPTURE, url, {mode: 0o600, flag: "wx"});\n'
    + '}).catch(() => process.exit(3));\n';
  for (const name of ["open", "xdg-open", "rundll32.exe"]) {
    await fs.writeFile(path.join(bin, name), opener, { mode: 0o700 });
  }
  const responses = [];
  const record = result => {
    responses.push(JSON.stringify(result));
    return result;
  };
  const call = async (client, name, args) => record(await client.callTool({ name, arguments: args }));
  return {
    env: {
      PATH: `${bin}${path.delimiter}${process.env.PATH ?? ""}`,
      PDF_TOOLS_TEST_OPENER_CAPTURE: capture,
    },
    responses,
    call,
    async lock(client, pdfPath) {
      const result = await call(client, "lock_pdf", { pdf_path: pdfPath });
      assert.notEqual(result.isError, true, "lock_pdf must succeed");
      return result;
    },
    async enter(client, pdfPath, password, { accepted = true } = {}) {
      await this.lock(client, pdfPath);
      await fs.rm(capture, { force: true });
      const opened = await call(client, "unlock_pdf", { pdf_path: pdfPath });
      assert.notEqual(opened.isError, true, "unlock_pdf must open the private entry surface");
      let captured;
      for (let count = 0; count < 100; count += 1) {
        try {
          captured = await fs.readFile(capture, "utf8");
          if (captured) break;
        }
        catch (error) { if (error.code !== "ENOENT") throw error; }
        await delay(20);
      }
      assert.ok(captured, "private browser opener must be invoked");
      const url = new URL(captured);
      assert.equal(url.hostname, "127.0.0.1");
      assert.match(url.hash, /^#[0-9a-f]{64}$/);
      assert.equal((await fs.stat(capture)).mode & 0o777, 0o600);
      assert.ok(!JSON.stringify(opened).includes(url.hash.slice(1)), "MCP must not expose the capability");
      const response = await fetch(new URL("/unlock", url), {
        method: "POST",
        headers: { Origin: url.origin, "Content-Type": "application/json" },
        body: JSON.stringify({ token: url.hash.slice(1), password }),
      });
      const body = await response.json();
      assert.ok(!JSON.stringify(body).includes(password), "private response must not echo credentials");
      if (accepted) {
        assert.equal(response.status, 200, "the synthetic password must unlock the exact document");
        assert.equal(body.status, "unlocked");
      } else {
        assert.ok(response.status >= 400, "a wrong local password must fail");
      }
      const status = await call(client, "get_pdf_unlock_status", { pdf_path: pdfPath });
      assert.notEqual(status.isError, true);
      const state = JSON.parse(status.content.filter(entry => entry.type === "text").map(entry => entry.text).join("\n"));
      assert.equal(state.status, accepted ? "unlocked" : "awaiting_password");
      for (const value of responses) assert.ok(!value.includes(password), "MCP response leaked a synthetic password");
      return { response, body, status };
    },
  };
}
