// Shared helpers for PDF Tools — extracted for testability

import fs from "fs/promises";
import { constants as fsConstants } from "fs";
import path from "path";
import { homedir } from "os";
import { createHash, randomUUID } from "crypto";
import {
  EncryptedPDFError,
  PDFArray,
  PDFDict,
  PDFDocument,
  PDFName,
  PDFObjectCopier,
  PDFPage,
  PDFRef,
  StandardFonts,
  rgb,
  degrees as pdfDegrees,
} from "pdf-lib";

const PDF_LIB_ENCRYPTED_ERROR_MESSAGE = new EncryptedPDFError().message;

// pdf-lib 1.17.1 ships no decryption at all: PDFDocument.load has no password
// option, and { ignoreEncryption: true } yields an unusable document. Any
// operation that reaches pdf-lib therefore fails on an encrypted PDF no matter
// what password the caller supplies, so the error must say that instead of
// asking for the password again. PDF.js does decrypt, so the read tools that
// route only through PDF.js are named as the working alternative.
export const PDF_LIB_ENCRYPTED_MESSAGE =
  "This PDF is encrypted and this operation cannot decrypt it: it reads the file with pdf-lib, "
  + "which has no decryption support, so supplying a password here will not help. "
  + "Decrypt the file first (for example with qpdf) and retry. "
  + "To read an encrypted PDF as it is, use read_pdf_layout, convert_pdf_to_markdown, "
  + "or get_pdf_info, which accept a password and decrypt with PDF.js.";

// Parameter text for tools that decrypt with PDF.js for one part of their work
// but still load page geometry through pdf-lib, which stops on encryption.
export const PDF_LIB_GEOMETRY_PASSWORD_DESCRIPTION =
  "Password for encrypted PDFs. PDF.js uses it, but this operation also loads page geometry with "
  + "pdf-lib, which cannot decrypt PDFs, so an encrypted document still fails with the correct password.";

const PDF_FIELD_VALIDATION_SCHEMA_VERSION = "1.0";
const UNSUPPORTED_DIRECTORY_FSYNC_ERRORS = new Set([
  "EINVAL",
  "ENOTSUP",
  "EOPNOTSUPP",
  "EISDIR",
]);

const PRODUCER = PDFName.of("Producer");
const MOD_DATE = PDFName.of("ModDate");
const MERGE_DESCRIPTIVE_METADATA_FIELDS = [
  {
    name: "title",
    read: document => document.getTitle(),
    write: (document, value) => document.setTitle(value),
  },
  {
    name: "author",
    read: document => document.getAuthor(),
    write: (document, value) => document.setAuthor(value),
  },
  {
    name: "subject",
    read: document => document.getSubject(),
    write: (document, value) => document.setSubject(value),
  },
  {
    name: "keywords",
    read: document => document.getKeywords(),
    write: (document, value) => document.setKeywords([value]),
  },
];
const ACROFORM_DEFAULT_KEYS = ["DA", "DR", "Q", "NeedAppearances", "SigFlags"]
  .map(PDFName.of);

export function isPdfLibEncryptedError(error) {
  return error instanceof EncryptedPDFError ||
    error?.message === PDF_LIB_ENCRYPTED_ERROR_MESSAGE;
}

function indirectRef(context, object) {
  if (object instanceof PDFRef) return object;
  const resolved = context.lookup(object);
  return context.getObjectRef(resolved) ?? context.register(resolved);
}

function recordCopiedSpecNullTargets(
  copier,
  sourceDoc,
  targetDoc,
  specNullTargetProvenance,
  sourceAuthorityLabel,
) {
  if (!(specNullTargetProvenance instanceof Map)) return;
  for (const [sourceObject, targetObject] of copier.traversedObjects) {
    if (!(sourceObject instanceof PDFRef) || !(targetObject instanceof PDFRef)
        || sourceDoc.context.lookup(sourceObject) !== undefined) {
      continue;
    }
    if (targetDoc.context.lookup(targetObject) !== undefined) {
      throw new Error("Copied null-reference target unexpectedly resolves.");
    }
    const target = targetObject.toString();
    const authority = {
      source_authority: sourceAuthorityLabel,
      source_ref: sourceObject.toString(),
    };
    const prior = specNullTargetProvenance.get(target);
    if (prior && JSON.stringify(prior) !== JSON.stringify(authority)) {
      throw new Error(`Copied null-reference provenance collides at ${target}.`);
    }
    specNullTargetProvenance.set(target, authority);
  }
}

function repairCopiedFormFields(
  targetDoc,
  copiedPages,
  sourceDoc,
  specNullTargetProvenance,
  sourceAuthorityLabel,
) {
  const fieldNodes = new Map();
  const fieldChildren = new Map();
  const rootRefs = new Map();

  function noteFieldChild(fieldRef, fieldDict, childRef) {
    const key = fieldRef.toString();
    fieldNodes.set(key, { ref: fieldRef, dict: fieldDict });
    if (!fieldChildren.has(key)) fieldChildren.set(key, new Map());
    fieldChildren.get(key).set(childRef.toString(), childRef);
  }

  for (const page of copiedPages) {
    const annotations = page.node.lookupMaybe(PDFName.of("Annots"), PDFArray);
    if (!annotations) continue;
    for (let index = 0; index < annotations.size(); index += 1) {
      const rawWidget = annotations.get(index);
      const widget = targetDoc.context.lookupMaybe(rawWidget, PDFDict);
      if (!widget || widget.get(PDFName.of("Subtype")) !== PDFName.of("Widget")) continue;
      const widgetRef = indirectRef(targetDoc.context, rawWidget);
      widget.set(PDFName.of("P"), page.ref);

      let childRef = widgetRef;
      let parentRaw = widget.get(PDFName.of("Parent"));
      const visited = new Set();
      if (!parentRaw) {
        if (widget.has(PDFName.of("FT")) || widget.has(PDFName.of("T"))) {
          rootRefs.set(widgetRef.toString(), widgetRef);
        }
        continue;
      }
      while (parentRaw) {
        const parent = targetDoc.context.lookupMaybe(parentRaw, PDFDict);
        if (!parent) break;
        const parentRef = indirectRef(targetDoc.context, parentRaw);
        const parentKey = parentRef.toString();
        if (visited.has(parentKey)) throw new Error("Copied AcroForm field hierarchy contains a cycle.");
        visited.add(parentKey);
        noteFieldChild(parentRef, parent, childRef);
        childRef = parentRef;
        parentRaw = parent.get(PDFName.of("Parent"));
      }
      rootRefs.set(childRef.toString(), childRef);
    }
  }

  if (rootRefs.size === 0) return;
  for (const [key, node] of fieldNodes) {
    node.dict.set(PDFName.of("Kids"), targetDoc.context.obj([...fieldChildren.get(key).values()]));
  }

  const targetAcroForm = targetDoc.catalog.getOrCreateAcroForm();
  const existing = new Set(targetAcroForm.Fields().asArray().map(ref => ref.toString()));
  for (const rootRef of rootRefs.values()) {
    if (!existing.has(rootRef.toString())) {
      targetAcroForm.addField(rootRef);
      existing.add(rootRef.toString());
    }
  }

  const sourceAcroForm = sourceDoc.catalog.getAcroForm();
  if (!sourceAcroForm) return;
  const copier = PDFObjectCopier.for(sourceDoc.context, targetDoc.context);
  for (const key of ACROFORM_DEFAULT_KEYS) {
    const value = sourceAcroForm.dict.get(key);
    if (value && !targetAcroForm.dict.has(key)) targetAcroForm.dict.set(key, copier.copy(value));
  }
  recordCopiedSpecNullTargets(
    copier,
    sourceDoc,
    targetDoc,
    specNullTargetProvenance,
    sourceAuthorityLabel,
  );
}

/**
 * Copy pages while rebuilding the AcroForm roots that pdf-lib's copyPages
 * intentionally leaves outside the destination catalog. Widget page pointers
 * and field Kids arrays are rebound only to pages actually present in the
 * destination document.
 */
export async function copyPdfPagesPreservingForms(targetDoc, sourceDoc, pageIndices, {
  mutatePage,
  sourceAuthorityLabel = null,
  specNullTargetProvenance = null,
  registerRebuiltSpecNullAuthority = null,
} = {}) {
  await sourceDoc.flush();
  const copier = PDFObjectCopier.for(sourceDoc.context, targetDoc.context);
  const sourcePages = sourceDoc.getPages();
  const copiedPages = pageIndices.map(index => {
    const node = copier.copy(sourcePages[index].node);
    const ref = targetDoc.context.register(node);
    return PDFPage.of(node, ref, targetDoc);
  });
  for (const page of copiedPages) targetDoc.addPage(page);
  recordCopiedSpecNullTargets(
    copier,
    sourceDoc,
    targetDoc,
    specNullTargetProvenance,
    sourceAuthorityLabel,
  );
  repairCopiedFormFields(
    targetDoc,
    copiedPages,
    sourceDoc,
    specNullTargetProvenance,
    sourceAuthorityLabel,
  );
  registerRebuiltSpecNullAuthority?.();
  for (const [index, page] of copiedPages.entries()) {
    await mutatePage?.(page, index);
  }
  return copiedPages;
}

/** Preserve source Info entries except producer and modification timestamp. */
export function copyPdfDocumentMetadata(targetDoc, sourceDoc, {
  sourceAuthorityLabel = null,
  specNullTargetProvenance = null,
  registerRebuiltSpecNullAuthority = null,
} = {}) {
  const sourceInfo = sourceDoc.context.lookupMaybe(sourceDoc.context.trailerInfo.Info, PDFDict);
  const targetInfo = targetDoc.context.lookupMaybe(targetDoc.context.trailerInfo.Info, PDFDict);
  if (!sourceInfo || !targetInfo) {
    registerRebuiltSpecNullAuthority?.();
    return;
  }
  const copier = PDFObjectCopier.for(sourceDoc.context, targetDoc.context);
  const sourceKeys = new Set(sourceInfo.keys().map(key => key.toString()));
  for (const key of targetInfo.keys()) {
    if (key !== PRODUCER && key !== MOD_DATE && !sourceKeys.has(key.toString())) targetInfo.delete(key);
  }
  for (const key of sourceInfo.keys()) {
    if (key === PRODUCER || key === MOD_DATE) continue;
    targetInfo.set(key, copier.copy(sourceInfo.get(key)));
  }
  recordCopiedSpecNullTargets(
    copier,
    sourceDoc,
    targetDoc,
    specNullTargetProvenance,
    sourceAuthorityLabel,
  );
  registerRebuiltSpecNullAuthority?.();
}

/**
 * Capture only document-level descriptive claims that may truthfully survive a
 * multi-input merge. Invalid Info values are kept distinct from absent values:
 * malformed source metadata must be omitted rather than accidentally treated
 * as unanimous absence.
 */
export function captureMergeDescriptiveMetadata(document) {
  return Object.fromEntries(MERGE_DESCRIPTIVE_METADATA_FIELDS.map(field => {
    try {
      const value = field.read(document);
      return [
        field.name,
        value === undefined
          ? { state: "absent" }
          : { state: "value", value },
      ];
    } catch {
      return [field.name, { state: "invalid" }];
    }
  }));
}

/**
 * Apply field-wise consensus metadata to a newly-created multi-input document.
 *
 * A field is preserved only when every source positively asserts the exact
 * same value. A present value versus absence, an invalid value, or any value
 * disagreement means the merged artifact cannot truthfully make that claim.
 */
export function applyMergeDescriptiveMetadataConsensus(targetDoc, sourceMetadata) {
  if (!Array.isArray(sourceMetadata) || sourceMetadata.length < 2) {
    throw new Error("Multi-input metadata consensus requires at least two sources.");
  }

  const preservedFields = [];
  const omittedFields = [];
  for (const field of MERGE_DESCRIPTIVE_METADATA_FIELDS) {
    const observations = sourceMetadata.map(metadata =>
      metadata?.[field.name] ?? { state: "invalid" });
    const first = observations[0];
    const unanimousValue = first.state === "value" &&
      observations.every(observation =>
        observation.state === "value" && observation.value === first.value);

    if (unanimousValue) {
      field.write(targetDoc, first.value);
      preservedFields.push(field.name);
      continue;
    }
    if (observations.some(observation => observation.state !== "absent")) {
      omittedFields.push(field.name);
    }
  }

  return { preservedFields, omittedFields };
}

function classifyPdfField(field) {
  const type = field?.constructor?.name || "UnknownField";
  if (type.includes("TextField")) return { type, kind: "text" };
  if (type.includes("CheckBox")) return { type, kind: "checkbox" };
  if (type.includes("RadioGroup")) return { type, kind: "radio" };
  if (type.includes("Dropdown")) return { type, kind: "dropdown" };
  if (type.includes("OptionList")) return { type, kind: "option_list" };
  if (type.includes("Signature")) return { type, kind: "signature" };
  if (type.includes("Button")) return { type, kind: "button" };
  return { type, kind: "unknown" };
}

function hasObservedSelection(value) {
  if (Array.isArray(value)) {
    return value.some(item => String(item ?? "").trim().length > 0);
  }
  return String(value ?? "").trim().length > 0;
}

function hasRequiredNameHint(name) {
  return /(^|[^a-z])(required|must)([^a-z]|$)/i.test(name) || name.includes("*");
}

function inspectPdfField(field, index) {
  let name = `<field-${index + 1}>`;
  let nameReadError = false;
  try {
    name = String(field.getName());
  } catch {
    nameReadError = true;
  }

  const { type, kind } = classifyPdfField(field);
  let required = null;
  let requiredReadError = false;
  try {
    if (typeof field?.isRequired !== "function") {
      throw new Error("Required flag reader unavailable");
    }
    required = field.isRequired();
    if (typeof required !== "boolean") {
      throw new Error("Required flag reader returned a non-boolean value");
    }
  } catch {
    required = null;
    requiredReadError = true;
  }

  let valueStatus = "unknown";
  let readError = nameReadError;
  try {
    if (kind === "text") {
      valueStatus = String(field.getText() ?? "").trim() ? "observed" : "empty";
    } else if (kind === "checkbox") {
      valueStatus = field.isChecked() ? "observed" : "unchecked";
    } else if (kind === "radio" || kind === "dropdown" || kind === "option_list") {
      valueStatus = hasObservedSelection(field.getSelected()) ? "observed" : "empty";
    } else if (kind === "button") {
      valueStatus = "not_applicable";
    } else {
      // pdf-lib deliberately does not expose a signature value reader, and an
      // unknown field type has no trustworthy generic value API. Do not guess.
      valueStatus = "unknown";
    }
  } catch {
    valueStatus = "read_error";
    readError = true;
  }

  if (nameReadError) {
    valueStatus = "read_error";
  }

  let requiredStatus = "not_required";
  if (required === null) {
    requiredStatus = "unknown";
  } else if (required) {
    if (valueStatus === "observed") requiredStatus = "satisfied";
    else if (valueStatus === "empty" || valueStatus === "unchecked") requiredStatus = "missing";
    else requiredStatus = "unknown";
  }

  let errorCode = null;
  if (readError) errorCode = "FIELD_READ_FAILED";
  else if (requiredReadError) errorCode = "REQUIRED_FLAG_READ_FAILED";
  else if (valueStatus === "unknown") errorCode = "VALUE_STATUS_UNAVAILABLE";

  return {
    name,
    type,
    kind,
    required,
    required_name_hint: hasRequiredNameHint(name),
    value_status: valueStatus,
    required_status: requiredStatus,
    error_code: errorCode,
  };
}

/**
 * Inspect AcroForm fields without treating field-name conventions as PDF
 * required flags. The returned object is intentionally value-free: it reports
 * whether a value was observed, not the potentially sensitive value itself.
 */
export function validatePdfFormFields(fields, { pdfPath = null, fileName = null } = {}) {
  if (!Array.isArray(fields)) throw new Error("fields must be an array.");

  const fieldResults = fields.map(inspectPdfField);
  const count = status => fieldResults.filter(field => field.value_status === status).length;
  const observedCount = count("observed");
  const emptyCount = count("empty");
  const uncheckedCount = count("unchecked");
  const unknownCount = count("unknown");
  const readErrorCount = count("read_error");
  const notApplicableCount = count("not_applicable");
  const requiredFields = fieldResults.filter(field => field.required === true);
  const missingRequiredFields = fieldResults.filter(field => field.required_status === "missing");
  const indeterminateRequiredFields = fieldResults.filter(
    field => field.required === true && field.required_status === "unknown",
  );
  const requirednessUnknownFields = fieldResults.filter(field => field.required === null);
  const heuristicRequiredCandidates = fieldResults.filter(field => field.required_name_hint);
  const validationIndeterminate =
    unknownCount > 0 ||
    readErrorCount > 0 ||
    requirednessUnknownFields.length > 0 ||
    indeterminateRequiredFields.length > 0;

  let requiredFieldsComplete;
  if (fields.length === 0 || requiredFields.length === 0) requiredFieldsComplete = null;
  else if (missingRequiredFields.length > 0) requiredFieldsComplete = false;
  else if (indeterminateRequiredFields.length > 0 || requirednessUnknownFields.length > 0) {
    requiredFieldsComplete = null;
  } else requiredFieldsComplete = true;

  let allValueFieldsFilled;
  const valueFieldCount = fields.length - notApplicableCount;
  if (valueFieldCount === 0 || unknownCount > 0 || readErrorCount > 0) {
    allValueFieldsFilled = null;
  } else {
    allValueFieldsFilled = emptyCount === 0 && uncheckedCount === 0;
  }

  const requiredFieldValidationStatus = fields.length === 0
    ? "no_fields"
    : requiredFields.length === 0 && requirednessUnknownFields.length > 0
      ? "indeterminate"
      : requiredFields.length === 0
        ? "no_required_flags"
        : missingRequiredFields.length > 0
          ? "incomplete"
          : indeterminateRequiredFields.length > 0 || requirednessUnknownFields.length > 0
            ? "indeterminate"
            : "complete";
  const validationStatus = fields.length === 0
    ? "no_fields"
    : valueFieldCount === 0
      ? "no_value_fields"
      : missingRequiredFields.length > 0
        ? "incomplete"
        : validationIndeterminate
          ? "indeterminate"
          : emptyCount > 0 || uncheckedCount > 0
            ? "partial"
            : "complete";
  const canClaimRequiredFieldsComplete =
    fields.length > 0 &&
    requiredFields.length > 0 &&
    !validationIndeterminate &&
    requiredFieldsComplete === true;

  const limitations = [
    "This result checks AcroForm field presence only; it does not prove legal validity, business-rule validity, signature validity, or readiness to submit.",
    "Only the PDF Required flag is authoritative for required-field counts. Name-based hints are advisory and never affect completeness.",
  ];
  if (fields.length === 0) {
    limitations.push("No AcroForm fields were found, so no fill-and-validate completion claim is available.");
  }
  if (requiredFields.length === 0 && requirednessUnknownFields.length === 0 && fields.length > 0) {
    limitations.push("The PDF marks no fields Required. Empty values remain observable, but required-field completeness cannot establish form readiness.");
  }
  if (validationIndeterminate) {
    limitations.push("At least one field value or required flag could not be determined; retry or inspect the named fields manually.");
  }

  const errorCodes = [...new Set(fieldResults.map(field => field.error_code).filter(Boolean))];
  const warningCodes = [];
  if (fields.length === 0) warningCodes.push("NO_FORM_FIELDS");
  if (fields.length > 0 && valueFieldCount === 0) warningCodes.push("NO_VALUE_FIELDS");
  if (fields.length > 0 && requiredFields.length === 0 && requirednessUnknownFields.length === 0) {
    warningCodes.push("NO_REQUIRED_FLAGS");
  }
  if (emptyCount > 0 || uncheckedCount > 0) warningCodes.push("PARTIAL_FIELD_COVERAGE");
  if (heuristicRequiredCandidates.length > 0) warningCodes.push("ADVISORY_REQUIRED_NAME_HINTS");

  return {
    schema_version: PDF_FIELD_VALIDATION_SCHEMA_VERSION,
    pdf_path: pdfPath,
    file_name: fileName,
    validation_status: validationStatus,
    required_field_validation_status: requiredFieldValidationStatus,
    validation_conclusive: fields.length > 0 && !validationIndeterminate,
    has_form_fields: fields.length > 0,
    required_fields_complete: requiredFieldsComplete,
    all_value_fields_filled: allValueFieldsFilled,
    can_claim_required_fields_complete: canClaimRequiredFieldsComplete,
    can_claim_form_ready: false,
    total_field_count: fields.length,
    value_field_count: valueFieldCount,
    observed_count: observedCount,
    filled_count: observedCount,
    empty_count: emptyCount,
    unchecked_count: uncheckedCount,
    unknown_count: unknownCount,
    read_error_count: readErrorCount,
    not_applicable_count: notApplicableCount,
    required_field_count: requiredFields.length,
    missing_required_count: missingRequiredFields.length,
    indeterminate_required_count: indeterminateRequiredFields.length,
    requiredness_unknown_count: requirednessUnknownFields.length,
    fields: fieldResults,
    observed_fields: fieldResults.filter(field => field.value_status === "observed").map(field => field.name),
    empty_fields: fieldResults.filter(field => field.value_status === "empty").map(field => field.name),
    unchecked_fields: fieldResults.filter(field => field.value_status === "unchecked").map(field => field.name),
    unknown_fields: fieldResults.filter(field => field.value_status === "unknown").map(field => field.name),
    read_error_fields: fieldResults.filter(field => field.value_status === "read_error").map(field => field.name),
    missing_required_fields: missingRequiredFields.map(field => field.name),
    indeterminate_required_fields: indeterminateRequiredFields.map(field => field.name),
    requiredness_unknown_fields: requirednessUnknownFields.map(field => field.name),
    heuristic_required_candidates: heuristicRequiredCandidates.map(field => field.name),
    error_codes: errorCodes,
    warning_codes: warningCodes,
    retry_guidance: validationIndeterminate
      ? "Inspect unknown/read-error fields manually or retry with a repaired PDF before making a completeness claim."
      : null,
    limitations,
  };
}

export function failedPdfFormValidation({ pdfPath = null, fileName = null } = {}) {
  return {
    schema_version: PDF_FIELD_VALIDATION_SCHEMA_VERSION,
    pdf_path: pdfPath,
    file_name: fileName,
    validation_status: "failed",
    required_field_validation_status: "failed",
    validation_conclusive: false,
    has_form_fields: null,
    required_fields_complete: null,
    all_value_fields_filled: null,
    can_claim_required_fields_complete: false,
    can_claim_form_ready: false,
    total_field_count: null,
    value_field_count: null,
    observed_count: null,
    filled_count: null,
    empty_count: null,
    unchecked_count: null,
    unknown_count: null,
    read_error_count: null,
    not_applicable_count: null,
    required_field_count: null,
    missing_required_count: null,
    indeterminate_required_count: null,
    requiredness_unknown_count: null,
    fields: [],
    observed_fields: [],
    empty_fields: [],
    unchecked_fields: [],
    unknown_fields: [],
    read_error_fields: [],
    missing_required_fields: [],
    indeterminate_required_fields: [],
    requiredness_unknown_fields: [],
    heuristic_required_candidates: [],
    warning_codes: [],
    retry_guidance: "Verify the local path and password, repair the PDF if necessary, then retry validation.",
    limitations: [
      "The PDF or its form fields could not be read. Do not interpret this result as an empty or complete form.",
      "This result does not prove legal validity, business-rule validity, signature validity, or readiness to submit.",
    ],
    error_codes: ["PDF_VALIDATION_FAILED"],
  };
}

// MCPB expands a `multiple: true` user configuration placeholder into
// separate command arguments. Keep the marker explicit so ordinary MCP hosts
// can continue using environment variables without treating unrelated CLI
// arguments as filesystem permissions.
// A host may hand us a path that still contains a placeholder. Two kinds arrive
// and they are not the same thing.
//
// `${HOME}` and `${USERPROFILE}` are *resolvable*: they name the running user's
// home directory, which this process already knows. Claude Desktop expands them
// in manifest-authored env strings but not inside `user_config` default values,
// so a user who never opened the settings sends us a literal `${HOME}/Documents`
// on every platform. Measured on Windows Claude Desktop 1.26832.0, and on macOS
// 1.26832.0 by replaying the host's own substitution against a real install —
// the substitution code is shared, so this is not a per-platform accident.
// test/host-mcp-config-substitution.test.js binds the manifest shape that makes
// it true.
//
// `${user_config.*}` is *unresolvable*: it means the host did not substitute the
// user's configuration and we genuinely do not know what was intended. That must
// still be rejected, because guessing a boundary the user never chose is the
// fail-open this replaced.
export function expandHostPlaceholders(value) {
  if (typeof value !== "string" || !value.includes("${")) return value;
  return value
    .replaceAll("${HOME}", homedir())
    .replaceAll("${USERPROFILE}", homedir());
}

