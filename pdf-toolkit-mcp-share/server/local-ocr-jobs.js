import { createHash, randomUUID } from "node:crypto";
import { execFile } from "node:child_process";
import { constants } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { parseStrictJson } from "../scripts/eval-strict-json.mjs";
import { LOCAL_OCR_HELPER_SHA256 } from "./local-ocr-tools.js";
import { validateStructuredToolResult } from "./output-schemas.js";

const execFileAsync = promisify(execFile);
const MAX_PAGES = 20;
const MAX_PAGES_PER_CALL = 2;
const MAX_SOURCE = 50 * 1024 * 1024;
const MAX_STATE = 32 * 1024;
const SHA256 = /^[a-f0-9]{64}$/u;
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/u;
const PROPOSAL_ID = /^proposal-[A-Za-z0-9]{6}$/u;
const ARTIFACTS = Object.freeze({
  "source.pdf": MAX_SOURCE, "adapter.py": 128 * 1024,
  "proposal/proposal.json": 4 * 1024 * 1024, "proposal/commit.json": 4096,
  "proposal/render.png": 25 * 1024 * 1024, "review.html": 40 * 1024 * 1024,
});
const sha = bytes => createHash("sha256").update(bytes).digest("hex");
const jsonBytes = value => Buffer.from(`${JSON.stringify(value)}\n`);
const check = (condition, message) => { if (!condition) throw new Error(message); };
const ownKeys = (value, keys) => value && typeof value === "object" && !Array.isArray(value)
  && Object.keys(value).every(key => keys.includes(key)) && keys.every(key => Object.hasOwn(value, key));
const identity = stat => Object.fromEntries(["dev", "ino", "size", "mode", "mtimeNs", "ctimeNs"]
  .map(key => [key, String(stat[key])]));
const same = (left, right) => JSON.stringify(left) === JSON.stringify(right);
const annotations = title => ({ title, readOnlyHint: false, destructiveHint: false,
  idempotentHint: false, openWorldHint: false });
const jobProperties = {
  job_id: { type: "string", pattern: UUID.source },
  expected_job_identity_sha256: { type: "string", pattern: SHA256.source },
};

export const LOCAL_OCR_JOB_TOOL_DEFINITIONS = Object.freeze([
  {
    name: "start_pdf_ocr_job",
    description: "Create a private resumable local OCR job for at most 20 explicit PDF pages. Requires the exact source SHA and explicit local OCR opt-in. This call records source and configured engine/helper identities; it does not run OCR. Save the returned job ID and identity, then call resume_pdf_ocr_job. All resulting words remain unverified proposals.",
    inputSchema: { type: "object", additionalProperties: false,
      properties: { pdf_path: { type: "string", minLength: 1, maxLength: 4096 },
        pages: { type: "array", minItems: 1, maxItems: MAX_PAGES, uniqueItems: true,
          items: { type: "integer", minimum: 1, maximum: 10000 } },
        expected_source_sha256: { type: "string", pattern: SHA256.source },
        confirm_local_ocr: { const: true } },
      required: ["pdf_path", "pages", "expected_source_sha256", "confirm_local_ocr"] },
    annotations: annotations("Start Local OCR Job"),
  },
  {
    name: "resume_pdf_ocr_job",
    description: "Explicitly opt in to process the next unfinished local OCR page(s), sequentially. Default one, maximum two pages per call, with the existing 120-second attempt bound per page. Already checkpointed pages are not rerun. Requires the job ID and identity returned at creation. Missing or changed source/configuration/artifacts refuse reuse. Returned counts and private review paths describe unverified proposals, never verified text.",
    inputSchema: { type: "object", additionalProperties: false,
      properties: { ...jobProperties, confirm_local_ocr: { const: true },
        max_pages: { type: "integer", minimum: 1, maximum: MAX_PAGES_PER_CALL } },
      required: [...Object.keys(jobProperties), "confirm_local_ocr"] },
    annotations: annotations("Resume Local OCR Job"),
  },
  {
    name: "read_pdf_ocr_job",
    description: "Read a known local OCR job's bounded progress and private review paths. Requires its exact job ID and identity; validates source/configuration and retained checkpoint identities. Does not run OCR. All words remain unverified, even when every selected page is complete.",
    inputSchema: { type: "object", additionalProperties: false,
      properties: jobProperties, required: Object.keys(jobProperties) },
    annotations: { ...annotations("Read Local OCR Job"), readOnlyHint: true, idempotentHint: true },
  },
]);

