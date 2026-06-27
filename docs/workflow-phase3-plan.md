# Phase 3 接线方案 —— 硬 `tool` / `skill`（工作流机械执行工具/技能）

> 状态：**已实现**（2026-06-27，3a 只读内置工具）。承接 `expert-system-design.md` §7.2 Phase 3、`workflow-phase2-plan.md`。
> 实现要点见文末"§9 实现记录"。
> 目标：让类型 A 工作流走到 `tool`/`skill` 硬节点时，由宿主**机械地**直接执行该工具/技能（不花 LLM turn），拿结果喂回 `advance()` 续跑。

---

## 0. 价值与前置确认

**价值（已与设计者对齐）**：硬工具的真正意义不是"省几个 token"，而是——

- **工具对模型隐形**：工作流自己知道何时调哪个工具，所以这些工具**不必注册进系统提示词**。系统提示词保持精简且稳定 → **prompt 缓存前缀稳、命中率高**；模型的决策空间也不被无关工具污染。
- **编排灵活**：可挂任意多个高度专用、参数各异的工具（例：3 个不同爬虫），工作流按需即时调用，不给模型工具空间添负担。

**典型用例**：信息搜集工作流 `A(爬虫A,硬) → B(爬虫B,硬) → C(爬虫C,硬) → summarize(llm,软)`。A/B/C 三步全程零 LLM turn、参数各填各的（来自节点静态配置 / `inputs` / 上一步产出），只有 `summarize` 进一次模型，引用 `{{A.output}} {{B.output}} {{C.output}}` 总结。模型从头到尾不知道那三个爬虫存在。

**前置确认（2026-06-26）**：

- 引擎**已支持**：`buildAction` 对 `tool`/`skill` 节点已吐 `{type:"tool",name,params}` / `{type:"skill",name,args}`（[AIWorkflow stateMachine.ts:101](../../AIWorkflow/src/engine/stateMachine.ts)），并已冒烟（triage-flow 的 tool 节点）。**无需改 AIWorkflow。**
- 参数流转**已支持**：tool 节点 `params` 用 `{{node.output.field}}` 引用上游产出（含带 `outputSchema` 的 LLM 节点的结构化产出），引擎 `resolveData` 在吐 action 前求值填好。
- QCode 侧**故意挡着**：`WorkflowSession.consume` 现对 `tool`/`skill` 抛 `Phase 3` 错（占位）。

---

## 1. 与 delegate 的本质差异（决定实现形态）

|              | Phase 2 `delegate`                                     | Phase 3 `tool`/`skill`                                                                               |
| ------------ | ------------------------------------------------------ | ---------------------------------------------------------------------------------------------------- |
| 有无现成机制 | ✅ 复用 `delegateParentAndOpenChild`/`reopen` 整条链   | ❌ 无现成"机械入口"，需新建调用器                                                                    |
| 是否经模型   | 子专家是一个完整 LLM 子任务                            | **完全不经模型**，宿主直调 handler                                                                   |
| 对话历史     | 子摘要回填进父历史（要处理 tool_use/tool_result 配对） | 硬工具**没有** model 发起的 tool_use → **无需配对**，结果只作为 `advance()` 的 lastOutput 走带外通道 |
| 主要难点     | 跨 dispose 续跑                                        | **复刻 `presentAssistantMessage` 的工具调用约定**                                                    |

> 关键反而比 Phase 2 简单的一点：硬工具不是模型发起的，所以**没有悬空 tool_use**、**不进 API 对话的 tool_result 配对**。结果通过带外通道(捕获回调)拿到、喂给 `advance`。麻烦的是怎么"在 `presentAssistantMessage` 之外"把 handler 跑起来。

---

## 2. 核心新件：宿主侧工具调用器（HostToolInvoker）

QCode 工具天生为模型驱动设计：分发在 [presentAssistantMessage.ts:674](../src/core/assistant-message/presentAssistantMessage.ts) 的大 `switch (block.name)`，每个 handler 依赖现场搭建的回调（`askApproval`/`handleError`/`pushToolResult`/`removeClosingTag`/`toolDescription` 等）+ 流式/partial 状态机。

调用器要做的：给定 `{name, params}`（引擎已解析好），**复刻这套调用约定但不经模型**：

