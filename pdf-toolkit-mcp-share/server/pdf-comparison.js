import { createHash } from "node:crypto";
import {
  PDF_OBSERVATION_COVERAGE_REASONS,
  validatePdfObservationSemantics,
} from "./pdf-observations.js";

// Bumped 0.1.0 -> 0.2.0 (schema 1.0 -> 1.1) when coverage began degrading on
// unreadable IR page status (Bug 1) and repeated-page alignment ambiguity
// (Bug 2). Coverage is wire-visible, so a change in what `supported` means is a
// behavior change and earns a deliberate version bump. The schema const in
// server/output-schemas.js mirrors both strings.
export const PDF_COMPARISON_SCHEMA_VERSION = "1.1";
export const PDF_COMPARISON_ENGINE = Object.freeze({
  name: "pdf-tools.deterministic-comparison",
  version: "0.2.0",
  parser: Object.freeze({ name: "pdfjs-dist", version: "5.4.624" }),
  renderer: Object.freeze({
    name: "native-canvas",
    scale: 1.5,
    pixel_delta_threshold: 8,
    mask_dilation_pixels: 1,
    connected_components: 8,
    minimum_component_area_pixels: 4,
    resizing: false,
  }),
  alignment_policy: "pdf-tools.page-alignment.v1",
  text_policy: "pdf-tools.extraction-ir-lines.v1",
  visual_policy: "pdf-tools.rgba-delta.v1",
  presentation_policy: "pdf-tools.material-presentation.v1",
});

export const PDF_COMPARISON_CHANNELS = Object.freeze([
  "semantic",
  "text",
  "structure",
  "form_field",
  "annotation",
  "metadata",
  "visual",
]);

export const PDF_COMPARISON_SIDES = Object.freeze(["before", "after"]);

// Reasons the comparison raises itself, rather than inheriting from a document
// observation. The visual reasons and `REPEATED_PAGE_AMBIGUITY` describe the
// run as a whole (repeated-page ambiguity is a property of the pair, not of one
// side), so they are not side-prefixed. The sided reasons below each describe
// one document's own layout extraction.
const PDF_COMPARISON_OWN_COVERAGE_REASONS = Object.freeze([
  "VISUAL_NOT_REQUESTED",
  "VISUAL_RENDERER_UNAVAILABLE",
  "VISUAL_ALIGNED_PAGE_COMPARISON_SKIPPED",
  "REPEATED_PAGE_AMBIGUITY",
]);
const PDF_COMPARISON_OWN_SIDED_COVERAGE_REASONS = Object.freeze([
  "TEXT_EXTRACTION_TRUNCATED",
  "TEXT_LAYER_FAILED",
  "TEXT_LAYER_PARTIAL",
  "EXTRACTION_FAILED",
  "EXTRACTION_PARTIAL",
]);

/*
 * Built from the observation vocabulary rather than restated beside it.
 *
 * `derivePdfComparisonCoverage` copies every reason a document observation
 * carries into a comparison channel with the side's name in front, so this set
 * has to be a superset of that vocabulary or the comparison's own semantics
 * validator rejects a payload it just built. It was not: three observation
 * reasons — `RAW_PAGE_GEOMETRY_UNAVAILABLE`, `FORM_FIELD_PAGE_GEOMETRY_PARTIAL`
 * and `ANNOTATION_PAGE_PARSE_PARTIAL` — were missing, and any document that
 * raised one turned a valid comparison into "Internal output validation
 * failed". Deriving the set closes all three and cannot drift again.
 */
export const PDF_COMPARISON_COVERAGE_REASONS = new Set([
  ...PDF_COMPARISON_OWN_COVERAGE_REASONS,
  ...PDF_COMPARISON_SIDES.flatMap(side => [
    ...Object.values(PDF_OBSERVATION_COVERAGE_REASONS).flat(),
    ...PDF_COMPARISON_OWN_SIDED_COVERAGE_REASONS,
  ].map(reason => `${side.toUpperCase()}_${reason}`)),
]);

export const PDF_COMPARISON_RENDERER = Object.freeze({
  scale: 1.5,
  pixel_delta_threshold: 8,
  mask_dilation_pixels: 1,
  connected_components: 8,
  minimum_component_area_pixels: 4,
});

function compareCodePoints(left, right) {
  return left < right ? -1 : left > right ? 1 : 0;
}

