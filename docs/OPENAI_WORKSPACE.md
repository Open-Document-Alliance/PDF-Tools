# PDF Tools in OpenAI extension surfaces

## Product intent

Bring the existing PDF Tools workspace into OpenAI's sidebar, conversation
panel and supported desktop file surfaces. This is an adaptation of the broad
application, not a separate form-only product. Reading, form filling, page
editing, extraction, comparison and optional Lumin signing remain the product.
Existing MCP Apps hosts and the local MCPB must continue working.

The durable work owner and scheduler is Bead `pdf-toolkit-mcp-zshk`.
Implementation starts from public master `14377c2d`. The owned checkout is
`codex-openai-pdf-workspace-20261001`, not the shared control checkout.

## Current implementation boundary

The workspace entrypoint opens the existing viewer in an honest empty state.
Global and thread entrypoints are optional host metadata; other clients can
ignore them. The coupled implementation uses the official OpenAI resource
bridge to read a host-provided PDF into a private local working copy and offers
an explicit, version-protected save back to the original.

The source implementation and synthetic built-viewer checks are complete.
Installed ChatGPT qualification is still pending and is not inferred from those
checks.

The host-file transport is bounded to 16 MiB. The app-only `import_host_pdf`
tool accepts bytes and an inert display label, not a resource URI, arbitrary
URL, local source path or destination. It writes a generated filename only
inside the already-allowed plugin workspace. An explicit folder policy that
excludes that workspace stays excluded; import does not widen it or choose
another approved folder. This adds no model-visible tool.

Pending page edits must first be committed as a local copy. Save-back is
unavailable during document mutations or incomplete rendering, and checks the
exact current PDF bytes before writing. A failed, read-only, stale or conflicted
save keeps the local copy and does not retry. Unrelated document loads or
viewer teardown remove the original host-file association. Unsupported hosts
retain the existing path-based `display_pdf` flow.

PDF file-handler metadata is not yet declared. Source tests, synthetic resource
bridge checks and contained-plugin tests do not establish installed ChatGPT
acceptance; that qualification remains a separate gate before advertising the
file handler.

Host-owned files must be accessed only through the resource explicitly supplied
by the host. A resource URI is not a local path or a URL to fetch arbitrarily.
Writes must respect read-only status and the source version/ETag, preserving the
user's document when a concurrent edit makes the save conflict. A useful text
fallback remains required when the host does not render the UI or support the
extension bridge.

## Existing distribution profiles

The built Agent Plugin contains a local stdio server and the broad PDF Tools
application. The hosted endpoint at `mcp.opendocuments.ai` is a separate,
stateless five-tool form profile. It has neither the extraction workspace nor
the local Lumin connection. It must not be submitted with full-workspace claims
as though it were the local application.

OpenAI's public submission flow requires a remote HTTPS MCP endpoint, domain
verification, five positive and three negative review cases, and a walkthrough.
Its packaging guide explicitly directs developers whose MCP server cannot be
deployed publicly to contact OpenAI for local MCP support. Bundled stdio servers
remain documented for local/repo marketplaces; that installation path is not
proof of eligibility for the universal public directory. Secure MCP tunnels are
for private testing, not public submission.

The full local application therefore needs OpenAI's confirmed local-support
route before a public-directory submission. The existing five-tool HTTPS
profile is not a substitute for it. Do not silently turn local document
processing into a cloud document-storage service to satisfy this requirement;
that would need a separate product, privacy and custody decision.

The listing metadata now has a single shared source for portable and Codex
compatibility manifests. It includes the required support/privacy/terms URLs,
bounded short description and explicit local-stamp/Lumin-send distinctions.
Review cases and a video are added only after they have actually been exercised.
Reviewer credentials belong in the secure portal, never the package or Git.

## Lumin and privacy continuity

Lumin's existing six workflow tools remain available. Opening this workspace
does not authorize sending a PDF, emailing recipients or signing. A configured
Lumin connection and exact user confirmation are still required for the send.
Local visible stamps must not be called cryptographic signatures.

No new analytics or document storage is introduced by entrypoint metadata.
Content returned to the assistant remains governed by the selected host's data
terms. A public release, directory submission and actual host qualification are
separate outcomes and must be reported separately.

## Governing references

- [OpenAI extension surfaces](https://developers.openai.com/plugins/build/extensions)
- [OpenAI extension protocol](https://github.com/openai/mcp-extensions/blob/main/docs/spec.md)
- [Plugin packaging](https://developers.openai.com/plugins/build/plugins)
- [Submission and review](https://developers.openai.com/plugins/deploy/submission)
- [Security and privacy](https://developers.openai.com/plugins/guides/security-privacy)

The platform and submission references were checked on October 1, 2026. Source
tests are not proof of installation, host file permissions or acceptance by the
public directory.
