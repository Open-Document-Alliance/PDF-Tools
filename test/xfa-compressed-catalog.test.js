// Regression for issue #200: `detectXfaForm` scans raw bytes, so a document
// whose catalog and AcroForm live inside a compressed object stream never
// shows `/XFA` and the guard never fires — which is most modern government
// forms, the population the guard exists for. A fixture written the plain way
// passes the old implementation, so every fixture here is built with
// `useObjectStreams: true` and the byte scan is asserted to miss it.

import fs from "fs/promises";
import path from "path";
import { fileURLToPath } from "url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { PDFArray, PDFDocument, PDFName, PDFString, StandardFonts } from "pdf-lib";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { createTestTempDirectory, removeTestTempDirectory } from "./helpers/temp-directory.js";
import {
  detectXfaForm,
  detectXfaFormInDocument,
} from "../server/helpers.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.join(__dirname, "..");
const EXAMPLE_PDF = path.join(REPO_ROOT, "example-fw9.pdf");
const FIELD_NAME = "topmostSubform[0].Page1[0].f1_01[0]";

// Builds a one-page AcroForm PDF that also carries an XFA packet, saved with
// object streams so the catalog and AcroForm are compressed. This is the shape
// the IRS W-9 has; the point of the fixture is that `/XFA` is unreadable in the
// file's plain bytes.
async function buildCompressedCatalogXfaPdf({ dynamic = false } = {}) {
  const doc = await PDFDocument.create();
  const page = doc.addPage([612, 792]);
  const font = await doc.embedFont(StandardFonts.Helvetica);
  page.drawText("Compressed-catalog XFA fixture", { x: 60, y: 700, size: 14, font });
  const field = doc.getForm().createTextField(FIELD_NAME);
  field.setText("");
  field.addToPage(page, { x: 60, y: 640, width: 300, height: 20, font });

  const acroForm = doc.catalog.lookup(PDFName.of("AcroForm"));
  const packet = doc.context.flateStream(
    Buffer.from('<xdp:xdp xmlns:xdp="http://ns.adobe.com/xdp/"></xdp:xdp>', "utf8"),
  );
  const xfa = PDFArray.withContext(doc.context);
  xfa.push(PDFString.of("xdp"));
  xfa.push(doc.context.register(packet));
  acroForm.set(PDFName.of("XFA"), xfa);
  if (dynamic) doc.catalog.set(PDFName.of("NeedsRendering"), doc.context.obj(true));

  return Buffer.from(await doc.save({ useObjectStreams: true, updateFieldAppearances: false }));
}

function textOf(response) {
  return response.content?.map(item => (item.type === "text" ? item.text : "")).join(" ") ?? "";
}

