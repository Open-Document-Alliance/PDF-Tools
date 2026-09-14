import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { PDFDocument, PDFName, PDFNumber, StandardFonts, degrees, rgb } from "pdf-lib";
import { validateStructuredToolResult } from "../server/output-schemas.js";
import {
  pdfComparisonEncryptedError,
  pdfComparisonEncryptedMessage,
  publicPdfComparisonError,
} from "../server/pdf-comparison.js";
import { PDF_LIB_ENCRYPTED_MESSAGE } from "../server/helpers.js";
import { createTestTempDirectory, removeTestTempDirectory } from "./helpers/temp-directory.js";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const FIXTURES = path.join(REPO_ROOT, "test/fixtures/eval/comparison/synthetic");
const BASE = path.join(FIXTURES, "comparison-base.pdf");
const ENCRYPTED = path.join(
  REPO_ROOT,
  "test/fixtures/eval/extraction/oracles/layout-encrypted-qpdf-r4.pdf",
);
const ENCRYPTED_PROVENANCE = path.join(
  REPO_ROOT,
  "test/fixtures/eval/extraction/oracles/layout-encrypted-qpdf-r4.provenance.json",
);

// The generic text every internal-validation failure carries. compare_pdfs used
// to answer an encrypted document with this, and no assertion below may ever be
// satisfied by it again.
const INTERNAL_VALIDATION_TEXT = "Internal output validation failed";

const PAIRS = Object.freeze({
  identical: ["comparison-base.pdf", []],
  material_text: ["comparison-material-text-after.pdf", ["semantic_text", "semantic_text"]],
  visual_only: ["comparison-visual-status-after.pdf", ["visual"]],
  layout_noise: ["comparison-layout-noise-after.pdf", ["visual"]],
  metadata_only: ["comparison-metadata-only-after.pdf", ["metadata", "metadata"]],
  pages_reordered: ["comparison-pages-reordered-after.pdf", ["structure"]],
  form_annotation: ["comparison-form-annotation-after.pdf", ["form_field", "annotation"]],
});

