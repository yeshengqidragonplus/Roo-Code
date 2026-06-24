# 工作流引擎（Workflow Engine）—— 跨仓库交接文档

> 状态：交接稿（handoff）
> 读者：在**独立 git 仓库 / 独立会话**中开发工作流引擎与可视化编辑器的人。
> 配套：QCode 侧设计见 `expert-system-design.md`（专家系统）。本文自包含，无需读 QCode 源码即可开工，但**第 4 章的对接契约必须与 QCode 侧保持一致**。

---

## 1. 目的（这个东西到底解决什么）

QCode（一个 Roo Code 的 VS Code 扩展 fork）要支持**长程任务**，任务分两类：

- **类型 A — 确定型**：流程已固化，按预定义工作流执行。**← 本工作流引擎服务于这一类。**
- **类型 B — 探索型**：无固定流程，LLM 自驱 loop（由 QCode 直接处理，不在本仓库范围）。

工作流引擎要达成三件事：

1. **可视化编辑**：用户能拖拽节点、连线、配参数，画出一条工作流。
2. **可执行**：把画好的图跑起来，每个节点驱动 QCode 去调工具 / 跑技能 / 派子专家 / 让 LLM 判断。
3. **可被复用为"技能/工具"**：一条工作流可以独立运行，也可以被一个探索型专家（类型 B）当成"一个高级动作"调用。

> 一句话：**让"已知怎么做"的流程，变成可视化编排、可执行、可被当技能调用的资产。**

---

## 2. 架构：两层，不要找大而全的现成产品

工作流系统拆成两个解耦的层。**不要引入 n8n / Node-RED / Temporal / LangGraph 这类重型产品**——它们是独立 server / 自带世界观，嵌进 VS Code 扩展是反模式，且它们的节点不认识 QCode 的"专家/技能/工具"。

| 层                 | 做法             | 选型                                                              |
| ------------------ | ---------------- | ----------------------------------------------------------------- |
| **① 可视化编辑器** | 节点式画布 UI    | **React Flow（`@xyflow/react`）**，MIT 协议，节点式编辑器事实标准 |
| **② 执行引擎**     | 有状态的状态机   | **自写轻量状态机**（约几百行），**不直接执行 QCode 工具**         |

**核心模型：LLM 为主，工作流为"导演"。** 工作流**不代替 LLM 执行动作**，而是被 QCode 宿主每个 turn 之前调用一次，返回"下一步该做什么"。LLM 始终是行动者、系统提示词不变；工作流只约束方向——像导演给演员递分镜，演员仍自己演。

因此引擎很薄：维护一个状态、根据"上一轮 LLM 输出"推进、决定下一步是**让 LLM 干**（返回提示词）还是**让宿主机械执行**（返回结构化指令）。它**无需懂 QCode 内部如何执行工具**（这正是和早期"引擎执行节点"设计的关键区别）。

---

## 3. 数据模型

### 3.1 图定义格式 = JSON

直接用 React Flow 的原生导入/导出格式（`nodes[] + edges[]`），不另造格式。一条工作流就是一份 JSON。

### 3.2 节点类型词汇表（★ 必须三方冻结后再开工 ★）

这是**编辑器、执行引擎、QCode 三方共同依赖的地基**。开发前先冻结这张表。

每个节点执行时，引擎选择**软**（返回 `nextPrompt` 给 LLM）或**硬**（返回 `action` 让宿主直接执行，不花 LLM turn）——见第 4 章。

| `type`      | 含义                     | 节点 `data` 关键字段                        | 软/硬           |
| ----------- | ------------------------ | ------------------------------------------- | --------------- |
| `tool`      | 调用一个 QCode 工具      | `toolName`, `params`                        | 可软可硬        |
| `skill`     | 运行一个技能             | `skillName`, `args`                         | 可软可硬        |
| `expert`    | 委派子专家并等待其汇报   | `expertId/mode`, `subtaskPrompt`            | 可软可硬        |
| `llm`       | 让 LLM 做一次判断 / 生成 | `prompt`, `outputSchema?`                   | 软              |
| `condition` | 条件分支                 | `expression`（依据状态 / 上一轮输出求值）   | 引擎内部，无 IO |
| `parallel`  | 并发执行多分支           | —（**先占位，QCode 并发能力就绪前不启用**） | —               |

> 节点间数据传递：每个节点执行后产出结果并写入工作流状态，下游节点（尤其 `condition` / `llm`）可引用。建议约定简单引用语法（如 `{{nodeId.output}}`），三方统一。

### 3.3 工作流元数据

每份工作流 JSON 顶层带：`name`、`description`、`version`、`inputs`（启动参数）、`nodes`、`edges`。`name`/`description` 用于注册成技能时的展示与触发。

---

## 4. 对接契约（与 QCode 的边界）★ 核心 ★