async function privateDirectory(directory, create = false) {
  check(path.isAbsolute(directory), "Local OCR job state paths must be absolute.");
  let created = false;
  if (create) {
    try { await fs.mkdir(directory, { mode: 0o700 }); created = true; }
    catch (error) { if (error.code !== "EEXIST") throw error; }
  }
  const stat = await fs.lstat(directory);
  check(stat.isDirectory() && !stat.isSymbolicLink() && (stat.mode & 0o777) === 0o700
    && (typeof process.getuid !== "function" || stat.uid === process.getuid()),
  "Local OCR job directories must be physical, owned and private (0700).");
  if (created) await confirmDurability([path.dirname(directory)]);
  return fs.realpath(directory);
}

async function inspectFile(file, maximum, { privateFile = true, bytes = false, expected, syncData = false } = {}) {
  const handle = await fs.open(file, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const before = await handle.stat({ bigint: true });
    check(before.isFile() && before.size > 0n && before.size <= BigInt(maximum),
      "Local OCR job artifacts must be bounded regular files.");
    check(!privateFile || ((before.mode & 0o777n) === 0o600n
      && (typeof process.getuid !== "function" || before.uid === BigInt(process.getuid()))),
    "Local OCR job artifacts must be owned and private (0600).");
    const observed = identity(before);
    if (expected) check(same(observed, expected), "Local OCR job artifact changed; refusing checkpoint reuse.");
    let content;
    let digest;
    // Completed checkpoints use exact descriptor metadata to detect subsequent
    // changes without reading up to 20 full render/review files on every poll.
    if (!expected) {
      const hash = createHash("sha256");
      const buffer = Buffer.alloc(Math.min(64 * 1024, Number(before.size)));
      const chunks = [];
      let offset = 0;
      while (offset < Number(before.size)) {
        const { bytesRead } = await handle.read(buffer, 0,
          Math.min(buffer.length, Number(before.size) - offset), offset);
        check(bytesRead > 0, "Local OCR job artifact changed while reading.");
        const chunk = buffer.subarray(0, bytesRead);
        hash.update(chunk);
        if (bytes) chunks.push(Buffer.from(chunk));
        offset += bytesRead;
      }
      digest = hash.digest("hex");
      if (bytes) content = Buffer.concat(chunks);
    }
    const after = await handle.stat({ bigint: true });
    const current = await fs.lstat(file, { bigint: true });
    check(current.isFile() && same(observed, identity(after)) && same(observed, identity(current)),
      "Local OCR job artifact changed while reading.");
    if (syncData) await handle.sync();
    return { identity: observed, sha256: digest, bytes: content };
  } finally { await handle.close(); }
}

async function readJson(file) {
  const result = await inspectFile(file, MAX_STATE, { bytes: true });
  return { ...result, value: parseStrictJson(result.bytes.toString("utf8"), "Local OCR job state") };
}

async function syncDirectory(directory) {
  const handle = await fs.open(directory, constants.O_RDONLY);
  try { await handle.sync(); } finally { await handle.close(); }
}

async function confirmDurability(directories) {
  try { for (const directory of directories) await syncDirectory(directory); }
  catch (cause) {
    const error = new Error("Local OCR checkpoint durability is uncertain. Retry to validate and sync the retained state.", { cause });
    error.code = "LOCAL_OCR_CHECKPOINT_DURABILITY_UNCERTAIN";
    throw error;
  }
}

async function publishJson(directory, name, value) {
  const bytes = jsonBytes(value);
  check(bytes.length <= MAX_STATE, "Local OCR job checkpoint exceeded its size bound.");
  const staging = path.join(directory, `.checkpoint-${randomUUID()}`);
  const handle = await fs.open(staging, "wx", 0o600);
  try { await handle.writeFile(bytes); await handle.sync(); } finally { await handle.close(); }
  try {
    // A complete checkpoint appears atomically and can never replace another.
    await fs.link(staging, path.join(directory, name));
    await confirmDurability([directory]);
  } finally { await fs.unlink(staging).catch(() => {}); }
}

