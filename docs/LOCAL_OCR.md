# Experimental opt-in local OCR

The default PDF Tools package does not install or bundle an OCR engine.
Its normal tool list is unchanged. The optional `propose_pdf_ocr` tool is
exposed only when an administrator explicitly supplies `localOCR` in the
existing local PDF Tools configuration file. This source feature is not yet
a qualified installed desktop release.

The first adapter supports macOS Vision through separately installed
`ocrmac`, PDFium and Pillow. It proposes words for one selected page, then
replays the retained image from the exact source bytes and creates a private
offline review. Replay proves source/image identity, not word correctness.
It does not change the PDF, replace its native text, recover table structure,
or independently approve the proposal as a source citation.

## Separate setup

Use a separate Python virtual environment, not the extension's runtime.
The tested adapter versions are ocrmac 1.0.1, pypdfium2 5.13.0 and Pillow
12.3.0 on macOS with Python 3.12. Their installation is an explicit local
administrator action. PDF Tools never installs packages on a tool call.

Install the reviewed `scripts/local-ocr-proposal.py` outside the extension
bundle. This helper version has SHA-256:

```text
2991b9e68dd7327813292126f8ae4398546662187799ff92b6446b591e825991
```

Use `get_allowed_directories` to find the active configuration file. Preserve
its existing folder policy and add:

```json
{
  "allowedDirectories": ["/absolute/folder/you/approve"],
  "localOCR": {
    "pythonPath": "/absolute/separate-venv/bin/python",
    "helperPath": "/absolute/separate-adapter/local-ocr-proposal.py"
  }
}
```

Paths are configured by the host user, never by a model tool argument.
The server checks the helper against its frozen digest, snapshots those
bytes, and runs only the snapshot. A helper from another version is refused.
The Python virtual environment and its libraries remain an explicitly trusted
local installation; this is not a sandbox against a hostile same-user or root
administrator. Use `localOCR: null` to disable the tool. Reconnect the server
after changing configuration. Do not restart an active host to experiment
with this feature without preserving its session.

## Request and review

Get the source identity with `get_pdf_identity`, then explicitly request:

```json
{
  "pdf_path": "/absolute/approved/source.pdf",
  "page": 1,
  "expected_source_sha256": "<the exact current source SHA-256>",
  "confirm_local_ocr": true
}
```

The source must pass the existing folder allowlist, be an unencrypted PDF of
at most 50 MiB, and still match its requested identity after the operation.
OCR runs on a private snapshot. Changed sources, incomplete saves or failed
replay produce no successful proposal response. There is no automatic retry.

The result labels every word as unverified and includes the page image when
it is at most 4 MiB. At most 200 of the adapter's bounded 1,000 observations
are returned; exact observed, returned and omitted counts remain separate.
The full proposal and an offline HTML review are retained privately under the
server's profiles area. Open the returned `review_html_path` in a local browser
to see the scan beside all proposed words and click their source boxes.
This tool does not open a browser automatically or create an approval record.

The review contains no scripts, external resources, analytics or upload code.
Text and images returned to an MCP host are subject to that host's data terms.
Retained files contain document content and should be treated as private.
Failed attempt folders can contain a source snapshot or partial output; they
are not accepted as completed proposals and are not silently deleted.

## Limits

- One active OCR request per server, one page per request, and a shared
  120-second generation/replay budget with process-group termination.
- No provider credentials or host Python import paths are passed to the
  adapter. Its configured local interpreter and system frameworks remain
  trusted, and no operating-system network audit is claimed.
- Engine scores are uncalibrated. In the existing scan fixture, Vision returned
  `FLIGIM` for visible `FLIGHT` even with a score of 1.0.
- The same bounded helper rejects excessive pixels, PNG bytes, observation
  counts, text lengths, malformed boxes and mismatched replay identities.
- Windows and Linux do not run this macOS adapter. A separate cross-platform
  recognizer would need its own implementation and evidence.
