# ChatLink 项目

## MCP 工具使用铁律

- `delegate_coding_task` 的 `task` 参数**就是发给 AI 聊天的消息正文**，不是内部指令
- **轮询 GPT 回复** → 只用 `get_chat_context`（只读，无副作用）
- **发任务给 GPT** → 用 `delegate_coding_task` 或 `send_chat_message`
- **检查页面状态** → 用 `get_page_content`（只读）
- 🚫 绝对不要把 `delegate_coding_task` 当轮询/等待工具用——会往对话里塞垃圾消息，打断 AI 生成
