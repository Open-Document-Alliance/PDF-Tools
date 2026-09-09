#!/usr/bin/env node

import { createHash } from "crypto";
import {
  chmodSync,
  cpSync,
  copyFileSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  readdirSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "fs";
import { tmpdir } from "os";
import path from "path";
import { fileURLToPath, pathToFileURL } from "url";
import { spawnSync } from "child_process";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { readCentralDirectory } from "./mcpb-archive.mjs";
import {
  QPDF_WASM_RUNTIME_DIRECTORY,
  QPDF_WASM_RUNTIME_FILES,
  verifyQpdfWasmRuntime,
} from "./qpdf-wasm-runtime.mjs";
import { SHARE_MIRRORED_FILES } from "../package-for-friend.js";

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(SCRIPT_DIR, "..");
const CMAP_ORACLE_SOURCE = path.join(REPO_ROOT, "test/fixtures/eval/extraction/oracles/layout-unijis-vertical.pdf");
const CMAP_ORACLE_PROVENANCE = JSON.parse(readFileSync(
  path.join(REPO_ROOT, "test/fixtures/eval/extraction/oracles/layout-unijis-vertical.provenance.json"),
  "utf8",
));
const PROTECTED_DIRECT_DEPENDENCIES = {
  "@modelcontextprotocol/sdk": "1.30.0",
  "@napi-rs/canvas": "0.1.99",
  "pdf-lib": "1.17.1",
  "pdfjs-dist": "5.4.624",
};
const EXPECTED_SHARE_EXECUTABLES = new Set([
  "configure-cursor.sh",
  "install-transactional.sh",
  "install.command",
  "install.sh",
  "server/index.js",
  "smart-install.sh",
]);
const ISOLATED_PACKAGER_SCRIPT_SOURCES = Object.freeze([
  "scripts/eval-strict-json.mjs",
  "scripts/npm-license-provenance.mjs",
  "scripts/pdfium-runtime.mjs",
  "scripts/pdfium-sbom.mjs",
  "scripts/qpdf-wasm-runtime.mjs",
  "scripts/qpdf-wasm-sbom.mjs",
  "scripts/verified-extraction-proposal.mjs",
  "scripts/verified-extraction-workspace.mjs",
]);

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

function run(command, args, cwd, options = {}) {
  const result = spawnSync(command, args, {
    cwd,
    encoding: "utf8",
    stdio: "pipe",
    ...options,
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(`${command} ${args.join(" ")} exited ${result.status}: ${result.stderr || result.stdout}`);
  }
  return result.stdout;
}

function expectFailure(command, args, cwd, pattern, options = {}) {
  const result = spawnSync(command, args, {
    cwd,
    encoding: "utf8",
    stdio: "pipe",
    ...options,
  });
  if (result.error) throw result.error;
  const output = `${result.stdout || ""}\n${result.stderr || ""}`;
  if (result.status === 0 || !pattern.test(output)) {
    throw new Error(`${command} ${args.join(" ")} did not fail closed as expected: ${output}`);
  }
  return result;
}

/*
 * A second, independent reading of what the native half of the bill must look
 * like — taken from the files that shipped inside the archive rather than from
 * the generator that wrote the SBOM. For QPDF WASM: `BUILD-INPUTS.json` is the
 * pinned source set; `licenses/manifest.json` is every notice the runtime
 * redistributes. For PDFium: `runtime.provenance.json` contains all notices.
 * Between them they say which native code ships, so between them they say how
 * many components the SBOM owes and what each one must claim.
 */
function expectedNativeSbomShape(packageRoot) {
  // QPDF WASM runtime components
  const qpdfRuntimeDirectory = "vendor/qpdf-wasm/runtime";
  const readQpdfRuntimeJson = relativePath => JSON.parse(readFileSync(
    path.join(packageRoot, ...`${qpdfRuntimeDirectory}/${relativePath}`.split("/")),
    "utf8",
  ));
  const buildInputs = readQpdfRuntimeJson("BUILD-INPUTS.json");
  const noticeManifest = readQpdfRuntimeJson("licenses/manifest.json");
  const sourceKeys = new Set(buildInputs.sources.map(source => `${source.name} ${source.version}`));
  const sources = buildInputs.sources.map(source => ({
    name: source.name,
    version: source.version,
    sha256: source.sha256,
    url: source.url,
    spdx: noticeManifest.files.find(notice => notice.component === `${source.name} ${source.version}`)?.spdx,
  }));
  for (const source of sources) {
    if (!source.spdx) {
      throw new Error(`Shipped source ${source.name} ${source.version} has no licence notice in the archive`);
    }
  }
  /*
   * Every notice that is neither a pinned source's own notice nor a
   * supplementary notice for one describes code the Emscripten toolchain
   * linked into the artifact. That code ships, so it owes a component.
   */
  const toolchain = noticeManifest.files
    .filter(notice => {
      const supplementary = /^(.+?) (\d\S*) bundled-code notices$/.exec(notice.component);
      if (supplementary) return false;
      const primary = /^(.+?) (\d\S*)$/.exec(notice.component);
      return !(primary && sourceKeys.has(`${primary[1]} ${primary[2]}`));
    })
    .map(notice => ({ component: notice.component, spdx: notice.spdx }));
  if (toolchain.length === 0) {
    throw new Error("Shipped notice manifest describes no toolchain-linked code, which cannot be right");
  }
  return {
    sources,
    toolchain,
    // The pinned sources, the toolchain-linked libraries, and one component
    // for the runtime artifact they are all compiled into. PDFium is only in
    // the MCPB, not in the share package.
    componentCount: sources.length + toolchain.length + 1,
  };
}

function assertNativeSbomCoverage(sbom, expectation) {
  const byName = new Map(sbom.components.map(component => [`${component.name}@${component.version}`, component]));
  for (const source of expectation.sources) {
    const component = byName.get(`${source.name}@${source.version}`);
    if (!component) {
      throw new Error(`SBOM omits the shipped native source ${source.name} ${source.version}`);
    }
    assertEqual(
      component.licenses?.[0]?.expression,
      source.spdx,
      `SBOM licence for ${source.name} disagrees with the notice that shipped with it`,
    );
    if (!component.hashes?.some(hash => hash.alg === "SHA-256" && hash.content === source.sha256)) {
      throw new Error(`SBOM does not hash ${source.name} against its pinned source archive digest`);
    }
    if (!component.purl?.startsWith("pkg:")) {
      throw new Error(`SBOM component for ${source.name} carries no package URL`);
    }
  }
  const licenceExpressions = new Set(sbom.components.map(component => component.licenses?.[0]?.expression));
  for (const entry of expectation.toolchain) {
    if (!licenceExpressions.has(entry.spdx)) {
      throw new Error(`SBOM has no component carrying the shipped notice for ${entry.component}`);
    }
  }
  const runtime = sbom.components.find(component =>
    component.externalReferences?.some(reference => reference.url?.endsWith("/qpdf.wasm")));
  if (!runtime) throw new Error("SBOM has no component representing the shipped WebAssembly runtime");
  const runtimeRef = runtime["bom-ref"];
  const runtimeEdges = sbom.dependencies.find(entry => entry.ref === runtimeRef)?.dependsOn || [];
  if (runtimeEdges.length !== expectation.componentCount - 1) {
    throw new Error(
      `SBOM native components do not all hang off the runtime: ${runtimeEdges.length} edges for `
      + `${expectation.componentCount - 1} components`,
    );
  }
  const rootRef = sbom.metadata.component["bom-ref"];
  const rootEdges = sbom.dependencies.find(entry => entry.ref === rootRef)?.dependsOn || [];
  if (!rootEdges.includes(runtimeRef)) {
    throw new Error("SBOM does not attach the WebAssembly runtime to the application it ships inside");
  }
  const toolComponents = sbom.metadata?.tools?.components || [];
  if (!toolComponents.some(tool => tool.type === "container")) {
    throw new Error("SBOM does not record the pinned build image as build tooling");
  }
  const shippedRefs = new Set(sbom.components.map(component => component["bom-ref"]));
  for (const tool of toolComponents) {
    if (shippedRefs.has(tool["bom-ref"])) {
      throw new Error(`SBOM lists build tooling as a shipped component: ${tool["bom-ref"]}`);
    }
  }
}

/**
 * Every installed package path under a real `node_modules`, in the same form
 * `package-lock.json` uses, paired with the manifest that landed on disk.
 */
function installedPackageManifests(installRoot, relativeRoot = "node_modules") {
  const directory = path.join(installRoot, ...relativeRoot.split("/"));
  if (!existsSync(directory)) return new Map();
  const manifests = new Map();
  const collect = packagePath => {
    const manifestPath = path.join(installRoot, ...packagePath.split("/"), "package.json");
    if (existsSync(manifestPath)) {
      manifests.set(packagePath, JSON.parse(readFileSync(manifestPath, "utf8")));
    }
    for (const [nested, manifest] of installedPackageManifests(installRoot, `${packagePath}/node_modules`)) {
      manifests.set(nested, manifest);
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
  return manifests;
}

/*
 * The licence claims in the shipped bill, checked against the code that
 * actually landed on the user's machine.
 *
 * This deliberately does not call the derivation the generator used. It reads
 * each installed `package.json` and asserts that whatever that package says
 * about itself is the string the bill reports — as an SPDX identifier, as an
 * expression, or as a plain name, whichever the bill chose. The choice between
 * those three is the generator's job and is checked elsewhere; the thing that
 * matters here is that the bill did not attribute a licence to a package that
 * the package does not claim, and did not go quiet about one that has none.
 */
function assertShippedLicencesMatchInstalledTree(sbom, installRoot) {
  const componentsByPath = new Map();
  for (const component of sbom.components) {
    const packagePath = component.properties
      ?.find(property => property.name === "pdf-tools:npm-package-path")?.value;
    if (packagePath) componentsByPath.set(packagePath, component);
  }
  const installed = installedPackageManifests(installRoot);
  if (installed.size < 50) {
    throw new Error(`Installed share tree is too small to check licences against: ${installed.size} packages`);
  }
  let checked = 0;
  for (const [packagePath, manifest] of installed) {
    const component = componentsByPath.get(packagePath);
    if (!component) throw new Error(`Installed package has no SBOM component: ${packagePath}`);
    if (!Array.isArray(component.licenses) || component.licenses.length === 0) {
      throw new Error(`Shipped SBOM states no licence for installed package ${packagePath}`);
    }
    const reported = component.licenses.map(entry =>
      entry.expression ?? entry.license?.id ?? entry.license?.name);
    const declared = typeof manifest.license === "string" && manifest.license.trim() !== ""
      ? [manifest.license.trim()]
      : Array.isArray(manifest.licenses)
        ? manifest.licenses.map(entry => (typeof entry === "string" ? entry : entry?.type))
        : manifest.license?.type
          ? [manifest.license.type]
          : ["NOASSERTION"];
    if (JSON.stringify(reported) !== JSON.stringify(declared)) {
      throw new Error(
        `Shipped SBOM licence for ${packagePath} is not what the installed package declares: `
        + `${JSON.stringify(reported)} != ${JSON.stringify(declared)}`,
      );
    }
    checked += 1;
  }
  const noAssertion = sbom.components.filter(component =>
    component.licenses?.length === 1 && component.licenses[0].license?.name === "NOASSERTION").length;
  return { checked, noAssertion };
}

function walkFiles(root, relativeRoot = "") {
  const files = [];
  for (const entry of readdirSync(path.join(root, relativeRoot)).sort()) {
    const relativePath = path.posix.join(relativeRoot.split(path.sep).join(path.posix.sep), entry);
    const absolutePath = path.join(root, ...relativePath.split("/"));
    const stat = statSync(absolutePath);
    if (stat.isDirectory()) files.push(...walkFiles(root, relativePath));
    else if (stat.isFile()) files.push(relativePath);
    else throw new Error(`Unexpected non-file archive entry at ${relativePath}`);
  }
  return files;
}

function regularTreeFingerprint(root, relativeRoot = "") {
  const files = [];
  for (const entry of readdirSync(path.join(root, relativeRoot)).sort()) {
    const relativePath = path.posix.join(
      relativeRoot.split(path.sep).join(path.posix.sep),
      entry,
    );
    const filename = path.join(root, ...relativePath.split("/"));
    const stat = lstatSync(filename);
    if (stat.isDirectory()) {
      files.push(...regularTreeFingerprint(root, relativePath));
    } else if (stat.isFile() && stat.nlink === 1) {
      files.push({
        path: relativePath,
        executable: process.platform === "win32"
          ? null
          : (stat.mode & 0o111) !== 0,
        bytes: stat.size,
        sha256: sha256(readFileSync(filename)),
      });
    } else {
      throw new Error(
        `Reviewed share source contains a non-regular or multiply-linked entry: ${relativePath}`,
      );
    }
  }
  return files;
}

function populatePackageBuildRoot(buildRoot) {
  mkdirSync(buildRoot, { recursive: true });
  for (const filename of ["package-for-friend.js", "package.json", "package-lock.json"]) {
    copyFileSync(path.join(REPO_ROOT, filename), path.join(buildRoot, filename));
  }
  /*
   * The packager derives its QPDF WASM manifest from the committed provenance
   * and mirrors the runtime out of the checkout, so the isolated build root
   * has to carry both. Only the runtime and its provenance are copied, not the
   * whole recipe: `vendor/qpdf-wasm/sources/` holds fetched upstream tarballs
   * that are ignored by Git and irrelevant to packaging.
   */
  const isolatedScriptSources = new Set(ISOLATED_PACKAGER_SCRIPT_SOURCES);
  const missingMirroredScriptSources = SHARE_MIRRORED_FILES.filter(relativePath =>
    relativePath.startsWith("scripts/") && !isolatedScriptSources.has(relativePath));
  if (missingMirroredScriptSources.length > 0) {
    throw new Error(
      `Isolated package build root omits mirrored script sources: ${missingMirroredScriptSources.join(", ")}`,
    );
  }
  for (const relativePath of ISOLATED_PACKAGER_SCRIPT_SOURCES) {
    const destination = path.join(buildRoot, ...relativePath.split("/"));
    mkdirSync(path.dirname(destination), { recursive: true });
    copyFileSync(
      path.join(REPO_ROOT, ...relativePath.split("/")),
      destination,
    );
  }
  /*
   * The committed npm licence evidence and the pinned SPDX identifier list.
   * The build root still has no `node_modules` — that is the property this
   * contract exists to establish — so the licence half of the bill has to come
   * from committed records for exactly the same reason the native half does.
   */
  cpSync(
    path.join(REPO_ROOT, "vendor", "npm-licenses"),
    path.join(buildRoot, "vendor", "npm-licenses"),
    { recursive: true },
  );
  mkdirSync(path.join(buildRoot, "vendor", "qpdf-wasm"), { recursive: true });
  copyFileSync(
    path.join(REPO_ROOT, "vendor", "qpdf-wasm", "runtime.provenance.json"),
    path.join(buildRoot, "vendor", "qpdf-wasm", "runtime.provenance.json"),
  );
  cpSync(
    path.join(REPO_ROOT, "vendor", "qpdf-wasm", "runtime"),
    path.join(buildRoot, "vendor", "qpdf-wasm", "runtime"),
    { recursive: true },
  );
  for (const directory of ["server", "dist-ui", "pdf-toolkit-mcp-share"]) {
    cpSync(path.join(REPO_ROOT, directory), path.join(buildRoot, directory), { recursive: true });
  }
}

function forceTreeModeProfile(root, {
  directoryMode,
  executableMode,
  regularMode,
}) {
  const visit = directory => {
    for (const entry of readdirSync(directory).sort()) {
      const filename = path.join(directory, entry);
      const stat = lstatSync(filename);
      if (stat.isDirectory()) {
        visit(filename);
        chmodSync(filename, directoryMode);
      } else if (stat.isFile() && stat.nlink === 1) {
        chmodSync(
          filename,
          (stat.mode & 0o111) !== 0 ? executableMode : regularMode,
        );
      } else {
        throw new Error(
          `Package build root contains a non-regular or multiply-linked entry: ${filename}`,
        );
      }
    }
  };
  visit(root);
  chmodSync(root, directoryMode);
}

function assertShareModeProfile(root, {
  directoryMode,
  executableMode,
  regularMode,
}) {
  const visit = (directory, relativeRoot = "") => {
    assertEqual(
      lstatSync(directory).mode & 0o777,
      directoryMode,
      `Reviewed source directory mode drifted for ${relativeRoot || "."}`,
    );
    for (const entry of readdirSync(directory).sort()) {
      const relativePath = path.posix.join(
        relativeRoot.split(path.sep).join(path.posix.sep),
        entry,
      );
      const filename = path.join(directory, entry);
      const stat = lstatSync(filename);
      if (stat.isDirectory()) {
        visit(filename, relativePath);
        continue;
      }
      if (!stat.isFile() || stat.nlink !== 1) {
        throw new Error(
          `Reviewed share source contains a non-regular or multiply-linked entry: ${relativePath}`,
        );
      }
      const expectedExecutable = EXPECTED_SHARE_EXECUTABLES.has(relativePath);
      assertEqual(
        (stat.mode & 0o111) !== 0,
        expectedExecutable,
        `Reviewed executable classification drifted for ${relativePath}`,
      );
      assertEqual(
        stat.mode & 0o777,
        expectedExecutable ? executableMode : regularMode,
        `Reviewed source mode drifted for ${relativePath}`,
      );
    }
  };
  visit(root);
}

function runPackager(buildRoot, invocationUmask) {
  if (process.platform === "win32") {
    return run(process.execPath, ["package-for-friend.js"], buildRoot);
  }
  const previousUmask = process.umask(invocationUmask);
  try {
    return run(process.execPath, ["package-for-friend.js"], buildRoot);
  } finally {
    process.umask(previousUmask);
  }
}

function assertCanonicalArchiveModes(bytes) {
  if (process.platform === "win32") return;
  const prefix = "pdf-toolkit-mcp-share/";
  const entries = readCentralDirectory(bytes);
  for (const entry of entries) {
    if (!entry.path.startsWith(prefix)) {
      throw new Error(`Share ZIP contains an unexpected path: ${entry.path}`);
    }
    const relativePath = entry.path.slice(prefix.length);
    const expectedMode = EXPECTED_SHARE_EXECUTABLES.has(relativePath)
      ? 0o755
      : 0o644;
    assertEqual(entry.os, 3, `Share ZIP host metadata drifted for ${relativePath}`);
    assertEqual(
      entry.unixMode,
      0o100000 | expectedMode,
      `Share ZIP Unix mode drifted for ${relativePath}`,
    );
    assertEqual(
      entry.mode,
      expectedMode,
      `Share ZIP permission mode drifted for ${relativePath}`,
    );
  }
}

function assertEqual(actual, expected, message) {
  if (actual !== expected) throw new Error(`${message}: expected ${expected}, received ${actual}`);
}

function expectThrow(operation, pattern, message) {
  try {
    operation();
  } catch (error) {
    if (pattern.test(error.message)) return;
    throw new Error(`${message}: unexpected error: ${error.message}`);
  }
  throw new Error(`${message}: operation unexpectedly succeeded`);
}

function writeExecutable(filename, contents) {
  writeFileSync(filename, contents);
  chmodSync(filename, 0o755);
}

function populateNodeOnlyInstallerPath(directory, cwd) {
  mkdirSync(directory, { recursive: true });
  for (const command of ["bash", "basename", "chmod", "cp", "dirname", "grep", "mkdir", "mktemp", "mv", "node", "rm"]) {
    const executable = run("sh", ["-c", `command -v ${command}`], cwd).trim();
    symlinkSync(executable, path.join(directory, command));
  }
  writeExecutable(path.join(directory, "npm"), "#!/bin/bash\nexit 0\n");
  const pythonProbe = spawnSync("/bin/sh", ["-c", "command -v python3"], {
    env: { ...process.env, PATH: directory },
    encoding: "utf8",
  });
  if (pythonProbe.status === 0) throw new Error("Node-only installer PATH unexpectedly exposes python3");
}

function assertNoInstallerTemps(parent, targetName) {
  const leftovers = readdirSync(parent).filter(name =>
    name.startsWith(`${targetName}.stage.`) || name.startsWith(`${targetName}.backup.`));
  assertEqual(JSON.stringify(leftovers), "[]", "Transactional installer left temporary directories");
}

function testTransactionalFailurePaths(sourcePackageRoot, tempRoot) {
  if (process.platform === "win32") return;
  const installer = path.join(sourcePackageRoot, "install-transactional.sh");
  const realMv = run("sh", ["-c", "command -v mv"], tempRoot).trim();

  const failureHome = path.join(tempRoot, "installer-failure-home");
  const failureTarget = path.join(failureHome, ".pdf-tools-mcp");
  const failureBin = path.join(failureHome, "bin");
  mkdirSync(failureTarget, { recursive: true });
  mkdirSync(failureBin, { recursive: true });
  writeFileSync(path.join(failureTarget, "working-install.txt"), "known-good-before-npm-failure\n");
  writeExecutable(path.join(failureBin, "npm"), "#!/bin/bash\nexit 42\n");
  const failureEnvironment = {
    ...process.env,
    HOME: failureHome,
    PATH: `${failureBin}:${process.env.PATH}`,
  };
  expectFailure("bash", [path.join(sourcePackageRoot, "smart-install.sh")], tempRoot, /existing installation was not changed/, {
    env: failureEnvironment,
  });
  expectFailure("bash", [path.join(sourcePackageRoot, "install.command")], tempRoot, /existing installation was not changed/, {
    env: failureEnvironment,
    input: "\n",
  });
  expectFailure("bash", [installer, sourcePackageRoot, failureTarget], tempRoot, /existing installation was not changed/, {
    env: failureEnvironment,
  });
  assertEqual(
    readFileSync(path.join(failureTarget, "working-install.txt"), "utf8"),
    "known-good-before-npm-failure\n",
    "npm failure damaged the working installation",
  );
  assertNoInstallerTemps(failureHome, ".pdf-tools-mcp");

  const rollbackHome = path.join(tempRoot, "installer-rollback-home");
  const rollbackTarget = path.join(rollbackHome, ".pdf-tools-mcp");
  const rollbackBin = path.join(rollbackHome, "bin");
  const mvState = path.join(rollbackHome, "mv-state");
  mkdirSync(rollbackTarget, { recursive: true });
  mkdirSync(rollbackBin, { recursive: true });
  writeFileSync(path.join(rollbackTarget, "working-install.txt"), "known-good-before-swap-failure\n");
  writeExecutable(path.join(rollbackBin, "npm"), "#!/bin/bash\nexit 0\n");
  writeExecutable(path.join(rollbackBin, "mv"), `#!/bin/bash
count=0
if [ -f "$MV_TEST_STATE" ]; then count=$(<"$MV_TEST_STATE"); fi
count=$((count + 1))
echo "$count" > "$MV_TEST_STATE"
if [ "$count" -eq 2 ]; then exit 73; fi
exec ${JSON.stringify(realMv)} "$@"
`);
  expectFailure("bash", [installer, sourcePackageRoot, rollbackTarget], tempRoot, /attempting rollback/, {
    env: {
      ...process.env,
      HOME: rollbackHome,
      PATH: `${rollbackBin}:${process.env.PATH}`,
      MV_TEST_STATE: mvState,
    },
  });
  assertEqual(readFileSync(mvState, "utf8").trim(), "3", "Swap-failure proof did not execute rollback move");
  assertEqual(
    readFileSync(path.join(rollbackTarget, "working-install.txt"), "utf8"),
    "known-good-before-swap-failure\n",
    "Swap failure did not restore the working installation",
  );
  assertNoInstallerTemps(rollbackHome, ".pdf-tools-mcp");

  const termHome = path.join(tempRoot, "installer-term-home");
  const termTarget = path.join(termHome, ".pdf-tools-mcp");
  const termBin = path.join(termHome, "bin");
  const termMvState = path.join(termHome, "mv-state");
  mkdirSync(termTarget, { recursive: true });
  mkdirSync(termBin, { recursive: true });
  writeFileSync(path.join(termTarget, "working-install.txt"), "known-good-before-term\n");
  writeExecutable(path.join(termBin, "npm"), "#!/bin/bash\nexit 0\n");
  writeExecutable(path.join(termBin, "mv"), `#!/bin/bash
count=0
if [ -f "$MV_TEST_STATE" ]; then count=$(<"$MV_TEST_STATE"); fi
count=$((count + 1))
echo "$count" > "$MV_TEST_STATE"
if [ "$count" -eq 1 ]; then
  ${JSON.stringify(realMv)} "$@"
  status=$?
  if [ "$status" -eq 0 ]; then kill -TERM "$PPID"; fi
  exit "$status"
fi
exec ${JSON.stringify(realMv)} "$@"
`);
  expectFailure("bash", [installer, sourcePackageRoot, termTarget], tempRoot, /Restoring the previous installation/, {
    env: {
      ...process.env,
      HOME: termHome,
      PATH: `${termBin}:${process.env.PATH}`,
      MV_TEST_STATE: termMvState,
    },
  });
  assertEqual(readFileSync(termMvState, "utf8").trim(), "2", "TERM proof did not execute rollback move");
  assertEqual(
    readFileSync(path.join(termTarget, "working-install.txt"), "utf8"),
    "known-good-before-term\n",
    "TERM after backup did not restore the working installation",
  );
  assertNoInstallerTemps(termHome, ".pdf-tools-mcp");
}

function assertConfiguredServer(configPath, expectedServerPath, expectedSentinel) {
  const config = JSON.parse(readFileSync(configPath, "utf8"));
  assertEqual(config.mcpServers?.["pdf-tools"]?.command, "node", "Cursor command was not JSON encoded");
  assertEqual(
    config.mcpServers?.["pdf-tools"]?.args?.[0],
    expectedServerPath,
    "Cursor server path did not round-trip exactly through JSON",
  );
  if (expectedSentinel !== undefined) {
    assertEqual(config.sentinel, expectedSentinel, "Existing Cursor config data was not preserved");
  }
}

function testSuccessfulWrapperConfigs(sourcePackageRoot, tempRoot) {
  if (process.platform === "win32") return;
  const hostileHome = path.join(tempRoot, "home space'apostrophe\"double\\backslash");
  const hostileBin = path.join(hostileHome, "bin");
  const hostileConfig = path.join(hostileHome, ".cursor", "mcp.json");
  mkdirSync(path.dirname(hostileConfig), { recursive: true });
  populateNodeOnlyInstallerPath(hostileBin, tempRoot);
  writeFileSync(hostileConfig, `${JSON.stringify({ sentinel: "preserve-me", mcpServers: { existing: { command: "ok" } } }, null, 2)}\n`);
  const hostileEnvironment = {
    ...process.env,
    HOME: hostileHome,
    PATH: hostileBin,
  };
  run("bash", [path.join(sourcePackageRoot, "smart-install.sh")], tempRoot, {
    env: hostileEnvironment,
    input: "y\n",
  });
  assertConfiguredServer(
    hostileConfig,
    path.join(hostileHome, ".pdf-tools-mcp", "server", "index.js"),
    "preserve-me",
  );
  if (!existsSync(`${hostileConfig}.backup`)) throw new Error("Existing Cursor config backup was not created");

  const newHome = path.join(tempRoot, "new home 'apostrophe \"double\" \\backslash");
  const newBin = path.join(newHome, "bin");
  populateNodeOnlyInstallerPath(newBin, tempRoot);
  run("bash", [path.join(sourcePackageRoot, "install.command")], tempRoot, {
    env: { ...process.env, HOME: newHome, PATH: newBin },
    input: "\n",
  });
  assertConfiguredServer(
    path.join(newHome, ".cursor", "mcp.json"),
    path.join(newHome, ".pdf-tools-mcp", "server", "index.js"),
  );

  const hostileManualSource = path.join(tempRoot, "manual source 'apostrophe \"double\" \\backslash");
  const manualBin = path.join(tempRoot, "manual-node-only-bin");
  cpSync(sourcePackageRoot, hostileManualSource, { recursive: true });
  populateNodeOnlyInstallerPath(manualBin, tempRoot);
  const manualOutput = run("bash", [path.join(hostileManualSource, "install.sh")], tempRoot, {
    env: { ...process.env, HOME: newHome, PATH: manualBin },
  });
  const separator = "===============================================";
  const outputLines = manualOutput.split(/\r?\n/);
  const firstSeparator = outputLines.indexOf(separator);
  const secondSeparator = outputLines.indexOf(separator, firstSeparator + 1);
  if (firstSeparator < 0 || secondSeparator < 0) throw new Error("Manual installer did not emit a JSON block");
  const printedConfig = JSON.parse(outputLines.slice(firstSeparator + 1, secondSeparator).join("\n"));
  assertEqual(
    printedConfig.mcpServers?.["pdf-tools"]?.args?.[0],
    path.join(realpathSync(hostileManualSource), "server", "index.js"),
    "Manual installer path did not round-trip exactly through JSON",
  );
}

async function expectMcpError(operation, code) {
  try {
    await operation();
  } catch (error) {
    if (error?.code === code) return;
    throw new Error(`Expected MCP error ${code}, received ${error?.code}: ${error?.message}`);
  }
  throw new Error(`Expected MCP error ${code}, but operation succeeded`);
}

async function main() {
  const tempRoot = mkdtempSync(path.join(tmpdir(), "pdf-tools-share-contract-"));
  const buildRoot = path.join(tempRoot, "package-build");
  const restrictiveBuildRoot = path.join(tempRoot, "package-build-umask-077");
  const extractedRoot = path.join(tempRoot, "extracted");
  const archivePath = path.join(buildRoot, "pdf-toolkit-mcp.zip");
  const restrictiveArchivePath = path.join(restrictiveBuildRoot, "pdf-toolkit-mcp.zip");
  const sourcePackageRoot = path.join(extractedRoot, "pdf-toolkit-mcp-share");
  const installHome = path.join(tempRoot, "real-install-home");
  let packageRoot = sourcePackageRoot;
  const specialFilename = process.platform === "win32" ? "quarterly #1 draft.pdf" : "quarterly #1 ? draft.pdf";
  const fixturePath = path.join(tempRoot, specialFilename);
  const cMapOraclePath = path.join(tempRoot, "layout-unijis-vertical.pdf");
  const npmCommand = process.platform === "win32" ? "npm.cmd" : "npm";
  let transport;

  try {
    populatePackageBuildRoot(buildRoot);
    if (process.platform !== "win32") {
      populatePackageBuildRoot(restrictiveBuildRoot);
      forceTreeModeProfile(buildRoot, {
        directoryMode: 0o755,
        executableMode: 0o755,
        regularMode: 0o644,
      });
      forceTreeModeProfile(restrictiveBuildRoot, {
        directoryMode: 0o700,
        executableMode: 0o700,
        regularMode: 0o600,
      });
      assertShareModeProfile(path.join(buildRoot, "pdf-toolkit-mcp-share"), {
        directoryMode: 0o755,
        executableMode: 0o755,
        regularMode: 0o644,
      });
      assertShareModeProfile(
        path.join(restrictiveBuildRoot, "pdf-toolkit-mcp-share"),
        {
          directoryMode: 0o700,
          executableMode: 0o700,
          regularMode: 0o600,
        },
      );
    }

    const shareTreeBeforeBuild = JSON.stringify(
      regularTreeFingerprint(path.join(buildRoot, "pdf-toolkit-mcp-share")),
    );
    runPackager(buildRoot, 0o022);
    assertEqual(
      JSON.stringify(regularTreeFingerprint(path.join(buildRoot, "pdf-toolkit-mcp-share"))),
      shareTreeBeforeBuild,
      "Share package generation mutated its reviewed source tree",
    );
    if (process.platform !== "win32") {
      assertShareModeProfile(path.join(buildRoot, "pdf-toolkit-mcp-share"), {
        directoryMode: 0o755,
        executableMode: 0o755,
        regularMode: 0o644,
      });
    }
    const firstArchiveBytes = readFileSync(archivePath);
    assertCanonicalArchiveModes(firstArchiveBytes);
    if (process.platform !== "win32") {
      const restrictiveShareTreeBeforeBuild = JSON.stringify(
        regularTreeFingerprint(path.join(restrictiveBuildRoot, "pdf-toolkit-mcp-share")),
      );
      runPackager(restrictiveBuildRoot, 0o077);
      assertEqual(
        JSON.stringify(regularTreeFingerprint(
          path.join(restrictiveBuildRoot, "pdf-toolkit-mcp-share"),
        )),
        restrictiveShareTreeBeforeBuild,
        "Restrictive-umask package generation mutated its reviewed source tree",
      );
      assertShareModeProfile(
        path.join(restrictiveBuildRoot, "pdf-toolkit-mcp-share"),
        {
          directoryMode: 0o700,
          executableMode: 0o700,
          regularMode: 0o600,
        },
      );
      const restrictiveArchiveBytes = readFileSync(restrictiveArchivePath);
      assertCanonicalArchiveModes(restrictiveArchiveBytes);
      assertEqual(
        sha256(restrictiveArchiveBytes),
        sha256(firstArchiveBytes),
        "Share ZIP differs between explicit 0644/0755 and 0600/0700 source trees",
      );
    }
    runPackager(buildRoot, 0o022);
    assertEqual(
      JSON.stringify(regularTreeFingerprint(path.join(buildRoot, "pdf-toolkit-mcp-share"))),
      shareTreeBeforeBuild,
      "Repeated share package generation mutated its reviewed source tree",
    );
    if (process.platform !== "win32") {
      assertShareModeProfile(path.join(buildRoot, "pdf-toolkit-mcp-share"), {
        directoryMode: 0o755,
        executableMode: 0o755,
        regularMode: 0o644,
      });
    }
    const secondArchiveBytes = readFileSync(archivePath);
    const archiveSha256 = sha256(secondArchiveBytes);
    assertEqual(sha256(firstArchiveBytes), archiveSha256, "Share ZIP is not byte-reproducible");

    const packager = await import(`${pathToFileURL(path.join(buildRoot, "package-for-friend.js")).href}?proof=1`);
    let forcedOutputFailure = false;
    try {
      await packager.createPackage({ zipCommand: path.join(tempRoot, "missing-zip-command") });
    } catch {
      forcedOutputFailure = true;
    }
    if (!forcedOutputFailure) throw new Error("Forced archive-output failure unexpectedly succeeded");
    assertEqual(sha256(readFileSync(archivePath)), archiveSha256, "Archive-output failure replaced the good ZIP");
    const candidateLeftovers = readdirSync(buildRoot).filter(name => name.startsWith(".pdf-toolkit-mcp.zip.candidate-"));
    assertEqual(JSON.stringify(candidateLeftovers), "[]", "Failed archive build left a candidate directory");

    const disposableShareLockPath = path.join(buildRoot, "pdf-toolkit-mcp-share", "package-lock.json");
    const originalShareLockText = readFileSync(disposableShareLockPath, "utf8");
    const directTamper = JSON.parse(originalShareLockText);
    directTamper.packages["node_modules/@napi-rs/canvas"].version = "0.1.100";
    writeFileSync(disposableShareLockPath, `${JSON.stringify(directTamper, null, 2)}\n`);
    expectFailure(
      process.execPath,
      ["package-for-friend.js"],
      buildRoot,
      /record drifted.*node_modules\/@napi-rs\/canvas/,
    );
    assertEqual(sha256(readFileSync(archivePath)), archiveSha256, "Direct lock drift overwrote the good ZIP");

    const transitiveTamper = JSON.parse(originalShareLockText);
    transitiveTamper.packages["node_modules/accepts"].integrity = "sha512-AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=";
    writeFileSync(disposableShareLockPath, `${JSON.stringify(transitiveTamper, null, 2)}\n`);
    expectFailure(
      process.execPath,
      ["package-for-friend.js"],
      buildRoot,
      /record drifted.*node_modules\/accepts/,
    );
    assertEqual(sha256(readFileSync(archivePath)), archiveSha256, "Transitive lock drift overwrote the good ZIP");

    const dependencyEdgeTamper = JSON.parse(originalShareLockText);
    dependencyEdgeTamper.packages["node_modules/accepts"].dependencies.negotiator = "9.9.9";
    writeFileSync(disposableShareLockPath, `${JSON.stringify(dependencyEdgeTamper, null, 2)}\n`);
    expectFailure(
      process.execPath,
      ["package-for-friend.js"],
      buildRoot,
      /record drifted.*node_modules\/accepts/,
    );
    assertEqual(sha256(readFileSync(archivePath)), archiveSha256, "Dependency-edge drift overwrote the good ZIP");

    const platformMetadataTamper = JSON.parse(originalShareLockText);
    platformMetadataTamper.packages["node_modules/@napi-rs/canvas-win32-x64-msvc"].os = ["darwin"];
    writeFileSync(disposableShareLockPath, `${JSON.stringify(platformMetadataTamper, null, 2)}\n`);
    expectFailure(
      process.execPath,
      ["package-for-friend.js"],
      buildRoot,
      /record drifted.*canvas-win32-x64-msvc/,
    );
    assertEqual(sha256(readFileSync(archivePath)), archiveSha256, "Platform-metadata drift overwrote the good ZIP");

    const optionalOmission = JSON.parse(originalShareLockText);
    delete optionalOmission.packages["node_modules/@napi-rs/canvas-win32-x64-msvc"];
    writeFileSync(disposableShareLockPath, `${JSON.stringify(optionalOmission, null, 2)}\n`);
    expectFailure(
      process.execPath,
      ["package-for-friend.js"],
      buildRoot,
      /package-path coverage.*canvas-win32-x64-msvc/,
    );
    assertEqual(sha256(readFileSync(archivePath)), archiveSha256, "Optional-package omission overwrote the good ZIP");
    writeFileSync(disposableShareLockPath, originalShareLockText);

    run("unzip", ["-q", archivePath, "-d", extractedRoot], buildRoot);
    copyFileSync(path.join(REPO_ROOT, "example-fw9.pdf"), fixturePath);
    copyFileSync(CMAP_ORACLE_SOURCE, cMapOraclePath);

    const provenance = JSON.parse(readFileSync(path.join(sourcePackageRoot, "SHARE-PROVENANCE.json"), "utf8"));
    assertEqual(provenance.schema_version, "1.1", "Unexpected share provenance schema");
    assertEqual(provenance.dependency_lock.lockfile_version, 3, "Unexpected npm lockfile version");
    const extractedFiles = walkFiles(sourcePackageRoot);
    const manifestedFiles = Object.keys(provenance.files).sort();
    const expectedFiles = [...manifestedFiles, "SHARE-PROVENANCE.json"].sort();
    assertEqual(JSON.stringify(extractedFiles), JSON.stringify(expectedFiles), "Archive file allowlist drifted");
    for (const relativePath of manifestedFiles) {
      const digest = sha256(readFileSync(path.join(sourcePackageRoot, ...relativePath.split("/"))));
      assertEqual(digest, provenance.files[relativePath], `Provenance mismatch for ${relativePath}`);
    }
    if (process.platform !== "win32") {
      for (const installer of [
        "configure-cursor.sh",
        "install-transactional.sh",
        "install.command",
        "install.sh",
        "smart-install.sh",
      ]) {
        if ((statSync(path.join(sourcePackageRoot, installer)).mode & 0o111) === 0) {
          throw new Error(`Archive lost executable mode for ${installer}`);
        }
      }
    }

    const lockBytesBeforeInstall = readFileSync(path.join(sourcePackageRoot, "package-lock.json"));
    const sharePackage = JSON.parse(readFileSync(path.join(sourcePackageRoot, "package.json"), "utf8"));
    const shareLock = JSON.parse(lockBytesBeforeInstall.toString("utf8"));
    const rootLock = JSON.parse(readFileSync(path.join(buildRoot, "package-lock.json"), "utf8"));
    assertEqual(sha256(lockBytesBeforeInstall), provenance.dependency_lock.sha256, "Provenance does not bind the lock");
    const sharePackagePaths = Object.keys(shareLock.packages).filter(Boolean).sort();
    const rootProductionPackagePaths = Object.entries(rootLock.packages)
      .filter(([packagePath, lockedPackage]) => packagePath && lockedPackage.dev !== true)
      .map(([packagePath]) => packagePath)
      .sort();
    assertEqual(
      JSON.stringify(sharePackagePaths),
      JSON.stringify(rootProductionPackagePaths),
      "Full lock package-path coverage differs",
    );
    for (const [packagePath, lockedPackage] of Object.entries(shareLock.packages)) {
      if (packagePath === "") continue;
      assertEqual(
        JSON.stringify(lockedPackage),
        JSON.stringify(rootLock.packages[packagePath]),
        `Complete lock-record parity failed for ${packagePath}`,
      );
    }

    const sbomBytes = readFileSync(path.join(sourcePackageRoot, "SBOM.cdx.json"));
    const sbom = JSON.parse(sbomBytes.toString("utf8"));
    assertEqual(sha256(sbomBytes), provenance.sbom.sha256, "Provenance does not bind the SBOM");
    assertEqual(provenance.sbom.format, "CycloneDX", "Unexpected SBOM format claim");
    assertEqual(provenance.sbom.spec_version, "1.6", "Unexpected SBOM version claim");
    if (!/not external schema validation/.test(provenance.sbom.validation)) {
      throw new Error("SBOM evidence overstates its validation level");
    }
    packager.validateCycloneDxSbom(sbom, shareLock, sharePackage);
    /*
     * The expected size of the bill is derived on this side from the records
     * that actually shipped inside the archive — the locked npm graph, plus
     * the build inputs and notice manifest that travel with the WebAssembly
     * runtime — not from the packager that produced the SBOM and not from a
     * literal. A literal count goes stale the first time a source is added,
     * and re-deriving it from the generator would only prove the generator
     * agrees with itself.
     */
    const nativeExpectation = expectedNativeSbomShape(sourcePackageRoot);
    const expectedComponents = Object.keys(shareLock.packages).length - 1 + nativeExpectation.componentCount;
    assertEqual(sbom.components.length, expectedComponents, "SBOM component coverage drifted");
    assertEqual(sbom.dependencies.length, expectedComponents + 1, "SBOM dependency coverage drifted");
    assertNativeSbomCoverage(sbom, nativeExpectation);
    /*
     * Every component says something about its terms. Two thirds of them used
     * to say nothing at all, because the generator only emitted a licence when
     * `package-lock.json` happened to record one.
     */
    const silent = sbom.components.filter(component => !(component.licenses?.length > 0));
    if (silent.length > 0) {
      throw new Error(`Shipped SBOM has components with no licence at all: ${silent.map(c => c.name).join(", ")}`);
    }
    const missingComponentSbom = structuredClone(sbom);
    missingComponentSbom.components.pop();
    expectThrow(
      () => packager.validateCycloneDxSbom(missingComponentSbom, shareLock, sharePackage),
      /component coverage mismatch/,
      "SBOM component omission was not rejected",
    );
    const missingEdgeSbom = structuredClone(sbom);
    missingEdgeSbom.dependencies[0].dependsOn.pop();
    expectThrow(
      () => packager.validateCycloneDxSbom(missingEdgeSbom, shareLock, sharePackage),
      /dependency edges do not exactly cover root/,
      "SBOM dependency-edge omission was not rejected",
    );

    /*
     * Derived from the packager's own manifest rather than copied into a third
     * hand-written list. A hand-written copy could only ever be a subset of
     * what shipped, so a server module missing from the packager was also
     * missing here and the parity sweep passed over its absence.
     * `test/packager-server-coverage.test.js` is what pins that manifest to
     * the real contents of `server/`.
     */
    const mirroredFiles = packager.SHARE_MIRRORED_FILES;
    assertEqual(
      mirroredFiles.includes("dist-ui/index.html")
        && mirroredFiles.filter(file => file.startsWith("server/")).length >= 19,
      true,
      "Share mirror manifest is too small to be the real one",
    );
    for (const relativePath of mirroredFiles) {
      assertEqual(
        sha256(readFileSync(path.join(sourcePackageRoot, ...relativePath.split("/")))),
        sha256(readFileSync(path.join(REPO_ROOT, relativePath))),
        `Archive/source parity failed for ${relativePath}`,
      );
    }
    /*
     * The archived QPDF WASM runtime, checked against the reproducible-build
     * hash contract rather than only against the repository copy, so an
     * archive that faithfully mirrors a drifted checkout still fails.
     */
    verifyQpdfWasmRuntime(sourcePackageRoot, "extracted share archive");

    /*
     * `install-transactional.sh` copies a hand-written allow-list of top-level
     * items and silently drops anything absent from it, which is how a shipped
     * directory becomes a missing one at the user's machine. Derived from the
     * packager manifest here so the two cannot disagree.
     */
    const installerSource = readFileSync(
      path.join(sourcePackageRoot, "install-transactional.sh"),
      "utf8",
    );
    const requiredItemsBlock = /REQUIRED_ITEMS=\(([^)]*)\)/.exec(installerSource);
    if (!requiredItemsBlock) throw new Error("install-transactional.sh no longer declares REQUIRED_ITEMS");
    const requiredItems = new Set(
      [...requiredItemsBlock[1].matchAll(/"([^"]+)"/g)].map(match => match[1]),
    );
    if (requiredItems.size < 12) {
      throw new Error(`install-transactional.sh REQUIRED_ITEMS is too small to be the real one: ${requiredItems.size}`);
    }
    for (const relativePath of [...packager.SHARE_FILES, "SBOM.cdx.json", "SHARE-PROVENANCE.json"]) {
      const topLevel = relativePath.split("/")[0];
      if (!requiredItems.has(topLevel)) {
        throw new Error(
          `install-transactional.sh would silently drop ${relativePath}: `
          + `REQUIRED_ITEMS does not carry ${topLevel}`,
        );
      }
    }

    assertEqual(sharePackage.dependencies["pdfjs-dist"], "5.4.624", "pdfjs-dist manifest pin changed");
    for (const [dependencyName, expectedVersion] of Object.entries(PROTECTED_DIRECT_DEPENDENCIES)) {
      assertEqual(
        shareLock.packages[`node_modules/${dependencyName}`]?.version,
        expectedVersion,
        `Protected locked dependency ${dependencyName} changed`,
      );
    }

    testTransactionalFailurePaths(sourcePackageRoot, tempRoot);
    testSuccessfulWrapperConfigs(sourcePackageRoot, tempRoot);
    if (process.platform === "win32") {
      run(npmCommand, [
        "ci", "--omit=dev", "--engine-strict", "--no-audit", "--no-fund",
        "--cache", path.join(tempRoot, "npm-cache"),
      ], sourcePackageRoot);
    } else {
      mkdirSync(installHome, { recursive: true });
      packageRoot = path.join(installHome, ".pdf-tools-mcp");
      run("bash", [
        path.join(sourcePackageRoot, "install-transactional.sh"),
        sourcePackageRoot,
        packageRoot,
      ], tempRoot, {
        env: { ...process.env, HOME: installHome, npm_config_cache: path.join(tempRoot, "npm-cache") },
      });
      assertNoInstallerTemps(installHome, ".pdf-tools-mcp");
    }
    assertEqual(
      sha256(readFileSync(path.join(packageRoot, "package-lock.json"))),
      sha256(lockBytesBeforeInstall),
      "Transactional npm ci mutated the shipped lockfile",
    );

    const installedGraph = JSON.parse(run(npmCommand, ["ls", "--omit=dev", "--json"], packageRoot));
    for (const [dependencyName, expectedVersion] of Object.entries(PROTECTED_DIRECT_DEPENDENCIES)) {
      assertEqual(
        installedGraph.dependencies?.[dependencyName]?.version,
        expectedVersion,
        `Installed dependency ${dependencyName} drifted from the reviewed lock`,
      );
    }
    /*
     * The end of the pipeline: the licences in the shipped bill, checked
     * against the packages a real `npm ci` from the shipped lock put on disk.
     * This is the only point where the bill and the actual code can be
     * compared without the generator in between.
     */
    const licenceCheck = assertShippedLicencesMatchInstalledTree(sbom, packageRoot);

    const client = new Client({ name: "pdf-tools-isolated-share-contract", version: "1.0.0" });
    transport = new StdioClientTransport({
      command: process.execPath,
      args: [path.join(packageRoot, "server", "index.js")],
      cwd: packageRoot,
      env: { ALLOWED_DIRECTORIES: tempRoot },
      stderr: "ignore",
    });
    await client.connect(transport);
    const { tools } = await client.listTools();
    const { prompts } = await client.listPrompts();
    const { resources } = await client.listResources();
    /*
     * Derived from manifest.json rather than typed here. Hard-coded counts
     * drifted: the 43rd tool landed with test/mcp-contract.test.js updated and
     * this literal left at 42, and because the share contract is a release
     * step outside `npm test` the stale number sat undetected. manifest.json
     * is the same authority test/mcp-contract.test.js checks tool names
     * against, so the two can no longer disagree.
     */
    const manifest = JSON.parse(readFileSync(path.join(REPO_ROOT, "manifest.json"), "utf8"));
    const expectedTools = manifest.tools.length;
    const expectedPrompts = manifest.prompts.length;
    if (!(expectedTools > 40) || !(expectedPrompts > 10)) {
      throw new Error("manifest.json does not declare a plausible tool and prompt surface");
    }
    if (tools.length !== expectedTools || prompts.length !== expectedPrompts || resources.length !== 1) {
      throw new Error(
        `Unexpected discovery counts: ${tools.length} tools, ${prompts.length} prompts, ${resources.length} resources`,
      );
    }
    await expectMcpError(() => client.listTools({ cursor: "never-issued" }), -32602);

    const byteResult = await client.callTool({
      name: "read_pdf_bytes",
      arguments: { pdf_path: fixturePath, offset: 0, byteCount: 8 },
    });
    if (byteResult.isError || byteResult.structuredContent?.byteCount !== 8) {
      throw new Error("Generic-client read_pdf_bytes compatibility check failed");
    }
    for (const asset of CMAP_ORACLE_PROVENANCE.runtime_assets.files) {
      const assetPath = path.join(packageRoot, ...asset.path.split("/"));
      if (!existsSync(assetPath) || !statSync(assetPath).isFile()) {
        throw new Error(`Share runtime is missing provenance-bound PDF.js asset ${asset.path}`);
      }
      const bytes = readFileSync(assetPath);
      if (bytes.length !== asset.size_bytes || sha256(bytes) !== asset.sha256) {
        throw new Error(`Share runtime PDF.js asset does not match oracle provenance: ${asset.path}`);
      }
    }
    /*
     * The QPDF WASM runtime as it exists after a real transactional install,
     * then actually instantiated from that installed location. Presence alone
     * is not the property worth asserting: an artifact that ships but cannot
     * be loaded from where it landed is the failure this check exists for.
     * Nothing under `server/` imports it yet; this proves the packaging is
     * sound before anything depends on it.
     */
    verifyQpdfWasmRuntime(packageRoot, "installed share package");
    const qpdfSmoke = spawnSync(
      process.execPath,
      [
        path.join(REPO_ROOT, "vendor", "qpdf-wasm", "smoke.mjs"),
        path.join(packageRoot, ...QPDF_WASM_RUNTIME_DIRECTORY.split("/")),
        fixturePath,
      ],
      { encoding: "utf8", cwd: packageRoot },
    );
    if (qpdfSmoke.status !== 0) {
      throw new Error(
        `Installed share QPDF WASM runtime did not load: ${qpdfSmoke.stderr || qpdfSmoke.stdout}`,
      );
    }
    const qpdfEvidence = JSON.parse(qpdfSmoke.stdout);
    if (qpdfEvidence.qpdf_version !== "12.3.2"
      || qpdfEvidence.decrypt_status !== 0
      || qpdfEvidence.check_status !== 0
      || qpdfEvidence.wrong_password_status === 0
      || qpdfEvidence.wrong_password_created_output !== false) {
      throw new Error(`Installed share QPDF WASM runtime smoke failed: ${qpdfSmoke.stdout}`);
    }
    if (QPDF_WASM_RUNTIME_FILES.length < 15) {
      throw new Error("QPDF WASM runtime manifest is too small to include its notice directory");
    }
    const layout = await client.callTool({
      name: "read_pdf_layout",
      arguments: { pdf_path: fixturePath, max_output_characters: 200000 },
    });
    if (layout.isError
      || layout.structuredContent?.ir?.version !== "1.6.0"
      || layout.structuredContent?.source?.size_bytes !== statSync(fixturePath).size) {
      throw new Error("Share read_pdf_layout contract smoke failed");
    }
    const markdown = await client.callTool({
      name: "convert_pdf_to_markdown",
      arguments: { pdf_path: fixturePath, max_markdown_bytes: 200000 },
    });
    if (markdown.isError
      || markdown.structuredContent?.renderer?.version !== "1.20.0"
      || markdown.structuredContent?.markdown_bytes !== Buffer.byteLength(markdown.structuredContent?.markdown || "", "utf8")
      || markdown.structuredContent?.markdown_sha256 !== sha256(Buffer.from(markdown.structuredContent?.markdown || "", "utf8"))) {
      throw new Error("Share convert_pdf_to_markdown contract smoke failed");
    }
    const cMapLayout = await client.callTool({
      name: "read_pdf_layout",
      arguments: { pdf_path: cMapOraclePath, max_output_characters: 200000 },
    });
    const cMapItem = cMapLayout.structuredContent?.pages?.[0]?.raw_items?.[0];
    if (cMapLayout.isError
      || cMapLayout.structuredContent?.source?.sha256 !== CMAP_ORACLE_PROVENANCE.fixture.sha256
      || cMapLayout.structuredContent?.source?.size_bytes !== CMAP_ORACLE_PROVENANCE.fixture.size_bytes
      || cMapLayout.structuredContent?.pages?.[0]?.flow_text !== "日本語"
      || cMapItem?.font?.vertical !== true
      || cMapItem?.raw_height !== 72
      || cMapItem?.geometry_provenance?.advance_source !== "item_height"
      || cMapItem?.bbox?.height !== 72) {
      throw new Error("Share read_pdf_layout named-CMap vertical oracle failed");
    }
    const uriResult = await client.callTool({ name: "get_pdf_resource_uri", arguments: { pdf_path: fixturePath } });
    const uri = uriResult.structuredContent?.uri;
    if (!uri || uri.includes(" ") || uri.includes("#") || uri.includes("?")) {
      throw new Error(`Share package returned a non-canonical resource URI: ${uri}`);
    }
    const resource = await client.readResource({ uri });
    if (Buffer.from(resource.contents?.[0]?.blob || "", "base64").subarray(0, 5).toString("ascii") !== "%PDF-") {
      throw new Error("Share package dynamic resource read failed");
    }
    const render = await client.callTool({
      name: "render_pdf_page",
      arguments: { pdf_path: fixturePath, page: 1, max_dimension_px: 800 },
    });
    const image = render.content?.find(item => item.type === "image" && item.mimeType === "image/png");
    if (render.isError || !image || Buffer.from(image.data, "base64").subarray(0, 8).toString("hex") !== "89504e470d0a1a0a") {
      throw new Error("Share package native render_pdf_page did not return a valid PNG");
    }

    await client.close();
    console.log(
      `Reproducible transactional share contract passed on ${process.platform}/${process.arch}: ` +
        `${tools.length} tools, ${prompts.length} prompts, ${sbom.components.length} SBOM components ` +
        `all carrying a licence (${licenceCheck.checked} checked against the installed tree, ` +
        `${licenceCheck.noAssertion} truthfully asserting none), ` +
        `native raster image, SHA-256 ${archiveSha256}.`,
    );
  } finally {
    await transport?.close();
    rmSync(tempRoot, { recursive: true, force: true });
  }
}

main().catch(error => {
  console.error(`Isolated share contract failed: ${error.message}`);
  process.exitCode = 1;
});
