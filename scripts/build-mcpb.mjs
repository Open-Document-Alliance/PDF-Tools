#!/usr/bin/env node

import {
  closeSync,
  copyFileSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readFileSync,
  readSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from "fs";
import { randomUUID } from "crypto";
import { tmpdir } from "os";
import path from "path";
import { fileURLToPath } from "url";
import { spawnSync } from "child_process";
import { verifyInstalledBuildToolchain } from "./build-toolchain.mjs";
import {
  assertSafeArchivePath,
  buildExpectedFileManifest,
  activateCanonicalCandidateAtomic,
  createCanonicalZip,
  McpbPostActivationDurabilityError,
  sha256Bytes,
  verifyCanonicalZip,
  writeCanonicalBytesAtomic,
} from "./mcpb-archive.mjs";
import {
  isForbiddenArchivePath,
  PDFJS_EXCLUDED_DIRECTORIES,
  VERIFIED_EXTRACTION_RUNTIME_FILES,
} from "./mcpb-packaging-policy.mjs";
import {
  QPDF_WASM_RUNTIME_ASSETS,
  QPDF_WASM_RUNTIME_BINARY,
  QPDF_WASM_RUNTIME_DIRECTORY,
  QPDF_WASM_RUNTIME_ENTRY_POINT,
  QPDF_WASM_RUNTIME_FILES,
  verifyQpdfWasmRuntime,
} from "./qpdf-wasm-runtime.mjs";
import { generateCycloneDxSbom } from "../package-for-friend.js";
export { isForbiddenArchivePath } from "./mcpb-packaging-policy.mjs";
export { QPDF_WASM_RUNTIME_FILES } from "./qpdf-wasm-runtime.mjs";

import { SKILL_FILES } from "../server/skills.js";

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(SCRIPT_DIR, "..");
const CMAP_ORACLE_PROVENANCE = JSON.parse(readFileSync(
  path.join(REPO_ROOT, "test/fixtures/eval/extraction/oracles/layout-unijis-vertical.provenance.json"),
  "utf8",
));
const CMAP_ORACLE_ASSETS = CMAP_ORACLE_PROVENANCE.runtime_assets.files;
const DEFAULT_OUTPUT = path.join(REPO_ROOT, "pdf-toolkit-mcp.mcpb");
export const SBOM_FILENAME = "SBOM.cdx.json";
const MCPB_VERSION = "2.1.2";
const FFLATE_VERSION = "0.8.3";
const MCP_SERVER_VERSION = "2.0.0";
const MCP_CORE_VERSION = "2.0.0";
const MCP_V1_DEV_VERSION = "1.30.0";
const PROTECTED_PDFJS_VERSION = "5.4.624";
/*
 * Every module the production archive stages under `server/`. This is an
 * explicit allow-list rather than a directory walk so nothing untracked can
 * reach a shipped artifact, and `verifyStagedProductionGraph` asserts the
 * staged tree EQUALS it. That equality made an omission invisible: a module
 * left out of this list was simply absent from the archive, the staged tree
 * still matched the (short) list, the build passed, and the extension failed
 * at startup on an unresolvable import.
 * `test/packager-server-coverage.test.js` closes that hole by requiring this
 * list to be exactly the contents of `server/`.
 */
export const SERVER_FILES = [
  "accessibility-inspection.js",
  "bounded-pdf-file.js",
  "document-map.js",
  "helpers.js",
  "index.js",
  "layout-extraction.js",
  "lumin-oauth-loopback.js",
  "lumin-sign-v1-mapper.js",
  "lumin-sign-v1-operation.js",
  "lumin-sign-v1-transport.js",
  "lumin-signing-tools.js",
  "markdown-conversion.js",
  "markdown-output-transaction.js",
  "output-schemas.js",
  "pdf-comparison.js",
  "pdf-lib-rss-monitor.js",
  "pdf-lib-subprocess.js",
  "pdf-lib-worker.js",
  "pdf-observations.js",
  "pdfjs-subprocess.js",
  "pdfjs-worker.js",
  "qpdf-decrypt-worker.js",
  "qpdf-decrypt.js",
  "resource-uri.js",
  "skills.js",
  "stderr-suppression.js",
  "table-proposal-verification.js",
  "type3-cm-pk-reference.js",
  "type3-cm-reference.js",
  "verified-extraction-tools.js",
];
export { VERIFIED_EXTRACTION_RUNTIME_FILES } from "./mcpb-packaging-policy.mjs";
const FIRST_PARTY_TEXT_FILES = [
  ...SKILL_FILES,
  ...SERVER_FILES.map(filename => `server/${filename}`),
  ...VERIFIED_EXTRACTION_RUNTIME_FILES,
  "dist-ui/index.html",
  "LICENSE",
  "README.md",
  "manifest.mcpb.json",
];
export const NATIVE_TARGETS = [
  {
    packageName: "@napi-rs/canvas-darwin-arm64",
    binary: "skia.darwin-arm64.node",
    cpu: "arm64",
    os: "darwin",
  },
  {
    packageName: "@napi-rs/canvas-darwin-x64",
    binary: "skia.darwin-x64.node",
    cpu: "x64",
    os: "darwin",
  },
  {
    packageName: "@napi-rs/canvas-linux-x64-gnu",
    binary: "skia.linux-x64-gnu.node",
    cpu: "x64",
    os: "linux",
  },
  {
    packageName: "@napi-rs/canvas-win32-arm64-msvc",
    binary: "skia.win32-arm64-msvc.node",
    cpu: "arm64",
    os: "win32",
  },
  {
    packageName: "@napi-rs/canvas-win32-x64-msvc",
    binary: "skia.win32-x64-msvc.node",
    cpu: "x64",
    os: "win32",
  },
];
const CANVAS_PRODUCTION_NATIVE_ASSET_CONTRACTS = Object.freeze({
  "0.1.99": Object.freeze({
    auxiliaryAssets: Object.freeze({
      "@napi-rs/canvas-win32-x64-msvc": Object.freeze(["icudtl.dat"]),
    }),
    metadataFiles: Object.freeze({
      "@napi-rs/canvas-win32-arm64-msvc": Object.freeze([
        "package.json",
      ]),
    }),
  }),
});
const CANVAS_CANDIDATE_REGISTRY_ASSET_INVENTORIES = Object.freeze({
  "1.0.2": Object.freeze({
    compatibilityEvaluated: false,
    evidenceClassification:
      "PUBLIC_REGISTRY_ASSET_INVENTORY_ONLY_NOT_COMPATIBILITY_EVIDENCE",
    packages: Object.freeze(NATIVE_TARGETS.map(target => Object.freeze({
      packageName: target.packageName,
      assets: Object.freeze([
        target.binary,
        ...(target.os === "win32" ? ["icudtl.dat"] : []),
      ]),
    }))),
    productionAuthorized: false,
  }),
});
const STATIC_ARCHIVE_EVIDENCE_CLASSIFICATION =
  "STATIC_ARCHIVE_CONFORMANCE_NOT_NATIVE_EXECUTION_OR_HOST_EVIDENCE";
const DEFAULT_CANVAS_NATIVE_PACKAGE_METADATA_FILES = Object.freeze([
  "README.md",
  "package.json",
]);
const DEVELOPMENT_FILE_SUFFIXES = [".map", ".d.ts", ".d.mts", ".d.cts", ".tsbuildinfo"];

function run(command, args, { cwd = REPO_ROOT, capture = false } = {}) {
  const result = spawnSync(command, args, {
    cwd,
    encoding: "utf8",
    stdio: capture ? ["ignore", "pipe", "pipe"] : "inherit",
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    const detail = capture ? `\n${result.stderr || result.stdout}` : "";
    throw new Error(`${command} exited with status ${result.status}${detail}`);
  }
  return result.stdout;
}

export function assertRegularFirstPartyFile(rootDir, relativePath) {
  const absolutePath = path.join(rootDir, ...relativePath.split("/"));
  const metadata = lstatSync(absolutePath);
  if (metadata.isSymbolicLink() || !metadata.isFile()) {
    throw new Error(`First-party build input must be a regular file, not a link or special entry: ${relativePath}`);
  }
  return absolutePath;
}

export function scanFirstPartyInputs(rootDir = REPO_ROOT) {
  const inputs = [
    ...FIRST_PARTY_TEXT_FILES,
    "icon.png",
    "package.json",
    "package-lock.json",
  ];
  const secretFilename = /(?:^|\/)(?:\.env(?:\..*)?|id_(?:rsa|ecdsa|ed25519)|[^/]+\.(?:key|p12|pfx|pem))$/i;
  const secretContent = [
    [/-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/, "private key"],
    [/\bAKIA[0-9A-Z]{16}\b/, "AWS access key"],
    [/\bxox[baprs]-[A-Za-z0-9-]{20,}\b/, "Slack token"],
    [/\bgh[pousr]_[A-Za-z0-9]{36,}\b/, "GitHub token"],
    [/\bAIza[0-9A-Za-z_-]{35}\b/, "Google API key"],
    [/\bsk-(?:proj-)?[A-Za-z0-9_-]{32,}\b/, "API secret key"],
  ];
  for (const relativePath of inputs) {
    const absolutePath = assertRegularFirstPartyFile(rootDir, relativePath);
    if (secretFilename.test(relativePath)) throw new Error(`Secret-like first-party filename: ${relativePath}`);
    if (relativePath === "icon.png") continue;
    const content = readFileSync(absolutePath, "utf8");
    for (const [pattern, kind] of secretContent) {
      if (pattern.test(content)) throw new Error(`Possible ${kind} in first-party build input: ${relativePath}`);
    }
  }
}

function copyRegularFile(sourceRelativePath, destinationRelativePath, stagingDir) {
  const source = assertRegularFirstPartyFile(REPO_ROOT, sourceRelativePath);
  const destination = path.join(stagingDir, ...destinationRelativePath.split("/"));
  mkdirSync(path.dirname(destination), { recursive: true });
  copyFileSync(source, destination);
}

function copyRuntimeSource(stagingDir) {
  scanFirstPartyInputs();
  for (const filename of SKILL_FILES) copyRegularFile(filename, filename, stagingDir);
  for (const filename of SERVER_FILES) copyRegularFile(`server/${filename}`, `server/${filename}`, stagingDir);
  for (const filename of VERIFIED_EXTRACTION_RUNTIME_FILES) {
    copyRegularFile(filename, filename, stagingDir);
  }
  copyRegularFile("dist-ui/index.html", "dist-ui/index.html", stagingDir);
  /*
   * The QPDF WebAssembly runtime is not first-party text, so it is bound by
   * the reproducible-build hash contract instead of the secret scanner. The
   * checkout is verified before anything is copied so a corrupted or
   * locally-patched vendor tree fails here, with the offending path, rather
   * than surfacing as a mismatched archive later.
   */
  verifyQpdfWasmRuntime(REPO_ROOT, "checkout");
  for (const relativePath of QPDF_WASM_RUNTIME_FILES) {
    copyRegularFile(relativePath, relativePath, stagingDir);
  }
  for (const filename of ["icon.png", "LICENSE", "README.md", "package-lock.json"]) {
    copyRegularFile(filename, filename, stagingDir);
  }
  const packageJson = JSON.parse(readFileSync(assertRegularFirstPartyFile(REPO_ROOT, "package.json"), "utf8"));
  const runtimePackageJson = {
    name: packageJson.name,
    version: packageJson.version,
    description: packageJson.description,
    type: packageJson.type,
    main: packageJson.main,
    license: packageJson.license,
    dependencies: packageJson.dependencies,
  };
  writeFileSync(path.join(stagingDir, "package.json"), `${JSON.stringify(runtimePackageJson, null, 2)}\n`);
  copyRegularFile("manifest.mcpb.json", "manifest.json", stagingDir);
}

export function verifyLockedTooling(repoRoot = REPO_ROOT) {
  const lock = JSON.parse(readFileSync(path.join(repoRoot, "package-lock.json"), "utf8"));
  const installedMcpb = JSON.parse(readFileSync(path.join(repoRoot, "node_modules/@anthropic-ai/mcpb/package.json"), "utf8"));
  const installedFflate = JSON.parse(readFileSync(path.join(repoRoot, "node_modules/fflate/package.json"), "utf8"));
  const installedMcpServer = JSON.parse(readFileSync(path.join(repoRoot, "node_modules/@modelcontextprotocol/server/package.json"), "utf8"));
  const installedMcpCore = JSON.parse(readFileSync(path.join(repoRoot, "node_modules/@modelcontextprotocol/core/package.json"), "utf8"));
  if (lock.packages?.["node_modules/@anthropic-ai/mcpb"]?.version !== MCPB_VERSION || installedMcpb.version !== MCPB_VERSION) {
    throw new Error(`Canonical build requires locked and installed @anthropic-ai/mcpb@${MCPB_VERSION}`);
  }
  if (
    lock.packages?.["node_modules/fflate"]?.version !== FFLATE_VERSION ||
    installedFflate.version !== FFLATE_VERSION ||
    installedMcpb.dependencies?.fflate !== "^0.8.2"
  ) {
    throw new Error(`Canonical build requires MCPB's locked and installed fflate@${FFLATE_VERSION}`);
  }
  if (lock.packages?.[""]?.dependencies?.["pdfjs-dist"] !== PROTECTED_PDFJS_VERSION) {
    throw new Error(`pdfjs-dist must remain exactly ${PROTECTED_PDFJS_VERSION}`);
  }
  if (
    lock.packages?.[""]?.dependencies?.["@modelcontextprotocol/server"] !== MCP_SERVER_VERSION ||
    lock.packages?.[""]?.devDependencies?.["@modelcontextprotocol/sdk"] !== MCP_V1_DEV_VERSION ||
    lock.packages?.["node_modules/@modelcontextprotocol/server"]?.version !== MCP_SERVER_VERSION ||
    lock.packages?.["node_modules/@modelcontextprotocol/core"]?.version !== MCP_CORE_VERSION ||
    installedMcpServer.version !== MCP_SERVER_VERSION ||
    installedMcpCore.version !== MCP_CORE_VERSION
  ) {
    throw new Error(
      `Canonical build requires production @modelcontextprotocol/server@${MCP_SERVER_VERSION} ` +
      `with @modelcontextprotocol/core@${MCP_CORE_VERSION} and dev-only SDK v1@${MCP_V1_DEV_VERSION}`,
    );
  }
  verifyCanvasLockGraph(lock);
}

function exactStringArray(value, expected) {
  return Array.isArray(value)
    && JSON.stringify(value) === JSON.stringify(expected);
}

function nonEmptyString(value) {
  return typeof value === "string" && value.trim().length > 0;
}

function validSha512Integrity(value) {
  if (!nonEmptyString(value)) return false;
  const match = /^sha512-([A-Za-z0-9+/]+={0,2})$/.exec(value);
  if (!match) return false;
  const digest = Buffer.from(match[1], "base64");
  return digest.length === 64
    && digest.toString("base64") === match[1];
}

function expectedRegistryTarball(packageName, version) {
  const basename = packageName.split("/").at(-1);
  return `https://registry.npmjs.org/${packageName}/-/${basename}-${version}.tgz`;
}

function assertCanonicalCaseUniquePaths(paths, label) {
  const foldedPaths = new Map();
  for (const relativePath of paths) {
    assertSafeArchivePath(relativePath);
    const folded = relativePath.toLowerCase();
    const previous = foldedPaths.get(folded);
    if (previous !== undefined && previous !== relativePath) {
      throw new Error(
        `${label} contains an ASCII case-fold path collision: ${previous}, ${relativePath}`,
      );
    }
    foldedPaths.set(folded, relativePath);
  }
}

function expectedCanvasPackagePaths() {
  return new Map([
    ["@napi-rs/canvas", "node_modules/@napi-rs/canvas"],
    ...NATIVE_TARGETS.map(target => [
      target.packageName,
      `node_modules/${target.packageName}`,
    ]),
  ]);
}

function verifyCanvasPackageIdentities(lockPackages) {
  const expectedPaths = expectedCanvasPackagePaths();
  const expectedByFoldedName = new Map(
    [...expectedPaths].map(([name, packagePath]) => [
      name.toLowerCase(),
      { name, packagePath },
    ]),
  );
  assertCanonicalCaseUniquePaths(
    Object.keys(lockPackages).filter(Boolean),
    "package-lock.json",
  );
  for (const [packagePath, entry] of Object.entries(lockPackages)) {
    if (!entry || typeof entry !== "object") continue;
    if (nonEmptyString(entry.name)) {
      const expected = expectedByFoldedName.get(entry.name.toLowerCase());
      if (
        expected
        && (
          entry.name !== expected.name
          || packagePath !== expected.packagePath
        )
      ) {
        throw new Error(
          `package-lock.json contains an aliased or noncanonical canvas package identity at ${packagePath}`,
        );
      }
    }
    for (const dependencyField of [
      "dependencies",
      "optionalDependencies",
      "peerDependencies",
      "devDependencies",
    ]) {
      const dependencies = entry[dependencyField];
      if (!dependencies || typeof dependencies !== "object") continue;
      for (const specification of Object.values(dependencies)) {
        if (
          typeof specification === "string"
          && /^npm:@napi-rs\/canvas(?:@|-)/i.test(specification)
        ) {
          throw new Error(
            "package-lock.json contains an npm alias to a canvas implementation or native package",
          );
        }
      }
    }
  }
  for (const [name, packagePath] of expectedPaths) {
    const foldedPath = packagePath.toLowerCase();
    for (const candidatePath of Object.keys(lockPackages)) {
      if (
        candidatePath.toLowerCase() === foldedPath
        && candidatePath !== packagePath
      ) {
        throw new Error(
          `package-lock.json contains a noncanonical path for ${name}`,
        );
      }
    }
  }
}

function nativeAssets(version, target) {
  const contract = CANVAS_PRODUCTION_NATIVE_ASSET_CONTRACTS[version];
  if (!contract) {
    throw new Error(
      `@napi-rs/canvas ${version || "(missing)"} production native asset contract is not reviewed`,
    );
  }
  return [
    target.binary,
    ...(contract.auxiliaryAssets[target.packageName] ?? []),
  ];
}

function nativePackageFiles(version, target) {
  const contract = CANVAS_PRODUCTION_NATIVE_ASSET_CONTRACTS[version];
  if (!contract) {
    throw new Error(
      `@napi-rs/canvas ${version || "(missing)"} production native package contract is not reviewed`,
    );
  }
  return [
    ...(contract.metadataFiles[target.packageName]
      ?? DEFAULT_CANVAS_NATIVE_PACKAGE_METADATA_FILES),
    ...nativeAssets(version, target),
  ];
}

export function canvasCandidateRegistryAssetInventory(version) {
  const inventory = CANVAS_CANDIDATE_REGISTRY_ASSET_INVENTORIES[version];
  if (!inventory) {
    throw new Error(
      `@napi-rs/canvas ${version || "(missing)"} has no candidate registry asset inventory`,
    );
  }
  return inventory;
}

export function staticArchiveConformanceEvidence(packagedNativeAssetPaths) {
  if (
    !Array.isArray(packagedNativeAssetPaths)
    || packagedNativeAssetPaths.some(value => !nonEmptyString(value))
  ) {
    throw new Error("Packaged native asset paths are invalid");
  }
  return {
    evidenceClassification: STATIC_ARCHIVE_EVIDENCE_CLASSIFICATION,
    packagedNativeAssetPaths: [...packagedNativeAssetPaths],
    nativeExecutionPerformed: false,
    crossArchitectureExecutionPerformed: false,
    claudeDesktopTested: false,
  };
}

function validateCanvasPolicy(policy) {
  if (
    !policy
    || typeof policy !== "object"
    || !nonEmptyString(policy.implementationVersion)
    || !Array.isArray(policy.packages)
    || policy.packages.length !== NATIVE_TARGETS.length
  ) {
    throw new Error("Native canvas policy is incomplete");
  }
  const packagesByName = new Map();
  for (const entry of policy.packages) {
    if (
      !entry
      || typeof entry !== "object"
      || !nonEmptyString(entry.packageName)
      || packagesByName.has(entry.packageName)
    ) {
      throw new Error("Native canvas policy has duplicate or invalid targets");
    }
    packagesByName.set(entry.packageName, entry);
  }
  for (const target of NATIVE_TARGETS) {
    const entry = packagesByName.get(target.packageName);
    const expectedAssets = nativeAssets(policy.implementationVersion, target);
    if (
      !entry
      || entry.binary !== target.binary
      || entry.os !== target.os
      || entry.cpu !== target.cpu
      || entry.version !== policy.implementationVersion
      || entry.resolved
        !== expectedRegistryTarball(target.packageName, entry.version)
      || !validSha512Integrity(entry.integrity)
      || !exactStringArray(entry.assets, expectedAssets)
    ) {
      throw new Error(
        `${target.packageName} native canvas policy does not match the reviewed contract`,
      );
    }
  }
  return policy;
}

export function verifyCanvasLockGraph(lock) {
  const lockPackages = lock?.packages;
  if (!lockPackages || typeof lockPackages !== "object") {
    throw new Error("package-lock.json does not contain a package graph");
  }
  verifyCanvasPackageIdentities(lockPackages);
  const packagePaths = Object.keys(lockPackages);
  const implementationPaths = packagePaths.filter(relativePath =>
    /(?:^|\/)node_modules\/@napi-rs\/canvas$/i.test(relativePath),
  );
  if (
    implementationPaths.length !== 1
    || implementationPaths[0] !== "node_modules/@napi-rs/canvas"
  ) {
    throw new Error(
      "package-lock.json must resolve exactly one canvas implementation at the root",
    );
  }
  const nestedCanvasPaths = packagePaths.filter(relativePath =>
    /\/node_modules\/@napi-rs\/canvas(?:$|-)/i.test(relativePath),
  );
  if (nestedCanvasPaths.length > 0) {
    throw new Error(
      `package-lock.json contains a nested canvas package: ${nestedCanvasPaths.join(", ")}`,
    );
  }
  const canvas = lockPackages[implementationPaths[0]];
  const rootDeclaration =
    lockPackages[""]?.dependencies?.["@napi-rs/canvas"];
  if (
    !nonEmptyString(canvas?.version)
    || !nonEmptyString(canvas.resolved)
    || !validSha512Integrity(canvas.integrity)
    || !canvas.optionalDependencies
    || !nonEmptyString(rootDeclaration)
  ) {
    throw new Error(
      "package-lock.json does not contain complete locked canvas metadata",
    );
  }
  const contract = CANVAS_PRODUCTION_NATIVE_ASSET_CONTRACTS[canvas.version];
  if (!contract) {
    throw new Error(
      `@napi-rs/canvas ${canvas.version} production native asset contract is not reviewed`,
    );
  }
  if (
    canvas.resolved
      !== expectedRegistryTarball("@napi-rs/canvas", canvas.version)
  ) {
    throw new Error(
      "package-lock.json canvas implementation has a noncanonical registry source",
    );
  }
  if (
    ![
      canvas.version,
      `^${canvas.version}`,
      `~${canvas.version}`,
    ].includes(rootDeclaration)
  ) {
    throw new Error(
      "package-lock.json root canvas declaration does not permit the reviewed implementation",
    );
  }
  const packages = NATIVE_TARGETS.map(target => {
    const entry = lockPackages[`node_modules/${target.packageName}`];
    const expectedVersion = canvas.optionalDependencies[target.packageName];
    if (
      !nonEmptyString(entry?.version)
      || !nonEmptyString(entry.resolved)
      || !validSha512Integrity(entry.integrity)
      || !nonEmptyString(expectedVersion)
    ) {
      throw new Error(`package-lock.json is missing complete metadata for ${target.packageName}`);
    }
    if (
      entry.resolved
        !== expectedRegistryTarball(target.packageName, entry.version)
    ) {
      throw new Error(
        `${target.packageName} has a noncanonical registry source`,
      );
    }
    if (
      entry.version !== expectedVersion
      || entry.version !== canvas.version
    ) {
      throw new Error(`${target.packageName} lock mismatch: ${entry.version} != ${expectedVersion}`);
    }
    if (
      entry.optional !== true
      || !exactStringArray(entry.os, [target.os])
      || !exactStringArray(entry.cpu, [target.cpu])
    ) {
      throw new Error(
        `${target.packageName} lock metadata has the wrong optional or platform disposition`,
      );
    }
    return {
      ...target,
      version: entry.version,
      resolved: entry.resolved,
      integrity: entry.integrity,
      assets: nativeAssets(canvas.version, target),
    };
  });
  return validateCanvasPolicy({
    implementationVersion: canvas.version,
    packages,
  });
}

function parseManifestPackageJson(file, label) {
  if (!file || file.size < 1 || !file.bytes) {
    throw new Error(`Staged native canvas package is missing ${label}`);
  }
  try {
    return JSON.parse(Buffer.from(file.bytes).toString("utf8"));
  } catch {
    throw new Error(`Staged native canvas package has invalid ${label}`);
  }
}

function verifyStagedCanvasPackageIdentities(files) {
  const expectedPaths = expectedCanvasPackagePaths();
  const expectedByFoldedName = new Map(
    [...expectedPaths].map(([name, packagePath]) => [
      name.toLowerCase(),
      { name, packageJsonPath: `${packagePath}/package.json` },
    ]),
  );
  const expectedByFoldedPath = new Map(
    [...expectedByFoldedName.values()].map(expected => [
      expected.packageJsonPath.toLowerCase(),
      expected,
    ]),
  );
  for (const file of files) {
    if (
      !/(?:^|\/)node_modules\/.+\/package\.json$/.test(file.path)
    ) {
      continue;
    }
    const packageJson = parseManifestPackageJson(
      file,
      `${file.path} package identity`,
    );
    const pathExpectation =
      expectedByFoldedPath.get(file.path.toLowerCase());
    if (
      pathExpectation
      && file.path !== pathExpectation.packageJsonPath
    ) {
      throw new Error(
        `Staged archive contains a noncanonical canvas package path: ${file.path}`,
      );
    }
    if (nonEmptyString(packageJson.name)) {
      const identityExpectation =
        expectedByFoldedName.get(packageJson.name.toLowerCase());
      if (
        identityExpectation
        && (
          packageJson.name !== identityExpectation.name
          || file.path !== identityExpectation.packageJsonPath
        )
      ) {
        throw new Error(
          `Staged archive contains an aliased or noncanonical canvas package identity at ${file.path}`,
        );
      }
    }
  }
}

export function verifyCanvasNativeStageManifest(files, policy) {
  if (!Array.isArray(files)) {
    throw new Error("Staged native canvas manifest or policy is invalid");
  }
  const validatedPolicy = validateCanvasPolicy(policy);
  const byPath = new Map();
  for (const file of files) {
    if (
      !file
      || typeof file.path !== "string"
      || !(Buffer.isBuffer(file.bytes) || file.bytes instanceof Uint8Array)
      || !Number.isSafeInteger(file.size)
      || file.size !== file.bytes.byteLength
      || (
        file.sha256 !== undefined
        && file.sha256 !== sha256Bytes(file.bytes)
      )
      || byPath.has(file.path)
    ) {
      throw new Error(
        "Staged native canvas manifest contains invalid bytes, metadata, or duplicate paths",
      );
    }
    byPath.set(file.path, file);
  }
  const paths = [...byPath.keys()];
  assertCanonicalCaseUniquePaths(paths, "Staged native canvas manifest");
  verifyStagedCanvasPackageIdentities(files);
  const implementationPackageJsonPaths = paths.filter(relativePath =>
    /(?:^|\/)node_modules\/@napi-rs\/canvas\/package\.json$/i.test(relativePath),
  );
  if (
    implementationPackageJsonPaths.length !== 1
    || implementationPackageJsonPaths[0]
      !== "node_modules/@napi-rs/canvas/package.json"
  ) {
    throw new Error(
      "Staged archive must contain exactly one canvas implementation at the root",
    );
  }
  const nestedCanvasPaths = paths.filter(relativePath =>
    /\/node_modules\/@napi-rs\/canvas(?:\/|-)/i.test(relativePath),
  );
  if (nestedCanvasPaths.length > 0) {
    throw new Error(
      `Staged archive contains a nested canvas package: ${nestedCanvasPaths.join(", ")}`,
    );
  }
  const stagedNativePackageNames = [...new Set(paths.flatMap(relativePath => {
    const match =
      /^node_modules\/@napi-rs\/(canvas-[^/]+)\//i.exec(relativePath);
    return match ? [`@napi-rs/${match[1]}`] : [];
  }))].sort();
  const expectedNativePackageNames = validatedPolicy.packages
    .map(target => target.packageName)
    .sort();
  if (
    JSON.stringify(stagedNativePackageNames)
      !== JSON.stringify(expectedNativePackageNames)
  ) {
    throw new Error(
      `Staged archive native canvas package inventory does not match the reviewed contract: ${stagedNativePackageNames.join(", ")}`,
    );
  }
  const implementationPackage = parseManifestPackageJson(
    byPath.get(implementationPackageJsonPaths[0]),
    "implementation package.json",
  );
  if (
    implementationPackage.name !== "@napi-rs/canvas"
    || implementationPackage.version !== validatedPolicy.implementationVersion
  ) {
    throw new Error(
      "Staged canvas implementation package identity does not match the lock",
    );
  }
  for (const target of validatedPolicy.packages) {
    const prefix = `node_modules/${target.packageName}/`;
    const packageJson = parseManifestPackageJson(
      byPath.get(`${prefix}package.json`),
      `${target.packageName} package.json`,
    );
    if (
      packageJson.name !== target.packageName
      || packageJson.version !== target.version
      || !exactStringArray(packageJson.os, [target.os])
      || !exactStringArray(packageJson.cpu, [target.cpu])
    ) {
      throw new Error(
        `${target.packageName} package identity or platform metadata does not match the lock`,
      );
    }
    const packageFiles = paths
      .filter(relativePath => relativePath.startsWith(prefix))
      .map(relativePath => relativePath.slice(prefix.length))
      .sort();
    const expectedPackageFiles = nativePackageFiles(
      validatedPolicy.implementationVersion,
      target,
    ).sort();
    if (
      JSON.stringify(packageFiles)
        !== JSON.stringify(expectedPackageFiles)
    ) {
      const unexpected = packageFiles.filter(filename =>
        !expectedPackageFiles.includes(filename),
      );
      if (unexpected.length > 0) {
        throw new Error(
          `${target.packageName} has an unexpected native canvas package payload: ${unexpected.join(", ")}`,
        );
      }
      throw new Error(
        `${target.packageName} is missing a required native canvas package file`,
      );
    }
    for (const asset of target.assets) {
      const file = byPath.get(`${prefix}${asset}`);
      if (!file) {
        throw new Error(
          `${target.packageName} is missing a required native canvas asset: ${asset}`,
        );
      }
      if (!Number.isSafeInteger(file.size) || file.size < 1) {
        throw new Error(
          `${target.packageName} has an empty native canvas asset: ${asset}`,
        );
      }
    }
  }
  return true;
}

function lockedCanvasPolicy() {
  const lock = JSON.parse(readFileSync(
    path.join(REPO_ROOT, "package-lock.json"),
    "utf8",
  ));
  return verifyCanvasLockGraph(lock);
}

function lockedNativePackages() {
  return lockedCanvasPolicy().packages;
}

function removeHostSelectedNativePackages(stagingDir) {
  const napiScope = path.join(stagingDir, "node_modules", "@napi-rs");
  if (!existsSync(napiScope)) return;
  for (const entry of readdirSync(napiScope)) {
    if (entry.startsWith("canvas-")) rmSync(path.join(napiScope, entry), { recursive: true, force: true });
  }
}

function installLockedNativePackages(stagingDir, downloadDir) {
  const npmCommand = process.platform === "win32" ? "npm.cmd" : "npm";
  const packages = lockedNativePackages();
  for (const target of packages) {
    const output = run(
      npmCommand,
      ["pack", `${target.packageName}@${target.version}`, "--json", "--pack-destination", downloadDir],
      { capture: true },
    );
    const [packed] = JSON.parse(output);
    if (!packed?.filename || packed.integrity !== target.integrity) {
      throw new Error(`Registry tarball integrity did not match package-lock.json for ${target.packageName}`);
    }
    const destination = path.join(stagingDir, "node_modules", ...target.packageName.split("/"));
    mkdirSync(destination, { recursive: true });
    run("tar", ["-xzf", path.join(downloadDir, packed.filename), "--strip-components=1", "-C", destination]);
  }
  return packages;
}

export function trimStagedProductionGraph(stagingDir) {
  const pdfjsDir = path.join(stagingDir, "node_modules", "pdfjs-dist");
  for (const directory of PDFJS_EXCLUDED_DIRECTORIES) {
    rmSync(path.join(pdfjsDir, directory), { recursive: true, force: true });
  }
  rmSync(path.join(stagingDir, "package-lock.json"), { force: true });
  rmSync(path.join(stagingDir, "node_modules", ".package-lock.json"), { force: true });
  // Production command shims are not used by the Node entry point and npm
  // creates them as symlinks, which are deliberately forbidden in an MCPB.
  rmSync(path.join(stagingDir, "node_modules", ".bin"), { recursive: true, force: true });

  // MCPB's walker historically omitted declarations, source maps, and common
  // package-manager/editor metadata. Remove them from the stage itself so the
  // expected manifest describes exactly what the canonical writer receives.
  const removeDevelopmentArtifacts = directory => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const absolutePath = path.join(directory, entry.name);
      const isExcludedDirectory = entry.isDirectory() && [".cache", ".npm", ".yarn"].includes(entry.name);
      const isExcludedFile = !entry.isDirectory() && (
        DEVELOPMENT_FILE_SUFFIXES.some(suffix => entry.name.endsWith(suffix)) ||
        [".DS_Store", "Thumbs.db", ".gitignore", ".npmrc", ".yarnrc", "yarn.lock", "tsconfig.json"].includes(entry.name) ||
        entry.name.endsWith(".log") ||
        entry.name === ".env" ||
        entry.name.startsWith(".env.")
      );
      if (isExcludedDirectory || isExcludedFile) {
        rmSync(absolutePath, { recursive: true, force: true });
      } else if (entry.isDirectory()) {
        removeDevelopmentArtifacts(absolutePath);
      }
    }
  };
  removeDevelopmentArtifacts(stagingDir);
}

