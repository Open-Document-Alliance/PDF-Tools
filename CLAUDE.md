# PDF Toolkit MCP - Development Guide

## Active Kepano / Shannon Work

Before continuing the current extraction-improvement tranche, read
`docs/handoffs/KEPANO_SHANNON.md`. The crucial starting fact is that Kepano's
example is Shannon's *A Mathematical Theory of Communication* PDF; it is not a
separate example to locate.

This document provides essential context for Claude and other AI assistants when working on the PDF Toolkit extension.

## Project Overview

PDF Toolkit is a Claude Desktop extension (MCPB) and MCP server that enables automated PDF form filling, bulk processing, and data extraction. Published in the official Claude Desktop Extension Directory.

### Key Features
- List PDF files in directories
- Read form fields from PDFs (text, checkboxes, dropdowns, radio buttons)
- Fill PDF forms programmatically
- Save filled PDFs to new files
- Password-protected PDFs: read through PDF.js or qpdf, and changed through qpdf with the document's own protection restored on save (see `## Password Support`)
- Bulk fill from CSV files
- Profile system for reusable data
- Extract data from PDFs to CSV
- Form validation
- PDF.js text-layer extraction and page/region rendering for visual inspection

## Technical Architecture

### Technology Stack
- **Runtime**: Node.js (ES modules)
- **PDF Libraries**: pdf-lib, pdfjs-dist
- **Raster Rendering**: @napi-rs/canvas
- **Protocol**: MCP (Model Context Protocol)
- **Extension Format**: MCPB (built via `mcpb pack`)

### Important Files
- `server/index.js` - Main MCP server implementation (all tool definitions and helpers). Prefer incremental updates over rewrites.
- `manifest.json` - Claude Desktop extension metadata and UI stub. Update versions alongside package.json.
- `manifest.mcpb.json` - MCPB packaging manifest
- `package.json` - Node.js dependencies
- `pdf-toolkit-mcp-share/` - Shareable package for Cursor users. Mirror changes from server/index.js when APIs evolve.
- `example-fw9.pdf` - Sample form for smoke tests. Keep anonymized assets only.
- `docs/MAINTAINERS.md` - Maintainer onboarding and operations
- `docs/RELEASE.md` - Release checklist
- `server/qpdf-decrypt.js` - The only path by which PDF Tools decrypts. Owns the
  password rules, the `/P` permission enforcement, the encrypted-input size cap,
  the one-at-a-time queue, and the 30-second deadline. It does not run qpdf
  itself. It also owns re-protection: restoring a source's own encryption onto
  the bytes a mutation produced, and proving the protection is unchanged before
  anything is written. See `## Password Support`.
- `server/qpdf-decrypt-worker.js` - The worker thread that does. The only module
  that loads the qpdf runtime, and never on the server's own thread. Decides
  nothing: it runs the qpdf passes the wrapper asks for and reports opaque
  reason codes.
- `vendor/qpdf-wasm/` - Reproducible QPDF WebAssembly build recipe. The
  promoted artifact under `vendor/qpdf-wasm/runtime/` is shipped in both the
  MCPB and the share ZIP at that same path, and is loaded by **exactly one
  module**, `server/qpdf-decrypt-worker.js`, which is started from exactly one
  place, `server/qpdf-decrypt.js` — a second importer, or a second starter,
  would bypass the safety rules and fails the artifact test. Do not
  hand-edit `runtime/` or `runtime.provenance.json`; regenerate them with
  `node scripts/vendor-qpdf-wasm-runtime.mjs <extracted-build-directory>`.
  `npm run qpdf-wasm:verify` is a ~45-minute Docker release gate and must stay
  out of `npm test`; the fast binding lives in
  `test/qpdf-wasm-runtime-artifact.test.js`.

## Module Format: ESM

The project uses ES modules (`"type": "module"` in package.json):
- Use `import`/`export` syntax
- Dynamic `await import()` for lazy-loaded dependencies (pdfjs-dist, @napi-rs/canvas)
- The MCP SDK, MCPB runtime, and Claude Desktop all support ESM

## Password Support

