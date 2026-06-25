# Phase 1 工作流专家 Demo —— 设计说明

> 目的：用一个最小的"全软步骤"工作流，端到端演示**类型 A（工作流驱动）专家**在 QCode 里怎么跑。读完这份你能看懂：一条工作流从配置到执行、再到完成的完整链路，以及每个文件各自负责什么。
>
> 配套总设计见 `expert-system-design.md`（尤其 §3 执行模型、§7 接线）。

---

## 0. 一句话概括

**专家（= Task 循环）当主控，工作流当"导演"逐步给专家下达下一步指令**；专家每完成一步就 `attempt_completion`，工作流据此推进到下一步；走到工作流终点，整个任务才算真正完成。

Phase 1 只支持**软步骤**（工作流给文本提示、由 LLM 干活），不含硬动作（派子专家 / 直接调工具）。

---

## 1. 组成这个 Demo 的三样东西

| # | 东西 | 文件 | 作用 |
|---|------|------|------|
| 1 | 工作流图 | `.roo/workflows/explain-and-plan.json` | 定义"走哪几步"（restate → plan → execute），全是 `llm` 软节点 |
| 2 | 工作流专家 | `.roomodes` 里的 `workflow-demo` | 一个 `kind: workflow` 的 mode，`workflow.workflowId = explain-and-plan` 把专家绑到上面那条工作流 |
| 3 | 引擎产物 | `AIWorkflow/dist-engine/engine.mjs`（外部仓库构建） | 真正"算下一步"的状态机；QCode 运行时动态加载，路径由 `qcode.workflowEnginePath` 指定 |

> 1 和 2 是工作区数据（运行时读取，不打进 vsix）；3 是独立项目的构建产物。三者通过**冻结的契约**解耦。

---

## 2. 工作流图长什么样（`explain-and-plan.json`）

线性三步，全部是 `llm`（软）节点：

```
inputs: { task }                     ← 用户的任务作为输入

restate(llm)  → plan(llm)  → execute(llm)
   │              │              │
"一句话复述目标"  "列3-6步计划"   "产出最终交付物"
```

- 节点间用 `{{...}}` 引用上一步产出：`{{inputs.task}}`、`{{restate.output}}`、`{{plan.output}}`。
- `llm` 节点天生是软步骤（引擎对它只会给 `nextPrompt`，不会给 `action`）。
- 没有 `tool`/`skill`/`expert` 硬节点 —— 所以是纯 Phase 1 工作流。

---

## 3. 执行时发生了什么（完整链路）

### 3.1 启动（专家任务开始）

`Task.initiateTaskLoop()` 一开头调 `initWorkflowSession()`（[Task.ts](../src/core/task/Task.ts)）：

1. 看当前 mode 是不是 `kind === "workflow"` 且有 `workflow.workflowId` → 是 `workflow-demo`，命中。
2. 取 `qcode.workflowEnginePath` + `WorkflowRegistry`：
   - `WorkflowRegistry.load("explain-and-plan")` 读 `.roo/workflows/explain-and-plan.json` 并解析（[WorkflowRegistry.ts](../src/core/expert/WorkflowRegistry.ts)）。
   - `createDynamicImportProvider(enginePath)(图)` 运行时 `import()` 引擎产物、`createEngine(图)`（[WorkflowEngineProvider.ts](../src/core/expert/WorkflowEngineProvider.ts)）。
3. `WorkflowSession.start({ task: 用户消息文本 })`（[WorkflowSession.ts](../src/core/expert/WorkflowSession.ts)）→ 引擎 `start()` 返回第一步：`restate` 的 `nextPrompt`。
4. 把这个提示词**加框**（`frameWorkflowStepPrompt`：追加"这是工作流的一步，完成本步后调 attempt_completion，别当作整体完成"）作为**首轮 user 内容**注入 Task 循环。

> 任何一步失败（引擎没配/加载失败）→ 记日志、**优雅降级为普通自驱**，不报错卡死。

### 3.2 每一步（专家干活 → 工作流推进）

```
注入 restate 提示词
   ↓
LLM 干活 → 调 attempt_completion("一句话复述：…")     ← 阶段完成
   ↓  （AttemptCompletionTool 拦截，见下）
workflowSession.advance("一句话复述：…")
   ↓  引擎推进到 plan，返回 plan 的 nextPrompt
pushToolResult(加框的 plan 提示词)                    ← 循环继续，不结束
   ↓
LLM 干活 → attempt_completion("计划：…")
   ↓ advance → execute 的 nextPrompt → pushToolResult
LLM 干活 → attempt_completion("最终交付物")
   ↓ advance → 引擎走到终点，done = true
不再拦截 → 落到正常完成流程 → 任务真正结束
```

