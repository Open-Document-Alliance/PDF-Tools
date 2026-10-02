import fs from "fs/promises";
import path from "path";
import { fileURLToPath } from "url";
import { describe, expect, it } from "vitest";
import { TOOL_OUTPUT_SCHEMAS } from "../server/output-schemas.js";
import { SKILL_FILES, SKILLS_EXTENSION } from "../server/skill-files.js";
import {
  DISPLAY_NAME_CANDIDATES,
  computeToolIdentifierBudget,
} from "../scripts/tool-identifier-budget.mjs";

const REPO_ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const CURRENT_PRODUCT_SURFACES = [
  "README.md",
  "CLAUDE.md",
  "AGENTS.md",
  "docs/MAINTAINERS.md",
  "docs/SUPPORT.md",
  // The normative MCP contract went a full cycle asserting a prompt-argument
  // isolation boundary that had been deleted, because this list did not
  // include it.
  "docs/MCP_CONTRACT.md",
  "docs/releases/v0.9.5.md",
  "pdf-toolkit-mcp-share/README.md",
  "manifest.json",
  "manifest.mcpb.json",
  "server/index.js",
  "pdf-toolkit-mcp-share/server/index.js",
];
const POSITIVE_OCR_PATTERNS = [
  /\bOCR\s*(?:\/\s*image\s*)?(?:support|fallback|extraction|engine|capabilit(?:y|ies)|pipeline)\b/i,
  /\b(?:automatic|built[- ]in|bundled|integrated|native|local)\s+OCR\b/i,
  /\b(?:includes?|runs?|performs?|provides?|supports?|uses?|ships?|offers?|handles?)\b[^.!?;\n]{0,60}\bOCR\b/i,
  /\bwith\s+(?:(?:automatic|built[- ]in|integrated|local)\s+)?OCR\b/i,
  /\bOCR\s+is\s+(?:not\s+)?(?:supported|included|available|enabled|bundled|built[ -]in)\b/i,
  /\b(?:has|have|features?|contains?)\b[^.!?;\n]{0,40}\bOCR\b/i,
  /\bOCR[ -]enabled\b/i,
  /\bOCR\b[^.!?;\n]{0,40}\bbuilt[ -]in\b/i,
];
const EXPLICIT_OCR_BOUNDARIES = [
  /\b(?:does not|do not|doesn't|don't|cannot|can't|never)\s+(?:currently\s+)?(?:bundle|include|run|perform|provide|support|use|ship|offer|have)\b[^.!?;\n]{0,80}\bOCR\b/i,
  /\bdoes not\s+render\s+pages,\s+run\s+OCR(?:\s*,|\s+or\b)/i,
  /\bno\s+(?:(?:built[- ]in|bundled|integrated|local|automatic)\s+)?OCR\s+(?:support|fallback|extraction|engine|capabilit(?:y|ies)|pipeline)\b/i,
  /\bwithout\s+(?:(?:built[- ]in|bundled|integrated|local|automatic)\s+)?OCR\b/i,
  /\b(?:future|planned|proposed|candidate|experimental|optional)\s+(?:(?:local|bundled|integrated)\s+)?OCR\b/i,
  /\bOCR\b[^.!?;\n]{0,100}\b(?:unavailable|unsupported|unshipped|planned|proposed|future|candidate|evaluation|benchmark)\b/i,
  /\bOCR\b[^.!?;\n]{0,100}\bnot\s+(?:shipped|included|available|supported|bundled|implemented|enabled)\b/i,
  /\bOCR\s+is\s+not\s+(?:supported|included|available|enabled|bundled|built[ -]in)\b/i,
  /\b(?:has|have|features?|contains?)\s+no\s+OCR\b/i,
  /\bOCR\b[^.!?;\n]{0,40}\bdoes not come built[ -]in\b/i,
  /\bnot\s+OCR[ -]enabled\b/i,
];
const POSITIVE_SCANNED_TEXT_PATTERNS = [
  /\b(?:recognizes?|extracts?|reads?|transcribes?)\s+(?:all\s+)?scanned\s+text\b/i,
  /\b(?:recognizes?|extracts?|reads?|transcribes?)\s+(?:all\s+)?text\s+(?:from|in)\s+scanned\s+(?:PDFs?|documents?|pages?)\b/i,
  /\bscanned\s+(?:PDFs?|text|documents?|pages?)\s+(?:is|are)\s+(?:not\s+)?(?:automatically\s+)?(?:recognized|extracted|read|transcribed)\b/i,
  /\btext\s+(?:in|from)\s+scanned\s+(?:PDFs?|documents?|pages?)\s+(?:is|are)\s+(?:not\s+)?(?:automatically\s+)?(?:recognized|extracted|read|transcribed)\b/i,
];
const EXPLICIT_SCANNED_TEXT_BOUNDARIES = [
  /\b(?:does not|do not|doesn't|don't|cannot|can't|never)\s+(?:currently\s+)?(?:recognize|extract|read|transcribe)\b[^.!?;\n]{0,80}\bscanned\s+(?:text|PDFs?|documents?|pages?)\b/i,
  /\bscanned\s+(?:text|PDFs?|documents?|pages?)\b[^.!?;\n]{0,80}\b(?:not recognized|not extracted|unrecognized|unsupported|planned|future)\b/i,
  /\btext\s+(?:in|from)\s+scanned\s+(?:PDFs?|documents?|pages?)\s+(?:is|are)\s+not\s+(?:recognized|extracted|read|transcribed)\b/i,
];
const POSITIVE_PDF_PARSE_PATTERNS = [
  /\b(?:uses?|includes?|requires?|bundles?)\b[^.!?;\n]{0,50}\bpdf-parse\b/i,
  /\bdepends?\s+on\b[^.!?;\n]{0,50}\bpdf-parse\b/i,
  /\bships?\s+with\b[^.!?;\n]{0,50}\bpdf-parse\b/i,
  /\bpdf-parse\s+is\s+(?:not\s+)?(?:used|included|required|bundled|installed)\b/i,
];
const EXPLICIT_PDF_PARSE_BOUNDARIES = [
  /\b(?:does not|do not|doesn't|don't|never)\s+(?:currently\s+)?(?:use|include|require|bundle)\b[^.!?;\n]{0,50}\bpdf-parse\b/i,
  /\b(?:does not|do not|doesn't|don't|never)\s+(?:currently\s+)?depend\s+on\b[^.!?;\n]{0,50}\bpdf-parse\b/i,
  /\b(?:does not|do not|doesn't|don't|never)\s+(?:currently\s+)?ship\s+with\b[^.!?;\n]{0,50}\bpdf-parse\b/i,
  /\bpdf-parse\s+is\s+not\s+(?:used|included|required|bundled|installed)\b/i,
];

async function readRepositoryFile(relativePath) {
  return fs.readFile(path.join(REPO_ROOT, relativePath), "utf8");
}

function findMatches(contents, pattern) {
  return contents
    .split("\n")
    .flatMap((line, index) => pattern.test(line) ? [`${index + 1}: ${line.trim()}`] : []);
}

function collectJsonStrings(value, strings = []) {
  if (typeof value === "string") {
    strings.push(value);
  } else if (Array.isArray(value)) {
    value.forEach(item => collectJsonStrings(item, strings));
  } else if (value && typeof value === "object") {
    Object.values(value).forEach(item => collectJsonStrings(item, strings));
  }
  return strings;
}

function splitClaimUnits(text, { sourceCode = false } = {}) {
  if (sourceCode) {
    return text.split("\n").map(line => line.trim()).filter(Boolean);
  }

  return text
    .replaceAll("\r\n", "\n")
    .split(/\n\s*\n/)
    .flatMap(paragraph => {
      const lines = paragraph.split("\n").map(line => line.trim()).filter(Boolean);
      const hasListItems = lines.some(line => /^(?:[-*•]|\d+[.)])\s+/.test(line));
      const units = hasListItems ? lines : [lines.join(" ")];
      return units.flatMap(unit => unit.split(/(?<=[.!?;])\s+/));
    })
    .map(unit => unit.trim())
    .filter(Boolean);
}

function claimUnits(relativePath, contents) {
  if (relativePath.endsWith(".json")) {
    return collectJsonStrings(JSON.parse(contents)).flatMap(value => splitClaimUnits(value));
  }
  return splitClaimUnits(contents, { sourceCode: relativePath.endsWith(".js") });
}

function findOcrClaimViolations(units) {
  return units.filter(unit => {
    const positiveOcr = POSITIVE_OCR_PATTERNS.some(pattern => pattern.test(unit));
    const boundedOcr = EXPLICIT_OCR_BOUNDARIES.some(pattern => pattern.test(unit));
    const positiveScannedText = POSITIVE_SCANNED_TEXT_PATTERNS.some(pattern => pattern.test(unit));
    const boundedScannedText = EXPLICIT_SCANNED_TEXT_BOUNDARIES.some(pattern => pattern.test(unit));
    return (positiveOcr && !boundedOcr) || (positiveScannedText && !boundedScannedText);
  });
}

function findPdfParseClaimViolations(units) {
  return units.filter(unit =>
    POSITIVE_PDF_PARSE_PATTERNS.some(pattern => pattern.test(unit)) &&
    !EXPLICIT_PDF_PARSE_BOUNDARIES.some(pattern => pattern.test(unit))
  );
}

describe("documentation capability claims", () => {
  it("distinguishes standalone workflow instructions from server-bearing packages", async () => {
    for (const relativePath of [
      "docs/AGENT_HOST_WORKFLOWS.md",
      "docs/agent-plugins-packaging.md",
    ]) {
      const contents = (await readRepositoryFile(relativePath)).replace(/\s+/g, " ");
      expect(contents, relativePath).toContain(SKILLS_EXTENSION);
      expect(contents, relativePath).toContain("server/skill-files.js");
      expect(contents, relativePath).toContain("SKILL_FILES");
      expect(contents, relativePath).toContain("MCPB and share ZIP");
      expect(contents, relativePath).toContain("standalone workflow-only");
      expect(contents, relativePath).toContain("server-bearing Agent Plugin");
      expect(contents, relativePath).not.toContain("server ships separately from the skill in every one");
      expect(contents, relativePath).not.toContain("workflow plugin is separate from the MCP server and extension package");
    }
  });

  it("binds the documented bundled skill to authored, mirrored, and staged files", async () => {
    for (const relativePath of SKILL_FILES) {
      expect(await readRepositoryFile(`pdf-toolkit-mcp-share/${relativePath}`)).toBe(
        await readRepositoryFile(relativePath),
      );
    }
    const mcpb = await readRepositoryFile("scripts/build-mcpb.mjs");
    expect(mcpb).toContain('import { SKILL_FILES } from "../server/skill-files.js"');
    expect(mcpb).toContain("for (const filename of SKILL_FILES) copyRegularFile");
    const share = await readRepositoryFile("package-for-friend.js");
    expect(share).toContain('import { SKILL_FILES } from "./server/skill-files.js"');
    expect(share).toContain("...SKILL_FILES");
    const server = await readRepositoryFile("server/index.js");
    expect(server).toContain("[SKILLS_EXTENSION]");
    expect(server).toContain('setRequestHandler("skills/list"');
    expect(server).toContain('setRequestHandler("skills/get"');
  });

  it("does not advertise absent PDF or OCR dependencies on current product surfaces", async () => {
    const violations = [];

    for (const relativePath of CURRENT_PRODUCT_SURFACES) {
      const contents = await readRepositoryFile(relativePath);
      const units = claimUnits(relativePath, contents);
      for (const unit of findPdfParseClaimViolations(units)) {
        violations.push(`${relativePath}: ${unit}`);
      }
      for (const unit of findOcrClaimViolations(units)) {
        violations.push(`${relativePath}: ${unit}`);
      }
      if (relativePath.endsWith("server/index.js")) {
        expect(contents, relativePath).toContain("No text was found in the PDF.js text layer.");
        expect(contents, relativePath).toContain(
          "Rendering page 1 as an image for host/model visual inspection...",
        );
        expect(contents, relativePath).not.toMatch(/OCR fallback/i);
      }
    }

    expect(CURRENT_PRODUCT_SURFACES).toContain("docs/releases/v0.9.5.md");
    expect(CURRENT_PRODUCT_SURFACES.some(relativePath => /evaluation/i.test(relativePath))).toBe(false);

    for (const relativePath of ["package.json", "pdf-toolkit-mcp-share/package.json"]) {
      const packageJson = JSON.parse(await readRepositoryFile(relativePath));
      const dependencyNames = Object.keys({
        ...packageJson.dependencies,
        ...packageJson.devDependencies,
      });
      expect(dependencyNames, relativePath).not.toContain("pdf-parse");
      expect(
        dependencyNames.some(name => /(?:^|[-_/])ocr(?:$|[-_/])/i.test(name)),
        `${relativePath} must not silently add an OCR package while docs describe OCR as unshipped`,
      ).toBe(false);
    }

    expect(violations).toEqual([]);
  });

  it.each([
    "PDF Tools does not include OCR support.",
    "A future OCR fallback is planned but not shipped.",
    "OCR support is unavailable in the current runtime.",
    "Optional local OCR remains a candidate for evaluation.",
    "The current package has no built-in OCR engine.",
    "OCR is not supported by the current runtime.",
    "The package has no OCR.",
    "OCR does not come built in.",
    "The runtime is not OCR-enabled.",
    "This tool does not render pages, run OCR, infer tables, or fill an arbitrary schema.",
    "PDF Tools renders scanned PDF pages for host/model visual inspection.",
    "The runtime does not recognize scanned text; it returns raster images for visual inspection.",
    "Scanned PDFs are not recognized as text.",
    "Text in scanned PDFs is not extracted by the runtime.",
  ])("allows explicitly qualified OCR boundary: %s", phrase => {
    expect(findOcrClaimViolations(splitClaimUnits(phrase))).toEqual([]);
  });

  it.each([
    "OCR fallback handles scanned PDFs.",
    "Built-in OCR reads scans.",
    "PDF Tools includes OCR for invoices.",
    "The runtime runs OCR locally.",
    "PDF Tools performs OCR automatically.",
    "Scans work with OCR.",
    "Automatic OCR is available.",
    "No text layer is required, and PDF Tools includes OCR.",
    "The runtime has no upload step but performs OCR.",
    "OCR support is included. Future improvements are planned.",
    "PDF Tools includes OCR, although no separate service is used.",
    "No OCR errors occur because built-in OCR reads scans.",
    "PDF Tools does not fail when it includes OCR.",
    "Future UI polish includes OCR support today.",
    "PDF Tools recognizes scanned text.",
    "PDF Tools extracts text from scanned PDFs.",
    "PDF Tools reads scanned text automatically.",
    "OCR is supported.",
    "OCR is included.",
    "OCR is available.",
    "OCR is enabled.",
    "OCR is bundled.",
    "OCR is built in.",
    "PDF Tools has OCR.",
    "PDF Tools features OCR.",
    "PDF Tools contains OCR.",
    "This is an OCR-enabled runtime.",
    "This tool does not render pages, but it runs OCR.",
    "This tool does not render pages and does run OCR.",
    "Scanned PDFs are recognized as text.",
    "Scanned text is extracted automatically.",
    "Scanned documents are read by the runtime.",
    "Scanned pages are transcribed.",
    "Text in scanned PDFs is recognized.",
    "Text from scanned PDFs is extracted automatically.",
  ])("rejects positive or qualification-bypass OCR claim: %s", phrase => {
    expect(findOcrClaimViolations(splitClaimUnits(phrase))).not.toEqual([]);
  });

  it.each([
    "PDF Tools does not use pdf-parse.",
    "The current runtime does not depend on pdf-parse.",
    "The package does not include pdf-parse.",
    "pdf-parse is not installed.",
  ])("allows explicitly negative pdf-parse boundary: %s", phrase => {
    expect(findPdfParseClaimViolations(splitClaimUnits(phrase))).toEqual([]);
  });

  it.each([
    "PDF Tools uses pdf-parse.",
    "The package includes pdf-parse.",
    "The runtime depends on pdf-parse.",
    "PDF Tools ships with pdf-parse.",
    "pdf-parse is installed.",
    "PDF Tools does not upload files but uses pdf-parse.",
  ])("rejects positive pdf-parse dependency claim: %s", phrase => {
    expect(findPdfParseClaimViolations(splitClaimUnits(phrase))).not.toEqual([]);
  });

  it("allows historical and evaluation files to describe former or candidate dependencies", () => {
    const historicalText =
      "Version 0.2 used pdf-parse. A candidate OCR engine was evaluated and removed.";

    expect(CURRENT_PRODUCT_SURFACES).not.toContain("docs/releases/v0.2.0.md");
    expect(CURRENT_PRODUCT_SURFACES).not.toContain("docs/EXTRACTION_EVALUATION.md");
    expect(historicalText).toContain("pdf-parse");
    expect(findOcrClaimViolations(splitClaimUnits(historicalText))).toEqual([]);
  });

  it("keeps extraction limitations explicit on current product surfaces", async () => {
    const readme = await readRepositoryFile("README.md");
    const developmentGuide = await readRepositoryFile("CLAUDE.md");
    const maintainerGuide = await readRepositoryFile("docs/MAINTAINERS.md");
    const shareReadme = await readRepositoryFile("pdf-toolkit-mcp-share/README.md");
    const sourceManifest = JSON.parse(await readRepositoryFile("manifest.json"));
    const packedManifest = JSON.parse(await readRepositoryFile("manifest.mcpb.json"));

    for (const [name, contents] of [
      ["README.md", readme],
      ["CLAUDE.md", developmentGuide],
      ["docs/MAINTAINERS.md", maintainerGuide],
      ["pdf-toolkit-mcp-share/README.md", shareReadme],
    ]) {
      expect(contents, name).toMatch(/does not (?:currently )?bundle an OCR engine/i);
      expect(contents, name).toMatch(/selected\s+(?:`read_pdf_content`\s+)?(?:result|extraction)[\s\S]{0,180}no text[\s\S]{0,180}page 1/i);
      expect(contents, name).toMatch(/(?:raster images?|rasterization)[\s\S]{0,120}(?:not|do not|rather than)[\s\S]{0,80}(?:recognized text|produce recognized text)/i);
      expect(contents, name).toMatch(/mixed\s+text\/raster[\s\S]{0,180}(?:pages? after page 1|later raster pages?)/i);
    }

    expect(sourceManifest.long_description).toMatch(/does not currently bundle OCR/i);
    expect(sourceManifest.long_description).toMatch(/selected `read_pdf_content` extraction has no text[\s\S]{0,100}page 1/i);
    expect(sourceManifest.long_description).toMatch(/raster images, not OCR text/i);
    expect(sourceManifest.long_description).toMatch(/mixed text\/raster documents and raster pages after page 1/i);
    expect(packedManifest.long_description).toBe(sourceManifest.long_description);
  });

  it("does not promise zero egress for host or model content", async () => {
    const zeroEgressPatterns = [
      /nothing is uploaded/i,
      /all processing happens locally/i,
      /analy(?:ze|sis) document content locally/i,
      /(?:files|PDFs).{0,80}stay on (?:your|the user's) machine/i,
      /without (?:sending|uploading)(?: files| PDFs?)?(?: to a web app)?/i,
    ];
    const violations = [];

    for (const relativePath of CURRENT_PRODUCT_SURFACES) {
      const contents = await readRepositoryFile(relativePath);
      for (const pattern of zeroEgressPatterns) {
        for (const match of findMatches(contents, pattern)) {
          violations.push(`${relativePath}:${match}`);
        }
      }
    }

    const readme = await readRepositoryFile("README.md");
    const shareReadme = await readRepositoryFile("pdf-toolkit-mcp-share/README.md");
    const sourceManifest = JSON.parse(await readRepositoryFile("manifest.json"));
    expect(readme).toMatch(/complete workflow is not necessarily zero egress/i);
    expect(shareReadme).toMatch(/complete workflow is not necessarily[\s\n]+zero egress/i);
    expect(sourceManifest.long_description).toMatch(/returned through MCP may be processed under the selected host or model provider's data terms/i);
    expect(violations).toEqual([]);
  });

  it("keeps host import authority distinct from PDF Tools direct folder scope", async () => {
    const readme = await readRepositoryFile("README.md");
    const packaging = await readRepositoryFile("docs/agent-plugins-packaging.md");
    const threatModel = await readRepositoryFile("docs/FOLDER_SCOPE_THREAT_MODEL.md");
    const pluginBuilder = await readRepositoryFile("scripts/build-agent-plugin.mjs");
    const joined = [readme, packaging, threatModel, pluginBuilder].join("\n");

    expect(readme).toMatch(/private PDF Tools workspace/i);
    expect(packaging).toMatch(/direct-call boundary, not a source-confidentiality boundary/i);
    expect(threatModel).toMatch(/Full Access host may read an outside file and copy it into the[\s\S]{0,20}workspace/i);
    expect(pluginBuilder).toMatch(/host's permissions govern which files it may import/i);
    expect(joined).not.toMatch(/extension only opens folders you have listed/i);
    expect(joined).not.toMatch(/fresh install allows no directories/i);
  });
});

/*
 * Tool-count claims in the normative docs.
 *
 * These numbers had drifted twice before this suite existed. `MCP_CONTRACT.md`
 * advertised 42 runtime tools and 41 packed tools against a live 43/42, and
 * `MAINTAINERS.md` and `scripts/tool-identifier-budget.mjs` disagreed with each
 * other about the identifier-budget figures (41/14 versus 40/13, live 42/15).
 * Nothing could have caught any of it: the docs stated the counts as prose and
 * no test read them, so adding a tool left every gate green while the published
 * contract became false.
 *
 * The binding below derives every figure from the artifact that owns it - the
 * two manifests, `TOOL_OUTPUT_SCHEMAS`, and the budget module - and asserts the
 * doc sentence built from it. Adding or removing a tool now fails these tests
 * with the exact sentence to update.
 *
 * The sweep that follows is the part that generalizes. Asserting the sentences
 * we happen to know about only pins those sentences; a newly written count
 * elsewhere in the same doc would drift silently, which is precisely how the
 * two instances above arrived. So every numeric tool- or prompt-count phrase in
 * those docs must use a live count unless its context explicitly marks it as
 * frozen v1/v2 evidence.
 */
const COUNT_CLAIM_SURFACES = [
  "docs/MCP_CONTRACT.md",
  "docs/MAINTAINERS.md",
  // Added after `docs/OUTPUT_SCHEMAS.md` was found claiming "this complete 38/4
  // matrix" over a 37-row table against a live 39/4. Scoping the original sweep
  // to the two files that had already drifted left the next one unguarded.
  "docs/OUTPUT_SCHEMAS.md",
  "pdf-toolkit-mcp-share/README.md",
];

/**
 * Qualifiers that may sit between a number and the counted noun. Deliberately a
 * whitelist rather than a wildcard: `A 30-character tool name` is a length, not
 * a count, and a wildcard reads it as one.
 */
const COUNT_QUALIFIERS =
  "(?:uniquely named|unique|packed|normal|model-workflow|structured|current|live|runtime|manifest)";
const TOOL_COUNT_PHRASE = new RegExp(
  `\\b(\\d{2,3})(?:-|\\s+)(?:${COUNT_QUALIFIERS}(?:-|\\s+))*tools?\\b`,
  "gi",
);
const PROMPT_COUNT_PHRASE = new RegExp(
  `\\b(\\d{1,3})(?:-|\\s+)(?:${COUNT_QUALIFIERS}(?:-|\\s+))*prompts?\\b`,
  "gi",
);

/**
 * A count is allowed to be stale only where the surrounding sentence says it
 * describes a frozen evidence generation rather than the shipped surface.
 */
const FROZEN_EVIDENCE_MARKERS = /\b(?:frozen|historical|tool-contracts\.v[12]|v1|v2)\b/i;

const NUMBER_WORDS = [
  "zero", "one", "two", "three", "four", "five", "six", "seven", "eight", "nine",
  "ten", "eleven", "twelve", "thirteen", "fourteen", "fifteen", "sixteen",
  "seventeen", "eighteen", "nineteen",
];
const TENS_WORDS = [
  "", "", "twenty", "thirty", "forty", "fifty", "sixty", "seventy", "eighty", "ninety",
];

function spellNumber(value) {
  if (value < 20) {
    return NUMBER_WORDS[value];
  }
  const tens = TENS_WORDS[Math.floor(value / 10)];
  const ones = value % 10;
  return ones === 0 ? tens : `${tens}-${NUMBER_WORDS[ones]}`;
}

/** Collapses the docs' hard wrapping so a claim can be matched as one sentence. */
function normalizeWhitespace(text) {
  return text.replaceAll("\r\n", "\n").replace(/\s+/g, " ").trim();
}

function findStaleCountPhrases(normalized, pattern, liveCounts) {
  const violations = [];
  for (const match of normalized.matchAll(pattern)) {
    const value = Number(match[1]);
    if (liveCounts.includes(value)) {
      continue;
    }
    const context = normalized.slice(
      Math.max(0, match.index - 120),
      match.index + match[0].length + 120,
    );
    if (FROZEN_EVIDENCE_MARKERS.test(context)) {
      continue;
    }
    violations.push(`${match[0]} (context: ...${context}...)`);
  }
  return violations;
}

describe("documentation tool-count claims", () => {
  it("states the live tool, prompt, and identifier-budget counts", async () => {
    const sourceManifest = JSON.parse(await readRepositoryFile("manifest.json"));
    const packedManifest = JSON.parse(await readRepositoryFile("manifest.mcpb.json"));
    const sourceToolCount = sourceManifest.tools.length;
    const packedToolCount = packedManifest.tools.length;
    const promptCount = sourceManifest.prompts.length;
    const structuredToolCount = sourceManifest.tools.filter(tool => Object.hasOwn(TOOL_OUTPUT_SCHEMAS, tool.name)).length;

    const contract = normalizeWhitespace(await readRepositoryFile("docs/MCP_CONTRACT.md"));
    expect(contract).toContain(`The runtime returns ${sourceToolCount} uniquely named tools.`);
    expect(contract).toContain(`The source manifest lists all ${sourceToolCount} tools.`);
    expect(contract).toContain(
      `The packed MCPB manifest lists the ${packedToolCount} normal model-workflow tools`,
    );
    expect(contract).toContain(`behavioral trajectory coverage of all ${sourceToolCount} tools.`);
    expect(contract).toContain(`Identical ${promptCount}-prompt arrays in both manifests`);
    expect(contract.toLowerCase()).toContain(
      `${spellNumber(structuredToolCount)} tool handlers advertise strict \`outputschema\` contracts`,
    );
    const optionalStructuredNames = Object.keys(TOOL_OUTPUT_SCHEMAS)
      .filter(name => !sourceManifest.tools.some(tool => tool.name === name));
    expect(optionalStructuredNames).toEqual(["propose_pdf_ocr"]);
    expect(contract).toContain(
      `bringing an opted-in runtime to ${sourceToolCount + optionalStructuredNames.length} tools with ${Object.keys(TOOL_OUTPUT_SCHEMAS).length} output schemas`,
    );
    expect(contract).toContain("It is absent from default discovery and both manifests.");

    const packedToolNames = packedManifest.tools.map(tool => tool.name);
    const shipped = computeToolIdentifierBudget(DISPLAY_NAME_CANDIDATES.shipped, packedToolNames);
    const fallback = computeToolIdentifierBudget(DISPLAY_NAME_CANDIDATES.fallback, packedToolNames);
    const rejected = computeToolIdentifierBudget(DISPLAY_NAME_CANDIDATES.rejected, packedToolNames);

    const maintainers = normalizeWhitespace(await readRepositoryFile("docs/MAINTAINERS.md"));
    expect(maintainers).toContain(
      `pushes ${rejected.overLimit.length} of the current ${packedToolCount} packed tool identifiers past the ceiling.`,
    );
    expect(maintainers).toContain(
      `(\`${shipped.longestToolName}\`, ${shipped.longestToolName.length} characters)`,
    );
    expect(maintainers).toContain(
      `- \`${DISPLAY_NAME_CANDIDATES.shipped}\`: longest identifier ${shipped.longestIdentifierLength}, headroom ${shipped.headroom}`,
    );
    expect(maintainers).toContain(
      `- \`${DISPLAY_NAME_CANDIDATES.fallback}\`: longest identifier ${fallback.longestIdentifierLength}, headroom ${fallback.headroom}`,
    );
    expect(maintainers).toContain(
      `- Original long title: longest identifier ${rejected.longestIdentifierLength}, ${rejected.overLimit.length} identifiers over the limit`,
    );
  });

  it("carries no stale tool or prompt count anywhere in the normative docs", async () => {
    const sourceManifest = JSON.parse(await readRepositoryFile("manifest.json"));
    const packedManifest = JSON.parse(await readRepositoryFile("manifest.mcpb.json"));
    const liveToolCounts = [
      sourceManifest.tools.length,
      packedManifest.tools.length,
      Object.keys(TOOL_OUTPUT_SCHEMAS).length,
      sourceManifest.tools.filter(tool => Object.hasOwn(TOOL_OUTPUT_SCHEMAS, tool.name)).length,
      sourceManifest.tools.length + Object.keys(TOOL_OUTPUT_SCHEMAS)
        .filter(name => !sourceManifest.tools.some(tool => tool.name === name)).length,
      computeToolIdentifierBudget(
        DISPLAY_NAME_CANDIDATES.rejected,
        packedManifest.tools.map(tool => tool.name),
      ).overLimit.length,
    ];
    const livePromptCounts = [sourceManifest.prompts.length, packedManifest.prompts.length];

    const violations = [];
    for (const relativePath of [...COUNT_CLAIM_SURFACES, "scripts/tool-identifier-budget.mjs"]) {
      const normalized = normalizeWhitespace(await readRepositoryFile(relativePath));
      for (const phrase of findStaleCountPhrases(normalized, TOOL_COUNT_PHRASE, liveToolCounts)) {
        violations.push(`${relativePath}: ${phrase}`);
      }
      for (const phrase of findStaleCountPhrases(normalized, PROMPT_COUNT_PHRASE, livePromptCounts)) {
        violations.push(`${relativePath}: ${phrase}`);
      }
    }
    expect(violations).toEqual([]);
  });

  it("never presents a frozen evaluation count as the live runtime surface", async () => {
    // `docs/EVALUATION.md` is deliberately absent from CURRENT_PRODUCT_SURFACES
    // because it exists to describe superseded evidence generations, and its v1
    // and v2 counts must stay at 39 and 40 forever. What it may not do is call
    // one of them the runtime, which is what "the complete 40-tool runtime
    // contract" did while the runtime carried 43.
    const liveRuntimeClaims = [
      /\b(?:current|live|latest)\s+(?:\w+[\s-]+){0,3}\d{2,3}-tool\b/i,
      /\b\d{2,3}-tool\s+(?:runtime|live|current)\b/i,
    ];
    const violations = [];
    for (const relativePath of ["docs/EVALUATION.md", ...COUNT_CLAIM_SURFACES]) {
      const normalized = normalizeWhitespace(await readRepositoryFile(relativePath));
      for (const pattern of liveRuntimeClaims) {
        const match = normalized.match(pattern);
        if (match) {
          violations.push(`${relativePath}: ${match[0]}`);
        }
      }
    }
    expect(violations).toEqual([]);
  });

  it.each([
    ["A 30-character tool name drops the fallback to 2 characters.", []],
    ["The runtime returns 43 uniquely named tools.", []],
    ["The packed MCPB manifest lists the 42 normal model-workflow tools.", []],
    ["The v2 jobs remain bound to the reviewed v2 40-tool projection.", []],
    ["The v1 trust stack remains unchanged for the frozen 39-tool evidence.", []],
    ["The runtime returns 41 uniquely named tools.", ["41 uniquely named tools"]],
    ["The source manifest lists all 44 tools.", ["44 tools"]],
    ["A reviewed 40-tool projection is the shipped surface.", ["40-tool"]],
  ])("classifies %s", (sentence, expected) => {
    const found = findStaleCountPhrases(
      normalizeWhitespace(sentence),
      TOOL_COUNT_PHRASE,
      [42, 43, 39, 15],
    ).map(entry => entry.split(" (context:")[0]);
    expect(found).toEqual(expected);
  });
});

/*
 * Tool-name inventories.
 *
 * The count binding above stops a documented *number* from drifting. It says
 * nothing about the lists themselves, and the lists had drifted further than
 * the numbers had. `docs/OUTPUT_SCHEMAS.md` presents a "Discovery matrix" and
 * calls it complete; it omitted `get_allowed_directories` and `split_pdf`, so
 * the normative statement of the wire contract told a host integrator that two
 * shipped tools return no `structuredContent` when both advertise a schema.
 * `README.md` omitted two tools and listed a third twice, and `AGENTS.md` said
 * "Tools currently shipped" over twenty-one of forty-three.
 *
 * `docs/MAINTAINERS.md` did carry an instruction to keep the lists in sync, and
 * it was unfollowable: it named two of the five inventories, and three of the
 * five are deliberately partial, so "in sync" was not a property any of them
 * could have had.
 *
 * The rule below replaces it. A partial inventory is legitimate but must say it
 * is partial, and may never name a tool that does not exist. Everything else is
 * read as a claim about the whole surface and must be exactly the registered
 * set. The selection marker is load-bearing in both directions: deleting the
 * sentence that declares a list partial promotes it into a completeness claim
 * and the same test then requires it to be complete, so a selection cannot be
 * quietly upgraded into a false one.
 */
const TOOL_INVENTORIES = [
  {
    label: "README.md `## Core Tools`",
    file: "README.md",
    start: "## Core Tools",
    end: "## Build From Source",
    // Bullets only. `### Viewer and Reading` and the trailing prose on the
    // `convert_pdf_to_markdown` line must not be read as entries.
    entry: /^-\s+`([a-z_][a-z0-9_]*)`/gm,
    completenessStatement: /this list is complete/i,
  },
  {
    label: "AGENTS.md `### Tools currently shipped`",
    file: "AGENTS.md",
    start: "### Tools currently shipped",
    end: "## Build, Test, and Development Commands",
    // The paragraphs after the list discuss individual tools in backticks;
    // anchoring to the bullet keeps those out of the inventory.
    entry: /^-\s+(?:`([a-z_][a-z0-9_]*)`(?:\s*\(app-only\))?(?:,\s*)?)+/gm,
    entryWithin: /`([a-z_][a-z0-9_]*)`/g,
    completenessStatement: /not a selection/i,
  },
  {
    label: "docs/OUTPUT_SCHEMAS.md discovery matrix",
    file: "docs/OUTPUT_SCHEMAS.md",
    start: "## Discovery matrix",
    end: "The executable source of truth",
    entry: /^\|\s+`([a-z_][a-z0-9_]*)`\s+\|/gm,
    // The matrix enumerates the tools that advertise a schema, not every tool.
    registeredKey: "structured",
    completenessStatement: /this complete matrix of/i,
  },
  {
    label: "CLAUDE.md `## Core Available Tools`",
    file: "CLAUDE.md",
    start: "## Core Available Tools",
    end: "### Current Extraction Boundary",
    entry: /^\d+\.\s+\*\*([a-z_][a-z0-9_]*)\*\*/gm,
    selectionMarker: /\(selected;/i,
  },
  {
    label: "pdf-toolkit-mcp-share/README.md `## Tools Available`",
    file: "pdf-toolkit-mcp-share/README.md",
    start: "## Tools Available",
    end: "### Current Extraction Boundary",
    entry: /^-\s+(?:\*\*([a-z_][a-z0-9_]*)\*\*(?:\s*\/\s*)?)+/gm,
    entryWithin: /\*\*([a-z_][a-z0-9_]*)\*\*/g,
    selectionMarker: /names a selection, not the whole surface/i,
  },
];

function inventorySection({ file, start, end }, contents) {
  const startIndex = contents.indexOf(start);
  if (startIndex === -1) {
    throw new Error(`${file}: inventory heading ${JSON.stringify(start)} is gone`);
  }
  const endIndex = contents.indexOf(end, startIndex + start.length);
  if (endIndex === -1) {
    throw new Error(`${file}: inventory terminator ${JSON.stringify(end)} is gone`);
  }
  return contents.slice(startIndex + start.length, endIndex);
}

function inventoryEntries(inventory, section) {
  const names = [];
  for (const match of section.matchAll(inventory.entry)) {
    if (inventory.entryWithin) {
      for (const inner of match[0].matchAll(inventory.entryWithin)) {
        names.push(inner[1]);
      }
    } else {
      names.push(match[1]);
    }
  }
  return names;
}

/**
 * The whole rule, as one function, so the table-driven test below can falsify
 * it directly instead of only through the five live documents.
 */
function inventoryViolations({ label, names, registered, declaresSelection }) {
  const violations = [];

  const duplicates = [...new Set(names.filter((name, index) => names.indexOf(name) !== index))];
  if (duplicates.length > 0) {
    violations.push(`${label}: lists ${duplicates.join(", ")} more than once`);
  }

  const phantom = names.filter(name => !registered.includes(name));
  if (phantom.length > 0) {
    violations.push(`${label}: names unregistered tools ${phantom.join(", ")}`);
  }

  if (!declaresSelection) {
    const missing = registered.filter(name => !names.includes(name));
    if (missing.length > 0) {
      violations.push(`${label}: presents a complete inventory but omits ${missing.join(", ")}`);
    }
  }

  return violations;
}

describe("documented tool inventories", () => {
  it("continues an inventory after inline app-only annotations", () => {
    const inventory = TOOL_INVENTORIES.find(item => item.file === "AGENTS.md");
    expect(inventoryEntries(inventory, "- `first` (app-only), `second` (app-only), `third`.\n`not_an_entry` is prose."))
      .toEqual(["first", "second", "third"]);
  });

  async function liveInventoryInputs() {
    const sourceManifest = JSON.parse(await readRepositoryFile("manifest.json"));
    const packedManifest = JSON.parse(await readRepositoryFile("manifest.mcpb.json"));
    const registered = sourceManifest.tools.map(tool => tool.name);
    const structured = Object.keys(TOOL_OUTPUT_SCHEMAS);
    return {
      registered,
      structured,
      textOnly: registered.filter(name => !structured.includes(name)),
      appOnly: registered.filter(
        name => !packedManifest.tools.some(tool => tool.name === name),
      ),
    };
  }

  it("keeps every documented inventory complete, or declared partial and free of phantom tools", async () => {
    const { registered, structured } = await liveInventoryInputs();
    const violations = [];

    for (const inventory of TOOL_INVENTORIES) {
      const contents = await readRepositoryFile(inventory.file);
      const section = inventorySection(inventory, contents);
      const names = inventoryEntries(inventory, section);

      expect(names.length, `${inventory.label}: matched no entries`).toBeGreaterThan(0);

      // Read from the document, not from this config, so the marker is
      // load-bearing in the way `docs/MAINTAINERS.md` says it is: delete the
      // sentence declaring a list partial and the completeness rule applies to
      // it on the next run.
      const declaresSelection = Boolean(inventory.selectionMarker)
        && inventory.selectionMarker.test(contents);

      if (inventory.completenessStatement) {
        expect(contents, `${inventory.label}: completeness statement is gone`)
          .toMatch(inventory.completenessStatement);
      }

      violations.push(...inventoryViolations({
        label: inventory.label,
        names,
        registered: inventory.registeredKey === "structured" ? structured : registered,
        declaresSelection,
      }));
    }

    expect(violations).toEqual([]);
  });

  it("states the live structured and text-only split in the output-schema contract", async () => {
    const { structured, textOnly } = await liveInventoryInputs();
    const outputSchemas = normalizeWhitespace(await readRepositoryFile("docs/OUTPUT_SCHEMAS.md"));

    expect(outputSchemas).toContain(
      `this complete matrix of ${structured.length} structured tools and ${spellNumber(textOnly.length)} text-only tools`,
    );
    expect(outputSchemas).toContain(
      `The following ${spellNumber(textOnly.length)} tools remain intentionally text-only`,
    );

    // The named remainder must be exactly the tools with no advertised schema.
    // A tool that quietly loses its schema would otherwise appear in neither
    // half of a document that claims to cover both.
    const declared = [...outputSchemas
      .slice(outputSchemas.indexOf("remain intentionally text-only"))
      .slice(0, 240)
      .matchAll(/`([a-z_][a-z0-9_]*)`/g)]
      .map(match => match[1]);
    expect([...declared].sort()).toEqual([...textOnly].sort());
  });

  it("states the live app-only tool count where CLAUDE.md declares its selection", async () => {
    const { appOnly } = await liveInventoryInputs();
    const developmentGuide = await readRepositoryFile("CLAUDE.md");
    expect(developmentGuide).toContain(`(selected; ${appOnly.length} app-only)`);
  });

  it("keeps the maintainer rule pointing at every inventory it governs", async () => {
    // The previous instruction named two of the five lists. A rule that governs
    // an inventory nobody wrote down is how the OUTPUT_SCHEMAS matrix drifted.
    const maintainers = await readRepositoryFile("docs/MAINTAINERS.md");
    const missing = TOOL_INVENTORIES
      .filter(inventory => !maintainers.includes(inventory.file))
      .map(inventory => inventory.file);
    expect(missing).toEqual([]);
  });

  it.each([
    [
      "complete inventory that is complete",
      { names: ["a", "b"], registered: ["a", "b"], declaresSelection: false },
      [],
    ],
    [
      "complete inventory missing a registered tool",
      { names: ["a"], registered: ["a", "b"], declaresSelection: false },
      ["x: presents a complete inventory but omits b"],
    ],
    [
      "declared selection missing a registered tool",
      { names: ["a"], registered: ["a", "b"], declaresSelection: true },
      [],
    ],
    [
      "selection promoted to a completeness claim by dropping its marker",
      { names: ["a"], registered: ["a", "b"], declaresSelection: false },
      ["x: presents a complete inventory but omits b"],
    ],
    [
      "declared selection naming a tool that does not exist",
      { names: ["a", "ghost"], registered: ["a", "b"], declaresSelection: true },
      ["x: names unregistered tools ghost"],
    ],
    [
      "inventory listing the same tool twice",
      { names: ["a", "b", "a"], registered: ["a", "b"], declaresSelection: false },
      ["x: lists a more than once"],
    ],
  ])("%s", (_label, input, expected) => {
    expect(inventoryViolations({ label: "x", ...input })).toEqual(expected);
  });
});
