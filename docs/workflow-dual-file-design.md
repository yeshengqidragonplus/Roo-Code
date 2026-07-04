# 工作流双文件架构设计

> 状态：设计稿
> 日期：2026-07-04
> 关联：`expert-system-design.md`、`workflow-engine-handoff.md`、`workflow-visualization.md`

## 1. 目标

把工作流从单文件拆成**架构文件**（流程拓扑）+ **配置文件**（节点内容），实现：

1. **架构复用**：同一套流程骨架可套不同配置（如逆向工作流架构复用于 Unity/Cocos/Godot）
2. **节点编辑**：可视化编辑器里点击节点直接编辑配置，不用翻几百行 JSON
3. **关注点分离**：架构（怎么连）与内容（做什么）独立演进

## 2. 文件格式

### 2.1 架构文件 `.roo/workflows/<id>.json`

轻量，只含流程拓扑。每个节点保留 `id`/`type`/`position`/`exec` + 一个 `customData` 占位（JSON，接收节点级配置）。

```jsonc
{
	"name": "APK 逆向工程标准流程",
	"description": "...",
	"version": "3.0.0",
	"inputs": [{ "name": "apkPath", "type": "string", "required": true }],
	"nodes": [
		{
			"id": "env-check",
			"type": "llm",
			"position": { "x": 0, "y": 120 },
			"data": {
				"exec": "soft",
				"customData": {}, // 占位：运行时由配置文件合并填充
			},
		},
		{
			"id": "engine-identify",
			"type": "condition",
			"position": { "x": 240, "y": 120 },
			"data": {
				"expression": "{{env-check.output.engine}}",
			},
		},
	],
	"edges": [
		{ "id": "e1", "source": "env-check", "target": "engine-identify" },
		{ "id": "e2", "source": "engine-identify", "target": "unity-flow", "data": { "branch": "true" } },
	],
}
```

**架构层保留的字段**（决定流程行为）：

- 节点：`id`、`type`、`position`、`data.exec`
- condition 节点：`data.expression`（分支逻辑属于架构）
- 边：`source`、`target`、`data.branch`

### 2.2 配置文件 `.roo/workflows/<id>.config.json`

重量，按节点 ID 索引，存每个节点的具体内容。

```jsonc
{
  "env-check": {
    "prompt": "环境检查：读取工具配置文件...(几百行)...",
    "outputSchema": { "type": "object", "properties": { ... } }
  },
  "unity-il2cpp": {
    "prompt": "Unity IL2CPP 逆向流程...(几百行)...",
    "outputSchema": { ... }
  },
  "crawl-step": {
    "toolName": "mcp__crawler__fetch",
    "params": { "url": "{{inputs.targetUrl}}", "depth": 3 }
  }
}
```

**配置层存储的字段**（节点做什么）：

- `prompt`、`outputSchema`（llm 节点）
- `toolName`、`params`（tool 节点）
- `skillName`、`args`（skill 节点）
- `subtaskPrompt`、`expertId`/`mode`（expert 节点）
- 未来按节点类型设计时再区分哪些字段属于配置

### 2.3 合并规则

引擎加载时，`WorkflowRegistry.load(id)` 合并两个文件：

```
graph = load(id + ".json")           // 架构
config = load(id + ".config.json")   // 配置（可选，不存在则用空对象）

for each node in graph.nodes:
  nodeConfig = config[node.id] ?? {}
  node.data = { ...node.data, ...nodeConfig }
  // 架构层的 exec/expression 不被配置覆盖（架构优先）
```

**合并优先级**：架构层字段（`exec`、`expression`）优先，配置层字段（`prompt`、`outputSchema`、`toolName`、`params` 等）合并进去。

## 3. 向后兼容

### 3.1 旧格式（单文件）

现有的 `.roo/workflows/*.json`（含完整 data）仍然可用。`WorkflowRegistry.load(id)` 的加载逻辑：

1. 读 `<id>.json`（架构）
2. 尝试读 `<id>.config.json`（配置）— 不存在则跳过
3. 如果架构文件里节点已有 `prompt` 等字段（旧格式），直接用（不合并配置文件）
4. 如果架构文件里节点 `customData` 为空且配置文件存在，合并配置

**判断逻辑**：如果节点的 `data` 里已有 `prompt`/`toolName` 等内容字段，视为旧格式，不合并。如果只有 `exec`/`expression` 等架构字段 + 空 `customData`，则合并配置文件。

### 3.2 迁移

旧工作流不需要立即迁移。新建工作流默认生成双文件。旧工作流在编辑器里保存时自动拆分。

## 4. 编辑器设计

### 4.1 双模式

| 模式                 | 触发                                | 画布交互           | 节点面板           |
| -------------------- | ----------------------------------- | ------------------ | ------------------ |
| **查看模式**（只读） | 工作流执行中                        | 不可编辑，只看进度 | 点击看属性（只读） |
| **编辑模式**         | 选了工作流模式但未执行 / 手动切编辑 | 可拖拽节点、连线   | 点击编辑属性       |

### 4.2 编辑模式 UI

```
┌──────────────────────────────┬──────────────────┐
│                              │ 节点配置面板      │
│   React Flow 画布            │                  │
│   (可拖拽节点、连线)          │ 节点: env-check  │
│                              │ 类型: llm        │
│   [env-check]→[identify]    │                  │
│      ↓分支                   │ Prompt:          │
│   [unity]  [cocos]  [godot] │ [文本编辑框...]   │
│                              │                  │
│                              │ OutputSchema:    │
│                              │ [JSON 编辑框...]  │
│                              │                  │
│                              │ [保存] [取消]    │
└──────────────────────────────┴──────────────────┘
```

### 4.3 保存机制

编辑器保存时分写两个文件：

- 架构文件：写 `nodes`（id/type/position/data.exec/data.expression）+ `edges`
- 配置文件：写 `{ [nodeId]: { prompt, outputSchema, ... } }`

后端新增 `saveWorkflow(id, graph, config)` API，前端通过 `postMessage` 调用。

## 5. 实现计划

| 步骤 | 内容                                         | 影响范围                                                       |
| ---- | -------------------------------------------- | -------------------------------------------------------------- |
| 1    | 类型定义：架构/配置分离的 TypeScript 类型    | `packages/types/src/workflow-viz.ts`                           |
| 2    | 后端：`WorkflowRegistry` 支持双文件加载/合并 | `src/core/expert/WorkflowRegistry.ts`                          |
| 3    | 后端：`saveWorkflow` API（写两个文件）       | `src/core/webview/webviewMessageHandler.ts`                    |
| 4    | 前端：编辑模式 React Flow（可拖拽/连线）     | `webview-ui/src/components/workflow/WorkflowView.tsx`          |
| 5    | 前端：节点配置面板（按节点类型渲染表单）     | `webview-ui/src/components/workflow/NodeConfigPanel.tsx`（新） |
| 6    | 前端：保存按钮 + postMessage                 | `WorkflowView.tsx`                                             |
| 7    | 旧工作流迁移工具（可选）                     | 脚本或编辑器"另存为双文件"                                     |

## 6. 关键决策记录

- `exec`（soft/hard）属于**架构**（决定流程行为）
- `expression`（condition 分支）属于**架构**（决定流程走向）
- `prompt`/`outputSchema`/`toolName`/`params`/`skillName`/`args`/`subtaskPrompt` 属于**配置**（节点做什么）
- 具体哪些字段属于架构/配置，按节点类型设计时再最终确定
- 配置文件是可选的——不存在时按旧格式从架构文件读
