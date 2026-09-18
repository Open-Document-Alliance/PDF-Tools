import { AjvJsonSchemaValidator } from "@modelcontextprotocol/server/validators/ajv";
import { validatePdfLayoutSemantics } from "./layout-extraction.js";
import { validateMarkdownConversionSemantics } from "./markdown-conversion.js";
import {
  validatePdfObservationSemantics,
  validateRenderObservationSemantics,
} from "./pdf-observations.js";
import { validatePdfComparisonSemantics } from "./pdf-comparison.js";
import { validateAccessibilityInspectionResult } from "./accessibility-inspection.js";
import {
  TABLE_PROPOSAL_CLAIM_BOUNDARY,
  TABLE_PROPOSAL_REASON_CODES,
  TABLE_PROPOSAL_VERIFIER,
  validateTableProposalVerificationResult,
} from "./table-proposal-verification.js";

const string = { type: "string" };
const number = { type: "number" };
const integer = { type: "integer" };
const boolean = { type: "boolean" };
const stringArray = { type: "array", items: string };
const integerArray = { type: "array", items: integer };
const nullable = schema => ({ anyOf: [schema, { type: "null" }] });
const object = (properties, required = Object.keys(properties), additionalProperties = false) => ({
  type: "object",
  properties,
  required,
  additionalProperties,
});
const arrayOf = items => ({ type: "array", items });
const enumString = values => ({ type: "string", enum: values });

const fieldValue = {
  anyOf: [string, boolean, stringArray],
};
const formField = object({
  name: string,
  type: enumString(["text", "checkbox", "radio", "dropdown", "unknown"]),
  options: stringArray,
  currentValue: fieldValue,
});
const activeDocumentProperties = {
  pdfPath: string,
  totalBytes: integer,
  initialPage: integer,
  fields: arrayOf(formField),
  fieldCount: integer,
  hasFormFields: boolean,
  active_path: string,
  backup_path: nullable(string),
  last_mutation_tool: nullable(string),
  last_mutation_at: nullable(string),
};
const activeDocument = (extra = {}) => object({
  ...activeDocumentProperties,
  ...extra,
});

const pageTextPreview = object({
  page: integer,
  char_count: integer,
  returned_chars: integer,
  truncated: boolean,
  text: string,
});
const pageReadError = nullable(object({
  page: integer,
  code: { const: "PDFJS_PAGE_READ_FAILED" },
}));
const regionPoints = object({
  x: number,
  y: number,
  width: number,
  height: number,
});
const sha256Digest = { type: "string", pattern: "^[a-f0-9]{64}$" };
const pageBox = {
  type: "array",
  items: number,
  minItems: 4,
  maxItems: 4,
};
const observationCoverage = object({
  status: enumString(["supported", "partial", "unavailable"]),
  reason_codes: stringArray,
});
const observationSource = object({
  canonical_path: string,
  file_name: string,
  size_bytes: integer,
  sha256: sha256Digest,
});
const comparisonSource = object({
  canonical_path: string,
  file_name: string,
  size_bytes: integer,
  sha256: sha256Digest,
  page_count: integer,
  identity_method: { const: "race_aware_descriptor_sha256" },
  parser: object({ name: { const: "pdfjs-dist" }, version: { const: "5.4.624" } }),
  observation_sha256: sha256Digest,
});
const comparisonCoverage = object({
  status: enumString(["supported", "partial", "unavailable"]),
  reason_codes: stringArray,
});
const accessibilityCheck = object({
  id: enumString([
    "parseable_pdf",
    "catalog_marked_true",
    "document_language_present",
    "document_title_present",
    "display_document_title_true",
    "structure_tree_root_dictionary_present",
    "structure_root_k_entry_resolves",
    "structure_parent_tree_entry_resolves",
  ]),
  status: enumString(["observed", "missing", "unavailable"]),
  observation_code: enumString([
    "PARSE_SUCCEEDED",
    "PARSE_FAILED",
    "TRUE",
    "FALSE",
    "NONEMPTY_TEXT",
    "BLANK_OR_CONTROL_ONLY",
    "DICTIONARY_PRESENT",
    "ABSENT_OR_WRONG_TYPE",
    "ENTRY_RESOLVES",
    "ENTRY_ABSENT_OR_UNRESOLVED",
    "NOT_INSPECTED",
  ]),
  limitation_code: enumString([
    "PARSE_DOES_NOT_ESTABLISH_TAG_SEMANTICS",
    "MARKED_FLAG_IS_NOT_TAG_QUALITY_EVIDENCE",
    "LANGUAGE_VALUE_AND_CHANGES_NOT_ASSESSED",
    "TITLE_MEANING_NOT_ASSESSED",
    "VIEWER_PREFERENCE_SIGNAL_ONLY",
    "STRUCTURE_ROOT_CONTENTS_NOT_VALIDATED",
    "STRUCTURE_HIERARCHY_ROLES_AND_ORDER_NOT_VALIDATED",
    "PARENT_TREE_NUMBER_TREE_AND_MAPPINGS_NOT_VALIDATED",
  ]),
  reason_code: nullable({ const: "STRICT_PARSE_FAILED" }),
});
const comparisonImmutability = object({
  initial_sha256: sha256Digest,
  final_sha256: sha256Digest,
  initial_size_bytes: integer,
  final_size_bytes: integer,
  unchanged: { const: true },
});
const comparisonAlignment = object({
  before_page: nullable(integer),
  after_page: nullable(integer),
  relation: enumString(["same", "moved", "inserted", "deleted"]),
  anchor_digest: sha256Digest,
  match_basis: enumString(["exact_composite_anchor", "unique_normalized_text", "weighted_assignment", "repeated_ambiguous", "unmatched"]),
  score: number,
  ambiguity_group: nullable(string),
});
const comparisonObservation = object({
  id: { type: "string", pattern: "^evidence\\.[a-z_]+\\.[0-9]{6}$" },
  channel: enumString(["semantic", "text", "structure", "form_field", "annotation", "metadata", "visual"]),
  side: enumString(["before", "after"]),
  document_sha256: sha256Digest,
  page: integer,
  page_box: pageBox,
  rotation: number,
  coordinate_space: { const: "pdfjs_viewport_top_left_points" },
  native_region: nullable(pageBox),
  display_region: pageBox,
  canonical_value: {},
  value_sha256: sha256Digest,
  raw_result_sha256: sha256Digest,
  observation_sha256: sha256Digest,
});
const comparisonFacet = object({
  channel: enumString(["semantic", "text", "structure", "form_field", "annotation", "metadata", "visual"]),
  operation: enumString(["added", "removed", "modified", "moved"]),
  before_evidence_id: nullable(string),
  after_evidence_id: nullable(string),
});
const comparisonChange = object({
  id: { type: "string", pattern: "^change\\.[0-9]{6}$" },
  kind: enumString(["semantic_text", "text", "structure", "form_field", "widget", "annotation", "metadata", "visual"]),
  operation: enumString(["added", "removed", "modified", "moved"]),
  salience: enumString(["material", "minor", "noise", "unknown"]),
  summary: string,
  facets: arrayOf(comparisonFacet),
  presentation: object({
    mode: enumString(["default_material", "forensic"]),
    disposition: enumString(["report", "suppress"]),
    reversible_reason_code: nullable(string),
  }),
});
const observationPageGeometry = object({
  geometry_source: enumString(["pdf-lib", "pdfjs-view-fallback"]),
  media_box: nullable(pageBox),
  crop_box: pageBox,
  width_points: number,
  height_points: number,
  rotation: number,
  user_unit: number,
  coordinate_space: { const: "pdf_user_space_bottom_left_points" },
});
const observationPageView = object({
  view_box: pageBox,
  width_points: number,
  height_points: number,
  rotation: number,
  user_unit: number,
  coordinate_space: { const: "pdfjs_viewport_top_left_points" },
});
const nativeObservationRegion = nullable(object({
  x1: number,
  y1: number,
  x2: number,
  y2: number,
}));
const displayObservationRegion = nullable(regionPoints);
const metadataRecord = object({
  values: { type: "object", additionalProperties: true },
  omitted_keys: stringArray,
  omitted_key_count: integer,
  omitted_keys_truncated: boolean,
  truncated: boolean,
});
const metadataObservation = object({
  info: metadataRecord,
  xmp: metadataRecord,
  disagreements: arrayOf(object({
    property: string,
    info_value_sha256: sha256Digest,
    xmp_value_sha256: sha256Digest,
  })),
  disagreements_truncated: boolean,
  observation_sha256: sha256Digest,
});
const pageObservation = object({
  page: integer,
  geometry_source: enumString(["pdf-lib", "pdfjs-view-fallback"]),
  media_box: nullable(pageBox),
  crop_box: pageBox,
  width_points: number,
  height_points: number,
  rotation: number,
  user_unit: number,
  coordinate_space: { const: "pdf_user_space_bottom_left_points" },
  observation_sha256: sha256Digest,
});
const formFieldObservation = object({
  id: { type: "string", pattern: "^field-[a-f0-9]{64}$" },
  record_kind: enumString(["field", "unmatched_widget"]),
  source_object_id: nullable(string),
  name: string,
  type: string,
  value: {},
  default_value: {},
  flags: integer,
  options: arrayOf({}),
  widget_page: nullable(integer),
  widget_native_region: nativeObservationRegion,
  widget_display_region: displayObservationRegion,
  appearance_state: {},
  rotation: number,
  value_sha256: sha256Digest,
  observation_sha256: sha256Digest,
});
const annotationObservation = object({
  id: { type: "string", pattern: "^annotation-[a-f0-9]{64}$" },
  source_object_id: nullable(string),
  page: integer,
  subtype: string,
  contents: string,
  flags: integer,
  native_region: nativeObservationRegion,
  display_region: displayObservationRegion,
  quad_points: {},
  target_kind: enumString(["external_url", "internal_destination", "action", "none"]),
  target_value: {},
  observation_sha256: sha256Digest,
});
const placement = object({
  label: string,
  page: integer,
  x: number,
  y: number,
  width: number,
  height: number,
});
const fillError = object({ field: string, error: string });
const signingDocumentIdentity = object({
  canonical_path: string,
  size_bytes: integer,
  sha256: sha256Digest,
  identity_method: { const: "race_aware_descriptor_sha256" },
});
const signingBackupIdentity = object({
  canonical_path: string,
  size_bytes: integer,
  sha256: sha256Digest,
  identity_method: { const: "immutable_original_backup_record_sha256" },
});
const signingPageBox = object({
  origin_x: number,
  origin_y: number,
  width: number,
  height: number,
});
const signingPageGeometry = object({
  page: integer,
  rotation_degrees: { type: "integer", enum: [0, 90, 180, 270] },
  media_box: signingPageBox,
  crop_box: signingPageBox,
});
const signingFieldOutcome = object({
  field_name: string,
  status: enumString(["written", "skipped", "failed"]),
  reason_code: nullable(enumString(["field_write_failed"])),
});
const signingParticipantBinding = object({
  status: enumString(["bound", "partial", "unbound"]),
  participant_id: nullable(string),
  participant_role: nullable(string),
});
const signingPreparationZone = object({
  zone_id: { type: "string", pattern: "^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$" },
  label: string,
  field_type: enumString([
    "signature", "initials", "date", "printed_name", "witness_signature", "unspecified",
  ]),
  page: integer,
  native_region: regionPoints,
  display_region: regionPoints,
  visibility_status: enumString(["visible", "partially_clipped", "outside_crop_box"]),
  coordinate_space_version: { const: "pdf-tools.media-box-top-left-points.v1" },
  evidence_source: enumString(["caller_supplied", "detect_signature_zones", "acroform"]),
  evidence_binding_status: { const: "caller_declared" },
  participant_binding: signingParticipantBinding,
});
const signingPreparationMissingInput = object({
  code: enumString([
    "NO_SIGNATURE_ZONES",
    "ZONE_TYPE_UNSPECIFIED",
    "ZONE_PARTICIPANT_BINDING_MISSING",
    "ZONE_PARTICIPANT_BINDING_PARTIAL",
    "ZONE_OUTSIDE_CROP_BOX",
    "ZONE_PARTIALLY_CLIPPED",
    "FIELD_WRITE_FAILED",
  ]),
  zone_id: nullable(string),
  field_name: nullable(string),
});
const signingPreparationReceipt = object({
  schema_version: { const: "1.0" },
  preparation_engine: { const: "pdf-tools.prepare-signing-packet.v1" },
  source_document: signingDocumentIdentity,
  prepared_document: signingDocumentIdentity,
  source_preservation: object({
    mode: enumString(["source_path_unchanged", "same_document_immutable_original_backup"]),
    source_path_reverified_after_commit: boolean,
    backup_identity_verified_after_commit: boolean,
    backup_path: nullable(string),
    backup_document: nullable(signingBackupIdentity),
  }),
  output_commit: object({
    status: { const: "committed" },
    protocol: { const: "pdf-tools.atomic-output-transaction.v1" },
    target_mode: enumString(["new_path", "same_document"]),
    source_binding_verified_at_commit: { const: true },
    prepared_identity_verified_after_commit: { const: true },
    replacement_identity_supplied: boolean,
  }),
  page_count: integer,
  geometry_policy: object({
    native_coordinate_space: { const: "pdf-tools.media-box-top-left-points.v1" },
    display_coordinate_space: { const: "pdf-tools.crop-box-rotated-top-left-points.v1" },
    page_box_basis: { const: "MediaBox" },
    crop_box_observed: { const: true },
    rotation_policy: { const: "clockwise_quarter_turns" },
  }),
  pages: arrayOf(signingPageGeometry),
  field_outcomes: arrayOf(signingFieldOutcome),
  zones: arrayOf(signingPreparationZone),
  existing_signature_observation: object({
    present: boolean,
    field_count: integer,
    field_names: stringArray,
    allow_resign: boolean,
  }),
  xfa_observation: object({
    present: boolean,
    force_xfa: boolean,
    stripping_authorized: boolean,
  }),
  handoff_status: enumString(["ready_for_provider_mapping", "incomplete", "blocked"]),
  missing_inputs: arrayOf(signingPreparationMissingInput),
  limitations: stringArray,
  provider_execution_status: { const: "not_requested" },
  receipt_sha256: sha256Digest,
});
const luminParticipant = object({
  participant_id: string,
  name: string,
  email_address: string,
});
const luminPreparedDocument = object({
  canonical_path: string,
  size_bytes: integer,
  sha256: sha256Digest,
});
const signatureZone = object({
  type: enumString(["signature", "initials", "name", "date"]),
  label: string,
  page: integer,
  x: number,
  y: number,
  width: number,
  height: number,
  confidence: number,
  source: enumString(["text-heuristic", "acroform-signature", "acroform-named-field"]),
});
const zoneDetectionWarning = object({
  code: enumString([
    "ACROFORM_WIDGET_PAGE_UNRESOLVED",
    "ENCRYPTED_ACROFORM_SCAN_UNAVAILABLE",
    "TEXT_EXTRACTION_UNAVAILABLE",
  ]),
  message: string,
  occurrences: { type: "integer", minimum: 1 },
});

