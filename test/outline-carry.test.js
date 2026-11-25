// Rebuilt outputs (merge_pdfs, split_pdf, reorder_pdf_pages, apply_page_plan)
// must carry the source outline and page labels. Before this they all
// built a fresh document and copied only pages, so every bookmark was lost
// without a word.
//
// Fixtures are synthetic and built here. The outline is read back with
// PDF.js, an independent parser, so the tests do not grade pdf-lib's writing
// with pdf-lib's reading.

import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import {
  PDFDocument,
  PDFHexString,
  PDFName,
  PDFNumber,
  PDFRef,
  PDFString,
  StandardFonts,
} from "pdf-lib";
import { validateStructuredToolResult } from "../server/output-schemas.js";
import {
  OUTLINE_CARRY_LIMITS,
  describeOutlineReport,
  publicOutlineReport,
  readSourceOutline,
  writeCarriedOutline,
} from "../server/outline-carry.js";
import { readSourcePageLabels } from "../server/page-label-carry.js";
import { readXmpDocumentFields } from "../server/xmp-metadata.js";
import { createTestTempDirectory, removeTestTempDirectory } from "./helpers/temp-directory.js";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

const XMP = `<?xpacket begin="﻿" id="W5M0MpCehiHzreSzNTczkc9d"?>
<x:xmpmeta xmlns:x="adobe:ns:meta/"><rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#">
<rdf:Description rdf:about="" xmlns:dc="http://purl.org/dc/elements/1.1/">
<dc:title><rdf:Alt><rdf:li xml:lang="x-default">Synthetic Outline Report</rdf:li></rdf:Alt></dc:title>
</rdf:Description></rdf:RDF></x:xmpmeta>
<?xpacket end="w"?>`;

/**
 * Build a document whose pages say SENTINEL-n and whose outline is given as
 * [{ title, dest, children, open, action }]. dest is a zero-based page index,
 * or { named: "x" } for a legacy /Dests name, or { tree: "x" } for a name in
 * the /Names /Dests tree, or { goto: n } for a GoTo action.
 */
async function buildDocument({ pages, outline, labels = null, xmp = false, title = "Synthetic Outline Report" }) {
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  const pageRefs = [];
  for (let index = 0; index < pages; index += 1) {
    const page = doc.addPage([400, 400]);
    page.drawText(`SENTINEL-${index + 1}`, { x: 40, y: 340, size: 18, font });
    pageRefs.push(page.ref);
  }
  doc.setTitle(title);
  const context = doc.context;
  const legacyDests = context.obj({});
  const treeNames = [];

  function destFor(dest) {
    if (typeof dest === "number") return { Dest: context.obj([pageRefs[dest], PDFName.of("XYZ"), 0, 400, null]) };
    if (dest?.named) {
      legacyDests.set(PDFName.of(dest.named), context.obj([pageRefs[dest.page], PDFName.of("Fit")]));
      return { Dest: PDFName.of(dest.named) };
    }
    if (dest?.tree) {
      treeNames.push([dest.tree, context.obj({ D: context.obj([pageRefs[dest.page], PDFName.of("FitH"), 300]) })]);
      return { Dest: PDFString.of(dest.tree) };
    }
    if (dest?.goto !== undefined) {
      return { A: context.obj({ S: PDFName.of("GoTo"), D: context.obj([pageRefs[dest.goto], PDFName.of("Fit")]) }) };
    }
    if (dest?.uri) return { A: context.obj({ S: PDFName.of("URI"), URI: PDFString.of(dest.uri) }) };
    if (dest?.javascript) return { A: context.obj({ S: PDFName.of("JavaScript"), JS: PDFString.of("app.alert(1)") }) };
    if (dest?.missing) return { Dest: PDFName.of("no-such-destination") };
    return {};
  }

  function writeLevel(items, parentRef) {
    const refs = items.map(() => context.nextRef());
    let visible = 0;
    items.forEach((item, index) => {
      const dict = context.obj({
        Title: PDFHexString.fromText(item.title),
        Parent: parentRef,
        ...destFor(item.dest),
      });
      if (index > 0) dict.set(PDFName.of("Prev"), refs[index - 1]);
      if (index < items.length - 1) dict.set(PDFName.of("Next"), refs[index + 1]);
      visible += 1;
      if (item.children?.length) {
        const child = writeLevel(item.children, refs[index]);
        dict.set(PDFName.of("First"), child.refs[0]);
        dict.set(PDFName.of("Last"), child.refs[child.refs.length - 1]);
        const open = item.open !== false;
        dict.set(PDFName.of("Count"), PDFNumber.of(open ? child.visible : -child.visible));
        if (open) visible += child.visible;
      }
      context.assign(refs[index], dict);
    });
    return { refs, visible };
  }

  const rootRef = context.nextRef();
  const top = writeLevel(outline, rootRef);
  context.assign(rootRef, context.obj({
    Type: PDFName.of("Outlines"),
    First: top.refs[0],
    Last: top.refs[top.refs.length - 1],
    Count: top.visible,
  }));
  doc.catalog.set(PDFName.of("Outlines"), rootRef);
  doc.catalog.set(PDFName.of("PageMode"), PDFName.of("UseOutlines"));
  if (legacyDests.keys().length > 0) doc.catalog.set(PDFName.of("Dests"), context.register(legacyDests));
  if (treeNames.length > 0) {
    treeNames.sort(([left], [right]) => (left < right ? -1 : 1));
    const names = treeNames.flatMap(([key, value]) => [PDFString.of(key), value]);
    doc.catalog.set(PDFName.of("Names"), context.obj({
      Dests: context.register(context.obj({ Names: context.obj(names) })),
    }));
  }
  if (labels) doc.catalog.set(PDFName.of("PageLabels"), context.register(context.obj({ Nums: labels(context) })));
  if (xmp) {
    const stream = context.stream(XMP, { Type: "Metadata", Subtype: "XML" });
    doc.catalog.set(PDFName.of("Metadata"), context.register(stream));
  }
  return doc.save();
}

