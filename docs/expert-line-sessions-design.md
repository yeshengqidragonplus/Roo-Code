# 专家专线会话设计（Expert Line Sessions）

> 状态：Phase 1-3 已实施；并行队列协议保留待并行任务模型落地后实施。
> 相关：`docs/expert-system-design.md`（专家系统总设计）、`.roo/memory/web-researcher-report-protocol.md`（公共文件协议）、`.roo/memory/shared-file-store-design.md`（共享文件库）。

## 1. 背景与目标模型

当前委派机制（`new_task` → `delegateParentAndOpenChild`）每次委派都创建一次性子任务，用完即弃：

- 同一发起方多次委派同一专家时，专家上下文每次从零开始，迭代式协作（调研 → 看报告 → 追问 → 深挖）每次都要写自包含消息，负担转嫁给发起方；
- 专家没有持续存在的"工作现场"。

**目标模型（用户拍板）：**

1. **路由 key = (发起会话 id, 专家模式 slug)**。发起会话首次委派专家 C → 新建专线会话；再次委派 C → 在同一专线里**追加对话**（上下文延续是特性，不是污染）。
2. **跨发起方物理隔离**：会话 2 的专线 2-1 与会话 20 的专线 20-1 互不相通。B 的任务细节不可能出现在 A 的协作上下文里。
3. **专线是特殊类型会话**：用户可查看、暂停、取消、应答 pending ask（权限审批/追问），**不能主动输入任务**。
4. **级联删除**：删除主会话必须删除其全部派生会话（含专线再委派出的下级专线），防孤儿。
5. **持久记忆放公共文件**（`.roo/research/`、shared-file-store），专线上下文只是"当前协作现场"。专线被回收/压缩后靠文件恢复认知。
6. **为并行预留协议**（队列、requestId），但 v1 在现有 single-open invariant 下实现，不放开并发。

### 被否决的早期方案（留档防反复）

"每专家单会话 + 请求结束归档重组上下文"：所有发起方共享专家一条总线，请求间靠摘要隔离。否决理由：同发起方的上下文延续恰恰是迭代协作需要的，被误伤；且归档/重组机制复杂。**专线模型用"按发起方隔离"替代"按请求隔离"**，隔离边界更粗但语义正确。

## 2. 核心概念

### 2.1 专线会话（expert-line session）

一个长期可复用的子任务，绑定 `(发起会话, 专家模式)` 二元组：

- **专线内**：普通多轮对话——每次委派是一条新 user message（带请求边界标记），专家保留该线全部上下文；
- **专线间**：物理隔离，各自独立的 Task/历史/磁盘目录；
- **生命周期**：随发起会话存活，级联删除时消亡；空闲时只是磁盘上的历史记录 + 登记项，不占运行时资源。

### 2.2 路由规则（唯一入口）

```
委派 (originTaskId, expertMode, message)
  → 查找活跃专线：sessionKind="expert-line"
      && lineOriginTaskId=originTaskId && lineExpertMode=expertMode
      && status ∈ {active, idle}
  → 命中 idle  → 恢复该 Task + 注入新请求（user message）
  → 命中 active → 报告忙碌（v1 single-open 下不可达，见 §10）
  → 未命中     → 新建专线（复用现有 delegateParentAndOpenChild 骨架）
```

路由由**宿主代码强制**（DelegationRouter），绝不依赖提示词约定。

### 2.3 嵌套委派

专线自己也可以委派（专家 C 委派专家 D）：路由 key = (专线 2-1 的 taskId, D) → 专线 2-1-1。级联删除沿 childIds 树递归，天然覆盖。

## 3. 数据模型

### 3.1 HistoryItem 新增字段（`packages/types/src/history.ts`）

```ts
/** 会话种类：普通会话（默认/缺省）或专家专线 */
sessionKind?: "main" | "expert-line"
/** 专线专属：发起方会话 id（路由 key 一半） */
lineOriginTaskId?: string
/** 专线专属：专家模式 slug（路由 key 另一半） */
lineExpertMode?: string
/** 专线累计请求数（用于请求边界标记编号） */
lineRequestCount?: number
```

