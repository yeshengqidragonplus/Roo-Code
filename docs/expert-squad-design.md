# 群组模式设计文档（Expert Squad）

> 状态：设计稿（待审核）
> 日期：2026-07-08
> 基线：`QC/Wittgenstein` @ `1dbdfa401`
> 失效条件：①实现落地后状态改"已实现"，偏差另立小节；②架构方向被推翻时按 `freeze-2026-07.md` 封存机制处理。
> 关联：`expert-system-design.md`（专家系统总设计，类型 B 自驱专家）、`mcp-mode-visibility-design.md`（MCP 工具可见性）、`freeze-2026-07.md`（封存记录）

---

## 1. 背景与目标

### 1.1 问题

当前模式是扁平的：每个模式独立工作，模式间协作靠 LLM 自主 `new_task` 派单。但实际项目（尤其游戏开发）需要**编队协作**：

- 带头人（组织者）负责任务分解、调度、验收，不直接做专业工作
- 专业子代理（图片分析、Unity 工程查询、测试、调试等）各有专长，各有专业工具
- 不同子代理可能用**不同的大模型**（如图片分析需要支持 vision 的模型，代码生成用文本模型）
- 主任务不需要知道子代理怎么做，只需对接需求和交付规则

现有机制（[`new_task`](../src/core/tools/NewTaskTool.ts) + [`delegateParentAndOpenChild`](../src/core/webview/ClineProvider.ts:2968) + 摘要回填）已支撑串行委派，但缺少：模式绑定模型、子代理工具隔离、图片跨模型传递、模式可见性控制。

### 1.2 核心理念：CEO 模型

> 主任务就是公司 CEO，子代理就是各部门负责人。CEO 让财务出报表，具体财务用什么工具、怎么做是财务自己的事。CEO 只管需求和交付，大局上把控住。子代理能力如何不需要主任务决定，主任务在 3-5 次（可配置）使用子代理得不到结果时停下来告诉用户，用户来打磨每个专业代理的能力。

设计原则：

1. **主任务不管子代理怎么做** -- 不检查子代理工具配置，不干预执行过程
2. **子代理自治** -- 自己决定用什么工具、怎么做，只向主任务交付结论摘要
3. **子代理不嵌套** -- 不能互相派单，只能向主任务交付
4. **专业工具隔离** -- 各子代理只看到自己的专业工具，不污染其他模式的上下文

### 1.3 三种模式类型

| 类型               | `kind`       | 选择器可见    | 能否派单     | 说明                                  |
| ------------------ | ------------ | ------------- | ------------ | ------------------------------------- |
| 普通模式           | `autonomous` | ✅            | 否           | code/ask/debug 等，独立工作           |
| 流程模式           | `workflow`   | ✅            | 硬步骤可委派 | 绑定工作流图，本次暂不涉及            |
| 群组模式（带头人） | `autonomous` | ✅            | ✅           | 组织者，`roleDefinition` 描述路由策略 |
| 群组成员（子代理） | `autonomous` | ❌ (`hidden`) | ❌           | 预先创建，被带头人 `new_task` 调用    |

群组模式和群组成员在 `kind` 上都是 `autonomous`（都是 LLM 自驱），区别在于：

- **带头人**：`roleDefinition` 描述路由策略 + `groups` 包含能触发 `new_task` 的组
- **子代理**：`hidden: true`（不在选择器显示）+ `roleDefinition` 约束"不开子任务"

---

## 2. 架构总览

```
用户对话（带头人模式）
  │
  ├─ 用户上传图片 -> [图片: pic_a1b2c3]（image-cleaning 注入标识）
  │
  ├─ 带头人 LLM 决策：需要图片分析
  │   └─ new_task(mode=image-analyzer, message="分析 pic_a1b2c3")
  │       ├─ 解析 pic_a1b2c3 -> 查父任务历史 -> 取图片 dataUrl
  │       ├─ delegateParentAndOpenChild:
  │       │   ├─ handleModeSwitch("image-analyzer")
  │       │   │   └─ 读 apiProfile -> 强制激活 "claude-vision"
  │       │   └─ createTask(message, images=[dataUrl], parent)
  │       ├─ 子代理（claude-vision）分析图片
  │       └─ attempt_completion -> 摘要回填给带头人
  │
  ├─ 带头人 LLM 决策：需要 Unity 工程查询
  │   └─ new_task(mode=unity-context, message="查询 Player 节点的子节点")
  │       ├─ handleModeSwitch("unity-context")
  │       │   └─ 读 apiProfile -> 强制激活对应 Profile
  │       ├─ 子代理只看到 unity-pro MCP 工具（MCP 可见性过滤）
  │       ├─ 子代理调 unity-pro 工具查询
  │       └─ attempt_completion -> 摘要回填
  │
  └─ 带头人整合所有结果 -> attempt_completion -> 交付给用户
```

