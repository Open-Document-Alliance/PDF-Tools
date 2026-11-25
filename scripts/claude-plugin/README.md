# PDF Tools

Work with PDFs in Claude: read and search them, convert pages to Markdown, fill and validate forms, merge, split, rotate and reorder pages, compare two documents, and place visible signature stamps. Results report what was read and what was missed, rather than claiming completeness.

PDF Tools is maintained by Open Document Alliance. Source: [Open-Document-Alliance/PDF-Tools](https://github.com/Open-Document-Alliance/PDF-Tools).

## What you get on each Claude surface

| Surface | What runs | Where your PDF is processed |
| --- | --- | --- |
| Claude Code, and Cowork sessions on your computer | The full local PDF Tools server (more than 60 tools, including profiles, bulk CSV fill, layout extraction, document comparison and the interactive viewer) plus the hosted connector | Local tools: on your machine. Hosted tools: only when used, see below |
| claude.ai and the Claude apps (chat) | The hosted PDF Tools connector | On the PDF Tools service, per request, without storing documents |
| Everywhere | The `pdf-tools` and `pdf-tools-workflow` skills | Instructions only; they run nothing |

The `pdf-tools` skill tells Claude to use the local server for files on your computer and the hosted connector only for chat attachments, links, or when you ask for it.

## Privacy

- **Local runs keep files on your machine.** The local server reads and writes only folders you have allowed. The one exception is a Lumin signing request: when you confirm the send, `send_lumin_request` uploads that one prepared PDF to Lumin, which emails the signers you listed.
- **The hosted connector processes each request without storing documents.** It receives only the PDF supplied for that call (an attachment, a URL, or inline bytes) and returns the result.
- **Your Claude host's data terms apply** to any content returned into the conversation.

Privacy policy: <https://www.opendocuments.ai/privacy-policy>. Terms: <https://www.opendocuments.ai/terms-of-service>.

## What this plugin runs, sends and fetches

Everything below is in this folder as readable source.

1. **First-run dependency install (Claude Code and local Cowork only).** The plugin does not bundle `node_modules`. The first time the local server starts for a given plugin version, `runtime/start.mjs` copies the server source into the plugin's data folder (`~/.claude/plugins/data/...`) and runs `npm ci --omit=dev --ignore-scripts` there. That downloads the five packages pinned in `package-lock.json` (`@modelcontextprotocol/server`, `@napi-rs/canvas` with the native build for your platform only, `pdf-lib`, `pdfjs-dist`, `yaml`) and their dependencies from your configured npm registry, normally `registry.npmjs.org`. npm checks each package against the lockfile's integrity hash. Package install scripts are disabled. Later starts reuse the install.
2. **SessionStart hook.** `hooks/hooks.json` runs `runtime/start.mjs --prepare` when a session starts. If the install for this version is missing, it starts that install in the background and returns at once. It does nothing else.
3. **Local MCP server (`pdf-tools`).** `node runtime/start.mjs` starts `server/index.js` over stdio. It makes no network requests except:
   - `fetch_pdf_from_url`, which downloads a PDF from a URL you give it into an allowed folder, with redirect, size and destination limits;
   - the optional Lumin signing tools (`*_lumin_*`), which contact Lumin (`auth.luminpdf.com`, `api.luminpdf.com`) only when you use them: to connect your Lumin account, to send a prepared PDF and the recipients you listed at the explicitly confirmed send step, and to check status and download the completed file from the link Lumin provides.

   For an encrypted PDF it can open a short-lived password page served only on `127.0.0.1`, so you type the password there instead of into the conversation.
4. **Hosted MCP connector (`pdf-tools-hosted`).** `https://mcp.opendocuments.ai/mcp`, operated by Open Document Alliance. No account or API key is needed. It is contacted only when Claude calls one of its tools.

The plugin collects no telemetry.

## First run: allow the folders PDF Tools may read

Out of the box the local server reaches exactly one folder: a private `workspace` folder inside the plugin's data folder. To let it open PDFs where you keep them, edit the `config.json` it creates next to that workspace. Ask Claude to run `get_allowed_directories`, which reports the active folders and the exact config path, then list your folders:

```json
{
  "allowedDirectories": ["/Users/you/Documents", "/Users/you/Desktop"]
}
```

Use absolute paths only, then restart the session. A non-empty list replaces the private workspace rather than adding to it. If you already use PDF Tools elsewhere with `~/.pdf-tools/config.json`, that file applies until the plugin's own list is non-empty. You edit this file yourself on purpose: the server cannot tell your words from the agent's, so it never widens its own access.

## Requirements and limits

- The local server needs Node.js 20.19+ or 22.12+ with npm, and network access to the npm registry on first run.
- The local server runs on macOS (Apple silicon and Intel), Windows (x64 and arm64) and Linux x64 with glibc: the platforms whose native rendering build PDF Tools reviews. On any other platform the first-run install stops and says so; the hosted connector still works.
- No OCR. Scanned pages are reported as needing vision, not read as text.
- Signatures are visible stamps, not cryptographic or legally binding signatures. Applying one requires your own words confirming intent.
- The hosted connector reads at most 10 pages per call, takes inputs up to 25 MB and 200 pages, returns at most 3 MB inline, and refuses encrypted PDFs.

## Usage

Try:

- "Read the first three pages of ~/Downloads/lease.pdf and tell me what the text extraction missed."
- "List the fields in this form, then fill only the values I give you."
- "Make a new PDF with pages 3 and 1 of this attachment, in that order."
- "Compare these two contracts and list every change, with page numbers."

## Support

Issues: <https://github.com/Open-Document-Alliance/PDF-Tools/issues>. License: MIT.
