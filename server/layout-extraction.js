import { PDFArray, PDFDict, PDFDocument, PDFName, PDFNumber } from "pdf-lib";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
import {
  CM_CODEPOINTS,
  CM_TFM_METRICS,
  CM_TFM_REFERENCE_VERSION,
  CM_WITNESS_CODEPOINTS,
} from "./type3-cm-reference.js";
import {
  CM_PK_REFERENCE_FACES,
  CM_PK_REFERENCE_QUALIFICATION,
} from "./type3-cm-pk-reference.js";

const IR_NAME = "pdf-tools.extraction-ir";
const IR_VERSION = "1.6.0";
/*
 * IR_VERSION pin sweep (all must remain aligned):
 * - server/layout-extraction.js: IR_VERSION and EXTRACTION_IR_IDENTITY
 * - server/output-schemas.js: read_pdf_layout root, id_scope, and Markdown provenance
 * - server/markdown-conversion.js: supported layout identity
 * - test/read-pdf-layout.test.js, test/convert-pdf-to-markdown.test.js,
 *   test/mcp-contract.test.js, and test/pdfjs-worker-contract.test.js
 * - scripts/smoke-mcpb.mjs and scripts/test-share-contract.mjs
 * - pdf-toolkit-mcp-share/server/layout-extraction.js, markdown-conversion.js,
 *   and output-schemas.js
 *
 * 1.6.0: bounded, typed, source-replayed axis-aligned ruling segments preserve
 * the straight-line geometry needed by verified-vision grid checks.
 *
 * 1.5.0: the Type-3 glyph evidence key is the stored image-mask sample grid.
 * The published digests under glyph_sha256 and witness_glyph_sha256 all
 * changed, and those two fields plus glyph_evidence_version replaced the
 * charproc-named fields of 1.4.0.
 */
const INTERNAL_SOURCE_REPLAY = Symbol("pdf-layout-internal-source-replay");
const INTERNAL_MARKDOWN_PROJECTION = Symbol("pdf-layout-internal-markdown-projection");

const RULED_RECT_PAGE_LIMIT = 512;
const RULING_SEGMENT_PAGE_LIMIT = 1024;
const RULED_RECT_AXIS_TOLERANCE = 0.5;
const RULED_RECT_MIN_SIZE = 5;
const RULING_SEGMENT_MIN_LENGTH = 2;
const DRAW_OPS = Object.freeze({ moveTo: 0, lineTo: 1, curveTo: 2, quadraticCurveTo: 3, closePath: 4 });

/**
 * PDF.js factory directories must end with a forward slash on every platform:
 * its factory validation is literally `.endsWith("/")`, so the
 * backslash-terminated paths fileURLToPath produces on Windows fail with
 * "Invalid factory url" and take every layout operation down with them.
 * Node's fs accepts forward-slash Windows paths, so normalizing the
 * separators is sufficient and platform-neutral.
 */
export function pdfjsFactoryDirectory(nativePath) {
  const normalized = String(nativePath).replaceAll("\\", "/");
  return normalized.endsWith("/") ? normalized : `${normalized}/`;
}

const PDFJS_DOCUMENT_ASSETS = Object.freeze({
  cMapUrl: pdfjsFactoryDirectory(fileURLToPath(new URL("../node_modules/pdfjs-dist/cmaps/", import.meta.url))),
  cMapPacked: true,
  standardFontDataUrl: pdfjsFactoryDirectory(fileURLToPath(new URL("../node_modules/pdfjs-dist/standard_fonts/", import.meta.url))),
  wasmUrl: pdfjsFactoryDirectory(fileURLToPath(new URL("../node_modules/pdfjs-dist/wasm/", import.meta.url))),
});
const ITEM_SPACE = Object.freeze({
  origin: "top_left",
  unit: "points_1_72_in_after_user_unit",
  reference_box: "pdfjs_display_viewport",
});
const RAW_PAGE_SPACE = Object.freeze({
  basis: "pdf_default_user_space",
  unit: "pdf_user_unit",
  stage: "before_user_unit_and_page_rotation",
});
const MAX_PAINTED_RECTANGLES = 500;
/*
 * Type-3 glyph evidence keys.
 *
 * v2 keys a legacy bitmap glyph on the stored samples of its decoded image
 * mask instead of on the CharProc operator list. The operator list folds in the
 * producer's idiom, the inline-image filter it chose, and the per-glyph
 * placement matrix, none of which are properties of the glyph: two documents
 * carrying a pixel-identical Computer Modern raster hashed differently under v1
 * and now hash the same. No matrix takes part in the key, because the matrices
 * that decide painted orientation are not all reachable from inside a CharProc
 * and keying on the reachable half is what made v1 producer-dependent. Non-mask
 * glyph programs keep the exact operator digest under a separate domain tag, so
 * the two lanes can never satisfy each other's registry entries.
 */
const TYPE3_GLYPH_EVIDENCE_VERSION = "pdfjs-type3-glyph-evidence-v2";
const TYPE3_MASK_EVIDENCE_DOMAIN = "type3-glyph-image-mask-v1";
const TYPE3_CHARPROC_EVIDENCE_DOMAIN = "pdfjs-charproc-json-v1";
const MAX_TYPE3_GLYPH_CANONICAL_NODES = 100000;
const MAX_TYPE3_GLYPH_CANONICAL_DEPTH = 32;
const MAX_TYPE3_GLYPH_CANONICAL_BYTES = 250000;
// PDF.js refuses to trace a mask wider or taller than 1000 samples, so a
// larger grid can never arrive here; the area bound caps the working buffer.
const MAX_TYPE3_GLYPH_MASK_PIXELS = 1_000_000;
const MAX_TYPE3_GLYPH_MASK_PATH_NODES = 60_000;

const TYPE3_RECOVERY_REGISTRY = Object.freeze([
  Object.freeze({
    id: "cmmi-pk-raster-alpha-e688a8-v1",
    qualification: "ctan-cm-encoding-plus-reviewed-pk-raster-v1",
    family: "computer-modern-math-italic",
    original_char_code: 11,
    source_unicode: "\u000b",
    target_unicode: "α",
    glyph_sha256: "55bb60d8560069c0650380cf09cdd023866ca4b91bb92b2fe4b45a056da1bf47",
    allow_collapsed_whitespace: true,
    witnesses: Object.freeze([
      Object.freeze({ original_char_code: 25, glyph_sha256: "9554966ab58edc060791bd02f04513a8da4a749f80a943d2daa3460a393fee7f" }),
      Object.freeze({ original_char_code: 26, glyph_sha256: "eaa7d3cbe50f3ec7903d72addc77f88a471c1dfdc2fd9eb02ce0fbf800068507" }),
    ]),
  }),
  Object.freeze({
    id: "cmmi-pk-raster-period-2df559-v1",
    qualification: "ctan-cm-encoding-plus-reviewed-pk-raster-v1",
    family: "computer-modern-math-italic",
    original_char_code: 58,
    source_unicode: ":",
    target_unicode: ".",
    glyph_sha256: "2ed87b069c99482d0823c085da9c199582e6e4b51172a2b360d9b6652066e3ae",
    witnesses: Object.freeze([
      Object.freeze({ original_char_code: 59, glyph_sha256: "b06ab15c9fa4160e3448e0d4cf7e0c6aa1ff13b5dd01ab1406df95d77c279a53" }),
      Object.freeze({ original_char_code: 61, glyph_sha256: "44505b10d5f364c73f92f52606205ba2fa27a7f96d4dc41c8ba311cc2bc3ffe3" }),
    ]),
  }),
  Object.freeze({
    id: "cmmi-pk-raster-comma-42b5eb-v1",
    qualification: "ctan-cm-encoding-plus-reviewed-pk-raster-v1",
    family: "computer-modern-math-italic",
    original_char_code: 59,
    source_unicode: ";",
    target_unicode: ",",
    glyph_sha256: "b06ab15c9fa4160e3448e0d4cf7e0c6aa1ff13b5dd01ab1406df95d77c279a53",
    witnesses: Object.freeze([
      Object.freeze({ original_char_code: 58, glyph_sha256: "2ed87b069c99482d0823c085da9c199582e6e4b51172a2b360d9b6652066e3ae" }),
      Object.freeze({ original_char_code: 61, glyph_sha256: "44505b10d5f364c73f92f52606205ba2fa27a7f96d4dc41c8ba311cc2bc3ffe3" }),
    ]),
  }),
  Object.freeze({
    id: "cmmi-pk-raster-pi-780b04-v1",
    qualification: "ctan-cm-encoding-plus-reviewed-pk-raster-v1",
    family: "computer-modern-math-italic",
    original_char_code: 25,
    source_unicode: "\u0019",
    target_unicode: "π",
    glyph_sha256: "9554966ab58edc060791bd02f04513a8da4a749f80a943d2daa3460a393fee7f",
    witnesses: Object.freeze([
      Object.freeze({ original_char_code: 11, glyph_sha256: "55bb60d8560069c0650380cf09cdd023866ca4b91bb92b2fe4b45a056da1bf47" }),
      Object.freeze({ original_char_code: 26, glyph_sha256: "eaa7d3cbe50f3ec7903d72addc77f88a471c1dfdc2fd9eb02ce0fbf800068507" }),
    ]),
  }),
  Object.freeze({
    id: "cmmi-pk-raster-rho-1500df-v1",
    qualification: "ctan-cm-encoding-plus-reviewed-pk-raster-v1",
    family: "computer-modern-math-italic",
    original_char_code: 26,
    source_unicode: "\u001a",
    target_unicode: "ρ",
    glyph_sha256: "eaa7d3cbe50f3ec7903d72addc77f88a471c1dfdc2fd9eb02ce0fbf800068507",
    witnesses: Object.freeze([
      Object.freeze({ original_char_code: 11, glyph_sha256: "55bb60d8560069c0650380cf09cdd023866ca4b91bb92b2fe4b45a056da1bf47" }),
      Object.freeze({ original_char_code: 25, glyph_sha256: "9554966ab58edc060791bd02f04513a8da4a749f80a943d2daa3460a393fee7f" }),
    ]),
  }),
  Object.freeze({
    id: "cmmi-pk-raster-omega-81b411-v1",
    qualification: "ctan-cm-encoding-plus-reviewed-pk-raster-v1",
    family: "computer-modern-math-italic",
    original_char_code: 33,
    source_unicode: "!",
    target_unicode: "ω",
    glyph_sha256: "d88e2217762ec495c847bbc7535cfa5a3b083590190c185788dfd69929affa24",
    witnesses: Object.freeze([
      Object.freeze({ original_char_code: 11, glyph_sha256: "55bb60d8560069c0650380cf09cdd023866ca4b91bb92b2fe4b45a056da1bf47" }),
      Object.freeze({ original_char_code: 25, glyph_sha256: "9554966ab58edc060791bd02f04513a8da4a749f80a943d2daa3460a393fee7f" }),
    ]),
  }),
  Object.freeze({
    id: "cmmi-pk-raster-slash-55447d-v1",
    qualification: "ctan-cm-encoding-plus-reviewed-pk-raster-v1",
    family: "computer-modern-math-italic",
    original_char_code: 61,
    source_unicode: "=",
    target_unicode: "/",
    glyph_sha256: "44505b10d5f364c73f92f52606205ba2fa27a7f96d4dc41c8ba311cc2bc3ffe3",
    witnesses: Object.freeze([
      Object.freeze({ original_char_code: 58, glyph_sha256: "2ed87b069c99482d0823c085da9c199582e6e4b51172a2b360d9b6652066e3ae" }),
      Object.freeze({ original_char_code: 59, glyph_sha256: "b06ab15c9fa4160e3448e0d4cf7e0c6aa1ff13b5dd01ab1406df95d77c279a53" }),
    ]),
  }),
  Object.freeze({
    id: "cmsy-pk-raster-minus-fb1f6b-v1",
    qualification: "ctan-cm-encoding-plus-reviewed-pk-raster-v1",
    family: "computer-modern-math-symbol",
    original_char_code: 0,
    source_unicode: "\u0000",
    target_unicode: "−",
    glyph_sha256: "68b4a1e125aa58ed3e798029190dbf4e2f3937030f921cd995cf7c8ad2f2eedc",
    witnesses: Object.freeze([
      Object.freeze({ original_char_code: 21, glyph_sha256: "520751dc437215219c1269212ade701dc57b1484416b9bad9ef3da2806bb53e9" }),
      Object.freeze({ original_char_code: 112, glyph_sha256: "0ecbc7bd327017ee4719d7fa1e0b097bdd7b06557f8a39e11aa7c10a8a408218" }),
    ]),
  }),
  Object.freeze({
    id: "cmsy-pk-raster-greater-equal-05b4a9-v1",
    qualification: "ctan-cm-encoding-plus-reviewed-pk-raster-v1",
    family: "computer-modern-math-symbol",
    original_char_code: 21,
    source_unicode: "\u0015",
    target_unicode: "≥",
    glyph_sha256: "520751dc437215219c1269212ade701dc57b1484416b9bad9ef3da2806bb53e9",
    witnesses: Object.freeze([
      Object.freeze({ original_char_code: 0, glyph_sha256: "68b4a1e125aa58ed3e798029190dbf4e2f3937030f921cd995cf7c8ad2f2eedc" }),
      Object.freeze({ original_char_code: 112, glyph_sha256: "0ecbc7bd327017ee4719d7fa1e0b097bdd7b06557f8a39e11aa7c10a8a408218" }),
    ]),
  }),
  Object.freeze({
    id: "cmsy-pk-raster-square-root-772f49-v1",
    qualification: "ctan-cm-encoding-plus-reviewed-pk-raster-v1",
    family: "computer-modern-math-symbol",
    original_char_code: 112,
    source_unicode: "p",
    target_unicode: "√",
    glyph_sha256: "0ecbc7bd327017ee4719d7fa1e0b097bdd7b06557f8a39e11aa7c10a8a408218",
    witnesses: Object.freeze([
      Object.freeze({ original_char_code: 0, glyph_sha256: "68b4a1e125aa58ed3e798029190dbf4e2f3937030f921cd995cf7c8ad2f2eedc" }),
      Object.freeze({ original_char_code: 21, glyph_sha256: "520751dc437215219c1269212ade701dc57b1484416b9bad9ef3da2806bb53e9" }),
    ]),
  }),
  Object.freeze({
    id: "cmmi-pk-raster-omega-v1",
    qualification: "ctan-cm-encoding-plus-reviewed-pk-raster-v1",
    family: "computer-modern-math-italic",
    original_char_code: 33,
    source_unicode: "!",
    target_unicode: "ω",
    glyph_sha256: "776ec8ccac079e545eeadd4abc00c0384bfd5f8ffe976e754d832ca527aba9f3",
    witnesses: Object.freeze([
      Object.freeze({ original_char_code: 11, glyph_sha256: "a8e84e0d932585f5ea43e57c1c6aa2ddc349dbf9c95f25dde63d953281094aed" }),
      Object.freeze({ original_char_code: 25, glyph_sha256: "8844ed36948e6f388a823fa06d5165b38e5c00b68d0a9196c4875d3a5ed4147c" }),
    ]),
  }),
  Object.freeze({
    id: "cmmi-pk-raster-period-v1",
    qualification: "ctan-cm-encoding-plus-reviewed-pk-raster-v1",
    family: "computer-modern-math-italic",
    original_char_code: 58,
    source_unicode: ":",
    target_unicode: ".",
    glyph_sha256: "8520f46225db90fbb8c41a8ffe4ced238a45f80f3dd74acf4d9b12ec29598513",
    witnesses: Object.freeze([
      Object.freeze({ original_char_code: 59, glyph_sha256: "76bea2467b789bea3b7bf4585d0bea146aa54cf04448d992013837d2febb8ab7" }),
      Object.freeze({ original_char_code: 61, glyph_sha256: "6564b30a30b414b35c8f5c892e3d63ece09a101e911109fac83f4bff95dc04b5" }),
    ]),
  }),
  Object.freeze({
    id: "cmmi-pk-raster-slash-v1",
    qualification: "ctan-cm-encoding-plus-reviewed-pk-raster-v1",
    family: "computer-modern-math-italic",
    original_char_code: 61,
    source_unicode: "=",
    target_unicode: "/",
    glyph_sha256: "6564b30a30b414b35c8f5c892e3d63ece09a101e911109fac83f4bff95dc04b5",
    witnesses: Object.freeze([
      Object.freeze({ original_char_code: 58, glyph_sha256: "8520f46225db90fbb8c41a8ffe4ced238a45f80f3dd74acf4d9b12ec29598513" }),
      Object.freeze({ original_char_code: 59, glyph_sha256: "76bea2467b789bea3b7bf4585d0bea146aa54cf04448d992013837d2febb8ab7" }),
    ]),
  }),
  Object.freeze({
    id: "cmmi-pk-raster-comma-7c69e2-v1",
    qualification: "ctan-cm-encoding-plus-reviewed-pk-raster-v1",
    family: "computer-modern-math-italic",
    original_char_code: 59,
    source_unicode: ";",
    target_unicode: ",",
    glyph_sha256: "76bea2467b789bea3b7bf4585d0bea146aa54cf04448d992013837d2febb8ab7",
    witnesses: Object.freeze([
      Object.freeze({ original_char_code: 58, glyph_sha256: "8520f46225db90fbb8c41a8ffe4ced238a45f80f3dd74acf4d9b12ec29598513" }),
      Object.freeze({ original_char_code: 61, glyph_sha256: "6564b30a30b414b35c8f5c892e3d63ece09a101e911109fac83f4bff95dc04b5" }),
    ]),
  }),
  Object.freeze({
    id: "cmsy-pk-raster-minus-0c8b34-v1",
    qualification: "ctan-cm-encoding-plus-reviewed-pk-raster-v1",
    family: "computer-modern-math-symbol",
    original_char_code: 0,
    source_unicode: "\u0000",
    target_unicode: "−",
    glyph_sha256: "ed5df416bb312c2b49ed8936f226016a28e9a09fa52aba56281dd6a8a5430d19",
    witnesses: Object.freeze([
      Object.freeze({ original_char_code: 6, glyph_sha256: "4dd026f859f9674351763f1eec5d88e6ef486555ea12f8eb6a433b1a95238a19" }),
      Object.freeze({ original_char_code: 33, glyph_sha256: "a818ff8e95ae122382e0f0198e875400f4cc07ef1115dbe936ad5dd37933c4d4" }),
    ]),
  }),
  Object.freeze({
    id: "cmsy-pk-raster-minus-v1",
    qualification: "ctan-cm-encoding-plus-reviewed-pk-raster-v1",
    family: "computer-modern-math-symbol",
    original_char_code: 0,
    source_unicode: "\u0000",
    target_unicode: "−",
    glyph_sha256: "3f6fdf2abc68f5693f9ea7cdec4d94214a57fb953fb66c747b86dd1f6293d807",
    witnesses: Object.freeze([
      Object.freeze({ original_char_code: 21, glyph_sha256: "cf5071eb6c006bc80cf9399c28dc00f7e12d8e7f090942de46cb06d404481dd6" }),
      Object.freeze({ original_char_code: 112, glyph_sha256: "da5345f465509486a66762b6cf8918a3ba5c937f4ca8c7bc4657f4f905d0b4be" }),
    ]),
  }),
  Object.freeze({
    id: "cmsy-ctan-type3-minus-v1",
    qualification: "ctan-cm-type3-labeled-reference-2026-08",
    family: "computer-modern-math-symbol",
    original_char_code: 0,
    source_unicode: "\u0000",
    target_unicode: "−",
    glyph_sha256: "183f30cb001ea6b5047c6f806e3a27fd095bcdde1470f7b1f351dba8ea94282e",
    witnesses: Object.freeze([
      Object.freeze({ original_char_code: 21, glyph_sha256: "f9b735aa52a672962391a234ed5e79f5c30635d6ce2ea998f103ba616e39dbdf" }),
      Object.freeze({ original_char_code: 112, glyph_sha256: "5dd2e8e832e3ed95c353d14854c6441e9f3ea10c1ff66466ba7b15cbf59546d7" }),
    ]),
  }),
  Object.freeze({
    id: "cmmi-pk-raster-period-bd8a8b-v1",
    qualification: "ctan-cm-encoding-plus-reviewed-pk-raster-v1",
    family: "computer-modern-math-italic",
    original_char_code: 58,
    source_unicode: ":",
    target_unicode: ".",
    glyph_sha256: "8520f46225db90fbb8c41a8ffe4ced238a45f80f3dd74acf4d9b12ec29598513",
    witnesses: Object.freeze([
      Object.freeze({ original_char_code: 59, glyph_sha256: "be90d1c78149ab81005db5ce23c2ad819399c82bc16bdc7b41de5a3e3a2ee494" }),
      Object.freeze({ original_char_code: 61, glyph_sha256: "7102f7980d961e8217c684332b9fe84a9a9f31290153ccf1ee784ffb16527665" }),
    ]),
  }),
  Object.freeze({
    id: "cmmi-pk-raster-comma-dec7c4-v1",
    qualification: "ctan-cm-encoding-plus-reviewed-pk-raster-v1",
    family: "computer-modern-math-italic",
    original_char_code: 59,
    source_unicode: ";",
    target_unicode: ",",
    glyph_sha256: "be90d1c78149ab81005db5ce23c2ad819399c82bc16bdc7b41de5a3e3a2ee494",
    witnesses: Object.freeze([
      Object.freeze({ original_char_code: 58, glyph_sha256: "8520f46225db90fbb8c41a8ffe4ced238a45f80f3dd74acf4d9b12ec29598513" }),
      Object.freeze({ original_char_code: 61, glyph_sha256: "7102f7980d961e8217c684332b9fe84a9a9f31290153ccf1ee784ffb16527665" }),
    ]),
  }),
  Object.freeze({
    id: "cmmi-pk-raster-slash-f5b035-v1",
    qualification: "ctan-cm-encoding-plus-reviewed-pk-raster-v1",
    family: "computer-modern-math-italic",
    original_char_code: 61,
    source_unicode: "=",
    target_unicode: "/",
    glyph_sha256: "7102f7980d961e8217c684332b9fe84a9a9f31290153ccf1ee784ffb16527665",
    witnesses: Object.freeze([
      Object.freeze({ original_char_code: 58, glyph_sha256: "8520f46225db90fbb8c41a8ffe4ced238a45f80f3dd74acf4d9b12ec29598513" }),
      Object.freeze({ original_char_code: 59, glyph_sha256: "be90d1c78149ab81005db5ce23c2ad819399c82bc16bdc7b41de5a3e3a2ee494" }),
    ]),
  }),
  Object.freeze({
    id: "cmmi-pk-raster-alpha-bab8ae-v1",
    qualification: "ctan-cm-encoding-plus-reviewed-pk-raster-v1",
    family: "computer-modern-math-italic",
    original_char_code: 11,
    source_unicode: "\u000b",
    target_unicode: "α",
    glyph_sha256: "afd53079aef8914177830dd32a4751df81d06ef083e4d1a0fc641896dc827fb4",
    allow_collapsed_whitespace: true,
    witnesses: Object.freeze([
      Object.freeze({ original_char_code: 25, glyph_sha256: "ef3b94ad4d1be76d84c62c89da120449668fd9b47cd120922110a9a7977c45f0" }),
      Object.freeze({ original_char_code: 26, glyph_sha256: "a98c60dd17ef1c118bbdd5ae57e81f7a5cc843450fa650017b64372445a3a5a4" }),
    ]),
  }),
  Object.freeze({
    id: "cmmi-pk-raster-pi-3d439e-v1",
    qualification: "ctan-cm-encoding-plus-reviewed-pk-raster-v1",
    family: "computer-modern-math-italic",
    original_char_code: 25,
    source_unicode: "\u0019",
    target_unicode: "π",
    glyph_sha256: "ef3b94ad4d1be76d84c62c89da120449668fd9b47cd120922110a9a7977c45f0",
    witnesses: Object.freeze([
      Object.freeze({ original_char_code: 11, glyph_sha256: "afd53079aef8914177830dd32a4751df81d06ef083e4d1a0fc641896dc827fb4" }),
      Object.freeze({ original_char_code: 26, glyph_sha256: "a98c60dd17ef1c118bbdd5ae57e81f7a5cc843450fa650017b64372445a3a5a4" }),
    ]),
  }),
  Object.freeze({
    id: "cmmi-pk-raster-rho-fa4a3d-v1",
    qualification: "ctan-cm-encoding-plus-reviewed-pk-raster-v1",
    family: "computer-modern-math-italic",
    original_char_code: 26,
    source_unicode: "\u001a",
    target_unicode: "ρ",
    glyph_sha256: "a98c60dd17ef1c118bbdd5ae57e81f7a5cc843450fa650017b64372445a3a5a4",
    witnesses: Object.freeze([
      Object.freeze({ original_char_code: 11, glyph_sha256: "afd53079aef8914177830dd32a4751df81d06ef083e4d1a0fc641896dc827fb4" }),
      Object.freeze({ original_char_code: 25, glyph_sha256: "ef3b94ad4d1be76d84c62c89da120449668fd9b47cd120922110a9a7977c45f0" }),
    ]),
  }),
  Object.freeze({
    id: "cmmi-pk-raster-alpha-c3d175-v1",
    qualification: "ctan-cm-encoding-plus-reviewed-pk-raster-v1",
    family: "computer-modern-math-italic",
    original_char_code: 11,
    source_unicode: "\u000b",
    target_unicode: "α",
    glyph_sha256: "a8e84e0d932585f5ea43e57c1c6aa2ddc349dbf9c95f25dde63d953281094aed",
    allow_collapsed_whitespace: true,
    witnesses: Object.freeze([
      Object.freeze({ original_char_code: 25, glyph_sha256: "8844ed36948e6f388a823fa06d5165b38e5c00b68d0a9196c4875d3a5ed4147c" }),
      Object.freeze({ original_char_code: 26, glyph_sha256: "4cbdb66a4c77a8d3544a862526cbf6918a1575df24ee425489fd4266aeaf0f2d" }),
    ]),
  }),
  Object.freeze({
    id: "cmmi-pk-raster-pi-994283-v1",
    qualification: "ctan-cm-encoding-plus-reviewed-pk-raster-v1",
    family: "computer-modern-math-italic",
    original_char_code: 25,
    source_unicode: "\u0019",
    target_unicode: "π",
    glyph_sha256: "8844ed36948e6f388a823fa06d5165b38e5c00b68d0a9196c4875d3a5ed4147c",
    witnesses: Object.freeze([
      Object.freeze({ original_char_code: 11, glyph_sha256: "a8e84e0d932585f5ea43e57c1c6aa2ddc349dbf9c95f25dde63d953281094aed" }),
      Object.freeze({ original_char_code: 26, glyph_sha256: "4cbdb66a4c77a8d3544a862526cbf6918a1575df24ee425489fd4266aeaf0f2d" }),
    ]),
  }),
  Object.freeze({
    id: "cmmi-pk-raster-rho-ee4042-v1",
    qualification: "ctan-cm-encoding-plus-reviewed-pk-raster-v1",
    family: "computer-modern-math-italic",
    original_char_code: 26,
    source_unicode: "\u001a",
    target_unicode: "ρ",
    glyph_sha256: "4cbdb66a4c77a8d3544a862526cbf6918a1575df24ee425489fd4266aeaf0f2d",
    witnesses: Object.freeze([
      Object.freeze({ original_char_code: 11, glyph_sha256: "a8e84e0d932585f5ea43e57c1c6aa2ddc349dbf9c95f25dde63d953281094aed" }),
      Object.freeze({ original_char_code: 25, glyph_sha256: "8844ed36948e6f388a823fa06d5165b38e5c00b68d0a9196c4875d3a5ed4147c" }),
    ]),
  }),
  Object.freeze({
    id: "cmsy-pk-raster-greater-equal-b57ae2-v1",
    qualification: "ctan-cm-encoding-plus-reviewed-pk-raster-v1",
    family: "computer-modern-math-symbol",
    original_char_code: 21,
    source_unicode: "\u0015",
    target_unicode: "≥",
    glyph_sha256: "cf5071eb6c006bc80cf9399c28dc00f7e12d8e7f090942de46cb06d404481dd6",
    witnesses: Object.freeze([
      Object.freeze({ original_char_code: 0, glyph_sha256: "3f6fdf2abc68f5693f9ea7cdec4d94214a57fb953fb66c747b86dd1f6293d807" }),
      Object.freeze({ original_char_code: 112, glyph_sha256: "da5345f465509486a66762b6cf8918a3ba5c937f4ca8c7bc4657f4f905d0b4be" }),
    ]),
  }),
  Object.freeze({
    id: "cmsy-pk-raster-square-root-0c8ca6-v1",
    qualification: "ctan-cm-encoding-plus-reviewed-pk-raster-v1",
    family: "computer-modern-math-symbol",
    original_char_code: 112,
    source_unicode: "p",
    target_unicode: "√",
    glyph_sha256: "da5345f465509486a66762b6cf8918a3ba5c937f4ca8c7bc4657f4f905d0b4be",
    witnesses: Object.freeze([
      Object.freeze({ original_char_code: 0, glyph_sha256: "3f6fdf2abc68f5693f9ea7cdec4d94214a57fb953fb66c747b86dd1f6293d807" }),
      Object.freeze({ original_char_code: 21, glyph_sha256: "cf5071eb6c006bc80cf9399c28dc00f7e12d8e7f090942de46cb06d404481dd6" }),
    ]),
  }),
  Object.freeze({
    id: "cmsy-pk-raster-centered-dot-33077f-v1",
    qualification: "ctan-cm-encoding-plus-reviewed-pk-raster-v1",
    family: "computer-modern-math-symbol",
    original_char_code: 1,
    source_unicode: "\u0001",
    target_unicode: "⋅",
    glyph_sha256: "2ed87b069c99482d0823c085da9c199582e6e4b51172a2b360d9b6652066e3ae",
    witnesses: Object.freeze([
      Object.freeze({ original_char_code: 0, glyph_sha256: "68b4a1e125aa58ed3e798029190dbf4e2f3937030f921cd995cf7c8ad2f2eedc" }),
      Object.freeze({ original_char_code: 6, glyph_sha256: "f7b39315fb585e4066816ab2d3d3d07e1b1d79bb9a30fdae7fbf5588d2873906" }),
    ]),
  }),
  Object.freeze({
    id: "cmsy-pk-raster-less-or-equal-90da52-v1",
    qualification: "ctan-cm-encoding-plus-reviewed-pk-raster-v1",
    family: "computer-modern-math-symbol",
    original_char_code: 20,
    source_unicode: "\u0014",
    target_unicode: "≤",
    glyph_sha256: "1f5c8de996c9b3c20c6503052f62d18022e4b97537957d565a0b3668c3c4918d",
    witnesses: Object.freeze([
      Object.freeze({ original_char_code: 0, glyph_sha256: "68b4a1e125aa58ed3e798029190dbf4e2f3937030f921cd995cf7c8ad2f2eedc" }),
      Object.freeze({ original_char_code: 1, glyph_sha256: "2ed87b069c99482d0823c085da9c199582e6e4b51172a2b360d9b6652066e3ae" }),
    ]),
  }),
  Object.freeze({
    id: "cmsy-pk-raster-prime-352207-v1",
    qualification: "ctan-cm-encoding-plus-reviewed-pk-raster-v1",
    family: "computer-modern-math-symbol",
    original_char_code: 48,
    source_unicode: "0",
    target_unicode: "′",
    glyph_sha256: "70c2850ba731163e1e74c60f354ca5407181fd97b75b500deba6e92fe068f6ea",
    witnesses: Object.freeze([
      Object.freeze({ original_char_code: 0, glyph_sha256: "ed5df416bb312c2b49ed8936f226016a28e9a09fa52aba56281dd6a8a5430d19" }),
      Object.freeze({ original_char_code: 6, glyph_sha256: "4dd026f859f9674351763f1eec5d88e6ef486555ea12f8eb6a433b1a95238a19" }),
    ]),
  }),
  Object.freeze({
    id: "cmsy-pk-raster-vertical-6ab8a7-v1",
    qualification: "ctan-cm-encoding-plus-reviewed-pk-raster-v1",
    family: "computer-modern-math-symbol",
    original_char_code: 106,
    source_unicode: "j",
    target_unicode: "|",
    glyph_sha256: "6b5b24f359788e9c53ad35f6de00ff0cdf7637eb8cb1b6efb124d96ba54c071f",
    witnesses: Object.freeze([
      Object.freeze({ original_char_code: 0, glyph_sha256: "68b4a1e125aa58ed3e798029190dbf4e2f3937030f921cd995cf7c8ad2f2eedc" }),
      Object.freeze({ original_char_code: 1, glyph_sha256: "2ed87b069c99482d0823c085da9c199582e6e4b51172a2b360d9b6652066e3ae" }),
    ]),
  }),
  Object.freeze({
    id: "cmex-pk-raster-big-left-parenthesis-eeae0f-v1",
    qualification: "ctan-cm-encoding-plus-reviewed-pk-raster-v1",
    family: "computer-modern-math-extension",
    original_char_code: 0,
    source_unicode: "\u0000",
    target_unicode: "(",
    glyph_sha256: "db8987d9df1b673b7c30dca2e284cf446998ad64b8a0a7a50c607cb3a08de761",
    witnesses: Object.freeze([
      Object.freeze({ original_char_code: 1, glyph_sha256: "a06c1a0819e09411d527d1313e0c91e68f2985038930a9bead785d1d62372154" }),
      Object.freeze({ original_char_code: 2, glyph_sha256: "de6ca507791bcb2a932347364bab4103b89d0cc312119d313878eb3b904f66f6" }),
    ]),
  }),
  Object.freeze({
    id: "cmex-pk-raster-big-right-parenthesis-9a0788-v1",
    qualification: "ctan-cm-encoding-plus-reviewed-pk-raster-v1",
    family: "computer-modern-math-extension",
    original_char_code: 1,
    source_unicode: "\u0001",
    target_unicode: ")",
    glyph_sha256: "a06c1a0819e09411d527d1313e0c91e68f2985038930a9bead785d1d62372154",
    witnesses: Object.freeze([
      Object.freeze({ original_char_code: 0, glyph_sha256: "db8987d9df1b673b7c30dca2e284cf446998ad64b8a0a7a50c607cb3a08de761" }),
      Object.freeze({ original_char_code: 2, glyph_sha256: "de6ca507791bcb2a932347364bab4103b89d0cc312119d313878eb3b904f66f6" }),
    ]),
  }),
  Object.freeze({
    id: "cmex-pk-raster-big-left-bracket-add929-v1",
    qualification: "ctan-cm-encoding-plus-reviewed-pk-raster-v1",
    family: "computer-modern-math-extension",
    original_char_code: 2,
    source_unicode: "\u0002",
    target_unicode: "[",
    glyph_sha256: "de6ca507791bcb2a932347364bab4103b89d0cc312119d313878eb3b904f66f6",
    witnesses: Object.freeze([
      Object.freeze({ original_char_code: 0, glyph_sha256: "db8987d9df1b673b7c30dca2e284cf446998ad64b8a0a7a50c607cb3a08de761" }),
      Object.freeze({ original_char_code: 1, glyph_sha256: "a06c1a0819e09411d527d1313e0c91e68f2985038930a9bead785d1d62372154" }),
    ]),
  }),
  Object.freeze({
    id: "cmex-pk-raster-big-left-bracket-24e2fb-v1",
    qualification: "ctan-cm-encoding-plus-reviewed-pk-raster-v1",
    family: "computer-modern-math-extension",
    original_char_code: 2,
    source_unicode: "\u0002",
    target_unicode: "[",
    glyph_sha256: "6b0a15286d5c6eab2ff6a3ec1ae3f10b2bda4a2a502190a441875d1307a089ca",
    witnesses: Object.freeze([
      Object.freeze({ original_char_code: 3, glyph_sha256: "f760c316d37754edd56178f58f7935789b7cfec19a577e3de751f3437e258583" }),
      Object.freeze({ original_char_code: 16, glyph_sha256: "dd4cc29a14d2086fc3affe1d8c0bed29b1dc1b29df911950c6b5320e347dfebc" }),
    ]),
  }),
  Object.freeze({
    id: "cmex-pk-raster-big-right-bracket-a23d3c-v1",
    qualification: "ctan-cm-encoding-plus-reviewed-pk-raster-v1",
    family: "computer-modern-math-extension",
    original_char_code: 3,
    source_unicode: "\u0003",
    target_unicode: "]",
    glyph_sha256: "1ea7f7dfe19ac962ae5a1408a4ebdb91046dd499d108474b0d830235a07921d9",
    witnesses: Object.freeze([
      Object.freeze({ original_char_code: 0, glyph_sha256: "db8987d9df1b673b7c30dca2e284cf446998ad64b8a0a7a50c607cb3a08de761" }),
      Object.freeze({ original_char_code: 1, glyph_sha256: "a06c1a0819e09411d527d1313e0c91e68f2985038930a9bead785d1d62372154" }),
    ]),
  }),
  Object.freeze({
    id: "cmex-pk-raster-big-right-bracket-2810f1-v1",
    qualification: "ctan-cm-encoding-plus-reviewed-pk-raster-v1",
    family: "computer-modern-math-extension",
    original_char_code: 3,
    source_unicode: "\u0003",
    target_unicode: "]",
    glyph_sha256: "f760c316d37754edd56178f58f7935789b7cfec19a577e3de751f3437e258583",
    witnesses: Object.freeze([
      Object.freeze({ original_char_code: 2, glyph_sha256: "6b0a15286d5c6eab2ff6a3ec1ae3f10b2bda4a2a502190a441875d1307a089ca" }),
      Object.freeze({ original_char_code: 16, glyph_sha256: "dd4cc29a14d2086fc3affe1d8c0bed29b1dc1b29df911950c6b5320e347dfebc" }),
    ]),
  }),
  Object.freeze({
    id: "cmex-pk-raster-Big-left-parenthesis-1784be-v1",
    qualification: "ctan-cm-encoding-plus-reviewed-pk-raster-v1",
    family: "computer-modern-math-extension",
    original_char_code: 16,
    source_unicode: "\u0010",
    target_unicode: "(",
    glyph_sha256: "6e514ff075120591b98740dcd095c9f73ec09f5483c8705f75b7cc0e89178e31",
    witnesses: Object.freeze([
      Object.freeze({ original_char_code: 0, glyph_sha256: "db8987d9df1b673b7c30dca2e284cf446998ad64b8a0a7a50c607cb3a08de761" }),
      Object.freeze({ original_char_code: 1, glyph_sha256: "a06c1a0819e09411d527d1313e0c91e68f2985038930a9bead785d1d62372154" }),
    ]),
  }),
  Object.freeze({
    id: "cmex-pk-raster-Big-left-parenthesis-e0188e-v1",
    qualification: "ctan-cm-encoding-plus-reviewed-pk-raster-v1",
    family: "computer-modern-math-extension",
    original_char_code: 16,
    source_unicode: "\u0010",
    target_unicode: "(",
    glyph_sha256: "dd4cc29a14d2086fc3affe1d8c0bed29b1dc1b29df911950c6b5320e347dfebc",
    witnesses: Object.freeze([
      Object.freeze({ original_char_code: 2, glyph_sha256: "6b0a15286d5c6eab2ff6a3ec1ae3f10b2bda4a2a502190a441875d1307a089ca" }),
      Object.freeze({ original_char_code: 3, glyph_sha256: "f760c316d37754edd56178f58f7935789b7cfec19a577e3de751f3437e258583" }),
    ]),
  }),
  Object.freeze({
    id: "cmex-pk-raster-Big-right-parenthesis-fd720e-v1",
    qualification: "ctan-cm-encoding-plus-reviewed-pk-raster-v1",
    family: "computer-modern-math-extension",
    original_char_code: 17,
    source_unicode: "\u0011",
    target_unicode: ")",
    glyph_sha256: "4a24a711ec6fb485ffd8a893be44c48f0a9b91450c50219fd94176ff32938b15",
    witnesses: Object.freeze([
      Object.freeze({ original_char_code: 0, glyph_sha256: "db8987d9df1b673b7c30dca2e284cf446998ad64b8a0a7a50c607cb3a08de761" }),
      Object.freeze({ original_char_code: 1, glyph_sha256: "a06c1a0819e09411d527d1313e0c91e68f2985038930a9bead785d1d62372154" }),
    ]),
  }),
  Object.freeze({
    id: "cmex-pk-raster-Big-right-parenthesis-741b0e-v1",
    qualification: "ctan-cm-encoding-plus-reviewed-pk-raster-v1",
    family: "computer-modern-math-extension",
    original_char_code: 17,
    source_unicode: "\u0011",
    target_unicode: ")",
    glyph_sha256: "c62e5e3a49164445ab07b6786922a5d8cd5d6806bc687aab4027a7b834f30381",
    witnesses: Object.freeze([
      Object.freeze({ original_char_code: 2, glyph_sha256: "6b0a15286d5c6eab2ff6a3ec1ae3f10b2bda4a2a502190a441875d1307a089ca" }),
      Object.freeze({ original_char_code: 3, glyph_sha256: "f760c316d37754edd56178f58f7935789b7cfec19a577e3de751f3437e258583" }),
    ]),
  }),
  Object.freeze({
    id: "cmex-pk-raster-bigg-left-parenthesis-d0c76f-v1",
    qualification: "ctan-cm-encoding-plus-reviewed-pk-raster-v1",
    family: "computer-modern-math-extension",
    original_char_code: 18,
    source_unicode: "\u0012",
    target_unicode: "(",
    glyph_sha256: "2ea0b479a269492539f17c9eeb24b9836e2c337ac091081b66ec7267d67a6cbe",
    witnesses: Object.freeze([
      Object.freeze({ original_char_code: 0, glyph_sha256: "db8987d9df1b673b7c30dca2e284cf446998ad64b8a0a7a50c607cb3a08de761" }),
      Object.freeze({ original_char_code: 1, glyph_sha256: "a06c1a0819e09411d527d1313e0c91e68f2985038930a9bead785d1d62372154" }),
    ]),
  }),
  Object.freeze({
    id: "cmex-pk-raster-bigg-right-parenthesis-4787f4-v1",
    qualification: "ctan-cm-encoding-plus-reviewed-pk-raster-v1",
    family: "computer-modern-math-extension",
    original_char_code: 19,
    source_unicode: "\u0013",
    target_unicode: ")",
    glyph_sha256: "30ce6ba7dc248d84d411a6050c735dc52420bbfc2e127330da96bb3876fdc176",
    witnesses: Object.freeze([
      Object.freeze({ original_char_code: 0, glyph_sha256: "db8987d9df1b673b7c30dca2e284cf446998ad64b8a0a7a50c607cb3a08de761" }),
      Object.freeze({ original_char_code: 1, glyph_sha256: "a06c1a0819e09411d527d1313e0c91e68f2985038930a9bead785d1d62372154" }),
    ]),
  }),
  Object.freeze({
    id: "cmex-pk-raster-bigg-left-bracket-2daf02-v1",
    qualification: "ctan-cm-encoding-plus-reviewed-pk-raster-v1",
    family: "computer-modern-math-extension",
    original_char_code: 20,
    source_unicode: "\u0014",
    target_unicode: "[",
    glyph_sha256: "d7bb229a762f6389b264ecc8182d96463512edd9d15641adcddd80da1d62864a",
    witnesses: Object.freeze([
      Object.freeze({ original_char_code: 0, glyph_sha256: "db8987d9df1b673b7c30dca2e284cf446998ad64b8a0a7a50c607cb3a08de761" }),
      Object.freeze({ original_char_code: 1, glyph_sha256: "a06c1a0819e09411d527d1313e0c91e68f2985038930a9bead785d1d62372154" }),
    ]),
  }),
  Object.freeze({
    id: "cmex-pk-raster-bigg-left-bracket-42ccb4-v1",
    qualification: "ctan-cm-encoding-plus-reviewed-pk-raster-v1",
    family: "computer-modern-math-extension",
    original_char_code: 20,
    source_unicode: "\u0014",
    target_unicode: "[",
    glyph_sha256: "5d63c680f912fa771991bec647d6024bbffc00377ef7515cd5eb4a063ac6fb30",
    witnesses: Object.freeze([
      Object.freeze({ original_char_code: 2, glyph_sha256: "6b0a15286d5c6eab2ff6a3ec1ae3f10b2bda4a2a502190a441875d1307a089ca" }),
      Object.freeze({ original_char_code: 3, glyph_sha256: "f760c316d37754edd56178f58f7935789b7cfec19a577e3de751f3437e258583" }),
    ]),
  }),
  Object.freeze({
    id: "cmex-pk-raster-bigg-right-bracket-50dd65-v1",
    qualification: "ctan-cm-encoding-plus-reviewed-pk-raster-v1",
    family: "computer-modern-math-extension",
    original_char_code: 21,
    source_unicode: "\u0015",
    target_unicode: "]",
    glyph_sha256: "c041f94f074b2255945dfb7dd0a115ae7ce4a97002147ca315fa7647362120a0",
    witnesses: Object.freeze([
      Object.freeze({ original_char_code: 0, glyph_sha256: "db8987d9df1b673b7c30dca2e284cf446998ad64b8a0a7a50c607cb3a08de761" }),
      Object.freeze({ original_char_code: 1, glyph_sha256: "a06c1a0819e09411d527d1313e0c91e68f2985038930a9bead785d1d62372154" }),
    ]),
  }),
  Object.freeze({
    id: "cmex-pk-raster-bigg-right-bracket-ebfd69-v1",
    qualification: "ctan-cm-encoding-plus-reviewed-pk-raster-v1",
    family: "computer-modern-math-extension",
    original_char_code: 21,
    source_unicode: "\u0015",
    target_unicode: "]",
    glyph_sha256: "5aac802aecbaec1d9ed686ae4ddc1bb6c8bce048462620ec5582b95c0299661d",
    witnesses: Object.freeze([
      Object.freeze({ original_char_code: 2, glyph_sha256: "6b0a15286d5c6eab2ff6a3ec1ae3f10b2bda4a2a502190a441875d1307a089ca" }),
      Object.freeze({ original_char_code: 3, glyph_sha256: "f760c316d37754edd56178f58f7935789b7cfec19a577e3de751f3437e258583" }),
    ]),
  }),
  Object.freeze({
    id: "cmmi-pk-raster-Delta-762215-v1",
    qualification: "ctan-cm-encoding-plus-reviewed-pk-raster-v1",
    family: "computer-modern-math-italic",
    original_char_code: 1,
    source_unicode: "\u0001",
    target_unicode: "Δ",
    glyph_sha256: "d3461f539f11089075b8a98c57a23114902418575458cb92fad483e950129164",
    witnesses: Object.freeze([
      Object.freeze({ original_char_code: 11, glyph_sha256: "55bb60d8560069c0650380cf09cdd023866ca4b91bb92b2fe4b45a056da1bf47" }),
      Object.freeze({ original_char_code: 14, glyph_sha256: "b2f587826f470886f73db237c0dcc326ea588e176bee087052b5ee7fec6e4cd6" }),
    ]),
  }),
  Object.freeze({
    id: "cmmi-pk-raster-delta-a5a76e-v1",
    qualification: "ctan-cm-encoding-plus-reviewed-pk-raster-v1",
    family: "computer-modern-math-italic",
    original_char_code: 14,
    source_unicode: "\u000e",
    target_unicode: "δ",
    glyph_sha256: "b2f587826f470886f73db237c0dcc326ea588e176bee087052b5ee7fec6e4cd6",
    witnesses: Object.freeze([
      Object.freeze({ original_char_code: 1, glyph_sha256: "d3461f539f11089075b8a98c57a23114902418575458cb92fad483e950129164" }),
      Object.freeze({ original_char_code: 11, glyph_sha256: "55bb60d8560069c0650380cf09cdd023866ca4b91bb92b2fe4b45a056da1bf47" }),
    ]),
  }),
  Object.freeze({
    id: "cmmi-pk-raster-delta-b41124-v1",
    qualification: "ctan-cm-encoding-plus-reviewed-pk-raster-v1",
    family: "computer-modern-math-italic",
    original_char_code: 14,
    source_unicode: "\u000e",
    target_unicode: "δ",
    glyph_sha256: "e8cb8e148c83465beb80f9a888fecb2b5b9a0e4625701b97cc149ffc893ed1ed",
    witnesses: Object.freeze([
      Object.freeze({ original_char_code: 11, glyph_sha256: "afd53079aef8914177830dd32a4751df81d06ef083e4d1a0fc641896dc827fb4" }),
      Object.freeze({ original_char_code: 15, glyph_sha256: "cb992b6a906e74dce8a20f585dc7c3befd47b7f99356f6e0acfeff69b324a367" }),
    ]),
  }),
  Object.freeze({
    id: "cmmi-pk-raster-epsilon-376b93-v1",
    qualification: "ctan-cm-encoding-plus-reviewed-pk-raster-v1",
    family: "computer-modern-math-italic",
    original_char_code: 15,
    source_unicode: "\u000f",
    target_unicode: "ϵ",
    glyph_sha256: "c05d44175c21bf871787e49b7e44630f1424dec624ed460442d05060a67283df",
    witnesses: Object.freeze([
      Object.freeze({ original_char_code: 1, glyph_sha256: "d3461f539f11089075b8a98c57a23114902418575458cb92fad483e950129164" }),
      Object.freeze({ original_char_code: 11, glyph_sha256: "55bb60d8560069c0650380cf09cdd023866ca4b91bb92b2fe4b45a056da1bf47" }),
    ]),
  }),
  Object.freeze({
    id: "cmmi-pk-raster-epsilon-7c6298-v1",
    qualification: "ctan-cm-encoding-plus-reviewed-pk-raster-v1",
    family: "computer-modern-math-italic",
    original_char_code: 15,
    source_unicode: "\u000f",
    target_unicode: "ϵ",
    glyph_sha256: "cb992b6a906e74dce8a20f585dc7c3befd47b7f99356f6e0acfeff69b324a367",
    witnesses: Object.freeze([
      Object.freeze({ original_char_code: 11, glyph_sha256: "afd53079aef8914177830dd32a4751df81d06ef083e4d1a0fc641896dc827fb4" }),
      Object.freeze({ original_char_code: 14, glyph_sha256: "e8cb8e148c83465beb80f9a888fecb2b5b9a0e4625701b97cc149ffc893ed1ed" }),
    ]),
  }),
  Object.freeze({
    id: "cmmi-pk-raster-eta-a19a51-v1",
    qualification: "ctan-cm-encoding-plus-reviewed-pk-raster-v1",
    family: "computer-modern-math-italic",
    original_char_code: 17,
    source_unicode: "\u0011",
    target_unicode: "η",
    glyph_sha256: "9d63d43c9de79f2045762af5a19d73f86c29c9dfbbb96ca3913f7a7d3fe83255",
    witnesses: Object.freeze([
      Object.freeze({ original_char_code: 11, glyph_sha256: "afd53079aef8914177830dd32a4751df81d06ef083e4d1a0fc641896dc827fb4" }),
      Object.freeze({ original_char_code: 14, glyph_sha256: "e8cb8e148c83465beb80f9a888fecb2b5b9a0e4625701b97cc149ffc893ed1ed" }),
    ]),
  }),
  Object.freeze({
    id: "cmmi-pk-raster-theta-700332-v1",
    qualification: "ctan-cm-encoding-plus-reviewed-pk-raster-v1",
    family: "computer-modern-math-italic",
    original_char_code: 18,
    source_unicode: "\u0012",
    target_unicode: "θ",
    glyph_sha256: "2f363c697c4ee84b7785dc606f0b38c93d8f4d63ea076784943858eae5c58859",
    witnesses: Object.freeze([
      Object.freeze({ original_char_code: 11, glyph_sha256: "afd53079aef8914177830dd32a4751df81d06ef083e4d1a0fc641896dc827fb4" }),
      Object.freeze({ original_char_code: 14, glyph_sha256: "e8cb8e148c83465beb80f9a888fecb2b5b9a0e4625701b97cc149ffc893ed1ed" }),
    ]),
  }),
  Object.freeze({
    id: "cmmi-pk-raster-lambda-25c0ac-v1",
    qualification: "ctan-cm-encoding-plus-reviewed-pk-raster-v1",
    family: "computer-modern-math-italic",
    original_char_code: 21,
    source_unicode: "\u0015",
    target_unicode: "λ",
    glyph_sha256: "41831967f0efef3f08cc7cdc544673323d526955d54eb70a02c0759c7fd4a2ff",
    witnesses: Object.freeze([
      Object.freeze({ original_char_code: 1, glyph_sha256: "d3461f539f11089075b8a98c57a23114902418575458cb92fad483e950129164" }),
      Object.freeze({ original_char_code: 11, glyph_sha256: "55bb60d8560069c0650380cf09cdd023866ca4b91bb92b2fe4b45a056da1bf47" }),
    ]),
  }),
  Object.freeze({
    id: "cmmi-pk-raster-lambda-2023b7-v1",
    qualification: "ctan-cm-encoding-plus-reviewed-pk-raster-v1",
    family: "computer-modern-math-italic",
    original_char_code: 21,
    source_unicode: "\u0015",
    target_unicode: "λ",
    glyph_sha256: "75980da7a10a36beb8fccf4970e9295c03fe44be69bf167dacfdead776e5163f",
    witnesses: Object.freeze([
      Object.freeze({ original_char_code: 11, glyph_sha256: "afd53079aef8914177830dd32a4751df81d06ef083e4d1a0fc641896dc827fb4" }),
      Object.freeze({ original_char_code: 14, glyph_sha256: "e8cb8e148c83465beb80f9a888fecb2b5b9a0e4625701b97cc149ffc893ed1ed" }),
    ]),
  }),
  Object.freeze({
    id: "cmmi-pk-raster-mu-2c7d9c-v1",
    qualification: "ctan-cm-encoding-plus-reviewed-pk-raster-v1",
    family: "computer-modern-math-italic",
    original_char_code: 22,
    source_unicode: "\u0016",
    target_unicode: "μ",
    glyph_sha256: "9bb6e58efa558b61d35a7d6c83ee5d6404c734858f689177a6527efe04065404",
    witnesses: Object.freeze([
      Object.freeze({ original_char_code: 1, glyph_sha256: "d3461f539f11089075b8a98c57a23114902418575458cb92fad483e950129164" }),
      Object.freeze({ original_char_code: 11, glyph_sha256: "55bb60d8560069c0650380cf09cdd023866ca4b91bb92b2fe4b45a056da1bf47" }),
    ]),
  }),
  Object.freeze({
    id: "cmmi-pk-raster-nu-f46329-v1",
    qualification: "ctan-cm-encoding-plus-reviewed-pk-raster-v1",
    family: "computer-modern-math-italic",
    original_char_code: 23,
    source_unicode: "\u0017",
    target_unicode: "ν",
    glyph_sha256: "6f42ddf03199aeb21b3487177b315979b4afafe5f3a499805c49bf5bd46d719e",
    witnesses: Object.freeze([
      Object.freeze({ original_char_code: 1, glyph_sha256: "d3461f539f11089075b8a98c57a23114902418575458cb92fad483e950129164" }),
      Object.freeze({ original_char_code: 11, glyph_sha256: "55bb60d8560069c0650380cf09cdd023866ca4b91bb92b2fe4b45a056da1bf47" }),
    ]),
  }),
  Object.freeze({
    id: "cmmi-pk-raster-sigma-94bd43-v1",
    qualification: "ctan-cm-encoding-plus-reviewed-pk-raster-v1",
    family: "computer-modern-math-italic",
    original_char_code: 27,
    source_unicode: "\u001b",
    target_unicode: "σ",
    glyph_sha256: "06ec7ab10994040dc4927dbc3da9884ebf14f0da502e9240cdaec07d1443998d",
    witnesses: Object.freeze([
      Object.freeze({ original_char_code: 11, glyph_sha256: "afd53079aef8914177830dd32a4751df81d06ef083e4d1a0fc641896dc827fb4" }),
      Object.freeze({ original_char_code: 14, glyph_sha256: "e8cb8e148c83465beb80f9a888fecb2b5b9a0e4625701b97cc149ffc893ed1ed" }),
    ]),
  }),
  Object.freeze({
    id: "cmmi-pk-raster-tau-53992a-v1",
    qualification: "ctan-cm-encoding-plus-reviewed-pk-raster-v1",
    family: "computer-modern-math-italic",
    original_char_code: 28,
    source_unicode: "\u001c",
    target_unicode: "τ",
    glyph_sha256: "c01bf46eb9a8d19c7fb57d94905839c2fc2ba40450c736e8996ccd72948fa4ab",
    witnesses: Object.freeze([
      Object.freeze({ original_char_code: 1, glyph_sha256: "d3461f539f11089075b8a98c57a23114902418575458cb92fad483e950129164" }),
      Object.freeze({ original_char_code: 11, glyph_sha256: "55bb60d8560069c0650380cf09cdd023866ca4b91bb92b2fe4b45a056da1bf47" }),
    ]),
  }),
  Object.freeze({
    id: "cmmi-pk-raster-variant-phi-117a85-v1",
    qualification: "ctan-cm-encoding-plus-reviewed-pk-raster-v1",
    family: "computer-modern-math-italic",
    original_char_code: 39,
    source_unicode: "'",
    target_unicode: "φ",
    glyph_sha256: "31ddaca9be2bbf03dd58481b7516a3447a4ce89938ce2d99067b37805e08debd",
    witnesses: Object.freeze([
      Object.freeze({ original_char_code: 1, glyph_sha256: "d3461f539f11089075b8a98c57a23114902418575458cb92fad483e950129164" }),
      Object.freeze({ original_char_code: 11, glyph_sha256: "55bb60d8560069c0650380cf09cdd023866ca4b91bb92b2fe4b45a056da1bf47" }),
    ]),
  }),
  Object.freeze({
    id: "cmex-pk-raster-textstyle-integral-e5fa9e-v1",
    qualification: "ctan-cm-encoding-plus-reviewed-pk-raster-v1",
    family: "computer-modern-math-extension",
    original_char_code: 82,
    source_unicode: "R",
    target_unicode: "∫",
    glyph_sha256: "362d48887daf303c09269e0fbc69db2338f062ce758cd9e242d3306f9f0c1952",
    complete_font_enrollment: Object.freeze([82, 90]),
    witnesses: Object.freeze([
      Object.freeze({ original_char_code: 90, glyph_sha256: "e5844045853943e3424dc224e60ba1217a509b2cc8e20f67a3504b141ed3c9c9" }),
    ]),
  }),
  Object.freeze({
    id: "cmex-pk-raster-displaystyle-integral-4a183f-v1",
    qualification: "ctan-cm-encoding-plus-reviewed-pk-raster-v1",
    family: "computer-modern-math-extension",
    original_char_code: 90,
    source_unicode: "Z",
    target_unicode: "∫",
    glyph_sha256: "e5844045853943e3424dc224e60ba1217a509b2cc8e20f67a3504b141ed3c9c9",
    complete_font_enrollment: Object.freeze([82, 90]),
    witnesses: Object.freeze([
      Object.freeze({ original_char_code: 82, glyph_sha256: "362d48887daf303c09269e0fbc69db2338f062ce758cd9e242d3306f9f0c1952" }),
    ]),
  }),
  Object.freeze({
    id: "cmsy-pk-raster-plus-or-minus-b68b24-v1",
    qualification: "ctan-cm-encoding-plus-reviewed-pk-raster-v1",
    family: "computer-modern-math-symbol",
    original_char_code: 6,
    source_unicode: "\u0006",
    target_unicode: "±",
    glyph_sha256: "4dd026f859f9674351763f1eec5d88e6ef486555ea12f8eb6a433b1a95238a19",
    witnesses: Object.freeze([
      Object.freeze({ original_char_code: 0, glyph_sha256: "ed5df416bb312c2b49ed8936f226016a28e9a09fa52aba56281dd6a8a5430d19" }),
      Object.freeze({ original_char_code: 33, glyph_sha256: "a818ff8e95ae122382e0f0198e875400f4cc07ef1115dbe936ad5dd37933c4d4" }),
    ]),
  }),
  Object.freeze({
    id: "cmsy-pk-raster-right-arrow-7d300b-v1",
    qualification: "ctan-cm-encoding-plus-reviewed-pk-raster-v1",
    family: "computer-modern-math-symbol",
    original_char_code: 33,
    source_unicode: "!",
    target_unicode: "→",
    glyph_sha256: "3efef4ea645a3cd8776d728305dd613116e17b74b006570e8cc6fd8a4b1dbb4b",
    witnesses: Object.freeze([
      Object.freeze({ original_char_code: 0, glyph_sha256: "68b4a1e125aa58ed3e798029190dbf4e2f3937030f921cd995cf7c8ad2f2eedc" }),
      Object.freeze({ original_char_code: 1, glyph_sha256: "2ed87b069c99482d0823c085da9c199582e6e4b51172a2b360d9b6652066e3ae" }),
    ]),
  }),
  Object.freeze({
    id: "cmsy-pk-raster-right-arrow-6ff1e0-v1",
    qualification: "ctan-cm-encoding-plus-reviewed-pk-raster-v1",
    family: "computer-modern-math-symbol",
    original_char_code: 33,
    source_unicode: "!",
    target_unicode: "→",
    glyph_sha256: "a818ff8e95ae122382e0f0198e875400f4cc07ef1115dbe936ad5dd37933c4d4",
    witnesses: Object.freeze([
      Object.freeze({ original_char_code: 0, glyph_sha256: "ed5df416bb312c2b49ed8936f226016a28e9a09fa52aba56281dd6a8a5430d19" }),
      Object.freeze({ original_char_code: 6, glyph_sha256: "4dd026f859f9674351763f1eec5d88e6ef486555ea12f8eb6a433b1a95238a19" }),
    ]),
  }),
  Object.freeze({
    id: "cmmi-pk-raster-eta-2fd7e5-v1",
    qualification: "ctan-cm-encoding-plus-reviewed-pk-raster-v1",
    family: "computer-modern-math-italic",
    original_char_code: 17,
    source_unicode: "\u0011",
    target_unicode: "η",
    glyph_sha256: "b92c6fb549abb85d45c5ef490227e3accba0f512901b57fb72079a7232ed51fe",
    witnesses: Object.freeze([
      Object.freeze({ original_char_code: 11, glyph_sha256: "55bb60d8560069c0650380cf09cdd023866ca4b91bb92b2fe4b45a056da1bf47" }),
      Object.freeze({ original_char_code: 25, glyph_sha256: "9554966ab58edc060791bd02f04513a8da4a749f80a943d2daa3460a393fee7f" }),
    ]),
  }),
  Object.freeze({
    id: "cmmi-pk-raster-theta-194bcc-v1",
    qualification: "ctan-cm-encoding-plus-reviewed-pk-raster-v1",
    family: "computer-modern-math-italic",
    original_char_code: 18,
    source_unicode: "\u0012",
    target_unicode: "θ",
    glyph_sha256: "23102a1771564bb5329a4dbceb26cb3c92ee878dc907664891121ffd96cd4924",
    witnesses: Object.freeze([
      Object.freeze({ original_char_code: 11, glyph_sha256: "55bb60d8560069c0650380cf09cdd023866ca4b91bb92b2fe4b45a056da1bf47" }),
      Object.freeze({ original_char_code: 25, glyph_sha256: "9554966ab58edc060791bd02f04513a8da4a749f80a943d2daa3460a393fee7f" }),
    ]),
  }),
  Object.freeze({
    id: "cmmi-pk-raster-sigma-dae3aa-v1",
    qualification: "ctan-cm-encoding-plus-reviewed-pk-raster-v1",
    family: "computer-modern-math-italic",
    original_char_code: 27,
    source_unicode: "\u001b",
    target_unicode: "σ",
    glyph_sha256: "dfba03d4b605f4ae62fd08d5829cc2e26549f0f40d2d2b9a11adf2db1046a10a",
    witnesses: Object.freeze([
      Object.freeze({ original_char_code: 11, glyph_sha256: "55bb60d8560069c0650380cf09cdd023866ca4b91bb92b2fe4b45a056da1bf47" }),
      Object.freeze({ original_char_code: 25, glyph_sha256: "9554966ab58edc060791bd02f04513a8da4a749f80a943d2daa3460a393fee7f" }),
    ]),
  }),
  Object.freeze({
    id: "cmsy-pk-raster-plus-or-minus-4dedb5-v1",
    qualification: "ctan-cm-encoding-plus-reviewed-pk-raster-v1",
    family: "computer-modern-math-symbol",
    original_char_code: 6,
    source_unicode: "\u0006",
    target_unicode: "±",
    glyph_sha256: "f7b39315fb585e4066816ab2d3d3d07e1b1d79bb9a30fdae7fbf5588d2873906",
    witnesses: Object.freeze([
      Object.freeze({ original_char_code: 0, glyph_sha256: "68b4a1e125aa58ed3e798029190dbf4e2f3937030f921cd995cf7c8ad2f2eedc" }),
      Object.freeze({ original_char_code: 21, glyph_sha256: "520751dc437215219c1269212ade701dc57b1484416b9bad9ef3da2806bb53e9" }),
    ]),
  }),
]);

