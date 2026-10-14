# Experimental opt-in local OCR

The default PDF Tools package does not install or bundle an OCR engine.
Its normal tool list is unchanged. The optional `propose_pdf_ocr` tool and
`start_pdf_ocr_job`, `resume_pdf_ocr_job`, `read_pdf_ocr_job` job tools are
exposed only when an administrator explicitly supplies `localOCR` in the
existing local PDF Tools configuration file. This source feature is not yet
a qualified installed desktop release.

The adapters support macOS Vision through separately installed `ocrmac`,
and Tesseract on Linux/macOS. Both use separately installed PDFium and Pillow. It proposes words for one selected page, then
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
a66ec8fe3d77f846cabac126812425dfe5a6ed2b2b533bb863fdcf6e05c999c0
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

For Tesseract, configure the engine and exact executable explicitly:

```json
{
  "localOCR": {
    "engine": "tesseract",
    "pythonPath": "/absolute/separate-venv/bin/python",
    "helperPath": "/absolute/separate-adapter/local-ocr-proposal.py",
    "tesseractPath": "/absolute/path/to/tesseract"
  }
}
```

Install Tesseract and its English language data separately with your operating
system's package manager. This adapter currently recognizes English only.
It does not discover executables, download language models or switch engines.
The default engine is `vision`, preserving existing macOS configuration.
Tesseract's version and the renderer versions are retained in each proposal.

After installing the optional dependencies, run a real-engine smoke check on a
generated raster invoice:

```bash
node scripts/smoke-local-ocr.mjs --python /absolute/venv/bin/python --tesseract /absolute/path/to/tesseract --report /absolute/new-report.json
```

This checks recognition of two known values, source preservation, replay and
unverified status. It is one synthetic fixture, not a general accuracy score.
The Linux execution receipt is retained in
`docs/evidence/tesseract-local-smoke-2026-10-12.json`.

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

The same bounded proposal payload is returned as `structuredContent` and as
JSON in a text block, so hosts that expose only text and image content to their
model still receive the literal OCR words, source identities and omission
counts. The text block labels that data as unverified proposals, not
instructions; it does not trim or correct recognized words. Job responses
likewise include their exact identity, progress and review paths in both
forms, without adding page text to the bounded job summary.

The review contains no scripts, external resources, analytics or upload code.
Text and images returned to an MCP host are subject to that host's data terms.
Retained files contain document content and should be treated as private.
Failed attempt folders can contain a source snapshot or partial output; they
are not accepted as completed proposals and are not silently deleted.

## Limits

Current-source macOS Vision qualification can also exercise the actual stdio
server without touching a desktop application's configuration:

```sh
node scripts/macos-local-ocr-smoke.mjs --pdf /absolute/two-page-scan.pdf --expect-source-sha256 <sha256> --python /absolute/venv/bin/python --helper /absolute/local-ocr-proposal.py --encrypted-pdf /absolute/encrypted-fixture.pdf --output-dir /absolute/new-private-evidence --job-pages 1,2
```

The check requires the exact current default tool names and all four configured
OCR tools with their source input/output schemas and annotations. It retains
one page proposal, creates a two-page job without OCR,
processes its first page, closes its own server, and resumes the second page
in a fresh server process. Repeating the completed resume must do no new page
work. Retained image, proposal, commit and review hashes are checked, and the
original PDF must stay unchanged. Omitting `--job-pages` performs the single-page
check only. Missing consent, stale source identity and encrypted input must
be refused. This is local protocol and engine evidence, not installed Claude
or ChatGPT acceptance, independent word verification or general scan accuracy.

- One active OCR page operation per server and a shared 120-second
  generation/replay budget per page with process-group termination. The
  single-page tool keeps its existing contract; a job resume handles at most
  two pages sequentially, for at most two page-attempt budgets.
- No provider credentials or host Python import paths are passed to the
  adapter. Its configured local interpreter and system frameworks remain
  trusted, and no operating-system network audit is claimed.
- Engine scores are uncalibrated. In the existing scan fixture, Vision returned
  `FLIGIM` for visible `FLIGHT` even with a score of 1.0.
