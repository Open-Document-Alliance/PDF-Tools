/**
 * The packagers' server allow-lists against the real contents of `server/`.
 *
 * Both packagers name the server modules they ship explicitly, which is the
 * right default — a directory walk would let an untracked scratch file reach a
 * shipped artifact. The failure mode of an allow-list is the opposite one, and
 * it is silent: a module added to `server/` and imported by another module,
 * but never added to the list, is simply absent from the archive. Every
 * structural check downstream still passes, because each of them compares the
 * staged tree against the same short list, and the omission only surfaces when
 * a host starts the extension and Node cannot resolve the import.
 *
 * That is exactly what happened to `server/type3-cm-pk-reference.js`: three
 * separate allow-lists and one hand-written copy step never gained it, the
 * MCPB build reported success, and `npm run test:contract:share` died at
 * connection setup. These assertions make the lists derivable facts rather
 * than remembered ones.
 */
import { SKILL_FILES } from "../server/skills.js";
import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  SERVER_FILES,
  VERIFIED_EXTRACTION_RUNTIME_FILES,
} from "../scripts/build-mcpb.mjs";
import { SHARE_FILES, SHARE_MIRRORED_FILES, SHARE_SERVER_FILES } from "../package-for-friend.js";
import {
  QPDF_WASM_RUNTIME_DIRECTORY,
  QPDF_WASM_RUNTIME_FILES,
} from "../scripts/qpdf-wasm-runtime.mjs";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const SERVER_DIR = path.join(REPO_ROOT, "server");
const SHARE_SERVER_DIR = path.join(REPO_ROOT, "pdf-toolkit-mcp-share", "server");
const SHARE_ROOT = path.join(REPO_ROOT, "pdf-toolkit-mcp-share");

async function sha256File(absolutePath) {
  return createHash("sha256").update(await fs.readFile(absolutePath)).digest("hex");
}

async function serverDirectoryFilenames(directory) {
  const entries = await fs.readdir(directory, { withFileTypes: true });
  for (const entry of entries) {
    expect(entry.isFile(), `${entry.name} under ${directory} is not a regular file`).toBe(true);
  }
  const names = entries.map(entry => entry.name).sort();
  // Guard against a readdir that silently returned nothing useful, which would
  // turn every equality below into a vacuous pass.
  expect(names.length).toBeGreaterThan(15);
  return names;
}

const serverFilenames = await serverDirectoryFilenames(SERVER_DIR);

describe("production packager server coverage", () => {
  it("stages exactly the modules that exist under server/", () => {
    expect([...SERVER_FILES].sort()).toEqual(serverFilenames);
  });

  it("names each module once", () => {
    expect(new Set(SERVER_FILES).size).toBe(SERVER_FILES.length);
  });
});

describe("share packager server coverage", () => {
  it("mirrors exactly the modules that exist under server/", () => {
    expect([...SHARE_SERVER_FILES].sort()).toEqual(serverFilenames.map(name => `server/${name}`));
  });

  it("mirrors the same modules the checked-in share tree carries", async () => {
    expect(await serverDirectoryFilenames(SHARE_SERVER_DIR)).toEqual(serverFilenames);
  });

  it("copies every mirrored path and nothing else", () => {
    // The copy step and the archive manifest are the same list, so a module
    // can no longer be archived without being copied or copied without being
    // archived.
    expect(SHARE_MIRRORED_FILES).toEqual([
      ...SKILL_FILES,
      ...SHARE_SERVER_FILES,
      ...VERIFIED_EXTRACTION_RUNTIME_FILES,
      "dist-ui/index.html",
      ...QPDF_WASM_RUNTIME_FILES,
    ]);
    for (const relativePath of SHARE_MIRRORED_FILES) expect(SHARE_FILES).toContain(relativePath);
  });

  it("names each path once", () => {
    expect(new Set(SHARE_FILES).size).toBe(SHARE_FILES.length);
  });
});

/**
 * The other half of the share bundle: the checked-in `pdf-toolkit-mcp-share/`
 * tree.
 *
 * `package-for-friend.js` refreshes that tree by copying every entry of
 * `SHARE_MIRRORED_FILES` verbatim out of the repository root, so byte parity
 * for exactly those paths is what the checked-in tree is supposed to satisfy
 * between packaging runs. Nothing asserted it. The allow-list checks above
 * compare *names*; the archive checks compare a staged tree against those same
 * names; and the one digest comparison in this file covers the vendored
 * qpdf-wasm runtime only. So editing a module under `server/` and forgetting
 * the mirror left every suite green and left the share bundle a change behind
 * the extension, which is what happened to the parse-time XFA refusal. `git
 * status` cannot report it either: both copies are tracked, and both are
 * clean.
 *
 * Coverage boundary: this asserts that every mirrored path matches, not that
 * the share tree carries nothing else. Extra files are caught for `server/` by
 * the listing assertion above and for the qpdf runtime directory by the one
 * below; for the skills, `scripts/` and `dist-ui/` entries they are not.
 */
