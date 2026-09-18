import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { PDFDocument, degrees } from "pdf-lib";
import fs from "fs/promises";
import path from "path";
import { fileURLToPath } from "url";
import {
  PAGE_ANALYSIS_RETRY_GUIDANCE,
  PAGE_ANALYSIS_MUTATION_GUIDANCE,
  IMAGE_DOMINATED_MIN_PAINTS,
  MIN_TEXT_CHARS,
  MIN_TEXT_CHARS_WITH_IMAGES,
  TEXT_PAGE_RATIO_THRESHOLD,
  VECTOR_SEGMENT_MIN,
  analyzePdfPages,
  classifyPageRouting,
  getPageDisplayMetrics,
  rollupPageClassification,
} from "../server/helpers.js";
import { createTestTempDirectory, removeTestTempDirectory } from "./helpers/temp-directory.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.join(__dirname, "..");
const EXAMPLE_PDF = path.join(REPO_ROOT, "example-fw9.pdf");
let TMP_DIR;

// Reproduce the get_page_analysis logic for testing
// Uses pdf-lib for dimensions (fast) — pdfjs-dist text extraction tested separately
async function getPageAnalysis(inputPath, password) {
  const pdfBytes = await fs.readFile(inputPath);
  const pdfDoc = await PDFDocument.load(pdfBytes, password ? { password } : { ignoreEncryption: true });
  const pages = pdfDoc.getPages();

  const pageMeta = pages.map((page, i) => {
    const { width, height } = page.getSize();
    const metrics = getPageDisplayMetrics({ width, height, rotation: page.getRotation().angle });
    return {
      page: i + 1,
      width: metrics.width,
      height: metrics.height,
      display_width: metrics.display_width,
      display_height: metrics.display_height,
      rotation: metrics.rotation,
      orientation: metrics.orientation,
    };
  });

  const orientationCounts = { portrait: 0, landscape: 0 };
  for (const p of pageMeta) orientationCounts[p.orientation]++;
  const majorityOrientation = orientationCounts.portrait >= orientationCounts.landscape ? "portrait" : "landscape";

  return { total_pages: pages.length, majority_orientation: majorityOrientation, pages: pageMeta };
}

describe("get_page_analysis", () => {
  let result;

  beforeAll(async () => {
    TMP_DIR = await createTestTempDirectory(REPO_ROOT, "analysis");
    result = await getPageAnalysis(EXAMPLE_PDF);
  });

  afterAll(async () => {
    await removeTestTempDirectory(TMP_DIR);
  });

  it("returns correct total page count", () => {
    expect(result.total_pages).toBeGreaterThan(0);
  });

  it("returns per-page dimensions", () => {
    for (const page of result.pages) {
      expect(page.width).toBeGreaterThan(0);
      expect(page.height).toBeGreaterThan(0);
      expect(page.page).toBeGreaterThanOrEqual(1);
    }
  });

  it("detects orientation correctly", () => {
    for (const page of result.pages) {
      if (page.display_width > page.display_height) {
        expect(page.orientation).toBe("landscape");
      } else {
        expect(page.orientation).toBe("portrait");
      }
    }
  });

  it("determines majority orientation", () => {
    expect(["portrait", "landscape"]).toContain(result.majority_orientation);
  });

  it("page numbers are 1-indexed and sequential", () => {
    result.pages.forEach((p, i) => {
      expect(p.page).toBe(i + 1);
    });
  });

  it("example-fw9.pdf is portrait (standard letter size)", () => {
    // W-9 form is US letter: 612 x 792 points
    const page1 = result.pages[0];
    expect(page1.orientation).toBe("portrait");
    expect(page1.width).toBeLessThan(page1.height);
  });

  it("treats a 90-degree rotated portrait page as landscape for display", async () => {
    const rotatedPath = path.join(TMP_DIR, "rotated-analysis.pdf");
    const doc = await PDFDocument.create();
    doc.addPage([612, 792]);
    const rotatedPage = doc.addPage([612, 792]);
    rotatedPage.setRotation(degrees(90));
    await fs.writeFile(rotatedPath, await doc.save());

    const rotatedResult = await getPageAnalysis(rotatedPath);
    expect(rotatedResult.pages[1].rotation).toBe(90);
    expect(rotatedResult.pages[1].orientation).toBe("landscape");
    expect(rotatedResult.pages[1].display_width).toBeGreaterThan(rotatedResult.pages[1].display_height);
  });
});