describe("XFA hidden in a compressed catalog (issue #200)", () => {
  let TMP_DIR;
  let client;
  let transport;
  let staticPath;
  let dynamicPath;
  let staticBytes;
  let dynamicBytes;

  beforeAll(async () => {
    TMP_DIR = await createTestTempDirectory(REPO_ROOT, "xfa-objstm");
    staticBytes = await buildCompressedCatalogXfaPdf({ dynamic: false });
    dynamicBytes = await buildCompressedCatalogXfaPdf({ dynamic: true });
    staticPath = path.join(TMP_DIR, "xfa-static-objstm.pdf");
    dynamicPath = path.join(TMP_DIR, "xfa-dynamic-objstm.pdf");
    await fs.writeFile(staticPath, staticBytes);
    await fs.writeFile(dynamicPath, dynamicBytes);

    client = new Client({ name: "pdf-tools-xfa-objstm-client", version: "1.0.0" });
    transport = new StdioClientTransport({
      command: process.execPath,
      args: [path.join(REPO_ROOT, "server", "index.js")],
      cwd: REPO_ROOT,
      env: { ALLOWED_DIRECTORIES: `${REPO_ROOT}:${TMP_DIR}` },
      stderr: "pipe",
    });
    await client.connect(transport);
  }, 60_000);

  afterAll(async () => {
    try {
      await transport?.close();
    } finally {
      await removeTestTempDirectory(TMP_DIR);
    }
  });

  it("the fixture really does hide /XFA from the raw byte scan", () => {
    for (const bytes of [staticBytes, dynamicBytes]) {
      expect(bytes.toString("latin1")).not.toContain("/XFA");
      expect(detectXfaForm(bytes)).toBe(false);
    }
  });

  it("the parse-time check sees what the byte scan cannot, and names the dynamic case", async () => {
    const staticDoc = await PDFDocument.load(staticBytes, { updateMetadata: false });
    expect(detectXfaFormInDocument(staticDoc)).toEqual({ present: true, dynamic: false });

    const dynamicDoc = await PDFDocument.load(dynamicBytes, { updateMetadata: false });
    expect(detectXfaFormInDocument(dynamicDoc)).toEqual({ present: true, dynamic: true });

    const plain = await PDFDocument.load(await fs.readFile(EXAMPLE_PDF), { updateMetadata: false });
    expect(detectXfaFormInDocument(plain)).toEqual({ present: false, dynamic: false });
  });

  it("detectXfaFormInDocument does not invent a refusal for a document it cannot walk", () => {
    expect(detectXfaFormInDocument(null)).toEqual({ present: false, dynamic: false });
    expect(detectXfaFormInDocument({})).toEqual({ present: false, dynamic: false });
    expect(detectXfaFormInDocument({
      catalog: { lookup() { throw new Error("unwalkable"); } },
    })).toEqual({ present: false, dynamic: false });
  });

  it("fill_pdf fills the compressed-catalog XFA form, which is the live IRS shape", async () => {
    const filled = await client.callTool({
      name: "fill_pdf",
      arguments: {
        pdf_path: staticPath,
        output_path: path.join(TMP_DIR, "static-filled.pdf"),
        field_data: { [FIELD_NAME]: "Jordan Sample" },
      },
    });
    // Static XFA keeps its values in the AcroForm, so the fill is correct and
    // refusing it would break an ordinary job to prevent nothing. What the
    // document does lose is the XFA layer, and the result has to say so.
    expect(textOf(filled)).toContain("PDF filled successfully");
    await expect(fs.access(path.join(TMP_DIR, "static-filled.pdf"))).resolves.toBeUndefined();
  }, 60_000);

  it("the dynamic refusal says why stripping that document is worse", async () => {
    const refused = await client.callTool({
      name: "fill_pdf",
      arguments: {
        pdf_path: dynamicPath,
        output_path: path.join(TMP_DIR, "dynamic-refused.pdf"),
        field_data: { [FIELD_NAME]: "Jordan Sample" },
      },
    });
    const message = textOf(refused);
    expect(message).toContain("This PDF uses XFA forms");
    expect(message).toContain("/NeedsRendering");
  }, 60_000);

  it("apply_page_plan runs on a static XFA document and refuses a dynamic one", async () => {
    const allowed = await client.callTool({
      name: "apply_page_plan",
      arguments: {
        input_path: staticPath,
        output_path: path.join(TMP_DIR, "plan-static.pdf"),
        plan: { page_order: [1] },
      },
    });
    expect(textOf(allowed)).toContain("Saved 1-page PDF");

    const refused = await client.callTool({
      name: "apply_page_plan",
      arguments: {
        input_path: dynamicPath,
        output_path: path.join(TMP_DIR, "plan-dynamic.pdf"),
        plan: { page_order: [1] },
      },
    });
    expect(textOf(refused)).toContain("This PDF uses XFA forms");
    expect(textOf(refused)).toContain("/NeedsRendering");
  }, 60_000);

  it("a document with no XFA is not refused", async () => {
    const filled = await client.callTool({
      name: "fill_pdf",
      arguments: {
        pdf_path: EXAMPLE_PDF,
        output_path: path.join(TMP_DIR, "plain-filled.pdf"),
        field_data: { "topmostSubform[0].Page1[0].f1_1[0]": "Jordan Sample" },
      },
    });
    expect(textOf(filled)).toContain("PDF filled successfully");
  }, 60_000);
});