describe("compare_pdfs deterministic product", () => {
  let client;
  let transport;
  let materialResult;
  let tempDirectory;

  beforeAll(async () => {
    tempDirectory = await createTestTempDirectory(REPO_ROOT, "compare-pdfs");
    client = new Client({ name: "compare-pdfs-test", version: "1.0.0" });
    transport = new StdioClientTransport({
      command: process.execPath,
      args: [path.join(REPO_ROOT, "server/index.js")],
      cwd: REPO_ROOT,
      env: { ...process.env, ALLOWED_DIRECTORIES: REPO_ROOT },
      stderr: "pipe",
    });
    await client.connect(transport);
  }, 30_000);

  afterAll(async () => {
    try {
      await client?.close();
      await transport?.close();
    } finally {
      await removeTestTempDirectory(tempDirectory);
    }
  });

  it("publishes the exact closed-world whole-document input contract", async () => {
    const tools = (await client.listTools()).tools;
    const tool = tools.find(item => item.name === "compare_pdfs");
    expect(tool).toMatchObject({
      annotations: {
        title: "Compare PDFs",
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
      inputSchema: {
        type: "object",
        additionalProperties: false,
        required: ["before_pdf_path", "after_pdf_path"],
      },
    });
    expect(tool.inputSchema.properties).toEqual(expect.objectContaining({
      before_password: expect.objectContaining({ maxLength: 4096 }),
      after_password: expect.objectContaining({ maxLength: 4096 }),
      mode: expect.objectContaining({ enum: ["default_material", "forensic"] }),
      max_pages: expect.objectContaining({ minimum: 1, maximum: 20 }),
      max_output_characters: expect.objectContaining({ minimum: 20000, maximum: 200000 }),
    }));
  });

  it.each(Object.entries(PAIRS))("discriminates the public synthetic %s comparison role", async (role, [afterName, expectedKinds]) => {
      const result = await client.callTool({
        name: "compare_pdfs",
        arguments: {
          before_pdf_path: BASE,
          after_pdf_path: path.join(FIXTURES, afterName),
          max_output_characters: 200_000,
        },
      });
      expect(result.isError, role).not.toBe(true);
      expect(validateStructuredToolResult("compare_pdfs", result), role).toBe(result);
      expect(result.structuredContent.changes.map(change => change.kind), role).toEqual(expectedKinds);
      expect(result.structuredContent.summary.equivalence_claim, role).toBe(false);
      if (role === "material_text") materialResult = result;
      if (role === "layout_noise") {
        expect(result.structuredContent.changes[0].presentation).toMatchObject({
          disposition: "suppress",
          reversible_reason_code: "CALIBRATED_LAYOUT_NOISE",
        });
      }
      if (role === "visual_only") {
        expect(result.structuredContent.changes[0]).toMatchObject({
          salience: "minor",
          presentation: {
            disposition: "report",
            reversible_reason_code: null,
          },
        });
      }
      if (role === "metadata_only") {
        expect(result.structuredContent.changes.every(change =>
          change.presentation.disposition === "suppress")).toBe(true);
        expect(result.structuredContent.changes.map(change =>
          change.presentation.reversible_reason_code).sort())
          .toEqual(["METADATA_ONLY_DEFAULT", "VOLATILE_METADATA"]);
      }
      if (role === "pages_reordered") {
        expect(result.structuredContent.page_alignments.map(item => item.relation)).toEqual(["moved", "moved"]);
      }
      if (role === "form_annotation") {
        expect(result.structuredContent.changes[0].facets.map(facet => facet.channel))
          .toEqual(["form_field", "visual"]);
        const annotationChange = result.structuredContent.changes.find(change => change.kind === "annotation");
        expect(annotationChange.facets).toEqual([expect.objectContaining({
          channel: "annotation",
          operation: "added",
          before_evidence_id: null,
        })]);
        const annotationEvidence = result.structuredContent.observations.find(observation =>
          observation.id === annotationChange.facets[0].after_evidence_id);
        expect(annotationEvidence).toMatchObject({
          channel: "annotation",
          page: 1,
          canonical_value: "Synthetic reviewer note: verify status.",
        });
        expect(annotationEvidence.native_region).not.toBeNull();
        expect(annotationEvidence.display_region).toEqual([360, 332, 22, 22]);
        expect(result.structuredContent.resource_usage).toMatchObject({
          network_requests: 0,
          external_persistence_writes: 0,
        });
      }
  }, 30_000);

  it("retains independent page and same-page visual changes alongside semantic text changes", async () => {
    async function makeMixedChangePdf(fileName, balance, rectangleColor, rectanglePage = 2) {
      const pdf = await PDFDocument.create({ updateMetadata: false });
      const font = await pdf.embedFont(StandardFonts.Helvetica);
      const first = pdf.addPage([400, 400]);
      first.drawText(`Current account balance: USD ${balance}`, {
        x: 40,
        y: 330,
        size: 16,
        font,
      });
      if (rectanglePage === 1) {
        first.drawRectangle({ x: 80, y: 160, width: 120, height: 80, color: rectangleColor });
      }
      const second = pdf.addPage([400, 400]);
      second.drawText("Stable independent visual page", { x: 40, y: 330, size: 16, font });
      if (rectanglePage === 2) {
        second.drawRectangle({ x: 80, y: 160, width: 120, height: 80, color: rectangleColor });
      }
      const filename = path.join(tempDirectory, fileName);
      await fs.writeFile(filename, await pdf.save());
      return filename;
    }

    const before = await makeMixedChangePdf("mixed-before.pdf", 10, rgb(0, 0, 0));
    const visualOnly = await makeMixedChangePdf("mixed-visual-only.pdf", 10, rgb(1, 0, 0));
    const mixed = await makeMixedChangePdf("mixed-text-and-visual.pdf", 20, rgb(1, 0, 0));
    const samePageBefore = await makeMixedChangePdf("same-page-before.pdf", 10, rgb(0, 0, 0), 1);
    const samePageAfter = await makeMixedChangePdf("same-page-after.pdf", 20, rgb(1, 0, 0), 1);
    const compare = async after => client.callTool({
      name: "compare_pdfs",
      arguments: {
        before_pdf_path: before,
        after_pdf_path: after,
        max_output_characters: 200_000,
      },
    });

    const visualOnlyResult = await compare(visualOnly);
    const mixedResult = await compare(mixed);
    const samePageResult = await client.callTool({
      name: "compare_pdfs",
      arguments: {
        before_pdf_path: samePageBefore,
        after_pdf_path: samePageAfter,
        max_output_characters: 200_000,
      },
    });
    expect(visualOnlyResult.isError).not.toBe(true);
    expect(mixedResult.isError).not.toBe(true);
    const visualOnlyChange = visualOnlyResult.structuredContent.changes.find(change => change.kind === "visual");
    const mixedVisualChange = mixedResult.structuredContent.changes.find(change => change.kind === "visual");
    expect(visualOnlyChange).toBeTruthy();
    expect(mixedResult.structuredContent.changes.map(change => change.kind))
      .toEqual(["semantic_text", "visual"]);
    expect(mixedVisualChange).toBeTruthy();
    const mixedVisualObservations = mixedVisualChange.facets.flatMap(facet => [
      facet.before_evidence_id,
      facet.after_evidence_id,
    ]).map(id => mixedResult.structuredContent.observations.find(observation => observation.id === id));
    expect(mixedVisualObservations.every(observation => observation.page === 2)).toBe(true);
    // Bug 1: these fixtures draw a rectangle on a page, so that page's IR
    // extraction_status is "partial" (mixed-content, not a clean text-layer
    // candidate). The text channel cannot observe that non-text content, so
    // semantic and text coverage now degrade to partial and the overall status
    // is "partial" — the honest statement that text comparison alone did not
    // fully cover the page. The visual channel still covers it and stays
    // supported, which is what this test is really asserting.
    expect(mixedResult.structuredContent).toMatchObject({
      status: "partial",
      coverage: { visual: { status: "supported", reason_codes: [] } },
      resource_usage: {
        aligned_page_visual_comparisons_requested: 2,
        aligned_page_visual_comparisons_completed: 2,
      },
    });
    expect(mixedVisualChange.facets[0].operation).toBe(visualOnlyChange.facets[0].operation);
    expect(samePageResult.isError).not.toBe(true);
    expect(samePageResult.structuredContent.changes.map(change => change.kind))
      .toEqual(["semantic_text", "visual"]);
    const samePageVisualChange = samePageResult.structuredContent.changes.find(change => change.kind === "visual");
    const samePageVisualObservations = samePageVisualChange.facets.flatMap(facet => [
      facet.before_evidence_id,
      facet.after_evidence_id,
    ]).map(id => samePageResult.structuredContent.observations.find(observation => observation.id === id));
    expect(samePageVisualObservations.every(observation => observation.page === 1)).toBe(true);
  }, 30_000);

  it("keeps visual-not-requested outside status while preserving typed coverage", async () => {
    const beforeBytes = await fs.readFile(BASE);
    const beforeStats = await fs.stat(BASE);
    const result = await client.callTool({
      name: "compare_pdfs",
      arguments: { before_pdf_path: BASE, after_pdf_path: BASE, include_visual: false },
    });
    const repeated = await client.callTool({
      name: "compare_pdfs",
      arguments: { before_pdf_path: BASE, after_pdf_path: BASE, include_visual: false },
    });
    expect(result.isError).not.toBe(true);
    // Bug 1: comparison-base.pdf draws a status rectangle on its service page,
    // so that page's IR extraction_status is "partial" (mixed-content). The
    // text channel cannot observe non-text content, so even a document compared
    // to itself no longer claims fully supported semantic/text coverage: the
    // status is "partial" and no_reported_changes is false. An empty change set
    // on incompletely covered channels is no longer reported as trivially green,
    // which is the whole point of the coverage-honesty fix. equivalence_claim
    // stays false regardless.
    expect(result.structuredContent).toMatchObject({
      status: "partial",
      coverage: { visual: { status: "unavailable", reason_codes: ["VISUAL_NOT_REQUESTED"] } },
      summary: { no_reported_changes: false, equivalence_claim: false },
    });
    const afterBytes = await fs.readFile(BASE);
    const afterStats = await fs.stat(BASE);
    expect(afterBytes).toEqual(beforeBytes);
    expect(afterStats.size).toBe(beforeStats.size);
    expect(afterStats.mtimeMs).toBe(beforeStats.mtimeMs);
    expect(result.structuredContent.before_source.sha256)
      .toBe(createHash("sha256").update(beforeBytes).digest("hex"));
    expect(result.structuredContent.source_immutability).toMatchObject({
      before: { unchanged: true },
      after: { unchanged: true },
    });
    expect(repeated.structuredContent.comparison_sha256)
      .toBe(result.structuredContent.comparison_sha256);
  }, 15_000);

  it("fails whole-document comparison instead of comparing prefixes", async () => {
    const result = await client.callTool({
      name: "compare_pdfs",
      arguments: { before_pdf_path: BASE, after_pdf_path: BASE, max_pages: 1 },
    });
    expect(result.isError).toBe(true);
    expect(result.structuredContent.error.code).toBe("COMPARISON_PAGE_LIMIT_EXCEEDED");
  });

  it("compares all pages through bounded Extraction IR chunks up to the advertised limit", async () => {
    const pdf = await PDFDocument.create();
    const font = await pdf.embedFont(StandardFonts.Helvetica);
    for (let pageNumber = 1; pageNumber <= 11; pageNumber += 1) {
      const page = pdf.addPage([612, 792]);
      page.drawText(`Unique comparison page ${pageNumber}`, { x: 72, y: 700, size: 14, font });
    }
    const filename = path.join(tempDirectory, "eleven-pages.pdf");
    await fs.writeFile(filename, await pdf.save());
    const result = await client.callTool({
      name: "compare_pdfs",
      arguments: {
        before_pdf_path: filename,
        after_pdf_path: filename,
        max_pages: 20,
        include_visual: false,
        max_output_characters: 200_000,
      },
    });
    expect(result.isError).not.toBe(true);
    expect(result.structuredContent.page_alignments).toHaveLength(11);
    expect(result.structuredContent.changes).toEqual([]);
    expect(result.structuredContent.summary).toMatchObject({
      no_reported_changes: true,
      equivalence_claim: false,
    });
  }, 30_000);

  it("detects aligned CropBox origin, rotation, and UserUnit geometry changes", async () => {
    async function makeGeometryPdf(fileName, { cropX, rotation, userUnit }) {
      const pdf = await PDFDocument.create();
      const page = pdf.addPage([400, 400]);
      const font = await pdf.embedFont(StandardFonts.Helvetica);
      page.setCropBox(cropX, 100, 200, 200);
      page.setRotation(degrees(rotation));
      page.node.set(PDFName.of("UserUnit"), PDFNumber.of(userUnit));
      page.drawText("Stable geometry page", { x: 120, y: 260, size: 12, font });
      const filename = path.join(tempDirectory, fileName);
      await fs.writeFile(filename, await pdf.save());
      return filename;
    }
    const before = await makeGeometryPdf("geometry-before.pdf", { cropX: 100, rotation: 0, userUnit: 1 });
    const after = await makeGeometryPdf("geometry-after.pdf", { cropX: 80, rotation: 90, userUnit: 2 });
    const result = await client.callTool({
      name: "compare_pdfs",
      arguments: {
        before_pdf_path: before,
        after_pdf_path: after,
        include_visual: false,
        max_output_characters: 200_000,
      },
    });
    expect(result.isError).not.toBe(true);
    expect(result.structuredContent.changes.map(change => change.kind)).toContain("structure");
    const structure = result.structuredContent.changes.find(change => change.kind === "structure");
    expect(structure.facets).toEqual([expect.objectContaining({
      channel: "structure",
      operation: "modified",
    })]);
  }, 30_000);

  it("preserves truthful clipped or off-page PDF.js evidence coordinates", async () => {
    async function makeOffPagePdf(fileName, text) {
      const pdf = await PDFDocument.create();
      const page = pdf.addPage([300, 180]);
      const font = await pdf.embedFont(StandardFonts.Helvetica);
      page.drawText(text, { x: 30, y: 100, size: 18, font });
      const filename = path.join(tempDirectory, fileName);
      await fs.writeFile(filename, await pdf.save());
      return filename;
    }
    const before = await makeOffPagePdf("off-page-before.pdf", "Packaged PDF Tools smoke test");
    const after = await makeOffPagePdf("off-page-after.pdf", "Packaged PDF Tools revised smoke test");
    const result = await client.callTool({
      name: "compare_pdfs",
      arguments: {
        before_pdf_path: before,
        after_pdf_path: after,
        include_visual: false,
        max_output_characters: 200_000,
      },
    });
    expect(result.isError).not.toBe(true);
    const evidence = result.structuredContent.observations.find(item => item.channel === "text"
      && item.display_region[0] + item.display_region[2] > item.page_box[2]);
    expect(evidence).toBeTruthy();
    expect(evidence.display_region[0] + evidence.display_region[2])
      .toBeGreaterThan(evidence.page_box[2]);
  }, 30_000);

  it("rejects unknown input and scrubs path and password sentinels", async () => {
    const inputSentinel = "SECRET_UNKNOWN_INPUT_SENTINEL";
    const unknown = await client.callTool({
      name: "compare_pdfs",
      arguments: { before_pdf_path: BASE, after_pdf_path: BASE, [inputSentinel]: true },
    });
    expect(unknown.isError).toBe(true);
    expect(JSON.stringify(unknown)).not.toContain(inputSentinel);
    /*
     * A rejected argument produces this same text whatever else the caller
     * varies, so it reads like a failure of the documents rather than of the
     * call — which is exactly how an encrypted-comparison report was once
     * misread as the encryption refusal being swallowed. The single most likely
     * mistake is `password`, because every other tool in this server takes one
     * and this tool takes two, so the refusal says so by name.
     */
    const unknownText = unknown.content?.map(part => part.text ?? "").join("\n") ?? "";
    expect(unknownText).toContain("before_password");
    expect(unknownText).toContain("after_password");
    expect(unknownText).toMatch(/no single 'password' argument/);
    expect(unknownText).toContain("absolute");
    // Naming the accepted arguments is safe — they are in the published input
    // schema. Naming the caller's own rejected key is not, and never happens.
    const advertised = (await client.listTools()).tools
      .find(item => item.name === "compare_pdfs");
    for (const name of Object.keys(advertised.inputSchema.properties)) {
      expect(unknownText, name).toContain(name);
    }

    const pathSentinel = "PRIVATE_INTERNAL_PATH_SENTINEL";
    const missing = await client.callTool({
      name: "compare_pdfs",
      arguments: {
        before_pdf_path: path.join(REPO_ROOT, `${pathSentinel}.pdf`),
        after_pdf_path: BASE,
      },
    });
    expect(missing.isError).toBe(true);
    expect(missing.structuredContent.error.code).toBe("PDF_UNAVAILABLE");
    expect(JSON.stringify(missing)).not.toContain(pathSentinel);

    const parserSentinel = "PRIVATE_PARSER_MESSAGE_SENTINEL";
    const malformedPath = path.join(tempDirectory, `${parserSentinel}.pdf`);
    await fs.writeFile(malformedPath, `%PDF-1.7\n${parserSentinel}\n%%EOF\n`);
    const malformed = await client.callTool({
      name: "compare_pdfs",
      arguments: {
        before_pdf_path: malformedPath,
        after_pdf_path: BASE,
        include_visual: false,
      },
    });
    expect(malformed.isError).toBe(true);
    expect(malformed.structuredContent.error.code).toBe("PDF_PARSE_FAILED");
    expect(JSON.stringify(malformed)).not.toContain(parserSentinel);

    const passwordSentinel = "PASSWORD_DO_NOT_ECHO_SENTINEL";
    const protectedResult = await client.callTool({
      name: "compare_pdfs",
      arguments: {
        before_pdf_path: ENCRYPTED,
        after_pdf_path: ENCRYPTED,
        before_password: passwordSentinel,
        after_password: passwordSentinel,
      },
    });
    expect(protectedResult.isError).toBe(true);
    // A wrong password used to be reported as a wrong password, which implied
    // the right one would work. It would not: no password makes an encrypted
    // comparison run, so the refusal is the encryption one either way.
    expect(protectedResult.structuredContent.error.code)
      .toBe("PDF_ENCRYPTED_COMPARISON_UNSUPPORTED");
    expect(JSON.stringify(protectedResult)).not.toContain(passwordSentinel);
  });

  /*
   * An encrypted comparison input is a real, user-correctable condition, and it
   * used to be reported three different ways depending on arguments the caller
   * had no reason to connect to encryption:
   *
   *   - no password              -> "A comparison input requires its password",
   *                                 which asks for something that cannot help;
   *   - correct password         -> the pdf-lib limit, with no side named;
   *   - correct password and     -> "Internal output validation failed for
   *     include_visual: false       compare_pdfs", because the observation's
   *                                 RAW_PAGE_GEOMETRY_UNAVAILABLE reached the
   *                                 comparison's structure channel, which had
   *                                 never heard of it.
   *
   * All three are now one refusal that names the side, the cause, and what to
   * do. These cases pin that, and every one of them asserts the absence of the
   * internal-validation text so the third can never come back quietly.
   */
  describe("encrypted comparison inputs", () => {
    let passwords;

    beforeAll(async () => {
      passwords = JSON.parse(await fs.readFile(ENCRYPTED_PROVENANCE, "utf8")).passwords;
    });

    const compare = async args => await client.callTool({
      name: "compare_pdfs",
      arguments: { max_output_characters: 200_000, ...args },
    });
    const textOf = result => result.content?.map(part => part.text ?? "").join("\n") ?? "";

    it("refuses with the same named message however the encrypted input is reached", async () => {
      const cases = [
        ["both, no password", ["before", "after"], {
          before_pdf_path: ENCRYPTED, after_pdf_path: ENCRYPTED,
        }],
        ["both, correct passwords", ["before", "after"], {
          before_pdf_path: ENCRYPTED, after_pdf_path: ENCRYPTED,
          before_password: passwords.user, after_password: passwords.user,
        }],
        // The case that produced the internal error: no render is requested, so
        // the pdf-lib geometry step never refuses and the comparison used to
        // complete and then fail its own semantics validator.
        ["both, correct passwords, no visual", ["before", "after"], {
          before_pdf_path: ENCRYPTED, after_pdf_path: ENCRYPTED,
          before_password: passwords.user, after_password: passwords.user,
          include_visual: false,
        }],
        ["before only", ["before"], {
          before_pdf_path: ENCRYPTED, after_pdf_path: BASE,
          before_password: passwords.user,
        }],
        ["after only", ["after"], {
          before_pdf_path: BASE, after_pdf_path: ENCRYPTED,
          after_password: passwords.user,
        }],
        ["both, wrong passwords", ["before", "after"], {
          before_pdf_path: ENCRYPTED, after_pdf_path: ENCRYPTED,
          before_password: passwords.wrong_password_oracle,
          after_password: passwords.wrong_password_oracle,
        }],
      ];
      for (const [label, sides, args] of cases) {
        const result = await compare(args);
        expect(result.isError, label).toBe(true);
        // Asserted on the SERVED response, at the MCP boundary. A module that
        // returns the right thing is not the same claim as a caller receiving
        // it: the code and the text have to survive every classifier between
        // the refusal and the wire.
        expect(result.structuredContent.error.code, label)
          .toBe("PDF_ENCRYPTED_COMPARISON_UNSUPPORTED");
        // Literal phrases, deliberately not routed through the message helper,
        // so a gutted or re-swallowed message cannot satisfy this by agreeing
        // with itself.
        expect(textOf(result), label)
          .toContain("cannot compare an encrypted document");
        expect(textOf(result), label)
          .toContain("supplying a password here will not help");
        // The two ways this has actually been swallowed before.
        expect(textOf(result), label).not.toContain(INTERNAL_VALIDATION_TEXT);
        expect(result.structuredContent.error.code, label).not.toBe("invalid_input");
        expect(textOf(result), label)
          .not.toContain("The compare_pdfs arguments or PDF inputs are invalid");
        // And still exactly the server's own text, so tool and module agree.
        expect(textOf(result), label).toBe(pdfComparisonEncryptedMessage(sides));
        expect(JSON.stringify(result), label).not.toContain(passwords.user);
        expect(JSON.stringify(result), label)
          .not.toContain(passwords.wrong_password_oracle);
      }
    }, 120_000);

    it("keeps the refusal classified when it arrives without its error code", () => {
      /*
       * `error.code` is an own property of an Error and does not survive a
       * boundary that rebuilds the error from its message. When that happened
       * the refusal fell through to `invalid_input`, "the arguments or PDF
       * inputs are invalid" — a false statement about a call whose arguments
       * were fine, and indistinguishable from a genuine argument mistake.
       */
      const carried = pdfComparisonEncryptedError(["before"]);
      expect(publicPdfComparisonError(carried).code)
        .toBe("PDF_ENCRYPTED_COMPARISON_UNSUPPORTED");
      // Same refusal, rebuilt from text alone.
      const stripped = new Error(pdfComparisonEncryptedMessage(["before"]));
      expect(stripped.code).toBeUndefined();
      expect(publicPdfComparisonError(stripped).code)
        .toBe("PDF_ENCRYPTED_COMPARISON_UNSUPPORTED");
      // And a real argument mistake must still classify as one, or the guard
      // above would just be swallowing everything in the other direction.
      expect(publicPdfComparisonError(new Error("Unknown compare_pdfs argument: nope.")).code)
        .toBe("invalid_input");
    });

    it("translates the pdf-lib limit in the layer that is allowed to see it", async () => {
      /*
       * The other encryption signal is the shared pdf-lib "no decryption
       * support" message, raised by the page renderer inside the PDF.js
       * subprocess. It cannot be matched in server/pdf-comparison.js: that
       * module's static import graph is closed and asserted by
       * test/eval/extraction-phase1-generation-verifiers.test.js, and importing
       * server/helpers.js for the constant would pull pdf-lib into the
       * extraction scorer's graph. So server/index.js owns the translation, and
       * both halves of that split are pinned here — otherwise the next edit
       * "simplifies" one of them and the refusal silently degrades to
       * invalid_input again.
       */
      const comparison = await fs.readFile(
        path.join(REPO_ROOT, "server/pdf-comparison.js"), "utf8",
      );
      expect(comparison).not.toMatch(/from\s+"\.\/helpers\.js"/);
      const server = await fs.readFile(path.join(REPO_ROOT, "server/index.js"), "utf8");
      // Substring, never equality: a subprocess boundary may prefix the text,
      // and an equality check that stops matching fails silently rather than
      // loudly.
      expect(server).toMatch(
        /function comparisonSawPdfLibEncryptionLimit[\s\S]{0,400}?\.includes\(PDF_LIB_ENCRYPTED_MESSAGE\)/,
      );
      // Scoped to the comparison's own classifier. Other tools keep their own
      // equality checks against this constant, and those are not this test's
      // business.
      const classifier = server.slice(
        server.indexOf("function comparisonEncryptionFailure"),
        server.indexOf("function comparisonInputIsEncrypted"),
      );
      expect(classifier.length).toBeGreaterThan(0);
      expect(classifier).toContain("comparisonSawPdfLibEncryptionLimit(error)");
      expect(classifier).not.toMatch(/message === PDF_LIB_ENCRYPTED_MESSAGE/);
      // The constant it matches is the real one the family publishes.
      expect(PDF_LIB_ENCRYPTED_MESSAGE).toMatch(/no decryption support/);
    });

    it("says which input, why it stops, and what the caller can do instead", () => {
      // Derived from the message rather than restated beside it: a rewrite that
      // drops any of these propositions fails here.
      for (const [sides, subject] of [
        [["before"], "The before comparison input is encrypted"],
        [["after"], "The after comparison input is encrypted"],
        [["before", "after"], "Both comparison inputs are encrypted"],
        [[], "A comparison input is encrypted"],
      ]) {
        expect(pdfComparisonEncryptedMessage(sides)).toContain(subject);
      }
      const message = pdfComparisonEncryptedMessage(["before", "after"]);
      // Why: the incidental pdf-lib step, named as the family names it.
      expect(message).toMatch(/pdf-lib/);
      expect(message).toMatch(/no decryption support/);
      // And therefore why the password arguments are not the answer.
      expect(message).toMatch(/supplying a password here will not help/);
      expect(message).not.toMatch(/provide the correct password/i);
      expect(message).not.toMatch(/ignoreEncryption/);
      // That it stops rather than reporting a thinner comparison.
      expect(message).toMatch(/it stops/);
      // What to do, and where an encrypted document can actually be read. The
      // named tools are exactly the ones the pdf-lib family message names, and
      // test/encrypted-pdf-password-truth.test.js proves each of them opens an
      // encrypted document with its password.
      expect(message).toMatch(/Decrypt both documents first \(for example with qpdf\)/);
      for (const tool of ["read_pdf_layout", "convert_pdf_to_markdown", "get_pdf_info"]) {
        expect(PDF_LIB_ENCRYPTED_MESSAGE, tool).toContain(tool);
        expect(message, tool).toContain(tool);
      }
      expect(message).not.toContain(INTERNAL_VALIDATION_TEXT);
    });

    it("reports missing raw page geometry as coverage, not as an internal fault", async () => {
      /*
       * The other half of the same defect, and the half that has nothing to do
       * with encryption. `observe_document` reads raw page geometry with
       * pdf-lib and falls back to PDF.js when it cannot, recording
       * RAW_PAGE_GEOMETRY_UNAVAILABLE. The comparison copied that into its
       * structure channel and then rejected it as an unknown reason, so any
       * unprotected document pdf-lib cannot parse but PDF.js can — here, one
       * whose %PDF- marker has been overwritten, the same damage the encrypted
       * layout oracle carries deliberately — answered with "Internal output
       * validation failed" instead of a partial comparison.
       */
      const damaged = path.join(tempDirectory, "damaged-header-base.pdf");
      const bytes = Buffer.from(await fs.readFile(BASE));
      bytes.write("xxxxx", 0, "latin1");
      await fs.writeFile(damaged, bytes);
      const result = await compare({
        before_pdf_path: damaged,
        after_pdf_path: path.join(FIXTURES, PAIRS.material_text[0]),
        include_visual: false,
      });
      expect(textOf(result)).not.toContain(INTERNAL_VALIDATION_TEXT);
      expect(result.isError).not.toBe(true);
      expect(validateStructuredToolResult("compare_pdfs", result)).toBe(result);
      expect(result.structuredContent.coverage.structure).toEqual({
        status: "partial",
        reason_codes: ["BEFORE_RAW_PAGE_GEOMETRY_UNAVAILABLE"],
      });
      expect(result.structuredContent.status).toBe("partial");
      expect(result.structuredContent.summary.no_reported_changes).toBe(false);
      expect(result.structuredContent.limitations)
        .toContain("structure:BEFORE_RAW_PAGE_GEOMETRY_UNAVAILABLE");
    }, 60_000);

    it("still compares two unprotected documents, which is the advice it gives", async () => {
      // The refusal tells the caller to compare decrypted copies. That has to
      // remain a real route, so the same run proves it.
      const result = await compare({
        before_pdf_path: BASE,
        after_pdf_path: path.join(FIXTURES, PAIRS.material_text[0]),
      });
      expect(result.isError).not.toBe(true);
      expect(validateStructuredToolResult("compare_pdfs", result)).toBe(result);
      expect(result.structuredContent.status).toEqual(expect.any(String));
    }, 60_000);
  });

  it("fails rather than dropping raw changes at the structured-output cap", async () => {
    async function makeFormPdf(fileName, valuePrefix) {
      const pdf = await PDFDocument.create();
      const page = pdf.addPage([612, 792]);
      const font = await pdf.embedFont(StandardFonts.Helvetica);
      const form = pdf.getForm();
      for (let index = 0; index < 60; index += 1) {
        const field = form.createTextField(`Field-${String(index).padStart(3, "0")}`);
        field.setText(`${valuePrefix}-${index}-${"x".repeat(80)}`);
        field.addToPage(page, {
          x: 36 + (index % 3) * 190,
          y: 750 - Math.floor(index / 3) * 34,
          width: 175,
          height: 20,
          font,
        });
      }
      const filename = path.join(tempDirectory, fileName);
      await fs.writeFile(filename, await pdf.save({ updateFieldAppearances: true }));
      return filename;
    }
    const before = await makeFormPdf("many-before.pdf", "before");
    const after = await makeFormPdf("many-after.pdf", "after");
    const result = await client.callTool({
      name: "compare_pdfs",
      arguments: {
        before_pdf_path: before,
        after_pdf_path: after,
        include_visual: false,
        max_output_characters: 20_000,
      },
    });
    expect(result.isError).toBe(true);
    expect(result.structuredContent.error.code).toBe("COMPARISON_OUTPUT_LIMIT_EXCEEDED");
  }, 30_000);

  it("keeps field type, options, flags, page, and widget geometry as independent changes", async () => {
    async function makeFieldPdf(fileName, {
      kind = "text",
      options = ["Alpha", "Beta"],
      required = false,
      readOnly = false,
      fieldPage = 1,
      x = 72,
    } = {}) {
      const pdf = await PDFDocument.create();
      const font = await pdf.embedFont(StandardFonts.Helvetica);
      const pages = [pdf.addPage([612, 792]), pdf.addPage([612, 792])];
      pages[0].drawText("Logical first page", { x: 72, y: 720, size: 14, font });
      pages[1].drawText("Logical second page", { x: 72, y: 720, size: 14, font });
      const form = pdf.getForm();
      let field;
      if (kind === "checkbox") {
        field = form.createCheckBox("AccountField");
        field.addToPage(pages[fieldPage - 1], { x, y: 650, width: 20, height: 20 });
      } else if (kind === "dropdown") {
        field = form.createDropdown("AccountField");
        field.addOptions(options);
        field.select(options[0]);
        field.addToPage(pages[fieldPage - 1], { x, y: 650, width: 180, height: 22, font });
      } else {
        field = form.createTextField("AccountField");
        field.setText("Stable value");
        field.addToPage(pages[fieldPage - 1], { x, y: 650, width: 180, height: 22, font });
      }
      if (required) field.enableRequired();
      if (readOnly) field.enableReadOnly();
      const filename = path.join(tempDirectory, fileName);
      await fs.writeFile(filename, await pdf.save({ updateFieldAppearances: true }));
      return filename;
    }
    const compare = async (before, after) => {
      const result = await client.callTool({
        name: "compare_pdfs",
        arguments: {
          before_pdf_path: before,
          after_pdf_path: after,
          include_visual: false,
          max_output_characters: 200_000,
        },
      });
      expect(result.isError).not.toBe(true);
      return result.structuredContent.changes.map(change => change.summary);
    };

    const text = await makeFieldPdf("field-text.pdf");
    const checkbox = await makeFieldPdf("field-checkbox.pdf", { kind: "checkbox" });
    expect((await compare(text, checkbox)).some(summary => summary.includes(" type modified"))).toBe(true);

    const optionsBefore = await makeFieldPdf("field-options-before.pdf", { kind: "dropdown" });
    const optionsAfter = await makeFieldPdf("field-options-after.pdf", { kind: "dropdown", options: ["Alpha", "Gamma"] });
    expect((await compare(optionsBefore, optionsAfter)).some(summary => summary.includes(" options modified"))).toBe(true);

    const flagsAfter = await makeFieldPdf("field-flags-after.pdf", { required: true, readOnly: true });
    expect((await compare(text, flagsAfter)).some(summary => summary.includes(" flags modified"))).toBe(true);

    const geometryAfter = await makeFieldPdf("field-geometry-after.pdf", { x: 180 });
    expect((await compare(text, geometryAfter)).some(summary => summary.includes("widget_display_region modified"))).toBe(true);

    const pageAfter = await makeFieldPdf("field-page-after.pdf", { fieldPage: 2 });
    expect((await compare(text, pageAfter)).some(summary => summary.includes(" widget_page modified"))).toBe(true);
  }, 60_000);

  it("fails closed on every reproduced envelope mutation", () => {
    expect(materialResult).toBeTruthy();
    const mutations = [
      // Bug 1 made material_text's own coverage partial (its service page draws
      // a rectangle, so extraction_status is "partial" and semantic/text
      // coverage degrade). These two mutations previously moved a supported
      // value to "partial"; that would now be a no-op that the envelope digest
      // cannot catch, so they move it the other way — asserting the same
      // fail-closed invariant against a payload whose valid state is partial.
      value => { value.status = "complete"; },
      value => { value.coverage.text.status = "supported"; },
      value => { value.coverage.text.reason_codes.push("MUTATED"); },
      value => { value.coverage.text = { status: "unavailable", reason_codes: [] }; },
      value => { value.coverage.text = { status: "supported", reason_codes: ["MUTATED"] }; },
      value => { value.limitations.push("text:MUTATED"); },
      value => { value.before_source.size_bytes += 1; },
      value => { value.before_source.file_name = "mutated.pdf"; },
      value => { value.before_source.canonical_path += ".mutated"; },
      value => { value.source_immutability.before.final_sha256 = "0".repeat(64); },
      value => { value.before_source.observation_sha256 = "0".repeat(64); },
      value => { value.before_source.page_count += 1; },
      value => { value.page_alignments.pop(); },
      value => { value.page_alignments[0].before_page = value.before_source.page_count + 1; },
      value => { value.summary.reported_change_count = 0; },
      value => { value.summary.no_reported_changes = true; },
      value => { value.resource_usage.network_requests = 1; },
      value => { value.resource_usage.aligned_page_visual_comparisons_completed -= 1; },
      value => { value.observations[0].document_sha256 = "0".repeat(64); },
      value => { value.observations[0].page = value.before_source.page_count + 1; },
      value => { value.observations[0].native_region = [0, 0, -1, 1]; },
      value => { value.changes[0].facets.push(structuredClone(value.changes[0].facets[0])); },
      value => { value.changes[0].facets[0].operation = "added"; },
      value => { value.comparison_sha256 = "0".repeat(64); },
    ];
    for (const mutate of mutations) {
      const candidate = structuredClone(materialResult);
      mutate(candidate.structuredContent);
      const validated = validateStructuredToolResult("compare_pdfs", candidate);
      expect(validated.isError).toBe(true);
      expect(validated.structuredContent.error.code).toBe("internal_validation_error");
    }
  });
});
