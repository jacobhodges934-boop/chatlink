import { createServer as createHttpServer, type IncomingMessage } from "http";
import { WebSocketServer, WebSocket } from "ws";
import { randomBytes } from "crypto";
import { z } from "zod";
import { ChatMcpError, type ChatMcpErrorCode, type StructuredError } from "./types.js";
import {
  ServerMessageSchema, ExtensionMessageSchema,
  AiTabsResultSchema, ChatResultSchema, PageResultSchema,
  ArtifactsResultSchema, SendMessageResultSchema,
  MAX_WS_FRAME_BYTES, PROTOCOL_VERSION,
  type ServerMessage, type ExtensionMessage, type AiTab,
  type ChatContent, type PageContent, type ArtifactsContent,
} from "./protocol.js";

const BRIDGE_PORT = 27182;
const RETRY_DELAY_MS = 500;
const MAX_RETRIES = 12; // ~1 minute of retrying

function isTrustedOrigin(origin: string): boolean {
  // MV3 service workers may omit Origin when fetching localhost
  if (!origin) return true;
  // Only chrome-extension:// origins can reach localhost:27182
  return origin.startsWith("chrome-extension://");
}

interface PendingRequest {
  responseSchema: z.ZodType<unknown>;
  expectedType: string;
  resolve: (value: unknown) => void;
  reject: (reason: Error) => void;
  timeout: NodeJS.Timeout;
  tabId?: number;
}

type BridgeState = "idle" | "starting" | "ready" | "failed" | "closing";

export class ExtensionBridge {
  private wss: WebSocketServer | null = null;
  private client: WebSocket | null = null;
  private pending = new Map<string, PendingRequest>();
  private requestCounter = 0;
  private readonly token: string;
  private httpServer: ReturnType<typeof createHttpServer> | null = null;
  private state: BridgeState = "idle";
  private startResolve: (() => void) | null = null;
  private startReject: ((reason: Error) => void) | null = null;
  private _ready: Promise<void> | null = null;
  private lastStartError: Error | null = null;

  constructor() {
    this.token = randomBytes(32).toString("hex");
  }

  start(): Promise<void> {
    if (this.state === "ready") return Promise.resolve();
    if (this.state === "starting" && this._ready) return this._ready;
    if (this.state === "closing") {
      return Promise.reject(this.makeError("BRIDGE_NOT_READY", "bridge.start", "Bridge is closing.", undefined, true));
    }
    if (this.state === "failed") {
      return Promise.reject(
        this.lastStartError ??
          this.makeError("BRIDGE_START_FAILED", "bridge.start", "Bridge failed to start.", undefined, true)
      );
    }

    this.state = "starting";
    this._ready = new Promise<void>((resolve, reject) => {
      this.startResolve = resolve;
      this.startReject = reject;
    });
    this.startServer(0);
    return this._ready;
  }

  /** Wait until bridge is listening (or already listening) */
  async ensureStarted(): Promise<void> {
    return this.start();
  }

  private makeError(
    code: ChatMcpErrorCode,
    stage: string,
    message: string,
    requestId?: string,
    retryable = false,
    details?: unknown
  ): ChatMcpError {
    return new ChatMcpError({ code, stage, message, requestId, retryable, details });
  }

  private failStart(error: Error) {
    this.state = "failed";
    this.lastStartError = error;
    this.startReject?.(error);
    this.startResolve = null;
    this.startReject = null;
  }

