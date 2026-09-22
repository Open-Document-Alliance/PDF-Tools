import { createHash } from "node:crypto";
import { closeSync, writeSync } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { Readable } from "node:stream";
import { fileURLToPath } from "node:url";
import {
  isMainThread,
  parentPort as threadParentPort,
  workerData as threadWorkerData,
} from "node:worker_threads";
import { createInflate } from "node:zlib";
import {
  PDFArray,
  PDFDict,
  PDFDocument,
  PDFInvalidObject,
  PDFName,
  PDFNumber,
  PDFPageLeaf,
  PDFPageTree,
  PDFRawStream,
  PDFRef,
  PDFStream,
  decodePDFRawStream,
  degrees,
} from "pdf-lib";
import {
  applyMergeDescriptiveMetadataConsensus,
  captureMergeDescriptiveMetadata,
  copyPdfDocumentMetadata,
  copyPdfPagesPreservingForms,
  detectExistingSignatures,
  drawSignatureFieldOnPage,
  getPageBoxGeometry,
  parsePageRanges,
  PDF_LIB_ENCRYPTED_MESSAGE,
  XFA_GUARDED_MUTATION_OPERATIONS,
  assertParsedXfaMutationAllowed,
  stampSignatureOnPage,
  stampTextOnPage,
} from "./helpers.js";
import {
  AccessibilityInspectionError,
  inspectPdfAccessibilityBytes,
  validateAccessibilityInspectionResult,
} from "./accessibility-inspection.js";
import {
  decryptPdfForWrite,
  ENCRYPTED_WRITE_OPERATIONS,
  mergeProtectionRefusal,
  reprotectPdfAfterWrite,
} from "./qpdf-decrypt.js";
import {
  PDF_MERGE_MAX_TOTAL_BYTES,
  PDF_MUTATION_MAX_FILE_BYTES,
  pdfMutationFileLimitError,
  withBoundedPdfFileSafely,
} from "./bounded-pdf-file.js";
import { startPdfLibRssMonitor } from "./pdf-lib-rss-monitor.js";

const PROTOCOL_VERSION = 1;
const MAX_REQUEST_BYTES = 16 * 1024 * 1024;
const MAX_CONTROL_BYTES = 1024 * 1024;
const MAX_STAGE_FILE_BYTES = 500 * 1024 * 1024;
const MAX_STAGE_TOTAL_BYTES = 1024 * 1024 * 1024;
const MAX_OUTPUTS = 1000;
const MAX_SIGNING_PACKET_PAGES = 1000;
const MAX_REASONABLE_OBJECT_NUMBER = 2_000_000;
const MAX_STRUCTURE_TOKEN_BYTES = 128;
// ISO 32000-1:2008, Table 17: every element of a cross-reference stream's /W
// array is the byte count of one cross-reference field. Eight bytes already
// exceed the integer precision pdf-lib accumulates those bytes into, so no
// conforming producer can need more.
const MAX_XREF_FIELD_BYTES = 8;
// pdf-lib's PDFXRefStreamParser consumes W[0] + W[1] + W[2] bytes per entry.
const MAX_XREF_ENTRY_BYTES = 3 * MAX_XREF_FIELD_BYTES;
// Only the first three /W elements ever become loop bounds, so retaining a
// short prefix checks everything that matters and keeps a /W array with
// millions of hostile elements from being materialized by this guard itself.
const MAX_TRACKED_XREF_WIDTHS = 8;
// A hostile file can nest dictionaries as deeply as its bytes allow, so the
// per-dictionary tracking below keeps only a bounded window of open frames.
const MAX_TRACKED_DICT_DEPTH = 512;
// A PDF real, which pdf-lib will still coerce into a loop bound. The lexer
// classifies anything containing a decimal point as a word, so byte widths
// have to be recognized here rather than only from integer tokens.
const PDF_REAL_NUMBER = /^[+-]?(?:\d+\.?\d*|\.\d+)$/;
const MAX_STREAM_FILTER_CHAIN_LENGTH = 4;
const MAX_EXPANDING_FILTER_STAGES = 2;
const MAX_PARSED_DIRECT_DEPTH = 256;
const MAX_PARSED_CONTAINER_VISITS = 1_000_000;
const MAX_PDF_GRAPH_EDGES = 2_000_000;
const MAX_PDF_GRAPH_PENDING = 1_000_000;
const MAX_SPEC_NULL_REFERENCE_SAMPLE = 32;
// Object streams contain serialized non-stream objects, and pdf-lib's writer
// groups only 50 objects into each one. A decoded object stream above 16 MiB is
// therefore far outside ordinary writer output. More importantly, the pinned
// parser eagerly materializes it before our post-parse 128 MiB stream probe can
// run: a measured 256 MiB object stream drove RSS above 4.3 GiB. Keeping this
// ceiling at 16 MiB leaves useful headroom inside the worker's 384 MiB V8 old-
// space budget while preserving large PDFs whose bulk lives in image/content
// streams rather than in one serialized-object container.
const MAX_DECODED_OBJECT_STREAM_BYTES = 16 * 1024 * 1024;
const MIN_DECODED_STREAM_BUDGET_BYTES = 16 * 1024 * 1024;
const MAX_DECODED_STREAM_BUDGET_BYTES = 128 * 1024 * 1024;
const MAX_DECODE_EXPANSION_RATIO = 512;
const DECODE_INSPECTION_CHUNK_BYTES = 64 * 1024;
const RESOURCE_CODE = "PDF_RESOURCE_LIMIT_EXCEEDED";
const inputSpecNullReferenceAuthorities = new WeakMap();
const rebuiltSpecNullReferenceStates = new WeakMap();
const SHA256_AUTHORITY_PATTERN = /^[a-f0-9]{64}$/;
const PDF_REF_LABEL_PATTERN = /^[1-9]\d* (?:0|[1-9]\d*) R$/;
const FILTER_NAME_ALIASES = new Map([
  ["AHx", "ASCIIHexDecode"],
  ["A85", "ASCII85Decode"],
  ["LZW", "LZWDecode"],
  ["Fl", "FlateDecode"],
  ["RL", "RunLengthDecode"],
  ["CCF", "CCITTFaxDecode"],
  ["DCT", "DCTDecode"],
]);
const EXPANDING_FILTERS = new Set([
  "CCITTFaxDecode",
  "DCTDecode",
  "FlateDecode",
  "JBIG2Decode",
  "JPXDecode",
  "LZWDecode",
  "RunLengthDecode",
]);
const BOUNDED_INSPECTION_FILTERS = new Set([
  "ASCII85Decode",
  "ASCIIHexDecode",
  "FlateDecode",
  "LZWDecode",
  "RunLengthDecode",
]);
const OPERATIONS = new Set([
  "add_signature_field",
  "apply_page_plan",
  "apply_signature",
  "apply_text",
  "bulk_fill_from_csv",
  "fill_pdf",
  "fill_with_profile",
  "inspect_pdf_accessibility",
  "merge_pdfs",
  "prepare_signing_packet",
  "reorder_pdf_pages",
  "rotate_pdf_pages",
  "split_pdf",
]);
const OPTION_KEYS = new Map([
  ["fill_pdf", ["field_data"]],
  ["fill_with_profile", ["field_data"]],
  ["inspect_pdf_accessibility", []],
  ["bulk_fill_from_csv", ["records"]],
  ["merge_pdfs", []],
  ["split_pdf", ["page_ranges"]],
  ["rotate_pdf_pages", ["degrees", "pages"]],
  ["reorder_pdf_pages", ["page_order", "rotations"]],
  ["apply_page_plan", ["page_order", "rotations"]],
  ["add_signature_field", ["allow_resign", "placement"]],
  ["apply_signature", [
    "allow_resign", "audit_line", "audit_text", "draw_audit_line",
    "modification_at", "placement", "signature",
  ]],
  ["prepare_signing_packet", [
    "allow_resign", "field_values", "require_provider_ready", "signature_locations",
  ]],
  ["apply_text", [
    "allow_resign", "audit_line", "font_style", "modification_at", "placement", "text",
  ]],
]);

function exactKeys(value, expected, label) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError(`${label} must be an object.`);
  }
  const actual = Object.keys(value).sort();
  const wanted = [...expected].sort();
  if (actual.length !== wanted.length || actual.some((key, index) => key !== wanted[index])) {
    throw new TypeError(`${label} has an invalid shape.`);
  }
}

function resourceError(reason, message) {
  const error = new Error(message);
  error.name = "PdfResourceLimitError";
  error.code = RESOURCE_CODE;
  error.reason = reason;
  return error;
}

function validateSource(source, index) {
  exactKeys(source, ["canonical_path", "file_identity", "sha256", "size_bytes"], `sources[${index}]`);
  if (typeof source.canonical_path !== "string" || !path.isAbsolute(source.canonical_path)) {
    throw new TypeError(`sources[${index}].canonical_path must be absolute.`);
  }
  if (!Number.isSafeInteger(source.size_bytes) || source.size_bytes < 1
      || source.size_bytes > PDF_MUTATION_MAX_FILE_BYTES) {
    throw new TypeError(`sources[${index}].size_bytes is invalid.`);
  }
  if (!/^[a-f0-9]{64}$/.test(source.sha256)) {
    throw new TypeError(`sources[${index}].sha256 is invalid.`);
  }
  exactKeys(source.file_identity, ["device", "inode"], `sources[${index}].file_identity`);
  for (const key of ["device", "inode"]) {
    if (typeof source.file_identity[key] !== "string" || source.file_identity[key].length < 1
        || source.file_identity[key].length > 128) {
      throw new TypeError(`sources[${index}].file_identity.${key} is invalid.`);
    }
  }
}

