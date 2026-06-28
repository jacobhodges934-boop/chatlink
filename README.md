# ChatLink

让 Claude Code 直接读写 ChatGPT、Gemini、Claude、DeepSeek、Grok、Mistral、Perplexity 的网页对话。

你的浏览器里开着 AI 聊天页面，Claude Code 通过 ChatLink 自动读写——不用复制粘贴，不烧 API 费用，吃的是你已有的网页订阅额度。

## 怎么工作

```
Chrome 标签页（ChatGPT/Gemini/Claude...）
    ↕ DOM 读写
Chrome 扩展
    ↕ WebSocket
MCP Server
    ↕ stdio
Claude Code
```

## 安装

```powershell
git clone https://github.com/jacobhodges934-boop/chatlink.git
cd chatlink/mcp-server
npm install && npm run build
```

### 注册 MCP 服务器

```powershell
claude mcp add chatlink -- node D:/文档/chatlink/mcp-server/dist/index.js
```

### 安装 Chrome 扩展

1. `chrome://extensions` → 右上角打开「开发者模式」
2. 「加载已解压的扩展程序」→ 选择 `chrome-extension/` 文件夹
3. 打开 chatgpt.com，确认扩展图标显示 **ON**

## 工具

| 工具 | 用途 |
|------|------|
| `list_ai_tabs` | 列出所有 AI 聊天标签页 |
| `get_chat_context` | 拉取完整对话记录 |
| `send_chat_message` | 向 AI 聊天框输入并发送 |
| `get_page_content` | 读取任意网页正文 |
| `get_claude_artifacts` | 提取 Claude.ai artifacts |
| `list_tabs` | 列出所有标签页 |
| `extension_status` | 检查连接状态 |

## License

MIT
