import { constants as fsConstants } from "node:fs";
import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { canonicalJson, sha256 } from "./extraction-phase1-protocol.js";

export const PHASE1_ARTIFACT_INVENTORY_ID = "pdf-tools.extraction-phase1-artifact-inventory.v1";
export const PHASE1_ARTIFACT_CONFIG_ID = "pdf-tools.extraction-phase1-artifact-config.v1";

const SAFE_ROLE = /^[a-z][a-z0-9_]{0,63}$/;
const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
export const PHASE1_ARTIFACT_ROLES = Object.freeze([
  "adapter_entrypoint",
  "adapter_source",
  "candidate_config",
  "environment_lock",
  "installed_distribution",
  "interpreter",
  "license_review",
  "license_text",
  "model_config",
  "model_weights",
  "native_bridge",
  "ocr_bridge",
  "required_data",
  "runtime_config",
  "system_component",
  "tokenizer_preprocessor",
]);
const ARTIFACT_ROLE_SET = new Set(PHASE1_ARTIFACT_ROLES);
const ROLE_DISPOSITION_STATUSES = new Set(["not_applicable", "pending", "required"]);
const ROLE_DISPOSITION_REASONS = new Set([
  "candidate_not_configured",
  "not_used_by_candidate",
  "runner_runtime_closure_incomplete",
  "synthetic_test_double_nonclaiming",
]);

function exactKeys(value, keys, label) {
  if (!value || typeof value !== "object" || Array.isArray(value)
    || canonicalJson(Object.keys(value).sort()) !== canonicalJson([...keys].sort())) {
    throw new Error(`${label} must contain exactly the trusted keys`);
  }
}

function portableRelative(value, label = "artifact path") {
  if (typeof value !== "string" || value.length === 0 || value.includes("\0")
    || value !== value.normalize("NFC") || value.includes("\\") || path.posix.isAbsolute(value)) {
    throw new Error(`${label} must be a nonempty relative NFC POSIX path`);
  }
  const normalized = path.posix.normalize(value);
  if (normalized !== value || normalized === "." || normalized === ".." || normalized.startsWith("../")) {
    throw new Error(`${label} contains traversal or non-normalized segments`);
  }
  for (const segment of value.split("/")) {
    if (!segment || segment === "." || segment === "..") throw new Error(`${label} contains an unsafe segment`);
  }
  return value;
}

function modeBits(stat) {
  return typeof stat.mode === "bigint" ? Number(stat.mode & 0o7777n) : stat.mode & 0o7777;
}

export function compareUnicodeCodePoints(left, right) {
  const leftPoints = Array.from(String(left), value => value.codePointAt(0));
  const rightPoints = Array.from(String(right), value => value.codePointAt(0));
  const length = Math.min(leftPoints.length, rightPoints.length);
  for (let index = 0; index < length; index += 1) {
    if (leftPoints[index] !== rightPoints[index]) return leftPoints[index] - rightPoints[index];
  }
  return leftPoints.length - rightPoints.length;
}

function sortBy(left, right, fields) {
  for (const field of fields) {
    const result = compareUnicodeCodePoints(left[field], right[field]);
    if (result) return result;
  }
  return 0;
}

function requireSorted(values, fields, label) {
  for (let index = 1; index < values.length; index += 1) {
    if (sortBy(values[index - 1], values[index], fields) >= 0) throw new Error(`${label} must be strictly sorted by Unicode code point order`);
  }
}

