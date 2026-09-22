import fs from "fs/promises";
import path from "path";
import { fileURLToPath } from "url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { validateStructuredToolResult } from "../server/output-schemas.js";
import { createTestTempDirectory, removeTestTempDirectory } from "./helpers/temp-directory.js";

// Measured over the real stdio transport at dc90e75 on Silverbook, 2026-08-18,
// with an ordinary $HOME and a store that exists and has been seeded by the
// product itself (evidence/read-side-silence-2026-08-18). Only what is
// *readable* varies:
//
//   store root 0500, not empty     list_profiles lists it, list_signatures
//                                  lists both -- the read answers are true
//   both signature files 0000      "No signatures yet. Use create_signature
//                                  to save one."            <-- false
//   one signature file 0000        "Saved signatures (1)"   <-- silent drop
//   one signature file corrupt     "Saved signatures (1)"   <-- same output
//
// So on a store whose signatures cannot be read, the server told the user they
// had none and recommended creating one, and a store with one unreadable
// record was indistinguishable from a store with one corrupt record. These
// cases bind the distinction: a file that cannot be READ is reported with its
// errno, a record that cannot be PARSED is still skipped but is counted.

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.join(__dirname, "..");
const SERVER_ENTRY = path.join(REPO_ROOT, "server", "index.js");

// L49: derive applicability from the simulation, not from the ambient
// environment. Mode bits do not mean this on win32, and a process running as
// root bypasses them entirely -- a real condition in containers that a
// platform check would miss. Computed at module scope because it.runIf is
// evaluated during collection, before any beforeAll has run.
async function measureUnreadableFileEnforcement() {
  const probeRoot = await createTestTempDirectory(REPO_ROOT, "sigread-modeprobe");
  try {
    const locked = path.join(probeRoot, "locked");
    await fs.writeFile(locked, "x");
    await fs.chmod(locked, 0o000);
    try {
      await fs.readFile(locked, "utf8");
      return false;
    } catch {
      return true;
    } finally {
      await fs.chmod(locked, 0o600).catch(() => {});
    }
  } finally {
    await removeTestTempDirectory(probeRoot);
  }
}

const unreadableFilesAreEnforced = await measureUnreadableFileEnforcement();

let tempRoot;
let templateStore;

// One server session. DEFAULT_PROFILES_DIR is the variable both manifests
// already set and it fixes the store on every platform; $HOME alone would not,
// because win32 derives the home from USERPROFILE.
async function serverSession({ cwd, storeRoot }, run) {
  const client = new Client({ name: "list-signatures-unreadable-test", version: "1.0.0" });
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [SERVER_ENTRY],
    cwd,
    env: {
      PATH: process.env.PATH ?? "",
      HOME: cwd,
      DEFAULT_PROFILES_DIR: storeRoot,
      ALLOWED_DIRECTORIES: cwd,
    },
    stderr: "pipe",
  });
  await client.connect(transport);
  try {
    return await run(client);
  } finally {
    await transport.close();
  }
}

function resultText(result) {
  return (result.content ?? []).map(item => (item.type === "text" ? item.text : "")).join(" ");
}

async function listSignatures(storeRoot, cwd) {
  return serverSession({ cwd, storeRoot }, client =>
    client.callTool({ name: "list_signatures", arguments: {} }));
}

// Seed once, with the product writing the records, so every case runs against
// exactly the bytes create_signature produces rather than a hand-built fixture.
beforeAll(async () => {
  tempRoot = await createTestTempDirectory(REPO_ROOT, "list-signatures-unreadable");
  const seedRoot = path.join(tempRoot, "seed");
  templateStore = path.join(seedRoot, "store");
  await fs.mkdir(seedRoot, { recursive: true });
  await serverSession({ cwd: seedRoot, storeRoot: templateStore }, async client => {
    for (const name of ["alpha", "beta", "gamma"]) {
      const created = await client.callTool({
        name: "create_signature",
        arguments: { name, display_name: `${name} Person` },
      });
      expect(created.isError, name).not.toBe(true);
    }
  });
  const seeded = (await fs.readdir(path.join(templateStore, "signatures"))).sort();
  expect(seeded).toEqual(["alpha.json", "beta.json", "gamma.json"]);
}, 60_000);

