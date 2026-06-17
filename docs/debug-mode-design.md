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

> **设计微调（已落地）**：面板**不**复用 webview-ui 那套完整 React/Vite 应用，也不再起第二套 React 构建，而是用 **`DebugPanelProvider` 自带的轻量 HTML + 内联脚本消息桥**。理由：调试面板需求朴素（渲染 JSON、几个按钮、单步），自带 HTML 更自包含、改动面小、可独立演进，无需动 webview-ui 打包链。位置放在 `src/core/debug/DebugPanelProvider.ts`（与 `debugMode.ts` 同目录），而非原计划的 `src/core/webview/`。

- `DebugPanelProvider.ts`：
    - `createOrShow(extensionUri)`：`createWebviewPanel("qcode.DebugPanel", "QCode Debug", ViewColumn.Beside, {...})`，进程内单例；已存在则 `reveal`。
    - `postMessage()` 向面板发消息；`onDidReceiveMessage` 收 `debugReady`（阶段 3/4 在此路由 `debugContinue`/`debugStep`/`debugEdit` 到 DebugController）。
    - `onDidDispose`：清理并 `debugMode.set(false)`（关面板=退出调试模式）。`close()` 供退出命令调用。
    - HTML：复用 `getNonce` + CSP + codicons；骨架含 顶部阶段栏(bug 图标 + Continue/Step 按钮，当前 disabled) + 可折叠分区(System Prompt / Messages / Metadata / Assistant Reply / Pending Tool，均占位)。
- 命令接线：`enableDebugMode` → `set(true)` + `createOrShow`；`disableDebugMode` → `set(false)` + `close`。
- 阶段 4 在此 HTML 上长出：编辑态、保存/还原、JSON 填充。

### 5.3 DebugController 与断点（阶段 3）

> **关键发现（已落地）**：本 fork 的回复是**边流式接收边内联执行工具**的（`presentAssistantMessage` 在流循环中被多次调用，工具在流中途就执行）。因此**不存在「完整回复收到、且工具都还没执行」的干净时机**——流到一半工具就跑了。
>
> **三个断点**（最初想砍掉 afterResponse，但用户验证时发现「纯文字回复看不到、没进调试步骤」，故补回）：
>
> - **断点A `beforeRequest`** — 发送前，看/改完整出站 payload。
> - **断点B `afterResponse`** — `Task.ts` `didCompleteReadingStream = true` 之后，流读完、`assistantMessage` 完整时暂停。**这是纯文字回复（无工具）唯一会触发的断点**，保证「回复也进入调试 loop」。注意：流中途已完成的工具可能已经跑过（并已触发过自己的 C），所以 B 语义是「模型话说完了」，不保证在工具之前。
> - **断点C `beforeTool`** — 每个完整工具执行前暂停（用户要的「动手前等我」）。
>
> 失败的请求走 `catch`（约 `Task.ts:3146`），不会到 B/C —— 故 provider 报错时调试面板不暂停（这是合理的；错误展示是后续可选增强）。

- 新建 `src/core/debug/DebugController.ts`（与 `debugMode.ts`/`DebugPanelProvider.ts` 同目录，非原写的 `task/`）：
    ```ts
    type DebugStage = "beforeRequest" | "afterResponse" | "beforeTool"
    interface DebugPausePayload {
    	stage
    	taskId
    	systemPrompt?
    	messages?
    	metadata?
    	assistantText?
    	tool?
    }
    interface DebugResumeResult {
    	systemPrompt?
    	messages?
    	metadata?
    	assistantText?
    } // 阶段4 才填
    class DebugController {
    	isEnabled() // = debugMode.isEnabled()
    	async pause(payload): DebugResumeResult // 关闭/无面板时立即返回 {}（零开销）；否则 postMessage + 阻塞等 resume
    	resume(result = {}) // resolve 当前挂起断点（+ 发 debugResumed）
    	cancelAll() // 释放挂起断点，防 loop 卡死
    }
    ```
- 接入点（均「未开启零开销」）：
    - **断点A**：`Task.ts` `createMessage` 调用前。`const r = await debugController.pause({stage:"beforeRequest", systemPrompt, messages: cleanConversationHistory, metadata})`，再以 `r.systemPrompt ?? systemPrompt` 等覆盖入参（阶段3 r 恒为空，覆盖路径为阶段4 预埋）。
    - **断点C**：`presentAssistantMessage.ts` `switch (block.name)` 之前，`if (!block.partial)` 内。`pause({stage:"beforeTool", taskId, assistantText, tool:{name:block.name, input:block.params}})`。
