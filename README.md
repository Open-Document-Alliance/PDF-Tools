# PDF Tools - Analyze, Extract, Fill, Compare

A comprehensive PDF toolkit for Claude that enables document analysis, data extraction, form filling, and comparison. Works with **both** Claude Desktop (as an extension) **and** Cursor (as an MCP server).

## 🎯 **Choose Your Platform**

### 🖥️ **Claude Desktop Extension**
Perfect for dedicated Claude Desktop users who want PDF filling built-in.

### ⚡ **Cursor MCP Server** 
Perfect for developers who want PDF filling while coding in Cursor.

## Features

### Core Features
- 📖 **Analyze Documents** - Extract and analyze full PDF content (300+ pages)
- 📊 **Extract Data** - Pull tables, text, and structured data from any PDF
- 🔍 **Compare Contracts** - Identify changes between document versions
- ✏️ **Fill Forms** - Automate form completion (W-9, 1099, I-9, etc.)
- 📋 **List & Organize** - Browse and manage PDF collections
- 🔐 **Password Support** - Handle encrypted and protected PDFs
- 👁️ **OCR Support** - Extract text from scanned documents

### Advanced Features
- 📊 **Bulk Fill from CSV** - Fill multiple PDFs using data from spreadsheets
- 👤 **Profile System** - Save and reuse common form data
- 📤 **Extract to CSV** - Export data from filled PDFs to spreadsheets
- ✅ **Form Validation** - Check for missing required fields
- 🚀 **Easy Sharing** - Share with friends via simple installer package

## Installation

### 🖥️ **For Claude Desktop**

