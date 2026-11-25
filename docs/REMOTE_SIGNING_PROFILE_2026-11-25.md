# Hosted Lumin signing: a second, authenticated surface

Status: proposed, 2026-11-25. Needs independent review before any code on this surface is merged.

This amends [`REMOTE_STATELESS_PROFILE_2026-09-19.md`](REMOTE_STATELESS_PROFILE_2026-09-19.md) by adding a surface beside it. It does not change the public `/mcp` endpoint, its twelve tools, or its properties. It does not lift the WAIT on a stored-document service in [`REMOTE_HYBRID_ARCHITECTURE_2026-07-30.md`](REMOTE_HYBRID_ARCHITECTURE_2026-07-30.md).

## The job

A person in Claude on the web or on a phone says "send this for signature". The prepared PDF goes to Lumin Sign, the listed signers get Lumin's email, and the person can later ask for the status and the completed document. People without a Lumin account create one during authorization. Lumin attributes the traffic to `client: pdf-tools` from the `User-Agent: PDF-Tools/<version>` header.

The local MCPB already does this with six `*_lumin_*` tools (public workflow landed 2026-09-05). The hosted surface reuses the same mapper, transport and confirmation rules (`server/lumin-sign-v1-*.js`), not a reimplementation.

## Why not on `/mcp`

The public endpoint promises P2, no identity. Sending to Lumin needs a Lumin credential for a specific person, so a signing tool on `/mcp` would break P2 for every caller of that endpoint and change what its documentation says. A separate path keeps both promises exact:

| Surface | URL | Identity | Tools |
|---|---|---|---|
| Public | `https://mcp.opendocuments.ai/mcp` | None (P2 unchanged) | The twelve stateless tools |
| Connect keys | `https://mcp.opendocuments.ai/mcp/connect` | Signed app key, no person | Same twelve |
| Signing (new) | `https://mcp.opendocuments.ai/mcp/sign` | The person's Lumin authorization, carried by the client | The twelve plus the Lumin tools below |

## Properties of the signing surface

**S1. Still nothing stored (P1 holds).** No database, no key-value store, no session table, no token table. Every OAuth artifact the server issues (client registration, authorization state, authorization code, access token, refresh token) is a self-contained value encrypted and authenticated with AES-256-GCM under a server key held in Vercel environment configuration. The client holds it; the server decrypts it per request and forgets it.

**S2. Identity is Lumin's, not ours.** The server keeps no user records. It learns who the caller is only by decrypting the token the client presents, and only for that request. It never maps one request to another.

**S3. The document leaves only at a confirmed send.** Reading, filling and preparing work exactly as on `/mcp`. The PDF and signer details go to Lumin only inside `send_lumin_request`, which requires the same exact confirmation values as the local tool. An elicitation confirmation on 2026-07-28 connections is planned, not built. After that, Lumin's terms and privacy policy apply to the document.

**S4. No content or credentials in logs (P4 extended).** Logs never contain Authorization headers, any token or code, OAuth state, Lumin request IDs, signer names or emails, or anything from P4's list.

**S6. One attempt per confirmation, without a durable claim.** The local send path writes a durable claim before calling Lumin (`server/lumin-sign-v1-operation.js`), so a crash or timeout can never turn into a second request. The hosted surface has nowhere to write that claim and must not fake its acknowledgement. It makes exactly one attempt per confirmed call and never retries, and an ambiguous outcome (timeout after the upload started) is reported as `outcome_unknown` with instructions to check status before sending again. If Lumin supports an idempotency key, the key is derived from the packet digest and the confirmation timestamp, so a client repeating the same confirmed call cannot create a second request. Until Lumin confirms that, a repeated call can, and the tool text says so.

**S5. User-Agent attribution.** Every request to `auth.luminpdf.com` and `api.luminpdf.com` sends `User-Agent: PDF-Tools/<version>` from `server/lumin-client-identity.js`.

## OAuth shape (MCP authorization, stateless proxy)

The server is the OAuth authorization server Claude talks to, and a client of Lumin's. Claude never sees a Lumin token in the clear.

1. Claude reads `/.well-known/oauth-protected-resource` for `/mcp/sign`, then `/.well-known/oauth-authorization-server`.
2. Claude registers (dynamic client registration). The returned `client_id` is a sealed value carrying its redirect URIs and an issue time. Nothing is recorded.
3. Claude sends the person to `/oauth/authorize` with PKCE. The server checks the redirect URI against the sealed client and shows its own consent page naming the registered app and its return host. The page sets a `__Host-` cookie (`SameSite=Strict`) whose hash is sealed into the form, so only a POST from the browser that saw the page can continue; a link someone else started cannot skip it. On Continue, the server generates its own PKCE pair for Lumin and redirects to `https://auth.luminpdf.com/oauth2/auth` with `state` = sealed {Claude redirect URI, Claude state, Claude code challenge, Lumin PKCE verifier, expiry 10 min}.
4. Lumin redirects to `/oauth/lumin/callback`. The server opens the sealed state, exchanges Lumin's code (with the verifier and, if issued, the client secret) for Lumin tokens, and redirects to Claude with `code` = sealed {Lumin tokens, Claude code challenge, client, redirect URI, expiry 60 s}.
5. Claude calls `/oauth/token` with its verifier. The server checks PKCE and returns `access_token` = sealed {Lumin access token, expiry} and `refresh_token` = sealed {Lumin refresh token}.
6. On refresh the server refreshes with Lumin and reseals. If Lumin issued no refresh token, the person re-authorizes on expiry.

