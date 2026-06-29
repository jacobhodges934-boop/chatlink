# ChatLink 安装指南

3 分钟把 ChatLink 跑起来，支持 **Claude Code / OpenCode / Cursor**。

## 前提

- Node.js 18+
- Chrome 116+ 或 Edge 116+
- 至少一个 AI 对话标签页已登录（ChatGPT / Gemini / DeepSeek / Grok 等）

## 一键安装

### Windows（PowerShell）：

```powershell
# Claude Code
.\scripts\install.ps1

# OpenCode
.\scripts\install.ps1 -Client opencode

# Cursor
.\scripts\install.ps1 -Client cursor
```

### macOS / Linux：

```bash
# Claude Code
bash scripts/install.sh

# OpenCode
bash scripts/install.sh --client opencode

# Cursor
bash scripts/install.sh --client cursor
```

脚本自动完成：环境检测 → 安装依赖 → 构建 → 写入 MCP 配置 → 打开扩展管理页面。

## 手动安装

### 第一步：构建 MCP Server

```bash
git clone https://github.com/jacobhodges934-boop/chatlink.git
cd chatlink/mcp-server
npm install
npm run build
```

### 第二步：加载扩展

**Chrome** — 打开 `chrome://extensions` → 开启**开发者模式** → **加载已解压的扩展程序** → 选择 `chrome-extension` 文件夹

**Edge** — 打开 `edge://extensions` → 开启**开发人员模式** → **加载解压缩的扩展** → 选择 `chrome-extension` 文件夹

> 同一时间只有一个浏览器能连接到 ChatLink。

### 第三步：配置 AI Coding Agent

**Claude Code：**
```bash
claude mcp add chatlink -- node "/path/to/chatlink/mcp-server/dist/index.js"
```

**OpenCode** — 写入 `~/.config/opencode/opencode.json`：
```json
{
  "mcpServers": {
    "chatlink": {
      "type": "local",
      "command": "node",
      "args": ["/path/to/chatlink/mcp-server/dist/index.js"]
    }
  }
}
```

**Cursor** — 写入 `~/.cursor/mcp.json`（Windows: `%USERPROFILE%\.cursor\mcp.json`）：
```json
{
  "mcpServers": {
    "chatlink": {
      "command": "node",
      "args": ["/path/to/chatlink/mcp-server/dist/index.js"]
    }
  }
}
```

### 第四步：验证

重启 coding agent，然后：

```
使用 ChatLink 检查扩展状态
用 ChatLink 列出我当前打开的 AI 标签页
```

## 常见问题

| 问题 | 解决 |
|------|------|
| 扩展显示 OFF | 刷新 AI 标签页，或重新加载扩展 |
| MCP 工具不可用 | 确认已重启 agent，检查 MCP 配置路径是否正确 |
| 发送消息失败 | 确认 AI 网站已登录且输入框可见 |
| 端口被占用 | 关闭其他 ChatLink 进程 |

## 更新

```bash
git pull
cd mcp-server && npm run build
```

然后在 `chrome://extensions` / `edge://extensions` 刷新扩展，并刷新 AI 标签页。
