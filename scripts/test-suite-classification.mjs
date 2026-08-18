export const DIRECT_CHECKOUT_LOCAL_SCRATCH_ALLOCATORS = Object.freeze([
  Object.freeze({
    file: "scripts/dev-ui-rotated-sign-smoke.mjs",
    prefix: ".test-tmp-rotated-ui-",
    reason: "The development smoke test needs a source-relative allowed output.",
  }),
  Object.freeze({
    file: "test/helpers/temp-directory.js",
    prefix: ".test-tmp-${label}-",
    reason: "Central allocator for unique, owned checkout-local integration roots.",
  }),
]);

export const REAL_CHECKOUT_SOURCE_IDENTITY_BINDERS = Object.freeze([
  Object.freeze({
    file: "scripts/eval-prepare-agent-workflow-campaign.mjs",
    reason: "Binds verifiedCleanSourceCommit to the PDF Tools repository root.",
  }),
  Object.freeze({
    file: "scripts/run-all-test-suites.mjs",
    reason: "Binds aggregate preflight and partition barriers to the PDF Tools root.",
  }),
]);

export const SYNTHETIC_SOURCE_IDENTITY_IMPORTERS = Object.freeze([
  Object.freeze({
    file: "test/source-worktree-state.test.js",
    reason: "Exercises the generic checker only against unique repositories under the OS temp root.",
  }),
  Object.freeze({
    file: "test/fixtures/vitest-group-order/source-identity.fixture.mjs",
    reason: "Reproduces Git-visible interference only in a unique synthetic repository under the OS temp root.",
  }),
]);

export const SOURCE_IDENTITY_TRANSITIVE_MODULES = Object.freeze([
  Object.freeze({
    file: "scripts/eval-rehearse-agent-workflow-protocol-v4.mjs",
    reason: "The v4 no-model rehearsal delegates clean source identity to the real-checkout campaign binder.",
  }),
  Object.freeze({
    file: "scripts/eval-prepare-agent-workflow-campaign-v3.mjs",
    reason: "Retired v3 preparation delegates source identity to the real-checkout campaign binder.",
  }),
  Object.freeze({
    file: "scripts/eval-run-agent-workflow-campaign-v3.mjs",
    reason: "Retired v3 execution verifies source identity through the campaign binder.",
  }),
  Object.freeze({
    file: "scripts/eval-score-agent-workflow-campaign-v3.mjs",
    reason: "Retired v3 scoring verifies source identity through the campaign binder.",
  }),
]);

export const NON_EXECUTABLE_SOURCE_IDENTITY_REFERENCES = Object.freeze([
  Object.freeze({
    file: "test/eval/agent-workflow-v3-retirement.test.js",
    target: "scripts/eval-prepare-agent-workflow-campaign-v3.mjs",
    reason: "Reads the retired controller as source text through new URL; it does not execute the module.",
  }),
]);

export const CHECKOUT_LOCAL_MUTATING_TEST_SUITES = Object.freeze([
  "test/allowed-directories.test.js",
  "test/apply-page-plan.test.js",
  "test/atomic-output-recovery.test.js",
  "test/atomic-output.test.js",
  "test/atomic-tool-output.test.js",
  "test/compare-pdfs.test.js",
  "test/csv-roundtrip.test.js",
  "test/deep-malformed-campaign.test.js",
  "test/detect-signature-zones-tool.test.js",
  "test/encrypted-pdf-password-truth.test.js",
  "test/eval/codex-comparison-controller.test.js",
  "test/fetch-pdf-from-url.test.js",
  "test/fuzz-malformed-pdfs.test.js",
  "test/get-page-analysis.test.js",
  "test/get-allowed-directories.test.js",
  "test/get-pdf-info.test.js",
  "test/golden-set-placement.test.js",
  "test/home-config-location.test.js",
  "test/host-placeholder-expansion.test.js",
  "test/integration.test.js",
  "test/list-pdfs-default-directory.test.js",
  "test/list-signatures-unreadable.test.js",
  "test/metadata-provenance.test.js",
  "test/mutation-input-limits.test.js",
  "test/path-handler-toctou.test.js",
  "test/pdfjs-worker-contract.test.js",
  "test/plugin-data-config.test.js",
  "test/qpdf-reprotect-write-paths.test.js",
  "test/render-pdf-page.test.js",
  "test/sandbox-boundary-findings.test.js",
  "test/signatures.test.js",
  "test/temp-directory.test.js",
  "test/type3-recovery-gate.test.js",
  "test/validate-pdf.test.js",
  "test/xfa-guards.test.js",
]);

