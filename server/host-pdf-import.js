import fs from "node:fs/promises";
import path from "node:path";
import { createHash, randomUUID } from "node:crypto";

// This is a transport cap, not a claim about the largest PDF the local tools
// can process. Check encoded length and decoded length before allocating bytes.
export const HOST_PDF_IMPORT_MAX_BYTES = 16 * 1024 * 1024;
export const HOST_PDF_IMPORT_MAX_BASE64_CHARS = 4 * Math.ceil(HOST_PDF_IMPORT_MAX_BYTES / 3);

function importError(code, message, cause) {
  const error = new Error(message, cause ? { cause } : undefined);
  error.code = code;
  return error;
}

export function decodeHostPdfImport(args) {
  if (!args || typeof args !== "object" || Array.isArray(args)
    || Object.keys(args).some(key => !["pdf_base64", "display_name"].includes(key))) {
    throw importError("HOST_IMPORT_INVALID_INPUT", "Host PDF import accepts only pdf_base64 and an optional inert display_name.");
  }
  const encoded = args.pdf_base64;
  if (typeof encoded !== "string" || encoded.length === 0) {
    throw importError("HOST_IMPORT_INVALID_INPUT", "pdf_base64 must be a nonempty canonical base64 string.");
  }
  if (encoded.length > HOST_PDF_IMPORT_MAX_BASE64_CHARS) {
    throw importError("HOST_IMPORT_TOO_LARGE", "Host PDF import accepts at most 16 MiB of PDF bytes.");
  }
  if (encoded.length % 4 !== 0 || !/^[A-Za-z0-9+/]*={0,2}$/.test(encoded)) {
    throw importError("HOST_IMPORT_INVALID_INPUT", "pdf_base64 must use canonical padded base64, without whitespace, a data URL, or URL-safe substitutions.");
  }
  const padding = encoded.endsWith("==") ? 2 : encoded.endsWith("=") ? 1 : 0;
  const sizeBytes = (encoded.length / 4) * 3 - padding;
  if (sizeBytes > HOST_PDF_IMPORT_MAX_BYTES) {
    throw importError("HOST_IMPORT_TOO_LARGE", "Host PDF import accepts at most 16 MiB of PDF bytes.");
  }
  const displayName = args.display_name === undefined ? "Imported PDF" : args.display_name;
  if (typeof displayName !== "string" || displayName.length === 0 || displayName.length > 255
    || /[\u0000-\u001f\u007f]/.test(displayName)) {
    throw importError("HOST_IMPORT_INVALID_INPUT", "display_name must be an inert label of 1 to 255 characters without control characters.");
  }
  const bytes = Buffer.from(encoded, "base64");
  // Buffer.from accepts nonzero unused bits. A round trip rejects them rather
  // than accepting multiple wire encodings of the same PDF.
  if (bytes.length !== sizeBytes || bytes.toString("base64") !== encoded) {
    throw importError("HOST_IMPORT_INVALID_INPUT", "pdf_base64 is not canonical base64.");
  }
  if (bytes.subarray(0, 1024).indexOf(Buffer.from("%PDF-", "ascii")) < 0) {
    throw importError("HOST_IMPORT_INVALID_PDF", "PDF input does not contain a %PDF- header within the first 1,024 bytes.");
  }
  return { bytes, displayName, sizeBytes, sha256: createHash("sha256").update(bytes).digest("hex") };
}

// The caller supplies the existing path policy and atomic writer. No URI,
// pathname, filename, or destination supplied by the host is used as a path.
export async function importHostPdf(args, {
  workspacePath,
  assertPathAllowed,
  validatePdf,
  writePdfOutputAtomic,
  hashPdfFile,
  makeId = randomUUID,
}) {
  const decoded = decodeHostPdfImport(args);
  const unavailable = cause => importError("HOST_IMPORT_WORKSPACE_UNAVAILABLE",
    "The private plugin workspace is unavailable or is outside the configured folder boundary. No fallback folder was used; keep using the host document or configure the private workspace explicitly.", cause);
  if (!workspacePath) throw unavailable();
  // Permission must precede mkdir and PDF parsing. Explicit folder overrides
  // replace the default workspace permission; import cannot widen that set.
  try { assertPathAllowed(workspacePath); } catch (cause) { throw unavailable(cause); }
  const pluginDataPath = path.dirname(workspacePath);
  let canonicalWorkspace;
  let workspaceIdentity;
  let canonicalPluginData;
  try {
    canonicalPluginData = await fs.realpath(pluginDataPath);
    try { await fs.mkdir(workspacePath, { mode: 0o700 }); } catch (error) {
      if (error.code !== "EEXIST") throw error;
    }
    const stats = await fs.lstat(workspacePath);
    canonicalWorkspace = await fs.realpath(workspacePath);
    if (!stats.isDirectory() || stats.isSymbolicLink()
      || canonicalWorkspace !== path.join(canonicalPluginData, "workspace")) throw unavailable();
    assertPathAllowed(canonicalWorkspace);
    workspaceIdentity = { dev: stats.dev, ino: stats.ino };
  } catch (cause) { throw unavailable(cause); }
  const guardWorkspace = async () => {
    try {
      const current = await fs.lstat(workspacePath);
      if (!current.isDirectory() || current.isSymbolicLink()
        || current.dev !== workspaceIdentity.dev || current.ino !== workspaceIdentity.ino
        || await fs.realpath(pluginDataPath) !== canonicalPluginData
        || await fs.realpath(workspacePath) !== canonicalWorkspace) throw unavailable();
      assertPathAllowed(canonicalWorkspace);
    } catch (cause) { throw unavailable(cause); }
  };
  let parsed;
  try { parsed = await validatePdf(decoded.bytes); } catch (cause) {
    if (cause?.code === "PDF_RESOURCE_LIMIT_EXCEEDED") throw cause;
    throw importError("HOST_IMPORT_INVALID_PDF", cause?.message || "The host PDF is malformed, encrypted, or unsupported.", cause);
  }
  const id = makeId();
  if (!/^[a-f0-9-]{36}$/.test(id)) throw importError("HOST_IMPORT_INVALID_INPUT", "Import identifier is invalid.");
  const destination = path.join(canonicalWorkspace, `host-import-${id}.pdf`);
  await guardWorkspace();
  const committed = await writePdfOutputAtomic(destination, decoded.bytes, {
    assertPathAllowed,
    beforeDirectoryGuard: guardWorkspace,
    overwrite: false,
  });
  await guardWorkspace();
  const identity = await hashPdfFile(committed.targetPath);
  if (identity.sha256 !== decoded.sha256 || identity.sizeBytes !== decoded.sizeBytes
    || identity.canonicalPath !== destination) {
    throw importError("HOST_IMPORT_SOURCE_CHANGED", "The imported PDF changed before its source identity could be returned. No document was opened.");
  }
  return { ...decoded, path: committed.targetPath, identity, parsed };
}
