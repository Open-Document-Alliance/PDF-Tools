# Structured tool output contracts

PDF Tools advertises an MCP `outputSchema` only when a tool can return
`structuredContent`. The schema is part of the wire contract: a successful
result is validated before it leaves the server, structured errors are checked
only against their error branches, and an invalid or missing structured result
is replaced with a text-only `isError` response. Every
structured success also retains `TextContent` for clients that do not consume
structured output.

The pinned MCP SDK 1.29 client validates any `structuredContent` it receives,
including content attached to `isError` results. Consequently each advertised
schema has tightly constrained branches for the generic versioned error
envelope and, where the runtime intentionally returns one, a tool-specific
structured error. Server-side success validation uses only the success branch;
an `isError` result is never forced through a success schema.

## Discovery matrix

| Tool | Advertised structured contract |
| --- | --- |
| `add_signature_field` | active document plus placement |
| `apply_page_plan` | active document plus page-plan outcome |
| `apply_signature` | active document plus signature-stamp audit fields |
| `apply_text` | active document plus text placement |
| `bulk_fill_from_csv` | row results and bounded record preview |
| `check_lumin_status` | authenticated poll status, exact operation authority, retained observation digest, and explicit read-only retry safety |
| `finish_lumin_authorization` | opaque connected-session identity, token expiry, and explicit no-persistence facts |
| `compare_pdfs` | source-bound whole-document alignments, seven-channel coverage, evidence, typed changes, reversible presentation decisions, and an equivalence-claim boundary |
| `create_extraction_workspace` | exact source/schema/map identities, genesis generation, leaf obligations, and private workspace state |
| `create_signature` | saved signature metadata |
| `convert_pdf_to_markdown` | deterministic Markdown, default-on evidence-bounded margin-furniture removal with an exact `remove_page_furniture` opt-out, typed coverage gaps (incl. `MATH_NOT_RECONSTRUCTED`, `PAGE_FURNITURE_REMOVED`, `TABLE_RULING_UNSUPPORTED`, `TEXT_INTEGRITY_SUSPECT`), gap-derived page/document conversion status, `pages_needing_vision` routing, normalization/removal counts, provenance, optional verified UTF-8 output, and (opt-in `emit_table_proposals`) bounded `table_proposals` packets plus document-level region truncation for abandoned table regions |
| `verify_table_proposal` | deterministic accepted/rejected result bound to a fresh source parse, typed B2 coverage/order/header and B3 grid/ruling/ambiguity checks, source/IR/region identity, and source-derived cells plus deterministic GFM only on acceptance; consistency is not proof of unique topology |