**pdf-lib does not decrypt. PDF.js does, and the qpdf runtime now does for both
the read-only tools and the write tools.** `pdf-lib` 1.17.1 ships no decryption
of any kind: `PDFDocument.load` has no `password` option, it throws
`EncryptedPDFError` on an encrypted document, and `{ ignoreEncryption: true }`
returns an unusable document that fails on the first page access. `pdfjs-dist`
5.4.624 does accept `{ password }` and opens the same document correctly.

`read_pdf_fields`, `validate_pdf`, and `extract_to_csv` decrypt through the
vendored qpdf WebAssembly runtime before handing plaintext to pdf-lib. They only
ever read: none writes a PDF back. Decrypted bytes stay in memory and are never
written to disk.

**The mutation tools decrypt too, and put the protection back.** Every tool in
`PDF_LIB_MUTATION_TOOL_NAMES` decrypts its source, lets pdf-lib change the
plaintext, and then restores the source's own encryption with qpdf's
`--copy-encryption` before anything is written. That reproduces `/O`, `/OE`,
`/U`, `/UE`, `/P`, `/R`, `/V`, `/ID` and the crypt filters verbatim, including
an owner password the process never learned, and the result is verified against
the source's protection before it is staged. Two rules follow:

- **Protection in, protection out.** There is no `remove_password` or
  `output_encryption` parameter, and no default to argue about. A document that
  cannot be faithfully re-protected fails the operation; nothing ever writes a
  decrypted copy of an encrypted document.
- **A denied `/P` needs the owner password.** If the document's permissions deny
  what the operation does, only the owner password authorises it — the user
  password proves you may open the document, not that you may override its
  owner. Each tool requires the bit matching what it does: `modifyforms` to fill
  a form, `modifyassembly` for page manipulation, `modify` for stamping (which
  draws into the page content stream, so it is bit 4 and not the annotation
  bit). See `ENCRYPTED_WRITE_OPERATIONS` in `server/qpdf-decrypt.js`. This is
  the *write* rule; reads do not consult `/P` at all (see below).

`merge_pdfs` refuses unless every source carries byte-identical protection,
because N sources with different or absent encryption make "the source's
encryption" undefined. The refusal names both routes that work — sources whose
`/Encrypt` dictionary really is one dictionary (copies of one protected
document, or the parts `split_pdf` made of it), or unprotected copies the
caller re-protects afterwards — and names the trap, because encrypting two
documents in two qpdf runs with one password does *not* produce one protection:
`/O` and `/U` mix in per-run material (a random salt at `/R` 6, the document's
own `/ID` at `/R` 4 and below).

All three phases run inside the isolated pdf-lib child, with qpdf on its own
worker thread. That placement is forced: the child stages its output to disk, so
protection has to be restored before staging, and decrypting in the same process
then keeps plaintext from crossing any process boundary.

**Decryption runs on a worker thread, never on the server's.** qpdf-wasm's
`callMain` is synchronous and cannot be interrupted by the thread that called
it, so an in-process `setTimeout` deadline could not fire until the work it was
meant to bound had already finished. Since the size cap bounds *bytes* while
qpdf's cost tracks *objects*, a lawful 14.3 MiB encrypted document built from
800,000 tiny objects spends over five seconds inside one `callMain` — and
nothing bounds object count. `server/qpdf-decrypt.js` therefore starts
`server/qpdf-decrypt-worker.js` per request and destroys it with
`worker.terminate()`, which is the only thing that actually stops WebAssembly
mid-flight. Measured: deadlines of 100 ms, 250 ms, 1 s, 2.5 s and 4 s against
that document each land within ~60 ms of themselves, and the process then burns
under 1 ms of further CPU over the next 2 seconds — against the 4 seconds of CPU
the same decrypt costs when it is allowed to finish.

**Deadline: 30 seconds**, matching `DEFAULT_TIMEOUT_MS` in
`server/pdf-lib-subprocess.js`. It bounds how long a hostile document may hold
the decryption queue and a core, not how long the server is unresponsive — the
server's thread is free throughout. Plaintext crosses no new boundary: the
worker is a thread in the same process and hands the decrypted bytes over
through `postMessage`'s transfer list, which moves ownership of the same pages
rather than serializing them. Handing plaintext *between* the server and the
pdf-lib child would have forced it through a pipe or a staged file, which is
exactly what the design avoids — so a mutation runs all three phases (decrypt,
change, re-protect) inside the child, with the qpdf worker started there.