function fakePdfLibPages(count) {
  return Array.from({ length: count }, () => ({
    getSize: () => ({ width: 612, height: 792 }),
    getRotation: () => ({ angle: 0 }),
  }));
}

function fakePdfjs(pageBehaviors, { documentFailure = false } = {}) {
  const OPS = {
    paintImageXObject: 1,
    paintJpegXObject: 2,
    paintImageMaskXObject: 3,
    fill: 4,
    constructPath: 5,
    setTextRenderingMode: 6,
    showText: 7,
    save: 8,
    restore: 9,
  };
  const document = {
    async getPage(pageNumber) {
      const behavior = pageBehaviors[pageNumber - 1] ?? {};
      if (behavior.pageFailure) throw new Error("forced page load failure");
      return {
        async getTextContent() {
          if (behavior.textFailure) throw new Error("forced text failure");
          return { items: [{ str: behavior.text ?? "" }] };
        },
        async getOperatorList() {
          if (behavior.imageFailure) throw new Error("forced image failure");
          const fnArray = [];
          const argsArray = [];
          if (behavior.hasImages) {
            fnArray.push(OPS.paintImageXObject);
            argsArray.push(null);
          }
          if (behavior.hasGraphics) {
            fnArray.push(OPS.fill);
            argsArray.push(null);
          }
          if (behavior.pathSegments) {
            const buffer = [];
            for (let index = 0; index < behavior.pathSegments; index += 1) {
              buffer.push(0, 0, 0);
            }
            fnArray.push(OPS.constructPath);
            argsArray.push([0, [buffer], null]);
          }
          return { fnArray, argsArray };
        },
      };
    },
    async destroy() {},
  };
  return {
    OPS,
    getDocument() {
      return {
        promise: documentFailure
          ? Promise.reject(new Error("forced document load failure"))
          : Promise.resolve(document),
      };
    },
  };
}