function validateRequest(request) {
  exactKeys(
    request,
    ["force_xfa", "operation", "options", "password", "protocol_version", "sources", "stage_directory"],
    "pdf-lib mutation request",
  );
  if (request.protocol_version !== PROTOCOL_VERSION || !OPERATIONS.has(request.operation)) {
    throw new TypeError("Unsupported pdf-lib mutation protocol request.");
  }
  if (!Array.isArray(request.sources) || request.sources.length < 1 || request.sources.length > 1000) {
    throw new TypeError("sources must contain from 1 to 1000 bindings.");
  }
  request.sources.forEach(validateSource);
  if (request.operation !== "merge_pdfs" && request.sources.length !== 1) {
    throw new TypeError(`${request.operation} requires exactly one source.`);
  }
  if (request.operation === "merge_pdfs"
      && request.sources.reduce((sum, source) => sum + source.size_bytes, 0) > PDF_MERGE_MAX_TOTAL_BYTES) {
    throw new TypeError("merge_pdfs source bindings exceed the aggregate limit.");
  }
  if (request.password !== null
      && (typeof request.password !== "string" || request.password.length < 1 || request.password.length > 4096)) {
    throw new TypeError("password is invalid.");
  }
  if (request.operation === "inspect_pdf_accessibility" && request.password !== null) {
    throw new TypeError("inspect_pdf_accessibility does not accept a password.");
  }
  if (typeof request.force_xfa !== "boolean") {
    throw new TypeError("force_xfa must be a boolean.");
  }
  if (request.force_xfa && !XFA_GUARDED_MUTATION_OPERATIONS.has(request.operation)) {
    throw new TypeError(`${request.operation} does not accept force_xfa.`);
  }
  if (!request.options || typeof request.options !== "object" || Array.isArray(request.options)) {
    throw new TypeError("options must be an object.");
  }
  exactKeys(request.options, OPTION_KEYS.get(request.operation), `${request.operation} options`);
  const options = request.options;
  const objectValue = (value, label) => {
    if (!value || typeof value !== "object" || Array.isArray(value)) {
      throw new TypeError(`${label} must be an object.`);
    }
  };
  const exactOptionalKeys = (value, required, optional, label) => {
    objectValue(value, label);
    const allowed = new Set([...required, ...optional]);
    if (
      required.some(key => !Object.hasOwn(value, key))
      || Object.keys(value).some(key => !allowed.has(key))
    ) {
      throw new TypeError(`${label} has an invalid shape.`);
    }
  };
  const placement = (value, label, { labelField = false } = {}) => {
    exactKeys(
      value,
      labelField ? ["height", "label", "page", "width", "x", "y"] : ["height", "page", "width", "x", "y"],
      label,
    );
    if (!Number.isSafeInteger(value.page) || value.page < 1) throw new TypeError(`${label}.page is invalid.`);
    for (const key of ["x", "y", "width", "height"]) {
      if (!Number.isFinite(value[key])) throw new TypeError(`${label}.${key} is invalid.`);
    }
    if (value.width <= 0 || value.height <= 0) throw new TypeError(`${label} dimensions are invalid.`);
    if (labelField && (typeof value.label !== "string" || value.label.length < 1 || value.label.length > 500)) {
      throw new TypeError(`${label}.label is invalid.`);
    }
  };
  const boundedArray = (value, label, { allowEmpty = false } = {}) => {
    if (!Array.isArray(value) || (!allowEmpty && value.length < 1) || value.length > MAX_OUTPUTS) {
      throw new TypeError(`${label} must be an array of at most ${MAX_OUTPUTS} items.`);
    }
  };
  if (["fill_pdf", "fill_with_profile"].includes(request.operation)) objectValue(options.field_data, "field_data");
  if (request.operation === "bulk_fill_from_csv") {
    boundedArray(options.records, "records");
    options.records.forEach((record, index) => objectValue(record, `records[${index}]`));
  }
  if (request.operation === "split_pdf"
      && (typeof options.page_ranges !== "string" || options.page_ranges.length < 1 || options.page_ranges.length > 16_384)) {
    throw new TypeError("page_ranges is invalid.");
  }
  if (request.operation === "rotate_pdf_pages") {
    boundedArray(options.pages, "pages", { allowEmpty: true });
    if (![90, 180, 270].includes(options.degrees)) throw new TypeError("degrees is invalid.");
  }
  if (["reorder_pdf_pages", "apply_page_plan"].includes(request.operation)) {
    boundedArray(options.page_order, "page_order");
    objectValue(options.rotations, "rotations");
    if (options.page_order.some(page => !Number.isSafeInteger(page) || page < 1)) {
      throw new TypeError("page_order contains an invalid page.");
    }
    for (const [page, rotation] of Object.entries(options.rotations)) {
      if (!/^[1-9]\d*$/.test(page) || ![0, 90, 180, 270].includes(rotation)) {
        throw new TypeError("rotations contains an invalid page or angle.");
      }
    }
  }
  if (["add_signature_field", "apply_signature", "apply_text"].includes(request.operation)) {
    placement(options.placement, "placement", { labelField: request.operation === "add_signature_field" });
  }
  if (request.operation === "apply_signature") {
    const signature = options.signature;
    objectValue(signature, "signature");
    if (typeof signature.name !== "string" || signature.name.length < 1 || signature.name.length > 500) {
      throw new TypeError("signature.name is invalid.");
    }
    if (signature.style === "typed") {
      exactOptionalKeys(signature, ["display_name", "name", "style"], ["created_at"], "signature");
      if (typeof signature.display_name !== "string" || signature.display_name.length < 1
          || signature.display_name.length > 120) {
        throw new TypeError("signature.display_name is invalid.");
      }
    } else if (signature.style === "image") {
      exactOptionalKeys(
        signature,
        ["image_data_b64", "image_mime", "name", "style"],
        ["created_at", "display_name", "source_path"],
        "signature",
      );
      if (!["image/png", "image/jpeg"].includes(signature.image_mime)
          || typeof signature.image_data_b64 !== "string"
          || signature.image_data_b64.length < 1
          || signature.image_data_b64.length > 4 * Math.ceil((10 * 1024 * 1024) / 3)) {
        throw new TypeError("signature image binding is invalid.");
      }
      for (const key of ["display_name", "source_path"]) {
        if (Object.hasOwn(signature, key) && signature[key] !== null && typeof signature[key] !== "string") {
          throw new TypeError(`signature.${key} is invalid.`);
        }
      }
    } else {
      throw new TypeError("signature.style is invalid.");
    }
    if (Object.hasOwn(signature, "created_at")
        && signature.created_at !== null && typeof signature.created_at !== "string") {
      throw new TypeError("signature.created_at is invalid.");
    }
  }
  if (request.operation === "prepare_signing_packet") {
    objectValue(options.field_values, "field_values");
    boundedArray(options.signature_locations, "signature_locations", { allowEmpty: true });
    const zoneIds = new Set();
    const zoneBindings = new Set();
    options.signature_locations.forEach((item, index) => {
      exactKeys(item, [
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
      ], `signature_locations[${index}]`);
      placement(
        {
          page: item.page,
          x: item.x,
          y: item.y,
          width: item.width,
          height: item.height,
          label: item.label,
        },
        `signature_locations[${index}]`,
        { labelField: true },
      );
      if (typeof item.zone_id !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(item.zone_id)) {
        throw new TypeError(`signature_locations[${index}].zone_id is invalid.`);
      }
      if (!["signature", "initials", "date", "printed_name", "witness_signature", "unspecified"].includes(item.field_type)) {
        throw new TypeError(`signature_locations[${index}].field_type is invalid.`);
      }
      if (!["caller_supplied", "detect_signature_zones", "acroform"].includes(item.evidence_source)) {
        throw new TypeError(`signature_locations[${index}].evidence_source is invalid.`);
      }
      for (const key of ["participant_id", "participant_role"]) {
        if (
          item[key] !== null
          && (
            typeof item[key] !== "string"
            || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(item[key])
          )
        ) {
          throw new TypeError(`signature_locations[${index}].${key} is invalid.`);
        }
      }
      if (zoneIds.has(item.zone_id)) throw new TypeError("signature_locations contains a duplicate zone_id.");
      const binding = [
        item.page, item.x, item.y, item.width, item.height,
      ].map(value => JSON.stringify(value)).join("\0");
      if (zoneBindings.has(binding)) {
        throw new TypeError("signature_locations contains conflicting duplicate geometry.");
      }
      zoneIds.add(item.zone_id);
      zoneBindings.add(binding);
    });
    if (typeof options.require_provider_ready !== "boolean") {
      throw new TypeError("require_provider_ready must be boolean.");
    }
    if (
      options.require_provider_ready
      && (
        options.signature_locations.length === 0
        || options.signature_locations.some(item =>
          item.field_type === "unspecified"
          || item.participant_id === null
          || item.participant_role === null)
      )
    ) {
      throw new TypeError("Provider-ready signing packets require typed, participant-bound zones.");
    }
  }
  if (Object.hasOwn(options, "allow_resign") && typeof options.allow_resign !== "boolean") {
    throw new TypeError("allow_resign must be boolean.");
  }
  for (const key of ["audit_line", "modification_at", "text", "font_style"]) {
    if (Object.hasOwn(options, key)
        && (typeof options[key] !== "string" || options[key].length < 1 || options[key].length > 16_384)) {
      throw new TypeError(`${key} is invalid.`);
    }
  }
  if (
    Object.hasOwn(options, "audit_text")
    && (
      typeof options.audit_text !== "string"
      || options.audit_text.length > 16_384
      || (options.draw_audit_line === true && options.audit_text.length < 1)
    )
  ) {
    throw new TypeError("audit_text is invalid.");
  }
  if (Object.hasOwn(options, "draw_audit_line") && typeof options.draw_audit_line !== "boolean") {
    throw new TypeError("draw_audit_line must be boolean.");
  }
  if (typeof request.stage_directory !== "string" || !path.isAbsolute(request.stage_directory)) {
    throw new TypeError("stage_directory must be absolute.");
  }
  const bytes = Buffer.from(JSON.stringify(request), "utf8");
  if (bytes.length > MAX_REQUEST_BYTES) throw resourceError("request_too_large", "Mutation control input is too large.");
  return bytes;
}

function isPdfWhitespace(byte) {
  return byte === 0x00 || byte === 0x09 || byte === 0x0a
    || byte === 0x0c || byte === 0x0d || byte === 0x20;
}

function isPdfDelimiter(byte) {
  return byte === 0x28 || byte === 0x29 || byte === 0x3c || byte === 0x3e
    || byte === 0x5b || byte === 0x5d || byte === 0x7b || byte === 0x7d
    || byte === 0x2f || byte === 0x25;
}

function decodePdfName(bytes, start, end) {
  let value = "";
  for (let index = start; index < end && value.length <= MAX_STRUCTURE_TOKEN_BYTES; index += 1) {
    if (bytes[index] === 0x23 && index + 2 < end) {
      const encoded = bytes.subarray(index + 1, index + 3).toString("ascii");
      if (/^[a-fA-F0-9]{2}$/.test(encoded)) {
        value += String.fromCharCode(Number.parseInt(encoded, 16));
        index += 2;
        continue;
      }
    }
    value += String.fromCharCode(bytes[index]);
  }
  return value;
}

const PDF_ENDSTREAM_KEYWORD = Buffer.from("endstream", "ascii");

// Resolve the end of one stream payload the way pdf-lib's own parser does:
// trust a direct /Length only when the bytes it points past really are the
// endstream keyword, and otherwise fall back to searching for that keyword.
// A payload that misleads this also misleads pdf-lib, so the two views of a
// document cannot be made to disagree about where structure resumes.
function resolvePdfStreamPayload(bytes, offset, declaredLength) {
  let start = offset;
  if (bytes[start] === 0x0d) start += 1;
  if (bytes[start] === 0x0a) start += 1;
  if (declaredLength !== null && start + declaredLength <= bytes.length) {
    let probe = start + declaredLength;
    while (probe < bytes.length && isPdfWhitespace(bytes[probe])) probe += 1;
    if (bytes.subarray(probe, probe + PDF_ENDSTREAM_KEYWORD.length)
      .equals(PDF_ENDSTREAM_KEYWORD)) {
      return { payloadStart: start, payloadEnd: start + declaredLength, resumeAt: probe };
    }
  }
  const found = bytes.indexOf(PDF_ENDSTREAM_KEYWORD, start);
  const end = found < 0 ? bytes.length : found;
  return { payloadStart: start, payloadEnd: end, resumeAt: end };
}

// This lexer retains only a bounded token and a handful of parser states. It
// deliberately ignores comments and PDF string objects, where structural
// spellings are data. Whitespace and comments may be arbitrarily long, so a
// sparse declaration cannot evade the guard by crossing a fixed-size overlap.
//
// By default stream payloads are tokenized too, because pdf-lib resynchronizes
// inside a payload whose /Length lies and will parse object headers out of it.
// skipStreamPayloads is for the cross-reference byte-width pass, which needs
// the structural view pdf-lib's parser itself acts on: a single unpaired "<"
// or "(" in compressed payload bytes otherwise swallows every following token
// up to the next ">" or ")", which is enough to hide a whole xref dictionary.
function* pdfStructureTokens(bytes, { skipStreamPayloads = false } = {}) {
  let offset = 0;
  let expectLengthValue = false;
  let declaredLength = null;
  while (offset < bytes.length) {
    const byte = bytes[offset];
    if (isPdfWhitespace(byte)) {
      offset += 1;
      continue;
    }
    if (byte === 0x25) {
      offset += 1;
      while (offset < bytes.length && bytes[offset] !== 0x0a && bytes[offset] !== 0x0d) offset += 1;
      continue;
    }
    if (byte === 0x28) {
      let depth = 1;
      offset += 1;
      while (offset < bytes.length && depth > 0) {
        if (bytes[offset] === 0x5c) {
          offset += Math.min(2, bytes.length - offset);
        } else {
          if (bytes[offset] === 0x28) depth += 1;
          if (bytes[offset] === 0x29) depth -= 1;
          offset += 1;
        }
      }
      continue;
    }
    if (byte === 0x3c && bytes[offset + 1] !== 0x3c) {
      offset += 1;
      while (offset < bytes.length && bytes[offset] !== 0x3e) offset += 1;
      if (offset < bytes.length) offset += 1;
      continue;
    }
    if (byte === 0x2f) {
      const start = ++offset;
      while (offset < bytes.length && !isPdfWhitespace(bytes[offset]) && !isPdfDelimiter(bytes[offset])) {
        offset += 1;
      }
      const nameToken = {
        type: "name",
        value: decodePdfName(bytes, start, offset),
        overlong: offset - start > MAX_STRUCTURE_TOKEN_BYTES,
      };
      yield nameToken;
      if (skipStreamPayloads) {
        expectLengthValue = !nameToken.overlong && nameToken.value === "Length";
      }
      continue;
    }
    if (isPdfDelimiter(byte)) {
      const paired = (byte === 0x3c && bytes[offset + 1] === 0x3c)
        || (byte === 0x3e && bytes[offset + 1] === 0x3e);
      yield { type: "delimiter", value: paired ? String.fromCharCode(byte, byte) : String.fromCharCode(byte) };
      offset += paired ? 2 : 1;
      continue;
    }
    const start = offset;
    let allDigits = true;
    let digitLength = 0;
    if (bytes[offset] === 0x2b || bytes[offset] === 0x2d) offset += 1;
    while (offset < bytes.length && !isPdfWhitespace(bytes[offset]) && !isPdfDelimiter(bytes[offset])) {
      if (bytes[offset] < 0x30 || bytes[offset] > 0x39) {
        allDigits = false;
      } else {
        digitLength += 1;
      }
      offset += 1;
    }
    const length = offset - start;
    if (digitLength === 0) allDigits = false;
    const token = {
      type: allDigits ? "integer" : "word",
      value: bytes.subarray(start, Math.min(offset, start + MAX_STRUCTURE_TOKEN_BYTES)).toString("latin1"),
      overlong: length > MAX_STRUCTURE_TOKEN_BYTES,
      digitLength: allDigits ? digitLength : 0,
    };
    if (!skipStreamPayloads) {
      yield token;
      continue;
    }
    if (expectLengthValue) {
      yield token;
      expectLengthValue = false;
      const value = token.type === "integer" && token.digitLength <= 15
        ? Number(token.value)
        : null;
      declaredLength = Number.isSafeInteger(value) && value >= 0 ? value : null;
      continue;
    }
    if (token.type === "word" && !token.overlong && token.value === "stream") {
      const { payloadStart, payloadEnd, resumeAt } = resolvePdfStreamPayload(
        bytes,
        offset,
        declaredLength,
      );
      yield { ...token, payloadStart, payloadEnd };
      offset = resumeAt;
      declaredLength = null;
      continue;
    }
    yield token;
  }
}

