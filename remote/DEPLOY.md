# Deploying the remote stateless MCP endpoint

Target: `https://mcp.opendocuments.ai/mcp`, on Open Document Alliance's Vercel
account. Nothing here is deployed yet.

## Before deploying

The six gates in [`../docs/REMOTE_STATELESS_PROFILE_2026-09-19.md`](../docs/REMOTE_STATELESS_PROFILE_2026-09-19.md)
come first. Gate 1 is met: `test/remote-stateless-profile.test.js` binds every
property and threat, 35 tests. Gates 2 through 6 are about this deployment:
proven refusals against the live endpoint, a log audit, caps enforced before
allocation, documentation that matches, and a reproducible deploy.

## What runs

| File | Role |
|---|---|
| `server.mjs` | The five tools, over the byte-level primitives in `server/helpers.js` |
| `fetch-guard.mjs` | URL fetching with private-range refusal, redirect re-checks, size cap |
| `http.mjs` | `fetch(Request) => Response` handler, one server per request |
| `vercel/api/mcp.js` | Vercel function that calls that handler |

## Deploy

1. Accept the invitation to the ODA Vercel account.
2. Create a project from this repository. Root directory `remote/vercel`,
   framework preset "Other", no build step.
3. The function needs the repository's `server/` and `remote/` directories, so
   set the project's included files to the repository root rather than the
   function directory alone.
4. Deploy, and confirm the preview URL answers an `initialize` call:

   ```
   curl -s -X POST <preview>/api/mcp \
     -H 'content-type: application/json' \
     -H 'accept: application/json, text/event-stream' \
     -d '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2026-07-28","capabilities":{},"clientInfo":{"name":"curl","version":"0"}}}'
   ```

5. Add the domain `mcp.opendocuments.ai` in Vercel, and ask ODA to add the CNAME
   Vercel shows. Route `/mcp` to the function so the endpoint reads
   `https://mcp.opendocuments.ai/mcp` rather than `/api/mcp`.
6. Run `node remote/smoke.mjs` with `MCP_URL` pointing at the deployed endpoint.
   It fetches the live IRS W-9, fills it, finds the signature zone, signs, and
   exercises every refusal.

## After deploying, before submitting

- Read the function logs for one full run and confirm no document-derived value
  appears in any line (gate 3).
- Point Muse at the endpoint as a custom connector and complete one real
  fill-and-sign, as evidence for the submission.
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

- No environment variables. The service has no secrets, because it has no
  accounts and no storage.
- Memory: about 150 MB per document, comfortably inside the default function
  size. Time: 1 to 3 seconds for a typical form, so the 60 second maximum is
  generous headroom rather than a target.
- Moving to other infrastructure later is a redeploy plus a DNS change, since
  nothing is stored and there is no state to migrate.
