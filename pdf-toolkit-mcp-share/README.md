# PDF Tools MCP Server - Quick Setup

Work with PDFs in Cursor using local file operations: view, fill, merge, split,
rotate, reorder, render, and extract data without a separate PDF upload service.

PDF Tools reads, renders, edits, and saves files locally. Text, images, and
metadata it returns may be processed by Cursor's MCP host or selected model
under that provider's data terms, so the complete workflow is not necessarily
zero egress.

## Installation Methods

### 🖱️ **Option 1: Double-Click Install** (Easiest - Mac only)
Just **double-click `install.command`** - that's it!
- Opens Terminal automatically
- Stages and installs everything at `~/.pdf-tools-mcp`
- Keeps the current working installation if dependency installation fails
- Rolls back the current installation if activation fails
- Can auto-update your Cursor config
- **Safe to delete Downloads** after install
- No Terminal knowledge needed

### 🚀 **Option 2: Smart Terminal Install** (macOS/Linux)
```bash
./smart-install.sh
```
- Most powerful option
- Auto-detects paths
- Can automatically update your mcp.json
- Handles all edge cases

### 🛠️ **Option 3: Manual Install** (Fallback)
```bash
./install.sh
```
- Shows exact paths to copy
- Manual but foolproof
- For when auto-install doesn't work

