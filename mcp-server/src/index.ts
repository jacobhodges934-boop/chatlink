#!/usr/bin/env node
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { createServer as createHttpServer, type IncomingMessage, type ServerResponse } from "http";
import { z } from "zod";
import { ExtensionBridge } from "./bridge.js";
import { readFile, writeFile, unlink } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";

const HTTP_PORT = 27183;
const COFFEE_URL = "https://buymeacoffee.com/indiantinker";

const bridge = new ExtensionBridge();

// ── Tool registration factory ──────────────────────────────────────────────
// Creates a fully-configured McpServer instance. Called once for stdio mode,
// or once per stateless HTTP session.

function registerTools(server: McpServer) {
  // ── list_ai_tabs ──────────────────────────────────────────────────────────
  server.tool(
    "list_ai_tabs",
    "List all open browser tabs that contain AI chat applications (ChatGPT, Claude, Gemini, Grok, DeepSeek, Mistral, Perplexity). Use this to see what AI chats are currently open before pulling context.",
    {},
    async () => {
      if (!bridge.isConnected()) {
        return {
          content: [
            {
              type: "text",
              text: "The ChatMCP Chrome extension is not connected. Please install the extension and make sure it is enabled.",
            },
          ],
          isError: true,
        };
      }

      try {
        const tabs = await bridge.listAiTabs();

        if (tabs.length === 0) {
          return {
            content: [
              {
                type: "text",
                text: "No AI chat tabs are currently open. Open ChatGPT, Claude, Gemini, Grok, DeepSeek, or Mistral in your browser and try again.",
              },
            ],
          };
        }

        const lines = tabs.map(
          (t, i) =>
            `${i + 1}. [${t.platform}] ${t.title}\n   Tab ID: ${t.tabId} | ${t.url}${t.active ? " (active)" : ""}`
        );

        return {
          content: [
            {
              type: "text",
              text: `Found ${tabs.length} AI chat tab(s):\n\n${lines.join("\n\n")}`,
            },
          ],
        };
      } catch (err) {
        return {
          content: [{ type: "text", text: `Error: ${(err as Error).message}` }],
          isError: true,
        };
      }
    }
  );

  // ── get_chat_context ────────────────────────────────────────────────────
  server.tool(
    "get_chat_context",
    "Pull the full conversation from an AI chat tab (ChatGPT, Claude, Gemini, Grok, DeepSeek, Mistral). If no tabId is provided it auto-selects the most recently active AI chat tab. Returns a structured transcript of the conversation you can use as context.",
    {
      tabId: z
        .number()
        .optional()
        .describe(
          "Specific browser tab ID to pull from (get this from list_ai_tabs). Omit to auto-select."
        ),
      maxMessages: z
        .number()
        .optional()
        .default(50)
        .describe("Maximum number of messages to return (most recent). Default: 50."),
      summaryOnly: z
        .boolean()
        .optional()
        .default(false)
        .describe(
          "If true, return a brief summary instead of the full transcript. Useful for large chats."
        ),
    },
    async ({ tabId, maxMessages, summaryOnly }) => {
      if (!bridge.isConnected()) {
        return {
          content: [
            {
              type: "text",
              text: "The ChatMCP Chrome extension is not connected. Please install the extension and make sure it is enabled.",
            },
          ],
          isError: true,
        };
      }

      try {
        const chat = await bridge.getChat(tabId);
        const messages = chat.messages.slice(-(maxMessages ?? 50));

        if (messages.length === 0) {
          return {
            content: [
              {
                type: "text",
                text: `No messages found in the ${chat.platform} chat. Make sure the chat is visible on screen and try again.`,
              },
            ],
          };
        }

        const header = `## Context from ${chat.platform}\n**Source:** ${chat.url}\n**Captured:** ${chat.extractedAt}\n**Messages:** ${messages.length}\n\n---\n\n`;

        if (summaryOnly) {
          const userMessages = messages.filter((m) => m.role === "user").map((m) => m.content);
          const summary = `Topics discussed:\n${userMessages.map((m) => `- ${m.slice(0, 120)}${m.length > 120 ? "…" : ""}`).join("\n")}`;
          return {
            content: [{ type: "text", text: header + summary }],
          };
        }

        const transcript = messages
          .map((m) => `**${m.role === "user" ? "You" : chat.platform}:** ${m.content}`)
          .join("\n\n");

        return {
          content: [{ type: "text", text: header + transcript }],
        };
      } catch (err) {
        const msg = (err as Error).message;
        return {
          content: [{ type: "text", text: `Error: ${msg}` }],
          isError: true,
        };
      }
    }
  );

  // ── get_page_content ────────────────────────────────────────────────────
  server.tool(
    "get_page_content",
    "Fetch the full readable text content from any browser tab — not just AI chats. Works on documentation pages, GitHub issues, articles, Stack Overflow, any URL. If no tabId is provided it reads the currently active tab. Strips nav/footer/sidebar noise and returns the main content.",
    {
      tabId: z
        .number()
        .optional()
        .describe(
          "Specific tab ID to read (get from list_ai_tabs or ask user). Omit to read the currently active tab."
        ),
    },
    async ({ tabId }) => {
      if (!bridge.isConnected()) {
        return {
          content: [
            {
              type: "text",
              text: "The ChatMCP Chrome extension is not connected.",
            },
          ],
          isError: true,
        };
      }

      try {
        const page = await bridge.getPage(tabId);

        if (!page.text || page.text.length < 10) {
          return {
            content: [
              {
                type: "text",
                text: `No readable content found on "${page.title}". The page may require interaction or be behind a login.`,
              },
            ],
          };
        }

        const header = `## Page: ${page.title}\n**URL:** ${page.url}\n**Captured:** ${page.extractedAt}\n\n---\n\n`;
        return {
          content: [{ type: "text", text: header + page.text }],
        };
      } catch (err) {
        return {
          content: [{ type: "text", text: `Error: ${(err as Error).message}` }],
          isError: true,
        };
      }
    }
  );

  // ── list_tabs ────────────────────────────────────────────────────────────
  server.tool(
    "list_tabs",
    "List ALL currently open browser tabs (not just AI chats). Useful when you want to get_page_content from a specific tab and need its tabId.",
    {},
    async () => {
      if (!bridge.isConnected()) {
        return {
          content: [{ type: "text", text: "Chrome extension is not connected." }],
          isError: true,
        };
      }

      try {
        const tabs = await bridge.listAllTabs();
        if (tabs.length === 0) {
          return { content: [{ type: "text", text: "No tabs found." }] };
        }
        const lines = tabs.map(
          (t, i) => `${i + 1}. [${t.platform || "page"}] ${t.title}\n   Tab ID: ${t.tabId} | ${t.url}${t.active ? " (active)" : ""}`
        );
        return {
          content: [{ type: "text", text: `${tabs.length} open tab(s):\n\n${lines.join("\n\n")}` }],
        };
      } catch (err) {
        return {
          content: [{ type: "text", text: `Error: ${(err as Error).message}` }],
          isError: true,
        };
      }
    }
  );

  // ── get_claude_artifacts ────────────────────────────────────────────────
  server.tool(
    "get_claude_artifacts",
    "Extract Claude artifacts from a claude.ai tab — JSX/React components, Markdown documents, HTML pages, code files, or Research process steps. Only works when the tab is on claude.ai and the artifact/research panel is open. If no tabId is provided it auto-selects the most recently active claude.ai tab. Returns each artifact's type, title, and full source content.",
    {
      tabId: z
        .number()
        .optional()
        .describe(
          "Specific browser tab ID to pull artifacts from (get this from list_ai_tabs). Omit to auto-select the active claude.ai tab."
        ),
      filterType: z
        .string()
        .optional()
        .describe(
          "Only return artifacts of this type (e.g. 'jsx', 'md', 'html', 'svg', 'research'). Omit to return all artifacts."
        ),
      includeLinks: z
        .boolean()
        .optional()
        .default(false)
        .describe(
          "For research artifacts: also extract source URLs. WARNING: this can return 100+ links and flood context. Consider saveToFile=true instead."
        ),
      maxLinks: z
        .number()
        .optional()
        .default(10)
        .describe(
          "Max URLs to return when includeLinks=true. Default: 10. Use saveToFile=true to get all links written to a file instead."
        ),
    },
    async ({ tabId, filterType, includeLinks, maxLinks }) => {
      if (!bridge.isConnected()) {
        return {
          content: [
            {
              type: "text",
              text: "The ChatMCP Chrome extension is not connected. Please install the extension and make sure it is enabled.",
            },
          ],
          isError: true,
        };
      }

      try {
        const result = await bridge.getArtifacts(tabId, includeLinks ?? false, maxLinks ?? 10);

        let artifacts = result.artifacts;

        if (filterType) {
          const filter = filterType.toLowerCase();
          artifacts = artifacts.filter((a) => a.type.toLowerCase() === filter);
        }

        if (artifacts.length === 0) {
          const note = result.note ?? (filterType
            ? `No artifacts of type "${filterType}" found.`
            : "No artifacts found.");
          return {
            content: [{ type: "text", text: note }],
          };
        }

        if (filterType === "research" && includeLinks && artifacts.length > 0) {
          const content = artifacts[0].content;
          const urlMatch = content.match(/SOURCE_URLS_TOTAL:(\d+)\n(.*)/s);

          if (urlMatch) {
            const totalUrls = parseInt(urlMatch[1], 10);
            const urlLines = urlMatch[2].split("\n").filter((line) => line.startsWith("http"));

            const text = `**Research Sources** (showing ${urlLines.length}/${totalUrls})\n\n${urlLines.join("\n")}`;
            return {
              content: [{ type: "text", text }],
            };
          }
        }

        const header = `## Claude Artifacts\n**Source:** ${result.url}\n**Captured:** ${result.extractedAt}\n**Count:** ${artifacts.length}\n\n---\n\n`;

        const sections = artifacts.map((a, i) => {
          const fence = "```";
          return `### Artifact ${i + 1}: ${a.title}\n**Type:** ${a.type}\n\n${fence}${a.type}\n${a.content}\n${fence}`;
        });

        return {
          content: [{ type: "text", text: header + sections.join("\n\n---\n\n") }],
        };
      } catch (err) {
        const msg = (err as Error).message;
        return {
          content: [{ type: "text", text: `Error: ${msg}` }],
          isError: true,
        };
      }
    }
  );

  // ── extension_status ────────────────────────────────────────────────────
  server.tool(
    "extension_status",
    "Check whether the ChatMCP Chrome extension is connected and ready.",
    {},
    async () => {
      const connected = bridge.isConnected();
      return {
        content: [
          {
            type: "text",
            text: connected
              ? "ChatMCP extension is connected and ready."
              : "ChatMCP extension is NOT connected. Install the extension from the chrome-extension/ folder and enable it.",
          },
        ],
      };
    }
  );

  // ── send_chat_message ────────────────────────────────────────────────────
  server.tool(
    "send_chat_message",
    "Send a message into an AI chat input box and optionally click submit. Supports ChatGPT, Claude, Gemini, Grok, DeepSeek, Mistral, Perplexity. If no tabId is provided it auto-selects the most recently active AI chat tab.",
    {
      text: z
        .string()
        .min(1)
        .describe("The message text to type into the chat input."),
      tabId: z
        .number()
        .optional()
        .describe(
          "Specific browser tab ID to target (get this from list_ai_tabs). Omit to auto-select."
        ),
      confirmation: z
        .enum(["dispatch", "confirmed"])
        .optional()
        .default("confirmed")
        .describe(
          "dispatch: return immediately after triggering send. confirmed: wait for page to confirm submission (default)."
        ),
    },
    async ({ text, tabId, confirmation }) => {
      if (!bridge.isConnected()) {
        return {
          content: [
            {
              type: "text",
              text: "The ChatMCP Chrome extension is not connected. Please install the extension and make sure it is enabled.",
            },
          ],
          isError: true,
        };
      }

      try {
        const result = await bridge.sendChatMessage(text, tabId, undefined, confirmation);

        if (result.success) {
          return {
            content: [
              {
                type: "text",
                text: `Message sent successfully on ${result.platform ?? "AI chat"} (${result.method ?? "click"}).`,
              },
            ],
          };
        } else {
          return {
            content: [{ type: "text", text: `Failed to send message.` }],
            isError: true,
          };
        }
      } catch (err) {
        return {
          content: [{ type: "text", text: `Error: ${(err as Error).message}` }],
          isError: true,
        };
      }
    }
  );
}