/*
 * The second enrollment lane: Computer Modern rasters GENERATED from the
 * pinned CTAN METAFONT sources rather than read off one document and reviewed.
 *
 * Entries above carry `ctan-cm-encoding-plus-reviewed-pk-raster-v1`: a human
 * looked at a raster the Shannon document actually contains, recognised the
 * character, and enrolled that document's own bytes. That is honest evidence
 * and it is also evidence about one document. Entries built here carry
 * `ctan-cm-metafont-generated-pk-v1`, which is a different and stronger
 * class: the raster is what Knuth's own sources produce at a pinned
 * rasterisation setting, nobody looked at a picture, and the whole chain —
 * archive digest, per-face source digest, METAFONT and GFtoPK versions, the
 * four pinned numbers — is recorded in
 * `test/fixtures/eval/extraction/type3-cm-pk-reference.provenance.json` and
 * reproducible from `scripts/generate-type3-cm-pk-reference.mjs`. The two
 * strings are deliberately different so a consumer can tell which kind of
 * evidence a recovery rests on.
 *
 * The generated table is a per-face map from officially enrolled slot to mask
 * digest. It is not itself a set of registry entries, because an entry also
 * needs its corroboration fixed in advance: the semantic validator re-derives
 * `witness_glyph_sha256` from the named entry, so witnesses cannot be chosen
 * at match time. Two entry shapes are built from each face, and the pair of
 * shapes is what makes the expansion safe.
 *
 * WHY THIS CANNOT COLLIDE WITH THE REVIEWED LANE, OR WITH ITSELF.
 * `matchingRegistryEntries` drops a code that two entries both match, so an
 * over-eager expansion here would *delete* recoveries rather than add them.
 * Two entries can only both match one code if they carry the same
 * `glyph_sha256`, since each is compared against the one digest the font has
 * at that code. Three rules follow, and together they are exhaustive:
 *
 *   1. A generated entry is skipped outright when the reviewed lane already
 *      holds the same (family, code, digest). That is the only way a
 *      generated entry could collide with a reviewed one, so the reviewed
 *      lane keeps every recovery it has today, unchanged and under its own
 *      qualification.
 *   2. The `solo` shape declares `complete_font_enrollment: [code, witness]`,
 *      so it fires only for a font drawing exactly those two enrolled slots.
 *      Two solo entries with different witnesses demand different complete
 *      footprints and are mutually exclusive; a solo and a `duo` are mutually
 *      exclusive because a duo needs three enrolled slots present and a solo
 *      needs exactly two. Solo entries are what recover a heavily subsetted
 *      dvips font, which is the common shape: astro-ph/9402001's one
 *      recoverable Computer Modern font draws exactly two enrolled slots.
 *   3. The `duo` shape carries two witnesses and no footprint, and is emitted
 *      only when its (family, code, digest) occurs in exactly one generated
 *      face. Two duo entries for one code would otherwise be able to pick
 *      different witness codes and both match.
 *
 * Identical tuples produced by two faces are collapsed to one entry, so a
 * shape shared by two design sizes is enrolled once.
 *
 * NO ENTRY MAY REST ON RECTANGLES ALONE.
 * Twenty of the reference's distinct digests are featureless filled
 * rectangles: Computer Modern's math minus at cmsy code 0 and its vertical bar
 * at code 106, at ten design sizes each. A solid rectangle's digest is decided
 * entirely by two integers, so it is not really shape evidence — any producer
 * that draws a rule of that pixel size produces that digest. Eleven face
 * records key both, and the naive construction emitted 22 `solo` entries from
 * them — each code against the other — whose whole case was "a solid block,
 * corroborated by another solid block". A Ghostscript-synthesised rule
 * font with a horizontal rule at code 0 and a vertical rule at code 106 would
 * have been transcribed as `−` and `|` with no gap reported.
 *
 * So an entry is built only when at least one raster in its evidence set — its
 * own glyph or one of its witnesses — is NOT a solid rectangle. Stated over
 * the evidence set rather than over the witnesses alone because the
 * distinguishing question is whether the whole case reduces to integers, not
 * which slot the shape sits in: a rectangle recovered against a shaped witness
 * is sound (the witness's exact digest is what identifies the font, and the
 * family pin, the metric pin and the complete-font footprint all still apply),
 * and a shaped glyph recovered against a rectangular witness is sound for the
 * same reason. Only the all-rectangle case is refused, and refusing it defeats
 * the rule-font attack outright, because a font of nothing but rules can never
 * supply the non-rectangular member.
 *
 * This does keep astro-ph/9402001's math-minus recoveries: that font's minus
 * IS an 18x2 solid bar, but it is corroborated by code 48, a 7x15 diagonal
 * prime stroke, so the evidence set is not all rectangles.
 *
 * `record.solid` is generated alongside the digests by
 * `scripts/generate-type3-cm-pk-reference.mjs`, which measures it on the same
 * decoded raster it hashes.
 */
