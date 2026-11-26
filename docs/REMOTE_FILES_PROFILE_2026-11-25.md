# Hosted file uploads and downloads (MCP Files extension)

Status: approved in principle, 2026-11-25. Mat approved Files and the retention wording (decision 2). Production stays off until the storage account exists, the host is approved, and the gates below pass. The implementation behind the flag can proceed on previews.

Sources: Anthropic's connector guide (https://claude.com/docs/connectors/building/files, beta) and the draft extension spec (modelcontextprotocol/experimental-ext-file-uploads, `specification/draft/file-uploads.md`). Both may change.

## What it gives people

Today a person in Claude attaches a PDF, and the model has to pass it to the hosted server inline (3 MB at most, and the bytes go through the model's context) or find a URL. With the extension, Claude uploads the attachment straight to storage the server names, up to 25 MB, and downloads results the same way. That is the difference between "works for small forms" and "works for real documents" on web and mobile.

## What it costs: the privacy contract changes

The public profile promises P1, "no persistence: bytes exist only for one request, in memory". The Files protocol cannot keep that promise: the upload lands in storage between two tool calls, and a result is fetched from storage after the call returns. The honest replacement is:

**F1. Transient storage only, for transfer.** An uploaded PDF and a returned PDF exist in the transfer bucket only while the transfer needs them, and never longer than 2 hours. Nothing else is stored: no database, no index of files, no copy after deletion. Processing still happens in memory, per request. Deletion works in three layers:

- the server deletes an upload as soon as the second call consumes it;
- a Vercel cron (`api/files-sweep.js`, `remote/files-sweeper.mjs`) runs every 15 minutes and deletes every object older than 105 minutes, so no object outlives 2 hours. Upload sessions end at 60 minutes and download URLs at 60 minutes, so the sweeper never deletes a file someone is still entitled to use. A session with several files may last at most 90 minutes;
- a 1-day bucket lifecycle rule stays as the backstop if the cron ever stops. It cannot carry the promise alone, because S3 lifecycle rules count whole days and round up to the next midnight UTC.

The cron endpoint needs `CRON_SECRET` in the project environment once Files is on; without it, it refuses and logs an ERROR line. With Files off it does nothing.

This changes the listing and the privacy policy wording: "processed per request and not stored" becomes the approved "held up to 2 hours for transfer, then deleted automatically". Until production is switched on:

- the extension is not advertised in production;
- the existing inline and URL inputs keep working unchanged, and remain the only path in production;
- previews may enable it against a test bucket.

## Decisions needed (for Mat)

1. **Storage host.** It must be on a domain we control, approved by Anthropic, HTTPS on 443, public IPv4, no redirects, not a shared or CDN host. Vercel Blob (`*.blob.vercel-storage.com`) is a shared host and is refused, and a request body through the Vercel function is capped near 4.5 MB, so uploads cannot pass through `mcp.opendocuments.ai` itself. Options:
   - **A. Cloudflare R2 or AWS S3 behind `files.opendocuments.ai`** (recommended). Needs a storage account and a DNS record at GoDaddy, where opendocuments.ai is registered.
   - **B. A provider-domain bucket we can prove is ours** (for example an S3 virtual-hosted bucket without dots in its name). No DNS change, but Anthropic must accept the ownership statement.
2. **Retention and wording.** Decided: "held up to 2 hours for transfer, then deleted automatically", enforced by the sweeper above.
3. **Who sends the host-approval email.** Draft ready (plugin lane's `draft-mcp-review-hosts-email.md`); it needs the host from decision 1.

Also required, outside our control: the connector must be listed in the Connectors Directory at exactly `https://mcp.opendocuments.ai/mcp` before Claude sends any file to it.

## Design (flagged, previews first)

**Advertisement.** `server/discover` adds `capabilities.extensions["io.modelcontextprotocol/files"] = { "upload": {} }` only when `PDF_TOOLS_FILES_ENABLED=1` and a storage adapter is configured, and only on 2026-07-28 connections. Each `tools/call` reads the client's declaration from `params._meta["io.modelcontextprotocol/clientCapabilities"]` every time.

**Inputs.** The existing document tools gain an optional `upload` argument whose object schema carries `x-mcp-file: { "accept": ["application/pdf"], "maxSize": 26214400 }`, alongside `file`, `pdf_url` and `pdf_base64` (exactly one still required). The tool names do not change, so the plugin lane's connector packet stays valid; the property appears only where the extension is enabled. `merge_pdfs` gains an `uploads` array the same way.

**First call** (metadata only): validate type and size, then answer `resultType: "upload_required"` with one presigned `PUT` target per file (`credentials: "omit"`, `Content-Type: application/pdf`, expiry at least 20 minutes) and a `requestState`, and `content: []` as the SDK requires.

**requestState** is a sealed value (`remote/sealed.mjs`, new purpose `files`), binding the tool name, a digest of the arguments, the object keys and declared sizes and digests, the connection kind (public or signing, and for signing a digest of the Lumin principal), and an expiry of 1 hour (at most 90 minutes with several files, so the sweeper cannot remove a file a live session still needs). It never carries a token.

**Second call:** open the state (else -32602), compare tool name and arguments (else -32602), `HEAD` each object to confirm size and digest, then copy each object to a key the upload URL cannot write, delete the upload object, and run the tool on the copied bytes inside the existing isolated worker and caps. Deleting the upload object is the consumption marker: a replay of the same `requestState` finds nothing to finalize and fails -32602 without running twice. This needs no database.

**Outputs.** When the call declared `download`, a new PDF is written to the bucket under a random key and returned in `_meta["io.modelcontextprotocol/files"].downloads[]` with name, `application/pdf`, exact size, SHA-256 digest, a presigned `GET` URL valid one hour, and `credentials: "omit"`. The URL never appears in `content` or `structuredContent`. Without `download`, results come back inline as today.

**Storage adapter.** `remote/file-store.mjs` exposes `presignUpload`, `head`, `take`, `putResult`, `presignDownload`, and, for the sweeper only, `list` and `delete`. It has an S3-compatible implementation (R2 and S3 speak the same API) and an in-memory fake for tests. Credentials live in Vercel environment configuration; nothing logs keys, URLs or object names.

**Signing surface.** `/mcp/sign` can take uploads the same way, so "send this for signature" works on a large attached PDF. `prepare_lumin_request` and `send_lumin_request` already accept any document input; the re-prepare check at send still applies.

**Logs.** Content-free as today, and additionally no object keys, presigned URLs or digests of private documents.

## Gates before production

1. Mat's decisions 1 to 3.
2. Every F1 and design property has a test with the fake store; a preview against a real test bucket proves presign, HEAD, take, delete, the sweeper and the lifecycle rule.
3. Anthropic approves the hosts; the directory listing exists.
4. A real Claude run on web and mobile with a synthetic PDF above 3 MB: upload, process, download, reopen.
5. `remote-mcp.md`, the privacy policy and the listing state F1 in the same words.
6. Independent review.