async function processIdentity(pid) {
  try { process.kill(pid, 0); }
  catch (error) { if (error.code === "ESRCH") return null; throw error; }
  if (process.platform === "linux") {
    try {
      const [stat, boot] = await Promise.all([
        fs.readFile(pid === process.pid ? "/proc/self/stat" : `/proc/${pid}/stat`, "utf8"),
        fs.readFile("/proc/sys/kernel/random/boot_id", "utf8"),
      ]);
      const fields = stat.slice(stat.lastIndexOf(")") + 2).trim().split(/\s+/u);
      check(/^\d+$/u.test(fields[19]), "Cannot establish local OCR lock process identity.");
      return `${boot.trim()}:${fields[19]}`;
    } catch (error) {
      if (error.code === "ENOENT") {
        try { process.kill(pid, 0); } catch (gone) { if (gone.code === "ESRCH") return null; }
      }
      throw error;
    }
  }
  // lstart is stable across a process's lifetime. An ambiguous live process is
  // never reclaimed; Linux uses kernel start ticks plus boot identity above.
  try {
    const { stdout } = await execFileAsync("/bin/ps", ["-p", String(pid), "-o", "lstart="],
      { timeout: 2000, maxBuffer: 4096, env: { PATH: "/usr/bin:/bin", LC_ALL: "C" } });
    check(stdout.trim().length > 0, "Cannot establish local OCR lock process identity.");
    return stdout.trim();
  } catch (error) {
    try { process.kill(pid, 0); } catch (gone) { if (gone.code === "ESRCH") return null; }
    throw error;
  }
}

async function acquireLock(directory, jobId) {
  const lockPath = path.join(directory, "active.lock");
  const token = randomUUID();
  const ownerName = `owner-${token}.json`;
  const candidate = path.join(directory, `.lock-${token}`);
  await fs.mkdir(candidate, { mode: 0o700 });
  try {
    const processId = await processIdentity(process.pid);
    check(typeof processId === "string", "Cannot establish local OCR lock process identity.");
    await publishJson(candidate, ownerName, { job_id: jobId, token, pid: process.pid,
      process_identity: processId });
    for (let attempt = 0; attempt < 6; attempt += 1) {
      try {
        // POSIX rename cannot replace a nonempty directory. Publish owner and
        // lock together, so there is no ownerless acquisition window.
        await fs.rename(candidate, lockPath);
        return async () => {
          await fs.unlink(path.join(lockPath, ownerName));
          await fs.rmdir(lockPath).catch(error => {
            if (!["ENOENT", "ENOTEMPTY", "EEXIST"].includes(error.code)) throw error;
          });
        };
      } catch (error) {
        if (!["EEXIST", "ENOTEMPTY"].includes(error.code)) throw error;
      }
      try {
        await privateDirectory(lockPath);
        const names = await fs.readdir(lockPath);
        if (names.length === 0) continue; // A concurrent release is in progress.
        check(names.length === 1 && /^owner-[a-f0-9-]{36}\.json$/u.test(names[0]),
          "Local OCR job lock is invalid; refusing to reclaim it.");
        const owner = (await readJson(path.join(lockPath, names[0]))).value;
        check(ownKeys(owner, ["job_id", "token", "pid", "process_identity"])
          && owner.job_id === jobId && UUID.test(owner.token)
          && names[0] === `owner-${owner.token}.json`
          && Number.isInteger(owner.pid) && owner.pid > 0 && owner.pid <= 2147483647
          && typeof owner.process_identity === "string" && owner.process_identity.length <= 200,
        "Local OCR job lock is invalid; refusing to reclaim it.");
        check(await processIdentity(owner.pid) !== owner.process_identity,
          "Another local OCR operation owns this job. Wait for it to finish.");
        // Remove ONLY this dead owner's unique filename. If another contender
        // already acquired a new lock, its different owner cannot be unlinked.
        await fs.unlink(path.join(lockPath, names[0]));
        await fs.rmdir(lockPath).catch(error => {
          if (!["ENOENT", "ENOTEMPTY", "EEXIST"].includes(error.code)) throw error;
        });
      } catch (error) { if (error.code !== "ENOENT") throw error; }
    }
    throw new Error("Local OCR job lock changed repeatedly. Retry after the active operation finishes.");
  } finally { await fs.rm(candidate, { recursive: true, force: true }); }
}