const standardError = object({
  status: { const: "failed" },
  error: object({
    error_schema_version: { const: 1 },
    code: enumString([
      "internal_validation_error",
      "path_policy_denied",
      "tool_execution_failed",
    ]),
  }),
});
const luminSigningError = object({
  status: { const: "failed" },
  error: object({
    error_schema_version: { const: 1 },
    code: { type: "string", pattern: "^LUMIN_[A-Z0-9_]+$" },
  }),
});
const textVisibility = object({
  status: enumString(["available", "unavailable"]),
  invisible_text_show_count: nullable(integer),
  other_text_show_count: nullable(integer),
});
const invisibleTextPages = arrayOf(object({ page: integer, ...textVisibility.properties }));
const contentWorkerFailure = object({
  pages_with_invisible_text: invisibleTextPages,
  pages_with_unavailable_text_visibility: integerArray,
  status: { const: "failed" },
  error: object({
    error_schema_version: { const: 1 },
    code: enumString(["internal_validation_error", "path_policy_denied", "tool_execution_failed"]),
  }),
  pages_read: integer,
  read_pages_without_text: integerArray,
  pages_with_suspected_text_integrity: arrayOf(object({
    page: integer,
    signals: arrayOf(object({
      kind: enumString(["replacement_characters", "private_use_runs", "c1_control_tokens", "non_alphanumeric_dominance"]),
      count: { type: "integer", minimum: 1 },
    })),
  })),
  page_read_error: pageReadError,
});
const contentResourceLimitError = object({
  pages_with_invisible_text: invisibleTextPages,
  pages_with_unavailable_text_visibility: integerArray,
  status: { const: "failed" },
  error: object({
    error_schema_version: { const: 1 },
    code: { const: "PDF_RESOURCE_LIMIT_EXCEEDED" },
  }),
  pages_read: integer,
  read_pages_without_text: integerArray,
  pages_with_suspected_text_integrity: arrayOf(object({
    page: integer,
    signals: arrayOf(object({
      kind: enumString(["replacement_characters", "private_use_runs", "c1_control_tokens", "non_alphanumeric_dominance"]),
      count: { type: "integer", minimum: 1 },
    })),
  })),
  page_read_error: pageReadError,
});
const layoutPasswordError = object({
  status: { const: "failed" },
  error: object({
    error_schema_version: { const: 1 },
    code: enumString(["PASSWORD_REQUIRED", "PASSWORD_INCORRECT"]),
  }),
});
const pdfResourceLimitError = object({
  status: { const: "failed" },
  error: object({
    error_schema_version: { const: 1 },
    code: { const: "PDF_RESOURCE_LIMIT_EXCEEDED" },
  }),
});
const pdfIdentityError = object({
  status: { const: "failed" },
  error: object({
    error_schema_version: { const: 1 },
    code: enumString([
      "PDF_CHANGED_DURING_READ",
      "PDF_INPUT_TOO_LARGE",
      "PDF_INVALID_HEADER",
      "PDF_UNAVAILABLE",
    ]),
  }),
});
const pdfAccessibilityInspectionError = object({
  status: { const: "failed" },
  error: object({
    error_schema_version: { const: 1 },
    code: enumString([
      "PDF_ACCESSIBILITY_INSPECTION_UNAVAILABLE",
      "PDF_ENCRYPTED_INSPECTION_UNAVAILABLE",
    ]),
  }),
});
const pdfComparisonError = object({
  status: { const: "failed" },
  error: object({
    error_schema_version: { const: 1 },
    code: enumString([
      "COMPARISON_OUTPUT_LIMIT_EXCEEDED",
      "COMPARISON_PAGE_LIMIT_EXCEEDED",
      "COMPARISON_SOURCE_BINDING_MISMATCH",
      "COMPARISON_SOURCE_CHANGED",
      // An encrypted input, which pdf-lib cannot decrypt for the page geometry
      // and page rendering this comparison needs. Distinct from
      // PDF_PARSE_FAILED because the document parsed perfectly well.
      "PDF_ENCRYPTED_COMPARISON_UNSUPPORTED",
      "PDF_PARSE_FAILED",
      "invalid_input",
    ]),
  }),
});

