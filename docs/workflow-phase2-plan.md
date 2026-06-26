# Phase 2 接线方案 —— 硬 `delegate`（工作流委派子专家）

> 状态：**已实现**（2026-06-26）。承接 `expert-system-design.md` §7.2 Phase 2、`workflow-demo-phase1.md`。
> 实现要点见文末"§8 实现记录"。
> 目标：让类型 A 工作流走到 `expert` 硬节点时，由宿主**机械地**派一个有相应权限的子专家去干（如"写文档"），子专家完成 → 摘要回填 → 父工作流据此 `advance` 推进，直到走到终点才真完成。
>
> 这正是 Phase 1 测试里暴露的痛点（只读专家写不了文件）的"干净"解法：**按步委派**，每个专家只拿自己那步需要的权限，而不是放宽父专家权限。

---

## 0. 前置确认（已核实 2026-06-26）

- **引擎已支持 delegate，无需改 AIWorkflow**。`AIWorkflow/src/engine/stateMachine.ts` 的 `buildAction` 对 `expert` 硬节点返回 `{type:'delegate', expert: expertId??mode, goal: subtaskPrompt}`；已构建进 `dist-engine/engine.mjs`；集成请求文档记录引擎已冒烟跑通 `tool→llm→condition→delegate`。
- **`expert` 节点契约**：必填 `subtaskPrompt`；`expertId` 或 `mode` 至少有一个 —— 其值是要委派到的 **QCode mode slug**。
- **QCode 委派机制已完整**：`delegateParentAndOpenChild`（父 dispose→开子）+ `reopenParentFromDelegation`（子完成→摘要回填→父 reopen→`resumeAfterDelegation`）。
- **reopen 回填有兜底**：父历史里没有匹配的 `new_task` tool_use 时，子摘要作为**纯 user 文本**注入（[ClineProvider.ts:3058](../src/core/webview/ClineProvider.ts:3058)）—— Phase 2 的机械委派正好走这条。

---

## 1. 完整数据流

```
父任务(workflow 专家) ── 某步 attempt_completion("计划已就绪")
   │
   ├─ AttemptCompletionTool 拦截（已存在 Phase 1 拦截点）
   │     workflowSession.advance("计划已就绪")
   │        └─ 引擎返回 action:{type:"delegate", expert:"code", goal:"把计划写成文档"}   ← 非 nextPrompt
   │
   ├─ 【B】宿主：不注入提示词。先给本轮 attempt_completion 推一条 tool_result
   │     （"Delegating to sub-expert code…"），再标记 pendingDelegation 落盘，
   │     然后 startSubtask(goal, [], "code")
   │        └─ delegateParentAndOpenChild：父任务 dispose 到磁盘（workflow_state.json 已含 pendingDelegation）
   │
   ▼
子专家(code, 有 edit 权限) 自驱 → 写文件 → attempt_completion("已写到 docs/plan.md")
   │
   ├─ 子任务有 parentTaskId → reopenParentFromDelegation
   │     子摘要注入父历史（无 new_task tool_use → 走纯文本兜底）→ 父 reopen
   │     → resumeAfterDelegation() → initiateTaskLoop([])
   │
   ▼
父任务 reopen → initWorkflowSession（resume 路径）
   │
   └─ 【C】检测到 pendingDelegation：rebuild session (resume) → advance("已写到 docs/plan.md")
         ├─ 下一步 soft → 注入 framed nextPrompt（循环继续）
         ├─ 又是 delegate → 再走 B（连环委派）
         └─ done → 落正常完成流程 → 任务真完成
```

---

## 2. 三处改动（A/B/C）

### A. WorkflowSession 透出 delegate 动作（停止 throw）

[WorkflowSession.ts:83](../src/core/expert/WorkflowSession.ts:83) 现在遇到任何 `action` 直接 throw。改为：`delegate` 透出给宿主，`tool`/`skill` 仍 throw（留 Phase 3）。

