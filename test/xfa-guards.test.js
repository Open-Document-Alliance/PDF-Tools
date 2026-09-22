import fs from "fs/promises";
import path from "path";
import { fileURLToPath } from "url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { createTestTempDirectory, removeTestTempDirectory } from "./helpers/temp-directory.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.join(__dirname, "..");
const EXAMPLE_PDF = path.join(REPO_ROOT, "example-fw9.pdf");
let TMP_DIR;

/**
 * Mark a document as dynamic XFA. A dynamic form is built from the XFA layer,
 * so dropping that layer can leave a reader showing a placeholder, which is the
 * case the refusal is for.
 */
function insertDynamicXfaMarker(pdfBuffer) {
  const marked = insertFakeXfaMarker(pdfBuffer);
  const newlineIndex = marked.indexOf("\n");
  return Buffer.concat([
    marked.subarray(0, newlineIndex + 1),
    Buffer.from("% synthetic dynamic marker /NeedsRendering true\n", "utf8"),
    marked.subarray(newlineIndex + 1),
  ]);
}

function insertFakeXfaMarker(pdfBuffer) {
  const header = "%PDF-";
  const headerIndex = pdfBuffer.indexOf(header);
  if (headerIndex !== 0) {
    throw new Error("Expected a standard PDF header.");
  }
  const newlineIndex = pdfBuffer.indexOf("\n");
  if (newlineIndex === -1) {
    throw new Error("Expected a newline after the PDF header.");
  }
  const marker = Buffer.from("% synthetic xfa marker /XFA <\n", "utf8");
  return Buffer.concat([
    pdfBuffer.subarray(0, newlineIndex + 1),
    marker,
    pdfBuffer.subarray(newlineIndex + 1),
  ]);
}

describe("XFA guards for mutating tools", () => {
  let client;
  let transport;
  let xfaPdfPath;
  let dynamicXfaPdfPath;
  let csvPath;

  beforeAll(async () => {
    TMP_DIR = await createTestTempDirectory(REPO_ROOT, "xfa");
    const source = await fs.readFile(EXAMPLE_PDF);
    xfaPdfPath = path.join(TMP_DIR, "xfa-flagged.pdf");
    await fs.writeFile(xfaPdfPath, insertFakeXfaMarker(source));
    dynamicXfaPdfPath = path.join(TMP_DIR, "xfa-dynamic.pdf");
    await fs.writeFile(dynamicXfaPdfPath, insertDynamicXfaMarker(source));
    csvPath = path.join(TMP_DIR, "fill.csv");
    await fs.writeFile(
      csvPath,
      "topmostSubform[0].Page1[0].f1_1[0]\nSmoke Test User\n",
      "utf8"
    );

    client = new Client({ name: "pdf-tools-xfa-test-client", version: "1.0.0" });
    transport = new StdioClientTransport({
      command: process.execPath,
      args: [path.join(REPO_ROOT, "server", "index.js")],
      cwd: REPO_ROOT,
      env: {
        ALLOWED_DIRECTORIES: REPO_ROOT,
      },
      stderr: "pipe",
    });
    await client.connect(transport);
  }, 30_000);

  afterAll(async () => {
    try {
      await transport?.close();
    } finally {
      await removeTestTempDirectory(TMP_DIR);
    }
  });

  it("fill_pdf refuses a dynamic XFA PDF unless force_xfa=true", async () => {
    const rejected = await client.callTool({
      name: "fill_pdf",
      arguments: {
        pdf_path: dynamicXfaPdfPath,
        output_path: path.join(TMP_DIR, "filled-rejected.pdf"),
        field_data: {
          "topmostSubform[0].Page1[0].f1_1[0]": "Smoke Test User",
        },
      },
    });
    const rejectText = rejected.content?.map(item => item.type === "text" ? item.text : "").join(" ");
    expect(rejectText).toContain("dynamic XFA form");

    const allowed = await client.callTool({
      name: "fill_pdf",
      arguments: {
        pdf_path: dynamicXfaPdfPath,
        output_path: path.join(TMP_DIR, "filled-allowed.pdf"),
        field_data: {
          "topmostSubform[0].Page1[0].f1_1[0]": "Smoke Test User",
        },
        force_xfa: true,
      },
    });
    expect(allowed.content?.map(item => item.type === "text" ? item.text : "").join(" ")).toContain("PDF filled successfully");
  }, 30_000);

  it("fill_pdf fills a static XFA PDF, which is what the live IRS forms are", async () => {
    const filled = await client.callTool({
      name: "fill_pdf",
      arguments: {
        pdf_path: xfaPdfPath,
        output_path: path.join(TMP_DIR, "filled-static-xfa.pdf"),
        field_data: {
          "topmostSubform[0].Page1[0].f1_1[0]": "Smoke Test User",
        },
      },
    });
    const text = filled.content?.map(item => item.type === "text" ? item.text : "").join(" ");
    expect(text).toContain("PDF filled successfully");
    expect(text).not.toContain("dynamic XFA form");
  }, 30_000);

  it("bulk_fill_from_csv refuses a dynamic XFA PDF unless force_xfa=true", async () => {
    const rejected = await client.callTool({
      name: "bulk_fill_from_csv",
      arguments: {
        pdf_path: dynamicXfaPdfPath,
        csv_path: csvPath,
        output_directory: path.join(TMP_DIR, "bulk-rejected"),
      },
    });
    const rejectText = rejected.content?.map(item => item.type === "text" ? item.text : "").join(" ");
    expect(rejectText).toContain("dynamic XFA form");

    const allowed = await client.callTool({
      name: "bulk_fill_from_csv",
      arguments: {
        pdf_path: dynamicXfaPdfPath,
        csv_path: csvPath,
        output_directory: path.join(TMP_DIR, "bulk-allowed"),
        force_xfa: true,
      },
    });
    expect(allowed.content?.map(item => item.type === "text" ? item.text : "").join(" ")).toContain("Bulk fill complete");
  }, 30_000);

  it("apply_page_plan refuses a dynamic XFA PDF unless force_xfa=true", async () => {
    const rejected = await client.callTool({
      name: "apply_page_plan",
      arguments: {
        input_path: dynamicXfaPdfPath,
        output_path: path.join(TMP_DIR, "plan-rejected.pdf"),
        plan: {
          page_order: [1],
        },
      },
    });
    const rejectText = rejected.content?.map(item => item.type === "text" ? item.text : "").join(" ");
    expect(rejectText).toContain("dynamic XFA form");

    const allowed = await client.callTool({
      name: "apply_page_plan",
      arguments: {
        input_path: dynamicXfaPdfPath,
        output_path: path.join(TMP_DIR, "plan-allowed.pdf"),
        plan: {
          page_order: [1],
        },
        force_xfa: true,
      },
    });
    const okText = allowed.content?.map(item => item.type === "text" ? item.text : "").join(" ");
    expect(okText).toContain("Saved 1-page PDF");
  }, 30_000);
});
