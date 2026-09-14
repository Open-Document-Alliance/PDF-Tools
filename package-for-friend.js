#!/usr/bin/env node

import { execFileSync } from "child_process";
import { createHash } from "crypto";
import { promises as fs } from "fs";
import os from "os";
import path from "path";
import { fileURLToPath } from "url";
import {
  QPDF_WASM_RUNTIME_FILES,
  verifyQpdfWasmRuntime,
} from "./scripts/qpdf-wasm-runtime.mjs";
import {
  QPDF_WASM_BUILD_TOOL_COMPONENT,
  QPDF_WASM_RUNTIME_COMPONENT_BOM_REF,
  QPDF_WASM_SBOM_COMPONENTS,
  QPDF_WASM_SBOM_DEPENDENCIES,
} from "./scripts/qpdf-wasm-sbom.mjs";
import {
  deriveNpmComponentLicensing,
  licenseEntryForDeclaredString,
  verifyNpmLicenseProvenanceCoverage,
} from "./scripts/npm-license-provenance.mjs";
export { QPDF_WASM_RUNTIME_FILES } from "./scripts/qpdf-wasm-runtime.mjs";
export {
  QPDF_WASM_RUNTIME_COMPONENT_BOM_REF,
  QPDF_WASM_SBOM_COMPONENTS,
} from "./scripts/qpdf-wasm-sbom.mjs";

const SCRIPT_PATH = fileURLToPath(import.meta.url);
const PROJECT_ROOT = path.dirname(SCRIPT_PATH);
const SOURCE_DIRNAME = "pdf-toolkit-mcp-share";
const SOURCE_DIR = path.join(PROJECT_ROOT, SOURCE_DIRNAME);
const OUTPUT_FILE = path.join(PROJECT_ROOT, "pdf-toolkit-mcp.zip");
const ARCHIVE_EPOCH = new Date("1980-01-01T00:00:00.000Z");
const SBOM_FILENAME = "SBOM.cdx.json";
const PROVENANCE_FILENAME = "SHARE-PROVENANCE.json";
/*
 * Every path the share archive carries. The `server/` entries are also the
 * only list of server modules the share bundle is copied from — see
 * `SHARE_SERVER_FILES` below — so a new module under `server/` has exactly one
 * place to be added here, and `test/packager-server-coverage.test.js` fails
 * until it is. Omitting one used to ship a bundle whose entry point could not
 * resolve its own imports.
 */
import { SKILL_FILES } from "./server/skill-files.js";

export const SHARE_FILES = [
  ...SKILL_FILES,
  "README.md",
  "configure-cursor.sh",
  "dist-ui/index.html",
  "install-transactional.sh",
  "install.command",
  "install.sh",
  "package-lock.json",
  "package.json",
  "server/accessibility-inspection.js",
  "server/bounded-pdf-file.js",
  "server/document-map.js",
  "server/helpers.js",
  "server/index.js",
  "server/layout-extraction.js",
  "server/lumin-oauth-loopback.js",
  "server/lumin-sign-v1-mapper.js",
  "server/lumin-sign-v1-operation.js",
  "server/lumin-sign-v1-transport.js",
  "server/lumin-signing-tools.js",
  "server/markdown-conversion.js",
  "server/markdown-output-transaction.js",
  "server/output-schemas.js",
  "server/pdf-comparison.js",
  "server/pdf-observations.js",
  "server/pdf-lib-rss-monitor.js",
  "server/pdf-lib-subprocess.js",
  "server/pdf-lib-worker.js",
  "server/pdfjs-subprocess.js",
  "server/pdfjs-worker.js",
  "server/qpdf-decrypt-worker.js",
  "server/qpdf-decrypt.js",
  "server/resource-uri.js",
  "server/skill-files.js",
  "server/skills.js",
  "server/stderr-suppression.js",
  "server/table-proposal-verification.js",
  "server/type3-cm-pk-reference.js",
  "server/type3-cm-reference.js",
  "server/verified-extraction-tools.js",
  "scripts/eval-strict-json.mjs",
  "scripts/verified-extraction-proposal.mjs",
  "scripts/verified-extraction-workspace.mjs",
  "smart-install.sh",
  /*
   * The QPDF WebAssembly runtime and its complete notice directory, derived
   * from the committed provenance record rather than transcribed. It is
   * packaged and licence-complete, and `server/qpdf-decrypt.js` loads it to
   * decrypt password-protected documents.
   */
  ...QPDF_WASM_RUNTIME_FILES,
];
/**
 * The server modules the share bundle mirrors, derived from SHARE_FILES so the
 * copy step and the archive manifest can never name different sets.
 */
