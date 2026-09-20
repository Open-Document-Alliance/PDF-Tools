import { createHash } from "node:crypto";
import path from "path";
import fs from "fs/promises";
import { fileURLToPath, pathToFileURL } from "url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createCanvas, loadImage } from "@napi-rs/canvas";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { PDFDocument, PDFName, PDFNumber, degrees, rgb } from "pdf-lib";
import {
  getPageRenderScale,
  getRegionPixelRect,
  validatePdfRegionBox,
} from "../server/helpers.js";
import { validateStructuredToolResult } from "../server/output-schemas.js";
import { createTestTempDirectory, removeTestTempDirectory } from "./helpers/temp-directory.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.join(__dirname, "..");
const EXAMPLE_PDF = path.join(REPO_ROOT, "example-fw9.pdf");

async function writeCoordinateTruthFixture(targetPath, rotation = 90) {
  const document = await PDFDocument.create();
  const page = document.addPage([400, 400]);
  page.setMediaBox(50, 60, 400, 400);
  page.setCropBox(100, 100, 200, 100);
  page.setRotation(degrees(rotation));
  page.node.set(PDFName.of("UserUnit"), PDFNumber.of(2));
  const redCorner = new Map([
    [0, { x: 100, y: 150 }],
    [90, { x: 100, y: 100 }],
    [180, { x: 250, y: 100 }],
    [270, { x: 250, y: 150 }],
  ]).get(rotation);
  const blueCorner = new Map([
    [0, { x: 250, y: 100 }],
    [90, { x: 250, y: 150 }],
    [180, { x: 100, y: 150 }],
    [270, { x: 100, y: 100 }],
  ]).get(rotation);
  if (!redCorner) throw new Error(`Unsupported test rotation ${rotation}.`);
  page.drawRectangle({ ...redCorner, width: 50, height: 50, color: rgb(1, 0, 0) });
  page.drawRectangle({ ...blueCorner, width: 50, height: 50, color: rgb(0, 0, 1) });
  await fs.writeFile(targetPath, await document.save({ useObjectStreams: false }));
}

describe("getPageRenderScale", () => {
  it("bounds the scale to the requested dominant dimension", () => {
    expect(getPageRenderScale({ width: 612, height: 792, maxDimensionPx: 1584 })).toBe(2);
  });

  it("respects the configured maxScale ceiling", () => {
    expect(getPageRenderScale({ width: 100, height: 200, maxDimensionPx: 5000, maxScale: 2.5 })).toBe(2.5);
  });

  it("can downscale below 1 when a bounded render must honor a smaller maximum", () => {
    expect(getPageRenderScale({
      width: 3000,
      height: 500,
      maxDimensionPx: 1400,
      minScale: 0.1,
    })).toBeCloseTo(0.47, 2);
  });
});

describe("PDF region helpers", () => {
  it("validates an in-bounds region", () => {
    expect(() => validatePdfRegionBox({
      pageWidth: 612,
      pageHeight: 792,
      x: 72,
      y: 120,
      width: 180,
      height: 60,
    })).not.toThrow();
  });

  it("rejects an out-of-bounds region", () => {
    expect(() => validatePdfRegionBox({
      pageWidth: 612,
      pageHeight: 792,
      x: 500,
      y: 760,
      width: 200,
      height: 80,
    })).toThrow(/outside page bounds/);
  });

  it("converts point regions to cropped pixel rectangles", () => {
    expect(getRegionPixelRect({
      x: 72,
      y: 120,
      width: 180,
      height: 60,
      scale: 2,
    })).toEqual({
      left: 144,
      top: 240,
      width: 360,
      height: 120,
    });
  });
});

