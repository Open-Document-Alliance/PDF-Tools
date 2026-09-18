import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { PDFDocument, PDFName, PDFNumber, PDFString, StandardFonts, degrees } from "pdf-lib";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { TOOL_OUTPUT_SCHEMAS } from "../server/output-schemas.js";
import { projectMarkdownTable, scoreTable } from "./eval/extraction-bakeoff-scorer.js";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const MIXED = path.join(REPO_ROOT, "test/fixtures/eval/extraction/synthetic/mixed-text-raster.pdf");
const RASTER = path.join(REPO_ROOT, "test/fixtures/eval/extraction/synthetic/raster-clean.pdf");
const TABLE = path.join(REPO_ROOT, "test/fixtures/eval/extraction/synthetic/table-merged-blank.pdf");
const ROTATED_CROP = path.join(REPO_ROOT, "test/fixtures/golden-forms/rotated-signature.pdf");
const VERTICAL_UNICODE = path.join(REPO_ROOT, "test/fixtures/eval/extraction/oracles/layout-unijis-vertical.pdf");
const ENCRYPTED = path.join(REPO_ROOT, "test/fixtures/eval/extraction/oracles/layout-encrypted-qpdf-r4.pdf");

async function makeStructureFixture(targetPath) {
  const document = await PDFDocument.create();
  const page = document.addPage([612, 792]);
  const font = await document.embedFont(StandardFonts.Helvetica);
  page.drawText("Quarterly Results", { x: 50, y: 720, size: 24, font });
  page.drawText("Revenue & margin <plan>", { x: 50, y: 670, size: 12, font });
  page.drawText("1. First [item]", { x: 50, y: 640, size: 12, font });
  page.drawText("2. Visit https://example.com/report", { x: 50, y: 610, size: 12, font });
  page.drawText("Repeated text", { x: 50, y: 580, size: 12, font });
  page.drawText("Repeated text", { x: 50, y: 550, size: 12, font });
  page.drawText("Resume cafe", { x: 50, y: 520, size: 12, font });
  await fs.writeFile(targetPath, await document.save({ useObjectStreams: false }));
}

const GRID_COLUMNS = [72, 220, 360, 480];
const GRID_ROWS = [
  ["Region", "Q1", "Q2", "Q3"],
  ["North", "1200", "1450", "1610"],
  ["South", "980", "1020", "1190"],
  ["West", "1500", "1380", "1720"],
];

async function drawGrid(targetPath, { headerSize, separateHeaderResource }) {
  const document = await PDFDocument.create();
  const page = document.addPage([612, 792]);
  const body = await document.embedFont(StandardFonts.Helvetica);
  // Embedding the same visible font twice yields a different font_name id but
  // no visible distinction. That must not authorize a header.
  const header = separateHeaderResource
    ? await document.embedFont(StandardFonts.Helvetica)
    : body;
  GRID_ROWS.forEach((row, rowIndex) => row.forEach((cell, columnIndex) => {
    page.drawText(cell, {
      x: GRID_COLUMNS[columnIndex],
      y: 660 - rowIndex * 32,
      size: rowIndex === 0 ? headerSize : 11,
      font: rowIndex === 0 ? header : body,
    });
  }));
  await fs.writeFile(targetPath, await document.save({ useObjectStreams: false }));
}

// Header row is materially larger, which is real source-visible evidence.
const makeGridTableFixture = target => drawGrid(target, { headerSize: 16, separateHeaderResource: false });
// Identical size on every row, so no header is evidenced.
const makeUniformGridFixture = target => drawGrid(target, { headerSize: 11, separateHeaderResource: false });
// Identical size, but the header uses a second embed of the same visible font.
const makeDoubleEmbedGridFixture = target => drawGrid(target, { headerSize: 11, separateHeaderResource: true });

async function makeDelimiterTableFixture(targetPath) {
  const document = await PDFDocument.create();
  const page = document.addPage([612, 792]);
  const font = await document.embedFont(StandardFonts.Helvetica);
  const columns = GRID_COLUMNS;
  const rows = [
    ["Symbol", "Meaning", "Note", "Code"],
    ["a|b", "pipe", "alpha", "1"],
    ["c\\d", "backslash", "beta", "2"],
  ];
  rows.forEach((row, rowIndex) => row.forEach((cell, columnIndex) => {
    page.drawText(cell, {
      x: columns[columnIndex],
      y: 660 - rowIndex * 32,
      size: rowIndex === 0 ? 16 : 11,
      font,
    });
  }));
  await fs.writeFile(targetPath, await document.save({ useObjectStreams: false }));
}

async function makeLinkFixture(targetPath, { rotation = 0, url = "https://example.com/report", crop = false } = {}) {
  const document = await PDFDocument.create();
  const page = document.addPage([612, 792]);
  const font = await document.embedFont(StandardFonts.Helvetica);
  if (crop) page.setCropBox(20, 30, 500, 700);
  page.setRotation(degrees(rotation));
  page.drawText("Open", { x: 72, y: 700, size: 12, font });
  page.drawText("report", { x: 104, y: 700, size: 12, font });
  page.drawText("Tail", { x: 72, y: 660, size: 12, font });
  const annotation = document.context.obj({
    Type: PDFName.of("Annot"),
    Subtype: PDFName.of("Link"),
    Rect: document.context.obj([70, 697, 145, 714]),
    Border: document.context.obj([0, 0, 0]),
    A: document.context.obj({
      Type: PDFName.of("Action"),
      S: PDFName.of("URI"),
      URI: PDFString.of(url),
    }),
  });
  page.node.set(PDFName.of("Annots"), document.context.obj([
    document.context.register(annotation),
  ]));
  await fs.writeFile(targetPath, await document.save({ useObjectStreams: false }));
}

