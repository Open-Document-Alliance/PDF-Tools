import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { LUMIN_CLIENT_USER_AGENT as sourceUserAgent } from "../server/lumin-client-identity.js";
import { LUMIN_CLIENT_USER_AGENT as shareUserAgent } from "../pdf-toolkit-mcp-share/server/lumin-client-identity.js";

describe("Lumin client identity", () => {
  it("uses the installed package version in source and share without a secret or per-user identifier", () => {
    const sourcePackage = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));
    const sharePackage = JSON.parse(readFileSync(new URL("../pdf-toolkit-mcp-share/package.json", import.meta.url), "utf8"));
    expect(sourcePackage.version).toBe(sharePackage.version);
    expect(sourceUserAgent).toBe(`PDF-Tools/${sourcePackage.version}`);
    expect(shareUserAgent).toBe(sourceUserAgent);
    expect(sourceUserAgent).toMatch(/^PDF-Tools\/\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/);
  });
});