---

## 3. 新增字段设计

### 3.1 `apiProfile`（模式绑定大模型）

在 [`modeConfigSchema`](../packages/types/src/mode.ts:97) 新增：

```ts
apiProfile: z.string().optional(),
```

**语义**：模式声明自己使用的 API Profile 名称。委派时强制激活，不受 `lockApiConfigAcrossModes` 全局开关影响。

**配置示例**（`.roomodes`）：

```yaml
- slug: image-analyzer
  name: 🌐 图片分析
  apiProfile: "claude-vision"
  hidden: true
  roleDefinition: 你是图片分析专家...
  groups: ["read", "mcp"]
```

**生效路径**：

1. [`delegateParentAndOpenChild`](../src/core/webview/ClineProvider.ts:2968) 切模式后，读取目标模式的 `apiProfile`
2. 如果存在，调用 `activateProviderProfile` 强制激活
3. `activateProviderProfile` 更新全局状态 -> `createTask` 从全局状态读取最新配置
4. 子任务的 [`api`](../src/core/task/Task.ts:511) handler 用新配置构建

**优先级**：`apiProfile` > 模式->Profile 映射（`getModeConfigId`）> 当前全局配置。`apiProfile` 存在时直接覆盖，不查映射表。

**容错**：如果 `apiProfile` 引用的 Profile 不存在（被删/改名），记警告日志，退化为当前配置，不阻塞任务。

**与 `lockApiConfigAcrossModes` 的关系**：

- `lockApiConfigAcrossModes = true` 时，`handleModeSwitch` 跳过模式->Profile 映射，但 `apiProfile` 字段的强制激活**不受影响**
- `apiProfile` 是模式级的声明式绑定，`lockApiConfigAcrossModes` 是全局的临时锁定，二者作用域不同

### 3.2 `hidden`（模式选择器可见性）

在 [`modeConfigSchema`](../packages/types/src/mode.ts:97) 新增：

```ts
hidden: z.boolean().optional(),
```

**语义**：`true` 时该模式不在模式选择器显示，但仍可被 `new_task` 工具指定。

**生效位置**：

1. 模式选择器 UI（[`ModesView`](../webview-ui/src/components/modes/ModesView.tsx)）：过滤 `hidden !== true`
2. `switch_mode` 工具的可用模式列表：同样过滤
3. `new_task` 工具的 `mode` 参数：**不过滤**，可指定任何模式（包括 hidden）

**零影响保证**：`hidden` 未设置或 `false` 时，行为完全不变。

### 3.3 `maxRetries`（子代理重试上限）

在 [`delegationPolicySchema`](../packages/types/src/expert.ts:52) 新增：

```ts
maxRetries: z.number().int().positive().default(3),
```

**语义**：带头人对同一子代理的重试上限。超过后带头人停止派单，`attempt_completion` 告知用户需要介入。

**注入方式**：带头人的系统提示词中注入"最多重试 N 次"。这是软约束（靠提示词），第一版不做 `new_task` 的硬计数限制。

**配置示例**：

```yaml
- slug: squad-lead
  name: 🧭 编队组织者
  delegation:
      canDelegate: true
      maxDepth: 3
      maxRetries: 5 # 可配置，默认 3
  roleDefinition: |
      你是任务编队组织者...
      如果子代理返回的结果不满足需求，可以重新派单并附上更详细的上下文。
      最多重试 5 次，超过后停止派单并告知用户需要介入。
```

---

## 4. pic_xxxx 图片传递方案

### 4.1 问题

主模型不支持图片（`supportsImages: false`），用户上传的图片在 [`image-cleaning.ts`](../src/api/transform/image-cleaning.ts:21) 被替换为无信息的 `[Referenced image in conversation]`。主模型不知道图片内容，也无法把图片传给子代理。