### Costs of being stateless, stated

- **Code replay within 60 seconds.** Without a used-code record, an intercepted code is replayable until it expires. PKCE means the attacker also needs Claude's verifier. Accepted, with the 60 s expiry.
- **No per-person revocation on our side.** The person revokes at Lumin, which kills the inner token. Rotating the server key invalidates every sealed value at once.
- **Key rotation.** Two keys (current and previous) are accepted during a rotation window so active connections survive it.
- **Refresh-token replay.** A stolen sealed refresh token, used with the public `client_id` it is bound to, works until it expires (30 days) unless Lumin rotates or revokes the underlying refresh token. Revoking at Lumin ends it.
- **Repeat sends within the preparation window.** A preparation token is valid for 30 minutes and is not consumed, so a client that calls send twice with valid confirmations creates two requests. The confirmation must be within 10 minutes and not earlier than the preparation, which narrows this; an idempotency key from Lumin would close it (S6).
- **Keys per environment.** The sealing AAD binds purpose and key ID, not the host. Previews and production must use different sealing keys, or a value sealed on one is accepted by the other. Preview qualification uses a throwaway per-deployment key.
- **Lumin codes in platform request logs.** Vercel's own request log records the callback URL, including Lumin's one-time code. That code is useless without the PKCE verifier, which exists only inside the sealed state.
- **Refresh failures.** A failed Lumin refresh, including a network failure, currently answers `invalid_grant`, which makes the client reconnect. Distinguishing transport failures is a follow-up.

## Tools on `/mcp/sign`

| Tool | Notes |
|---|---|
| The twelve `/mcp` tools | Identical definitions and limits |
| `prepare_lumin_request` | Builds the exact packet preview from the hosted document input (file, URL or inline); returns a packet digest |
| `send_lumin_request` | Re-supplies the document, checks it matches the previewed digest, requires the confirmation values, sends once, no automatic retry |
| `check_lumin_status` | Takes the Lumin request ID, reads status from Lumin |
| `download_lumin_artifact` | Returns the completed PDF as a download result |

`start_lumin_authorization` and `finish_lumin_authorization` do not exist here, because the connector's own OAuth replaces them. Because nothing is stored, the prepared packet is not kept between prepare and send: the client sends the document again, and the digest binds it to what the person saw.

### As built (2026-11-25)

- **Preparation is hosted-native.** The local transport requires a receipt from `prepare_signing_packet` that records an atomic file commit at a local path. The hosted surface has no such file and does not fabricate that receipt. `prepare_lumin_request` instead draws the same visible "sign here" boxes with the shared `drawSignatureFieldOnPage`, at caller-supplied locations (found with `detect_signature_zones`), one or more per signer. It reuses the local mapper (`mapLuminSignV1SignatureRequest`) and its request-mapping digest.
- **The preparation token is sealed** (purpose `prepare`, 30 minutes) and carries the source digest, the prepared digest and size, the mapping digest and the full plan (title, expiry, people, box placements). The plan is encrypted, so recipient addresses do not appear in the token.
- **Send re-prepares.** `send_lumin_request` takes the same source document, refuses `SOURCE_CHANGED` if its digest differs, prepares again (deterministic: pdf-lib loads with `updateMetadata: false`), and refuses `PREPARATION_MISMATCH` unless the bytes and mapping equal the preview. Only then does it make the single Lumin request, with the same multipart fields as the local transport (`use_text_tags: true`, `SAME_TIME`). The September 2026 live send used a PDF with visible boxes and no Lumin text tags, and Lumin accepted it; whether text tags would improve field placement is a question for Lumin.
- **Limits:** at most 10 people and 40 boxes per request, expiry between one hour and one year, prepared PDF at most 3 MB (the hosted output limit).
- **The token reaches the worker as data.** `/mcp/sign` opens the sealed access token and passes the Lumin token to the per-call worker in `workerData.context`, never as a tool argument. The public `/mcp` passes no context, so it can neither list nor call the signing tools.
- **Configuration:** `PDF_TOOLS_SIGN_ENABLED=1`, `PDF_TOOLS_SIGN_SEALING_KEYS`, `PDF_TOOLS_LUMIN_CLIENT_ID` and optionally `PDF_TOOLS_LUMIN_CLIENT_SECRET`. Any missing piece returns 503 on every signing path.

## Gates before this surface is public

1. Every S property above has a test that fails when it is broken, including a log audit over a full prepare, send, status and download run against a fake Lumin.
2. Sealed values: tamper, expiry, wrong-purpose (a code presented as a token) and wrong-key cases are refused.
3. A real Claude run on a Vercel preview, web and mobile, with synthetic documents only, ending in a Lumin request that Lumin attributes to `client: pdf-tools`.
4. `remote-mcp.md` states the three surfaces and S1 to S5 in these words.
5. Independent review of this document and the implementation.

Until all five pass, `/mcp/sign` returns 503, the way `/mcp/connect` does when unconfigured.

## Needed from Lumin

An OAuth client for the hosted redirect URI `https://mcp.opendocuments.ai/oauth/lumin/callback` (and a preview or staging redirect), scopes `openid profile.read sign:requests`, authorization code with PKCE and refresh tokens, and confirmation that the `PDF-Tools/<version>` User-Agent still maps to `client: pdf-tools`.
