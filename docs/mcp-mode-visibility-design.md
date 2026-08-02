# 模式级 MCP 可见性（子代理专业工具分层）设计

> 状态：已实现（方案 A 落地，提交 `150b5c82c`）
> 日期：2026-07-08
> 基线：`QC/Wittgenstein` @ `28adf2102`
> 失效条件：①后续需求变化时更新本文；②子代理架构方向若被推翻，本文按 `freeze-2026-07.md` 的封存机制处理。
> 关联：`expert-squad-design.md`（群组模式总设计，§5 引用本文）、`freeze-2026-07.md`（封存记录）、`unity-pro-mcp-design.md`（服务器侧储备稿）、`approval-mechanism-design.md`（审批与可见性的关系）

## 1. 背景与目标

2026-07-07 讨论定下的分工架构：

- **主流程**保持精干，判断与分析能力优先，不背专业工具的提示词负担；
- **专业子代理**（如 unity-context 模式）通过子任务承接领域查询/操作，工具箱 = 1-2 个通用工具 + 专业 MCP 全量工具；
- **专业 MCP 服务器**（Unity/Cocos 专业工具、按 mtime 缓存解析结果）由用户在**独立项目**实现，QCode 不做（见附录 A 契约参考、`unity-pro-mcp-design.md`）；
- 主任务经 `new_task` 派单给子代理，子代理直接执行工具、`attempt_completion` 摘要回填。**子任务不再嵌套开子任务**（挂起/恢复见 §7）。

上述链路里，QCode 现有机件（`new_task` 带模式参数、`.roomodes` 定制模式、摘要回填、L1 沙盒对切模式/开子任务的自动放行）都已具备，**唯一缺口**：MCP 工具对模式是"全有或全无"——专业服务器一接入，几十个工具的 schema 会进入**所有**带 `mcp` 组模式的每轮请求，主流程被灌满。本设计只补这一个通用机制：**让 MCP 服务器的工具可以只对指定模式可见**。

## 2. 现状（问题定位）

注入链（每轮请求的 tools 数组）：

1. [`build-tools.ts`](../src/core/task/build-tools.ts) `buildNativeToolsArrayWithRestrictions()` →
2. [`native-tools/mcp_server.ts`](../src/core/prompts/tools/native-tools/mcp_server.ts) `getMcpServerTools(mcpHub)`：把所有已连接服务器的全部工具生成原生工具定义，命名 `mcp--{server}--{tool}`（`buildMcpToolName`，64 字符截断）→
3. [`filter-tools-for-mode.ts:437`](../src/core/prompts/tools/filter-tools-for-mode.ts) `filterMcpToolsForMode()`：**只检查** `use_mcp_tool` 是否属于该模式的组——模式有 `mcp` 组则全量放行，没有则全空。**没有按服务器区分的能力。**

执行链：模型发 `mcp--server--tool` → [`NativeToolCallParser.ts:1041`](../src/core/assistant-message/NativeToolCallParser.ts) `parseDynamicMcpTool()` 解析出 `McpToolUse{serverName, toolName}` → [`presentAssistantMessage.ts:107`](../src/core/assistant-message/presentAssistantMessage.ts) `case "mcp_tool_use"` 执行。

可参照的先例：

- **组选项模式**：`groupEntrySchema = union(组名, [组名, 选项])`，现有选项 `fileRegex`/`description`（[`packages/types/src/mode.ts:10,38`](../packages/types/src/mode.ts)）；执行侧强制在 [`validateToolUse.ts:206`](../src/core/tools/validateToolUse.ts)（edit + fileRegex → `FileRestrictionError`）。
- **服务器配置 schema**：[`McpHub.ts:67`](../src/services/mcp/McpHub.ts) `BaseConfigSchema`（含 `alwaysAllow`），三种传输类型共用。

相关但**不是**本设计的既有开关（均为全局，非按模式）：工具级 `enabledForPrompt`、服务器级 `disabled`、审批级 `alwaysAllow`。

## 3. 方案选型：可见性声明放在哪一侧（待拍板）

两案解决同一个问题，机制内核相同（§4），差别只在**白名单声明在哪份配置里、由谁维护**。

### 3.1 方案 A：服务器侧声明 `modes`（"服务器挑模式"）

**Schema**：`McpHub.ts` 的 `BaseConfigSchema` 增加：

