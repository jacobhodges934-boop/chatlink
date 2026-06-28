export interface AiTab {
  tabId: number;
  url: string;
  title: string;
  platform: string;
  active: boolean;
  windowId: number;
}

export interface ChatMessage {
  role: "user" | "assistant";
  content: string;
}

export interface ChatContent {
  tabId: number;
  platform: string;
  url: string;
  title: string;
  messages: ChatMessage[];
  extractedAt: string;
  isGenerating?: boolean;
  errorState?: { detected: boolean; message?: string; element?: string };
}

export interface PageContent {
  tabId: number;
  platform: string;
  url: string;
  title: string;
  text: string;
  extractedAt: string;
}

export interface ClaudeArtifact {
  type: string;    // e.g. "jsx", "md", "html", "tsx", "py", "svg", "text"
  title: string;
  content: string;
}

export interface ArtifactsContent {
  tabId: number;
  platform: string;
  url: string;
  title: string;
  artifacts: ClaudeArtifact[];
  count: number;
  extractedAt: string;
  note?: string | null;
}

export type ChatMcpErrorCode =
  | "BRIDGE_NOT_READY"
  | "EXTENSION_DISCONNECTED"
  | "CONTENT_SCRIPT_MISSING"
  | "INPUT_NOT_FOUND"
  | "SUBMISSION_NOT_CONFIRMED"
  | "REQUEST_TIMEOUT"
  | "INVALID_REQUEST"
  | "TAB_NOT_FOUND"
  | "BRIDGE_START_FAILED"
  | "UNKNOWN_ERROR";

export interface StructuredError {
  code: ChatMcpErrorCode;
  stage: string;
  message: string;
  requestId?: string;
  retryable: boolean;
  details?: unknown;
}

export class ChatMcpError extends Error {
  readonly code: ChatMcpErrorCode;
  readonly stage: string;
  readonly requestId?: string;
  readonly retryable: boolean;
  readonly details?: unknown;

  constructor(error: StructuredError) {
    super(error.message);
    this.name = "ChatMcpError";
    this.code = error.code;
    this.stage = error.stage;
    this.requestId = error.requestId;
    this.retryable = error.retryable;
    this.details = error.details;
  }

  toJSON(): StructuredError {
    return {
      code: this.code,
      stage: this.stage,
      message: this.message,
      requestId: this.requestId,
      retryable: this.retryable,
      details: this.details,
    };
  }
}

// Messages from MCP server → extension
export type ServerMessage =
  | { type: "list_ai_tabs"; requestId: string }
  | { type: "list_all_tabs"; requestId: string }
  | { type: "get_chat"; requestId: string; tabId?: number }
  | { type: "get_page"; requestId: string; tabId?: number }
  | { type: "get_artifacts"; requestId: string; tabId?: number; includeLinks?: boolean; maxLinks?: number }
  | { type: "send_message"; requestId: string; tabId?: number; text: string; platform?: string; operationId?: string; confirmation?: string };

// Messages from extension → MCP server
export type ExtensionMessage =
  | { type: "connected"; version: string }
  | { type: "ping" }
  | { type: "ai_tabs_result"; requestId: string; tabs: AiTab[] }
  | { type: "all_tabs_result"; requestId: string; tabs: AiTab[] }
  | { type: "chat_result"; requestId: string; content: ChatContent }
  | { type: "page_result"; requestId: string; content: PageContent }
  | { type: "artifacts_result"; requestId: string; content: ArtifactsContent }
  | { type: "error"; requestId: string; message: string; code?: ChatMcpErrorCode; stage?: string; retryable?: boolean; details?: unknown }
  | { type: "send_message_result"; requestId: string; success: boolean; sent?: boolean; platform?: string; method?: string; confirmationSignal?: string };