function validateMetadataRecords(config) {
  const components = structuredClone(config.components);
  const licenses = structuredClone(config.licenses);
  requireSorted(components, ["component_id"], "Component records");
  requireSorted(licenses, ["license_id"], "License records");
  if (new Set(components.map(item => item.component_id)).size !== components.length) throw new Error("Artifact configuration contains duplicate component IDs");
  if (new Set(licenses.map(item => item.license_id)).size !== licenses.length) throw new Error("Artifact configuration contains duplicate license IDs");
  for (const component of components) {
    exactKeys(component, ["artifact_roles", "component_id", "license_ids", "source_reference", "source_revision", "version"], "Component record");
    if (!SAFE_ID.test(component.component_id) || typeof component.version !== "string" || !component.version) throw new Error("Invalid component identity");
    if (typeof component.source_reference !== "string" || !component.source_reference
      || typeof component.source_revision !== "string" || !component.source_revision
      || !Array.isArray(component.license_ids) || component.license_ids.length === 0
      || new Set(component.license_ids).size !== component.license_ids.length
      || component.license_ids.some(id => !licenses.some(item => item.license_id === id))) throw new Error("Component source or license closure is invalid");
    if (!Array.isArray(component.artifact_roles) || component.artifact_roles.length === 0
      || new Set(component.artifact_roles).size !== component.artifact_roles.length
      || component.artifact_roles.some(role => !ARTIFACT_ROLE_SET.has(role))) throw new Error("Component artifact roles are invalid");
    if (canonicalJson(component.artifact_roles) !== canonicalJson([...component.artifact_roles].sort(compareUnicodeCodePoints))
      || canonicalJson(component.license_ids) !== canonicalJson([...component.license_ids].sort(compareUnicodeCodePoints))) throw new Error("Component role and license arrays must already be sorted");
  }
  for (const license of licenses) {
    exactKeys(license, ["component_id", "license_id", "license_name", "license_text_artifact_id", "review_record_artifact_id", "review_record_sha256", "review_scope", "reviewed_at", "status"], "License record");
    if (!SAFE_ID.test(license.license_id) || typeof license.license_name !== "string" || !license.license_name
      || typeof license.license_text_artifact_id !== "string" || !license.license_text_artifact_id
      || typeof license.review_record_artifact_id !== "string" || !license.review_record_artifact_id
      || license.review_record_artifact_id === license.license_text_artifact_id
      || !components.some(item => item.component_id === license.component_id)
      || !/^[a-f0-9]{64}$/.test(license.review_record_sha256)
      || typeof license.review_scope !== "string" || !license.review_scope
      || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z$/.test(license.reviewed_at)
      || !["reviewed_license", "pending_review"].includes(license.status)) throw new Error("Invalid license record");
  }
  for (const component of components) {
    if (component.license_ids.some(licenseId => licenses.find(item => item.license_id === licenseId)?.component_id !== component.component_id)) {
      throw new Error("Component-to-license ownership is invalid");
    }
  }
  for (const license of licenses) {
    const referringComponents = components.filter(component => component.license_ids.includes(license.license_id));
    if (referringComponents.length !== 1 || referringComponents[0].component_id !== license.component_id) {
      throw new Error("License-to-component ownership is invalid");
    }
  }
  return { components, licenses };
}

