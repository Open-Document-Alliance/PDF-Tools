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

import {
  assertXfaMutationAllowed,
  detectExistingSignatures,
  detectSignatureZones,
  formatSigningAuditLine,
  stampSignatureOnPage,
  validateSigningIntent,
} from "../server/helpers.js";
import { fetchPdfBytes, FetchRefused, MAX_PDF_BYTES } from "./fetch-guard.mjs";

export const SERVER_NAME = "pdf-tools-remote";
export const SERVER_VERSION = "0.1.0";
export const MAX_PAGES = 200;

const PDF_INPUT_PROPERTIES = {
  pdf_url: { type: "string", description: "HTTPS URL of the PDF. Supply this or pdf_base64." },
  pdf_base64: { type: "string", description: "The PDF itself, base64 encoded. Supply this or pdf_url." },
};

class ToolRefusal extends Error {
  constructor(code, message) {
    super(message);
    this.code = code;
  }
}

/** Resolve either input form to bytes. Nothing here touches a filesystem. */
async function resolveBytes({ pdf_url, pdf_base64 }) {
  if (pdf_url && pdf_base64) {
    throw new ToolRefusal("AMBIGUOUS_INPUT", "Supply either pdf_url or pdf_base64, not both.");
  }
  if (pdf_url) return fetchPdfBytes(pdf_url);
  if (pdf_base64) {
    const bytes = new Uint8Array(Buffer.from(pdf_base64, "base64"));
    if (bytes.length === 0) throw new ToolRefusal("EMPTY_INPUT", "That base64 value did not decode to any bytes.");
    if (bytes.length > MAX_PDF_BYTES) {
      throw new ToolRefusal("TOO_LARGE", `That document is larger than the ${MAX_PDF_BYTES / 1024 / 1024} MB limit.`);
    }
    return bytes;
  }
  throw new ToolRefusal("MISSING_INPUT", "Supply pdf_url or pdf_base64.");
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
      assertXfaMutationAllowed(bytes);
      const document = await loadDocument(bytes);
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
        `Filled ${filled.length} of ${Object.keys(fields ?? {}).length} fields.${note}\nThis does not prove the form is complete or ready to submit.`,
        { filled, not_filled: notFilled, pdf_base64: Buffer.from(output).toString("base64") },
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
      assertXfaMutationAllowed(bytes);
      const document = await loadDocument(bytes);
      if (detectExistingSignatures(document)?.length) {
        throw new ToolRefusal(
          "ALREADY_SIGNED",
          "That PDF already carries a cryptographic signature, and saving would invalidate it.",
        );
      }
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
        `Stamped "${display_name}" on page ${page}.\n${auditLine}\nThis is a visible stamp, not a cryptographic signature.`,
        { audit_line: auditLine, pdf_base64: Buffer.from(output).toString("base64") },
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
      assertXfaMutationAllowed(bytes);
      const document = await loadDocument(bytes);
      document.getForm().flatten();
      const output = await document.save();
      return ok("Flattened. The values are now page content.", {
        pdf_base64: Buffer.from(output).toString("base64"),
      });
    },
  },
];

export const INSTRUCTIONS =
  "PDF form tools that run on a server. Nothing is stored: each call takes a PDF by URL or base64 and returns the result in the response. " +
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
    return await tool.handler(args);
  } catch (error) {
    if (error instanceof ToolRefusal || error instanceof FetchRefused) {
      return refusal(error.code, error.message);
    }
    if (error?.message && /intent|confirmed/i.test(error.message)) {
      // validateSigningIntent speaks for itself and says nothing about content.
      return refusal("INTENT_INVALID", error.message);
    }
    // Never surface a raw parser error: it can echo document content.
    return refusal("INTERNAL_ERROR", "That document could not be processed.");
  }
}

export function listTools() {
  return {
    tools: TOOLS.map(({ name, description, inputSchema, annotations }) => ({
      name,
      description,
      inputSchema,
      annotations,
    })),
  };
}

export function createRemoteServer() {
  const server = new Server(
    { name: SERVER_NAME, version: SERVER_VERSION },
    { capabilities: { tools: {} }, instructions: INSTRUCTIONS },
  );

  server.setRequestHandler("tools/list", async () => listTools());

  server.setRequestHandler("tools/call", async (request) =>
    callTool(request.params?.name, request.params?.arguments ?? {}));

  return server;
}

export const testing = { TOOLS, resolveBytes, loadDocument };
