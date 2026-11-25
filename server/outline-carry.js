// Carry a source document's outline (bookmarks) into a rebuilt output.
//
// merge_pdfs, split_pdf, reorder_pdf_pages and apply_page_plan build a new
// PDFDocument and copy pages into it. pdf-lib's page copy brings the pages and
// what they reference, but the outline lives in the source catalog, so before
// this module every one of those tools silently dropped every bookmark.
//
// The carry reads the source outline once, resolves each entry's destination
// to a source page index, and rebuilds the tree in the target against the
// copied pages. An entry whose page is not in the output is dropped, its
// surviving children are promoted into its place, and the drop is reported:
// a lost bookmark is never silent. Everything the reader cannot follow is
// bounded and reported the same way rather than guessed at.
//
// The rebuilt tree is made only of fresh dictionaries, literal values, and
// references to pages already copied into the target. Nothing from the source
// is copied by reference, so no source object can ride along through a
// bookmark, and named destinations are rewritten as explicit ones because the
// target carries no name tree.

import {
  PDFArray,
  PDFDict,
  PDFHexString,
  PDFName,
  PDFNull,
  PDFNumber,
  PDFRef,
  PDFString,
} from "pdf-lib";

export const OUTLINE_CARRY_LIMITS = Object.freeze({
  maxEntries: 4096,
  maxDepth: 64,
  maxNameTreeNodes: 4096,
  maxReportedTitles: 20,
  maxReportedTitleLength: 160,
});

const N = Object.freeze({
  A: PDFName.of("A"),
  C: PDFName.of("C"),
  Count: PDFName.of("Count"),
  D: PDFName.of("D"),
  Dest: PDFName.of("Dest"),
  Dests: PDFName.of("Dests"),
  F: PDFName.of("F"),
  First: PDFName.of("First"),
  GoTo: PDFName.of("GoTo"),
  Kids: PDFName.of("Kids"),
  Last: PDFName.of("Last"),
  Limits: PDFName.of("Limits"),
  Names: PDFName.of("Names"),
  Next: PDFName.of("Next"),
  Outlines: PDFName.of("Outlines"),
  PageMode: PDFName.of("PageMode"),
  Parent: PDFName.of("Parent"),
  Prev: PDFName.of("Prev"),
  S: PDFName.of("S"),
  Title: PDFName.of("Title"),
  Type: PDFName.of("Type"),
  URI: PDFName.of("URI"),
  Named: PDFName.of("Named"),
  UseOutlines: PDFName.of("UseOutlines"),
});

const VIEW_FITS = new Set(["XYZ", "Fit", "FitH", "FitV", "FitR", "FitB", "FitBH", "FitBV"]);

class OutlineUnreadable extends Error {
  constructor(reason) {
    super(reason);
    this.reason = reason;
  }
}

function lookup(context, value) {
  if (value instanceof PDFRef) return context.lookup(value);
  return value;
}

function lookupDict(context, value) {
  const resolved = lookup(context, value);
  return resolved instanceof PDFDict ? resolved : null;
}

function textOf(value) {
  if (value instanceof PDFString || value instanceof PDFHexString) {
    try {
      return value.decodeText();
    } catch {
      return "";
    }
  }
  return "";
}

function reportedTitle(title) {
  const flat = title.replace(/\s+/g, " ").trim();
  const limit = OUTLINE_CARRY_LIMITS.maxReportedTitleLength;
  return flat.length > limit ? `${flat.slice(0, limit - 1)}…` : flat;
}

function nameKey(value) {
  if (value instanceof PDFName) return { kind: "name", key: value.decodeText() };
  if (value instanceof PDFString || value instanceof PDFHexString) {
    return { kind: "string", key: textOf(value) };
  }
  return null;
}

/**
 * Resolve named destinations lazily and at most once per document: the old
 * catalog /Dests dictionary (keys are names) and the /Names /Dests name tree
 * (keys are strings). The tree walk is bounded by node count and refuses
 * cycles, so a hostile tree costs a bounded amount and then reads as absent.
 */