describe("render_pdf_page MCP tool", () => {
  let client;
  let transport;
  let tempDirectory;

  beforeAll(async () => {
    tempDirectory = await createTestTempDirectory(REPO_ROOT, "render");
    client = new Client({ name: "pdf-tools-test-client", version: "1.0.0" });
    transport = new StdioClientTransport({
      command: process.execPath,
      args: [path.join(REPO_ROOT, "server", "index.js")],
      cwd: REPO_ROOT,
      env: {
        ALLOWED_DIRECTORIES: REPO_ROOT,
      },
      stderr: "pipe",
    });
    await client.connect(transport);
  }, 30_000);

  afterAll(async () => {
    try {
      await transport?.close();
    } finally {
      await removeTestTempDirectory(tempDirectory);
    }
  });

  it("is listed and returns a rendered PNG plus structured metadata", async () => {
    const tools = await client.listTools();
    expect(tools.tools.some(tool => tool.name === "render_pdf_page")).toBe(true);

    const result = await client.callTool({
      name: "render_pdf_page",
      arguments: {
        pdf_path: EXAMPLE_PDF,
        page: 1,
        max_dimension_px: 1200,
      },
    });

    expect(result.isError).not.toBe(true);
    expect(result.content.some(item => item.type === "image" && item.mimeType === "image/png")).toBe(true);
    expect(result.structuredContent).toMatchObject({
      pdf_path: EXAMPLE_PDF,
      page: 1,
      total_pages: 4,
      mime_type: "image/png",
    });
    expect(result.structuredContent.rendered_width_px).toBeGreaterThan(0);
    expect(result.structuredContent.rendered_height_px).toBeGreaterThan(0);
    expect(result.structuredContent.scale).toBeGreaterThanOrEqual(1);
    const image = result.content.find(item => item.type === "image");
    const sourceBytes = await fs.readFile(EXAMPLE_PDF);
    expect(result.structuredContent).toMatchObject({
      observation_schema_version: "1.0",
      source: {
        sha256: createHash("sha256").update(sourceBytes).digest("hex"),
        size_bytes: sourceBytes.length,
      },
      raw_pixel_status: "available",
      // The system-renderer fallback is a macOS capability, so pdfjsRendererPolicy
      // reports plain "native" everywhere else. The hardcoded darwin value failed
      // on every non-darwin host; it stayed hidden because the aggregate gate runs
      // on macOS.
      renderer_policy: process.platform === "darwin" ? "native_with_system_fallback" : "native",
    });
    expect(result.structuredContent.png_sha256)
      .toBe(createHash("sha256").update(Buffer.from(image.data, "base64")).digest("hex"));
    expect(result.structuredContent.raw_pixel_sha256).toMatch(/^[a-f0-9]{64}$/);
    const tampered = structuredClone(result);
    tampered.structuredContent.png_sha256 = "0".repeat(64);
    expect(validateStructuredToolResult("render_pdf_page", tampered).structuredContent.error.code)
      .toBe("internal_validation_error");
  }, 30_000);

  it("renders a bounded region using top-left point coordinates", async () => {
    const result = await client.callTool({
      name: "render_pdf_region",
      arguments: {
        pdf_path: EXAMPLE_PDF,
        page: 1,
        x: 72,
        y: 120,
        width: 180,
        height: 60,
        max_dimension_px: 1000,
      },
    });

    expect(result.isError).not.toBe(true);
    expect(result.content.some(item => item.type === "image" && item.mimeType === "image/png")).toBe(true);
    expect(result.structuredContent).toMatchObject({
      pdf_path: EXAMPLE_PDF,
      page: 1,
      total_pages: 4,
      region_points: {
        x: 72,
        y: 120,
        width: 180,
        height: 60,
      },
      mime_type: "image/png",
    });
    expect(result.structuredContent.rendered_width_px).toBeGreaterThan(0);
    expect(result.structuredContent.rendered_height_px).toBeGreaterThan(0);
    const image = result.content.find(item => item.type === "image");
    expect(result.structuredContent.png_sha256)
      .toBe(createHash("sha256").update(Buffer.from(image.data, "base64")).digest("hex"));
    expect(result.structuredContent.requested_region).toEqual(result.structuredContent.region_points);
  }, 30_000);

  // max_dimension_px is a target, not a ceiling: the scale clamp wins at both
  // ends. The input-schema descriptions say so, and these calls hold them to it.
  it("renders past or short of max_dimension_px exactly where the documented scale clamps apply", async () => {
    const longerSide = result => Math.max(
      result.structuredContent.rendered_width_px,
      result.structuredContent.rendered_height_px,
    );
    const call = async (name, args) => {
      const result = await client.callTool({ name, arguments: { pdf_path: EXAMPLE_PDF, page: 1, ...args } });
      expect(result.isError, `${name} ${JSON.stringify(args)}`).not.toBe(true);
      return result;
    };
    const renderPage = (await client.listTools()).tools.find(tool => tool.name === "render_pdf_page");
    const renderRegion = (await client.listTools()).tools.find(tool => tool.name === "render_pdf_region");
    expect(renderPage.inputSchema.properties.max_dimension_px.description)
      .toMatch(/integer from 64 to 8192[\s\S]*between 1 and 2\.5 pixels per PDF\.js viewport point/);
    expect(renderRegion.inputSchema.properties.max_dimension_px.description)
      .toMatch(/integer from 64 to 8192[\s\S]*between 0\.1 and 4 pixels per PDF\.js viewport point/);

    const smallPage = await call("render_pdf_page", { max_dimension_px: 64 });
    const pageView = smallPage.structuredContent.page_view;
    const pageLongerSide = Math.max(pageView.width_points, pageView.height_points);
    expect(pageLongerSide).toBeGreaterThan(64);
    expect(smallPage.structuredContent.scale).toBe(1);
    expect(longerSide(smallPage)).toBeGreaterThan(64);

    expect(8192).toBeGreaterThan(pageLongerSide * 2.5);
    const largePage = await call("render_pdf_page", { max_dimension_px: 8192 });
    expect(largePage.structuredContent.scale).toBe(2.5);
    expect(longerSide(largePage)).toBeLessThan(8192);

    for (const outOfRange of [63, 8193, 1600.5]) {
      const refused = await client.callTool({
        name: "render_pdf_page",
        arguments: { pdf_path: EXAMPLE_PDF, page: 1, max_dimension_px: outOfRange },
      }).catch(error => ({ isError: true, thrown: error }));
      expect(refused.isError, `max_dimension_px ${outOfRange}`).toBe(true);
    }

    const wholePageRegion = { x: 0, y: 0, width: pageView.width_points, height: pageView.height_points };
    expect(pageLongerSide).toBeGreaterThan(64 * 10);
    const smallRegion = await call("render_pdf_region", { ...wholePageRegion, max_dimension_px: 64 });
    expect(smallRegion.structuredContent.scale).toBe(0.1);
    expect(longerSide(smallRegion)).toBeGreaterThan(64);

    const largeRegion = await call("render_pdf_region", { x: 72, y: 72, width: 100, height: 50, max_dimension_px: 8192 });
    expect(largeRegion.structuredContent.scale).toBe(4);
    expect(longerSide(largeRegion)).toBe(400);
  }, 60_000);

  it("keeps region coordinates aligned on rotated pages by rendering in native page space", async () => {
    const rotatedPdfPath = path.join(tempDirectory, "rotated-region.pdf");
    const doc = await PDFDocument.create();
    const page = doc.addPage([300, 300]);
    page.drawRectangle({
      x: 30,
      y: 230,
      width: 80,
      height: 40,
      color: rgb(1, 0, 0),
    });
    page.setRotation(degrees(90));
    await fs.writeFile(rotatedPdfPath, await doc.save());

    const result = await client.callTool({
      name: "render_pdf_region",
      arguments: {
        pdf_path: rotatedPdfPath,
        page: 1,
        x: 230,
        y: 30,
        width: 40,
        height: 80,
        max_dimension_px: 400,
      },
    });

    expect(result.isError).not.toBe(true);
    const imageItem = result.content.find(item => item.type === "image");
    expect(imageItem?.mimeType).toBe("image/png");

    const image = await loadImage(Buffer.from(imageItem.data, "base64"));
    const canvas = createCanvas(image.width, image.height);
    const ctx = canvas.getContext("2d");
    ctx.drawImage(image, 0, 0, image.width, image.height);
    const center = ctx.getImageData(Math.floor(image.width / 2), Math.floor(image.height / 2), 1, 1).data;

    expect(center[0]).toBeGreaterThan(200);
    expect(center[1]).toBeLessThan(80);
    expect(center[2]).toBeLessThan(80);
  }, 30_000);

  it("labels and applies PDF.js view coordinates across origins, rotation, CropBox, and UserUnit", async () => {
    const fixturePath = path.join(tempDirectory, "coordinate-truth.pdf");
    await writeCoordinateTruthFixture(fixturePath);
    const wholePage = await client.callTool({
      name: "render_pdf_page",
      arguments: { pdf_path: fixturePath, page: 1, max_dimension_px: 800 },
    });
    expect(wholePage.isError).not.toBe(true);
    expect(wholePage.structuredContent).toMatchObject({
      page_geometry: {
        geometry_source: "pdf-lib",
        media_box: [50, 60, 450, 460],
        crop_box: [100, 100, 300, 200],
        rotation: 90,
        user_unit: 2,
        coordinate_space: "pdf_user_space_bottom_left_points",
      },
      page_view: {
        view_box: [100, 100, 300, 200],
        width_points: 200,
        height_points: 400,
        rotation: 90,
        user_unit: 2,
        coordinate_space: "pdfjs_viewport_top_left_points",
      },
      requested_coordinate_space: "pdfjs_viewport_top_left_points",
      requested_region: { x: 0, y: 0, width: 200, height: 400 },
    });

    const region = await client.callTool({
      name: "render_pdf_region",
      arguments: {
        pdf_path: fixturePath,
        page: 1,
        x: 0,
        y: 0,
        width: 100,
        height: 100,
        max_dimension_px: 400,
      },
    });
    expect(region.isError).not.toBe(true);
    expect(region.structuredContent.requested_region).toEqual({
      x: 0, y: 0, width: 100, height: 100,
    });
    const imageItem = region.content.find(item => item.type === "image");
    const image = await loadImage(Buffer.from(imageItem.data, "base64"));
    const canvas = createCanvas(image.width, image.height);
    const context = canvas.getContext("2d");
    context.drawImage(image, 0, 0);
    const center = context.getImageData(
      Math.floor(image.width / 2),
      Math.floor(image.height / 2),
      1,
      1,
    ).data;
    expect(center[0]).toBeGreaterThan(200);
    expect(center[1]).toBeLessThan(80);
    expect(center[2]).toBeLessThan(80);
  }, 30_000);
});

