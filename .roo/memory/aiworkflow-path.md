# AIWorkflow 引擎路径

AIWorkflow 工作流引擎仓库在本机的绝对路径：`C:\WorkSpace\AIProject\AIWorkflow`（注意大小写：AIWorkFlow 目录在文件系统上实际为 AIWorkflow）。

引擎核心文件：

- `src/engine/stateMachine.ts` — 状态机核心（createEngine/start/advance/drive）
- `src/engine/condition.ts` — condition 节点表达式求值（{{ref}} 替换 + 最小递归下降求值器，支持 ===/!==/==/!=/>/</>=/<=/&&/||/!）
- `src/engine/reference.ts` — resolveValue/resolveData，处理 {{nodeId.output}} / {{inputs.xxx}} 引用
- `src/engine/validate.ts` — 工作流校验

关键机制：

- condition 出边用 `data.branch: "true"|"false"` 匹配，output===true 选 true 分支
- llm 节点声明 `outputSchema` 时，lastOutput 若为 JSON 文本会自动 parse 为对象
- 硬节点（tool/skill/expert + exec:"hard"）返回 action 不花 LLM turn；llm 节点恒 soft
- state 必须可序列化，advance 用 JSON.parse(JSON.stringify) 深拷贝