export const SHARE_SERVER_FILES = SHARE_FILES.filter(relativePath => relativePath.startsWith("server/"));
/**
 * Everything the share bundle copies verbatim out of this repository. The
 * share contract asserts byte parity for exactly these paths.
 */
export const SHARE_MIRRORED_FILES = [
  ...SKILL_FILES,
  ...SHARE_SERVER_FILES,
  "scripts/eval-strict-json.mjs",
  "scripts/verified-extraction-proposal.mjs",
  "scripts/verified-extraction-workspace.mjs",
  "dist-ui/index.html",
  ...QPDF_WASM_RUNTIME_FILES,
];
const EXECUTABLE_SHARE_FILES = new Set([
  "configure-cursor.sh",
  "install-transactional.sh",
  "install.command",
  "install.sh",
  "server/index.js",
  "smart-install.sh",
]);

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

function compareCodePoints(left, right) {
  return left < right ? -1 : left > right ? 1 : 0;
}

function canonicalArchiveMode(relativePath) {
  return EXECUTABLE_SHARE_FILES.has(relativePath) ? 0o755 : 0o644;
}

function canonicalize(value) {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.keys(value).sort(compareCodePoints).map(key => [key, canonicalize(value[key])]),
    );
  }
  return value;
}

function sameJson(left, right) {
  return JSON.stringify(canonicalize(left)) === JSON.stringify(canonicalize(right));
}

