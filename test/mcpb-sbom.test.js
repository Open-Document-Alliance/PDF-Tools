import { describe, expect, it } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { validatePackedSbomLicences } from "../scripts/smoke-mcpb.mjs";

describe("packed SDK 2 licence inventory", () => {
  it("validates a smaller complete runtime graph and refuses a missing required runtime", () => {
    const root = mkdtempSync(path.join(tmpdir(), "pdf-skills-sbom-"));
    const dependencies = ["@modelcontextprotocol/server", "@modelcontextprotocol/core", "@napi-rs/canvas", "pdf-lib", "pdfjs-dist", "yaml"];
    const sbom = { components: dependencies.map(name => ({
      name, scope: "required", licenses: [{ license: { id: "MIT" } }],
      properties: [{ name: "pdf-tools:npm-package-path", value: "node_modules/" + name }],
    })) };
    try {
      for (const name of dependencies) {
        const dir = path.join(root, "node_modules", name);
        mkdirSync(dir, { recursive: true });
        writeFileSync(path.join(dir, "package.json"), JSON.stringify({ name, license: "MIT" }));
      }
      expect(validatePackedSbomLicences(sbom, root).packed).toBe(6);
      rmSync(path.join(root, "node_modules/yaml"), { recursive: true });
      expect(() => validatePackedSbomLicences(sbom, root)).toThrow("Required runtime dependency is missing: yaml");
    } finally { rmSync(root, { recursive: true, force: true }); }
  });
});

