# PDF Filler MCP Server - Quick Setup

Fill PDF forms with Claude in Cursor! No more manual form filling.

## Installation Methods

### 🖱️ **Option 1: Double-Click Install** (Easiest - Mac only)
Just **double-click `install.command`** - that's it!
- Opens Terminal automatically
- **Auto-moves files** from Downloads to permanent location (`~/.pdf-filler-mcp`)
- Installs everything 
- Can auto-update your Cursor config
- **Safe to delete Downloads** after install
- No Terminal knowledge needed

### 🚀 **Option 2: Smart Terminal Install** (All platforms)
```bash
./smart-install.sh
```
- Most powerful option
- Auto-detects paths
- Can automatically update your mcp.json
- Handles all edge cases

### 🛠️ **Option 3: Manual Install** (Fallback)
```bash
./install.sh
```
- Shows exact paths to copy
- Manual but foolproof
- For when auto-install doesn't work

## What You Need
- **Node.js** installed (v18 or higher) - Get it at [nodejs.org](https://nodejs.org)
- **Cursor** with MCP support

## 🗂️ **Installation Location**
- **If run from Downloads**: Auto-moves to `~/.pdf-filler-mcp` (permanent)
- **If run elsewhere**: Installs in current location
- **Safe cleanup**: Can delete original files after install

## After Installation
1. **Completely quit Cursor** (Cmd+Q on Mac, Alt+F4 on Windows)
2. **Restart Cursor**
3. **Look for "pdf-filler"** in MCP servers showing "11 tools enabled"
4. **Toggle it on** if needed

## Usage Examples
Once installed, ask Claude in Cursor:
- *"Read the form fields in this PDF file"*
- *"Fill this W-9 form with my business information"* 
- *"List all PDFs in my Documents folder"*
- *"Create a profile with my personal info for future forms"*
- *"Fill 50 PDFs using data from this spreadsheet"*
- *"Read the content of this PDF document"*
- *"Analyze this scanned invoice PDF"*

## Tools Available
- **list_pdfs** - List PDF files in directories
- **read_pdf_fields** - Read form fields from PDFs
- **fill_pdf** - Fill PDF forms with data
- **bulk_fill_from_csv** - Fill multiple PDFs from CSV data
- **save_profile** / **load_profile** - Save/load common form data
- **fill_with_profile** - Fill PDFs using saved profiles
- **extract_to_csv** - Export PDF data to spreadsheets
- **validate_pdf** - Check for missing required fields
- **read_pdf_content** - Read and analyze full PDF content (with OCR support for scanned PDFs)

## Troubleshooting
- **Node.js not found?** Install from [nodejs.org](https://nodejs.org)
- **Tools not appearing?** Try restarting Cursor completely
- **Permission denied?** Run `chmod +x *.sh` in the folder
- **Path issues?** The install scripts auto-detect the correct path
- **Broke after cleaning Downloads?** The installer prevents this!

## What This Does
This MCP server lets Claude directly:
- Read PDF form fields 
- Fill out forms programmatically
- Save common data as reusable profiles
- Process multiple PDFs from spreadsheet data
- Validate forms for completeness
- Extract and analyze full PDF content
- Handle scanned PDFs with automatic OCR

Perfect for W-9s, job applications, contracts, invoices, and any PDF processing! 