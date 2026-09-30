import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import { constants } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { parseStrictJson } from "../scripts/eval-strict-json.mjs";

// The adapter is separately installed, never supplied by a model argument.
// Change this pin only with the reviewed first-party Python adapter.
export const LOCAL_OCR_HELPER_SHA256 = "2991b9e68dd7327813292126f8ae4398546662187799ff92b6446b591e825991";
const SHA256 = /^[a-f0-9]{64}$/u;
const MAX_SOURCE = 50 * 1024 * 1024;
const MAX_PNG = 25 * 1024 * 1024;
const MAX_INLINE_PNG = 4 * 1024 * 1024;
const MAX_JSON = 4 * 1024 * 1024;
const MAX_RETURNED = 200;
const children = new Set();
const sha = bytes => createHash("sha256").update(bytes).digest("hex");

export const LOCAL_OCR_TOOL_DEFINITION = Object.freeze({
  name: "propose_pdf_ocr",
  description: "Explicitly opt in to separately installed local macOS OCR for ONE PDF page. Requires the exact get_pdf_identity SHA and confirm_local_ocr=true. Returns unverified word proposals, a source-render replay and a private offline review file. Engine scores are not correctness. Never replaces native text or edits the PDF. At most 200 words are returned; the full bounded proposal is retained for review. Optional adapter setup is required; no engine is bundled.",
  inputSchema: {
    type: "object", additionalProperties: false,
    properties: {
      pdf_path: { type: "string" },
      page: { type: "integer", minimum: 1, maximum: 10000 },
      expected_source_sha256: { type: "string", pattern: "^[a-f0-9]{64}$" },
      confirm_local_ocr: { const: true },
    },
    required: ["pdf_path", "page", "expected_source_sha256", "confirm_local_ocr"],
  },
  annotations: { title: "Propose Local OCR", readOnlyHint: false,
    destructiveHint: false, idempotentHint: false, openWorldHint: false },
});

const digestSchema = { type: "string", pattern: "^[a-f0-9]{64}$" };
export const LOCAL_OCR_OUTPUT_SCHEMA = {
  type: "object", additionalProperties: false,
  properties: {
    status: { const: "source_render_replayed_ocr_unverified" },
    source_pdf_sha256: digestSchema, page_number: { type: "integer", minimum: 1 },
    proposal_sha256: digestSchema, render_png_sha256: digestSchema,
    helper_sha256: digestSchema, review_html_sha256: digestSchema,
    review_html_path: { type: "string" }, proposal_directory: { type: "string" },
    observation_count: { type: "integer", minimum: 0, maximum: 1000 },
    returned_observation_count: { type: "integer", minimum: 0, maximum: MAX_RETURNED },
    omitted_observation_count: { type: "integer", minimum: 0, maximum: 1000 },
    inline_image_returned: { type: "boolean" },
    proposals: { type: "array", maxItems: MAX_RETURNED, items: {
      type: "object", additionalProperties: false,
      properties: {
        observation_index: { type: "integer", minimum: 0 },
        text_proposal: { type: "string", minLength: 1, maxLength: 500 },
        engine_confidence_unverified: { type: "number", minimum: 0, maximum: 1 },
        box_top_left_pixels: { type: "array", minItems: 4, maxItems: 4,
          items: { type: "number", minimum: 0 } },
      },
      required: ["observation_index", "text_proposal", "engine_confidence_unverified", "box_top_left_pixels"],
    } },
  },
  required: ["status", "source_pdf_sha256", "page_number", "proposal_sha256", "render_png_sha256",
    "helper_sha256", "review_html_sha256", "review_html_path", "proposal_directory",
    "observation_count", "returned_observation_count", "omitted_observation_count",
    "inline_image_returned", "proposals"],
};

