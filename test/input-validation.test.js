import fs from "fs/promises";
import { tmpdir } from "os";
import path from "path";
import { fileURLToPath } from "url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.join(__dirname, "..");
const EXAMPLE_PDF = path.join(REPO_ROOT, "example-fw9.pdf");
const TINY_PNG_B64 = "iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAYAAABytg0kAAAAEUlEQVQIW2NgYGD4z8DAwMAAAAwAAwH1oUt1AAAAAElFTkSuQmCC";
const MALFORMED_SIGNATURE_RECORDS = [
  {
    slug: "bad-typed",
    record: { name: "bad-typed", style: "typed", display_name: 123 },
  },
  {
    slug: "unrenderable-typed",
    record: { name: "unrenderable-typed", style: "typed", display_name: "Signer 💥" },
  },
  {
    slug: "bad-base64",
    record: { name: "bad-base64", style: "image", image_mime: "image/png", image_data_b64: "not-base64" },
  },
  {
    slug: "bad-mime",
    record: { name: "bad-mime", style: "image", image_mime: "image/jpeg", image_data_b64: TINY_PNG_B64 },
  },
  {
    slug: "truncated-png",
    record: {
      name: "truncated-png",
      style: "image",
      image_mime: "image/png",
      image_data_b64: Buffer.from("89504e470d0a1a0a", "hex").toString("base64"),
    },
  },
  {
    slug: "identity-confused",
    record: { name: "different-signature", style: "typed", display_name: "Wrong Signer" },
  },
];
const RUNTIMES = [
  { name: "source runtime", root: REPO_ROOT },
  { name: "share runtime", root: path.join(REPO_ROOT, "pdf-toolkit-mcp-share") },
];

async function expectMissing(filePath) {
  await expect(fs.access(filePath)).rejects.toMatchObject({ code: "ENOENT" });
}