#### Quick Install
1. **[Download the latest .mcpb file from Releases](https://github.com/silverstein/pdf-filler-simple/releases/latest)**
2. Double-click the `.mcpb` file to install in Claude Desktop

Or manually:
1. Open Claude Desktop
2. Go to Settings → Developer → Edit Config
3. The `.mcpb` file will auto-configure itself when opened

NOTE: The extension is also available in the Claude Extensions directory. If installing from there doesn't work with your Claude Desktop version, use the `.mcpb` file from our releases instead.

#### Build from Source
```bash
git clone https://github.com/silverstein/pdf-filler-simple
cd pdf-filler-simple
npm install
npm install -g @anthropic-ai/mcpb
mcpb pack
# Install the generated .mcpb file in Claude Desktop
```

### ⚡ **For Cursor**

#### 📦 Easy Install
1. **[Download pdf-filler-mcp.zip from Releases](https://github.com/silverstein/pdf-filler-simple/releases/latest)**
2. **Unzip** the file anywhere
3. **Mac users**: Double-click `install.command` 
4. **All users**: Or run `./smart-install.sh` in Terminal
5. **Restart Cursor** - Look for "pdf-filler" with "11 tools enabled"

#### 🛠️ Developer Install
```bash
git clone https://github.com/silverstein/pdf-filler-simple
cd pdf-filler-simple
npm install

# Add to your ~/.cursor/mcp.json:
{
  "mcpServers": {
    "pdf-filler": {
      "command": "node",
      "args": ["/full/path/to/pdf-filler-simple/server/index.js"]
    }
  }
}

# Restart Cursor
```

## Usage

Works the same way in both Claude Desktop and Cursor! Ask Claude to:

### List PDFs
*"List all PDFs in my Documents folder"*
*"Show me PDF files in /Users/myname/Downloads"*

### Read PDF Form Fields
*"What form fields are in this PDF file?"*
*"Read the form fields from application.pdf on my Desktop"*

### Fill PDF Forms
*"Fill this W-9 PDF with my business information"*
*"Fill the PDF at /path/to/form.pdf with John Doe as the name and save it to filled-form.pdf"*

### Bulk Fill from CSV
*"Fill the template.pdf with data from employees.csv and save all PDFs to /Users/me/filled-forms/"*
*"Use the 'employee_name' column for filenames"*

### Save and Use Profiles
*"Save this as my 'work' profile: name John Doe, title Software Engineer, company Tech Corp"*
*"Fill application.pdf using my work profile and save to filled-app.pdf"*

### Extract Data to Spreadsheet
*"Extract all data from these PDFs to summary.csv"*

### Validate Forms
*"Validate if all required fields are filled in application.pdf"*

### Read PDF Content (NEW! v0.3.0)
*"Read the content of this PDF: /path/to/document.pdf"*
*"Convert this PDF to markdown format"*
*"Extract all text from my estate planning PDF"*
*"Summarize the main points in this contract PDF"*
*"What does this PDF say about payment terms?"*
*"Analyze this scanned invoice PDF"* (automatically uses OCR)

**Note**: The `read_pdf_content` tool automatically handles both text-based and scanned PDFs

## Sharing with Friends

### 🎁 Create Shareable Cursor Package
```bash
# For Cursor users - creates easy installer
node package-for-friend.js
# Share the generated pdf-filler-mcp.zip
```

### 🖥️ Share Claude Desktop Extension
```bash
# For Claude Desktop users
dxt pack
# Share the generated .dxt file
```

### 🚀 What Your Friends Get

**Cursor Users:**
- **Double-click installer** (Mac)
- **Smart terminal installer** (all platforms)
- **Auto-detects paths** - no manual configuration
- **Safe installation** - moves files to permanent location

**Claude Desktop Users:**
- **Simple .dxt file install**
- **Built-in extension experience**

## How It Works

This solution uses:
- [MCP (Model Context Protocol)](https://github.com/anthropics/mcp) for both Claude Desktop and Cursor integration
- [pdf-lib](https://github.com/Hopding/pdf-lib) for PDF manipulation
- Node.js for the server runtime

## Development

### Project Structure
```
pdf-filler-simple/
├── server/index.js           # MCP server (works for both!)
├── package.json             # Node.js dependencies
├── manifest.json            # Claude Desktop extension metadata
├── pdf-toolkit.dxt    # Claude Desktop extension package
├── pdf-filler-mcp-share/    # Cursor shareable package
├── pdf-filler-mcp.zip       # Cursor ready-to-share installer
└── README.md               # This file
```

### Available Tools

Same 11 tools work in both Claude Desktop and Cursor:

1. **list_pdfs** - Lists all PDF files in a specified directory
2. **read_pdf_fields** - Extracts form field information from a PDF (supports password parameter)
3. **fill_pdf** - Fills a PDF form with provided data (supports password parameter)
4. **bulk_fill_from_csv** - Fill multiple PDFs using CSV data (supports password parameter)
5. **save_profile** - Save form data as a reusable profile
6. **load_profile** - Load a saved profile
7. **list_profiles** - List all saved profiles
8. **fill_with_profile** - Fill a PDF using a saved profile (supports password parameter)
9. **extract_to_csv** - Extract data from PDFs to CSV
10. **validate_pdf** - Check for missing required fields (supports password parameter)
11. **read_pdf_content** - Read and analyze full PDF content - extract text, summarize, convert formats, answer questions

## Requirements

**For Claude Desktop:**
- Claude Desktop (with developer mode enabled)
- Node.js 18+ (for building from source)

**For Cursor:**
- Cursor with MCP support
- Node.js 18+

**Both support:** macOS, Windows, Linux

## Examples

### W-9 Tax Form
*"Fill this W-9 with my business info: Company Name LLC, 123 Main St, Tax ID 12-3456789"*

### Job Applications
*"Use my 'personal' profile to fill this job application PDF"*

### Bulk Processing
*"Fill 50 contract PDFs using the client data from contracts.csv"*

### Password-Protected PDFs
*"Read the fields from this encrypted PDF using password 'mypassword123'"*
*"Fill this protected PDF with my data, the password is 'secure456'"*

## License

MIT

## Contributing

Pull requests welcome! This project supports both Claude Desktop extensions and Cursor MCP servers.

---

**🎉 Best of both worlds - use with Claude Desktop OR Cursor!**  
**Perfect for W-9s, contracts, job applications, and any repetitive PDF form filling!** 📄✨