const validationField = object({
  name: string,
  type: string,
  kind: enumString(["text", "checkbox", "radio", "dropdown", "option_list", "signature", "button", "unknown"]),
  required: nullable(boolean),
  required_name_hint: boolean,
  value_status: enumString(["observed", "empty", "unchecked", "unknown", "read_error", "not_applicable"]),
  required_status: enumString(["not_required", "unknown", "satisfied", "missing"]),
  error_code: nullable(string),
});
const validationProperties = {
  schema_version: { const: "1.0" },
  pdf_path: nullable(string),
  file_name: nullable(string),
  validation_status: enumString(["complete", "partial", "incomplete", "indeterminate", "no_fields", "no_value_fields"]),
  required_field_validation_status: enumString(["complete", "incomplete", "indeterminate", "no_fields", "no_required_flags"]),
  validation_conclusive: boolean,
  has_form_fields: boolean,
  required_fields_complete: nullable(boolean),
  all_value_fields_filled: nullable(boolean),
  can_claim_required_fields_complete: boolean,
  can_claim_form_ready: { const: false },
  total_field_count: integer,
  value_field_count: integer,
  observed_count: integer,
  filled_count: integer,
  empty_count: integer,
  unchecked_count: integer,
  unknown_count: integer,
  read_error_count: integer,
  not_applicable_count: integer,
  required_field_count: integer,
  missing_required_count: integer,
  indeterminate_required_count: integer,
  requiredness_unknown_count: integer,
  fields: arrayOf(validationField),
  observed_fields: stringArray,
  empty_fields: stringArray,
  unchecked_fields: stringArray,
  unknown_fields: stringArray,
  read_error_fields: stringArray,
  missing_required_fields: stringArray,
  indeterminate_required_fields: stringArray,
  requiredness_unknown_fields: stringArray,
  heuristic_required_candidates: stringArray,
  error_codes: stringArray,
  warning_codes: stringArray,
  retry_guidance: nullable(string),
  limitations: stringArray,
};
const validationSuccess = object({
  ...validationProperties,
  pdf_path: string,
  file_name: string,
});
const validationFailure = object({
  ...validationProperties,
  validation_status: { const: "failed" },
  required_field_validation_status: { const: "failed" },
  has_form_fields: { type: "null" },
  total_field_count: { type: "null" },
  value_field_count: { type: "null" },
  observed_count: { type: "null" },
  filled_count: { type: "null" },
  empty_count: { type: "null" },
  unchecked_count: { type: "null" },
  unknown_count: { type: "null" },
  read_error_count: { type: "null" },
  not_applicable_count: { type: "null" },
  required_field_count: { type: "null" },
  missing_required_count: { type: "null" },
  indeterminate_required_count: { type: "null" },
  requiredness_unknown_count: { type: "null" },
});
const contentProperties = {
  pages_with_invisible_text: invisibleTextPages,
  pages_with_unavailable_text_visibility: integerArray,
  pdf_path: string,
  file_name: string,
  total_pages: integer,
  pages_read: integer,
  text_length: integer,
  text_truncated: boolean,
  text_found: boolean,
  content_available: boolean,
  extraction_status: { ...enumString(["complete", "partial"]), description: "Text-layer read coverage, not OCR correctness or agreement with the visible page." },
  page_previews: arrayOf(pageTextPreview),
  page_read_error: pageReadError,
  read_pages_without_text: { ...integerArray, description: "Pages actually read in this call whose normalized text layer is empty." },
  pages_with_suspected_text_integrity: arrayOf(object({
    page: integer,
    signals: arrayOf(object({
      kind: enumString(["replacement_characters", "private_use_runs", "c1_control_tokens", "non_alphanumeric_dominance"]),
      count: { type: "integer", minimum: 1 },
    })),
  })),
  routing_guidance: nullable({ type: "string", description: "Fixed visual-verification guidance for textless, suspect, invisible, or visibility-unavailable text within the read scope." }),
  preview_truncated: boolean,
  extraction_mode: enumString(["text", "image-fallback"]),
  error_codes: stringArray,
  retry_guidance: nullable(string),
};
const contentTextSuccess = object({
  ...contentProperties,
  text_found: { const: true },
  content_available: { const: true },
  extraction_mode: { const: "text" },
});
const contentImageSuccess = object({
  ...contentProperties,
  text_length: { const: 0 },
  text_truncated: { const: false },
  text_found: { const: false },
  content_available: { const: true },
  extraction_status: { const: "partial" },
  extraction_mode: { const: "image-fallback" },
  image_renderer: enumString(["native-canvas", "macos-sips", "macos-quicklook"]),
});
const contentFailure = object({
  ...contentProperties,
  text_truncated: { const: false },
  text_found: { const: false },
  content_available: { const: false },
  extraction_status: { const: "failed" },
  extraction_mode: { const: "none" },
});
const layoutTextIntegrity = object({
  status: enumString(["ok", "suspect", "unavailable"]),
  signals: arrayOf(object({
    kind: enumString(["replacement_characters", "private_use_runs", "c1_control_tokens", "non_alphanumeric_dominance"]),
    count: { type: "integer", minimum: 1 },
  })),
});
const pageAnalysis = object({
  text_visibility: textVisibility,
  page: integer,
  width: integer,
  height: integer,
  rotation: integer,
  display_width: integer,
  display_height: integer,
  orientation: enumString(["portrait", "landscape"]),
  text_length: nullable(integer),
  text_snippet: nullable(string),
  has_images: nullable(boolean),
  has_graphics: nullable(boolean),
  image_op_count: nullable({ type: "integer", minimum: 0, description: "Count of PDF.js image paint invocations; grouped or repeat image operators count as one invocation each, not raw PDF operators." }),
  path_op_count: nullable({ type: "integer", minimum: 0, description: "Count of PDF.js constructPath invocations, not raw PDF path operators." }),
  path_segment_count: nullable({ type: "integer", minimum: 0, description: "Count of DrawOPS path commands contained in PDF.js constructPath invocations." }),
  content_analysis_status: enumString(["complete", "degraded", "unavailable", "not_analyzed"]),
  text_extraction_status: enumString(["complete", "failed", "not_analyzed"]),
  image_detection_status: enumString(["complete", "failed", "not_analyzed"]),
  graphics_detection_status: enumString(["complete", "failed", "not_analyzed"]),
  blank_status: enumString(["likely_blank", "not_blank", "unknown"]),
  analysis_error_codes: stringArray,
  analysis_provenance: object({
    dimensions: { const: "pdf-lib" },
    text: nullable(enumString(["pdfjs"])),
    images: nullable(enumString(["pdfjs"])),
    graphics: nullable(enumString(["pdfjs"])),
  }),
  text_integrity: layoutTextIntegrity,
});
const analysisError = object({
  scope: enumString(["document", "page"]),
  page: integer,
  code: string,
}, ["scope", "code"]);
const layoutBox = object({ x: number, y: number, width: number, height: number });
const layoutItemSpace = object({
  origin: { const: "top_left" },
  unit: { const: "points_1_72_in_after_user_unit" },
  reference_box: { const: "pdfjs_display_viewport" },
});
const routingReason = enumString([
  "invisible_text_layer",
  "text_visibility_unavailable",
  "no_text_layer",
  "image_dominated",
  "vector_only_text",
  "suspected_text_integrity",
  "analysis_unavailable",
]);
const visionRoutingPage = object({
  page: integer,
  reasons: arrayOf(routingReason),
});
const layoutRawPageSpace = object({
  basis: { const: "pdf_default_user_space" },
  unit: { const: "pdf_user_unit" },
  stage: { const: "before_user_unit_and_page_rotation" },
});
const layoutGeometry = object({
  page: integer,
  media_box: nullable(layoutBox),
  crop_box: nullable(layoutBox),
  pdfjs_view: nullable({ type: "array", minItems: 4, maxItems: 4, items: number }),
  user_unit: nullable(number),
  raw_pdf_rotation: nullable({ type: "integer", enum: [0, 90, 180, 270] }),
  display_rotation: nullable({ type: "integer", enum: [0, 90, 180, 270] }),
  rotation_matches_raw: nullable(boolean),
  display_width: nullable(number),
  display_height: nullable(number),
  viewport_transform: nullable({ type: "array", minItems: 6, maxItems: 6, items: number }),
  raw_page_space: layoutRawPageSpace,
  item_space: layoutItemSpace,
});
const layoutPageTruncation = object({
  truncated: boolean,
  reasons: stringArray,
  omitted_items: integer,
  omitted_non_whitespace_items: integer,
  omitted_characters: integer,
  first_omitted_source_index: nullable(integer),
});
const layoutDocumentTruncation = object({
  truncated: boolean,
  reasons: stringArray,
  omitted_items: integer,
  omitted_characters: integer,
  first_omitted_page: nullable(integer),
  first_omitted_source_index: nullable(integer),
});
const layoutError = object({
  stage: enumString(["page", "text", "operators", "geometry", "annotations", "ruled_rects"]),
  code: string,
  message: string,
});
const layoutPoint = object({ x: number, y: number });
const layoutPaintedRectangles = object({
  status: enumString(["available", "unavailable"]),
  truncated: boolean,
  observed_count: integer,
  returned_count: integer,
  items: arrayOf(object({
    id: string,
    source_operation_index: integer,
    source_kind: { const: "solid_color_image_mask" },
    graphics_transform: { type: "array", minItems: 6, maxItems: 6, items: number },
    quad: { type: "array", minItems: 4, maxItems: 4, items: layoutPoint },
    bbox: layoutBox,
  })),
});
const layoutGlyphRecovery = object({
  source_utf16_start: integer,
  source_utf16_end: integer,
  output_utf16_start: integer,
  output_utf16_end: integer,
  original_char_code: integer,
  source_unicode: string,
  operator_unicode: string,
  target_unicode: string,
  binding_kind: enumString(["exact_text_scalar", "collapsed_whitespace_item"]),
  operator_advance_width: nullable(number),
  operator_anchor_span_width: nullable(number),
  operator_raw_transform: nullable({ type: "array", minItems: 6, maxItems: 6, items: number }),
  font_name: nullable(string),
  registry_id: string,
  qualification: string,
  glyph_sha256: string,
  witness_glyph_sha256: stringArray,
  tfm_reference_version: string,
  glyph_evidence_version: string,
});
const layoutRawItemProperties = {
  id: string,
  source_index: integer,
  text: string,
  source_text: string,
  glyph_recoveries: arrayOf(layoutGlyphRecovery),
  is_whitespace: boolean,
  text_kind: enumString(["empty", "whitespace", "non_whitespace"]),
  has_eol: boolean,
  raw_transform: { type: "array", minItems: 6, maxItems: 6, items: nullable(number) },
  raw_width: nullable(number),
  raw_height: nullable(number),
  font_name: nullable(string),
  font: object({
    family: nullable(string),
    ascent: nullable(number),
    descent: nullable(number),
    vertical: boolean,
  }),
  geometry_kind: { const: "pdfjs_text_run_advance_box" },
  geometry_valid: boolean,
  bbox_status: enumString(["valid", "degenerate", "invalid"]),
  geometry_provenance: object({
    formula: enumString([
      "pdfjs_text_item_style_metric_advance_box_approximation",
      "pdfjs_collapsed_type3_operator_advance_box_approximation",
    ]),
    quad_order: { const: "anchor_top_terminal_top_anchor_bottom_terminal_bottom" },
    advance_source: enumString(["item_width", "item_height", "operator_advance_width"]),
    ascent_source: nullable(enumString(["style_ascent", "style_descent_fallback", "default_0_8"])),
    ascent_ratio: nullable(number),
  }),
  quad: nullable({ type: "array", minItems: 4, maxItems: 4, items: layoutPoint }),
  bbox: nullable(layoutBox),
  x: nullable(number),
  y: nullable(number),
  width: nullable(number),
  height: nullable(number),
  line_height: nullable(number),
  direction: enumString(["ltr", "rtl", "ttb", "unknown"]),
  reading_order_index: integer,
  line_id: nullable(string),
  column_index: nullable(integer),
};
const layoutRawItem = object(
  layoutRawItemProperties,
  Object.keys(layoutRawItemProperties).filter(key => !["source_text", "glyph_recoveries"].includes(key)),
);
const layoutLine = object({
  id: string,
  source_first_index: integer,
  text: string,
  x: number,
  y: number,
  width: number,
  height: number,
  direction: enumString(["ltr", "rtl", "ttb", "unknown"]),
  item_ids: stringArray,
  reading_order_index: integer,
  column_index: integer,
});
const layoutBlock = object({
  id: string,
  kind: enumString(["page_flow", "column_flow", "spanning_flow"]),
  column_index: integer,
  line_ids: stringArray,
});
const layoutRuledRect = object({
  x: number,
  y: number,
  width: { type: "number", minimum: 0 },
  height: { type: "number", minimum: 0 },
  verb: enumString(["fill", "stroke", "clip", "none"]),
});
const layoutRuledRects = object({
  status: enumString(["available", "truncated", "failed", "unavailable"]),
  observed_count: { type: "integer", minimum: 0 },
  returned_count: { type: "integer", minimum: 0 },
  items: arrayOf(layoutRuledRect),
});
const layoutRulingSegment = object({
  orientation: enumString(["horizontal", "vertical"]),
  x1: number,
  y1: number,
  x2: number,
  y2: number,
  source_operator_index: { type: "integer", minimum: 0 },
});
const layoutRulingSegments = object({
  status: enumString(["available", "unavailable"]),
  truncated: boolean,
  observed_count: { type: "integer", minimum: 0 },
  returned_count: { type: "integer", minimum: 0 },
  items: arrayOf(layoutRulingSegment),
});
const layoutOperatorCounts = nullable(object({
  image_paint_ops: { type: "integer", minimum: 0 },
  path_segments: { type: "integer", minimum: 0 },
  path_construct_ops: { type: "integer", minimum: 0 },
}));
const markdownGapCode = enumString([
  "PAGE_RANGE_INCOMPLETE",
  "SOURCE_ITEM_LIMIT_REACHED",
  "SOURCE_CHARACTER_LIMIT_REACHED",
  "TEXT_LAYER_FAILED",
  "TEXT_LAYER_EMPTY",
  "OCR_NOT_PERFORMED",
  "PAGE_FURNITURE_REMOVED",
  "IMAGE_CONTENT_NOT_RENDERED",
  "VECTOR_CONTENT_NOT_INTERPRETED",
  "RAW_PAGE_GEOMETRY_UNAVAILABLE",
  "INVALID_TEXT_GEOMETRY",
  "LINK_ANNOTATIONS_UNAVAILABLE",
  "LINK_MAPPING_AMBIGUOUS",
  "UNSUPPORTED_LINK_TARGET",
  "TABLE_RULING_UNSUPPORTED",
  "TABLE_TOPOLOGY_UNKNOWN",
  "TEXT_INTEGRITY_SUSPECT",
  "MATH_NOT_RECONSTRUCTED",
  "CONTROL_CHARACTERS_SANITIZED",
]);
const markdownGap = object({
  code: markdownGapCode,
  page: nullable(integer),
  message: string,
});
const markdownPage = object({
  page: { type: "integer", minimum: 1 },
  conversion_status: enumString(["complete", "partial", "failed"]),
  markdown_bytes: { type: "integer", minimum: 0 },
  line_count: { type: "integer", minimum: 0 },
  rendered_line_count: { type: "integer", minimum: 0 },
  gaps: arrayOf(markdownGap),
});
const markdownSavedOutput = nullable(object({
  path: string,
  encoding: { const: "utf-8" },
  bytes: { type: "integer", minimum: 0 },
  sha256: { type: "string", pattern: "^[a-f0-9]{64}$" },
  commit_method: { const: "same_directory_atomic" },
  reopened_verified: { const: true },
  overwritten: boolean,
}));
const layoutPage = object({
  id: string,
  page: integer,
  text_layer_status: enumString(["present", "empty", "partial", "failed"]),
  image_detection_status: enumString(["detected", "not_detected", "failed"]),
  modality_hint: enumString(["text-layer-candidate", "mixed-content-candidate", "image-only-candidate", "vector-only-candidate", "empty-candidate", "unknown"]),
  extraction_status: enumString(["complete", "partial", "failed"]),
  needs_visual_inspection: boolean,
  geometry: layoutGeometry,
  has_image_operations: nullable(boolean),
  has_vector_paint_operations: nullable(boolean),
  ruled_rects: layoutRuledRects,
  ruling_segments: layoutRulingSegments,
  text_integrity: layoutTextIntegrity,
  operator_counts: layoutOperatorCounts,
  painted_rectangles: layoutPaintedRectangles,
  link_annotations: object({
    status: enumString(["available", "unavailable"]),
    truncated: boolean,
    items: arrayOf(object({
      id: string,
      rect: nullable(object({
        x: number,
        y: number,
        width: number,
        height: number,
      })),
      target_kind: enumString([
        "http",
        "internal_destination",
        "action",
        "unsupported_scheme",
        "ambiguous_target",
        "none",
      ]),
      url: nullable(string),
    })),
  }),
  raw_items: arrayOf(layoutRawItem),
  lines: arrayOf(layoutLine),
  blocks: arrayOf(layoutBlock),
  reading_order: object({
    strategy: enumString(["source_order_fallback", "two_column_left_to_right", "unavailable_output_omitted"]),
    confidence: { const: "not_calibrated" },
    column_count: integer,
    limitations: stringArray,
  }),
  flow_text: string,
  spatial_text: string,
  counts: object({
    observed_items: integer,
    returned_items: integer,
    observed_non_whitespace_items: integer,
    returned_non_whitespace_items: integer,
    observed_characters: integer,
    returned_characters: integer,
  }),
  truncation: layoutPageTruncation,
  errors: arrayOf(layoutError),
  limitations: stringArray,
});

