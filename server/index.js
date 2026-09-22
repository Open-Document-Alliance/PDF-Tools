#!/usr/bin/env node

import {
  ProtocolError as McpError,
  ProtocolErrorCode as ErrorCode,
  ResourceNotFoundError,
  Server,
} from "@modelcontextprotocol/server";
import { loadSkills, skillParams, SKILLS_EXTENSION } from "./skills.js";
import { serveStdio } from "@modelcontextprotocol/server/stdio";
import {
  PDFArray,
  PDFCatalog,
  PDFDocument,
  PDFName,
  PDFNumber,
  PDFPageLeaf,
  PDFPageTree,
  PDFRef,
  degrees as pdfDegrees,
} from "pdf-lib";
import { fileURLToPath } from "url";
import {
  chmodSync,
  constants as fsConstants,
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  writeFileSync,
} from "fs";
import fs from "fs/promises";
import path from "path";
import { homedir, platform as osPlatform } from "os";
import { spawn } from "child_process";
import { createHash, randomUUID } from "crypto";
import {
  isUnavailableResourceError,
  pathToPdfResourceUri,
  pdfResourceUriToPath,
} from "./resource-uri.js";
import {
  TOOL_OUTPUT_SCHEMAS,
  createTypedToolError,
  validateStructuredToolResult,
  withToolOutputSchema,
} from "./output-schemas.js";
import { publicAccessibilityInspectionError } from "./accessibility-inspection.js";
import { renderPdfLayoutToMarkdown } from "./markdown-conversion.js";
import {
  normalizeTableProposalCells,
  verifyTableProposalAgainstRegion,
} from "./table-proposal-verification.js";
import { validatePdfLayoutSemantics } from "./layout-extraction.js";
import {
  buildRenderObservation,
  publicPdfObservationError,
  validatePdfObservationSemantics,
} from "./pdf-observations.js";
import {
  PDF_COMPARISON_ENCRYPTED_CODE,
  PDF_COMPARISON_RENDERER,
  buildPdfComparison,
  isPdfComparisonEncryptedFailure,
  pdfComparisonEncryptedError,
  publicPdfComparisonError,
} from "./pdf-comparison.js";
import {
  PDF_DECRYPTABLE_PASSWORD_DESCRIPTION,
  PDF_REPROTECTING_PASSWORD_DESCRIPTION,
  PdfDecryptionError,
  decryptPdfForRead,
  forceTerminateAllDecryptionWorkers,
  terminateAllDecryptionWorkers,
} from "./qpdf-decrypt.js";
import {
  PDF_MUTATION_MAX_FILE_BYTES,
  assertDanglingPdfInputAlias,
  assertCanonicalRecoveryDirectory,
  bindDanglingPdfInputAlias,
  bindCanonicalRecoveryDirectory,
  hashBoundedPdfFileSafely,
  pdfMutationFileLimitError,
  preflightBoundedPdfFileSafely,
  preflightPdfMutationInputsWithinMergeLimit,
  readBoundedPdfFileSafely,
  readPdfMutationInputsWithinMergeLimit,
} from "./bounded-pdf-file.js";
import {
  PDF_RESOURCE_LIMIT_CODE,
  createPdfjsSubprocessRequest,
  forceTerminateAllPdfjsSubprocesses,
  runPdfjsSubprocess,
  settleAllShutdownOperations,
  terminateAllPdfjsSubprocesses,
} from "./pdfjs-subprocess.js";
import {
  PDF_LIB_MUTATION_TOOL_NAMES,
  forceTerminateAllPdfLibMutations,
  runPdfLibInspection,
  runPdfLibMutation,
  terminateAllPdfLibMutations,
} from "./pdf-lib-subprocess.js";
// The pre-parse bounds the mutation path already applies, reused on the one
// read path that hands pdf-lib bytes it did not read off disk. This module is
// already on the server's import graph through pdf-lib-subprocess.js, so the
// import costs nothing new; see `loadEncryptedPdfBytes`.
import {
  assertBoundedPdfStreamDecodes,
  assertBoundedPdfStructure,
} from "./pdf-lib-worker.js";
import {
  VERIFIED_EXTRACTION_TOOL_DEFINITIONS,
  createVerifiedExtractionToolHandler,
} from "./verified-extraction-tools.js";
import {
  LUMIN_SIGNING_TOOL_DEFINITIONS,
  LUMIN_SIGNING_TOOL_NAMES,
  createLuminSigningToolHandler,
  formatLuminSigningToolText,
} from "./lumin-signing-tools.js";

export const READ_CONTENT_ROUTING_GUIDANCE =
  "Use render_pdf_page to inspect pages flagged as textless, suspect, or containing invisible text. Invisible text may be accurate, but its agreement with the visible page has not been verified. Unavailable visibility measurements do not establish that text is visible. Routing fields cover only successfully-read pages; unread pages are not classified. No OCR or visual transcription was performed.";

/**
 * Keep Markdown routing in one mapping function so later text-integrity
 * signals can extend the same additive surface without duplicating policy.
 */
export function deriveMarkdownVisionRouting(layout) {
  return (layout?.pages ?? []).flatMap(page => {
    const reasons = [];
    if (["empty", "failed"].includes(page.text_layer_status)) reasons.push("no_text_layer");
    // Threshold-consistent with get_page_analysis (helpers.js
    // MIN_TEXT_CHARS_WITH_IMAGES): a page with image paints and text below
    // the raised bar routes to vision even when a thin text layer exists.
    const trimmedTextLength = (page.raw_items ?? [])
      .filter(item => item.is_whitespace !== true && typeof item.text === "string")
      .reduce((total, item) => total + item.text.trim().length, 0);
    const imagePaints = page.operator_counts?.image_paint_ops ?? 0;
    if (page.image_detection_status === "detected"
      && (page.text_layer_status !== "present"
        || (imagePaints > 0 && trimmedTextLength < MIN_TEXT_CHARS_WITH_IMAGES))) {
      reasons.push("image_dominated");
    }
    if (page.modality_hint === "vector-only-candidate") reasons.push("vector_only_text");
    if (page.text_integrity?.status === "suspect") reasons.push("suspected_text_integrity");
    return reasons.length > 0 ? [{ page: page.page, reasons }] : [];
  });
}

function boundedInteger(value, fallback, { name, minimum, maximum }) {
  const candidate = value === undefined || value === null ? fallback : value;
  if (!Number.isInteger(candidate) || candidate < minimum || candidate > maximum) {
    throw new Error(`${name} must be an integer from ${minimum} to ${maximum}.`);
  }
  return candidate;
}

async function readBoundedPdfFile(resolvedPath, maxBytes, options = {}) {
  return readBoundedPdfFileSafely(resolvedPath, maxBytes, {
    ...options,
    assertPathAllowed,
  });
}

async function preflightPdfInputWithoutRecovery(inputPath, maxBytes, createSizeLimitError) {
  const resolvedPath = resolvePath(inputPath);
  try {
    const observation = await preflightBoundedPdfFileSafely(resolvedPath, maxBytes, {
      createSizeLimitError,
      assertPathAllowed,
    });
    return { resolvedPath, ...observation, missingBeforeRecovery: false };
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
    let finalComponent;
    try {
      finalComponent = await fs.lstat(resolvedPath, { bigint: true });
    } catch (lstatError) {
      if (lstatError?.code !== "ENOENT") throw lstatError;
    }
    if (finalComponent) {
      const aliasBinding = await bindDanglingPdfInputAlias(resolvedPath, {
        assertPathAllowed,
      });
      return {
        resolvedPath,
        sizeBytes: null,
        canonicalPath: null,
        fileIdentity: null,
        recoveryDirectory: aliasBinding.recoveryDirectory,
        expectedCanonicalPath: aliasBinding.expectedCanonicalPath,
        aliasBinding,
        missingBeforeRecovery: true,
      };
    }
    const recoveryDirectory = await bindCanonicalRecoveryDirectory(
      path.dirname(resolvedPath),
      { assertPathAllowed },
    );
    return {
      resolvedPath,
      sizeBytes: null,
      canonicalPath: null,
      fileIdentity: null,
      recoveryDirectory,
      expectedCanonicalPath: path.join(
        recoveryDirectory.canonicalPath,
        path.basename(resolvedPath),
      ),
      aliasBinding: null,
      missingBeforeRecovery: true,
    };
  }
}

function sameStableFileIdentity(left, right) {
  return Boolean(
    left
    && right
    && left.device === right.device
    && left.inode === right.inode,
  );
}

function expandUserPath(inputPath) {
  if (!inputPath) return inputPath;
  if (inputPath === "~") return homedir();
  if (inputPath.startsWith("~/") || inputPath.startsWith("~\\")) {
    return path.join(homedir(), inputPath.slice(2));
  }
  return inputPath;
}

function normalizeUserPath(inputPath) {
  const expanded = expandUserPath(inputPath);
  return path.resolve(expanded);
}

function canonicalizePathForPolicy(resolvedPath) {
  const absolutePath = path.resolve(resolvedPath);
  if (existsSync(absolutePath)) {
    return realpathSync.native(absolutePath);
  }

  let ancestor = absolutePath;
  const missingParts = [];
  while (!existsSync(ancestor)) {
    const parent = path.dirname(ancestor);
    if (parent === ancestor) break;
    missingParts.unshift(path.basename(ancestor));
    ancestor = parent;
  }

  const canonicalAncestor = existsSync(ancestor)
    ? realpathSync.native(ancestor)
    : ancestor;
  return path.join(canonicalAncestor, ...missingParts);
}

function isPathInsideDirectory(candidatePath, directoryPath) {
  const relative = path.relative(directoryPath, candidatePath);
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

function assertPathAllowed(resolvedPath) {
  const canonicalPath = canonicalizePathForPolicy(resolvedPath);
  const isAllowed = ALLOWED_DIRECTORIES.some((directory) =>
    isPathInsideDirectory(canonicalPath, directory.canonical)
  );

  if (!isAllowed) {
    const allowed = ALLOWED_DIRECTORIES.map((directory) => directory.display).join(", ");
    // Two distinct states. An empty allowed set means nothing configured us,
    // which cannot arise once defaults are gone unless the host supplied
    // nothing at all, so it names the mechanisms instead of a set it does not
    // have. Otherwise the message reports the configured set and the attempted
    // path, because a user who cannot see what was allowed cannot fix it.
    const error = new Error(
      ALLOWED_DIRECTORIES.length === 0
        ? "No allowed directories are configured, so this server refused the request. "
          + `List the folders you want reachable in ${HOME_CONFIG_PATH}, under `
          + "\"allowedDirectories\", then restart this server. "
          + (PLUGIN_DATA_CONFIG_PATH
            ? `A plugin-specific file at ${PLUGIN_DATA_CONFIG_PATH} takes precedence when present. `
            : "")
          + "Hosts with a settings UI may instead set --allowed-directories or the "
          + "ALLOWED_DIRECTORIES environment variable."
        : `This server is only allowed to access: ${allowed}. ` +
          `Tried to access: ${resolvedPath}. ` +
          "The allowed list must be set where this server is configured, and it replaces " +
          "these defaults rather than adding to them, so include the folders you still need. " +
          "Hosts with a settings UI expose it as allowed_directories; otherwise set the " +
          "--allowed-directories argument, which takes precedence, or the ALLOWED_DIRECTORIES " +
          "environment variable, which applies only when that argument is absent."
    );
    error.code = "path_policy_denied";
    throw error;
  }

  return resolvedPath;
}

// Helper function to resolve paths and enforce the extension filesystem sandbox.
function resolvePath(inputPath) {
  if (!inputPath) return inputPath;
  return assertPathAllowed(normalizeUserPath(inputPath));
}

// resolvePath returns the caller's path, not the file the policy check accepted,
// so a handler that opens that string can be sent somewhere else by a symlink
// swapped in afterwards. This returns the canonical path instead, which names
// one file and cannot be repointed by replacing a link. Use it wherever the
// resolved path is then handed to the filesystem or to another process.
function resolveCanonicalPath(inputPath) {
  if (!inputPath) return inputPath;
  const canonicalPath = canonicalizePathForPolicy(normalizeUserPath(inputPath));
  assertPathAllowed(canonicalPath);
  return canonicalPath;
}

// openVerifiedRegularFile lives in helpers.js so its device/inode identity
// check can be exercised with an injected filesystem. Handlers here pass the
// real fs.

async function bindOutputPathForTransaction(outputPath) {
  const parentPath = await fs.realpath(path.dirname(outputPath));
  assertPathAllowed(parentPath);
  const parentStats = await fs.lstat(parentPath, { bigint: true });
  if (!parentStats.isDirectory() || parentStats.isSymbolicLink()) {
    throw new Error("output_path parent must resolve to a regular directory.");
  }
  const targetPath = path.join(parentPath, path.basename(outputPath));
  assertPathAllowed(targetPath);
  return {
    targetPath,
    parentPath,
    parentIdentity: {
      device: String(parentStats.dev),
      inode: String(parentStats.ino),
    },
  };
}

async function assertBoundOutputParent(binding) {
  const canonicalParent = await fs.realpath(binding.parentPath);
  assertPathAllowed(canonicalParent);
  const parentStats = await fs.lstat(canonicalParent, { bigint: true });
  if (
    canonicalParent !== binding.parentPath
    || !parentStats.isDirectory()
    || parentStats.isSymbolicLink()
    || !sameStableFileIdentity({
      device: String(parentStats.dev),
      inode: String(parentStats.ino),
    }, binding.parentIdentity)
  ) {
    throw new Error("output_path parent changed before the Markdown transaction could commit.");
  }
}

async function commitMarkdownOutputInAnchoredProcess({
  outputBinding,
  markdownBytes,
  overwrite,
  expectedOutputIdentity,
  sourcePath,
  sourceCanonicalPath,
  sourceSha256,
  sourceSizeBytes,
  sourceFileIdentity,
}) {
  const childPath = path.join(path.dirname(fileURLToPath(import.meta.url)), "markdown-output-transaction.js");
  const request = {
    protocol_version: 2,
    target_name: path.basename(outputBinding.targetPath),
    markdown_base64: markdownBytes.toString("base64"),
    overwrite,
    expected_output_identity: expectedOutputIdentity === null
      ? null
      : {
          canonical_path: expectedOutputIdentity.canonicalPath,
          size_bytes: expectedOutputIdentity.sizeBytes,
          sha256: expectedOutputIdentity.sha256,
        },
    parent_identity: outputBinding.parentIdentity,
    source_path: sourcePath,
    source_canonical_path: sourceCanonicalPath,
    source_sha256: sourceSha256,
    source_size_bytes: sourceSizeBytes,
    source_file_identity: sourceFileIdentity,
    allowed_directories: ALLOWED_DIRECTORIES.map(directory => directory.canonical),
  };

  return await new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [childPath], {
      cwd: outputBinding.parentPath,
      env: { PATH: process.env.PATH ?? "" },
      stdio: ["pipe", "pipe", "pipe"],
    });
    const stdout = [];
    const stderr = [];
    let stdoutBytes = 0;
    let stderrBytes = 0;
    let timedOut = false;
    let settled = false;
    const finish = (callback, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      callback(value);
    };
    const timeout = setTimeout(() => {
      timedOut = true;
      child.kill("SIGKILL");
    }, 60_000);
    child.on("error", error => finish(reject, error));
    child.stdout.on("data", chunk => {
      stdoutBytes += chunk.length;
      if (stdoutBytes > 1024 * 1024) {
        child.kill("SIGKILL");
        return;
      }
      stdout.push(chunk);
    });
    child.stderr.on("data", chunk => {
      stderrBytes += chunk.length;
      if (stderrBytes <= 64 * 1024) stderr.push(chunk);
    });
    child.on("close", code => {
      if (settled) return;
      if (timedOut) {
        finish(reject, new Error("Markdown output transaction timed out after 60 seconds."));
        return;
      }
      let response;
      try {
        response = JSON.parse(Buffer.concat(stdout).toString("utf8"));
      } catch (error) {
        const diagnostic = Buffer.concat(stderr).toString("utf8").trim().slice(0, 1000);
        finish(reject, new Error(
          `Markdown output transaction returned invalid evidence${diagnostic ? `: ${diagnostic}` : "."}`,
          { cause: error },
        ));
        return;
      }
      if (code !== 0 || response?.ok !== true) {
        const error = new Error(response?.error?.message ?? "Markdown output transaction failed.");
        error.code = response?.error?.code ?? "MARKDOWN_OUTPUT_TRANSACTION_FAILED";
        finish(reject, error);
        return;
      }
      finish(resolve, response.saved_output);
    });
    child.stdin.on("error", () => {});
    child.stdin.end(JSON.stringify(request));
  });
}

// Helper: load a PDF from disk with password support and clear error messages
async function assertPdfInputRecoveryBinding(binding) {
  if (!binding?.recoveryDirectory) {
    throw new TypeError("A PDF input recovery binding is required.");
  }
  await assertCanonicalRecoveryDirectory(binding.recoveryDirectory, { assertPathAllowed });
  if (binding.aliasBinding) {
    await assertDanglingPdfInputAlias(binding.aliasBinding, { assertPathAllowed });
  }
}

async function readPdfInputWithRecovery(inputPath, {
  maxBytes = PDF_MUTATION_MAX_FILE_BYTES,
  createSizeLimitError = pdfMutationFileLimitError,
} = {}) {
  const resolvedPath = resolvePath(inputPath);
  const preflight = await preflightPdfInputWithoutRecovery(
    resolvedPath,
    maxBytes,
    createSizeLimitError,
  );
  const recoveryDirectory = preflight.recoveryDirectory;
  const expectedCanonicalPath = preflight.expectedCanonicalPath ?? preflight.canonicalPath;
  const inputRecoveryBinding = {
    recoveryDirectory,
    aliasBinding: preflight.aliasBinding,
  };
  const assertRecoveryBinding = async () => {
    await assertPdfInputRecoveryBinding(inputRecoveryBinding);
  };
  for (let attempt = 0; attempt < 4; attempt += 1) {
    await assertRecoveryBinding(recoveryDirectory);
    try {
      await recoverPdfOutputTransactions(recoveryDirectory.canonicalPath, {
        recoveryDirectoryBinding: recoveryDirectory,
        assertRecoveryDirectoryBinding: assertRecoveryBinding,
      });
      await assertRecoveryBinding(recoveryDirectory);
      break;
    } catch (error) {
      await assertRecoveryBinding(recoveryDirectory);
      if (error?.code !== "ATOMIC_OUTPUT_CONCURRENT") throw error;
      if (attempt === 3) {
        throw backupIdentityError("CONCURRENT_MODIFICATION", "Another process is committing PDF output in this directory. Retry after that mutation finishes.", error);
      }
      await new Promise(resolve => setTimeout(resolve, 5));
    }
  }
  await assertRecoveryBinding(recoveryDirectory);
  const boundedInput = await readBoundedPdfFile(resolvedPath, maxBytes, {
    createSizeLimitError,
  });
  await assertRecoveryBinding(recoveryDirectory);
  if (boundedInput.canonicalPath !== expectedCanonicalPath) {
    throw backupIdentityError(
      "PDF_RECOVERY_INPUT_CHANGED",
      "PDF input resolved to a different canonical path after recovery. Retry the request.",
    );
  }
  if (
    !Buffer.isBuffer(boundedInput.bytes)
    || boundedInput.bytes.length !== boundedInput.sizeBytes
  ) {
    throw new Error("Bounded PDF input reader returned invalid bytes.");
  }
  inputRecoveryBinding.inputFileIdentity = boundedInput.fileIdentity;
  inputRecoveryBinding.inputCanonicalPath = boundedInput.canonicalPath;
  inputRecoveryBinding.inputSizeBytes = boundedInput.sizeBytes;
  return {
    resolvedPath,
    pdfBytes: boundedInput.bytes,
    sizeBytes: boundedInput.sizeBytes,
    canonicalPath: boundedInput.canonicalPath,
    fileIdentity: boundedInput.fileIdentity,
    inputRecoveryBinding,
  };
}

const MAX_VALIDATED_PDF_STRUCTURE_DIGESTS = 32;
const validatedPdfStructureDigests = new Map();

function rememberValidatedPdfStructure(digest) {
  validatedPdfStructureDigests.delete(digest);
  validatedPdfStructureDigests.set(digest, true);
  while (validatedPdfStructureDigests.size > MAX_VALIDATED_PDF_STRUCTURE_DIGESTS) {
    validatedPdfStructureDigests.delete(validatedPdfStructureDigests.keys().next().value);
  }
}

function validatePdfPageTree(pdfDoc) {
  if (!(pdfDoc.catalog instanceof PDFCatalog)) {
    throw new Error("catalog is unavailable");
  }
  const root = pdfDoc.catalog.lookup(PDFName.of("Pages"));
  if (!(root instanceof PDFPageTree)) {
    throw new Error("page tree root is unavailable");
  }
  if (root.get(PDFName.of("Parent"), true) !== undefined) {
    throw new Error("page tree root must not have a parent");
  }

  const seenNodes = new Set([root]);
  const frameFor = (tree, parent) => {
    const kids = tree.lookupMaybe(PDFName.of("Kids"), PDFArray);
    const count = tree.lookupMaybe(PDFName.of("Count"), PDFNumber);
    const declaredCount = count?.asNumber();
    if (!kids || !Number.isSafeInteger(declaredCount) || declaredCount < 0) {
      throw new Error("page tree node is incomplete");
    }
    return {
      tree,
      parent,
      kids,
      declaredCount,
      nextChild: 0,
      reachablePages: 0,
    };
  };

  const stack = [frameFor(root, null)];
  while (stack.length > 0) {
    const frame = stack[stack.length - 1];
    if (frame.nextChild >= frame.kids.size()) {
      if (frame.reachablePages !== frame.declaredCount) {
        throw new Error("page tree count does not match reachable pages");
      }
      stack.pop();
      if (frame.parent) {
        frame.parent.reachablePages += frame.reachablePages;
      }
      continue;
    }

    const childToken = frame.kids.get(frame.nextChild);
    frame.nextChild += 1;
    if (!(childToken instanceof PDFRef)) {
      throw new Error("page tree children must be indirect references");
    }
    const child = pdfDoc.context.lookupMaybe(childToken, PDFPageTree, PDFPageLeaf);
    if (!(child instanceof PDFPageTree) && !(child instanceof PDFPageLeaf)) {
      throw new Error("page tree child is unavailable or has an invalid type");
    }
    if (seenNodes.has(child)) {
      throw new Error("page tree contains a cycle or duplicate child");
    }
    seenNodes.add(child);
    const parent = child.lookupMaybe(PDFName.of("Parent"), PDFPageTree);
    if (parent !== frame.tree) {
      throw new Error("page tree child has an invalid parent");
    }
    if (child instanceof PDFPageLeaf) {
      frame.reachablePages += 1;
    } else {
      stack.push(frameFor(child, frame));
    }
  }
}

function validateLoadedPdfStructure(pdfDoc, pdfBytes) {
  const invalidPdfMessage = "Failed to load PDF: the file is malformed, incomplete, or unsupported.";
  const structureDigest = sha256Bytes(pdfBytes);
  if (validatedPdfStructureDigests.has(structureDigest)) {
    rememberValidatedPdfStructure(structureDigest);
    return pdfDoc;
  }
  try {
    validatePdfPageTree(pdfDoc);
  } catch (error) {
    throw new Error(invalidPdfMessage, { cause: error });
  }
  rememberValidatedPdfStructure(structureDigest);
  return pdfDoc;
}

/**
 * Loads bytes through pdf-lib, optionally decrypting first.
 *
 * pdf-lib is always tried first, so an unencrypted document pays nothing for
 * this path: no QPDF module is instantiated and no extra parse happens. Only
 * once pdf-lib has refused the document as encrypted, and only for an
 * operation named in `ENCRYPTED_READ_OPERATIONS`, is the decrypting path
 * entered at all.
 *
 * `decryptFor` is the opt-in. Passing it means "this operation only reads, and
 * is allowed to decrypt subject to the rules in server/qpdf-decrypt.js".
 * Without it the behaviour is exactly what it was: the honest pdf-lib message.
 *
 * When decryption happens the caller is handed a `releaseDecryptedBytes` and
 * must call it once it has finished reading `pdfDoc`. pdf-lib copies the input
 * during parsing, so releasing afterwards does not disturb the loaded
 * document.
 */
async function loadPdfBytes(pdfBytes, password = null, { decryptFor = null } = {}) {
  const invalidPdfMessage = "Failed to load PDF: the file is malformed, incomplete, or unsupported.";
  let pdfDoc;
  try {
    pdfDoc = await PDFDocument.load(pdfBytes, password ? { password } : {});
  } catch (error) {
    if (error.message?.includes("password") || error.message?.includes("encrypt")) {
      if (!decryptFor) throw new Error(PDF_LIB_ENCRYPTED_MESSAGE);
      return loadEncryptedPdfBytes(pdfBytes, password, decryptFor, invalidPdfMessage);
    }
    throw new Error(invalidPdfMessage, { cause: error });
  }
  return { pdfDoc: validateLoadedPdfStructure(pdfDoc, pdfBytes), releaseDecryptedBytes: () => {} };
}

/**
 * The encrypted branch of `loadPdfBytes`. Decrypts in memory, parses the
 * plaintext, and releases the plaintext immediately if parsing fails so a
 * malformed decrypted document does not leave it sitting in the heap.
 *
 * The plaintext gets the same pre-parse bounds the mutation path applies to a
 * document it is about to hand pdf-lib: `assertBoundedPdfStructure` for hostile
 * cross-reference byte widths and sparse object numbering, and
 * `assertBoundedPdfStreamDecodes` for object streams that expand past a
 * deterministic ceiling. Those are the two shapes that make `PDFDocument.load`
 * allocate without bound, and this is the one place in the server process where
 * pdf-lib parses bytes that did not come straight off disk.
 *
 * It is belt and braces rather than a live hole. `qpdf --decrypt` fully
 * re-serializes the document, which launders hostile cross-reference structure
 * on the way through — a `/W [1 2000000000 1]` does not survive the round trip.
 * But that is a property of QPDF's writer, not a contract it offers us, and it
 * is the sort of property that evaporates quietly. Measured at 7.2 MB the two
 * checks cost 22 ms against the 314 ms of pdf-lib parsing that follows
 * unconditionally, so paying for the guarantee outright is cheaper than
 * depending on somebody else's serializer to keep providing it.
 */
async function loadEncryptedPdfBytes(pdfBytes, password, decryptFor, invalidPdfMessage) {
  const decrypted = await decryptPdfForRead(pdfBytes, password, decryptFor);
  let pdfDoc;
  try {
    assertBoundedPdfStructure(decrypted.plaintext);
    await assertBoundedPdfStreamDecodes(decrypted.plaintext);
    pdfDoc = await PDFDocument.load(decrypted.plaintext);
    // Validated against the plaintext, because that is the byte sequence this
    // document was actually parsed from.
    validateLoadedPdfStructure(pdfDoc, decrypted.plaintext);
  } catch (error) {
    decrypted.release();
    // A bound that was exceeded is a specific, actionable fact and says which
    // one. Collapsing it into "the file is malformed" would throw that away and
    // describe a document this code deliberately refused as one it could not
    // understand.
    if (error?.code === PDF_RESOURCE_LIMIT_CODE) throw error;
    if (error?.message === invalidPdfMessage) throw error;
    throw new Error(invalidPdfMessage, { cause: error });
  }
  return { pdfDoc, releaseDecryptedBytes: () => decrypted.release() };
}

async function loadPdf(inputPath, password = null, { decryptFor = null } = {}) {
  const {
    resolvedPath,
    pdfBytes,
    fileIdentity,
    inputRecoveryBinding,
  } = await readPdfInputWithRecovery(inputPath);
  const { pdfDoc, releaseDecryptedBytes } = await loadPdfBytes(pdfBytes, password, { decryptFor });
  return {
    pdfDoc,
    resolvedPath,
    // Always the bytes as they are on disk. A decrypted copy is never returned
    // here and never reaches a caller that might persist it.
    pdfBytes,
    fileIdentity,
    inputRecoveryBinding,
    releaseDecryptedBytes,
  };
}

async function readCurrentPdfMutationBytes(inputPath) {
  const { bytes } = await readBoundedPdfFile(
    inputPath,
    PDF_MUTATION_MAX_FILE_BYTES,
    { createSizeLimitError: pdfMutationFileLimitError },
  );
  return bytes;
}

function bindRecoveredMutationSource(input, pdfBytes = input.pdfBytes) {
  if (
    !input?.canonicalPath
    || !input?.fileIdentity
    || !Number.isSafeInteger(input.sizeBytes)
    || !Buffer.isBuffer(pdfBytes)
    || pdfBytes.length !== input.sizeBytes
  ) {
    throw new TypeError("A complete recovered PDF source binding is required.");
  }
  return {
    canonical_path: input.canonicalPath,
    file_identity: input.fileIdentity,
    sha256: sha256Bytes(pdfBytes),
    size_bytes: input.sizeBytes,
  };
}

// Import helpers extracted for testability
import {
  parsePageRanges,
  downloadPdfFromUrl,
  findUniquePath,
  validateSignatureName,
  parseImageDataUrl,
  validateSigningIntent,
  stampSignatureOnPage,
  stampTextOnPage,
  drawSignatureFieldOnPage,
  formatSigningAuditLine,
  detectExistingSignatures,
  detectXfaForm,
  assertXfaMutationAllowed,
  computeIoU,
  getRegionPixelRect,
  expandHostPlaceholders,
  parseAllowedDirectoryArgs,
  validatePdfFormFields,
  failedPdfFormValidation,
  copyPdfPagesPreservingForms,
  copyPdfDocumentMetadata,
  captureMergeDescriptiveMetadata,
  applyMergeDescriptiveMetadataConsensus,
  recoverPdfOutputTransactions,
  writePdfOutputAtomic,
  writePdfOutputsAtomic,
  MIN_TEXT_CHARS_WITH_IMAGES,
  openVerifiedRegularFile,
  PDF_LIB_ENCRYPTED_MESSAGE,
  PDF_LIB_GEOMETRY_PASSWORD_DESCRIPTION,
} from "./helpers.js";

// Helper: validate profile name to prevent path traversal
function validateProfileName(name) {
  if (!name || typeof name !== "string") throw new Error("Profile name is required.");
  if (!/^[\w\-. ]+$/.test(name)) {
    throw new Error("Profile name may only contain letters, numbers, hyphens, underscores, spaces, and dots.");
  }
  return name;
}

function normalizeStoredSignatureMetadata(record) {
  if (!record || typeof record !== "object" || Array.isArray(record)) {
    throw new Error("Stored signature record must be an object.");
  }
  const name = validateSignatureName(record.name);
  if (!name) {
    throw new Error("Stored signature record is missing a valid name.");
  }
  if (!["typed", "image"].includes(record.style)) {
    throw new Error("Stored signature record has an unsupported style.");
  }

  let displayName = null;
  if (record.display_name !== undefined && record.display_name !== null) {
    if (typeof record.display_name !== "string") {
      throw new Error("Stored signature display_name must be a string.");
    }
    displayName = record.display_name.trim() || null;
    if (displayName && displayName.length > 120) {
      throw new Error("Stored signature display_name is too long (>120 chars).");
    }
  }

  let createdAt = null;
  if (record.created_at !== undefined && record.created_at !== null && record.created_at !== "") {
    if (typeof record.created_at !== "string") {
      throw new Error("Stored signature created_at must be a string when present.");
    }
    createdAt = record.created_at;
  }

  return {
    name,
    style: record.style,
    display_name: displayName,
    // Signatures saved before created_at was introduced remain usable.
    created_at: createdAt,
  };
}

function decodeStoredSignatureImage(record, mime) {
  const maximumImageBytes = 10 * 1024 * 1024;
  if (typeof record.image_data_b64 !== "string" || !record.image_data_b64.trim()) {
    throw new Error("Stored image signature is missing image_data_b64.");
  }
  const encoded = record.image_data_b64.replace(/\s+/g, "");
  if (encoded.length > 4 * Math.ceil(maximumImageBytes / 3)) {
    throw new Error("Stored image signature is too large (>10 MiB).");
  }
  const canonicalBase64 = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/;
  if (encoded.length % 4 !== 0 || !canonicalBase64.test(encoded)) {
    throw new Error("Stored image signature contains invalid base64 data.");
  }
  const bytes = Buffer.from(encoded, "base64");
  if (bytes.length === 0 || bytes.toString("base64") !== encoded) {
    throw new Error("Stored image signature contains invalid base64 data.");
  }
  if (bytes.length > maximumImageBytes) {
    throw new Error("Stored image signature is too large (>10 MiB).");
  }
  const isPng = bytes.subarray(0, 8).toString("hex") === "89504e470d0a1a0a";
  const isJpeg = bytes.subarray(0, 3).toString("hex") === "ffd8ff";
  if ((mime === "image/png" && !isPng) || (mime === "image/jpeg" && !isJpeg)) {
    throw new Error(`Stored image signature bytes do not match ${mime}.`);
  }
  const hasPngTerminator = bytes.length >= 20
    && bytes.subarray(bytes.length - 12).toString("hex") === "0000000049454e44ae426082";
  const hasJpegTerminator = bytes.length >= 4
    && bytes.subarray(bytes.length - 2).toString("hex") === "ffd9";
  if ((mime === "image/png" && !hasPngTerminator) || (mime === "image/jpeg" && !hasJpegTerminator)) {
    throw new Error(`Stored image signature contains incomplete ${mime} image data.`);
  }
  return { bytes, encoded };
}

async function normalizeStoredSignatureRecord(record, expectedName = null) {
  const metadata = normalizeStoredSignatureMetadata(record);
  if (expectedName !== null && metadata.name !== expectedName) {
    throw new Error(
      `Stored signature record name "${metadata.name}" does not match requested signature "${expectedName}".`
    );
  }
  if (metadata.style === "typed") {
    if (!metadata.display_name) {
      throw new Error("Stored typed signature is missing a valid display_name.");
    }
    const winAnsiExtras = new Set([
      0x0152, 0x0153, 0x0160, 0x0161, 0x0178, 0x017d, 0x017e, 0x0192,
      0x02c6, 0x02dc, 0x2013, 0x2014, 0x2018, 0x2019, 0x201a, 0x201c,
      0x201d, 0x201e, 0x2020, 0x2021, 0x2022, 0x2026, 0x2030, 0x2039,
      0x203a, 0x20ac, 0x2122,
    ]);
    const renderable = [...metadata.display_name].every(character => {
      const codePoint = character.codePointAt(0);
      return (codePoint >= 0x20 && codePoint <= 0x7e)
        || (codePoint >= 0xa0 && codePoint <= 0xff)
        || winAnsiExtras.has(codePoint);
    });
    if (!renderable) {
      throw new Error("Stored typed signature display_name cannot be rendered by the signature font.");
    }
    return metadata;
  }

  if (typeof record.image_mime !== "string") {
    throw new Error("Stored image signature is missing image_mime.");
  }
  const mime = record.image_mime.toLowerCase() === "image/jpg"
    ? "image/jpeg"
    : record.image_mime.toLowerCase();
  if (mime !== "image/png" && mime !== "image/jpeg") {
    throw new Error("Stored image signature image_mime must be image/png or image/jpeg.");
  }
  const { encoded } = decodeStoredSignatureImage(record, mime);

  let sourcePath;
  if (record.source_path !== undefined && record.source_path !== null) {
    if (typeof record.source_path !== "string" || !record.source_path) {
      throw new Error("Stored image signature source_path must be a non-empty string when present.");
    }
    sourcePath = record.source_path;
  }

  return {
    ...metadata,
    image_mime: mime,
    image_data_b64: encoded,
    ...(sourcePath ? { source_path: sourcePath } : {}),
  };
}

async function normalizeStoredSignatureSummary(record) {
  const normalized = await normalizeStoredSignatureRecord(record);
  return {
    name: normalized.name,
    style: normalized.style,
    display_name: normalized.display_name,
    created_at: normalized.created_at,
  };
}

function requireArgumentObject(args, toolName) {
  if (!args || typeof args !== "object" || Array.isArray(args)) {
    throw new Error(`${toolName} arguments must be an object.`);
  }
  return args;
}

function requireStringArgument(value, name, { maxLength = null } = {}) {
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`'${name}' is required and must be a non-empty string.`);
  }
  if (maxLength !== null && value.length > maxLength) {
    throw new Error(`'${name}' must not exceed ${maxLength} characters.`);
  }
  return value;
}

function optionalStringArgument(value, name, { maxLength = null } = {}) {
  if (value === undefined) return null;
  return requireStringArgument(value, name, { maxLength });
}

function optionalBooleanArgument(value, name, fallback = false) {
  if (value === undefined) return fallback;
  if (typeof value !== "boolean") {
    throw new Error(`'${name}' must be a boolean.`);
  }
  return value;
}

function normalizeExpectedOutputIdentity(value, name = "expected_output_identity") {
  if (value === undefined || value === null) return null;
  const identity = requireArgumentObject(value, name);
  const keys = Object.keys(identity).sort();
  if (keys.join(",") !== "canonical_path,sha256,size_bytes") {
    throw new Error(
      `'${name}' must contain exactly canonical_path, size_bytes, and sha256.`,
    );
  }
  const canonicalPath = requireStringArgument(
    identity.canonical_path,
    `${name}.canonical_path`,
  );
  if (!path.isAbsolute(canonicalPath) || path.resolve(canonicalPath) !== canonicalPath) {
    throw new Error(`'${name}.canonical_path' must be an absolute normalized path.`);
  }
  const sizeBytes = requireIntegerArgument(
    identity.size_bytes,
    `${name}.size_bytes`,
    { min: 0 },
  );
  const sha256 = requireStringArgument(identity.sha256, `${name}.sha256`);
  if (!/^[a-f0-9]{64}$/.test(sha256)) {
    throw new Error(`'${name}.sha256' must be a lowercase SHA-256 digest.`);
  }
  return { canonicalPath, sizeBytes, sha256 };
}

const EXPECTED_OUTPUT_IDENTITY_INPUT_SCHEMA = Object.freeze({
  type: "object",
  additionalProperties: false,
  description:
    "Exact current identity returned by get_pdf_identity. Required when replacing a distinct existing output_path, optional for the separately guarded same-document backup workflow, and omitted for a new destination.",
  properties: {
    canonical_path: {
      type: "string",
      description: "Exact canonical_path returned by get_pdf_identity for the existing destination.",
    },
    size_bytes: {
      type: "integer",
      minimum: 0,
      description: "Exact size_bytes returned by get_pdf_identity for the existing destination.",
    },
    sha256: {
      type: "string",
      pattern: "^[a-f0-9]{64}$",
      description: "Exact SHA-256 returned by get_pdf_identity for the existing destination.",
    },
  },
  required: ["canonical_path", "size_bytes", "sha256"],
});

// get_pdf_identity refuses a file without a PDF header, so it cannot identify
// an existing .md destination. The conversion that wrote the file reports the
// same three values in saved_output.
const EXPECTED_MARKDOWN_OUTPUT_IDENTITY_INPUT_SCHEMA = Object.freeze({
  type: "object",
  additionalProperties: false,
  description:
    "Exact current identity of the existing .md output_path: canonical path, byte length, and SHA-256. get_pdf_identity cannot supply it, because it requires a PDF header; the convert_pdf_to_markdown result that wrote the file reports these values as saved_output.path, saved_output.bytes, and saved_output.sha256. Required with overwrite=true; omit it for a new destination.",
  properties: {
    canonical_path: {
      type: "string",
      description: "Exact canonical path of the existing destination, as reported in saved_output.path.",
    },
    size_bytes: {
      type: "integer",
      minimum: 0,
      description: "Exact byte length of the existing destination, as reported in saved_output.bytes.",
    },
    sha256: {
      type: "string",
      pattern: "^[a-f0-9]{64}$",
      description: "Exact SHA-256 of the existing destination, as reported in saved_output.sha256.",
    },
  },
  required: ["canonical_path", "size_bytes", "sha256"],
});

const EXPECTED_OUTPUT_IDENTITIES_INPUT_SCHEMA = Object.freeze({
  type: "array",
  maxItems: 1000,
  description:
    "Exact identities for generated batch destinations that already exist. Omit new destinations. Any stale, duplicate, unrelated, or missing entry aborts the whole batch.",
  items: {
    type: "object",
    additionalProperties: false,
    properties: {
      output_path: {
        type: "string",
        description: "Computed absolute output path this identity authorizes replacing.",
      },
      ...EXPECTED_OUTPUT_IDENTITY_INPUT_SCHEMA.properties,
    },
    required: ["output_path", "canonical_path", "size_bytes", "sha256"],
  },
});

function normalizeExpectedOutputIdentities(value) {
  if (value === undefined || value === null) return new Map();
  if (!Array.isArray(value) || value.length > 1000) {
    throw new Error("'expected_output_identities' must be an array of at most 1000 identities.");
  }
  const identities = new Map();
  for (const [index, item] of value.entries()) {
    const entry = requireArgumentObject(
      item,
      `expected_output_identities[${index}]`,
    );
    const keys = Object.keys(entry).sort();
    if (keys.join(",") !== "canonical_path,output_path,sha256,size_bytes") {
      throw new Error(
        `'expected_output_identities[${index}]' has unexpected properties.`,
      );
    }
    const outputPath = requireStringArgument(
      entry.output_path,
      `expected_output_identities[${index}].output_path`,
    );
    if (!path.isAbsolute(outputPath) || path.resolve(outputPath) !== outputPath) {
      throw new Error(
        `'expected_output_identities[${index}].output_path' must be an absolute normalized path.`,
      );
    }
    if (identities.has(outputPath)) {
      throw new Error(`Duplicate expected output identity for: ${outputPath}`);
    }
    identities.set(outputPath, normalizeExpectedOutputIdentity({
      canonical_path: entry.canonical_path,
      size_bytes: entry.size_bytes,
      sha256: entry.sha256,
    }, `expected_output_identities[${index}]`));
  }
  return identities;
}

function requireIntegerArgument(value, name, { min = null } = {}) {
  if (!Number.isInteger(value) || (min !== null && value < min)) {
    const suffix = min === null ? "an integer" : `an integer >= ${min}`;
    throw new Error(`'${name}' must be ${suffix}.`);
  }
  return value;
}

function requireNumberArgument(value, name, { min = null, exclusiveMin = false } = {}) {
  const belowMinimum = min !== null && (exclusiveMin ? value <= min : value < min);
  if (typeof value !== "number" || !Number.isFinite(value) || belowMinimum) {
    const suffix = min === null
      ? "a finite number"
      : `a finite number ${exclusiveMin ? ">" : ">="} ${min}`;
    throw new Error(`'${name}' must be ${suffix}.`);
  }
  return value;
}

function normalizePlacementArguments(value, name = "arguments") {
  const args = requireArgumentObject(value, name);
  return {
    page: requireIntegerArgument(args.page, `${name}.page`, { min: 1 }),
    x: requireNumberArgument(args.x, `${name}.x`, { min: 0 }),
    y: requireNumberArgument(args.y, `${name}.y`, { min: 0 }),
    width: requireNumberArgument(args.width, `${name}.width`, { min: 0, exclusiveMin: true }),
    height: requireNumberArgument(args.height, `${name}.height`, { min: 0, exclusiveMin: true }),
  };
}

function normalizeMutationArguments(value, toolName) {
  const args = requireArgumentObject(value, toolName);
  return {
    pdf_path: requireStringArgument(args.pdf_path, "pdf_path"),
    output_path: requireStringArgument(args.output_path, "output_path"),
    allow_resign: optionalBooleanArgument(args.allow_resign, "allow_resign"),
    force_xfa: optionalBooleanArgument(args.force_xfa, "force_xfa"),
    password: optionalStringArgument(args.password, "password"),
    expected_output_identity: normalizeExpectedOutputIdentity(
      args.expected_output_identity,
    ),
    ...normalizePlacementArguments(args),
  };
}

function normalizeAddSignatureFieldArguments(value) {
  const args = requireArgumentObject(value, "add_signature_field");
  const normalized = normalizeMutationArguments(args, "add_signature_field");
  let label = "Sign here";
  if (args.label !== undefined) {
    if (typeof args.label !== "string") {
      throw new Error("'label' must be a string.");
    }
    label = args.label || "Sign here";
  }
  return { ...normalized, label };
}

function normalizeApplyTextArguments(value) {
  const args = requireArgumentObject(value, "apply_text");
  const normalized = normalizeMutationArguments(args, "apply_text");
  const text = requireStringArgument(args.text, "text", { maxLength: 200 });
  const fontStyle = args.font_style === undefined ? "normal" : args.font_style;
  if (!["normal", "italic"].includes(fontStyle)) {
    throw new Error("'font_style' must be 'normal' or 'italic'.");
  }
  const legacyOverwrite = optionalBooleanArgument(args.overwrite, "overwrite");
  return {
    ...normalized,
    text,
    font_style: fontStyle,
    legacy_overwrite: legacyOverwrite,
  };
}

function normalizeApplySignatureArguments(value) {
  const args = requireArgumentObject(value, "apply_signature");
  const normalized = normalizeMutationArguments(args, "apply_signature");
  const signingMode = args.signing_mode === undefined ? "signature" : args.signing_mode;
  if (!["signature", "initials"].includes(signingMode)) {
    throw new Error("'signing_mode' must be 'signature' or 'initials'.");
  }
  const legacyOverwrite = optionalBooleanArgument(args.overwrite, "overwrite");
  return {
    ...normalized,
    signature_name: requireStringArgument(args.signature_name, "signature_name"),
    user_intent_statement: requireStringArgument(args.user_intent_statement, "user_intent_statement"),
    user_confirmed_at: requireStringArgument(args.user_confirmed_at, "user_confirmed_at"),
    draw_audit_line: optionalBooleanArgument(args.draw_audit_line, "draw_audit_line"),
    signing_mode: signingMode,
    legacy_overwrite: legacyOverwrite,
  };
}

const SIGNING_PACKET_ZONE_TYPES = new Set([
  "signature",
  "initials",
  "date",
  "printed_name",
  "witness_signature",
]);
const SIGNING_PACKET_EVIDENCE_SOURCES = new Set([
  "caller_supplied",
  "detect_signature_zones",
  "acroform",
]);
const SIGNING_PACKET_TOKEN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;

function normalizeSigningPacketToken(value, name) {
  if (value === undefined) return null;
  if (typeof value !== "string" || !SIGNING_PACKET_TOKEN.test(value)) {
    throw new Error(`'${name}' must be a stable 1-128 character identifier.`);
  }
  return value;
}

function normalizePrepareSigningPacketArguments(value) {
  const args = requireArgumentObject(value, "prepare_signing_packet");
  const allowedKeys = new Set([
    "allow_resign",
    "expected_output_identity",
    "field_values",
    "force_xfa",
    "output_path",
    "password",
    "pdf_path",
    "require_provider_ready",
    "signature_locations",
  ]);
  const unexpectedKeys = Object.keys(args).filter(key => !allowedKeys.has(key));
  if (unexpectedKeys.length > 0) {
    throw new Error(`prepare_signing_packet has unexpected properties: ${unexpectedKeys.sort().join(", ")}.`);
  }
  if (
    args.field_values !== undefined &&
    (!args.field_values || typeof args.field_values !== "object" || Array.isArray(args.field_values))
  ) {
    throw new Error("'field_values' must be an object.");
  }
  for (const fieldName of Object.keys(args.field_values ?? {})) {
    if (!fieldName || fieldName.length > 500) {
      throw new Error("'field_values' contains an invalid field name.");
    }
  }
  if (args.signature_locations !== undefined && !Array.isArray(args.signature_locations)) {
    throw new Error("'signature_locations' must be an array.");
  }
  const requireProviderReady = optionalBooleanArgument(
    args.require_provider_ready,
    "require_provider_ready",
  );
  const observedZoneIds = new Set();
  const observedZoneBindings = new Set();
  const signatureLocations = (args.signature_locations || []).map((location, index) => {
    const locationObject = requireArgumentObject(location, `signature_locations[${index}]`);
    const locationKeys = new Set([
      "evidence_source",
      "field_type",
      "height",
      "label",
      "page",
      "participant_id",
      "participant_role",
      "width",
      "x",
      "y",
      "zone_id",
    ]);
    const unexpected = Object.keys(locationObject).filter(key => !locationKeys.has(key));
    if (unexpected.length > 0) {
      throw new Error(
        `'signature_locations[${index}]' has unexpected properties: ${unexpected.sort().join(", ")}.`,
      );
    }
    const normalized = normalizePlacementArguments(location, `signature_locations[${index}]`);
    let label = "Sign here";
    if (location.label !== undefined) {
      if (
        typeof location.label !== "string"
        || location.label.length < 1
        || location.label.length > 500
        || location.label.trim().length < 1
      ) {
        throw new Error(`'signature_locations[${index}].label' must be a non-blank string of at most 500 characters.`);
      }
      label = location.label;
    }
    const fieldType = location.field_type === undefined ? "unspecified" : location.field_type;
    if (fieldType !== "unspecified" && !SIGNING_PACKET_ZONE_TYPES.has(fieldType)) {
      throw new Error(`'signature_locations[${index}].field_type' is unsupported.`);
    }
    const evidenceSource = location.evidence_source === undefined
      ? "caller_supplied"
      : location.evidence_source;
    if (!SIGNING_PACKET_EVIDENCE_SOURCES.has(evidenceSource)) {
      throw new Error(`'signature_locations[${index}].evidence_source' is unsupported.`);
    }
    const participantId = normalizeSigningPacketToken(
      location.participant_id,
      `signature_locations[${index}].participant_id`,
    );
    const participantRole = normalizeSigningPacketToken(
      location.participant_role,
      `signature_locations[${index}].participant_role`,
    );
    const zoneBinding = {
      ...normalized,
      label,
      field_type: fieldType,
      participant_id: participantId,
      participant_role: participantRole,
      evidence_source: evidenceSource,
    };
    const zoneId = location.zone_id === undefined
      ? `zone-${sha256Bytes(Buffer.from(
          `pdf-tools.signing-zone.v1\0${canonicalJson(zoneBinding)}`,
          "utf8",
        ))}`
      : normalizeSigningPacketToken(location.zone_id, `signature_locations[${index}].zone_id`);
    if (observedZoneIds.has(zoneId)) {
      throw new Error(`Duplicate signing zone ID: ${zoneId}.`);
    }
    const bindingDigest = sha256Bytes(Buffer.from(canonicalJson({
      page: normalized.page,
      x: normalized.x,
      y: normalized.y,
      width: normalized.width,
      height: normalized.height,
    }), "utf8"));
    if (observedZoneBindings.has(bindingDigest)) {
      throw new Error(`Conflicting duplicate signing zone geometry at signature_locations[${index}].`);
    }
    observedZoneIds.add(zoneId);
    observedZoneBindings.add(bindingDigest);
    if (
      requireProviderReady
      && (
        fieldType === "unspecified"
        || participantId === null
        || participantRole === null
      )
    ) {
      throw new Error(
        `'signature_locations[${index}]' must bind field_type, participant_id, and participant_role when require_provider_ready=true.`,
      );
    }
    return { ...zoneBinding, zone_id: zoneId };
  });
  if (requireProviderReady && signatureLocations.length === 0) {
    throw new Error("require_provider_ready=true requires at least one fully bound signature location.");
  }
  return {
    pdf_path: requireStringArgument(args.pdf_path, "pdf_path"),
    output_path: requireStringArgument(args.output_path, "output_path"),
    field_values: args.field_values === undefined ? null : args.field_values,
    signature_locations: signatureLocations,
    allow_resign: optionalBooleanArgument(args.allow_resign, "allow_resign"),
    force_xfa: optionalBooleanArgument(args.force_xfa, "force_xfa"),
    password: optionalStringArgument(args.password, "password"),
    require_provider_ready: requireProviderReady,
    expected_output_identity: normalizeExpectedOutputIdentity(
      args.expected_output_identity,
    ),
  };
}

function normalizeSetActiveDocumentArguments(value) {
  const args = requireArgumentObject(value, "set_active_document");
  const lastMutationTool = optionalStringArgument(
    args.last_mutation_tool,
    "last_mutation_tool",
    { maxLength: 128 },
  );
  const rawMutationAt = optionalStringArgument(args.last_mutation_at, "last_mutation_at");
  let lastMutationAt = null;
  if (rawMutationAt !== null) {
    const parsed = new Date(rawMutationAt);
    if (Number.isNaN(parsed.getTime())) {
      throw new Error("'last_mutation_at' must be a valid ISO-8601 timestamp.");
    }
    lastMutationAt = parsed.toISOString();
  }
  return {
    pdf_path: requireStringArgument(args.pdf_path, "pdf_path"),
    backup_path: optionalStringArgument(args.backup_path, "backup_path"),
    last_mutation_tool: lastMutationTool,
    last_mutation_at: lastMutationAt,
  };
}

const PROMPT_TEMPLATES = [
  {
    name: "view_and_analyze_pdf",
    description: "Open and analyze any PDF document",
    arguments: ["focus"],
    text: "Use PDF Tools to open a PDF stored on this computer and analyze it, focusing on ${arguments.focus}. If I haven't given you a path, start by listing the PDFs in my default folder so I can pick one. Then extract key findings, summarize sections, answer questions about specific pages, pull out structured data, and identify form fields if present.",
  },
  {
    name: "research_paper_analysis",
    description: "Analyze & summarize research papers",
    arguments: ["focus_area"],
    text: "Use PDF Tools to analyze a research paper stored on this computer, focusing on ${arguments.focus_area}. If I haven't given you a path, start by listing the PDFs in my default folder so I can pick one. Extract the key findings and methodology, identify research gaps, summarize it chapter by chapter, pull out the citations, and draft a literature review outline.",
  },
  {
    name: "contract_comparison",
    description: "Compare legal documents & contracts",
    arguments: ["comparison_focus"],
    text: "Use PDF Tools to compare contracts or legal documents stored on this computer, focusing on ${arguments.comparison_focus}. If I haven't given you their paths, start by listing the PDFs in my default folder so I can pick them. Highlight changed clauses, modified terms, added or removed sections, pricing differences, and liability changes, then summarize the comparison.",
  },
  {
    name: "financial_report_extraction",
    description: "Extract data from financial statements",
    arguments: ["output_format"],
    text: "Use PDF Tools to extract and analyze data from financial PDFs stored on this computer, including tables and key metrics. If I haven't given you a path, start by listing the PDFs in my default folder so I can pick one. Convert what you extract to ${arguments.output_format} format, cite the page for the values you extract, and tell me plainly about anything you could not extract.",
  },
  {
    name: "document_qa_session",
    description: "Interactive Q&A about your documents",
    arguments: ["initial_question"],
    text: "Use PDF Tools to open a PDF stored on this computer so we can discuss it. My first question is: ${arguments.initial_question}. If I haven't given you a path, start by listing the PDFs in my default folder so I can pick one. Find specific information, explain complex sections, cross-reference different parts, and quote passages with their page numbers.",
  },
  {
    name: "bulk_invoice_processing",
    description: "Process multiple invoices into structured data",
    arguments: ["folder_path", "output_format"],
    text: "Use PDF Tools to process the invoice PDFs in the folder ${arguments.folder_path} on this computer and build a unified dataset in ${arguments.output_format} format. Start by listing the PDFs in that folder so I can see what you found. Extract vendor names, invoice numbers, dates, line items, totals, tax amounts, and payment terms, and tell me about any invoice you could not read.",
  },
  {
    name: "technical_documentation_summary",
    description: "Summarize technical manuals & documentation",
    arguments: ["summary_type"],
    text: "Use PDF Tools to analyze technical documentation stored on this computer and create ${arguments.summary_type}. If I haven't given you a path, start by listing the PDFs in my default folder so I can pick one. Extract the code examples, build a reference guide, identify the implementation steps, and summarize the troubleshooting sections.",
  },
  {
    name: "fill_w9_business",
    description: "Fill W-9 for business entity",
    arguments: [],
    text: "Use PDF Tools to fill out a W-9 stored on this computer for my business. If I haven't already given you the file, start by listing the PDFs in my default folder so I can point you at the right form, then read its fields. Ask me for the business legal name, the DBA or trade name if it differs, the business type (LLC, corporation, partnership), the tax classification, the EIN, and the business address. Check the correct tax classification boxes and tell me about any required field you could not fill.",
  },
  {
    name: "batch_invoices",
    description: "Process multiple invoices",
    arguments: [],
    text: "Use PDF Tools to batch process invoice PDFs stored on this computer. If I haven't already named them, start by listing the PDFs in my default folder so I can confirm which ones to use, or I'll name the folder they are in. Extract the amounts and dates, build a summary spreadsheet, flag missing information, total them by vendor, date, and category, and tell me about any invoice you could not read. Ask me which fields matter most before you start.",
  },
  {
    name: "rental_application",
    description: "Fill rental application",
    arguments: [],
    text: "Use PDF Tools to help me complete a rental application stored on this computer. If I haven't already given you the file, start by listing the PDFs in my default folder so I can point you at the right form, then read its fields. I'll have ready my personal details, three years of employment history, income verification, three years of previous addresses, references, vehicle information, and an emergency contact. Fill every required field and flag the ones that need supporting documents.",
  },
  {
    name: "extract_1099_data",
    description: "Extract data from 1099 forms",
    arguments: [],
    text: "Use PDF Tools to extract the data from 1099 forms stored on this computer (1099-NEC, 1099-MISC, 1099-DIV, 1099-INT and similar) and build a tax summary. If I haven't already named them, start by listing the PDFs in my default folder so I can confirm which ones to use. Organize by payer, identify the type of income, total each category, format it for import into tax software, and tell me about anything you could not read.",
  },
  {
    name: "merge_documents",
    description: "Combine multiple PDFs into one document",
    arguments: [],
    text: "Use PDF Tools to merge PDF files stored on this computer into one document. If I haven't already named them, start by listing the PDFs in my default folder so I can choose which ones to combine, then ask me where to save the result. Preserve the page order, and afterwards report the page count and the output path so I can check it. File operations happen locally; content you inspect is handled under my MCP host or model provider's data terms.",
  },
  {
    name: "split_large_document",
    description: "Split a PDF into smaller files",
    arguments: [],
    text: "Use PDF Tools to split a PDF stored on this computer into separate files. If I haven't given you a path, start by listing the PDFs in my default folder so I can pick one. I'll either give you exact page ranges (for example pages 1-10 and 11-20) or ask you to split at a regular interval (for example every 5 pages). Save each section as its own PDF and tell me where you wrote them.",
  },
  {
    name: "organize_scanned_pages",
    description: "Rotate and reorder scanned PDF pages",
    arguments: [],
    text: "Use PDF Tools to fix up a scanned PDF stored on this computer. If I haven't given you a path, start by listing the PDFs in my default folder so I can pick one. Rotate the pages I tell you are sideways or upside-down (90, 180, or 270 degrees) and reorder pages that were scanned out of sequence. Tell me the page order and rotations you plan to apply before you save, so I can confirm them.",
  },
];

const PROMPT_ARGUMENT_MAX_LENGTH = 1024;
// Cap on how many paths one list_pdfs call returns. Large enough that an
// ordinary folder is never truncated, small enough that a folder holding years
// of scanned documents cannot flood the conversation before any work starts.
const LIST_PDFS_MAX_RESULTS = 200;

// Shared by list_pdfs. Returns a non-negative integer, or throws with a message
// naming what arrived, so a caller that sends the wrong type finds out.
function parseListOffset(rawOffset) {
  if (rawOffset === undefined || rawOffset === null) return 0;
  const value = typeof rawOffset === "string" && rawOffset.trim() !== ""
    ? Number(rawOffset)
    : rawOffset;
  if (typeof value !== "number" || !Number.isFinite(value) || !Number.isInteger(value)) {
    throw new Error(
      `offset must be a whole number, received ${JSON.stringify(rawOffset)}.`,
    );
  }
  if (value < 0) {
    throw new Error(`offset must be zero or greater, received ${value}.`);
  }
  if (value > Number.MAX_SAFE_INTEGER) {
    throw new Error(`offset is too large.`);
  }
  return value;
}

// Values are substituted into a user-role message with no isolation, so this
// rejects control and invisible characters a reader could not see.
//
// It is deliberately NOT a defence against instruction-shaped text: a plain
// sentence saying "ignore the above" passes, by design, and docs/MCP_CONTRACT.md
// states that clients must not source these arguments from untrusted content.
//
// This is the set that has shipped for months. Widening it was tried twice and
// reverted both times, because each attempt broke ordinary input for a marginal
// gain against a threat the contract already places out of scope:
//   U+FE00-FE0F   contains U+FE0F, the emoji presentation selector, so it
//                 rejected a warning sign, a check mark, a heart, keycap digits
//   U+E0100-E01EF, U+061C   legitimate in CJK and in Arabic
//   U+E0000-E007F (Tags)   encodes hidden ASCII, but is also the encoding for
//                 the England, Scotland and Wales flag emoji
//
// Known and accepted limitation, inherited and not introduced here: the
// \u200b-\u200f range rejects U+200C and U+200D, so Persian and Devanagari ZWNJ
// and every ZWJ emoji sequence are refused. Fixing that means narrowing this
// range, not widening it, and needs its own change with its own evidence.
const PROMPT_ARGUMENT_UNSAFE_CONTROLS = /[\u0000-\u001f\u007f-\u009f\u00ad\u200b-\u200f\u2028-\u202e\u2060-\u206f\ufeff]/u;

function validatedPromptArguments(prompt, suppliedArguments = {}) {
  const expectedArguments = new Set(prompt.arguments);
  const unknownArguments = Object.keys(suppliedArguments)
    .filter(name => !expectedArguments.has(name));
  if (unknownArguments.length > 0) {
    throw new McpError(
      ErrorCode.InvalidParams,
      `Unknown argument(s) for prompt ${prompt.name}: ${unknownArguments.join(", ")}`,
    );
  }

  for (const argumentName of prompt.arguments) {
    if (!Object.prototype.hasOwnProperty.call(suppliedArguments, argumentName)) {
      throw new McpError(
        ErrorCode.InvalidParams,
        `Missing required argument for prompt ${prompt.name}: ${argumentName}`,
      );
    }
    const value = suppliedArguments[argumentName];
    if (typeof value !== "string") {
      throw new McpError(
        ErrorCode.InvalidParams,
        `Argument ${argumentName} for prompt ${prompt.name} must be a string`,
      );
    }
    if (value.length > PROMPT_ARGUMENT_MAX_LENGTH) {
      throw new McpError(
        ErrorCode.InvalidParams,
        `Argument ${argumentName} for prompt ${prompt.name} exceeds ${PROMPT_ARGUMENT_MAX_LENGTH} characters`,
      );
    }
    if (PROMPT_ARGUMENT_UNSAFE_CONTROLS.test(value)) {
      throw new McpError(
        ErrorCode.InvalidParams,
        `Argument ${argumentName} for prompt ${prompt.name} contains unsupported control characters`,
      );
    }
    // No argument value has a legitimate reason to carry a template marker, and
    // allowing one lets a value manufacture a placeholder for another argument.
    if (value.includes("${")) {
      throw new McpError(
        ErrorCode.InvalidParams,
        `Argument ${argumentName} for prompt ${prompt.name} may not contain template markers`,
      );
    }
  }
  return Object.fromEntries(prompt.arguments.map(name => [name, suppliedArguments[name]]));
}

// Values are substituted inline, and the result must be the declared prompt
// text with nothing added. That is a host constraint, not a preference.
//
// Claude Desktop validates the prompts/get response against the prompt text
// declared in the manifest. Anything extra is refused with "content validation
// failed. Rejecting response to prevent potential prompt injection", and the
// prompt does not attach at all. Measured on Windows 11 / Claude Desktop
// 1.25927.0 on 2026-08-06 by driving the host UI, four builds differing only
// here:
//
//   inline substitution, nothing added                        attaches
//   + delimited JSON argument block and "Task:" separator     refused
//   + JSON values appended, no delimiters                     refused
//   + one short plain sentence appended                       refused
//
// So an isolation wrapper cannot be reintroduced here. It does not merely look
// risky to the validator; it makes the feature unusable. This removed a real
// control: an earlier version put values in a delimited block referenced by
// name, which kept caller-supplied text out of the instruction stream.
//
// What that costs, stated plainly: prompts/get accepts arguments from any
// caller, and the rendered text is returned with role "user". A caller that
// fills an argument from untrusted content can therefore place text into an
// operative instruction. validatedPromptArguments is the only remaining
// barrier: it rejects non-strings, oversized values, control/bidi characters,
// and template markers. Hosts must not source these arguments from untrusted
// documents without their own review; docs/MCP_CONTRACT.md states this.
//
// Revisit if the host's validator changes. Do not "restore hardening" here
// without re-measuring against a real host first.
function renderPromptTemplate(prompt, suppliedArguments = {}) {
  const validatedArguments = validatedPromptArguments(prompt, suppliedArguments);
  // Single pass. Substituting one argument at a time lets an earlier value that
  // contains "${arguments.other}" capture a later argument's placeholder.
  return prompt.text.replace(
    /\$\{arguments\.([A-Za-z0-9_]+)\}/g,
    (placeholder, argumentName) =>
      Object.prototype.hasOwnProperty.call(validatedArguments, argumentName)
        ? validatedArguments[argumentName]
        : placeholder,
  );
}

function rejectUnissuedCursor(request, method) {
  if (Object.prototype.hasOwnProperty.call(request.params ?? {}, "cursor")) {
    throw new McpError(
      ErrorCode.InvalidParams,
      `${method} does not issue cursors; omit the cursor parameter`,
    );
  }
}

// Default directories - use environment variables from manifest or fallback to defaults
// Defensive env read — if Claude Desktop couldn't substitute a user_config
// template (MCPB version mismatch, missing config), the raw literal
// "${user_config.X}" would reach us and break readdir. Treat any template-
// shaped value as unset and fall through to the safe home-dir default.
function envPathOrDefault(name, fallback) {
  const raw = process.env[name];
  if (!raw) return fallback;
  const val = expandHostPlaceholders(raw);
  // Still templated after expansion means the host did not resolve it.
  if (val.includes("${")) return fallback;
  return val;
}
const DEFAULT_PDF_DIR = envPathOrDefault("DEFAULT_PDF_DIR", path.join(homedir(), "Documents"));
const DEFAULT_DOWNLOAD_DIR = envPathOrDefault("DEFAULT_DOWNLOAD_DIR", path.join(homedir(), "Downloads"));
// Keep in sync with manifest.json and share bundle defaults
const PROFILES_DIR = envPathOrDefault("DEFAULT_PROFILES_DIR", path.join(homedir(), ".pdf-toolkit-files"));
const SIGNATURES_DIR = path.join(PROFILES_DIR, "signatures");
const BACKUPS_DIR = path.join(PROFILES_DIR, "backups");
const VERIFIED_EXTRACTION_WORKSPACES_DIR = path.join(
  PROFILES_DIR,
  "verified-extraction-workspaces",
);
const OLD_PROFILES_DIR = path.join(homedir(), ".pdf-filler-profiles");

function parsePathListValue(rawValue) {
  const value = expandHostPlaceholders(rawValue);
  if (!value || value.includes("${")) return null;

  const trimmed = value.trim();
  if (!trimmed) return null;

  if (trimmed.startsWith("[")) {
    try {
      const parsed = JSON.parse(trimmed);
      if (Array.isArray(parsed)) {
        // An empty entry would resolve to the working directory, so it is
        // dropped rather than treated as a permission.
        return parsed
          .filter(item => typeof item === "string")
          .map(item => expandHostPlaceholders(item.trim()))
          .filter(item => item && !item.includes("${"));
      }
    } catch {}
  }

  const delimiters = [
    "\n",
    path.delimiter,
    ",",
  ].filter((delimiter, index, all) => delimiter && all.indexOf(delimiter) === index);
  const delimiter = delimiters.find((candidate) => trimmed.includes(candidate));
  if (!delimiter) return [trimmed];
  return trimmed
    .split(delimiter)
    .map(item => item.trim())
    .filter(Boolean);
}

// Direct access to user folders is established only by explicit configuration.
// A host that substitutes nothing never receives an implicit home-folder
// grant. Agent Plugin installs instead get one private workspace under
// PLUGIN_DATA; ordinary stdio installs without PLUGIN_DATA still fail closed.
// Agent Plugins 1.0.0 has no user-configuration mechanism and expands only
// ${PLUGIN_ROOT} and ${PLUGIN_DATA}, so a plugin install can reach neither the
// CLI flag nor the environment variable a host would otherwise set. PLUGIN_DATA
// is one location that specification guarantees exists, stays writable, and
// survives plugin updates. A plugin data file outranks the well-known home file,
// while host-supplied argument or environment configuration outranks both.
const PLUGIN_DATA_CONFIG_NAME = "config.json";
const PLUGIN_WORKSPACE_DIRECTORY_NAME = "workspace";
const HOME_CONFIG_DIRECTORY_NAME = ".pdf-tools";

function pluginDataConfigPath() {
  const pluginData = process.env.PLUGIN_DATA;
  if (!pluginData || pluginData.includes("${")) return null;
  return path.join(path.resolve(pluginData), PLUGIN_DATA_CONFIG_NAME);
}

function homeConfigPath() {
  return path.join(homedir(), HOME_CONFIG_DIRECTORY_NAME, PLUGIN_DATA_CONFIG_NAME);
}

function pluginWorkspacePath() {
  const pluginData = process.env.PLUGIN_DATA;
  if (!pluginData || pluginData.includes("${")) return null;
  return path.join(path.resolve(pluginData), PLUGIN_WORKSPACE_DIRECTORY_NAME);
}

// Agent Plugin hosts guarantee a private writable PLUGIN_DATA directory but do
// not currently pass a host-selected folder list to the MCP server. Give a
// fresh install one useful, narrow place to work without granting the rest of
// the user's home directory. A full-access host may intentionally import files
// into this directory; that is host-authorized copying, not direct PDF Tools
// access to the source path.
function ensurePluginWorkspace(workspacePath) {
  if (!workspacePath) return null;
  const pluginData = path.dirname(workspacePath);
  try {
    mkdirSync(pluginData, { recursive: true, mode: 0o700 });
    if (existsSync(workspacePath)) {
      const stat = lstatSync(workspacePath);
      if (!stat.isDirectory() || stat.isSymbolicLink()) {
        throw new Error("workspace is not a physical directory");
      }
    } else {
      mkdirSync(workspacePath, { mode: 0o700 });
    }
    chmodSync(workspacePath, 0o700);
    const canonicalPluginData = realpathSync.native(pluginData);
    const canonicalWorkspace = realpathSync.native(workspacePath);
    if (!isPathInsideDirectory(canonicalWorkspace, canonicalPluginData)
      || canonicalWorkspace === canonicalPluginData) {
      throw new Error("workspace resolves outside plugin data");
    }
    return { display: workspacePath, canonical: canonicalWorkspace };
  } catch (error) {
    console.error(
      `[pdf-tools] Could not establish the private plugin workspace at ${workspacePath}: ${error.message}. `
      + "No directories are allowed until the workspace or an explicit configuration is fixed.",
    );
    return null;
  }
}

// The template is the optional direct-folder override. Editing it is a human
// action the PDF Tools server cannot perform, which keeps direct path widening
// off the server's own authority.
function ensurePluginDataConfigTemplate(configPath) {
  if (!configPath || existsSync(configPath)) return;
  try {
    mkdirSync(path.dirname(configPath), { recursive: true });
    writeFileSync(
      configPath,
      JSON.stringify({
        _comment: "Optional folders this server may read and write directly. Absolute paths only. "
          + "A non-empty list replaces the private plugin workspace rather than adding to it, "
          + "so list every direct folder you need. luminOAuthClientId is a public application ID, "
          + "not a secret. Restart the server after editing.",
        allowedDirectories: [],
        luminOAuthClientId: "",
      }, null, 2) + "\n",
      { mode: 0o600 },
    );
  } catch {
    // A read-only or unwritable PLUGIN_DATA is the host's business. Failing to
    // write a hint must never be louder than the refusal it was meant to explain.
  }
}

// Create the discoverable template only when no higher layer supplied a value.
// Resolve the target through existing ancestors before writing so a symlinked
// .pdf-tools directory cannot redirect first-run setup outside the home folder.
function ensureHomeConfigTemplate(configPath) {
  if (!configPath || existsSync(configPath)) return;
  const canonicalHome = canonicalizePathForPolicy(homedir());
  const canonicalConfig = canonicalizePathForPolicy(configPath);
  if (!isPathInsideDirectory(canonicalConfig, canonicalHome)) {
    console.error(`[pdf-tools] Refusing to create ${configPath} because it resolves outside the home directory.`);
    return;
  }
  ensurePluginDataConfigTemplate(configPath);
}

// Returns the configured list, or null when this layer supplies nothing. A
// malformed file returns an empty list rather than null, to say "present,
// badly" rather than "not present". That distinction prevents a malformed or
// empty higher-precedence file from falling through to a lower layer.
// Three outcomes, not two. Collapsing "present but unusable" and "present and
// deliberately empty" into one empty list forces a single precedence answer for
// two different situations, and either answer is wrong for the other:
//
//   malformed  -> authoritative, fail closed. Falling through to a lower layer
//                 would silently paper over a file the user needs to fix.
//   valid+empty -> not a configuration. It must NOT shadow a lower layer, or
//                 anyone upgrading from a version that wrote an empty template
//                 finds the friendlier file they just edited silently ignored.
function readAllowedDirectoriesConfig(configPath) {
  if (!configPath || !existsSync(configPath)) return { status: "absent", directories: [] };
  let parsed;
  try {
    parsed = JSON.parse(readFileSync(configPath, "utf8"));
  } catch {
    console.error(`[pdf-tools] ${configPath} is not valid JSON. No directories are allowed until it is fixed.`);
    return { status: "malformed", directories: [] };
  }
  if (!parsed || typeof parsed !== "object" || !Array.isArray(parsed.allowedDirectories)) {
    console.error(`[pdf-tools] ${configPath} needs an "allowedDirectories" array. No directories are allowed until it is fixed.`);
    return { status: "malformed", directories: [] };
  }
  const directories = parsed.allowedDirectories
    .filter(entry => typeof entry === "string")
    .map(entry => expandHostPlaceholders(entry.trim()))
    .filter(entry => entry && !entry.includes("${"));
  return { status: "ok", directories };
}

// A set that reaches the config file lets any write tool rewrite the sandbox on
// the next launch. Refuse the whole set rather than dropping the entry, so the
// operator learns the boundary is wrong instead of quietly losing one folder.
function grantsAccessToOwnConfig(directories, configPath) {
  if (!configPath) return false;
  const canonicalConfig = canonicalizePathForPolicy(configPath);
  return directories.some(directory => isPathInsideDirectory(canonicalConfig, directory.canonical));
}

// Which precedence layer actually supplied the active set. Reported by
// get_allowed_directories so an operator can tell where to change it.
let ALLOWED_DIRECTORY_SOURCE = "none";
const PLUGIN_DATA_CONFIG_PATH = pluginDataConfigPath();
const PLUGIN_WORKSPACE_PATH = pluginWorkspacePath();
const HOME_CONFIG_PATH = homeConfigPath();
let ALLOWED_DIRECTORY_CONFIG_PATH = PLUGIN_DATA_CONFIG_PATH;

function buildAllowedDirectories() {
  const pluginConfigPath = PLUGIN_DATA_CONFIG_PATH;
  const userHomeConfigPath = HOME_CONFIG_PATH;
  const argumentDirectories = parseAllowedDirectoryArgs(process.argv.slice(2));
  const environmentDirectories = parsePathListValue(process.env.ALLOWED_DIRECTORIES);

  let configuredDirectories;
  let boundaryConfigPath = pluginConfigPath;
  if (argumentDirectories?.length) {
    configuredDirectories = argumentDirectories;
    ALLOWED_DIRECTORY_SOURCE = "argument";
  } else if (environmentDirectories?.length) {
    configuredDirectories = environmentDirectories;
    ALLOWED_DIRECTORY_SOURCE = "environment";
  } else {
    const fromPluginConfig = readAllowedDirectoriesConfig(pluginConfigPath);
    if (fromPluginConfig.status === "malformed" || fromPluginConfig.directories.length > 0) {
      configuredDirectories = fromPluginConfig.directories;
      boundaryConfigPath = pluginConfigPath;
      ALLOWED_DIRECTORY_CONFIG_PATH = pluginConfigPath;
      ALLOWED_DIRECTORY_SOURCE = fromPluginConfig.directories.length ? "config_file" : "none";
    } else {
      const fromHomeConfig = readAllowedDirectoriesConfig(userHomeConfigPath);
      boundaryConfigPath = userHomeConfigPath;
      ALLOWED_DIRECTORY_CONFIG_PATH = userHomeConfigPath;
      if (fromHomeConfig.status !== "absent") {
        configuredDirectories = fromHomeConfig.directories;
        ALLOWED_DIRECTORY_SOURCE = fromHomeConfig.directories.length ? "home_config_file" : "none";
      } else if (PLUGIN_WORKSPACE_PATH) {
        ensurePluginDataConfigTemplate(pluginConfigPath);
        const workspace = ensurePluginWorkspace(PLUGIN_WORKSPACE_PATH);
        configuredDirectories = workspace ? [workspace.display] : [];
        boundaryConfigPath = pluginConfigPath;
        ALLOWED_DIRECTORY_CONFIG_PATH = pluginConfigPath;
        ALLOWED_DIRECTORY_SOURCE = workspace ? "plugin_workspace" : "none";
      } else {
        configuredDirectories = [];
        ALLOWED_DIRECTORY_SOURCE = "none";
        ensureHomeConfigTemplate(userHomeConfigPath);
      }
    }
  }

  const seen = new Set();
  const resolved = configuredDirectories
    .map((directory) => normalizeUserPath(directory))
    .map((directory) => ({
      display: directory,
      canonical: canonicalizePathForPolicy(directory),
    }))
    .filter((directory) => {
      const key = directory.canonical;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });

  if (grantsAccessToOwnConfig(resolved, boundaryConfigPath)) {
    console.error(
      `[pdf-tools] The allowed directories reach ${boundaryConfigPath}, which would let this `
      + "server rewrite its own boundary. No directories are allowed until that entry is removed.",
    );
    ALLOWED_DIRECTORY_SOURCE = "refused_self_granting";
    return [];
  }
  return resolved;
}

const ALLOWED_DIRECTORIES = buildAllowedDirectories();

function configuredLuminClientId() {
  const environmentValue = process.env.LUMIN_OAUTH_CLIENT_ID;
  if (environmentValue && !environmentValue.includes("${")) return environmentValue.trim();
  for (const configPath of [PLUGIN_DATA_CONFIG_PATH, HOME_CONFIG_PATH]) {
    if (!configPath || !existsSync(configPath)) continue;
    try {
      const value = JSON.parse(readFileSync(configPath, "utf8")).luminOAuthClientId;
      if (typeof value === "string" && value === value.trim() && value.length > 0) return value;
    } catch {}
  }
  return null;
}

const LUMIN_OAUTH_CLIENT_ID = configuredLuminClientId();
const LUMIN_OPERATION_STATE_ROOT = canonicalizePathForPolicy(path.join(
  process.env.PLUGIN_DATA && !process.env.PLUGIN_DATA.includes("${")
    ? path.resolve(process.env.PLUGIN_DATA)
    : PROFILES_DIR,
  "lumin-signing-state",
));

// Where a tool browses when the caller names no directory. An explicitly
// configured value always wins. Otherwise prefer the first allowed directory
// over a home folder, which is no longer granted by default: falling back to an
// ungranted path would refuse a request the caller never actually made.
function defaultDirectoryWithin(configuredValue, envName) {
  const explicit = process.env[envName];
  if (explicit && !explicit.includes("${")) return configuredValue;
  return ALLOWED_DIRECTORIES[0]?.display ?? configuredValue;
}
const DEFAULT_PDF_DIRECTORY = defaultDirectoryWithin(DEFAULT_PDF_DIR, "DEFAULT_PDF_DIR");
const DEFAULT_DOWNLOAD_DIRECTORY = defaultDirectoryWithin(DEFAULT_DOWNLOAD_DIR, "DEFAULT_DOWNLOAD_DIR");

const PDFJS_TOOL_NAMES = new Set([
  "convert_pdf_to_markdown",
  "verify_table_proposal",
  "compare_pdfs",
  "detect_signature_zones",
  "get_page_analysis",
  "get_pdf_info",
  "read_pdf_content",
  "read_pdf_layout",
  "read_pdf_pages",
  "render_pdf_page",
  "render_pdf_region",
  "search_pdf_text",
  "create_extraction_workspace",
  "read_extraction_chunk",
  "verify_extraction_proposal",
]);

async function bindPdfjsSubprocessSource(resolvedPath) {
  const source = await hashBoundedPdfFileSafely(
    resolvedPath,
    PDF_MUTATION_MAX_FILE_BYTES,
    {
      assertPathAllowed,
      createSizeLimitError: pdfMutationFileLimitError,
      requirePdfHeader: false,
    },
  );
  return {
    canonical_path: source.canonicalPath,
    file_identity: source.fileIdentity,
    sha256: source.sha256,
    size_bytes: source.sizeBytes,
  };
}

async function bindPdfLibInspectionSource(resolvedPath) {
  return bindPdfjsSubprocessSource(resolvedPath);
}

async function runPdfjsOperation(resolvedPath, {
  operation,
  options,
  password = null,
  timeoutMs = 30_000,
}) {
  const source = await bindPdfjsSubprocessSource(resolvedPath);
  const result = await runPdfjsSubprocess(createPdfjsSubprocessRequest({
    operation,
    source,
    options,
    password,
    allowedDirectories: ALLOWED_DIRECTORIES.map(directory => directory.canonical),
  }), { timeoutMs });
  return { result, source };
}

async function extractCompleteVerifiedExtractionLayouts({
  resolvedPath,
  password,
  sourceBytes,
  maxPages,
}) {
  if (!Number.isInteger(maxPages) || maxPages < 1 || maxPages > 200) {
    throw new Error("max_pages must be an integer from 1 to 200.");
  }
  const layouts = [];
  let totalPages = null;
  for (let page = 1; totalPages === null || page <= totalPages; page += 1) {
    const { result } = await runPdfjsOperation(resolvedPath, {
      operation: "extract_layout",
      password,
      options: {
        source_path: resolvedPath,
        source_file_name: path.basename(resolvedPath),
        start_page: page,
        end_page: page,
        max_items: 5000,
        max_characters: 100000,
        max_output_characters: 200000,
      },
    });
    const layout = validatePdfLayoutSemantics(result.layout, { sourceBytes });
    if (totalPages === null) {
      totalPages = layout.page_range.total_pages;
      if (totalPages > maxPages) {
        throw new Error(
          `The PDF has ${totalPages} pages; this workspace is limited to ${maxPages}. `
          + "Raise max_pages up to 200 or use a smaller PDF.",
        );
      }
    } else if (layout.page_range.total_pages !== totalPages) {
      throw new Error("The PDF page count changed while the workspace was being created.");
    }
    layouts.push(layout);
  }
  return layouts;
}

const handleVerifiedExtractionTool = createVerifiedExtractionToolHandler({
  workspaceRoot: VERIFIED_EXTRACTION_WORKSPACES_DIR,
  resolvePdfPath: resolvePath,
  readPdfBytes: readCurrentPdfMutationBytes,
  extractLayouts: extractCompleteVerifiedExtractionLayouts,
});
const VERIFIED_EXTRACTION_TOOL_NAMES = new Set(
  VERIFIED_EXTRACTION_TOOL_DEFINITIONS.map(tool => tool.name),
);

const handleLuminSigningTool = createLuminSigningToolHandler({
  clientId: LUMIN_OAUTH_CLIENT_ID,
  stateRoot: LUMIN_OPERATION_STATE_ROOT,
  readPreparedPdf: async inputPath => {
    const canonicalPath = resolveCanonicalPath(inputPath);
    return {
      canonicalPath,
      bytes: await readCurrentPdfMutationBytes(canonicalPath),
    };
  },
  resolveOutputPath: inputPath => resolvePath(inputPath),
  downloadSignedPdf: async ({ signedUrl, outputPath }) => {
    let result;
    try {
      result = await downloadPdfFromUrl(signedUrl, {
        filename: path.basename(outputPath),
        destinationDir: path.dirname(outputPath),
        overwrite: false,
        maxSizeMb: 200,
        allowPrivateHosts: false,
        maxRedirects: 0,
        assertPathAllowed,
      });
      const identity = await hashBoundedPdfFileSafely(
        result.path,
        PDF_MUTATION_MAX_FILE_BYTES,
        {
          assertPathAllowed,
          createSizeLimitError: pdfMutationFileLimitError,
          requirePdfHeader: true,
        },
      );
      noteDocumentOpened(identity.canonicalPath);
      return {
        canonicalPath: identity.canonicalPath,
        bytes: identity.sizeBytes,
        sha256: identity.sha256,
      };
    } catch {
      throw new Error("The Lumin artifact could not be downloaded safely.");
    } finally {
      result = null;
    }
  },
});
const LUMIN_SIGNING_TOOL_NAME_SET = new Set(LUMIN_SIGNING_TOOL_NAMES);

function comparisonSourceChangedError() {
  const error = new Error("A comparison source changed while it was being inspected.");
  error.code = "COMPARISON_SOURCE_CHANGED";
  return error;
}

/**
 * Whether an encrypted document is what stopped this comparison step.
 *
 * Three shapes mean the same thing here, and all three used to surface as
 * something else. PDF.js reports a missing or rejected password, which is true
 * but useless advice on this tool — no password makes an encrypted comparison
 * run. pdf-lib's geometry step reports the honest "no decryption support"
 * limit, which is the family message but does not say which input it was. And
 * with `include_visual: false` neither fired at all: the comparison completed,
 * carried `RAW_PAGE_GEOMETRY_UNAVAILABLE` into its structure channel, and was
 * rejected by its own semantics validator as an internal fault.
 */
function comparisonEncryptionFailure(error, side) {
  // `isPdfComparisonEncryptedFailure` covers the typed code and both message
  // signatures, including one that has crossed a boundary which dropped its
  // `code`. Matching on the message rather than on identity matters here: the
  // pdf-lib limit is raised inside the PDF.js subprocess and travels back as
  // text.
  const encrypted = error?.code === "PASSWORD_REQUIRED"
    || error?.code === "PASSWORD_INCORRECT"
    || comparisonSawPdfLibEncryptionLimit(error)
    || isPdfComparisonEncryptedFailure(error);
  return encrypted ? pdfComparisonEncryptedError([side]) : null;
}

/**
 * The shared pdf-lib "no decryption support" limit, matched wherever it came
 * from.
 *
 * `includes` rather than `===`: the page renderer raises this inside the PDF.js
 * subprocess, so it reaches the server as text that a boundary may have
 * prefixed or annotated. An equality check that stops matching does not fail
 * loudly — it silently reclassifies a true statement about encryption as
 * `invalid_input`, "the arguments or PDF inputs are invalid", about a call
 * whose arguments were fine.
 */
function comparisonSawPdfLibEncryptionLimit(error) {
  return typeof error?.message === "string"
    && error.message.includes(PDF_LIB_ENCRYPTED_MESSAGE);
}

/**
 * Whether the document PDF.js just observed carries an `/Encrypt` dictionary.
 *
 * PDF.js reports the security handler's filter name for a protected document
 * and `null` for an unprotected one, and the observation this comparison had to
 * make anyway already carries it — so this costs nothing, needs no second
 * parse, and does not depend on pdf-lib having been able to read the document.
 * It is the case a password error never reaches: the caller supplied the right
 * password, PDF.js opened the file, and the comparison would otherwise have run
 * on geometry pdf-lib could not supply.
 */
function comparisonInputIsEncrypted(observation) {
  const filterName = observation?.metadata?.info?.values?.EncryptFilterName;
  return typeof filterName === "string" && filterName.length > 0;
}

async function observeComparisonDocument(resolvedPath, { side, password, maxPages }) {
  let observed;
  try {
    observed = await runPdfjsOperation(resolvedPath, {
      operation: "observe_document",
      password,
      options: { max_pages: maxPages, max_output_characters: 200_000 },
    });
  } catch (error) {
    throw comparisonEncryptionFailure(error, side) ?? error;
  }
  if (observed.result.pages.total_count > maxPages) {
    const error = new Error(`Comparison supports at most ${maxPages} pages per document.`);
    error.code = "COMPARISON_PAGE_LIMIT_EXCEEDED";
    throw error;
  }
  validatePdfObservationSemantics(observed.result);
  if (comparisonInputIsEncrypted(observed.result)) throw pdfComparisonEncryptedError([side]);
  return { side, observed };
}

/**
 * Observes both inputs before either is inspected further.
 *
 * Encryption is the one failure worth collecting from both sides rather than
 * reporting from the first: a caller with two protected documents should be
 * told that once, not led through them one at a time. Every other failure still
 * stops at the first input that raised it.
 */
async function observeComparisonDocuments(requests) {
  const observations = [];
  const encryptedSides = [];
  for (const request of requests) {
    try {
      observations.push(await observeComparisonDocument(request.resolvedPath, request));
    } catch (error) {
      if (error?.code !== PDF_COMPARISON_ENCRYPTED_CODE) {
        // Whichever input failed first still decides the answer, exactly as it
        // did before: an encrypted `before` is reported even when `after` turns
        // out to be unreadable, and an unreadable `before` is reported without
        // `after` being consulted at all.
        if (encryptedSides.length > 0) throw pdfComparisonEncryptedError(encryptedSides);
        throw error;
      }
      encryptedSides.push(request.side);
    }
  }
  if (encryptedSides.length > 0) throw pdfComparisonEncryptedError(encryptedSides);
  return observations;
}

/**
 * Layout and visual evidence for one already-observed comparison input.
 *
 * `observeComparisonDocument` has already refused an encrypted document, so
 * nothing here should meet one — but the pdf-lib geometry step inside the page
 * renderer can still raise the family's encryption message for a document whose
 * `/Encrypt` dictionary the observation could not report (bounded metadata can
 * omit a key). The wrapper below turns that into the same typed refusal rather
 * than letting it fall through to "the arguments or PDF inputs are invalid".
 */
async function inspectComparisonDocument(resolvedPath, options) {
  try {
    return await inspectComparisonDocumentChannels(resolvedPath, options);
  } catch (error) {
    throw comparisonEncryptionFailure(error, options.side) ?? error;
  }
}

async function inspectComparisonDocumentChannels(resolvedPath, {
  side,
  observed,
  password,
  includeVisual,
}) {
  const layoutChunks = [];
  for (let startPage = 1; startPage <= observed.result.pages.total_count; startPage += 10) {
    const layoutChunk = await runPdfjsOperation(resolvedPath, {
      operation: "extract_layout",
      password,
      options: {
        source_path: resolvedPath,
        source_file_name: path.basename(resolvedPath),
        start_page: startPage,
        end_page: Math.min(startPage + 9, observed.result.pages.total_count),
        max_items: 5000,
        max_characters: 100_000,
        max_output_characters: 200_000,
      },
    });
    if (
      observed.source.sha256 !== layoutChunk.source.sha256
      || observed.source.size_bytes !== layoutChunk.source.size_bytes
    ) throw comparisonSourceChangedError();
    validatePdfLayoutSemantics(layoutChunk.result.layout);
    layoutChunks.push(layoutChunk.result.layout);
  }
  const layout = {
    source: layoutChunks[0].source,
    pages: layoutChunks.flatMap(chunk => chunk.pages),
    truncation: {
      truncated: layoutChunks.some(chunk => chunk.truncation.truncated),
      reasons: [...new Set(layoutChunks.flatMap(chunk => chunk.truncation.reasons))].sort(),
    },
  };

  const renders = [];
  if (includeVisual) {
    for (let page = 1; page <= observed.result.pages.total_count; page += 1) {
      try {
        const rendered = await runPdfjsOperation(resolvedPath, {
          operation: "render_comparison_page",
          password,
          timeoutMs: 60_000,
          options: {
            page,
            renderer_policy: "native",
            max_dimension_px: null,
            scale_override: PDF_COMPARISON_RENDERER.scale,
          },
        });
        if (observed.source.sha256 !== rendered.source.sha256) {
          throw comparisonSourceChangedError();
        }
        renders.push(rendered.result);
      } catch (error) {
        if (error?.code !== "PDF_RENDERER_UNAVAILABLE") throw error;
        renders.push(null);
      }
    }
  }
  return {
    side,
    observation: observed.result,
    layout,
    renders,
    initial_source: observed.source,
  };
}

async function verifyComparisonSourceUnchanged(resolvedPath, initialSource) {
  const finalSource = await bindPdfjsSubprocessSource(resolvedPath);
  const unchanged = finalSource.sha256 === initialSource.sha256
    && finalSource.size_bytes === initialSource.size_bytes
    && finalSource.file_identity.device === initialSource.file_identity.device
    && finalSource.file_identity.inode === initialSource.file_identity.inode;
  if (!unchanged) throw comparisonSourceChangedError();
  return {
    initial_sha256: initialSource.sha256,
    final_sha256: finalSource.sha256,
    initial_size_bytes: initialSource.size_bytes,
    final_size_bytes: finalSource.size_bytes,
    unchanged: true,
  };
}

function pdfjsRendererPolicy() {
  const forced = process.env.PDF_TOOLS_FORCE_SYSTEM_RENDERER === "1";
  const disabled = process.env.PDF_TOOLS_DISABLE_SYSTEM_RENDERER === "1";
  if (forced && (disabled || process.platform !== "darwin")) return "forced_unavailable";
  if (forced) return "system";
  if (disabled || process.platform !== "darwin") return "native";
  return "native_with_system_fallback";
}

let workerShutdown = null;
for (const [signal, exitCode] of new Map([
  ["SIGHUP", 129],
  ["SIGINT", 130],
  ["SIGTERM", 143],
])) {
  process.once(signal, () => {
    if (workerShutdown !== null) return;
    workerShutdown = settleAllShutdownOperations([
      terminateAllPdfjsSubprocesses(),
      terminateAllPdfLibMutations(),
      // A decryption worker is a live thread and keeps the process alive. It
      // has its own 30-second deadline, which is the wrong amount of time for a
      // shutdown to wait on.
      terminateAllDecryptionWorkers(),
    ]);
    void workerShutdown.finally(() => process.exit(exitCode));
  });
}
process.once("exit", () => {
  forceTerminateAllPdfjsSubprocesses();
  forceTerminateAllPdfLibMutations();
  forceTerminateAllDecryptionWorkers();
});

const backupPathByCanonical = new Map();
const backupOperationByCanonical = new Map();
const activeDocumentState = {
  activePath: null,
  backupPath: null,
  lastOpenedAt: null,
  lastMutationTool: null,
  lastMutationAt: null,
};

function backupIdentityId(pdfPath) {
  return sha256Bytes(Buffer.from(pdfPath));
}

function backupFileNameFor(pdfPath) {
  const ext = path.extname(pdfPath) || ".pdf";
  const base = backupBaseNameFor(pdfPath);
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  return `${base}__${backupIdentityId(pdfPath).slice(0, 16)}-${stamp}-${process.pid}-${Math.random().toString(36).slice(2, 8)}${ext}`;
}

function backupBaseNameFor(pdfPath) {
  const ext = path.extname(pdfPath) || ".pdf";
  return path.basename(pdfPath, ext).replace(/[^\w.-]+/g, "_");
}

function sha256Bytes(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

function canonicalJson(value) {
  if (value === null || typeof value === "boolean" || typeof value === "string") {
    return JSON.stringify(value);
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new TypeError("Canonical JSON cannot encode a non-finite number.");
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value).sort().map(key => {
      if (value[key] === undefined) throw new TypeError("Canonical JSON cannot encode undefined.");
      return `${JSON.stringify(key)}:${canonicalJson(value[key])}`;
    }).join(",")}}`;
  }
  throw new TypeError("Canonical JSON supports only JSON values.");
}

function signingDisplayRegion(nativeRegion, pageGeometry) {
  const { width, height } = nativeRegion;
  const x = pageGeometry.media_box.origin_x + nativeRegion.x - pageGeometry.crop_box.origin_x;
  const y = pageGeometry.crop_box.origin_y + pageGeometry.crop_box.height
    - (pageGeometry.media_box.origin_y + pageGeometry.media_box.height - nativeRegion.y);
  const pageWidth = pageGeometry.crop_box.width;
  const pageHeight = pageGeometry.crop_box.height;
  if (pageGeometry.rotation_degrees === 90) {
    return { x: pageHeight - y - height, y: x, width: height, height: width };
  }
  if (pageGeometry.rotation_degrees === 180) {
    return {
      x: pageWidth - x - width,
      y: pageHeight - y - height,
      width,
      height,
    };
  }
  if (pageGeometry.rotation_degrees === 270) {
    return { x: y, y: pageWidth - x - width, width: height, height: width };
  }
  return { x, y, width, height };
}

function signingZoneVisibility(nativeRegion, pageGeometry) {
  const cropRegion = {
    x: pageGeometry.media_box.origin_x + nativeRegion.x - pageGeometry.crop_box.origin_x,
    y: pageGeometry.crop_box.origin_y + pageGeometry.crop_box.height
      - (pageGeometry.media_box.origin_y + pageGeometry.media_box.height - nativeRegion.y),
    width: nativeRegion.width,
    height: nativeRegion.height,
  };
  const overlapWidth = Math.min(cropRegion.x + cropRegion.width, pageGeometry.crop_box.width)
    - Math.max(cropRegion.x, 0);
  const overlapHeight = Math.min(cropRegion.y + cropRegion.height, pageGeometry.crop_box.height)
    - Math.max(cropRegion.y, 0);
  if (overlapWidth <= 0 || overlapHeight <= 0) return "outside_crop_box";
  if (
    cropRegion.x < 0
    || cropRegion.y < 0
    || cropRegion.x + cropRegion.width > pageGeometry.crop_box.width
    || cropRegion.y + cropRegion.height > pageGeometry.crop_box.height
  ) return "partially_clipped";
  return "visible";
}

function signingParticipantBinding(zone) {
  const hasId = zone.participant_id !== null;
  const hasRole = zone.participant_role !== null;
  return {
    status: hasId && hasRole ? "bound" : hasId || hasRole ? "partial" : "unbound",
    participant_id: zone.participant_id,
    participant_role: zone.participant_role,
  };
}

function compareSigningText(left, right) {
  return left < right ? -1 : left > right ? 1 : 0;
}

function signingPreparationMissingInputs(zones, fieldOutcomes) {
  const missing = [];
  if (zones.length === 0) {
    missing.push({ code: "NO_SIGNATURE_ZONES", zone_id: null, field_name: null });
  }
  for (const zone of zones) {
    if (zone.field_type === "unspecified") {
      missing.push({ code: "ZONE_TYPE_UNSPECIFIED", zone_id: zone.zone_id, field_name: null });
    }
    const binding = zone.participant_binding ?? signingParticipantBinding(zone);
    if (binding.status === "unbound") {
      missing.push({ code: "ZONE_PARTICIPANT_BINDING_MISSING", zone_id: zone.zone_id, field_name: null });
    } else if (binding.status === "partial") {
      missing.push({ code: "ZONE_PARTICIPANT_BINDING_PARTIAL", zone_id: zone.zone_id, field_name: null });
    }
    if (zone.visibility_status === "outside_crop_box") {
      missing.push({ code: "ZONE_OUTSIDE_CROP_BOX", zone_id: zone.zone_id, field_name: null });
    } else if (zone.visibility_status === "partially_clipped") {
      missing.push({ code: "ZONE_PARTIALLY_CLIPPED", zone_id: zone.zone_id, field_name: null });
    }
  }
  for (const outcome of fieldOutcomes) {
    if (outcome.status === "failed") {
      missing.push({ code: "FIELD_WRITE_FAILED", zone_id: null, field_name: outcome.field_name });
    }
  }
  return missing.sort((left, right) => compareSigningText(
    `${left.code}\0${left.zone_id ?? ""}\0${left.field_name ?? ""}`,
    `${right.code}\0${right.zone_id ?? ""}\0${right.field_name ?? ""}`,
  ));
}

async function buildSigningPreparationReceipt({
  recoveredInput,
  resolvedOutput,
  backupPath,
  result,
  zones,
  allowResign,
  forceXfa,
  xfaPresent,
  expectedOutputIdentity,
}) {
  const preparedIdentity = await bindPdfjsSubprocessSource(resolvedOutput);
  const sameDocument = preparedIdentity.canonical_path === recoveredInput.canonicalPath;
  let sourcePreservation;
  if (sameDocument) {
    if (!backupPath) {
      throw new Error("Signing preparation replaced its source without recording the immutable original backup.");
    }
    const backupRecord = await readBackupRecord(recoveredInput.canonicalPath);
    if (
      !backupRecord
      || backupRecord.original_sha256 !== sha256Bytes(recoveredInput.pdfBytes)
    ) {
      throw new Error("The immutable-original backup record does not bind the signing-packet source identity.");
    }
    const validatedBackupPath = await validateBackupRecord(backupRecord);
    if (path.resolve(validatedBackupPath) !== path.resolve(backupPath)) {
      throw new Error("The immutable-original backup path changed after the prepared output committed.");
    }
    sourcePreservation = {
      mode: "same_document_immutable_original_backup",
      source_path_reverified_after_commit: false,
      backup_identity_verified_after_commit: true,
      backup_path: validatedBackupPath,
      backup_document: {
        canonical_path: validatedBackupPath,
        size_bytes: recoveredInput.sizeBytes,
        sha256: sha256Bytes(recoveredInput.pdfBytes),
        identity_method: "immutable_original_backup_record_sha256",
      },
    };
  } else {
    const sourceAfterCommit = await bindPdfjsSubprocessSource(recoveredInput.canonicalPath);
    if (
      sourceAfterCommit.sha256 !== sha256Bytes(recoveredInput.pdfBytes)
      || sourceAfterCommit.size_bytes !== recoveredInput.sizeBytes
      || sourceAfterCommit.file_identity.device !== recoveredInput.fileIdentity.device
      || sourceAfterCommit.file_identity.inode !== recoveredInput.fileIdentity.inode
    ) {
      throw new Error("The signing-packet source identity changed after the prepared output committed.");
    }
    sourcePreservation = {
      mode: "source_path_unchanged",
      source_path_reverified_after_commit: true,
      backup_identity_verified_after_commit: false,
      backup_path: null,
      backup_document: null,
    };
  }

  const pagesByNumber = new Map(result.page_geometry.map(page => [page.page, page]));
  const receiptZones = zones.map(zone => {
    const pageGeometry = pagesByNumber.get(zone.page);
    if (!pageGeometry) throw new Error(`Signing zone ${zone.zone_id} has no retained page geometry.`);
    const nativeRegion = {
      x: zone.x,
      y: zone.y,
      width: zone.width,
      height: zone.height,
    };
    return {
      zone_id: zone.zone_id,
      label: zone.label,
      field_type: zone.field_type,
      page: zone.page,
      native_region: nativeRegion,
      display_region: signingDisplayRegion(nativeRegion, pageGeometry),
      visibility_status: signingZoneVisibility(nativeRegion, pageGeometry),
      coordinate_space_version: "pdf-tools.media-box-top-left-points.v1",
      evidence_source: zone.evidence_source,
      evidence_binding_status: "caller_declared",
      participant_binding: signingParticipantBinding(zone),
    };
  });
  const fieldOutcomes = [...result.field_outcomes].sort((left, right) =>
    compareSigningText(left.field_name, right.field_name));
  const missingInputs = signingPreparationMissingInputs(receiptZones, fieldOutcomes);
  const receipt = {
    schema_version: "1.0",
    preparation_engine: "pdf-tools.prepare-signing-packet.v1",
    source_document: {
      canonical_path: recoveredInput.canonicalPath,
      size_bytes: recoveredInput.sizeBytes,
      sha256: sha256Bytes(recoveredInput.pdfBytes),
      identity_method: "race_aware_descriptor_sha256",
    },
    prepared_document: {
      canonical_path: preparedIdentity.canonical_path,
      size_bytes: preparedIdentity.size_bytes,
      sha256: preparedIdentity.sha256,
      identity_method: "race_aware_descriptor_sha256",
    },
    source_preservation: sourcePreservation,
    output_commit: {
      status: "committed",
      protocol: "pdf-tools.atomic-output-transaction.v1",
      target_mode: sameDocument ? "same_document" : "new_path",
      source_binding_verified_at_commit: true,
      prepared_identity_verified_after_commit: true,
      replacement_identity_supplied: expectedOutputIdentity !== null,
    },
    page_count: result.page_geometry.length,
    geometry_policy: {
      native_coordinate_space: "pdf-tools.media-box-top-left-points.v1",
      display_coordinate_space: "pdf-tools.crop-box-rotated-top-left-points.v1",
      page_box_basis: "MediaBox",
      crop_box_observed: true,
      rotation_policy: "clockwise_quarter_turns",
    },
    pages: result.page_geometry,
    field_outcomes: fieldOutcomes,
    zones: receiptZones,
    existing_signature_observation: {
      present: result.source_signatures.present,
      field_count: result.source_signatures.fieldNames.length,
      field_names: [...result.source_signatures.fieldNames].sort(compareSigningText),
      allow_resign: allowResign,
    },
    xfa_observation: {
      present: xfaPresent,
      force_xfa: forceXfa,
      stripping_authorized: xfaPresent && forceXfa,
    },
    handoff_status: missingInputs.length === 0 ? "ready_for_provider_mapping" : "incomplete",
    missing_inputs: missingInputs,
    limitations: [
      "This receipt proves local preparation identity and intent only; it does not prove signer identity, consent, delivery, completion, enforceability, or legal validity.",
      "No provider request, signing agreement, signing link, callback, or completed signed artifact was requested or observed.",
      "Provider-specific coordinate, participant, authentication, retention, and custody rules remain outside this receipt.",
      "Zone evidence_source values are caller-declared labels, not independently replayed detection or AcroForm evidence.",
    ],
    provider_execution_status: "not_requested",
  };
  return {
    ...receipt,
    receipt_sha256: sha256Bytes(Buffer.from(
      `pdf-tools.signing-preparation-receipt.v1\0${canonicalJson(receipt)}`,
      "utf8",
    )),
  };
}

// The errno shapes a path can take while another writer replaces the file
// under it. Mirrors PATH_RACE_ERROR_CODES in bounded-pdf-file.js, which maps
// the same set to PDF_CHANGED_DURING_READ on the read side.
const PDF_INPUT_PATH_RACE_CODES = new Set(["ELOOP", "ENOENT", "ENOTDIR", "ESTALE"]);

function backupIdentityError(code, message, cause) {
  const error = new Error(`${code}: ${message}`);
  error.code = code;
  if (cause) error.cause = cause;
  return error;
}

function backupRecordPath(canonicalPath) {
  return path.join(BACKUPS_DIR, `.original-${backupIdentityId(canonicalPath)}.v1.json`);
}

async function ensureManagedBackupDirectory() {
  await fs.mkdir(BACKUPS_DIR, { recursive: true, mode: 0o700 });
  const [stat, real] = await Promise.all([fs.lstat(BACKUPS_DIR), fs.realpath(BACKUPS_DIR)]);
  if (!stat.isDirectory() || stat.isSymbolicLink() || real !== path.resolve(BACKUPS_DIR)) {
    throw backupIdentityError("BACKUP_DIRECTORY_INVALID", "The managed backup directory must be a real directory, not a symlink.");
  }
  if (typeof process.getuid === "function" && (stat.uid !== process.getuid() || (stat.mode & 0o022) !== 0)) {
    throw backupIdentityError("BACKUP_DIRECTORY_PERMISSIONS", "The managed backup directory has unsafe ownership or write permissions.");
  }
}

function mutationArtifactIdentity(stat) {
  if (!stat) return null;
  return [stat.dev, stat.ino, stat.mode, stat.size, stat.mtimeMs].join(":");
}

function mutationProcessAppearsAlive(pid) {
  if (!Number.isSafeInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error?.code !== "ESRCH";
  }
}

function assertPrivateMutationArtifact(artifactPath, stat) {
  if (!stat?.isFile() || stat.isSymbolicLink()) {
    throw backupIdentityError("MUTATION_LOCK_INVALID", `The document mutation artifact is not a regular file: ${artifactPath}`);
  }
  if (
    process.platform !== "win32" && typeof process.getuid === "function" &&
    (stat.uid !== process.getuid() || (stat.mode & 0o077) !== 0)
  ) {
    throw backupIdentityError("MUTATION_LOCK_INVALID", `The document mutation artifact is not private and owned: ${artifactPath}`);
  }
}

async function removeMutationArtifact(artifactPath, expectedIdentity = null) {
  let stat;
  try {
    stat = await fs.lstat(artifactPath);
  } catch (error) {
    if (error?.code === "ENOENT") return;
    throw error;
  }
  assertPrivateMutationArtifact(artifactPath, stat);
  if (expectedIdentity && mutationArtifactIdentity(stat) !== expectedIdentity) {
    throw backupIdentityError("MUTATION_LOCK_CHANGED", `The document mutation artifact changed unexpectedly: ${artifactPath}`);
  }
  await fs.unlink(artifactPath);
}

async function readMutationLock(lockPath, canonicalPath) {
  const stat = await fs.lstat(lockPath);
  assertPrivateMutationArtifact(lockPath, stat);
  const identity = mutationArtifactIdentity(stat);
  const lockHandle = await fs.open(lockPath, fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW ?? 0));
  let raw;
  try {
    const opened = await lockHandle.stat();
    if (!opened.isFile() || opened.size > 64 * 1024) throw new Error("invalid lock file");
    raw = await lockHandle.readFile("utf8");
  } finally {
    await lockHandle.close();
  }
  if (mutationArtifactIdentity(await fs.lstat(lockPath)) !== identity) {
    throw backupIdentityError("MUTATION_LOCK_CHANGED", "The document mutation lock changed while it was read.");
  }
  const lock = JSON.parse(raw);
  if (
    lock?.schema_version !== 1 || lock.canonical_path !== canonicalPath ||
    !Number.isSafeInteger(lock.pid) || lock.pid <= 0 ||
    typeof lock.token !== "string" || !lock.token ||
    typeof lock.created_at !== "string" ||
    Object.keys(lock).sort().join(",") !== "canonical_path,created_at,pid,schema_version,token"
  ) {
    throw new Error("invalid lock record");
  }
  return { lock, identity };
}

async function cleanupStaleMutationCandidates(canonicalPath) {
  const identityId = backupIdentityId(canonicalPath);
  const candidatePattern = new RegExp(`^\\.mutation-${identityId}\\.candidate-(\\d+)-[0-9a-f-]{36}$`);
  for (const name of await fs.readdir(BACKUPS_DIR)) {
    const match = candidatePattern.exec(name);
    if (!match || mutationProcessAppearsAlive(Number(match[1]))) continue;
    const candidatePath = path.join(BACKUPS_DIR, name);
    const stat = await fs.lstat(candidatePath).catch(error => {
      if (error?.code === "ENOENT") return null;
      throw error;
    });
    if (!stat) continue;
    assertPrivateMutationArtifact(candidatePath, stat);
    await removeMutationArtifact(candidatePath, mutationArtifactIdentity(stat));
  }
}

async function acquireMutationLock(canonicalPath) {
  await ensureManagedBackupDirectory();
  await cleanupStaleMutationCandidates(canonicalPath);
  const identityId = backupIdentityId(canonicalPath);
  const lockPath = path.join(BACKUPS_DIR, `.mutation-${identityId}.lock`);
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const token = randomUUID();
    const candidatePath = path.join(BACKUPS_DIR, `.mutation-${identityId}.candidate-${process.pid}-${token}`);
    let handle;
    let candidateIdentity = null;
    let published = false;
    try {
      handle = await fs.open(candidatePath, "wx", 0o600);
      await handle.writeFile(`${JSON.stringify({
        schema_version: 1,
        canonical_path: canonicalPath,
        pid: process.pid,
        token,
        created_at: new Date().toISOString(),
      })}\n`);
      await handle.sync();
      await handle.close();
      handle = null;
      const candidateStat = await fs.lstat(candidatePath);
      assertPrivateMutationArtifact(candidatePath, candidateStat);
      candidateIdentity = mutationArtifactIdentity(candidateStat);
      await fs.link(candidatePath, lockPath);
      published = true;
      if (mutationArtifactIdentity(await fs.lstat(lockPath)) !== candidateIdentity) {
        throw backupIdentityError("MUTATION_LOCK_CHANGED", "The published document mutation lock has the wrong identity.");
      }
      await removeMutationArtifact(candidatePath, candidateIdentity);
      return async () => {
        const current = await fs.lstat(lockPath).catch(error => {
          if (error?.code === "ENOENT") return null;
          throw error;
        });
        if (mutationArtifactIdentity(current) !== candidateIdentity) {
          throw backupIdentityError("MUTATION_LOCK_CHANGED", "The document mutation lock changed unexpectedly.");
        }
        await removeMutationArtifact(lockPath, candidateIdentity);
      };
    } catch (error) {
      try { await handle?.close(); } catch {}
      try { await removeMutationArtifact(candidatePath, candidateIdentity); } catch (cleanupError) {
        throw backupIdentityError("MUTATION_LOCK_FAILED", "The document mutation lock candidate could not be cleaned.", cleanupError);
      }
      if (published) {
        try { await removeMutationArtifact(lockPath, candidateIdentity); } catch (cleanupError) {
          throw backupIdentityError("MUTATION_LOCK_FAILED", "The incomplete document mutation lock could not be cleaned.", cleanupError);
        }
      }
      if (error.code !== "EEXIST") {
        throw backupIdentityError("MUTATION_LOCK_FAILED", "The document mutation lock could not be established.", error);
      }
      let existing;
      try {
        existing = await readMutationLock(lockPath, canonicalPath);
      } catch (readError) {
        if (readError?.code === "ENOENT") continue;
        if (readError?.code?.startsWith("MUTATION_LOCK_")) throw readError;
        throw backupIdentityError("MUTATION_LOCK_INVALID", "The document mutation lock record is invalid.", readError);
      }
      if (mutationProcessAppearsAlive(existing.lock.pid)) {
        throw backupIdentityError("CONCURRENT_MODIFICATION", "Another process is already committing a mutation for this document.");
      }
      const stalePath = `${lockPath}.stale-${randomUUID()}`;
      try {
        await fs.rename(lockPath, stalePath);
      } catch (renameError) {
        if (renameError?.code === "ENOENT") continue;
        throw backupIdentityError("MUTATION_LOCK_FAILED", "The stale document mutation lock could not be isolated.", renameError);
      }
      await removeMutationArtifact(stalePath, existing.identity);
    }
  }
  throw backupIdentityError("MUTATION_LOCK_FAILED", "The document mutation lock could not be established after stale-lock recovery.");
}

async function readBackupRecord(canonicalPath) {
  const recordPath = backupRecordPath(canonicalPath);
  let bytes;
  try {
    const stat = await fs.lstat(recordPath);
    if (!stat.isFile() || stat.isSymbolicLink()) {
      throw backupIdentityError("BACKUP_RECORD_INVALID", "The original-backup identity record is not a regular file.");
    }
    const handle = await fs.open(recordPath, fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW ?? 0));
    try {
      const opened = await handle.stat();
      if (!opened.isFile() || opened.size > 64 * 1024) throw new Error("invalid record file");
      bytes = await handle.readFile();
    } finally {
      await handle.close();
    }
  } catch (error) {
    if (error.code === "ENOENT") return null;
    if (error.code === "BACKUP_RECORD_INVALID") throw error;
    throw backupIdentityError("BACKUP_RECORD_UNAVAILABLE", "The original-backup identity record could not be read.", error);
  }
  try {
    const parsed = JSON.parse(bytes);
    if (parsed?.schema_version !== 1 || parsed.canonical_path !== canonicalPath
      || typeof parsed.backup_file !== "string" || path.basename(parsed.backup_file) !== parsed.backup_file
      || !/^[a-f0-9]{64}$/.test(parsed.original_sha256 ?? "")
      || !/^[a-f0-9]{64}$/.test(parsed.last_committed_sha256 ?? "")
      || !(parsed.pending_sha256 === null || /^[a-f0-9]{64}$/.test(parsed.pending_sha256 ?? ""))
      || Object.keys(parsed).sort().join(",") !== "backup_file,canonical_path,last_committed_sha256,original_sha256,pending_sha256,schema_version") throw new Error("invalid record");
    return parsed;
  } catch (error) {
    throw backupIdentityError("BACKUP_RECORD_INVALID", "The original-backup identity record is corrupt or has an unsupported format.", error);
  }
}

async function publishBackupRecord(record) {
  await ensureManagedBackupDirectory();
  const recordPath = backupRecordPath(record.canonical_path);
  const bytes = Buffer.from(`${JSON.stringify(record, null, 2)}\n`);
  const temporary = `${recordPath}.tmp-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  try {
    const handle = await fs.open(temporary, "wx", 0o600);
    try {
      await handle.writeFile(bytes);
      await handle.sync();
    } finally {
      await handle.close();
    }
    await fs.link(temporary, recordPath);
    try {
      const directory = await fs.open(BACKUPS_DIR, "r");
      try { await directory.sync(); } finally { await directory.close(); }
    } catch {}
    return true;
  } catch (error) {
    if (error.code === "EEXIST") return false;
    throw backupIdentityError("BACKUP_RECORD_WRITE_FAILED", "The original-backup identity record could not be published atomically.", error);
  } finally {
    try { await fs.unlink(temporary); } catch {}
  }
}

async function replaceBackupRecord(record) {
  const recordPath = backupRecordPath(record.canonical_path);
  const temporary = `${recordPath}.tmp-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  let handle;
  try {
    handle = await fs.open(temporary, "wx", 0o600);
    await handle.writeFile(`${JSON.stringify(record, null, 2)}\n`);
    await handle.sync();
    await handle.close();
    handle = null;
    await fs.rename(temporary, recordPath);
    try {
      const directory = await fs.open(BACKUPS_DIR, "r");
      try { await directory.sync(); } finally { await directory.close(); }
    } catch {}
  } catch (error) {
    try { await handle?.close(); } catch {}
    try { await fs.unlink(temporary); } catch {}
    throw backupIdentityError("BACKUP_RECORD_WRITE_FAILED", "The original-backup identity record could not be replaced atomically.", error);
  }
}

async function validateBackupRecord(record) {
  const resolvedBackup = path.resolve(BACKUPS_DIR, record.backup_file);
  const backupRoot = path.resolve(BACKUPS_DIR);
  if (!resolvedBackup.startsWith(`${backupRoot}${path.sep}`) || path.extname(resolvedBackup).toLowerCase() !== ".pdf") {
    throw backupIdentityError("BACKUP_IDENTITY_INVALID", "The recorded original backup path is outside the managed backup directory.");
  }
  let bytes;
  try {
    const stat = await fs.lstat(resolvedBackup);
    if (!stat.isFile() || stat.isSymbolicLink()) {
      throw backupIdentityError("BACKUP_IDENTITY_INVALID", "The recorded original backup is not a regular PDF file.");
    }
    const handle = await fs.open(resolvedBackup, fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW ?? 0));
    try {
      const opened = await handle.stat();
      if (!opened.isFile()) throw backupIdentityError("BACKUP_IDENTITY_INVALID", "The recorded original backup is not a regular PDF file.");
      bytes = await handle.readFile();
    } finally {
      await handle.close();
    }
  } catch (error) {
    if (error.code === "BACKUP_IDENTITY_INVALID") throw error;
    throw backupIdentityError(
      "ORIGINAL_BACKUP_MISSING",
      `Refusing to mutate ${path.basename(record.canonical_path)} because its recorded original backup is unavailable at ${resolvedBackup}. Restore that file before retrying.`,
      error,
    );
  }
  if (sha256Bytes(bytes) !== record.original_sha256) {
    throw backupIdentityError(
      "ORIGINAL_BACKUP_MISMATCH",
      `Refusing to mutate ${path.basename(record.canonical_path)} because its recorded original backup no longer matches the immutable original identity.`,
    );
  }
  return resolvedBackup;
}

async function serializeBackupOperation(canonicalPath, operation) {
  const prior = backupOperationByCanonical.get(canonicalPath) ?? Promise.resolve();
  const current = prior.then(operation, operation);
  const tail = current.catch(() => {});
  backupOperationByCanonical.set(canonicalPath, tail);
  try {
    return await current;
  } finally {
    if (backupOperationByCanonical.get(canonicalPath) === tail) backupOperationByCanonical.delete(canonicalPath);
  }
}

async function ensureBackupForCanonicalPath(pdfPath, expectedOriginalBytes, expectedOriginalSha256) {
  const resolvedPath = await fs.realpath(resolvePath(pdfPath));
  return serializeBackupOperation(resolvedPath, async () => {
    const record = await readBackupRecord(resolvedPath);
    const rememberedPath = backupPathByCanonical.get(resolvedPath);
    if (record) {
      if (rememberedPath && path.resolve(rememberedPath) !== path.resolve(BACKUPS_DIR, record.backup_file)) {
        throw backupIdentityError("BACKUP_IDENTITY_MISMATCH", "In-memory and persisted original-backup identities disagree.");
      }
      const validated = await validateBackupRecord(record);
      backupPathByCanonical.set(resolvedPath, validated);
      return validated;
    }
    if (rememberedPath) {
      throw backupIdentityError(
        "BACKUP_IDENTITY_UNVERIFIED",
        "A backup path was rehydrated without a persisted immutable-original identity. Refusing to manufacture or adopt an original backup from ambiguous state.",
      );
    }

    await ensureManagedBackupDirectory();
    if (!Buffer.isBuffer(expectedOriginalBytes) || sha256Bytes(expectedOriginalBytes) !== expectedOriginalSha256) {
      throw backupIdentityError(
        "BACKUP_INPUT_IDENTITY_INVALID",
        "The bytes supplied for first-backup publication do not match their captured SHA-256 identity.",
      );
    }
    const identityPrefix = `__${backupIdentityId(resolvedPath).slice(0, 16)}-`;
    const backupEntries = await fs.readdir(BACKUPS_DIR);
    const priorBackupEvidence = backupEntries.some(entry => entry.includes(identityPrefix) && entry.toLowerCase().endsWith(".pdf"));
    if (priorBackupEvidence) {
      throw backupIdentityError(
        "BACKUP_RECORD_MISSING",
        "A managed original backup exists without its immutable identity record. Refusing to create a replacement from ambiguous state.",
      );
    }
    const legacyPrefix = `${backupBaseNameFor(resolvedPath)}__`;
    const legacyBackupEvidence = backupEntries.some(entry => entry.startsWith(legacyPrefix) && entry.toLowerCase().endsWith(".pdf"));
    if (legacyBackupEvidence) {
      throw backupIdentityError(
        "BACKUP_MIGRATION_REQUIRED",
        "A legacy original backup exists without a durable identity record. Resolve that backup lineage before retrying this mutation.",
      );
    }

    const target = await findUniquePath(path.join(BACKUPS_DIR, backupFileNameFor(resolvedPath)));
    const temporary = `${target}.tmp-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    try {
      const handle = await fs.open(temporary, "wx", 0o600);
      try {
        await handle.writeFile(expectedOriginalBytes);
        await handle.sync();
      } finally {
        await handle.close();
      }
      await fs.rename(temporary, target);
      try {
        const directory = await fs.open(BACKUPS_DIR, "r");
        try { await directory.sync(); } finally { await directory.close(); }
      } catch {}
      const published = await publishBackupRecord({
        schema_version: 1,
        canonical_path: resolvedPath,
        backup_file: path.basename(target),
        original_sha256: expectedOriginalSha256,
        last_committed_sha256: expectedOriginalSha256,
        pending_sha256: null,
      });
      if (!published) {
        await fs.unlink(target);
        const winningRecord = await readBackupRecord(resolvedPath);
        if (!winningRecord) throw backupIdentityError("BACKUP_RECORD_RACE", "A competing backup identity publication disappeared.");
        const validated = await validateBackupRecord(winningRecord);
        backupPathByCanonical.set(resolvedPath, validated);
        return validated;
      }
    } catch (error) {
      try { await fs.unlink(temporary); } catch {}
      try { await fs.unlink(target); } catch {}
      throw error;
    }
    backupPathByCanonical.set(resolvedPath, target);
    return target;
  });
}

function noteDocumentOpened(pdfPath) {
  const resolvedPath = resolvePath(pdfPath);
  activeDocumentState.activePath = resolvedPath;
  activeDocumentState.backupPath = backupPathByCanonical.get(resolvedPath) || null;
  activeDocumentState.lastOpenedAt = new Date().toISOString();
}

function syncActiveDocumentState({ pdfPath, backupPath = null, lastMutationTool = null, lastMutationAt = null }) {
  const resolvedPath = resolvePath(pdfPath);
  const resolvedBackupPath = backupPath ? resolvePath(backupPath) : null;
  activeDocumentState.activePath = resolvedPath;
  activeDocumentState.backupPath = resolvedBackupPath;
  activeDocumentState.lastOpenedAt = new Date().toISOString();
  if (resolvedBackupPath) {
    backupPathByCanonical.set(resolvedPath, resolvedBackupPath);
  }
  activeDocumentState.lastMutationTool = lastMutationTool;
  activeDocumentState.lastMutationAt = lastMutationAt;
}

async function buildPdfLoadPayload(pdfPath, initialPage = 1, extra = {}) {
  const stats = await fs.stat(pdfPath);
  return {
    pdfPath,
    totalBytes: stats.size,
    initialPage,
    fields: [],
    fieldCount: 0,
    hasFormFields: false,
    ...extra,
  };
}

async function buildActiveDocumentPayload(pdfPath, initialPage = 1, extra = {}) {
  const resolvedPath = resolvePath(pdfPath);
  let canonicalPath = resolvedPath;
  try { canonicalPath = await fs.realpath(resolvedPath); } catch {}
  let defaultFormInfo = {};
  if (extra.fields === undefined && extra.fieldCount === undefined && extra.hasFormFields === undefined) {
    try {
      const { pdfDoc } = await loadPdf(resolvedPath);
      defaultFormInfo = getFormFieldInfo(pdfDoc);
    } catch {
      defaultFormInfo = { fields: [], fieldCount: 0, hasFormFields: false };
    }
  }
  const payload = await buildPdfLoadPayload(resolvedPath, initialPage, {
    ...defaultFormInfo,
    ...extra,
  });
  const backupPath = backupPathByCanonical.get(canonicalPath) || backupPathByCanonical.get(resolvedPath) || null;
  return {
    ...payload,
    active_path: resolvedPath,
    backup_path: backupPath,
    last_mutation_tool: activeDocumentState.activePath === resolvedPath ? activeDocumentState.lastMutationTool : null,
    last_mutation_at: activeDocumentState.activePath === resolvedPath ? activeDocumentState.lastMutationAt : null,
  };
}

async function buildNewOutputDocumentPayload(outputPath, toolName, initialPage = 1, extra = {}) {
  const mutationAt = new Date().toISOString();
  syncActiveDocumentState({
    pdfPath: outputPath,
    lastMutationTool: toolName,
    lastMutationAt: mutationAt,
  });
  return await buildActiveDocumentPayload(outputPath, initialPage, extra);
}

function rejectOutputAliasesToProtectedInputs(protectedIdentities) {
  const protectedKeys = new Set((protectedIdentities ?? [])
    .filter(identity =>
      identity
      && typeof identity.device === "string"
      && typeof identity.inode === "string")
    .map(identity => `${identity.device}\0${identity.inode}`));
  return async targets => {
    const outputKeys = new Set();
    for (const target of targets) {
      if (!target.exists || !target.fileIdentity) continue;
      const targetKey =
        `${target.fileIdentity.device}\0${target.fileIdentity.inode}`;
      if (protectedKeys.has(targetKey)) {
        const error = new Error(
          `OUTPUT_ALIASES_INPUT: Refusing to replace an output that is another name for a protected input: ${target.targetPath}`,
        );
        error.code = "OUTPUT_ALIASES_INPUT";
        throw error;
      }
      if (outputKeys.has(targetKey)) {
        const error = new Error(
          `OUTPUT_TARGETS_ALIAS: Refusing a batch whose existing destinations are names for the same file: ${target.targetPath}`,
        );
        error.code = "OUTPUT_TARGETS_ALIAS";
        throw error;
      }
      outputKeys.add(targetKey);
    }
  };
}

function bindExpectedOutputIdentityManifest(entries, expectedIdentities) {
  const outputPaths = new Set(entries.map(entry => path.resolve(entry.targetPath)));
  for (const expectedPath of expectedIdentities.keys()) {
    if (!outputPaths.has(expectedPath)) {
      throw new Error(
        `OUTPUT_BATCH_IDENTITY_MISMATCH: Identity supplied for an output this batch will not create: ${expectedPath}`,
      );
    }
  }
  for (const entry of entries) {
    const outputPath = path.resolve(entry.targetPath);
    const expected = expectedIdentities.get(outputPath) ?? null;
    entry.overwrite = expected !== null;
    entry.expectedExistingIdentity = expected;
  }
  return entries;
}

async function persistPdfMutation({
  mutationOutput,
  formInfo,
  inputPath,
  outputPath,
  toolName,
  expectedInputSha256,
  expectedOutputIdentity = null,
  legacyOverwrite = false,
  inputRecoveryBinding,
  initialPage = 1,
  extraPayload = {},
}) {
  // The input was read, bound and revalidated before this function is
  // reached, so a path that no longer resolves here is a document that changed
  // under this mutation, not a missing file. The ordering that produces it is
  // a second writer between the two steps of its activation: writePdfOutputAtomic
  // moves the existing output to its rollback name and then links the staged
  // bytes in under a no-clobber link, and the document path does not exist in
  // between. A loser whose commit begins inside that window used to surface the
  // raw ENOENT from realpath, which is a third answer to the race the
  // revalidateSources and commit-time identity detectors already report as
  // CONCURRENT_MODIFICATION. Report it in the same shape, and keep the errno
  // as the cause so the boundary suites can still say which check fired.
  let resolvedInputPath;
  let inputCanonical;
  try {
    resolvedInputPath = resolvePath(inputPath);
    inputCanonical = await fs.realpath(resolvedInputPath);
  } catch (error) {
    if (PDF_INPUT_PATH_RACE_CODES.has(error?.code)) {
      throw backupIdentityError(
        "CONCURRENT_MODIFICATION",
        "The PDF changed after this mutation loaded its input. Reload the current document and retry.",
        error,
      );
    }
    throw error;
  }
  const resolvedOutputPath = resolvePath(outputPath);
  let outputCanonical = null;
  try { outputCanonical = await fs.realpath(resolvedOutputPath); } catch {}
  const sameDocument = inputCanonical === outputCanonical;
  if (
    legacyOverwrite
    && outputCanonical !== null
    && !sameDocument
    && expectedOutputIdentity === null
  ) {
    throw backupIdentityError(
      "OUTPUT_IDENTITY_REQUIRED",
      "overwrite=true cannot authorize replacement of a distinct existing output. Supply its exact current expected_output_identity.",
    );
  }
  const committedTargetIdentity = sameDocument
    ? expectedOutputIdentity ?? {
        canonicalPath: inputCanonical,
        sizeBytes: inputRecoveryBinding.inputSizeBytes,
        sha256: expectedInputSha256,
      }
    : expectedOutputIdentity;
  if (
    !inputRecoveryBinding?.recoveryDirectory
    || inputRecoveryBinding.recoveryDirectory.canonicalPath !== path.dirname(inputCanonical)
    || (
      inputRecoveryBinding.aliasBinding
      && inputRecoveryBinding.aliasBinding.expectedCanonicalPath !== inputCanonical
    )
  ) {
    throw backupIdentityError(
      "PDF_RECOVERY_INPUT_CHANGED",
      "PDF input recovery binding no longer identifies the parsed canonical input.",
    );
  }

  const commit = async () => {
    await assertPdfInputRecoveryBinding(inputRecoveryBinding);
    await recoverPdfOutputTransactions(path.dirname(inputCanonical), {
      recoveryDirectoryBinding: inputRecoveryBinding.recoveryDirectory,
      assertRecoveryDirectoryBinding: async () => {
        await assertPdfInputRecoveryBinding(inputRecoveryBinding);
      },
    });
    await assertPdfInputRecoveryBinding(inputRecoveryBinding);
    const recoveredInputSha256 = sha256Bytes(await readCurrentPdfMutationBytes(inputCanonical));
    if (
      /^[a-f0-9]{64}$/.test(expectedInputSha256 ?? "") &&
      recoveredInputSha256 !== expectedInputSha256
    ) {
      throw backupIdentityError("CONCURRENT_MODIFICATION", "The PDF changed while an interrupted output transaction was recovered. Reload the current document and retry.");
    }
    let backupPath = backupPathByCanonical.get(inputCanonical) || null;
    let record = null;
    let commitInputSha256 = null;
    if (
      !mutationOutput
      || typeof mutationOutput.readBytes !== "function"
      || !/^[a-f0-9]{64}$/.test(mutationOutput.sha256 ?? "")
    ) {
      throw new TypeError("A validated staged mutation output is required.");
    }
    const pendingSha256 = mutationOutput.sha256;
    if (sameDocument) {
      if (!/^[a-f0-9]{64}$/.test(expectedInputSha256 ?? "")) {
        throw backupIdentityError("MUTATION_INPUT_IDENTITY_REQUIRED", "Same-document mutations require the SHA-256 captured when the input was loaded.");
      }
      const currentBytes = await readCurrentPdfMutationBytes(inputCanonical);
      const currentSha256 = sha256Bytes(currentBytes);
      commitInputSha256 = currentSha256;
      if (currentSha256 !== expectedInputSha256) {
        throw backupIdentityError("CONCURRENT_MODIFICATION", "The PDF changed after this mutation loaded its input. Reload the current document and retry.");
      }
      if (
        expectedOutputIdentity !== null
        && (
          expectedOutputIdentity.canonicalPath !== inputCanonical
          || expectedOutputIdentity.sizeBytes !== currentBytes.length
          || expectedOutputIdentity.sha256 !== currentSha256
        )
      ) {
        throw backupIdentityError(
          "ATOMIC_OUTPUT_EXPECTED_IDENTITY_CHANGED",
          "The same-document output no longer matches the approved identity. Capture its current identity and obtain fresh approval before retrying.",
        );
      }
      backupPath = await ensureBackupForCanonicalPath(inputCanonical, currentBytes, currentSha256);
      record = await readBackupRecord(inputCanonical);
      if (!record) throw backupIdentityError("BACKUP_RECORD_MISSING", "The immutable original identity record disappeared before commit.");
      await validateBackupRecord(record);
      if (record.pending_sha256) {
        if (currentSha256 === record.pending_sha256) {
          record.last_committed_sha256 = record.pending_sha256;
          record.pending_sha256 = null;
          await replaceBackupRecord(record);
        } else if (currentSha256 === record.last_committed_sha256) {
          record.pending_sha256 = null;
          await replaceBackupRecord(record);
        } else {
          throw backupIdentityError("BACKUP_JOURNAL_CONFLICT", "The working PDF matches neither the committed nor pending mutation identity.");
        }
      }
      if (currentSha256 !== record.last_committed_sha256 || currentSha256 !== expectedInputSha256) {
        throw backupIdentityError("CONCURRENT_MODIFICATION", "The PDF changed after this mutation loaded its input. Reload the current document and retry.");
      }
      record.pending_sha256 = pendingSha256;
      await replaceBackupRecord(record);
      if (sha256Bytes(await readCurrentPdfMutationBytes(inputCanonical)) !== currentSha256) {
        record.pending_sha256 = null;
        await replaceBackupRecord(record);
        throw backupIdentityError("CONCURRENT_MODIFICATION", "The PDF changed while this mutation was preparing to commit. Reload the current document and retry.");
      }
    }

    const committedOutput = await writePdfOutputAtomic(
      sameDocument ? inputCanonical : resolvedOutputPath,
      null,
      {
        produceBytes: mutationOutput.readBytes,
        onTransition: mutationOutput.atomicTransition,
        assertPathAllowed,
        overwrite: committedTargetIdentity !== null,
        expectedExistingIdentity: committedTargetIdentity,
        validateInitialTargets: sameDocument
          ? undefined
          : rejectOutputAliasesToProtectedInputs([
              inputRecoveryBinding.inputFileIdentity,
            ]),
        beforeTransaction: sameDocument
          ? async () => {
              if (sha256Bytes(await readCurrentPdfMutationBytes(inputCanonical)) !== commitInputSha256) {
                throw backupIdentityError("CONCURRENT_MODIFICATION", "The PDF changed while this mutation was preparing to activate. Reload the current document and retry.");
              }
            }
          : undefined,
      },
    );
    const committedOutputPath = committedOutput.targetPath;
    if (record) {
      record.last_committed_sha256 = pendingSha256;
      record.pending_sha256 = null;
      await replaceBackupRecord(record);
    }

    activeDocumentState.activePath = committedOutputPath;
    activeDocumentState.backupPath = backupPath;
    activeDocumentState.lastMutationTool = toolName;
    activeDocumentState.lastMutationAt = new Date().toISOString();

    const payload = await buildActiveDocumentPayload(committedOutputPath, initialPage, {
      ...formInfo,
      ...extraPayload,
    });
    return { payload, backupPath };
  };

  if (!sameDocument) return commit();
  const release = await acquireMutationLock(inputCanonical);
  try { return await commit(); } finally { await release(); }
}

function getFormFieldInfo(pdfDoc) {
  try {
    const form = pdfDoc.getForm();
    const fields = form.getFields();
    const fieldInfo = fields.map(field => {
      const name = field.getName();
      let type = "unknown";
      let options = [];
      let currentValue = "";
      try {
        if (field.constructor.name.includes("TextField")) {
          type = "text";
          currentValue = field.getText() || "";
        } else if (field.constructor.name.includes("CheckBox")) {
          type = "checkbox";
          currentValue = field.isChecked();
        } else if (field.constructor.name.includes("RadioGroup")) {
          type = "radio";
          currentValue = field.getSelected() || "";
        } else if (field.constructor.name.includes("Dropdown")) {
          type = "dropdown";
          options = field.getOptions();
          currentValue = field.getSelected() || "";
        }
      } catch {}
      return { name, type, options, currentValue };
    });
    return {
      fields: fieldInfo,
      fieldCount: fieldInfo.length,
      hasFormFields: fieldInfo.length > 0,
    };
  } catch {
    return {
      fields: [],
      fieldCount: 0,
      hasFormFields: false,
    };
  }
}

// Helper function to parse CSV
function parseCSV(content) {
  const rows = [];
  let row = [];
  let value = "";
  let inQuotes = false;
  let wasQuoted = false;

  const pushValue = () => {
    row.push(wasQuoted ? value : value.trim());
    value = "";
    wasQuoted = false;
  };

  const pushRow = () => {
    pushValue();
    if (row.some(cell => cell !== "")) {
      rows.push(row);
    }
    row = [];
  };

  for (let i = 0; i < content.length; i++) {
    const char = content[i];

    if (inQuotes) {
      if (char === '"') {
        if (content[i + 1] === '"') {
          value += '"';
          i++;
        } else {
          inQuotes = false;
        }
      } else {
        value += char;
      }
      continue;
    }

    if (char === '"' && value.trim() === "") {
      inQuotes = true;
      wasQuoted = true;
      value = "";
    } else if (char === ",") {
      pushValue();
    } else if (char === "\n") {
      pushRow();
    } else if (char === "\r") {
      if (content[i + 1] === "\n") i++;
      pushRow();
    } else {
      value += char;
    }
  }

  if (inQuotes) {
    throw new Error("Malformed CSV: unterminated quoted field");
  }

  if (value !== "" || row.length > 0) {
    pushRow();
  }

  if (rows.length === 0) return [];

  const headers = rows[0].map((header, index) => {
    const normalized = index === 0 ? header.replace(/^\uFEFF/, "").trim() : header.trim();
    if (!normalized) {
      throw new Error(`Malformed CSV: blank header at column ${index + 1}`);
    }
    return normalized;
  });
  const duplicateHeader = headers.find((header, index) => headers.indexOf(header) !== index);
  if (duplicateHeader) {
    throw new Error(`Malformed CSV: duplicate header "${duplicateHeader}"`);
  }

  return rows.slice(1).map((values, rowIndex) => {
    if (values.length !== headers.length) {
      throw new Error(
        `Malformed CSV: row ${rowIndex + 2} has ${values.length} values, expected ${headers.length}`
      );
    }
    return headers.reduce((obj, header, index) => {
      obj[header] = values[index] || "";
      return obj;
    }, {});
  });
}

function formatCSVValue(value) {
  return `"${String(value ?? "").replace(/"/g, "\"\"")}"`;
}

// Helper function to fill PDF fields
async function fillPdfDocumentFields(pdfDoc, fieldData) {
  const form = pdfDoc.getForm();
  const filledFields = [];
  const errors = [];
  
  for (const [fieldName, value] of Object.entries(fieldData)) {
    try {
      const field = form.getField(fieldName);
      
      if (field.constructor.name.includes('TextField')) {
        field.setText(String(value));
      } else if (field.constructor.name.includes('CheckBox')) {
        if (value === true || value === 'true' || value === 'yes' || value === '1') {
          field.check();
        } else {
          field.uncheck();
        }
      } else if (field.constructor.name.includes('RadioGroup')) {
        field.select(String(value));
      } else if (field.constructor.name.includes('Dropdown')) {
        field.select(String(value));
      }
      filledFields.push(fieldName);
    } catch (e) {
      if (e.message?.includes('No field')) {
        errors.push(`Field '${fieldName}' not found in PDF. Check field name or use 'read_pdf_fields' to see available fields.`);
      } else {
        errors.push(`Field '${fieldName}': ${e.message}`);
      }
    }
  }
  
  return { pdfDoc, filledFields, errors };
}

async function fillPdfBytes(pdfBytes, fieldData, password = null) {
  // No `decryptFor`: filling writes the document back, so it stays on the
  // honest pdf-lib limit rather than the decrypting path.
  const { pdfDoc } = await loadPdfBytes(pdfBytes, password);
  return await fillPdfDocumentFields(pdfDoc, fieldData);
}

// read_pdf_content, read_pdf_pages, and search_pdf_text decrypt through PDF.js
// but expose no password argument, so PDF.js's stock "provide it with the
// password parameter" advice names an input those tools cannot accept. Name the
// read tools that do take one instead.
const PDFJS_NO_PASSWORD_ARGUMENT_MESSAGE =
  "This PDF is encrypted and this tool accepts no password. Use read_pdf_layout, "
  + "convert_pdf_to_markdown, or get_pdf_info, which do accept a password, or decrypt "
  + "the file first (for example with qpdf) and retry.";

function passwordlessReadError(error) {
  if (!["PASSWORD_REQUIRED", "PASSWORD_INCORRECT"].includes(error?.code)) return error;
  const replacement = new Error(PDFJS_NO_PASSWORD_ARGUMENT_MESSAGE);
  replacement.code = error.code;
  return replacement;
}

// List available tools
async function listTools(request) {
  rejectUnissuedCursor(request, "tools/list");
  return {
    tools: [
      {
        name: "list_pdfs",
        description: "List PDF files in a directory, sorted by name, returning at most 200 paths per call and reporting the true total when more exist. Use offset to page through a folder with more than 200 PDFs. This tool operates on the user's local filesystem — all paths must be absolute paths on the user's machine (e.g. /Users/name/Documents/), NOT paths on Claude's container (/mnt/...).",
        inputSchema: {
          type: "object",
          properties: {
            directory: {
              type: "string",
              description: "Directory path to search for PDFs. Defaults to the configured PDFs folder. Must be a local filesystem path."
            },
            offset: {
              type: "integer",
              minimum: 0,
              description: "Skip this many PDFs before listing. Use it to page through a folder holding more than 200 PDFs; the response reports the true total."
            }
          }
        },
        annotations: {
          title: "List PDF Files",
          readOnlyHint: true,
          destructiveHint: false,
          idempotentHint: true,
          openWorldHint: false
        }
      },
      {
        name: "read_pdf_fields",
        description: "Read all form fields from a PDF file and display them in an interactive viewer. Returns field names, types, and current values. Also renders the PDF visually — no need to also call display_pdf. All paths must be absolute paths on the user's local machine, NOT Claude container paths (/mnt/...).",
        inputSchema: {
          type: "object",
          properties: {
            pdf_path: {
              type: "string",
              description: "Path to the PDF file"
            },
            password: {
              type: "string",
              description: PDF_DECRYPTABLE_PASSWORD_DESCRIPTION,
            }
          },
          required: ["pdf_path"]
        },
        annotations: {
          title: "Read PDF Form Fields",
          readOnlyHint: false,
          destructiveHint: false,
          idempotentHint: false,
          openWorldHint: false
        },
        _meta: {
          ui: {
            resourceUri: "ui://pdf-toolkit/viewer"
          }
        }
      },
      {
        name: "fill_pdf",
        description: "Fill a PDF form with provided data and save it. output_path may be the same as pdf_path for in-place editing; the original is backed up on the first same-path mutation. All paths must be absolute paths on the user's local machine, NOT Claude container paths (/mnt/...).",
        inputSchema: {
          type: "object",
          properties: {
            pdf_path: {
              type: "string",
              description: "Path to the source PDF file"
            },
            output_path: {
              type: "string",
              description: "Path where the filled PDF will be saved"
            },
            field_data: {
              type: "object",
              description: "Object with field names as keys and values to fill"
            },
            password: {
              type: "string",
              description: PDF_REPROTECTING_PASSWORD_DESCRIPTION,
            },
            force_xfa: {
              type: "boolean",
              description: "Proceed even if the PDF is a DYNAMIC XFA form, whose pages are built from the XFA layer that saving drops (default: false). Static XFA needs no flag: its values live in the AcroForm and survive, and the result says the layer was removed."
            },
            expected_output_identity: EXPECTED_OUTPUT_IDENTITY_INPUT_SCHEMA
          },
          required: ["pdf_path", "output_path", "field_data"]
        },
        annotations: {
          title: "Fill PDF Form",
          readOnlyHint: false,
          destructiveHint: true,
          idempotentHint: true,
          openWorldHint: false
        }
      },
      {
        name: "bulk_fill_from_csv",
        description: "Fill multiple PDFs using data from a CSV file. Output filenames must be unique. New outputs need no identity; every existing destination requires one exact entry in expected_output_identities. Any missing, stale, unrelated, or duplicate identity or any row failure aborts the whole batch.",
        inputSchema: {
          type: "object",
          properties: {
            pdf_path: {
              type: "string",
              description: "Path to the template PDF file"
            },
            csv_path: {
              type: "string",
              description: "Path to CSV file with data (first row should be field names)"
            },
            output_directory: {
              type: "string",
              description: "Directory where filled PDFs will be saved"
            },
            filename_column: {
              type: "string",
              description: "CSV column to use for output filenames (optional)"
            },
            password: {
              type: "string",
              description: PDF_REPROTECTING_PASSWORD_DESCRIPTION,
            },
            force_xfa: {
              type: "boolean",
              description: "Proceed even if the PDF is a DYNAMIC XFA form, whose pages are built from the XFA layer that saving drops (default: false). Static XFA needs no flag: its values live in the AcroForm and survive, and the result says the layer was removed."
            },
            expected_output_identities: EXPECTED_OUTPUT_IDENTITIES_INPUT_SCHEMA
          },
          required: ["pdf_path", "csv_path", "output_directory"]
        },
        annotations: {
          title: "Bulk Fill PDFs from CSV",
          readOnlyHint: false,
          destructiveHint: true,
          idempotentHint: true,
          openWorldHint: false
        }
      },
      {
        name: "save_profile",
        description: "Save form data as a reusable profile",
        inputSchema: {
          type: "object",
          properties: {
            profile_name: {
              type: "string",
              description: "Name for the profile (e.g., 'work', 'personal')"
            },
            field_data: {
              type: "object",
              description: "Object with field names and values to save"
            }
          },
          required: ["profile_name", "field_data"]
        },
        annotations: {
          title: "Save Form Profile",
          readOnlyHint: false,
          destructiveHint: true,
          idempotentHint: true,
          openWorldHint: false
        }
      },
      {
        name: "load_profile",
        description: "Load a saved profile",
        inputSchema: {
          type: "object",
          properties: {
            profile_name: {
              type: "string",
              description: "Name of the profile to load"
            }
          },
          required: ["profile_name"]
        },
        annotations: {
          title: "Load Form Profile",
          readOnlyHint: true,
          destructiveHint: false,
          idempotentHint: true,
          openWorldHint: false
        }
      },
      {
        name: "list_profiles",
        description: "List all saved profiles",
        inputSchema: {
          type: "object",
          properties: {}
        },
        annotations: {
          title: "List Saved Profiles",
          readOnlyHint: true,
          destructiveHint: false,
          idempotentHint: true,
          openWorldHint: false
        }
      },
      {
        name: "fill_with_profile",
        description: "Fill a PDF using a saved profile",
        inputSchema: {
          type: "object",
          properties: {
            pdf_path: {
              type: "string",
              description: "Path to the PDF file"
            },
            output_path: {
              type: "string",
              description: "Path where the filled PDF will be saved"
            },
            profile_name: {
              type: "string",
              description: "Name of the profile to use"
            },
            additional_data: {
              type: "object",
              description: "Additional fields to fill/override (optional)"
            },
            password: {
              type: "string",
              description: PDF_REPROTECTING_PASSWORD_DESCRIPTION,
            },
            expected_output_identity: EXPECTED_OUTPUT_IDENTITY_INPUT_SCHEMA
          },
          required: ["pdf_path", "output_path", "profile_name"]
        },
        annotations: {
          title: "Fill PDF with Profile",
          readOnlyHint: false,
          destructiveHint: true,
          idempotentHint: true,
          openWorldHint: false
        }
      },
      {
        name: "extract_to_csv",
        description: "Extract form data from filled PDFs to a CSV file",
        inputSchema: {
          type: "object",
          properties: {
            pdf_paths: {
              type: "array",
              items: { type: "string" },
              description: "Array of PDF file paths to extract data from"
            },
            output_csv: {
              type: "string",
              description: "Path where the CSV file will be saved"
            }
          },
          required: ["pdf_paths", "output_csv"]
        },
        annotations: {
          title: "Extract PDF Data to CSV",
          readOnlyHint: false,
          destructiveHint: true,
          idempotentHint: true,
          openWorldHint: false
        }
      },
      {
        name: "validate_pdf",
        description: "Inspect AcroForm value coverage and the PDF's actual Required flags without mutating the document. Returns explicit complete, partial, no-fields, and indeterminate states plus a narrow required-field claim boundary; it does not determine legal validity, business-rule validity, signature validity, or readiness to submit.",
        inputSchema: {
          type: "object",
          properties: {
            pdf_path: {
              type: "string",
              description: "Absolute path to the fillable PDF on the user's machine."
            },
            password: {
              type: "string",
              description: PDF_DECRYPTABLE_PASSWORD_DESCRIPTION,
            }
          },
          required: ["pdf_path"]
        },
        annotations: {
          title: "Validate PDF Form",
          readOnlyHint: true,
          destructiveHint: false,
          idempotentHint: true,
          openWorldHint: false
        }
      },
      {
        name: "read_pdf_content",
        description: "Read PDF text for broad understanding of the document. Returns an explicit extraction_status (complete, partial, or failed); a failed result must not be interpreted as an empty PDF. Best for full-document summarization, question answering, and exploratory analysis when you want a single text-oriented view of the file. If you need page-bounded excerpts or keyword search results, prefer read_pdf_pages or search_pdf_text. All paths must be absolute paths on the user's local machine, NOT Claude container paths (/mnt/...).",
        inputSchema: {
          type: "object",
          properties: {
            pdf_path: {
              type: "string",
              description: "Absolute path to the PDF file."
            },
            max_pages: {
              type: "number",
              description: "Maximum number of pages to extract. Useful for very large PDFs when you only need the opening section."
            }
          },
          required: ["pdf_path"],
          examples: [
            {
              pdf_path: "/Users/alice/Documents/contract.pdf",
              max_pages: 12
            }
          ]
        },
        annotations: {
          title: "Read PDF Content",
          readOnlyHint: true,
          destructiveHint: false,
          idempotentHint: true,
          openWorldHint: false
        }
      },
      {
        name: "read_pdf_pages",
        description: "Read a specific page range from a PDF with page-numbered structured output. Use this when the model should inspect or quote a bounded slice of the document instead of loading the whole thing at once. All paths must be absolute paths on the user's local machine, NOT Claude container paths (/mnt/...).",
        inputSchema: {
          type: "object",
          properties: {
            pdf_path: {
              type: "string",
              description: "Absolute path to the PDF file."
            },
            start_page: {
              type: "number",
              description: "First page to read (1-indexed, default: 1)."
            },
            end_page: {
              type: "number",
              description: "Last page to read (1-indexed, inclusive, default: start_page)."
            },
            max_chars_per_page: {
              type: "number",
              description: "Maximum characters to return per page, an integer from 1 to 20000 (default: 4000). Every page in one call also draws on a shared 16,000-character budget, so a later page in a long range can return less text than this, or none; read it with a later start_page."
            }
          },
          required: ["pdf_path"],
          examples: [
            {
              pdf_path: "/Users/alice/Documents/nda.pdf",
              start_page: 4,
              end_page: 6
            }
          ]
        },
        annotations: {
          title: "Read PDF Pages",
          readOnlyHint: true,
          destructiveHint: false,
          idempotentHint: true,
          openWorldHint: false
        }
      },
      {
        name: "read_pdf_layout",
        description: "Extract a bounded page range into the versioned PDF Tools Extraction IR using the local pinned PDF.js parser. Returns source identity, raw page boxes and rotation when available, PDF.js-authoritative display geometry in physical 1/72-inch points after UserUnit, conservative lines and nonsemantic flow blocks, normalized flow/spatial text, and explicit raster or partial gaps. Text-run quads are advance boxes, not glyph ink bounds. This tool does not render pages, run OCR, infer tables, or fill an arbitrary schema. Narrow the page range or lower limits for large documents. All paths must be absolute paths on the user's local machine, NOT Claude container paths (/mnt/...).",
        inputSchema: {
          type: "object",
          additionalProperties: false,
          properties: {
            pdf_path: { type: "string", description: "Absolute path, or ~/ path, to the local PDF file." },
            password: { type: "string", description: "Password for an encrypted PDF, when required." },
            start_page: { type: "integer", minimum: 1, description: "First page to extract, 1-indexed. Default: 1." },
            end_page: { type: "integer", minimum: 1, description: "Last page to extract, inclusive. Default: start_page. At most 10 pages per call." },
            max_items: { type: "integer", minimum: 1, maximum: 5000, description: "Maximum returned raw text items across the requested range. Default: 1000." },
            max_characters: { type: "integer", minimum: 1, maximum: 100000, description: "Maximum returned raw text characters across the requested range. Default: 50000." },
            max_output_characters: { type: "integer", minimum: 20000, maximum: 200000, description: "Maximum serialized structured-output characters. Whole page detail is omitted with explicit metadata if needed. Default: 50000." }
          },
          required: ["pdf_path"]
        },
        annotations: {
          title: "Read PDF Layout",
          readOnlyHint: true,
          destructiveHint: false,
          idempotentHint: true,
          openWorldHint: false
        }
      },
      {
        name: "convert_pdf_to_markdown",
        description: "Convert a bounded page range of a local PDF into deterministic Markdown from the source-validated PDF Tools Extraction IR. Headings and lists require geometry or literal marker evidence. A table requires a complete recurring text grid, a clean ruled-rectangle grid, or a complete closed painted grid, with every item in one cell and real header evidence. A link requires a source-validated external http or https annotation target covering one contiguous text run. Unsupported tables and link targets, including merged cells, internal destinations, actions, and other schemes, stay escaped text with typed gaps. Compact extreme-margin page numbers and provenance furniture, plus same-band text repeated across selected pages, are removed with typed counts by default; detected headings and all source-evidenced table-region lines are preserved, and removal can be disabled. No OCR or external model. Optionally enable compact mode for counted dot-leader and spaced-hyphen normalizations. Optionally saves transactional UTF-8 Markdown. Use absolute or ~/ local paths, not Claude container paths (/mnt/...).",
        inputSchema: {
          type: "object",
          additionalProperties: false,
          properties: {
            pdf_path: { type: "string", description: "Absolute path to the local PDF file." },
            password: { type: "string", description: "Password for an encrypted PDF, when required." },
            start_page: { type: "integer", minimum: 1, description: "First page to convert, 1-indexed. Default: 1." },
            end_page: { type: "integer", minimum: 1, description: "Last page to convert, inclusive. Default: start_page. At most 10 pages per call." },
            max_items: { type: "integer", minimum: 1, maximum: 5000, description: "Maximum retained PDF text items across the requested range. Default: 1000." },
            max_characters: { type: "integer", minimum: 1, maximum: 100000, description: "Maximum retained PDF text characters across the requested range. Default: 50000." },
            max_markdown_bytes: { type: "integer", minimum: 256, maximum: 200000, description: "Maximum UTF-8 Markdown bytes. The conversion fails rather than cutting a line or Unicode sequence. Default: 50000." },
            include_page_boundaries: { type: "boolean", description: "Include deterministic HTML comments marking page boundaries. Default: true." },
            compact: { type: "boolean", description: "Opt into counted dot-leader, isolated page-number, and Unicode-letter spaced-hyphen normalizations. Default: false." },
            remove_page_furniture: { type: "boolean", description: "Remove only source-evidenced extreme-margin page furniture and report every removed line by typed gap and counts. Set false to preserve all source lines. Default: true." },
            emit_table_proposals: { type: "boolean", description: "Opt into emitting one bounded, deterministic table_proposals packet per abandoned table region (TABLE_TOPOLOGY_UNKNOWN or TABLE_RULING_UNSUPPORTED), carrying the region's text items, ruled and painted evidence, header hints, page, bbox, coordinate_space, and a source-and-IR-bound proposal_token so a host model can propose a structure for later read-only verification. Additive: the abstention gap is unchanged and default output stays byte-identical. Default: false." },
            output_path: { type: "string", description: "Optional absolute .md path, or ~/ path. The file is written only after complete bytes are staged and verified." },
            overwrite: { type: "boolean", description: "Replace an existing output_path only when its exact expected_output_identity is also supplied. Default: false." },
            expected_output_identity: EXPECTED_MARKDOWN_OUTPUT_IDENTITY_INPUT_SCHEMA
          },
          required: ["pdf_path"]
        },
        annotations: {
          title: "Convert PDF to Markdown",
          readOnlyHint: false,
          destructiveHint: true,
          idempotentHint: true,
          openWorldHint: false
        }
      },
      {
        name: "verify_table_proposal",
        description: "Deterministically check an untrusted table-structure proposal against a fresh, independently source-validated parse of the current PDF. The caller supplies only a region/token identity and item-to-cell assignments; text, geometry, header evidence, and packet fields are regenerated from source bytes. Acceptance means source-derived content passed coverage and ordering checks and the rectangular grid agrees with every available source ruling segment. Borderless or otherwise ambiguous geometry rejects. Consistency does not prove unique topology. No OCR, model, network, mutation, or numeric confidence.",
        inputSchema: {
          type: "object",
          additionalProperties: false,
          properties: {
            pdf_path: { type: "string", description: "Absolute path, or ~/ path, to the same local PDF used to obtain the proposal packet." },
            password: { type: "string", description: "Password for an encrypted PDF, when required." },
            region_id: { type: "string", pattern: "^p[1-9][0-9]*-t[1-9][0-9]*$", description: "Deterministic B1 abandoned-region identity, such as p1-t1." },
            proposal_token: { type: "string", pattern: "^[a-f0-9]{64}$", description: "B1 SHA-256 token binding the source SHA-256, extraction IR version, and region identity." },
            cells: {
              type: "array",
              minItems: 1,
              maxItems: 1000,
              description: "Untrusted structural assignments. Cell text is never accepted from the caller.",
              items: {
                type: "object",
                additionalProperties: false,
                properties: {
                  row: { type: "integer", minimum: 0, maximum: 999 },
                  column: { type: "integer", minimum: 0, maximum: 999 },
                  rowspan: { type: "integer", minimum: 1, maximum: 1000 },
                  colspan: { type: "integer", minimum: 1, maximum: 1000 },
                  item_ids: {
                    type: "array",
                    maxItems: 400,
                    items: { type: "string", minLength: 1, maxLength: 128 },
                  },
                },
                required: ["row", "column", "rowspan", "colspan", "item_ids"],
              },
            },
          },
          required: ["pdf_path", "region_id", "proposal_token", "cells"],
        },
        annotations: {
          title: "Verify Table Proposal",
          readOnlyHint: true,
          destructiveHint: false,
          idempotentHint: true,
          openWorldHint: false,
        },
      },
      {
        name: "render_pdf_page",
        description: "Render one PDF.js page view to a PNG image for visual reasoning. The source-bound result distinguishes raw MediaBox/CropBox geometry from the rotated, UserUnit-scaled PDF.js view and raster coordinate spaces. Use this when text extraction is weak or visual layout must be inspected. All paths must be absolute local paths, not host container paths.",
        inputSchema: {
          type: "object",
          properties: {
            pdf_path: {
              type: "string",
              description: "Absolute path to the PDF file."
            },
            page: {
              type: "number",
              description: "Page number to render (1-indexed, default: 1)."
            },
            max_dimension_px: {
              type: "number",
              description: "Target size of the page image's longer side in pixels, an integer from 64 to 8192 (default: 1800). The render scale is held between 1 and 2.5 pixels per PDF.js viewport point, so a page whose longer side exceeds this many points renders larger than the target, and a target above 2.5 times that side renders smaller. Use smaller values for lighter previews."
            },
            password: {
              type: "string",
              description: PDF_LIB_GEOMETRY_PASSWORD_DESCRIPTION,
            }
          },
          required: ["pdf_path"],
          examples: [
            {
              pdf_path: "/Users/alice/Documents/scanned-invoice.pdf",
              page: 1,
              max_dimension_px: 1600
            }
          ]
        },
        annotations: {
          title: "Render PDF Page",
          readOnlyHint: true,
          destructiveHint: false,
          idempotentHint: true,
          openWorldHint: false
        }
      },
      {
        name: "render_pdf_region",
        description: "Render a rectangular region from the rotated, UserUnit-scaled PDF.js page view. Coordinates use a top-left origin in PDF.js viewport points and are not interchangeable with MediaBox-relative detect_signature_zones or signing coordinates. The macOS system renderer preserves this view mapping and reports raw pixels unavailable. All paths must be absolute local paths, not host container paths.",
        inputSchema: {
          type: "object",
          properties: {
            pdf_path: {
              type: "string",
              description: "Absolute path to the PDF file."
            },
            page: {
              type: "number",
              description: "Page number to render (1-indexed)."
            },
            x: {
              type: "number",
              description: "Left edge in PDF.js viewport points from the displayed page view's left edge."
            },
            y: {
              type: "number",
              description: "Top edge in PDF.js viewport points from the displayed page view's top edge."
            },
            width: {
              type: "number",
              description: "Width in rotated, UserUnit-scaled PDF.js viewport points."
            },
            height: {
              type: "number",
              description: "Height in rotated, UserUnit-scaled PDF.js viewport points."
            },
            max_dimension_px: {
              type: "number",
              description: "Target size of the region image's longer side in pixels, an integer from 64 to 8192 (default: 1400). The render scale is held between 0.1 and 4 pixels per PDF.js viewport point, so a region whose longer side exceeds ten times the target renders larger than it, and a target above four times that side renders smaller."
            },
            password: {
              type: "string",
              description: PDF_LIB_GEOMETRY_PASSWORD_DESCRIPTION,
            }
          },
          required: ["pdf_path", "page", "x", "y", "width", "height"],
          examples: [
            {
              pdf_path: "/Users/alice/Documents/contract.pdf",
              page: 8,
              x: 72,
              y: 620,
              width: 220,
              height: 80,
              max_dimension_px: 1200
            }
          ]
        },
        annotations: {
          title: "Render PDF Region",
          readOnlyHint: true,
          destructiveHint: false,
          idempotentHint: true,
          openWorldHint: false
        }
      },
      {
        name: "search_pdf_text",
        description: "Search extracted PDF text for a literal phrase and return page-numbered snippets. Use this when you need to find mentions of a clause, person, amount, or keyword before deciding which pages to inspect more deeply. All paths must be absolute paths on the user's local machine, NOT Claude container paths (/mnt/...).",
        inputSchema: {
          type: "object",
          properties: {
            pdf_path: {
              type: "string",
              description: "Absolute path to the PDF file."
            },
            query: {
              type: "string",
              description: "Literal text to search for, such as \"indemnification\" or \"governing law\"."
            },
            max_results: {
              type: "number",
              description: "Maximum number of matching snippets to return (default: 10)."
            },
            context_chars: {
              type: "number",
              description: "Approximate number of surrounding characters to include around each match (default: 160)."
            }
          },
          required: ["pdf_path", "query"],
          examples: [
            {
              pdf_path: "/Users/alice/Documents/master-services-agreement.pdf",
              query: "indemnification",
              max_results: 5
            }
          ]
        },
        annotations: {
          title: "Search PDF Text",
          readOnlyHint: true,
          destructiveHint: false,
          idempotentHint: true,
          openWorldHint: false
        }
      },
      {
        name: "get_pdf_resource_uri",
        description: "Return the PDF's `pdf://...` resource URI so Claude-compatible MCP hosts can reference the binary directly through this server's Resources API. Use this when the host supports MCP resources and you want to hand Claude the document itself rather than only extracted text.",
        inputSchema: {
          type: "object",
          properties: {
            pdf_path: {
              type: "string",
              description: "Absolute path to the PDF file."
            }
          },
          required: ["pdf_path"],
          examples: [
            {
              pdf_path: "/Users/alice/Documents/report.pdf"
            }
          ]
        },
        annotations: {
          title: "Get PDF Resource URI",
          readOnlyHint: true,
          destructiveHint: false,
          idempotentHint: true,
          openWorldHint: false
        }
      },
      {
        name: "get_pdf_identity",
        description: "Return a stable local artifact identity for a PDF without parsing or decrypting its document structure: canonical path, exact byte length, and SHA-256. Use this to bind plans, approvals, outputs, or provenance to the exact input bytes. The tool reads at most 250 MiB through one race-aware file descriptor and requires a PDF header within the first 1,024 bytes.",
        inputSchema: {
          type: "object",
          properties: {
            pdf_path: {
              type: "string",
              description: "Absolute path to the local PDF file."
            }
          },
          required: ["pdf_path"],
          examples: [
            {
              pdf_path: "/Users/alice/Documents/contract.pdf"
            }
          ]
        },
        annotations: {
          title: "Get PDF Identity",
          readOnlyHint: true,
          destructiveHint: false,
          idempotentHint: true,
          openWorldHint: false
        }
      },
      {
        name: "display_pdf",
        description: "Open the interactive PDF viewer with page navigation, zoom, in-document search, text selection, form-field sidebar, and Sign mode. This is the primary tool for visually working with a PDF. If the user gave you a URL instead of a local path, call fetch_pdf_from_url first, then pass the downloaded local path here. Automatically detects form fields, so you usually do not need to also call read_pdf_fields. All paths must be absolute paths on the user's local machine, NOT Claude container paths (/mnt/...).",
        inputSchema: {
          type: "object",
          properties: {
            pdf_path: {
              type: "string",
              description: "Absolute path to the PDF file."
            },
            page: {
              type: "number",
              description: "Initial page number to display (default: 1)."
            }
          },
          required: ["pdf_path"],
          examples: [
            {
              pdf_path: "/Users/alice/Documents/w9.pdf",
              page: 2
            }
          ]
        },
        annotations: {
          title: "Display PDF Viewer",
          readOnlyHint: false,
          destructiveHint: false,
          idempotentHint: false,
          openWorldHint: false
        },
        _meta: {
          ui: {
            resourceUri: "ui://pdf-toolkit/viewer"
          }
        }
      },
      {
        name: "get_active_document",
        description: "Return the toolkit's current active PDF document, including its canonical active_path, any backup_path created on first mutation, and the last mutation metadata. Use this when an agent needs to resume work on the current document without guessing which file is canonical.",
        inputSchema: {
          type: "object",
          properties: {}
        },
        annotations: {
          title: "Get Active Document",
          readOnlyHint: true,
          destructiveHint: false,
          idempotentHint: true,
          openWorldHint: false
        }
      },
      {
        name: "set_active_document",
        description: "Set or rehydrate the toolkit's active document state from a viewer session. Intended for the viewer to resync the canonical active_path and optional backup_path after MCP/server restarts.",
        inputSchema: {
          type: "object",
          properties: {
            pdf_path: {
              type: "string",
              description: "Canonical active PDF path currently shown in the viewer."
            },
            backup_path: {
              type: "string",
              description: "Optional backup path previously created for this document."
            },
            last_mutation_tool: {
              type: "string",
              description: "Optional last mutation tool name to preserve across rehydration."
            },
            last_mutation_at: {
              type: "string",
              description: "Optional ISO-8601 timestamp of the last mutation."
            }
          },
          required: ["pdf_path"]
        },
        annotations: {
          title: "Set Active Document",
          readOnlyHint: false,
          destructiveHint: false,
          idempotentHint: false,
          openWorldHint: false
        }
      },
      {
        name: "read_pdf_bytes",
        description: "Read PDF file bytes in chunks (for UI rendering)",
        inputSchema: {
          type: "object",
          properties: {
            pdf_path: {
              type: "string",
              description: "Path to the PDF file"
            },
            offset: {
              type: "number",
              description: "Byte offset to start reading from"
            },
            byteCount: {
              type: "number",
              description: "Number of bytes to read (max 524288)"
            }
          },
          required: ["pdf_path", "offset", "byteCount"]
        },
        annotations: {
          title: "Read PDF Bytes",
          readOnlyHint: true,
          destructiveHint: false,
          idempotentHint: true,
          openWorldHint: false
        },
        _meta: {
          ui: {
            visibility: ["app"]
          }
        }
      },
      {
        name: "merge_pdfs",
        description: "Merge multiple PDF files into a single PDF. For multi-input merges, descriptive metadata is preserved only when every input asserts the same value; conflicting, partial, or invalid Title, Author, Subject, and Keywords claims are omitted rather than misattributed. New outputs commit atomically. Replacing a distinct existing output requires its exact current expected_output_identity. All paths must be absolute paths on the user's local machine.",
        inputSchema: {
          type: "object",
          properties: {
            input_paths: {
              type: "array",
              items: { type: "string" },
              description: "Array of PDF file paths to merge (in order)"
            },
            output_path: {
              type: "string",
              description: "Path where the merged PDF will be saved"
            },
            password: {
              type: "string",
              description: PDF_REPROTECTING_PASSWORD_DESCRIPTION,
            },
            expected_output_identity: EXPECTED_OUTPUT_IDENTITY_INPUT_SCHEMA
          },
          required: ["input_paths", "output_path"]
        },
        annotations: {
          title: "Merge PDFs",
          readOnlyHint: false,
          destructiveHint: true,
          idempotentHint: true,
          openWorldHint: false
        },
        _meta: {
          ui: {
            resourceUri: "ui://pdf-toolkit/viewer"
          }
        }
      },
      {
        name: "split_pdf",
        description: "Split a PDF into multiple files by page ranges (e.g. '1-5,6-10') or at regular intervals (e.g. 'every 5'). New outputs need no identity; every existing destination requires one exact entry in expected_output_identities. Any identity or output failure aborts the whole split set. All paths must be absolute paths on the user's local machine.",
        inputSchema: {
          type: "object",
          properties: {
            input_path: {
              type: "string",
              description: "Path to the PDF file to split"
            },
            page_ranges: {
              type: "string",
              description: "Page ranges: '1-5,6-10,11-15' or 'every 5' for uniform splits"
            },
            output_directory: {
              type: "string",
              description: "Directory where split PDFs will be saved"
            },
            password: {
              type: "string",
              description: PDF_REPROTECTING_PASSWORD_DESCRIPTION,
            },
            expected_output_identities: EXPECTED_OUTPUT_IDENTITIES_INPUT_SCHEMA
          },
          required: ["input_path", "page_ranges", "output_directory"]
        },
        annotations: {
          title: "Split PDF",
          readOnlyHint: false,
          destructiveHint: true,
          idempotentHint: true,
          openWorldHint: false
        }
      },
      {
        name: "rotate_pdf_pages",
        description: "Rotate pages in a PDF by 90, 180, or 270 degrees. New outputs commit atomically. Replacing a distinct existing output requires its exact current expected_output_identity. All paths must be absolute paths on the user's local machine.",
        inputSchema: {
          type: "object",
          properties: {
            input_path: {
              type: "string",
              description: "Path to the source PDF file"
            },
            output_path: {
              type: "string",
              description: "Path where the rotated PDF will be saved"
            },
            pages: {
              type: "array",
              items: { type: "number" },
              description: "Array of 1-based page numbers to rotate (omit or empty array for all pages)"
            },
            degrees: {
              type: "number",
              description: "Rotation angle: 90, 180, or 270"
            },
            password: {
              type: "string",
              description: PDF_REPROTECTING_PASSWORD_DESCRIPTION,
            },
            expected_output_identity: EXPECTED_OUTPUT_IDENTITY_INPUT_SCHEMA
          },
          required: ["input_path", "output_path", "degrees"]
        },
        annotations: {
          title: "Rotate PDF Pages",
          readOnlyHint: false,
          destructiveHint: true,
          idempotentHint: true,
          openWorldHint: false
        },
        _meta: {
          ui: {
            resourceUri: "ui://pdf-toolkit/viewer"
          }
        }
      },
      {
        name: "reorder_pdf_pages",
        description: "Rearrange the pages of a PDF in a new order. All pages must be included exactly once (strict permutation). New outputs commit atomically. Replacing a distinct existing output requires its exact current expected_output_identity. All paths must be absolute paths on the user's local machine.",
        inputSchema: {
          type: "object",
          properties: {
            input_path: {
              type: "string",
              description: "Path to the source PDF file"
            },
            output_path: {
              type: "string",
              description: "Path where the reordered PDF will be saved"
            },
            page_order: {
              type: "array",
              items: { type: "number" },
              description: "Array of 1-based page numbers in desired order, e.g. [3, 1, 2, 4]"
            },
            password: {
              type: "string",
              description: PDF_REPROTECTING_PASSWORD_DESCRIPTION,
            },
            expected_output_identity: EXPECTED_OUTPUT_IDENTITY_INPUT_SCHEMA
          },
          required: ["input_path", "output_path", "page_order"]
        },
        annotations: {
          title: "Reorder PDF Pages",
          readOnlyHint: false,
          destructiveHint: true,
          idempotentHint: true,
          openWorldHint: false
        },
        _meta: {
          ui: {
            resourceUri: "ui://pdf-toolkit/viewer"
          }
        }
      },
      {
        name: "inspect_pdf_accessibility",
        description: "Inspect an unencrypted bounded local PDF for exactly eight shallow catalog-level accessibility signals. Returns exact missing or unavailable observations, a source SHA-256 binding, fixed limitations, and areas requiring qualified human review. This structural review does not run veraPDF, assess tag semantics or assistive-technology behavior, edit the PDF, or establish PDF/UA, WCAG, certification, legal-compliance, or document-accessibility conclusions.",
        inputSchema: {
          type: "object",
          additionalProperties: false,
          properties: {
            pdf_path: {
              type: "string",
              maxLength: 32768,
              description: "Absolute path or ~/ path to the unencrypted local PDF file.",
            },
          },
          required: ["pdf_path"],
        },
        annotations: {
          title: "Inspect PDF Accessibility Signals",
          readOnlyHint: true,
          destructiveHint: false,
          idempotentHint: true,
          openWorldHint: false,
        },
      },
      {
        name: "compare_pdfs",
        description: "Deterministically compare two complete bounded local PDFs through source-bound parser observations, Extraction IR text geometry, forms, ordinary annotations, metadata, and optional raw-RGBA visual evidence. Page alignment never guesses across unresolved repeated-page ambiguity. Default mode suppresses only typed presentation noise while retaining every detected change. A no-reported-changes result is never an equivalence claim and is emitted only when every requested channel is supported and complete. Both inputs are re-hashed after comparison and any source mutation discards all claims. No links or actions are followed and no network access or persistent output is used.",
        inputSchema: {
          type: "object",
          additionalProperties: false,
          properties: {
            before_pdf_path: { type: "string", description: "Absolute path to the earlier PDF." },
            after_pdf_path: { type: "string", description: "Absolute path to the later PDF." },
            before_password: { type: "string", maxLength: 4096, description: `Optional password for the earlier PDF. ${PDF_LIB_GEOMETRY_PASSWORD_DESCRIPTION}` },
            after_password: { type: "string", maxLength: 4096, description: `Optional password for the later PDF. ${PDF_LIB_GEOMETRY_PASSWORD_DESCRIPTION}` },
            mode: { type: "string", enum: ["default_material", "forensic"], description: "Presentation mode. Default: default_material." },
            max_pages: { type: "integer", minimum: 1, maximum: 20, description: "Whole-document page ceiling for each input. Default: 10." },
            include_visual: { type: "boolean", description: "Request canonical raw-pixel visual comparison. Default: true." },
            max_output_characters: { type: "integer", minimum: 20000, maximum: 200000, description: "Maximum serialized structured-output characters. Default: 100000." },
          },
          required: ["before_pdf_path", "after_pdf_path"],
        },
        annotations: {
          title: "Compare PDFs",
          readOnlyHint: true,
          destructiveHint: false,
          idempotentHint: true,
          openWorldHint: false,
        },
      },
      {
        name: "get_pdf_info",
        description: "Inspect a bounded local PDF through the pinned parser and return source-bound page geometry, Info and XMP metadata, form fields and widgets, and inert ordinary annotations. Every retained observation is tied to the canonical path, byte length, and SHA-256. Caps and parser failures are reported as partial or unavailable coverage, never as an empty-document claim. Annotation actions and URLs are observed but never followed. All paths must be absolute paths on the user's local machine.",
        inputSchema: {
          type: "object",
          additionalProperties: false,
          properties: {
            pdf_path: {
              type: "string",
              description: "Path to the PDF file"
            },
            password: {
              type: "string",
              maxLength: 4096,
              description: "Password for encrypted PDFs (optional)"
            },
            max_pages: {
              type: "integer",
              minimum: 1,
              maximum: 200,
              description: "Maximum pages to observe. Default: 200."
            },
            max_output_characters: {
              type: "integer",
              minimum: 20000,
              maximum: 200000,
              description: "Maximum serialized structured-output characters. Whole observations are omitted with explicit partial coverage when necessary. Default: 50000."
            }
          },
          required: ["pdf_path"]
        },
        annotations: {
          title: "Get PDF Info",
          readOnlyHint: true,
          destructiveHint: false,
          idempotentHint: true,
          openWorldHint: false
        }
      },
      {
        name: "apply_page_plan",
        description: "Apply a page plan to a PDF: reorder, rotate, and delete pages in one pass. Pages not listed in page_order are excluded (deleted). The source is never modified. Replacing a distinct existing output requires its exact current expected_output_identity. All paths must be absolute.",
        inputSchema: {
          type: "object",
          properties: {
            input_path: {
              type: "string",
              description: "Path to the source PDF file"
            },
            output_path: {
              type: "string",
              description: "Path where the new PDF will be saved (must differ from input_path)"
            },
            plan: {
              type: "object",
              description: "Page plan object",
              properties: {
                page_order: {
                  type: "array",
                  items: { type: "integer" },
                  description: "1-indexed page numbers in desired order. Pages not listed are excluded (deleted)."
                },
                rotations: {
                  type: "object",
                  description: "Map of original page number (string) to rotation degrees (90, 180, or 270). Entries for excluded pages are silently ignored.",
                  additionalProperties: { type: "number" }
                }
              },
              required: ["page_order"]
            },
            password: {
              type: "string",
              description: PDF_REPROTECTING_PASSWORD_DESCRIPTION,
            },
            force_xfa: {
              type: "boolean",
              description: "Proceed even if the PDF is a DYNAMIC XFA form, whose pages are built from the XFA layer that saving drops (default: false). Static XFA needs no flag: its values live in the AcroForm and survive, and the result says the layer was removed."
            },
            expected_output_identity: EXPECTED_OUTPUT_IDENTITY_INPUT_SCHEMA
          },
          required: ["input_path", "output_path", "plan"]
        },
        annotations: {
          title: "Apply Page Plan",
          readOnlyHint: false,
          destructiveHint: true,
          idempotentHint: true,
          openWorldHint: false
        }
      },
      {
        name: "get_page_analysis",
        description: "Analyze a PDF and return per-page metadata with explicit content-analysis provenance: text length, text snippet, image/vector-graphics presence, dimensions, orientation, and blank_status. Only likely_blank pages with complete content measurements are blank candidates, and every candidate still requires visual inspection before mutation; unknown pages must never be deleted or reordered from this result. All paths must be absolute.",
        inputSchema: {
          type: "object",
          properties: {
            pdf_path: {
              type: "string",
              description: "Path to the PDF file"
            },
            password: {
              type: "string",
              description: PDF_LIB_GEOMETRY_PASSWORD_DESCRIPTION,
            }
          },
          required: ["pdf_path"]
        },
        annotations: {
          title: "Get Page Analysis",
          readOnlyHint: true,
          destructiveHint: false,
          idempotentHint: true,
          openWorldHint: false
        }
      },
      {
        name: "create_signature",
        description: "Save a reusable signature the user can apply to PDFs. Two styles: 'typed' uses the user's display name rendered in italic script on apply, 'image' uses a PNG/JPEG the user provides (a scan or photo of their actual signature, or a drawn signature as a data URL). Signatures are stored locally at ~/.pdf-toolkit-files/signatures/. This tool is agent-safe — it does NOT sign any document; it just saves the signature asset for later use by apply_signature.",
        inputSchema: {
          type: "object",
          properties: {
            name: {
              type: "string",
              description: "Short identifier for this signature (letters, numbers, hyphens, underscores, spaces, dots). Used to look it up later — e.g. 'mat-default', 'business'."
            },
            display_name: {
              type: "string",
              description: "The user's name as it should appear in attestations, e.g. 'Mat Silverstein'. If provided without an image source, creates a typed signature. If provided with image_path or image_data_url, it is stored as metadata alongside the image signature."
            },
            image_path: {
              type: "string",
              description: "[Image style] Local path to a PNG or JPEG image of the signature (a scan/photo of a handwritten signature). Must be an absolute path on the user's machine."
            },
            image_data_url: {
              type: "string",
              description: "[Image style] Base64 data URL of the signature image, e.g. 'data:image/png;base64,iVBOR...'. Use when the signature was drawn in the viewer or captured from another source."
            },
            overwrite: {
              type: "boolean",
              description: "If a signature with this name already exists, overwrite it (default: false)."
            }
          },
          required: ["name"]
        },
        annotations: {
          title: "Create Signature",
          readOnlyHint: false,
          destructiveHint: true,
          idempotentHint: false,
          openWorldHint: false
        }
      },
      {
        name: "get_allowed_directories",
        description: "Report which folders this server may read and write, which configuration layer supplied them, and where the stored configuration file lives. Answers without touching the filesystem, so it works before anything is configured. Use it to explain a path refusal or to tell the user where to change the boundary. It reports the boundary; it cannot change it.",
        inputSchema: {
          type: "object",
          properties: {}
        },
        annotations: {
          title: "Get Allowed Directories",
          readOnlyHint: true,
          destructiveHint: false,
          idempotentHint: true,
          openWorldHint: false
        }
      },
      {
        name: "list_signatures",
        description: "List all saved signatures in ~/.pdf-toolkit-files/signatures/. Returns each signature's name, style (typed or image), display name (for typed), and creation timestamp.",
        inputSchema: {
          type: "object",
          properties: {}
        },
        annotations: {
          title: "List Signatures",
          readOnlyHint: true,
          destructiveHint: false,
          idempotentHint: true,
          openWorldHint: false
        }
      },
      {
        name: "load_signature",
        description: "Load one saved signature by name. Returns the style, display name, and for image signatures a preview data URL so the viewer can render the selected asset on demand.",
        inputSchema: {
          type: "object",
          properties: {
            signature_name: {
              type: "string",
              description: "Name of a previously-saved signature."
            }
          },
          required: ["signature_name"]
        },
        annotations: {
          title: "Load Signature",
          readOnlyHint: true,
          destructiveHint: false,
          idempotentHint: true,
          openWorldHint: false
        }
      },
      {
        name: "add_signature_field",
        description: "Draw a visible 'Sign here' placeholder box on a PDF page and save as a new file. Marks where a signature should go — does NOT sign the document. Useful when preparing a PDF to send to another party for signing. Coordinates are in points (72pt = 1 inch), TOP-LEFT origin: x=distance from left, y=distance from top.",
        inputSchema: {
          type: "object",
          properties: {
            pdf_path: { type: "string", description: "Path to the input PDF" },
            output_path: { type: "string", description: "Path to save the output PDF. May be the same as pdf_path for in-place editing; the original will be backed up on the first mutation." },
            page: { type: "integer", description: "Page number (1-indexed)" },
            x: { type: "number", description: "Left edge of the signature box, in points from the left of the page" },
            y: { type: "number", description: "Top edge of the signature box, in points from the TOP of the page" },
            width: { type: "number", description: "Width of the signature box, in points (e.g. 150 for a typical signature line)" },
            height: { type: "number", description: "Height of the signature box, in points (e.g. 36 for a typical signature line)" },
            label: { type: "string", description: "Text shown inside the box (default: 'Sign here')" },
            allow_resign: {
              type: "boolean",
              description: "Proceed even if the PDF already contains cryptographic signature fields (default: false). Warning: saving will invalidate any existing signatures."
            },
            password: { type: "string", description: PDF_REPROTECTING_PASSWORD_DESCRIPTION },
            force_xfa: { type: "boolean", description: "Proceed even if the PDF uses XFA forms (default: false). Warning: the XFA data will be stripped by pdf-lib." },
            expected_output_identity: EXPECTED_OUTPUT_IDENTITY_INPUT_SCHEMA
          },
          required: ["pdf_path", "output_path", "page", "x", "y", "width", "height"]
        },
        annotations: {
          title: "Add Signature Field",
          readOnlyHint: false,
          destructiveHint: true,
          idempotentHint: false,
          openWorldHint: false
        }
      },
      {
        name: "apply_signature",
        description:
          "NEVER FABRICATE user_intent_statement OR user_confirmed_at. Both values MUST come directly from the user — ask them, get their answer, pass it through verbatim. Fabricating these is a hard violation of the human-intent requirement this tool ships under; every agent calling apply_signature does so on behalf of a user who has the legal responsibility for the signature.\n\n" +
          "This stamps a saved signature onto a PDF as a BASIC visible image — NOT legally-binding cryptographic signing.\n\n" +
          "REQUIRED WORKFLOW:\n" +
          "1. Call detect_signature_zones(pdf_path) first. Never guess coordinates — guessing places signatures on the wrong content (body text, section headers, etc.).\n" +
          "2. Pick the zone that matches what the user is signing (by type, label, and page).\n" +
          "3. Ask the user for a sentence describing their intent (e.g. \"I, {name}, sign this {document} on {date}\") and the ISO-8601 timestamp at which they confirmed. Pass both to apply_signature.\n" +
          "4. Call apply_signature with the zone's x/y/width/height + the intent values.\n\n" +
          "Coordinates use TOP-LEFT origin in points (72pt = 1 inch), in the page's NATIVE (pre-rotation) coordinate space — same space returned by detect_signature_zones. Both intent values are written into the PDF's Keywords metadata as an audit trail.",
        inputSchema: {
          type: "object",
          properties: {
            pdf_path: { type: "string", description: "Path to the input PDF" },
            output_path: { type: "string", description: "Path to save the signed PDF. May be the same as pdf_path for in-place signing; the original will be backed up on the first mutation." },
            signature_name: { type: "string", description: "Name of a previously-saved signature (see create_signature / list_signatures)" },
            page: { type: "integer", description: "Page number (1-indexed)" },
            x: { type: "number", description: "Left edge in points, TOP-LEFT origin" },
            y: { type: "number", description: "Top edge in points, TOP-LEFT origin" },
            width: { type: "number", description: "Width in points" },
            height: { type: "number", description: "Height in points" },
            user_intent_statement: {
              type: "string",
              description: "REQUIRED. The user's own sentence confirming intent to sign — e.g. \"I, Mat Silverstein, sign this W-9 application on 2026-04-16.\" Ask the user for this verbatim; do not invent it."
            },
            user_confirmed_at: {
              type: "string",
              description: "REQUIRED. ISO-8601 timestamp of when the user confirmed signing, e.g. \"2026-04-16T19:32:00Z\". Must be within the last 24 hours. Ask the user; do not fabricate."
            },
            draw_audit_line: {
              type: "boolean",
              description: "Also draw a small visible timestamp/signer line below the signature (default: false). Useful for printable audit trails."
            },
            signing_mode: {
              type: "string",
              enum: ["signature", "initials"],
              description: "Optional semantic label for the visible mark. Use 'initials' when applying a mark to an initials zone so results and audit metadata say 'initialed' instead of 'signed'."
            },
            allow_resign: {
              type: "boolean",
              description: "Proceed even if the PDF already contains cryptographic signature fields (default: false). Warning: saving will invalidate any existing signatures. Only enable if the user explicitly wants to re-sign a previously-signed document."
            },
            force_xfa: {
              type: "boolean",
              description: "Proceed even if the PDF is a DYNAMIC XFA form, whose pages are built from the XFA layer that saving drops (default: false). Static XFA needs no flag: its values live in the AcroForm and survive, and the result says the layer was removed."
            },
            overwrite: {
              type: "boolean",
              description: "Deprecated compatibility field. true is accepted as a no-op when the destination does not exist or output_path identifies the same canonical document as pdf_path. It never authorizes replacing a distinct existing output; that requires expected_output_identity."
            },
            password: { type: "string", description: PDF_REPROTECTING_PASSWORD_DESCRIPTION },
            expected_output_identity: EXPECTED_OUTPUT_IDENTITY_INPUT_SCHEMA
          },
          required: ["pdf_path", "output_path", "signature_name", "page", "x", "y", "width", "height", "user_intent_statement", "user_confirmed_at"]
        },
        annotations: {
          title: "Apply Signature",
          readOnlyHint: false,
          destructiveHint: true,
          idempotentHint: false,
          openWorldHint: false
        }
      },
      {
        name: "prepare_signing_packet",
        description: "One-shot local workflow: fill form fields AND add 'Sign here' placeholder boxes to a PDF in a single pass, saving as a new file. Returns the legacy pending-location manifest plus a provider-neutral, source-bound preparation receipt. Does NOT apply a signature, contact a provider, create an agreement, or prove legal readiness. Set require_provider_ready=true only when every zone has an explicit type and participant binding.",
        inputSchema: {
          type: "object",
          properties: {
            pdf_path: { type: "string", description: "Path to the input PDF" },
            output_path: { type: "string", description: "Path to save the prepared PDF. May be the same as pdf_path for in-place editing; the original will be backed up on the first mutation." },
            field_values: {
              type: "object",
              description: "Optional map of AcroForm field name → value. Same shape as fill_pdf's 'field_data' argument.",
              additionalProperties: true
            },
            signature_locations: {
              type: "array",
              description: "Sign-here boxes to add. Coordinates use TOP-LEFT origin in points.",
              items: {
                type: "object",
                properties: {
                  label: { type: "string", description: "Label shown in the box, e.g. 'Signature (Applicant)'" },
                  page: { type: "integer" },
                  x: { type: "number" },
                  y: { type: "number" },
                  width: { type: "number" },
                  height: { type: "number" },
                  zone_id: { type: "string", pattern: "^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$", description: "Optional stable provider-neutral zone identifier. A deterministic ID is generated when omitted." },
                  field_type: { type: "string", enum: ["signature", "initials", "date", "printed_name", "witness_signature"], description: "Provider-neutral intended field type. Required when require_provider_ready=true." },
                  participant_id: { type: "string", pattern: "^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$", description: "Opaque stable participant identifier, not an email address or secret. Required when require_provider_ready=true." },
                  participant_role: { type: "string", pattern: "^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$", description: "Provider-neutral participant role. Required when require_provider_ready=true." },
                  evidence_source: { type: "string", enum: ["caller_supplied", "detect_signature_zones", "acroform"], description: "Caller-declared label for how the placement was established (default: caller_supplied). This receipt does not independently replay that evidence." }
                },
                required: ["page", "x", "y", "width", "height"],
                additionalProperties: false
              }
            },
            require_provider_ready: {
              type: "boolean",
              description: "Fail closed before committing unless every zone is typed and participant-bound and every requested field write succeeds. Default: false. This means ready for later provider mapping only, never ready or authorized to sign."
            },
            allow_resign: {
              type: "boolean",
              description: "Proceed even if the PDF already contains cryptographic signature fields (default: false). Warning: saving will invalidate any existing signatures."
            },
            password: { type: "string", description: PDF_REPROTECTING_PASSWORD_DESCRIPTION },
            force_xfa: { type: "boolean", description: "Proceed even if the PDF uses XFA forms (default: false). Warning: the XFA layer will be stripped." },
            expected_output_identity: EXPECTED_OUTPUT_IDENTITY_INPUT_SCHEMA
          },
          required: ["pdf_path", "output_path"],
          additionalProperties: false
        },
        annotations: {
          title: "Prepare Signing Packet",
          readOnlyHint: false,
          destructiveHint: true,
          idempotentHint: false,
          openWorldHint: false
        }
      },
      {
        name: "apply_text",
        description: "Stamp a plain text string at a location on a PDF, saving the result as a new file. Use this for date zones (stamp today's date), or any other \"put these characters here\" operation that isn't a signature. NO user_intent_statement required — text is not a signature. Coordinates use TOP-LEFT origin in points, same as apply_signature. Writes a one-line audit entry to the PDF's Keywords metadata.",
        inputSchema: {
          type: "object",
          properties: {
            pdf_path: { type: "string", description: "Path to the input PDF" },
            output_path: { type: "string", description: "Path to save the stamped PDF. May be the same as pdf_path for in-place editing; the original will be backed up on the first mutation." },
            page: { type: "integer", description: "Page number (1-indexed)" },
            x: { type: "number", description: "Left edge in points, TOP-LEFT origin" },
            y: { type: "number", description: "Top edge in points, TOP-LEFT origin" },
            width: { type: "number", description: "Width in points" },
            height: { type: "number", description: "Height in points" },
            text: { type: "string", description: "Text to stamp (max 200 chars)" },
            font_style: { type: "string", enum: ["normal", "italic"], description: "Font style (default: normal)" },
            allow_resign: { type: "boolean", description: "Proceed even if the PDF has existing cryptographic signatures (default: false — saving would invalidate them)" },
            force_xfa: { type: "boolean", description: "Proceed even if the PDF uses XFA forms (default: false — the XFA layer will be stripped)" },
            overwrite: {
              type: "boolean",
              description: "Deprecated compatibility field. true is accepted as a no-op when the destination does not exist or output_path identifies the same canonical document as pdf_path. It never authorizes replacing a distinct existing output; that requires expected_output_identity."
            },
            password: { type: "string", description: PDF_REPROTECTING_PASSWORD_DESCRIPTION },
            expected_output_identity: EXPECTED_OUTPUT_IDENTITY_INPUT_SCHEMA
          },
          required: ["pdf_path", "output_path", "page", "x", "y", "width", "height", "text"]
        },
        annotations: {
          title: "Apply Text",
          readOnlyHint: false,
          destructiveHint: true,
          idempotentHint: false,
          openWorldHint: false
        }
      },
      {
        name: "detect_signature_zones",
        description: "Find places in a PDF where a signature, initials, printed name, or date should go. Returns typed zones with top-left coordinates in points. Use this before apply_signature and never guess coordinates. Apply signatures and initials with apply_signature. Apply names and dates with apply_text. Detection uses AcroForm widgets and text labels such as 'Signature', 'Witness', 'Print Name', and 'Dated'. Encrypted PDFs use the authenticated PDF.js text layer and report that AcroForm widgets were not scanned. Any widget whose page cannot be resolved is skipped with a warning instead of being assigned a fabricated location.",
        inputSchema: {
          type: "object",
          properties: {
            pdf_path: { type: "string", description: "Path to the PDF file" },
            password: { type: "string", description: PDF_LIB_GEOMETRY_PASSWORD_DESCRIPTION }
          },
          required: ["pdf_path"]
        },
        annotations: {
          title: "Detect Signature Zones",
          readOnlyHint: true,
          destructiveHint: false,
          idempotentHint: true,
          openWorldHint: false
        }
      },
      {
        name: "fetch_pdf_from_url",
        description: "Download a PDF from any URL — the PREFERRED way to grab any PDF from a URL for the user. **Always use this for PDF URLs; do NOT use bash, curl, wget, or WebFetch first.** Those run in Claude's sandbox and fail on many domains (gov sites, enterprise, auth-required URLs); this tool runs on the user's machine with full network access and succeeds where they don't. Returns a local file path that plugs into every other PDF tool here (display_pdf, read_pdf_fields, fill_pdf, validate_pdf, detect_signature_zones, apply_signature, merge_pdfs, etc.). If the user mentions a PDF URL in any way — \"download this,\" \"open this link,\" \"sign this,\" \"fill out\" — this is your first move before any other tool.",
        inputSchema: {
          type: "object",
          properties: {
            url: {
              type: "string",
              description: "HTTP or HTTPS URL of a PDF to download"
            },
            filename: {
              type: "string",
              description: "Optional filename for the saved PDF (default: derived from the URL and sanitized; '.pdf' appended if missing)"
            },
            destination_dir: {
              type: "string",
              description: "Optional local directory to save into (default: ~/Downloads/). Must be a local path on the user's machine — NOT a Claude container path like /mnt/..."
            },
            overwrite: {
              type: "boolean",
              description: "Replace the named file only when its exact expected_output_identity is also supplied. Default: false, which appends ' (2)', ' (3)', etc."
            },
            expected_output_identity: EXPECTED_OUTPUT_IDENTITY_INPUT_SCHEMA,
            max_size_mb: {
              type: "number",
              description: "Maximum download size in MB (default: 100). Raise for larger PDFs."
            },
            headers: {
              type: "object",
              description: "Optional HTTP headers, e.g. { \"Authorization\": \"Bearer ...\" } for authenticated URLs.",
              additionalProperties: { type: "string" }
            },
            allow_private_hosts: {
              type: "boolean",
              description: "Allow downloads from localhost / private IP ranges. Default false for safety. Only enable for trusted intranet PDFs."
            }
          },
          required: ["url"]
        },
        annotations: {
          title: "Fetch PDF from URL",
          readOnlyHint: false,
          destructiveHint: true,
          idempotentHint: false,
          openWorldHint: true
        }
      },
      {
        name: "reveal_in_finder",
        description: "Open the OS file manager with the given file selected (macOS: Finder → Reveal; Windows: Explorer → select; Linux: opens the enclosing folder). Used by the viewer to surface the active PDF or its backup so the user can immediately see the relevant file.",
        inputSchema: {
          type: "object",
          properties: {
            path: { type: "string", description: "Absolute path to the file to reveal." }
          },
          required: ["path"]
        },
        annotations: {
          title: "Reveal File in Finder",
          readOnlyHint: false,
          destructiveHint: false,
          idempotentHint: false,
          openWorldHint: false
        }
      },
      ...LUMIN_SIGNING_TOOL_DEFINITIONS,
      ...VERIFIED_EXTRACTION_TOOL_DEFINITIONS,
    ].map(withToolOutputSchema),
  };
}

// Handle tool calls
async function handleToolCall(request) {
  const { name, arguments: args } = request.params;

  try {
    if (LUMIN_SIGNING_TOOL_NAME_SET.has(name)) {
      const structuredContent = await handleLuminSigningTool(name, args ?? {});
      const summary = formatLuminSigningToolText(name, structuredContent);
      return {
        content: [{ type: "text", text: summary }],
        structuredContent,
      };
    }
    if (VERIFIED_EXTRACTION_TOOL_NAMES.has(name)) {
      const structuredContent = await handleVerifiedExtractionTool(name, args ?? {});
      const summary = name === "create_extraction_workspace"
        ? `Created verified extraction workspace ${structuredContent.workspace_identity_sha256} at generation ${structuredContent.generation_sha256}.`
        : name === "verify_extraction_proposal"
          ? `Retained ${structuredContent.result.status} verification for ${structuredContent.result.leaf_pointer} at generation ${structuredContent.generation_sha256}.`
          : `${name} completed.`;
      return {
        content: [{ type: "text", text: summary }],
        structuredContent,
      };
    }
    switch (name) {
      case "list_pdfs": {
        const directory = resolvePath(args.directory || DEFAULT_PDF_DIRECTORY);
        // Every prompt template opens with this call, so a missing folder is the
        // first thing a user can hit on a fresh install. A raw ENOENT scandir
        // string is not something they can act on, and it is especially likely
        // where the platform has no ~/Documents at all.
        let files;
        try {
          files = await fs.readdir(directory);
        } catch (error) {
          if (error?.code === "ENOENT") {
            throw new Error(
              `No folder exists at ${directory}. `
              + `Tell me the folder your PDFs are actually in, `
              + `or change the default PDFs folder in this extension's settings.`,
            );
          }
          if (error?.code === "ENOTDIR") {
            throw new Error(`${directory} is a file, not a folder. Give me the folder that contains it.`);
          }
          if (error?.code === "EACCES" || error?.code === "EPERM") {
            throw new Error(`This computer refused access to ${directory}. Check the folder's permissions.`);
          }
          throw error;
        }
        const pdfFiles = files
          .filter(file => file.toLowerCase().endsWith('.pdf'))
          // readdir order is filesystem-dependent, so sort before any cap:
          // an unsorted truncation would show a different arbitrary subset on
          // each call. Plain codepoint comparison rather than localeCompare,
          // which is not a total order (it can return 0 for distinct strings)
          // and varies with the host Node's ICU build.
          .sort((left, right) => (left < right ? -1 : left > right ? 1 : 0))
          .map(file => path.join(directory, file));

        // Every prompt template opens by listing this directory, so an
        // uncapped listing is the first thing that happens in a conversation.
        // Measured against the previous unbounded format: 2,000 PDFs produced
        // about 153,000 characters, roughly 38,000 tokens, and 10,000 produced
        // about 768,000. A Documents folder holding years of scanned invoices
        // is exactly this product's user, so the entry point could consume a
        // whole context window before any work began.
        // An offset makes the cap a window rather than a ceiling. Without it a
        // flat folder of thousands of date-named scans would have its newest
        // files permanently unreachable, since the sort is ascending and
        // "narrow the directory" is impossible when they are all in one folder.
        // The SDK does not enforce inputSchema, so validate here. A numeric string
        // is coerced, because models stringify numbers routinely; anything else
        // is refused loudly rather than silently paging to zero, which would
        // return page one alongside an instruction to request page one again.
        const offset = parseListOffset(args.offset);
        const shown = pdfFiles.slice(offset, offset + LIST_PDFS_MAX_RESULTS);
        const remaining = pdfFiles.length - offset - shown.length;

        if (offset === 0 && remaining <= 0) {
          if (pdfFiles.length === 0) {
            // "Found 0 PDF files:" with a trailing colon and nothing after it
            // left a user with a misconfigured default unable to tell what was
            // searched.
            return {
              content: [
                {
                  type: "text",
                  text: `No PDF files in ${directory}. `
                    + `If your PDFs are somewhere else, tell me that folder.`
                }
              ],
            };
          }
          // Unchanged wording for the ordinary case, so nothing that reads this
          // output sees a difference on a normal folder.
          return {
            content: [
              {
                type: "text",
                text: `Found ${pdfFiles.length} PDF files:\n${pdfFiles.join('\n')}`
              }
            ],
          };
        }

        if (shown.length === 0) {
          return {
            content: [
              {
                type: "text",
                text: `Found ${pdfFiles.length} PDF files in ${directory}. `
                  + `Offset ${offset} is past the end of the list.`
              }
            ],
          };
        }

        const position = `${offset + 1} to ${offset + shown.length} of ${pdfFiles.length}`;
        const more = remaining > 0
          ? `To see the next ${Math.min(remaining, LIST_PDFS_MAX_RESULTS)}, call this tool again `
            + `with offset ${offset + shown.length}, or narrow the search with a more specific directory.`
          : `That is the end of the list.`;
        return {
          content: [
            {
              type: "text",
              text: `Found ${pdfFiles.length} PDF files in ${directory}. `
                + `Showing ${position}, sorted by name.\n${shown.join('\n')}\n\n`
                + `${more}`
            }
          ],
        };
      }

      case "read_pdf_fields": {
        const { pdf_path, password } = args;
        // Read-only: this never writes the PDF back, so it may decrypt.
        const { pdfDoc, resolvedPath, releaseDecryptedBytes } = await loadPdf(
          pdf_path,
          password,
          { decryptFor: "read_pdf_fields" },
        );
        noteDocumentOpened(resolvedPath);

        const form = pdfDoc.getForm();
        const fields = form.getFields();

        let fieldInfo;
        try {
          fieldInfo = fields.map(field => {
          const name = field.getName();
          let type = "unknown";
          let options = [];
          let currentValue = "";

          try {
            if (field.constructor.name.includes('TextField')) {
              type = "text";
              currentValue = field.getText() || "";
            } else if (field.constructor.name.includes('CheckBox')) {
              type = "checkbox";
              currentValue = field.isChecked();
            } else if (field.constructor.name.includes('RadioGroup')) {
              type = "radio";
              currentValue = field.getSelected() || "";
            } else if (field.constructor.name.includes('Dropdown')) {
              type = "dropdown";
              options = field.getOptions();
              currentValue = field.getSelected() || "";
            }
          } catch (e) {
            // Field type detection failed
          }
          
          return { name, type, options, currentValue };
          });
        } finally {
          // Every value has been copied out of the document, so any decrypted
          // plaintext can go now rather than at the end of the response build.
          releaseDecryptedBytes();
        }

        const payload = await buildActiveDocumentPayload(resolvedPath, 1, {
          fields: fieldInfo,
          fieldCount: fields.length,
          hasFormFields: fields.length > 0,
        });
        return {
          content: [
            {
              type: "text",
              // "0 form fields" reads as "this document has no form", which is
              // often false: a questionnaire can be visibly full of blanks that
              // were flattened into page content, or built with a form
              // technology this parser does not enumerate. We measured AcroForm
              // fields, so say AcroForm, and say what that does not rule out.
              text: fields.length === 0
                ? "This PDF has no AcroForm fields. That is not the same as having no form: visible blanks may have been flattened into the page, or built with a form technology this parser does not enumerate. Use read_pdf_content or the viewer to inspect what is actually on the page."
                : `PDF has ${fields.length} AcroForm fields:\n${JSON.stringify(fieldInfo, null, 2)}`
            }
          ],
          structuredContent: payload,
          _meta: {
            ui: { resourceUri: "ui://pdf-toolkit/viewer" },
            viewUUID: `pdf-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
            ...payload,
          }
        };
      }

      case "fill_pdf": {
        const {
          pdf_path,
          output_path,
          field_data,
          password,
          force_xfa = false,
          expected_output_identity,
        } = args;
        const resolvedPdfPath = resolvePath(pdf_path);
        const resolvedOutputPath = resolvePath(output_path);
        const recoveredInput = await readPdfInputWithRecovery(resolvedPdfPath);
        const {
          pdfBytes: rawPdfBytes,
          inputRecoveryBinding,
        } = recoveredInput;
        assertXfaMutationAllowed(rawPdfBytes, { forceXfa: force_xfa });
        const { payload, backupPath, filledFields, errors } = await runPdfLibMutation({
          operation: "fill_pdf",
          sources: [bindRecoveredMutationSource(recoveredInput)],
          password,
          force_xfa: force_xfa === true,
          options: { field_data },
        }, async ({ result, outputs, atomicTransition }) => {
          const filledFields = result.filledFields;
          const errors = result.errors;
          const committed = await persistPdfMutation({
            mutationOutput: { ...outputs[0], atomicTransition },
            formInfo: result.form_info,
            inputPath: resolvedPdfPath,
            outputPath: resolvedOutputPath,
            toolName: "fill_pdf",
            expectedInputSha256: sha256Bytes(rawPdfBytes),
            expectedOutputIdentity: normalizeExpectedOutputIdentity(expected_output_identity),
            inputRecoveryBinding,
            extraPayload: { filled_fields: filledFields, fill_errors: errors },
          });
          return { ...committed, filledFields, errors };
        });
        
        let message = `PDF filled successfully and saved to: ${output_path}\n`;
        message += `Fields filled: ${filledFields.length}`;
        if (backupPath) {
          message += `\nOriginal backed up to: ${backupPath}`;
        }
        if (errors.length > 0) {
          message += `\nErrors:\n${errors.join('\n')}`;
        }
        
        return {
          content: [{
            type: "text",
            text: message
          }],
          structuredContent: payload,
        };
      }

      case "bulk_fill_from_csv": {
        const {
          pdf_path,
          csv_path,
          output_directory,
          filename_column,
          password,
          force_xfa = false,
          expected_output_identities,
        } = args;
        const resolvedPdfPath = resolvePath(pdf_path);
        const resolvedCsvPath = resolvePath(csv_path);
        const resolvedOutputDir = resolvePath(output_directory);
        const expectedOutputIdentities = normalizeExpectedOutputIdentities(
          expected_output_identities,
        );
        const recoveredInput = await readPdfInputWithRecovery(resolvedPdfPath);
        const {
          pdfBytes: rawPdfBytes,
          fileIdentity: templateFileIdentity,
        } = recoveredInput;
        assertXfaMutationAllowed(rawPdfBytes, { forceXfa: force_xfa });
        
        // Read CSV
        const csvStats = await fs.lstat(resolvedCsvPath, { bigint: true });
        if (!csvStats.isFile() || csvStats.isSymbolicLink()) {
          throw new Error("csv_path must identify a regular file.");
        }
        const csvFileIdentity = {
          device: String(csvStats.dev),
          inode: String(csvStats.ino),
        };
        const csvContent = await fs.readFile(resolvedCsvPath, 'utf8');
        const records = parseCSV(csvContent);
        
        // Ensure output directory exists
        await fs.mkdir(resolvedOutputDir, { recursive: true });
        
        const pendingOutputs = [];
        const outputPaths = new Set();
        for (let i = 0; i < records.length; i++) {
          const record = records[i];
          let rawName = filename_column && record[filename_column]
            ? record[filename_column]
            : `filled_${i + 1}`;
          // Sanitize filename to prevent path traversal
          rawName = path.basename(rawName).replace(/[/\\]/g, "_");
          const filename = `${rawName}.pdf`;
          const outputPath = path.join(resolvedOutputDir, filename);
          if (outputPaths.has(outputPath)) {
            throw new Error(`Bulk fill produced duplicate filename "${filename}". Use unique values in filename_column.`);
          }
          outputPaths.add(outputPath);

          pendingOutputs.push({ targetPath: outputPath, filename });
        }

        bindExpectedOutputIdentityManifest(
          pendingOutputs,
          expectedOutputIdentities,
        );
        const results = await runPdfLibMutation({
          operation: "bulk_fill_from_csv",
          sources: [bindRecoveredMutationSource(recoveredInput)],
          password,
          force_xfa: force_xfa === true,
          options: { records },
        }, async ({ result, outputs, atomicTransition }) => {
          if (outputs.length !== pendingOutputs.length || result.rows.length !== pendingOutputs.length) {
            throw new Error("Bulk fill worker returned an incomplete batch.");
          }
          if (pendingOutputs.length === 0) return [];
          const atomicEntries = pendingOutputs.map((entry, index) => ({
            ...entry,
            produceBytes: outputs[index].readBytes,
          }));
          const committedOutputs = await writePdfOutputsAtomic(atomicEntries, {
              onTransition: atomicTransition,
              assertPathAllowed,
              validateInitialTargets: rejectOutputAliasesToProtectedInputs([
                templateFileIdentity,
                csvFileIdentity,
              ]),
          });
          return committedOutputs.map((committed, index) => ({
            filename: pendingOutputs[index].filename,
            output_path: committed.targetPath,
            fields_filled: result.rows[index].filledFields.length,
            errors: result.rows[index].errors,
            status: result.rows[index].errors.length > 0 ? "warning" : "ok",
          }));
        });

        const resultLines = results.map(result => {
          const marker = result.status === "error" ? "✗" : result.status === "warning" ? "!" : "✓";
          const suffix = result.errors.length > 0 ? ` (${result.errors.length} warnings/errors)` : "";
          return `${marker} ${result.filename}: ${result.fields_filled} fields filled${suffix}`;
        });
        
        return {
          content: [{
            type: "text",
            text: `Bulk fill complete!\n${resultLines.join('\n')}`
          }],
          structuredContent: {
            row_count: records.length,
            results,
            preview_records: records.slice(0, 3),
          },
        };
      }

      case "save_profile": {
        const { profile_name, field_data } = args;
        validateProfileName(profile_name);
        const profilePath = path.join(PROFILES_DIR, `${profile_name}.json`);
        
        await fs.writeFile(profilePath, JSON.stringify(field_data, null, 2));
        
        return {
          content: [{
            type: "text",
            text: `Profile '${profile_name}' saved successfully!`
          }],
        };
      }

      case "load_profile": {
        const { profile_name } = args;
        validateProfileName(profile_name);
        const profilePath = path.join(PROFILES_DIR, `${profile_name}.json`);
        
        const profileData = await fs.readFile(profilePath, 'utf8');
        
        return {
          content: [{
            type: "text",
            text: `Profile '${profile_name}' loaded:\n${profileData}`
          }],
        };
      }

      case "list_profiles": {
        const files = await fs.readdir(PROFILES_DIR);
        const profiles = files
          .filter(file => file.endsWith('.json'))
          .map(file => file.replace('.json', ''));
        
        return {
          content: [{
            type: "text",
            text: profiles.length > 0 
              ? `Available profiles:\n${profiles.join('\n')}`
              : "No profiles saved yet"
          }],
        };
      }

      case "fill_with_profile": {
        const {
          pdf_path,
          output_path,
          profile_name,
          additional_data = {},
          password,
          expected_output_identity,
        } = args;
        validateProfileName(profile_name);
        const resolvedPdfPath = resolvePath(pdf_path);
        const resolvedOutputPath = resolvePath(output_path);

        // Load profile
        const profilePath = path.join(PROFILES_DIR, `${profile_name}.json`);
        const profileData = JSON.parse(await fs.readFile(profilePath, 'utf8'));
        
        // Merge profile data with additional data
        const mergedData = { ...profileData, ...additional_data };
        const recoveredInput = await readPdfInputWithRecovery(resolvedPdfPath);
        const { pdfBytes: rawPdfBytes, inputRecoveryBinding } = recoveredInput;
        const { payload, backupPath, filledFields } = await runPdfLibMutation({
          operation: "fill_with_profile",
          sources: [bindRecoveredMutationSource(recoveredInput)],
          password,
          options: { field_data: mergedData },
        }, async ({ result, outputs, atomicTransition }) => {
          const committed = await persistPdfMutation({
            mutationOutput: { ...outputs[0], atomicTransition },
            formInfo: result.form_info,
            inputPath: resolvedPdfPath,
            outputPath: resolvedOutputPath,
            toolName: "fill_with_profile",
            expectedInputSha256: sha256Bytes(rawPdfBytes),
            expectedOutputIdentity: normalizeExpectedOutputIdentity(expected_output_identity),
            inputRecoveryBinding,
            extraPayload: {
              profile_name,
              filled_fields: result.filledFields,
              fill_errors: result.errors,
            },
          });
          return { ...committed, filledFields: result.filledFields };
        });
        
        return {
          content: [{
            type: "text",
            text:
              `PDF filled with profile '${profile_name}' and saved to: ${output_path}\nFields filled: ${filledFields.length}` +
              (backupPath ? `\nOriginal backed up to: ${backupPath}` : "")
          }],
          structuredContent: payload,
        };
      }

      case "extract_to_csv": {
        const { pdf_paths, output_csv } = args;
        const resolvedOutputCsv = resolvePath(output_csv);
        const allData = [];
        const allFieldNames = new Set();
        
        // Extract data from each PDF
        for (const pdfPath of pdf_paths) {
          const resolvedPdfPath = resolvePath(pdfPath);
          const pdfBytes = await fs.readFile(resolvedPdfPath);
          // Read-only: this writes a CSV, never a PDF, so it may decrypt. The
          // tool takes a list of documents and no password — one password
          // could not serve a list — so the only encrypted documents it can
          // read are those that open without one and whose own permissions
          // allow extraction. Anything else is refused by name.
          const { pdfDoc, releaseDecryptedBytes } = await loadPdfBytes(pdfBytes, null, {
            decryptFor: "extract_to_csv",
          });
          const form = pdfDoc.getForm();
          const fields = form.getFields();

          const rowData = { _filename: path.basename(pdfPath) };

          try {
            for (const field of fields) {
              const fieldName = field.getName();
              allFieldNames.add(fieldName);

              try {
                if (field.constructor.name.includes('TextField')) {
                  rowData[fieldName] = field.getText() || "";
                } else if (field.constructor.name.includes('CheckBox')) {
                  rowData[fieldName] = field.isChecked() ? "yes" : "no";
                } else if (field.constructor.name.includes('RadioGroup') ||
                           field.constructor.name.includes('Dropdown')) {
                  rowData[fieldName] = field.getSelected() || "";
                }
              } catch (e) {
                rowData[fieldName] = "";
              }
            }
          } finally {
            // Released per document, so a long list never holds more than one
            // decrypted document in memory at a time.
            releaseDecryptedBytes();
          }

          allData.push(rowData);
        }
        
        // Create CSV
        const headers = ['_filename', ...Array.from(allFieldNames).sort()];
        const csvLines = [headers.map(formatCSVValue).join(',')];
        
        for (const row of allData) {
          const values = headers.map(h => row[h] || "");
          csvLines.push(values.map(formatCSVValue).join(','));
        }
        
        await fs.writeFile(resolvedOutputCsv, csvLines.join('\n'));
        
        return {
          content: [{
            type: "text",
            text: `Extracted data from ${pdf_paths.length} PDFs to: ${output_csv}\nFields extracted: ${allFieldNames.size}\nPreview rows returned in structuredContent.`
          }],
          structuredContent: {
            output_csv: resolvedOutputCsv,
            source_pdf_count: pdf_paths.length,
            field_count: allFieldNames.size,
            row_count: allData.length,
            preview_row_count: Math.min(allData.length, 3),
            headers,
            preview_rows: allData.slice(0, 3),
          },
        };
      }

      case "validate_pdf": {
        const { pdf_path, password } = args;
        let resolvedPath = null;
        try {
          // Read-only: this never writes the PDF back, so it may decrypt.
          const loaded = await loadPdf(pdf_path, password, { decryptFor: "validate_pdf" });
          resolvedPath = loaded.resolvedPath;
          let validation;
          try {
            const fields = loaded.pdfDoc.getForm().getFields();
            validation = validatePdfFormFields(fields, {
              pdfPath: resolvedPath,
              fileName: path.basename(resolvedPath),
            });
          } finally {
            // The report is fully materialized above; nothing below reads the
            // document again, so any decrypted plaintext can go now.
            loaded.releaseDecryptedBytes();
          }

          const requiredSummary = validation.required_fields_complete === null
            ? "UNKNOWN"
            : validation.required_fields_complete
              ? "YES"
              : "NO";
          const allFieldsSummary = validation.all_value_fields_filled === null
            ? "UNKNOWN"
            : validation.all_value_fields_filled
              ? "YES"
              : "NO";
          const message = [
            `PDF Field Validation Report for: ${validation.file_name}`,
            `Field coverage status: ${validation.validation_status.toUpperCase()}`,
            `Required-field status: ${validation.required_field_validation_status.toUpperCase()}`,
            `Required fields complete: ${requiredSummary}`,
            `All value fields filled: ${allFieldsSummary}`,
            `Total fields: ${validation.total_field_count}`,
            `Observed values: ${validation.observed_count}`,
            `Empty values: ${validation.empty_count}`,
            `Unchecked boxes: ${validation.unchecked_count}`,
            `Unknown/read errors: ${validation.unknown_count + validation.read_error_count}`,
            `PDF-required fields: ${validation.required_field_count}`,
            `Missing PDF-required fields: ${validation.missing_required_count}`,
            "",
            validation.can_claim_required_fields_complete
              ? "Safe claim: all fields marked Required by the PDF are complete."
              : "Safe claim unavailable: do not claim that required fields are complete.",
            "This does not prove the form is valid or ready to submit.",
          ];
          if (validation.missing_required_fields.length > 0) {
            message.push("", "Missing PDF-required fields:", ...validation.missing_required_fields.slice(0, 10));
            if (validation.missing_required_fields.length > 10) {
              message.push(`... and ${validation.missing_required_fields.length - 10} more`);
            }
          }
          const unresolvedFields = validation.fields.filter(
            field => ["empty", "unchecked", "unknown", "read_error"].includes(field.value_status),
          );
          if (unresolvedFields.length > 0) {
            message.push(
              "",
              "Unresolved field coverage:",
              ...unresolvedFields.slice(0, 10).map(field => `${field.name} [${field.value_status}]`),
            );
            if (unresolvedFields.length > 10) {
              message.push(`... and ${unresolvedFields.length - 10} more`);
            }
          }
          if (validation.heuristic_required_candidates.length > 0) {
            message.push(
              "",
              `Advisory name-based required hints (not counted as Required): ${validation.heuristic_required_candidates.length}`,
            );
          }
          message.push("", `Limitations: ${validation.limitations.join(" ")}`);

          return {
            content: [{ type: "text", text: message.join("\n") }],
            structuredContent: validation,
          };
        } catch (error) {
          const validation = failedPdfFormValidation({
            pdfPath: resolvedPath,
            fileName: path.basename(String(pdf_path || "unknown.pdf")),
          });
          // "Verify the path/password and retry" is useless advice when the
          // reason is already known and actionable: a password the document
          // rejected, or permissions that deny the read. Those messages are
          // fixed strings built here, never QPDF output, so passing them
          // through leaks nothing.
          const reason = error instanceof PdfDecryptionError
            || error?.message === PDF_LIB_ENCRYPTED_MESSAGE
            ? error.message
            : null;
          return {
            content: [{
              type: "text",
              text: reason
                ? `Error: PDF field validation failed for ${validation.file_name}. ${reason}`
                : `Error: PDF field validation failed for ${validation.file_name}. `
                  + "Do not interpret this as an empty or complete form. Verify the path/password and retry.",
            }],
            structuredContent: validation,
            isError: true,
          };
        }
      }

      case "read_pdf_content": {
        const { pdf_path, max_pages = null } = args;
        const resolvedPath = resolvePath(pdf_path);
        const MAX_CHARS = 50000;
        let readPagesWithoutText = [];
        let pagesWithSuspectedTextIntegrity = [];
        let readPagesWithInvisibleText = [];
        let readPagesWithUnavailableTextVisibility = [];
        let readPagesReadCount = 0;
        let readPageReadError = null;

        try {
          const { result, source } = await runPdfjsOperation(resolvedPath, {
            operation: "read_content",
            options: {
              max_pages: max_pages === undefined || max_pages === null
                ? null
                : Number(max_pages),
            },
          });
          const fileName = path.basename(resolvedPath);
          const fileSizeKB = (source.size_bytes / 1024).toFixed(2);
          const textFound = result.text_found;
          const extractedText = result.output_text;
          const pageCount = result.total_pages;
          const pagesRead = result.pages_read;
          const pagesWithoutText = result.pages_without_text ?? [];
          const pagesWithIntegrity = result.pages_with_suspected_text_integrity ?? [];
          const pagesWithInvisibleText = result.pages_with_invisible_text ?? [];
          const pagesWithUnavailableTextVisibility = result.pages_with_unavailable_text_visibility ?? [];
          readPagesWithInvisibleText = pagesWithInvisibleText;
          readPagesWithUnavailableTextVisibility = pagesWithUnavailableTextVisibility;
          readPagesWithoutText = pagesWithoutText;
          pagesWithSuspectedTextIntegrity = pagesWithIntegrity;
          const pageReadError = result.page_read_error ?? null;
          readPagesReadCount = Number.isInteger(pagesRead) ? pagesRead : 0;
          readPageReadError = pageReadError;
          const pageReadErrorCodes = pageReadError ? [pageReadError.code] : [];
          const routingGuidance = pagesWithoutText.length > 0 || pagesWithIntegrity.length > 0
            || pagesWithInvisibleText.length > 0 || pagesWithUnavailableTextVisibility.length > 0
            ? READ_CONTENT_ROUTING_GUIDANCE
            : null;

          // Prepare the response
          let response = `PDF text layer read. Visual correspondence has not been verified.\n\n`;
          response += `File: ${fileName}\n`;
          response += `Size: ${fileSizeKB} KB\n`;
          response += `Pages: ${pageCount}`;
          if (pagesRead < pageCount) {
            response += ` (extracted ${pagesRead} of ${pageCount})`;
          }
          response += `\n`;
          response += `Text Length: ${result.source_length} characters\n`;
          if (routingGuidance) response += `Routing guidance: ${routingGuidance}\n`;

          // Truncate if too large for context window
          const truncated = result.text_truncated;
          if (truncated) {
            response += `\n⚠️ Output truncated to ${MAX_CHARS} characters. Use max_pages to limit extraction scope.\n`;
          }

          response += `\n${"=".repeat(50)}\n`;
          response += `EXTRACTED TEXT:\n`;
          response += `${"=".repeat(50)}\n\n`;
          response += extractedText;

          if (truncated) {
            response += `\n\n... [TRUNCATED — ${MAX_CHARS} char limit reached] ...`;
          }

          // Check if text was extracted
          if (!textFound) {
            // No PDF.js text-layer text found; render page 1 for host/model visual inspection.
            try {
              response = `No text was found in the PDF.js text layer.\n`;
              response += `Rendering page 1 as an image for host/model visual inspection...\n\n`;
              response += `File: ${fileName}\n`;
              response += `Size: ${fileSizeKB} KB\n`;
              response += `Pages: ${pageCount}\n`;
              
              // Calculate scale to keep image size reasonable
              // Target ~500KB after base64 encoding (roughly 375KB raw)
              const targetSizeKB = 375;
              const scaleFactor = Math.min(1.5, Math.sqrt(targetSizeKB / parseFloat(fileSizeKB)));
              
              // Convert first page to image
              const { result: renderedImage } = await runPdfjsOperation(resolvedPath, {
                operation: "render_page",
                options: {
                  page: 1,
                  max_dimension_px: null,
                  renderer_policy: pdfjsRendererPolicy(),
                  scale_override: scaleFactor,
                },
              });
              const imageBuffer = renderedImage.binary;
              const imageSizeKB = (imageBuffer.length / 1024).toFixed(2);
              
              response += `\nPage 1 extracted as image (${imageSizeKB} KB, scale: ${scaleFactor.toFixed(2)})\n`;
              
              // Return as image content
              return {
                content: [{
                  type: "text",
                  text: response
                }, {
                  type: "image",
                  data: imageBuffer.toString("base64"),
                  mimeType: "image/png"
                }],
                structuredContent: {
                  pdf_path: resolvedPath,
                  file_name: fileName,
                  total_pages: pageCount,
                  pages_read: pagesRead,
                  text_length: 0,
                  text_truncated: false,
                  text_found: textFound,
                  content_available: true,
                  extraction_status: "partial",
                  page_previews: result.page_previews,
                  preview_truncated: result.preview_truncated,
                  extraction_mode: "image-fallback",
                  image_renderer: renderedImage.renderer,
                  page_read_error: pageReadError,
                  read_pages_without_text: pagesWithoutText,
                  pages_with_suspected_text_integrity: pagesWithIntegrity,
                  pages_with_invisible_text: pagesWithInvisibleText,
                  pages_with_unavailable_text_visibility: pagesWithUnavailableTextVisibility,
                  routing_guidance: routingGuidance,
                  error_codes: pageReadErrorCodes,
                  retry_guidance:
                    "Only page 1 was returned as an image. Use render_pdf_page for any additional pages that require inspection.",
                },
              };
            } catch (imageError) {
              if (imageError?.code === PDF_RESOURCE_LIMIT_CODE) {
                // Preserve already-computed read provenance instead of losing
                // it to the bare shared resource-limit shape.
                return createTypedToolError({
                  message: `Error: ${imageError.message}`,
                  code: PDF_RESOURCE_LIMIT_CODE,
                  structuredContent: {
                    status: "failed",
                    error: { error_schema_version: 1, code: PDF_RESOURCE_LIMIT_CODE },
                    pages_read: readPagesReadCount,
                    read_pages_without_text: readPagesWithoutText,
                    pages_with_suspected_text_integrity: pagesWithSuspectedTextIntegrity,
                    pages_with_invisible_text: readPagesWithInvisibleText,
                    pages_with_unavailable_text_visibility: readPagesWithUnavailableTextVisibility,
                    page_read_error: readPageReadError,
                  },
                });
              }
              console.error("[read_pdf_content] Image fallback failed:", imageError.message);
              response = `Error: PDF content extraction failed: no text was found and the page-image fallback was unavailable.\n`;
              response += `Do not assume this PDF is empty or complete. Check PDF access/password, retry, and use render_pdf_page to diagnose page 1 before relying on the document contents.\n`;
              return createTypedToolError({
                message: response,
                content: [{
                  type: "text",
                  text: response,
                }],
                structuredContent: {
                  pdf_path: resolvedPath,
                  file_name: fileName,
                  total_pages: pageCount,
                  pages_read: pagesRead,
                  text_length: result.source_length,
                  text_truncated: false,
                  text_found: textFound,
                  content_available: false,
                  extraction_status: "failed",
                  page_previews: result.page_previews,
                  preview_truncated: result.preview_truncated,
                  extraction_mode: "none",
                  page_read_error: pageReadError,
                  read_pages_without_text: pagesWithoutText,
                  pages_with_suspected_text_integrity: pagesWithIntegrity,
                  pages_with_invisible_text: pagesWithInvisibleText,
                  pages_with_unavailable_text_visibility: pagesWithUnavailableTextVisibility,
                  routing_guidance: routingGuidance,
                  error_codes: ["NO_EXTRACTABLE_TEXT", "IMAGE_FALLBACK_FAILED", ...pageReadErrorCodes],
                  retry_guidance:
                    "Do not treat this PDF as empty. Check PDF access/password and renderer availability, then retry read_pdf_content or render_pdf_page.",
                },
              });
            }
          }

          const extractionPartial = truncated || pagesRead < pageCount;
          
          return {
            content: [{
              type: "text",
              text: response
            }],
            structuredContent: {
              pdf_path: resolvedPath,
              file_name: fileName,
              total_pages: pageCount,
              pages_read: pagesRead,
              text_length: result.source_length,
              text_truncated: truncated,
              text_found: textFound,
              content_available: textFound,
              extraction_status: extractionPartial ? "partial" : "complete",
              page_previews: result.page_previews,
              preview_truncated: result.preview_truncated,
              extraction_mode: "text",
              page_read_error: pageReadError,
              read_pages_without_text: pagesWithoutText,
              pages_with_suspected_text_integrity: pagesWithIntegrity,
              pages_with_invisible_text: pagesWithInvisibleText,
              pages_with_unavailable_text_visibility: pagesWithUnavailableTextVisibility,
              routing_guidance: routingGuidance,
              error_codes: pageReadErrorCodes,
              retry_guidance: extractionPartial
                ? "Use max_pages or page-bounded tools to retrieve content outside this partial result."
                : null,
            },
          };
        } catch (error) {
          if (error?.code === PDF_RESOURCE_LIMIT_CODE) {
            return createTypedToolError({
              message: `Error: ${error.message}`,
              code: PDF_RESOURCE_LIMIT_CODE,
              structuredContent: {
                status: "failed",
                error: { error_schema_version: 1, code: PDF_RESOURCE_LIMIT_CODE },
                pages_read: readPagesReadCount,
                read_pages_without_text: readPagesWithoutText,
                pages_with_suspected_text_integrity: pagesWithSuspectedTextIntegrity,
                pages_with_invisible_text: readPagesWithInvisibleText,
                pages_with_unavailable_text_visibility: readPagesWithUnavailableTextVisibility,
                page_read_error: readPageReadError,
              },
            });
          }
          error = passwordlessReadError(error);
          return createTypedToolError({
            message: `Error reading PDF file: ${error.message}`,
            content: [{
              type: "text",
              text: `Error reading PDF file: ${error.message}\n\nPlease ensure the file path is correct and the file exists.`
            }],
            structuredContent: {
              status: "failed",
              error: {
                error_schema_version: 1,
                code: "tool_execution_failed",
              },
              pages_read: readPagesReadCount,
              read_pages_without_text: readPagesWithoutText,
              pages_with_suspected_text_integrity: pagesWithSuspectedTextIntegrity,
              pages_with_invisible_text: readPagesWithInvisibleText,
              pages_with_unavailable_text_visibility: readPagesWithUnavailableTextVisibility,
              page_read_error: readPageReadError,
            },
          });
        }
      }

      case "read_pdf_pages": {
        const {
          pdf_path,
          start_page = 1,
          end_page = start_page || 1,
          max_chars_per_page = 4000,
        } = args;
        const resolvedPath = resolvePath(pdf_path);

        try {
          const requestedStart = Math.max(1, Number(start_page) || 1);
          const requestedEnd = Math.max(requestedStart, Number(end_page) || requestedStart);
          const { result, source } = await runPdfjsOperation(resolvedPath, {
            operation: "read_pages",
            options: {
              start_page: requestedStart,
              end_page: requestedEnd,
              max_chars_per_page: Number(max_chars_per_page) || 4000,
            },
          });
          const fileName = path.basename(resolvedPath);
          const fileSizeKB = (source.size_bytes / 1024).toFixed(2);

          let response =
            `Read pages ${requestedStart}-${requestedEnd} from ${fileName}\n` +
            `Size: ${fileSizeKB} KB\n` +
            `Document pages: ${result.total_pages}\n` +
            `Returned pages: ${result.pages.length}\n`;

          if (result.truncated) {
            response += `\nSome page text was truncated to keep the result bounded. Use a narrower page range if you need more detail.\n`;
          }

          const nonEmptyPages = result.pages.filter(page => page.text.trim().length > 0);
          if (nonEmptyPages.length === 0) {
            response += `\nNo extractable text was found on the requested pages. The document may be scanned or image-only.`;
          } else {
            response += `\n`;
            for (const page of result.pages) {
              response += `\n${"=".repeat(20)} PAGE ${page.page} ${"=".repeat(20)}\n`;
              response += page.text || "[No extractable text]";
              if (page.truncated) {
                response += `\n\n...[PAGE ${page.page} TRUNCATED]...`;
              }
              response += `\n`;
            }
          }

          return {
            content: [{
              type: "text",
              text: response.trimEnd(),
            }],
            structuredContent: {
              pdf_path: resolvedPath,
              file_name: fileName,
              total_pages: result.total_pages,
              start_page: requestedStart,
              end_page: requestedEnd,
              pages: result.pages,
              text_found: nonEmptyPages.length > 0,
              truncated: result.truncated,
            },
          };
        } catch (error) {
          if (error?.code === PDF_RESOURCE_LIMIT_CODE) throw error;
          error = passwordlessReadError(error);
          return createTypedToolError({
            message: `Error reading PDF pages: ${error.message}\n\nPlease ensure the file path is correct and the requested page range is valid.`,
          });
        }
      }

      case "read_pdf_layout": {
        const { pdf_path, password = null } = args;
        const resolvedPath = resolvePath(pdf_path);
        try {
          const startPage = boundedInteger(args.start_page, 1, { name: "start_page", minimum: 1, maximum: 1000000 });
          const endPage = boundedInteger(args.end_page, startPage, { name: "end_page", minimum: 1, maximum: 1000000 });
          if (endPage < startPage) throw new Error("end_page must be greater than or equal to start_page.");
          if (endPage - startPage + 1 > 10) throw new Error("read_pdf_layout accepts at most 10 pages per call. Request a narrower range.");
          const maxItems = boundedInteger(args.max_items, 1000, { name: "max_items", minimum: 1, maximum: 5000 });
          const maxCharacters = boundedInteger(args.max_characters, 50000, { name: "max_characters", minimum: 1, maximum: 100000 });
          const maxOutputCharacters = boundedInteger(args.max_output_characters, 50000, { name: "max_output_characters", minimum: 20000, maximum: 200000 });
          const fileName = path.basename(resolvedPath);
          const { result } = await runPdfjsOperation(resolvedPath, {
            operation: "extract_layout",
            password,
            options: {
              source_path: resolvedPath,
              source_file_name: fileName,
              start_page: startPage,
              end_page: endPage,
              max_items: maxItems,
              max_characters: maxCharacters,
              max_output_characters: maxOutputCharacters,
            },
          });
          const payload = result.layout;
          const summary = [
            `Extracted PDF layout IR ${payload.ir.version} from pages ${payload.page_range.start_page}-${payload.page_range.end_page} of ${fileName}.`,
            `Status: ${payload.extraction_status}. Parser: ${payload.parser.name} ${payload.parser.version}.`,
            `Source SHA-256: ${payload.source.sha256}.`,
            ...payload.pages.map(page => {
              const preview = page.flow_text.replace(/\s+/g, " ").trim().slice(0, 120);
              return `Page ${page.page}: ${page.extraction_status}; text=${page.text_layer_status}; modality=${page.modality_hint}; ${page.counts.returned_items}/${page.counts.observed_items} items; order=${page.reading_order.strategy}; preview=${preview || "[none]"}`;
            }),
            ...(payload.truncation.truncated
              ? [`Truncated: ${payload.truncation.reasons.join(", ")}. Omitted ${payload.truncation.omitted_items} items and ${payload.truncation.omitted_characters} characters.`]
              : []),
            "Coordinates use the PDF.js top-left display viewport in physical 1/72-inch points after UserUnit and are not interchangeable with render_pdf_region or signing coordinates. Text-run quads are advance boxes, not glyph ink bounds. No rendering, OCR, table inference, or arbitrary schema extraction was performed.",
          ].join("\n");
          return {
            content: [{ type: "text", text: summary }],
            structuredContent: payload,
          };
        } catch (error) {
          if (error?.code === PDF_RESOURCE_LIMIT_CODE) throw error;
          const passwordCode = ["PASSWORD_REQUIRED", "PASSWORD_INCORRECT"].includes(error?.code)
            ? error.code
            : null;
          const message = `Error reading PDF layout: ${error.message}\n\nUse a valid local PDF up to 250 MiB, a page range of at most 10 pages, and narrower limits if the document is large.`;
          return passwordCode
            ? createTypedToolError({ message, code: passwordCode })
            : createTypedToolError({ message });
        }
      }

      case "convert_pdf_to_markdown": {
        const markdownArgs = requireArgumentObject(args, "convert_pdf_to_markdown");
        const allowedArguments = new Set([
          "pdf_path",
          "password",
          "start_page",
          "end_page",
          "max_items",
          "max_characters",
          "max_markdown_bytes",
          "include_page_boundaries",
          "compact",
          "remove_page_furniture",
          "emit_table_proposals",
          "output_path",
          "overwrite",
          "expected_output_identity",
        ]);
        const unknownArgument = Object.keys(markdownArgs).find(name => !allowedArguments.has(name));
        if (unknownArgument) throw new Error(`Unknown convert_pdf_to_markdown argument: ${unknownArgument}.`);
        const pdf_path = requireStringArgument(markdownArgs.pdf_path, "pdf_path", { maxLength: 32768 });
        const password = optionalStringArgument(markdownArgs.password, "password", { maxLength: 4096 });
        const outputPathArgument = optionalStringArgument(markdownArgs.output_path, "output_path", { maxLength: 32768 });
        const includePageBoundaries = optionalBooleanArgument(markdownArgs.include_page_boundaries, "include_page_boundaries", true);
        const compact = optionalBooleanArgument(markdownArgs.compact, "compact", false);
        const removePageFurniture = optionalBooleanArgument(
          markdownArgs.remove_page_furniture,
          "remove_page_furniture",
          true,
        );
        const emitTableProposals = optionalBooleanArgument(markdownArgs.emit_table_proposals, "emit_table_proposals", false);
        const overwrite = optionalBooleanArgument(markdownArgs.overwrite, "overwrite", false);
        const expectedOutputIdentity = normalizeExpectedOutputIdentity(
          markdownArgs.expected_output_identity,
        );
        if (overwrite !== (expectedOutputIdentity !== null)) {
          throw new Error(
            "OUTPUT_IDENTITY_REQUIRED: overwrite=true requires the exact current expected_output_identity, and an expected identity requires overwrite=true.",
          );
        }
        if (!path.isAbsolute(expandUserPath(pdf_path))) {
          throw new Error("pdf_path must be an absolute path or begin with ~/.");
        }
        if (outputPathArgument !== null && !path.isAbsolute(expandUserPath(outputPathArgument))) {
          throw new Error("output_path must be an absolute path or begin with ~/.");
        }
        const resolvedPath = resolvePath(pdf_path);
        try {
          const startPage = boundedInteger(markdownArgs.start_page, 1, { name: "start_page", minimum: 1, maximum: 1000000 });
          const endPage = boundedInteger(markdownArgs.end_page, startPage, { name: "end_page", minimum: 1, maximum: 1000000 });
          if (endPage < startPage) throw new Error("end_page must be greater than or equal to start_page.");
          if (endPage - startPage + 1 > 10) throw new Error("convert_pdf_to_markdown accepts at most 10 pages per call. Request a narrower range.");
          const maxItems = boundedInteger(markdownArgs.max_items, 1000, { name: "max_items", minimum: 1, maximum: 5000 });
          const maxCharacters = boundedInteger(markdownArgs.max_characters, 50000, { name: "max_characters", minimum: 1, maximum: 100000 });
          const maxMarkdownBytes = boundedInteger(markdownArgs.max_markdown_bytes, 50000, { name: "max_markdown_bytes", minimum: 256, maximum: 200000 });
          const outputPath = outputPathArgument === null ? null : resolvePath(outputPathArgument);
          if (outputPath && path.extname(outputPath).toLowerCase() !== ".md") {
            throw new Error("output_path must end in .md.");
          }
          if (outputPath && path.resolve(outputPath) === path.resolve(resolvedPath)) {
            throw new Error("output_path must be different from the source PDF path.");
          }
          const outputBinding = outputPath
            ? await bindOutputPathForTransaction(outputPath)
            : null;

          const fileName = path.basename(resolvedPath);
          const { result, source } = await runPdfjsOperation(resolvedPath, {
            operation: "extract_layout_for_markdown",
            password,
            options: {
              source_path: resolvedPath,
              source_file_name: fileName,
              start_page: startPage,
              end_page: endPage,
              max_items: maxItems,
              max_characters: maxCharacters,
              max_output_characters: 200000,
            },
          });
          const layout = result.layout;
          const sourceCanonicalPath = source.canonical_path;
          const sourceFileIdentity = source.file_identity;
          const sourceSha256 = source.sha256;
          const sizeBytes = source.size_bytes;
          const rendered = renderPdfLayoutToMarkdown(layout, {
            includePageBoundaries,
            maxMarkdownBytes,
            compact,
            removePageFurniture,
            emitTableProposals,
          });
          const pagesNeedingVision = deriveMarkdownVisionRouting(layout);

          let savedOutput = null;
          if (outputBinding) {
            await assertBoundOutputParent(outputBinding);
            const markdownBytes = Buffer.from(rendered.markdown, "utf8");
            savedOutput = await commitMarkdownOutputInAnchoredProcess({
              outputBinding,
              markdownBytes,
              overwrite,
              expectedOutputIdentity,
              sourcePath: resolvedPath,
              sourceCanonicalPath,
              sourceSha256,
              sourceSizeBytes: sizeBytes,
              sourceFileIdentity,
            });
          }

          // Verified-vision (B1): the renderer emits token-free region
          // descriptors under `table_proposal_regions` only when opt-in. The
          // handler owns source identity, so it binds each region to this exact
          // document with a proposal_token = SHA-256 of a canonical
          // (source sha256, IR version, region_id) string, and re-keys the
          // descriptors to `table_proposals`. The intermediate key never
          // reaches the payload. When the flag is off there is no key at all,
          // so the structured result stays byte-identical to prior behavior.
          const { table_proposal_regions: tableProposalRegions, ...renderedPayload } = rendered;
          let tableProposals;
          if (tableProposalRegions !== undefined) {
            const tokenSourceSha256 = rendered.provenance.source.sha256;
            const tokenIrVersion = rendered.provenance.layout.version;
            tableProposals = tableProposalRegions.map(region => ({
              ...region,
              proposal_token: createHash("sha256")
                .update([tokenSourceSha256, tokenIrVersion, region.region_id].join("\n"), "utf8")
                .digest("hex"),
            }));
          }
          const payload = {
            ...renderedPayload,
            pages_needing_vision: pagesNeedingVision,
            saved_output: savedOutput,
            ...(tableProposals !== undefined ? { table_proposals: tableProposals } : {}),
          };
          const summary = [
            `Converted pages ${layout.page_range.start_page}-${layout.page_range.end_page} of ${fileName} to deterministic Markdown.`,
            `Status: ${rendered.conversion_status}. UTF-8 bytes: ${rendered.markdown_bytes}.`,
            `Source SHA-256: ${sourceSha256}.`,
            ...(savedOutput ? [`Saved and reopened exact UTF-8 output: ${savedOutput.path}`] : []),
            ...(rendered.gaps.length > 0 ? [`Coverage gaps: ${rendered.gaps.map(gap => `page ${gap.page}: ${gap.code}`).join(", ")}.`] : []),
            ...(pagesNeedingVision.length > 0
              ? [`Vision routing: use render_pdf_page for pages ${pagesNeedingVision.map(entry => entry.page).join(", ")}.`]
              : []),
            "No OCR, external model, hidden link-target recovery, or table inference beyond complete source-bound text, ruled, or painted grids was performed.",
            rendered.markdown,
          ].join("\n\n");
          return {
            content: [{ type: "text", text: summary }],
            structuredContent: payload,
          };
        } catch (error) {
          if (error?.code === PDF_RESOURCE_LIMIT_CODE) throw error;
          if (["PASSWORD_REQUIRED", "PASSWORD_INCORRECT"].includes(error?.code)) {
            return {
              isError: true,
              content: [{ type: "text", text: `Error converting PDF to Markdown: ${error.message}` }],
              structuredContent: {
                status: "failed",
                error: { error_schema_version: 1, code: error.code },
              },
            };
          }
          throw new Error(`Error converting PDF to Markdown: ${error.message}`, { cause: error });
        }
      }

      case "verify_table_proposal": {
        const verifyArgs = requireArgumentObject(args, "verify_table_proposal");
        const allowedArguments = new Set([
          "pdf_path",
          "password",
          "region_id",
          "proposal_token",
          "cells",
        ]);
        const unknownArgument = Object.keys(verifyArgs).find(name => !allowedArguments.has(name));
        if (unknownArgument) throw new Error(`Unknown verify_table_proposal argument: ${unknownArgument}.`);
        const pdfPath = requireStringArgument(verifyArgs.pdf_path, "pdf_path", { maxLength: 32768 });
        const password = optionalStringArgument(verifyArgs.password, "password", { maxLength: 4096 });
        const regionId = requireStringArgument(verifyArgs.region_id, "region_id", { maxLength: 64 });
        const regionMatch = /^p([1-9][0-9]*)-t([1-9][0-9]*)$/.exec(regionId);
        if (!regionMatch) throw new Error("region_id must match p{page}-t{ordinal} with positive integers.");
        const page = Number(regionMatch[1]);
        if (!Number.isSafeInteger(page) || page > 1000000) {
          throw new Error("region_id page must be from 1 through 1000000.");
        }
        const proposalToken = requireStringArgument(
          verifyArgs.proposal_token,
          "proposal_token",
          { maxLength: 64 },
        );
        if (!/^[a-f0-9]{64}$/.test(proposalToken)) {
          throw new Error("proposal_token must be a lowercase 64-character SHA-256 hex digest.");
        }
        const cells = normalizeTableProposalCells(verifyArgs.cells);
        if (!path.isAbsolute(expandUserPath(pdfPath))) {
          throw new Error("pdf_path must be an absolute path or begin with ~/.");
        }
        const resolvedPath = resolvePath(pdfPath);
        try {
          // Use the widest supported single-page extraction limits. If the B1
          // packet came from a narrower or truncated view, the verifier can see
          // additional source items and reject missing coverage, never accept a
          // convenient subset. The PDF.js worker performs the independent
          // source-evidence replay before this result is returned.
          const fileName = path.basename(resolvedPath);
          const { result } = await runPdfjsOperation(resolvedPath, {
            operation: "extract_layout_for_markdown",
            password,
            options: {
              source_path: resolvedPath,
              source_file_name: fileName,
              start_page: page,
              end_page: page,
              max_items: 5000,
              max_characters: 100000,
              max_output_characters: 200000,
            },
          });
          const rendered = renderPdfLayoutToMarkdown(result.layout, {
            includePageBoundaries: true,
            maxMarkdownBytes: 200000,
            compact: false,
            emitTableProposals: true,
          });
          const expectedProposalToken = createHash("sha256")
            .update([
              rendered.provenance.source.sha256,
              rendered.provenance.layout.version,
              regionId,
            ].join("\n"), "utf8")
            .digest("hex");
          const region = rendered.table_proposal_regions.find(candidate => (
            candidate.region_id === regionId
          )) ?? null;
          const payload = verifyTableProposalAgainstRegion({
            source: {
              file_name: rendered.provenance.source.file_name,
              sha256: rendered.provenance.source.sha256,
              size_bytes: rendered.provenance.source.size_bytes,
            },
            layout: {
              name: rendered.provenance.layout.name,
              version: rendered.provenance.layout.version,
              parser_name: rendered.provenance.layout.parser_name,
              parser_version: rendered.provenance.layout.parser_version,
            },
            regionId,
            page,
            region,
            proposalToken,
            expectedProposalToken,
            cells,
          });
          const summary = payload.status === "accepted"
            ? `Accepted proposal ${regionId} against a fresh source parse. Cell content was rebuilt only from the PDF text layer, and the grid is consistent with every available source ruling segment. The GFM table below is a syntax-escaped rectangular projection; structured cells retain any spans. Consistency does not prove unique topology.\n\n${payload.table.markdown}`
            : `Rejected proposal ${regionId} against a fresh source parse: ${payload.reason_codes.join(", ")}. No table content was emitted.`;
          return {
            content: [{ type: "text", text: summary }],
            structuredContent: payload,
          };
        } catch (error) {
          if (error?.code === PDF_RESOURCE_LIMIT_CODE) throw error;
          const passwordCode = ["PASSWORD_REQUIRED", "PASSWORD_INCORRECT"].includes(error?.code)
            ? error.code
            : null;
          const message = `Error verifying table proposal: ${error.message}`;
          return passwordCode
            ? createTypedToolError({ message, code: passwordCode })
            : createTypedToolError({ message });
        }
      }

      case "render_pdf_page": {
        const {
          pdf_path,
          page = 1,
          max_dimension_px = 1800,
          password = null,
        } = args;
        const resolvedPath = resolvePath(pdf_path);

        try {
          const targetPage = Math.max(1, Number(page) || 1);
          const rendererPolicy = pdfjsRendererPolicy();
          const { result: renderedImage, source } = await runPdfjsOperation(resolvedPath, {
            operation: "render_page",
            password,
            options: {
              page: targetPage,
              max_dimension_px: Number(max_dimension_px) || 1800,
              renderer_policy: rendererPolicy,
              scale_override: null,
            },
          });
          const imageBuffer = renderedImage.binary;
          const width = renderedImage.width_points;
          const height = renderedImage.height_points;
          const scale = renderedImage.scale;
          const totalPages = renderedImage.total_pages;
          const renderedWidth = renderedImage.width;
          const renderedHeight = renderedImage.height;
          const fileName = path.basename(resolvedPath);
          const payload = buildRenderObservation({
            existing: {
              pdf_path: resolvedPath,
              file_name: fileName,
              page: targetPage,
              total_pages: totalPages,
              width_points: Math.round(width),
              height_points: Math.round(height),
              rendered_width_px: renderedWidth,
              rendered_height_px: renderedHeight,
              scale,
              renderer: renderedImage.renderer,
              mime_type: "image/png",
            },
            source: { ...source, file_name: fileName },
            geometry: renderedImage.page_geometry,
            pageView: renderedImage.page_view,
            page: targetPage,
            requestedRegion: renderedImage.requested_region,
            renderedRegion: renderedImage.rendered_region,
            rendererPolicy,
            pngSha256: createHash("sha256").update(imageBuffer).digest("hex"),
            rawPixelSha256: renderedImage.raw_pixel_sha256,
            rawPixelStatus: renderedImage.raw_pixel_status,
          });

          return {
            content: [{
              type: "text",
              text:
                `Rendered page ${targetPage} of ${fileName} as PNG.\n` +
                `Document pages: ${totalPages}\n` +
                `Rendered size: ${renderedWidth} x ${renderedHeight} px\n` +
                `Renderer: ${renderedImage.renderer}\n` +
                `Scale: ${scale.toFixed(2)}x`
            }, {
              type: "image",
              data: imageBuffer.toString("base64"),
              mimeType: "image/png",
            }],
            structuredContent: payload,
          };
        } catch (error) {
          if (error?.code === PDF_RESOURCE_LIMIT_CODE) throw error;
          return createTypedToolError({
            message: `Error rendering PDF page: ${error.message}\n\nPlease ensure the file path is correct and the requested page can be rendered.`,
          });
        }
      }

      case "render_pdf_region": {
        const {
          pdf_path,
          page,
          x,
          y,
          width,
          height,
          max_dimension_px = 1400,
          password = null,
        } = args;
        const resolvedPath = resolvePath(pdf_path);

        try {
          const targetPage = Math.max(1, Number(page) || 1);
          const region = {
            x: Number(x),
            y: Number(y),
            width: Number(width),
            height: Number(height),
          };
          const rendererPolicy = pdfjsRendererPolicy();
          const { result: renderedImage, source } = await runPdfjsOperation(resolvedPath, {
            operation: "render_region",
            password,
            options: {
              page: targetPage,
              max_dimension_px: Number(max_dimension_px) || 1400,
              renderer_policy: rendererPolicy,
              ...region,
            },
          });
          const scale = renderedImage.scale;
          const crop = getRegionPixelRect({
            ...region,
            scale,
          });
          const imageBuffer = renderedImage.binary;
          const totalPages = renderedImage.total_pages;
          const fileName = path.basename(resolvedPath);
          const payload = buildRenderObservation({
            existing: {
              pdf_path: resolvedPath,
              file_name: fileName,
              page: targetPage,
              total_pages: totalPages,
              region_points: region,
              rendered_width_px: renderedImage.width,
              rendered_height_px: renderedImage.height,
              scale,
              renderer: renderedImage.renderer,
              mime_type: "image/png",
            },
            source: { ...source, file_name: fileName },
            geometry: renderedImage.page_geometry,
            pageView: renderedImage.page_view,
            page: targetPage,
            requestedRegion: renderedImage.requested_region,
            renderedRegion: renderedImage.rendered_region,
            rendererPolicy,
            pngSha256: createHash("sha256").update(imageBuffer).digest("hex"),
            rawPixelSha256: renderedImage.raw_pixel_sha256,
            rawPixelStatus: renderedImage.raw_pixel_status,
          });

          return {
            content: [{
              type: "text",
              text:
                `Rendered region from page ${targetPage} of ${fileName} as PNG.\n` +
                `Region (pt): (${region.x}, ${region.y}, ${region.width} x ${region.height})\n` +
                `Rendered crop: ${crop.width} x ${crop.height} px\n` +
                `Renderer: ${renderedImage.renderer}\n` +
                `Scale: ${scale.toFixed(2)}x`
            }, {
              type: "image",
              data: imageBuffer.toString("base64"),
              mimeType: "image/png",
            }],
            structuredContent: payload,
          };
        } catch (error) {
          if (error?.code === PDF_RESOURCE_LIMIT_CODE) throw error;
          return createTypedToolError({
            message: `Error rendering PDF region: ${error.message}\n\nPlease ensure the file path, page, and region coordinates are valid.`,
          });
        }
      }

      case "search_pdf_text": {
        const {
          pdf_path,
          query,
          max_results = 10,
          context_chars = 160,
        } = args;
        const resolvedPath = resolvePath(pdf_path);

        try {
          const { result, source } = await runPdfjsOperation(resolvedPath, {
            operation: "search_text",
            options: {
              query: String(query ?? ""),
              max_results: Number(max_results) || 10,
              context_chars: Number(context_chars) || 160,
            },
          });
          const fileName = path.basename(resolvedPath);
          const fileSizeKB = (source.size_bytes / 1024).toFixed(2);

          let response =
            `Search results for "${result.query}" in ${fileName}\n` +
            `Size: ${fileSizeKB} KB\n` +
            `Document pages: ${result.total_pages}\n` +
            `Matches returned: ${result.match_count}\n`;

          if (result.match_count === 0) {
            response += `\nNo matches found.`;
          } else {
            if (result.truncated) {
              response += `\nShowing the first ${result.match_count} matches. Narrow the query or increase max_results for more.\n`;
            }
            response += `\n`;
            for (const match of result.matches) {
              response += `\n- Page ${match.page}: ${match.snippet}\n`;
            }
          }

          return {
            content: [{
              type: "text",
              text: response.trimEnd(),
            }],
            structuredContent: {
              pdf_path: resolvedPath,
              file_name: fileName,
              total_pages: result.total_pages,
              query: result.query,
              match_count: result.match_count,
              truncated: result.truncated,
              matches: result.matches,
            },
          };
        } catch (error) {
          if (error?.code === PDF_RESOURCE_LIMIT_CODE) throw error;
          error = passwordlessReadError(error);
          return createTypedToolError({
            message: `Error searching PDF text: ${error.message}\n\nPlease ensure the file path is correct and the query is valid.`,
          });
        }
      }

      case "get_pdf_resource_uri": {
        const { pdf_path } = args;
        // A resource URI outlives this call, so it must name the file that was
        // checked rather than a link that can be repointed before it is read.
        const resolvedPath = resolveCanonicalPath(pdf_path);

        try {
          const stats = await fs.lstat(resolvedPath);
          if (stats.isSymbolicLink() || !stats.isFile()) {
            throw new Error(`Not a regular file: ${path.basename(resolvedPath)}`);
          }
          const fileName = path.basename(resolvedPath);
          const fileSizeKB = (stats.size / 1024).toFixed(2);
          
          // Create the resource URI
          const resourceUri = pathToPdfResourceUri(resolvedPath);
          
          return {
            content: [{
              type: "text",
              text: `Resource URI created: ${resourceUri}\n\nFile: ${fileName}\nSize: ${fileSizeKB} KB\n\nA resource-aware MCP client can request this PDF through this server's Resources API.`
            }],
            structuredContent: {
              uri: resourceUri,
              pdf_path: resolvedPath,
              file_name: fileName,
              size_bytes: stats.size,
            },
          };
        } catch (error) {
          return createTypedToolError({
            message: `Error accessing PDF file: ${error.message}\n\nPlease ensure the file path is correct and the file exists.`,
          });
        }
      }

      case "get_pdf_identity": {
        const { pdf_path } = args;
        const requestedPath = resolvePath(pdf_path);
        const identity = await hashBoundedPdfFileSafely(
          requestedPath,
          PDF_MUTATION_MAX_FILE_BYTES,
          {
            assertPathAllowed,
            createSizeLimitError: pdfMutationFileLimitError,
          },
        );
        const payload = {
          schema_version: "1.0",
          requested_path: requestedPath,
          canonical_path: identity.canonicalPath,
          file_name: path.basename(identity.canonicalPath),
          size_bytes: identity.sizeBytes,
          sha256: identity.sha256,
          identity_method: "race_aware_descriptor_sha256",
          pdf_parsed: false,
        };
        return {
          content: [{
            type: "text",
            text: [
              `File: ${payload.file_name}`,
              `Canonical path: ${payload.canonical_path}`,
              `Size: ${payload.size_bytes} bytes`,
              `SHA-256: ${payload.sha256}`,
              "PDF parsed: no",
            ].join("\n"),
          }],
          structuredContent: payload,
        };
      }

      case "display_pdf": {
        const { pdf_path, page } = args;
        const resolvedPath = resolvePath(pdf_path);
        const MAX_FILE_SIZE = 100 * 1024 * 1024; // 100MB

        await fs.access(resolvedPath);
        const stats = await fs.stat(resolvedPath);

        if (stats.size > MAX_FILE_SIZE) {
          return createTypedToolError({
            message: `PDF exceeds 100MB limit (${(stats.size / 1024 / 1024).toFixed(1)}MB). Use read_pdf_content for text extraction instead.`,
          });
        }

        const fileName = path.basename(resolvedPath);
        const initialPage = Math.max(1, page || 1);
        noteDocumentOpened(resolvedPath);

        // Detect and extract form fields
        let hasFormFields = false;
        let fieldCount = 0;
        let fieldInfo = [];
        try {
          const pdfBytes = await fs.readFile(resolvedPath);
          const pdfDoc = await PDFDocument.load(pdfBytes, { ignoreEncryption: true });
          const form = pdfDoc.getForm();
          const fields = form.getFields();
          fieldCount = fields.length;
          hasFormFields = fieldCount > 0;

          if (hasFormFields) {
            fieldInfo = fields.map(field => {
              const name = field.getName();
              let type = "unknown";
              let options = [];
              let currentValue = "";
              try {
                if (field.constructor.name.includes("TextField")) {
                  type = "text";
                  currentValue = field.getText() || "";
                } else if (field.constructor.name.includes("CheckBox")) {
                  type = "checkbox";
                  currentValue = field.isChecked();
                } else if (field.constructor.name.includes("RadioGroup")) {
                  type = "radio";
                  currentValue = field.getSelected() || "";
                } else if (field.constructor.name.includes("Dropdown")) {
                  type = "dropdown";
                  options = field.getOptions();
                  currentValue = field.getSelected() || "";
                }
              } catch {}
              return { name, type, options, currentValue };
            });
          }
        } catch {
          // Not a form PDF or encrypted — that's fine
        }

        let text = `Displaying: ${fileName} (${(stats.size / 1024).toFixed(0)} KB)`;
        if (hasFormFields) {
          text += `\n${fieldCount} form fields detected.`;
        }

        const payload = await buildActiveDocumentPayload(resolvedPath, initialPage, {
          hasFormFields,
          fieldCount,
          fields: fieldInfo,
        });
        return {
          content: [{ type: "text", text }],
          structuredContent: payload,
          _meta: {
            ui: { resourceUri: "ui://pdf-toolkit/viewer" },
            viewUUID: `pdf-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
            ...payload,
          },
        };
      }

      case "get_active_document": {
        if (!activeDocumentState.activePath) {
          return {
            content: [{
              type: "text",
              text: "No active document yet. Open a PDF with display_pdf or read_pdf_fields, or fetch one with fetch_pdf_from_url first."
            }],
            structuredContent: {
              active_path: null,
              backup_path: null,
              last_mutation_tool: null,
              last_mutation_at: null,
            },
          };
        }

        const payload = await buildActiveDocumentPayload(activeDocumentState.activePath);
        return {
          content: [{
            type: "text",
            text:
              `Active document: ${payload.active_path}\n` +
              (payload.backup_path ? `Backup: ${payload.backup_path}\n` : "Backup: none\n") +
              (payload.last_mutation_tool ? `Last mutation: ${payload.last_mutation_tool} at ${payload.last_mutation_at}` : "Last mutation: none")
          }],
          structuredContent: payload,
        };
      }

      case "set_active_document": {
        const normalized = normalizeSetActiveDocumentArguments(args);
        const resolvedPdfPath = resolvePath(normalized.pdf_path);
        const pdfStats = await fs.stat(resolvedPdfPath);
        if (!pdfStats.isFile()) {
          throw new Error(`Active PDF path is not a file: ${resolvedPdfPath}`);
        }
        let resolvedBackupPath = normalized.backup_path === null
          ? null
          : resolvePath(normalized.backup_path);
        if (resolvedBackupPath !== null) {
          const backupStats = await fs.stat(resolvedBackupPath);
          if (!backupStats.isFile()) {
            throw new Error(`Backup PDF path is not a file: ${resolvedBackupPath}`);
          }
          const canonicalPdfPath = await fs.realpath(resolvedPdfPath);
          const record = await readBackupRecord(canonicalPdfPath);
          if (!record) {
            throw backupIdentityError(
              "BACKUP_IDENTITY_UNVERIFIED",
              "The supplied backup has no durable immutable-original identity record.",
            );
          }
          const validatedBackupPath = await validateBackupRecord(record);
          const suppliedBackupPath = await fs.realpath(resolvedBackupPath);
          if (suppliedBackupPath !== validatedBackupPath) {
            throw backupIdentityError(
              "BACKUP_IDENTITY_MISMATCH",
              "The supplied backup does not match the durable immutable-original identity for this document.",
            );
          }
          resolvedBackupPath = validatedBackupPath;
        }

        syncActiveDocumentState({
          pdfPath: resolvedPdfPath,
          backupPath: resolvedBackupPath,
          lastMutationTool: normalized.last_mutation_tool,
          lastMutationAt: normalized.last_mutation_at,
        });
        const payload = await buildActiveDocumentPayload(resolvedPdfPath);
        return {
          content: [{
            type: "text",
            text: `Active document synced: ${payload.active_path}`
          }],
          structuredContent: payload,
        };
      }

      case "read_pdf_bytes": {
        const { pdf_path, offset, byteCount } = args;
        const resolvedPath = resolveCanonicalPath(pdf_path);
        const MAX_CHUNK = 524288; // 512KB max per chunk
        const clampedByteCount = Math.min(byteCount || MAX_CHUNK, MAX_CHUNK);

        let fileHandle;
        try {
          // Size comes from the open descriptor rather than a separate stat of
          // the name, so the bytes read are the file that was checked.
          const opened = await openVerifiedRegularFile(fs, resolvedPath);
          fileHandle = opened.handle;
          const totalBytes = opened.stat.size;
          const clampedOffset = Math.min(offset || 0, totalBytes);
          const end = Math.min(clampedOffset + clampedByteCount, totalBytes);
          const buffer = Buffer.alloc(end - clampedOffset);
          await fileHandle.read(buffer, 0, buffer.length, clampedOffset);

          const bytes = buffer.toString("base64");
          const hasMore = end < totalBytes;

          return {
            content: [{
              type: "text",
              text: `${buffer.length} bytes at ${clampedOffset}/${totalBytes}`
            }],
            structuredContent: {
              pdfPath: resolvedPath,
              bytes,
              offset: clampedOffset,
              byteCount: buffer.length,
              totalBytes,
              hasMore,
            },
          };
        } catch (err) {
          return createTypedToolError({ message: `Error opening file: ${err.message}` });
        } finally {
          await fileHandle?.close().catch(() => {});
        }
      }

      case "merge_pdfs": {
        const {
          input_paths,
          output_path,
          password,
          expected_output_identity,
        } = args;
        if (!input_paths || input_paths.length === 0) {
          throw new Error("input_paths must be a non-empty array of PDF file paths.");
        }
        const resolvedOutputPath = resolvePath(output_path);
        const expectedOutputIdentity = normalizeExpectedOutputIdentity(
          expected_output_identity,
        );

        // Check no input path equals output path
        const resolvedInputPaths = input_paths.map(p => resolvePath(p));
        if (resolvedInputPaths.includes(resolvedOutputPath)) {
          throw new Error("output_path must be different from all input paths to prevent file corruption.");
        }

        await preflightPdfMutationInputsWithinMergeLimit(resolvedInputPaths, {
          preflightInput: async (inputPath, maxBytes, createSizeLimitError) => {
            const observation = await preflightPdfInputWithoutRecovery(
              inputPath,
              maxBytes,
              createSizeLimitError,
            );
            return observation.missingBeforeRecovery ? null : observation;
          },
        });
        const { inputs: retainedInputs } = await readPdfMutationInputsWithinMergeLimit(
          resolvedInputPaths,
          {
            readInput: (inputPath, maxBytes, createSizeLimitError) =>
              readPdfInputWithRecovery(inputPath, { maxBytes, createSizeLimitError }),
          },
        );

        const mergeResult = await runPdfLibMutation({
          operation: "merge_pdfs",
          sources: retainedInputs.map(input => bindRecoveredMutationSource(input)),
          password,
          options: {},
        }, async ({ result, outputs, atomicTransition }) => {
          const committedOutput = await writePdfOutputAtomic(resolvedOutputPath, null, {
            produceBytes: outputs[0].readBytes,
            onTransition: atomicTransition,
            assertPathAllowed,
            overwrite: expectedOutputIdentity !== null,
            expectedExistingIdentity: expectedOutputIdentity,
            validateInitialTargets: rejectOutputAliasesToProtectedInputs(
              retainedInputs.map(input => input.fileIdentity),
            ),
          });
          return { committedOutput, result };
        });
        const { committedOutput, result: workerResult } = mergeResult;
        const committedOutputPath = committedOutput.targetPath;
        const outputStats = await fs.stat(committedOutputPath);
        const payload = await buildNewOutputDocumentPayload(committedOutputPath, "merge_pdfs", 1, {
          ...workerResult.form_info,
          total_pages: workerResult.total_pages,
          metadata_fields_omitted: workerResult.omitted_fields,
        });
        const metadataNotice = workerResult.omitted_fields.length > 0
          ? `\nOmitted unverified metadata: ${workerResult.omitted_fields.join(", ")}`
          : "";

        return {
          content: [{
            type: "text",
            text: `Merged ${input_paths.length} PDFs into: ${output_path}\nTotal pages: ${workerResult.total_pages}\nFile size: ${(outputStats.size / 1024).toFixed(0)} KB${metadataNotice}`
          }],
          structuredContent: payload,
          _meta: {
            ui: { resourceUri: "ui://pdf-toolkit/viewer" },
            ...payload,
          },
        };
      }

      case "split_pdf": {
        const {
          input_path,
          page_ranges,
          output_directory,
          password,
          expected_output_identities,
        } = args;
        const recoveredInput = await readPdfInputWithRecovery(input_path);
        const {
          resolvedPath: resolvedInputPath,
          fileIdentity,
        } = recoveredInput;
        const resolvedOutputDir = resolvePath(output_directory);
        const expectedOutputIdentities = normalizeExpectedOutputIdentities(
          expected_output_identities,
        );
        const baseName = path.basename(resolvedInputPath, ".pdf");
        const split = await runPdfLibMutation({
          operation: "split_pdf",
          sources: [bindRecoveredMutationSource(recoveredInput)],
          password,
          options: { page_ranges },
        }, async ({ result, outputs, atomicTransition }) => {
          await fs.mkdir(resolvedOutputDir, { recursive: true });
          const pendingOutputs = result.ranges.map(([start, end], index) => {
            const suffix = result.ranges.length > 1 ? `_${index + 1}` : "";
            const filename = `${baseName}_pages_${start}-${end}${suffix}.pdf`;
            return {
              filename, start, end,
              targetPath: path.join(resolvedOutputDir, filename),
              produceBytes: outputs[index]?.readBytes,
            };
          });
          if (outputs.length !== pendingOutputs.length) throw new Error("Split worker returned an incomplete batch.");
          bindExpectedOutputIdentityManifest(pendingOutputs, expectedOutputIdentities);
          const committed = await writePdfOutputsAtomic(pendingOutputs, {
            onTransition: atomicTransition,
            assertPathAllowed,
            validateInitialTargets: rejectOutputAliasesToProtectedInputs([fileIdentity]),
          });
          return {
            ranges: result.ranges,
            files: pendingOutputs.map((entry, index) => ({
              filename: entry.filename,
              output_path: committed[index].targetPath,
              start_page: entry.start,
              end_page: entry.end,
              page_count: entry.end - entry.start + 1,
            })),
          };
        });
        const results = split.files.map(file => `${file.filename} (${file.page_count} pages)`);

        return {
          content: [{
            type: "text",
            text: `Split ${path.basename(resolvedInputPath)} into ${results.length} files:\n${results.join("\n")}\nSaved to: ${output_directory}`
          }],
          structuredContent: {
            input_path: resolvedInputPath,
            output_directory: resolvedOutputDir,
            file_count: split.files.length,
            files: split.files,
          },
        };
      }

      case "rotate_pdf_pages": {
        const {
          input_path,
          output_path,
          pages,
          degrees,
          password,
          expected_output_identity,
        } = args;
        if (![90, 180, 270].includes(degrees)) {
          throw new Error(`Invalid rotation angle: ${degrees}. Must be 90, 180, or 270.`);
        }
        const resolvedInputPath = resolvePath(input_path);
        const resolvedOutputPath = resolvePath(output_path);
        const expectedOutputIdentity = normalizeExpectedOutputIdentity(
          expected_output_identity,
        );
        if (resolvedInputPath === resolvedOutputPath) {
          throw new Error("output_path must be different from input_path to prevent file corruption.");
        }

        const recoveredInput = await readPdfInputWithRecovery(input_path);
        const rotate = await runPdfLibMutation({
          operation: "rotate_pdf_pages",
          sources: [bindRecoveredMutationSource(recoveredInput)],
          password,
          options: { pages: pages ?? [], degrees },
        }, async ({ result, outputs, atomicTransition }) => {
          const committedOutput = await writePdfOutputAtomic(resolvedOutputPath, null, {
            produceBytes: outputs[0].readBytes,
            onTransition: atomicTransition,
            assertPathAllowed,
            overwrite: expectedOutputIdentity !== null,
            expectedExistingIdentity: expectedOutputIdentity,
            validateInitialTargets: rejectOutputAliasesToProtectedInputs([recoveredInput.fileIdentity]),
          });
          return { result, committedOutput };
        });
        const { result: workerResult, committedOutput } = rotate;
        const committedOutputPath = committedOutput.targetPath;
        const outputStats = await fs.stat(committedOutputPath);
        const payload = await buildNewOutputDocumentPayload(committedOutputPath, "rotate_pdf_pages", 1, {
          ...workerResult.form_info,
          rotated_pages: workerResult.rotated_pages,
          degrees,
        });

        return {
          content: [{
            type: "text",
            text: `Rotated ${workerResult.rotated_pages} page(s) by ${degrees}° and saved to: ${output_path}\nFile size: ${(outputStats.size / 1024).toFixed(0)} KB`
          }],
          structuredContent: payload,
          _meta: {
            ui: { resourceUri: "ui://pdf-toolkit/viewer" },
            ...payload,
          },
        };
      }

      case "reorder_pdf_pages": {
        const {
          input_path,
          output_path,
          page_order,
          password,
          expected_output_identity,
        } = args;
        if (!page_order || page_order.length === 0) {
          throw new Error("page_order must be a non-empty array of page numbers.");
        }
        const resolvedInputPath = resolvePath(input_path);
        const resolvedOutputPath = resolvePath(output_path);
        const expectedOutputIdentity = normalizeExpectedOutputIdentity(
          expected_output_identity,
        );
        if (resolvedInputPath === resolvedOutputPath) {
          throw new Error("output_path must be different from input_path to prevent file corruption.");
        }

        const recoveredInput = await readPdfInputWithRecovery(input_path);
        const reordered = await runPdfLibMutation({
          operation: "reorder_pdf_pages",
          sources: [bindRecoveredMutationSource(recoveredInput)],
          password,
          options: { page_order, rotations: {} },
        }, async ({ result, outputs, atomicTransition }) => {
          const committedOutput = await writePdfOutputAtomic(resolvedOutputPath, null, {
            produceBytes: outputs[0].readBytes,
            onTransition: atomicTransition,
            assertPathAllowed,
            overwrite: expectedOutputIdentity !== null,
            expectedExistingIdentity: expectedOutputIdentity,
            validateInitialTargets: rejectOutputAliasesToProtectedInputs([recoveredInput.fileIdentity]),
          });
          return { result, committedOutput };
        });
        const { result: workerResult, committedOutput } = reordered;
        const committedOutputPath = committedOutput.targetPath;
        const outputStats = await fs.stat(committedOutputPath);
        const payload = await buildNewOutputDocumentPayload(committedOutputPath, "reorder_pdf_pages", 1, {
          ...workerResult.form_info,
          page_order,
        });

        return {
          content: [{
            type: "text",
            text: `Reordered ${workerResult.total_pages} pages and saved to: ${output_path}\nNew order: [${page_order.join(", ")}]\nFile size: ${(outputStats.size / 1024).toFixed(0)} KB`
          }],
          structuredContent: payload,
          _meta: {
            ui: { resourceUri: "ui://pdf-toolkit/viewer" },
            ...payload,
          },
        };
      }

      case "inspect_pdf_accessibility": {
        try {
          const inspectionArgs = requireArgumentObject(args, "inspect_pdf_accessibility");
          const unknownArgument = Object.keys(inspectionArgs)
            .find(argument => argument !== "pdf_path");
          if (unknownArgument) {
            throw new TypeError("inspect_pdf_accessibility received an unknown argument.");
          }
          const pdfPath = requireStringArgument(
            inspectionArgs.pdf_path,
            "pdf_path",
            { maxLength: 32_768 },
          );
          const resolvedPath = resolvePath(pdfPath);
          const source = await bindPdfLibInspectionSource(resolvedPath);
          const payload = await runPdfLibInspection({
            operation: "inspect_pdf_accessibility",
            sources: [source],
          });
          return {
            content: [{
              type: "text",
              text: [
                `Structural review status: ${payload.inspection_status}.`,
                `Reviewed 8 shallow catalog-level signals: ${payload.summary.observed} observed, ${payload.summary.missing} missing, ${payload.summary.unavailable} unavailable.`,
                "Qualified human review is required.",
                "PDF/UA, WCAG, certification, legal compliance, and document accessibility are not established.",
              ].join("\n"),
            }],
            structuredContent: payload,
          };
        } catch (error) {
          return createTypedToolError(publicAccessibilityInspectionError(error));
        }
      }

      case "compare_pdfs": {
        try {
          const compareArgs = requireArgumentObject(args, "compare_pdfs");
          const allowedArguments = new Set([
            "before_pdf_path", "after_pdf_path", "before_password", "after_password",
            "mode", "max_pages", "include_visual", "max_output_characters",
          ]);
          const unknownArgument = Object.keys(compareArgs).find(name => !allowedArguments.has(name));
          if (unknownArgument) throw new Error(`Unknown compare_pdfs argument: ${unknownArgument}.`);
          const beforePdfPath = requireStringArgument(compareArgs.before_pdf_path, "before_pdf_path", { maxLength: 32_768 });
          const afterPdfPath = requireStringArgument(compareArgs.after_pdf_path, "after_pdf_path", { maxLength: 32_768 });
          const beforePassword = optionalStringArgument(compareArgs.before_password, "before_password", { maxLength: 4096 });
          const afterPassword = optionalStringArgument(compareArgs.after_password, "after_password", { maxLength: 4096 });
          const mode = compareArgs.mode === undefined ? "default_material" : compareArgs.mode;
          if (!new Set(["default_material", "forensic"]).has(mode)) {
            throw new Error("'mode' must be default_material or forensic.");
          }
          const maxPages = compareArgs.max_pages === undefined ? 10 : requireIntegerArgument(compareArgs.max_pages, "max_pages", { min: 1 });
          if (maxPages > 20) throw new Error("'max_pages' must not exceed 20.");
          const includeVisual = compareArgs.include_visual === undefined ? true : compareArgs.include_visual;
          if (typeof includeVisual !== "boolean") throw new Error("'include_visual' must be a boolean.");
          const maxOutputCharacters = compareArgs.max_output_characters === undefined
            ? 100_000
            : requireIntegerArgument(compareArgs.max_output_characters, "max_output_characters", { min: 20_000 });
          if (maxOutputCharacters > 200_000) throw new Error("'max_output_characters' must not exceed 200000.");

          const started = performance.now();
          const beforePath = resolvePath(beforePdfPath);
          const afterPath = resolvePath(afterPdfPath);
          const [beforeObservation, afterObservation] = await observeComparisonDocuments([
            { side: "before", resolvedPath: beforePath, password: beforePassword, maxPages },
            { side: "after", resolvedPath: afterPath, password: afterPassword, maxPages },
          ]);
          const before = await inspectComparisonDocument(beforePath, { ...beforeObservation, password: beforePassword, includeVisual });
          const after = await inspectComparisonDocument(afterPath, { ...afterObservation, password: afterPassword, includeVisual });
          const sourceImmutability = {
            before: await verifyComparisonSourceUnchanged(beforePath, before.initial_source),
            after: await verifyComparisonSourceUnchanged(afterPath, after.initial_source),
          };
          delete before.initial_source;
          delete after.initial_source;
          const payload = buildPdfComparison({
            before, after, mode, includeVisual, maxOutputCharacters,
            sourceImmutability,
            durationMs: performance.now() - started,
          });
          return {
            content: [{ type: "text", text: [
              `Comparison status: ${payload.status}.`,
              `Detected changes: ${payload.summary.detected_change_count}; reported in ${mode}: ${payload.summary.reported_change_count}.`,
              `Before SHA-256: ${payload.before_source.sha256}. After SHA-256: ${payload.after_source.sha256}.`,
              "No links or annotation actions were opened. No network or persistent output was used.",
            ].join("\n") }],
            structuredContent: payload,
          };
        } catch (error) {
          // `publicPdfComparisonError` recognises the comparison's own refusal
          // by code *and* by message signature, so one that lost its `code`
          // crossing a boundary still classifies. The pdf-lib limit is the one
          // signal it cannot see — that constant lives in server/helpers.js and
          // the comparison module's import graph is deliberately closed against
          // it — so this layer translates it, and does so before the classifier
          // can report a valid call as an invalid one.
          const failure = comparisonSawPdfLibEncryptionLimit(error)
            ? pdfComparisonEncryptedError([])
            : error;
          return createTypedToolError(publicPdfComparisonError(failure));
        }
      }

      case "get_pdf_info": {
        const infoArgs = requireArgumentObject(args, "get_pdf_info");
        const allowedArguments = new Set([
          "pdf_path",
          "password",
          "max_pages",
          "max_output_characters",
        ]);
        const unknownArgument = Object.keys(infoArgs).find(name => !allowedArguments.has(name));
        if (unknownArgument) throw new Error(`Unknown get_pdf_info argument: ${unknownArgument}.`);
        const pdfPath = requireStringArgument(infoArgs.pdf_path, "pdf_path", { maxLength: 32_768 });
        const password = optionalStringArgument(infoArgs.password, "password", { maxLength: 4096 });
        const maxPages = infoArgs.max_pages === undefined
          ? 200
          : requireIntegerArgument(infoArgs.max_pages, "max_pages", { min: 1 });
        const maxOutputCharacters = infoArgs.max_output_characters === undefined
          ? 50_000
          : requireIntegerArgument(
            infoArgs.max_output_characters,
            "max_output_characters",
            { min: 20_000 },
          );
        if (maxPages > 200) throw new Error("'max_pages' must not exceed 200.");
        if (maxOutputCharacters > 200_000) {
          throw new Error("'max_output_characters' must not exceed 200000.");
        }
        try {
          const resolvedPath = resolvePath(pdfPath);
          const { result: payload } = await runPdfjsOperation(resolvedPath, {
            operation: "observe_document",
            password,
            options: {
              max_pages: maxPages,
              max_output_characters: maxOutputCharacters,
            },
          });
          const summary = [
            `Inspected ${payload.pages.observed_count} of ${payload.pages.total_count} pages in ${payload.source.file_name}.`,
            `Status: ${payload.status}. Source SHA-256: ${payload.source.sha256}.`,
            `Form-field observations: ${payload.form_fields.observed_count}. Ordinary annotations: ${payload.annotations.observed_count}.`,
            ...payload.limitations.map(reason => `Limitation: ${reason}.`),
            "Annotation targets were observed as inert values and were not opened or fetched.",
          ].join("\n");
          return {
            content: [{ type: "text", text: summary }],
            structuredContent: payload,
          };
        } catch (error) {
          const publicError = publicPdfObservationError(error);
          return createTypedToolError(publicError);
        }
      }

      case "apply_page_plan": {
        const {
          input_path,
          output_path,
          plan,
          password,
          force_xfa = false,
          expected_output_identity,
        } = args;
        const { page_order, rotations = {} } = plan;

        if (!page_order || page_order.length === 0) {
          throw new Error("plan.page_order must be a non-empty array of page numbers.");
        }

        const resolvedInputPath = resolvePath(input_path);
        const resolvedOutputPath = resolvePath(output_path);
        const expectedOutputIdentity = normalizeExpectedOutputIdentity(
          expected_output_identity,
        );
        if (resolvedInputPath === resolvedOutputPath) {
          throw new Error("output_path must be different from input_path to prevent file corruption.");
        }

        const recoveredInput = await readPdfInputWithRecovery(resolvedInputPath);
        const {
          pdfBytes: rawPdfBytes,
          fileIdentity,
        } = recoveredInput;
        assertXfaMutationAllowed(rawPdfBytes, { forceXfa: force_xfa });
        // Validate rotation degrees
        const validDegrees = [0, 90, 180, 270];
        for (const [pageStr, deg] of Object.entries(rotations)) {
          if (!validDegrees.includes(deg)) {
            throw new Error(`Invalid rotation ${deg}° for page ${pageStr}. Must be 0, 90, 180, or 270.`);
          }
        }

        let outputStats;
        let committedOutputPath;
        let workerResult;
        try {
          const applied = await runPdfLibMutation({
            operation: "apply_page_plan",
            sources: [bindRecoveredMutationSource(recoveredInput)],
            password,
            force_xfa: force_xfa === true,
            options: { page_order, rotations },
          }, async ({ result, outputs, atomicTransition }) => {
            const committedOutput = await writePdfOutputAtomic(resolvedOutputPath, null, {
              produceBytes: outputs[0].readBytes,
              onTransition: atomicTransition,
              assertPathAllowed,
              overwrite: expectedOutputIdentity !== null,
              expectedExistingIdentity: expectedOutputIdentity,
              validateInitialTargets: rejectOutputAliasesToProtectedInputs([
                fileIdentity,
              ]),
            });
            return { result, committedOutput };
          });
          workerResult = applied.result;
          const committedOutput = applied.committedOutput;
          committedOutputPath = committedOutput.targetPath;
          outputStats = await fs.stat(committedOutputPath);
        } catch (writeErr) {
          throw new Error(`Failed to save PDF: ${writeErr.message}. Check that the output directory exists and is writable.`);
        }

        const deletedCount = workerResult.deleted_pages;
        const rotatedCount = workerResult.rotated_pages;
        let summary = `Saved ${page_order.length}-page PDF to: ${output_path}\nFile size: ${(outputStats.size / 1024).toFixed(0)} KB`;
        if (deletedCount > 0) summary += `\n${deletedCount} page(s) removed`;
        if (rotatedCount > 0) summary += `\n${rotatedCount} page(s) rotated`;
        const payload = await buildNewOutputDocumentPayload(committedOutputPath, "apply_page_plan", 1, {
          ...workerResult.form_info,
          deleted_pages: deletedCount,
          rotated_pages: rotatedCount,
          page_order,
          rotations,
        });

        return {
          content: [{ type: "text", text: summary }],
          structuredContent: payload,
          _meta: {
            ui: { resourceUri: "ui://pdf-toolkit/viewer" },
            ...payload,
          },
        };
      }

      case "get_page_analysis": {
        const { pdf_path, password } = args;
        const resolvedPath = resolvePath(pdf_path);
        const { result } = await runPdfjsOperation(resolvedPath, {
          operation: "analyze_pages",
          password,
          options: { max_pages: 200 },
        });
        const analysis = result.analysis;
        const pageMeta = analysis.pages;
        const totalPages = analysis.total_pages;

        // Compute majority orientation for detecting sideways pages
        const orientationCounts = { portrait: 0, landscape: 0 };
        for (const p of pageMeta) orientationCounts[p.orientation]++;
        const majorityOrientation = orientationCounts.portrait >= orientationCounts.landscape ? "portrait" : "landscape";

        let summary = `Analyzed geometry for ${totalPages} pages`;
        if (totalPages > 200) summary += ` (content analysis limited to the first 200)`;
        summary += ".";
        const sidewaysPages = pageMeta.filter(p => p.orientation !== majorityOrientation);
        if (analysis.likely_blank_pages.length > 0) {
          summary += ` ${analysis.likely_blank_pages.length} likely blank page(s): ${analysis.likely_blank_pages.join(", ")}.`;
          summary += ` ${analysis.mutation_guidance}`;
        }
        if (analysis.unknown_pages.length > 0) {
          summary += ` ${analysis.unknown_pages.length} page(s) have unknown content status and are not blank candidates: ${analysis.unknown_pages.join(", ")}.`;
        }
        if (sidewaysPages.length > 0) summary += ` ${sidewaysPages.length} page(s) in ${sidewaysPages[0].orientation} orientation (majority is ${majorityOrientation}): ${sidewaysPages.map(p => p.page).join(", ")}.`;
        if (analysis.retry_guidance) summary += ` ${analysis.retry_guidance}`;

        return {
          content: [{ type: "text", text: summary }],
          structuredContent: {
            ...analysis,
            majority_orientation: majorityOrientation,
          },
        };
      }

      case "create_signature": {
        const { name, display_name, image_path, image_data_url, overwrite = false } = args;
        const cleanName = validateSignatureName(name);
        const cleanDisplayName = typeof display_name === "string" ? display_name.trim() : "";
        if (cleanDisplayName.length > 120) {
          throw new Error("display_name is too long (>120 chars).");
        }
        const imageSourcesProvided = [image_path, image_data_url].filter(Boolean).length;
        const typedOnly = cleanDisplayName.length > 0 && imageSourcesProvided === 0;
        if (!typedOnly && imageSourcesProvided === 0) {
          throw new Error("Provide either display_name for a typed signature, or exactly one image source: image_path or image_data_url.");
        }
        if (imageSourcesProvided > 1) {
          throw new Error("Provide only one image source: image_path or image_data_url.");
        }

        const slug = cleanName.replace(/\s+/g, "-");
        const sigPath = path.join(SIGNATURES_DIR, `${slug}.json`);

        if (!overwrite) {
          let alreadyExists = false;
          try {
            await fs.access(sigPath);
            alreadyExists = true;
          } catch (err) {
            if (err.code !== "ENOENT") throw err;
          }
          if (alreadyExists) {
            throw new Error(`Signature "${cleanName}" already exists. Use overwrite=true to replace it.`);
          }
        }

        let signatureRecord;
        if (typedOnly) {
          signatureRecord = {
            name: cleanName,
            style: "typed",
            display_name: cleanDisplayName,
            created_at: new Date().toISOString(),
          };
        } else if (image_path) {
          const resolvedImgPath = resolvePath(image_path);
          const imgBytes = await fs.readFile(resolvedImgPath);
          const ext = path.extname(resolvedImgPath).toLowerCase();
          let mime;
          if (ext === ".png" || imgBytes.subarray(0, 8).toString("hex") === "89504e470d0a1a0a") mime = "image/png";
          else if (ext === ".jpg" || ext === ".jpeg" || imgBytes.subarray(0, 3).toString("hex") === "ffd8ff") mime = "image/jpeg";
          else throw new Error(`Unsupported image format: "${ext}". Use PNG or JPEG.`);
          signatureRecord = {
            name: cleanName,
            style: "image",
            image_mime: mime,
            image_data_b64: imgBytes.toString("base64"),
            ...(cleanDisplayName ? { display_name: cleanDisplayName } : {}),
            source_path: resolvedImgPath,
            created_at: new Date().toISOString(),
          };
        } else {
          const { mime, bytes } = parseImageDataUrl(image_data_url);
          signatureRecord = {
            name: cleanName,
            style: "image",
            image_mime: mime,
            image_data_b64: bytes.toString("base64"),
            ...(cleanDisplayName ? { display_name: cleanDisplayName } : {}),
            created_at: new Date().toISOString(),
          };
        }

        signatureRecord = await normalizeStoredSignatureRecord(signatureRecord);
        await fs.writeFile(sigPath, JSON.stringify(signatureRecord, null, 2));
        const bytesOnDisk = (await fs.stat(sigPath)).size;
        return {
          content: [{
            type: "text",
            text:
              `Signature saved: "${cleanName}" (${signatureRecord.style})\n` +
              `Location: ${sigPath}\n` +
              `Use apply_signature with signature_name="${cleanName}" to stamp it onto a PDF.`
          }],
          structuredContent: {
            name: cleanName,
            style: signatureRecord.style,
            path: sigPath,
            bytes: bytesOnDisk,
          },
        };
      }

      case "get_allowed_directories": {
        // Reporting the boundary is not reaching past it, so this answers even
        // when nothing is configured — which is exactly when it is most needed.
        const directories = ALLOWED_DIRECTORIES.map(directory => directory.display);
        const configured = directories.length > 0;
        const summary = configured
          ? `Allowed folders (${ALLOWED_DIRECTORY_SOURCE.replace(/_/g, " ")}):\n${directories.join("\n")}`
            + (ALLOWED_DIRECTORY_SOURCE === "plugin_workspace"
              ? "\nYour host may copy files you select into this private workspace. To grant PDF Tools direct access to other folders, edit the config file and restart."
              : "")
          : `No folders are allowed yet. List them in ${HOME_CONFIG_PATH} under "allowedDirectories", then restart this server.`
            + (PLUGIN_DATA_CONFIG_PATH
              ? ` A plugin-specific file at ${PLUGIN_DATA_CONFIG_PATH} takes precedence when present.`
              : "");

        return {
          content: [{ type: "text", text: summary }],
          structuredContent: {
            directories,
            configured,
            source: ALLOWED_DIRECTORY_SOURCE,
            config_path: ALLOWED_DIRECTORY_CONFIG_PATH ?? null,
          },
        };
      }

      case "list_signatures": {
        let files;
        try {
          files = await fs.readdir(SIGNATURES_DIR);
        } catch (err) {
          if (err.code === "ENOENT") {
            return {
              content: [{ type: "text", text: "No signatures yet. Use create_signature to save one." }],
              structuredContent: { signatures: [], unreadable: [], malformed: [] },
            };
          }
          throw err;
        }
        const entries = [];
        // A file that exists but cannot be read is not an absent signature.
        // Folding the two together answers "No signatures yet" over a store
        // that still holds the user's signatures, and recommends the one
        // action a user who already has them does not want. Keep the two
        // apart: a record that cannot be parsed is skipped as before, a file
        // that cannot be read is reported with the errno that explains it.
        const unreadable = [];
        const malformed = [];
        for (const file of files) {
          if (!file.endsWith(".json")) continue;
          let raw;
          try {
            raw = await fs.readFile(path.join(SIGNATURES_DIR, file), "utf8");
          } catch (readError) {
            unreadable.push({ file, code: readError.code ?? null });
            continue;
          }
          try {
            const rec = JSON.parse(raw);
            const summary = await normalizeStoredSignatureSummary(rec);
            if (file !== `${summary.name.replace(/\s+/g, "-")}.json`) {
              throw new Error("Stored signature filename does not match its record name.");
            }
            if (summary.name.startsWith("__pdf-tools-quick-")) {
              continue;
            }
            entries.push(summary);
          } catch {
            malformed.push({ file });
          }
        }
        entries.sort((a, b) => (b.created_at || "").localeCompare(a.created_at || ""));
        const notes = [];
        if (unreadable.length > 0) {
          const named = unreadable.map(e => (e.code ? `${e.file} (${e.code})` : e.file)).join(", ");
          notes.push(
            `Could not read ${unreadable.length} file${unreadable.length === 1 ? "" : "s"} in `
            + `${SIGNATURES_DIR}: ${named}. Any signature stored there still exists and is not `
            + `listed above.`
          );
        }
        if (malformed.length > 0) {
          const named = malformed.map(e => e.file).join(", ");
          notes.push(
            `Skipped ${malformed.length} file${malformed.length === 1 ? "" : "s"} in `
            + `${SIGNATURES_DIR} that could not be parsed as a signature record: ${named}.`
          );
        }
        if (entries.length === 0) {
          return {
            content: [{
              type: "text",
              text: notes.length === 0
                ? "No signatures yet. Use create_signature to save one."
                : ["No signatures could be listed.", ...notes].join("\n"),
            }],
            structuredContent: { signatures: [], unreadable, malformed },
          };
        }
        const lines = entries.map(e =>
          `  • ${e.name} (${e.style}${e.display_name ? ` — "${e.display_name}"` : ""})` +
          (e.created_at ? ` — ${e.created_at}` : "")
        );
        return {
          content: [{
            type: "text",
            text: [`Saved signatures (${entries.length}):\n${lines.join("\n")}`, ...notes].join("\n\n")
          }],
          structuredContent: { signatures: entries, unreadable, malformed },
        };
      }

      case "load_signature": {
        const { signature_name } = args;
        const cleanSigName = validateSignatureName(signature_name);
        const sigSlug = cleanSigName.replace(/\s+/g, "-");
        const sigPath = path.join(SIGNATURES_DIR, `${sigSlug}.json`);
        let rec;
        try {
          rec = JSON.parse(await fs.readFile(sigPath, "utf8"));
        } catch (err) {
          if (err.code === "ENOENT") {
            throw new Error(`Signature "${cleanSigName}" not found. Use create_signature to save it first, or list_signatures to see available ones.`);
          }
          throw err;
        }
        const normalizedRecord = await normalizeStoredSignatureRecord(rec, cleanSigName);
        const summary = {
          name: normalizedRecord.name,
          style: normalizedRecord.style,
          display_name: normalizedRecord.display_name,
          created_at: normalizedRecord.created_at,
        };
        const previewDataUrl = normalizedRecord.style === "image"
          ? `data:${normalizedRecord.image_mime};base64,${normalizedRecord.image_data_b64}`
          : null;
        return {
          content: [{
            type: "text",
            text: `Loaded signature "${cleanSigName}" (${normalizedRecord.style}).`
          }],
          structuredContent: {
            name: summary.name,
            style: summary.style,
            display_name: summary.display_name,
            preview_data_url: previewDataUrl,
            created_at: summary.created_at,
          },
        };
      }

      case "add_signature_field": {
        const {
          pdf_path, output_path, page, x, y, width, height, label,
          allow_resign, password, force_xfa, expected_output_identity,
        } = normalizeAddSignatureFieldArguments(args);
        const resolvedOutput = resolvePath(output_path);
        const resolvedInput = resolvePath(pdf_path);
        const recoveredInput = await readPdfInputWithRecovery(pdf_path);
        const { pdfBytes, inputRecoveryBinding } = recoveredInput;
        assertXfaMutationAllowed(pdfBytes, { forceXfa: force_xfa });
        const { payload, backupPath } = await runPdfLibMutation({
          operation: "add_signature_field",
          sources: [bindRecoveredMutationSource(recoveredInput)],
          password,
          force_xfa: force_xfa === true,
          options: {
            placement: { page, x, y, width, height, label },
            allow_resign,
          },
        }, ({ result, outputs, atomicTransition }) => persistPdfMutation({
            mutationOutput: { ...outputs[0], atomicTransition },
            formInfo: result.form_info,
            inputPath: resolvedInput,
            outputPath: resolvedOutput,
            toolName: "add_signature_field",
            expectedInputSha256: sha256Bytes(pdfBytes),
            expectedOutputIdentity: expected_output_identity,
            inputRecoveryBinding,
            initialPage: page,
          }));
        return {
          content: [{
            type: "text",
            text:
              `Added signature field to page ${page} at (${x}, ${y}) — ${width}x${height} pts\n` +
              `Output: ${resolvedOutput}\n` +
              (backupPath ? `Original backed up to: ${backupPath}\n` : "") +
              `The field is a visible placeholder; use apply_signature to stamp a signature there.`
          }],
          structuredContent: {
            ...payload,
            pdf_path: resolvedOutput,
            page, x, y, width, height,
            label,
          },
          _meta: {
            ui: { resourceUri: "ui://pdf-toolkit/viewer" },
            ...payload,
          }
        };
      }

      case "apply_signature": {
        const {
          pdf_path, output_path, signature_name,
          page, x, y, width, height,
          user_intent_statement, user_confirmed_at,
          draw_audit_line,
          signing_mode,
          allow_resign,
          force_xfa,
          password,
          expected_output_identity,
          legacy_overwrite,
        } = normalizeApplySignatureArguments(args);

        const resolvedOutput = resolvePath(output_path);
        const resolvedInput = resolvePath(pdf_path);

        // 1. Validate intent — rejects missing/stale/invented intent signals
        const { statement, confirmedAt } = validateSigningIntent({ user_intent_statement, user_confirmed_at });

        // 2. Load the signature record
        const cleanSigName = validateSignatureName(signature_name);
        const sigSlug = cleanSigName.replace(/\s+/g, "-");
        const sigPath = path.join(SIGNATURES_DIR, `${sigSlug}.json`);
        let signatureRecord;
        try {
          signatureRecord = JSON.parse(await fs.readFile(sigPath, "utf8"));
        } catch (err) {
          if (err.code === "ENOENT") {
            throw new Error(`Signature "${cleanSigName}" not found. Use create_signature to save it first, or list_signatures to see available ones.`);
          }
          throw err;
        }
        signatureRecord = await normalizeStoredSignatureRecord(signatureRecord, cleanSigName);

        // 3. Bind the PDF without parsing it in the long-lived server.
        const recoveredInput = await readPdfInputWithRecovery(pdf_path);
        const { pdfBytes, inputRecoveryBinding } = recoveredInput;

        // 3b. Refuse to silently strip XFA data.
        assertXfaMutationAllowed(pdfBytes, { forceXfa: force_xfa });

        // 4. Stamp
        const displayName = signatureRecord.display_name || signatureRecord.name;
        const auditVerb = signing_mode === "initials" ? "Initialed" : "Signed";
        const auditAction = signing_mode === "initials" ? "initialed" : "signed";
        const auditText = draw_audit_line
          ? `${auditVerb} by ${displayName} at ${confirmedAt.toISOString()}`
          : "";
        const auditLine = formatSigningAuditLine({
          display_name: displayName,
          statement,
          confirmedAt,
          action: auditAction,
        });
        const modificationAt = new Date().toISOString();
        const { payload, backupPath } = await runPdfLibMutation({
          operation: "apply_signature",
          sources: [bindRecoveredMutationSource(recoveredInput)],
          password,
          force_xfa: force_xfa === true,
          options: {
            signature: signatureRecord,
            placement: { page, x, y, width, height },
            draw_audit_line,
            audit_text: auditText,
            audit_line: auditLine,
            modification_at: modificationAt,
            allow_resign,
          },
        }, ({ result, outputs, atomicTransition }) => persistPdfMutation({
            mutationOutput: { ...outputs[0], atomicTransition },
            formInfo: result.form_info,
            inputPath: resolvedInput,
            outputPath: resolvedOutput,
            toolName: "apply_signature",
            expectedInputSha256: sha256Bytes(pdfBytes),
            expectedOutputIdentity: expected_output_identity,
            legacyOverwrite: legacy_overwrite,
            inputRecoveryBinding,
            initialPage: page,
          }));

        return {
          content: [{
            type: "text",
            text:
              `${auditVerb}: "${displayName}" stamped on page ${page} at (${x}, ${y})\n` +
              `Output: ${resolvedOutput}\n` +
              (backupPath ? `Original backed up to: ${backupPath}\n` : "") +
              `Audit trail: ${auditLine}\n\n` +
              `NOTE: This is a basic visible stamp, not a cryptographic signature. ` +
              `For legally-binding signing, use a compliance-grade service.`
          }],
          structuredContent: {
            ...payload,
            pdf_path: resolvedOutput,
            signature_name: cleanSigName,
            page, x, y, width, height,
            signer: displayName,
            confirmed_at: confirmedAt.toISOString(),
            intent_statement: statement,
            signing_mode,
            tier: "basic-local-stamp",
          },
        };
      }

      case "prepare_signing_packet": {
        const {
          pdf_path, output_path, field_values, signature_locations,
          allow_resign, password, force_xfa, require_provider_ready, expected_output_identity,
        } = normalizePrepareSigningPacketArguments(args);
        const resolvedOutput = resolvePath(output_path);
        const resolvedInput = resolvePath(pdf_path);

        const recoveredInput = await readPdfInputWithRecovery(pdf_path);
        const { pdfBytes, inputRecoveryBinding } = recoveredInput;
        const xfaPresent = detectXfaForm(pdfBytes);
        assertXfaMutationAllowed(pdfBytes, { forceXfa: force_xfa });
        const zones = signature_locations.map(loc => ({ ...loc }));
        const manifest = zones.map(({ page, x, y, width, height, label }) => ({
          page, x, y, width, height, label,
        }));
        const prepared = await runPdfLibMutation({
          operation: "prepare_signing_packet",
          sources: [bindRecoveredMutationSource(recoveredInput)],
          password,
          force_xfa: force_xfa === true,
          options: {
            field_values: field_values ?? {},
            signature_locations: zones,
            allow_resign,
            require_provider_ready,
          },
        }, async ({ result, outputs, atomicTransition }) => {
          const committed = await persistPdfMutation({
            mutationOutput: { ...outputs[0], atomicTransition },
            formInfo: result.form_info,
            inputPath: resolvedInput,
            outputPath: resolvedOutput,
            toolName: "prepare_signing_packet",
            expectedInputSha256: sha256Bytes(pdfBytes),
            expectedOutputIdentity: expected_output_identity,
            inputRecoveryBinding,
            initialPage: manifest[0]?.page || 1,
            extraPayload: {
              pending_signatures: manifest,
              filled_count: result.filled_count,
              fill_errors: result.fill_errors,
            },
          });
          const preparationReceipt = await buildSigningPreparationReceipt({
            recoveredInput,
            resolvedOutput,
            backupPath: committed.backupPath,
            result,
            zones,
            allowResign: allow_resign,
            forceXfa: force_xfa,
            xfaPresent,
            expectedOutputIdentity: expected_output_identity,
          });
          return {
            ...committed,
            payload: { ...committed.payload, preparation_receipt: preparationReceipt },
            filledCount: result.filled_count,
            fillErrors: result.fill_errors,
            preparationReceipt,
          };
        });
        const {
          payload, backupPath, filledCount, fillErrors, preparationReceipt,
        } = prepared;

        const summary =
          `Prepared signing packet: ${path.basename(resolvedOutput)}\n` +
          `  Filled: ${filledCount} field${filledCount === 1 ? "" : "s"}\n` +
          (fillErrors.length ? `  Errors: ${fillErrors.length} (${fillErrors.slice(0,3).map(e => e.field).join(", ")})\n` : "") +
          (backupPath ? `  Backup: ${backupPath}\n` : "") +
          `  Signature fields added: ${manifest.length}\n` +
          `  Provider handoff: ${preparationReceipt.handoff_status}\n` +
          `  Provider execution: not requested\n` +
          `  Output: ${resolvedOutput}`;

        return {
          content: [{ type: "text", text: summary }],
          structuredContent: {
            ...payload,
            pdf_path: resolvedOutput,
            filled_count: filledCount,
            fill_errors: fillErrors,
            pending_signatures: manifest,
            preparation_receipt: preparationReceipt,
          },
          _meta: {
            ui: { resourceUri: "ui://pdf-toolkit/viewer" },
            ...payload,
          }
        };
      }

      case "apply_text": {
        const {
          pdf_path, output_path,
          page, x, y, width, height,
          text, font_style,
          allow_resign,
          force_xfa,
          password,
          expected_output_identity,
          legacy_overwrite,
        } = normalizeApplyTextArguments(args);

        const resolvedOutput = resolvePath(output_path);
        const resolvedInput = resolvePath(pdf_path);

        const recoveredInput = await readPdfInputWithRecovery(pdf_path);
        const { pdfBytes, inputRecoveryBinding } = recoveredInput;
        assertXfaMutationAllowed(pdfBytes, { forceXfa: force_xfa });

        // Short audit line so filling dates/initials shows up in Keywords.
        const modificationAt = new Date().toISOString();
        const auditLine = `stamped text via pdf-toolkit; text="${String(text).replace(/\s+/g, " ").slice(0, 80)}"; at=${modificationAt}; page=${page}`;
        const { payload, backupPath } = await runPdfLibMutation({
          operation: "apply_text",
          sources: [bindRecoveredMutationSource(recoveredInput)],
          password,
          force_xfa: force_xfa === true,
          options: {
            placement: { page, x, y, width, height },
            text,
            font_style,
            audit_line: auditLine,
            modification_at: modificationAt,
            allow_resign,
          },
        }, ({ result, outputs, atomicTransition }) => persistPdfMutation({
            mutationOutput: { ...outputs[0], atomicTransition },
            formInfo: result.form_info,
            inputPath: resolvedInput,
            outputPath: resolvedOutput,
            toolName: "apply_text",
            expectedInputSha256: sha256Bytes(pdfBytes),
            expectedOutputIdentity: expected_output_identity,
            legacyOverwrite: legacy_overwrite,
            inputRecoveryBinding,
            initialPage: page,
          }));

        return {
          content: [{
            type: "text",
            text:
              `Stamped text "${text}" on page ${page} at (${x}, ${y}).\n` +
              (backupPath ? `Original backed up to: ${backupPath}\n` : "") +
              `Output: ${resolvedOutput}`
          }],
          structuredContent: {
            ...payload,
            pdf_path: resolvedOutput,
            page, x, y, width, height,
            text,
          },
        };
      }

      case "detect_signature_zones": {
        const { pdf_path, password } = args;
        const resolvedPath = resolvePath(pdf_path);
        const warningMessages = {
          ACROFORM_WIDGET_PAGE_UNRESOLVED: "Skipped an AcroForm signing widget because its page could not be resolved. No page location was guessed.",
          ENCRYPTED_ACROFORM_SCAN_UNAVAILABLE: "Encrypted PDF zone detection used the authenticated text layer. AcroForm widgets were not scanned.",
          TEXT_EXTRACTION_UNAVAILABLE: "Text labels could not be scanned. No text-derived zones were returned.",
        };
        const warningCounts = new Map();
        const recordWarningOccurrences = (code, occurrences) => {
          if (!Object.hasOwn(warningMessages, code) || !Number.isSafeInteger(occurrences)) return;
          warningCounts.set(
            code,
            Math.min((warningCounts.get(code) || 0) + Math.max(0, occurrences), 1000000),
          );
        };
        let workerResult;
        try {
          ({ result: workerResult } = await runPdfjsOperation(resolvedPath, {
            operation: "detect_signature_zones",
            password,
            options: {},
          }));
        } catch (error) {
          if (error?.code === PDF_RESOURCE_LIMIT_CODE) throw error;
          const passwordCode = ["PASSWORD_REQUIRED", "PASSWORD_INCORRECT"].includes(error?.code)
            ? error.code
            : null;
          if (passwordCode) {
            const message = passwordCode === "PASSWORD_REQUIRED"
              ? "This PDF requires a password. Provide it with the password parameter and try again."
              : "The PDF password was not accepted. Check the password and try again.";
            return {
              isError: true,
              content: [{ type: "text", text: message }],
              structuredContent: {
                status: "failed",
                error: { error_schema_version: 1, code: passwordCode },
              },
            };
          }
          throw error;
        }
        const zones = workerResult.zones;
        for (const warning of workerResult.warning_counts) {
          recordWarningOccurrences(warning.code, warning.occurrences);
        }
        const warnings = [...warningCounts.entries()]
          .map(([code, occurrences]) => ({
            code,
            message: warningMessages[code],
            occurrences,
          }));

        const byType = zones.reduce((acc, z) => {
          acc[z.type] = (acc[z.type] || 0) + 1;
          return acc;
        }, {});
        const resultSummary = zones.length === 0
          ? `No signature zones detected in ${path.basename(pdf_path)}. The form may be flat, scanned, or use an unusual layout. Ask the user to pick a signature location in the viewer.`
          : `Found ${zones.length} zone(s) in ${path.basename(pdf_path)}: ` +
            Object.entries(byType).map(([t, n]) => `${n} ${t}${n === 1 ? "" : "s"}`).join(", ") +
            `.\n\nDetected zones (top-left origin, points; use these exact coordinates, do not guess):\n` +
            zones.map((z, idx) => (
              `${idx + 1}. ${z.type.toUpperCase()} p${z.page} ` +
              `x=${Number(z.x).toFixed(1)} y=${Number(z.y).toFixed(1)} ` +
              `width=${Number(z.width).toFixed(1)} height=${Number(z.height).toFixed(1)} ` +
              `label="${z.label || ""}" confidence=${Number(z.confidence ?? 0).toFixed(2)} source=${z.source || "unknown"}`
            )).join("\n") +
            `\n\nUse apply_signature at returned SIGNATURE and INITIALS zones. Use apply_text at returned NAME and DATE zones.`;
        const warningSummary = warnings.length === 0
          ? ""
          : `\n\nDetection warnings:\n${warnings.map(warning =>
              `- ${warning.message} Occurrences: ${warning.occurrences}.`
            ).join("\n")}`;

        // Zone coordinates are top-left origin relative to each page's
        // MediaBox. A consumer that renders them has to know that box, and
        // PDF.js only exposes the view (CropBox intersected with MediaBox), so
        // it cannot derive the MediaBox itself. Without this, an overlay drawn
        // on a page whose CropBox differs from its MediaBox is displaced by the
        // difference between the two boxes.
        const pageGeometry = workerResult.page_geometry;

        return {
          content: [{ type: "text", text: resultSummary + warningSummary }],
          structuredContent: {
            detection_status: warnings.length > 0 ? "partial" : "complete",
            zones,
            warnings,
            page_geometry: pageGeometry,
          },
        };
      }

      case "fetch_pdf_from_url": {
        const {
          url,
          filename,
          destination_dir,
          overwrite = false,
          expected_output_identity,
          max_size_mb = 100,
          headers,
          allow_private_hosts = false,
        } = args;

        if (!url || typeof url !== "string") {
          throw new Error("'url' is required and must be a string.");
        }
        const expectedOutputIdentity = normalizeExpectedOutputIdentity(
          expected_output_identity,
        );
        if (overwrite !== (expectedOutputIdentity !== null)) {
          throw new Error(
            "OUTPUT_IDENTITY_REQUIRED: overwrite=true requires the exact current expected_output_identity, and an expected identity requires overwrite=true.",
          );
        }

        // Destination directory priority:
        //   1. caller-supplied destination_dir (one-off override)
        //   2. user_config.download_directory from the extension settings UI
        //   3. helper's internal default (~/Downloads)
        const resolvedDestDir = resolvePath(destination_dir || DEFAULT_DOWNLOAD_DIRECTORY);

        const result = await downloadPdfFromUrl(url, {
          filename,
          destinationDir: resolvedDestDir,
          overwrite,
          expectedOutputIdentity,
          maxSizeMb: max_size_mb,
          headers: headers || {},
          allowPrivateHosts: allow_private_hosts,
          assertPathAllowed,
        });
        noteDocumentOpened(result.path);

        const sizeKb = (result.bytes / 1024).toFixed(0);
        const payload = await buildActiveDocumentPayload(result.path);
        return {
          content: [{
            type: "text",
            text:
              `Downloaded ${sizeKb} KB to:\n${result.path}\n\n` +
              `Source: ${result.sourceUrl}\n` +
              `You can now pass this path to read_pdf_fields, fill_pdf, validate_pdf, or any other PDF tool.`
          }],
          structuredContent: {
            ...payload,
            pdf_path: result.path,
            bytes: result.bytes,
            content_type: result.contentType,
            source_url: result.sourceUrl,
          },
        };
      }

      case "reveal_in_finder": {
        const rawPath = args?.path;
        if (!rawPath || typeof rawPath !== "string") {
          throw new Error("'path' is required and must be a string.");
        }
        // The canonical path is what gets handed to a platform process, so a
        // link cannot make that process act on a file outside the allowed set.
        const resolved = resolveCanonicalPath(rawPath);
        // Existence check first — better error than spawn failure.
        let revealStat;
        try { revealStat = await fs.lstat(resolved); } catch {
          throw new Error(`File not found: ${resolved}`);
        }
        if (revealStat.isSymbolicLink()) {
          throw new Error(`Not a regular file or folder: ${path.basename(resolved)}`);
        }

        const plat = osPlatform();
        let cmd, cmdArgs;
        if (plat === "darwin") {
          cmd = "open";
          cmdArgs = ["-R", resolved];
        } else if (plat === "win32") {
          cmd = "explorer.exe";
          // /select, must be a single argv entry with the path joined.
          cmdArgs = [`/select,${resolved}`];
        } else {
          // Linux / other POSIX — best-effort: open the enclosing directory.
          cmd = "xdg-open";
          cmdArgs = [path.dirname(resolved)];
        }

        await new Promise((resolve, reject) => {
          const child = spawn(cmd, cmdArgs, { stdio: "ignore", detached: true });
          child.on("error", reject);
          // Detach so the child outlives this handler.
          child.unref();
          // We don't wait for exit on detached GUI launchers (they fork-and-return).
          resolve();
        });

        return {
          content: [{ type: "text", text: `Revealed ${resolved}` }],
          structuredContent: { path: resolved, platform: plat },
        };
      }

      default:
        throw new Error(`Unknown tool: ${name}`);
    }
  } catch (error) {
    let errorCode = error?.code === "path_policy_denied"
      ? "path_policy_denied"
      : "tool_execution_failed";
    if (LUMIN_SIGNING_TOOL_NAME_SET.has(name) && /^LUMIN_[A-Z0-9_]+$/.test(error?.code ?? "")) {
      errorCode = error.code;
    }
    if (
      error?.code === PDF_RESOURCE_LIMIT_CODE
      && (PDFJS_TOOL_NAMES.has(name) || PDF_LIB_MUTATION_TOOL_NAMES.has(name))
    ) {
      errorCode = PDF_RESOURCE_LIMIT_CODE;
    }
    if (name === "get_pdf_identity") {
      if ([
        "PDF_CHANGED_DURING_READ",
        "PDF_INPUT_TOO_LARGE",
        "PDF_INVALID_HEADER",
      ].includes(error?.code)) {
        errorCode = error.code;
      } else if (["ENOENT", "ENOTDIR", "EACCES", "EPERM"].includes(error?.code)) {
        errorCode = "PDF_UNAVAILABLE";
      }
    }
    return createTypedToolError({
      message: `Error: ${error.message}`,
      code: errorCode,
    });
  }
}

async function callTool(request) {
  return validateStructuredToolResult(request.params.name, await handleToolCall(request));
}

// Resource handlers for PDFs
async function listResources(request) {
  rejectUnissuedCursor(request, "resources/list");
  console.error(`[Resources] ListResourcesRequest received`);
  return {
    resources: [
      {
        uri: "ui://pdf-toolkit/viewer",
        name: "PDF Form Viewer",
        mimeType: "text/html;profile=mcp-app"
      }
    ]
  };
}

async function readResource(request) {
  const { uri } = request.params;
  console.error(`[Resources] ReadResourceRequest for URI: ${uri}`);

  // Handle UI resource requests (MCP Apps)
  if (uri === "ui://pdf-toolkit/viewer") {
    const htmlPath = path.join(
      path.dirname(fileURLToPath(import.meta.url)),
      "..",
      "dist-ui",
      "index.html"
    );
    console.error(`[Resources] Reading UI resource from: ${htmlPath}`);
    const html = await fs.readFile(htmlPath, "utf-8");
    return {
      contents: [{
        uri,
        mimeType: "text/html;profile=mcp-app",
        text: html
      }]
    };
  }

  let pdfPath;
  try {
    pdfPath = pdfResourceUriToPath(uri);
  } catch (error) {
    console.error(`[Resources] Invalid PDF resource URI: ${error.message}`);
    throw new McpError(ErrorCode.InvalidParams, `Invalid PDF resource URI: ${error.message}`);
  }

  let resolvedPath;
  try {
    if (!path.isAbsolute(pdfPath)) {
      throw new Error("Resource path is not absolute on this host");
    }
    resolvedPath = resolvePath(pdfPath);
  } catch {
    throw new ResourceNotFoundError(uri, "PDF resource not found");
  }
  console.error(`[Resources] Reading PDF from path: ${pdfPath} -> ${resolvedPath}`);
  
  try {
    // Read the PDF file
    const pdfBytes = await fs.readFile(resolvedPath);
    const fileName = path.basename(resolvedPath);
    console.error(`[Resources] Successfully read PDF: ${fileName} (${pdfBytes.length} bytes)`);
    
    // Return the PDF as blob content
    const response = {
      contents: [
        {
          uri: uri,
          mimeType: "application/pdf",
          blob: pdfBytes.toString("base64")
        }
      ]
    };
    console.error(`[Resources] Returning blob content with ${response.contents[0].blob.length} base64 chars`);
    return response;
  } catch (error) {
    console.error(`[Resources] Error reading PDF: ${error.message}`);
    if (isUnavailableResourceError(error)) {
      throw new ResourceNotFoundError(uri, "PDF resource not found");
    }
    throw error;
  }
}

async function listPrompts(request) {
  rejectUnissuedCursor(request, "prompts/list");
  return {
    prompts: PROMPT_TEMPLATES.map(prompt => ({
      name: prompt.name,
      description: prompt.description,
      ...(prompt.arguments.length > 0 ? {
        arguments: prompt.arguments.map(name => ({ name, required: true })),
      } : {}),
    })),
  };
}

async function getPrompt(request) {
  const prompt = PROMPT_TEMPLATES.find(candidate => candidate.name === request.params.name);
  if (!prompt) {
    throw new McpError(ErrorCode.InvalidParams, `Unknown prompt: ${request.params.name}`);
  }

  return {
    description: prompt.description,
    messages: [{
      role: "user",
      content: {
        type: "text",
        text: renderPromptTemplate(prompt, request.params.arguments),
      },
    }],
  };
}

function buildPdfToolsServer({ era }) {
  const skills = era === "modern" ? loadSkills() : null;
  const server = new Server(
    {
      name: "pdf-tools",
      version: "0.14.0",
    },
    {
      capabilities: {
        tools: {},
        resources: {},
        prompts: {},
        ...(skills ? { extensions: { [SKILLS_EXTENSION]: {} } } : {}),
      },
    },
  );

  server.setRequestHandler("tools/list", listTools);
  server.setRequestHandler("tools/call", async (request) =>
    server.projectCallToolResult(
      await callTool(request),
      TOOL_OUTPUT_SCHEMAS[request.params.name],
    ));
  server.setRequestHandler("resources/list", async request => {
    const result = await listResources(request);
    if (skills) result.resources.push(...skills.resources());
    return result;
  });
  server.setRequestHandler("resources/read", request => {
    if (skills && request.params.uri.startsWith("skill:")) return skills.read(request.params.uri);
    return readResource(request);
  });
  if (skills) {
    server.setRequestHandler("skills/list", { params: skillParams("list") }, () => skills.list());
    server.setRequestHandler("skills/get", { params: skillParams("get") }, params => skills.get(params.uri));
  }
  server.setRequestHandler("prompts/list", listPrompts);
  server.setRequestHandler("prompts/get", getPrompt);
  return server;
}

// Initialize and start the server
async function main() {
  // Ensure profiles and signatures directories exist
  for (const directory of [PROFILES_DIR, SIGNATURES_DIR, BACKUPS_DIR]) {
    await fs.mkdir(directory, { recursive: true, mode: 0o700 }).catch(() => {});
    await fs.chmod(directory, 0o700).catch(() => {});
  }

  // Migrate profiles from old directory (~/.pdf-filler-profiles) if it exists
  try {
    const oldFiles = await fs.readdir(OLD_PROFILES_DIR);
    const jsonFiles = oldFiles.filter(f => f.endsWith(".json"));
    if (jsonFiles.length > 0) {
      let migrated = 0;
      for (const file of jsonFiles) {
        const dest = path.join(PROFILES_DIR, file);
        try {
          await fs.access(dest);
          // Already exists in new dir, skip
        } catch {
          await fs.copyFile(path.join(OLD_PROFILES_DIR, file), dest);
          migrated++;
        }
      }
      if (migrated > 0) {
        console.error(`[PDF Tools] Migrated ${migrated} profile(s) from ${OLD_PROFILES_DIR} to ${PROFILES_DIR}`);
      }
    }
  } catch {
    // Old directory doesn't exist — nothing to migrate
  }

  // Start one era-pinned server instance per stdio connection. The factory is
  // side-effect free because a modern discovery probe may be discarded before
  // a legacy instance is pinned.
  serveStdio(buildPdfToolsServer, {
    legacy: "serve",
    onerror(error) {
      console.error(`[PDF Tools] MCP transport error: ${error.message}`);
    },
  });

  console.error("PDF Tools MCP server running...");
}

// Run the main function
main().catch((error) => {
  console.error("[PDF Tools] Fatal error:", error);
  console.error("[PDF Tools] Stack trace:", error.stack);
  process.exit(1);
});
