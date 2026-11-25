import { createHash } from "node:crypto";
import path from "node:path";
import { PDFName, PDFNumber } from "pdf-lib";

export const PDF_OBSERVATION_SCHEMA_VERSION = "1.0";
export const PDF_OBSERVATION_PARSER = Object.freeze({
  name: "pdfjs-dist",
  version: "5.4.624",
});
export const PDF_OBSERVATION_LIMITS = Object.freeze({
  max_annotations: 500,
  max_fields: 500,
  max_metadata_characters: 32_768,
});

/**
 * Every coverage reason a document observation may carry, by channel.
 *
 * This vocabulary does not stay inside `get_pdf_info`. `compare_pdfs` copies
 * each observation reason into one of its own channels with a `BEFORE_` or
 * `AFTER_` prefix, and its semantics validator rejects a payload carrying a
 * reason it does not recognise — which turned a perfectly good comparison of
 * two encrypted documents into "Internal output validation failed", because
 * `RAW_PAGE_GEOMETRY_UNAVAILABLE` had never been added to the comparison's
 * copy of this list. So the list lives here, next to the code that emits it,
 * `validatePdfObservationSemantics` rejects anything outside it, and
 * `server/pdf-comparison.js` builds its own set from it rather than restating
 * it. A reason added in one place and forgotten in the other is no longer
 * expressible.
 */
export const PDF_OBSERVATION_COVERAGE_REASONS = Object.freeze({
  pages: Object.freeze([
    "OUTPUT_LIMIT_PAGES_OMITTED",
    "PAGE_LIMIT_REACHED",
    "PAGE_PARSE_PARTIAL",
    "PAGE_PARSE_UNAVAILABLE",
    "RAW_PAGE_GEOMETRY_UNAVAILABLE",
  ]),
  metadata: Object.freeze([
    "METADATA_LIMIT_REACHED",
    "METADATA_PARSE_UNAVAILABLE",
    "METADATA_STREAM_UNBOUNDED",
    "OUTPUT_LIMIT_METADATA_OMITTED",
    "XMP_PARSE_UNAVAILABLE",
  ]),
  form_fields: Object.freeze([
    "FIELD_LIMIT_REACHED",
    "FORM_FIELD_PAGE_GEOMETRY_PARTIAL",
    "FORM_FIELD_PAGE_LIMIT_REACHED",
    "FORM_FIELD_PARSE_UNAVAILABLE",
    "OUTPUT_LIMIT_FORM_FIELDS_OMITTED",
    "WIDGET_OBSERVATION_LIMIT_REACHED",
  ]),
  annotations: Object.freeze([
    "ANNOTATION_LIMIT_REACHED",
    "ANNOTATION_PAGE_LIMIT_REACHED",
    "ANNOTATION_PAGE_PARSE_PARTIAL",
    "ANNOTATION_PARSE_UNAVAILABLE",
    "OUTPUT_LIMIT_ANNOTATIONS_OMITTED",
  ]),
});

const OBSERVATION_COORDINATE_SPACES = Object.freeze({
  display: "pdfjs_viewport_top_left_points",
  native: "pdf_user_space_bottom_left_points",
  requested: "pdfjs_viewport_top_left_points",
  raster: "raster_top_left_pixels",
});

function compareCodePoints(left, right) {
  return left < right ? -1 : left > right ? 1 : 0;
}

function finiteNumber(value) {
  return typeof value === "number" && Number.isFinite(value)
    ? Number(value.toFixed(6))
    : null;
}

export function canonicalizeObservationValue(value, depth = 0) {
  if (depth > 8) return "[depth-limited]";
  if (value === null || typeof value === "boolean" || typeof value === "string") return value;
  if (typeof value === "number") return finiteNumber(value);
  if (typeof value === "bigint") return String(value);
  if (value instanceof Date) return value.toISOString();
  if (ArrayBuffer.isView(value)) {
    return Array.from(value, item => canonicalizeObservationValue(item, depth + 1));
  }
  if (Array.isArray(value)) {
    return value.map(item => canonicalizeObservationValue(item, depth + 1));
  }
  if (!value || typeof value !== "object") return String(value ?? "");
  return Object.fromEntries(
    Object.keys(value)
      .sort(compareCodePoints)
      .filter(key => value[key] !== undefined && typeof value[key] !== "function")
      .map(key => [key, canonicalizeObservationValue(value[key], depth + 1)]),
  );
}

export function canonicalObservationJson(value) {
  return JSON.stringify(canonicalizeObservationValue(value));
}

export function observationSha256(value) {
  return createHash("sha256").update(canonicalObservationJson(value), "utf8").digest("hex");
}

export function publicPdfObservationError(error) {
  if (error?.code === "PASSWORD_REQUIRED") {
    return { code: "PASSWORD_REQUIRED", message: "This PDF requires a password." };
  }
  if (error?.code === "PASSWORD_INCORRECT") {
    return { code: "PASSWORD_INCORRECT", message: "The supplied PDF password is incorrect." };
  }
  if (error?.code === "path_policy_denied") {
    return { code: "path_policy_denied", message: "The requested PDF path is not permitted." };
  }
  if (error?.code === "PDF_CHANGED_DURING_READ") {
    return {
      code: "PDF_CHANGED_DURING_READ",
      message: "The PDF changed while it was being read. Retry the operation.",
    };
  }
  if (error?.code === "PDF_RESOURCE_LIMIT_EXCEEDED") {
    return {
      code: "PDF_RESOURCE_LIMIT_EXCEEDED",
      message: "PDF inspection exceeded its isolated resource budget. Try fewer pages.",
    };
  }
  if (error?.code === "PDF_INPUT_TOO_LARGE") {
    return { code: "PDF_INPUT_TOO_LARGE", message: "The PDF exceeds the supported size limit." };
  }
  if (["ENOENT", "ENOTDIR", "EACCES", "EPERM"].includes(error?.code)) {
    return { code: "PDF_UNAVAILABLE", message: "The PDF could not be opened." };
  }
  return { code: "tool_execution_failed", message: "The PDF could not be inspected." };
}

