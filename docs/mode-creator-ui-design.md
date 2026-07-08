# 模式创建界面改造设计

> 状态：设计稿（待审核）
> 日期：2026-07-08
> 基线：`QC/Wittgenstein` @ `507e0820e`
> 关联：`expert-squad-design.md`（群组模式总设计）、`mcp-mode-visibility-design.md`（MCP 可见性）
> 失效条件：实现落地后状态改"已实现"，偏差另立小节。

---

## 1. 现状分析

### 1.1 当前创建界面

文件：[`ModesView.tsx:1394-1604`](../webview-ui/src/components/modes/ModesView.tsx:1394)

右侧滑入面板，表单字段：Name -> Slug -> Save Location -> Role Definition -> Description -> When to Use -> Workflow 下拉 -> Tools -> Custom Instructions。

### 1.2 当前类型区分

仅通过 [`line 1524-1545`](../webview-ui/src/components/modes/ModesView.tsx:1524) 的 Workflow 下拉区分 autonomous / workflow。没有群组模式、`apiProfile` / `hidden` / `maxRetries` 的 UI。

### 1.3 已有数据源

- `listApiConfigMeta`（[`line 71`](../webview-ui/src/components/modes/ModesView.tsx:71)）：API Profile 列表，可直接用于 apiProfile 下拉
- `customModes`（[`line 77`](../webview-ui/src/components/modes/ModesView.tsx:77)）：已有模式列表，可用于子代理勾选
- `workflows`（[`line 78`](../webview-ui/src/components/modes/ModesView.tsx:78)）：工作流列表，用于流程模式下拉

---

## 2. 四种创建类型

| 类型       | 对应配置                              | 选择器可见 | 特有字段                    |
| ---------- | ------------------------------------- | ---------- | --------------------------- |
| 普通模式   | `kind` 不设或 `autonomous`            | ✅         | 无                          |
| 流程模式   | `kind: "workflow"`                    | ✅         | `workflow.workflowId`       |
| 群组组织者 | `kind: "autonomous"` + 路由策略       | ✅         | `apiProfile` + `delegation` |
| 群组成员   | `kind: "autonomous"` + `hidden: true` | ❌         | `apiProfile` + `hidden`     |

---

## 3. 界面布局

### 3.1 类型选择器（新增，置顶）

在 Name 之前增加类型选择，四种类型互斥：

```
┌─────────────────────────────────────────────────┐
│  创建模式                                    [X] │
│                                                   │
│  模式类型                                         │
│  ┌─────┐ ┌─────┐ ┌──────────┐ ┌──────────┐     │
│  │ 普通 │ │ 流程 │ │ 群组组织者 │ │ 群组成员 │     │
│  └─────┘ └─────┘ └──────────┘ └──────────┘     │
│  （描述文字根据选中类型变化）                       │
└─────────────────────────────────────────────────┘
```

类型描述：

| 类型       | 描述                                                  |
| ---------- | ----------------------------------------------------- |
| 普通       | 独立工作模式，不派单也不被派单。如 code、ask、debug。 |
| 流程       | 绑定工作流图，按预定义流程执行。                      |
| 群组组织者 | 任务编队带头人，分解任务并调度子代理。在选择器可见。  |
| 群组成员   | 专业子代理，被组织者派单调用。不在选择器显示。        |

### 3.2 公共字段（四种类型共用）

Name / Slug / Save Location / Role Definition / Description / When to Use / Tools / Custom Instructions。

### 3.3 类型特有字段

**普通模式**：无额外字段。

**流程模式**：Workflow 下拉（复用现有 [`line 1524-1545`](../webview-ui/src/components/modes/ModesView.tsx:1524)）。

**群组组织者**：

- a) API Profile 绑定（下拉，来自 `listApiConfigMeta` + "不绑定"选项）
- b) 委派策略（maxDepth 数字框默认 3，maxRetries 数字框默认 3）
- c) 可调度子代理勾选（多选，列出所有已有模式含 hidden 的）
- d) hidden 开关（默认关闭）

**群组成员**：

- a) API Profile 绑定（同上）
- b) hidden 开关（**默认开启**）
- c) roleDefinition 模板提示（纯文案，建议包含"不要开子任务"+ `[SUCCESS/FAILED]` 返回格式）

---

## 4. 路由策略自动生成

### 4.1 标记区域

群组组织者勾选子代理后，系统在 `roleDefinition` 中用 HTML 注释标记自动生成区域：

```
你是游戏开发编队组织者，负责任务分解和验收。

<!-- SQUAD_MEMBERS_BEGIN -->
可调度的专家：
- image-analyzer (🌐图片分析)：对话含图片或需要看截图时派单
- unity-context (🎮Unity工程)：Unity prefab/场景/引用查询

派单规则：
- 用 new_task 工具指定 mode 参数，message 描述任务目标+必要上下文+期望返回格式。
- 子任务返回摘要后你决定下一步：整合、重新派单、或向用户报告。
- 最多重试 3 次，超过后停止派单并告知用户需要介入。
<!-- SQUAD_MEMBERS_END -->

不要自己做专业工作，拆出去让别人做，你整合结果。
```