// ── Port ownership & lifecycle management ──────────────────────────────────
const CHATMCP_PORT = 27182;
const OWNER_FILE = join(tmpdir(), `chatmcp-${CHATMCP_PORT}.owner.json`);
const instanceId = randomUUID();
let shuttingDown = false;
let parentMonitor: ReturnType<typeof setInterval> | undefined;

function isProcessAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try { process.kill(pid, 0); return true; }
  catch (e: any) { return e?.code === "EPERM"; }
}

async function readPortOwner(): Promise<{ service: string; port: number; pid: number; parentPid: number; instanceId: string; startedAt: string } | null> {
  try {
    const c = JSON.parse(await readFile(OWNER_FILE, "utf8"));
    if (c.service !== "chatmcp" || c.port !== CHATMCP_PORT || !c.pid || !c.parentPid || !c.instanceId) return null;
    return c;
  } catch { return null; }
}
async function writePortOwner(): Promise<void> {
  await writeFile(OWNER_FILE, JSON.stringify({ service: "chatmcp", port: CHATMCP_PORT, pid: process.pid, parentPid: process.ppid, instanceId, startedAt: new Date().toISOString() }, null, 2), { encoding: "utf8", mode: 0o600 });
}
async function removeOwnPortOwner(): Promise<void> {
  const o = await readPortOwner();
  if (o?.pid !== process.pid || o.instanceId !== instanceId) return;
  try { await unlink(OWNER_FILE); } catch {}
}
function sleep(ms: number): Promise<void> { return new Promise(r => setTimeout(r, ms)); }
async function waitForProcessExit(pid: number, timeoutMs = 2000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) { if (!isProcessAlive(pid)) return true; await sleep(100); }
  return !isProcessAlive(pid);
}

