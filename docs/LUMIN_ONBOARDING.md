# Lumin connection and first-time use

## Current experience

PDF Tools' direct Lumin integration currently requires a maintainer-configured
public OAuth application ID. It is not a consumer-ready shared application
configuration. No sandbox app ID is supplied as a default. Creating a personal
Lumin account does not fix missing installation configuration.

Once configured, `start_lumin_authorization` opens Lumin's authorization page
and returns instructions; `finish_lumin_authorization` completes the connection.
Account creation, passwords, and consent belong in Lumin's browser experience,
not MCP arguments or chat. A new user may need to create an account on Lumin's
website and restart connection if signup does not preserve the authorization
journey. Seamless signup continuation has not been qualified.

The local callback expires after five minutes. An expired or unsuccessful
connection can be restarted without uploading a PDF or sending an invitation.
Tokens remain in memory and a restart or token expiry requires reconnection.
Reconnect and poll an existing signing request; do not send a replacement.
Connecting an account never authorizes the separate document-send action.

## Lumin's own MCP: complement, not an automatic replacement

Research checked the official repository at
[`7c5ece34270a62752fc3298040b5414a95288999`](https://github.com/luminpdf/lumin-mcp-server/tree/7c5ece34270a62752fc3298040b5414a95288999)
and current developer documentation on 2026-09-05. Source and documentation
inspection is not a live authenticated compatibility test.

| Offering | What the inspected evidence establishes | Boundary |
| --- | --- | --- |
| Lumin local extension | Its manifest requires an API key; `stdio.js` passes that key to its tool server. Seven tools cover user/workspace information, upload, Markdown conversion, and send/status/cancel. | It does not remove account or credential setup. |
| Lumin hosted MCP | Official connection docs advertise `https://mcp.luminpdf.com/mcp`. The current tool reference lists 14 tools, including templates and agreement generation/download. | Hosted implementation, authentication persistence, and signup continuation were not executed or proven from the older local repository. |
| PDF Tools direct integration | Local PDF preparation, exact recipient preview and confirmation, direct upload, durable request outcome, status polling, and validated local artifact saving. | Separately configured account connection. No automatic federation or token sharing with Lumin's MCP. |

The inspected repository and published MCP tool list contain no account-signup
or attribution-reporting tool. That is not proof that Lumin lacks internal
signup or reporting services. The repository contains an OAuth admin helper
for creating OAuth clients, not user accounts; it requires server-side admin
configuration and must not be copied into a desktop client.

The hosted tool reference describes upload and signing from file URLs. A
local PDF path is not a remotely accessible URL. Do not expose a local file
server, upload to an intermediary, or publish a document merely to bridge the
two MCP servers. A future handoff needs an explicit private transfer contract
and the user's document-send consent. Neither connection's tokens, session
IDs, nor approval receipts are transferable to the other by assumption.

Prefer evaluating Lumin's hosted MCP as a companion for cloud-native templates,
workspace browsing, and cancellation before duplicating those tools locally.
The current integration does not install or call it. Two co-installed servers
must not both send the same request when one has already submitted it or has
an uncertain outcome.

## Provider-side attribution, not client telemetry

Lumin confirmed that direct API requests already record the OAuth client ID
and user agent. PDF Tools sends `User-Agent: PDF-Tools/<version>` on its token
exchange, signing-request create, status poll, and artifact-metadata read.
Lumin says it maps the `PDF-Tools/` prefix to `client: pdf-tools` in its
reporting; a synthetic reporting readback has not yet been performed.
This is one product identifier, not a per-user analytics identifier. The
hosted Lumin MCP still needs Lumin's announced user-agent forwarding change;
PDF Tools does not currently call that hosted server or claim its attribution.
Do not ship the test app as a production default.

Useful proposed measures are attributable new accounts, connected accounts,
unique signature requests sent, and completed/canceled/failed requests. A
successful authorization is not necessarily a new account. Polls are not new
requests. Provider outcomes must be deduplicated by request and state, rather
than counting every tool call or status poll as engagement.

Lumin confirmed that users may sign in or create a workspace and that API
usage is billed to their own workspace. A first-time signup return, ODA-owned
production app across unrelated workspaces, and provider reporting of new
account acquisition still need live qualification. Do not invent referral
parameters or repurpose OAuth `state`, which is reserved here for connection
security.

Local preparation, abandoned local attempts, and local errors are not covered
by provider-side reporting. Any future client analytics requires a separately
reviewed purpose, minimized schema, user-facing disclosure/control, retention,
and recipient. Do not report PDF content, prompts, paths, filenames, signer
names/emails, signatures, tokens, callback URLs, or signed download URLs as
analytics. No analytics collector, event emission, tracking identifier, signup
API, or additional network dependency is enabled by this change.

App webhooks are documented as private/server-app only and are not a reporting
shortcut for the current public PKCE desktop client. Server-side analytics
and private webhooks would be a separate architecture, not a reason to put
server secrets into the extension.

## Sources and qualification

- [Official repository manifest](https://github.com/luminpdf/lumin-mcp-server/blob/7c5ece34270a62752fc3298040b5414a95288999/manifest.json)
- [Official local entry point](https://github.com/luminpdf/lumin-mcp-server/blob/7c5ece34270a62752fc3298040b5414a95288999/stdio.js)
- [Official hosted connection](https://developers.luminpdf.com/tabs/mcp/connect)
- [Official current MCP tools](https://developers.luminpdf.com/tabs/mcp/supportedTool)
- [OAuth and public-client constraints](https://developers.luminpdf.com/tabs/guides/authentication/oauth2)
- [App-webhook restrictions](https://developers.luminpdf.com/tabs/guides/webhooks/app-webhooks)

The published redirect-URI prose still conflicts with the provider-confirmed,
tested loopback behavior. This research does not change the existing exact
`http://127.0.0.1/callback` registration or ephemeral-port implementation.
Do not infer free API allowance from Lumin's consumer web-plan pricing.
