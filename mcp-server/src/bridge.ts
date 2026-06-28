import { createServer as createHttpServer, type IncomingMessage } from "http";
import { WebSocketServer, WebSocket } from "ws";
import { randomBytes } from "crypto";
import type { ServerMessage, ExtensionMessage, AiTab, ChatContent, PageContent, ArtifactsContent } from "./types.js";

const BRIDGE_PORT = 27182;
const RETRY_DELAY_MS = 500;
const MAX_RETRIES = 12; // ~1 minute of retrying

interface PendingRequest {
  resolve: (value: unknown) => void;
  reject: (reason: Error) => void;
  timeout: NodeJS.Timeout;
}

export class ExtensionBridge {
  private wss: WebSocketServer | null = null;
  private client: WebSocket | null = null;
  private pending = new Map<string, PendingRequest>();
  private requestCounter = 0;
  private readonly token: string;
  private httpServer: ReturnType<typeof createHttpServer> | null = null;
  private closing = false;
  private startResolve: (() => void) | null = null;
  private _ready: Promise<void>;

  constructor() {
    this.token = randomBytes(32).toString("hex");
    this._ready = new Promise<void>(resolve => { this.startResolve = resolve; });
    this.startServer(0);
  }

  /** Wait until bridge is listening (or already listening) */
  async ensureStarted(): Promise<void> {
    return this._ready;
  }

  private startServer(attempt: number) {
    // Create HTTP server without callback so 'upgrade' event fires.
    // WebSocket upgrade requests are handled via the 'upgrade' listener;
    // regular HTTP goes through the 'request' listener.
    const httpServer = createHttpServer();
    const wss = new WebSocketServer({ noServer: true });

    // WebSocket upgrade — must be registered before 'request' listener
    // because Node.js doesn't emit 'upgrade' when 'request' listener exists.
    // By using .on() directly on the underlying server, we can intercept
    // upgrades before the http module's request handler gets them.
    // Actually: we handle upgrades via the 'upgrade' event which fires
    // correctly when no callback is passed to createHttpServer.
    httpServer.on("upgrade", (request, socket, head) => {
      // Validate token from URL before upgrading
      const url = new URL(request.url ?? "/", "http://localhost");
      const token = url.searchParams.get("token");
      if (token !== this.token) {
        process.stderr.write("Rejecting WebSocket upgrade — invalid or missing token.\n");
        socket.write("HTTP/1.1 403 Forbidden\r\n\r\n");
        socket.destroy();
        return;
      }
      wss.handleUpgrade(request, socket, head, (ws) => {
        wss.emit("connection", ws, request);
      });
    });

    // HTTP request handler — token endpoint only
    httpServer.on("request", (req, res) => {
      if (req.method === "GET" && req.url === "/token") {
        // Relaxed: Chrome MV3 service workers may not send chrome-extension:// origin
        // when fetching localhost. The server only listens on 127.0.0.1 anyway.
        const origin = req.headers["origin"] ?? "";
        if (origin && !origin.startsWith("chrome-extension://")) {
          res.writeHead(403, { "Content-Type": "text/plain" });
          res.end("Forbidden — untrusted origin: " + origin);
          return;
        }
        res.writeHead(200, {
          "Content-Type": "text/plain",
          "Access-Control-Allow-Origin": origin,
        });
        res.end(this.token);
        return;
      }
      // For non-token requests that aren't WebSocket: could be a browser sniffing
      if (!(req.headers["upgrade"] ?? "").toLowerCase().includes("websocket")) {
        res.writeHead(404);
        res.end();
      }
    });

    wss.on("connection", (ws, request) => this.handleUpgrade(ws, request));

    // ws re-emits httpServer errors; suppress here so the httpServer handler below
    // can do the retry without an unhandled 'error' event crashing the process.
    wss.on("error", () => { /* handled by httpServer error handler below */ });

    httpServer.on("error", (err) => {
      const code = (err as NodeJS.ErrnoException).code;
      if (code === "EADDRINUSE") {
        httpServer.close();
        if (attempt < MAX_RETRIES) {
          process.stderr.write(
            `Bridge port ${BRIDGE_PORT} in use, retrying in ${RETRY_DELAY_MS / 1000}s (attempt ${attempt + 1}/${MAX_RETRIES})…\n`
          );
          setTimeout(() => this.startServer(attempt + 1), RETRY_DELAY_MS);
        } else {
          process.stderr.write(
            `Bridge port ${BRIDGE_PORT} still in use after ${MAX_RETRIES} retries. Giving up.\n`
          );
        }
      } else {
        process.stderr.write(`Bridge HTTP error: ${err.message}\n`);
      }
    });

    httpServer.listen(BRIDGE_PORT, "127.0.0.1", () => {
      this.wss = wss;
      this.httpServer = httpServer;
      this.startResolve?.();
      process.stderr.write(`ChatMCP bridge listening on port ${BRIDGE_PORT}.\n`);
    });
  }

  private handleUpgrade(ws: WebSocket, request: IncomingMessage) {
    // Validate auth token from query string
    const url = new URL(request.url ?? "/", "http://localhost");
    const token = url.searchParams.get("token");
    if (token !== this.token) {
      process.stderr.write("Rejecting WebSocket client — invalid or missing token.\n");
      try { ws.close(1008, "Invalid auth token"); } catch { /* ignore */ }
      return;
    }

    // Only one client at a time
    if (this.client && this.client.readyState === WebSocket.OPEN) {
      process.stderr.write("Rejecting extra WebSocket client — one is already connected.\n");
      try { ws.close(1008, "Another client is already connected"); } catch { /* ignore */ }
      return;
    }

    this.handleConnection(ws);
  }

