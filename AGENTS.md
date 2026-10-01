# Repository Guidelines

## Active Kepano / Shannon Work

Before continuing the current extraction-improvement tranche, read
`docs/handoffs/KEPANO_SHANNON.md`. The crucial starting fact is that Kepano's
example is Shannon's *A Mathematical Theory of Communication* PDF; it is not a
separate example to locate.

## Project Structure & Module Organization
- `server/index.js`: Node MCP server exposing PDF tools shared by Claude Desktop and Cursor. Keep tool definitions and helper utilities here; prefer incremental updates over rewrites.
- `pdf-toolkit-mcp-share/`: Packaged variant used by `package-for-friend.js`; mirror changes from `server/index.js` when APIs evolve.
- `manifest.json` and `index.html`: Claude Desktop extension metadata and UI stub. Update versions alongside `package.json`.
- `example-fw9.pdf`: Sample form for smoke tests. Keep anonymized assets only.

### Tools currently shipped
This is the complete registered set, not a selection.

- `display_pdf`, `list_pdfs`, `read_pdf_fields`, `fill_pdf`, `bulk_fill_from_csv`, `save_profile`, `load_profile`, `list_profiles`, `fill_with_profile`, `extract_to_csv`, `validate_pdf`, `read_pdf_content`, `read_pdf_pages`, `read_pdf_layout`, `search_pdf_text`, `convert_pdf_to_markdown`, `verify_table_proposal`, `get_pdf_identity`, `get_pdf_info`, `get_page_analysis`, `inspect_pdf_accessibility`, `compare_pdfs`, `render_pdf_page`, `render_pdf_region`, `fetch_pdf_from_url`, `merge_pdfs`, `split_pdf`, `rotate_pdf_pages`, `reorder_pdf_pages`, `apply_page_plan`, `create_signature`, `list_signatures`, `load_signature`, `detect_signature_zones`, `add_signature_field`, `prepare_signing_packet`, `apply_signature`, `apply_text`, `start_lumin_authorization`, `finish_lumin_authorization`, `prepare_lumin_request`, `send_lumin_request`, `check_lumin_status`, `download_lumin_artifact`, `get_active_document`, `set_active_document`, `get_allowed_directories`, `get_pdf_resource_uri`, `create_extraction_workspace`, `inspect_extraction_state`, `read_extraction_workspace`, `read_extraction_chunk`, `submit_extraction_proposal`, `verify_extraction_proposal`, `delete_extraction_workspace`, `reveal_in_finder`, `read_pdf_bytes` (app-only), `open_pdf_workspace` (app-only).

`open_pdf_workspace` opens an empty task-selection screen through optional
global/thread MCP App entrypoints. It reads no PDF, scans no folder and performs
no document mutation or send. Its registration is not proof of native host-file
import/save-back or acceptance in the OpenAI directory.

`get_pdf_info` returns bounded source-bound observations. Widget annotations
belong to form fields; ordinary annotations remain separate and their targets
are returned only as inert values. Render tools bind PNG and, when native
canvas is available, raw RGBA digests to the exact source SHA-256.
Render-region inputs are top-left PDF.js viewport points after CropBox,
rotation, and UserUnit, not MediaBox-relative signing coordinates. The macOS
system renderer uses the same view mapping for whole pages and regions and
reports raw pixels unavailable.

`inspect_pdf_accessibility` performs a bounded, local, read-only review of
exactly eight shallow catalog-level signals in an unencrypted PDF. It binds
observations to the source SHA-256, distinguishes missing from unavailable
signals, and always requires human review. It does not establish PDF/UA,
WCAG, certification, legal, or document-accessibility conclusions.

`compare_pdfs` performs a bounded, local, read-only whole-document comparison
of two PDFs with at most 20 pages each. It binds observations and evidence to
both immutable source envelopes, keeps seven coverage channels separate,
preserves ambiguous page matches, and emits reversible default-material or
forensic presentation decisions. A successful result is a detected-change
set, never a document-equivalence claim.

## Build, Test, and Development Commands
- `npm install`: install dependencies with Node.js 20.19+ or 22.12+; this is
  the contributor build/test floor imposed by Vite, not a claim about the
  Node runtime embedded by a desktop host.