```ts
modes: z.array(z.string()).min(1).optional(),   // 该服务器工具仅对这些模式可见；未设置 = 全部模式
```

空数组由 `min(1)` 拒绝（`validateServerConfig` 报错回显），避免"想全隐藏却写 `[]`"的歧义——全隐藏用现有 `disabled`。

**配置**（`mcp_settings.json` / `.roo/mcp.json` 的服务器条目）：

```json
{
	"mcpServers": {
		"unity-pro": {
			"command": "...",
			"modes": ["unity-context"]
		}
	}
}
```

**语义**：`modes` 未设置 = 所有带 `mcp` 组的模式可见（零影响，向后兼容）；非空数组 = 仅列出的模式可见；空数组 = 服务保留但暂不分配给任何模式。空数组让配置 UI 可以取消最后一个 Mode，而不会意外退回“全模式可见”。

**效果**：一处声明，unity-pro 即从主流程和其他所有模式（含内置模式）消失，只在 unity-context 出现。其他任何模式、任何服务器配置都不用动。

**配套的模式定义**（`.roomodes`，注意 `groups` 就是普通 `mcp`）：

```yaml
customModes:
    - slug: unity-context
      name: 🎮 Unity Context
      roleDefinition: >-
          你是 Unity 工程查询专家。用 unity-pro 工具直接查询，禁止通读大文件猜测。
          返回给上级的必须是蒸馏后的结论，不要粘贴原始 YAML。
      whenToUse: Unity 场景/prefab 结构、资产引用、guid 解析等工程查询任务
      groups: ["read", "mcp"]
```

**代价**：模式定义不自解释——光看 unity-context 的条目看不出它独享 unity-pro，要交叉查 MCP 配置才知道全貌。

### 3.2 方案 B：模式侧组选项 `servers`（"模式挑服务器"）

**Schema**：`packages/types/src/mode.ts` 的 `groupOptionsSchema` 增加：

```ts
servers: z.array(z.string()).min(1).optional(),   // 仅对 "mcp" 组条目有意义；该模式只见列出的服务器
```

出现在非 `mcp` 组条目上时忽略（与 `fileRegex` 出现在非 `edit` 组同样处理：schema 允许、强制逻辑只在对应组读取）。

**配置**（`.roomodes`）：

```yaml
customModes:
    - slug: unity-context
      name: 🎮 Unity Context
      roleDefinition: >-
          你是 Unity 工程查询专家。用 unity-pro 工具直接查询，禁止通读大文件猜测。
          返回给上级的必须是蒸馏后的结论，不要粘贴原始 YAML。
      whenToUse: Unity 场景/prefab 结构、资产引用、guid 解析等工程查询任务
      groups: ["read", ["mcp", { "servers": ["unity-pro", "常用公共服务器..."] }]]
```

**语义**：`mcp` 组带 `servers` 选项时，该模式只见列出的服务器；普通 `mcp`（无选项）= 全部服务器（零影响，向后兼容）。

**效果与代价（关键差异）**：unity-context 一处配置即可**给自己**收窄。但**把 unity-pro 从主流程藏掉**需要反向操作：给每个会碰到 MCP 的模式（内置 code/architect/ask/debug + 所有自定义模式）都加 override，写成 `["mcp", { "servers": ["公共服务器A", "公共服务器B", ...] }]` 枚举放行名单——而且**以后每接入一个新的公共 MCP 服务器，都要回头改所有这些 override**，否则新服务器对它们不可见。内置模式支持同 slug override，机制上可行，但配置面随模式数 × 服务器变更次数增长。

**收益**：模式定义完全自解释（一个模式能见什么，条目里一目了然）；与 `fileRegex` 组选项先例同型，schema 与执行侧强制照抄现有模式；`filterMcpToolsForMode` 不需要新增 `mcpHub` 参数（白名单直接来自模式配置）。另外它更通用——任何模式都能主动收窄自己（例如让某个受限模式只见文档类 MCP）。

### 3.3 对比与推荐