export function validateArtifactConfiguration(config, trustedCandidateIds) {
  exactKeys(config, ["candidate_id", "components", "config_id", "configured", "licenses", "role_dispositions", "root_specs"], "Artifact configuration");
  if (config.config_id !== PHASE1_ARTIFACT_CONFIG_ID || !trustedCandidateIds.includes(config.candidate_id)) throw new Error("Artifact configuration has an invalid runner-owned identity");
  if (!Array.isArray(config.root_specs) || !Array.isArray(config.role_dispositions)
    || config.role_dispositions.length !== PHASE1_ARTIFACT_ROLES.length) throw new Error("Artifact configuration roles are invalid");
  requireSorted(config.role_dispositions, ["role"], "Artifact role dispositions");
  if (canonicalJson(config.role_dispositions.map(item => item.role)) !== canonicalJson(PHASE1_ARTIFACT_ROLES)) throw new Error("Artifact configuration must exhaustively disposition every closed role");
  for (const disposition of config.role_dispositions) {
    exactKeys(disposition, ["reason", "role", "status"], "Artifact role disposition");
    if (!ARTIFACT_ROLE_SET.has(disposition.role) || !ROLE_DISPOSITION_STATUSES.has(disposition.status)
      || (disposition.status === "required" ? disposition.reason !== null : !ROLE_DISPOSITION_REASONS.has(disposition.reason))) {
      throw new Error("Artifact role disposition is invalid");
    }
  }
  const dispositionByRole = new Map(config.role_dispositions.map(item => [item.role, item]));
  const { components, licenses } = validateMetadataRecords(config);
  const roots = new Set();
  for (const root of config.root_specs) {
    exactKeys(root, ["allow_hardlink_groups", "allow_symlinks", "artifact_role", "component_id", "license_ids", "path", "required", "root_role"], "Artifact root specification");
    const rootComponent = components.find(item => item.component_id === root.component_id);
    if (!SAFE_ROLE.test(root.root_role) || !ARTIFACT_ROLE_SET.has(root.artifact_role) || roots.has(root.root_role)
      || !path.isAbsolute(root.path) || typeof root.required !== "boolean" || !Array.isArray(root.allow_hardlink_groups)
      || !root.allow_symlinks || typeof root.allow_symlinks !== "object" || Array.isArray(root.allow_symlinks)
      || !rootComponent || !rootComponent.artifact_roles.includes(root.artifact_role) || dispositionByRole.get(root.artifact_role)?.status !== "required"
      || !Array.isArray(root.license_ids) || root.license_ids.length === 0
      || canonicalJson(root.license_ids) !== canonicalJson([...root.license_ids].sort(compareUnicodeCodePoints))
      || root.license_ids.some(id => !licenses.some(item => item.license_id === id))
      || canonicalJson(root.license_ids) !== canonicalJson(rootComponent?.license_ids)) {
      throw new Error("Artifact root specification is invalid");
    }
    roots.add(root.root_role);
    for (const [link, target] of Object.entries(root.allow_symlinks)) {
      portableRelative(link, "symlink path");
      portableRelative(target, "symlink target");
    }
    for (const group of root.allow_hardlink_groups) {
      if (!Array.isArray(group) || group.length < 2 || new Set(group).size !== group.length) throw new Error("Hardlink allowlist groups must contain distinct paths");
      group.forEach(value => portableRelative(value, "hardlink path"));
      if (canonicalJson(group) !== canonicalJson([...group].sort(compareUnicodeCodePoints))) throw new Error("Hardlink allowlist groups must already use Unicode code point order");
    }
  }
  requireSorted(config.root_specs, ["root_role"], "Artifact root specifications");
  if (config.configured === false) {
    if (config.root_specs.length || config.components.length || config.licenses.length
      || config.role_dispositions.some(item => item.status !== "not_applicable" || item.reason !== "candidate_not_configured")) {
      throw new Error("An unconfigured candidate artifact configuration must be exactly not applicable");
    }
  } else if (config.root_specs.length === 0 || !config.role_dispositions.some(item => item.status === "required")) {
    throw new Error("A configured candidate requires trusted artifact roots and nonzero required roles");
  }
  return { components, licenses };
}

export function redactArtifactConfiguration(config) {
  const redacted = structuredClone(config);
  redacted.root_specs = redacted.root_specs.map(root => {
    const { path: absolutePath, ...retained } = root;
    return { ...retained, path_sha256: sha256(Buffer.from(`pdf-tools.artifact-config-path.v1\0${path.resolve(absolutePath)}`)) };
  });
  return redacted;
}

function caseFold(value) {
  return value.normalize("NFC").toLowerCase();
}

function inodeIdentity(inode) {
  // Node can expose a high-bit inode as a signed bigint on some filesystems.
  // Serialize the same 64 bits as unsigned decimal, as required by the schema.
  return BigInt.asUintN(64, inode).toString();
}