### 4.2 方案

在 image-cleaning 阶段生成有标识的 `pic_xxxx`，替换无信息文本。主模型在 `new_task` 的 `message` 里引用标识，系统解析标识取出图片传给子任务。

### 4.3 完整链路

```
1. 用户上传图片
   -> 图片作为 image block 进入 apiConversationHistory

2. 主模型不支持图片
   -> image-cleaning.ts 把 image block 替换为：
      "[图片: pic_a1b2c3]"（a1b2c3 = 图片 dataUrl 的 sha256 前 6 位）

3. 主模型看到 "[图片: pic_a1b2c3]"
   -> LLM 在 new_task 的 message 里写："请分析 pic_a1b2c3"

4. NewTaskTool.execute 拦截 message
   -> 正则匹配 "pic_[a-f0-9]{6}"
   -> 遍历父任务的 apiConversationHistory
   -> 找到 sha 匹配的 image block，取出 dataUrl
   -> 收集到 images: string[]

5. delegateParentAndOpenChild 传 images 给子任务
   -> createTask(message, images, parent)
   -> 子任务（支持图片的模型）拿到真实图片

6. 子代理分析图片 -> attempt_completion 摘要回填
```

### 4.4 改动点

#### 4.4.1 `image-cleaning.ts`

文件：[`src/api/transform/image-cleaning.ts`](../src/api/transform/image-cleaning.ts:6)

```ts
// 现在：
return { type: "text", text: "[Referenced image in conversation]" }

// 改为：
const sha = computeShaPrefix(block.source?.data ?? block.data)
return { type: "text", text: `[图片: pic_${sha}]` }
```

需要访问 image block 的 dataUrl 来算 sha。当前 `maybeRemoveImageBlocks` 的入参是 `ApiMessage[]`，image block 的 dataUrl 在 `block.source.data`（Anthropic 格式）或类似字段。实现时确认具体字段路径。

#### 4.4.2 `NewTaskTool.ts`

文件：[`src/core/tools/NewTaskTool.ts`](../src/core/tools/NewTaskTool.ts:113)

在 `execute` 方法中，解析 `message` 里的 `pic_xxxx` 标识：

```ts
const PIC_REGEX = /pic_([a-f0-9]{6})/g

function extractImagesFromMessage(message: string, task: Task): string[] {
	const pics = Array.from(message.matchAll(PIC_REGEX)).map((m) => m[1])
	const images: string[] = []
	for (const pic of pics) {
		const dataUrl = findImageByShaPrefix(task.apiConversationHistory, pic)
		if (dataUrl) images.push(dataUrl)
	}
	return images
}
```

找到的 images 传给 `delegateParentAndOpenChild`。

#### 4.4.3 `delegateParentAndOpenChild`

文件：[`src/core/webview/ClineProvider.ts:2968`](../src/core/webview/ClineProvider.ts)

增加 `images?: string[]` 参数，传给 `createTask`：

```ts
// 现在：createTask(message, undefined, parent, ...)
// 改为：createTask(message, images, parent, ...)
```

`startSubtask`（[`Task.ts:2381`](../src/core/task/Task.ts)）同步增加 `images` 参数。

#### 4.4.4 `new_task` 工具描述

文件：[`src/core/prompts/tools/native-tools/new_task.ts`](../src/core/prompts/tools/native-tools/new_task.ts)

在工具 description 里补充：

```
对话中的图片会显示为 [图片: pic_xxxx] 标识。在 message 中引用 pic_xxxx 即可把图片传给子任务。
```

### 4.5 边界处理

- **图片已被 condense 移除**：`findImageByShaPrefix` 找不到 -> `NewTaskTool` 返回错误"图片 pic_xxxx 已不在上下文中，请重新上传"。第一版不做 picRegistry 缓存。
- **同一张图多次引用**：sha 相同，去重后只传一份。
- **多张图**：message 里多个 `pic_xxxx`，全部解析收集。
- **子代理模型也不支持图片**：子代理的 image-cleaning 会再次替换为 `[图片: pic_xxxx]`。子代理 `roleDefinition` 应声明需要支持图片的模型（通过 `apiProfile` 绑定）。

### 4.6 不做 pic_context.txt

