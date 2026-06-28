/**
 * ChatMCP background service worker.
 * Connects to the local MCP server via WebSocket and handles requests.
 * Modified: added chrome.storage.local diagnostics log system.
 */

const MCP_TOKEN_URL = "http://127.0.0.1:27182/token";
const MCP_SERVER_BASE = "ws://127.0.0.1:27182";
const RECONNECT_DELAY_MS = 3000;
const KEEPALIVE_ALARM = "chatmcp-keepalive";
const KEEPALIVE_PERIOD_MINUTES = 0.3; // ~18s — tighter keepalive
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
  } catch {}
}

async function clearDiagLog() {
  await chrome.storage.local.remove(["diagnostics", "lastConnected", "lastUpdate"]);
  await diagLog("init", "Diagnostics log started v" + VERSION);
}

// ── Keepalive alarm ─────────────────────────────────────────────────────
chrome.alarms.create(KEEPALIVE_ALARM, { periodInMinutes: KEEPALIVE_PERIOD_MINUTES });

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name !== KEEPALIVE_ALARM) return;
  diagLog("alarm", "keepalive fired, connected=" + connected);
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
  if (ws) { try { ws.close(); } catch {} ws = null; }
  await diagLog("connect", "attempting...");

  const token = await fetchToken();
  if (!token) { await diagLog("connect_fail", "no token, scheduling retry in " + RECONNECT_DELAY_MS + "ms"); scheduleReconnect(); return; }

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
    }, 20000);
  });

  ws.addEventListener("message", (event) => {
    let msg;
    try { msg = JSON.parse(event.data); } catch { return; }
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
  reconnectTimer = setTimeout(connect, RECONNECT_DELAY_MS);
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
async function handleServerMessage(msg) {
  switch (msg.type) {
    case "list_ai_tabs":    return handleListAiTabs(msg.requestId);
    case "list_all_tabs":   return handleListAllTabs(msg.requestId);
    case "get_chat":        return handleGetContent(msg.requestId, msg.tabId, "chat");
    case "get_page":        return handleGetContent(msg.requestId, msg.tabId, "page");
    case "get_artifacts":   return handleGetArtifacts(msg.requestId, msg.tabId, msg.includeLinks ?? false, msg.maxLinks ?? 10);
    case "send_message":    return handleSendMessage(msg.requestId, msg.tabId, msg.text, msg.platform, msg.operationId);
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
        let host = "";
        try { host = new URL(tab.url).hostname; } catch {}
        return { tabId: tab.id, url: tab.url, title: tab.title ?? "", platform: PLATFORM_NAMES[host] ?? "", active: tab.active, windowId: tab.windowId };
      });
    send({ type: "all_tabs_result", requestId, tabs });
  } catch (err) { send({ type: "error", requestId, message: err.message }); }
}

async function handleListAiTabs(requestId) {
  try {
    const allTabs = await chrome.tabs.query({});
    const aiTabs = allTabs.filter((tab) => {
      if (!tab.url) return false;
      try { return AI_HOSTNAMES.has(new URL(tab.url).hostname); } catch { return false; }
    }).map((tab) => {
      const host = new URL(tab.url).hostname;
      return { tabId: tab.id, url: tab.url, title: tab.title ?? "", platform: PLATFORM_NAMES[host] ?? host, active: tab.active, windowId: tab.windowId };
    });
    send({ type: "ai_tabs_result", requestId, tabs: aiTabs });
  } catch (err) { send({ type: "error", requestId, message: err.message }); }
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
        try { return AI_HOSTNAMES.has(new URL(t.url).hostname); } catch { return false; }
      });
      if (aiTabs.length === 0) { send({ type: "error", requestId, message: "No AI chat tabs are open." }); return; }
      tab = aiTabs.find((t) => t.active) ?? aiTabs[0];
    } else {
      const [activeTab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
      if (!activeTab) { send({ type: "error", requestId, message: "No active tab found." }); return; }
      tab = activeTab;
    }
    if (!tab?.id) { send({ type: "error", requestId, message: "Tab not found." }); return; }

    async function extract() {
      if (mode === "chat") return chrome.tabs.sendMessage(tab.id, { type: "EXTRACT_CHAT" });
      else {
        const injected = await chrome.scripting.executeScript({ target: { tabId: tab.id }, func: extractPageInline });
        return injected?.[0]?.result;
      }
    }

    let result = await extract().catch(() => null);
    if (!result && !tab.active) {
      await chrome.tabs.update(tab.id, { active: true });
      await chrome.windows.update(tab.windowId, { focused: true });
      await sleep(600);
      result = await extract().catch(() => null);
    }
    if (!result) { send({ type: "error", requestId, message: "No response from content script." }); return; }
    if (result.error) { send({ type: "error", requestId, message: result.error }); return; }

    const host = (() => { try { return new URL(tab.url).hostname; } catch { return ""; } })();
    const platform = PLATFORM_NAMES[host] ?? host ?? "Unknown";

    if (result.type === "page") {
      send({ type: "page_result", requestId, content: { tabId: tab.id, platform, url: result.url, title: result.title, text: result.text, extractedAt: result.extractedAt } });
    } else {
      send({ type: "chat_result", requestId, content: { tabId: tab.id, platform: result.platform ?? platform, url: result.url, title: result.title, messages: result.messages, extractedAt: result.extractedAt } });
    }
  } catch (err) { send({ type: "error", requestId, message: err.message }); }
}