function generatedPkRecoveryEntries() {
  const reviewedTriples = new Set(TYPE3_RECOVERY_REGISTRY.map(
    entry => `${entry.family}:${entry.original_char_code}:${entry.glyph_sha256}`,
  ));
  const facesByTriple = new Map();
  const solidByRecord = new Map();
  for (const record of CM_PK_REFERENCE_FACES) {
    // The rectangle census is load-bearing for the rule below, so a reference
    // that does not carry one — or carries one naming a slot it does not key —
    // is refused at load rather than quietly treated as "no rectangles here".
    if (!Array.isArray(record.solid)) {
      throw new Error(`Generated Computer Modern record ${record.face}@${record.profile} declares no rectangle census`);
    }
    for (const code of record.solid) {
      if (record.codes[code] === undefined) {
        throw new Error(
          `Generated Computer Modern record ${record.face}@${record.profile}`
          + ` calls unkeyed slot ${code} a rectangle`,
        );
      }
    }
    solidByRecord.set(record, new Set(record.solid));
    for (const [code, digest] of Object.entries(record.codes)) {
      const triple = `${record.family}:${code}:${digest}`;
      facesByTriple.set(triple, (facesByTriple.get(triple) ?? 0) + 1);
    }
  }
  const byTuple = new Map();
  const remember = (record, code, digest, kind, witnessCodes, footprint) => {
    // The whole evidence set is two integers per raster and nothing else.
    // Refused: see the block comment above.
    const solid = solidByRecord.get(record);
    if (solid.has(code) && witnessCodes.every(witness => solid.has(witness))) return;
    const witnesses = witnessCodes.map(witness => Object.freeze({
      original_char_code: witness,
      glyph_sha256: record.codes[witness],
    }));
    const tuple = `${record.family}:${code}:${digest}:${kind}:`
      + witnesses.map(witness => `${witness.original_char_code}=${witness.glyph_sha256}`).join(",");
    if (byTuple.has(tuple)) return;
    byTuple.set(tuple, Object.freeze({
      id: `${record.face}-${record.profile}-pk-c${code}-${kind}-w${witnessCodes.join("_")}-v1`,
      qualification: CM_PK_REFERENCE_QUALIFICATION,
      family: record.family,
      original_char_code: code,
      source_unicode: String.fromCharCode(code),
      target_unicode: CM_CODEPOINTS[record.family][code],
      glyph_sha256: digest,
      witnesses: Object.freeze(witnesses),
      ...(footprint ? { complete_font_enrollment: Object.freeze(footprint) } : {}),
    }));
  };
  for (const record of CM_PK_REFERENCE_FACES) {
    const codes = Object.keys(record.codes).map(Number).sort((left, right) => left - right);
    for (const code of codes) {
      const digest = record.codes[code];
      if (CM_CODEPOINTS[record.family]?.[code] === undefined) continue;
      if (reviewedTriples.has(`${record.family}:${code}:${digest}`)) continue;
      const others = codes.filter(candidate => candidate !== code);
      for (const witness of others) remember(record, code, digest, "solo", [witness], [code, witness]);
      if (others.length >= 2 && facesByTriple.get(`${record.family}:${code}:${digest}`) === 1) {
        remember(record, code, digest, "duo", others.slice(0, 2), null);
      }
    }
  }
  return [...byTuple.values()];
}

const TYPE3_GENERATED_PK_REGISTRY = Object.freeze(generatedPkRecoveryEntries());
/**
 * Every enrollment record the matcher can use, reviewed and generated
 * together. Exported so the recovery gate can assert the mutual-exclusion
 * argument above against the entries actually built, rather than against a
 * second copy of the reasoning written out in the test.
 */
export const TYPE3_RECOVERY_ENTRIES = Object.freeze([
  ...TYPE3_RECOVERY_REGISTRY,
  ...TYPE3_GENERATED_PK_REGISTRY,
]);
const TYPE3_ALL_RECOVERY_ENTRIES = TYPE3_RECOVERY_ENTRIES;
const TYPE3_RECOVERY_BY_ID = new Map(TYPE3_ALL_RECOVERY_ENTRIES.map(entry => [entry.id, entry]));
if (TYPE3_RECOVERY_BY_ID.size !== TYPE3_ALL_RECOVERY_ENTRIES.length) {
  throw new Error("Type-3 recovery entries do not have unique identifiers");
}
/*
 * Entries are looked up by the (family, code) pair the font is being asked
 * about rather than by scanning, because the generated lane is thousands of
 * entries and the scan runs once per Type-3 font per page. An entry whose
 * `original_char_code` the font does not draw could never pass
 * `evidenceIdentifiesCode`, so indexing on it changes nothing but the cost.
 */
const TYPE3_RECOVERY_BY_FAMILY_CODE = new Map();
for (const entry of TYPE3_ALL_RECOVERY_ENTRIES) {
  const key = `${entry.family}:${entry.original_char_code}`;
  if (!TYPE3_RECOVERY_BY_FAMILY_CODE.has(key)) TYPE3_RECOVERY_BY_FAMILY_CODE.set(key, []);
  TYPE3_RECOVERY_BY_FAMILY_CODE.get(key).push(entry);
}

for (const entry of TYPE3_ALL_RECOVERY_ENTRIES) {
  if (CM_CODEPOINTS[entry.family]?.[entry.original_char_code] !== entry.target_unicode) {
    throw new Error(`Type-3 registry ${entry.id} disagrees with the official Computer Modern encoding`);
  }
  const officialWitnesses = { ...CM_CODEPOINTS[entry.family], ...CM_WITNESS_CODEPOINTS[entry.family] };
  if (entry.witnesses.some(witness => officialWitnesses[witness.original_char_code] === undefined)) {
    throw new Error(`Type-3 registry ${entry.id} lacks official Computer Modern witnesses`);
  }
  // Corroboration only means anything if it comes from a different glyph. A
  // witness that repeats the entry's own code makes the witness digest check
  // the same comparison as the target digest check, and it collapses the
  // footprint set below so a single-witness entry could pass on no independent
  // evidence at all.
  const witnessCodes = entry.witnesses.map(witness => witness.original_char_code);
  if (new Set([entry.original_char_code, ...witnessCodes]).size !== witnessCodes.length + 1) {
    throw new Error(`Type-3 registry ${entry.id} reuses its own or a repeated witness code`);
  }
  // Two independent witnesses are the default corroboration. A dvips subset can
  // legitimately hold fewer official glyphs than that: an integrals-only cmex
  // font carries exactly two. Such an entry may name a single witness only by
  // declaring its font's complete official footprint, which the matcher then
  // requires to be present and matching in full and to have nothing else
  // enrolled outside it. That is not uniformly stronger than two witnesses: a
  // font holding more enrolled glyphs fails the footprint test and recovers
  // nothing, so the exception is narrow and tied to one subsetting shape.
  const footprint = entry.complete_font_enrollment ?? null;
  if (footprint && [...new Set(footprint)].some(code => CM_CODEPOINTS[entry.family]?.[code] === undefined)) {
    throw new Error(`Type-3 registry ${entry.id} declares an unenrolled code in its font footprint`);
  }
  if (entry.witnesses.length >= 2) {
    // A footprint is only meaningful as the single-witness escape hatch. Left on
    // a two-witness entry it would silently contradict the matcher and make the
    // entry permanently unreachable, so reject it here instead.
    if (footprint) throw new Error(`Type-3 registry ${entry.id} declares a font footprint it does not need`);
    continue;
  }
  const declared = new Set(footprint ?? []);
  const expected = new Set([entry.original_char_code, ...entry.witnesses.map(witness => witness.original_char_code)]);
  if (entry.witnesses.length !== 1
    || !footprint
    || declared.size !== expected.size
    || [...expected].some(code => !declared.has(code))
    || [...declared].some(code => officialWitnesses[code] === undefined)) {
    throw new Error(`Type-3 registry ${entry.id} lacks two official Computer Modern witnesses`);
  }
}

function normalizeType3CanonicalValue(value, state, depth = 0) {
  if (depth > MAX_TYPE3_GLYPH_CANONICAL_DEPTH) throw new Error("Type-3 glyph program is too deeply nested");
  state.nodes += 1;
  if (state.nodes > MAX_TYPE3_GLYPH_CANONICAL_NODES) throw new Error("Type-3 glyph program is too large");
  if (value === null || typeof value === "string" || typeof value === "boolean") return value;
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new Error("Type-3 glyph program contains a non-finite number");
    return value;
  }
  if (ArrayBuffer.isView(value)) {
    if (value.length > MAX_TYPE3_GLYPH_CANONICAL_NODES) throw new Error("Type-3 glyph array is too large");
    return { typed: value.constructor.name, values: Array.from(value, item => normalizeType3CanonicalValue(item, state, depth + 1)) };
  }
  if (Array.isArray(value)) return value.map(item => normalizeType3CanonicalValue(item, state, depth + 1));
  if (typeof value === "object") {
    return Object.fromEntries(Object.keys(value).sort().map(key => [
      key,
      normalizeType3CanonicalValue(value[key], state, depth + 1),
    ]));
  }
  throw new Error("Type-3 glyph program contains an unsupported value");
}

export function type3CharProcSha256(charProc) {
  if (!charProc || !Array.isArray(charProc.fnArray) || !Array.isArray(charProc.argsArray)) return null;
  try {
    const canonical = JSON.stringify(normalizeType3CanonicalValue({
      fnArray: charProc.fnArray,
      argsArray: charProc.argsArray,
    }, { nodes: 0 }));
    if (canonical.length > MAX_TYPE3_GLYPH_CANONICAL_BYTES) return null;
    return createHash("sha256").update(canonical).digest("hex");
  } catch {
    return null;
  }
}

function multiplyType3Transform(outer, inner) {
  return [
    outer[0] * inner[0] + outer[2] * inner[1],
    outer[1] * inner[0] + outer[3] * inner[1],
    outer[0] * inner[2] + outer[2] * inner[3],
    outer[1] * inner[2] + outer[3] * inner[3],
    outer[0] * inner[4] + outer[2] * inner[5] + outer[4],
    outer[1] * inner[4] + outer[3] * inner[5] + outer[5],
  ];
}

/**
 * Rebuilds the decoded 1-bit image-mask grid from the outline PDF.js compiles
 * for a Type-3 bitmap glyph.
 *
 * PDF.js does not hand out the decoded mask samples: for a Type-3 glyph whose
 * body is a single inline image mask it decodes the samples (applying /Decode,
 * /BlackIs1 and any CCITT or Flate filter), traces the painted pixels, and
 * emits one `rawFillPath` whose vertices sit exactly on the pixel lattice,
 * expressed in the unit square as `x / width` and `1 - row / height`. Every
 * edge is therefore axis-parallel and integral, and filling that outline with
 * the non-zero rule recovers the painted samples exactly. Verified bit for bit
 * against the 123 distinct inline masks of the Shannon reference document,
 * decoded independently straight out of the CharProcs streams.
 */
function type3GlyphImageMask(charProc, fontMatrix, ops) {
  if (!charProc || !Array.isArray(charProc.fnArray) || !Array.isArray(charProc.argsArray)) return null;
  if (!Array.isArray(fontMatrix) || fontMatrix.length !== 6 || !fontMatrix.every(Number.isFinite)) return null;
  if (![ops?.save, ops?.restore, ops?.transform, ops?.constructPath, ops?.rawFillPath,
    ops?.setCharWidthAndBounds].every(Number.isFinite)) return null;
  let current = [...fontMatrix];
  const stack = [];
  let painted = null;
  for (let index = 0; index < charProc.fnArray.length; index += 1) {
    const operation = charProc.fnArray[index];
    const args = charProc.argsArray[index];
    if (operation === ops.save) {
      if (stack.length > MAX_TYPE3_GLYPH_CANONICAL_DEPTH) return null;
      stack.push([...current]);
    } else if (operation === ops.restore) {
      if (stack.length === 0) return null;
      current = stack.pop();
    } else if (operation === ops.transform) {
      if (!Array.isArray(args) || args.length !== 6 || !args.every(Number.isFinite)) return null;
      current = multiplyType3Transform(current, args);
    } else if (operation === ops.setCharWidthAndBounds) {
      // Declares the glyph's advance and bounds. It paints nothing, and its
      // numbers are exactly the producer-specific placement this key drops.
    } else if (operation === ops.constructPath) {
      // A second painted object means this is not a plain single-mask glyph.
      if (painted || args?.[0] !== ops.rawFillPath) return null;
      painted = { path: args?.[1]?.[0], box: args?.[2], transform: current };
    } else {
      return null;
    }
  }
  if (!painted) return null;
  const { path, box, transform } = painted;
  if (!ArrayBuffer.isView(path) || !ArrayBuffer.isView(box) || box.length !== 4) return null;
  if (box[0] !== 0 || box[1] !== 0) return null;
  const width = box[2];
  const height = box[3];
  if (!Number.isInteger(width) || !Number.isInteger(height) || width <= 0 || height <= 0) return null;
  if (width * height > MAX_TYPE3_GLYPH_MASK_PIXELS) return null;
  if (path.length > MAX_TYPE3_GLYPH_MASK_PATH_NODES) return null;
  // Exactly what this checks: the CharProc-local matrix, meaning the font's
  // FontMatrix composed with the `cm` chain written inside this one glyph
  // program. Exactly what it does NOT check, and cannot: the text matrix and
  // the graphics CTM in force at the `Tj` that draws the glyph. Those are set
  // by the page content stream outside the CharProc and are invisible here, so
  // the absolute orientation the glyph is finally painted in is not knowable
  // from a CharProc, and nothing here claims to know it.
  //
  // Two things come out of the matrix. First, admissibility: the mask lane is
  // held to the plain axis-aligned, non-degenerate scale-or-reflection bitmap
  // idiom every enrolled entry was qualified on, so a glyph program that
  // rotates, shears, or collapses its own bitmap is a different construction
  // and is keyed by the exact operator digest instead. Second, the sign of the
  // CharProc-local determinant, which is not part of the key — it is
  // producer-dependent in absolute terms — but is comparable between two
  // glyphs of the same font. `type3FontPaintOrientation` uses it for exactly
  // that and nothing else.
  if (Math.abs(transform[1]) > 1e-9 || Math.abs(transform[2]) > 1e-9) return null;
  if (!(Math.abs(transform[0]) > 0) || !(Math.abs(transform[3]) > 0)) return null;
  const bits = fillAxisAlignedLatticePath(path, width, height);
  if (!bits) return null;
  return { width, height, bits, paint_orientation: Math.sign(transform[0] * transform[3]) };
}

function fillAxisAlignedLatticePath(path, width, height) {
  const crossings = Array.from({ length: height }, () => []);
  const lattice = (value, extent) => {
    const scaled = value * extent;
    const rounded = Math.round(scaled);
    if (!Number.isFinite(scaled) || Math.abs(scaled - rounded) > 1e-3) return null;
    return rounded < 0 || rounded > extent ? null : rounded;
  };
  const addEdge = (fromX, fromY, toX, toY) => {
    if (fromX !== toX) return fromY === toY;
    const direction = toY > fromY ? 1 : -1;
    for (let row = Math.min(fromY, toY); row < Math.max(fromY, toY); row += 1) {
      crossings[row].push([fromX, direction]);
    }
    return true;
  };
  let startX = 0;
  let startY = 0;
  let cursorX = 0;
  let cursorY = 0;
  let open = false;
  for (let index = 0; index < path.length;) {
    const operation = path[index];
    index += 1;
    if (operation !== DRAW_OPS.moveTo && operation !== DRAW_OPS.lineTo && operation !== DRAW_OPS.closePath) return null;
    if (operation === DRAW_OPS.closePath) {
      if (open && !addEdge(cursorX, cursorY, startX, startY)) return null;
      cursorX = startX;
      cursorY = startY;
      continue;
    }
    if (index + 1 >= path.length) return null;
    const x = lattice(path[index], width);
    // PDF.js emits the traced outline y-up in the unit square, so unit y 1 is
    // image row 0. Reading it back as a row index recovers the grid in the
    // stored sample order, which is the order the key is taken in.
    const y = lattice(1 - path[index + 1], height);
    index += 2;
    if (x === null || y === null) return null;
    if (operation === DRAW_OPS.moveTo) {
      if (open && !addEdge(cursorX, cursorY, startX, startY)) return null;
      startX = x;
      startY = y;
      open = true;
    } else if (!open || !addEdge(cursorX, cursorY, x, y)) {
      return null;
    }
    cursorX = x;
    cursorY = y;
  }
  if (open && !addEdge(cursorX, cursorY, startX, startY)) return null;
  const bits = new Uint8Array(width * height);
  for (let row = 0; row < height; row += 1) {
    const edges = crossings[row].sort((left, right) => left[0] - right[0]);
    let winding = 0;
    let previous = 0;
    for (const [x, direction] of edges) {
      if (winding !== 0) bits.fill(1, row * width + previous, row * width + x);
      winding += direction;
      previous = x;
    }
    if (winding !== 0) return null;
  }
  return bits;
}

/**
 * The producer-independent form of a decoded mask: the stored sample grid,
 * cropped to its own ink.
 *
 * The grid as stored is the canonical form on purpose. It is the one thing in
 * a Type-3 bitmap glyph that is a property of the glyph and of nothing else:
 * every matrix that could reorient it — the CharProc's own `cm`, the font's
 * FontMatrix, the text matrix, the page CTM — is chosen by the producer or by
 * the page that draws the character, and only the first two are even reachable
 * from inside a CharProc. Normalizing to painted orientation would therefore
 * mean keying partly on data this function cannot see, and did: an earlier
 * revision folded in `sign(FontMatrix x cm)` and gave two documents different
 * keys for a pixel-identical comma.
 *
 * The accepted consequence is that a glyph painted rotated or reflected keys
 * the same as the upright one. That is the correct answer for text set at an
 * angle, which is still the same character. Where it is wrong is a reflection
 * that turns the shape into a *different* enrolled character, and Computer
 * Modern has those: 16 of the shipped registry digests — eight mirror pairs,
 * the parenthesis and bracket pairs of the two enrolled cmex fonts — are the
 * exact horizontal mirror of another shipped digest. Measured, by mirroring
 * every registry grid the reference document resolves and looking the result
 * back up. A CharProc holding the stored raster of `]` but painting it
 * reflected paints `[`, and the grid alone cannot tell the two apart.
 *
 * Shape-code injectivity does not refuse that case, and an earlier revision of
 * this comment wrongly claimed it did. Injectivity asks whether one shape
 * stands at two enrolled codes of the font. The reflected glyph stands at one
 * code holding one raster; its mirror image lives at a different code holding
 * a different, genuinely mirrored raster. Both codes are injective and both
 * recover, one of them as the wrong character. Demonstrated on the Shannon
 * reference document by negating the x scale of a single CMEX CharProc `cm`
 * while leaving its mask bytes byte-identical.
 *
 * What refuses it is `type3FontPaintOrientation`: reflection relative to the
 * font's own siblings is detectable without knowing any absolute orientation.
 *
 * Also deliberately dropped: the blank padding around the ink and the operator
 * idiom that carried the samples. An inkless mask has no shape to key at all
 * and is rejected here rather than collapsing every blank glyph of every font
 * onto one digest.
 */
function canonicalType3MaskBits(mask) {
  const { width, height, bits } = mask;
  let top = height;
  let bottom = -1;
  let left = width;
  let right = -1;
  for (let row = 0; row < height; row += 1) {
    for (let column = 0; column < width; column += 1) {
      if (!bits[row * width + column]) continue;
      if (row < top) top = row;
      if (row > bottom) bottom = row;
      if (column < left) left = column;
      if (column > right) right = column;
    }
  }
  if (bottom < 0) return null;
  const inkWidth = right - left + 1;
  const inkHeight = bottom - top + 1;
  const stride = (inkWidth + 7) >> 3;
  const packed = Buffer.alloc(stride * inkHeight);
  for (let row = 0; row < inkHeight; row += 1) {
    for (let column = 0; column < inkWidth; column += 1) {
      if (bits[(top + row) * width + left + column]) packed[row * stride + (column >> 3)] |= 128 >> (column & 7);
    }
  }
  return { width: inkWidth, height: inkHeight, packed };
}

/**
 * The mask-lane recovery key for one decoded 1-bit grid, keyed on the ink box
 * alone so a glyph keys the same however much blank margin its producer left
 * around it.
 *
 * Exported because the generated Computer Modern ground-truth reference has to
 * key METAFONT output with exactly this function rather than a re-implementation
 * of it: `scripts/generate-type3-cm-pk-reference.mjs` decodes a PK raster to the
 * same row-major 1-bit grid a Type-3 image mask decodes to and hashes it here.
 * A second copy of this arithmetic would be a second thing to keep in step, and
 * a silent drift between the two would enrol digests that no document can ever
 * match.
 */
export function type3MaskGridSha256(width, height, bits) {
  const canonical = canonicalType3MaskBits({ width, height, bits });
  if (!canonical) return null;
  return createHash("sha256")
    .update(`${TYPE3_MASK_EVIDENCE_DOMAIN}:${canonical.width}x${canonical.height}:`)
    .update(canonical.packed)
    .digest("hex");
}

/**
 * The recovery key for one Type-3 glyph program.
 *
 * A glyph whose body is a single decoded image mask carrying ink is keyed on
 * the stored mask grid, so the same Computer Modern raster keys identically no
 * matter which dvips-era toolchain packed it, which filter it was compressed
 * with, or where and which way round the producer placed it inside the glyph
 * box. Anything else — an outline CharProc, a multi-object program, a glyph
 * program that rotates or shears its own bitmap, an inkless mask with no shape
 * to key — falls back to the exact canonicalized operator digest, which is
 * narrower but never wrong. The two lanes are domain-separated, so a mask
 * digest can never satisfy an operator-keyed registry entry or the reverse.
 *
 * `fontPaintOrientation` is the one sign every mask-lane glyph of this font
 * agrees on, from `type3FontPaintOrientation`, and is required for the mask
 * lane rather than optional: a caller with no font-wide answer gets the
 * operator lane, which is the safe direction. A glyph whose own CharProc-local
 * determinant sign disagrees with its siblings is reflected relative to them
 * and is refused the grid key.
 */
export function type3GlyphEvidenceSha256(charProc, fontMatrix, ops, fontPaintOrientation) {
  const mask = type3GlyphImageMask(charProc, fontMatrix, ops);
  const oriented = mask !== null
    && (fontPaintOrientation === 1 || fontPaintOrientation === -1)
    && mask.paint_orientation === fontPaintOrientation;
  const grid = oriented ? type3MaskGridSha256(mask.width, mask.height, mask.bits) : null;
  if (grid === null) {
    const operators = type3CharProcSha256(charProc);
    return operators === null
      ? null
      : createHash("sha256").update(`${TYPE3_CHARPROC_EVIDENCE_DOMAIN}:${operators}`).digest("hex");
  }
  return grid;
}

/*
 * The glyph name a /Differences entry really carries, as PDF.js sees it.
 *
 * PDF names escape an irregular byte as `#` plus two hexadecimal digits, and
 * ISO 32000-1 7.3.5 allows either letter case. pdf-lib's `decodeText()`
 * unescapes with `/#([\dABCDEF]{2})/g` — digits and UPPERCASE A-F only — so a
 * producer that writes lowercase hex leaves the escape sitting in the decoded
 * string. dvips-era Ghostscript names each Computer Modern glyph after its own
 * raw encoding byte, so a text font's ligature slots arrive as `/#0b`, `/#0c`,
 * `/#0d`, `/#0e` and pdf-lib reports the three-character strings `#0b`, `#0c`,
 * … while PDF.js keys the same CharProcs entries by the one-character names
 * U+000B, U+000C, and so on. `linkedRawType3Font` compares the two and the
 * whole font fails to link, which costs it every recovery and every census
 * row it would otherwise have.
 *
 * A residual escape cannot simply be unescaped again, because the same
 * three characters can be the glyph's real name. A producer that means the
 * literal name `#0B` writes `/#230B`; pdf-lib decodes the `#23` to `#` and
 * stops, and PDF.js decodes it exactly the same way, so both agree on `#0B`
 * and unescaping once more would break a font that links today. The Shannon
 * reference document is that case: all 29 of its escaped Type-3 glyph names
 * are `/#23`-prefixed, and blanket re-unescaping drops its linked occurrences
 * from 4,437 to 766.
 *
 * The two cases are separated exactly, not heuristically. pdf-lib already
 * consumed every escape whose digits are `[0-9A-F]`, so a residual `#hh` can
 * only be an escape pdf-lib missed when at least one of its digits is
 * lowercase `a-f`. `#0b` therefore came from a raw `/#0b`; `#0B`, `#28` and
 * `#2328` could not have, and are left alone. Both readings are offered to the
 * linker rather than one being chosen, so a font is still only linked when the
 * name PDF.js reports is one pdf-lib's bytes can actually produce.
 *
 * Measured on the corpus: astro-ph/9402001 goes from 7,019 to 100,108 of its
 * 100,114 drawn Type-3 occurrences attributable to a font dictionary, and
 * three further harvested documents recover in the same way, while Shannon and
 * the four Ghostscript 6.52 documents are unchanged to the occurrence.
 */
function type3GlyphNameCandidates(decodedName) {
  const unescaped = decodedName.replace(
    /#(?=[0-9a-fA-F]{2})([0-9a-fA-F]{2})/gu,
    (escape, digits) => (/[a-f]/u.test(digits) ? String.fromCharCode(Number.parseInt(digits, 16)) : escape),
  );
  return unescaped === decodedName ? Object.freeze([decodedName]) : Object.freeze([decodedName, unescaped]);
}

function fontEncodingDifferences(font, context) {
  const encoding = context.lookup(font.get(PDFName.of("Encoding")), PDFDict);
  const differences = encoding?.lookup(PDFName.of("Differences"), PDFArray);
  if (!differences) return null;
  const codeToGlyph = new Map();
  let code = null;
  for (let index = 0; index < differences.size(); index += 1) {
    const value = differences.lookup(index);
    if (value instanceof PDFNumber) {
      code = value.asNumber();
    } else if (value instanceof PDFName && Number.isSafeInteger(code) && code >= 0 && code <= 255) {
      codeToGlyph.set(code, type3GlyphNameCandidates(value.decodeText()));
      code += 1;
    } else {
      return null;
    }
  }
  return codeToGlyph;
}

function rawType3Fonts(pdfLibPage) {
  try {
    const context = pdfLibPage.doc.context;
    const resources = pdfLibPage.node.Resources();
    const fonts = resources?.lookup(PDFName.of("Font"), PDFDict);
    if (!fonts) return [];
    const records = [];
    for (const [, reference] of fonts.entries()) {
      const font = context.lookup(reference, PDFDict);
      if (font?.get(PDFName.of("Subtype"))?.toString() !== "/Type3") continue;
      /*
       * A font carrying its own /ToUnicode is deliberately left alone: PDF.js
       * already maps those glyphs, and overriding a valid producer-supplied
       * mapping would be a regression, not a recovery. It is still parsed and
       * kept here as a *competitor*, so that a page whose glyphs match both it
       * and a recoverable font is reported as ambiguous instead of silently
       * linking to the recoverable one. Retaining zero-width slots made many
       * more link attempts succeed, so the pool they have to be unique against
       * has to be the whole page, not just the recoverable part of it.
       */
      const recoverable = !font.has(PDFName.of("ToUnicode"));
      const first = font.lookup(PDFName.of("FirstChar"), PDFNumber)?.asNumber();
      const last = font.lookup(PDFName.of("LastChar"), PDFNumber)?.asNumber();
      const widthsArray = font.lookup(PDFName.of("Widths"), PDFArray);
      const codeToGlyph = fontEncodingDifferences(font, context);
      if (!Number.isSafeInteger(first) || !Number.isSafeInteger(last) || !widthsArray || !codeToGlyph) continue;
      if (first < 0 || last < first || widthsArray.size() !== last - first + 1) continue;
      /*
       * Two separate width views, because the two consumers need opposite
       * things from a declared zero.
       *
       * `widths` keeps every declared slot, zeros included. It is the linker's
       * evidence: a drawn glyph whose declared width is 0 is a fact about the
       * font, and dropping it turned the linker's `widths.get(code) === width`
       * test into `undefined === 0`, so a single legitimately zero-width drawn
       * glyph voided an otherwise perfect font match.
       *
       * `metricWidths` keeps only the positive slots, because that is what a
       * TFM scale can actually be fitted to: `metricScaleInterval` divides by
       * the reference width and an observed 0 pins the scale into
       * (-0.5/ref, +0.5/ref), which no real scale satisfies. Feeding zeros to
       * the family fingerprint would abolish family resolution outright.
       */
      const widths = new Map();
      const metricWidths = new Map();
      let valid = true;
      for (let code = first; code <= last; code += 1) {
        const width = widthsArray.lookup(code - first, PDFNumber)?.asNumber();
        if (!Number.isSafeInteger(width) || width < 0) {
          valid = false;
          break;
        }
        widths.set(code, width);
        if (width > 0) metricWidths.set(code, width);
      }
      if (!valid) continue;
      // The official Computer Modern encodings only reach code 127, so a font
      // declaring higher codes cannot be one of them and can only ever be a
      // competitor. Same for a font with no positive width at all: nothing can
      // fingerprint its family.
      records.push({
        widths,
        metricWidths,
        codeToGlyph,
        recoverable: recoverable && last <= 127 && metricWidths.size > 0,
      });
    }
    return records;
  } catch {
    return [];
  }
}

function metricScaleInterval(widths, metric) {
  let lower = 0;
  let upper = Infinity;
  for (const [code, observed] of widths) {
    const fixedWidth = metric.widths[code];
    if (!Number.isSafeInteger(fixedWidth) || fixedWidth <= 0) return null;
    const reference = fixedWidth / 1048576;
    lower = Math.max(lower, (observed - 0.5) / reference);
    upper = Math.min(upper, (observed + 0.5) / reference);
  }
  return lower < upper ? { lower, upper } : null;
}

export function uniqueComputerModernFamily(widthEntries) {
  const widths = widthEntries instanceof Map ? widthEntries : new Map(widthEntries);
  if (widths.size < 2) return null;
  const families = new Set();
  for (const metric of CM_TFM_METRICS) {
    if (metricScaleInterval(widths, metric)) families.add(metric.family);
  }
  return families.size === 1 ? [...families][0] : null;
}

function operatorGlyphTokens(operators, pdfjsPage, pdfjsLib) {
  const ops = pdfjsLib?.OPS ?? {};
  if (!operators || !Array.isArray(operators.fnArray) || !Array.isArray(operators.argsArray)) return null;
  const state = {
    current_font: null,
    font_size: 0,
    font_direction: 1,
    char_spacing: 0,
    word_spacing: 0,
    text_h_scale: 1,
    text_rise: 0,
    leading: 0,
    text_matrix: null,
    x: 0,
    y: 0,
    line_x: 0,
    line_y: 0,
    graphics_transform: identityTransform(),
  };
  const stateStack = [];
  const tokens = [];
  const allTokens = [];
  const fonts = new Map();
  const fontObjects = new Map();
  const unsupportedTextOps = new Set([
    ops.showSpacedText,
    ops.nextLineShowText,
    ops.nextLineSetSpacingShowText,
  ].filter(Number.isFinite));
  const numericArgument = (args, index = 0) => Number(Array.isArray(args) ? args[index] : NaN);
  const moveText = (x, y) => {
    if (![x, y].every(Number.isFinite)) return false;
    state.line_x += x;
    state.line_y += y;
    state.x = state.line_x;
    state.y = state.line_y;
    return true;
  };
  const fontObject = fontId => {
    if (fontObjects.has(fontId)) return fontObjects.get(fontId);
    let font;
    try {
      font = pdfjsPage.commonObjs.get(fontId);
    } catch {
      return null;
    }
    fontObjects.set(fontId, font);
    fonts.set(fontId, font?.isType3Font === true ? font : null);
    return font;
  };
  for (let index = 0; index < operators.fnArray.length; index += 1) {
    const operation = operators.fnArray[index];
    const args = operators.argsArray[index];
    if (operation === ops.save) stateStack.push(structuredClone(state));
    else if (operation === ops.restore) {
      if (stateStack.length === 0) return null;
      Object.assign(state, stateStack.pop());
    } else if (operation === ops.transform) {
      try {
        state.graphics_transform = multiplyTransforms(state.graphics_transform, finiteMatrix(args, "text graphics"));
      } catch {
        return null;
      }
    } else if (operation === ops.beginText) {
      state.text_matrix = null;
      state.x = state.line_x = 0;
      state.y = state.line_y = 0;
    } else if (operation === ops.setFont) {
      state.current_font = typeof args?.[0] === "string" ? args[0] : null;
      const size = numericArgument(args, 1);
      if (state.current_font === null || !Number.isFinite(size)) return null;
      state.font_size = Math.abs(size);
      state.font_direction = size < 0 ? -1 : 1;
    } else if (operation === ops.setTextMatrix) {
      try {
        state.text_matrix = finiteMatrix(args, "text");
      } catch {
        return null;
      }
      state.x = state.line_x = 0;
      state.y = state.line_y = 0;
    } else if (operation === ops.moveText) {
      if (!moveText(numericArgument(args), numericArgument(args, 1))) return null;
    } else if (operation === ops.setLeadingMoveText) {
      const x = numericArgument(args);
      const y = numericArgument(args, 1);
      state.leading = -y;
      if (!moveText(x, y)) return null;
    } else if (operation === ops.nextLine) {
      if (!moveText(0, state.leading)) return null;
    } else if (operation === ops.setLeading) {
      const leading = numericArgument(args);
      if (!Number.isFinite(leading)) return null;
      state.leading = -leading;
    } else if (operation === ops.setCharSpacing) {
      state.char_spacing = numericArgument(args);
      if (!Number.isFinite(state.char_spacing)) return null;
    } else if (operation === ops.setWordSpacing) {
      state.word_spacing = numericArgument(args);
      if (!Number.isFinite(state.word_spacing)) return null;
    } else if (operation === ops.setHScale) {
      state.text_h_scale = numericArgument(args) / 100;
      if (!Number.isFinite(state.text_h_scale)) return null;
    } else if (operation === ops.setTextRise) {
      state.text_rise = numericArgument(args);
      if (!Number.isFinite(state.text_rise)) return null;
    } else if (unsupportedTextOps.has(operation)) {
      return null;
    } else if (operation === ops.showText) {
      if (state.current_font === null || state.text_matrix === null || !Array.isArray(args?.[0])) return null;
      const font = fontObject(state.current_font);
      if (!font) return null;
      const fontMatrix = Array.isArray(font.fontMatrix) || ArrayBuffer.isView(font.fontMatrix)
        ? Array.from(font.fontMatrix, Number) : [0.001, 0, 0, 0.001, 0, 0];
      if (fontMatrix.length !== 6 || !fontMatrix.every(Number.isFinite)) return null;
      const textHScale = state.text_h_scale * state.font_direction;
      for (const glyph of args[0]) {
        if (typeof glyph === "number" && Number.isFinite(glyph)) {
          const spacingDirection = font.vertical ? 1 : -1;
          state.x += spacingDirection * glyph * state.font_size / 1000 * textHScale;
          continue;
        }
        if (!glyph || typeof glyph !== "object" || !Number.isFinite(glyph.width)) continue;
        const textOrigin = multiplyTransforms(
          state.graphics_transform,
          multiplyTransforms(state.text_matrix, [1, 0, 0, 1, state.x, state.y + state.text_rise]),
        );
        const origin = [textOrigin[4], textOrigin[5]];
        const glyphWidth = font.isType3Font
          ? (glyph.width * fontMatrix[0] + fontMatrix[4]) * state.font_size
          : glyph.width * state.font_size * fontMatrix[0];
        const spacing = (glyph.isSpace ? state.word_spacing : 0) + state.char_spacing;
        const glyphAdvanceVector = [
          textOrigin[0] * glyphWidth * textHScale,
          textOrigin[1] * glyphWidth * textHScale,
        ];
        const operatorAdvanceWidth = Math.hypot(...glyphAdvanceVector);
        const unicode = typeof glyph.unicode === "string" ? glyph.unicode : "";
        let offset = 0;
        for (const originalScalar of unicode) {
          const start = offset;
          offset += originalScalar.length;
          for (const scalar of originalScalar.normalize("NFKC")) {
            const token = {
              font_id: state.current_font,
              unicode: scalar,
              glyph,
              glyph_unicode_start: start,
              glyph_unicode_end: offset,
              all_token_index: allTokens.length,
              operator_origin: origin,
              operator_advance_width: operatorAdvanceWidth,
              operator_baseline: [textOrigin[0] * textHScale, textOrigin[1] * textHScale],
            };
            allTokens.push(token);
            if (!/^\s$/u.test(scalar)) tokens.push(token);
          }
        }
        state.x += (glyphWidth + spacing) * textHScale;
      }
    }
  }
  if (stateStack.length !== 0) return null;
  return { tokens, all_tokens: allTokens, fonts };
}