| 维度                   | A 服务器侧 `modes`                                      | B 模式侧 `servers`                       |
| ---------------------- | ------------------------------------------------------- | ---------------------------------------- |
| 隐藏专业服务器的配置量 | **1 处**（服务器条目）                                  | N 处（其他每个模式都要 override）        |
| 新增公共服务器时       | 无需改动                                                | 须回改所有带 `servers` 的模式            |
| 模式定义可读性         | 不自解释，需交叉查 MCP 配置                             | **自解释**，模式条目即全貌               |
| 先例契合               | `BaseConfigSchema` 已聚集 `alwaysAllow` 等策略字段      | **同型复用** edit+`fileRegex` 组选项先例 |
| 实现差异               | 过滤函数需拿 `mcpHub`（调用处现成）                     | 过滤函数只读模式配置，依赖更少           |
| 通用性                 | 只表达"服务器限定模式"                                  | 模式可自主收窄，场景更广                 |
| 声明文件               | `mcp_settings.json`（全局）或 `.roo/mcp.json`（项目级） | `.roomodes`（项目级）或全局自定义模式    |

**推荐 A**，理由一句话：本次的驱动场景是"专业服务器只给专家模式"，A 让声明跟着服务器走、一处生效；B 在这个场景下的结构性弱点是"隐藏"要靠**其他所有模式**各自设限，且随公共服务器增减持续付维护费。若更看重"模式定义自解释"、或预期常有"通用模式想自主收窄"的需求，B 也成立。

**两案可叠加**（都实现时语义为交集：可见 ⇔ 服务器侧允许该模式 ∧ 模式侧允许该服务器），但 v1 建议只选一个，控制测试矩阵；都做约 +0.5-1 天（过滤逻辑共享，多在 schema 与测试）。

## 4. 实现设计（A/B 通用内核）

以下机制两案共用，唯一差异是**白名单来源**：A 来自服务器配置的 `modes`，B 来自当前模式 `mcp` 组的 `servers` 选项。统一抽成判定函数：

```ts
isServerVisibleToMode(serverName, modeSlug, { mcpHub?, modeConfig }): boolean
```

### 4.1 注入侧过滤（主路径）

`filterMcpToolsForMode()`（[`filter-tools-for-mode.ts:437`](../src/core/prompts/tools/filter-tools-for-mode.ts)）扩展：

1. 原有检查不变：模式无 `mcp` 组 → 返回空。
2. 新增：对不可见的服务器，计算名称前缀 `mcp--{sanitizeMcpName(server.name)}--`，从工具定义数组剔除匹配前缀的条目。（方案 A 需在 [`build-tools.ts:129`](../src/core/task/build-tools.ts) 调用处多传 `mcpHub`，已在手；方案 B 无签名变化。）

用**前缀匹配**而非 `parseMcpToolName` 全解析：`buildMcpToolName` 有 64 字符截断，截断只可能伤到 tool 段，前缀（`mcp--server--`）总是完整的，前缀匹配对截断名安全。

Gemini 的 `includeAllToolsWithRestrictions` 路径无需单改：`allowedFunctionNames` 派生自过滤后的 `filteredTools`，自动继承（`allTools` 仍含全量定义，只影响历史工具调用的引用，不影响可调用集）。

### 4.2 执行侧兜底（防御纵深）

模型可能从对话历史里模仿出被过滤服务器的工具名。在 [`presentAssistantMessage.ts:107`](../src/core/assistant-message/presentAssistantMessage.ts) `case "mcp_tool_use"` 执行前调 `isServerVisibleToMode()`：不可见 → 不执行，返回工具错误结果，文案指路："服务器 X 的工具对当前模式不可见；如需其能力，请用 new_task 开启对应模式的子任务"。（这句文案本身就是给主模型的委派路由提示，一石二鸟。）

比较时服务器名统一过 `sanitizeMcpName` 后比对，避免原始名与工具名解析出的 sanitized 名不一致。

旧式 `use_mcp_tool` 通道若在本 fork 仍可达（实现时确认），在同一判定函数上用 `server_name` 参数做相同检查（方案 B 时即 [`validateToolUse.ts:206`](../src/core/tools/validateToolUse.ts) fileRegex 强制的同位置、同写法）。

### 4.3 系统提示词文案

`system.ts` 的 MCP 相关段落（capabilities 等）按同一过滤给出服务器列表（实现时核实该段是否逐服务器列名；若只有泛述则不动）。

### 4.4 零影响保证

未使用新字段时（A：服务器无 `modes`；B：`mcp` 组无 `servers` 选项），注入与执行行为**逐字不变**。照 `checkAutoApproval` 叠加层的纪律，用 zero-impact 测试组锁定（见 §6）。

## 5. 配套配置（纯配置，不计开发量）

