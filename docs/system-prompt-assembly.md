# RooCode System Prompt 拼接规则

> 本文档说明 RooCode（本 fork 即 QCode）发送给大模型的 **system prompt** 是如何由代码组装出来的：包含哪些段落、每段来源、用户能定制哪些部分，以及对应的源码位置。
>
> 入口函数：[`generatePrompt()`](../src/core/prompts/system.ts) in `src/core/prompts/system.ts`。

## 一、背景：一次请求的结构

发给大模型的不是一坨文本，而是一个有结构的对象。核心三块：

| 字段       | 内容                                                   | 是否每轮都带 |
| ---------- | ------------------------------------------------------ | ------------ |
| `system`   | 系统提示（本文档主题）：人设、规则、工具说明、环境信息 | 是，整段常驻 |
| `tools`    | 当前允许调用的工具定义清单                             | 是           |
| `messages` | 一来一回的对话历史（用户任务、模型回复、工具结果）     | 是，不断增长 |

`system` 是**凌驾于对话之上的框架层**，模型被训练成更服从它。本文档只讲 `system` 这一块的拼接。

> 另有一个传给 provider 的 `metadata` 对象（`taskId` / `mode` 等），属于**追踪标签和调用开关，不是发给模型的内容**，与 system prompt 无关，不在本文范围。

## 二、拼接顺序（总览）

`generatePrompt()` 用模板字符串按**固定顺序**把以下段落拼成一个大字符串。来源标记：

- 🔒 **内置写死** —— 代码里的固定模板，用户改不了，是 agent 运行的基础脚手架
- 🔄 **动态生成** —— 代码按当前环境 / 配置自动生成（内容固定但随环境变）
- ⚙️ **来自 Mode** —— 当前模式（mode）配置提供，换 mode 即换内容
- 📝 **用户可写** —— 用户通过规则文件 / 模式配置自定义

| #   | 段落                        | 来源类型    | 生成位置                                                    | 说明                                                           |
| --- | --------------------------- | ----------- | ----------------------------------------------------------- | -------------------------------------------------------------- |
| 1   | **角色定义** roleDefinition | ⚙️ Mode     | `src/shared/modes.ts` `getModeSelection()`                  | "你是 X 模式…"，当前 mode 的身份设定                           |
| 2   | Markdown 格式规则           | 🔒          | `sections/markdown-formatting.ts`                           | 要求把代码 / 文件名输出为可点击 markdown 链接                  |
| 3   | 工具使用说明 TOOL USE       | 🔒          | `sections/tool-use.ts`                                      | 工具需审批；鼓励一次回复批量调用多个工具                       |
| 4   | 工具目录                    | 🔄          | `system.ts`（`toolsCatalog`，当前为占位）                   | 预留：每个工具的说明书                                         |
| 5   | 工具使用准则                | 🔒          | `sections/tool-use-guidelines.ts`                           | 迭代式判断"先取什么信息、用哪个工具"                           |
| 6   | 能力说明 CAPABILITIES       | 🔒          | `sections/capabilities.ts`                                  | 能访问 CLI、列文件、看代码、用 MCP 等                          |
| 7   | 模式列表 MODES              | 🔄          | `sections/modes.ts`                                         | 列出所有可用 mode 及各自 `whenToUse`                           |
| 8   | 技能列表 AVAILABLE SKILLS   | 🔄          | `sections/skills.ts`                                        | 列出当前 mode 可用 skill（仅名字 + 描述 + 路径，正文按需加载） |
| 9   | 规则 RULES                  | 🔒          | `sections/rules.ts`                                         | 项目根目录、路径约定、命令拼接、模式文件限制、代码规范等       |
| 10  | 系统信息 SYSTEM INFORMATION | 🔄          | `sections/system-info.ts`                                   | 自动探测：OS、默认 shell、home 目录、工作目录                  |
| 11  | 目标 OBJECTIVE              | 🔒          | `sections/objective.ts`                                     | 任务拆解协议、attempt_completion 流程                          |
| 12  | **用户自定义指令**          | 📝 用户可写 | `sections/custom-instructions.ts` `addCustomInstructions()` | 见第四节，这是用户主要的定制入口                               |

> 实际拼接代码（`system.ts` 约 85–107 行）：
>
> ```ts
> const basePrompt = `${roleDefinition}
>
> ${markdownFormattingSection()}
>
> ${getSharedToolUseSection()}${toolsCatalog}
>
> ${getToolUseGuidelinesSection()}
>
> ${getCapabilitiesSection(cwd, shouldIncludeMcp ? mcpHub : undefined)}
>
> ${modesSection}
> ${skillsSection ? `\n${skillsSection}` : ""}
> ${getRulesSection(cwd, settings)}
>
> ${getSystemInfoSection(cwd)}
>
> ${getObjectiveSection()}
>
> ${await addCustomInstructions(baseInstructions, globalCustomInstructions || "", cwd, mode, { ... })}`
> ```