## What You Need
- **Node.js** installed (`^20.19.0` or `>=22.12.0`) - Get it at [nodejs.org](https://nodejs.org)
- **Cursor** with MCP support

The package includes the maintainer-reviewed `package-lock.json`. Every bundled
installer uses `npm ci --omit=dev --engine-strict`, so an install fails instead
of silently resolving a newer dependency graph.

`SBOM.cdx.json` is a deterministic CycloneDX 1.6 inventory of the complete
locked production graph plus the native components of the bundled QPDF
WebAssembly runtime, each derived from its own pinned record.

Every component states its licence terms. For npm packages the terms are the
ones the package declares about itself, read out of the exact registry tarball
the lockfile pins and marked `acknowledgement: "declared"`. A declaration the
pinned SPDX licence list recognises is reported as a `license.id`; a compound
declaration keeps its own operators as an SPDX `expression`, so a dual licence
is never reduced to one half; anything else is reported as a `license.name`,
which asserts nothing about SPDX. A package that declares no licence at all
says `NOASSERTION` explicitly and carries a property saying what was looked for.
Licence text that ships without naming an identifier is pointed at and hashed,
never read and guessed at.

`SHARE-PROVENANCE.json` binds the lockfile, SBOM, and
packaged source files to SHA-256 digests. The SBOM is structurally and
lock-coverage validated during packaging; this is not a claim of validation by
an external CycloneDX schema validator.

All installers use the included Node-based JSON serializer for Cursor config
output; Python is not required. Paths are passed as process arguments, so
spaces, quotes, apostrophes, and backslashes are encoded as data rather than
executable code.

### Windows

The bundled click/terminal helpers are Bash scripts. In PowerShell, open this
directory and run:

```powershell
npm ci --omit=dev --engine-strict --no-audit --no-fund
```

Then add the absolute `server/index.js` path to Cursor's `mcp.json` using the
same JSON shown by `install.sh`. Native Windows installation remains a release
host gate; a Linux-only smoke run does not establish Windows compatibility.

## 🗂️ **Installation Location**
- **Double-click/smart installers**: Always stage and atomically activate at `~/.pdf-tools-mcp`
- **Manual installer**: Installs in the extracted package directory
- **Safe cleanup**: Can delete original files after install

## After Installation
1. **Completely quit Cursor** (Cmd+Q on Mac, Alt+F4 on Windows)
2. **Restart Cursor**
3. **Look for "pdf-tools"** in MCP servers
4. **Toggle it on** if needed

## Usage Examples
Once installed, ask Claude in Cursor:
- *"Read the form fields in this PDF file"*
- *"Fill this W-9 form with my business information"* 
- *"List the PDFs in my Documents folder"*
- *"Create a profile with my personal info for future forms"*
- *"Fill 50 PDFs using data from this spreadsheet"*
- *"Read the content of this PDF document"*
- *"Render page 1 of this scanned invoice so you can inspect it visually"*
- *"Compare these two contract versions and cite every material change in both files"*
- *"Merge these contracts and show me the result"*
- *"Split this report every 10 pages"*
- *"Rotate page 3 by 90 degrees"*

## Tools Available
This page names a selection, not the whole surface: the server registers 64
tools. The root `README.md` lists every one, and `docs/OUTPUT_SCHEMAS.md`
carries their structured output contracts.

- **display_pdf** - Interactive PDF viewer with search and form sidebar
- **list_pdfs** - List PDF files in directories
- **read_pdf_fields** - Read form fields from PDFs
- **fill_pdf** - Fill PDF forms with data
- **bulk_fill_from_csv** - Fill multiple PDFs from CSV data
- **save_profile** / **load_profile** - Save/load common form data
- **fill_with_profile** - Fill PDFs using saved profiles
- **extract_to_csv** - Export PDF data to spreadsheets
- **validate_pdf** - Inspect value coverage and actual PDF Required flags without claiming submission readiness
- **read_pdf_content** - Read the PDF.js text layer; a wholly textless selected extraction may return only page 1 as an image for host/model vision
- **read_pdf_pages** - Read a bounded page range with page-numbered structured output
- **read_pdf_layout** - Extract bounded local text geometry and conservative reading order without OCR or table inference
- **convert_pdf_to_markdown** - Convert supported PDF text to deterministic Markdown with explicit partial and unsupported-content gaps. Reconstructs a table only when every row fills every recurring column and the first row carries real header evidence, and emits a link only for a source-validated external http or https target. Unsupported table structures and link targets stay escaped text reported as a typed gap.
- **render_pdf_page** - Render a source-bound PDF.js page view with distinct raw geometry, view geometry, renderer policy, and digest evidence
- **render_pdf_region** - Render a bounded PDF.js viewport region; these inputs are not MediaBox-relative signing coordinates
- **prepare_signing_packet** - Prepare an exact local PDF and provider-neutral handoff receipt
- **start_lumin_authorization** / **finish_lumin_authorization** - Connect a Lumin account with browser-based PKCE and keep the token only in memory
- **prepare_lumin_request** - Preview the exact document, recipients, disclosure, and confirmation locally
- **send_lumin_request** - Send once only after fresh verbatim user confirmation, with no automatic retry
- **check_lumin_status** / **download_lumin_artifact** - Poll an existing request and save an artifact without exposing its temporary signed URL
- **search_pdf_text** - Search extracted PDF text and return page-numbered snippets
- **merge_pdfs** / **split_pdf** - Combine and split documents
- **rotate_pdf_pages** / **reorder_pdf_pages** - Organize scanned or shuffled pages
- **get_pdf_identity** - Bind plans and provenance to the canonical path, byte length, and SHA-256 for a PDF up to 250 MiB without parsing its document structure
- **get_pdf_info** - Observe bounded source-bound page geometry, metadata, form widgets, and inert ordinary annotations with explicit coverage
- **compare_pdfs** - Compare two immutable PDFs (up to 20 pages each) across seven typed channels with page alignment, source-bound evidence, and reversible material/noise decisions; it never claims document equivalence
- **get_page_analysis** - Inspect blank detection, orientation, and page-content routing
- **create_extraction_workspace** / **read_extraction_workspace** - Create and page through a private PDF-and-schema-bound extraction workspace
- **read_extraction_chunk** - Rebuild one returned chunk from fresh source bytes
- **submit_extraction_proposal** / **verify_extraction_proposal** - Retain an untrusted leaf proposal, then deterministically replay its exact citations without a model inside PDF Tools

Lumin signing is optional and external. The prepared PDF plus listed names and
email addresses leave the device only after the send confirmation. PDF Tools
checks the exact text and time, while the host and agent remain responsible for
passing only what the user actually confirmed. Configure a public OAuth client
ID with `LUMIN_OAUTH_CLIENT_ID` or
`luminOAuthClientId` in the plugin's private `config.json`, registered for
`http://127.0.0.1/callback`. Access tokens stay only in the running process.
Creation is one-shot with no automatic retry, status uses polling, and existing
download files are never replaced. The public Lumin workflow currently supports
macOS and Linux and fails closed on Windows before OAuth or signing state begins.

### Current Extraction Boundary

PDF Tools does not currently bundle an OCR engine. `read_pdf_content` reads the
PDF.js text layer. Only when the entire selected extraction contains no text may
it return a rendered image of page 1 for a vision-capable host or model to
inspect. `render_pdf_page` and `render_pdf_region` produce raster images, not
recognized text. Mixed text/raster documents and raster pages after page 1 can
therefore remain unrecognized by a broad text read. Optional local OCR remains
planned rather than shipped.

## Troubleshooting
- **Node.js not found?** Install from [nodejs.org](https://nodejs.org)
- **Tools not appearing?** Try restarting Cursor completely
- **Permission denied?** Run `chmod +x *.sh` in the folder
- **Path issues?** The install scripts auto-detect the correct path
- **Existing Cursor settings?** Automatic setup preserves other JSON keys and creates a backup before updating
- **Broke after cleaning Downloads?** The installer prevents this!

## What This Does
This MCP server lets Claude directly:
- View PDFs interactively with search, zoom, and navigation
- Read PDF form fields and fill out forms programmatically
- Save common data as reusable profiles
- Process multiple PDFs from spreadsheet data
- Validate forms for completeness
- Merge, split, rotate, and reorder pages
- Extract and analyze full PDF content
- Render scanned PDF pages or regions for visual inspection

Perfect for W-9s, job applications, contracts, invoices, research papers, and general PDF processing.

## Third-party notices
This bundle carries a vendored QPDF WebAssembly runtime at
`vendor/qpdf-wasm/runtime/`. It decrypts password-protected documents for the
tools that read and write them. qpdf is Apache-2.0, and the complete notice set
(qpdf, zlib, libjpeg-turbo, the Emscripten generated runtime, musl,
compiler-rt, libc++, libc++abi and libunwind) is in
`vendor/qpdf-wasm/runtime/licenses/`,
bound to its SHA-256 hashes by that directory's `manifest.json`. Keep the
directory intact if you redistribute this bundle. The npm dependencies keep
their own licences inside `node_modules/` after installation, and
`SBOM.cdx.json` inventories both: the locked npm packages, and a component for
each of those native pieces hung off the WebAssembly runtime that ships them.
The Emscripten image that compiled the runtime is recorded there as build
tooling rather than as a shipped component, because it is not inside the
artifact.