function stableObservationId(sourceSha256, channel, identity, observedValues) {
  return `${channel}-${observationSha256({
    channel,
    identity,
    observed_values: observedValues,
    source_sha256: sourceSha256,
  })}`;
}

function pdfBox(box, fallback) {
  const source = box && [box.x, box.y, box.width, box.height].every(Number.isFinite)
    ? box
    : fallback;
  const x = finiteNumber(source?.x) ?? 0;
  const y = finiteNumber(source?.y) ?? 0;
  const width = finiteNumber(source?.width) ?? 0;
  const height = finiteNumber(source?.height) ?? 0;
  return [x, y, finiteNumber(x + width), finiteNumber(y + height)];
}

function pdfUserUnit(pdfPage) {
  try {
    const value = pdfPage.doc.context.lookupMaybe(
      pdfPage.node.get(PDFName.of("UserUnit")),
      PDFNumber,
    );
    const userUnit = value?.asNumber?.();
    return Number.isFinite(userUnit) && userUnit > 0 ? finiteNumber(userUnit) : 1;
  } catch {
    return 1;
  }
}

export function pageGeometryFromPdfLib(pdfPage) {
  const size = pdfPage.getSize();
  let media = null;
  let crop = null;
  try { media = pdfPage.getMediaBox(); } catch {}
  try { crop = pdfPage.getCropBox(); } catch {}
  const fallback = { x: 0, y: 0, width: size.width, height: size.height };
  const mediaBox = pdfBox(media, fallback);
  const cropBox = pdfBox(crop, media ?? fallback);
  const rotation = finiteNumber(pdfPage.getRotation()?.angle) ?? 0;
  return {
    geometry_source: "pdf-lib",
    media_box: mediaBox,
    crop_box: cropBox,
    width_points: finiteNumber(mediaBox[2] - mediaBox[0]),
    height_points: finiteNumber(mediaBox[3] - mediaBox[1]),
    rotation,
    user_unit: pdfUserUnit(pdfPage),
    coordinate_space: OBSERVATION_COORDINATE_SPACES.native,
  };
}

export function pageViewFromPdfjs(pdfjsPage) {
  const viewport = pdfjsPage.getViewport({ scale: 1 });
  const viewBox = Array.isArray(pdfjsPage.view) && pdfjsPage.view.length === 4
    ? pdfjsPage.view.map(value => finiteNumber(value) ?? 0)
    : [0, 0, finiteNumber(viewport.width) ?? 0, finiteNumber(viewport.height) ?? 0];
  return {
    view_box: viewBox,
    width_points: finiteNumber(viewport.width),
    height_points: finiteNumber(viewport.height),
    rotation: finiteNumber(pdfjsPage.rotate) ?? 0,
    user_unit: finiteNumber(pdfjsPage.userUnit) ?? 1,
    coordinate_space: OBSERVATION_COORDINATE_SPACES.display,
  };
}

export function displayRegionFromPdfjsRect(rect, viewport) {
  if (!Array.isArray(rect) || rect.length !== 4 || !rect.every(Number.isFinite)) return null;
  let converted;
  try {
    converted = viewport.convertToViewportRectangle(rect);
  } catch {
    return null;
  }
  if (!Array.isArray(converted) || converted.length !== 4 || !converted.every(Number.isFinite)) {
    return null;
  }
  const left = Math.min(converted[0], converted[2]);
  const top = Math.min(converted[1], converted[3]);
  const right = Math.max(converted[0], converted[2]);
  const bottom = Math.max(converted[1], converted[3]);
  return {
    x: finiteNumber(left),
    y: finiteNumber(top),
    width: finiteNumber(right - left),
    height: finiteNumber(bottom - top),
  };
}

function nativeRegion(rect) {
  if (!Array.isArray(rect) || rect.length !== 4 || !rect.every(Number.isFinite)) return null;
  return {
    x1: finiteNumber(Math.min(rect[0], rect[2])),
    y1: finiteNumber(Math.min(rect[1], rect[3])),
    x2: finiteNumber(Math.max(rect[0], rect[2])),
    y2: finiteNumber(Math.max(rect[1], rect[3])),
  };
}

function boundedValue(value, maximumCharacters = 16_384) {
  const normalized = canonicalizeObservationValue(value);
  const encoded = canonicalObservationJson(normalized);
  if (encoded.length <= maximumCharacters) return { value: normalized, truncated: false };
  if (typeof normalized === "string") {
    return { value: normalized.slice(0, Math.max(0, maximumCharacters - 2)), truncated: true };
  }
  return { value: null, truncated: true };
}

// PDF.js lowercases XMP property names (pdf:producer, xmp:modifydate), so
// XMP keys are matched without regard to case; Info keys keep their case.
function metadataAlias(key, { xmp = false } = {}) {
  if (xmp) {
    const lowered = String(key).toLowerCase();
    for (const [name, alias] of Object.entries(METADATA_ALIASES)) {
      if (name.includes(":") && name.toLowerCase() === lowered) return alias;
    }
    return null;
  }
  return METADATA_ALIASES[key] ?? null;
}

const METADATA_ALIASES = Object.freeze({
  Author: "author",
  CreationDate: "creation_date",
  Creator: "creator",
  Keywords: "keywords",
  ModDate: "modification_date",
  Producer: "producer",
  Subject: "subject",
  Title: "title",
  "dc:creator": "author",
  "dc:description": "subject",
  "dc:subject": "keywords",
  "dc:title": "title",
  "pdf:Keywords": "keywords",
  "pdf:Producer": "producer",
  "xmp:CreateDate": "creation_date",
  "xmp:CreatorTool": "creator",
  "xmp:ModifyDate": "modification_date",
});