function textItemTokens(textContent) {
  const entries = (textContent?.items ?? [])
    .filter(item => typeof item?.str === "string")
    .map((item, sourceIndex) => [sourceIndex, item]);
  const tokens = [];
  for (const [sourceIndex, item] of entries) {
    let offset = 0;
    for (const originalScalar of item.str) {
      const start = offset;
      offset += originalScalar.length;
      for (const scalar of originalScalar.normalize("NFKC")) {
        if (/^\s$/u.test(scalar)) continue;
        tokens.push({
          font_id: item.fontName,
          unicode: scalar,
          source_index: sourceIndex,
          source_utf16_start: start,
          source_utf16_end: offset,
          direction: direction(item.dir),
        });
      }
    }
  }
  return { tokens, entries };
}

function baselineTextLineEvidence(textContent, pdfjsPage) {
  const viewport = pdfjsPage?.getViewport?.({ scale: 1 });
  const viewportTransform = safeTransform(viewport?.transform);
  if (!viewportTransform || !Number.isFinite(viewport?.width)) return null;
  const items = [];
  let hardSegment = 0;
  let invalidGeometry = false;
  for (let sourceIndex = 0; sourceIndex < (textContent?.items ?? []).length; sourceIndex += 1) {
    const item = textContent.items[sourceIndex];
    if (typeof item?.str !== "string") continue;
    const style = textContent?.styles?.[item.fontName] ?? {};
    const geometry = computeItemGeometry(
      viewportTransform,
      safeTransform(item.transform),
      finiteOrNull(item.width),
      finiteOrNull(item.height),
      style,
    );
    invalidGeometry ||= !geometry.valid;
    if (item.str.trim().length > 0) {
      const baselineItem = {
        id: `baseline-${sourceIndex}`,
        source_index: sourceIndex,
        is_whitespace: false,
        geometry_valid: geometry.valid,
        x: geometry.bbox?.x ?? null,
        y: geometry.bbox?.y ?? null,
        width: geometry.bbox?.width ?? null,
        height: geometry.bbox?.height ?? null,
        line_height: geometry.line_height,
        direction: direction(item.dir),
      };
      Object.defineProperty(baselineItem, "hard_segment", { value: hardSegment, enumerable: false });
      items.push(baselineItem);
    }
    if (item.hasEOL) hardSegment += 1;
  }
  const candidates = items.filter(item => item.geometry_valid);
  const grouped = groupLines(candidates, pdfjsPage?.pageNumber ?? 0);
  if (invalidGeometry) return null;
  const sourceById = new Map(items.map(item => [item.id, item.source_index]));
  const lineBySource = new Map();
  for (const line of grouped) {
    for (const itemId of line.item_ids) lineBySource.set(sourceById.get(itemId), line);
  }
  return { line_by_source: lineBySource };
}

function collapsedWhitespaceBinding(operatorTokens, token, textEntries, baselineEvidence) {
  const tokenIndex = token.all_token_index;
  if (!Number.isSafeInteger(tokenIndex) || operatorTokens[tokenIndex] !== token || !/^\s$/u.test(token.unicode)) return null;
  if ((tokenIndex > 0 && /^\s$/u.test(operatorTokens[tokenIndex - 1].unicode))
    || (tokenIndex + 1 < operatorTokens.length && /^\s$/u.test(operatorTokens[tokenIndex + 1].unicode))) return null;
  const previous = operatorTokens[tokenIndex - 1];
  const next = operatorTokens[tokenIndex + 1];
  if (!previous?.binding || !next?.binding) return null;
  if (next.binding.source_index !== previous.binding.source_index + 2) return null;
  const sourceIndex = previous.binding.source_index + 1;
  const item = textEntries[sourceIndex]?.[1];
  const nextItem = textEntries[next.binding.source_index]?.[1];
  if (!item || !["ltr", "unknown"].includes(direction(item.dir))) return null;
  if (item.str !== " ") return null;
  const previousSourceIndex = previous.binding.source_index;
  const nextSourceIndex = next.binding.source_index;
  const previousLine = baselineEvidence?.line_by_source.get(previousSourceIndex);
  const nextLine = baselineEvidence?.line_by_source.get(nextSourceIndex);
  if (!previousLine || previousLine !== nextLine) return null;
  const transform = safeTransform(item.transform);
  const nextTransform = safeTransform(nextItem?.transform);
  const operatorOrigin = token.operator_origin;
  const operatorBaseline = token.operator_baseline;
  if (!transform || !nextTransform
    || !Array.isArray(operatorOrigin) || operatorOrigin.length !== 2 || !operatorOrigin.every(Number.isFinite)
    || !Array.isArray(operatorBaseline) || operatorBaseline.length !== 2 || !operatorBaseline.every(Number.isFinite)) return null;
  const baselineMagnitude = Math.hypot(...operatorBaseline);
  if (!(baselineMagnitude > 0)) return null;
  const baselineUnit = operatorBaseline.map(value => value / baselineMagnitude);
  const fontSize = Math.hypot(transform[2], transform[3]);
  if (!(fontSize > 0)) return null;
  const toNext = [nextTransform[4] - operatorOrigin[0], nextTransform[5] - operatorOrigin[1]];
  const operatorAnchorSpanWidth = toNext[0] * baselineUnit[0] + toNext[1] * baselineUnit[1];
  const crossDistance = Math.abs(toNext[0] * -baselineUnit[1] + toNext[1] * baselineUnit[0]);
  const operatorAdvanceWidth = token.operator_advance_width;
  if (!Number.isFinite(operatorAdvanceWidth)
    || operatorAdvanceWidth <= 0
    || !Number.isFinite(operatorAnchorSpanWidth)
    || operatorAnchorSpanWidth + 0.01 < operatorAdvanceWidth
    || operatorAnchorSpanWidth > Math.max(24, fontSize * 2)
    || crossDistance > Math.max(2, fontSize * 0.5)) return null;
  const operatorRawTransform = [
    baselineUnit[0] * fontSize,
    baselineUnit[1] * fontSize,
    -baselineUnit[1] * fontSize,
    baselineUnit[0] * fontSize,
    operatorOrigin[0],
    operatorOrigin[1],
  ];
  return {
    font_id: item.fontName,
    unicode: item.str,
    source_index: sourceIndex,
    source_utf16_start: 0,
    source_utf16_end: item.str.length,
    direction: direction(item.dir),
    operator_advance_width: operatorAdvanceWidth,
    operator_anchor_span_width: operatorAnchorSpanWidth,
    operator_raw_transform: operatorRawTransform,
  };
}

function linkedRawType3Font(fontId, fontTokens, rawFonts) {
  const observed = new Map();
  const glyphIds = new Map();
  for (const token of fontTokens) {
    const glyph = token.glyph;
    if (!Number.isSafeInteger(glyph.originalCharCode) || !Number.isFinite(glyph.width)) return null;
    const priorWidth = observed.get(glyph.originalCharCode);
    if (priorWidth !== undefined && priorWidth !== glyph.width) return null;
    observed.set(glyph.originalCharCode, glyph.width);
    if (typeof glyph.operatorListId === "string") glyphIds.set(glyph.originalCharCode, glyph.operatorListId);
  }
  const candidates = rawFonts.filter(raw => [...observed].every(([code, width]) => raw.widths.get(code) === width)
    && [...glyphIds].every(([code, glyphId]) => raw.codeToGlyph.get(code)?.includes(glyphId) === true));
  if (candidates.length !== 1 || !candidates[0].recoverable) return null;
  return candidates[0];
}

/*
 * One glyph program is looked up once per registry entry that names it and
 * again for the enrolled-shape index, so the decode is memoized. PDF.js caches
 * Type-3 font objects per document, so the same font object comes back on
 * every page the font is used on.
 *
 * The cache is keyed on the font and then the glyph id, not on the CharProc
 * object alone, because the digest is a function of all three of the
 * arguments below and only the CharProc is an object identity. A font owns
 * exactly one FontMatrix and one CharProc for a given glyph id, so keying on
 * the pair covers both; keying on a CharProc that two fonts happened to share
 * would not, since the two fonts can declare different FontMatrix values and
 * the matrix decides whether the mask lane is admissible at all. `ops` is the
 * operator table of the single pinned PDF.js build loaded in this process and
 * is therefore constant for the cache's lifetime.
 */
const type3GlyphEvidenceCache = new WeakMap();

const type3FontPaintOrientationCache = new WeakMap();

/**
 * The single paint convention every mask-lane glyph of one embedded font
 * agrees on, as `1` or `-1`, or `null` when the font has none.
 *
 * The grid key deliberately discards orientation, which is right — the stored
 * samples are the glyph and the matrices around them are the producer. But it
 * leaves reflection unpoliced, and in Computer Modern reflection is not a
 * harmless re-orientation of the same character: mirroring the `]` raster
 * paints a `[`, and both are separately enrolled. So orientation has to be
 * checked somewhere, and the only place it can be checked honestly is between
 * glyphs of one font.
 *
 * The comparison is the sign of the CharProc-local determinant — FontMatrix
 * composed with the glyph's own `cm`. That sign is meaningless in absolute
 * terms, because producers split the flip differently: the Shannon reference
 * document carries it in `FontMatrix [1 0 0 -1]` and gives every glyph of
 * every one of its 24 Type-3 fonts sign -1, while other dvips-era producers
 * leave FontMatrix upright and come out uniformly +1. Keying on it, or
 * demanding a particular value of it, would make the same painted glyph key
 * two ways — the exact producer dependence the grid key exists to remove.
 * Comparing it *within* one font asks a different and answerable question: a
 * font sets all of its bitmaps the same way round, so a glyph whose sign
 * differs from its siblings is reflected relative to them, whatever absolute
 * convention the producer chose.
 *
 * Unanimity, not a majority, because a majority is a vote an adversary can
 * win by flipping more glyphs, and because most legacy fonts here carry one to
 * four mask glyphs, where a majority is not defined. A font that disagrees
 * with itself has no convention to normalize against and gets no grid keys at
 * all; every glyph falls to the operator digest and abstains.
 *
 * Measured, not assumed: all 24 embedded Type-3 fonts of the Shannon
 * reference document and all 92 of the five legacy TeX corpus documents are
 * unanimous, and none of the 116 is mixed. Mirroring one CMEX CharProc `cm`
 * makes exactly its own font mixed and nothing else.
 *
 * The scan covers every entry of `charProcOperatorList`, which PDF.js builds
 * eagerly from the whole /CharProcs dictionary when the font is loaded rather
 * than lazily per drawn glyph, so the answer is a property of the font and not
 * of which page happened to be extracted first.
 */
export function type3FontPaintOrientation(font, ops) {
  const cached = type3FontPaintOrientationCache.get(font);
  if (cached !== undefined) return cached;
  const charProcs = font?.charProcOperatorList;
  let orientation = null;
  if (charProcs && typeof charProcs === "object") {
    for (const glyphId of Object.keys(charProcs)) {
      const mask = type3GlyphImageMask(charProcs[glyphId], font?.fontMatrix, ops);
      if (mask === null) continue;
      if (orientation === null) orientation = mask.paint_orientation;
      else if (orientation !== mask.paint_orientation) {
        orientation = null;
        break;
      }
    }
  }
  type3FontPaintOrientationCache.set(font, orientation);
  return orientation;
}

function type3GlyphEvidenceForCode(font, rawFont, code, ops) {
  // A /Differences name has one reading unless pdf-lib left a lowercase hex
  // escape in it (see `type3GlyphNameCandidates`), in which case the second
  // reading is the escape resolved. Whichever one names a real CharProcs entry
  // is the glyph PDF.js drew; if both do, the font gives one name two meanings
  // and there is nothing honest to key on.
  const names = (rawFont.codeToGlyph.get(code) ?? [])
    .filter(name => typeof name === "string" && typeof font?.charProcOperatorList?.[name] === "object" && font.charProcOperatorList[name] !== null);
  if (names.length !== 1) return null;
  const glyphId = names[0];
  const charProc = font.charProcOperatorList[glyphId];
  if (!charProc || typeof charProc !== "object") return null;
  let byGlyphId = type3GlyphEvidenceCache.get(font);
  if (byGlyphId === undefined) {
    byGlyphId = new Map();
    type3GlyphEvidenceCache.set(font, byGlyphId);
  }
  const cached = byGlyphId.get(glyphId);
  if (cached !== undefined) return cached;
  const digest = type3GlyphEvidenceSha256(charProc, font?.fontMatrix, ops, type3FontPaintOrientation(font, ops));
  byGlyphId.set(glyphId, digest);
  return digest;
}

/**
 * Every officially enrolled code of `family` that this font actually draws,
 * mapped to its glyph evidence digest.
 */
function enrolledGlyphEvidence(font, rawFont, family, ops) {
  const byCode = new Map();
  for (const key of Object.keys(CM_CODEPOINTS[family] ?? {})) {
    const code = Number(key);
    const digest = type3GlyphEvidenceForCode(font, rawFont, code, ops);
    if (digest !== null) byCode.set(code, digest);
  }
  return byCode;
}

/**
 * Corroboration the shape key has to earn back.
 *
 * Keying on the decoded mask deliberately discards the placement matrix, and
 * placement is real evidence: a Computer Modern period and a Computer Modern
 * centred dot at the same design size are the *same* nine-by-nine blob, told
 * apart only by how high above the baseline the producer put it. Under the old
 * CharProc key that difference was inside the digest. It is no longer, so the
 * matcher requires instead that the shape identify the code on its own within
 * the font it came from: a digest that appears at two enrolled codes of the
 * same font is ambiguous evidence and recovers nothing.
 */
function evidenceIdentifiesCode(enrolled, code, digest) {
  if (digest === null || enrolled.get(code) !== digest) return false;
  let seen = 0;
  for (const candidate of enrolled.values()) {
    if (candidate === digest) seen += 1;
    if (seen > 1) return false;
  }
  return seen === 1;
}

/**
 * The second thing the matcher has to earn back, this time for Block A.
 *
 * Retaining zero-width slots is what lets a legacy font link at all, but it
 * also means a drawn glyph can now reach the registry with no advance width
 * behind it, and a zero advance is invisible to the TFM fingerprint that
 * qualifies the family. A recovered code must therefore carry a positive
 * declared width — which, being positive, is one of the widths
 * `uniqueComputerModernFamily` had to fit to the family's own metrics.
 */
function metricPinnedCode(rawFont, code) {
  return rawFont.metricWidths.has(code);
}

/**
 * True when the font carries a drawable raster for exactly the declared
 * officially enrolled codes of its family and for no other enrolled code. A
 * single-witness entry relies on this so that its reduced corroboration is
 * still the whole of the evidence its font can offer.
 */
function fontMatchesCompleteEnrollment(enrolled, family, declaredCodes) {
  const declared = new Set(declaredCodes);
  for (const key of Object.keys(CM_CODEPOINTS[family] ?? {})) {
    const code = Number(key);
    if (enrolled.has(code) !== declared.has(code)) return false;
  }
  return true;
}

/**
 * Registry entries whose whole evidence the font satisfies. A code matched by
 * more than one entry is reported as such and recovers nothing: two entries
 * disagreeing about one glyph is exactly the ambiguity this pipeline abstains
 * on, and it is newly reachable now that the key no longer separates entries
 * by their producer's placement.
 */
function matchingRegistryEntries(enrolled, rawFont, family) {
  const byCode = new Map();
  for (const code of enrolled.keys()) {
    for (const registry of TYPE3_RECOVERY_BY_FAMILY_CODE.get(`${family}:${code}`) ?? []) {
      if (!metricPinnedCode(rawFont, registry.original_char_code)) continue;
      if (!evidenceIdentifiesCode(enrolled, registry.original_char_code, registry.glyph_sha256)) continue;
      if (registry.witnesses.some(witness => !metricPinnedCode(rawFont, witness.original_char_code)
        || !evidenceIdentifiesCode(enrolled, witness.original_char_code, witness.glyph_sha256))) continue;
      if (registry.complete_font_enrollment
        && !fontMatchesCompleteEnrollment(enrolled, family, registry.complete_font_enrollment)) continue;
      if (!byCode.has(registry.original_char_code)) byCode.set(registry.original_char_code, []);
      byCode.get(registry.original_char_code).push(registry);
    }
  }
  return [...byCode.values()].filter(entries => entries.length === 1).map(entries => entries[0]);
}

function collectType3GlyphRecoveries({ textContent, operators, pdfjsPage, pdfLibPage, pdfjsLib }) {
  const operatorEvidence = operatorGlyphTokens(operators, pdfjsPage, pdfjsLib);
  if (!operatorEvidence) return new Map();
  const textEvidence = textItemTokens(textContent);
  const baselineEvidence = baselineTextLineEvidence(textContent, pdfjsPage);
  if (!baselineEvidence) return new Map();
  const textTokens = textEvidence.tokens;
  if (textTokens.length !== operatorEvidence.tokens.length) return new Map();
  for (let index = 0; index < textTokens.length; index += 1) {
    const source = textTokens[index];
    const operator = operatorEvidence.tokens[index];
    if (source.font_id !== operator.font_id || source.unicode !== operator.unicode) return new Map();
    operator.binding = source;
  }

  const rawFonts = rawType3Fonts(pdfLibPage);
  const byFont = new Map();
  for (const token of operatorEvidence.all_tokens) {
    if (!byFont.has(token.font_id)) byFont.set(token.font_id, []);
    byFont.get(token.font_id).push(token);
  }
  const recoveries = new Map();
  for (const [fontId, fontTokens] of byFont) {
    const font = operatorEvidence.fonts.get(fontId);
    if (!font) continue;
    const rawFont = linkedRawType3Font(fontId, fontTokens, rawFonts);
    if (!rawFont) continue;
    const family = uniqueComputerModernFamily(rawFont.metricWidths);
    if (!family || family.startsWith("unsupported:")) continue;
    const enrolled = enrolledGlyphEvidence(font, rawFont, family, pdfjsLib?.OPS ?? {});
    for (const registry of matchingRegistryEntries(enrolled, rawFont, family)) {
      const witnessDigests = registry.witnesses.map(witness => witness.glyph_sha256);
      for (const token of fontTokens) {
        const glyph = token.glyph;
        if (glyph.originalCharCode !== registry.original_char_code || glyph.unicode !== registry.source_unicode) continue;
        const collapsedBinding = registry.allow_collapsed_whitespace === true
          ? collapsedWhitespaceBinding(operatorEvidence.all_tokens, token, textEvidence.entries, baselineEvidence)
          : null;
        const binding = token.binding ?? collapsedBinding;
        if (!binding || !["ltr", "unknown"].includes(binding.direction)) continue;
        if (!recoveries.has(binding.source_index)) recoveries.set(binding.source_index, []);
        recoveries.get(binding.source_index).push({
          source_utf16_start: binding.source_utf16_start,
          source_utf16_end: binding.source_utf16_end,
          output_utf16_start: binding.source_utf16_start,
          output_utf16_end: binding.source_utf16_start + registry.target_unicode.length,
          original_char_code: registry.original_char_code,
          source_unicode: binding.unicode,
          operator_unicode: registry.source_unicode,
          target_unicode: registry.target_unicode,
          binding_kind: collapsedBinding ? "collapsed_whitespace_item" : "exact_text_scalar",
          operator_advance_width: collapsedBinding?.operator_advance_width ?? null,
          operator_anchor_span_width: collapsedBinding?.operator_anchor_span_width ?? null,
          operator_raw_transform: collapsedBinding?.operator_raw_transform ?? null,
          source_font_id: fontId,
          registry_id: registry.id,
          qualification: registry.qualification,
          glyph_sha256: registry.glyph_sha256,
          witness_glyph_sha256: witnessDigests,
          tfm_reference_version: CM_TFM_REFERENCE_VERSION,
          glyph_evidence_version: TYPE3_GLYPH_EVIDENCE_VERSION,
        });
      }
    }
  }
  for (const [sourceIndex, items] of recoveries) {
    const deduplicated = [...new Map(items.map(item => [`${item.source_utf16_start}:${item.registry_id}`, item])).values()]
      .sort((left, right) => left.source_utf16_start - right.source_utf16_start);
    recoveries.set(sourceIndex, deduplicated);
  }
  return recoveries;
}

/**
 * Read-only maintainer census for every understood legacy Type-3 showText
 * glyph. Unlike recovery's strict text-binding lane, this keeps control and
 * whitespace-like Unicode values so old encodings cannot disappear from the
 * report. Missing links/classification/digests remain explicit omissions.
 */
export function inspectType3GlyphEvidenceForPage({ textContent, operators, pdfjsPage, pdfLibPage, pdfjsLib }) {
  const ops = pdfjsLib?.OPS ?? {};
  const omissions = [];
  if (!operators || !Array.isArray(operators.fnArray) || !Array.isArray(operators.argsArray)) {
    return { occurrences: [], omissions: [{ reason: "operator_evidence_unavailable", count: 1 }] };
  }
  let currentFont = null;
  const fontStack = [];
  const byFont = new Map();
  const fonts = new Map();
  const unsupportedTextOps = new Set([
    ops.showSpacedText,
    ops.nextLineShowText,
    ops.nextLineSetSpacingShowText,
  ].filter(Number.isFinite));
  for (let operatorIndex = 0; operatorIndex < operators.fnArray.length; operatorIndex += 1) {
    const operation = operators.fnArray[operatorIndex];
    const args = operators.argsArray[operatorIndex];
    if (operation === ops.save) fontStack.push(currentFont);
    else if (operation === ops.restore) {
      if (fontStack.length === 0) omissions.push({ reason: "font_stack_restore_underflow", count: 1 });
      else currentFont = fontStack.pop();
    } else if (operation === ops.setFont) {
      currentFont = typeof args?.[0] === "string" ? args[0] : null;
    } else if (unsupportedTextOps.has(operation)) {
      omissions.push({ reason: "unsupported_text_operator", count: 1 });
    } else if (operation === ops.showText && currentFont !== null && Array.isArray(args?.[0])) {
      let font = fonts.get(currentFont);
      if (font === undefined) {
        try {
          font = pdfjsPage.commonObjs.get(currentFont);
        } catch {
          font = null;
          omissions.push({ font_id: currentFont, reason: "font_object_unavailable", scope: "potential_font_glyph", count: args[0].length });
        }
        if (font?.isType3Font !== true) font = null;
        fonts.set(currentFont, font);
      }
      if (!font) continue;
      if (!byFont.has(currentFont)) byFont.set(currentFont, []);
      for (let glyphIndex = 0; glyphIndex < args[0].length; glyphIndex += 1) {
        const glyph = args[0][glyphIndex];
        // PDF.js interleaves numeric text-position adjustments with glyphs.
        if (typeof glyph === "number" && Number.isFinite(glyph)) continue;
        if (!glyph || typeof glyph !== "object") {
          omissions.push({ font_id: currentFont, reason: "malformed_type3_glyph", scope: "type3_glyph", count: 1 });
          continue;
        }
        byFont.get(currentFont).push({ glyph, operator_index: operatorIndex, glyph_index: glyphIndex });
      }
    } else if (operation === ops.showText && currentFont === null) {
      omissions.push({ reason: "show_text_without_current_font", scope: "potential_font_glyph", count: Array.isArray(args?.[0]) ? args[0].length : 1 });
    } else if (operation === ops.showText) {
      omissions.push({ reason: "malformed_show_text_arguments", scope: "potential_font_glyph", count: 1 });
    }
  }
  if (fontStack.length !== 0) omissions.push({ reason: "font_stack_unbalanced_at_end", count: fontStack.length });

  const rawFonts = rawType3Fonts(pdfLibPage);
  const occurrences = [];
  for (const [fontId, fontTokens] of byFont) {
    const font = fonts.get(fontId);
    const rawFont = linkedRawType3Font(fontId, fontTokens, rawFonts);
    if (!rawFont) {
      omissions.push({ font_id: fontId, reason: "raw_type3_font_link_ambiguous_or_unavailable", scope: "type3_glyph", count: fontTokens.length });
      continue;
    }
    const family = uniqueComputerModernFamily(rawFont.metricWidths);
    const official = family ? CM_CODEPOINTS[family] : null;
    const witnessCodes = family ? CM_WITNESS_CODEPOINTS[family] : null;
    const mappedCodeGlyphSha256 = official ? Object.fromEntries([...new Set([
      ...Object.keys(official),
      ...Object.keys(witnessCodes ?? {}),
    ])]
      .map(Number)
      .sort((left, right) => left - right)
      .map(code => [code, type3GlyphEvidenceForCode(font, rawFont, code, ops)])) : {};
    const enrolled = family ? enrolledGlyphEvidence(font, rawFont, family, ops) : new Map();
    const matchedByCode = new Map();
    if (family) {
      for (const entry of matchingRegistryEntries(enrolled, rawFont, family)) {
        matchedByCode.set(entry.original_char_code, entry);
      }
    }
    for (const token of fontTokens) {
      const code = token.glyph.originalCharCode;
      if (!Number.isSafeInteger(code)) {
        omissions.push({ font_id: fontId, reason: "original_char_code_unavailable", scope: "type3_glyph", count: 1 });
        continue;
      }
      const digest = type3GlyphEvidenceForCode(font, rawFont, code, ops);
      if (!digest) omissions.push({ font_id: fontId, reason: "glyph_evidence_unavailable", scope: "glyph_evidence", count: 1 });
      const matched = matchedByCode.get(code) ?? null;
      const registryEvidenceMatchIds = matched
        && matched.source_unicode === token.glyph.unicode
        && matched.target_unicode === official?.[code]
        ? [matched.id]
        : [];
      occurrences.push({
        family,
        family_status: !family
          ? "ambiguous_or_unavailable"
          : official
            ? "identified_reviewed_mapping"
            : "identified_not_unicode_mapped",
        original_char_code: code,
        source_unicode: typeof token.glyph.unicode === "string" ? token.glyph.unicode : "",
        intended_unicode: official?.[code] ?? null,
        glyph_sha256: digest,
        mapped_code_glyph_sha256: mappedCodeGlyphSha256,
        registry_evidence_match_ids: registryEvidenceMatchIds,
        operator_index: token.operator_index,
        glyph_index: token.glyph_index,
        tfm_reference_version: CM_TFM_REFERENCE_VERSION,
        glyph_evidence_version: TYPE3_GLYPH_EVIDENCE_VERSION,
      });
    }
  }
  const strictRecoveries = textContent ? [...collectType3GlyphRecoveries({
    textContent,
    operators,
    pdfjsPage,
    pdfLibPage,
    pdfjsLib,
  }).entries()].flatMap(([sourceIndex, recoveries]) => recoveries.map(recovery => ({
    source_index: sourceIndex,
    ...recovery,
  }))) : [];
  if (!textContent) omissions.push({ reason: "strict_text_binding_unavailable", scope: "strict_recovery", count: 1 });
  return { occurrences, omissions, strict_recoveries: strictRecoveries };
}

function applyType3GlyphRecoveries(sourceText, recoveries) {
  if (!recoveries?.length) return sourceText;
  let cursor = 0;
  let result = "";
  for (const recovery of recoveries) {
    if (recovery.source_utf16_start < cursor
      || sourceText.slice(recovery.source_utf16_start, recovery.source_utf16_end) !== recovery.source_unicode) return sourceText;
    result += sourceText.slice(cursor, recovery.source_utf16_start);
    result += recovery.target_unicode;
    cursor = recovery.source_utf16_end;
  }
  return result + sourceText.slice(cursor);
}

function round(value) {
  return Number(Number(value).toFixed(3));
}

function normalizeText(value) {
  return String(value ?? "").replace(/\s+/g, " ").trim();
}

function box(value) {
  return {
    x: round(value.x),
    y: round(value.y),
    width: round(value.width),
    height: round(value.height),
  };
}

function normalizedRotation(value) {
  return ((Number(value) % 360) + 360) % 360;
}

function effectiveViewportScale(viewportTransform) {
  return Math.hypot(Number(viewportTransform[0]), Number(viewportTransform[1]));
}

function ascentRatio(style) {
  if (Number.isFinite(Number(style?.ascent)) && Number(style.ascent) !== 0) {
    return { ratio: Number(style.ascent), source: "style_ascent" };
  }
  if (Number.isFinite(Number(style?.descent)) && Number(style.descent) !== 0) {
    return { ratio: 1 + Number(style.descent), source: "style_descent_fallback" };
  }
  return { ratio: 0.8, source: "default_0_8" };
}

export function pageGeometry(pdfLibPage, pdfjsPage, viewport, pageNumber) {
  const mediaBox = pdfLibPage ? box(pdfLibPage.getMediaBox()) : null;
  const cropBox = pdfLibPage ? box(pdfLibPage.getCropBox()) : null;
  const rawPdfRotation = pdfLibPage ? normalizedRotation(pdfLibPage.getRotation().angle) : null;
  const displayRotation = pdfjsPage ? normalizedRotation(pdfjsPage.rotate) : null;
  return {
    page: pageNumber,
    media_box: mediaBox,
    crop_box: cropBox,
    pdfjs_view: pdfjsPage ? pdfjsPage.view.map(round) : null,
    user_unit: pdfjsPage ? round(pdfjsPage.userUnit || 1) : null,
    raw_pdf_rotation: rawPdfRotation,
    display_rotation: displayRotation,
    rotation_matches_raw: displayRotation === null || rawPdfRotation === null ? null : displayRotation === rawPdfRotation,
    display_width: viewport ? round(viewport.width) : null,
    display_height: viewport ? round(viewport.height) : null,
    viewport_transform: viewport ? viewport.transform.map(round) : null,
    raw_page_space: { ...RAW_PAGE_SPACE },
    item_space: { ...ITEM_SPACE },
  };
}

const MAX_LINK_ANNOTATIONS = 200;
const SUPPORTED_LINK_PROTOCOLS = new Set(["http:", "https:"]);

/**
 * Resolve a link annotation to a supported target.
 *
 * Trust boundary: the only target string ever resolved is PDF.js's sanitized
 * `url`. The raw `unsafeUrl` is used solely as a typeof presence signal when
 * classifying the target class, and its content is never read, parsed, or
 * emitted. The value returned is the normalized `parsed.href`, not the
 * original string.
 */
function supportedLinkUrl(annotation) {
  const url = typeof annotation?.url === "string" ? annotation.url : null;
  if (url === null || url.length === 0 || url.length > 2048) return null;
  if (/[\u0000-\u0020\u007f-\u009f]/u.test(url)) return null;
  let parsed = null;
  try {
    parsed = new URL(url);
  } catch {
    return null;
  }
  if (!SUPPORTED_LINK_PROTOCOLS.has(parsed.protocol)) return null;
  if (parsed.href.length > 2048) return null;
  if (/[\u0000-\u0020\u007f-\u009f]/u.test(parsed.href)) return null;
  return parsed.href;
}

/**
 * Which target classes the annotation declares. Presence only: `unsafeUrl` is
 * counted by type, never by content.
 */
function linkTargetClasses(annotation) {
  const classes = [];
  if (typeof annotation?.url === "string" || typeof annotation?.unsafeUrl === "string") {
    classes.push("url");
  }
  if (annotation?.dest !== undefined && annotation?.dest !== null) classes.push("destination");
  if (annotation?.action !== undefined && annotation?.action !== null) classes.push("action");
  return classes;
}

function linkTargetKind(annotation) {
  const classes = linkTargetClasses(annotation);
  // A safe url must not win over a co-declared destination or action. More
  // than one declared class is ambiguous and degrades to escaped text.
  if (classes.length === 0) return "none";
  if (classes.length > 1) return "ambiguous_target";
  if (classes[0] === "destination") return "internal_destination";
  if (classes[0] === "action") return "action";
  return supportedLinkUrl(annotation) !== null ? "http" : "unsupported_scheme";
}

function applyViewportPoint(transform, x, y) {
  return [
    transform[0] * x + transform[2] * y + transform[4],
    transform[1] * x + transform[3] * y + transform[5],
  ];
}

/**
 * Project an annotation rect from PDF user space into the same display
 * viewport the text items use, so rotation and CropBox origin are already
 * folded in by the viewport transform.
 */
function linkRectGeometry(viewportTransform, rect) {
  if (!Array.isArray(viewportTransform) || viewportTransform.length !== 6) return null;
  if (!viewportTransform.every(Number.isFinite)) return null;
  if (!Array.isArray(rect) || rect.length !== 4 || !rect.every(Number.isFinite)) return null;
  const [x1, y1, x2, y2] = rect;
  const corners = [[x1, y1], [x2, y1], [x2, y2], [x1, y2]]
    .map(([x, y]) => applyViewportPoint(viewportTransform, x, y));
  const xs = corners.map(corner => corner[0]);
  const ys = corners.map(corner => corner[1]);
  if (![...xs, ...ys].every(Number.isFinite)) return null;
  const x = Math.min(...xs);
  const y = Math.min(...ys);
  return {
    x: round(x),
    y: round(y),
    width: round(Math.max(...xs) - x),
    height: round(Math.max(...ys) - y),
  };
}

function collectLinkAnnotations(annotations, viewportTransform, pageNumber) {
  const items = [];
  let truncated = false;
  for (const annotation of Array.isArray(annotations) ? annotations : []) {
    if (annotation?.subtype !== "Link") continue;
    if (items.length >= MAX_LINK_ANNOTATIONS) {
      truncated = true;
      break;
    }
    const targetKind = linkTargetKind(annotation);
    items.push({
      id: `p${String(pageNumber).padStart(4, "0")}-link${String(items.length + 1).padStart(4, "0")}`,
      rect: linkRectGeometry(viewportTransform, annotation.rect),
      target_kind: targetKind,
      url: targetKind === "http" ? supportedLinkUrl(annotation) : null,
    });
  }
  return { status: "available", truncated, items };
}

const UNAVAILABLE_LINK_ANNOTATIONS = Object.freeze({
  status: "unavailable",
  truncated: false,
  items: [],
});

function multiplyTransforms(left, right) {
  return [
    left[0] * right[0] + left[2] * right[1],
    left[1] * right[0] + left[3] * right[1],
    left[0] * right[2] + left[2] * right[3],
    left[1] * right[2] + left[3] * right[3],
    left[0] * right[4] + left[2] * right[5] + left[4],
    left[1] * right[4] + left[3] * right[5] + left[5],
  ];
}

