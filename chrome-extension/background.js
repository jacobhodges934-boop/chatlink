/**
 * ChatLink background service worker.
 * Connects to the local MCP server via WebSocket and handles requests.
 * Modified: added chrome.storage.local diagnostics log system.
 */

const MCP_TOKEN_URL = "http://127.0.0.1:27182/token";
const MCP_SERVER_BASE = "ws://127.0.0.1:27182";
const connectionTimings = Object.freeze({
  reconnectMs: 3000,
  pingMs: 20000,
  keepaliveAlarmMinutes: 0.5,
  inactiveTabFocusDelayMs: 600,
  injectionProbeIntervalMs: 100,
  injectionProbeAttempts: 10,
});

const KEEPALIVE_ALARM = "chatlink-keepalive";
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
    console.warn("[ChatLink] Failed to write diagnostics log:", e);
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

// ── Tab lifecycle listeners — notify server immediately on close/navigate ──
chrome.tabs.onRemoved.addListener((tabId) => {
  if (connected && ws && ws.readyState === WebSocket.OPEN) {
    send({ type: "tab_closed", tabId });
  }
});

chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
  if (!changeInfo.url) return;
  if (!connected || !ws || ws.readyState !== WebSocket.OPEN) return;
  // Notify if AI tab navigated to a different host (AI→non-AI or AI→AI switch)
  const oldHost = parseHostname(tab.url || "");
  const newHost = parseHostname(changeInfo.url);
  if (oldHost && oldHost !== newHost) {
    send({ type: "tab_navigated", tabId, url: changeInfo.url });
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
const DEDUP_STORAGE_KEY = "completedSendOps";

// Restore dedup cache from session storage on Service Worker startup
(async function restoreDedupCache() {
  try {
    const stored = await chrome.storage.session.get(DEDUP_STORAGE_KEY);
    const entries = stored[DEDUP_STORAGE_KEY];
    if (Array.isArray(entries)) {
      const now = Date.now();
      for (const entry of entries) {
        if (entry && entry.op && now - entry.ts < SEND_OP_TTL_MS) {
          completedSendOps.set(entry.op, { ts: entry.ts, result: entry.result });
        }
      }
    }
  } catch (_) { /* storage unavailable — continue with empty cache */ }
})();

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
  // Persist to session storage so cache survives Service Worker restart
  try {
    const entries = [];
    completedSendOps.forEach((v, k) => {
      if (Date.now() - v.ts < SEND_OP_TTL_MS) {
        entries.push({ op: k, ts: v.ts, result: v.result });
      }
    });
    chrome.storage.session.set({ [DEDUP_STORAGE_KEY]: entries.slice(-20) });
  } catch (_) { /* storage unavailable — continue with memory-only */ }
}

// ── Server message handlers ─────────────────────────────────────────────

// ── Protocol validation guards (lightweight, no Zod) ────────────────────
const PROTO_VERSION = 1;
const SUPPORTED_SERVER_TYPES = new Set(["list_ai_tabs", "list_all_tabs", "get_chat", "get_page", "get_artifacts", "send_message"]);
const MAX_REQ_ID = 128;

function validateServerMessage(msg) {
  if (!msg || typeof msg !== "object" || Array.isArray(msg)) {
    console.warn("[ChatLink] Invalid server message: not a plain object");
    return false;
  }
  if (msg.protocolVersion !== undefined && msg.protocolVersion !== PROTO_VERSION) {
    console.warn("[ChatLink] Protocol version mismatch:", msg.protocolVersion);
    return false;
  }
  if (typeof msg.type !== "string" || !SUPPORTED_SERVER_TYPES.has(msg.type)) {
    console.warn("[ChatLink] Unsupported message type:", msg.type);
    return false;
  }
  if (typeof msg.requestId !== "string" || msg.requestId.length > MAX_REQ_ID) {
    console.warn("[ChatLink] Invalid or oversized requestId");
    return false;
  }
  if (msg.type === "send_message") {
    if (typeof msg.text !== "string" || msg.text.length === 0) {
      console.warn("[ChatLink] send_message missing text");
      return false;
    }
    if (msg.confirmation !== undefined && msg.confirmation !== "dispatch" && msg.confirmation !== "confirmed") {
      console.warn("[ChatLink] Invalid confirmation value:", msg.confirmation);
      return false;
    }
  }
  if ((msg.type === "get_chat" || msg.type === "get_page" || msg.type === "get_artifacts") && msg.tabId !== undefined) {
    if (!Number.isInteger(msg.tabId) || msg.tabId <= 0) {
      console.warn("[ChatLink] Invalid tabId:", msg.tabId);
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
    case "list_ai_tabs":    return handleListAiTabs(msg.requestId);
    case "list_all_tabs":   return handleListAllTabs(msg.requestId);
    case "get_chat":        return handleGetContent(msg.requestId, msg.tabId, "chat", msg.sinceIndex);
    case "get_page":        return handleGetContent(msg.requestId, msg.tabId, "page");
    case "get_artifacts":   return handleGetArtifacts(msg.requestId, msg.tabId, msg.includeLinks ?? false, msg.maxLinks ?? 10);
    case "send_message":    return handleSendMessage(msg.requestId, msg.tabId, msg.text, msg.platform, msg.operationId, msg.confirmation);
    default:
      console.warn("[ChatLink] Unknown message type:", msg.type);
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

async function handleGetContent(requestId, targetTabId, mode, sinceIndex) {
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

    let result;
    if (mode === "chat") {
      // Content script is authoritative — has per-platform extractors, stop/busy/error detection
      await ensureContentScript(tab.id);
      result = await chrome.tabs.sendMessage(tab.id, { type: "EXTRACT_CHAT", sinceIndex: sinceIndex ?? 0 }).catch(() => null);
    } else {
      // Content script also handles generic page extraction
      await ensureContentScript(tab.id);
      result = await chrome.tabs.sendMessage(tab.id, { type: "EXTRACT_PAGE" }).catch(() => null);
    }
    if (!result) { sendError(requestId, "background.get_content.content_script", "No response from content script."); return; }
    if (result.error) { sendError(requestId, "background.get_content.content_script", result.error); return; }

    const host = parseHostname(tab.url);
    const platform = PLATFORM_NAMES[host] ?? host ?? "Unknown";

    if (result.type === "page") {
      send({ type: "page_result", requestId, content: { tabId: tab.id, platform, url: result.url, title: result.title, text: result.text, extractedAt: result.extractedAt } });
    } else {
      send({ type: "chat_result", requestId, content: { tabId: tab.id, platform: result.platform ?? platform, url: result.url, title: result.title, messages: result.messages, extractedAt: result.extractedAt, isGenerating: result.isGenerating, errorState: result.errorState, totalMessageCount: result.totalMessageCount, extractionMeta: result.extractionMeta } });
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

// extractChatInline removed — content script extractor.js is now authoritative for chat extraction

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