async function configurationIdentity(configuration, platform, expectedHelperSha256) {
  check(configuration, "Local OCR is not configured. It is optional and disabled by default.");
  const engine = configuration.engine ?? "vision";
  check(["vision", "tesseract"].includes(engine)
    && (engine === "vision" ? platform === "darwin" : ["darwin", "linux"].includes(platform)),
  "Local OCR jobs require macOS Vision or Linux/macOS Tesseract.");
  const executable = async requested => {
    check(typeof requested === "string" && path.isAbsolute(requested) && requested.length <= 4096,
      "Configure absolute local OCR executable paths.");
    const real = await fs.realpath(requested);
    const stat = await fs.stat(real, { bigint: true });
    check(stat.isFile() && (stat.mode & 0o111n) !== 0n, "Local OCR executable is unavailable.");
    return { requested_path: requested, real_path: real, identity: identity(stat) };
  };
  check(typeof configuration.helperPath === "string" && path.isAbsolute(configuration.helperPath)
    && configuration.helperPath.length <= 4096, "Configure an absolute local OCR helper path.");
  const helper = await inspectFile(configuration.helperPath, 128 * 1024, { privateFile: false });
  check(helper.sha256 === expectedHelperSha256, "The local OCR helper does not match this reviewed version.");
  return { engine, platform, architecture: process.arch,
    python: await executable(configuration.pythonPath),
    helper: { requested_path: configuration.helperPath,
      real_path: await fs.realpath(configuration.helperPath), sha256: helper.sha256 },
    tesseract: engine === "tesseract" ? await executable(configuration.tesseractPath) : null };
}

function validateInput(args, name) {
  const definition = LOCAL_OCR_JOB_TOOL_DEFINITIONS.find(tool => tool.name === name);
  check(args && typeof args === "object" && !Array.isArray(args)
    && Object.keys(args).every(key => Object.hasOwn(definition.inputSchema.properties, key))
    && definition.inputSchema.required.every(key => Object.hasOwn(args, key)), "Invalid local OCR job arguments.");
  if (name !== "read_pdf_ocr_job") check(args.confirm_local_ocr === true, "Explicit confirm_local_ocr=true is required.");
  if (name === "start_pdf_ocr_job") {
    check(typeof args.pdf_path === "string" && args.pdf_path.length > 0 && args.pdf_path.length <= 4096
      && SHA256.test(args.expected_source_sha256 ?? "") && Array.isArray(args.pages)
      && args.pages.length > 0 && args.pages.length <= MAX_PAGES && new Set(args.pages).size === args.pages.length
      && args.pages.every(page => Number.isInteger(page) && page >= 1 && page <= 10000),
    "Local OCR jobs require a source SHA and 1–20 unique page numbers (1–10000).");
  } else {
    check(typeof args.job_id === "string" && UUID.test(args.job_id)
      && typeof args.expected_job_identity_sha256 === "string" && SHA256.test(args.expected_job_identity_sha256),
    "Use the exact local OCR job ID and identity returned by start_pdf_ocr_job.");
    if (name === "resume_pdf_ocr_job") check(args.max_pages === undefined
      || (Number.isInteger(args.max_pages) && args.max_pages >= 1 && args.max_pages <= MAX_PAGES_PER_CALL),
    "A local OCR resume call may process only one or two pages.");
  }
}

