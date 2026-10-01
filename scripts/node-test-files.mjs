const RELEASE_PLATFORMS = Object.freeze(["darwin", "linux", "win32"]);
const POSIX_PLATFORMS = Object.freeze(["darwin", "linux"]);

export const NODE_TEST_SUITES = Object.freeze([
  {
    file: "test/local-ocr-tools-native.test.js",
    platforms: POSIX_PLATFORMS,
    omissions: Object.freeze({
      win32: "optional local OCR adapter requires macOS; private-mode and process-group tests are POSIX-only",
    }),
  },
  {
    file: "test/deep-malformed-native-v2-contract.test.js",
    platforms: RELEASE_PLATFORMS,
  },
  {
    file: "test/deep-malformed-native-v2-mechanisms.test.js",
    platforms: POSIX_PLATFORMS,
    omissions: Object.freeze({
      win32: "frozen historical suite requires POSIX FIFO and process-group primitives",
    }),
  },
  {
    file: "test/deep-malformed-native-v3-contract.test.js",
    platforms: RELEASE_PLATFORMS,
  },
  {
    file: "test/deep-malformed-native-v3-mechanisms.test.js",
    platforms: POSIX_PLATFORMS,
    omissions: Object.freeze({
      win32: "frozen historical suite requires POSIX FIFO and process-group primitives",
    }),
  },
  {
    file: "test/deep-malformed-native-v4-contract.test.js",
    platforms: RELEASE_PLATFORMS,
  },
  {
    file: "test/deep-malformed-native-v4-mechanisms.test.js",
    platforms: POSIX_PLATFORMS,
    omissions: Object.freeze({
      win32: "frozen historical suite requires POSIX FIFO and process-group primitives",
    }),
  },
  {
    file: "test/qpdf-macos-budget-exec.test.js",
    platforms: RELEASE_PLATFORMS,
  },
  {
    file: "test/connect-auth.test.js",
    platforms: RELEASE_PLATFORMS,
  },
  {
    file: "test/deep-malformed-native-windows-portable.test.js",
    platforms: Object.freeze(["win32"]),
    omissions: Object.freeze({
      darwin: "portable scanner contract is covered by the fuller POSIX mechanism suites",
      linux: "portable scanner contract is covered by the fuller POSIX mechanism suites",
    }),
  },
].map(suite => Object.freeze(suite)));

export const NODE_TEST_FILES = Object.freeze(
  NODE_TEST_SUITES.map(suite => suite.file),
);

export function nodeTestFilesForPlatform(platform) {
  if (!RELEASE_PLATFORMS.includes(platform)) {
    throw new Error(`Unsupported native test platform: ${platform}`);
  }
  return NODE_TEST_SUITES
    .filter(suite => suite.platforms.includes(platform))
    .map(suite => suite.file);
}

export function nodeTestOmissionsForPlatform(platform) {
  nodeTestFilesForPlatform(platform);
  return NODE_TEST_SUITES
    .filter(suite => !suite.platforms.includes(platform))
    .map(suite => ({
      file: suite.file,
      reason: suite.omissions?.[platform],
    }));
}