function collectPreparseStreamDecodes(bytes) {
  const streams = [];
  const dictionaries = [];
  let lastClosedDictionary = null;
  const markMalformedValue = frame => {
    if (frame?.pendingKey === "Type") frame.typeAmbiguous = true;
    if (frame?.pendingKey === "Filter") frame.filterAmbiguous = true;
    if (frame) frame.pendingKey = null;
  };
  for (const token of pdfStructureTokens(bytes, { skipStreamPayloads: true })) {
    const frame = dictionaries.at(-1);
    if (token.type === "delimiter" && token.value === "<<") {
      markMalformedValue(frame);
      dictionaries.push({
        type: null,
        typeAmbiguous: false,
        filters: null,
        filterAmbiguous: false,
        filterArray: false,
        pendingKey: null,
      });
      lastClosedDictionary = null;
      continue;
    }
    if (token.type === "delimiter" && token.value === ">>") {
      const closing = dictionaries.pop() ?? null;
      markMalformedValue(closing);
      lastClosedDictionary = closing;
      continue;
    }
    if (frame?.filterArray) {
      if (token.type === "delimiter" && token.value === "]") {
        frame.filterArray = false;
        frame.pendingKey = null;
      } else if (token.type === "name" && !token.overlong) {
        frame.filters.push(token.value);
      } else {
        frame.filterAmbiguous = true;
      }
      lastClosedDictionary = null;
      continue;
    }
    if (frame?.pendingKey === "Type") {
      if (token.type === "name" && !token.overlong) frame.type = token.value;
      else frame.typeAmbiguous = true;
      frame.pendingKey = null;
      lastClosedDictionary = null;
      continue;
    }
    if (frame?.pendingKey === "Filter") {
      if (token.type === "name" && !token.overlong) {
        frame.filters = [token.value];
        frame.pendingKey = null;
      } else if (token.type === "delimiter" && token.value === "[") {
        frame.filters = [];
        frame.filterArray = true;
      } else {
        frame.filterAmbiguous = true;
        frame.pendingKey = null;
      }
      lastClosedDictionary = null;
      continue;
    }
    if (frame && token.type === "name" && !token.overlong
        && (token.value === "Type" || token.value === "Filter")) {
      frame.pendingKey = token.value;
      lastClosedDictionary = null;
      continue;
    }
    if (token.type === "word" && token.value === "stream"
        && Number.isSafeInteger(token.payloadStart)
        && Number.isSafeInteger(token.payloadEnd)) {
      if (lastClosedDictionary) {
        streams.push({
          ...lastClosedDictionary,
          payloadStart: token.payloadStart,
          payloadEnd: token.payloadEnd,
        });
      }
      lastClosedDictionary = null;
      continue;
    }
    lastClosedDictionary = null;
  }
  return streams;
}

async function countFlateBytesWithinLimit(payload, maximumDecodedBytes) {
  const source = Readable.from((function* compressedChunks() {
    for (let offset = 0; offset < payload.length; offset += DECODE_INSPECTION_CHUNK_BYTES) {
      yield payload.subarray(offset, offset + DECODE_INSPECTION_CHUNK_BYTES);
    }
  })());
  const decoder = createInflate({ chunkSize: DECODE_INSPECTION_CHUNK_BYTES });
  source.pipe(decoder);
  let decodedBytes = 0;
  try {
    for await (const chunk of decoder) {
      decodedBytes += chunk.length;
      if (decodedBytes > maximumDecodedBytes) {
        throw resourceError(
          "unsafe_object_stream_expansion",
          `PDF object stream exceeds the ${maximumDecodedBytes}-byte decoded ceiling; `
          + "the document was rejected before parsing.",
        );
      }
    }
    return decodedBytes;
  } finally {
    source.destroy();
    decoder.destroy();
  }
}

export async function assertBoundedPdfStreamDecodes(bytes, {
  maximumDecodedObjectStreamBytes = MAX_DECODED_OBJECT_STREAM_BYTES,
} = {}) {
  if (!(bytes instanceof Uint8Array)
      || !Number.isSafeInteger(maximumDecodedObjectStreamBytes)
      || maximumDecodedObjectStreamBytes < 1
      || maximumDecodedObjectStreamBytes > MAX_DECODED_OBJECT_STREAM_BYTES) {
    throw new TypeError("Decoded object-stream inspection options are invalid.");
  }
  const rejectUnsupportedObjectStream = detail => {
    throw resourceError(
      "unsafe_object_stream_decode",
      `PDF object stream cannot be decoded within a deterministic byte budget (${detail}); `
      + "the document was rejected before parsing.",
    );
  };
  for (const stream of collectPreparseStreamDecodes(bytes)) {
    if (stream.typeAmbiguous) {
      rejectUnsupportedObjectStream("indirect or malformed Type");
    }
    const objectStream = stream.type === "ObjStm";
    // Content and image streams are not decoded eagerly by PDFDocument.load;
    // they remain covered by the existing parsed-stream probe. Re-decoding
    // them here would add full-document work without closing the object-stream
    // allocation gap this preflight exists to cover.
    if (!objectStream) continue;
    if (stream.filterAmbiguous) {
      rejectUnsupportedObjectStream("indirect or malformed Filter");
    }
    const filters = stream.filters?.map(value => FILTER_NAME_ALIASES.get(value) ?? value) ?? [];
    if (filters.length === 0) {
      if (stream.payloadEnd - stream.payloadStart > maximumDecodedObjectStreamBytes) {
        throw resourceError(
          "unsafe_object_stream_expansion",
          `PDF object stream exceeds the ${maximumDecodedObjectStreamBytes}-byte decoded ceiling; `
          + "the document was rejected before parsing.",
        );
      }
      continue;
    }
    if (filters.length !== 1 || filters[0] !== "FlateDecode") {
      rejectUnsupportedObjectStream("unsupported Filter chain");
    }
    try {
      await countFlateBytesWithinLimit(
        bytes.subarray(stream.payloadStart, stream.payloadEnd),
        maximumDecodedObjectStreamBytes,
      );
    } catch (error) {
      if (error?.code === RESOURCE_CODE) throw error;
      // A malformed stream that fails before reaching the ceiling remains the
      // parser's responsibility. The preflight exists only to prevent an
      // otherwise valid expanding decode from allocating past its budget.
    }
  }
}

// pdf-lib 1.17.1 reads a cross-reference stream's /W byte widths straight
// into the loop bounds of PDFXRefStreamParser.parseEntries without any range
// check, so /W [1 2000000000 1] spins that loop for billions of iterations on
// a one-kilobyte file while resident memory stays flat. The RSS monitor cannot
// see a flat-memory spin, which leaves only the subprocess deadline between a
// hostile document and a wedged worker. The defect is Hopding/pdf-lib#1776
// (CWE-190); the fix in PR #1781 is unmerged and the issue was closed
// untouched by a stale bot, so the bound has to live on our side of the
// parser. The reasoning ported from that PR is the ISO 32000-1:2008 Table 17
// range check below; the premature end-of-stream handling it also adds is not
// reproducible from here, because a bounded /W can never read past a bounded
// entry count.
function assertBoundedXRefStreamByteWidths(bytes) {
  const rejectByteWidth = detail => {
    throw resourceError(
      "unsafe_xref_byte_width",
      `PDF declares an unsafe cross-reference stream byte width (${detail}); `
      + "the document was rejected before parsing.",
    );
  };
  // The loop bound pdf-lib derives is the numeric magnitude, so magnitude is
  // what has to be bounded. A non-canonical spelling such as 1.0 stays
  // acceptable; 2000000000.0 does not.
  const byteWidthNumber = token => {
    if (token.overlong) return Number.POSITIVE_INFINITY;
    if (token.type === "integer") return Number(token.value);
    if (token.type === "word" && PDF_REAL_NUMBER.test(token.value)) return Number(token.value);
    return null;
  };
  const assertByteWidths = widths => {
    let entryBytes = 0;
    for (let index = 0; index < widths.length; index += 1) {
      const { raw, value } = widths[index];
      if (!Number.isFinite(value) || value < 0 || value > MAX_XREF_FIELD_BYTES) {
        rejectByteWidth(`/W[${index}] = ${raw}`);
      }
      if (index < 3) entryBytes += value;
    }
    if (entryBytes > MAX_XREF_ENTRY_BYTES) {
      rejectByteWidth(`/W implies a ${entryBytes}-byte entry`);
    }
  };
  const dictStack = [];
  let untrackedDictDepth = 0;
  let expectTypeValue = false;
  let widthState = "idle";
  let widthFrame = null;
  let widthDepth = 0;
  let widthValues = null;
  let widthMalformed = false;
  const resetWidthCollection = () => {
    widthState = "idle";
    widthFrame = null;
    widthDepth = 0;
    widthValues = null;
    widthMalformed = false;
  };

  for (const token of pdfStructureTokens(bytes, { skipStreamPayloads: true })) {
    // Bind each /W array to the dictionary that declares it so a CIDFont /W
    // glyph-width array, whose legitimate elements are far larger than eight,
    // is never mistaken for a cross-reference stream's byte widths. The widths
    // are checked when the dictionary closes, because /Type /XRef may be
    // written after /W.
    if (expectTypeValue) {
      if (token.type === "name" && !token.overlong && token.value === "XRef") {
        const frame = dictStack.at(-1);
        if (frame) frame.xrefStream = true;
      }
      expectTypeValue = false;
    }
    if (widthState === "bracket") {
      if (token.type === "delimiter" && token.value === "[") {
        widthState = "collect";
        widthDepth = 1;
        widthValues = [];
        widthMalformed = false;
      } else {
        resetWidthCollection();
      }
    } else if (widthState === "collect") {
      if (token.type === "delimiter" && token.value === "[") {
        widthDepth += 1;
        widthMalformed = true;
      } else if (token.type === "delimiter" && token.value === "]") {
        widthDepth -= 1;
        if (widthDepth === 0) {
          if (widthFrame && !widthMalformed) widthFrame.widths = widthValues;
          resetWidthCollection();
        }
      } else if (widthDepth === 1) {
        // A non-numeric element makes pdf-lib's own W.lookup(idx, PDFNumber)
        // throw inside the constructor, before parseEntries runs, so such an
        // array needs no bound from here.
        const value = byteWidthNumber(token);
        if (value === null) widthMalformed = true;
        else if (widthValues.length < MAX_TRACKED_XREF_WIDTHS) {
          widthValues.push({ raw: token.value, value });
        }
      }
    }
    if (token.type === "delimiter" && token.value === "<<") {
      if (dictStack.length < MAX_TRACKED_DICT_DEPTH) {
        dictStack.push({ xrefStream: false, widths: null });
      } else {
        untrackedDictDepth += 1;
      }
    } else if (token.type === "delimiter" && token.value === ">>") {
      if (untrackedDictDepth > 0) {
        untrackedDictDepth -= 1;
      } else {
        const frame = dictStack.pop();
        if (frame === widthFrame) resetWidthCollection();
        if (frame?.xrefStream && frame.widths) assertByteWidths(frame.widths);
      }
    }
    if (token.type === "name" && !token.overlong) {
      if (token.value === "Type") expectTypeValue = true;
      if (token.value === "W" && dictStack.length > 0) {
        widthState = "bracket";
        widthFrame = dictStack.at(-1);
        widthDepth = 0;
        widthValues = null;
        widthMalformed = false;
      }
    }
  }
}

