# MCP 配置避坑指南（Q-Code / Roo Code）

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

## 5. 配置文件位置

全局 MCP 配置：`<globalStorage>/qcode.qcode/settings/mcp_settings.json`（Windows 下为 `%APPDATA%/Code/User/globalStorage/qcode.qcode/settings/mcp_settings.json`）。修改后 [`watchMcpSettingsFile`](src/services/mcp/McpHub.ts:168) 会自动检测变更并重连，无需重启。
