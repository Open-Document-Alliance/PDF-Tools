# Repository review and improvement goals

Review baseline: `ac856ca7ff007354568febb0604a3f5cb43f1fd6`.

## Assessment

PDF Tools already has substantial product foundations: a broad MCP tool set,
source-bound extraction records, guarded file publication, isolated parsing
workers, an embedded viewer, and unusually explicit evaluation protocols.
Preserving those boundaries is more valuable than adding an unmeasured model
dependency or rewriting the server.

The review found gaps between those foundations and individual execution paths:

| Finding | User impact | Goal for this change set |
| --- | --- | --- |
| Some reads and host imports still parsed with pdf-lib in the MCP process | A malformed PDF can block unrelated requests | Route all such parsing through the bounded child-process boundary |
| CSV export used a direct output write | An output alias could overwrite a source | Bind the exact source bytes and publish a new file atomically |
| Local downloads lacked connection-bound address checks and a whole-operation budget | Redirects, changing DNS, and oversized bodies escaped parts of the intended policy | Validate and pin destinations, scope headers, and bound decoded bytes and total time |
| Viewer caches and asynchronous work outlived a document session | Reopening the same path could show stale content; late rendering could fail | Use explicit session generations and retire all document and thumbnail work |
| Single-page viewer controls were hidden | Ordinary one-page forms lost signing and page-management actions | Make those actions available for one-page documents |
| `anyOf` behaved like exclusive choice, and absence was described too strongly | Valid schemas were rejected and uncertain output appeared mechanically established | Admit inclusive alternatives and retain absence as unverified reasoning |
| Uncertain extraction outcomes could become terminal | Users could not correct them without losing the original record | Support append-only corrections with honest current status and history |
| Extraction repeatedly rebuilt source layouts | Multi-field verification paid repeated parsing cost | Bound a source- and context-keyed cache and verify batches in one atomic generation |
| Evidence was mainly accessible through separate tool responses | Reviewing values against their sources was cumbersome | Add a source-bound viewer workbench with citations, coverage, history, and correction requests |
| Optional local OCR was single-page and macOS-only | Linux scans and interrupted multipage work were poorly served | Add explicit Tesseract configuration and checkpointed, resumable page jobs |
| The PR gate omitted most native test suites | A green PR could miss important runtime regressions | Run the complete platform-supported native suite in CI |
| Existing quality evidence did not establish current general extraction leadership | A “state of the art” label would be unsupported | Add reproducible independent workflow checks and a pinned upstream scoring bridge |

## What success means

This is a reliability and reviewability milestone toward a competitive document
toolkit. Success requires preserved sources, responsive bounded parsing,
explicit uncertainty, correctable extraction records, functioning source review,
and reproducible measurements from the integrated commit. Passing a synthetic
workflow is evidence for that workflow, not evidence of general document
understanding or a public leaderboard rank.

New OCR text remains a proposal. A replayed source image does not verify its
recognized words, and a matching text citation does not prove the semantic
assignment of a field. “Not found” never becomes a mechanical proof of absence.

## Qualification still required before broader claims

1. Run the pinned full external corpus on a machine that supports the existing
   process-tree network fence and the official scorer dependencies. Retain
   per-case results, full denominators, runtime versions, and failure categories.
2. Compare extraction against contemporary engines under the same document,
   cost, latency, and hardware protocol. Include scans, tables, equations,
   multilingual documents, reading order, and refusal behavior. Do not use the
   public synthetic generator as an unseen test set.
3. Exercise the built package in real supported MCP hosts and browsers, including
   page navigation, citation highlighting, corrections, signing, and reopening a
   changed file. DOM tests do not establish installed-host compatibility.
4. Run the platform matrix before release. Linux tests do not qualify macOS
   Vision or Windows, and local Tesseract success on one raster fixture does not
   establish multilingual or scan-corpus accuracy.

See `PUBLIC_QUALIFICATION.md` for reproducible evaluation commands and
`LOCAL_OCR.md` for the optional local-engine boundary. Release, publication,
external messages, and signatures are separate actions from this code handoff.
