# Evaluation and Release Evidence

PDF Tools is not state of the art because it has many tools or because a demo
worked once. It earns that claim when a versioned evaluation system can show
that agents complete real document jobs correctly, safely, and consistently on
the hosts we support.

This document defines that system. Engineering work remains tracked in Beads;
this is the public scoring and evidence contract.

## Principles

1. **Evaluate user jobs, not isolated model answers.** A trial includes the
   prompt, tool trajectory, source files, output files, visible host behavior,
   and final answer.
2. **Prefer deterministic graders.** Exact structure, hashes, schemas, page
   geometry, pixels, fields, filesystem effects, and protocol behavior should
   be checked by code. Model and human graders cover qualities that cannot be
   reduced safely to exact assertions.
3. **Require evidence chains.** A correct-looking answer is incomplete when it
   cannot point to the page, region, field, or transformation that supports it.
4. **Separate product failures from harness failures.** Automation timeouts,
   host focus problems, and unavailable fixtures are reported independently and
   never converted into product passes.
5. **Turn every escaped defect into an eval.** A reproducible user report or
   maintainer correction becomes an anonymized fixture and regression test when
   licensing and privacy permit it.
6. **Do not average away blockers.** Security, destructive mutation, signature
   intent, artifact integrity, and supported-host startup are hard gates.

## Evidence layers

| Layer | What it proves | Typical evidence |
|---|---|---|
| L0: unit and property tests | Helpers and invariants behave correctly | Test output, fuzz seeds, exact assertions |
| L1: MCP contract | Tool discovery, schemas, results, errors, resources, and lifecycle are protocol-correct | Recorded JSON-RPC transcript and schema checks |
| L2: packed artifact | The exact MCPB is self-contained and contains the intended code and native targets | SHA-256, archive inventory, manifest diff, SBOM, extracted-artifact smoke |
| L3: runtime shape | Electron utility-process and browser-sandbox assumptions are represented in tests | Electron-shaped tests and viewer browser tests |
| L4: native host | The final artifact installs, exposes tools, renders, and completes core jobs in a supported host | Host/app versions, install registry, screenshots, logs, tool transcript |
| L5: agent workflow | An agent chooses suitable tools, asks for needed intent, recovers from errors, and returns a verifiable artifact | Versioned task, repeated trials, trajectory grade, output grade |
| L6: field evidence | Real users succeed and their corrections improve the suite | Anonymized failure class, support issue, regression fixture, trend report |

Passing a lower layer does not imply a higher-layer pass. In particular, direct
stdio success does not prove Claude Desktop integration, and a screenshot does
not prove the output file is correct.

### Experimental structured-output admission

The internal `scripts/verified-extraction-response-admission.mjs` helper is a
zero-inference preparation contract for a successor to the private long-document
evaluation. It is deliberately absent from the MCP server and release packages.
It treats output-token-cap termination as typed truncation evidence, rejects
duplicate JSON members before object construction, bounds contributor output,
and admits citations only when both the submitted quote and claimed value map
uniquely to an exact current-document chunk and to the canonical normalized
PDF.js page text bound to the same PDF bytes. The canonical source-page bundle
is derived only from a complete retained PDF.js text-item denominator and binds
the PDF, PDF.js package, every page string, and its own digest. Token projection
permits renderer-only whitespace around punctuation while preserving the exact
canonical page span; it does not join or alter source tokens. Every admitted
citation retains the submitted quote, chunk replay, canonical page replay,
UTF-8 byte ranges, and all corresponding digests. Independent replay requires
both the exact chunks and the exact source-page bundle. Reference,
bibliography, and works-cited sections are
evidence-ineligible and should not receive a model call. A later explicit
`Appendix` heading reopens source eligibility for that appendix; the pipeline
splits a caller batch at that transition so reference and appendix chunks can
never share one request.

A structurally known field that fails source replay is not allowed to erase
independently valid fields or masquerade as valid. The admitted proposal replaces
that field with its schema-safe `null` or empty-array value and retains a
digest-bound `rejected/not_source_bound` field outcome and message. The original
strictly parsed proposal and its digest remain separate from the admitted partial
proposal and its digest. Contributor arrays are all-or-nothing: one invalid,
duplicate, stale, or overflowed contributor rejects the whole contributor field
rather than creating an apparently complete shortened list. Malformed envelopes,
duplicate JSON members, unknown top-level fields, and reference-section calls
still reject the whole response.

`publication_citation_excerpt` must replay as a bounded 50–700-character
canonical source span, begin with `Suggested citation:` whenever that label
exists in the document, and retain DOI support. `first_table` has an additional
source-heading gate. Its page must contain the first exact capitalized
`Table 1.` or `Table 1.x.` heading whose longest bounded source prefix uniquely
replays to one retained chunk;
contents/list pages are excluded before the candidate is frozen. Abandoned
table regions remain bound when present, but they are not a complete table
inventory: confidently reconstructed tables do not appear in that collection.
This source-only classifier is an experimental deterministic heuristic for the
current evaluation corpus, not a general proof of table semantics or topology.
The admitted
anchor must begin with `Table 1`, contain 20–360 canonical characters, and bind
the selected source heading prefix. The request exposes that exact prefix rather
than asking the model to guess the source-bound extent. The admission retains
the selection and its digest, plus the exact abandoned-region evidence when one
exists on that page.
Missing, ambiguous, stale, substituted, contents-only, or semantically short
evidence produces a typed rejected field rather than an invented table
location.

The V16 retained-evidence replay exposed two composition requirements around
that boundary. Model requests now label every source chunk with its exact
physical PDF page, include the canonical source page text, and identify the
first classified actual-data-table page; `first_table` is disabled in every
other batch. Source-page prompt material is fail-closed under explicit per-page
and aggregate UTF-8 byte limits; it is never silently truncated. The prompt
explicitly allows unsupported fields to remain null or empty and forbids deriving a physical
page from printed labels or table numbers. It also requires one complete
human-readable contributor name per item and forbids combined `and`/semicolon
names. A typed malformed or truncated batch
is retained as rejected but does not prevent later frozen batches from running.
Only strictly admitted proposals contribute to the aggregate, while invocation
or controller failures remain fatal. These changes add no retry, repair
malformed JSON, weaken citation replay, or authorize a model/provider call.

The V17 retained run then isolated a representation-only boundary: 184 of 185
model responses contained duplicate-key-safe strict JSON inside exactly one
lowercase `json` Markdown fence, while the sole direct JSON response was
admitted. Admission now recognizes only that one finite wrapper grammar—three
backticks plus lowercase `json`, one LF, the strict JSON payload, one LF, and
the closing three backticks—with no surrounding bytes. Generic or uppercase
fences, missing boundaries, prose, multiple or nested fences, malformed JSON,
and duplicate members still fail closed. The admission retains the exact
payload, its digest, the raw-content digest, and an explicit representation
kind so downstream replay can reconstruct the original content before scoring.
This does not normalize arbitrary Markdown or weaken any source, citation,
table, schema, chunk, or cross-document check.

The caller must supply chunks from a separately validated, SHA-bound document
map; the helper rehashes each chunk and binds the complete ordered chunk scope
but does not replace document-map source/schema/renderer validation.

Source replay is the primary evidence property. Whitespace projection does not
silently rewrite the submitted proposal: its submitted strings remain bound by
the parsed proposal and response digests while the exact source spans remain the
primary replay evidence. Exact equality to one retained
oracle quote is a separate secondary evaluation signal because a source can
contain multiple valid literal spans. Derived counts are recomputed from admitted
objects rather than accepted as model arithmetic. These controls do not repair
or authorize an already-consumed campaign, invoke a model, expose the helper as
a product feature, or make a benchmark/public claim.

A measured successor must freeze a new comparison and campaign authority before
execution. Its trial and attempt identities must be disjoint from the consumed
V13 campaign, and it must bind the exact response-admission source, proposal
schema, reference-section policy, document-map identity, and complete ordered
chunk-scope digest. Zero-inference verification of those bindings precedes any
new local-model authorization; this source-only tranche creates no such
authorization.

