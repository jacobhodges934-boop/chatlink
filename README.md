# ChatLink

**Your browser already has the models. ChatLink gives Claude Code the wire.**

Turn ChatGPT, Claude, Gemini, NotebookLM, DeepSeek, Grok, Mistral, and Perplexity tabs into tools that Claude Code can read, write to, and delegate work through.

One local bridge. Browser AI platforms. No separate model API key required.

ChatLink uses the AI sessions already open in your browser. Your existing web subscription and usage limits still apply, but ChatLink does not add separate per-token model API billing.

## Why ChatLink?

Claude Code is excellent at working inside your repository. Browser AI products are excellent at research, second opinions, long-form reasoning, and model-specific capabilities.

ChatLink connects them.

Ask Claude Code to:

- send a coding task to ChatGPT and wait for the complete answer
- pull context from an existing Claude or Gemini conversation
- compare responses across multiple AI platforms
- read documentation, issues, and articles from open browser tabs
- extract Claude artifacts and research sources
- coordinate several browser AI tabs without manually copying and pasting

```
You
 └─ Claude Code
     └─ ChatLink MCP
         ├─ ChatGPT
         ├─ Claude
         ├─ Gemini
         ├─ NotebookLM
         ├─ DeepSeek
         ├─ Grok
         ├─ Mistral
         └─ Perplexity
```

### Supported platforms

| Platform | Read conversations | Send messages | Delegate tasks |
|---|---|---|---|
| ChatGPT | ✓ | ✓ | ✓ |
| Claude | ✓ | ✓ | ✓ |
| Gemini | ✓ | ✓ | ✓ |
| NotebookLM | ✓ | ✓ | ✓ |
| DeepSeek | ✓ | ✓ | ✓ |
| Grok | ✓ | ✓ | ✓ |
| Mistral | ✓ | ✓ | ✓ |
| Perplexity | ✓ | ✓ | ✓ |

Claude also supports artifact and research-panel extraction.

## How it works

```
┌─────────────────────────────────────────────────────────────┐
│ Claude Code or another MCP client                           │
└───────────────────────────┬─────────────────────────────────┘
                            │
                 stdio or Streamable HTTP
                 HTTP: 127.0.0.1:27183
                 Bearer authentication
                            │
┌───────────────────────────▼─────────────────────────────────┐
│ ChatLink MCP Server                                         │
│                                                             │
│ index.ts     MCP tools, task orchestration, tab scheduling  │
│ bridge.ts    Local WebSocket bridge and authentication      │
│ protocol.ts  End-to-end Zod protocol validation             │
└───────────────────────────┬─────────────────────────────────┘
                            │
                 Authenticated WebSocket
                 ws://127.0.0.1:27182
                 Random 64-character session token
                            │
┌───────────────────────────▼─────────────────────────────────┐
│ Chrome Manifest V3 extension                                │
│                                                             │
│ background.js   Service Worker, routing, deduplication      │
│ extractor.js    DOM extraction and platform adapters        │
└───────────────────────────┬─────────────────────────────────┘
                            │
                  chrome.runtime messaging
                            │
┌───────────────────────────▼─────────────────────────────────┐
│ Browser AI tabs                                             │
│ ChatGPT · Claude · Gemini · NotebookLM · DeepSeek · Grok    │
│ Mistral · PPLX                                              │
└─────────────────────────────────────────────────────────────┘
```

Everything runs locally between the MCP process and your Chrome extension. ChatLink does not proxy conversations through a hosted ChatLink server.

## Reliability by design

Browser interfaces change constantly. ChatLink is built around that reality rather than pretending the DOM is stable.

### Tiered extraction

Every platform has a dedicated adapter with three extraction levels:

- **Tier 1 — stable selectors**: Uses semantic attributes such as `data-testid`, message roles, and platform-specific elements.
- **Tier 2 — structural heuristics**: Falls back to message containers, DOM order, layout, and role inference.
- **Tier 3 — page fallback**: Returns low-confidence page text when structured extraction is unavailable.

