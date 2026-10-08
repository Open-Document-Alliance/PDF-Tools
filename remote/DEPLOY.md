# Deploying the remote stateless MCP endpoint

Target: `https://mcp.opendocuments.ai/mcp`, on Open Document Alliance's Vercel
account. The twelve-tool service is live following the October 6 promotion of
the tested preview from PR #219. Direct-service checks passed; actual ChatGPT
attachment/download acceptance and directory submission are separate gates.
See [`../docs/OPENAI_HOSTED_CORE.md`](../docs/OPENAI_HOSTED_CORE.md).

## Before deploying

The six gates in [`../docs/REMOTE_STATELESS_PROFILE_2026-09-19.md`](../docs/REMOTE_STATELESS_PROFILE_2026-09-19.md)
come first. The focused tests bind the source contract, but gates 2 through 6
remain about the exact deployed artifact:
proven refusals against the live endpoint, a log audit, caps enforced before
allocation, documentation that matches, and a reproducible deploy.

## What runs

| File | Role |
|---|---|
| `server.mjs`, `document-tools.mjs` | Twelve tools over existing byte/extraction engines |
| `fetch-guard.mjs` | Pinned public connection, redirect/whole-body deadline, size cap |
| `isolated-tool.mjs`, `tool-worker.mjs` | Per-call worker, parent deadline and concurrency admission |
| `http.mjs` | `fetch(Request) => Response` handler, one server per request |
| `../api/mcp.js` | Vercel function that calls that handler |

## Deploy

1. Reuse ODA's existing `pdf-tools-remote` project. Verify the team, project,
   source commit and clean source; do not create an unrelated hosted service.
2. Root directory is the repository root, framework "Other", no build step.
3. Keep the explicit `vercel.json` includes for remote worker/shared engine
   files and native canvas/PDF.js assets. Inspect the deployed artifact and
   exercise actual worker dispatch, not just `tools/list`.
4. Create a preview without promoting production, then verify `initialize`:

   ```
   curl -s -X POST <preview>/api/mcp \
     -H 'content-type: application/json' \
     -H 'accept: application/json, text/event-stream' \
     -d '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2026-07-28","capabilities":{},"clientInfo":{"name":"curl","version":"0"}}}'
   ```

5. Preserve the existing domain `mcp.opendocuments.ai` and its routing. A
   production promotion is a separate milestone. Route `/mcp` to the function:
   `https://mcp.opendocuments.ai/mcp` rather than `/api/mcp`.
6. Qualify the preview with conspicuously synthetic PDFs, readback of returned
   bytes, source/coverage checks and content-free refusals. Prefer synthetic
   forms and page operations without performing a signature. The historical
   `remote/smoke.mjs` stamp flow is not authority to create signing intent.

## After deploying, before submitting

- Read the function logs for one full run and confirm no document-derived value
  appears in any line (gate 3).
- Test the intended host with explicitly supplied synthetic PDFs and actually
  download and reopen edited copies. Direct HTTP results do not establish
  ChatGPT or Muse acceptance. A signature is not required for these checks;
  signing remains subject to explicit user intent.
- Fill in the endpoint URL in `remote-mcp.md`, which is the documentation URL
  the submission form asks for.

## Three things this deployment had to learn

1. **Named method exports, not a default export.** A `default` export in `api/`
   is given the Node `(req, res)` signature and its return value is ignored, so
   a handler returning a `Response` hangs until the function times out. `api/mcp.js`
   exports `POST`, which selects the Web `fetch` style.
2. **The repository looks like a Jekyll site.** `_config.yml` makes Vercel run
   `jekyll build`, which fails. `vercel.json` sets `framework: null`, an empty
   build command, and serves `public/` so the repository's own files are never
   published.
3. **File tracing drops what PDF.js loads dynamically.** Without
   `includeFiles`, `@napi-rs/canvas` is missing and zone detection throws, and
   with the canvas alone but not `pdfjs-dist`'s `standard_fonts` and `cmaps`,
   text extraction silently finds nothing. Both are pinned by
   `functions["api/mcp.js"].includeFiles`.

## Notes

- Public `/mcp` needs no caller key and stores no documents. The optional
  `/mcp/connect` surface uses `PDF_TOOLS_CONNECT_SIGNING_SECRET` and signed
  app keys, without adding stored documents or user accounts. It fails closed
  when unconfigured. See [`../docs/REMOTE_CONNECT_API_KEYS.md`](../docs/REMOTE_CONNECT_API_KEYS.md)
  for activation, credential handling and rollback. Do not remove or expose an
  existing production secret when qualifying the public endpoint.
- The worker's 45-second parent deadline is below the configured 60-second
  invocation cap. V8 heap limits are not a total-memory cap or OS sandbox.
  Platform packaging, worker resolution and resource behavior need deployed
  evidence; a source-level cap is not proof of hosting capacity.
- Moving to other infrastructure later is a redeploy plus a DNS change, since
  nothing is stored and there is no state to migrate.