describe("checked-in share tree parity", () => {
  it("carries a byte-identical copy of every path the packager mirrors", async () => {
    let compared = 0;
    for (const relativePath of SHARE_MIRRORED_FILES) {
      const segments = relativePath.split("/");
      // Compared as digests. The mirrored set includes a 2.4 MB WebAssembly
      // binary, and vitest's deep equality on a buffer that size is slow
      // enough to blow the suite's budget while naming the file no more
      // precisely than a digest mismatch does. A path missing from the share
      // tree fails here as an ENOENT that names it.
      expect(
        await sha256File(path.join(SHARE_ROOT, ...segments)),
        `pdf-toolkit-mcp-share/${relativePath} drifted from ${relativePath}`,
      ).toBe(await sha256File(path.join(REPO_ROOT, ...segments)));
      compared += 1;
    }
    expect(compared).toBe(SHARE_MIRRORED_FILES.length);
    // Guards against a mirrored list that has quietly shrunk to the handful of
    // paths that happen to agree, which would make the equality above vacuous.
    expect(compared).toBeGreaterThan(30);
    expect(SHARE_MIRRORED_FILES).toContain("server/index.js");
  });

  it("compares bytes rather than paths", async () => {
    // Known-answer control for the comparison above: the same file read twice
    // has to agree, and one byte of difference has to not. Without this, a
    // helper that returned a constant would pass the whole block.
    const witness = path.join(SERVER_DIR, "index.js");
    const bytes = await fs.readFile(witness);
    expect(await sha256File(witness)).toBe(createHash("sha256").update(bytes).digest("hex"));
    expect(await sha256File(witness)).not.toBe(
      createHash("sha256").update(Buffer.concat([bytes, Buffer.from("\n")])).digest("hex"),
    );
  });
});

/**
 * The same allow-list property, for the one shipped directory that is not
 * `server/`: the vendored QPDF WebAssembly runtime.
 *
 * It deliberately does not live under `server/`. Every assertion above
 * requires each entry of `server/` to be a regular file that the import-graph
 * walk can read as UTF-8 source, and a 2.4 MB WebAssembly binary is neither.
 * Putting it there would also force a second copy into
 * `pdf-toolkit-mcp-share/server/`, which has to stay byte-identical to
 * `server/`, so the exception would have to be made twice. It ships from
 * `vendor/qpdf-wasm/runtime/` instead, at that identical path in the checkout,
 * in the MCPB, and in the share ZIP.
 *
 * `server/qpdf-decrypt.js` loads it, but through a dynamic import resolved
 * against `import.meta.url` rather than a static `from "..."` specifier, so
 * the import-graph property below — which only follows static relative
 * specifiers between shipped `server/` modules — is unaffected. What guarantees
 * the runtime is actually present next to that module in every packaged tree is
 * the allow-list coverage asserted here, not the graph walk.
 */
