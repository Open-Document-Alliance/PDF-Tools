# Hosted file uploads and downloads (MCP Files extension)

Status: approved in principle, 2026-11-25. Mat approved Files and the retention wording (decision 2). Production stays off until the storage account exists, the host is approved, and the gates below pass. The implementation behind the flag can proceed on previews.

Sources: Anthropic's connector guide (https://claude.com/docs/connectors/building/files, beta) and the draft extension spec (modelcontextprotocol/experimental-ext-file-uploads, `specification/draft/file-uploads.md`). Both may change.

## What it gives people

Today a person in Claude attaches a PDF, and the model has to pass it to the hosted server inline (3 MB at most, and the bytes go through the model's context) or find a URL. With the extension, Claude uploads the attachment straight to storage the server names, up to 25 MB, and downloads results the same way. That is the difference between "works for small forms" and "works for real documents" on web and mobile.

## What it costs: the privacy contract changes

The public profile promises P1, "no persistence: bytes exist only for one request, in memory". The Files protocol cannot keep that promise: the upload lands in storage between two tool calls, and a result is fetched from storage after the call returns. The honest replacement is:

**F1. Transient storage only, for transfer.** An uploaded PDF and a returned PDF exist in the transfer bucket only while the transfer needs them, and never longer than 2 hours. Nothing else is stored: no database, no index of files, no copy after deletion. Processing still happens in memory, per request. Deletion works in three layers:

- the server replaces an upload's bytes with an empty tombstone as soon as the second call consumes it. The key stays, so the upload URL can never write again;
- a Vercel cron (`api/files-sweep.js`, `remote/files-sweeper.mjs`) runs every 10 minutes. It deletes every object under the Files prefixes (`up/`, `dl/`, `claimed/`, and nothing else in the bucket) that is older than 65 minutes. Nothing legitimate needs an object that long: upload sessions end at 60 minutes and download URLs at 55. When every run happens, an object is gone within 75 minutes. It is still gone within 2 hours if up to four runs in a row are missed; Vercel can skip or delay a cron run, and the sweep is idempotent. A run that deletes an object older than 85 minutes logs an ERROR line saying scheduled runs were missed;
- a 1-day bucket lifecycle rule is the backstop if the cron stops entirely, where the Marketplace account allows setting one. It cannot carry the promise alone, because S3 lifecycle rules count whole days and round up to the next midnight UTC.

The sweeper runs whenever the bucket is connected, whether or not Files is enabled, so switching Files off never strands stored transfers. Files is never advertised unless `CRON_SECRET` is set. Without the secret, the cron endpoint refuses and logs an ERROR line.

**Operations.**
- *Disable:* unset `PDF_TOOLS_FILES_ENABLED` (or set it to `0`) and redeploy. No new targets are issued, and the sweeper empties the prefixes within 75 minutes.
- *Rollback:* roll `pdf-tools-remote` back only to a deployment that has the sweeper cron (any from this change on). To go further back, disable Files first, wait until the sweeper reports `kept: 0` (at most 75 minutes), then roll back.
- *Missed runs:* an ERROR line from the sweeper means runs were missed. Start a run from the project's Cron Jobs settings in Vercel ("Run"), check that the next run reports no late objects, and check the cron's recent invocations.

This changes the listing and the privacy policy wording: "processed per request and not stored" becomes the approved "held up to 2 hours for transfer, then deleted automatically". Until production is switched on:

- the extension is not advertised in production;
- the existing inline and URL inputs keep working unchanged, and remain the only path in production;
- previews may enable it against a test bucket.

## Decisions (Mat, 2026-11-25 and 2026-11-26)

1. **Storage host: `files.opendocuments.ai`, a Vercel external rewrite to the Vercel Marketplace S3 bucket.** No separate AWS account. The ODA Vercel project `pdf-tools-files` owns the hostname and rewrites `/up/` and `/dl/` to the private bucket (`files-host/`). Uploads cannot pass through `mcp.opendocuments.ai` itself, because a function request body is capped near 4.5 MB. Vercel Blob is a shared host, which Anthropic refuses. A protected preview proved the rewrite on 2026-11-26 with 50 MB and 100 MB PUT and GET (SHA-256 matched). It also proved write-once and signed size: a second PUT is refused 412, and another size, or a missing condition, is refused 403. Unsigned and tampered requests are refused, and deletion works. DNS is a single `CNAME` at GoDaddy.
2. **Retention and wording.** Decided: "held up to 2 hours for transfer, then deleted automatically", enforced by the sweeper above.
3. **One upload per call at launch.** The Marketplace role's sessions last at most one hour (measured: 3601 seconds is refused), and a presigned URL dies with its session. One upload target (at least 20 minutes; signed for 25, to leave room for the response) and downloads (55 minutes, "about an hour") fit. Several targets in one call need 75 minutes, which needs the role's maximum session raised in the Marketplace AWS account. So `merge_pdfs` does not offer `uploads`.
4. **Public route only at launch.** Files is offered on `https://mcp.opendocuments.ai/mcp`. The authenticated signing route `/mcp/sign` does not offer it. It keeps its existing inputs, and its state would have to bind the Lumin principal before uploads could be added there.
5. **Host approval.** Mat sends the email; the plugin lane keeps the draft. It names `files.opendocuments.ai` as a production host on Vercel's edge network, proxying to our own bucket.

Also required, outside our control: the connector must be listed in the Connectors Directory at exactly `https://mcp.opendocuments.ai/mcp` before Claude sends any file to it.

## Design (flagged, previews first)

**Advertisement.** `server/discover` adds `capabilities.extensions["io.modelcontextprotocol/files"] = { "upload": {} }` only when `PDF_TOOLS_FILES_ENABLED=1` and a storage adapter is configured, and only on 2026-07-28 connections. Each `tools/call` reads the client's declaration from `params._meta["io.modelcontextprotocol/clientCapabilities"]` every time.

**Inputs.** The existing document tools gain an optional `upload` argument whose object schema carries `x-mcp-file: { "accept": ["application/pdf"], "maxSize": 26214400 }`, alongside `file`, `pdf_url` and `pdf_base64` (exactly one still required). The tool names do not change, so the plugin lane's connector packet stays valid; the property appears only where the extension is enabled. The advertised set is exactly the tools that take one document as `file`. A call that carries `upload` to any other tool, or to an unknown name, is refused with `UPLOAD_UNSUPPORTED_TOOL` before any target is issued. `merge_pdfs` does not offer `uploads` (decision 3).

**First call** (metadata only): validate type and size, then answer `resultType: "upload_required"` with one presigned `PUT` target (`credentials: "omit"`, headers `Content-Type: application/pdf` and `If-None-Match: *`, signed for 25 minutes, with `expiresAt` stating the exact expiry the URL was signed with) and a `requestState`, and `content: []` as the SDK requires.

**requestState** is a sealed value (`remote/sealed.mjs`, new purpose `files`), binding the tool name, a digest of the arguments, the object keys and declared sizes and digests, the connection kind (public at launch), and an expiry of 1 hour, so the sweeper (65 minutes) cannot remove a file a live session still needs. It never carries a token.

**Second call:** open the state (else -32602), compare tool name and arguments (else -32602), and `HEAD` the object (if it is missing, -32602, and nothing is used up). Then take it:
- a claim marker is written with `If-None-Match: *`, which decides the single run, so two concurrent repeats cannot both run;
- the object is read;
- its bytes are replaced by an empty tombstone. It is never deleted, so S3's condition on the upload URL keeps refusing writes until the URL expires.

Then the exact size and digest are checked, and the tool runs on those bytes inside the existing isolated child and caps. A replay finds the claim and fails -32602. This needs no database.

**Outputs.** When the call declared `download`, a new PDF is written to the bucket under a random key and returned in `_meta["io.modelcontextprotocol/files"].downloads[]` with name, `application/pdf`, exact size, SHA-256 digest, a presigned `GET` URL valid 55 minutes, and `credentials: "omit"`. Generated PDFs keep the existing 3 MB output limit (`OUTPUT_TOO_LARGE`), so at launch downloads carry results up to 3 MB. Larger inputs (up to 25 MB) work for every tool whose result fits that limit: reads, info, and page selections that stay small. A result returned inline, when the client did not declare download, also counts toward Claude's response-size limit. The URL never appears in `content` or `structuredContent`. Without `download`, results come back inline as today.

**Storage adapter.** `remote/file-store.mjs` exposes `presignUpload`, `head`, `take`, `putResult`, `presignDownload`, and, for the sweeper only, `list` and `delete`. The S3 implementation signs requests itself (`remote/aws-s3.mjs`, checked against AWS's published Signature Version 4 examples), so no AWS SDK is added to `package.json`. It has no stored AWS key. For each request it exchanges that request's Vercel OIDC token for Marketplace role credentials (`AssumeRoleWithWebIdentity`), reusing a session only while it outlives the URL being signed. URLs are signed for the bucket host and handed out on `PDF_TOOLS_FILES_ORIGIN`, and the files host forwards them unchanged. An in-memory store serves the tests. Nothing logs keys, URLs, tokens or object names.

**Configuration** (`pdf-tools-remote`): `PDF_TOOLS_FILES_ENABLED=1`, `PDF_TOOLS_FILES_ORIGIN=https://files.opendocuments.ai`, `PDF_TOOLS_FILES_SEALING_KEYS` and `CRON_SECRET`, plus `S3_BUCKET_NAME`, `AWS_REGION` and `AWS_ROLE_ARN`, which the Marketplace integration sets. Without all of them, Files is not advertised.

**Signing surface.** Not at launch (decision 4). `/mcp/sign` neither advertises Files nor accepts `upload`.

**Logs.** Content-free as today, and additionally no object keys, presigned URLs or digests of private documents.

## Gates before production

1. The v0.16.0 tag is out. The `files.opendocuments.ai` CNAME is live, with Vercel's certificate, and serves the `files-host/` rewrite.
2. Every F1 and design property has a test with the fake stores. A preview of the exact head with the real bucket proves:
   - the role's own S3 permissions: the claim PUT, the tombstone, prefix-scoped listing and batch delete;
   - the real MCP two-call flow with a download;
   - after DNS, the same through the files host without preview authentication.

   It also proves the 1-day lifecycle backstop, if the Marketplace account allows setting one. Otherwise the sweeper alone carries F1, and the listing still says 2 hours.
3. A bounded quota on upload-target issuance for the account-free route is decided and in place, for example a Vercel firewall rate limit on `/mcp` tool calls. It must not filter the files host, which Anthropic requires to stay unfiltered.
4. Anthropic approves the hosts; the directory listing exists.
5. A real Claude run on web and mobile with a synthetic PDF above 3 MB as input and a supported result: upload, process, download a result within the output limit, reopen.
6. `remote-mcp.md`, the privacy policy and the listing state F1 in the same words.
7. The full hosted gate and an independent review of the rollout.
