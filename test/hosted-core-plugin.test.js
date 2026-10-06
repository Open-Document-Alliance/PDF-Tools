import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { listTools } from "../remote/server.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const read = file => readFileSync(path.join(root, file), "utf8");
const manifest = JSON.parse(read("plugins/pdf-tools-hosted/plugin.json"));
const config = JSON.parse(read("plugins/pdf-tools-hosted/mcp.json"));
const skill = read("plugins/pdf-tools-hosted/skills/pdf-tools/SKILL.md");

describe("broader hosted PDF Tools submission candidate", () => {
  it("keeps the full brand and preserves a distinct internal package identity", () => {
    expect(manifest.name).toBe("pdf-tools-hosted");
    expect(manifest.version).toBe("0.2.0");
    const ui = manifest.extensions["com.openai"].interface;
    expect(ui.displayName).toBe("PDF Tools");
    expect(ui.shortDescription.length).toBeLessThanOrEqual(30);
    expect(ui.longDescription).toMatch(/No OCR/);
    expect(ui.longDescription).toMatch(/processed remotely/);
    expect(ui.longDescription).toMatch(/not stored/);
    expect(ui.longDescription).toMatch(/does not provide local folder/);
    expect(ui.longDescription).toMatch(/document-level forms/);
    expect(manifest.extensions["com.openai"].review).toBeUndefined();
  });
  it("reuses the existing HTTPS service without bundling a command server", () => {
    expect(config.mcpServers).toEqual({ "pdf-tools": { type: "streamable-http", url: "https://mcp.opendocuments.ai/mcp" } });
    expect(JSON.stringify(config)).not.toMatch(/command|stdio|PLUGIN_ROOT/);
    expect(read("scripts/build-hosted-core-plugin.mjs")).not.toMatch(/prepareCleanStage|node_modules|build-mcpb/);
  });
  it("documents supported attachment and output contracts without inventing access", () => {
    expect(skill).toMatch(/never invent them/);
    expect(skill).toMatch(/output_mode: "download"/);
    expect(skill).toMatch(/never describe an unexamined page/);
    expect(skill).toMatch(/digest alone is not access/);
    expect(skill).toMatch(/Never invent consent/);
  });
  it("only documents tool names the actual server declares", () => {
    const tools = new Set(listTools().tools.map(tool => tool.name));
    for (const name of ["get_pdf_info", "read_pdf_pages", "search_pdf_text", "convert_pdf_to_markdown", "select_pdf_pages", "rotate_pdf_pages", "merge_pdfs", "read_form_fields", "fill_form", "flatten_form", "detect_signature_zones", "apply_signature"]) {
      expect(tools.has(name)).toBe(true);
      expect(skill).toContain(name);
    }
    expect(tools.size).toBe(12);
  });
  it("prepares review scenarios without claiming native host acceptance", () => {
    const cases = JSON.parse(read("plugins/pdf-tools-hosted/review-cases.json"));
    expect(cases.positive).toHaveLength(7);
    expect(cases.negative).toHaveLength(4);
    expect(cases.status).toMatch(/not native host acceptance/);
    expect(read("docs/OPENAI_HOSTED_CORE.md")).toMatch(/not deployed or submitted/);
    expect(read("scripts/build-hosted-core-plugin.mjs")).toMatch(/native_host_accepted: false/);
  });
  it("does not replace either historical forms or the full local profile", () => {
    expect(JSON.parse(read("plugins/pdf-forms/plugin.json")).name).toBe("pdf-forms");
    expect(read("scripts/build-agent-plugin.mjs")).toMatch(/type: "stdio"/);
  });
});
