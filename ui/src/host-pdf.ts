import {
  OpenAIFileEntrypointInputSchema,
  type OpenAIResources,
} from "@openai/mcp-extensions/app";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { getToolResultText, parsePdfToolLoadData } from "./tool-result";

export const MAX_HOST_PDF_BYTES = 16 * 1024 * 1024;
const CHUNK_BYTES = 524288;
const SHA256 = /^[a-f0-9]{64}$/;
type FileInput = { file: { name: string; resourceUri: string } };
type ToolCall = (request: { name: string; arguments: Record<string, unknown> }) => Promise<CallToolResult>;
export class HostPdfSessionEndedError extends Error {
  constructor() { super("The PDF file session ended or changed."); }
}

/** SDK input parsing strips extra members, so check the literal shape first. */
export function parseHostPdfInput(value: unknown): FileInput | null {
  if (!value || typeof value !== "object" || Array.isArray(value) || !("file" in value)) return null;
  const input = value as Record<string, unknown>;
  const file = input.file;
  if (Object.keys(input).join(",") !== "file" || !file || typeof file !== "object" || Array.isArray(file) || Object.keys(file).sort().join(",") !== "name,resourceUri") {
    throw new Error("The host did not provide one exact PDF file reference.");
  }
  const parsed = OpenAIFileEntrypointInputSchema.safeParse(input);
  if (!parsed.success || parsed.data.file.name.length > 255 || !parsed.data.file.name.toLowerCase().endsWith(".pdf") || /[\\/\x00-\x1f]/.test(parsed.data.file.name)) {
    throw new Error("The host file must have a PDF filename, not a path.");
  }
  return parsed.data;
}

export function decodeHostPdfBlob(blob: unknown, limit = MAX_HOST_PDF_BYTES): Uint8Array {
  if (typeof blob !== "string" || blob.length === 0 || blob.length > 4 * Math.ceil(limit / 3) || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(blob)) {
    throw new Error("PDF file data is missing, invalid, or larger than the 16 MiB host-file limit.");
  }
  const raw = atob(blob);
  if (!raw.length || raw.length > limit || btoa(raw) !== blob) throw new Error("PDF file data is not canonical bounded base64.");
  return Uint8Array.from(raw, character => character.charCodeAt(0));
}

export function encodeHostPdfBlob(bytes: Uint8Array): string {
  let raw = "";
  for (let offset = 0; offset < bytes.length; offset += 32768) raw += String.fromCharCode(...bytes.subarray(offset, offset + 32768));
  return btoa(raw);
}

async function digest(bytes: Uint8Array): Promise<string> {
  const hash = await crypto.subtle.digest("SHA-256", bytes);
  return [...new Uint8Array(hash)].map(byte => byte.toString(16).padStart(2, "0")).join("");
}

export interface HostPdfState {
  associated: boolean;
  busy: boolean;
  canSave: boolean;
  stale: boolean;
  message: string;
  blockedReason?: string;
}

type Binding = { uri: string; localPath: string; etag?: string; writable: boolean; stale: boolean; resources: OpenAIResources; removeHandler: () => void; subscribed: boolean };
type Dependencies = {
  resources: () => OpenAIResources | undefined;
  callTool: ToolCall;
  load: (result: CallToolResult) => Promise<boolean>;
  currentPath: () => string;
  onState: (state: HostPdfState) => void;
  readyToSave?: () => string | null;
};

/** A host URI is an opaque UI capability. It is never sent to the server. */
export class HostPdfSession {
  private binding: Binding | null = null;
  private epoch = 0;
  private disposed = false;
  private busy = false;
  private operation = false;
  private message = "";
  constructor(private readonly dependencies: Dependencies) {}
  get isBusy() { return this.operation; }

  private emit() {
    const binding = this.binding;
    const blockedReason = binding ? this.dependencies.readyToSave?.() || undefined : undefined;
    this.dependencies.onState({ associated: Boolean(binding), busy: this.busy, stale: Boolean(binding?.stale), canSave: Boolean(binding?.writable && binding.etag && !binding.stale && !this.busy && !blockedReason && binding.localPath === this.dependencies.currentPath()), message: this.message, blockedReason });
  }

  refresh() { this.emit(); }

  private current(epoch: number) { return !this.disposed && this.epoch === epoch; }
  private assertCurrent(epoch: number) { if (!this.current(epoch)) throw new HostPdfSessionEndedError(); }

