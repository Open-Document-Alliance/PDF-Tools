/**
 * The bill has to say what its contents are licensed under.
 *
 * `SBOM.cdx.json` emitted a `licenses` entry only when `package-lock.json`
 * happened to record a `license` field, which it does for fewer than half of
 * the locked packages. Seventy of a hundred and twelve components were named,
 * versioned and hashed while saying nothing at all about their terms, and that
 * inventory shipped in both the MCPB and the share ZIP.
 *
 * The two sides of every check below are deliberately different sources:
 *
 *   - the expectation for WHICH packages owe licence evidence is derived from
 *     `package-lock.json`, never from a count written down here;
 *   - the expectation for WHAT each one declares is re-read from the installed
 *     tree in `node_modules/`, while the committed record was resolved from
 *     the registry tarballs. A record that has been hand-edited, or a
 *     dependency bumped without regenerating it, disagrees with the code on
 *     disk and fails here.
 *
 * The last group proves the checks are not vacuous by mutating the lock and
 * the record in the ways a real change would, and requiring each mutation to
 * fail closed.
 */
import { createHash } from "node:crypto";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  generateCycloneDxSbom,
  validateCycloneDxSbom,
} from "../package-for-friend.js";
import {
  classifyLicenseDeclaration,
  DECLARATION_LICENSE_OBJECT,
  DECLARATION_LICENSE_STRING,
  DECLARATION_LICENSES_ARRAY,
  DECLARATION_NONE,
  deriveNpmComponentLicensing,
  isSpdxLicenseExpression,
  isSpdxLicenseId,
  npmLicenseKey,
  npmLicenseProvenance,
  packageNameFromLockPath,
  spdxLicenseList,
  verifyNpmLicenseProvenanceCoverage,
} from "../scripts/npm-license-provenance.mjs";
import { QPDF_WASM_SBOM_COMPONENTS } from "../scripts/qpdf-wasm-sbom.mjs";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

const rootLock = JSON.parse(readFileSync(path.join(REPO_ROOT, "package-lock.json"), "utf8"));
const shareLock = JSON.parse(
  readFileSync(path.join(REPO_ROOT, "pdf-toolkit-mcp-share", "package-lock.json"), "utf8"),
);
const sharePackage = JSON.parse(
  readFileSync(path.join(REPO_ROOT, "pdf-toolkit-mcp-share", "package.json"), "utf8"),
);
const provenance = npmLicenseProvenance();
const spdx = spdxLicenseList();
const REQUIRED_RUNTIME_PACKAGES = [
  "@modelcontextprotocol/server", "@modelcontextprotocol/core",
  "@napi-rs/canvas", "pdf-lib", "pdfjs-dist", "yaml",
];
const sbom = generateCycloneDxSbom(shareLock, sharePackage);

/** The production graph: what is inside a shipped artifact, from the lock. */
const productionEntries = Object.entries(rootLock.packages)
  .filter(([packagePath, lockedPackage]) => packagePath !== "" && lockedPackage.dev !== true);

/** Whether this host can install a locked package at all. */
function hostCanInstall(lockedPackage) {
  const platformMatches = (constraint, actual) => !constraint
    || constraint.some(value => (value.startsWith("!") ? value.slice(1) !== actual : value === actual));
  return platformMatches(lockedPackage.os, process.platform)
    && platformMatches(lockedPackage.cpu, process.arch);
}

/**
 * The licence evidence for a locked package, or a failure that names the
 * package. A bare property access on a missing entry reports a TypeError,
 * which is loud but says nothing about which dependency drifted.
 */
function evidenceFor(packagePath, lockedPackage, record = provenance) {
  const key = npmLicenseKey(packageNameFromLockPath(packagePath), lockedPackage.version);
  const entry = record.packages[key];
  if (!entry) {
    throw new Error(
      `No committed licence evidence for ${key} (${packagePath}). `
      + "Run `npm run vendor:npm-licenses` and commit the result.",
    );
  }
  return entry;
}

function componentsByPackagePath(bom) {
  return new Map(bom.components
    .map(component => [
      component.properties?.find(property => property.name === "pdf-tools:npm-package-path")?.value,
      component,
    ])
    .filter(([packagePath]) => packagePath));
}

function propertyValues(component, name) {
  return (component.properties || [])
    .filter(property => property.name === `pdf-tools:${name}`)
    .map(property => property.value);
}