工作流引擎**不直接操作 QCode 内部**，只通过下面两个约定与 QCode 交互。

### 4.1 工作流即技能（Workflow-as-Skill）

- 一条工作流 JSON **注册为 QCode `.roo/skills` 下的一个技能**（数据驱动，无需改 QCode 代码）。
- 注册后两种用法：
    - **独立运行**：作为类型 A 专家的执行体。
    - **被调用**：类型 B 探索型专家在自驱 loop 中把它当一个工具调用（例："走一遍 `release-flow`"）。

### 4.2 引擎接口：有状态的状态机（由 QCode 宿主调用）

引擎暴露两个方法，**由 QCode 宿主每个 turn 之前调用**。`state` 是引擎自己的不透明 JSON，QCode 只负责随 task 持久化、不解读其内部：

```
workflow.start(inputs)              -> { state, nextPrompt?, action?, done }
workflow.advance(state, lastOutput) -> { state, nextPrompt?, action?, done, finalResult? }
```

每次返回，`nextPrompt` 与 `action` **二选一**（done 时都为空，给 finalResult）：

- `nextPrompt`（**软**）：给 LLM 的指示文本，宿主注入后走一个 LLM turn，把 LLM **最终文本**作为 `lastOutput` 喂回 `advance`。
- `action`（**硬**）：结构化指令，宿主直接执行、**不花 LLM turn**，把执行结果作为 `lastOutput` 喂回：
    - `{ type:"delegate", expert, goal }` —— 硬触发委派子专家
    - `{ type:"tool", name, params }` —— 机械调工具
    - `{ type:"skill", name, args }` —— 机械跑技能

宿主分发逻辑：

```
{ state, nextPrompt, action, done } = workflow.advance(state, lastOutput)
if (done)        finish(finalResult)
else if (action) → 宿主直接执行 → 拿结果 → 立刻再 advance（无 LLM turn）
else if (prompt) → 注入 LLM（system 不变）→ runOneTurn → 收割最终文本 → 再 advance
```

> **职责边界**：引擎 = 控制流 + 状态（决定下一步软或硬）；QCode = 动作落地（LLM turn / delegate / tool / skill）。引擎**绝不直接调 QCode 工具**。
>
> ⚠️ 旧版本的 `dispatchNode(node, context)` 入口**已作废**，改为上面的状态机接口。

### 4.3 约束（来自 QCode，必须遵守）

- **禁止引入 AI-SDK / `@ai-sdk/*` / `ai` 依赖**（QCode 刻意不用）。
- **第一阶段不做并发**：`expert`/`parallel` 先按**串行**实现（QCode 当前委派会 dispose 父任务，单活动任务模型，并发需后续重构）。`parallel` 可在编辑器占位，执行先降级串行或禁用。
- **子专家只回传"结论摘要"**，不回传完整对话历史（防上下文爆炸）。
- **委派会触发父任务 dispose→reopen**：QCode 侧须在 reopen 时把工作流 `state` 取回、用子专家摘要作为 `lastOutput` 调 `advance` 续跑。引擎只需保证 `state` 可序列化、`advance` 可从任意持久化的 `state` 恢复（**无隐式内存依赖**）。

---

## 5. 建议的里程碑

1. **冻结状态机接口（4.2）+ 节点词汇表（3.2）+ 图 JSON schema（3.3）** —— 三方对齐，先于一切编码。
2. **可视化编辑器 MVP**：React Flow 画布 + 上述节点类型 + 导出/导入 JSON。
3. **执行引擎 MVP**：实现 `start`/`advance` 状态机——读 JSON、维护 `state`、按节点产出 `nextPrompt` 或 `action`、`condition` 分支。`state` 必须可序列化、可从持久化值恢复（4.3）。用一个模拟宿主（mock LLM/action 执行）跑通控制流。
4. **与 QCode 对接**：把模拟宿主换成 QCode 真实宿主循环，工作流注册为 skill（4.1）。
5. **闭环验证**：画一条混合软硬步骤的工作流（如 硬 read → 软 llm 判断 → 硬 delegate）→ 注册为技能 → 由一个类型 A 专家跑通，含委派 reopen 续跑。
6. （后续）并发节点、子专家并行 —— 待 QCode 重构单活动任务模型后。

---

## 6. 两个会话的协同点（重要）

- **状态机接口（4.2）+ 节点词汇表（3.2）** 是 QCode 会话与本会话的**共享契约**，任一方改动都要同步。建议作为唯一事实来源（single source of truth），两边都引用它。
- QCode 侧第一阶段交付：**统一专家抽象 + 类型 B 自驱 loop + 宿主侧 `start/advance` 循环（`nextPrompt`/`action` 分发）+ 串行子专家 + 委派 reopen 时恢复工作流循环**。本仓库可在 QCode 宿主就绪前，用模拟宿主先行开发到里程碑 3。