| `detect_signature_zones` | detected coordinate zones |
| `delete_extraction_workspace` | exact identity/generation deletion receipt with no recovery claim |
| `display_pdf` | active document and form summary |
| `download_lumin_artifact` | local PDF identity, artifact type and observation digest, with explicit signed-URL and token non-persistence |
| `extract_to_csv` | CSV counts, headers, and bounded row preview |
| `fetch_pdf_from_url` | active document and download provenance |
| `fill_pdf` | active document and field-fill outcome |
| `fill_with_profile` | active document and profile-fill outcome |
| `get_active_document` | empty or populated active-document state |
| `get_allowed_directories` | resolved directory list, whether any were configured, which configuration layer supplied them, and the stored configuration path |
| `get_page_analysis` | bounded page analysis with explicit provenance, operator counts, and a `classification` rollup (`document_kind`, typed `pages_needing_vision`, explicit `pages_not_analyzed`) |
| `get_pdf_identity` | parser-independent canonical path, byte length, and SHA-256 |
| `get_pdf_info` | bounded source-bound page, metadata, form-widget, and inert annotation observations with typed coverage, exact accounting, and a full-envelope digest |
| `inspect_pdf_accessibility` | source-bound eight-signal structural review with bounded observation and reason codes, fixed limitations, required human review, and `not_established` conclusions |
| `inspect_extraction_state` | exact current generation, incomplete/abandoned state, active transaction, and retention limits |
| `get_pdf_resource_uri` | resource URI and local file metadata |
| `list_signatures` | saved signature summaries, including an empty array |
| `load_signature` | signature metadata and optional preview |
| `merge_pdfs` | active output document and page count |
| `prepare_signing_packet` | active document, fills, legacy pending placements, and a source/output-bound provider-neutral preparation receipt with value-free field outcomes, typed zones, readiness gaps, and `provider_execution_status: not_requested` |
| `prepare_lumin_request` | exact local prepared-PDF identity, recipients, disclosure, required confirmation, expiry, and proof that no provider was contacted |
| `propose_pdf_ocr` | optional configured-only one-page unverified word proposals, exact source/render/helper digests, retained private review file, and observed/returned/omitted accounting; absent from default discovery, with no bundled OCR engine |
| `read_pdf_bytes` | bounded base64 byte chunk |
| `read_pdf_content` | complete/partial text or image-fallback result with page-scoped routing facts (`read_pages_without_text`, integrity signals, typed `page_read_error`) preserved through failure and resource-limit branches |
| `read_pdf_fields` | active document and form fields |
| `read_pdf_pages` | bounded page-numbered text |
| `read_pdf_layout` | versioned bounded Extraction IR with source, geometry, reading order, gaps, and limits |
| `read_extraction_chunk` | one freshly rebuilt source/schema/map-bound returned chunk |
| `read_extraction_workspace` | cursor-bound page of chunks, pending leaves, events, proposals, or verification results |
| `render_pdf_page` | source identity, distinct raw page and PDF.js view geometry, renderer policy, raster dimensions, and PNG/raw-pixel digest evidence |
| `render_pdf_region` | source identity, PDF.js viewport request coordinates, rendered raster region, page/view geometry, renderer policy, and PNG/raw-pixel digest evidence |
| `reorder_pdf_pages` | active output document and page order |
| `reveal_in_finder` | revealed path and platform |
| `rotate_pdf_pages` | active output document and rotation outcome |
| `search_pdf_text` | bounded page matches |
| `set_active_document` | populated active-document state |
| `send_lumin_request` | one-shot create outcome, provider request identity, authority digest, status, and explicit no-retry and no-token-persistence facts |
| `submit_extraction_proposal` | new immutable generation containing one explicitly unverified leaf proposal |
| `split_pdf` | input path, output directory, and the page range and page count of every file written |
| `start_lumin_authorization` | opaque pending-session identity, callback expiry, and proof that no PDF was sent |
| `validate_pdf` | versioned PDF field-validation result |
| `verify_extraction_proposal` | new immutable generation containing the deterministic cited replay result and typed status |

The following four tools remain intentionally text-only and therefore do not
advertise `outputSchema`: `list_pdfs`, `list_profiles`, `load_profile`,
and `save_profile`. Their error results are also
text-only; attaching an undeclared `structuredContent` error would create a
wire contract that discovery does not publish.

### Provider-neutral signing preparation receipt

`prepare_signing_packet` remains a local PDF mutation. Its additive
`preparation_receipt` binds the exact source and committed output identities,
the atomic-commit and same-document backup path/hash/size boundary,
MediaBox/CropBox geometry,
page rotation, value-free field-write outcomes, typed signing zones, and an
explicit participant-binding status. The digest is SHA-256 over canonical
non-secret receipt values with the digest field omitted and the domain prefix
`pdf-tools.signing-preparation-receipt.v1\0`.
Native regions retain the tool's MediaBox-relative top-left coordinates;
display regions are translated into CropBox-relative top-left coordinates and
then transformed by the page rotation. Each zone reports whether it is fully
visible, partially clipped, or outside the visible crop.

Legacy placements remain accepted and receive deterministic zone IDs, but the
receipt is `incomplete` until each zone has an intended type plus an opaque
participant ID and role. `require_provider_ready: true` fails before commit for
missing bindings and fails inside the isolated mutation worker before staging
when any requested field write fails. Unknown properties, duplicate IDs or
duplicate zone geometry, malformed identifiers, unsupported types, unresolved
pages, out-of-bounds geometry, and clipped provider-ready zones fail closed.
Legacy calls may still prepare a local artifact with a clipped zone, but its
receipt remains `incomplete` with a typed crop-visibility gap.
`ready_for_provider_mapping` means only that a later provider adapter can
consume the local intent; it does not establish signer identity, consent,
enforceability, provider acceptance, or authorization to transmit or sign.
Receipt preparation is capped at 1,000 pages and refuses a prepared output
above the existing 250 MiB per-file bound before staging or commit. Every
successful receipt says `provider_execution_status: not_requested`.

### Consent-gated Lumin workflow

