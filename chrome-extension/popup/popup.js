const dot = document.getElementById("dot");
const statusText = document.getElementById("statusText");
const tabList = document.getElementById("tabList");
const refreshBtn = document.getElementById("refreshBtn");
const reconnectBtn = document.getElementById("reconnectBtn");

const AI_HOSTNAMES = new Set([
  "chat.openai.com",
  "chatgpt.com",
  "claude.ai",
  "gemini.google.com",
  "grok.com",
  "chat.deepseek.com",
  "chat.mistral.ai",
  "perplexity.ai",
  "www.perplexity.ai",
]);

const PLATFORM_NAMES = {
  "chat.openai.com": "ChatGPT",
  "chatgpt.com": "ChatGPT",
  "claude.ai": "Claude",
  "gemini.google.com": "Gemini",
  "grok.com": "Grok",
  "chat.deepseek.com": "DeepSeek",
  "chat.mistral.ai": "Mistral",
  "perplexity.ai": "Perplexity",
  "www.perplexity.ai": "Perplexity",
};

async function checkConnection() {
  // Ask the background service worker for its current connection state.
  // Do NOT open a WebSocket from the popup — it would steal the background's
  // client slot on the server and invalidate the real connection.
  try {
    const res = await chrome.runtime.sendMessage({ type: "get_status" });
    return Boolean(res?.connected);
  } catch {
    return false;
  }
}

async function loadTabs() {
  const tabs = await chrome.tabs.query({});
  const aiTabs = tabs.filter((tab) => {
    if (!tab.url) return false;
    try {
      return AI_HOSTNAMES.has(new URL(tab.url).hostname);
    } catch {
      return false;
    }
  });

  if (aiTabs.length === 0) {
    tabList.innerHTML = '<div class="empty-state">No AI chat tabs open</div>';
    return;
  }

  tabList.innerHTML = aiTabs
    .map((tab) => {
      const host = new URL(tab.url).hostname;
      const platform = PLATFORM_NAMES[host] ?? host;
      const title = tab.title?.replace(/ - (ChatGPT|Claude|Gemini|Grok|DeepSeek|Mistral).*/, "") ?? "";
      return `
        <div class="tab-item" data-tab-id="${tab.id}" data-window-id="${tab.windowId}">
          <span class="platform-badge">${platform}</span>
          <span class="tab-title" title="${tab.title}">${title || "Untitled"}</span>
          ${tab.active ? '<span class="active-indicator" title="Active tab"></span>' : ""}
        </div>
      `;
    })
    .join("");

  // Click to focus tab
  for (const item of tabList.querySelectorAll(".tab-item")) {
    item.addEventListener("click", async () => {
      const tabId = parseInt(item.dataset.tabId);
      const windowId = parseInt(item.dataset.windowId);
      await chrome.tabs.update(tabId, { active: true });
      await chrome.windows.update(windowId, { focused: true });
      window.close();
    });
  }
}

async function init() {
  const isConnected = await checkConnection();
  dot.className = `dot ${isConnected ? "connected" : "disconnected"}`;
  statusText.textContent = isConnected
    ? "MCP server connected"
    : "MCP server not running — start chatmcp-server";

  // Show Reconnect button only when disconnected
  reconnectBtn.disabled = isConnected;
  reconnectBtn.style.display = isConnected ? "none" : "inline-block";

  await loadTabs();
}

reconnectBtn.addEventListener("click", async () => {
  reconnectBtn.disabled = true;
  reconnectBtn.textContent = "Connecting…";
  try {
    await chrome.runtime.sendMessage({ type: "force_reconnect" });
  } catch { /* background may have been restarted */ }
  // Give it a moment then re-check
  setTimeout(async () => {
    await init();
    reconnectBtn.textContent = "Reconnect";
  }, 2000);
});

refreshBtn.addEventListener("click", loadTabs);
init();
