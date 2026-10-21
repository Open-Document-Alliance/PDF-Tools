import { createHash } from "node:crypto";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { PDFDocument, StandardFonts } from "pdf-lib";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildTableProposalRegion } from "../server/markdown-conversion.js";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const sourceSha256 = "a".repeat(64);
function fixture() {
  const entries = [
    ["Table 1. Synthetic measurements", 50, 88, 160, "caption"],
    ["Concentration", 60, 114, 55, "top-1"],
    ["level", 70, 126, 20, "top-2"],
    ["A", 145, 120, 10, "top-3"], ["B", 225, 120, 10, "top-3"],
    ...["Control", "Low", "High"].flatMap((text, index) => [
      [text, 60, 148 + index * 15, 40, `body-${index}`],
      [String(index), 140, 148 + index * 15, 8, `body-${index}`],
      [String(index + 1), 220, 148 + index * 15, 8, `body-${index}`],
    ]),
  ];
  const raw_items = entries.map(([text, x, y, width, line_id], index) => ({
    id: `item-${index}`, text, bbox: { x, y, width, height: 8 }, line_id,
    reading_order_index: index, geometry_valid: true, text_kind: "non_whitespace",
  }));
  const lines = [...new Set(entries.map(row => row[4]))].map(id => {
    const items = raw_items.filter(item => item.line_id === id);
    const x = Math.min(...items.map(item => item.bbox.x));
    const y = Math.min(...items.map(item => item.bbox.y));
    return { id, x, y, width: Math.max(...items.map(item => item.bbox.x + item.bbox.width)) - x,
      height: 8, text: items.map(item => item.text).join(" "), item_ids: items.map(item => item.id) };
  });
  const bars = [110, 140, 195].flatMap(y => [
    { x: 50, y, width: 120, height: 1, verb: "fill" },
    { x: 170, y, width: 100, height: 1, verb: "fill" },
  ]);
  return { page: { page: 1, raw_items, lines, truncation: { truncated: false },
    ruled_rects: { status: "available", observed_count: 6, returned_count: 6, items: bars },
    ruling_segments: { status: "available", truncated: false, observed_count: 0, returned_count: 0, items: [] },
    painted_rectangles: { status: "available", truncated: false, observed_count: 0, returned_count: 0, items: [] } },
  run: lines.slice(3).map(line => ({ line, cells: raw_items.filter(item => item.line_id === line.id) })) };
}
function packet(input, sha = sourceSha256) {
  return buildTableProposalRegion(input.page, input.run, "topology", 1, { sourceSha256: sha });
}

describe("three-rule table arrangement for review", () => {
  it("produces one deterministic complete draft with multiline labels and no header claim", () => {
    const input = fixture();
    const before = structuredClone(input);
    const result = packet(input);
    const candidate = result.review_candidate;
    expect(candidate).toMatchObject({ status: "needs_review", topology_verified: false,
      header_roles_verified: false, row_count: 4, column_count: 3,
      source_item_count: 13, assigned_item_count: 13, unassigned_item_count: 0, source_sha256: sourceSha256 });
    expect(candidate.cells[0].lines.map(line => line.text)).toEqual(["Concentration", "level"]);
    expect(candidate.html).toContain("<td>Concentration<br>level</td>");
    expect(candidate.html).not.toContain("<th");
    expect(candidate.cells.flatMap(cell => cell.item_ids).sort())
      .toEqual(result.text_items.map(item => item.id).sort());
    expect(packet(input)).toEqual(result);
    expect(input).toEqual(before);
    expect(packet(input, "b".repeat(64)).review_candidate.candidate_sha256).not.toBe(candidate.candidate_sha256);
    expect(buildTableProposalRegion(input.page, input.run, "topology", 1)).not.toHaveProperty("review_candidate");
  });

  const attacks = {
    missing_caption: input => { input.page.lines[0].text = "Ordinary paragraph"; },
    competing_paint: input => {
      input.page.ruled_rects.items.push({ x: 50, y: 160, width: 220, height: 1, verb: "fill" });
      input.page.ruled_rects.observed_count++; input.page.ruled_rects.returned_count++;
    },
    truncated_text: input => { input.page.truncation.truncated = true; },
    truncated_geometry: input => { input.page.ruled_rects.status = "truncated"; },
    overlapping_body_rows: input => {
      for (const item of input.page.raw_items.filter(item => item.line_id === "body-1")) item.bbox.y = 152;
    },
    wrapped_body_cell: input => { input.page.raw_items.find(item => item.text === "Low").line_id = "wrapped-body"; },
    missing_cell: input => {
      const item = input.page.raw_items.find(item => item.line_id === "body-1" && item.bbox.x === 220);
      item.bbox.x = 142;
    },
    spanning_top_cell: input => { input.page.raw_items[1].bbox.width = 120; },
    no_common_corridor: input => {
      const item = input.page.raw_items.find(item => item.line_id === "body-1" && item.bbox.x === 140);
      item.bbox.x = 90; item.bbox.width = 120;
    },
    oversized_preview: input => { input.page.raw_items[1].text = "X".repeat(40_001); },
  };
  it.each(Object.keys(attacks))("keeps evidence without a draft for %s", name => {
    const input = fixture(); attacks[name](input);
    expect(packet(input)).not.toHaveProperty("review_candidate");
  });

  it("escapes PDF markup and preserves exact source fragments", () => {
    const input = fixture();
    input.page.raw_items[1].text = '<img src=x onerror="alert(1)"> & https://evil.test';
    const result = packet(input);
    const candidate = result.review_candidate;
    expect(candidate.cells[0].lines[0].text).toBe(input.page.raw_items[1].text);
    expect(candidate.html).toContain("&lt;img");
    expect(candidate.html).toContain("https&#58;//evil&#46;test");
    expect(candidate.html).not.toContain("<img");
  });
});

