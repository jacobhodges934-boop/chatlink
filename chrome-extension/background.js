/**
 * ChatMCP background service worker.
 * Connects to the local MCP server via WebSocket and handles requests.
 * Modified: added chrome.storage.local diagnostics log system.
 */

const MCP_TOKEN_URL = "http://127.0.0.1:27182/token";
const MCP_SERVER_BASE = "ws://127.0.0.1:27182";
const connectionTimings = Object.freeze({
  reconnectMs: 3000,
  pingMs: 20000,
  keepaliveAlarmMinutes: 0.3,
  inactiveTabFocusDelayMs: 600,
  injectionProbeIntervalMs: 100,
  injectionProbeAttempts: 10,
});

const KEEPALIVE_ALARM = "chatmcp-keepalive";
const VERSION = "1.0.0";
const MAX_LOG_ENTRIES = 200;

const AI_HOSTNAMES = new Set([
  "chat.openai.com","chatgpt.com","claude.ai","gemini.google.com",
  "grok.com","chat.deepseek.com","chat.mistral.ai","perplexity.ai","www.perplexity.ai",
]);

const PLATFORM_NAMES = {
  "chat.openai.com":"ChatGPT","chatgpt.com":"ChatGPT","claude.ai":"Claude",
  "gemini.google.com":"Gemini","grok.com":"Grok","chat.deepseek.com":"DeepSeek",
  "chat.mistral.ai":"Mistral","perplexity.ai":"Perplexity","www.perplexity.ai":"Perplexity",
};

let ws = null, reconnectTimer = null, pingTimer = null, connected = false;

// ── Diagnostic log system ─────────────────────────────────────────────
async function diagLog(event, detail) {
  try {
    const { diagnostics } = await chrome.storage.local.get("diagnostics");
    const logs = (diagnostics || []).slice(-(MAX_LOG_ENTRIES - 1));
    logs.push({
      ts: new Date().toISOString(),
      event,
      detail: typeof detail === "string" ? detail : JSON.stringify(detail).slice(0, 500),
    });
    await chrome.storage.local.set({ diagnostics: logs, lastConnected: connected, lastUpdate: Date.now() });
  } catch (e) {
    console.warn("[ChatMCP] Failed to write diagnostics log:", e);
  }
}

function classifyErrorCode(message) {
  const lower = String(message || "").toLowerCase();
  if (lower.includes("content script") || lower.includes("receiving end") || lower.includes("could not establish connection") || lower.includes("no response from content script")) {
    return "CONTENT_SCRIPT_MISSING";
  }
  if (lower.includes("input") || lower.includes("输入框")) return "INPUT_NOT_FOUND";
  if (lower.includes("提交确认超时") || lower.includes("submission") || lower.includes("confirm")) {
    return "SUBMISSION_NOT_CONFIRMED";
  }
  if (lower.includes("tab not found")) return "TAB_NOT_FOUND";
  return "UNKNOWN_ERROR";
}

function isRetryableErrorCode(code) {
  return code === "CONTENT_SCRIPT_MISSING" || code === "SUBMISSION_NOT_CONFIRMED" || code === "TAB_NOT_FOUND";
}

function sendError(requestId, stage, errOrMessage, details) {
  const message = errOrMessage && errOrMessage.message ? errOrMessage.message : String(errOrMessage);
  const code = classifyErrorCode(message);
  send({ type: "error", requestId, code, stage, message, retryable: isRetryableErrorCode(code), details });
}

function parseHostname(url) {
  try {
    return new URL(url).hostname;
  } catch (e) {
    return "";
  }
}

async function clearDiagLog() {
  await chrome.storage.local.remove(["diagnostics", "lastConnected", "lastUpdate"]);
  await diagLog("init", "Diagnostics log started v" + VERSION);
}

// ── Keepalive alarm ─────────────────────────────────────────────────────
chrome.alarms.create(KEEPALIVE_ALARM, { periodInMinutes: connectionTimings.keepaliveAlarmMinutes });

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name !== KEEPALIVE_ALARM) return;
  // Only log state changes, not every keepalive (~4800/day saved)
  if (!connected) {
    connect();
  } else if (ws && ws.readyState === WebSocket.OPEN) {
    send({ type: "ping" });
  }
});