function packageNameFromLockPath(packagePath) {
  const nestedMarker = "/node_modules/";
  const nestedIndex = packagePath.lastIndexOf(nestedMarker);
  return nestedIndex >= 0
    ? packagePath.slice(nestedIndex + nestedMarker.length)
    : packagePath.replace(/^node_modules\//, "");
}

function packagePurl(name, version) {
  const encodedName = name.split("/").map(segment => encodeURIComponent(segment)).join("/");
  return `pkg:npm/${encodedName}@${encodeURIComponent(version)}`;
}

function packageBomRef(packagePath) {
  return `urn:pdf-tools:npm-lock:${sha256(packagePath).slice(0, 32)}`;
}

function deterministicUuid(seed) {
  // RFC 4122 UUIDv5 using the standard URL namespace. The seed is the locked
  // graph digest, so identical reviewed graphs get identical SBOM identities.
  const namespace = Buffer.from("6ba7b8119dad11d180b400c04fd430c8", "hex");
  const bytes = createHash("sha1").update(namespace).update(seed).digest().subarray(0, 16);
  bytes[6] = (bytes[6] & 0x0f) | 0x50;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = bytes.toString("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

function integrityHash(integrity) {
  const match = /^(sha(?:1|256|384|512))-([A-Za-z0-9+/=]+)$/.exec(integrity || "");
  if (!match) throw new Error(`Unsupported npm integrity value: ${integrity}`);
  const algorithm = match[1].toUpperCase().replace(/^SHA(\d+)$/, "SHA-$1");
  return { alg: algorithm, content: Buffer.from(match[2], "base64").toString("hex") };
}

function resolveDependencyPath(packages, packagePath, dependencyName) {
  let base = packagePath;
  while (base) {
    const candidate = `${base}/node_modules/${dependencyName}`;
    if (packages[candidate]) return candidate;
    const parentIndex = base.lastIndexOf("/node_modules/");
    if (parentIndex < 0) break;
    base = base.slice(0, parentIndex);
  }
  const rootCandidate = `node_modules/${dependencyName}`;
  return packages[rootCandidate] ? rootCandidate : null;
}

function dependencyPathsForPackage(lock, packagePath) {
  const lockedPackage = lock.packages[packagePath];
  const names = new Set([
    ...Object.keys(lockedPackage.dependencies || {}),
    ...Object.keys(lockedPackage.optionalDependencies || {}),
    ...Object.keys(lockedPackage.peerDependencies || {}),
  ]);
  const paths = [];
  for (const dependencyName of [...names].sort(compareCodePoints)) {
    const resolvedPath = resolveDependencyPath(lock.packages, packagePath, dependencyName);
    if (resolvedPath) {
      paths.push(resolvedPath);
      continue;
    }
    const isOptional = dependencyName in (lockedPackage.optionalDependencies || {}) ||
      lockedPackage.peerDependenciesMeta?.[dependencyName]?.optional === true;
    if (!isOptional) {
      throw new Error(`Locked dependency ${dependencyName} required by ${packagePath || "root"} is missing.`);
    }
  }
  return [...new Set(paths)].sort(compareCodePoints);
}

/**
 * What the application itself directly requires: its locked npm dependencies,
 * plus the QPDF WebAssembly runtime, which is not an npm package but does ship
 * inside both artifacts and is loaded by `server/qpdf-decrypt-worker.js`.
 */
function rootDependsOn(lock) {
  return [
    ...dependencyPathsForPackage(lock, "").map(packageBomRef),
    QPDF_WASM_RUNTIME_COMPONENT_BOM_REF,
  ];
}

/**
 * One npm component, licence and all. Built in exactly one place so that
 * `validateCycloneDxSbom` can re-derive it from the same pinned records and
 * compare, rather than re-listing the fields it expects to find.
 */
function npmComponent(packagePath, lockedPackage, installedPackagePaths) {
  const name = packageNameFromLockPath(packagePath);
  const { scope, basis } = componentScope(packagePath, lockedPackage, installedPackagePaths);
  const { licenses, properties: licenseProperties } =
    deriveNpmComponentLicensing(name, lockedPackage.version);
  const properties = [
    { name: "pdf-tools:npm-package-path", value: packagePath },
    { name: "pdf-tools:npm-scope-basis", value: basis },
  ];
  if (lockedPackage.optional) {
    properties.push({ name: "pdf-tools:npm-optional-dependency", value: "true" });
  }
  if (lockedPackage.os) {
    properties.push({ name: "pdf-tools:npm-os", value: JSON.stringify(lockedPackage.os) });
  }
  if (lockedPackage.cpu) {
    properties.push({ name: "pdf-tools:npm-cpu", value: JSON.stringify(lockedPackage.cpu) });
  }
  return {
    type: "library",
    "bom-ref": packageBomRef(packagePath),
    name,
    version: lockedPackage.version,
    scope,
    hashes: [integrityHash(lockedPackage.integrity)],
    purl: packagePurl(name, lockedPackage.version),
    licenses,
    externalReferences: [{ type: "distribution", url: lockedPackage.resolved }],
    properties: [...properties, ...licenseProperties],
  };
}

/*
 * CycloneDX `scope` is a statement about the artifact the bill describes, not
 * about the lockfile, and the two shipped artifacts differ:
 *
 *   - The MCPB carries an installed `node_modules` inside it, so it can say
 *     precisely which components are present. Anything staged is `required` —
 *     CycloneDX reserves `optional` for code that is "not capable of being
 *     called due to it not being installed", which is false of a package that
 *     ships inside the archive. Anything the lock names but the archive does
 *     not carry is `excluded`, which is the construct the specification
 *     provides for a component documented but not reachable at runtime. Before
 *     this, the MCPB's bill marked all eleven `@napi-rs/canvas-*` targets
 *     `optional` because the lockfile said so, while five of them were
 *     physically inside the archive and six were not there at all: it
 *     understated the code that ships and overstated the code that does not.
 *
 *   - The share ZIP carries no `node_modules`; it ships a lockfile that `npm
 *     ci` resolves on the user's machine. Its bill describes an install
 *     specification, so npm's own optionality is exactly the right statement
 *     and is kept.
 *
 * Either way the basis is written into the component, so nobody has to guess
 * which reading applies.
 */
function componentScope(packagePath, lockedPackage, installedPackagePaths) {
  if (!installedPackagePaths) {
    return {
      scope: lockedPackage.optional ? "optional" : "required",
      basis: lockedPackage.optional
        ? "npm optionalDependency in the lockfile this artifact ships; the artifact contains no "
          + "installed tree, so presence is decided by `npm ci` on the target machine"
        : "required by the lockfile this artifact ships; the artifact contains no installed tree, so "
          + "the package is installed by `npm ci` on the target machine",
    };
  }
  return installedPackagePaths.has(packagePath)
    ? {
      scope: "required",
      basis: "installed inside this artifact at the recorded package path",
    }
    : {
      scope: "excluded",
      basis: "named by the reviewed lockfile but deliberately not carried inside this artifact, so it "
        + "is documented rather than claimed as shipped code",
    };
}

/*
 * The bill is assembled from three pinned records, none of them written down
 * here. The npm components come from `package-lock.json`;
 * their licence terms come from
 * `vendor/npm-licenses/npm-license-provenance.json`; the native components
 * come from `vendor/qpdf-wasm/runtime.provenance.json` by way of
 * `scripts/qpdf-wasm-sbom.mjs`. None of it is written down here, because a
 * hand-maintained component list drifts from its lock the first time anyone
 * bumps a version — which is exactly how the QPDF WebAssembly runtime came to
 * ship with notices, hashes and provenance but no SBOM component at all, and
 * how seventy of a hundred and twelve npm components came to ship with no
 * licence at all.
 *
 * @param {object} lock the locked graph the bill describes
 * @param {object} sharePackage the manifest of the application being described
 * @param {{ installedPackagePaths?: Set<string> }} [options] the lock package
 *   paths actually present inside the artifact, when the artifact carries an
 *   installed tree. Omitted for the share ZIP, which ships a lockfile instead.
 */
export function generateCycloneDxSbom(lock, sharePackage, options = {}) {
  const { installedPackagePaths } = options;
  /*
   * Fails before anything is written if the committed licence evidence does
   * not cover the locked graph exactly. A dependency added, removed or bumped
   * without the evidence following stops the build here rather than producing
   * a component that says nothing about its terms.
   */
  verifyNpmLicenseProvenanceCoverage(lock);
  const rootRef = `pkg:npm/${encodeURIComponent(sharePackage.name)}@${encodeURIComponent(sharePackage.version)}`;
  const packageEntries = Object.entries(lock.packages)
    .filter(([packagePath]) => packagePath !== "")
    .sort(([left], [right]) => compareCodePoints(left, right));
  const components = packageEntries.map(([packagePath, lockedPackage]) =>
    npmComponent(packagePath, lockedPackage, installedPackagePaths));
  const dependencies = [
    {
      ref: rootRef,
      dependsOn: rootDependsOn(lock),
    },
    ...packageEntries.map(([packagePath]) => ({
      ref: packageBomRef(packagePath),
      dependsOn: dependencyPathsForPackage(lock, packagePath).map(packageBomRef),
    })),
    ...QPDF_WASM_SBOM_DEPENDENCIES.map(entry => ({ ref: entry.ref, dependsOn: [...entry.dependsOn] })),
  ];
  /*
   * The identity seed is the reviewed graph plus the artifact inventory the
   * bill describes, so the MCPB's bill — which says which components are
   * physically inside it — cannot carry the same serial number as the share
   * ZIP's, which describes an install specification. Identical inputs still
   * produce identical identities.
   */
  const inventoryDigest = installedPackagePaths
    ? sha256([...installedPackagePaths].sort(compareCodePoints).join("\n"))
    : "install-specification";
  const lockDigest = sha256(`${JSON.stringify(lock)}\n${inventoryDigest}\n`);
  const sbom = {
    $schema: "http://cyclonedx.org/schema/bom-1.6.schema.json",
    bomFormat: "CycloneDX",
    specVersion: "1.6",
    serialNumber: `urn:uuid:${deterministicUuid(lockDigest)}`,
    version: 1,
    metadata: {
      component: {
        type: "application",
        "bom-ref": rootRef,
        name: sharePackage.name,
        version: sharePackage.version,
        purl: rootRef,
        // Routed through the same classifier the dependencies use, so the
        // application's own licence is asserted as an SPDX identifier only if
        // the pinned SPDX list actually contains it.
        licenses: [licenseEntryForDeclaredString(sharePackage.license).entry],
      },
      properties: [
        {
          name: "pdf-tools:evidence-validation",
          value: "deterministic structural, lock-coverage and native-provenance-coverage validation",
        },
      ],
      /*
       * The Emscripten build image belongs here rather than in `components`:
       * it produced the WebAssembly runtime but is not inside any shipped
       * artifact. Its statically linked runtime libraries are components; the
       * compiler is not.
       */
      tools: { components: [QPDF_WASM_BUILD_TOOL_COMPONENT] },
    },
    components: [...components, ...QPDF_WASM_SBOM_COMPONENTS],
    dependencies,
  };
  validateCycloneDxSbom(sbom, lock, sharePackage, options);
  return sbom;
}

export function validateCycloneDxSbom(sbom, lock, sharePackage, options = {}) {
  const { installedPackagePaths } = options;
  verifyNpmLicenseProvenanceCoverage(lock);
  if (sbom.$schema !== "http://cyclonedx.org/schema/bom-1.6.schema.json" ||
      sbom.bomFormat !== "CycloneDX" || sbom.specVersion !== "1.6" || sbom.version !== 1) {
    throw new Error("SBOM is not structurally identified as CycloneDX 1.6 JSON.");
  }
  if (sbom.metadata?.component?.name !== sharePackage.name ||
      sbom.metadata?.component?.version !== sharePackage.version) {
    throw new Error("SBOM metadata component does not match the share package.");
  }

  const packagePaths = Object.keys(lock.packages)
    .filter(packagePath => packagePath !== "")
    .sort(compareCodePoints);
  /*
   * The expected total is the npm graph plus the native graph, each counted
   * from its own pinned record. Neither number is written down.
   */
  const expectedComponentCount = packagePaths.length + QPDF_WASM_SBOM_COMPONENTS.length;
  if (sbom.components?.length !== expectedComponentCount) {
    throw new Error(`SBOM component coverage mismatch: ${sbom.components?.length} != ${expectedComponentCount}.`);
  }
  const componentsByRef = new Map(sbom.components.map(component => [component["bom-ref"], component]));
  if (componentsByRef.size !== expectedComponentCount) {
    throw new Error("SBOM contains duplicate component references.");
  }

  for (const nativeComponent of QPDF_WASM_SBOM_COMPONENTS) {
    const component = componentsByRef.get(nativeComponent["bom-ref"]);
    if (!component || !sameJson(component, nativeComponent)) {
      throw new Error(
        `SBOM native component does not exactly cover ${nativeComponent["bom-ref"]}. `
        + "Regenerate it from vendor/qpdf-wasm/runtime.provenance.json rather than editing it.",
      );
    }
  }
  if (!sameJson(sbom.metadata?.tools?.components, [QPDF_WASM_BUILD_TOOL_COMPONENT])) {
    throw new Error("SBOM does not record the pinned QPDF WebAssembly build toolchain as build tooling.");
  }

  for (const packagePath of packagePaths) {
    const lockedPackage = lock.packages[packagePath];
    const component = componentsByRef.get(packageBomRef(packagePath));
    /*
     * Re-derived from the lock and the committed licence evidence rather than
     * spot-checked field by field. A field-by-field check can only ever assert
     * the fields somebody remembered to list, and the licence half is exactly
     * the half that went unlisted for as long as it was missing.
     */
    if (!component || !sameJson(component, npmComponent(packagePath, lockedPackage, installedPackagePaths))) {
      throw new Error(`SBOM component does not exactly cover ${packagePath}.`);
    }
  }

  /*
   * No component may be silent about its terms. A package that declares no
   * licence still carries an explicit NOASSERTION and a property saying what
   * was looked for, so an empty `licenses` array can only mean the generator
   * skipped the question.
   */
  for (const component of sbom.components) {
    if (!Array.isArray(component.licenses) || component.licenses.length === 0) {
      throw new Error(`SBOM component states no licence at all: ${component["bom-ref"]}.`);
    }
  }
  if (!Array.isArray(sbom.metadata?.component?.licenses) || sbom.metadata.component.licenses.length === 0) {
    throw new Error("SBOM metadata component states no licence at all.");
  }

  const rootRef = sbom.metadata.component["bom-ref"];
  const dependencyEntries = new Map((sbom.dependencies || []).map(entry => [entry.ref, entry.dependsOn]));
  if (dependencyEntries.size !== expectedComponentCount + 1) {
    throw new Error("SBOM dependency graph does not cover the root and every locked component exactly once.");
  }
  /*
   * Native components hang off the runtime that ships them, not off the root,
   * so the graph says what is inside what rather than listing them loose
   * beside the npm packages.
   */
  const expectedEdges = [
    { ref: rootRef, label: "root", dependsOn: rootDependsOn(lock) },
    ...packagePaths.map(packagePath => ({
      ref: packageBomRef(packagePath),
      label: packagePath,
      dependsOn: dependencyPathsForPackage(lock, packagePath).map(packageBomRef),
    })),
    ...QPDF_WASM_SBOM_DEPENDENCIES.map(entry => ({
      ref: entry.ref,
      label: entry.ref,
      dependsOn: entry.dependsOn,
    })),
  ];
  for (const { ref, label, dependsOn: expected } of expectedEdges) {
    const actual = dependencyEntries.get(ref);
    if (!actual || !sameJson(
      [...actual].sort(compareCodePoints),
      [...expected].sort(compareCodePoints),
    )) {
      throw new Error(`SBOM dependency edges do not exactly cover ${label}.`);
    }
    for (const dependencyRef of actual) {
      if (!componentsByRef.has(dependencyRef)) {
        throw new Error(`SBOM dependency edge references an unknown component: ${dependencyRef}.`);
      }
    }
  }
  return true;
}

export async function verifyShareLock(sharePackage, rootLock, sourceDir = SOURCE_DIR) {
  const lockPath = path.join(sourceDir, "package-lock.json");
  let lock;
  try {
    lock = JSON.parse(await fs.readFile(lockPath, "utf8"));
  } catch (error) {
    throw new Error(
      `A valid ${SOURCE_DIRNAME}/package-lock.json is required for reproducible installs: ${error.message}`,
    );
  }

  const lockedRoot = lock.packages?.[""];
  if (lock.lockfileVersion !== 3 || !lockedRoot) {
    throw new Error("Share package lock must use npm lockfileVersion 3 and include its root package record.");
  }

  for (const key of ["name", "version", "license", "engines", "dependencies"]) {
    if (!sameJson(lockedRoot[key], sharePackage[key])) {
      throw new Error(
        `${SOURCE_DIRNAME}/package-lock.json is stale at packages[\"\"].${key}. ` +
          "Seed it from the reviewed root lock and prune it to the share manifest.",
      );
    }
  }

  const sharePackagePaths = Object.keys(lock.packages)
    .filter(packagePath => packagePath !== "")
    .sort(compareCodePoints);
  const rootProductionPackagePaths = Object.entries(rootLock.packages || {})
    .filter(([packagePath, lockedPackage]) => packagePath !== "" && lockedPackage.dev !== true)
    .map(([packagePath]) => packagePath)
    .sort(compareCodePoints);
  if (!sameJson(sharePackagePaths, rootProductionPackagePaths)) {
    const shareSet = new Set(sharePackagePaths);
    const rootSet = new Set(rootProductionPackagePaths);
    const missing = rootProductionPackagePaths.filter(packagePath => !shareSet.has(packagePath));
    const extra = sharePackagePaths.filter(packagePath => !rootSet.has(packagePath));
    throw new Error(
      `Share lock package-path coverage differs from the reviewed root production graph; ` +
        `missing=${JSON.stringify(missing)}, extra=${JSON.stringify(extra)}.`,
    );
  }

  for (const [packagePath, lockedPackage] of Object.entries(lock.packages)) {
    if (packagePath === "") continue;
    if (lockedPackage.dev === true) {
      throw new Error(`Share production lock unexpectedly contains a dev-only package: ${packagePath}.`);
    }
    if (!lockedPackage.version || !lockedPackage.resolved || !lockedPackage.integrity) {
      throw new Error(`Share lock lacks complete registry provenance for ${packagePath}.`);
    }
    const rootLockedPackage = rootLock.packages?.[packagePath];
    if (!rootLockedPackage) throw new Error(`Share lock package is absent from the reviewed root lock: ${packagePath}.`);
    if (!sameJson(lockedPackage, rootLockedPackage)) {
      throw new Error(
        `Share lock record drifted from the reviewed root lock for ${packagePath}; ` +
          `share=${JSON.stringify(canonicalize(lockedPackage))}, ` +
          `root=${JSON.stringify(canonicalize(rootLockedPackage))}.`,
      );
    }
  }

  if (lock.packages["node_modules/pdfjs-dist"]?.version !== "5.4.624") {
    throw new Error("Share lock does not preserve pdfjs-dist@5.4.624.");
  }
  return lock;
}

async function syncSharePackage() {
  const rootPackage = JSON.parse(await fs.readFile(path.join(PROJECT_ROOT, "package.json"), "utf8"));
  const rootLock = JSON.parse(await fs.readFile(path.join(PROJECT_ROOT, "package-lock.json"), "utf8"));
  const sharePackagePath = path.join(SOURCE_DIR, "package.json");
  const shareServerDir = path.join(SOURCE_DIR, "server");
  const shareUiDir = path.join(SOURCE_DIR, "dist-ui");

  await fs.mkdir(shareServerDir, { recursive: true });
  await fs.mkdir(shareUiDir, { recursive: true });
  try {
    await fs.access(path.join(PROJECT_ROOT, "dist-ui", "index.html"));
  } catch {
    throw new Error("dist-ui/index.html is missing. Run `npm run build:ui` before packaging the share bundle.");
  }
  /*
   * Mirrored verbatim from SHARE_MIRRORED_FILES rather than from a second
   * hand-written list. The two used to be maintained separately, and a server
   * module added to one but not the other produced a bundle whose entry point
   * could not resolve its own imports.
   */
  verifyQpdfWasmRuntime(PROJECT_ROOT, "checkout");
  await Promise.all(SHARE_MIRRORED_FILES.map(async relativePath => {
    const target = path.join(SOURCE_DIR, ...relativePath.split("/"));
    await fs.mkdir(path.dirname(target), { recursive: true });
    await fs.copyFile(path.join(PROJECT_ROOT, ...relativePath.split("/")), target);
  }));
  verifyQpdfWasmRuntime(SOURCE_DIR, "share source tree");

  const sharePackage = {
    name: rootPackage.name,
    version: rootPackage.version,
    description: "PDF Tools MCP server for Cursor and other stdio MCP hosts",
    type: "module",
    main: "server/index.js",
    license: rootPackage.license,
    engines: rootPackage.engines,
    dependencies: {
      "@modelcontextprotocol/server": rootPackage.dependencies["@modelcontextprotocol/server"],
      "yaml": rootPackage.dependencies["yaml"],
      "@napi-rs/canvas": rootPackage.dependencies["@napi-rs/canvas"],
      "pdf-lib": rootPackage.dependencies["pdf-lib"],
      "pdfjs-dist": rootPackage.dependencies["pdfjs-dist"],
    },
  };
  if (sharePackage.dependencies["pdfjs-dist"] !== "5.4.624") {
    throw new Error("Refusing to package an unreviewed pdfjs-dist version; expected exact pin 5.4.624.");
  }
  await fs.writeFile(sharePackagePath, `${JSON.stringify(sharePackage, null, 2)}\n`);
  const shareLock = await verifyShareLock(sharePackage, rootLock);
  return { sharePackage, shareLock };
}

async function stageSharePackage(stageRoot, sharePackage, shareLock) {
  const stagedPackageRoot = path.join(stageRoot, SOURCE_DIRNAME);
  const fileHashes = {};
  for (const relativePath of SHARE_FILES) {
    const sourcePath = path.join(SOURCE_DIR, relativePath);
    const targetPath = path.join(stagedPackageRoot, relativePath);
    const sourceStat = await fs.stat(sourcePath);
    if (!sourceStat.isFile()) throw new Error(`Expected a regular share-package file: ${relativePath}`);
    await fs.mkdir(path.dirname(targetPath), { recursive: true });
    await fs.copyFile(sourcePath, targetPath);
    await fs.chmod(targetPath, canonicalArchiveMode(relativePath));
    fileHashes[relativePath] = sha256(await fs.readFile(targetPath));
  }
  // What the ZIP is built from, checked against the reproducible-build hash
  // contract rather than against another copy of the same file list.
  verifyQpdfWasmRuntime(stagedPackageRoot, "staged share package");

  const sbom = generateCycloneDxSbom(shareLock, sharePackage);
  const sbomPath = path.join(stagedPackageRoot, SBOM_FILENAME);
  await fs.writeFile(sbomPath, `${JSON.stringify(sbom, null, 2)}\n`);
  await fs.chmod(sbomPath, 0o644);
  const sbomBytes = await fs.readFile(sbomPath);
  fileHashes[SBOM_FILENAME] = sha256(sbomBytes);

  const lockBytes = await fs.readFile(path.join(stagedPackageRoot, "package-lock.json"));
  const provenance = {
    schema_version: "1.1",
    package: { name: sharePackage.name, version: sharePackage.version },
    dependency_lock: {
      path: "package-lock.json",
      lockfile_version: 3,
      sha256: sha256(lockBytes),
    },
    sbom: {
      path: SBOM_FILENAME,
      format: "CycloneDX",
      spec_version: "1.6",
      validation: "deterministic structural checks, exact lock component/dependency coverage, and exact "
        + "coverage of the native components derived from vendor/qpdf-wasm/runtime.provenance.json; "
        + "not external schema validation",
      sha256: sha256(sbomBytes),
    },
    files: fileHashes,
  };
  const provenancePath = path.join(stagedPackageRoot, PROVENANCE_FILENAME);
  await fs.writeFile(provenancePath, `${JSON.stringify(provenance, null, 2)}\n`);
  await fs.chmod(provenancePath, 0o644);

  const archiveFiles = [...SHARE_FILES, SBOM_FILENAME, PROVENANCE_FILENAME]
    .map(relativePath => `${SOURCE_DIRNAME}/${relativePath}`)
    .sort(compareCodePoints);
  for (const archivePath of archiveFiles) {
    await fs.utimes(path.join(stageRoot, archivePath), ARCHIVE_EPOCH, ARCHIVE_EPOCH);
  }
  return { archiveFiles, provenance };
}

function validateArchive(candidatePath, archiveFiles, unzipCommand) {
  execFileSync(unzipCommand, ["-tqq", candidatePath], { stdio: "pipe" });
  const entries = execFileSync(unzipCommand, ["-Z1", candidatePath], { encoding: "utf8" })
    .split(/\r?\n/)
    .filter(Boolean)
    .sort(compareCodePoints);
  if (!sameJson(entries, [...archiveFiles].sort(compareCodePoints))) {
    throw new Error(`ZIP entry validation failed: ${JSON.stringify(entries)}.`);
  }
}

async function createArchive(stageRoot, archiveFiles, options) {
  const { outputFile, zipCommand, unzipCommand } = options;
  const candidateRoot = await fs.mkdtemp(
    path.join(path.dirname(outputFile), `.${path.basename(outputFile)}.candidate-`),
  );
  const candidatePath = path.join(candidateRoot, path.basename(outputFile));
  try {
    execFileSync(zipCommand, ["-X", "-q", candidatePath, "-@"], {
      cwd: stageRoot,
      env: { ...process.env, TZ: "UTC" },
      input: `${archiveFiles.join("\n")}\n`,
      stdio: ["pipe", "inherit", "inherit"],
    });
    validateArchive(candidatePath, archiveFiles, unzipCommand);
    await fs.rename(candidatePath, outputFile);
  } finally {
    await fs.rm(candidateRoot, { recursive: true, force: true });
  }
}

export async function createPackage(options = {}) {
  const outputFile = options.outputFile || OUTPUT_FILE;
  const zipCommand = options.zipCommand || "zip";
  const unzipCommand = options.unzipCommand || "unzip";
  console.log("📦 Creating reproducible share package for Cursor and other stdio MCP hosts...\n");
  try {
    await fs.access(SOURCE_DIR);
  } catch {
    throw new Error(`Directory '${SOURCE_DIRNAME}' not found at ${PROJECT_ROOT}.`);
  }

  const stageRoot = await fs.mkdtemp(path.join(os.tmpdir(), "pdf-tools-share-stage-"));
  try {
    console.log("🔄 Syncing runtime files, validating the full lock, and generating CycloneDX 1.6 SBOM...");
    const { sharePackage, shareLock } = await syncSharePackage();
    const { archiveFiles } = await stageSharePackage(stageRoot, sharePackage, shareLock);
    console.log(`📁 Building and validating atomic candidate for ${path.basename(outputFile)}...`);
    await createArchive(stageRoot, archiveFiles, { outputFile, zipCommand, unzipCommand });

    const bytes = await fs.readFile(outputFile);
    console.log("\n✅ Share package created successfully!");
    console.log(`📦 File: ${outputFile} (${(bytes.length / (1024 * 1024)).toFixed(2)} MB)`);
    console.log(`🔒 SHA-256: ${sha256(bytes)}`);
    console.log("🔁 Installers consume the shipped lock with `npm ci --omit=dev --engine-strict`.");
    return { outputFile, sha256: sha256(bytes), size: bytes.length, archiveFiles };
  } finally {
    await fs.rm(stageRoot, { recursive: true, force: true });
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === SCRIPT_PATH) {
  createPackage().catch(error => {
    console.error(`❌ Share-package build failed: ${error.message}`);
    process.exitCode = 1;
  });
}