Isolation costs a roughly constant **45-65 ms per decryption** — worker start,
a fresh runtime instantiation, and the message round trip. Measured on
macOS/arm64: an 84 KB document goes from 32 ms to 81 ms, a 1 MB one from 68 ms
to 110 ms, and a 14.6 MiB one from 671 ms to 734 ms. Back-to-back decryptions
pay an extra ~55 ms because the queue is held until the previous worker is gone,
which is deliberate: one qpdf heap at a time is what the size cap assumes.
Isolation does **not** improve the memory picture; see the size-cap note below.

**The scope rule.** Decryption is not a "remove the password" facility:

- Correct password supplied → decrypt and proceed.
- Wrong password supplied → fail, saying the password was not accepted. The
  empty string counts as *no password*, so it cannot be used to claim
  credentialed access to a document whose user password is empty. A password
  containing a line break is refused outright: it cannot be represented in the
  single-line password file that keeps passwords off the command line.
- **No password supplied, document opens with an empty user password** (the
  owner-locked shape: opens freely, `/P` denies modification) → the *read*
  proceeds; a *write* proceeds only if `/P` grants the bit it needs. qpdf can
  decrypt, edit, and re-lock such a document with identical `/P` and `/R` and no
  password at all, and PDF Tools must not become a tool for that — which is what
  the write rule and "protection in, protection out" prevent.
- Not encrypted → unchanged. pdf-lib is tried first, so no qpdf module is
  instantiated and there is no measurable cost.

**`/P` governs writes. It does not govern reads.** That is one rule, stated once
in `pdfPermissionRefusal` in `server/qpdf-decrypt.js`, which is the only
function in `server/` that reads `encryption.capabilities`. The read tools once
required `/P` bit 5 (`extract`); the requirement was removed because it could
not be applied to the family it belonged to. It only ever bound the three qpdf-
backed reads, while every PDF.js-backed sibling — `read_pdf_content`,
`read_pdf_layout`, `convert_pdf_to_markdown`, `render_pdf_page` and the rest —
returned the same content regardless, PDF.js having no `/P` implementation at
all. Extending it uniformly would have meant refusing `read_pdf_bytes`,
`get_pdf_resource_uri` and `display_pdf`, which is refusing to show the user
their own document; no reader on the market does that. And it cannot bite in any
case: `/P` bit 10 (`accessibility`) is deprecated-and-required by ISO 32000-2,
and qpdf cannot even produce an R4 or R6 document that denies it, so on anything
encrypted with AES an owner who denies `extract` has granted extraction for
accessibility in the same breath. The full argument is in the module header;
`test/pdf-read-permission-consistency.test.js` pins the uniformity so a new read
tool cannot join the family with different behaviour.

**Size cap.** Encrypted inputs are capped at **16 MiB**, separate from and far
below the 250 MiB `PDF_MUTATION_MAX_FILE_BYTES`. Decryption costs roughly
`16 x input + 45 MB` of peak RSS, so 16 MiB keeps a full read inside the
1024 MiB the project already treats as too much. Oversized input gets a clear
size message rather than an out-of-memory kill.

**Do not raise the cap on the strength of worker isolation.** The hypothesis
that a terminated worker would reclaim the WebAssembly heap where in-process GC
could not does not survive measurement on macOS/arm64. After one 14.6 MiB
decrypt and a forced-GC settle, the in-process arrangement retains ~190 MB over
baseline and the worker arrangement retains ~260 MB: terminating the thread
returns *less* to the OS than collecting the module did, because the freed pages
stay mapped. Neither arrangement accumulates — eight consecutive near-cap
decrypts plateau at ~370 MB in-process and ~350 MB in workers rather than
summing — so a per-file cap is still sufficient and `extract_to_csv` still needs
no aggregate bound. What the cap is derived from is the *peak* of a single
decrypt, which isolation leaves essentially unchanged (~315 MB in a worker
versus ~333 MB in-process), so there is no measurement here that licenses a
larger number.

Measured against an AES-256 PDF produced with
`qpdf --encrypt --user-password=secret --owner-password=secret --bits=256`:

| Tool | PDF reader | Password support |
| --- | --- | --- |
| `read_pdf_layout` | PDF.js | Real. Succeeds; reports a `RAW_PAGE_GEOMETRY_UNAVAILABLE` gap because raw geometry comes from pdf-lib. |
| `convert_pdf_to_markdown` | PDF.js | Real. Same partial-coverage gap. |
| `get_pdf_info` | PDF.js | Real. Same partial-coverage gap. |
| `read_pdf_fields` | qpdf + pdf-lib | **Real.** Decrypts with the password; without one, reads only if `/P` allows `extract`. 16 MiB cap. |
| `fill_pdf` | qpdf + pdf-lib | **Real.** Decrypts, fills, and restores the document's own encryption. Needs `modifyforms`, or the owner password. 16 MiB cap. |
| `bulk_fill_from_csv` | qpdf + pdf-lib | **Real.** Same rule as `fill_pdf`; every output is re-protected. |
| `fill_with_profile` | qpdf + pdf-lib | **Real.** Same rule as `fill_pdf`. |
| `validate_pdf` | qpdf + pdf-lib | **Real.** Same rule and cap as `read_pdf_fields`. |
| `merge_pdfs`, `split_pdf`, `rotate_pdf_pages`, `reorder_pdf_pages`, `apply_page_plan` | qpdf + pdf-lib worker | **Real.** Need `modifyassembly`, or the owner password. `merge_pdfs` additionally refuses unless every source is protected identically. |
| `add_signature_field`, `apply_signature`, `prepare_signing_packet`, `apply_text` | qpdf + pdf-lib worker | **Real.** Need `modify` (they draw into the page content stream); `prepare_signing_packet` needs `modifyforms` as well. |
| `render_pdf_page`, `render_pdf_region`, `get_page_analysis` | PDF.js plus pdf-lib geometry | None in practice. PDF.js uses the password, but the pdf-lib geometry load still fails. |
| `detect_signature_zones` | PDF.js plus pdf-lib geometry | None in practice. It degrades through `ignoreEncryption` and succeeds only on the committed header-malformed R4 oracle; a well-formed AES-128 or AES-256 file fails. |
| `compare_pdfs` | PDF.js plus pdf-lib geometry | None, and it now says so once. Any encrypted input is refused as `PDF_ENCRYPTED_COMPARISON_UNSUPPORTED`, naming which side, whatever the passwords and `include_visual` say. It used to answer three different ways: "requires its password", the pdf-lib limit, or `internal_validation_error` when `include_visual` was false. |
| `extract_to_csv` | qpdf + pdf-lib | **Partial.** No `password` parameter (one password cannot serve a list of documents), so it reads an encrypted document only when that document opens without a password and its `/P` allows `extract`. |
| `read_pdf_content`, `read_pdf_pages`, `search_pdf_text` | PDF.js | None reachable. No `password` parameter exists, so an encrypted PDF cannot be opened. |
| `inspect_pdf_accessibility` | pdf-lib | None, and it says so: it rejects a `password` argument outright. |

Pass the optional `password` parameter to `read_pdf_layout`,
`convert_pdf_to_markdown`, `get_pdf_info`, `read_pdf_fields`, and
`validate_pdf`. For anything else, decrypt the document first (for example with
`qpdf --decrypt`) and operate on the plaintext copy. Adding decryption to the
**write** paths is a separate, harder problem: a write path must re-encrypt to
preserve the source's protection, which is exactly the capability the scope
rule above withholds. It remains an open decision, not a bug fix.

## XFA Forms

**pdf-lib cannot write XFA, so every mutation drops that layer.** What the loss
costs depends on the document, and the guard now distinguishes the two cases
instead of treating them alike.

- **Static XFA** keeps its values in the AcroForm. The current IRS W-9 is this
  shape. Filling it produces a correct document, so the mutation proceeds and
  the result carries `XFA_STATIC_NOTICE` saying the layer was removed. No flag
  is needed, and requiring one would break an ordinary job to prevent nothing.
- **Dynamic XFA** (`/NeedsRendering true`) builds its pages from that layer, so
  dropping it can leave a reader showing a placeholder. This is refused, and
  `force_xfa: true` is the acknowledgement that overrides it.
- **No XFA**: unchanged, `assertXfaMutationAllowed` returns null.