/** runPage MUST be the same handler instance registered as propose_pdf_ocr. */
export function createLocalOcrJobHandlers({ configuration, stateRoot, proposalStateRoot,
  resolvePdfPath, readPdfBytes, runPage, platform = process.platform,
  expectedHelperSha256 = LOCAL_OCR_HELPER_SHA256 }) {
  let active = false;
  const configured = () => configurationIdentity(configuration, platform, expectedHelperSha256);
  const sourceIdentity = async requested => {
    const canonical = await fs.realpath(resolvePdfPath(requested));
    const bytes = await readPdfBytes(resolvePdfPath(canonical));
    check(Buffer.isBuffer(bytes) && bytes.length > 0 && bytes.length <= MAX_SOURCE
      && bytes.subarray(0, 5).toString("ascii") === "%PDF-", "Local OCR job source must be a bounded PDF.");
    return { canonical_path: canonical, sha256: sha(bytes), size_bytes: bytes.length };
  };
  const assertBindings = async manifest => {
    check(same(await configured(), manifest.configuration), "Local OCR job configuration changed; start a new job.");
    check(same(await sourceIdentity(manifest.source.canonical_path), manifest.source),
      "Local OCR job source changed; start a new job with its current SHA.");
  };
  const loadJob = async args => {
    const root = await privateDirectory(stateRoot);
    const directory = await privateDirectory(path.join(root, args.job_id));
    const state = await readJson(path.join(directory, "manifest.json"));
    check(state.sha256 === args.expected_job_identity_sha256, "Local OCR job identity does not match the stored manifest.");
    const manifest = state.value;
    check(ownKeys(manifest, ["schema", "job_id", "created_at", "source", "configuration", "pages"])
      && manifest.schema === "pdf-tools.local-ocr-job.v1" && manifest.job_id === args.job_id
      && ownKeys(manifest.source, ["canonical_path", "sha256", "size_bytes"]),
    "Local OCR job manifest is invalid.");
    validateInput({ pdf_path: manifest.source.canonical_path, pages: manifest.pages,
      expected_source_sha256: manifest.source.sha256, confirm_local_ocr: true }, "start_pdf_ocr_job");
    await assertBindings(manifest);
    return { directory, manifest, identity: state.sha256 };
  };
  const proposalLocation = async proposalId => {
    check(typeof proposalId === "string" && PROPOSAL_ID.test(proposalId), "Invalid local OCR checkpoint proposal ID.");
    const root = await privateDirectory(proposalStateRoot);
    const directory = await privateDirectory(path.join(root, proposalId));
    await privateDirectory(path.join(directory, "proposal"));
    return directory;
  };
  const readCompleted = async job => {
    const completed = [];
    const durableDirectories = new Set();
    for (const page of job.manifest.pages) {
      let value;
      try { value = (await readJson(path.join(job.directory, `page-${page}.json`))).value; }
      catch (error) { if (error.code === "ENOENT") continue; throw error; }
      check(ownKeys(value, ["schema", "job_identity_sha256", "page_number", "proposal_id", "result", "files"])
        && value.schema === "pdf-tools.local-ocr-page-checkpoint.v1"
        && value.job_identity_sha256 === job.identity && value.page_number === page
        && ownKeys(value.result, ["observation_count", "proposal_sha256", "render_png_sha256", "review_html_sha256"])
        && Number.isInteger(value.result.observation_count) && value.result.observation_count >= 0
        && value.result.observation_count <= 1000
        && ["proposal_sha256", "render_png_sha256", "review_html_sha256"].every(key => SHA256.test(value.result[key]))
        && ownKeys(value.files, Object.keys(ARTIFACTS)), "Local OCR page checkpoint is invalid.");
      const directory = await proposalLocation(value.proposal_id);
      for (const [name, maximum] of Object.entries(ARTIFACTS)) {
        const file = value.files[name];
        check(ownKeys(file, ["identity", "sha256"]) && SHA256.test(file.sha256)
          && ownKeys(file.identity, ["dev", "ino", "size", "mode", "mtimeNs", "ctimeNs"])
          && Object.values(file.identity).every(item => typeof item === "string" && /^-?\d{1,30}$/u.test(item)),
        "Local OCR checkpoint file identity is invalid.");
        await inspectFile(path.join(directory, name), maximum, { expected: file.identity });
      }
      check(value.files["source.pdf"].sha256 === job.manifest.source.sha256
        && value.files["adapter.py"].sha256 === job.manifest.configuration.helper.sha256
        && value.files["proposal/render.png"].sha256 === value.result.render_png_sha256
        && value.files["review.html"].sha256 === value.result.review_html_sha256,
      "Local OCR checkpoint artifact bindings are invalid.");
      completed.push({ page_number: page, ...value.result,
        review_html_path: path.join(directory, "review.html"), proposal_directory: path.join(directory, "proposal") });
      durableDirectories.add(path.join(directory, "proposal"));
      durableDirectories.add(directory);
      durableDirectories.add(path.dirname(directory));
      durableDirectories.add(path.dirname(path.dirname(directory)));
    }
    // This also seals a checkpoint that became visible just before a prior
    // directory fsync failed; retry never reruns its completed page.
    await confirmDurability([...durableDirectories, job.directory,
      path.dirname(job.directory), path.dirname(path.dirname(job.directory))]);
    return completed;
  };
  const checkpoint = async (job, page, result) => {
    const validated = validateStructuredToolResult("propose_pdf_ocr", result);
    check(!validated.isError, "Local OCR page did not return a valid completed result.");
    const payload = validated.structuredContent;
    check(payload.source_pdf_sha256 === job.manifest.source.sha256 && payload.page_number === page
      && payload.helper_sha256 === job.manifest.configuration.helper.sha256,
    "Local OCR page result does not match this job.");
    const proposalId = path.basename(path.dirname(payload.proposal_directory));
    const directory = await proposalLocation(proposalId);
    check(payload.proposal_directory === path.join(directory, "proposal")
      && payload.review_html_path === path.join(directory, "review.html"),
    "Local OCR page result paths are outside the configured proposal state.");
    const files = {};
    let proposal;
    let commit;
    for (const [name, maximum] of Object.entries(ARTIFACTS)) {
      const observed = await inspectFile(path.join(directory, name), maximum,
        { bytes: ["proposal/proposal.json", "proposal/commit.json"].includes(name), syncData: true });
      files[name] = { identity: observed.identity, sha256: observed.sha256 };
      if (name === "proposal/proposal.json") proposal = parseStrictJson(observed.bytes.toString("utf8"), "OCR proposal");
      if (name === "proposal/commit.json") commit = parseStrictJson(observed.bytes.toString("utf8"), "OCR commit");
    }
    check(files["source.pdf"].sha256 === job.manifest.source.sha256
      && files["adapter.py"].sha256 === payload.helper_sha256
      && files["proposal/render.png"].sha256 === payload.render_png_sha256
      && files["review.html"].sha256 === payload.review_html_sha256
      && commit.schema === "pdf-tools.local-ocr-commit.v1"
      && commit.proposal_file_sha256 === files["proposal/proposal.json"].sha256
      && commit.proposal_sha256 === payload.proposal_sha256
      && commit.render_png_sha256 === payload.render_png_sha256
      && proposal.source_pdf_sha256 === payload.source_pdf_sha256 && proposal.page_number === page
      && proposal.proposal_sha256 === payload.proposal_sha256
      && proposal.render_png_sha256 === payload.render_png_sha256
      && Array.isArray(proposal.proposals) && proposal.proposals.length === payload.observation_count,
    "Local OCR completed artifacts do not match the page result.");
    await assertBindings(job.manifest);
    // The proposal tree lives beside the job tree. Both parent directory
    // entries must be durable before publishing a page that refers to it.
    await confirmDurability([path.join(directory, "proposal"), directory,
      path.dirname(directory), path.dirname(path.dirname(directory))]);
    await publishJson(job.directory, `page-${page}.json`, {
      schema: "pdf-tools.local-ocr-page-checkpoint.v1", job_identity_sha256: job.identity,
      page_number: page, proposal_id: proposalId, result: {
        observation_count: payload.observation_count, proposal_sha256: payload.proposal_sha256,
        render_png_sha256: payload.render_png_sha256, review_html_sha256: payload.review_html_sha256,
      }, files,
    });
  };
  const report = (job, completed, processed = 0, failedPage = null) => {
    const remaining = job.manifest.pages.filter(page => !completed.some(item => item.page_number === page));
    const structuredContent = {
      status: remaining.length === 0 ? "ocr_job_complete" : completed.length === 0 ? "ocr_job_ready" : "ocr_job_paused",
      job_id: job.manifest.job_id, job_identity_sha256: job.identity,
      source_pdf_sha256: job.manifest.source.sha256, helper_sha256: job.manifest.configuration.helper.sha256,
      configured_engine: job.manifest.configuration.engine, verification_status: "unverified_ocr_proposals",
      page_count: job.manifest.pages.length, completed_count: completed.length, remaining_count: remaining.length,
      completed_pages: completed, remaining_pages: remaining, processed_this_call: processed,
      max_pages_per_call: MAX_PAGES_PER_CALL, failed_page: failedPage,
      failure_code: failedPage === null ? null : "page_attempt_failed",
      next_action: remaining.length ? "resume_pdf_ocr_job" : "review_unverified_proposals",
    };
    return { structuredContent, content: [{ type: "text", text:
      `Local OCR job ${job.manifest.job_id}: ${completed.length}/${job.manifest.pages.length} pages checkpointed; `
      + `${remaining.length} remain. All words remain UNVERIFIED proposals. `
      + (failedPage === null ? "" : `Page ${failedPage} did not complete; check the configured engine and page before retrying. `)
      + (remaining.length ? "Resume with the returned job ID/identity and confirm_local_ocr=true; maximum two pages per call. "
        : "Review the private proposal files against the source images. ")
      + "Review paths and exact progress are in structuredContent." }] };
  };
  return {
    async start_pdf_ocr_job(args) {
      validateInput(args, "start_pdf_ocr_job");
      const config = await configured();
      const source = await sourceIdentity(args.pdf_path);
      check(source.sha256 === args.expected_source_sha256, "Local OCR job source SHA does not match the requested PDF.");
      const root = await privateDirectory(stateRoot, true);
      const jobId = randomUUID();
      const directory = path.join(root, jobId);
      await fs.mkdir(directory, { mode: 0o700 });
      const manifest = { schema: "pdf-tools.local-ocr-job.v1", job_id: jobId,
        created_at: new Date().toISOString(), source, configuration: config, pages: [...args.pages].sort((a, b) => a - b) };
      await publishJson(directory, "manifest.json", manifest);
      await confirmDurability([root, path.dirname(root)]);
      return report({ directory, manifest, identity: sha(jsonBytes(manifest)) }, []);
    },
    async read_pdf_ocr_job(args) {
      validateInput(args, "read_pdf_ocr_job");
      const job = await loadJob(args);
      return report(job, await readCompleted(job));
    },
    async resume_pdf_ocr_job(args) {
      validateInput(args, "resume_pdf_ocr_job");
      check(!active, "Another local OCR job operation is active. Wait for it to finish.");
      active = true;
      let release;
      try {
        const job = await loadJob(args);
        release = await acquireLock(job.directory, job.manifest.job_id);
        let completed = await readCompleted(job);
        const previouslyCompleted = completed.length;
        const pending = job.manifest.pages.filter(page => !completed.some(item => item.page_number === page))
          .slice(0, args.max_pages ?? 1);
        let failedPage = null;
        for (const page of pending) {
          await assertBindings(job.manifest);
          try {
            const result = await runPage({ pdf_path: job.manifest.source.canonical_path, page,
              expected_source_sha256: job.manifest.source.sha256, confirm_local_ocr: true });
            await checkpoint(job, page, result);
          } catch (error) {
            if (error.code === "LOCAL_OCR_CHECKPOINT_DURABILITY_UNCERTAIN") throw error;
            // A partial proposal or an interrupted page never becomes a page
            // checkpoint. Publication durability failures instead propagate;
            // a later call can seal a visible checkpoint without rerunning it.
            failedPage = page;
            break;
          }
        }
        await assertBindings(job.manifest); // Source/config drift is a refusal, not a resumable engine failure.
        completed = await readCompleted(job);
        if (completed.some(item => item.page_number === failedPage)) failedPage = null;
        return report(job, completed, completed.length - previouslyCompleted, failedPage);
      } finally {
        try { if (release) await release(); } finally { active = false; }
      }
    },
  };
}