export function parseAllowedDirectoryArgs(argv = []) {
  const markerIndex = argv.indexOf("--allowed-directories");
  if (markerIndex === -1) return null;

  const values = [];
  for (const argument of argv.slice(markerIndex + 1)) {
    if (typeof argument !== "string") continue;
    // Stop at the next option so an unrelated flag can never be mistaken for a
    // filesystem permission.
    if (argument.startsWith("--")) break;
    const trimmed = expandHostPlaceholders(argument.trim());
    if (!trimmed || trimmed.includes("${")) continue;
    values.push(trimmed);
  }
  return values;
}

// Validate a signature name to prevent path traversal or weird filenames.
// Mirrors validateProfileName's contract.
export function validateSignatureName(name) {
  if (!name || typeof name !== "string") throw new Error("Signature name is required.");
  if (!/^[\w\-. ]+$/.test(name)) {
    throw new Error("Signature name may only contain letters, numbers, hyphens, underscores, spaces, and dots.");
  }
  return name.trim();
}

// Parse a data URL ("data:image/png;base64,...") into { mime, bytes }.
export function parseImageDataUrl(dataUrl) {
  if (!dataUrl || typeof dataUrl !== "string") {
    throw new Error("image_data_url must be a string.");
  }
  const match = dataUrl.match(/^data:([^;,]+);base64,([A-Za-z0-9+/=\s]+)$/);
  if (!match) {
    throw new Error("image_data_url must be a base64 data URL (e.g. 'data:image/png;base64,...').");
  }
  const mime = match[1].toLowerCase();
  if (mime !== "image/png" && mime !== "image/jpeg" && mime !== "image/jpg") {
    throw new Error(`Unsupported image type: ${mime}. Use image/png or image/jpeg.`);
  }
  const bytes = Buffer.from(match[2].replace(/\s+/g, ""), "base64");
  if (bytes.length === 0) throw new Error("image_data_url is empty.");
  return { mime, bytes };
}

// Validate a user-supplied signing intent + confirmation timestamp.
// Returns the parsed confirmation Date on success. Throws on anything suspicious.
// The purpose is to make the agent-vs-human distinction visible in logs and metadata,
// not to be cryptographically unforgeable — that's Tier 2 (Lumin's job).
export function validateSigningIntent({ user_intent_statement, user_confirmed_at }, { now = Date.now() } = {}) {
  if (!user_intent_statement || typeof user_intent_statement !== "string") {
    throw new Error(
      "apply_signature requires 'user_intent_statement' — a short sentence " +
      "from the USER describing what they are signing (e.g. \"I, Mat Silverstein, sign this W-9 on 2026-04-16\"). " +
      "Agents must elicit this from the user before calling this tool; do not invent one."
    );
  }
  const statement = user_intent_statement.trim();
  if (statement.length < 8) {
    throw new Error("user_intent_statement is too short. Capture the user's actual statement of intent.");
  }
  if (statement.length > 500) {
    throw new Error("user_intent_statement is too long (>500 chars). Use a single sentence.");
  }

  if (!user_confirmed_at || typeof user_confirmed_at !== "string") {
    throw new Error(
      "apply_signature requires 'user_confirmed_at' — an ISO-8601 timestamp of when " +
      "the user confirmed signing. Agents must obtain this from the user, not fabricate it."
    );
  }
  const confirmedAt = new Date(user_confirmed_at);
  if (Number.isNaN(confirmedAt.getTime())) {
    throw new Error(`user_confirmed_at is not a valid ISO-8601 timestamp: "${user_confirmed_at}".`);
  }
  const driftMs = now - confirmedAt.getTime();
  if (driftMs < -5 * 60 * 1000) {
    throw new Error(`user_confirmed_at is more than 5 minutes in the future. Check the timestamp.`);
  }
  if (driftMs > 24 * 60 * 60 * 1000) {
    throw new Error(
      `user_confirmed_at is more than 24 hours old (${(driftMs / 3600000).toFixed(1)}h). ` +
      `Re-confirm with the user before signing.`
    );
  }
  return { statement, confirmedAt };
}

// CANONICAL PAGE-BOX COORDINATE CONVENTION
//
// Every coordinate crossing this module's public boundary — tool inputs, detected
// zones, extracted text bounds, viewer overlays, fixtures — is expressed as
// TOP-LEFT origin, in points, RELATIVE TO THE PAGE'S MEDIABOX. The MediaBox is
// the canonical reference box (not the CropBox), matching `page.getSize()` and
// the accepted rotated/cropped golden fixture.
//
// PDF user space is bottom-left origin AND is offset by the MediaBox origin,
// which is nonzero for a page whose MediaBox is e.g. [40 60 652 852]. Raw
// pdf-lib drawing calls and raw pdf.js text transforms both live in that
// absolute user space. Converting only the y-axis flip while ignoring the
// origin silently displaces content by (-originX, -originY): on a nonzero-origin
// page a signature requested near the margin is drawn outside the visible area.
//
// Normalization therefore happens at exactly two boundaries, and nowhere else:
//   - INPUT  (stamping): box-relative top-left -> user space, via toUserSpace()
//   - OUTPUT (detection/extraction): user space -> box-relative top-left
//
// Both directions must move together. Fixing only one side would appear correct
// on a detect-then-stamp round trip (the two errors cancel) while every
// externally supplied or externally consumed coordinate stayed wrong.
export function getPageBoxGeometry(pdfPage) {
  let box = null;
  try {
    box = pdfPage.getMediaBox();
  } catch {
    box = null;
  }
  const size = pdfPage.getSize();
  const originX = Number.isFinite(box?.x) ? box.x : 0;
  const originY = Number.isFinite(box?.y) ? box.y : 0;
  const width = Number.isFinite(box?.width) ? box.width : size.width;
  const height = Number.isFinite(box?.height) ? box.height : size.height;
  return { originX, originY, width, height };
}

// Convert a box-relative top-left point to absolute PDF user space.
// `yFromBottom` is the already-flipped distance from the box's bottom edge.
function toUserSpace({ originX, originY }, x, yFromBottom) {
  return { x: originX + x, y: originY + yFromBottom };
}

// Stamp a saved signature onto a PDF page at the given top-left coordinates.
// Coordinates are in PDF points (72pt = 1 inch), using TOP-LEFT origin relative
// to the page MediaBox:
//   x: distance from the MediaBox left edge
//   y: distance from the MediaBox TOP edge
// (converted to absolute bottom-left user space internally; see the convention note above)
// Mutates pdfDoc in place.
export async function stampSignatureOnPage(pdfDoc, signature, {
  page,          // 1-indexed page number
  x, y,          // top-left origin, points
  width, height, // box dimensions, points
  drawAuditLine = false,
  auditText = "",
}) {
  const pages = pdfDoc.getPages();
  if (page < 1 || page > pages.length) {
    throw new Error(`Page ${page} is out of range (1-${pages.length}).`);
  }
  const pdfPage = pages[page - 1];
  const boxGeometry = getPageBoxGeometry(pdfPage);
  const { width: pageW, height: pageH } = boxGeometry;

  if (!Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(width) || !Number.isFinite(height)) {
    throw new Error("x, y, width, height must all be finite numbers.");
  }
  if (width <= 0 || height <= 0) {
    throw new Error(`width and height must be positive (got ${width} x ${height}).`);
  }
  if (x < 0 || y < 0 || x + width > pageW || y + height > pageH) {
    throw new Error(
      `Signature box (${x}, ${y}, ${width}x${height}) falls outside page bounds ` +
      `(page ${page} is ${pageW.toFixed(0)}x${pageH.toFixed(0)} pts). ` +
      `Use top-left origin coordinates in points.`
    );
  }

  // Flip top-left y to a bottom-relative offset, then shift into absolute user
  // space so a nonzero MediaBox origin is honored.
  const pdfY = pageH - y - height;
  const boxOrigin = toUserSpace(boxGeometry, x, pdfY);
  const userX = boxOrigin.x;
  const userY = boxOrigin.y;

  if (signature.style === "image") {
    const imageBytes = Buffer.from(signature.image_data_b64, "base64");
    const image = signature.image_mime === "image/jpeg" || signature.image_mime === "image/jpg"
      ? await pdfDoc.embedJpg(imageBytes)
      : await pdfDoc.embedPng(imageBytes);
    // Preserve aspect ratio within the box (contain)
    const imgAspect = image.width / image.height;
    const boxAspect = width / height;
    let drawW, drawH, drawX, drawY;
    if (imgAspect > boxAspect) {
      drawW = width;
      drawH = width / imgAspect;
      drawX = userX;
      drawY = userY + (height - drawH) / 2;
    } else {
      drawH = height;
      drawW = height * imgAspect;
      drawX = userX + (width - drawW) / 2;
      drawY = userY;
    }
    pdfPage.drawImage(image, { x: drawX, y: drawY, width: drawW, height: drawH });
  } else if (signature.style === "typed") {
    const font = await pdfDoc.embedFont(StandardFonts.HelveticaOblique);
    const text = signature.display_name;
    // Fit text to box: find largest font size where text width fits 90% of box width
    let fontSize = height * 0.7;
    const maxWidth = width * 0.95;
    let textWidth = font.widthOfTextAtSize(text, fontSize);
    if (textWidth > maxWidth) {
      fontSize = fontSize * (maxWidth / textWidth);
      textWidth = font.widthOfTextAtSize(text, fontSize);
    }
    // Center text vertically in the box
    const textHeight = font.heightAtSize(fontSize);
    const textX = userX + (width - textWidth) / 2;
    const textY = userY + (height - textHeight) / 2 + font.heightAtSize(fontSize) * 0.2;
    pdfPage.drawText(text, {
      x: textX,
      y: textY,
      size: fontSize,
      font,
      color: rgb(0.05, 0.05, 0.25), // dark navy
    });
  } else {
    throw new Error(`Unknown signature style: "${signature.style}". Must be 'typed' or 'image'.`);
  }

  // Optional: draw a small visible audit line below the signature
  if (drawAuditLine && auditText) {
    const font = await pdfDoc.embedFont(StandardFonts.Helvetica);
    const auditSize = 6;
    const lineY = userY - 2 - auditSize;
    // Keep the 2pt floor measured from the box's own bottom edge, not from
    // absolute user-space zero, so the guard means the same thing on a
    // nonzero-origin page.
    if (lineY > boxGeometry.originY + 2) {
      pdfPage.drawText(auditText, {
        x: userX,
        y: lineY,
        size: auditSize,
        font,
        color: rgb(0.4, 0.4, 0.4),
      });
    }
  }
}

// Stamp a plain text string on a page — used for date zones and any other
// "just put these characters here" operation that isn't a signature.
// Same top-left coordinate convention as stampSignatureOnPage.
// No signature asset needed; no intent check required (text is not a signature).
export async function stampTextOnPage(pdfDoc, {
  page,
  x, y, width, height,
  text,
  fontStyle = "normal", // "normal" | "italic"
  color = { r: 0.05, g: 0.05, b: 0.15 },
}) {
  const pages = pdfDoc.getPages();
  if (page < 1 || page > pages.length) {
    throw new Error(`Page ${page} is out of range (1-${pages.length}).`);
  }
  const pdfPage = pages[page - 1];
  const boxGeometry = getPageBoxGeometry(pdfPage);
  const { width: pageW, height: pageH } = boxGeometry;

  if (!Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(width) || !Number.isFinite(height)) {
    throw new Error("x, y, width, height must all be finite numbers.");
  }
  if (width <= 0 || height <= 0) {
    throw new Error(`width and height must be positive (got ${width} x ${height}).`);
  }
  if (x < 0 || y < 0 || x + width > pageW || y + height > pageH) {
    throw new Error(
      `Text box (${x}, ${y}, ${width}x${height}) falls outside page bounds ` +
      `(page ${page} is ${pageW.toFixed(0)}x${pageH.toFixed(0)} pts).`
    );
  }
  const safeText = String(text ?? "");
  if (!safeText || safeText.length > 200) {
    throw new Error(`text must be a non-empty string no longer than 200 chars (got ${safeText.length}).`);
  }

  const pdfY = pageH - y - height;
  const { x: userX, y: userY } = toUserSpace(boxGeometry, x, pdfY);
  const font = await pdfDoc.embedFont(
    fontStyle === "italic" ? StandardFonts.HelveticaOblique : StandardFonts.Helvetica
  );

  // Fit text to box: find largest font size whose width fits 95% of box width,
  // capped by 80% of box height so ascenders/descenders aren't clipped.
  let fontSize = Math.min(height * 0.7, 18);
  const maxWidth = width * 0.95;
  const measured = font.widthOfTextAtSize(safeText, fontSize);
  if (measured > maxWidth) {
    fontSize = Math.max(6, fontSize * (maxWidth / measured));
  }
  const textWidth = font.widthOfTextAtSize(safeText, fontSize);
  const textX = userX + (width - textWidth) / 2;
  const textY = userY + (height - font.heightAtSize(fontSize)) / 2 + fontSize * 0.15;

  pdfPage.drawText(safeText, {
    x: textX,
    y: textY,
    size: fontSize,
    font,
    color: rgb(color.r, color.g, color.b),
  });
}

// Draw a visible "sign here" placeholder box on a page.
// Same top-left coordinate convention as stampSignatureOnPage.
export async function drawSignatureFieldOnPage(pdfDoc, {
  page,
  x, y, width, height,
  label = "Sign here",
}) {
  const pages = pdfDoc.getPages();
  if (page < 1 || page > pages.length) {
    throw new Error(`Page ${page} is out of range (1-${pages.length}).`);
  }
  const pdfPage = pages[page - 1];
  const boxGeometry = getPageBoxGeometry(pdfPage);
  const { width: pageW, height: pageH } = boxGeometry;
  if (x < 0 || y < 0 || x + width > pageW || y + height > pageH) {
    throw new Error(
      `Signature field (${x}, ${y}, ${width}x${height}) falls outside page bounds ` +
      `(page ${page} is ${pageW.toFixed(0)}x${pageH.toFixed(0)} pts).`
    );
  }
  const pdfY = pageH - y - height;
  const { x: userX, y: userY } = toUserSpace(boxGeometry, x, pdfY);

  // Light gray dashed rectangle outline
  pdfPage.drawRectangle({
    x: userX, y: userY, width, height,
    borderColor: rgb(0.55, 0.55, 0.6),
    borderWidth: 0.75,
    borderOpacity: 0.9,
    color: rgb(0.97, 0.97, 0.99),
    opacity: 0.6,
  });

  // Label centered in the box
  const font = await pdfDoc.embedFont(StandardFonts.Helvetica);
  const text = String(label || "Sign here");
  const labelSize = Math.min(height * 0.35, 10);
  const textWidth = font.widthOfTextAtSize(text, labelSize);
  pdfPage.drawText(text, {
    x: userX + (width - textWidth) / 2,
    y: userY + height / 2 - labelSize * 0.35,
    size: labelSize,
    font,
    color: rgb(0.45, 0.45, 0.5),
  });
}

// Detect whether a PDF already has one or more cryptographic signature fields.
// If we modify such a PDF, pdf-lib's save() invalidates the existing signature —
// so every mutating tool should refuse (or require opt-in) when this returns true.
// Returns { present, fieldNames }.
export function detectExistingSignatures(pdfDoc) {
  try {
    const form = pdfDoc.getForm();
    const fields = form.getFields();
    const sigFields = fields.filter(f => {
      const typeName = f.constructor.name || "";
      return typeName.includes("Signature");
    });
    return {
      present: sigFields.length > 0,
      fieldNames: sigFields.map(f => {
        try { return f.getName(); } catch { return "(unnamed)"; }
      }),
    };
  } catch {
    // No form or error reading — treat as no signatures (don't block the tool).
    return { present: false, fieldNames: [] };
  }
}

