/**
 * PDF Tools remote MCP server, stateless profile.
 * See docs/REMOTE_STATELESS_PROFILE_2026-09-19.md for the properties this
 * implementation has to keep: nothing stored, nobody authenticated, bytes in
 * and bytes out, no document-derived values in logs, hard caps, narrow surface.
 *
 * The PDF work reuses server/helpers.js, the same byte-level primitives the
 * local product uses, so the two surfaces cannot drift apart on behavior that
 * matters (zone detection, signing intent, XFA refusal).
 */

import { Server } from "@modelcontextprotocol/server";
import { PDFDocument } from "pdf-lib";
import { createHash } from "node:crypto";

import {
  assertParsedXfaMutationAllowed,
  assertXfaMutationAllowed,
  detectExistingSignatures,
  detectSignatureZones,
  formatSigningAuditLine,
  stampSignatureOnPage,
  validateSigningIntent,
} from "../server/helpers.js";
import { fetchPdfBytes, FetchRefused, MAX_PDF_BYTES } from "./fetch-guard.mjs";
import { createDocumentTools } from "./document-tools.mjs";
import { OUTPUT_RESOURCE_URI, OUTPUT_TOOL_NAMES, outputResource } from "./output-card.mjs";

export const SERVER_NAME = "pdf-tools-remote";
export const SERVER_VERSION = "0.2.0";
export const MAX_PAGES = 200;

/**
 * The ceiling on a document sent inline, which is lower than the one on a
 * document we fetch ourselves and is not ours to choose.
 *
 * The host rejects a request body over about 4.5 MB before this code runs, and
 * base64 inflates a document by a third, so roughly 3 MB of PDF is as much as
 * can arrive inline. Measured against the deployed endpoint: a 4.0 MB request
 * succeeded, 8.0 MB and 16 MB were refused by the host in about 160 ms with a
 * message this service never sees.
 *
 * Refusing it here first is the difference between a caller being told to pass
 * a URL instead and a caller reading "Request Entity Too Large" from a server
 * it has never heard of.
 */
export const MAX_INLINE_PDF_BYTES = 3 * 1024 * 1024;

const PDF_INPUT_PROPERTIES = {
  file: {
    type: "object",
    description: "A PDF attachment explicitly supplied by the host. Its temporary download URL is fetched for this request only.",
    properties: {
      download_url: { type: "string" },
      file_id: { type: "string" },
      mime_type: { type: "string" },
      file_name: { type: "string" },
    },
    required: ["download_url", "file_id"],
    additionalProperties: false,
  },
  pdf_url: {
    type: "string",
    description: "HTTPS URL of the PDF, which this service fetches itself. Prefer this: it accepts documents up to 25 MB, where an inline document is limited to 3 MB.",
  },
  pdf_base64: {
    type: "string",
    description: "The PDF itself, base64 encoded, for a document with no public URL. Limited to 3 MB; above that the request is rejected before it arrives, so pass pdf_url instead.",
  },
};

class ToolRefusal extends Error {
  constructor(code, message) {
    super(message);
    this.code = code;
  }
}