export function assertBoundedPdfStructure(bytes) {
  assertBoundedXRefStreamByteWidths(bytes);
  const densityLimit = Math.min(
    MAX_REASONABLE_OBJECT_NUMBER,
    Math.max(100_000, bytes.length * 32),
  );
  const reject = (kind, value) => {
    throw resourceError(
      "sparse_pdf_structure",
      `PDF declares an unsafe sparse ${kind} (${value}); the document was rejected before parsing.`,
    );
  };
  const integerValue = token => {
    if (token?.type !== "integer" || token.digitLength > 15) return null;
    const value = Number(token.value);
    return Number.isSafeInteger(value) ? value : null;
  };
  const assertNumber = (token, kind) => {
    if (token?.type !== "integer") return null;
    const value = integerValue(token);
    if (value === null || value > densityLimit) reject(kind, token.value);
    return value;
  };
  const recent = [];
  let expectSize = false;
  let classicXrefState = "idle";
  let classicXrefStart = null;
  let classicXrefEntriesRemaining = 0;
  let indexState = "idle";
  let indexStart = null;

  for (const token of pdfStructureTokens(bytes)) {
    if (expectSize) {
      assertNumber(token, "trailer Size");
      expectSize = false;
    }

    if (token.type === "word" && !token.overlong && token.value === "xref") {
      classicXrefState = "subsectionStart";
      classicXrefStart = null;
      classicXrefEntriesRemaining = 0;
    } else if (classicXrefState === "subsectionStart") {
      if (token.type === "word" && token.value === "trailer") {
        classicXrefState = "idle";
      } else if (token.type === "integer") {
        classicXrefStart = assertNumber(token, "xref range");
        classicXrefState = "subsectionCount";
      } else {
        reject("xref table syntax", token.value);
      }
    } else if (classicXrefState === "subsectionCount") {
      if (token.type !== "integer") reject("xref table syntax", token.value);
      const count = assertNumber(token, "xref range");
      if (classicXrefStart + count > densityLimit + 1) {
        reject("xref range", `${classicXrefStart}+${count}`);
      }
      classicXrefEntriesRemaining = count;
      classicXrefState = count === 0 ? "subsectionStart" : "entryOffset";
    } else if (classicXrefState === "entryOffset") {
      if (integerValue(token) === null) reject("xref table syntax", token.value);
      classicXrefState = "entryGeneration";
    } else if (classicXrefState === "entryGeneration") {
      if (integerValue(token) === null) reject("xref table syntax", token.value);
      classicXrefState = "entryMarker";
    } else if (classicXrefState === "entryMarker") {
      if (token.type !== "word" || (token.value !== "n" && token.value !== "f")) {
        reject("xref table syntax", token.value);
      }
      classicXrefEntriesRemaining -= 1;
      classicXrefState = classicXrefEntriesRemaining === 0
        ? "subsectionStart"
        : "entryOffset";
    }

    if (indexState === "bracket") {
      indexState = token.type === "delimiter" && token.value === "[" ? "start" : "idle";
    } else if (indexState === "start") {
      if (token.type === "delimiter" && token.value === "]") {
        indexState = "idle";
      } else if (token.type === "integer") {
        indexStart = assertNumber(token, "xref-stream Index");
        indexState = "count";
      } else {
        indexState = "idle";
      }
    } else if (indexState === "count") {
      if (token.type === "integer") {
        const count = assertNumber(token, "xref-stream Index");
        if (indexStart + count > densityLimit + 1) {
          reject("xref-stream Index", `${indexStart}+${count}`);
        }
        indexStart = null;
        indexState = "start";
      } else {
        indexStart = null;
        indexState = "idle";
      }
    }

    if (token.type === "name" && !token.overlong) {
      if (token.value === "Size") expectSize = true;
      if (token.value === "Index") {
        indexState = "bracket";
        indexStart = null;
      }
    }
    if (token.type === "word" && (token.value === "obj" || token.value === "R")) {
      const objectNumber = recent.at(-2);
      const generation = recent.at(-1);
      if (objectNumber?.type === "integer" && generation?.type === "integer") {
        assertNumber(
          objectNumber,
          token.value === "obj" ? "object number" : "object reference",
        );
      }
    }
    recent.push(token);
    if (recent.length > 2) recent.shift();
  }
}

function validatePageTree(pdfDoc) {
  const rootRef = pdfDoc.catalog.get(PDFName.of("Pages"));
  if (!(rootRef instanceof PDFRef)) throw new Error("page tree root must be an indirect reference");
  const root = pdfDoc.context.lookupMaybe(rootRef, PDFPageTree);
  if (!(root instanceof PDFPageTree)) throw new Error("page tree root is unavailable");
  if (root.lookupMaybe(PDFName.of("Parent"), PDFPageTree)) throw new Error("page tree root must not have a parent");
  const seen = new Set([root]);
  const frame = (tree, parent) => {
    const kids = tree.lookupMaybe(PDFName.of("Kids"), PDFArray);
    const count = tree.lookupMaybe(PDFName.of("Count"), PDFNumber);
    if (!(kids instanceof PDFArray) || !(count instanceof PDFNumber)) throw new Error("invalid page tree node");
    const declared = count.asNumber();
    if (!Number.isSafeInteger(declared) || declared < 0) throw new Error("invalid page tree count");
    return { tree, parent, kids, declared, next: 0, reached: 0 };
  };
  const stack = [frame(root, null)];
  while (stack.length) {
    const current = stack[stack.length - 1];
    if (current.next >= current.kids.size()) {
      if (current.reached !== current.declared) throw new Error("page tree count mismatch");
      stack.pop();
      if (current.parent) current.parent.reached += current.reached;
      continue;
    }
    const ref = current.kids.get(current.next++);
    if (!(ref instanceof PDFRef)) throw new Error("page tree child must be indirect");
    const child = pdfDoc.context.lookupMaybe(ref, PDFPageTree, PDFPageLeaf);
    if (!(child instanceof PDFPageTree) && !(child instanceof PDFPageLeaf)) throw new Error("invalid page tree child");
    if (seen.has(child)) throw new Error("duplicate or cyclic page tree child");
    seen.add(child);
    if (child.lookupMaybe(PDFName.of("Parent"), PDFPageTree) !== current.tree) throw new Error("invalid page parent");
    if (child instanceof PDFPageLeaf) current.reached += 1;
    else stack.push(frame(child, current));
  }
}

export function assertSafeParsedPdfDecodeChains(document) {
  const reject = detail => {
    throw resourceError(
      "unsafe_decode_chain",
      `PDF contains an unsafe parsed stream decoder chain (${detail}); mutation was stopped before saving.`,
    );
  };
  for (const [, object] of document.context.enumerateIndirectObjects()) {
    if (!(object instanceof PDFRawStream)) continue;
    const rawFilter = object.dict.get(PDFName.of("Filter"));
    if (rawFilter === undefined) continue;
    let filter;
    try {
      filter = document.context.lookup(rawFilter);
    } catch {
      reject("unresolvable Filter value");
    }
    const values = filter instanceof PDFName
      ? [filter]
      : filter instanceof PDFArray
        ? filter.asArray().map(value => {
            try {
              return document.context.lookup(value);
            } catch {
              reject("unresolvable Filter array entry");
            }
          })
        : null;
    if (values === null || values.some(value => !(value instanceof PDFName))) {
      reject("Filter value is not a name or name array");
    }
    if (values.length > MAX_STREAM_FILTER_CHAIN_LENGTH) {
      reject(`more than ${MAX_STREAM_FILTER_CHAIN_LENGTH} filters`);
    }
    let expandingStages = 0;
    for (const value of values) {
      const decoded = value.decodeText();
      const canonical = FILTER_NAME_ALIASES.get(decoded) ?? decoded;
      if (!EXPANDING_FILTERS.has(canonical)) continue;
      expandingStages += 1;
      if (expandingStages > MAX_EXPANDING_FILTER_STAGES) {
        reject(`more than ${MAX_EXPANDING_FILTER_STAGES} expanding filter stages`);
      }
    }
  }
}

export function isExpectedMalformedStreamDecodeError(error) {
  if (error?.constructor !== Error
      || typeof error.message !== "string"
      || error.message.length > 100) {
    return false;
  }
  const byte = String.raw`(?:0|[1-9]\d?|1\d{2}|2[0-4]\d|25[0-5])`;
  const byteOrEof = String.raw`(?:-1|${byte})`;
  const dynamic = [
    [new RegExp(`^Invalid header in flate stream: (${byteOrEof}), (${byteOrEof})$`),
      (cmf, flg) => cmf === -1 || flg === -1],
    [new RegExp(`^Unknown compression method in flate stream: (${byte}), (${byte})$`),
      cmf => (cmf & 0x0f) !== 0x08],
    [new RegExp(`^Bad FCHECK in flate stream: (${byte}), (${byte})$`),
      (cmf, flg) => (cmf & 0x0f) === 0x08
        && ((cmf << 8) + flg) % 31 !== 0],
    [new RegExp(`^FDICT bit set in flate stream: (${byte}), (${byte})$`),
      (cmf, flg) => (cmf & 0x0f) === 0x08
        && ((cmf << 8) + flg) % 31 === 0
        && (flg & 0x20) !== 0],
  ];
  for (const [pattern, branch] of dynamic) {
    const match = pattern.exec(error.message);
    if (match && branch(Number(match[1]), Number(match[2]))) return true;
  }
  return [
    /^Bad block header in flate stream$/,
    /^Bad uncompressed block length in flate stream$/,
    /^Unknown block type in flate stream$/,
    /^Bad encoding in flate stream$/,
  ].some(pattern => pattern.test(error.message));
}