describe("every locked package owes licence evidence, and the lock says which", () => {
  it("covers exactly the production graph, derived from the lock rather than counted here", () => {
    const expected = new Set(productionEntries
      .map(([packagePath, lockedPackage]) =>
        npmLicenseKey(packageNameFromLockPath(packagePath), lockedPackage.version)));
    expect(productionEntries.map(([packagePath]) => packageNameFromLockPath(packagePath)))
      .toEqual(expect.arrayContaining(REQUIRED_RUNTIME_PACKAGES));
    expect([...Object.keys(provenance.packages)].sort()).toEqual([...expected].sort());
  });

  it("binds every entry to the same tarball the lock pins", () => {
    for (const [packagePath, lockedPackage] of productionEntries) {
      const entry = evidenceFor(packagePath, lockedPackage);
      expect(entry.integrity, packagePath).toBe(lockedPackage.integrity);
      expect(entry.tarball, packagePath).toBe(lockedPackage.resolved);
    }
  });

  it("agrees with the licence the lockfile itself already recorded, where it recorded one", () => {
    const withLockLicence = productionEntries.filter(([, lockedPackage]) => lockedPackage.license);
    // The lockfile carries npm's registry copy of the declaration for some
    // packages and not others; wherever it does, it is a third independent
    // source and must agree with the tarball this record was read from.
    expect(withLockLicence.length).toBeGreaterThan(10);
    for (const [packagePath, lockedPackage] of withLockLicence) {
      const entry = evidenceFor(packagePath, lockedPackage);
      expect(entry.declaration, packagePath).toBe(DECLARATION_LICENSE_STRING);
      expect(entry.declared, packagePath).toBe(lockedPackage.license);
    }
  });
});

describe("the committed record agrees with the code installed on this machine", () => {
  /*
   * The record was resolved from registry tarballs; this reads the tree npm
   * actually installed. Neither side is the other's source, so a hand-edited
   * record or a stale one is caught here rather than believed.
   */
  const installable = productionEntries.filter(([, lockedPackage]) => hostCanInstall(lockedPackage));
  const absent = productionEntries.filter(([packagePath]) =>
    !existsSync(path.join(REPO_ROOT, ...packagePath.split("/"), "package.json")));

  it("re-derives what every installed package declares, and finds the record already says it", () => {
    expect(installable.map(([packagePath]) => packageNameFromLockPath(packagePath)))
      .toEqual(expect.arrayContaining(REQUIRED_RUNTIME_PACKAGES));
    let checked = 0;
    for (const [packagePath, lockedPackage] of installable) {
      const manifestPath = path.join(REPO_ROOT, ...packagePath.split("/"), "package.json");
      if (!existsSync(manifestPath)) continue;
      const installed = classifyLicenseDeclaration(JSON.parse(readFileSync(manifestPath, "utf8")));
      const entry = evidenceFor(packagePath, lockedPackage);
      expect(entry.declaration, packagePath).toBe(installed.declaration);
      expect(entry.declared, packagePath).toEqual(installed.declared);
      checked += 1;
    }
    expect(checked).toBe(installable.length);
  });

  it("accounts for every package it could not read, by the lock's own platform constraints", () => {
    // Nothing may be skipped for a reason other than "this host cannot install
    // it", which is exactly why the record is resolved from tarballs instead
    // of from whatever happens to be on the build machine.
    for (const [packagePath, lockedPackage] of absent) {
      expect(hostCanInstall(lockedPackage), `${packagePath} is absent but installable here`).toBe(false);
    }
    expect(absent.length).toBeGreaterThan(0);
  });

  it("finds the licence text the record hashes, byte for byte, where the package is installed", () => {
    let checked = 0;
    for (const [packagePath, lockedPackage] of installable) {
      const packageDir = path.join(REPO_ROOT, ...packagePath.split("/"));
      if (!existsSync(packageDir)) continue;
      const entry = evidenceFor(packagePath, lockedPackage);
      const onDisk = new Set(readdirSync(packageDir));
      for (const file of entry.license_files) {
        // npm can drop files an `.npmignore` excluded from the published
        // tarball, but it never adds one, so a recorded file that is present
        // must be the same bytes.
        if (!onDisk.has(file.path)) continue;
        const bytes = readFileSync(path.join(packageDir, file.path));
        expect(
          sha256(bytes),
          `${packagePath}/${file.path}`,
        ).toBe(file.sha256);
        checked += 1;
      }
    }
    // Every recorded licence file for an installable package must be read;
    // dependency pruning must not turn this into an arbitrary size threshold.
    expect(checked).toBe(installable.reduce((total, [packagePath, lockedPackage]) =>
      total + evidenceFor(packagePath, lockedPackage).license_files.length, 0));
  });
});