The six Lumin tools retain structured results without credentials or temporary
signed URLs. Authorization returns only an opaque process-local session ID.
Request preparation is local and binds the exact prepared PDF, provider-neutral
receipt, mapped recipients, disclosure, and confirmation digest. Sending
requires that exact digest plus the user's fresh verbatim confirmation and then
consumes one durable authority with no automatic retry. Status polling and
artifact access can safely repeat reads of an existing provider request but can
never create it again. Artifact download returns only the local PDF identity and
the retained observation digest.
Zone `evidence_source` values are explicitly marked `caller_declared`; this
preparation receipt does not independently replay a detector or AcroForm
evidence artifact.

### Verified table proposal workflow

`convert_pdf_to_markdown` emits `table_proposals` only when
`emit_table_proposals: true` is requested and conversion abandons a bounded
table region with `TABLE_TOPOLOGY_UNKNOWN` or `TABLE_RULING_UNSUPPORTED`.
Each packet includes `region_id`, page, bounding box and coordinate space,
source text items, ruled rectangles and ruling segments, painted rectangles,
header hints, typed per-region truncation, and a `proposal_token` bound to the
source SHA-256, extraction-IR version, and region identity.
`table_proposals_truncation` reports observed, returned, and omitted region
counts at the document level, so the 50-region cap cannot silently discard
proposal evidence. The flag is additive and default-off: the original typed
abstention remains, and output without the flag is byte-identical.

`verify_table_proposal` accepts only the PDF path, packet identity, token, and
untrusted item-to-cell assignments. It reparses the current source and
regenerates text, geometry, header evidence, and rulings. The `checks` object
reports token and region binding, cell validity, coverage, one-cell assignment,
row non-straddle, row and column order, rectangular grid, cut consistency,
ruling agreement, topology ambiguity, header evidence, and content source.
A rejection has typed `reason_codes` and `table: null`. An acceptance includes
source-derived structured cells and deterministic GFM with format, span
projection, byte count, and SHA-256. Structured row and column spans remain
authoritative; GFM places text once at the anchor and leaves continuation cells
empty because GFM cannot represent spans.

Acceptance establishes that emitted cell content came from the freshly parsed
PDF text layer and that the proposed grid is consistent with the available
source-replayed evidence. It does not establish unique topology, semantic
correctness, OCR accuracy, or model quality. Borderless or otherwise ambiguous
geometry continues to reject.

`get_pdf_identity` adds exact structured error codes for an unavailable file,
invalid PDF header, input over 250 MiB, and a file or pathname that changed
during hashing. Path-policy denial remains the shared structured error.

`inspect_pdf_accessibility` returns bounded partial or indeterminate results
for malformed input and a fixed, path-free error for encrypted input. The
encrypted branch exposes no findings. Shared path-policy, file-availability,
source-identity, and isolated-resource errors remain structured and do not
include parser diagnostics or passwords.

`compare_pdfs` has stable structured failures for page-cap refusal, source
identity races, encrypted inputs, unsupported parsing, filesystem policy
denial, unavailable inputs, output-cap refusal, and internal validation
failure. An encrypted input is one refusal
(`PDF_ENCRYPTED_COMPARISON_UNSUPPORTED`) whatever the password arguments say,
because comparison takes raw page geometry and page rendering through pdf-lib,
which cannot decrypt; the message names which input was protected and where an
encrypted document can be read instead. Success validates complete source-page alignment coverage,
known sorted coverage reasons, evidence geometry and digests, change/facet
relations, summary counts, zero server network/persistence effects, and a full
comparison-envelope digest before leaving the server.

The low-level MCP server does not apply advertised input schemas on its own.
Session rehydration and coordinate-bearing mutations therefore validate and
normalize typed arguments before changing active-document state, opening an
output, creating a backup, or editing a PDF. Returned placement and timestamp
fields are the normalized values actually used for the operation.

Saved signature JSON is treated as untrusted input. A shared validator binds
the record name to the requested signature, preserves legacy records that omit
`created_at`, checks typed display text against the actual signature font, and
verifies image MIME, canonical base64, magic bytes, and decoder compatibility.
Creation, listing, loading, and application all use that validator. In
particular, `apply_signature` rejects an unusable or identity-confused record
before loading the target PDF, writing output, or changing active-document
state.

The executable source of truth is `server/output-schemas.js`. The MCP contract
tests assert this complete matrix of 54 structured tools and four text-only
tools, including the configured-only OCR contract. Default discovery still
has 53 structured tools and four text-only tools; enabling local OCR adds one
structured tool. Tests compile every schema through the pinned SDK validator, reject newer
unsupported JSON Schema keywords, exercise live success and error branches, and
require byte-identical source/share runtime files.
