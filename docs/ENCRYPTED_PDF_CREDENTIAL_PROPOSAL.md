# Private password entry for encrypted PDFs

Status: implemented in the private-entry source tranche. Release and desktop-host
qualification are separate from source tests; this document does not claim an
OpenAI allowlisting or public release.

## Current boundary

PDF tools no longer accept top-level `password`, `before_password`, or
`after_password` arguments. Legacy calls, including null or empty values, fail
before filesystem or parser actions without reflecting their values. A PDF form
field or extraction-schema property named `password` is ordinary document data,
not an authentication channel. Low-level isolated worker protocols remain
internal and are not MCP tools.

The download tool no longer accepts custom HTTP headers. Authenticated
downloads should happen through the provider's user-facing interface, followed
by opening the saved local file. Lumin authentication continues to use its
existing browser OAuth flow, not credentials supplied in chat.

## User experience

When an encrypted document needs a password, PDF Tools offers a local unlock
window. The user enters the password there, outside chat. The assistant receives
only an awaiting-password, locked, unlocked, or expired status for that document.
Call `unlock_pdf` with the local path, enter the password in the opened browser
window, then retry the PDF operation. `get_pdf_unlock_status` checks access;
`lock_pdf` and the window's Lock button clear it. Access expires after at most
ten minutes and ends with the server session. Ordinary non-encrypted workflows
remain unchanged. Restarting the host requires unlocking again.

The implementation provides a direct user-to-local-server channel.
Sending the password through an app-only MCP tool is not an acceptable shortcut:
it would still be a tool argument. A viewer-only PDF.js prompt would likewise
not unlock extraction or mutation tools running in the server.

## Implemented boundary

- Use a local, user-facing entry surface connected to the already-running
  server through authenticated local IPC or a tightly bounded loopback service.
  The browser connects only to `127.0.0.1` on an ephemeral port, with a random
  256-bit capability initially carried in the fragment and removed from browser
  history by the page. The URL is never returned through MCP. Requests require
  exact Host/Origin, POST, JSON content type, bounded bodies and the capability.
  The page has no external assets and a restrictive CSP; request bodies are not
  logged. Pending windows last five minutes. A successful window retains its
  lock capability for the credential lifetime. At most eight documents and one
  password validation are active; attempts and validation time are bounded.
- Keep credentials in process memory, not command-line arguments, URLs, MCP
  calls/results, analytics, logs, temporary plaintext PDFs, or saved profiles.
  JavaScript memory and operating-system swap do not provide guaranteed erasure.
- Bind each entry to the canonical path, exact encrypted source hash and file
  identity. Revalidate before use; changed bytes invalidate it. Scope access to
  the server session and document, not all files with the same password.
- Remove public password arguments from discovery. Reject
  legacy password arguments without echoing their values, and resolve the
  credential internally before invoking existing bounded PDF.js/QPDF workers.
- Expire entries, cap their count and lifetime, clear them on explicit lock,
  disconnect or restart, and avoid transferring them to another session.
- Preserve existing permission checks and unsupported-operation errors.
  Unlocking for reading is not permission to modify. Encrypted inputs must
  produce encrypted outputs or fail; the existing QPDF reprotection contract
  remains in force.

Each input to a multi-document mutation must be unlocked independently. The
existing worker requires the same password for all encrypted inputs; this
tranche does not add mixed-password merge support. Encrypted rendering,
geometry, comparison, and accessibility inspection remain unsupported where
the underlying operation already refused them. Unlocking does not lift those
limits. Locking does not erase text already read, completed output files, or
existing extraction workspaces.

This is a local trusted-user boundary, not protection against malware, browser
extensions, a hostile same-user process, root, OS swap, or a compromised host.
There is no credential persistence or transfer between server instances.

## Qualification before enabling

Test wrong passwords, cancel/expiry/restart, changed sources, concurrent
documents, attempted cross-session access, forged local requests, and old
model-visible password inputs. Assert that passwords never appear in captured
MCP messages, tool errors, logs, process arguments, persisted state or output
artifacts. Test read and write permission distinctions and encrypted-output
preservation, then exercise the real user entry flow in supported desktop hosts.

An installed-host run and exact packaged-source check are required before
claiming desktop qualification. Synthetic test passwords may appear in test
fixture code; they must not appear in the captured product MCP traffic, logs,
saved profiles, or generated document metadata.