```
invokeHardTool(task, { name, params }) -> Promise<string>   // 返回工具输出文本，作为 advance 的 lastOutput
  1. 权限校验：name ∈ 专家 toolPolicy.allowedTools ? 否则拒绝(见 §4)
  2. 构造合成 ToolUse 块 { type:"tool_use", name, params, partial:false }（无 model tool_use id）
  3. 注入回调：
     - pushToolResult(content) → 捕获到局部 result（**不**写 userMessageContent，硬工具无需配对）
     - askApproval(...)        → 走真实审批，尊重 auto-approval(见 §4 层3)
     - handleError(...)        → 捕获错误
     - removeClosingTag/toolDescription → 复刻最小实现
  4. dispatch 到对应 handler（内置走 switch 同款；MCP 走 MCP 客户端；skill 走 SkillTool）
  5. 返回捕获的 result 文本
```

**注意**：result 走带外通道（局部变量），**不**进 API 对话历史的 tool_result——因为没有对应的 model tool_use。这避免了 Phase 2 那种配对问题。工具结果之后被某个软节点的 prompt 通过 `{{node.output}}` 引用时，才以**文本**形式进入对话。

---

## 3. 分类落地：先做哪类

工具有三类来源，复杂度/价值不同。建议**分三小步**，先把调用器骨架在最安全的一类上跑通：

| 小步                       | 范围                                                                                                   | 理由                                                      |
| -------------------------- | ------------------------------------------------------------------------------------------------------ | --------------------------------------------------------- |
| **3a 骨架**                | 仅**只读内置工具**（如 `read_file`/`list_files`/`codebase_search`）——无副作用、常可自动批准            | 验证 HostToolInvoker 骨架 + 权限 + advance 续跑，风险最低 |
| **3b MCP**（真实用例）     | MCP 工具（绕开 `use_mcp_tool` 模型入口，直调 MCP 客户端）                                              | 爬虫等专用工具多是 MCP；这才是价值兑现处                  |
| **3c 技能 + 有副作用内置** | `skill`（走 [SkillTool](../src/core/tools/SkillTool.ts)）、`execute_command`/`write_to_file`/`edit` 等 | 最需审批/最易踩边界，最后做                               |

> 用户场景（爬虫）落在 **3b**；但先做 **3a** 把骨架与权限模型验稳。

---

## 4. 权限与安全模型（四层；唯一新概念 = §4.2 能力白名单）

**核心矛盾**：若用 mode 的 `groups` 管硬工具权限，而 `groups` 又决定"哪些工具进系统提示词"，则一授权工具就回到提示词、被模型看见——**毁掉"工具隐形 + 缓存稳定"**。故：**"工作流可执行" 必须与 "模型可见" 解耦**。

### 4.1 层1 — 来源信任（trust-by-location）

`.roo/workflows/` 是授权数据，与 `.roomodes`/skills/rules 同信任级。**跑一个工作流 = 信任其作者**（等同跑一个技能/npm 脚本）。不自动跑不可信来源的工作流。文档明示。**第一道也是最主要的防线。**

### 4.2 层2 — 能力白名单（挂专家上，且不进系统提示词）〔新增字段〕

在 `expert.ts` 加 `toolPolicy`（仿现有 `delegationPolicy`）：

```ts
export const toolPolicySchema = z.object({
	/** 该工作流专家可机械调用的工具/技能名（精确名）。 */
	allowedTools: z.array(z.string()).optional(),
	/** 可选：按类别放行（如 "mcp"、"read"），便于一次放开一类 MCP。 */
	allowedCategories: z.array(z.enum(["read", "edit", "command", "mcp", "skill"])).optional(),
})
// 加入 expertModeFields： toolPolicy: toolPolicySchema.optional()
```

- 这是**人工授权点**（写在 `.roomodes`，接线者填）。
- **关键**：这份名单**不喂系统提示词构造**（不经 `filter-tools-for-mode`/`getToolsForMode`）→ 模型仍看不见 → 缓存收益保住。
- **默认空 = 一个都不能硬调**（fail-safe）。`HostToolInvoker` 第 1 步据此校验，未授权直接拒绝并 `say("error")`。

**重要处方（否则缓存收益失效）**：系统提示词里的工具 = `ALWAYS_AVAILABLE_TOOLS`(7 个固定核心) + mode 的 `groups` 所带工具（`getToolsForMode`，[modes.ts:30](../src/shared/modes.ts)）。内置工具**不是无条件进提示词**，而是 **group 门控**（`read`→read_file…、`edit`→write_to_file…、`command`→execute_command…、`mcp`→use_mcp_tool…）。因此：

