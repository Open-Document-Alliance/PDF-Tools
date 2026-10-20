import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { validateStructuredToolResult } from "../server/output-schemas.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, "..");
const EXAMPLE_PDF = path.join(REPO_ROOT, "example-fw9.pdf");
const ENCRYPTED_PDF = path.join(
  REPO_ROOT,
  "test/fixtures/golden-forms/encrypted-rotated-signature.pdf",
);
const RUNTIMES = [
  { name: "source runtime", root: REPO_ROOT },
  { name: "share runtime", root: path.join(REPO_ROOT, "pdf-toolkit-mcp-share") },
];

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

describe.each(RUNTIMES)("$name accessibility inspection MCP contract", ({ root }) => {
  let client;
  let transport;
  let stateRoot;
  let tool;

  beforeAll(async () => {
    stateRoot = await fs.mkdtemp(path.join(os.tmpdir(), "pdf-tools-a11y-tool-"));
    transport = new StdioClientTransport({
      command: process.execPath,
      args: [path.join(root, "server", "index.js")],
      cwd: root,
      env: {
        ALLOWED_DIRECTORIES: [REPO_ROOT, stateRoot].join(path.delimiter),
        DEFAULT_PROFILES_DIR: path.join(stateRoot, "profiles"),
      },
      stderr: "ignore",
    });
    client = new Client({ name: "pdf-tools-a11y-tool-test", version: "1.0.0" });
    await client.connect(transport);
    const listed = await client.listTools();
    tool = listed.tools.find(item => item.name === "inspect_pdf_accessibility");
  }, 30_000);

  afterAll(async () => {
    await client?.close();
    await transport?.close();
    if (stateRoot) await fs.rm(stateRoot, { recursive: true, force: true });
  });

  it("discovers one closed read-only argument contract with exact annotations", () => {
    expect(tool).toMatchObject({
      name: "inspect_pdf_accessibility",
      inputSchema: {
        type: "object",
        additionalProperties: false,
        required: ["pdf_path"],
        properties: { pdf_path: { type: "string", maxLength: 32768 } },
      },
      annotations: {
        title: "Inspect PDF Accessibility Signals",
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    });
    expect(tool.outputSchema).toEqual(expect.any(Object));
  });

  it("returns a source-bound, semantically validated result without changing the PDF", async () => {
    const beforeBytes = await fs.readFile(EXAMPLE_PDF);
    const beforeStats = await fs.stat(EXAMPLE_PDF);
    const result = await client.callTool({
      name: "inspect_pdf_accessibility",
      arguments: { pdf_path: EXAMPLE_PDF },
    });
    const afterBytes = await fs.readFile(EXAMPLE_PDF);
    const afterStats = await fs.stat(EXAMPLE_PDF);

    expect(result.isError).not.toBe(true);
    expect(result.structuredContent).toMatchObject({
      schema_version: "pdf-tools.accessibility-inspection-result/1.0.0",
      source: {
        file_name: path.basename(EXAMPLE_PDF),
        size_bytes: beforeBytes.length,
        sha256: sha256(beforeBytes),
      },
      summary: { total: 8 },
      machine_profile_validation: { status: "not_run" },
      human_review: { status: "required" },
      conclusions: {
        pdfua_conformance: "not_established",
        wcag_conformance: "not_established",
        certification: "not_established",
        legal_compliance: "not_established",
        document_accessibility: "not_established",
      },
    });
    expect(result.structuredContent.checks).toHaveLength(8);
    expect(validateStructuredToolResult("inspect_pdf_accessibility", result)).toBe(result);
    expect(result.content[0].text).not.toContain(EXAMPLE_PDF);
    expect(result.content[0].text).not.toContain(path.basename(EXAMPLE_PDF));
    expect(result.content[0].text).not.toContain(sha256(beforeBytes));
    expect(afterBytes).toEqual(beforeBytes);
    expect(afterStats.size).toBe(beforeStats.size);
    expect(afterStats.ino).toBe(beforeStats.ino);
    expect(afterStats.mtimeMs).toBe(beforeStats.mtimeMs);
  }, 30_000);

  it("returns a fixed encrypted abstention with no findings or path leakage", async () => {
    const result = await client.callTool({
      name: "inspect_pdf_accessibility",
      arguments: { pdf_path: ENCRYPTED_PDF },
    });
    expect(result.isError).toBe(true);
    expect(result.structuredContent).toEqual({
      status: "failed",
      error: {
        error_schema_version: 1,
        code: "PDF_ENCRYPTED_INSPECTION_UNAVAILABLE",
      },
    });
    expect(result.content).toEqual([{
      type: "text",
      text: "Encrypted PDF inspection is unavailable because this operation does not accept a password.",
    }]);
    expect(JSON.stringify(result)).not.toContain(ENCRYPTED_PDF);
    expect(result).not.toHaveProperty("findings");
  }, 30_000);

  it("fails closed on malformed input and rejects password or unknown fields", async () => {
    const malformedPath = path.join(stateRoot, "malformed.pdf");
    await fs.writeFile(malformedPath, "not a PDF /private/var/folders/parser-canary");
    const malformed = await client.callTool({
      name: "inspect_pdf_accessibility",
      arguments: { pdf_path: malformedPath },
    });
    expect(malformed.isError).not.toBe(true);
    expect(malformed.structuredContent).toMatchObject({
      inspection_status: "partial",
      result: "indeterminate",
    });
    expect(malformed.structuredContent.checks[0]).toMatchObject({
      id: "parseable_pdf",
      status: "missing",
      observation_code: "PARSE_FAILED",
    });
    expect(JSON.stringify(malformed)).not.toContain("parser-canary");
    expect(JSON.stringify(malformed)).not.toContain("/private/var/");
    const forgedReason = structuredClone(malformed);
    forgedReason.structuredContent.checks[1].reason_code = "FORGED_REASON";
    const rejectedReason = validateStructuredToolResult(
      "inspect_pdf_accessibility",
      forgedReason,
    );
    expect(rejectedReason.isError).toBe(true);
    expect(rejectedReason.structuredContent.error.code).toBe("internal_validation_error");

    for (const [argumentsValue, expectedCode] of [
      [{ pdf_path: EXAMPLE_PDF, password: "secret" }, "PRIVATE_PDF_PASSWORD_ARGUMENT_FORBIDDEN"],
      [{ pdf_path: EXAMPLE_PDF, reviewer: "self-appointed" }, "tool_execution_failed"],
    ]) {
      const rejected = await client.callTool({
        name: "inspect_pdf_accessibility",
        arguments: argumentsValue,
      });
      expect(rejected.isError).toBe(true);
      expect(rejected.structuredContent.error.code).toBe(expectedCode);
      expect(JSON.stringify(rejected)).not.toContain("secret");
      expect(JSON.stringify(rejected)).not.toContain("self-appointed");
    }
  }, 30_000);

  it("returns a fixed path-policy error and blocks contradictory structured results", async () => {
    const denied = await client.callTool({
      name: "inspect_pdf_accessibility",
      arguments: { pdf_path: path.join(path.parse(REPO_ROOT).root, "outside.pdf") },
    });
    expect(denied.isError).toBe(true);
    expect(denied.structuredContent.error.code).toBe("path_policy_denied");
    expect(denied.content[0].text).toBe("The requested PDF path is not permitted.");

    const valid = await client.callTool({
      name: "inspect_pdf_accessibility",
      arguments: { pdf_path: EXAMPLE_PDF },
    });
    const mutations = [
      value => { value.summary.observed += 1; },
      value => { value.checks[0].observation_code = "PARSE_FAILED"; },
      value => { value.conclusions.pdfua_conformance = "established"; },
      value => { value.checks.push(structuredClone(value.checks[0])); },
    ];
    for (const mutate of mutations) {
      const changed = structuredClone(valid);
      mutate(changed.structuredContent);
      const rejected = validateStructuredToolResult("inspect_pdf_accessibility", changed);
      expect(rejected.isError).toBe(true);
      expect(rejected.structuredContent.error.code).toBe("internal_validation_error");
    }
  }, 30_000);
});

describe("installed accessibility inspection smoke contract", () => {
  const requiredWiring = [
    "const accessibility = await first.client.callTool({",
    'name: "inspect_pdf_accessibility"',
    "accessibility.structuredContent?.source?.file_name === path.basename(textFixture)",
    "accessibility.structuredContent?.source?.size_bytes === textFixtureBytes.length",
    "accessibility.structuredContent?.source?.sha256",
    'accessibility.structuredContent?.checks?.length === 8',
    'accessibility.structuredContent?.summary?.total === 8',
    'accessibility.structuredContent?.machine_profile_validation?.status === "not_run"',
    'accessibility.structuredContent?.human_review?.status === "required"',
    '.every(value => value === "not_established")',
    "accessibility_receipt: accessibilityReceipt",
  ];

  function assertInstalledSmokeWiring(smoke) {
    for (const required of requiredWiring) {
      if (!smoke.includes(required)) throw new Error(`Installed smoke omitted required wiring: ${required}`);
    }
  }

  it("executes the tool and asserts exact source binding and bounded conclusions", async () => {
    const smoke = await fs.readFile(
      path.join(REPO_ROOT, "scripts/macos-claude-installed-smoke.mjs"),
      "utf8",
    );
    expect(() => assertInstalledSmokeWiring(smoke)).not.toThrow();
    expect(smoke).toContain("same_session_calls: 9");
  });

  it("fails its contract check when any receipt field wiring is removed", async () => {
    const smoke = await fs.readFile(
      path.join(REPO_ROOT, "scripts/macos-claude-installed-smoke.mjs"),
      "utf8",
    );
    for (const required of requiredWiring) {
      const mutated = smoke.replace(required, "REMOVED_WIRING");
      expect(mutated).not.toBe(smoke);
      expect(() => assertInstalledSmokeWiring(mutated)).toThrow(/omitted required wiring/);
    }
  });
});
