import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createPrivatePdfUnlockHarness } from "./helpers/private-pdf-unlock.js";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const PASSWORD = "private-extraction-synthetic-password";
const text = result => (result.content ?? []).map(part => part.text ?? "").join("\n");

describe("private PDF authorization at the real extraction cache boundary", () => {
  let directory;
  let source;
  let client;
  let transport;
  let unlock;
  let chunkArguments;
  let clearChunk;

  beforeAll(async () => {
    directory = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "private-pdf-extraction-")));
    source = path.join(directory, "encrypted-source.pdf");
    const createQpdf = (await import("../vendor/qpdf-wasm/runtime/qpdf.mjs")).default;
    const qpdf = await createQpdf({ print: () => {}, printErr: () => {} });
    qpdf.FS.writeFile("/in.pdf", new Uint8Array(await fs.readFile(path.join(
      ROOT, "test/fixtures/eval/extraction/synthetic/born-digital-flat.pdf",
    ))));
    let code;
    try {
      code = qpdf.callMain([
        "--encrypt", `--user-password=${PASSWORD}`, `--owner-password=${PASSWORD}`,
        "--bits=256", "--", "/in.pdf", "/out.pdf",
      ]);
    } catch (error) { code = Number.isInteger(error?.status) ? error.status : -1; }
    expect(code).toBe(0);
    await fs.writeFile(source, qpdf.FS.readFile("/out.pdf"), { mode: 0o600 });
    await fs.mkdir(path.join(directory, "profiles"), { mode: 0o700 });
    unlock = await createPrivatePdfUnlockHarness(directory);
    transport = new StdioClientTransport({
      command: process.execPath,
      args: [path.join(ROOT, "server/index.js")],
      cwd: ROOT,
      env: {
        ...unlock.env,
        ALLOWED_DIRECTORIES: directory,
        DEFAULT_PROFILES_DIR: path.join(directory, "profiles"),
      },
      stderr: "ignore",
    });
    client = new Client({ name: "private-pdf-extraction-test", version: "1.0.0" });
    await client.connect(transport);
  }, 90_000);

  afterAll(async () => {
    try {
      await client?.close();
      await transport?.close();
    } finally {
      if (directory) await fs.rm(directory, { recursive: true, force: true });
    }
  });

  it("rechecks private authorization after locking an already cached encrypted workspace", async () => {
    await unlock.enter(client, source, PASSWORD);
    const created = await unlock.call(client, "create_extraction_workspace", {
      pdf_path: source,
      workspace_id: "private-auth-cache",
      schema: { type: "object", properties: { title: { type: "string" } } },
    });
    expect(created.isError, text(created)).not.toBe(true);
    const bound = {
      workspace_id: "private-auth-cache",
      workspace_identity_sha256: created.structuredContent.workspace_identity_sha256,
    };
    const descriptors = await unlock.call(client, "read_extraction_workspace", {
      ...bound, collection: "document_map_chunks", limit: 100,
    });
    expect(descriptors.isError, text(descriptors)).not.toBe(true);
    expect(descriptors.structuredContent.items.length).toBeGreaterThan(0);
    chunkArguments = { ...bound, pdf_path: source, chunk_id: descriptors.structuredContent.items[0].chunk_id };
    const first = await unlock.call(client, "read_extraction_chunk", chunkArguments);
    expect(first.isError, text(first)).not.toBe(true);
    clearChunk = first.structuredContent.content;
    expect(clearChunk.length).toBeGreaterThan(0);
    const cached = await unlock.call(client, "read_extraction_chunk", chunkArguments);
    expect(cached.isError, text(cached)).not.toBe(true);
    expect(cached.structuredContent).toEqual(first.structuredContent);

    await unlock.lock(client, source);
    const refused = await unlock.call(client, "read_extraction_chunk", chunkArguments);
    expect(refused.isError, "cached layout cannot preserve a locked credential").toBe(true);
    expect(text(refused)).toContain("unlock_pdf");
    expect(refused.structuredContent?.content).toBeUndefined();
    expect(JSON.stringify(refused)).not.toContain(clearChunk);

    await unlock.enter(client, source, PASSWORD);
    const restored = await unlock.call(client, "read_extraction_chunk", chunkArguments);
    expect(restored.isError, text(restored)).not.toBe(true);
    expect(restored.structuredContent.content).toBe(clearChunk);
    for (const response of unlock.responses) expect(response).not.toContain(PASSWORD);
  }, 180_000);

  it("invalidates a private entry when the encrypted source changes at the same path", async () => {
    // A trailing PDF comment preserves readability but changes the exact
    // source bytes. Neither a credential nor cached chunk can transfer to it.
    await fs.appendFile(source, "\n% synthetic source revision\n");
    const state = await unlock.call(client, "get_pdf_unlock_status", { pdf_path: source });
    expect(JSON.parse(text(state)).status).toBe("locked");
    const read = await unlock.call(client, "get_pdf_info", { pdf_path: source });
    expect(read.isError, "same path with new bytes must require private entry again").toBe(true);
    expect(text(read)).toContain("unlock_pdf");
    const stale = await unlock.call(client, "read_extraction_chunk", chunkArguments);
    expect(stale.isError, "old workspace source binding must reject changed bytes").toBe(true);
    expect(stale.structuredContent?.content).toBeUndefined();
    expect(JSON.stringify(stale)).not.toContain(clearChunk);
    for (const response of unlock.responses) expect(response).not.toContain(PASSWORD);
  }, 60_000);
});