function namedDestinationResolver(sourceDoc) {
  const context = sourceDoc.context;
  let tree = null;
  const legacy = lookupDict(context, sourceDoc.catalog.get(N.Dests));

  function loadTree() {
    if (tree) return tree;
    tree = new Map();
    const names = lookupDict(context, sourceDoc.catalog.get(N.Names));
    const root = names ? lookupDict(context, names.get(N.Dests)) : null;
    if (!root) return tree;
    const pending = [root];
    const seen = new Set();
    let visited = 0;
    while (pending.length > 0) {
      const node = pending.pop();
      if (seen.has(node)) throw new OutlineUnreadable("named_destination_tree_cycle");
      seen.add(node);
      visited += 1;
      if (visited > OUTLINE_CARRY_LIMITS.maxNameTreeNodes) {
        throw new OutlineUnreadable("named_destination_tree_too_large");
      }
      const pairs = lookup(context, node.get(N.Names));
      if (pairs instanceof PDFArray) {
        for (let index = 0; index + 1 < pairs.size(); index += 2) {
          const key = nameKey(lookup(context, pairs.get(index)));
          if (key && !tree.has(key.key)) tree.set(key.key, pairs.get(index + 1));
        }
      }
      const kids = lookup(context, node.get(N.Kids));
      if (kids instanceof PDFArray) {
        for (let index = kids.size() - 1; index >= 0; index -= 1) {
          const kid = lookupDict(context, kids.get(index));
          if (kid) pending.push(kid);
        }
      }
    }
    return tree;
  }

  return key => {
    if (key.kind === "name" && legacy) {
      const hit = legacy.get(PDFName.of(key.key));
      if (hit !== undefined) return hit;
    }
    return loadTree().get(key.key);
  };
}

function explicitDestination(context, value, resolveName, depth = 0) {
  if (depth > 2) return null;
  const resolved = lookup(context, value);
  if (resolved instanceof PDFArray) return resolved;
  if (resolved instanceof PDFDict) {
    // A named destination's value may be a dictionary whose /D is the array.
    return explicitDestination(context, resolved.get(N.D), resolveName, depth + 1);
  }
  const key = nameKey(resolved);
  if (key) {
    const target = resolveName(key);
    return target === undefined ? null : explicitDestination(context, target, resolveName, depth + 1);
  }
  return null;
}

/**
 * Turn the tail of a destination array into fresh literal values. Only the
 * fit names the spec defines and their numeric or null operands survive; any
 * other shape becomes /Fit, which still lands on the right page.
 */
function destinationView(context, array) {
  const fit = lookup(context, array.get(1));
  const fitName = fit instanceof PDFName ? fit.decodeText() : null;
  if (!fitName || !VIEW_FITS.has(fitName)) return { fit: "Fit", operands: [] };
  const operands = [];
  for (let index = 2; index < array.size() && index < 6; index += 1) {
    const operand = lookup(context, array.get(index));
    if (operand instanceof PDFNumber) operands.push(operand.asNumber());
    else operands.push(null);
  }
  return { fit: fitName, operands };
}