### 3.2 任务状态新增 `"idle"`

现有 status 联合类型（`active | delegated | completed`）增加 `idle`，专线专属语义：

| 状态        | 含义                              |
| ----------- | --------------------------------- |
| `active`    | 专线正忙（处理请求中）            |
| `idle`      | 空闲存活，可被路由复用            |
| `completed` | 专线已关闭（轮换/手动），不可复用 |

主会话的 `delegated`/`awaitingChildId` 语义不变（等待专线回传时挂起）。

### 3.3 兼容性

无 `sessionKind` 字段的存量任务 = legacy 子任务，行为完全不变。路由只认自己创建的专线。

## 4. DelegationRouter（新组件）

位置：`src/core/delegation/DelegationRouter.ts`，由 ClineProvider 持有。

```ts
class DelegationRouter {
	/** 查活跃专线：v1 直接扫 taskHistoryStore（委派频率低，O(n) 可接受） */
	findLine(originTaskId, expertMode): Promise<HistoryItem | undefined>

	/** 委派唯一入口：NewTaskTool 与 workflow 委派都走这里 */
	routeDelegation(params: {
		originTask: Task // 发起方（当前活动任务）
		expertMode: string
		message: string
		images?: string[]
		todos?: TodoItem[]
	}): Promise<{ lineTaskId: string; reused: boolean }>
}
```

职责：

1. **查找/创建/恢复**专线（§2.2 规则）；
2. **创建路径**：复用 [`delegateParentAndOpenChild()`](src/core/webview/ClineProvider.ts:3040) 的骨架（flush 发起方 pending tool results → 挂起发起方 → mode/profile 切换 → 建子任务 → 持久化血缘），差异仅在子任务 historyItem 多写 §3.1 字段、初始 status 语义；
3. **恢复路径**：以 historyItem 实例化 Task（resume）→ mode/profile 切换 → 注入带边界标记的请求 → 重置 per-request 状态（`toolUseCount`、`didToolFailInCurrentTurn`）→ 发起方挂起（awaitingChildId 指向专线）；
4. **请求边界标记**：注入的消息包裹

```
<delegation_request number="{N}" origin="{发起会话 id}">
{委派消息}
</delegation_request>
```

让专家明确"这是同一条线上的第 N 个请求"。

实现注记：恢复路径"resume + 注入消息"复用 `showTaskWithId` + 聊天输入提交消息的内部链路（Task 以 historyItem 实例化后向已初始化任务提交 user message 的那条路径），具体 API 在编码时确认，必要时在 ClineProvider 上补一个小方法。

## 5. 关键流程

### 5.1 首次委派（会话 2 → 专家 C）

```
NewTaskTool.execute（校验不变：mode 存在、workgroup colleague 白名单）
→ Router.routeDelegation
→ 无活跃专线 → 创建 2-1：
   sessionKind="expert-line", lineOriginTaskId=2, lineExpertMode="C",
   lineRequestCount=1, status="active"
→ 发起方 2 挂起（delegated + awaitingChildId=2-1，现有机制）
→ 专线 start，注入请求 #1
```

### 5.2 重复委派（会话 2 再次 → C，专线 2-1 idle）

```
Router.routeDelegation → 命中 2-1 (idle)
→ 恢复 Task 2-1（从磁盘加载 apiConversationHistory——上下文延续的落点）
→ mode/profile 切到 C
→ 注入请求 #2（边界标记 + lineRequestCount=2）
→ toolUseCount 归零（预算 per-request，见 §6.2）
→ 发起方 2 挂起
```

### 5.3 完成回传

```
专线 attempt_completion
→ delegateToParent → reopenParentFromDelegation(2, 2-1, result)（现有机制，零改动）
→ 差异：专线 status 置 "idle"（而非 "completed"），历史保留待复用
→ 队列空 → 专线空闲存活
```

### 5.4 取消

用户在专线监控面板点"取消当前请求"：

