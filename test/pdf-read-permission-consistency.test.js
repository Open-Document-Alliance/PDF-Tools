/**
 * One rule, applied to the whole read family.
 *
 * `/P` governs writes. It does not govern reads. That sentence lives in
 * `server/qpdf-decrypt.js`, and this suite is what stops it drifting back into
 * being true of one tool and false of nineteen others — which is exactly the
 * state it was in before, and the reason the read gate was removed:
 * `read_pdf_fields` refused an owner-locked, extract-denied AES-256 document by
 * name while `read_pdf_content` returned 33,173 characters of the same file,
 * because PDF.js does not implement `/P` and never consulted it.
 *
 * Two kinds of assertion, because either alone is escapable.
 *
 *   - *Structural*: `encryption.capabilities` is read in exactly one function
 *     in `server/`. A rule enforced in one place is a rule; a rule enforced in
 *     two places is two rules that agree today.
 *   - *Behavioural*: every registered tool that reads a document is called
 *     against a matched pair of documents identical in everything but `/P` bit
 *     5, and must treat them the same. The family is derived from the live tool
 *     list rather than listed here, so a tool that joins it later is tested
 *     whether or not anybody remembered this file.
 *
 * A tool is in the read family if its schema names a PDF to operate on and it
 * is not in `ENCRYPTED_WRITE_OPERATIONS`, which is the product's own register
 * of everything that writes a PDF back. Both halves of that come from the
 * product, not from this suite.
 *
 * Fixtures are encrypted here rather than committed, with the runtime the
 * product itself uses.
 */
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createPrivatePdfUnlockHarness } from "./helpers/private-pdf-unlock.js";
import {
  ENCRYPTED_READ_OPERATIONS,
  ENCRYPTED_WRITE_OPERATIONS,
  PdfDecryptionError,
  decryptPdfForRead,
  decryptPdfForWrite,
  pdfPermissionRefusal,
} from "../server/qpdf-decrypt.js";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const PLAIN_PDF = path.join(REPO_ROOT, "example-fw9.pdf");
const EXTRACTION_PDF = path.join(
  REPO_ROOT,
  "test/fixtures/eval/extraction/synthetic/born-digital-flat.pdf",
);
const RUNTIME_ENTRY = path.join(REPO_ROOT, "vendor", "qpdf-wasm", "runtime", "qpdf.mjs");
const OWNER_PASSWORD = "owner-secret";

/**
 * The matched pair the whole suite turns on: same source document, same
 * AES-256, same empty user password, same denial of every modification. One
 * grants `/P` bit 5 and the other denies it, and nothing else differs. Any
 * tool that behaves differently across this pair is consulting the bit.
 */
const FIXTURE_RECIPES = Object.freeze({
  extractDenied: ["--encrypt", "--user-password=", `--owner-password=${OWNER_PASSWORD}`,
    "--bits=256", "--extract=n", "--modify=none", "--"],
  extractAllowed: ["--encrypt", "--user-password=", `--owner-password=${OWNER_PASSWORD}`,
    "--bits=256", "--extract=y", "--modify=none", "--"],
});

async function encryptFixture(sourceBytes, encryptArgs) {
  const createQpdf = (await import(RUNTIME_ENTRY)).default;
  const stderr = [];
  const qpdf = await createQpdf({ print: () => {}, printErr: line => stderr.push(String(line)) });
  qpdf.FS.writeFile("/in.pdf", new Uint8Array(sourceBytes));
  let status;
  try {
    status = qpdf.callMain([...encryptArgs, "/in.pdf", "/out.pdf"]);
  } catch (error) {
    status = Number.isInteger(error?.status) ? error.status : -1;
  }
  if (status !== 0) throw new Error(`fixture encryption failed (${status}): ${stderr.join(" ")}`);
  return Buffer.from(qpdf.FS.readFile("/out.pdf"));
}

let temporaryRoot;
let client;
let transport;
let unlock;
const fixturePaths = {};
let workspaceSequence = 0;