  private handleConnection(ws: WebSocket) {
    this.client = ws;

    ws.on("message", (data) => {
      try {
        const msg = JSON.parse(data.toString()) as ExtensionMessage;
        this.handleExtensionMessage(msg);
      } catch {
        // ignore malformed messages
      }
    });

    ws.on("close", () => {
      if (this.client === ws) this.client = null;
      for (const [id, req] of this.pending) {
        clearTimeout(req.timeout);
        req.reject(new Error("Extension disconnected"));
        this.pending.delete(id);
      }
    });
  }

  private handleExtensionMessage(msg: ExtensionMessage) {
    if (msg.type === "connected") {
      process.stderr.write(`ChatMCP extension connected (v${msg.version})\n`);
      return;
    }

    if (msg.type === "ping") {
      // Respond with pong to acknowledge keepalive
      if (this.client && this.client.readyState === WebSocket.OPEN) {
        this.client.send(JSON.stringify({ type: "pong" }));
      }
      return;
    }

    if (!("requestId" in msg)) return;
    const req = this.pending.get(msg.requestId);
    if (!req) return;

    clearTimeout(req.timeout);
    this.pending.delete(msg.requestId);

    if (msg.type === "error") {
      req.reject(new Error(msg.message));
    } else {
      req.resolve(msg);
    }
  }

  private send(msg: ServerMessage) {
    if (!this.wss) {
      throw new Error(
        "Bridge server is not ready yet — port may be temporarily in use. Try again shortly."
      );
    }
    if (!this.client || this.client.readyState !== WebSocket.OPEN) {
      throw new Error(
        "Chrome extension is not connected. Make sure the ChatMCP extension is installed and enabled."
      );
    }
    this.client.send(JSON.stringify(msg));
  }

  private makeRequestId(): string {
    return `req_${++this.requestCounter}_${Date.now()}`;
  }

  private request<T>(msg: Record<string, unknown>, timeoutMs = 15000): Promise<T> {
    const requestId = this.makeRequestId();
    return new Promise<T>((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.pending.delete(requestId);
        reject(new Error("Request timed out — extension did not respond in time."));
      }, timeoutMs);

      this.pending.set(requestId, {
        resolve: resolve as (v: unknown) => void,
        reject,
        timeout,
      });

      try {
        this.send({ ...msg, requestId } as unknown as ServerMessage);
      } catch (err) {
        clearTimeout(timeout);
        this.pending.delete(requestId);
        reject(err);
      }
    });
  }

  isConnected(): boolean {
    return this.wss !== null && this.client !== null && this.client.readyState === WebSocket.OPEN;
  }

  async listAiTabs(): Promise<AiTab[]> {
    const result = await this.request<{ type: string; tabs: AiTab[] }>(
      { type: "list_ai_tabs" },
      10000
    );
    return result.tabs;
  }

  async listAllTabs(): Promise<AiTab[]> {
    const result = await this.request<{ type: string; tabs: AiTab[] }>(
      { type: "list_all_tabs" },
      10000
    );
    return result.tabs;
  }

  async getChat(tabId?: number): Promise<ChatContent> {
    const result = await this.request<{ type: string; content: ChatContent }>(
      { type: "get_chat", tabId },
      20000
    );
    return result.content;
  }

  async getPage(tabId?: number): Promise<PageContent> {
    const result = await this.request<{ type: string; content: PageContent }>(
      { type: "get_page", tabId },
      20000
    );
    return result.content;
  }

  async getArtifacts(tabId?: number, includeLinks = false, maxLinks = 10): Promise<ArtifactsContent> {
    const result = await this.request<{ type: string; content: ArtifactsContent }>(
      { type: "get_artifacts", tabId, includeLinks, maxLinks },
      60000
    );
    return result.content;
  }

  async sendChatMessage(text: string, tabId?: number, platform?: string, confirmation: "dispatch" | "confirmed" = "confirmed"): Promise<{ success: boolean; platform?: string; method?: string }> {
    const operationId = randomBytes(16).toString("hex");
    const result = await this.request<{ type: string; success: boolean; platform?: string; method?: string }>(
      { type: "send_message", tabId, text, platform, operationId, confirmation },
      25000
    );
    return { success: result.success, platform: result.platform, method: result.method };
  }

  async close(reason = "ChatMCP bridge is shutting down"): Promise<void> {
    if (this.closing) return;
    this.closing = true;
    // Reject all pending requests
    for (const req of this.pending.values()) {
      clearTimeout(req.timeout);
      req.reject(new Error(reason));
    }
    this.pending.clear();
    // Close extension WS client
    if (this.client) {
      try { this.client.terminate(); } catch {}
      this.client = null;
    }
    // Close WebSocketServer
    if (this.wss) {
      for (const client of this.wss.clients) {
        try { client.terminate(); } catch {}
      }
      await new Promise<void>(resolve => { this.wss!.close(() => resolve()); });
    }
    // Close HTTP server
    if (this.httpServer) {
      try { this.httpServer.closeAllConnections?.(); } catch {}
      await new Promise<void>(resolve => { this.httpServer!.close(() => resolve()); });
    }
  }
}