function invertAffine([a, b, c, d, e, f]) {
  const determinant = a * d - b * c;
  return [
    d / determinant,
    -b / determinant,
    -c / determinant,
    a / determinant,
    (c * f - d * e) / determinant,
    (b * e - a * f) / determinant,
  ];
}

function applyAffine([a, b, c, d, e, f], x, y) {
  return [a * x + c * y + e, b * x + d * y + f];
}

async function writeRotatedTextPdf(targetPath, { rotation, annotationRect = null }) {
  const document = await PDFDocument.create();
  const page = document.addPage([612, 792]);
  const font = await document.embedFont(StandardFonts.Helvetica);
  page.setCropBox(20, 30, 500, 700);
  page.setRotation(degrees(rotation));
  page.drawText("Open", { x: 72, y: 400, size: 12, font });
  page.drawText("report", { x: 104, y: 400, size: 12, font });
  page.drawText("Tail", { x: 72, y: 360, size: 12, font });
  if (annotationRect !== null) {
    const annotation = document.context.obj({
      Type: PDFName.of("Annot"),
      Subtype: PDFName.of("Link"),
      Rect: document.context.obj(annotationRect),
      Border: document.context.obj([0, 0, 0]),
      A: document.context.obj({
        Type: PDFName.of("Action"),
        S: PDFName.of("URI"),
        URI: PDFString.of("https://example.com/rotated"),
      }),
    });
    page.node.set(PDFName.of("Annots"), document.context.obj([
      document.context.register(annotation),
    ]));
  }
  await fs.writeFile(targetPath, await document.save({ useObjectStreams: false }));
}

async function makeProseFixture(targetPath) {
  const document = await PDFDocument.create();
  const page = document.addPage([612, 792]);
  const font = await document.embedFont(StandardFonts.Helvetica);
  // Ordinary left-aligned prose, drawn word by word so every line yields many
  // text items at irregular x positions.
  const paragraph = [
    "The quarterly review covers every operating region",
    "and summarises the revenue recorded during the period",
    "alongside commentary from each regional director",
  ];
  paragraph.forEach((line, lineIndex) => {
    let x = 72;
    for (const word of line.split(" ")) {
      page.drawText(word, { x, y: 660 - lineIndex * 28, size: 11, font });
      x += font.widthOfTextAtSize(`${word} `, 11);
    }
  });
  await fs.writeFile(targetPath, await document.save({ useObjectStreams: false }));
}

async function makeDenseFixture(targetPath) {
  const document = await PDFDocument.create();
  const page = document.addPage([612, 792]);
  const font = await document.embedFont(StandardFonts.Helvetica);
  for (let index = 0; index < 450; index += 1) {
    page.drawText(`Dense item ${String(index).padStart(4, "0")}`, {
      x: 40,
      y: 760 - index * 1.5,
      size: 10,
      font,
    });
  }
  await fs.writeFile(targetPath, await document.save({ useObjectStreams: false }));
}

async function makeGeometryFixture(targetPath) {
  const document = await PDFDocument.create();
  const font = await document.embedFont(StandardFonts.Helvetica);
  for (const rotation of [0, 90, 180, 270]) {
    const page = document.addPage([420, 520]);
    page.setCropBox(20, 30, 360, 440);
    page.setRotation(degrees(rotation));
    page.node.set(PDFName.of("UserUnit"), PDFNumber.of(1.5));
    page.drawText(`Rotation ${rotation}`, { x: 60, y: 100, size: 12, font });
  }
  await fs.writeFile(targetPath, await document.save({ useObjectStreams: false }));
}

async function expectedOutputIdentity(filePath) {
  const [canonicalPath, bytes, stats] = await Promise.all([
    fs.realpath(filePath),
    fs.readFile(filePath),
    fs.stat(filePath),
  ]);
  return {
    canonical_path: canonicalPath,
    size_bytes: stats.size,
    sha256: createHash("sha256").update(bytes).digest("hex"),
  };
}