### 4.2 更新规则

- **标记区域内**：系统管理，勾选变更时覆盖
- **标记区域外**：用户管理，系统不触碰
- **无标记区域**（旧模式）：首次勾选时追加到末尾
- **触发时机**：勾选/取消勾选子代理、修改 `maxRetries`

### 4.3 生成函数

```tsx
function generateSquadMembersSection(selectedMembers: ModeConfig[], maxRetries: number): string {
	const memberLines = selectedMembers
		.map((m) => `- ${m.slug} (${m.name})：${m.whenToUse ?? m.description ?? ""}`)
		.join("\n")
	return `<!-- SQUAD_MEMBERS_BEGIN -->
可调度的专家：
${memberLines}

派单规则：
- 用 new_task 工具指定 mode 参数，message 描述任务目标+必要上下文+期望返回格式。
- 子任务返回摘要后你决定下一步：整合、重新派单、或向用户报告。
- 最多重试 ${maxRetries} 次，超过后停止派单并告知用户需要介入。
<!-- SQUAD_MEMBERS_END -->`
}

function updateRoleDefinitionWithSquad(
	roleDefinition: string,
	selectedMembers: ModeConfig[],
	maxRetries: number,
): string {
	const section = generateSquadMembersSection(selectedMembers, maxRetries)
	const beginMarker = "<!-- SQUAD_MEMBERS_BEGIN -->"
	const endMarker = "<!-- SQUAD_MEMBERS_END -->"
	if (roleDefinition.includes(beginMarker)) {
		const regex = new RegExp(`${beginMarker}[\\s\\S]*?${endMarker}`, "g")
		return roleDefinition.replace(regex, section)
	} else {
		return roleDefinition.trimEnd() + "\n\n" + section
	}
}
```

---

## 5. 新增 State

```tsx
type CreateModeType = "normal" | "workflow" | "squad-lead" | "squad-member"

const [createModeType, setCreateModeType] = useState<CreateModeType>("normal")
const [newModeApiProfile, setNewModeApiProfile] = useState<string>("")
const [newModeHidden, setNewModeHidden] = useState<boolean>(false)
const [newModeMaxDepth, setNewModeMaxDepth] = useState<number>(3)
const [newModeMaxRetries, setNewModeMaxRetries] = useState<number>(3)
const [selectedSquadMembers, setSelectedSquadMembers] = useState<string[]>([])
```

---

## 6. handleCreateMode 改造

```tsx
const handleCreateMode = useCallback(() => {
	const newMode: ModeConfig = {
		slug: newModeSlug,
		name: newModeName,
		description: newModeDescription.trim() || undefined,
		roleDefinition: newModeRoleDefinition.trim(),
		whenToUse: newModeWhenToUse.trim() || undefined,
		customInstructions: newModeCustomInstructions.trim() || undefined,
		groups: newModeGroups,
		source: newModeSource,
	}

	switch (createModeType) {
		case "workflow":
			if (newModeWorkflowId) {
				newMode.kind = "workflow"
				newMode.workflow = { workflowId: newModeWorkflowId }
			}
			break
		case "squad-lead":
			newMode.kind = "autonomous"
			if (newModeApiProfile) newMode.apiProfile = newModeApiProfile
			newMode.delegation = {
				canDelegate: true,
				maxDepth: newModeMaxDepth,
				maxRetries: newModeMaxRetries,
				concurrency: "serial",
			}
			if (newModeHidden) newMode.hidden = true
			break
		case "squad-member":
			newMode.kind = "autonomous"
			if (newModeApiProfile) newMode.apiProfile = newModeApiProfile
			newMode.hidden = newModeHidden // 默认 true
			break
		case "normal":
		default:
			break
	}

	const result = modeConfigSchema.safeParse(newMode)
	// ... 校验 + 保存（与现有逻辑一致）
}, [createModeType, newModeApiProfile, newModeMaxDepth, newModeMaxRetries, newModeHidden /* ... */])
```

---

## 7. 条件渲染结构

```tsx
{/* 类型选择器 -- 始终显示 */}
<TypeSelector value={createModeType} onChange={setCreateModeType} />

{/* 公共字段 -- 始终显示 */}
<NameField />
<SlugField />
<SaveLocationField />
<RoleDefinitionField />

{/* 群组成员提示 -- 类型为 squad-member 时显示 */}
{createModeType === "squad-member" && <SubAgentHint />}

<DescriptionField />
<WhenToUseField />

{/* 流程模式特有 */}
{createModeType === "workflow" && <WorkflowSelect />}

{/* 群组组织者特有 */}
{createModeType === "squad-lead" && (
    <>
        <ApiProfileSelect value={newModeApiProfile}
            onChange={setNewModeApiProfile} options={listApiConfigMeta} />
        <DelegationConfig maxDepth={newModeMaxDepth} maxRetries={newModeMaxRetries}
            onMaxDepthChange={setNewModeMaxDepth} onMaxRetriesChange={setNewModeMaxRetries} />
        <SquadMemberSelector selected={selectedSquadMembers}
            onChange={setSelectedSquadMembers} modes={modes} />
        <HiddenToggle checked={newModeHidden} onChange={setNewModeHidden} />
    </>
)}

{/* 群组成员特有 */}
{createModeType === "squad-member" && (
    <>
        <ApiProfileSelect value={newModeApiProfile}
            onChange={setNewModeApiProfile} options={listApiConfigMeta} />
        <HiddenToggle checked={newModeHidden} onChange={setNewModeHidden} />
    </>
)}

{/* 公共字段 -- 始终显示 */}
<ToolsField />
<CustomInstructionsField />
```