async function handleGetArtifacts(requestId, targetTabId, includeLinks, maxLinks) {
  try {
    let tab;
    if (targetTabId) { tab = await chrome.tabs.get(targetTabId); }
    else {
      const allTabs = await chrome.tabs.query({});
      const claudeTabs = allTabs.filter((t) => { if (!t.url) return false; try { return new URL(t.url).hostname === "claude.ai"; } catch { return false; } });
      if (claudeTabs.length === 0) { send({ type: "error", requestId, message: "No claude.ai tabs are open." }); return; }
      tab = claudeTabs.find((t) => t.active) ?? claudeTabs[0];
    }
    if (!tab?.id) { send({ type: "error", requestId, message: "Tab not found." }); return; }
    let hostname = ""; try { hostname = new URL(tab.url).hostname; } catch {}
    if (hostname !== "claude.ai") { send({ type: "error", requestId, message: "Tab is on " + hostname + ", not claude.ai." }); return; }

    let result = await chrome.tabs.sendMessage(tab.id, { type: "EXTRACT_ARTIFACTS", includeLinks, maxLinks }).catch(() => null);
    if (!result && !tab.active) {
      await chrome.tabs.update(tab.id, { active: true });
      await chrome.windows.update(tab.windowId, { focused: true });
      await sleep(600);
      result = await chrome.tabs.sendMessage(tab.id, { type: "EXTRACT_ARTIFACTS", includeLinks, maxLinks }).catch(() => null);
    }
    if (!result) { send({ type: "error", requestId, message: "No response from content script." }); return; }
    if (result.error) { send({ type: "error", requestId, message: result.error }); return; }
    send({ type: "artifacts_result", requestId, content: { tabId: tab.id, platform: "Claude", url: result.url, title: result.title, artifacts: result.artifacts, count: result.count, extractedAt: result.extractedAt, note: result.note ?? null } });
  } catch (err) { send({ type: "error", requestId, message: err.message }); }
}

async function handleSendMessage(requestId, targetTabId, text, platform, operationId) {
  try {
    if (!text || typeof text !== "string" || text.trim().length === 0) {
      send({ type: "error", requestId, message: "No text provided to send." });
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
        send({ type: "error", requestId, message: "Target tab is not an AI chat page." }); return;
      }
    } else {
      const tabs = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
      tab = tabs.find(t => { try { return AI_HOSTNAMES.has(new URL(t.url).hostname); } catch { return false; } });
      if (!tab) {
        send({ type: "error", requestId, message: "No active AI chat tab. Open ChatGPT/Gemini/Claude first." }); return;
      }
    }
    if (!tab?.id) { send({ type: "error", requestId, message: "Tab not found." }); return; }

    if (!platform) {
      try { platform = PLATFORM_NAMES[new URL(tab.url).hostname]?.toLowerCase(); } catch {}
    }

    // Serial queue per tab — no auto-focus (just send via content script)
    const result = await enqueueTabSend(tab.id, async () => {
      try {
        return await chrome.tabs.sendMessage(tab.id, {
          type: "SEND_MESSAGE",
          text: text.trim(),
          platform,
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
      send({ type: "error", requestId, message: "No response from content script. Refresh the chat page and try again." });
      return;
    }
    if (result.error) {
      send({ type: "error", requestId, message: result.error });
      return;
    }

    const r = { success: !!(result.ok || result.success), sent: !!(result.sent ?? result.ok ?? result.success), platform: result.platform||result.site, method: result.method };
    if (operationId) setDedupResult(operationId, r);
    send({ type: "send_message_result", requestId, ...r });
  } catch (err) {
    send({ type: "error", requestId, message: err.message });
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