export function validateLocalOcrResult(result) {
  requireThat(result.proposals.length === result.returned_observation_count
    && result.returned_observation_count + result.omitted_observation_count === result.observation_count
    && result.proposals.every((item, index) => item.observation_index === index),
  "Local OCR returned-observation accounting is invalid.");
}

function requireThat(condition, message) {
  if (!condition) throw new Error(message);
}

async function readPhysicalFile(file, max, privateFile = false) {
  const handle = await fs.open(file, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const before = await handle.stat();
    requireThat(before.isFile() && before.size > 0 && before.size <= max,
      "Local OCR requires a bounded regular file.");
    requireThat(!privateFile || (before.mode & 0o777) === 0o600,
      "Local OCR retained files must be private (0600).");
    const bytes = Buffer.alloc(before.size);
    let offset = 0;
    while (offset < bytes.length) {
      const read = await handle.read(bytes, offset, bytes.length - offset, offset);
      if (!read.bytesRead) break;
      offset += read.bytesRead;
    }
    const after = await handle.stat();
    const current = await fs.lstat(file);
    requireThat(offset === bytes.length && current.isFile()
      && ["dev", "ino", "size", "mtimeMs", "ctimeMs"].every(key => before[key] === after[key])
      && current.dev === after.dev && current.ino === after.ino,
    "Local OCR input changed while it was read.");
    return bytes;
  } finally { await handle.close(); }
}

async function writePrivate(file, bytes) {
  const handle = await fs.open(file, "wx", 0o600);
  try { await handle.writeFile(bytes); await handle.sync(); }
  finally { await handle.close(); }
}

async function privateDirectory(directory) {
  await fs.mkdir(directory, { mode: 0o700 }).catch(error => {
    if (error.code !== "EEXIST") throw error;
  });
  const observed = await fs.lstat(directory);
  requireThat(observed.isDirectory() && !observed.isSymbolicLink()
    && (observed.mode & 0o777) === 0o700,
  "Local OCR state directory must be a physical private directory (0700).");
  return fs.realpath(directory);
}

function killAdapter(child) {
  try { process.kill(-child.pid, "SIGKILL"); } catch {}
}

export async function terminateLocalOcrAdapters() {
  for (const record of children) killAdapter(record.child);
  await Promise.allSettled([...children].map(record => record.closed));
}

export function forceTerminateLocalOcrAdapters() {
  for (const record of children) killAdapter(record.child);
}

export function runLocalOcrAdapter(python, helper, args, deadline) {
  requireThat(deadline > Date.now(), "Local OCR attempt exceeded its time limit.");
  return new Promise((resolve, reject) => {
    const child = spawn(python, ["-I", "-B", helper, ...args], {
      shell: false, detached: true, stdio: ["ignore", "pipe", "pipe"],
      // No provider credentials, host Python path or shell hooks are forwarded.
      env: { PATH: "/usr/bin:/bin", PYTHONDONTWRITEBYTECODE: "1" },
    });
    let finish;
    const record = { child, closed: new Promise(done => { finish = done; }) };
    children.add(record);
    const chunks = [];
    let outputBytes = 0;
    let stderrBytes = 0;
    let failure = null;
    const fail = message => { failure ??= new Error(message); killAdapter(child); };
    const timer = setTimeout(() => fail("Local OCR attempt exceeded its time limit."), deadline - Date.now());
    child.stdout.on("data", bytes => {
      outputBytes += bytes.length;
      if (outputBytes > MAX_JSON) fail("Local OCR adapter output exceeded its limit.");
      else chunks.push(bytes);
    });
    child.stderr.on("data", bytes => {
      stderrBytes += bytes.length;
      if (stderrBytes > 256 * 1024) fail("Local OCR adapter diagnostics exceeded their limit.");
    });
    child.on("error", () => { failure ??= new Error("Optional local OCR adapter could not start. Check its separate installation."); });
    child.on("close", code => {
      // The parent can exit while a same-group descendant has redirected its
      // pipes. Close that group before dropping deadline/shutdown tracking.
      killAdapter(child);
      clearTimeout(timer); children.delete(record); finish();
      if (failure) reject(failure);
      else if (code !== 0) reject(new Error("Optional local OCR adapter failed. Check the separate macOS installation, supported PDF and page; no verified OCR result was returned."));
      else {
        try { resolve(parseStrictJson(Buffer.concat(chunks).toString("utf8"), "Local OCR adapter output")); }
        catch (error) { reject(error); }
      }
    });
  });
}