- 工作流专家应保持**最小 `groups`**（只放其**软 LLM 步骤**真正需要的，常为 `[read]` 甚至空）。
- 硬工具一律走 `toolPolicy`，**不要**为了让硬工具能跑而去加 `groups`——加了就把工具塞回系统提示词、被模型看见、击穿缓存前缀，**正是要避免的反模式**。
- 例：爬虫专家 `groups:[read]` + `toolPolicy.allowedTools:[crawler_a,crawler_b,crawler_c]` → 系统提示词只有核心+read，三个爬虫对模型隐形。

### 4.3 层3 — 运行时审批（复用现有 auto-approval）

每次硬执行走与模型工具调用**同一条 `askApproval`**，尊重 `alwaysAllowExecute/Write/Mcp/Read...` 设置，审批 UI 标注"工作流步骤：将执行 X"。用户设了自动批准 → 顺滑；否则弹同款审批 + 可否决。**不另造审批系统。** 全自动无人值守 ⇒ 用户须主动预授权相应类别（有意识的选择）。

### 4.4 层4 — 可见性/审计

每个硬步骤在对话 UI 渲染成"工作流工具步骤"消息（复用 `say`），完整留痕，不藏执行。

---

## 5. 接线改动

1. **`WorkflowSession.ts`**：`consume` 对 `tool`/`skill` 不再抛错，透出 `turn.action`（仿 Phase 2 透 `delegate`）。`WorkflowTurn` 加 `action?: {type:"tool"|"skill", ...}`。
2. **`HostToolInvoker`（新文件，`src/core/expert/`）**：§2 的调用器。依赖注入便于单测。
3. **`Task` 主控**：turn 带硬 `tool`/`skill` → 调 invoker 执行 → 拿结果**立即 `advance(result)`**（循环里不发 API）→ 直到遇软步骤或 `done`。落点同 Phase 2 的 `applyWorkflowTurn`（再加 `action` 分支）+ 一个"机械执行循环"（连续硬步骤不进 LLM turn）。
4. **`expert.ts`**：加 `toolPolicy`（§4.2）。
5. **审批接线**：invoker 的 `askApproval` 路由到现有审批/auto-approval。

> ⚠️ `applyWorkflowTurn` 当前返回"下一条 user 内容"给 Task 循环；硬 `tool`/`skill` 不应产生 user 内容、而应**就地执行并再 advance**。需在 `initiateTaskLoop`/`applyWorkflowTurn` 引入一个内层 while：`while (turn.action is tool/skill) { result = invoke(); turn = advance(result) }`，跳出后再按 soft/delegate/done 处理。

---

## 5.1 硬动作失败语义（跨仓库契约缺口，须先拍）

工具执行可能失败（爬虫没联网 / 命令非零退出 / MCP 报错）。宿主**能**检测失败（handler 抛异常 / MCP 错误 → `formatResponse.toolError`），但**当前引擎契约没有成功/失败维度**：`advance(state, lastOutput)` 把 `lastOutput` 一律记为 `status:'success'`（[AIWorkflow stateMachine.ts:192 `parseOutput`](../../AIWorkflow/src/engine/stateMachine.ts)）。后果：错误文本被当成节点正常产出，工作流照常推进，下游 LLM 拿到"失败"却以为是数据。

三条路（须先选定，A 触及冻结契约）：

| 方案                    | 做法                                                                                   | 代价                                   |
| ----------------------- | -------------------------------------------------------------------------------------- | -------------------------------------- |
| **A. 扩契约**           | `advance` 增加失败信号（如 `advance(state, output, {error})`），引擎据此走失败分支或停 | 动跨仓库冻结契约，需与 AIWorkflow 协调 |
| **B. 约定 + condition** | 宿主把结果包成 `{ok:false,error}` 当 output，工作流作者用 `condition` 节点自行判       | 不动契约，但靠作者每处写判断           |
| **C. 宿主策略**         | 硬工具一失败，宿主**不 advance**、直接停并报用户（可配重试次数）                       | 最简单稳妥，但工作流无法"自处理失败"   |

**倾向**：C 打底（失败即停、绝不假装成功）+ 视需要再上 A。落地前与 AIWorkflow 对齐。

## 6. 风险与门控

- ⚠️ **per-tool 调用约定**：有的 handler 直接动 task 状态 / 调 `say` / 期望流式上下文。invoker 的注入回调要保证：`pushToolResult` 只捕获、**不**写 `userMessageContent`（否则产生悬空 tool_result）。逐工具验证，故 3a 先挑无副作用只读工具。
- ⚠️ **连续硬步骤的循环**：A→B→C 连环硬执行须在**不发 API**的内层循环里跑完，注意 abort/错误中断与持久化（每步 advance 已 persist）。
- ⚠️ **权限默认安全**：`toolPolicy` 默认空；未授权工具一律拒绝 + 提示，绝不"静默放行"。
- ✅ **无 tool_use/tool_result 配对问题**（硬工具非模型发起），比 Phase 2 这点上更简单。
- ✅ **不破坏现有路径**：仍以 `kind==="workflow"` + `workflowSession` 为唯一开关。

