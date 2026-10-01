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

The first implementation checkpoint adds a zero-argument app entrypoint around
the existing viewer, with an honest initial workspace. The global and thread
entrypoints are optional host metadata; other clients can ignore them.
This does not by itself implement host-owned PDF import, editing or save-back.
PDF file-handler metadata must not be declared until that coupled boundary is
implemented and tested.

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

OpenAI's public submission flow documents connecting one remote MCP server,
domain verification, five positive and three negative review cases, and a
walkthrough. Its authoring documentation also supports bundled stdio servers
in local/repo marketplaces. The exact eligibility/distribution route for this
bundled local desktop application must be confirmed in the actual portal or
with OpenAI before a public-directory submission claims it is supported.
Do not infer that every stdio ZIP is rejected, or turn this into a hosted
document-storage service without a separate product/privacy decision.

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