```ts
// WorkflowTurn 增加 delegation 字段
export interface WorkflowTurn {
	prompt?: string
	/** 硬委派：宿主需派子专家、拿摘要后再 advance。 */
	delegate?: { expert: string; goal: string }
	done: boolean
	finalResult?: string
}

// consume()
if (step.action) {
	if (step.action.type === "delegate") {
		return { delegate: { expert: step.action.expert, goal: step.action.goal }, done: false }
	}
	throw new Error(`Workflow ${step.action.type} actions are Phase 3 — not supported yet.`)
}
```

> `advance()` 已经在 `consume` 里 `persist` 了引擎 state，所以委派前的状态天然存盘。

### B. 发起委派（AttemptCompletionTool + Task.start 首步）

两个调用 `advance/start` 的点都要处理"turn 带 delegate"：

1. **每步**：[AttemptCompletionTool.ts:99](../src/core/tools/AttemptCompletionTool.ts:99) 现有的 `if (nextStep && !nextStep.done && nextStep.prompt)` 分支前，加 delegate 分支：

```ts
if (nextStep && !nextStep.done && nextStep.delegate) {
	await task.say("completion_result", result, undefined, false)
	// 给本轮 attempt_completion 一个 well-formed tool_result，再委派
	pushToolResult(
		formatResponse.toolResult(`Delegating to sub-expert "${nextStep.delegate.expert}": ${nextStep.delegate.goal}`),
	)
	await task.beginWorkflowDelegation(nextStep.delegate) // 见下
	return
}
```

2. **首步**：[Task.ts:2528](../src/core/task/Task.ts:2528) `initWorkflowSession` 的 fresh-start，若 `turn.delegate` 直接委派（少见但要兜住）。

`beginWorkflowDelegation` 落在 Task 上：标记 pendingDelegation 落盘 → `startSubtask(goal, [], expert)`。

```ts
public async beginWorkflowDelegation(d: { expert: string; goal: string }) {
	await markWorkflowPendingDelegation({ taskId: this.taskId, globalStoragePath: this.globalStoragePath, expert: d.expert })
	await this.startSubtask(d.goal, [], d.expert)   // → delegateParentAndOpenChild({mode: d.expert})
}
```

> **目标 mode 校验**：`d.expert` 必须是存在的 mode slug。委派前用 `getModeBySlug` 校验，缺失则 `say("error", …)` 并降级（把 goal 当 nextPrompt 让父专家自己干），避免卡死。

### C. 父 reopen 续 advance（最易错）

`resumeAfterDelegation` 末尾 `initiateTaskLoop([])`（[Task.ts:2448](../src/core/task/Task.ts:2448)）会重新过 `initWorkflowSession`。在 `initWorkflowSession` 的 **resume 路径**（[Task.ts:2517](../src/core/task/Task.ts:2517)）里区分两种 resume：

| 场景                                       | 信号                     | 动作                                                                                            |
| ------------------------------------------ | ------------------------ | ----------------------------------------------------------------------------------------------- |
| 进程重启 / 普通重开（Phase 1，软步骤途中） | 无 pendingDelegation     | rebuild session，原样返回 userContent（在途提示词已在历史，模型接着答）                         |
| **委派返回（Phase 2）**                    | **有 pendingDelegation** | rebuild session → `advance(子摘要)` → 清 pendingDelegation → 按 turn 注入下一步 / 再委派 / 完成 |

"子摘要"从哪来：reopen 把它作为父历史最后一条 user 文本注入了。`initWorkflowSession` 读回 `historyItem.completionResultSummary`（reopen 已写入，[ClineProvider.ts:3108](../src/core/webview/ClineProvider.ts:3108)）作为 `advance` 的 lastOutput 最稳妥，不必从历史里捞文本。

