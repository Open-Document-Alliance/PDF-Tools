# Reviewing extraction evidence

Ask the assistant to open an existing extraction workspace with
`review_extraction_workspace`, supplying its PDF path, workspace ID and exact
workspace identity. The result opens the PDF viewer's **Evidence** mode. The
ordinary PDF viewer also has an **Ask to open evidence** action; it prepares a
conversation request rather than asking you to copy technical IDs into a form.

Before enabling evidence controls, the viewer hashes the complete PDF byte stream
owned by PDF.js and compares its SHA-256 and length with the workspace source.
The server independently checks the current PDF against that source on every
review read. A same-size file replacement or mixed progressive load is rejected.
The loaded source remains the document being reviewed; these checks do not lock
the external file against later edits.

## Values, history and coverage

**Values** shows each schema leaf's latest proposal and the result associated
with that proposal. Only `verified_exact` and `computed_with_inputs` count as
settled. Source-supported interpretations, ambiguous results, unverified
reasoning and replay failures remain visibly unresolved. No proposal and a
proposal awaiting replay are separate states. A new unverified correction never
inherits an older proposal's verification status.

**History and citations** shows append-only proposals newest first, identifies
the current proposal, and retains the earlier values and their replay results.
Values and quotes may have explicitly labelled previews; the underlying value
and quote hashes remain in the tool response. The assistant can retrieve exact
source chunks through `read_extraction_chunk`.

Selecting a replayed citation opens its original page. If its complete quote has
one exact match in the rendered PDF text spans, the containing spans are
highlighted. A repeated quote, truncated preview, or unavailable text layer does
not produce a guessed highlight. A highlight is a navigation aid, not an exact
source bounding box or proof of semantic correctness. UTF-8 byte offsets refer
to the retained extraction chunk, not to the PDF file or PDF.js text layer.

**Page coverage** reports retained extraction status, modality, visual-inspection
needs, gap codes, and omitted items, characters and chunks. It does not declare a
page semantically complete or prove that absent text is absent from the document.

All three views fetch at most 20 items at once. History may return fewer items to
keep the review payload within 128 KiB. Pagination is tied to the exact source,
workspace identity, current generation and collection. When the workspace
changes, use **Refresh** to restart that collection against the new generation.

## Requesting a correction

Use **Ask agent to correct**, **Ask agent to extract**, or **Ask agent to verify**
on a current unresolved leaf. The UI first checks that the workspace generation
and source are still current, then prepares a visible request containing the
source, workspace and generation identities. Hosts supporting MCP App messages
send that request to the current conversation. Other hosts leave the request
selectable for you to copy.

The review view itself performs no extraction write and has no approve button.
The assistant must use `submit_extraction_proposal` and
`verify_extraction_proposal` or `verify_extraction_batch` with the existing exact
parent-generation safeguards. After the assistant finishes, refresh the view to
see the appended proposal and result. Insufficient evidence remains unresolved.

## Integration and verification

`server/extraction-review.js` exports the read-only tool definition, strict output
schema and injected handler factory. The handler requires the canonical,
authorized PDF path resolver; a bounded, race-aware PDF reader; and
`readExtractionReviewState` from the workspace module. It returns ordinary viewer
metadata plus `structuredContent.extractionReview`; subsequent app reads consume
that descriptor directly without replacing the loaded PDF session.

The automated tests exercise the real app entrypoint with controlled DOM,
renderer and MCP transport: byte mismatch, page coverage, citation navigation,
correction messaging, stale-generation rejection, and late responses after
document replacement. These are not browser-layout or installed-host evidence.
`scripts/dev-ui-document-session-smoke.mjs` is the optional real-browser smoke
against a built viewer. The current implementation run could not provision
Chromium because the download endpoint was unavailable; installed-host and real
browser qualification remain separate release checks.