---

## 7. 测试计划

1. 单测 `WorkflowSession`：`tool`/`skill` action 透出 `turn.action`（不再抛 Phase 3）。
2. 单测 `HostToolInvoker`：mock 一个 handler，断言 (a) 权限拒绝路径，(b) 结果捕获，(c) 错误捕获，(d) 不污染 `userMessageContent`。
3. 真引擎集成：在 `real-engine.integration.spec.ts` 加一条 `WorkflowSession` 驱动含 `tool` 硬节点的图（已有 triage-flow 的 read 工具节点可借），断言 `turn.action.type==="tool"` 且 advance 续跑。
4. 测试工作流 `.roo/workflows/` + 专家 + 手动 e2e（先 read_file 这类只读工具）。

---

## 8. 落地顺序

1. `WorkflowSession` 透出 `tool`/`skill` action + 单测。
2. `expert.ts` 加 `toolPolicy` + schema 单测。
3. `HostToolInvoker` 骨架（仅只读内置工具）+ 权限校验 + 单测。
4. Task 主控的"机械执行内层循环" + 接审批 + 真引擎集成测试。
5. 扩 MCP（3b）→ 技能 + 有副作用内置（3c）。
6. 文档回填。

> 建议：**Phase 2 手动 e2e 先落地确认**，再开 Phase 3（Phase 3 是纯新建，无 Phase 2 那种现成机制可借）。

---

## 9. 实现记录（2026-06-27，3a 已完成）

按 §8 落地顺序，步骤 1–4 + 6 已完成（**3a：只读内置工具**）；3b（MCP）/3c（技能 + 有副作用内置）待做。

### 已实现

1. **WorkflowSession.ts**：consume 对 tool/skill 不再抛错，透出到 turn.action（WorkflowHardAction）。WorkflowTurn 加 action 字段。单测 11/11 过。
2. **packages/types/src/expert.ts**：加 toolPolicySchema（allowedTools + allowedCategories）+ ToolPolicy 类型，混入 expertModeFields。与 mode groups 解耦（不进系统提示词）。单测 15/15 过。顺带重新生成 schemas/roomodes.json，修复预先存在的 workflowSkillName→workflowId schema 漂移。
3. **src/core/expert/HostToolInvoker.ts（新文件）**：调用器。权限校验（默认空=拒绝）→ 合成 ToolUse（无 model tool_use id）→ 注入捕获版 callbacks（pushToolResult 只捕获、不写 userMessageContent）→ tool.handle() → 返回 {output, isError}。buildReadOnlyToolRegistry 注册 4 个只读工具。单测 19/19 过。
4. **Task.ts**：applyWorkflowTurn 加 action 分支 → 新私有方法 runHardToolLoop（内层 while：连续硬步骤不进 LLM turn，每步 advance(result)，遇 soft/delegate/done 跳出）。审批路由到 this.ask（复用 auto-approval）。失败语义策略 C（失败即停 + 报告）。tsc --noEmit 通过。
5. **真引擎集成测试**：real-engine.integration.spec.ts 加一条用 SAMPLE 的 read tool 节点驱动 WorkflowSession，断言 turn.action.type==="tool" + advance 续跑。本机无引擎产物 → skip。

### 测试总计

- core/expert/**tests**/：50 passed / 3 skipped（真引擎，无产物）
- packages/types/src/**tests**/expert.spec.ts：15 passed
- packages/types/src/**tests**/roomodes-schema\*.spec.ts：26 passed（含修复的 sync）

### 未实现（后续）

- **3b MCP**：HostToolInvoker 目前只注册只读内置工具。MCP 工具需绕开 use_mcp_tool 模型入口、直调 MCP 客户端。爬虫等专用工具的价值兑现处。
- **3c 技能 + 有副作用内置**：skill（走 SkillTool）、execute_command/write_to_file/edit 等。最需审批、最易踩边界，最后做。
- **§5.1 失败语义**：当前用策略 C（失败即停）。若工作流需自处理失败，再上策略 A（扩 advance 契约加失败信号，需与 AIWorkflow 协调）。
- **手动 e2e**：装 vsix、配带 tool 硬节点的工作流 + 专家 toolPolicy、跑 read_file 验证。
