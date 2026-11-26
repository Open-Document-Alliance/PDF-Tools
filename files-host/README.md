# files.opendocuments.ai

The transfer host for the hosted server's MCP Files extension (docs/REMOTE_FILES_PROFILE_2026-11-25.md). It is the Vercel project `pdf-tools-files` in the Open Document Alliance team, separate from `pdf-tools-remote`, and it serves nothing of its own: it rewrites `/up/` and `/dl/` to the private Files bucket, and everything else is 404 (robots.txt aside).

Every request carries its own S3 signature, made by `pdf-tools-remote` for one object key. The bucket refuses anything unsigned, expired or tampered with, and the rewrite passes S3's answer through unchanged. Upload URLs sign `Content-Length`, `Content-Type` and `If-None-Match: *`, so each accepts exactly one write of the declared size. Responses are never cached. Claim markers (`claimed/`) and anything else in the bucket are not reachable through this host.

Deploy (production only after the Files gates in the profile):

```
vercel deploy files-host --scope open-document-alliance --project pdf-tools-files --prod
```

Project settings that must stay this way, because Anthropic's Files guide refuses targets behind a sign-in page, a bot challenge, or a filter on User-Agent or source address:

- no Vercel Authentication or password protection on the production domain;
- no Attack Challenge Mode, bot protection or firewall rules on `/up/` or `/dl/`;
- `files.opendocuments.ai` attached to this project, reached by a `CNAME` to Vercel, with Vercel's certificate.

Vercel ends a proxied request after 120 seconds. Uploads are at most 25 MB, and a 100 MB transfer took about 6 seconds through this rewrite on a preview.
