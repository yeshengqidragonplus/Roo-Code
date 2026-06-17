# QCode 调试模式（Agent Loop 单步调试器）设计文档

> 状态：设计已确认，待实现。本文件同时是开发进度跟踪表 —— 每完成一个阶段就更新底部的「阶段与完成情况」。随时可停下，随时可凭本文件继续。

## 1. 目标

在 QCode 侧边栏顶部工具栏（设置按钮旁）增加一个**调试按钮**。点击后按钮切换到激活态，进入**调试模式**。调试模式下，在工作区编辑区**新开一个独立的 Webview Panel**，作为完整的「Agent Loop 检查/单步调试」界面，让用户能：

- 看到每一轮 agent loop **发给大模型 API 的完整上下文**（system prompt + 全部消息 + metadata）。
- 看到**大模型的原始回复**。
- **单步调试**：在关键断点暂停 agent loop，等用户决定「继续运行」或「修改内容后继续」。
- 可编辑：发送前可改上下文，回复后可改模型输出，再继续。

## 2. 非目标

- 不替换现有的工具审批（tool approval）流程，调试断点与之共存。
- 不持久化调试会话（首版断点状态随任务/面板生命周期存在，不落盘）。
- 不引入 AI-SDK / 浏览器相关代码（遵循 fork 约束，见 CLAUDE.md）。

## 3. 现状基础（可复用 / 不可复用）

| 现有能力                                                      | 位置                                                                                                    | 对本功能的意义                                                                                         |
| ------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------ |
| `debug` 设置标志 + `openDebugApiHistory`/`openDebugUiHistory` | `src/core/webview/webviewMessageHandler.ts:2886`，`webview-ui/src/components/chat/TaskActions.tsx`      | 仅「事后导出 JSON」，**交互不可复用**；但证明「导出完整 API 上下文」的数据链路是通的，**数据可复用**。 |
| 视图标题栏按钮（铅笔/齿轮/历史/弹出）                         | `src/package.json:205` `view/title` 菜单                                                                | 调试按钮在此处新增；图标切换用 context key + `when` 互斥实现。                                         |
| `Task.ask()` 阻塞等待用户的 promise + `pWaitFor` 模式         | `src/core/task/Task.ts:1219`                                                                            | 单步「暂停—等继续/修改」直接照搬此模式。                                                               |
| 发送前断点位置                                                | `src/core/task/Task.ts:4167` `this.api.createMessage(systemPrompt, cleanConversationHistory, metadata)` | 此行之前可拿到完整 payload。                                                                           |
| 回复后断点位置                                                | `src/core/task/Task.ts:2735` 附近，流接收完、`presentAssistantMessage` 解析之前                         | 此处可拿到模型原始回复。                                                                               |
| 工具执行前断点位置                                            | `src/core/assistant-message/presentAssistantMessage.ts` 工具 switch 之前（约 `:59` 起）                 | 每个工具调用执行前可暂停。                                                                             |
| 弹出到新标签的 webview 机制                                   | `qcode.TabPanelProvider` / `popoutButtonClicked`                                                        | 调试 Panel 参考其 `createWebviewPanel` 写法。                                                          |

## 4. 架构概览

```
[视图标题栏 调试按钮] --command--> setContext qcode.debugMode = true/false
                                        │
                                        ▼ (通知 Task / 全局状态)
                          Task loop 检测 debugMode 标志：
                            断点A 发送前  → postMessage(debugPaused, payload) → 阻塞等
                            断点B 回复后  → postMessage(debugPaused, payload) → 阻塞等
                            断点C 工具前  → postMessage(debugPaused, payload) → 阻塞等
                                        │  ▲
                            debugContinue / debugEdit │
                                        ▼  │
        [工作区新开 Webview Panel(独立 tab) — Debug App(React)]
          展示：阶段 / system prompt / messages / metadata / 原始回复 / 即将执行的工具
          操作：继续 · 单步 · 编辑后继续
```