const REPORT_OUTLINE = [
  { title: "Cover", dest: 0 },
  { title: "Contents", dest: { named: "contents", page: 1 } },
  {
    title: "Body",
    dest: 2,
    children: [
      { title: "Findings", dest: { tree: "findings", page: 2 } },
      { title: "Methods", dest: { goto: 3 } },
    ],
  },
  { title: "Appendix", dest: 4, children: [{ title: "Raw data", dest: 4 }], open: false },
  { title: "Project site", dest: { uri: "https://example.invalid/report" } },
];

const romanThenDecimal = context => context.obj([
  0, context.obj({ S: PDFName.of("r") }),
  2, context.obj({ S: PDFName.of("D") }),
]);

async function pdfjs() {
  return import("pdfjs-dist/legacy/build/pdf.mjs");
}

/** [depth, title, sentinel-of-target-page | null] read with PDF.js. */
async function outlineWithPdfjs(bytes) {
  const lib = await pdfjs();
  const task = lib.getDocument({ data: new Uint8Array(bytes), isEvalSupported: false, useSystemFonts: false });
  const document = await task.promise;
  try {
    const pageSentinels = [];
    for (let number = 1; number <= document.numPages; number += 1) {
      const page = await document.getPage(number);
      const text = await page.getTextContent();
      pageSentinels.push(text.items.map(item => item.str).join(" ").match(/SENTINEL-\d+/)?.[0] ?? null);
    }
    const out = [];
    async function walk(items, depth) {
      for (const item of items ?? []) {
        let target = null;
        let dest = item.dest;
        if (typeof dest === "string") dest = await document.getDestination(dest);
        if (Array.isArray(dest)) target = pageSentinels[await document.getPageIndex(dest[0])];
        out.push([depth, item.title, target ?? (item.url ? `url:${item.url}` : null)]);
        await walk(item.items, depth + 1);
      }
    }
    await walk(await document.getOutline(), 0);
    return { outline: out, labels: await document.getPageLabels(), pages: pageSentinels };
  } finally {
    await task.destroy();
  }
}

