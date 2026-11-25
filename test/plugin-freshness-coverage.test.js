// Binds SHIPPED_PATHS to what the plugin build actually copies.
//
// scripts/check-plugin-freshness.mjs is the only mechanism that notices the
// distribution repo has gone stale. It decides by matching changed files
// against SHIPPED_PATHS, so a shipped input missing from that list makes the
// gate print "nothing to publish" and exit 0 over a stale published plugin —
// a false green from the one thing watching. The list carried a comment
// telling maintainers to keep it in step with the builder by hand, and nothing
// checked that, which is the shape of an unfollowable control: present,
// reassuring, and constraining nothing.
//
// These tests derive the shipped set from the builders themselves and assert
// it against the list in both directions. Both directions are load-bearing:
// a missing entry is a silent stale publish, and a dead entry makes the list
// look more complete than it is.
//
// Every derivation below is anchored so that a parse which stops matching
// throws instead of quietly deriving an empty set and passing vacuously.

import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { describe, expect, it } from "vitest";

import { SHIPPED_PATHS, shipsInPlugin } from "../scripts/plugin-shipped-paths.mjs";
import { SERVER_FILES, QPDF_WASM_RUNTIME_FILES } from "../scripts/build-mcpb.mjs";

const REPO_ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const PLUGIN_BUILD_ENTRY = "scripts/build-agent-plugin.mjs";

const read = relativePath => fs.readFileSync(path.join(REPO_ROOT, relativePath), "utf8");

/**
 * The static relative-import closure of a repo-relative entry point.
 *
 * Only relative specifiers are followed: a bare specifier is a node_modules
 * dependency, which is already covered by package-lock.json.
 */
function importClosure(entry) {
  const seen = new Set();
  const queue = [entry];
  while (queue.length > 0) {
    const file = queue.shift();
    if (seen.has(file)) continue;
    seen.add(file);
    const source = read(file);
    const specifiers = [
      ...source.matchAll(/(?:^|\n)\s*(?:import|export)[^;\n]*?from\s+["'](\.[^"']+)["']/g),
      ...source.matchAll(/import\(\s*["'](\.[^"']+)["']\s*\)/g),
    ].map(match => match[1]);
    for (const specifier of specifiers) {
      queue.push(path.posix.normalize(path.posix.join(path.posix.dirname(file), specifier)));
    }
  }
  return [...seen].sort();
}

/** The body of a named function declaration, located by an exact anchor. */
function functionBody(source, declaration) {
  const start = source.indexOf(declaration);
  if (start === -1) {
    throw new Error(
      `anchor not found: ${declaration}. This parse has stopped matching the source; `
        + "fix the anchor rather than letting the derivation return nothing.",
    );
  }
  let depth = 0;
  for (let index = start + declaration.length - 1; index < source.length; index += 1) {
    if (source[index] === "{") depth += 1;
    if (source[index] === "}") {
      depth -= 1;
      if (depth === 0) return source.slice(start, index + 1);
    }
  }
  throw new Error(`unbalanced braces after anchor: ${declaration}`);
}

// Files that copyRuntimeSource() stages but that never reach the plugin,
// each with the mechanism that removes it. An exemption whose mechanism has
// gone away must fail rather than launder a real gap (L37), which the last
// test in this file enforces.
const STAGE_ONLY = new Map([
  [
    "manifest.mcpb.json",
    'rmSync(path.join(stagingDir, "manifest.json")',
  ],
]);

