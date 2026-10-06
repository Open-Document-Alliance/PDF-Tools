---
name: pdf-forms
description: Help inspect and fill PDF forms, find signature locations, add a visible signature stamp with the person's confirmation, and flatten a reviewed form using the hosted PDF Forms tools.
---

# PDF Forms

Use the configured `pdf-forms` MCP server. This is the hosted five-tool edition,
not the full local PDF Tools application. It provides no local file access,
viewer, saved profiles, extraction workspace, or Lumin signing.

## Supply and return the PDF

Each call requires the PDF as `pdf_url` or `pdf_base64`, never both. Only send a
document the user has supplied for this task and knows will be processed by the
hosted service. Never upload a private document to another service to obtain a
public URL. Do not invent document URLs, field values, or attachment access.
If the host cannot provide the PDF bytes or an authorized URL, explain that
limitation and request a supported input. Do not claim to have opened it.

Inline input is limited to 3 MB, fetched PDFs to 25 MB, and documents to 200
pages. Returned PDFs are inline base64, with host transfer limits. Encrypted
PDFs are refused. PDF Tools does not store the documents; content returned to
the assistant is governed by the host's data terms.

Use the host's supported file-output mechanism for returned PDF bytes. Never
present base64 as a download link or invent a file. If the host cannot produce
an accessible output file, state that the output handoff is unsupported.

## Fill and verify

1. Call `read_form_fields` and use exact field names from its result.
2. Ask for missing values. Do not guess what a coded field represents.
3. Call `fill_form` with only the user's supplied values.
4. Check both `filled` and `not_filled`, and read back the returned PDF to
   confirm its field values. Report every unfilled or unsupported field.
5. Never claim the form is complete, accurate, legally valid, or ready to
   submit just because filling succeeded.

## Signature stamps

Call `detect_signature_zones` first and preserve its top-left coordinates.
Before `apply_signature`, obtain the person's name and their own statement
confirming intent to apply the visible stamp. Preserve the exact statement and
the time of their actual confirmation. Never invent either required field.
The statement must be recent, and an earlier unrelated approval is not consent.
Clearly explain that a visible stamp is not a cryptographic signature or a
Lumin signing request. A request to inspect or fill is not permission to sign.

## Flatten

Call `flatten_form` only when the user wants fields converted into fixed page
content. Return a new output rather than claiming the original was overwritten.
Explain that further form-field editing is no longer available in that copy.
Report tool refusals and host/output limitations candidly; do not retry with
different inputs to bypass encryption, signature, size, or network safeguards.
