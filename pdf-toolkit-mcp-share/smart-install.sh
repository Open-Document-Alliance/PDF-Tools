#!/bin/bash

function show_manual_instructions() {
    echo ""
    echo "📋 MANUAL METHOD - Copy this exact text to ~/.cursor/mcp.json:"
    echo ""
    echo "==============================================="
    echo '{'
    echo '  "mcpServers": {'
    echo '    "pdf-filler": {'
    echo '      "command": "node",'
    echo "      \"args\": [\"$FULL_PATH\"]"
    echo '    }'
    echo '  }'
    echo '}'
    echo "==============================================="
    echo ""
    echo "💡 To open the file: open ~/.cursor/mcp.json"
}

echo "🚀 Installing PDF Filler MCP Server..."

# Navigate to the script's directory
cd "$(dirname "$0")"

# Check if we're in Downloads folder
CURRENT_DIR="$(pwd)"
if [[ "$CURRENT_DIR" == *"/Downloads/"* ]]; then
    echo "⚠️  Installing from Downloads folder"
    echo "📂 Moving to permanent location for safety..."
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

npm install
echo "✅ Dependencies installed!"
echo ""

# Get the absolute path automatically
FULL_PATH="$(pwd)/server/index.js"
MCP_CONFIG="$HOME/.cursor/mcp.json"

echo "✨ Server installed at: $FULL_PATH"
echo ""

# Check if mcp.json exists
if [ -f "$MCP_CONFIG" ]; then
    echo "📂 Found existing MCP config at: $MCP_CONFIG"
    echo ""
    echo "🤖 Would you like me to automatically add pdf-filler to your config? (y/n)"
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
"
        if [ $? -eq 0 ]; then
            echo ""
            echo "🎉 DONE! pdf-filler has been added to your MCP config!"
            echo ""
            echo "📍 Permanent location: $FULL_PATH"
            echo ""
            echo "🔄 Next steps:"
            echo "1. Completely quit Cursor"
            echo "2. Restart Cursor"
            echo "3. Look for 'pdf-filler' showing '10 tools enabled'"
            echo ""
            echo "🎯 You're all set! Safe to delete Downloads folder now."
        else
            echo "⚠️  Auto-update failed. Please use manual method below."
            show_manual_instructions
        fi
    else
        show_manual_instructions
    fi
else
    echo "📂 No existing MCP config found. Creating new one..."
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
    
    echo "✅ Created new MCP config with pdf-filler!"
    echo ""
    echo "📍 Permanent location: $FULL_PATH"
    echo ""
    echo "🔄 Next steps:"
    echo "1. Completely quit Cursor"
    echo "2. Restart Cursor"
    echo "3. Look for 'pdf-filler' showing '10 tools enabled'"
    echo ""
    echo "✨ Safe to delete Downloads folder now!"
fi 