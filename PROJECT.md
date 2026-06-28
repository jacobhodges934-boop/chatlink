# ChatMCP 双向通信增强版

基于 [IndianTinker/chatmcp](https://github.com/indiantinker/chatMCP) 的深度改造版本。

## 原版 vs 本版

| 功能 | 原版 | 本版 |
|------|------|------|
| 读取 AI 对话 | ✅ | ✅ |
| **发送消息到 AI 聊天框** | ❌ | ✅ |
| MutationObserver 性能确认 | ❌ | ✅ |
| dispatch/confirmed 双模式 | ❌ | ✅ |
| tab 串行队列防并发 | ❌ | ✅ |
| operationId 去重 | ❌ | ✅ |
| 优雅退出 + 端口自动回收 | ❌ | ✅ |
| 诊断页面 | ❌ | ✅ |
| 7 平台输入框选择器 | 只读提取器 | 读写双向 |

## 安装

```powershell
git clone https://github.com/jacobhodges934-boop/chatmcp.git
cd chatmcp/mcp-server
npm install && npm run build
```

MCP 注册（在 Claude Code 中）：
```
claude mcp add chatmcp -- node D:/文档/chatmcp/mcp-server/dist/index.js
```

Chrome 扩展：
1. `chrome://extensions` → 开发者模式
2. 加载已解压 → 选 `chrome-extension/` 文件夹

## 踩坑记录

### Bug 1: bridge.ts HTTP 回调拦截 WebSocket 升级
`createHttpServer(callback)` → Node.js 不触发 `upgrade` 事件 → WebSocket 握手被 404 拦截
**修复**: 改用 `server.on('upgrade', ...)` + `server.on('request', ...)`

### Bug 2: token 端点 Origin 检查过严
Chrome MV3 service worker 的 `fetch()` 到 localhost 不发送 `Origin` 头
**修复**: 只在 Origin 存在且不是 chrome-extension 时才拒绝

### Bug 3: `/reload-plugins` 不重启 MCP 进程
源码改动后编译，`/reload-plugins` 加载的是旧进程内存中的代码
**修复**: 手动杀旧进程 + `/reload-plugins`，或完全重启 Claude Code

### Bug 4: bash heredoc 吃掉反斜杠
通过 bash 写入 JS 代码时 `\s` `\r` `\n` 被解释
**修复**: 用 Write 工具或 Node.js 直接写文件，避免 bash 中转

### Bug 5: ESM 顶层 await 兼容性
`await` 在模块顶层时，`require()` 无法加载该模块
**修复**: 异步启动用 `Promise.resolve().then()` 替代顶层 await

## 预防故障的机制

1. **每次改完源码后测试**：
   ```powershell
   cd D:/文档/chatmcp/mcp-server
   npm run build
   node dist/index.js  # 应该看到 "ChatMCP MCP server running" 然后 Ctrl+C
   ```

2. **Git 保护**：每次稳定版本打 tag，出问题 `git checkout v1.x.x` 秒回滚

3. **双分支策略**：
   - `main` — 始终可用的稳定版
   - `dev` — 开发分支，坏了大不了切回 main

4. **./reload-plugins 不可靠**：大改后直接重启 Claude Code