describe("outline carry (unit)", () => {
  it("reads every destination form and resolves it to a page", async () => {
    const source = await PDFDocument.load(await buildDocument({ pages: 5, outline: REPORT_OUTLINE }));
    const outline = readSourceOutline(source);
    expect(outline.status).toBe("read");
    expect(outline.total).toBe(8);
    const flat = [];
    const walk = (entries, depth) => entries.forEach(entry => {
      flat.push([depth, entry.titleText, entry.page, entry.action?.kind ?? null]);
      walk(entry.children, depth + 1);
    });
    walk(outline.entries, 0);
    expect(flat).toEqual([
      [0, "Cover", 0, null],
      [0, "Contents", 1, null],
      [0, "Body", 2, null],
      [1, "Findings", 2, null],
      [1, "Methods", 3, null],
      [0, "Appendix", 4, null],
      [1, "Raw data", 4, null],
      [0, "Project site", null, "uri"],
    ]);
  });

  it("refuses a cyclic outline as unreadable instead of looping or guessing", async () => {
    const doc = await PDFDocument.create();
    const page = doc.addPage();
    const a = doc.context.nextRef();
    const b = doc.context.nextRef();
    const root = doc.context.nextRef();
    doc.context.assign(a, doc.context.obj({ Title: PDFString.of("A"), Parent: root, Next: b, Dest: [page.ref, PDFName.of("Fit")] }));
    doc.context.assign(b, doc.context.obj({ Title: PDFString.of("B"), Parent: root, Next: a, Dest: [page.ref, PDFName.of("Fit")] }));
    doc.context.assign(root, doc.context.obj({ Type: "Outlines", First: a, Last: b, Count: 2 }));
    doc.catalog.set(PDFName.of("Outlines"), root);
    const outline = readSourceOutline(await PDFDocument.load(await doc.save()));
    expect(outline).toMatchObject({ status: "unreadable", reason: "outline_cycle" });

    const target = await PDFDocument.create();
    target.addPage();
    const report = publicOutlineReport(writeCarriedOutline(target, [{ outline, targetPageFor: () => null }]));
    expect(report.status).toBe("not_carried");
    expect(describeOutlineReport(report)).toMatch(/NOT carried.*outline_cycle/);
    expect(target.catalog.get(PDFName.of("Outlines"))).toBeUndefined();
  });

  it("bounds the number of entries it will read", async () => {
    const many = Array.from({ length: OUTLINE_CARRY_LIMITS.maxEntries + 1 }, (_, index) => ({ title: `E${index}`, dest: 0 }));
    const outline = readSourceOutline(await PDFDocument.load(await buildDocument({ pages: 1, outline: many })));
    expect(outline).toMatchObject({ status: "unreadable", reason: "outline_too_large" });
  });

  it("keeps unsupported actions' titles but not the action, and says so", async () => {
    const source = await PDFDocument.load(await buildDocument({
      pages: 1,
      outline: [{ title: "Run script", dest: { javascript: true } }, { title: "Broken", dest: { missing: true } }],
    }));
    const target = await PDFDocument.create();
    const copied = await target.copyPages(source, [0]);
    target.addPage(copied[0]);
    const report = publicOutlineReport(writeCarriedOutline(target, [{
      outline: readSourceOutline(source),
      targetPageFor: page => (page === 0 ? copied[0].ref : null),
    }]));
    expect(report).toMatchObject({ status: "partial", carried_entries: 2, actions_not_carried: 1, unresolved_targets: 1 });
    const saved = await target.save();
    expect(Buffer.from(saved).toString("latin1")).not.toContain("JavaScript");
    expect(describeOutlineReport(report)).toMatch(/other than go-to/);
  });

  it("compares destination names by their bytes, not their decoded text", async () => {
    // <FEFF0061> and (a) both decode to "a" but are different names.
    const doc = await PDFDocument.create();
    const pages = [doc.addPage(), doc.addPage(), doc.addPage()];
    const context = doc.context;
    doc.catalog.set(PDFName.of("Names"), context.obj({
      Dests: context.register(context.obj({
        Names: context.obj([
          PDFString.of("a"), context.obj([pages[0].ref, PDFName.of("Fit")]),
          PDFHexString.of("FEFF0061"), context.obj([pages[2].ref, PDFName.of("Fit")]),
        ]),
      })),
    }));
    const item = context.nextRef();
    const root = context.nextRef();
    context.assign(item, context.obj({ Title: PDFString.of("A"), Parent: root, Dest: PDFString.of("a") }));
    context.assign(root, context.obj({ Type: "Outlines", First: item, Last: item, Count: 1 }));
    doc.catalog.set(PDFName.of("Outlines"), root);
    const outline = readSourceOutline(await PDFDocument.load(await doc.save()));
    expect(outline.entries[0].page).toBe(0);
  });

  it("writes a closed entry's /Count from every descendant it would show", async () => {
    const source = await PDFDocument.load(await buildDocument({
      pages: 1,
      outline: [{ title: "A", dest: 0, open: false, children: [{ title: "B", dest: 0, children: [{ title: "C", dest: 0 }] }] }],
    }));
    const target = await PDFDocument.create();
    const copied = await target.copyPages(source, [0]);
    target.addPage(copied[0]);
    writeCarriedOutline(target, [{ outline: readSourceOutline(source), targetPageFor: () => copied[0].ref }]);
    const root = target.context.lookup(target.catalog.get(PDFName.of("Outlines")));
    const a = target.context.lookup(root.get(PDFName.of("First")));
    expect(a.get(PDFName.of("Count")).asNumber()).toBe(-2);
    expect(root.get(PDFName.of("Count")).asNumber()).toBe(1);
  });

  it("ends a sibling chain at a reference to a missing object instead of dropping the outline", async () => {
    const doc = await PDFDocument.create();
    const page = doc.addPage();
    const context = doc.context;
    const item = context.nextRef();
    const root = context.nextRef();
    context.assign(item, context.obj({
      Title: PDFString.of("Only"), Parent: root, Next: PDFRef.of(9999, 0), Dest: [page.ref, PDFName.of("Fit")],
    }));
    context.assign(root, context.obj({ Type: "Outlines", First: item, Last: item, Count: 1 }));
    doc.catalog.set(PDFName.of("Outlines"), root);
    const outline = readSourceOutline(await PDFDocument.load(await doc.save()));
    expect(outline).toMatchObject({ status: "read", total: 1 });
  });

  it("reads page labels, including ranges and starting values", async () => {
    const labels = readSourcePageLabels(await PDFDocument.load(await buildDocument({
      pages: 4,
      outline: [{ title: "x", dest: 0 }],
      labels: context => context.obj([
        0, context.obj({ S: PDFName.of("r") }),
        2, context.obj({ S: PDFName.of("D"), P: PDFString.of("A-"), St: 7 }),
      ]),
    })));
    expect(labels.status).toBe("read");
    expect(labels.ranges.map(range => [range.start, range.style, range.prefix?.decodeText() ?? null, range.first]))
      .toEqual([[0, "r", null, 1], [2, "D", "A-", 7]]);
  });
});

