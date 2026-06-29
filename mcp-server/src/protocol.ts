import { z } from "zod";

// ── Protocol constants ──────────────────────────────────────────────────────
export const MAX_WS_FRAME_BYTES = 4 * 1024 * 1024;
export const MAX_SEND_TEXT_LENGTH = 512 * 1024;
export const MAX_CHAT_MESSAGE_LENGTH = 2 * 1024 * 1024;
export const MAX_ERROR_MESSAGE_LENGTH = 4096;
export const MAX_MESSAGES_PER_CHAT = 500;
export const MAX_REQUEST_ID_LENGTH = 128;
export const PROTOCOL_VERSION = 1;

// ── Base schemas ─────────────────────────────────────────────────────────────
export const RequestIdSchema = z.string().max(MAX_REQUEST_ID_LENGTH);

export const AiTabSchema = z.object({
  tabId: z.number().int().positive(),
  url: z.string().url().max(8192),
  title: z.string().max(1024),
  platform: z.string().max(128),
  active: z.boolean(),
  windowId: z.number().int(),
});

export const ChatMessageSchema = z.object({
  role: z.enum(["user", "assistant"]),
  content: z.string().max(MAX_CHAT_MESSAGE_LENGTH),
});

export const PlatformErrorStateSchema = z.object({
  detected: z.boolean(),
  message: z.string().max(MAX_ERROR_MESSAGE_LENGTH).optional(),
  element: z.string().max(512).optional(),
  code: z.string().max(128).optional(),
  ruleId: z.string().max(128).optional(),
  source: z.string().max(256).optional(),
  retryable: z.boolean().optional(),
});

export const ChatContentSchema = z.object({
  tabId: z.number().int().positive(),
  platform: z.string().max(128),
  url: z.string().max(8192),
  title: z.string().max(1024),
  messages: z.array(ChatMessageSchema).max(MAX_MESSAGES_PER_CHAT),
  extractedAt: z.string(),
  isGenerating: z.boolean().optional(),
  errorState: PlatformErrorStateSchema.optional(),
});

export const PageContentSchema = z.object({
  tabId: z.number().int().positive(),
  platform: z.string().max(128),
  url: z.string().max(8192),
  title: z.string().max(1024),
  text: z.string().max(MAX_CHAT_MESSAGE_LENGTH * 5),
  extractedAt: z.string(),
});

export const ClaudeArtifactSchema = z.object({
  type: z.string().max(64),
  title: z.string().max(1024),
  content: z.string().max(MAX_CHAT_MESSAGE_LENGTH * 5),
});

export const ArtifactsContentSchema = z.object({
  tabId: z.number().int().positive(),
  platform: z.string().max(128),
  url: z.string().max(8192),
  title: z.string().max(1024),
  artifacts: z.array(ClaudeArtifactSchema),
  count: z.number().int().nonnegative(),
  extractedAt: z.string(),
  note: z.string().nullable().optional(),
});

// ── Envelope schemas (discriminated unions, strict) ──────────────────────────
export const ServerMessageSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("list_ai_tabs"), requestId: RequestIdSchema }).strict(),
  z.object({ type: z.literal("list_all_tabs"), requestId: RequestIdSchema }).strict(),
  z.object({ type: z.literal("get_chat"), requestId: RequestIdSchema, tabId: z.number().int().positive().optional() }).strict(),
  z.object({ type: z.literal("get_page"), requestId: RequestIdSchema, tabId: z.number().int().positive().optional() }).strict(),
  z.object({ type: z.literal("get_artifacts"), requestId: RequestIdSchema, tabId: z.number().int().positive().optional(), includeLinks: z.boolean().optional(), maxLinks: z.number().int().positive().max(100).optional() }).strict(),
  z.object({ type: z.literal("send_message"), requestId: RequestIdSchema, tabId: z.number().int().positive().optional(), text: z.string().min(1).max(MAX_SEND_TEXT_LENGTH), platform: z.string().max(128).optional(), operationId: z.string().max(128).optional(), confirmation: z.enum(["dispatch", "confirmed"]).optional() }).strict(),
]);

export const ExtensionMessageSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("connected"), version: z.string().max(64) }).strict(),
  z.object({ type: z.literal("ping") }).strict(),
  z.object({ type: z.literal("ai_tabs_result"), requestId: RequestIdSchema, tabs: z.array(AiTabSchema) }).strict(),
  z.object({ type: z.literal("all_tabs_result"), requestId: RequestIdSchema, tabs: z.array(AiTabSchema) }).strict(),
  z.object({ type: z.literal("chat_result"), requestId: RequestIdSchema, content: ChatContentSchema }).strict(),
  z.object({ type: z.literal("page_result"), requestId: RequestIdSchema, content: PageContentSchema }).strict(),
  z.object({ type: z.literal("artifacts_result"), requestId: RequestIdSchema, content: ArtifactsContentSchema }).strict(),
  z.object({ type: z.literal("send_message_result"), requestId: RequestIdSchema, success: z.boolean(), sent: z.boolean().optional(), platform: z.string().max(128).optional(), method: z.string().max(64).optional(), confirmationSignal: z.string().max(128).optional() }).strict(),
  z.object({ type: z.literal("error"), requestId: RequestIdSchema, message: z.string().max(MAX_ERROR_MESSAGE_LENGTH), code: z.string().max(64).optional(), stage: z.string().max(128).optional(), retryable: z.boolean().optional(), details: z.unknown().optional() }).strict(),
]);

// ── Response shape schemas (passthrough for flexible matching) ────────────────
export const AiTabsResultSchema = z.object({ tabs: z.array(AiTabSchema) }).passthrough();
export const ChatResultSchema = z.object({ content: ChatContentSchema }).passthrough();
export const PageResultSchema = z.object({ content: PageContentSchema }).passthrough();
export const ArtifactsResultSchema = z.object({ content: ArtifactsContentSchema }).passthrough();
export const SendMessageResultSchema = z.object({ success: z.boolean(), platform: z.string().optional(), method: z.string().optional(), confirmationSignal: z.string().optional() }).passthrough();

// ── Inferred types ────────────────────────────────────────────────────────────
export type ServerMessage = z.infer<typeof ServerMessageSchema>;
export type ExtensionMessage = z.infer<typeof ExtensionMessageSchema>;
export type AiTab = z.infer<typeof AiTabSchema>;
export type ChatMessage = z.infer<typeof ChatMessageSchema>;
export type ChatContent = z.infer<typeof ChatContentSchema>;
export type PageContent = z.infer<typeof PageContentSchema>;
export type ArtifactsContent = z.infer<typeof ArtifactsContentSchema>;
export type ClaudeArtifact = z.infer<typeof ClaudeArtifactSchema>;
