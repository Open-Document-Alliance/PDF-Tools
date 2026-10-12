# Verified extraction workspaces

Verified extraction is an experimental, model-free PDF Tools workflow for
turning a local PDF into schema-shaped values with replayable source evidence.
It does not ask PDF Tools to guess a completed object. Instead, the MCP host or
agent proposes one schema leaf at a time, cites exact bytes from source-bound
chunks, and asks PDF Tools to replay the claim deterministically.

## Workflow

1. Call `create_extraction_workspace` with a local `pdf_path`, a short
   `workspace_id`, and a supported JSON Schema object. PDF Tools reads every
   admitted page locally, binds the exact PDF and schema bytes, compiles the
   schema's leaf obligations, and creates a private transactional workspace.
2. Call `read_extraction_workspace` for `document_map_chunks` and
   `pending_leaves`. Use its cursor when `next_cursor` is non-null.
3. Call `read_extraction_chunk` with the same PDF path and one returned
   `chunk_id`. PDF Tools reads and hashes the current PDF, reuses only an exact
   source/context layout match, and refuses source drift or an omitted/unknown
   chunk.
4. Call `submit_extraction_proposal` with one pending JSON Pointer, a proposed
   JSON value, the exact current generation, and the chunks used. The proposal
   is retained as `unverified`; caller text, geometry, or confidence is never
   treated as proof.
5. Call `verify_extraction_proposal` with the proposal generation/event,
   citations expressed as exact UTF-8 byte ranges plus quote SHA-256, and one
   supported method. PDF Tools checks fresh PDF bytes and the retained schema,
   replays the quoted bytes, derives the typed result, and appends that result as a new immutable
   generation.
6. Read `results` and `pending_leaves`, or call
   `inspect_extraction_state`. Citation failures and uncertain results leave
   the leaf pending so a corrected proposal can be submitted against the new
   current generation. Exact projections and computed results close the leaf
   and reject later replacement. Earlier proposals and results remain intact.
7. Call `delete_extraction_workspace` only with the exact current workspace
   identity, exact current generation, and `confirm: "DELETE"`.

## Atomic batch verification

After submitting proposals for different leaves, call `verify_extraction_batch`
with `pdf_path`, `workspace_id`, `workspace_identity_sha256`, the exact current
`parent_generation_sha256`, and 1–32 `items`. Each item contains the existing
`proposal_event_id`, `citations`, and `method` fields. Every item names an
unverified current proposal on a distinct leaf. Proposals may have been
submitted in different earlier generations; all results bind the same current
parent used for the batch.

The tool loads fresh PDF bytes and one validated workspace snapshot. It checks
every item before acquiring publication authority, then retains all results in
one immutable generation. Invalid input reports a zero-based `batch item N`
error and leaves the workspace unchanged. Source drift, a stale parent, duplicate
proposals/leaves, or a failed resource bound also prevent publication.
`citation_mismatch` and `unverified_reasoning` are valid typed results and can
be retained alongside `verified_exact`. Thus `state: "complete"` means all
results were retained, not that all claims were verified. The ordered `events`
and `results` arrays correspond to the ordered input items; the response also
contains the parent digest, resulting digest, and generation sequence.

A process crash can leave the existing recovery claim or a complete staged
batch. Recovery either retains the previous generation or publishes the full
batch; it never publishes a subset. Read the current generation before retrying
a request whose response was lost. Batches do not make repeated publication
idempotent and do not alter exact/computed leaf closure.

Generation manifest `1.1.0-experimental` adds explicit `event_count` when a
history has more events than generations. Generation numbers remain contiguous;
event numbers advance once per result. Legacy manifest `1.0.0-experimental`
retains its one-event-per-generation interpretation, and old bytes and hashes
remain unchanged. Tools using old readers must upgrade before reading a batched
workspace.

## Layout reuse and resource bounds

Each handler has an in-memory LRU cache of source-derived layouts, bounded to
8 entries and 64 MiB of serialized layout payload, with at most 2 distinct
extractions in flight. Same-key concurrent requests share extraction; other
requests above that bound fail with a retryable limit message. Oversized layouts
are returned without retention and failed extractions leave no cache entry.
The byte bound is serialized payload, not a promise about JavaScript heap or RSS.

Every source-bearing request still reads and hashes current PDF bytes. Cache
keys include the exact source digest/length, resolved path, salted password
context, page limit, and parser/IR/renderer/policy versions. Entries are validated
against their source bytes and callers receive defensive copies. Cached layouts
never substitute for schema checks, generation checks, document-map/citation
replay, or evidence of semantic correctness. Cache statistics are performance
diagnostics only. Passwords, proposals, and verification results are not retained
as cache values. Restarting the process discards the cache.

The cumulative events, state, and manifest payloads of all retained and complete
staged generations are bounded to 256 MiB, alongside existing individual file,
event, value, generation-count, and response limits. Metadata is checked before
reading generation payloads, actual read bytes are checked again, and a proposed
append is budgeted before creating a writer claim. An oversized legacy workspace
is refused without deletion or mutation. Histories remain cumulative, so their
storage and replay costs still grow with successive generations. Static source
map/schema/identity files retain their separate individual limits.