describe("get_page_analysis content provenance", () => {
  it("makes a whole-document PDF.js failure explicitly unavailable, never blank", async () => {
    const result = await analyzePdfPages({
      pdfLibPages: fakePdfLibPages(2),
      pdfBytes: new Uint8Array([1]),
      pdfjsLib: fakePdfjs([], { documentFailure: true }),
    });

    expect(result).toMatchObject({
      content_analysis_status: "degraded",
      content_analysis_complete: false,
      likely_blank_pages: [],
      unknown_pages: [1, 2],
      retry_guidance: PAGE_ANALYSIS_RETRY_GUIDANCE,
      mutation_guidance: PAGE_ANALYSIS_MUTATION_GUIDANCE,
      analysis_errors: [{ scope: "document", code: "PDFJS_DOCUMENT_LOAD_FAILED" }],
    });
    for (const page of result.pages) {
      expect(page).toMatchObject({
        text_length: null,
        text_snippet: null,
        has_images: null,
        has_graphics: null,
        content_analysis_status: "unavailable",
        blank_status: "unknown",
      });
      expect(page.analysis_error_codes).toEqual(["PDFJS_DOCUMENT_LOAD_FAILED"]);
    }
  });

  it("keeps successful and positive partial evidence while isolating unknown pages", async () => {
    const result = await analyzePdfPages({
      pdfLibPages: fakePdfLibPages(6),
      pdfBytes: new Uint8Array([1]),
      pdfjsLib: fakePdfjs([
        { text: "", hasImages: false },
        { text: "Revenue", imageFailure: true },
        { textFailure: true, hasImages: false },
        { textFailure: true, hasImages: true },
        { textFailure: true, hasGraphics: true },
        { pageFailure: true },
      ]),
    });

    expect(result).toMatchObject({
      content_analysis_status: "degraded",
      content_analysis_complete: false,
      likely_blank_pages: [1],
      nonblank_pages: [2, 4, 5],
      unknown_pages: [3, 6],
      retry_guidance: PAGE_ANALYSIS_RETRY_GUIDANCE,
    });
    expect(result.pages[0]).toMatchObject({
      content_analysis_status: "complete",
      text_length: 0,
      has_images: false,
      has_graphics: false,
      blank_status: "likely_blank",
    });
    expect(result.pages[1]).toMatchObject({
      content_analysis_status: "degraded",
      text_length: 7,
      has_images: null,
      has_graphics: null,
      blank_status: "not_blank",
      analysis_error_codes: ["PDFJS_OPERATOR_ANALYSIS_FAILED"],
    });
    expect(result.pages[2]).toMatchObject({
      content_analysis_status: "degraded",
      text_length: null,
      has_images: false,
      has_graphics: false,
      blank_status: "unknown",
      analysis_error_codes: ["PDFJS_TEXT_EXTRACTION_FAILED"],
    });
    expect(result.pages[3]).toMatchObject({
      content_analysis_status: "degraded",
      text_length: null,
      has_images: true,
      has_graphics: false,
      blank_status: "not_blank",
    });
    expect(result.pages[4]).toMatchObject({
      content_analysis_status: "degraded",
      text_length: null,
      has_images: false,
      has_graphics: true,
      blank_status: "not_blank",
    });
    expect(result.pages[5]).toMatchObject({
      content_analysis_status: "unavailable",
      text_length: null,
      has_images: null,
      has_graphics: null,
      blank_status: "unknown",
      analysis_error_codes: ["PDFJS_PAGE_LOAD_FAILED"],
    });
  });

  it("marks pages beyond the analysis cap unknown instead of blank", async () => {
    const result = await analyzePdfPages({
      pdfLibPages: fakePdfLibPages(2),
      pdfBytes: new Uint8Array([1]),
      pdfjsLib: fakePdfjs([{ text: "a".repeat(30), hasImages: false }]),
      maxPages: 1,
    });

    expect(result).toMatchObject({
      content_analysis_status: "partial",
      nonblank_pages: [1],
      unknown_pages: [2],
      retry_guidance: PAGE_ANALYSIS_RETRY_GUIDANCE,
      classification: {
        document_kind: "text_based",
        pages_analyzed: 1,
        pages_needing_vision: [],
        pages_not_analyzed: [2],
      },
    });
    expect(result.pages[1]).toMatchObject({
      content_analysis_status: "not_analyzed",
      text_length: null,
      has_images: null,
      has_graphics: null,
      blank_status: "unknown",
    });
  });

  it("counts image paints and DrawOPS segments from the same operator-list read", async () => {
    const result = await analyzePdfPages({
      pdfLibPages: fakePdfLibPages(1),
      pdfBytes: new Uint8Array([1]),
      pdfjsLib: fakePdfjs([{ text: "enough text", hasImages: true, pathSegments: 3 }]),
    });
    expect(result.pages[0]).toMatchObject({
      image_op_count: 1,
      path_op_count: 1,
      path_segment_count: 3,
      has_images: true,
      has_graphics: true,
    });
  });
});

function measuredPage({ page = 1, textLength = 25, imageOpCount = 0, pathSegmentCount = 0, textIntegrity } = {}) {
  return {
    page,
    text_length: textLength,
    text_extraction_status: "complete",
    image_detection_status: "complete",
    graphics_detection_status: "complete",
    image_op_count: imageOpCount,
    path_op_count: pathSegmentCount > 0 ? 1 : 0,
    path_segment_count: pathSegmentCount,
    content_analysis_status: "complete",
    ...(textIntegrity ? { text_integrity: textIntegrity } : {}),
  };
}