export function registerPortableArtifactPathIdentity(identities, value) {
  if (!(identities instanceof Map)) throw new TypeError("Portable artifact path identities must be a Map");
  if (typeof value !== "string" || value !== value.normalize("NFC")) {
    throw new Error(`Artifact path is not NFC: ${value}`);
  }
  portableRelative(value);
  const folded = caseFold(value);
  const prior = identities.get(folded);
  if (prior !== undefined) {
    throw new Error(`Artifact paths have a Unicode or case-fold collision: ${prior} and ${value}`);
  }
  identities.set(folded, value);
  return folded;
}

async function resolveAllowedSymlink(rootPath, relativePath, allowSymlinks) {
  let current = relativePath;
  const chain = [];
  const visited = new Set();
  for (let depth = 0; depth < 40; depth += 1) {
    if (visited.has(current)) throw new Error(`Symlink cycle detected at ${relativePath}`);
    visited.add(current);
    const absolute = path.join(rootPath, ...current.split("/"));
    const stat = await fs.lstat(absolute, { bigint: true });
    if (!stat.isSymbolicLink()) return { finalRelative: current, finalPath: absolute, stat, chain };
    const declared = allowSymlinks[current];
    if (!declared) throw new Error(`Symlink is not runner-allowlisted: ${relativePath}`);
    const linkText = await fs.readlink(absolute);
    const resolved = path.resolve(path.dirname(absolute), linkText);
    const rootPrefix = `${path.resolve(rootPath)}${path.sep}`;
    if (!resolved.startsWith(rootPrefix)) throw new Error(`Symlink escapes its trusted root: ${relativePath}`);
    const next = path.relative(rootPath, resolved).split(path.sep).join("/");
    portableRelative(next, "resolved symlink target");
    if (next !== declared) throw new Error(`Symlink target differs from the runner allowlist: ${relativePath}`);
    chain.push({ path: current, target: next, link_text_sha256: sha256(Buffer.from(linkText)) });
    current = next;
  }
  throw new Error(`Symlink chain is too deep: ${relativePath}`);
}

async function readRegularFileNoFollow(filename, expectedStat, label) {
  if (typeof fsConstants.O_NOFOLLOW !== "number") throw new Error("Safe artifact inventory requires O_NOFOLLOW support");
  let handle;
  try {
    handle = await fs.open(filename, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW);
  } catch (error) {
    const wrapped = new Error(`Safe no-follow artifact open failed for ${label}: ${error.code ?? error.message}`);
    wrapped.code = "SAFE_ARTIFACT_OPEN_FAILED";
    throw wrapped;
  }
  try {
    const before = await handle.stat({ bigint: true });
    if (!before.isFile()
      || String(before.dev) !== String(expectedStat.dev) || String(before.ino) !== String(expectedStat.ino)
      || String(before.size) !== String(expectedStat.size)) throw new Error(`Artifact identity changed before read: ${label}`);
    const hash = createHash("sha256");
    const chunk = Buffer.allocUnsafe(1024 * 1024);
    let observedBytes = 0;
    while (true) {
      const { bytesRead } = await handle.read(chunk, 0, chunk.length, null);
      if (bytesRead === 0) break;
      hash.update(chunk.subarray(0, bytesRead));
      observedBytes += bytesRead;
    }
    const after = await handle.stat({ bigint: true });
    for (const key of ["dev", "ino", "size", "mtimeNs", "ctimeNs"]) {
      if (String(after[key]) !== String(before[key])) throw new Error(`Artifact changed while read: ${label}`);
    }
    if (BigInt(observedBytes) !== after.size) throw new Error(`Artifact byte count changed while read: ${label}`);
    return { bytes: observedBytes, sha256: hash.digest("hex"), stat: after };
  } finally {
    await handle.close();
  }
}