describe.each(RUNTIMES)("$name pre-mutation input validation", ({ root }) => {
  let client;
  let transport;
  let stateRoot;

  beforeAll(async () => {
    stateRoot = await fs.mkdtemp(path.join(tmpdir(), "pdf-tools-input-validation-"));
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
    client = new Client({ name: "pdf-tools-input-validation-test", version: "1.0.0" });
    await client.connect(transport);
    await client.listTools();
  }, 30_000);

  afterAll(async () => {
    await client?.close();
    await transport?.close();
    if (stateRoot) await fs.rm(stateRoot, { recursive: true, force: true });
  });

  it("rejects poisoned session fields before changing healthy active state", async () => {
    const initialized = await client.callTool({
      name: "set_active_document",
      arguments: {
        pdf_path: EXAMPLE_PDF,
        last_mutation_tool: "fill_pdf",
        last_mutation_at: "2026-07-21T01:02:03-07:00",
      },
    });
    expect(initialized.isError).not.toBe(true);
    expect(initialized.structuredContent).toMatchObject({
      active_path: EXAMPLE_PDF,
      last_mutation_tool: "fill_pdf",
      last_mutation_at: "2026-07-21T08:02:03.000Z",
    });

    const poisoned = await client.callTool({
      name: "set_active_document",
      arguments: {
        pdf_path: EXAMPLE_PDF,
        last_mutation_tool: { injected: true },
        last_mutation_at: "2026-07-21T08:02:03.000Z",
      },
    });
    expect(poisoned.isError).toBe(true);

    const missing = await client.callTool({
      name: "set_active_document",
      arguments: { pdf_path: path.join(stateRoot, "missing.pdf") },
    });
    expect(missing.isError).toBe(true);

    const active = await client.callTool({ name: "get_active_document", arguments: {} });
    expect(active.isError).not.toBe(true);
    expect(active.structuredContent).toMatchObject({
      active_path: EXAMPLE_PDF,
      last_mutation_tool: "fill_pdf",
      last_mutation_at: "2026-07-21T08:02:03.000Z",
    });
  });

  it("rejects invalid apply_text arguments without creating an output", async () => {
    const outputPath = path.join(stateRoot, "invalid-text.pdf");
    const result = await client.callTool({
      name: "apply_text",
      arguments: {
        pdf_path: EXAMPLE_PDF,
        output_path: outputPath,
        page: "1",
        x: 10,
        y: 10,
        width: 100,
        height: 20,
        text: "2026-07-21",
      },
    });
    expect(result.isError).toBe(true);
    await expectMissing(outputPath);
  });

  it("rejects invalid signature-field arguments without creating an output", async () => {
    const outputPath = path.join(stateRoot, "invalid-field.pdf");
    const result = await client.callTool({
      name: "add_signature_field",
      arguments: {
        pdf_path: EXAMPLE_PDF,
        output_path: outputPath,
        page: 1,
        x: 10,
        y: 10,
        width: "100",
        height: 20,
      },
    });
    expect(result.isError).toBe(true);
    await expectMissing(outputPath);
  });

  it("rejects an invalid signing-packet manifest before loading or writing the PDF", async () => {
    const outputPath = path.join(stateRoot, "invalid-packet.pdf");
    const result = await client.callTool({
      name: "prepare_signing_packet",
      arguments: {
        pdf_path: EXAMPLE_PDF,
        output_path: outputPath,
        signature_locations: [{
          page: 1,
          x: 10,
          y: 10,
          width: 100,
          height: "20",
        }],
      },
    });
    expect(result.isError).toBe(true);
    await expectMissing(outputPath);
  });

  it("rejects invalid apply_signature coordinates before reading a signature or writing", async () => {
    const outputPath = path.join(stateRoot, "invalid-signature.pdf");
    const result = await client.callTool({
      name: "apply_signature",
      arguments: {
        pdf_path: EXAMPLE_PDF,
        output_path: outputPath,
        signature_name: "does-not-matter",
        page: 1,
        x: "10",
        y: 10,
        width: 100,
        height: 20,
        user_intent_statement: "I intend to sign this test document.",
        user_confirmed_at: new Date().toISOString(),
      },
    });
    expect(result.isError).toBe(true);
    await expectMissing(outputPath);
  });

  // Each malformed record is one independent scenario with the ordinary test
  // budget. Active-state inspection now runs in a fresh isolated PDF worker;
  // one loop must not combine all six scenarios' worker starts into one budget.
  it.each(MALFORMED_SIGNATURE_RECORDS)("rejects malformed saved signature $slug before loading or mutating the active PDF", async ({ slug, record }) => {
    const initialized = await client.callTool({
      name: "set_active_document",
      arguments: {
        pdf_path: EXAMPLE_PDF,
        last_mutation_tool: "fill_pdf",
        last_mutation_at: "2026-07-21T08:02:03.000Z",
      },
    });
    expect(initialized.isError).not.toBe(true);
    // Both set/get_active_document return buildActiveDocumentPayload(path).
    // The setter already supplies the exact pre-operation payload to compare.
    const before = initialized.structuredContent;

    const signaturesDir = path.join(stateRoot, "profiles", "signatures");
    await fs.mkdir(signaturesDir, { recursive: true });
    await fs.writeFile(path.join(signaturesDir, `${slug}.json`), JSON.stringify(record));
    const outputPath = path.join(stateRoot, `${slug}.pdf`);
    const result = await client.callTool({
      name: "apply_signature",
      arguments: {
        pdf_path: EXAMPLE_PDF,
        output_path: outputPath,
        signature_name: slug,
        page: 1,
        x: 72,
        y: 600,
        width: 180,
        height: 40,
        user_intent_statement: "I intend to sign this automated validation document.",
        user_confirmed_at: new Date().toISOString(),
      },
    });
    expect(result.isError, slug).toBe(true);
    await expectMissing(outputPath);

    const after = await client.callTool({ name: "get_active_document", arguments: {} });
    expect(after.structuredContent, slug).toEqual(before);

    const loaded = await client.callTool({
      name: "load_signature",
      arguments: { signature_name: slug },
    });
    expect(loaded.isError, slug).toBe(true);
  });

  it("excludes every malformed saved signature from the signature list", async () => {
    // Populate the complete inventory here as well, so this aggregate check
    // remains meaningful when run alone or with a test-name filter.
    const signaturesDir = path.join(stateRoot, "profiles", "signatures");
    await fs.mkdir(signaturesDir, { recursive: true });
    for (const { slug, record } of MALFORMED_SIGNATURE_RECORDS) {
      await fs.writeFile(path.join(signaturesDir, `${slug}.json`), JSON.stringify(record));
    }

    const listed = await client.callTool({ name: "list_signatures", arguments: {} });
    expect(listed.isError).not.toBe(true);
    const listedNames = listed.structuredContent.signatures.map(signature => signature.name);
    for (const { slug } of MALFORMED_SIGNATURE_RECORDS) {
      expect(listedNames).not.toContain(slug);
    }
    expect(listedNames).not.toContain("different-signature");
  });

  it("keeps a valid image signature compatible across create, list, and load", async () => {
    const created = await client.callTool({
      name: "create_signature",
      arguments: {
        name: "valid-image",
        display_name: "Image Signer",
        image_data_url: `data:image/png;base64,${TINY_PNG_B64}`,
        overwrite: true,
      },
    });
    expect(created.isError).not.toBe(true);
    expect(created.structuredContent).toMatchObject({ name: "valid-image", style: "image" });

    const loaded = await client.callTool({
      name: "load_signature",
      arguments: { signature_name: "valid-image" },
    });
    expect(loaded.isError).not.toBe(true);
    expect(loaded.structuredContent).toMatchObject({
      name: "valid-image",
      style: "image",
      display_name: "Image Signer",
      preview_data_url: `data:image/png;base64,${TINY_PNG_B64}`,
    });

    const listed = await client.callTool({ name: "list_signatures", arguments: {} });
    expect(listed.isError).not.toBe(true);
    expect(listed.structuredContent.signatures).toEqual(expect.arrayContaining([
      expect.objectContaining({ name: "valid-image", style: "image", display_name: "Image Signer" }),
    ]));
  });

  it("returns normalized placement values that match the file mutation", async () => {
    const outputPath = path.join(stateRoot, "normalized-packet.pdf");
    const result = await client.callTool({
      name: "prepare_signing_packet",
      arguments: {
        pdf_path: EXAMPLE_PDF,
        output_path: outputPath,
        signature_locations: [{
          page: 1,
          x: 72,
          y: 600,
          width: 180,
          height: 40,
        }],
      },
    });
    expect(result.isError).not.toBe(true);
    expect(result.structuredContent).toMatchObject({
      pdf_path: outputPath,
      pending_signatures: [{
        label: "Sign here",
        page: 1,
        x: 72,
        y: 600,
        width: 180,
        height: 40,
      }],
    });
    await expect(fs.stat(outputPath)).resolves.toMatchObject({ size: expect.any(Number) });
  });
});