## 三、关键认知：绝大部分是内置脚手架

**第 2–11 段（约占 system prompt 90% 以上）都是 RooCode 自带的，不是用户写的。** 它们定义了"怎么用工具、能干什么、要守什么规矩、当前环境、任务怎么推进"——是让 agent 能正常工作的基础设施，每个任务自动注入。

用户能影响的只有两处：

- **第 1 段 roleDefinition** —— 由当前 mode 决定
- **第 12 段 自定义指令** —— 由规则文件决定

这解释了"我没写过却有一大堆内容"：那一大堆是脚手架，不是用户产物。

## 四、第 12 段：用户自定义指令的来源

`addCustomInstructions()`（`sections/custom-instructions.ts`，约 382–507 行）按以下顺序拼接，**所有文件都是自动发现并注入的，用户无需显式引用**：

1. **语言偏好**（若设置）
2. **全局自定义指令**（`globalCustomInstructions`）
3. **模式专属指令**（来自 mode 配置的 `customInstructions`）
4. **Rules 区块**，依次拼接：
    1. **模式专属规则**：`.roo/rules-{mode}/` 目录（如 `.roo/rules-debug/`），或旧式 `.roorules-{mode}`
    2. **RooIgnore 指令**（类 gitignore 规则）
    3. **`AGENTS.md` / `AGENTS.local.md`**（当 `settings.useAgentRules !== false`，默认开启时自动加载）
    4. **通用规则**：`.roo/rules/` 目录，或旧式 `.roorules` / `.clinerules`

### 规则文件自动加载细节

**通用规则**（`loadRuleFiles()`，约 206–239 行），首个命中者生效：

1. `.roo/rules/` 目录 —— 全局 `~/.roo/rules/` 优先，再项目 `.roo/rules/`；目录内所有 `.md` / 文本文件按字母序拼接；排除 `.cache` / `.lock` / `.log` / `.tmp` / `.pyc` 等
2. 回退（无 `.roo/rules/` 时）：项目根的 `.roorules`，再 `.clinerules`

**模式专属规则**（约 399–438 行），首个命中者生效：

1. `.roo/rules-{mode}/` 目录 —— 全局 `~/.roo/rules-{mode}/` 优先，再项目 `.roo/rules-{mode}/`；文本文件按字母序拼接
2. 回退：`.roorules-{mode}`，再 `.clinerules-{mode}`

**AGENTS.md**（`loadAllAgentRulesFiles()`，约 355–380 行）：

- 默认自动加载（`useAgentRules`，默认 `true`）
- 先找项目根的 `AGENTS.md`；`AGENTS.local.md` 总是尝试加载（用于本机个人覆盖，不入版本控制）

### 目录层级（自动发现）

定义于 `src/services/roo-config/index.ts`：

- 默认（`enableSubfolderRules` 关闭）：全局 `~/.roo/` + 项目 `{cwd}/.roo/`
- 开启子目录规则时：额外发现 `{cwd}/*/.roo/`、`{cwd}/*/*/.roo/` 等，按字母序排序

## 五、定制速查

| 想做的事                         | 改哪里                                                                                         |
| -------------------------------- | ---------------------------------------------------------------------------------------------- |
| 改某个模式的"人设"               | 该 mode 的 `roleDefinition`（内置 mode 在 `packages/types/src/mode.ts`；自定义在 `.roomodes`） |
| 给某模式加专属规则 / 记忆文档    | `.roo/rules-{mode}/`（如 `.roo/rules-debug/`），该 mode 激活时自动注入                         |
| 给所有模式加通用规则             | `.roo/rules/` 或项目根 `AGENTS.md`                                                             |
| 仅本机个人覆盖（不提交）         | `AGENTS.local.md`                                                                              |
| 收窄某模式可用工具               | mode 配置的 `groups`（见 `.roomodes` / `packages/types/src/mode.ts`）                          |
| 改工具说明 / 能力 / 目标等脚手架 | `src/core/prompts/sections/*.ts`（内置模板，谨慎）                                             |

## 六、设计提示

- **稳定的放 system，动态的放 messages。** 人设、规则、工具说明属于稳定内容，放 system 既能享受 prompt 缓存（前缀不变即命中），又能借助 system 的高指令优先级避免被对话内容冲淡。任务特有的一次性数据（如临时采集的日志 / 文件内容）应放 messages，避免污染 system 并破坏缓存。
- **切换 mode = 重写 system = 一次缓存全失效。** 因此模式切换不宜过于频繁，最好一个任务定一次。
- **`.roo/rules-{mode}/` 是"每模式可进化记忆文档"的现成载体**：模式激活时自动注入，无需自建注入机制。

---

_相关源码：`src/core/prompts/system.ts`、`src/core/prompts/sections/`、`src/core/prompts/sections/custom-instructions.ts`、`src/shared/modes.ts`、`src/services/roo-config/index.ts`。_