export function enforceSafeParsedPdfGraph(document, {
  allowedSpecNullTargets = null,
  pruneUnreachableInvalid = true,
} = {}) {
  const reject = detail => {
    throw resourceError(
      "unsafe_pdf_integrity",
      `PDF contains unsafe object-graph integrity (${detail}); mutation was stopped before saving.`,
    );
  };
  const context = document?.context;
  if (!context || typeof context.enumerateIndirectObjects !== "function") {
    throw new TypeError("document must be a parsed PDFDocument.");
  }
  if (allowedSpecNullTargets !== null
      && !(allowedSpecNullTargets instanceof Set)
      && !(allowedSpecNullTargets instanceof Map)) {
    throw new TypeError("allowedSpecNullTargets must be a Set or Map.");
  }
  if (allowedSpecNullTargets?.size > MAX_PDF_GRAPH_EDGES) {
    reject(`more than ${MAX_PDF_GRAPH_EDGES} allowed null-reference targets`);
  }
  const allowedSpecNullTargetUses = allowedSpecNullTargets instanceof Map
    ? new Map([...allowedSpecNullTargets.keys()].map(target => [target, 0]))
    : null;
  const nodes = new Map();
  let directContainers = 0;
  let traversedEdges = 0;

  const inspect = roots => {
    const outgoing = new Set();
    const directSeen = new WeakSet();
    const directActive = new WeakSet();
    const pending = roots.map(value => ({ value, leaving: false }));
    let containsInvalid = false;
    while (pending.length > 0) {
      if (pending.length > MAX_PDF_GRAPH_PENDING) {
        reject(`more than ${MAX_PDF_GRAPH_PENDING} pending graph values`);
      }
      const { value, leaving } = pending.pop();
      if (leaving) {
        directActive.delete(value);
        continue;
      }
      if (value instanceof PDFRef) {
        traversedEdges += 1;
        if (traversedEdges > MAX_PDF_GRAPH_EDGES) {
          reject(`more than ${MAX_PDF_GRAPH_EDGES} graph edges`);
        }
        outgoing.add(value.toString());
        continue;
      }
      if (value instanceof PDFInvalidObject) {
        containsInvalid = true;
        continue;
      }
      if (!value || typeof value !== "object") continue;
      if (directActive.has(value)) reject("direct-container cycle");
      if (directSeen.has(value)) continue;
      directSeen.add(value);
      let children = null;
      if (value instanceof PDFStream) {
        directContainers += 1;
        children = [value.dict];
      } else if (value instanceof PDFArray) {
        directContainers += 1;
        children = value.asArray();
      } else if (value instanceof PDFDict) {
        directContainers += 1;
        children = value.entries().map(([, child]) => child);
      }
      if (children !== null) {
        directActive.add(value);
        pending.push({ value, leaving: true });
        for (const child of children) {
          pending.push({ value: child, leaving: false });
        }
      }
      if (directContainers > MAX_PARSED_CONTAINER_VISITS) {
        reject(`more than ${MAX_PARSED_CONTAINER_VISITS} direct graph containers`);
      }
    }
    return { outgoing, containsInvalid };
  };

  const indirect = context.enumerateIndirectObjects();
  if (indirect.length > MAX_PARSED_CONTAINER_VISITS) {
    reject(`more than ${MAX_PARSED_CONTAINER_VISITS} indirect objects`);
  }
  for (const [ref, object] of indirect) {
    const key = ref.toString();
    if (nodes.has(key)) reject(`duplicate indirect reference ${key}`);
    nodes.set(key, {
      ref,
      object,
      ...inspect([object]),
    });
  }
  const trailerInfo = context.trailerInfo;
  const rootRef = trailerInfo?.Root;
  if (!(rootRef instanceof PDFRef)
      || nodes.get(rootRef.toString())?.object !== document.catalog) {
    reject("trailer Root does not resolve to the parsed catalog");
  }
  const semanticRoots = new Set();
  for (const value of Object.values(trailerInfo)) {
    if (value === undefined) continue;
    const analysis = inspect([value]);
    if (analysis.containsInvalid) {
      reject("trailer contains a direct opaque invalid object");
    }
    for (const target of analysis.outgoing) semanticRoots.add(target);
  }

  const reachable = new Set();
  const pending = [...semanticRoots];
  while (pending.length > 0) {
    if (pending.length > MAX_PDF_GRAPH_PENDING) {
      reject(`more than ${MAX_PDF_GRAPH_PENDING} pending reachable references`);
    }
    const key = pending.pop();
    if (reachable.has(key)) continue;
    const node = nodes.get(key);
    // ISO 32000 defines an indirect reference to an undefined object as a
    // reference to null. Required consumers such as Root and the page tree are
    // validated independently; generic graph traversal must not call this an
    // integrity failure.
    if (!node) continue;
    reachable.add(key);
    if (node.containsInvalid) {
      reject(`trailer-reachable component ${key} contains an opaque invalid object`);
    }
    for (const target of node.outgoing) pending.push(target);
  }

  const removal = new Set();
  const reverse = new Map();
  for (const [key, node] of nodes) {
    if (reachable.has(key)) continue;
    if (node.containsInvalid) removal.add(key);
    for (const target of node.outgoing) {
      if (!nodes.has(target) || reachable.has(target)) continue;
      const predecessors = reverse.get(target) ?? new Set();
      predecessors.add(key);
      reverse.set(target, predecessors);
    }
  }
  if (!pruneUnreachableInvalid && removal.size > 0) {
    reject("serialized graph would contain an opaque invalid orphan component");
  }
  const tainted = [...removal];
  while (tainted.length > 0) {
    const target = tainted.pop();
    for (const predecessor of reverse.get(target) ?? []) {
      if (removal.has(predecessor)) continue;
      removal.add(predecessor);
      tainted.push(predecessor);
    }
  }
  for (const key of removal) context.delete(nodes.get(key).ref);
  for (const [key, node] of nodes) {
    if (removal.has(key)) continue;
    for (const target of node.outgoing) {
      if (removal.has(target)) {
        reject(`retained reference ${key} is dangling after graph closure`);
      }
    }
  }
  const specNullHash = createHash("sha256");
  const specNullSample = [];
  let specNullEdges = 0;
  let specNullReachableEdges = 0;
  let specNullOrphanEdges = 0;
  let specNullTrailerEdges = 0;
  let auditedReferenceEdges = 0;
  let auditedDirectContainers = 0;
  const token = (kind, value = null) => `${JSON.stringify([kind, value])}\n`;
  const appendSlot = (base, kind, value = null) => {
    const combined = `${base}${token(kind, value)}`;
    if (Buffer.byteLength(combined, "utf8") <= 4096) return combined;
    return token(
      "path_sha256",
      createHash("sha256").update(combined).digest("hex"),
    );
  };
  const keySlot = key => {
    const decoded = key.decodeText();
    return Buffer.byteLength(decoded, "utf8") <= 100
      ? ["dict_key", decoded]
      : [
        "dict_key_sha256",
        createHash("sha256").update(decoded).digest("hex"),
      ];
  };
  const audit = (value, owner, initialSlot, reachability, initialKind) => {
    const directActive = new WeakSet();
    const auditPending = [{
      value,
      slot: initialSlot,
      container_kind: initialKind,
      leaving: false,
    }];
    while (auditPending.length > 0) {
      if (auditPending.length > MAX_PDF_GRAPH_PENDING) {
        reject(`more than ${MAX_PDF_GRAPH_PENDING} pending reference-audit values`);
      }
      const current = auditPending.pop();
      if (current.leaving) {
        directActive.delete(current.value);
        continue;
      }
      if (current.value instanceof PDFRef) {
        auditedReferenceEdges += 1;
        if (auditedReferenceEdges > MAX_PDF_GRAPH_EDGES) {
          reject(`more than ${MAX_PDF_GRAPH_EDGES} audited graph edges`);
        }
        const target = current.value.toString();
        if (!nodes.has(target)) {
          if (allowedSpecNullTargets
              && !allowedSpecNullTargets.has(target)) {
            reject(`standards-defined null target ${target} lacks copier provenance`);
          }
          if (allowedSpecNullTargetUses) {
            allowedSpecNullTargetUses.set(
              target,
              allowedSpecNullTargetUses.get(target) + 1,
            );
          }
          const entry = {
            owner,
            slot: current.slot,
            target,
            reachability,
            container_kind: current.container_kind,
          };
          specNullEdges += 1;
          if (reachability === "trailer") specNullTrailerEdges += 1;
          else if (reachability === "reachable") specNullReachableEdges += 1;
          else specNullOrphanEdges += 1;
          specNullHash.update(JSON.stringify([
            entry.owner,
            entry.slot,
            entry.target,
            entry.reachability,
            entry.container_kind,
          ]));
          specNullHash.update("\n");
          if (specNullSample.length < MAX_SPEC_NULL_REFERENCE_SAMPLE) {
            specNullSample.push(entry);
          }
        }
        continue;
      }
      if (!current.value || typeof current.value !== "object") continue;
      if (!(current.value instanceof PDFStream)
          && !(current.value instanceof PDFArray)
          && !(current.value instanceof PDFDict)) {
        continue;
      }
      if (directActive.has(current.value)) reject("direct-container cycle during audit");
      directActive.add(current.value);
      auditedDirectContainers += 1;
      if (auditedDirectContainers > MAX_PARSED_CONTAINER_VISITS) {
        reject(`more than ${MAX_PARSED_CONTAINER_VISITS} audited direct containers`);
      }
      auditPending.push({ ...current, leaving: true });
      if (current.value instanceof PDFStream) {
        auditPending.push({
          value: current.value.dict,
          slot: appendSlot(current.slot, "stream_dict"),
          container_kind: "stream_dict",
          leaving: false,
        });
      } else if (current.value instanceof PDFArray) {
        const values = current.value.asArray();
        for (let index = values.length - 1; index >= 0; index -= 1) {
          auditPending.push({
            value: values[index],
            slot: appendSlot(current.slot, "array_index", index),
            container_kind: "array",
            leaving: false,
          });
        }
      } else if (current.value instanceof PDFDict) {
        const entries = current.value.entries().sort(([left], [right]) => {
          const leftName = left.decodeText();
          const rightName = right.decodeText();
          if (leftName !== rightName) return leftName < rightName ? -1 : 1;
          const leftEncoded = left.toString();
          const rightEncoded = right.toString();
          return leftEncoded === rightEncoded
            ? 0
            : (leftEncoded < rightEncoded ? -1 : 1);
        });
        for (let index = entries.length - 1; index >= 0; index -= 1) {
          const [kind, value] = keySlot(entries[index][0]);
          auditPending.push({
            value: entries[index][1],
            slot: appendSlot(current.slot, kind, value),
            container_kind: current.container_kind === "stream_dict"
              ? "stream_dict"
              : "dict",
            leaving: false,
          });
        }
      }
    }
  };
  const trailerEntries = Object.entries(trailerInfo)
    .sort(([left], [right]) => (left === right ? 0 : (left < right ? -1 : 1)));
  for (const [key, value] of trailerEntries) {
    if (value !== undefined) {
      audit(
        value,
        "trailer",
        token("trailer_field", key),
        "trailer",
        "trailer",
      );
    }
  }
  const sortedNodes = [...nodes.entries()].sort(([, left], [, right]) => (
    left.ref.objectNumber - right.ref.objectNumber
      || left.ref.generationNumber - right.ref.generationNumber
  ));
  for (const [key, node] of sortedNodes) {
    if (!removal.has(key)) {
      audit(
        node.object,
        key,
        "",
        reachable.has(key) ? "reachable" : "orphan",
        "indirect_object",
      );
    }
  }
  if (allowedSpecNullTargetUses) {
    for (const [target, uses] of allowedSpecNullTargetUses) {
      if (uses === 0) {
        reject(`copier provenance target ${target} is absent from the rebuilt graph`);
      }
    }
  }
  return {
    reachable_indirect_objects: reachable.size,
    removed_tainted_orphan_objects: removal.size,
    retained_indirect_objects: nodes.size - removal.size,
    traversed_edges: traversedEdges,
    direct_containers: directContainers,
    audited_reference_edges: auditedReferenceEdges,
    audited_direct_containers: auditedDirectContainers,
    spec_null_reference_edges: specNullEdges,
    spec_null_reachable_edges: specNullReachableEdges,
    spec_null_orphan_edges: specNullOrphanEdges,
    spec_null_trailer_edges: specNullTrailerEdges,
    spec_null_reference_inventory_sha256: specNullHash.digest("hex"),
    spec_null_reference_slot_encoding: "typed-json-sequence.v1",
    spec_null_reference_sample: specNullSample,
    spec_null_reference_samples_truncated:
      specNullEdges > specNullSample.length,
  };
}

export function assertSafeParsedPdfComplexity(document, {
  decodeStream = decodePDFRawStream,
} = {}) {
  if (typeof decodeStream !== "function") {
    throw new TypeError("decodeStream must be a function.");
  }
  const reject = (reason, detail) => {
    throw resourceError(
      reason,
      `PDF contains unsafe parsed complexity (${detail}); mutation was stopped before saving.`,
    );
  };
  const maximumDepth = new WeakMap();
  const inspectedStreams = new WeakSet();
  let containerVisits = 0;
  let totalDecodedInspectionBytes = 0;
  let indeterminateStreams = 0;

  const inspectExpansion = stream => {
    if (inspectedStreams.has(stream)) return;
    inspectedStreams.add(stream);
    const rawFilter = stream.dict.get(PDFName.of("Filter"));
    if (rawFilter === undefined) return;
    let filter;
    try {
      filter = document.context.lookup(rawFilter);
    } catch {
      reject("unsafe_stream_expansion", "unresolvable Filter value");
    }
    const values = filter instanceof PDFName
      ? [filter]
      : filter instanceof PDFArray
        ? filter.asArray().map(value => {
            try {
              return document.context.lookup(value);
            } catch {
              reject("unsafe_stream_expansion", "unresolvable Filter array entry");
            }
          })
        : null;
    if (values === null || values.length < 1
        || values.some(value => !(value instanceof PDFName))) {
      reject("unsafe_stream_expansion", "Filter value is not a name or name array");
    }
    const canonicalFilters = values.map(value => {
      const decoded = value.decodeText();
      return FILTER_NAME_ALIASES.get(decoded) ?? decoded;
    });
    // pdf-lib cannot incrementally decode chains containing image-only or
    // otherwise unsupported filters. Keep those chains under the separate
    // topology, worker-RSS, and timeout controls instead of pretending this
    // guard inspected their expansion.
    if (!canonicalFilters.every(value => BOUNDED_INSPECTION_FILTERS.has(value))) {
      indeterminateStreams += 1;
      return;
    }
    const compressedBytes = stream.contents.length;
    const decodedBudget = Math.min(
      MAX_DECODED_STREAM_BUDGET_BYTES,
      Math.max(
        MIN_DECODED_STREAM_BUDGET_BYTES,
        compressedBytes * MAX_DECODE_EXPANSION_RATIO,
      ),
    );
    try {
      // pdf-lib 1.17.1 recognizes full decoder names but not the standard
      // abbreviations accepted by our parsed topology policy. Decode a
      // shallow dictionary clone with canonical names so the inspected bytes
      // and original document remain unchanged.
      const decodeDictionary = stream.dict.clone(document.context);
      decodeDictionary.set(
        PDFName.of("Filter"),
        canonicalFilters.length === 1
          ? PDFName.of(canonicalFilters[0])
          : document.context.obj(
              canonicalFilters.map(value => PDFName.of(value)),
            ),
      );
      const decoder = decodeStream(
        PDFRawStream.of(decodeDictionary, stream.contents),
      );
      let decodedBytes = 0;
      for (;;) {
        const chunk = decoder.getBytes(DECODE_INSPECTION_CHUNK_BYTES);
        decodedBytes += chunk.length;
        if (decodedBytes > decodedBudget) {
          reject(
            "unsafe_stream_expansion",
            `decoded stream exceeds ${decodedBudget} bytes`,
          );
        }
        totalDecodedInspectionBytes += chunk.length;
        if (chunk.length < DECODE_INSPECTION_CHUNK_BYTES) break;
      }
    } catch (error) {
      if (error?.code === RESOURCE_CODE) throw error;
      if (isExpectedMalformedStreamDecodeError(error)) {
        indeterminateStreams += 1;
        return;
      }
      throw error;
    }
  };

  for (const [, root] of document.context.enumerateIndirectObjects()) {
    const stack = [{ value: root, depth: 0 }];
    while (stack.length > 0) {
      const { value, depth } = stack.pop();
      if (!value || typeof value !== "object" || value instanceof PDFRef) continue;
      const previousDepth = maximumDepth.get(value);
      if (previousDepth !== undefined && previousDepth >= depth) continue;
      maximumDepth.set(value, depth);
      containerVisits += 1;
      if (containerVisits > MAX_PARSED_CONTAINER_VISITS) {
        reject(
          "unsafe_pdf_complexity",
          `more than ${MAX_PARSED_CONTAINER_VISITS} container visits`,
        );
      }
      if (depth > MAX_PARSED_DIRECT_DEPTH) {
        reject(
          "unsafe_pdf_complexity",
          `direct object depth exceeds ${MAX_PARSED_DIRECT_DEPTH}`,
        );
      }
      if (value instanceof PDFRawStream) {
        inspectExpansion(value);
        stack.push({ value: value.dict, depth: depth + 1 });
      } else if (value instanceof PDFArray) {
        for (const child of value.asArray()) {
          stack.push({ value: child, depth: depth + 1 });
        }
      } else if (value instanceof PDFDict) {
        for (const [, child] of value.entries()) {
          stack.push({ value: child, depth: depth + 1 });
        }
      }
    }
  }
  return {
    expansion_probe: indeterminateStreams > 0
      ? "indeterminate"
      : "within_bound",
    indeterminate_streams: indeterminateStreams,
    decoded_inspection_bytes: totalDecodedInspectionBytes,
  };
}