function readTarget(sourceDoc, entry, pageIndexByRef, resolveName) {
  const context = sourceDoc.context;
  let destValue = entry.get(N.Dest);
  let action = null;
  if (destValue === undefined) {
    const actionDict = lookupDict(context, entry.get(N.A));
    if (actionDict) {
      const kind = lookup(context, actionDict.get(N.S));
      if (kind === N.GoTo) {
        destValue = actionDict.get(N.D);
      } else if (kind === N.URI) {
        const uri = lookup(context, actionDict.get(N.URI));
        if (uri instanceof PDFString || uri instanceof PDFHexString) {
          action = { kind: "uri", value: uri };
        } else {
          action = { kind: "unsupported" };
        }
      } else if (kind === N.Named) {
        const name = lookup(context, actionDict.get(PDFName.of("N")));
        action = name instanceof PDFName ? { kind: "named", value: name } : { kind: "unsupported" };
      } else {
        action = { kind: "unsupported" };
      }
    }
  }
  if (destValue === undefined) return { page: null, view: null, action };
  const array = explicitDestination(context, destValue, resolveName);
  if (!array || array.size() < 1) return { page: null, view: null, action: null, unresolved: true };
  const pageValue = array.get(0);
  let page = null;
  if (pageValue instanceof PDFRef) {
    page = pageIndexByRef.get(pageValue.toString()) ?? null;
  } else {
    // A local destination must name its page by reference. Some producers
    // write a zero-based page number instead; readers tolerate it, so do we.
    const number = lookup(context, pageValue);
    if (number instanceof PDFNumber && Number.isInteger(number.asNumber())
        && number.asNumber() >= 0 && number.asNumber() < pageIndexByRef.size) {
      page = number.asNumber();
    }
  }
  if (page === null) return { page: null, view: null, action: null, unresolved: true };
  return { page, view: destinationView(context, array), action: null };
}

/**
 * Read a source outline into a plain tree. Returns { status, entries, reason }
 * where status is "absent", "read", or "unreadable". Unreadable means the
 * tree broke a bound or a structural rule; it is reported, never guessed at.
 */
export function readSourceOutline(sourceDoc) {
  const context = sourceDoc.context;
  const root = lookupDict(context, sourceDoc.catalog.get(N.Outlines));
  if (!root || root.get(N.First) === undefined) {
    return { status: "absent", entries: [], total: 0, reason: null };
  }
  const pageIndexByRef = new Map(
    sourceDoc.getPages().map((page, index) => [page.ref.toString(), index]),
  );
  const resolveName = namedDestinationResolver(sourceDoc);
  const seen = new Set();
  let total = 0;

  function readSiblings(parent, depth) {
    if (depth > OUTLINE_CARRY_LIMITS.maxDepth) throw new OutlineUnreadable("outline_too_deep");
    const out = [];
    let raw = parent.get(N.First);
    while (raw !== undefined) {
      const key = raw instanceof PDFRef ? raw.toString() : null;
      const entry = lookupDict(context, raw);
      if (!entry) throw new OutlineUnreadable("outline_entry_not_a_dictionary");
      if (key) {
        if (seen.has(key)) throw new OutlineUnreadable("outline_cycle");
        seen.add(key);
      } else if (seen.has(entry)) {
        throw new OutlineUnreadable("outline_cycle");
      } else {
        seen.add(entry);
      }
      total += 1;
      if (total > OUTLINE_CARRY_LIMITS.maxEntries) throw new OutlineUnreadable("outline_too_large");
      const titleValue = lookup(context, entry.get(N.Title));
      const title = titleValue instanceof PDFString || titleValue instanceof PDFHexString
        ? titleValue
        : PDFString.of("");
      const count = lookup(context, entry.get(N.Count));
      const color = lookup(context, entry.get(N.C));
      const flags = lookup(context, entry.get(N.F));
      const target = readTarget(sourceDoc, entry, pageIndexByRef, resolveName);
      out.push({
        title,
        titleText: textOf(title),
        open: count instanceof PDFNumber ? count.asNumber() > 0 : false,
        color: color instanceof PDFArray && color.size() === 3
          && color.asArray().every(component => lookup(context, component) instanceof PDFNumber)
          ? color.asArray().map(component => lookup(context, component).asNumber())
          : null,
        flags: flags instanceof PDFNumber && Number.isInteger(flags.asNumber()) ? flags.asNumber() & 3 : null,
        page: target.page,
        view: target.view,
        action: target.action,
        unresolved: target.unresolved === true,
        hadTarget: target.page !== null || target.action !== null || target.unresolved === true,
        children: entry.get(N.First) !== undefined ? readSiblings(entry, depth + 1) : [],
      });
      raw = entry.get(N.Next);
    }
    return out;
  }

  try {
    const entries = readSiblings(root, 0);
    return { status: "read", entries, total, reason: null };
  } catch (error) {
    if (error instanceof OutlineUnreadable) {
      return { status: "unreadable", entries: [], total: 0, reason: error.reason };
    }
    throw error;
  }
}

