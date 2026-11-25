// Carry page labels (the "i, ii, 1, 2" numbering a viewer shows) into a
// rebuilt output. Before this, every rebuilt output fell back to plain 1..n,
// so a report with roman front matter lost its numbering on any reorder,
// delete, split or merge.
//
// Two placements:
// - positional (the default for reorder_pdf_pages and apply_page_plan): page
//   labels are a numbering scheme, so the output keeps the source's scheme by
//   position and its printed numbering stays sequential. After a reorder or a
//   delete, a page can show a different label than it had; the caller counts
//   those and the reply says so.
// - follow (split_pdf, merge_pdfs, and page_labels "follow_pages"): each page
//   keeps the label it had. A split part is an excerpt, so a part starting on
//   source page 4, labelled "2", starts at "2"; a merged source keeps its own
//   numbering, and a source without labels keeps the plain numbers it showed.
// The output's ranges are rebuilt from the label each output page carries,
// merging runs that continue one another.
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

function toRoman(value) {
  const table = [[1000, "m"], [900, "cm"], [500, "d"], [400, "cd"], [100, "c"], [90, "xc"],
    [50, "l"], [40, "xl"], [10, "x"], [9, "ix"], [5, "v"], [4, "iv"], [1, "i"]];
  let rest = value;
  let out = "";
  for (const [amount, text] of table) {
    while (rest >= amount && out.length < 64) {
      out += text;
      rest -= amount;
    }
  }
  return out;
}

function toLetters(value) {
  const letter = String.fromCharCode(97 + ((value - 1) % 26));
  return letter.repeat(Math.min(64, Math.floor((value - 1) / 26) + 1));
}

/** The label text a viewer shows for a { style, prefix, value } label. */
export function formatPageLabel(label) {
  const prefix = label.prefix ? label.prefix.decodeText() : "";
  const numbers = {
    D: () => String(label.value),
    r: () => toRoman(label.value),
    R: () => toRoman(label.value).toUpperCase(),
    a: () => toLetters(label.value),
    A: () => toLetters(label.value).toUpperCase(),
  };
  return prefix + (label.style ? numbers[label.style]() : "");
}

/**
 * Labels for a reorder or page plan. placement "positional" applies the
 * source's scheme to output positions; "follow" keeps each page's label.
 * Returns { status, changed, example } where changed counts output pages
 * whose label differs from the one that page had in the source, and example
 * is the first such page as { source_page, before, after }.
 */
export function carryReorderedPageLabels(targetDoc, labels, sourcePages, placement) {
  if (labels.status === "unreadable") return { status: "not_carried", changed: 0, example: null };
  if (labels.status !== "read") return { status: "absent", changed: 0, example: null };
  const own = sourcePages.map(page => pageLabelOf(labels, page));
  const chosen = placement === "follow" ? own : sourcePages.map((_, index) => pageLabelOf(labels, index));
  let changed = 0;
  let example = null;
  for (const [index, label] of chosen.entries()) {
    const before = formatPageLabel(own[index]);
    const after = formatPageLabel(label);
    if (before === after) continue;
    changed += 1;
    example = example ?? { source_page: sourcePages[index] + 1, before, after };
  }
  const status = writePageLabels(targetDoc, chosen) ? "carried" : "not_carried";
  return { status, changed, example };
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
