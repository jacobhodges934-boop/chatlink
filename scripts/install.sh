#!/usr/bin/env bash
# ChatLink one-click installer for macOS / Linux
# Usage: bash scripts/install.sh

set -e
REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

echo ""
echo "  ChatLink Installer"
echo "  ==================="
echo ""

# ── 1. Check Node.js ──
echo "[1/5] Checking Node.js..."
if command -v node &>/dev/null; then
    echo "  OK  Node.js $(node -v)"
else
    echo "  FAIL Node.js not found. Install from https://nodejs.org (version 18+)"
    exit 1
fi

# ── 2. Check Claude Code ──
echo "[2/5] Checking Claude Code..."
if command -v claude &>/dev/null; then
    echo "  OK  Claude Code found at $(which claude)"
else
    echo "  WARN Claude Code CLI not found in PATH"
fi

# ── 3. Install dependencies & build ──
echo "[3/5] Installing dependencies & building..."
cd "$REPO_ROOT/mcp-server"
npm install --silent
npm run build --silent
cd "$REPO_ROOT"
echo "  OK  MCP Server built"

# ── 4. Register Claude Code MCP ──
echo "[4/5] Registering with Claude Code..."
SERVER_PATH="$REPO_ROOT/mcp-server/dist/index.js"
if claude mcp list 2>/dev/null | grep -q "chatlink"; then
    echo "  INFO ChatLink already registered. Skipping."
else
    claude mcp add chatlink -- node "$SERVER_PATH" 2>/dev/null || true
    echo "  OK  Registered: claude mcp add chatlink"
fi

# ── 5. Open extension pages ──
echo "[5/5] Opening extension settings..."

detect_os() {
    case "$(uname -s)" in
        Darwin*) echo "macos" ;;
        Linux*)  echo "linux" ;;
        *)       echo "unknown" ;;
    esac
}
OS=$(detect_os)

if [ "$OS" = "macos" ]; then
    echo "  Opening Chrome extensions page..."
    open -a "Google Chrome" "chrome://extensions" 2>/dev/null || true
    echo "  Opening Edge extensions page..."
    open -a "Microsoft Edge" "edge://extensions" 2>/dev/null || true
elif [ "$OS" = "linux" ]; then
    echo "  Open chrome://extensions or edge://extensions in your browser"
    if command -v google-chrome &>/dev/null; then
        google-chrome "chrome://extensions" 2>/dev/null || true
    fi
fi

echo ""
echo "  Done!"
echo "  1. Enable Developer Mode in the extensions page"
echo "  2. Click 'Load unpacked' and select:"
echo "     $REPO_ROOT/chrome-extension"
echo "  3. Open any AI chat tab (ChatGPT/Gemini/etc.)"
echo "  4. Restart Claude Code and run: 使用 ChatLink 检查扩展状态"
echo ""