- The same bounded helper rejects excessive pixels, PNG bytes, observation
  counts, text lengths, malformed boxes and mismatched replay identities.
- Windows is not supported by the private-file/process-group adapter boundary.
  Linux uses the explicitly configured Tesseract adapter; macOS can use either
  engine. A source implementation is not installed-host qualification.

## Resumable multipage jobs

1. Obtain the source SHA-256 with `get_pdf_identity`.
2. Call `start_pdf_ocr_job` with `pdf_path`, `expected_source_sha256`, an
   explicit `pages` list and `confirm_local_ocr: true`. The list must contain
   1–20 distinct page numbers from 1–10000. Creation records the job but does
   not run an engine; page existence is checked by each later page attempt.
3. Save the returned `job_id` and `job_identity_sha256`. Resume with
   `resume_pdf_ocr_job({ job_id, expected_job_identity_sha256:
   job_identity_sha256, confirm_local_ocr: true })`. Default work is one
   unfinished page; `max_pages: 2` permits two. Each call needs fresh explicit
   confirmation. Page order is ascending.
4. `read_pdf_ocr_job` accepts the same ID and expected identity without
   confirmation. It returns progress and private review paths without OCR.
   Completion means every selected page has a retained, replayed proposal;
   it does **not** mean the words are correct.

Jobs pin the canonical source path and SHA, configured engine, exact reviewed
helper bytes, configured executable invocation paths, resolved executable
paths and filesystem identities. Every read/resume rechecks these bindings
through the existing source allowlist. A missing or changed source or
configuration refuses reuse; start a new job after intentional changes.
Executable filesystem identity is not an attestation of the entire Python
environment: installed libraries, language data and OS frameworks remain
trusted host configuration.

Private job directories (0700) contain an immutable manifest and independent
page checkpoints (0600). A checkpoint is published atomically only after a
successful single-page generation/replay and validation of the retained
files. Failed or interrupted pages have no completed checkpoint and may be
retried. A process restart preserves completed checkpoints and skips those
pages. A crash after producing proposal files but before publishing its
checkpoint can rerun that unfinished page; orphaned attempts remain private.
Completed file hashes are checked at checkpoint creation. Subsequent
read/resume calls check exact descriptor metadata, including inode and
nanosecond change/modification times, before reusing a checkpoint. Changed,
missing or nonprivate retained artifacts refuse reuse.
File and directory durability barriers complete before success is reported.
If a barrier fails after a checkpoint becomes visible, the call reports
uncertain durability; a later read/resume validates and syncs that checkpoint
without rerunning the completed page.

One job resume runs at a time per server, and it calls the same single-page
handler used by `propose_pdf_ocr`, preserving that handler's active-operation
lock. A per-job filesystem lock also protects against competing server
processes. Dead owners can be recovered using process birth identity;
unidentifiable live owners are never reclaimed. Job state is for a local
filesystem shared within one host PID namespace, not a network filesystem or
cross-container distributed queue.

Responses contain at most 20 page summaries and no word/image payloads.
`completed_count`, `remaining_count`, `processed_this_call`, `remaining_pages`
and `next_action` make continuation explicit. `failed_page` and
`failure_code: "page_attempt_failed"` mean that page did not complete; inspect
the selected page and configured engine before retrying. Every response has
`verification_status: "unverified_ocr_proposals"`. Review paths refer to the
same private proposal and HTML files used by the single-page tool.

Page count, per-call work, artifact size and returned metadata are bounded;
there is no automatic retention cleanup or aggregate disk quota. Each page
retains its own source/helper snapshot, and failed attempts may also consume
space. The subprocess deadline and output limits are not a hard RSS limit or
an OS parser sandbox.

The optional local two-page qualification command is:

```sh
node scripts/smoke-local-ocr-jobs.mjs --python /absolute/venv/bin/python --tesseract /absolute/path/to/tesseract --report /absolute/new-report.json
```

It generates a nonprivate two-page raster fixture, resumes between fresh
handler instances, checks retained reviews and verifies that a completed job
runs no additional pages. It is a small engine smoke check, not a general OCR
accuracy evaluation or installed-desktop qualification.
