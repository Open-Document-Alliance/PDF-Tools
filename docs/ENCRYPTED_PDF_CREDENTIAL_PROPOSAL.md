# Private password entry for encrypted PDFs

Status: design proposal, not implemented or claimed as shipped.

## Current boundary

Several PDF tools currently accept a PDF password in their MCP arguments.
Those arguments are model-visible. The existing viewer has no independent
password-entry prompt, and Lumin's browser OAuth flow is provider-specific.
Neither is an encrypted-PDF credential service.

The download tool no longer accepts custom HTTP headers. Authenticated
downloads should happen through the provider's user-facing interface, followed
by opening the saved local file. Lumin authentication continues to use its
existing browser OAuth flow, not credentials supplied in chat.

## Proposed user experience

When an encrypted document needs a password, PDF Tools offers a local unlock
window. The user enters the password there, outside chat. The assistant receives
only a locked/unlocked/expired status for that document. A visible lock action
and short expiry end access. Ordinary non-encrypted workflows remain unchanged.

The implementation must provide a direct user-to-local-server channel.
Sending the password through an app-only MCP tool is not an acceptable shortcut:
it would still be a tool argument. A viewer-only PDF.js prompt would likewise
not unlock extraction or mutation tools running in the server.

## Proposed implementation boundary

- Use a local, user-facing entry surface connected to the already-running
  server through authenticated local IPC or a tightly bounded loopback service.
  Select and qualify that transport before shipping. For a browser surface,
  require an unpredictable session capability, exact Host/Origin checks,
  POST-only submission, expiry, no external assets, and no request-body logging.
- Keep credentials in process memory, not command-line arguments, URLs, MCP
  calls/results, analytics, logs, temporary plaintext PDFs, or saved profiles.
  JavaScript memory and operating-system swap do not provide guaranteed erasure.
- Bind each entry to the canonical path, exact encrypted source hash and file
  identity. Revalidate before use; changed bytes invalidate it. Scope access to
  the server session and document, not all files with the same password.
- Remove public password arguments when this mechanism is implemented. Reject
  legacy password arguments without echoing their values, and resolve the
  credential internally before invoking existing bounded PDF.js/QPDF workers.
- Expire entries, cap their count and lifetime, clear them on explicit lock,
  disconnect or restart, and avoid transferring them to another session.
- Preserve existing permission checks and unsupported-operation errors.
  Unlocking for reading is not permission to modify. Encrypted inputs must
  produce encrypted outputs or fail; the existing QPDF reprotection contract
  remains in force.

## Qualification before enabling

Test wrong passwords, cancel/expiry/restart, changed sources, concurrent
documents, attempted cross-session access, forged local requests, and old
model-visible password inputs. Assert that passwords never appear in captured
MCP messages, tool errors, logs, process arguments, persisted state or output
artifacts. Test read and write permission distinctions and encrypted-output
preservation, then exercise the real user entry flow in supported desktop hosts.

This proposal requires review and implementation before a submission may claim
password-free encrypted-PDF authentication. The annotation and download changes
do not implement this separate capability.