function computeItemGeometry(viewportTransform, rawTransform, rawWidth, rawHeight, style) {
  const rawValues = [...viewportTransform, ...rawTransform, rawWidth, rawHeight];
  if (!rawValues.every(value => typeof value === "number" && Number.isFinite(value))) {
    return {
      valid: false,
      quad: null,
      bbox: null,
      line_height: null,
      ascent_ratio: null,
      ascent_source: null,
      advance_source: style?.vertical === true ? "item_height" : "item_width",
    };
  }
  const transformed = multiplyTransforms(viewportTransform, rawTransform);
  if (!transformed.every(Number.isFinite)) {
    return {
      valid: false,
      quad: null,
      bbox: null,
      line_height: null,
      ascent_ratio: null,
      ascent_source: null,
      advance_source: style?.vertical === true ? "item_height" : "item_width",
    };
  }
  const baseline = { x: transformed[4], y: transformed[5] };
  const fontSize = Math.hypot(transformed[2], transformed[3]);
  const viewportScale = effectiveViewportScale(viewportTransform);
  const isVertical = style?.vertical === true;
  const rawAdvance = isVertical ? rawHeight : rawWidth;
  const advanceLength = Math.abs(rawAdvance) * viewportScale;
  let angle = Math.atan2(transformed[1], transformed[0]);
  if (isVertical) angle += Math.PI / 2;
  const advance = { x: Math.cos(angle) * advanceLength, y: Math.sin(angle) * advanceLength };
  const cross = { x: -Math.sin(angle) * fontSize, y: Math.cos(angle) * fontSize };
  const ascent = ascentRatio(style);
  const top = {
    x: baseline.x + fontSize * ascent.ratio * Math.sin(angle),
    y: baseline.y - fontSize * ascent.ratio * Math.cos(angle),
  };
  const points = [
    top,
    { x: top.x + advance.x, y: top.y + advance.y },
    { x: top.x + cross.x, y: top.y + cross.y },
    { x: top.x + advance.x + cross.x, y: top.y + advance.y + cross.y },
  ];
  const xs = points.map(point => point.x);
  const ys = points.map(point => point.y);
  return {
    valid: true,
    quad: points.map(point => ({ x: round(point.x), y: round(point.y) })),
    bbox: {
      x: round(Math.min(...xs)),
      y: round(Math.min(...ys)),
      width: round(Math.max(...xs) - Math.min(...xs)),
      height: round(Math.max(...ys) - Math.min(...ys)),
    },
    line_height: round(fontSize),
    ascent_ratio: round(ascent.ratio),
    ascent_source: ascent.source,
    advance_source: isVertical ? "item_height" : "item_width",
  };
}

function direction(value) {
  return ["ltr", "rtl", "ttb"].includes(value) ? value : "unknown";
}

function itemAdvanceGap(previous, item, lineDirection) {
  const previousStart = previous.quad?.[0];
  const previousEnd = previous.quad?.[1];
  const itemStart = item.quad?.[0];
  const itemEnd = item.quad?.[1];
  if ([previousStart, previousEnd, itemStart, itemEnd]
    .every(point => Number.isFinite(point?.x) && Number.isFinite(point?.y))) {
    const dx = previousEnd.x - previousStart.x;
    const dy = previousEnd.y - previousStart.y;
    const length = Math.hypot(dx, dy);
    const itemDx = itemEnd.x - itemStart.x;
    const itemDy = itemEnd.y - itemStart.y;
    const itemLength = Math.hypot(itemDx, itemDy);
    // The quad's anchor-to-terminal edge follows the text advance after
    // CropBox, UserUnit, and rotation. Bounding-box x gaps lose that direction
    // on a 180-degree page and concatenate distinct source runs. Project only
    // co-directed advances; keep the existing fallback for degenerate or
    // differently oriented runs and leave line grouping/source order unchanged.
    if (length > 0 && itemLength > 0
      && (dx * itemDx + dy * itemDy) / (length * itemLength) >= 0.999) {
      const from = lineDirection === "rtl" ? itemEnd : previousEnd;
      const to = lineDirection === "rtl" ? previousStart : itemStart;
      return ((to.x - from.x) * dx + (to.y - from.y) * dy) / length;
    }
  }
  return lineDirection === "rtl"
    ? previous.x - (item.x + item.width)
    : item.x - (previous.x + previous.width);
}

function lineText(items, lineDirection) {
  let text = "";
  let previous = null;
  for (const item of items) {
    if (previous) {
      const gap = itemAdvanceGap(previous, item, lineDirection);
      const operatorRecoveredBoundary = [previous, item].some(value => value.glyph_recoveries
        ?.some(recovery => recovery.binding_kind === "collapsed_whitespace_item"));
      const spaceThreshold = operatorRecoveredBoundary
        ? Math.max(0.5, Math.min(item.line_height ?? 8, previous.line_height ?? 8) * 0.08)
        : Math.max(1, Math.min(item.line_height ?? 8, previous.line_height ?? 8) * 0.2);
      if (gap > spaceThreshold && !text.endsWith(" ")) text += " ";
    }
    text += item.text;
    previous = item;
  }
  return normalizeText(text);
}

function combineBounds(items) {
  const right = Math.max(...items.map(item => item.x + item.width));
  const bottom = Math.max(...items.map(item => item.y + item.height));
  const x = Math.min(...items.map(item => item.x));
  const y = Math.min(...items.map(item => item.y));
  return { x: round(x), y: round(y), width: round(right - x), height: round(bottom - y) };
}

function materializeLine(lineItems, pageNumber, lineDirection) {
  const sourceFirstIndex = Math.min(...lineItems.map(item => item.source_index));
  return {
    id: `p${String(pageNumber).padStart(4, "0")}-l${String(sourceFirstIndex + 1).padStart(6, "0")}`,
    source_first_index: sourceFirstIndex,
    text: lineText(lineItems, lineDirection),
    ...combineBounds(lineItems),
    direction: lineDirection,
    item_ids: lineItems.map(item => item.id),
    reading_order_index: -1,
    column_index: 0,
  };
}

function medianNumber(values) {
  const sorted = [...values].sort((left, right) => left - right);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? (sorted[middle - 1] + sorted[middle]) / 2 : sorted[middle];
}

function itemBaselineCenter(item) {
  return item.y + item.height / 2;
}

function baselineInvariant(lineItems, toleranceFactor) {
  if (lineItems.length <= 1) return true;
  const centers = lineItems.map(itemBaselineCenter);
  const heights = lineItems.map(item => item.line_height).filter(Number.isFinite);
  const referenceHeight = heights.length > 0 ? medianNumber(heights) : 8;
  const centerMedian = medianNumber(centers);
  const tolerances = lineItems.map(item => Math.max(2, Math.min(referenceHeight, item.line_height ?? referenceHeight) * toleranceFactor));
  return lineItems.every((item, index) => Math.abs(centers[index] - centers[0]) <= tolerances[index]
    && Math.abs(centers[index] - centerMedian) <= tolerances[index])
    && Math.max(...centers) - Math.min(...centers) <= Math.min(...tolerances);
}

function groupLines(items, pageNumber) {
  const ordered = [...items].sort((left, right) => {
    const leftCenter = left.y + left.height / 2;
    const rightCenter = right.y + right.height / 2;
    return leftCenter - rightCenter || left.x - right.x || left.source_index - right.source_index;
  });
  const lines = [];
  for (const item of ordered) {
    const center = item.y + item.height / 2;
    let best = null;
    let bestDistance = Infinity;
    for (const line of lines) {
      if (line.direction !== item.direction || line.hard_segment !== item.hard_segment) continue;
      if (!baselineInvariant([...line.items, item], 0.35)) continue;
      const distance = Math.abs(center - medianNumber(line.items.map(itemBaselineCenter)));
      const lineLeft = Math.min(...line.items.map(value => value.x));
      const lineRight = Math.max(...line.items.map(value => value.x + value.width));
      const alongAxisGap = Math.max(0, lineLeft - (item.x + item.width), item.x - lineRight);
      const maxAlongAxisGap = Math.max(24, Math.min(line.median_font_size, item.line_height ?? line.median_font_size) * 4);
      if (alongAxisGap > maxAlongAxisGap) continue;
      if (distance < bestDistance) {
        best = line;
        bestDistance = distance;
      }
    }
    if (!best) {
      lines.push({ center, direction: item.direction, hard_segment: item.hard_segment, median_font_size: item.line_height ?? 8, items: [item] });
    } else {
      best.items.push(item);
      best.center = best.items.reduce((sum, value) => sum + value.y + value.height / 2, 0) / best.items.length;
      const sizes = best.items.map(value => value.line_height).filter(Number.isFinite).sort((a, b) => a - b);
      if (sizes.length > 0) best.median_font_size = sizes[Math.floor(sizes.length / 2)];
    }
  }
  return lines.map(line => {
    const lineItems = [...line.items].sort((left, right) => {
      if (line.direction === "rtl") return right.x - left.x || left.source_index - right.source_index;
      return left.x - right.x || left.source_index - right.source_index;
    });
    return materializeLine(lineItems, pageNumber, line.direction);
  });
}

function sourceOrderLines(items, pageNumber) {
  const segments = [];
  let current = null;
  for (const item of [...items].sort((left, right) => left.source_index - right.source_index)) {
    if (!item.geometry_valid || item.is_whitespace) continue;
    if (!current
      || current.hard_segment !== item.hard_segment
      || current.direction !== item.direction
      || !baselineInvariant([...current.items, item], 0.5)) {
      current = { hard_segment: item.hard_segment, direction: item.direction, items: [] };
      segments.push(current);
    }
    current.items.push(item);
  }
  return segments.map(segment => materializeLine(segment.items, pageNumber, segment.direction));
}

function buildBlocks(lines, pageNumber, columnCount) {
  const blocks = [];
  for (const line of lines) {
    const previous = blocks.at(-1);
    if (!previous || previous.column_index !== line.column_index) {
      blocks.push({
        id: `p${String(pageNumber).padStart(4, "0")}-b${String(blocks.length + 1).padStart(4, "0")}`,
        kind: line.column_index === -1 ? "spanning_flow" : columnCount > 1 ? "column_flow" : "page_flow",
        column_index: line.column_index,
        line_ids: [],
      });
    }
    blocks.at(-1).line_ids.push(line.id);
  }
  return blocks;
}

function readingOrder(lines, displayWidth, { sourceLines, forceSourceOrder = false, fallbackReason = null } = {}) {
  const sourceOrder = [...sourceLines].sort((left, right) => left.source_first_index - right.source_first_index);
  if (forceSourceOrder) {
    return {
      lines: sourceOrder,
      strategy: "source_order_fallback",
      confidence: "not_calibrated",
      column_count: 1,
      limitations: [
        fallbackReason || "Geometry was ambiguous, so source item order was retained.",
        "Source order is parser order and is not proof of intended or visible reading order.",
      ],
    };
  }
  const defaultResult = {
    lines: sourceOrder,
    strategy: "source_order_fallback",
    confidence: "not_calibrated",
    column_count: 1,
    limitations: [
      "Column evidence was insufficient or ambiguous, so source item order was retained.",
      "Source order is parser order and is not proof of intended or visible reading order.",
    ],
  };
  if (lines.length < 4) return defaultResult;

  const byX = [...lines].sort((left, right) => left.x - right.x || left.y - right.y);
  let largestGap = { size: 0, index: -1 };
  for (let index = 1; index < byX.length; index += 1) {
    const gap = byX[index].x - byX[index - 1].x;
    if (gap > largestGap.size) largestGap = { size: gap, index };
  }
  if (largestGap.index < 2 || byX.length - largestGap.index < 2 || largestGap.size < displayWidth * 0.15) {
    return defaultResult;
  }
  const threshold = (byX[largestGap.index - 1].x + byX[largestGap.index].x) / 2;
  const spanning = lines.filter(line => line.x < threshold && line.x + line.width > threshold);
  const left = lines.filter(line => line.x <= threshold && !spanning.includes(line));
  const right = lines.filter(line => line.x > threshold);
  if (left.length < 2 || right.length < 2) return defaultResult;
  const gutterLeft = Math.max(...left.map(line => line.x + line.width));
  const gutterRight = Math.min(...right.map(line => line.x));
  if (gutterRight - gutterLeft < Math.max(12, displayWidth * 0.05)) return defaultResult;
  const span = values => ({
    top: Math.min(...values.map(line => line.y)),
    bottom: Math.max(...values.map(line => line.y + line.height)),
  });
  const leftSpan = span(left);
  const rightSpan = span(right);
  const overlap = Math.max(0, Math.min(leftSpan.bottom, rightSpan.bottom) - Math.max(leftSpan.top, rightSpan.top));
  const minimumSpan = Math.min(leftSpan.bottom - leftSpan.top, rightSpan.bottom - rightSpan.top);
  if (minimumSpan <= 0 || overlap / minimumSpan < 0.5) return defaultResult;
  const hasSegmentedBaseline = values => values.some((line, index) => values.slice(index + 1).some(other => {
    const centerDistance = Math.abs((line.y + line.height / 2) - (other.y + other.height / 2));
    const tolerance = Math.max(2, Math.min(line.height, other.height) * 0.35);
    const horizontallySeparate = line.x + line.width <= other.x || other.x + other.width <= line.x;
    return horizontallySeparate && centerDistance <= tolerance;
  }));
  if (hasSegmentedBaseline(left) || hasSegmentedBaseline(right)) {
    return {
      ...defaultResult,
      limitations: [
        "A candidate column contained multiple non-overlapping lines on the same baseline, so table-like or segmented content retained source order.",
        "Source order is parser order and is not proof of intended or visible reading order.",
      ],
    };
  }
  const columnTop = Math.min(leftSpan.top, rightSpan.top);
  const columnBottom = Math.max(leftSpan.bottom, rightSpan.bottom);
  const spanningAbove = spanning.filter(line => line.y + line.height <= columnTop);
  const spanningBelow = spanning.filter(line => line.y >= columnBottom);
  if (spanningAbove.length + spanningBelow.length !== spanning.length) return defaultResult;

  for (const line of left) line.column_index = 0;
  for (const line of right) line.column_index = 1;
  for (const line of spanning) line.column_index = -1;
  const stableGeometryOrder = values => values.sort((a, b) => a.y - b.y || a.x - b.x || a.source_first_index - b.source_first_index);
  return {
    lines: [
      ...stableGeometryOrder(spanningAbove),
      ...stableGeometryOrder(left),
      ...stableGeometryOrder(right),
      ...stableGeometryOrder(spanningBelow),
    ],
    strategy: "two_column_left_to_right",
    confidence: "not_calibrated",
    column_count: 2,
    limitations: [
      "Two-column order requires persistent non-overlapping line boxes and a real gutter; confidence is not calibrated.",
      "Spanning headings or footers are retained only when they are geometrically outside both column spans.",
      "Tables, floating objects, and footnotes are not inferred.",
    ],
  };
}

function imageOperationSet(pdfjsLib) {
  return new Set([
    pdfjsLib.OPS?.paintImageXObject,
    pdfjsLib.OPS?.paintJpegXObject,
    pdfjsLib.OPS?.paintImageMaskXObject,
    pdfjsLib.OPS?.paintImageMaskXObjectGroup,
    pdfjsLib.OPS?.paintInlineImageXObject,
    pdfjsLib.OPS?.paintInlineImageXObjectGroup,
    pdfjsLib.OPS?.paintImageXObjectRepeat,
    pdfjsLib.OPS?.paintImageMaskXObjectRepeat,
  ].filter(Number.isInteger));
}

function vectorOperationSet(pdfjsLib) {
  return new Set([
    pdfjsLib.OPS?.stroke,
    pdfjsLib.OPS?.closeStroke,
    pdfjsLib.OPS?.fill,
    pdfjsLib.OPS?.eoFill,
    pdfjsLib.OPS?.fillStroke,
    pdfjsLib.OPS?.eoFillStroke,
    pdfjsLib.OPS?.closeFillStroke,
    pdfjsLib.OPS?.closeEOFillStroke,
    pdfjsLib.OPS?.shadingFill,
    pdfjsLib.OPS?.constructPath,
    pdfjsLib.OPS?.rawFillPath,
  ].filter(Number.isInteger));
}

const RECT_FILL_OP_NAMES = [
  "fill",
  "eoFill",
  "fillStroke",
  "eoFillStroke",
  "closeFillStroke",
  "closeEOFillStroke",
];
const RECT_STROKE_OP_NAMES = ["stroke", "closeStroke"];

function identityTransform() {
  return [1, 0, 0, 1, 0, 0];
}

function operatorArgument(argsArray, index) {
  return Array.isArray(argsArray) ? argsArray[index] : undefined;
}

function operatorMatrix(value) {
  if ((Array.isArray(value) || ArrayBuffer.isView(value))
    && value.length === 1
    && (Array.isArray(value[0]) || ArrayBuffer.isView(value[0]))) return value[0];
  return value;
}

function finiteMatrix(value, label) {
  const matrix = operatorMatrix(value);
  if (!matrix || matrix.length !== 6 || !Array.from(matrix).every(Number.isFinite)) {
    throw new Error(`Invalid ${label} matrix in operator list.`);
  }
  return Array.from(matrix, Number);
}

function pathBufferFromArguments(argumentsForOperation) {
  if (!Array.isArray(argumentsForOperation)) return null;
  const pathData = argumentsForOperation[1];
  if (!Array.isArray(pathData) && !ArrayBuffer.isView(pathData)) {
    throw new Error("Invalid constructPath data in operator list.");
  }
  const buffer = pathData[0];
  if (buffer === null || buffer === undefined) return null;
  if (!Array.isArray(buffer) && !ArrayBuffer.isView(buffer)) {
    throw new Error("Invalid constructPath DrawOPS buffer in operator list.");
  }
  return buffer;
}

function decodeDrawOps(buffer) {
  if (buffer === null) return [];
  const commands = [];
  let index = 0;
  while (index < buffer.length) {
    const opcode = Number(buffer[index++]);
    if (![DRAW_OPS.moveTo, DRAW_OPS.lineTo, DRAW_OPS.curveTo, DRAW_OPS.quadraticCurveTo, DRAW_OPS.closePath].includes(opcode)) {
      throw new Error(`Unknown DrawOPS opcode ${opcode}.`);
    }
    const coordinateCount = opcode === DRAW_OPS.curveTo ? 6
      : opcode === DRAW_OPS.quadraticCurveTo ? 4
        : opcode === DRAW_OPS.moveTo || opcode === DRAW_OPS.lineTo ? 2 : 0;
    if (index + coordinateCount > buffer.length) throw new Error("Truncated constructPath DrawOPS buffer.");
    const coordinates = Array.from(buffer.slice(index, index + coordinateCount), Number);
    if (!coordinates.every(Number.isFinite)) throw new Error("Non-finite constructPath coordinate.");
    index += coordinateCount;
    commands.push({ opcode, coordinates });
  }
  return commands;
}

function rectangleSubpaths(commands) {
  const rectangles = [];
  let current = null;
  const finish = () => {
    if (!current || !current.closed || current.hasCurve || ![3, 4].includes(current.lines.length)) return;
    const segments = current.lines.map(segment => [...segment]);
    const last = segments.at(-1);
    const closeSegment = [last[1], current.start];
    if (segments.length === 3) segments.push(closeSegment);
    else if (Math.hypot(last[1][0] - current.start[0], last[1][1] - current.start[1]) > RULED_RECT_AXIS_TOLERANCE) return;
    rectangles.push(segments);
  };
  for (const command of commands) {
    if (command.opcode === DRAW_OPS.moveTo) {
      finish();
      const point = [command.coordinates[0], command.coordinates[1]];
      current = { start: point, point, lines: [], hasCurve: false, closed: false };
    } else if (command.opcode === DRAW_OPS.lineTo) {
      if (!current) continue;
      const next = [command.coordinates[0], command.coordinates[1]];
      current.lines.push([current.point, next]);
      current.point = next;
    } else if (command.opcode === DRAW_OPS.curveTo || command.opcode === DRAW_OPS.quadraticCurveTo) {
      if (current) {
        current.hasCurve = true;
        current.point = command.opcode === DRAW_OPS.curveTo
          ? [command.coordinates[4], command.coordinates[5]]
          : [command.coordinates[2], command.coordinates[3]];
      }
    } else if (command.opcode === DRAW_OPS.closePath) {
      if (current) {
        current.closed = true;
        finish();
        current = null;
      }
    }
  }
  finish();
  return rectangles;
}

function transformedRectangle(segments, transform) {
  const transformedSegments = segments.map(([start, end]) => [
    applyViewportPoint(transform, start[0], start[1]),
    applyViewportPoint(transform, end[0], end[1]),
  ]);
  const points = transformedSegments.flat();
  if (!points.every(point => point.every(Number.isFinite))) return null;
  const axisAligned = transformedSegments.every(([start, end]) => {
    const dx = Math.abs(end[0] - start[0]);
    const dy = Math.abs(end[1] - start[1]);
    return (dy <= RULED_RECT_AXIS_TOLERANCE && dx > RULED_RECT_AXIS_TOLERANCE)
      || (dx <= RULED_RECT_AXIS_TOLERANCE && dy > RULED_RECT_AXIS_TOLERANCE);
  });
  if (!axisAligned) return null;
  const xs = points.map(point => point[0]);
  const ys = points.map(point => point[1]);
  const x = Math.min(...xs);
  const y = Math.min(...ys);
  const width = Math.max(...xs) - x;
  const height = Math.max(...ys) - y;
  if (width < RULED_RECT_MIN_SIZE || height < RULED_RECT_MIN_SIZE) return null;
  const uniqueCorners = [];
  for (const point of points) {
    if (!uniqueCorners.some(existing => Math.hypot(existing[0] - point[0], existing[1] - point[1]) <= RULED_RECT_AXIS_TOLERANCE)) {
      uniqueCorners.push(point);
    }
  }
  if (uniqueCorners.length !== 4) return null;
  return { x: round(x), y: round(y), width: round(width), height: round(height) };
}

function rectPaintVerb(pdfjsLib, paintOp, pendingClip) {
  if (pendingClip && paintOp === pdfjsLib.OPS?.endPath) return "clip";
  if (RECT_FILL_OP_NAMES.some(name => paintOp === pdfjsLib.OPS?.[name])) return "fill";
  if (RECT_STROKE_OP_NAMES.some(name => paintOp === pdfjsLib.OPS?.[name])) return "stroke";
  if (paintOp === pdfjsLib.OPS?.endPath) return "none";
  return null;
}

function pathIncludesStroke(pdfjsLib, paintOp) {
  return [
    "stroke",
    "closeStroke",
    "fillStroke",
    "eoFillStroke",
    "closeFillStroke",
    "closeEOFillStroke",
  ].some(name => paintOp === pdfjsLib.OPS?.[name]);
}

function straightPathSegments(commands) {
  const segments = [];
  let start = null;
  let point = null;
  for (const command of commands) {
    if (command.opcode === DRAW_OPS.moveTo) {
      start = [command.coordinates[0], command.coordinates[1]];
      point = start;
    } else if (command.opcode === DRAW_OPS.lineTo) {
      const next = [command.coordinates[0], command.coordinates[1]];
      if (point) segments.push([point, next]);
      point = next;
    } else if (command.opcode === DRAW_OPS.curveTo) {
      point = [command.coordinates[4], command.coordinates[5]];
    } else if (command.opcode === DRAW_OPS.quadraticCurveTo) {
      point = [command.coordinates[2], command.coordinates[3]];
    } else if (command.opcode === DRAW_OPS.closePath) {
      if (point && start) segments.push([point, start]);
      point = start;
    }
  }
  return segments;
}

function transformedRulingSegment(segment, transform, operatorIndex) {
  const first = applyViewportPoint(transform, segment[0][0], segment[0][1]);
  const second = applyViewportPoint(transform, segment[1][0], segment[1][1]);
  if (![...first, ...second].every(Number.isFinite)) return null;
  const dx = Math.abs(second[0] - first[0]);
  const dy = Math.abs(second[1] - first[1]);
  let orientation;
  if (dy <= RULED_RECT_AXIS_TOLERANCE && dx >= RULING_SEGMENT_MIN_LENGTH) orientation = "horizontal";
  else if (dx <= RULED_RECT_AXIS_TOLERANCE && dy >= RULING_SEGMENT_MIN_LENGTH) orientation = "vertical";
  else return null;
  if (orientation === "horizontal") {
    const ordered = [...[first, second]].sort((left, right) => left[0] - right[0] || left[1] - right[1]);
    const x1 = round(ordered[0][0]);
    const x2 = round(ordered[1][0]);
    if (x2 - x1 < RULING_SEGMENT_MIN_LENGTH) return null;
    const y = round((ordered[0][1] + ordered[1][1]) / 2);
    return {
      orientation,
      x1,
      y1: y,
      x2,
      y2: y,
      source_operator_index: operatorIndex,
    };
  }
  const ordered = [...[first, second]].sort((left, right) => left[1] - right[1] || left[0] - right[0]);
  const y1 = round(ordered[0][1]);
  const y2 = round(ordered[1][1]);
  if (y2 - y1 < RULING_SEGMENT_MIN_LENGTH) return null;
  const x = round((ordered[0][0] + ordered[1][0]) / 2);
  return {
    orientation,
    x1: x,
    y1,
    x2: x,
    y2,
    source_operator_index: operatorIndex,
  };
}

function deduplicateRulingSegments(candidates) {
  const ordered = [...candidates].sort((left, right) => (
    left.source_operator_index - right.source_operator_index
      || left.orientation.localeCompare(right.orientation)
      || left.y1 - right.y1
      || left.x1 - right.x1
      || left.y2 - right.y2
      || left.x2 - right.x2
  ));
  const buckets = new Map();
  const unique = [];
  for (const candidate of ordered) {
    const fields = candidate.orientation === "horizontal"
      ? ["y1", "x1", "x2"] : ["x1", "y1", "y2"];
    const grid = fields.map(field => Math.round(candidate[field] / RULED_RECT_AXIS_TOLERANCE));
    let duplicate = false;
    for (let first = -1; first <= 1 && !duplicate; first += 1) {
      for (let second = -1; second <= 1 && !duplicate; second += 1) {
        for (let third = -1; third <= 1 && !duplicate; third += 1) {
          const key = `${candidate.orientation}:${grid[0] + first}:${grid[1] + second}:${grid[2] + third}`;
          duplicate = (buckets.get(key) ?? []).some(existing => (
            ["x1", "y1", "x2", "y2"].every(field => (
              Math.abs(existing[field] - candidate[field]) <= RULED_RECT_AXIS_TOLERANCE
            ))
          ));
        }
      }
    }
    if (duplicate) continue;
    const key = `${candidate.orientation}:${grid[0]}:${grid[1]}:${grid[2]}`;
    const bucket = buckets.get(key) ?? [];
    bucket.push(candidate);
    buckets.set(key, bucket);
    unique.push(candidate);
  }
  return unique;
}

function rectGridKey(rect) {
  return [rect.x, rect.y, rect.width, rect.height].map(value => Math.round(value / RULED_RECT_AXIS_TOLERANCE));
}

function deduplicateRectangles(candidates) {
  const sorted = [...candidates].sort((left, right) => {
    const leftKey = rectGridKey(left);
    const rightKey = rectGridKey(right);
    for (let index = 0; index < leftKey.length; index += 1) {
      if (leftKey[index] !== rightKey[index]) return leftKey[index] - rightKey[index];
    }
    return left.operator_index - right.operator_index;
  });
  const buckets = new Map();
  const unique = [];
  for (const candidate of sorted) {
    const [x, y, width, height] = rectGridKey(candidate);
    let duplicate = false;
    for (let dx = -1; dx <= 1 && !duplicate; dx += 1) {
      for (let dy = -1; dy <= 1 && !duplicate; dy += 1) {
        for (let dw = -1; dw <= 1 && !duplicate; dw += 1) {
          for (let dh = -1; dh <= 1 && !duplicate; dh += 1) {
            const bucket = buckets.get(`${x + dx}:${y + dy}:${width + dw}:${height + dh}`) ?? [];
            duplicate = bucket.some(existing => existing.verb === candidate.verb
              && ["x", "y", "width", "height"].every(
                field => Math.abs(existing[field] - candidate[field]) <= RULED_RECT_AXIS_TOLERANCE,
              ));
          }
        }
      }
    }
    if (duplicate) continue;
    const key = `${x}:${y}:${width}:${height}`;
    const bucket = buckets.get(key) ?? [];
    bucket.push(candidate);
    buckets.set(key, bucket);
    unique.push(candidate);
  }
  return unique.sort((left, right) => left.operator_index - right.operator_index);
}

// Ported from firecrawl/pdf-inspector (MIT): src/tables/detect_rects.rs.
function deriveOperatorEvidence(pdfjsLib, operators, viewportTransform) {
  const fnArray = operators?.fnArray;
  if (!Array.isArray(fnArray)) throw new Error("Operator list fnArray is unavailable.");
  const argsArray = Array.isArray(operators?.argsArray) ? operators.argsArray : [];
  const imageOps = imageOperationSet(pdfjsLib);
  const constructPathOp = pdfjsLib.OPS?.constructPath;
  const matrixStack = [];
  const scopeBases = [0];
  let currentTransform = identityTransform();
  let pendingClip = false;
  let imagePaintOps = 0;
  let pathConstructOps = 0;
  let pathSegments = 0;
  const candidates = [];
  const rulingCandidates = [];
  const displayTransform = Array.isArray(viewportTransform) && viewportTransform.length === 6
    ? viewportTransform : identityTransform();

  for (let operatorIndex = 0; operatorIndex < fnArray.length; operatorIndex += 1) {
    const operation = fnArray[operatorIndex];
    const args = operatorArgument(argsArray, operatorIndex);
    if (imageOps.has(operation)) imagePaintOps += 1;
    if (operation === pdfjsLib.OPS?.save) {
      matrixStack.push({ kind: "save", transform: currentTransform });
    } else if (operation === pdfjsLib.OPS?.restore) {
      const scopeBase = scopeBases.at(-1);
      if (matrixStack.length > scopeBase) currentTransform = matrixStack.pop().transform;
    } else if (operation === pdfjsLib.OPS?.transform) {
      currentTransform = multiplyTransforms(currentTransform, finiteMatrix(args, "transform"));
    } else if (operation === pdfjsLib.OPS?.paintFormXObjectBegin) {
      matrixStack.push({ kind: "form", transform: currentTransform });
      scopeBases.push(matrixStack.length);
      const formArgs = Array.isArray(args) ? args : [];
      // pdfjs passes [null, bbox] for a Form XObject without /Matrix; null
      // means identity, not an invalid operator list.
      if (formArgs[0] !== null && formArgs[0] !== undefined) {
        currentTransform = multiplyTransforms(currentTransform, finiteMatrix(formArgs[0], "Form XObject"));
      }
    } else if (operation === pdfjsLib.OPS?.paintFormXObjectEnd) {
      const scopeBase = scopeBases.length > 1 ? scopeBases.pop() : null;
      if (scopeBase !== null) {
        while (matrixStack.length > scopeBase) matrixStack.pop();
        const formFrame = matrixStack.pop();
        if (formFrame?.kind === "form") currentTransform = formFrame.transform;
      }
    } else if (operation === pdfjsLib.OPS?.clip || operation === pdfjsLib.OPS?.eoClip) {
      pendingClip = true;
    } else if (operation === constructPathOp) {
      pathConstructOps += 1;
      const argumentsForPath = Array.isArray(args) ? args : null;
      const buffer = pathBufferFromArguments(argumentsForPath);
      const commands = decodeDrawOps(buffer);
      pathSegments += commands.length;
      const paintOp = argumentsForPath?.[0];
      const verb = rectPaintVerb(pdfjsLib, paintOp, pendingClip);
      const combinedTransform = multiplyTransforms(displayTransform, currentTransform);
      if (buffer !== null && pathIncludesStroke(pdfjsLib, paintOp)) {
        for (const segment of straightPathSegments(commands)) {
          const ruling = transformedRulingSegment(segment, combinedTransform, operatorIndex);
          if (ruling) rulingCandidates.push(ruling);
        }
      }
      if (verb !== null && buffer !== null) {
        for (const segments of rectangleSubpaths(commands)) {
          const rect = transformedRectangle(segments, combinedTransform);
          if (rect) candidates.push({ ...rect, verb, operator_index: operatorIndex });
        }
      }
      pendingClip = false;
    }
  }

  const unique = deduplicateRectangles(candidates);
  const returned = unique.slice(0, RULED_RECT_PAGE_LIMIT).map(({ operator_index: _operatorIndex, ...rect }) => rect);
  const truncated = unique.length > returned.length;
  const uniqueRulingSegments = deduplicateRulingSegments(rulingCandidates);
  const returnedRulingSegments = uniqueRulingSegments.slice(0, RULING_SEGMENT_PAGE_LIMIT);
  return {
    ruled_rects: {
      status: truncated ? "truncated" : "available",
      observed_count: unique.length,
      returned_count: returned.length,
      items: returned,
    },
    ruling_segments: {
      status: "available",
      truncated: uniqueRulingSegments.length > returnedRulingSegments.length,
      observed_count: uniqueRulingSegments.length,
      returned_count: returnedRulingSegments.length,
      items: returnedRulingSegments,
    },
    operator_counts: {
      image_paint_ops: imagePaintOps,
      path_segments: pathSegments,
      path_construct_ops: pathConstructOps,
    },
  };
}

// Ported from firecrawl/pdf-inspector (MIT): src/text_quality.rs.
function codePointIsPrivateUse(codePoint) {
  return (codePoint >= 0xe000 && codePoint <= 0xf8ff)
    || (codePoint >= 0xf0000 && codePoint <= 0xffffd)
    || (codePoint >= 0x100000 && codePoint <= 0x10fffd);
}

// Ported from firecrawl/pdf-inspector (MIT): src/text_quality.rs.
function itemTextIntegrity(text) {
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
    const tokenText = token[0];
    const tokenCodePoints = [...tokenText];
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
    privateUseSignal,
    c1ControlTokens,
  };
}