/** Seconds since the epoch for an Info "D:" date or an XMP ISO date, or null. */
function metadataInstant(value) {
  if (typeof value !== "string") return null;
  const info = /^D:(\d{4})(\d{2})?(\d{2})?(\d{2})?(\d{2})?(\d{2})?([Zz+-])?(\d{2})?'?(\d{2})?'?$/.exec(value.trim());
  if (info) {
    const [, y, mo = "01", d = "01", h = "00", mi = "00", se = "00", sign, oh = "00", om = "00"] = info;
    const utc = Date.UTC(Number(y), Number(mo) - 1, Number(d), Number(h), Number(mi), Number(se));
    const offset = (Number(oh) * 60 + Number(om)) * 60_000 * (sign === "-" ? -1 : sign === "+" ? 1 : 0);
    return Math.floor((utc - offset) / 1000);
  }
  const parsed = Date.parse(value);
  return Number.isNaN(parsed) ? null : Math.floor(parsed / 1000);
}

/**
 * The form in which an Info value and its XMP twin are compared. XMP states
 * authors as a list and keywords as a bag while Info states one string, and
 * Info dates are "D:" strings while XMP's are ISO; comparing the raw forms
 * reported a disagreement after every faithful edit.
 */
function comparableMetadataValue(alias, value) {
  const terms = (input, separator) => (Array.isArray(input) ? input : [input])
    .flatMap(item => String(item ?? "").split(separator))
    .map(item => item.trim())
    .filter(Boolean);
  if (alias === "keywords") return [...new Set(terms(value, /[;,]/))].sort(compareCodePoints);
  if (alias === "author") return terms(value, /;/);
  if (alias === "creation_date" || alias === "modification_date") {
    const instant = metadataInstant(Array.isArray(value) ? value[0] : value);
    if (instant !== null) return instant;
  }
  if (Array.isArray(value) && value.length === 1) return value[0];
  return value;
}

function omittedMetadataKey(key) {
  return `sha256:${createHash("sha256").update(key, "utf8").digest("hex")}`;
}

function boundedMetadataRecord(record, maximumCharacters) {
  const bounded = {
    values: {},
    omitted_keys: [],
    omitted_key_count: 0,
    omitted_keys_truncated: false,
    truncated: false,
  };
  const fits = candidate => serializedCharacters(candidate) <= maximumCharacters;
  for (const key of Object.keys(record ?? {}).sort(compareCodePoints)) {
    const normalized = boundedValue(record[key], Math.min(maximumCharacters, 16_384));
    const withValue = structuredClone(bounded);
    withValue.values[key] = normalized.value;
    if (fits(withValue)) {
      bounded.values[key] = normalized.value;
    } else {
      normalized.truncated = true;
    }
    if (!normalized.truncated) continue;
    bounded.omitted_key_count += 1;
    bounded.truncated = true;
    const descriptor = omittedMetadataKey(key);
    const withDescriptor = structuredClone(bounded);
    withDescriptor.omitted_keys.push(descriptor);
    if (fits(withDescriptor)) bounded.omitted_keys.push(descriptor);
    else bounded.omitted_keys_truncated = true;
  }
  return bounded;
}

export function buildMetadataObservation(sourceSha256, info, xmp, maximumCharacters) {
  const recordBudget = Math.max(256, Math.floor((maximumCharacters - 2048) / 2));
  const boundedInfo = boundedMetadataRecord(info, recordBudget);
  const boundedXmp = boundedMetadataRecord(xmp, recordBudget);
  const infoAliases = new Map();
  const xmpAliases = new Map();
  for (const [key, value] of Object.entries(boundedInfo.values)) {
    const alias = metadataAlias(key);
    if (alias) infoAliases.set(alias, value);
  }
  // Keys are sorted, so pdf:keywords is seen after dc:subject and, being
  // the property that mirrors Info /Keywords exactly, takes precedence.
  for (const [key, value] of Object.entries(boundedXmp.values)) {
    const alias = metadataAlias(key, { xmp: true });
    if (alias) xmpAliases.set(alias, value);
  }
  const disagreements = [...infoAliases.keys()]
    .filter(key => xmpAliases.has(key)
      && canonicalObservationJson(comparableMetadataValue(key, infoAliases.get(key)))
        !== canonicalObservationJson(comparableMetadataValue(key, xmpAliases.get(key))))
    .sort(compareCodePoints)
    .map(property => ({
      property,
      info_value_sha256: observationSha256(infoAliases.get(property)),
      xmp_value_sha256: observationSha256(xmpAliases.get(property)),
    }));
  const observed = {
    info: boundedInfo,
    xmp: boundedXmp,
    disagreements,
    disagreements_truncated: false,
  };
  const result = {
    ...observed,
    observation_sha256: stableObservationId(sourceSha256, "metadata", "document", observed)
      .slice("metadata-".length),
  };
  while (serializedCharacters(result) > maximumCharacters && result.disagreements.length > 0) {
    result.disagreements.pop();
    result.disagreements_truncated = true;
    const withoutDigest = {
      info: result.info,
      xmp: result.xmp,
      disagreements: result.disagreements,
      disagreements_truncated: result.disagreements_truncated,
    };
    result.observation_sha256 = stableObservationId(
      sourceSha256,
      "metadata",
      "document",
      withoutDigest,
    ).slice("metadata-".length);
  }
  if (serializedCharacters(result) > maximumCharacters) {
    throw new Error("The bounded metadata observation exceeds max_metadata_characters.");
  }
  return result;
}

function normalizedFieldType(field) {
  if (typeof field?.type === "string" && field.type.length > 0) return field.type;
  if (field?.fieldType === "Tx") return "text";
  if (field?.fieldType === "Sig") return "signature";
  if (field?.fieldType === "Ch") return field.combo ? "combobox" : "listbox";
  if (field?.fieldType === "Btn") {
    if (field.radioButton) return "radio";
    if (field.checkBox) return "checkbox";
    return "button";
  }
  return "unknown";
}

function fieldOptions(field) {
  const raw = field?.items ?? field?.exportValues ?? field?.exportValue ?? [];
  const values = Array.isArray(raw) ? raw : [raw];
  return values.map(value => canonicalizeObservationValue(value));
}

