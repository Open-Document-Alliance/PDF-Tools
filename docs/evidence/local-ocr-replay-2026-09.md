# Local OCR proposal replay, September 30, 2026

The experimental local script now writes schema v1 proposals with a final
`commit.json` record. Verification requires both the source PDF digest and
the proposal-body digest from the caller. It reopens the three private files,
rejects partial output and changed files, and independently renders the same
page again. The retained PNG must equal the fresh PNG byte for byte with the
recorded PDFium and Pillow versions. OCR text remains unverified; replay does
not establish that the engine read a word correctly.

## Behaviour

Generation retains `render.png` and canonical `proposal.json`, syncs their
directory, writes `commit.json` last, and syncs the directory and its parent.
An interrupted save can leave a private incomplete directory. Verification
rejects it, and generation refuses to overwrite any existing output directory.
This is incomplete-state rejection, not automatic crash recovery or an atomic
directory publication guarantee. Use a new directory for another attempt.

Verification checks physical nonsymlink files, private modes, exact inventory,
canonical JSON with duplicate-member rejection, the caller's digests, retained
file digests, page identity, renderer versions and observation bounds. Its
success status is `source_render_replayed_ocr_unverified`. It neither reruns
OCR nor authenticates the author of the recognised words. The same-user host,
installed renderer and private parent directory are trusted. Schema v0 output
is retained as historical evidence and intentionally does not pass this v1 gate.

A missing optional engine or unsupported generation platform returns a clear
failure and creates no output. Optional dependencies remain separately
installed. No MCP tool, manifest, package dependency or package inventory changes.

## Actual Mac evidence

On MSS MacBook, the existing separately installed environment generated a v1
proposal from the same public Apollo source used in the prototype. A separate
verification process rerendered the PDF and accepted the retained proposal:

- Source SHA-256: `539cc6aeaf44e5f3a9919ebbe6416654fac1b784feb5e30b868bd8af83b0e22b`.
- PNG: 2,351,721 bytes, SHA-256 `1e7e17ea7cb2efbeff08069e75891fdcf959d1ef9f091151c5260779322d31c6`.
- Proposal file: 17,607 bytes, SHA-256 `6686a57ca583e0aad8b235e6efcda0a5aab9a0f179bb3b45072fc75308eeab78`.
- Proposal-body SHA-256: `7d9174f9178ba659541594ef76eb370025d70a8329a57700df6bf4ee8ded23b1`.
- Commit file: 305 bytes, SHA-256 `f66c8ce201d8574d1f5a46ecc45c749cfa8d16c3051565a9410c099520a90832`.
- One page, 119 observations, directory 0700 and all three files 0600.
- Retained output: `~/Library/Caches/oda-pdf-tools-extraction/ocr-replay-validation-20260930/output/`.

The renderer's initial page cleanup used a context manager unsupported by
PDFium's page API. That actual run failed before output. Explicit `close()`
calls in `finally` blocks corrected it; the real generation and replay then
passed. The first 12 dependency-free checks passed on Linux and Mac. They cover
partial save, source/render/pin/version substitution, private modes, symlinks,
missing/extra files, duplicate JSON, malformed observations after full digest
recomputation, and absent-adapter failure before output.
A thirteenth check rejects a FIFO immediately without waiting for a writer;
the open uses `O_NONBLOCK` before testing that its handle is a regular file.

Independent review of the first replay commit found two functional edges:
syncing a symlinked parent (including macOS `/tmp`) failed after output was
committed, and binary floating-point addition could reject a valid box rounded
to the page boundary. Retention now resolves the existing parent before any
write. Replay compares decimal coordinates with the same 0.01-pixel allowance,
without widening it. Both direct regressions pass, including rejection just
beyond the allowance. All 15 dependency-free checks pass on Linux and Mac;
the same bank runs in the existing pull-request CI workflow without installing
OCR dependencies. The actual Apollo proposal still replays under the corrected
script.

## Invocation

Use a Python environment containing separately installed `ocrmac`,
`pypdfium2` and `Pillow`. Generation requires macOS Vision:

```sh
python scripts/local-ocr-proposal.py --pdf /absolute/source.pdf --page 1 \
  --expect-source-sha256 <source-digest> --output-dir /absolute/new-proposal
```

Replay needs the renderer only and the returned proposal digest:

```sh
python scripts/local-ocr-proposal.py --pdf /absolute/source.pdf \
  --expect-source-sha256 <source-digest> \
  --verify-proposal-dir /absolute/new-proposal \
  --expect-proposal-sha256 <proposal-body-digest>
```

The review surface and actual desktop integration remain in Bead
`pdf-toolkit-mcp-478i`. This step adds replayable evidence; it does not establish
full transcription, layout quality or a new shipped OCR capability.
