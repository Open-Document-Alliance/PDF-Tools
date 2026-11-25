/**
 * Skills over MCP (io.modelcontextprotocol/skills) for the hosted server.
 *
 * The hosted server has its own skill text because the local workflow skill
 * describes local folders, profiles and tools the hosted edition does not
 * have (profile property P7: honest naming). The skill is read once from an
 * explicit file list inside remote/, never from a caller-supplied path, and is
 * advertised only to 2026-07-28 connections, as on the local server.
 */
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { ProtocolError, ProtocolErrorCode } from "@modelcontextprotocol/server";
import { parseDocument } from "yaml";

import { skillParams, SKILLS_EXTENSION } from "../server/skills.js";

export { skillParams, SKILLS_EXTENSION };

const SKILL_NAME = "pdf-tools-hosted";
const SKILL_URI = `skill://${SKILL_NAME}/SKILL.md`;
const SKILL_FILE = new URL(`./skills/${SKILL_NAME}/SKILL.md`, import.meta.url);

function load() {
  const bytes = readFileSync(SKILL_FILE);
  const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  const match = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/.exec(text);
  if (!match) throw new Error("Hosted skill is missing YAML frontmatter");
  const document = parseDocument(match[1], { uniqueKeys: true });
  if (document.errors.length) throw new Error("Hosted skill has invalid YAML frontmatter");
  const frontmatter = document.toJS({ maxAliasCount: 0 });
  if (frontmatter?.name !== SKILL_NAME || typeof frontmatter.description !== "string" || !frontmatter.description.trim()) {
    throw new Error("Hosted skill has an invalid name or description");
  }
  return Object.freeze({
    text,
    skill: Object.freeze({
      uri: SKILL_URI,
      frontmatter,
      resources: [{ uri: SKILL_URI, digest: `sha256:${createHash("sha256").update(bytes).digest("hex")}`, size: bytes.length }],
    }),
  });
}

let cached;
export function hostedSkills() {
  cached ??= load();
  const { text, skill } = cached;
  const complete = payload => ({ resultType: "complete", ttlMs: 0, cacheScope: "private", ...payload });
  const unknown = () => { throw new ProtocolError(ProtocolErrorCode.InvalidParams, "Unknown skill resource"); };
  return {
    list: () => complete({ skills: [skill] }),
    get: uri => (uri === SKILL_URI ? complete({ skill }) : unknown()),
    read: uri => (uri === SKILL_URI ? { contents: [{ uri, mimeType: "text/markdown", text }] } : unknown()),
    resources: () => [{ uri: SKILL_URI, name: SKILL_NAME, description: skill.frontmatter.description, mimeType: "text/markdown" }],
  };
}
