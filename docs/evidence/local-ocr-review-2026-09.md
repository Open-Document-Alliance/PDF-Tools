# Offline OCR review surface, September 30, 2026

The experimental script can now write an offline HTML review after the exact
source/page/render replay succeeds. This is a read-only visual aid, not OCR
verification, a correction workflow or an approval record. It remains outside
MCP registration and both default packages.

## Design and scope

The visual thesis is a calm, document-first workspace: original scan beside
proposed text, with one green accent identifying the selected observation.
The content plan is orientation and warning, original page, all proposed text,
then expandable source identities. Restrained hover and selected-box transitions
support navigation; reduced-motion settings disable transitions.

Each text observation links to its corresponding source-page box. The desktop
layout has two scrollable columns; narrow windows stack them. All recognized
text is escaped before HTML insertion. The image is embedded, styles are
SHA-bound by a Content Security Policy, and scripts, remote resource loading,
forms and base URLs are prohibited. There are no analytics or provider calls.
The output uses the same in-memory proposal and image snapshot that was just
validated, never a second file read after validation.

An explicitly selected new HTML path is written with exclusive creation and
mode 0600. Existing files are preserved. The review must live outside the
three-file retained proposal directory. Failed replay creates no review.
The same-user host, private parent and renderer remain trusted. This does not
make an independently authenticated statement about who authored OCR words.

## Actual Mac browser evidence

The unchanged retained Apollo proposal from
`local-ocr-replay-2026-09.md` replayed and generated `review-v2.html`:

- Proposal body SHA-256: `7d9174f9178ba659541594ef76eb370025d70a8329a57700df6bf4ee8ded23b1`.
- Review HTML SHA-256: `0f3717f44b4158e74aad7c8e07dc7cc6784ed7e85de835663b35d0675f9491e6`.
- 119 text links and 119 source boxes; zero script elements.
- An actual Mac headless browser click selected observation 42 and its source
  box. The proposed `FLIGIM` is visibly wrong against the scan's `FLIGHT`, even
  though its retained engine score is 1.0. The UI does not promote that score
  into word correctness.
- Desktop 1440px and narrow 390px checks showed no horizontal page overflow;
  the narrow layout uses one column. The page image displayed in both.
- The browser's resource timing list contained no remote resource entries.
  CSP inspection matched the generated offline policy. This is browser/UI
  evidence, not an operating-system network audit.
- Retained Mac files and screenshots live in
  `~/Library/Caches/oda-pdf-tools-extraction/ocr-replay-validation-20260930/`.

All 19 standard-library contract tests pass on Linux and MSS MacBook. New
tests cover escaped hostile text, output digest/private mode, no output after
failed replay, existing-file preservation, outside-proposal placement, an
explicit empty result and displaying the captured snapshot despite a later
disk mutation. Native OCR was not rerun for the screen; the existing proposal
was replayed and displayed.

A separate review of the screen delta at `a4f7ca91` found no actionable
defects and independently passed all 19 contract tests and the diff check.
It did not repeat the Mac browser run. The observed browser was
HeadlessChrome 151; both the selected text and source box highlight matched.
The isolated browser session was closed after capture; Claude Desktop was
not restarted or modified.

## Invocation

```sh
python scripts/local-ocr-proposal.py --pdf /absolute/source.pdf \
  --expect-source-sha256 <source-digest> \
  --verify-proposal-dir /absolute/retained-proposal \
  --expect-proposal-sha256 <proposal-body-digest> \
  --review-html /absolute/new-review.html
```

Open the generated file in a local browser. No web server is needed.
`--review-html` is rejected in generation mode because source-render replay
must run first. Keep the HTML private like the source PDF.

Bead `pdf-toolkit-mcp-478i` remains in progress. This screen is not actual Claude
Desktop integration, installed OCR capability, table reconstruction or an
extraction-quality benchmark. The source PDF and retained proposal are never
edited or replaced by the screen.
