# 工作流 llm 节点 outputSchema 的隐含契约

llm 节点声明 `outputSchema` 不仅是文档/校验用途，更是**触发 JSON 解析的开关**。

引擎的 `parseOutput`（AIWorkflow `src/engine/stateMachine.ts:192`）逻辑：

- 有 `outputSchema` + lastOutput 是 JSON 文本 → `JSON.parse` 成对象存入 `state.results[id].output`
- 无 `outputSchema` → lastOutput 原样存为字符串

**关键后果**：如果 llm 节点输出 JSON 但没声明 `outputSchema`，下游 condition 引用 `{{nodeId.output.field}}` 时，`resolveRef` → `getByPath(string, ["field"])` → 字符串没有该属性 → 返回 `undefined` → condition 求值恒为 false。

**规则**：llm 节点输出 JSON 且下游 condition/引用需要访问字段时，**必须声明 `outputSchema`**。

## 多分支汇聚 + skipped 节点引用

condition 分流后，未激活分支的节点被 `skipInactive` 标记为 `status: 'skipped'`，output 为 `undefined`。下游节点引用 skipped 节点的 output 时，`resolveValue` 对 `undefined` 返回空字符串 `''`（不是 "undefined"）。

设计多分支汇聚节点时，prompt 里列出所有分支引用是安全的——skipped 的自动为空，不影响可读性。