function normalizedPageRotations(document) {
  return document.getPages().map(page => {
    const angle = page.getRotation().angle;
    return ((angle % 360) + 360) % 360;
  });
}

function signingPacketPageGeometry(document) {
  return document.getPages().map((page, index) => {
    const media = getPageBoxGeometry(page);
    let crop;
    try {
      const observed = page.getCropBox();
      crop = {
        origin_x: observed.x,
        origin_y: observed.y,
        width: observed.width,
        height: observed.height,
      };
    } catch {
      crop = {
        origin_x: media.originX,
        origin_y: media.originY,
        width: media.width,
        height: media.height,
      };
    }
    const geometry = {
      page: index + 1,
      rotation_degrees: ((page.getRotation().angle % 360) + 360) % 360,
      media_box: {
        origin_x: media.originX,
        origin_y: media.originY,
        width: media.width,
        height: media.height,
      },
      crop_box: crop,
    };
    const values = [
      geometry.media_box.origin_x,
      geometry.media_box.origin_y,
      geometry.media_box.width,
      geometry.media_box.height,
      geometry.crop_box.origin_x,
      geometry.crop_box.origin_y,
      geometry.crop_box.width,
      geometry.crop_box.height,
    ];
    if (
      ![0, 90, 180, 270].includes(geometry.rotation_degrees)
      || values.some(value => !Number.isFinite(value))
      || geometry.media_box.width <= 0
      || geometry.media_box.height <= 0
      || geometry.crop_box.width <= 0
      || geometry.crop_box.height <= 0
    ) {
      throw new TypeError(`Page ${index + 1} has unsupported signing geometry.`);
    }
    return geometry;
  });
}

function signingPacketZoneVisibleWithinCrop(zone, pageGeometry) {
  const x = pageGeometry.media_box.origin_x + zone.x - pageGeometry.crop_box.origin_x;
  const y = pageGeometry.crop_box.origin_y + pageGeometry.crop_box.height
    - (pageGeometry.media_box.origin_y + pageGeometry.media_box.height - zone.y);
  return x >= 0
    && y >= 0
    && x + zone.width <= pageGeometry.crop_box.width
    && y + zone.height <= pageGeometry.crop_box.height;
}

function specNullReferenceAuthority(graphPolicy) {
  return {
    edges: graphPolicy.spec_null_reference_edges,
    inventory_sha256: graphPolicy.spec_null_reference_inventory_sha256,
    slot_encoding: graphPolicy.spec_null_reference_slot_encoding,
  };
}

function sameSpecNullReferenceAuthority(left, right) {
  return left.edges === right.edges
    && left.inventory_sha256 === right.inventory_sha256
    && left.slot_encoding === right.slot_encoding;
}

function validateRebuiltSpecNullProvenance(provenance) {
  if (!(provenance instanceof Map)) {
    throw new TypeError("Internal rebuilt-output provenance must be a Map.");
  }
  if (provenance.size > MAX_PDF_GRAPH_EDGES) {
    throw resourceError(
      "unsafe_pdf_integrity",
      "Rebuilt-output provenance exceeds the bounded graph authority",
    );
  }
  const entries = [...provenance.entries()].sort(([left], [right]) => (
    left === right ? 0 : (left < right ? -1 : 1)
  ));
  const digest = createHash("sha256");
  for (const [target, authority] of entries) {
    if (!PDF_REF_LABEL_PATTERN.test(target)
        || !authority
        || Object.getPrototypeOf(authority) !== Object.prototype
        || JSON.stringify(Object.keys(authority).sort())
          !== JSON.stringify(["source_authority", "source_ref"])
        || !SHA256_AUTHORITY_PATTERN.test(authority.source_authority)
        || !PDF_REF_LABEL_PATTERN.test(authority.source_ref)) {
      throw resourceError(
        "unsafe_pdf_integrity",
        "Rebuilt-output provenance contains an invalid source authority",
      );
    }
    digest.update(JSON.stringify([
      target,
      authority.source_authority,
      authority.source_ref,
    ]));
    digest.update("\n");
  }
  return digest.digest("hex");
}

function captureRebuiltSpecNullAuthority(document, state) {
  const provenanceSha256 = validateRebuiltSpecNullProvenance(state.provenance);
  const graphPolicy = enforceSafeParsedPdfGraph(document, {
    allowedSpecNullTargets: state.provenance,
  });
  state.authority = {
    ...specNullReferenceAuthority(graphPolicy),
    provenance_sha256: provenanceSha256,
  };
  return graphPolicy;
}

function assertRebuiltSpecNullAuthority(document, state) {
  if (!state?.authority) {
    throw resourceError(
      "unsafe_pdf_integrity",
      "Rebuilt output lacks an opaque graph-authority checkpoint",
    );
  }
  const provenanceSha256 = validateRebuiltSpecNullProvenance(state.provenance);
  const graphPolicy = enforceSafeParsedPdfGraph(document, {
    allowedSpecNullTargets: state.provenance,
  });
  const current = {
    ...specNullReferenceAuthority(graphPolicy),
    provenance_sha256: provenanceSha256,
  };
  if (!sameSpecNullReferenceAuthority(current, state.authority)
      || current.provenance_sha256 !== state.authority.provenance_sha256) {
    throw resourceError(
      "unsafe_pdf_integrity",
      "Rebuilt output changed its sanctioned null-reference occurrence authority",
    );
  }
  return graphPolicy;
}

function prepareRebuiltSpecNullCopy(document) {
  if (inputSpecNullReferenceAuthorities.has(document)) {
    throw new TypeError("A loaded document cannot become a rebuilt output.");
  }
  let state = rebuiltSpecNullReferenceStates.get(document);
  if (state) {
    assertRebuiltSpecNullAuthority(document, state);
  } else {
    state = { provenance: new Map(), authority: null };
    rebuiltSpecNullReferenceStates.set(document, state);
  }
  return state;
}

function assertLoadedSourceAuthority(sourceDoc, sourceAuthorityLabel) {
  const sourceState = inputSpecNullReferenceAuthorities.get(sourceDoc);
  if (!sourceState
      || sourceState.source_sha256 !== sourceAuthorityLabel
      || !SHA256_AUTHORITY_PATTERN.test(sourceAuthorityLabel)) {
    throw resourceError(
      "unsafe_pdf_integrity",
      "Rebuilt-output source authority does not match the loaded source bytes",
    );
  }
}

function copyPdfDocumentMetadataForRebuiltOutput(
  targetDoc,
  sourceDoc,
  sourceAuthorityLabel,
) {
  assertLoadedSourceAuthority(sourceDoc, sourceAuthorityLabel);
  const state = prepareRebuiltSpecNullCopy(targetDoc);
  copyPdfDocumentMetadata(targetDoc, sourceDoc, {
    sourceAuthorityLabel,
    specNullTargetProvenance: state.provenance,
    registerRebuiltSpecNullAuthority() {
      captureRebuiltSpecNullAuthority(targetDoc, state);
    },
  });
}

async function copyPdfPagesForRebuiltOutput(
  targetDoc,
  sourceDoc,
  pageIndices,
  {
    sourceAuthorityLabel,
    mutatePage,
  } = {},
) {
  assertLoadedSourceAuthority(sourceDoc, sourceAuthorityLabel);
  const state = prepareRebuiltSpecNullCopy(targetDoc);
  return copyPdfPagesPreservingForms(targetDoc, sourceDoc, pageIndices, {
    sourceAuthorityLabel,
    specNullTargetProvenance: state.provenance,
    registerRebuiltSpecNullAuthority() {
      captureRebuiltSpecNullAuthority(targetDoc, state);
    },
    mutatePage,
  });
}

export const __testOnlyCopyPdfPagesForRebuiltOutput =
  process.env.NODE_ENV === "test"
    ? copyPdfPagesForRebuiltOutput
    : undefined;

export async function savePdfDocumentSafely(document, options = {}) {
  if (!options
      || Object.getPrototypeOf(options) !== Object.prototype
      || options instanceof Array
      || Object.keys(options).some(key => (
        key !== "expectedPageCount" && key !== "expectedPageRotations"
      ))) {
    throw new TypeError("Saved-output options contain an unknown authority.");
  }
  const {
    expectedPageCount,
    expectedPageRotations,
  } = options;
  if (!Number.isSafeInteger(expectedPageCount) || expectedPageCount < 1
      || !Array.isArray(expectedPageRotations)
      || expectedPageRotations.length !== expectedPageCount
      || expectedPageRotations.some(angle => (
        !Number.isFinite(angle) || angle < 0 || angle >= 360
      ))) {
    throw new TypeError("Saved-output postconditions are invalid.");
  }
  try {
    await document.flush();
  } catch {
    throw resourceError(
      "unsafe_pdf_integrity",
      "PDF failed to materialize deferred objects before verification",
    );
  }
  assertSafeParsedPdfDecodeChains(document);
  assertSafeParsedPdfComplexity(document);
  const initialState = inputSpecNullReferenceAuthorities.get(document);
  const initialAuthority = initialState?.graph_authority;
  const rebuiltState = rebuiltSpecNullReferenceStates.get(document);
  if (initialAuthority && rebuiltState) {
    throw new TypeError(
      "A loaded document cannot use rebuilt-output null-reference provenance.",
    );
  }
  const graphBeforeSave = rebuiltState
    ? assertRebuiltSpecNullAuthority(document, rebuiltState)
    : enforceSafeParsedPdfGraph(document);
  const beforeSaveAuthority = specNullReferenceAuthority(graphBeforeSave);
  if (!initialAuthority && beforeSaveAuthority.edges > 0
      && !rebuiltState) {
    throw resourceError(
      "unsafe_pdf_integrity",
      "Output contains a standards-defined null reference without source provenance",
    );
  }
  if (initialAuthority
      && !sameSpecNullReferenceAuthority(beforeSaveAuthority, initialAuthority)) {
    throw resourceError(
      "unsafe_pdf_integrity",
      "Mutation introduced or altered a standards-defined null reference",
    );
  }
  const bytes = await document.save({ addDefaultPage: false });
  let verified;
  let graphAfterSave;
  try {
    await assertBoundedPdfStreamDecodes(bytes);
    verified = await PDFDocument.load(bytes, { updateMetadata: false });
    graphAfterSave = enforceSafeParsedPdfGraph(
      verified,
      {
        allowedSpecNullTargets: rebuiltState?.provenance ?? null,
        pruneUnreachableInvalid: false,
      },
    );
    validatePageTree(verified);
  } catch (error) {
    if (error?.code === RESOURCE_CODE) throw error;
    throw resourceError(
      "unsafe_pdf_integrity",
      "Saved PDF failed isolated object-graph verification",
    );
  }
  if (!sameSpecNullReferenceAuthority(
    specNullReferenceAuthority(graphAfterSave),
    beforeSaveAuthority,
  )) {
    throw resourceError(
      "unsafe_pdf_integrity",
      "Saved PDF changed its standards-defined null-reference inventory",
    );
  }
  if (verified.getPageCount() !== expectedPageCount || expectedPageCount < 1) {
    throw resourceError(
      "unsafe_pdf_integrity",
      "Saved PDF changed its expected positive page count",
    );
  }
  if (JSON.stringify(normalizedPageRotations(verified))
      !== JSON.stringify(expectedPageRotations)) {
    throw resourceError(
      "unsafe_pdf_integrity",
      "Saved PDF changed its operation-intended page rotations",
    );
  }
  return bytes;
}

export async function loadPdfForMutation(bytes, password, { forceXfa = false, guardXfa = false } = {}) {
  assertBoundedPdfStructure(bytes);
  await assertBoundedPdfStreamDecodes(bytes);
  let document;
  try {
    document = await PDFDocument.load(bytes, password ? { password } : {});
  } catch (error) {
    if (error.message?.includes("password") || error.message?.includes("encrypt")) {
      throw new Error(PDF_LIB_ENCRYPTED_MESSAGE);
    }
    throw new Error("Failed to load PDF: the file is malformed, incomplete, or unsupported.", { cause: error });
  }
  assertSafeParsedPdfDecodeChains(document);
  assertSafeParsedPdfComplexity(document);
  const graphAuthority = enforceSafeParsedPdfGraph(document);
  inputSpecNullReferenceAuthorities.set(document, {
    graph_authority: specNullReferenceAuthority(graphAuthority),
    source_sha256: createHash("sha256").update(bytes).digest("hex"),
  });
  try {
    validatePageTree(document);
  } catch (error) {
    throw new Error("Failed to load PDF: the file is malformed, incomplete, or unsupported.", { cause: error });
  }
  if (document.getPageCount() < 1) {
    throw new Error("PDF has zero pages. A mutation requires at least one source and output page.");
  }
  // The parse-time XFA guard runs here, and only here, because this is the one
  // point every guarded mutation parses its source through. The parent's byte
  // scan cannot see an /XFA that lives in a compressed object stream, which is
  // most modern government forms; by this line pdf-lib has already inflated
  // them, so the check costs no extra parse. A decrypted source arrives here as
  // its plaintext, so an encrypted XFA form is caught too.
  if (guardXfa) assertParsedXfaMutationAllowed(document, { forceXfa });
  return document;
}