beforeAll(async () => {
  // macOS exposes its temporary directory through /var -> /private/var.
  // Workspaces deliberately reject aliased parents; use the physical test root
  // rather than weakening that production boundary.
  temporaryRoot = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "pdf-tools-permission-consistency-")));
  await fs.mkdir(path.join(temporaryRoot, "profiles"), { mode: 0o700 });
  const plainBytes = await fs.readFile(PLAIN_PDF);
  fixturePaths.plain = path.join(temporaryRoot, "plain.pdf");
  await fs.writeFile(fixturePaths.plain, plainBytes);
  for (const [name, args] of Object.entries(FIXTURE_RECIPES)) {
    const target = path.join(temporaryRoot, `${name}.pdf`);
    await fs.writeFile(target, await encryptFixture(plainBytes, args));
    fixturePaths[name] = target;
  }
  const extractionBytes = await fs.readFile(EXTRACTION_PDF);
  for (const [name, args] of Object.entries(FIXTURE_RECIPES)) {
    const directory = path.join(temporaryRoot, `${name}-extraction`);
    await fs.mkdir(directory, { mode: 0o700 });
    const target = path.join(directory, "extraction.pdf");
    await fs.writeFile(target, await encryptFixture(extractionBytes, args));
    fixturePaths[`${name}Extraction`] = target;
  }
  unlock = await createPrivatePdfUnlockHarness(temporaryRoot);
  transport = new StdioClientTransport({
    command: process.execPath,
    args: [path.join(REPO_ROOT, "server/index.js")],
    cwd: REPO_ROOT,
    env: {
      ...unlock.env,
      ALLOWED_DIRECTORIES: [REPO_ROOT, temporaryRoot].join(path.delimiter),
      DEFAULT_PROFILES_DIR: path.join(temporaryRoot, "profiles"),
    },
    stderr: "ignore",
  });
  client = new Client({ name: "pdf-tools-permission-consistency", version: "1.0.0" });
  await client.connect(transport);
}, 180_000);

afterAll(async () => {
  await client?.close();
  await transport?.close();
  if (temporaryRoot) await fs.rm(temporaryRoot, { recursive: true, force: true });
});

/*
 * How to call each member of the read family with one document. Arguments only
 * — no expectations live here, because what is asserted is that the *same* call
 * behaves the same way on two documents, not that any particular call succeeds.
 *
 * If a tool joins the read family and is not in this table, the suite fails and
 * says so. That is deliberate: the alternative is a new tool silently escaping
 * the rule, which is the failure this whole file exists to prevent.
 */
async function extractionWorkspace(document, tag, { leafNames = ["missing"] } = {}) {
  const sourceDocument = document === fixturePaths.extractDenied
    ? fixturePaths.extractDeniedExtraction
    : fixturePaths.extractAllowedExtraction;
  workspaceSequence += 1;
  const workspaceId = `permission-${workspaceSequence}-${tag.replace(/[^a-z0-9_-]/gu, "-")}`;
  const created = await client.callTool({
    name: "create_extraction_workspace",
    arguments: {
      pdf_path: sourceDocument,
      workspace_id: workspaceId,
      schema: {
        type: "object",
        additionalProperties: false,
        required: leafNames,
        properties: Object.fromEntries(leafNames.map(leaf => [
          leaf, { anyOf: [{ type: "string" }, { type: "null" }] },
        ])),
      },
    },
  });
  expect(created.isError, responseText(created)).not.toBe(true);
  const chunks = await client.callTool({
    name: "read_extraction_workspace",
    arguments: {
      workspace_id: workspaceId,
      workspace_identity_sha256: created.structuredContent.workspace_identity_sha256,
      collection: "document_map_chunks",
      limit: 100,
    },
  });
  expect(chunks.isError, responseText(chunks)).not.toBe(true);
  expect(chunks.structuredContent.items.length).toBeGreaterThan(0);
  return {
    workspaceId,
    sourceDocument,
    created: created.structuredContent,
    chunks: chunks.structuredContent.items,
  };
}