/**
 * Writes the CycloneDX bill of materials for the staged production payload.
 *
 * The MCPB used to ship no SBOM at all — only the Cursor share ZIP carried
 * one — even though it is the primary artifact and carries the same npm graph
 * and the same compiled-from-source WebAssembly runtime. It is generated by
 * the same generator the share ZIP uses, from the reviewed root lock reduced
 * to the production graph `npm ci --omit=dev` actually staged, so the two
 * artifacts cannot describe different bills.
 */
/**
 * Every locked package path that is actually inside the staged archive, read
 * off the staged tree rather than assumed from the lock. The MCPB is the one
 * artifact that carries an installed `node_modules`, so it is the one artifact
 * whose bill can say which components are genuinely present — and it does not
 * carry all of them: six of the eleven `@napi-rs/canvas-*` targets are
 * deliberately dropped, and marking those `optional` alongside the five that
 * ship told a reader nothing about which was which.
 */
export function stagedPackagePaths(stagingDir, relativeRoot = "node_modules") {
  const directory = path.join(stagingDir, ...relativeRoot.split("/"));
  if (!existsSync(directory)) return new Set();
  const paths = new Set();
  const collect = packagePath => {
    if (existsSync(path.join(stagingDir, ...packagePath.split("/"), "package.json"))) {
      paths.add(packagePath);
    }
    for (const nested of stagedPackagePaths(stagingDir, `${packagePath}/node_modules`)) {
      paths.add(nested);
    }
  };
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    if (!entry.isDirectory() || entry.name.startsWith(".")) continue;
    if (entry.name.startsWith("@")) {
      for (const scoped of readdirSync(path.join(directory, entry.name), { withFileTypes: true })) {
        if (scoped.isDirectory()) collect(`${relativeRoot}/${entry.name}/${scoped.name}`);
      }
      continue;
    }
    collect(`${relativeRoot}/${entry.name}`);
  }
  return paths;
}

