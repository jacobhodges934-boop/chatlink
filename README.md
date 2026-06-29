# ChatLink

让 Claude Code 直接读写 AI 网页对话。支持 7 平台读取和发送（ChatGPT、Claude、Gemini、Grok、DeepSeek、Mistral、Perplexity）。

不烧 API 费用——用的是你浏览器里已有的网页订阅额度。

## 架构

```
Chrome 标签页（ChatGPT/Gemini/Claude...）
    ↕ DOM 读写（extractor.js — 平台适配器）
Chrome 扩展（background.js — Service Worker）
    ↕ WebSocket + Zod 校验（protocol.ts）
MCP Server（bridge.ts + index.ts）
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

> **注意：** 修改扩展代码后，如果内容脚本不更新，需要**完全卸载扩展再重新加载**（Chrome 刷新按钮不保证 content script 热更新）。

## 工具

| 工具 | 用途 |
|------|------|
| `delegate_coding_task` | **核心工具** — 发任务到 AI 聊天，等待完整回复。一次调用搞定 找标签→发消息→等完成→返回 |
| `list_ai_tabs` | 列出所有 AI 聊天标签页 |
| `get_chat_context` | 拉取完整对话记录 |
| `send_chat_message` | 向 AI 聊天框输入并发送 |
| `get_page_content` | 读取任意网页正文 |
| `get_claude_artifacts` | 提取 Claude.ai artifacts |
| `list_tabs` | 列出所有标签页 |
| `extension_status` | 检查扩展连接状态 |

### delegate_coding_task 工作原理

```
发送任务 → 等待完成 → 返回结果

完成检测（按优先级）：
  1. explicit_end   — DOM 检测到 stop 按钮消失（~3-6s）
  2. content_stability — 回复文本稳定 3.5s（~5-10s）
  3. timeout         — 超时，返回部分内容 + isError
  
安全：所有返回值带 trust: "untrusted" 标记
```

## 开发

```powershell
cd mcp-server

# 构建
npm run build

# 测试（9 个单元测试）
npm test
```

## 项目结构

```
mcp-server/src/
  index.ts              # MCP 工具注册 + delegate_coding_task
  bridge.ts             # WebSocket 桥接 + Zod 运行时校验
  protocol.ts           # Zod schemas（消息类型 + 响应类型）
  completion-tracker.ts # 完成状态机（纯函数）
  config.ts             # 集中时序配置
  types.ts              # 错误类型

chrome-extension/
  background.js         # Service Worker + 消息路由
  content-scripts/
    extractor.js        # 平台适配器（7 平台 × Tier1/2/3 提取）
  popup/                # 弹出窗口
  diagnostics.html      # 诊断面板
```

## 配置

时序参数集中在 `mcp-server/src/config.ts`（服务端）和 `background.js` 顶部（扩展端）。按需调整即可，不需要散落修改。

## 故障排除

| 症状 | 解决 |
|------|------|
| NOT CONNECTED | 重启 Claude Code |
| 内容脚本不更新 | 卸载扩展 → 重新加载 |
| delegate 超时 | 检查 ChatGPT 页面是否在对话中（非登录页） |
| 平台返回 unknown | 刷新 ChatGPT 页面（ensureContentScript 会自动注入） |

## License

MIT