/** Resolve either input form to bytes. Nothing here touches a filesystem. */
async function resolveBytes({ file, pdf_url, pdf_base64 }, fetchOptions = {}) {
  if ([file, pdf_url, pdf_base64].filter(value => value !== undefined).length > 1) {
    throw new ToolRefusal("AMBIGUOUS_INPUT", "Supply exactly one of file, pdf_url or pdf_base64, never more than one.");
  }
  if (file !== undefined) {
    if (!file || typeof file !== "object" || Array.isArray(file)
      || Object.keys(file).some(key => !["download_url", "file_id", "mime_type", "file_name"].includes(key))
      || typeof file.file_id !== "string" || !file.file_id || file.file_id.length > 512
      || typeof file.download_url !== "string" || file.download_url.length > 8192
      || (file.mime_type !== undefined && file.mime_type !== "application/pdf")
      || (file.file_name !== undefined && (typeof file.file_name !== "string" || !file.file_name.toLowerCase().endsWith(".pdf")))) {
      throw new ToolRefusal("INVALID_FILE", "An explicit PDF attachment with file_id and HTTPS download_url is required.");
    }
    let url;
    try { url = new URL(file.download_url); } catch { /* rejected below */ }
    if (url?.protocol !== "https:" || url.username || url.password) {
      throw new ToolRefusal("INVALID_FILE", "The attachment must use an HTTPS download URL without embedded credentials.");
    }
    return fetchPdfBytes(file.download_url, fetchOptions);
  }
  if (pdf_url) return fetchPdfBytes(pdf_url, fetchOptions);
  if (pdf_base64) {
    if (typeof pdf_base64 !== "string" || pdf_base64.length > 4 * Math.ceil(MAX_INLINE_PDF_BYTES / 3)) {
      throw new ToolRefusal("TOO_LARGE_INLINE", "Inline PDF data exceeds the 3 MB limit. Use file or pdf_url for inputs up to 25 MB, or local PDF Tools: https://github.com/Open-Document-Alliance/PDF-Tools.");
    }
    if (!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(pdf_base64)) {
      throw new ToolRefusal("INVALID_BASE64", "PDF data must be canonical base64.");
    }
    const bytes = new Uint8Array(Buffer.from(pdf_base64, "base64"));
    if (Buffer.from(bytes).toString("base64") !== pdf_base64) {
      throw new ToolRefusal("INVALID_BASE64", "PDF data must be canonical base64.");
    }
    if (bytes.length === 0) throw new ToolRefusal("EMPTY_INPUT", "That base64 value did not decode to any bytes.");
    if (bytes.length > MAX_INLINE_PDF_BYTES) {
      throw new ToolRefusal(
        "TOO_LARGE_INLINE",
        `That document is ${(bytes.length / 1024 / 1024).toFixed(1)} MB, above the `
          + `${MAX_INLINE_PDF_BYTES / 1024 / 1024} MB limit for a document sent inline. `
          + `Pass pdf_url instead and this service will fetch it, which allows up to `
          + `${MAX_PDF_BYTES / 1024 / 1024} MB. For a document that has no public URL and is larger `
          + `than this, run PDF Tools on the machine that holds it: `
          + `https://github.com/Open-Document-Alliance/PDF-Tools`,
      );
    }
    return bytes;
  }
  throw new ToolRefusal("MISSING_INPUT", "Supply file, pdf_url or pdf_base64.");
}

/**
 * Load with pdf-lib. Encrypted documents are refused in this profile: handling
 * a password would mean accepting a secret, and this service promises to keep
 * nothing.
 */
async function loadDocument(bytes) {
  let document;
  try {
    document = await PDFDocument.load(bytes, { ignoreEncryption: false, updateMetadata: false });
  } catch (error) {
    if (/encrypt/i.test(String(error?.message))) {
      throw new ToolRefusal(
        "ENCRYPTED",
        "That PDF is encrypted. This service never takes passwords; the PDF Tools desktop extension handles encrypted files on your own machine.",
      );
    }
    throw new ToolRefusal("UNREADABLE", "That file could not be read as a PDF.");
  }
  const pages = document.getPageCount();
  if (pages > MAX_PAGES) {
    throw new ToolRefusal("TOO_MANY_PAGES", `That document has ${pages} pages, above the ${MAX_PAGES} page limit.`);
  }
  return document;
}

function refuseSignatureFields(document) {
  if (detectExistingSignatures(document).present) {
    throw new ToolRefusal("ALREADY_SIGNED", "That PDF has a detected signature field. Saving could invalidate a signature; use a local review workflow.");
  }
}

function ok(text, structured) {
  return { content: [{ type: "text", text }], structuredContent: structured };
}

function refusal(code, message) {
  return { isError: true, content: [{ type: "text", text: `${code}: ${message}` }] };
}

function fieldSummary(field) {
  const type = field.constructor.name.replace(/^PDF/, "").replace(/Field$/, "").toLowerCase();
  let value = null;
  try {
    if (typeof field.getText === "function") value = field.getText() ?? "";
    else if (typeof field.isChecked === "function") value = field.isChecked();
    else if (typeof field.getSelected === "function") value = field.getSelected();
  } catch {
    value = null;
  }
  return { name: field.getName(), type, value };
}