### 数据流（一次断点的生命周期）

1. Task loop 到达断点，构造 `DebugPausePayload`，调 `debugController.pause(stage, payload)`。
2. `pause()` 通过 `DebugPanelProvider` 向调试面板 `postMessage({ type: "debugPaused", ... })`，并 `await` 一个 promise（内部 `pWaitFor` 等待 resolve）。
3. 用户在面板点「继续」或「编辑后继续」，面板回发 `debugContinue` / `debugEdit`。
4. `webviewMessageHandler` 收到后调用 `debugController.resume(edited?)`，resolve promise。
5. Task loop 拿到（可能被编辑过的）内容，继续执行。

## 5. 详细设计

### 5.1 工具栏按钮与图标切换（阶段 1）

- `src/package.json`：
    - `contributes.commands` 新增 `qcode.enableDebugMode`（图2 调试图标）、`qcode.disableDebugMode`（图3 激活态图标）。图标资源放 `assets/icons/`。
    - `contributes.menus["view/title"]` 与 `editor/title` 各加两条，`group: "navigation@3"`：
        - `qcode.enableDebugMode`，`when: "view == qcode.SidebarProvider && !qcode.debugMode"`
        - `qcode.disableDebugMode`，`when: "view == qcode.SidebarProvider && qcode.debugMode"`
- 命令注册（`src/activate/` 下注册命令的地方）：执行时 `vscode.commands.executeCommand("setContext", "qcode.debugMode", next)`，更新全局调试状态，并在开启时打开/聚焦调试 Panel、关闭时清除挂起断点（自动 resume，避免 loop 卡死）。

### 5.2 调试 Webview Panel（阶段 2）

- 新建 `src/core/webview/DebugPanelProvider.ts`：
    - `createOrShow()`：`vscode.window.createWebviewPanel("qcode.DebugPanel", "QCode Debug", ViewColumn.Beside, {...})`，单例。
    - 持有 webview，提供 `postMessage()`；监听 `onDidReceiveMessage` 转交 `webviewMessageHandler`（或专用 debug handler）。
    - `onDidDispose`：清理并把 `qcode.debugMode` 关掉、resume 任何挂起断点。
- webview 前端：`webview-ui` 内新增 debug 入口（复用现有 Vite/消息总线 `vscode.postMessage`）。组件分区：
    - 顶部：当前阶段标识（发送前 / 回复后 / 工具前）、轮次、任务 ID。
    - 主体（可折叠分栏）：System Prompt / Messages（JSON 可编辑）/ Metadata（含 tools、tool_choice）/ 模型原始回复 / 即将执行的工具(名+参数)。
    - 底部操作栏：`继续`、`单步`、`编辑后继续`（编辑态下出现保存/还原）。

### 5.3 DebugController 与断点（阶段 3）

- 新建 `src/core/task/DebugController.ts`（或挂在 Task 上）：
    ```ts
    type DebugStage = "beforeRequest" | "afterResponse" | "beforeTool"
    interface DebugPausePayload {
    	stage: DebugStage
    	taskId: string
    	round: number
    	systemPrompt?: string
    	messages?: unknown // cleanConversationHistory
    	metadata?: unknown
    	assistantText?: string // afterResponse
    	tool?: { name: string; input: unknown } // beforeTool
    }
    class DebugController {
    	isEnabled(): boolean
    	async pause(payload): Promise<DebugResumeResult> // 内部 pWaitFor + promise
    	resume(result: DebugResumeResult): void // result 可含编辑后的字段
    	cancelAll(): void // 关闭调试模式时调用
    }
    ```
