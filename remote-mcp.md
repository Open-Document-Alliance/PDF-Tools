---
title: PDF Tools Remote MCP
description: The hosted PDF Tools MCP endpoint for AI agents, what it does, and what it does not keep.
---

# PDF Tools Remote MCP

> The endpoint is deployed and the properties below are what it does. Its
> behavioral contract, and the tests that bind it, are in the repository.

PDF Tools is an open source toolkit for working with PDF forms. It exists in two
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
- Authentication: none
- Protocol revisions: as published by the server's `initialize` response

## Tools

| Tool | What it does |
|---|---|
| `read_form_fields` | Lists form fields with names, types and current values |
| `fill_form` | Fills named fields and returns the filled document |
| `detect_signature_zones` | Finds where a signature, initials, printed name or date belongs, with coordinates |
| `apply_signature` | Stamps a typed signature at a zone |
| `flatten_form` | Makes filled values permanent page content |

Each tool takes a PDF either as `pdf_url`, which the server fetches, or as
`pdf_base64`, which you send inline. Results that produce a new document return
it as base64 in the response.

## What this service does not do

**It does not store your document.** Bytes exist in memory for the length of one
request. There is no database, no object storage, no cache, and no download link
that outlives the response, because there is nothing kept to link to.

**It does not know who you are.** There are no accounts, no API keys and no
sessions. Nothing associates one request with another.

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
| Maximum document size | 25 MB |
| Maximum pages | 200 |
| Fetch timeout | 15 seconds |
| Redirects followed | 3 |

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