  async clear() {
    this.epoch++;
    const binding = this.binding;
    this.binding = null;
    this.busy = false;
    this.message = "";
    binding?.removeHandler();
    this.emit();
    if (binding?.subscribed) {
      try { await binding.resources.unsubscribe({ uri: binding.uri }); } catch { /* no write or retry */ }
    }
  }

  /** Only explicit local mutations may carry the host association to an output. */
  viewerPathChanged(path: string, previousPath?: string) {
    if (!this.binding) return;
    if (previousPath && previousPath === this.binding.localPath && previousPath === this.dependencies.currentPath()) {
      this.binding.localPath = path;
      this.emit();
    } else if (path !== this.binding.localPath) {
      void this.clear();
    } else this.emit();
  }

  async open(input: FileInput): Promise<void> {
    if (this.disposed || this.operation) throw new Error("A PDF file operation is already active or the viewer has closed.");
    const admitted = parseHostPdfInput(input);
    if (!admitted) throw new Error("An exact host-supplied PDF file reference is required.");
    this.operation = true;
    await this.clear();
    const epoch = this.epoch;
    this.busy = true;
    this.message = "Opening the PDF supplied by the host...";
    this.emit();
    try {
      this.assertCurrent(epoch);
      const resources = this.dependencies.resources();
      if (!resources) throw new Error("This host does not support native PDF files. Ask the assistant to open a local PDF with display_pdf instead.");
      const binding: Binding = { uri: admitted.file.resourceUri, localPath: "", writable: false, stale: false, resources, removeHandler: () => {}, subscribed: false };
      this.binding = binding;
      binding.removeHandler = resources.addUpdateHandler(notification => {
        if (this.binding === binding && notification.params.uri === binding.uri) {
          binding.stale = true;
          this.message = "The original file changed in the host. Your local copy is retained. Reopen the original before saving back.";
          this.emit();
        }
      });
      // Subscribe before reading so an intervening host edit cannot go unseen.
      try {
        await resources.subscribe({ uri: binding.uri });
        binding.subscribed = true;
        if (!this.current(epoch)) {
          binding.removeHandler();
          try { await resources.unsubscribe({ uri: binding.uri }); } catch { /* cancelled before import */ }
        }
      } catch { /* version-matched save remains disabled without subscription */ }
      this.assertCurrent(epoch);
      const read = await resources.read({ uri: binding.uri, representation: "blob" });
      this.assertCurrent(epoch);
      if (read.contents.length !== 1 || read.contents[0].uri !== binding.uri || !("blob" in read.contents[0])) throw new Error("The host returned a different or ambiguous PDF resource.");
      const content = read.contents[0];
      const blob = content.blob;
      const bytes = decodeHostPdfBlob(blob);
      const expectedSha = await digest(bytes);
      this.assertCurrent(epoch);
      binding.writable = binding.subscribed && content.openaiMetadata?.writable === true;
      binding.etag = typeof content.openaiMetadata?.etag === "string" && content.openaiMetadata.etag.trim() ? content.openaiMetadata.etag : undefined;
      const result = await this.dependencies.callTool({ name: "import_host_pdf", arguments: { pdf_base64: blob, display_name: admitted.file.name } });
      this.assertCurrent(epoch);
      const payload = result.structuredContent as Record<string, any> | undefined;
      const load = parsePdfToolLoadData(result);
      if (result.isError || !load.ok) throw new Error(getToolResultText(result) || "The private workspace cannot import this PDF. No folder permissions were changed.");
      if (payload?.host_import?.version !== 1 || payload.host_import.status !== "imported" || payload.host_import.sha256 !== expectedSha || payload.host_import.size_bytes !== bytes.length || load.data.totalBytes !== bytes.length || payload.source?.sha256 !== expectedSha || payload.source?.size_bytes !== bytes.length || payload.source?.canonical_path !== (load.data.activePath || load.data.pdfPath)) throw new Error("The imported PDF does not match the exact host file bytes.");
      binding.localPath = load.data.activePath || load.data.pdfPath;
      if (!await this.dependencies.load(result)) throw new Error("The imported PDF could not be loaded.");
      this.assertCurrent(epoch);
      this.message = binding.stale ? "The original file changed. Your local copy is retained; reopen before saving back." : binding.writable && binding.etag ? "Working on a private copy. Save back only when you are ready." : "Working on a private copy. The host did not grant versioned write access, so saving back is unavailable.";
    } catch (error) {
      if (this.current(epoch)) {
        const message = error instanceof Error ? error.message : String(error);
        await this.clear();
        this.message = message;
        this.emit();
      }
      throw error;
    } finally {
      this.operation = false;
      if (this.current(epoch)) { this.busy = false; this.emit(); }
    }
  }