export const REVIEWED_COMPUTED_MODULE_LOADS = Object.freeze([
  Object.freeze({
    // The byte-identical share mirror of server/qpdf-decrypt-worker.js below.
    // Same load, same fingerprint; the two entries must not diverge.
    file: "pdf-toolkit-mcp-share/server/qpdf-decrypt-worker.js",
    count: 1,
    kinds: Object.freeze(["dynamic-import"]),
    fingerprints: Object.freeze([
      "689d1575decd28551f1043e7b853740985cba96c87102c4a834cae9b1da7d52e",
    ]),
    reason: "Share-tree mirror of server/qpdf-decrypt-worker.js, which loads the vendored QPDF "
      + "WebAssembly runtime from a fixed repository-relative path.",
  }),
  Object.freeze({
    file: "scripts/eval-calibrate-docling-supervisor.mjs",
    count: 1,
    kinds: Object.freeze(["dynamic-import"]),
    fingerprints: Object.freeze([
      "324f1dd7563934fcad8a67004e19120e5af1400a0be377800f8771b38e40ed70",
    ]),
    reason: "Loads a content-addressed generated controller outside the source checkout.",
  }),
  Object.freeze({
    file: "scripts/eval-capture-docling-bakeoff.mjs",
    count: 2,
    kinds: Object.freeze(["dynamic-import", "dynamic-import"]),
    fingerprints: Object.freeze([
      "945966b799328d11c93c9092bf8ba3029bc9496a4cf6da1323ee15dde065f230",
      "28c892e64238554d2b4b0426118f566882828acc8202adb6efe269e839faf56d",
    ]),
    reason: "Loads content-addressed file URLs and data URLs generated for authority capture.",
  }),
  Object.freeze({
    file: "scripts/eval-docling-authority.mjs",
    count: 1,
    kinds: Object.freeze(["dynamic-import"]),
    fingerprints: Object.freeze([
      "ecb3e1f7bccf05bdaf8abffd775a3c4f8b5357f631bdc97bba82f5a651278634",
    ]),
    reason: "Loads controller bytes through a generated data URL.",
  }),
  Object.freeze({
    file: "scripts/eval-run-codex-agent-workflow-case.mjs",
    count: 1,
    kinds: Object.freeze(["dynamic-import"]),
    fingerprints: Object.freeze([
      "adf648f59f6851e234fc181440c721c622db54d6cd58b921e61bab3e06348184",
    ]),
    reason: "Loads a verified external attester file URL.",
  }),
  Object.freeze({
    file: "scripts/eval-verify-docling-macos-handoff.mjs",
    count: 1,
    kinds: Object.freeze(["dynamic-import"]),
    fingerprints: Object.freeze([
      "43a13fd31dedbfd235c2cc0626c6dc7a6e07db3b3a5bf743139342c8f8c88104",
    ]),
    reason: "Loads the explicitly supplied verifier URL.",
  }),
  Object.freeze({
    file: "scripts/generate-layout-encrypted-oracle.mjs",
    count: 1,
    kinds: Object.freeze(["dynamic-import"]),
    fingerprints: Object.freeze([
      "f180d903a09ac300faa7afdd76e0afee1781676c3b3a34adbf56aafb5c5d486c",
    ]),
    reason: "Loads the selected generated qpdf module URL.",
  }),
  Object.freeze({
    file: "scripts/macos-claude-installed-shannon.mjs",
    count: 2,
    kinds: Object.freeze(["dynamic-import", "dynamic-import"]),
    fingerprints: Object.freeze([
      "0bea25bcef085af91e6d4364375bbdde843149fa1d65f834db34ae52fcae5ef7",
      "28c033735ea9fb0f4f12abf4ed9d905107b81abef289f9e5315316809b5440c7",
    ]),
    reason: "Loads an installed SDK by validated absolute file URL for the Shannon proof.",
  }),
  Object.freeze({
    file: "scripts/macos-claude-installed-smoke.mjs",
    count: 2,
    kinds: Object.freeze(["dynamic-import", "dynamic-import"]),
    fingerprints: Object.freeze([
      "0bea25bcef085af91e6d4364375bbdde843149fa1d65f834db34ae52fcae5ef7",
      "28c033735ea9fb0f4f12abf4ed9d905107b81abef289f9e5315316809b5440c7",
    ]),
    reason: "Loads an installed SDK by validated absolute file URL.",
  }),
  Object.freeze({
    file: "scripts/test-share-contract.mjs",
    count: 1,
    kinds: Object.freeze(["dynamic-import"]),
    fingerprints: Object.freeze([
      "955c0c9874d8a7293b769d2b9597a728fcd373c87f16a826b40e90d556ad6717",
    ]),
    reason: "Loads a packaged share artifact from an isolated build root.",
  }),
  Object.freeze({
    file: "server/qpdf-decrypt-worker.js",
    count: 1,
    kinds: Object.freeze(["dynamic-import"]),
    fingerprints: Object.freeze([
      "689d1575decd28551f1043e7b853740985cba96c87102c4a834cae9b1da7d52e",
    ]),
    reason: "Loads the vendored QPDF WebAssembly runtime from a fixed repository-relative path "
      + "resolved against import.meta.url. The specifier is computed rather than literal so that "
      + "test-time bundlers leave the Emscripten output alone; it resolves its own .wasm sibling. "
      + "This is the decryption worker thread rather than server/qpdf-decrypt.js: the runtime is "
      + "synchronous, so it has to be loaded somewhere that can be destroyed on a deadline.",
  }),
  Object.freeze({
    file: "test/eval/extraction-docling-handoff.js",
    count: 1,
    kinds: Object.freeze(["dynamic-import"]),
    fingerprints: Object.freeze([
      "bfb22ac97868fe7bb9a1d7da4651099c672c2ac8fec83b6b51340bbeb36dd305",
    ]),
    reason: "Loads a verified generated controller outside the checkout.",
  }),
  Object.freeze({
    file: "test/pdf-read-permission-consistency.test.js",
    count: 1,
    kinds: Object.freeze(["dynamic-import"]),
    fingerprints: Object.freeze([
      "948c7080973dbfd1901b9e7904f3a2abcc2c968427f868cd50096046ad532df5",
    ]),
    reason: "Loads the committed QPDF runtime to build the matched pair of owner-locked AES-256 "
      + "documents that differ only in /P bit 5, which is the only way to observe whether a tool "
      + "consults the bit, and which cannot be committed as binaries.",
  }),
  Object.freeze({
    file: "test/qpdf-decrypt-isolation.test.js",
    count: 1,
    kinds: Object.freeze(["dynamic-import"]),
    fingerprints: Object.freeze([
      "948c7080973dbfd1901b9e7904f3a2abcc2c968427f868cd50096046ad532df5",
    ]),
    reason: "Loads the committed QPDF runtime to encrypt the deliberately pathological "
      + "many-object fixture the decryption deadline is measured against, so a document built to "
      + "be slow is generated rather than committed.",
  }),
  Object.freeze({
    file: "test/qpdf-decrypt-read-only.test.js",
    count: 1,
    kinds: Object.freeze(["dynamic-import"]),
    fingerprints: Object.freeze([
      "948c7080973dbfd1901b9e7904f3a2abcc2c968427f868cd50096046ad532df5",
    ]),
    reason: "Loads the committed QPDF runtime to encrypt its own AES-256, AES-128 and RC4-128 "
      + "fixtures, so the decryption suite exercises real encrypted documents without committing "
      + "binaries.",
  }),
  Object.freeze({
    file: "test/qpdf-reprotect-write-paths.test.js",
    count: 1,
    kinds: Object.freeze(["dynamic-import"]),
    fingerprints: Object.freeze([
      "948c7080973dbfd1901b9e7904f3a2abcc2c968427f868cd50096046ad532df5",
    ]),
    reason: "Loads the committed QPDF runtime to encrypt its own fixtures and to inspect the "
      + "written output independently of the product, so the claim that a mutation restored a "
      + "document's own protection is checked against the runtime rather than against the code "
      + "that made it.",
  }),
  Object.freeze({
    file: "test/type3-recovery-gate.test.js",
    count: 1,
    kinds: Object.freeze(["dynamic-import"]),
    fingerprints: Object.freeze([
      "49ea2a4c75eea36e13ac9eeb361b35d5e909e755cd06a0aa72d07cf6a5621683",
    ]),
    reason: "Imports deliberately malformed copies of the recovery module to prove each Type-3 registry startup invariant rejects.",
  }),
  Object.freeze({
    file: "vendor/qpdf-wasm/smoke.mjs",
    count: 1,
    kinds: Object.freeze(["dynamic-import"]),
    fingerprints: Object.freeze([
      "4fa1d4b65418c62e010fe6b642b227915884e8f4259a918c583e6d8c7a752cce",
    ]),
    reason: "Loads the selected qpdf artifact from the vendor smoke directory.",
  }),
]);