const TOOLS = [
  {
    name: "read_form_fields",
    description:
      "List a PDF's form fields with names, types and current values. Government forms name fields in codes such as f1_01, so call render or look at the document before deciding which field is which.",
    inputSchema: { type: "object", properties: { ...PDF_INPUT_PROPERTIES } },
    annotations: { title: "Read Form Fields", readOnlyHint: true },
    async handler(args) {
      const bytes = await resolveBytes(args);
      const document = await loadDocument(bytes);
      const fields = document.getForm().getFields().map(fieldSummary);
      const summary = fields.length === 0
        ? "That PDF has no fillable form fields. It can still be signed with apply_signature."
        : `${fields.length} form fields:\n${fields
            .map((f) => `  ${f.name} [${f.type}]${f.value ? ` = ${f.value}` : ""}`)
            .join("\n")}`;
      return ok(summary, { page_count: document.getPageCount(), fields });
    },
  },
  {
    name: "fill_form",
    description:
      "Fill named form fields and return the filled PDF as base64. Field names must match read_form_fields exactly. Nothing is stored on the server.",
    inputSchema: {
      type: "object",
      properties: {
        ...PDF_INPUT_PROPERTIES,
        fields: {
          type: "object",
          description: "Field name to value. Text fields take strings, checkboxes take true or false.",
          additionalProperties: { type: ["string", "boolean"] },
        },
      },
      required: ["fields"],
    },
    annotations: { title: "Fill Form" },
    async handler({ fields, ...input }) {
      const bytes = await resolveBytes(input);
      const document = await loadDocument(bytes);
      const xfaNotice = assertParsedXfaMutationAllowed(document);
      refuseSignatureFields(document);
      const form = document.getForm();
      const filled = [];
      const notFilled = [];
      for (const [name, value] of Object.entries(fields ?? {})) {
        try {
          const field = form.getField(name);
          if (typeof value === "boolean" && typeof field.check === "function") {
            if (value) field.check();
            else field.uncheck();
          } else if (typeof field.setText === "function") {
            field.setText(String(value));
          } else if (typeof field.select === "function") {
            field.select(String(value));
          } else {
            notFilled.push({ name, reason: "unsupported field type" });
            continue;
          }
          filled.push(name);
        } catch {
          notFilled.push({ name, reason: "no field with that exact name" });
        }
      }
      const output = await document.save();
      const note = notFilled.length
        ? `\nNot filled: ${notFilled.map((entry) => `${entry.name} (${entry.reason})`).join(", ")}`
        : "";
      return ok(
        `Filled ${filled.length} of ${Object.keys(fields ?? {}).length} fields.${note}\n`
          + `This does not prove the form is complete or ready to submit.${xfaNotice ? `\n${xfaNotice}` : ""}`,
        {
          filled,
          not_filled: notFilled,
          xfa_notice: xfaNotice,
          pdf_base64: Buffer.from(output).toString("base64"),
        },
      );
    },
  },
  {
    name: "detect_signature_zones",
    description:
      "Find where a signature, initials, printed name or date belongs, with coordinates in points from the top-left. Call this before apply_signature rather than guessing coordinates.",
    inputSchema: { type: "object", properties: { ...PDF_INPUT_PROPERTIES } },
    annotations: { title: "Detect Signature Zones", readOnlyHint: true },
    async handler(args) {
      const bytes = await resolveBytes(args);
      const document = await loadDocument(bytes);
      const pdfjsLib = await import("pdfjs-dist/legacy/build/pdf.mjs");
      const zones = await detectSignatureZones({
        pdfDoc: document,
        pdfBytes: bytes,
        pdfjsLib,
        password: null,
        onWarning: () => {},
      });
      const lines = zones.map(
        (zone, index) =>
          `${index + 1}. ${String(zone.type).toUpperCase()} p${zone.page} x=${zone.x} y=${zone.y} width=${zone.width} height=${zone.height} label="${zone.label}" confidence=${zone.confidence}`,
      );
      return ok(
        zones.length ? `Found ${zones.length} zone(s):\n${lines.join("\n")}` : "No signature zones were found.",
        { zones },
      );
    },
  },
  {
    name: "apply_signature",
    description:
      "Stamp a typed signature at a zone from detect_signature_zones and return the signed PDF. NEVER invent intent_statement or confirmed_at: both must come from the person in their own words. This is a visible stamp, not a cryptographic signature.",
    inputSchema: {
      type: "object",
      properties: {
        ...PDF_INPUT_PROPERTIES,
        display_name: { type: "string", description: "The person's name as it should appear." },
        page: { type: "integer", minimum: 1 },
        x: { type: "number", description: "Left edge in points." },
        y: { type: "number", description: "Top edge in points, top-left origin, from detect_signature_zones." },
        width: { type: "number" },
        height: { type: "number" },
        intent_statement: {
          type: "string",
          description: "REQUIRED. The person's own sentence confirming intent to sign. Ask them; never write it for them.",
        },
        confirmed_at: {
          type: "string",
          description: "REQUIRED. ISO-8601 time the person confirmed, within the last 24 hours.",
        },
        audit_line: {
          type: "boolean",
          description: "Also draw a small signer and timestamp line under the signature.",
        },
      },
      required: ["display_name", "page", "x", "y", "width", "height", "intent_statement", "confirmed_at"],
    },
    annotations: { title: "Apply Signature" },
    async handler({ display_name, page, x, y, width, height, intent_statement, confirmed_at, audit_line, ...input }) {
      // Returns the trimmed statement and a parsed Date; the audit formatter needs both.
      const intent = validateSigningIntent({
        user_intent_statement: intent_statement,
        user_confirmed_at: confirmed_at,
      });
      const bytes = await resolveBytes(input);
      const document = await loadDocument(bytes);
      const xfaNotice = assertParsedXfaMutationAllowed(document);
      refuseSignatureFields(document);
      const auditLine = formatSigningAuditLine({
        display_name,
        statement: intent.statement,
        confirmedAt: intent.confirmedAt,
        action: "signed",
      });
      await stampSignatureOnPage(
        document,
        { style: "typed", display_name },
        { page, x, y, width, height, drawAuditLine: audit_line === true, auditText: auditLine },
      );
      document.setKeywords([auditLine]);
      const output = await document.save();
      return ok(
        `Stamped "${display_name}" on page ${page}.\n${auditLine}\n`
          + `This is a visible stamp, not a cryptographic signature.${xfaNotice ? `\n${xfaNotice}` : ""}`,
        { audit_line: auditLine, xfa_notice: xfaNotice, pdf_base64: Buffer.from(output).toString("base64") },
      );
    },
  },
  {
    name: "flatten_form",
    description:
      "Flatten the form so values become fixed page content that cannot be edited further. Returns the flattened PDF as base64.",
    inputSchema: { type: "object", properties: { ...PDF_INPUT_PROPERTIES } },
    annotations: { title: "Flatten Form" },
    async handler(args) {
      const bytes = await resolveBytes(args);
      const document = await loadDocument(bytes);
      const xfaNotice = assertParsedXfaMutationAllowed(document);
      refuseSignatureFields(document);
      document.getForm().flatten();
      const output = await document.save();
      return ok(`Flattened. The values are now page content.${xfaNotice ? `\n${xfaNotice}` : ""}`, {
        xfa_notice: xfaNotice,
        pdf_base64: Buffer.from(output).toString("base64"),
      });
    },
  },
];