  private startServer(attempt: number): void {
    if (this.state !== "starting") return;
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
        // Chrome MV3 service workers may omit Origin when fetching localhost.
        // If Origin is present, only the packaged ChatLink extension may fetch the token.
        const origin = req.headers["origin"] ?? "";
        if (!isTrustedOrigin(origin)) {
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
          const startError = this.makeError(
            "BRIDGE_START_FAILED",
            "bridge.listen",
            `Bridge port ${BRIDGE_PORT} still in use after ${MAX_RETRIES} retries.`,
            undefined,
            true,
            { port: BRIDGE_PORT, attempts: MAX_RETRIES }
          );
          process.stderr.write(`${startError.message} Giving up.\n`);
          this.failStart(startError);
        }
      } else {
        process.stderr.write(`Bridge HTTP error: ${err.message}\n`);
        this.failStart(
          this.makeError("BRIDGE_START_FAILED", "bridge.listen", err.message, undefined, true, {
            code,
          })
        );
      }
    });

    httpServer.listen(BRIDGE_PORT, "127.0.0.1", () => {
      if (this.state !== "starting") {
        httpServer.close((err) => {
          if (err) process.stderr.write(`Bridge close after abandoned start failed: ${err.message}\n`);
        });
        return;
      }
      this.wss = wss;
      this.httpServer = httpServer;
      this.state = "ready";
      this.startResolve?.();
      this.startResolve = null;
      this.startReject = null;
      process.stderr.write(`ChatLink bridge listening on port ${BRIDGE_PORT}.\n`);
    });
  }

  private handleUpgrade(ws: WebSocket, request: IncomingMessage) {
    // Validate auth token from query string
    const url = new URL(request.url ?? "/", "http://localhost");
    const token = url.searchParams.get("token");
    if (token !== this.token) {
      process.stderr.write("Rejecting WebSocket client — invalid or missing token.\n");
      try {
        ws.close(1008, "Invalid auth token");
      } catch (err) {
        process.stderr.write(`Failed to close invalid WebSocket client: ${String(err)}\n`);
      }
      return;
    }

    // Only one client at a time
    if (this.client && this.client.readyState === WebSocket.OPEN) {
      process.stderr.write("Rejecting extra WebSocket client — one is already connected.\n");
      try {
        ws.close(1008, "Another client is already connected");
      } catch (err) {
        process.stderr.write(`Failed to close duplicate WebSocket client: ${String(err)}\n`);
      }
      return;
    }

    this.handleConnection(ws);
  }

  private handleConnection(ws: WebSocket) {
    this.client = ws;

    ws.on("message", (data) => {
      this.handleIncomingFrame(data);
    });

    ws.on("close", () => {
      if (this.client === ws) this.client = null;
      for (const [id, req] of this.pending) {
        clearTimeout(req.timeout);
        req.reject(
          this.makeError(
            "EXTENSION_DISCONNECTED",
            "bridge.websocket.close",
            "Extension disconnected before the request completed.",
            id,
            true
          )
        );
        this.pending.delete(id);
      }
    });
  }

    private handleIncomingFrame(data: unknown): void {
    // Step 1: Reject oversized frames
    const raw = typeof data === "string" ? data : Buffer.isBuffer(data) ? data.toString() : JSON.stringify(data);
    if (Buffer.byteLength(raw, "utf8") > MAX_WS_FRAME_BYTES) {
      process.stderr.write("[ChatLink] Ignoring oversized frame: " + Buffer.byteLength(raw, "utf8") + " bytes > " + MAX_WS_FRAME_BYTES + "\n");
      return;
    }
    let parsed;
    try { parsed = JSON.parse(raw); } catch (err) {
      process.stderr.write("[ChatLink] Ignoring unparseable frame: " + String(err) + "\n");
      return;
    }
    const schemaResult = ExtensionMessageSchema.safeParse(parsed);
    if (!schemaResult.success) {
      const rid = typeof parsed.requestId === "string" ? parsed.requestId : "?";
      process.stderr.write("[ChatLink] Protocol validation failed (type=" + String(parsed.type) + ", requestId=" + rid + "): " + schemaResult.error.message + "\n");
      return;
    }
    const msg = schemaResult.data;
    if (parsed.protocolVersion !== undefined && parsed.protocolVersion !== PROTOCOL_VERSION) {
      process.stderr.write("[ChatLink] Protocol version mismatch: got " + parsed.protocolVersion + ", expected " + PROTOCOL_VERSION + "\n");
      try { this.client?.close(4001, "Protocol version mismatch"); } catch {}
      return;
    }
    if (msg.type === "connected") {
      process.stderr.write("ChatLink extension connected (v" + msg.version + ")" + "\n");
      return;
    }
    if (msg.type === "ping") { return; }
    if (msg.type === "tab_closed" || msg.type === "tab_navigated") {
      const eventName = msg.type === "tab_closed" ? "TAB_CLOSED" : "TAB_NAVIGATED";
      process.stderr.write("[ChatLink] Tab event: " + eventName + " tabId=" + msg.tabId + "\n");
      // Reject only pending requests for this specific tab
      const closedTabId = msg.tabId;
      for (const [id, req] of this.pending) {
        // Only reject requests that target the closed/navigated tab (or untargeted requests as a safety net)
        if (req.tabId !== undefined && req.tabId !== closedTabId) continue;
        clearTimeout(req.timeout);
        req.reject(this.makeError("TAB_NOT_FOUND", "bridge.tab_lifecycle",
          "Tab " + closedTabId + " was " + (msg.type === "tab_closed" ? "closed" : "navigated away"), id, false,
          { tabId: closedTabId, event: eventName }));
        this.pending.delete(id);
      }
      return;
    }
    if (!("requestId" in msg)) return;
    const req = this.pending.get(msg.requestId);
    if (!req) {
      process.stderr.write("[ChatLink] No pending request found for requestId=" + msg.requestId + ", type=" + msg.type + "\n");
      return;
    }
    clearTimeout(req.timeout); this.pending.delete(msg.requestId);
    if (msg.type === "error") {
      req.reject(this.makeError((msg.code ?? this.classifyErrorCode(msg.message)) as ChatMcpErrorCode, "extension", msg.message, msg.requestId, msg.retryable ?? this.isRetryableExtensionError(msg.message), msg.details));
      return;
    }
    if (msg.type !== req.expectedType) {
      req.reject(this.makeError("INVALID_RESPONSE", "bridge.handleIncomingFrame", "Expected response type " + req.expectedType + " but got " + msg.type + ".", msg.requestId, false));
      return;
    }
    const responseResult = req.responseSchema.safeParse(msg);
    if (!responseResult.success) {
      req.reject(this.makeError("INVALID_RESPONSE", "bridge.handleIncomingFrame", "Response schema validation failed for " + msg.type + ": " + responseResult.error.message, msg.requestId, false, { zodError: responseResult.error.format() }));
      return;
    }
    req.resolve(responseResult.data);
  }
