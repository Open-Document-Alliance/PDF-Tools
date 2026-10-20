// Truthfulness guard for encrypted PDFs.
//
// pdf-lib 1.17.1 has no decryption at all. PDF.js does decrypt, and the
// vendored qpdf runtime now decrypts for the pdf-lib paths that opted into it.
// So there are three honest stories a tool can tell about a password, and the
// only untruthful thing a tool can do is tell the wrong one. This suite builds
// a real AES-256 PDF with qpdf at run time (no encrypted binary is committed
// for it), then proves:
//
//   1. the libraries really do behave that way, so the claim is measured here
//      rather than asserted from documentation;
//   2. a tool that cannot decrypt says so, and never tells the caller to supply
//      a password it cannot use;
//   3. a tool that can decrypt does not carry the "cannot decrypt" text, and
//      says what it actually does — including, on a write path, that the
//      document's protection is put back rather than removed;
//   4. private entry unlocks the exact document for supported tools without
//      exposing a password or browser capability in MCP messages.
//
// (4) is what stops the message from drifting into naming a tool that does not
// work, (2) is what stops the old "please provide the correct password" advice
// from coming back, and (3) is the same guard pointing the other way: it stops
// a tool that gained decryption from keeping a refusal it no longer means.

import { spawnSync } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { PDFDocument } from "pdf-lib";
import { PDF_LIB_ENCRYPTED_MESSAGE } from "../server/helpers.js";
import { createTestTempDirectory, removeTestTempDirectory } from "./helpers/temp-directory.js";
import { createPrivatePdfUnlockHarness } from "./helpers/private-pdf-unlock.js";

const REPO_ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const PLAINTEXT_PDF = path.join(REPO_ROOT, "example-fw9.pdf");
const USER_PASSWORD = "encrypted-truth-user-2026";
const WRONG_PASSWORD = "encrypted-truth-wrong-2026";

// Supported PDF.js readers named by encrypted-operation recovery messages.
const PDFJS_PASSWORD_TOOLS = Object.freeze(["convert_pdf_to_markdown", "get_pdf_info", "read_pdf_layout"]);

// Tools that read through pdf-lib but decrypt first, via the vendored qpdf
// runtime in server/qpdf-decrypt.js. They are read-only — none writes a PDF
// back. Their privately entered credential is usable, so "cannot decrypt" is false on
// them and this suite must not require it.
const DECRYPTING_PASSWORD_TOOLS = Object.freeze(["read_pdf_fields", "validate_pdf"]);


function probeQpdf() {
  try {
    const probe = spawnSync("qpdf", ["--version"], { encoding: "utf8" });
    if (probe.error || probe.status !== 0) {
      return { available: false, reason: probe.error ? probe.error.message : `qpdf --version exited ${probe.status}` };
    }
    return { available: true, version: probe.stdout.split("\n")[0].trim() };
  } catch (error) {
    return { available: false, reason: error.message };
  }
}

const QPDF = probeQpdf();

describe("encrypted PDF password truthfulness", () => {
  // Always runs, so the report states the guard's status instead of quietly
  // omitting it. A skipped encryption guard must be loud: a silent skip is how
  // a truthfulness regression reaches a release unnoticed.
  it("reports whether the qpdf-backed encryption guard could run", () => {
    expect(typeof QPDF.available).toBe("boolean");
    if (QPDF.available) return;
    expect(QPDF.reason, "a skip must carry its reason").toEqual(expect.any(String));
    expect(QPDF.reason.length).toBeGreaterThan(0);
    const banner = `[encrypted-pdf-password-truth] SKIPPED: qpdf is unavailable (${QPDF.reason}). `
      + "The encrypted-PDF password-truthfulness guard did NOT run. Install qpdf to enforce it.";
    process.stderr.write(`\n${"!".repeat(78)}\n${banner}\n${"!".repeat(78)}\n\n`);
    console.warn(banner);
  });
});