```
webviewMessageHandler 新消息 cancelLineRequest { lineTaskId }
→ abort 专线当前请求
→ 恢复发起会话 2，注入取消通知（"委派已被用户取消"）而非结果
→ 专线 status → idle（会话不死，只终止本请求）
```

发起方永不无限期挂起——取消是路由回传的三种结局（结果/取消/失败）之一。

### 5.5 级联删除

[`deleteTaskWithId()`](src/core/webview/ClineProvider.ts:1918) 已按 `childIds` 递归级联 + shared-file GC——专线天然是 child 树节点，**机制零改动**，需补验证测试：

- 删除主会话 → 专线及下级专线全部删除；
- 专线正忙（active）时删除主会话 → 先 abort 再删（现有"在栈中则 removeClineFromStack"分支覆盖）；
- 公共文件不级联（shared-file GC 按剩余引用保留，现有语义正确）；
- [DeleteTaskDialog](webview-ui/src/components/history/DeleteTaskDialog.tsx:39) 的 `subtaskCount` 级联计数把专线算进去（现有递归计数应已覆盖，验证即可）。

### 5.6 膨胀控制与轮换

- **v1 兜底**：专线内多请求累积触发现有 condense（`src/core/condense/`），无需新机制；
- **显式轮换**（Phase 4）：condense 后仍超阈值 / 连续失败 N 次 → 专线置 `completed` 关闭，下次委派自动新建。专家长期记忆在公共文件，轮换无损失。

## 6. 与现有机制的交互

### 6.1 single-open invariant

不变。任一时刻仍只有一个活动 Task：发起方挂起时专线是活动任务，专线完成/取消后发起方恢复。专线 idle 时其 Task 实例已 dispose，只有磁盘历史 + historyItem 登记项——不占栈、不占内存。

### 6.2 maxToolUses 语义修正

现状：预算 per-child-task（一次委派 = 一个任务 = 一份预算）。专线复用后若不重置，第二次委派会立刻撞预算。**修正：预算 per-request**——Router 每次注入新请求时 `toolUseCount` 归零（`maxToolUsesLimit` 本身仍来自专家模式配置）。

### 6.3 技能注入

零改动。专线以专家模式运行，[`getSkillsForMode()`](src/services/skills/SkillsManager.ts:184) 的 modeSlugs 白名单照常生效；系统提示词在专线生命周期内稳定（专家人格 + 技能清单），新请求以 user message 到达——这正是"追加对话提示而不是系统提示词"。

### 6.4 workflow 委派

[`beginWorkflowDelegation`](src/core/task/Task.ts:2778)（type-A 工作流专家的硬委派）同样过 Router：key = (工作流任务, 子专家)。工作流多轮委派同一子专家 → 专线复用、上下文延续，对工作流是纯收益。

### 6.5 公共文件（持久记忆）

不变。web-researcher 落盘协议、shared-file-store 照旧。专线上下文 = 协作现场；公共文件 = 跨会话/跨专线的长期记忆。专线被删除/轮换后，靠文件路径恢复认知。

### 6.6 shared-file GC

不变。专线删除走 `deleteTaskWithId` 同一入口，manifest 引用计数语义照旧。

## 7. UI 设计

1. **主历史列表**：`sessionKind="expert-line"` 的任务**不进**主列表（防淹没），在发起会话详情页分组展示（"专家专线：web-researcher ×1、unity-operator ×1"，显示状态徽标 busy/idle）。
2. **专线聊天视图**：特殊模式——
    - 消息流只读展示（含历史请求的完整执行过程，供审计）；
    - 输入框禁用，**仅当存在 pending ask（权限审批/追问）时**开放应答输入/按钮；
    - 工具栏：暂停、取消当前请求（§5.4）；
    - 顶部横幅标识"这是 {专家名} 的专线 · 发起自会话 {id}"。
3. **i18n**：新增文案进 18 个 locale（webview-ui/src/i18n/locales/\*/）。

## 8. 实施计划

### Phase 1 — 数据模型 + 路由核心（可独立交付）