`detectXfaForm` scans raw bytes first, then Flate-compressed object streams,
because a document with a compressed cross-reference table keeps its catalog,
and therefore `/XFA`, where a byte scan cannot see it. That second pass is
bounded (8 MB inflated in total, 2 MB per stream) so it cannot be turned into a
decompression bomb. Before it existed the guard was blind to exactly the
documents it was written for, and `force_xfa` was unreachable for them: see
issue #200 and `test/xfa-compressed-catalog.test.js`.

The tool contract is pinned twice, so rewording a description fails two tests
until both are updated deliberately: `TOOL_CONTRACT_SHA256` in
`test/mcp-contract.test.js`, which wants a dated note, and the byte-for-byte
capture at `test/fixtures/eval/trajectories/tool-contracts.v3.json`, which is
regenerated with `node scripts/eval-capture-tool-contracts.mjs`.

## Development Commands

### Build and Package
```bash
# Install dependencies
npm install

# Run MCP server locally (for testing with Claude Desktop or Cursor)
node server/index.js

# Build and inspect a platform-complete MCPB for Claude Desktop
npm run build:mcpb

# Create shareable package for Cursor
node package-for-friend.js
```

### Testing
Run focused Vitest checks with `npm test -- <paths>`. Run
`npm run test:node-native` for the explicit platform partition of native
Node suites, and use the unfiltered `npm run test:all` aggregate for release
qualification. Then perform manual host runs against `example-fw9.pdf`:
1. `list_pdfs` against a local directory
2. `read_pdf_fields` on example-fw9.pdf
3. `fill_pdf` with test data
4. Profile flow: `save_profile`, `load_profile`, `fill_with_profile`
5. `bulk_fill_from_csv` with a two-row CSV (include a comma in one value)
6. `extract_to_csv` on two PDFs
7. `validate_pdf` on a partially filled form
8. `read_pdf_content` on a text-layer PDF and a textless scanned PDF, confirming the page-1 image fallback boundary

## Core Available Tools (selected; 1 app-only)

1. **display_pdf** - Interactive PDF viewer with search, navigation, zoom, and form field sidebar
2. **list_pdfs** - Lists PDF files in a directory
3. **read_pdf_fields** - Extracts form field information (opens viewer with form sidebar)
4. **fill_pdf** - Fills a PDF form with data
5. **bulk_fill_from_csv** - Fill multiple PDFs from CSV
6. **save_profile** - Save form data as reusable profile
7. **load_profile** - Load a saved profile
8. **list_profiles** - List all saved profiles
9. **fill_with_profile** - Fill PDF using saved profile
10. **extract_to_csv** - Extract data from PDFs to CSV
11. **validate_pdf** - Check for missing required fields
12. **read_pdf_content** - Read the PDF.js text layer; if the selected extraction contains no text, it may return a rendered page-1 image for host/model vision
13. **read_pdf_layout** - Extract bounded local text geometry and conservative reading order without OCR or table inference
14. **convert_pdf_to_markdown** - Convert a bounded supported text-layer range to deterministic Markdown with explicit coverage gaps, including evidence-backed tables and source-validated external http or https links
15. **get_pdf_resource_uri** - Get resource URI for a PDF file
16. **read_pdf_bytes** - (app-only) Chunked byte streaming for the interactive viewer
17. **merge_pdfs** - Merge multiple PDFs into a single document
18. **split_pdf** - Split a PDF by page ranges or at regular intervals
19. **rotate_pdf_pages** - Rotate pages by 90, 180, or 270 degrees
20. **reorder_pdf_pages** - Rearrange the pages of a PDF into a new order
21. **get_pdf_info** - Get source-bound page geometry, bounded metadata, form widgets, and inert ordinary annotations with explicit coverage
22. **inspect_pdf_accessibility** - Inspect exactly eight shallow catalog-level accessibility signals with source binding, bounded abstention, and required human review
23. **compare_pdfs** - Compare two immutable PDFs across semantic, text, structure, form, annotation, metadata, and visual channels with source-bound evidence
24. **apply_page_plan** - Reorder, rotate, and delete pages in one pass (saves as new file)
25. **get_page_analysis** - Analyze pages for blank detection, orientation, text content, images
26. **fetch_pdf_from_url** - Download a PDF from a URL to the user's local machine (bypasses Claude's WebFetch sandbox)
27. **create_signature** - Save a reusable typed or image signature
28. **list_signatures** - List saved signatures
29. **add_signature_field** - Draw a "Sign here" placeholder box (does NOT sign)
30. **apply_signature** - Stamp a saved signature at a location (requires explicit human intent; see Signature Architecture below)
31. **prepare_signing_packet** - Fill form + add sign-here boxes in one pass
32. **detect_signature_zones** - Locate signature, initials, printed-name, and date zones with coordinates. Use apply_signature for signatures and initials, and apply_text for names and dates.
33. **get_allowed_directories** - Report the folders this server may reach, which configuration layer supplied them, and where the stored config file lives. Read-only; it cannot change the boundary.
34. **create_extraction_workspace** - Create a private exact PDF-and-schema-bound extraction workspace
35. **read_extraction_workspace** - Page through returned chunks, pending leaves, proposals, results, or events
36. **read_extraction_chunk** - Rebuild one returned chunk from fresh PDF bytes
37. **submit_extraction_proposal** - Retain one explicitly unverified cited leaf proposal
38. **verify_extraction_proposal** - Replay citations deterministically and retain the typed result without a model inside PDF Tools