describe.skipIf(!QPDF.available)("encrypted PDF password truthfulness (qpdf present)", () => {
  let client;
  let transport;
  let tempDirectory;
  let encryptedPath;
  let encryptedBytes;
  let unlock;

  const callTool = async (name, args) => await unlock.call(client, name, args);
  const toolText = result => result.content?.map(part => part.text ?? "").join("\n") ?? "";

  beforeAll(async () => {
    tempDirectory = await createTestTempDirectory(REPO_ROOT, "encrypted-password-truth");
    encryptedPath = path.join(tempDirectory, "aes256-encrypted.pdf");
    const encrypt = spawnSync("qpdf", [
      "--encrypt",
      `--user-password=${USER_PASSWORD}`,
      `--owner-password=${USER_PASSWORD}`,
      "--bits=256",
      "--",
      PLAINTEXT_PDF,
      encryptedPath,
    ], { encoding: "utf8" });
    if (encrypt.status !== 0) {
      throw new Error(`qpdf encryption failed (${encrypt.status}): ${encrypt.stderr}`);
    }
    encryptedBytes = await fs.readFile(encryptedPath);
    unlock = await createPrivatePdfUnlockHarness(tempDirectory);

    client = new Client({ name: "encrypted-password-truth-test", version: "1.0.0" });
    transport = new StdioClientTransport({
      command: process.execPath,
      args: [path.join(REPO_ROOT, "server/index.js")],
      cwd: REPO_ROOT,
      env: { ...unlock.env, ALLOWED_DIRECTORIES: [REPO_ROOT, tempDirectory].join(path.delimiter) },
      stderr: "ignore",
    });
    await client.connect(transport);
  }, 60_000);

  afterAll(async () => {
    try {
      await client?.close();
      await transport?.close();
    } finally {
      await removeTestTempDirectory(tempDirectory);
    }
  });

  it("measures that pdf-lib cannot decrypt and PDF.js can", async () => {
    // The premise of every other assertion in this file, checked against the
    // pinned libraries instead of taken on trust.
    await expect(PDFDocument.load(encryptedBytes, { password: USER_PASSWORD }))
      .rejects.toThrow(/encrypted/i);
    await expect(PDFDocument.load(encryptedBytes)).rejects.toThrow(/encrypted/i);
    // pdf-lib's own suggested escape hatch produces a document that cannot be
    // used, which is why the error must not repeat that advice either.
    let ignoredEncryptionFailure = null;
    try {
      const ignored = await PDFDocument.load(encryptedBytes, { ignoreEncryption: true });
      ignored.getPages();
    } catch (error) {
      ignoredEncryptionFailure = error;
    }
    expect(ignoredEncryptionFailure, "ignoreEncryption must not yield a usable document").not.toBeNull();

    const pdfjs = await import("pdfjs-dist/legacy/build/pdf.mjs");
    const task = pdfjs.getDocument({
      data: new Uint8Array(encryptedBytes),
      password: USER_PASSWORD,
      isEvalSupported: false,
      useSystemFonts: false,
    });
    const document = await task.promise;
    try {
      expect(document.numPages).toBeGreaterThan(0);
    } finally {
      await task.destroy();
    }
  }, 60_000);

  it("states the pdf-lib limit instead of asking for a password it cannot use", () => {
    // Derived from the message itself, so rewording it cannot smuggle the old
    // instruction back in.
    const message = PDF_LIB_ENCRYPTED_MESSAGE;
    expect(message).toMatch(/cannot decrypt|no decryption/i);
    expect(message).toMatch(/pdf-lib/);
    expect(message).not.toMatch(/provide the correct password/i);
    expect(message).not.toMatch(/using the '?password'? parameter/i);
    expect(message).not.toMatch(/ignoreEncryption/);
    // It must direct the caller somewhere that works, and only there.
    const namedTools = PDFJS_PASSWORD_TOOLS.filter(tool => message.includes(tool));
    expect(namedTools).toEqual([...PDFJS_PASSWORD_TOOLS]);
  });

  it("tells the truth on a WRITE path, and writes nothing without a usable password", async () => {
    // fill_pdf loads inside the pdf-lib worker subprocess and writes the
    // document back. It decrypts now — and re-protects afterwards — so the
    // truthfulness requirement moves rather than disappears: a missing or
    // wrong password must say which of the two it was, produce no file, and
    // never quote the password back.
    const filled = path.join(tempDirectory, "filled.pdf");
    const attempt = async () => callTool("fill_pdf", {
      pdf_path: encryptedPath,
      field_data: {},
      output_path: filled,
    });

    await unlock.lock(client, encryptedPath);
    const omitted = await attempt();
    expect(omitted.isError, "fill_pdf with no password").toBe(true);
    expect(toolText(omitted)).toContain("unlock_pdf");

    await unlock.enter(client, encryptedPath, WRONG_PASSWORD, { accepted: false });
    const wrong = await attempt();
    expect(wrong.isError, "fill_pdf with a wrong password").toBe(true);
    expect(toolText(wrong)).toContain("unlock_pdf");
    expect(toolText(wrong), "must not echo the password").not.toContain(WRONG_PASSWORD);
    // The pdf-lib limit is no longer the truth on this path, so citing it
    // would be the new lie.
    expect(toolText(wrong)).not.toContain(PDF_LIB_ENCRYPTED_MESSAGE);

    // Neither failure may have produced a file.
    await expect(fs.access(filled)).rejects.toThrow();

    await unlock.enter(client, encryptedPath, USER_PASSWORD);
    const accepted = await attempt();
    expect(accepted.isError, "fill_pdf with the correct password").not.toBe(true);
    expect(toolText(accepted), "must not echo the password").not.toContain(USER_PASSWORD);
    // And what it wrote is still an encrypted document: a write path that
    // silently produced plaintext would be the worst possible outcome here.
    const written = await fs.readFile(filled);
    expect(written.toString("latin1")).toContain("/Encrypt");
    await expect(PDFDocument.load(written)).rejects.toThrow(/encrypted/i);
  }, 120_000);

  it("tells the truth on the read paths that now decrypt, and never echoes the password", async () => {
    // These used to be covered by the blanket "every pdf-lib reader fails"
    // assertion above. They decrypt now, so the truthfulness requirement moves
    // rather than disappears: each outcome must describe what actually
    // happened, and no outcome may contain the password.
    for (const tool of DECRYPTING_PASSWORD_TOOLS) {
      await unlock.enter(client, encryptedPath, USER_PASSWORD);
      const accepted = await callTool(tool, { pdf_path: encryptedPath });
      expect(accepted.isError, `${tool} with the correct password`).not.toBe(true);
      expect(toolText(accepted), `${tool} must not echo the password`).not.toContain(USER_PASSWORD);

      await unlock.enter(client, encryptedPath, WRONG_PASSWORD, { accepted: false });
      const rejected = await callTool(tool, { pdf_path: encryptedPath });
      expect(rejected.isError).toBe(true);
      expect(toolText(rejected), `${tool} with a wrong local password`).toContain("unlock_pdf");
      expect(toolText(rejected), `${tool} must not echo the password`).not.toContain(WRONG_PASSWORD);
      // The old "supply the correct password" advice must not come back in the
      // one case where it is still wrong to imply pdf-lib could use it.
      expect(toolText(rejected), `${tool} must not cite the pdf-lib limit`)
        .not.toContain(PDF_LIB_ENCRYPTED_MESSAGE);

      await unlock.lock(client, encryptedPath);
      const omitted = await callTool(tool, { pdf_path: encryptedPath });
      expect(toolText(omitted), `${tool} with no password`).toContain("unlock_pdf");
    }
  }, 120_000);

  it("opens the same document with the same password on every tool the message names", async () => {
    // Binds the advice to behavior: if one of these stops working, the message
    // is no longer true and this test fails.
    const invocations = {
      convert_pdf_to_markdown: { pdf_path: encryptedPath, start_page: 1, end_page: 1 },
      get_pdf_info: { pdf_path: encryptedPath },
      read_pdf_layout: { pdf_path: encryptedPath, start_page: 1, end_page: 1 },
    };
    expect(Object.keys(invocations).sort()).toEqual([...PDFJS_PASSWORD_TOOLS].sort());
    await unlock.enter(client, encryptedPath, USER_PASSWORD);
    for (const tool of PDFJS_PASSWORD_TOOLS) {
      const result = await callTool(tool, invocations[tool]);
      expect(result.isError, `${tool} with the correct password`).not.toBe(true);
      expect(toolText(result), `${tool} must not echo the password`).not.toContain(USER_PASSWORD);
    }
  }, 120_000);

  it("does not point a password-less read tool at a password parameter it lacks", async () => {
    // read_pdf_content and its siblings decrypt through PDF.js but expose no
    // password argument, so the advice must name tools that do accept one.
    await unlock.lock(client, encryptedPath);
    const { tools } = await client.listTools();
    const byName = new Map(tools.map(tool => [tool.name, tool]));
    for (const tool of ["read_pdf_content", "read_pdf_pages", "search_pdf_text"]) {
      expect(Object.keys(byName.get(tool).inputSchema.properties), `${tool} schema`)
        .not.toContain("password");
    }
    const readArguments = {
      read_pdf_content: { pdf_path: encryptedPath },
      read_pdf_pages: { pdf_path: encryptedPath, start_page: 1, end_page: 1 },
      search_pdf_text: { pdf_path: encryptedPath, query: "name" },
    };
    for (const [tool, args] of Object.entries(readArguments)) {
      const result = await callTool(tool, args);
      const text = toolText(result);
      expect(result.isError, tool).toBe(true);
      expect(text, tool).not.toMatch(/provide it with the password parameter/i);
      expect(text, tool).toContain("unlock_pdf");
    }
  }, 90_000);

  it("refuses an encrypted comparison usefully, rather than as an internal fault", async () => {
    // compare_pdfs cannot decrypt: PDF.js gives it text, forms, annotations and
    // metadata, but page geometry and page rendering go through pdf-lib. What
    // it must never do is report that as an internal error, which is what it
    // did whenever the visual channel was switched off and the encrypted
    // observation's RAW_PAGE_GEOMETRY_UNAVAILABLE reached its structure
    // channel. Both argument shapes are checked, because that is exactly the
    // difference that used to change the answer.
    await unlock.enter(client, encryptedPath, USER_PASSWORD);
    for (const includeVisual of [true, false]) {
      const result = await callTool("compare_pdfs", {
        before_pdf_path: encryptedPath,
        after_pdf_path: encryptedPath,
        include_visual: includeVisual,
      });
      const text = toolText(result);
      const label = `include_visual: ${includeVisual}`;
      expect(result.isError, label).toBe(true);
      expect(text, label).not.toMatch(/Internal output validation failed/);
      expect(result.structuredContent.error.code, label)
        .toBe("PDF_ENCRYPTED_COMPARISON_UNSUPPORTED");
      // Same three obligations as every other refusal in this family: what was
      // wrong, why the password cannot fix it, and where an encrypted document
      // can actually be read.
      expect(text, label).toContain("Both comparison inputs are encrypted");
      expect(text, label).toMatch(/pdf-lib, which has no decryption support/);
      expect(text, label).not.toMatch(/provide.*password.*argument/i);
      for (const named of PDFJS_PASSWORD_TOOLS) expect(text, `${label} ${named}`).toContain(named);
      expect(text, label).not.toContain(USER_PASSWORD);
      // The other way this refusal has been lost: re-reported as a generic
      // argument fault, which is a false statement about a valid call.
      expect(result.structuredContent.error.code, label).not.toBe("invalid_input");
      expect(text, label).not.toContain("arguments or PDF inputs are invalid");
    }
  }, 180_000);

  it("rejects all legacy password arguments before work, including empty and null values", async () => {
    for (const field of ["password", "before_password", "after_password"]) {
      for (const value of [USER_PASSWORD, "", null]) {
        const output = path.join(tempDirectory, `legacy-${field}-${value === null ? "null" : value.length}.pdf`);
        const result = await callTool("fill_pdf", {
          pdf_path: PLAINTEXT_PDF, field_data: {}, output_path: output, [field]: value,
        });
        expect(result.isError, `${field}=${value === null ? "null" : "string"}`).toBe(true);
        expect(toolText(result)).toContain("unlock_pdf");
        expect(JSON.stringify(result)).not.toContain(USER_PASSWORD);
        await expect(fs.access(output)).rejects.toThrow();
      }
    }
  }, 60_000);

  it("refuses a mixed-encryption merge with the two routes that would work", async () => {
    // Encrypting two documents with one password does not give them one
    // protection — the salts and /ID differ per run — so the merge is refused.
    // The refusal has to say that, because "I used the same password" is
    // exactly what the caller will have done.
    const second = path.join(tempDirectory, "aes256-encrypted-second.pdf");
    const encrypt = spawnSync("qpdf", [
      "--encrypt", `--user-password=${USER_PASSWORD}`, `--owner-password=${USER_PASSWORD}`,
      "--bits=256", "--", PLAINTEXT_PDF, second,
    ], { encoding: "utf8" });
    expect(encrypt.status, encrypt.stderr).toBe(0);
    await unlock.enter(client, encryptedPath, USER_PASSWORD);
    await unlock.enter(client, second, USER_PASSWORD);

    const refused = await callTool("merge_pdfs", {
      input_paths: [encryptedPath, second],
      output_path: path.join(tempDirectory, "merged-mixed.pdf"),
    });
    const text = toolText(refused);
    expect(refused.isError).toBe(true);
    // Asserted on the served response at the MCP boundary. merge_pdfs raises
    // this inside the isolated pdf-lib child, so the whole message has to
    // survive a process boundary to reach the caller at all.
    expect(text).toContain("not all protected the same way");
    expect(text).toContain("Encrypting each source separately with the same password is not enough");
    expect(text).toMatch(/byte-identical/);
    expect(text).toMatch(/protect the merged file yourself/);
    expect(text).not.toContain(USER_PASSWORD);
    await expect(fs.access(path.join(tempDirectory, "merged-mixed.pdf"))).rejects.toThrow();

    // And the route it names is real: copies of one protected document share
    // one /Encrypt dictionary and merge.
    const copy = path.join(tempDirectory, "aes256-encrypted-copy.pdf");
    await fs.writeFile(copy, encryptedBytes);
    const merged = path.join(tempDirectory, "merged-identical.pdf");
    const lockedCopy = await callTool("merge_pdfs", {
      input_paths: [encryptedPath, copy], output_path: merged,
    });
    expect(lockedCopy.isError, "credentials must not transfer to another path with identical bytes").toBe(true);
    await expect(fs.access(merged)).rejects.toThrow();
    await unlock.enter(client, copy, USER_PASSWORD);
    const accepted = await callTool("merge_pdfs", {
      input_paths: [encryptedPath, copy],
      output_path: merged,
    });
    expect(accepted.isError, toolText(accepted)).not.toBe(true);
    expect((await fs.readFile(merged)).toString("latin1")).toContain("/Encrypt");
  }, 180_000);

  it("never advertises public password inputs and exposes only document-scoped entry controls", async () => {
    const { tools } = await client.listTools();
    for (const tool of tools) {
      for (const field of ["password", "before_password", "after_password"]) {
        expect(tool.inputSchema?.properties ?? {}, tool.name).not.toHaveProperty(field);
      }
    }
    for (const name of ["unlock_pdf", "get_pdf_unlock_status", "lock_pdf"]) {
      const tool = tools.find(value => value.name === name);
      expect(tool, name).toBeDefined();
      expect(Object.keys(tool.inputSchema.properties), name).toEqual(["pdf_path"]);
    }
    for (const response of unlock.responses) {
      expect(response).not.toContain(USER_PASSWORD);
      expect(response).not.toContain(WRONG_PASSWORD);
    }
  }, 30_000);

  it("serves the same private-entry contract from the share bundle with isolated server sessions", async () => {
    await unlock.enter(client, encryptedPath, USER_PASSWORD);
    const shareClient = new Client({ name: "encrypted-password-share-test", version: "1.0.0" });
    const shareTransport = new StdioClientTransport({
      command: process.execPath,
      args: [path.join(REPO_ROOT, "pdf-toolkit-mcp-share/server/index.js")],
      cwd: REPO_ROOT,
      env: { ...unlock.env, ALLOWED_DIRECTORIES: [REPO_ROOT, tempDirectory].join(path.delimiter) },
      stderr: "ignore",
    });
    try {
      await shareClient.connect(shareTransport);
      const [sourceTools, shareTools] = await Promise.all([client.listTools(), shareClient.listTools()]);
      for (const name of ["unlock_pdf", "get_pdf_unlock_status", "lock_pdf", "read_pdf_fields", "fill_pdf"]) {
        expect(shareTools.tools.find(tool => tool.name === name)?.inputSchema, name)
          .toEqual(sourceTools.tools.find(tool => tool.name === name)?.inputSchema);
      }
      const stillLocked = await unlock.call(shareClient, "read_pdf_fields", { pdf_path: encryptedPath });
      expect(stillLocked.isError, "one server's credential must not unlock another server").toBe(true);
      expect(toolText(stillLocked)).toContain("unlock_pdf");
      const legacy = await unlock.call(shareClient, "read_pdf_fields", {
        pdf_path: encryptedPath, password: USER_PASSWORD,
      });
      expect(legacy.isError).toBe(true);
      expect(JSON.stringify(legacy)).not.toContain(USER_PASSWORD);
      await unlock.enter(shareClient, encryptedPath, USER_PASSWORD);
      const opened = await unlock.call(shareClient, "read_pdf_fields", { pdf_path: encryptedPath });
      expect(opened.isError, toolText(opened)).not.toBe(true);
      expect(opened.structuredContent.fieldCount).toBeGreaterThan(0);
      const output = path.join(tempDirectory, "share-filled.pdf");
      const written = await unlock.call(shareClient, "fill_pdf", {
        pdf_path: encryptedPath, field_data: {}, output_path: output,
      });
      expect(written.isError, toolText(written)).not.toBe(true);
      expect((await fs.readFile(output)).toString("latin1")).toContain("/Encrypt");
    } finally {
      await shareClient.close();
      await shareTransport.close();
    }
  }, 120_000);
});