export async function hashTrustedRegularFile(filename) {
  const resolved = path.resolve(filename);
  // Match the descriptor's exact integer representation. Number Stats can
  // round 64-bit inode IDs (and represent their sign differently), producing
  // false identity changes before an otherwise stable runtime artifact read.
  const stat = await fs.lstat(resolved, { bigint: true });
  if (!stat.isFile() || stat.isSymbolicLink()) throw new Error("Trusted runtime artifact must be a real regular file");
  const retained = await readRegularFileNoFollow(resolved, stat, path.basename(resolved));
  return {
    bytes: retained.bytes,
    sha256: retained.sha256,
    mode: Number(retained.stat.mode & 0o7777n),
    device: String(retained.stat.dev),
    inode: inodeIdentity(retained.stat.ino),
    realpath_sha256: sha256(Buffer.from(await fs.realpath(resolved))),
  };
}

export async function buildCandidateCommandEvidence(candidate, config, inventory) {
  if (!candidate?.configured || !candidate.command || config.candidate_id !== candidate.id || inventory.candidate_id !== candidate.id) {
    throw new Error("Candidate command evidence inputs are inconsistent");
  }
  const executable = await hashTrustedRegularFile(candidate.command.executable);
  const argumentsEvidence = [];
  let boundEntrypoints = 0;
  for (const [index, value] of candidate.command.args.entries()) {
    if (path.isAbsolute(value)) {
      let binding = null;
      for (const root of config.root_specs) {
        const relative = path.relative(path.resolve(root.path), path.resolve(value));
        if (!relative || relative.startsWith("..") || path.isAbsolute(relative)) continue;
        const portable = relative.split(path.sep).join("/");
        const artifact = inventory.artifacts.find(item => item.root_role === root.root_role && item.relative_path === portable);
        if (artifact) {
          binding = { index, kind: "artifact", artifact_id: artifact.artifact_id, artifact_role: artifact.artifact_role, sha256: artifact.sha256 };
          if (artifact.artifact_role === "adapter_entrypoint") boundEntrypoints += 1;
          break;
        }
      }
      if (!binding) throw new Error(`Absolute candidate command argument is not bound to inventoried content: ${index}`);
      argumentsEvidence.push(binding);
    } else {
      argumentsEvidence.push({ index, kind: "literal", value_sha256: sha256(Buffer.from(value)) });
    }
  }
  if (boundEntrypoints !== 1) throw new Error("Configured candidate command must bind exactly one inventoried adapter entrypoint");
  return {
    candidate_id: candidate.id,
    closure: "incomplete_nonclaiming",
    executable,
    arguments: argumentsEvidence,
    bound_adapter_entrypoints: boundEntrypoints,
  };
}