describe("no component is silent, and none claims more than its package does", () => {
  const byPath = componentsByPackagePath(sbom);

  it("gives every component in the bill a licence, npm and native alike", () => {
    // Derived from the two records the bill is built out of. The native count
    // is separately re-derived from the shipped notice manifest in
    // test/sbom-native-components.test.js; what matters here is that the
    // licence loop covers all of it and skips nothing.
    expect(sbom.components.length)
      .toBe(Object.keys(shareLock.packages).length - 1 + QPDF_WASM_SBOM_COMPONENTS.length);
    for (const component of sbom.components) {
      expect(component.licenses?.length, component.name).toBeGreaterThan(0);
    }
    expect(sbom.metadata.component.licenses.length).toBeGreaterThan(0);
  });

  it("only claims an SPDX identifier the pinned list actually contains", () => {
    expect(spdx.ids.length).toBeGreaterThan(400);
    const claimed = new Set();
    for (const component of [...sbom.components, sbom.metadata.component]) {
      for (const entry of component.licenses) {
        if (entry.license?.id) claimed.add(entry.license.id);
        if (entry.expression) expect(isSpdxLicenseExpression(entry.expression)).toBe(true);
      }
    }
    expect(claimed.size).toBeGreaterThan(0);
    for (const id of claimed) expect(spdx.ids, id).toContain(id);
  });

  it("reports the declared string itself, never a normalised guess at it", () => {
    for (const [packagePath, lockedPackage] of Object.entries(shareLock.packages)) {
      if (packagePath === "") continue;
      const entry = evidenceFor(packagePath, lockedPackage);
      if (entry.declaration !== DECLARATION_LICENSE_STRING) continue;
      const component = byPath.get(packagePath);
      const reported = component.licenses[0].license?.id
        ?? component.licenses[0].license?.name
        ?? component.licenses[0].expression;
      expect(reported, packagePath).toBe(entry.declared);
    }
  });

  it("says where each licence came from, and marks it as the package's own declaration", () => {
    for (const [packagePath] of Object.entries(shareLock.packages).filter(([key]) => key !== "")) {
      const component = byPath.get(packagePath);
      expect(propertyValues(component, "npm-license-basis").length, packagePath).toBe(1);
      expect(propertyValues(component, "npm-license-evidence")[0]).toMatch(/verified against the locked integrity/);
      for (const entry of component.licenses) {
        const acknowledgement = entry.acknowledgement ?? entry.license?.acknowledgement;
        // Everything asserted here is declared by the package. Nothing is
        // "concluded", because concluding a licence means reading the text and
        // deciding what it is, which is the guess this record refuses to make.
        if (entry.license?.name !== "NOASSERTION") expect(acknowledgement, packagePath).toBe("declared");
      }
    }
  });
});