// ── WebSocket connection ────────────────────────────────────────────────
async function fetchToken() {
  try {
    const res = await fetch(MCP_TOKEN_URL);
    if (!res.ok) {
      await diagLog("token_fetch_fail", "HTTP " + res.status + " " + res.statusText);
      return null;
    }
    const text = await res.text();
    if (!text || text.length < 10) {
      await diagLog("token_fetch_fail", "empty or short token: " + text.length + " chars");
      return null;
    }
    await diagLog("token_fetch_ok", "token len=" + text.length);
    return text;
  } catch (e) {
    await diagLog("token_fetch_error", e.message);
    return null;
  }
}

async function connect() {
  if (ws) {
    try {
      ws.close();
    } catch (e) {
      await diagLog("ws_close_error", e.message || String(e));
    }
    ws = null;
  }
  await diagLog("connect", "attempting...");

  const token = await fetchToken();
  if (!token) { await diagLog("connect_fail", "no token, scheduling retry in " + connectionTimings.reconnectMs + "ms"); scheduleReconnect(); return; }

  try {
    ws = new WebSocket(MCP_SERVER_BASE + "?token=" + encodeURIComponent(token));
  } catch (e) {
    await diagLog("ws_ctor_error", e.message);
    scheduleReconnect();
    return;
  }

  ws.addEventListener("open", async () => {
    connected = true;
    clearTimeout(reconnectTimer);
    clearInterval(pingTimer);
    send({ type: "connected", version: VERSION });
    updateBadge(true);
    await diagLog("ws_open", "WebSocket connected, badge=ON");
    pingTimer = setInterval(() => {
      if (ws && ws.readyState === WebSocket.OPEN) send({ type: "ping" });
    }, connectionTimings.pingMs);
  });

  ws.addEventListener("message", (event) => {
    let msg;
    try {
      msg = JSON.parse(event.data);
    } catch (e) {
      diagLog("ws_bad_json", e.message || String(e));
      return;
    }
    handleServerMessage(msg);
  });

  ws.addEventListener("close", async (event) => {
    connected = false;
    ws = null;
    clearInterval(pingTimer);
    pingTimer = null;
    updateBadge(false);
    await diagLog("ws_close", "code=" + event.code + " reason=" + event.reason + " wasClean=" + event.wasClean);
    scheduleReconnect();
  });

  ws.addEventListener("error", async (e) => {
    await diagLog("ws_error", "WebSocket error event fired");
  });
}

function send(msg) {
  if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(msg));
}

function scheduleReconnect() {
  clearTimeout(reconnectTimer);
  reconnectTimer = setTimeout(connect, connectionTimings.reconnectMs);
}

function updateBadge(isConnected) {
  chrome.action.setBadgeText({ text: isConnected ? "ON" : "OFF" });
  chrome.action.setBadgeBackgroundColor({ color: isConnected ? "#22c55e" : "#6b7280" });
}

// ── Tab send queue & dedup cache ───────────────────────────────────────
const tabSendQueues = new Map();
const completedSendOps = new Map();
const SEND_OP_TTL_MS = 2 * 60 * 1000;

function enqueueTabSend(tabId, fn) {
  const prev = tabSendQueues.get(tabId) ?? Promise.resolve();
  const next = prev.catch(() => {}).then(fn);
  tabSendQueues.set(tabId, next);
  next.finally(() => { if (tabSendQueues.get(tabId) === next) tabSendQueues.delete(tabId); });
  return next;
}

function getDedupResult(operationId) {
  if (!operationId) return null;
  const c = completedSendOps.get(operationId);
  if (!c) return null;
  if (Date.now() - c.ts > SEND_OP_TTL_MS) { completedSendOps.delete(operationId); return null; }
  return c.result;
}

function setDedupResult(operationId, result) {
  if (!operationId) return;
  completedSendOps.set(operationId, { ts: Date.now(), result });
}

// ── Server message handlers ─────────────────────────────────────────────

// ── Protocol validation guards (lightweight, no Zod) ────────────────────
const PROTO_VERSION = 1;
const SUPPORTED_SERVER_TYPES = new Set(["list_ai_tabs", "list_all_tabs", "get_chat", "get_page", "get_artifacts", "send_message"]);
const MAX_REQ_ID = 128;