const READ_CALL_RECIPES = Object.freeze({
  compare_pdfs: (doc, extras) => ({
    before_pdf_path: doc,
    after_pdf_path: fixturePaths.plain,
    include_visual: false,
  }),
  convert_pdf_to_markdown: (doc, extras) => ({ pdf_path: doc, start_page: 1, end_page: 1, ...extras }),
  create_extraction_workspace: (doc, extras) => ({
    pdf_path: doc === fixturePaths.extractDenied
      ? fixturePaths.extractDeniedExtraction
      : fixturePaths.extractAllowedExtraction,
    workspace_id: `permission-create-${path.basename(doc, ".pdf")}${extras.tag}`
      .replace(/[^a-z0-9_-]/gu, "-"),
    schema: { type: "object", properties: { value: { type: "string" } } },
  }),
  detect_signature_zones: (doc, extras) => ({ pdf_path: doc, ...extras }),
  display_pdf: doc => ({ pdf_path: doc }),
  extract_to_csv: (doc, extras) => ({
    pdf_paths: [doc],
    output_csv: path.join(temporaryRoot, `${path.basename(doc, ".pdf")}${extras.tag}.csv`),
  }),
  get_page_analysis: (doc, extras) => ({ pdf_path: doc, ...extras }),
  get_pdf_identity: doc => ({ pdf_path: doc }),
  get_pdf_info: (doc, extras) => ({ pdf_path: doc, ...extras }),
  get_pdf_resource_uri: doc => ({ pdf_path: doc }),
  inspect_pdf_accessibility: doc => ({ pdf_path: doc }),
  prepare_lumin_request: doc => ({ pdf_path: doc }),
  read_extraction_chunk: async (doc, extras) => {
    const prepared = await extractionWorkspace(doc, `chunk${extras.tag}`);
    return {
      pdf_path: prepared.sourceDocument,
      workspace_id: prepared.workspaceId,
      workspace_identity_sha256: prepared.created.workspace_identity_sha256,
      chunk_id: prepared.chunks[0].chunk_id,
    };
  },
  read_pdf_bytes: doc => ({ pdf_path: doc, offset: 0, byteCount: 4096 }),
  read_pdf_content: doc => ({ pdf_path: doc }),
  read_pdf_fields: (doc, extras) => ({ pdf_path: doc, ...extras }),
  read_pdf_layout: (doc, extras) => ({ pdf_path: doc, start_page: 1, end_page: 1, ...extras }),
  read_pdf_pages: doc => ({ pdf_path: doc, start_page: 1, end_page: 1 }),
  render_pdf_page: (doc, extras) => ({ pdf_path: doc, page: 1, ...extras }),
  render_pdf_region: (doc, extras) => ({
    pdf_path: doc, page: 1, x: 0, y: 0, width: 200, height: 200, ...extras,
  }),
  review_extraction_workspace: async (doc, extras) => {
    // Review hashes the original bytes and reads retained evidence; it has no
    // password argument. Private entry precedes creation in the test context.
    const prepared = await extractionWorkspace(doc, `review${extras.tag}`);
    return {
      pdf_path: prepared.sourceDocument,
      workspace_id: prepared.workspaceId,
      workspace_identity_sha256: prepared.created.workspace_identity_sha256,
      expected_generation_sha256: prepared.created.generation_sha256,
      view: "leaves",
      limit: 20,
    };
  },
  search_pdf_text: doc => ({ pdf_path: doc, query: "Name" }),
  set_active_document: doc => ({ pdf_path: doc }),
  validate_pdf: (doc, extras) => ({ pdf_path: doc, ...extras }),
  verify_extraction_batch: async (doc, extras) => {
    const leafNames = ["first", "second"];
    const prepared = await extractionWorkspace(doc, `batch${extras.tag}`, {
      leafNames,
    });
    let generation = prepared.created.generation_sha256;
    const items = [];
    for (const leaf of leafNames) {
      const proposal = await client.callTool({
        name: "submit_extraction_proposal",
        arguments: {
          workspace_id: prepared.workspaceId,
          workspace_identity_sha256: prepared.created.workspace_identity_sha256,
          parent_generation_sha256: generation,
          leaf_pointer: `/${leaf}`,
          proposed_value: null,
          chunk_ids: prepared.chunks.map(chunk => chunk.chunk_id),
        },
      });
      expect(proposal.isError, responseText(proposal)).not.toBe(true);
      generation = proposal.structuredContent.generation_sha256;
      items.push({
        proposal_event_id: proposal.structuredContent.event.event_id,
        citations: [],
        method: { kind: "not_found" },
      });
    }
    return {
      pdf_path: prepared.sourceDocument,
      workspace_id: prepared.workspaceId,
      workspace_identity_sha256: prepared.created.workspace_identity_sha256,
      parent_generation_sha256: generation,
      items,
    };
  },
  verify_extraction_proposal: async (doc, extras) => {
    const prepared = await extractionWorkspace(doc, `verify${extras.tag}`);
    const proposal = await client.callTool({
      name: "submit_extraction_proposal",
      arguments: {
        workspace_id: prepared.workspaceId,
        workspace_identity_sha256: prepared.created.workspace_identity_sha256,
        parent_generation_sha256: prepared.created.generation_sha256,
        leaf_pointer: "/missing",
        proposed_value: null,
        chunk_ids: prepared.chunks.map(chunk => chunk.chunk_id),
      },
    });
    expect(proposal.isError, responseText(proposal)).not.toBe(true);
    return {
      pdf_path: prepared.sourceDocument,
      workspace_id: prepared.workspaceId,
      workspace_identity_sha256: prepared.created.workspace_identity_sha256,
      proposal_generation_sha256: proposal.structuredContent.generation_sha256,
      proposal_event_id: proposal.structuredContent.event.event_id,
      citations: [],
      method: { kind: "not_found" },
    };
  },
  verify_table_proposal: (doc, extras) => ({
    pdf_path: doc,
    region_id: "p1-t1",
    proposal_token: "0".repeat(64),
    cells: [{ row: 0, column: 0, rowspan: 1, colspan: 1, item_ids: [] }],
  }),
});