TOOLS.push(...createDocumentTools({ PDF_INPUT_PROPERTIES, resolveBytes, loadDocument, ok, ToolRefusal, MAX_PAGES, MAX_INLINE_PDF_BYTES }));

export const INSTRUCTIONS =
  "PDF Tools runs on a server. Each call takes an explicit PDF attachment, URL or inline PDF and returns its result without storing it. Read or convert bounded page ranges, search text, fill forms, and assemble or rotate pages. Extraction reports gaps and page coverage; no OCR is performed. " +
  "Signatures are visible stamps, not cryptographic signatures, and need the person's own words confirming intent. " +
  "Encrypted PDFs are refused here; the PDF Tools desktop extension handles those on the person's own machine.";

/**
 * Dispatch one tool call and convert refusals into typed, content-free tool
 * errors. Exported so tests exercise exactly what the transport reaches, rather
 * than reaching into the server's private handler table.
 */
export async function callTool(name, args = {}) {
  const tool = TOOLS.find((candidate) => candidate.name === name);
  if (!tool) return refusal("UNKNOWN_TOOL", `There is no tool named ${name}.`);
  try {
    if (OUTPUT_TOOL_NAMES.has(name) && args.output_mode !== undefined && !["inline", "download"].includes(args.output_mode)) {
      return refusal("INVALID_OUTPUT_MODE", "Choose download for the result card or inline for a machine-readable base64 response.");
    }
    const result = await tool.handler(args);
    const output = result.structuredContent?.pdf_base64;
    if (output && Buffer.byteLength(output, "base64") > MAX_INLINE_PDF_BYTES) {
      return refusal("OUTPUT_TOO_LARGE", "The output exceeds the 3 MB inline transfer limit. Request fewer pages or use the local PDF Tools edition.");
    }
    if (output) {
      const bytes = Buffer.from(output, "base64");
      result.structuredContent.output = {
        ...result.structuredContent.output,
        sha256: createHash("sha256").update(bytes).digest("hex"), size_bytes: bytes.length,
      };
      if (args.output_mode === "download") {
        result._meta = { ...result._meta, pdf_file: { pdf_base64: output, output: result.structuredContent.output } };
        delete result.structuredContent.pdf_base64;
        result.structuredContent.output_handoff = "result_card_download_requires_host_support";
      }
    }
    return result;
  } catch (error) {
    if (error instanceof ToolRefusal || error instanceof FetchRefused) {
      return refusal(error.code, error.message);
    }
    if (error?.message && /intent|confirmed/i.test(error.message)) {
      // validateSigningIntent speaks for itself and says nothing about content.
      return refusal("INTENT_INVALID", error.message);
    }
    // Never surface a raw parser error: it can echo document content. The log
    // line carries the error class and its top frame only, for the same reason.
    const frame = String(error?.stack ?? "").split("\n")[1]?.trim() ?? "no frame";
    process.stderr.write(`tool ${name} failed: ${error?.name ?? "Error"} at ${frame}\n`);
    return refusal("INTERNAL_ERROR", "That document could not be processed.");
  }
}