function validateServerMessage(msg) {
  if (!msg || typeof msg !== "object" || Array.isArray(msg)) {
    console.warn("[ChatMCP] Invalid server message: not a plain object");
    return false;
  }
  if (msg.protocolVersion !== undefined && msg.protocolVersion !== PROTO_VERSION) {
    console.warn("[ChatMCP] Protocol version mismatch:", msg.protocolVersion);
    return false;
  }
  if (typeof msg.type !== "string" || !SUPPORTED_SERVER_TYPES.has(msg.type)) {
    console.warn("[ChatMCP] Unsupported message type:", msg.type);
    return false;
  }
  if (typeof msg.requestId !== "string" || msg.requestId.length > MAX_REQ_ID) {
    console.warn("[ChatMCP] Invalid or oversized requestId");
    return false;
  }
  if (msg.type === "send_message") {
    if (typeof msg.text !== "string" || msg.text.length === 0) {
      console.warn("[ChatMCP] send_message missing text");
      return false;
    }
    if (msg.confirmation !== undefined && msg.confirmation !== "dispatch" && msg.confirmation !== "confirmed") {
      console.warn("[ChatMCP] Invalid confirmation value:", msg.confirmation);
      return false;
    }
  }
  if ((msg.type === "get_chat" || msg.type === "get_page" || msg.type === "get_artifacts") && msg.tabId !== undefined) {
    if (!Number.isInteger(msg.tabId) || msg.tabId <= 0) {
      console.warn("[ChatMCP] Invalid tabId:", msg.tabId);
      return false;
    }
  }
  return true;
}
function handleServerMessage(raw) {
  if (!validateServerMessage(raw)) {
    diagLog("invalid_server_message", { type: raw && raw.type, problem: "validation failed" });
    return;
  }
  const msg = raw;
  switch (msg.type) {
  switch (msg.type) {
    case "list_ai_tabs":    return handleListAiTabs(msg.requestId);
    case "list_all_tabs":   return handleListAllTabs(msg.requestId);
    case "get_chat":        return handleGetContent(msg.requestId, msg.tabId, "chat");
    case "get_page":        return handleGetContent(msg.requestId, msg.tabId, "page");
    case "get_artifacts":   return handleGetArtifacts(msg.requestId, msg.tabId, msg.includeLinks ?? false, msg.maxLinks ?? 10);
    case "send_message":    return handleSendMessage(msg.requestId, msg.tabId, msg.text, msg.platform, msg.operationId, msg.confirmation);
    default:
      console.warn("[ChatMCP] Unknown message type:", msg.type);
  }
}

async function handleListAllTabs(requestId) {
  try {
    const allTabs = await chrome.tabs.query({});
    const tabs = allTabs
      .filter((tab) => tab.url && !tab.url.startsWith("chrome://") && !tab.url.startsWith("chrome-extension://"))
      .map((tab) => {
        const host = parseHostname(tab.url);
        return { tabId: tab.id, url: tab.url, title: tab.title ?? "", platform: PLATFORM_NAMES[host] ?? "", active: tab.active, windowId: tab.windowId };
    });
    send({ type: "all_tabs_result", requestId, tabs });
  } catch (err) { sendError(requestId, "background.list_all_tabs", err); }
}

async function handleListAiTabs(requestId) {
  try {
    const allTabs = await chrome.tabs.query({});
    const aiTabs = allTabs.filter((tab) => {
      if (!tab.url) return false;
      return AI_HOSTNAMES.has(parseHostname(tab.url));
    }).map((tab) => {
      const host = new URL(tab.url).hostname;
      return { tabId: tab.id, url: tab.url, title: tab.title ?? "", platform: PLATFORM_NAMES[host] ?? host, active: tab.active, windowId: tab.windowId };
    });
    send({ type: "ai_tabs_result", requestId, tabs: aiTabs });
  } catch (err) { sendError(requestId, "background.list_ai_tabs", err); }
}

async function handleGetContent(requestId, targetTabId, mode) {
  try {
    let tab;
    if (targetTabId) {
      tab = await chrome.tabs.get(targetTabId);
    } else if (mode === "chat") {
      const allTabs = await chrome.tabs.query({});
      const aiTabs = allTabs.filter((t) => {
        if (!t.url) return false;
        return AI_HOSTNAMES.has(parseHostname(t.url));
      });
      if (aiTabs.length === 0) { sendError(requestId, "background.get_content.find_tab", "No AI chat tabs are open."); return; }
      tab = aiTabs.find((t) => t.active) ?? aiTabs[0];
    } else {
      const [activeTab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
      if (!activeTab) { sendError(requestId, "background.get_content.find_tab", "No active tab found."); return; }
      tab = activeTab;
    }
    if (!tab?.id) { sendError(requestId, "background.get_content.find_tab", "Tab not found."); return; }

    async function extract() {
      if (mode === "chat") {
        const injected = await chrome.scripting.executeScript({ target: { tabId: tab.id }, func: extractChatInline });
        return injected?.[0]?.result;
      }
      else {
        const injected = await chrome.scripting.executeScript({ target: { tabId: tab.id }, func: extractPageInline });
        return injected?.[0]?.result;
      }
    }

    let result = await extract().catch(() => null);
    if (!result && mode === "chat") {
      result = await chrome.tabs.sendMessage(tab.id, { type: "EXTRACT_CHAT" }).catch(() => null);
    }
    if (!result && !tab.active) {
      await chrome.tabs.update(tab.id, { active: true });
      await chrome.windows.update(tab.windowId, { focused: true });
      await sleep(600);
      result = await extract().catch(() => null);
      if (!result && mode === "chat") {
        result = await chrome.tabs.sendMessage(tab.id, { type: "EXTRACT_CHAT" }).catch(() => null);
      }
    }
    if (!result) { sendError(requestId, "background.get_content.content_script", "No response from content script."); return; }
    if (result.error) { sendError(requestId, "background.get_content.content_script", result.error); return; }

    const host = parseHostname(tab.url);
    const platform = PLATFORM_NAMES[host] ?? host ?? "Unknown";

    if (result.type === "page") {
      send({ type: "page_result", requestId, content: { tabId: tab.id, platform, url: result.url, title: result.title, text: result.text, extractedAt: result.extractedAt } });
    } else {
      send({ type: "chat_result", requestId, content: { tabId: tab.id, platform: result.platform ?? platform, url: result.url, title: result.title, messages: result.messages, extractedAt: result.extractedAt, isGenerating: result.isGenerating, errorState: result.errorState } });
    }
  } catch (err) { sendError(requestId, "background.get_content", err); }
}

async function handleGetArtifacts(requestId, targetTabId, includeLinks, maxLinks) {
  try {
    let tab;
    if (targetTabId) { tab = await chrome.tabs.get(targetTabId); }
    else {
      const allTabs = await chrome.tabs.query({});
      const claudeTabs = allTabs.filter((t) => t.url && parseHostname(t.url) === "claude.ai");
      if (claudeTabs.length === 0) { sendError(requestId, "background.get_artifacts.find_tab", "No claude.ai tabs are open."); return; }
      tab = claudeTabs.find((t) => t.active) ?? claudeTabs[0];
    }
    if (!tab?.id) { sendError(requestId, "background.get_artifacts.find_tab", "Tab not found."); return; }
    const hostname = parseHostname(tab.url);
    if (hostname !== "claude.ai") { sendError(requestId, "background.get_artifacts.find_tab", "Tab is on " + hostname + ", not claude.ai."); return; }

    let result = await chrome.tabs.sendMessage(tab.id, { type: "EXTRACT_ARTIFACTS", includeLinks, maxLinks }).catch(() => null);
    if (!result && !tab.active) {
      await chrome.tabs.update(tab.id, { active: true });
      await chrome.windows.update(tab.windowId, { focused: true });
      await sleep(600);
      result = await chrome.tabs.sendMessage(tab.id, { type: "EXTRACT_ARTIFACTS", includeLinks, maxLinks }).catch(() => null);
    }
    if (!result) { sendError(requestId, "background.get_artifacts.content_script", "No response from content script."); return; }
    if (result.error) { sendError(requestId, "background.get_artifacts.content_script", result.error); return; }
    send({ type: "artifacts_result", requestId, content: { tabId: tab.id, platform: "Claude", url: result.url, title: result.title, artifacts: result.artifacts, count: result.count, extractedAt: result.extractedAt, note: result.note ?? null } });
  } catch (err) { sendError(requestId, "background.get_artifacts", err); }
}

const injectionPromises = new Map();

async function ensureContentScript(tabId) {
  // Dedup: return existing injection promise for this tab
  const existing = injectionPromises.get(tabId);
  if (existing) return existing;

  const promise = (async () => {
    // Try existing content script first
    let ready = await chrome.tabs.sendMessage(tabId, { type: "__CHATLINK_DIAGNOSTICS__" }).catch(() => null);
    if (ready?.version) return ready;

    // Not injected yet — force injection
    await chrome.scripting.executeScript({ target: { tabId }, files: ["content-scripts/extractor.js"] });

    // Poll until ready
    for (let i = 0; i < connectionTimings.injectionProbeAttempts; i++) {
      await new Promise(r => setTimeout(r, connectionTimings.injectionProbeIntervalMs));
      ready = await chrome.tabs.sendMessage(tabId, { type: "__CHATLINK_DIAGNOSTICS__" }).catch(() => null);
      if (ready?.version) return ready;
    }

    throw new Error("Chat page content script did not become ready after injection.");
  })();

  injectionPromises.set(tabId, promise);
  promise.finally(() => { injectionPromises.delete(tabId); });
  return promise;
}

async function handleSendMessage(requestId, targetTabId, text, platform, operationId, confirmation) {
  try {
    if (!text || typeof text !== "string" || text.trim().length === 0) {
      sendError(requestId, "background.send_message.validate", "No text provided to send.");
      return;
    }

    // Dedup check
    if (operationId) {
      const dup = getDedupResult(operationId);
      if (dup) { send({ type: "send_message_result", requestId, ...dup }); return; }
    }

    let tab;
    if (targetTabId) {
      tab = await chrome.tabs.get(targetTabId);
      if (!tab?.url || !AI_HOSTNAMES.has(new URL(tab.url).hostname)) {
        sendError(requestId, "background.send_message.find_tab", "Target tab is not an AI chat page."); return;
      }
    } else {
      const tabs = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
      tab = tabs.find(t => AI_HOSTNAMES.has(parseHostname(t.url)));
      if (!tab) {
        sendError(requestId, "background.send_message.find_tab", "No active AI chat tab. Open ChatGPT/Gemini/Claude first."); return;
      }
    }
    if (!tab?.id) { sendError(requestId, "background.send_message.find_tab", "Tab not found."); return; }

    if (!platform) {
      platform = PLATFORM_NAMES[parseHostname(tab.url)]?.toLowerCase();
    }

    // Serial queue per tab — no auto-focus (just send via content script)
    const result = await enqueueTabSend(tab.id, async () => {
      try {
        await ensureContentScript(tab.id);
        return await chrome.tabs.sendMessage(tab.id, {
          type: "SEND_MESSAGE",
          text: text.trim(),
          platform,
          confirmation: confirmation ?? "confirmed",
        });
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        if (msg.includes("Receiving end does not exist") || msg.includes("Could not establish connection")) {
          throw new Error("Chat page not ready — refresh the ChatGPT/Gemini tab and try again.");
        }
        throw e;
      }
    });

    if (!result) {
      sendError(requestId, "background.send_message.content_script", "No response from content script. Refresh the chat page and try again.");
      return;
    }
    if (result.error) {
      sendError(requestId, "background.send_message.content_script", result.error);
      return;
    }

    const tabPlatform = PLATFORM_NAMES[parseHostname(tab.url)]?.toLowerCase();
    const r = {
      success: !!(result.ok || result.success),
      sent: !!(result.sent ?? result.ok ?? result.success),
      platform: result.platform || result.site || platform || tabPlatform || "unknown",
      method: result.method,
      confirmationSignal: result.confirmationSignal,
    };
    if (operationId) setDedupResult(operationId, r);
    send({ type: "send_message_result", requestId, ...r });
  } catch (err) {
    sendError(requestId, "background.send_message", err);
  }
}

function extractPageInline() {
  const main = document.querySelector("main,[role='main'],article,.content,#content,#main") ?? document.body;
  const clone = main.cloneNode(true);
  for (const el of clone.querySelectorAll("nav,footer,header,aside,[role='navigation'],[role='banner'],[role='complementary'],script,style,noscript,iframe,[aria-hidden='true']")) el.remove();
  for (const pre of clone.querySelectorAll("pre")) {
    const code = pre.querySelector("code");
    const lang = code?.className.match(/language-(\w+)/)?.[1] ?? "";
    pre.replaceWith("\n```" + lang + "\n" + (code ?? pre).textContent.trim() + "\n```\n");
  }
  for (const code of clone.querySelectorAll("code")) code.replaceWith("`" + code.textContent + "`");
  const text = (clone.textContent ?? "").replace(/\n{4,}/g, "\n\n\n").trim();
  return { type: "page", url: location.href, title: document.title, text, extractedAt: new Date().toISOString() };
}

function extractChatInline() {
  function visible(el) {
    if (!el) return false;
    try {
      if (el.checkVisibility) return el.checkVisibility();
      return !!(el.offsetWidth || el.offsetHeight || el.getClientRects().length);
    } catch (e) {
      return false;
    }
  }

  function textOf(el) {
    if (!el) return "";
    const clone = el.cloneNode(true);
    for (const hidden of clone.querySelectorAll('[aria-hidden="true"],button,[role="tooltip"],noscript,style,script')) {
      hidden.remove();
    }
    for (const pre of clone.querySelectorAll("pre")) {
      const code = pre.querySelector("code");
      const lang = code?.className.match(/language-(\w+)/)?.[1] ?? "";
      const content = (code ?? pre).textContent ?? "";
      pre.replaceWith("\n```" + lang + "\n" + content.trim() + "\n```\n");
    }
    for (const code of clone.querySelectorAll("code")) {
      code.replaceWith("`" + code.textContent + "`");
    }
    return (clone.textContent ?? "").replace(/\n{3,}/g, "\n\n").trim();
  }

  function platformName() {
    const host = location.hostname;
    if (host === "chat.openai.com" || host === "chatgpt.com") return "chatgpt";
    if (host === "claude.ai") return "claude";
    if (host === "gemini.google.com") return "gemini";
    if (host === "grok.com") return "grok";
    if (host === "chat.deepseek.com") return "deepseek";
    if (host === "chat.mistral.ai") return "mistral";
    if (host === "perplexity.ai" || host === "www.perplexity.ai") return "perplexity";
    return host || "unknown";
  }

  function fallbackFullText() {
    const main = document.querySelector("main,[role='main'],#main") ?? document.body;
    const text = textOf(main);
    return text ? [{ role: "assistant", content: "[Full page text]\n\n" + text }] : [];
  }

  function extractChatGpt() {
    const messages = [];
    const articles = document.querySelectorAll('article[data-testid^="conversation-turn"]');
    for (const article of articles) {
      const roleEl = article.querySelector("[data-message-author-role]");
      const role = roleEl?.getAttribute("data-message-author-role");
      if (role !== "user" && role !== "assistant") continue;
      const text = textOf(article);
      if (text) messages.push({ role, content: text });
    }
    if (messages.length) return messages;

    const roleEls = document.querySelectorAll("[data-message-author-role]");
    for (const el of roleEls) {
      const role = el.getAttribute("data-message-author-role");
      if (role !== "user" && role !== "assistant") continue;
      const text = textOf(el);
      if (text) messages.push({ role, content: text });
    }
    return messages.length ? messages : fallbackFullText();
  }

  function extractClaude() {
    const messages = [];
    const turns = document.querySelectorAll('[data-testid="human-turn"],[data-testid="ai-turn"]');
    for (const turn of turns) {
      const isHuman = turn.getAttribute("data-testid") === "human-turn";
      const text = textOf(turn);
      if (text) messages.push({ role: isHuman ? "user" : "assistant", content: text });
    }
    if (messages.length) return messages;

    const humanEls = Array.from(document.querySelectorAll(".human-turn,[class*='HumanTurn']"));
    const aiEls = Array.from(document.querySelectorAll(".ai-turn,[class*='AiTurn'],[class*='AssistantTurn']"));
    const allTurns = [
      ...humanEls.map((el) => ({ el, role: "user" })),
      ...aiEls.map((el) => ({ el, role: "assistant" })),
    ].sort((a, b) => {
      const pos = a.el.compareDocumentPosition(b.el);
      return pos & Node.DOCUMENT_POSITION_FOLLOWING ? -1 : 1;
    });
    for (const turn of allTurns) {
      const text = textOf(turn.el);
      if (text) messages.push({ role: turn.role, content: text });
    }
    return messages.length ? messages : fallbackFullText();
  }

  function extractGeneric() {
    const messages = [];
    const selectors = [
      '[data-message-author-role]',
      '[data-testid*="message" i]',
      '[class*="message" i]',
      '[class*="turn" i]',
    ];
    const seen = new Set();
    for (const selector of selectors) {
      const els = document.querySelectorAll(selector);
      for (const el of els) {
        if (seen.has(el) || !visible(el)) continue;
        seen.add(el);
        const marker = [
          el.getAttribute("data-message-author-role"),
          el.getAttribute("data-testid"),
          el.getAttribute("aria-label"),
          el.className,
        ].join(" ").toLowerCase();
        let role = null;
        if (/user|human|you|query|prompt/.test(marker)) role = "user";
        if (/assistant|ai|model|answer|response|bot/.test(marker)) role = "assistant";
        if (!role) continue;
        const text = textOf(el);
        if (text) messages.push({ role, content: text });
      }
      if (messages.length) return messages;
    }
    return fallbackFullText();
  }

  function detectGenerating() {
    const strongSelectors = [
      'button[data-testid*="stop" i]',
      'button[aria-label*="stop" i]',
      'button[aria-label*="停止" i]',
      '[role="button"][aria-label*="stop" i]',
      '[role="button"][aria-label*="停止" i]',
      'button[title*="stop" i]',
      '[data-testid*="stop-generation" i]',
      '[aria-busy="true"]',
      '[role="progressbar"]',
      '[data-testid*="spinner" i]',
      '.spinner',
      '.loading',
      '.streaming',
    ];
    for (const selector of strongSelectors) {
      const els = document.querySelectorAll(selector);
      for (const el of els) {
        if (visible(el)) return true;
      }
    }
    return undefined;
  }

  function detectErrorState() {
    const patterns = [
      /rate limit/i, /usage limit/i, /quota exceeded/i, /too many requests/i,
      /login required/i, /sign in/i, /please log in/i, /session expired/i,
      /captcha/i, /verify you.?re human/i, /are you a robot/i,
      /something went wrong/i, /error generating/i, /unavailable/i,
      /network error/i, /connection lost/i, /try again/i,
      /response blocked/i, /content filtered/i, /violates.*policy/i,
      /您已经达到.*上限/i, /用量.*限制/i, /请登录/i, /验证码/i,
      /网络.*错误/i, /服务.*不可用/i, /生成.*失败/i,
    ];
    const selectors = [
      '[role="alert"]', '[role="status"]', '.alert', '.error', '.warning',
      '.notification', '.toast', '.snackbar', '.banner',
      '[data-testid*="error"]', '[data-testid*="alert"]',
      '.message-error', '.text-error', '.text-red-500',
    ];
    for (const selector of selectors) {
      const els = document.querySelectorAll(selector);
      for (const el of els) {
        if (!visible(el)) continue;
        const text = (el.textContent || "").trim();
        if (!text) continue;
        for (const pattern of patterns) {
          if (pattern.test(text)) return { detected: true, message: text.slice(0, 300), element: selector };
        }
      }
    }
    return { detected: false };
  }

  const platform = platformName();
  let messages;
  if (platform === "chatgpt") messages = extractChatGpt();
  else if (platform === "claude") messages = extractClaude();
  else messages = extractGeneric();

  return {
    type: "chat",
    platform,
    url: location.href,
    title: document.title,
    messages,
    extractedAt: new Date().toISOString(),
    isGenerating: detectGenerating(),
    errorState: detectErrorState(),
    extractor: "background-inline",
  };
}

function sleep(ms) { return new Promise((resolve) => setTimeout(resolve, ms)); }

// ── Popup status channel ────────────────────────────────────────────────
chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg?.type === "get_status") {
    sendResponse({ connected, readyState: ws?.readyState ?? null });
    return false;
  }
  if (msg?.type === "force_reconnect") {
    clearTimeout(reconnectTimer);
    connect();
    sendResponse({ ok: true });
    return false;
  }
});

// ── Init ────────────────────────────────────────────────────────────────
updateBadge(false);
clearDiagLog().then(() => connect());