describe("actual MCP table draft presentation", () => {
  let directory, pdfPath, client, transport;
  beforeAll(async () => {
    directory = await mkdtemp(path.join(os.tmpdir(), "pdf-tools-table-review-"));
    pdfPath = path.join(directory, "synthetic.pdf");
    const pdf = await PDFDocument.create();
    const page = pdf.addPage([612, 792]);
    const font = await pdf.embedFont(StandardFonts.Helvetica);
    const draw = (text, x, top) => page.drawText(text, { x, y: 792 - top - 9, size: 9, font });
    draw("Table 1. Synthetic measurements", 50, 88);
    draw("Concentration", 60, 114); draw("level", 70, 126);
    draw("A", 140, 120); draw("B", 220, 120);
    for (const [index, label] of ["Control", "Low", "High"].entries()) {
      draw(label, 60, 148 + index * 15); draw(String(index), 140, 148 + index * 15);
      draw(String(index + 1), 220, 148 + index * 15);
    }
    draw("3. Results", 50, 210);
    for (const y of [110, 140, 195]) page.drawRectangle({ x: 50, y: 792 - y - 1, width: 220, height: 1 });
    await writeFile(pdfPath, await pdf.save(), { flag: "wx" });
    transport = new StdioClientTransport({ command: process.execPath,
      args: [path.join(root, "server/index.js")], cwd: root,
      env: { ALLOWED_DIRECTORIES: directory }, stderr: "ignore" });
    client = new Client({ name: "table-review-test", version: "1.0.0" });
    await client.connect(transport);
  }, 30000);
  afterAll(async () => { await client?.close(); await transport?.close(); await rm(directory, { recursive: true, force: true }); });

  it("exposes the same draft and warning in text and structure while strict verification rejects", async () => {
    const baseline = await client.callTool({ name: "convert_pdf_to_markdown", arguments: { pdf_path: pdfPath } });
    const result = await client.callTool({ name: "convert_pdf_to_markdown", arguments: {
      pdf_path: pdfPath, emit_table_proposals: true,
    } });
    expect(result.isError).not.toBe(true);
    const region = result.structuredContent.table_proposals.find(item => item.review_candidate);
    expect(region).toBeDefined();
    const candidate = region.review_candidate;
    expect(candidate).toMatchObject({ row_count: 4, column_count: 3, topology_verified: false });
    expect(result.content[0].text).toContain(candidate.review_notice);
    expect(result.content[0].text).toContain(candidate.html);
    expect(result.structuredContent.markdown).toBe(baseline.structuredContent.markdown);
    expect(result.structuredContent.gaps).toEqual(baseline.structuredContent.gaps);
    const verification = await client.callTool({ name: "verify_table_proposal", arguments: {
      pdf_path: pdfPath, region_id: region.region_id, proposal_token: region.proposal_token,
      cells: candidate.cells.map(cell => ({ row: cell.row, column: cell.column,
        rowspan: 1, colspan: 1, item_ids: cell.item_ids })),
    } });
    expect(verification.isError).not.toBe(true);
    expect(verification.structuredContent.status).toBe("rejected");
    expect(verification.structuredContent.table).toBeNull();
    expect(verification.structuredContent.reason_codes).toContain("TABLE_PROPOSAL_TOPOLOGY_AMBIGUOUS");
    expect(verification.structuredContent).not.toHaveProperty("review_candidate");
  }, 30000);
});