function nonAlphanumericDominance(text) {
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

function deriveTextIntegrity(textItemEntries, unavailable = false) {
  if (unavailable) return { status: "unavailable", signals: [] };
  const pageText = textItemEntries.map(([, item]) => item.str).join("\n");
  const itemSignals = textItemEntries.map(([, item]) => itemTextIntegrity(item.str));
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
  if (nonAlphanumericDominance(pageText)) signals.push({ kind: "non_alphanumeric_dominance", count: 1 });
  return {
    status: replacementSuspect || privateUseRuns > 0 || c1ControlTokens > 0 || signals.some(signal => signal.kind === "non_alphanumeric_dominance")
      ? "suspect" : "ok",
    signals,
  };
}

function unavailablePaintedRectangles() {
  return {
    status: "unavailable",
    truncated: false,
    observed_count: 0,
    returned_count: 0,
    items: [],
  };
}

function unavailableRulingSegments({ truncated = false, observedCount = 0 } = {}) {
  return {
    status: "unavailable",
    truncated,
    observed_count: observedCount,
    returned_count: 0,
    items: [],
  };
}

function unitRectangleGeometry(viewportTransform, graphicsTransform) {
  if (![...viewportTransform, ...graphicsTransform].every(Number.isFinite)) return null;
  const transformed = multiplyTransforms(viewportTransform, graphicsTransform);
  if (!transformed.every(Number.isFinite)) return null;
  const axisAligned = (Math.abs(transformed[1]) <= 0.002 && Math.abs(transformed[2]) <= 0.002)
    || (Math.abs(transformed[0]) <= 0.002 && Math.abs(transformed[3]) <= 0.002);
  if (!axisAligned) return null;
  const points = [[0, 0], [1, 0], [1, 1], [0, 1]].map(([x, y]) => ({
    x: round(transformed[0] * x + transformed[2] * y + transformed[4]),
    y: round(transformed[1] * x + transformed[3] * y + transformed[5]),
  }));
  const xs = points.map(point => point.x);
  const ys = points.map(point => point.y);
  const x = Math.min(...xs);
  const y = Math.min(...ys);
  const width = round(Math.max(...xs) - x);
  const height = round(Math.max(...ys) - y);
  if (!(width > 0 && height > 0)) return null;
  return {
    quad: points,
    bbox: { x: round(x), y: round(y), width, height },
  };
}

/**
 * Preserve a bounded neutral projection of PDF.js solid-color image-mask
 * rectangles. These marks include rules but can also include fraction bars or
 * other artwork; table semantics are deliberately left to the renderer, which
 * must require a complete closed grid rather than trusting any one rectangle.
 */
function collectPaintedRectangles(operators, pdfjsLib, viewportTransform, pageNumber) {
  const save = pdfjsLib.OPS?.save;
  const restore = pdfjsLib.OPS?.restore;
  const transform = pdfjsLib.OPS?.transform;
  const paint = pdfjsLib.OPS?.paintSolidColorImageMask;
  if (![save, restore, transform, paint].every(Number.isInteger)
    || !Array.isArray(operators?.fnArray)
    || !Array.isArray(operators?.argsArray)) return unavailablePaintedRectangles();
  let current = [1, 0, 0, 1, 0, 0];
  const stack = [];
  const items = [];
  let observedCount = 0;
  for (let operationIndex = 0; operationIndex < operators.fnArray.length; operationIndex += 1) {
    const operation = operators.fnArray[operationIndex];
    if (operation === save) {
      stack.push([...current]);
    } else if (operation === restore) {
      if (stack.length === 0) return unavailablePaintedRectangles();
      current = stack.pop();
    } else if (operation === transform) {
      const values = operators.argsArray[operationIndex];
      if (!Array.isArray(values) || values.length !== 6 || !values.every(Number.isFinite)) {
        return unavailablePaintedRectangles();
      }
      current = multiplyTransforms(current, values);
      if (!current.every(Number.isFinite)) return unavailablePaintedRectangles();
    } else if (operation === paint) {
      const geometry = unitRectangleGeometry(viewportTransform, current);
      if (!geometry) continue;
      observedCount += 1;
      if (items.length >= MAX_PAINTED_RECTANGLES) continue;
      items.push({
        id: `p${String(pageNumber).padStart(4, "0")}-r${String(operationIndex + 1).padStart(6, "0")}`,
        source_operation_index: operationIndex,
        source_kind: "solid_color_image_mask",
        graphics_transform: [...current],
        quad: geometry.quad,
        bbox: geometry.bbox,
      });
    }
  }
  return {
    status: "available",
    truncated: observedCount > items.length,
    observed_count: observedCount,
    returned_count: items.length,
    items,
  };
}

function errorRecord(stage, error) {
  return {
    stage,
    code: String(error?.name || "Error"),
    message: String(error?.message || error || "Unknown parser error").slice(0, 500),
  };
}

function withDeadline(operation, deadlineAt) {
  const remaining = deadlineAt - Date.now();
  if (remaining <= 0) return Promise.reject(Object.assign(new Error("PDF layout extraction exceeded its 20 second deadline."), { code: "LAYOUT_DEADLINE" }));
  let timer;
  return Promise.race([
    operation,
    new Promise((_, reject) => {
      timer = setTimeout(() => reject(Object.assign(new Error("PDF layout extraction exceeded its 20 second deadline."), { code: "LAYOUT_DEADLINE" })), remaining);
    }),
  ]).finally(() => clearTimeout(timer));
}

function classifyLoadingError(error, pdfjsLib) {
  const passwordCode = Number(error?.code);
  const passwordName = String(error?.name || "");
  if (passwordName !== "PasswordException") return error;
  const requiredCode = Number(pdfjsLib.PasswordResponses?.NEED_PASSWORD ?? 1);
  const incorrectCode = Number(pdfjsLib.PasswordResponses?.INCORRECT_PASSWORD ?? 2);
  if (passwordCode === requiredCode) {
    return Object.assign(new Error("PDF password is required."), { code: "PASSWORD_REQUIRED" });
  }
  if (passwordCode === incorrectCode) {
    return Object.assign(new Error("PDF password is incorrect."), { code: "PASSWORD_INCORRECT" });
  }
  return Object.assign(new Error("PDF password authentication failed."), { code: "PASSWORD_AUTHENTICATION_FAILED" });
}

function isFatalParserResourceError(error) {
  const name = String(error?.name || "");
  const code = String(error?.code || "");
  return code === "LAYOUT_DEADLINE"
    || /Abort|Cancel|Timeout|MissingPDF|UnexpectedResponse/i.test(name)
    || /DEADLINE|TIMEOUT|ABORT|CANCEL|ENOMEM|RESOURCE|EIO|EMFILE|ENFILE/i.test(code);
}

function recomputeDocumentTruncation(payload) {
  const truncatedPages = payload.pages.filter(page => page.truncation.truncated);
  payload.truncation.truncated = truncatedPages.length > 0;
  payload.truncation.omitted_items = truncatedPages.reduce((sum, page) => sum + page.truncation.omitted_items, 0);
  payload.truncation.omitted_characters = truncatedPages.reduce((sum, page) => sum + page.truncation.omitted_characters, 0);
  payload.truncation.first_omitted_page = truncatedPages[0]?.page ?? null;
  payload.truncation.first_omitted_source_index = truncatedPages[0]?.truncation.first_omitted_source_index ?? null;
}

function markOutputBudget(payload, maxOutputCharacters) {
  if (JSON.stringify(payload).length <= maxOutputCharacters) return payload;
  for (let index = payload.pages.length - 1; index >= 0 && JSON.stringify(payload).length > maxOutputCharacters; index -= 1) {
    const page = payload.pages[index];
    if (page.ruling_segments.items.length === 0) continue;
    page.ruling_segments = unavailableRulingSegments({
      truncated: true,
      observedCount: page.ruling_segments.observed_count,
    });
    page.extraction_status = page.extraction_status === "failed" ? "failed" : "partial";
    page.needs_visual_inspection = true;
    if (!page.limitations.includes("Ruling-segment detail was omitted to satisfy max_output_characters.")) {
      page.limitations.push("Ruling-segment detail was omitted to satisfy max_output_characters.");
    }
  }
  if (JSON.stringify(payload).length <= maxOutputCharacters) {
    payload.extraction_status = payload.pages.every(page => page.extraction_status === "complete") ? "complete" : "partial";
    return payload;
  }
  for (let index = payload.pages.length - 1; index >= 0 && JSON.stringify(payload).length > maxOutputCharacters; index -= 1) {
    const page = payload.pages[index];
    if (page.painted_rectangles.items.length === 0) continue;
    page.painted_rectangles = {
      status: "unavailable",
      truncated: true,
      observed_count: page.painted_rectangles.observed_count,
      returned_count: 0,
      items: [],
    };
    page.extraction_status = page.extraction_status === "failed" ? "failed" : "partial";
    page.needs_visual_inspection = true;
    if (!page.limitations.includes("Painted rectangle detail was omitted to satisfy max_output_characters.")) {
      page.limitations.push("Painted rectangle detail was omitted to satisfy max_output_characters.");
    }
  }
  if (JSON.stringify(payload).length <= maxOutputCharacters) {
    payload.extraction_status = payload.pages.every(page => page.extraction_status === "complete") ? "complete" : "partial";
    return payload;
  }
  if (!payload.truncation.reasons.includes("max_output_characters")) payload.truncation.reasons.push("max_output_characters");
  for (let index = payload.pages.length - 1; index >= 0 && JSON.stringify(payload).length > maxOutputCharacters; index -= 1) {
    const page = payload.pages[index];
    if (page.raw_items.length === 0 && page.lines.length === 0 && page.flow_text.length === 0) continue;
    page.truncation.truncated = true;
    if (!page.truncation.reasons.includes("max_output_characters")) page.truncation.reasons.push("max_output_characters");
    page.truncation.first_omitted_source_index = page.raw_items[0]?.source_index ?? page.truncation.first_omitted_source_index;
    page.truncation.omitted_items = page.counts.observed_items;
    page.truncation.omitted_non_whitespace_items = page.counts.observed_non_whitespace_items;
    page.truncation.omitted_characters = page.counts.observed_characters;
    page.counts.returned_items = 0;
    page.counts.returned_non_whitespace_items = 0;
    page.counts.returned_characters = 0;
    page.raw_items = [];
    page.lines = [];
    page.blocks = [];
    // Link items are page detail too. Leaving them would keep a link-heavy
    // page over budget and turn a bounded partial into a whole-call error.
    page.link_annotations = { status: "unavailable", truncated: true, items: [] };
    page.painted_rectangles = {
      status: "unavailable",
      truncated: true,
      observed_count: page.painted_rectangles.observed_count,
      returned_count: 0,
      items: [],
    };
    page.ruling_segments = unavailableRulingSegments({
      truncated: true,
      observedCount: page.ruling_segments.observed_count,
    });
    page.flow_text = "";
    page.spatial_text = "";
    page.reading_order = {
      strategy: "unavailable_output_omitted",
      confidence: "not_calibrated",
      column_count: 0,
      limitations: ["Reading-order evidence was omitted to satisfy max_output_characters."],
    };
    if (page.text_layer_status === "present") page.text_layer_status = "partial";
    page.extraction_status = "partial";
    page.needs_visual_inspection = true;
    if (!page.limitations.includes("Page detail omitted to satisfy max_output_characters.")) {
      page.limitations.push("Page detail omitted to satisfy max_output_characters.");
    }
  }
  recomputeDocumentTruncation(payload);
  if (JSON.stringify(payload).length > maxOutputCharacters) {
    throw new Error("Layout metadata exceeds max_output_characters. Request a narrower page range.");
  }
  payload.extraction_status = payload.pages.every(page => page.extraction_status === "failed") ? "failed" : "partial";
  return payload;
}

function finiteOrNull(value) {
  return Number.isFinite(Number(value)) ? round(value) : null;
}

function safeTransform(transform) {
  return Array.from({ length: 6 }, (_, index) => finiteOrNull(transform?.[index]));
}

function semanticAssertion(condition, message) {
  if (!condition) throw new Error(`Invalid Extraction IR semantics: ${message}`);
}

function sameRoundedNumber(left, right) {
  return Number.isFinite(left) && Number.isFinite(right) && Math.abs(left - right) <= 0.002;
}

function roundedProductTolerance(left, right, leftError = 0.0005, rightError = 0.0005) {
  return 0.001 + Math.abs(left) * rightError + Math.abs(right) * leftError + leftError * rightError;
}

function roundedSpanProductTolerance(start, end, scale) {
  const span = end - start;
  return 0.001 + Math.abs(span) * 0.0005 + Math.abs(scale) * 0.001 + 0.0000005;
}

function expectedViewportGeometry(view, userUnit, rotation) {
  const [x1, y1, x2, y2] = view;
  const scale = userUnit;
  const xSpanTolerance = roundedSpanProductTolerance(x1, x2, scale);
  const ySpanTolerance = roundedSpanProductTolerance(y1, y2, scale);
  if (rotation === 0) {
    return {
      width: (x2 - x1) * scale,
      height: (y2 - y1) * scale,
      transform: [scale, 0, 0, -scale, -x1 * scale, y2 * scale],
      width_tolerance: xSpanTolerance,
      height_tolerance: ySpanTolerance,
      transform_tolerances: [0.002, 0.002, 0.002, 0.002, roundedProductTolerance(x1, scale), roundedProductTolerance(y2, scale)],
    };
  }
  if (rotation === 90) {
    return {
      width: (y2 - y1) * scale,
      height: (x2 - x1) * scale,
      transform: [0, scale, scale, 0, -y1 * scale, -x1 * scale],
      width_tolerance: ySpanTolerance,
      height_tolerance: xSpanTolerance,
      transform_tolerances: [0.002, 0.002, 0.002, 0.002, roundedProductTolerance(y1, scale), roundedProductTolerance(x1, scale)],
    };
  }
  if (rotation === 180) {
    return {
      width: (x2 - x1) * scale,
      height: (y2 - y1) * scale,
      transform: [-scale, 0, 0, scale, x2 * scale, -y1 * scale],
      width_tolerance: xSpanTolerance,
      height_tolerance: ySpanTolerance,
      transform_tolerances: [0.002, 0.002, 0.002, 0.002, roundedProductTolerance(x2, scale), roundedProductTolerance(y1, scale)],
    };
  }
  return {
    width: (y2 - y1) * scale,
    height: (x2 - x1) * scale,
    transform: [0, -scale, -scale, 0, y2 * scale, x2 * scale],
    width_tolerance: ySpanTolerance,
    height_tolerance: xSpanTolerance,
    transform_tolerances: [0.002, 0.002, 0.002, 0.002, roundedProductTolerance(y2, scale), roundedProductTolerance(x2, scale)],
  };
}

export function validatePdfLayoutSemantics(payload, {
  sourceBytes = null,
  enforceOutputBudget = true,
} = {}) {
  semanticAssertion(payload.id_scope.source_sha256 === payload.source.sha256, "ID scope source hash mismatch");
  semanticAssertion(payload.id_scope.parser_version === payload.parser.version, "ID scope parser mismatch");
  semanticAssertion(payload.id_scope.ir_version === payload.ir.version, "ID scope IR mismatch");
  semanticAssertion(payload.id_scope.requested_start_page === payload.page_range.requested_start_page, "ID scope start page mismatch");
  semanticAssertion(payload.id_scope.requested_end_page === payload.page_range.requested_end_page, "ID scope end page mismatch");
  semanticAssertion(payload.id_scope.max_items === payload.limits.max_items, "ID scope item limit mismatch");
  semanticAssertion(payload.id_scope.max_characters === payload.limits.max_characters, "ID scope character limit mismatch");
  semanticAssertion(payload.id_scope.max_output_characters === payload.limits.max_output_characters, "ID scope output limit mismatch");
  semanticAssertion(Number.isSafeInteger(payload.source.size_bytes)
    && payload.source.size_bytes >= 1
    && payload.source.size_bytes <= 250 * 1024 * 1024, "invalid source size");
  if (sourceBytes !== null) {
    semanticAssertion(payload.source.size_bytes === sourceBytes.length, "source byte length mismatch");
    semanticAssertion(payload.source.sha256 === createHash("sha256").update(sourceBytes).digest("hex"), "source byte hash mismatch");
  }
  semanticAssertion(Number.isInteger(payload.page_range.requested_start_page) && payload.page_range.requested_start_page >= 1, "invalid requested start page");
  semanticAssertion(payload.page_range.requested_end_page >= payload.page_range.requested_start_page, "invalid requested end page");
  semanticAssertion(payload.page_range.start_page === payload.page_range.requested_start_page
    && payload.page_range.end_page === payload.page_range.requested_end_page
    && payload.page_range.end_page <= payload.page_range.total_pages, "effective page range mismatch");
  semanticAssertion(payload.pages.length <= 10, "page range exceeds hard limit");
  semanticAssertion(payload.limits.max_items >= 1 && payload.limits.max_items <= 5000, "item limit out of range");
  semanticAssertion(payload.limits.max_characters >= 1 && payload.limits.max_characters <= 100000, "character limit out of range");
  semanticAssertion(payload.limits.max_output_characters >= 20000 && payload.limits.max_output_characters <= 200000, "output limit out of range");
  semanticAssertion(payload.limits.deadline_ms === 20000, "deadline mismatch");
  semanticAssertion(payload.pages.length === payload.page_range.end_page - payload.page_range.start_page + 1, "page range length mismatch");

  const documentIds = new Set();
  for (let pageOffset = 0; pageOffset < payload.pages.length; pageOffset += 1) {
    const page = payload.pages[pageOffset];
    const expectedPage = payload.page_range.start_page + pageOffset;
    const pagePrefix = `p${String(expectedPage).padStart(4, "0")}`;
    const links = page.link_annotations;
    semanticAssertion(links && typeof links === "object" && !Array.isArray(links),
      `page ${page.page} link annotations are malformed`);
    semanticAssertion(["available", "unavailable"].includes(links.status),
      `page ${page.page} link annotation status is invalid`);
    semanticAssertion(typeof links.truncated === "boolean",
      `page ${page.page} link annotation truncation flag is invalid`);
    semanticAssertion(Array.isArray(links.items) && links.items.length <= MAX_LINK_ANNOTATIONS,
      `page ${page.page} link annotation list is invalid`);
    semanticAssertion(links.status === "available" || links.items.length === 0,
      `page ${page.page} reports unavailable link annotations with retained items`);
    // An unavailable link state is only legitimate when the page carries an
    // annotations-stage error or had its detail omitted for the output budget.
    // Without this, downgrading available evidence to unavailable would pass.
    const linkAnnotationError = page.errors.some(
      error => error.stage === "annotations" || error.stage === "page",
    );
    const linkBudgetOmitted = page.truncation.reasons.includes("max_output_characters");
    if (links.status === "unavailable") {
      semanticAssertion(linkAnnotationError || linkBudgetOmitted,
        `page ${page.page} reports unavailable link annotations without supporting evidence`);
      semanticAssertion(!linkBudgetOmitted || links.truncated === true,
        `page ${page.page} omitted link detail for the output budget without recording truncation`);
    }
    for (let linkIndex = 0; linkIndex < links.items.length; linkIndex += 1) {
      const link = links.items[linkIndex];
      semanticAssertion(link.id === `${pagePrefix}-link${String(linkIndex + 1).padStart(4, "0")}`,
        `page ${page.page} link ${link.id} is out of order`);
      semanticAssertion([
        "http",
        "internal_destination",
        "action",
        "unsupported_scheme",
        "ambiguous_target",
        "none",
      ].includes(link.target_kind), `page ${page.page} link ${link.id} target kind is invalid`);
      // Only an http target may carry a URL, and it must already be exactly
      // the normalized absolute form the resolver would produce.
      if (link.target_kind === "http") {
        semanticAssertion(typeof link.url === "string"
          && link.url === supportedLinkUrl({ url: link.url }),
        `page ${page.page} link ${link.id} url is not a normalized supported target`);
      } else {
        semanticAssertion(link.url === null,
          `page ${page.page} link ${link.id} retains a url for a non-http target`);
      }
      semanticAssertion(!documentIds.has(link.id), `duplicate ID ${link.id}`);
      documentIds.add(link.id);
      semanticAssertion(link.rect === null || (
        Number.isFinite(link.rect.x) && Number.isFinite(link.rect.y)
        && Number.isFinite(link.rect.width) && Number.isFinite(link.rect.height)
        && link.rect.width >= 0 && link.rect.height >= 0
      ), `page ${page.page} link ${link.id} rect is invalid`);
    }
    semanticAssertion(page.page === expectedPage && page.id === pagePrefix, `page ${expectedPage} identity mismatch`);
    semanticAssertion(page.geometry.page === page.page, `page ${page.page} geometry identity mismatch`);
    const ruledRects = page.ruled_rects;
    semanticAssertion(ruledRects && typeof ruledRects === "object" && !Array.isArray(ruledRects),
      `page ${page.page} ruled rectangle evidence is malformed`);
    semanticAssertion(["available", "truncated", "failed", "unavailable"].includes(ruledRects.status),
      `page ${page.page} ruled rectangle status is invalid`);
    semanticAssertion(Number.isSafeInteger(ruledRects.observed_count) && ruledRects.observed_count >= 0
      && Number.isSafeInteger(ruledRects.returned_count) && ruledRects.returned_count >= 0
      && ruledRects.returned_count <= ruledRects.observed_count
      && Array.isArray(ruledRects.items) && ruledRects.items.length === ruledRects.returned_count
      && ruledRects.items.length <= RULED_RECT_PAGE_LIMIT,
    `page ${page.page} ruled rectangle accounting is invalid`);
    semanticAssertion((ruledRects.status === "truncated") === (ruledRects.observed_count > ruledRects.returned_count),
      `page ${page.page} ruled rectangle truncation status mismatch`);
    if (ruledRects.status === "available") {
      semanticAssertion(ruledRects.observed_count === ruledRects.returned_count,
        `page ${page.page} available ruled rectangle evidence is incomplete`);
    }
    if (ruledRects.status === "failed" || ruledRects.status === "unavailable") {
      semanticAssertion(ruledRects.items.length === 0 && ruledRects.observed_count === 0 && ruledRects.returned_count === 0,
      `page ${page.page} degraded ruled rectangle evidence retains geometry`);
    }
    if (ruledRects.status === "truncated" || ruledRects.status === "failed") {
      semanticAssertion(page.errors.some(error => error.stage === "ruled_rects"),
        `page ${page.page} degraded ruled rectangle evidence lacks a supporting error`);
    }
    if (ruledRects.status === "unavailable") {
      semanticAssertion(page.errors.some(error => error.stage === "operators" || error.stage === "page"),
        `page ${page.page} unavailable ruled rectangle evidence lacks an operator failure`);
    }
    for (const rect of ruledRects.items) {
      semanticAssertion(Number.isFinite(rect.x) && Number.isFinite(rect.y)
        && Number.isFinite(rect.width) && Number.isFinite(rect.height)
        && rect.width >= 0 && rect.height >= 0
        && ["fill", "stroke", "clip", "none"].includes(rect.verb),
      `page ${page.page} ruled rectangle geometry or verb is invalid`);
    }
    const rulingSegments = page.ruling_segments;
    semanticAssertion(rulingSegments && typeof rulingSegments === "object" && !Array.isArray(rulingSegments),
      `page ${page.page} ruling-segment evidence is malformed`);
    semanticAssertion(["available", "unavailable"].includes(rulingSegments.status)
      && typeof rulingSegments.truncated === "boolean"
      && Number.isSafeInteger(rulingSegments.observed_count) && rulingSegments.observed_count >= 0
      && Number.isSafeInteger(rulingSegments.returned_count) && rulingSegments.returned_count >= 0
      && rulingSegments.returned_count <= rulingSegments.observed_count
      && Array.isArray(rulingSegments.items)
      && rulingSegments.items.length === rulingSegments.returned_count
      && rulingSegments.returned_count <= RULING_SEGMENT_PAGE_LIMIT,
    `page ${page.page} ruling-segment accounting is invalid`);
    if (rulingSegments.status === "available") {
      semanticAssertion(rulingSegments.returned_count === Math.min(rulingSegments.observed_count, RULING_SEGMENT_PAGE_LIMIT)
        && rulingSegments.truncated === (rulingSegments.observed_count > rulingSegments.returned_count),
      `page ${page.page} ruling-segment availability is inconsistent`);
    } else {
      semanticAssertion(rulingSegments.returned_count === 0 && rulingSegments.items.length === 0,
        `page ${page.page} unavailable ruling segments leaked geometry`);
      semanticAssertion(rulingSegments.truncated === true
        || page.errors.some(error => error.stage === "operators" || error.stage === "page" || error.stage === "ruled_rects"),
      `page ${page.page} unavailable ruling segments lack an operator failure or typed omission`);
    }
    let priorRulingOperator = -1;
    for (const segment of rulingSegments.items) {
      semanticAssertion(["horizontal", "vertical"].includes(segment.orientation)
        && Number.isFinite(segment.x1)
        && Number.isFinite(segment.y1)
        && Number.isFinite(segment.x2)
        && Number.isFinite(segment.y2)
        && Number.isSafeInteger(segment.source_operator_index)
        && segment.source_operator_index >= priorRulingOperator,
      `page ${page.page} ruling-segment geometry or source order is invalid`);
      priorRulingOperator = segment.source_operator_index;
      if (segment.orientation === "horizontal") {
        semanticAssertion(Math.abs(segment.y2 - segment.y1) <= RULED_RECT_AXIS_TOLERANCE
          && segment.x2 - segment.x1 >= RULING_SEGMENT_MIN_LENGTH,
        `page ${page.page} horizontal ruling segment is not normalized`);
      } else {
        semanticAssertion(Math.abs(segment.x2 - segment.x1) <= RULED_RECT_AXIS_TOLERANCE
          && segment.y2 - segment.y1 >= RULING_SEGMENT_MIN_LENGTH,
        `page ${page.page} vertical ruling segment is not normalized`);
      }
    }
    const operatorCounts = page.operator_counts;
    semanticAssertion(operatorCounts === null || (
      typeof operatorCounts === "object"
      && ["image_paint_ops", "path_segments", "path_construct_ops"].every(field => Number.isSafeInteger(operatorCounts[field]) && operatorCounts[field] >= 0)
    ), `page ${page.page} operator counts are invalid`);
    const textIntegrity = page.text_integrity;
    semanticAssertion(textIntegrity && typeof textIntegrity === "object" && !Array.isArray(textIntegrity)
      && ["ok", "suspect", "unavailable"].includes(textIntegrity.status)
      && Array.isArray(textIntegrity.signals), `page ${page.page} text-integrity evidence is malformed`);
    const textSignalKinds = ["replacement_characters", "private_use_runs", "c1_control_tokens", "non_alphanumeric_dominance"];
    const seenTextSignalKinds = new Set();
    for (const signal of textIntegrity.signals) {
      semanticAssertion(textSignalKinds.includes(signal.kind)
        && Number.isSafeInteger(signal.count) && signal.count > 0
        && !seenTextSignalKinds.has(signal.kind), `page ${page.page} text-integrity signal is invalid`);
      seenTextSignalKinds.add(signal.kind);
    }
    if (textIntegrity.status === "unavailable") {
      semanticAssertion(textIntegrity.signals.length === 0
        && page.errors.some(error => error.stage === "page" || error.stage === "text"),
      `page ${page.page} unavailable text-integrity evidence lacks a text failure`);
    }
    semanticAssertion(page.geometry.rotation_matches_raw === (page.geometry.display_rotation === null || page.geometry.raw_pdf_rotation === null
      ? null : page.geometry.display_rotation === page.geometry.raw_pdf_rotation), `page ${page.page} rotation cross-check mismatch`);
    const rawGeometryUnavailable = page.errors.some(error => error.code === "RAW_PAGE_GEOMETRY_UNAVAILABLE");
    if (rawGeometryUnavailable) {
      semanticAssertion(page.geometry.media_box === null
        && page.geometry.crop_box === null
        && page.geometry.raw_pdf_rotation === null
        && page.geometry.rotation_matches_raw === null, `page ${page.page} unavailable raw geometry contains claims`);
    } else {
      semanticAssertion(page.geometry.media_box !== null
        && page.geometry.crop_box !== null
        && page.geometry.raw_pdf_rotation !== null, `page ${page.page} raw geometry lacks unavailability evidence`);
    }
    for (const rawBox of [page.geometry.media_box, page.geometry.crop_box]) {
      if (rawBox) {
        semanticAssertion([rawBox.x, rawBox.y, rawBox.width, rawBox.height].every(Number.isFinite)
          && rawBox.width > 0 && rawBox.height > 0, `page ${page.page} invalid raw page box`);
      }
    }
    if (page.geometry.display_width !== null || page.geometry.display_height !== null) {
      semanticAssertion(Number.isFinite(page.geometry.display_width) && page.geometry.display_width > 0
        && Number.isFinite(page.geometry.display_height) && page.geometry.display_height > 0, `page ${page.page} invalid display size`);
      semanticAssertion(Array.isArray(page.geometry.viewport_transform)
        && page.geometry.viewport_transform.length === 6
        && page.geometry.viewport_transform.every(Number.isFinite), `page ${page.page} invalid viewport transform`);
      semanticAssertion(Array.isArray(page.geometry.pdfjs_view)
        && page.geometry.pdfjs_view.length === 4
        && page.geometry.pdfjs_view.every(Number.isFinite), `page ${page.page} invalid PDF.js view`);
      semanticAssertion(Number.isFinite(page.geometry.user_unit) && page.geometry.user_unit > 0, `page ${page.page} invalid UserUnit`);
      semanticAssertion(sameRoundedNumber(effectiveViewportScale(page.geometry.viewport_transform), page.geometry.user_unit), `page ${page.page} viewport scale/UserUnit mismatch`);
      const [viewX1, viewY1, viewX2, viewY2] = page.geometry.pdfjs_view;
      semanticAssertion(viewX2 > viewX1 && viewY2 > viewY1, `page ${page.page} invalid PDF.js view bounds`);
      semanticAssertion([0, 90, 180, 270].includes(page.geometry.display_rotation), `page ${page.page} invalid display rotation`);
      const expectedViewport = expectedViewportGeometry(
        page.geometry.pdfjs_view,
        page.geometry.user_unit,
        page.geometry.display_rotation,
      );
      semanticAssertion(Math.abs(page.geometry.display_width - expectedViewport.width) <= expectedViewport.width_tolerance
        && Math.abs(page.geometry.display_height - expectedViewport.height) <= expectedViewport.height_tolerance, `page ${page.page} display size/view mismatch`);
      semanticAssertion(page.geometry.viewport_transform.every((value, index) => Math.abs(value - expectedViewport.transform[index]) <= expectedViewport.transform_tolerances[index]), `page ${page.page} viewport transform/view/rotation mismatch`);
    }
    semanticAssertion(!documentIds.has(page.id), `duplicate ID ${page.id}`);
    documentIds.add(page.id);

    const painted = page.painted_rectangles;
    semanticAssertion(painted && ["available", "unavailable"].includes(painted.status),
      `page ${page.page} painted rectangle status is invalid`);
    semanticAssertion(typeof painted.truncated === "boolean"
      && Number.isSafeInteger(painted.observed_count) && painted.observed_count >= 0
      && Number.isSafeInteger(painted.returned_count) && painted.returned_count >= 0
      && painted.returned_count === painted.items.length
      && painted.returned_count <= painted.observed_count
      && painted.returned_count <= MAX_PAINTED_RECTANGLES,
    `page ${page.page} painted rectangle counts are invalid`);
    if (painted.status === "available") {
      semanticAssertion(painted.returned_count === Math.min(painted.observed_count, MAX_PAINTED_RECTANGLES)
        && painted.truncated === (painted.observed_count > painted.returned_count),
      `page ${page.page} painted rectangle availability is inconsistent`);
    } else {
      semanticAssertion(painted.returned_count === 0 && painted.items.length === 0,
        `page ${page.page} unavailable painted rectangles leaked items`);
    }
    let priorPaintOperation = -1;
    for (const item of painted.items) {
      semanticAssertion(Number.isSafeInteger(item.source_operation_index)
        && item.source_operation_index > priorPaintOperation,
      `page ${page.page} painted rectangle operation order is invalid`);
      priorPaintOperation = item.source_operation_index;
      semanticAssertion(item.id === `${pagePrefix}-r${String(item.source_operation_index + 1).padStart(6, "0")}`
        && item.source_kind === "solid_color_image_mask"
        && Array.isArray(item.graphics_transform)
        && item.graphics_transform.length === 6
        && item.graphics_transform.every(Number.isFinite),
      `painted rectangle ${item.id} source identity is invalid`);
      semanticAssertion(!documentIds.has(item.id), `duplicate ID ${item.id}`);
      documentIds.add(item.id);
      const expected = unitRectangleGeometry(
        page.geometry.viewport_transform,
        item.graphics_transform,
      );
      semanticAssertion(expected !== null
        && sameJson(item.quad, expected.quad)
        && sameJson(item.bbox, expected.bbox),
      `painted rectangle ${item.id} geometry mismatch`);
    }

    const itemById = new Map();
    let returnedCharacters = 0;
    for (let index = 0; index < page.raw_items.length; index += 1) {
      const item = page.raw_items[index];
      const expectedId = `${pagePrefix}-i${String(item.source_index + 1).padStart(6, "0")}`;
      semanticAssertion(item.id === expectedId, `item ID ${item.id} is outside its page/source scope`);
      semanticAssertion(!documentIds.has(item.id), `duplicate ID ${item.id}`);
      semanticAssertion(Number.isSafeInteger(item.source_index) && item.source_index >= 0, `item ${item.id} has unsafe source index`);
      semanticAssertion(item.source_index === index, `page ${page.page} retained items are not the exact source prefix`);
      documentIds.add(item.id);
      itemById.set(item.id, item);
      returnedCharacters += item.text.length;
      const expectedTextKind = item.text.length === 0 ? "empty" : item.text.trim().length === 0 ? "whitespace" : "non_whitespace";
      semanticAssertion(item.text_kind === expectedTextKind, `item ${item.id} text_kind mismatch`);
      semanticAssertion(item.is_whitespace === (expectedTextKind !== "non_whitespace"), `item ${item.id} whitespace mismatch`);
      if (item.source_text === undefined || item.glyph_recoveries === undefined) {
        semanticAssertion(item.source_text === undefined && item.glyph_recoveries === undefined,
          `item ${item.id} has incomplete glyph-recovery evidence`);
      } else {
        semanticAssertion(typeof item.source_text === "string"
          && Array.isArray(item.glyph_recoveries)
          && item.glyph_recoveries.length > 0,
        `item ${item.id} glyph-recovery evidence is malformed`);
        let sourceCursor = 0;
        let outputCursor = 0;
        let recoveredText = "";
        for (const recovery of item.glyph_recoveries) {
          const registry = TYPE3_RECOVERY_BY_ID.get(recovery.registry_id);
          semanticAssertion(registry
            && recovery.qualification === registry.qualification
            && recovery.original_char_code === registry.original_char_code
            && recovery.operator_unicode === registry.source_unicode
            && recovery.target_unicode === registry.target_unicode
            && recovery.glyph_sha256 === registry.glyph_sha256
            && sameJson(recovery.witness_glyph_sha256, registry.witnesses.map(witness => witness.glyph_sha256))
            && recovery.tfm_reference_version === CM_TFM_REFERENCE_VERSION
            && recovery.glyph_evidence_version === TYPE3_GLYPH_EVIDENCE_VERSION,
          `item ${item.id} glyph-recovery registry evidence is invalid`);
          const exactScalarBinding = recovery.binding_kind === "exact_text_scalar"
            && recovery.source_unicode === recovery.operator_unicode
            && recovery.source_unicode.length === 1
            && recovery.operator_advance_width === null
            && recovery.operator_anchor_span_width === null
            && recovery.operator_raw_transform === null;
          const collapsedWhitespaceBinding = recovery.binding_kind === "collapsed_whitespace_item"
            && recovery.source_unicode === " "
            && /^\s$/u.test(recovery.operator_unicode)
            && Number.isFinite(recovery.operator_advance_width)
            && recovery.operator_advance_width > 0
            && Number.isFinite(recovery.operator_anchor_span_width)
            && recovery.operator_anchor_span_width + 0.01 >= recovery.operator_advance_width
            && Array.isArray(recovery.operator_raw_transform)
            && recovery.operator_raw_transform.length === 6
            && recovery.operator_raw_transform.every(Number.isFinite);
          semanticAssertion(recovery.font_name === item.font_name
            && (exactScalarBinding || collapsedWhitespaceBinding)
            && recovery.target_unicode.length === 1
            && recovery.source_utf16_start === sourceCursor + item.source_text.slice(sourceCursor, recovery.source_utf16_start).length
            && recovery.source_utf16_end === recovery.source_utf16_start + recovery.source_unicode.length
            && recovery.output_utf16_start === outputCursor + item.source_text.slice(sourceCursor, recovery.source_utf16_start).length
            && recovery.output_utf16_end === recovery.output_utf16_start + 1
            && recovery.source_utf16_start >= sourceCursor
            && item.source_text.slice(recovery.source_utf16_start, recovery.source_utf16_end) === recovery.source_unicode,
          `item ${item.id} glyph-recovery offsets are invalid`);
          const unchanged = item.source_text.slice(sourceCursor, recovery.source_utf16_start);
          recoveredText += unchanged + recovery.target_unicode;
          sourceCursor = recovery.source_utf16_end;
          outputCursor = recovery.output_utf16_end;
        }
        recoveredText += item.source_text.slice(sourceCursor);
        semanticAssertion(recoveredText === item.text && item.source_text !== item.text,
          `item ${item.id} recovered text does not follow its evidence`);
      }
      const collapsedRecovery = item.glyph_recoveries?.find(recovery => recovery.binding_kind === "collapsed_whitespace_item") ?? null;
      const expectedGeometryFormula = collapsedRecovery
        ? "pdfjs_collapsed_type3_operator_advance_box_approximation"
        : "pdfjs_text_item_style_metric_advance_box_approximation";
      semanticAssertion(item.geometry_provenance.formula === expectedGeometryFormula, `item ${item.id} formula provenance mismatch`);
      semanticAssertion(item.geometry_provenance.quad_order === "anchor_top_terminal_top_anchor_bottom_terminal_bottom", `item ${item.id} quad order mismatch`);
      semanticAssertion(item.geometry_provenance.advance_source === (collapsedRecovery
        ? "operator_advance_width"
        : item.font.vertical ? "item_height" : "item_width"), `item ${item.id} advance provenance mismatch`);
      const expectedGeometry = computeItemGeometry(
        page.geometry.viewport_transform ?? [],
        collapsedRecovery?.operator_raw_transform ?? item.raw_transform ?? [],
        collapsedRecovery?.operator_advance_width ?? item.raw_width,
        item.raw_height,
        item.font,
      );
      semanticAssertion(item.geometry_valid === expectedGeometry.valid, `item ${item.id} geometry validity mismatch`);
      if (!item.geometry_valid) {
        semanticAssertion(item.bbox_status === "invalid" && item.quad === null && item.bbox === null, `item ${item.id} invalid geometry mismatch`);
        semanticAssertion([item.x, item.y, item.width, item.height, item.line_height].every(value => value === null), `item ${item.id} invalid geometry leaked coordinates`);
        semanticAssertion(item.geometry_provenance.ascent_source === null && item.geometry_provenance.ascent_ratio === null, `item ${item.id} invalid geometry provenance mismatch`);
      } else {
        semanticAssertion(Array.isArray(item.raw_transform)
          && item.raw_transform.length === 6
          && item.raw_transform.every(value => typeof value === "number" && Number.isFinite(value))
          && typeof item.raw_width === "number" && Number.isFinite(item.raw_width) && item.raw_width >= 0
          && typeof item.raw_height === "number" && Number.isFinite(item.raw_height) && item.raw_height >= 0, `item ${item.id} invalid raw PDF.js metrics`);
        semanticAssertion(Array.isArray(item.quad) && item.quad.length === 4 && item.bbox, `item ${item.id} missing valid geometry`);
        semanticAssertion(Number.isFinite(item.line_height) && item.line_height >= 0, `item ${item.id} invalid line height`);
        semanticAssertion(item.quad.every(point => Number.isFinite(point.x) && Number.isFinite(point.y)), `item ${item.id} has non-finite quad`);
        semanticAssertion(item.quad.every((point, pointIndex) => sameRoundedNumber(point.x, expectedGeometry.quad[pointIndex].x)
          && sameRoundedNumber(point.y, expectedGeometry.quad[pointIndex].y)), `item ${item.id} quad does not match raw PDF.js metrics`);
        semanticAssertion(sameRoundedNumber(item.line_height, expectedGeometry.line_height), `item ${item.id} line height mismatch`);
        semanticAssertion(item.geometry_provenance.advance_source === (collapsedRecovery ? "operator_advance_width" : expectedGeometry.advance_source)
          && item.geometry_provenance.ascent_source === expectedGeometry.ascent_source
          && sameRoundedNumber(item.geometry_provenance.ascent_ratio, expectedGeometry.ascent_ratio), `item ${item.id} recomputed provenance mismatch`);
        const expectedRawCrossMetric = Math.hypot(item.raw_transform[2], item.raw_transform[3]);
        const rawCrossMetric = item.font.vertical ? item.raw_width : item.raw_height;
        semanticAssertion(rawCrossMetric === 0 || sameRoundedNumber(rawCrossMetric, expectedRawCrossMetric), `item ${item.id} raw cross metric mismatch`);
        const xs = item.quad.map(point => point.x);
        const ys = item.quad.map(point => point.y);
        const expectedBox = {
          x: Math.min(...xs),
          y: Math.min(...ys),
          width: Math.max(...xs) - Math.min(...xs),
          height: Math.max(...ys) - Math.min(...ys),
        };
        semanticAssertion(sameRoundedNumber(item.bbox.x, expectedBox.x)
          && sameRoundedNumber(item.bbox.y, expectedBox.y)
          && sameRoundedNumber(item.bbox.width, expectedBox.width)
          && sameRoundedNumber(item.bbox.height, expectedBox.height), `item ${item.id} bbox does not enclose its quad`);
        semanticAssertion(sameRoundedNumber(item.x, item.bbox.x)
          && sameRoundedNumber(item.y, item.bbox.y)
          && sameRoundedNumber(item.width, item.bbox.width)
          && sameRoundedNumber(item.height, item.bbox.height), `item ${item.id} convenience bbox mismatch`);
        const expectedBboxStatus = item.bbox.width === 0 || item.bbox.height === 0 ? "degenerate" : "valid";
        semanticAssertion(item.bbox_status === expectedBboxStatus, `item ${item.id} bbox_status mismatch`);
        semanticAssertion(sameRoundedNumber(item.bbox.x, expectedGeometry.bbox.x)
          && sameRoundedNumber(item.bbox.y, expectedGeometry.bbox.y)
          && sameRoundedNumber(item.bbox.width, expectedGeometry.bbox.width)
          && sameRoundedNumber(item.bbox.height, expectedGeometry.bbox.height), `item ${item.id} bbox does not match raw PDF.js metrics`);
        const expectedAscent = ascentRatio(item.font);
        semanticAssertion(item.geometry_provenance.ascent_source === expectedAscent.source
          && sameRoundedNumber(item.geometry_provenance.ascent_ratio, expectedAscent.ratio), `item ${item.id} ascent provenance mismatch`);
      }
    }

    semanticAssertion(page.counts.returned_items === page.raw_items.length, `page ${page.page} returned item count mismatch`);
    semanticAssertion(page.counts.returned_characters === returnedCharacters, `page ${page.page} returned character count mismatch`);
    semanticAssertion(page.counts.observed_items === page.counts.returned_items + page.truncation.omitted_items, `page ${page.page} observed item count mismatch`);
    semanticAssertion(page.counts.observed_characters === page.counts.returned_characters + page.truncation.omitted_characters, `page ${page.page} observed character count mismatch`);
    const returnedNonWhitespace = page.raw_items.filter(item => item.text_kind === "non_whitespace").length;
    semanticAssertion(page.counts.returned_non_whitespace_items === returnedNonWhitespace, `page ${page.page} returned non-whitespace count mismatch`);
    semanticAssertion(page.counts.observed_non_whitespace_items === page.counts.returned_non_whitespace_items + page.truncation.omitted_non_whitespace_items, `page ${page.page} observed non-whitespace count mismatch`);
    const pageHasOmissions = page.truncation.omitted_items > 0 || page.truncation.omitted_characters > 0;
    semanticAssertion(page.truncation.truncated === pageHasOmissions, `page ${page.page} truncation flag mismatch`);
    semanticAssertion(new Set(page.truncation.reasons).size === page.truncation.reasons.length, `page ${page.page} duplicate truncation reasons`);
    semanticAssertion(page.truncation.reasons.every(reason => ["max_items", "max_characters", "max_output_characters"].includes(reason)), `page ${page.page} unknown truncation reason`);
    semanticAssertion(page.truncation.truncated
      ? page.truncation.reasons.length > 0 && page.truncation.first_omitted_source_index !== null
      : page.truncation.reasons.length === 0 && page.truncation.first_omitted_source_index === null, `page ${page.page} truncation evidence mismatch`);
    if (page.truncation.first_omitted_source_index !== null) {
      semanticAssertion(page.truncation.first_omitted_source_index === page.raw_items.length,
        `page ${page.page} first omitted index is not the exact prefix boundary`);
    }
    semanticAssertion(page.text_layer_status === "partial" ? page.truncation.truncated : true, `page ${page.page} partial text status lacks truncation`);

    const lineById = new Map();
    const referencedItems = new Set();
    for (let index = 0; index < page.lines.length; index += 1) {
      const line = page.lines[index];
      semanticAssertion(line.reading_order_index === index, `line ${line.id} order mismatch`);
      semanticAssertion(line.id === `${pagePrefix}-l${String(line.source_first_index + 1).padStart(6, "0")}`, `line ${line.id} scope mismatch`);
      semanticAssertion(!documentIds.has(line.id), `duplicate ID ${line.id}`);
      semanticAssertion(line.item_ids.length > 0, `line ${line.id} is empty`);
      documentIds.add(line.id);
      lineById.set(line.id, line);
      const lineItems = line.item_ids.map(id => itemById.get(id));
      semanticAssertion(lineItems.every(Boolean), `line ${line.id} has a dangling item reference`);
      semanticAssertion(lineItems.every(item => item.geometry_valid && item.text_kind === "non_whitespace"), `line ${line.id} contains unsupported items`);
      semanticAssertion(lineItems.every(item => item.direction === line.direction), `line ${line.id} direction mismatch`);
      semanticAssertion(baselineInvariant(lineItems, 0.5), `line ${line.id} baseline spread mismatch`);
      semanticAssertion(Math.min(...lineItems.map(item => item.source_index)) === line.source_first_index, `line ${line.id} source index mismatch`);
      semanticAssertion(line.text === lineText(lineItems, line.direction), `line ${line.id} text mismatch`);
      const expectedLineBox = combineBounds(lineItems);
      semanticAssertion(sameRoundedNumber(line.x, expectedLineBox.x)
        && sameRoundedNumber(line.y, expectedLineBox.y)
        && sameRoundedNumber(line.width, expectedLineBox.width)
        && sameRoundedNumber(line.height, expectedLineBox.height), `line ${line.id} bounds mismatch`);
      for (const item of lineItems) {
        semanticAssertion(!referencedItems.has(item.id), `item ${item.id} appears in multiple lines`);
        semanticAssertion(item.line_id === line.id && item.column_index === line.column_index, `item ${item.id} line back-reference mismatch`);
        referencedItems.add(item.id);
      }
    }
    for (const item of page.raw_items) {
      semanticAssertion(Number.isInteger(item.reading_order_index)
        && item.reading_order_index >= 0
        && item.reading_order_index < page.raw_items.length, `item ${item.id} order is out of range`);
      semanticAssertion(item.line_id === null ? item.column_index === null : lineById.has(item.line_id), `item ${item.id} has a dangling line reference`);
      semanticAssertion(referencedItems.has(item.id) === (item.geometry_valid && item.text_kind === "non_whitespace"), `item ${item.id} line membership mismatch`);
    }
    semanticAssertion(new Set(page.raw_items.map(item => item.reading_order_index)).size === page.raw_items.length, `page ${page.page} item order is not a permutation`);
    const expectedItemOrder = [...page.lines.flatMap(line => line.item_ids), ...page.raw_items.filter(item => !referencedItems.has(item.id)).map(item => item.id)];
    for (let index = 0; index < expectedItemOrder.length; index += 1) {
      semanticAssertion(itemById.get(expectedItemOrder[index]).reading_order_index === index, `page ${page.page} item order reconstruction mismatch`);
    }

    const flattenedBlockLines = [];
    for (let index = 0; index < page.blocks.length; index += 1) {
      const block = page.blocks[index];
      semanticAssertion(block.id === `${pagePrefix}-b${String(index + 1).padStart(4, "0")}`, `block ${block.id} scope mismatch`);
      semanticAssertion(!documentIds.has(block.id), `duplicate ID ${block.id}`);
      semanticAssertion(block.line_ids.length > 0 && block.line_ids.every(id => lineById.has(id)), `block ${block.id} has dangling or empty line references`);
      const blockLines = block.line_ids.map(id => lineById.get(id));
      semanticAssertion(blockLines.every(line => line.column_index === block.column_index), `block ${block.id} column mismatch`);
      const expectedKind = block.column_index === -1
        ? "spanning_flow" : page.reading_order.column_count > 1 ? "column_flow" : "page_flow";
      semanticAssertion(block.kind === expectedKind, `block ${block.id} kind mismatch`);
      documentIds.add(block.id);
      flattenedBlockLines.push(...block.line_ids);
    }
    semanticAssertion(JSON.stringify(flattenedBlockLines) === JSON.stringify(page.lines.map(line => line.id)), `page ${page.page} block coverage mismatch`);
    semanticAssertion(page.flow_text === page.lines.map(line => line.text).join("\n"), `page ${page.page} flow text mismatch`);
    const expectedSpatial = page.lines.map(line => `[${line.id} x=${line.x} y=${line.y} w=${line.width} h=${line.height}] ${line.text}`).join("\n");
    semanticAssertion(page.spatial_text === expectedSpatial, `page ${page.page} spatial text mismatch`);
    const outputOmitted = page.truncation.reasons.includes("max_output_characters");
    semanticAssertion(outputOmitted
      ? page.reading_order.strategy === "unavailable_output_omitted" && page.lines.length === 0 && page.blocks.length === 0
      : page.reading_order.strategy !== "unavailable_output_omitted", `page ${page.page} reading-order availability mismatch`);
    if (page.reading_order.strategy === "two_column_left_to_right") {
      semanticAssertion(page.reading_order.column_count === 2 && page.lines.some(line => line.column_index === 0)
        && page.lines.some(line => line.column_index === 1), `page ${page.page} two-column evidence mismatch`);
    } else if (page.reading_order.strategy === "source_order_fallback") {
      semanticAssertion(page.reading_order.column_count === 1, `page ${page.page} source-order column count mismatch`);
    }
    const expectedTextLayerStatus = page.errors.some(error => error.stage === "page" || error.stage === "text")
      ? "failed" : page.counts.observed_items === 0 ? "empty" : page.truncation.truncated ? "partial" : "present";
    semanticAssertion(page.text_layer_status === expectedTextLayerStatus, `page ${page.page} text-layer status mismatch`);
    const expectedImageStatus = page.errors.some(error => error.stage === "page" || error.stage === "operators")
      ? "failed" : page.has_image_operations ? "detected" : "not_detected";
    semanticAssertion(page.image_detection_status === expectedImageStatus, `page ${page.page} image status mismatch`);
    const hasObservedText = page.counts.observed_non_whitespace_items > 0;
    const expectedModality = expectedImageStatus === "failed"
      ? "unknown"
      : hasObservedText && (page.has_image_operations || page.has_vector_paint_operations) ? "mixed-content-candidate"
        : hasObservedText ? "text-layer-candidate"
          : page.has_image_operations ? "image-only-candidate"
            : page.has_vector_paint_operations ? "vector-only-candidate" : "empty-candidate";
    semanticAssertion(page.modality_hint === expectedModality, `page ${page.page} modality mismatch`);
    const hasInvalidGeometry = page.raw_items.some(item => !item.geometry_valid);
    const hasRawGeometryGap = page.errors.some(error => error.code === "RAW_PAGE_GEOMETRY_UNAVAILABLE");
    const hasAnnotationError = page.errors.some(error => error.stage === "annotations");
    // Degraded link evidence, including a hit 200-link cap, is partial evidence.
    const hasDegradedLinks = page.link_annotations.status !== "available"
      || page.link_annotations.truncated === true;
    const hasDegradedPaintedRectangles = page.painted_rectangles.status !== "available"
      || page.painted_rectangles.truncated === true;
    const hasDegradedRulingSegments = page.ruling_segments.status !== "available"
      || page.ruling_segments.truncated === true;
    const expectedExtraction = expectedTextLayerStatus === "failed"
      ? "failed"
      : page.truncation.truncated || hasInvalidGeometry || hasRawGeometryGap || expectedImageStatus === "failed" || expectedModality !== "text-layer-candidate" || hasAnnotationError || hasDegradedLinks || hasDegradedPaintedRectangles || hasDegradedRulingSegments
        ? "partial" : "complete";
    semanticAssertion(page.extraction_status === expectedExtraction, `page ${page.page} extraction status mismatch`);
    semanticAssertion(page.needs_visual_inspection === (expectedExtraction !== "complete" || expectedModality !== "text-layer-candidate"), `page ${page.page} visual-inspection status mismatch`);
    if (page.extraction_status === "complete") {
      semanticAssertion(page.text_layer_status === "present"
        && page.image_detection_status !== "failed"
        && page.modality_hint === "text-layer-candidate"
        && !page.needs_visual_inspection
        && !page.truncation.truncated
        && page.errors.every(error => error.stage === "ruled_rects")
        && page.link_annotations.status === "available"
        && page.link_annotations.truncated === false
        && page.painted_rectangles.status === "available"
        && page.painted_rectangles.truncated === false
        && page.ruling_segments.status === "available"
        && page.ruling_segments.truncated === false
        && page.raw_items.every(item => item.geometry_valid), `page ${page.page} complete status overclaims evidence`);
    }
    if (page.text_layer_status === "failed") semanticAssertion(page.extraction_status === "failed", `page ${page.page} failed text status mismatch`);
    semanticAssertion(page.errors.every(error => ["page", "text", "operators", "geometry", "annotations", "ruled_rects"].includes(error.stage)
      && typeof error.code === "string" && error.code.length > 0 && error.code.length <= 100
      && typeof error.message === "string" && error.message.length > 0 && error.message.length <= 500), `page ${page.page} invalid error record`);
  }

  const truncatedPages = payload.pages.filter(page => page.truncation.truncated);
  const omittedItems = truncatedPages.reduce((sum, page) => sum + page.truncation.omitted_items, 0);
  const omittedCharacters = truncatedPages.reduce((sum, page) => sum + page.truncation.omitted_characters, 0);
  const documentReasons = [...new Set(payload.pages.flatMap(page => page.truncation.reasons))];
  semanticAssertion(payload.truncation.truncated === (truncatedPages.length > 0), "document truncation flag mismatch");
  semanticAssertion(payload.truncation.omitted_items === omittedItems && payload.truncation.omitted_characters === omittedCharacters, "document omission counts mismatch");
  semanticAssertion(payload.truncation.first_omitted_page === (truncatedPages[0]?.page ?? null), "document first omitted page mismatch");
  semanticAssertion(payload.truncation.first_omitted_source_index === (truncatedPages[0]?.truncation.first_omitted_source_index ?? null), "document first omitted item mismatch");
  semanticAssertion(JSON.stringify(payload.truncation.reasons) === JSON.stringify(documentReasons), "document truncation reasons mismatch");
  const expectedStatus = payload.pages.every(page => page.extraction_status === "complete")
    ? "complete" : payload.pages.every(page => page.extraction_status === "failed") ? "failed" : "partial";
  semanticAssertion(payload.extraction_status === expectedStatus, "document extraction status mismatch");
  if (enforceOutputBudget) {
    semanticAssertion(JSON.stringify(payload).length <= payload.limits.max_output_characters, "serialized output exceeds its declared limit");
  }
  return payload;
}

function sourceEvidenceAssertion(condition, message) {
  if (!condition) throw new Error(`Invalid Extraction IR source evidence: ${message}`);
}

function sameJson(left, right) {
  return JSON.stringify(left) === JSON.stringify(right);
}

function replayOutputBudgetIndependently(seedPayload, maxOutputCharacters) {
  const replay = structuredClone(seedPayload);
  replay.id_scope.max_output_characters = maxOutputCharacters;
  replay.limits.max_output_characters = maxOutputCharacters;
  if (JSON.stringify(replay).length <= maxOutputCharacters) return replay;
  for (let index = replay.pages.length - 1; index >= 0 && JSON.stringify(replay).length > maxOutputCharacters; index -= 1) {
    const page = replay.pages[index];
    if (page.ruling_segments.items.length === 0) continue;
    page.ruling_segments = unavailableRulingSegments({
      truncated: true,
      observedCount: page.ruling_segments.observed_count,
    });
    page.extraction_status = page.extraction_status === "failed" ? "failed" : "partial";
    page.needs_visual_inspection = true;
    if (!page.limitations.includes("Ruling-segment detail was omitted to satisfy max_output_characters.")) {
      page.limitations.push("Ruling-segment detail was omitted to satisfy max_output_characters.");
    }
  }
  if (JSON.stringify(replay).length <= maxOutputCharacters) {
    replay.extraction_status = replay.pages.every(page => page.extraction_status === "complete") ? "complete" : "partial";
    return replay;
  }
  for (let index = replay.pages.length - 1; index >= 0 && JSON.stringify(replay).length > maxOutputCharacters; index -= 1) {
    const page = replay.pages[index];
    if (page.painted_rectangles.items.length === 0) continue;
    page.painted_rectangles = {
      status: "unavailable",
      truncated: true,
      observed_count: page.painted_rectangles.observed_count,
      returned_count: 0,
      items: [],
    };
    page.extraction_status = page.extraction_status === "failed" ? "failed" : "partial";
    page.needs_visual_inspection = true;
    if (!page.limitations.includes("Painted rectangle detail was omitted to satisfy max_output_characters.")) {
      page.limitations.push("Painted rectangle detail was omitted to satisfy max_output_characters.");
    }
  }
  if (JSON.stringify(replay).length <= maxOutputCharacters) {
    replay.extraction_status = replay.pages.every(page => page.extraction_status === "complete") ? "complete" : "partial";
    return replay;
  }
  if (!replay.truncation.reasons.includes("max_output_characters")) replay.truncation.reasons.push("max_output_characters");
  for (let index = replay.pages.length - 1; index >= 0 && JSON.stringify(replay).length > maxOutputCharacters; index -= 1) {
    const page = replay.pages[index];
    if (page.raw_items.length === 0 && page.lines.length === 0 && page.flow_text.length === 0) continue;
    page.truncation.truncated = true;
    if (!page.truncation.reasons.includes("max_output_characters")) page.truncation.reasons.push("max_output_characters");
    page.truncation.first_omitted_source_index = page.raw_items[0]?.source_index ?? page.truncation.first_omitted_source_index;
    page.truncation.omitted_items = page.counts.observed_items;
    page.truncation.omitted_non_whitespace_items = page.counts.observed_non_whitespace_items;
    page.truncation.omitted_characters = page.counts.observed_characters;
    page.counts.returned_items = 0;
    page.counts.returned_non_whitespace_items = 0;
    page.counts.returned_characters = 0;
    page.raw_items = [];
    page.lines = [];
    page.blocks = [];
    page.link_annotations = { status: "unavailable", truncated: true, items: [] };
    page.painted_rectangles = {
      status: "unavailable",
      truncated: true,
      observed_count: page.painted_rectangles.observed_count,
      returned_count: 0,
      items: [],
    };
    page.ruling_segments = unavailableRulingSegments({
      truncated: true,
      observedCount: page.ruling_segments.observed_count,
    });
    page.flow_text = "";
    page.spatial_text = "";
    page.reading_order = {
      strategy: "unavailable_output_omitted",
      confidence: "not_calibrated",
      column_count: 0,
      limitations: ["Reading-order evidence was omitted to satisfy max_output_characters."],
    };
    if (page.text_layer_status === "present") page.text_layer_status = "partial";
    page.extraction_status = "partial";
    page.needs_visual_inspection = true;
    if (!page.limitations.includes("Page detail omitted to satisfy max_output_characters.")) {
      page.limitations.push("Page detail omitted to satisfy max_output_characters.");
    }
  }
  const truncatedPages = replay.pages.filter(page => page.truncation.truncated);
  replay.truncation.truncated = truncatedPages.length > 0;
  replay.truncation.reasons = [...new Set(replay.pages.flatMap(page => page.truncation.reasons))];
  replay.truncation.omitted_items = truncatedPages.reduce((sum, page) => sum + page.truncation.omitted_items, 0);
  replay.truncation.omitted_characters = truncatedPages.reduce((sum, page) => sum + page.truncation.omitted_characters, 0);
  replay.truncation.first_omitted_page = truncatedPages[0]?.page ?? null;
  replay.truncation.first_omitted_source_index = truncatedPages[0]?.truncation.first_omitted_source_index ?? null;
  sourceEvidenceAssertion(JSON.stringify(replay).length <= maxOutputCharacters, "independent output-budget replay exceeds its declared limit");
  replay.extraction_status = replay.pages.every(page => page.extraction_status === "failed") ? "failed" : "partial";
  return replay;
}

/**
 * Reparse the named source bytes and bind the Extraction IR's raw page and
 * TextItem evidence to that parse. Raw pdf-lib boxes/rotation are bound when a
 * second pdf-lib parse succeeds; otherwise their explicit unavailable/null
 * state is verified. validatePdfLayoutSemantics is deliberately
 * synchronous and proves only internal consistency (plus byte identity when
 * sourceBytes is supplied); callers claiming source-bound evidence must await
 * this validator instead.
 */
export async function validatePdfLayoutSourceEvidence(payload, {
  pdfjsLib,
  sourceBytes,
  password = null,
  deadlineAt = Date.now() + 20000,
  enforceOutputBudget = true,
} = {}) {
  validatePdfLayoutSemantics(payload, { sourceBytes, enforceOutputBudget });
  sourceEvidenceAssertion(pdfjsLib && typeof pdfjsLib.getDocument === "function", "PDF.js parser is required");
  sourceEvidenceAssertion(sourceBytes && Number.isSafeInteger(sourceBytes.length), "source bytes are required");
  sourceEvidenceAssertion(String(pdfjsLib.version || "unknown") === payload.parser.version, "parser version mismatch");

  let loadingTask = null;
  let document = null;
  let pdfLibPages = null;
  try {
    loadingTask = pdfjsLib.getDocument({
      data: new Uint8Array(sourceBytes),
      password: password || undefined,
      useWorkerFetch: false,
      isEvalSupported: false,
      ...PDFJS_DOCUMENT_ASSETS,
    });
    try {
      document = await withDeadline(loadingTask.promise, deadlineAt);
    } catch (error) {
      throw classifyLoadingError(error, pdfjsLib);
    }
    sourceEvidenceAssertion(document.numPages === payload.page_range.total_pages, "source page count mismatch");
    try {
      const pdfLibDocument = await withDeadline(PDFDocument.load(sourceBytes, { ignoreEncryption: true, updateMetadata: false }), deadlineAt);
      pdfLibPages = pdfLibDocument.getPages();
      if (pdfLibPages.length !== document.numPages) pdfLibPages = null;
    } catch (error) {
      if (isFatalParserResourceError(error)) throw error;
      pdfLibPages = null;
    }

    // Independent reference replay of the public retention contract. Keep this
    // intentionally small and separate from extractPdfLayout's product loop so
    // a shared implementation bug cannot validate itself.
    let replayRetainedItems = 0;
    let replayRetainedCharacters = 0;
    const sourceImageOps = imageOperationSet(pdfjsLib);
    const sourceVectorOps = vectorOperationSet(pdfjsLib);
    for (const outputPage of payload.pages) {
      let sourcePage = null;
      try {
        let sourceViewport = null;
        let sourcePageError = null;
        try {
          sourcePage = await withDeadline(document.getPage(outputPage.page), deadlineAt);
          sourceViewport = sourcePage.getViewport({ scale: 1 });
        } catch (error) {
          if (isFatalParserResourceError(error)) throw error;
          sourcePageError = error;
        }
        // Independently re-derive link annotation evidence from the reparsed
        // source. Annotations enter the IR as a trust-boundary crossing, so
        // they are re-read here rather than accepted from the product loop.
        let replayLinks = UNAVAILABLE_LINK_ANNOTATIONS;
        let replayLinksRead = false;
        if (sourcePage !== null && typeof sourcePage.getAnnotations === "function") {
          try {
            const sourceAnnotations = await withDeadline(
              sourcePage.getAnnotations({ intent: "display" }),
              deadlineAt,
            );
            replayLinks = collectLinkAnnotations(
              sourceAnnotations,
              sourceViewport?.transform ?? null,
              outputPage.page,
            );
            replayLinksRead = true;
          } catch (error) {
            if (isFatalParserResourceError(error) || error?.code === "LAYOUT_DEADLINE") throw error;
            replayLinks = UNAVAILABLE_LINK_ANNOTATIONS;
          }
        }
        const sourceGeometry = pageGeometry(
          pdfLibPages?.[outputPage.page - 1] ?? null,
          sourcePage,
          sourceViewport,
          outputPage.page,
        );
        for (const field of [
          "pdfjs_view",
          "user_unit",
          "display_rotation",
          "display_width",
          "display_height",
          "viewport_transform",
        ]) {
          sourceEvidenceAssertion(
            sameJson(outputPage.geometry[field], sourceGeometry[field]),
            `page ${outputPage.page} ${field} differs from reparsed source`,
          );
        }
        if (pdfLibPages) {
          for (const field of ["media_box", "crop_box", "raw_pdf_rotation", "rotation_matches_raw"]) {
            sourceEvidenceAssertion(
              sameJson(outputPage.geometry[field], sourceGeometry[field]),
              `page ${outputPage.page} ${field} differs from reparsed source`,
            );
          }
        } else {
          sourceEvidenceAssertion(
            outputPage.geometry.media_box === null
              && outputPage.geometry.crop_box === null
              && outputPage.geometry.raw_pdf_rotation === null
              && outputPage.geometry.rotation_matches_raw === null
              && outputPage.errors.some(error => error.code === "RAW_PAGE_GEOMETRY_UNAVAILABLE"),
            `page ${outputPage.page} raw page geometry is unverified but output contains claims`,
          );
        }
        if (sourcePageError !== null) {
          const expectedError = errorRecord("page", sourcePageError);
          const expectedErrors = [];
          if (!pdfLibPages) {
            expectedErrors.push({
              stage: "geometry",
              code: "RAW_PAGE_GEOMETRY_UNAVAILABLE",
              message: "Raw page-box enrichment was unavailable; PDF.js display geometry remains authoritative.",
            });
          }
          expectedErrors.push(expectedError);
          sourceEvidenceAssertion(
            sameJson(outputPage.errors, expectedErrors)
              && outputPage.text_layer_status === "failed"
              && outputPage.image_detection_status === "failed"
              && outputPage.extraction_status === "failed"
              && outputPage.modality_hint === "unknown"
              && outputPage.needs_visual_inspection === true
              && sameJson(outputPage.counts, {
                observed_items: 0,
                returned_items: 0,
                observed_non_whitespace_items: 0,
                returned_non_whitespace_items: 0,
                observed_characters: 0,
                returned_characters: 0,
              })
              && sameJson(outputPage.truncation, {
                truncated: false,
                reasons: [],
                omitted_items: 0,
                omitted_non_whitespace_items: 0,
                omitted_characters: 0,
                first_omitted_source_index: null,
              })
              && outputPage.raw_items.length === 0
              && outputPage.lines.length === 0
              && outputPage.blocks.length === 0
              && outputPage.flow_text === ""
              && outputPage.spatial_text === ""
              && sameJson(outputPage.reading_order, {
                strategy: "source_order_fallback",
                confidence: "not_calibrated",
                column_count: 1,
                limitations: [
                  "Column evidence was insufficient or ambiguous, so source item order was retained.",
                  "Source order is parser order and is not proof of intended or visible reading order.",
                ],
              })
              && outputPage.has_image_operations === null
              && outputPage.has_vector_paint_operations === null
              && sameJson(outputPage.ruled_rects, { status: "unavailable", observed_count: 0, returned_count: 0, items: [] })
              && sameJson(outputPage.ruling_segments, unavailableRulingSegments())
              && outputPage.text_integrity.status === "unavailable"
              && outputPage.text_integrity.signals.length === 0
              && outputPage.operator_counts === null
              && sameJson(outputPage.painted_rectangles, unavailablePaintedRectangles()),
            `page ${outputPage.page} ordinary page failure differs from reparsed source`,
          );
          continue;
        }

        // Link-annotation evidence. Placed after the replay's own page-failure
        // handling so a genuine page or deadline failure is reported on its own
        // terms rather than as a link mismatch.
        if (outputPage.link_annotations.status === "available") {
          // An available claim must be authenticated by a successful
          // independent read. A missing getAnnotations or a failed replay read
          // can never authenticate link evidence.
          sourceEvidenceAssertion(
            replayLinksRead,
            `page ${outputPage.page} claims available link evidence that was not independently reparsed`,
          );
          sourceEvidenceAssertion(
            JSON.stringify(outputPage.link_annotations) === JSON.stringify(replayLinks),
            `page ${outputPage.page} link annotations differ from independently reparsed source`,
          );
        } else {
          const linkBudgetOmitted = outputPage.truncation.reasons.includes("max_output_characters");
          const linkReadFailed = outputPage.errors.some(
            error => error.stage === "annotations" || error.stage === "page",
          );
          sourceEvidenceAssertion(
            linkBudgetOmitted || linkReadFailed,
            `page ${outputPage.page} reports unavailable link evidence without supporting evidence`,
          );
          sourceEvidenceAssertion(
            outputPage.link_annotations.items.length === 0
              && (!linkBudgetOmitted || outputPage.link_annotations.truncated === true),
            `page ${outputPage.page} unavailable link evidence is malformed`,
          );
        }

        let textContent = null;
        try {
          textContent = await withDeadline(sourcePage.getTextContent({ includeMarkedContent: false, disableNormalization: false }), deadlineAt);
        } catch (error) {
          if (isFatalParserResourceError(error)) throw error;
          const expectedError = errorRecord("text", error);
          sourceEvidenceAssertion(
            outputPage.text_layer_status === "failed"
              && outputPage.raw_items.length === 0
              && outputPage.errors.some(outputError => sameJson(outputError, expectedError)),
            `page ${outputPage.page} source text parse failed but output claims text evidence`,
          );
        }
        const sourceEntries = (textContent?.items ?? [])
          .filter(item => typeof item?.str === "string")
          .map((item, sourceIndex) => [sourceIndex, item]);
        let sourceOperators = null;
        let sourceOperatorError = null;
        try {
          sourceOperators = await withDeadline(sourcePage.getOperatorList(), deadlineAt);
        } catch (error) {
          if (isFatalParserResourceError(error)) throw error;
          sourceOperatorError = error;
        }
        const sourceType3Recoveries = sourceOperatorError === null
          ? collectType3GlyphRecoveries({
            textContent,
            operators: sourceOperators,
            pdfjsPage: sourcePage,
            pdfLibPage: pdfLibPages?.[outputPage.page - 1] ?? null,
            pdfjsLib,
          })
          : new Map();
        const sourceEffectiveText = (sourceIndex, item) => applyType3GlyphRecoveries(
          item.str,
          sourceType3Recoveries.get(sourceIndex) ?? [],
        );
        // Dedicated source replay: ruled_rects, ruling_segments,
        // text_integrity, and operator_counts are all replay-proven from the
        // second parse; none are semantic-only.
        const sourceTextIntegrity = deriveTextIntegrity(sourceEntries, textContent === null);
        sourceEvidenceAssertion(
          sameJson(outputPage.text_integrity, sourceTextIntegrity),
          `page ${outputPage.page} text-integrity evidence differs from independently reparsed source`,
        );
        sourceEvidenceAssertion(outputPage.counts.observed_items === sourceEntries.length, `page ${outputPage.page} observed item count differs from reparsed source`);
        sourceEvidenceAssertion(
          outputPage.counts.observed_non_whitespace_items === sourceEntries.filter(([sourceIndex, item]) => sourceEffectiveText(sourceIndex, item).trim().length > 0).length,
          `page ${outputPage.page} observed non-whitespace count differs from reparsed source`,
        );
        sourceEvidenceAssertion(
          outputPage.counts.observed_characters === sourceEntries.reduce((sum, [, item]) => sum + item.str.length, 0),
          `page ${outputPage.page} observed character count differs from reparsed source`,
        );

        let replayPrefixLength = 0;
        let replayReason = null;
        for (const [, sourceItem] of sourceEntries) {
          const exceedsItems = replayRetainedItems >= payload.limits.max_items;
          const exceedsCharacters = replayRetainedCharacters + sourceItem.str.length > payload.limits.max_characters;
          if (replayReason !== null || exceedsItems || exceedsCharacters) {
            if (replayReason === null) replayReason = exceedsItems ? "max_items" : "max_characters";
            continue;
          }
          replayPrefixLength += 1;
          replayRetainedItems += 1;
          replayRetainedCharacters += sourceItem.str.length;
        }
        const outputOmitted = outputPage.truncation.reasons.includes("max_output_characters");
        const expectedReturnedEntries = outputOmitted ? [] : sourceEntries.slice(0, replayPrefixLength);
        const expectedOmittedEntries = outputOmitted ? sourceEntries : sourceEntries.slice(replayPrefixLength);
        const expectedReasons = [
          ...(replayReason === null ? [] : [replayReason]),
          ...(outputOmitted ? ["max_output_characters"] : []),
        ];
        sourceEvidenceAssertion(
          sameJson(outputPage.raw_items.map(item => item.source_index), expectedReturnedEntries.map(([sourceIndex]) => sourceIndex)),
          `page ${outputPage.page} retained items differ from independently replayed limits`,
        );
        sourceEvidenceAssertion(
          sameJson(outputPage.truncation.reasons, expectedReasons),
          `page ${outputPage.page} truncation reason differs from independently replayed limits`,
        );
        sourceEvidenceAssertion(
          outputPage.truncation.omitted_items === expectedOmittedEntries.length
            && outputPage.truncation.omitted_non_whitespace_items === expectedOmittedEntries.filter(([sourceIndex, item]) => sourceEffectiveText(sourceIndex, item).trim().length > 0).length
            && outputPage.truncation.omitted_characters === expectedOmittedEntries.reduce((sum, [, item]) => sum + item.str.length, 0),
          `page ${outputPage.page} omission counts differ from independently replayed limits`,
        );
        sourceEvidenceAssertion(
          outputPage.truncation.first_omitted_source_index === (expectedOmittedEntries.length > 0 ? expectedReturnedEntries.length : null),
          `page ${outputPage.page} first omitted index differs from independently replayed limits`,
        );

        const sourceByIndex = new Map(sourceEntries);
        const fontIds = new Map();
        for (const outputItem of outputPage.raw_items) {
          const sourceItem = sourceByIndex.get(outputItem.source_index);
          sourceEvidenceAssertion(sourceItem, `item ${outputItem.id} source index is absent from reparsed source`);
          const sourceStyle = textContent?.styles?.[sourceItem.fontName] ?? {};
          if (typeof sourceItem.fontName === "string" && !fontIds.has(sourceItem.fontName)) {
            fontIds.set(sourceItem.fontName, `font-${String(fontIds.size + 1).padStart(4, "0")}`);
          }
          const sourceFont = {
            family: typeof sourceStyle.fontFamily === "string" ? sourceStyle.fontFamily : null,
            ascent: finiteOrNull(sourceStyle.ascent),
            descent: finiteOrNull(sourceStyle.descent),
            vertical: sourceStyle.vertical === true,
          };
          const expectedFontName = typeof sourceItem.fontName === "string" ? fontIds.get(sourceItem.fontName) : null;
          const internalRecoveries = sourceType3Recoveries.get(outputItem.source_index) ?? [];
          const expectedText = applyType3GlyphRecoveries(sourceItem.str, internalRecoveries);
          const expectedGlyphRecoveries = expectedText === sourceItem.str ? undefined : internalRecoveries.map(recovery => ({
            source_utf16_start: recovery.source_utf16_start,
            source_utf16_end: recovery.source_utf16_end,
            output_utf16_start: recovery.output_utf16_start,
            output_utf16_end: recovery.output_utf16_end,
            original_char_code: recovery.original_char_code,
            source_unicode: recovery.source_unicode,
            operator_unicode: recovery.operator_unicode,
            target_unicode: recovery.target_unicode,
            binding_kind: recovery.binding_kind,
            operator_advance_width: recovery.operator_advance_width,
            operator_anchor_span_width: recovery.operator_anchor_span_width,
            operator_raw_transform: recovery.operator_raw_transform,
            font_name: expectedFontName,
            registry_id: recovery.registry_id,
            qualification: recovery.qualification,
            glyph_sha256: recovery.glyph_sha256,
            witness_glyph_sha256: recovery.witness_glyph_sha256,
            tfm_reference_version: recovery.tfm_reference_version,
            glyph_evidence_version: recovery.glyph_evidence_version,
          }));
          const comparisons = [
            ["text", outputItem.text, expectedText],
            ["source_text", outputItem.source_text, expectedGlyphRecoveries ? sourceItem.str : undefined],
            ["glyph_recoveries", outputItem.glyph_recoveries, expectedGlyphRecoveries],
            ["has_eol", outputItem.has_eol, sourceItem.hasEOL === true],
            ["raw_transform", outputItem.raw_transform, safeTransform(sourceItem.transform)],
            ["raw_width", outputItem.raw_width, finiteOrNull(sourceItem.width)],
            ["raw_height", outputItem.raw_height, finiteOrNull(sourceItem.height)],
            ["font_name", outputItem.font_name, expectedFontName],
            ["font", outputItem.font, sourceFont],
            ["direction", outputItem.direction, direction(sourceItem.dir)],
          ];
          for (const [field, actual, expected] of comparisons) {
            sourceEvidenceAssertion(sameJson(actual, expected), `item ${outputItem.id} ${field} differs from reparsed source`);
          }
        }

        let sourceOperatorEvidenceError = null;
        let sourceOperatorEvidence = null;
        if (sourceOperatorError === null) {
          try {
            if (!Array.isArray(sourceOperators?.fnArray)) throw new Error("Operator list fnArray is unavailable.");
            sourceOperatorEvidence = deriveOperatorEvidence(pdfjsLib, sourceOperators, sourceViewport?.transform ?? null);
          } catch (error) {
            if (isFatalParserResourceError(error)) throw error;
            sourceOperatorEvidenceError = error;
          }
        }
        if (sourceOperatorError === null) {
          const sourceHasImageOperations = sourceOperators.fnArray.some(operation => sourceImageOps.has(operation));
          const sourceHasVectorOperations = sourceOperators.fnArray.some(operation => sourceVectorOps.has(operation));
          const sourcePaintedRectangles = collectPaintedRectangles(
            sourceOperators,
            pdfjsLib,
            sourceViewport?.transform ?? [],
            outputPage.page,
          );
          const paintedOutputOmitted = outputPage.painted_rectangles.status === "unavailable"
            && outputPage.painted_rectangles.truncated === true
            && !outputPage.errors.some(error => error.stage === "operators" || error.stage === "page");
          const expectedPaintedRectangles = (outputOmitted || paintedOutputOmitted)
            ? {
              status: "unavailable",
              truncated: true,
              observed_count: sourcePaintedRectangles.observed_count,
              returned_count: 0,
              items: [],
            }
            : sourcePaintedRectangles;
          sourceEvidenceAssertion(
            outputPage.has_image_operations === sourceHasImageOperations
              && outputPage.has_vector_paint_operations === sourceHasVectorOperations
              && sameJson(outputPage.painted_rectangles, expectedPaintedRectangles)
              && !outputPage.errors.some(error => error.stage === "operators"),
            `page ${outputPage.page} operator evidence differs from reparsed source`,
          );
          if (sourceOperatorEvidenceError === null) {
            const expectedRuledErrors = sourceOperatorEvidence.ruled_rects.status === "truncated"
              ? [errorRecord("ruled_rects", Object.assign(new Error(`Ruled rectangle evidence exceeded the per-page limit of ${RULED_RECT_PAGE_LIMIT}.`), { name: "RULED_RECT_PAGE_LIMIT" }))]
              : [];
            const rulingOutputOmitted = outputPage.ruling_segments.status === "unavailable"
              && outputPage.ruling_segments.truncated === true
              && !outputPage.errors.some(error => error.stage === "operators" || error.stage === "page" || error.stage === "ruled_rects");
            const expectedRulingSegments = (outputOmitted || rulingOutputOmitted)
              ? unavailableRulingSegments({
                truncated: true,
                observedCount: sourceOperatorEvidence.ruling_segments.observed_count,
              })
              : sourceOperatorEvidence.ruling_segments;
            sourceEvidenceAssertion(
              sameJson(outputPage.ruled_rects, sourceOperatorEvidence.ruled_rects)
                && sameJson(outputPage.ruling_segments, expectedRulingSegments)
                && sameJson(outputPage.operator_counts, sourceOperatorEvidence.operator_counts)
                && sameJson(outputPage.errors.filter(error => error.stage === "ruled_rects"), expectedRuledErrors),
              `page ${outputPage.page} dedicated operator evidence differs from independently reparsed source`,
            );
          } else {
            const expectedError = errorRecord("ruled_rects", sourceOperatorEvidenceError);
            sourceEvidenceAssertion(
              outputPage.ruled_rects.status === "failed"
                && outputPage.ruled_rects.observed_count === 0
                && outputPage.ruled_rects.returned_count === 0
                && outputPage.ruled_rects.items.length === 0
                && sameJson(outputPage.ruling_segments, unavailableRulingSegments())
                && outputPage.operator_counts === null
                && sameJson(outputPage.errors.filter(error => error.stage === "ruled_rects"), [expectedError]),
              `page ${outputPage.page} failed dedicated operator evidence differs from independently reparsed source`,
            );
          }
        } else {
          const expectedError = errorRecord("operators", sourceOperatorError);
          sourceEvidenceAssertion(
            outputPage.has_image_operations === null
              && outputPage.has_vector_paint_operations === null
              && sameJson(outputPage.ruled_rects, { status: "unavailable", observed_count: 0, returned_count: 0, items: [] })
              && sameJson(outputPage.ruling_segments, unavailableRulingSegments())
              && outputPage.operator_counts === null
              && sameJson(outputPage.painted_rectangles, unavailablePaintedRectangles())
              && outputPage.errors.some(outputError => sameJson(outputError, expectedError)),
            `page ${outputPage.page} source operator parse failed but output claims operator evidence`,
          );
        }
      } finally {
        sourcePage?.cleanup();
      }
    }
    const sourceTruncatedPages = payload.pages.filter(page => page.truncation.truncated);
    const sourceDocumentTruncation = {
      truncated: sourceTruncatedPages.length > 0,
      reasons: [...new Set(payload.pages.flatMap(page => page.truncation.reasons))],
      omitted_items: sourceTruncatedPages.reduce((sum, page) => sum + page.truncation.omitted_items, 0),
      omitted_characters: sourceTruncatedPages.reduce((sum, page) => sum + page.truncation.omitted_characters, 0),
      first_omitted_page: sourceTruncatedPages[0]?.page ?? null,
      first_omitted_source_index: sourceTruncatedPages[0]?.truncation.first_omitted_source_index ?? null,
    };
    sourceEvidenceAssertion(sameJson(payload.truncation, sourceDocumentTruncation), "document truncation differs from source-verified page records");
    const sourceDocumentStatus = payload.pages.every(page => page.extraction_status === "complete")
      ? "complete" : payload.pages.every(page => page.extraction_status === "failed") ? "failed" : "partial";
    sourceEvidenceAssertion(payload.extraction_status === sourceDocumentStatus, "document status differs from source-verified page records");
    if (!enforceOutputBudget) {
      sourceEvidenceAssertion(
        payload.pages.every(page => !page.truncation.reasons.includes("max_output_characters")
          && !(page.painted_rectangles.status === "unavailable" && page.painted_rectangles.truncated)
          && !(page.ruling_segments.status === "unavailable" && page.ruling_segments.truncated)),
        "internal Markdown evidence contains a public output-budget omission",
      );
    } else if (payload.pages.some(page => page.truncation.reasons.includes("max_output_characters")
      || (page.painted_rectangles.status === "unavailable" && page.painted_rectangles.truncated)
      || (page.ruling_segments.status === "unavailable" && page.ruling_segments.truncated))) {
      const replaySeed = await extractPdfLayout({
        pdfjsLib,
        pdfBytes: sourceBytes,
        sourcePath: payload.source.pdf_path,
        sourceFileName: payload.source.file_name,
        sourceSha256: payload.source.sha256,
        sourceSizeBytes: payload.source.size_bytes,
        password,
        requestedStartPage: payload.page_range.requested_start_page,
        requestedEndPage: payload.page_range.requested_end_page,
        maxItems: payload.limits.max_items,
        maxCharacters: payload.limits.max_characters,
        maxOutputCharacters: 200000,
        deadlineMs: payload.limits.deadline_ms,
        operationDeadlineAt: deadlineAt,
        sourceEvidenceValidationToken: INTERNAL_SOURCE_REPLAY,
      });
      const replayedBudget = replayOutputBudgetIndependently(replaySeed, payload.limits.max_output_characters);
      sourceEvidenceAssertion(sameJson(payload, replayedBudget), "output omission differs from independent budget replay");
    }
    return payload;
  } finally {
    await document?.destroy().catch(() => {});
    await loadingTask?.destroy?.().catch(() => {});
  }
}

function horizontalGeometryIsAmbiguous(item) {
  if (item.direction === "ttb") return true;
  if (!item.geometry_valid || !item.quad || item.raw_width === 0) return false;
  const start = item.quad[0];
  const end = item.quad[1];
  const magnitude = Math.hypot(end.x - start.x, end.y - start.y);
  return magnitude > 0 && Math.abs((end.y - start.y) / magnitude) > 0.05;
}

export async function extractPdfLayout({
  pdfjsLib,
  pdfBytes,
  sourcePath,
  sourceFileName,
  sourceSha256,
  sourceSizeBytes = pdfBytes.length,
  password = null,
  requestedStartPage = 1,
  requestedEndPage = requestedStartPage,
  maxItems = 1000,
  maxCharacters = 50000,
  maxOutputCharacters = 50000,
  deadlineMs = 20000,
  operationDeadlineAt = null,
  sourceEvidenceValidationToken = null,
  outputProjectionToken = null,
}) {
  const deadlineAt = operationDeadlineAt ?? Date.now() + deadlineMs;
  let loadingTask = null;
  let document = null;
  try {
    loadingTask = pdfjsLib.getDocument({
      data: new Uint8Array(pdfBytes),
      password: password || undefined,
      useWorkerFetch: false,
      isEvalSupported: false,
      ...PDFJS_DOCUMENT_ASSETS,
    });
    try {
      document = await withDeadline(loadingTask.promise, deadlineAt);
    } catch (error) {
      throw classifyLoadingError(error, pdfjsLib);
    }
    let pdfLibPages = null;
    try {
      const pdfLibDocument = await withDeadline(PDFDocument.load(pdfBytes, { ignoreEncryption: true, updateMetadata: false }), deadlineAt);
      pdfLibPages = pdfLibDocument.getPages();
    } catch (error) {
      if (isFatalParserResourceError(error)) throw error;
      pdfLibPages = null;
    }
    const totalPages = document.numPages;
    if (pdfLibPages && pdfLibPages.length !== totalPages) pdfLibPages = null;
    if (requestedStartPage < 1 || requestedStartPage > totalPages) {
      throw new Error(`start_page ${requestedStartPage} is out of range (1-${totalPages}).`);
    }
    if (requestedEndPage < requestedStartPage || requestedEndPage > totalPages) {
      throw new Error(`end_page ${requestedEndPage} is out of range (${requestedStartPage}-${totalPages}).`);
    }

    const pages = [];
    let retainedItemCount = 0;
    let retainedCharacterCount = 0;
    const imageOps = imageOperationSet(pdfjsLib);
    const vectorOps = vectorOperationSet(pdfjsLib);

    for (let pageNumber = requestedStartPage; pageNumber <= requestedEndPage; pageNumber += 1) {
      const errors = [];
      const limitations = [];
      if (!pdfLibPages) {
        errors.push({
          stage: "geometry",
          code: "RAW_PAGE_GEOMETRY_UNAVAILABLE",
          message: "Raw page-box enrichment was unavailable; PDF.js display geometry remains authoritative.",
        });
        limitations.push("Raw MediaBox, CropBox, and PDF rotation enrichment was unavailable for this page.");
      }
      let textContent = null;
      let hasImageOperations = null;
      let hasVectorPaintOperations = null;
      let ruledRects = { status: "unavailable", observed_count: 0, returned_count: 0, items: [] };
      let rulingSegments = unavailableRulingSegments();
      let operatorCounts = null;
      let paintedRectangles = unavailablePaintedRectangles();
      let type3GlyphRecoveries = new Map();
      let pdfjsPage = null;
      let viewport = null;
      let linkAnnotations = UNAVAILABLE_LINK_ANNOTATIONS;
      try {
        pdfjsPage = await withDeadline(document.getPage(pageNumber), deadlineAt);
        viewport = pdfjsPage.getViewport({ scale: 1 });
        try {
          if (typeof pdfjsPage.getAnnotations !== "function") {
            throw new Error("Parser does not expose annotation evidence.");
          }
          const annotations = await withDeadline(
            pdfjsPage.getAnnotations({ intent: "display" }),
            deadlineAt,
          );
          linkAnnotations = collectLinkAnnotations(
            annotations,
            viewport?.transform ?? null,
            pageNumber,
          );
        } catch (error) {
          if (isFatalParserResourceError(error)) throw error;
          errors.push(errorRecord("annotations", error));
        }
        try {
          textContent = await withDeadline(pdfjsPage.getTextContent({ includeMarkedContent: false, disableNormalization: false }), deadlineAt);
        } catch (error) {
          if (isFatalParserResourceError(error)) throw error;
          errors.push(errorRecord("text", error));
        }
        try {
          const operators = await withDeadline(pdfjsPage.getOperatorList(), deadlineAt);
          hasImageOperations = operators.fnArray.some(operation => imageOps.has(operation));
          hasVectorPaintOperations = operators.fnArray.some(operation => vectorOps.has(operation));
          try {
            const operatorEvidence = deriveOperatorEvidence(pdfjsLib, operators, viewport?.transform ?? null);
            ruledRects = operatorEvidence.ruled_rects;
            rulingSegments = operatorEvidence.ruling_segments;
            operatorCounts = operatorEvidence.operator_counts;
            if (ruledRects.status === "truncated") {
              const limitError = Object.assign(new Error(`Ruled rectangle evidence exceeded the per-page limit of ${RULED_RECT_PAGE_LIMIT}.`), {
                name: "RULED_RECT_PAGE_LIMIT",
              });
              errors.push(errorRecord("ruled_rects", limitError));
            }
          } catch (error) {
            if (isFatalParserResourceError(error)) throw error;
            ruledRects = { status: "failed", observed_count: 0, returned_count: 0, items: [] };
            rulingSegments = unavailableRulingSegments();
            operatorCounts = null;
            errors.push(errorRecord("ruled_rects", error));
          }
          paintedRectangles = collectPaintedRectangles(
            operators,
            pdfjsLib,
            viewport?.transform ?? [],
            pageNumber,
          );
          type3GlyphRecoveries = collectType3GlyphRecoveries({
            textContent,
            operators,
            pdfjsPage,
            pdfLibPage: pdfLibPages?.[pageNumber - 1] ?? null,
            pdfjsLib,
          });
        } catch (error) {
          if (isFatalParserResourceError(error)) throw error;
          errors.push(errorRecord("operators", error));
        }
      } catch (error) {
        if (isFatalParserResourceError(error)) throw error;
        errors.push(errorRecord("page", error));
      } finally {
        pdfjsPage?.cleanup();
      }

      const geometry = pageGeometry(pdfLibPages?.[pageNumber - 1] ?? null, pdfjsPage, viewport, pageNumber);
      const textItemEntries = (textContent?.items ?? [])
        .filter(item => typeof item?.str === "string")
        .map((item, sourceIndex) => [sourceIndex, item]);
      const textIntegrity = deriveTextIntegrity(textItemEntries, textContent === null);
      const observedCharacters = textItemEntries.reduce((sum, [, item]) => sum + item.str.length, 0);
      const rawItems = [];
      const pageReasons = [];
      let firstOmittedSourceIndex = null;
      let hardSegment = 0;
      let invalidGeometry = false;
      const fontIds = new Map();

      for (const [sourceIndex, item] of textItemEntries) {
        const retentionAlreadyTruncated = firstOmittedSourceIndex !== null;
        const exceedsItems = retainedItemCount >= maxItems;
        const exceedsCharacters = retainedCharacterCount + item.str.length > maxCharacters;
        if (retentionAlreadyTruncated || exceedsItems || exceedsCharacters) {
          if (firstOmittedSourceIndex === null) firstOmittedSourceIndex = sourceIndex;
          if (!retentionAlreadyTruncated) {
            const reason = exceedsItems ? "max_items" : "max_characters";
            if (!pageReasons.includes(reason)) pageReasons.push(reason);
          }
          if (item.hasEOL) hardSegment += 1;
          continue;
        }
        const style = textContent?.styles?.[item.fontName] ?? {};
        const rawTransform = safeTransform(item.transform);
        const rawWidth = finiteOrNull(item.width);
        const rawHeight = finiteOrNull(item.height);
        const font = {
          family: typeof style.fontFamily === "string" ? style.fontFamily : null,
          ascent: finiteOrNull(style.ascent),
          descent: finiteOrNull(style.descent),
          vertical: style.vertical === true,
        };
        const itemRecoveries = type3GlyphRecoveries.get(sourceIndex) ?? [];
        const collapsedRecovery = itemRecoveries.find(recovery => recovery.binding_kind === "collapsed_whitespace_item") ?? null;
        const geometryAdvanceWidth = collapsedRecovery?.operator_advance_width ?? rawWidth;
        const geometryItem = computeItemGeometry(
          geometry.viewport_transform ?? [],
          collapsedRecovery?.operator_raw_transform ?? rawTransform,
          geometryAdvanceWidth,
          rawHeight,
          font,
        );
        if (typeof item.fontName === "string" && !fontIds.has(item.fontName)) {
          fontIds.set(item.fontName, `font-${String(fontIds.size + 1).padStart(4, "0")}`);
        }
        const effectiveText = applyType3GlyphRecoveries(item.str, itemRecoveries);
        const publicFontName = typeof item.fontName === "string" ? fontIds.get(item.fontName) : null;
        const publicRecoveries = effectiveText === item.str ? [] : itemRecoveries.map(recovery => ({
          source_utf16_start: recovery.source_utf16_start,
          source_utf16_end: recovery.source_utf16_end,
          output_utf16_start: recovery.output_utf16_start,
          output_utf16_end: recovery.output_utf16_end,
          original_char_code: recovery.original_char_code,
          source_unicode: recovery.source_unicode,
          operator_unicode: recovery.operator_unicode,
          target_unicode: recovery.target_unicode,
          binding_kind: recovery.binding_kind,
          operator_advance_width: recovery.operator_advance_width,
          operator_anchor_span_width: recovery.operator_anchor_span_width,
          operator_raw_transform: recovery.operator_raw_transform,
          font_name: publicFontName,
          registry_id: recovery.registry_id,
          qualification: recovery.qualification,
          glyph_sha256: recovery.glyph_sha256,
          witness_glyph_sha256: recovery.witness_glyph_sha256,
          tfm_reference_version: recovery.tfm_reference_version,
          glyph_evidence_version: recovery.glyph_evidence_version,
        }));
        if (!geometryItem.valid) {
          invalidGeometry = true;
          errors.push({ stage: "geometry", code: "NONFINITE_TEXT_GEOMETRY", message: `Text item ${sourceIndex} has non-finite geometry.` });
        }
        const rawItem = {
          id: `p${String(pageNumber).padStart(4, "0")}-i${String(sourceIndex + 1).padStart(6, "0")}`,
          source_index: sourceIndex,
          text: effectiveText,
          ...(publicRecoveries.length > 0 ? { source_text: item.str, glyph_recoveries: publicRecoveries } : {}),
          is_whitespace: effectiveText.trim().length === 0,
          text_kind: effectiveText.length === 0 ? "empty" : effectiveText.trim().length === 0 ? "whitespace" : "non_whitespace",
          has_eol: item.hasEOL === true,
          raw_transform: rawTransform,
          raw_width: rawWidth,
          raw_height: rawHeight,
          font_name: publicFontName,
          font,
          geometry_kind: "pdfjs_text_run_advance_box",
          geometry_valid: geometryItem.valid,
          bbox_status: !geometryItem.valid ? "invalid" : geometryItem.bbox.width === 0 || geometryItem.bbox.height === 0 ? "degenerate" : "valid",
          geometry_provenance: {
            formula: collapsedRecovery
              ? "pdfjs_collapsed_type3_operator_advance_box_approximation"
              : "pdfjs_text_item_style_metric_advance_box_approximation",
            quad_order: "anchor_top_terminal_top_anchor_bottom_terminal_bottom",
            advance_source: collapsedRecovery ? "operator_advance_width" : geometryItem.advance_source,
            ascent_source: geometryItem.ascent_source,
            ascent_ratio: geometryItem.ascent_ratio,
          },
          quad: geometryItem.quad,
          bbox: geometryItem.bbox,
          x: geometryItem.bbox?.x ?? null,
          y: geometryItem.bbox?.y ?? null,
          width: geometryItem.bbox?.width ?? null,
          height: geometryItem.bbox?.height ?? null,
          line_height: geometryItem.line_height,
          direction: direction(item.dir),
          reading_order_index: -1,
          line_id: null,
          column_index: null,
        };
        Object.defineProperty(rawItem, "hard_segment", { value: hardSegment, enumerable: false });
        rawItems.push(rawItem);
        retainedItemCount += 1;
        retainedCharacterCount += item.str.length;
        if (item.hasEOL) hardSegment += 1;
      }

      const lineCandidates = rawItems.filter(item => item.geometry_valid && !item.is_whitespace);
      const forceSourceOrder = invalidGeometry || lineCandidates.some(horizontalGeometryIsAmbiguous);
      const sourceLines = sourceOrderLines(rawItems, pageNumber);
      const grouped = groupLines(lineCandidates, pageNumber);
      const ordered = readingOrder(grouped, geometry.display_width ?? geometry.crop_box.width, {
        sourceLines,
        forceSourceOrder,
        fallbackReason: invalidGeometry
          ? "At least one retained item had invalid geometry, so source order was retained."
          : "Vertical or skewed text made geometric order ambiguous, so source order was retained.",
      });
      const itemById = new Map(rawItems.map(item => [item.id, item]));
      const orderedIds = [];
      ordered.lines.forEach((line, lineIndex) => {
        line.reading_order_index = lineIndex;
        for (const itemId of line.item_ids) {
          const item = itemById.get(itemId);
          item.line_id = line.id;
          item.column_index = line.column_index;
          orderedIds.push(itemId);
        }
      });
      const orderedIdSet = new Set(orderedIds);
      for (const item of rawItems) {
        if (!orderedIdSet.has(item.id)) {
          orderedIds.push(item.id);
          orderedIdSet.add(item.id);
        }
      }
      const orderById = new Map(orderedIds.map((id, index) => [id, index]));
      for (const item of rawItems) item.reading_order_index = orderById.get(item.id);

      const textLayerStatus = errors.some(error => error.stage === "page" || error.stage === "text")
        ? "failed" : textItemEntries.length === 0 ? "empty" : firstOmittedSourceIndex !== null ? "partial" : "present";
      const imageDetectionStatus = errors.some(error => error.stage === "page" || error.stage === "operators")
        ? "failed" : hasImageOperations ? "detected" : "not_detected";
      const hasText = textItemEntries.some(([, item]) => item.str.trim().length > 0);
      let modalityHint = "unknown";
      if (imageDetectionStatus !== "failed") {
        if (hasText && (hasImageOperations || hasVectorPaintOperations)) modalityHint = "mixed-content-candidate";
        else if (hasText) modalityHint = "text-layer-candidate";
        else if (hasImageOperations) modalityHint = "image-only-candidate";
        else if (hasVectorPaintOperations) modalityHint = "vector-only-candidate";
        else modalityHint = "empty-candidate";
      }
      const pageTruncated = firstOmittedSourceIndex !== null;
      let extractionStatus = "complete";
      if (textLayerStatus === "failed") extractionStatus = "failed";
      else if (pageTruncated || invalidGeometry || !pdfLibPages || imageDetectionStatus === "failed" || modalityHint !== "text-layer-candidate" || errors.some(error => error.stage === "annotations") || linkAnnotations.truncated === true || paintedRectangles.status !== "available" || paintedRectangles.truncated === true || rulingSegments.status !== "available" || rulingSegments.truncated === true) extractionStatus = "partial";
      const needsVisualInspection = extractionStatus !== "complete" || modalityHint !== "text-layer-candidate";
      if (hasImageOperations) limitations.push("Image paint operations were detected, but no image was rendered or OCRed; this is not raster-content proof.");
      if (hasVectorPaintOperations) limitations.push("Vector paint operations were detected but not interpreted.");
      if (imageDetectionStatus === "failed") limitations.push("Image and vector gap detection failed for this page.");
      if (pageTruncated) limitations.push("Page content is incomplete because a caller-supplied retention limit was reached.");
      if (invalidGeometry) limitations.push("At least one retained text item had non-finite geometry and was excluded from geometric reconstruction.");
      limitations.push("The PDF text layer can contain hidden, clipped, duplicated, or OCR-overlay text and is not proof of visible content.");

      const flowText = ordered.lines.map(line => line.text).join("\n");
      pages.push({
        id: `p${String(pageNumber).padStart(4, "0")}`,
        page: pageNumber,
        text_layer_status: textLayerStatus,
        image_detection_status: imageDetectionStatus,
        modality_hint: modalityHint,
        extraction_status: extractionStatus,
        needs_visual_inspection: needsVisualInspection,
        geometry,
        has_image_operations: hasImageOperations,
        has_vector_paint_operations: hasVectorPaintOperations,
        ruled_rects: ruledRects,
        ruling_segments: rulingSegments,
        text_integrity: textIntegrity,
        operator_counts: operatorCounts,
        painted_rectangles: paintedRectangles,
        link_annotations: linkAnnotations,
        raw_items: rawItems,
        lines: ordered.lines,
        blocks: buildBlocks(ordered.lines, pageNumber, ordered.column_count),
        reading_order: {
          strategy: ordered.strategy,
          confidence: ordered.confidence,
          column_count: ordered.column_count,
          limitations: ordered.limitations,
        },
        flow_text: flowText,
        spatial_text: ordered.lines.map(line => `[${line.id} x=${line.x} y=${line.y} w=${line.width} h=${line.height}] ${line.text}`).join("\n"),
        counts: {
          observed_items: textItemEntries.length,
          returned_items: rawItems.length,
          observed_non_whitespace_items: textItemEntries.filter(([sourceIndex, item]) => applyType3GlyphRecoveries(
            item.str,
            type3GlyphRecoveries.get(sourceIndex) ?? [],
          ).trim().length > 0).length,
          returned_non_whitespace_items: rawItems.filter(item => item.text_kind === "non_whitespace").length,
          observed_characters: observedCharacters,
          returned_characters: rawItems.reduce((sum, item) => sum + item.text.length, 0),
        },
        truncation: {
          truncated: pageTruncated,
          reasons: pageReasons,
          omitted_items: textItemEntries.length - rawItems.length,
          omitted_non_whitespace_items: textItemEntries.filter(([sourceIndex, item]) => applyType3GlyphRecoveries(
            item.str,
            type3GlyphRecoveries.get(sourceIndex) ?? [],
          ).trim().length > 0).length
            - rawItems.filter(item => item.text_kind === "non_whitespace").length,
          omitted_characters: observedCharacters - rawItems.reduce((sum, item) => sum + item.text.length, 0),
          first_omitted_source_index: firstOmittedSourceIndex,
        },
        errors,
        limitations,
      });
    }

    const payload = {
      ir: { name: IR_NAME, version: IR_VERSION },
      parser: { name: "pdfjs-dist", version: String(pdfjsLib.version || "unknown") },
      source: { pdf_path: sourcePath, file_name: sourceFileName, sha256: sourceSha256, size_bytes: sourceSizeBytes },
      id_scope: {
        kind: "source_parser_ir_options",
        source_sha256: sourceSha256,
        parser_version: String(pdfjsLib.version || "unknown"),
        ir_version: IR_VERSION,
        requested_start_page: requestedStartPage,
        requested_end_page: requestedEndPage,
        max_items: maxItems,
        max_characters: maxCharacters,
        max_output_characters: maxOutputCharacters,
      },
      page_range: {
        requested_start_page: requestedStartPage,
        requested_end_page: requestedEndPage,
        start_page: requestedStartPage,
        end_page: requestedEndPage,
        total_pages: totalPages,
      },
      extraction_status: pages.every(page => page.extraction_status === "complete")
        ? "complete" : pages.every(page => page.extraction_status === "failed") ? "failed" : "partial",
      pages,
      limits: { max_items: maxItems, max_characters: maxCharacters, max_output_characters: maxOutputCharacters, deadline_ms: deadlineMs },
      truncation: {
        truncated: false,
        reasons: [...new Set(pages.flatMap(page => page.truncation.reasons))],
        omitted_items: 0,
        omitted_characters: 0,
        first_omitted_page: null,
        first_omitted_source_index: null,
      },
      limitations: [
        "Local PDF.js text-layer geometry only; no rendering, OCR, table inference, or arbitrary schema extraction is performed.",
        "PDF.js display-viewport coordinates are not interchangeable with render_pdf_region or signing coordinates; do not pass these boxes to those tools.",
        "Text-run quads are a deterministic PDF.js TextItem/style-metric approximation, not DOM TextLayer or glyph ink bounds.",
        "Text-layer content can be hidden, clipped, duplicated, or an OCR overlay and is not proof of visible page content.",
        "Reading order is deterministic conservative reconstruction, not tagged-PDF or intended semantic order.",
        "Legacy Computer Modern Type-3 text is recovered only for independently qualified exact metric, target-glyph, witness-glyph, and full-page sequence matches; every unsupported or ambiguous variant is left unchanged.",
      ],
    };
    recomputeDocumentTruncation(payload);
    const internalMarkdownProjection = outputProjectionToken === INTERNAL_MARKDOWN_PROJECTION;
    const projectedPayload = internalMarkdownProjection
      ? payload
      : markOutputBudget(payload, maxOutputCharacters);
    const validatedPayload = validatePdfLayoutSemantics(projectedPayload, {
      sourceBytes: pdfBytes,
      enforceOutputBudget: !internalMarkdownProjection,
    });
    if (sourceEvidenceValidationToken === INTERNAL_SOURCE_REPLAY) return validatedPayload;
    return await validatePdfLayoutSourceEvidence(validatedPayload, {
      pdfjsLib,
      sourceBytes: pdfBytes,
      password,
      deadlineAt,
      enforceOutputBudget: !internalMarkdownProjection,
    });
  } finally {
    await document?.destroy().catch(() => {});
    await loadingTask?.destroy?.().catch(() => {});
  }
}

/**
 * Produce source-validated bounded layout evidence for the deterministic local
 * Markdown renderer before the public read_pdf_layout response projection can
 * omit whole-page detail. This remains bounded by the same page, item,
 * character, and deadline limits. It is not an MCP response payload and must
 * be reduced by the Markdown renderer before returning to a client.
 */
export async function extractPdfLayoutForMarkdown(options) {
  return extractPdfLayout({
    ...options,
    outputProjectionToken: INTERNAL_MARKDOWN_PROJECTION,
  });
}

export const EXTRACTION_IR_IDENTITY = Object.freeze({ name: IR_NAME, version: IR_VERSION });
