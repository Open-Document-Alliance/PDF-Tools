import { describe, expect, it } from "vitest";
import { buildTableProposalRegion } from "../server/markdown-conversion.js";

function fixture() {
  const rows = [
    ["caption", "Table 1. Example values", 90, 60, 180],
    ["header-1", "Concentration", 112, 60, 60],
    ["header-2", "level", 124, 70, 30],
    ["columns", "A B C", 118, 150, 100],
    ["body-1", "Control 0 0 0", 145, 60, 190],
    ["body-2", "Low 1 2 3", 160, 60, 190],
    ["body-3", "High 4 5 6", 175, 60, 190],
    ["results", "Results", 205, 50, 50],
    ["prose", "Ordinary following prose", 220, 50, 200],
  ];
  const raw_items = rows.map(([id, text, y, x, width], index) => ({
    id, text, reading_order_index: index, line_id: id + "-line", column_index: 0,
    geometry_valid: true, text_kind: "non_whitespace",
    bbox: { x, y, width, height: 10 }, raw_transform: [], quad: null,
  }));
  const lines = raw_items.map(item => ({ ...item.bbox, id: item.line_id,
    text: item.text, item_ids: [item.id] }));
  const items = [110, 140, 190].flatMap(y => [
    { x: 50, y, width: 120, height: 1, verb: "fill" },
    { x: 170, y, width: 100, height: 1, verb: "fill" },
  ]);
  const page = { page: 1, raw_items, lines, truncation: { truncated: false },
    ruled_rects: { status: "available", observed_count: 6, returned_count: 6, items },
    ruling_segments: { status: "available", truncated: false, observed_count: 0, returned_count: 0, items: [] },
    painted_rectangles: { status: "available", truncated: false, observed_count: 0, returned_count: 0, items: [] } };
  const run = lines.slice(3).map(line => ({ line,
    cells: raw_items.filter(item => item.line_id === line.id) }));
  return { page, run };
}

function packet({ page, run }) {
  return buildTableProposalRegion(page, run, "topology", 2);
}

function oldPacket(input) {
  const copy = structuredClone(input);
  copy.page.ruled_rects.status = "unavailable";
  return packet(copy);
}

describe("abandoned three-rule table source envelope", () => {
  it("retains both header lines and removes only outside prose without asserting topology", () => {
    const input = fixture();
    const before = structuredClone(input);
    const result = packet(input);
    expect(result.text_items.map(item => item.id)).toEqual([
      "header-1", "header-2", "columns", "body-1", "body-2", "body-3",
    ]);
    expect(result.bbox).toEqual({ x: 50, y: 110, width: 220, height: 81 });
    expect(result.ruled_rects).toHaveLength(6);
    expect(result.region_id).toBe("p1-t2");
    expect(result.reason).toBe("TABLE_TOPOLOGY_UNKNOWN");
    expect(result.header_hints).toEqual({ status: "unavailable", first_row_height: null,
      body_median_height: null, first_row_band: "unavailable" });
    expect(result).not.toHaveProperty("cells");
    expect(packet(input)).toEqual(result);
    expect(input).toEqual(before);
  });

  const attacks = {
    no_caption: input => { input.page.lines[0].text = "Section 1. Example values"; },
    distant_caption: input => { input.page.lines[0].y = 10; },
    duplicate_caption: input => { input.page.lines.push({ ...input.page.lines[0], id: "other-caption" }); },
    disconnected_band: input => { input.page.ruled_rects.items[1].x += 3; },
    overlapping_band: input => { input.page.ruled_rects.items[1].x -= 3; },
    unequal_width: input => { input.page.ruled_rects.items[5].width -= 10; },
    missing_band: input => { input.page.ruled_rects.items.splice(2, 2); },
    fourth_band: input => { input.page.ruled_rects.items.push({ x: 50, y: 155, width: 220, height: 1, verb: "fill" }); },
    interior_fraction_bar: input => { input.page.ruled_rects.items.push({ x: 65, y: 155, width: 20, height: 1, verb: "fill" }); },
    thick_foreign_fill: input => { input.page.ruled_rects.items.push({ x: 50, y: 155, width: 220, height: 3, verb: "fill" }); },
    short_foreign_fill: input => { input.page.ruled_rects.items.push({ x: 65, y: 155, width: 4, height: 1, verb: "fill" }); },
    foreign_stroke: input => {
      input.page.ruling_segments.items.push({ orientation: "horizontal", x1: 50, x2: 270, y1: 155, y2: 155 });
    },
    foreign_paint: input => { input.page.painted_rectangles.items.push({ bbox: { x: 50, y: 155, width: 220, height: 3 } }); },
    unavailable_strokes: input => { input.page.ruling_segments.status = "unavailable"; },
    truncated_strokes: input => { input.page.ruling_segments.truncated = true; },
    unavailable_paint: input => { input.page.painted_rectangles.status = "unavailable"; },
    truncated_paint: input => { input.page.painted_rectangles.truncated = true; },
    clip_only: input => { input.page.ruled_rects.items.forEach(item => { item.verb = "clip"; }); },
    truncated_geometry: input => { input.page.ruled_rects.status = "truncated"; },
    truncated_text: input => { input.page.truncation.truncated = true; },
    missing_geometry: input => { input.page.raw_items[1].geometry_valid = false; },
    straddling_outer_boundary: input => { input.page.raw_items[1].bbox.y = 109; },
    straddling_middle_rule: input => { input.page.raw_items[1].bbox.y = 135; },
    straddling_line: input => { input.page.lines[1].x = 40; },
    unassigned_item: input => { input.page.lines[1].item_ids = []; },
    duplicate_membership: input => { input.page.lines[1].item_ids.push("header-1"); },
    unrelated_run: input => { input.run = input.run.slice(-2); },
  };
  it.each(Object.keys(attacks))("preserves the original proposal for %s", name => {
    const input = fixture();
    attacks[name](input);
    input.page.ruled_rects.observed_count = input.page.ruled_rects.items.length;
    input.page.ruled_rects.returned_count = input.page.ruled_rects.items.length;
    for (const channel of [input.page.ruling_segments, input.page.painted_rectangles]) {
      channel.observed_count = channel.returned_count = channel.items.length;
    }
    const actual = packet(input);
    const old = oldPacket(input);
    expect(actual.bbox).toEqual(old.bbox);
    expect(actual.text_items).toEqual(old.text_items);
    expect(actual.header_hints).toEqual(old.header_hints);
  });
});
