# TODO

## Architecture
- [x] **Multi-client HTTP mode** — `--http` flag starts a Streamable HTTP MCP server on port 27183, allowing OpenCode, Copilot, Cursor, and other tools to connect simultaneously. Claude Code continues to use stdio (default, no flag needed). Tested and working.
- [ ] **Daemon mode for multi-IDE support** — The HTTP mode covers most cases. A true shared daemon (where multiple stdio clients share one bridge process) could still be useful but is lower priority now that HTTP mode exists.

## Publishing
- [ ] **npm publish** — run `npm publish` from `mcp-server/` once ready
- [ ] **Chrome Web Store submission** — requires a hosted privacy policy URL (can be a GitHub Pages page or a `PRIVACY.md` linked from the repo)

## Extraction quality
- [ ] **Fix Claude.ai extractor selectors** — `get_chat_context` on claude.ai falls back to full page text dump instead of properly split user/assistant turns. The `[data-testid="human-turn"]` / `[data-testid="ai-turn"]` selectors in `extractor.js` need to be verified against the current claude.ai DOM.
- [ ] **Add Perplexity extractor** — `list_ai_tabs` detects Perplexity tabs but `get_chat_context` has no structured extractor for it yet; falls back to raw text.

## Tools
- [x] **`list_ai_tabs`** — lists open AI chat tabs (ChatGPT, Claude, Gemini, Grok, DeepSeek, Mistral, Perplexity)
- [x] **`get_chat_context`** — pulls full conversation transcript from an AI chat tab; supports `maxMessages` and `summaryOnly`
- [x] **`get_page_content`** — reads readable text from any browser tab (docs, GitHub issues, articles, etc.)
- [x] **`list_tabs`** — lists all open browser tabs with their tab IDs
- [x] **`get_claude_artifacts`** — extracts Claude artifacts (JSX, HTML, Markdown, SVG, research) from claude.ai tabs; supports `filterType`, `includeLinks`, `maxLinks`
- [x] **`extension_status`** — checks if the Chrome extension is connected
- [ ] **`send_message`** — type a message into an AI chat tab and submit it (agentic use-case: let Claude Code drive another AI)
- [ ] **`screenshot_tab`** — capture a screenshot of any open tab and return it as base64 / MCP image content

## Security
- [ ] **Rotate token on demand** — currently the auth token is regenerated only on server restart. Add a `chatmcp-server --rotate-token` flag or MCP tool for users who want to invalidate existing connections without restarting.

## Bug fixes
- [x] **Bridge crash on EADDRINUSE** — `WebSocketServer` was re-emitting the port-in-use error as an unhandled event, crashing the process instead of retrying. Fixed by adding a no-op `wss.on("error", ...)` handler so the retry logic in `httpServer.on("error", ...)` runs cleanly.
