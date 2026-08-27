# MCP 配置避坑指南（Q-Code / Roo Code）

## ⚠️ 本机真实配置位置是 D:\QCodeStorage（2026-08-27 确认）

**最重要的避坑点**：QCode fork 有 `customStoragePath` 设置（`src/utils/storage.ts` 的 `getStorageBasePath()`，读取 VS Code 设置 `qcode.customStoragePath`），设置后 settings/tasks/cache 全部重定向。

**本机已配置重定向到 `D:\QCodeStorage`**，所以：

- ✅ 真实 MCP 配置：`D:\QCodeStorage\settings\mcp_settings.json`
- ❌ `%APPDATA%/Code/User/globalStorage/qcode.qcode/settings/mcp_settings.json` **不是**扩展实际读取的位置（C 盘 globalStorage 里只剩 tasks/ 空壳是正常的，不是数据丢失）

排查 MCP 问题前先确认 `qcode.customStoragePath` 是否生效，否则会改错文件。

## 0. MCP 面板为空的排查路径（2026-08-27 实战记录）

本次 "CoderGraph MCP 消失" 的真正原因：`D:\QCodeStorage\settings\mcp_settings.json` 内容为空 `{"mcpServers": {}}`（何时被清空未知）。修复：直接把 server 配置写回该文件，`watchMcpSettingsFile`（McpHub.ts）监听 onDidChange/onDidCreate 会自动重连，无需重启 VS Code；若面板未刷新可点"刷新 MCP 服务器"按钮。

## 1. 合法的 server type 只有三种

`mcp_settings.json` 里 `type` 字段只接受：`stdio`、`sse`、`streamable-http`。
**`"http"` 不是合法值**，会被 [`validateServerConfig`](src/services/mcp/McpHub.ts:236) 直接拒绝并抛 `Server type must be 'stdio', 'sse', or 'streamable-http'`。

- `stdio`：本地命令行进程（有 `command`/`args`/`env`）
- `sse`：旧版 HTTP 传输，GET 建 SSE 长连接拿 endpoint，再 POST（用 `SSEClientTransport`）
- `streamable-http`：新版 HTTP 传输，直接对 `url` 发 POST JSON-RPC（用 `StreamableHTTPClientTransport`），响应是普通 JSON

## 2. streamable-http 的 url 必须指向具体端点，不是根路径

`StreamableHTTPClientTransport`（[`McpHub.ts:783`](src/services/mcp/McpHub.ts:783)）直接对配置的 `url` 发 POST。如果服务端 MCP 端点在 `/mcp` 而配置写根路径 `/`，会得到 `HTTP 404 {"error":"Not found"}`。**端点路径必须与服务端实际注册的路由一致**（常见 `/mcp`、`/sse`、`/messages`）。

排查方法：用 curl 对候选路径发 POST initialize 请求，看是否返回 `200` + JSON-RPC 响应。

## 3. alwaysAllow 用精确字符串匹配，不剥离前缀

[`McpHub.ts:1029`](src/services/mcp/McpHub.ts:1029) 的匹配逻辑是 `alwaysAllowConfig.includes(tool.name)`，而 [`normalizeForComparison`](src/utils/mcp-name.ts:27) 只做连字符→下划线转换，**不剥离模块前缀**。

所以配置里写 `get_current_scene` 无法匹配服务端实际工具名 `scene_get_current_scene`。**alwaysAllow 里的名字必须与服务端 `tools/list` 返回的 `name` 字段完全一致**（连字符/下划线可互换，但前缀不能省）。

## 4. alwaysAllow 还需配合全局开关 alwaysAllowMcp

[`auto-approval/mcp.ts`](src/core/auto-approval/mcp.ts:6) 判断逻辑：`state.alwaysAllowMcp === true && isMcpToolAlwaysAllowed(...)`。`alwaysAllow`（per-server 白名单）和 `alwaysAllowMcp`（全局总开关）必须同时开启，工具才会真正免确认执行。

## 5. stdio 命令在 Windows 上会被 cmd.exe 自动包装

[McpHub.ts:758](src/services/mcp/McpHub.ts:758)：Windows 下 stdio server 的 `command` 会被自动包成 `cmd.exe /c <command> <args>`，所以配置里直接写 `codegraph` 这类 `.cmd` shim 命令名即可，无需自己包装。

## 6. CodeGraph MCP 的标准配置

npm 包 `@colbymchenry/codegraph`（全局安装，bin 为 `codegraph`），MCP 启动方式为 `codegraph serve --mcp`。注意：工作区无 `.codegraph/` 索引时 server 以 inactive 状态连接且不提供工具，需先 `codegraph init`。