// Verified-vision (B1) proposal packet. Emitted only when the opt-in
// emit_table_proposals flag is set; one bounded, deterministic descriptor per
// abandoned table region. Typed statuses only, no numeric confidence.
const tableProposalTextItem = object({
  id: string,
  text: string,
  reading_order_index: { type: "integer", minimum: 0 },
  line_id: nullable(string),
  column_index: nullable(integer),
  bbox: nullable(layoutBox),
  quad: nullable({ type: "array", minItems: 4, maxItems: 4, items: layoutPoint }),
  raw_transform: { type: "array", minItems: 6, maxItems: 6, items: nullable(number) },
});
const tableProposalRuledRect = object({
  x: number,
  y: number,
  width: number,
  height: number,
  verb: enumString(["fill", "stroke", "clip", "none"]),
});
const tableProposalRulingSegment = object({
  orientation: enumString(["horizontal", "vertical"]),
  x1: number,
  y1: number,
  x2: number,
  y2: number,
  source_operator_index: { type: "integer", minimum: 0 },
});
const tableProposalPaintedRect = object({
  id: string,
  bbox: layoutBox,
});
const tableProposalHeaderHints = object({
  status: enumString(["available", "unavailable"]),
  first_row_height: nullable(number),
  body_median_height: nullable(number),
  first_row_band: enumString(["taller_than_body", "not_distinguished", "unavailable"]),
});
const tableProposalTruncation = object({
  text_items: enumString(["complete", "truncated"]),
  ruled_rects: enumString(["complete", "truncated"]),
  ruling_segments: enumString(["complete", "truncated"]),
  painted_rectangles: enumString(["complete", "truncated"]),
});
const tableProposalsDocumentTruncation = object({
  status: enumString(["complete", "truncated"]),
  observed_regions: integer,
  returned_regions: integer,
  omitted_regions: integer,
});
const tableProposal = object({
  region_id: { type: "string", pattern: "^p[0-9]+-t[0-9]+$" },
  page: { type: "integer", minimum: 1 },
  reason: enumString(["TABLE_TOPOLOGY_UNKNOWN", "TABLE_RULING_UNSUPPORTED"]),
  coordinate_space: { const: "pdfjs_viewport_top_left_points" },
  bbox: layoutBox,
  text_items: arrayOf(tableProposalTextItem),
  ruled_rects: arrayOf(tableProposalRuledRect),
  ruling_segments: arrayOf(tableProposalRulingSegment),
  painted_rectangles: arrayOf(tableProposalPaintedRect),
  header_hints: tableProposalHeaderHints,
  truncation: tableProposalTruncation,
  proposal_token: sha256Digest,
});
const tableProposalCheckStatus = enumString(["passed", "failed", "not_run"]);
const verifiedTableCell = object({
  row: { type: "integer", minimum: 0 },
  column: { type: "integer", minimum: 0 },
  rowspan: { type: "integer", minimum: 1 },
  colspan: { type: "integer", minimum: 1 },
  item_ids: stringArray,
  text: string,
});
const tableProposalVerification = object({
  verifier: object({
    name: { const: TABLE_PROPOSAL_VERIFIER.name },
    version: { const: TABLE_PROPOSAL_VERIFIER.version },
  }),
  status: enumString(["accepted", "rejected"]),
  reason_codes: arrayOf(enumString(TABLE_PROPOSAL_REASON_CODES)),
  source: object({
    file_name: string,
    sha256: sha256Digest,
    size_bytes: { type: "integer", minimum: 0 },
  }),
  layout: object({
    name: { const: "pdf-tools.extraction-ir" },
    version: { const: "1.6.0" },
    parser_name: { const: "pdfjs-dist" },
    parser_version: { const: "5.4.624" },
  }),
  region: object({
    region_id: { type: "string", pattern: "^p[1-9][0-9]*-t[1-9][0-9]*$" },
    page: { type: "integer", minimum: 1 },
    abandonment_reason: nullable(enumString(["TABLE_TOPOLOGY_UNKNOWN", "TABLE_RULING_UNSUPPORTED"])),
  }),
  source_reparsed: { const: true },
  checks: object({
    token_binding: tableProposalCheckStatus,
    region_evidence: tableProposalCheckStatus,
    cell_input: tableProposalCheckStatus,
    coverage: tableProposalCheckStatus,
    one_cell: tableProposalCheckStatus,
    row_non_straddle: tableProposalCheckStatus,
    row_order: tableProposalCheckStatus,
    column_order: tableProposalCheckStatus,
    rectangular_grid: tableProposalCheckStatus,
    cut_line_consistency: tableProposalCheckStatus,
    ruled_line_agreement: tableProposalCheckStatus,
    topology_ambiguity: tableProposalCheckStatus,
    header_evidence: tableProposalCheckStatus,
    content_source: tableProposalCheckStatus,
  }),
  table: nullable(object({
    row_count: { type: "integer", minimum: 1 },
    column_count: { type: "integer", minimum: 1 },
    cells: arrayOf(verifiedTableCell),
    content_origin: { const: "reparsed_pdf_text_layer" },
    markdown: string,
    markdown_format: { const: "gfm" },
    markdown_span_projection: { const: "anchor_text_with_empty_continuation_cells" },
    markdown_bytes: { type: "integer", minimum: 1 },
    markdown_sha256: sha256Digest,
  })),
  claim_boundary: { const: TABLE_PROPOSAL_CLAIM_BOUNDARY },
});

