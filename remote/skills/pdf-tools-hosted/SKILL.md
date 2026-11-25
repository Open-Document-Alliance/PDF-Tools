---
name: pdf-tools-hosted
description: Read, search, convert, fill, stamp and reorganize PDFs with the hosted PDF Tools server, which keeps nothing. Use when the person supplies a PDF as an attachment, a URL or inline data and wants text, Markdown, form filling, page changes or a visible signature stamp.
---

# Hosted PDF Tools

This server runs remotely and stores nothing. Each call takes one explicit document and returns its result in the response. It has no access to the person's files, folders, saved profiles or saved signatures.

## Supplying the document

Use exactly one input per call:

- `file`: an attachment the host provides (with a download URL). Prefer it when there is one.
- `pdf_url`: a public HTTPS URL the server fetches itself, up to 25 MB.
- `pdf_base64`: the PDF inline, up to 3 MB.

A filename or a digest is not the document. Never publish a private document just to give the server a URL. For larger files, encrypted files, or files on the person's computer, point them to the local PDF Tools server (Claude plugin or desktop app).

## Reading

1. Call `get_pdf_info` first for page count, page sizes and form count.
2. Read with `read_pdf_pages`, search with `search_pdf_text`, or convert with `convert_pdf_to_markdown`. Each covers at most 10 pages per call, so walk longer documents in ranges.
3. Report the coverage and gaps the tools return. There is no OCR: empty text does not mean an empty page, and a no-match result covers only the extracted text you searched.

## Filling a form

1. `read_form_fields` to get exact field names, types and current values. Government forms often use coded names such as `f1_01`; work out which field is which before filling.
2. `fill_form` with names exactly as listed. It returns the filled PDF.
3. Only `flatten_form` when the person wants the values made permanent.
4. Never claim a form is complete or ready to submit. Say which fields you filled and which you left.

## Pages

`select_pdf_pages` keeps or reorders pages, `rotate_pdf_pages` rotates exact pages, and `merge_pdfs` combines 2 to 5 attachments in order. Each returns a new copy and leaves the source unchanged. These copy page content, not bookmarks or document-level metadata.

## Signatures

- `detect_signature_zones` finds where a signature, initials, name or date belongs.
- `apply_signature` draws a visible typed signature. It is a stamp, not a cryptographic or certificate-backed signature. It needs the person's own words stating their intent and the time they gave them. Never write those for them.
- To send a document for a binding signature through Lumin, the person needs the separate signing connection (`/mcp/sign`). Its tools are not available on this connection.

## Returning results

New PDFs come back as base64 or, with `output_mode: "download"`, as a download card where the host supports it. The person must actually download and open the result; a card or a digest is not proof they have it. Keep the refusal codes the tools return (for example `TOO_LARGE_INLINE`, `ENCRYPTED`, `PRIVATE_ADDRESS`) and explain the next step rather than retrying the same call.
