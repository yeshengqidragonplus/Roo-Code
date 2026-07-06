# 工作流可视化与编辑器（实现记录）

> 状态：已实现（MVP，commit `c5950da43`）
> 日期：2026-07-04
> 关联：`workflow-dual-file-design.md`（设计稿）、`expert-system-design.md`、`workflow-engine-handoff.md`
> 依赖：`@xyflow/react ^12`（React Flow，新增依赖）

## 1. 概述

本次开发为工作流专家系统补上了可视化层与编辑能力，共三块：

1. **查看模式**：工作流运行中，在聊天输入框工具栏点按钮弹出 React Flow 画布，实时显示节点执行状态（成功/失败/跳过/进行中/待执行）、动画边、节点属性与输出预览。
2. **编辑模式**：选中工作流专家模式但未运行时，可打开独立编辑器（VS Code 编辑器标签页），拖拽节点、连线、增删节点、在右侧面板按节点类型编辑配置，保存写回磁盘。
3. **双文件架构**：工作流拆为**架构文件**（`<id>.json`，拓扑）+ **配置文件**（`<id>.config.json`，节点内容），`WorkflowRegistry` 负责加载合并与保存拆分，旧单文件格式向后兼容。

## 2. UI 表面（共三个，其中一个是死路径）

| 表面                    | 入口                                                    | 状态                                    |
| ----------------------- | ------------------------------------------------------- | --------------------------------------- |
| 查看 Popover（600×400） | ChatTextArea 工具栏"查看"按钮，`workflowViz` 存在时显示 | ✅ 可用（但宽度超出 sidebar，见 §6.12） |
| 独立编辑器 Panel        | ChatTextArea"编辑"按钮 → `openWorkflowEditor` 消息      | ✅ 主编辑路径                           |
| Sidebar 内嵌编辑 tab    | `switchTab` action 带 `tab: "workflowEditor"`           | ⚠️ 死路径——宿主侧无任何代码触发（§6.5） |

## 3. 后端实现

### 3.1 投影层（引擎状态 → 展示状态）

- `src/core/expert/WorkflowSession.ts` 新增只读 getter `currentState`，暴露引擎 state。
- `src/core/expert/workflowVizProjector.ts` 的 `projectWorkflowState(rawState)` 是**唯一**解读引擎内部 state 形状的地方——宿主循环仍把 state 当 opaque，契约不破。输出截断为 200 字符预览（`finalResult` 为 800），畸形 state 返回 `undefined` 视为"无工作流"。
- 展示类型定义在 `packages/types/src/workflow-viz.ts`：`WorkflowVizNode/Edge/Graph`、`WorkflowNodeStatus`、`WorkflowVizState`、`WorkflowVizPayload`。

### 3.2 状态注入（查看模式）

`ClineProvider.getStateToPostToWebview()`：当前 task 有 `workflowSession` 时，投影 state + `workflowRegistry.load(workflowId)` 读图，组装 `ExtensionState.workflowViz` 推给 webview。注意：**每次 state push 都会从磁盘重新 load 图**（见 §6.7）。

### 3.3 消息协议

| 方向         | 消息                                            | 说明                                     |
| ------------ | ----------------------------------------------- | ---------------------------------------- |
| webview→host | `requestWorkflowGraph { workflowId }`           | 请求图 JSON（编辑模式加载）              |
| host→webview | `workflowGraph { workflowId, graph }`           | 返回合并后的完整图                       |
| webview→host | `saveWorkflow { workflowId, graph }`            | 保存（双文件拆分写入）                   |
| host→webview | `workflowSaved` / `workflowSaveError { error }` | 保存结果                                 |
| webview→host | `openWorkflowEditor { workflowId }`             | 打开独立编辑器 panel                     |
| webview→host | `closeWorkflowEditor`                           | 关闭 panel（仅 panel 本地 handler 处理） |

`requestWorkflowGraph`/`saveWorkflow` 在 `webviewMessageHandler.ts`（sidebar）和 panel 本地 handler（`ClineProvider.openWorkflowEditorPanel` 内）**各实现了一份**（见 §6.6）。

### 3.4 独立编辑器 Panel

`ClineProvider.openWorkflowEditorPanel(workflowId)`：

