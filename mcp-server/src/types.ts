import type { ServerMessage, ExtensionMessage, AiTab, ChatMessage, ChatContent, PageContent, ArtifactsContent, ClaudeArtifact } from "./protocol.js";

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
  | "UNKNOWN_ERROR"
  | "INVALID_PROTOCOL_MESSAGE"
  | "PROTOCOL_VERSION_MISMATCH"
  | "INVALID_RESPONSE";

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



// ── Re-export inferred types from protocol schemas (runtime validation source of truth) ───
export type { ServerMessage, ExtensionMessage, AiTab, ChatMessage, ChatContent, PageContent, ArtifactsContent, ClaudeArtifact } from "./protocol.js";