export function buildFormFieldObservation({
  sourceSha256,
  field,
  widget,
  viewport,
  ordinal,
  recordKind = "field",
}) {
  const page = Number.isInteger(widget?.page) && widget.page >= 0
    ? widget.page + 1
    : Number.isInteger(field?.page) && field.page >= 0
      ? field.page + 1
      : null;
  const rect = widget?.rect ?? field?.rect ?? null;
  const observed = {
    record_kind: recordKind,
    source_object_id: typeof (widget?.id ?? field?.id) === "string"
      ? String(widget?.id ?? field?.id).slice(0, 4096)
      : null,
    name: String(field?.name ?? widget?.fieldName ?? ""),
    type: normalizedFieldType({ ...field, ...widget }),
    value: canonicalizeObservationValue(widget?.fieldValue ?? field?.value ?? null),
    default_value: canonicalizeObservationValue(
      widget?.defaultFieldValue ?? field?.defaultValue ?? null,
    ),
    flags: Number.isSafeInteger(widget?.fieldFlags) ? widget.fieldFlags : 0,
    options: fieldOptions({ ...field, ...widget }),
    widget_page: page,
    widget_native_region: nativeRegion(rect),
    widget_display_region: displayRegionFromPdfjsRect(rect, viewport),
    appearance_state: canonicalizeObservationValue(
      widget?.appearanceState ?? widget?.fieldValue ?? null,
    ),
    rotation: finiteNumber(widget?.rotation ?? field?.rotation) ?? 0,
  };
  const identity = observed.source_object_id === null
    ? { fallback_ordinal: ordinal, name: observed.name, page }
    : { page, source_object_id: observed.source_object_id };
  const id = stableObservationId(sourceSha256, "field", identity, observed);
  return {
    id,
    ...observed,
    value_sha256: observationSha256(observed.value),
    observation_sha256: id.slice("field-".length),
  };
}

function annotationContents(annotation) {
  if (typeof annotation?.contentsObj?.str === "string") return annotation.contentsObj.str;
  return typeof annotation?.contents === "string" ? annotation.contents : "";
}

function inertAnnotationTarget(annotation) {
  if (typeof annotation?.url === "string") return { kind: "external_url", value: annotation.url };
  if (typeof annotation?.unsafeUrl === "string") {
    return { kind: "external_url", value: annotation.unsafeUrl };
  }
  if (annotation?.dest !== undefined && annotation.dest !== null) {
    return { kind: "internal_destination", value: canonicalizeObservationValue(annotation.dest) };
  }
  if (annotation?.action !== undefined && annotation.action !== null) {
    return { kind: "action", value: canonicalizeObservationValue(annotation.action) };
  }
  return { kind: "none", value: null };
}

export function buildAnnotationObservation({
  sourceSha256,
  annotation,
  page,
  viewport,
  ordinal,
}) {
  const target = inertAnnotationTarget(annotation);
  const observed = {
    source_object_id: typeof annotation?.id === "string"
      ? annotation.id.slice(0, 4096)
      : null,
    page,
    subtype: String(annotation?.subtype ?? "Unknown"),
    contents: annotationContents(annotation),
    flags: Number.isSafeInteger(annotation?.annotationFlags) ? annotation.annotationFlags : 0,
    native_region: nativeRegion(annotation?.rect),
    display_region: displayRegionFromPdfjsRect(annotation?.rect, viewport),
    quad_points: canonicalizeObservationValue(annotation?.quadPoints ?? []),
    target_kind: target.kind,
    target_value: target.value,
  };
  const id = stableObservationId(
    sourceSha256,
    "annotation",
    observed.source_object_id === null
      ? { fallback_ordinal: ordinal, page, subtype: observed.subtype }
      : { page, source_object_id: observed.source_object_id, subtype: observed.subtype },
    observed,
  );
  return { id, ...observed, observation_sha256: id.slice("annotation-".length) };
}

function coverageState(status = "supported", reasonCodes = []) {
  return { status, reason_codes: [...new Set(reasonCodes)].sort(compareCodePoints) };
}

function coverageStatus(channel, reasonCodes, hasObservation) {
  const unavailableReasons = new Set({
    annotations: ["ANNOTATION_PARSE_UNAVAILABLE"],
    form_fields: ["FORM_FIELD_PARSE_UNAVAILABLE"],
    metadata: ["METADATA_PARSE_UNAVAILABLE", "METADATA_STREAM_UNBOUNDED"],
    pages: ["PAGE_PARSE_UNAVAILABLE"],
  }[channel] ?? []);
  if (!hasObservation && reasonCodes.some(reason => unavailableReasons.has(reason))) {
    return "unavailable";
  }
  return reasonCodes.length > 0 ? "partial" : "supported";
}

function markPartial(result, channel, reason) {
  result.coverage[channel] = coverageState(
    result.coverage[channel].status === "unavailable" ? "unavailable" : "partial",
    [
    ...result.coverage[channel].reason_codes,
    reason,
    ],
  );
  result.status = "partial";
  if (!result.limitations.includes(reason)) result.limitations.push(reason);
}

function serializedCharacters(value) {
  return JSON.stringify(value).length;
}