| 文件                                            | 改动                                                            |
| ----------------------------------------------- | --------------------------------------------------------------- |
| `packages/types/src/history.ts`                 | §3.1 字段 + `"idle"` 状态                                       |
| `src/core/delegation/DelegationRouter.ts`（新） | findLine / routeDelegation / 恢复注入                           |
| `src/core/tools/NewTaskTool.ts`                 | 委派改走 Router（含 §8 gate）                                   |
| `src/core/webview/ClineProvider.ts`             | delegateParentAndOpenChild 拆出可复用片段；补 resumeLineSession |

**Gate（v1 决策）**：仅 `targetMode.kind` 存在（专家模式）或发起方是 workgroup 时走专线路由；普通 mode（code/debug 等）委派保持 legacy 每次新建。理由：不改变普通模式既有语义，风险隔离。

测试：`DelegationRouter.spec.ts`（查找/创建/恢复/gate/边界标记）、NewTaskTool 既有 spec 扩展。

### Phase 2 — 完成回传 + 取消 + 状态机

| 文件                                        | 改动                                                   |
| ------------------------------------------- | ------------------------------------------------------ |
| `src/core/tools/AttemptCompletionTool.ts`   | 专线完成 → status=idle + 回传（复用 delegateToParent） |
| `src/core/webview/webviewMessageHandler.ts` | `cancelLineRequest` 消息分支                           |
| `src/core/webview/ClineProvider.ts`         | 取消路径：abort 专线 + 恢复发起方注入取消通知          |

测试：完成→idle→再委派复用（断言第二次委派后 apiConversationHistory 含第一次对话）；取消回传；级联删除含专线。

### Phase 3 — UI + i18n

| 文件                                                                 | 改动                                   |
| -------------------------------------------------------------------- | -------------------------------------- |
| `webview-ui/src/components/history/HistoryView.tsx` / `TaskItem.tsx` | 专线过滤 + 分组 + 状态徽标             |
| `webview-ui/src/components/chat/ChatTextArea.tsx`                    | 专线视图输入受限（pending ask 才开放） |
| 专线监控视图（新组件）                                               | 横幅 + 暂停/取消按钮                   |
| 18 个 locale 文件                                                    | 新文案                                 |

### Phase 4 — 队列 / 轮换（部分实施）

- **轮换**：已实施。达到请求数/连续失败阈值时，先将旧专线标记为 `completed`，再创建新专线，确保旧线不会被后续路由重新命中。
- **请求队列**：待并行任务模型实施。`LineRequestQueue` 可作为后续持久化基础设施，但 v1 不接入路由；busy 专线明确返回忙碌错误，绝不接受后又丢失请求。
- **显式轮换**：`shouldRotate()`——`lineRequestCount >= 20` 或 `lineConsecutiveFailures >= 3`（`LineRotationPolicy` 可配）→ 关线重建；完成重置失败计数，取消 +1 失败计数
- **未实施**（真正放开并行委派时再做）：多发起方同时挂起、多对多 requestId 关联表、路由内存索引

## 9. 决策点（实施中如遇冲突以此为准，或回头找用户）

1. **Gate 范围**：v1 只对专家模式/workgroup 走专线（§8）。若用户要求全量，去掉 gate 即可，机制相同。
2. **取消语义**：取消 = 终止当前请求，专线保留 idle。若用户要求"取消 = 关闭专线"，改一行状态转移。
3. **专线在历史列表的可见性**：默认不进主列表、详情页分组。若用户要求可见，改过滤条件。
4. **busy 时入队 vs 报错**：v1 single-open 下不可达，先实现为明确报错（"专家正忙"），Phase 4 换队列。

## 10. 为什么 v1 队列不可达（留档）

single-open invariant 下，发起方委派后即挂起，不可能再发第二条；另一发起方（会话 20）要委派必须先成为活动任务，而切换任务会把当前活动任务（正忙的专线）挂起——走的是暂停/恢复机制而非排队。因此 v1 队列长度恒为 0，实现它没有可验证的路径。协议（requestId、队列结构）待并行任务模型落地后再接入路由。