const workspaceDigest = sha256Digest;
const workspaceGenerationSequence = { type: "integer", minimum: 0 };
const workspaceJsonValue = {};
const workspaceContract = (name, version) => object({
  name: { const: name },
  version: { const: version },
});
const workspaceProposalEvent = object({
  contract: workspaceContract("pdf-tools.verified-extraction-workspace-event", "1.1.0-experimental"),
  event_sequence: { type: "integer", minimum: 1 },
  kind: { const: "proposal_submitted" },
  workspace_identity_sha256: workspaceDigest,
  leaf_pointer: string,
  proposed_value: workspaceJsonValue,
  chunk_ids: arrayOf({ type: "string", pattern: "^chunk\\.[a-f0-9]{64}$" }),
  verification: object({ status: { const: "unverified" }, reason: { const: "not_replayed" } }),
  event_id: { type: "string", pattern: "^event\\.[a-f0-9]{64}$" },
});
const workspaceVerificationResult = object({
  contract: { type: "object" },
  workspace_identity_sha256: workspaceDigest,
  generation_sha256: workspaceDigest,
  proposal_event_id: { type: "string", pattern: "^event\\.[a-f0-9]{64}$" },
  proposal_event: workspaceProposalEvent,
  leaf_pointer: string,
  proposed_value: workspaceJsonValue,
  proposed_value_sha256: workspaceDigest,
  source: object({ sha256: workspaceDigest, size_bytes: { type: "integer", minimum: 1 } }),
  schema: object({ sha256: workspaceDigest, size_bytes: { type: "integer", minimum: 1 } }),
  document_map_sha256: workspaceDigest,
  chunk_policy_sha256: workspaceDigest,
  status: enumString([
    "verified_exact", "computed_with_inputs", "source_supported", "not_found", "ambiguous",
    "unverified_reasoning", "citation_mismatch", "chunk_missing",
  ]),
  reason_codes: stringArray,
  citations: arrayOf(workspaceJsonValue),
  method: { type: "object" },
  derived_value: workspaceJsonValue,
  calculation: workspaceJsonValue,
  search_scope: workspaceJsonValue,
  source_replayed: { const: true },
  schema_replayed: { const: true },
  caller_text_accepted_as_proof: { const: false },
  caller_geometry_accepted_as_proof: { const: false },
  caller_confidence_accepted_as_proof: { const: false },
  table_topology_proven: { const: false },
  claim_boundary: string,
  package_inclusion: { const: "enabled_experimental" },
  verification_sha256: workspaceDigest,
});
const workspaceVerifiedEvent = object({
  contract: workspaceContract("pdf-tools.verified-extraction-workspace-event", "1.1.0-experimental"),
  event_sequence: { type: "integer", minimum: 1 },
  kind: { const: "proposal_verified" },
  workspace_identity_sha256: workspaceDigest,
  leaf_pointer: string,
  proposal_event_id: { type: "string", pattern: "^event\\.[a-f0-9]{64}$" },
  verification_result: workspaceVerificationResult,
  event_id: { type: "string", pattern: "^event\\.[a-f0-9]{64}$" },
});
const workspacePageRange = object({
  start_page: { type: "integer", minimum: 1 },
  end_page: { type: "integer", minimum: 1 },
});

