# Support and Triage

Use this when handling issues from users or downstream maintainers.

## 1) Intake checklist

- Which MCP host? (Claude Desktop vs Cursor)
- Host version and OS
- Steps to reproduce
- Sample files (scrubbed PDFs/CSVs)
- Exact error text / screenshots if applicable

## 2) Fast classification

- Install/config issue (MCP host config, path, permissions)
- Tool runtime issue (PDF parsing, OCR, profiles)
- Packaging issue (mcpb pack, zip installer)

## 3) Minimal repro

- Try `list_pdfs` and `read_pdf_fields` on `example-fw9.pdf`
- Confirm `read_pdf_content` on a simple text PDF
- Confirm `get_pdf_resource_uri` on a local file

## 4) Escalation

- Open a GitHub Issue with repro steps and environment
- Note whether regression vs long‑standing behavior
- If packaging-related, run the manual checklist and attach logs
