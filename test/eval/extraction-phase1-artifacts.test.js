import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  PHASE1_ARTIFACT_CONFIG_ID,
  PHASE1_ARTIFACT_ROLES,
  attestArtifactImmutability,
  buildArtifactInventory,
  hashTrustedRegularFile,
  registerPortableArtifactPathIdentity,
  validateArtifactConfiguration,
  verifyArtifactInventory,
} from "./extraction-phase1-artifacts.js";
import { assertSchema, canonicalJson, sha256 } from "./extraction-phase1-protocol.js";

const TRUSTED = ["candidate.direct_pdf.v1"];
const roots = [];

afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(roots.splice(0).map(root => fs.rm(root, { recursive: true, force: true })));
});

async function fixture() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "phase1-artifacts-"));
  roots.push(root);
  const directories = {
    adapter: path.join(root, "adapter"),
    review: path.join(root, "review"),
    terms: path.join(root, "terms"),
  };
  await Promise.all(Object.values(directories).map(directory => fs.mkdir(directory, { mode: 0o700 })));
  const reviewBytes = Buffer.from("reviewed license scope\n");
  await Promise.all([
    fs.writeFile(path.join(directories.adapter, "adapter.mjs"), "export const adapter = true;\n", { mode: 0o600 }),
    fs.writeFile(path.join(directories.review, "review.txt"), reviewBytes, { mode: 0o600 }),
    fs.writeFile(path.join(directories.terms, "LICENSE.txt"), "Synthetic license\n", { mode: 0o600 }),
  ]);
  const license = {
    component_id: "synthetic-adapter",
    license_id: "synthetic-license",
    license_name: "Synthetic License",
    license_text_artifact_id: "terms:LICENSE.txt",
    review_record_artifact_id: "review:review.txt",
    review_record_sha256: sha256(reviewBytes),
    review_scope: "Synthetic adapter test fixture only",
    reviewed_at: "2026-07-22T00:00:00Z",
    status: "reviewed_license",
  };
  const component = {
    component_id: "synthetic-adapter",
    version: "1.0.0",
    source_reference: "local:test-fixture",
    source_revision: "fixture-v1",
    license_ids: [license.license_id],
    artifact_roles: ["adapter_source", "license_review", "license_text"],
  };
  const rootSpec = (root_role, artifact_role, directory) => ({
    root_role,
    artifact_role,
    component_id: component.component_id,
    license_ids: [license.license_id],
    path: directory,
    required: true,
    allow_symlinks: {},
    allow_hardlink_groups: [],
  });
  const config = {
    config_id: PHASE1_ARTIFACT_CONFIG_ID,
    candidate_id: TRUSTED[0],
    configured: true,
    root_specs: [
      rootSpec("adapter", "adapter_source", directories.adapter),
      rootSpec("review", "license_review", directories.review),
      rootSpec("terms", "license_text", directories.terms),
    ],
    role_dispositions: PHASE1_ARTIFACT_ROLES.map(role => ["adapter_source", "license_review", "license_text"].includes(role)
      ? { role, status: "required", reason: null }
      : { role, status: "pending", reason: "runner_runtime_closure_incomplete" }),
    components: [component],
    licenses: [license],
  };
  return { root, directories, config };
}

