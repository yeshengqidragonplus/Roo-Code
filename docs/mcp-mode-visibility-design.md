# 模式级 MCP 可见性（子代理专业工具分层）设计

> 状态：设计稿（待审核，审核通过后动工）
> 日期：2026-07-07
> 基线：`QC/Wittgenstein` @ `e877fdeaf`
> 失效条件：①实现落地后本文状态改"已实现"，偏差另立小节；②子代理架构方向若被推翻，本文按 `freeze-2026-07.md` 的封存机制处理。
> 关联：`freeze-2026-07.md`（§1 下一目标评估）、`approval-mechanism-design.md`（审批与可见性的关系）

## 1. 背景与目标

2026-07-07 讨论定下的分工架构：

- **主流程**保持精干，判断与分析能力优先，不背专业工具的提示词负担；
- **专业子代理**（如 unity-context 模式）通过子任务承接领域查询/操作，工具箱 = 1-2 个通用工具 + 专业 MCP 全量工具；
- **专业 MCP 服务器**（Unity/Cocos 专业工具、按 mtime 缓存解析结果）由用户在**独立项目**实现，QCode 不做（见附录 A 契约参考）；
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

## 3. 方案选型：可见性声明放在哪一侧

### 方案 A（推荐）：服务器侧声明 `modes`

在 MCP 服务器配置（`mcp_settings.json` / `.roo/mcp.json` 的服务器条目）加可选字段：

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

语义：`modes` 存在时，该服务器的工具**只对列出的模式可见**；未设置 = 所有带 `mcp` 组的模式可见（零影响，向后兼容）。

选它的理由：**使用场景是"专业服务器只给专家模式"，声明应该跟着服务器走**。一处声明生效，内置模式（code/architect/…）一个都不用改；社区 MCP 无需任何配合。若用方案 B（模式侧白名单），想把 unity-pro 从主流程藏掉，得给每个内置模式加 override——配置面爆炸。

### 方案 B（后备/可叠加）：模式侧组选项 `servers`

`groupOptionsSchema` 加 `servers?: string[]`，写法 `["mcp", { "servers": ["unity-pro"] }]`，语义：该模式只见列出的服务器。

保留为 P2 可选增强（场景：某个模式想主动收窄自己看到的服务器集合）。两方案语义可叠加：可见 = 服务器侧允许 ∩ 模式侧允许。**v1 只做方案 A**，B 不做，避免双倍测试矩阵。

## 4. 设计（方案 A）

### 4.1 Schema

`McpHub.ts` 的 `BaseConfigSchema` 增加：

```ts
modes: z.array(z.string()).optional(),   // 服务器工具仅对这些模式可见；未设置 = 全部模式
```

空数组视为配置错误（校验拒绝并报错回显，与现有 `validateServerConfig` 一致），避免"想全隐藏却写了 `[]`"的歧义——全隐藏用现有 `disabled` 或不配置该服务器。

### 4.2 注入侧过滤（主路径）

`filterMcpToolsForMode()` 扩展签名，增加 `mcpHub` 参数（[`build-tools.ts:129`](../src/core/task/build-tools.ts) 调用处已有 `mcpHub` 在手）：

1. 原有检查不变：模式无 `mcp` 组 → 返回空。
2. 新增：遍历服务器，凡 `config.modes` 存在且不含当前模式 slug 的，计算其名称前缀 `mcp--{sanitizeMcpName(server.name)}--`，从工具定义数组中剔除匹配前缀的条目。

用**前缀匹配**而非 `parseMcpToolName` 全解析：`buildMcpToolName` 有 64 字符截断，截断只可能伤到 tool 段，前缀（`mcp--server--`）总是完整的，前缀匹配对截断名安全。

Gemini 的 `includeAllToolsWithRestrictions` 路径无需单改：`allowedFunctionNames` 派生自过滤后的 `filteredTools`，自动继承（`allTools` 仍含全量定义，只影响历史工具调用的引用，不影响可调用集）。

### 4.3 执行侧兜底（防御纵深）

模型可能从对话历史里模仿出被过滤服务器的工具名。在 [`presentAssistantMessage.ts:107`](../src/core/assistant-message/presentAssistantMessage.ts) `case "mcp_tool_use"` 执行前检查：当前模式不在该服务器 `modes` 白名单内 → 不执行，返回工具错误结果，文案指路："服务器 X 的工具对当前模式不可见；如需其能力，请用 new_task 开启对应模式的子任务"。（这句文案本身就是给主模型的委派路由提示，一石二鸟。）

比较时服务器名统一过 `sanitizeMcpName` 后比对，避免原始名与工具名解析出的 sanitized 名不一致。

旧式 `use_mcp_tool` 通道若在本 fork 仍可达（实现时确认），在同一判定函数里用 `server_name` 参数做相同检查；判定逻辑抽成单一函数 `isServerVisibleToMode(serverConfig, modeSlug)` 供两处复用。

