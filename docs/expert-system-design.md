# 专家系统（Expert System）设计文档

> 状态：设计讨论稿（draft）
> 范围：QCode 内的"长程任务 / 多专家协作"架构。工作流（Workflow）引擎与可视化编辑器在**独立的 git 仓库 / 会话**中实现，本文只定义 QCode 侧需要遵守的**接口契约**。

---

## 1. 目标

支持**长程任务（long-horizon task）**的执行。长程任务分两种形态，统一抽象为"专家（Expert）"：

- **类型 A — 确定型（已知工作流）**：流程已固化，专家按预定义 workflow 执行。本质是流程编排，LLM 只在节点内部做局部智能。
- **类型 B — 探索型（半开放 / 全开放）**：尚未形成固定流程。专家以"自身思维模式 + LLM loop"自驱，期间可使用工具、技能，可派生子任务委派其他专家，收集汇报以辅助决策，直至任务完成。

设计原则：**两类专家共享同一执行内核，差异只体现在"控制流来源"和配置上**，不做成两套系统。

---

## 2. 核心抽象：专家（Expert）

```
专家（Expert）= 思维模式 / 角色 / 工具权限   （= QCode 的 roomode）
              + 可调用的技能集               （= .roo/skills）
              + 可选的工作流定义             （仅类型 A 携带；= 一份工作流图 JSON）
```

- **类型 A 专家** = 带 workflow 定义的专家。
- **类型 B 专家** = 不带 workflow，放开 Task loop 自驱的专家。

> 关键判断：统一抽象，差异在配置。一个专家是 A 还是 B，取决于它是否绑定了 workflow 定义。

### 映射到 QCode 现有设施

| 专家的组成                 | QCode 现有载体                           | 现状                        |
| -------------------------- | ---------------------------------------- | --------------------------- |
| 思维模式 / 角色 / 工具权限 | `.roomodes` + `filter-tools-for-mode.ts` | ✅ 已有                     |
| 可调用技能                 | `.roo/skills`（数据驱动技能系统）        | ✅ 已有                     |
| 工作流定义（类型 A）       | 一份图 JSON，注册为 skill                | ⛔ 待接入（外部仓库做引擎） |
| 执行内核                   | `src/core/task/Task.ts` 的主循环         | ✅ 已有                     |

---

## 3. 执行模型

### 3.1 共享内核：LLM 为主，工作流为"导演"

两类专家底层都是同一个 **Task loop**（[Task.ts](../src/core/task/Task.ts)）：观察 → 决策下一步 → 执行 → 再观察。LLM 始终是行动者，**系统提示词不变**。

- **类型 B** = 直接放开该 loop，由 LLM 每步动态决策（QCode 现状最接近，几乎现成）。
- **类型 A** = 在 loop 外由**宿主（专家代码）**每个 turn 之前调用一次工作流（一个**有状态的状态机**），拿到"下一步该做什么"再喂给 LLM。工作流**不代替 LLM 执行动作**，只约束方向——像导演给演员递分镜，演员仍自己演。

> 关键反转：工作流不是"引擎逐个执行节点、LLM 填空"，而是"**宿主调用工作流推进状态、LLM 仍是主行动者**"。这消除了工作流对 QCode 内部的耦合（不再需要 `dispatchNode`）。

#### 类型 A 的宿主循环

工作流暴露两个方法（状态 `state` 是引擎自己的不透明 JSON，由 QCode 随 task 持久化）：

```
workflow.start(inputs)              -> { state, nextPrompt?, action?, done }
workflow.advance(state, lastOutput) -> { state, nextPrompt?, action?, done, finalResult? }
```

每轮 `advance` 的返回是**软/硬二选一**（这就是"A 和 B 兼得"的来源）：

- `nextPrompt`（**软**）：给 LLM 的指示文本，LLM 自己决定怎么做 → 走一个 LLM turn。
- `action`（**硬**）：给宿主的结构化指令，宿主直接执行、**不花 LLM turn**：
  - `{ type:"delegate", expert, goal }` —— 硬触发委派子专家
  - `{ type:"tool", name, params }` —— 机械地调工具
  - `{ type:"skill", name, args }` —— 机械地跑技能