describe("qpdf-wasm runtime packager coverage", () => {
  const RUNTIME_DIR = path.join(REPO_ROOT, ...QPDF_WASM_RUNTIME_DIRECTORY.split("/"));

  async function runtimeRelativePaths(root) {
    const found = [];
    const walk = async directory => {
      for (const entry of await fs.readdir(directory, { withFileTypes: true })) {
        const absolutePath = path.join(directory, entry.name);
        if (entry.isDirectory()) {
          await walk(absolutePath);
          continue;
        }
        expect(entry.isFile(), `${absolutePath} is not a regular file`).toBe(true);
        found.push(`${QPDF_WASM_RUNTIME_DIRECTORY}/${
          path.relative(root, absolutePath).split(path.sep).join("/")
        }`);
      }
    };
    await walk(root);
    // A readdir that returned nothing useful would make every equality below
    // a vacuous pass.
    expect(found.length).toBeGreaterThan(10);
    return found.sort();
  }

  it("ships exactly the files that exist under the runtime directory", async () => {
    expect([...QPDF_WASM_RUNTIME_FILES].sort()).toEqual(await runtimeRelativePaths(RUNTIME_DIR));
  });

  it("names each path once", () => {
    expect(new Set(QPDF_WASM_RUNTIME_FILES).size).toBe(QPDF_WASM_RUNTIME_FILES.length);
  });

  it("is shipped by both packagers", () => {
    for (const relativePath of QPDF_WASM_RUNTIME_FILES) {
      expect(SERVER_FILES).not.toContain(relativePath);
      expect(SHARE_FILES, `share packager does not archive ${relativePath}`).toContain(relativePath);
      expect(SHARE_MIRRORED_FILES, `share packager does not mirror ${relativePath}`).toContain(relativePath);
    }
  });

  it("carries the complete notice directory into both packagers", () => {
    const notices = QPDF_WASM_RUNTIME_FILES.filter(relativePath =>
      relativePath.startsWith(`${QPDF_WASM_RUNTIME_DIRECTORY}/licenses/`));
    // qpdf, its bundled-code notice, zlib, libjpeg-turbo, the Emscripten
    // runtime, musl, compiler-rt, libc++, libc++abi, libunwind, and the
    // manifest that binds them.
    expect(notices.length).toBe(11);
    expect(notices).toContain(`${QPDF_WASM_RUNTIME_DIRECTORY}/licenses/manifest.json`);
    expect(notices).toContain(`${QPDF_WASM_RUNTIME_DIRECTORY}/licenses/QPDF-LICENSE.txt`);
  });

  it("carries exactly these runtime files in the checked-in share tree", async () => {
    // The bytes of each of these paths are compared, along with every other
    // mirrored path, by "checked-in share tree parity" above. What this adds
    // is the direction a per-path digest loop cannot see: the share tree's
    // runtime directory holds no file the manifest does not name, so a
    // promoted build that dropped a file cannot leave the old one behind.
    expect(
      await runtimeRelativePaths(path.join(SHARE_ROOT, ...QPDF_WASM_RUNTIME_DIRECTORY.split("/"))),
    ).toEqual([...QPDF_WASM_RUNTIME_FILES].sort());
  });
});

/**
 * The property the allow-lists exist to protect: a staged tree that can
 * actually resolve its own imports. Checked against the import graph rather
 * than against another list, so a module reachable from the entry point has to
 * be shipped whatever any list happens to say.
 */
describe("staged server import graph", () => {
  it("resolves every relative import of every shipped module inside the shipped set", async () => {
    let relativeImports = 0;
    for (const filename of serverFilenames) {
      const source = await fs.readFile(path.join(SERVER_DIR, filename), "utf8");
      const specifiers = [...source.matchAll(/(?:^|[^\w$])(?:import|export)[^;'"]*?from\s*"(\.[^"]*)"/gmu)]
        .map(match => match[1]);
      for (const specifier of specifiers) {
        relativeImports += 1;
        const resolved = path.relative(SERVER_DIR, path.resolve(SERVER_DIR, specifier));
        const resolvedFromRoot = path.relative(REPO_ROOT, path.resolve(SERVER_DIR, specifier))
          .split(path.sep).join("/");
        if (VERIFIED_EXTRACTION_RUNTIME_FILES.includes(resolvedFromRoot)) {
          expect(SHARE_FILES).toContain(resolvedFromRoot);
          continue;
        }
        expect(
          SERVER_FILES,
          `${filename} imports ${specifier}, which the production packager does not stage`,
        ).toContain(resolved);
        expect(
          SHARE_SERVER_FILES,
          `${filename} imports ${specifier}, which the share packager does not mirror`,
        ).toContain(`server/${resolved}`);
      }
    }
    expect(relativeImports).toBeGreaterThan(5);
  });

  it("resolves the verified extraction runtime import graph inside the shipped set", async () => {
    for (const relativePath of VERIFIED_EXTRACTION_RUNTIME_FILES) {
      const source = await fs.readFile(path.join(REPO_ROOT, relativePath), "utf8");
      const directory = path.dirname(path.join(REPO_ROOT, relativePath));
      const specifiers = [...source.matchAll(/(?:^|[^\w$])(?:import|export)[^;'"]*?from\s*"(\.[^"]*)"/gmu)]
        .map(match => match[1]);
      for (const specifier of specifiers) {
        const resolved = path.relative(REPO_ROOT, path.resolve(directory, specifier))
          .split(path.sep).join("/");
        expect(
          [...VERIFIED_EXTRACTION_RUNTIME_FILES, ...SERVER_FILES.map(name => `server/${name}`)],
          `${relativePath} imports ${specifier}, which neither packager stages`,
        ).toContain(resolved);
        expect(SHARE_FILES).toContain(resolved);
      }
    }
  });
});
