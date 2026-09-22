// The XFA refusal applies to exactly the mutations that declare `force_xfa`,
// and to no others. A tool that never declared the parameter has no way for a
// caller to proceed past a refusal, so guarding it would be a new refusal with
// no escape hatch; a tool that declares the parameter but is not guarded makes
// the parameter meaningless. Either drift is a defect, so both directions are
// pinned here rather than left to whichever side a future change edits.

import path from "path";
import { fileURLToPath } from "url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { XFA_GUARDED_MUTATION_OPERATIONS } from "../server/helpers.js";
import {
  PDF_LIB_MUTATION_TOOL_NAMES,
  createPdfLibInspectionRequest,
  createPdfLibMutationRequest,
} from "../server/pdf-lib-subprocess.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.join(__dirname, "..");

describe("XFA guard surface consistency", () => {
  let client;
  let transport;
  let toolsWithForceXfa;

  beforeAll(async () => {
    client = new Client({ name: "pdf-tools-xfa-surface-client", version: "1.0.0" });
    transport = new StdioClientTransport({
      command: process.execPath,
      args: [path.join(REPO_ROOT, "server", "index.js")],
      cwd: REPO_ROOT,
      env: { ALLOWED_DIRECTORIES: REPO_ROOT },
      stderr: "pipe",
    });
    await client.connect(transport);
    const { tools } = await client.listTools();
    toolsWithForceXfa = tools
      .filter(tool => Object.hasOwn(tool.inputSchema?.properties ?? {}, "force_xfa"))
      .map(tool => tool.name)
      .sort();
  }, 60_000);

  afterAll(async () => {
    await transport?.close();
  });

  it("every tool that declares force_xfa is guarded, and every guarded operation declares it", () => {
    expect(toolsWithForceXfa).toEqual([...XFA_GUARDED_MUTATION_OPERATIONS].sort());
  });

  it("force_xfa is a request field the parent may only set for a guarded operation", () => {
    const source = Object.freeze({
      canonical_path: path.join(REPO_ROOT, "example-fw9.pdf"),
      file_identity: { device: "1", inode: "2" },
      size_bytes: 126218,
      sha256: "0".repeat(64),
    });

    // Carried on every request, so the shape is one shape rather than two.
    expect(createPdfLibMutationRequest({
      operation: "fill_pdf", sources: [source], options: { field_data: {} },
    }).force_xfa).toBe(false);
    expect(createPdfLibMutationRequest({
      operation: "fill_pdf", sources: [source], options: { field_data: {} }, force_xfa: true,
    }).force_xfa).toBe(true);
    expect(createPdfLibInspectionRequest({
      operation: "inspect_pdf_accessibility", sources: [source],
    }).force_xfa).toBe(false);

    // An operation with no force_xfa parameter cannot be forced past a guard
    // it does not have; asking is a programming error, not a silent no-op.
    expect(() => createPdfLibMutationRequest({
      operation: "split_pdf", sources: [source], options: { page_ranges: [] }, force_xfa: true,
    })).toThrow(/does not accept force_xfa/);

    expect(() => createPdfLibMutationRequest({
      operation: "fill_pdf", sources: [source], options: { field_data: {} }, force_xfa: "yes",
    })).toThrow(/force_xfa must be a boolean/);
  });

  it("the guarded set is a real subset of the pdf-lib mutations", () => {
    for (const operation of XFA_GUARDED_MUTATION_OPERATIONS) {
      expect(PDF_LIB_MUTATION_TOOL_NAMES.has(operation)).toBe(true);
    }
    // Deliberately unguarded today, and recorded as such rather than silently
    // widened: none of these declares force_xfa, so a refusal here would have
    // no escape hatch. Issue #200 did not ask for them and this pin makes a
    // future decision to include them an explicit edit.
    for (const operation of ["merge_pdfs", "split_pdf", "rotate_pdf_pages",
                             "reorder_pdf_pages", "fill_with_profile"]) {
      expect(PDF_LIB_MUTATION_TOOL_NAMES.has(operation)).toBe(true);
      expect(XFA_GUARDED_MUTATION_OPERATIONS.has(operation)).toBe(false);
    }
  });
});