export const TOOL_SUCCESS_OUTPUT_SCHEMAS = Object.freeze({
  create_extraction_workspace: object({
    workspace_id: string,
    workspace_path: string,
    workspace_identity_sha256: workspaceDigest,
    workspace_pointer_sha256: workspaceDigest,
    creator_claim_sha256: workspaceDigest,
    generation_sha256: workspaceDigest,
    generation_sequence: { const: 0 },
    state: { const: "complete" },
    leaf_obligations: stringArray,
    document_map_sha256: workspaceDigest,
  }),
  inspect_extraction_state: object({
    workspace_id: string,
    workspace_identity_sha256: workspaceDigest,
    state: enumString(["complete", "durability_uncertain", "initialization_recovery_required"]),
    current_generation_sha256: nullable(workspaceDigest),
    current_generation_sequence: nullable(workspaceGenerationSequence),
    complete_generations: { type: "integer", minimum: 0 },
    incomplete_generations: arrayOf(object({
      name: string,
      state: string,
      reason: nullable(string),
    })),
    abandoned_generations: stringArray,
    active_transaction_id: nullable(string),
    retention: object({
      maximum_generations: { type: "integer", minimum: 1 },
      remaining_generations: { type: "integer", minimum: 0 },
      automatic_pruning: { const: false },
      deletion_requires_exact_current_generation: { const: true },
    }),
  }),
  read_extraction_workspace: object({
    contract: workspaceContract("pdf-tools.verified-extraction-workspace-page", "1.0.0-experimental"),
    workspace_identity_sha256: workspaceDigest,
    generation_sha256: workspaceDigest,
    collection: enumString(["document_map_chunks", "pending_leaves", "events", "proposals", "results"]),
    collection_sha256: workspaceDigest,
    counts: object({
      total: { type: "integer", minimum: 0 },
      offset: { type: "integer", minimum: 0 },
      returned: { type: "integer", minimum: 0 },
      omitted_before: { type: "integer", minimum: 0 },
      omitted_after: { type: "integer", minimum: 0 },
    }),
    items: arrayOf(workspaceJsonValue),
    next_cursor: nullable(string),
  }),
  read_extraction_chunk: object({
    document_map_sha256: workspaceDigest,
    chunk_id: { type: "string", pattern: "^chunk\\.[a-f0-9]{64}$" },
    page_range: workspacePageRange,
    content: string,
    content_utf8_bytes: { type: "integer", minimum: 0 },
    content_sha256: workspaceDigest,
    admitted_item_count: { type: "integer", minimum: 0 },
    omitted_item_count: { const: 0 },
  }),
  submit_extraction_proposal: object({
    workspace_identity_sha256: workspaceDigest,
    generation_sha256: workspaceDigest,
    generation_sequence: workspaceGenerationSequence,
    event: workspaceProposalEvent,
    state: { const: "complete" },
  }),
  verify_extraction_proposal: object({
    workspace_identity_sha256: workspaceDigest,
    generation_sha256: workspaceDigest,
    generation_sequence: workspaceGenerationSequence,
    event: workspaceVerifiedEvent,
    result: workspaceVerificationResult,
    state: { const: "complete" },
  }),
  delete_extraction_workspace: object({
    state: { const: "deleted" },
    workspace_id: string,
    workspace_identity_sha256: workspaceDigest,
    final_generation_sha256: workspaceDigest,
    recoverable: { const: false },
  }),
  read_pdf_fields: activeDocument(),
  fill_pdf: activeDocument({ filled_fields: stringArray, fill_errors: stringArray }),
  bulk_fill_from_csv: object({
    row_count: integer,
    results: arrayOf(object({
      filename: string,
      output_path: string,
      fields_filled: integer,
      errors: stringArray,
      status: enumString(["ok", "warning", "error"]),
    })),
    preview_records: arrayOf({ type: "object", additionalProperties: string }),
  }),
  fill_with_profile: activeDocument({
    profile_name: string,
    filled_fields: stringArray,
    fill_errors: stringArray,
  }),
  extract_to_csv: object({
    output_csv: string,
    source_pdf_count: integer,
    field_count: integer,
    row_count: integer,
    preview_row_count: integer,
    headers: stringArray,
    preview_rows: arrayOf({ type: "object", additionalProperties: string }),
  }),
  validate_pdf: validationSuccess,
  read_pdf_content: { type: "object", anyOf: [contentTextSuccess, contentImageSuccess] },
  read_pdf_pages: object({
    pdf_path: string,
    file_name: string,
    total_pages: integer,
    start_page: integer,
    end_page: integer,
    pages: arrayOf(pageTextPreview),
    text_found: boolean,
    truncated: boolean,
  }),
  read_pdf_layout: object({
    ir: object({ name: { const: "pdf-tools.extraction-ir" }, version: { const: "1.6.0" } }),
    parser: object({ name: { const: "pdfjs-dist" }, version: { const: "5.4.624" } }),
    source: object({
      pdf_path: string,
      file_name: string,
      sha256: { type: "string", pattern: "^[a-f0-9]{64}$" },
      size_bytes: integer,
    }),
    id_scope: object({
      kind: { const: "source_parser_ir_options" },
      source_sha256: { type: "string", pattern: "^[a-f0-9]{64}$" },
      parser_version: { const: "5.4.624" },
      ir_version: { const: "1.6.0" },
      requested_start_page: integer,
      requested_end_page: integer,
      max_items: integer,
      max_characters: integer,
      max_output_characters: integer,
    }),
    page_range: object({
      requested_start_page: integer,
      requested_end_page: integer,
      start_page: integer,
      end_page: integer,
      total_pages: integer,
    }),
    extraction_status: enumString(["complete", "partial", "failed"]),
    pages: arrayOf(layoutPage),
    limits: object({
      max_items: integer,
      max_characters: integer,
      max_output_characters: integer,
      deadline_ms: integer,
    }),
    truncation: layoutDocumentTruncation,
    limitations: stringArray,
  }),
  convert_pdf_to_markdown: object(
    {
      renderer: object({
        name: { const: "pdf-tools.layout-markdown-renderer" },
        version: { const: "1.21.0" },
      }),
      conversion_status: enumString(["complete", "partial", "failed"]),
      markdown: string,
      markdown_sha256: { type: "string", pattern: "^[a-f0-9]{64}$" },
      markdown_bytes: { type: "integer", minimum: 0 },
      options: object({
        include_page_boundaries: boolean,
        compact: boolean,
        remove_page_furniture: boolean,
      }),
      limits: object({ max_markdown_bytes: { type: "integer", minimum: 1, maximum: 200000 } }),
      pages: arrayOf(markdownPage),
      pages_needing_vision: arrayOf(visionRoutingPage),
      gaps: arrayOf(markdownGap),
      limitations: stringArray,
      normalizations: object({
        dot_leaders_collapsed: { type: "integer", minimum: 0 },
        page_number_lines_removed: { type: "integer", minimum: 0 },
        running_header_lines_removed: { type: "integer", minimum: 0 },
        running_footer_lines_removed: { type: "integer", minimum: 0 },
        page_furniture_characters_removed: { type: "integer", minimum: 0 },
        page_furniture_pages: integerArray,
        spaced_hyphens_joined: { type: "integer", minimum: 0 },
        normalized_pages: integerArray,
      }),
      provenance: object({
        source: object({
          file_name: string,
          sha256: { type: "string", pattern: "^[a-f0-9]{64}$" },
          size_bytes: integer,
        }),
        layout: object({
          name: { const: "pdf-tools.extraction-ir" },
          version: { const: "1.6.0" },
          parser_name: { const: "pdfjs-dist" },
          parser_version: { const: "5.4.624" },
          page_range: object({
            start_page: integer,
            end_page: integer,
            total_pages: integer,
          }),
        }),
      }),
      saved_output: markdownSavedOutput,
      // Present only when the opt-in emit_table_proposals flag is set, so it is
      // deliberately excluded from the required list below to keep the
      // default-off result byte-identical.
      table_proposals: arrayOf(tableProposal),
      table_proposals_truncation: tableProposalsDocumentTruncation,
    },
    [
      "renderer",
      "conversion_status",
      "markdown",
      "markdown_sha256",
      "markdown_bytes",
      "options",
      "limits",
      "pages",
      "pages_needing_vision",
      "gaps",
      "limitations",
      "normalizations",
      "provenance",
      "saved_output",
    ],
  ),
  verify_table_proposal: tableProposalVerification,
  render_pdf_page: object({
    pdf_path: string,
    file_name: string,
    page: integer,
    total_pages: integer,
    width_points: integer,
    height_points: integer,
    rendered_width_px: integer,
    rendered_height_px: integer,
    scale: number,
    renderer: enumString(["native-canvas", "macos-sips", "macos-quicklook"]),
    mime_type: { const: "image/png" },
    observation_schema_version: { const: "1.0" },
    source: observationSource,
    page_geometry: observationPageGeometry,
    page_view: observationPageView,
    requested_coordinate_space: { const: "pdfjs_viewport_top_left_points" },
    rendered_coordinate_space: { const: "raster_top_left_pixels" },
    requested_region: regionPoints,
    rendered_region: regionPoints,
    renderer_policy: enumString([
      "forced_unavailable",
      "native",
      "native_with_system_fallback",
      "system",
    ]),
    png_sha256: sha256Digest,
    raw_pixel_sha256: nullable(sha256Digest),
    raw_pixel_status: enumString(["available", "unavailable"]),
    observation_sha256: sha256Digest,
  }),
  render_pdf_region: object({
    pdf_path: string,
    file_name: string,
    page: integer,
    total_pages: integer,
    region_points: regionPoints,
    rendered_width_px: integer,
    rendered_height_px: integer,
    scale: number,
    renderer: enumString(["native-canvas", "macos-sips", "macos-quicklook"]),
    mime_type: { const: "image/png" },
    observation_schema_version: { const: "1.0" },
    source: observationSource,
    page_geometry: observationPageGeometry,
    page_view: observationPageView,
    requested_coordinate_space: { const: "pdfjs_viewport_top_left_points" },
    rendered_coordinate_space: { const: "raster_top_left_pixels" },
    requested_region: regionPoints,
    rendered_region: regionPoints,
    renderer_policy: enumString([
      "forced_unavailable",
      "native",
      "native_with_system_fallback",
      "system",
    ]),
    png_sha256: sha256Digest,
    raw_pixel_sha256: nullable(sha256Digest),
    raw_pixel_status: enumString(["available", "unavailable"]),
    observation_sha256: sha256Digest,
  }),
  search_pdf_text: object({
    pdf_path: string,
    file_name: string,
    total_pages: integer,
    query: string,
    match_count: integer,
    truncated: boolean,
    matches: arrayOf(object({
      page: integer,
      char_index: integer,
      match_text: string,
      snippet: string,
    })),
  }),
  get_pdf_resource_uri: object({
    uri: string,
    pdf_path: string,
    file_name: string,
    size_bytes: integer,
  }),
  get_pdf_identity: object({
    schema_version: { const: "1.0" },
    requested_path: string,
    canonical_path: string,
    file_name: string,
    size_bytes: { type: "integer", minimum: 0, maximum: 250 * 1024 * 1024 },
    sha256: { type: "string", pattern: "^[a-f0-9]{64}$" },
    identity_method: { const: "race_aware_descriptor_sha256" },
    pdf_parsed: { const: false },
  }),
  inspect_pdf_accessibility: object({
    schema_version: { const: "pdf-tools.accessibility-inspection-result/1.0.0" },
    engine: object({
      name: { const: "pdf-tools.structural-review-screen" },
      version: { const: "1.0.0" },
    }),
    parser: object({ name: { const: "pdf-lib" }, version: { const: "1.17.1" } }),
    source: object({
      file_name: { type: "string", minLength: 1, maxLength: 255 },
      size_bytes: { type: "integer", minimum: 1 },
      sha256: sha256Digest,
    }),
    inspection_status: enumString(["complete", "partial"]),
    result: enumString(["findings_detected", "no_findings_detected", "indeterminate"]),
    checks: {
      type: "array",
      items: accessibilityCheck,
      minItems: 8,
      maxItems: 8,
    },
    summary: object({
      total: { const: 8 },
      observed: { type: "integer", minimum: 0, maximum: 8 },
      missing: { type: "integer", minimum: 0, maximum: 8 },
      unavailable: { type: "integer", minimum: 0, maximum: 8 },
      text: string,
    }),
    self_declared_identification: object({
      status: enumString(["observed", "not_observed", "unavailable"]),
      part: nullable({ type: "integer", minimum: 1, maximum: 99 }),
      revision: nullable({ type: "integer", minimum: 1, maximum: 9999 }),
      reason_code: nullable(enumString([
        "COMPRESSED_METADATA_NOT_INSPECTED",
        "METADATA_SIZE_LIMIT",
        "STRICT_PARSE_FAILED",
      ])),
    }),
    machine_profile_validation: object({ status: { const: "not_run" } }),
    human_review: object({
      status: { const: "required" },
      unresolved_areas: stringArray,
    }),
    conclusions: object({
      pdfua_conformance: { const: "not_established" },
      wcag_conformance: { const: "not_established" },
      certification: { const: "not_established" },
      legal_compliance: { const: "not_established" },
      document_accessibility: { const: "not_established" },
    }),
    limitations: stringArray,
  }),
  compare_pdfs: object({
    schema_version: { const: "1.1" },
    engine: object({
      name: { const: "pdf-tools.deterministic-comparison" },
      version: { const: "0.2.0" },
      parser: object({ name: { const: "pdfjs-dist" }, version: { const: "5.4.624" } }),
      renderer: object({
        name: { const: "native-canvas" },
        scale: { const: 1.5 },
        pixel_delta_threshold: { const: 8 },
        mask_dilation_pixels: { const: 1 },
        connected_components: { const: 8 },
        minimum_component_area_pixels: { const: 4 },
        resizing: { const: false },
      }),
      alignment_policy: { const: "pdf-tools.page-alignment.v1" },
      text_policy: { const: "pdf-tools.extraction-ir-lines.v1" },
      visual_policy: { const: "pdf-tools.rgba-delta.v1" },
      presentation_policy: { const: "pdf-tools.material-presentation.v1" },
    }),
    status: enumString(["complete", "partial"]),
    mode: enumString(["default_material", "forensic"]),
    before_source: comparisonSource,
    after_source: comparisonSource,
    source_immutability: object({ before: comparisonImmutability, after: comparisonImmutability }),
    coverage: object({
      semantic: comparisonCoverage,
      text: comparisonCoverage,
      structure: comparisonCoverage,
      form_field: comparisonCoverage,
      annotation: comparisonCoverage,
      metadata: comparisonCoverage,
      visual: comparisonCoverage,
    }),
    page_alignments: arrayOf(comparisonAlignment),
    observations: arrayOf(comparisonObservation),
    changes: arrayOf(comparisonChange),
    summary: object({
      detected_change_count: integer,
      reported_change_count: integer,
      suppressed_change_count: integer,
      no_reported_changes: boolean,
      equivalence_claim: { const: false },
    }),
    limitations: stringArray,
    resource_usage: object({
      duration_ms: number,
      source_bytes: integer,
      rendered_pixels: integer,
      aligned_page_visual_comparisons_requested: integer,
      aligned_page_visual_comparisons_completed: integer,
      network_requests: { const: 0 },
      external_persistence_writes: { const: 0 },
    }),
    comparison_sha256: sha256Digest,
  }),
  get_pdf_info: object({
    schema_version: { const: "1.0" },
    status: enumString(["complete", "partial"]),
    source: object({
      canonical_path: string,
      file_name: string,
      size_bytes: integer,
      sha256: sha256Digest,
      identity_method: { const: "race_aware_descriptor_sha256" },
    }),
    parser: object({ name: { const: "pdfjs-dist" }, version: { const: "5.4.624" } }),
    coverage: object({
      pages: observationCoverage,
      metadata: observationCoverage,
      form_fields: observationCoverage,
      annotations: observationCoverage,
    }),
    limits: object({
      max_pages: { type: "integer", minimum: 1, maximum: 200 },
      max_fields: { const: 500 },
      max_annotations: { const: 500 },
      max_metadata_characters: { const: 32768 },
      max_output_characters: { type: "integer", minimum: 20000, maximum: 200000 },
    }),
    pages: object({
      total_count: integer,
      observed_count: integer,
      truncated: boolean,
      items: arrayOf(pageObservation),
    }),
    metadata: metadataObservation,
    form_fields: object({
      field_object_count: integer,
      total_count: integer,
      observed_count: integer,
      truncated: boolean,
      widget_count: integer,
      matched_widget_count: integer,
      unmatched_widget_count: integer,
      omitted_widget_count: integer,
      items: arrayOf(formFieldObservation),
    }),
    annotations: object({
      encountered_count: integer,
      observed_count: integer,
      truncated: boolean,
      items: arrayOf(annotationObservation),
    }),
    limitations: stringArray,
    observation_sha256: sha256Digest,
  }),
  display_pdf: activeDocument(),
  get_active_document: {
    type: "object",
    anyOf: [
      object({
        active_path: { type: "null" },
        backup_path: { type: "null" },
        last_mutation_tool: { type: "null" },
        last_mutation_at: { type: "null" },
      }),
      activeDocument(),
    ],
  },
  set_active_document: activeDocument(),
  read_pdf_bytes: object({
    pdfPath: string,
    bytes: string,
    offset: integer,
    byteCount: integer,
    totalBytes: integer,
    hasMore: boolean,
  }),
  merge_pdfs: activeDocument({
    total_pages: integer,
    metadata_fields_omitted: stringArray,
  }),
  split_pdf: object({
    input_path: string,
    output_directory: string,
    file_count: integer,
    files: arrayOf(object({
      filename: string,
      output_path: string,
      start_page: integer,
      end_page: integer,
      page_count: integer,
    })),
  }),
  rotate_pdf_pages: activeDocument({
    rotated_pages: integer,
    degrees: { type: "number", enum: [90, 180, 270] },
  }),
  reorder_pdf_pages: activeDocument({ page_order: integerArray }),
  apply_page_plan: activeDocument({
    deleted_pages: integer,
    rotated_pages: integer,
    page_order: integerArray,
    rotations: { type: "object", additionalProperties: { type: "number", enum: [0, 90, 180, 270] } },
  }),
  get_page_analysis: object({
    total_pages: integer,
    content_analysis_status: enumString(["complete", "partial", "degraded"]),
    content_analysis_complete: boolean,
    content_pages_requested: integer,
    content_pages_complete: integer,
    likely_blank_pages: integerArray,
    nonblank_pages: integerArray,
    unknown_pages: integerArray,
    analysis_errors: arrayOf(analysisError),
    retry_guidance: nullable(string),
    mutation_guidance: string,
    classification: object({
      document_kind: enumString(["text_based", "image_based", "vector_heavy", "mixed", "empty", "unknown"]),
      pages_analyzed: integer,
      pages_needing_vision: arrayOf(visionRoutingPage),
      pages_not_analyzed: integerArray,
    }),
    pages: arrayOf(pageAnalysis),
    majority_orientation: enumString(["portrait", "landscape"]),
  }),
  create_signature: object({
    name: string,
    style: enumString(["typed", "image"]),
    path: string,
    bytes: integer,
  }),
  get_allowed_directories: object({
    directories: arrayOf(string),
    configured: { type: "boolean" },
    source: enumString(["argument", "environment", "config_file", "home_config_file", "plugin_workspace", "none", "refused_self_granting"]),
    config_path: nullable(string),
  }),
  list_signatures: object({
    signatures: arrayOf(object({
      name: string,
      style: enumString(["typed", "image"]),
      display_name: nullable(string),
      created_at: nullable(string),
    })),
  }),
  load_signature: object({
    name: string,
    style: enumString(["typed", "image"]),
    display_name: nullable(string),
    preview_data_url: nullable(string),
    created_at: nullable(string),
  }),
  add_signature_field: activeDocument({
    pdf_path: string,
    page: integer,
    x: number,
    y: number,
    width: number,
    height: number,
    label: string,
  }),
  apply_signature: activeDocument({
    pdf_path: string,
    signature_name: string,
    page: integer,
    x: number,
    y: number,
    width: number,
    height: number,
    signer: string,
    confirmed_at: string,
    intent_statement: string,
    signing_mode: enumString(["signature", "initials"]),
    tier: { const: "basic-local-stamp" },
  }),
  prepare_signing_packet: activeDocument({
    pdf_path: string,
    pending_signatures: arrayOf(placement),
    filled_count: integer,
    fill_errors: arrayOf(fillError),
    preparation_receipt: signingPreparationReceipt,
  }),
  start_lumin_authorization: object({
    status: { const: "awaiting_user_authorization" },
    next_step: string,
    provider: { const: "lumin_sign" },
    authorization_session_id: string,
    callback_expires_at: string,
    browser_opened: { const: true },
    pdf_sent: { const: false },
  }),
  finish_lumin_authorization: object({
    status: { const: "connected" },
    next_step: string,
    provider: { const: "lumin_sign" },
    authorization_session_id: string,
    token_expires_at: string,
    access_token_persisted: { const: false },
    refresh_token_persisted: { const: false },
    pdf_sent: { const: false },
  }),
  prepare_lumin_request: object({
    status: { const: "ready_for_user_confirmation" },
    provider: { const: "lumin_sign" },
    request_preparation_id: string,
    authorization_session_id: string,
    confirmation_sha256: sha256Digest,
    confirmation_expires_at: string,
    disclosure: string,
    confirmation_statement_required: string,
    prepared_document: luminPreparedDocument,
    title: string,
    request_expires_at: string,
    signers: arrayOf(luminParticipant),
    viewers: arrayOf(luminParticipant),
    provider_contacted: { const: false },
    pdf_sent: { const: false },
  }),
  send_lumin_request: object({
    status: { const: "request_created" },
    provider: { const: "lumin_sign" },
    authority_sha256: sha256Digest,
    operation_status: { const: "request_created" },
    signature_request_id: string,
    provider_status: string,
    created_at: integer,
    attempt_count: { const: 1 },
    automatic_retry_performed: { const: false },
    create_retry_allowed: { const: false },
    access_token_persisted: { const: false },
  }),
  check_lumin_status: object({
    status: { const: "observed" },
    provider: { const: "lumin_sign" },
    authority_sha256: sha256Digest,
    signature_request_id: string,
    provider_status: string,
    observed_at: string,
    observation_sha256: sha256Digest,
    read_retry_safe: { const: true },
    create_retry_allowed: { const: false },
    access_token_persisted: { const: false },
  }),
  download_lumin_artifact: object({
    status: { const: "downloaded" },
    provider: { const: "lumin_sign" },
    authority_sha256: sha256Digest,
    file_type: enumString(["agreement", "coc", "merged"]),
    pdf_path: string,
    size_bytes: integer,
    sha256: sha256Digest,
    artifact_observation_sha256: sha256Digest,
    access_url_persisted: { const: false },
    access_url_returned: { const: false },
    access_token_persisted: { const: false },
    create_retry_allowed: { const: false },
  }),
  apply_text: activeDocument({
    pdf_path: string,
    page: integer,
    x: number,
    y: number,
    width: number,
    height: number,
    text: string,
  }),
  detect_signature_zones: object({
    detection_status: enumString(["complete", "partial"]),
    zones: arrayOf(signatureZone),
    warnings: arrayOf(zoneDetectionWarning),
    // Zone coordinates are top-left origin relative to the page MediaBox.
    // PDF.js exposes only the view (CropBox intersected with MediaBox), so a
    // renderer cannot derive the MediaBox on its own and would misplace every
    // overlay on a page where those boxes differ.
    page_geometry: arrayOf(object({
      page: integer,
      origin_x: number,
      origin_y: number,
      width: number,
      height: number,
    })),
  }),
  fetch_pdf_from_url: activeDocument({
    pdf_path: string,
    bytes: integer,
    content_type: string,
    source_url: string,
  }),
  reveal_in_finder: object({
    path: string,
    platform: enumString(["darwin", "win32", "linux", "aix", "freebsd", "openbsd", "sunos", "android"]),
  }),
});