The matching internal `scripts/verified-extraction-response-controller.mjs`
composes that admission boundary over one separately validated document map.
It freezes the complete ordered chunk denominator, partitions it into
contiguous batches, stops model-call eligibility at the first
bibliography/references heading, and retains one attempt receipt for complete,
truncated, malformed, source-replay-rejected, or controller-failure outcomes.
Contributor count is derived from unique exact admitted names and admission
digests rather than accepted from the caller. The controller accepts an
invocation callback but performs no model/provider call itself, remains absent
from server/share inventories, and keeps `benchmark_claim_ready: false`.

The internal `scripts/verified-extraction-response-pipeline.mjs` is the required
composition boundary for a measured caller. It derives the controller's exact
document-validation object from the retained document map and canonical
source-page bundle, carries that same bundle through plan replay and response
admission, and constructs each request from the controller-frozen batch policy.
Callers therefore do not independently author the map, source-page, table,
renderer, schema, chunk-scope, or batch-policy bindings at each handoff. Missing,
duplicated, substituted, or drifted bindings reject before the invocation
callback. The helper remains internal experimental source, performs no model or
provider call, and grants no execution or benchmark authority.

This boundary closes the integration failure measured in the consumed V19
campaign: all 30 candidate documents retained their source layouts and maps,
then failed before inference because the caller omitted the newly mandatory
source-page digest/object at the response-controller handoff. V19 remains
immutable failure evidence; this source repair neither retries nor retroactively
changes that campaign.

The consumed V20 campaign then exposed a later semantic seam. Response
admission successfully retained canonical source-page spans, including spans
whose chunk rendering differed only in whitespace, but the measured caller
discarded some of those admitted values by applying a second byte-exact chunk
substring check during final merge. The controller now owns one digest-bound
source materialization after admission. It independently replays every
admission against the frozen batch policy, exact chunks, and canonical
source-page bundle, then selects values and citations directly from those
validated replay spans. Each retained citation exposes a canonical-page form
for scoring and the separately replayed exact-chunk byte range for workspace
verification, so callers do not reinterpret offsets between those consumers.
It retains exact missing paths for incomplete results
and never treats a controller-admitted span as unsupported merely because its
chunk rendering contains different whitespace. Wrong-page, cross-chunk,
forged, substituted, ambiguous, or drifted evidence still rejects before
materialization. This is a source-only correction over preserved evidence; it
does not retry V20, authorize another campaign, or qualify integration.

V20 also retained one fatal local-model context failure: a 32,976-token prompt
reached a runtime frozen at 32,768 tokens while the request reserved additional
output. Current response plans bind the exact model context and a conservative
two-message capacity policy. The pipeline measures the canonical UTF-8 request
shape with a one-token-per-byte upper bound plus a fixed frozen-chat-template
ceiling, adds the full reserved output, and deterministically splits contiguous
multi-chunk batches until they fit. It repeats the exact capacity observation
immediately before invocation. If even one chunk cannot fit, the batch is
retained as a typed `model_context_capacity_exceeded` product failure with zero
model calls; later frozen batches and the document denominator remain intact.
The byte upper bound intentionally favors fail-closed extra splitting over an
ambient tokenizer or an endpoint-side token-count probe. Its two-message shape,
model identity, context, estimator, template ceiling, request digest and output
reservation are all digest-bound. This source repair does not retry V20 or
authorize a new campaign.

The consumed V26 campaign proved the frozen 283-call ceiling, but also exposed
a caller-side finalization defect. Seventeen documents reached a completed
response-controller receipt. Six of those also retained a complete canonical
source materialization, but the caller rebuilt state from raw admitted
proposals using the obsolete chunk-substring merge and incorrectly reported
`incomplete_extraction`. The other ten materializations were genuinely
incomplete, usually because `summary.first_table` was absent. The pipeline now
provides one fail-closed finalizer: it recomputes materialization from the
retained admissions, exact-compares the returned extraction and controller
receipt, and projects the already validated public and workspace citation forms
into caller state. Drifted receipts, citations, admissions, and incomplete
materializations reject; the finalizer does not infer or fill a missing field.
V26 remains immutable zero-completion evidence, and this correction authorizes
no campaign, retry, integration, benchmark, or public claim.

## Corpus design

The corpus is versioned, anonymized, licensed for its use, and split so that
development does not tune entirely against the release set. Every fixture has
provenance, expected properties, permitted uses, and a stable identifier.

Cover at least these families:

- born-digital text, scans, mixed text/image, and degraded OCR;
- simple and multi-column layouts, tables, lists, equations, and images;
- AcroForm, XFA, flattened, encrypted, signed, and malformed files;
- rotated, cropped, unusually sized, very large, and multi-document packets;
- accessible/tagged documents and documents with known PDF/UA defects;
- Windows-originated paths and filenames, Unicode, spaces, commas, and long paths;
- adversarial content, embedded links, oversized objects, and parser edge cases.

Public fixtures belong in the repository only when redistribution is clearly
allowed. Confidential or user-supplied documents stay outside Git; derived
synthetic fixtures should reproduce the failure without retaining private data.

### External olmOCR-bench regression gate

The tracked olmOCR-bench gate measures page-1 Markdown extraction and typed-gap
coverage across an external 1,403-PDF corpus. The corpus is not vendored. Its
upstream revision, seven JSONL inputs, metadata, and canonical PDF inventory are
pinned in `test/fixtures/eval/olmocr/manifest.v1.json`. Download the ODC-BY
dataset separately and verify all bytes before executing product code:

```bash
npm run eval:olmocr -- verify --bench-root /absolute/path/to/olmOCR-bench
```

A full release-candidate run and score run on a POSIX Linux or macOS host and
use exclusive, atomic, mode-`0600` JSON outputs outside the repository.
Before it reads the corpus or starts the candidate, the command requires the
output parent to be a canonical existing directory and the output target to be
absent. The same checks run again at publication, and existing outputs are never
overwritten:

```bash
npm run eval:olmocr -- run \
  --bench-root /absolute/path/to/olmOCR-bench \
  --output /private/evidence/run.json
# Retain the printed run SHA-256 independently before scoring.
npm run eval:olmocr -- score \
  --bench-root /absolute/path/to/olmOCR-bench \
  --run /private/evidence/run.json \
  --run-sha256 PRINTED_RUN_SHA256 \
  --output /private/evidence/score.json
```

The runner starts the candidate and every descendant inside a fail-closed
OS process-tree boundary with no network namespace on Linux or a deny-network
sandbox on macOS. A pinned Node preload denies common network APIs in the main
process as defense in depth. The report binds the isolation executable and
policy, Node executable, Node,
V8, ICU/Unicode, platform, architecture, the exact installed dependency tree, evaluator,
candidate source tree, and network preload. Provider credentials and proxy
variables are not inherited. A host without the required isolation mechanism
cannot run or qualify. `score` accepts only a mode-`0600`, current-user
owned run whose independently retained digest is supplied explicitly, and it
re-verifies the exact clean Git candidate and installed runtime before scoring.

The headline is the three-bucket decomposition excluding math: `pass`,
`failed_flagged`, and `failed_silent`. Percentages use attempted tests only;
`not_run` remains a separate count. Math is shown separately because it uses
a normalized-string containment proxy rather than the upstream rendered-bbox
symbol-layout test. Exact Unicode superscript and subscript presentation forms
are folded back to their base characters for matching because the corpus uses
flat TeX-like math strings and the retained reference predates the product's
presentation-preserving script projection. `failed_flagged` requires a gap relevant to the test: a
whole-text failure or truncation can cover missing content, table gaps cover
only table tests, and the math gap covers only math. Image/OCR gaps cover a
failure only when the scored extraction body is empty; they never excuse
forbidden text emitted by an `absent` failure. It is not a correctness pass.
The JavaScript fuzzy and table approximations are useful for internal
directional regression tracking only.
Every report therefore sets `benchmark_claim_ready` to false and prohibits a
public benchmark claim. A limited run, dirty candidate, conversion failure,
corpus mismatch, or binding mismatch is non-qualifying.