---

## 8. 组件实现要点

### 8.1 API Profile 下拉

复用现有 `Select` 组件，数据源 `listApiConfigMeta`。选项含"不绑定（用当前配置）"对应空值。

### 8.2 子代理选择器

```tsx
<div className="grid grid-cols-[repeat(auto-fill,minmax(200px,1fr))] gap-2">
    {modes.map((modeConfig) => (
        <VSCodeCheckbox
            key={modeConfig.slug}
            checked={selectedSquadMembers.includes(modeConfig.slug)}
            onChange={(e) => {
                const checked = (e as CustomEvent)?.detail?.target?.checked
                if (checked) {
                    setSelectedSquadMembers([...selectedSquadMembers, modeConfig.slug])
                } else {
                    setSelectedSquadMembers(selectedSquadMembers.filter(s => s !== modeConfig.slug))
                }
                // 自动更新 roleDefinition
                setNewModeRoleDefinition(prev =>
                    updateRoleDefinitionWithSquad(prev, /* newMembers */, newModeMaxRetries)
                )
            }}
        >
            {modeConfig.name} ({modeConfig.slug})
        </VSCodeCheckbox>
    ))}
</div>
```

### 8.3 Hidden 开关

```tsx
<VSCodeCheckbox
	checked={newModeHidden}
	onChange={(e) => {
		const checked = (e as CustomEvent)?.detail?.target?.checked
		setNewModeHidden(checked)
	}}>
	在模式选择器隐藏
	<div className="text-xs text-vscode-descriptionForeground mt-0.5">
		开启后此模式不在选择器显示，但仍可被 new_task 工具指定。
	</div>
</VSCodeCheckbox>
```

### 8.4 类型切换时的默认值

```tsx
const handleTypeChange = useCallback((type: CreateModeType) => {
	setCreateModeType(type)
	// 群组成员默认 hidden
	if (type === "squad-member") {
		setNewModeHidden(true)
	} else if (type === "squad-lead") {
		setNewModeHidden(false)
	}
}, [])
```

---

## 9. 编辑现有模式

创建界面也用于编辑现有模式（通过修改 `handleCreateMode` 或复用表单）。

编辑时需**反向推断类型**：

```tsx
function inferCreateModeType(mode: ModeConfig): CreateModeType {
	if (mode.kind === "workflow") return "workflow"
	if (mode.hidden === true) return "squad-member"
	if (mode.delegation?.canDelegate === true) return "squad-lead"
	return "normal"
}
```

编辑群组组织者时，从 `roleDefinition` 中解析 `SQUAD_MEMBERS_BEGIN/END` 标记区域，反查已勾选的子代理列表。

---

## 10. 改动清单

| #   | 改动                                | 文件                                                                | 估时   |
| --- | ----------------------------------- | ------------------------------------------------------------------- | ------ |
| 1   | 类型选择器 + 条件渲染骨架           | [`ModesView.tsx`](../webview-ui/src/components/modes/ModesView.tsx) | 0.5 天 |
| 2   | API Profile 下拉组件                | 同上                                                                | 0.5 天 |
| 3   | Hidden 开关组件                     | 同上                                                                | 0.5 天 |
| 4   | 委派策略配置（maxDepth/maxRetries） | 同上                                                                | 0.5 天 |
| 5   | 子代理选择器 + 路由策略自动生成     | 同上                                                                | 1 天   |
| 6   | handleCreateMode 类型分支           | 同上                                                                | 0.5 天 |
| 7   | 编辑模式反向推断 + 回填             | 同上                                                                | 1 天   |
| 8   | i18n 文案                           | `locales/*/`                                                        | 0.5 天 |

**总计**：约 5 天。

---

## 11. 与 expert-squad-design.md 的关系

本文档是 [`expert-squad-design.md`](expert-squad-design.md) §6（群组模式创建界面）的详细设计。`expert-squad-design.md` 定义了字段语义（`apiProfile` / `hidden` / `maxRetries`），本文档定义这些字段在 UI 上如何呈现和编辑。

`expert-squad-design.md` §3 的 schema 字段（`apiProfile` / `hidden` / `maxRetries`）必须先落地，本文档的 UI 才能工作。建议按以下顺序：

1. 先做 schema 字段（[`modeConfigSchema`](../packages/types/src/mode.ts:97) + [`expertModeFields`](../packages/types/src/expert.ts:100)）
2. 再做本文档的创建界面

---

## 变更记录

- 2026-07-08 创建：基于现有 ModesView 代码结构和 expert-squad-design.md 的界面设计方案。