function canonical(value) {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value).sort(compareCodePoints)
      .map(key => `${JSON.stringify(key)}:${canonical(value[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

export function comparisonSha256(value) {
  return createHash("sha256").update(Buffer.isBuffer(value) ? value : canonical(value)).digest("hex");
}

function comparisonValueSha256(value) {
  if (Buffer.isBuffer(value)) return createHash("sha256").update(value).digest("hex");
  if (typeof value === "string") return createHash("sha256").update(value, "utf8").digest("hex");
  return comparisonSha256(value);
}

function comparisonEnvelopeSha256(value) {
  const envelope = structuredClone(value);
  delete envelope.comparison_sha256;
  delete envelope.resource_usage.duration_ms;
  return comparisonSha256(envelope);
}

export function normalizeComparisonText(value) {
  return String(value ?? "").normalize("NFC").replace(/\s+/g, " ").trim();
}

function tokens(value) {
  return new Set(normalizeComparisonText(value).toLocaleLowerCase("en-US")
    .split(/[^\p{L}\p{N}]+/u).filter(Boolean));
}

function jaccard(left, right) {
  const leftTokens = tokens(left);
  const rightTokens = tokens(right);
  if (leftTokens.size === 0 && rightTokens.size === 0) return 1;
  const intersection = [...leftTokens].filter(token => rightTokens.has(token)).length;
  const union = new Set([...leftTokens, ...rightTokens]).size;
  return union === 0 ? 0 : intersection / union;
}

function pageBox(page) {
  return [0, 0, page.geometry.display_width, page.geometry.display_height];
}

function pageRotation(page) {
  return page.geometry.display_rotation;
}

function pageText(page) {
  return normalizeComparisonText(page.flow_text);
}

function pageSignature(page) {
  return comparisonSha256({
    text: pageText(page),
    width: page.geometry.display_width,
    height: page.geometry.display_height,
    rotation: pageRotation(page),
  });
}

function pageLabel(page) {
  const candidates = (page.lines ?? [])
    .filter(line => normalizeComparisonText(line.text).length > 0)
    .filter(line => line.y >= page.geometry.display_height * 0.8)
    .sort((left, right) => right.y - left.y || left.x - right.x);
  const text = normalizeComparisonText(candidates[0]?.text ?? "");
  if (!text) return pageSignature(page);
  const separator = text.indexOf(":");
  return separator === -1 ? text : normalizeComparisonText(text.slice(separator + 1));
}

function pageSimilarity(before, after) {
  const textScore = jaccard(pageText(before), pageText(after));
  const widthRatio = Math.min(before.geometry.display_width, after.geometry.display_width)
    / Math.max(before.geometry.display_width, after.geometry.display_width);
  const heightRatio = Math.min(before.geometry.display_height, after.geometry.display_height)
    / Math.max(before.geometry.display_height, after.geometry.display_height);
  const geometryScore = (widthRatio + heightRatio) / 2;
  const rotationScore = pageRotation(before) === pageRotation(after) ? 1 : 0;
  return 0.75 * textScore + 0.2 * geometryScore + 0.05 * rotationScore;
}

function uniqueBy(items, keyFor) {
  const groups = new Map();
  for (const item of items) {
    const key = keyFor(item);
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(item);
  }
  return new Map([...groups].filter(([, values]) => values.length === 1)
    .map(([key, values]) => [key, values[0]]));
}

export function alignComparisonPages(beforePages, afterPages, {
  beforeCompositeAnchors = null,
  afterCompositeAnchors = null,
} = {}) {
  const unmatchedBefore = new Map(beforePages.map(page => [page.page, page]));
  const unmatchedAfter = new Map(afterPages.map(page => [page.page, page]));
  const matches = [];
  const ambiguousBefore = new Map();
  const ambiguousAfter = new Map();
  const match = (before, after, anchorDigest, matchBasis, score) => {
    unmatchedBefore.delete(before.page);
    unmatchedAfter.delete(after.page);
    matches.push({ before, after, anchor_digest: anchorDigest, match_basis: matchBasis, score });
  };

  const beforeComposite = page => beforeCompositeAnchors?.get(page.page) ?? pageSignature(page);
  const afterComposite = page => afterCompositeAnchors?.get(page.page) ?? pageSignature(page);
  for (const [beforeKeyFor, afterKeyFor, matchBasis] of [
    [beforeComposite, afterComposite, "exact_composite_anchor"],
    [pageText, pageText, "unique_normalized_text"],
  ]) {
    const beforeUnique = uniqueBy([...unmatchedBefore.values()], beforeKeyFor);
    const afterUnique = uniqueBy([...unmatchedAfter.values()], afterKeyFor);
    for (const [key, before] of beforeUnique) {
      const after = afterUnique.get(key);
      if (after) match(before, after, comparisonSha256(key), matchBasis, 1);
    }
  }

  const candidates = [];
  for (const before of unmatchedBefore.values()) {
    for (const after of unmatchedAfter.values()) {
      candidates.push({ before, after, score: pageSimilarity(before, after) });
    }
  }
  candidates.sort((left, right) => right.score - left.score
    || left.before.page - right.before.page || left.after.page - right.after.page);
  for (const candidate of candidates) {
    if (!unmatchedBefore.has(candidate.before.page) || !unmatchedAfter.has(candidate.after.page)) continue;
    const alternatives = candidates.filter(other => other !== candidate
      && unmatchedBefore.has(other.before.page) && unmatchedAfter.has(other.after.page)
      && (other.before.page === candidate.before.page || other.after.page === candidate.after.page));
    const nextScore = alternatives.length === 0 ? 0 : Math.max(...alternatives.map(item => item.score));
    if (candidate.score < 0.55 || candidate.score - nextScore < 0.1) continue;
    match(candidate.before, candidate.after, comparisonSha256({ before: pageText(candidate.before), after: pageText(candidate.after) }), "weighted_assignment", Number(candidate.score.toFixed(6)));
  }

  const repeatedBefore = new Map();
  const repeatedAfter = new Map();
  for (const page of unmatchedBefore.values()) {
    const signature = pageText(page);
    if (!repeatedBefore.has(signature)) repeatedBefore.set(signature, []);
    repeatedBefore.get(signature).push(page);
  }
  for (const page of unmatchedAfter.values()) {
    const signature = pageText(page);
    if (!repeatedAfter.has(signature)) repeatedAfter.set(signature, []);
    repeatedAfter.get(signature).push(page);
  }
  for (const [signature, beforeGroup] of repeatedBefore) {
    const afterGroup = repeatedAfter.get(signature) ?? [];
    if (beforeGroup.length < 2 || beforeGroup.length !== afterGroup.length) continue;
    const ambiguityGroup = `repeated-${comparisonSha256(signature)}`;
    for (const page of beforeGroup) ambiguousBefore.set(page.page, ambiguityGroup);
    for (const page of afterGroup) ambiguousAfter.set(page.page, ambiguityGroup);
  }

  const alignments = matches.map(item => ({
    before_page: item.before.page,
    after_page: item.after.page,
    relation: item.before.page === item.after.page ? "same" : "moved",
    anchor_digest: item.anchor_digest,
    match_basis: item.match_basis,
    score: item.score,
    ambiguity_group: null,
  }));
  for (const page of unmatchedBefore.values()) {
    const ambiguityGroup = ambiguousBefore.get(page.page) ?? null;
    alignments.push({ before_page: page.page, after_page: null, relation: "deleted", anchor_digest: beforeComposite(page), match_basis: ambiguityGroup ? "repeated_ambiguous" : "unmatched", score: ambiguityGroup ? 0 : 1, ambiguity_group: ambiguityGroup });
  }
  for (const page of unmatchedAfter.values()) {
    const ambiguityGroup = ambiguousAfter.get(page.page) ?? null;
    alignments.push({ before_page: null, after_page: page.page, relation: "inserted", anchor_digest: afterComposite(page), match_basis: ambiguityGroup ? "repeated_ambiguous" : "unmatched", score: ambiguityGroup ? 0 : 1, ambiguity_group: ambiguityGroup });
  }
  return alignments.sort((left, right) => (left.before_page ?? Number.MAX_SAFE_INTEGER)
    - (right.before_page ?? Number.MAX_SAFE_INTEGER)
    || (left.after_page ?? Number.MAX_SAFE_INTEGER) - (right.after_page ?? Number.MAX_SAFE_INTEGER));
}

function coverage(status = "supported", reasonCodes = []) {
  return { status, reason_codes: [...new Set(reasonCodes)].sort(compareCodePoints) };
}

// Never let a channel's status improve: unavailable outranks partial, which
// outranks supported. Every degradation in this function goes through here so
// the ordering is applied once.
const COVERAGE_STATUS_RANK = Object.freeze({ supported: 0, partial: 1, unavailable: 2 });
function raiseCoverage(entry, status, reasonCode) {
  if (COVERAGE_STATUS_RANK[status] > COVERAGE_STATUS_RANK[entry.status]) entry.status = status;
  entry.reason_codes.push(reasonCode);
}

export function derivePdfComparisonCoverage(documents, includeVisual, alignments = []) {
  const result = Object.fromEntries(PDF_COMPARISON_CHANNELS.map(channel => [channel, coverage()]));
  const mapping = {
    metadata: "metadata",
    form_field: "form_fields",
    annotation: "annotations",
    structure: "pages",
  };
  for (const [channel, observationChannel] of Object.entries(mapping)) {
    for (const document of documents) {
      const source = document.observation.coverage[observationChannel];
      if (source.status === "unavailable") result[channel].status = "unavailable";
      else if (source.status === "partial" && result[channel].status !== "unavailable") {
        result[channel].status = "partial";
      }
      result[channel].reason_codes.push(...source.reason_codes.map(reason => `${document.side.toUpperCase()}_${reason}`));
    }
  }
  for (const document of documents) {
    if (document.layout.truncation.truncated || document.layout.pages.some(page => page.truncation.truncated)) {
      for (const channel of ["semantic", "text"]) {
        result[channel].status = "partial";
        result[channel].reason_codes.push(`${document.side.toUpperCase()}_TEXT_EXTRACTION_TRUNCATED`);
      }
    }
  }
  // Bug 1: the truncation check above only catches a text layer the extractor
  // deliberately cut short. It ignores the IR page's own `text_layer_status`
  // and `extraction_status`, so a page whose text layer or extraction *failed*
  // (or was only partial) — a scanned/image-only page, a page the parser could
  // not read — still reported `supported` semantic and text coverage. The
  // guiding rule is that we must never claim `supported` for a page the text
  // channel could not read. A `failed` status means the page produced no
  // observable text at all, so it contributes `unavailable` (matching how an
  // unavailable observation channel already propagates here); a `partial`
  // status contributes `partial`. Structure is left to the observation-derived
  // `pages` channel above; only the two text-bearing channels degrade here.
  for (const document of documents) {
    const side = document.side.toUpperCase();
    const conditions = [
      ["unavailable", page => page.text_layer_status === "failed", `${side}_TEXT_LAYER_FAILED`],
      ["unavailable", page => page.extraction_status === "failed", `${side}_EXTRACTION_FAILED`],
      ["partial", page => page.text_layer_status === "partial", `${side}_TEXT_LAYER_PARTIAL`],
      ["partial", page => page.extraction_status === "partial", `${side}_EXTRACTION_PARTIAL`],
    ];
    for (const [status, predicate, reasonCode] of conditions) {
      if (!document.layout.pages.some(predicate)) continue;
      for (const channel of ["semantic", "text"]) raiseCoverage(result[channel], status, reasonCode);
    }
  }
  // Bug 2: a `repeated_ambiguous` alignment is a repeated/template page the
  // engine refused to guess a partner for. Such pages are excluded from aligned
  // text comparison and from inserted/deleted structure detection, so their
  // content was never compared. Surfacing that as partial coverage on the three
  // channels whose per-page comparison was skipped keeps every consumer honest;
  // the ambiguity is a property of the pair, so the reason is not side-prefixed.
  if (alignments.some(alignment => alignment.match_basis === "repeated_ambiguous")) {
    for (const channel of ["semantic", "text", "structure"]) {
      raiseCoverage(result[channel], "partial", "REPEATED_PAGE_AMBIGUITY");
    }
  }
  if (!includeVisual) {
    result.visual = coverage("unavailable", ["VISUAL_NOT_REQUESTED"]);
  } else if (documents.some(document => document.renders.some(render => !render?.binary))) {
    result.visual = coverage("unavailable", ["VISUAL_RENDERER_UNAVAILABLE"]);
  }
  for (const channel of PDF_COMPARISON_CHANNELS) {
    result[channel].reason_codes = [...new Set(result[channel].reason_codes)].sort(compareCodePoints);
  }
  return result;
}

function rect(line, page) {
  if (line && [line.x, line.y, line.width, line.height].every(Number.isFinite)
    && line.width > 0 && line.height > 0) {
    return [line.x, line.y, line.width, line.height];
  }
  return pageBox(page);
}

function scalarValue(text) {
  const value = normalizeComparisonText(text.includes(":") ? text.slice(text.indexOf(":") + 1) : text);
  const patterns = [
    ["currency", /^(?:USD|EUR|GBP|CAD|AUD|JPY|[$€£])\s*[+-]?[\d,.]+$/i],
    ["date", /^(?:\d{4}-\d{2}-\d{2}|\d{1,2}[/-]\d{1,2}[/-]\d{2,4}|(?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)[a-z]*\s+\d{1,2},?\s+\d{4})$/i],
    ["duration", /^[+-]?[\d,.]+\s+(?:days?|hours?|weeks?|months?|years?)$/i],
    ["percentage", /^[+-]?[\d,.]+\s*%$/],
    ["number", /^[+-]?[\d,.]+$/],
    ["negation", /^(?:no|not|none|never|without|false)$/i],
  ];
  const kind = patterns.find(([, pattern]) => pattern.test(value))?.[0] ?? null;
  return { kind, value };
}

function cropRgba(render, region) {
  const scale = render.scale;
  const x0 = Math.max(0, Math.floor(region[0] * scale));
  const y0 = Math.max(0, Math.floor(region[1] * scale));
  const x1 = Math.min(render.width, Math.ceil((region[0] + region[2]) * scale));
  const y1 = Math.min(render.height, Math.ceil((region[1] + region[3]) * scale));
  const bytes = Buffer.alloc(Math.max(0, x1 - x0) * Math.max(0, y1 - y0) * 4);
  let offset = 0;
  for (let y = y0; y < y1; y += 1) {
    const start = (y * render.width + x0) * 4;
    const end = (y * render.width + x1) * 4;
    render.binary.copy(bytes, offset, start, end);
    offset += end - start;
  }
  return { bytes, sha256: comparisonSha256(bytes) };
}

function comparisonRenderLogicalExtent(render) {
  const pageView = render?.page_view;
  const pageWidth = pageView?.width_points;
  const pageHeight = pageView?.height_points;
  const rawPageWidth = render?.comparison_view?.raw_width_pixels;
  const rawPageHeight = render?.comparison_view?.raw_height_pixels;
  const viewBox = pageView?.view_box;
  const rotation = pageView?.rotation;
  const userUnit = pageView?.user_unit;
  const requested = render?.requested_region;
  const rendered = render?.rendered_region;
  if (render?.renderer !== PDF_COMPARISON_ENGINE.renderer.name
    || render?.scale !== PDF_COMPARISON_RENDERER.scale
    || pageView?.coordinate_space !== "pdfjs_viewport_top_left_points"
    || !Array.isArray(viewBox) || viewBox.length !== 4 || !viewBox.every(Number.isFinite)
    || viewBox[2] <= viewBox[0] || viewBox[3] <= viewBox[1]
    || ![0, 90, 180, 270].includes(rotation)
    || !Number.isFinite(userUnit) || userUnit <= 0
    || !Number.isFinite(pageWidth) || pageWidth <= 0
    || !Number.isFinite(pageHeight) || pageHeight <= 0
    || !Number.isFinite(rawPageWidth) || rawPageWidth <= 0
    || !Number.isFinite(rawPageHeight) || rawPageHeight <= 0
    || !requested || requested.x !== 0 || requested.y !== 0
    || requested.width !== pageWidth || requested.height !== pageHeight
    || !Number.isSafeInteger(render.width) || render.width <= 0
    || !Number.isSafeInteger(render.height) || render.height <= 0
    || !rendered || rendered.x !== 0 || rendered.y !== 0
    || rendered.width !== render.width || rendered.height !== render.height
    || Math.ceil(rawPageWidth) !== render.width
    || Math.ceil(rawPageHeight) !== render.height) return null;
  const exactPageWidth = rawPageWidth / render.scale;
  const exactPageHeight = rawPageHeight / render.scale;
  const roundsToPublished = (exact, published) => Math.abs(exact - published)
    <= 0.00000051 + Number.EPSILON * Math.max(1, Math.abs(exact), Math.abs(published));
  if (!roundsToPublished(exactPageWidth, pageWidth)
    || !roundsToPublished(exactPageHeight, pageHeight)) return null;
  const nativeWidth = (viewBox[2] - viewBox[0]) * userUnit;
  const nativeHeight = (viewBox[3] - viewBox[1]) * userUnit;
  const expectedWidth = rotation % 180 === 0 ? nativeWidth : nativeHeight;
  const expectedHeight = rotation % 180 === 0 ? nativeHeight : nativeWidth;
  const nearlyEqual = (left, right) => Math.abs(left - right)
    <= 0.000001 * Math.max(1, Math.abs(left), Math.abs(right));
  if (!Number.isFinite(expectedWidth) || !Number.isFinite(expectedHeight)
    || !nearlyEqual(pageWidth, expectedWidth)
    || !nearlyEqual(pageHeight, expectedHeight)) return null;
  return { width: exactPageWidth, height: exactPageHeight };
}

function comparisonSharedLogicalExtent(before, after) {
  const beforeExtent = comparisonRenderLogicalExtent(before);
  const afterExtent = comparisonRenderLogicalExtent(after);
  if (!beforeExtent || !afterExtent
    || canonical(before.page_view) !== canonical(after.page_view)
    || canonical(before.comparison_view) !== canonical(after.comparison_view)
    || canonical(before.requested_region) !== canonical(after.requested_region)
    || beforeExtent.width !== afterExtent.width
    || beforeExtent.height !== afterExtent.height) return null;
  return beforeExtent;
}

function comparisonIgnoredPixelMask(render, regions, logicalExtent) {
  const mask = new Uint8Array(render.width * render.height);
  if (!logicalExtent) return mask;
  const clamp = (value, maximum) => Math.max(0, Math.min(maximum, value));
  for (const region of regions) {
    if (!Array.isArray(region) || region.length !== 4 || !region.every(Number.isFinite)
      || region[2] <= 0 || region[3] <= 0) continue;
    const regionRight = region[0] + region[2];
    const regionBottom = region[1] + region[3];
    if (regionRight <= 0 || regionBottom <= 0
      || region[0] >= logicalExtent.width
      || region[1] >= logicalExtent.height) continue;
    const x0 = clamp(Math.floor(region[0] * render.scale) - 1, render.width);
    const y0 = clamp(Math.floor(region[1] * render.scale) - 1, render.height);
    const x1 = clamp(Math.ceil((region[0] + region[2]) * render.scale) + 1, render.width);
    const y1 = clamp(Math.ceil((region[1] + region[3]) * render.scale) + 1, render.height);
    if (x1 <= x0 || y1 <= y0) continue;
    for (let y = y0; y < y1; y += 1) {
      mask.fill(1, y * render.width + x0, y * render.width + x1);
    }
  }
  return mask;
}

export function diffComparisonRgba(before, after, ignoredRegions = []) {
  if (before.width !== after.width || before.height !== after.height) {
    return { dimension_mismatch: true, raw_changed_pixels: null, changed_pixels: null, changed_fraction: null, bounds: null, components: [] };
  }
  const pixelCount = before.width * before.height;
  const ignoredPixels = comparisonIgnoredPixelMask(
    before,
    ignoredRegions,
    comparisonSharedLogicalExtent(before, after),
  );
  const threshold = new Uint8Array(pixelCount);
  let rawChangedPixels = 0;
  for (let pixel = 0; pixel < pixelCount; pixel += 1) {
    if (ignoredPixels[pixel]) continue;
    const offset = pixel * 4;
    let maximumDelta = 0;
    for (let channel = 0; channel < 4; channel += 1) {
      maximumDelta = Math.max(maximumDelta, Math.abs(before.binary[offset + channel] - after.binary[offset + channel]));
    }
    if (maximumDelta <= PDF_COMPARISON_RENDERER.pixel_delta_threshold) continue;
    threshold[pixel] = 1;
    rawChangedPixels += 1;
  }
  const dilated = new Uint8Array(pixelCount);
  for (let pixel = 0; pixel < pixelCount; pixel += 1) {
    if (!threshold[pixel]) continue;
    const x = pixel % before.width;
    const y = Math.floor(pixel / before.width);
    for (let dy = -1; dy <= 1; dy += 1) {
      for (let dx = -1; dx <= 1; dx += 1) {
        const targetX = x + dx;
        const targetY = y + dy;
        if (targetX >= 0 && targetX < before.width && targetY >= 0 && targetY < before.height) {
          dilated[targetY * before.width + targetX] = 1;
        }
      }
    }
  }
  const visited = new Uint8Array(pixelCount);
  const components = [];
  let changedPixels = 0;
  for (let start = 0; start < pixelCount; start += 1) {
    if (!dilated[start] || visited[start]) continue;
    const stack = [start];
    visited[start] = 1;
    let area = 0;
    let minX = before.width;
    let minY = before.height;
    let maxX = -1;
    let maxY = -1;
    while (stack.length > 0) {
      const pixel = stack.pop();
      const x = pixel % before.width;
      const y = Math.floor(pixel / before.width);
      area += 1;
      minX = Math.min(minX, x); minY = Math.min(minY, y);
      maxX = Math.max(maxX, x); maxY = Math.max(maxY, y);
      for (let dy = -1; dy <= 1; dy += 1) {
        for (let dx = -1; dx <= 1; dx += 1) {
          if (dx === 0 && dy === 0) continue;
          const targetX = x + dx;
          const targetY = y + dy;
          if (targetX < 0 || targetX >= before.width || targetY < 0 || targetY >= before.height) continue;
          const target = targetY * before.width + targetX;
          if (dilated[target] && !visited[target]) { visited[target] = 1; stack.push(target); }
        }
      }
    }
    if (area < PDF_COMPARISON_RENDERER.minimum_component_area_pixels) continue;
    changedPixels += area;
    components.push({
      area_pixels: area,
      bounds: [minX / before.scale, minY / before.scale, (maxX - minX + 1) / before.scale, (maxY - minY + 1) / before.scale],
    });
  }
  components.sort((left, right) => right.area_pixels - left.area_pixels
    || left.bounds[1] - right.bounds[1] || left.bounds[0] - right.bounds[0]);
  const bounds = components.length === 0 ? null : components.reduce((result, component) => {
    const [x, y, width, height] = component.bounds;
    if (!result) return [x, y, width, height];
    const right = Math.max(result[0] + result[2], x + width);
    const bottom = Math.max(result[1] + result[3], y + height);
    result[0] = Math.min(result[0], x); result[1] = Math.min(result[1], y);
    result[2] = right - result[0]; result[3] = bottom - result[1];
    return result;
  }, null);
  return { dimension_mismatch: false, raw_changed_pixels: rawChangedPixels, changed_pixels: changedPixels, changed_fraction: changedPixels / pixelCount, bounds, components };
}

function createState(mode, before, after) {
  return { mode, before, after, observations: [], changes: [], observationSequence: 1, changeSequence: 1 };
}

function observe(state, side, channel, page, pageValue, region, value, raw) {
  const document = side === "before" ? state.before : state.after;
  const id = `evidence.${channel}.${String(state.observationSequence).padStart(6, "0")}`;
  state.observationSequence += 1;
  const observation = {
    id,
    channel,
    side,
    document_sha256: document.observation.source.sha256,
    page: page.page,
    page_box: pageBox(page),
    rotation: pageRotation(page),
    coordinate_space: "pdfjs_viewport_top_left_points",
    native_region: pageValue,
    display_region: region,
    canonical_value: Buffer.isBuffer(value)
      ? { binary_bytes: value.length, binary_sha256: comparisonSha256(value) }
      : value,
    value_sha256: comparisonValueSha256(value),
    raw_result_sha256: comparisonSha256({ source_sha256: document.observation.source.sha256, raw }),
  };
  observation.observation_sha256 = comparisonSha256(observation);
  state.observations.push(observation);
  return id;
}

function addChange(state, kind, operation, salience, summary, facets, suppressionReason = null) {
  const id = `change.${String(state.changeSequence).padStart(6, "0")}`;
  state.changeSequence += 1;
  const disposition = state.mode === "forensic" || suppressionReason === null ? "report" : "suppress";
  state.changes.push({
    id, kind, operation, salience, summary, facets,
    presentation: {
      mode: state.mode,
      disposition,
      reversible_reason_code: suppressionReason,
    },
  });
}

function pairLines(beforePage, afterPage) {
  const before = (beforePage.lines ?? []).filter(line => normalizeComparisonText(line.text));
  const after = (afterPage.lines ?? []).filter(line => normalizeComparisonText(line.text));
  const remainingBefore = new Set(before);
  const remainingAfter = new Set(after);
  const pairs = [];
  const beforeExact = uniqueBy(before, line => normalizeComparisonText(line.text));
  const afterExact = uniqueBy(after, line => normalizeComparisonText(line.text));
  for (const [text, left] of beforeExact) {
    const right = afterExact.get(text);
    if (!right) continue;
    remainingBefore.delete(left); remainingAfter.delete(right); pairs.push({ before: left, after: right });
  }
  const candidates = [];
  for (const left of remainingBefore) {
    for (const right of remainingAfter) {
      const distance = Math.hypot(left.x - right.x, left.y - right.y);
      const size = Math.max(left.height, right.height, 1);
      candidates.push({ left, right, score: distance / size });
    }
  }
  candidates.sort((left, right) => left.score - right.score
    || left.left.source_first_index - right.left.source_first_index
    || left.right.source_first_index - right.right.source_first_index);
  for (const candidate of candidates) {
    if (!remainingBefore.has(candidate.left) || !remainingAfter.has(candidate.right)) continue;
    if (candidate.score > 4) continue;
    remainingBefore.delete(candidate.left); remainingAfter.delete(candidate.right);
    pairs.push({ before: candidate.left, after: candidate.right });
  }
  return { pairs, removed: [...remainingBefore], added: [...remainingAfter] };
}

function alignedPagePairs(before, after, alignments) {
  const beforeByPage = new Map(before.layout.pages.map(page => [page.page, page]));
  const afterByPage = new Map(after.layout.pages.map(page => [page.page, page]));
  return alignments.filter(item => item.before_page !== null && item.after_page !== null).map(item => ({
    alignment: item,
    beforePage: beforeByPage.get(item.before_page),
    afterPage: afterByPage.get(item.after_page),
    beforeRender: before.renders[item.before_page - 1] ?? null,
    afterRender: after.renders[item.after_page - 1] ?? null,
  }));
}

function detectText(state, pairs, includeVisual) {
  let contentChanges = 0;
  for (const pair of pairs) {
    const matched = pairLines(pair.beforePage, pair.afterPage);
    for (const lines of matched.pairs) {
      const beforeText = normalizeComparisonText(lines.before.text);
      const afterText = normalizeComparisonText(lines.after.text);
      if (beforeText === afterText) continue;
      const beforeScalar = scalarValue(beforeText);
      const afterScalar = scalarValue(afterText);
      const semantic = beforeScalar.kind !== null && beforeScalar.kind === afterScalar.kind;
      const beforeRegion = rect(lines.before, pair.beforePage);
      const afterRegion = rect(lines.after, pair.afterPage);
      const facets = [];
      if (semantic) facets.push({
        channel: "semantic", operation: "modified",
        before_evidence_id: observe(state, "before", "semantic", pair.beforePage, null, beforeRegion, beforeScalar.value, beforeScalar),
        after_evidence_id: observe(state, "after", "semantic", pair.afterPage, null, afterRegion, afterScalar.value, afterScalar),
      });
      facets.push({
        channel: "text", operation: "modified",
        before_evidence_id: observe(state, "before", "text", pair.beforePage, null, beforeRegion, beforeScalar.value, lines.before),
        after_evidence_id: observe(state, "after", "text", pair.afterPage, null, afterRegion, afterScalar.value, lines.after),
      });
      if (includeVisual && pair.beforeRender && pair.afterRender) {
        const beforeCrop = cropRgba(pair.beforeRender, beforeRegion);
        const afterCrop = cropRgba(pair.afterRender, afterRegion);
        facets.push({
          channel: "visual", operation: "modified",
          before_evidence_id: observe(state, "before", "visual", pair.beforePage, null, beforeRegion, beforeCrop.bytes, { sha256: beforeCrop.sha256 }),
          after_evidence_id: observe(state, "after", "visual", pair.afterPage, null, afterRegion, afterCrop.bytes, { sha256: afterCrop.sha256 }),
        });
      }
      addChange(state, semantic ? "semantic_text" : "text", "modified", semantic ? "material" : "unknown", `Text changes from ${JSON.stringify(beforeText)} to ${JSON.stringify(afterText)}.`, facets);
      contentChanges += 1;
    }
    for (const [operation, side, lines] of [["removed", "before", matched.removed], ["added", "after", matched.added]]) {
      for (const line of lines) {
        const page = side === "before" ? pair.beforePage : pair.afterPage;
        const text = normalizeComparisonText(line.text);
        const evidence = observe(state, side, "text", page, null, rect(line, page), text, line);
        addChange(state, "text", operation, "unknown", `Text ${operation}: ${JSON.stringify(text)}.`, [{
          channel: "text", operation,
          before_evidence_id: side === "before" ? evidence : null,
          after_evidence_id: side === "after" ? evidence : null,
        }]);
        contentChanges += 1;
      }
    }
  }
  return contentChanges;
}

function fieldKey(item) {
  return item.record_kind === "field"
    ? canonical([item.record_kind, item.name])
    : canonical([item.record_kind, item.name, item.source_object_id, item.widget_page]);
}

function annotationKey(item) {
  return canonical([item.subtype, item.contents, item.target_kind, item.target_value, item.flags,
    item.page, item.native_region, item.display_region, item.quad_points]);
}

function regionArray(value) {
  if (!value || typeof value !== "object") return null;
  const { x, y, width, height } = value;
  return [x, y, width, height].every(Number.isFinite) && width > 0 && height > 0
    ? [x, y, width, height]
    : null;
}

function nativeRegionArray(value) {
  if (!value || typeof value !== "object") return null;
  const { x1, y1, x2, y2 } = value;
  return [x1, y1, x2, y2].every(Number.isFinite) && x2 > x1 && y2 > y1
    ? [x1, y1, x2 - x1, y2 - y1]
    : null;
}

function observationPage(document, number) {
  return document.layout.pages[number - 1] ?? document.layout.pages[0];
}

function renderFor(state, side, page) {
  const document = side === "before" ? state.before : state.after;
  return document.renders[page.page - 1] ?? null;
}

function detectRecordChanges(state, channel, beforeItems, afterItems, keyFor, valueFor, summaryFor, includeVisual = false, evidenceValueFor = valueFor) {
  let changes = 0;
  const indexRecords = (items) => {
    const occurrences = new Map();
    return new Map(items.map(item => {
      const base = keyFor(item);
      const occurrence = occurrences.get(base) ?? 0;
      occurrences.set(base, occurrence + 1);
      return [canonical([base, occurrence]), item];
    }));
  };
  const beforeByKey = indexRecords(beforeItems);
  const afterByKey = indexRecords(afterItems);
  for (const key of new Set([...beforeByKey.keys(), ...afterByKey.keys()])) {
    const beforeItem = beforeByKey.get(key) ?? null;
    const afterItem = afterByKey.get(key) ?? null;
    if (beforeItem && afterItem && canonical(valueFor(beforeItem)) === canonical(valueFor(afterItem))) continue;
    const operation = beforeItem && afterItem ? "modified" : beforeItem ? "removed" : "added";
    const beforePage = beforeItem ? observationPage(state.before, beforeItem.widget_page ?? beforeItem.page ?? 1) : null;
    const afterPage = afterItem ? observationPage(state.after, afterItem.widget_page ?? afterItem.page ?? 1) : null;
    const beforeRegion = regionArray(beforeItem?.widget_display_region)
      ?? regionArray(beforeItem?.display_region) ?? (beforePage ? pageBox(beforePage) : null);
    const afterRegion = regionArray(afterItem?.widget_display_region)
      ?? regionArray(afterItem?.display_region) ?? (afterPage ? pageBox(afterPage) : null);
    const beforeNativeRegion = nativeRegionArray(beforeItem?.widget_native_region)
      ?? nativeRegionArray(beforeItem?.native_region);
    const afterNativeRegion = nativeRegionArray(afterItem?.widget_native_region)
      ?? nativeRegionArray(afterItem?.native_region);
    const beforeEvidence = beforeItem ? observe(state, "before", channel, beforePage, beforeNativeRegion, beforeRegion, evidenceValueFor(beforeItem), beforeItem) : null;
    const afterEvidence = afterItem ? observe(state, "after", channel, afterPage, afterNativeRegion, afterRegion, evidenceValueFor(afterItem), afterItem) : null;
    const facets = [{
      channel, operation, before_evidence_id: beforeEvidence, after_evidence_id: afterEvidence,
    }];
    if (includeVisual && beforePage && afterPage && beforeRegion && afterRegion) {
      const beforeRender = renderFor(state, "before", beforePage);
      const afterRender = renderFor(state, "after", afterPage);
      if (beforeRender && afterRender) {
        const beforeCrop = cropRgba(beforeRender, beforeRegion);
        const afterCrop = cropRgba(afterRender, afterRegion);
        facets.push({
          channel: "visual", operation: "modified",
          before_evidence_id: observe(state, "before", "visual", beforePage, null, beforeRegion, beforeCrop.bytes, { sha256: beforeCrop.sha256 }),
          after_evidence_id: observe(state, "after", "visual", afterPage, null, afterRegion, afterCrop.bytes, { sha256: afterCrop.sha256 }),
        });
      }
    }
    addChange(state, channel, operation, channel === "form_field" ? "material" : "minor", summaryFor(beforeItem, afterItem, operation), facets);
    changes += 1;
  }
  return changes;
}

function detectFormChanges(state, includeVisual, alignments) {
  const beforeItems = state.before.observation.form_fields.items;
  const afterItems = state.after.observation.form_fields.items;
  const grouped = (items) => {
    const occurrences = new Map();
    return new Map(items.map(item => {
      const base = fieldKey(item);
      const occurrence = occurrences.get(base) ?? 0;
      occurrences.set(base, occurrence + 1);
      return [canonical([base, occurrence]), item];
    }));
  };
  const beforeByKey = grouped(beforeItems);
  const afterByKey = grouped(afterItems);
  let changes = 0;
  // `appearance_state` (the widget `/AS`) is captured on every observation
  // (output-schemas.js:263) but is NOT compared here, and adding it to this
  // list would not help. For CHECKBOX widgets the pinned pdfjs 5.4.624 resolves
  // `fieldValue` from `/AS`, so the observed `value` already reflects the
  // displayed state (even when a file's `/V` and `/AS` disagree, `value`
  // follows `/AS`); comparing `appearance_state` too would only duplicate that
  // change. That redundancy is pinned by test/compare-pdfs-coverage.test.js.
  //
  // KNOWN GAP (not redundancy): for RADIO groups pdfjs does not expose
  // per-widget `appearanceState`, and `fieldValue` is the shared parent `/V`
  // for every widget. So `appearance_state` falls back to that same shared
  // `fieldValue`, and a per-widget `/AS` change with an unchanged group `/V`
  // changes neither `value` nor the fallback `appearance_state` — it is NOT
  // detected. Adding `appearance_state` to `properties` cannot close this,
  // because the observed value is the same fallback; detecting it requires
  // capturing the real per-widget `/AS` in the observation layer. Tracked as a
  // separate follow-up; named honestly in docs/MCP_CONTRACT.md rather than
  // claimed as covered.
  const properties = ["type", "value", "default_value", "options", "flags", "widget_page",
    "widget_native_region", "widget_display_region", "rotation"];
  for (const key of new Set([...beforeByKey.keys(), ...afterByKey.keys()])) {
    const beforeItem = beforeByKey.get(key) ?? null;
    const afterItem = afterByKey.get(key) ?? null;
    const changedProperties = beforeItem && afterItem
      ? properties.filter(property => canonical(beforeItem[property]) !== canonical(afterItem[property]))
      : ["record"];
    const logicalChangedProperties = changedProperties.filter(property => property !== "widget_page"
      || !alignments.some(alignment => alignment.before_page === beforeItem?.widget_page
        && alignment.after_page === afterItem?.widget_page));
    for (const property of logicalChangedProperties) {
      const operation = beforeItem && afterItem ? "modified" : beforeItem ? "removed" : "added";
      const beforePage = beforeItem ? observationPage(state.before, beforeItem.widget_page ?? 1) : null;
      const afterPage = afterItem ? observationPage(state.after, afterItem.widget_page ?? 1) : null;
      const beforeRegion = regionArray(beforeItem?.widget_display_region) ?? (beforePage ? pageBox(beforePage) : null);
      const afterRegion = regionArray(afterItem?.widget_display_region) ?? (afterPage ? pageBox(afterPage) : null);
      const beforeNativeRegion = nativeRegionArray(beforeItem?.widget_native_region);
      const afterNativeRegion = nativeRegionArray(afterItem?.widget_native_region);
      const beforeValue = property === "record" ? beforeItem : beforeItem?.[property];
      const afterValue = property === "record" ? afterItem : afterItem?.[property];
      const beforeEvidence = beforeItem ? observe(state, "before", "form_field", beforePage, beforeNativeRegion, beforeRegion, beforeValue, beforeItem) : null;
      const afterEvidence = afterItem ? observe(state, "after", "form_field", afterPage, afterNativeRegion, afterRegion, afterValue, afterItem) : null;
      const facets = [{ channel: "form_field", operation, before_evidence_id: beforeEvidence, after_evidence_id: afterEvidence }];
      if (includeVisual && property === "value" && beforePage && afterPage) {
        const beforeRender = renderFor(state, "before", beforePage);
        const afterRender = renderFor(state, "after", afterPage);
        if (beforeRender && afterRender) {
          const beforeCrop = cropRgba(beforeRender, beforeRegion);
          const afterCrop = cropRgba(afterRender, afterRegion);
          facets.push({
            channel: "visual", operation: "modified",
            before_evidence_id: observe(state, "before", "visual", beforePage, null, beforeRegion, beforeCrop.bytes, { sha256: beforeCrop.sha256 }),
            after_evidence_id: observe(state, "after", "visual", afterPage, null, afterRegion, afterCrop.bytes, { sha256: afterCrop.sha256 }),
          });
        }
      }
      addChange(state, property.includes("widget") || property === "rotation" ? "widget" : "form_field", operation, "material", `Form field ${JSON.stringify(beforeItem?.name ?? afterItem?.name ?? "")} ${property} ${operation}.`, facets);
      changes += 1;
    }
  }
  return changes;
}

function detectMetadata(state) {
  const sources = ["info", "xmp"];
  for (const source of sources) {
    const before = state.before.observation.metadata[source].values;
    const after = state.after.observation.metadata[source].values;
    for (const key of new Set([...Object.keys(before), ...Object.keys(after)])) {
      if (canonical(before[key]) === canonical(after[key])) continue;
      const beforePage = state.before.layout.pages[0];
      const afterPage = state.after.layout.pages[0];
      const beforeEvidence = Object.hasOwn(before, key) ? observe(state, "before", "metadata", beforePage, null, pageBox(beforePage), before[key], { source, key, value: before[key] }) : null;
      const afterEvidence = Object.hasOwn(after, key) ? observe(state, "after", "metadata", afterPage, null, pageBox(afterPage), after[key], { source, key, value: after[key] }) : null;
      const operation = beforeEvidence && afterEvidence ? "modified" : beforeEvidence ? "removed" : "added";
      const volatile = new Set(["CreationDate", "ModDate", "Producer", "Creator"]).has(key);
      addChange(state, "metadata", operation, volatile ? "noise" : "minor", `${key} ${source} metadata ${operation}.`, [{ channel: "metadata", operation, before_evidence_id: beforeEvidence, after_evidence_id: afterEvidence }], volatile ? "VOLATILE_METADATA" : "METADATA_ONLY_DEFAULT");
    }
  }
  const beforeDisagreements = state.before.observation.metadata.disagreements;
  const afterDisagreements = state.after.observation.metadata.disagreements;
  if (canonical(beforeDisagreements) !== canonical(afterDisagreements)) {
    const beforePage = state.before.layout.pages[0];
    const afterPage = state.after.layout.pages[0];
    addChange(state, "metadata", "modified", "minor", "Info and XMP metadata disagreements change.", [{
      channel: "metadata",
      operation: "modified",
      before_evidence_id: observe(state, "before", "metadata", beforePage, null, pageBox(beforePage), beforeDisagreements, { disagreements: beforeDisagreements }),
      after_evidence_id: observe(state, "after", "metadata", afterPage, null, pageBox(afterPage), afterDisagreements, { disagreements: afterDisagreements }),
    }]);
  }
}

function detectStructure(state, alignments) {
  const moved = alignments.filter(item => item.relation === "moved");
  if (moved.length > 0) {
    const beforePage = state.before.layout.pages[moved[0].before_page - 1];
    const afterPage = state.after.layout.pages[moved[0].after_page - 1];
    const beforeSequence = state.before.layout.pages.map(pageLabel).join("|");
    const afterSequence = state.after.layout.pages.map(pageLabel).join("|");
    addChange(state, "structure", "moved", "material", "Page order changes between the two documents.", [{
      channel: "structure", operation: "moved",
      before_evidence_id: observe(state, "before", "structure", beforePage, null, pageBox(beforePage), beforeSequence, { sequence: beforeSequence }),
      after_evidence_id: observe(state, "after", "structure", afterPage, null, pageBox(afterPage), afterSequence, { sequence: afterSequence }),
    }]);
  }
  for (const alignment of alignments.filter(item => ["inserted", "deleted"].includes(item.relation)
    && item.ambiguity_group === null)) {
    const side = alignment.relation === "deleted" ? "before" : "after";
    const page = side === "before" ? state.before.layout.pages[alignment.before_page - 1] : state.after.layout.pages[alignment.after_page - 1];
    const evidence = observe(state, side, "structure", page, null, pageBox(page), pageSignature(page), page.geometry);
    addChange(state, "structure", alignment.relation === "deleted" ? "removed" : "added", "material", `Page ${alignment.relation}.`, [{
      channel: "structure", operation: alignment.relation === "deleted" ? "removed" : "added",
      before_evidence_id: side === "before" ? evidence : null,
      after_evidence_id: side === "after" ? evidence : null,
    }]);
  }
  for (const alignment of alignments.filter(item => item.before_page !== null && item.after_page !== null)) {
    const beforePage = state.before.layout.pages[alignment.before_page - 1];
    const afterPage = state.after.layout.pages[alignment.after_page - 1];
    const { page: _beforePageNumber, ...beforeGeometry } = beforePage.geometry;
    const { page: _afterPageNumber, ...afterGeometry } = afterPage.geometry;
    if (canonical(beforeGeometry) === canonical(afterGeometry)) continue;
    addChange(state, "structure", "modified", "material", "Aligned page geometry changes between the two documents.", [{
      channel: "structure", operation: "modified",
      before_evidence_id: observe(state, "before", "structure", beforePage, null, pageBox(beforePage), beforeGeometry, beforeGeometry),
      after_evidence_id: observe(state, "after", "structure", afterPage, null, pageBox(afterPage), afterGeometry, afterGeometry),
    }]);
  }
}

function residualVisualIgnoredRegions(state, pair) {
  const observations = new Map(state.observations.map(observation => [observation.id, observation]));
  const regions = [];
  const addRegion = (id, side, page) => {
    if (!id) return;
    const observation = observations.get(id);
    if (observation?.side === side && observation.page === page) regions.push(observation.display_region);
  };
  for (const change of state.changes) {
    for (const facet of change.facets) {
      if (!["text", "form_field", "annotation"].includes(facet.channel)) continue;
      addRegion(facet.before_evidence_id, "before", pair.beforePage.page);
      addRegion(facet.after_evidence_id, "after", pair.afterPage.page);
    }
  }
  return [...new Map(regions.map(region => [canonical(region), region])).values()];
}

function detectResidualVisual(state, pairs, includeVisual) {
  const analysis = { requested: includeVisual ? pairs.length : 0, completed: 0 };
  if (!includeVisual) return analysis;
  for (const pair of pairs) {
    if (!pair.beforeRender || !pair.afterRender) continue;
    analysis.completed += 1;
    const ignoredRegions = residualVisualIgnoredRegions(state, pair);
    const difference = diffComparisonRgba(pair.beforeRender, pair.afterRender, ignoredRegions);
    if (!difference.dimension_mismatch && difference.changed_pixels === 0) continue;
    const textEqual = pageText(pair.beforePage) === pageText(pair.afterPage);
    const layoutNoise = textEqual && difference.components.length > 3;
    const region = difference.dimension_mismatch || layoutNoise ? pageBox(pair.beforePage) : difference.bounds;
    const beforeCrop = cropRgba(pair.beforeRender, region);
    const afterCrop = cropRgba(pair.afterRender, region);
    addChange(state, "visual", "modified", layoutNoise ? "noise" : "minor", layoutNoise
      ? "Rendered layout changes while normalized text remains equal."
      : "Rendered appearance changes while extracted text remains equal.", [{
      channel: "visual", operation: "modified",
      before_evidence_id: observe(state, "before", "visual", pair.beforePage, null, region, beforeCrop.bytes, { difference, sha256: beforeCrop.sha256 }),
      after_evidence_id: observe(state, "after", "visual", pair.afterPage, null, region, afterCrop.bytes, { difference, sha256: afterCrop.sha256 }),
    }], layoutNoise ? "CALIBRATED_LAYOUT_NOISE" : null);
  }
  return analysis;
}

function validateDocumentInput(document, side) {
  if (!document || document.side !== side || !document.observation || !document.layout || !Array.isArray(document.renders)) {
    throw new TypeError(`${side} comparison document is invalid.`);
  }
  if (document.observation.source.sha256 !== document.layout.source.sha256) {
    const error = new Error("Comparison inputs were not observed from the same source bytes.");
    error.code = "COMPARISON_SOURCE_BINDING_MISMATCH";
    throw error;
  }
  validatePdfObservationSemantics(document.observation);
  if (document.observation.source.size_bytes !== document.layout.source.size_bytes
    || document.layout.pages.length !== document.observation.pages.total_count
    || document.layout.pages.some((page, index) => page.page !== index + 1)) {
    const error = new Error("Comparison layout does not cover the same complete source document.");
    error.code = "COMPARISON_SOURCE_BINDING_MISMATCH";
    throw error;
  }
}

function pageCompositeAnchors(document) {
  const fields = document.observation.form_fields.items;
  const annotations = document.observation.annotations.items;
  return new Map(document.layout.pages.map(page => [page.page, comparisonSha256({
    page: {
      text: pageText(page),
      width: page.geometry.display_width,
      height: page.geometry.display_height,
      rotation: pageRotation(page),
    },
    fields: fields.filter(item => item.widget_page === page.page),
    annotations: annotations.filter(item => item.page === page.page),
    native_render_sha256: document.renders[page.page - 1]?.raw_pixel_sha256
      ?? (document.renders[page.page - 1]?.binary
        ? comparisonSha256(document.renders[page.page - 1].binary)
        : null),
  })]));
}

function comparisonSource(document) {
  return {
    ...document.observation.source,
    page_count: document.observation.pages.total_count,
    parser: document.observation.parser,
    observation_sha256: document.observation.observation_sha256,
  };
}

export function buildPdfComparison({
  before,
  after,
  mode,
  includeVisual,
  maxOutputCharacters,
  sourceImmutability,
  durationMs,
}) {
  validateDocumentInput(before, "before");
  validateDocumentInput(after, "after");
  const alignments = alignComparisonPages(before.layout.pages, after.layout.pages, {
    beforeCompositeAnchors: pageCompositeAnchors(before),
    afterCompositeAnchors: pageCompositeAnchors(after),
  });
  // Coverage derivation needs the alignments so repeated-page ambiguity (Bug 2)
  // degrades the affected channels in the engine, before any consumer sees it.
  const coverageByChannel = derivePdfComparisonCoverage([before, after], includeVisual, alignments);
  const pairs = alignedPagePairs(before, after, alignments);
  const state = createState(mode, before, after);
  detectStructure(state, alignments);
  detectText(state, pairs, includeVisual);
  detectFormChanges(state, includeVisual, alignments);
  detectRecordChanges(
    state, "annotation", before.observation.annotations.items, after.observation.annotations.items,
    item => canonical([item.source_object_id, item.subtype, item.page]),
    annotationKey,
    (left, right, operation) => `Annotation ${JSON.stringify(left?.contents ?? right?.contents ?? left?.subtype ?? right?.subtype ?? "")} ${operation}.`,
    false,
    item => item.contents,
  );
  detectMetadata(state);
  const visualAnalysis = detectResidualVisual(state, pairs, includeVisual);
  if (includeVisual && coverageByChannel.visual.status === "supported"
    && visualAnalysis.completed !== visualAnalysis.requested) {
    coverageByChannel.visual = coverage("partial", ["VISUAL_ALIGNED_PAGE_COMPARISON_SKIPPED"]);
  }

  const limitations = Object.entries(coverageByChannel).flatMap(([channel, value]) => value.reason_codes.map(reason => `${channel}:${reason}`));
  const status = Object.entries(coverageByChannel).some(([channel, value]) => value.status !== "supported"
    && !(channel === "visual" && value.reason_codes.includes("VISUAL_NOT_REQUESTED"))) ? "partial" : "complete";
  const reported = state.changes.filter(change => change.presentation.disposition === "report");
  const allRequestedChannelsComplete = Object.entries(coverageByChannel)
    .filter(([channel]) => includeVisual || channel !== "visual")
    .every(([, value]) => value.status === "supported");
  const result = {
    schema_version: PDF_COMPARISON_SCHEMA_VERSION,
    engine: PDF_COMPARISON_ENGINE,
    status,
    mode,
    before_source: comparisonSource(before),
    after_source: comparisonSource(after),
    source_immutability: sourceImmutability,
    coverage: coverageByChannel,
    page_alignments: alignments,
    observations: state.observations,
    changes: state.changes,
    summary: {
      detected_change_count: state.changes.length,
      reported_change_count: reported.length,
      suppressed_change_count: state.changes.length - reported.length,
      no_reported_changes: reported.length === 0 && allRequestedChannelsComplete,
      equivalence_claim: false,
    },
    limitations: [...new Set(limitations)].sort(compareCodePoints),
    resource_usage: {
      duration_ms: Number(durationMs.toFixed(3)),
      source_bytes: before.observation.source.size_bytes + after.observation.source.size_bytes,
      rendered_pixels: [...before.renders, ...after.renders]
        .filter(Boolean).reduce((sum, render) => sum + render.width * render.height, 0),
      aligned_page_visual_comparisons_requested: visualAnalysis.requested,
      aligned_page_visual_comparisons_completed: visualAnalysis.completed,
      network_requests: 0,
      external_persistence_writes: 0,
    },
  };
  result.comparison_sha256 = comparisonEnvelopeSha256(result);
  if (JSON.stringify(result).length > maxOutputCharacters) {
    const error = new Error("The deterministic comparison result exceeds max_output_characters without safely omitting raw changes.");
    error.code = "COMPARISON_OUTPUT_LIMIT_EXCEEDED";
    throw error;
  }
  return result;
}

export const PDF_COMPARISON_ENCRYPTED_CODE = "PDF_ENCRYPTED_COMPARISON_UNSUPPORTED";

/**
 * The phrase every encrypted-comparison refusal contains, used to recognise one
 * that has lost its `code`.
 *
 * `error.code` is an own property of an Error instance and does not survive
 * anything that rebuilds the error from its message — a structured clone, a
 * subprocess or worker boundary, a transport that carries `{ message }`. When
 * that happens the refusal falls through every branch below and is re-reported
 * as `invalid_input`, "the arguments or PDF inputs are invalid", which is both
 * wrong and exactly the class of useless refusal this work exists to remove.
 * Matching the text as well as the code means the classification survives a
 * boundary that the code does not.
 */
const PDF_COMPARISON_ENCRYPTED_SIGNATURE =
  "compare_pdfs cannot compare an encrypted document";

/**
 * Whether this failure is an encrypted comparison input, however it arrived.
 *
 * Two signals, not one: the typed code, and this module's own refusal text as a
 * substring, so a wrapper that prefixes or annotates the message cannot turn a
 * true statement about encryption into a false one about arguments.
 *
 * The *other* encryption signal — the shared pdf-lib "no decryption support"
 * limit raised by the page renderer — is deliberately not matched here. It
 * belongs to `server/helpers.js`, and this module's static import graph is
 * closed and asserted by the extraction scorer
 * (`test/eval/extraction-phase1-generation-verifiers.test.js`), which must not
 * transitively acquire pdf-lib. `server/index.js` owns that translation
 * instead, converting the pdf-lib limit into a typed refusal before it ever
 * reaches this classifier.
 */
export function isPdfComparisonEncryptedFailure(error) {
  if (error?.code === PDF_COMPARISON_ENCRYPTED_CODE) return true;
  const message = typeof error?.message === "string" ? error.message : "";
  return message.includes(PDF_COMPARISON_ENCRYPTED_SIGNATURE);
}

/**
 * The refusal for an encrypted comparison input.
 *
 * `compare_pdfs` reads text, form fields, annotations and metadata through
 * PDF.js, which decrypts, but it takes each page's raw geometry — and, when the
 * visual channel is requested, every rendered page — through pdf-lib, which has
 * no decryption support at all. So the password arguments genuinely cannot make
 * this comparison run, and the message says that instead of asking for a
 * password again or reporting an internal fault.
 *
 * The named alternatives are the three tools that accept a password and read
 * entirely through PDF.js, which is the same set `PDF_LIB_ENCRYPTED_MESSAGE`
 * names; `test/encrypted-pdf-password-truth.test.js` proves each of them really
 * does open an encrypted document with the password, so the advice cannot rot
 * into naming a tool that does not work.
 *
 * `sides` is whichever of the two inputs were found encrypted, in comparison
 * order. An empty list is allowed: it means an encrypted input was detected
 * somewhere in the run without the side being attributable, which is better
 * reported vaguely than reported as an internal error.
 */
export function pdfComparisonEncryptedMessage(sides) {
  const named = sides.length === 0
    ? "A comparison input is encrypted"
    : sides.length === PDF_COMPARISON_SIDES.length
      ? "Both comparison inputs are encrypted"
      : `The ${sides[0]} comparison input is encrypted`;
  return `${named}, and compare_pdfs cannot compare an encrypted document. It reads text, form `
    + "fields, annotations and metadata with PDF.js, which does decrypt, but it takes every page's "
    + "raw geometry — and every rendered page, when the visual channel is requested — through "
    + "pdf-lib, which has no decryption support, so supplying a password here will not help. "
    + "Rather than report a comparison of whichever channels survive, it stops. Decrypt both "
    + "documents first (for example with qpdf) and compare the decrypted copies. To read an "
    + "encrypted PDF as it is, use read_pdf_layout, convert_pdf_to_markdown, or get_pdf_info, "
    + "after entering the password in the private window opened by unlock_pdf. Those tools decrypt with PDF.js.";
}

export function pdfComparisonEncryptedError(sides) {
  const ordered = PDF_COMPARISON_SIDES.filter(side => sides.includes(side));
  const error = new Error(pdfComparisonEncryptedMessage(ordered));
  error.code = PDF_COMPARISON_ENCRYPTED_CODE;
  error.encryptedSides = Object.freeze(ordered);
  return error;
}

/**
 * The catch-all, which has to earn its place because it is where every
 * unrecognised failure lands.
 *
 * "The compare_pdfs arguments or PDF inputs are invalid" on its own is the same
 * useless-refusal shape as the bugs above: true, and no help at all. The
 * argument that is actually wrong is nearly always the password, because every
 * other tool in this server takes `password` and this one does not — and a
 * rejected unknown argument produces this text identically for every other
 * argument the caller varies, which makes it read like a failure of the
 * document rather than of the call.
 *
 * The accepted names are published in the tool's own input schema, so repeating
 * them here reveals nothing. What must NOT appear is anything the caller sent:
 * an unknown argument's *name* is caller data and is deliberately never echoed,
 * which `test/compare-pdfs.test.js` pins with a sentinel.
 */
export const PDF_COMPARISON_INVALID_INPUT_MESSAGE =
  "The compare_pdfs arguments or PDF inputs are invalid. It accepts only before_pdf_path, "
  + "after_pdf_path, mode, max_pages, include_visual and max_output_characters, and rejects "
  + "any other argument. Passwords are never accepted in tool arguments. "
  + "Both paths must be absolute paths on this machine.";

export function publicPdfComparisonError(error) {
  const code = error?.code;
  // Checked first, and by evidence rather than by code alone, so a refusal that
  // crossed a boundary which dropped its `code` is still reported as what it is
  // instead of falling through to the catch-all below.
  if (isPdfComparisonEncryptedFailure(error)) {
    return {
      code: PDF_COMPARISON_ENCRYPTED_CODE,
      message: pdfComparisonEncryptedMessage(error.encryptedSides ?? []),
    };
  }
  if (code === "COMPARISON_PAGE_LIMIT_EXCEEDED") {
    return { code, message: "A comparison input exceeds the requested whole-document page limit." };
  }
  if (code === "COMPARISON_OUTPUT_LIMIT_EXCEEDED") {
    return { code, message: "The complete comparison evidence exceeds the requested output limit." };
  }
  if (code === "COMPARISON_SOURCE_CHANGED" || code === "PDF_CHANGED_DURING_READ") {
    return { code: "COMPARISON_SOURCE_CHANGED", message: "A comparison input changed while it was being read. Retry the operation." };
  }
  if (code === "COMPARISON_SOURCE_BINDING_MISMATCH") {
    return { code, message: "Comparison source observations did not bind to identical input bytes." };
  }
  if (code === "PASSWORD_REQUIRED") {
    return { code, message: "A comparison input requires its password." };
  }
  if (code === "PASSWORD_INCORRECT") {
    return { code, message: "A comparison input password was not accepted." };
  }
  if (code === "path_policy_denied") {
    return { code, message: "A requested comparison path is not permitted." };
  }
  if (code === "PDF_RESOURCE_LIMIT_EXCEEDED") {
    return { code, message: "PDF comparison exceeded its isolated resource budget." };
  }
  if (code === "PDF_INPUT_TOO_LARGE") {
    return { code, message: "A comparison input exceeds the supported PDF size limit." };
  }
  if (["ENOENT", "ENOTDIR", "EACCES", "EPERM"].includes(code)) {
    return { code: "PDF_UNAVAILABLE", message: "A comparison input could not be opened." };
  }
  if (code === "PDFJS_SUBPROCESS_FAILED" || code === "PDF_INVALID_HEADER") {
    return { code: "PDF_PARSE_FAILED", message: "A comparison input could not be parsed as a supported PDF." };
  }
  if (["InvalidPDFException", "MissingPDFException", "UnexpectedResponseException", "FormatError"]
    .includes(error?.name)) {
    return { code: "PDF_PARSE_FAILED", message: "A comparison input could not be parsed as a supported PDF." };
  }
  if (error instanceof TypeError || typeof error?.message === "string") {
    return { code: "invalid_input", message: PDF_COMPARISON_INVALID_INPUT_MESSAGE };
  }
  return { code: "tool_execution_failed", message: "The PDFs could not be compared." };
}

function semanticError(message) {
  throw new TypeError(`Invalid PDF comparison semantics: ${message}`);
}

export function validatePdfComparisonSemantics(payload) {
  if (canonical(payload.engine) !== canonical(PDF_COMPARISON_ENGINE)) semanticError("engine policy is not canonical");
  for (const [side, source] of [["before", payload.before_source], ["after", payload.after_source]]) {
    if (source.file_name !== source.canonical_path.split(/[\\/]/).pop()) semanticError(`${side} source name does not match its path`);
    const immutable = payload.source_immutability[side];
    if (!immutable.unchanged
      || immutable.initial_sha256 !== source.sha256
      || immutable.final_sha256 !== source.sha256
      || immutable.initial_size_bytes !== source.size_bytes
      || immutable.final_size_bytes !== source.size_bytes) {
      semanticError(`${side} source immutability does not bind the source envelope`);
    }
    if (canonical(source.parser) !== canonical(PDF_COMPARISON_ENGINE.parser)
      || !/^[a-f0-9]{64}$/.test(source.observation_sha256)) {
      semanticError(`${side} parser or observation digest is invalid`);
    }
  }
  const coverageKeys = Object.keys(payload.coverage).sort(compareCodePoints);
  if (canonical(coverageKeys) !== canonical([...PDF_COMPARISON_CHANNELS].sort(compareCodePoints))) {
    semanticError("coverage channels are incomplete");
  }
  for (const [channel, value] of Object.entries(payload.coverage)) {
    const reasons = [...new Set(value.reason_codes)].sort(compareCodePoints);
    if (canonical(value.reason_codes) !== canonical(reasons)) semanticError(`${channel} coverage reasons are not unique and sorted`);
    if (value.status === "supported" && value.reason_codes.length > 0) semanticError(`${channel} supported coverage has limitations`);
    if (value.status !== "supported" && value.reason_codes.length === 0) semanticError(`${channel} incomplete coverage has no reason`);
    if (value.reason_codes.some(reason => !PDF_COMPARISON_COVERAGE_REASONS.has(reason))) {
      semanticError(`${channel} coverage has an unknown reason`);
    }
    if (value.reason_codes.includes("VISUAL_NOT_REQUESTED")
      && (channel !== "visual" || value.status !== "unavailable"
        || canonical(value.reason_codes) !== canonical(["VISUAL_NOT_REQUESTED"]))) {
      semanticError("visual-not-requested coverage is malformed");
    }
  }
  const derivedStatus = Object.entries(payload.coverage).some(([channel, value]) => value.status !== "supported"
    && !(channel === "visual" && value.reason_codes.includes("VISUAL_NOT_REQUESTED")))
    ? "partial" : "complete";
  if (payload.status !== derivedStatus) semanticError("status does not match channel coverage");
  const expectedLimitations = Object.entries(payload.coverage)
    .flatMap(([channel, value]) => value.reason_codes.map(reason => `${channel}:${reason}`))
    .filter((value, index, values) => values.indexOf(value) === index).sort(compareCodePoints);
  if (canonical(payload.limitations) !== canonical(expectedLimitations)) semanticError("limitations do not match coverage reasons");

  // Bug 2 invariant: a repeated-ambiguous alignment means the engine did not
  // compare those pages' semantic, text, or structure content, so none of those
  // channels may still claim `supported`, and each must carry the typed reason.
  if (payload.page_alignments.some(alignment => alignment.match_basis === "repeated_ambiguous")) {
    for (const channel of ["semantic", "text", "structure"]) {
      const entry = payload.coverage[channel];
      if (entry.status === "supported" || !entry.reason_codes.includes("REPEATED_PAGE_AMBIGUITY")) {
        semanticError(`${channel} coverage ignores repeated-page ambiguity`);
      }
    }
  }

  const beforePages = new Set();
  const afterPages = new Set();
  for (const alignment of payload.page_alignments) {
    if (alignment.score < 0 || alignment.score > 1) semanticError("alignment score is outside 0..1");
    if (alignment.before_page !== null) {
      if (beforePages.has(alignment.before_page)) semanticError("before page alignment is not one-to-one");
      beforePages.add(alignment.before_page);
    }
    if (alignment.after_page !== null) {
      if (afterPages.has(alignment.after_page)) semanticError("after page alignment is not one-to-one");
      afterPages.add(alignment.after_page);
    }
    if (alignment.relation === "inserted" && alignment.before_page !== null) semanticError("inserted alignment has a before page");
    if (alignment.relation === "deleted" && alignment.after_page !== null) semanticError("deleted alignment has an after page");
    if (["same", "moved"].includes(alignment.relation)
      && (alignment.before_page === null || alignment.after_page === null)) semanticError("paired alignment omits a side");
    if (alignment.match_basis === "repeated_ambiguous") {
      if (!alignment.ambiguity_group || alignment.score !== 0
        || (alignment.before_page === null) === (alignment.after_page === null)) {
        semanticError("repeated-page ambiguity was resolved or malformed");
      }
    } else if (alignment.ambiguity_group !== null) semanticError("non-ambiguous alignment has an ambiguity group");
  }
  for (const [side, pages, expectedCount] of [
    ["before", beforePages, payload.before_source.page_count],
    ["after", afterPages, payload.after_source.page_count],
  ]) {
    if (!Number.isSafeInteger(expectedCount) || expectedCount < 1 || expectedCount > 20
      || pages.size !== expectedCount
      || [...pages].some(page => !Number.isSafeInteger(page) || page < 1 || page > expectedCount)) {
      semanticError(`${side} page alignments do not cover the source envelope`);
    }
  }
  const pairedAlignmentCount = payload.page_alignments.filter(alignment => alignment.before_page !== null
    && alignment.after_page !== null).length;
  const visualNotRequested = payload.coverage.visual.reason_codes.includes("VISUAL_NOT_REQUESTED");
  const expectedVisualRequests = visualNotRequested ? 0 : pairedAlignmentCount;
  const visualRequests = payload.resource_usage.aligned_page_visual_comparisons_requested;
  const visualCompleted = payload.resource_usage.aligned_page_visual_comparisons_completed;
  if (visualRequests !== expectedVisualRequests || visualCompleted > visualRequests
    || visualCompleted < 0 || !Number.isSafeInteger(visualCompleted)) {
    semanticError("visual comparison accounting does not bind aligned pages");
  }
  const hasSkippedVisualReason = payload.coverage.visual.reason_codes
    .includes("VISUAL_ALIGNED_PAGE_COMPARISON_SKIPPED");
  if (payload.coverage.visual.status === "supported" && visualCompleted !== visualRequests) {
    semanticError("supported visual coverage skipped an aligned page comparison");
  }
  if (hasSkippedVisualReason !== (payload.coverage.visual.status === "partial"
    && visualCompleted < visualRequests)) {
    semanticError("skipped visual comparison reason does not match accounting");
  }

  const observations = new Map();
  for (const observation of payload.observations) {
    if (observations.has(observation.id)) semanticError(`duplicate observation ${observation.id}`);
    observations.set(observation.id, observation);
    const source = observation.side === "before" ? payload.before_source : payload.after_source;
    if (observation.document_sha256 !== source.sha256) semanticError(`${observation.id} is not source-bound`);
    if (!Number.isSafeInteger(observation.page) || observation.page < 1 || observation.page > source.page_count) {
      semanticError(`${observation.id} page is outside its source envelope`);
    }
    const [x, y, width, height] = observation.display_region;
    const [, , pageWidth, pageHeight] = observation.page_box;
    if (![x, y, width, height, pageWidth, pageHeight].every(Number.isFinite)
      || width <= 0 || height <= 0 || pageWidth <= 0 || pageHeight <= 0) {
      semanticError(`${observation.id} display region is invalid`);
    }
    if (observation.native_region !== null) {
      const [, , nativeWidth, nativeHeight] = observation.native_region;
      if (nativeWidth <= 0 || nativeHeight <= 0) semanticError(`${observation.id} native region is invalid`);
    }
    if (observation.canonical_value?.binary_sha256) {
      if (observation.canonical_value.binary_sha256 !== observation.value_sha256) {
        semanticError(`${observation.id} binary value digest is invalid`);
      }
    } else if (comparisonValueSha256(observation.canonical_value) !== observation.value_sha256) {
      semanticError(`${observation.id} canonical value digest is invalid`);
    }
    const digestEnvelope = structuredClone(observation);
    delete digestEnvelope.observation_sha256;
    if (observation.observation_sha256 !== comparisonSha256(digestEnvelope)) {
      semanticError(`${observation.id} digest is invalid`);
    }
  }
  const changeIds = new Set();
  for (const change of payload.changes) {
    if (changeIds.has(change.id)) semanticError(`duplicate change ${change.id}`);
    changeIds.add(change.id);
    if (change.presentation.mode !== payload.mode) semanticError(`${change.id} presentation mode does not bind the envelope`);
    const facetChannels = new Set();
    for (const facet of change.facets) {
      if (facetChannels.has(facet.channel)) semanticError(`${change.id} repeats a facet channel`);
      facetChannels.add(facet.channel);
      if (facet.operation !== change.operation) semanticError(`${change.id} facet operation does not match its change`);
      for (const [key, side] of [["before_evidence_id", "before"], ["after_evidence_id", "after"]]) {
        const id = facet[key];
        if (id === null) continue;
        const observation = observations.get(id);
        if (!observation || observation.side !== side || observation.channel !== facet.channel) {
          semanticError(`${change.id} references invalid ${key}`);
        }
      }
      if (facet.operation === "added" && facet.before_evidence_id !== null) semanticError(`${change.id} added facet has before evidence`);
      if (facet.operation === "removed" && facet.after_evidence_id !== null) semanticError(`${change.id} removed facet has after evidence`);
      if (["modified", "moved"].includes(facet.operation)
        && (facet.before_evidence_id === null || facet.after_evidence_id === null)) {
        semanticError(`${change.id} two-sided facet is incomplete`);
      }
    }
  }
  const reported = payload.changes.filter(change => change.presentation.disposition === "report").length;
  const suppressed = payload.changes.length - reported;
  if (payload.summary.detected_change_count !== payload.changes.length
    || payload.summary.reported_change_count !== reported
    || payload.summary.suppressed_change_count !== suppressed
    || payload.summary.equivalence_claim !== false) {
    semanticError("summary counts or equivalence boundary are invalid");
  }
  const requestedCoverageComplete = Object.entries(payload.coverage)
    .filter(([channel, value]) => !(channel === "visual" && value.reason_codes.includes("VISUAL_NOT_REQUESTED")))
    .every(([, value]) => value.status === "supported");
  const expectedNoReported = reported === 0 && requestedCoverageComplete;
  if (payload.summary.no_reported_changes !== expectedNoReported) semanticError("no-reported-changes is not fail-closed");
  if (payload.resource_usage.network_requests !== 0 || payload.resource_usage.external_persistence_writes !== 0) {
    semanticError("resource envelope violates the closed-world policy");
  }
  if (payload.comparison_sha256 !== comparisonEnvelopeSha256(payload)) semanticError("comparison envelope digest is invalid");
  return true;
}