describe("declaration shapes npm has used are represented, never guessed at", () => {
  const derive = entry => deriveNpmComponentLicensing("synthetic", "1.0.0", {
    evidence_basis: "synthetic",
    packages: { "synthetic@1.0.0": { integrity: "sha512-x", tarball: "https://example.invalid/t.tgz", license_files: [], ...entry } },
  });

  it("uses license.id for an identifier the pinned SPDX list knows", () => {
    expect(derive({ declaration: DECLARATION_LICENSE_STRING, declared: "Apache-2.0" }).licenses)
      .toEqual([{ license: { id: "Apache-2.0", acknowledgement: "declared" } }]);
  });

  it("keeps a dual licence as the expression the package wrote, not one half of it", () => {
    const { licenses, properties } = derive({
      declaration: DECLARATION_LICENSE_STRING,
      declared: "(MIT OR Apache-2.0)",
    });
    expect(licenses).toEqual([{ expression: "(MIT OR Apache-2.0)", acknowledgement: "declared" }]);
    expect(properties[0].value).toMatch(/rather than reduced to one side of the choice/);
    expect(derive({ declaration: DECLARATION_LICENSE_STRING, declared: "GPL-3.0-only WITH Classpath-exception-2.0" }).licenses)
      .toEqual([{ expression: "GPL-3.0-only WITH Classpath-exception-2.0", acknowledgement: "declared" }]);
  });

  it("refuses to call a non-SPDX string an SPDX identifier", () => {
    const { licenses, properties } = derive({
      declaration: DECLARATION_LICENSE_STRING,
      declared: "SEE LICENSE IN LICENSE.md",
    });
    // `license.name` asserts nothing about SPDX; `license.id` would, and would
    // also be schema-invalid, which is how a wrong claim becomes a broken one.
    expect(licenses).toEqual([{ license: { name: "SEE LICENSE IN LICENSE.md", acknowledgement: "declared" } }]);
    expect(properties[0].value).toMatch(/could not be validated against the pinned SPDX licence list/);
    expect(isSpdxLicenseId("SEE LICENSE IN LICENSE.md")).toBe(false);
  });

  it("reads the legacy `license` object form without treating its url as a licence", () => {
    const { licenses, properties } = derive({
      declaration: DECLARATION_LICENSE_OBJECT,
      declared: { type: "ISC", url: "https://example.com/isc" },
    });
    expect(licenses).toEqual([
      { license: { id: "ISC", acknowledgement: "declared", url: "https://example.com/isc" } },
    ]);
    expect(properties[0].value).toMatch(/legacy `license` object form/);
  });

  it("treats an empty legacy array as no declaration rather than an empty licence list", () => {
    expect(classifyLicenseDeclaration({ licenses: [] })).toEqual({ declaration: DECLARATION_NONE, declared: null });
    expect(classifyLicenseDeclaration({ license: "  " })).toEqual({ declaration: DECLARATION_NONE, declared: null });
  });

  it("lists a legacy `licenses` array without inventing AND or OR between its entries", () => {
    const { licenses, properties } = derive({
      declaration: DECLARATION_LICENSES_ARRAY,
      declared: [{ type: "MIT", url: "https://example.com/mit" }, { type: "Acme Proprietary 1.0" }],
    });
    expect(licenses).toEqual([
      { license: { id: "MIT", acknowledgement: "declared", url: "https://example.com/mit" } },
      { license: { name: "Acme Proprietary 1.0", acknowledgement: "declared" } },
    ]);
    expect(properties[0].value).toMatch(/without saying whether they apply together or as a choice/);
  });

  it("says NOASSERTION explicitly when a package declares nothing, and says what it looked for", () => {
    const bare = derive({ declaration: DECLARATION_NONE, declared: null });
    expect(bare.licenses).toEqual([{ license: { name: "NOASSERTION" } }]);
    expect(bare.properties[0].value).toMatch(/declares no licence .* and ships no licence file/);

    const withText = deriveNpmComponentLicensing("synthetic", "1.0.0", {
      evidence_basis: "synthetic",
      packages: {
        "synthetic@1.0.0": {
          integrity: "sha512-x",
          tarball: "https://example.invalid/t.tgz",
          declaration: DECLARATION_NONE,
          declared: null,
          license_files: [{ path: "LICENSE", sha256: "a".repeat(64) }],
        },
      },
    });
    // Licence text is evidence, not a licence. It is pointed at and hashed;
    // no identifier is read out of it.
    expect(withText.licenses).toEqual([{ license: { name: "NOASSERTION" } }]);
    expect(withText.properties[0].value).toMatch(/text does not name an identifier and one is not inferred/);
    expect(withText.properties.map(property => property.value))
      .toContain(`LICENSE sha256:${"a".repeat(64)}`);
  });
});

describe("scope says what is inside the artifact, not what npm called it", () => {
  it("keeps npm's optionality for the share ZIP, which ships a lockfile and no installed tree", () => {
    const canvasTargets = sbom.components.filter(component => component.name.startsWith("@napi-rs/canvas-"));
    expect(canvasTargets.length).toBeGreaterThan(4);
    for (const component of canvasTargets) {
      expect(component.scope).toBe("optional");
      expect(propertyValues(component, "npm-optional-dependency")).toEqual(["true"]);
      expect(propertyValues(component, "npm-scope-basis")[0]).toMatch(/no installed tree/);
    }
  });

  it("marks what an artifact carries as required and what it does not as excluded", () => {
    /*
     * The MCPB carries an installed tree, so its bill can be exact. Five of
     * the eleven canvas targets ship inside it and six do not; calling all
     * eleven "optional" understated the five and overstated the six.
     */
    const staged = new Set(Object.keys(shareLock.packages)
      .filter(packagePath => packagePath !== "" && !packagePath.includes("canvas-win32")));
    const artifactSbom = generateCycloneDxSbom(shareLock, sharePackage, { installedPackagePaths: staged });
    const byPath = componentsByPackagePath(artifactSbom);
    for (const [packagePath, component] of byPath) {
      expect(component.scope, packagePath).toBe(staged.has(packagePath) ? "required" : "excluded");
    }
    expect([...byPath.values()].filter(component => component.scope === "excluded").length)
      .toBe(Object.keys(shareLock.packages).length - 1 - staged.size);
    expect(() => validateCycloneDxSbom(artifactSbom, shareLock, sharePackage, { installedPackagePaths: staged }))
      .not.toThrow();
    // And a bill generated for one artifact does not validate as the other's.
    expect(() => validateCycloneDxSbom(artifactSbom, shareLock, sharePackage))
      .toThrow(/does not exactly cover/);
  });
});

