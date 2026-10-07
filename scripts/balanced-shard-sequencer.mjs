import path from "path";
import { BaseSequencer } from "vitest/node";

// Vitest's own --shard hashes file paths into equal-count slices. Here that
// put fuzz-malformed-pdfs, comparison-product-baseline and the rest of the
// heaviest suites into one shard, so four shards still left a 20-minute
// critical path. This sequencer keeps the base ordering and only replaces the
// shard split: longest-first greedy assignment by measured duration.
//
// Durations are seconds from the Linux pull-request gate on Node 22.12 (run
// 37492360840). Files not listed weigh DEFAULT_SECONDS. A stale table only
// unbalances the shards; every file still lands in exactly one of them.
export const MEASURED_SECONDS = new Map([
  ["test/fuzz-malformed-pdfs.test.js", 637],
  ["test/eval/comparison-product-baseline.test.js", 202],
  ["test/deep-malformed-campaign.test.js", 167],
  ["test/compare-pdfs.test.js", 84],
  ["test/pdf-read-permission-consistency.test.js", 71],
  ["test/eval/extraction-phase1-scorer.test.js", 63],
  ["test/save-lifecycle.test.js", 62],
  ["test/qpdf-decrypt-isolation.test.js", 32],
  ["test/eval/extraction-phase0.test.js", 31],
  ["test/eval/codex-comparison-controller.test.js", 31],
  ["test/convert-pdf-to-markdown.test.js", 26],
  ["test/qpdf-reprotect-write-paths.test.js", 20],
  ["test/eval/extraction-phase1.test.js", 20],
  ["test/home-config-location.test.js", 16],
  ["test/verified-vision-verifier.test.js", 15],
  ["test/eval/extraction-phase1-generation-verifiers.test.js", 14],
  ["test/analysis-error-truth.test.js", 13],
  ["test/mcp-contract.test.js", 12],
  ["test/read-pdf-layout.test.js", 12],
  ["test/pdfjs-subprocess-boundary.test.js", 12],
  ["test/render-pdf-page.test.js", 12],
  ["test/pdfjs-worker-contract.test.js", 11],
  ["test/eval/agent-workflow-run-binding.test.js", 11],
  ["test/atomic-output-recovery.test.js", 11],
  ["test/pdf-lib-subprocess-boundary.test.js", 11],
  ["test/plugin-data-config.test.js", 10],
]);

export const DEFAULT_SECONDS = 2;

/**
 * Returns, for each shard, the entries assigned to it. Pure and deterministic
 * so every shard computes the same split independently.
 * @param {{ key: string, file: string }[]} entries
 * @param {number} count
 */
export function balancedShards(entries, count) {
  const weight = entry => MEASURED_SECONDS.get(entry.file) ?? DEFAULT_SECONDS;
  const ordered = [...entries].sort((a, b) =>
    weight(b) - weight(a) || (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
  const loads = new Array(count).fill(0);
  const shards = Array.from({ length: count }, () => []);
  for (const entry of ordered) {
    let target = 0;
    for (let i = 1; i < count; i++) {
      if (loads[i] < loads[target]) target = i;
    }
    loads[target] += weight(entry);
    shards[target].push(entry);
  }
  return shards;
}

export class BalancedShardSequencer extends BaseSequencer {
  async shard(files) {
    const { index, count } = this.ctx.config.shard;
    const root = this.ctx.config.root;
    const entries = files.map(spec => {
      const file = path.relative(root, spec.moduleId).split(path.sep).join("/");
      return { spec, file, key: `${file}\0${spec.project.name}` };
    });
    return balancedShards(entries, count)[index - 1].map(entry => entry.spec);
  }
}