function writeStagedSbom(stagingDir) {
  const rootLock = JSON.parse(readFileSync(path.join(REPO_ROOT, "package-lock.json"), "utf8"));
  const productionLock = {
    ...rootLock,
    packages: Object.fromEntries(
      Object.entries(rootLock.packages)
        .filter(([packagePath, lockedPackage]) => packagePath === "" || lockedPackage.dev !== true),
    ),
  };
  const stagedPackage = JSON.parse(readFileSync(path.join(stagingDir, "package.json"), "utf8"));
  const installedPackagePaths = stagedPackagePaths(stagingDir);
  const unknown = [...installedPackagePaths]
    .filter(packagePath => !productionLock.packages[packagePath])
    .sort();
  if (unknown.length > 0) {
    throw new Error(`Staged MCPB carries packages the reviewed production lock does not name: ${unknown.join(", ")}`);
  }
  const sbom = generateCycloneDxSbom(productionLock, stagedPackage, { installedPackagePaths });
  writeFileSync(path.join(stagingDir, SBOM_FILENAME), `${JSON.stringify(sbom, null, 2)}\n`);
  return sbom;
}

function verifyStagedProductionGraph(stagingDir, packages) {
  const expected = buildExpectedFileManifest(stagingDir);
  const paths = expected.map(file => file.path);
  const archivedServerFiles = paths
    .filter(filename => filename.startsWith("server/"))
    .map(filename => filename.slice("server/".length));
  if (JSON.stringify(archivedServerFiles) !== JSON.stringify(SERVER_FILES)) {
    throw new Error(`Staged server inventory mismatch: ${archivedServerFiles.join(", ")}`);
  }
  const archivedVerifiedExtractionFiles = paths
    .filter(filename => filename.startsWith("scripts/"))
    .filter(filename => VERIFIED_EXTRACTION_RUNTIME_FILES.includes(filename));
  if (JSON.stringify(archivedVerifiedExtractionFiles)
    !== JSON.stringify(VERIFIED_EXTRACTION_RUNTIME_FILES)) {
    throw new Error(`Staged verified-extraction inventory mismatch: ${archivedVerifiedExtractionFiles.join(", ")}`);
  }
  const uiFiles = paths.filter(filename => filename.startsWith("dist-ui/"));
  if (JSON.stringify(uiFiles) !== JSON.stringify(["dist-ui/index.html"])) {
    throw new Error(`Staged UI inventory mismatch: ${uiFiles.join(", ")}`);
  }
  /*
   * The staged QPDF WASM runtime must be the whole reviewed directory and
   * nothing else. Verified against the staged tree, not against the checkout,
   * because the archive is written from the stage.
   */
  const stagedQpdfWasmFiles = paths.filter(filename =>
    filename.startsWith(`${QPDF_WASM_RUNTIME_DIRECTORY}/`),
  );
  if (JSON.stringify([...stagedQpdfWasmFiles].sort()) !== JSON.stringify([...QPDF_WASM_RUNTIME_FILES].sort())) {
    throw new Error(`Staged QPDF WASM runtime inventory mismatch: ${stagedQpdfWasmFiles.join(", ")}`);
  }
  const stagedVendorFiles = paths.filter(filename => filename.startsWith("vendor/"));
  if (JSON.stringify([...stagedVendorFiles].sort()) !== JSON.stringify([...QPDF_WASM_RUNTIME_FILES].sort())) {
    throw new Error(`Staged vendor inventory carries unreviewed files: ${stagedVendorFiles.join(", ")}`);
  }
  verifyQpdfWasmRuntime(stagingDir, "staged MCPB");
  for (const required of [
    "manifest.json",
    "package.json",
    SBOM_FILENAME,
    "server/index.js",
    ...SKILL_FILES,
    ...VERIFIED_EXTRACTION_RUNTIME_FILES,
    "dist-ui/index.html",
    "node_modules/pdfjs-dist/legacy/build/pdf.mjs",
    "node_modules/pdfjs-dist/legacy/build/pdf.worker.mjs",
    ...CMAP_ORACLE_ASSETS.map(asset => asset.path),
    ...QPDF_WASM_RUNTIME_FILES,
  ]) {
    if (!paths.includes(required)) throw new Error(`Staged MCPB is missing required runtime file: ${required}`);
  }
  const expectedByPath = new Map(expected.map(file => [file.path, file]));
  for (const binding of CMAP_ORACLE_ASSETS) {
    const file = expectedByPath.get(binding.path);
    if (!file || file.size !== binding.size_bytes || file.sha256 !== binding.sha256) {
      throw new Error(`Staged MCPB PDF.js asset does not match oracle provenance: ${binding.path}`);
    }
  }
  // The manifest the canonical writer consumes, checked separately from the
  // staged bytes on disk, so a manifest that describes something other than
  // what was staged cannot reach the archive.
  for (const binding of QPDF_WASM_RUNTIME_ASSETS) {
    const file = expectedByPath.get(binding.path);
    if (!file || file.size !== binding.size_bytes || file.sha256 !== binding.sha256) {
      throw new Error(`Staged MCPB QPDF WASM asset does not match runtime provenance: ${binding.path}`);
    }
  }
  for (const filename of paths) {
    if (isForbiddenArchivePath(filename)) {
      throw new Error(`Staged MCPB contains forbidden entry: ${filename}`);
    }
    if (DEVELOPMENT_FILE_SUFFIXES.some(suffix => filename.endsWith(suffix))) {
      throw new Error(`Staged MCPB contains development-only metadata: ${filename}`);
    }
  }
  const packagedNativeAssetPaths = packages.flatMap(target =>
    target.assets.map(asset =>
      `node_modules/${target.packageName}/${asset}`,
    ),
  );
  for (const nativeAssetPath of packagedNativeAssetPaths) {
    const file = expected.find(entry => entry.path === nativeAssetPath);
    if (!file || file.size === 0) {
      throw new Error(
        `Required packaged native asset is missing or empty: ${nativeAssetPath}`,
      );
    }
  }
  const stagedNativePackages = readdirSync(path.join(stagingDir, "node_modules", "@napi-rs"))
    .filter(name => name.startsWith("canvas-"))
    .map(name => `@napi-rs/${name}`)
    .sort();
  const intendedNativePackages = packages.map(target => target.packageName).sort();
  if (JSON.stringify(stagedNativePackages) !== JSON.stringify(intendedNativePackages)) {
    throw new Error(`Unexpected native canvas package inventory: ${stagedNativePackages.join(", ")}`);
  }
  verifyCanvasNativeStageManifest(expected, {
    implementationVersion: packages[0]?.version,
    packages,
  });
  const runtimePackage = JSON.parse(readFileSync(path.join(stagingDir, "package.json"), "utf8"));
  if (runtimePackage.dependencies?.["pdfjs-dist"] !== PROTECTED_PDFJS_VERSION) {
    throw new Error(`Staged pdfjs-dist must remain exactly ${PROTECTED_PDFJS_VERSION}`);
  }
  if (
    runtimePackage.dependencies?.["@modelcontextprotocol/server"] !== MCP_SERVER_VERSION ||
    runtimePackage.dependencies?.["@modelcontextprotocol/sdk"] !== undefined
  ) {
    throw new Error(
      `Staged MCPB must use @modelcontextprotocol/server@${MCP_SERVER_VERSION} without the monolithic SDK`,
    );
  }
  const stagedMcpServer = JSON.parse(readFileSync(
    path.join(stagingDir, "node_modules/@modelcontextprotocol/server/package.json"),
    "utf8",
  ));
  const stagedMcpCore = JSON.parse(readFileSync(
    path.join(stagingDir, "node_modules/@modelcontextprotocol/core/package.json"),
    "utf8",
  ));
  if (
    stagedMcpServer.version !== MCP_SERVER_VERSION ||
    stagedMcpCore.version !== MCP_CORE_VERSION
  ) {
    throw new Error(
      `Staged MCPB requires exact server/core ${MCP_SERVER_VERSION}/${MCP_CORE_VERSION}`,
    );
  }
  return { expected, packagedNativeAssetPaths };
}