宿主分发逻辑：

```
{ state, nextPrompt, action, done } = workflow.advance(state, lastOutput)
if (done)        finish(finalResult)
else if (action) → 宿主直接执行 action，拿结果 → 立刻再 advance（不花 LLM turn）
else if (prompt) → 注入给 LLM（system 不变）→ runOneTurn → 收割最终文本 → 再 advance
```

- **喂回工作流的"上一轮输出"** = LLM 这一轮的**最终文本结果**（不含中间工具执行细节）。
- **纯机械步骤**通过 `action` 出口跳过 LLM turn，节省 token。

### 3.2 子专家派遣与汇报

**触发的决定权分两类**（实际发起委派始终是宿主/LLM，见下）：

- **类型 B**：由 **LLM 自己**决定何时拆子任务（model-driven，同现状）。
- **类型 A**：由**工作流**决定——走到委派步骤时返回 `action:{type:"delegate",...}`（硬触发，宿主直接发起），或在 `nextPrompt` 里指示 LLM 去派（软触发）。

QCode 现有委派机制**已完整支持串行协作**（已核实，非"待验证"）：

| 能力                                       | QCode 现状                                                                                | 备注                  |
| ------------------------------------------ | ----------------------------------------------------------------------------------------- | --------------------- |
| 派生子专家                                 | `new_task` → `delegateParentAndOpenChild`（[ClineProvider.ts:2807](../src/core/webview/ClineProvider.ts)） | ✅ 已有；父任务被 dispose 到磁盘，子任务成为唯一活动任务 |
| 子专家完成回填 + **父专家恢复后继续决策**  | `reopenParentFromDelegation`（[ClineProvider.ts:2942](../src/core/webview/ClineProvider.ts)） | ✅ 已核实：子任务摘要以 `tool_result` 注入父任务，父 loop 无缝续跑 |
| 只回摘要                                   | `attempt_completion` 的 result 字符串                                                     | ✅ 天然成立，不回传子任务完整历史 |

**新增的集成要求（采用宿主驱动工作流后）**：类型 A 专家委派时，父任务会被 **dispose → 之后 reopen**。因此：

- **工作流状态必须随父任务持久化**（不能只在内存）。
- 父任务 **reopen 时，宿主要恢复工作流循环**，把子任务摘要作为"上一轮 LLM 输出"喂回 `workflow.advance()`，拿下一步继续。

**并发**：当前委派强制**单活动任务**（父任务被 dispose）。真并行子专家（一次派多个、`Promise.all` 汇总）需重构这里，**后置**；第一阶段只做串行。

### 3.3 上下文管理（长程任务的真正瓶颈）

长程 + 多专家最先爆的是 context window。约束：

- 子专家**只向父专家汇报"结论摘要"**，不回传完整对话历史。
  → 复用 `completionResultSummary`（[history.ts](../packages/types/src/history.ts)）。
- 父专家自身也需 condense（[src/core/condense/](../src/core/condense/)）。

---

## 4. 与工作流引擎的接口契约（跨仓库边界）

工作流引擎 + 可视化编辑器在**独立仓库**实现。本文只锁定 QCode 侧需遵守的契约：

### 4.1 技术选型（已讨论结论，供外部仓库参考）

