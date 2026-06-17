# 内存占用优化方案（QCode / 继承自 Roo Code）

> 状态：进行中
> 负责：内存优化专项
> 范围：扩展宿主 `src/` 与 Webview UI `webview-ui/`

## 1. 背景

QCode 从 Roo Code 最后一个分支 fork 而来，继承了 Roo Code 系扩展长期存在的内存膨胀问题。
经过对扩展宿主（`src/`）和 Webview UI（`webview-ui/`）两侧的代码核查，确认内存膨胀由
**一个主因 + 若干独立泄漏**叠加造成。

## 2. 问题清单（已在代码中核实）

### 2.1 主因：会话历史「双重 + 全量」驻留内存

| 位置                                                                                                              | 问题                                                                                                                                                                                |
| ----------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| [`src/core/task/Task.ts:306-307`](../src/core/task/Task.ts)                                                       | `apiConversationHistory` 与 `clineMessages` 每个 API 轮次都 push，无上限。长任务下可累积数千条消息（含全文 + base64 图片）。condense 逻辑仅在撞到上下文上限时触发，内存本身不释放。 |
| [`webview-ui/src/context/ExtensionStateContext.tsx:181-182`](../webview-ui/src/context/ExtensionStateContext.tsx) | 同一份 `clineMessages` / `taskHistory` 在 Webview 侧用 React state 又复制一份。宿主与 webview 各存一份全文 + 图片。                                                                 |

效果：内存随任务长度线性增长，任务结束（实际是整个会话）前不释放。这是体感膨胀的主体。

### 2.2 已确认的独立泄漏

1. **Bedrock 缓存无上限** — [`src/api/providers/bedrock.ts:1163`](../src/api/providers/bedrock.ts)
   `previousCachePointPlacements` 以 `conversationId` 为键无限累积，无 TTL、无上限。纯泄漏（仅 Bedrock 路径）。
2. **`aggregatedCostsMap` 无上限** — [`webview-ui/src/components/chat/ChatView.tsx:164`](../webview-ui/src/components/chat/ChatView.tsx)
   每个子任务 ID 增加一条，从不清理。
3. **base64 图片驻留** — [`webview-ui/src/components/chat/ChatView.tsx:133`](../webview-ui/src/components/chat/ChatView.tsx) 等
   图片以 base64 字符串存于 state 和消息数组；单张截图 0.5–2MB，随消息数累积。
4. **每个 `ChatRow` 一个 window 监听器** — [`webview-ui/src/components/chat/ChatRow.tsx:194`](../webview-ui/src/components/chat/ChatRow.tsx)
   每条消息注册一个 `message` 监听器，1000 条消息＝1000 个监听器 + 闭包。

### 2.3 复核后判定为「非问题 / 已被高估」

- **TerminalRegistry** — [`src/integrations/terminal/TerminalRegistry.ts:293`](../src/integrations/terminal/TerminalRegistry.ts) 会过滤已关闭终端，受「打开中终端数」约束。
- **FileChangesPanel `finalContentByPath`** — [`webview-ui/src/components/chat/FileChangesPanel.tsx:30`](../webview-ui/src/components/chat/FileChangesPanel.tsx) 切换任务时重置，单任务内有界。
- **Virtuoso 保留全部 `visibleMessages`** — 虚拟滚动正常行为；问题归结到主因（数组长度）。

## 3. 优化方案（按阶段）

### 阶段 1 —— 低风险、见效快（独立泄漏修复）

- **1-A. Bedrock 缓存加上限**
  将裸 object `previousCachePointPlacements` 改为有界结构（零依赖的有界 Map / 简易 LRU，`max ≈ 50`）。扩展宿主无 `lru-cache` 依赖，采用手写有界 Map 避免引入新依赖。
- **1-B. `aggregatedCostsMap` 改 LRU**
  webview 已有 `lru-cache` 依赖，改为 `LRUCache`（`max ≈ 200`）。
- **1-C. 合并 `ChatRow` 的 window 监听器**
  实现采用更小改动、同等收益的方案：该监听器仅在行处于编辑态（`isEditing`）时才有作用，故改为「仅在 `isEditing` 为真时注册」。同一时刻至多一行处于编辑态，监听器数量从 N 降到 ≤1（原计划的上提到 `ChatView` 顶层分发会增大改动面，未采用）。

### 阶段 2 —— 针对主因（设计改动，收益最大，需先计测）

- **2-A. Webview 消息虚拟化保留**：宿主不再全量推送 `clineMessages`，改窗口 + 懒加载；图片改用 VS Code 资源 URI / webview asset 引用，去除 base64。
- **2-B. 宿主历史落盘**：旧轮次全文从内存卸下、按需读回；condense 在上下文上限前按消息数 / 字节阈值自动触发。
- **2-C. 图片内存表示 base64 → 引用**：两侧均不再保留 base64（已选定实施，见下）。

