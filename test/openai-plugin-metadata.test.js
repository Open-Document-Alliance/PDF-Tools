import fs from "node:fs";
import { describe, expect, it } from "vitest";
import { createOpenAIPluginMetadata } from "../scripts/openai-plugin-metadata.mjs";
import { shipsInPlugin } from "../scripts/plugin-shipped-paths.mjs";

describe("local PDF Tools OpenAI listing metadata", () => {
  it("supplies bounded listing text and all four required public URLs", () => {
    const { interface: listing } = createOpenAIPluginMetadata();
    expect(listing.displayName.length).toBeLessThanOrEqual(30);
    expect(listing.shortDescription.length).toBeLessThanOrEqual(30);
    expect(listing.longDescription.length).toBeLessThanOrEqual(4000);
    for (const key of ["websiteURL", "supportURL", "privacyPolicyURL", "termsOfServiceURL"]) {
      const url = new URL(listing[key]);
      expect(url.protocol).toBe("https:");
      expect(url.username + url.password).toBe("");
    }
    expect(listing.defaultPrompt).toHaveLength(3);
    for (const prompt of listing.defaultPrompt) expect(prompt.length).toBeLessThanOrEqual(128);
  });

  it("preserves local and Lumin disclosure without claiming unsupported native file handoff", () => {
    const { interface: listing } = createOpenAIPluginMetadata();
    expect(listing.longDescription).toContain("not cryptographic signatures");
    expect(listing.longDescription).toContain("your confirmation before the PDF and recipient details are sent to Lumin");
    expect(listing.longDescription).toContain("content returned to the host follows its data terms");
    expect(listing.longDescription).not.toMatch(/save.back|native file handler|fully offline/i);
  });

  it("uses one metadata source for portable and compatibility manifests", () => {
    const builder = fs.readFileSync(new URL("../scripts/build-agent-plugin.mjs", import.meta.url), "utf8");
    expect(builder).toContain('"com.openai": createOpenAIPluginMetadata()');
    expect(builder).toContain("...createOpenAIPluginMetadata()");
    expect(shipsInPlugin("scripts/openai-plugin-metadata.mjs")).toBe(true);
    expect(createOpenAIPluginMetadata()).toEqual(createOpenAIPluginMetadata());
    expect(createOpenAIPluginMetadata().interface.logo).toBe("./assets/pdf-tools.png");
  });
});
