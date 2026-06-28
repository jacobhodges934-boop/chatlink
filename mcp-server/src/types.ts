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

// Messages from MCP server → extension
export type ServerMessage =
  | { type: "list_ai_tabs"; requestId: string }
  | { type: "list_all_tabs"; requestId: string }
  | { type: "get_chat"; requestId: string; tabId?: number }
  | { type: "get_page"; requestId: string; tabId?: number }
  | { type: "get_artifacts"; requestId: string; tabId?: number; includeLinks?: boolean; maxLinks?: number };

// Messages from extension → MCP server
export type ExtensionMessage =
  | { type: "connected"; version: string }
  | { type: "ping" }
  | { type: "ai_tabs_result"; requestId: string; tabs: AiTab[] }
  | { type: "all_tabs_result"; requestId: string; tabs: AiTab[] }
  | { type: "chat_result"; requestId: string; content: ChatContent }
  | { type: "page_result"; requestId: string; content: PageContent }
  | { type: "artifacts_result"; requestId: string; content: ArtifactsContent }
  | { type: "error"; requestId: string; message: string };