describe("Claude Desktop Electron utility rendering", () => {
  let client;
  let transport;
  let imageOnlyPdfPath;
  let electronTempDirectory;

  beforeAll(async () => {
    electronTempDirectory = await createTestTempDirectory(REPO_ROOT, "electron-render");
    const sourceCanvas = createCanvas(200, 100);
    const sourceContext = sourceCanvas.getContext("2d");
    sourceContext.fillStyle = "#ffffff";
    sourceContext.fillRect(0, 0, 200, 100);
    sourceContext.fillStyle = "#d02020";
    sourceContext.fillRect(40, 20, 120, 60);

    const imageOnlyDoc = await PDFDocument.create();
    const imageOnlyPage = imageOnlyDoc.addPage([200, 100]);
    const image = await imageOnlyDoc.embedPng(sourceCanvas.toBuffer("image/png"));
    imageOnlyPage.drawImage(image, { x: 0, y: 0, width: 200, height: 100 });
    imageOnlyPdfPath = path.join(electronTempDirectory, "image-only.pdf");
    await fs.writeFile(imageOnlyPdfPath, await imageOnlyDoc.save());

    const serverUrl = pathToFileURL(path.join(REPO_ROOT, "server", "index.js")).href;
    const bootstrap = [
      'process.type = "utility";',
      'Object.defineProperty(process.versions, "electron", { value: "test", configurable: true });',
      `await import(${JSON.stringify(serverUrl)});`,
    ].join(" ");

    client = new Client({ name: "pdf-tools-electron-utility-test-client", version: "1.0.0" });
    transport = new StdioClientTransport({
      command: process.execPath,
      args: ["--input-type=module", "--eval", bootstrap],
      cwd: REPO_ROOT,
      env: {
        ALLOWED_DIRECTORIES: REPO_ROOT,
        PDF_TOOLS_DISABLE_SYSTEM_RENDERER: "1",
      },
      stderr: "pipe",
    });
    await client.connect(transport);
  }, 30_000);

  afterAll(async () => {
    try {
      await transport?.close();
    } finally {
      await removeTestTempDirectory(electronTempDirectory);
    }
  });

  // This describe runs an embedded Electron host with the system renderer
  // disabled, which models a host that has no macOS sips fallback. Embedded
  // hosts block the native canvas binding, so rendering is unavailable there
  // by design. These assert that the failure is explicit and truthful rather
  // than a misleading dependency-reinstall suggestion.
  it("reports an explicit unavailable renderer instead of a dependency error", async () => {
    const result = await client.callTool({
      name: "render_pdf_page",
      arguments: {
        pdf_path: EXAMPLE_PDF,
        page: 1,
        max_dimension_px: 1200,
      },
    });

    expect(result.isError).toBe(true);
    const text = JSON.stringify(result.content);
    expect(text).toContain("No PDF page renderer is available in this host");
    expect(text).not.toContain("npm has a bug");
    expect(text).not.toContain("removing both package-lock.json");
  }, 30_000);

  it("reports the same explicit failure for bounded regions", async () => {
    const result = await client.callTool({
      name: "render_pdf_region",
      arguments: {
        pdf_path: EXAMPLE_PDF,
        page: 1,
        x: 72,
        y: 120,
        width: 180,
        height: 60,
        max_dimension_px: 1000,
      },
    });

    expect(result.isError).toBe(true);
    expect(JSON.stringify(result.content)).toContain("No PDF page renderer is available in this host");
  }, 30_000);

  it("does not claim a rendered image when no renderer exists", async () => {
    const result = await client.callTool({
      name: "read_pdf_content",
      arguments: {
        pdf_path: imageOnlyPdfPath,
        max_pages: 1,
      },
    });

    // Without a renderer the image fallback cannot produce a page image, so
    // the text-layer result stands on its own rather than silently claiming a
    // rendered image.
    expect(result.structuredContent?.image_renderer).not.toBe("native-canvas");
  }, 30_000);
});