/**
 * Keep the entries whose target survives. targetPageFor(sourcePageIndex)
 * returns the target page ref, or null when that page is not in the output.
 * An entry pointing at a removed page is dropped and its surviving children
 * take its place. An entry with no page target (a URI, a heading) stays,
 * unless it was only a heading and every child under it was dropped.
 */
function filterEntries(entries, targetPageFor, report, sourceOffset) {
  const kept = [];
  for (const entry of entries) {
    const children = filterEntries(entry.children, targetPageFor, report, sourceOffset);
    let targetRef = null;
    if (entry.page !== null) targetRef = targetPageFor(entry.page);
    const pageRemoved = entry.page !== null && targetRef === null;
    const emptiedHeading = !entry.hadTarget && entry.children.length > 0 && children.length === 0;
    if (pageRemoved || emptiedHeading) {
      report.dropped.push({
        title: reportedTitle(entry.titleText),
        source_page: entry.page === null ? null : entry.page + 1 + sourceOffset,
        reason: pageRemoved ? "page_not_in_output" : "all_children_dropped",
      });
      kept.push(...children);
      continue;
    }
    if (entry.unresolved) report.unresolved += 1;
    if (entry.action?.kind === "unsupported") report.actions_not_carried += 1;
    kept.push({ ...entry, targetRef, children });
  }
  return kept;
}

function visibleCount(entries) {
  let count = 0;
  for (const entry of entries) {
    count += 1;
    if (entry.open) count += visibleCount(entry.children);
  }
  return count;
}

function buildEntryDict(context, entry, parentRef, selfRef) {
  const dict = context.obj({});
  dict.set(N.Title, entry.title);
  dict.set(N.Parent, parentRef);
  if (entry.color) dict.set(N.C, context.obj(entry.color));
  if (entry.flags) dict.set(N.F, PDFNumber.of(entry.flags));
  if (entry.targetRef) {
    const view = entry.view ?? { fit: "Fit", operands: [] };
    dict.set(N.Dest, context.obj([
      entry.targetRef,
      PDFName.of(view.fit),
      ...view.operands.map(value => (value === null ? PDFNull : PDFNumber.of(value))),
    ]));
  } else if (entry.action?.kind === "uri") {
    dict.set(N.A, context.obj({ S: N.URI, URI: entry.action.value }));
  } else if (entry.action?.kind === "named") {
    dict.set(N.A, context.obj({ S: N.Named, N: entry.action.value }));
  }
  context.assign(selfRef, dict);
  return dict;
}

function writeSiblings(context, entries, parentRef) {
  const refs = entries.map(() => context.nextRef());
  const dicts = entries.map((entry, index) => buildEntryDict(context, entry, parentRef, refs[index]));
  for (const [index, entry] of entries.entries()) {
    const dict = dicts[index];
    if (index > 0) dict.set(N.Prev, refs[index - 1]);
    if (index < entries.length - 1) dict.set(N.Next, refs[index + 1]);
    if (entry.children.length > 0) {
      const childRefs = writeSiblings(context, entry.children, refs[index]);
      dict.set(N.First, childRefs[0]);
      dict.set(N.Last, childRefs[childRefs.length - 1]);
      const descendants = visibleCount(entry.children);
      dict.set(N.Count, PDFNumber.of(entry.open ? descendants : -entry.children.length));
    }
  }
  return refs;
}

function countEntries(entries) {
  return entries.reduce((sum, entry) => sum + 1 + countEntries(entry.children), 0);
}

/**
 * Rebuild the outline of a target document from one or more sources, in
 * order. Each part is { outline, targetPageFor, sourcePageOffset }, where
 * outline came from readSourceOutline and sourcePageOffset shifts the
 * reported 1-based page numbers (zero for a single source). Returns the
 * report that the tool reply surfaces. With dryRun the report is computed and
 * nothing is written, which is how split_pdf finds bookmarks no part keeps.
 */
