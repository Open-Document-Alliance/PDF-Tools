/**
 * MCP Files extension (io.modelcontextprotocol/files) for the hosted server.
 * Design and privacy contract: docs/REMOTE_FILES_PROFILE_2026-11-25.md.
 *
 * Uploads: a tool call with an `upload` argument (metadata only) answers
 * `upload_required` with a presigned target and a sealed requestState. The
 * repeated call with that state is checked against the original call, the
 * stored object is confirmed and taken (read and deleted, which is also what
 * makes a replay fail), and the tool runs on those bytes.
 *
 * Downloads: when the call declared `download`, a returned PDF is written to
 * the store and offered as a download target instead of inline base64.
 */
import { createHash, randomBytes } from "node:crypto";

import { open, seal } from "./sealed.mjs";

export const FILES_EXTENSION = "io.modelcontextprotocol/files";
export const MAX_UPLOAD_BYTES = 25 * 1024 * 1024;
const UPLOAD_TARGET_SECONDS = 20 * 60;
const STATE_SECONDS = 60 * 60;
const DOWNLOAD_SECONDS = 60 * 60;
const ID_PATTERN = /^[\x21-\x7e]{1,128}$/;
const DIGEST_PATTERN = /^[A-Za-z0-9_-]{43}$/;

export const UPLOAD_PROPERTY = Object.freeze({
  type: "object",
  description: "A PDF the host uploads directly to this service's transfer storage (MCP Files). Use instead of file, pdf_url or pdf_base64.",
  "x-mcp-file": { accept: ["application/pdf"], maxSize: MAX_UPLOAD_BYTES },
  properties: {
    id: { type: "string" },
    name: { type: "string" },
    mimeType: { type: "string" },
    size: { type: "integer", minimum: 0 },
    digest: { type: "object", properties: { algorithm: { type: "string" }, value: { type: "string" } } },
  },
  required: ["id", "mimeType", "size"],
});

class FilesProtocolError extends Error {
  constructor(message) { super(message); this.code = -32602; }
}

const refusal = (code, message) => ({ isError: true, content: [{ type: "text", text: `${code}: ${message}` }] });

/** Canonical JSON digest of the call's arguments, so the repeat must be the same call. */
function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value && typeof value === "object") return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(",")}}`;
  return JSON.stringify(value);
}
const argsDigest = (name, args, principal) => createHash("sha256").update(`pdf-tools.files.call.v1\0${name}\0${principal}\0${canonicalJson(args)}`).digest("base64url");

/** What this call's client declared for the extension, read on every call. */
export function declaredFiles(envelope) {
  const declared = envelope?.["io.modelcontextprotocol/clientCapabilities"]?.extensions?.[FILES_EXTENSION];
  return { upload: Boolean(declared?.upload), download: Boolean(declared?.download) };
}

export function createFilesHandler({ store, keys, principal = "public" }) {
  return {
    capability: { upload: {} },

    /**
     * Handle a call that carries `upload`. `run(argsWithBytes)` dispatches the
     * tool once the bytes are confirmed.
     */
    async handleUpload({ name, args, requestState, declared, nowSeconds, run }) {
      if (!declared.upload) return refusal("UPLOAD_UNSUPPORTED", "This client did not declare file uploads. Use file, pdf_url or pdf_base64 instead.");
      const upload = args.upload;
      if (!upload || typeof upload !== "object" || Array.isArray(upload) || !ID_PATTERN.test(upload.id ?? "")
        || upload.mimeType !== "application/pdf" || !Number.isSafeInteger(upload.size) || upload.size < 1 || upload.size > MAX_UPLOAD_BYTES) {
        return refusal("INVALID_UPLOAD", `Upload a single PDF of at most ${MAX_UPLOAD_BYTES / 1024 / 1024} MB.`);
      }
      if (upload.digest !== undefined && (upload.digest?.algorithm !== "sha-256" || !DIGEST_PATTERN.test(upload.digest?.value ?? ""))) {
        return refusal("INVALID_UPLOAD", "An upload digest must be sha-256 in base64url.");
      }
      if (["file", "pdf_url", "pdf_base64"].some(key => args[key] !== undefined)) {
        return refusal("AMBIGUOUS_INPUT", "Supply exactly one of upload, file, pdf_url or pdf_base64.");
      }
      const binding = argsDigest(name, args, principal);

      if (requestState === undefined) {
        const key = `up/${randomBytes(18).toString("base64url")}`;
        const expiresAt = nowSeconds + UPLOAD_TARGET_SECONDS;
        const target = store.presignUpload(key, { size: upload.size, mimeType: "application/pdf", expiresAt });
        const state = seal("files", { b: binding, k: key, z: upload.size, d: upload.digest?.value }, { keys, expiresAt: nowSeconds + STATE_SECONDS });
        return {
          resultType: "upload_required",
          content: [],
          uploads: [{ fileId: upload.id, url: target.url, method: target.method, headers: target.headers, credentials: "omit", expiresAt: new Date(expiresAt * 1000).toISOString() }],
          requestState: state,
        };
      }

      let state;
      try { state = open("files", String(requestState), { keys, now: nowSeconds }); } catch {
        throw new FilesProtocolError("The upload state is not valid or has expired.");
      }
      if (state.b !== binding) throw new FilesProtocolError("The repeated call does not match the call that requested the upload.");
      const observed = await store.head(state.k);
      if (!observed) throw new FilesProtocolError("The upload was not received, or this upload was already used.");
      if (observed.size !== state.z || (state.d && observed.sha256 !== state.d)) {
        await store.take(state.k);
        return refusal("UPLOAD_MISMATCH", "The uploaded bytes do not match the declared size or digest. Nothing was processed.");
      }
      const bytes = await store.take(state.k);
      if (!bytes) throw new FilesProtocolError("This upload was already used.");
      const { upload: _declared, ...rest } = args;
      return run({ ...rest, _uploaded_bytes: bytes });
    },

    /** Move a returned PDF out of the response and into a download target, if the client declared download. */
    async offloadResult(result, { declared, nowSeconds, fileName = "result.pdf" }) {
      const base64 = result?.structuredContent?.pdf_base64 ?? result?._meta?.pdf_file?.pdf_base64;
      if (!declared.download || result?.isError || typeof base64 !== "string") return result;
      const bytes = Buffer.from(base64, "base64");
      const key = `dl/${randomBytes(18).toString("base64url")}`;
      await store.putResult(key, bytes, { mimeType: "application/pdf" });
      const { url } = store.presignDownload(key, { expiresAt: nowSeconds + DOWNLOAD_SECONDS });
      const structuredContent = { ...result.structuredContent };
      delete structuredContent.pdf_base64;
      const meta = { ...(result._meta ?? {}) };
      delete meta.pdf_file;
      meta[FILES_EXTENSION] = {
        downloads: [{
          name: fileName, mimeType: "application/pdf", size: bytes.length,
          digest: { algorithm: "sha-256", value: createHash("sha256").update(bytes).digest("base64url") },
          url, credentials: "omit", expiresAt: new Date((nowSeconds + DOWNLOAD_SECONDS) * 1000).toISOString(),
        }],
      };
      const content = [...(result.content ?? []), { type: "text", text: `The PDF (${bytes.length} bytes) is attached as a download.` }];
      return { ...result, content, structuredContent: { ...structuredContent, output_handoff: "mcp_files_download" }, _meta: meta };
    },
  };
}
