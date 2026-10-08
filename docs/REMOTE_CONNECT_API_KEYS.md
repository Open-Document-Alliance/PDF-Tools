# Optional API keys for Vercel Connect

This is a separate, opt-in connection surface for credential brokers. It does
not replace the public, unauthenticated endpoint documented in `remote-mcp.md`.
Deploying it requires maintainer approval and a configured signing secret.
Until that configuration is present, issuance and the protected route return
503, while the original `/mcp` continues to work without authentication.

## Caller setup

1. Open `https://mcp.opendocuments.ai/connect` and create an app key. No account,
   email address, document, or other caller data is requested.
2. Store the key in the Vercel Connect API-key connector or a secret manager.
3. Use `https://mcp.opendocuments.ai/mcp/connect` over Streamable HTTP, with
   `Authorization: Bearer <key>`.
4. Create a replacement key before the displayed expiry and update the
   connector. Keys last 90 days. Replacing a key does not revoke the old one;
   it remains valid until expiry or maintainer rotation of the signing secret.

The protected endpoint rejects missing, forged, or expired keys before loading
the PDF handler or reading the document body. Authorized requests use the same
twelve tools and document limits as the public endpoint. A key is a signed
capability for stateless PDF processing; it grants no access to stored
documents, user accounts, or other callers' requests.

## Stateless credential profile

The service keeps no individual key records, accounts, sessions, or key-to-person
mapping. Tokens contain a random nonce and an expiry, signed with a server
secret, and are verified locally. Request and response bodies, Authorization
headers, and keys must never be added to application logs or analytics.

The signing secret is retained in Vercel's environment configuration. There is
no individual revocation list; changing that secret invalidates all existing
Connect keys. The public endpoint remains available during a rotation.

Issuance is public because processing documents does not require an account or
access to any stored record. API keys do not introduce caller quotas, billing,
or an abuse-prevention claim. The public endpoint's caps and fair-use policy
continue to apply. Issuance accepts only an empty JSON object, refuses bodies
over 512 bytes, and refuses browser requests from other origins.

## Maintainer activation and rollback

1. Review the source and run `node --test test/connect-auth.test.js`.
2. Generate a random 32-byte secret, encode it as 64 lowercase hex characters,
   and store it as the sensitive production environment variable
   `PDF_TOOLS_CONNECT_SIGNING_SECRET` in the `pdf-tools-remote` project under
   Open Document Alliance. Keep its value out of logs, commits, and receipts.
3. Deploy the reviewed source. No database, document storage, or local extension
   change is required. `vercel.json` preserves `/mcp` and adds `/mcp/connect`
   and `/connect`. Native PDF.js and canvas assets are traced for both handlers.
4. Verify the real browser key flow, then missing/invalid/valid/expired key
   behavior and MCP discovery through the protected endpoint. Repeat the
   synthetic read/fill/zone/flatten checks with a real issued key and confirm
   that unauthenticated discovery still works through the original endpoint.
5. Submit the API-key connection method only after those deployed checks pass.
   Use `/connect` as the setup and documentation URL, `/mcp/connect` as the
   service URL, and app-scoped credential defaults.

To roll back, restore the preceding deployment and remove the signing-secret
configuration when it is no longer used. Removing the secret alone makes the
new authenticated surface fail closed; it does not disable the public endpoint.

## Evidence boundary

Local crypto, refusal, bounded-issuance, and delegation tests establish source
behavior. They are not a deployment, a server-log audit, Connect acceptance,
or proof of every PDF operation. Record the exact deployment and source SHA
separately after activation. Signature execution requires the existing explicit
human intent; the connection work does not authorize signing a real document.