describe("a dependency cannot change without the licence evidence following", () => {
  /*
   * The point of this group. Each mutation is what a real dependency change
   * looks like from the lockfile's side, and each one must stop the build
   * instead of producing a component that says nothing about its terms.
   */
  it("refuses a dependency that was added without licence evidence", () => {
    const drifted = structuredClone(shareLock);
    drifted.packages["node_modules/left-pad"] = {
      version: "1.3.0",
      resolved: "https://registry.npmjs.org/left-pad/-/left-pad-1.3.0.tgz",
      integrity: "sha512-XI5MPzVNApjAyhQzphX8BkmKsKUxD4LdyK24iZeQGinBN9yTQT3bFlCBy/aVx2HrNcqQGsdot8ghrjyrvMCoEA==",
      license: "WTFPL",
    };
    expect(() => generateCycloneDxSbom(drifted, sharePackage))
      .toThrow(/does not cover the locked graph.*left-pad@1\.3\.0/s);
  });

  it("refuses a dependency that was removed while its evidence stayed behind", () => {
    const drifted = structuredClone(shareLock);
    delete drifted.packages["node_modules/pako"];
    expect(() => verifyNpmLicenseProvenanceCoverage(drifted))
      .toThrow(/does not cover the locked graph.*extra.*pako@1\.0\.11/s);
  });

  it("refuses a version bump whose evidence still describes the old version", () => {
    const drifted = structuredClone(shareLock);
    drifted.packages["node_modules/pako"].version = "1.0.12";
    expect(() => generateCycloneDxSbom(drifted, sharePackage))
      .toThrow(/does not cover the locked graph.*pako@1\.0\.12/s);
  });

  it("refuses evidence resolved from a different tarball than the lock pins", () => {
    const drifted = structuredClone(shareLock);
    drifted.packages["node_modules/pako"].integrity = "sha512-AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=";
    expect(() => generateCycloneDxSbom(drifted, sharePackage))
      .toThrow(/resolved from a different tarball than the lock pins/);
  });

  it("refuses evidence that contradicts the licence the lockfile itself records", () => {
    // The lockfile records a licence for some packages and not others, and
    // wherever it does it is a source this record did not read. Editing the
    // record to say something else has to fail against it.
    const sdkKey = npmLicenseKey(
      "@modelcontextprotocol/server",
      shareLock.packages["node_modules/@modelcontextprotocol/server"].version,
    );
    expect(shareLock.packages["node_modules/@modelcontextprotocol/server"].license).toBeTruthy();
    const tampered = structuredClone(provenance);
    tampered.packages[sdkKey].declared = "Apache-2.0";
    expect(() => verifyNpmLicenseProvenanceCoverage(shareLock, tampered))
      .toThrow(/disagrees with the licence the lock itself records/);
  });

  it("refuses to emit a bill for a component it has no evidence for", () => {
    expect(() => deriveNpmComponentLicensing("never-published", "0.0.1"))
      .toThrow(/No licence evidence is recorded for never-published@0\.0\.1/);
  });

  it("rejects a bill whose licence was edited after generation", () => {
    const tampered = structuredClone(sbom);
    const target = tampered.components.find(component => component.name === "pdfjs-dist");
    target.licenses = [{ license: { id: "MIT", acknowledgement: "declared" } }];
    expect(() => validateCycloneDxSbom(tampered, shareLock, sharePackage))
      .toThrow(/does not exactly cover node_modules\/pdfjs-dist/);
  });

  it("rejects a bill that drops a licence entirely", () => {
    const tampered = structuredClone(sbom);
    delete tampered.components.find(component => component.name === "pdf-lib").licenses;
    expect(() => validateCycloneDxSbom(tampered, shareLock, sharePackage))
      .toThrow(/does not exactly cover node_modules\/pdf-lib/);
  });
});