Every extraction includes `extractionMeta` with a `high`, `medium`, or `low` confidence level, so downstream agents can distinguish reliable transcripts from fallback data.

### Dual completion detection

`delegate_coding_task` does not rely on a single fragile selector. It combines:

- explicit DOM generation signals, including stop and busy controls
- assistant-message detection
- content-stability verification
- a final reread before declaring completion
- configurable timeouts with partial-response reporting

### Incremental polling

After the initial conversation snapshot, polling requests only newly added messages instead of repeatedly extracting the full transcript. This reduces DOM work by roughly 90% during typical delegated tasks and keeps long conversations responsive.

### Task and tab safety

- Per-tab mutexes prevent overlapping delegated tasks.
- Smart tab selection skips tabs already in use.
- Send operations use stable operation IDs.
- Deduplication state is stored in `chrome.storage.session`, surviving Service Worker restarts within the browser session.
- Tab close and navigation events immediately invalidate affected operations.
- AI webpage output is explicitly marked as `untrusted`.

## Quick start

### Requirements

- Node.js 18+
- Chrome 116+ or Edge 116+
- An AI coding agent: [Claude Code](https://claude.ai/code) / [OpenCode](https://opencode.ai) / [Cursor](https://cursor.com)
- At least one AI chat tab open and signed in (ChatGPT, Gemini, DeepSeek, Grok, etc.)

### One-line install

```bash
curl -fsSL https://raw.githubusercontent.com/jacobhodges934-boop/chatlink/master/scripts/bootstrap.sh | bash -s -- --client claude
```

Replace `claude` with `opencode` or `cursor`. That's it — the script clones, builds, and configures everything.

### Or from a local clone

**Windows (PowerShell):**
```powershell
.\scripts\install.ps1 -Client claude    # or: opencode, cursor
```

**macOS / Linux:**
```bash
bash scripts/install.sh --client claude  # or: opencode, cursor
```

The script installs dependencies, builds the MCP server, writes the MCP config for your chosen agent, and opens the extension page.

Detailed setup → [INSTALL.md](INSTALL.md)

### Verify

After loading the extension and restarting your coding agent:

> 使用 ChatLink 检查扩展状态

## MCP tools

| Tool | What it does |
|---|---|
| `delegate_coding_task` | Finds an available platform tab, sends a task, waits for completion, and returns only the new assistant response |
| `send_chat_message` | Sends text to a specific or automatically selected AI tab |
| `get_chat_context` | Reads recent messages from an AI conversation |
| `list_ai_tabs` | Lists supported AI chat tabs with their tab IDs |
| `list_tabs` | Lists all readable browser tabs |
| `get_page_content` | Extracts readable content from a browser tab |
| `get_claude_artifacts` | Extracts Claude artifacts, code, documents, research steps, and optional source links |
| `dom_dump` | Dumps visible inputs, send buttons, new-chat buttons, message containers, body candidates, and busy/stop/complete signals for adapter debugging |
| `extension_status` | Checks whether the Chrome extension is connected |

### `delegate_coding_task`

This is the main high-level tool.

```
find tab
   ↓
check tab availability
   ↓
capture conversation baseline
   ↓
scan task and context for secrets
   ↓
send with persistent operation ID
   ↓
observe DOM and incremental messages
   ↓
verify completion
   ↓
return only the new assistant response
```

**Supported arguments:**

| Argument | Description |
|---|---|
| `platform` | `chatgpt`, `claude`, `gemini`, `notebooklm`, `deepseek`, `grok`, `mistral`, or `perplexity` |
| `task` | The task to send |
| `tabId` | Optional exact browser tab |
| `context` | Optional source files, logs, diffs, or other context |
| `timeout` | Completion timeout from 5 to 900 seconds; default is 180 |
| `startNewChat` | Optional boolean. Default `false` sends in the current old conversation or already-open new-chat start page. Set `true` to click the platform's new-chat control before sending. |

### New chat pages

Each supported AI has two valid starting points:

- an already opened old conversation, where ChatLink appends the message to that thread
- a new-chat start page, where the first sent message turns the blank composer into a normal conversation

Use `startNewChat: false` when you have already opened the target old conversation or new-chat start page yourself. Use `startNewChat: true` when you want ChatLink to click the platform's New chat / Start new conversation control first and then send the message.

### `send_chat_message`

`send_chat_message` accepts the same `startNewChat` option:

```json
{
  "text": "Say hello in Chinese, nothing else",
  "startNewChat": true
}
```

### `dom_dump`

Use `dom_dump` when a platform UI changes or a new adapter needs selectors. It reports bounded previews for visible input boxes, send buttons, new-chat controls, stop/busy/complete signals, message containers, and likely response-body elements. Text previews are intentionally truncated.

## HTTP MCP mode

ChatLink uses stdio by default. It can also expose a local Streamable HTTP MCP endpoint for clients such as editors and coding agents that support HTTP transport.

```bash
cd mcp-server
node dist/index.js --http
```

The server listens on `http://127.0.0.1:27183/mcp`. A random Bearer token is printed at startup.

HTTP mode includes: loopback-only binding, Bearer authentication, timing-safe token comparison, a 1 MB request-body limit, and stateless MCP request handling.

**Do not expose the HTTP port to a public network.**

## Security model

Current protections include:

- loopback-only WebSocket and HTTP servers
- random per-process bridge tokens
- Bearer authentication for HTTP mode
- timing-safe credential comparison
- Zod validation for protocol messages and responses
- WebSocket frame and message-size limits
- secret scanning for delegated task text and context
- `.gitignore`-aware context filtering
- persistent send deduplication
- tab lifecycle invalidation
- explicit `trust: "untrusted"` marking for external AI output

**Important trust boundary**: AI responses are external webpage content. ChatLink marks them as untrusted, but the calling agent must still decide which actions are safe to execute. Never paste credentials into browser AI chats.

## Project structure

```
chatlink/
├── chrome-extension/
│   ├── manifest.json
│   ├── background.js
│   ├── content-scripts/
│   │   └── extractor.js
│   ├── popup/
│   └── diagnostics.html
│
└── mcp-server/
    ├── src/
    │   ├── index.ts
    │   ├── bridge.ts
    │   ├── protocol.ts
    │   ├── completion-tracker.ts
    │   ├── config.ts
    │   └── types.ts
    ├── package.json
    └── tsconfig.json
```

Five files form the core data path: `extractor.js → background.js → bridge.ts → protocol.ts → index.ts`

## Development

```bash
cd mcp-server
npm run build       # Compile TypeScript
npm test            # Run tests + extension syntax checks
npm run dev         # Development mode
npm run lint:extractor  # Syntax-check extension scripts only
```

## Troubleshooting

| Problem | What to check |
|---|---|
| Extension badge shows `OFF` | MCP Server running? Use popup's reconnect |
| No AI tabs listed | Open a supported website, wait for page load |
| Input box not found | Refresh the AI tab; DOM may have changed |
| Task times out | Check login, network, rate limits, CAPTCHA |
| Extraction confidence low | Refresh page; platform UI may have changed |
| Content script not updated | Reload extension + refresh all AI tabs |
| Port `27182` occupied | Stop stale ChatLink process, restart MCP |
| HTTP returns `401` | Configure Bearer token from startup output |

## Limitations

- Interacts with browser interfaces, not official model APIs
- AI websites can change their DOM without notice
- Must be signed in to the target platform
- Web subscription limits, rate limits, and regional availability still apply
- Browser tabs must remain open during delegated tasks

## License

MIT

---

**Your browser tabs are no longer isolated windows. They are tools.**

If ChatLink saves you from one more copy-paste loop, consider giving the repository a star. ⭐