private handleExtensionMessage(msg: ExtensionMessage) {
    // Legacy dispatcher -- kept for backward compat
    if (msg.type === "connected") {
      process.stderr.write("ChatLink extension connected (v" + msg.version + "\n");
      return;
    }
    if (msg.type === "ping") {
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
      req.reject(
        this.makeError(
          (msg.code ?? this.classifyErrorCode(msg.message)) as ChatMcpErrorCode,
          msg.stage ?? "extension",
          msg.message,
          msg.requestId,
          msg.retryable ?? this.isRetryableExtensionError(msg.message),
          msg.details
        )
      );
    } else {
      req.resolve(msg);
    }
  }

    private classifyErrorCode(message: string): ChatMcpErrorCode {
    const lower = message.toLowerCase();
    if (lower.includes("content script") || lower.includes("receiving end") || lower.includes("could not establish connection")) {
      return "CONTENT_SCRIPT_MISSING";
    }
    if (lower.includes("input") || lower.includes("输入框")) return "INPUT_NOT_FOUND";
    if (lower.includes("提交确认超时") || lower.includes("submission") || lower.includes("confirm")) {
      return "SUBMISSION_NOT_CONFIRMED";
    }
    if (lower.includes("tab not found")) return "TAB_NOT_FOUND";
    return "UNKNOWN_ERROR";
  }

  private isRetryableExtensionError(message: string): boolean {
    const code = this.classifyErrorCode(message);
    return code === "CONTENT_SCRIPT_MISSING" || code === "SUBMISSION_NOT_CONFIRMED" || code === "TAB_NOT_FOUND";
  }

  private validateOutgoing(msg: Record<string, unknown>): void {
    const result = ServerMessageSchema.safeParse(msg);
    if (!result.success) {
      process.stderr.write("[ChatLink] Outgoing message validation warning (type=" + String(msg.type) + "): " + result.error.message + "\n");
    }
  }

  private send(msg: ServerMessage) {
    if (this.state !== "ready" || !this.wss) {
      throw this.makeError(
        "BRIDGE_NOT_READY",
        "bridge.send",
        "Bridge server is not ready yet.",
        msg.requestId,
        true,
        { state: this.state }
      );
    }
    if (!this.client || this.client.readyState !== WebSocket.OPEN) {
      throw this.makeError(
        "EXTENSION_DISCONNECTED",
        "bridge.send",
        "Chrome extension is not connected. Make sure the ChatLink extension is installed and enabled.",
        msg.requestId,
        true
      );
    }
    this.client.send(JSON.stringify(msg));
  }

  private makeRequestId(): string {
    return `req_${++this.requestCounter}_${Date.now()}`;
  }

  private request<T>(msg: Record<string, unknown>, responseSchema: z.ZodType<T>, expectedType: string, timeoutMs = 15000, tabId?: number): Promise<T> {
    const requestId = this.makeRequestId();
    return new Promise<T>((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.pending.delete(requestId);
        reject(
          this.makeError(
            "REQUEST_TIMEOUT",
            "bridge.request",
            "Request timed out — extension did not respond in time.",
            requestId,
            true,
            { timeoutMs }
          )
        );
      }, timeoutMs);

      this.pending.set(requestId, {
        responseSchema: responseSchema as z.ZodType<unknown>,
        expectedType,
        resolve: resolve as (v: unknown) => void,
        reject,
        timeout,
        tabId,
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
    return this.state === "ready" && this.wss !== null && this.client !== null && this.client.readyState === WebSocket.OPEN;
  }

  async listAiTabs(): Promise<AiTab[]> {
    const result = await this.request(
      { type: "list_ai_tabs" },
      AiTabsResultSchema,
      "ai_tabs_result",
      10000
    );
    return result.tabs;
  }

  async listAllTabs(): Promise<AiTab[]> {
    const result = await this.request(
      { type: "list_all_tabs" },
      AiTabsResultSchema,
      "all_tabs_result",
      10000
    );
    return result.tabs;
  }

  async getChat(tabId?: number, sinceIndex?: number): Promise<ChatContent> {
    const result = await this.request(
      { type: "get_chat", tabId, sinceIndex },
      ChatResultSchema,
      "chat_result",
      20000,
      tabId
    );
    return result.content;
  }

  async getPage(tabId?: number): Promise<PageContent> {
    const result = await this.request(
      { type: "get_page", tabId },
      PageResultSchema,
      "page_result",
      20000,
      tabId
    );
    return result.content;
  }

  async getArtifacts(tabId?: number, includeLinks = false, maxLinks = 10): Promise<ArtifactsContent> {
    const result = await this.request(
      { type: "get_artifacts", tabId, includeLinks, maxLinks },
      ArtifactsResultSchema,
      "artifacts_result",
      60000
    );
    return result.content;
  }

  async sendChatMessage(text: string, tabId?: number, platform?: string, confirmation: "dispatch" | "confirmed" = "confirmed", operationId?: string): Promise<{ success: boolean; platform?: string; method?: string; confirmationSignal?: string }> {
    const opId = operationId || randomBytes(16).toString("hex");
    const result = await this.request(
      { type: "send_message", tabId, text, platform, operationId: opId, confirmation },
      SendMessageResultSchema,
      "send_message_result",
      25000,
      tabId
    );
    return { success: result.success, platform: result.platform, method: result.method, confirmationSignal: result.confirmationSignal };
  }

  async close(reason = "ChatLink bridge is shutting down"): Promise<void> {
    if (this.state === "closing") return;
    this.state = "closing";
    // Reject all pending requests
    for (const req of this.pending.values()) {
      clearTimeout(req.timeout);
      req.reject(this.makeError("BRIDGE_NOT_READY", "bridge.close", reason, undefined, true));
    }
    this.pending.clear();
    // Close extension WS client
    if (this.client) {
      try {
        this.client.terminate();
      } catch (err) {
        process.stderr.write(`Failed to terminate extension client: ${String(err)}\n`);
      }
      this.client = null;
    }
    // Close WebSocketServer
    if (this.wss) {
      for (const client of this.wss.clients) {
        try {
          client.terminate();
        } catch (err) {
          process.stderr.write(`Failed to terminate WebSocket client: ${String(err)}\n`);
        }
      }
      await new Promise<void>(resolve => { this.wss!.close(() => resolve()); });
      this.wss = null;
    }
    // Close HTTP server
    if (this.httpServer) {
      try {
        this.httpServer.closeAllConnections?.();
      } catch (err) {
        process.stderr.write(`Failed to close bridge HTTP connections: ${String(err)}\n`);
      }
      await new Promise<void>(resolve => { this.httpServer!.close(() => resolve()); });
      this.httpServer = null;
    }
  }
}
