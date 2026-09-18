import fs from "fs/promises";
import { tmpdir } from "os";
import path from "path";
import { fileURLToPath } from "url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { AjvJsonSchemaValidator } from "@modelcontextprotocol/server/validators/ajv";
import {
  TOOL_OUTPUT_SCHEMAS,
  TOOL_ERROR_OUTPUT_SCHEMAS,
  TOOL_SUCCESS_OUTPUT_SCHEMAS,
  validateStructuredToolResult,
} from "../server/output-schemas.js";
import { makeDeepMalformedFixture } from "./helpers/deep-malformed-fixtures.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.join(__dirname, "..");
const EXAMPLE_PDF = path.join(REPO_ROOT, "example-fw9.pdf");

const STRUCTURED_TOOLS = [
  "add_signature_field",
  "apply_page_plan",
  "apply_signature",
  "apply_text",
  "bulk_fill_from_csv",
  "check_lumin_status",
  "compare_pdfs",
  "create_extraction_workspace",
  "create_signature",
  "convert_pdf_to_markdown",
  "delete_extraction_workspace",
  "detect_signature_zones",
  "display_pdf",
  "download_lumin_artifact",
  "extract_to_csv",
  "fetch_pdf_from_url",
  "fill_pdf",
  "fill_with_profile",
  "finish_lumin_authorization",
  "get_active_document",
  "get_allowed_directories",
  "get_page_analysis",
  "get_pdf_identity",
  "get_pdf_info",
  "get_pdf_resource_uri",
  "inspect_extraction_state",
  "inspect_pdf_accessibility",
  "list_signatures",
  "load_signature",
  "merge_pdfs",
  "prepare_signing_packet",
  "prepare_lumin_request",
  "read_extraction_chunk",
  "read_extraction_workspace",
  "read_pdf_bytes",
  "read_pdf_content",
  "read_pdf_layout",
  "read_pdf_fields",
  "read_pdf_pages",
  "render_pdf_page",
  "render_pdf_region",
  "reorder_pdf_pages",
  "reveal_in_finder",
  "rotate_pdf_pages",
  "search_pdf_text",
  "set_active_document",
  "send_lumin_request",
  "split_pdf",
  "submit_extraction_proposal",
  "start_lumin_authorization",
  "validate_pdf",
  "verify_extraction_proposal",
  "verify_table_proposal",
].sort();
const TEXT_ONLY_TOOLS = [
  "list_pdfs",
  "list_profiles",
  "load_profile",
  "save_profile",
].sort();

function collectKeys(value, output = new Set()) {
  if (Array.isArray(value)) {
    for (const item of value) collectKeys(item, output);
    return output;
  }
  if (!value || typeof value !== "object") return output;
  for (const [key, child] of Object.entries(value)) {
    output.add(key);
    collectKeys(child, output);
  }
  return output;
}

