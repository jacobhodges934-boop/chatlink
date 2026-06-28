import { readFileSync, writeFileSync } from "fs";
let s = readFileSync("mcp-server/src/index.ts", "utf8");
const start = s.indexOf("  // ── delegate_coding_task");
const end = s.indexOf("\n// ── Port ownership & lifecycle management");

const clean = `  // ── delegate_coding_task ──────────────────────────────────────────────────
  server.tool(
    "delegate_coding_task",
    "Send a coding task to an AI chat, wait for complete response, return only the new assistant reply. Combines find-tab + send + poll + read into one call.",
    {
      platform: z.enum(["chatgpt","gemini","claude","deepseek","grok"]).describe("AI platform to target"),
      task: z.string().min(1).describe("The coding task. Be specific about files and expected output."),
      tabId: z.number().optional().describe("Specific tab ID. Omit to auto-select by platform."),
      context: z.string().optional().describe("Optional context: file contents, error logs, git diff."),
      timeout: z.number().optional().default(120).describe("Max seconds to wait for response."),
    },
    async ({ platform, task, tabId, context, timeout }) => {
      if (!bridge.isConnected()) {
        return { content: [{ type: "text", text: "ChatLink extension not connected." }], isError: true };
      }
      try {
        let prompt = task;
        if (context) prompt = "## Context\\n\\n" + context + "\\n\\n## Task\\n\\n" + task;
        const tabs = await bridge.listAiTabs();
        const candidates = tabId
          ? tabs.filter(t => t.tabId === tabId)
          : tabs.filter(t => (t.platform || "").toLowerCase() === platform);
        if (candidates.length === 0) {
          return { content: [{ type: "text", text: "No " + platform + " tab found." }], isError: true };
        }
        let targetTab = candidates[0];
        let sent = false;
        for (const t of candidates.slice(0, 3)) {
          try {
            const r = await bridge.sendChatMessage(prompt, t.tabId, platform, "dispatch");
            if (r && r.success) { targetTab = t; sent = true; break; }
          } catch(e) { return { content: [{ type: "text", text: "Send error: "+(e?.message||e) }], isError: true }; }
        }
        if (!sent) {
          return { content: [{ type: "text", text: "Failed to send." }], isError: true };
        }
        // Wait
        await new Promise(r => setTimeout(r, Math.min((timeout! * 1000 * 0.7), 25000)));
        // Diagnosis: dump raw chat data
        try {
          const chat = await bridge.getChat(targetTab.tabId);
          const diag = JSON.stringify({ totalMsgs: chat.messages.length, sampleRoles: chat.messages.slice(-3).map(m=>m.role), sampleContent: chat.messages.slice(-1).map(m=>(m.content||'').slice(0,50)) });
          return { content: [{ type: "text", text: "DIAGNOSIS: " + diag }] };
        } catch(e) {
          return { content: [{ type: "text", text: "getChat error: "+(e?.message||e) }], isError: true };
        }
      } catch (err) {
        return { content: [{ type: "text", text: "Error: " + ((err as Error).message || String(err)) }], isError: true };
      }
    }
  );
}
// ── Port ownership & lifecycle management`;
s = s.substring(0, start) + clean + s.substring(end);
writeFileSync("mcp-server/src/index.ts", s);
console.log("Diagnostic version");