- `node server/index.js`: run the MCP server over stdio for local hosts (Cursor, Claude) and watch stderr for diagnostics.
- `node package-for-friend.js`: regenerate `pdf-toolkit-mcp.zip`; requires the `zip` CLI and ensures shareable installers stay current.
- `npm run build:mcpb`: build the UI, create a clean production bundle with the locked macOS/Windows native canvas packages, and verify the `.mcpb` contents.
- `npm run smoke:mcpb -- pdf-toolkit-mcp.mcpb`: start the extracted artifact and require tool discovery plus native page rendering on each release platform.
- `npm test`: run the Vitest partition only.
- `npm run test:node-native`: run the explicit platform partition of Node
  native-test suites.
- `npm run test:all`: run the unfiltered Vitest and native partitions; use
  this aggregate gate for release qualification.

## Coding Style & Naming Conventions
- Use 2-space indentation, `const`/`let` semantics, and double-quoted strings to match `server/index.js` and shipped bundles.
- Favor composable helpers over inlined logic; reuse `resolvePath`, `fillPdfFields`, and profile utilities instead of duplicating them.
- Tool names stay snake_case (`list_pdfs`, `fill_pdf`); new tools should follow that pattern and return structured text blocks.

## Testing Guidelines
- Run the narrowest relevant automated tests first, then `npm run test:all`
  for release qualification. Automated stdio evidence does not replace manual
  host runs against `example-fw9.pdf`; exercise `list_pdfs`,
  `read_pdf_fields`, `fill_pdf`, and one profile flow.
- Validate CSV workflows with a two-row fixture before publishing; include a value with a comma to catch CSV parsing regressions.
- Smoke-test new tools: `extract_to_csv` on two PDFs, `validate_pdf` on a partially filled form, `read_pdf_content` on a text-layer PDF and a textless scanned PDF to verify its page-1 image fallback, and `get_pdf_resource_uri` with a local file path.
- Exercise `compare_pdfs` with the seven deterministic synthetic roles
  (semantic, text, structure, form, annotation, metadata, and visual), plus an
  identical/noise control and an inserted-page ambiguity case.

## Commit & Pull Request Guidelines
- Follow the existing imperative subject style (`Update index.html to improve structure`). Group related changes and note version bumps explicitly.
- Include PR context: summary of affected tools, manual test evidence, linked issue if applicable, and screenshots only when UI assets change.
- Regenerate artifacts (`pdf-toolkit-mcp.zip`, `.mcpb`) in separate commits or attach them to releases rather than merging binaries directly. Keep version numbers aligned across `package.json`, `manifest.json`, and the share bundle.

## Maintainer Docs
- `docs/MAINTAINERS.md` for architecture, packaging, and manual test checklist.
- `docs/RELEASE.md` for release steps and artifact handling.
- `docs/SUPPORT.md` for issue intake and triage flow.

## Upstream Tracking
- MCP spec/org: https://github.com/modelcontextprotocol
- MCPB CLI: https://github.com/modelcontextprotocol/mcpb
- SDK: `@modelcontextprotocol/sdk`

## Security & Configuration Tips
- Never hard-code personal paths; rely on `resolvePath` and default directories (`~/Documents`, `~/.pdf-toolkit-files`).
- Scrub PDFs or CSVs before committing, and point contributors to local-only credentials files when testing protected documents.

## Autonomous Maintainer Run Contract

When the maintainer has authorized an autonomous tranche or epic, do not stop
after planning, a single Bead, or a small progress report. Follow
`docs/ORCHESTRATION.md` and continue through ready work until the tranche's exit
criteria are met or a genuine human gate is reached.

- Use Beads as the durable scheduler; claim one bounded task per execution lane.
- Use Agent Mail for identity, inboxes, handoffs, and file reservations when it
  is healthy. Use isolated worktrees even when reservations are available.
- Code-changing parallel lanes use dedicated worktrees under
  `/home/mat/Sites/pdf-tools-worktrees/`; do not edit the shared checkout.
- Commit locally at coherent checkpoints. The control tower batches merges and
  Git pushes at milestones to limit downstream build-minute costs.