  async save(): Promise<void> {
    const binding = this.binding;
    const blockedReason = this.dependencies.readyToSave?.();
    if (blockedReason) throw new Error(blockedReason);
    if (this.disposed || this.operation || !binding || binding.stale || !binding.writable || !binding.etag || binding.localPath !== this.dependencies.currentPath()) throw new Error("Saving back requires the current host file and its unchanged version.");
    this.operation = true;
    const epoch = this.epoch;
    const path = binding.localPath;
    const etag = binding.etag;
    const validate = () => { this.assertCurrent(epoch); const reason = this.dependencies.readyToSave?.(); if (reason) throw new Error(reason); if (binding.stale || this.binding !== binding || path !== binding.localPath || path !== this.dependencies.currentPath()) throw new Error("The file changed while preparing to save. Your local copy is retained."); };
    this.busy = true;
    this.message = "Verifying your current PDF before saving back...";
    this.emit();
    try {
      const identityResult = await this.dependencies.callTool({ name: "get_pdf_identity", arguments: { pdf_path: path } });
      validate();
      const identity = identityResult.structuredContent as Record<string, any> | undefined;
      if (identityResult.isError || !identity || !SHA256.test(identity.sha256) || !Number.isSafeInteger(identity.size_bytes) || identity.size_bytes < 1 || identity.size_bytes > MAX_HOST_PDF_BYTES || identity.canonical_path !== path) throw new Error("The local PDF identity is invalid or exceeds the 16 MiB save-back limit. Your local copy is retained.");
      const bytes = new Uint8Array(identity.size_bytes);
      for (let offset = 0; offset < bytes.length; offset += CHUNK_BYTES) {
        const count = Math.min(CHUNK_BYTES, bytes.length - offset);
        const result = await this.dependencies.callTool({ name: "read_pdf_bytes", arguments: { pdf_path: path, offset, byteCount: count } });
        validate();
        const chunk = result.structuredContent as Record<string, any> | undefined;
        if (result.isError || !chunk || chunk.pdfPath !== path || chunk.offset !== offset || chunk.byteCount !== count || chunk.totalBytes !== bytes.length) throw new Error("PDF byte read did not match the exact current document.");
        const decoded = decodeHostPdfBlob(chunk.bytes, count);
        if (decoded.length !== count) throw new Error("PDF byte read was incomplete.");
        bytes.set(decoded, offset);
      }
      const observedSha = await digest(bytes);
      validate();
      if (observedSha !== identity.sha256) throw new Error("The local PDF changed during reading. Your local copy is retained; save was not attempted.");
      const finalIdentity = await this.dependencies.callTool({ name: "get_pdf_identity", arguments: { pdf_path: path } });
      validate();
      const final = finalIdentity.structuredContent as Record<string, any> | undefined;
      if (finalIdentity.isError || final?.sha256 !== observedSha || final?.size_bytes !== bytes.length || final?.canonical_path !== path) throw new Error("The local PDF changed before saving. Your local copy is retained.");
      const outcome = await binding.resources.write(binding.uri, { blob: encodeHostPdfBlob(bytes), ifMatch: etag });
      // Host notifications can precede a successful write response. Report
      // that confirmed effect honestly while retaining the conservative stale
      // block, rather than claiming a write was never attempted.
      this.assertCurrent(epoch);
      if (this.binding !== binding || path !== binding.localPath || path !== this.dependencies.currentPath()) throw new Error("The host save response arrived after the viewer changed documents. The old local copy is retained.");
      if (outcome.outcome === "saved" && outcome.etag.trim()) {
        binding.etag = outcome.etag;
        this.message = binding.stale ? "The host confirmed the save, but also reported a file update. Your local copy is retained; reopen before saving again." : "Saved back to the host file. Your local working copy is retained.";
      } else if (outcome.outcome === "conflict") {
        binding.stale = true;
        this.message = "Not saved: the host file changed. Your local copy is retained. Reopen the original before saving back.";
      } else if (outcome.outcome === "too-large") {
        this.message = "Not saved: the host file size limit was exceeded. Your local copy is retained.";
      } else throw new Error("The host did not confirm a versioned save. Your local copy is retained.");
    } catch (error) {
      if (this.current(epoch)) this.message = error instanceof Error ? error.message : String(error);
      throw error;
    } finally {
      this.operation = false;
      if (this.current(epoch)) { this.busy = false; this.emit(); }
    }
  }

  async dispose() { this.disposed = true; await this.clear(); }
}