const specialErrorSchemas = {
  compare_pdfs: [layoutPasswordError, pdfResourceLimitError, pdfIdentityError, pdfComparisonError],
  inspect_pdf_accessibility: [
    pdfResourceLimitError,
    pdfIdentityError,
    pdfAccessibilityInspectionError,
  ],
  get_pdf_identity: [pdfIdentityError],
  get_pdf_info: [layoutPasswordError, pdfResourceLimitError, pdfIdentityError],
  validate_pdf: [validationFailure],
  read_pdf_content: [contentFailure, contentWorkerFailure, contentResourceLimitError, pdfResourceLimitError],
  read_pdf_pages: [pdfResourceLimitError],
  read_pdf_layout: [layoutPasswordError, pdfResourceLimitError],
  convert_pdf_to_markdown: [layoutPasswordError, pdfResourceLimitError],
  verify_table_proposal: [layoutPasswordError, pdfResourceLimitError],
  render_pdf_page: [pdfResourceLimitError],
  render_pdf_region: [pdfResourceLimitError],
  search_pdf_text: [pdfResourceLimitError],
  get_page_analysis: [pdfResourceLimitError],
  detect_signature_zones: [layoutPasswordError, pdfResourceLimitError],
};
for (const toolName of [
  "start_lumin_authorization",
  "finish_lumin_authorization",
  "prepare_lumin_request",
  "send_lumin_request",
  "check_lumin_status",
  "download_lumin_artifact",
]) {
  specialErrorSchemas[toolName] = [luminSigningError];
}
for (const toolName of [
  "add_signature_field",
  "apply_page_plan",
  "apply_signature",
  "apply_text",
  "bulk_fill_from_csv",
  "fill_pdf",
  "fill_with_profile",
  "merge_pdfs",
  "prepare_signing_packet",
  "reorder_pdf_pages",
  "rotate_pdf_pages",
  "split_pdf",
]) {
  specialErrorSchemas[toolName] = [
    ...(specialErrorSchemas[toolName] ?? []),
    pdfResourceLimitError,
  ];
}