```ts
// initWorkflowSession，resume 分支内
if (persisted.pendingDelegation) {
	this.workflowSession = await WorkflowSession.resume(workflowId, persisted.engineState, deps)
	const childSummary = /* historyItem.completionResultSummary */ ""
	const turn = await this.workflowSession.advance(childSummary)
	await clearWorkflowPendingDelegation({ taskId, globalStoragePath })
	if (turn.done) return userContent // 落正常完成
	if (turn.delegate) {
		await this.beginWorkflowDelegation(turn.delegate) /* 不再继续 loop */
	}
	if (turn.prompt) return [{ type: "text", text: frameWorkflowStepPrompt(turn.prompt) }]
}
```

> ⚠️ 注意 reopen 已经把子摘要塞进了父 API 历史（兜底纯文本）。我们这里**又**注入下一步提示词作为新 user 内容 —— 要确认不会产生连续两条 user 消息触发 API 报错。`resumeAfterDelegation` 本来就把环境详情合并进"最后一条 user 消息"而非新建（[Task.ts:2413-2440](../src/core/task/Task.ts:2413)）；我们注入的下一步提示词应作为 `initiateTaskLoop` 的入参 userContent，由它正常追加为新一轮——需实测这条边界。

---

## 3. 持久化 schema 扩展

`PersistedWorkflowState`（[workflowState.ts:18](../src/core/task-persistence/workflowState.ts:18)）加一个可选标记 + 两个辅助函数：

```ts
export interface PersistedWorkflowState {
	workflowId: string
	engineState: WorkflowState
	lastUpdated: number
	pendingDelegation?: { expert: string } // 新增：B 标记，C 消费后清除
}
// + markWorkflowPendingDelegation() / clearWorkflowPendingDelegation()（读-改-写同一文件）
```

---

## 4. 测试计划

1. **测试工作流**：新增 `.roo/workflows/explain-plan-write.json`，在 Phase 1 的 restate→plan 后接一个 `expert` 硬节点：
    ```jsonc
    {
    	"id": "write",
    	"type": "expert",
    	"data": { "mode": "code", "subtaskPrompt": "把计划写成文档：{{plan.output}}", "exec": "hard" },
    }
    ```
    再接一个 `llm` 终点节点确认整体达成。新增一个绑定它的 `workflow-demo-2` 专家（mode）。
2. **单测（WorkflowSession）**：mock 引擎返回 delegate action → `advance` 返回 `turn.delegate`，不再 throw；`tool`/`skill` 仍 throw。
3. **集成测试（跨 dispose）**：最难、最关键。用真引擎 + stub 子任务完成，断言：委派标记落盘 → reopen 读回 → `advance(摘要)` 推进 → 下一步注入正确。复用 Phase 1 的真引擎集成测试骨架。
4. **手动 e2e**：装 vsix，选 `workflow-demo-2`，给开放任务，观察 restate→plan→**派 code 子专家写文件**→回到父→终点确认→完成；中途关重开能续。

---

## 5. 风险与门控

- ✅ **连续 user 消息**：实现时发现 `recursivelyMakeClineRequests` 在发往 API 前用 `mergeConsecutiveApiMessages(msgs, {roles:["user"]})`（[Task.ts:4231](../src/core/task/Task.ts:4231)）**非破坏性合并连续 user 消息**——所以 B/C 注入与 reopen 兜底产生的连续 user 消息会自动合并，不违反角色交替。原本担心的"双 user"风险被这个既有机制兜住。
- ⚠️ **tool_use/tool_result 配对**（真正要处理的）：原生 `new_task` 流是靠 reopen 给触发用的 tool_use 回填 tool_result；但 reopen 只认 `new_task`，对我们的 `attempt_completion` 触发只会走纯文本兜底、**不**回填 tool_result。所以 B 处必须在 dispose **前**给 `attempt_completion` 推一个占位 tool_result（否则父恢复发 API 时悬空 tool_use 报 400）。占位经由 `beginWorkflowDelegation` 的 `onBeforeDelegate` 回调在 `startSubtask` flush 前推、且仅成功路径推。
- ⚠️ **pendingDelegation 与普通 resume 的区分**必须可靠：标记只在 B 写、C 清；进程在委派途中崩溃重开也应能据标记恢复（advance 幂等性由引擎 `JSON.parse(JSON.stringify)` 深拷贝保证）。
- ⚠️ **目标 mode 不存在**：校验 + 降级，不卡死。
- ✅ **不破坏现有路径**：所有改动仍以 `kind==="workflow"` + `workflowSession` 存在为唯一开关；普通会话 / 类型 B 完全不进这些分支。
- ✅ **单活动任务约束**不变：仍是串行委派（父 dispose），不碰并发。