async function reopenSource(binding) {
  return withBoundedPdfFileSafely(
    binding.canonical_path,
    PDF_MUTATION_MAX_FILE_BYTES,
    {
      assertPathAllowed(candidate) {
        if (path.resolve(candidate) !== binding.canonical_path) throw new Error("Source path binding changed.");
      },
      createSizeLimitError: pdfMutationFileLimitError,
    },
    async source => {
      if (source.canonicalPath !== binding.canonical_path
          || source.sizeBytes !== binding.size_bytes
          || source.sha256 !== binding.sha256
          || source.fileIdentity.device !== binding.file_identity.device
          || source.fileIdentity.inode !== binding.file_identity.inode) {
        throw resourceError("source_drift", "PDF source changed before isolated mutation.");
      }
      return source.bytes;
    },
  );
}

async function inspectAccessibilitySource(bytes, binding) {
  assertBoundedPdfStructure(bytes);
  await assertBoundedPdfStreamDecodes(bytes);
  let document;
  try {
    document = await PDFDocument.load(bytes, { updateMetadata: false });
  } catch {
    // The pure primitive owns fixed encrypted abstention and malformed-result
    // classification. It never includes a parser diagnostic in either path.
    return inspectPdfAccessibilityBytes(bytes, {
      source_file_name: path.basename(binding.canonical_path),
    });
  }
  assertSafeParsedPdfDecodeChains(document);
  assertSafeParsedPdfComplexity(document);
  enforceSafeParsedPdfGraph(document);
  try {
    validatePageTree(document);
  } catch (error) {
    throw new AccessibilityInspectionError(
      "PDF_ACCESSIBILITY_INSPECTION_UNAVAILABLE",
      "PDF accessibility signal inspection is unavailable for this malformed document.",
    );
  }
  return validateAccessibilityInspectionResult(await inspectPdfAccessibilityBytes(bytes, {
    source_file_name: path.basename(binding.canonical_path),
  }));
}

function formInfo(document) {
  try {
    const fields = document.getForm().getFields().map(field => {
      let type = "unknown";
      let options = [];
      let currentValue = "";
      try {
        if (field.constructor.name.includes("TextField")) {
          type = "text"; currentValue = field.getText() || "";
        } else if (field.constructor.name.includes("CheckBox")) {
          type = "checkbox"; currentValue = field.isChecked();
        } else if (field.constructor.name.includes("RadioGroup")) {
          type = "radio"; currentValue = field.getSelected() || "";
        } else if (field.constructor.name.includes("Dropdown")) {
          type = "dropdown"; options = field.getOptions(); currentValue = field.getSelected() || "";
        }
      } catch {}
      return { name: field.getName(), type, options, currentValue };
    });
    return { fields, fieldCount: fields.length, hasFormFields: fields.length > 0 };
  } catch {
    return { fields: [], fieldCount: 0, hasFormFields: false };
  }
}

function assertMayResave(document, allowResign, noun = "modify") {
  const signatures = detectExistingSignatures(document);
  if (signatures.present && !allowResign) {
    throw new Error(
      `This PDF already contains ${signatures.fieldNames.length} cryptographic signature field(s) `
      + `(${signatures.fieldNames.slice(0, 3).join(", ")}${signatures.fieldNames.length > 3 ? "..." : ""}). `
      + `Saving would invalidate those signatures. Pass allow_resign=true if you intend to ${noun} a signed PDF.`,
    );
  }
}

function fillFields(document, data, { objectErrors = false } = {}) {
  const filledFields = [];
  const errors = [];
  const form = document.getForm();
  for (const [fieldName, value] of Object.entries(data ?? {})) {
    try {
      const field = form.getField(fieldName);
      const name = field.constructor.name;
      if (name.includes("TextField")) field.setText(String(value ?? ""));
      else if (name.includes("CheckBox")) {
        if (value === true || value === "true" || value === "yes" || value === "1" || value === 1) field.check();
        else field.uncheck();
      } else if (name.includes("RadioGroup")) field.select(String(value));
      else if (name.includes("Dropdown") || name.includes("OptionList")) field.select(String(value));
      filledFields.push(fieldName);
    } catch (error) {
      const message = error.message?.includes("No field")
        ? `Field '${fieldName}' not found in PDF. Check field name or use 'read_pdf_fields' to see available fields.`
        : `Field '${fieldName}': ${error.message}`;
      errors.push(objectErrors ? { field: fieldName, error: error.message } : message);
    }
  }
  return { filledFields, errors };
}

/*
 * Encrypted documents on the write path.
 *
 * All three phases — decrypt, mutate, re-protect — run here, inside the
 * isolated pdf-lib worker, and that placement is forced rather than chosen.
 * A mutation's output is written to the private stage directory on disk before
 * the parent ever sees it, so if protection were restored anywhere later than
 * this process the staged file would be plaintext on disk. Re-protection
 * therefore has to happen before `stageOutputs`, which puts QPDF in here; and
 * once QPDF is in here, decrypting here too keeps the plaintext from ever
 * crossing a process boundary.
 *
 * QPDF itself still runs on its own thread, exactly as it does for the
 * read-only tools: `server/qpdf-decrypt.js` starts one worker per phase and
 * destroys it. That is not merely inherited. A synchronous `callMain` on this
 * thread would block the RSS monitor's heartbeat, and the parent kills a child
 * whose monitor stalls for 250 ms — well under the ~1.6 s a legitimate
 * near-cap decrypt takes — so running QPDF inline here would turn ordinary
 * encrypted documents into spurious resource-limit kills.
 *
 * Where the plaintext is, at every moment:
 *
 *   - The ciphertext is read from disk into this process, as before.
 *   - It is transferred into a QPDF thread, decrypted inside the WebAssembly
 *     heap, and the plaintext is transferred back here. That thread is then
 *     destroyed.
 *   - pdf-lib parses and mutates the plaintext in this process's heap.
 *   - The mutated plaintext and the original ciphertext are transferred into a
 *     second QPDF thread, which restores the original protection and is then
 *     destroyed.
 *   - Only the re-protected ciphertext reaches `stageOutputs`, and so only
 *     ciphertext is ever written to disk.
 *
 * On every failure path — a refusal, a deadline, an RSS breach, SIGTERM,
 * SIGKILL — this process dies or unwinds with the plaintext still only in
 * memory, and the parent removes the operation directory regardless. There is
 * no path on which a decrypted document is staged, and no fallback that writes
 * plaintext when re-protection fails: an encrypted input yields an encrypted
 * output or no output at all.
 */
function createProtection(request) {
  return {
    operation: request.operation,
    password: request.password,
    forceXfa: request.force_xfa === true,
    guardXfa: XFA_GUARDED_MUTATION_OPERATIONS.has(request.operation),
    // Every source gets an entry, encrypted or not, because `merge_pdfs` has
    // to be able to tell "all protected the same way" from "some protected".
    sources: new Map(),
  };
}

/**
 * Loads one mutation source, decrypting it first if pdf-lib refuses it as
 * encrypted.
 *
 * pdf-lib is always tried first, so an unencrypted document pays nothing: no
 * QPDF module is instantiated and no extra parse happens. The encrypted branch
 * is entered only after pdf-lib has said the document is encrypted, which is
 * the same detection the read path uses.
 */
async function loadMutationSource(protection, bytes) {
  const xfa = { forceXfa: protection.forceXfa, guardXfa: protection.guardXfa };
  if (!ENCRYPTED_WRITE_OPERATIONS[protection.operation]) {
    // Not a mutation that may decrypt; behave exactly as before.
    return loadPdfForMutation(bytes, protection.password, xfa);
  }
  const known = protection.sources.get(bytes);
  if (known?.plaintext) return loadPdfForMutation(known.plaintext, null, xfa);
  try {
    const document = await loadPdfForMutation(bytes, protection.password, xfa);
    if (!protection.sources.has(bytes)) protection.sources.set(bytes, null);
    return document;
  } catch (error) {
    if (error?.message !== PDF_LIB_ENCRYPTED_MESSAGE) throw error;
  }
  const decrypted = await decryptPdfForWrite(bytes, protection.password, protection.operation);
  protection.sources.set(bytes, {
    reference: bytes,
    encryption: decrypted.encryption,
    plaintext: decrypted.plaintext,
    release: decrypted.release,
    // The rebuild-style operations bind a copied page's null-reference
    // provenance to a digest of the bytes its source was parsed from. For a
    // decrypted document those bytes are the plaintext, not the file on disk,
    // so the on-disk digest would not describe what pdf-lib actually read.
    // The binding to the file itself is not weakened by this: `reopenSource`
    // and the parent's `revalidateSources` both still verify the encrypted
    // source by device, inode, size and digest.
    parsedSha256: createHash("sha256").update(decrypted.plaintext).digest("hex"),
  });
  return loadPdfForMutation(decrypted.plaintext, null, xfa);
}

/**
 * The digest of the bytes a source was actually parsed from: the plaintext for
 * a decrypted document, and the file's own digest otherwise.
 */
function parsedSourceAuthority(protection, bytes, binding) {
  return protection.sources.get(bytes)?.parsedSha256 ?? binding.sha256;
}

/** The protection every output of this request must carry, or `null`. */
function requiredProtection(protection) {
  const opened = [...protection.sources.values()];
  const refusal = mergeProtectionRefusal(opened.map(entry => entry?.encryption ?? null));
  if (refusal) throw refusal;
  return opened.find(entry => entry !== null) ?? null;
}

/**
 * Restores the source's protection onto every output, before anything is
 * staged. Returns the bytes that will actually be written.
 */
async function protectOutputs(protection, outputs) {
  const required = requiredProtection(protection);
  if (!required) return outputs;
  const protectedOutputs = [];
  for (const bytes of outputs) {
    protectedOutputs.push(await reprotectPdfAfterWrite(
      bytes,
      required.reference,
      protection.password,
      required.encryption,
    ));
    // The mutated bytes are a decrypted copy of the document and are no longer
    // needed once they have been protected. Overwriting them here is the same
    // best-effort narrowing the decrypted source gets: it shortens the window
    // in which plaintext is readable in this process rather than closing it.
    if (ArrayBuffer.isView(bytes)) bytes.fill(0);
  }
  return protectedOutputs;
}

/** Overwrites every decrypted buffer this request produced. */
function releaseProtection(protection) {
  for (const entry of protection.sources.values()) {
    try { entry?.release?.(); } catch { /* Already released. */ }
  }
}