- 面板接线：`onDidReceiveMessage` 收 `debugContinue`/`debugStep` → `debugController.resume()`；HTML 在 `debugPaused` 时填充各分区、启用 Continue/Step，`debugResumed` 时禁用。
- 防卡死：退出命令 `disableDebugMode` 与面板 `onDidDispose` 均调 `cancelAll()`。
- 阶段3 范围：**只读暂停-继续**（Step 暂等同 Continue，即跑到下一个断点）；编辑回写留阶段4。

### 5.4 编辑回写（阶段 4，已落地）

> **实现微调**：因面板是自带 HTML（非 webview-ui React，见 5.2），消息协议**没有**走 `packages/types` 的 `ExtensionMessage`/`WebviewMessage` 联合类型，而是 `DebugPanelProvider` 内部的私有协议（`debugPaused`/`debugResumed` ↓，`debugContinue`/`debugStep` ↑）。`debugEdit` 合并进 `debugContinue`/`debugStep` 的 `result` 字段，不单独设。类型 `DebugResumeResult` 定义在 `DebugController.ts`。

- **面板 UI**：各分区由 `<pre>` 改为 `<textarea>`。按阶段决定哪些可编辑（其余 readonly + 置灰）：
    - `beforeRequest` → System Prompt(text) / Messages(json) / Metadata(json)
    - `afterResponse` → Assistant Reply(text)
    - `beforeTool` → Pending Tool(json，含 name+input)
    - 可编辑分区标 `editable` 徽标并自动展开；Messages 上方注明「仅作用于本轮请求」。
- **采集/校验**：点 Continue/Step 时只采集**真正改过**的分区（与服务端原值比对）；json 分区 `JSON.parse`，失败则高亮该框 + 顶部红条报错且**不继续**。结果只含被改字段，未改字段缺省 → loop 用原值。
- **回写语义**：
    - System Prompt / Messages / Metadata（断点A）：经 `r.x ?? 原值` 覆盖**本次 `createMessage` 入参**，**不**改 `apiConversationHistory`（首版策略，UI 已标注）。
    - Assistant Reply（断点B）：`assistantMessage = r.assistantText`，**会**流入随后写进 `apiConversationHistory` 的 assistant 消息，保证后续轮次一致。
    - Pending Tool（断点C）：仅把 `input` 覆盖到 `block.params`，**让工具以编辑后的入参执行**；`name` 不改。注意历史里记录的仍是原始入参（首版可接受的小不一致）。
- **协议**：`resume(result)` 透传 `DebugResumeResult`；未改时 `result = {}`，行为与阶段3 一致。
- 测试覆盖留阶段5。

### 5.5 测试 / 多语言 / 边界打磨（阶段 5，已规划 · 暂缓）

> **决定（2026-06-17）**：阶段 1–4 的核心功能已全部完成且可用。以下三项已规划但**暂缓**，确认其余计划无遗留后再回来做。

- **测试**（Vitest，`cd src && npx vitest run ...`）：
    - `DebugController` 的 pause/resume/cancelAll：未开启零开销立即返回、开启阻塞到 resume、resume 透传编辑结果、cancelAll 防卡死。
    - 回写一致性：Assistant Reply 编辑后确实流入 `apiConversationHistory`，下一轮一致。
    - 断点在调试关闭时零开销（不阻塞）。
- **多语言 i18n**：按钮 title（`src/package.nls.*.json`）、面板内文案（阶段标签、Continue/Step、分区标题、提示）目前为硬编码英文，需本地化。优先级偏低（主要自用时英文够用）。
- **边界打磨**：多个连续断点、面板关闭后重开、调试中途切换任务/取消任务、超长上下文渲染性能等场景的健壮性复查。

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

| 阶段 | 内容                                                                                 | 状态 | 备注                                                                                                     |
| ---- | ------------------------------------------------------------------------------------ | ---- | -------------------------------------------------------------------------------------------------------- |
| 1    | 工具栏调试按钮 + 图标激活态切换（context key / `when`）                              | ✅   | 命令/菜单/图标/状态单例已就位；类型检查、lint、registerCommands 测试通过                                 |
| 2    | 调试 Webview Panel（DebugPanelProvider + 轻量 HTML 骨架，能打开空界面）              | ✅   | 改用自带 HTML（非第二套 React）；createOrShow/close + 命令接线；tsc/lint/测试通过；真机目检面板可弹出    |
| 3    | DebugController + 断点接入（A 发送前 / C 工具前；B 因边流边执行取消），只读暂停-继续 | ✅   | DebugController + 断点 A/C + 面板接线 + cancelAll 防卡死；tsc/lint/测试通过；真机目检留待                |
| 4    | 编辑回写（可编辑上下文/回复/工具入参）                                               | ✅   | textarea 按阶段可编辑 + JSON 校验；A 改本轮请求、B 回写历史、C 改工具入参；tsc/lint/测试通过；待真机目检 |
| 5    | 测试 + 多语言 + 边界打磨                                                             | ⏸️   | 已规划，**暂缓**（用户确认其余计划无遗留后再做）。详见 5.5                                               |