// Claude Desktop on macOS is an embedded Electron host WITH the system
// renderer available. That is the shipped path, so it is pinned separately
// from the no-fallback host above.
describe.runIf(process.platform === "darwin")("Claude Desktop Electron utility rendering with a system fallback", () => {
  let client;
  let transport;
  let tempDirectory;
  let coordinateFixture;

  beforeAll(async () => {
    tempDirectory = await createTestTempDirectory(REPO_ROOT, "system-coordinate-render");
    coordinateFixture = path.join(tempDirectory, "system-coordinate-truth.pdf");
    await writeCoordinateTruthFixture(coordinateFixture);
    const serverUrl = pathToFileURL(path.join(REPO_ROOT, "server", "index.js")).href;
    const bootstrap = [
      'process.type = "utility";',
      'Object.defineProperty(process.versions, "electron", { value: "test", configurable: true });',
      `await import(${JSON.stringify(serverUrl)});`,
    ].join(" ");
    client = new Client({ name: "pdf-tools-electron-fallback-client", version: "1.0.0" });
    transport = new StdioClientTransport({
      command: process.execPath,
      args: ["--input-type=module", "--eval", bootstrap],
      cwd: REPO_ROOT,
      env: { ALLOWED_DIRECTORIES: REPO_ROOT },
      stderr: "pipe",
    });
    await client.connect(transport);
  }, 30_000);

  afterAll(async () => {
    try {
      await transport?.close();
    } finally {
      await removeTestTempDirectory(tempDirectory);
    }
  });

  it("renders through the system renderer rather than the blocked native binding", async () => {
    const result = await client.callTool({
      name: "render_pdf_page",
      arguments: { pdf_path: EXAMPLE_PDF, page: 1, max_dimension_px: 800 },
    });
    expect(result.isError).not.toBe(true);
    expect(result.structuredContent).toMatchObject({
      page: 1,
      renderer: "macos-quicklook",
      raw_pixel_sha256: null,
      raw_pixel_status: "unavailable",
    });
    expect(result.content.some(item => item.type === "image" && item.mimeType === "image/png")).toBe(true);
  }, 30_000);

  it("renders a supported system region with explicit PDF.js view coordinates", async () => {
    const result = await client.callTool({
      name: "render_pdf_region",
      arguments: {
        pdf_path: EXAMPLE_PDF,
        page: 1,
        x: 72,
        y: 120,
        width: 180,
        height: 60,
        max_dimension_px: 720,
      },
    });
    expect(result.isError).not.toBe(true);
    expect(result.structuredContent).toMatchObject({
      renderer: "macos-quicklook",
      requested_coordinate_space: "pdfjs_viewport_top_left_points",
      requested_region: { x: 72, y: 120, width: 180, height: 60 },
      raw_pixel_status: "unavailable",
      raw_pixel_sha256: null,
    });
    const imageItem = result.content.find(item => item.type === "image");
    expect(result.structuredContent.png_sha256)
      .toBe(createHash("sha256").update(Buffer.from(imageItem.data, "base64")).digest("hex"));
  }, 30_000);

  it("keeps system page and region pixels in the PDF.js view across origins, rotation, CropBox, and UserUnit", async () => {
    const sourceBefore = await fs.readFile(coordinateFixture);
    const sourceStatBefore = await fs.stat(coordinateFixture);
    const wholePage = await client.callTool({
      name: "render_pdf_page",
      arguments: { pdf_path: coordinateFixture, page: 1, max_dimension_px: 800 },
    });
    expect(wholePage.isError).not.toBe(true);
    expect(wholePage.structuredContent).toMatchObject({
      renderer: "macos-quicklook",
      page_view: {
        view_box: [100, 100, 300, 200],
        width_points: 200,
        height_points: 400,
        rotation: 90,
        user_unit: 2,
        coordinate_space: "pdfjs_viewport_top_left_points",
      },
      requested_region: { x: 0, y: 0, width: 200, height: 400 },
    });
    const wholeImageItem = wholePage.content.find(item => item.type === "image");
    const wholeImage = await loadImage(Buffer.from(wholeImageItem.data, "base64"));
    expect(wholeImage.width).toBe(400);
    expect(wholeImage.height).toBe(800);
    expect(wholePage.structuredContent.png_sha256).toBe(
      createHash("sha256").update(Buffer.from(wholeImageItem.data, "base64")).digest("hex"),
    );
    const repeatedWholePage = await client.callTool({
      name: "render_pdf_page",
      arguments: { pdf_path: coordinateFixture, page: 1, max_dimension_px: 800 },
    });
    expect(repeatedWholePage.isError).not.toBe(true);
    expect(repeatedWholePage.structuredContent.png_sha256)
      .toBe(wholePage.structuredContent.png_sha256);
    expect(await fs.readFile(coordinateFixture)).toEqual(sourceBefore);
    expect((await fs.stat(coordinateFixture)).mtimeMs).toBe(sourceStatBefore.mtimeMs);
    const region = await client.callTool({
      name: "render_pdf_region",
      arguments: {
        pdf_path: coordinateFixture,
        page: 1,
        x: 0,
        y: 0,
        width: 100,
        height: 100,
        max_dimension_px: 400,
      },
    });
    expect(region.isError).not.toBe(true);
    expect(region.structuredContent).toMatchObject({
      renderer: "macos-quicklook",
      requested_coordinate_space: "pdfjs_viewport_top_left_points",
      requested_region: { x: 0, y: 0, width: 100, height: 100 },
      rendered_width_px: 400,
      rendered_height_px: 400,
    });
    const imageItem = region.content.find(item => item.type === "image");
    const image = await loadImage(Buffer.from(imageItem.data, "base64"));
    const canvas = createCanvas(image.width, image.height);
    const context = canvas.getContext("2d");
    context.drawImage(image, 0, 0);
    const center = context.getImageData(
      Math.floor(image.width / 2),
      Math.floor(image.height / 2),
      1,
      1,
    ).data;
    expect(center[0]).toBeGreaterThan(200);
    expect(center[1]).toBeLessThan(80);
    expect(center[2]).toBeLessThan(80);
  }, 30_000);

  it.each([0, 90, 180, 270])(
    "maps the top-left PDF.js view region through the system renderer at rotation %i",
    async rotation => {
      const fixturePath = path.join(tempDirectory, `system-coordinate-${rotation}.pdf`);
      await writeCoordinateTruthFixture(fixturePath, rotation);
      const expectedView = rotation % 180 === 0
        ? { width_points: 400, height_points: 200 }
        : { width_points: 200, height_points: 400 };
      const region = await client.callTool({
        name: "render_pdf_region",
        arguments: {
          pdf_path: fixturePath,
          page: 1,
          x: 0,
          y: 0,
          width: 100,
          height: 100,
          max_dimension_px: 400,
        },
      });
      expect(region.isError).not.toBe(true);
      expect(region.structuredContent).toMatchObject({
        renderer: "macos-quicklook",
        page_view: { ...expectedView, rotation, user_unit: 2 },
      });
      const imageItem = region.content.find(item => item.type === "image");
      const image = await loadImage(Buffer.from(imageItem.data, "base64"));
      const canvas = createCanvas(image.width, image.height);
      const context = canvas.getContext("2d");
      context.drawImage(image, 0, 0);
      const center = context.getImageData(
        Math.floor(image.width / 2),
        Math.floor(image.height / 2),
        1,
        1,
      ).data;
      expect(center[0]).toBeGreaterThan(200);
      expect(center[1]).toBeLessThan(80);
      expect(center[2]).toBeLessThan(80);

      const oppositeRegion = await client.callTool({
        name: "render_pdf_region",
        arguments: {
          pdf_path: fixturePath,
          page: 1,
          x: expectedView.width_points - 100,
          y: expectedView.height_points - 100,
          width: 100,
          height: 100,
          max_dimension_px: 400,
        },
      });
      expect(oppositeRegion.isError).not.toBe(true);
      const oppositeImageItem = oppositeRegion.content.find(item => item.type === "image");
      const oppositeImage = await loadImage(Buffer.from(oppositeImageItem.data, "base64"));
      const oppositeCanvas = createCanvas(oppositeImage.width, oppositeImage.height);
      const oppositeContext = oppositeCanvas.getContext("2d");
      oppositeContext.drawImage(oppositeImage, 0, 0);
      const oppositeCenter = oppositeContext.getImageData(
        Math.floor(oppositeImage.width / 2),
        Math.floor(oppositeImage.height / 2),
        1,
        1,
      ).data;
      expect(oppositeCenter[0]).toBeLessThan(80);
      expect(oppositeCenter[1]).toBeLessThan(80);
      expect(oppositeCenter[2]).toBeGreaterThan(200);
    },
    30_000,
  );
});