- 接入点：
    - **断点A**：`Task.ts:4167` 之前。若 `debug.isEnabled()`，`pause({stage:"beforeRequest", systemPrompt, messages: cleanConversationHistory, metadata})`，用返回值覆盖 `systemPrompt`/`cleanConversationHistory`/`metadata` 后再 `createMessage`。
    - **断点B**：`Task.ts:2735` 附近，流读取完整 assistant 内容后、`presentAssistantMessage` 之前，`pause({stage:"afterResponse", assistantText})`，用返回值覆盖再继续解析。
    - **断点C**：`presentAssistantMessage.ts` 每个工具 switch 执行前，`pause({stage:"beforeTool", tool})`。
- 性能：未开启调试时 `pause` 直接 return，零阻塞。

### 5.4 消息协议与编辑回写（阶段 4）

- `packages/types/src/vscode-extension-host.ts`：
    - `ExtensionMessage`（宿主→面板）新增 `debugPaused`（带 `DebugPausePayload`）、`debugResumed`、`debugModeChanged`。
    - `WebviewMessage`（面板→宿主）新增 `debugContinue`、`debugStep`、`debugEdit`（带编辑后的字段）。
- `webviewMessageHandler.ts`：新增对应 case，转调 `debugController.resume(...)`。
- **编辑回写一致性（最高风险点）**：
    - 发送前编辑 `messages`：仅影响本次 `createMessage` 入参，**不**直接改 `apiConversationHistory`（除非用户明确选择写回历史）；首版策略 = 只改本轮请求，历史保持原样，并在 UI 标注「本次编辑仅作用于本轮请求」。
    - 回复后编辑 `assistantText`：需同时更新写入 `apiConversationHistory` 的 assistant 消息，保证后续轮次一致。这里要加测试覆盖。

### 5.5 i18n 与测试（阶段 5）

- 文案：按钮 title、面板标题、阶段标签走 `webview-ui` i18n 与 `src/package.nls.*.json`。
- 测试（Vitest，`cd src && npx vitest run ...`）：
    - `DebugController` 的 pause/resume/cancelAll 阻塞与编辑回写。
    - 断点在 `debug` 关闭时零开销（不阻塞）。
    - 回复后编辑写回 `apiConversationHistory` 后下一轮一致。

## 6. 风险与对策

| 风险                                   | 对策                                           |
| -------------------------------------- | ---------------------------------------------- |
| 关闭调试模式或面板被关时 loop 卡在断点 | `cancelAll()`：自动 resume 所有挂起断点。      |
| 编辑回写破坏消息历史一致性             | 首版默认「仅作用本轮」；回复回写单独测试。     |
| 大 payload（长上下文）传输/渲染卡顿    | 面板内 JSON 懒渲染/折叠；必要时截断+「展开」。 |
| 与现有工具审批重复打断                 | 阶段 C 默认可在面板内关闭，避免与审批叠加。    |

## 7. 涉及文件清单（预估）

- `src/package.json`（命令 + 菜单 + 图标）
- `assets/icons/`（调试图标 ×2）
- `src/activate/`（命令注册 + setContext）
- `src/core/webview/DebugPanelProvider.ts`（新）
- `src/core/task/DebugController.ts`（新）
- `src/core/task/Task.ts`（断点 A、B 接入）
- `src/core/assistant-message/presentAssistantMessage.ts`（断点 C 接入）
- `src/core/webview/webviewMessageHandler.ts`（新消息 case）
- `packages/types/src/vscode-extension-host.ts`（消息类型）
- `webview-ui/src/`（调试 Panel React 入口 + 组件）
- i18n：`webview-ui` locales、`src/package.nls.*.json`
- 测试：`src/core/task/__tests__/`

---

## 7.5 已讨论但否决的需求（存档，避免重复讨论）

### 否决一：调试模式下手动按 profile 换模型 + 「心跳保温」缓存

