import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

import { handleMcpFetch } from "../remote/http.mjs";
import { listTools } from "../remote/server.mjs";

const SKILL_URI = "skill://pdf-tools-hosted/SKILL.md";
const MODERN = "2026-07-28";
const META = {
  "io.modelcontextprotocol/protocolVersion": MODERN,
  "io.modelcontextprotocol/clientInfo": { name: "synthetic-skill-test", version: "0" },
  "io.modelcontextprotocol/clientCapabilities": {},
};

async function post(message, { modern }) {
  const headers = { "content-type": "application/json", accept: "application/json, text/event-stream", "mcp-protocol-version": modern ? MODERN : "2025-11-25" };
  const body = modern ? { ...message, params: { ...(message.params ?? {}), _meta: META } } : message;
  if (modern) {
    headers["mcp-method"] = message.method;
    if (message.params?.name) headers["mcp-name"] = message.params.name;
    if (message.method === "resources/read") headers["mcp-name"] = message.params.uri;
  }
  const response = await handleMcpFetch(new Request("http://localhost/mcp", { method: "POST", headers, body: JSON.stringify(body) }));
  const raw = await response.text();
  const data = raw.startsWith("{") ? raw : raw.split(/\r?\n/).filter(line => line.startsWith("data: ")).map(line => line.slice(6)).join("");
  return { status: response.status, message: JSON.parse(data) };
}

describe("hosted Skills over MCP", () => {
  it("advertises the skills extension to 2026-07-28 connections", async () => {
    const { message } = await post({ jsonrpc: "2.0", id: 1, method: "server/discover" }, { modern: true });
    expect(message.result.capabilities.extensions).toHaveProperty(["io.modelcontextprotocol/skills"]);
  });

  it("lists, gets and reads the hosted skill, bound to its exact bytes", async () => {
    const listed = await post({ jsonrpc: "2.0", id: 1, method: "skills/list", params: {} }, { modern: true });
    const [skill] = listed.message.result.skills;
    expect(skill.uri).toBe(SKILL_URI);
    expect(skill.frontmatter.name).toBe("pdf-tools-hosted");
    const got = await post({ jsonrpc: "2.0", id: 2, method: "skills/get", params: { uri: SKILL_URI } }, { modern: true });
    expect(got.message.result.skill.uri).toBe(SKILL_URI);
    const read = await post({ jsonrpc: "2.0", id: 3, method: "resources/read", params: { uri: SKILL_URI } }, { modern: true });
    const text = read.message.result.contents[0].text;
    const bytes = Buffer.from(text, "utf8");
    expect(skill.resources[0].size).toBe(bytes.length);
    expect(text).toContain("# Hosted PDF Tools");
    const resources = await post({ jsonrpc: "2.0", id: 4, method: "resources/list", params: {} }, { modern: true });
    expect(resources.message.result.resources.map(resource => resource.uri)).toContain(SKILL_URI);
  });

  it("refuses unknown skill URIs", async () => {
    const { message } = await post({ jsonrpc: "2.0", id: 1, method: "skills/get", params: { uri: "skill://pdf-tools-workflow/SKILL.md" } }, { modern: true });
    expect(message.error).toBeDefined();
  });

  it("does not advertise skills to 2025-era connections", async () => {
    const init = await post({ jsonrpc: "2.0", id: 0, method: "initialize", params: { protocolVersion: "2025-11-25", capabilities: {}, clientInfo: { name: "t", version: "0" } } }, { modern: false });
    expect(init.message.result.capabilities.extensions).toBeUndefined();
    const listed = await post({ jsonrpc: "2.0", id: 1, method: "skills/list", params: {} }, { modern: false });
    expect(listed.message.error).toBeDefined();
  });

  it("names only tools the hosted server actually has", () => {
    const text = readFileSync(new URL("../remote/skills/pdf-tools-hosted/SKILL.md", import.meta.url), "utf8");
    const hosted = new Set(listTools().tools.map(tool => tool.name));
    const named = [...text.matchAll(/`([a-z]+(?:_[a-z]+)+)`/g)].map(match => match[1])
      .filter(name => !["pdf_url", "pdf_base64", "output_mode", "f1_01"].includes(name) && !/^[A-Z_]+$/.test(name));
    expect(named.length).toBeGreaterThan(5);
    for (const name of named) expect(hosted, name).toContain(name);
    expect(text).not.toMatch(/desktop extension|list_pdfs|save_profile|fill_pdf\b/);
  });
});
