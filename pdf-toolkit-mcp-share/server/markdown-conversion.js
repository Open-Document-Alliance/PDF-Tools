import { createHash } from "node:crypto";
import {
  EXTRACTION_IR_IDENTITY,
  validatePdfLayoutSemantics,
} from "./layout-extraction.js";

const RENDERER = Object.freeze({
  name: "pdf-tools.layout-markdown-renderer",
  version: "1.20.1",
});
const SUPPORTED_LAYOUT_IR_VERSION = "1.6.0";

// Bounded geometric table inference. A run of adjacent lines is treated as a
// table only when every row fills every detected column, so ragged or
// ambiguous candidates degrade to reading-order text plus a typed gap rather
// than to an invented topology.
const TABLE_MIN_ROWS = 2;
const TABLE_MIN_COLUMNS = 2;
const TABLE_COLUMN_TOLERANCE_POINTS = 3;
// A column must recur on at least this many lines to count as structure, and
// this fraction of a run's text items must sit in those columns.
const TABLE_MIN_COLUMN_ROWS = 2;
const TABLE_COLUMNAR_COVERAGE = 0.8;
// How much taller the first row must be to evidence a header row.
const HEADER_HEIGHT_RATIO = 1.15;
const RULE_MAX_THICKNESS = 1.5;
const RULE_AXIS_TOLERANCE = 1;
const RULE_JOIN_TOLERANCE = 1;
const RULE_EDGE_TOLERANCE = 1.5;
const RULED_TABLE_MAX_ROWS = 100;
const RULED_TABLE_MAX_COLUMNS = 50;
const RULED_TABLE_MAX_CELLS = 1_000;

// Ported from firecrawl/pdf-inspector (MIT): src/tables/detect_rects.rs.
// These are deliberately named, bounded geometry gates rather than a
// confidence score: the renderer either has enough ruling evidence to prove a
// grid or it reports why it declined one.
const RECT_CLUSTER_ADJACENCY_TOLERANCE = 3;
const RECT_SNAP_TOLERANCE = 6;
const RECT_CELL_ASSIGNMENT_SLACK = 2;
const RECT_MIN_CLUSTER_RECTS = 6;
const MAX_CLUSTER_RECTS = 2000;
const RECT_MIN_FILL_RATIO = 0.3;
const RECT_MAX_COLUMNS = 25;
const RECT_CONTAINMENT_TOLERANCE = 2;
// Two cell rectangles sharing a drawn border may overlap by a stroke width;
// anything beyond this in BOTH axes is competing evidence, not a border.
const RECT_MATERIAL_OVERLAP = 1;

// Verified-vision (B1) proposal-packet emission. When a table region is
// abandoned (TABLE_TOPOLOGY_UNKNOWN / TABLE_RULING_UNSUPPORTED), an opt-in flag
// emits one bounded, deterministic descriptor per region so a host model can
// propose a structure and a later read-only verifier (B2) can accept or reject
// it. These are hard, named bounds mirroring the IR's max_items discipline;
// over-cap descriptors report typed truncation rather than unbounded output.
const TABLE_PROPOSAL_COORDINATE_SPACE = "pdfjs_viewport_top_left_points";
export const MAX_TABLE_PROPOSALS_PER_DOCUMENT = 50;
export const MAX_TABLE_PROPOSAL_TEXT_ITEMS = 400;
const MAX_TABLE_PROPOSAL_RULED_RECTS = 400;
const MAX_TABLE_PROPOSAL_RULING_SEGMENTS = 400;
const MAX_TABLE_PROPOSAL_PAINTED_RECTS = 400;

const MAX_MARKDOWN_BYTES_LIMIT = 200_000;
const GAP_CODES = new Set([
  "CONTROL_CHARACTERS_SANITIZED",
  "IMAGE_CONTENT_NOT_RENDERED",
  "INVALID_TEXT_GEOMETRY",
  "LINK_ANNOTATIONS_UNAVAILABLE",
  "LINK_MAPPING_AMBIGUOUS",
  "MATH_NOT_RECONSTRUCTED",
  "OCR_NOT_PERFORMED",
  "PAGE_FURNITURE_REMOVED",
  "PAGE_RANGE_INCOMPLETE",
  "RAW_PAGE_GEOMETRY_UNAVAILABLE",
  "SOURCE_CHARACTER_LIMIT_REACHED",
  "SOURCE_ITEM_LIMIT_REACHED",
  "TABLE_RULING_UNSUPPORTED",
  "TABLE_TOPOLOGY_UNKNOWN",
  "TEXT_INTEGRITY_SUSPECT",
  "TEXT_LAYER_EMPTY",
  "TEXT_LAYER_FAILED",
  "UNSUPPORTED_LINK_TARGET",
  "VECTOR_CONTENT_NOT_INTERPRETED",
]);

const LIMITATIONS = Object.freeze([
  "Headings are emitted only from consistent enlarged font metrics, centered English-language source structure with section spacing, or numbered or lettered research-paper structure at an established body margin with spacing plus font, size, or exact small-caps evidence. Wrapped heading lines are joined only from matching font and height, a very small vertical gap, and bounded alignment. Narrow vertical labels and ambiguous, very short, or unsupported heading styles remain body text.",
  "Page furniture is removed only from an extreme top or bottom margin band when a compact line of at most 120 Unicode characters is separated from the body and is either an explicit page-number or provenance pattern, or repeats in the same band on at least two selected pages after bounded digit normalization. Multiple lines matching the bare-page-number pattern in the same page band are ambiguous and retained, even if they repeat across pages or compact mode is enabled. Detected headings, their geometric continuations, and source-evidenced table-region lines, including abandoned table regions, are never removed. Every removal is reported by a typed page gap and counted by kind; callers can disable this furniture-removal pass. Optional compact normalization is separate.",
  "A geometrically overlapping initial capital may be joined to its following uppercase word remainder. Line-end hyphens are preserved because source geometry cannot reliably distinguish a split word from an intentional compound. The source Extraction IR retains the original lines.",
  "A missing space after a separate source text item that is exactly the mathematical operator log is restored only in a short, compact left-to-right math run when a single-letter variable from a different source font resource follows on the same baseline with a small positive geometric gap and independent local math-layout evidence. A missing prose-to-variable space is restored only when a multiword prose item, a separate uppercase letter from a different source font resource, and continuing prose from the original prose font share one baseline with distinct positive boundary gaps, and the same letter/font pair occurs in a nearby compact equation on the same page and column. An inline single-digit stacked fraction is rendered only when consecutive same-font source items, explicit source whitespace, smaller exactly aligned numerator and denominator digits, ordinary prose on both sides, and exactly one thin matching solid-mask bar agree. A small version-pinned registry may recover a legacy Computer Modern Type-3 character only after an exact official-metric family match, exact target and witness glyph-program matches, and a complete operator/text sequence binding. Two witnesses are required unless the source font subset cannot supply them, in which case the entry must declare that font's complete enrolled footprint and every code in it must be present and match. General equations, other fraction bars, unregistered raster variants, and other damaged mathematical glyphs remain source reading-order text rather than being guessed.",
  "A glyph run the source painted smaller and displaced from the baseline of the text it is attached to is written as Unicode superscript characters when it was raised and Unicode subscript characters when it was lowered. This records how the page is set and nothing more: a page raises a mathematical exponent and a footnote reference in exactly the same way, so this does not distinguish the two, does not assert that a raised digit is a power, and does not assert that a lowered one is an index. A displaced run is written only when every one of its characters has a real Unicode form in that direction and the whole run is present on one line, so a run stays flat entire rather than being written in part. Unicode subscript coverage is much thinner than superscript coverage, with no capital letters and only some lowercase ones, so many lowered runs stay flat for that reason alone. A stacked fraction numerator is raised by the same amount but stands clear of the text before it, and is left alone. Where the source set a displaced run without changing font and without leaving any of its base's advance unused, the text layer reports it as part of the base run and no displacement survives to be read, so that run stays flat too and is indistinguishable here from text the page never displaced. A line whose source items cannot all be located within its own extracted text, and a line the stacked-fraction projection rebuilt, keep the text they had rather than being partly rewritten.",
  "Lists are emitted only for literal bullet glyphs or decimal markers present in the source text.",
  "Links are emitted only for source-validated http or https annotation targets that map to exactly one contiguous run of text on one line. Internal destinations, actions, other schemes, ambiguous or partially covered labels, and links inside reconstructed tables remain escaped text reported as a conversion gap, and URL-looking source text is escaped to resist host autolinking.",
  "Tables are reconstructed directly only from complete text-item column geometry, clean ruled-rectangle grid evidence, or one unambiguous complete closed grid of bounded axis-aligned solid-mask rectangles. Every text item must fit exactly one cell, aligned partial dividers that evidence merged or spanning topology are rejected, and the first row must carry real header evidence because Markdown imposes header semantics. On an opt-in abstention path, a caller may submit item-to-cell assignments to the read-only verifier; accepted cell content is rebuilt only from a fresh source parse and the grid must agree with all available source-replayed ruling geometry. This proves source-backed content and consistency, not unique topology; ambiguous or unsupported geometry remains rejected. GFM cannot encode row or column spans, so accepted spans retain their authority in structured cells while Markdown places source text once at the anchor and leaves continuation slots empty. Incomplete grids and damaged mathematical glyphs are not interpreted; other ambiguous content remains escaped reading-order text with a conversion gap. Cell artwork is omitted and reported as a vector-content gap; only independently qualified exact legacy glyph variants are recovered.",
  "Vector paint operations beyond any reconstructed ruled or solid-mask table grid are not interpreted.",
  "OCR is not performed. Image-only text and text that exists only inside page images are omitted and reported as conversion gaps.",
  "Unsafe control characters and malformed UTF-16 surrogates are replaced with the Unicode replacement character and reported as conversion gaps.",
]);

function assertion(condition, message) {
  if (!condition) throw new Error(`Invalid Markdown conversion semantics: ${message}`);
}

function validateSupportedLayoutIdentity(layout) {
  assertion(layout.ir?.name === EXTRACTION_IR_IDENTITY.name
    && layout.ir?.version === SUPPORTED_LAYOUT_IR_VERSION
    && SUPPORTED_LAYOUT_IR_VERSION === EXTRACTION_IR_IDENTITY.version,
  `unsupported layout IR; expected ${EXTRACTION_IR_IDENTITY.name} ${SUPPORTED_LAYOUT_IR_VERSION}`);
  assertion(layout.parser?.name === "pdfjs-dist" && layout.parser?.version === "5.4.624",
    "unsupported parser; expected pdfjs-dist 5.4.624");
}

function utf8Bytes(value) {
  return Buffer.byteLength(value, "utf8");
}

function sha256(value) {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function median(values) {
  const sorted = [...values].sort((left, right) => left - right);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0
    ? (sorted[middle - 1] + sorted[middle]) / 2
    : sorted[middle];
}

function containsUnsafeText(value) {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if ((code >= 0 && code <= 8) || code === 11 || code === 12 || (code >= 14 && code <= 31) || code === 127) return true;
    if (code >= 0xd800 && code <= 0xdbff) {
      const next = value.charCodeAt(index + 1);
      if (next >= 0xdc00 && next <= 0xdfff) index += 1;
      else return true;
    } else if (code >= 0xdc00 && code <= 0xdfff) {
      return true;
    }
  }
  return false;
}

function sanitizeUnsafeText(value) {
  let sanitized = "";
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if ((code >= 0 && code <= 8) || code === 11 || code === 12 || (code >= 14 && code <= 31) || code === 127) {
      sanitized += "\ufffd";
    } else if (code >= 0xd800 && code <= 0xdbff) {
      const next = value.charCodeAt(index + 1);
      if (next >= 0xdc00 && next <= 0xdfff) {
        sanitized += value[index] + value[index + 1];
        index += 1;
      } else {
        sanitized += "\ufffd";
      }
    } else if (code >= 0xdc00 && code <= 0xdfff) {
      sanitized += "\ufffd";
    } else {
      sanitized += value[index];
    }
  }
  return sanitized;
}

