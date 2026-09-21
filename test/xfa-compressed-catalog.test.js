/**
 * The XFA guard has to see XFA that a document hides from a byte scan.
 *
 * A PDF written with a compressed cross-reference table keeps its catalog, and
 * therefore /XFA, inside a Flate-compressed /ObjStm. The scan that only read
 * raw bytes returned false for every such document, so `force_xfa` was
 * unreachable for the population it was written for: modern government forms.
 *
 * These tests build that shape locally rather than fetching a live form, so
 * they neither need the network nor drift when the IRS reissues a PDF.
 */

import { deflateSync } from "node:zlib";

import { PDFDocument } from "pdf-lib";
import { describe, expect, it } from "vitest";

import {
  assertXfaMutationAllowed,
  detectDynamicXfaForm,
  detectXfaForm,
  XFA_DYNAMIC_NOTICE,
  XFA_STATIC_NOTICE,
} from "../server/helpers.js";

/**
 * A document whose /XFA sits in raw bytes, which the old scan already caught.
 * Written by hand rather than through pdf-lib, because pdf-lib strips XFA on
 * the way out: the call that builds a form is the call that deletes the thing
 * under test.
 */
function plainXfaDocument({ dynamic = false } = {}) {
  return Buffer.from(
    "%PDF-1.7\n"
      + "1 0 obj\n<< /Type /Catalog /AcroForm 2 0 R"
      + (dynamic ? " /NeedsRendering true" : "")
      + " >>\nendobj\n"
      + "2 0 obj\n<< /Fields [] /XFA [ (preamble) 3 0 R ] >>\nendobj\n"
      + "trailer\n<< /Root 1 0 R >>\n%%EOF",
    "latin1",
  );
}

/**
 * A document with a Flate-compressed object stream that mentions /XFA, which
 * is the shape the plain scan cannot see through.
 */
function compressedCatalogDocument() {
  const payload = deflateSync(
    Buffer.from("<< /Type /Catalog /AcroForm << /XFA [ (preamble) 9 0 R ] >> >>", "latin1"),
  );
  const header = Buffer.from(
    "%PDF-1.7\n1 0 obj\n<< /Type /ObjStm /N 1 /First 6 /Filter /FlateDecode /Length "
      + `${payload.length} >>\nstream\n`,
    "latin1",
  );
  const footer = Buffer.from("\nendstream\nendobj\ntrailer\n<< /Root 1 0 R >>\n%%EOF", "latin1");
  return Buffer.concat([header, payload, footer]);
}

describe("detectXfaForm", () => {
  it("still catches XFA written in the clear", () => {
    expect(detectXfaForm(plainXfaDocument())).toBe(true);
  });

  it("catches XFA hidden in a compressed object stream", () => {
    const document = compressedCatalogDocument();
    // The bytes themselves give nothing away, which is the whole bug.
    expect(document.toString("latin1")).not.toMatch(/\/XFA/);
    expect(detectXfaForm(document)).toBe(true);
  });

  it("leaves an ordinary document alone", async () => {
    const document = await PDFDocument.create();
    document.addPage([200, 200]);
    expect(detectXfaForm(Buffer.from(await document.save()))).toBe(false);
  });

  it("says nothing about a document too small to be a PDF", () => {
    expect(detectXfaForm(Buffer.from("%PDF"))).toBe(false);
    expect(detectXfaForm(null)).toBe(false);
  });

  it("does not inflate an implausible stream length", () => {
    const lying = Buffer.concat([
      Buffer.from("%PDF-1.7\n1 0 obj\n<< /Type /ObjStm /Filter /FlateDecode >>\nstream\n", "latin1"),
      Buffer.alloc(64, 0x00),
      Buffer.from("\nendstream\n%%EOF", "latin1"),
    ]);
    expect(detectXfaForm(lying)).toBe(false);
  });
});

describe("assertXfaMutationAllowed", () => {
  it("allows a static XFA document and returns a notice the caller can pass on", () => {
    const notice = assertXfaMutationAllowed(plainXfaDocument());
    expect(notice).toBe(XFA_STATIC_NOTICE);
    expect(notice).toMatch(/values live in the AcroForm and are preserved/);
  });

  it("refuses a dynamic XFA document, because its pages come from the layer being dropped", () => {
    const dynamic = plainXfaDocument({ dynamic: true });
    expect(detectDynamicXfaForm(dynamic)).toBe(true);
    expect(() => assertXfaMutationAllowed(dynamic)).toThrow(/dynamic XFA form/);
  });

  it("lets force_xfa through the dynamic refusal, still saying what it costs", () => {
    const dynamic = plainXfaDocument({ dynamic: true });
    expect(assertXfaMutationAllowed(dynamic, { forceXfa: true })).toBe(XFA_DYNAMIC_NOTICE);
  });

  it("returns nothing for a document with no XFA at all", async () => {
    const document = await PDFDocument.create();
    document.addPage([200, 200]);
    expect(assertXfaMutationAllowed(Buffer.from(await document.save()))).toBeNull();
  });
});
