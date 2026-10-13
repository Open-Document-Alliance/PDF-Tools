# Public workflow and upstream extraction qualification

These two tools add reproducible evidence without changing the frozen
directional olmOCR gate or any private agent-workflow campaign authority.
Neither command calls a model, downloads documents, publishes results, or
executes a signature. Neither establishes native ChatGPT, Claude Desktop,
Windows, or macOS acceptance.

## Complete local workflow

```sh
# The independent reader is separate from the product's pdf-lib/PDF.js stack.
python3 -m pip install pypdf
npm run eval:workflows -- /absolute/new/evidence-directory qualification-v1 python3
```

The command exclusively creates its output directory and retains generated
PDFs, server stderr, and a machine-readable `report.json`. It uses only original
synthetic text and generated forms; there is no external document license or
private document content involved. Its optional seed changes literal field
values and page labels. The public generator is a regression/challenge tool,
**not an unseen held-out corpus**. A release owner can choose and retain a new
seed before testing, but should not call this evidence generalization to real
documents.

The twelve fixed obligations cover exact byte import, field discovery, form
filling, source preservation, returning exact bytes, independent `pypdf`
inspection of those returned bytes, page ordering and geometry, explicit
textless-page abstention, and invalid-input refusal without an output file.
Generated source/returned PDFs are retained. Form fields and page content are
read from disk with the separate Python engine rather than trusted from the
server's own success message. No visual/pixel fidelity or table-extraction
claim follows from these checks.

Every obligation remains in the denominator when setup, a tool, or an oracle
fails. A missing Python dependency yields incomplete evidence and a nonzero
exit; it does not waive the independent-reader checks. `passed_all` requires
12/12. The report separately records correctness, abstention, refusal, coverage,
false acceptance, transport failures, product errors, timestamps, and per-call
latency. False-acceptance rate is accompanied by attempted/total negative cases
and `fully_observed`; zero with incomplete coverage is not a clean result.

Linux memory telemetry samples the sum of server/descendant current RSS from
`/proc` every 100 ms, including an explicit PID-namespace mapping. The recorded
maximum is a sampled observation, not a hard bound or exact peak. It excludes
the separate Python oracle and may be unavailable on restricted or non-Linux
hosts. `null` is unavailable; it is never reported as zero usage. Latencies
include cold starts and are descriptive single-run observations, not a
statistically established performance comparison.

The report binds the Git revision, clean/dirty state, tracked runtime/script
files, generator, oracle, Python reader version, Node runtime, seed, artifacts,
and raw-response hashes. The output includes local paths and synthetic source
content; review it before external publication. A dirty run is useful during
development but is not exact-commit release evidence. Source bindings are
captured before starting the server and after completing the run; drift keeps
`source_stable` and `qualified` false even when individual assertions passed.
Tracked runtime/script bytes are also compared directly with Git objects, so
an index flag that hides working-tree edits cannot grant qualification.
The CLI exits nonzero for drift, dirty source, or unmet obligations. This
pre/post check is not a signed runtime attestation. Run again from the clean
integrated commit for the final PR/release record.

## Official upstream test-class bridge

