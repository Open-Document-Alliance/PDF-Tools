// The repository paths whose bytes reach the published Agent Plugin.
//
// This list is the whole discriminating power of `check-plugin-freshness.mjs`:
// that gate diffs `published..HEAD` and reports "nothing to publish" when no
// changed file matches an entry here. A path that ships and is missing from
// this list therefore produces a confident green over a stale distribution
// repo, which is the exact failure (#125) the gate was built to end.
//
// It lived as a private const inside the checker, under a comment that told
// maintainers to "keep this in step with scripts/build-agent-plugin.mjs".
// Nothing enforced that, and it had drifted: six inputs that demonstrably
// reach the artifact were absent. It is a module now so
// `test/plugin-freshness-coverage.test.js` can derive the true set from the
// builders and fail when the two disagree, in both directions.
//
// Two kinds of entry, and the difference matters when adding one:
//
//   1. DATA copied verbatim into the artifact (server/, vendor/, README.md).
//      Changing the file changes the published bytes directly.
//   2. BUILD CODE that decides what is copied or generates a shipped file
//      (scripts/build-mcpb.mjs, package-for-friend.js). Changing it can change
//      the published bytes with no change to any file in group 1 — which is
//      why "the builders themselves ship" is not a technicality.
//
// A false STALE costs one republish, which is idempotent. A false FRESH ships
// bytes nobody can reproduce. When in doubt, add the path.
export const SHIPPED_PATHS = Object.freeze([
  // Group 1: data copied verbatim.
  "server/",
  "dist-ui/",
  "vendor/",
  "plugins/pdf-tools-workflow/",
  "scripts/agent-plugin-launchers/",
  "package.json",
  "package-lock.json",
  "icon.png",
  "LICENSE",
  // Copied into the stage by copyRuntimeSource() and, unlike manifest.json,
  // not removed by the plugin builder. It is present in the distribution repo
  // at plugins/pdf-tools/README.md.
  "README.md",

  // Group 2: the build code that produces the artifact. This is the static
  // relative-import closure of scripts/build-agent-plugin.mjs, which the test
  // recomputes rather than trusting this comment.
  "scripts/build-agent-plugin.mjs",
  "scripts/build-mcpb.mjs",
  "scripts/build-toolchain.mjs",
  "scripts/mcpb-packaging-policy.mjs",
  "scripts/plugin-version.mjs",
  "scripts/qpdf-wasm-runtime.mjs",
  "scripts/pdfium-runtime.mjs",
  "package-for-friend.js",
]);

/** True when `file` (a repo-relative path) is one of the shipped inputs. */
export function shipsInPlugin(file) {
  return SHIPPED_PATHS.some(prefix =>
    prefix.endsWith("/") ? file.startsWith(prefix) : file === prefix);
}