async function collectRoot(rootSpec, directoryReader) {
  const rootPath = path.resolve(rootSpec.path);
  let rootLstat;
  try {
    rootLstat = await fs.lstat(rootPath, { bigint: true });
  } catch (error) {
    if (error?.code === "ENOENT" && !rootSpec.required) return { root: null, artifacts: [] };
    throw error;
  }
  if (rootLstat.isSymbolicLink() || !rootLstat.isDirectory()) throw new Error(`Trusted artifact root must be a real directory: ${rootSpec.root_role}`);
  const rootReal = await fs.realpath(rootPath);
  const artifacts = [];
  const names = new Map();
  const walk = async (absolute, prefix = "") => {
    const directoryBefore = await fs.lstat(absolute, { bigint: true });
    if (!directoryBefore.isDirectory() || directoryBefore.isSymbolicLink()) throw new Error(`Artifact directory identity is unsafe: ${prefix || rootSpec.root_role}`);
    const entries = await directoryReader(absolute, { withFileTypes: true });
    entries.sort((a, b) => compareUnicodeCodePoints(a.name, b.name));
    const entryNamesBefore = entries.map(entry => entry.name);
    for (const entry of entries) {
      const relative = prefix ? `${prefix}/${entry.name}` : entry.name;
      registerPortableArtifactPathIdentity(names, relative);
      const itemPath = path.join(absolute, entry.name);
      const linkStat = await fs.lstat(itemPath, { bigint: true });
      if (linkStat.isDirectory()) {
        await walk(itemPath, relative);
        continue;
      }
      let resolved = { finalPath: itemPath, finalRelative: relative, stat: linkStat, chain: [] };
      if (linkStat.isSymbolicLink()) resolved = await resolveAllowedSymlink(rootPath, relative, rootSpec.allow_symlinks);
      if (!resolved.stat.isFile()) throw new Error(`Special artifact files are prohibited: ${relative}`);
      const opened = await readRegularFileNoFollow(resolved.finalPath, resolved.stat, relative);
      const bytes = opened.bytes;
      const after = opened.stat;
      artifacts.push({
        artifact_role: rootSpec.artifact_role,
        artifact_id: `${rootSpec.root_role}:${relative}`,
        component_id: rootSpec.component_id,
        license_ids: structuredClone(rootSpec.license_ids),
        root_role: rootSpec.root_role,
        relative_path: relative,
        file_type: resolved.chain.length ? "allowlisted_symlink" : "regular_file",
        bytes,
        sha256: opened.sha256,
        mode: Number(after.mode & 0o7777n),
        device: String(after.dev),
        inode: inodeIdentity(after.ino),
        nlink: Number(after.nlink),
        link_identity: {
          directory_entry_device: String(linkStat.dev),
          directory_entry_inode: inodeIdentity(linkStat.ino),
          target_device: String(after.dev),
          target_inode: inodeIdentity(after.ino),
        },
        symlink_chain: resolved.chain,
      });
    }
    const entryNamesAfter = (await fs.readdir(absolute)).sort(compareUnicodeCodePoints);
    if (canonicalJson(entryNamesAfter) !== canonicalJson(entryNamesBefore)) throw new Error(`Artifact directory entry set changed while inventoried: ${prefix || rootSpec.root_role}`);
    const directoryAfter = await fs.lstat(absolute, { bigint: true });
    if (!directoryAfter.isDirectory() || directoryAfter.isSymbolicLink()) throw new Error(`Artifact directory changed type while inventoried: ${prefix || rootSpec.root_role}`);
    for (const key of ["dev", "ino", "mode", "nlink", "size", "mtimeNs", "ctimeNs"]) {
      if (String(directoryAfter[key]) !== String(directoryBefore[key])) throw new Error(`Artifact directory changed while inventoried: ${prefix || rootSpec.root_role}`);
    }
  };
  await walk(rootPath);
  const rootAfter = await fs.lstat(rootPath, { bigint: true });
  if (!rootAfter.isDirectory() || rootAfter.isSymbolicLink() || await fs.realpath(rootPath) !== rootReal
    || rootAfter.dev !== rootLstat.dev || rootAfter.ino !== rootLstat.ino || rootAfter.mode !== rootLstat.mode
    || rootAfter.mtimeNs !== rootLstat.mtimeNs || rootAfter.ctimeNs !== rootLstat.ctimeNs) throw new Error(`Trusted artifact root changed while inventoried: ${rootSpec.root_role}`);
  artifacts.sort((a, b) => sortBy(a, b, ["artifact_role", "root_role", "relative_path"]));
  const aliases = new Map();
  for (const artifact of artifacts) {
    const identity = `${artifact.device}:${artifact.inode}`;
    const list = aliases.get(identity) ?? [];
    if (artifact.file_type === "regular_file") list.push(artifact.relative_path);
    aliases.set(identity, list);
  }
  const allowedGroups = rootSpec.allow_hardlink_groups.map(group => [...group]);
  for (const group of aliases.values()) {
    if (group.length === 0) continue;
    const retained = artifacts.find(item => item.relative_path === group[0]);
    if (retained.nlink !== group.length) throw new Error(`Artifact has an external or uninventoried hardlink: ${group[0]}`);
    if (group.length < 2) continue;
    const sorted = [...group].sort(compareUnicodeCodePoints);
    if (!allowedGroups.some(allowed => canonicalJson(allowed) === canonicalJson(sorted))) {
      throw new Error(`Hardlink aliases are not exactly runner-allowlisted: ${sorted.join(", ")}`);
    }
  }
  return {
    root: {
      root_role: rootSpec.root_role,
      artifact_role: rootSpec.artifact_role,
      required: rootSpec.required,
      root_path_sha256: sha256(Buffer.from(rootPath)),
      root_realpath_sha256: sha256(Buffer.from(rootReal)),
      mode: modeBits(rootLstat),
      device: String(rootLstat.dev),
      inode: inodeIdentity(rootLstat.ino),
    },
    artifacts,
  };
}

