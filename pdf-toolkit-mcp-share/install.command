#!/bin/bash

function show_manual_method() {
    echo ""
    echo "📋 MANUAL METHOD:"
    echo "Copy this to ~/.cursor/mcp.json:"
    echo ""
    echo "{"
    echo '  "mcpServers": {'
    echo '    "pdf-filler": {'
    echo '      "command": "node",'
    echo "      \"args\": [\"$FULL_PATH\"]"
    echo '    }'
    echo '  }'
    echo "}"
    echo ""
}

# Navigate to the script's directory
cd "$(dirname "$0")"

echo "🚀 PDF Filler MCP Server Installer"
echo "==================================="
echo ""

# Check if we're in Downloads folder
CURRENT_DIR="$(pwd)"
if [[ "$CURRENT_DIR" == *"/Downloads/"* ]]; then
    echo "⚠️  You're installing from Downloads folder"
    echo "📂 For safety, I'll move the files to a permanent location"
    echo ""
    
    # Create permanent location
    PERMANENT_DIR="$HOME/.pdf-filler-mcp"
    
    if [ -d "$PERMANENT_DIR" ]; then
        echo "🔄 Updating existing installation at $PERMANENT_DIR"
        rm -rf "$PERMANENT_DIR"
    else
        echo "📁 Creating permanent installation at $PERMANENT_DIR"
    fi
    
    # Create directory and copy files
    mkdir -p "$PERMANENT_DIR"
    cp -r * "$PERMANENT_DIR/"
    
    echo "✅ Files moved to permanent location"
    echo "💡 You can now safely delete the Downloads folder contents"
    echo ""
    
    # Switch to the permanent directory
    cd "$PERMANENT_DIR"
    chmod +x *.sh *.command
fi

# Install dependencies
echo "📦 Installing dependencies..."
npm install
if [ $? -ne 0 ]; then
    echo "❌ Failed to install dependencies. Make sure Node.js is installed."
    echo "Visit: https://nodejs.org to install Node.js"
    read -p "Press Enter to exit..."
    exit 1
fi

echo "✅ Dependencies installed!"
echo ""

# Get the absolute path automatically
FULL_PATH="$(pwd)/server/index.js"
MCP_CONFIG="$HOME/.cursor/mcp.json"

echo "✨ Server installed at: $FULL_PATH"
echo ""

# Check if mcp.json exists
if [ -f "$MCP_CONFIG" ]; then
    echo "📂 Found existing MCP config"
    echo ""
    echo "🤖 Should I automatically add pdf-filler to your Cursor config?"
    echo "   Type 'y' for Yes, 'n' for No"
    read -r response
    
    if [[ "$response" =~ ^[Yy]$ ]]; then
        # Create backup
        cp "$MCP_CONFIG" "$MCP_CONFIG.backup"
        echo "💾 Backup created: $MCP_CONFIG.backup"
        
        # Check if pdf-filler already exists and remove old entry
        if grep -q '"pdf-filler"' "$MCP_CONFIG"; then
            echo "🔄 Updating existing pdf-filler configuration..."
        fi
        
        # Use python to safely update JSON
        python3 -c "
import json
import sys

try:
    with open('$MCP_CONFIG', 'r') as f:
        config = json.load(f)
    
    if 'mcpServers' not in config:
        config['mcpServers'] = {}
    
    # Update or add pdf-filler config
    config['mcpServers']['pdf-filler'] = {
        'command': 'node',
        'args': ['$FULL_PATH']
    }
    
    with open('$MCP_CONFIG', 'w') as f:
        json.dump(config, f, indent=2)
    
    print('✅ Successfully updated pdf-filler in MCP config!')
except Exception as e:
    print(f'❌ Error: {e}')
    sys.exit(1)
" 2>/dev/null
        
        if [ $? -eq 0 ]; then
            echo ""
            echo "🎉 SUCCESS! PDF Filler has been installed!"
            echo ""
            echo "📍 Permanent location: $FULL_PATH"
            echo ""
            echo "🔄 Final steps:"
            echo "1. Completely quit Cursor (Cmd+Q)"
            echo "2. Restart Cursor"
            echo "3. Look for 'pdf-filler' with '10 tools enabled'"
            echo ""
            echo "✨ You're all set! Safe to delete Downloads folder now."
        else
            show_manual_method
        fi
    else
        show_manual_method
    fi
else
    echo "📂 Creating new MCP config..."
    mkdir -p "$(dirname "$MCP_CONFIG")"
    
    cat > "$MCP_CONFIG" << EOF
{
  "mcpServers": {
    "pdf-filler": {
      "command": "node",
      "args": ["$FULL_PATH"]
    }
  }
}
EOF
    
    echo "✅ Created MCP config with PDF Filler!"
    echo ""
    echo "📍 Permanent location: $FULL_PATH" 
    echo ""
    echo "🔄 Final steps:"
    echo "1. Completely quit Cursor (Cmd+Q)"
    echo "2. Restart Cursor"  
    echo "3. Look for 'pdf-filler' with '10 tools enabled'"
    echo ""
    echo "✨ Safe to delete Downloads folder now!"
fi

echo ""
echo "🎯 Installation complete! This window will close in 15 seconds..."
echo "   Or press Enter to close now"

read -t 15 -r 