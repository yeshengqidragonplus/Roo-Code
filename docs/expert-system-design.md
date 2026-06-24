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

### 3.1 共享内核

两类专家底层都是同一个 **Task loop**（[Task.ts](../src/core/task/Task.ts)）：观察 → 决策下一步工具 → 执行 → 再观察。

- **类型 B** = 直接放开该 loop，由 LLM 每步动态决策（QCode 现状最接近，几乎现成）。
- **类型 A** = 在 loop 外套一层 **workflow 引擎**，由引擎决定"这一步给 LLM 什么子目标 / 调哪个工具"，LLM 只负责节点内的局部智能。

工具、技能、子专家派遣等能力两类**共用**，不重复实现。

### 3.2 子专家派遣与汇报（最核心、最难的一环）

需要三个能力，对应 QCode 现状：

| 能力                                               | QCode 现状                                                                               | 备注      |
| -------------------------------------------------- | ---------------------------------------------------------------------------------------- | --------- |
| 派生子专家                                         | `new_task`（[NewTaskTool.ts](../src/core/tools/NewTaskTool.ts)）                         | ✅ 已有   |
| 子专家完成后回填结果                               | `delegateParentAndOpenChild`（[ClineProvider.ts](../src/core/webview/ClineProvider.ts)） | ✅ 已有   |
| 父专家拿到汇报后**继续自己的决策**（而非直接结束） | 需确认 / 可能要改恢复逻辑                                                                | ⚠️ 待验证 |

**并发决策**：当前 `clineStack`（LIFO 任务栈）本质是**单活动任务**，只能串行。

- **第一阶段先做串行版**（QCode 现成），把"专家协作"整链路跑通。
- 并行子专家（一次派多个、`Promise.all` 汇总）属于较大重构，**后置**。

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
- 类型 A 专家执行时，引擎读该 JSON，驱动 Task loop。
- 类型 B 专家可在 loop 中**把工作流当成一个工具/高级动作调用**（例："走一遍标准发布流程" → 调用名为 `release-flow` 的工作流技能）。

### 4.3 节点类型词汇表（编辑器与执行引擎的共同地基）

执行引擎的 dispatch 分支与编辑器的可拖拽节点一一对应：

| 节点类型    | 含义                                  |
| ----------- | ------------------------------------- |
| `tool`      | 调用一个 QCode 工具                   |
| `skill`     | 运行一个技能                          |
| `expert`    | 派生子专家，等待其汇报                |
| `llm`       | 让 LLM 做一次判断 / 生成              |
| `condition` | 条件分支                              |
| `parallel`  | 并发（待 QCode 并发能力就绪后再启用） |

> QCode 侧需提供稳定的"按节点类型 dispatch 到 tool/skill/new_task"的执行入口，供外部引擎调用。

---

## 5. 落地优先级（QCode 本会话聚焦）

1. **统一"专家"抽象**：建模为 `mode + 可选 workflow 引用 + skills`，A/B 两类都用它。
2. **先实现类型 B**：放开 Task loop 自驱，最接近现成。
3. **轻量 workflow 引擎对接**（引擎主体在外部仓库；QCode 提供节点 dispatch 入口）。
4. **专家间协作先串行**，结果只回传摘要。
5. **最后再上并行子专家**（需重构 `clineStack` 单活动任务模型）。

---

## 6. 已识别的关键风险 / 待办

- ⚠️ **父专家恢复后继续决策**的逻辑需验证（3.2）。
- ⚠️ **并发**需重构单活动任务模型（`clineStack`），不要在第一阶段碰。
- ⚠️ **上下文膨胀**：必须强制"子专家只回摘要"，否则父专家上下文爆炸。
- 🔗 **跨仓库契约**：节点类型词汇表（4.3）是编辑器/引擎/QCode 三方共同依赖，**先冻结再开发**。

---

## 附：相关现有文件索引

- 核心循环：[src/core/task/Task.ts](../src/core/task/Task.ts)
- 子任务派生：[src/core/tools/NewTaskTool.ts](../src/core/tools/NewTaskTool.ts)
- 委派 / 任务栈：[src/core/webview/ClineProvider.ts](../src/core/webview/ClineProvider.ts)
- 任务层级类型：[packages/types/src/history.ts](../packages/types/src/history.ts)
- 模式 → 工具过滤：[src/core/prompts/tools/filter-tools-for-mode.ts](../src/core/prompts/tools/filter-tools-for-mode.ts)
- 模式定义：[.roomodes](../.roomodes)
- 上下文压缩：[src/core/condense/](../src/core/condense/)