export function listTools() {
  return {
    tools: TOOLS.map(({ name, description, inputSchema, annotations }) => ({
      name,
      description,
      inputSchema: OUTPUT_TOOL_NAMES.has(name) ? { ...inputSchema, properties: { ...inputSchema.properties,
        output_mode: { type: "string", enum: ["inline", "download"], default: "inline", description: "Choose download for a user-facing result card; its PDF bytes stay out of model-visible text. Inline returns base64 for machine clients and backwards compatibility. Host download support must be tested." },
      } } : inputSchema,
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true, ...annotations },
      _meta: {
        "openai/fileParams": name === "merge_pdfs" ? ["files"] : ["file"],
        ...(OUTPUT_TOOL_NAMES.has(name) ? { ui: { resourceUri: OUTPUT_RESOURCE_URI } } : {}),
      },
    })),
  };
}

export function createRemoteServer({ dispatchTool = callTool } = {}) {
  const server = new Server(
    { name: SERVER_NAME, version: SERVER_VERSION },
    { capabilities: { tools: {}, resources: {} }, instructions: INSTRUCTIONS },
  );

  server.setRequestHandler("tools/list", async () => listTools());

  server.setRequestHandler("tools/call", async (request, extra) =>
    dispatchTool(request.params?.name, request.params?.arguments ?? {}, { signal: extra?.signal }));
  server.setRequestHandler("resources/list", async () => ({ resources: [{ uri: OUTPUT_RESOURCE_URI, name: "PDF Tools output", mimeType: "text/html;profile=mcp-app" }] }));
  server.setRequestHandler("resources/read", async request => {
    if (request.params?.uri !== OUTPUT_RESOURCE_URI) throw new Error("Unknown UI resource");
    return outputResource();
  });

  return server;
}

export const testing = { TOOLS, resolveBytes, loadDocument };
