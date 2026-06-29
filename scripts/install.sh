#!/usr/bin/env bash
# ChatLink one-click installer for macOS / Linux
# Usage: bash scripts/install.sh [--client claude|opencode|cursor|all]

set -e
REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
CLIENT="claude"

# ── Parse args ──
while [[ $# -gt 0 ]]; do
  case "$1" in
    --client) CLIENT="$2"; shift 2 ;;
    *) echo "Unknown: $1"; exit 1 ;;
  esac
done

echo ""
echo "  ChatLink Installer  (client: $CLIENT)"
echo "  ======================================"
echo ""

# ── 1. Check Node.js ──
echo "[1/5] Checking Node.js..."
if ! command -v node &>/dev/null; then
  echo "  FAIL  Node.js not found. Install from https://nodejs.org (version 18+)"
  exit 1
fi
NODE_MAJOR=$(node -e "console.log(process.versions.node.split('.')[0])")
if [ "$NODE_MAJOR" -lt 18 ]; then
  echo "  FAIL  Node.js v$NODE_MAJOR too old. Need v18+. Install from https://nodejs.org"
  exit 1
fi
echo "  OK   Node.js v$(node -v)"

# ── 2. Check clients ──
echo "[2/5] Checking AI coding agents..."

has_claude=false; has_opencode=false; has_cursor=false
command -v claude &>/dev/null && has_claude=true
command -v opencode &>/dev/null && has_opencode=true
# Cursor is a GUI app, check common macOS paths
[ -d "/Applications/Cursor.app" ] && has_cursor=true

case "$CLIENT" in
  claude)
    if ! $has_claude; then
      echo "  WARN  Claude Code not found. Install: npm install -g @anthropic-ai/claude-code"
    else
      echo "  OK   Claude Code found"
    fi ;;
  opencode)
    if ! $has_opencode; then
      echo "  WARN  OpenCode CLI not found. Install from https://opencode.ai"
    else
      echo "  OK   OpenCode found"
    fi ;;
  cursor)
    if ! $has_cursor; then
      echo "  INFO  Cursor.app not detected. Make sure it is installed."
    else
      echo "  OK   Cursor.app found"
    fi ;;
  all)
    $has_claude && echo "  OK   Claude Code found" || echo "  WARN  Claude Code not found"
    $has_opencode && echo "  OK   OpenCode found" || echo "  INFO  OpenCode not found (skip)"
    $has_cursor && echo "  OK   Cursor.app found" || echo "  INFO  Cursor.app not found (skip)" ;;
esac

# ── 3. Install dependencies & build ──
echo "[3/5] Installing dependencies & building..."
cd "$REPO_ROOT/mcp-server"
npm install --silent
npm run build --silent
cd "$REPO_ROOT"
echo "  OK   MCP Server built"

# ── 4. Write MCP configs ──
echo "[4/5] Configuring MCP clients..."
SERVER_PATH="$REPO_ROOT/mcp-server/dist/index.js"

# ── Helper: merge chatlink into a JSON/JSONC config file ──
merge_mcp_config() {
  local config_file="$1"
  local client_name="$2"
  local mcp_entry="$3"
  local dir=$(dirname "$config_file")
  mkdir -p "$dir"

  local existing="{}"
  [ -f "$config_file" ] && existing=$(cat "$config_file" 2>/dev/null || echo "{}")

  # Use node to merge JSON (handles comments via simple parse)
  node -e "
    const fs = require('fs');
    const path = '$config_file';
    const entry = $mcp_entry;
    let cfg = {};
    try {
      // Strip JSONC comments
      const raw = fs.readFileSync(path, 'utf8');
      const stripped = raw.replace(/\/\/.*$/gm, '').replace(/\/\*[\s\S]*?\*\//g, '');
      cfg = JSON.parse(stripped);
    } catch(e) {}
    cfg.mcpServers = cfg.mcpServers || {};
    if (!cfg.mcpServers.chatlink) {
      cfg.mcpServers.chatlink = entry;
      console.log('CREATED');
    } else {
      cfg.mcpServers.chatlink = { ...cfg.mcpServers.chatlink, ...entry };
      console.log('UPDATED');
    }
    fs.writeFileSync(path, JSON.stringify(cfg, null, 2) + '\n');
  " 2>/dev/null
}

# Resolve the persisted HTTP token (generates on first run)
HTTP_TOKEN=$(node "$SERVER_PATH" --token 2>/dev/null || echo "")
if [ -z "$HTTP_TOKEN" ]; then
  echo "  FAIL  Could not resolve HTTP token. Build may have failed."
  exit 1
fi

configure_claude() {
  if ! $has_claude; then return; fi
  # Remove old stdio config if present
  claude mcp remove chatlink 2>/dev/null || true
  # Register with HTTP transport using persisted token
  if claude mcp list 2>/dev/null | grep -q "chatlink"; then
    echo "  INFO  Claude Code: already registered (HTTP)"
  else
    claude mcp add --transport http chatlink http://127.0.0.1:27183/mcp \
      --header "Authorization: Bearer $HTTP_TOKEN" 2>/dev/null && \
      echo "  OK    Claude Code: HTTP → 127.0.0.1:27183/mcp" || {
      echo "  WARN  Claude Code HTTP registration failed. Run manually:"
      echo "        claude mcp add --transport http chatlink http://127.0.0.1:27183/mcp --header \"Authorization: Bearer \$TOKEN\""
    }
  fi
}

configure_opencode() {
  if ! $has_opencode && [ "$CLIENT" != "all" ]; then return; fi
  local cfg="$HOME/.config/opencode/opencode.json"
  local entry='{"type":"remote","url":"http://127.0.0.1:27183/mcp","headers":{"Authorization":"Bearer '"$HTTP_TOKEN"'"}}'
  merge_mcp_config "$cfg" "opencode" "$entry"
  echo "  OK    OpenCode: remote → 127.0.0.1:27183/mcp"
}

configure_cursor() {
  if ! $has_cursor && [ "$CLIENT" != "all" ]; then return; fi
  local cfg="$HOME/.cursor/mcp.json"
  local entry='{"command":"node","args":["'"$SERVER_PATH"'","--http"]}'
  merge_mcp_config "$cfg" "cursor" "$entry"
  echo "  OK    Cursor: stdio → HTTP daemon"
}

case "$CLIENT" in
  claude)   configure_claude ;;
  opencode) configure_opencode ;;
  cursor)   configure_cursor ;;
  all)
    configure_claude
    configure_opencode
    configure_cursor ;;
esac

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
  [ -d "/Applications/Google Chrome.app" ] && open -a "Google Chrome" "chrome://extensions" 2>/dev/null || true
  [ -d "/Applications/Microsoft Edge.app" ] && open -a "Microsoft Edge" "edge://extensions" 2>/dev/null || true
elif [ "$OS" = "linux" ]; then
  command -v google-chrome &>/dev/null && google-chrome "chrome://extensions" 2>/dev/null || \
    echo "  Open chrome://extensions or edge://extensions in your browser"
fi

echo ""
echo "  Done!"
echo "  1. Enable Developer Mode in the extensions page"
echo "  2. Click 'Load unpacked' and select:"
echo "     $REPO_ROOT/chrome-extension"
echo "  3. Open any AI chat tab (ChatGPT/Gemini/etc.)"
case "$CLIENT" in
  claude) echo "  4. Restart Claude Code" ;;
  opencode) echo "  4. Restart OpenCode" ;;
  cursor) echo "  4. Restart Cursor" ;;
  all) echo "  4. Restart your coding agent" ;;
esac
echo ""
