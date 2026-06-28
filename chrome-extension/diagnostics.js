async function refresh() {
  const data = await chrome.storage.local.get(["diagnostics","lastConnected","lastUpdate"]);
  const logs = data.diagnostics || [];
  const bar = document.getElementById("statusBar");
  const connected = data.lastConnected;
  bar.textContent = connected ? "CONNECTED" : "NOT CONNECTED";
  bar.className = "status " + (connected ? "connected" : "disconnected");
  document.getElementById("metaInfo").textContent = "Last update: " + (data.lastUpdate ? new Date(data.lastUpdate).toLocaleString() : "never") + " | Log entries: " + logs.length;
  const lc = document.getElementById("logContent");
  if (!logs.length) { lc.innerHTML = '<div class="log-entry info">No log entries yet. The service worker may be starting up.</div>'; return; }
  lc.innerHTML = logs.slice().reverse().map(function(l) {
    var cls = l.event.includes("error") || l.event.includes("fail") ? "error"
              : l.event.includes("ok") || l.event.includes("open") ? "ok"
              : l.event.includes("close") ? "warn" : "info";
    return '<div class="log-entry ' + cls + '"><b>' + l.ts.slice(11,19) + '</b> [' + l.event + '] ' + escapeHtml(l.detail) + '</div>';
  }).join("");
}

async function reconnect() {
  try { await chrome.runtime.sendMessage({type:"force_reconnect"}); }
  catch(e) { console.error(e); }
  setTimeout(refresh, 2000);
}

async function clearLogs() {
  await chrome.storage.local.remove(["diagnostics","lastConnected","lastUpdate"]);
  refresh();
}

function escapeHtml(s) { var d = document.createElement("div"); d.textContent = s; return d.innerHTML; }

refresh();
setInterval(refresh, 3000);