### Current Extraction Boundary

The local runtime does not bundle an OCR engine. `read_pdf_content` reads the
PDF.js text layer. Only when the entire selected extraction contains no text may
it return a rendered image of page 1 for a vision-capable host or model to
inspect. `render_pdf_page` and `render_pdf_region` perform local rasterization;
they do not produce recognized text. Mixed text/raster documents still include
later raster pages whose scanned content no broad text read recognizes; the
routing metadata identifies those pages without recognizing their text, so
they are no longer silent: `read_pdf_content` reports
`read_pages_without_text` (scoped to pages actually read),
`get_page_analysis` reports a `classification` rollup with typed
`pages_needing_vision` reasons and an explicit `pages_not_analyzed` scope,
and `convert_pdf_to_markdown` embeds the same routing metadata. All of
these surfaces report statuses and typed reasons, never numeric confidence,
with failed measurements surfacing as unavailable rather than fabricated
zeros.

`get_pdf_info` binds every observation to the race-aware source SHA-256 and
keeps page, metadata, form-widget, and ordinary-annotation coverage separate.
Annotation URLs, destinations, and actions are never opened. Render results
report the source identity, page geometry, coordinate spaces, renderer policy,
PNG digest, and native raw-pixel digest availability.

`inspect_pdf_accessibility` reads an unencrypted PDF without editing it and
reports exactly eight shallow catalog-level signals as observed, missing, or
unavailable. Machine validation remains `not_run`, human review is required,
and PDF/UA, WCAG, certification, legal, and document-accessibility conclusions
remain `not_established`.

`render_pdf_region` uses top-left PDF.js viewport points after CropBox,
rotation, and UserUnit. Do not pass MediaBox-relative signature-zone or signing
coordinates to it. The macOS Quick Look fallback renders whole pages and
regions in that same PDF.js view, including nonzero origins, rotated CropBoxes,
and UserUnit scaling, while reporting raw pixels unavailable.

`compare_pdfs` reads both inputs through immutable source descriptors, refuses
documents over 20 pages instead of comparing prefixes, refuses an encrypted
input outright — pdf-lib supplies its raw page geometry and its page renderer,
and cannot decrypt, so no password helps — and reports typed coverage for
semantic, text, structure, form-field, annotation, metadata, and visual
channels. Its coverage vocabulary is derived from the document-observation
vocabulary in `server/pdf-observations.js` rather than restated, because a
reason present in one and missing from the other used to surface as
`internal_validation_error`. Ambiguous repeated pages remain unresolved. The default mode
may suppress reversible metadata or visual noise, while forensic mode reports
it; neither mode claims that no reported changes proves document equivalence.