export function createLocalOcrToolHandler({
  configuration, stateRoot, resolvePdfPath, readPdfBytes,
  platform = process.platform, invokeAdapter = runLocalOcrAdapter,
  expectedHelperSha256 = LOCAL_OCR_HELPER_SHA256,
}) {
  let busy = false;
  return async args => {
    requireThat(configuration, "Local OCR is not configured. It is optional and disabled by default.");
    requireThat(platform === "darwin", "This optional local OCR adapter currently requires macOS.");
    requireThat(args && typeof args === "object" && !Array.isArray(args)
      && Object.keys(args).every(key => ["pdf_path", "page", "expected_source_sha256", "confirm_local_ocr"].includes(key)),
    "Local OCR arguments are invalid.");
    requireThat(args.confirm_local_ocr === true, "Explicit confirm_local_ocr=true is required.");
    requireThat(typeof args.pdf_path === "string" && args.pdf_path.length > 0
      && Number.isInteger(args.page) && args.page >= 1 && args.page <= 10000
      && typeof args.expected_source_sha256 === "string" && SHA256.test(args.expected_source_sha256),
    "Local OCR requires a path, one page and the exact source SHA-256.");
    requireThat(!busy, "Another local OCR request is active. Wait for it to finish.");
    busy = true;
    try {
      requireThat(typeof configuration.pythonPath === "string" && path.isAbsolute(configuration.pythonPath)
        && typeof configuration.helperPath === "string" && path.isAbsolute(configuration.helperPath),
      "Configure absolute localOCR.pythonPath and localOCR.helperPath in the host configuration.");
      // Preserve the venv invocation path: executing its realpath directly
      // would discard the venv's separately installed packages.
      const python = configuration.pythonPath;
      const pythonStat = await fs.stat(await fs.realpath(python));
      requireThat(pythonStat.isFile() && (pythonStat.mode & 0o111) !== 0,
        "The configured local OCR Python must be an executable file.");
      const helper = await readPhysicalFile(configuration.helperPath, 128 * 1024);
      requireThat(sha(helper) === expectedHelperSha256, "The separately installed local OCR helper does not match this reviewed version.");
      const sourcePath = resolvePdfPath(args.pdf_path); // Enforces the existing folder allowlist.
      const source = await readPdfBytes(sourcePath);
      requireThat(Buffer.isBuffer(source) && source.length > 0 && source.length <= MAX_SOURCE
        && source.subarray(0, 5).toString("ascii") === "%PDF-"
        && sha(source) === args.expected_source_sha256,
      "Local OCR source bytes do not match the requested PDF identity or size limit.");
      const root = await privateDirectory(stateRoot);
      const job = await fs.mkdtemp(path.join(root, "proposal-"));
      await fs.chmod(job, 0o700);
      const snapshotPath = path.join(job, "source.pdf");
      const helperPath = path.join(job, "adapter.py");
      const proposalDirectory = path.join(job, "proposal");
      const reviewPath = path.join(job, "review.html");
      await writePrivate(snapshotPath, source);
      await writePrivate(helperPath, helper); // Use the hashed bytes, not a later path lookup.
      const deadline = Date.now() + 120_000;
      const generated = await invokeAdapter(python, helperPath, ["--pdf", snapshotPath,
        "--page", String(args.page), "--expect-source-sha256", args.expected_source_sha256,
        "--output-dir", proposalDirectory], deadline);
      requireThat(generated?.status === "unverified_ocr_proposal"
        && generated.source_pdf_sha256 === args.expected_source_sha256
        && SHA256.test(generated.proposal_sha256 ?? ""), "Local OCR generation binding is invalid.");
      const replay = await invokeAdapter(python, helperPath, ["--pdf", snapshotPath,
        "--expect-source-sha256", args.expected_source_sha256,
        "--verify-proposal-dir", proposalDirectory,
        "--expect-proposal-sha256", generated.proposal_sha256, "--review-html", reviewPath], deadline);
      requireThat(replay?.status === "source_render_replayed_ocr_unverified"
        && replay.source_pdf_sha256 === args.expected_source_sha256
        && replay.proposal_sha256 === generated.proposal_sha256
        && replay.page_number === args.page, "Local OCR source-render replay did not match.");
      const inventory = (await fs.readdir(proposalDirectory)).sort();
      requireThat(inventory.join(",") === "commit.json,proposal.json,render.png", "Local OCR retained inventory is incomplete or unexpected.");
      const proposalBytes = await readPhysicalFile(path.join(proposalDirectory, "proposal.json"), MAX_JSON, true);
      const proposal = parseStrictJson(proposalBytes.toString("utf8"), "Local OCR proposal");
      const commit = parseStrictJson((await readPhysicalFile(path.join(proposalDirectory, "commit.json"), 4096, true)).toString("utf8"), "Local OCR commit");
      const image = await readPhysicalFile(path.join(proposalDirectory, "render.png"), MAX_PNG, true);
      const review = await readPhysicalFile(reviewPath, 40 * 1024 * 1024, true);
      requireThat(commit.schema === "pdf-tools.local-ocr-commit.v1"
        && commit.proposal_file_sha256 === sha(proposalBytes)
        && commit.proposal_sha256 === generated.proposal_sha256
        && commit.render_png_sha256 === sha(image)
        && proposal.proposal_sha256 === replay.proposal_sha256
        && proposal.render_png_sha256 === sha(image) && replay.render_png_sha256 === sha(image)
        && replay.review_html_sha256 === sha(review)
        && proposal.page_number === args.page && proposal.source_pdf_sha256 === args.expected_source_sha256
        && Array.isArray(proposal.proposals) && proposal.proposals.length === replay.observation_count,
      "Local OCR retained bytes do not match the completed replay.");
      // Do not return a proposal for an original that changed during OCR.
      requireThat(sha(await readPdfBytes(resolvePdfPath(args.pdf_path))) === args.expected_source_sha256,
        "The original PDF changed during local OCR. No proposal was returned.");
      const observations = proposal.proposals.slice(0, MAX_RETURNED);
      const structuredContent = {
        status: "source_render_replayed_ocr_unverified",
        source_pdf_sha256: args.expected_source_sha256, page_number: args.page,
        proposal_sha256: replay.proposal_sha256, render_png_sha256: sha(image),
        helper_sha256: sha(helper), review_html_sha256: sha(review),
        review_html_path: reviewPath, proposal_directory: proposalDirectory,
        observation_count: proposal.proposals.length, returned_observation_count: observations.length,
        omitted_observation_count: proposal.proposals.length - observations.length,
        inline_image_returned: image.length <= MAX_INLINE_PNG,
        proposals: observations,
      };
      return { structuredContent, content: [
        { type: "text", text: `Local OCR proposed ${structuredContent.observation_count} observations for page ${args.page}. `
          + `These words are UNVERIFIED; engine scores are not correctness. Review against the original image. `
          + `${structuredContent.omitted_observation_count} observations omitted from this response; all are retained in the private review. `
          + `Offline review: ${reviewPath}. The original PDF and its native text were not changed.` },
        ...(structuredContent.inline_image_returned ? [{ type: "image", mimeType: "image/png", data: image.toString("base64") }] : []),
      ] };
    } finally { busy = false; }
  };
}
