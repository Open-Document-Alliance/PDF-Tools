import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const read = (file) => readFileSync(path.join(root, file), "utf8");
const manifest = JSON.parse(read("plugins/pdf-forms/plugin.json"));
const config = JSON.parse(read("plugins/pdf-forms/mcp.json"));
const skill = read("plugins/pdf-forms/skills/pdf-forms/SKILL.md");

describe("hosted forms submission profile", () => {
  it("declares exactly the existing production HTTPS endpoint without a command", () => {
    expect(config.mcpServers).toEqual({ "pdf-forms": { type: "streamable-http", url: "https://mcp.opendocuments.ai/mcp" } });
    expect(JSON.stringify(config)).not.toMatch(/command|stdio|PLUGIN_ROOT|localhost/);
  });
  it("is a distinct package with bounded human-facing metadata", () => {
    expect(manifest.name).toBe("pdf-forms");
    const ui = manifest.extensions["com.openai"].interface;
    expect(ui.displayName.length).toBeLessThanOrEqual(30);
    expect(ui.shortDescription.length).toBeLessThanOrEqual(30);
    expect(ui.longDescription).toMatch(/processed on a server|hosted PDF Tools service/);
    expect(ui.longDescription).toMatch(/does not provide the desktop viewer/);
    expect(ui.longDescription).toMatch(/3 MB/);
    expect(ui.longDescription).toMatch(/not a cryptographic signature/);
  });
  it("does not import the local workflow or fabricate review acceptance", () => {
    expect(manifest.extensions["com.openai"].review).toBeUndefined();
    expect(manifest.extensions["com.openai"].onboardingSkill).toBe("./skills/pdf-forms/SKILL.md");
    expect(skill).toMatch(/Never invent either required field/);
    expect(skill).toMatch(/never both/);
    expect(skill).toMatch(/output handoff is unsupported/);
  });
  it("keeps the full local package unchanged", () => {
    expect(read("scripts/build-agent-plugin.mjs")).toMatch(/type: "stdio"/);
    expect(read("scripts/build-hosted-forms-plugin.mjs")).not.toMatch(/prepareCleanStage|node_modules|build-mcpb/);
  });
  it("prepares exactly five positive and three negative prompts without claiming a host run", () => {
    const cases = JSON.parse(read("plugins/pdf-forms/review-cases.json"));
    expect(cases.positive).toHaveLength(5);
    expect(cases.negative).toHaveLength(3);
    for (const row of [...cases.positive, ...cases.negative]) {
      expect(row.description).toBeTruthy();
      expect(row.prompt).toBeTruthy();
      expect(typeof row.tools_triggered).toBe("string");
      expect(row.expected_behavior).toBeTruthy();
    }
    expect(read("docs/OPENAI_HOSTED_FORMS.md")).toMatch(/not native host acceptance/);
    expect(cases.positive[0].description).toMatch(/supplied privately/);
    expect(cases.positive[0].description).not.toMatch(/included in the package/);
  });
  it("qualifies returned page content rather than audit metadata alone", () => {
    const qualifier = read("scripts/qualify-hosted-forms.mjs");
    expect(qualifier).toMatch(/mkdir\(path.dirname\(output\), \{ recursive: true/);
    expect(qualifier).toMatch(/await pageText\(stampedBytes\)/);
    expect(qualifier).toMatch(/await pageText\(flatBytes\)/);
    expect(qualifier).toMatch(/assert.equal\(pdf.numPages, 1/);
  });
});