export function writeCarriedOutline(targetDoc, parts, { pageModeFrom = null, dryRun = false } = {}) {
  const report = {
    status: "absent",
    source_entries: 0,
    carried_entries: 0,
    dropped: [],
    unresolved: 0,
    actions_not_carried: 0,
    unreadable_reason: null,
  };
  const kept = [];
  let anyRead = false;
  for (const part of parts) {
    if (part.outline.status === "unreadable") {
      report.unreadable_reason = report.unreadable_reason ?? part.outline.reason;
      continue;
    }
    if (part.outline.status !== "read") continue;
    anyRead = true;
    report.source_entries += part.outline.total;
    kept.push(...filterEntries(part.outline.entries, part.targetPageFor, report, part.sourcePageOffset ?? 0));
  }
  report.carried_entries = countEntries(kept);
  if (kept.length > 0 && !dryRun) {
    const context = targetDoc.context;
    const rootRef = context.nextRef();
    const refs = writeSiblings(context, kept, rootRef);
    context.assign(rootRef, context.obj({
      Type: N.Outlines,
      First: refs[0],
      Last: refs[refs.length - 1],
      Count: PDFNumber.of(visibleCount(kept)),
    }));
    targetDoc.catalog.set(N.Outlines, rootRef);
    const pageMode = pageModeFrom ? lookup(pageModeFrom.context, pageModeFrom.catalog.get(N.PageMode)) : null;
    if (pageMode === N.UseOutlines) targetDoc.catalog.set(N.PageMode, N.UseOutlines);
  }
  if (report.unreadable_reason) report.status = anyRead ? "partial" : "not_carried";
  else if (!anyRead) report.status = "absent";
  else if (report.dropped.length > 0 || report.unresolved > 0 || report.actions_not_carried > 0) report.status = "partial";
  else report.status = "carried";
  return report;
}

/** The report as it crosses the worker boundary: bounded and JSON-safe. */
export function publicOutlineReport(report) {
  return {
    status: report.status,
    source_entries: report.source_entries,
    carried_entries: report.carried_entries,
    dropped_entries: report.dropped.length,
    dropped: report.dropped.slice(0, OUTLINE_CARRY_LIMITS.maxReportedTitles),
    unresolved_targets: report.unresolved,
    actions_not_carried: report.actions_not_carried,
    unreadable_reason: report.unreadable_reason,
  };
}

/**
 * One line for the tool reply, or "" when the source had no outline. The
 * point is that a caller never has to diff the files to learn that a
 * bookmark is gone.
 */
export function describeOutlineReport(report) {
  if (!report || report.status === "absent") return "";
  if (report.status === "not_carried") {
    return `Bookmarks: NOT carried. The source outline could not be read safely (${report.unreadable_reason}), so the output has none.`;
  }
  const lines = [`Bookmarks: kept ${report.carried_entries} of ${report.source_entries}.`];
  if (report.dropped_entries > 0) {
    const named = report.dropped
      .map(entry => (entry.source_page === null ? `"${entry.title}"` : `"${entry.title}" (page ${entry.source_page})`))
      .join(", ");
    const more = report.dropped_entries > report.dropped.length
      ? ` and ${report.dropped_entries - report.dropped.length} more`
      : "";
    lines.push(`Removed ${report.dropped_entries} bookmark(s) whose pages are not in this output: ${named}${more}.`);
  }
  if (report.unresolved_targets > 0) {
    lines.push(`${report.unresolved_targets} bookmark(s) had a destination the source does not resolve; they are kept without a target.`);
  }
  if (report.actions_not_carried > 0) {
    lines.push(`${report.actions_not_carried} bookmark(s) ran an action other than go-to, link, or named navigation; they are kept without the action.`);
  }
  if (report.unreadable_reason) {
    lines.push(`One source outline could not be read safely (${report.unreadable_reason}) and was not carried.`);
  }
  return lines.join(" ");
}