`convert_pdf_to_markdown` consumes the bounded source-validated layout IR
(v1.3.0, which carries CTM-tracked ruled-rectangle evidence, text-integrity
character-class signals, and operator counts, all independently replayed
against a second parse). It reconstructs a table from recurring column
geometry, or from clean ruled-rectangle grid evidence when every rect aligns
to exactly one cell, every text item lands in exactly one cell, and the first
row carries header evidence (typographic or a non-recurring first-row band);
it may also use a complete closed grid of bounded axis-aligned solid-mask
rectangles when every text item fits exactly one cell and independent caption
and header evidence are present;
overlapping grids, body-row bands, aligned partial dividers that evidence
merged or spanning cells, ambiguous assignments, and line-segment-only rulings
all abandon with typed gaps
(`TABLE_TOPOLOGY_UNKNOWN`, `TABLE_RULING_UNSUPPORTED`). A text layer that is
present but suspect (replacement-character, private-use, or C1-control
density) is flagged with `TEXT_INTEGRITY_SUSPECT` and routed to vision while
the extracted text is still emitted verbatim. An opt-in `compact` mode applies
three declared, counted normalizations (dot-leader collapse, isolated
page-number removal, spaced-hyphen joining) with tables and link lines exempt;
default output is byte-identical to non-compact behavior. Links are emitted
only for a source-validated external http or https annotation target that maps
to exactly one contiguous run of text on one line; internal destinations,
actions, other URL schemes, and ambiguous labels stay escaped text. It does
not reconstruct general equations or fraction bars, but may restore
a missing space after a separate `log` source item only in a short, tightly
bounded math run with same-baseline variable evidence plus an independent
local math-layout clue. A glyph run the source painted smaller and displaced
from the baseline of the text it is attached to is written as Unicode
superscript characters when it was raised and Unicode subscript characters when
it was lowered, and only when every character of the run has a real form in
that direction; this records how the page is set, does not distinguish an
exponent from a footnote reference, and does not assert that a lowered digit is
an index. Unicode has no subscript capitals and only some lowercase letters, so
many lowered runs stay flat on coverage alone, and a script the source set
without a font change and without leaving any of its base's advance unused is
reported by the text layer as part of that base run and stays flat too. A small version-pinned registry may recover a legacy
Computer Modern Type-3 character only after exact official-metric, glyph
program, and operator/text sequence checks. It does
not run OCR or use an external model. Unsupported visual or structural content
is reported as typed partial coverage rather than silently represented as
complete Markdown.

PDF Tools performs filesystem operations and rasterization locally and does not
upload files to a separate PDF service. Content returned through MCP can be
processed by the selected host or model under that provider's data terms. A
future local OCR engine is optional planned work, not a current capability.

## Signature Architecture (v0.8.0)

The signature tools implement a **two-tier model** agreed with Max Ferguson on 2026-04-09:

- **Tier 1 (this repo, local, free)**: Visible stamp via pdf-lib. `apply_signature` stamps a saved signature + writes an audit trail to PDF metadata. NOT legally-binding. NOT cryptographic.
- **Tier 2 (optional Lumin API handoff)**: The six `*_lumin_*` workflow tools connect a public PKCE client, preview an exact prepared packet, send one confirmed request without automatic retry, poll status, and download a completed artifact. The PDF and listed recipient details leave the device only at the confirmed send step. Lumin, not PDF Tools, provides the remote signing service and its completion certificate.

**Human-intent constraint** (critical): `apply_signature` requires `user_intent_statement` + `user_confirmed_at` (ISO-8601, within last 24h). This is a legal requirement per Max: *"there's gotta be intent. Having the agent just kind of go and stamp signatures on a document without someone telling it to is not really allowed."* Agents MUST obtain these from the user and never fabricate. The validation enforces length/recency sanity checks; the intent is stored in PDF Keywords metadata for audit.

**Coordinate system**: All signature tools use **top-left origin** (x from left, y from top) in PDF points (72pt = 1 inch). Internally converted to pdf-lib's bottom-left — agents/users never need to think about it.

**Agent-safe vs human-gated split**:
- Agent-safe (no intent check): `create_signature`, `list_signatures`, `add_signature_field`, `prepare_signing_packet`
- Human-gated (requires intent): `apply_signature` and `send_lumin_request`. The
  Lumin send tool validates exact recent confirmation values, but the host and
  agent remain responsible for passing only values the user actually supplied.

## Code Standards

### Coding Style
- 2-space indentation
- `const`/`let` semantics (no `var`)
- Double-quoted strings
- Tool names are snake_case (`list_pdfs`, `fill_pdf`)

### Helper Functions
Reuse existing helpers in `server/index.js`:
- `resolvePath` - Resolve file paths safely
- `fillPdfFields` - Core PDF filling logic
- Profile utilities for save/load operations