describe("Phase 1 candidate artifact attestation", () => {
  it.each([9007199254740993n, -9223372036854407366n])(
    "compares exact large inode %s and still rejects a one-inode replacement", async inode => {
      const { directories } = await fixture();
      const filename = path.join(directories.adapter, "adapter.mjs");
      let descriptorInode = inode;
      const originalLstat = fs.lstat.bind(fs);
      const originalOpen = fs.open.bind(fs);
      vi.spyOn(fs, "lstat").mockImplementation(async (target, options) => {
        const stat = await originalLstat(target, options);
        if (target === filename) stat.ino = options?.bigint ? inode : Number(inode);
        return stat;
      });
      vi.spyOn(fs, "open").mockImplementation(async (...args) => {
        const handle = await originalOpen(...args);
        if (args[0] === filename) {
          const originalStat = handle.stat.bind(handle);
          handle.stat = async options => {
            const stat = await originalStat(options);
            stat.ino = options?.bigint ? descriptorInode : Number(descriptorInode);
            return stat;
          };
        }
        return handle;
      });
      await expect(hashTrustedRegularFile(filename)).resolves.toMatchObject({ inode: BigInt.asUintN(64, inode).toString() });
      descriptorInode = inode + 1n;
      await expect(hashTrustedRegularFile(filename)).rejects.toThrow("Artifact identity changed before read");
    });

  it("serializes signed root, file, symlink, and runtime inode identities as unsigned decimal", async () => {
    const { directories, config } = await fixture();
    const filename = path.join(directories.adapter, "adapter.mjs");
    await fs.symlink("adapter.mjs", path.join(directories.adapter, "alias.mjs"));
    config.root_specs[0].allow_symlinks = { "alias.mjs": "adapter.mjs" };
    const highBit = 1n << 63n;
    const signedStat = (stat, options) => {
      const inode = BigInt.asIntN(64, BigInt(stat.ino) | highBit);
      stat.ino = options?.bigint ? inode : Number(inode);
      return stat;
    };
    const originalLstat = fs.lstat.bind(fs);
    const originalOpen = fs.open.bind(fs);
    vi.spyOn(fs, "lstat").mockImplementation(async (target, options) => signedStat(await originalLstat(target, options), options));
    vi.spyOn(fs, "open").mockImplementation(async (...args) => {
      const handle = await originalOpen(...args);
      const originalStat = handle.stat.bind(handle);
      handle.stat = async options => signedStat(await originalStat(options), options);
      return handle;
    });
    const inventory = await buildArtifactInventory(config, { trustedCandidateIds: TRUSTED });
    const schema = JSON.parse(await fs.readFile(new URL("../fixtures/eval/extraction/phase1/artifact-inventory.schema.json", import.meta.url)));
    expect(assertSchema(inventory, schema, "signed inode inventory")).toBe(true);
    const runtime = await hashTrustedRegularFile(filename);
    const identities = [
      ...inventory.roots.map(root => root.inode),
      ...inventory.artifacts.flatMap(artifact => [artifact.inode, artifact.link_identity.directory_entry_inode, artifact.link_identity.target_inode]),
      runtime.inode,
    ];
    for (const identity of identities) {
      expect(identity).toMatch(/^[0-9]+$/);
      expect(BigInt(identity)).toBeGreaterThanOrEqual(highBit);
    }
    const original = inventory.artifacts.find(artifact => artifact.relative_path === "adapter.mjs");
    const alias = inventory.artifacts.find(artifact => artifact.relative_path === "alias.mjs");
    expect(alias.inode).toBe(original.inode);
    expect(alias.link_identity.target_inode).toBe(original.inode);
    expect(alias.link_identity.directory_entry_inode).not.toBe(original.inode);
    expect(runtime.inode).toBe(original.inode);
  });

  it("builds strict portable and host inventories and maps unconfigured defaults to not applicable", async () => {
    const { config } = await fixture();
    expect(validateArtifactConfiguration(config, TRUSTED)).toBeTruthy();
    const inventory = await buildArtifactInventory(config, { trustedCandidateIds: TRUSTED });
    const schema = JSON.parse(await fs.readFile(new URL("../fixtures/eval/extraction/phase1/artifact-inventory.schema.json", import.meta.url)));
    expect(assertSchema(inventory, schema, "artifact inventory")).toBe(true);
    expect(inventory.state).toBe("captured_incomplete");
    expect(inventory.components[0].content_identity_sha256).toMatch(/^[a-f0-9]{64}$/);
    expect(inventory.artifacts.map(item => item.artifact_role)).toEqual(["adapter_source", "license_review", "license_text"]);
    expect(inventory.logical_bytes).toBeGreaterThan(0);
    expect(inventory.unique_content_bytes).toBeGreaterThan(0);
    expect(verifyArtifactInventory(inventory, structuredClone(inventory))).toBe(true);

    const notApplicable = await buildArtifactInventory({
      config_id: PHASE1_ARTIFACT_CONFIG_ID,
      candidate_id: TRUSTED[0],
      configured: false,
      root_specs: [], role_dispositions: PHASE1_ARTIFACT_ROLES.map(role => ({ role, status: "not_applicable", reason: "candidate_not_configured" })), components: [], licenses: [],
    }, { trustedCandidateIds: TRUSTED });
    expect(notApplicable).toMatchObject({ state: "not_applicable", roots: [], artifacts: [], logical_bytes: 0, unique_content_bytes: 0 });
    await expect(buildArtifactInventory(config)).rejects.toThrow(/explicit trusted candidate ID set/);
  });

  it("fails closed on same-size, missing, extra, order, role, component, and license mutations", async () => {
    const { config, directories } = await fixture();
    await expect(attestArtifactImmutability(config, async () => {
      await fs.writeFile(path.join(directories.adapter, "adapter.mjs"), "export const adapter = null;\n", { mode: 0o600 });
    }, { trustedCandidateIds: TRUSTED })).rejects.toMatchObject({ code: "ARTIFACT_DEPLOYMENT_DRIFT" });

    const mutations = [
      value => value.root_specs.reverse(),
      value => { value.root_specs[0].artifact_role = "runtime_config"; },
      value => { value.root_specs[0].component_id = "other-component"; },
      value => { value.root_specs[0].license_ids = ["other-license"]; },
      value => value.role_dispositions.reverse(),
      value => { value.role_dispositions[0] = value.role_dispositions[1]; },
      value => { value.role_dispositions.find(item => item.role === "adapter_source").status = "pending"; value.role_dispositions.find(item => item.role === "adapter_source").reason = "runner_runtime_closure_incomplete"; },
      value => { value.role_dispositions.find(item => item.status === "pending").reason = "unknown_reason"; },
      value => { value.components[0].artifact_roles = ["license_review", "adapter_source", "license_text"]; },
      value => { value.components[0].license_ids = ["other-license"]; },
    ];
    for (const mutate of mutations) {
      const hostile = structuredClone(config);
      mutate(hostile);
      await expect(buildArtifactInventory(hostile, { trustedCandidateIds: TRUSTED })).rejects.toThrow();
    }
    await fs.rm(path.join(directories.review, "review.txt"));
    await expect(buildArtifactInventory(config, { trustedCandidateIds: TRUSTED })).rejects.toThrow();
  });

  it("rejects a two-component cross-license ownership swap", async () => {
    const { config } = await fixture();
    const componentA = { ...structuredClone(config.components[0]), component_id: "component-a", license_ids: ["license-a"] };
    const componentB = { ...structuredClone(config.components[0]), component_id: "component-b", license_ids: ["license-b"] };
    const licenseA = { ...structuredClone(config.licenses[0]), component_id: "component-a", license_id: "license-a" };
    const licenseB = { ...structuredClone(config.licenses[0]), component_id: "component-b", license_id: "license-b" };
    config.components = [componentA, componentB];
    config.licenses = [licenseA, licenseB];
    config.root_specs = config.root_specs.map(rootSpec => ({ ...rootSpec, component_id: "component-a", license_ids: ["license-a"] }));
    expect(validateArtifactConfiguration(config, TRUSTED)).toBeTruthy();

    config.components[0].license_ids = ["license-b"];
    config.components[1].license_ids = ["license-a"];
    config.root_specs = config.root_specs.map(rootSpec => ({ ...rootSpec, license_ids: ["license-b"] }));
    expect(() => validateArtifactConfiguration(config, TRUSTED)).toThrow(/ownership/);
  });

  it("rejects case collisions and non-NFC paths at the portable metadata boundary", () => {
    const identities = new Map();
    expect(registerPortableArtifactPathIdentity(identities, "NAME")).toBe("name");
    expect(() => registerPortableArtifactPathIdentity(identities, "name")).toThrow(/NAME and name/);
    const unicode = new Map();
    registerPortableArtifactPathIdentity(unicode, "caf\u00e9.pdf");
    expect(() => registerPortableArtifactPathIdentity(unicode, "cafe\u0301.pdf")).toThrow(/not NFC/);

    const nested = new Map();
    registerPortableArtifactPathIdentity(nested, "A/x");
    expect(() => registerPortableArtifactPathIdentity(nested, "a/x")).toThrow(/collision/);
    const distinctNested = new Map();
    registerPortableArtifactPathIdentity(distinctNested, "A/x");
    expect(() => registerPortableArtifactPathIdentity(distinctNested, "a/y")).not.toThrow();
    expect(() => registerPortableArtifactPathIdentity(new Map(), "\u03b1/\u03b2.pdf")).not.toThrow();
  });

  it("routes collected directory metadata through the portable collision policy", async () => {
    const { config, directories } = await fixture();
    await fs.writeFile(path.join(directories.adapter, "NAME"), "one", { mode: 0o600 });
    const directoryReader = async (directory, options) => {
      const entries = await fs.readdir(directory, options);
      if (directory === directories.adapter) entries.push({ name: "name" });
      return entries;
    };
    await expect(buildArtifactInventory(config, {
      trustedCandidateIds: TRUSTED,
      directoryReader,
    })).rejects.toThrow(/NAME and name/);
  });

  it("rejects unsafe symlinks, hardlinks, and special files", async () => {
    const { config, directories } = await fixture();
    const source = path.join(directories.adapter, "adapter.mjs");
    await fs.symlink("adapter.mjs", path.join(directories.adapter, "link.mjs"));
    await expect(buildArtifactInventory(config, { trustedCandidateIds: TRUSTED })).rejects.toThrow(/not runner-allowlisted/);
    await fs.rm(path.join(directories.adapter, "link.mjs"));
    await fs.link(source, path.join(directories.adapter, "hard.mjs"));
    await expect(buildArtifactInventory(config, { trustedCandidateIds: TRUSTED })).rejects.toThrow(/hardlink/i);
    config.root_specs[0].allow_hardlink_groups = [["adapter.mjs", "hard.mjs"]];
    const allowed = await buildArtifactInventory(config, { trustedCandidateIds: TRUSTED });
    expect(allowed.artifacts.filter(item => item.artifact_role === "adapter_source")).toHaveLength(2);

    const mutant = structuredClone(allowed);
    mutant.artifacts[0].bytes += 1;
    expect(() => verifyArtifactInventory(mutant, allowed)).toThrow();
    const forgedComponent = structuredClone(allowed);
    forgedComponent.components[0].content_identity_sha256 = "f".repeat(64);
    expect(() => verifyArtifactInventory(forgedComponent, allowed)).toThrow();
    expect(canonicalJson(allowed)).not.toContain(config.root_specs[0].path);
  });
});
