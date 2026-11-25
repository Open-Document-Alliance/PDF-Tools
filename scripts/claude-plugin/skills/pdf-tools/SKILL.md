---
name: pdf-tools
description: Choose the right PDF Tools connection for the PDF in front of you. Use when the user wants to open, read, search, convert, fill, sign, merge, split, rotate, reorder or compare a PDF, whether it is a file on their computer, an attachment in this conversation, or a link.
---

# PDF Tools: which connection to use

This plugin carries two PDF Tools connections. They have different reach, so
pick by where the PDF is.

| Where the PDF is | Use | Why |
| --- | --- | --- |
| A file on the user's computer (a path, a folder, "my Downloads") | `pdf-tools` (local) | Runs on this machine. Files stay on the machine. Reads only folders the user has allowed. |
| An attachment in a claude.ai or Claude app chat | `pdf-tools-hosted` | Chat cannot start local servers. The hosted service processes the supplied PDF for that one request and does not store it. |
| A public link | `pdf-tools` if available (`fetch_pdf_from_url` saves a local copy), otherwise `pdf-tools-hosted` with `pdf_url` | Prefer local processing whenever the local server is connected. |

Rules:

- When the local `pdf-tools` tools are connected, use them for local files.
  Never read a local file and send its bytes to `pdf-tools-hosted` unless the
  user explicitly asks for hosted processing of that file.
- If only `pdf-tools-hosted` is connected and the user names a file on their
  computer, say that this surface cannot reach local files and ask them to
  attach the PDF instead.
- If the local server reports that it is installing its dependencies, tell the
  user it is a one-time setup and retry after it finishes.
- If the local server says no folders are allowed, run
  `get_allowed_directories` and give the user the exact config file path it
  reports. Only the user edits that file; never offer to widen it yourself.
- Signatures from either connection are visible stamps, not cryptographic or
  legally binding signatures, and need the user's own words confirming intent.

Privacy, stated the same way everywhere:

- Local runs keep files on the user's machine.
- The hosted service processes each request without storing documents.
- Content returned into the conversation follows the host's data terms.

For multi-step edits, checks and comparisons, follow the `pdf-tools-workflow`
skill: inspect, compare, plan, authorize, transform, validate, return.