export const SOURCE_IDENTITY_TEST_SUITES = Object.freeze([
  Object.freeze({
    file: "test/eval/agent-workflow-campaign-preparation.test.js",
    reason: "Exercises the v2 campaign clean-source identity gate.",
  }),
  Object.freeze({
    file: "test/eval/agent-workflow-repeated-campaign.test.js",
    reason: "Exercises the retired v2 campaign clean-source identity gate.",
  }),
  Object.freeze({
    file: "test/eval/agent-workflow-run-binding.test.js",
    reason: "Prepares exact-source campaign runs before binding their artifacts.",
  }),
  Object.freeze({
    file: "test/eval/agent-workflow-v3-campaign.test.js",
    reason: "Retains the retired v3 preparation, execution, and scoring gates.",
  }),
  Object.freeze({
    file: "test/eval/agent-workflow-v3-preparation.test.js",
    reason: "Retains the retired v3 clean-source preparation gate.",
  }),
  Object.freeze({
    file: "test/test-runner-contract.test.js",
    reason: "Imports the aggregate module that binds source checks to the real checkout.",
  }),
]);

export const SOURCE_IDENTITY_TEST_FILES = Object.freeze(
  SOURCE_IDENTITY_TEST_SUITES.map(suite => suite.file),
);

export const SERIAL_RESOURCE_TEST_SUITES = Object.freeze([
  Object.freeze({
    file: "test/compare-pdfs.test.js",
    reason: "Exercises multiple PDF.js comparison renders that exceeded their "
      + "existing per-test budgets only under sibling-suite contention and "
      + "passed unchanged with an exclusive worker.",
  }),
  Object.freeze({
    file: "test/eval/comparison-product-baseline.test.js",
    reason: "Runs the full comparison-product baseline and approached its "
      + "sealed 240-second suite budget under sibling-suite contention.",
  }),
  Object.freeze({
    file: "test/eval/extraction-phase0.test.js",
    reason: "Runs extraction bakeoff fixtures that exceeded their existing "
      + "per-test budgets only under sibling-suite contention and passed "
      + "unchanged with an exclusive worker.",
  }),
  Object.freeze({
    file: "test/eval/extraction-phase1-publisher.test.js",
    reason: "Publishes extraction evidence through asynchronous fixture work; "
      + "sibling-suite contention caused timeouts and cleanup races that did "
      + "not reproduce with an exclusive worker.",
  }),
  Object.freeze({
    file: "test/eval/extraction-phase1-scorer.test.js",
    reason: "Scores extraction fixtures through asynchronous PDF work; "
      + "sibling-suite contention caused timeouts and cleanup races that did "
      + "not reproduce with an exclusive worker.",
  }),
  Object.freeze({
    file: "test/fuzz-malformed-pdfs.test.js",
    reason: "Runs the bounded malformed-PDF campaign for several minutes and "
      + "exceeded its existing per-test budgets only under sibling-suite "
      + "contention.",
  }),
  Object.freeze({
    file: "test/lumin-sign-v1-transport.test.js",
    reason: "Builds and validates full durable poll histories with repeated "
      + "fsync and concurrent publication. Four existing five-second windows "
      + "timed out under sibling-suite contention but passed unchanged with "
      + "an exclusive worker.",
  }),
  Object.freeze({
    file: "test/mcp-contract.test.js",
    reason: "Loads and compares both committed runtimes and exercises their MCP "
      + "contracts; sibling-suite contention exhausted an existing five-second "
      + "contract window that passed unchanged with an exclusive worker.",
  }),
  Object.freeze({
    file: "test/pdfjs-worker-contract.test.js",
    reason: "Exercises PDF.js worker lifecycle and process teardown; sibling-"
      + "suite contention exhausted its existing five-second contract windows, "
      + "while the unchanged suite passed with an exclusive worker.",
  }),
  Object.freeze({
    file: "test/read-pdf-layout.test.js",
    reason: "Exercises repeated real PDF.js layout, geometry, and encrypted-PDF "
      + "MCP paths; sibling-suite contention exhausted three existing five-"
      + "second windows that passed unchanged with an exclusive worker.",
  }),
]);

export const SERIAL_RESOURCE_TEST_FILES = Object.freeze(
  SERIAL_RESOURCE_TEST_SUITES.map(suite => suite.file),
);

export const SERIAL_NATIVE_TEST_SUITES = Object.freeze([
  Object.freeze({
    file: "test/pdfjs-subprocess-boundary.test.js",
    reason: "Exercises the embedded Electron worker boundary and real macOS "
      + "system renderer inside bounded test windows; sibling-worker load can "
      + "delay those operations past Vitest's generic timeout and leave the "
      + "shared in-process queue occupied for following assertions.",
  }),
  Object.freeze({
    file: "test/eval/docling-macos-supervisor.test.js",
    reason: "Races real process lifetimes against the supervisor's sealed 20ms "
      + "sampling-revalidation budget; sibling-worker scheduler starvation can "
      + "delay the first sample past a candidate child's lifetime, so the "
      + "suite must have the host to itself.",
  }),
]);

export const SERIAL_NATIVE_TEST_FILES = Object.freeze(
  SERIAL_NATIVE_TEST_SUITES.map(suite => suite.file),
);