const DOCUMENT_PARAMETERS = Object.freeze([
  "pdf_path", "pdf_paths", "before_pdf_path", "after_pdf_path", "input_path", "input_paths",
]);

async function readFamily() {
  const { tools } = await client.listTools();
  const writes = new Set(Object.keys(ENCRYPTED_WRITE_OPERATIONS));
  return tools
    .filter(tool => Object.keys(tool.inputSchema?.properties ?? {})
      .some(property => DOCUMENT_PARAMETERS.includes(property)))
    .filter(tool => !writes.has(tool.name))
    // These manage a credential session; they do not read PDF content.
    .filter(tool => !["unlock_pdf", "get_pdf_unlock_status", "lock_pdf"].includes(tool.name))
    .map(tool => tool.name)
    .sort();
}

const responseText = result => (result.content ?? [])
  .map(entry => entry.text ?? (entry.type === "image" ? `[image:${entry.data?.length ?? 0}]` : ""))
  .join(" ");

/**
 * Everything about an outcome that the permission question cares about, and
 * nothing that would differ between two files merely because they are two
 * files. Names, sizes and digests are erased; whether the call worked, and what
 * it refused for if it did not, survives.
 */
async function preparePrivateReadContext(document, privatePassword) {
  const extraction = document === fixturePaths.extractDenied
    ? fixturePaths.extractDeniedExtraction : fixturePaths.extractAllowedExtraction;
  for (const source of [document, extraction]) {
    if (privatePassword === undefined) await unlock.lock(client, source);
    else await unlock.enter(client, source, privatePassword);
  }
}

async function observe(name, document, { privatePassword, privateContextPrepared = false, ...extras } = { tag: "" }) {
  const build = READ_CALL_RECIPES[name];
  let result;
  try {
    if (!privateContextPrepared) await preparePrivateReadContext(document, privatePassword);
    result = await client.callTool({ name, arguments: await build(document, extras) });
  } catch (error) {
    return { outcome: "transport-error", detail: String(error?.message ?? error).slice(0, 80) };
  }
  const text = responseText(result);
  const normalized = text
    .replaceAll(path.basename(document), "<fixture>")
    // Also without the extension, because tools that derive an output name from
    // the input carry the stem rather than the file name.
    .replaceAll(path.basename(document, ".pdf"), "<fixture>")
    .replaceAll(temporaryRoot, "<root>")
    .replace(/\b[0-9a-f]{64}\b/g, "<sha256>")
    .replace(/\b\d[\d.,]*\s?(?:KB|MB|bytes)\b/g, "<size>")
    .replace(/\s+/g, " ")
    .trim();
  if (result.isError !== true) return { outcome: "allowed", normalized };
  if (/\/P '|permissions deny/.test(text)) {
    return { outcome: "refused-on-/P", normalized };
  }
  return { outcome: "refused", normalized };
}