图片分析结果通过 `attempt_completion` 摘要回填给主任务，不需要中间文件。后续如发现频繁重复分析同一张图，再考虑缓存层。

---

## 5. MCP 工具可见性（方案 A：服务器侧 `modes`）

### 5.1 问题

MCP 工具对模式是"全有或全无"：有 `mcp` 组就看到所有服务器的全部工具。专业服务器（如 unity-pro，几十个工具）一接入，所有带 `mcp` 组的模式上下文被灌满。

### 5.2 方案 A：服务器侧声明 `modes`

在 [`McpHub.ts`](../src/services/mcp/McpHub.ts) 的 `BaseConfigSchema` 增加：

```ts
modes: z.array(z.string()).min(1).optional(),
```

**配置**（`mcp_settings.json` / `.roo/mcp.json`）：

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

**语义**：`modes` 存在时，该服务器的工具只对列出的模式可见；未设置 = 所有带 `mcp` 组的模式可见（零影响，向后兼容）。

### 5.3 实现

详见 [`mcp-mode-visibility-design.md`](mcp-mode-visibility-design.md)。要点：

1. **注入侧**：[`filterMcpToolsForMode`](../src/core/prompts/tools/filter-tools-for-mode.ts:437) 扩展，对不可见服务器按前缀匹配剔除工具
2. **执行侧兜底**：[`presentAssistantMessage.ts`](../src/core/assistant-message/presentAssistantMessage.ts:107) `mcp_tool_use` 执行前检查可见性，不可见则返回错误并提示委派
3. **系统提示词**：按同一过滤给出服务器列表

### 5.4 零影响保证

未使用 `modes` 字段时（服务器无 `modes`），注入与执行行为逐字不变。

---

## 6. 群组模式创建界面

### 6.1 设计目标

创建群组模式 = 创建一个带头人 + 勾选已有的子代理模式复用。

### 6.2 创建流程

```
1. 用户选择"创建群组模式"
2. 填写带头人属性：
   - slug / name / roleDefinition（路由策略模板）
   - apiProfile（绑定带头人的大模型）
   - delegation.maxRetries（重试上限，默认 3）
3. 勾选可调度的子代理模式：
   - 列出所有已有模式（含 hidden 的子代理模式）
   - 多选
4. 系统自动生成带头人的 roleDefinition：
   - 注入选中的子代理列表（slug + name + whenToUse）
   - 注入路由规则模板
5. 保存带头人模式到 .roomodes
```

### 6.3 子代理模式创建

子代理模式也是独立创建的模式，只是标记 `hidden: true`：

```yaml
- slug: image-analyzer
  name: 🌐 图片分析
  apiProfile: "claude-vision"
  hidden: true
  roleDefinition: |
      你是图片分析专家。分析用户提供的图片内容，返回结构化描述。
      不要开子任务。attempt_completion 返回格式：
      [SUCCESS/FAILED] 结论
      - 关键发现1
      - 关键发现2
  groups: ["read", "mcp"]
```

### 6.4 带头人模式示例

```yaml
- slug: squad-lead
  name: 🧭 编队组织者
  apiProfile: "glm-text"
  hidden: false
  delegation:
      canDelegate: true
      maxDepth: 3
      maxRetries: 3
  roleDefinition: |
      你是任务编队组织者，负责任务分解、调度和验收。
      你不直接做专业工作，而是拆解任务派单给专业子代理。

      可调度的专家：
      - image-analyzer (🌐图片分析)：对话含图片或需要看截图时派单
        对话中的图片标记为 [图片: pic_xxxx]，在 message 中引用 pic_xxxx 即可把图片传给子代理。
      - unity-context (🎮Unity工程)：Unity prefab/场景/引用查询
      - code-writer (💻代码)：写/改代码
      - test-runner (🧪测试)：跑测试验证
      - debugger (🪲调试)：诊断和修复 bug

      派单规则：
      - 用 new_task 工具指定 mode 参数，message 描述任务目标+必要上下文+期望返回格式。
      - 子任务返回摘要后你决定下一步：整合、重新派单、或向用户报告。
      - 如果子代理返回的结果不满足需求，可以重新派单并附上更详细的上下文。最多重试 3 次，超过后停止派单并告知用户需要介入。
      - 不要自己做专业工作，拆出去让别人做，你整合结果。
```

