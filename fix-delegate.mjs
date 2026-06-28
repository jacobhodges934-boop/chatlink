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

        // Find working tab
        const tabs = await bridge.listAiTabs();
        const candidates = tabId
          ? tabs.filter(t => t.tabId === tabId)
          : tabs.filter(t => (t.platform || "").toLowerCase() === platform);
        if (candidates.length === 0) {
          return { content: [{ type: "text", text: "No " + platform + " tab found." }], isError: true };
        }

        let workingTab = candidates[0];
        for (const t of candidates.slice(0, 5)) {
          try {
            const r = await bridge.sendChatMessage(prompt, t.tabId, platform, "dispatch");
            if (r.success) { workingTab = t; break; }
          } catch { continue; }
        }

        // Simple wait-then-read approach: poll with progressive sleep until response stable
        const deadline = Date.now() + (timeout! * 1000);
        let prevLength = 0;
        while (Date.now() < deadline) {
          const wait = Math.min(5000, Math.max(2000, Math.floor((deadline - Date.now()) / 6)));
          await new Promise(r => setTimeout(r, wait));
          try {
            const chat = await bridge.getChat(workingTab.tabId);
            const total = chat.messages.length;
            if (total === prevLength && total > 0) {
              // Stable — return last assistant
              const assists = chat.messages.filter((m: any) => m.role === "assistant");
              if (assists.length > 0) {
                const last = assists[assists.length - 1].content;
                if (last.length > 10) {
                  return { content: [{ type: "text", text: "## Response from " + platform + "\\n\\n---\\n\\n" + last }] };
                }
              }
            }
            prevLength = total;
          } catch { continue; }
        }
        // Last attempt
        try {
          const chat = await bridge.getChat(workingTab.tabId);
          const assists = chat.messages.filter((m: any) => m.role === "assistant");
          if (assists.length > 0) {
            return { content: [{ type: "text", text: "## Response (final)\\n\\n---\\n\\n" + assists[assists.length - 1].content }] };
          }
        } catch {}
        return { content: [{ type: "text", text: "Timeout: no response in " + timeout + "s." }], isError: true };
      } catch (err) {
        return { content: [{ type: "text", text: "Error: " + ((err as Error).message || String(err)) }], isError: true };
      }
    }
  );
`;
s = s.substring(0, start) + clean + s.substring(end);
writeFileSync("mcp-server/src/index.ts", s);
console.log("Fixed: stable total message count approach");