#### 2-C 实施设计（已与用户确认：兼容并存 + 全链路）

现状：图片自选中起即为 `data:image/...` base64，一路驻留于内存（`clineMessages` + `apiConversationHistory`）、磁盘存档（JSON 内联 base64）、webview 传输与渲染。唯一**必须** base64 的只有「发给模型那一刻」（Anthropic API 仅收 base64）。

核心设计：图片字节只落盘一次（`<taskDir>/images/<sha256>.<ext>`），其余环节只存**引用 token**（前缀 `roo-image-ref:`，与 `data:` 可区分，实现兼容并存）。仅在两处还原：

- 发模型时：引用 → 读文件转 base64（最后一刻）。
- webview 显示时：引用 → `convertToWebviewUri()`，在两个出口转换：`ClineProvider.getStateToPostToWebview()`（批量）与 `Task.updateClineMessage()`（流式单条）。

兼容并存：所有消费端对 `images[]` 每一项分支处理——`data:` 走旧 base64 路径（旧任务照常打开），`roo-image-ref:` 走新引用路径。旧存档零迁移、零破坏。

子步骤（各自可编译、可测、可单独提交）：

| 子步骤 | 内容                                                                                                                  | 风险         |
| ------ | --------------------------------------------------------------------------------------------------------------------- | ------------ | ---------- |
| C1     | 新增宿主侧 image-store 模块（`storeImage` / `isImageRef` / `refToAbsPath` / `refToDataUrl`）+ 单测                    | 低（纯函数） | ✅         |
| C2     | 摄入：图片在 `Task.say` 内落盘并替换为引用（单一出口，调用方的 base64 数组不变）                                      | 中           | ✅         |
| C3     | 发模型：无需改动 — `say` 只改本地副本，调用方 `images` 仍为 base64，API 路径不变                                      | —            | ✅（免做） |
| C5     | webview 渲染：两个出口（`ClineProvider.getStateToPostToWebview` / `Task.updateClineMessage`）将引用解析为 webview URI | 中           | ✅         |
| C4     | `apiConversationHistory` 存盘外置 / 发送内联（**最后做，单独测**）                                                    | 高           | ⬜         |
| C6     | 兼容并存与回归测试（旧 base64 任务仍可打开/显示/发送）                                                                | —            | 🔄 进行中  |

> 实施记录：C2 最终落在 `Task.say`（唯一把图片写入 `clineMessages` 的出口；`ask` 不带图片），而非入站处。
> 因 `say` 只重写其本地 `images` 参数，调用方数组仍是 base64，发模型路径无需改动（C3 免做）。
> 这把 base64 从 `clineMessages` 内存与 `ui_messages.json` 磁盘上去掉了；`apiConversationHistory` 仍内联 base64，留待 C4。

### 阶段 3 —— 监控

注入轻量、按需开启的内存探针 [`src/utils/memoryProbe.ts`](../src/utils/memoryProbe.ts)，
跟踪任务进行中的 `heapUsed` / `rss` / `external` 及历史数组长度，对阶段 1/2 做 before/after 验证。

**用法**：设置环境变量 `QCODE_MEMORY_PROBE=1` 启动扩展（未设置时零开销，可安全留在生产构建）。
探针在每个 API 轮次（`Task.recursivelyMakeClineRequests` 循环顶部）打印一行：

```
[memory-probe] task <id> turn heapUsed=123.4MB (+5.6MB) rss=... external=... apiHistory=42 clineMessages=88
```

观察 `heapUsed` 增量与 `apiHistory` / `clineMessages` 长度是否同步线性增长，即可坐实主因（2.1）。

## 4. 阶段任务与进度

| ID  | 阶段 | 任务                                          | 状态                              |
| --- | ---- | --------------------------------------------- | --------------------------------- |
| 1-A | 1    | Bedrock `previousCachePointPlacements` 有界化 | ✅ 完成                           |
| 1-B | 1    | `aggregatedCostsMap` 改 LRU                   | ✅ 完成                           |
| 1-C | 1    | 合并 `ChatRow` window 监听器到 `ChatView`     | ✅ 完成                           |
| 3   | 3    | 注入 `memoryUsage` 探针并计测                 | ✅ 完成（探针就绪，待实环境计测） |
| 2-A | 2    | Webview 消息虚拟化保留 + 图片引用化           | ⬜ 未开始（待计测）               |
| 2-B | 2    | 宿主历史落盘 + condense 自动触发              | ⬜ 未开始（待计测）               |
| 2-C | 2    | 图片 base64 → Blob/引用                       | ⬜ 未开始（待计测）               |

> 实施顺序：先完成阶段 1（1-A → 1-B → 1-C），再做阶段 3 计测以数字坐实主因，最后据计测结果推进阶段 2。
> 每完成一项更新本表状态（⬜ 未开始 / 🔄 进行中 / ✅ 完成），并保证 `pnpm lint` 与 `pnpm check-types` 通过、相关测试通过。
