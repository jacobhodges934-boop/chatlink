#!/usr/bin/env bash
# ChatLink remote bootstrap — one-liner installer
# Usage: curl -fsSL https://raw.githubusercontent.com/jacobhodges934-boop/chatlink/master/scripts/bootstrap.sh | bash -s -- --client opencode
set -e

CLIENT="${1:-claude}"
case "$CLIENT" in --client) CLIENT="$2"; esac
REPO="https://github.com/jacobhodges934-boop/chatlink.git"
DIR="$HOME/chatlink"

echo ""
echo "  ChatLink Bootstrap  →  $CLIENT"
echo "  ================================"
echo ""

# Clone or update
if [ -d "$DIR/.git" ]; then
    echo "Updating existing repo..."
    cd "$DIR" && git pull --ff-only
else
    echo "Cloning ChatLink..."
    git clone "$REPO" "$DIR"
fi

# Build
echo "Building MCP Server..."
cd "$DIR/mcp-server"
npm install --silent
npm run build --silent

# Install
echo "Configuring for $CLIENT..."
bash "$DIR/scripts/install.sh" --client "$CLIENT"

echo ""
echo "  All done. Load the extension and restart $CLIENT."
echo "  Then run: 使用 ChatLink 检查扩展状态"
echo ""