### 4.4 系统提示词文案

`system.ts` 的 MCP 相关段落（capabilities 等）按同一过滤给出服务器列表（实现时核实该段是否逐服务器列名；若只有泛述则不动）。

### 4.5 零影响保证

任何服务器未配置 `modes` 时，注入与执行行为**逐字不变**。照 `checkAutoApproval` 叠加层的纪律，用 zero-impact 测试组锁定（见 §6）。

## 5. 配套配置（纯配置，不计开发量）

### 5.1 unity-context 模式样例（`.roomodes`）

```yaml
customModes:
    - slug: unity-context
      name: 🎮 Unity Context
      roleDefinition: >-
          你是 Unity 工程查询专家。用 unity-pro 工具直接查询，禁止通读大文件猜测。
          返回给上级的必须是蒸馏后的结论（节点路径、组件、脚本路径、引用关系），
          不要粘贴原始 YAML。
      whenToUse: Unity 场景/prefab 结构、资产引用、guid 解析等工程查询任务
      groups: ["read", "mcp"]
```

`whenToUse` 供主流程 `new_task` 选模式时参考。`groups` 写普通 `mcp` 即可——unity-pro 的可见性由服务器侧 `modes: ["unity-context"]` 声明，此模式自动可见；其他公共 MCP 服务器（未配 `modes`）它也能看到，符合"1-2 个通用工具 + 专业工具"的预期。

### 5.2 路由与审批

- `.roo/rules/rules.md` 加一行委派指引："涉及 Unity 序列化文件（.unity/.prefab/.asset）的结构、引用、guid 问题，开 unity-context 子任务处理，不要直接通读文件。"
- unity-pro 的只读查询工具加进该服务器 `alwaysAllow`；L1 沙盒下切模式/开子任务已自动放行，整条委派链零弹窗。**可见性与审批正交**：看得见 ≠ 免批，二者各自独立生效。

## 6. 测试计划

`McpHub` 配置校验：合法 `modes`、空数组拒绝、缺省通过。
`filterMcpToolsForMode`（新增用例）：

- zero-impact 组：无 `modes` 配置时输出与改动前逐字一致；模式无 `mcp` 组仍全空。
- 过滤组：`modes` 命中/未命中；多服务器混合；截断名前缀匹配；sanitized 名（含空格/特殊字符服务器名）。
- Gemini 路径：`allowedFunctionNames` 不含被过滤服务器工具，`allTools` 仍含全量。

执行侧：`mcp_tool_use` 对不可见服务器返回错误结果且不触发 `McpHub.callTool`；错误文案含委派指引。

## 7. 以后（不做本次）

- **子任务挂起/恢复**（2026-07-07 用户提出，记录防丢）：子任务做到一半发现自己解决不了，向主任务汇报"需要什么帮助"后挂起；主任务处理（自己做或另开子任务），完成后恢复原子任务续跑。防死锁要点：①保持严格树形——子只向父求助，禁止横向等待兄弟任务；②"任意时刻恰有一个活跃任务"不变量（现有子任务栈天然满足，挂起/恢复须保持）；③求助处理期间父不得向挂起中的子任务发新请求，恢复必须显式；④挂起深度/时长上限兜底。依赖 task-persistence 已有的任务栈持久化。
- **方案 B**（模式侧 `servers` 组选项）与**工具级白名单**（服务器内再挑工具）：等真实需求。
- **read_file 拦截路由**（读到 Unity 大文件时提示开子任务）：属于引擎资产上下文方向，另行评估。

## 8. 实施步骤与估时（审核通过后）

1. `BaseConfigSchema.modes` + 配置校验测试 — 0.5 天
2. `filterMcpToolsForMode` 扩展 + `build-tools` 接线 + 注入侧测试 — 1 天
3. 执行侧兜底 + 测试 — 0.5 天
4. `.roomodes` 样例、规则行、设置文档说明（含 i18n 如涉及用户可见文案）— 0.5 天

合计 2-3 天，纯宿主侧，不碰 webview（MCP 设置界面若要展示 `modes` 字段，另立 P2）。

## 附录 A：unity-pro MCP 工具契约参考（非约束，服务器归属用户独立项目）

QCode 侧不依赖具体工具集，以下仅为配套建议，供服务器实现参考：

- 查询类（建议 `alwaysAllow`）：`outline(file)` 层级大纲、`subtree(file, node)` 节点组件详情（guid/fileID 已解析）、`resolve(guid|path)` 双向换算、`refs(asset)` 反向引用、`find(name|type)` 按名/类型搜节点。
- 操作类（走审批）：改组件字段、挂/卸组件等编辑器写操作。
- 服务器进程内按**文件 mtime** 缓存解析结果（QCode 不感知缓存）。
- 工具 description 用一句话说清"何时用我"，子代理的工具选择全靠它。

## 变更记录

- 2026-07-07 创建（基线 `e877fdeaf`）：方案 A 设计稿，待审核。
