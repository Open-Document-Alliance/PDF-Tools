// Carry page labels (the "i, ii, 1, 2" numbering a viewer shows) into a
// rebuilt output. Before this, every rebuilt output fell back to plain 1..n,
// so a report with roman front matter lost its numbering on any reorder,
// delete, split or merge.
//
// Labels follow their pages. A page labelled "1" in the source is labelled
// "1" in the output wherever it lands, because a label exists to match the
// number printed on the page: after deleting the cover of an "i, ii, 1, 2"
// document the output reads "ii, 1, 2", not "i, ii, 1". The output's ranges
// are rebuilt from the label each output page carries, merging runs that
// continue one another. Pages of a source without labels keep the plain
// number a viewer showed for them in that source.
//
// The number tree is read with bounds and cycle refusal, the output tree is
// built from fresh literal values only, and a label tree that cannot be read
// is reported rather than silently replaced with plain numbers.

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
 * { start, style, prefix, first }: start a zero-based page index, style one
 * of D R r A a or null, prefix a PDF string or null, first the numeric value
 * of the range's first page. status is "absent", "read", or "unreadable".
 */
export function readSourcePageLabels(sourceDoc) {
  const context = sourceDoc.context;
  if (sourceDoc.catalog.get(PAGE_LABELS) === undefined) return { status: "absent", ranges: [] };
  const root = lookup(context, sourceDoc.catalog.get(PAGE_LABELS));
  if (!(root instanceof PDFDict)) return { status: "unreadable", ranges: [] };
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

/**
 * The label a source page carries: { style, prefix, value }. A page no range
 * covers (or any page of a source without labels) shows its plain number.
 */
export function pageLabelOf(labels, sourcePage) {
  let covering = null;
  for (const range of labels.ranges ?? []) {
    if (range.start <= sourcePage) covering = range;
    else break;
  }
  if (!covering) return { style: "D", prefix: null, value: sourcePage + 1 };
  return { style: covering.style, prefix: covering.prefix, value: covering.first + (sourcePage - covering.start) };
}

function samePrefix(left, right) {
  if (left === null || right === null) return left === right;
  return Buffer.from(left.asBytes()).equals(Buffer.from(right.asBytes()));
}

/**
 * Write labels for an output whose page j carries pageLabels[j], as returned
 * by pageLabelOf. Consecutive pages that continue one range (same style and
 * prefix, value one higher) share it. Returns true when labels were written.
 */
export function writePageLabels(targetDoc, pageLabels) {
  if (pageLabels.length === 0 || pageLabels.length !== targetDoc.getPageCount()) return false;
  const context = targetDoc.context;
  const nums = [];
  let previous = null;
  for (const [index, label] of pageLabels.entries()) {
    const continues = previous
      && previous.style === label.style
      && samePrefix(previous.prefix, label.prefix)
      && label.value === previous.value + 1;
    previous = label;
    if (continues) continue;
    const dict = context.obj({});
    if (label.style) dict.set(PDFName.of("S"), PDFName.of(label.style));
    if (label.prefix) dict.set(PDFName.of("P"), label.prefix);
    if (label.value !== 1) dict.set(PDFName.of("St"), PDFNumber.of(label.value));
    nums.push(PDFNumber.of(index), dict);
  }
  targetDoc.catalog.set(PAGE_LABELS, context.register(context.obj({ Nums: context.obj(nums) })));
  return true;
}

/**
 * Carry labels for an output built from parts [{ labels, sourcePages }], in
 * output order. Returns "absent" when no part's source had labels,
 * "not_carried" when one could not be read (the output then gets none, and
 * the caller says so), or "carried".
 */
export function carryPageLabels(targetDoc, parts) {
  if (parts.some(part => part.labels.status === "unreadable")) return "not_carried";
  if (parts.every(part => part.labels.status !== "read")) return "absent";
  const pageLabels = parts.flatMap(part => part.sourcePages.map(page => pageLabelOf(part.labels, page)));
  return writePageLabels(targetDoc, pageLabels) ? "carried" : "not_carried";
}
