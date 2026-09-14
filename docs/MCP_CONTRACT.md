# MCP discovery contract

PDF Tools serves MCP `2025-11-25` and `2026-07-28` through the stable TypeScript SDK 2.0.0 and MCPB manifest format `0.3`. The official `serveStdio` entry selects the protocol era from the opening exchange and pins it for the connection. Modern connections use `server/discover` and per-request metadata; legacy hosts keep the `initialize` lifecycle. Both eras expose the same tools and prompts. Source, MCPB, and share builds use the same runtime. SDK 1.30.0 remains a development dependency for legacy clients and the Apps 1.7.5 viewer build.

Primary references:

- [MCP lifecycle and capability negotiation](https://modelcontextprotocol.io/specification/2025-11-25/basic/lifecycle)
- [MCP prompts](https://modelcontextprotocol.io/specification/2025-11-25/server/prompts)
- [MCP resources](https://modelcontextprotocol.io/specification/2025-11-25/server/resources)
- [MCP tools](https://modelcontextprotocol.io/specification/2025-11-25/server/tools)
- [MCPB manifest 0.3](https://github.com/modelcontextprotocol/mcpb/blob/main/MANIFEST.md)

## Native Skills

Modern connections declare `io.modelcontextprotocol/skills: {}` alongside `resources: {}` and implement `skills/list`, `skills/get`, and standard `resources/read`. The entry URI is `skill://pdf-tools-workflow/SKILL.md`. Its complete file manifest contains the authored workflow and `agents/openai.yaml`, with SHA-256 digests and byte lengths computed from the exact served bytes. Frontmatter is parsed as YAML without dropping author fields. Each connection reads one immutable snapshot. A read transports instructions; host skill activation, consent, and verification remain host responsibilities.

The file list is an explicit bundled allowlist, independent of user PDF folders. URI lookup is exact: unknown paths, traversal spellings, query strings, and fragments fail with invalid params. Discovery issues no cursors and rejects supplied cursors. Skill discovery and reads use private, zero-TTL cache policy. Optional directory reading and change notifications are not declared. Legacy sessions retain their existing resource catalog and plugin installation fallback without advertising this modern extension.

Both packaging paths include the exact authored files and verify source/share parity. Native host support still requires qualification against the exact MCPB; successful automated stdio tests do not establish desktop activation or rendering. See the [accepted Skills specification](https://github.com/modelcontextprotocol/ext-skills/blob/main/specification/stable/skills.mdx).

## Advertised surfaces

| Surface | Initialize capability | Discovery and use | Static declaration |
| --- | --- | --- | --- |
| Tools | `tools: {}` | `tools/list`, `tools/call` | `manifest.json` and `manifest.mcpb.json` |
| Prompts | `prompts: {}` | `prompts/list`, `prompts/get` | Identical 14-prompt arrays in both manifests |
| Resources | `resources: {}` | `resources/list`, `resources/read` | Runtime only; MCPB 0.3 does not declare resources |

The capability objects do not claim list-change notifications or resource
subscriptions because PDF Tools does not emit or implement them. Resource
template discovery is also unsupported and deterministically returns JSON-RPC
`-32601` (`Method not found`).

### Tools

The runtime returns 57 uniquely named tools. Every tool has an object input
schema plus `title`, `readOnlyHint`, `destructiveHint`, `idempotentHint`, and
`openWorldHint` annotations. Annotations are user-interface hints, never an
authorization boundary; path allowlists and signature-intent checks remain the
enforced controls. The contract test enforces the exact four-hint policy for
every tool in both runtime copies. The handler evidence and classification
rules are recorded in
[`TOOL_ANNOTATION_AUDIT_2026-07-21.md`](TOOL_ANNOTATION_AUDIT_2026-07-21.md).

The source manifest lists all 57 tools. The packed MCPB manifest lists the 56
normal model-workflow tools and omits `read_pdf_bytes`, whose runtime metadata
marks it `ui.visibility: ["app"]`. `tools_generated: true` explicitly tells MCPB
hosts that runtime discovery includes an additional tool. That visibility hint
is advisory and depends on an MCP Apps-aware host filtering its model catalog;
a generic MCP client can still discover and call `read_pdf_bytes`. It is not an
authorization or confidentiality boundary. Filesystem allowlists and the tool's
bounded reads remain the enforced controls.

Filesystem scope applies to direct PDF Tools calls. In Agent Plugin mode, a
fresh install directly accesses only its private `${PLUGIN_DATA}/workspace`.
A desktop host with broader operating-system permission may copy a file into
that workspace; this is host-authorized import and is not prevented by the PDF
Tools path policy. Consequently the active folder list is defense in depth, not
a source-confidentiality boundary against a Full Access host. Content returned
through MCP remains subject to the host and model provider's data terms.

Fifty-three tool handlers advertise strict `outputSchema` contracts and return
`structuredContent`. They also return a human-readable `content` text block so
non-Apps and older clients remain usable. Successful structured output is
validated before it leaves the server, with separate generic and tool-specific
error branches where required.

`get_pdf_identity` provides parser-independent artifact binding for planning
and provenance. It streams at most 250 MiB from one read-only descriptor,
returns the canonical local path, exact byte length, and SHA-256, and rejects
observable requested-path, canonical-path, or inode changes. It requires a
`%PDF-` header within the first 1,024 bytes but does not otherwise parse or
decrypt the PDF, so an encrypted document can be identified before a password
is available. Structured failures distinguish path denial, unavailable files,
invalid PDF headers, oversized inputs, and retryable identity races.

`inspect_pdf_accessibility` performs a local read-only structural review of an
unencrypted PDF. It reports exactly eight shallow catalog-level signals, one
source descriptor with SHA-256, and no output files. Each signal is observed,
missing, or unavailable with bounded reason codes. Machine validation is fixed
at `not_run`, human review is required, and PDF/UA, WCAG, certification, legal,
and document-accessibility conclusions remain `not_established`. Encrypted
inputs return a fixed abstention without findings. The tool does not run
veraPDF or assess tag semantics or assistive-technology behavior.

The trajectory harness preserves `tool-contracts.v1.json` and
`tool-contracts.v2.json` for their frozen evidence. The v2 jobs remain bound to
the reviewed v2 40-tool projection that introduced `get_pdf_identity`.
`tool-contracts.v3.json` is the current runtime projection and includes the
exact-output-identity preconditions. New evaluation suites must bind v3
explicitly. The grader selects the allowlisted contract and trust registry
declared by each suite, so historical evidence remains valid under its original
stack and is not silently rescored. The six existing trajectory jobs do not
constitute behavioral trajectory coverage of all 57 tools.
`get_pdf_identity` is covered by its contract, handler, filesystem-race, and
agent-workflow tests rather than by those six retained jobs.

Existing output replacement is fail-closed. The twelve PDF-producing mutators
create an absent destination without an identity. A distinct existing
destination is replaced only when `expected_output_identity` exactly matches
its canonical path, byte length, and SHA-256 while the output-directory lock is
held. `bulk_fill_from_csv` and `split_pdf` use the bounded
`expected_output_identities` manifest and abort the entire batch on a missing,
stale, duplicate, unrelated, or aliased entry. Existing destinations that are
hardlink aliases to protected inputs are rejected even when their content and
supplied identity match. Same-document fill, signature, and text operations
retain their separate immutable-backup lifecycle and internally bind the
already loaded input identity. `apply_text` and `apply_signature` retain their
deprecated `overwrite: true` field as a compatibility no-op when the
destination is absent or identifies that same canonical document. It never
authorizes replacing a distinct existing output. Caller-supplied same-document
identity is checked under the document mutation lock before an original backup
or pending mutation record is created. The exact identity is a server
precondition, not proof that a person approved the replacement. The workflow
or host must still obtain that approval.

#### Extraction and page-analysis truthfulness

`get_pdf_info` returns bounded observations tied to the exact race-aware
source path, byte length, and SHA-256. Page geometry preserves MediaBox,
CropBox, rotation, and UserUnit in raw bottom-left PDF user space. A separate
PDF.js page-view envelope records the CropBox/view, rotation, UserUnit, and
top-left display dimensions.
Metadata preserves Info and XMP as distinct records and reports disagreement
without choosing a winner. Form widgets are returned only under
`form_fields`; ordinary annotations are separate, and external URLs, internal
destinations, and actions are inert observed values that are never opened or
fetched. Each channel reports `supported`, `partial`, or `unavailable` with
typed reasons. Whole observation records are omitted when necessary to honor
the caller's serialized output cap.

`render_pdf_page` and `render_pdf_region` preserve their existing raster
fields and additionally bind the image to the source identity, page geometry,
requested and rendered coordinate spaces, renderer policy, and PNG SHA-256.
Native canvas renders also report a digest of the exact raw RGBA bytes.
`render_pdf_region` requests use the rotated, UserUnit-scaled PDF.js page view
with a top-left origin. They are not interchangeable with MediaBox-relative
zone or signing coordinates. System-rendered PNGs report raw-pixel evidence as
unavailable. The macOS system path renders through Quick Look (`qlmanage`),
with its PDF.js page-view and crop mapping covered by nonzero-origin, CropBox,
rotation, and UserUnit regressions. Canonical comparison still requires native
raw-RGBA rendering and never silently substitutes this system path.

`compare_pdfs` is a local, read-only, whole-document operation over two PDFs
with at most 20 pages each. It binds canonical path, byte length, SHA-256,
parser, observation digest, page count, and pre/post immutability evidence for
both inputs. It aligns pages without resolving repeated-page ambiguity, emits
source-bound observations and typed changes across seven coverage channels,
and keeps widgets under the form channel rather than ordinary annotations.
Coverage is degraded, never inflated, for content the engine did not actually
compare: a compared page whose Extraction IR reports a failed text layer or
extraction drops the semantic and text channels to `unavailable`, a partial
one drops them to `partial` (a scanned, image-only, or otherwise non-text
page is therefore never reported as fully covered by the text channels), and
any repeated/template page the aligner refuses to pair degrades the semantic,
text, and structure channels to `partial` with a typed `REPEATED_PAGE_AMBIGUITY`
reason rather than being silently skipped. A checkbox's displayed appearance
state (`/AS`) is captured on the observation but intentionally not a separate
compared property, because the parser folds it into the observed field value,
so a change in it is already reported through that value rather than duplicated.
This folding does not hold for radio groups: the parser reports the shared
group value for every widget and does not expose per-widget `/AS`, so a change
to an individual radio widget's displayed state while the group value is
unchanged is **not currently detected** — a named coverage gap, not a claim of
full form-appearance coverage.
Evidence display regions preserve PDF.js viewport coordinates even when PDF
content is clipped or lies partly outside the CropBox; consumers clip those
regions for display rather than rewriting the source coordinates.
Default-material suppressions are retained as reversible typed decisions;
forensic mode reports them. A complete result means every requested channel was
fully observed under this policy; a partial result names the channels and pages
that were not. `no_reported_changes` is fail-closed: an empty change set is not
reported as green when any requested channel is less than fully supported. It
never sets an equivalence claim, and an empty reported set is not proof that the
files are semantically identical.

Comparison refuses page-cap prefixes, changed sources, malformed PDFs,
encrypted inputs, output-cap truncation, unknown input fields, and invalid
internal semantics. Encryption is a single refusal rather than a password
failure: PDF.js decrypts the text, form, annotation and metadata channels, but
raw page geometry and page rendering go through pdf-lib, which cannot decrypt,
so no password makes a comparison run and the refusal says so. Public errors use stable typed messages and do not include
input paths, passwords, or lower-level parser and filesystem text. Native raw
RGBA is the only visual comparison sensor; an unavailable native renderer is
typed partial coverage rather than a system-renderer substitution.

`read_pdf_layout` returns the versioned PDF Tools Extraction IR for at most 10
pages per call. It binds each ID scope to the source SHA-256, pinned PDF.js
parser, IR version, page range, and retention options. When pdf-lib can parse
the same authenticated bytes, it preserves raw MediaBox, CropBox, and PDF
rotation; otherwise those enrichment fields are null and an explicit geometry
error is returned while PDF.js remains the display-geometry authority. Raw
MediaBox and CropBox values remain in PDF default user space before UserUnit
and page rotation. `pdfjs_view` is recorded separately in that raw coordinate
space, and UserUnit comes from PDF.js. Item quads and boxes
use a separate top-left space in physical 1/72-inch points after UserUnit and
rotation in the PDF.js display viewport. Text-run quads use a deterministic
PDF.js TextItem/style-metric approximation: the baseline is shifted by the
recorded ascent ratio, the advance axis uses item width (or item height for
vertical text) times the effective viewport scale, and the cross axis uses
transformed font height. The IR records the advance and ascent provenance.
These boxes are neither browser DOM TextLayer boxes nor glyph ink bounds. Quad
points are ordered anchor-top, terminal-top, anchor-bottom, terminal-bottom;
they are not polygon winding order. `line_height` is the modeled TextLayer
font-height vector, not a font-size or ink-height measurement.
Stable item, line, and nonsemantic flow-block references support conservative
reading order without claiming paragraphs or document structure. Version 1.2
also retains bounded, axis-aligned solid-mask rectangle evidence with exact
source-operation and transform provenance. Those rectangles are neutral paint
evidence, not inferred rules or cells. Raster-only, mixed, hidden, clipped,
duplicate, and OCR-overlay gaps remain explicit. The tool does not render, OCR,
infer tables, or claim arbitrary schema extraction,
and every item, character, or output limit is fail-closed with truncation
metadata. Its coordinates must not be passed to `render_pdf_region` or signing
tools.

`convert_pdf_to_markdown` consumes that source-validated IR and emits bounded,
deterministic UTF-8 Markdown. It preserves supported text and conservative
reading order, escapes Markdown and HTML control syntax, and promotes headings
or list markers only when the retained text and geometry support them. It
reconstructs a table only when every row fills every recurring detected
column, or when one unambiguous complete closed grid can be established from
the bounded solid-mask rectangle evidence. Every retained grid item must fit
exactly one cell, and either route requires real first-row header evidence. It
emits a link only for a source-validated external http or https annotation
target that maps to exactly one contiguous run of text on one line. Unsupported
text from stroked, incomplete, or ambiguous grids, aligned partial dividers,
internal destinations, actions, other URL schemes, and ambiguous or partially
covered labels stays escaped and is reported as a typed gap. Cell artwork is
omitted and reported as a vector-content gap. It does not
run OCR, render image content, or use an external model. Raster, mixed,
vector, failed, caller-limit-truncated, invalid-geometry, output-omission, and
source-evidenced unreconstructed-mathematics cases are represented as typed
gaps and cannot receive a complete conversion status. The
`MATH_NOT_RECONSTRUCTED` code is emitted per page only when an unambiguous
mathematical glyph occurs, when a relation and independent cross-font evidence
occur in the same compact source-item run, or when one retained source item
matches a finite merged-equation grammar: an exact named operator, an equals
sign, and a separate single-letter variable; ambiguous operator names require
function parentheses. Named operators are
case-insensitive so real lowercase `lim`, `max`, and `min` notation is covered.
A lone operator word, `max=5`, `max x=5`, programming declarations such as
`int x=5`, prose words containing an operator substring, generic configuration
syntax, a standalone square-root character that may be a table checkmark, and
raised or lowered text remain undeclared
rather than guessed. These rules declare source-evidenced math but never
reconstruct or alter the Markdown body.
By default, the renderer also removes only source-evidenced page furniture in
the extreme top or bottom 12 percent of a page: an explicit page-number or
provenance line, or text repeated in the same band on at least two selected
pages after digit normalization. The line must be smaller than or comparable
to body text, no longer than 120 Unicode characters, and geometrically
separated from at least two inner-body lines.
Detected headings and every source-evidenced table-region line, including an
abandoned table, are protected. Each removal emits the page-scoped
`PAGE_FURNITURE_REMOVED` gap, changes derived conversion status to `partial`,
and is counted by kind and removed characters in `normalizations`.
`remove_page_furniture: false` preserves every source line.
With `emit_table_proposals: true`,
each abandoned table region also carries one bounded packet containing source
text items, ruled and painted geometry, header hints, typed truncation, and a
token bound to the source hash, extraction-IR version, and region identity.
Document-level observed, returned, and omitted counts make the 50-region cap
explicit. This option is additive and default-off: it does not remove the
abstention gap or change ordinary output.

The read-only `verify_table_proposal` tool accepts only that region/token
identity and untrusted item-to-cell assignments. It reparses the current PDF,
regenerates all content and evidence, and requires complete one-cell coverage,
conservative order, independent header evidence, a well-formed rectangular
grid, consistent cuts, agreement with every available source ruling, and
non-ambiguous topology. Rejection emits no cells or Markdown. Acceptance emits
only freshly source-derived cells plus a deterministic GFM projection; because
GFM cannot encode spans, structured spans remain authoritative while the
projection uses anchor text and empty continuation cells. This proves
source-backed content and consistency with the replayed evidence, not that the
topology is unique or semantically correct. No OCR, model, network call, or
numeric confidence is part of verification.

The converter consumes
source-validated evidence before the public `read_pdf_layout` response
projection, so that response's 200,000-character cap cannot erase conversion
input. Conversion remains bounded by caller item, character, page, deadline,
and final Markdown byte limits. An optional `.md` output uses the same durable
same-directory transaction machinery as PDF outputs, refuses an existing file
unless `overwrite` is true and `expected_output_identity` exactly matches its
current canonical path, byte length, and SHA-256, and activates staged bytes
with an atomic no-clobber hard link. A local Node transaction worker starts with its current
directory bound to the canonical allowed parent and uses only relative mutation
paths, so later parent renames or symlink replacements cannot redirect writes.
The bound directory identity, exact UTF-8 output, and source PDF hash, size, and
filesystem identity are revalidated before the transaction commits or deletes
prior output bytes.

`read_pdf_content` exposes `extraction_status` as `complete`, `partial`, or
`failed`. A text result is partial when it is page-limited or response-
truncated. A successful first-page image fallback is also partial because it
does not establish the contents of every page. If text extraction finds no
content and image fallback fails, the tool returns `isError: true` while
preserving safe document metadata and page-preview measurements in
`structuredContent`. That result uses `extraction_mode: "none"`,
`content_available: false`, stable public `error_codes`, and retry guidance;
it must never be interpreted as proof that the PDF is empty. Internal renderer
error text is logged to stderr rather than exposed in the structured contract.

`get_page_analysis` reports geometry from `pdf-lib` separately from content
measurements obtained through PDF.js. Every page has explicit text/image/vector-graphics
measurement status, provenance, and `blank_status` (`likely_blank`,
`not_blank`, or `unknown`). A page is `likely_blank` only when text and
operator-list measurements completed successfully and found no text, image, or
painted vector graphics. Positive partial
evidence can still establish `not_blank`; missing or failed evidence produces
`unknown`, with `null` rather than fabricated zero/false values. Whole-document,
per-page, and 200-page-cap gaps are therefore never deletion or reorder advice.
When any pages are unknown, the response tells agents to retry and then inspect
those pages with `render_pdf_page` before a page mutation. Even a
`likely_blank` result is a conservative heuristic rather than deletion
authorization; `mutation_guidance` requires visual inspection of every
candidate before deletion or reordering.

### Prompts

The 14 manifest prompt templates are first-class MCP prompts. Runtime
discovery preserves manifest order, names, descriptions, and argument names.
Every declared argument is required because every one is interpolated into its
template. `prompts/get` returns one user message: the declared template with argument
values substituted in place, and nothing else added.

User-provided values are bounded to 1,024 characters, and reject non-strings,
C0/C1 and common invisible/bidirectional format characters, and `${` template
markers. That input validation is the **only** boundary applied to them.

Values are substituted directly into the message text, so a value becomes part
of an operative instruction carrying the `user` role. **Clients must keep prompt
invocation user-controlled and must not source arguments from untrusted
documents, tool output, or model output without their own review.**

Earlier versions isolated values in a delimited JSON block referenced by name.
That was removed because it made the feature unusable, not because it was
unnecessary: Claude Desktop validates the `prompts/get` response against the
manifest-declared text and refuses any addition with "content validation
failed. Rejecting response to prevent potential prompt injection", so the
prompt never attaches. Measured against Claude Desktop 1.25927.0 on Windows 11,
2026-08-06; a delimited block, an appended JSON object, and a single appended
plain sentence were each refused, while unadorned substitution attached.
Server-side isolation is therefore not available under that host, and any
future attempt to reintroduce it must be re-measured against a real host
before it is shipped.

Missing arguments, unknown arguments, and unknown prompt names return JSON-RPC
`-32602` (`Invalid params`). Adding or removing a prompt requires updating both
manifests and both committed runtime copies; the contract test detects drift.

### Resources

`resources/list` returns the MCP Apps viewer at
`ui://pdf-toolkit/viewer`. `resources/read` returns its single-file HTML with
the `text/html;profile=mcp-app` media type.

PDF file resources are dynamic and therefore are not included in
`resources/list`. `get_pdf_resource_uri` applies the filesystem allowlist, then
encodes the absolute platform path as one percent-encoded segment under the
canonical `pdf://local/` authority. The encoded path is the canonical one, and
`pdf_path` reports the same value, so a URI that outlives the call still names
the file the allowlist accepted rather than a name that can be repointed before
`resources/read` runs. Where the requested path traverses a symlink the two
differ: on macOS a temp root under `/var` reports `/private/var`. The symmetric decoder handles POSIX,
Windows-drive, UNC, Unicode, and RFC 3986 reserved characters without allowing
URI query/fragment ambiguity. `resources/read` re-applies the allowlist before
returning the PDF as an `application/pdf` blob. Schema-valid string URIs that
do not match a supported resource form return `-32602`; missing or
expected-permission-unavailable resources return `-32602`. Inputs rejected by
the SDK before the handler runs can use the SDK's own protocol-error mapping.
Genuine filesystem/runtime faults remain `-32603` instead of being mislabeled
as a missing resource.

The finite tools, prompts, and resource lists do not issue pagination cursors.
Supplying a schema-valid string cursor therefore returns `-32602` instead of
silently restarting at the first page. Inputs rejected by the SDK schema before
the handler runs can use the SDK's own protocol-error mapping.

## Verification

Run the deterministic source and staged-share-files contract suite:

```bash
npm test -- --run test/mcp-contract.test.js
```

The suite verifies initialization, tool declarations and annotations, explicit
generic-client behavior for the app-intended byte tool, prompt
listing/rendering/injection boundaries/error behavior, cursor rejection,
static and reserved-character dynamic resource reads, representative structured
content with a text fallback, and unsupported resource-template discovery. It
also requires all committed share runtime modules and the single-file viewer to
be byte-identical to their source counterparts. The regular suite stages share
files under a temporary root with an explicit dependency fixture; it catches
missing package files and source/share drift, but is not the clean-install proof.

Prove that the share manifest resolves and installs without any parent checkout:

```bash
npm run test:contract:share
```

This gate runs the real share packager, extracts its ZIP into a clean temporary
root, generates a dependency lock from only that archive, recreates it with
`npm ci --omit=dev`, and exercises discovery, app-tool compatibility, cursor
errors, and a dynamic PDF resource round trip.

For an exact release candidate, also verify the packed projection:

```bash
npm run build:mcpb
npm run smoke:mcpb -- pdf-toolkit-mcp.mcpb
```

The packed smoke runs the extracted archive itself and covers discovery,
prompt argument boundaries, cursor errors, both resource kinds, generic-client
app-tool behavior, tool error signaling, and native rasterization.

Finally install that exact artifact in the current Claude Desktop host and use
a fresh synthetic chat to confirm prompt visibility, one prompt invocation, one
normal tool call, and viewer rendering. The local stdio contract suite proves
protocol behavior, not host-specific catalog presentation.
