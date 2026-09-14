import { describe, expect, it } from "vitest";
import { parseNpmPackResult } from "../scripts/build-mcpb.mjs";

describe("npm pack receipt compatibility", () => {
  const name = "@napi-rs/canvas-darwin-x64";
  const receipt = { name, filename: "canvas.tgz", integrity: "sha512-example" };
  it("accepts the legacy single array and npm 11 package-keyed receipt", () => {
    expect(parseNpmPackResult(JSON.stringify([receipt]), name)).toEqual(receipt);
    expect(parseNpmPackResult(JSON.stringify({ [name]: receipt }), name)).toEqual(receipt);
  });
  it("rejects an empty, ambiguous, or differently named package inventory", () => {
    for (const value of [[], [receipt, receipt], null, {}, { other: receipt }, { [name]: receipt, other: receipt }]) {
      expect(() => parseNpmPackResult(JSON.stringify(value), name)).toThrow(/unexpected package inventory/);
    }
  });
});