### Error Handling
- Provide clear, actionable error messages
- Handle password-protected PDFs gracefully, and never tell a caller to supply a
  password on a path that cannot use one (see `## Password Support`)
- Guide users to correct tools (e.g., "use 'read_pdf_fields' to see available fields")

### Security
- Never log or expose passwords
- Validate file paths to prevent directory traversal
- Use secure defaults for all operations
- Never hard-code personal paths; use `resolvePath` and default directories

## Common Issues & Solutions

### Module not found errors
Ensure ESM syntax is used throughout (`import`/`export`). Check that `package.json` has `"type": "module"`.

### Password-protected PDF errors
Most tools now accept a usable `password`: the PDF.js readers, the three
qpdf-backed read tools, and every mutation tool. Check the table in "Password
Support" above before assuming a tool cannot decrypt — a few still cannot,
because they load page geometry through pdf-lib. If a write is refused with a
named `/P` permission, that is deliberate: supply the owner password, which is
the credential that authorises overriding the document's own restrictions. The
regression guards are `test/encrypted-pdf-password-truth.test.js` and
`test/qpdf-reprotect-write-paths.test.js`.

### MCPB not loading in Claude Desktop
1. Ensure `npm run build:mcpb` and the platform's `npm run smoke:mcpb -- pdf-toolkit-mcp.mcpb` completed successfully
2. Check Claude Desktop logs for errors
3. Verify `manifest.mcpb.json` is valid JSON

### CSV parsing issues
Ensure CSV values with commas are properly quoted. Test with a value containing a comma before publishing.

## Versioning

When releasing, update versions in all places:
- `package.json`
- `manifest.json`
- `manifest.mcpb.json`

Keep versions aligned. See `docs/RELEASE.md` for the full checklist.

## Upstream Dependencies

- MCP spec and org: https://github.com/modelcontextprotocol
- MCPB CLI: https://github.com/modelcontextprotocol/mcpb
- SDK package: `@modelcontextprotocol/sdk`

Watch the MCPB repo for releases and breaking changes.

### pdfjs-dist — PINNED VERSION, DO NOT UPGRADE WITHOUT TESTING

**`pdfjs-dist` is pinned to `5.4.624` (exact, no caret).** Do not upgrade.

The interactive PDF viewer (`display_pdf`) runs inside Claude Desktop's Electron sandbox, which ships an older Chromium. Newer pdfjs-dist versions (5.5+) use ES2025 APIs like `Map.prototype.getOrInsertComputed` (Chrome 134+) that crash the viewer with `TypeError: this[#t].getOrInsertComputed is not a function`. The server-side Node.js code works fine — only the viewer breaks, making the regression invisible until you test in Claude Desktop.

**If upgrading pdfjs-dist:**
1. Grep the new version for ES2025+ APIs: `grep -r "getOrInsertComputed\|sumPrecise" node_modules/pdfjs-dist/build/`
2. Rebuild the UI: `npm run build:ui`
3. Run `npm run build:mcpb` and install the artifact in Claude Desktop
4. Test `display_pdf` on at least one PDF — confirm pages render without errors
5. Check Claude Desktop logs: `~/Library/Logs/Claude/claude.ai-web.log` for `[viewer] Render error`

## Commit & Pull Request Guidelines

### Commit Style
- Use imperative subject style (e.g., "Update index.html to improve structure")
- Group related changes together
- Note version bumps explicitly in commit messages

### Pull Requests
- Include summary of affected tools
- Provide manual test evidence
- Link related issues if applicable
- Only include screenshots when UI assets change

### Artifacts
- Regenerate artifacts (`pdf-toolkit-mcp.zip`, `.mcpb`) in separate commits
- Or attach them to releases rather than merging binaries directly
- Keep version numbers aligned across `package.json`, `manifest.json`, and the share bundle

### Before Committing
- Scrub PDFs or CSVs of personal data before committing
- Use local-only credentials files when testing protected documents
- Never commit sensitive test data

## Contributing

1. Read `docs/MAINTAINERS.md` for architecture details
2. Follow `docs/RELEASE.md` before publishing
3. Use GitHub Issues for bugs and feature requests
4. Include manual test evidence in PRs

## Project Links

- **Repository**: https://github.com/Open-Document-Alliance/PDF-Tools
- **Issues**: https://github.com/Open-Document-Alliance/PDF-Tools/issues
