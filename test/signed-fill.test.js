// Filling a signed form must not break the signature. fill_pdf used to
// rewrite every file with pdf-lib, which moves every byte a signature covers,
// so a filled copy of a signed form no longer verified. A signed document
// is now filled by appending an
// incremental update; what a signature forbids is refused before anything
// changes.
//
// The signed fixture is synthetic (scripts/make-signed-form-fixture.mjs).
// Signatures are verified with `openssl cms` over their byte range when
// openssl is on PATH, which is the same check a validator makes.

import { execFileSync } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { PDFDocument, PDFName, PDFString } from "pdf-lib";
import { validateStructuredToolResult } from "../server/output-schemas.js";
import {
  buildIncrementalUpdate,
  keepsPrefix,
  snapshotIndirectObjects,
} from "../server/incremental-update.js";
import { createTestTempDirectory, removeTestTempDirectory } from "./helpers/temp-directory.js";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const SIGNED_FIXTURE = path.join(REPO_ROOT, "test/fixtures/signing/signed-form.pdf");

function hasOpenssl() {
  try {
    execFileSync("openssl", ["version"], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

async function signatureVerifies(file, directory) {
  const bytes = await fs.readFile(file);
  const latin = bytes.toString("latin1");
  const range = /\/ByteRange\s*\[\s*(\d+)\s+(\d+)\s+(\d+)\s+(\d+)\s*\]/.exec(latin).slice(1).map(Number);
  const der = Buffer.from(latin.slice(range[1] + 1, range[2] - 1), "hex");
  const length = der[1] & 0x80 ? 2 + (der[1] & 0x7f) + der.readUIntBE(2, der[1] & 0x7f) : 2 + der[1];
  const derPath = path.join(directory, "verify.der");
  const contentPath = path.join(directory, "verify.bin");
  await fs.writeFile(derPath, der.subarray(0, length));
  await fs.writeFile(contentPath, Buffer.concat([
    bytes.subarray(range[0], range[0] + range[1]),
    bytes.subarray(range[2], range[2] + range[3]),
  ]));
  try {
    execFileSync("openssl", ["cms", "-verify", "-binary", "-inform", "DER", "-in", derPath,
      "-content", contentPath, "-noverify", "-out", process.platform === "win32" ? "NUL" : "/dev/null"], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

/** Append a change to the signed fixture, the way a later signer or tool would. */
async function signedFixtureWith(change) {
  const original = new Uint8Array(await fs.readFile(SIGNED_FIXTURE));
  const doc = await PDFDocument.load(original, { updateMetadata: false });
  const snapshot = snapshotIndirectObjects(doc, original);
  change(doc);
  return buildIncrementalUpdate(doc, original, snapshot).bytes;
}

function signatureField(doc) {
  const fields = doc.context.lookup(doc.catalog.lookup(PDFName.of("AcroForm")).get(PDFName.of("Fields")));
  return fields.asArray().map(ref => doc.context.lookup(ref))
    .find(field => field.get(PDFName.of("FT")) === PDFName.of("Sig"));
}

async function textValue(file, name) {
  const doc = await PDFDocument.load(await fs.readFile(file), { updateMetadata: false });
  return doc.getForm().getTextField(name).getText() ?? null;
}

describe("filling signed and unsigned forms (stdio)", () => {
  let client;
  let transport;
  let directory;

  async function call(name, args) {
    const result = await client.callTool({ name, arguments: args });
    return {
      isError: result.isError === true,
      text: result.content.map(block => block.text ?? "").join("\n"),
      structured: result.structuredContent,
      result,
    };
  }

  async function succeed(name, args) {
    const outcome = await call(name, args);
    expect(outcome.isError, outcome.text).toBe(false);
    expect(validateStructuredToolResult(name, outcome.result).isError).toBeFalsy();
    return outcome;
  }

  beforeAll(async () => {
    directory = await createTestTempDirectory(REPO_ROOT, "signed-fill");
    transport = new StdioClientTransport({
      command: process.execPath,
      args: [path.join(REPO_ROOT, "server/index.js")],
      cwd: REPO_ROOT,
      env: { ...process.env, ALLOWED_DIRECTORIES: directory, DEFAULT_PROFILES_DIR: path.join(directory, "state") },
      stderr: "pipe",
    });
    client = new Client({ name: "signed-fill-test", version: "1.0.0" });
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

  it("fills a signed form by appending, and the signature still verifies", async () => {
    const source = path.join(directory, "signed.pdf");
    const output = path.join(directory, "signed-filled.pdf");
    await fs.copyFile(SIGNED_FIXTURE, source);
    const { text, structured } = await succeed("fill_pdf", {
      pdf_path: source, output_path: output, field_data: { full_name: "Jane Q. Example" },
    });
    expect(structured).toMatchObject({ save_mode: "incremental", signatures_kept: 1, filled_fields: ["full_name"] });
    expect(text).toContain("appended as an incremental update");
    const original = new Uint8Array(await fs.readFile(SIGNED_FIXTURE));
    expect(keepsPrefix(new Uint8Array(await fs.readFile(output)), original)).toBe(true);
    expect(await textValue(output, "full_name")).toBe("Jane Q. Example");
    expect(await textValue(output, "company")).toBe("Example Widgets LLC");
    if (hasOpenssl()) expect(await signatureVerifies(output, directory)).toBe(true);
  });

  it("fills a signed form in place, keeping a backup", async () => {
    const file = path.join(directory, "in-place.pdf");
    await fs.copyFile(SIGNED_FIXTURE, file);
    const { structured, text } = await succeed("fill_pdf", {
      pdf_path: file, output_path: file, field_data: { full_name: "In Place" },
    });
    expect(structured.save_mode).toBe("incremental");
    expect(text).toContain("Original backed up to:");
    if (hasOpenssl()) expect(await signatureVerifies(file, directory)).toBe(true);
  });

  it("refuses to write a signature field, and says filling cannot sign", async () => {
    const source = path.join(directory, "sig-field.pdf");
    await fs.copyFile(SIGNED_FIXTURE, source);
    const outcome = await call("fill_pdf", {
      pdf_path: source, output_path: path.join(directory, "never.pdf"), field_data: { approver_signature: "x" },
    });
    expect(outcome.isError).toBe(true);
    expect(outcome.text).toMatch(/is a signature field\. Filling cannot sign/);
    await expect(fs.access(path.join(directory, "never.pdf"))).rejects.toThrow();
  });

  it("refuses a field the signature locks, and a DocMDP level 1 certification", async () => {
    const locked = path.join(directory, "locked.pdf");
    await fs.writeFile(locked, await signedFixtureWith(doc => {
      signatureField(doc).set(PDFName.of("Lock"), doc.context.obj({
        Type: "SigFieldLock", Action: "Include", Fields: [PDFString.of("full_name")],
      }));
    }));
    const lockedOutcome = await call("fill_pdf", {
      pdf_path: locked, output_path: path.join(directory, "locked-out.pdf"), field_data: { full_name: "Nope" },
    });
    expect(lockedOutcome.isError).toBe(true);
    expect(lockedOutcome.text).toMatch(/'full_name' is locked by an existing signature/);
    // A field the lock does not name can still be filled.
    const { structured } = await succeed("fill_pdf", {
      pdf_path: locked, output_path: path.join(directory, "locked-company.pdf"), field_data: { company: "Other LLC" },
    });
    expect(structured.save_mode).toBe("incremental");

    const certified = path.join(directory, "certified.pdf");
    await fs.writeFile(certified, await signedFixtureWith(doc => {
      const signature = signatureField(doc).get(PDFName.of("V"));
      doc.context.lookup(signature).set(PDFName.of("Reference"), doc.context.obj([doc.context.obj({
        Type: "SigRef", TransformMethod: "DocMDP", TransformParams: doc.context.obj({ Type: "TransformParams", P: 1, V: "1.2" }),
      })]));
      doc.catalog.set(PDFName.of("Perms"), doc.context.obj({ DocMDP: signature }));
    }));
    const certifiedOutcome = await call("fill_pdf", {
      pdf_path: certified, output_path: path.join(directory, "certified-out.pdf"), field_data: { full_name: "Nope" },
    });
    expect(certifiedOutcome.isError).toBe(true);
    expect(certifiedOutcome.text).toMatch(/DocMDP level 1/);
  });

  it("fills only the requested field: another field without an appearance is left alone", async () => {
    // Exclude-lock everything but full_name, and strip company's appearance,
    // which pdf-lib's form-wide update would otherwise regenerate.
    const file = path.join(directory, "exclude-lock.pdf");
    await fs.writeFile(file, await signedFixtureWith(doc => {
      signatureField(doc).set(PDFName.of("Lock"), doc.context.obj({
        Type: "SigFieldLock", Action: "Exclude", Fields: [PDFString.of("full_name")],
      }));
      const company = doc.getForm().getTextField("company");
      for (const widget of company.acroField.getWidgets()) widget.dict.delete(PDFName.of("AP"));
    }));
    const output = path.join(directory, "exclude-lock-out.pdf");
    const { structured } = await succeed("fill_pdf", {
      pdf_path: file, output_path: output, field_data: { full_name: "Allowed" },
    });
    expect(structured.save_mode).toBe("incremental");
    const before = await PDFDocument.load(await fs.readFile(file), { updateMetadata: false });
    const after = await PDFDocument.load(await fs.readFile(output), { updateMetadata: false });
    const companyBefore = before.getForm().getTextField("company").acroField.getWidgets()[0].dict;
    const companyAfter = after.getForm().getTextField("company").acroField.getWidgets()[0].dict;
    expect(companyAfter.has(PDFName.of("AP"))).toBe(companyBefore.has(PDFName.of("AP")));
    if (hasOpenssl()) expect(await signatureVerifies(output, directory)).toBe(true);
  });

  it("enforces a FieldMDP lock declared only in the signature's references", async () => {
    const file = path.join(directory, "reference-lock.pdf");
    await fs.writeFile(file, await signedFixtureWith(doc => {
      const signature = doc.context.lookup(signatureField(doc).get(PDFName.of("V")));
      signature.set(PDFName.of("Reference"), doc.context.obj([doc.context.obj({
        Type: "SigRef", TransformMethod: "FieldMDP",
        TransformParams: doc.context.obj({ Type: "TransformParams", Action: "Include", Fields: [PDFString.of("company")] }),
      })]));
    }));
    const outcome = await call("fill_pdf", {
      pdf_path: file, output_path: path.join(directory, "reference-lock-out.pdf"), field_data: { company: "Changed" },
    });
    expect(outcome.isError).toBe(true);
    expect(outcome.text).toMatch(/'company' is locked by an existing signature/);
  });

  it("refuses a signed XFA form rather than dropping or contradicting its XFA layer", async () => {
    const file = path.join(directory, "signed-xfa.pdf");
    await fs.writeFile(file, await signedFixtureWith(doc => {
      const xfa = doc.context.register(doc.context.stream("<xdp:xdp xmlns:xdp=\"http://ns.adobe.com/xdp/\"/>"));
      doc.catalog.lookup(PDFName.of("AcroForm")).set(PDFName.of("XFA"), xfa);
    }));
    const outcome = await call("fill_pdf", {
      pdf_path: file, output_path: path.join(directory, "signed-xfa-out.pdf"), field_data: { full_name: "Nope" },
    });
    expect(outcome.isError).toBe(true);
    expect(outcome.text).toMatch(/carries an XFA form/);
  });

  it("fills each row of a signed template by appending", async () => {
    const template = path.join(directory, "template.pdf");
    const csv = path.join(directory, "rows.csv");
    await fs.copyFile(SIGNED_FIXTURE, template);
    await fs.writeFile(csv, "filename,full_name\nrow-one,\"Example, Jane\"\nrow-two,Sam Example\n");
    const outputDirectory = path.join(directory, "bulk");
    const { text, structured } = await succeed("bulk_fill_from_csv", {
      pdf_path: template, csv_path: csv, output_directory: outputDirectory, filename_column: "filename",
    });
    expect(text).toContain("each fill was appended as an incremental update");
    for (const row of structured.results) {
      expect(row.fields_filled).toBe(1);
      if (hasOpenssl()) expect(await signatureVerifies(row.output_path, directory)).toBe(true);
    }
    expect(await textValue(structured.results[0].output_path, "full_name")).toBe("Example, Jane");
  });

  it("still rewrites an unsigned form, and no longer reports a non-fillable field as filled", async () => {
    const doc = await PDFDocument.create();
    const page = doc.addPage([400, 400]);
    const form = doc.getForm();
    form.createTextField("name").addToPage(page, { x: 20, y: 300, width: 200, height: 20 });
    form.createButton("submit").addToPage("Submit", page, { x: 20, y: 250, width: 80, height: 20 });
    const source = path.join(directory, "unsigned.pdf");
    await fs.writeFile(source, await doc.save());
    const { structured } = await succeed("fill_pdf", {
      pdf_path: source, output_path: path.join(directory, "unsigned-out.pdf"), field_data: { name: "A", submit: "x" },
    });
    expect(structured).toMatchObject({ save_mode: "rewrite", signatures_kept: 0, filled_fields: ["name"] });
    expect(structured.fill_errors.join(" ")).toMatch(/'submit': is not a fillable field/);
  });

  it("an empty signature field is not a signature: stamping text is not refused", async () => {
    const doc = await PDFDocument.create();
    const page = doc.addPage([400, 400]);
    const context = doc.context;
    const field = context.register(context.obj({
      Type: "Annot", Subtype: "Widget", FT: "Sig", T: PDFString.of("sign_here"),
      Rect: [20, 20, 200, 60], F: 4, P: page.ref,
    }));
    page.node.addAnnot(field);
    doc.catalog.getOrCreateAcroForm().addField(field);
    const source = path.join(directory, "empty-sig-field.pdf");
    await fs.writeFile(source, await doc.save());
    const { text } = await succeed("apply_text", {
      pdf_path: source, output_path: path.join(directory, "stamped.pdf"),
      page: 1, x: 20, y: 20, width: 200, height: 20, text: "2026-11-25",
    });
    expect(text).not.toMatch(/cryptographic signature/);
  });
});
