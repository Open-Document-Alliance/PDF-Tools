#!/usr/bin/env node
// Build test/fixtures/signing/signed-form.pdf: a small synthetic AcroForm with
// one prefilled text field, one empty text field, and an approval signature
// (adbe.pkcs7.detached) made with a throwaway self-signed key that is
// generated here and discarded. Nothing in it is real or trusted.
//
// The fixture exists so tests can prove that a change to a signed document
// leaves the signature verifying. It is committed rather than built per test
// because building it needs the openssl CLI; verifying it in a test needs only
// `openssl cms -verify`, and tests skip that step when openssl is absent.
//
// Usage: node scripts/make-signed-form-fixture.mjs [output-directory]

import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { PDFDocument, PDFHexString, PDFName, PDFNumber, PDFString, StandardFonts } from "pdf-lib";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const OUTPUT_DIRECTORY = path.resolve(process.argv[2] ?? path.join(REPO_ROOT, "test/fixtures/signing"));
const CONTENTS_HEX_LENGTH = 16_384;
const PLACEHOLDER = 9_999_999_999;

async function build() {
  const doc = await PDFDocument.create();
  doc.setTitle("Synthetic Signed Form");
  doc.setAuthor("PDF Tools test fixture");
  const page = doc.addPage([612, 792]);
  const font = await doc.embedFont(StandardFonts.Helvetica);
  page.drawText("SIGNED-FORM-SENTINEL", { x: 72, y: 720, size: 14, font });
  page.drawText("Full name", { x: 72, y: 650, size: 10, font });
  page.drawText("Company", { x: 72, y: 600, size: 10, font });
  page.drawText("Approver signature", { x: 72, y: 520, size: 10, font });
  const form = doc.getForm();
  const fullName = form.createTextField("full_name");
  fullName.addToPage(page, { x: 160, y: 640, width: 260, height: 20 });
  const company = form.createTextField("company");
  company.setText("Example Widgets LLC");
  company.addToPage(page, { x: 160, y: 590, width: 260, height: 20 });
  form.updateFieldAppearances();

  const context = doc.context;
  const signatureRef = context.register(context.obj({
    Type: PDFName.of("Sig"),
    Filter: PDFName.of("Adobe.PPKLite"),
    SubFilter: PDFName.of("adbe.pkcs7.detached"),
    ByteRange: context.obj([0, PLACEHOLDER, PLACEHOLDER, PLACEHOLDER]),
    Contents: PDFHexString.of("0".repeat(CONTENTS_HEX_LENGTH)),
    M: PDFString.fromDate(new Date("2026-11-25T00:00:00Z")),
    Name: PDFString.of("Synthetic Test Signer"),
  }));
  const fieldRef = context.register(context.obj({
    Type: PDFName.of("Annot"),
    Subtype: PDFName.of("Widget"),
    FT: PDFName.of("Sig"),
    T: PDFString.of("approver_signature"),
    V: signatureRef,
    Rect: context.obj([160, 505, 420, 535]),
    F: PDFNumber.of(132),
    P: page.ref,
  }));
  page.node.addAnnot(fieldRef);
  const acroForm = doc.catalog.getOrCreateAcroForm();
  acroForm.addField(fieldRef);
  acroForm.dict.set(PDFName.of("SigFlags"), PDFNumber.of(3));
  return doc.save({ useObjectStreams: false });
}

function sign(bytes, directory) {
  const latin = Buffer.from(bytes).toString("latin1");
  const placeholder = `[ 0 ${PLACEHOLDER} ${PLACEHOLDER} ${PLACEHOLDER} ]`;
  const byteRangeAt = latin.indexOf(placeholder);
  const contentsAt = latin.indexOf(`<${"0".repeat(CONTENTS_HEX_LENGTH)}>`);
  if (byteRangeAt < 0 || contentsAt < 0) throw new Error("Signature placeholders not found.");
  const gapStart = contentsAt;
  const gapEnd = contentsAt + CONTENTS_HEX_LENGTH + 2;
  const range = [0, gapStart, gapEnd, bytes.length - gapEnd];
  const width = placeholder.length;
  const filled = `[ ${range.join(" ")} ]`.padEnd(width, " ");
  if (filled.length !== width) throw new Error("ByteRange does not fit its placeholder.");
  const out = Buffer.from(bytes);
  out.write(filled, byteRangeAt, "latin1");

  const key = path.join(directory, "key.pem");
  const certificate = path.join(directory, "cert.pem");
  const content = path.join(directory, "content.bin");
  const der = path.join(directory, "sig.der");
  execFileSync("openssl", ["req", "-x509", "-newkey", "rsa:2048", "-nodes", "-days", "3650",
    "-subj", "/CN=PDF Tools synthetic test signer (not trusted)", "-keyout", key, "-out", certificate], { stdio: "ignore" });
  return fs.writeFile(content, Buffer.concat([out.subarray(0, gapStart), out.subarray(gapEnd)])).then(() => {
    execFileSync("openssl", ["cms", "-sign", "-binary", "-noattr", "-nosmimecap", "-md", "sha256", "-outform", "DER",
      "-signer", certificate, "-inkey", key, "-in", content, "-out", der], { stdio: "ignore" });
    return fs.readFile(der);
  }).then(signature => {
    const hex = signature.toString("hex");
    if (hex.length > CONTENTS_HEX_LENGTH) throw new Error("Signature does not fit its placeholder.");
    out.write(hex, gapStart + 1, "latin1");
    return out;
  });
}

const temporary = await fs.mkdtemp(path.join(os.tmpdir(), "pdf-tools-signed-fixture-"));
try {
  const signed = await sign(await build(), temporary);
  await fs.mkdir(OUTPUT_DIRECTORY, { recursive: true });
  await fs.writeFile(path.join(OUTPUT_DIRECTORY, "signed-form.pdf"), signed);
  await fs.writeFile(path.join(OUTPUT_DIRECTORY, "signed-form.provenance.json"), `${JSON.stringify({
    generator: "scripts/make-signed-form-fixture.mjs",
    description: "Synthetic AcroForm with an approval signature from a throwaway self-signed key generated and discarded at build time. Not trusted; contains no real data.",
    sha256: createHash("sha256").update(signed).digest("hex"),
    fields: { full_name: "", company: "Example Widgets LLC", approver_signature: "signed" },
  }, null, 2)}\n`);
  console.log(`wrote ${path.join(OUTPUT_DIRECTORY, "signed-form.pdf")} (${signed.length} bytes)`);
} finally {
  await fs.rm(temporary, { recursive: true, force: true });
}