describe("output schema definitions", () => {
  it("does not leave intentional text-only error literals in the server", async () => {
    const source = await fs.readFile(path.join(REPO_ROOT, "server", "index.js"), "utf8");
    const readContent = source.slice(
      source.indexOf('case "read_pdf_content"'),
      source.indexOf('case "read_pdf_pages"'),
    );
    expect(readContent).toContain("return createTypedToolError({");
    const lines = source.split("\n");
    const literalErrorRows = lines
      .map((line, index) => line.includes("isError: true") ? index : -1)
      .filter(index => index >= 0);
    expect(literalErrorRows.length).toBeGreaterThan(0);
    for (const row of literalErrorRows) {
      expect(lines.slice(Math.max(0, row - 12), row + 13).join("\n")).toContain("structuredContent");
    }
  });

  it("advertises the exact resource-limit error on isolated semantic and mutation tools", () => {
    const affectedTools = [
      "add_signature_field",
      "apply_page_plan",
      "apply_signature",
      "apply_text",
      "bulk_fill_from_csv",
      "compare_pdfs",
      "convert_pdf_to_markdown",
      "verify_table_proposal",
      "detect_signature_zones",
      "fill_pdf",
      "fill_with_profile",
      "get_page_analysis",
      "get_pdf_info",
      "inspect_pdf_accessibility",
      "merge_pdfs",
      "prepare_signing_packet",
      "read_pdf_content",
      "read_pdf_layout",
      "read_pdf_pages",
      "reorder_pdf_pages",
      "render_pdf_page",
      "render_pdf_region",
      "rotate_pdf_pages",
      "search_pdf_text",
      "split_pdf",
    ];
    const resourceFailure = {
      content: [{ type: "text", text: "The isolated worker was stopped." }],
      structuredContent: {
        status: "failed",
        error: {
          error_schema_version: 1,
          code: "PDF_RESOURCE_LIMIT_EXCEEDED",
        },
      },
      isError: true,
    };
    for (const toolName of affectedTools) {
      expect(validateStructuredToolResult(toolName, resourceFailure), toolName).toBe(
        resourceFailure,
      );
    }
    const rejected = validateStructuredToolResult("get_active_document", resourceFailure);
    expect(rejected.isError).toBe(true);
    expect(rejected.structuredContent.error.code).toBe("internal_validation_error");
  });

  it("covers the exact 53 structured tools and no text-only tool", () => {
    expect(Object.keys(TOOL_OUTPUT_SCHEMAS).sort()).toEqual(STRUCTURED_TOOLS);
    expect(Object.keys(TOOL_ERROR_OUTPUT_SCHEMAS).sort()).toEqual(STRUCTURED_TOOLS);
    expect(Object.keys(TOOL_SUCCESS_OUTPUT_SCHEMAS).sort()).toEqual(STRUCTURED_TOOLS);
    expect(STRUCTURED_TOOLS).toHaveLength(53);
    expect(TEXT_ONLY_TOOLS).toHaveLength(4);
  });

  it("preserves stable Lumin failure codes in structured errors", () => {
    const result = validateStructuredToolResult("start_lumin_authorization", {
      content: [{ type: "text", text: "Lumin OAuth is not configured." }],
      structuredContent: {
        status: "failed",
        error: {
          error_schema_version: 1,
          code: "LUMIN_OAUTH_NOT_CONFIGURED",
        },
      },
      isError: true,
    });
    expect(result.structuredContent.error.code).toBe("LUMIN_OAUTH_NOT_CONFIGURED");
  });

  it("uses current-host-compatible object schemas that compile with the pinned SDK", () => {
    const provider = new AjvJsonSchemaValidator();
    const unsupportedKeywords = new Set([
      "$defs",
      "$dynamicAnchor",
      "$dynamicRef",
      "dependentRequired",
      "dependentSchemas",
      "prefixItems",
      "unevaluatedItems",
      "unevaluatedProperties",
    ]);

    for (const [name, schema] of Object.entries(TOOL_OUTPUT_SCHEMAS)) {
      expect(schema, name).toMatchObject({ type: "object" });
      const keys = collectKeys(schema);
      expect([...keys].filter(key => unsupportedKeywords.has(key)), name).toEqual([]);
      expect(() => provider.getValidator(schema), name).not.toThrow();
      expect(() => provider.getValidator(TOOL_SUCCESS_OUTPUT_SCHEMAS[name]), name).not.toThrow();
    }
  });

  it("fails closed against distinct success and structured-error validators", () => {
    const valid = {
      content: [{ type: "text", text: "No active document yet" }],
      structuredContent: {
        active_path: null,
        backup_path: null,
        last_mutation_tool: null,
        last_mutation_at: null,
      },
    };
    expect(validateStructuredToolResult("get_active_document", valid)).toBe(valid);

    const invalidSuccess = validateStructuredToolResult("get_active_document", {
      content: [{ type: "text", text: "bad" }],
      structuredContent: { active_path: 42 },
    });
    expect(invalidSuccess).toEqual({
      content: [{
        type: "text",
        text: "Internal output validation failed for get_active_document. No unvalidated structured result was returned.",
      }],
      structuredContent: {
        status: "failed",
        error: {
          error_schema_version: 1,
          code: "internal_validation_error",
        },
      },
      isError: true,
    });

    const omitted = validateStructuredToolResult("get_active_document", {
      content: [{ type: "text", text: "bad" }],
    });
    expect(omitted.isError).toBe(true);

    const undeclared = validateStructuredToolResult("list_pdfs", {
      content: [{ type: "text", text: "bad" }],
      structuredContent: { files: [] },
    });
    expect(undeclared.isError).toBe(true);

    const toolError = {
      content: [{ type: "text", text: "Error: denied" }],
      structuredContent: {
        status: "failed",
        error: { error_schema_version: 1, code: "path_policy_denied" },
      },
      isError: true,
    };
    expect(validateStructuredToolResult("get_active_document", toolError)).toBe(toolError);

    const malformedToolError = validateStructuredToolResult("get_active_document", {
      content: [{ type: "text", text: "Error: malformed" }],
      structuredContent: { deliberately: "not a structured error shape" },
      isError: true,
    });
    expect(malformedToolError.isError).toBe(true);
    expect(malformedToolError.structuredContent.error.code).toBe("internal_validation_error");

    const nameZone = {
      content: [{ type: "text", text: "Found a printed-name zone" }],
      structuredContent: {
        detection_status: "partial",
        zones: [{
          type: "name",
          label: "Print Name:",
          page: 1,
          x: 100,
          y: 200,
          width: 180,
          height: 20,
          confidence: 0.8,
          source: "text-heuristic",
        }],
        warnings: [{
          code: "ACROFORM_WIDGET_PAGE_UNRESOLVED",
          message: "Skipped an AcroForm signing widget because its page could not be resolved. No page location was guessed.",
          occurrences: 1,
        }],
        // Required so a renderer can place zones against the MediaBox they are
        // measured from. A nonzero origin is used here deliberately: it is the
        // case a consumer cannot reconstruct from PDF.js alone.
        page_geometry: [{ page: 1, origin_x: 20, origin_y: 24, width: 480, height: 360 }],
      },
    };
    expect(validateStructuredToolResult("detect_signature_zones", nameZone)).toBe(nameZone);

    const passwordError = {
      content: [{ type: "text", text: "A password is required" }],
      structuredContent: {
        status: "failed",
        error: { error_schema_version: 1, code: "PASSWORD_REQUIRED" },
      },
      isError: true,
    };
    expect(validateStructuredToolResult("detect_signature_zones", passwordError)).toBe(passwordError);

  });
});