Run `node scripts/verified-extraction-cache-benchmark.mjs` for a small offline
20/100-page timing demonstration. It compares the same generated PDFs with and
without retained layout reuse, counts parser calls and fresh reads, and checks
same-path source mutation. It is a synthetic performance check using in-process
PDF.js, not an extraction-quality result or a production-worker latency claim.

## Supported verification methods

- `exact_projection`: a value is projected from one replayed citation using a
  supported literal normalization.
- `calculation`: an exact rational calculation is derived from replayed inputs.
- `source_supported`: a typed, source-supported interpretation remains visibly
  distinct from an exact projection.
- `ambiguous`: competing replayed values are retained as typed uncertainty.
- `unverified_reasoning`: retain a cited proposal whose semantic assignment has
  no accepted deterministic verifier.
- `not_found`: retain a caller's absence declaration only with `null`, no
  citations, the complete returned chunk set, and complete admitted page/search
  coverage. The result is `unverified_reasoning` with
  `ABSENCE_NOT_MECHANICALLY_PROVEN`. Complete scope proves what was available
  to inspect, not that a fact is absent. The leaf stays open for correction.

The verifier returns typed statuses such as `verified_exact`,
`computed_with_inputs`, `source_supported`, `ambiguous`,
`citation_mismatch`, `chunk_missing`, and `unverified_reasoning`. It does not
return numeric confidence.

The verifier contract is `1.1.0-experimental`. Historical `1.0.0-experimental`
results may contain `not_found`; they remain historical caller declarations,
not mechanically proven absence. Reading a retained workspace preserves its
original generations and their original pending counts. A new proposal can
reopen a legacy uncertain leaf, including one previously marked `not_found`.

## Reading correction history

The [evidence review viewer](EVIDENCE_REVIEW.md) presents current leaf status,
immutable proposal history, and cited page evidence together.

`events`, `proposals`, and `results` are append-only chronological histories.
Group events by `leaf_pointer`; the latest proposal is the active attempt and
its matching `proposal_event_id` identifies its result, if one exists. An
earlier result is historical once a later proposal exists, even before that
later proposal is verified. Do not display an earlier result as the current
answer while a correction is pending. `pending_leaves` reports unresolved
leaves; for new results, only `verified_exact` and `computed_with_inputs` close
a leaf. Their source-presence or arithmetic claims still do not prove the
semantic choice of field or calculation inputs.

Submit a correction through the ordinary proposal/verification calls using the
exact latest generation. One unverified proposal per leaf is allowed at a time;
stale-generation and concurrent-proposal checks still apply. Correction never
deletes a prior result, mutates source bytes, or bypasses citation replay.

## Privacy and boundaries

- PDF parsing, workspace state, citation replay, and verification happen
  locally. The MCP server makes no model or provider call.
- Content returned through MCP may still be sent by the selected host to its
  model provider. The host/provider data terms therefore remain relevant.
- Workspace data lives under
  `~/.pdf-toolkit-files/verified-extraction-workspaces` (or the configured
  private profiles root), not beside the source PDF.
- POSIX hosts require physical `0700` workspace directories and `0600` state
  files. Windows does not expose useful POSIX permission bits through Node, so
  the workflow instead relies on the current-account ACL of the configured
  private profiles root while retaining physical-file, canonical-path,
  no-symlink, file-index, size, timestamp, and digest checks.
- Retained files are individually flushed before publication on every host.
  Node cannot portably `fsync` NTFS directories, so Windows does not claim the
  same power-loss directory-metadata guarantee as POSIX hosts; process-crash
  recovery and fail-closed generation replay remain enforced.
- The source PDF must remain inside the configured allowed-directory boundary.
  The private workspace root cannot widen that boundary.
- This surface does not run OCR. Raster-only or truncated evidence stays a gap;
  even a caller's `not_found` declaration is rejected when admitted search
  coverage is incomplete.
- The supported JSON Schema subset gives `anyOf` its inclusive meaning: one or
  more branches may match. Only annotation keys may appear beside `anyOf`;
  sibling validation constraints and other unsupported keywords are rejected,
  not ignored.
- Arrays are one leaf obligation in this first version. It verifies the array
  value as a whole and supports exact uniqueness or keyed-item schema checks;
  it does not expose per-index editing.
- Verification proves the stated replay or calculation under the exact local
  inputs. It is not legal review, semantic completeness, model-quality proof,
  or a public benchmark claim.

## Recovery and retention

Every mutation publishes an append-only generation under an exclusive local
transaction. Inspection reports incomplete or active transaction state rather
than silently repairing it. The current public tools intentionally expose the
ordinary create/read/propose/verify/delete lifecycle; maintainers use the
lower-level exact recovery functions for a crashed mutation after inspecting
its retained transaction authority. No automatic pruning occurs.