// Exported so the Agent Plugins bundle can reuse the identical staging —
// locked deps, verified native packages, secret scan, symlink ban — instead of
// a second, drifting implementation. Behaviour is unchanged for the MCPB build.
export function prepareCleanStage() {
  const stagingDir = mkdtempSync(path.join(tmpdir(), "pdf-tools-mcpb-"));
  const downloadDir = path.join(stagingDir, ".native-packages");
  const npmCommand = process.platform === "win32" ? "npm.cmd" : "npm";
  const mcpbCommand = path.join(REPO_ROOT, "node_modules", ".bin", process.platform === "win32" ? "mcpb.cmd" : "mcpb");
  try {
    run(npmCommand, ["run", "build:ui"]);
    copyRuntimeSource(stagingDir);
    run(npmCommand, ["ci", "--omit=dev", "--ignore-scripts", "--no-audit", "--no-fund"], { cwd: stagingDir });
    removeHostSelectedNativePackages(stagingDir);
    mkdirSync(downloadDir, { recursive: true });
    const packages = installLockedNativePackages(stagingDir, downloadDir);
    rmSync(downloadDir, { recursive: true, force: true });
    trimStagedProductionGraph(stagingDir);
    writeStagedSbom(stagingDir);
    run(mcpbCommand, ["validate", path.join(stagingDir, "manifest.json")]);
    return { stagingDir, ...verifyStagedProductionGraph(stagingDir, packages) };
  } catch (error) {
    rmSync(stagingDir, { recursive: true, force: true });
    throw error;
  }
}

