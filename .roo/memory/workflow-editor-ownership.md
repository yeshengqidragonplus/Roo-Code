# 工作流可视化编辑器的归属

工作流可视化编辑器由 **AIWorkflow 引擎仓**（`C:\WorkSpace\AIProject\AIWorkflow` 的 `editor/` 目录）负责，**不是 QCode 的职责**。

架构边界：

- **AIWorkflow 仓**：React Flow 编辑器（节点画布、配置面板、图 JSON 导入/导出）+ 执行引擎。已有原型（`editor/ConfigPanel.tsx`、`WorkflowNodeView.tsx`、`serialize.ts` 等）。
- **QCode 仓**：只把工作流当作**一份 JSON 数据**消费——存放在 `.roo/workflows/`、注册为 skill、运行时由宿主 `start`/`advance` 驱动。QCode 可能负责展示工作流，但**不负责编辑**。

> 重要纠正：`docs/commercialization-gap-analysis.md` 的 P1 #7 把"工作流可视化编辑器集成 webview"列为 QCode 的关键缺口，这是**过时的认知**。编辑器不在 QCode 工作范围内。QCode 侧关于工作流的实际剩余工作是 Phase 3b/3c 硬工具、并行子专家、错误恢复韧性等运行时集成，而非造编辑器。