---

## 7. 失败处理与边界情况

### 7.1 子代理超时或卡死

第一版不做自动超时。用户可在 UI 上看到子代理卡住，手动取消。后置可加 `delegationPolicy.timeout` 字段。

### 7.2 子代理返回垃圾内容

纯提示词约束。带头人 `roleDefinition` 要求检查子代理返回的 `[SUCCESS]`/`[FAILED]` 标记。子代理 `roleDefinition` 要求 `attempt_completion` 的 result 第一行必须是 `[SUCCESS]` 或 `[FAILED]` + 原因。

带头人可重新派单（受 `maxRetries` 限制），超过上限后告知用户。

### 7.3 子代理嵌套委派

子代理不应开子任务。两层防护：

1. **提示词约束**：子代理模式的 `roleDefinition` 里写"不要开子任务，你是最终执行者"
2. **代码兜底（后置）**：[`NewTaskTool`](../src/core/tools/NewTaskTool.ts) 检查 `task.parentTaskId`，如果当前任务已经是子任务（`parentTaskId` 存在），给警告或拒绝

### 7.4 子代理工具权限不够

不做自动检查（CEO 理念：不干预子代理怎么做）。如果子代理 `groups` 没配 `mcp`，它看不到 MCP 工具，自然用 `read_file` 去读大文件。用户通过观察子代理行为来打磨其配置。

### 7.5 主任务和子任务用同一个模型

如果 `apiProfile` 未配置或 Profile 不存在，子任务可能和主任务用同一个模型。如果该模型不支持图片而子代理需要图片，子代理的 image-cleaning 会再次替换为 `[图片: pic_xxxx]`。

建议子代理模式通过 `apiProfile` 绑定支持所需能力的模型。第一版不做自动检测，靠用户配置。

### 7.6 委派深度限制

当前 [`delegationPolicySchema`](../packages/types/src/expert.ts:63) 的 `maxDepth: 3` 只在工作流专家（类型 A）硬委派时生效。类型 B（LLM 自主 `new_task`）没有深度检查。

第一版靠提示词约束"子代理不开子任务"（§7.3）。后置在 `NewTaskTool` 加 `parentTaskId` 深度检查。

---

## 8. 完整改动清单

| #   | 改动                    | 文件                                                                                                                                                                                                                                                                         | 类型         | 估时     |
| --- | ----------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------ | -------- |
| 1   | MCP 可见性（方案 A）    | [`McpHub.ts`](../src/services/mcp/McpHub.ts) `BaseConfigSchema` + [`filterMcpToolsForMode`](../src/core/prompts/tools/filter-tools-for-mode.ts) + [`presentAssistantMessage`](../src/core/assistant-message/presentAssistantMessage.ts) + `system.ts`                        | 代码         | 2-3 天   |
| 2   | `apiProfile` 字段       | [`modeConfigSchema`](../packages/types/src/mode.ts:97) + [`delegateParentAndOpenChild`](../src/core/webview/ClineProvider.ts:2968) + [`handleModeSwitch`](../src/core/webview/ClineProvider.ts:1381)                                                                         | 代码         | 1-2 天   |
| 3   | `hidden` 字段           | [`modeConfigSchema`](../packages/types/src/mode.ts:97) + [`ModesView`](../webview-ui/src/components/modes/ModesView.tsx) + `switch_mode` 工具列表                                                                                                                            | 代码         | 0.5-1 天 |
| 4   | `maxRetries` 字段       | [`delegationPolicySchema`](../packages/types/src/expert.ts:52) + 系统提示词注入                                                                                                                                                                                              | 代码         | 0.5 天   |
| 5   | pic_xxxx 图片传递       | [`image-cleaning.ts`](../src/api/transform/image-cleaning.ts:6) + [`NewTaskTool`](../src/core/tools/NewTaskTool.ts) + [`delegateParentAndOpenChild`](../src/core/webview/ClineProvider.ts:3061) + [`Task.startSubtask`](../src/core/task/Task.ts:2381) + `new_task` 工具描述 | 代码         | 1-2 天   |
| 6   | 群组模式创建界面        | [`ModesView`](../webview-ui/src/components/modes/ModesView.tsx) 新增群组创建流程                                                                                                                                                                                             | 代码         | 2-3 天   |
| 7   | 带头人 + 子代理模式定义 | [`.roomodes`](../.roomodes)                                                                                                                                                                                                                                                  | 配置         | 0        |
| 8   | 委派深度限制（后置）    | [`NewTaskTool`](../src/core/tools/NewTaskTool.ts) 检查 `parentTaskId`                                                                                                                                                                                                        | 代码（后置） | 0.5 天   |