async function reclaimStaleChatMcp(): Promise<void> {
  let owner = await readPortOwner();
  if (!owner || owner.pid === process.pid) return;
  if (!isProcessAlive(owner.pid)) { try { await unlink(OWNER_FILE); } catch {} return; }
  for (let i = 0; i < 20; i++) {
    if (!isProcessAlive(owner.pid)) { try { await unlink(OWNER_FILE); } catch {} return; }
    if (!isProcessAlive(owner.parentPid)) break;
    await sleep(100);
    const lo = await readPortOwner();
    if (lo && lo.instanceId !== owner.instanceId) owner = lo;
  }
  if (isProcessAlive(owner.parentPid)) return; // another session still alive
  process.stderr.write(`[ChatMCP] Auto-reclaiming stale process PID=${owner.pid}\n`);
  try { process.kill(owner.pid, "SIGTERM"); } catch {}
  if (!(await waitForProcessExit(owner.pid, 2000))) throw new Error(`Unable to terminate stale ChatMCP PID=${owner.pid}`);
  const lo = await readPortOwner();
  if (lo?.instanceId === owner.instanceId) { try { await unlink(OWNER_FILE); } catch {} }
}

async function shutdown(reason: string, exitCode = 0): Promise<never> {
  if (shuttingDown) process.exit(exitCode);
  shuttingDown = true;
  if (parentMonitor) { clearInterval(parentMonitor); parentMonitor = undefined; }
  process.stderr.write(`[ChatMCP] Shutting down: ${reason}\n`);
  const force = setTimeout(() => process.exit(exitCode), 1500); force.unref();
  try { await bridge.close(reason); } catch {}
  try { await removeOwnPortOwner(); } catch {}
  process.exit(exitCode);
}