export const TOOL_ERROR_OUTPUT_SCHEMAS = Object.freeze(Object.fromEntries(
  Object.keys(TOOL_SUCCESS_OUTPUT_SCHEMAS).map(name => [
    name,
    {
      type: "object",
      anyOf: [standardError, ...(specialErrorSchemas[name] || [])],
    },
  ]),
));

// The pinned SDK validates structuredContent whenever it is present, including
// isError results. Keep every advertised error branch exact while the live
// success validator below deliberately excludes all error shapes.
export const TOOL_OUTPUT_SCHEMAS = Object.freeze(Object.fromEntries(
  Object.entries(TOOL_SUCCESS_OUTPUT_SCHEMAS).map(([name, successSchema]) => [
    name,
    {
      type: "object",
      anyOf: [successSchema, standardError, ...(specialErrorSchemas[name] || [])],
    },
  ]),
));

const validatorProvider = new AjvJsonSchemaValidator();
const successValidators = new Map(Object.entries(TOOL_SUCCESS_OUTPUT_SCHEMAS).map(
  ([name, schema]) => [name, validatorProvider.getValidator(schema)],
));
const errorValidators = new Map(Object.entries(TOOL_ERROR_OUTPUT_SCHEMAS).map(
  ([name, schema]) => [name, validatorProvider.getValidator(schema)],
));
const standardErrorValidator = validatorProvider.getValidator(standardError);
const semanticSuccessValidators = new Map([
  ["compare_pdfs", validatePdfComparisonSemantics],
  ["inspect_pdf_accessibility", validateAccessibilityInspectionResult],
  ["read_pdf_layout", validatePdfLayoutSemantics],
  ["convert_pdf_to_markdown", validateMarkdownConversionSemantics],
  ["verify_table_proposal", validateTableProposalVerificationResult],
  ["get_pdf_info", validatePdfObservationSemantics],
  ["render_pdf_page", validateRenderObservationSemantics],
  ["render_pdf_region", validateRenderObservationSemantics],
]);

export function withToolOutputSchema(tool) {
  const outputSchema = TOOL_OUTPUT_SCHEMAS[tool.name];
  return outputSchema ? { ...tool, outputSchema } : tool;
}

export function hasToolOutputSchema(toolName) {
  return Object.prototype.hasOwnProperty.call(TOOL_OUTPUT_SCHEMAS, toolName);
}

export function createTypedToolError({
  message,
  code = "tool_execution_failed",
  content = null,
  structuredContent = null,
}) {
  if (typeof message !== "string" || message.length === 0) {
    throw new TypeError("Typed tool errors require a non-empty message.");
  }
  if (typeof code !== "string" || code.length === 0) {
    throw new TypeError("Typed tool errors require a non-empty code.");
  }
  return {
    content: content ?? [{ type: "text", text: message }],
    structuredContent: structuredContent ?? {
      status: "failed",
      error: {
        error_schema_version: 1,
        code,
      },
    },
    isError: true,
  };
}

export function validateStructuredToolResult(toolName, result) {
  if (result?.isError === true) {
    if (result.structuredContent === undefined) {
      return internalValidationError(toolName, "the error result omitted required structured content");
    }
    const validation = (errorValidators.get(toolName) || standardErrorValidator)(result.structuredContent);
    if (!validation.valid) {
      return internalValidationError(toolName, `invalid structured error: ${validation.errorMessage}`);
    }
    return result;
  }

  const validator = successValidators.get(toolName);
  if (!validator) {
    if (result?.structuredContent === undefined) return result;
    return internalValidationError(toolName, "structured content was returned without an advertised output schema");
  }
  if (result?.structuredContent === undefined) {
    return internalValidationError(toolName, "the successful result omitted required structured content");
  }

  const validation = validator(result.structuredContent);
  if (!validation.valid) {
    return internalValidationError(toolName, validation.errorMessage);
  }
  const semanticValidator = semanticSuccessValidators.get(toolName);
  if (semanticValidator) {
    try {
      semanticValidator(result.structuredContent);
    } catch (error) {
      return internalValidationError(toolName, error.message);
    }
  }
  return result;
}

function internalValidationError(toolName, detail) {
  console.error(`[PDF Tools] Output validation failed for ${toolName}: ${detail}`);
  return createTypedToolError({
    message:
      `Internal output validation failed for ${toolName}. `
      + "No unvalidated structured result was returned.",
    code: "internal_validation_error",
  });
}
