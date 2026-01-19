# PDF Toolkit MCP - Development Guide

This document provides essential context for Claude and other AI assistants when working on the PDF Toolkit extension.

## Project Overview

PDF Toolkit is a Claude Desktop extension (MCPB) and MCP server that enables automated PDF form filling, bulk processing, and data extraction. Published in the official Claude Desktop Extension Directory.

### Key Features
- List PDF files in directories
- Read form fields from PDFs (text, checkboxes, dropdowns, radio buttons)
- Fill PDF forms programmatically
- Save filled PDFs to new files
- Password-protected PDF support
- Bulk fill from CSV files
- Profile system for reusable data
- Extract data from PDFs to CSV
- Form validation
- OCR support for scanned PDFs

## Technical Architecture

### Technology Stack
- **Runtime**: Node.js (CommonJS modules for Claude Desktop compatibility)
- **PDF Libraries**: pdf-lib, pdf-parse, pdfjs-dist
- **Protocol**: MCP (Model Context Protocol)
- **Extension Format**: MCPB (built via `mcpb pack`)

### Important Files
- `server/index.js` - Main MCP server implementation (all tool definitions and helpers). Prefer incremental updates over rewrites.
- `manifest.json` - Claude Desktop extension metadata and UI stub. Update versions alongside package.json.
- `manifest.mcpb.json` - MCPB packaging manifest
- `package.json` - Node.js dependencies
- `pdf-toolkit-mcp-share/` - Shareable package for Cursor users. Mirror changes from server/index.js when APIs evolve.
- `example-fw9.pdf` - Sample form for smoke tests. Keep anonymized assets only.
- `docs/MAINTAINERS.md` - Maintainer onboarding and operations
- `docs/RELEASE.md` - Release checklist

## Critical: CommonJS Format

The project uses CommonJS modules for Claude Desktop compatibility. This is **required**:
- Use `require()` instead of `import`
- Use `module.exports` instead of `export`
- Do NOT convert to ES modules

This constraint exists because Claude Desktop's extension runtime expects CommonJS.

## Password Support

Password functionality for encrypted PDFs is implemented across all relevant tools:
- `read_pdf_fields`
- `fill_pdf`
- `bulk_fill_from_csv`
- `fill_with_profile`
- `validate_pdf`

Pass the optional `password` parameter when working with protected PDFs.

## Development Commands

### Build and Package
```bash
# Install dependencies
npm install

# Run MCP server locally (for testing with Claude Desktop or Cursor)
node server/index.js

# Build MCPB for Claude Desktop
mcpb pack

# Create shareable package for Cursor
node package-for-friend.js
```

### Testing
No automated test suite yet. Perform manual runs against `example-fw9.pdf`:
1. `list_pdfs` against a local directory
2. `read_pdf_fields` on example-fw9.pdf
3. `fill_pdf` with test data
4. Profile flow: `save_profile`, `load_profile`, `fill_with_profile`
5. `bulk_fill_from_csv` with a two-row CSV (include a comma in one value)
6. `extract_to_csv` on two PDFs
7. `validate_pdf` on a partially filled form
8. `read_pdf_content` on text and scanned PDFs

## Available Tools (12 total)

1. **list_pdfs** - Lists PDF files in a directory
2. **read_pdf_fields** - Extracts form field information
3. **fill_pdf** - Fills a PDF form with data
4. **bulk_fill_from_csv** - Fill multiple PDFs from CSV
5. **save_profile** - Save form data as reusable profile
6. **load_profile** - Load a saved profile
7. **list_profiles** - List all saved profiles
8. **fill_with_profile** - Fill PDF using saved profile
9. **extract_to_csv** - Extract data from PDFs to CSV
10. **validate_pdf** - Check for missing required fields
11. **read_pdf_content** - Extract text/images from PDFs (OCR support)
12. **get_pdf_resource_uri** - Get resource URI for a PDF file

## Code Standards

### Coding Style
- 2-space indentation
- `const`/`let` semantics (no `var`)
- Double-quoted strings
- Tool names are snake_case (`list_pdfs`, `fill_pdf`)

### Helper Functions
Reuse existing helpers in `server/index.js`:
- `resolvePath` - Resolve file paths safely
- `fillPdfFields` - Core PDF filling logic
- Profile utilities for save/load operations

### Error Handling
- Provide clear, actionable error messages
- Handle password-protected PDFs gracefully
- Guide users to correct tools (e.g., "use 'read_pdf_fields' to see available fields")

### Security
- Never log or expose passwords
- Validate file paths to prevent directory traversal
- Use secure defaults for all operations
- Never hard-code personal paths; use `resolvePath` and default directories

## Common Issues & Solutions

### Module not found errors
Ensure CommonJS syntax is used throughout. Check for any `import`/`export` statements that should be `require()`/`module.exports`.

### Password-protected PDF errors
Pass the `password` parameter to relevant tools. The error message should indicate if a password is required.

### MCPB not loading in Claude Desktop
1. Ensure `mcpb pack` completed successfully
2. Check Claude Desktop logs for errors
3. Verify `manifest.mcpb.json` is valid JSON

### CSV parsing issues
Ensure CSV values with commas are properly quoted. Test with a value containing a comma before publishing.

## Versioning

When releasing, update versions in all places:
- `package.json`
- `manifest.json`
- `manifest.mcpb.json`

Keep versions aligned. See `docs/RELEASE.md` for the full checklist.

## Upstream Dependencies

- MCP spec and org: https://github.com/modelcontextprotocol
- MCPB CLI: https://github.com/modelcontextprotocol/mcpb
- SDK package: `@modelcontextprotocol/sdk`

Watch the MCPB repo for releases and breaking changes.

## Commit & Pull Request Guidelines

### Commit Style
- Use imperative subject style (e.g., "Update index.html to improve structure")
- Group related changes together
- Note version bumps explicitly in commit messages

### Pull Requests
- Include summary of affected tools
- Provide manual test evidence
- Link related issues if applicable
- Only include screenshots when UI assets change

### Artifacts
- Regenerate artifacts (`pdf-toolkit-mcp.zip`, `.mcpb`) in separate commits
- Or attach them to releases rather than merging binaries directly
- Keep version numbers aligned across `package.json`, `manifest.json`, and the share bundle

### Before Committing
- Scrub PDFs or CSVs of personal data before committing
- Use local-only credentials files when testing protected documents
- Never commit sensitive test data

## Contributing

1. Read `docs/MAINTAINERS.md` for architecture details
2. Follow `docs/RELEASE.md` before publishing
3. Use GitHub Issues for bugs and feature requests
4. Include manual test evidence in PRs

## Project Links

- **Repository**: https://github.com/matsilverstein/pdf-toolkit-mcp
- **Issues**: https://github.com/matsilverstein/pdf-toolkit-mcp/issues