- Every implementation lane must verify, adversarially review, record evidence,
  hand off, release reservations, and either take the next ready task or stop at
  an explicit gate.
- Progress updates are informational and do not require the maintainer to say
  “continue.” Ask only when authority, credentials, money, irreversible state,
  legal/commercial judgment, or a materially ambiguous product choice is needed.
- Never autonomously publish a release, execute a signature, disclose an
  unpatched vulnerability, post contractual/legal claims, spend money, or alter
  production/external data. Those remain human gates.
- If context is compacted or a session restarts, recover from Git, Beads,
  `docs/ORCHESTRATION.md`, Agent Mail, and the evidence ledger rather than
  relying on chat history.

<!-- BEGIN BEADS INTEGRATION v:1 profile:full hash:d4f96305 -->
## Issue Tracking with bd (beads)

**IMPORTANT**: This project uses **bd (beads)** for ALL issue tracking. Do NOT use markdown TODOs, task lists, or other tracking methods.

### Why bd?

- Dependency-aware: Track blockers and relationships between issues
- Git-friendly: Dolt-powered version control with native sync
- Agent-optimized: JSON output, ready work detection, discovered-from links
- Prevents duplicate tracking systems and confusion

### Quick Start

**Check for ready work:**

```bash
bd ready --json
```

**Create new issues:**

```bash
bd create "Issue title" --description="Detailed context" -t bug|feature|task -p 0-4 --json
bd create "Issue title" --description="What this issue is about" -p 1 --deps discovered-from:bd-123 --json
```

**Claim and update:**

```bash
bd update <id> --claim --json
bd update bd-42 --priority 1 --json
```

**Complete work:**

```bash
bd close bd-42 --reason "Completed" --json
```

### Issue Types

- `bug` - Something broken
- `feature` - New functionality
- `task` - Work item (tests, docs, refactoring)
- `epic` - Large feature with subtasks
- `chore` - Maintenance (dependencies, tooling)

### Priorities

- `0` - Critical (security, data loss, broken builds)
- `1` - High (major features, important bugs)
- `2` - Medium (default, nice-to-have)
- `3` - Low (polish, optimization)
- `4` - Backlog (future ideas)

### Workflow for AI Agents

1. **Check ready work**: `bd ready` shows unblocked issues
2. **Claim your task atomically**: `bd update <id> --claim`
3. **Work on it**: Implement, test, document
4. **Discover new work?** Create linked issue:
   - `bd create "Found bug" --description="Details about what was found" -p 1 --deps discovered-from:<parent-id>`
5. **Complete**: `bd close <id> --reason "Done"`

### Auto-Sync

bd automatically syncs via Dolt:

- Each write auto-commits to Dolt history
- Use `bd dolt push`/`bd dolt pull` for remote sync
- No manual export/import needed!

### Important Rules

- ✅ Use bd for ALL task tracking
- ✅ Always use `--json` flag for programmatic use
- ✅ Link discovered work with `discovered-from` dependencies
- ✅ Check `bd ready` before asking "what should I work on?"
- ❌ Do NOT create markdown TODO lists
- ❌ Do NOT use external issue trackers
- ❌ Do NOT duplicate tracking systems

For more details, see README.md and docs/QUICKSTART.md.

## Landing the Plane (Session Completion)

**When ending a work session**, you MUST complete ALL steps below. Work is NOT complete until `git push` succeeds.

**MANDATORY WORKFLOW:**

1. **File issues for remaining work** - Create issues for anything that needs follow-up
2. **Run quality gates** (if code changed) - Tests, linters, builds
3. **Update issue status** - Close finished work, update in-progress items
4. **PUSH TO REMOTE** - This is MANDATORY:
   ```bash
   git pull --rebase
   bd dolt push
   git push
   git status  # MUST show "up to date with origin"
   ```
5. **Clean up** - Clear stashes, prune remote branches
6. **Verify** - All changes committed AND pushed
7. **Hand off** - Provide context for next session

**CRITICAL RULES:**
- Work is NOT complete until `git push` succeeds
- NEVER stop before pushing - that leaves work stranded locally
- NEVER say "ready to push when you are" - YOU must push
- If push fails, resolve and retry until it succeeds

<!-- END BEADS INTEGRATION -->