export function applyObservationOutputLimit(result, maximumCharacters) {
  const bounded = structuredClone(result);
  const collections = [
    ["annotations", "annotations", "OUTPUT_LIMIT_ANNOTATIONS_OMITTED"],
    ["form_fields", "form_fields", "OUTPUT_LIMIT_FORM_FIELDS_OMITTED"],
    ["pages", "pages", "OUTPUT_LIMIT_PAGES_OMITTED"],
  ];
  for (const [property, channel, reason] of collections) {
    while (serializedCharacters(bounded) > maximumCharacters && bounded[property].items.length > 0) {
      bounded[property].items.pop();
      bounded[property].observed_count = bounded[property].items.length;
      bounded[property].truncated = true;
      markPartial(bounded, channel, reason);
    }
  }
  if (serializedCharacters(bounded) > maximumCharacters) {
    for (const record of [bounded.metadata.info, bounded.metadata.xmp]) {
      record.omitted_key_count += Object.keys(record.values).length;
      record.values = {};
      record.omitted_keys = [];
      record.omitted_keys_truncated = record.omitted_key_count > 0;
      record.truncated = record.omitted_key_count > 0;
    }
    bounded.metadata.disagreements = [];
    bounded.metadata.disagreements_truncated = true;
    const metadataWithoutDigest = {
      info: bounded.metadata.info,
      xmp: bounded.metadata.xmp,
      disagreements: bounded.metadata.disagreements,
      disagreements_truncated: bounded.metadata.disagreements_truncated,
    };
    bounded.metadata.observation_sha256 = stableObservationId(
      bounded.source.sha256,
      "metadata",
      "document",
      metadataWithoutDigest,
    ).slice("metadata-".length);
    markPartial(bounded, "metadata", "OUTPUT_LIMIT_METADATA_OMITTED");
  }
  bounded.limitations.sort(compareCodePoints);
  bounded.observation_sha256 = documentEnvelopeSha256(bounded);
  if (serializedCharacters(bounded) > maximumCharacters) {
    throw new Error("The bounded PDF observation envelope exceeds max_output_characters.");
  }
  return bounded;
}

export function documentEnvelopeSha256(payload) {
  const envelope = structuredClone(payload);
  delete envelope.observation_sha256;
  return observationSha256(envelope);
}

export function buildDocumentObservation({
  source,
  totalPages,
  pageItems,
  pageTruncated,
  pageLimitReached = pageTruncated,
  metadata,
  formFields,
  totalFormFields = formFields.length,
  fieldObjectCount = totalFormFields,
  fieldsTruncated,
  fieldsLimitReached = fieldsTruncated,
  widgetCount = 0,
  matchedWidgetCount = 0,
  unmatchedWidgetCount = 0,
  omittedWidgetCount = 0,
  annotations,
  annotationEncounteredCount = annotations.length,
  annotationsTruncated,
  annotationsLimitReached = annotationsTruncated,
  coverageReasons = {},
  maxPages,
  maxOutputCharacters,
}) {
  const effectivePageTruncated = pageItems.length < totalPages;
  const pageReasons = [...(coverageReasons.pages ?? [])];
  const metadataReasons = [...(coverageReasons.metadata ?? [])];
  const fieldReasons = [...(coverageReasons.form_fields ?? [])];
  const annotationReasons = [...(coverageReasons.annotations ?? [])];
  if (pageLimitReached) pageReasons.push("PAGE_LIMIT_REACHED");
  if (
    metadata.info.truncated
    || metadata.xmp.truncated
    || metadata.disagreements_truncated
  ) metadataReasons.push("METADATA_LIMIT_REACHED");
  if (fieldsLimitReached) fieldReasons.push("FIELD_LIMIT_REACHED");
  if (omittedWidgetCount > 0) fieldReasons.push("WIDGET_OBSERVATION_LIMIT_REACHED");
  if (annotationsLimitReached) annotationReasons.push("ANNOTATION_LIMIT_REACHED");
  const metadataHasObservation = Object.keys(metadata.info.values).length > 0
    || Object.keys(metadata.xmp.values).length > 0
    || metadata.disagreements.length > 0;
  const coverage = {
    pages: coverageState(coverageStatus("pages", pageReasons, pageItems.length > 0), pageReasons),
    metadata: coverageState(
      coverageStatus("metadata", metadataReasons, metadataHasObservation),
      metadataReasons,
    ),
    form_fields: coverageState(
      coverageStatus("form_fields", fieldReasons, formFields.length > 0),
      fieldReasons,
    ),
    annotations: coverageState(
      coverageStatus("annotations", annotationReasons, annotations.length > 0),
      annotationReasons,
    ),
  };
  const limitations = Object.values(coverage).flatMap(channel => channel.reason_codes);
  const result = {
    schema_version: PDF_OBSERVATION_SCHEMA_VERSION,
    status: limitations.length === 0 ? "complete" : "partial",
    source: {
      canonical_path: source.canonical_path,
      file_name: source.file_name,
      size_bytes: source.size_bytes,
      sha256: source.sha256,
      identity_method: "race_aware_descriptor_sha256",
    },
    parser: PDF_OBSERVATION_PARSER,
    coverage,
    limits: {
      max_pages: maxPages,
      max_fields: PDF_OBSERVATION_LIMITS.max_fields,
      max_annotations: PDF_OBSERVATION_LIMITS.max_annotations,
      max_metadata_characters: PDF_OBSERVATION_LIMITS.max_metadata_characters,
      max_output_characters: maxOutputCharacters,
    },
    pages: {
      total_count: totalPages,
      observed_count: pageItems.length,
      truncated: effectivePageTruncated,
      items: pageItems,
    },
    metadata,
    form_fields: {
      field_object_count: fieldObjectCount,
      total_count: totalFormFields,
      observed_count: formFields.length,
      truncated: fieldsTruncated,
      widget_count: widgetCount,
      matched_widget_count: matchedWidgetCount,
      unmatched_widget_count: unmatchedWidgetCount,
      omitted_widget_count: omittedWidgetCount,
      items: formFields,
    },
    annotations: {
      encountered_count: annotationEncounteredCount,
      observed_count: annotations.length,
      truncated: annotationsTruncated,
      items: annotations,
    },
    limitations: [...new Set(limitations)].sort(compareCodePoints),
    observation_sha256: "0".repeat(64),
  };
  return applyObservationOutputLimit(result, maxOutputCharacters);
}

export function buildPageObservation(sourceSha256, page, geometry) {
  const observed = { page, ...geometry };
  const id = stableObservationId(sourceSha256, "page", { page }, observed);
  return { ...observed, observation_sha256: id.slice("page-".length) };
}