function filesAreByteIdentical(firstPath, secondPath) {
  if (statSync(firstPath).size !== statSync(secondPath).size) return false;
  const first = openSync(firstPath, "r");
  const second = openSync(secondPath, "r");
  const firstBuffer = Buffer.allocUnsafe(1024 * 1024);
  const secondBuffer = Buffer.allocUnsafe(1024 * 1024);
  try {
    while (true) {
      const firstRead = readSync(first, firstBuffer, 0, firstBuffer.length, null);
      const secondRead = readSync(second, secondBuffer, 0, secondBuffer.length, null);
      if (firstRead !== secondRead) return false;
      if (firstRead === 0) return true;
      if (!firstBuffer.subarray(0, firstRead).equals(secondBuffer.subarray(0, secondRead))) return false;
    }
  } finally {
    closeSync(first);
    closeSync(second);
  }
}

function runSingleBuild(candidatePath) {
  verifyInstalledBuildToolchain(REPO_ROOT);
  verifyLockedTooling();
  let build;
  try {
    build = prepareCleanStage();
    const archive = createCanonicalZip(build.expected);
    verifyCanonicalZip(archive, build.expected);
    const fileCount = build.expected.length;
    for (const file of build.expected) file.bytes = undefined;
    const result = writeCanonicalBytesAtomic({
      bytes: archive,
      expectedFiles: build.expected,
      outputPath: candidatePath,
      canonicalVerified: true,
    });
    const evidence = {
      ...result,
      files: fileCount,
      ...staticArchiveConformanceEvidence(
        build.packagedNativeAssetPaths,
      ),
      peakRssKiB: process.resourceUsage().maxRSS,
    };
    console.log(`MCPB_BUILD_RESULT ${JSON.stringify(evidence)}`);
  } finally {
    if (build) rmSync(build.stagingDir, { recursive: true, force: true });
  }
}

