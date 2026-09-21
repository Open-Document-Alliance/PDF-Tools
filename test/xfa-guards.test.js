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
  let csvPath;

  beforeAll(async () => {
    TMP_DIR = await createTestTempDirectory(REPO_ROOT, "xfa");
    const source = await fs.readFile(EXAMPLE_PDF);
    xfaPdfPath = path.join(TMP_DIR, "xfa-flagged.pdf");
    await fs.writeFile(xfaPdfPath, insertFakeXfaMarker(source));
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

  it("fill_pdf rejects XFA PDFs unless force_xfa=true", async () => {
    const rejected = await client.callTool({
      name: "fill_pdf",
      arguments: {
        pdf_path: xfaPdfPath,
        output_path: path.join(TMP_DIR, "filled-rejected.pdf"),
        field_data: {
          "topmostSubform[0].Page1[0].f1_1[0]": "Smoke Test User",
        },
      },
    });
    const rejectText = rejected.content?.map(item => item.type === "text" ? item.text : "").join(" ");
    expect(rejectText).toContain("This PDF uses XFA forms");

    const allowed = await client.callTool({
      name: "fill_pdf",
      arguments: {
        pdf_path: xfaPdfPath,
        output_path: path.join(TMP_DIR, "filled-allowed.pdf"),
        field_data: {
          "topmostSubform[0].Page1[0].f1_1[0]": "Smoke Test User",
        },
        force_xfa: true,
      },
    });
    expect(allowed.content?.map(item => item.type === "text" ? item.text : "").join(" ")).toContain("PDF filled successfully");
  }, 30_000);

  it("bulk_fill_from_csv rejects XFA PDFs unless force_xfa=true", async () => {
    const rejected = await client.callTool({
      name: "bulk_fill_from_csv",
      arguments: {
        pdf_path: xfaPdfPath,
        csv_path: csvPath,
        output_directory: path.join(TMP_DIR, "bulk-rejected"),
      },
    });
    const rejectText = rejected.content?.map(item => item.type === "text" ? item.text : "").join(" ");
    expect(rejectText).toContain("This PDF uses XFA forms");

    const allowed = await client.callTool({
      name: "bulk_fill_from_csv",
      arguments: {
        pdf_path: xfaPdfPath,
        csv_path: csvPath,
        output_directory: path.join(TMP_DIR, "bulk-allowed"),
        force_xfa: true,
      },
    });
    expect(allowed.content?.map(item => item.type === "text" ? item.text : "").join(" ")).toContain("Bulk fill complete");
  }, 30_000);

  it("apply_page_plan rejects XFA PDFs unless force_xfa=true", async () => {
    const rejected = await client.callTool({
      name: "apply_page_plan",
      arguments: {
        input_path: xfaPdfPath,
        output_path: path.join(TMP_DIR, "plan-rejected.pdf"),
        plan: {
          page_order: [1],
        },
      },
    });
    const rejectText = rejected.content?.map(item => item.type === "text" ? item.text : "").join(" ");
    expect(rejectText).toContain("This PDF uses XFA forms");

    const allowed = await client.callTool({
      name: "apply_page_plan",
      arguments: {
        input_path: xfaPdfPath,
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

// ─── Wiring coverage for `assertXfaMutationAllowed` ──────────────────────────
//
// The three cases above drive three tools. The guard is wired at SEVEN call
// sites in server/index.js. Deleting any one of the other four — the
// add_signature_field, apply_signature, prepare_signing_packet or apply_text
// site — left this file green at 3 of 3, and left every other suite in the
// repository that names those four tools green as well. Four wired guards had
// no coverage of their wiring anywhere. (Method: to find out whether a guard
// is covered, delete the guard from the product, not the feature, and run the
// suites that ought to catch it.)
//
// This block pins the wiring as an identity between three independently
// derived sets rather than as a list of tool names, so widening or narrowing
// the guarded set later stays green and only a HALF-wired change turns it red:
//
//   A  source     — tool cases in server/index.js containing an
//                   `assertXfaMutationAllowed(` call
//   B  schema     — tools whose live `tools/list` inputSchema declares force_xfa
//   C  behaviour  — tools that actually refuse an XFA-marked document
//
// A === B === C. A call site added without the parameter, a parameter added
// without the call site, and a call site that no longer fires are each red.
//
// KNOWN GAP, deliberately NOT pinned: five further pdf-lib mutation tools
// (fill_with_profile, merge_pdfs, reorder_pdf_pages, rotate_pdf_pages,
// split_pdf) carry no XFA guard at all and are absent from all three sets, so
// they stay consistent here. Pinning their absence would make the eventual fix
// read as a regression.
describe("XFA guard wiring: schema, source and behaviour name the same tools", () => {
  let client;
  let transport;
  let TMP;
  let xfaPdfPath;
  let csvPath;

  const SIGNATURE_NAME = "xfa-wiring-probe";
  const REFUSAL = "This PDF uses XFA forms";

  // Minimum arguments that reach the guard. Every one of these calls must get
  // past argument normalization, or the tool reads as "does not enforce" for
  // the wrong reason — which this block's own diff makes visible, because a
  // non-refusing tool is reported with the text it returned instead.
  function argsFor(name, { force } = {}) {
    const out = suffix => path.join(TMP, `${name}-${suffix}.pdf`);
    const tag = force ? "forced" : "plain";
    const box = { page: 1, x: 100, y: 100, width: 150, height: 40 };
    const base = {
      fill_pdf: {
        pdf_path: xfaPdfPath,
        output_path: out(tag),
        field_data: { "topmostSubform[0].Page1[0].f1_1[0]": "Wiring Probe" },
      },
      bulk_fill_from_csv: {
        pdf_path: xfaPdfPath,
        csv_path: csvPath,
        output_directory: path.join(TMP, `bulk-${tag}`),
      },
      apply_page_plan: {
        input_path: xfaPdfPath,
        output_path: out(tag),
        plan: { page_order: [1] },
      },
      add_signature_field: { pdf_path: xfaPdfPath, output_path: out(tag), ...box },
      apply_signature: {
        pdf_path: xfaPdfPath,
        output_path: out(tag),
        signature_name: SIGNATURE_NAME,
        ...box,
        user_intent_statement: "I confirm this XFA guard wiring probe signature.",
        user_confirmed_at: new Date().toISOString(),
      },
      prepare_signing_packet: { pdf_path: xfaPdfPath, output_path: out(tag) },
      apply_text: { pdf_path: xfaPdfPath, output_path: out(tag), ...box, text: "probe" },
    }[name];
    if (!base) {
      throw new Error(
        `No probe arguments for "${name}". A tool gained force_xfa without gaining ` +
        `a case here; add one that reaches assertXfaMutationAllowed.`
      );
    }
    return force ? { ...base, force_xfa: true } : base;
  }

  function textOf(result) {
    return (result.content || [])
      .map(item => (item.type === "text" ? item.text : ""))
      .join(" ");
  }

  beforeAll(async () => {
    TMP = await createTestTempDirectory(REPO_ROOT, "xfa-wiring");
    const source = await fs.readFile(EXAMPLE_PDF);
    xfaPdfPath = path.join(TMP, "xfa-flagged.pdf");
    await fs.writeFile(xfaPdfPath, insertFakeXfaMarker(source));
    csvPath = path.join(TMP, "fill.csv");
    await fs.writeFile(
      csvPath,
      "topmostSubform[0].Page1[0].f1_1[0]\nWiring Probe\n",
      "utf8"
    );

    client = new Client({ name: "pdf-tools-xfa-wiring-client", version: "1.0.0" });
    transport = new StdioClientTransport({
      command: process.execPath,
      args: [path.join(REPO_ROOT, "server", "index.js")],
      cwd: REPO_ROOT,
      env: {
        ALLOWED_DIRECTORIES: REPO_ROOT,
        // apply_signature needs a stored signature; keep it inside the temp
        // tree so the probe never touches the real ~/.pdf-toolkit-files.
        DEFAULT_PROFILES_DIR: path.join(TMP, "profiles"),
      },
      stderr: "pipe",
    });
    await client.connect(transport);

    const created = await client.callTool({
      name: "create_signature",
      arguments: { name: SIGNATURE_NAME, display_name: "Wiring Probe", overwrite: true },
    });
    expect(textOf(created)).not.toContain("Error");
  }, 30_000);

  afterAll(async () => {
    try {
      await transport?.close();
    } finally {
      await removeTestTempDirectory(TMP);
    }
  });

  it("declares, wires and enforces force_xfa on exactly the same set of tools", async () => {
    // B — schema, read from the live tools/list response.
    const { tools } = await client.listTools();
    expect(tools.length).toBeGreaterThan(20);
    const declared = tools
      .filter(tool => tool.inputSchema?.properties?.force_xfa)
      .map(tool => tool.name)
      .sort();
    expect(declared.length).toBeGreaterThan(0);

    // A — source, read from the dispatcher's own case blocks.
    const source = await fs.readFile(path.join(REPO_ROOT, "server", "index.js"), "utf8");
    const caseMarks = [...source.matchAll(/^ {6}case "([a-z0-9_]+)": \{$/gm)]
      .map(match => ({ name: match[1], start: match.index }));
    expect(caseMarks.length).toBeGreaterThan(20);
    const wired = caseMarks
      .filter((mark, index) => {
        const end = index + 1 < caseMarks.length ? caseMarks[index + 1].start : source.length;
        return source.slice(mark.start, end).includes("assertXfaMutationAllowed(");
      })
      .map(mark => mark.name)
      .sort();
    expect(wired).toEqual(declared);

    // C — behaviour, measured by calling every declaring tool on an XFA
    // document. Reported as a map so a tool that fails to refuse shows the
    // text it returned instead of only its name.
    const observed = {};
    for (const name of declared) {
      const result = await client.callTool({ name, arguments: argsFor(name) });
      const text = textOf(result);
      observed[name] = text.includes(REFUSAL) ? REFUSAL : `DID NOT REFUSE: ${text.slice(0, 220)}`;
    }
    expect(observed).toEqual(Object.fromEntries(declared.map(name => [name, REFUSAL])));
  }, 120_000);

  it("stops refusing each of those tools when force_xfa is true", async () => {
    const { tools } = await client.listTools();
    const declared = tools
      .filter(tool => tool.inputSchema?.properties?.force_xfa)
      .map(tool => tool.name)
      .sort();

    const observed = {};
    for (const name of declared) {
      const result = await client.callTool({ name, arguments: argsFor(name, { force: true }) });
      observed[name] = textOf(result).includes(REFUSAL) ? `STILL REFUSED: ${name}` : "proceeded";
    }
    expect(observed).toEqual(Object.fromEntries(declared.map(name => [name, "proceeded"])));
  }, 120_000);
});
