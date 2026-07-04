# 工作流可视化（Workflow Visualization）

## 架构

工作流可视化包含**查看**（只读）和**编辑**两种模式：

- **后端**：`ClineProvider.getStateToPostToWebview` 在当前 task 有 `workflowSession` 时推 `WorkflowVizPayload`（查看模式）；`requestWorkflowGraph` 消息加载图 JSON（编辑模式）；`saveWorkflow` 消息双文件保存
- **投影层**：`src/core/expert/workflowVizProjector.ts` 的 `projectWorkflowState()` 把引擎的 opaque state 转成展示用 `WorkflowVizState`
- **前端**：`webview-ui/src/components/workflow/` 用 React Flow（`@xyflow/react ^12`）渲染
- **类型**：`packages/types/src/workflow-viz.ts` 定义展示类型；`ExtensionState.workflowViz` 字段

## 双文件架构（架构 + 内容分离）

工作流拆成两个文件（详见 `docs/workflow-dual-file-design.md`）：

- **架构文件** `.roo/workflows/<id>.json`：轻量，只含拓扑（节点 id/type/position/exec + 边 + condition expression）
- **配置文件** `.roo/workflows/<id>.config.json`：重量，按节点 ID 索引，存节点内容（prompt/outputSchema/toolName/params 等）
- **合并**：`WorkflowRegistry.load()` 加载时自动合并两文件，架构字段优先；旧单文件格式向后兼容
- **保存**：`WorkflowRegistry.save()` 自动拆分写入两文件

架构字段（`exec`/`expression`/`customData`）在 `WorkflowRegistry` 的 `ARCHITECTURE_NODE_DATA_FIELDS` 集合里定义。

## 关键文件

- `packages/types/src/workflow-viz.ts` — 展示类型
- `src/core/expert/workflowVizProjector.ts` — 引擎 state → 展示 state 投影
- `src/core/expert/WorkflowRegistry.ts` — 双文件加载/合并/保存
- `src/core/webview/ClineProvider.ts` — getStateToPostToWebview 注入 workflowViz
- `src/core/webview/webviewMessageHandler.ts` — requestWorkflowGraph / saveWorkflow handler
- `webview-ui/src/components/workflow/WorkflowView.tsx` — React Flow 主组件（查看+编辑双模式）
- `webview-ui/src/components/workflow/WorkflowNodeView.tsx` — 自定义节点
- `webview-ui/src/components/workflow/NodeConfigPanel.tsx` — 节点配置编辑面板（按类型渲染表单）
- `webview-ui/src/components/workflow/constants.ts` — 颜色/图标常量
- `webview-ui/src/components/chat/ChatTextArea.tsx` — 工具栏入口（查看按钮 + 编辑按钮）

## 数据流

```
查看模式（运行时）：
  WorkflowSession.currentState → projectWorkflowState()
  → ExtensionState.workflowViz → WorkflowView (React Flow, read-only)

编辑模式：
  requestWorkflowGraph → WorkflowRegistry.load(id) → 合并双文件
  → workflowGraph 消息 → ChatTextArea editGraph state
  → WorkflowView (editMode) → 拖拽/编辑 → saveWorkflow
  → WorkflowRegistry.save() → 拆分写入架构+配置两文件
```

## 入口按钮

ChatTextArea 工具栏有两个按钮：

- **查看按钮**（实心图标）：`workflowViz` 存在时显示（工作流运行中）
- **编辑按钮**（空心图标+铅笔）：当前模式是 workflow 专家且未运行时显示（`workflowModeId` 存在且 `!workflowViz`）