function runBuildChild(candidatePath, buildNumber) {
  console.log(`\nPreparing clean MCPB build ${buildNumber}/2 in an isolated process...`);
  const result = spawnSync(process.execPath, [fileURLToPath(import.meta.url), "--build-once", candidatePath], {
    cwd: REPO_ROOT,
    encoding: "utf8",
    maxBuffer: 20 * 1024 * 1024,
  });
  if (result.stdout) process.stdout.write(result.stdout);
  if (result.stderr) process.stderr.write(result.stderr);
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`Isolated MCPB build ${buildNumber} exited with status ${result.status}`);
  const match = result.stdout.match(/^MCPB_BUILD_RESULT (.+)$/m);
  if (!match) throw new Error(`Isolated MCPB build ${buildNumber} did not report evidence`);
  return JSON.parse(match[1]);
}

function verifyCandidateWithPinnedMcpb(candidatePath) {
  const mcpbCommand = path.join(REPO_ROOT, "node_modules", ".bin", process.platform === "win32" ? "mcpb.cmd" : "mcpb");
  run(mcpbCommand, ["info", candidatePath], { capture: true });
  const unpackRoot = mkdtempSync(path.join(tmpdir(), "pdf-tools-mcpb-unpack-"));
  const unpacked = path.join(unpackRoot, "extension");
  try {
    run(mcpbCommand, ["unpack", candidatePath, unpacked], { capture: true });
    const canvasPolicy = lockedCanvasPolicy();
    for (const required of [
      "manifest.json",
      "server/index.js",
      "dist-ui/index.html",
      QPDF_WASM_RUNTIME_ENTRY_POINT,
      QPDF_WASM_RUNTIME_BINARY,
      ...canvasPolicy.packages.flatMap(target =>
        target.assets.map(asset =>
          `node_modules/${target.packageName}/${asset}`,
        ),
      ),
    ]) {
      const filename = path.join(unpacked, ...required.split("/"));
      if (!existsSync(filename) || !lstatSync(filename).isFile()) {
        throw new Error(`Pinned MCPB unpack is missing required file: ${required}`);
      }
    }
    /*
     * Round-tripping the archive is the only place that proves the runtime a
     * host will actually load is the reviewed one. An artifact that is present
     * but truncated, or reassembled with a different compression path, fails
     * here rather than at first use.
     */
    verifyQpdfWasmRuntime(unpacked, "unpacked MCPB");
    verifyCanvasNativeStageManifest(
      buildExpectedFileManifest(unpacked),
      canvasPolicy,
    );
  } finally {
    rmSync(unpackRoot, { recursive: true, force: true });
  }

  const externalUnzip = spawnSync("unzip", ["-tqq", candidatePath], { encoding: "utf8" });
  if (externalUnzip.error?.code === "ENOENT") {
    console.warn("Additional external unzip integrity check skipped: unzip is not installed");
  } else if (externalUnzip.error) {
    throw externalUnzip.error;
  } else if (externalUnzip.status !== 0) {
    throw new Error(`Additional external unzip integrity check failed: ${externalUnzip.stderr || externalUnzip.stdout}`);
  }
}