async function execute(request, protection) {
  const sourceBytes = await Promise.all(request.sources.map(reopenSource));
  const options = request.options;
  let outputs = [];
  let result = {};
  if (request.operation === "inspect_pdf_accessibility") {
    result = await inspectAccessibilitySource(sourceBytes[0], request.sources[0]);
  } else if (["fill_pdf", "fill_with_profile"].includes(request.operation)) {
    const document = await loadMutationSource(protection, sourceBytes[0]);
    const expectedPageCount = document.getPageCount();
    const expectedPageRotations = normalizedPageRotations(document);
    const fill = fillFields(document, options.field_data);
    outputs = [await savePdfDocumentSafely(document, {
      expectedPageCount,
      expectedPageRotations,
    })];
    result = { ...fill, form_info: formInfo(document) };
  } else if (request.operation === "bulk_fill_from_csv") {
    const rows = [];
    for (const record of options.records) {
      const document = await loadMutationSource(protection, sourceBytes[0]);
      const expectedPageCount = document.getPageCount();
      const expectedPageRotations = normalizedPageRotations(document);
      const fill = fillFields(document, record);
      outputs.push(await savePdfDocumentSafely(document, {
        expectedPageCount,
        expectedPageRotations,
      }));
      rows.push(fill);
    }
    result = { rows };
  } else if (request.operation === "merge_pdfs") {
    const target = await PDFDocument.create();
    const metadata = [];
    let pages = 0;
    const expectedPageRotations = [];
    for (const [sourceIndex, bytes] of sourceBytes.entries()) {
      const source = await loadMutationSource(protection, bytes);
      if (sourceBytes.length > 1) metadata.push(captureMergeDescriptiveMetadata(source));
      else {
        copyPdfDocumentMetadataForRebuiltOutput(
          target,
          source,
          parsedSourceAuthority(protection, bytes, request.sources[sourceIndex]),
        );
      }
      const indices = source.getPageIndices();
      expectedPageRotations.push(...normalizedPageRotations(source));
      await copyPdfPagesForRebuiltOutput(target, source, indices, {
        sourceAuthorityLabel: parsedSourceAuthority(protection, bytes, request.sources[sourceIndex]),
      });
      pages += indices.length;
    }
    if (pages < 1) throw new Error("merge_pdfs has no effective output pages.");
    const consensus = sourceBytes.length > 1
      ? applyMergeDescriptiveMetadataConsensus(target, metadata)
      : { preservedFields: [], omittedFields: [] };
    outputs = [await savePdfDocumentSafely(target, {
      expectedPageCount: pages,
      expectedPageRotations,
    })];
    result = { total_pages: pages, omitted_fields: consensus.omittedFields, form_info: formInfo(target) };
  } else if (request.operation === "split_pdf") {
    const source = await loadMutationSource(protection, sourceBytes[0]);
    const ranges = parsePageRanges(options.page_ranges, source.getPageCount());
    for (const [start, end] of ranges) {
      const target = await PDFDocument.create();
      copyPdfDocumentMetadataForRebuiltOutput(
        target,
        source,
        parsedSourceAuthority(protection, sourceBytes[0], request.sources[0]),
      );
      await copyPdfPagesForRebuiltOutput(
        target,
        source,
        Array.from({ length: end - start + 1 }, (_, index) => start - 1 + index),
        {
          sourceAuthorityLabel: parsedSourceAuthority(protection, sourceBytes[0], request.sources[0]),
        },
      );
      if (target.getPageCount() < 1) throw new Error("split_pdf produced an empty effective page range.");
      outputs.push(await savePdfDocumentSafely(target, {
        expectedPageCount: end - start + 1,
        expectedPageRotations: normalizedPageRotations(source)
          .slice(start - 1, end),
      }));
    }
    result = { ranges };
  } else if (request.operation === "rotate_pdf_pages") {
    const document = await loadMutationSource(protection, sourceBytes[0]);
    const all = document.getPages();
    const expectedPageCount = all.length;
    const expectedPageRotations = normalizedPageRotations(document);
    const targetIndices = !options.pages?.length
      ? all.map((_, index) => index)
      : options.pages.map(page => {
      if (!Number.isInteger(page) || page < 1 || page > all.length) {
        throw new Error(`Page ${page} is out of range (1-${all.length}).`);
      }
      return page - 1;
    });
    if (targetIndices.length < 1) throw new Error("rotate_pdf_pages has no effective target pages.");
    for (const index of targetIndices) {
      expectedPageRotations[index] =
        (expectedPageRotations[index] + options.degrees) % 360;
      all[index].setRotation(degrees(expectedPageRotations[index]));
    }
    outputs = [await savePdfDocumentSafely(document, {
      expectedPageCount,
      expectedPageRotations,
    })];
    result = { rotated_pages: targetIndices.length, form_info: formInfo(document) };
  } else if (["reorder_pdf_pages", "apply_page_plan"].includes(request.operation)) {
    const source = await loadMutationSource(protection, sourceBytes[0]);
    const order = options.page_order;
    if (!Array.isArray(order) || order.length < 1) throw new Error("page_order has no effective output pages.");
    const total = source.getPageCount();
    const seen = new Set();
    for (const page of order) {
      if (!Number.isInteger(page) || page < 1 || page > total || seen.has(page)) {
        throw new Error(`Invalid or duplicate page number in page_order: ${page}`);
      }
      seen.add(page);
    }
    if (request.operation === "reorder_pdf_pages" && order.length !== total) {
      throw new Error(`page_order must be a permutation of all pages (1-${total}). Got: [${order.join(", ")}]`);
    }
    const target = await PDFDocument.create();
    const sourceRotations = normalizedPageRotations(source);
    const expectedPageRotations = order.map(page => {
      const adjustment = options.rotations?.[String(page)] ?? 0;
      return (sourceRotations[page - 1] + adjustment) % 360;
    });
    copyPdfDocumentMetadataForRebuiltOutput(
      target,
      source,
      parsedSourceAuthority(protection, sourceBytes[0], request.sources[0]),
    );
    await copyPdfPagesForRebuiltOutput(target, source, order.map(page => page - 1), {
      sourceAuthorityLabel: parsedSourceAuthority(protection, sourceBytes[0], request.sources[0]),
      mutatePage(page, index) {
        const rotation = options.rotations?.[String(order[index])];
        if (rotation) page.setRotation(degrees((page.getRotation().angle + rotation) % 360));
      },
    });
    outputs = [await savePdfDocumentSafely(target, {
      expectedPageCount: order.length,
      expectedPageRotations,
    })];
    result = {
      total_pages: total,
      deleted_pages: total - order.length,
      rotated_pages: Object.keys(options.rotations ?? {}).filter(key => seen.has(Number(key))).length,
      form_info: formInfo(target),
    };
  } else {
    const document = await loadMutationSource(protection, sourceBytes[0]);
    const expectedPageCount = document.getPageCount();
    if (request.operation === "prepare_signing_packet" && expectedPageCount > MAX_SIGNING_PACKET_PAGES) {
      throw resourceError(
        "signing_packet_too_many_pages",
        `Signing packet preparation supports at most ${MAX_SIGNING_PACKET_PAGES} pages.`,
      );
    }
    const expectedPageRotations = normalizedPageRotations(document);
    const signingGeometry = request.operation === "prepare_signing_packet"
      ? signingPacketPageGeometry(document)
      : null;
    if (
      request.operation === "prepare_signing_packet"
      && options.require_provider_ready
      && options.signature_locations.some(zone => {
        const pageGeometry = signingGeometry[zone.page - 1];
        return !pageGeometry || !signingPacketZoneVisibleWithinCrop(zone, pageGeometry);
      })
    ) {
      throw new Error("Provider-ready signing zones must be fully visible inside the page CropBox.");
    }
    const sourceSignatures = request.operation === "prepare_signing_packet"
      ? detectExistingSignatures(document)
      : null;
    assertMayResave(document, options.allow_resign, request.operation === "apply_signature" ? "re-sign" : "modify");
    if (request.operation === "add_signature_field") {
      await drawSignatureFieldOnPage(document, options.placement);
      result = { form_info: formInfo(document) };
    } else if (request.operation === "apply_signature") {
      await stampSignatureOnPage(document, options.signature, {
        ...options.placement,
        drawAuditLine: options.draw_audit_line,
        auditText: options.audit_text,
      });
      const keywords = document.getKeywords() || "";
      document.setKeywords([keywords ? `${keywords}\n${options.audit_line}` : options.audit_line]);
      document.setModificationDate(new Date(options.modification_at));
      result = { form_info: formInfo(document) };
    } else if (request.operation === "prepare_signing_packet") {
      const fill = fillFields(document, options.field_values, { objectErrors: true });
      if (options.require_provider_ready && fill.errors.length > 0) {
        throw new Error(
          `Provider-ready signing packet preparation failed for ${fill.errors.length} requested form field(s).`,
        );
      }
      for (const placement of options.signature_locations) await drawSignatureFieldOnPage(document, placement);
      const filled = new Set(fill.filledFields);
      const fieldOutcomes = Object.keys(options.field_values).sort().map(fieldName => ({
        field_name: fieldName,
        status: filled.has(fieldName) ? "written" : "failed",
        reason_code: filled.has(fieldName) ? null : "field_write_failed",
      }));
      result = {
        filled_count: fill.filledFields.length,
        fill_errors: fill.errors,
        field_outcomes: fieldOutcomes,
        page_geometry: signingGeometry,
        source_signatures: sourceSignatures,
        form_info: formInfo(document),
      };
    } else if (request.operation === "apply_text") {
      await stampTextOnPage(document, { ...options.placement, text: options.text, fontStyle: options.font_style });
      const keywords = document.getKeywords() || "";
      document.setKeywords([keywords ? `${keywords}\n${options.audit_line}` : options.audit_line]);
      document.setModificationDate(new Date(options.modification_at));
      result = { form_info: formInfo(document) };
    }
    outputs = [await savePdfDocumentSafely(document, {
      expectedPageCount,
      expectedPageRotations,
    })];
  }
  if (outputs.length > MAX_OUTPUTS) throw resourceError("too_many_outputs", "Mutation produced too many outputs.");
  if (
    request.operation === "prepare_signing_packet"
    && outputs.some(output => output.length > PDF_MUTATION_MAX_FILE_BYTES)
  ) {
    throw resourceError(
      "prepared_signing_packet_too_large",
      "Prepared signing packet exceeds the 250 MiB provider-neutral receipt limit.",
    );
  }
  if (request.operation === "inspect_pdf_accessibility" && outputs.length !== 0) {
    throw new TypeError("Read-only inspection cannot stage output.");
  }
  if (request.operation !== "inspect_pdf_accessibility" && outputs.length < 1) {
    throw new TypeError("Mutation operations must stage at least one output.");
  }
  return { outputs, result };
}

async function stageOutputs(stageDirectory, outputBytes) {
  const before = await fs.lstat(stageDirectory, { bigint: true });
  if (
    !before.isDirectory()
    || before.isSymbolicLink()
    || (process.platform !== "win32" && Number(before.mode & 0o777n) !== 0o700)
    || (typeof process.getuid === "function" && before.uid !== BigInt(process.getuid()))
  ) {
    throw new Error("Private stage is unavailable.");
  }
  const manifest = [];
  let total = 0;
  for (const [index, value] of outputBytes.entries()) {
    const bytes = Buffer.from(value);
    total += bytes.length;
    if (bytes.length < 1 || bytes.length > MAX_STAGE_FILE_BYTES || total > MAX_STAGE_TOTAL_BYTES) {
      throw resourceError("staged_output_too_large", "Mutation output exceeds its isolated stage budget.");
    }
    const filename = `output-${String(index + 1).padStart(4, "0")}.pdf`;
    const outputPath = path.join(stageDirectory, filename);
    await fs.writeFile(outputPath, bytes, { flag: "wx", mode: 0o600 });
    const stats = await fs.lstat(outputPath, { bigint: true });
    if (!stats.isFile() || stats.isSymbolicLink() || stats.nlink !== 1n) throw new Error("Staged output is unsafe.");
    manifest.push({
      filename,
      size_bytes: bytes.length,
      sha256: createHash("sha256").update(bytes).digest("hex"),
      file_identity: { device: String(stats.dev), inode: String(stats.ino) },
    });
  }
  const after = await fs.lstat(stageDirectory, { bigint: true });
  if (
    String(before.dev) !== String(after.dev)
    || String(before.ino) !== String(after.ino)
    || Number(after.mode & 0o777n) !== Number(before.mode & 0o777n)
    || after.uid !== before.uid
  ) {
    throw new Error("Private stage changed during mutation.");
  }
  return manifest;
}

export async function executePdfLibOperationRequest(request) {
  validateRequest(request);
  const protection = createProtection(request);
  try {
    const { outputs, result } = await execute(request, protection);
    // Protection is restored before anything reaches the stage, so a decrypted
    // document is never written to disk even momentarily. A failure here
    // stages nothing at all rather than falling back to plaintext.
    const manifest = await stageOutputs(
      request.stage_directory,
      await protectOutputs(protection, outputs),
    );
    return {
      protocol_version: PROTOCOL_VERSION,
      operation: request.operation,
      status: "ok",
      manifest,
      result,
    };
  } finally {
    releaseProtection(protection);
  }
}

export async function executePdfLibMutationRequest(request) {
  if (request?.operation === "inspect_pdf_accessibility") {
    throw new TypeError("Read-only inspection is not a mutation request.");
  }
  return executePdfLibOperationRequest(request);
}

function errorResponse(error, request) {
  return {
    protocol_version: PROTOCOL_VERSION,
    operation: request?.operation ?? null,
    status: "error",
    error: {
      name: error?.name ?? "Error",
      code: error?.code ?? null,
      message: error?.message ?? String(error),
      reason: error?.reason ?? null,
    },
  };
}

function boundedControlBytes(response) {
  const bytes = Buffer.from(JSON.stringify(response), "utf8");
  if (bytes.length > MAX_CONTROL_BYTES) {
    throw resourceError(
      "control_output_too_large",
      "Mutation control output is too large.",
    );
  }
  return bytes;
}

async function threadMain() {
  const request = threadWorkerData?.request ?? null;
  let response;
  try {
    response = await executePdfLibOperationRequest(request);
    boundedControlBytes(response);
  } catch (error) {
    response = errorResponse(error, request);
    boundedControlBytes(response);
  }
  threadParentPort.postMessage({ kind: "response", response });
  threadParentPort.close();
}

async function main() {
  const monitor = startPdfLibRssMonitor();
  let request = null;
  let exitCode = 0;
  try {
    const chunks = [];
    let observed = 0;
    for await (const chunk of process.stdin) {
      observed += chunk.length;
      if (observed > MAX_REQUEST_BYTES) {
        throw resourceError("request_too_large", "Mutation control input is too large.");
      }
      chunks.push(Buffer.from(chunk));
    }
    request = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    const response = await executePdfLibOperationRequest(request);
    writeSync(1, boundedControlBytes(response));
  } catch (error) {
    writeSync(1, boundedControlBytes(errorResponse(error, request)));
    exitCode = 1;
  } finally {
    await monitor.stop();
    process.exitCode = exitCode;
  }
}

if (
  !isMainThread
  && threadWorkerData?.pdf_tools_worker === "pdf-lib"
  && threadParentPort
) {
  threadMain().catch(error => {
    throw error;
  });
} else if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  main().catch(error => {
    writeSync(2, Buffer.from(String(error?.stack ?? error).slice(0, 64 * 1024), "utf8"));
    closeSync(0);
    process.exitCode = 1;
  });
}