export function buildRenderObservation({
  existing,
  source,
  geometry,
  pageView,
  page,
  requestedRegion,
  renderedRegion,
  rendererPolicy,
  pngSha256,
  rawPixelSha256,
  rawPixelStatus,
}) {
  const observed = {
    observation_schema_version: PDF_OBSERVATION_SCHEMA_VERSION,
    source: {
      canonical_path: source.canonical_path,
      file_name: source.file_name,
      size_bytes: source.size_bytes,
      sha256: source.sha256,
    },
    page_geometry: geometry,
    page_view: pageView,
    requested_coordinate_space: OBSERVATION_COORDINATE_SPACES.requested,
    rendered_coordinate_space: OBSERVATION_COORDINATE_SPACES.raster,
    requested_region: requestedRegion,
    rendered_region: renderedRegion,
    renderer_policy: rendererPolicy,
    png_sha256: pngSha256,
    raw_pixel_sha256: rawPixelSha256,
    raw_pixel_status: rawPixelStatus,
  };
  return {
    ...existing,
    ...observed,
    observation_sha256: observationSha256({
      source_sha256: source.sha256,
      channel: "render",
      page,
      observed,
    }),
  };
}

function semanticAssertion(condition, message) {
  if (!condition) throw new Error(`PDF observation semantic validation failed: ${message}.`);
}

function observedField(field) {
  return {
    record_kind: field.record_kind,
    source_object_id: field.source_object_id,
    name: field.name,
    type: field.type,
    value: field.value,
    default_value: field.default_value,
    flags: field.flags,
    options: field.options,
    widget_page: field.widget_page,
    widget_native_region: field.widget_native_region,
    widget_display_region: field.widget_display_region,
    appearance_state: field.appearance_state,
    rotation: field.rotation,
  };
}

function observedAnnotation(annotation) {
  return {
    source_object_id: annotation.source_object_id,
    page: annotation.page,
    subtype: annotation.subtype,
    contents: annotation.contents,
    flags: annotation.flags,
    native_region: annotation.native_region,
    display_region: annotation.display_region,
    quad_points: annotation.quad_points,
    target_kind: annotation.target_kind,
    target_value: annotation.target_value,
  };
}