async function main() {
  if (process.argv[2] === "--build-once") {
    runSingleBuild(path.resolve(process.argv[3]));
    return;
  }
  const outputPath = path.resolve(process.argv[2] || DEFAULT_OUTPUT);
  const outputDirectory = path.dirname(outputPath);
  mkdirSync(outputDirectory, { recursive: true });
  verifyInstalledBuildToolchain(REPO_ROOT);
  verifyLockedTooling();
  const candidatePaths = [1, 2].map(number =>
    path.join(outputDirectory, `.${path.basename(outputPath)}.repro-${number}-${process.pid}-${randomUUID()}`),
  );
  let activated = false;
  try {
    const first = runBuildChild(candidatePaths[0], 1);
    const second = runBuildChild(candidatePaths[1], 2);
    if (
      first.sha256 !== second.sha256 ||
      first.bytes !== second.bytes ||
      first.files !== second.files ||
      first.evidenceClassification !== STATIC_ARCHIVE_EVIDENCE_CLASSIFICATION ||
      second.evidenceClassification !== STATIC_ARCHIVE_EVIDENCE_CLASSIFICATION ||
      first.nativeExecutionPerformed !== false ||
      second.nativeExecutionPerformed !== false ||
      first.claudeDesktopTested !== false ||
      second.claudeDesktopTested !== false ||
      JSON.stringify(first.packagedNativeAssetPaths)
        !== JSON.stringify(second.packagedNativeAssetPaths) ||
      !filesAreByteIdentical(candidatePaths[0], candidatePaths[1])
    ) {
      throw new Error(`Clean MCPB builds were not byte-identical: ${first.sha256} != ${second.sha256}`);
    }
    verifyCandidateWithPinnedMcpb(candidatePaths[1]);
    const result = activateCanonicalCandidateAtomic({
      candidatePath: candidatePaths[1],
      outputPath,
      expectedSha256: second.sha256,
      expectedBytes: second.bytes,
    });
    if (!result.activated || result.sha256 !== second.sha256 || result.bytes !== second.bytes) {
      throw new McpbPostActivationDurabilityError(
        "Activated MCPB result does not match the verified second build",
        {
          cause: new Error(`Expected ${second.bytes} bytes/${second.sha256}; found ${result.bytes} bytes/${result.sha256}`),
          outputPath,
          sha256: result.sha256,
          bytes: result.bytes,
        },
      );
    }
    activated = true;
    console.log(
      "\nVerified packaged native asset paths (static; not executed):",
    );
    for (const nativeAssetPath of second.packagedNativeAssetPaths) {
      console.log(`- ${nativeAssetPath}`);
    }
    console.log(`\nArtifact: ${outputPath}`);
    console.log(`Files: ${second.files}`);
    console.log(`Bytes: ${result.bytes}`);
    console.log(`SHA-256: ${result.sha256}`);
    console.log(`Peak isolated-build RSS: ${Math.max(first.peakRssKiB, second.peakRssKiB)} KiB`);
    console.log("Reproducibility: two clean isolated builds were byte-identical");
    console.log("Consumer verification: pinned MCPB info and unpack passed");
  } finally {
    rmSync(candidatePaths[0], { force: true });
    if (!activated) rmSync(candidatePaths[1], { force: true });
  }
}

if (path.resolve(process.argv[1] || "") === fileURLToPath(import.meta.url)) {
  main().catch(error => {
    if (error?.activated === true) {
      console.error(
        `MCPB activation durability failure: activated=true output=${error.outputPath} ` +
        `bytes=${error.bytes} sha256=${error.sha256}: ${error.message}`,
      );
    } else {
      console.error(`MCPB build failed: ${error.message}`);
    }
    process.exitCode = 1;
  });
}