`eval:olmocr:upstream` delegates test semantics to the real upstream Python
classes at commit
`f7cfe4c22098b154c76b6ec950d1c0a464eecf8d` of
[allenai/olmocr](https://github.com/allenai/olmocr/tree/f7cfe4c22098b154c76b6ec950d1c0a464eecf8d).
The existing external dataset pin remains
`54a96a6fb6a2bd3b297e59869491db4d3625b711` of
[allenai/olmOCR-bench](https://huggingface.co/datasets/allenai/olmOCR-bench/tree/54a96a6fb6a2bd3b297e59869491db4d3625b711).
No upstream package or corpus is vendored into this repository.

First provision the scorer separately, following its
[benchmark instructions](https://github.com/allenai/olmocr/blob/f7cfe4c22098b154c76b6ec950d1c0a464eecf8d/olmocr/bench/README.md):

```sh
git clone https://github.com/allenai/olmocr.git /absolute/scorer-checkout
git -C /absolute/scorer-checkout checkout f7cfe4c22098b154c76b6ec950d1c0a464eecf8d
python3 -m venv /absolute/scorer-venv
/absolute/scorer-venv/bin/pip install -e '/absolute/scorer-checkout[bench]'
/absolute/scorer-venv/bin/python -m playwright install chromium
# Place the pinned dataset at /absolute/olmOCR-bench using the upstream
# Hugging Face download procedure, specifying --revision with the pin above.
```

Scoring imports the pinned source classes directly and records installed Python
package versions. Keep the checkout clean; generated/untracked source files
make it ineligible. The upstream installation has a broader dependency set
than this bridge itself. The corpus's pinned PDFs occupy 354,384,964 bytes;
Python dependencies and Chromium are additional. Pin and retain an environment
lock/container when publishing comparisons: a source commit alone does not
freeze package or browser behavior.

The scorer uses a fresh per-run home for its equation cache while preserving
the original platform's Playwright browser-cache path. An explicit
`PLAYWRIGHT_BROWSERS_PATH` takes precedence (use the same value during browser
installation and scoring). Provider credentials and proxy variables are not
passed to the scoring process.

```sh
npm run eval:olmocr:upstream -- --preflight \
  --upstream /absolute/scorer-checkout \
  --python /absolute/scorer-venv/bin/python \
  --output /absolute/new/preflight

# Existing conversion preserves its mandatory OS process-tree network fence.
npm run eval:olmocr -- verify --bench-root /absolute/olmOCR-bench
npm run eval:olmocr -- run --bench-root /absolute/olmOCR-bench \
  --output /absolute/evidence/current-run.json

# Retain the printed run digest independently; do not substitute another run.
npm run eval:olmocr:upstream -- \
  --upstream /absolute/scorer-checkout \
  --python /absolute/scorer-venv/bin/python \
  --bench-root /absolute/olmOCR-bench \
  --run /absolute/evidence/current-run.json \
  --run-sha256 INDEPENDENTLY_RETAINED_SHA256 \
  --output /absolute/new/upstream-score
```

Preflight always returns a not-run record and nonzero exit, because preflight
is not a benchmark score. It reports the original converter's Linux bubblewrap
or macOS sandbox prerequisite and missing Python packages. It does not download
dependencies, grant namespaces, or relax containment. The actual scoring path
also verifies clean pinned scorer source, every corpus byte through the
existing verifier, the run's independently supplied digest and structural
bindings, and the manifest/corpus identity. Scorer source bytes are compared
with the pinned Git objects both before and after scoring. Scoring retained outputs needs no
new conversion; unavailable local conversion containment is recorded even
when scoring an already-retained valid run from a qualifying host.

The bridge passes **unchanged Markdown** to upstream `load_single_test(...).run`
and runs an actual KaTeX/Chromium preflight before accepting any score. It does
not use the JavaScript math/string/table approximations or normalize the
candidate into a more favorable form. Default upstream baseline tests are
added for each PDF, and the headline uses upstream's **mean of per-category
pass rates including baseline**, not a micro-average over tests. It retains
every annotated test and baseline. Missing or failed conversions are `not_run`,
Python exceptions are `scorer_error`, and incomplete results have no upstream
headline (`null`). A separate conservative macro-average retains the full
planned denominator, including failures and unattempted tests.

The report retains the full request, per-test upstream output, exact source and
response digests, Python package inventory, original candidate binding, and
current-checkout comparison. Scorer diagnostics are drained without an
unbounded in-memory buffer: at most 64 KiB per stream is retained as an exact
base64 prefix, with total byte counts, full-stream SHA-256 and omitted-byte
counts. Verbose diagnostics cannot change the test denominator or terminate
scoring by filling a buffer. The process still has a 60-minute deadline;
timeout, cancellation, nonzero exit or cleanup failure cannot produce a
completed score. POSIX scorer descendants are reaped when their root exits.
The exclusive JSON response file, not stdout, supplies all test verdicts.
Existing annotated baseline tests are not duplicated; the corpus receives one
baseline test per PDF, including those already present in the annotations.
`current_head_score_complete` additionally
requires a matching clean HEAD. `benchmark_claim_ready` stays false: this is a
test-class adapter, not proof of an independently replicated public leaderboard
result. It does not reproduce upstream bootstrap confidence intervals or
repeated model generations. Public claims need separately reviewed rights,
execution/denominator evidence, runtime pinning, and comparison protocol.

## Validation boundary

`test/eval/public-qualification.test.js` checks denominator retention,
macro/micro distinction, duplicate/reordered/missing rows, missing conversions,
exception retention, exact raw-Markdown forwarding to an imported Python test
class, and refusal coverage. The Python wire test uses a tiny **fake** upstream
module and does not establish official scorer acceptance. Only a provisioned
upstream run can supply that acceptance.
