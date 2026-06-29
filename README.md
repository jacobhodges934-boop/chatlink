# ChatLink

**Your browser already has the models. ChatLink gives Claude Code the wire.**

Turn ChatGPT, Claude, Gemini, DeepSeek, Grok, Mistral, and Perplexity tabs into tools that Claude Code can read, write to, and delegate work through.

One local bridge. Seven AI platforms. No separate model API key required.

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
│ ChatGPT · Claude · Gemini · DeepSeek · Grok · Mistral · PPLX│
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

- Node.js 18 or newer
- Google Chrome 116 or newer
- Claude Code or another MCP-compatible client
- At least one supported AI website open and signed in

### 1. Clone and build

```bash
git clone https://github.com/jacobhodges934-boop/chatlink.git
cd chatlink/mcp-server
npm install
npm run build
```

### 2. Load the Chrome extension

1. Open `chrome://extensions`.
2. Enable **Developer mode**.
3. Click **Load unpacked**.
4. Select the repository's `chrome-extension/` directory.
5. Open a supported AI website.
6. Confirm that the ChatLink extension badge displays **ON**.

> When extension code changes, reload ChatLink from `chrome://extensions` and refresh any open AI tabs.

### 3. Register ChatLink with Claude Code

Use the absolute path to the compiled server.

**macOS or Linux**

```bash
claude mcp add chatlink -- node /absolute/path/to/chatlink/mcp-server/dist/index.js
```

**Windows PowerShell**

```bash
claude mcp add chatlink -- node "C:\absolute\path\to\chatlink\mcp-server\dist\index.js"
```

Restart Claude Code after registering the server.

### 4. Verify the connection

Open ChatGPT, Claude, Gemini, or another supported platform, then ask Claude Code:

> Use ChatLink to check the extension status and list my open AI tabs.

You can also ask it directly:

> Send this task to ChatGPT through ChatLink and return only the new response: Review the current repository architecture and identify the three highest-risk modules.

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
| `platform` | `chatgpt`, `claude`, `gemini`, `deepseek`, `grok`, `mistral`, or `perplexity` |
| `task` | The task to send |
| `tabId` | Optional exact browser tab |
| `context` | Optional source files, logs, diffs, or other context |
| `timeout` | Completion timeout from 5 to 900 seconds; default is 180 |

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