describe("the permission rule has exactly one home", () => {
  it("reads /P capabilities in exactly one function in the whole server", async () => {
    const serverFiles = (await fs.readdir(path.join(REPO_ROOT, "server")))
      .filter(name => name.endsWith(".js"));
    const readers = [];
    for (const file of serverFiles) {
      const source = await fs.readFile(path.join(REPO_ROOT, "server", file), "utf8");
      // Comments state the rule and must be allowed to; code that acts on the
      // bits is what may not be duplicated.
      const code = source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
      for (const match of code.matchAll(/encryption\??\.capabilities|\bcapabilities\?\.\[/g)) {
        readers.push({ file, index: match.index });
      }
    }
    // The one legitimate reader is the write branch. The worker validates the
    // shape it forwards and does not decide anything with it; it is a separate
    // file and is named here so the exemption is visible rather than pattern-
    // matched away.
    const decisionReaders = readers.filter(reader => reader.file !== "qpdf-decrypt-worker.js");
    expect(decisionReaders.map(reader => reader.file)).toEqual(
      decisionReaders.map(() => "qpdf-decrypt.js"),
    );
    const decryptSource = await fs.readFile(
      path.join(REPO_ROOT, "server", "qpdf-decrypt.js"), "utf8",
    );
    const writeBranch = decryptSource.slice(
      decryptSource.indexOf("export function writePermissionRefusal"),
    );
    // Every capability read sits inside `writePermissionRefusal`, and the read
    // path therefore cannot be consulting them.
    const readsInsideWriteBranch = [...writeBranch.matchAll(/encryption\??\.capabilities/g)];
    expect(readsInsideWriteBranch.length).toBe(decisionReaders.length);
  });

  it("routes both decryption intents through the same decision function", async () => {
    const source = await fs.readFile(path.join(REPO_ROOT, "server", "qpdf-decrypt.js"), "utf8");
    // Each `runDecryptionWorker` call passes exactly one permission callback,
    // and both of them are this function. A third intent, or a bespoke callback
    // beside them, is a second rule.
    expect([...source.matchAll(/pdfPermissionRefusal\(\{\s*\n\s*intent: "(read|write)"/g)]
      .map(match => match[1]).sort()).toEqual(["read", "write"]);
    expect(source.match(/runDecryptionWorker\(/g)).toHaveLength(3); // definition + two calls
    // The read path's old refusal reason is gone entirely. `write_permission_denied`
    // is a different string and is meant to still be here.
    expect(source).not.toMatch(/"permission_denied"/);
    expect(source).toMatch(/"write_permission_denied"/);
  });

  it("keeps the read registry free of any /P capability to require", () => {
    expect(Object.keys(ENCRYPTED_READ_OPERATIONS).length).toBeGreaterThan(0);
    for (const [operation, rules] of Object.entries(ENCRYPTED_READ_OPERATIONS)) {
      expect(Object.keys(rules), operation).toEqual(["activity"]);
    }
    // And the function says so directly: a document that denies everything is
    // still readable, and the same document is still not writable.
    const deniesEverything = {
      encrypted: true,
      ownerPasswordMatched: false,
      userPasswordMatched: true,
      capabilities: { extract: false, accessibility: false, modify: false, modifyforms: false },
    };
    for (const operation of Object.keys(ENCRYPTED_READ_OPERATIONS)) {
      expect(pdfPermissionRefusal({
        intent: "read", encryption: deniesEverything, suppliedPassword: null, operation,
      }), operation).toBeNull();
    }
    expect(pdfPermissionRefusal({
      intent: "write", encryption: deniesEverything, suppliedPassword: null, operation: "fill_pdf",
    })).toBeInstanceOf(PdfDecryptionError);
    expect(() => pdfPermissionRefusal({
      intent: "inspect", encryption: deniesEverything, suppliedPassword: null, operation: "fill_pdf",
    })).toThrow(TypeError);
  });
});

describe("every tool that reads a document treats /P the same way", () => {
  it("has a call recipe for every member of the read family", async () => {
    const family = await readFamily();
    expect(family.length).toBeGreaterThan(10);
    const missing = family.filter(name => !(name in READ_CALL_RECIPES));
    // If this fails, a tool that reads PDFs has joined the product without
    // joining this suite. Add it to READ_CALL_RECIPES; do not delete it from
    // the family.
    expect(missing).toEqual([]);
    // The reverse too, so the table cannot rot into describing tools that no
    // longer exist and quietly stop covering the ones that do.
    expect(Object.keys(READ_CALL_RECIPES).sort().filter(name => !family.includes(name)))
      .toEqual([]);
  }, 60_000);

  it("really reviews and batch-verifies both permission variants with or without the owner password", async () => {
    for (const document of [fixturePaths.extractDenied, fixturePaths.extractAllowed]) {
      for (const password of [undefined, OWNER_PASSWORD]) {
        await preparePrivateReadContext(document, password);
        for (const name of ["review_extraction_workspace", "verify_extraction_batch"]) {
          const args = await READ_CALL_RECIPES[name](document, { tag: "-nonvacuous" });
          const result = await client.callTool({ name, arguments: args });
          expect(result.isError, `${name}: ${responseText(result)}`).not.toBe(true);
          if (name === "review_extraction_workspace") {
            expect(result.structuredContent.extractionReview).toMatchObject({
              page_count: 1, summary: { leaves: 1, unproposed: 1 },
              items: [{ leaf_pointer: "/missing", status: "not_proposed" }],
            });
          } else {
            expect(result.structuredContent).toMatchObject({ state: "complete", generation_sequence: 3 });
            expect(result.structuredContent.results).toHaveLength(2);
            expect(result.structuredContent.results.map(item => item.leaf_pointer)).toEqual(["/first", "/second"]);
            for (const item of result.structuredContent.results) {
              expect(item).toMatchObject({ status: "unverified_reasoning", source_replayed: true,
                schema_replayed: true, reason_codes: ["ABSENCE_NOT_MECHANICALLY_PROVEN"] });
            }
          }
        }
      }
    }
  }, 180_000);

  it("cannot tell an extract-denied document from an extract-allowed one", async () => {
    const family = await readFamily();
    const divergent = [];
    const allowed = [];
    for (const name of family) {
      // Same tag on both sides on purpose: a tool that names an output file
      // after its inputs must produce a comparable name, or the comparison
      // measures the test's own bookkeeping rather than the product.
      const denied = await observe(name, fixturePaths.extractDenied, { tag: "-pair" });
      const permitted = await observe(name, fixturePaths.extractAllowed, { tag: "-pair" });
      if (denied.outcome === "allowed") allowed.push(name);
      if (denied.outcome !== permitted.outcome || denied.normalized !== permitted.normalized) {
        divergent.push({ name, denied, permitted });
      }
    }
    // The two documents are the same document with one bit flipped, so any
    // observable difference is the bit being consulted.
    expect(divergent.map(entry => entry.name)).toEqual([]);
    // Not vacuous: a strict majority of the family really does read these
    // documents, so "identical" is not "identically refused". Transactional
    // workspace tools may fail later on lifecycle/schema prerequisites; that
    // failure is intentionally compared above but is not a permission success.
    expect(allowed.length).toBeGreaterThan(Math.floor(family.length / 2));
  }, 600_000);

  it("refuses no read on /P, whatever else it may refuse on", async () => {
    // Two ways to be a `/P` refusal, because a gate can be reintroduced with
    // any wording at all: the message names the bit, or the same call succeeds
    // on the document that grants it. The second catches a silent one.
    const family = await readFamily();
    const onP = [];
    for (const name of family) {
      const denied = await observe(name, fixturePaths.extractDenied, { tag: "-p" });
      if (denied.outcome === "refused-on-/P") {
        onP.push(`${name} (named the bit)`);
        continue;
      }
      if (denied.outcome === "allowed") continue;
      const permitted = await observe(name, fixturePaths.extractAllowed, { tag: "-p" });
      if (permitted.outcome === "allowed") onP.push(`${name} (refused only the denying document)`);
    }
    expect(onP).toEqual([]);
  }, 600_000);

  it("closes the specific gap that prompted this: fields and content now agree", async () => {
    // The reported defect, pinned as its own case so a regression is legible
    // rather than one row in a table. read_pdf_fields refused; read_pdf_content
    // returned the whole document.
    const fields = await observe("read_pdf_fields", fixturePaths.extractDenied, { tag: "-gap" });
    const content = await observe("read_pdf_content", fixturePaths.extractDenied, { tag: "-gap" });
    expect([fields.outcome, content.outcome]).toEqual(["allowed", "allowed"]);
    // And the read is real, not an empty success: the fields come back matching
    // the same document read with no encryption at all.
    const plainFields = await client.callTool({
      name: "read_pdf_fields", arguments: { pdf_path: fixturePaths.plain },
    });
    const deniedFields = await client.callTool({
      name: "read_pdf_fields", arguments: { pdf_path: fixturePaths.extractDenied },
    });
    expect(deniedFields.structuredContent.fieldCount)
      .toBe(plainFields.structuredContent.fieldCount);
    expect(deniedFields.structuredContent.fieldCount).toBeGreaterThan(0);
  }, 120_000);

  it("never leaves a caller worse off for supplying the owner password", async () => {
    const family = await readFamily();
    const downgraded = [];
    const withoutOwner = new Map();
    // Group the two contexts so this matrix does not open dozens of browser
    // windows or exhaust the production entry rate limit. Every read in each
    // pass still reaches the real MCP tool with its exact document binding.
    for (const name of family) {
      withoutOwner.set(name, await observe(name, fixturePaths.extractDenied, { tag: "-nopw" }));
    }
    await preparePrivateReadContext(fixturePaths.extractDenied, OWNER_PASSWORD);
    for (const name of family) {
      const without = withoutOwner.get(name);
      const withOwner = await observe(
        name, fixturePaths.extractDenied, { tag: "-ownerpw", privateContextPrepared: true },
      );
      if (without.outcome === "allowed" && withOwner.outcome !== "allowed") {
        downgraded.push({ name, without, withOwner });
      }
    }
    expect(downgraded.map(entry => entry.name), JSON.stringify(downgraded, null, 2)).toEqual([]);
  }, 600_000);
});

describe("the write gate is the one that survived, and it still bites", () => {
  it("refuses the same document a read just returned, and the owner password changes that", async () => {
    // The pair that proves the rule is asymmetric rather than absent. Same
    // file, same call site in the product, opposite answers.
    const read = await observe("read_pdf_fields", fixturePaths.extractDenied, { tag: "-w" });
    expect(read.outcome).toBe("allowed");

    const refused = await client.callTool({
      name: "fill_pdf",
      arguments: {
        pdf_path: fixturePaths.extractDenied,
        output_path: path.join(temporaryRoot, "refused.pdf"),
        field_data: { "topmostSubform[0].Page1[0].f1_1[0]": "attempted" },
      },
    });
    expect(refused.isError).toBe(true);
    expect(responseText(refused)).toMatch(/permissions deny/);
    expect(responseText(refused)).toMatch(/modifyforms/);
    await expect(fs.access(path.join(temporaryRoot, "refused.pdf")))
      .rejects.toMatchObject({ code: "ENOENT" });

    const written = path.join(temporaryRoot, "owner-authorised.pdf");
    await unlock.enter(client, fixturePaths.extractDenied, OWNER_PASSWORD);
    const allowed = await client.callTool({
      name: "fill_pdf",
      arguments: {
        pdf_path: fixturePaths.extractDenied,
        output_path: written,
        field_data: { "topmostSubform[0].Page1[0].f1_1[0]": "authorised" },
      },
    });
    expect(allowed.isError).not.toBe(true);
    // And the protection came back with it: the owner password authorises the
    // change, not the removal of the lock.
    const bytes = await fs.readFile(written);
    expect(bytes.toString("latin1")).toContain("/Encrypt");
  }, 180_000);

  it("keeps that asymmetry at the module boundary too, not only through the server", async () => {
    const bytes = await fs.readFile(fixturePaths.extractDenied);
    const read = await decryptPdfForRead(bytes, null, "read_pdf_fields");
    try {
      expect(read.encryption.capabilities.extract).toBe(false);
      expect(read.plaintext.subarray(0, 5).toString("latin1")).toBe("%PDF-");
    } finally {
      read.release();
    }
    await expect(decryptPdfForWrite(bytes, null, "fill_pdf"))
      .rejects.toMatchObject({ reason: "write_permission_denied" });
  }, 120_000);
});
