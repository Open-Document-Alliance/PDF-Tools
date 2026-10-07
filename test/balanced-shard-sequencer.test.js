import { describe, expect, it } from "vitest";
import {
  BalancedShardSequencer,
  DEFAULT_SECONDS,
  MEASURED_SECONDS,
  balancedShards,
} from "../scripts/balanced-shard-sequencer.mjs";
import viteConfigFactory from "../vite.config.mjs";

const entries = [
  ...MEASURED_SECONDS.keys(),
  ...Array.from({ length: 40 }, (_, i) => `test/unmeasured-${i}.test.js`),
].map(file => ({ file, key: `${file}\0ordinary` }));

describe("balanced shard sequencer", () => {
  it("assigns every file to exactly one shard for any shard count", () => {
    for (let count = 1; count <= 8; count++) {
      const shards = balancedShards(entries, count);
      expect(shards).toHaveLength(count);
      const assigned = shards.flat().map(entry => entry.key).sort();
      expect(assigned).toEqual(entries.map(entry => entry.key).sort());
    }
  });

  it("splits the same way regardless of input order", () => {
    const forward = balancedShards(entries, 3);
    const reversed = balancedShards([...entries].reverse(), 3);
    expect(reversed.map(shard => shard.map(entry => entry.key)))
      .toEqual(forward.map(shard => shard.map(entry => entry.key)));
  });

  it("gives the heaviest suite a shard of its own share", () => {
    const shards = balancedShards(entries, 3);
    const weight = shard => shard.reduce((sum, entry) =>
      sum + (MEASURED_SECONDS.get(entry.file) ?? DEFAULT_SECONDS), 0);
    const heaviest = Math.max(...MEASURED_SECONDS.values());
    expect(Math.max(...shards.map(weight))).toBeLessThanOrEqual(heaviest + 10 * DEFAULT_SECONDS);
  });

  it("is the configured sequencer", () => {
    const config = viteConfigFactory({ command: "build", mode: "test" });
    expect(config.test.sequence.sequencer).toBe(BalancedShardSequencer);
  });
});