- **unity-context 模式定义**：见 §3.1（方案 A 配法）/ §3.2（方案 B 配法），`whenToUse` 供主流程 `new_task` 选模式时参考。
- **路由**：`.roo/rules/rules.md` 加一行委派指引："涉及 Unity 序列化文件（.unity/.prefab/.asset）的结构、引用、guid 问题，开 unity-context 子任务处理，不要直接通读文件。"
- **审批**：unity-pro 的只读查询工具加进该服务器 `alwaysAllow`；L1 沙盒下切模式/开子任务已自动放行，整条委派链零弹窗。**可见性与审批正交**：看得见 ≠ 免批，二者各自独立生效。

## 6. 测试计划

Schema 校验（按所选方案）：A：`modes` 合法/空数组表示未分配/缺省通过；B：`servers` 合法/空数组拒绝/缺省通过/出现在非 mcp 组时忽略。

`filterMcpToolsForMode`（新增用例）：

- zero-impact 组：未用新字段时输出与改动前逐字一致；模式无 `mcp` 组仍全空。
- 过滤组：白名单命中/未命中；多服务器混合；截断名前缀匹配；sanitized 名（含空格/特殊字符服务器名）；（B）内置模式 override 生效。
- Gemini 路径：`allowedFunctionNames` 不含被过滤服务器工具，`allTools` 仍含全量。

执行侧：`mcp_tool_use` 对不可见服务器返回错误结果且不触发 `McpHub.callTool`；错误文案含委派指引。

## 7. 以后（不做本次）

- **子任务挂起/恢复**（2026-07-07 用户提出，记录防丢）：子任务做到一半发现自己解决不了，向主任务汇报"需要什么帮助"后挂起；主任务处理（自己做或另开子任务），完成后恢复原子任务续跑。防死锁要点：①保持严格树形——子只向父求助，禁止横向等待兄弟任务；②"任意时刻恰有一个活跃任务"不变量（现有子任务栈天然满足，挂起/恢复须保持）；③求助处理期间父不得向挂起中的子任务发新请求，恢复必须显式；④挂起深度/时长上限兜底。依赖 task-persistence 已有的任务栈持久化。
- **A/B 中未选中的另一案**及**叠加语义**（交集，见 §3.3）：等真实需求。
- **工具级白名单**（服务器内再挑工具）：服务器本身按专业域拆分已够用，等真实需求。
- **read_file 拦截路由**（读到 Unity 大文件时提示开子任务）：属于引擎资产上下文方向，另行评估。

## 8. 实施步骤与估时（选型后动工）

1. Schema（A：`BaseConfigSchema.modes`；B：`groupOptionsSchema.servers`）+ 校验测试 — 0.5 天
2. `isServerVisibleToMode` + `filterMcpToolsForMode` 扩展 + `build-tools` 接线 + 注入侧测试 — 1 天
3. 执行侧兜底 + 测试 — 0.5 天
4. `.roomodes` 样例、规则行、设置文档说明（含 i18n 如涉及用户可见文案）— 0.5 天

单选 A 或 B 均为 2-3 天，纯宿主侧，不碰 webview（MCP 设置界面若要展示新字段，另立 P2）；A+B 都做约 +0.5-1 天。

## 附录 A：unity-pro MCP 工具契约参考（非约束，服务器归属用户独立项目）

详见 `unity-pro-mcp-design.md`。要点：查询五件套（`outline`/`subtree`/`resolve`/`refs`/`find`，只读建议 `alwaysAllow`）；操作类走审批；服务器进程内按文件 mtime 缓存；工具 description 第一句回答"何时用我"。

## 变更记录

- 2026-07-07 创建（基线 `e877fdeaf`）：方案 A 设计稿，待审核。
- 2026-07-07 补全方案 B 至与 A 对称（schema/配置/效果代价/对比表 §3.1-§3.3），§4 重构为 A/B 通用内核，供选型。
- 2026-07-08 方案 A 已实现（提交 `150b5c82c`）：`BaseConfigSchema.modes` 字段 + `filterMcpToolsForMode` 注入侧过滤 + `presentAssistantMessage` 执行侧兜底 + 16 单测。`isServerVisibleToMode` / `parseServerModes` 为新增辅助函数，`filterMcpToolsForMode` 新增可选 `mcpHub` 参数（缺省时零影响）。方案 B 未实现，如需要可后续追加。
