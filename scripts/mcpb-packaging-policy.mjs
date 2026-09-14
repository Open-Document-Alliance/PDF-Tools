export const PDFJS_EXCLUDED_DIRECTORIES = Object.freeze([
  "build",
  "web",
  "types",
  "image_decoders",
  "wasm",
]);

export const VERIFIED_EXTRACTION_RUNTIME_FILES = Object.freeze([
  "scripts/eval-strict-json.mjs",
  "scripts/verified-extraction-proposal.mjs",
  "scripts/verified-extraction-workspace.mjs",
]);

const ALLOWED_ARCHIVE_SCRIPT_FILES = new Set(VERIFIED_EXTRACTION_RUNTIME_FILES);

const FORBIDDEN_ARCHIVE_PREFIXES = Object.freeze([
  ...PDFJS_EXCLUDED_DIRECTORIES.map(
    name => `node_modules/pdfjs-dist/${name}/`,
  ),
  "node_modules/.vite/",
  "node_modules/.bin/",
  "node_modules/vite/",
  "node_modules/vite-plugin-singlefile/",
  "node_modules/vitest/",
  "node_modules/@vitest/",
  "node_modules/@modelcontextprotocol/ext-apps/",
  "node_modules/@modelcontextprotocol/sdk/",
  "node_modules/@esbuild/",
  "node_modules/@rollup/",
  "node_modules/rollup/",
  "node_modules/esbuild/",
  "test/",
  "docs/",
  ".git/",
  ".beads/",
  ".pdf-tools-extraction-cache/",
  "extraction-phase1-generations/",
]);

const FORBIDDEN_ARCHIVE_FILES = new Set([
  "package-lock.json",
  "node_modules/.package-lock.json",
  "config/remote-loopback-mock.v1.json",
]);

export function isForbiddenArchivePath(filename) {
  return (filename.startsWith("scripts/") && !ALLOWED_ARCHIVE_SCRIPT_FILES.has(filename)) ||
    FORBIDDEN_ARCHIVE_FILES.has(filename) ||
    FORBIDDEN_ARCHIVE_PREFIXES.some(prefix => filename.startsWith(prefix));
}
