// add_signature_field used to draw a picture of a box and nothing else, so
// no signing application could find a field to sign. It now creates an
// unsigned /Sig AcroForm
// field with a widget at the drawn box, appended as an incremental update.
// Results are read back with PDF.js, which reports widget annotations
// independently of pdf-lib.

import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { PDFDocument, PDFName, StandardFonts } from "pdf-lib";
import { validateStructuredToolResult } from "../server/output-schemas.js";
import { keepsPrefix } from "../server/incremental-update.js";
import { inspectSignatureState } from "../server/signature-state.js";
import { createTestTempDirectory, removeTestTempDirectory } from "./helpers/temp-directory.js";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

async function signatureWidgets(bytes) {
  const lib = await import("pdfjs-dist/legacy/build/pdf.mjs");
  const task = lib.getDocument({ data: new Uint8Array(bytes), isEvalSupported: false, useSystemFonts: false });
  const document = await task.promise;
  try {
    const out = [];
    for (let number = 1; number <= document.numPages; number += 1) {
      const page = await document.getPage(number);
      for (const annotation of await page.getAnnotations()) {
        if (annotation.subtype === "Widget" && annotation.fieldType === "Sig") {
          out.push({ page: number, name: annotation.fieldName, rect: annotation.rect.map(Math.round) });
        }
      }
    }
    return out;
  } finally {
    await task.destroy();
  }
}

async function formDocument() {
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  doc.addPage([612, 792]);
  const page = doc.addPage([612, 792]);
  page.drawText("Signature: ____________________", { x: 72, y: 540, size: 12, font });
  doc.getForm().createTextField("full_name").addToPage(page, { x: 72, y: 600, width: 200, height: 20 });
  doc.getForm().getTextField("full_name").setText("Prefilled Name");
  return doc.save();
}

describe("add_signature_field creates a real signature field (stdio)", () => {
  let client;
  let transport;
  let directory;

  async function call(args) {
    const result = await client.callTool({ name: "add_signature_field", arguments: args });
    return { result, text: result.content.map(block => block.text ?? "").join("\n") };
  }

  beforeAll(async () => {
    directory = await createTestTempDirectory(REPO_ROOT, "signature-field");
    transport = new StdioClientTransport({
      command: process.execPath,
      args: [path.join(REPO_ROOT, "server/index.js")],
      cwd: REPO_ROOT,
      env: { ...process.env, ALLOWED_DIRECTORIES: directory, DEFAULT_PROFILES_DIR: path.join(directory, "state") },
      stderr: "pipe",
    });
    client = new Client({ name: "signature-field-test", version: "1.0.0" });
    await client.connect(transport);
  }, 30_000);

  afterAll(async () => {
    try {
      await client?.close();
      await transport?.close();
    } finally {
      await removeTestTempDirectory(directory);
    }
  });

  it("adds an unsigned /Sig field with a widget exactly at the drawn box, appended", async () => {
    const source = path.join(directory, "form.pdf");
    const output = path.join(directory, "form-sign.pdf");
    const original = await formDocument();
    await fs.writeFile(source, original);
    const { result, text } = await call({
      pdf_path: source, output_path: output, page: 2, x: 140, y: 230, width: 250, height: 36,
    });
    expect(result.isError, text).toBeFalsy();
    expect(validateStructuredToolResult("add_signature_field", result).isError).toBeFalsy();
    expect(result.structuredContent).toMatchObject({ field_name: "Signature", save_mode: "incremental" });
    expect(text).toContain("real, unsigned signature form field");
    const bytes = await fs.readFile(output);
    expect(keepsPrefix(new Uint8Array(bytes), original)).toBe(true);
    // Top-left (140, 230) on a 792pt page is bottom-left y 792 - 230 - 36 = 526.
    expect(await signatureWidgets(bytes)).toEqual([{ page: 2, name: "Signature", rect: [140, 526, 390, 562] }]);
    const doc = await PDFDocument.load(bytes, { updateMetadata: false });
    expect(inspectSignatureState(doc)).toMatchObject({ signed: [], unsigned: ["Signature"] });
    const acroForm = doc.catalog.lookup(PDFName.of("AcroForm"));
    expect(acroForm.lookup(PDFName.of("SigFlags")).asNumber() & 1).toBe(1);
    expect(doc.getForm().getTextField("full_name").getText()).toBe("Prefilled Name");
  });

  it("picks the next free default name, honours field_name, and refuses a taken one", async () => {
    const source = path.join(directory, "names.pdf");
    await fs.writeFile(source, await formDocument());
    await call({ pdf_path: source, output_path: source, page: 2, x: 140, y: 230, width: 250, height: 36 });
    const second = await call({ pdf_path: source, output_path: source, page: 2, x: 140, y: 300, width: 250, height: 36 });
    expect(second.result.structuredContent.field_name).toBe("Signature2");
    const named = await call({
      pdf_path: source, output_path: source, page: 1, x: 72, y: 72, width: 200, height: 30, field_name: "client_signature",
    });
    expect(named.result.structuredContent.field_name).toBe("client_signature");
    const taken = await call({
      pdf_path: source, output_path: source, page: 1, x: 72, y: 200, width: 200, height: 30, field_name: "full_name",
    });
    expect(taken.result.isError).toBe(true);
    expect(taken.text).toMatch(/already exists/);
    const widgets = await signatureWidgets(await fs.readFile(source));
    expect(widgets.map(widget => widget.name).sort()).toEqual(["Signature", "Signature2", "client_signature"]);
  });

  it("leaves the document editable: an empty signature field does not block stamping", async () => {
    const source = path.join(directory, "then-stamp.pdf");
    const signed = path.join(directory, "then-stamp-field.pdf");
    await fs.writeFile(source, await formDocument());
    await call({ pdf_path: source, output_path: signed, page: 2, x: 140, y: 230, width: 250, height: 36 });
    const stamped = await client.callTool({
      name: "apply_text",
      arguments: {
        pdf_path: signed, output_path: path.join(directory, "stamped.pdf"),
        page: 2, x: 400, y: 230, width: 120, height: 20, text: "2026-11-25",
      },
    });
    expect(stamped.isError, JSON.stringify(stamped.content)).toBeFalsy();
  });
});