describe("get_page_analysis classification and routing", () => {
  it("adds only the suspect-integrity routing reason", () => {
    expect(classifyPageRouting(measuredPage({
      textIntegrity: {
        status: "suspect",
        signals: [{ kind: "private_use_runs", count: 1 }],
      },
    }))).toEqual({ text_bearing: true, reasons: ["suspected_text_integrity"] });
    expect(classifyPageRouting(measuredPage({
      textIntegrity: { status: "ok", signals: [] },
    }))).toEqual({ text_bearing: true, reasons: [] });
    expect(classifyPageRouting({
      ...measuredPage(),
      content_analysis_status: "unavailable",
      text_extraction_status: "failed",
      text_integrity: { status: "unavailable", signals: [] },
      text_length: null,
      image_op_count: null,
      path_op_count: null,
      path_segment_count: null,
    }).reasons).not.toContain("suspected_text_integrity");
  });

  it("pins text and image threshold boundaries", () => {
    expect(classifyPageRouting(measuredPage({ textLength: MIN_TEXT_CHARS - 1 })).reasons)
      .toEqual(["no_text_layer"]);
    expect(classifyPageRouting(measuredPage({ textLength: MIN_TEXT_CHARS })).text_bearing)
      .toBe(true);
    expect(classifyPageRouting(measuredPage({
      textLength: MIN_TEXT_CHARS_WITH_IMAGES - 1,
      imageOpCount: IMAGE_DOMINATED_MIN_PAINTS,
    })).reasons).toEqual(["image_dominated"]);
    expect(classifyPageRouting(measuredPage({
      textLength: MIN_TEXT_CHARS_WITH_IMAGES,
      imageOpCount: IMAGE_DOMINATED_MIN_PAINTS,
    })).text_bearing).toBe(true);
  });

  it("routes high-vector low-text pages and preserves unavailable truth", () => {
    expect(classifyPageRouting(measuredPage({
      textLength: 29,
      pathSegmentCount: VECTOR_SEGMENT_MIN,
    })).reasons).toEqual(["vector_only_text"]);
    expect(classifyPageRouting({
      ...measuredPage(),
      text_extraction_status: "failed",
      text_length: null,
      image_op_count: null,
      path_op_count: null,
      path_segment_count: null,
    })).toEqual({ text_bearing: null, reasons: ["analysis_unavailable"] });
  });

  it("uses the inclusive 0.6 text-page ratio and is deterministic", () => {
    const pages = [
      measuredPage({ page: 1, textLength: 25 }),
      measuredPage({ page: 2, textLength: 25 }),
      measuredPage({ page: 3, textLength: 25 }),
      measuredPage({ page: 4, textLength: 0 }),
      measuredPage({ page: 5, textLength: 0 }),
    ];
    expect(3 / pages.length).toBe(TEXT_PAGE_RATIO_THRESHOLD);
    const first = rollupPageClassification(pages);
    expect(first).toEqual(rollupPageClassification(pages));
    expect(first.document_kind).toBe("text_based");
    expect(first.pages_needing_vision).toEqual([
      { page: 4, reasons: ["no_text_layer"] },
      { page: 5, reasons: ["no_text_layer"] },
    ]);
  });

  it("classifies below the ratio threshold as mixed and keeps vision pages explicit above it", () => {
    const belowThreshold = rollupPageClassification([
      measuredPage({ page: 1, textLength: 25 }),
      measuredPage({ page: 2, textLength: 25 }),
      measuredPage({ page: 3, textLength: 0 }),
      measuredPage({ page: 4, textLength: 0 }),
    ]);
    expect(belowThreshold.document_kind).toBe("mixed");
    expect(belowThreshold.pages_needing_vision).toEqual([
      { page: 3, reasons: ["no_text_layer"] },
      { page: 4, reasons: ["no_text_layer"] },
    ]);

    const aboveThreshold = rollupPageClassification([
      measuredPage({ page: 1, textLength: 25 }),
      measuredPage({ page: 2, textLength: 25 }),
      measuredPage({ page: 3, textLength: 25 }),
      measuredPage({ page: 4, textLength: 25 }),
      measuredPage({ page: 5, textLength: 0 }),
      measuredPage({ page: 6, textLength: 0, imageOpCount: 1 }),
    ]);
    expect(aboveThreshold.document_kind).toBe("text_based");
    expect(aboveThreshold.pages_needing_vision).toEqual([
      { page: 5, reasons: ["no_text_layer"] },
      { page: 6, reasons: ["image_dominated"] },
    ]);
  });

  it("pins vector and trimmed-text boundaries", async () => {
    expect(classifyPageRouting(measuredPage({ textLength: 29, pathSegmentCount: VECTOR_SEGMENT_MIN - 1 })))
      .toEqual({ text_bearing: true, reasons: [] });
    expect(classifyPageRouting(measuredPage({ textLength: 29, pathSegmentCount: VECTOR_SEGMENT_MIN })))
      .toEqual({ text_bearing: true, reasons: ["vector_only_text"] });
    expect(classifyPageRouting(measuredPage({ textLength: 29, pathSegmentCount: VECTOR_SEGMENT_MIN + 1 })))
      .toEqual({ text_bearing: true, reasons: ["vector_only_text"] });
    expect(classifyPageRouting(measuredPage({ textLength: 30, pathSegmentCount: VECTOR_SEGMENT_MIN })))
      .toEqual({ text_bearing: true, reasons: [] });

    const whitespace = await analyzePdfPages({
      pdfLibPages: fakePdfLibPages(1),
      pdfBytes: new Uint8Array([1]),
      pdfjsLib: fakePdfjs([{ text: " \n\t  " }]),
    });
    expect(whitespace.pages[0].text_length).toBe(5);
    expect(classifyPageRouting(whitespace.pages[0])).toEqual({
      text_bearing: false,
      reasons: ["no_text_layer"],
    });
  });

  it("keeps an unavailable page unknown unless the remaining evidence proves mixed", () => {
    const text = measuredPage({ page: 1, textLength: 40 });
    const unavailable = {
      ...measuredPage({ page: 2 }),
      content_analysis_status: "unavailable",
      text_extraction_status: "failed",
      image_detection_status: "failed",
      graphics_detection_status: "failed",
      text_length: null,
      image_op_count: null,
      path_op_count: null,
      path_segment_count: null,
    };
    expect(rollupPageClassification([text, unavailable]).document_kind).toBe("unknown");
    expect(rollupPageClassification([
      text,
      measuredPage({ page: 2, textLength: 0, imageOpCount: 1 }),
      unavailable,
    ]).document_kind).toBe("mixed");
    // The discriminating regression case: available ratio 2/3 >= 0.6 must NOT
    // absorb an attempted-but-failed page into text_based.
    expect(rollupPageClassification([
      text,
      measuredPage({ page: 2, textLength: 55 }),
      measuredPage({ page: 3, textLength: 0, imageOpCount: 1 }),
      unavailable,
    ]).document_kind).toBe("mixed");
  });

  it("excludes not-analyzed pages from vision routing", () => {
    expect(classifyPageRouting({ content_analysis_status: "not_analyzed" })).toEqual({
      text_bearing: null,
      reasons: [],
    });
    const result = rollupPageClassification([
      measuredPage({ page: 1, textLength: 30 }),
      {
        page: 2,
        content_analysis_status: "not_analyzed",
        text_extraction_status: "not_analyzed",
        image_detection_status: "not_analyzed",
        graphics_detection_status: "not_analyzed",
      },
    ], 1);
    expect(result).toEqual({
      document_kind: "text_based",
      pages_analyzed: 1,
      pages_needing_vision: [],
      pages_not_analyzed: [2],
    });
  });
});