function escapePlainMarkdown(value) {
  const escaped = sanitizeUnsafeText(String(value))
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/\\/g, "\\\\")
    .replace(/([`*_\[\]|])/g, "\\$1")
    .replace(/https?:/giu, match => `${match.slice(0, -1)}&#58;`)
    .replace(/\b(?:[\p{L}\p{N}-]+\.)+[\p{L}]{2,}\b/giu, domain => domain.replace(".", "&#46;"))
    .replace(/@(?=[\p{L}\p{N}.-]+&#46;[\p{L}]{2,})/giu, "&#64;");
  // A source text item may itself contain LF or CR, which sanitizeUnsafeText
  // deliberately preserves. Every physical line start must therefore be
  // guarded, not just the start of the string, or embedded block syntax stays
  // live. Leading whitespace is matched horizontally so "^" cannot consume the
  // newline that defines the next line.
  return escaped
    .replace(/^([^\S\r\n]*)([=-]+)([^\S\r\n]*)$/gmu, "$1\\$2$3")
    .replace(/^([^\S\r\n]*)(~{3,})(.*)$/gmu, "$1\\$2$3")
    .replace(/^([^\S\r\n]*)([#>+\-=])(?=[^\S\r\n]|$)/gmu, "$1\\$2")
    .replace(/^([^\S\r\n]*)(\d{1,9})([.)])(?=[^\S\r\n])/gmu, "$1$2\\$3");
}

function lineFontEvidence(page) {
  const itemById = new Map(page.raw_items.map(item => [item.id, item]));
  return page.lines.map(line => {
    const items = line.item_ids.map(id => itemById.get(id)).filter(Boolean);
    const heights = items.map(item => item.line_height).filter(Number.isFinite);
    const fontNames = new Set(items.map(item => item.font_name));
    return {
      line,
      height: heights.length > 0 ? median(heights) : null,
      consistentHeight: heights.length > 0
        && Math.max(...heights) - Math.min(...heights) <= Math.max(0.5, median(heights) * 0.1),
      consistentFont: fontNames.size === 1 && !fontNames.has(null),
      fontName: fontNames.size === 1 ? [...fontNames][0] : null,
    };
  });
}

function headingTextEligible(value) {
  const text = String(value).trim();
  const alphanumericCharacters = text.match(/[\p{L}\p{N}]/gu) ?? [];
  return !text.includes("\uFFFD")
    && alphanumericCharacters.length >= 3
    && !/[=∑∫∞≤≥≈≠±×÷√]/u.test(text);
}

function titleCaseHeading(value) {
  const words = String(value).trim().match(/[\p{L}\p{N}]+(?:-[\p{L}\p{N}]+)*/gu) ?? [];
  if (words.length < 3 || words.length > 15) return false;
  const minorWords = new Set(["a", "an", "and", "as", "at", "by", "for", "in", "of", "on", "or", "the", "to"]);
  return words.every((word, index) => {
    const lower = word.toLocaleLowerCase("en-US");
    if (index > 0 && minorWords.has(lower)) return true;
    const first = [...word][0];
    return first === first.toLocaleUpperCase("en-US")
      && first !== first.toLocaleLowerCase("en-US");
  });
}

function lineIsCentered(page, line) {
  const pageWidth = page.geometry?.display_width;
  return Number.isFinite(pageWidth)
    && Math.abs(line.x + line.width / 2 - pageWidth / 2) <= Math.max(4, line.height);
}

function hasSectionBreakBefore(page, evidence, index, bodyHeight) {
  const line = evidence[index].line;
  if (index === 0) {
    return Number.isFinite(page.geometry?.display_height)
      && line.y >= page.geometry.display_height * 0.07;
  }
  const previous = evidence[index - 1].line;
  const gap = line.y - (previous.y + previous.height);
  return gap >= Math.max(line.height, bodyHeight) * 1.15;
}

function hasNumberedSectionBreakBefore(page, evidence, index, bodyHeight) {
  const line = evidence[index].line;
  if (index === 0) {
    return Number.isFinite(page.geometry?.display_height)
      && line.y >= page.geometry.display_height * 0.07;
  }
  const previous = evidence[index - 1].line;
  const gap = line.y - (previous.y + previous.height);
  return gap >= Math.max(line.height, bodyHeight) * 0.8;
}

function dominantBodyFont(page, bodyHeight) {
  const weights = new Map();
  for (const item of page.raw_items) {
    if (item.is_whitespace || !Number.isFinite(item.line_height)
      || Math.abs(item.line_height - bodyHeight) > bodyHeight * 0.1
      || typeof item.font_name !== "string") continue;
    const weight = (item.text.match(/[\p{L}\p{N}]/gu) ?? []).length;
    if (weight > 0) weights.set(item.font_name, (weights.get(item.font_name) ?? 0) + weight);
  }
  return [...weights.entries()].sort((left, right) => right[1] - left[1] || left[0].localeCompare(right[0]))[0]?.[0] ?? null;
}

function bodyLeftAligned(evidence, bodyHeight, line) {
  const bodyLines = evidence.filter(({ line, height }) => (
    Number.isFinite(height)
    && Math.abs(height - bodyHeight) <= bodyHeight * 0.1
    && line.text.trim().length >= 20
  )).map(({ line }) => line.x).filter(Number.isFinite);
  return Number.isFinite(line.x)
    && bodyLines.filter(x => Math.abs(x - line.x) <= Math.max(4, bodyHeight)).length >= 3;
}

function lineIsBodyColumnCentered(page, evidence, bodyHeight, line) {
  const pageWidth = page.geometry?.display_width;
  if (!Number.isFinite(pageWidth)) return false;
  const lineCenter = line.x + line.width / 2;
  const sameHalf = candidate => (candidate.x + candidate.width / 2 < pageWidth / 2)
    === (lineCenter < pageWidth / 2);
  const prose = evidence.filter(({ line: candidate, height }) => (
    Number.isFinite(height)
    && Math.abs(height - bodyHeight) <= bodyHeight * 0.1
    && candidate.width >= pageWidth * 0.25
    && (candidate.text.match(/[\p{L}\p{N}]/gu) ?? []).length >= 20
    && sameHalf(candidate)
  )).map(({ line: candidate }) => candidate);
  if (prose.length < 3) return false;
  const columnCenter = (median(prose.map(candidate => candidate.x))
    + median(prose.map(candidate => candidate.x + candidate.width))) / 2;
  return Math.abs(lineCenter - columnCenter) <= Math.max(4, line.height);
}

function pageBodyHeight(page, evidence) {
  const heights = evidence.map(value => value.height).filter(Number.isFinite);
  const pageWidth = page.geometry?.display_width;
  if (!Number.isFinite(pageWidth)) return median(heights);
  const proseHeights = evidence.filter(({ line, height }) => (
    Number.isFinite(height)
    && line.width >= pageWidth * 0.25
    && (line.text.match(/[\p{L}\p{N}]/gu) ?? []).length >= 20
  )).map(value => value.height);
  return proseHeights.length >= 3 ? median(proseHeights) : median(heights);
}

function hasBodyTextAfter(page, evidence, index, bodyHeight) {
  const next = evidence[index + 1];
  if (!next || !Number.isFinite(page.geometry?.display_width) || !Number.isFinite(next.height)) return false;
  const gap = next.line.y - (evidence[index].line.y + evidence[index].line.height);
  return next.height >= bodyHeight * 0.9
    && next.height <= bodyHeight * 1.1
    && (next.line.text.match(/[\p{L}\p{N}]/gu) ?? []).length >= 10
    && gap >= 0
    && gap <= bodyHeight * 8;
}

function smallCapsNumberedHeadingEvidence(page, line, bodyHeight, headingWords) {
  if (headingWords !== headingWords.toLocaleUpperCase("en-US")) return false;
  const itemById = new Map(page.raw_items.map(item => [item.id, item]));
  const items = line.item_ids.map(id => itemById.get(id)).filter(item => item && !item.is_whitespace);
  const heights = items.map(item => item.line_height).filter(Number.isFinite);
  const fontNames = new Set(items.map(item => item.font_name));
  if (heights.length < 3 || fontNames.size !== 1 || fontNames.has(null)) return false;
  const minimum = Math.min(...heights);
  const maximum = Math.max(...heights);
  const enlargedInitials = minimum >= bodyHeight * 0.9
    && minimum <= bodyHeight * 1.05
    && maximum >= bodyHeight * 1.15
    && maximum <= bodyHeight * 1.3
    && maximum / minimum >= 1.15;
  const bodySizedInitials = minimum >= bodyHeight * 0.75
    && minimum <= bodyHeight * 0.85
    && maximum >= bodyHeight * 0.95
    && maximum <= bodyHeight * 1.05
    && maximum / minimum >= 1.2
    && maximum / minimum <= 1.3;
  return enlargedInitials || bodySizedInitials;
}

function numberedSectionHeadingLevel(page, evidence, index, bodyHeight, bodyFontName) {
  const { line, height, consistentHeight, consistentFont, fontName } = evidence[index];
  const text = line.text.trim();
  const match = text.match(/^(?:(\d{1,3})(?:\.(\d{1,3}))?(?:\.(\d{1,3}))?|([A-Z])(?:\.(\d{1,3}))?)\s+([\p{Lu}][^\n]{1,100})$/u);
  const pageWidth = page.geometry?.display_width;
  const contrastingFontEvidence = consistentHeight && consistentFont && fontName && fontName !== bodyFontName
    && Number.isFinite(height) && height >= bodyHeight * 0.95 && height <= bodyHeight * 1.35;
  const enlargedTextEvidence = consistentHeight && consistentFont
    && Number.isFinite(height) && height >= bodyHeight * 1.08 && height <= bodyHeight * 1.35;
  const smallCapsEvidence = match
    ? smallCapsNumberedHeadingEvidence(page, line, bodyHeight, match[6])
    : false;
  if (!match || !headingTextEligible(text) || /[.!?;:]$/u.test(text)
    || (!contrastingFontEvidence && !enlargedTextEvidence && !smallCapsEvidence)
    || !Number.isFinite(pageWidth) || line.width < line.height * 2 || line.width > pageWidth * 0.7
    || !bodyLeftAligned(evidence, bodyHeight, line)
    || !hasNumberedSectionBreakBefore(page, evidence, index, bodyHeight)) return null;
  if (match[4] !== undefined) return match[5] === undefined ? 2 : 3;
  return match[3] === undefined ? (match[2] === undefined ? 2 : 3) : 4;
}

function wrappedResearchTitleLevel(page, evidence, index, bodyHeight, bodyFontName) {
  const first = evidence[index];
  if (!first.consistentHeight || !first.consistentFont || !first.fontName
    || !Number.isFinite(first.height)
    || first.height < bodyHeight * 1.08 || first.height > bodyHeight * 1.35
    || (first.fontName === bodyFontName && first.height < bodyHeight * 1.15)
    || !lineIsBodyColumnCentered(page, evidence, bodyHeight, first.line)
    || !hasSectionBreakBefore(page, evidence, index, bodyHeight)
    || /^(?:Figure|Table|Algorithm)\b/iu.test(first.line.text.trim())) return null;
  let end = index;
  while (end < evidence.length - 1 && end - index < 2) {
    const current = evidence[end];
    const next = evidence[end + 1];
    const gap = next.line.y - (current.line.y + current.line.height);
    if (!next.consistentHeight || !next.consistentFont
      || next.fontName !== first.fontName
      || !Number.isFinite(next.height)
      || Math.abs(next.height - first.height) > first.height * 0.05
      || gap < 0 || gap > Math.max(4, bodyHeight * 0.5)
      || !lineIsBodyColumnCentered(page, evidence, bodyHeight, next.line)) break;
    end += 1;
  }
  if (end === index || !hasBodyTextAfter(page, evidence, end, bodyHeight)) return null;
  const text = evidence.slice(index, end + 1).map(item => item.line.text.trim()).join(" ");
  return headingTextEligible(text) && titleCaseHeading(text) ? 2 : null;
}

function structuralHeadingLevel(page, evidence, index, bodyHeight) {
  const line = evidence[index].line;
  const text = line.text.trim();
  if (page.page === 1 && text === "CONTENTS" && headingTextEligible(text)) return 1;
  if (!headingTextEligible(text) || !lineIsCentered(page, line)) return null;
  if (!hasSectionBreakBefore(page, evidence, index, bodyHeight)) return null;
  if (page.page === 1 && text === "INTRODUCTION") return 2;
  if (/^PART\s+[IVXLCDM]+:\s+.+$/u.test(text) && text === text.toLocaleUpperCase("en-US")) return 2;
  if (/^APPENDIX\s+(?:\d+|[IVXLCDM]+)$/u.test(text)) return 2;
  return null;
}

function structuralHeadingLevels(page, evidence, bodyHeight) {
  const structural = new Map(evidence.flatMap(({ line }, index) => {
    const level = structuralHeadingLevel(page, evidence, index, bodyHeight);
    return level === null ? [] : [[line.id, level]];
  }));
  const bodyFontName = dominantBodyFont(page, bodyHeight);
  for (let index = 0; index < evidence.length; index += 1) {
    const level = numberedSectionHeadingLevel(page, evidence, index, bodyHeight, bodyFontName);
    if (level !== null) structural.set(evidence[index].line.id, level);
    const wrappedLevel = wrappedResearchTitleLevel(page, evidence, index, bodyHeight, bodyFontName);
    if (wrappedLevel !== null) structural.set(evidence[index].line.id, wrappedLevel);
  }
  if (page.page !== 1) return structural;
  const titleCandidates = evidence.filter(({ line, height }) => (
    headingTextEligible(line.text)
    && titleCaseHeading(line.text)
    && lineIsCentered(page, line)
    && Number.isFinite(page.geometry?.display_height)
    && line.y <= page.geometry.display_height * 0.35
    && Number.isFinite(height)
    && height >= bodyHeight * 1.2
  ));
  const ranked = [...titleCandidates].sort((left, right) => (
    (right.height ?? 0) - (left.height ?? 0)
    || evidence.findIndex(item => item.line.id === left.line.id)
      - evidence.findIndex(item => item.line.id === right.line.id)
  ));
  const winner = ranked[0];
  if (winner) structural.set(winner.line.id, 1);
  return structural;
}

function headingLevels(page) {
  const evidence = lineFontEvidence(page);
  const heights = evidence.map(value => value.height).filter(Number.isFinite);
  if (heights.length < 4) return new Map();
  const bodyHeight = pageBodyHeight(page, evidence);
  const structural = structuralHeadingLevels(page, evidence, bodyHeight);
  const bodyEvidence = heights.filter(height => Math.abs(height - bodyHeight) <= bodyHeight * 0.1);
  if (bodyEvidence.length < 3) return structural;
  const candidates = evidence.filter(({ line, height, consistentHeight, consistentFont }, index) => (
    consistentHeight
      && consistentFont
      && height >= bodyHeight * 1.5
      && line.text.length > 0
      && line.text.length <= 120
      && headingTextEligible(line.text)
      && hasBodyTextAfter(page, evidence, index, bodyHeight)
      && line.width >= line.height * 2
      && height <= bodyHeight * 4
      && !/[.!?;]$/u.test(line.text)
      && !/^\s*(?:[\u2022\u2023\u25e6\u2043\u2219]|\d{1,3}[.)])\s+/u.test(line.text)
  ));
  const levels = [...new Set(candidates.map(value => value.height))].sort((left, right) => right - left);
  const geometric = candidates.map(({ line, height }) => [line.id, Math.min(6, levels.indexOf(height) + 1)]);
  const combined = new Map([...geometric, ...structural]);
  if (page.page === 1) {
    const h1 = evidence.filter(({ line }) => combined.get(line.id) === 1);
    const preferred = h1.find(({ line }) => structural.get(line.id) === 1) ?? h1[0];
    for (const { line } of h1) {
      if (line.id !== preferred?.line.id) combined.set(line.id, 2);
    }
  }
  return combined;
}

function headingContinuationIds(page, headings) {
  const evidence = lineFontEvidence(page);
  const bodyHeight = pageBodyHeight(page, evidence);
  const continuations = new Set();
  for (let index = 0; index < evidence.length - 1; index += 1) {
    const current = evidence[index];
    const next = evidence[index + 1];
    if ((!headings.has(current.line.id) && !continuations.has(current.line.id)) || headings.has(next.line.id)
      || !current.consistentHeight || !next.consistentHeight
      || !current.consistentFont || !next.consistentFont
      || current.fontName !== next.fontName
      || !Number.isFinite(current.height) || !Number.isFinite(next.height)
      || Math.abs(current.height - next.height) > current.height * 0.05
      || !headingTextEligible(next.line.text)) continue;
    const gap = next.line.y - (current.line.y + current.line.height);
    const aligned = (next.line.x >= current.line.x - Math.max(4, bodyHeight * 0.25)
        && next.line.x - current.line.x <= bodyHeight * 3)
      || (lineIsCentered(page, current.line) && lineIsCentered(page, next.line));
    if (gap >= 0 && gap <= Math.max(4, bodyHeight * 0.5) && aligned) {
      continuations.add(next.line.id);
    }
  }
  return continuations;
}

const PAGE_FURNITURE_BAND_FRACTION = 0.12;
const PAGE_FURNITURE_LABELLED_PAGE_NUMBER = /^(?:page|p(?:age)?\.?|p[aá]gina|pagina|seite)\s*[:.\-]?\s*(?:\d{1,4}|[ivxlcdm]{1,8})(?:\s*(?:of|de|\/|-)\s*(?:\d{1,4}|[ivxlcdm]{1,8}))?$/iu;
const PAGE_FURNITURE_BARE_PAGE_NUMBER = /^(?:\d{1,4}|[ivxlcdm]{2,8})(?:\s*(?:of|de|\/|-)\s*(?:\d{1,4}|[ivxlcdm]{1,8}))?$/iu;
const PAGE_FURNITURE_PROVENANCE = /^(?:©|copyright\b|printed\b|downloaded\s+from\b|please\s+cite\b|journal\s+homepage\b|contents\s+lists\s+available\s+at\b|article\s+in\s+press\b|single-user\s+licen[cs]e\b|https?:\/\/|www\.)/iu;

function pageFurniturePageNumber(text) {
  // A bare single Roman glyph (especially "I") is ordinary prose often
  // enough that removing it would be worse than retaining a page number.
  return PAGE_FURNITURE_LABELLED_PAGE_NUMBER.test(text)
    || PAGE_FURNITURE_BARE_PAGE_NUMBER.test(text);
}

function pageFurnitureBand(page, line) {
  const pageHeight = page.geometry?.display_height;
  if (!Number.isFinite(pageHeight) || pageHeight <= 0) return null;
  if (line.y + line.height <= pageHeight * PAGE_FURNITURE_BAND_FRACTION) return "header";
  if (line.y >= pageHeight * (1 - PAGE_FURNITURE_BAND_FRACTION)) return "footer";
  return null;
}

function normalizedPageFurnitureKey(text) {
  return text.normalize("NFKC")
    .toLocaleLowerCase("en-US")
    .replace(/\p{N}+/gu, "#")
    .replace(/\s+/gu, " ")
    .trim();
}

function ambiguousBarePageNumberIds(page) {
  // Blank form grids need not qualify as reconstructed tables. Several bare
  // numbers in one margin band can be cell labels, not pagination. Count all
  // source lines before eligibility filters so a protected label still makes
  // its neighbour ambiguous, and exclude them before cross-page repetition.
  const bareNumberCounts = new Map();
  for (const line of page.lines) {
    const band = pageFurnitureBand(page, line);
    if (band !== null && PAGE_FURNITURE_BARE_PAGE_NUMBER.test(line.text.trim())) {
      bareNumberCounts.set(band, (bareNumberCounts.get(band) ?? 0) + 1);
    }
  }
  return new Set(page.lines.filter(line => (
    bareNumberCounts.get(pageFurnitureBand(page, line)) > 1
    && PAGE_FURNITURE_BARE_PAGE_NUMBER.test(line.text.trim())
  )).map(line => line.id));
}

function pageFurnitureCandidates(page) {
  const ambiguousNumberIds = ambiguousBarePageNumberIds(page);
  const headings = headingLevels(page);
  const headingContinuations = headingContinuationIds(page, headings);
  const analysis = segmentPageLines(page);
  const tableLineIds = new Set(analysis.segments.flatMap(segment => (
    segment.kind === "table" ? segment.rows.map(row => row.line.id) : []
  )));
  // An abandoned table region is still source-evidenced table content. Keep
  // all of its rows even if one resembles a page number or repeated footer;
  // the existing typed table gap is the safe representation of uncertainty.
  for (const region of analysis.regions) {
    for (const row of region.run) tableLineIds.add(row.line.id);
  }
  const fontEvidence = new Map(lineFontEvidence(page).map(value => [value.line.id, value]));
  const innerBody = page.lines.filter(line => (
    pageFurnitureBand(page, line) === null
    && !headings.has(line.id)
    && !headingContinuations.has(line.id)
    && !tableLineIds.has(line.id)
    && (line.text.match(/[\p{L}\p{N}]/gu) ?? []).length >= 10
  ));
  if (innerBody.length < 2) return [];
  const bodyTop = Math.min(...innerBody.map(line => line.y));
  const bodyBottom = Math.max(...innerBody.map(line => line.y + line.height));
  const bodyHeight = median(innerBody
    .map(line => fontEvidence.get(line.id)?.height ?? line.height)
    .filter(Number.isFinite));
  if (!Number.isFinite(bodyHeight) || bodyHeight <= 0) return [];

  return page.lines.flatMap(line => {
    const band = pageFurnitureBand(page, line);
    if (band === null || headings.has(line.id) || headingContinuations.has(line.id)
      || tableLineIds.has(line.id)) return [];
    const text = line.text.trim();
    if (ambiguousNumberIds.has(line.id)) return [];
    // Long legal/provenance sentences can still be semantically referenced by
    // the document body. Keep them: this lane removes compact furniture, not
    // arbitrary margin paragraphs.
    if (text.length === 0 || text.length > 120) return [];
    const height = fontEvidence.get(line.id)?.height ?? line.height;
    if (!Number.isFinite(height) || height > bodyHeight * 1.15) return [];
    const separation = band === "header"
      ? bodyTop - (line.y + line.height)
      : line.y - bodyBottom;
    if (separation < Math.max(4, bodyHeight * 0.4)) return [];
    return [{
      page: page.page,
      lineId: line.id,
      text,
      characters: [...text].length,
      band,
      key: normalizedPageFurnitureKey(text),
      explicitKind: pageFurniturePageNumber(text)
        ? "page_number"
        : PAGE_FURNITURE_PROVENANCE.test(text)
          ? `running_${band}`
          : null,
    }];
  });
}

function planDocumentPageFurniture(pages, enabled) {
  const plans = new Map(pages.map(page => [page.page, []]));
  if (!enabled) return plans;
  const candidates = pages.flatMap(pageFurnitureCandidates);
  const repeated = new Map();
  for (const candidate of candidates) {
    if (candidate.key.length === 0) continue;
    const groupKey = `${candidate.band}:${candidate.key}`;
    if (!repeated.has(groupKey)) repeated.set(groupKey, []);
    repeated.get(groupKey).push(candidate);
  }
  const repeatedKeys = new Set([...repeated]
    .filter(([, values]) => new Set(values.map(value => value.page)).size >= 2)
    .map(([key]) => key));

  for (const candidate of candidates) {
    const groupKey = `${candidate.band}:${candidate.key}`;
    const kind = candidate.explicitKind
      ?? (repeatedKeys.has(groupKey) ? `running_${candidate.band}` : null);
    if (kind === null) continue;
    plans.get(candidate.page).push({
      lineId: candidate.lineId,
      kind,
      characters: candidate.characters,
    });
  }
  return plans;
}

/**
 * Whether renderLine rewrites this line's structure (bullet or ordered marker).
 * Such lines cannot carry a spliced inline link.
 */
function rewritesLineStructure(line) {
  const text = line.text.trim();
  return /^[\u2022\u2023\u25e6\u2043\u2219]\s+(.+)$/u.test(text)
    || /^(\d{1,3})([.)])\s+(.+)$/u.test(text);
}

function renderLine(line, headingLevel, sourceText = line.text) {
  const text = sourceText.trim();
  if (headingLevel) return `${"#".repeat(headingLevel)} ${escapePlainMarkdown(text)}`;
  const bullet = text.match(/^[\u2022\u2023\u25e6\u2043\u2219]\s+(.+)$/u);
  if (bullet) return `- ${escapePlainMarkdown(bullet[1])}`;
  const ordered = text.match(/^(\d{1,3})([.)])\s+(.+)$/u);
  if (ordered) return `${ordered[1]}${ordered[2]} ${escapePlainMarkdown(ordered[3])}`;
  return escapePlainMarkdown(text);
}

// A link rect must contain essentially all of a text item's box for that item
// to count as labelled by the link. Anything partially covered is ambiguous.
const LINK_ITEM_CONTAINMENT = 0.95;

function itemBox(item) {
  if (item.bbox
    && Number.isFinite(item.bbox.x) && Number.isFinite(item.bbox.y)
    && Number.isFinite(item.bbox.width) && Number.isFinite(item.bbox.height)) {
    return item.bbox;
  }
  return null;
}

function coveredFraction(box, rect) {
  const overlapWidth = Math.min(box.x + box.width, rect.x + rect.width) - Math.max(box.x, rect.x);
  const overlapHeight = Math.min(box.y + box.height, rect.y + rect.height) - Math.max(box.y, rect.y);
  if (overlapWidth <= 0 || overlapHeight <= 0) return 0;
  const area = box.width * box.height;
  if (!(area > 0)) return 0;
  return (overlapWidth * overlapHeight) / area;
}

/**
 * Percent-encode the characters that would otherwise terminate or reshape a
 * Markdown inline-link destination. The IR already guarantees an absolute
 * http/https href with no whitespace or control characters.
 */
function encodeLinkDestination(href) {
  return href.replace(/[()<>\\]/gu, character => (
    `%${character.codePointAt(0).toString(16).toUpperCase().padStart(2, "0")}`
  ));
}

/**
 * Prove where each retained item sits inside the line's exact text. Offsets are
 * recovered by scanning line.text forward, so a label can later be spliced from
 * the original string rather than rebuilt from item fragments. Returns null if
 * any item cannot be located, which fails the line closed.
 */
function itemOffsets(line, items) {
  const offsets = [];
  let cursor = 0;
  for (const item of items) {
    if (typeof item.text !== "string" || item.text.length === 0) return null;
    const index = line.text.indexOf(item.text, cursor);
    if (index === -1) return null;
    offsets.push({ start: index, end: index + item.text.length });
    cursor = index + item.text.length;
  }
  return offsets;
}

/**
 * Build one page-global plan for every link annotation.
 *
 * Fail-closed. A link is rendered only when it covers items on exactly one
 * eligible line, those items form one contiguous run, no item is partially
 * covered, no other annotation of any kind touches them, and the label offsets
 * are provable against the line's exact text. Every other outcome degrades to
 * escaped text plus a typed gap, so a rect spanning two lines can never emit
 * two links.
 *
 * Every annotation contributes a footprint, including unsupported and
 * ambiguous ones, so an unsupported target overlapping a supported label
 * suppresses that label instead of being silently ignored.
 */
function planPageLinks(rows, links, excludedLineIds) {
  const spansByLine = new Map();
  const offsetsByLine = new Map();
  let ambiguous = false;
  let unsupportedTarget = false;

  for (const row of rows) {
    const offsets = itemOffsets(row.line, row.cells);
    if (offsets !== null) offsetsByLine.set(row.line.id, offsets);
  }

  const footprints = [];
  const candidates = [];
  for (const link of links) {
    const supported = link.target_kind === "http";
    if (!supported) unsupportedTarget = true;
    if (link.rect === null) {
      if (supported) ambiguous = true;
      continue;
    }
    const touched = new Map();
    let partial = false;
    for (let rowIndex = 0; rowIndex < rows.length; rowIndex += 1) {
      const row = rows[rowIndex];
      for (let itemIndex = 0; itemIndex < row.cells.length; itemIndex += 1) {
        const box = itemBox(row.cells[itemIndex]);
        if (box === null) continue;
        const fraction = coveredFraction(box, link.rect);
        if (fraction <= 0) continue;
        if (!touched.has(rowIndex)) touched.set(rowIndex, { contained: [], any: [] });
        touched.get(rowIndex).any.push(itemIndex);
        if (fraction >= LINK_ITEM_CONTAINMENT) touched.get(rowIndex).contained.push(itemIndex);
        else partial = true;
      }
    }
    // Footprints cover every item this annotation overlaps at all.
    for (const [rowIndex, entry] of touched) {
      footprints.push({
        link,
        lineId: rows[rowIndex].line.id,
        start: Math.min(...entry.any),
        end: Math.max(...entry.any),
      });
    }
    if (!supported) continue;
    if (touched.size !== 1 || partial) {
      ambiguous = true;
      continue;
    }
    const [rowIndex, entry] = [...touched.entries()][0];
    const row = rows[rowIndex];
    const indexes = entry.contained;
    const contiguous = indexes.length > 0
      && indexes[indexes.length - 1] - indexes[0] + 1 === indexes.length;
    // A heading or list line is rewritten structurally by renderLine, so a
    // link landing there cannot be spliced and must be reported, not dropped.
    if (!contiguous
      || excludedLineIds.has(row.line.id)
      || !offsetsByLine.has(row.line.id)) {
      ambiguous = true;
      continue;
    }
    // renderLine emits line.text.trim(), so a line carrying leading or
    // trailing content cannot be spliced without changing structure depending
    // on whether a link happened to resolve. A label containing LF or CR would
    // also break the inline-link grammar. Both fail closed.
    const offsets = offsetsByLine.get(row.line.id);
    const label = row.line.text.slice(
      offsets[indexes[0]].start,
      offsets[indexes[indexes.length - 1]].end,
    );
    if (row.line.text !== row.line.text.trim() || /[\r\n]/u.test(label)) {
      ambiguous = true;
      continue;
    }
    candidates.push({
      link,
      lineId: row.line.id,
      start: indexes[0],
      end: indexes[indexes.length - 1],
      url: link.url,
    });
  }

  // Drop any candidate whose items are also touched by a different annotation.
  const kept = candidates.filter(candidate => !footprints.some(other => (
    other.link !== candidate.link
    && other.lineId === candidate.lineId
    && other.start <= candidate.end
    && candidate.start <= other.end
  )));
  if (kept.length !== candidates.length) ambiguous = true;

  for (const span of kept) {
    if (!spansByLine.has(span.lineId)) spansByLine.set(span.lineId, []);
    spansByLine.get(span.lineId).push(span);
  }
  for (const spans of spansByLine.values()) {
    spans.sort((left, right) => left.start - right.start);
  }
  return { spansByLine, offsetsByLine, ambiguous, unsupportedTarget };
}

/**
 * Splice links into the line's exact source text. Text outside a link is taken
 * verbatim from line.text, so spacing, punctuation, and scripts without word
 * separators are preserved.
 */
function renderLinkedLine(line, offsets, spans) {
  let cursor = 0;
  let rendered = "";
  for (const span of spans) {
    const from = offsets[span.start].start;
    const to = offsets[span.end].end;
    if (from < cursor) return null;
    rendered += escapePlainMarkdown(line.text.slice(cursor, from));
    rendered += `[${escapePlainMarkdown(line.text.slice(from, to))}](${encodeLinkDestination(span.url)})`;
    cursor = to;
  }
  return rendered + escapePlainMarkdown(line.text.slice(cursor));
}

function itemStartX(item) {
  if (item.bbox && Number.isFinite(item.bbox.x)) return item.bbox.x;
  return Number.isFinite(item.x) ? item.x : NaN;
}

function lineCells(line, itemById) {
  return line.item_ids
    .map(id => itemById.get(id))
    .filter(item => item
      && item.is_whitespace !== true
      && typeof item.text === "string"
      && item.text.trim().length > 0
      && Number.isFinite(itemStartX(item)));
}

function isCollapsedWhitespaceRecovery(item) {
  return item.glyph_recoveries?.some(
    recovery => recovery.binding_kind === "collapsed_whitespace_item",
  ) === true;
}

function tableStructureCells(row) {
  return row.cells.filter(item => !isCollapsedWhitespaceRecovery(item));
}

const COMPACT_MATH_PUNCTUATION = /^[()[\]{},.;:+\-*/=∞∑∫]+$/u;

function compactMathItemText(value) {
  const text = String(value).trim();
  return text === "log"
    || /^\p{L}$/u.test(text)
    || /^\p{N}$/u.test(text)
    || COMPACT_MATH_PUNCTUATION.test(text);
}

function sameMathBaseline(left, right) {
  const leftHeight = left.line_height;
  const rightHeight = right.line_height;
  return Number.isFinite(left.y)
    && Number.isFinite(right.y)
    && Number.isFinite(leftHeight)
    && Number.isFinite(rightHeight)
    && leftHeight > 0
    && rightHeight > 0
    && Math.abs(left.y - right.y) <= Math.max(leftHeight, rightHeight) * 0.1;
}

function operatorVariableGap(left, right) {
  const leftX = itemStartX(left);
  const rightX = itemStartX(right);
  const leftWidth = left.bbox && Number.isFinite(left.bbox.width) ? left.bbox.width : left.width;
  if (!Number.isFinite(leftX) || !Number.isFinite(rightX) || !Number.isFinite(leftWidth)) return null;
  return rightX - (leftX + leftWidth);
}

function hasAttachedSmallerOffsetScript(cells, variableIndex) {
  const variable = cells[variableIndex];
  const script = cells[variableIndex + 1];
  if (!variable || !script
    || !/^\p{L}$/u.test(variable.text.trim())
    || !/^[\p{L}\p{N}]+$/u.test(script.text.trim())
    || !Number.isFinite(variable.line_height)
    || !Number.isFinite(script.line_height)
    || !Number.isFinite(variable.y)
    || !Number.isFinite(script.y)) return false;
  const gap = operatorVariableGap(variable, script);
  return script.line_height <= variable.line_height * 0.8
    && Math.abs(script.y - variable.y) >= variable.line_height * 0.2
    && gap !== null
    && gap >= -variable.line_height * 0.05
    && gap <= variable.line_height * 0.25;
}

/**
 * The characters that have a genuine Unicode superscript form. This map is the
 * safety mechanism of the script projection, not a style choice: a raised
 * token is transcribed only when every one of its characters can be written as
 * a real superscript character, so an arrow, a word, or a multi-letter marker
 * has no form here and is left exactly as the source emitted it. Nothing is
 * ever synthesized from a modifier, a combining mark, or markup.
 *
 * Every key and every value is exactly one UTF-16 code unit. That invariant is
 * load-bearing: it makes the projection length-preserving, so item offsets
 * recovered against the original line text stay valid after rewriting.
 */
const SUPERSCRIPT_FORMS = new Map(Object.entries({
  0: "⁰",
  1: "¹",
  2: "²",
  3: "³",
  4: "⁴",
  5: "⁵",
  6: "⁶",
  7: "⁷",
  8: "⁸",
  9: "⁹",
  "+": "⁺",
  "-": "⁻",
  "−": "⁻",
  "=": "⁼",
  "(": "⁽",
  ")": "⁾",
  n: "ⁿ",
  i: "ⁱ",
}));

/**
 * The characters that have a genuine Unicode subscript form, under exactly the
 * same whole-run discipline as the superscript map above and with the same
 * one-code-unit invariant.
 *
 * Coverage here is materially thinner, and the holes are the interesting part.
 * Unicode encodes no subscript capital at all, and among lowercase letters only
 * a e h i j k l m n o p r s t u v x exist: there is no b, c, d, f, g, q, w, y or
 * z. The whole-run rule turns every hole into an abstention rather than an
 * invention, which is the only honest option available. A source item whose
 * text carries an interior space is left flat for the same reason, because a
 * lowered space is not a character this map can write and dropping it would
 * change what the page says.
 */
const SUBSCRIPT_FORMS = new Map(Object.entries({
  0: "₀",
  1: "₁",
  2: "₂",
  3: "₃",
  4: "₄",
  5: "₅",
  6: "₆",
  7: "₇",
  8: "₈",
  9: "₉",
  "+": "₊",
  "-": "₋",
  "−": "₋",
  "=": "₌",
  "(": "₍",
  ")": "₎",
  a: "ₐ",
  e: "ₑ",
  h: "ₕ",
  i: "ᵢ",
  j: "ⱼ",
  k: "ₖ",
  l: "ₗ",
  m: "ₘ",
  n: "ₙ",
  o: "ₒ",
  p: "ₚ",
  r: "ᵣ",
  s: "ₛ",
  t: "ₜ",
  u: "ᵤ",
  v: "ᵥ",
  x: "ₓ",
}));

// Smaller-glyph script geometry, measured across the pinned legacy TeX corpus.
// Script size sits near 0.74 of its base, and its baseline is displaced from
// the base's by roughly a third of the base height: raised for a superscript,
// lowered for a subscript. The size window is shared, and each direction's
// displacement window is widened around its own observations rather than
// fitted to one document. A subscript's drop is the more variable of the two
// because the source scales it against the enclosing formula rather than
// against the base item, so the observed band runs from an ordinary variable
// index to the deeper drop a mathematical operator takes.
//
// The horizontal window is the one that carries real discriminating work, and
// it is narrow on purpose. An attached script is set inside its base's advance
// box or immediately after it, so only a kern separates them. A stacked
// fraction numerator is raised by the same amount at the same size, but it is
// centered over a rule wider than itself, so it starts a visible distance after
// whatever precedes it. Allowing a gap of up to a word space would transcribe
// those numerators as superscripts, which is not what the page shows.
//
// The two ceilings differ, and the asymmetry is load-bearing rather than
// sloppy. The numerator is the pressure on the raised window, and there is no
// lowered counterpart to it: a denominator does not reach this rule at all. The
// reason is not the one it looks like. A denominator is not preceded on its own
// source line by the numerator it hangs under, so the two are never compared;
// of the fraction bars on the corpus that carry text on both sides, all but
// four have a denominator that is the first painted item on its line, which
// this rule never examines because it only ever judges an item against the one
// before it. In each of the four remaining cases the item beneath the bar is
// prose or a full-size symbol rather than a small denominator digit, it is
// level with its predecessor rather than below it, and it is the same size as
// its predecessor, so the height window rejects it before the gap is consulted
// and the rise window would reject it independently. So the lowered ceiling is
// free to sit where the source actually needs it. It needs to be past 0.10: an
// italic descender is kerned out further than an upright digit, and the
// corpus's attached lowered runs reach 0.12 before they stop. The next lowered
// candidate of any kind is at 0.67, where the base is punctuation or a whole
// word rather than a symbol, so 0.15 sits inside a wide empty band and admits
// nothing the source did not set attached.
const SCRIPT_HEIGHT_RATIO_MIN = 0.6;
const SCRIPT_HEIGHT_RATIO_MAX = 0.82;
const SUPERSCRIPT_BASELINE_RISE_MIN = 0.28;
const SUPERSCRIPT_BASELINE_RISE_MAX = 0.45;
const SUBSCRIPT_BASELINE_RISE_MIN = -0.35;
const SUBSCRIPT_BASELINE_RISE_MAX = -0.1;
const SUPERSCRIPT_GAP_MIN = -0.1;
const SUPERSCRIPT_GAP_MAX = 0.1;
const SUBSCRIPT_GAP_MIN = -0.1;
const SUBSCRIPT_GAP_MAX = 0.15;
// Deliberately much wider than the attachment windows above, and used only to
// keep scanning a displaced run for a reason to abstain. Widening a window that
// can only suppress output is safe; widening one that admits it is not.
const SCRIPT_RUN_GAP_MIN = -0.35;
const SCRIPT_RUN_GAP_MAX = 0.6;
const SCRIPT_RUN_BASELINE_TOLERANCE = 0.1;

// The two directions a source may set an attached smaller run, each carrying
// its own displacement and attachment windows and its own alphabet. The signed
// rise windows do not overlap and do not contain zero, so at most one entry can
// describe any one pair of items.
const SCRIPT_KINDS = Object.freeze([
  Object.freeze({
    forms: SUPERSCRIPT_FORMS,
    riseMin: SUPERSCRIPT_BASELINE_RISE_MIN,
    riseMax: SUPERSCRIPT_BASELINE_RISE_MAX,
    gapMin: SUPERSCRIPT_GAP_MIN,
    gapMax: SUPERSCRIPT_GAP_MAX,
  }),
  Object.freeze({
    forms: SUBSCRIPT_FORMS,
    riseMin: SUBSCRIPT_BASELINE_RISE_MIN,
    riseMax: SUBSCRIPT_BASELINE_RISE_MAX,
    gapMin: SUBSCRIPT_GAP_MIN,
    gapMax: SUBSCRIPT_GAP_MAX,
  }),
]);

function scriptForm(kind, value) {
  if (typeof value !== "string" || value.length === 0) return null;
  let mapped = "";
  for (const character of value) {
    const form = kind.forms.get(character);
    if (form === undefined) return null;
    mapped += form;
  }
  return mapped;
}

/**
 * Recover an item's text baseline in viewport coordinates.
 *
 * The IR publishes an advance box whose anchor-top corner sits one ascent above
 * the baseline, plus the exact ascent ratio used to place it, so the baseline is
 * recoverable without re-deriving the transform. Only upright left-to-right runs
 * qualify: the quad's two top corners must share a y, and the bottom corners
 * must lie below them. For rotated or flipped text the ascent offset does not
 * lie along y at all, and this returns null rather than a wrong baseline.
 */
function uprightBaselineY(item) {
  const quad = item.quad;
  const ascentRatioValue = item.geometry_provenance?.ascent_ratio;
  if (item.geometry_valid !== true
    || item.direction !== "ltr"
    || !Array.isArray(quad)
    || quad.length !== 4
    || !Number.isFinite(item.line_height)
    || !Number.isFinite(ascentRatioValue)
    || !quad.every(point => Number.isFinite(point?.x) && Number.isFinite(point?.y))
    || quad[0].y !== quad[1].y
    || quad[2].y !== quad[3].y
    || !(quad[2].y > quad[0].y)
    || !(quad[1].x > quad[0].x)) return null;
  return quad[0].y + item.line_height * ascentRatioValue;
}

/**
 * Which direction, if either, the source painted `script` in as a smaller run
 * attached to `base`: script-sized, its baseline displaced by a script offset,
 * and set with no word gap. Returns the matching entry of SCRIPT_KINDS, or null
 * when the pair is not an attached script at all.
 *
 * This is a typographic observation and nothing more. The same raised geometry
 * carries a mathematical exponent and a footnote reference, and the page raises
 * both identically, so no geometric rule can separate them and this one does
 * not try. Deliberately not consulted: the base item's own text. Requiring the
 * base to end alphanumeric selects the footnote-marker population (a word
 * followed by a digit) and drops genuine raised runs whose base item follows an
 * operator or a comma.
 *
 * hasAttachedSmallerOffsetScript encodes a related but different observation
 * for the log-spacing projection: it takes the absolute vertical offset between
 * advance-box tops, so it cannot tell a raised glyph from a lowered one, and it
 * is deliberately left alone here. That question is "is a script attached
 * here at all", which either direction answers equally well; this one needs the
 * signed direction and the true baseline, because the direction chooses which
 * alphabet the run has to be written in.
 */
function attachedScriptKind(base, script) {
  const baseHeight = base?.line_height;
  const scriptHeight = script?.line_height;
  if (!Number.isFinite(baseHeight) || !Number.isFinite(scriptHeight) || !(baseHeight > 0)) return null;
  const baseBaseline = uprightBaselineY(base);
  const scriptBaseline = uprightBaselineY(script);
  if (baseBaseline === null || scriptBaseline === null) return null;
  const gap = operatorVariableGap(base, script);
  if (gap === null) return null;
  const ratio = scriptHeight / baseHeight;
  if (ratio < SCRIPT_HEIGHT_RATIO_MIN || ratio > SCRIPT_HEIGHT_RATIO_MAX) return null;
  const rise = (baseBaseline - scriptBaseline) / baseHeight;
  return SCRIPT_KINDS.find(candidate => rise >= candidate.riseMin
    && rise <= candidate.riseMax
    && gap >= candidate.gapMin * baseHeight
    && gap <= candidate.gapMax * baseHeight) ?? null;
}

/**
 * Whether `next` continues the displaced run that `script` started: painted on
 * the same displaced baseline and still attached. Used only to find the end of
 * a run so the whole run can be judged together.
 *
 * Deliberately no size condition, and deliberately no direction condition
 * either. A run's direction is fixed by the pair that opened it, and anything
 * sharing that run's baseline belongs to it whatever its own metrics say. A
 * recovered legacy glyph can report a font metric quite unlike its neighbours'
 * while sitting on exactly their baseline, and missing such a member would
 * leave the run looking complete when it is not. This test can only cause
 * abstention, so it is written to over-collect.
 */
function continuesScriptRun(script, next) {
  const height = script.line_height;
  if (!Number.isFinite(height) || !(height > 0)) return false;
  const scriptBaseline = uprightBaselineY(script);
  const nextBaseline = uprightBaselineY(next);
  if (scriptBaseline === null || nextBaseline === null) return false;
  const gap = operatorVariableGap(script, next);
  return gap !== null
    && Math.abs(nextBaseline - scriptBaseline) <= height * SCRIPT_RUN_BASELINE_TOLERANCE
    && gap >= SCRIPT_RUN_GAP_MIN * height
    && gap <= SCRIPT_RUN_GAP_MAX * height;
}

function paintedItems(page) {
  return page.raw_items.filter(item => item.is_whitespace !== true
    && typeof item.text === "string"
    && item.text.trim().length > 0);
}

/**
 * Plan the script projection for one line.
 *
 * `items` is that line's source items in the order the line records them, and
 * `pageItems` is every painted item on the page. Attachment is judged over the
 * non-whitespace ones, so a base and its script must be neighbours in the
 * painted run, and a base never reaches across an explicit space item to claim
 * a script.
 *
 * A displaced run is transcribed only in full, in the direction the pair that
 * opened it was set, and only when this line holds all of it. The source may
 * split one such run across several items and even across the IR's line
 * grouping, and transcribing the representable prefix would emit a displaced
 * opening parenthesis against a baseline closing one, which misreports the page
 * more badly than leaving the whole run flat. The run is therefore followed
 * across the whole page, which costs nothing in accuracy because a genuinely
 * line-final script has no attached same-baseline neighbour anywhere.
 *
 * Returns the per-item projected forms and, when the caller's item list can be
 * located inside `baseText`, that text rewritten. Because every projected
 * character replaces exactly one source code unit, the rewritten text has the
 * same length as `baseText` and any offsets the caller already holds against it
 * stay valid.
 *
 * `baseText` defaults to the line's own text and exists so a caller that has
 * already spaced the line can hand that text in instead. Locating the items is
 * a sequential scan for each item's exact text, so a projection that only
 * inserts separators between items leaves every item findable and in order; one
 * that rewrites item text or merges lines does not, and such a caller must not
 * pass its result here. Where the scan fails the line keeps its text unchanged
 * rather than being partly rewritten, which is why a line whose last source
 * item carries a trailing space the line text dropped stays flat.
 */
function scriptLineProjection(line, items, pageItems, baseText = line.text) {
  const attached = items.filter(item => item
    && item.is_whitespace !== true
    && typeof item.text === "string"
    && item.text.trim().length > 0);
  const lineItemIds = new Set(attached.map(item => item.id));
  const forms = new Map();
  for (let index = 1; index < attached.length; index += 1) {
    const kind = attachedScriptKind(attached[index - 1], attached[index]);
    if (kind === null) continue;
    const run = [];
    const claimed = new Set();
    for (let tail = attached[index]; tail !== null;) {
      run.push([tail, lineItemIds.has(tail.id) ? scriptForm(kind, tail.text) : null]);
      claimed.add(tail.id);
      tail = pageItems.find(
        item => !claimed.has(item.id) && continuesScriptRun(tail, item),
      ) ?? null;
    }
    while (index + 1 < attached.length && claimed.has(attached[index + 1].id)) index += 1;
    if (run.some(([, form]) => form === null)) continue;
    for (const [item, form] of run) forms.set(item.id, form);
  }
  if (forms.size === 0) return { forms, text: null };
  const offsets = itemOffsets({ text: baseText }, items);
  if (offsets === null) return { forms, text: null };
  let text = baseText;
  items.forEach((item, index) => {
    const form = forms.get(item.id);
    if (form === undefined) return;
    text = `${text.slice(0, offsets[index].start)}${form}${text.slice(offsets[index].end)}`;
  });
  return { forms, text: text === baseText ? null : text };
}

function projectedItemText(forms, item) {
  return forms.get(item.id) ?? item.text;
}

function rowHasSpecificMathOperator(row) {
  return row.cells.some(item => /^(?:Lim|Max|Min|[∑∫∞])$/u.test(item.text.trim()));
}

function nearbyEquationEvidence(rows, rowIndex) {
  const row = rows[rowIndex];
  const start = Math.max(0, rowIndex - 4);
  const end = Math.min(rows.length - 1, rowIndex + 4);
  for (let index = start; index <= end; index += 1) {
    if (index === rowIndex) continue;
    const candidate = rows[index];
    if (candidate.line.column_index !== row.line.column_index
      || candidate.line.direction !== "ltr"
      || candidate.line.text.length > 80
      || !rowHasSpecificMathOperator(candidate)) continue;
    const verticalDistance = Math.abs(candidate.line.y - row.line.y);
    const height = Math.max(candidate.line.height, row.line.height);
    const horizontalGap = Math.max(
      candidate.line.x - (row.line.x + row.line.width),
      row.line.x - (candidate.line.x + candidate.line.width),
      0,
    );
    if (verticalDistance <= height * 2.5 && horizontalGap <= height * 2) return true;
  }
  return false;
}

function hasIndependentMathLayoutEvidence(row, operatorIndex, rows, rowIndex) {
  return hasAttachedSmallerOffsetScript(row.cells, operatorIndex + 1)
    || rowHasSpecificMathOperator(row)
    || (row.cells.some(item => /^[()]$/u.test(item.text.trim()))
      && nearbyEquationEvidence(rows, rowIndex));
}

/**
 * MATH_NOT_RECONSTRUCTED evidence.
 *
 * The renderer never reconstructs mathematics: an equation reaches the Markdown
 * as the source's own reading-order text, which the `## Conversion limitations`
 * section has always said in prose. This rule adds nothing to that behaviour.
 * It only decides, per page, whether the renderer can *prove* from source
 * evidence that mathematical content was on the page, so a consumer can route
 * those pages rather than re-read a global paragraph. A page that cannot be
 * proven mathematical emits nothing: a missing declaration is preferable to a
 * fabricated one.
 *
 * A page qualifies when at least one line the renderer emitted as flat
 * reading-order text carries either a source-symbol proof or all three compact
 * run conditions below.
 *
 *   M1 — merged source-symbol proof. A source item on a short left-to-right
 *        line contains both an alphanumeric character and an unambiguous
 *        mathematical glyph (`∑`, `∫`, `∞`, `∂`, `∇`, `≈`, `≠`, `∈`,
 *        `∉`, `⊂`, `⊃`, `⊆`, `⊇`, `⊗`, or `⊕`). The proof is taken from the
 *        exact retained source item, not inferred from a score over the line.
 *        A lone glyph is not enough on this route; the existing structural-run
 *        route below still handles a separately painted operator.
 *   M2 — merged named-operator proof. One short source item consists only of
 *        math-run characters and contains a literal `log`, `lim`, `max`,
 *        `min`, `sum`, or `infinity`, an equals sign, and a separate
 *        single-letter variable. Only `lim` and `infinity` stand alone; the
 *        other names require function parentheses. Thus `lim x=0` and
 *        `max(x)=5` are source evidence, while `max=5`, `max x=5`, `int x=5`,
 *        `maximum(x)=5`, and `PATH=/tmp` remain ambiguous and do not qualify.
 *
 *   S1 — run shape. The line is upright left-to-right, at most
 *        MATH_RUN_MAX_LINE_CHARACTERS long, holds at least two structural
 *        source items, and *every* one of them is a compact math token
 *        (`compactMathItemText`: one letter, one digit, math punctuation, or
 *        the operator `log`) or a named operator word. Named operators are
 *        matched case-insensitively because mathematical papers commonly use
 *        lowercase `lim`, `max`, and `min`. This is the same "short
 *        compact left-to-right math run" shape the bounded `log`-spacing repair
 *        already uses to recognise a nearby equation, reused verbatim rather
 *        than reinvented.
 *   S2 — an independent mathematical marker on that same line: either an
 *        unambiguous mathematical glyph (`∑`, `∫`, or `∞`), or a relation `=`
 *        in a run of at least three items that switches source font resource
 *        across an adjacent same-baseline pair including a single letter — the
 *        roman-operator / italic-variable alternation that mathematical
 *        typesetting produces and running prose does not.
 *   S3 — the line really was left flat: it is not inside a reconstructed table
 *        segment, and the stacked-fraction projection neither consumed nor
 *        rewrote it. Where a construct *was* reconstructed, nothing is claimed
 *        lost.
 *
 * S1 alone is not enough, which is the whole point of the conjunction: a line
 * of single-character items can be a column of initials or a run of separated
 * digits. The words `Lim`, `Max`, and `Min` are admitted by S1 so a relation
 * can corroborate them, but they are not S2 evidence by themselves: `Max 5`
 * may be prose, a header, or a label. A mathematical symbol or the independent
 * relation-plus-font evidence is required rather than fabricating a loss
 * declaration from an ambiguous word. M1 and M2 close the source-item
 * segmentation hole without guessing equation topology or changing the
 * rendered body.
 *
 * Deliberately rejected as triggers:
 *
 *   - `√` on the merged-symbol route. Real PDF tables also use this character
 *     as a checkmark, so source text such as `A2 ≥ 80% √` is not sufficient
 *     evidence of mathematics without another admitted route.
 *   - A raised or lowered run on its own. The renderer's own limitation prose
 *     states that a page sets a mathematical exponent and a footnote reference
 *     identically, so a raised run cannot distinguish the two and would emit
 *     this gap over every footnoted page.
 *   - `glyph_recoveries` / legacy Computer-Modern Type-3 evidence on its own.
 *     A recovery record marks a glyph the version-pinned registry *did*
 *     recover, so it evidences a repair rather than a loss, and the same
 *     Computer Modern families also set accents and symbols in ordinary prose.
 *     It proves neither that content was mathematical nor that anything was
 *     dropped.
 *   - `text_integrity.status === "suspect"` on its own. Damaged text is not
 *     mathematics, and it already has its own typed gap
 *     (TEXT_INTEGRITY_SUSPECT) which this one must not duplicate or weaken.
 *   - Character-class scoring over the rendered line text ("this looks mathy").
 *     That is a heuristic guess, not source evidence, and would put a numeric
 *     judgement where this vocabulary allows none. The merged-item routes use
 *     exact, enumerated source characters and a finite grammar instead.
 */
const NAMED_MATH_OPERATOR = /^(?:log|lim|max|min|sum|int|infinity)$/iu;
const MERGED_NAMED_MATH_OPERATOR = /(?:^|[^\p{L}])(log|lim|max|min|sum|infinity)(?=$|[^\p{L}])/iu;
const SOURCE_MATH_SYMBOL = /[∑∫∞∂∇≈≠∈∉⊂⊃⊆⊇⊗⊕]/u;
const MERGED_MATH_CHARACTERS = /^[\p{L}\p{M}\p{N}\s()[\]{},.;:+\-*/=^_]+$/u;
const MATH_RUN_MAX_LINE_CHARACTERS = 80;
const MATH_RUN_MIN_ITEMS = 2;
const MATH_RELATION_MIN_ITEMS = 3;

function isMathRunItemText(value) {
  const text = String(value).trim();
  return compactMathItemText(text) || NAMED_MATH_OPERATOR.test(text);
}

function mathRunStructuralItems(row) {
  return row.cells.filter(item => !isCollapsedWhitespaceRecovery(item)
    && typeof item.text === "string"
    && item.text.trim().length > 0);
}

function hasCrossFontRelationEvidence(items) {
  if (items.length < MATH_RELATION_MIN_ITEMS) return false;
  if (!items.some(item => item.text.trim() === "=")) return false;
  for (let index = 0; index < items.length - 1; index += 1) {
    const left = items[index];
    const right = items[index + 1];
    if (typeof left.font_name !== "string" || typeof right.font_name !== "string"
      || left.font_name === right.font_name) continue;
    if (!/^\p{L}$/u.test(left.text.trim()) && !/^\p{L}$/u.test(right.text.trim())) continue;
    if (sameMathBaseline(left, right)) return true;
  }
  return false;
}

function hasMergedSourceMathSymbol(items) {
  return items.some(item => {
    const text = item.text.trim();
    return text.length <= MATH_RUN_MAX_LINE_CHARACTERS
      && SOURCE_MATH_SYMBOL.test(text)
      && /[\p{L}\p{N}]/u.test(text);
  });
}

function isMergedNamedOperatorEquation(value) {
  const text = String(value).trim();
  const operatorMatch = MERGED_NAMED_MATH_OPERATOR.exec(text);
  if (text.length < 3 || text.length > MATH_RUN_MAX_LINE_CHARACTERS
    || !text.includes("=")
    || operatorMatch === null
    || !MERGED_MATH_CHARACTERS.test(text)) return false;
  const words = text.match(/\p{L}+/gu) ?? [];
  const operator = operatorMatch[1].toLowerCase();
  const operatorHasFunctionShape = operator === "lim" || operator === "infinity"
    || new RegExp(`(?:^|[^\\p{L}])${operator}\\s*\\(`, "iu").test(text);
  return operatorHasFunctionShape
    && words.some(word => /^\p{L}$/u.test(word))
    && words.every(word => /^\p{L}$/u.test(word) || NAMED_MATH_OPERATOR.test(word));
}

function hasMergedNamedOperatorEquation(items) {
  return items.some(item => isMergedNamedOperatorEquation(item.text));
}

function rowHasSymbolicMathOperator(row) {
  return row.cells.some(item => /^[∑∫∞]$/u.test(item.text.trim()));
}

function isUnreconstructedMathRow(row) {
  const { line } = row;
  if (line.direction !== "ltr" || line.text.length > MATH_RUN_MAX_LINE_CHARACTERS) return false;
  const items = mathRunStructuralItems(row);
  if (items.length === 0 || items.some(item => containsUnsafeText(item.text))) return false;
  if (hasMergedSourceMathSymbol(items) || hasMergedNamedOperatorEquation(items)) return true;
  if (items.length < MATH_RUN_MIN_ITEMS
    || !items.every(item => isMathRunItemText(item.text))
  ) return false;
  return rowHasSymbolicMathOperator(row) || hasCrossFontRelationEvidence(items);
}

function pageMathNotReconstructed(analysis, fractionPlan) {
  return analysis.segments.some(segment => segment.kind !== "table"
    && segment.rows.some(row => !fractionPlan.skipped.has(row.line.id)
      && !fractionPlan.replacements.has(row.line.id)
      && isUnreconstructedMathRow(row)));
}

/**
 * Restore one visible operator boundary that the layout IR can prove without
 * interpreting equation topology. PDF.js may expose roman "log" and its
 * following italic variable as separate same-baseline items whose positive
 * gap is smaller than the general prose-spacing threshold. This projection is
 * intentionally much narrower than lowering that threshold for every line.
 */
function mathOperatorSpacedText(row, {
  headingLevel,
  linked,
  rows,
  rowIndex,
  unsafePage,
}) {
  const { line, cells } = row;
  if (headingLevel || linked || unsafePage || rewritesLineStructure(line)
    || line.direction !== "ltr" || line.text.length > 80
    || cells.length < 2 || cells.length > 16
    || cells.some(item => !compactMathItemText(item.text) || containsUnsafeText(item.text))) return null;
  const offsets = itemOffsets(line, cells);
  if (offsets === null) return null;
  const insertions = [];
  for (let index = 0; index < cells.length - 1; index += 1) {
    const operator = cells[index];
    const variable = cells[index + 1];
    if (operator.text.trim() !== "log"
      || !/^\p{L}$/u.test(variable.text.trim())
      || operator.font_name === null
      || variable.font_name === null
      || operator.font_name === variable.font_name
      || !sameMathBaseline(operator, variable)
      || !hasIndependentMathLayoutEvidence(row, index, rows, rowIndex)) continue;
    const gap = operatorVariableGap(operator, variable);
    const height = Math.max(operator.line_height, variable.line_height);
    if (!(gap > height * 0.05 && gap <= height * 0.25)) continue;
    const from = offsets[index].end;
    const to = offsets[index + 1].start;
    if (from !== to || /\s/u.test(line.text.slice(from, to))) continue;
    insertions.push(from);
  }
  if (insertions.length === 0) return null;
  let text = line.text;
  for (const offset of insertions.sort((left, right) => right - left)) {
    text = `${text.slice(0, offset)} ${text.slice(offset)}`;
  }
  return text;
}

/**
 * Restore a prose-to-variable boundary only when three separate source items
 * prove the intended transition: multiword prose, one uppercase math-font
 * variable, and continuing prose in the original font. Requiring both a
 * smaller first gap and an already preserved second space avoids lowering the
 * general line-grouping threshold or interpreting compact identifiers.
 */
function proseMathVariableSpacedText(row, {
  headingLevel,
  linked,
  rows,
  rowIndex,
  unsafePage,
}) {
  const { line, cells } = row;
  if (headingLevel || linked || unsafePage || rewritesLineStructure(line)
    || line.direction !== "ltr" || line.text.length > 160 || cells.length < 3) return null;
  const offsets = itemOffsets(line, cells);
  if (offsets === null) return null;
  const insertions = [];
  for (let index = 0; index < cells.length - 2; index += 1) {
    const prose = cells[index];
    const variable = cells[index + 1];
    const continuation = cells[index + 2];
    const proseWords = prose.text.trim().split(/\s+/u);
    const continuationWords = continuation.text.trim().split(/\s+/u);
    if (proseWords.length < 3 || continuationWords.length < 3
      || !/\p{Ll}{4,}$/u.test(prose.text.trim())
      || !/^\p{Lu}$/u.test(variable.text.trim())
      || !/^\p{Ll}/u.test(continuation.text.trim())
      || typeof prose.font_name !== "string"
      || typeof variable.font_name !== "string"
      || typeof continuation.font_name !== "string"
      || prose.font_name !== continuation.font_name
      || prose.font_name === variable.font_name
      || !sameMathBaseline(prose, variable)
      || !sameMathBaseline(variable, continuation)
      || !hasNearbyMathVariableEvidence(row, variable, rows, rowIndex)) continue;
    const gap = operatorVariableGap(prose, variable);
    const continuationGap = operatorVariableGap(variable, continuation);
    const height = Math.max(prose.line_height, variable.line_height, continuation.line_height);
    if (!(gap > height * 0.15 && gap <= height * 0.25)
      || !(continuationGap > gap && continuationGap <= height * 0.5)) continue;
    const from = offsets[index].end;
    const to = offsets[index + 1].start;
    const after = line.text.slice(offsets[index + 1].end, offsets[index + 2].start);
    if (from !== to || /\s/u.test(line.text.slice(from, to)) || !/^\s+$/u.test(after)) continue;
    insertions.push(from);
  }
  if (insertions.length === 0) return null;
  let text = line.text;
  for (const offset of insertions.sort((left, right) => right - left)) {
    text = `${text.slice(0, offset)} ${text.slice(offset)}`;
  }
  return text;
}

function hasNearbyMathVariableEvidence(row, variable, rows, rowIndex) {
  const start = Math.max(0, rowIndex - 3);
  const end = Math.min(rows.length - 1, rowIndex + 3);
  for (let index = start; index <= end; index += 1) {
    if (index === rowIndex) continue;
    const candidate = rows[index];
    if (candidate.line.column_index !== row.line.column_index
      || candidate.line.direction !== "ltr"
      || candidate.line.text.length > 80
      || !candidate.cells.every(item => (compactMathItemText(item.text)
        || /^(?:Lim|Max|Min)$/u.test(item.text.trim()))
        && !containsUnsafeText(item.text))
      || !candidate.cells.some(item => item.text.trim() === variable.text.trim()
        && item.font_name === variable.font_name)
      || !candidate.cells.some(item => item.text.trim() === "=")
      || containsUnsafeText(candidate.line.text)) continue;
    const verticalDistance = Math.abs(candidate.line.y - row.line.y);
    const height = Math.max(candidate.line.height, row.line.height);
    if (verticalDistance <= height * 4) return true;
  }
  return false;
}

function alignedFractionBar(page, numerator, denominator) {
  const evidence = page.painted_rectangles;
  if (evidence?.status !== "available" || evidence.truncated === true) return null;
  const tolerance = numerator.line_height * 0.05;
  const matches = (evidence.items ?? []).filter(item => {
    const box = item.bbox;
    const transform = item.graphics_transform;
    return item.source_kind === "solid_color_image_mask"
      && box
      && Array.isArray(transform)
      && transform.length === 6
      && transform.every(Number.isFinite)
      && transform[0] > 0
      && transform[3] < 0
      && Math.abs(transform[1]) <= 1e-6
      && Math.abs(transform[2]) <= 1e-6
      && box.height > 0
      && box.height <= numerator.line_height * 0.1
      && Math.abs(box.x - numerator.x) <= tolerance
      && Math.abs(box.width - numerator.width) <= tolerance
      && Math.abs((box.x + box.width / 2) - (numerator.x + numerator.width / 2)) <= tolerance
      && Math.abs((box.x + box.width / 2) - (denominator.x + denominator.width / 2)) <= tolerance
      && box.y <= numerator.y + numerator.height + tolerance
      && box.y + box.height >= denominator.y - tolerance;
  });
  return matches.length === 1 ? matches[0] : null;
}

function axisAlignedTextItem(item) {
  const transform = item.raw_transform;
  return Array.isArray(transform) && transform.length === 6
    && transform.every(Number.isFinite)
    && transform[0] > 0 && transform[3] > 0
    && Math.abs(transform[1]) <= 1e-6
    && Math.abs(transform[2]) <= 1e-6;
}

function exactFractionSourceSequence(page, prose, numerator, denominator, continuation) {
  const byIndex = new Map(page.raw_items.map(item => [item.source_index, item]));
  const before = byIndex.get(prose.source_index + 1);
  const after = byIndex.get(denominator.source_index + 1);
  return numerator.source_index === prose.source_index + 2
    && denominator.source_index === numerator.source_index + 1
    && continuation.source_index === denominator.source_index + 2
    && before?.text_kind === "whitespace"
    && after?.text_kind === "whitespace"
    && /^\s+$/u.test(before.text)
    && /^\s+$/u.test(after.text)
    && before.font_name === prose.font_name
    && after.font_name === denominator.font_name;
}

/**
 * Interpret only a single-digit stacked fraction whose exact source geometry
 * includes a matching solid-mask bar and whose three rows form one ordinary
 * prose sentence. Other stacked scripts and fraction-like layouts remain in
 * source reading order.
 */
function simpleStackedFractionPlan(page, rows, {
  headings,
  linkState,
  unsafePage,
}) {
  const replacements = new Map();
  const skipped = new Set();
  if (unsafePage) return { replacements, skipped };
  for (let index = 0; index < rows.length - 2; index += 1) {
    const host = rows[index];
    const denominatorRow = rows[index + 1];
    const continuation = rows[index + 2];
    const numerator = host.cells.at(-1);
    const prose = host.cells.at(-2);
    const denominator = denominatorRow.cells[0];
    const continuationItem = continuation.cells[0];
    if (host.cells.length !== 2 || denominatorRow.cells.length !== 1
      || continuation.cells.length !== 1 || !numerator || !prose || !denominator
      || !continuationItem || headings.get(host.line.id)
      || headings.get(denominatorRow.line.id) || headings.get(continuation.line.id)
      || linkState.spansByLine.get(host.line.id)?.length
      || linkState.spansByLine.get(denominatorRow.line.id)?.length
      || linkState.spansByLine.get(continuation.line.id)?.length
      || [host.line, denominatorRow.line, continuation.line]
        .some(line => line.direction !== "ltr" || rewritesLineStructure(line)
          || containsUnsafeText(line.text))
      || host.line.column_index !== denominatorRow.line.column_index
      || host.line.column_index !== continuation.line.column_index
      || !/\d$/u.test(prose.text.trim())
      || (prose.text.trim().match(/[\p{L}\p{N}]+/gu)?.length ?? 0) < 5
      || !/^\p{Ll}/u.test(continuationItem.text.trim())
      || (continuationItem.text.trim().match(/[\p{L}\p{N}]+/gu)?.length ?? 0) < 5
      || !/^\d$/u.test(numerator.text.trim())
      || !/^\d$/u.test(denominator.text.trim())
      || typeof prose.font_name !== "string"
      || prose.font_name !== numerator.font_name
      || prose.font_name !== denominator.font_name
      || prose.font_name !== continuationItem.font_name
      || ![prose, numerator, denominator, continuationItem].every(axisAlignedTextItem)
      || !exactFractionSourceSequence(page, prose, numerator, denominator, continuationItem)) continue;
    const proseHeight = Math.max(prose.line_height, continuationItem.line_height);
    const digitHeight = Math.max(numerator.line_height, denominator.line_height);
    const leftGap = numerator.x - (prose.x + prose.width);
    const rightGap = continuationItem.x - (numerator.x + numerator.width);
    if (!(digitHeight >= proseHeight * 0.65 && digitHeight <= proseHeight * 0.8)
      || Math.abs(numerator.x - denominator.x) > digitHeight * 0.05
      || Math.abs(numerator.width - denominator.width) > digitHeight * 0.05
      || Math.abs(numerator.line_height - denominator.line_height) > digitHeight * 0.05
      || Math.abs(prose.line_height - continuationItem.line_height) > proseHeight * 0.05
      || !(numerator.y < prose.y && denominator.y > prose.y)
      || Math.abs(prose.y - continuationItem.y) > proseHeight * 0.05
      || !(leftGap > 0 && leftGap <= proseHeight * 0.2)
      || !(rightGap > proseHeight * 0.25 && rightGap <= proseHeight * 0.6)
      || alignedFractionBar(page, numerator, denominator) === null) continue;
    const offsets = itemOffsets(host.line, host.cells);
    const numeratorOffset = offsets?.at(-1);
    if (!numeratorOffset || numeratorOffset.start !== numeratorOffset.end - 1
      || numeratorOffset.end !== host.line.text.length
      || /\s/u.test(host.line.text.slice(offsets.at(-2).end, numeratorOffset.start))) continue;
    replacements.set(
      host.line.id,
      `${host.line.text.slice(0, numeratorOffset.start)} ${numerator.text.trim()}/${denominator.text.trim()} ${continuation.line.text.trim()}`,
    );
    skipped.add(denominatorRow.line.id);
    skipped.add(continuation.line.id);
    index += 2;
  }
  return { replacements, skipped };
}

function pageStackedFractionPlan(page, segments, options) {
  const replacements = new Map();
  const skipped = new Set();
  let contiguousTextRows = [];
  const flush = () => {
    const plan = simpleStackedFractionPlan(page, contiguousTextRows, options);
    for (const [lineId, text] of plan.replacements) replacements.set(lineId, text);
    for (const lineId of plan.skipped) skipped.add(lineId);
    contiguousTextRows = [];
  };
  for (const segment of segments) {
    if (segment.kind === "table") flush();
    else contiguousTextRows.push(...segment.rows);
  }
  flush();
  return { replacements, skipped };
}

function columnAnchors(rows) {
  const xs = rows
    .flatMap(row => row.cells.map(itemStartX))
    .sort((left, right) => left - right);
  const clusters = [];
  for (const x of xs) {
    const last = clusters[clusters.length - 1];
    if (last && x - last.anchor <= TABLE_COLUMN_TOLERANCE_POINTS) {
      last.values.push(x);
    } else {
      clusters.push({ anchor: x, values: [x] });
    }
  }
  return clusters.map(cluster => median(cluster.values));
}

function nearestAnchor(anchors, x) {
  let best = -1;
  for (let index = 0; index < anchors.length; index += 1) {
    const distance = Math.abs(anchors[index] - x);
    if (distance > TABLE_COLUMN_TOLERANCE_POINTS) continue;
    if (best === -1 || distance < Math.abs(anchors[best] - x)) best = index;
  }
  return best;
}

/**
 * Keep only anchors that recur down the run. A column that appears in a single
 * line is word placement, not table structure; requiring recurrence is what
 * stops ordinary prose from being read as a failed table.
 */
function columnarAnalysis(run) {
  const structuralRun = run.map(row => ({ ...row, cells: tableStructureCells(row) }));
  const anchors = columnAnchors(structuralRun);
  const rowsPerAnchor = anchors.map(() => new Set());
  structuralRun.forEach((row, rowIndex) => {
    for (const item of row.cells) {
      const index = nearestAnchor(anchors, itemStartX(item));
      if (index !== -1) rowsPerAnchor[index].add(rowIndex);
    }
  });
  const columnar = anchors.filter(
    (_anchor, index) => rowsPerAnchor[index].size >= TABLE_MIN_COLUMN_ROWS,
  );
  const totalCells = structuralRun.reduce((total, row) => total + row.cells.length, 0);
  const covered = structuralRun.reduce((total, row) => total + row.cells.filter(
    item => nearestAnchor(columnar, itemStartX(item)) !== -1,
  ).length, 0);
  const coverage = totalCells === 0 ? 0 : covered / totalCells;
  return {
    columnar,
    tableLike: columnar.length >= TABLE_MIN_COLUMNS
      && coverage >= TABLE_COLUMNAR_COVERAGE,
  };
}

function rowHeight(row) {
  const heights = row.cells.map(item => item.line_height).filter(Number.isFinite);
  return heights.length > 0 ? median(heights) : null;
}

/**
 * A GFM table necessarily promotes its first row to header semantics, so a
 * geometrically complete grid is not sufficient: emitting one without source
 * evidence would invent a header.
 *
 * Deliberately not evidence: a differing font_name. That field is a synthetic
 * per-document resource identity, and the same visible font subset or embedded
 * twice yields different ids, so a difference there does not imply any visible
 * distinction. Line height is the one stable visual metric this IR exposes.
 */
function hasHeaderEvidence(run) {
  const [header, ...body] = run;
  if (body.length === 0) return false;
  const headerHeight = rowHeight(header);
  const bodyHeights = body.map(rowHeight).filter(Number.isFinite);
  if (headerHeight === null || bodyHeights.length === 0) return false;
  const bodyHeight = median(bodyHeights);
  return bodyHeight > 0 && headerHeight >= bodyHeight * HEADER_HEIGHT_RATIO;
}

function assignRowToColumns(row, anchors, pageItems) {
  const assigned = new Map();
  // Emission only: column assignment and the newline rejection below both read
  // the raw source item, so the projection cannot move a cell or admit a run
  // this path would otherwise reject.
  const { forms } = scriptLineProjection(row.line, row.cells, pageItems);
  for (const item of row.cells) {
    const index = nearestAnchor(anchors, itemStartX(item));
    if (index === -1 || assigned.has(index)) return null;
    // A newline inside a cell would terminate the row and break the grid.
    // Such a run is not eligible for table emission.
    if (/[\r\n]/u.test(item.text.trim())) return null;
    assigned.set(index, projectedItemText(forms, item).trim());
  }
  if (assigned.size !== anchors.length) return null;
  return anchors.map((_anchor, index) => assigned.get(index));
}

function rectRight(rect) {
  return rect.x + rect.width;
}

function rectBottom(rect) {
  return rect.y + rect.height;
}

function rectsExactlyEqual(left, right) {
  return left.x === right.x
    && left.y === right.y
    && left.width === right.width
    && left.height === right.height
    && left.verb === right.verb;
}

function containsRect(outer, inner, tolerance = RECT_CONTAINMENT_TOLERANCE) {
  return outer.x <= inner.x + tolerance
    && outer.y <= inner.y + tolerance
    && rectRight(outer) >= rectRight(inner) - tolerance
    && rectBottom(outer) >= rectBottom(inner) - tolerance;
}

function preprocessRuledRects(page) {
  const evidence = page.ruled_rects;
  // A truncated page cannot distinguish a complete grid from one whose
  // omitted rects would change its topology. It is intentionally a hard
  // disable, not a partial table candidate.
  if (!evidence || evidence.status !== "available") return null;
  const sourceRects = evidence.items
    .map((rect, order) => ({ ...rect, order }))
    .filter(rect => rect.width > 0 && rect.height > 0);
  if (sourceRects.length === 0) return [];

  const medianWidth = median(sourceRects.map(rect => rect.width));
  const widthFiltered = sourceRects.filter(rect => rect.width <= medianWidth * 10);
  const unique = widthFiltered.filter((rect, index, all) => (
    all.findIndex(candidate => rectsExactlyEqual(candidate, rect)) === index
  ));
  const containedFiltered = unique.filter((inner, innerIndex, all) => {
    const innerArea = inner.width * inner.height;
    return !all.some((outer, outerIndex) => {
      if (outerIndex === innerIndex) return false;
      if (outer.x < 5 && outer.y < 5) return false;
      // Preserve cell rectangles underneath a one-row band until the grid
      // has been built. A body-row band is ambiguous and must be classified
      // as topology, not allowed to erase the evidence needed to classify it.
      if (Math.abs(outer.height - inner.height) <= RECT_CONTAINMENT_TOLERANCE
        && outer.width > inner.width + RECT_CONTAINMENT_TOLERANCE) return false;
      const outerArea = outer.width * outer.height;
      return outerArea > innerArea * 1.2
        && outer.height < inner.height * 4
        && containsRect(outer, inner);
    });
  });
  const medianHeight = median(containedFiltered.length > 0
    ? containedFiltered.map(rect => rect.height)
    : sourceRects.map(rect => rect.height));
  const filtered = containedFiltered
    .filter(rect => !(rect.x < 5 && rect.y < 5 && rect.height > medianHeight * 20))
    .sort((left, right) => left.order - right.order);
  return filtered.length > MAX_CLUSTER_RECTS ? null : filtered;
}

function intervalGap(firstStart, firstEnd, secondStart, secondEnd) {
  if (firstEnd < secondStart) return secondStart - firstEnd;
  if (secondEnd < firstStart) return firstStart - secondEnd;
  return 0;
}

function rectsAdjacent(left, right) {
  return intervalGap(left.x, rectRight(left), right.x, rectRight(right))
      <= RECT_CLUSTER_ADJACENCY_TOLERANCE
    && intervalGap(left.y, rectBottom(left), right.y, rectBottom(right))
      <= RECT_CLUSTER_ADJACENCY_TOLERANCE;
}

function clusterRuledRects(rects) {
  const parents = rects.map((_rect, index) => index);
  const find = index => {
    let root = index;
    while (parents[root] !== root) root = parents[root];
    while (parents[index] !== index) {
      const next = parents[index];
      parents[index] = root;
      index = next;
    }
    return root;
  };
  const union = (left, right) => {
    const leftRoot = find(left);
    const rightRoot = find(right);
    if (leftRoot !== rightRoot) parents[rightRoot] = leftRoot;
  };
  for (let left = 0; left < rects.length; left += 1) {
    for (let right = left + 1; right < rects.length; right += 1) {
      if (rectsAdjacent(rects[left], rects[right])) union(left, right);
    }
  }
  const membersByRoot = new Map();
  rects.forEach((_rect, index) => {
    const root = find(index);
    if (!membersByRoot.has(root)) membersByRoot.set(root, []);
    membersByRoot.get(root).push(index);
  });
  return [...membersByRoot.values()]
    .map(members => members.sort((left, right) => rects[left].order - rects[right].order))
    .sort((left, right) => rects[left[0]].order - rects[right[0]].order)
    .filter(members => members.length >= RECT_MIN_CLUSTER_RECTS)
    .map(members => members.map(index => rects[index]));
}

function snapEdges(values) {
  const sorted = [...values].sort((left, right) => left - right);
  const groups = [];
  for (const value of sorted) {
    const last = groups[groups.length - 1];
    if (last && value - last.values[last.values.length - 1] <= RECT_SNAP_TOLERANCE) {
      last.values.push(value);
    } else {
      groups.push({ values: [value] });
    }
  }
  return groups.map(group => median(group.values));
}

function coversInterval(rect, start, end, tolerance = RECT_SNAP_TOLERANCE) {
  return rect.x <= start + tolerance
    && rectRight(rect) >= end - tolerance;
}

function gridRectCoverage(rect, xEdges, yEdges, tolerance = RECT_SNAP_TOLERANCE) {
  const columns = [];
  const rows = [];
  for (let column = 0; column < xEdges.length - 1; column += 1) {
    if (coversInterval(rect, xEdges[column], xEdges[column + 1], tolerance)) columns.push(column);
  }
  for (let row = 0; row < yEdges.length - 1; row += 1) {
    if (rect.y <= yEdges[row] + tolerance
      && rectBottom(rect) >= yEdges[row + 1] - tolerance) rows.push(row);
  }
  return { columns, rows };
}

function rectEdgesMatchCell(rect, column, row, xEdges, yEdges) {
  return Math.abs(rect.x - xEdges[column]) <= RECT_SNAP_TOLERANCE
    && Math.abs(rectRight(rect) - xEdges[column + 1]) <= RECT_SNAP_TOLERANCE
    && Math.abs(rect.y - yEdges[row]) <= RECT_SNAP_TOLERANCE
    && Math.abs(rectBottom(rect) - yEdges[row + 1]) <= RECT_SNAP_TOLERANCE;
}

function boxesOverlap(left, right) {
  return Math.min(left.x + left.width, right.x + right.width) > Math.max(left.x, right.x)
    && Math.min(left.y + left.height, right.y + right.height) > Math.max(left.y, right.y);
}

function clusterBounds(cluster) {
  return {
    x: Math.min(...cluster.map(rect => rect.x)),
    y: Math.min(...cluster.map(rect => rect.y)),
    right: Math.max(...cluster.map(rect => rectRight(rect))),
    bottom: Math.max(...cluster.map(rect => rectBottom(rect))),
  };
}

function pointInsideCluster(item, bounds) {
  const box = itemBox(item);
  if (!box) return false;
  const centerX = box.x + box.width / 2;
  const centerY = box.y + box.height / 2;
  return centerX >= bounds.x && centerX <= bounds.right
    && centerY >= bounds.y && centerY <= bounds.bottom;
}

function hasFirstRowBandEvidence(bands) {
  const firstRow = bands.find(band => band.rows.length === 1 && band.rows[0] === 0);
  if (!firstRow) return false;
  return !bands.some(band => band !== firstRow
    && band.rows.length === 1
    && band.rows[0] > 0
    && Math.abs(band.rect.y - firstRow.rect.y) <= RECT_SNAP_TOLERANCE
    && Math.abs(rectBottom(band.rect) - rectBottom(firstRow.rect)) <= RECT_SNAP_TOLERANCE);
}

function tryBuildRectGrid(page, run, clusters, itemById) {
  const runLineIds = new Set(run.map(row => row.line.id));
  const candidates = [];
  for (const cluster of clusters) {
    if (cluster.length < RECT_MIN_CLUSTER_RECTS) continue;
    const bounds = clusterBounds(cluster);
    const lineRecords = page.lines.map(line => {
      const allItems = line.item_ids.map(id => itemById.get(id)).filter(Boolean);
      const insideItems = allItems.filter(item => pointInsideCluster(item, bounds));
      const nonWhitespace = allItems.filter(item => item.is_whitespace !== true
        && typeof item.text === "string" && item.text.trim().length > 0);
      const insideNonWhitespace = insideItems.filter(item => item.is_whitespace !== true
        && typeof item.text === "string" && item.text.trim().length > 0);
      const structuralInsideNonWhitespace = insideNonWhitespace.filter(item => !isCollapsedWhitespaceRecovery(item));
      if (structuralInsideNonWhitespace.length === 0) return null;
      return {
        line,
        allItems,
        items: insideItems,
        nonWhitespace,
        insideNonWhitespace,
        structuralInsideNonWhitespace,
      };
    }).filter(Boolean);
    if (lineRecords.length < TABLE_MIN_ROWS || !lineRecords.some(record => runLineIds.has(record.line.id))) continue;
    candidates.push({ cluster, bounds, lineRecords });
  }

  for (const { cluster, bounds, lineRecords } of candidates) {
    const xEdges = snapEdges(cluster.flatMap(rect => [rect.x, rectRight(rect)]));
    const yEdges = snapEdges(cluster.flatMap(rect => [rect.y, rectBottom(rect)]));
    const gridShape = xEdges.length >= 3 && yEdges.length >= 4;
    const canReportUnsupported = gridShape && lineRecords.length >= TABLE_MIN_ROWS;
    if (!gridShape) continue;
    const columnCount = xEdges.length - 1;
    const rowCount = yEdges.length - 1;
    if (columnCount < TABLE_MIN_COLUMNS || columnCount > RECT_MAX_COLUMNS || rowCount < TABLE_MIN_ROWS) {
      if (canReportUnsupported) return { reason: "ruling_unsupported" };
      continue;
    }

    const bands = [];
    const occupiedCells = new Set();
    const cellRects = [];
    let filledCells = 0;
    const totalCells = columnCount * rowCount;
    for (const rect of cluster) {
      const coverage = gridRectCoverage(rect, xEdges, yEdges);
      if (coverage.columns.length === columnCount && coverage.rows.length === 1) {
        // A full-width band is only safe as first-row header evidence. On a
        // body row it could be decoration or a merged cell, so abandon the
        // entire candidate with a topology gap.
        if (coverage.rows[0] > 0) return { reason: "topology" };
        if (bands.some(band => band.rows[0] === coverage.rows[0])) {
          return { reason: "topology" };
        }
        bands.push({ rect, ...coverage });
        continue;
      }
      // Every non-band rectangle must describe exactly one cell. This catches
      // merged spans and competing/shifted grids before text can be emitted.
      if (coverage.columns.length !== 1 || coverage.rows.length !== 1
        || !rectEdgesMatchCell(rect, coverage.columns[0], coverage.rows[0], xEdges, yEdges)) {
        return { reason: "topology" };
      }
      const cellKey = `${coverage.rows[0]}:${coverage.columns[0]}`;
      if (occupiedCells.has(cellKey)) return { reason: "topology" };
      occupiedCells.add(cellKey);
      cellRects.push(rect);
    }
    // Distinct cell rectangles may share borders, but a material geometric
    // overlap in both axes means two grids compete for the same region even
    // when both rects snap cleanly to (different) cells. Fail closed.
    for (let first = 0; first < cellRects.length; first += 1) {
      for (let second = first + 1; second < cellRects.length; second += 1) {
        const a = cellRects[first];
        const b = cellRects[second];
        const overlapWidth = Math.min(a.x + a.width, b.x + b.width) - Math.max(a.x, b.x);
        const overlapHeight = Math.min(rectBottom(a), rectBottom(b)) - Math.max(a.y, b.y);
        if (overlapWidth > RECT_MATERIAL_OVERLAP && overlapHeight > RECT_MATERIAL_OVERLAP) {
          return { reason: "topology" };
        }
      }
    }
    for (let row = 0; row < rowCount; row += 1) {
      for (let column = 0; column < columnCount; column += 1) {
        if (cluster.some(rect => coversInterval(rect, xEdges[column], xEdges[column + 1])
          && rect.y <= yEdges[row] + RECT_SNAP_TOLERANCE
          && rectBottom(rect) >= yEdges[row + 1] - RECT_SNAP_TOLERANCE)) filledCells += 1;
      }
    }
    if (filledCells / totalCells < RECT_MIN_FILL_RATIO) return { reason: "ruling_unsupported" };

    const cells = Array.from({ length: rowCount }, () => (
      Array.from({ length: columnCount }, () => [])
    ));
    for (const record of lineRecords) {
      // A line partially crossing the cluster would be split or duplicated by
      // a table render, so the whole line must be inside the same evidence box.
      if (record.nonWhitespace.some(item => !pointInsideCluster(item, bounds))) {
        return { reason: "topology" };
      }
      for (const item of record.insideNonWhitespace) {
        const box = itemBox(item);
        const centerX = box.x + box.width / 2;
        const matches = [];
        for (let row = 0; row < rowCount; row += 1) {
          for (let column = 0; column < columnCount; column += 1) {
            if (centerX >= xEdges[column] - RECT_CELL_ASSIGNMENT_SLACK
              && centerX <= xEdges[column + 1] + RECT_CELL_ASSIGNMENT_SLACK
              && box.y >= yEdges[row] - RECT_CELL_ASSIGNMENT_SLACK
              && box.y <= yEdges[row + 1] + RECT_CELL_ASSIGNMENT_SLACK) {
              matches.push({ row, column });
            }
          }
        }
        // An item near a snapped boundary can be eligible for two cells. A
        // first-match choice would invent topology, so abandon instead.
        if (matches.length !== 1) return { reason: "topology" };
        const cell = cells[matches[0].row][matches[0].column];
        if (cell.some(entry => boxesOverlap(entry.item.bbox, box))) {
          return { reason: "topology" };
        }
        cell.push({ item, line: record.line });
      }
    }
    const pageItems = paintedItems(page);
    const assignedItems = new Set(lineRecords.flatMap(record => record.insideNonWhitespace));
    const unrepresentedItem = page.raw_items.some(item => (
      item.is_whitespace !== true
        && typeof item.text === "string"
        && item.text.trim().length > 0
        && pointInsideCluster(item, bounds)
        && !assignedItems.has(item)
    ));
    if (unrepresentedItem) return { reason: "topology" };

    // Emission only. The structural grid, the header evidence, and the
    // newline rejection below all keep reading raw source text, so the
    // script projection cannot change which grid is reconstructed.
    const scriptForms = new Map(lineRecords.flatMap(
      record => [...scriptLineProjection(record.line, record.allItems, pageItems).forms],
    ));
    const grid = cells.map(row => row.map(cell => {
      cell.sort((left, right) => (
        right.item.bbox.y - left.item.bbox.y
          || left.item.bbox.x - right.item.bbox.x
      ));
      if (cell.some(entry => /[\r\n]/u.test(entry.item.text) || /[\r\n]/u.test(entry.line.text))) return null;
      return cell.map(entry => projectedItemText(scriptForms, entry.item).trim()).filter(Boolean).join(" ");
    }));
    if (grid.some(row => row.some(value => value === null))) return { reason: "topology" };

    const structuralGrid = cells.map(row => row.map(cell => cell
      .filter(entry => !isCollapsedWhitespaceRecovery(entry.item))
      .map(entry => entry.item.text.trim())
      .filter(Boolean)
      .join(" ")));
    const emptyColumns = structuralGrid[0].map((_value, column) => structuralGrid.every(row => row[column] === ""));
    let firstColumn = 0;
    let lastColumn = columnCount - 1;
    while (firstColumn <= lastColumn && emptyColumns[firstColumn]) firstColumn += 1;
    while (lastColumn >= firstColumn && emptyColumns[lastColumn]) lastColumn -= 1;
    if (emptyColumns.slice(firstColumn, lastColumn + 1).some(Boolean)) return { reason: "ruling_unsupported" };
    if (firstColumn > lastColumn) return { reason: "ruling_unsupported" };
    const trimmedGrid = grid.map(row => row.slice(firstColumn, lastColumn + 1));
    const candidateRows = lineRecords
      .sort((left, right) => left.line.y - right.line.y)
      .map(record => ({ line: record.line, cells: record.structuralInsideNonWhitespace }));
    if (!hasHeaderEvidence(candidateRows) && !hasFirstRowBandEvidence(bands)) {
      return { reason: "header" };
    }
    if (candidateRows.some(row => !runLineIds.has(row.line.id))) return { reason: "topology" };
    return { kind: "table", grid: trimmedGrid, rows: candidateRows };
  }
  return null;
}

function mergeRuleSegments(rectangles, orientation) {
  const horizontal = orientation === "horizontal";
  const candidates = rectangles
    .map(item => item.bbox)
    .filter(rect => horizontal
      ? rect.height <= RULE_MAX_THICKNESS && rect.width >= 20
      : rect.width <= RULE_MAX_THICKNESS && rect.height >= 8)
    .map(rect => ({
      axis: horizontal ? rect.y + rect.height / 2 : rect.x + rect.width / 2,
      start: horizontal ? rect.x : rect.y,
      end: horizontal ? rect.x + rect.width : rect.y + rect.height,
    }))
    .sort((left, right) => left.axis - right.axis || left.start - right.start);
  const axisGroups = [];
  for (const candidate of candidates) {
    const group = axisGroups.find(value => Math.abs(value.axis - candidate.axis) <= RULE_AXIS_TOLERANCE);
    if (group) {
      group.values.push(candidate);
      group.axis = median(group.values.map(value => value.axis));
    } else {
      axisGroups.push({ axis: candidate.axis, values: [candidate] });
    }
  }
  const merged = [];
  for (const group of axisGroups) {
    const spans = group.values.sort((left, right) => left.start - right.start);
    for (const span of spans) {
      const prior = merged[merged.length - 1];
      if (prior && Math.abs(prior.axis - group.axis) <= RULE_AXIS_TOLERANCE
        && span.start <= prior.end + RULE_JOIN_TOLERANCE) {
        prior.end = Math.max(prior.end, span.end);
      } else {
        merged.push({ axis: group.axis, start: span.start, end: span.end });
      }
    }
  }
  return merged;
}

function uniqueCoordinates(values) {
  const unique = [];
  for (const value of [...values].sort((left, right) => left - right)) {
    if (unique.length === 0 || Math.abs(unique[unique.length - 1] - value) > RULE_AXIS_TOLERANCE) {
      unique.push(value);
    } else {
      unique[unique.length - 1] = (unique[unique.length - 1] + value) / 2;
    }
  }
  return unique;
}

function alignedCoordinateIndex(values, candidate) {
  return values.findIndex(value => Math.abs(value - candidate) <= RULE_EDGE_TOLERANCE);
}

function hasAlignedPartialRule(horizontal, vertical, xs, ys) {
  const lastX = xs.length - 1;
  const lastY = ys.length - 1;
  for (const rule of vertical) {
    if (rule.axis < xs[0] - RULE_EDGE_TOLERANCE || rule.axis > xs[lastX] + RULE_EDGE_TOLERANCE) continue;
    const xIndex = alignedCoordinateIndex(xs, rule.axis);
    const startIndex = alignedCoordinateIndex(ys, rule.start);
    const endIndex = alignedCoordinateIndex(ys, rule.end);
    if (startIndex < 0 || endIndex <= startIndex) continue;
    if (!(xIndex >= 0 && startIndex === 0 && endIndex === lastY)) return true;
  }
  for (const rule of horizontal) {
    if (rule.axis < ys[0] - RULE_EDGE_TOLERANCE || rule.axis > ys[lastY] + RULE_EDGE_TOLERANCE) continue;
    const yIndex = alignedCoordinateIndex(ys, rule.axis);
    const startIndex = alignedCoordinateIndex(xs, rule.start);
    const endIndex = alignedCoordinateIndex(xs, rule.end);
    if (startIndex < 0 || endIndex <= startIndex) continue;
    if (!(yIndex >= 0 && startIndex === 0 && endIndex === lastX)) return true;
  }
  return false;
}

function closedRuleGrid(page) {
  const evidence = page.painted_rectangles;
  if (!evidence || evidence.status !== "available" || evidence.truncated || evidence.items.length === 0) {
    return { boundaries: null, tableReason: null };
  }
  const horizontal = mergeRuleSegments(evidence.items, "horizontal")
    .filter(rule => rule.end - rule.start >= 100);
  const vertical = mergeRuleSegments(evidence.items, "vertical");
  const candidates = [];
  for (const seed of horizontal) {
    const peers = horizontal.filter(rule => Math.abs(rule.start - seed.start) <= RULE_EDGE_TOLERANCE
      && Math.abs(rule.end - seed.end) <= RULE_EDGE_TOLERANCE);
    const ys = uniqueCoordinates(peers.map(rule => rule.axis));
    if (ys.length < 3 || ys.some((value, index) => index > 0 && value - ys[index - 1] < 8)) continue;
    const top = ys[0];
    const bottom = ys[ys.length - 1];
    const spanning = vertical.filter(rule => rule.start <= top + RULE_EDGE_TOLERANCE
      && rule.end >= bottom - RULE_EDGE_TOLERANCE
      && rule.axis >= seed.start - RULE_EDGE_TOLERANCE
      && rule.axis <= seed.end + RULE_EDGE_TOLERANCE);
    const xs = uniqueCoordinates(spanning.map(rule => rule.axis));
    if (xs.length < 3
      || Math.abs(xs[0] - seed.start) > RULE_EDGE_TOLERANCE
      || Math.abs(xs[xs.length - 1] - seed.end) > RULE_EDGE_TOLERANCE
      || xs.some((value, index) => index > 0 && value - xs[index - 1] < 12)) continue;
    candidates.push({
      xs,
      ys,
      hasPartialRule: hasAlignedPartialRule(horizontal, vertical, xs, ys),
    });
  }
  const distinct = [];
  for (const candidate of candidates) {
    const key = JSON.stringify({
      xs: candidate.xs.map(value => Number(value.toFixed(1))),
      ys: candidate.ys.map(value => Number(value.toFixed(1))),
    });
    if (!distinct.some(value => value.key === key)) distinct.push({ key, ...candidate });
  }
  if (distinct.length === 1 && !distinct[0].hasPartialRule) {
    return { boundaries: distinct[0], tableReason: null };
  }
  const gridLikeEvidence = horizontal.length >= 3 && vertical.length >= 2;
  return { boundaries: null, tableReason: distinct.length > 0 || gridLikeEvidence ? "topology" : null };
}

function itemCell(item, xs, ys) {
  if (!item.geometry_valid || !item.bbox || item.text_kind !== "non_whitespace") return null;
  const centerX = item.bbox.x + item.bbox.width / 2;
  const centerY = item.bbox.y + item.bbox.height / 2;
  const column = xs.findIndex((right, index) => index > 0 && centerX < right) - 1;
  const row = ys.findIndex((bottom, index) => index > 0 && centerY < bottom) - 1;
  if (column < 0 || row < 0) return null;
  const tolerance = 0.75;
  if (item.bbox.x < xs[column] - tolerance
    || item.bbox.x + item.bbox.width > xs[column + 1] + tolerance
    || item.bbox.y < ys[row] - tolerance
    || item.bbox.y + item.bbox.height > ys[row + 1] + tolerance) return null;
  return { row, column };
}

function ruledGridSegment(page) {
  const pageItems = paintedItems(page);
  const detected = closedRuleGrid(page);
  const boundaries = detected.boundaries;
  if (!boundaries) return { segment: null, tableReason: detected.tableReason };
  const { xs, ys } = boundaries;
  const rowCount = ys.length - 1;
  const columnCount = xs.length - 1;
  if (rowCount > RULED_TABLE_MAX_ROWS
    || columnCount > RULED_TABLE_MAX_COLUMNS
    || rowCount * columnCount > RULED_TABLE_MAX_CELLS) {
    return { segment: null, tableReason: "topology" };
  }
  const rowHeights = ys.slice(1).map((value, index) => value - ys[index]);
  const bodyMedian = median(rowHeights.slice(1));
  if (rowCount < 3 || columnCount < 2 || !(rowHeights[0] <= bodyMedian * 0.6)) {
    return { segment: null, tableReason: "topology" };
  }
  const captionCandidates = page.lines.filter(line => {
    const text = line.text.trim();
    const bottom = line.y + line.height;
    const center = line.x + line.width / 2;
    return /^TABLE\s+(?:\d+|[IVXLCDM]+)$/iu.test(text)
      && bottom <= ys[0]
      && ys[0] - bottom <= 30
      && center >= xs[0]
      && center <= xs[xs.length - 1];
  });
  if (captionCandidates.length !== 1) return { segment: null, tableReason: "header" };

  const cells = Array.from({ length: rowCount }, () => (
    Array.from({ length: columnCount }, () => [])
  ));
  const structuralCells = Array.from({ length: rowCount }, () => (
    Array.from({ length: columnCount }, () => [])
  ));
  const covered = new Set();
  const itemLocations = new Map();
  const itemById = new Map(page.raw_items.map(item => [item.id, item]));
  const gridBox = { left: xs[0], right: xs[xs.length - 1], top: ys[0], bottom: ys[ys.length - 1] };
  for (const item of page.raw_items) {
    if (!item.geometry_valid || !item.bbox || item.text_kind !== "non_whitespace") continue;
    const overlaps = item.bbox.x < gridBox.right && item.bbox.x + item.bbox.width > gridBox.left
      && item.bbox.y < gridBox.bottom && item.bbox.y + item.bbox.height > gridBox.top;
    if (!overlaps) continue;
    const location = itemCell(item, xs, ys);
    if (!location) return { segment: null, tableReason: "topology" };
    cells[location.row][location.column].push(item.id);
    if (!isCollapsedWhitespaceRecovery(item)) structuralCells[location.row][location.column].push(item.id);
    covered.add(item.id);
    itemLocations.set(item.id, location);
  }
  if (structuralCells.some(row => row.some(cell => cell.length === 0))) {
    return { segment: null, tableReason: "topology" };
  }
  const grid = Array.from({ length: rowCount }, () => (
    Array.from({ length: columnCount }, () => [])
  ));
  const coveredRows = [];
  for (let lineIndex = 0; lineIndex < page.lines.length; lineIndex += 1) {
    const line = page.lines[lineIndex];
    const allItems = line.item_ids.map(id => itemById.get(id)).filter(Boolean);
    const coveredCount = line.item_ids.filter(id => covered.has(id)).length;
    if (coveredCount === 0) continue;
    if (coveredCount !== line.item_ids.length || allItems.length !== line.item_ids.length) {
      return { segment: null, tableReason: "topology" };
    }
    const locations = line.item_ids.map(id => itemLocations.get(id));
    const tableRow = locations[0]?.row;
    if (!Number.isInteger(tableRow) || locations.some(location => location?.row !== tableRow)) {
      return { segment: null, tableReason: "topology" };
    }
    const groups = [];
    let previousColumn = -1;
    for (let itemIndex = 0; itemIndex < locations.length; itemIndex += 1) {
      const column = locations[itemIndex].column;
      if (column < previousColumn) return { segment: null, tableReason: "topology" };
      if (column !== previousColumn) groups.push({ column, start: itemIndex, end: itemIndex });
      else groups.at(-1).end = itemIndex;
      previousColumn = column;
    }
    const offsets = itemOffsets(line, allItems);
    // Cell text is sliced out of the line, so the script projection is
    // applied to the line text before slicing. It is length-preserving, which
    // is why the offsets recovered against the original string stay correct.
    const script = scriptLineProjection(line, allItems, pageItems);
    const lineText = script.text ?? line.text;
    for (const group of groups) {
      const fragment = offsets === null
        ? allItems.slice(group.start, group.end + 1)
          .map(item => projectedItemText(script.forms, item)).join(" ").trim()
        : lineText.slice(offsets[group.start].start, offsets[group.end].end).trim();
      if (!fragment) return { segment: null, tableReason: "topology" };
      grid[tableRow][group.column].push({
        text: fragment,
        y: line.y,
        x: line.x,
        lineIndex,
      });
    }
    coveredRows.push({ index: lineIndex, line, cells: allItems });
  }
  if (coveredRows.length === 0) return { segment: null, tableReason: "topology" };
  if (grid.some(row => row.some(fragments => fragments.length === 0))) {
    return { segment: null, tableReason: "topology" };
  }
  const orderedGrid = grid.map(row => row.map(fragments => fragments
    .sort((left, right) => left.y - right.y || left.x - right.x || left.lineIndex - right.lineIndex)
    .map(fragment => fragment.text)));
  const structuralHeader = structuralCells[0].map(cell => cell.map(id => itemById.get(id)?.text ?? ""));
  if (structuralHeader.some(fragments => {
    const text = fragments.join(" ").trim();
    const letters = text.match(/\p{L}/gu)?.length ?? 0;
    const visible = text.match(/[\p{L}\p{N}]/gu)?.length ?? 0;
    return text.length === 0 || text.length > 80 || visible === 0
      || letters / visible < 0.8 || text !== text.toLocaleUpperCase("en-US");
  })) return { segment: null, tableReason: "header" };
  return {
    segment: {
      kind: "table",
      rows: coveredRows.map(({ line, cells: rowCells }) => ({ line, cells: rowCells })),
      grid: orderedGrid,
      coveredLineIds: new Set(coveredRows.map(row => row.line.id)),
      insertionIndex: page.lines.findIndex(line => line.id === captionCandidates[0].id) + 1,
    },
    tableReason: null,
  };
}

function segmentTextRows(page, rows, itemById, ruledClusters) {
  const pageItems = paintedItems(page);
  const segments = [];
  const regions = [];
  let tableReason = null;
  let index = 0;
  while (index < rows.length) {
    let end = index;
    while (end < rows.length && tableStructureCells(rows[end]).length >= TABLE_MIN_COLUMNS) end += 1;
    const run = rows.slice(index, end);
    if (run.length < TABLE_MIN_ROWS) {
      segments.push({ kind: "text", rows: rows.slice(index, Math.max(end, index + 1)) });
      index = Math.max(end, index + 1);
      continue;
    }
    const { columnar, tableLike } = columnarAnalysis(run);
    const grid = tableLike ? run.map(row => assignRowToColumns(row, columnar, pageItems)) : null;
    if (grid && grid.every(Boolean) && hasHeaderEvidence(run)) {
      segments.push({ kind: "table", rows: run, grid });
    } else {
      // Only report a topology gap for runs that actually look columnar.
      // Ordinary prose that happens to share a left margin must not be
      // reported as an unreconstructed table.
      const ruling = ruledClusters.length > 0
        ? tryBuildRectGrid(page, run, ruledClusters, itemById)
        : null;
      if (ruling?.kind === "table") {
        segments.push({ kind: "table", rows: run, grid: ruling.grid });
      } else {
        // Preserve the reason from the rect-evidence attempt. The text path
        // can independently see a header/topology failure, but it must not
        // overwrite a more specific rect-path failure and its gap detail.
        let runReason = null;
        if (ruling?.reason === "topology") {
          runReason = "topology";
        } else if (ruling?.reason === "header") {
          runReason = "header";
        } else if (ruling?.reason === "ruling_unsupported") {
          runReason = "ruling_unsupported";
        } else if (tableLike) {
          runReason = grid && grid.every(Boolean) ? "header" : "topology";
        }
        // The abstention gap is unchanged: the page-level tableReason still
        // takes the last abandoned run's reason exactly as before. The region
        // list is purely additive and only consulted by the opt-in packet path.
        if (runReason) {
          tableReason = runReason;
          regions.push({ run, reason: runReason });
        }
        segments.push({ kind: "text", rows: run });
      }
    }
    index = end;
  }
  return { segments, tableReason, regions };
}

/**
 * Partition a page's lines into reading-order segments. Each segment is either
 * a confidently reconstructed table or a run of ordinary lines. Table-like runs
 * that cannot be reconstructed are returned as text with tableReason set, so
 * the caller can report typed partial coverage instead of silently flattening.
 */
function segmentPageLines(page) {
  const itemById = new Map(page.raw_items.map(item => [item.id, item]));
  const rows = page.lines.map(line => ({ line, cells: lineCells(line, itemById) }));
  const ruledRects = preprocessRuledRects(page);
  const ruledClusters = ruledRects ? clusterRuledRects(ruledRects) : [];
  const ruled = ruledGridSegment(page);
  if (!ruled.segment) {
    const text = segmentTextRows(page, rows, itemById, ruledClusters);
    return {
      segments: text.segments,
      tableReason: ruled.tableReason ?? text.tableReason,
      regions: text.regions,
    };
  }
  const remaining = rows.map((row, index) => ({ ...row, sourceIndex: index }))
    .filter(row => !ruled.segment.coveredLineIds.has(row.line.id));
  const before = segmentTextRows(page, remaining.filter(row => row.sourceIndex < ruled.segment.insertionIndex), itemById, ruledClusters);
  const after = segmentTextRows(page, remaining.filter(row => row.sourceIndex >= ruled.segment.insertionIndex), itemById, ruledClusters);
  return {
    segments: [...before.segments, ruled.segment, ...after.segments],
    tableReason: before.tableReason ?? after.tableReason,
    regions: [...before.regions, ...after.regions],
  };
}

function regionGapCode(reason) {
  return reason === "ruling_unsupported" ? "TABLE_RULING_UNSUPPORTED" : "TABLE_TOPOLOGY_UNKNOWN";
}

function rectsOverlap(box, region) {
  return box.x < region.x + region.width
    && box.x + box.width > region.x
    && box.y < region.y + region.height
    && box.y + box.height > region.y;
}

function rulingSegmentOverlapsRegion(segment, region) {
  const regionRight = region.x + region.width;
  const regionBottom = region.y + region.height;
  if (segment.orientation === "horizontal") {
    return segment.y1 >= region.y - RULE_AXIS_TOLERANCE
      && segment.y1 <= regionBottom + RULE_AXIS_TOLERANCE
      && segment.x2 >= region.x - RULE_AXIS_TOLERANCE
      && segment.x1 <= regionRight + RULE_AXIS_TOLERANCE;
  }
  return segment.x1 >= region.x - RULE_AXIS_TOLERANCE
    && segment.x1 <= regionRight + RULE_AXIS_TOLERANCE
    && segment.y2 >= region.y - RULE_AXIS_TOLERANCE
    && segment.y1 <= regionBottom + RULE_AXIS_TOLERANCE;
}

function tableProposalTextItem(item) {
  return {
    id: item.id,
    text: item.text,
    reading_order_index: item.reading_order_index,
    line_id: item.line_id ?? null,
    column_index: item.column_index ?? null,
    bbox: item.bbox ?? null,
    quad: item.quad ?? null,
    raw_transform: item.raw_transform ?? [],
  };
}

// Line height is the one stable per-row visual metric the IR exposes, and the
// first-row-band signal reuses the exact ratio the reconstruction path uses to
// decide header evidence. B1 ships this evidence only; it never decides the
// header, and reports no numeric confidence.
function tableProposalHeaderHints(run) {
  const firstRowHeight = rowHeight(run[0]);
  const bodyHeights = run.slice(1).map(rowHeight).filter(Number.isFinite);
  const bodyMedianHeight = bodyHeights.length > 0 ? median(bodyHeights) : null;
  let band;
  if (firstRowHeight === null || bodyMedianHeight === null) {
    band = "unavailable";
  } else if (bodyMedianHeight > 0 && firstRowHeight >= bodyMedianHeight * HEADER_HEIGHT_RATIO) {
    band = "taller_than_body";
  } else {
    band = "not_distinguished";
  }
  return {
    status: firstRowHeight === null && bodyMedianHeight === null ? "unavailable" : "available",
    first_row_height: firstRowHeight,
    body_median_height: bodyMedianHeight,
    first_row_band: band,
  };
}

/**
 * Build one deterministic, bounded proposal-region descriptor for a table run
 * the renderer abandoned. Pure over the page IR and the run; no token, no I/O,
 * no time/RNG. The proposal_token that binds it to (source sha, IR version,
 * region_id) is added by the handler, which owns the source identity. Exported
 * for the bounded-truncation regression, which needs to force an over-cap
 * region without synthesizing a full validated IR.
 */
export function buildTableProposalRegion(page, run, reason, ordinal) {
  const itemById = new Map(page.raw_items.map(item => [item.id, item]));
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const { line } of run) {
    minX = Math.min(minX, line.x);
    minY = Math.min(minY, line.y);
    maxX = Math.max(maxX, line.x + line.width);
    maxY = Math.max(maxY, line.y + line.height);
  }
  const bbox = { x: minX, y: minY, width: maxX - minX, height: maxY - minY };

  const allItems = [];
  for (const { line } of run) {
    for (const id of line.item_ids) {
      const item = itemById.get(id);
      if (item && item.geometry_valid && item.text_kind === "non_whitespace" && item.bbox) {
        allItems.push(item);
      }
    }
  }
  const itemsTruncated = allItems.length > MAX_TABLE_PROPOSAL_TEXT_ITEMS;
  const textItems = allItems.slice(0, MAX_TABLE_PROPOSAL_TEXT_ITEMS).map(tableProposalTextItem);

  const ruledEvidence = page.ruled_rects && Array.isArray(page.ruled_rects.items)
    ? page.ruled_rects.items.filter(rect => rectsOverlap(rect, bbox))
    : [];
  const ruledTruncated = ruledEvidence.length > MAX_TABLE_PROPOSAL_RULED_RECTS;
  const ruledRects = ruledEvidence.slice(0, MAX_TABLE_PROPOSAL_RULED_RECTS).map(rect => ({
    x: rect.x,
    y: rect.y,
    width: rect.width,
    height: rect.height,
    verb: rect.verb,
  }));

  const rulingEvidence = page.ruling_segments && Array.isArray(page.ruling_segments.items)
    ? page.ruling_segments.items.filter(segment => rulingSegmentOverlapsRegion(segment, bbox))
    : [];
  const rulingTruncated = page.ruling_segments?.status !== "available"
    || page.ruling_segments?.truncated === true
    || rulingEvidence.length > MAX_TABLE_PROPOSAL_RULING_SEGMENTS;
  const rulingSegments = rulingEvidence.slice(0, MAX_TABLE_PROPOSAL_RULING_SEGMENTS).map(segment => ({
    orientation: segment.orientation,
    x1: segment.x1,
    y1: segment.y1,
    x2: segment.x2,
    y2: segment.y2,
    source_operator_index: segment.source_operator_index,
  }));

  const paintedEvidence = page.painted_rectangles && Array.isArray(page.painted_rectangles.items)
    ? page.painted_rectangles.items.filter(painted => painted.bbox && rectsOverlap(painted.bbox, bbox))
    : [];
  const paintedTruncated = paintedEvidence.length > MAX_TABLE_PROPOSAL_PAINTED_RECTS;
  const paintedRectangles = paintedEvidence.slice(0, MAX_TABLE_PROPOSAL_PAINTED_RECTS).map(painted => ({
    id: painted.id,
    bbox: painted.bbox,
  }));

  return {
    region_id: `p${page.page}-t${ordinal}`,
    page: page.page,
    reason: regionGapCode(reason),
    coordinate_space: TABLE_PROPOSAL_COORDINATE_SPACE,
    bbox,
    text_items: textItems,
    ruled_rects: ruledRects,
    ruling_segments: rulingSegments,
    painted_rectangles: paintedRectangles,
    header_hints: tableProposalHeaderHints(run),
    truncation: {
      text_items: itemsTruncated ? "truncated" : "complete",
      ruled_rects: ruledTruncated ? "truncated" : "complete",
      ruling_segments: rulingTruncated ? "truncated" : "complete",
      painted_rectangles: paintedTruncated ? "truncated" : "complete",
    },
  };
}

// escapePlainMarkdown already escapes "|" (and backslashes before it), so a
// second pass here would emit "\\|", which is an escaped backslash followed by
// a live cell delimiter. Reuse the single existing escape.
function escapeTableCell(value) {
  const escapeFragment = fragment => escapePlainMarkdown(fragment)
    .replace(/\r/g, "&#13;")
    .replace(/\n/g, "&#10;");
  return Array.isArray(value)
    ? value.map(escapeFragment).join("<br>")
    : escapeFragment(value);
}

function renderTable(grid) {
  const [header, ...body] = grid;
  const lines = [
    `| ${header.map(escapeTableCell).join(" | ")} |`,
    `| ${header.map(() => "---").join(" | ")} |`,
    ...body.map(row => `| ${row.map(escapeTableCell).join(" | ")} |`),
  ];
  return lines;
}

/**
 * Project a verifier-accepted rectangular table through the same GFM escaping
 * used by deterministic conversion. GFM has no span syntax, so structured
 * cells retain the proposal's spans while covered Markdown slots stay empty.
 * Source text appears exactly once, at the cell's anchor.
 */
export function renderVerifiedTableMarkdown(table) {
  assertion(table && typeof table === "object" && !Array.isArray(table),
    "verified table must be an object");
  const { row_count: rowCount, column_count: columnCount, cells } = table;
  assertion(Number.isSafeInteger(rowCount) && rowCount >= 1
    && Number.isSafeInteger(columnCount) && columnCount >= 1
    && rowCount * columnCount <= 10_000,
  "verified table dimensions are invalid");
  assertion(Array.isArray(cells) && cells.length >= 1, "verified table cells are invalid");
  const grid = Array.from({ length: rowCount }, () => Array(columnCount).fill(null));
  for (const cell of cells) {
    assertion(cell && Number.isSafeInteger(cell.row) && Number.isSafeInteger(cell.column)
      && Number.isSafeInteger(cell.rowspan) && cell.rowspan >= 1
      && Number.isSafeInteger(cell.colspan) && cell.colspan >= 1
      && cell.row >= 0 && cell.column >= 0
      && cell.row + cell.rowspan <= rowCount
      && cell.column + cell.colspan <= columnCount
      && typeof cell.text === "string",
    "verified table cell is invalid");
    for (let row = cell.row; row < cell.row + cell.rowspan; row += 1) {
      for (let column = cell.column; column < cell.column + cell.colspan; column += 1) {
        assertion(grid[row][column] === null, "verified table cells overlap");
        grid[row][column] = row === cell.row && column === cell.column ? cell.text : "";
      }
    }
  }
  assertion(grid.every(row => row.every(value => value !== null)),
    "verified table cells do not cover the grid");
  return renderTable(grid).join("\n");
}

const PAGE_NUMBER_LINE = /^(?:\d{1,4}|page\s+\d{1,4}(?:\s+of\s+\d{1,4})?|\d{1,4}\s+of\s+\d{1,4}|-\d{1,4}-)$/iu;
// Unlike the source port's hardcoded Latin alphabet, Unicode Letter covers
// every script without silently making compact mode language-dependent.
const SPACED_HYPHEN = /(\p{L}) - (\p{L})/gu;

function emptyNormalizations() {
  return {
    dot_leaders_collapsed: 0,
    page_number_lines_removed: 0,
    running_header_lines_removed: 0,
    running_footer_lines_removed: 0,
    page_furniture_characters_removed: 0,
    page_furniture_pages: [],
    spaced_hyphens_joined: 0,
    normalized_pages: [],
  };
}

function recordPageFurnitureNormalizations(normalizations, page, furniture) {
  if (furniture.length === 0) return normalizations;
  for (const entry of furniture) {
    if (entry.kind === "page_number") normalizations.page_number_lines_removed += 1;
    if (entry.kind === "running_header") normalizations.running_header_lines_removed += 1;
    if (entry.kind === "running_footer") normalizations.running_footer_lines_removed += 1;
    normalizations.page_furniture_characters_removed += entry.characters;
  }
  normalizations.page_furniture_pages.push(page);
  return normalizations;
}

function isPageNumberLine(value) {
  return PAGE_NUMBER_LINE.test(value.trim());
}

function collapseDotLeaders(value, normalizations) {
  let result = "";
  let cursor = 0;
  for (const match of value.matchAll(/\.{4,}/gu)) {
    const start = match.index;
    const end = start + match[0].length;
    result += value.slice(cursor, start);
    const leftSpace = result.endsWith(" ");
    const rightSpace = value[end] === " ";
    // The upstream port emits " ... ". Only the spaces introduced at this
    // splice are collapsed, so compact mode does not rewrite unrelated source
    // spacing elsewhere on the line.
    result += leftSpace && rightSpace
      ? "..."
      : leftSpace
        ? "... "
        : rightSpace
          ? " ..."
          : " ... ";
    cursor = end;
    normalizations.dot_leaders_collapsed += 1;
  }
  return result + value.slice(cursor);
}

function joinSpacedHyphens(value, normalizations) {
  return value.replace(SPACED_HYPHEN, (_match, left, right) => {
    normalizations.spaced_hyphens_joined += 1;
    return `${left}-${right}`;
  });
}

function normalizePlainLines(entries, {
  page,
  pageBoundaryBefore,
  pageBoundaryAfter,
  protectedPageNumberIds,
}) {
  const normalizations = emptyNormalizations();
  const pageNumberCandidates = entries.map(entry => (
    entry.normalizable && !protectedPageNumberIds.has(entry.line?.id)
      && isPageNumberLine(entry.sourceText)
  ));
  const removed = new Set();

  // Ported from firecrawl/pdf-inspector (MIT): src/markdown/postprocess.rs.
  // The source port works over document text with explicit page-break markers;
  // this renderer keeps page structure as typed entries. A consecutive run of
  // page-number candidates is treated as one isolated footer block, allowing a
  // trailing run to be removed when its final line is directly before the
  // page boundary. This preserves mid-prose numbers while handling PDFs that
  // emit multiple footer candidates without blank text lines between them.
  for (let index = 0; index < entries.length;) {
    if (!pageNumberCandidates[index]) {
      index += 1;
      continue;
    }
    const start = index;
    while (index + 1 < entries.length && pageNumberCandidates[index + 1]) index += 1;
    const end = index;
    const previousIsBlank = start > 0 && entries[start - 1].sourceText.trim() === "";
    const nextIsBlank = end + 1 < entries.length && entries[end + 1].sourceText.trim() === "";
    const pageBoundaryBeforeLine = pageBoundaryBefore && start === 0;
    const pageBoundaryAfterLine = pageBoundaryAfter && end === entries.length - 1;
    const isolated = (pageBoundaryBeforeLine || previousIsBlank)
      && (pageBoundaryAfterLine || nextIsBlank);
    const beforePageBoundary = pageBoundaryAfterLine;
    if (isolated || beforePageBoundary) {
      for (let removal = start; removal <= end; removal += 1) removed.add(removal);
      normalizations.page_number_lines_removed += end - start + 1;
      normalizations.normalized_pages.push(page);
    }
    index += 1;
  }

  const lines = [];
  entries.forEach((entry, index) => {
    if (removed.has(index)) return;
    if (!entry.normalizable) {
      lines.push(entry.text);
      return;
    }
    let text = collapseDotLeaders(entry.text, normalizations);
    text = joinSpacedHyphens(text, normalizations);
    lines.push(text);
  });
  return { lines, normalizations };
}

/**
 * Resolve every link annotation on the page against the rendered lines.
 * Table runs cannot carry inline links in this renderer, so their lines are
 * excluded from the plan and any link landing there degrades to a typed gap.
 */
function analyzePageLinks(page, analysis, headings, furnitureLineIds = new Set()) {
  const links = page.link_annotations;
  // A truncated annotation list cannot prove that an omitted annotation does
  // not overlap a retained label. Suppress the whole page's explicit-link
  // projection so the overlap rule remains fail-closed.
  if (!links || links.status !== "available" || links.truncated === true) {
    return {
      spansByLine: new Map(),
      offsetsByLine: new Map(),
      unavailable: true,
      ambiguous: false,
      unsupportedTarget: false,
    };
  }
  const rows = analysis.segments.flatMap(segment => (
    segment.kind === "table" ? [] : segment.rows
  ));
  const excluded = new Set(rows
    .filter(row => headings.get(row.line.id)
      || furnitureLineIds.has(row.line.id)
      || rewritesLineStructure(row.line))
    .map(row => row.line.id));
  const plan = planPageLinks(rows, links.items ?? [], excluded);
  return {
    spansByLine: plan.spansByLine,
    offsetsByLine: plan.offsetsByLine,
    unavailable: false,
    ambiguous: plan.ambiguous,
    unsupportedTarget: plan.unsupportedTarget,
  };
}

function pageGaps(page, analysis, linkState, {
  mathNotReconstructed = false,
  pageFurniture = [],
} = {}) {
  const gaps = [];
  const add = (code, message) => gaps.push({ code, page: page.page, message });
  if (linkState?.unavailable) {
    add("LINK_ANNOTATIONS_UNAVAILABLE", "Link annotation evidence was unavailable or truncated for this page, so no explicit links were emitted.");
  }
  if (linkState?.unsupportedTarget) {
    add("UNSUPPORTED_LINK_TARGET", "At least one link targets an internal destination, an action, or an unsupported scheme, so it remains escaped text.");
  }
  if (linkState?.ambiguous) {
    add("LINK_MAPPING_AMBIGUOUS", "At least one link could not be mapped to exactly one contiguous run of source text, so it remains escaped text.");
  }
  if (analysis?.tableReason === "topology") {
    add("TABLE_TOPOLOGY_UNKNOWN", "Table-like content was detected but its column topology could not be reconstructed, so it remains reading-order text.");
  }
  if (analysis?.tableReason === "header") {
    add("TABLE_TOPOLOGY_UNKNOWN", "A column grid was detected but no source evidence distinguishes a header row, and a Markdown table would impose one, so it remains reading-order text.");
  }
  if (analysis?.tableReason === "ruling_unsupported") {
    add("TABLE_RULING_UNSUPPORTED", "Ruled rectangle evidence described a grid-shaped region, but its table topology could not be reconstructed, so it remains reading-order text.");
  }
  if (page.text_integrity?.status === "suspect") {
    const details = page.text_integrity.signals
      .map(signal => `${signal.kind}=${signal.count}`)
      .join(", ");
    add("TEXT_INTEGRITY_SUSPECT", `Text-layer integrity signals were detected (${details}); extracted text is retained but may require visual inspection.`);
  }
  if (page.extraction_status === "failed") {
    add("TEXT_LAYER_FAILED", "The page text-layer extraction failed.");
  }
  if (page.text_layer_status === "empty") {
    add("TEXT_LAYER_EMPTY", "No source-backed text-layer content was available on this page.");
  }
  if (page.truncation.reasons.includes("max_items")) {
    add("SOURCE_ITEM_LIMIT_REACHED", "Source text items were omitted because the extraction item limit was reached.");
  }
  if (page.truncation.reasons.includes("max_characters")) {
    add("SOURCE_CHARACTER_LIMIT_REACHED", "Source text was omitted because the extraction character limit was reached.");
  }
  if (page.reading_order.strategy === "unavailable_output_omitted") {
    add("PAGE_RANGE_INCOMPLETE", "The accepted layout projection omitted this page's reading-order evidence, so the requested range is incomplete.");
  }
  if (page.modality_hint === "image-only-candidate") {
    add("OCR_NOT_PERFORMED", "The page appears image-only, and OCR was not performed.");
    add("IMAGE_CONTENT_NOT_RENDERED", "Image content was not rendered into Markdown.");
  } else if (page.modality_hint === "mixed-content-candidate" && page.has_image_operations) {
    add("OCR_NOT_PERFORMED", "Images may contain text that is absent because OCR was not performed.");
    add("IMAGE_CONTENT_NOT_RENDERED", "Image content was not rendered into Markdown.");
  }
  if (mathNotReconstructed) {
    add("MATH_NOT_RECONSTRUCTED", "Source-evidenced mathematical content was present on this page and was not reconstructed as mathematics; it remains source reading-order text.");
  }
  if (pageFurniture.length > 0) {
    const kinds = [...new Set(pageFurniture.map(entry => entry.kind))].sort().join(", ");
    add("PAGE_FURNITURE_REMOVED", `${pageFurniture.length} source line${pageFurniture.length === 1 ? " was" : "s were"} removed as page furniture (${kinds}); removal counts and kinds are reported in normalizations.`);
  }
  if (page.has_vector_paint_operations) {
    add("VECTOR_CONTENT_NOT_INTERPRETED", "Vector-painted content beyond reconstructed ruled or bounded solid-mask table grids was not interpreted as text or table structure.");
  }
  if (page.errors.some(error => error.code === "RAW_PAGE_GEOMETRY_UNAVAILABLE")) {
    add("RAW_PAGE_GEOMETRY_UNAVAILABLE", "Raw MediaBox, CropBox, or rotation evidence was unavailable.");
  }
  if (page.errors.some(error => error.code === "NONFINITE_TEXT_GEOMETRY")) {
    add("INVALID_TEXT_GEOMETRY", "At least one retained text item had invalid geometry and was omitted from layout reconstruction.");
  }
  if (page.lines.some(line => containsUnsafeText(line.text))) {
    add("CONTROL_CHARACTERS_SANITIZED", "Unsafe control characters or malformed UTF-16 surrogates were replaced with the Unicode replacement character.");
  }
  if (page.extraction_status === "partial" && gaps.length === 0) {
    add("PAGE_RANGE_INCOMPLETE", "The page layout evidence is partial, so the requested range is not fully represented.");
  }
  return gaps;
}

function pageStatus(page, gaps) {
  if (page.extraction_status === "failed" && page.lines.length === 0) return "failed";
  return gaps.length > 0 ? "partial" : "complete";
}

function sameFlow(left, right) {
  return left?.joinable === true
    && right?.joinable === true
    && left.line.column_index === right.line.column_index;
}

function dropCapContinuation(preceding, left, right) {
  if (!sameFlow(left, right)) return false;
  const leftText = left.line.text.trim();
  const rightText = right.line.text.trim();
  const rightWords = rightText.match(/[\p{L}\p{N}]+/gu) ?? [];
  const verticalOverlap = Math.min(left.line.y + left.line.height, right.line.y + right.line.height)
    - Math.max(left.line.y, right.line.y);
  const horizontalGap = right.line.x - (left.line.x + left.line.width);
  return (preceding === null || preceding.joinable === false)
    && left.line.direction === "ltr"
    && right.line.direction === "ltr"
    && /^\p{Lu}$/u.test(leftText)
    && /^\p{Lu}{2,}(?:\s|$)/u.test(rightText)
    && rightWords.length >= 5
    && /\p{Ll}/u.test(rightText)
    && left.line.height >= right.line.height * 1.5
    && verticalOverlap > 0
    && horizontalGap >= -1
    && horizontalGap <= Math.max(4, right.line.height);
}

function joinParagraphContinuity(records) {
  const joined = [];
  for (const [index, record] of records.entries()) {
    const previous = records[index - 1] ?? null;
    const preceding = records[index - 2] ?? null;
    if (previous && dropCapContinuation(preceding, previous, record)) {
      joined[joined.length - 1] = {
        ...record,
        text: `${joined[joined.length - 1].text}${record.text}`,
        sourceText: `${joined[joined.length - 1].sourceText}${record.sourceText}`,
      };
    } else {
      joined.push(record);
    }
  }
  return joined;
}

function joinHeadingContinuations(records) {
  const joined = [];
  for (const record of records) {
    const previous = joined[joined.length - 1];
    if (record.headingContinuation && previous?.headingLevel) {
      joined[joined.length - 1] = {
        ...previous,
        text: `${previous.text} ${record.text}`,
        sourceText: `${previous.sourceText} ${record.sourceText}`,
      };
    } else {
      joined.push(record);
    }
  }
  return joined;
}

function renderPage(page, {
  compact = false,
  pageBoundaryBefore = false,
  pageBoundaryAfter = false,
  collectTableProposals = false,
  pageFurniture = [],
} = {}) {
  const furnitureLineIds = new Set(pageFurniture.map(entry => entry.lineId));
  const pageItems = paintedItems(page);
  const headings = headingLevels(page);
  const headingContinuations = headingContinuationIds(page, headings);
  const analysis = segmentPageLines(page);
  const linkState = analyzePageLinks(page, analysis, headings, furnitureLineIds);
  const unsafePage = analysis.tableReason !== null
    || linkState.unavailable
    || linkState.ambiguous
    || linkState.unsupportedTarget;
  const fractionPlan = pageStackedFractionPlan(page, analysis.segments, {
    headings,
    linkState,
    unsafePage,
  });
  const records = analysis.segments.flatMap(segment => {
    if (segment.kind === "table") {
      return renderTable(segment.grid).map(text => ({
          text,
          sourceText: text,
          normalizable: false,
          line: null,
          joinable: false,
        }));
    }
    return segment.rows.flatMap(({ line, cells }, rowIndex, rows) => {
        if (furnitureLineIds.has(line.id)) return [];
        if (fractionPlan.skipped.has(line.id)) return [];
        const spans = linkState.spansByLine.get(line.id);
        const offsets = linkState.offsetsByLine.get(line.id);
        if (spans && spans.length > 0 && offsets && !headings.get(line.id)
          && !headingContinuations.has(line.id)) {
          const linked = renderLinkedLine(line, offsets, spans);
          if (linked !== null) {
            return {
              text: linked,
              sourceText: line.text,
              normalizable: false,
              line,
              joinable: false,
            };
          }
        }
        const projectionOptions = {
          headingLevel: headings.get(line.id),
          linked: Boolean(spans?.length),
          rows,
          rowIndex,
          unsafePage,
        };
        const mathText = mathOperatorSpacedText(
          { line, cells },
          projectionOptions,
        );
        const proseMathText = mathText === null
          ? proseMathVariableSpacedText({ line, cells }, projectionOptions)
          : null;
        const fractionText = fractionPlan.replacements.get(line.id) ?? null;
        const projectedText = fractionText ?? mathText ?? proseMathText;
        // Typographic fidelity only, and applied last so it composes with the
        // spacing projections instead of being displaced by them. Those two
        // only splice a separator between two source items, which leaves every
        // item's own text intact and in order, so the script projection can
        // recover its offsets against the spaced string just as well as against
        // the original. The fraction replacement is excluded: it merges two
        // source lines and rebuilds their text, so the items of neither line
        // can be located in the result and a projection over it would be
        // guesswork. `joinable` deliberately still follows projectedText alone,
        // because a script form changes only which characters are emitted, not
        // whether the line is a continuable flow.
        const scriptText = fractionText === null
          ? scriptLineProjection(line, cells, pageItems, projectedText ?? line.text).text
          : null;
        return {
          text: renderLine(line, headings.get(line.id), scriptText ?? projectedText ?? line.text),
          sourceText: line.text,
          normalizable: true,
          line,
          joinable: projectedText === null && !headings.get(line.id) && !rewritesLineStructure(line),
          headingLevel: headings.get(line.id),
          headingContinuation: headingContinuations.has(line.id),
        };
      });
  });
  const entries = joinParagraphContinuity(joinHeadingContinuations(records));
  const normalized = compact
    ? normalizePlainLines(entries, {
      page: page.page, pageBoundaryBefore, pageBoundaryAfter,
      protectedPageNumberIds: ambiguousBarePageNumberIds(page),
    })
    : { lines: entries.map(entry => entry.text), normalizations: emptyNormalizations() };
  recordPageFurnitureNormalizations(normalized.normalizations, page.page, pageFurniture);
  const lines = normalized.lines;
  const markdown = lines.length > 0
    ? lines.join("\n")
    : "[No source-backed text was available on this page.]";
  const gaps = pageGaps(page, analysis, linkState, {
    mathNotReconstructed: pageMathNotReconstructed(analysis, fractionPlan),
    pageFurniture,
  });
  const rendered = {
    page: page.page,
    conversion_status: pageStatus(page, gaps),
    markdown,
    markdown_bytes: utf8Bytes(markdown),
    line_count: page.lines.length,
    rendered_line_count: lines.length,
    gaps,
    normalizations: normalized.normalizations,
  };
  if (collectTableProposals) {
    // Additive: this key is stripped from the page result and never affects
    // markdown, gaps, or byte counts. It is only present when the opt-in flag
    // is set, so the default page shape is byte-identical.
    rendered.tableProposalRegions = analysis.regions.map(
      (region, index) => buildTableProposalRegion(page, region.run, region.reason, index + 1),
    );
  }
  return rendered;
}

function renderDocumentMarkdown(renderedPages, includePageBoundaries, gaps) {
  const sections = renderedPages.map(({ page, markdown }) => (
    includePageBoundaries ? `<!-- PDF page ${page} -->\n\n${markdown}` : markdown
  ));
  const separator = includePageBoundaries ? "\n\n---\n\n" : "\n\n";
  const parts = [sections.join(separator)];
  if (gaps.length > 0) {
    parts.push([
      "## Conversion gaps",
      "",
      ...gaps.map(gap => `- Page ${gap.page}: ${escapePlainMarkdown(gap.message)}`),
    ].join("\n"));
  }
  parts.push([
    "## Conversion limitations",
    "",
    ...LIMITATIONS.map(limitation => `- ${escapePlainMarkdown(limitation)}`),
  ].join("\n"));
  return `${parts.filter(Boolean).join("\n\n")}\n`;
}

function documentStatus(pages) {
  if (pages.length > 0 && pages.every(page => page.conversion_status === "failed")) return "failed";
  return pages.every(page => page.conversion_status === "complete") ? "complete" : "partial";
}

function resultPageStatus(page) {
  if (page.rendered_line_count === 0 && page.gaps.some(gap => gap.code === "TEXT_LAYER_FAILED")) return "failed";
  return page.gaps.length > 0 ? "partial" : "complete";
}

function provenanceFromLayout(layout) {
  return {
    source: {
      file_name: layout.source.file_name,
      sha256: layout.source.sha256,
      size_bytes: layout.source.size_bytes,
    },
    layout: {
      name: layout.ir.name,
      version: layout.ir.version,
      parser_name: layout.parser.name,
      parser_version: layout.parser.version,
      page_range: {
        start_page: layout.page_range.start_page,
        end_page: layout.page_range.end_page,
        total_pages: layout.page_range.total_pages,
      },
    },
  };
}

function sameJson(left, right) {
  return JSON.stringify(left) === JSON.stringify(right);
}

function aggregateNormalizations(renderedPages) {
  const normalizations = emptyNormalizations();
  for (const page of renderedPages) {
    normalizations.dot_leaders_collapsed += page.normalizations.dot_leaders_collapsed;
    normalizations.page_number_lines_removed += page.normalizations.page_number_lines_removed;
    normalizations.running_header_lines_removed += page.normalizations.running_header_lines_removed;
    normalizations.running_footer_lines_removed += page.normalizations.running_footer_lines_removed;
    normalizations.page_furniture_characters_removed += page.normalizations.page_furniture_characters_removed;
    normalizations.page_furniture_pages.push(...page.normalizations.page_furniture_pages);
    normalizations.spaced_hyphens_joined += page.normalizations.spaced_hyphens_joined;
    normalizations.normalized_pages.push(...page.normalizations.normalized_pages);
  }
  normalizations.normalized_pages = [...new Set(normalizations.normalized_pages)].sort((left, right) => left - right);
  normalizations.page_furniture_pages = [...new Set(normalizations.page_furniture_pages)]
    .sort((left, right) => left - right);
  return normalizations;
}

function validateNormalizations(normalizations) {
  assertion(normalizations && typeof normalizations === "object" && !Array.isArray(normalizations),
    "normalizations must be an object");
  for (const key of [
    "dot_leaders_collapsed",
    "page_number_lines_removed",
    "running_header_lines_removed",
    "running_footer_lines_removed",
    "page_furniture_characters_removed",
    "spaced_hyphens_joined",
  ]) {
    assertion(Number.isSafeInteger(normalizations[key]) && normalizations[key] >= 0,
      `${key} must be a non-negative integer`);
  }
  assertion(Array.isArray(normalizations.normalized_pages)
    && normalizations.normalized_pages.every(page => Number.isSafeInteger(page) && page >= 1)
    && sameJson(normalizations.normalized_pages, [...new Set(normalizations.normalized_pages)].sort((left, right) => left - right)),
  "normalized_pages must be a sorted unique page-number array");
  assertion(Array.isArray(normalizations.page_furniture_pages)
    && normalizations.page_furniture_pages.every(page => Number.isSafeInteger(page) && page >= 1)
    && sameJson(normalizations.page_furniture_pages,
      [...new Set(normalizations.page_furniture_pages)].sort((left, right) => left - right)),
  "page_furniture_pages must be a sorted unique page-number array");
}

/**
 * Validate the deterministic renderer result. When layout is supplied, this
 * also binds provenance, page status, line counts, gaps, and page byte counts
 * to the accepted layout IR. This proves internal conversion semantics, not
 * source evidence. Callers must source-validate the layout IR before rendering.
 */
export function validateMarkdownConversionSemantics(result, { layout = null } = {}) {
  assertion(sameJson(result.renderer, RENDERER), "renderer identity mismatch");
  assertion(result.options?.include_page_boundaries === true || result.options?.include_page_boundaries === false,
    "include_page_boundaries must be boolean");
  assertion(result.options?.compact === true || result.options?.compact === false,
    "compact must be boolean");
  assertion(result.options?.remove_page_furniture === true
    || result.options?.remove_page_furniture === false,
  "remove_page_furniture must be boolean");
  assertion(Number.isSafeInteger(result.limits?.max_markdown_bytes)
    && result.limits.max_markdown_bytes >= 1
    && result.limits.max_markdown_bytes <= MAX_MARKDOWN_BYTES_LIMIT, "max_markdown_bytes is out of range");
  assertion(typeof result.markdown === "string", "markdown must be a string");
  validateNormalizations(result.normalizations);
  const markdownBytes = utf8Bytes(result.markdown);
  assertion(result.markdown_bytes === markdownBytes, "markdown UTF-8 byte count mismatch");
  assertion(result.markdown_sha256 === sha256(result.markdown), "markdown SHA-256 mismatch");
  if (result.saved_output !== undefined && result.saved_output !== null) {
    assertion(result.saved_output.bytes === markdownBytes, "saved output UTF-8 byte count mismatch");
    assertion(result.saved_output.sha256 === result.markdown_sha256, "saved output SHA-256 mismatch");
  }
  assertion(markdownBytes <= result.limits.max_markdown_bytes, "markdown exceeds max_markdown_bytes");
  assertion(Array.isArray(result.pages) && result.pages.length > 0, "pages must be a non-empty array");
  for (const page of result.pages) {
    assertion(Number.isInteger(page.page) && page.page >= 1, "page number is invalid");
    assertion(["complete", "partial", "failed"].includes(page.conversion_status), `page ${page.page} status is invalid`);
    assertion(Number.isSafeInteger(page.markdown_bytes) && page.markdown_bytes >= 0, `page ${page.page} byte count is invalid`);
    assertion(Number.isSafeInteger(page.line_count) && page.line_count >= 0, `page ${page.page} line count is invalid`);
    assertion(Number.isSafeInteger(page.rendered_line_count) && page.rendered_line_count >= 0, `page ${page.page} rendered line count is invalid`);
    assertion(Array.isArray(page.gaps), `page ${page.page} gaps must be an array`);
    for (const gap of page.gaps) {
      assertion(GAP_CODES.has(gap.code), `unknown gap code ${gap.code}`);
      assertion(gap.page === page.page, `gap ${gap.code} page mismatch`);
      assertion(typeof gap.message === "string" && gap.message.length > 0, `gap ${gap.code} message is invalid`);
    }
    assertion(page.conversion_status === resultPageStatus(page), `page ${page.page} status does not match its gaps`);
  }
  const flattenedGaps = result.pages.flatMap(page => page.gaps);
  assertion(sameJson(result.gaps, flattenedGaps), "document gaps are not the exact flattened page gaps");
  assertion(result.conversion_status === documentStatus(result.pages), "document conversion status mismatch");
  assertion(sameJson(result.limitations, LIMITATIONS), "renderer limitations mismatch");

  if (layout !== null) {
    validatePdfLayoutSemantics(layout, { enforceOutputBudget: false });
    validateSupportedLayoutIdentity(layout);
    const furniturePlans = planDocumentPageFurniture(
      layout.pages,
      result.options.remove_page_furniture,
    );
    assertion(sameJson(result.provenance, provenanceFromLayout(layout)), "source or layout provenance mismatch");
    assertion(result.pages.length === layout.pages.length, "page count does not match layout IR");
    for (let index = 0; index < layout.pages.length; index += 1) {
      const expected = renderPage(layout.pages[index], {
        compact: result.options.compact,
        pageBoundaryBefore: index > 0,
        pageBoundaryAfter: true,
        pageFurniture: furniturePlans.get(layout.pages[index].page),
      });
      const actual = result.pages[index];
      assertion(actual.page === expected.page, `page ${expected.page} order mismatch`);
      assertion(actual.line_count === expected.line_count, `page ${expected.page} line count mismatch`);
      assertion(actual.rendered_line_count === expected.rendered_line_count, `page ${expected.page} rendered line count mismatch`);
      assertion(actual.markdown_bytes === expected.markdown_bytes, `page ${expected.page} byte count mismatch`);
      assertion(actual.conversion_status === expected.conversion_status, `page ${expected.page} status mismatch`);
      assertion(sameJson(actual.gaps, expected.gaps), `page ${expected.page} gaps mismatch`);
    }
    assertion(sameJson(result.normalizations, aggregateNormalizations(
      layout.pages.map((page, index) => renderPage(page, {
        compact: result.options.compact,
        pageBoundaryBefore: index > 0,
        pageBoundaryAfter: true,
        pageFurniture: furniturePlans.get(page.page),
      })),
    )), "normalizations do not match the bound layout IR");
    const expectedMarkdown = renderDocumentMarkdown(
      layout.pages.map((page, index) => renderPage(page, {
        compact: result.options.compact,
        pageBoundaryBefore: index > 0,
        pageBoundaryAfter: true,
        pageFurniture: furniturePlans.get(page.page),
      })),
      result.options.include_page_boundaries,
      flattenedGaps,
    );
    assertion(result.markdown === expectedMarkdown, "markdown does not match the bound layout IR");
  }

  // Verified-vision proposal packets are additive and optional. The renderer
  // emits token-free descriptors under `table_proposal_regions`; the handler
  // re-keys them to `table_proposals` with a bound `proposal_token`. Validate
  // whichever is present, sharing one descriptor contract.
  const rendererProposals = result.table_proposal_regions;
  const payloadProposals = result.table_proposals;
  assertion(rendererProposals === undefined || payloadProposals === undefined,
    "renderer and payload table proposals cannot coexist");
  const proposals = rendererProposals ?? payloadProposals;
  if (proposals !== undefined) {
    validateTableProposals(proposals, { requireToken: payloadProposals !== undefined });
    validateTableProposalDocumentTruncation(result.table_proposals_truncation, proposals);
  } else {
    assertion(result.table_proposals_truncation === undefined,
      "table proposal truncation cannot exist without proposals");
  }
  return result;
}

function isFiniteNumber(value) {
  return typeof value === "number" && Number.isFinite(value);
}

function validateTableProposalBox(box, label) {
  assertion(box && typeof box === "object" && !Array.isArray(box), `${label} must be an object`);
  assertion(isFiniteNumber(box.x) && isFiniteNumber(box.y), `${label} origin is invalid`);
  assertion(isFiniteNumber(box.width) && box.width >= 0
    && isFiniteNumber(box.height) && box.height >= 0, `${label} extent is invalid`);
}

function validateTableProposals(proposals, { requireToken }) {
  assertion(Array.isArray(proposals), "table proposals must be an array");
  assertion(proposals.length <= MAX_TABLE_PROPOSALS_PER_DOCUMENT,
    "table proposals exceed the per-document cap");
  const seen = new Set();
  for (const proposal of proposals) {
    assertion(proposal && typeof proposal === "object" && !Array.isArray(proposal),
      "each table proposal must be an object");
    assertion(typeof proposal.region_id === "string" && /^p[0-9]+-t[0-9]+$/.test(proposal.region_id),
      "table proposal region_id is malformed");
    assertion(!seen.has(proposal.region_id), `duplicate table proposal region_id ${proposal.region_id}`);
    seen.add(proposal.region_id);
    assertion(Number.isInteger(proposal.page) && proposal.page >= 1, "table proposal page is invalid");
    assertion(proposal.region_id.startsWith(`p${proposal.page}-t`), "table proposal region_id does not bind its page");
    assertion(["TABLE_TOPOLOGY_UNKNOWN", "TABLE_RULING_UNSUPPORTED"].includes(proposal.reason),
      "table proposal reason must be a table abstention code");
    assertion(proposal.coordinate_space === TABLE_PROPOSAL_COORDINATE_SPACE,
      "table proposal coordinate_space mismatch");
    validateTableProposalBox(proposal.bbox, `table proposal ${proposal.region_id} bbox`);

    assertion(Array.isArray(proposal.text_items)
      && proposal.text_items.length <= MAX_TABLE_PROPOSAL_TEXT_ITEMS,
    "table proposal text_items exceed the cap");
    for (const item of proposal.text_items) {
      assertion(item && typeof item.id === "string" && typeof item.text === "string",
        "table proposal text item identity is invalid");
      assertion(Number.isInteger(item.reading_order_index) && item.reading_order_index >= 0,
        "table proposal text item reading_order_index is invalid");
      assertion(item.line_id === null || typeof item.line_id === "string",
        "table proposal text item line_id is invalid");
      assertion(item.column_index === null || Number.isInteger(item.column_index),
        "table proposal text item column_index is invalid");
      assertion(item.bbox === null || (typeof item.bbox === "object" && !Array.isArray(item.bbox)),
        "table proposal text item bbox is invalid");
      assertion(item.quad === null || (Array.isArray(item.quad) && item.quad.length === 4),
        "table proposal text item quad is invalid");
      assertion(Array.isArray(item.raw_transform) && item.raw_transform.length === 6,
        "table proposal text item raw_transform is invalid");
    }

    assertion(Array.isArray(proposal.ruled_rects)
      && proposal.ruled_rects.length <= MAX_TABLE_PROPOSAL_RULED_RECTS,
    "table proposal ruled_rects exceed the cap");
    for (const rect of proposal.ruled_rects) {
      validateTableProposalBox(rect, `table proposal ${proposal.region_id} ruled rect`);
      assertion(["fill", "stroke", "clip", "none"].includes(rect.verb),
        "table proposal ruled rect verb is invalid");
    }

    assertion(Array.isArray(proposal.ruling_segments)
      && proposal.ruling_segments.length <= MAX_TABLE_PROPOSAL_RULING_SEGMENTS,
    "table proposal ruling_segments exceed the cap");
    let priorRulingOperator = -1;
    for (const segment of proposal.ruling_segments) {
      assertion(segment && ["horizontal", "vertical"].includes(segment.orientation)
        && [segment.x1, segment.y1, segment.x2, segment.y2].every(isFiniteNumber)
        && Number.isInteger(segment.source_operator_index)
        && segment.source_operator_index >= priorRulingOperator,
      "table proposal ruling segment is invalid");
      priorRulingOperator = segment.source_operator_index;
    }

    assertion(Array.isArray(proposal.painted_rectangles)
      && proposal.painted_rectangles.length <= MAX_TABLE_PROPOSAL_PAINTED_RECTS,
    "table proposal painted_rectangles exceed the cap");
    for (const painted of proposal.painted_rectangles) {
      assertion(painted && typeof painted.id === "string", "table proposal painted rect id is invalid");
      validateTableProposalBox(painted.bbox, `table proposal ${proposal.region_id} painted rect`);
    }

    const hints = proposal.header_hints;
    assertion(hints && typeof hints === "object" && !Array.isArray(hints),
      "table proposal header_hints must be an object");
    assertion(["available", "unavailable"].includes(hints.status),
      "table proposal header_hints status is invalid");
    assertion(hints.first_row_height === null || isFiniteNumber(hints.first_row_height),
      "table proposal header_hints first_row_height is invalid");
    assertion(hints.body_median_height === null || isFiniteNumber(hints.body_median_height),
      "table proposal header_hints body_median_height is invalid");
    assertion(["taller_than_body", "not_distinguished", "unavailable"].includes(hints.first_row_band),
      "table proposal header_hints first_row_band is invalid");

    const truncation = proposal.truncation;
    assertion(truncation && typeof truncation === "object" && !Array.isArray(truncation),
      "table proposal truncation must be an object");
    for (const key of ["text_items", "ruled_rects", "ruling_segments", "painted_rectangles"]) {
      assertion(["complete", "truncated"].includes(truncation[key]),
        `table proposal truncation.${key} is invalid`);
    }

    if (requireToken) {
      assertion(typeof proposal.proposal_token === "string" && /^[a-f0-9]{64}$/.test(proposal.proposal_token),
        "table proposal proposal_token is malformed");
    } else {
      assertion(proposal.proposal_token === undefined,
        "renderer-stage table proposals must not carry a proposal_token");
    }
  }
}

function validateTableProposalDocumentTruncation(truncation, proposals) {
  assertion(truncation && typeof truncation === "object" && !Array.isArray(truncation),
    "table proposals truncation must be an object");
  assertion(["complete", "truncated"].includes(truncation.status),
    "table proposals truncation status is invalid");
  for (const key of ["observed_regions", "returned_regions", "omitted_regions"]) {
    assertion(Number.isSafeInteger(truncation[key]) && truncation[key] >= 0,
      `table proposals truncation ${key} is invalid`);
  }
  assertion(truncation.returned_regions === proposals.length,
    "table proposals truncation returned count mismatch");
  assertion(truncation.observed_regions === truncation.returned_regions + truncation.omitted_regions,
    "table proposals truncation counts do not reconcile");
  assertion(truncation.returned_regions <= MAX_TABLE_PROPOSALS_PER_DOCUMENT,
    "table proposals truncation exceeds the document cap");
  assertion(truncation.status === (truncation.omitted_regions > 0 ? "truncated" : "complete"),
    "table proposals truncation status does not match omitted regions");
}

export function validateTableProposalGapCoverage(gaps, regions) {
  assertion(Array.isArray(gaps), "conversion gaps must be an array");
  assertion(Array.isArray(regions), "table proposal regions must be an array");
  const proposalPages = new Set(regions.map(region => region.page));
  const uncoveredPages = [...new Set(gaps
    .filter(gap => gap.code === "TABLE_TOPOLOGY_UNKNOWN" || gap.code === "TABLE_RULING_UNSUPPORTED")
    .map(gap => gap.page))]
    .filter(page => !proposalPages.has(page));
  assertion(uncoveredPages.length === 0,
    `table abandonment gaps lack proposal regions on pages ${uncoveredPages.join(", ")}`);
}

export function boundTableProposalRegions(regions) {
  assertion(Array.isArray(regions), "table proposal regions must be an array");
  const bounded = regions.slice(0, MAX_TABLE_PROPOSALS_PER_DOCUMENT);
  const omitted = regions.length - bounded.length;
  return {
    regions: bounded,
    truncation: {
      status: omitted > 0 ? "truncated" : "complete",
      observed_regions: regions.length,
      returned_regions: bounded.length,
      omitted_regions: omitted,
    },
  };
}

/**
 * Return the renderer's deterministic structural evidence for the experimental
 * document-map layer. The caller must first validate every source layout; this
 * helper deliberately reuses the renderer's heading, table-gap, and
 * cross-page furniture rules instead of growing a second set of heuristics.
 * It performs no I/O and does not expose a new MCP tool.
 */
export function analyzeValidatedPdfPagesForDocumentMap(pages) {
  assertion(Array.isArray(pages) && pages.length > 0,
    "document-map pages must be a non-empty array");
  const furniturePlans = planDocumentPageFurniture(pages, true);
  return pages.map(page => {
    const headings = headingLevels(page);
    const headingContinuations = headingContinuationIds(page, headings);
    // A cover/title page is itself source evidence. Cross-page furniture
    // planning can correctly recognize repeated masthead lines while still
    // being wrong about their semantic role on page 1 (for example, the
    // publishing agency on a report cover). Preserve every retained page-1
    // line in the source-bound map; later pages continue to use the renderer's
    // bounded furniture rules.
    const pageFurniture = page.page === 1 ? [] : furniturePlans.get(page.page) ?? [];
    const furnitureLineIds = new Set(pageFurniture.map(entry => entry.lineId));
    const analysis = segmentPageLines(page);
    const linkState = analyzePageLinks(page, analysis, headings, furnitureLineIds);
    const unsafePage = analysis.tableReason !== null
      || linkState.unavailable
      || linkState.ambiguous
      || linkState.unsupportedTarget;
    const fractionPlan = pageStackedFractionPlan(page, analysis.segments, {
      headings,
      linkState,
      unsafePage,
    });
    const gaps = pageGaps(page, analysis, linkState, {
      mathNotReconstructed: pageMathNotReconstructed(analysis, fractionPlan),
      pageFurniture,
    });
    return {
      page: page.page,
      headings: page.lines.flatMap(line => headings.has(line.id) ? [{
        line_id: line.id,
        level: headings.get(line.id),
        text: line.text,
      }] : []),
      heading_continuation_line_ids: page.lines
        .filter(line => headingContinuations.has(line.id))
        .map(line => line.id),
      furniture: pageFurniture.map(entry => ({ ...entry })),
      table_regions: analysis.regions.map((region, index) => (
        buildTableProposalRegion(page, region.run, region.reason, index + 1)
      )),
      gaps: gaps.map(gap => ({ ...gap })),
      content_lines: page.lines
        .filter(line => !furnitureLineIds.has(line.id))
        .map(line => ({
          line_id: line.id,
          text: line.text,
          item_ids: [...line.item_ids],
          heading_level: headings.get(line.id) ?? null,
          heading_continuation: headingContinuations.has(line.id),
        })),
    };
  });
}

/**
 * Render an already source-validated PDF Tools layout IR to deterministic
 * Markdown. This function rechecks IR semantics but deliberately performs no
 * I/O, PDF parsing, rendering, OCR, or annotation lookup. Table reconstruction
 * uses the layout IR's own text-item column geometry plus independently
 * validated closed ruled-rectangle evidence. The non-rect path remains the
 * pre-1.3.0 path; the rect path never infers merged or spanning cells and
 * abandons on ambiguous geometry. Complete axis-aligned solid-mask grids are
 * independently bounded and never interpreted as merged cells or cell art.
 */
export function renderPdfLayoutToMarkdown(layout, {
  includePageBoundaries = true,
  maxMarkdownBytes = 50000,
  compact = false,
  removePageFurniture = true,
  emitTableProposals = false,
} = {}) {
  validatePdfLayoutSemantics(layout, { enforceOutputBudget: false });
  validateSupportedLayoutIdentity(layout);
  if (typeof includePageBoundaries !== "boolean") {
    throw new TypeError("includePageBoundaries must be a boolean.");
  }
  if (typeof compact !== "boolean") {
    throw new TypeError("compact must be a boolean.");
  }
  if (typeof removePageFurniture !== "boolean") {
    throw new TypeError("removePageFurniture must be a boolean.");
  }
  if (typeof emitTableProposals !== "boolean") {
    throw new TypeError("emitTableProposals must be a boolean.");
  }
  if (!Number.isSafeInteger(maxMarkdownBytes)
    || maxMarkdownBytes < 1
    || maxMarkdownBytes > MAX_MARKDOWN_BYTES_LIMIT) {
    throw new RangeError(`maxMarkdownBytes must be an integer from 1 through ${MAX_MARKDOWN_BYTES_LIMIT}.`);
  }

  const furniturePlans = planDocumentPageFurniture(layout.pages, removePageFurniture);
  const renderedPages = layout.pages.map((page, index) => renderPage(page, {
    compact,
    pageBoundaryBefore: index > 0,
    // A page boundary is a semantic boundary even when the caller omits the
    // visual HTML marker. This also lets compact mode remove a trailing footer
    // number from a single-page selection.
    pageBoundaryAfter: true,
    collectTableProposals: emitTableProposals,
    pageFurniture: furniturePlans.get(page.page),
  }));
  const gaps = renderedPages.flatMap(page => page.gaps);
  const markdown = renderDocumentMarkdown(renderedPages, includePageBoundaries, gaps);
  const markdownBytes = utf8Bytes(markdown);
  if (markdownBytes > maxMarkdownBytes) {
    // Deliberately throws rather than emitting a gap: truncating would cut a
    // line or a Unicode sequence. There is therefore no byte-limit gap code,
    // because a code the renderer can never emit would misdescribe the
    // contract to callers.
    throw new RangeError(
      `Markdown output is ${markdownBytes} UTF-8 bytes, which exceeds maxMarkdownBytes ${maxMarkdownBytes}. Request a narrower page range or raise the limit.`,
    );
  }

  const result = {
    renderer: { ...RENDERER },
    conversion_status: documentStatus(renderedPages),
    markdown,
    markdown_sha256: sha256(markdown),
    markdown_bytes: markdownBytes,
    options: {
      include_page_boundaries: includePageBoundaries,
      compact,
      remove_page_furniture: removePageFurniture,
    },
    limits: { max_markdown_bytes: maxMarkdownBytes },
    pages: renderedPages.map(({
      markdown: _markdown,
      normalizations: _normalizations,
      tableProposalRegions: _tableProposalRegions,
      ...page
    }) => page),
    gaps,
    limitations: [...LIMITATIONS],
    normalizations: aggregateNormalizations(renderedPages),
    provenance: provenanceFromLayout(layout),
  };
  if (emitTableProposals) {
    // Document-order flatten, bounded by a named per-document cap. The handler
    // adds each region's proposal_token; the renderer stays token-free and pure.
    const observedRegions = renderedPages.flatMap(page => page.tableProposalRegions ?? []);
    // A page-level abandonment gap without any source-bound region descriptor
    // would make an opt-in result claim proposal coverage it did not provide.
    // Fail closed before applying the document cap; genuine cap omissions are
    // then reported by the typed truncation sibling below.
    validateTableProposalGapCoverage(gaps, observedRegions);
    const { regions, truncation } = boundTableProposalRegions(observedRegions);
    result.table_proposal_regions = regions;
    result.table_proposals_truncation = truncation;
  }
  return validateMarkdownConversionSemantics(result, { layout });
}

export const MARKDOWN_RENDERER_IDENTITY = RENDERER;
