// Carry a source document's page labels (the "i, ii, 1, 2" numbering a viewer
// shows) into a rebuilt output. Before this, every rebuilt output fell back to
// plain 1..n, so a report with roman front matter lost its numbering on any
// reorder, delete or split.
//
// Two placements, because the operations mean different things:
// - "scheme" (reorder_pdf_pages, apply_page_plan): the output is the same
//   document with its pages rearranged, so it keeps the document's numbering
//   scheme position by position, clipped to the new page count. That is what
//   a viewer does when pages are moved within one file.
// - "follow" (split_pdf): each part is an excerpt, so its pages keep the
//   labels they had in the source. A part that starts on source page 4,
//   labelled "2", starts at "2".
//
// The number tree is read with bounds and cycle refusal, and the output tree
// is built from fresh literal values only.

import {
  PDFArray,
  PDFDict,
  PDFHexString,
  PDFName,
  PDFNumber,
  PDFRef,
  PDFString,
} from "pdf-lib";

export const PAGE_LABEL_LIMITS = Object.freeze({ maxRanges: 4096, maxTreeNodes: 4096 });

const PAGE_LABELS = PDFName.of("PageLabels");
const NUMS = PDFName.of("Nums");
const KIDS = PDFName.of("Kids");
const STYLES = new Set(["D", "R", "r", "A", "a"]);

function lookup(context, value) {
  return value instanceof PDFRef ? context.lookup(value) : value;
}

/**
 * Returns { status, ranges } where ranges is a sorted list of
 * { start, style, prefix, first } with start a zero-based page index, style
 * one of D R r A a or null, prefix a PDF string or null, and first the
 * numeric value of the range's first page. status is "absent", "read", or
 * "unreadable".
 */
export function readSourcePageLabels(sourceDoc) {
  const context = sourceDoc.context;
  const root = lookup(context, sourceDoc.catalog.get(PAGE_LABELS));
  if (!(root instanceof PDFDict)) return { status: "absent", ranges: [] };
  const ranges = new Map();
  const pending = [root];
  const seen = new Set();
  while (pending.length > 0) {
    const node = pending.pop();
    if (seen.has(node)) return { status: "unreadable", ranges: [] };
    seen.add(node);
    if (seen.size > PAGE_LABEL_LIMITS.maxTreeNodes) return { status: "unreadable", ranges: [] };
    const nums = lookup(context, node.get(NUMS));
    if (nums instanceof PDFArray) {
      for (let index = 0; index + 1 < nums.size(); index += 2) {
        const key = lookup(context, nums.get(index));
        const label = lookup(context, nums.get(index + 1));
        if (!(key instanceof PDFNumber) || !(label instanceof PDFDict)) continue;
        const start = key.asNumber();
        if (!Number.isSafeInteger(start) || start < 0 || ranges.has(start)) continue;
        const style = lookup(context, label.get(PDFName.of("S")));
        const prefix = lookup(context, label.get(PDFName.of("P")));
        const first = lookup(context, label.get(PDFName.of("St")));
        ranges.set(start, {
          start,
          style: style instanceof PDFName && STYLES.has(style.decodeText()) ? style.decodeText() : null,
          prefix: prefix instanceof PDFString || prefix instanceof PDFHexString ? prefix : null,
          first: first instanceof PDFNumber && Number.isSafeInteger(first.asNumber()) && first.asNumber() >= 1
            ? first.asNumber()
            : 1,
        });
        if (ranges.size > PAGE_LABEL_LIMITS.maxRanges) return { status: "unreadable", ranges: [] };
      }
    }
    const kids = lookup(context, node.get(KIDS));
    if (kids instanceof PDFArray) {
      for (const kid of kids.asArray()) {
        const resolved = lookup(context, kid);
        if (resolved instanceof PDFDict) pending.push(resolved);
      }
    }
  }
  const sorted = [...ranges.values()].sort((left, right) => left.start - right.start);
  return { status: sorted.length > 0 ? "read" : "absent", ranges: sorted };
}

/** Ranges for an output whose page j is source page sourceStart + j. */
function followRanges(ranges, sourceStart, pageCount) {
  const out = [];
  const opening = [...ranges].reverse().find(range => range.start <= sourceStart);
  if (opening) {
    out.push({ ...opening, start: 0, first: opening.first + (sourceStart - opening.start) });
  }
  for (const range of ranges) {
    if (range.start > sourceStart && range.start < sourceStart + pageCount) {
      out.push({ ...range, start: range.start - sourceStart });
    }
  }
  return out;
}

/**
 * Write labels into the target. placement is { kind: "scheme" } or
 * { kind: "follow", sourceStart }. Returns true when labels were written.
 */
export function writeCarriedPageLabels(targetDoc, labels, placement) {
  if (labels.status !== "read") return false;
  const pageCount = targetDoc.getPageCount();
  const ranges = placement.kind === "follow"
    ? followRanges(labels.ranges, placement.sourceStart, pageCount)
    : labels.ranges.filter(range => range.start < pageCount);
  if (ranges.length === 0) return false;
  const context = targetDoc.context;
  const nums = [];
  for (const range of ranges) {
    const dict = context.obj({});
    if (range.style) dict.set(PDFName.of("S"), PDFName.of(range.style));
    if (range.prefix) dict.set(PDFName.of("P"), range.prefix);
    if (range.first !== 1) dict.set(PDFName.of("St"), PDFNumber.of(range.first));
    nums.push(PDFNumber.of(range.start), dict);
  }
  targetDoc.catalog.set(PAGE_LABELS, context.register(context.obj({ Nums: context.obj(nums) })));
  return true;
}
