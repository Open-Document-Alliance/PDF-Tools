# Hosted PDF Tools submission candidate

Status: source preparation on October 6, 2026, not deployed or submitted.
Bead `pdf-toolkit-mcp-lbaw` owns this tranche.

Mat chose a broader PDF Tools offering instead of a forms-only flagship. The
existing hosted service is reused, not replaced with a new stored-document
service. The local product, local package and existing portal draft are preserved.
`plugins/pdf-forms` remains a historical test profile, not the current flagship.

The primary Apps archetype is submission-ready. The existing stateless backend
is adapted directly; a small vanilla MCP Apps output card follows the current
official bridge example instead of importing the full desktop viewer.

## Candidate capability boundary

The server now declares twelve tools: the existing five form/stamp operations
plus `get_pdf_info`, `read_pdf_pages`, `search_pdf_text`,
`convert_pdf_to_markdown`, `select_pdf_pages`, `rotate_pdf_pages` and `merge_pdfs`.
The input descriptor declares OpenAI's complete `file` object contract, with
`download_url`, `file_id`, optional `mime_type` and optional `file_name`.
Merging takes a bounded array of those objects. Actual HTTPS attachment bytes
are fetched through the existing private-network guard, never synthesized.

Reading, search and Markdown conversion reuse the current source-backed
extraction engine. Coverage is explicit, ranges are limited to ten pages,
and image-only or unsupported content is not called complete. No OCR or
full saved Verified Extraction Workspace is added by this adapter.

Page operations return new copies. Selection and merging preserve page
content, not document-level forms, bookmarks or metadata. Detected signature
fields and XFA sources are refused for these mutations; this is not a claim to
detect or validate every possible cryptographic signature.

PDF output is bounded to 3 MB. In `output_mode: "download"`, bytes are carried
only in widget metadata and the model sees their exact identity and size.
The card rehashes those bytes and offers a user-initiated Blob download.
`inline` preserves the existing base64 machine-client contract and is the
backwards-compatible default. The onboarding skill selects download mode for
user-facing copies. The widget makes no new network request and stores no
document. A rendered link is not proof the user received the file.

## Build and qualification

Build with `node scripts/build-hosted-core-plugin.mjs <fresh-output-path>`.
The internal package slug is `pdf-tools-hosted` to preserve the existing local
draft; its user-facing name is PDF Tools. The URL is the existing
`https://mcp.opendocuments.ai/mcp`. The ZIP contains no local command server or
dependencies. Its provenance records the exact source and unaccepted host gate.

Source tests, direct HTTP protocol tests, production deployment, host discovery,
actual attachment input, actual downloaded output, portal upload, and public
review are distinct evidence. Do not upload this candidate while production
still exposes only the previous five-tool surface. No public claim or comparison
with other extraction products follows from these adapter tests.

The inherited public-service network and parser containment limits also need
to remain explicit. The layout's 20-second deadline is cooperative, not an
isolated hard CPU termination boundary. Host native file support and sandbox
download behavior must be measured, not assumed from metadata.

October 6 candidate checks passed 199 focused and adjoining tests on Silverbook
with Node 22.23.2 and one Vitest worker. Independent source review found and
then confirmed fixes for XFA page-copy refusal, cancellation of a queued output
card, and typed Markdown output-budget refusal. Direct HTTP-handler tests cover
discovery, real synthetic PDF input, output metadata and the UI resource.

`scripts/build-hosted-output-harness.mjs <fresh-directory>` builds a synthetic
local HTTP and MCP Apps bridge simulation. In an isolated browser, the card
rendered and its download produced the exact independently reparsed PDF with
pages 3 and 1 in that order. This is local browser/download proof, not ChatGPT
attachment, iframe-CSP, file-return or submission acceptance. Production remains
unchanged until a separately verified deployment milestone.

## Official implementation sources

- [OpenAI file inputs and runtime reference](https://developers.openai.com/plugins/reference#file-apis)
- [MCP server and file input contract](https://developers.openai.com/plugins/build/mcp-server)
- [MCP Apps UI and vanilla bridge example](https://developers.openai.com/plugins/build/chatgpt-ui)
- [Plugin extensions and local versus hosted integration](https://developers.openai.com/plugins/build/extensions)

The original forms qualification remains valid for its exact old source and
production version. It is not evidence of the new tools or native host output.
