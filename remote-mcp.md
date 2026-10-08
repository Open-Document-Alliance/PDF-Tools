---
title: PDF Tools Remote MCP
description: The hosted PDF Tools MCP endpoint for AI agents, what it does, and what it does not keep.
---

# PDF Tools Remote MCP

> The endpoint is deployed and the properties below are what it does. Its
> behavioral contract, and the tests that bind it, are in the repository.

PDF Tools is an open source toolkit for reading and working with PDFs. It exists in two
forms, and the difference matters:

| | Where it runs | What it can reach | What it keeps |
|---|---|---|---|
| **Desktop extension** ([.mcpb](https://github.com/Open-Document-Alliance/PDF-Tools/releases/latest)) | On your own computer | Folders you have allowed | Your files stay yours; saved profiles and signatures live on your machine |
| **Remote MCP** (this page) | On a server | Only the document sent with each request | Nothing |

If you want PDF Tools to work on files already on your computer, use the desktop
extension. The remote endpoint exists for agents that have no access to your
filesystem, such as a hosted assistant working from a link or an attachment.

## Endpoint

- Transport: Streamable HTTP (MCP)
- URL: `https://mcp.opendocuments.ai/mcp`
- Authentication: none on this public endpoint
- Protocol revisions: as published by the server's `initialize` response

## Tools

The twelve-tool service below is deployed following the October 6 promotion.
Direct-service checks passed for reading, forms and returned PDF copies. This
does not establish native ChatGPT attachment/download acceptance or directory
submission; see
[the hosted-core qualification record](docs/OPENAI_HOSTED_CORE.md).

| Tool | What it does |
|---|---|
| `get_pdf_info` | Reports source identity, page count and bounded document observations |
| `read_pdf_pages` | Reads text from an explicit page range and reports coverage and gaps |
| `search_pdf_text` | Finds literal matches within an explicit page range |
| `convert_pdf_to_markdown` | Converts selected pages to source-backed Markdown with extraction warnings |
| `select_pdf_pages` | Creates a copy with selected unique pages in the requested order |
| `rotate_pdf_pages` | Creates a copy with exact pages rotated by 90, 180 or 270 degrees |
| `merge_pdfs` | Creates a copy from 2 to 5 explicitly supplied PDFs in order |
| `read_form_fields` | Lists form fields with names, types and current values |
| `fill_form` | Fills named fields and returns the filled document |
| `detect_signature_zones` | Finds where a signature, initials, printed name or date belongs, with coordinates |
| `apply_signature` | Stamps a typed signature at a zone |
| `flatten_form` | Makes filled values permanent page content |

Single-document tools accept one input: a real host-provided `file` attachment
descriptor, an authorized `pdf_url`, or actual inline `pdf_base64` bytes.
`merge_pdfs` accepts a `files` array of real attachment descriptors. A filename
or digest alone is not file access; the host must supply the bytes or a usable
download URL. Never publish a private document just to make its URL accessible.

Reading, search and Markdown cover at most 10 pages per call and default to
page 1. No OCR is performed. Preserve reported extraction gaps and do not call
unexamined or image-only pages complete. Selection and merging copy page content,
not document-level forms, bookmarks or metadata; detected signature fields and
XFA documents are refused for these page-copy operations.

New document results default to inline base64 for machine clients. With
`output_mode: "download"`, bytes are in widget metadata rather than the model
response, and compatible hosts can show a user-initiated download card. The
user must actually receive and reopen the file; a card or digest alone is not
successful download proof. The hosted edition has no local-folder access,
full desktop viewer, saved extraction workspace, profiles or Lumin signing.

## What this service does not do

**It does not store your document.** Bytes exist in memory for the length of one
request. There is no database, no object storage, no cache, and no download link
that outlives the response, because there is nothing kept to link to.

**The public endpoint does not know who you are.** It requires no accounts,
API keys or sessions. Nothing associates one request with another.

An optional, separately configured [Vercel Connect surface](docs/REMOTE_CONNECT_API_KEYS.md)
uses account-free app keys at `/mcp/connect`. It requires maintainer activation
and returns 503 until configured. Keys are signed capabilities for stateless
processing, never access to stored records. The public `/mcp` remains available
without a key. Both surfaces use the same document-processing tools and limits.

**It does not log your content.** Operational logs record tool names, byte
counts, durations and error classes. They do not record document bytes,
extracted text, field names, field values, filenames, or the URLs you supply.

**It does not train anything.** No model is trained, fine-tuned or evaluated on
documents sent to this service.

**It does not sign documents in a legally binding way.** `apply_signature`
draws a visible signature onto the page and records the signer, the time and the
person's stated intent in the document's metadata. That is a stamp, not a
cryptographic signature and not a certificate-backed one. For binding signatures
use a signing service built for it.

**It does not accept passwords.** Encrypted documents are refused rather than
decrypted, because handling a password means accepting a secret. The desktop
extension handles encrypted files on your own machine.

## Limits and refusals

| Limit | Value |
|---|---|
| Document fetched from a URL | 25 MB |
| Document sent inline (`pdf_base64`) | 3 MB |
| Maximum pages | 200 |
| Reading, search or Markdown range | 10 pages per call |
| Returned PDF copy | 3 MB |
| Download deadline | 15 seconds across DNS, headers, redirects and body; shared across merge inputs |
| Hosted operation deadline | 45 seconds, parent terminates the per-call worker |
| Hosted concurrency | 2 active workers per service instance, no waiting document queue |
| Redirects followed | 3 |

The two document limits differ because they are set by different things. A
document we fetch is bounded by this service. A document sent inline rides
inside the request, and the host rejects a request body above roughly 4.5 MB
before this service sees it, which after base64 leaves about 3 MB of PDF. A
finished document travels back the same way, so a result much above 3 MB may
fail on the way out even when the input arrived by URL.

Two ways around it, in order of preference: pass a URL, which this service
fetches itself, or run PDF Tools on the machine that holds the file. The
desktop extension has no such ceiling because nothing crosses a network.

The URL fetcher refuses anything other than `http` and `https`, refuses private,
loopback, link-local and similar network ranges after resolving the name and
again after every redirect, and refuses a response whose bytes are not a PDF.

Requests that exceed a limit fail with a typed error rather than a truncated
result. When the service cannot prove something, it says so: filling a form
never claims the form is complete or ready to submit.

## Fair use

The endpoint is unauthenticated and free. Please keep automated use
proportionate. Persistent abuse is answered with rate limits, and if that proves
insufficient the service will require a key.

## Terms and privacy

The [privacy policy](https://www.opendocuments.ai/privacy-policy) and
[terms of service](https://www.opendocuments.ai/terms-of-service) of Open
Document Alliance LLC govern this endpoint.

## Source and contact

The server is open source, MIT licensed, in
[Open-Document-Alliance/PDF-Tools](https://github.com/Open-Document-Alliance/PDF-Tools)
under `remote/`. Its behavioral contract is
`docs/REMOTE_STATELESS_PROFILE_2026-09-19.md` in the same repository.

Report a bug or a security issue through the repository's
[issues](https://github.com/Open-Document-Alliance/PDF-Tools/issues) or the
contact in `SECURITY.md`.