The `score` command is an executable gate, not just a report generator. It
exits `0` only when the run is qualifying and the pinned no-regression policy
passes: non-math pass count cannot fall, non-math silent failures cannot rise,
math silent failures cannot rise, and every category must preserve its pass
and silent-failure bounds. It writes the report before returning exit `2` for a
qualification or regression failure so the blocking evidence is retained.
The manifest binds the reference run, scorer digest, and exact reference
counts. Changing scorer semantics requires an explicit baseline review and
re-pin.

Ordinary candidate scores include a `deprecated_candidate_profile` section to
show how that candidate would look under the discarded first-run rules. It is
not a historical-compatibility assertion and is never gating. Reproducing the
original 2026-08-19 result is a separate exact-byte operation: use the retained
run whose digest is pinned in the manifest.

```bash
npm run eval:olmocr -- verify-reference \
  --bench-root /absolute/path/to/olmOCR-bench \
  --run /private/evidence/pinned-first-run.jsonl \
  --output /private/evidence/reference-verification.json
```

That command refuses any other run bytes and succeeds only when the deprecated
profile reproduces 921 / 2,922 / 3,176 and the primary scorer reproduces every
threshold used by the tracked regression gate.

### Executable corpus v0

The first executable slice lives at `test/fixtures/eval/manifest.v1.json` and is
defined by `manifest.schema.json`. Stable fixture IDs begin with
`pdf-tools.eval.v1.`. Every entry records its exact SHA-256, manifest-relative
path, provenance, redistribution terms, privacy class, partition, category, and
expected deterministic properties.

The ordinary run selects only `development`:

```bash
node scripts/eval-run.mjs
```

The release partition is deliberately separate and must be named explicitly:

```bash
node scripts/eval-run.mjs --partition held_out_release
```

This split prevents ordinary development runs from continually exercising every
release example. The committed release fixture is public for auditability, so
this is an operational holdout rather than a secret benchmark. Future private
release fixtures must remain outside Git and use a separately controlled
manifest; they must never be copied into this public corpus.