function digestInventory(inventory) {
  const portableArtifacts = inventory.artifacts.map(({ device, inode, nlink, link_identity, ...portable }) => portable);
  const portable = {
    candidate_id: inventory.candidate_id,
    state: inventory.state,
    role_dispositions: inventory.role_dispositions,
    components: inventory.components,
    licenses: inventory.licenses,
    artifacts: portableArtifacts,
    logical_bytes: inventory.logical_bytes,
    unique_content_bytes: inventory.unique_content_bytes,
  };
  const contentItems = [...new Map(inventory.artifacts.map(item => [`${item.sha256}:${item.bytes}`, { sha256: item.sha256, bytes: item.bytes }])).values()]
    .sort((a, b) => sortBy(a, b, ["sha256", "bytes"]));
  const withDigests = {
    ...inventory,
    digests: {
      portable_content_set_sha256: sha256(Buffer.from(`pdf-tools.artifact-portable.v1\0${canonicalJson(portable)}`)),
      host_deployment_set_sha256: sha256(Buffer.from(`pdf-tools.artifact-host.v1\0${canonicalJson({ roots: inventory.roots, artifacts: inventory.artifacts })}`)),
      content_set_sha256: sha256(Buffer.from(`pdf-tools.artifact-content.v1\0${canonicalJson(contentItems)}`)),
      inventory_self_sha256: null,
    },
  };
  withDigests.digests.inventory_self_sha256 = sha256(Buffer.from(`pdf-tools.artifact-inventory-self.v1\0${canonicalJson(withDigests)}`));
  return withDigests;
}