- **当初想法**：在发送前断点提供「切换模型 profile」的能力——常规/简单任务交给本地免费小模型，复杂任务交给付费大模型以省 token。进一步想给每个会话里的每个模型维持一个极小的「5 分钟心跳」+ 模型相关前缀，让付费大模型的 prompt 缓存一直保温不过期。
- **手动换 profile 部分：技术上成立**（QCode 已有命名 API 配置档机制 `ProviderSettingsManager`），换模型不会丢上下文——每轮请求都把完整历史重发，新模型能看到全过程。这条本身合理，但**不在首版做**，留待后续可选增强。
- **「心跳保温」部分：明确否决。** 原因：
    1. **心跳无法「小」**。要刷新某段缓存的 TTL，必须重发能命中该前缀的完整请求（system prompt + 历史，可能几万 token），不能用几十 token 的小请求续期。
    2. **持续付费 > 一次性付费**。缓存读取按基础价 0.1 倍计，每 5 分钟保温一次，累计开销远超「真正切回大模型时付一次 1.25 倍缓存写入」。对「偶尔才用大模型」的场景，过期重建永远更划算。
    3. **省 token 的真正来源是「用免费本地模型干活」，不是「给大模型缓存保温」**。缓存只在连续高频调用同一模型时划算；大模型既然用得少，缓存对它收益本就微小，保温反而越优化越贵。
    4. **跨 provider 缓存本就自动隔离**，无需工程维护「模型相关前缀」。
    5. 若确有长时间不用大模型又怕缓存过期的顾虑，用官方 **1 小时 TTL 缓存**（`cache_control: {ttl: "1h"}`，写入价 2 倍）即可，不必自造心跳。
- **缓存失效的正确认知（备忘）**：① 时间过期（TTL 默认约 5 分钟，够快切回可规避）；② 前缀内容改变（从改动点起必然失效，与快慢无关）。单纯换模型只是往历史追加内容，不破坏前缀；真正会失效的是本设计「编辑上下文」功能改动了历史中靠前的消息。

## 8. 阶段与完成情况

> 图例：⬜ 未开始 · 🟡 进行中 · ✅ 完成

| 阶段 | 内容                                                                                | 状态 | 备注                                                                     |
| ---- | ----------------------------------------------------------------------------------- | ---- | ------------------------------------------------------------------------ |
| 1    | 工具栏调试按钮 + 图标激活态切换（context key / `when`）                             | ✅   | 命令/菜单/图标/状态单例已就位；类型检查、lint、registerCommands 测试通过 |
| 2    | 调试 Webview Panel（DebugPanelProvider + React 入口骨架，能打开空界面）             | ⬜   |                                                                          |
| 3    | DebugController + 三个断点接入（A 发送前 / B 回复后 / C 工具前），先做只读暂停-继续 | ⬜   |                                                                          |
| 4    | 消息协议 + 编辑回写（可编辑上下文与回复）                                           | ⬜   |                                                                          |
| 5    | i18n + 测试 + 边界（cancelAll、零开销、回写一致性）                                 | ⬜   |                                                                          |

### 变更日志

- 2026-06-17：创建设计文档，方案与三项关键决策已确认（新 Webview Panel / 三断点 / 可编辑上下文与回复）。
- 2026-06-17：新增「7.5 已讨论但否决的需求」——存档「手动换 profile + 心跳保温缓存」的讨论与否决理由（心跳否决；手动换 profile 留作后续可选）。开始阶段 1。
- 2026-06-17：✅ 阶段 1 完成。改动：`packages/types/src/vscode.ts`（commandIds 增 `enableDebugMode`/`disableDebugMode`）、`src/package.json`（命令+图标 `$(bug)`/`$(debug-stop)`、view/title 与 editor/title 菜单 navigation@3 互斥项）、`src/package.nls.json`（文案，其它 locale 暂回退英文，留待阶段 5）、新增 `src/core/debug/debugMode.ts`（debugMode 状态单例，set 时写 `qcode.debugMode` context key）、`src/activate/registerCommands.ts`（两个命令回调）。验证：types 构建、`tsc --noEmit`、eslint、registerCommands.spec 均通过。注：event emitter 因测试内联 vscode mock 未提供 EventEmitter 暂移除，阶段 3 需要时再加。