describe("rebuilt outputs keep bookmarks and page labels (stdio)", () => {
  let client;
  let transport;
  let directory;
  let report;
  let form;

  async function call(name, args) {
    const result = await client.callTool({ name, arguments: args });
    expect(result.isError, JSON.stringify(result.content)).toBeFalsy();
    expect(validateStructuredToolResult(name, result).isError).toBeFalsy();
    return { text: result.content.map(block => block.text ?? "").join("\n"), structured: result.structuredContent };
  }

  beforeAll(async () => {
    directory = await createTestTempDirectory(REPO_ROOT, "outline-carry");
    report = path.join(directory, "report.pdf");
    form = path.join(directory, "form.pdf");
    await fs.writeFile(report, await buildDocument({
      pages: 5, outline: REPORT_OUTLINE, labels: romanThenDecimal, xmp: true,
    }));
    await fs.writeFile(form, await buildDocument({
      pages: 3,
      outline: [{ title: "Details", dest: 0 }, { title: "Instructions", dest: 1 }, { title: "Review", dest: 2 }],
      title: "Synthetic Form",
    }));
    transport = new StdioClientTransport({
      command: process.execPath,
      args: [path.join(REPO_ROOT, "server/index.js")],
      cwd: REPO_ROOT,
      env: { ...process.env, ALLOWED_DIRECTORIES: directory },
      stderr: "pipe",
    });
    client = new Client({ name: "outline-carry-test", version: "1.0.0" });
    await client.connect(transport);
  }, 30_000);

  afterAll(async () => {
    try {
      await client?.close();
      await transport?.close();
    } finally {
      await removeTestTempDirectory(directory);
    }
  });

  it("reorder_pdf_pages: every bookmark survives and still points at its own page", async () => {
    const output = path.join(directory, "reordered.pdf");
    const { text, structured } = await call("reorder_pdf_pages", {
      input_path: report, output_path: output, page_order: [5, 1, 2, 3, 4],
    });
    expect(structured.outline).toMatchObject({ status: "carried", source_entries: 8, carried_entries: 8, dropped_entries: 0 });
    expect(text).toContain("Bookmarks: kept 8 of 8.");
    const bytes = await fs.readFile(output);
    const read = await outlineWithPdfjs(bytes);
    expect(read.pages).toEqual(["SENTINEL-5", "SENTINEL-1", "SENTINEL-2", "SENTINEL-3", "SENTINEL-4"]);
    expect(read.outline).toEqual([
      [0, "Cover", "SENTINEL-1"],
      [0, "Contents", "SENTINEL-2"],
      [0, "Body", "SENTINEL-3"],
      [1, "Findings", "SENTINEL-3"],
      [1, "Methods", "SENTINEL-4"],
      [0, "Appendix", "SENTINEL-5"],
      [1, "Raw data", "SENTINEL-5"],
      [0, "Project site", "url:https://example.invalid/report"],
    ]);
    // Labels follow their pages: the page printed "3" is still "3" up front.
    // Source XMP is deliberately not copied into a rebuilt output
    // (docs/METADATA_PROVENANCE.md); a fresh packet states only what the
    // output's Info already asserts.
    expect(read.labels).toEqual(["3", "i", "ii", "1", "2"]);
    expect(structured.page_labels).toBe("carried");
    const reloaded = await PDFDocument.load(bytes);
    const packet = new TextDecoder().decode(reloaded.catalog.lookup(PDFName.of("Metadata")).getContents());
    expect(readXmpDocumentFields(packet).title).toEqual({ state: "value", value: "Synthetic Outline Report" });
    expect(packet).not.toContain("xmpMM:");
    expect(reloaded.catalog.get(PDFName.of("PageMode"))).toBe(PDFName.of("UseOutlines"));
    // The closed entry stays closed.
    const appendix = readSourceOutline(reloaded).entries.find(entry => entry.titleText === "Appendix");
    expect(appendix.open).toBe(false);
  });

  it("apply_page_plan: deleting a page drops only its bookmarks, promotes children, and names the loss", async () => {
    const output = path.join(directory, "deleted.pdf");
    const { text, structured } = await call("apply_page_plan", {
      input_path: report, output_path: output, plan: { page_order: [1, 2, 4, 5] },
    });
    expect(structured.outline).toMatchObject({
      status: "partial",
      source_entries: 8,
      carried_entries: 6,
      dropped_entries: 2,
      dropped: [
        { title: "Findings", source_page: 3, reason: "page_not_in_output" },
        { title: "Body", source_page: 3, reason: "page_not_in_output" },
      ],
    });
    expect(text).toContain("Removed 2 bookmark(s) whose pages are not in this output: \"Findings\" (page 3), \"Body\" (page 3).");
    const read = await outlineWithPdfjs(await fs.readFile(output));
    expect(read.outline).toEqual([
      [0, "Cover", "SENTINEL-1"],
      [0, "Contents", "SENTINEL-2"],
      [0, "Methods", "SENTINEL-4"],
      [0, "Appendix", "SENTINEL-5"],
      [1, "Raw data", "SENTINEL-5"],
      [0, "Project site", "url:https://example.invalid/report"],
    ]);
    // Deleting the third page leaves every other page with its own label.
    expect(read.labels).toEqual(["i", "ii", "2", "3"]);
  });

  it("apply_page_plan: deleting the cover keeps each page's printed label", async () => {
    const output = path.join(directory, "no-cover.pdf");
    await call("apply_page_plan", { input_path: report, output_path: output, plan: { page_order: [2, 3, 4, 5] } });
    expect((await outlineWithPdfjs(await fs.readFile(output))).labels).toEqual(["ii", "1", "2", "3"]);
  });

  it("split_pdf: each part keeps its own pages' bookmarks and labels; a page in no part is named", async () => {
    const outputDirectory = path.join(directory, "split");
    const { text, structured } = await call("split_pdf", {
      input_path: report, output_directory: outputDirectory, page_ranges: "1-2,4-5",
    });
    expect(structured.outline).toMatchObject({ status: "partial", dropped_entries: 2 });
    expect(structured.files.map(file => file.outline.carried_entries)).toEqual([2, 4]);
    expect(text).toContain("\"Findings\" (page 3), \"Body\" (page 3)");
    const first = await outlineWithPdfjs(await fs.readFile(structured.files[0].output_path));
    expect(first.outline).toEqual([
      [0, "Cover", "SENTINEL-1"],
      [0, "Contents", "SENTINEL-2"],
    ]);
    expect(first.labels).toEqual(["i", "ii"]);
    // The link bookmark follows the bookmark before it (Appendix, page 5),
    // so it lands in the part that holds page 5 and nowhere else.
    const second = await outlineWithPdfjs(await fs.readFile(structured.files[1].output_path));
    expect(second.outline).toEqual([
      [0, "Methods", "SENTINEL-4"],
      [0, "Appendix", "SENTINEL-5"],
      [1, "Raw data", "SENTINEL-5"],
      [0, "Project site", "url:https://example.invalid/report"],
    ]);
    // Source pages 4 and 5 were labelled 2 and 3; the excerpt keeps that.
    expect(second.labels).toEqual(["2", "3"]);
  });

  it("split_pdf: never says none lost when a bookmark lost its target or action", async () => {
    const broken = path.join(directory, "broken-target.pdf");
    await fs.writeFile(broken, await buildDocument({
      pages: 2,
      outline: [{ title: "One", dest: 0 }, { title: "Nowhere", dest: { missing: true } }],
    }));
    const { text, structured } = await call("split_pdf", {
      input_path: broken, output_directory: path.join(directory, "split-broken"), page_ranges: "1-2",
    });
    expect(structured.outline).toMatchObject({ status: "partial", unresolved_targets: 1 });
    expect(text).not.toContain("none lost");
    expect(text).toContain("destination the source does not resolve");
  });

  it("split_pdf: when every page lands in some part, it says nothing was lost", async () => {
    const { text, structured } = await call("split_pdf", {
      input_path: report, output_directory: path.join(directory, "split-all"), page_ranges: "1-3,4-5",
    });
    expect(structured.outline).toMatchObject({ status: "carried", dropped_entries: 0 });
    expect(text).toContain("each part keeps the bookmarks for its own pages (8 in the source, none lost)");
  });

  it("merge_pdfs: bookmarks from every source follow their pages", async () => {
    const output = path.join(directory, "merged.pdf");
    const { text, structured } = await call("merge_pdfs", { input_paths: [form, report], output_path: output });
    expect(structured.outline).toMatchObject({ status: "carried", source_entries: 11, carried_entries: 11 });
    expect(text).toContain("Bookmarks: kept 11 of 11.");
    const read = await outlineWithPdfjs(await fs.readFile(output));
    expect(read.outline.slice(0, 4)).toEqual([
      [0, "Details", "SENTINEL-1"],
      [0, "Instructions", "SENTINEL-2"],
      [0, "Review", "SENTINEL-3"],
      [0, "Cover", "SENTINEL-1"],
    ]);
    expect(read.outline.find(entry => entry[1] === "Methods")).toEqual([1, "Methods", "SENTINEL-4"]);
    expect(read.outline).toHaveLength(11);
    // The form had no labels, so its pages keep the plain numbers it showed.
    expect(read.labels).toEqual(["1", "2", "3", "i", "ii", "1", "2", "3"]);
    expect(structured.page_labels).toBe("carried");
  });

  it("a source with no outline still produces none, and the reply stays quiet about bookmarks", async () => {
    const plain = path.join(directory, "plain.pdf");
    const doc = await PDFDocument.create();
    doc.addPage();
    doc.addPage();
    await fs.writeFile(plain, await doc.save());
    const { text, structured } = await call("reorder_pdf_pages", {
      input_path: plain, output_path: path.join(directory, "plain-reordered.pdf"), page_order: [2, 1],
    });
    expect(structured.outline.status).toBe("absent");
    expect(text).not.toContain("Bookmarks");
  });
});