describe("plugin freshness coverage", () => {
  it("covers every module the plugin build imports", () => {
    const closure = importClosure(PLUGIN_BUILD_ENTRY);

    // Anchor the derivation itself. A walker that stopped following imports
    // would return just the entry point and every assertion below would pass
    // over nothing.
    expect(closure).toContain(PLUGIN_BUILD_ENTRY);
    expect(closure.length).toBeGreaterThanOrEqual(5);

    const uncovered = closure.filter(file => !shipsInPlugin(file));
    expect(uncovered).toEqual([]);
  });

  it("covers every repository file copied verbatim into the artifact", () => {
    expect(SERVER_FILES.length).toBeGreaterThan(0);
    expect(QPDF_WASM_RUNTIME_FILES.length).toBeGreaterThan(0);

    const copied = [
      ...SERVER_FILES.map(filename => `server/${filename}`),
      ...QPDF_WASM_RUNTIME_FILES,
      "dist-ui/index.html",
      "icon.png",
      "LICENSE",
      "README.md",
      "package.json",
      "package-lock.json",
      "plugins/pdf-tools-workflow/skills/pdf-tools-workflow/SKILL.md",
      "scripts/agent-plugin-launchers/pdf-tools-launch",
    ];

    for (const file of copied) {
      expect(fs.existsSync(path.join(REPO_ROOT, file)), `${file} does not exist`).toBe(true);
    }

    const uncovered = copied.filter(file => !shipsInPlugin(file));
    expect(uncovered).toEqual([]);
  });

  it("declares every literal source path copyRuntimeSource stages, shipped or stage-only", () => {
    const body = functionBody(read("scripts/build-mcpb.mjs"), "function copyRuntimeSource(stagingDir, { includeMcpbManifest = true } = {}) {");

    // Read the *arguments*, not every quoted literal in the body. The first
    // draft of this test collected all literals and reported manifest.json,
    // which is copyRegularFile's destination name for manifest.mcpb.json and
    // not a source path at all. A derivation that cannot tell a source from a
    // destination produces findings that are not about the product.
    //
    // Each pattern is required to match. A renamed helper must throw here, not
    // silently contribute nothing and let the assertion pass over a short set.
    const patterns = [
      // copyRegularFile(<source>, <destination>, stagingDir)
      [/copyRegularFile\(\s*"([^"]+)"/g, "copyRegularFile(<source literal>"],
      // assertRegularFirstPartyFile(REPO_ROOT, <source>)
      [/assertRegularFirstPartyFile\(\s*REPO_ROOT\s*,\s*"([^"]+)"/g, "assertRegularFirstPartyFile(REPO_ROOT, <source>"],
    ];
    const staged = new Set();
    for (const [pattern, description] of patterns) {
      const matches = [...body.matchAll(pattern)];
      if (matches.length === 0) {
        throw new Error(
          `derivation matched nothing for ${description}). copyRuntimeSource has been `
            + "rewritten; fix this parse rather than letting it derive an empty set.",
        );
      }
      for (const match of matches) staged.add(match[1]);
    }

    // The bulk root-file loop: for (const filename of [...]) copyRegularFile(...)
    const loops = [...body.matchAll(/for\s*\(\s*const\s+\w+\s+of\s+\[([^\]]+)\]\s*\)/g)];
    if (loops.length === 0) {
      throw new Error(
        "derivation matched no `for (const x of [...])` loop in copyRuntimeSource; "
          + "the root-file list has moved and this parse no longer sees it.",
      );
    }
    for (const loop of loops) {
      for (const literal of loop[1].matchAll(/"([^"]+)"/g)) staged.add(literal[1]);
    }

    const sources = [...staged].sort();
    expect(sources.length).toBeGreaterThanOrEqual(6);

    // Every derived source must be a real path in this repository. This is what
    // separates a source from a destination: a destination lives in the staging
    // directory and has no reason to exist here.
    for (const file of sources) {
      expect(fs.existsSync(path.join(REPO_ROOT, file)), `derived a path that does not exist: ${file}`)
        .toBe(true);
    }

    const undeclared = sources.filter(file => !shipsInPlugin(file) && !STAGE_ONLY.has(file));
    expect(
      undeclared,
      "copyRuntimeSource stages a source path that neither ships nor is declared stage-only",
    ).toEqual([]);
  });

  it("keeps every stage-only exemption backed by the removal that justifies it", () => {
    const builder = read(PLUGIN_BUILD_ENTRY);
    for (const [file, removal] of STAGE_ONLY) {
      expect(
        builder.includes(removal),
        `${file} is exempted from SHIPPED_PATHS because the plugin builder removes it, `
          + `but the removal (${removal}) is gone. The exemption is now a coverage gap.`,
      ).toBe(true);
    }
  });

  it("has no dead entry that covers nothing on disk", () => {
    expect(SHIPPED_PATHS.length).toBeGreaterThan(0);
    const dead = SHIPPED_PATHS.filter(entry => !fs.existsSync(path.join(REPO_ROOT, entry)));
    expect(dead, "a SHIPPED_PATHS entry matches no path, so it covers nothing").toEqual([]);
  });
});