---

## 6. 不在本阶段（Phase 3+）

- 硬 `tool` / `skill`（宿主机械直调工具/技能 handler，绕过模型驱动流程）—— A 处仍对它们 throw。
- 并行子专家（需重构单活动任务模型）。

---

## 7. 落地顺序建议

1. A（WorkflowSession 透出 delegate）+ 单测 —— 最小、零风险。
2. 持久化 schema（mark/clear）+ 单测。
3. B（发起委派）。
4. C（reopen 续 advance）—— 配集成测试边写边验。
5. 测试工作流 + 手动 e2e。
6. 文档回填：`expert-system-design.md` §5 第 6 项打勾、§7.2 Phase 2 标"已实现"。

---

## 8. 实现记录（2026-06-26）

落地与本方案一致，差异/要点如下：

**改动文件**

- `WorkflowSession.ts`：`WorkflowTurn` 加 `delegate?`；`consume()` 对 `delegate` 透出、对 `tool`/`skill` 抛 Phase 3 错。
- `workflowState.ts`：`PersistedWorkflowState.pendingDelegation?`；新增 `markWorkflowPendingDelegation` / `clearWorkflowPendingDelegation`（读-改-写）。`saveWorkflowState` 仍只写基础字段 → 下一次 advance 自动清标记。
- `Task.ts`：`initWorkflowSession` fresh-start 与 resume 两路都改走新私有方法 `applyWorkflowTurn`；resume 路凭 `pendingDelegation` 用子摘要续 `advance`。新增 `applyWorkflowTurn`、`beginWorkflowDelegation`（public，带 `onBeforeDelegate` 回调）、`getDelegationChildSummary`（从 `provider.getTaskWithId(taskId).historyItem.completionResultSummary` 取）。
- `AttemptCompletionTool.ts`：每步拦截里加 delegate 分支，经回调在委派前推占位 tool_result；mode 缺失则降级为软提示词。

**关键决策**

1. **委派从 `attempt_completion` 拦截点机械发起**（非模型 `new_task`），复用 `startSubtask → delegateParentAndOpenChild`。
2. **子摘要来源**：`historyItem.completionResultSummary`（reopen 已写入），而非从对话历史捞文本——更稳。
3. **clear-on-advance**：标记是只活到下一次 advance 的瞬态位，靠 `saveWorkflowState` 不写它实现自动清除（外加显式 `clearWorkflowPendingDelegation` 双保险）。
4. **降级**：目标 mode 不存在 → `say("error")` + 把 goal 当软步骤交当前专家，绝不卡死。

**测试**

- `WorkflowSession.spec.ts`：delegate 透出、advance 后 delegate、tool/skill 抛 Phase 3。
- `workflowState.spec.ts`：mark/clear/clear-on-advance/无状态 no-op。
- `real-engine.integration.spec.ts`：用**真引擎** + `WorkflowSession` 跑 soft→soft→delegate→soft→done，断言 `turn.delegate` 与续跑。
- 测试工作流 `.roo/workflows/explain-plan-write.json` + 专家 `workflow-demo-2`（待手动 e2e）。

**仍需手动 e2e 验证**：跨 dispose 的真实 reopen 续跑（单测覆盖了 WorkflowSession 与持久化层，但 Task↔Provider 的真实 reopen 回调链未在单测中端到端跑）。

```

```