describe("live output schema contract", () => {
  let client;
  let transport;
  let stateRoot;
  let tools;

  beforeAll(async () => {
    stateRoot = await fs.mkdtemp(path.join(tmpdir(), "pdf-tools-output-schema-"));
    transport = new StdioClientTransport({
      command: process.execPath,
      args: [path.join(REPO_ROOT, "server", "index.js")],
      cwd: REPO_ROOT,
      env: {
        ALLOWED_DIRECTORIES: [REPO_ROOT, stateRoot].join(path.delimiter),
        DEFAULT_PROFILES_DIR: path.join(stateRoot, "profiles"),
      },
      stderr: "ignore",
    });
    client = new Client({ name: "pdf-tools-output-schema-test", version: "1.0.0" });
    await client.connect(transport);
    ({ tools } = await client.listTools());
  }, 30_000);

  afterAll(async () => {
    await client?.close();
    await transport?.close();
    if (stateRoot) await fs.rm(stateRoot, { recursive: true, force: true });
  });

  it("publishes the exhaustive structured/text-only discovery matrix", () => {
    expect(tools.filter(tool => tool.outputSchema).map(tool => tool.name).sort()).toEqual(STRUCTURED_TOOLS);
    expect(tools.filter(tool => !tool.outputSchema).map(tool => tool.name).sort()).toEqual(TEXT_ONLY_TOOLS);
    for (const tool of tools.filter(entry => entry.outputSchema)) {
      expect(tool.outputSchema, tool.name).toEqual(TOOL_OUTPUT_SCHEMAS[tool.name]);
    }
  });

  it("validates representative live success shapes and preserves text fallbacks", async () => {
    const requests = [
      { name: "get_active_document", arguments: {} },
      { name: "read_pdf_fields", arguments: { pdf_path: EXAMPLE_PDF } },
      { name: "read_pdf_pages", arguments: { pdf_path: EXAMPLE_PDF, start_page: 1, end_page: 1 } },
      { name: "get_page_analysis", arguments: { pdf_path: EXAMPLE_PDF } },
      { name: "list_signatures", arguments: {} },
    ];

    for (const request of requests) {
      const result = await client.callTool(request);
      expect(result.isError, request.name).not.toBe(true);
      expect(result.structuredContent, request.name).toEqual(expect.any(Object));
      expect(result.content, request.name).toEqual(expect.arrayContaining([
        expect.objectContaining({ type: "text", text: expect.any(String) }),
      ]));
    }
  }, 30_000);

  it("rejects saved Markdown evidence that disagrees with the inline bytes or digest", async () => {
    const outputPath = path.join(stateRoot, "schema-bound-markdown.md");
    const converted = await client.callTool({
      name: "convert_pdf_to_markdown",
      arguments: { pdf_path: EXAMPLE_PDF, output_path: outputPath },
    });
    expect(converted.isError).not.toBe(true);
    expect(validateStructuredToolResult("convert_pdf_to_markdown", converted)).toBe(converted);

    const cases = [
      { ...converted.structuredContent.saved_output, bytes: converted.structuredContent.markdown_bytes + 1 },
      { ...converted.structuredContent.saved_output, sha256: "0".repeat(64) },
    ];
    for (const savedOutput of cases) {
      const rejected = validateStructuredToolResult("convert_pdf_to_markdown", {
        ...converted,
        structuredContent: {
          ...converted.structuredContent,
          saved_output: savedOutput,
        },
      });
      expect(rejected.isError).toBe(true);
      expect(rejected.structuredContent.error.code).toBe("internal_validation_error");
    }
  }, 30_000);

  it("keeps pre-created signature records without timestamps usable", async () => {
    const signaturesDir = path.join(stateRoot, "profiles", "signatures");
    await fs.mkdir(signaturesDir, { recursive: true });
    await fs.writeFile(path.join(signaturesDir, "legacy.json"), JSON.stringify({
      name: "legacy",
      style: "typed",
      display_name: "Legacy Signer",
    }));
    await fs.writeFile(path.join(signaturesDir, "malformed.json"), JSON.stringify({
      name: "malformed",
      style: "unsupported",
    }));

    const listed = await client.callTool({ name: "list_signatures", arguments: {} });
    expect(listed.isError).not.toBe(true);
    expect(listed.structuredContent.signatures).toEqual([{
      name: "legacy",
      style: "typed",
      display_name: "Legacy Signer",
      created_at: null,
    }]);

    const loaded = await client.callTool({
      name: "load_signature",
      arguments: { signature_name: "legacy" },
    });
    expect(loaded.isError).not.toBe(true);
    expect(loaded.structuredContent).toMatchObject({
      name: "legacy",
      style: "typed",
      display_name: "Legacy Signer",
      preview_data_url: null,
      created_at: null,
    });
  });

  it("keeps structured isError branches distinct from success validation", async () => {
    const deniedPath = path.join(path.parse(REPO_ROOT).root, "outside.pdf");
    const denied = await client.callTool({
      name: "read_pdf_fields",
      arguments: { pdf_path: deniedPath },
    });
    expect(denied).toMatchObject({
      isError: true,
      structuredContent: {
        status: "failed",
        error: { error_schema_version: 1, code: "path_policy_denied" },
      },
    });

    const validationFailure = await client.callTool({
      name: "validate_pdf",
      arguments: { pdf_path: path.join(stateRoot, "missing.pdf") },
    });
    expect(validationFailure).toMatchObject({
      isError: true,
      structuredContent: {
        schema_version: "1.0",
        validation_status: "failed",
        required_field_validation_status: "failed",
      },
    });
  });

  it("accepts scoped routing facts on a read-content worker failure", () => {
    const result = {
      isError: true,
      structuredContent: {
        status: "failed",
        error: { error_schema_version: 1, code: "tool_execution_failed" },
        pages_read: 1,
        read_pages_without_text: [1],
        pages_with_suspected_text_integrity: [],
        page_read_error: { page: 2, code: "PDFJS_PAGE_READ_FAILED" },
        pages_with_invisible_text: [],
        pages_with_unavailable_text_visibility: [],
      },
    };
    expect(validateStructuredToolResult("read_pdf_content", result)).toBe(result);
  });

  it("accepts scoped routing facts on a read-content resource-limit failure", () => {
    const result = {
      isError: true,
      structuredContent: {
        status: "failed",
        error: { error_schema_version: 1, code: "PDF_RESOURCE_LIMIT_EXCEEDED" },
        pages_read: 1,
        read_pages_without_text: [1],
        pages_with_suspected_text_integrity: [],
        page_read_error: null,
        pages_with_invisible_text: [],
        pages_with_unavailable_text_visibility: [],
      },
    };
    expect(validateStructuredToolResult("read_pdf_content", result)).toBe(result);
  });

  it("rejects a read-content worker failure that omits read provenance", () => {
    const rejected = validateStructuredToolResult("read_pdf_content", {
      isError: true,
      structuredContent: {
        status: "failed",
        error: { error_schema_version: 1, code: "tool_execution_failed" },
        read_pages_without_text: [1],
      },
    });
    expect(rejected).not.toBe(rejected.structuredContent);
    expect(rejected.structuredContent.error.code).toBe("internal_validation_error");
  });

  it("preserves its rich typed failure for an empty malformed content read", async () => {
    const fixture = makeDeepMalformedFixture({
      scale: "full",
      name: "sparse-xref-range-overflow",
    });
    const fixturePath = path.join(stateRoot, `${fixture.name}.pdf`);
    await fs.writeFile(fixturePath, fixture.bytes, { mode: 0o600 });

    const result = await client.callTool({
      name: "read_pdf_content",
      arguments: { pdf_path: fixturePath },
    });
    expect(result).toMatchObject({
      isError: true,
      structuredContent: {
        content_available: false,
        extraction_status: "failed",
        extraction_mode: "none",
        text_found: false,
        error_codes: ["NO_EXTRACTABLE_TEXT", "IMAGE_FALLBACK_FAILED"],
      },
    });
  }, 30_000);

  it("does not attach undeclared structured content to text-only tool errors", async () => {
    const result = await client.callTool({
      name: "list_pdfs",
      arguments: { directory: path.join(stateRoot, "missing-directory") },
    });
    expect(result.isError).toBe(true);
    expect(result.structuredContent.error.code).toBe("tool_execution_failed");
    expect(result.content).toEqual([expect.objectContaining({
      type: "text",
      text: expect.stringMatching(/^Error:/),
    })]);
  });
});