- `createWebviewPanel` 复用同一 React 构建（dev 走 HMR HTML），向 `</head>` 前注入 `window.WORKFLOW_EDITOR_MODE = { workflowId }` 引导变量（从基础 HTML 提取 CSP nonce）。
- `App.tsx` 检测到该变量时**只渲染** `WorkflowEditorView`，跳过 hydration gate，不依赖 sidebar 的 task 状态。
- panel 按 workflowId 去重（`workflowEditorPanels` Map），重复打开 reveal 现有 panel；dispose 时清理。
- panel 内的 `requestWorkflowGraph` 每次**现建**一个 `WorkflowRegistry`（取当前 cwd），但 `saveWorkflow` 用共享 registry——不一致（见 §6.6）。

### 3.5 双文件 load / save（`WorkflowRegistry`）

- 架构字段集合：`ARCHITECTURE_NODE_DATA_FIELDS = { exec, expression, customData }`。
- **load(id)**：读 `<id>.json`；尝试读 `<id>.config.json`，不存在直接返回（旧格式/无配置）。逐节点合并：`isLegacyNode`（data 里已有 `prompt/toolName/skillName/subtaskPrompt`）则跳过；否则以 config 为底、架构三字段覆盖。**注意实现与设计稿的合并规则有偏差**（见 §5）。
- **save(id, dir, graph)**：逐节点把 `data` 按架构字段集合拆成两份，架构文件写 `{...graph, nodes: 精简节点}`，配置文件写 `{ [nodeId]: contentData }`，均走 `safeWriteJson`。旧工作流保存时自动完成拆分迁移。
- 保存目录固定为 `${cwd}/.roo/workflows`（项目目录），与工作流原始来源（全局/项目）无关（见 §6.3）。

## 4. 前端实现

- `WorkflowView.tsx`（432 行）：React Flow 主组件，`editMode` prop 切换双模式。查看模式从 `workflowViz.state` 派生节点状态与动画边；编辑模式维护本地 `editNodes/editEdges`，支持拖拽、连线、Add Node 下拉（6 种类型）、未保存标记、Save 按钮。
- `WorkflowNodeView.tsx`：自定义节点（类型图标/颜色 + 状态描边）。
- `NodeConfigPanel.tsx`：右侧配置面板，按节点类型渲染表单——llm（prompt/outputSchema）、condition（expression）、tool（toolName/params）、skill（skillName/args）、expert（subtaskPrompt/expertId）；JSON 字段带解析校验；另有 exec 软/硬下拉（架构字段，为方便一并可编辑）。
- `WorkflowEditorView.tsx`：全屏编辑器容器，挂载时 `requestWorkflowGraph`，处理加载/错误态，`workflowSaved` 后重新拉图。
- `ChatTextArea.tsx`：两个入口按钮（查看/编辑，手绘 SVG 图标）；`workflowModeId` 由当前 mode 的 `kind === "workflow"` 派生。
- 主题：`src/integrations/theme/getTheme.ts` 兜底 `tokenColors` 缺失；`webview-ui/src/index.css` 新增 React Flow 的 VSCode 主题变量适配。

## 5. 与设计稿（workflow-dual-file-design.md）的偏差

设计稿的合并规则是 `node.data = { ...node.data, ...nodeConfig }`（先铺架构文件的 data，再铺 config，架构字段最终覆盖）。**实现是 `merged = { ...nodeConfig }` 后仅回拷三个架构字段**——架构文件 data 里除 `exec/expression/customData` 之外的任何字段（例如未来加的 `label`、注释类字段），在该节点存在 config 条目时会被**静默丢弃**。应改回设计稿语义或明确收窄架构文件的字段白名单。

## 6. 已知问题与技术债

按严重程度排序：

