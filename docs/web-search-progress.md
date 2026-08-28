# Web Search 工具进度

> 分支：`QC/Wittgenstein`
> 更新：2026-08-28

## 背景

QCode 内置了两个 provider 无关的 web 工具（提交 `894e24f41`，Phase 1）：

- `web_search`：Tavily 后端，返回清洗片段 + LLM 合成答案，支持 `allowed_domains` 限定。
- `web_fetch`：本地 axios + cheerio 抓单页、剥样板；传 `prompt` 且页面长时用配置模型蒸馏。

两个工具走现有 native-tool 模式，归入 `read` 工具组，由 `webSearch` 实验开关 + `tavilyApiKey` 全局 secret 门控。

## 已完成

### 0. 免费 Bing HTML 后端（2026-08-28，commit `067c10348`）

`web_search` 新增第三个后端 **Bing（免费，无需 API key）**，对标 ddgs 库"抓搜索引擎 HTML 页"的思路：

- [`src/services/web-search/bing.ts`](../src/services/web-search/bing.ts)：GET `https://www.bing.com/search`，cheerio 解析 `li.b_algo`（`h2 a` 标题 + `.b_caption p` 摘要），解码 `/ck/a?...&u=a1<base64url>` 点击跳转链接还原真实 URL；`includeDomains` 用 `site:` 操作符 OR 连接实现。
- `webSearchProvider` 枚举扩展为 `"tavily" | "google" | "bing" | "auto"`；**auto 默认优先免费 Bing**，无任何凭据也能搜索，再回退 Google/Tavily（有凭据时）。
- UI：WebSearchSettings 单选组 + NodeConfigPanel 工作流节点下拉均加 "Bing (free, no API key)"。
- 测试：`bing.spec.ts` 7 项 + `webSearchTool.spec.ts` 扩展至 20 项；web-search 目录回归 61/61 全绿，lint 零警告。
- **真实环境冒烟**：搜索 "unity webgl memory leak" 返回 3 条真实结果，URL 解包正确。

**关键决策记录**：最初按 ddgs 思路实现 DuckDuckGo HTML 抓取，但真实环境两个端点（`html.`/`lite.`）都返回 **202 + 反爬验证码**（"Select all squares containing a duck"），裸 HTTP 客户端被识别——ddgs 库本身也因这类反爬需要频繁更新绕过策略。Bing 的 HTML 搜索页对带浏览器 UA 的 GET 请求宽松（实测 200 + 10 条结果），故选 Bing。若 Bing 未来收紧，备选方案是走 Playwright MCP 浏览器抓取（cookie 持久化 + 真实指纹）。

**注意**：Bing 无合成 answer（Tavily 独有），工具输出不含 "Answer (synthesized)" 行。

### 1. 单元测试补齐（2026-06-27）

此前 web 工具零测试覆盖。本次补 4 个文件、58 个测试，全部通过 + lint 干净：

| 文件                                                | 测试数 | 覆盖点                                                                                                       |
| --------------------------------------------------- | ------ | ------------------------------------------------------------------------------------------------------------ |
| `src/services/web-search/__tests__/tavily.spec.ts`  | 11     | 请求构造、默认值、includeDomains 条件包含、响应映射与字段兜底、AbortSignal、错误传播                         |
| `src/services/web-search/__tests__/extract.spec.ts` | 12     | 清洗去样板、title 提取、main/article/body 优先级、截断、默认 maxChars、空白折叠、空内容、UA/Accept 头        |
| `src/core/tools/__tests__/webSearchTool.spec.ts`    | 14     | 实验门控、apiKey 缺失、缺参、审批载荷/拒绝、成功格式化、空结果、异常、partial                                |
| `src/core/tools/__tests__/webFetchTool.spec.ts`     | 21     | 实验门控、缺参、非法/非 http URL、审批、成功、截断标记、蒸馏阈值/成功/失败/空回退、fetch 预算、异常、partial |

运行：`cd src && npx vitest run services/web-search/__tests__/ core/tools/__tests__/webSearchTool.spec.ts core/tools/__tests__/webFetchTool.spec.ts`

### 2. Tavily 版网络搜索专家 mode（2026-06-27）

在 `.roomodes` 新增 `web-researcher` mode：

- `kind: autonomous`（类型 B 自驱专家），`groups: [read]`。
- 系统提示词约束：只搜 + 总结、不写文件、`attempt_completion` 回带引用的摘要。
- `terminationHint`：目标已答/诚实报告搜不到/引用来源/未改文件。
- 用法：父专家用 `new_task` 委派一个搜索子任务给 `web-researcher`，它搜完把结论摘要回填父任务（复用 Phase 2 的 `delegateParentAndOpenChild` / `reopenParentFromDelegation` 委派链路）。

YAML 校验通过（共 11 个 mode）。

## 已调研但未实现

### 豆包（火山方舟）内置 web_search

调研结论（2026-06-27 实测）：

- 豆包 `web_search` 是 **Responses API** 的内置工具（`tools:[{type:"web_search"}]`），不是 Chat Completions 的 function calling。文档全部示例走 `/api/v3/responses`。
- codingplans 套餐 key 走 `/api/coding/v3/responses` 端点（通用 `/api/v3/` 报 `ModelNotOpen`）。
- QCode 的 `openai-native` provider 已走 Responses API 且支持自定义 baseURL，是接入豆包内置搜索的正确载体（不需新 provider、不碰 `doubao` 退役枚举）。
- **实测未触发搜索**：声明 `{type:"web_search"}` 后请求被接受，但 4 次测试（含明确要求联网）均无 `response.web_search_call.*` 事件，模型编造答案。根因：联网内容插件需在方舟控制台单独开通 + 单独计费。
- **决策：放弃**。豆包 web_search 单独收费，暂不接入。若将来要接，方案是给 `openai-native` 加 web_search 工具注入开关 + 流事件转 UI 消息，前提是用户已开通联网内容插件。

## 下一步候选

1. **专家系统 Phase 3**（硬 `tool`/`skill`）：让工作流机械直调工具/技能 handler。方案稿在 `docs/workflow-phase3-plan.md`，需新建 `HostToolInvoker` + `expert.ts` 加 `toolPolicy` + 审批接线。建议先做 Phase 2 手动 e2e 验证再开 Phase 3。
2. **web 工具 i18n**：`webSearch` 设置文案目前只有 `en`，`zh-CN` 等缺失（回退英文）。可用 roo-translation skill 批量补全。
3. **并行子专家**：需重构单活动任务模型，后置。