// Heuristic: does this PDF use XFA forms?
// pdf-lib strips XFA data on save(), which silently guts government/IRS forms.
// We scan the raw bytes for the /XFA dict entry — fast and effective.
// Not 100% foolproof (won't catch heavily-obfuscated PDFs) but catches all
// real-world XFA forms we've tested.
export function detectXfaForm(pdfBytes) {
  if (!pdfBytes || pdfBytes.length < 10) return false;
  // Scan first 200KB — XFA refs are always in the catalog/AcroForm, near the
  // top of the file. Whole-file scan would be unnecessarily expensive.
  const searchLimit = Math.min(pdfBytes.length, 200 * 1024);
  const sample = pdfBytes.subarray(0, searchLimit).toString("latin1");
  // Match /XFA followed by whitespace, array start, or dict ref
  return /\/XFA[\s\[<\/]/.test(sample);
}

export function assertXfaMutationAllowed(pdfBytes, { forceXfa = false } = {}) {
  if (!forceXfa && detectXfaForm(pdfBytes)) {
    throw new Error(
      "This PDF uses XFA forms, which pdf-lib cannot preserve — saving it would destroy the form data. " +
      "Convert the form to AcroForm first (e.g. via Adobe Acrobat's 'Flatten Form'), or pass force_xfa=true " +
      "if you understand that the XFA layer will be stripped."
    );
  }
}

// ─── Signature zone detection ────────────────────────────────────────────────
// Finds "Sign here", initials, name, and date zones in a PDF so agents/viewers can
// place signatures at real locations instead of guessing coordinates.

// Compute intersection-over-union for two top-left-origin rectangles.
// Used for dedup and for the golden-set placement eval.
export function computeIoU(a, b) {
  const x1 = Math.max(a.x, b.x);
  const y1 = Math.max(a.y, b.y);
  const x2 = Math.min(a.x + a.width, b.x + b.width);
  const y2 = Math.min(a.y + a.height, b.y + b.height);
  if (x2 <= x1 || y2 <= y1) return 0;
  const intersection = (x2 - x1) * (y2 - y1);
  const areaA = a.width * a.height;
  const areaB = b.width * b.height;
  const union = areaA + areaB - intersection;
  return union > 0 ? intersection / union : 0;
}

// Extract text items from a PDF with top-left origin bounding boxes IN THE
// PAGE'S NATIVE (pre-rotation) COORDINATE SPACE. This matches how pdf-lib
// reads widget rectangles and how our apply_signature tool stamps — all three
// agree on native coords so rotated pages render stamps at the correct spot
// visually. Callers that consume zones in a viewer MUST apply the page's
// rotation when rendering clicks back into zone coords.
// Takes a loaded pdfjs module so helpers.js doesn't need its own init.
// Returns: [{ page, width, height, items: [{ text, x, y, width, height, fontSize }] }]
export async function extractPdfTextWithBounds(pdfjsLib, pdfBytes, { password, maxPages = 500, mediaBoxes } = {}) {
  let nativeMediaBoxes = mediaBoxes;
  if (!nativeMediaBoxes) {
    try {
      const geometryDocument = await PDFDocument.load(pdfBytes, {
        ignoreEncryption: true,
        updateMetadata: false,
      });
      nativeMediaBoxes = geometryDocument.getPages().map(page => page.getMediaBox());
    } catch {
      nativeMediaBoxes = null;
    }
  }
  if (!nativeMediaBoxes) {
    throw new Error("Native signature-zone coordinates require PDF MediaBox geometry");
  }
  const doc = await pdfjsLib.getDocument({
    data: new Uint8Array(pdfBytes),
    password: password || undefined,
    useSystemFonts: true,
    disableFontFace: true,
    verbosity: 0,
  }).promise;

  const out = [];
  try {
    const numPages = Math.min(doc.numPages, maxPages);
    for (let i = 1; i <= numPages; i++) {
      const page = await doc.getPage(i);
      const mediaBox = nativeMediaBoxes?.[i - 1];
      if (!mediaBox) {
        throw new Error(`Native signature-zone coordinates require MediaBox geometry for page ${i}`);
      }
      const pageW = mediaBox.width;
      const pageH = mediaBox.height;
      // pdf.js text transforms are absolute user space. Subtract the MediaBox
      // origin so emitted bounds are box-relative per the canonical convention.
      const originX = Number.isFinite(mediaBox.x) ? mediaBox.x : 0;
      const originY = Number.isFinite(mediaBox.y) ? mediaBox.y : 0;
      const textContent = await page.getTextContent();
      const items = [];
      for (const it of textContent.items) {
        if (!it || !it.str) continue;
        const str = it.str;
        // Skip pure-whitespace tokens — they don't help pattern matching
        if (!str.trim()) continue;
        const tr = it.transform || [1, 0, 0, 1, 0, 0];
        // transform = [a, b, c, d, e, f]; (e, f) = baseline origin in PDF coords
        const a = tr[0], d = tr[3], e = tr[4], f = tr[5];
        // fontSize ≈ hypot of the vertical-scale components, works for non-rotated text
        const fontSize = Math.abs(d) > 0.01 ? Math.abs(d) : Math.max(Math.hypot(tr[2], d), 8);
        const textWidth = typeof it.width === "number" && it.width > 0 ? it.width : fontSize * str.length * 0.5;
        // PDF baseline in bottom-left origin: baselineY_bl = f
        // Top of glyph in bottom-left: f + fontSize * 0.75 (ascent)
        // Convert to the native top-left convention used by the stamping tools,
        // removing the MediaBox origin so both sides share one box-relative space.
        const xTopLeft = e - originX;
        const yTopLeft = (originY + pageH) - f - fontSize * 0.75;
        items.push({
          text: str,
          x: xTopLeft,
          y: yTopLeft,
          width: textWidth,
          height: fontSize,
          fontSize,
        });
      }
      out.push({ page: i, width: pageW, height: pageH, items });
    }
  } finally {
    await doc.destroy();
  }
  return out;
}

// Text-heuristic patterns, ordered by confidence. First match wins per item.
// Zone starts to the RIGHT of the label text by default; initials/date boxes
// are smaller than signature boxes.
//
// IMPORTANT: these patterns are strict by design. "Signature requirements."
// should NOT match — that's instructional text, not a zone label. Only match
// labels that clearly precede a signing area: followed by "of", ":", end-of-string,
// or a standalone "Sign Here" / "X ______" style marker.
// `requiresRoom` means the bare-word match only counts if there's clear
// horizontal space to the right on the same baseline — suppresses false
// positives on section headers like Part II's "Signature of U.S. person"
// subheading or table column header "Date" where there's actual content
// immediately to the right.
// `placement`:
//   "right" — label is followed by a horizontal line on the same baseline;
//             zone sits to the right of the label (e.g. "Signature of X ____")
//   "above" — label is UNDER a horizontal line (the line is the signing surface);
//             zone sits above the label so a signature rests on the line.
//             Common on government forms where bare "Signature" / "Date" label
//             a line one row above.
const SIGNATURE_PATTERNS = [
  // Most "Signature of X" labels on legal/gov forms caption the signature
  // LINE ABOVE them (e.g. "___________\nSignature of Authorized Officer").
  // Place above by default; the existing fallback inside scanPageForLabels
  // switches to right-placement when the label is too close to the page top.
  { rx: /^Signature of\b/i,          type: "signature", confidence: 0.92, zoneWidth: 260, placement: "above" },
  { rx: /^Signature\s*:\s*\*?\s*[_-]*$/i,
                                        type: "signature", confidence: 0.88, zoneWidth: 260, placement: "right" },
  { rx: /^Signatures\s*:?\s*\*?\s*[_-]*$/i,
                                        type: "signature", confidence: 0.80, zoneWidth: 260, placement: "above", requiresRoom: 40 },
  { rx: /^Signed by\s*:?\s*\*?\s*[_-]*$/i,
                                        type: "signature", confidence: 0.80, zoneWidth: 240, placement: "right" },
  { rx: /^Authorized Signature\s*:?\s*\*?\s*[_-]*$/i,
                                        type: "signature", confidence: 0.84, zoneWidth: 240, placement: "above" },
  { rx: /^Borrower['\u2019]s Signature\s*:?\s*\*?\s*[_-]*$/i,
                                        type: "signature", confidence: 0.84, zoneWidth: 240, placement: "above" },
  { rx: /^Witness\s*:?\s*\*?\s*[_-]*$/i,
                                        type: "signature", confidence: 0.76, zoneWidth: 240, placement: "above", requiresRoom: 40 },
  { rx: /^Signature$/i,               type: "signature", confidence: 0.75, zoneWidth: 240, placement: "above", requiresRoom: 40 },
  // Qualifier + Signature — "Applicant Signature", "Employee Signature*",
  // "Borrower's Signature", "Witness Signature", "Authorized Officer Signature".
  // 1–3 qualifier words (letters, numbers, apostrophes) then the literal
  // "Signature" with optional "*" (common required-field marker).
  { rx: /^(?:[A-Za-z][A-Za-z'0-9]*\s+){1,3}Signature\*?$/,
                                        type: "signature", confidence: 0.80, zoneWidth: 240, placement: "above" },
  { rx: /^(?:[A-Za-z][A-Za-z'0-9]*\s+){1,3}Initials?\*?$/,
                                        type: "initials",  confidence: 0.75, zoneWidth: 60,  placement: "above" },
  { rx: /^Sign Here\s*:?\s*\*?\s*[_-]*$/i,
                                        type: "signature", confidence: 0.85, zoneWidth: 260, placement: "right" },
  { rx: /^X[\s_]{3,}/,                type: "signature", confidence: 0.70, zoneWidth: 240, placement: "right" },
  { rx: /^Initials?\s*:\s*\*?\s*[_-]*$/i,
                                        type: "initials",  confidence: 0.78, zoneWidth: 60,  placement: "right" },
  { rx: /^Init\.?:?$/i,               type: "initials",  confidence: 0.75, zoneWidth: 50,  placement: "above" },
  { rx: /^Initials?$/i,               type: "initials",  confidence: 0.72, zoneWidth: 60,  placement: "above", requiresRoom: 30 },
  { rx: /^Print(?:ed)? Name\s*:\s*\*?\s*[_-]*$/i,
                                        type: "name",      confidence: 0.80, zoneWidth: 220, placement: "right" },
  { rx: /^Print(?:ed)? Name\s*\*?\s*[_-]*$/i,
                                        type: "name",      confidence: 0.74, zoneWidth: 220, placement: "above", requiresRoom: 40 },
  { rx: /^Dated\s*:\s*\*?\s*[_-]*$/i,
                                        type: "date",      confidence: 0.75, zoneWidth: 110, placement: "right" },
  { rx: /^Date\s*:\s*\*?\s*[_-]*$/i,
                                        type: "date",      confidence: 0.75, zoneWidth: 110, placement: "right" },
  { rx: /^Date$/i,                    type: "date",      confidence: 0.65, zoneWidth: 110, placement: "above", requiresRoom: 30 },
];

// Check whether there's empty space to the right of this item within `minPts`
// on roughly the same baseline. Used to gate bare-word pattern matches so
// section headers / column labels don't false-positive.
// Ignores single-character decorative glyphs (arrows, bullets, check marks)
// that forms use to point at the signing area — those don't fill the space.
function isDecorativeGlyph(text) {
  if (text.length !== 1) return false;
  // Not a letter, digit, or common punctuation — almost certainly a form glyph
  return !/[A-Za-z0-9.,;:!?@#$%&*()\[\]{}\-_+=<>\/\\]/.test(text);
}

function isSigningArrowMarker(text) {
  // W-9-style labels use arrow glyphs to point at the signing surface.
  // Do not treat bullets/checkmarks as anchors; they are common in body copy.
  return /^[\u25B6\u25B8\u25BA\u2794\u279C\u2192]$/.test(text);
}

function sameBaseline(a, b, tolerance = Math.max(a.height, b.height) * 1.2) {
  return Math.abs(a.y - b.y) <= tolerance;
}

function verticalSpansOverlap(a, b) {
  return Math.min(a.y + a.height, b.y + b.height) > Math.max(a.y, b.y);
}

function findSigningArrowMarkerToRight(item, allItems, { maxGap = 120 } = {}) {
  const itemRight = item.x + item.width;
  return allItems
    .filter(other =>
      other !== item &&
      isSigningArrowMarker(other.text) &&
      sameBaseline(item, other) &&
      other.x >= itemRight &&
      other.x - itemRight <= maxGap
    )
    .sort((a, b) => a.x - b.x)[0] ?? null;
}

function findContinuationMarkerBelow(item, allItems) {
  const lowerLines = allItems
    .filter(other =>
      other !== item &&
      !isDecorativeGlyph(other.text) &&
      Math.abs(other.x - item.x) <= 8 &&
      other.y > item.y &&
      other.y - item.y <= Math.max(item.height * 2.5, 18)
    )
    .sort((a, b) => a.y - b.y || a.x - b.x);

  for (const line of lowerLines) {
    const marker = findSigningArrowMarkerToRight(line, allItems, { maxGap: 80 });
    if (marker) return marker;
  }
  return null;
}

function findNextTextToRightOnBaseline(anchor, allItems, minX) {
  return allItems
    .filter(other =>
      !isDecorativeGlyph(other.text) &&
      sameBaseline(anchor, other) &&
      other.x > minX
    )
    .sort((a, b) => a.x - b.x)[0] ?? null;
}

function markerAnchoredZone(item, allItems, pat, gap, zoneHeight, rightBound) {
  const directMarker = findSigningArrowMarkerToRight(item, allItems);
  const continuationMarker = directMarker ? null : findContinuationMarkerBelow(item, allItems);
  const marker = directMarker || continuationMarker;
  if (!marker) return null;

  const zoneX = marker.x + marker.width + gap;
  const nextText = findNextTextToRightOnBaseline(marker, allItems, zoneX);
  const baselineRightBound = nextText ? Math.min(rightBound, nextText.x - gap) : rightBound;
  const zoneWidth = Math.min(pat.zoneWidth, Math.max(baselineRightBound - zoneX, 0));
  if (zoneWidth < 24) return null;
  const markerPointsToCaptionedLine =
    Boolean(continuationMarker) ||
    /^(Signature|Signatures|Initials?|Print(?:ed)? Name|Date|Dated|Witness):?$/i.test(item.text.trim());
  const effectiveZoneHeight = markerPointsToCaptionedLine
    ? Math.min(zoneHeight, 16)
    : zoneHeight;
  const captionedLineY = marker.y - effectiveZoneHeight - 1;
  return {
    zoneX,
    // W-9-style arrows often live on the label/continuation baseline, while
    // the actual signing surface is the blank row above the label. Use the
    // marker to find horizontal start, but only use above-line vertical
    // placement for captioned rows. Same-baseline "Signature of X -> line"
    // layouts stay centered on the marker row.
    zoneY: pat.placement === "above" && markerPointsToCaptionedLine && captionedLineY >= 4
      ? captionedLineY
      : marker.y - (zoneHeight - marker.height) / 2,
    zoneWidth,
    zoneHeight: effectiveZoneHeight,
  };
}

function sideCaptionedSigningRowZone(item, allItems, gap, zoneHeight, rightBound, desiredWidth) {
  // Some forms split a left-side caption across two lines while the actual
  // signing surface occupies the rest of that same row. Keep this deliberately
  // strict so ordinary "Signature of ..." captions retain line-above placement.
  if (!/^Signature of\s*:?\s*$/i.test(item.text.trim())) return null;

  const continuation = allItems
    .filter(other =>
      other !== item &&
      Math.abs(other.x - item.x) <= 4 &&
      other.y > item.y &&
      other.y - item.y <= Math.max(item.height * 2, 14) &&
      other.text.trim() &&
      !/^(?:Sign|Here|Date|Dated)$/i.test(other.text.trim()) &&
      !isDecorativeGlyph(other.text.trim())
    )
    .sort((a, b) => a.y - b.y || a.x - b.x)[0] ?? null;
  if (!continuation) return null;

  const captionRight = Math.max(
    item.x + item.width,
    continuation.x + continuation.width
  );
  const dateLabel = allItems
    .filter(other =>
      /^(?:Date|Dated)$/i.test(other.text.trim()) &&
      other.x > captionRight + gap &&
      sameBaseline(continuation, other) &&
      verticalSpansOverlap(continuation, other)
    )
    .sort((a, b) => a.x - b.x)[0] ?? null;
  if (!dateLabel) return null;

  const signLabels = allItems
    .filter(other =>
      /^Sign$/i.test(other.text.trim()) &&
      other.x + other.width <= item.x &&
      item.x - (other.x + other.width) <= 80 &&
      sameBaseline(item, other) &&
      verticalSpansOverlap(item, other)
    )
    .sort((a, b) => a.x - b.x || a.y - b.y);

  const hasStackedHeading = signLabels.some(signLabel =>
    allItems.some(hereLabel =>
      /^Here$/i.test(hereLabel.text.trim()) &&
      hereLabel.x + hereLabel.width <= item.x &&
      Math.abs(hereLabel.x - signLabel.x) <= 4 &&
      hereLabel.y > signLabel.y &&
      hereLabel.y - signLabel.y <= Math.max(signLabel.height * 2, 20) &&
      sameBaseline(continuation, hereLabel) &&
      verticalSpansOverlap(continuation, hereLabel)
    )
  );
  if (!hasStackedHeading) return null;

  const zoneX = captionRight + gap;
  const rowRightBound = Math.min(rightBound, dateLabel.x - gap);
  const zoneWidth = Math.min(desiredWidth, Math.max(rowRightBound - zoneX, 0));
  if (zoneWidth < 24) return null;

  return {
    zoneX,
    zoneY: item.y - (zoneHeight - item.height) / 2,
    zoneWidth,
  };
}

function hasRoomToRight(item, allItems, minPts) {
  const labelRightEdge = item.x + item.width;
  for (const other of allItems) {
    if (other === item) continue;
    if (!sameBaseline(item, other, item.height * 0.7)) continue;
    if (other.x <= labelRightEdge) continue;
    if (isDecorativeGlyph(other.text)) continue;
    const gap = other.x - labelRightEdge;
    if (gap < minPts) return false;
  }
  return true;
}

// Scan one page's text items for signature/initials/name/date labels.
// Zone begins right after the label; width comes from the pattern config.
export function scanPageForLabels(page) {
  const zones = [];
  for (const item of page.items) {
    const text = item.text.trim();
    for (const pat of SIGNATURE_PATTERNS) {
      if (!pat.rx.test(text)) continue;
      // Bare-word patterns (e.g. /^Signature$/) require empty space to their
      // right — otherwise they fire on section headings and column labels.
      if (pat.requiresRoom && !hasRoomToRight(item, page.items, pat.requiresRoom)) {
        break; // matched but suppressed — don't fall through to other patterns
      }
      const gap = 6;
      let zoneHeight = Math.max(item.height * 1.3, 18);
      const rightBound = page.width - 18;
      let zoneX, zoneY, zoneWidth;

      const markerZone = markerAnchoredZone(item, page.items, pat, gap, zoneHeight, rightBound);
      if (markerZone) {
        ({ zoneX, zoneY, zoneWidth } = markerZone);
        zoneHeight = markerZone.zoneHeight || zoneHeight;
      } else {
        const sideCaptionedZone = sideCaptionedSigningRowZone(
          item,
          page.items,
          gap,
          zoneHeight,
          rightBound,
          pat.zoneWidth
        );
        if (sideCaptionedZone) {
          ({ zoneX, zoneY, zoneWidth } = sideCaptionedZone);
        } else if (pat.placement === "above") {
          // Line sits above the label; the zone rests on the line with its
          // bottom roughly at the label's top edge. Shift up by (zoneHeight + 2)
          // so the zone's bottom is approximately the line's y.
          zoneX = item.x;
          zoneY = item.y - zoneHeight - 2;
          // If the label is too close to the page top there's no line above.
          // Fall back to right-placement so we don't emit a zone off-page.
          if (zoneY < 4) {
            zoneX = item.x + item.width + gap;
            zoneY = item.y - (zoneHeight - item.height) / 2;
            zoneWidth = Math.min(pat.zoneWidth, Math.max(rightBound - zoneX, 0));
          } else {
            zoneWidth = Math.min(pat.zoneWidth, Math.max(rightBound - zoneX, 0));
          }
        } else {
          zoneX = item.x + item.width + gap;
          zoneY = item.y - (zoneHeight - item.height) / 2;
          zoneWidth = Math.min(pat.zoneWidth, Math.max(rightBound - zoneX, 0));
        }
      }

      if (zoneWidth < 24) break; // too squeezed — label with no room
      zones.push({
        type: pat.type,
        label: text,
        page: page.page,
        x: Math.round(zoneX * 10) / 10,
        y: Math.round(zoneY * 10) / 10,
        width: Math.round(zoneWidth * 10) / 10,
        height: Math.round(zoneHeight * 10) / 10,
        confidence: pat.confidence,
        source: "text-heuristic",
      });
      break; // one pattern per item
    }
  }
  return zones;
}

// Look up AcroForm signature-typed fields and signature-named text fields.
// Uses pdf-lib to read field types + widget rectangles.
// Returns zones in top-left origin.
const UNRESOLVED_WIDGET_PAGE_WARNING = Object.freeze({
  code: "ACROFORM_WIDGET_PAGE_UNRESOLVED",
  message: "Skipped an AcroForm signing widget because its page could not be resolved. No page location was guessed.",
});

function scanAcroFormForZones(pdfDoc, { onWarning } = {}) {
  const zones = [];
  let fields;
  try {
    fields = pdfDoc.getForm().getFields();
  } catch {
    return zones;
  }
  const pages = pdfDoc.getPages();
  // Widget /Rect values are absolute user space, so the MediaBox origin has to
  // come off here too — otherwise AcroForm zones and text zones would be
  // reported in two different coordinate spaces on a nonzero-origin page.
  const pageBoxes = pages.map(p => getPageBoxGeometry(p));

  for (const field of fields) {
    const typeName = field.constructor.name || "";
    let widgets;
    try { widgets = field.acroField.getWidgets(); } catch { continue; }
    if (!widgets || widgets.length === 0) continue;

    const isSignature = typeName.includes("Signature");
    const fieldName = (() => { try { return field.getName(); } catch { return ""; } })();
    // Match signature-like field names that are clearly *about* signing:
    //   "Signature", "Signature1", "sig_date", "Name_Sig", "form_signature"
    // Reject substrings inside unrelated words: "assignment", "design", "resignation", "Initialize"
    // Leading `(^|[^a-z])` demands a non-letter boundary before the keyword (rejects camelCase
    // midwords like "DocumentSignature" too — minor false-negative, acceptable for v0.8.0).
    // Trailing `(?![a-z])` rejects continuations: "signature" vs "signatures_optional" (match)
    // but "signaturelookup" (continues with letter — reject).
    const looksLikeSig = !isSignature && typeName.includes("TextField") &&
      /(^|[^a-z])(sig|signature)s?(?![a-z])/i.test(fieldName);
    const looksLikeInitials = !isSignature && typeName.includes("TextField") &&
      /(^|[^a-z])initials?(?![a-z])/i.test(fieldName);
    const looksLikeName = !isSignature && typeName.includes("TextField") &&
      /(^|[^a-z])print(?:ed)?[\s_-]*name(?![a-z])/i.test(fieldName);
    if (!isSignature && !looksLikeSig && !looksLikeInitials && !looksLikeName) continue;

    for (const widget of widgets) {
      let rect;
      try { rect = widget.getRectangle(); } catch { continue; }
      // Find the page index for this widget
      let pageIdx = -1;
      try {
        const pRef = widget.P && widget.P();
        if (pRef) {
          for (let i = 0; i < pages.length; i++) {
            if (pages[i].ref === pRef) { pageIdx = i; break; }
          }
        }
      } catch { /* fall through */ }
      if (pageIdx === -1) {
        // Resolve the widget's indirect reference through pdf-lib's own page
        // annotation lookup. Reading PDFArray internals directly is brittle and
        // can silently miss a valid page association.
        try {
          const widgetRef = pdfDoc.context.getObjectRef(widget.dict);
          const widgetPage = widgetRef
            ? pdfDoc.findPageForAnnotationRef(widgetRef)
            : undefined;
          pageIdx = widgetPage ? pages.indexOf(widgetPage) : -1;
        } catch { /* fall through to the bounded warning below */ }
      }
      if (pageIdx === -1) {
        onWarning?.(UNRESOLVED_WIDGET_PAGE_WARNING);
        continue;
      }

      const pageBox = pageBoxes[pageIdx];
      const pageH = pageBox.height;
      const type = isSignature || looksLikeSig
        ? "signature"
        : looksLikeInitials
          ? "initials"
          : "name";
      const zone = {
        type,
        label: fieldName || (type === "signature" ? "Signature" : type === "initials" ? "Initials" : "Print Name"),
        page: pageIdx + 1,
        x: Math.round((rect.x - pageBox.originX) * 10) / 10,
        y: Math.round(((pageBox.originY + pageH) - rect.y - rect.height) * 10) / 10,
        width: Math.round(rect.width * 10) / 10,
        height: Math.round(rect.height * 10) / 10,
        confidence: isSignature ? 0.99 : 0.85,
        source: isSignature ? "acroform-signature" : "acroform-named-field",
      };
      zones.push(zone);
    }
  }
  return zones;
}

// Remove overlapping zones of the same type, keeping the higher-confidence one.
// Different semantic fields can legitimately share rows or overlap vertically.
export function dedupeOverlappingZones(zones, iouThreshold = 0.4) {
  const sorted = [...zones].sort((a, b) => b.confidence - a.confidence);
  const kept = [];
  for (const z of sorted) {
    const dup = kept.some(k =>
      k.type === z.type &&
      k.page === z.page &&
      computeIoU(k, z) >= iouThreshold
    );
    if (!dup) kept.push(z);
  }
  // Final sort: by page then by y-coordinate (top to bottom)
  kept.sort((a, b) => a.page - b.page || a.y - b.y || a.x - b.x);
  return kept;
}

// Main entry: returns a typed zone array for the given PDF.
// Caller supplies the loaded pdfjs module (helpers.js stays pure-import).
export async function detectSignatureZones({
  pdfDoc,
  pdfBytes,
  pdfjsLib,
  password,
  onWarning,
  scanAcroForm = true,
}) {
  const zones = [];

  // Layer 1+2: AcroForm signature fields and signature-named text fields
  if (pdfDoc && scanAcroForm) {
    zones.push(...scanAcroFormForZones(pdfDoc, { onWarning }));
  }

  // Layer 3: Text-heuristic pattern matching
  if (pdfjsLib && pdfBytes) {
    try {
      const mediaBoxes = pdfDoc
        ? pdfDoc.getPages().map(page => page.getMediaBox())
        : undefined;
      const pages = await extractPdfTextWithBounds(pdfjsLib, pdfBytes, { password, mediaBoxes });
      for (const page of pages) {
        zones.push(...scanPageForLabels(page));
      }
    } catch (err) {
      const passwordResponses = pdfjsLib?.PasswordResponses;
      if (
        err?.name === "PasswordException" &&
        passwordResponses &&
        [passwordResponses.NEED_PASSWORD, passwordResponses.INCORRECT_PASSWORD].includes(err.code)
      ) {
        throw err;
      }
      onWarning?.({
        code: "TEXT_EXTRACTION_UNAVAILABLE",
        message: "Text labels could not be scanned. No text-derived zones were returned.",
      });
    }
  }

  return dedupeOverlappingZones(zones);
}

// Build a compact one-line audit trail to store in PDF metadata.
export function formatSigningAuditLine({ display_name, statement, confirmedAt, action = "signed" }) {
  const iso = confirmedAt.toISOString();
  // Sanitize statement — metadata should be single-line
  const flat = statement.replace(/\s+/g, " ").trim();
  return `${action} via pdf-toolkit; signer="${display_name}"; at=${iso}; intent="${flat}"`;
}

// Parse page range strings like "1-5,6-10" or "every 5"

// Sanitize a filename for safe filesystem use. Always ends with .pdf.
export function sanitizePdfFilename(name) {
  let safe = path.basename(String(name || ""));
  safe = safe.replace(/[\x00-\x1f\x7f]/g, "");
  safe = safe.replace(/[\/\\:*?"<>|]/g, "_");
  safe = safe.replace(/^\.+/, "").trim();
  if (!safe) safe = "download.pdf";
  if (!safe.toLowerCase().endsWith(".pdf")) safe += ".pdf";
  return safe;
}
const PDF_OUTPUT_TRANSACTION_VERSION = 3;
const PDF_OUTPUT_JOURNAL_PATTERN = /^\.pdf-tools-([a-f0-9]{64})-transaction\.json$/;
const PDF_OUTPUT_JOURNAL_CANDIDATE_PATTERN = /^\.pdf-tools-[a-f0-9]{64}-transaction\.json\.candidate-[a-f0-9-]+$/;
const PDF_OUTPUT_LOCK_NAME = ".pdf-tools-output-transaction.lock";
const PDF_OUTPUT_LOCK_CANDIDATE_PATTERN = /^\.pdf-tools-output-transaction\.lock\.candidate-(\d+)-[a-f0-9-]+$/;
const PDF_OUTPUT_STALE_LOCK_PATTERN = /^\.pdf-tools-output-transaction\.lock\.stale-[a-f0-9-]+$/;
const PDF_OUTPUT_LOCK_OWNER_NAME = "owner.json";
const NOFOLLOW_READ_FLAGS = fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW ?? 0);

// Open a canonical path for reading and prove the descriptor is the same
// regular file that was inspected a moment earlier. O_NOFOLLOW refuses a final
// component that became a symlink after canonicalization; the device/inode
// compare refuses a replacement that reused the name in the window between the
// lstat and the open (CWE-367). The caller owns closing the returned handle.
//
// fsOps is injected so this window can be forced in a test: a filesystem whose
// open() reaches a different inode than the preceding lstat() must be rejected
// here rather than read.
function openFileDeviceIdentityMatches(left, right, platform) {
  if (left.dev === right.dev) return true;
  const leftMissing = left.dev === 0 || left.dev === 0n;
  const rightMissing = right.dev === 0 || right.dev === 0n;
  return platform === "win32" && leftMissing !== rightMissing;
}

export async function openVerifiedRegularFile(fsOps, canonicalPath, {
  platform = process.platform,
} = {}) {
  const beforeStat = await fsOps.lstat(canonicalPath);
  if (beforeStat.isSymbolicLink() || !beforeStat.isFile()) {
    throw new Error(`Not a regular file: ${path.basename(canonicalPath)}`);
  }
  const handle = await fsOps.open(canonicalPath, NOFOLLOW_READ_FLAGS);
  try {
    const descriptorStat = await handle.stat();
    if (
      !descriptorStat.isFile()
      || !openFileDeviceIdentityMatches(descriptorStat, beforeStat, platform)
      || descriptorStat.ino !== beforeStat.ino
    ) {
      throw new Error("The file changed while it was being opened. Retry the request.");
    }
    return { handle, stat: descriptorStat };
  } catch (error) {
    await handle.close().catch(() => {});
    throw error;
  }
}

const RECOVERY_DIRECTORY_GUARD_FAILURE = Symbol("recoveryDirectoryGuardFailure");
const JOURNAL_EXPECTATION_FAILURE = Symbol("journalExpectationFailure");
const JOURNAL_PUBLISHED_EXPECTATION = Symbol("journalPublishedExpectation");
function atomicOutputDirectoryChangedError(cause = null) {
  return atomicOutputError(
    "ATOMIC_OUTPUT_DIRECTORY_CHANGED",
    "The PDF output directory changed during the transaction. Retry the request.",
    cause,
  );
}
export function portableFilesystemDevice(stat, platform = process.platform) {
  return platform === "win32" ? "win32-unavailable" : String(stat.dev);
}

function stableDirectoryIdentity(stat) {
  return {
    device: portableFilesystemDevice(stat),
    inode: String(stat.ino),
  };
}
function sameStableDirectoryIdentity(left, right) {
  return Boolean(
    left
    && right
    && left.device === right.device
    && left.inode === right.inode,
  );
}
async function bindAtomicOutputDirectory(
  directoryPath,
  assertPathAllowed,
  fileSystem,
  { anchoredDirectory = false } = {},
) {
  const requestedPath = anchoredDirectory ? "." : path.resolve(directoryPath);
  try {
    await assertPathAllowed(requestedPath);
    const canonicalPath = await fileSystem.realpath(requestedPath);
    await assertPathAllowed(canonicalPath);
    const inspectedPath = anchoredDirectory ? requestedPath : canonicalPath;
    const before = await fileSystem.lstat(inspectedPath, { bigint: true });
    const canonicalAfter = await fileSystem.realpath(requestedPath);
    const after = await fileSystem.lstat(inspectedPath, { bigint: true });
    if (
      canonicalAfter !== canonicalPath
      || !before.isDirectory()
      || before.isSymbolicLink()
      || !after.isDirectory()
      || after.isSymbolicLink()
      || !sameStableDirectoryIdentity(
        stableDirectoryIdentity(before),
        stableDirectoryIdentity(after),
      )
    ) {
      throw atomicOutputDirectoryChangedError();
    }
    await assertPathAllowed(canonicalAfter);
    return {
      requestedPath,
      canonicalPath,
      fileIdentity: stableDirectoryIdentity(after),
      anchoredDirectory,
    };
  } catch (error) {
    if (error?.code === "ATOMIC_OUTPUT_DIRECTORY_CHANGED") throw error;
    // A refusal is not a race. Rewrapping it as a directory change would tell
    // the caller to retry an operation the policy will never allow, and would
    // hide the real reason it stopped.
    if (error?.code === "path_policy_denied") throw error;
    throw atomicOutputDirectoryChangedError(error);
  }
}
async function assertAtomicOutputDirectory(binding, assertPathAllowed, fileSystem) {
  try {
    await assertPathAllowed(binding.requestedPath);
    const canonicalFromRequested = await fileSystem.realpath(binding.requestedPath);
    if (!binding.anchoredDirectory && canonicalFromRequested !== binding.canonicalPath) {
      throw atomicOutputDirectoryChangedError();
    }
    await assertPathAllowed(canonicalFromRequested);
    const inspectedPath = binding.anchoredDirectory ? "." : binding.canonicalPath;
    const before = await fileSystem.lstat(inspectedPath, { bigint: true });
    const canonicalAfter = await fileSystem.realpath(inspectedPath);
    const after = await fileSystem.lstat(inspectedPath, { bigint: true });
    if (
      (!binding.anchoredDirectory && canonicalAfter !== binding.canonicalPath)
      || !before.isDirectory()
      || before.isSymbolicLink()
      || !after.isDirectory()
      || after.isSymbolicLink()
      || !sameStableDirectoryIdentity(
        stableDirectoryIdentity(before),
        stableDirectoryIdentity(after),
      )
      || !sameStableDirectoryIdentity(
        stableDirectoryIdentity(after),
        binding.fileIdentity,
      )
    ) {
      throw atomicOutputDirectoryChangedError();
    }
    await assertPathAllowed(canonicalAfter);
  } catch (error) {
    if (error?.code === "ATOMIC_OUTPUT_DIRECTORY_CHANGED") throw error;
    // A refusal is not a race. Rewrapping it as a directory change would tell
    // the caller to retry an operation the policy will never allow, and would
    // hide the real reason it stopped.
    if (error?.code === "path_policy_denied") throw error;
    throw atomicOutputDirectoryChangedError(error);
  }
}
function sha256Value(value) {
  return createHash("sha256").update(value).digest("hex");
}

function atomicOutputToken() {
  return `${process.pid}-${randomUUID()}`;
}
function atomicOutputTokenId(token) {
  return sha256Value(Buffer.from(String(token)));
}
function atomicSiblingPath(targetPath, tokenId, kind, index = 0) {
  return path.join(path.dirname(targetPath), `.pdf-tools-${tokenId}-${index}-${kind}`);
}
function atomicJournalPath(directoryPath, tokenId) {
  return path.join(directoryPath, `.pdf-tools-${tokenId}-transaction.json`);
}

async function removeAtomicArtifact(
  fsOps,
  artifactPath,
  cleanupErrors,
  {
    recoveryDirectoryGuard = null,
    verifyBeforeUnlink = null,
  } = {},
) {
  for (let attempt = 0; attempt < 3; attempt += 1) {
    if (verifyBeforeUnlink && !await verifyBeforeUnlink()) return;
    await assertRecoveryDirectoryGuard(recoveryDirectoryGuard, "before_artifact_unlink");
    try {
      await fsOps.unlink(artifactPath);
      return;
    } catch (error) {
      if (error?.code === "ENOENT") return;
      if (attempt === 2) cleanupErrors.push({ path: artifactPath, error });
    }
  }
}

async function assertRecoveryDirectoryGuard(recoveryDirectoryGuard, phase) {
  if (!recoveryDirectoryGuard) return;
  try {
    await recoveryDirectoryGuard(phase);
  } catch (error) {
    if (error && (typeof error === "object" || typeof error === "function")) {
      error[RECOVERY_DIRECTORY_GUARD_FAILURE] = true;
    }
    throw error;
  }
}

async function syncAtomicOutputDirectory(
  fsOps,
  directoryPath,
  recoveryDirectoryGuard = null,
  expectedDirectoryIdentity = recoveryDirectoryGuard?.fileIdentity ?? null,
) {
  if (process.platform === "win32") return;
  let handle = null;
  try {
    await assertRecoveryDirectoryGuard(
      recoveryDirectoryGuard,
      "before_output_directory_sync_open",
    );
    handle = await fsOps.open(directoryPath, "r");
    if (expectedDirectoryIdentity) {
      const opened = await handle.stat({ bigint: true });
      if (
        !opened.isDirectory()
        || !sameStableDirectoryIdentity(
          stableDirectoryIdentity(opened),
          expectedDirectoryIdentity,
        )
      ) {
        const error = atomicOutputDirectoryChangedError();
        error[RECOVERY_DIRECTORY_GUARD_FAILURE] = true;
        throw error;
      }
    }
    await handle.sync();
  } catch (error) {
    if (error?.[RECOVERY_DIRECTORY_GUARD_FAILURE]) throw error;
    if (!UNSUPPORTED_DIRECTORY_FSYNC_ERRORS.has(error?.code)) throw error;
  } finally {
    await handle?.close();
  }
}
function recoveryIdentity(stat) {
  if (!stat) return null;
  return [portableFilesystemDevice(stat), stat.ino, stat.mode, stat.size, stat.mtimeMs].join(":");
}
function lockDirectoryIdentity(stat) {
  if (!stat) return null;
  return `${portableFilesystemDevice(stat)}:${stat.ino}`;
}
function portableOutputNameKey(name) {
  return name.normalize("NFC").toLowerCase();
}
function assertOwnedRegularArtifact(artifactPath, stat, { privateMode = false, requireOwner = privateMode } = {}) {
  if (!stat?.isFile() || stat.isSymbolicLink()) {
    throw atomicOutputError(
      "ATOMIC_OUTPUT_ARTIFACT_INVALID",
      `Transaction artifact must be a regular file: ${artifactPath}`,
    );
  }
  if (requireOwner && typeof process.getuid === "function" && stat.uid !== process.getuid()) {
    throw atomicOutputError(
      "ATOMIC_OUTPUT_ARTIFACT_OWNER_INVALID",
      `Transaction artifact is not owned by the current user: ${artifactPath}`,
    );
  }
  if (process.platform !== "win32" && privateMode && (stat.mode & 0o077) !== 0) {
    throw atomicOutputError(
      "ATOMIC_OUTPUT_ARTIFACT_MODE_INVALID",
      `Transaction artifact permissions are too broad: ${artifactPath}`,
    );
  }
}
async function consumeVerifiedRegularFile(
  fsOps,
  filePath,
  {
    privateMode = false,
    changedCode = "ATOMIC_OUTPUT_ARTIFACT_CHANGED",
    changedMessage = `Transaction artifact changed while it was read: ${filePath}`,
    missingError = null,
  } = {},
  consume,
) {
  const pathBefore = await lstatIfPresent(fsOps, filePath);
  if (!pathBefore && typeof missingError === "function") throw missingError();
  assertOwnedRegularArtifact(filePath, pathBefore, { privateMode });
  const handle = await fsOps.open(filePath, NOFOLLOW_READ_FLAGS);
  try {
    const descriptorBefore = await handle.stat();
    assertOwnedRegularArtifact(filePath, descriptorBefore, { privateMode });
    if (outputIdentity(descriptorBefore) !== outputIdentity(pathBefore)) {
      throw atomicOutputError(changedCode, changedMessage);
    }
    const value = await consume(handle);
    const descriptorAfter = await handle.stat();
    const pathAfter = await lstatIfPresent(fsOps, filePath);
    if (
      outputIdentity(descriptorAfter) !== outputIdentity(descriptorBefore)
      || outputIdentity(pathAfter) !== outputIdentity(descriptorAfter)
    ) {
      throw atomicOutputError(changedCode, changedMessage);
    }
    return { value, stat: descriptorAfter };
  } finally {
    await handle.close();
  }
}
async function sha256RegularFile(fsOps, filePath) {
  const { value } = await consumeVerifiedRegularFile(fsOps, filePath, {}, async handle => {
    const hash = createHash("sha256");
    const buffer = Buffer.allocUnsafe(1024 * 1024);
    let position = 0;
    while (true) {
      const { bytesRead } = await handle.read(buffer, 0, buffer.length, position);
      if (bytesRead === 0) break;
      hash.update(buffer.subarray(0, bytesRead));
      position += bytesRead;
    }
    return hash.digest("hex");
  });
  return value;
}
function journalEnvelope(payload) {
  const serializedPayload = JSON.stringify(payload);
  return {
    payload,
    payload_sha256: sha256Value(Buffer.from(serializedPayload)),
  };
}
function journalExpectationError(message) {
  const error = atomicOutputError("ATOMIC_OUTPUT_JOURNAL_CHANGED", message);
  error[JOURNAL_EXPECTATION_FAILURE] = true;
  return error;
}
async function writeAtomicJournal(
  fsOps,
  journalPath,
  payload,
  recoveryDirectoryGuard = null,
  expectedPriorJournal = undefined,
) {
  const candidatePath = `${journalPath}.candidate-${randomUUID()}`;
  const serializedEnvelope = `${JSON.stringify(journalEnvelope(payload))}\n`;
  const envelopeSha256 = sha256Value(Buffer.from(serializedEnvelope));
  const priorJournal = await lstatIfPresent(fsOps, journalPath);
  if (priorJournal) assertOwnedRegularArtifact(journalPath, priorJournal, { privateMode: true });
  const priorJournalIdentity = recoveryIdentity(priorJournal);
  const priorJournalSha256 = priorJournal
    ? await sha256RegularFile(fsOps, journalPath)
    : null;
  if (
    expectedPriorJournal === null
      ? priorJournal !== null
      : expectedPriorJournal !== undefined
        && (
          priorJournalIdentity !== expectedPriorJournal.identity
          || priorJournalSha256 !== expectedPriorJournal.sha256
        )
  ) {
    throw journalExpectationError(
      `Transaction journal did not match the prior published state: ${journalPath}`,
    );
  }
  let handle = null;
  let created = false;
  let candidateIdentity = null;
  let candidateStableIdentity = null;
  let candidateComplete = false;
  let publishedExpectation = null;
  try {
    await assertRecoveryDirectoryGuard(
      recoveryDirectoryGuard,
      "before_journal_candidate_create",
    );
    handle = await fsOps.open(candidatePath, "wx", 0o600);
    created = true;
    const createdCandidate = await lstatIfPresent(fsOps, candidatePath);
    assertOwnedRegularArtifact(candidatePath, createdCandidate, { privateMode: true });
    candidateIdentity = recoveryIdentity(createdCandidate);
    candidateStableIdentity = lockDirectoryIdentity(createdCandidate);
    await handle.writeFile(serializedEnvelope);
    await handle.sync();
    await handle.close();
    handle = null;
    const candidate = await assertExpectedArtifact(fsOps, candidatePath, {
      sha256: envelopeSha256,
      privateMode: true,
    });
    candidateIdentity = recoveryIdentity(candidate);
    candidateComplete = true;
    if (!candidateIdentity) {
      throw atomicOutputError("ATOMIC_OUTPUT_ARTIFACT_CHANGED", `Journal candidate disappeared: ${candidatePath}`);
    }
    await assertRecoveryDirectoryGuard(
      recoveryDirectoryGuard,
      "before_journal_publish",
    );
    await assertExpectedArtifact(fsOps, candidatePath, {
      identity: candidateIdentity,
      sha256: envelopeSha256,
      privateMode: true,
    });
    const currentJournal = await lstatIfPresent(fsOps, journalPath);
    if (recoveryIdentity(currentJournal) !== priorJournalIdentity) {
      throw journalExpectationError(`Transaction journal changed before publication: ${journalPath}`);
    }
    if (
      currentJournal
      && await sha256RegularFile(fsOps, journalPath) !== priorJournalSha256
    ) {
      throw journalExpectationError(`Transaction journal bytes changed before publication: ${journalPath}`);
    }
    await fsOps.rename(candidatePath, journalPath);
    await assertExpectedArtifact(fsOps, journalPath, {
      identity: candidateIdentity,
      sha256: envelopeSha256,
      privateMode: true,
    });
    publishedExpectation = {
      identity: candidateIdentity,
      sha256: envelopeSha256,
    };
    await syncAtomicOutputDirectory(
      fsOps,
      path.dirname(journalPath),
      recoveryDirectoryGuard,
    );
    return publishedExpectation;
  } catch (error) {
    try { await handle?.close(); } catch {}
    if (publishedExpectation !== null) {
      error[JOURNAL_PUBLISHED_EXPECTATION] = publishedExpectation;
    }
    if (error?.[RECOVERY_DIRECTORY_GUARD_FAILURE]) throw error;
    if (created && candidateIdentity) {
      try {
        await removeExpectedArtifact(fsOps, candidatePath, {
          identity: candidateComplete ? candidateIdentity : null,
          stableIdentity: candidateStableIdentity,
          sha256: candidateComplete ? envelopeSha256 : null,
          privateMode: true,
        }, recoveryDirectoryGuard);
      } catch (cleanupError) {
        if (cleanupError?.[RECOVERY_DIRECTORY_GUARD_FAILURE]) throw cleanupError;
        const cleanupFailure = atomicOutputError(
          error?.[JOURNAL_EXPECTATION_FAILURE]
            ? "ATOMIC_OUTPUT_JOURNAL_CHANGED"
            : "ATOMIC_OUTPUT_JOURNAL_CLEANUP_FAILED",
          error?.[JOURNAL_EXPECTATION_FAILURE]
            ? `Transaction journal changed and its candidate could not be cleaned safely: ${candidatePath}`
            : `Failed to clean the transaction journal candidate: ${candidatePath}`,
          error,
          [{ path: candidatePath, error: cleanupError }],
        );
        if (error?.[JOURNAL_EXPECTATION_FAILURE]) {
          cleanupFailure[JOURNAL_EXPECTATION_FAILURE] = true;
        }
        if (error?.[JOURNAL_PUBLISHED_EXPECTATION]) {
          cleanupFailure[JOURNAL_PUBLISHED_EXPECTATION] = error[JOURNAL_PUBLISHED_EXPECTATION];
        }
        throw cleanupFailure;
      }
    }
    throw error;
  }
}
function validateJournalPayload(payload, directoryPath, tokenId) {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    throw atomicOutputError("ATOMIC_OUTPUT_JOURNAL_INVALID", "Transaction journal payload is invalid.");
  }
  if (Object.keys(payload).sort().join(",") !== "entries,schema_version,state,token_id") {
    throw atomicOutputError("ATOMIC_OUTPUT_JOURNAL_INVALID", "Transaction journal payload has unexpected properties.");
  }
  if (![1, 2, PDF_OUTPUT_TRANSACTION_VERSION].includes(payload.schema_version) || payload.token_id !== tokenId) {
    throw atomicOutputError("ATOMIC_OUTPUT_JOURNAL_INVALID", "Transaction journal version or token is invalid.");
  }
  if (!["staging", "prepared", "activating", "committed"].includes(payload.state)) {
    throw atomicOutputError("ATOMIC_OUTPUT_JOURNAL_INVALID", "Transaction journal state is invalid.");
  }
  if (!Array.isArray(payload.entries) || payload.entries.length === 0) {
    throw atomicOutputError("ATOMIC_OUTPUT_JOURNAL_INVALID", "Transaction journal entries are invalid.");
  }
  const targets = new Set();
  payload.entries.forEach((entry, index) => {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
      throw atomicOutputError("ATOMIC_OUTPUT_JOURNAL_INVALID", `Transaction journal entry ${index + 1} is invalid.`);
    }
    const expectedEntryKeys = payload.schema_version >= 3
      ? "initial_identity,initial_sha256,new_sha256,rollback,stage,stage_identity,target"
      : "initial_identity,initial_sha256,new_sha256,rollback,stage,target";
    if (Object.keys(entry).sort().join(",") !== expectedEntryKeys) {
      throw atomicOutputError("ATOMIC_OUTPUT_JOURNAL_INVALID", `Transaction journal entry ${index + 1} has unexpected properties.`);
    }
    if (
      typeof entry.target !== "string" || !entry.target || entry.target !== path.basename(entry.target) ||
      entry.target === "." || entry.target === ".." ||
      portableOutputNameKey(entry.target).startsWith(".pdf-tools-") ||
      targets.has(portableOutputNameKey(entry.target))
    ) {
      throw atomicOutputError("ATOMIC_OUTPUT_JOURNAL_PATH_INVALID", `Transaction target ${index + 1} is invalid.`);
    }
    targets.add(portableOutputNameKey(entry.target));
    const targetPath = path.join(directoryPath, entry.target);
    if (
      entry.stage !== path.basename(atomicSiblingPath(targetPath, tokenId, "stage", index)) ||
      entry.rollback !== path.basename(atomicSiblingPath(targetPath, tokenId, "rollback", index))
    ) {
      throw atomicOutputError("ATOMIC_OUTPUT_JOURNAL_PATH_INVALID", `Transaction artifacts for entry ${index + 1} are invalid.`);
    }
    if (entry.initial_identity !== null && typeof entry.initial_identity !== "string") {
      throw atomicOutputError("ATOMIC_OUTPUT_JOURNAL_INVALID", `Initial identity for entry ${index + 1} is invalid.`);
    }
    if (
      (entry.initial_identity === null && entry.initial_sha256 !== null) ||
      (entry.initial_identity !== null && !/^[a-f0-9]{64}$/.test(entry.initial_sha256 ?? ""))
    ) {
      throw atomicOutputError("ATOMIC_OUTPUT_JOURNAL_INVALID", `Initial digest for entry ${index + 1} is invalid.`);
    }
    if (entry.new_sha256 !== null && !/^[a-f0-9]{64}$/.test(entry.new_sha256)) {
      throw atomicOutputError("ATOMIC_OUTPUT_JOURNAL_INVALID", `Output digest for entry ${index + 1} is invalid.`);
    }
    if (payload.state !== "staging" && entry.new_sha256 === null) {
      throw atomicOutputError("ATOMIC_OUTPUT_JOURNAL_INVALID", `Prepared entry ${index + 1} has no output digest.`);
    }
    if (
      payload.schema_version >= 3
      && (
        (entry.stage_identity !== null && typeof entry.stage_identity !== "string")
        || ((entry.new_sha256 === null) !== (entry.stage_identity === null))
        || (payload.state !== "staging" && entry.stage_identity === null)
      )
    ) {
      throw atomicOutputError("ATOMIC_OUTPUT_JOURNAL_INVALID", `Stage identity for entry ${index + 1} is invalid.`);
    }
  });
  return payload;
}
async function readAtomicJournal(fsOps, journalPath) {
  const match = path.basename(journalPath).match(PDF_OUTPUT_JOURNAL_PATTERN);
  if (!match) {
    throw atomicOutputError("ATOMIC_OUTPUT_JOURNAL_PATH_INVALID", `Transaction journal name is invalid: ${journalPath}`);
  }
  const { value: raw, stat } = await consumeVerifiedRegularFile(
    fsOps,
    journalPath,
    {
      privateMode: true,
      changedCode: "ATOMIC_OUTPUT_JOURNAL_CHANGED",
      changedMessage: `Transaction journal changed while it was read: ${journalPath}`,
    },
    async handle => await handle.readFile("utf8"),
  );
  let envelope;
  try {
    envelope = JSON.parse(raw);
  } catch (error) {
    throw atomicOutputError("ATOMIC_OUTPUT_JOURNAL_INVALID", `Transaction journal is not valid JSON: ${journalPath}`, error);
  }
  if (!envelope || typeof envelope !== "object" || Array.isArray(envelope)) {
    throw atomicOutputError("ATOMIC_OUTPUT_JOURNAL_INVALID", `Transaction journal envelope is invalid: ${journalPath}`);
  }
  if (Object.keys(envelope).sort().join(",") !== "payload,payload_sha256") {
    throw atomicOutputError("ATOMIC_OUTPUT_JOURNAL_INVALID", `Transaction journal envelope has unexpected properties: ${journalPath}`);
  }
  const serializedPayload = JSON.stringify(envelope.payload);
  if (envelope.payload_sha256 !== sha256Value(Buffer.from(serializedPayload))) {
    throw atomicOutputError("ATOMIC_OUTPUT_JOURNAL_DIGEST_INVALID", `Transaction journal digest is invalid: ${journalPath}`);
  }
  return {
    payload: validateJournalPayload(envelope.payload, path.dirname(journalPath), match[1]),
    identity: recoveryIdentity(stat),
    sha256: sha256Value(Buffer.from(raw)),
  };
}
async function assertExpectedArtifact(fsOps, artifactPath, {
  sha256 = null,
  identity = null,
  stableIdentity = null,
  privateMode = false,
} = {}) {
  const stat = await lstatIfPresent(fsOps, artifactPath);
  if (!stat) return null;
  assertOwnedRegularArtifact(artifactPath, stat, { privateMode });
  if (identity !== null && recoveryIdentity(stat) !== identity) {
    throw atomicOutputError("ATOMIC_OUTPUT_RECOVERY_CONFLICT", `Transaction artifact identity is ambiguous: ${artifactPath}`);
  }
  if (stableIdentity !== null && lockDirectoryIdentity(stat) !== stableIdentity) {
    throw atomicOutputError("ATOMIC_OUTPUT_RECOVERY_CONFLICT", `Transaction artifact stable identity is ambiguous: ${artifactPath}`);
  }
  if (sha256 !== null && await sha256RegularFile(fsOps, artifactPath) !== sha256) {
    throw atomicOutputError("ATOMIC_OUTPUT_RECOVERY_CONFLICT", `Transaction artifact digest is ambiguous: ${artifactPath}`);
  }
  return stat;
}
async function removeExpectedArtifact(
  fsOps,
  artifactPath,
  expectations = {},
  recoveryDirectoryGuard = null,
) {
  await assertRecoveryDirectoryGuard(recoveryDirectoryGuard, "before_artifact_inspection");
  if (!await assertExpectedArtifact(fsOps, artifactPath, expectations)) return;
  await assertRecoveryDirectoryGuard(recoveryDirectoryGuard, "before_artifact_removal");
  const cleanupErrors = [];
  await removeAtomicArtifact(fsOps, artifactPath, cleanupErrors, {
    recoveryDirectoryGuard,
    verifyBeforeUnlink: async () => {
      await assertRecoveryDirectoryGuard(
        recoveryDirectoryGuard,
        "before_artifact_retry_inspection",
      );
      return Boolean(await assertExpectedArtifact(fsOps, artifactPath, expectations));
    },
  });
  if (cleanupErrors.length > 0) {
    throw atomicOutputError(
      "ATOMIC_OUTPUT_RECOVERY_CLEANUP_FAILED",
      `Failed to remove transaction artifact: ${artifactPath}`,
      null,
      cleanupErrors,
    );
  }
}
async function recoverAtomicJournal(
  fsOps,
  journalPath,
  recoveryDirectoryGuard = null,
  expectedJournal = null,
) {
  await assertRecoveryDirectoryGuard(recoveryDirectoryGuard, "before_journal_read");
  const journal = await readAtomicJournal(fsOps, journalPath);
  if (
    expectedJournal !== null
    && (
      journal.identity !== expectedJournal.identity
      || journal.sha256 !== expectedJournal.sha256
    )
  ) {
    throw journalExpectationError(
      `Transaction-owned recovery journal did not match its last published state: ${journalPath}`,
    );
  }
  const payload = journal.payload;
  const directoryPath = path.dirname(journalPath);
  const entries = payload.entries.map(entry => ({
    ...entry,
    targetPath: path.join(directoryPath, entry.target),
    stagePath: path.join(directoryPath, entry.stage),
    rollbackPath: path.join(directoryPath, entry.rollback),
  }));
  if (payload.state === "staging" || payload.state === "prepared") {
    for (const entry of entries) {
      if (await lstatIfPresent(fsOps, entry.rollbackPath)) {
        throw atomicOutputError("ATOMIC_OUTPUT_RECOVERY_CONFLICT", `Rollback exists before activation: ${entry.rollbackPath}`);
      }
      if (entry.new_sha256 === null) {
        if (await lstatIfPresent(fsOps, entry.stagePath)) {
          throw atomicOutputError("ATOMIC_OUTPUT_RECOVERY_CONFLICT", `Unrecorded staged output exists: ${entry.stagePath}`);
        }
        continue;
      }
      await removeExpectedArtifact(fsOps, entry.stagePath, {
        identity: payload.schema_version >= 3 ? entry.stage_identity : null,
        sha256: entry.new_sha256,
        privateMode: true,
      }, recoveryDirectoryGuard);
    }
  } else if (payload.state === "activating") {
    for (const entry of [...entries].reverse()) {
      const stage = await assertExpectedArtifact(fsOps, entry.stagePath, {
        identity: payload.schema_version >= 3 ? entry.stage_identity : null,
        sha256: entry.new_sha256,
        privateMode: true,
      });
      const rollback = await assertExpectedArtifact(fsOps, entry.rollbackPath, {
        identity: entry.initial_identity,
        sha256: entry.initial_sha256,
      });
      const target = await lstatIfPresent(fsOps, entry.targetPath);
      if (target) assertAtomicOutputTarget(entry.targetPath, target);
      const stageIdentity = stage ? recoveryIdentity(stage) : null;
      const targetOwnedByTransaction = target && (
        await sha256RegularFile(fsOps, entry.targetPath) === entry.new_sha256
        && (stageIdentity !== null
          ? recoveryIdentity(target) === stageIdentity
          : payload.schema_version === 1)
      );
      if (entry.initial_identity !== null) {
        if (
          payload.schema_version >= 2
          && !stage
          && !rollback
          && target
          && recoveryIdentity(target) === entry.initial_identity
          && await sha256RegularFile(fsOps, entry.targetPath) === entry.initial_sha256
        ) {
          continue;
        }
        if (payload.schema_version >= 2 && !stage) {
          throw atomicOutputError("ATOMIC_OUTPUT_RECOVERY_CONFLICT", `Staged output identity is missing: ${entry.stagePath}`);
        }
        if (rollback) {
          if (target) {
            if (!targetOwnedByTransaction) {
              throw atomicOutputError("ATOMIC_OUTPUT_RECOVERY_CONFLICT", `Activated output is ambiguous: ${entry.targetPath}`);
            }
            await removeExpectedArtifact(fsOps, entry.targetPath, {
              identity: stageIdentity,
              sha256: entry.new_sha256,
            }, recoveryDirectoryGuard);
          }
          const rollbackBeforeRestore = await assertExpectedArtifact(fsOps, entry.rollbackPath, {
            identity: entry.initial_identity,
            sha256: entry.initial_sha256,
          });
          if (!rollbackBeforeRestore) {
            throw atomicOutputError(
              "ATOMIC_OUTPUT_RECOVERY_CONFLICT",
              `Rollback disappeared before restoration: ${entry.rollbackPath}`,
            );
          }
          if (await lstatIfPresent(fsOps, entry.targetPath)) {
            throw atomicOutputError(
              "ATOMIC_OUTPUT_RECOVERY_CONFLICT",
              `Target reappeared before rollback restoration: ${entry.targetPath}`,
            );
          }
          await assertRecoveryDirectoryGuard(recoveryDirectoryGuard, "before_rollback_restore");
          await fsOps.rename(entry.rollbackPath, entry.targetPath);
          if (!await assertExpectedArtifact(fsOps, entry.targetPath, {
            identity: entry.initial_identity,
            sha256: entry.initial_sha256,
          })) {
            throw atomicOutputError(
              "ATOMIC_OUTPUT_RECOVERY_CONFLICT",
              `Restored output disappeared after rollback rename: ${entry.targetPath}`,
            );
          }
        } else {
          if (!target || recoveryIdentity(target) !== entry.initial_identity) {
            throw atomicOutputError("ATOMIC_OUTPUT_RECOVERY_CONFLICT", `Original output cannot be restored unambiguously: ${entry.targetPath}`);
          }
          if (await sha256RegularFile(fsOps, entry.targetPath) !== entry.initial_sha256) {
            throw atomicOutputError("ATOMIC_OUTPUT_RECOVERY_CONFLICT", `Original output digest is ambiguous: ${entry.targetPath}`);
          }
        }
      } else {
        if (payload.schema_version >= 2 && !stage && !rollback && !target) {
          continue;
        }
        if (payload.schema_version >= 2 && !stage) {
          throw atomicOutputError("ATOMIC_OUTPUT_RECOVERY_CONFLICT", `Staged output identity is missing: ${entry.stagePath}`);
        }
        if (rollback) {
          throw atomicOutputError("ATOMIC_OUTPUT_RECOVERY_CONFLICT", `Unexpected rollback exists for a new output: ${entry.rollbackPath}`);
        }
        if (targetOwnedByTransaction) {
          await removeExpectedArtifact(fsOps, entry.targetPath, {
            identity: stageIdentity,
            sha256: entry.new_sha256,
          }, recoveryDirectoryGuard);
        }
      }
      await removeExpectedArtifact(fsOps, entry.stagePath, {
        identity: payload.schema_version >= 3 ? entry.stage_identity : stageIdentity,
        sha256: entry.new_sha256,
        privateMode: true,
      }, recoveryDirectoryGuard);
    }
  } else {
    for (const entry of entries) {
      if (!await assertExpectedArtifact(fsOps, entry.targetPath, {
        identity: payload.schema_version >= 3 ? entry.stage_identity : null,
        sha256: entry.new_sha256,
      })) {
        throw atomicOutputError("ATOMIC_OUTPUT_RECOVERY_CONFLICT", `Committed output is missing: ${entry.targetPath}`);
      }
      await removeExpectedArtifact(fsOps, entry.stagePath, {
        identity: payload.schema_version >= 3 ? entry.stage_identity : null,
        sha256: entry.new_sha256,
        privateMode: true,
      }, recoveryDirectoryGuard);
      if (entry.initial_identity === null) {
        if (await lstatIfPresent(fsOps, entry.rollbackPath)) {
          throw atomicOutputError("ATOMIC_OUTPUT_RECOVERY_CONFLICT", `Unexpected rollback exists for a committed new output: ${entry.rollbackPath}`);
        }
      } else {
        await removeExpectedArtifact(fsOps, entry.rollbackPath, {
          identity: entry.initial_identity,
          sha256: entry.initial_sha256,
        }, recoveryDirectoryGuard);
      }
    }
  }
  await assertRecoveryDirectoryGuard(recoveryDirectoryGuard, "before_recovery_directory_sync");
  await syncAtomicOutputDirectory(fsOps, directoryPath, recoveryDirectoryGuard);
  await removeExpectedArtifact(
    fsOps,
    journalPath,
    {
      identity: journal.identity,
      sha256: journal.sha256,
      privateMode: true,
    },
    recoveryDirectoryGuard,
  );
  await assertRecoveryDirectoryGuard(recoveryDirectoryGuard, "before_final_recovery_directory_sync");
  await syncAtomicOutputDirectory(fsOps, directoryPath, recoveryDirectoryGuard);
  return { journal_path: journalPath, recovered_state: payload.state };
}
async function recoverPdfOutputTransactionsUnlocked(directoryPath, {
  fsOps = fs,
  resolveDirectory = true,
  recoveryDirectoryGuard = null,
} = {}) {
  const resolvedDirectory = resolveDirectory ? path.resolve(directoryPath) : directoryPath;
  await assertRecoveryDirectoryGuard(recoveryDirectoryGuard, "before_unlocked_recovery_entry");
  const directoryStat = await fsOps.lstat(resolvedDirectory);
  if (!directoryStat.isDirectory() || directoryStat.isSymbolicLink()) {
    throw atomicOutputError("ATOMIC_OUTPUT_DIRECTORY_INVALID", `Output transaction directory is invalid: ${resolvedDirectory}`);
  }
  await assertRecoveryDirectoryGuard(recoveryDirectoryGuard, "before_recovery_directory_listing");
  const names = await fsOps.readdir(resolvedDirectory);
  const journals = names.filter(name => PDF_OUTPUT_JOURNAL_PATTERN.test(name)).sort();
  const recovered = [];
  for (const name of journals) {
    recovered.push(await recoverAtomicJournal(
      fsOps,
      path.join(resolvedDirectory, name),
      recoveryDirectoryGuard,
    ));
  }
  for (const name of names.filter(name => PDF_OUTPUT_JOURNAL_CANDIDATE_PATTERN.test(name)).sort()) {
    await removeExpectedArtifact(
      fsOps,
      path.join(resolvedDirectory, name),
      { privateMode: true },
      recoveryDirectoryGuard,
    );
  }
  for (const name of names.filter(name => PDF_OUTPUT_STALE_LOCK_PATTERN.test(name)).sort()) {
    await removeOutputLockDirectory(fsOps, path.join(resolvedDirectory, name), {
      allowPartial: true,
      recoveryDirectoryGuard,
    });
  }
  for (const name of names.filter(name => PDF_OUTPUT_LOCK_CANDIDATE_PATTERN.test(name)).sort()) {
    const pid = Number(name.match(PDF_OUTPUT_LOCK_CANDIDATE_PATTERN)[1]);
    if (!processAppearsAlive(pid)) {
      await removeOutputLockDirectory(fsOps, path.join(resolvedDirectory, name), {
        allowPartial: true,
        recoveryDirectoryGuard,
      });
    }
  }
  return recovered;
}
export async function recoverPdfOutputTransactions(directoryPath, {
  fsOps = fs,
  recoveryDirectoryBinding = null,
  assertRecoveryDirectoryBinding = null,
  assertPathAllowed = async () => {},
  beforeDirectoryGuard = async () => {},
} = {}) {
  if (
    typeof assertPathAllowed !== "function"
    || typeof beforeDirectoryGuard !== "function"
  ) {
    throw new TypeError("Recovery directory guards must be functions.");
  }
  let resolvedDirectory = path.resolve(directoryPath);
  if ((recoveryDirectoryBinding === null) !== (assertRecoveryDirectoryBinding === null)) {
    throw new TypeError("Recovery directory binding and assertion must be provided together.");
  }
  if (
    recoveryDirectoryBinding
    && (
      typeof recoveryDirectoryBinding.canonicalPath !== "string"
      || path.resolve(recoveryDirectoryBinding.canonicalPath) !== resolvedDirectory
      || typeof assertRecoveryDirectoryBinding !== "function"
    )
  ) {
    throw new TypeError("Recovery directory binding must identify the requested canonical directory.");
  }
  let recoveryDirectoryGuard;
  if (recoveryDirectoryBinding) {
    recoveryDirectoryGuard = async phase => {
      await beforeDirectoryGuard(phase);
      await assertRecoveryDirectoryBinding(recoveryDirectoryBinding, phase);
    };
    recoveryDirectoryGuard.fileIdentity = recoveryDirectoryBinding.fileIdentity;
  } else {
    const outputDirectoryBinding = await bindAtomicOutputDirectory(
      resolvedDirectory,
      assertPathAllowed,
      fsOps,
    );
    resolvedDirectory = outputDirectoryBinding.canonicalPath;
    recoveryDirectoryGuard = async phase => {
      await beforeDirectoryGuard(phase);
      await assertAtomicOutputDirectory(outputDirectoryBinding, assertPathAllowed, fsOps);
    };
    recoveryDirectoryGuard.fileIdentity = outputDirectoryBinding.fileIdentity;
  }
  await assertRecoveryDirectoryGuard(recoveryDirectoryGuard, "recovery_entry");
  const directoryStat = await fsOps.lstat(resolvedDirectory);
  if (!directoryStat.isDirectory() || directoryStat.isSymbolicLink()) {
    throw atomicOutputError("ATOMIC_OUTPUT_DIRECTORY_INVALID", `Output transaction directory is invalid: ${resolvedDirectory}`);
  }
  await assertRecoveryDirectoryGuard(recoveryDirectoryGuard, "before_initial_recovery_directory_listing");
  const names = await fsOps.readdir(resolvedDirectory);
  const needsRecovery = names.some(name => (
    name === PDF_OUTPUT_LOCK_NAME || PDF_OUTPUT_JOURNAL_PATTERN.test(name) ||
    PDF_OUTPUT_JOURNAL_CANDIDATE_PATTERN.test(name) ||
    PDF_OUTPUT_LOCK_CANDIDATE_PATTERN.test(name) || PDF_OUTPUT_STALE_LOCK_PATTERN.test(name)
  ));
  if (!needsRecovery) return [];
  const release = await acquireAtomicOutputDirectoryLock(fsOps, resolvedDirectory, {
    recoveryDirectoryGuard,
  });
  try {
    await assertRecoveryDirectoryGuard(recoveryDirectoryGuard, "after_lock_acquired");
    return await recoverPdfOutputTransactionsUnlocked(resolvedDirectory, {
      fsOps,
      recoveryDirectoryGuard,
    });
  } finally {
    await release();
  }
}
async function stageAtomicOutput(
  fsOps,
  targetPath,
  bytes,
  tokenId,
  index,
  recoveryDirectoryGuard = null,
) {
  const stagePath = atomicSiblingPath(targetPath, tokenId, "stage", index);
  let handle = null;
  let created = false;
  let stageIdentity = null;
  let stageStableIdentity = null;
  let stageComplete = false;
  try {
    await assertRecoveryDirectoryGuard(
      recoveryDirectoryGuard,
      `before_stage_${index}_create`,
    );
    handle = await fsOps.open(stagePath, "wx", 0o600);
    created = true;
    const createdStage = await lstatIfPresent(fsOps, stagePath);
    assertOwnedRegularArtifact(stagePath, createdStage, { privateMode: true });
    stageStableIdentity = lockDirectoryIdentity(createdStage);
    await handle.writeFile(bytes);
    await handle.sync();
    await handle.close();
    handle = null;
    await assertRecoveryDirectoryGuard(
      recoveryDirectoryGuard,
      `before_stage_${index}_identity_capture`,
    );
    const stage = await assertExpectedArtifact(fsOps, stagePath, {
      sha256: sha256Value(bytes),
      privateMode: true,
    });
    if (!stage) {
      throw atomicOutputError("ATOMIC_OUTPUT_ARTIFACT_CHANGED", `Staged output disappeared: ${stagePath}`);
    }
    if (lockDirectoryIdentity(stage) !== stageStableIdentity) {
      throw atomicOutputError("ATOMIC_OUTPUT_ARTIFACT_CHANGED", `Staged output identity changed: ${stagePath}`);
    }
    stageComplete = true;
    return {
      path: stagePath,
      identity: recoveryIdentity(stage),
    };
  } catch (error) {
    try { await handle?.close(); } catch {}
    if (error?.[RECOVERY_DIRECTORY_GUARD_FAILURE]) throw error;
    const cleanupErrors = [];
    if (created) {
      await removeExpectedArtifact(fsOps, stagePath, {
        stableIdentity: stageStableIdentity,
        sha256: stageComplete ? sha256Value(bytes) : null,
        privateMode: true,
      }, recoveryDirectoryGuard);
    }
    if (cleanupErrors.length > 0) {
      throw atomicOutputError(
        "ATOMIC_OUTPUT_CLEANUP_FAILED",
        `Failed to clean the staged PDF output for ${targetPath}`,
        error,
        cleanupErrors,
      );
    }
    throw error;
  }
}

export function outputIdentity(stat, platform = process.platform) {
  if (!stat) return null;
  return [
    portableFilesystemDevice(stat, platform),
    stat.ino,
    stat.mode,
    stat.size,
    stat.mtimeMs,
    stat.ctimeMs,
  ].join(":");
}

async function lstatIfPresent(fsOps, targetPath) {
  try {
    return await fsOps.lstat(targetPath);
  } catch (error) {
    if (error?.code === "ENOENT") return null;
    throw error;
  }
}
function processAppearsAlive(pid) {
  if (!Number.isSafeInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    if (error?.code === "ESRCH") return false;
    return true;
  }
}
async function readPrivateJsonArtifact(fsOps, artifactPath) {
  const { value: raw, stat } = await consumeVerifiedRegularFile(
    fsOps,
    artifactPath,
    {
      privateMode: true,
      changedMessage: `Private transaction artifact changed while it was read: ${artifactPath}`,
      missingError: () => {
        const error = new Error(`Private transaction artifact disappeared: ${artifactPath}`);
        error.code = "ENOENT";
        return error;
      },
    },
    async handle => await handle.readFile("utf8"),
  );
  try {
    return {
      value: JSON.parse(raw),
      identity: recoveryIdentity(stat),
      sha256: sha256Value(Buffer.from(raw)),
    };
  } catch (error) {
    throw atomicOutputError("ATOMIC_OUTPUT_ARTIFACT_INVALID", `Private transaction artifact is not valid JSON: ${artifactPath}`, error);
  }
}
function assertOwnedPrivateDirectory(directoryPath, stat) {
  if (!stat?.isDirectory() || stat.isSymbolicLink()) {
    throw atomicOutputError("ATOMIC_OUTPUT_LOCK_INVALID", `Output transaction lock is not a directory: ${directoryPath}`);
  }
  if (
    process.platform !== "win32" && typeof process.getuid === "function" &&
    (stat.uid !== process.getuid() || (stat.mode & 0o077) !== 0)
  ) {
    throw atomicOutputError("ATOMIC_OUTPUT_LOCK_INVALID", `Output transaction lock directory is not private and owned: ${directoryPath}`);
  }
}
async function readOutputLockDirectory(fsOps, lockPath) {
  const before = await lstatIfPresent(fsOps, lockPath);
  if (!before) {
    const error = new Error(`Output transaction lock disappeared: ${lockPath}`);
    error.code = "ENOENT";
    throw error;
  }
  assertOwnedPrivateDirectory(lockPath, before);
  const names = await fsOps.readdir(lockPath);
  if (names.length === 0) {
    const error = new Error(`Output transaction lock is being released: ${lockPath}`);
    error.code = "ENOENT";
    throw error;
  }
  if (names.length !== 1 || names[0] !== PDF_OUTPUT_LOCK_OWNER_NAME) {
    throw atomicOutputError("ATOMIC_OUTPUT_LOCK_INVALID", `Output transaction lock directory has unexpected contents: ${lockPath}`);
  }
  const ownerPath = path.join(lockPath, PDF_OUTPUT_LOCK_OWNER_NAME);
  const ownerArtifact = await readPrivateJsonArtifact(fsOps, ownerPath);
  const after = await lstatIfPresent(fsOps, lockPath);
  if (lockDirectoryIdentity(after) !== lockDirectoryIdentity(before)) {
    throw atomicOutputError("ATOMIC_OUTPUT_LOCK_CHANGED", `Output transaction lock changed while it was read: ${lockPath}`);
  }
  return {
    value: ownerArtifact.value,
    identity: lockDirectoryIdentity(before),
    ownerIdentity: ownerArtifact.identity,
    ownerSha256: ownerArtifact.sha256,
  };
}
async function removeOutputLockDirectory(fsOps, lockPath, {
  identity = null,
  ownerStableIdentity = null,
  ownerIdentity = null,
  ownerSha256 = null,
  allowPartial = false,
  recoveryDirectoryGuard = null,
} = {}) {
  await assertRecoveryDirectoryGuard(recoveryDirectoryGuard, "before_lock_inspection");
  const stat = await lstatIfPresent(fsOps, lockPath);
  if (!stat) return;
  assertOwnedPrivateDirectory(lockPath, stat);
  if (identity !== null && lockDirectoryIdentity(stat) !== identity) {
    throw atomicOutputError("ATOMIC_OUTPUT_LOCK_CHANGED", `Output transaction lock changed unexpectedly: ${lockPath}`);
  }
  const expectedLockIdentity = identity ?? lockDirectoryIdentity(stat);
  const lockDirectoryGuard = async phase => {
    await assertRecoveryDirectoryGuard(recoveryDirectoryGuard, phase);
    const current = await lstatIfPresent(fsOps, lockPath);
    if (lockDirectoryIdentity(current) !== expectedLockIdentity) {
      throw atomicOutputError("ATOMIC_OUTPUT_LOCK_CHANGED", `Output transaction lock changed around owner cleanup: ${lockPath}`);
    }
  };
  const names = await fsOps.readdir(lockPath);
  if (names.some(name => name !== PDF_OUTPUT_LOCK_OWNER_NAME) || (!allowPartial && names.length !== 1)) {
    throw atomicOutputError("ATOMIC_OUTPUT_LOCK_INVALID", `Output transaction lock directory has unexpected contents: ${lockPath}`);
  }
  if (names.includes(PDF_OUTPUT_LOCK_OWNER_NAME)) {
    await assertRecoveryDirectoryGuard(
      recoveryDirectoryGuard,
      "before_lock_owner_cleanup",
    );
    const lockBeforeOwnerCleanup = await lstatIfPresent(fsOps, lockPath);
    if (lockDirectoryIdentity(lockBeforeOwnerCleanup) !== expectedLockIdentity) {
      throw atomicOutputError("ATOMIC_OUTPUT_LOCK_CHANGED", `Output transaction lock changed before owner cleanup: ${lockPath}`);
    }
    await removeExpectedArtifact(fsOps, path.join(lockPath, PDF_OUTPUT_LOCK_OWNER_NAME), {
      stableIdentity: ownerStableIdentity,
      identity: ownerIdentity,
      sha256: ownerSha256,
      privateMode: true,
    }, lockDirectoryGuard);
  }
  const beforeRemoval = await lstatIfPresent(fsOps, lockPath);
  if (
    !beforeRemoval?.isDirectory()
    || beforeRemoval.isSymbolicLink()
    || beforeRemoval.dev !== stat.dev
    || beforeRemoval.ino !== stat.ino
  ) {
    throw atomicOutputError(
      "ATOMIC_OUTPUT_LOCK_CHANGED",
      `Output transaction lock changed before removal: ${lockPath}`,
    );
  }
  await assertRecoveryDirectoryGuard(recoveryDirectoryGuard, "before_lock_directory_removal");
  await fsOps.rmdir(lockPath);
}
async function acquireAtomicOutputDirectoryLock(fsOps, directoryPath, {
  recoveryDirectoryGuard = null,
} = {}) {
  const lockPath = path.join(directoryPath, PDF_OUTPUT_LOCK_NAME);
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const token = randomUUID();
    const candidatePath = `${lockPath}.candidate-${process.pid}-${token}`;
    const candidateOwnerPath = path.join(candidatePath, PDF_OUTPUT_LOCK_OWNER_NAME);
    let handle = null;
    let candidateCreated = false;
    let published = false;
    let candidateIdentity = null;
    let candidateFileIdentity = null;
    let candidateOwnerCreated = false;
    let candidateOwnerStableIdentity = null;
    let candidateOwnerIdentity = null;
    let candidateOwnerSha256 = null;
    let candidateOwnerComplete = false;
    let publishedArtifact = null;
    try {
      await assertRecoveryDirectoryGuard(recoveryDirectoryGuard, "before_lock_candidate_create");
      await fsOps.mkdir(candidatePath, { mode: 0o700 });
      candidateCreated = true;
      const candidate = await lstatIfPresent(fsOps, candidatePath);
      assertOwnedPrivateDirectory(candidatePath, candidate);
      candidateIdentity = lockDirectoryIdentity(candidate);
      candidateFileIdentity = stableDirectoryIdentity(candidate);
      await assertRecoveryDirectoryGuard(recoveryDirectoryGuard, "before_lock_owner_create");
      const candidateBeforeOwner = await lstatIfPresent(fsOps, candidatePath);
      if (lockDirectoryIdentity(candidateBeforeOwner) !== candidateIdentity) {
        throw atomicOutputError("ATOMIC_OUTPUT_LOCK_CHANGED", `Output lock candidate changed before owner creation: ${candidatePath}`);
      }
      const owner = {
        schema_version: 1,
        pid: process.pid,
        token,
        created_at: new Date().toISOString(),
      };
      const ownerBytes = `${JSON.stringify(owner)}\n`;
      const ownerSha256 = sha256Value(Buffer.from(ownerBytes));
      handle = await fsOps.open(candidateOwnerPath, "wx", 0o600);
      candidateOwnerCreated = true;
      const openedOwnerStats = await handle.stat();
      candidateOwnerStableIdentity = lockDirectoryIdentity(openedOwnerStats);
      const ownerPathStats = await lstatIfPresent(fsOps, candidateOwnerPath);
      assertOwnedRegularArtifact(candidateOwnerPath, ownerPathStats, { privateMode: true });
      if (lockDirectoryIdentity(ownerPathStats) !== candidateOwnerStableIdentity) {
        throw atomicOutputError(
          "ATOMIC_OUTPUT_LOCK_CHANGED",
          `Output lock owner changed after creation: ${candidateOwnerPath}`,
        );
      }
      await handle.writeFile(ownerBytes);
      await handle.sync();
      const ownerDescriptorIdentity = recoveryIdentity(await handle.stat());
      candidateOwnerIdentity = ownerDescriptorIdentity;
      candidateOwnerSha256 = ownerSha256;
      candidateOwnerComplete = true;
      await handle.close();
      handle = null;
      await assertRecoveryDirectoryGuard(
        recoveryDirectoryGuard,
        "after_lock_owner_close",
      );
      const candidateArtifact = await readOutputLockDirectory(fsOps, candidatePath);
      if (
        candidateArtifact.identity !== candidateIdentity
        || candidateArtifact.ownerIdentity !== ownerDescriptorIdentity
        || candidateArtifact.ownerSha256 !== ownerSha256
        || JSON.stringify(candidateArtifact.value) !== JSON.stringify(owner)
      ) {
        throw atomicOutputError("ATOMIC_OUTPUT_LOCK_CHANGED", `Output lock candidate changed before publication: ${candidatePath}`);
      }
      await syncAtomicOutputDirectory(
        fsOps,
        candidatePath,
        recoveryDirectoryGuard,
        candidateFileIdentity,
      );
      await assertRecoveryDirectoryGuard(recoveryDirectoryGuard, "before_lock_publish");
      const candidateBeforePublish = await readOutputLockDirectory(fsOps, candidatePath);
      if (
        candidateBeforePublish.identity !== candidateIdentity
        || candidateBeforePublish.ownerIdentity !== candidateOwnerIdentity
        || candidateBeforePublish.ownerSha256 !== candidateOwnerSha256
        || JSON.stringify(candidateBeforePublish.value) !== JSON.stringify(owner)
      ) {
        throw atomicOutputError("ATOMIC_OUTPUT_LOCK_CHANGED", `Output lock candidate changed at publication: ${candidatePath}`);
      }
      if (await lstatIfPresent(fsOps, lockPath)) {
        const error = new Error(`Output transaction lock already exists: ${lockPath}`);
        error.code = "EEXIST";
        throw error;
      }
      await fsOps.rename(candidatePath, lockPath);
      published = true;
      const lockArtifact = await readOutputLockDirectory(fsOps, lockPath);
      if (
        lockArtifact.identity !== candidateIdentity
        || lockArtifact.ownerIdentity !== candidateOwnerIdentity
        || lockArtifact.ownerSha256 !== candidateOwnerSha256
        || JSON.stringify(lockArtifact.value) !== JSON.stringify(owner)
      ) {
        throw atomicOutputError("ATOMIC_OUTPUT_LOCK_CHANGED", `Published output lock identity changed: ${lockPath}`);
      }
      publishedArtifact = lockArtifact;
      await syncAtomicOutputDirectory(fsOps, directoryPath, recoveryDirectoryGuard);
      return async () => {
        await assertRecoveryDirectoryGuard(recoveryDirectoryGuard, "before_lock_release");
        await removeOutputLockDirectory(fsOps, lockPath, {
          identity: lockArtifact.identity,
          ownerIdentity: lockArtifact.ownerIdentity,
          ownerSha256: lockArtifact.ownerSha256,
          recoveryDirectoryGuard,
        });
        await assertRecoveryDirectoryGuard(recoveryDirectoryGuard, "before_lock_release_sync");
        await syncAtomicOutputDirectory(fsOps, directoryPath, recoveryDirectoryGuard);
      };
    } catch (error) {
      try { await handle?.close(); } catch {}
      if (error?.[RECOVERY_DIRECTORY_GUARD_FAILURE]) throw error;
      if (candidateCreated) {
        try {
          if (candidateOwnerCreated && candidateOwnerStableIdentity === null) {
            throw atomicOutputError(
              "ATOMIC_OUTPUT_LOCK_CHANGED",
              `Output lock owner identity could not be captured safely: ${candidateOwnerPath}`,
            );
          }
          await removeOutputLockDirectory(fsOps, candidatePath, {
            identity: candidateIdentity,
            ownerStableIdentity: candidateOwnerStableIdentity,
            ownerIdentity: candidateOwnerComplete ? candidateOwnerIdentity : null,
            ownerSha256: candidateOwnerComplete ? candidateOwnerSha256 : null,
            allowPartial: true,
            recoveryDirectoryGuard,
          });
        } catch (cleanupError) {
          if (cleanupError?.[RECOVERY_DIRECTORY_GUARD_FAILURE]) throw cleanupError;
          throw atomicOutputError(
            "ATOMIC_OUTPUT_LOCK_CLEANUP_FAILED",
            `Failed to clean an output transaction lock candidate: ${candidatePath}`,
            error,
            [{ path: candidatePath, error: cleanupError }],
          );
        }
      }
      if (published) {
        await removeOutputLockDirectory(fsOps, lockPath, {
          identity: publishedArtifact?.identity ?? candidateIdentity,
          ownerIdentity: publishedArtifact?.ownerIdentity ?? candidateOwnerIdentity,
          ownerSha256: publishedArtifact?.ownerSha256 ?? candidateOwnerSha256,
          allowPartial: true,
          recoveryDirectoryGuard,
        });
      }
      if (!new Set(["EEXIST", "ENOTEMPTY"]).has(error?.code)) throw error;
      let lockArtifact;
      try {
        lockArtifact = await readOutputLockDirectory(fsOps, lockPath);
      } catch (readError) {
        if (readError?.code === "ENOENT") {
          await new Promise(resolve => setTimeout(resolve, 1));
          continue;
        }
        if (new Set(["ATOMIC_OUTPUT_ARTIFACT_CHANGED", "ATOMIC_OUTPUT_LOCK_CHANGED"]).has(readError?.code)) {
          await new Promise(resolve => setTimeout(resolve, 1));
          continue;
        }
        throw readError;
      }
      const { value: lock } = lockArtifact;
      if (
        !lock || lock.schema_version !== 1 || !Number.isSafeInteger(lock.pid) ||
        lock.pid <= 0 || typeof lock.token !== "string" || !lock.token ||
        typeof lock.created_at !== "string" ||
        Object.keys(lock).sort().join(",") !== "created_at,pid,schema_version,token"
      ) {
        throw atomicOutputError("ATOMIC_OUTPUT_LOCK_INVALID", `Output transaction lock is invalid: ${lockPath}`);
      }
      if (processAppearsAlive(lock.pid)) {
        throw atomicOutputError("ATOMIC_OUTPUT_CONCURRENT", `Another process is committing PDF outputs in: ${directoryPath}`);
      }
      const stalePath = `${lockPath}.stale-${randomUUID()}`;
      try {
        await assertRecoveryDirectoryGuard(recoveryDirectoryGuard, "before_stale_lock_rename");
        const lockBeforeRename = await lstatIfPresent(fsOps, lockPath);
        if (lockDirectoryIdentity(lockBeforeRename) !== lockArtifact.identity) {
          throw atomicOutputError(
            "ATOMIC_OUTPUT_LOCK_CHANGED",
            `Output transaction lock changed before stale rename: ${lockPath}`,
          );
        }
        await assertRecoveryDirectoryGuard(recoveryDirectoryGuard, "before_stale_lock_rename_commit");
        await fsOps.rename(lockPath, stalePath);
      } catch (renameError) {
        if (renameError?.code === "ENOENT") continue;
        throw renameError;
      }
      await removeOutputLockDirectory(fsOps, stalePath, {
        identity: lockArtifact.identity,
        ownerIdentity: lockArtifact.ownerIdentity,
        ownerSha256: lockArtifact.ownerSha256,
        recoveryDirectoryGuard,
      });
      await syncAtomicOutputDirectory(fsOps, directoryPath, recoveryDirectoryGuard);
    }
  }
  throw atomicOutputError("ATOMIC_OUTPUT_LOCK_FAILED", `Could not establish output transaction lock: ${directoryPath}`);
}

function assertAtomicOutputTarget(targetPath, stat) {
  if (stat?.isDirectory()) {
    const error = new Error(`Atomic PDF output target is a directory: ${targetPath}`);
    error.code = "ATOMIC_OUTPUT_TARGET_IS_DIRECTORY";
    throw error;
  }
  if (stat && !stat.isFile()) {
    const error = new Error(`Atomic PDF output target must be a regular file: ${targetPath}`);
    error.code = "ATOMIC_OUTPUT_TARGET_NOT_REGULAR";
    throw error;
  }
}

function atomicOutputError(code, message, cause, cleanupErrors = []) {
  const error = new Error(`${code}: ${message}`);
  error.code = code;
  if (cause) error.cause = cause;
  if (cleanupErrors.length > 0) {
    error.cleanup_errors = cleanupErrors.map(item => ({
      path: item.path,
      code: item.error?.code ?? null,
      message: item.error?.message ?? String(item.error),
    }));
  }
  return error;
}

/**
 * Replace one output only after its complete bytes have been flushed to a
 * same-directory staging file. A failed write or rename leaves an existing
 * target untouched.
 */
export async function writePdfOutputAtomic(targetPath, bytes, {
  fsOps = fs,
  token = atomicOutputToken(),
  onTransition,
  beforeDirectoryGuard,
  assertPathAllowed,
  beforeTransaction,
  validateInitialTargets,
  verifyActivatedTargets,
  anchoredDirectory = false,
  overwrite = false,
  expectedExistingIdentity = null,
  produceBytes,
} = {}) {
  const [result] = await writePdfOutputsAtomic([{
    targetPath,
    bytes,
    produceBytes,
    overwrite,
    expectedExistingIdentity,
  }], {
    fsOps,
    token,
    onTransition,
    beforeDirectoryGuard,
    assertPathAllowed,
    beforeTransaction,
    validateInitialTargets,
    verifyActivatedTargets,
    anchoredDirectory,
  });
  return result;
}

// The durable transaction accepts arbitrary bytes. Keep the established PDF
// name for compatibility while exposing a format-neutral entry point for text
// and future non-PDF side outputs.
export const writeOutputAtomic = writePdfOutputAtomic;

/**
 * Commit a same-directory set of PDF outputs as one durable transaction. All
 * bytes are staged before any target changes. A versioned journal restores an
 * interrupted pre-commit set or finishes cleanup for a durably committed set.
 */
export async function writePdfOutputsAtomic(entries, {
  fsOps = fs,
  token = atomicOutputToken(),
  onTransition = async () => {},
  beforeDirectoryGuard = async () => {},
  assertPathAllowed = async () => {},
  beforeTransaction = async () => {},
  validateInitialTargets = async () => {},
  verifyActivatedTargets = async () => {},
  anchoredDirectory = false,
} = {}) {
  if (!Array.isArray(entries) || entries.length === 0) {
    throw new TypeError("Atomic PDF output entries must be a non-empty array.");
  }
  if (
    typeof beforeDirectoryGuard !== "function"
    || typeof assertPathAllowed !== "function"
  ) {
    throw new TypeError("Atomic PDF output directory guards must be functions.");
  }
  const tokenId = atomicOutputTokenId(token);
  const targets = entries.map((entry, index) => {
    if (!entry || typeof entry.targetPath !== "string" || !entry.targetPath.trim()) {
      throw new TypeError(`Atomic PDF output entry ${index + 1} requires targetPath.`);
    }
    if (
      anchoredDirectory
      && (path.isAbsolute(entry.targetPath) || path.dirname(entry.targetPath) !== ".")
    ) {
      throw new TypeError(`Anchored atomic output entry ${index + 1} must use a basename-only targetPath.`);
    }
    const targetPath = anchoredDirectory ? entry.targetPath : path.resolve(entry.targetPath);
    if (portableOutputNameKey(path.basename(targetPath)).startsWith(".pdf-tools-")) {
      throw atomicOutputError(
        "ATOMIC_OUTPUT_RESERVED_TARGET",
        `PDF output target uses a reserved transaction name: ${targetPath}`,
      );
    }
    return {
      targetPath,
      reportedTargetPath: targetPath,
      bytes: entry.bytes,
      produceBytes: entry.produceBytes,
      overwrite: entry.overwrite === true,
      expectedExistingIdentity: entry.expectedExistingIdentity ?? null,
      index,
      initial: null,
      stagePath: atomicSiblingPath(targetPath, tokenId, "stage", index),
      rollbackPath: atomicSiblingPath(targetPath, tokenId, "rollback", index),
      originalMoved: false,
      activated: false,
    };
  });
  for (const entry of targets) {
    if (entry.overwrite !== (entry.expectedExistingIdentity !== null)) {
      throw atomicOutputError(
        "ATOMIC_OUTPUT_EXPECTED_IDENTITY_REQUIRED",
        `Replacing an existing output requires an exact expected identity: ${entry.targetPath}`,
      );
    }
  }
  const uniqueTargets = new Set(targets.map(entry => (
    path.join(path.dirname(entry.targetPath), portableOutputNameKey(path.basename(entry.targetPath)))
  )));
  if (uniqueTargets.size !== targets.length) {
    const error = new Error("Atomic PDF output transaction contains duplicate target paths.");
    error.code = "ATOMIC_OUTPUT_DUPLICATE_TARGET";
    throw error;
  }
  const directories = new Set(targets.map(entry => path.dirname(entry.targetPath)));
  if (directories.size !== 1) {
    throw atomicOutputError(
      "ATOMIC_OUTPUT_MULTIPLE_DIRECTORIES",
      "One PDF output transaction cannot span multiple directories.",
    );
  }
  const [requestedDirectoryPath] = directories;
  const outputDirectoryBinding = await bindAtomicOutputDirectory(
    requestedDirectoryPath,
    assertPathAllowed,
    fsOps,
    { anchoredDirectory },
  );
  const recoveryDirectoryGuard = async phase => {
    await beforeDirectoryGuard(phase);
    await assertAtomicOutputDirectory(outputDirectoryBinding, assertPathAllowed, fsOps);
  };
  recoveryDirectoryGuard.fileIdentity = outputDirectoryBinding.fileIdentity;
  await assertRecoveryDirectoryGuard(
    recoveryDirectoryGuard,
    "output_transaction_entry",
  );
  const directoryPath = anchoredDirectory ? "." : outputDirectoryBinding.canonicalPath;
  for (const entry of targets) {
    entry.targetPath = anchoredDirectory
      ? path.basename(entry.targetPath)
      : path.join(directoryPath, path.basename(entry.targetPath));
    if (!anchoredDirectory) entry.reportedTargetPath = entry.targetPath;
    entry.stagePath = atomicSiblingPath(entry.targetPath, tokenId, "stage", entry.index);
    entry.rollbackPath = atomicSiblingPath(entry.targetPath, tokenId, "rollback", entry.index);
  }
  const releaseDirectoryLock = await acquireAtomicOutputDirectoryLock(
    fsOps,
    directoryPath,
    { recoveryDirectoryGuard },
  );
  try {
    await onTransition("lock_acquired");
    await recoverPdfOutputTransactionsUnlocked(directoryPath, {
      fsOps,
      resolveDirectory: false,
      recoveryDirectoryGuard,
    });
    await assertRecoveryDirectoryGuard(
      recoveryDirectoryGuard,
      "before_transaction_callback",
    );
    await beforeTransaction();
    const journalPath = atomicJournalPath(directoryPath, tokenId);
    if (await lstatIfPresent(fsOps, journalPath)) {
      throw atomicOutputError("ATOMIC_OUTPUT_ARTIFACT_COLLISION", `Transaction journal already exists: ${journalPath}`);
    }
    const cleanupErrors = [];
    let journalCreated = false;
    let journalExpectation = null;
    let committed = false;
    const payload = {
      schema_version: PDF_OUTPUT_TRANSACTION_VERSION,
      token_id: tokenId,
      state: "staging",
      entries: [],
    };
    try {
      for (const entry of targets) {
        await assertRecoveryDirectoryGuard(
          recoveryDirectoryGuard,
          `before_initial_target_${entry.index}_inspection`,
        );
        entry.initial = await lstatIfPresent(fsOps, entry.targetPath);
        assertAtomicOutputTarget(entry.targetPath, entry.initial);
        if (entry.initial && !entry.overwrite) {
          throw atomicOutputError(
            "ATOMIC_OUTPUT_TARGET_EXISTS",
            `Atomic output target already exists and overwrite is false: ${entry.targetPath}`,
          );
        }
        entry.initialSha256 = entry.initial
          ? await sha256RegularFile(fsOps, entry.targetPath)
          : null;
        if (entry.expectedExistingIdentity !== null) {
          const expected = entry.expectedExistingIdentity;
          if (
            !entry.overwrite
            || !expected
            || typeof expected !== "object"
            || Array.isArray(expected)
            || typeof expected.canonicalPath !== "string"
            || !Number.isSafeInteger(expected.sizeBytes)
            || expected.sizeBytes < 0
            || !/^[a-f0-9]{64}$/.test(expected.sha256 ?? "")
          ) {
            throw atomicOutputError(
              "ATOMIC_OUTPUT_EXPECTED_IDENTITY_INVALID",
              `Expected output identity is invalid: ${entry.targetPath}`,
            );
          }
          if (!entry.initial) {
            throw atomicOutputError(
              "ATOMIC_OUTPUT_EXPECTED_TARGET_MISSING",
              `The approved output target no longer exists: ${entry.targetPath}`,
            );
          }
          if (
            expected.canonicalPath !== path.resolve(entry.reportedTargetPath)
            || expected.sizeBytes !== entry.initial.size
            || expected.sha256 !== entry.initialSha256
          ) {
            throw atomicOutputError(
              "ATOMIC_OUTPUT_EXPECTED_IDENTITY_CHANGED",
              `The output target no longer matches the approved identity: ${entry.targetPath}`,
            );
          }
        }
        if (outputIdentity(await lstatIfPresent(fsOps, entry.targetPath)) !== outputIdentity(entry.initial)) {
          throw atomicOutputError(
            "ATOMIC_OUTPUT_CONFLICT",
            `Output changed while its initial digest was captured: ${entry.targetPath}`,
          );
        }
        if (await lstatIfPresent(fsOps, entry.rollbackPath)) {
          throw atomicOutputError(
            "ATOMIC_OUTPUT_ARTIFACT_COLLISION",
            `Rollback path already exists: ${entry.rollbackPath}`,
          );
        }
        if (await lstatIfPresent(fsOps, entry.stagePath)) {
          throw atomicOutputError(
            "ATOMIC_OUTPUT_ARTIFACT_COLLISION",
            `Stage path already exists: ${entry.stagePath}`,
          );
        }
      }
      await validateInitialTargets(targets.map(entry => ({
        targetPath: entry.reportedTargetPath,
        exists: entry.initial !== null,
        sizeBytes: entry.initial ? Number(entry.initial.size) : null,
        sha256: entry.initialSha256,
        fileIdentity: entry.initial ? {
          device: String(entry.initial.dev),
          inode: String(entry.initial.ino),
        } : null,
      })));
      payload.entries = targets.map(entry => ({
        target: path.basename(entry.targetPath),
        stage: path.basename(entry.stagePath),
        stage_identity: null,
        rollback: path.basename(entry.rollbackPath),
        initial_identity: recoveryIdentity(entry.initial),
        initial_sha256: entry.initialSha256,
        new_sha256: null,
      }));
      journalExpectation = await writeAtomicJournal(
        fsOps,
        journalPath,
        payload,
        recoveryDirectoryGuard,
        null,
      );
      journalCreated = true;
      await onTransition("journal_staging");
      for (const entry of targets) {
        const bytes = typeof entry.produceBytes === "function"
          ? await entry.produceBytes()
          : entry.bytes;
        payload.entries[entry.index].new_sha256 = sha256Value(bytes);
        const staged = await stageAtomicOutput(
          fsOps,
          entry.targetPath,
          bytes,
          tokenId,
          entry.index,
          recoveryDirectoryGuard,
        );
        entry.stagePath = staged.path;
        entry.stageIdentity = staged.identity;
        payload.entries[entry.index].stage_identity = staged.identity;
        entry.bytes = null;
        entry.produceBytes = null;
        journalExpectation = await writeAtomicJournal(
          fsOps,
          journalPath,
          payload,
          recoveryDirectoryGuard,
          journalExpectation,
        );
        await onTransition(`stage_${entry.index}`);
      }
      payload.state = "prepared";
      journalExpectation = await writeAtomicJournal(
        fsOps,
        journalPath,
        payload,
        recoveryDirectoryGuard,
        journalExpectation,
      );
      await onTransition("journal_prepared");
      for (const entry of targets) {
        const current = await lstatIfPresent(fsOps, entry.targetPath);
        if (outputIdentity(current) !== outputIdentity(entry.initial)) {
          throw atomicOutputError(
            "ATOMIC_OUTPUT_CONFLICT",
            `Output changed while the transaction was being staged: ${entry.targetPath}`,
          );
        }
      }
      payload.state = "activating";
      journalExpectation = await writeAtomicJournal(
        fsOps,
        journalPath,
        payload,
        recoveryDirectoryGuard,
        journalExpectation,
      );
      await onTransition("journal_activating");
      for (const entry of targets) {
        const current = await lstatIfPresent(fsOps, entry.targetPath);
        if (outputIdentity(current) !== outputIdentity(entry.initial)) {
          throw atomicOutputError(
            "ATOMIC_OUTPUT_CONFLICT",
            `Output changed immediately before activation: ${entry.targetPath}`,
          );
        }
        if (current) {
          await assertRecoveryDirectoryGuard(
            recoveryDirectoryGuard,
            `before_target_${entry.index}_rollback`,
          );
          await fsOps.rename(entry.targetPath, entry.rollbackPath);
          entry.originalMoved = true;
          await onTransition(`rollback_${entry.index}`);
          const moved = await lstatIfPresent(fsOps, entry.rollbackPath);
          let movedSha256 = null;
          let movedDigestError = null;
          if (moved) {
            try {
              movedSha256 = await sha256RegularFile(fsOps, entry.rollbackPath);
            } catch (error) {
              movedDigestError = error;
            }
          }
          if (
            movedDigestError
            ||
            recoveryIdentity(moved) !== recoveryIdentity(entry.initial)
            || movedSha256 !== entry.initialSha256
          ) {
            if (moved) {
              try {
                await assertRecoveryDirectoryGuard(
                  recoveryDirectoryGuard,
                  `before_target_${entry.index}_rollback_repair`,
                );
                await fsOps.link(entry.rollbackPath, entry.targetPath);
                if (!await assertExpectedArtifact(fsOps, entry.targetPath, {
                  identity: recoveryIdentity(moved),
                  sha256: movedDigestError ? null : movedSha256,
                })) {
                  throw atomicOutputError(
                    "ATOMIC_OUTPUT_CONFLICT",
                    `Rollback repair did not restore the exact output: ${entry.targetPath}`,
                  );
                }
                await removeExpectedArtifact(fsOps, entry.rollbackPath, {
                  identity: recoveryIdentity(moved),
                  sha256: movedDigestError ? null : movedSha256,
                }, recoveryDirectoryGuard);
                entry.originalMoved = false;
              } catch (repairError) {
                if (repairError?.[RECOVERY_DIRECTORY_GUARD_FAILURE]) throw repairError;
              }
            }
            throw atomicOutputError(
              "ATOMIC_OUTPUT_CONFLICT",
              `Output changed while it was moved into rollback protection: ${entry.targetPath}`,
              movedDigestError,
            );
          }
        }
        try {
          await assertExpectedArtifact(fsOps, entry.stagePath, {
            identity: entry.stageIdentity,
            sha256: payload.entries[entry.index].new_sha256,
            privateMode: true,
          });
          await assertRecoveryDirectoryGuard(
            recoveryDirectoryGuard,
            `before_target_${entry.index}_activation`,
          );
          await fsOps.link(entry.stagePath, entry.targetPath);
        } catch (error) {
          if (error?.code === "EEXIST") {
            throw atomicOutputError(
              "ATOMIC_OUTPUT_CONFLICT",
              `Output appeared before no-clobber activation: ${entry.targetPath}`,
              error,
            );
          }
          throw error;
        }
        entry.activated = true;
        await onTransition(`activate_${entry.index}`);
      }
      await syncAtomicOutputDirectory(
        fsOps,
        directoryPath,
        recoveryDirectoryGuard,
      );
      await onTransition("activation_synced");
      await verifyActivatedTargets(targets.map(entry => ({
        targetPath: entry.reportedTargetPath,
        replacedExisting: entry.initial !== null,
      })));
      await assertRecoveryDirectoryGuard(
        recoveryDirectoryGuard,
        "after_activated_target_verification",
      );
      for (const entry of targets) {
        if (!await assertExpectedArtifact(fsOps, entry.targetPath, {
          identity: entry.stageIdentity,
          sha256: payload.entries[entry.index].new_sha256,
        })) {
          throw atomicOutputError(
            "ATOMIC_OUTPUT_CONFLICT",
            `Verified output disappeared before commit: ${entry.targetPath}`,
          );
        }
      }
      await onTransition("activation_verified");
      payload.state = "committed";
      journalExpectation = await writeAtomicJournal(
        fsOps,
        journalPath,
        payload,
        recoveryDirectoryGuard,
        journalExpectation,
      );
      committed = true;
      await onTransition("journal_committed");
    } catch (cause) {
      if (cause?.[RECOVERY_DIRECTORY_GUARD_FAILURE]) throw cause;
      if (cause?.[JOURNAL_EXPECTATION_FAILURE]) throw cause;
      const partiallyPublishedJournal = cause?.[JOURNAL_PUBLISHED_EXPECTATION] ?? null;
      const recoveryJournalExpectation = partiallyPublishedJournal ?? journalExpectation;
      try {
        if (payload.state === "staging") {
          for (const entry of targets) {
            if (!entry.stageIdentity || entry.originalMoved || entry.activated) continue;
            await removeExpectedArtifact(fsOps, entry.stagePath, {
              identity: entry.stageIdentity,
              sha256: payload.entries[entry.index]?.new_sha256 ?? null,
              privateMode: true,
            }, recoveryDirectoryGuard);
          }
        }
        if (journalCreated || partiallyPublishedJournal !== null) {
          await recoverAtomicJournal(
            fsOps,
            journalPath,
            recoveryDirectoryGuard,
            recoveryJournalExpectation,
          );
        } else if (await lstatIfPresent(fsOps, journalPath)) {
          throw journalExpectationError(
            `Transaction journal appeared before this writer published it: ${journalPath}`,
          );
        }
      } catch (recoveryError) {
        cleanupErrors.push({ path: journalPath, error: recoveryError });
      }
      if (cleanupErrors.length > 0) {
        throw atomicOutputError(
          "ATOMIC_OUTPUT_ROLLBACK_FAILED",
          committed
            ? "The PDF outputs committed, but transaction cleanup could not be completed."
            : "The PDF output transaction failed and could not be fully recovered.",
          cause,
          cleanupErrors,
        );
      }
      if (committed) {
        return targets.map(entry => ({
          targetPath: entry.reportedTargetPath,
          replacedExisting: entry.initial !== null,
        }));
      }
      throw cause;
    }
    let removingCommittedJournal = false;
    try {
      for (const entry of targets) {
        if (entry.stagePath) {
          await removeExpectedArtifact(fsOps, entry.stagePath, {
            identity: entry.stageIdentity,
            sha256: payload.entries[entry.index].new_sha256,
            privateMode: true,
          }, recoveryDirectoryGuard);
          entry.stagePath = null;
          await onTransition(`stage_removed_${entry.index}`);
        }
        if (entry.originalMoved) {
          await removeExpectedArtifact(fsOps, entry.rollbackPath, {
            identity: recoveryIdentity(entry.initial),
            sha256: entry.initialSha256,
          }, recoveryDirectoryGuard);
          entry.originalMoved = false;
          await onTransition(`rollback_removed_${entry.index}`);
        }
      }
      await syncAtomicOutputDirectory(
        fsOps,
        directoryPath,
        recoveryDirectoryGuard,
      );
      removingCommittedJournal = true;
      await removeExpectedArtifact(
        fsOps,
        journalPath,
        {
          identity: journalExpectation.identity,
          sha256: journalExpectation.sha256,
          privateMode: true,
        },
        recoveryDirectoryGuard,
      );
      removingCommittedJournal = false;
      await syncAtomicOutputDirectory(
        fsOps,
        directoryPath,
        recoveryDirectoryGuard,
      );
      await onTransition("journal_removed");
    } catch (cause) {
      if (cause?.[RECOVERY_DIRECTORY_GUARD_FAILURE]) throw cause;
      if (removingCommittedJournal) {
        throw atomicOutputError(
          "ATOMIC_OUTPUT_COMMITTED_CLEANUP_FAILED",
          "The PDF outputs committed, but the exact durable journal could not be removed.",
          cause,
          [{ path: journalPath, error: cause }],
        );
      }
      try {
        if (await lstatIfPresent(fsOps, journalPath)) {
          await recoverAtomicJournal(
            fsOps,
            journalPath,
            recoveryDirectoryGuard,
            journalExpectation,
          );
        }
      } catch (recoveryError) {
        throw atomicOutputError(
          "ATOMIC_OUTPUT_COMMITTED_CLEANUP_FAILED",
          "The PDF outputs committed, but durable transaction cleanup could not be completed.",
          cause,
          [{ path: journalPath, error: recoveryError }],
        );
      }
    }
    return targets.map(entry => ({
      targetPath: entry.reportedTargetPath,
      replacedExisting: entry.initial !== null,
    }));
  } finally {
    await releaseDirectoryLock();
  }
}

// Find an unused filesystem path by appending " (2)", " (3)", etc.
export async function findUniquePath(target) {
  try {
    await fs.access(target);
  } catch {
    return target;
  }
  const ext = path.extname(target);
  const base = target.slice(0, target.length - ext.length);
  for (let i = 2; i < 1000; i++) {
    const candidate = `${base} (${i})${ext}`;
    try {
      await fs.access(candidate);
    } catch {
      return candidate;
    }
  }
  throw new Error(`Could not find a unique filename for ${target}`);
}

const PDF_DOWNLOAD_FILENAME_NAMESPACE_SIZE = 999;
const DEFAULT_PDF_DOWNLOAD_CONTENTION_TIMEOUT_MS = 30_000;
const PDF_DOWNLOAD_CONTENTION_INITIAL_DELAY_MS = 5;
const PDF_DOWNLOAD_CONTENTION_MAX_DELAY_MS = 50;
const PDF_DOWNLOAD_CONTENTION_CODES = new Set([
  "ATOMIC_OUTPUT_CONCURRENT",
  "ATOMIC_OUTPUT_LOCK_FAILED",
]);

function pdfDownloadRetryExhausted(code, message, cause) {
  const error = new Error(message);
  error.code = code;
  error.cause = cause;
  return error;
}

/**
 * Commit fetched PDF bytes without clobbering a concurrent download.
 *
 * findUniquePath is intentionally only an optimistic candidate selection.
 * writePdfOutputAtomic makes the no-clobber decision while holding the output
 * directory lock. If another writer wins that exact candidate first, select
 * again and retry. Every other failure is surfaced without retrying.
 */
export async function writePdfDownloadAtomic(targetPath, bytes, {
  assertPathAllowed = async () => {},
  overwrite = false,
  expectedExistingIdentity = null,
  maxFilenameCollisions = PDF_DOWNLOAD_FILENAME_NAMESPACE_SIZE,
  contentionTimeoutMs = DEFAULT_PDF_DOWNLOAD_CONTENTION_TIMEOUT_MS,
  findUniquePathFn = findUniquePath,
  writePdfOutputAtomicFn = writePdfOutputAtomic,
  nowFn = () => performance.now(),
  sleepFn = delayMs => new Promise(resolve => setTimeout(resolve, delayMs)),
} = {}) {
  if (
    !Number.isSafeInteger(maxFilenameCollisions)
    || maxFilenameCollisions < 1
    || maxFilenameCollisions > PDF_DOWNLOAD_FILENAME_NAMESPACE_SIZE
  ) {
    throw new RangeError(
      `maxFilenameCollisions must be an integer from 1 to ${PDF_DOWNLOAD_FILENAME_NAMESPACE_SIZE}.`,
    );
  }
  if (!Number.isFinite(contentionTimeoutMs) || contentionTimeoutMs < 0) {
    throw new RangeError("contentionTimeoutMs must be a non-negative finite number.");
  }

  if (overwrite) {
    return writePdfOutputAtomicFn(targetPath, bytes, {
      assertPathAllowed,
      overwrite: true,
      expectedExistingIdentity,
    });
  }
  if (expectedExistingIdentity !== null) {
    throw new Error(
      "expectedExistingIdentity requires overwrite=true for a PDF download.",
    );
  }

  let filenameCollisions = 0;
  let contentionWaits = 0;
  let contentionDeadline = null;
  while (true) {
    const candidatePath = await findUniquePathFn(targetPath);
    try {
      return await writePdfOutputAtomicFn(candidatePath, bytes, {
        assertPathAllowed,
        overwrite: false,
      });
    } catch (error) {
      if (error?.code === "ATOMIC_OUTPUT_TARGET_EXISTS") {
        filenameCollisions++;
        if (filenameCollisions >= maxFilenameCollisions) {
          throw pdfDownloadRetryExhausted(
            "PDF_DOWNLOAD_UNIQUE_PATH_RETRY_EXHAUSTED",
            `Could not commit a unique PDF filename after ${filenameCollisions} locked candidate collisions: ${targetPath}`,
            error,
          );
        }
        continue;
      }
      if (!PDF_DOWNLOAD_CONTENTION_CODES.has(error?.code)) throw error;

      const now = nowFn();
      contentionDeadline ??= now + contentionTimeoutMs;
      const remainingMs = contentionDeadline - now;
      if (remainingMs <= 0) {
        throw pdfDownloadRetryExhausted(
          "PDF_DOWNLOAD_OUTPUT_CONTENTION_TIMEOUT",
          `Timed out waiting to commit a downloaded PDF in the output directory: ${path.dirname(targetPath)}`,
          error,
        );
      }
      const delayMs = Math.min(
        remainingMs,
        PDF_DOWNLOAD_CONTENTION_MAX_DELAY_MS,
        PDF_DOWNLOAD_CONTENTION_INITIAL_DELAY_MS * (2 ** Math.min(contentionWaits, 4)),
      );
      contentionWaits++;
      await sleepFn(delayMs);
    }
  }
}

// Detect loopback, link-local, and RFC1918 private hostnames/IPs.
export function isPrivateHost(hostname) {
  if (!hostname) return true;
  const h = hostname.toLowerCase().replace(/^\[|\]$/g, "");
  if (h === "localhost" || h === "::1" || h === "0.0.0.0") return true;
  if (h.endsWith(".localhost") || h.endsWith(".local")) return true;
  const ipv4 = h.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (ipv4) {
    const [a, b] = ipv4.slice(1).map(Number);
    if (a === 10 || a === 127 || a === 0) return true;
    if (a === 169 && b === 254) return true;
    if (a === 172 && b >= 16 && b <= 31) return true;
    if (a === 192 && b === 168) return true;
  }
  if (h.startsWith("fc") || h.startsWith("fd") || h.startsWith("fe80:")) return true;
  return false;
}

// Validate a URL for fetch: must be http/https, must not be a private host
// (unless allowPrivateHosts). Returns the parsed URL or throws.
function validateFetchTarget(urlString, allowPrivateHosts) {
  let parsed;
  try {
    parsed = new URL(urlString);
  } catch {
    throw new Error(`Invalid URL: ${urlString}`);
  }
  if (!["http:", "https:"].includes(parsed.protocol)) {
    throw new Error(`Only http and https URLs are supported (got ${parsed.protocol}).`);
  }
  if (!allowPrivateHosts && isPrivateHost(parsed.hostname)) {
    throw new Error(
      `Refusing to download from private/loopback host "${parsed.hostname}". ` +
      `Set allow_private_hosts=true if this is intentional.`
    );
  }
  return parsed;
}

// Download a PDF from a URL to a local file.
// Returns { path, bytes, contentType, sourceUrl, finalUrl, redirectHops }.
// Rejects: non-http(s), private hosts (unless allowPrivateHosts), non-PDF content, oversize,
// redirects to private hosts (each redirect is re-validated — prevents redirect-based SSRF).
export async function downloadPdfFromUrl(url, {
  filename = null,
  destinationDir = null,
  overwrite = false,
  expectedOutputIdentity = null,
  maxSizeMb = 100,
  headers = {},
  allowPrivateHosts = false,
  maxRedirects = 5,
  fetchFn = fetch,
  assertPathAllowed = async () => {},
} = {}) {
  // Initial validation — defends against the naive SSRF case.
  validateFetchTarget(url, allowPrivateHosts);

  // Manual redirect loop — re-validates each hop so a public URL cannot 302
  // to a private host (AWS metadata endpoint, localhost, RFC1918, etc.).
  let currentUrl = url;
  let response;
  let hops = 0;
  while (true) {
    let parsed;
    try {
      response = await fetchFn(currentUrl, { headers, redirect: "manual" });
    } catch (err) {
      parsed = new URL(currentUrl);
      throw new Error(`Could not reach ${parsed.hostname}: ${err.message}`);
    }
    const status = response.status;
    const isRedirect = [301, 302, 303, 307, 308].includes(status);
    if (!isRedirect) break;

    if (hops >= maxRedirects) {
      throw new Error(`Too many redirects (>${maxRedirects}) starting from ${url}.`);
    }
    const location = response.headers.get("location");
    if (!location) {
      throw new Error(`HTTP ${status} redirect from ${currentUrl} with no Location header.`);
    }
    // Resolve relative Location against current URL; absolute URLs pass through.
    const nextUrl = new URL(location, currentUrl).toString();
    // Re-validate the target of every hop — blocks redirect-based SSRF.
    validateFetchTarget(nextUrl, allowPrivateHosts);
    currentUrl = nextUrl;
    hops++;
  }

  if (!response.ok) {
    throw new Error(`HTTP ${response.status} ${response.statusText} from ${currentUrl}`);
  }

  const contentType = response.headers.get("content-type") || "";
  const contentLengthHeader = response.headers.get("content-length");
  const advertisedLength = contentLengthHeader ? parseInt(contentLengthHeader, 10) : 0;
  const maxBytes = maxSizeMb * 1024 * 1024;
  if (advertisedLength && advertisedLength > maxBytes) {
    throw new Error(
      `PDF is ${(advertisedLength / 1048576).toFixed(1)} MB, exceeds ${maxSizeMb} MB limit. ` +
      `Increase max_size_mb to override.`
    );
  }

  const buffer = Buffer.from(await response.arrayBuffer());
  if (buffer.length > maxBytes) {
    throw new Error(
      `PDF is ${(buffer.length / 1048576).toFixed(1)} MB, exceeds ${maxSizeMb} MB limit.`
    );
  }

  const magic = buffer.subarray(0, 5).toString("ascii");
  if (magic !== "%PDF-") {
    const preview = buffer.subarray(0, 80).toString("utf-8")
      .replace(/[^\x20-\x7e]/g, "?").slice(0, 60);
    throw new Error(
      `URL did not return a PDF. Content-Type: "${contentType || "unknown"}". ` +
      `First bytes: "${preview}". ` +
      `The URL may point to an HTML page — confirm it is a direct PDF link.`
    );
  }

  // Destination dir + filename resolution deferred until after validation
  // so we don't create empty files on rejection paths.
  // Default to the user's standard Downloads folder — a hidden dotfile dir is
  // invisible in Finder and users can't find their files. ~/Downloads works
  // on macOS, Windows, and most Linux setups.
  const destDir = destinationDir || path.join(homedir(), "Downloads");
  await fs.mkdir(destDir, { recursive: true });
  const finalParsed = new URL(currentUrl);
  const urlName = decodeURIComponent(path.basename(finalParsed.pathname) || "");
  const finalName = sanitizePdfFilename(filename || urlName || "download.pdf");
  let target = path.join(destDir, finalName);

  const committed = await writePdfDownloadAtomic(target, buffer, {
    assertPathAllowed,
    overwrite,
    expectedExistingIdentity: expectedOutputIdentity,
  });
  target = committed.targetPath;
  return {
    path: target,
    bytes: buffer.length,
    contentType,
    sourceUrl: url,
    finalUrl: currentUrl,
    redirectHops: hops,
  };
}

// Parse page range strings like "1-5,6-10" or "every 5"
export function parsePageRanges(rangeString, totalPages) {
  const trimmed = rangeString.trim();

  // Handle "every N" shorthand
  const everyMatch = trimmed.match(/^every\s+(\d+)$/i);
  if (everyMatch) {
    const n = parseInt(everyMatch[1], 10);
    if (n <= 0) throw new Error("'every N' requires N > 0.");
    const ranges = [];
    for (let start = 1; start <= totalPages; start += n) {
      const end = Math.min(start + n - 1, totalPages);
      ranges.push([start, end]);
    }
    return ranges;
  }

  // Handle comma-separated dash ranges: "1-5,6-10,11-15"
  const parts = trimmed.split(",").map(p => p.trim()).filter(Boolean);
  if (parts.length === 0) throw new Error("Empty page range string.");

  const ranges = [];
  for (const part of parts) {
    const dashMatch = part.match(/^(\d+)\s*-\s*(\d+)$/);
    if (!dashMatch) {
      // Try single page number
      const singleMatch = part.match(/^(\d+)$/);
      if (singleMatch) {
        const page = parseInt(singleMatch[1], 10);
        if (page < 1 || page > totalPages) throw new Error(`Page ${page} is out of range (1-${totalPages}).`);
        ranges.push([page, page]);
        continue;
      }
      throw new Error(`Invalid page range: "${part}". Use "1-5" or "every 5" format.`);
    }
    const start = parseInt(dashMatch[1], 10);
    const end = parseInt(dashMatch[2], 10);
    if (start < 1 || end < 1) throw new Error(`Page numbers must be >= 1, got "${part}".`);
    if (start > end) throw new Error(`Invalid range "${part}": start (${start}) > end (${end}).`);
    if (end > totalPages) throw new Error(`Page ${end} is out of range (1-${totalPages}).`);
    ranges.push([start, end]);
  }
  return ranges;
}

export function normalizeRotation(rotation) {
  const normalized = rotation % 360;
  return normalized < 0 ? normalized + 360 : normalized;
}

export function getPageDisplayMetrics({ width, height, rotation = 0 }) {
  const normalizedRotation = normalizeRotation(rotation);
  const swapsAxes = normalizedRotation === 90 || normalizedRotation === 270;
  const displayWidth = swapsAxes ? height : width;
  const displayHeight = swapsAxes ? width : height;

  return {
    width: Math.round(width),
    height: Math.round(height),
    rotation: normalizedRotation,
    display_width: Math.round(displayWidth),
    display_height: Math.round(displayHeight),
    orientation: displayWidth > displayHeight ? "landscape" : "portrait",
  };
}

export const PAGE_ANALYSIS_RETRY_GUIDANCE =
  "Do not treat unknown pages as blank or delete/reorder them from this result. " +
  "Retry get_page_analysis; if a page remains unknown, inspect it with render_pdf_page before any page mutation.";

export const PAGE_ANALYSIS_MUTATION_GUIDANCE =
  "likely_blank is a conservative heuristic, not authorization to delete or reorder a page. " +
  "Visually inspect every blank candidate with render_pdf_page before mutation.";

// Ported from firecrawl/pdf-inspector (MIT): src/detector.rs. These are PDF.js
// measurement thresholds, not raw PDF operator thresholds. Keep them named so
// the fixture corpus and boundary tests pin the routing contract.
export const MIN_TEXT_CHARS = 25;
export const MIN_TEXT_CHARS_WITH_IMAGES = 100;
export const IMAGE_DOMINATED_MIN_PAINTS = 1;
export const VECTOR_SEGMENT_MIN = 1000;
export const TEXT_PAGE_RATIO_THRESHOLD = 0.6;

export const PAGE_CLASSIFICATION_REASONS = Object.freeze([
  "no_text_layer",
  "image_dominated",
  "vector_only_text",
  "suspected_text_integrity",
  "invisible_text_layer",
  "text_visibility_unavailable",
  "analysis_unavailable",
]);

const ROUTING_TEXT_LENGTH = Symbol("routingTextLength");

// This observes PDF text-paint instructions, not OCR accuracy, language, or
// whether arbitrary content is visible after clipping/overpainting. Mode 3
// explicitly suppresses text painting. An invisible layer may be perfectly
// accurate, but extracting it does not verify it against the visible page.
export function measureTextVisibility(pdfjsLib, operators) {
  const unavailable = { status: "unavailable", invisible_text_show_count: null, other_text_show_count: null };
  const OPS = pdfjsLib?.OPS;
  if (!OPS || !Number.isInteger(OPS.setTextRenderingMode)
      || !Number.isInteger(OPS.showText) || !Number.isInteger(OPS.save)
      || !Number.isInteger(OPS.restore) || !Array.isArray(operators?.fnArray)
      || !Array.isArray(operators?.argsArray)
      || operators.fnArray.length !== operators.argsArray.length) return unavailable;
  let mode = 0;
  let invisible = 0;
  let other = 0;
  const stack = [];
  for (let index = 0; index < operators.fnArray.length; index += 1) {
    const fn = operators.fnArray[index];
    const args = operators.argsArray[index];
    if (fn === OPS.save || fn === OPS.paintFormXObjectBegin) {
      stack.push(mode);
    } else if (fn === OPS.restore || fn === OPS.paintFormXObjectEnd) {
      if (stack.length === 0) return unavailable;
      mode = stack.pop();
    } else if (fn === OPS.beginAnnotation || fn === OPS.endAnnotation
        || fn === OPS.beginGroup || fn === OPS.endGroup) {
      // Annotation and transparency-group setup is renderer-specific; do not
      // let an untracked state restoration become false visibility evidence.
      return unavailable;
    } else if (fn === OPS.beginMarkedContentProps) {
      // Optional-content visibility changes form state semantics in PDF.js.
      // Do not infer the selected layer configuration from operator bytes.
      if (!Array.isArray(args) || typeof args[0] !== "string" || args[0] === "OC") return unavailable;
    } else if (fn === OPS.setTextRenderingMode) {
      if (!Array.isArray(args) || args.length !== 1 || !Number.isInteger(args[0])
          || args[0] < 0 || args[0] > 7) return unavailable;
      mode = args[0];
    } else if (fn === OPS.showText) {
      if (!Array.isArray(args) || !Array.isArray(args[0])) return unavailable;
      if (args[0].some(glyph => typeof glyph?.unicode === "string" && glyph.unicode.trim().length > 0)) {
        if (mode === 3) invisible += 1;
        else other += 1;
      }
    }
  }
  if (stack.length > 0) return unavailable;
  return { status: "available", invisible_text_show_count: invisible, other_text_show_count: other };
}

// Ported from firecrawl/pdf-inspector (MIT): src/text_quality.rs. Keep this
// synchronized with layout-extraction.js because get_page_analysis and
// read_pdf_content receive PDF.js text items rather than the extraction IR.
function codePointIsPrivateUse(codePoint) {
  return (codePoint >= 0xe000 && codePoint <= 0xf8ff)
    || (codePoint >= 0xf0000 && codePoint <= 0xffffd)
    || (codePoint >= 0x100000 && codePoint <= 0x10fffd);
}

function itemTextIntegrityForRouting(text) {
  const codePoints = [...text];
  let replacementCharacters = 0;
  let longestReplacementRun = 0;
  let replacementSpans = 0;
  let replacementRun = 0;
  let privateUse = 0;
  let privateUseRuns = 0;
  let privateRun = 0;
  for (const character of codePoints) {
    const codePoint = character.codePointAt(0);
    if (character === "\uFFFD") {
      replacementCharacters += 1;
      replacementRun += 1;
      longestReplacementRun = Math.max(longestReplacementRun, replacementRun);
    } else if (replacementRun > 0) {
      if (replacementRun >= 2) replacementSpans += 1;
      replacementRun = 0;
    }
    if (codePointIsPrivateUse(codePoint)) {
      privateUse += 1;
      privateRun += 1;
    } else if (privateRun > 0) {
      if (privateRun >= 3) privateUseRuns += 1;
      privateRun = 0;
    }
  }
  if (replacementRun >= 2) replacementSpans += 1;
  if (privateRun >= 3) privateUseRuns += 1;
  const replacementSignal = longestReplacementRun >= 2 || replacementCharacters >= 3;
  let c1ControlTokens = 0;
  for (const token of text.matchAll(/\S+/gu)) {
    const tokenCodePoints = [...token[0]];
    const c1Count = tokenCodePoints.filter(character => {
      const codePoint = character.codePointAt(0);
      return codePoint >= 0x80 && codePoint <= 0x9f;
    }).length;
    if (tokenCodePoints.length >= 5 && c1Count >= 2 && c1Count * 20 >= tokenCodePoints.length) c1ControlTokens += 1;
  }
  const privateUseSignal = privateUseRuns > 0
    || (codePoints.length >= 5 && privateUse >= 2 && privateUse * 2 >= codePoints.length);
  return {
    replacementCharacters: replacementSignal ? replacementCharacters : 0,
    longestReplacementRun,
    replacementSpans: replacementSignal ? replacementSpans : 0,
    privateUseRuns: privateUseSignal ? Math.max(1, privateUseRuns) : 0,
    c1ControlTokens,
  };
}

function nonAlphanumericDominanceForRouting(text) {
  const codePoints = [...text];
  let total = 0;
  let alphanumeric = 0;
  for (let index = 0; index < codePoints.length;) {
    if ([".", "_", "·"].includes(codePoints[index])) {
      let end = index + 1;
      while (end < codePoints.length && [".", "_", "·"].includes(codePoints[end])) end += 1;
      if (end - index >= 3) {
        index = end;
        continue;
      }
    }
    const character = codePoints[index++];
    if (/\s/u.test(character)) continue;
    total += 1;
    if (/^[\p{L}\p{N}]$/u.test(character)) alphanumeric += 1;
  }
  return total >= 50 && alphanumeric * 2 < total;
}

export function deriveTextIntegrityForRouting(texts, unavailable = false) {
  if (unavailable) return { status: "unavailable", signals: [] };
  const itemTexts = (texts ?? []).map(text => String(text ?? ""));
  const pageText = itemTexts.join("\n");
  const itemSignals = itemTexts.map(itemTextIntegrityForRouting);
  const characters = [...pageText].length;
  const replacementCharacters = itemSignals.reduce((sum, signal) => sum + signal.replacementCharacters, 0);
  const replacementSpans = itemSignals.reduce((sum, signal) => sum + signal.replacementSpans, 0);
  const longestReplacementRun = Math.max(0, ...itemSignals.map(signal => signal.longestReplacementRun));
  const privateUseRuns = itemSignals.reduce((sum, signal) => sum + signal.privateUseRuns, 0);
  const c1ControlTokens = itemSignals.reduce((sum, signal) => sum + signal.c1ControlTokens, 0);
  const replacementSuspect = (characters <= 80 && longestReplacementRun >= 2)
    || (replacementCharacters >= 12 && replacementCharacters / Math.max(1, characters) >= 0.05)
    || (replacementSpans >= 3 && replacementSpans / Math.max(1, characters) >= 0.025)
    || (longestReplacementRun >= 8 && longestReplacementRun / Math.max(1, characters) >= 0.025);
  const signals = [];
  if (replacementCharacters > 0) signals.push({ kind: "replacement_characters", count: replacementCharacters });
  if (privateUseRuns > 0) signals.push({ kind: "private_use_runs", count: privateUseRuns });
  if (c1ControlTokens > 0) signals.push({ kind: "c1_control_tokens", count: c1ControlTokens });
  if (nonAlphanumericDominanceForRouting(pageText)) signals.push({ kind: "non_alphanumeric_dominance", count: 1 });
  return {
    status: replacementSuspect || privateUseRuns > 0 || c1ControlTokens > 0 || signals.some(signal => signal.kind === "non_alphanumeric_dominance")
      ? "suspect" : "ok",
    signals,
  };
}

function initialPageAnalysis(page, index) {
  const { width, height } = page.getSize();
  const metrics = getPageDisplayMetrics({
    width,
    height,
    rotation: page.getRotation().angle,
  });
  return {
    page: index + 1,
    ...metrics,
    text_length: null,
    text_snippet: null,
    has_images: null,
    has_graphics: null,
    image_op_count: null,
    path_op_count: null,
    path_segment_count: null,
    content_analysis_status: "not_analyzed",
    text_extraction_status: "not_analyzed",
    image_detection_status: "not_analyzed",
    graphics_detection_status: "not_analyzed",
    blank_status: "unknown",
    analysis_error_codes: [],
    text_integrity: { status: "unavailable", signals: [] },
    text_visibility: measureTextVisibility(null, null),
    analysis_provenance: {
      dimensions: "pdf-lib",
      text: null,
      images: null,
      graphics: null,
    },
  };
}

function measuredRoutingTextLength(page) {
  return Number.isSafeInteger(page?.[ROUTING_TEXT_LENGTH])
    ? page[ROUTING_TEXT_LENGTH]
    : page?.text_length;
}

function pageMeasurementsAvailable(page) {
  return page?.text_extraction_status === "complete"
    && page?.image_detection_status === "complete"
    && page?.graphics_detection_status === "complete"
    && Number.isSafeInteger(measuredRoutingTextLength(page))
    && Number.isSafeInteger(page?.image_op_count)
    && Number.isSafeInteger(page?.path_op_count)
    && Number.isSafeInteger(page?.path_segment_count);
}

/**
 * Return the deterministic, evidence-backed routing classification for one
 * page. Failed or not-yet-run measurements are never converted into zeros.
 */
export function classifyPageRouting(page, {
  minTextChars = MIN_TEXT_CHARS,
  minTextCharsWithImages = MIN_TEXT_CHARS_WITH_IMAGES,
  imageDominatedMinPaints = IMAGE_DOMINATED_MIN_PAINTS,
  vectorSegmentMin = VECTOR_SEGMENT_MIN,
} = {}) {
  if (page?.content_analysis_status === "not_analyzed") {
    return {
      text_bearing: null,
      reasons: [],
    };
  }
  if (!pageMeasurementsAvailable(page)) {
    return {
      text_bearing: null,
      reasons: ["analysis_unavailable"],
    };
  }

  const textLength = measuredRoutingTextLength(page);
  const hasImages = page.image_op_count >= imageDominatedMinPaints;
  const textThreshold = hasImages ? minTextCharsWithImages : minTextChars;
  const textBearing = textLength >= textThreshold;
  const reasons = [];
  if (!textBearing) {
    reasons.push(hasImages ? "image_dominated" : "no_text_layer");
  }
  if (page.path_segment_count >= vectorSegmentMin && textLength < 30) {
    reasons.push("vector_only_text");
  }
  if (page.text_integrity?.status === "suspect") {
    reasons.push("suspected_text_integrity");
  }
  if (textLength > 0 && page.text_visibility?.status === "available"
      && page.text_visibility.invisible_text_show_count > 0) {
    reasons.push("invisible_text_layer");
  }
  if (textLength > 0 && page.text_visibility?.status === "unavailable") {
    reasons.push("text_visibility_unavailable");
  }
  return { text_bearing: textBearing, reasons };
}

function pageHasImageEvidence(page) {
  return Number.isSafeInteger(page?.image_op_count) && page.image_op_count > 0;
}

function pageHasVectorEvidence(page, routing) {
  return routing.reasons.includes("vector_only_text")
    || (Number.isSafeInteger(page?.path_segment_count) && page.path_segment_count > 0);
}

/** Roll up per-page routing decisions without inventing confidence scores. */
export function rollupPageClassification(pages, pagesAnalyzed = null) {
  if (!Array.isArray(pages)) throw new TypeError("pages must be an array.");
  const pagesNotAnalyzed = pages
    .filter(page => page.content_analysis_status === "not_analyzed")
    .map(page => page.page);
  const analyzedPages = pages.filter(page => page.content_analysis_status !== "not_analyzed");
  const decisions = analyzedPages.map(page => ({ page, routing: classifyPageRouting(page) }));
  const pagesNeedingVision = decisions
    .filter(({ routing }) => routing.reasons.length > 0)
    .map(({ page, routing }) => ({ page: page.page, reasons: routing.reasons }));
  const analyzedCount = pagesAnalyzed === null ? analyzedPages.length : pagesAnalyzed;
  const available = decisions.filter(({ routing }) => routing.text_bearing !== null);
  const textBearingPages = available.filter(({ routing }) => routing.text_bearing);
  const imagePages = available.filter(({ page }) => pageHasImageEvidence(page));
  const nonTextPages = available.filter(({ routing }) => !routing.text_bearing);
  const unavailable = decisions.some(({ routing }) => routing.reasons.includes("analysis_unavailable"));
  const provesMixed = textBearingPages.length > 0
    && nonTextPages.length > 0;
  const textRatio = available.length > 0 ? textBearingPages.length / available.length : null;

  let documentKind = "unknown";
  if (unavailable) {
    // Fail closed: a page whose measurements ran and failed can never be
    // absorbed into a confident text_based summary. Available evidence may
    // still prove the document mixed; anything less stays unknown.
    documentKind = provesMixed ? "mixed" : "unknown";
  } else if (textRatio !== null && textRatio >= TEXT_PAGE_RATIO_THRESHOLD) {
    documentKind = "text_based";
  } else if (textBearingPages.length > 0 && pagesNeedingVision.length > 0) {
    documentKind = "mixed";
  } else if (textBearingPages.length === 0 && imagePages.length > 0) {
    const imageReasonCount = pagesNeedingVision.filter(entry => entry.reasons.includes("image_dominated")).length;
    const vectorReasonCount = pagesNeedingVision.filter(entry => entry.reasons.includes("vector_only_text")).length;
    documentKind = vectorReasonCount > imageReasonCount ? "vector_heavy" : "image_based";
  } else if (available.length > 0 && nonTextPages.length === available.length) {
    const vectorReasonCount = pagesNeedingVision.filter(entry => entry.reasons.includes("vector_only_text")).length;
    const imageReasonCount = pagesNeedingVision.filter(entry => entry.reasons.includes("image_dominated")).length;
    if (vectorReasonCount > imageReasonCount && vectorReasonCount > 0) documentKind = "vector_heavy";
    else if (imageReasonCount > 0) documentKind = "image_based";
    else if (available.every(({ page }) => !pageHasImageEvidence(page) && !pageHasVectorEvidence(page, classifyPageRouting(page)))) documentKind = "empty";
  }

  return {
    document_kind: documentKind,
    pages_analyzed: analyzedCount,
    pages_needing_vision: pagesNeedingVision,
    pages_not_analyzed: pagesNotAnalyzed,
  };
}

function markPageUnavailable(page, errorCode) {
  page.content_analysis_status = "unavailable";
  page.text_extraction_status = "failed";
  page.image_detection_status = "failed";
  page.graphics_detection_status = "failed";
  page.blank_status = "unknown";
  page.image_op_count = null;
  page.path_op_count = null;
  page.path_segment_count = null;
  page.text_integrity = { status: "unavailable", signals: [] };
  page.analysis_error_codes.push(errorCode);
}

function drawOpsCommandCount(buffer) {
  if (buffer === null || buffer === undefined) return 0;
  if (!Array.isArray(buffer) && !ArrayBuffer.isView(buffer)) {
    throw new Error("Invalid constructPath DrawOPS buffer in operator list.");
  }
  let index = 0;
  let count = 0;
  while (index < buffer.length) {
    const opcode = Number(buffer[index++]);
    const coordinateCount = opcode === 2 ? 6
      : opcode === 3 ? 4
        : opcode === 0 || opcode === 1 ? 2
          : opcode === 4 ? 0
            : null;
    if (coordinateCount === null || index + coordinateCount > buffer.length) {
      throw new Error("Invalid constructPath DrawOPS buffer in operator list.");
    }
    index += coordinateCount;
    count += 1;
  }
  return count;
}

function countOperatorMeasurements(pdfjsLib, operators, imageOps, graphicsOps) {
  if (!Array.isArray(operators?.fnArray)) throw new Error("PDF.js operator list unavailable");
  const fnArray = operators.fnArray;
  const argsArray = Array.isArray(operators.argsArray) ? operators.argsArray : null;
  const constructPath = pdfjsLib.OPS?.constructPath;
  let pathOpCount = 0;
  let pathSegmentCount = 0;
  for (let index = 0; index < fnArray.length; index += 1) {
    if (fnArray[index] !== constructPath) continue;
    pathOpCount += 1;
    if (!argsArray) throw new Error("PDF.js constructPath arguments unavailable");
    const args = argsArray[index];
    if (!Array.isArray(args)) throw new Error("PDF.js constructPath arguments malformed");
    const pathData = args[1];
    if (!Array.isArray(pathData) && !ArrayBuffer.isView(pathData)) {
      throw new Error("PDF.js constructPath data unavailable");
    }
    const drawOps = pathData[0];
    pathSegmentCount += drawOpsCommandCount(drawOps);
  }
  return {
    imageOpCount: fnArray.filter(fn => imageOps.includes(fn)).length,
    graphicsOpCount: fnArray.filter(fn => graphicsOps.includes(fn)).length,
    pathOpCount,
    pathSegmentCount,
  };
}

function finalizePageAnalysis(page) {
  const textComplete = page.text_extraction_status === "complete";
  const operatorsComplete =
    page.image_detection_status === "complete" &&
    page.graphics_detection_status === "complete";

  if (textComplete && operatorsComplete) {
    page.content_analysis_status = "complete";
  } else if (textComplete || operatorsComplete) {
    page.content_analysis_status = "degraded";
  } else if (page.content_analysis_status !== "unavailable") {
    page.content_analysis_status = "degraded";
  }

  if (
    (textComplete && page.text_length > 0) ||
    (operatorsComplete && (page.has_images === true || page.has_graphics === true))
  ) {
    page.blank_status = "not_blank";
  } else if (
    textComplete &&
    operatorsComplete &&
    page.text_length === 0 &&
    page.has_images === false &&
    page.has_graphics === false
  ) {
    page.blank_status = "likely_blank";
  } else {
    page.blank_status = "unknown";
  }
}

/**
 * Analyze page content without allowing failed PDF.js measurements to look
 * like real zero/false observations. Geometry always comes from pdf-lib;
 * text, image, and blankness provenance is explicit for agent safety.
 */
export async function analyzePdfPages({
  pdfLibPages,
  pdfBytes,
  pdfjsLib,
  password,
  maxPages = 200,
  unavailableCode = "PDFJS_UNAVAILABLE",
}) {
  if (!Array.isArray(pdfLibPages)) {
    throw new Error("pdfLibPages must be an array.");
  }
  if (!Number.isInteger(maxPages) || maxPages < 1) {
    throw new Error("maxPages must be an integer >= 1.");
  }

  const pages = pdfLibPages.map(initialPageAnalysis);
  const pagesToAnalyze = Math.min(pages.length, maxPages);
  const analysisErrors = [];

  if (!pdfjsLib) {
    analysisErrors.push({ scope: "document", code: unavailableCode });
    for (let i = 0; i < pagesToAnalyze; i++) {
      markPageUnavailable(pages[i], unavailableCode);
    }
  } else {
    let pdfjsDoc = null;
    try {
      pdfjsDoc = await pdfjsLib.getDocument({
        data: new Uint8Array(pdfBytes),
        password: password || undefined,
        useSystemFonts: true,
        disableFontFace: true,
        verbosity: 0,
      }).promise;
    } catch {
      analysisErrors.push({ scope: "document", code: "PDFJS_DOCUMENT_LOAD_FAILED" });
      for (let i = 0; i < pagesToAnalyze; i++) {
        markPageUnavailable(pages[i], "PDFJS_DOCUMENT_LOAD_FAILED");
      }
    }

    if (pdfjsDoc) {
      const imageOps = [
        pdfjsLib.OPS?.paintImageXObject,
        pdfjsLib.OPS?.paintJpegXObject,
        pdfjsLib.OPS?.paintImageMaskXObject,
        pdfjsLib.OPS?.paintImageMaskXObjectGroup,
        pdfjsLib.OPS?.paintInlineImageXObject,
        pdfjsLib.OPS?.paintInlineImageXObjectGroup,
        pdfjsLib.OPS?.paintImageXObjectRepeat,
        pdfjsLib.OPS?.paintImageMaskXObjectRepeat,
        pdfjsLib.OPS?.paintSolidColorImageMask,
      ].filter(value => value !== undefined && value !== null);
      const graphicsOps = [
        pdfjsLib.OPS?.stroke,
        pdfjsLib.OPS?.closeStroke,
        pdfjsLib.OPS?.fill,
        pdfjsLib.OPS?.eoFill,
        pdfjsLib.OPS?.fillStroke,
        pdfjsLib.OPS?.eoFillStroke,
        pdfjsLib.OPS?.closeFillStroke,
        pdfjsLib.OPS?.closeEOFillStroke,
        pdfjsLib.OPS?.shadingFill,
        pdfjsLib.OPS?.paintXObject,
        pdfjsLib.OPS?.paintFormXObjectBegin,
        pdfjsLib.OPS?.beginAnnotation,
        pdfjsLib.OPS?.constructPath,
        pdfjsLib.OPS?.rawFillPath,
      ].filter(value => value !== undefined && value !== null);

      try {
        for (let i = 0; i < pagesToAnalyze; i++) {
          const pageResult = pages[i];
          let pdfjsPage;
          try {
            pdfjsPage = await pdfjsDoc.getPage(i + 1);
          } catch {
            markPageUnavailable(pageResult, "PDFJS_PAGE_LOAD_FAILED");
            analysisErrors.push({
              scope: "page",
              page: i + 1,
              code: "PDFJS_PAGE_LOAD_FAILED",
            });
            continue;
          }

          try {
            const content = await pdfjsPage.getTextContent();
            const fullText = content.items.map(item => item.str).join("");
            pageResult.text_integrity = deriveTextIntegrityForRouting(
              content.items.filter(item => typeof item?.str === "string").map(item => item.str),
            );
            pageResult.text_length = fullText.length;
            pageResult[ROUTING_TEXT_LENGTH] = fullText.trim().length;
            pageResult.text_snippet = fullText.slice(0, 100);
            pageResult.text_extraction_status = "complete";
            pageResult.analysis_provenance.text = "pdfjs";
          } catch {
            pageResult.text_extraction_status = "failed";
            pageResult.analysis_error_codes.push("PDFJS_TEXT_EXTRACTION_FAILED");
            analysisErrors.push({
              scope: "page",
              page: i + 1,
              code: "PDFJS_TEXT_EXTRACTION_FAILED",
            });
          }

          try {
            if (imageOps.length === 0 || graphicsOps.length === 0) {
              throw new Error("PDF.js content operators unavailable");
            }
            const ops = await pdfjsPage.getOperatorList();
            pageResult.text_visibility = measureTextVisibility(pdfjsLib, ops);
            const measurements = countOperatorMeasurements(pdfjsLib, ops, imageOps, graphicsOps);
            pageResult.image_op_count = measurements.imageOpCount;
            pageResult.path_op_count = measurements.pathOpCount;
            pageResult.path_segment_count = measurements.pathSegmentCount;
            pageResult.has_images = measurements.imageOpCount > 0;
            pageResult.has_graphics = measurements.graphicsOpCount > 0;
            pageResult.image_detection_status = "complete";
            pageResult.graphics_detection_status = "complete";
            pageResult.analysis_provenance.images = "pdfjs";
            pageResult.analysis_provenance.graphics = "pdfjs";
          } catch {
            pageResult.image_detection_status = "failed";
            pageResult.graphics_detection_status = "failed";
            pageResult.analysis_error_codes.push("PDFJS_OPERATOR_ANALYSIS_FAILED");
            analysisErrors.push({
              scope: "page",
              page: i + 1,
              code: "PDFJS_OPERATOR_ANALYSIS_FAILED",
            });
          }

          finalizePageAnalysis(pageResult);
        }
      } finally {
        try {
          await pdfjsDoc.destroy();
        } catch {}
      }
    }
  }

  const likelyBlankPages = pages
    .filter(page => page.blank_status === "likely_blank")
    .map(page => page.page);
  const nonblankPages = pages
    .filter(page => page.blank_status === "not_blank")
    .map(page => page.page);
  const unknownPages = pages
    .filter(page => page.blank_status === "unknown")
    .map(page => page.page);
  const hasFailures = analysisErrors.length > 0;
  const intentionallyPartial = pages.length > pagesToAnalyze;
  const contentAnalysisStatus = hasFailures
    ? "degraded"
    : intentionallyPartial
      ? "partial"
      : "complete";
  const classification = rollupPageClassification(pages, pagesToAnalyze);

  return {
    total_pages: pages.length,
    content_analysis_status: contentAnalysisStatus,
    content_analysis_complete: contentAnalysisStatus === "complete",
    content_pages_requested: pagesToAnalyze,
    content_pages_complete: pages.filter(page => page.content_analysis_status === "complete").length,
    likely_blank_pages: likelyBlankPages,
    nonblank_pages: nonblankPages,
    unknown_pages: unknownPages,
    analysis_errors: analysisErrors,
    retry_guidance: unknownPages.length > 0 ? PAGE_ANALYSIS_RETRY_GUIDANCE : null,
    mutation_guidance: PAGE_ANALYSIS_MUTATION_GUIDANCE,
    classification,
    pages,
  };
}

export function getPageRenderScale({
  width,
  height,
  maxDimensionPx = 1800,
  minScale = 1,
  maxScale = 2.5,
}) {
  if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) {
    throw new Error("width and height must be positive numbers.");
  }
  if (!Number.isFinite(maxDimensionPx) || maxDimensionPx <= 0) {
    throw new Error("maxDimensionPx must be a positive number.");
  }
  const dominantSide = Math.max(width, height);
  const scaleFromDimension = maxDimensionPx / dominantSide;
  const boundedScale = Math.min(Math.max(scaleFromDimension, minScale), maxScale);
  return Math.round(boundedScale * 100) / 100;
}

export function validatePdfRegionBox({
  pageWidth,
  pageHeight,
  x,
  y,
  width,
  height,
}) {
  if (![pageWidth, pageHeight, x, y, width, height].every(Number.isFinite)) {
    throw new Error("pageWidth, pageHeight, x, y, width, and height must all be finite numbers.");
  }
  if (pageWidth <= 0 || pageHeight <= 0) {
    throw new Error("pageWidth and pageHeight must be positive numbers.");
  }
  if (width <= 0 || height <= 0) {
    throw new Error("width and height must be positive numbers.");
  }
  if (x < 0 || y < 0 || x + width > pageWidth || y + height > pageHeight) {
    throw new Error(
      `Region (${x}, ${y}, ${width}x${height}) falls outside page bounds ` +
      `(${pageWidth.toFixed(0)}x${pageHeight.toFixed(0)} pts).`
    );
  }
}

export function getRegionPixelRect({
  x,
  y,
  width,
  height,
  scale,
}) {
  if (![x, y, width, height, scale].every(Number.isFinite)) {
    throw new Error("x, y, width, height, and scale must all be finite numbers.");
  }
  if (scale <= 0) {
    throw new Error("scale must be a positive number.");
  }

  return {
    left: Math.round(x * scale),
    top: Math.round(y * scale),
    width: Math.max(1, Math.round(width * scale)),
    height: Math.max(1, Math.round(height * scale)),
  };
}

function normalizeExtractedText(text) {
  return String(text ?? "")
    .replace(/\r\n/g, "\n")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

export function preparePdfTextResponse(text, { maxChars = 50000 } = {}) {
  if (!Number.isInteger(maxChars) || maxChars < 1) {
    throw new Error("maxChars must be an integer >= 1.");
  }

  const sourceText = String(text ?? "");
  const textFound = sourceText.trim().length > 0;
  const truncated = sourceText.length > maxChars;

  return {
    outputText: truncated ? sourceText.slice(0, maxChars) : sourceText,
    sourceLength: sourceText.length,
    textFound,
    truncated,
  };
}

export function buildPageTextSegments(pageTexts, {
  startPage = 1,
  endPage = pageTexts.length,
  maxCharsPerPage = 4000,
  maxTotalChars = 16000,
} = {}) {
  if (!Array.isArray(pageTexts)) {
    throw new Error("pageTexts must be an array.");
  }
  if (!Number.isInteger(startPage) || startPage < 1) {
    throw new Error("startPage must be an integer >= 1.");
  }
  if (!Number.isInteger(endPage) || endPage < startPage) {
    throw new Error("endPage must be an integer >= startPage.");
  }
  if (!Number.isInteger(maxCharsPerPage) || maxCharsPerPage < 1) {
    throw new Error("maxCharsPerPage must be an integer >= 1.");
  }
  if (!Number.isInteger(maxTotalChars) || maxTotalChars < 1) {
    throw new Error("maxTotalChars must be an integer >= 1.");
  }
  if (pageTexts.length === 0) {
    return {
      totalPages: 0,
      startPage,
      endPage,
      totalSourceChars: 0,
      totalReturnedChars: 0,
      truncated: false,
      pages: [],
    };
  }
  if (endPage > pageTexts.length) {
    throw new Error(`endPage ${endPage} is out of range (1-${pageTexts.length}).`);
  }

  const selectedPages = pageTexts.slice(startPage - 1, endPage);
  const pages = [];
  let remainingChars = maxTotalChars;
  let totalSourceChars = 0;
  let totalReturnedChars = 0;
  let truncated = false;

  for (const rawPage of selectedPages) {
    const normalizedText = normalizeExtractedText(rawPage?.text);
    totalSourceChars += normalizedText.length;

    const charsAvailable = Math.max(Math.min(remainingChars, maxCharsPerPage), 0);
    const returnedText = normalizedText.slice(0, charsAvailable);
    const pageTruncated = normalizedText.length > returnedText.length;
    if (pageTruncated) truncated = true;

    pages.push({
      page: rawPage?.page,
      char_count: normalizedText.length,
      returned_chars: returnedText.length,
      truncated: pageTruncated,
      text: returnedText,
    });

    totalReturnedChars += returnedText.length;
    remainingChars -= returnedText.length;
  }

  return {
    totalPages: pageTexts.length,
    startPage,
    endPage,
    totalSourceChars,
    totalReturnedChars,
    truncated,
    pages,
  };
}

function buildMatchSnippet(text, matchIndex, matchLength, contextChars) {
  const start = Math.max(0, matchIndex - contextChars);
  const end = Math.min(text.length, matchIndex + matchLength + contextChars);
  let snippet = text.slice(start, end).replace(/\s+/g, " ").trim();
  if (start > 0) snippet = `...${snippet}`;
  if (end < text.length) snippet = `${snippet}...`;
  return snippet;
}

export function searchPageTexts(pageTexts, query, {
  maxResults = 10,
  contextChars = 160,
} = {}) {
  if (!Array.isArray(pageTexts)) {
    throw new Error("pageTexts must be an array.");
  }
  const normalizedQuery = String(query ?? "").trim();
  if (!normalizedQuery) {
    throw new Error("query must be a non-empty string.");
  }
  if (!Number.isInteger(maxResults) || maxResults < 1) {
    throw new Error("maxResults must be an integer >= 1.");
  }
  if (!Number.isInteger(contextChars) || contextChars < 10) {
    throw new Error("contextChars must be an integer >= 10.");
  }

  const loweredQuery = normalizedQuery.toLowerCase();
  const matches = [];

  for (const rawPage of pageTexts) {
    const normalizedText = normalizeExtractedText(rawPage?.text);
    if (!normalizedText) continue;

    const loweredText = normalizedText.toLowerCase();
    let fromIndex = 0;
    while (matches.length < maxResults) {
      const matchIndex = loweredText.indexOf(loweredQuery, fromIndex);
      if (matchIndex === -1) break;

      matches.push({
        page: rawPage?.page,
        char_index: matchIndex,
        match_text: normalizedText.slice(matchIndex, matchIndex + normalizedQuery.length),
        snippet: buildMatchSnippet(normalizedText, matchIndex, normalizedQuery.length, contextChars),
      });

      fromIndex = matchIndex + normalizedQuery.length;
    }

    if (matches.length >= maxResults) break;
  }

  return {
    query: normalizedQuery,
    matchCount: matches.length,
    truncated: matches.length >= maxResults,
    matches,
  };
}