Synthetic PDFs are tiny and reproducible with
`node scripts/eval-generate-fixtures.mjs`. The manifest also references the
existing blank 2014 IRS W-9 golden fixture in place. Its upstream source is the
[IRS prior-year form](https://www.irs.gov/pub/irs-prior/fw9--2014.pdf), and its
redistribution basis is recorded as a United States government work under
[17 U.S.C. section 105](https://www.copyright.gov/title17/92chap1.html#105).
The signature-zone golden set includes a SHA-bound synthetic `/Rotate 90` page
with a nonzero CropBox. Regenerate it with
`node scripts/generate-golden-fixtures.mjs`; its test requires byte-for-byte
reproducibility and a 1.0 native-coordinate placement score.

The v0 scorers cover parseability, exact page and form-field counts,
tolerance-bounded media/crop boxes, rotation, basic per-page text extraction
through an independent parser, exact created/modified/deleted file sets, and
source-file immutability. The development corpus includes a
visibly reversed two-page PDF: it remains non-empty, parseable, and has the
correct page count, but the geometry scorer rejects the swapped page order.
This is the minimum adversarial guard against tests that only prove a PDF was
written.

### Verified long-document extraction contract v1

`test/fixtures/eval/verified-extraction/manifest.v1.json` freezes the private
P0 contract for a possible Verified Extraction Workspace before any candidate
product implementation or paired model run. The admitted corpus contains only
three deterministic ODA-authored synthetic PDFs: 288 pages, 97 schema-leaf
values, 43 citation obligations, 27 keyed-array items, and one replayable
calculation. It contains no personal data or third-party source-document bytes.

Regenerate and verify the corpus with:

```bash
node scripts/eval-generate-verified-extraction-fixtures.mjs
node scripts/eval-verified-extraction-contract.mjs
```

The manifest binds every PDF, target schema, truth oracle, and citation oracle
by exact byte length and SHA-256 digest. It binds each canonical protocol
payload and the scorer and generator sources by SHA-256. Verification independently
checks PDF page counts with PDF.js and pdf-lib, validates truth against the
declared schema subset, replays citation quotes on the declared pages, checks
key uniqueness, recomputes all denominators, and replays calculations. The
generator is byte-deterministic; any generator, scorer, protocol, or retained-
artifact change changes the manifest digest and invalidates prior v1 results.
A semantic contract change must be reviewed as an explicit version revision.

The frozen baseline is the best agent-managed workflow available from the
current public PDF tools. The preregistered candidate may add a source-bound
document map, stable bounded chunks, local intermediate state, pagination,
typed uncertainty, and deterministic replay, but it may not put a model inside
the MCP server, expose numeric confidence, read the truth oracles, silently
truncate, or perform unreported provider egress. A comparison must use the same
host model and version, settings, source and schema bytes, time budget, retry
budget, and scorer. Each role separately binds the exact exercised PDF Tools
Git commit and either its source-tree digest or its packaged-artifact digest.
Baseline and candidate product identities may differ, but neither may be
missing, inferred from the branch name, or substituted after execution.

The v1 manifest explicitly authorizes zero measured executions. Before any
future baseline call, the execution lane must retain one immutable comparison
authority. It binds the exact benchmark-manifest digest, both workflow protocol
bindings, scorer binding, shared model/provider/version,
host/platform/architecture/runtime, canonical settings, time and retry budgets,
the exact baseline product identity, the full admitted-document set, both roles,
every trial, every primary and retry attempt slot, and the
`no_product_replacement_harness_retry_only` policy. The candidate product
identity is deliberately absent and recorded as `pending_implementation`.
This permits the governed current-tools baseline to run before the candidate
exists.

After candidate implementation and before candidate execution, the lane must
retain a subordinate candidate execution authority. It adds only the exact
candidate product identity and a derived execution-plan digest bound to the
unchanged comparison-authority digest. It cannot override frozen protocols,
scorer, model, host, settings, budgets, denominator, retry policy, or attempt
identities. Creating it does not change the comparison digest, baseline
execution-plan digest, or any retained baseline receipt. Baseline results bind
the comparison authority as their role authority; candidate results bind both
the comparison and later candidate authority. The scorer rejects identity,
plan, trial, attempt, or chronology drift.

A complete campaign receipt accounts for every frozen slot exactly once as a
product result, harness
failure, or an explicitly unused retry. Aggregate verification re-scores every
retained product result from the frozen document context; it does not trust a
caller-supplied score or success flag. It rejects omitted, duplicate, substituted,
unplanned, resumed, or replacement attempts. Product failures and trials ending
in harness failure remain in the frozen trial denominator. The aggregate receipt
also publishes campaign-wide frozen document, leaf, citation, keyed-array, and
calculation denominators with deterministically recomputed numerators; a trial
ending in harness failure contributes its full obligations and zero numerators.
Aggregate completion requires both the immutable comparison authority and the
later candidate execution authority, even when all candidate attempts end in
harness failure.

Product identity uses the canonical `pdf-tools-product-identity.v1` shape:
source execution binds a 40-hex Git commit and its 40-hex Git tree; packaged
execution binds a 40-hex Git commit and the exact package SHA-256. Contract
validation proves only syntactic shape and immutable digest binding. It does
not prove that the Git object or package exists or that those bytes were
actually exercised. E9E.2 therefore remains blocked until an independent
preflight verifies the commit and observed clean tree, or the commit and
observer-computed digest of the exact executed package. That retained preflight
and independent observation are execution evidence, not an inference from this
contract or its unit fixtures.

E9E.2 must independently retain the comparison authority before baseline and
the subordinate candidate authority before candidate execution; timestamp
ordering alone is not evidence of preregistration. Missing or mismatched
bindings are harness failures and cannot produce a role score or complete
campaign receipt.

Primary scoring is exact and deterministic: schema validity, leaf precision
and recall, keyed-array precision and recall, citation replay, calculation
replay, silent omissions, and truncation. The frozen denominator comes from the
truth and citation oracles, never candidate output. Harness failures and
product failures are separate named taxonomies. A model judge may provide
secondary qualitative analysis but cannot change, excuse, or override a
deterministic failure.
Extra submitted citation paths fail the primary gate. Rates with a zero
denominator are `null` (not applicable) and must be excluded from macro
averages, never treated as 100 percent.

Two PDFs are development cases. `citation-calculation-72` is held-out
calibration: its truth and citation files are validator-only until both paired
protocols and scorer bindings are frozen. Failed runs remain in the denominator;
they cannot be replaced, tuned away, or omitted. A retry may follow a retained
harness failure only within the frozen slots; no retry may follow or replace a
product result, including a deterministically failing result.

VAREX, RealDoc-Bench, and LongExtractBench-50 are recorded as external
candidates but are explicitly not admitted. VAREX does not match this frozen
long-document workload. RealDoc-Bench source documents require per-document
license and takedown review even though its published annotations have a dataset
license. LongExtractBench-50 says source PDFs retain their original rights. No
external corpus bytes were downloaded or treated as rights-cleared for v1.

This suite is `private_synthetic_calibration_only` and always reports
`benchmark_claim_ready: false`. It can gate exact internal regressions and
support a fully qualified private paired comparison. It cannot support a public
benchmark, state-of-the-art claim, real-world-document claim, provider-quality
claim, or numeric-confidence claim.

This three-document synthetic campaign is mechanics calibration, not the real
P1 baseline. A separate rights-admitted public-pilot corpus tranche must pass
admission and independent review before E9E.2 can be described as a real P1
baseline.

### Experimental source-bound document map

E9E.3 introduces a pure experimental contract in `server/document-map.js`.
It is not registered as an MCP tool and is not candidate-execution authority.
The contract consumes exact PDF and schema bytes plus already validated
Extraction IR pages. It binds their source and schema SHA-256 identities, the
pinned parser and IR, the deterministic renderer identity, and the complete
chunk policy before producing a document-map digest.

Chunks prefer renderer-supported heading boundaries, otherwise use fixed
line and UTF-8 byte ceilings. Each stable chunk identity binds the source,
schema, parser, IR, renderer, policy, page and line range, admitted item-ID
digest, and content digest. Reading a chunk reconstructs the complete map and
fails closed if any binding or returned descriptor has drifted.

The compact map reuses the active renderer's heading, table-gap, and
cross-page page-furniture evidence rules. It reports exact observed, returned,
and omitted counts for pages, source items, source characters, chunks,
headings, table regions, and typed gaps. Output caps retain counts plus a digest
of the complete hidden inventory; omitted chunks cannot be read through the
bounded contract. No OCR, schema filling, numeric confidence, model call,
provider egress, truth-oracle access, or benchmark claim occurs in this layer.

### Experimental transactional extraction workspace

E9E.4 adds a model-free private artifact contract in
`scripts/verified-extraction-workspace.mjs`. It is deliberately outside the
MCP server and both package inventories. Creating a workspace revalidates the
complete E9E.3 document map from the exact PDF bytes, schema bytes, Extraction
IR pages, renderer, and chunk policy. It then binds that map, the admitted
schema-leaf obligations, and strict byte, record, generation, and pagination
limits into one immutable workspace identity. Loading a workspace recomputes
the retained document-map digest from the map body itself; re-authoring a
generation inventory around changed map bytes cannot preserve the workspace.

Creation writes a durable root-level creator claim before exposing any
initialization directory. That claim binds the workspace, transaction,
initialization directory, and workspace identity. A crash before the first
directory or static artifact can therefore be abandoned only with the exact
physical claim digest and independently retained initialization-workspace
identity. If static identity bytes exist, abandonment reconciles those bytes
to the same authority before it proceeds. The claim is removed only after
genesis publication succeeds or after an immutable root-level abandonment
tombstone is durable.

The workspace root and every generation directory are mode 0700; retained
files are mode 0600. Physical-path, no-symlink, file-identity, exact-inventory,
and canonical-byte checks fail closed. Static artifacts are assembled and
fsynced in a private unique sibling directory. The canonical 0600 pointer is
retained with those static artifacts and atomically hard-linked into the
deterministic workspace slot with exclusive no-replacement semantics; a reader
therefore sees either no pointer or the complete retained pointer bytes, and an
existing file, link, or empty or non-empty directory is never replaced. A crash
during static writes cannot expose or strand a partial authoritative workspace.
Unpublished initialization scratch is never silently pruned; its explicit
abandonment requires the exact current pointer identity when one exists,
refuses a missing or substituted creator claim, reconciles any retained static
identity, writes a nonreplaceable transaction tombstone before cleanup, refuses
links, unsafe modes, writer or generation history, and cannot remove the
directory named by the authoritative pointer. Creation and genesis recovery
both consult the tombstone, so an abandoned transaction can never be reused.
Creation, genesis recovery, and abandonment share one exclusive per-transaction
operation lease. Its exact owner bytes are atomically hard-linked into place;
a live owner rejects every overlapping operation, while a dead owner can be
reclaimed by exact physical identity. Creation holds the lease from before its
tombstone check through genesis publication, so abandonment cannot linearize
between any check and filesystem progress.
Writers first retain one
exact internal transaction claim, then atomically hard-link those same bytes
into the external per-workspace operation slot used by deletion. A writer
cannot mutate generation state until it owns that shared exclusive slot, and
deletion cannot publish its intent while a writer owns it. If deletion wins
after a writer's initial scan, the unadmitted internal claim is removed before
unpublication and cannot advance. The admitted writer then writes append-only
events and replayed canonical
state in a staging generation, fsync those artifacts, and write the generation
manifest last as the commit marker. Only a complete manifest-bound generation
may be renamed into the immutable linear history. A missing marker, retained
claim, crash after rename, or incomplete genesis is reported as uncertain and
requires an explicit exact-transaction recovery decision; incomplete work is
never guessed complete. The genesis transaction is itself frozen into the
workspace identity. If a crash occurs after the complete static workspace is
published but before the genesis writer claim exists, inspection reports
`initialization_recovery_required`; the dedicated recovery action accepts only
that already-bound transaction, the exact retained creator-claim digest, and an
otherwise empty pre-genesis history.
Abandoned transaction IDs cannot be reused.

Proposals bind an admitted leaf and one or more returned E9E.3 chunk IDs. They
persist only as `unverified/not_replayed`; this layer has no promotion or result
path. Stable opaque cursors bind the workspace, retained generation, collection,
complete collection digest, offset, and page limit. Every page reports exact
total, returned, and omitted-before/after counts and fails if even one retained
item exceeds the frozen byte ceiling. Generations are never silently pruned.
Irreversible workspace deletion requires the exact workspace identity and
current generation digest, rejects links or unexpected file types, and durably
publishes a canonical external deletion intent before it unpublishes the
pointer or removes data. The intent binds the private directory, workspace
identity, final generation, and pointer bytes; it blocks republication and
survives partial recursive removal. Exact completion can therefore resume from
any remaining safe subset without rereading artifacts already removed, and
clears the intent only after the data directory is durably absent. Completion
requires the originally returned pointer digest; a complete intent resumes by
validating and unpublishing an active matching pointer when necessary. Only a
structurally incomplete intent, or one stale against the exact active
generation, may be abandoned while that workspace remains authoritative; a
complete current deletion authority cannot race deletion by taking that path.

This contract performs no model call, provider egress, holdout-oracle access,
candidate execution, scoring, publication, or benchmark claim. It remains
experimental and excluded from release artifacts until a separately reviewed
product-integration tranche authorizes that boundary change.

### Experimental source-replayed proposal verifier

E9E.5 adds the model-free private verifier in
`scripts/verified-extraction-proposal.mjs`. It loads the named proposal only
from the exact complete current E9E.4 generation, rejects a second assignment
to the same leaf, and revalidates the E9E.3 map from the exact PDF bytes,
schema bytes, Extraction IR pages, renderer, and chunk policy. Citation inputs
contain only a returned chunk ID, exact UTF-8 byte range, and quote digest. The
verifier reconstructs the chunk and quote from fresh source; caller text,
source identity, page, geometry, confidence, and table topology are not proof.

The supported schema subset is explicit and fail-closed. It includes bounded
objects, arrays, strings, numbers, integers, booleans, nulls, constants, enums,
exclusive `anyOf`, calendar dates, item and length bounds, `uniqueItems`, and
the frozen `x-key` convention for keyed arrays. Duplicate JSON members,
unsupported schema keywords, duplicate whole-array items, missing keyed-array
identities, and duplicate keyed-array identities reject. The verifier does not
silently treat an unsupported JSON Schema feature as if it had been enforced.
String lengths count Unicode code points. Every raw schema numeric token is
accepted only when its JSON spelling is a canonical safe integer. Decimal,
exponent, negative-zero, and out-of-range spellings reject from the raw UTF-8
text before ordinary JSON construction can round or underflow them.

`verified_exact` means a declared identity or narrow ASCII normalization
replayed the proposed value. `computed_with_inputs` means an allowlisted sum,
difference, product, or quotient over two or more bounded decimal citations
replayed exactly as a rational calculation; its retained input-selection status
remains `unverified_reasoning` because arithmetic replay does not prove that the
right business inputs were chosen. `source_supported`, `ambiguous`,
and `unverified_reasoning` retain exact source citations while explicitly
preserving the semantic judgment that this layer cannot prove. `not_found`
requires a null proposal, no citations, every returned chunk ID, complete
accounting, no omitted admitted bytes or chunk material, complete page
extraction, and no visual-inspection flag. It cannot turn missing or truncated
scope into an absence claim.

`decimal_ascii` never converts source text to a floating-point value before
comparison. It compares the bounded source decimal and the canonical JSON
representation of the proposed number as exact fractions, and rejects proposal
representations that require exponent or otherwise unsupported numeric syntax.

The canonical result retains and replays the complete content-addressed proposal
event, including its workspace identity, leaf, proposal value, chunk inventory,
and unverified state, as well as the proposal value digest. A `not_found` result
also retains the exact map digest, returned chunk inventory, page states, and
zero-omission accounting that authorized the complete search. Standalone result
validation deterministically replays those bindings and the method over retained
citation bytes, and requires the status, reasons, derived value, and every
calculation field to match that replay. These hashes prove internal binding, not
that re-authored bytes belonged to an actual workspace generation; authentic
workspace membership still requires the exact external workspace and map bytes
used by `verifyWorkspaceExtractionProposal`. The canonical digest is integrity
formatting and cannot make an internally impossible re-authored result valid.

This general verifier never promotes table topology. The separately shipped
`verify_table_proposal` contract remains the only specialized table-structure
verifier, with its existing fresh-parse, coverage, ordering, and ruling checks.
E9E.5 performs no model call, provider egress, holdout scoring, candidate
execution, release packaging, publication, or benchmark claim, and remains
excluded from both package inventories.

### Experimental source-supported agency evidence

The failed E9E.6 candidate retained source-backed contributors, table regions,
and occasional publication citations, but every valid model proposal left the
required publication agency unset. The bounded repair in
`scripts/verified-extraction-agency-evidence.mjs` does not infer an agency from
the filename, corpus, report family, or a later-page organizational mention.
It proposes an agency only when one page-one document-map chunk contains the
literal parent organization, literal agency, and a recognized publication
series line. The proposal cites the exact agency string in that same chunk.

The current experimental policy admits only the exact U.S. Department of the
Interior / U.S. Geological Survey title-page signature. Case changes,
normalization, missing hierarchy or series evidence, later-page evidence,
unbalanced duplicated lines, and more than one qualifying chunk reject. A
completely duplicated title block is admitted only when the parent, agency,
and identical series line repeat in balanced counts, matching observed
renderer duplication while preserving one exact citation value.

Document-map version `1.1.0-experimental` preserves every retained first-page
line even when the renderer's cross-page furniture detector recognizes the
same masthead elsewhere. This keeps cover-page agency evidence source-citable
without disabling bounded furniture removal on later pages.

This helper supplies a source-supported candidate proposal; it does not weaken
the measured schema, scorer, citation replay, or complete-result contract. It
performs no model call, provider egress, holdout-oracle access, scoring,
execution authorization, or benchmark claim. It remains internal and excluded
from the MCP server and both package inventories. Any measured use requires a
wholly new comparison authority with new trial and attempt identities.

The same internal module also exposes a bounded publication-citation proposal.
It accepts one exact page 1–4 document-map chunk containing the literal standard
USGS public-domain disclaimer followed immediately by either the exact
`Suggested citation:` marker or the standard unlabeled citation form. It retains
the exact source bytes only through the first DOI-ending sentence and excludes
associated-data material. Missing or normalized labels, later-page references,
unsupported series, missing DOI evidence, ambiguous chunks, and non-map chunk
identities fail closed. As with agency evidence, the helper only proposes; the
candidate controller must explicitly invoke it and replay its exact citation.
One labelled citation may follow the last of multiple byte-identical standard
disclaimers because the sole exact marker makes that source block unambiguous;
multiple unlabelled disclaimer blocks still reject.

## Scoring contracts

Accessibility claims have an additional fail-closed evidence ladder. The
executable catalog-level screen, adversarial false-certification fixtures,
claim taxonomy, provenance rules, human-review boundary, and standards sources
are defined in [Accessibility Evaluation and Claim Safety](ACCESSIBILITY_EVALUATION.md).
Passing that screen is explicitly not evidence of PDF/UA or WCAG conformance.

### Deterministic graders

- protocol negotiation, tool-list stability, JSON Schema validity, and result shape;
- exact or tolerance-bounded form-field values and CSV round trips;
- page count/order/rotation/crop boxes and expected filesystem effects;
- signature and annotation geometry, including coordinate-system conversion;
- output readability across independent PDF parsers;
- text coverage, reading order, page anchors, table-cell structure, and schema validity;
- visual pixel or region differences with documented tolerances;
- no unintended mutation, overwrite, partial output, external request, or data escape;
- artifact contents, native binary inventory, startup, and render output;
- latency and peak-memory budgets on named hardware classes.

### Model graders

Use rubric-scored model judgment only for qualities such as error clarity,
workflow choice, summary usefulness, comparison salience, and whether a visual
change matches the user's intent. Pin the grader prompt and model, retain the
reasoning-independent score record, calibrate it against human labels, and do
not let it override a deterministic failure.

### Human gates

Human review remains mandatory for release authorization, signature intent,
claims of accessibility or legal compliance, destructive or externally shared
outputs, and ambiguous fidelity decisions. Human approval is a product boundary,
not a missing automation feature.

## Agent-workflow trials

Each task specifies the user job, starting files and permissions, allowed side
effects, expected evidence, success rubric, and failure conditions. Run multiple
unique trials when agent choice or generation is involved. Report attempted and
product trial counts, harness-failure rate, pass rate, sample variance, standard
error, and—only after independence gates pass—a 95% Wilson interval. A perfect
observed rate still has uncertainty; do not present zero observed variance as
proof of perfect reliability, and do not compute inferential bounds over cloned
fixtures or trajectories.

Score the complete trajectory:

- selected the right tool sequence and did not invoke irrelevant or forbidden tools;
- inspected before mutating and used the current active document correctly;
- asked for missing information and explicit intent at consequential boundaries;
- cited the page, region, field, or file that supports important claims;
- verified the produced file rather than trusting a success string;
- described limitations and recovery actions accurately;
- did not expose tool mechanics or claim effects that did not occur.

Representative jobs include inspect-and-answer, form fill and validation,
structured extraction, compare-and-explain, page-plan transformation,
accessibility assessment, prepare-for-signature, and multi-document packet work.

### Agent-workflow planning protocol v4

The public v4 planning-protocol core, its synthetic no-model rehearsal, its
private-input boundary, and its relationship to historical v3 evidence are
documented in `docs/AGENT_WORKFLOW_PROTOCOL_V4.md`.

Public synthetic calibration proves only deterministic protocol wiring. A real
planning campaign requires frozen private cases and oracles, a reviewed model
host, an accepted case-free canary, and separate seal, measured-campaign, and
publication authorities. Planning-response evidence does not replace
configured-MCP trajectories or native-host product evidence.

### Executable trajectory contracts v1 and v2

The first executable L5 contract lives in the frozen
`test/fixtures/eval/trajectories/jobs.v1.json`. The newest executable job set is
`test/fixtures/eval/trajectories/jobs.v2.json`, which binds the frozen 40-tool
`tool-contracts.v2.json` projection rather than the live runtime surface. Both
version the same six public-safe jobs:
inspect-and-answer, fill-and-validate, compare-and-explain, safe page mutation,
prepare-for-signature, and path-policy error recovery. Each job declares:

- allowed, forbidden, inspection, mutation, and required tool groups;
- exact required semantic calls, including nested argument values rather than
  only the presence of argument names;
- whether inspection must precede mutation;
- allowed created, modified, deleted, external-request, and signature effects;
- declared input/output evidence sources plus required page, field, region, and
  file evidence;
- verified-output and limitation requirements.

The six job IDs deliberately remain `pdf-tools.trajectory.v1.*` in v2 because
they are stable task identities, not evidence-version identities. V2 trial,
run, event, step, and result IDs use a separate namespace. The v2 suite validates
every invoked tool against the complete 40-tool v2 contract, but these six
jobs are not behavioral trajectory coverage for even those 40 tools, and the
live runtime surface has grown past them. In particular,
`get_pdf_identity` has separate contract, handler, and workflow tests and is not
invoked by the six retained trajectory jobs.

The v4 grader uses strict, independently versioned suite, trial-set, trial, run,
host-event, step (currently v2), result, effects, artifact, evidence, claim, and harness-failure
records. Unknown fields and ambiguous success/error records are rejected. A
required tool counts only after a successful call with its required arguments
and a non-null, hashed retained MCP result. An observed source must also appear
in that call's path arguments. Every trajectory call is validated against the
actual schemas returned by the suite-selected, allowlisted contract. Historical
v1 runs bind `tool-contracts.v1.json`; v2 runs bind
`tool-contracts.v2.json`. The current runtime projection is
`tool-contracts.v3.json`; future runs against the exact-output-identity schemas
must bind v3 explicitly. Each suite pins the runtime version and contract
digest, and the grader selects the matching trust registry and tool schemas
from that policy rather than silently applying the newest contract.
Regenerate and verify that contract directly from the running MCP server with:

```bash
node scripts/eval-capture-tool-contracts.mjs
```

Evidence binds to a successful result ID, its source, and a typed semantic
observation such as the exact page, field/value digest, region, page plan,
signature location, or file. A retained result hash by itself is not semantic
evidence, and a claim's own `supported` boolean is not evidence. Fixed public
jobs also pin expected result observations (including page-text and field-value
digests) and require a schema-shaped JSON terminal answer whose canonical digest
matches the expected value; merely mentioning the expected words is insufficient.
Output artifacts require a separately retained filesystem-observer event whose
SHA-256 agrees with the producer result, artifact record, and a distinct,
successful, path-bound post-mutation verifier result. The filesystem observation
must occur after the recorded completion time of both production and verification,
so a pre-mutation snapshot, in-flight output, or unrelated output cannot satisfy
the gate. The fill job specifically
requires field inspection before mutation, validation, and an exact field
read-back afterward; an observed output hash is artifact-integrity evidence, not
proof that the agent completed the full job or preserved every non-target field.

`test/eval/trajectory-grader.js` treats forbidden tools, uninspected mutation,
fabricated or stale signature intent, escaped or unproven effects, unsupported
important claims, missing terminal answers, unverified outputs, and failed
recovery as hard failures. Signing intent is checked with the same production
validator as `apply_signature`, must match the exact tool arguments, and is
revalidated at every signature-call timestamp—not only the first. It must bind
to a retained user-confirmation host event. Recovery requires a retained raw
`ok:false` error with the declared denial code and denied argument, followed by
an allowed successful call explicitly bound to that failure. A terminal answer
must follow the final tool call and precede a retained completed-turn event.
Harness failures are classified separately only when a strict phase/error record
binds to trusted host provenance; a bare `harness_failure` label is invalid, and
a benchmark stays blocked when the configured maximum harness-failure rate is
exceeded.

The provider-neutral signing-preparation contract is evaluated separately from
signature intent and provider execution. Focused tests exercise both source and
share runtimes, independently rehash the source and committed output, replay the
canonical receipt digest, verify rotated MediaBox/CropBox regions, and prove
that confidential field values are absent from the receipt. Hostile cases must
reject unknown properties, malformed or duplicate zone identities, duplicated
zone geometry, partial participant bindings under the readiness gate,
field-write
failure, off-page geometry, and CropBox clipping without committing an output.
Same-document coverage rehashes the immutable-original backup and requires its
path, size, and source-matching SHA-256 in the receipt. Zone evidence-source
labels remain caller-declared rather than independently replayed. These checks
establish a local preparation contract only: they do not call a signing provider or prove
identity, consent, delivery, completion, cryptographic signing, or legal
validity.

For render evidence, grading decodes the retained PNG again, independently
renders the SHA-256-pinned corpus source, recomputes the normalized pixel and
foreground comparison, and applies the perceptual thresholds to that fresh
replay. Native raster bytes vary slightly by operating system, so the full
capture-host oracle record must also match a complete preimage in the
suite-pinned `visual-oracle-approvals.v1.json` artifact. That artifact records
the capture kind, host, architecture, OS build, Node and renderer versions,
source/page/scale/region request, retained-image origin and digest, exact
oracle object, canonical oracle digest, source-file digests, review method, and
review date. The trust registry points to the artifact by ID and canonical
SHA-256, and the suite independently pins the same ID and digest. V2 reports
retain the exact canonical SHA-256 of both the trust registry and approval
artifact so later registry edits cannot silently change the resources attributed
to an exported result. The grader additionally binds the stable
fixture, source, normalized dimensions, and retained-image digest across the
record and replay. Neither fabricated stored metrics nor a favorable stored
pass flag can replace the replay.

The trust registry pins the canonical digest of the entire suite, including
prompts, thresholds, policies, and forbidden tools. Correction lineage is
approved per job, so a failure from one workflow cannot be relabeled with a
different workflow's regression. Changing any suite content requires an
intentional registry update and review.

Run the deterministic grader calibration with:

```bash
node scripts/eval-run-trajectories.mjs
```

The committed calibration set contains two passing product trials, one
deliberately failing product trial, and one harness failure for every job. The
runner reports descriptive sample statistics, harness-failure rates, and
failure-class counts. It deliberately withholds Wilson bounds because repeated
calibration payloads are not independent samples. Repeat indices, run IDs, and
host-event IDs must be unique, but uniqueness of labels alone is insufficient.
Independence is based on distinct fixture instances and the job's pinned
semantic operation as well as inputs, seeds, invocation provenance, transcript
digests, and runs; changing an irrelevant optional argument cannot turn cloned
work into independent evidence. Input and fixture-instance hashes must bind to
retained filesystem-observer events rather than observer labels alone. Each deliberate calibration
failure carries a Bead and regression reference approved by the versioned trust
registry. The generator reproduces the calibration file exactly:

```bash
node scripts/eval-generate-trajectory-calibration.mjs
```

These generated records exercise the grader; they are **not observed agent or
native-host benchmark results**. The report therefore keeps
`benchmark_claim_ready: false` even when the synthetic sample count reaches the
configured minimum.

The runner also accepts measured non-calibration trial sets. Every set must keep
an explicit claim boundary, and meeting the minimum sample count does not widen
that boundary. Claim readiness is the conjunction of approved suite/corpus,
cryptographically trusted ingestion, sample independence, per-job sample size,
and harness-health gates. The repository intentionally authorizes no planner or
result-attestation public keys and contains no private signing keys; unsigned ad
hoc runs are useful product evidence but cannot become benchmark claims. The
generator writes `calibration-trials.v2.json`. Its embedded PNG reference
bytes are regenerated byte-for-byte on the Linux reference platform because
native PDF rasterization is not byte-identical across operating systems.
Any host that runs the suite validates the committed v2 fixture's complete
schema, suite binding, run plan, retained-image hashes, approved capture-oracle
digest, and grader behavior. Current retained receipts cover the Linux reference
host and Silverbook Darwin compatibility replay; Windows native-host evidence
remains a separate release gate. V2 trial, run, event, step, and result
identifiers use a distinct namespace and do not collide with v1 evidence
identities. The v1 suite, calibration fixture, tool contract, and trust registry
remain frozen historical evidence and are not silently rebound.

The active trust registry is
`test/fixtures/eval/trajectories/trust-registry.v2.json`. Its pinned approval
artifact contains reviewed Linux-origin reference replays and Silverbook
Darwin compatibility replays for the two rendered corpus fixtures. The Darwin
receipts replay the same Linux-origin retained PNGs against Darwin-rendered
references; they are not Darwin-origin product captures. Tests recompute every
receipt's full canonical oracle digest and grading fails closed when a source
approval is absent. Approval lookup binds the complete
source/page/scale/region request, and cross-platform lineage compares the
normalized retained-image pixel digest while the render record separately binds
the exact PNG bytes. The v1 trust stack remains unchanged for the frozen
39-tool comparison evidence; current runs do not reinterpret that historical
evidence.

Before authorizing any measured-claim keys, the measured runner must preserve
live tool failures as `isError: true` with stable structured error codes, capture
start and completion timestamps independently for every call, and execute the
native-host matrix below. Synthetic calibration records cannot satisfy any of
those prerequisites.

## Schema-directed verified-extraction routing

The experimental verified-extraction pipeline does not treat every document
chunk as equally relevant to every schema. Its schema-directed entrypoint first
builds a deterministic evidence plan from the retained document map and
canonical source-page bundle. For the current publication schema, the plan
selects only the labeled or source-identified front-matter publication-citation
page, an earlier credited-name page, and the earliest classified
actual-data-table page. Reference-section chunks are ineligible. The response
controller retains the complete document
chunk denominator while separately binding the routed and unrouted counts, and
it rejects a routing plan that cannot be rebuilt from the exact retained source
evidence.

A zero-inference private replay over the 30-document development corpus reduced
the worst-case context-split request count from the approximately 590 calls
projected for near-exhaustive coverage to 108 routed calls. On the 11 completed
results available from the consumed predecessor run, deterministic source-bound
projection produced 11 semantically valid results and replayed all 74 citation
obligations under the private source-replay-v2 contract. The older exact-window
diagnostic matched 21 of those 74 citations; it remains a secondary diagnostic
because a different literal source span can support the same value.

These are internal product-development measurements, not a rerun campaign or a
public benchmark. The router and projection perform no model or provider call,
do not read the private truth or citation oracle while choosing evidence, and
retain `benchmark_claim_ready: false`. A future measured campaign must freeze
the exact router/controller bytes and demonstrate its own complete receipts,
resource usage, and private score before any integration or performance claim.

Private acceptance uses the experimental source-replay scorer rather than
requiring equality with one hidden excerpt window. The scorer binds the exact
schema bytes, normalized source-page bundle, PDF and document-map identities,
and the complete retained chunk inventory. Every required citation must be a
literal span on the submitted page, support the canonical submitted value, and
map to a page represented in that bound chunk inventory. Missing, extra,
duplicated, substituted, stale, or unsupported evidence fails closed. Exact
equality with the frozen oracle window is reported separately as a diagnostic
and does not override valid source support.

The routed canonical projection is also the verified-workspace state; it is not
merely a scoring overlay. Publication, contributors, summary, and citation keys
are identical between the canonical result and workspace proposal state. Each
workspace citation deterministically selects the strongest exact retained
source chunk by literal support, quote and value token coverage, cited-page
agreement, and finally the frozen document-map chunk order. Its workspace page,
quote, byte range, and digest describe that replayed chunk itself; the public
canonical citation remains separately unchanged. This distinction handles
repeated report headers and renderer/oracle text-window differences without
inventing support or silently choosing an unbound representation. Missing,
stale-content, cross-document, or unsupported mappings fail before workspace
mutation, so reference-derived extras cannot survive in a parallel
pre-canonical state.

The retained V29 projections were replayed again through the repository scorer:
11/11 documents were semantically valid, all 74/74 citation obligations replayed
from their bound source, and zero deterministic failures remained. Only 21/74
quotes equal the oracle author's chosen window byte-for-byte. This private
offline replay used no model or provider call, leaves prior scores immutable,
and does not authorize a benchmark or public claim.

Future verified-extraction campaign writers must keep execution completion and
product acceptance separate. The repository campaign-completion summary
consumes the exact retained index bytes rather than a caller-authored parsed
object. It binds those bytes by both physical and canonical digest, checks the
seven index authority/runtime bindings plus preflight state against a separate
trusted expected-binding file, and checks the exact frozen document ID/order
denominator. Every indexed receipt digest must then bind one exact retained
receipt file whose document ID and outcome match its row. Result rows are
retained in frozen order and counted only from their exact `completed`,
`product_failure`, or `harness_failure` classification. The summary never emits
an unqualified `ok`; it reports
`controller_index_completion_status: complete` separately from
`product_acceptance_status: not_evaluated`. Semantic product acceptance can be
decided only by the later offline scorer, including when every document row is
completed.

The exact physical execution-index SHA-256, expected-binding file, and that
file's separately supplied exact physical SHA-256 pin are trust inputs. They
must come from the independently frozen authority and denominator, never be
regenerated from the candidate index being checked. This prevents a fully
resealed receipt and matching index outcome from replacing the frozen result.
Replacing all of those trust inputs and the retained artifacts together remains
outside what an unsigned post-hoc source contract can authenticate. Index,
expected-binding, and receipt JSON also reject duplicate object members at any
depth before any binding or outcome is admitted.

The source-controlled post-hoc boundary is read-only:

```bash
node scripts/summarize-verified-extraction-campaign.mjs \
  --index /exact/retained/execution-index.json \
  --index-sha256 <trusted-index-physical-sha256> \
  --expected-bindings /trusted/expected-bindings.json \
  --expected-bindings-sha256 <trusted-physical-sha256> \
  --receipt /exact/retained/receipt-1.json \
  --receipt /exact/retained/receipt-2.json
```

It exits zero only when the complete index/receipt set authenticates, regardless
of the later product-acceptance decision, and exits nonzero on any integrity or
denominator failure. There is no source-controlled V29/V30 campaign writer to
wire: the historical stdout producer exists only inside immutable sealed
evidence. This adapter does not mutate or reinterpret that historical stdout.
Future executable campaign authorities must call this contract or bind
equivalent logic before claiming execution completion. Real V29/V30 retained
indexes and receipts are private evidence rather than stable source-controlled
fixtures, so repository tests exercise byte-exact synthetic replays; real
retained replay remains an external evidence-validation step and cannot be
closed by this repository alone.

A campaign controller may therefore exit zero after it durably retains every
frozen attempt and the final execution index even when one or more document
outcomes failed. That exit means only that campaign execution and indexing are
complete; it is not a product pass. The calibration command keeps its existing
pass/fail `ok` field and matching exit behavior because calibration is a
different, one-call mechanics gate rather than a multi-document campaign
completion contract.

Campaign-wide model-call exhaustion is a typed, denominator-preserving outcome,
including when it occurs between document batches. Response-controller receipt
version 3 retains `model_call_budget_exhausted` without silently renaming the
historical `completed_request_count`; malformed lookalike errors remain ordinary
controller failures. The field's retained meaning is versioned by campaign:
V29 historical tool-model trace failure events use a document-local
completed-request count, while the V30-and-later typed ledger contract uses the
campaign-wide reserved-call ledger count. In both cases `observed.model_calls`
and each batch's model-call count
remain local to that document attempt. A caller can reconstruct the typed error
only from a digest-valid receipt. Attempt page partitions must be derived from
the ordered, durably retained page inventory: retained pages survive a later
model-budget failure, while failure to retain the aggregate trace clears
processed pages rather than claiming unsupported work. Zero retry and no
replacement still apply, and every
later frozen slot remains in the campaign index.

Each trial set includes an invocation run plan that defines the denominator
before execution. The plan binds the trial-set ID, suite ID and digest, claim
boundary, semantic operation, fixture instance, and seed. Its signature uses a
separately authorized planner key, and every run retains the full plan digest in
an agent-host event captured no later than run start. Every planned invocation
must resolve to exactly one product
trial or one harness-failure record; a launch that never produces a transcript
cannot silently disappear. The attestation binds the run-plan digest as well as
the suite and trial payload digests. Its signed payload also binds the claim
boundary, attestation kind, producer, and key ID, preventing those trust fields
from being rewritten after signing.

Raw `codex exec --json` streams can be normalized with an external observer
sidecar:

```bash
node scripts/eval-ingest-codex-trajectory.mjs \
  --plan pre-run-plan.json \
  --raw codex-events.jsonl \
  --observer filesystem-observer.json \
  --output measured-trial.json
node scripts/eval-run-trajectories.mjs --trials measured-trial.json
```

Multi-invocation plans must be ingested as a complete batch, so a partial first
result cannot redefine the denominator. A batch manifest contains
`{"runs":[{"raw":"run-1.jsonl","observer":"run-1-observer.json"}, ...]}`;
paths are relative to the manifest:

```bash
node scripts/eval-ingest-codex-trajectory.mjs \
  --plan pre-run-plan.json \
  --batch batch-manifest.json \
  --output measured-trials.json
```

The ingester is fail-closed over the Codex event stream. It accepts only the
declared thread/turn lifecycle events and completed agent messages or PDF MCP
calls; command execution, file-change, web-search, unknown item types, unknown
terminal statuses, unfinished calls, and calls to undeclared servers are
rejected rather than dropped. It rejects null successful results, hashes
retained raw tool results and failures, derives error codes only from those raw
failures, and requires the terminal agent message to occur after the final PDF
tool call and before `turn.completed`. A planned launch failure is normalized
explicitly as a harness failure and remains in the run-plan denominator. Once a
PDF tool call completes, the run is a product trial and cannot be relabeled as a
harness failure merely because the answer or product result was bad.
Tool arguments and completion/error state come from Codex JSONL; observed input
sources, filesystem effects, artifact existence/hashes, and evidence annotations
come only from the strictly validated separate observer record. Agent prose is
never accepted as an effects or artifact oracle. The attestation binds the raw
transcript, observer sidecar, suite, run plan, normalized trial payload, and
claim/trust fields, preventing a later JSON edit from inheriting trust. If the
agent emits no terminal answer,
the record is still a valid product trial with `present: false` and must fail
rather than being discarded as malformed or relabeled as a harness failure.
Real L5 claims must retain run/host metadata and references without committing
private document content. A host timeout remains a harness failure even when
the same task later passes.

## Verified extraction product surface

The model-free workspace primitives qualified during the private verified-
extraction evaluation are now exposed as an experimental local MCP lifecycle:
create an exact PDF/schema-bound workspace, page through its document map and
leaf obligations, submit an explicitly unverified proposal, replay citations
against fresh source bytes, retain a typed result, inspect state, and delete
under exact identity/generation bindings. The server does not run a model,
accept numeric confidence as proof, or import the private benchmark scorer or
truth oracle. See `docs/VERIFIED_EXTRACTION.md`.

Shipping the workspace does not convert any private campaign into a public
benchmark claim. Product tests prove deterministic contract behavior; benchmark
claims still require their separately frozen corpus, authority, denominator,
execution, score, and rights gates.

## Native host matrix

The release matrix distinguishes server compatibility from official host
support. A release record names the exact operating system, architecture, host
version, Electron/Node runtime where observable, artifact hash, and result.

For Claude Desktop releases, macOS ARM64 and Windows x64 are hard release lanes.
Linux artifact smoke is useful server evidence but is not a substitute for a
supported Claude Desktop host. A second macOS machine is a valuable clean-profile
and upgrade-path lane, not a replacement for Windows.

Native UI automation may drive install, tool discovery, prompts, viewer actions,
screenshots, and log capture. It must use stable accessibility selectors where
possible and pair visual evidence with protocol/file assertions. Computer-use
models can supplement exploratory and black-box testing; they are not the sole
release oracle.

## Release evidence bundle

Every release candidate should retain:

- source commit and tag; dependency lock and manifest/version diff;
- MCPB and companion artifact sizes and SHA-256 hashes;
- archive inventory, native-target inventory, license/SBOM output, and secret scan;
- exact commands and results for unit, property, protocol, corpus, and artifact tests;
- native-host versions, install evidence, tool discovery, core-job transcript,
  screenshots, and relevant logs for each required lane;
- agent-workflow scorecard with trial count, grader versions, failures, and variance;
- known limitations, deferred hosts, risk acceptance, and approving maintainer.

Release evidence is immutable for that artifact hash. Repacking—even for
metadata—creates a new candidate that must pass the artifact and installation
gates again.

## Continuous improvement loop

The operating loop is:

**observe → frame the user job → research → benchmark the baseline → plan →
adversarially review the plan → implement the smallest useful slice → run
deterministic gates → run native-host and agent trials → adversarially review the
result → dogfood → ship with evidence → convert corrections into fixtures →
review the scorecard and repeat.**

A change is not complete merely because code merged. It is complete when the
appropriate evidence layer is green, the result is documented, and any newly
discovered gap has one canonical Bead.

## Product-surface scope

The local MCPB remains the privacy-preserving path for local files in Claude
Desktop and compatible local hosts. Cowork, remote MCP clients, Codex workflows,
ChatGPT, and future MCP Apps are distinct distribution and trust boundaries.
Evaluate them as separate products or adapters with explicit file-transfer,
authentication, storage, consent, and mutation semantics. Do not imply that a
local MCPB works in a cloud surface merely because both speak MCP.
# Captioned segmented-rule table regression (September 2026)

The Markdown renderer has a bounded path for tables with a segmented header
underline rather than vertical grid rules. It requires an explicit `TABLE`
caption, a complete top rule, separate header underline segments and a complete
bottom rule. The underline segments must provide contiguous column intervals;
every retained text item must fit exactly one interval, and competing internal
rules, overlapping rows, spanning headers and incomplete data rows reject.
Multiline header fragments retain their line breaks. Short source labels in the
first column remain literal rows with empty presentation slots. These are not
inferred group hierarchies, inherited values or filled-in missing data.

Continuation pages are handled independently and require their own complete
header evidence. This is not cross-page table stitching, arbitrary borderless
table recognition, OCR, or proof of semantic extraction quality. Other vector,
link and text coverage gaps remain reported even when a table is reconstructed.
`test/segmented-rule-table.test.js` uses generated, non-government PDFs and
tests broken or missing rules, misleading headers, crossing/missing cells,
standalone numeric records, unbound labels and literal Markdown escaping.

## Invisible text-layer routing

`read_pdf_content` and `get_page_analysis` observe explicit PDF.js text
rendering mode 3 (invisible). Text-show counts distinguish invisible from other
rendering modes; "other" does not assert visibility after clipping, opacity or
overpainting. Counts describe the top-level normalized PDF.js text-show list,
not nested Type-3 glyph programs or final pixels. The observer tracks graphics
save/restore and form boundaries;
unsupported annotation/transparency-group/optional-content state and malformed measurements are
unavailable, never inferred zeros. This is independent of the existing Unicode
text-integrity signals and does not judge language or OCR correctness.

The reader preserves exact extracted text, reports `pages_with_invisible_text`
and `pages_with_unavailable_text_visibility`, and recommends `render_pdf_page`
for visual verification. Page analysis exposes `text_visibility` and the
`invisible_text_layer` or `text_visibility_unavailable` routing reason. An accurate searchable scan can receive
the same guidance: hidden text is not intrinsically corrupt. Read completeness
means the requested text-layer read finished, not that its words match the
visible page. No OCR, automatic image transcription or replacement text is
performed. Markdown's existing image/OCR gaps remain unchanged; its extraction
IR does not yet carry this additional operator-state observation.

`test/invisible-text-routing.test.js` protects multilingual/native text,
mixed hidden/other text, state restoration, clipping-only mode, unavailable
operators and retention across later page failures, including a generated
searchable-image PDF. A separately retained public Apollo flight-plan diagnostic
motivated this change: both PDFKit and PDF.js extracted text that missed eight
visible literal anchors, and independent operators proved its text layer
invisible. It is a development regression, not an unseen benchmark or evidence
of improved transcription accuracy. The historical cause of that layer's bad
text remains unknown.