// The embedded in-process canvas block is what leaves a host with no renderer
// when there is no system fallback, which is the Windows shape. This pins that
// the opt-in lifts it, so the fix is measurable and cannot regress silently.
describe("embedded host native canvas opt-in", () => {
  const runEmbedded = async env => {
    const serverUrl = pathToFileURL(path.join(REPO_ROOT, "server", "index.js")).href;
    const bootstrap = [
      'process.type = "utility";',
      'Object.defineProperty(process.versions, "electron", { value: "test", configurable: true });',
      `await import(${JSON.stringify(serverUrl)});`,
    ].join(" ");
    const transport = new StdioClientTransport({
      command: process.execPath,
      args: ["--input-type=module", "--eval", bootstrap],
      cwd: REPO_ROOT,
      env: { ALLOWED_DIRECTORIES: REPO_ROOT, PDF_TOOLS_DISABLE_SYSTEM_RENDERER: "1", ...env },
      stderr: "pipe",
    });
    const embeddedClient = new Client({ name: "pdf-tools-canvas-optin", version: "1.0.0" });
    await embeddedClient.connect(transport);
    try {
      return await embeddedClient.callTool({
        name: "render_pdf_page",
        arguments: { pdf_path: EXAMPLE_PDF, page: 1, max_dimension_px: 800 },
      });
    } finally {
      await transport.close();
    }
  };

  it("cannot render with no system fallback while the block is in force", async () => {
    const result = await runEmbedded({});
    expect(result.isError).toBe(true);
    expect(JSON.stringify(result.content)).toContain("No PDF page renderer is available in this host");
  }, 30_000);

  it("renders natively when the opt-in lifts the block", async () => {
    const result = await runEmbedded({ PDF_TOOLS_EMBEDDED_NATIVE_CANVAS: "1" });
    expect(result.isError).not.toBe(true);
    expect(result.structuredContent).toMatchObject({ page: 1, renderer: "native-canvas" });
  }, 30_000);
});