afterAll(async () => {
  // Restore anything left unreadable before the tree is removed, or rm cannot
  // descend into it and the checkout keeps a directory no later run can clean.
  if (tempRoot) {
    const stack = [tempRoot];
    while (stack.length > 0) {
      const current = stack.pop();
      await fs.chmod(current, 0o700).catch(() => {});
      const entries = await fs.readdir(current, { withFileTypes: true }).catch(() => []);
      for (const entry of entries) {
        const child = path.join(current, entry.name);
        if (entry.isDirectory()) stack.push(child);
        else await fs.chmod(child, 0o600).catch(() => {});
      }
    }
  }
  await removeTestTempDirectory(tempRoot);
});

// A copy of the seeded store, so each case starts from the same product-written
// records and can break exactly one thing.
async function storeCopy(label) {
  const cwd = path.join(tempRoot, label);
  const storeRoot = path.join(cwd, "store");
  await fs.mkdir(cwd, { recursive: true });
  await fs.cp(templateStore, storeRoot, { recursive: true });
  await fs.chmod(storeRoot, 0o700).catch(() => {});
  for (const name of await fs.readdir(path.join(storeRoot, "signatures"))) {
    await fs.chmod(path.join(storeRoot, "signatures", name), 0o600).catch(() => {});
  }
  return { cwd, storeRoot, signatures: path.join(storeRoot, "signatures") };
}

describe("list_signatures over a store it can read", () => {
  it("lists every seeded signature and reports nothing dropped", async () => {
    const { cwd, storeRoot } = await storeCopy("readable");
    const result = await listSignatures(storeRoot, cwd);

    expect(result.isError).not.toBe(true);
    expect(resultText(result)).toContain("Saved signatures (3)");
    expect(result.structuredContent.signatures.map(s => s.name).sort())
      .toEqual(["alpha", "beta", "gamma"]);
    expect(result.structuredContent.unreadable).toEqual([]);
    expect(result.structuredContent.malformed).toEqual([]);
  }, 30_000);

  it("still says 'No signatures yet' when the store really is empty", async () => {
    const cwd = path.join(tempRoot, "empty");
    const storeRoot = path.join(cwd, "store");
    await fs.mkdir(path.join(storeRoot, "signatures"), { recursive: true });
    const result = await listSignatures(storeRoot, cwd);

    expect(result.isError).not.toBe(true);
    // The pre-existing sentence, unchanged: an empty store is not a broken one.
    expect(resultText(result)).toContain("No signatures yet. Use create_signature to save one.");
    expect(resultText(result)).not.toContain("Could not read");
    expect(result.structuredContent).toEqual({ signatures: [], unreadable: [], malformed: [] });
  }, 30_000);

  it("does not count a hidden quick signature as dropped", async () => {
    const { cwd, storeRoot, signatures } = await storeCopy("hidden-quick");
    const hidden = "__pdf-tools-quick-scratch";
    const record = JSON.parse(await fs.readFile(path.join(signatures, "alpha.json"), "utf8"));
    await fs.writeFile(
      path.join(signatures, `${hidden}.json`),
      JSON.stringify({ ...record, name: hidden }, null, 2),
    );
    const result = await listSignatures(storeRoot, cwd);

    expect(result.isError).not.toBe(true);
    expect(result.structuredContent.signatures.map(s => s.name).sort())
      .toEqual(["alpha", "beta", "gamma"]);
    expect(result.structuredContent.unreadable).toEqual([]);
    expect(result.structuredContent.malformed).toEqual([]);
  }, 30_000);
});