1. **【数据丢失】编辑器保存会删掉 `inputs` 并重置 `version`**：`WorkflowView.handleSave` 重建 graph 时只带 `name/description/version("1.0.0" 硬编码)/nodes/edges`，顶层 `inputs` 声明（如 apk 工作流的 `apkPath`）保存一次即被删除，version 3.0.0 会回退成 1.0.0。修法：加载时保留完整 graph 对象，保存时仅覆盖 `nodes/edges`。
2. **【数据丢失】load 合并偏差**：见 §5。
3. **【语义存疑】保存目录固定项目 `.roo/workflows`**：编辑全局工作流会在项目里落一份副本（变相 override）。若非有意设计，应写回 `summary.path` 所在目录，或在 UI 上明示"另存为项目副本"。
4. **【架构矛盾】编辑器归属未决**：同一提交里 `.roo/memory/workflow-editor-ownership.md` 记录"编辑器归 AIWorkflow 仓、QCode 不负责编辑"，但本提交在 QCode 内实现了完整编辑器。目前两仓各有一个 React Flow 编辑器（AIWorkflow 里程碑 2 MVP + QCode 本实现），节点词汇表/图 schema 存在双向漂移风险。需要决策（见 §8）。
5. **【死代码】** ChatTextArea 里 `editGraph` state + `workflowGraph` 监听器（Popover 编辑器方案的遗留）以及未使用的 `WorkflowVizGraph` import；App.tsx 的 sidebar 内嵌 `workflowEditor` tab 无任何触发方。
6. **【重复实现】** `requestWorkflowGraph`/`saveWorkflow` 在 sidebar handler 与 panel 本地 handler 各一份；且 panel 内 load 用现建 registry（跟随最新 cwd）、save 用共享 registry，行为不一致。应抽成 `ClineProvider` 上的公共方法。
7. **【性能】** 查看模式下每次 state push 都 `registry.load()` 从磁盘读图并 JSON.parse。工作流运行期间 state push 频繁，应按 workflowId（+mtime）缓存，或 session 启动时把图挂在 session 上。
8. **【健壮性】保存无 schema 校验**：AIWorkflow 仓已冻结节点词汇表/图 Schema/引用语法三份契约，但 `saveWorkflow` 把前端传来的 JSON 直接写盘，畸形图要到运行时才暴露。应在 save 入口做 zod 校验并把错误回显到编辑器。
9. **【零测试】** 双文件 load/save、projector、全部前端组件均无测试（`WorkflowRegistry.spec.ts` 仍是旧的 discover/get 覆盖），违反仓库"新代码必须带测试"约定。最关键的缺口是 **round-trip 测试**：load → save → load 幂等。
10. **【危险的全局副作用】** `extension.ts` 顶部 `process.removeAllListeners("warning")`：VS Code 扩展宿主是**共享 Node 进程**，这会把宿主自身与其它扩展注册的 warning 监听器一并移除。应改为不动全局监听器的方案（如仅在自家输出通道过滤）。
11. **【i18n 缺失】** "Edit Mode"、"Save Workflow"、"Node Properties"、"Loading workflow..." 等用户可见字符串全部硬编码英文，未走 i18n（仓库约定用户可见字符串需本地化）。
12. **【布局】** 查看 Popover 固定 `w-[600px]`，sidebar webview 通常仅 300–450px 宽，会溢出/被裁剪。
13. **【小问题】** projector 把引擎 status 直接 `as WorkflowNodeStatus` 未校验；"current" 状态在 projector 和前端 `viewNodes` 里各算一遍（逻辑重复）；NodeConfigPanel 未在 UI 上区分架构字段与配置字段的边界。

## 7. 顺带修复（与工作流无关，混在同一提交）

- `src/api/providers/fetchers/vercel-ai-gateway.ts`：`context_window`/`max_tokens` 改为 optional（上游 API 返回缺字段时 zod 解析崩溃），缺省回退 0。
- `src/integrations/theme/getTheme.ts`：主题缺 `tokenColors` 时兜底空数组，修复 `convertTheme` 崩溃。
- `src/extension.ts`：抑制第三方依赖的 DeprecationWarning（**实现方式有全局副作用**，见 §6.10）。

> 流程备注：以上三项应各自独立提交；混入 feature 提交会给后续 bisect/revert 带来麻烦。

## 8. 待决策：编辑器归属（阻塞后续投入方向）

两个可选方向：

- **方案 A（推荐）：QCode 内嵌编辑器为产品面**。用户在 IDE 内就地查看/编辑工作流是核心体验闭环；AIWorkflow 仓的 editor 降级为引擎开发调试工具。前提：把节点词汇表/图 schema 契约做成**单一来源**（AIWorkflow 契约文档 → 生成/导出 zod schema 供 QCode 消费），杜绝两份编辑器实现各自漂移。
- **方案 B：维持 memory 的边界**，QCode 只留查看模式，编辑器（本提交的 NodeConfigPanel/编辑态）迁往 AIWorkflow 仓，QCode 通过"打开外部编辑器/导入 JSON"衔接。

无论选哪个，`.roo/memory/workflow-editor-ownership.md` 与 `docs/commercialization-gap-analysis.md` §2.3 需要同步改成一致的说法。
