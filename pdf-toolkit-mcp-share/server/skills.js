import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { parseDocument } from "yaml";
import { ProtocolError, ProtocolErrorCode } from "@modelcontextprotocol/server";

import { SKILL_FILES, SKILL_ROOT } from "./skill-files.js";
export { SKILL_FILES, SKILLS_EXTENSION } from "./skill-files.js";
const SKILL_URI = "skill://pdf-tools-workflow/SKILL.md";

// An explicit authored-file allowlist, never a walk of a user PDF directory.
// Read once so each connection's manifest and resource bytes are one snapshot.
export function loadSkills() {
  const files = new Map(SKILL_FILES.map(filename => {
    const bytes = readFileSync(new URL(`../${filename}`, import.meta.url));
    const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    return [`skill://pdf-tools-workflow/${filename.slice(SKILL_ROOT.length + 1)}`, { bytes, text }];
  }));
  const match = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/.exec(files.get(SKILL_URI).text);
  if (!match) throw new Error("Bundled PDF workflow is missing YAML frontmatter");
  const document = parseDocument(match[1], { uniqueKeys: true });
  if (document.errors.length) throw new Error("Bundled PDF workflow has invalid YAML frontmatter");
  const frontmatter = document.toJS({ maxAliasCount: 0 });
  if (frontmatter?.name !== "pdf-tools-workflow" || typeof frontmatter.description !== "string" || !frontmatter.description.trim()) {
    throw new Error("Bundled PDF workflow has invalid name or description");
  }
  const skill = {
    uri: SKILL_URI,
    frontmatter,
    resources: [...files].map(([uri, { bytes }]) => ({
      uri, digest: `sha256:${createHash("sha256").update(bytes).digest("hex")}`, size: bytes.length,
    })),
  };
  const complete = payload => ({ resultType: "complete", ttlMs: 0, cacheScope: "private", ...payload });
  const invalid = () => { throw new ProtocolError(ProtocolErrorCode.InvalidParams, "Unknown skill resource"); };
  return {
    list: () => complete({ skills: [skill] }),
    get: uri => uri === SKILL_URI ? complete({ skill }) : invalid(),
    read: uri => {
      const file = files.get(uri);
      if (!file) return invalid();
      return { contents: [{ uri, mimeType: uri.endsWith(".md") ? "text/markdown" : "application/yaml", text: file.text }] };
    },
    resources: () => [...files.keys()].map(uri => ({
      uri,
      name: uri === SKILL_URI ? frontmatter.name : "PDF workflow host configuration",
      ...(uri === SKILL_URI ? { description: frontmatter.description } : {}),
      mimeType: uri.endsWith(".md") ? "text/markdown" : "application/yaml",
    })),
  };
}

// SDK 2's documented Standard Schema registration path for extension methods.
export function skillParams(kind) {
  return { "~standard": {
    version: 1, vendor: "pdf-tools",
    validate(value) {
      const valid = value && typeof value === "object" && !Array.isArray(value) &&
        (kind === "get" ? typeof value.uri === "string" : value.cursor === undefined);
      return valid ? { value } : { issues: [{ message: kind === "get" ? "uri must be a string" : "No cursor was issued" }] };
    },
  } };
}