- **可视化编辑器**：[React Flow（`@xyflow/react`）](https://reactflow.dev)，装入 `webview-ui`（QCode webview 本就是 React/Vite）。
- **执行引擎**：自写**轻量 DAG 解释器**（~几百行），因为节点动作（调工具 / 跑技能 / 派子专家）只有 QCode 代码知道如何执行，通用引擎（n8n / Temporal / LangGraph）不适用，且违反 CLAUDE.md 的依赖约束。
- **图定义格式**：JSON（React Flow 原生导入/导出）。

### 4.2 工作流即技能（Workflow-as-Skill）

- 一个工作流 = 一份图 JSON 定义，**注册为 `.roo/skills` 下的技能**。
- 类型 A 专家执行时，宿主加载该工作流并按 3.1 的 `start/advance` 循环驱动。
- 类型 B 专家可在 loop 中**把工作流当成一个工具/高级动作调用**（例："走一遍标准发布流程" → 调用名为 `release-flow` 的工作流技能）。

### 4.3 接口：状态机，而非节点执行器（取代旧的 `dispatchNode`）

工作流引擎与 QCode 的边界是一个**有状态的状态机**，由 QCode 宿主调用（见 3.1）：

```
workflow.start(inputs)              -> { state, nextPrompt?, action?, done }
workflow.advance(state, lastOutput) -> { state, nextPrompt?, action?, done, finalResult? }
```

- 引擎负责**控制流**（图遍历 / 分支 / 状态推进 / 决定下一步软或硬）。
- QCode 负责**动作落地**：`nextPrompt` 走 LLM turn；`action` 由宿主直接执行（delegate / tool / skill）。
- 引擎**不直接执行 QCode 工具**，因此无需懂 QCode 内部 —— 旧的 `dispatchNode` 契约已作废。

### 4.4 节点类型词汇表（编辑器用；执行语义见上）

软/硬由工作流作者通过节点 `data.exec`（`'soft' | 'hard'`）逐节点指定，引擎只读取、不推断；缺省按类型默认：

| 节点类型    | 含义                                  | `exec` 默认 |
| ----------- | ------------------------------------- | ----------- |
| `tool`      | 调用一个 QCode 工具                    | `hard`      |
| `skill`     | 运行一个技能                          | `hard`      |
| `expert`    | 委派子专家，等待其摘要汇报            | `hard`      |
| `llm`       | 让 LLM 做一次判断 / 生成              | `soft`（恒定）|
| `condition` | 条件分支（依据上一轮输出 / 状态求值） | —           |
| `parallel`  | 并发（待 QCode 并发能力就绪后再启用） | —           |

---

## 5. 落地优先级（QCode 本会话聚焦）

1. **统一"专家"抽象**：建模为 `mode + 可选 workflow 引用 + skills`，A/B 两类都用它。
2. **先实现类型 B**：放开 Task loop 自驱，最接近现成。
3. **宿主侧工作流循环**：实现 3.1 的 `start/advance` 驱动 + `nextPrompt`/`action` 分发；引擎主体在外部仓库。
4. **专家间协作先串行**，结果只回传摘要；含委派 reopen 时**恢复工作流循环**（3.2）。
5. **最后再上并行子专家**（需重构单活动任务模型）。

---

## 6. 已识别的关键风险 / 待办

- ✅ **父专家恢复后继续决策**已核实可用（`reopenParentFromDelegation`，3.2）。
- ⚠️ **工作流状态持久化 + reopen 恢复循环**：类型 A 委派时父任务 dispose→reopen，工作流状态须随 task 存盘并在 reopen 时恢复（3.2，新增集成点）。
- ⚠️ **并发**需重构单活动任务模型（委派时父任务被 dispose），不要在第一阶段碰。
- ⚠️ **上下文膨胀**：必须强制"子专家只回摘要"，否则父专家上下文爆炸。
- 🔗 **跨仓库契约**：`start/advance` 状态机接口（4.3）+ 节点词汇表（4.4）是两仓库共同依赖，**先冻结再开发**。

---

## 附：相关现有文件索引

- 核心循环：[src/core/task/Task.ts](../src/core/task/Task.ts)
- 子任务派生：[src/core/tools/NewTaskTool.ts](../src/core/tools/NewTaskTool.ts)
- 委派 / 任务栈：[src/core/webview/ClineProvider.ts](../src/core/webview/ClineProvider.ts)
- 任务层级类型：[packages/types/src/history.ts](../packages/types/src/history.ts)
- 模式 → 工具过滤：[src/core/prompts/tools/filter-tools-for-mode.ts](../src/core/prompts/tools/filter-tools-for-mode.ts)
- 模式定义：[.roomodes](../.roomodes)
- 上下文压缩：[src/core/condense/](../src/core/condense/)