// Register graceful exit listeners
process.stdin.once("end", () => { void shutdown("stdin ended"); });
process.stdin.once("close", () => { void shutdown("stdin closed"); });
process.once("disconnect", () => { void shutdown("parent IPC disconnected"); });
process.once("SIGINT", () => { void shutdown("SIGINT"); });
process.once("SIGTERM", () => { void shutdown("SIGTERM"); });
process.once("SIGHUP", () => { void shutdown("SIGHUP"); });
process.once("uncaughtException", (err) => { process.stderr.write(`Fatal: ${err.message}\n`); void shutdown("uncaughtException", 1); });
process.once("unhandledRejection", (reason) => { process.stderr.write(`Rejection: ${reason}\n`); void shutdown("unhandledRejection", 1); });
parentMonitor = setInterval(() => { if (!isProcessAlive(process.ppid)) void shutdown("parent process exited"); }, 1000);
parentMonitor.unref();

// ── Main entry ────────────────────────────────────────────────────────────
async function main() {
  // Reclaim stale port in background (must not block MCP handshake)
  Promise.resolve().then(() => reclaimStaleChatMcp().then(() => writePortOwner()).catch(e => process.stderr.write("[ChatMCP] Startup: " + (e?.message||e) + "\n")));

  // ── Mode selection ──────────────────────────────────────────────────────
  const args = process.argv.slice(2);
  const httpMode = args.includes("--http");

  if (httpMode) {
  // ── HTTP mode: serves multiple clients (OpenCode, Copilot, Cursor, etc.) ──
  // Uses MCP Streamable HTTP transport. Each request is handled statelessly so
  // any number of clients can connect simultaneously.

  const transport = new StreamableHTTPServerTransport({
    sessionIdGenerator: undefined, // stateless — no session tracking needed
  });

  const server = new McpServer({ name: "chatmcp", version: "1.0.0" });
  registerTools(server);
  await server.connect(transport);

  const httpServer = createHttpServer(async (req: IncomingMessage, res: ServerResponse) => {
    if (req.url !== "/mcp") {
      res.writeHead(404, { "Content-Type": "text/plain" });
      res.end("Not found. ChatMCP MCP endpoint is at /mcp");
      return;
    }

    // Collect body for POST requests
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => chunks.push(chunk));
    req.on("end", async () => {
      let parsedBody: unknown;
      if (chunks.length > 0) {
        try {
          parsedBody = JSON.parse(Buffer.concat(chunks).toString());
        } catch {
          res.writeHead(400, { "Content-Type": "text/plain" });
          res.end("Invalid JSON body");
          return;
        }
      }
      await transport.handleRequest(req, res, parsedBody);
    });
  });

  httpServer.listen(HTTP_PORT, "127.0.0.1", () => {
    process.stderr.write(
      `ChatMCP HTTP server running on http://127.0.0.1:${HTTP_PORT}/mcp\n` +
      `Multiple clients (OpenCode, Copilot, Cursor) can connect simultaneously.\n` +
      `Waiting for Chrome extension on port 27182.\n` +
      `\nLike this tool? Buy me a coffee: ${COFFEE_URL}\n`
    );
  });
} else {
  // ── stdio mode (default): Claude Code ──────────────────────────────────
  const server = new McpServer({ name: "chatmcp", version: "1.0.0" });
  registerTools(server);
  const transport = new StdioServerTransport();
  await server.connect(transport);
  process.stderr.write(
    `ChatMCP MCP server running. Waiting for Chrome extension on port 27182.\n` +
    `\nLike this tool? Buy me a coffee: ${COFFEE_URL}\n`
  );
  }
}

void main().catch(err => { process.stderr.write("Fatal: " + (err?.message||err) + "\n"); void shutdown("main failed", 1); });