**总计**：第一版（1-7）约 7-11 天，后置项（8）0.5 天。

---

## 9. 实施顺序

1. **MCP 可见性**（改动 1）-- 专业子代理工具隔离的通用地基，已有设计稿
2. **`apiProfile` + `hidden` + `maxRetries`**（改动 2-4）-- schema 字段 + 委派链读取，互相独立可并行
3. **pic_xxxx 图片传递**（改动 5）-- 依赖 `apiProfile`（子代理需绑定支持图片的模型）
4. **模式定义**（改动 7）-- 纯配置，在 1-3 完成后即可验证
5. **群组创建界面**（改动 6）-- UI 层，最后做
6. **委派深度限制**（改动 8）-- 后置

---

## 10. 与现有设计的关系

### 10.1 与 `expert-system-design.md` 的关系

本设计是 [`expert-system-design.md`](expert-system-design.md) §3.2 **类型 B（探索型专家）**的具体应用：

- 带头人 = 类型 B 专家，LLM 自主决定何时拆子任务
- 子代理 = 类型 B 专家，自驱执行不嵌套
- 委派机制复用现有的 `new_task` -> `delegateParentAndOpenChild` -> `reopenParentFromDelegation` 链路
- 串行约束（`concurrency: "serial"`）不变，一次只有一个活跃子任务

### 10.2 与 `mcp-mode-visibility-design.md` 的关系

本设计的 §5 直接引用 `mcp-mode-visibility-design.md` 的方案 A（服务器侧 `modes`）。两份文档互补：

- `mcp-mode-visibility-design.md`：MCP 可见性的通用机制设计（A/B 选型、过滤实现、测试计划）
- 本文档：在群组模式场景下如何使用该机制（unity-pro 只对 unity-context 可见）

### 10.3 与 `freeze-2026-07.md` 的关系

`freeze-2026-07.md` 封存了工作流/专家系统线，本设计重启该线的一个子方向。按封存文档的约定，重启时须在对应小节标注"已重启：见 `expert-squad-design.md`"。

本设计**不重启**以下被封存项：

- Phase 3b MCP 硬执行（工作流引擎的硬工具调用）
- 并行子专家
- 编辑器还债 P1/P2

本设计**复用**以下已完成的封存基础设施：

- 委派机制（`delegateParentAndOpenChild` + `reopenParentFromDelegation`）
- L1 沙盒自动放行（`switchMode`/`newTask`/`finishTask` -> `approve`）
- 专家类型字段（`kind`/`delegation`/`terminationHint`）

---

## 11. 风险与待办

- ⚠️ **pic_xxxx 的 sha 计算**：image block 的 dataUrl 字段路径需实现时确认（Anthropic 格式 vs OpenAI 格式）。`image-cleaning.ts` 当前不访问 dataUrl，需要改函数签名或预处理。
- ⚠️ **condense 后图片丢失**：第一版返回错误让用户重新上传。后续可加 `picRegistry` 持久化缓存。
- ⚠️ **群组创建界面的复杂度**：§6 的创建流程涉及 UI 重构，可能需要 2-3 天。第一版可先用纯配置（手写 `.roomodes`）验证，界面后做。
- 🔗 **跨 MCP 可见性依赖**：§5 依赖 `mcp-mode-visibility-design.md` 的方案 A 实现，须先选型动工。
- ⚠️ **子代理 `apiProfile` 与 sticky profile 的交互**：[`_taskApiConfigName`](../src/core/task/Task.ts:574) 在任务恢复时优先。需确认 `apiProfile` 激活后是否正确写入 `_taskApiConfigName`，避免恢复时覆盖。

---

## 变更记录

- 2026-07-08 创建：基于架构讨论（可行性 -> 权限/提示词 -> pic_xxxx/apiProfile/失败处理 -> 群组模式概念）的设计稿。