describe("list_signatures over a store whose records it cannot read", () => {
  it.runIf(unreadableFilesAreEnforced)(
    "does not tell a user with signatures that they have none",
    async () => {
      const { cwd, storeRoot, signatures } = await storeCopy("all-unreadable");
      for (const name of ["alpha.json", "beta.json", "gamma.json"]) {
        await fs.chmod(path.join(signatures, name), 0o000);
      }
      const result = await listSignatures(storeRoot, cwd);
      const text = resultText(result);

      expect(result.isError).not.toBe(true);
      // The measured pre-repair answer, which is the defect this case exists
      // for: three of the user's signatures were sitting in the store.
      expect(text).not.toContain("No signatures yet. Use create_signature to save one.");
      expect(text).toContain("Could not read 3 files");
      expect(text).toContain("EACCES");
      for (const name of ["alpha.json", "beta.json", "gamma.json"]) {
        expect(text).toContain(name);
      }
      expect(result.structuredContent.signatures).toEqual([]);
      expect(result.structuredContent.unreadable.map(e => e.file).sort())
        .toEqual(["alpha.json", "beta.json", "gamma.json"]);
      expect(result.structuredContent.unreadable.every(e => e.code === "EACCES")).toBe(true);
      expect(result.structuredContent.malformed).toEqual([]);
    },
    30_000,
  );

  it.runIf(unreadableFilesAreEnforced)(
    "names the one file it could not read instead of dropping it from the count",
    async () => {
      const { cwd, storeRoot, signatures } = await storeCopy("one-unreadable");
      await fs.chmod(path.join(signatures, "alpha.json"), 0o000);
      const result = await listSignatures(storeRoot, cwd);
      const text = resultText(result);

      expect(result.isError).not.toBe(true);
      expect(text).toContain("Saved signatures (2)");
      expect(text).toContain("Could not read 1 file");
      expect(text).toContain("alpha.json (EACCES)");
      expect(result.structuredContent.signatures.map(s => s.name).sort()).toEqual(["beta", "gamma"]);
      expect(result.structuredContent.unreadable).toEqual([{ file: "alpha.json", code: "EACCES" }]);
      expect(result.structuredContent.malformed).toEqual([]);
    },
    30_000,
  );

  it.runIf(unreadableFilesAreEnforced)(
    "reports an unreadable file and a corrupt record as different things",
    async () => {
      const { cwd, storeRoot, signatures } = await storeCopy("mixed");
      await fs.chmod(path.join(signatures, "alpha.json"), 0o000);
      await fs.writeFile(path.join(signatures, "gamma.json"), "{ this is not json");
      const result = await listSignatures(storeRoot, cwd);
      const text = resultText(result);

      expect(result.isError).not.toBe(true);
      expect(text).toContain("Saved signatures (1)");
      // Pre-repair both of these produced the identical line above and nothing
      // else, so a permission the user can fix in one command looked exactly
      // like a record that is gone for good.
      expect(text).toContain("Could not read 1 file");
      expect(text).toContain("alpha.json (EACCES)");
      expect(text).toContain("Skipped 1 file");
      expect(text).toContain("gamma.json");
      expect(result.structuredContent.signatures.map(s => s.name)).toEqual(["beta"]);
      expect(result.structuredContent.unreadable).toEqual([{ file: "alpha.json", code: "EACCES" }]);
      expect(result.structuredContent.malformed).toEqual([{ file: "gamma.json" }]);
    },
    30_000,
  );

  it("reports a corrupt record without claiming it could not be read", async () => {
    const { cwd, storeRoot, signatures } = await storeCopy("one-malformed");
    await fs.writeFile(path.join(signatures, "gamma.json"), "{ this is not json");
    const result = await listSignatures(storeRoot, cwd);
    const text = resultText(result);

    expect(result.isError).not.toBe(true);
    expect(text).toContain("Saved signatures (2)");
    expect(text).toContain("Skipped 1 file");
    expect(text).toContain("gamma.json");
    expect(text).not.toContain("Could not read");
    expect(result.structuredContent.unreadable).toEqual([]);
    expect(result.structuredContent.malformed).toEqual([{ file: "gamma.json" }]);
  }, 30_000);

  it.runIf(unreadableFilesAreEnforced)(
    "keeps the structured result valid against the advertised output schema",
    async () => {
      const { cwd, storeRoot, signatures } = await storeCopy("schema");
      await fs.chmod(path.join(signatures, "alpha.json"), 0o000);
      const result = await listSignatures(storeRoot, cwd);

      // The server validates its own output before returning it, so an
      // undeclared key would already have become an internal error. Assert it
      // here too, so the schema and the handler cannot drift apart silently.
      const validated = validateStructuredToolResult("list_signatures", {
        content: result.content,
        structuredContent: result.structuredContent,
      });
      expect(validated.isError).not.toBe(true);
      expect(validated.structuredContent).toEqual(result.structuredContent);
    },
    30_000,
  );
});