**关键拦截点**在 `AttemptCompletionTool`（[AttemptCompletionTool.ts](../src/core/tools/AttemptCompletionTool.ts)）：

- 仅当 `task.workflowSession` 存在且非子任务时生效。
- 模型的 `attempt_completion(result)` 被当作**本步结果**喂给 `advance(result)`。
- `advance` 返回**未 done** → 展示本步结果 + `pushToolResult(下一步提示词)` → **循环继续**。
- `advance` 返回 **done** → 不拦截，落到正常完成流程 → 任务真正结束。

> 这就是"阶段完成 ≠ 整体完成"：每个 `attempt_completion` 只是某个流程节点的完成；唯有工作流自己走到终点（`done`）才真正完成。完成由**工作流闸门**裁决，而非模型随口说完成。

### 3.3 状态持久化与恢复（会话级）

- `advance`/`start` 每推进一步，`WorkflowSession` 通过注入的 `persist` 调 `saveWorkflowState()`（[workflowState.ts](../src/core/task-persistence/workflowState.ts)），把 `{ workflowId, engineState, lastUpdated }` 写进会话目录 `tasks/{taskId}/workflow_state.json`。
- 关闭后重开任务：`initWorkflowSession` 读到 `workflow_state.json` → `WorkflowSession.resume(engineState)` 重建引擎、从持久化状态续跑（在途的那条提示词已在对话历史里，模型接着答即可）。

---

## 4. 各文件职责速查

| 文件 | 职责 |
|------|------|
| `.roo/workflows/explain-and-plan.json` | 工作流图（走哪几步） |
| `.roomodes` → `workflow-demo` | 工作流专家（绑定 workflowId） |
| `packages/types/src/workflow.ts` | 冻结契约：`WorkflowEngine.start/advance`、`WorkflowStep`、`WorkflowAction`、`WorkflowSummary` |
| `packages/types/src/expert.ts` | 专家字段：`kind` / `workflow.workflowId` / `delegation` / `terminationHint` |
| `WorkflowRegistry.ts` | 扫 `.roo/workflows/`、按文件名 id 列出/加载图 |
| `WorkflowEngineProvider.ts` | 运行时动态加载引擎产物，适配成契约 `WorkflowEngine` |
| `WorkflowSession.ts` | 宿主侧会话：`start/advance/resume`，soft-only，调 persist；`frameWorkflowStepPrompt` |
| `workflowState.ts` | 会话级状态读写（`workflow_state.json`） |
| `Task.ts` → `initWorkflowSession` | 启动/恢复时建会话、注入首步提示词 |
| `AttemptCompletionTool.ts` | 拦截 `attempt_completion` 作为每步边界 |
| `qcode.workflowEnginePath`（设置） | 引擎产物路径；空则禁用工作流专家（自驱） |

---

## 5. 实测步骤

1. 安装：`code --install-extension bin/qcode-0.0.4.vsix --force`，重载窗口。
2. 用 **Roo-Code 仓库**作为工作区打开（才能读到 `.roomodes` 和 `.roo/workflows/`）。
3. 设置 `qcode.workflowEnginePath` = `/Volumes/workspace/GitHubTest/AIWorkflow/dist-engine/engine.mjs`。
4. 模式下拉选 **🧪 Workflow Demo (Explain & Plan)**，给一个开放任务。

**预期**：被工作流逼着走 restate → plan → execute 三步，每步 `attempt_completion` 后自动进入下一步（提示词带"This is one step of a larger workflow…"框），三步走完才真正完成；中途关掉重开能续跑。

**排查**：
- 表现得像普通自驱、没分步 → 多半 `qcode.workflowEnginePath` 没设/路径错（日志有 `[workflow] … running autonomously`）。
- 报 `Phase 1 is soft-only` → 用了含硬节点的工作流（本 demo 纯软，不会触发）。

---

## 6. 这个 Demo 不包含什么（即 Phase 2/3）

- **硬 `delegate`**（工作流直接派子专家、跨 dispose 续跑）——Phase 2，未实现。
- **硬 `tool`/`skill`**（工作流机械直调工具/技能）——Phase 3，未实现。
- **并行子专家**——更后置。

本 demo 仅验证"工作流当导演、逐步软指挥 LLM、按阶段/整体语义完成"这条最核心的主链路。