### 变更日志

- 2026-06-17：创建设计文档，方案与三项关键决策已确认（新 Webview Panel / 三断点 / 可编辑上下文与回复）。
- 2026-06-17：新增「7.5 已讨论但否决的需求」——存档「手动换 profile + 心跳保温缓存」的讨论与否决理由（心跳否决；手动换 profile 留作后续可选）。开始阶段 1。
- 2026-06-17：✅ 阶段 1 完成。改动：`packages/types/src/vscode.ts`（commandIds 增 `enableDebugMode`/`disableDebugMode`）、`src/package.json`（命令+图标 `$(bug)`/`$(debug-stop)`、view/title 与 editor/title 菜单 navigation@3 互斥项）、`src/package.nls.json`（文案，其它 locale 暂回退英文，留待阶段 5）、新增 `src/core/debug/debugMode.ts`（debugMode 状态单例，set 时写 `qcode.debugMode` context key）、`src/activate/registerCommands.ts`（两个命令回调）。验证：types 构建、`tsc --noEmit`、eslint、registerCommands.spec 均通过。注：event emitter 因测试内联 vscode mock 未提供 EventEmitter 暂移除，阶段 3 需要时再加。
- 2026-06-17：✅ 阶段 2 完成。新增 `src/core/debug/DebugPanelProvider.ts`（自带 HTML 的调试面板，单例 createOrShow/close，CSP+nonce+codicons，骨架分区 + Continue/Step 占位按钮 + debugReady 消息桥）；`registerCommands.ts` 两命令接线打开/关闭面板。设计微调：面板用轻量 HTML 而非第二套 React（理由见 5.2）。验证：tsc/eslint/registerCommands.spec 通过；真机目检面板可正常弹出。
- 2026-06-17：✅ 阶段 3 完成。**关键发现**：本 fork 边流式接收边内联执行工具，原「断点B 回复后/工具前」无干净时机，断点收敛为 A(beforeRequest)+C(beforeTool)，C 携带 assistantText 故也能看回复。新增 `src/core/debug/DebugController.ts`（pause/resume/cancelAll，未开启零开销）；`Task.ts` 接断点 A（createMessage 前，预埋覆盖路径）；`presentAssistantMessage.ts` 接断点 C（switch 前、!partial）；`DebugPanelProvider` 接 debugContinue/debugStep→resume、HTML 填充分区+启停按钮；退出命令与面板 dispose 均 cancelAll 防卡死。验证：tsc/eslint/registerCommands.spec 通过；真机目检留待。
- 2026-06-17：阶段3 修正（真机验证反馈）。用户发现纯文字回复（无工具）不触发任何断点、回复没进调试 loop。补回 **断点B `afterResponse`**：`Task.ts` 流读完(`didCompleteReadingStream=true`)后暂停，带 `assistantText`，并预埋编辑回写（`assistantMessage` 可被 resume 结果覆盖）。`DebugStage` 增 `afterResponse`，面板加 "After Response" 标签。说明：失败请求走 catch 不暂停。tsc/lint 通过。
- 2026-06-17：✅ 阶段 4 完成。面板各分区改 `<textarea>`，按阶段可编辑（A: SystemPrompt/Messages/Metadata；B: Assistant Reply；C: Pending Tool input），JSON 分区带 parse 校验+错误高亮，只采集改动字段。回写：A 覆盖本轮 createMessage 入参（不改历史）、B 经 assistantMessage 流入历史、C 把 input 覆盖到 block.params。`DebugResumeResult` 增 `tool`，`presentAssistantMessage` 应用工具入参编辑，`DebugPanelProvider` resume 透传 result。实现微调：协议走面板私有消息（非 packages/types 联合类型），`debugEdit` 并入 Continue/Step 的 result。tsc/lint/registerCommands.spec 通过；真机目检留待。
- 2026-06-17：阶段 1–4 核心功能全部完成、可用。阶段 5（测试 / 多语言 / 边界打磨）经用户决定**暂缓**，已在 5.5 与进度表记录，待其余计划确认无遗留后再回来做。
