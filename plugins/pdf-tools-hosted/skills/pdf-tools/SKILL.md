---
name: pdf-tools
description: Read and search PDFs, turn selected pages into Markdown, fill PDF forms, and create new copies with selected, reordered, rotated or merged pages. Reports source coverage and extraction gaps.
---

# PDF Tools

Use the configured `pdf-tools` hosted MCP. This processes only documents
explicitly supplied for this task, remotely for one request at a time. It does
not store documents, browse local folders, or provide the local application's
saved workspace, profiles, full viewer or Lumin signing.

## Get the supplied file

Prefer the host-provided `file` attachment input. The host supplies its real
`download_url` and `file_id`; never invent them. Tools also accept an authorized
`pdf_url` or actual `pdf_base64`, but never more than one input form. `merge_pdfs`
takes a `files` array of 2 to 5 real attachments. Never publish a private file
elsewhere just to obtain a public URL. If the host cannot supply the attachment,
explain the unsupported handoff rather than claiming access.

Inputs fetched by URL or attachment are limited to 25 MB and 200 pages. Inline
input and returned PDFs are limited to 3 MB. Encrypted PDFs are refused. The
assistant host's data terms apply to files and content shared with it.

## Read, search and convert

Use `get_pdf_info` first to establish the source and page count. Reading,
searching and Markdown conversion require explicit inclusive page ranges of
at most 10 pages per call. They default to page 1 only. Track the exact covered
ranges if working through a longer document; never describe an unexamined page
as reviewed. Use `read_pdf_pages`, `search_pdf_text` and
`convert_pdf_to_markdown` for their respective jobs.

Preserve extraction status, truncation and gap warnings in the answer. A
no-match result covers only the extracted text in that range. No OCR is
performed; image-only content and missing text are not empty-document proof.
Markdown conversion is not complete mathematical, table or schema extraction.

## Make and return a new copy

Use `select_pdf_pages` with exact unique page numbers in the desired order to
split or reorder. Omitted pages are deliberately excluded and must be reported.
Use `rotate_pdf_pages` for exact pages and 90, 180 or 270 clockwise degrees.
Use `merge_pdfs` for explicitly supplied attachments in their listed order.
Page selection and merging copy page content, not document-level form
structure, bookmarks or metadata. Do not promise those survived.

For user-facing PDF-producing calls set `output_mode: "download"`. The
result card receives and verifies PDF bytes without placing them in the
model-visible result. The download action is user initiated and depends on
host support. Never call encoded data a download link or say the file has
been saved before the host or user confirms it. Without a working card,
explain the output limitation. `output_mode: "inline"` is for machine clients
that can actually consume base64; do not echo large base64 to the user.

The source is never overwritten. To run a further operation on the new copy,
use an actual host-authorized file handoff. A digest alone is not access to
bytes, and the stateless server cannot retrieve a previous result by ID.

## Forms and visible stamps

Read `read_form_fields` and use exact returned field names. Fill only the user's
provided values with `fill_form`. Report both `filled` and `not_filled`. Verify
the new copy when the host can supply it again; otherwise do not claim readback.
Use `flatten_form` only when the user wants fixed page content rather than
editable fields. A successful fill does not mean complete or ready to submit.

Use `detect_signature_zones` before a visible stamp. `apply_signature` needs
the person's own explicit intent statement and actual recent confirmation
time. Never invent consent, timestamp or signature identity. A visible stamp
is not a cryptographic signature or a Lumin signing request. Do not bypass
signature, XFA, encryption, size or private-network refusals.
