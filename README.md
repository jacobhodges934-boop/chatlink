# ChatMCP

Pull context from your AI browser tabs directly into Claude Code (and other AI coding tools) via MCP.

[![Buy Me a Coffee](https://img.shields.io/badge/Buy%20Me%20a%20Coffee-support-yellow?logo=buy-me-a-coffee)](https://buymeacoffee.com/indiantinker)

## How it works

```
Claude Code / Copilot CLI / Codex CLI   ← stdio (spawns server as subprocess)
                    OR
Cursor / Antigravity / Copilot (VS Code) ← HTTP  http://127.0.0.1:27183/mcp
                    ↕
             Node MCP Server  ←── WebSocket on localhost:27182
                    ↕
    Chrome Extension (background service worker)
                    ↕
    AI Chat Tabs (ChatGPT, Claude, Gemini, Grok, DeepSeek, Mistral, Perplexity)
```

---

## Quick start (no technical experience needed)

You need two things: a Chrome extension and a small server program. Here's exactly what to do.

### Step 1 — Install Node.js (if you don't have it)

1. Go to [nodejs.org](https://nodejs.org) and download the **LTS** version
2. Run the installer — click Next through everything, keep all defaults
3. When it's done, open **Terminal** (Mac) or **Command Prompt** (Windows) and type:
   ```
   node --version
   ```
   You should see something like `v20.x.x`. If so, you're good.

### Step 2 — Install Claude Code (if you don't have it)

In Terminal / Command Prompt:
```bash
npm install -g @anthropic-ai/claude-code
```

Then run `claude` and follow the login prompt.

### Step 3 — Add the MCP server to Claude Code

Copy and paste this one line into your terminal:

```bash
claude mcp add chatmcp -- npx -y chatmcp-server
```

That's it. Claude Code will automatically start the server whenever you use it.

### Step 4 — Install the Chrome extension

1. Download or clone this repository — click the green **Code** button on GitHub, then **Download ZIP**, and unzip it somewhere on your computer
2. Open Chrome and go to `chrome://extensions` in the address bar
3. In the top-right corner, turn on **Developer mode**
4. Click **Load unpacked**
5. Select the `chrome-extension` folder from what you just unzipped
6. You should see the ChatMCP extension appear with an **OFF** badge

### Step 5 — Connect

1. Start Claude Code by typing `claude` in your terminal
2. The extension badge should turn **ON** (green) within a few seconds
3. Open any AI chat tab (ChatGPT, Gemini, etc.) in Chrome
4. In Claude Code, ask: *"pull context from my browser tabs"*

---

## Setup (for developers)

> **Two modes:** Tools that can spawn subprocesses use **stdio** (simpler — no background process needed). Tools that connect to a running server use **HTTP mode** — start the server once and leave it running.

---

### Claude Code

```bash
claude mcp add chatmcp -- npx -y chatmcp-server
```

---

### VS Code + GitHub Copilot

Copilot in VS Code (1.99+) spawns the server for you — no background process needed.

**Workspace** — create `.vscode/mcp.json` in your project:

```json
{
  "servers": {
    "chatmcp": {
      "command": "npx",
      "args": ["-y", "chatmcp-server"]
    }
  }
}
```

**Global (all projects)** — open VS Code, run `MCP: Open User Configuration` from the Command Palette, and add:

```json
{
  "servers": {
    "chatmcp": {
      "command": "npx",
      "args": ["-y", "chatmcp-server"]
    }
  }
}
```

Then open Copilot Chat, switch to **Agent** mode, and the `chatmcp` tools appear automatically. (MCP tools are invisible in Ask / Edit mode.)

---

### GitHub Copilot CLI

Config lives at `~/.copilot/mcp-config.json` (created automatically on first use). Add:

```json
{
  "mcpServers": {
    "chatmcp": {
      "type": "local",
      "command": "npx",
      "args": ["-y", "chatmcp-server"]
    }
  }
}
```

Or use the interactive command inside the CLI:

```
/mcp add
```

---

### OpenAI Codex CLI

Config lives at `~/.codex/config.toml`. Add a section:

```toml
[mcp_servers.chatmcp]
command = "npx"
args    = ["-y", "chatmcp-server"]
```

Or scope it to a project by placing the same block in `.codex/config.toml` inside your repo.

You can also use the CLI helper:

```bash
codex mcp add
```

---

### Cursor

**Project-level** — create `.cursor/mcp.json` in your project root:

```json
{
  "mcpServers": {
    "chatmcp": {
      "type": "stdio",
      "command": "npx",
      "args": ["-y", "chatmcp-server"]
    }
  }
}
```

**Global** — add the same block to `~/.cursor/mcp.json`.

Verify in **Cursor Settings → Tools & MCP** — you should see `chatmcp` with a green status indicator.

---

### Google Antigravity

Open an Agent session, click **⋯ → MCP Servers → Manage MCP Servers → View raw config**, and add to `mcp_config.json`:

```json
{
  "mcpServers": {
    "chatmcp": {
      "command": "npx",
      "args": ["-y", "chatmcp-server"]
    }
  }
}
```

Save the file — Antigravity picks up the new server immediately.

---

### Any other tool (HTTP mode)

If your tool connects to MCP servers over HTTP/SSE rather than spawning subprocesses (OpenCode, Windsurf, custom agents, etc.), start the server in HTTP mode first:

```bash
npx -y chatmcp-server --http
```

The server runs persistently on `http://127.0.0.1:27183/mcp` and accepts multiple simultaneous clients. Point your tool at that URL. Keep the terminal open (or add it to your system startup / `launchd` / `systemd`).

---

### Build from source

```bash
git clone https://github.com/indiantinker/chatMCP.git
cd chatMCP/mcp-server
npm install && npm run build

# stdio (Claude Code, Copilot, Codex, Cursor, Antigravity)
node /path/to/chatMCP/mcp-server/dist/index.js

# HTTP (OpenCode, Windsurf, or any HTTP MCP client)
node /path/to/chatMCP/mcp-server/dist/index.js --http
```

For Claude Code with a local build:

```bash
claude mcp add chatmcp -- node /path/to/chatMCP/mcp-server/dist/index.js
```

---

## Usage in Claude Code

```
# See what AI chats are open
list_ai_tabs

# Pull the full conversation (auto-selects active AI tab)
get_chat_context

# Pull from a specific tab
get_chat_context tabId=12345

# Get a summary instead of the full transcript
get_chat_context summaryOnly=true

# Read any tab (docs, GitHub issues, articles)
get_page_content

# Check extension status
extension_status
```

Or just ask naturally:
> "Pull context from my ChatGPT tab and continue building on that idea."

---

## Supported platforms

| Platform    | URL                           |
|-------------|-------------------------------|
| ChatGPT     | chat.openai.com / chatgpt.com |
| Claude      | claude.ai                     |
| Gemini      | gemini.google.com             |
| Grok        | grok.com                      |
| DeepSeek    | chat.deepseek.com             |
| Mistral     | chat.mistral.ai               |
| Perplexity  | perplexity.ai                 |

---

## Privacy

All data stays on your machine. The MCP server and Chrome extension communicate over `localhost` only — nothing is sent to any external server. Chat content is passed directly to your local Claude Code session.

---

## Notes

- The MCP server starts automatically when Claude Code launches if registered (stdio mode).
- In HTTP mode, start the server manually and keep it running.
- The extension auto-reconnects every 3 seconds if the server restarts.
- Chat extraction uses DOM scraping — may need updates when AI platforms change their markup.

---

## License

MIT — see [LICENSE](LICENSE).

---

If this saves you time, [buy me a coffee](https://buymeacoffee.com/indiantinker). ☕
