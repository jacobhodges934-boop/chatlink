# ChatLink 安装指南

3 分钟把 ChatLink 跑起来。

## 前提

- Node.js 18 或更新版本
- Chrome 116+ 或 Edge 116+
- [Claude Code](https://claude.ai/code) 已安装
- 至少登录了一个 AI 对话网站（ChatGPT / Gemini / DeepSeek / Grok 等）

## 第一步：安装 MCP Server

```bash
git clone https://github.com/jacobhodges934-boop/chatlink.git
cd chatlink/mcp-server
npm install
npm run build
```

## 第二步：加载扩展

### Chrome

1. 打开 `chrome://extensions`
2. 右上角开启 **开发者模式**
3. 点击 **加载已解压的扩展程序**
4. 选择仓库中的 `chrome-extension` 文件夹
5. 打开一个 AI 对话标签页
6. 确认扩展图标显示 **ON**

### Edge

1. 打开 `edge://extensions`
2. 左侧开启 **开发人员模式**
3. 点击 **加载解压缩的扩展**
4. 选择仓库中的 `chrome-extension` 文件夹
5. 打开一个 AI 对话标签页
6. 确认扩展图标显示 **ON**

> **注意**：同一时间只能有一个浏览器（Chrome 或 Edge）连接到 ChatLink。如需切换，关闭当前浏览器再打开另一个即可。

## 第三步：注册到 Claude Code

**Windows PowerShell：**

```powershell
claude mcp add chatlink -- node "完整路径\chatlink\mcp-server\dist\index.js"
```

**macOS / Linux：**

```bash
claude mcp add chatlink -- node "/完整路径/chatlink/mcp-server/dist/index.js"
```

重启 Claude Code。

## 第四步：验证

在 Claude Code 中输入：

```
使用 ChatLink 检查扩展状态
```

返回 `connected` 即成功。然后试试：

```
用 ChatLink 列出我当前打开的 AI 标签页
```

---

## 自动安装（推荐）

运行项目自带的安装脚本：

**Windows（PowerShell）：**

```powershell
.\scripts\install.ps1
```

**macOS / Linux：**

```bash
bash scripts/install.sh
```

脚本会自动完成：环境检测 → 安装依赖 → 构建 → 注册 Claude Code → 打开扩展管理页面。

## 常见问题

| 问题 | 解决 |
|------|------|
| 扩展显示 OFF | 刷新 AI 标签页，或从 `chrome://extensions` / `edge://extensions` 重新加载扩展 |
| Claude Code 命令无响应 | 检查是否已重启 Claude Code，`claude mcp list` 确认 chatlink 已注册 |
| 发送消息失败 | 确认 AI 网站已登录且输入框可见 |
| 端口被占用 | 关闭其他 ChatLink MCP Server 进程 |
| Edge 下部分 API 不工作 | Edge 版本需 ≥ 116，确认 `edge://version` 中 Chromium 版本 |

## 更新

拉取最新代码后重建：

```bash
git pull
cd mcp-server && npm run build
```

然后在 `chrome://extensions` / `edge://extensions` 点击 ChatLink 的刷新按钮，并刷新已打开的 AI 标签页。