export function validatePdfObservationSemantics(payload) {
  semanticAssertion(path.isAbsolute(payload.source.canonical_path),
    "source canonical path is not absolute");
  semanticAssertion(path.basename(payload.source.canonical_path) === payload.source.file_name,
    "source file name does not match canonical path");
  semanticAssertion(Number.isSafeInteger(payload.source.size_bytes)
    && payload.source.size_bytes >= 1
    && payload.source.size_bytes <= 250 * 1024 * 1024, "source size is invalid");
  semanticAssertion(payload.source.identity_method === "race_aware_descriptor_sha256",
    "source identity method mismatch");
  semanticAssertion(payload.limits.max_fields === PDF_OBSERVATION_LIMITS.max_fields,
    "form field limit mismatch");
  semanticAssertion(payload.limits.max_annotations === PDF_OBSERVATION_LIMITS.max_annotations,
    "annotation limit mismatch");
  semanticAssertion(
    payload.limits.max_metadata_characters === PDF_OBSERVATION_LIMITS.max_metadata_characters,
    "metadata limit mismatch",
  );
  semanticAssertion(payload.pages.observed_count === payload.pages.items.length,
    "page observation count mismatch");
  semanticAssertion(payload.form_fields.observed_count === payload.form_fields.items.length,
    "form field observation count mismatch");
  semanticAssertion(payload.annotations.observed_count === payload.annotations.items.length,
    "annotation observation count mismatch");
  semanticAssertion(payload.pages.total_count >= payload.pages.observed_count,
    "page total is smaller than observed count");
  semanticAssertion(Number.isSafeInteger(payload.pages.total_count)
    && payload.pages.total_count >= 1, "page total is invalid");
  semanticAssertion(payload.form_fields.total_count >= payload.form_fields.observed_count,
    "form field total is smaller than observed count");
  semanticAssertion(payload.annotations.encountered_count >= payload.annotations.observed_count,
    "annotation encountered count is smaller than observed count");
  semanticAssertion(payload.pages.observed_count <= payload.limits.max_pages,
    "page observation limit exceeded");
  semanticAssertion(payload.form_fields.observed_count <= payload.limits.max_fields,
    "form field observation limit exceeded");
  semanticAssertion(payload.annotations.observed_count <= payload.limits.max_annotations,
    "annotation observation limit exceeded");
  semanticAssertion(serializedCharacters(payload) <= payload.limits.max_output_characters,
    "output character limit exceeded");
  semanticAssertion(
    serializedCharacters(payload.metadata) <= payload.limits.max_metadata_characters,
    "metadata character limit exceeded",
  );
  const limitations = [...new Set(Object.values(payload.coverage)
    .flatMap(channel => channel.reason_codes))].sort(compareCodePoints);
  semanticAssertion(canonicalObservationJson(limitations)
    === canonicalObservationJson(payload.limitations), "limitation coverage mismatch");
  semanticAssertion(payload.status === (limitations.length === 0 ? "complete" : "partial"),
    "document status mismatch");
  const metadataHasObservation = Object.keys(payload.metadata.info.values).length > 0
    || Object.keys(payload.metadata.xmp.values).length > 0
    || payload.metadata.disagreements.length > 0;
  const channelObservation = {
    pages: payload.pages.observed_count > 0,
    metadata: metadataHasObservation,
    form_fields: payload.form_fields.observed_count > 0,
    annotations: payload.annotations.observed_count > 0,
  };
  for (const [channel, coverage] of Object.entries(payload.coverage)) {
    semanticAssertion(canonicalObservationJson(coverage.reason_codes)
      === canonicalObservationJson([...new Set(coverage.reason_codes)].sort(compareCodePoints)),
    `${channel} coverage reasons are not unique and sorted`);
    semanticAssertion(coverage.reason_codes.length > 0 || coverage.status === "supported",
      `${channel} unavailable or partial coverage has no reason`);
    // Every reason has to be one this module publishes, because `compare_pdfs`
    // inherits this vocabulary and refuses a reason it has never heard of. An
    // unregistered reason fails here, on the tool that emitted it, instead of
    // reappearing downstream as an internal validation error.
    semanticAssertion(
      coverage.reason_codes.every(
        reason => PDF_OBSERVATION_COVERAGE_REASONS[channel].includes(reason),
      ),
      `${channel} coverage carries a reason outside the published vocabulary`,
    );
    semanticAssertion(
      coverage.status === coverageStatus(channel, coverage.reason_codes, channelObservation[channel]),
      `${channel} coverage status does not follow its evidence and reasons`,
    );
  }
  semanticAssertion(payload.pages.truncated
    === (payload.pages.observed_count < payload.pages.total_count),
  "page truncation flag mismatch");
  semanticAssertion(!payload.pages.truncated || payload.coverage.pages.reason_codes.length > 0,
    "page truncation has no reason");
  const pageLimitReached = payload.pages.total_count > payload.limits.max_pages;
  semanticAssertion(
    payload.coverage.pages.reason_codes.includes("PAGE_LIMIT_REACHED") === pageLimitReached,
    "page limit reason mismatch",
  );

  const fieldReasons = new Set(payload.coverage.form_fields.reason_codes);
  const expectedFieldTruncation = payload.form_fields.observed_count < payload.form_fields.total_count
    || fieldReasons.has("FORM_FIELD_PAGE_LIMIT_REACHED")
    || fieldReasons.has("WIDGET_OBSERVATION_LIMIT_REACHED")
    || fieldReasons.has("OUTPUT_LIMIT_FORM_FIELDS_OMITTED");
  semanticAssertion(payload.form_fields.truncated === expectedFieldTruncation,
    "form field truncation flag mismatch");
  semanticAssertion(!payload.form_fields.truncated || fieldReasons.size > 0,
    "form field truncation has no reason");
  semanticAssertion(
    fieldReasons.has("FIELD_LIMIT_REACHED")
      === (payload.form_fields.total_count > payload.limits.max_fields),
    "form field cap reason mismatch",
  );
  semanticAssertion(payload.form_fields.widget_count
    === payload.form_fields.matched_widget_count + payload.form_fields.unmatched_widget_count,
  "widget accounting mismatch");
  semanticAssertion(payload.form_fields.total_count
    === payload.form_fields.field_object_count + payload.form_fields.unmatched_widget_count,
  "form field total accounting mismatch");
  for (const count of [
    payload.form_fields.field_object_count,
    payload.form_fields.total_count,
    payload.form_fields.observed_count,
    payload.form_fields.widget_count,
    payload.form_fields.matched_widget_count,
    payload.form_fields.unmatched_widget_count,
    payload.form_fields.omitted_widget_count,
    payload.annotations.encountered_count,
    payload.annotations.observed_count,
  ]) {
    semanticAssertion(Number.isSafeInteger(count) && count >= 0,
      "observation accounting contains a negative or unsafe count");
  }
  semanticAssertion(payload.form_fields.omitted_widget_count
    <= payload.form_fields.widget_count, "omitted widget count is invalid");
  semanticAssertion(
    fieldReasons.has("WIDGET_OBSERVATION_LIMIT_REACHED")
      === (payload.form_fields.omitted_widget_count > 0),
    "widget omission reason mismatch",
  );

  const annotationReasons = new Set(payload.coverage.annotations.reason_codes);
  const expectedAnnotationTruncation = payload.annotations.observed_count
    < payload.annotations.encountered_count
    || annotationReasons.has("ANNOTATION_PAGE_LIMIT_REACHED")
    || annotationReasons.has("OUTPUT_LIMIT_ANNOTATIONS_OMITTED");
  semanticAssertion(payload.annotations.truncated === expectedAnnotationTruncation,
    "annotation truncation flag mismatch");
  semanticAssertion(!payload.annotations.truncated || annotationReasons.size > 0,
    "annotation truncation has no reason");
  semanticAssertion(
    annotationReasons.has("ANNOTATION_LIMIT_REACHED")
      === (payload.annotations.encountered_count > payload.limits.max_annotations),
    "annotation cap reason mismatch",
  );

  const pageNumbers = new Set();
  for (const page of payload.pages.items) {
    semanticAssertion(!pageNumbers.has(page.page), `duplicate page ${page.page}`);
    pageNumbers.add(page.page);
    const observed = {
      page: page.page,
      geometry_source: page.geometry_source,
      media_box: page.media_box,
      crop_box: page.crop_box,
      width_points: page.width_points,
      height_points: page.height_points,
      rotation: page.rotation,
      user_unit: page.user_unit,
      coordinate_space: page.coordinate_space,
    };
    const expected = stableObservationId(
      payload.source.sha256,
      "page",
      { page: page.page },
      observed,
    ).slice("page-".length);
    semanticAssertion(page.observation_sha256 === expected,
      `page ${page.page} digest mismatch`);
  }

  const metadataWithoutDigest = {
    info: payload.metadata.info,
    xmp: payload.metadata.xmp,
    disagreements: payload.metadata.disagreements,
    disagreements_truncated: payload.metadata.disagreements_truncated,
  };
  const metadataDigest = stableObservationId(
    payload.source.sha256,
    "metadata",
    "document",
    metadataWithoutDigest,
  ).slice("metadata-".length);
  semanticAssertion(payload.metadata.observation_sha256 === metadataDigest,
    "metadata digest mismatch");
  const metadataReasons = new Set(payload.coverage.metadata.reason_codes);
  const metadataTruncated = payload.metadata.info.truncated
    || payload.metadata.xmp.truncated
    || payload.metadata.disagreements_truncated;
  semanticAssertion(!metadataTruncated
    || metadataReasons.has("METADATA_LIMIT_REACHED")
    || metadataReasons.has("OUTPUT_LIMIT_METADATA_OMITTED"),
  "metadata truncation has no cap reason");
  semanticAssertion(!metadataReasons.has("METADATA_LIMIT_REACHED") || metadataTruncated,
    "metadata cap reason has no truncation evidence");
  for (const [name, record] of Object.entries({
    info: payload.metadata.info,
    xmp: payload.metadata.xmp,
  })) {
    semanticAssertion(record.omitted_key_count >= record.omitted_keys.length,
      `${name} omitted metadata count mismatch`);
    semanticAssertion(record.truncated === (record.omitted_key_count > 0),
      `${name} metadata truncation mismatch`);
    semanticAssertion(!record.omitted_keys_truncated
      || record.omitted_key_count > record.omitted_keys.length,
    `${name} omitted-key reporting mismatch`);
  }

  const fieldIds = new Set();
  let retainedUnmatchedWidgets = 0;
  for (let index = 0; index < payload.form_fields.items.length; index += 1) {
    const field = payload.form_fields.items[index];
    if (field.record_kind === "unmatched_widget") retainedUnmatchedWidgets += 1;
    semanticAssertion(!fieldIds.has(field.id), `duplicate form field ID ${field.id}`);
    fieldIds.add(field.id);
    const observed = observedField(field);
    const expectedId = stableObservationId(
      payload.source.sha256,
      "field",
      field.source_object_id === null
        ? { fallback_ordinal: index + 1, name: field.name, page: field.widget_page }
        : { page: field.widget_page, source_object_id: field.source_object_id },
      observed,
    );
    semanticAssertion(field.id === expectedId, `form field ${field.id} ID mismatch`);
    semanticAssertion(field.observation_sha256 === expectedId.slice("field-".length),
      `form field ${field.id} digest mismatch`);
    semanticAssertion(field.value_sha256 === observationSha256(field.value),
      `form field ${field.id} value digest mismatch`);
  }
  semanticAssertion(retainedUnmatchedWidgets <= payload.form_fields.unmatched_widget_count,
    "retained unmatched widgets exceed encountered unmatched widgets");

  const annotationIds = new Set();
  for (let index = 0; index < payload.annotations.items.length; index += 1) {
    const annotation = payload.annotations.items[index];
    semanticAssertion(annotation.subtype !== "Widget",
      `widget ${annotation.id} leaked into ordinary annotations`);
    semanticAssertion(!annotationIds.has(annotation.id),
      `duplicate annotation ID ${annotation.id}`);
    annotationIds.add(annotation.id);
    const observed = observedAnnotation(annotation);
    const expectedId = stableObservationId(
      payload.source.sha256,
      "annotation",
      annotation.source_object_id === null
        ? { fallback_ordinal: index + 1, page: annotation.page, subtype: annotation.subtype }
        : {
            page: annotation.page,
            source_object_id: annotation.source_object_id,
            subtype: annotation.subtype,
          },
      observed,
    );
    semanticAssertion(annotation.id === expectedId,
      `annotation ${annotation.id} ID mismatch`);
    semanticAssertion(annotation.observation_sha256 === expectedId.slice("annotation-".length),
      `annotation ${annotation.id} digest mismatch`);
  }
  semanticAssertion(payload.observation_sha256 === documentEnvelopeSha256(payload),
    "document envelope digest mismatch");
  return payload;
}