export async function buildArtifactInventory(config, {
  trustedCandidateIds,
  directoryReader = fs.readdir,
} = {}) {
  if (!Array.isArray(trustedCandidateIds) || trustedCandidateIds.length === 0) throw new Error("Artifact inventory requires an explicit trusted candidate ID set");
  if (typeof directoryReader !== "function") throw new Error("Artifact inventory directory reader must be callable");
  const { components, licenses } = validateArtifactConfiguration(config, trustedCandidateIds);
  if (!config.configured) {
    return digestInventory({
      inventory_id: PHASE1_ARTIFACT_INVENTORY_ID, inventory_version: 1, candidate_id: config.candidate_id,
      state: "not_applicable", role_dispositions: structuredClone(config.role_dispositions), roots: [], components: [], licenses: [], artifacts: [], logical_bytes: 0, unique_content_bytes: 0,
    });
  }
  const collected = await Promise.all(config.root_specs.map(rootSpec => collectRoot(rootSpec, directoryReader)));
  const roots = collected.map(item => item.root).filter(Boolean);
  const artifacts = collected.flatMap(item => item.artifacts);
  artifacts.sort((a, b) => sortBy(a, b, ["artifact_role", "root_role", "relative_path"]));
  requireSorted(roots, ["root_role"], "Inventory roots");
  requireSorted(artifacts, ["artifact_role", "root_role", "relative_path"], "Inventory artifacts");
  const artifactIds = new Set(artifacts.map(item => item.artifact_id));
  for (const license of licenses) {
    if (!artifactIds.has(license.license_text_artifact_id) || !artifactIds.has(license.review_record_artifact_id)) throw new Error(`License evidence artifacts are absent: ${license.license_id}`);
    const review = artifacts.find(item => item.artifact_id === license.review_record_artifact_id);
    const text = artifacts.find(item => item.artifact_id === license.license_text_artifact_id);
    if (review.sha256 !== license.review_record_sha256 || review.artifact_role !== "license_review"
      || text.artifact_role !== "license_text" || review.component_id !== license.component_id || text.component_id !== license.component_id
      || !review.license_ids.includes(license.license_id) || !text.license_ids.includes(license.license_id)) {
      throw new Error(`License evidence binding is invalid: ${license.license_id}`);
    }
  }
  for (const artifact of artifacts) {
    const component = components.find(item => item.component_id === artifact.component_id);
    if (!component || !component.artifact_roles.includes(artifact.artifact_role)
      || canonicalJson(artifact.license_ids) !== canonicalJson(component.license_ids)) throw new Error(`Artifact component or license binding is not closed: ${artifact.artifact_id}`);
  }
  const presentRoles = new Set(artifacts.filter(item => item.bytes > 0).map(item => item.artifact_role));
  for (const role of config.role_dispositions.filter(item => item.status === "required").map(item => item.role)) {
    if (!presentRoles.has(role)) throw new Error(`Required artifact role has no nonzero content: ${role}`);
  }
  const derivedComponents = components.map(component => {
    const content = artifacts.filter(item => item.component_id === component.component_id).map(item => ({
      artifact_role: item.artifact_role, root_role: item.root_role, relative_path: item.relative_path, bytes: item.bytes, sha256: item.sha256,
    }));
    return {
      ...component,
      content_identity_sha256: sha256(Buffer.from(`pdf-tools.artifact-component-content.v1\0${canonicalJson(content)}`)),
    };
  });
  const uniqueByContent = new Map();
  for (const item of artifacts) uniqueByContent.set(`${item.sha256}:${item.bytes}`, item.bytes);
  return digestInventory({
    inventory_id: PHASE1_ARTIFACT_INVENTORY_ID, inventory_version: 1, candidate_id: config.candidate_id,
    state: licenses.some(item => item.status === "pending_review") ? "captured_review_pending" : "captured_incomplete",
    role_dispositions: structuredClone(config.role_dispositions), roots, components: derivedComponents, licenses, artifacts,
    logical_bytes: artifacts.reduce((total, item) => total + item.bytes, 0),
    unique_content_bytes: [...uniqueByContent.values()].reduce((total, value) => total + value, 0),
  });
}

export function verifyArtifactInventory(inventory, expected) {
  if (canonicalJson(inventory) !== canonicalJson(expected)) throw new Error("Artifact inventory differs from the independently rebuilt trusted inventory");
  const { inventory_self_sha256: retained, ...otherDigests } = inventory.digests;
  const recomputed = sha256(Buffer.from(`pdf-tools.artifact-inventory-self.v1\0${canonicalJson({ ...inventory, digests: { ...otherDigests, inventory_self_sha256: null } })}`));
  if (retained !== recomputed) throw new Error("Artifact inventory self digest is invalid");
  return true;
}

export async function attestArtifactImmutability(config, operation, options = {}) {
  const before = await buildArtifactInventory(config, options);
  let value;
  let operationError = null;
  try {
    value = await operation(before);
  } catch (error) {
    operationError = error;
  }
  let after;
  try {
    after = await buildArtifactInventory(config, options);
    verifyArtifactInventory(after, before);
  } catch (driftError) {
    const error = new Error(`Candidate artifact deployment changed during execution: ${driftError.message}`);
    error.code = "ARTIFACT_DEPLOYMENT_DRIFT";
    error.cause = driftError;
    throw error;
  }
  if (operationError) throw operationError;
  return { value, before, after };
}