describe("convert_pdf_to_markdown MCP tool", () => {
  let client;
  let transport;
  let temporaryRoot;
  let structureFixture;
  let denseFixture;
  let geometryFixture;
  let gridTableFixture;
  let uniformGridFixture;
  let delimiterTableFixture;
  let proseFixture;
  let doubleEmbedFixture;
  let linkFixture;
  let rotatedLinkFixture;
  let hostileLinkFixture;

  beforeAll(async () => {
    temporaryRoot = await fs.mkdtemp(path.join(os.tmpdir(), "pdf-tools-markdown-"));
    structureFixture = path.join(temporaryRoot, "structure.pdf");
    denseFixture = path.join(temporaryRoot, "dense.pdf");
    geometryFixture = path.join(temporaryRoot, "geometry.pdf");
    gridTableFixture = path.join(temporaryRoot, "grid-table.pdf");
    uniformGridFixture = path.join(temporaryRoot, "uniform-grid.pdf");
    delimiterTableFixture = path.join(temporaryRoot, "delimiter-table.pdf");
    proseFixture = path.join(temporaryRoot, "prose.pdf");
    doubleEmbedFixture = path.join(temporaryRoot, "double-embed-grid.pdf");
    linkFixture = path.join(temporaryRoot, "link.pdf");
    rotatedLinkFixture = path.join(temporaryRoot, "link-rotated.pdf");
    hostileLinkFixture = path.join(temporaryRoot, "link-hostile.pdf");
    await makeStructureFixture(structureFixture);
    await makeDenseFixture(denseFixture);
    await makeGeometryFixture(geometryFixture);
    await makeGridTableFixture(gridTableFixture);
    await makeUniformGridFixture(uniformGridFixture);
    await makeDelimiterTableFixture(delimiterTableFixture);
    await makeProseFixture(proseFixture);
    await makeDoubleEmbedGridFixture(doubleEmbedFixture);
    await makeLinkFixture(linkFixture);
    await makeLinkFixture(rotatedLinkFixture, { rotation: 90, crop: true });
    await makeLinkFixture(hostileLinkFixture, { url: "https://example.com/a(b)c" });
    transport = new StdioClientTransport({
      command: process.execPath,
      args: [path.join(REPO_ROOT, "server/index.js")],
      cwd: REPO_ROOT,
      env: { ALLOWED_DIRECTORIES: [REPO_ROOT, temporaryRoot].join(path.delimiter) },
      stderr: "ignore",
    });
    client = new Client({ name: "pdf-markdown-test", version: "1.0.0" });
    await client.connect(transport);
  }, 30_000);

  afterAll(async () => {
    await client?.close();
    await transport?.close();
    if (temporaryRoot) await fs.rm(temporaryRoot, { recursive: true, force: true });
  });

  it("discovers the exact local, write-capable, closed-world contract", async () => {
    const { tools } = await client.listTools();
    expect(tools.find(tool => tool.name === "convert_pdf_to_markdown")).toMatchObject({
      inputSchema: {
        type: "object",
        additionalProperties: false,
        required: ["pdf_path"],
      },
      annotations: {
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: true,
        openWorldHint: false,
      },
      outputSchema: TOOL_OUTPUT_SCHEMAS.convert_pdf_to_markdown,
    });
  });

  it("renders deterministic heading, list, repeated text, escaped syntax, and plain URL evidence", async () => {
    const request = {
      name: "convert_pdf_to_markdown",
      arguments: { pdf_path: structureFixture, max_markdown_bytes: 100000 },
    };
    const first = await client.callTool(request);
    const second = await client.callTool(request);
    expect(first.isError).not.toBe(true);
    expect(second.structuredContent).toEqual(first.structuredContent);
    expect(first.structuredContent).toMatchObject({
      renderer: { name: "pdf-tools.layout-markdown-renderer", version: "1.21.0" },
      conversion_status: "complete",
      saved_output: null,
      provenance: {
        layout: { name: "pdf-tools.extraction-ir", version: "1.6.0", parser_version: "5.4.624" },
      },
      pages_needing_vision: [],
    });
    const { markdown } = first.structuredContent;
    expect(markdown).toContain("<!-- PDF page 1 -->");
    expect(markdown).toMatch(/^<!-- PDF page 1 -->[\s\S]*# Quarterly Results/m);
    expect(markdown).toContain("Revenue &amp; margin &lt;plan&gt;");
    expect(markdown).toContain("1. First \\[item\\]");
    expect(markdown).toContain("https&#58;//example&#46;com/report");
    expect(markdown).not.toContain("<https://example.com/report>");
    expect(markdown.match(/Repeated text/g)).toHaveLength(2);
    expect(first.structuredContent.markdown_bytes).toBe(Buffer.byteLength(markdown, "utf8"));
    expect(first.structuredContent.markdown_sha256).toBe(
      createHash("sha256").update(markdown).digest("hex"),
    );
  }, 30_000);

  it("reconstructs an unambiguous column grid as a Markdown table without a topology gap", async () => {
    const result = await client.callTool({
      name: "convert_pdf_to_markdown",
      arguments: { pdf_path: gridTableFixture, max_markdown_bytes: 100000 },
    });
    expect(result.isError).not.toBe(true);
    const { markdown } = result.structuredContent;
    expect(markdown).toMatch(/^\| Region \| Q1 \| Q2 \| Q3 \|$/m);
    expect(markdown).toMatch(/^\| --- \| --- \| --- \| --- \|$/m);
    expect(markdown).toMatch(/^\| North \| 1200 \| 1450 \| 1610 \|$/m);
    expect(markdown).toMatch(/^\| West \| 1500 \| 1380 \| 1720 \|$/m);
    // Every row filled every detected column, so this is a reconstruction, not
    // a degraded flatten: no topology gap may be reported.
    expect(result.structuredContent.gaps.map(gap => gap.code))
      .not.toContain("TABLE_TOPOLOGY_UNKNOWN");
    expect(result.structuredContent.conversion_status).toBe("complete");
  }, 30_000);

  it("round-trips a reconstructed table back through the bakeoff projection", async () => {
    const result = await client.callTool({
      name: "convert_pdf_to_markdown",
      arguments: { pdf_path: gridTableFixture, max_markdown_bytes: 100000 },
    });
    expect(result.isError).not.toBe(true);
    // The renderer's own output must be projectable by the scorer, otherwise
    // the bakeoff scores a real reconstruction as a miss.
    const candidate = projectMarkdownTable(result.structuredContent.markdown, 1);
    expect(candidate).not.toBeNull();
    expect(candidate.row_count).toBe(4);
    expect(candidate.column_count).toBe(4);
    const expected = {
      page: 1,
      row_count: 4,
      column_count: 4,
      merged_cells: [],
      cells: GRID_ROWS.flatMap((row, rowIndex) => row.map((value, columnIndex) => ({
        row: rowIndex + 1,
        column: columnIndex + 1,
        value,
      }))),
    };
    const score = scoreTable(expected, candidate);
    expect(score.present).toBe(true);
    expect(score.dimensions_exact).toBe(true);
    expect(score.cells_exact).toBe(true);
    expect(score.topology_exact).toBe(true);
    expect(score.exact_cells).toBe(16);
  }, 30_000);

  it("does not invent a header for a uniform grid and reports it as a typed gap", async () => {
    const result = await client.callTool({
      name: "convert_pdf_to_markdown",
      arguments: { pdf_path: uniformGridFixture, max_markdown_bytes: 100000 },
    });
    expect(result.isError).not.toBe(true);
    expect(result.structuredContent.markdown).not.toMatch(/^\|.*\|$/m);
    expect(result.structuredContent.gaps.map(gap => gap.code))
      .toContain("TABLE_TOPOLOGY_UNKNOWN");
    expect(result.structuredContent.gaps.map(gap => gap.message).join("\n"))
      .toMatch(/no source evidence distinguishes a header row/);
    expect(result.structuredContent.conversion_status).toBe("partial");
  }, 30_000);

  it("treats a differing font resource id alone as no header evidence", async () => {
    // Same visible font, embedded twice, so header and body carry different
    // font_name ids with no visible distinction. That must not promote a
    // header row.
    const result = await client.callTool({
      name: "convert_pdf_to_markdown",
      arguments: { pdf_path: doubleEmbedFixture, max_markdown_bytes: 100000 },
    });
    expect(result.isError).not.toBe(true);
    expect(result.structuredContent.markdown).not.toMatch(/^\|.*\|$/m);
    expect(result.structuredContent.gaps.map(gap => gap.code))
      .toContain("TABLE_TOPOLOGY_UNKNOWN");
    expect(result.structuredContent.conversion_status).toBe("partial");
  }, 30_000);

  it("escapes a table cell delimiter exactly once", async () => {
    const result = await client.callTool({
      name: "convert_pdf_to_markdown",
      arguments: { pdf_path: delimiterTableFixture, max_markdown_bytes: 100000 },
    });
    expect(result.isError).not.toBe(true);
    const { markdown } = result.structuredContent;
    const row = markdown.split("\n").find(line => line.includes("pipe"));
    expect(row).toBeDefined();
    // Exactly one backslash before the literal pipe: "\|" and never "\\|",
    // which would be an escaped backslash plus a live cell delimiter.
    expect(row).toContain("a\\|b");
    expect(row).not.toContain("a\\\\|b");
    // Splitting on unescaped delimiters must yield exactly the declared column
    // count, proving the escaped pipe was not treated as a delimiter.
    expect(row.split(/(?<!\\)\|/u).length - 2).toBe(4);
    const backslashRow = markdown.split("\n").find(line => line.includes("backslash"));
    expect(backslashRow).toContain("c\\\\d");
  }, 30_000);

  it("does not report ordinary aligned prose as table-like", async () => {
    const result = await client.callTool({
      name: "convert_pdf_to_markdown",
      arguments: { pdf_path: proseFixture, max_markdown_bytes: 100000 },
    });
    expect(result.isError).not.toBe(true);
    expect(result.structuredContent.markdown).not.toMatch(/^\|.*\|$/m);
    expect(result.structuredContent.gaps.map(gap => gap.code))
      .not.toContain("TABLE_TOPOLOGY_UNKNOWN");
  }, 30_000);

  it("emits a source-validated link end to end", async () => {
    const result = await client.callTool({
      name: "convert_pdf_to_markdown",
      arguments: { pdf_path: linkFixture, max_markdown_bytes: 100000 },
    });
    expect(result.isError).not.toBe(true);
    expect(result.structuredContent.markdown).toContain("[Open report](https://example.com/report)");
    expect(result.structuredContent.markdown).toContain("Tail");
  }, 30_000);

  it("maps link geometry through rotation and CropBox", async () => {
    const result = await client.callTool({
      name: "convert_pdf_to_markdown",
      arguments: { pdf_path: rotatedLinkFixture, max_markdown_bytes: 100000 },
    });
    expect(result.isError).not.toBe(true);
    const { markdown, gaps } = result.structuredContent;
    // Either the rect still resolves under the rotated CropBox viewport, or it
    // fails closed with a typed gap. It must never emit a wrong label.
    const emitted = markdown.includes("](https://example.com/report)");
    if (emitted) expect(markdown).toContain("[Open report](https://example.com/report)");
    else expect(gaps.map(gap => gap.code)).toContain("LINK_MAPPING_AMBIGUOUS");
  }, 30_000);

  it("percent-encodes a hostile destination end to end", async () => {
    const result = await client.callTool({
      name: "convert_pdf_to_markdown",
      arguments: { pdf_path: hostileLinkFixture, max_markdown_bytes: 100000 },
    });
    expect(result.isError).not.toBe(true);
    const { markdown } = result.structuredContent;
    if (markdown.includes("](")) {
      expect(markdown).toContain("%28b%29");
      expect(markdown).not.toContain("(https://example.com/a(b)c)");
    }
  }, 30_000);

  it("emits exactly once for a rotated, cropped page when the rect is source-space correct", async () => {
    for (const rotation of [90, 180]) {
      const probePath = path.join(temporaryRoot, `rot-${rotation}-probe.pdf`);
      await writeRotatedTextPdf(probePath, { rotation });
      const layout = await client.callTool({
        name: "read_pdf_layout",
        arguments: { pdf_path: probePath },
      });
      expect(layout.isError, `rotation ${rotation}`).not.toBe(true);
      const page = layout.structuredContent.pages[0];
      const wanted = page.raw_items.filter(item => item.text === "report");
      expect(wanted.length, `rotation ${rotation}`).toBe(1);
      // The item box in display space, mapped back to user space through the
      // inverse viewport transform, so the rect is genuinely the source-space
      // region covering exactly that label under rotation and CropBox.
      const minX = Math.min(...wanted.map(item => item.bbox.x)) - 1;
      const minY = Math.min(...wanted.map(item => item.bbox.y)) - 1;
      const maxX = Math.max(...wanted.map(item => item.bbox.x + item.bbox.width)) + 1;
      const maxY = Math.max(...wanted.map(item => item.bbox.y + item.bbox.height)) + 1;
      const inverse = invertAffine(page.geometry.viewport_transform);
      const corners = [[minX, minY], [maxX, minY], [maxX, maxY], [minX, maxY]]
        .map(([x, y]) => applyAffine(inverse, x, y));
      const rect = [
        Math.min(...corners.map(corner => corner[0])),
        Math.min(...corners.map(corner => corner[1])),
        Math.max(...corners.map(corner => corner[0])),
        Math.max(...corners.map(corner => corner[1])),
      ];
      const linkedPath = path.join(temporaryRoot, `rot-${rotation}-linked.pdf`);
      await writeRotatedTextPdf(linkedPath, { rotation, annotationRect: rect });
      const result = await client.callTool({
        name: "convert_pdf_to_markdown",
        arguments: { pdf_path: linkedPath, max_markdown_bytes: 100000 },
      });
      expect(result.isError, `rotation ${rotation}`).not.toBe(true);
      const { markdown, gaps } = result.structuredContent;
      expect(markdown, `rotation ${rotation}`).toContain("[report](https://example.com/rotated)");
      expect(markdown.match(/\]\(https:\/\/example\.com\/rotated\)/gu).length, `rotation ${rotation}`).toBe(1);
      expect(gaps.map(gap => gap.code), `rotation ${rotation}`).not.toContain("LINK_MAPPING_AMBIGUOUS");
      expect(markdown, `rotation ${rotation}`).toContain("Tail");
    }
  }, 60_000);

  it("fails closed for a rotated page whose rect lands out of bounds", async () => {
    const outOfBounds = path.join(temporaryRoot, "rot-out-of-bounds.pdf");
    await writeRotatedTextPdf(outOfBounds, { rotation: 90, annotationRect: [4000, 4000, 4100, 4100] });
    const result = await client.callTool({
      name: "convert_pdf_to_markdown",
      arguments: { pdf_path: outOfBounds, max_markdown_bytes: 100000 },
    });
    expect(result.isError).not.toBe(true);
    expect(result.structuredContent.markdown).not.toContain("](https://example.com/rotated)");
    expect(result.structuredContent.gaps.map(gap => gap.code)).toContain("LINK_MAPPING_AMBIGUOUS");
  }, 30_000);

  it("routes an image page with sub-threshold text to vision, matching get_page_analysis semantics", async () => {
    const pdfPath = path.join(temporaryRoot, "image-short-text.pdf");
    const document = await PDFDocument.create();
    const page = document.addPage([612, 792]);
    const font = await document.embedFont(StandardFonts.Helvetica);
    const raster = await document.embedPng(await fs.readFile(
      path.join(REPO_ROOT, "test/fixtures/eval/extraction/source-images/raster-clean.png"),
    ));
    page.drawImage(raster, { x: 72, y: 200, width: 400, height: 400 });
    page.drawText("Caption under the scan", { x: 72, y: 160, size: 12, font });
    await fs.writeFile(pdfPath, await document.save({ useObjectStreams: false }));
    const result = await client.callTool({
      name: "convert_pdf_to_markdown",
      arguments: { pdf_path: pdfPath, max_markdown_bytes: 100000 },
    });
    expect(result.isError).not.toBe(true);
    // 22 trimmed chars < MIN_TEXT_CHARS_WITH_IMAGES (100): the thin caption
    // must not suppress vision routing merely because a text layer exists.
    expect(result.structuredContent.pages_needing_vision).toEqual([
      { page: 1, reasons: ["image_dominated"] },
    ]);
  });

  it("reports mixed, raster-only, and table-like visual structure without OCR or topology claims", async () => {
    const cases = [
      [MIXED, { end_page: 2 }, ["OCR_NOT_PERFORMED", "IMAGE_CONTENT_NOT_RENDERED"]],
      [RASTER, {}, ["TEXT_LAYER_EMPTY", "OCR_NOT_PERFORMED", "IMAGE_CONTENT_NOT_RENDERED"]],
    ];
    for (const [pdfPath, range, expectedCodes] of cases) {
      const result = await client.callTool({
        name: "convert_pdf_to_markdown",
        arguments: { pdf_path: pdfPath, max_markdown_bytes: 100000, ...range },
      });
      expect(result.isError, pdfPath).not.toBe(true);
      expect(result.structuredContent.conversion_status, pdfPath).toBe("partial");
      const codes = result.structuredContent.gaps.map(gap => gap.code);
      expect(codes, pdfPath).toEqual(expect.arrayContaining(expectedCodes));
      expect(result.structuredContent.pages_needing_vision, pdfPath).toEqual(
        range.end_page === 2
          ? [{ page: 2, reasons: ["no_text_layer", "image_dominated"] }]
          : [{ page: 1, reasons: ["no_text_layer", "image_dominated"] }],
      );
      expect(result.content?.[0]?.text ?? "").toContain("render_pdf_page");
      expect(result.structuredContent.limitations.join("\n")).toMatch(/OCR is not performed/);
      expect(result.structuredContent.limitations.join("\n")).toMatch(/Cell artwork is omitted and reported as a vector-content gap/);
      expect(result.structuredContent.limitations.join("\n")).toMatch(/merged or spanning topology are rejected/);
    }

    const table = await client.callTool({
      name: "convert_pdf_to_markdown",
      arguments: { pdf_path: TABLE, max_markdown_bytes: 100000 },
    });
    expect(table.isError).not.toBe(true);
    expect(table.structuredContent.limitations.join("\n")).toMatch(/Cell artwork is omitted and reported as a vector-content gap/);
    expect(table.structuredContent.limitations.join("\n")).toMatch(/merged or spanning topology are rejected/);
    // This fixture has a merged/blank cell, so no row fills every detected
    // column. It must degrade to reading-order text and report typed partial
    // coverage rather than inventing a topology.
    expect(table.structuredContent.markdown).not.toMatch(/^\|.*\|$/m);
    expect(table.structuredContent.gaps.map(gap => gap.code))
      .toContain("TABLE_TOPOLOGY_UNKNOWN");
    expect(table.structuredContent.conversion_status).toBe("partial");
    const orderedFragments = [
      "Q3 PURCHASES",
      "Item",
      "Qty",
      "Amount",
      "Paper",
      "2",
      "USD 20.00",
      "Delivery",
      "USD 5.00",
    ];
    let cursor = 0;
    for (const fragment of orderedFragments) {
      const index = table.structuredContent.markdown.indexOf(fragment, cursor);
      expect(index, fragment).toBeGreaterThanOrEqual(cursor);
      cursor = index + fragment.length;
    }
  }, 30_000);

  it("keeps rotated and cropped geometry bounded and deterministic", async () => {
    const request = {
      name: "convert_pdf_to_markdown",
      arguments: { pdf_path: ROTATED_CROP, max_markdown_bytes: 100000 },
    };
    const first = await client.callTool(request);
    const second = await client.callTool(request);
    expect(first.isError).not.toBe(true);
    expect(second.structuredContent).toEqual(first.structuredContent);
    expect(first.structuredContent.provenance.layout.page_range).toMatchObject({
      start_page: 1,
      end_page: 1,
      total_pages: 1,
    });
  }, 30_000);

  it("preserves text across rotated, offset-CropBox, non-unit-UserUnit pages", async () => {
    const result = await client.callTool({
      name: "convert_pdf_to_markdown",
      arguments: {
        pdf_path: geometryFixture,
        start_page: 1,
        end_page: 4,
        max_markdown_bytes: 100000,
      },
    });
    expect(result.isError).not.toBe(true);
    expect(result.structuredContent.provenance.layout.page_range).toMatchObject({
      start_page: 1,
      end_page: 4,
      total_pages: 4,
    });
    for (const rotation of [0, 90, 180, 270]) {
      expect(result.structuredContent.markdown).toContain(`Rotation ${rotation}`);
    }
  }, 30_000);

  it("preserves provenance-bound vertical Unicode text without byte drift", async () => {
    const result = await client.callTool({
      name: "convert_pdf_to_markdown",
      arguments: { pdf_path: VERTICAL_UNICODE, max_markdown_bytes: 100000 },
    });
    expect(result.isError).not.toBe(true);
    expect(result.structuredContent.markdown).toContain("日本語");
    expect(result.structuredContent.markdown_bytes).toBe(
      Buffer.byteLength(result.structuredContent.markdown, "utf8"),
    );
  }, 30_000);

  it("returns exact password errors and converts authenticated encrypted bytes", async () => {
    const missing = await client.callTool({
      name: "convert_pdf_to_markdown",
      arguments: { pdf_path: ENCRYPTED },
    });
    expect(missing.isError).toBe(true);
    expect(missing.structuredContent).toEqual({
      status: "failed",
      error: { error_schema_version: 1, code: "PASSWORD_REQUIRED" },
    });

    const wrong = await client.callTool({
      name: "convert_pdf_to_markdown",
      arguments: { pdf_path: ENCRYPTED, password: "definitely-wrong-layout-password" },
    });
    expect(wrong.isError).toBe(true);
    expect(wrong.structuredContent).toEqual({
      status: "failed",
      error: { error_schema_version: 1, code: "PASSWORD_INCORRECT" },
    });

    const correct = await client.callTool({
      name: "convert_pdf_to_markdown",
      arguments: { pdf_path: ENCRYPTED, password: "oda-layout-user-2026" },
    });
    expect(correct.isError).not.toBe(true);
    expect(correct.structuredContent.provenance.source.sha256).toBe(
      createHash("sha256").update(await fs.readFile(ENCRYPTED)).digest("hex"),
    );
  }, 30_000);

  it("renders source-validated retained evidence before the public layout response projection", async () => {
    const publicLayout = await client.callTool({
      name: "read_pdf_layout",
      arguments: {
        pdf_path: denseFixture,
        max_items: 5000,
        max_characters: 100000,
        max_output_characters: 200000,
      },
    });
    expect(publicLayout.isError).not.toBe(true);
    expect(publicLayout.structuredContent.truncation.reasons).toContain("max_output_characters");
    expect(publicLayout.structuredContent.pages[0].lines).toEqual([]);

    const markdown = await client.callTool({
      name: "convert_pdf_to_markdown",
      arguments: {
        pdf_path: denseFixture,
        max_items: 5000,
        max_characters: 100000,
        max_markdown_bytes: 200000,
      },
    });
    expect(markdown.isError).not.toBe(true);
    expect(markdown.structuredContent.gaps.map(gap => gap.code)).not.toContain("PAGE_RANGE_INCOMPLETE");
    expect(markdown.structuredContent.markdown).toContain("Dense item 0000");
    expect(markdown.structuredContent.markdown).toContain("Dense item 0449");
  }, 30_000);

  it("transactionally saves exact UTF-8 bytes, preserves the source, and requires explicit overwrite", async () => {
    const outputPath = path.join(temporaryRoot, "structure.md");
    const sourceBefore = await fs.readFile(structureFixture);
    const first = await client.callTool({
      name: "convert_pdf_to_markdown",
      arguments: { pdf_path: structureFixture, output_path: outputPath },
    });
    expect(first.isError).not.toBe(true);
    const saved = await fs.readFile(outputPath);
    const canonicalOutputPath = await fs.realpath(outputPath);
    expect(saved.toString("utf8")).toBe(first.structuredContent.markdown);
    expect(first.structuredContent.saved_output).toEqual({
      path: canonicalOutputPath,
      encoding: "utf-8",
      bytes: saved.length,
      sha256: createHash("sha256").update(saved).digest("hex"),
      commit_method: "same_directory_atomic",
      reopened_verified: true,
      overwritten: false,
    });
    expect(await fs.readFile(structureFixture)).toEqual(sourceBefore);

    const refused = await client.callTool({
      name: "convert_pdf_to_markdown",
      arguments: { pdf_path: structureFixture, output_path: outputPath },
    });
    expect(refused.isError).toBe(true);
    expect(await fs.readFile(outputPath)).toEqual(saved);
    expect(await fs.readFile(structureFixture)).toEqual(sourceBefore);

    const replaced = await client.callTool({
      name: "convert_pdf_to_markdown",
      arguments: {
        pdf_path: structureFixture,
        output_path: outputPath,
        overwrite: true,
        expected_output_identity: await expectedOutputIdentity(outputPath),
      },
    });
    expect(replaced.isError).not.toBe(true);
    expect(replaced.structuredContent.saved_output.overwritten).toBe(true);
    expect(await fs.readFile(structureFixture)).toEqual(sourceBefore);
  }, 30_000);

  it.runIf(process.platform !== "win32")("refuses symlink and hardlink output aliases without changing source bytes", async () => {
    const symlinkTarget = path.join(temporaryRoot, "aliased-source.md");
    const symlinkSource = path.join(temporaryRoot, "aliased-source.pdf");
    const originalBytes = await fs.readFile(structureFixture);
    await fs.writeFile(symlinkTarget, originalBytes);
    await fs.symlink(symlinkTarget, symlinkSource);

    const symlinkResult = await client.callTool({
      name: "convert_pdf_to_markdown",
      arguments: {
        pdf_path: symlinkSource,
        output_path: symlinkTarget,
        overwrite: true,
        expected_output_identity: await expectedOutputIdentity(symlinkTarget),
      },
    });
    expect(symlinkResult.isError).toBe(true);
    expect(symlinkResult.content[0].text).toContain("output_path resolves to the same file as the source PDF");
    expect(await fs.readFile(symlinkTarget)).toEqual(originalBytes);
    expect(await fs.readlink(symlinkSource)).toBe(symlinkTarget);

    const hardlinkSource = path.join(temporaryRoot, "hardlink-source.pdf");
    const hardlinkOutput = path.join(temporaryRoot, "hardlink-output.md");
    await fs.writeFile(hardlinkSource, originalBytes);
    await fs.link(hardlinkSource, hardlinkOutput);

    const hardlinkResult = await client.callTool({
      name: "convert_pdf_to_markdown",
      arguments: {
        pdf_path: hardlinkSource,
        output_path: hardlinkOutput,
        overwrite: true,
        expected_output_identity: await expectedOutputIdentity(hardlinkOutput),
      },
    });
    expect(hardlinkResult.isError).toBe(true);
    expect(hardlinkResult.content[0].text).toContain("output_path resolves to the same file as the source PDF");
    expect(await fs.readFile(hardlinkSource)).toEqual(originalBytes);
    expect(await fs.readFile(hardlinkOutput)).toEqual(originalBytes);
  }, 30_000);

  it.runIf(process.platform !== "win32")("binds the canonical output parent and does not follow a late outside retarget", async () => {
    const inside = path.join(temporaryRoot, "inside-output-parent");
    const routedParent = path.join(temporaryRoot, "routed-output-parent");
    const outside = await fs.mkdtemp(path.join(os.tmpdir(), "pdf-tools-outside-output-"));
    const outputPath = path.join(routedParent, "late-retarget.md");
    await fs.mkdir(inside);
    await fs.symlink(inside, routedParent);

    try {
      const pending = client.callTool({
        name: "convert_pdf_to_markdown",
        arguments: {
          pdf_path: denseFixture,
          output_path: outputPath,
          max_items: 5000,
          max_characters: 100000,
          max_markdown_bytes: 200000,
        },
      });
      await new Promise(resolve => setTimeout(resolve, 25));
      await fs.unlink(routedParent);
      await fs.symlink(outside, routedParent);

      const result = await pending;
      expect(result.isError).not.toBe(true);
      expect(result.structuredContent.saved_output.path).toBe(
        path.join(await fs.realpath(inside), "late-retarget.md"),
      );
      await expect(fs.readFile(path.join(inside, "late-retarget.md"), "utf8")).resolves.toBe(
        result.structuredContent.markdown,
      );
      await expect(fs.access(path.join(outside, "late-retarget.md"))).rejects.toMatchObject({ code: "ENOENT" });
    } finally {
      await fs.rm(routedParent, { force: true });
      await fs.rm(outside, { recursive: true, force: true });
    }
  }, 30_000);

  it.runIf(process.platform !== "win32")("refuses a bound output parent replaced by an outside symlink before commit", async () => {
    const parent = path.join(temporaryRoot, "bound-output-parent");
    const movedParent = path.join(temporaryRoot, "bound-output-parent-moved");
    const outside = await fs.mkdtemp(path.join(os.tmpdir(), "pdf-tools-outside-bound-output-"));
    const outputPath = path.join(parent, "late-parent-swap.md");
    await fs.mkdir(parent);

    try {
      const pending = client.callTool({
        name: "convert_pdf_to_markdown",
        arguments: {
          pdf_path: denseFixture,
          output_path: outputPath,
          max_items: 5000,
          max_characters: 100000,
          max_markdown_bytes: 200000,
        },
      });
      await new Promise(resolve => setTimeout(resolve, 25));
      await fs.rename(parent, movedParent);
      await fs.symlink(outside, parent);

      const result = await pending;
      expect(result.isError).toBe(true);
      await expect(fs.access(path.join(movedParent, "late-parent-swap.md"))).rejects.toMatchObject({ code: "ENOENT" });
      await expect(fs.access(path.join(outside, "late-parent-swap.md"))).rejects.toMatchObject({ code: "ENOENT" });
    } finally {
      await fs.rm(parent, { force: true });
      await fs.rm(movedParent, { recursive: true, force: true });
      await fs.rm(outside, { recursive: true, force: true });
    }
  }, 30_000);

  it("fails closed on byte limits and invalid output paths without creating files", async () => {
    const tooSmall = await client.callTool({
      name: "convert_pdf_to_markdown",
      arguments: { pdf_path: structureFixture, max_markdown_bytes: 256 },
    });
    expect(tooSmall.isError).toBe(true);
    expect(tooSmall.structuredContent).toMatchObject({
      status: "failed",
      error: { error_schema_version: 1, code: "tool_execution_failed" },
    });

    const wrongExtension = path.join(temporaryRoot, "not-markdown.txt");
    const invalid = await client.callTool({
      name: "convert_pdf_to_markdown",
      arguments: { pdf_path: structureFixture, output_path: wrongExtension },
    });
    expect(invalid.isError).toBe(true);
    await expect(fs.access(wrongExtension)).rejects.toMatchObject({ code: "ENOENT" });

    const protectedTarget = path.join(temporaryRoot, "protected-target.txt");
    const symlinkOutput = path.join(temporaryRoot, "linked.md");
    await fs.writeFile(protectedTarget, "keep me");
    await fs.symlink(protectedTarget, symlinkOutput);
    const symlinkResult = await client.callTool({
      name: "convert_pdf_to_markdown",
      arguments: { pdf_path: structureFixture, output_path: symlinkOutput },
    });
    expect(symlinkResult.isError).toBe(true);
    await expect(fs.readFile(protectedTarget, "utf8")).resolves.toBe("keep me");

    const directoryOutput = path.join(temporaryRoot, "directory.md");
    await fs.mkdir(directoryOutput);
    const directoryResult = await client.callTool({
      name: "convert_pdf_to_markdown",
      arguments: { pdf_path: structureFixture, output_path: directoryOutput },
    });
    expect(directoryResult.isError).toBe(true);

    const reservedOutput = path.join(temporaryRoot, ".pdf-tools-user.md");
    const reservedResult = await client.callTool({
      name: "convert_pdf_to_markdown",
      arguments: { pdf_path: structureFixture, output_path: reservedOutput },
    });
    expect(reservedResult.isError).toBe(true);
    await expect(fs.access(reservedOutput)).rejects.toMatchObject({ code: "ENOENT" });

    const missingParentOutput = path.join(temporaryRoot, "missing", "output.md");
    const missingParent = await client.callTool({
      name: "convert_pdf_to_markdown",
      arguments: { pdf_path: structureFixture, output_path: missingParentOutput },
    });
    expect(missingParent.isError).toBe(true);
    await expect(fs.access(missingParentOutput)).rejects.toMatchObject({ code: "ENOENT" });
  }, 30_000);
});