export function validateRenderObservationSemantics(payload) {
  semanticAssertion(path.isAbsolute(payload.source.canonical_path),
    "render source path is not absolute");
  semanticAssertion(payload.source.file_name === payload.file_name,
    "render source file name mismatch");
  semanticAssertion(path.basename(payload.source.canonical_path) === payload.source.file_name,
    "render source envelope mismatch");
  semanticAssertion(Number.isSafeInteger(payload.source.size_bytes)
    && payload.source.size_bytes >= 1
    && payload.source.size_bytes <= 250 * 1024 * 1024, "render source size is invalid");
  semanticAssertion(payload.raw_pixel_status === "available"
    ? payload.raw_pixel_sha256 !== null
    : payload.raw_pixel_sha256 === null, "raw pixel status mismatch");
  semanticAssertion(payload.requested_region.x === payload.region_points?.x
    || payload.region_points === undefined, "requested region x mismatch");
  semanticAssertion(payload.requested_region.y === payload.region_points?.y
    || payload.region_points === undefined, "requested region y mismatch");
  semanticAssertion(payload.requested_region.width === payload.region_points?.width
    || payload.region_points === undefined, "requested region width mismatch");
  semanticAssertion(payload.requested_region.height === payload.region_points?.height
    || payload.region_points === undefined, "requested region height mismatch");
  semanticAssertion(payload.rendered_region.width === payload.rendered_width_px,
    "rendered region width mismatch");
  semanticAssertion(payload.rendered_region.height === payload.rendered_height_px,
    "rendered region height mismatch");
  semanticAssertion(payload.requested_region.x >= 0 && payload.requested_region.y >= 0,
    "requested render region has a negative origin");
  semanticAssertion(payload.requested_region.x + payload.requested_region.width
    <= payload.page_view.width_points + 0.000001, "requested region exceeds page view width");
  semanticAssertion(payload.requested_region.y + payload.requested_region.height
    <= payload.page_view.height_points + 0.000001, "requested region exceeds page view height");
  if (payload.region_points === undefined) {
    semanticAssertion(payload.requested_region.x === 0 && payload.requested_region.y === 0,
      "whole-page request origin mismatch");
    semanticAssertion(payload.requested_region.width === payload.page_view.width_points
      && payload.requested_region.height === payload.page_view.height_points,
    "whole-page request dimensions mismatch");
  }
  const observed = {
    observation_schema_version: payload.observation_schema_version,
    source: payload.source,
    page_geometry: payload.page_geometry,
    page_view: payload.page_view,
    requested_coordinate_space: payload.requested_coordinate_space,
    rendered_coordinate_space: payload.rendered_coordinate_space,
    requested_region: payload.requested_region,
    rendered_region: payload.rendered_region,
    renderer_policy: payload.renderer_policy,
    png_sha256: payload.png_sha256,
    raw_pixel_sha256: payload.raw_pixel_sha256,
    raw_pixel_status: payload.raw_pixel_status,
  };
  const expectedDigest = observationSha256({
    source_sha256: payload.source.sha256,
    channel: "render",
    page: payload.page,
    observed,
  });
  semanticAssertion(payload.observation_sha256 === expectedDigest,
    "render observation digest mismatch");
  return payload;
}

export { OBSERVATION_COORDINATE_SPACES };
