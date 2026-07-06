# QCode 商业化差距评估与开发计划

> 对标：MX6（VS Code 插件型 AI 编程助手，同类产品：Cursor / Cline / Roo Code / Continue）
> 评估日期：2026-07-01
> 当前版本：0.0.4（fork 自 Roo Code 3.53.0）

---

## 一、项目现状总览

### 1.1 基础底座（继承自 Roo Code，成熟度高）

QCode fork 自 Roo Code 3.53.0，继承了完整的 agent loop 基础设施：

| 能力域                    | 现状                                                                             | 成熟度            |
| ------------------------- | -------------------------------------------------------------------------------- | ----------------- |
| Agent 主循环（Task loop） | 完整：观察→决策→执行→再观察                                                      | ✅ 生产级         |
| 工具体系                  | 28 个内置工具（read/write/edit/command/search/mcp/skill 等）                     | ✅ 生产级         |
| API Provider              | 30+ provider（Anthropic/OpenAI/Gemini/DeepSeek/Qwen/Moonshot/Vertex/Bedrock 等） | ✅ 生产级         |
| MCP 集成                  | stdio/sse/streamable-http 三传输，完整生命周期管理                               | ✅ 生产级         |
| 模式系统（Modes）         | Code/Architect/Ask/Debug + 11 个自定义专家模式                                   | ✅ 生产级         |
| 上下文管理                | condense 压缩 + context-management + checkpoints                                 | ✅ 生产级         |
| 自动审批                  | 分组 auto-approval（read/edit/command/mcp）                                      | ✅ 生产级         |
| i18n                      | 17 种语言（含 zh-CN/zh-TW/ja/ko 等）                                             | ✅ 生产级         |
| 测试覆盖                  | 后端 5393 passed / 1 failed；UI 1267 passed                                      | ✅ 高（1 个需修） |
| CI/CD                     | GitHub Actions（code-qa/codeql/changeset/marketplace-publish/nightly）           | ✅ 生产级         |
| CLI                       | 独立 CLI 包（apps/cli），支持 session resume                                     | ✅ 生产级         |

### 1.2 QCode 自主开发的核心差异化功能

这是 QCode 区别于 Roo Code 原版、构成商业竞争力的核心：

| 功能                               | 状态                                                        | 文档                                                               | 测试       |
| ---------------------------------- | ----------------------------------------------------------- | ------------------------------------------------------------------ | ---------- |
| **专家系统（Expert System）**      | ✅ 已实现                                                   | [`expert-system-design.md`](expert-system-design.md)               | ✅ 有测试  |
| - 类型 A（工作流驱动专家）         | ✅ Phase 1-3a 已实现                                        | [`workflow-phase3-plan.md`](workflow-phase3-plan.md)               | ✅         |
| - 类型 B（自驱专家）               | ✅ 已实现（first-principles mode）                          | —                                                                  | ✅         |
| - 硬 delegate（跨 dispose 续跑）   | ✅ Phase 2 已实现                                           | [`workflow-phase2-plan.md`](workflow-phase2-plan.md)               | ✅         |
| - 硬 tool/skill（HostToolInvoker） | ⚠️ Phase 3a（只读内置）已实现；3b MCP / 3c 技能+副作用 待做 | [`workflow-phase3-plan.md`](workflow-phase3-plan.md)               | ✅         |
| - 并行子专家                       | ❌ 未实现（后置）                                           | —                                                                  | —          |
| **工作流引擎**                     | ✅ 独立仓库 AIWorkflow，已集成                              | [`aiworkflow-path.md`](../.roo/memory/aiworkflow-path.md)          | ✅         |
| **Web 搜索工具**                   | ✅ 已实现（Tavily + web_fetch）                             | [`web-search-progress.md`](web-search-progress.md)                 | ✅ 58 测试 |
| **APK 逆向工作流**                 | ✅ 设计完成，实战验证用例                                   | [`apk-reverse-workflow-design.md`](apk-reverse-workflow-design.md) | —          |
| **Cocos Creator MCP**              | ✅ 已接入（scene/node/component/prefab/project 全套）       | mcp_settings.json                                                  | —          |

### 1.3 关键代码资产

```
src/core/expert/          — 专家系统核心（6 文件 + 6 测试）
src/core/tools/           — 28 个工具 + 测试
src/api/providers/        — 30+ provider
src/services/web-search/  — Web 搜索服务
src/services/mcp/         — MCP 集成
src/services/skills/      — 技能系统
src/services/tree-sitter/ — 代码解析（多语言）
webview-ui/src/           — 完整 React/Vite UI
apps/cli/                 — 独立 CLI
```

---

## 二、与商业化产品（MX6 级别）的差距分析

### 2.1 差距矩阵（按优先级排序）

| #                   | 维度                   | 当前状态                                                                                                                                                                    | 商业级要求                         | 差距  | 优先级 |
| ------------------- | ---------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------- | ----- | ------ |
| **P0 — 阻塞上线**   |                        |                                                                                                                                                                             |                                    |       |        |
| 1                   | **品牌与法务**         | 仍叫 "roo-code"，README/CHANGELOG 全是 Roo Code 内容；publisher=QCode 但品牌未清洗                                                                                          | 独立品牌、无上游商标风险           | 🔴 大 | P0     |
| 2                   | **测试失败修复**       | 1 个后端测试失败                                                                                                                                                            | 0 失败                             | 🔴 小 | P0     |
| 3                   | **用户文档**           | 仅有内部设计文档（docs/），无面向用户的安装/使用/FAQ 文档                                                                                                                   | 完整用户文档站                     | 🔴 大 | P0     |
| 4                   | **落地页/官网**        | 无                                                                                                                                                                          | 产品官网 + 安装入口                | 🔴 大 | P0     |
| 5                   | **隐私与合规**         | 有 PRIVACY.md/SECURITY.md 但未针对 QCode 定制                                                                                                                               | 合规的隐私政策、数据处理说明       | 🟡 中 | P0     |
| **P1 — 核心竞争力** |                        |                                                                                                                                                                             |                                    |       |        |
| 6                   | **工作流 Phase 3b/3c** | 仅 3a（只读内置工具）完成                                                                                                                                                   | MCP 工具 + 技能 + 有副作用工具全通 | 🟡 中 | P1     |
| 7                   | **工作流可视化编辑器** | MVP 已落地（c5950da43）：查看+编辑双模式、独立编辑器 panel、双文件保存；余保存链路 bug/schema 校验/测试/i18n，且与 AIWorkflow 仓编辑器归属未决（见 workflow-viz-editor.md） | React Flow 编辑器集成 webview      | 🟡 中 | P1     |
| 8                   | **并行子专家**         | 仅串行委派                                                                                                                                                                  | 并行委派 + Promise.all 汇总        | 🟡 中 | P1     |
| 9                   | **错误恢复与韧性**     | 工作流异常处理较简单                                                                                                                                                        | 重试、断点续跑、错误恢复策略       | 🟡 中 | P1     |
| **P2 — 体验打磨**   |                        |                                                                                                                                                                             |                                    |       |        |
| 10                  | **onboarding 引导**    | 无首次使用引导                                                                                                                                                              | 新用户引导流程                     | 🟡 中 | P2     |
| 11                  | **工作流市场/模板**    | 无                                                                                                                                                                          | 预置工作流模板库                   | 🟡 中 | P2     |
| 12                  | **用量统计与成本看板** | 有基础 cost 追踪                                                                                                                                                            | 完善的 token/cost 统计面板         | 🟢 小 | P2     |
| 13                  | **web 工具 i18n**      | webSearch 设置仅英文                                                                                                                                                        | 多语言                             | 🟢 小 | P2     |
| 14                  | **性能优化**           | 未做专项                                                                                                                                                                    | 大文件/大仓库性能优化              | 🟢 小 | P2     |
| **P3 — 商业化增值** |                        |                                                                                                                                                                             |                                    |       |        |
| 15                  | **账号与订阅**         | 无                                                                                                                                                                          | 用户账号、订阅/计费                | 🔴 大 | P3     |
| 16                  | **云端同步**           | 无                                                                                                                                                                          | 配置/历史/工作流云同步             | 🟡 中 | P3     |
| 17                  | **团队协作**           | 无                                                                                                                                                                          | 共享模式/工作流/配置               | 🟡 中 | P3     |
| 18                  | **遥测与产品分析**     | 无                                                                                                                                                                          | 匿名使用统计（opt-in）             | 🟢 小 | P3     |

### 2.2 核心优势（相对竞品的差异化）

QCode 相对 MX6 / Cursor / Cline / Roo Code 的**独有优势**：

1. **专家系统 + 工作流引擎** — 这是最大的差异化。竞品只有"单 agent + mode"，QCode 有：

    - 类型 A（工作流驱动）：确定性流程编排，LLM 只在节点内做局部智能
    - 类型 B（自驱专家）：开放探索，LLM 自主决策
    - 硬工具执行：工作流机械调工具，工具对模型隐形 → prompt 缓存稳定
    - 子专家委派：长程任务拆解，串行协作已通

2. **Cocos Creator 深度集成** — MCP 全套覆盖 scene/node/component/prefab/project，游戏开发场景独有能力

3. **APK 逆向工作流** — 编码了三个真实逆向案例经验，Unity/Cocos2dx/Godot 三引擎分流

4. **Web 搜索内置** — Tavily + web_fetch，无需 MCP 即可联网

---

## 三、开发计划（分四阶段，目标：商业级上线）

### 阶段一：上线就绪（P0，预计 2-3 周）

> 目标：消除所有上线阻塞项，产品可公开发布。

#### 1.1 品牌清洗与法务（2-3 天）

- [ ] 全局替换 `roo-code` → `qcode`：package.json、README、CHANGELOG、代码注释、i18n key
- [ ] 重写 README.md 为 QCode 品牌介绍（保留 LICENSE/NOTICE 的 Apache 2.0 归属）
- [ ] 清洗 CHANGELOG.md（Roo Code 历史保留为"基于 Roo Code 3.53.0"一行，之后是 QCode 自己的）
- [ ] 替换图标/品牌素材（assets/icons/）
- [ ] 检查所有 `roo` 字样的配置 key（`qcode.*` 已是，但内部代码变量可能残留）

#### 1.2 测试修复（0.5 天）

- [ ] 修复 1 个失败的后端测试（定位并修复）
- [ ] 确认 UI 测试全绿

#### 1.3 用户文档（3-5 天）

- [ ] 创建 `docs/user-guide/` 目录：
    - [ ] `getting-started.md` — 安装、首次配置、第一个任务
    - [ ] `modes.md` — 各模式说明与使用场景
    - [ ] `expert-system.md` — 专家系统概念、类型 A/B、如何创建工作流专家
    - [ ] `workflows.md` — 工作流编写指南、节点类型、参数引用
    - [ ] `mcp.md` — MCP 配置与使用
    - [ ] `web-search.md` — Web 搜索配置
    - [ ] `cocos-creator.md` — Cocos Creator 集成指南
    - [ ] `faq.md` — 常见问题
- [ ] 利用 docs-extractor mode 从代码提取准确信息

#### 1.4 落地页（2-3 天）

- [ ] 创建 `apps/landing/` 或独立仓库：
    - 产品介绍、核心功能、截图/演示
    - 安装入口（VS Code Marketplace 链接）
    - 文档链接
- [ ] 可选：GitHub Pages 部署（已有 `docs-pages.yml` workflow）

#### 1.5 隐私与合规（1-2 天）

- [ ] 更新 PRIVACY.md：明确 QCode 的数据处理（本地优先、API key 本地存储、不上传代码）
- [ ] 更新 SECURITY.md：漏洞报告流程
- [ ] 检查所有 provider 的数据流向说明

**阶段一交付物**：可公开发布的 v0.1.0，品牌干净、文档齐全、测试全绿。

---

### 阶段二：核心功能补全（P1，预计 3-4 周）

> 目标：补齐专家系统的关键缺口，让差异化功能完整可用。

#### 2.1 工作流 Phase 3b — MCP 工具硬执行（3-5 天）

- [ ] 扩展 [`HostToolInvoker.ts`](../src/core/expert/HostToolInvoker.ts) 支持 MCP 工具：
    - 绕开 `use_mcp_tool` 模型入口，直调 MCP 客户端
    - 复用 `toolPolicy.allowedTools` / `allowedCategories: ["mcp"]` 权限
- [ ] 测试：MCP 硬工具调用 + advance 续跑
- [ ] 这是爬虫等专用工具的价值兑现点

#### 2.2 工作流 Phase 3c — 技能 + 有副作用工具（3-5 天）

- [ ] 扩展 HostToolInvoker 支持 `skill`（走 [`SkillTool.ts`](../src/core/tools/SkillTool.ts)）
- [ ] 支持 `execute_command` / `write_to_file` / `edit` 等有副作用工具
- [ ] 完善审批 UI 标注"工作流步骤"
- [ ] 测试：技能执行 + 副作用工具 + 审批流程

#### 2.3 工作流可视化编辑器（7-10 天）⭐ 重点

> 2026-07-04 更新：MVP 已在 c5950da43 落地（详见 `workflow-viz-editor.md`）。剩余项与新增技术债如下。

- [x] 集成 React Flow（`@xyflow/react`）到 webview-ui
- [x] 节点类型渲染：llm / condition / tool / skill / expert / parallel
- [x] 节点配置面板：prompt 编辑、outputSchema、exec 软/硬（参数引用 `{{node.output}}` 的补全/校验未做）
- [x] 边配置：condition 的 `branch: true/false`（连线时可标 label）
- [ ] 图 JSON 导入/导出（与 AIWorkflow 引擎格式对齐 + 保存时 schema 校验）
- [x] 保存到 `.roo/workflows/`（双文件拆分；⚠️ 保存链路会丢 `inputs`/重置 `version`，须先修）
- [ ] 在 mode 创建界面绑定工作流
- [ ] 修复保存链路数据丢失 + round-trip 测试 + i18n + 死代码清理（见 workflow-viz-editor.md §6）
- [ ] **决策**：编辑器归属 QCode 还是 AIWorkflow 仓（两仓现各有一份编辑器实现，schema 需单一来源）

#### 2.4 错误恢复与韧性（3-5 天）

- [ ] 工作流节点失败的重试策略（可配置重试次数）
- [ ] 工作流断点续跑（基于 `workflow_state.json`，已部分实现）
- [ ] LLM 调用失败的重试与降级
- [ ] 工作流异常的 UI 可见性（错误节点高亮）

#### 2.5 并行子专家（5-7 天，可后置到阶段三）

- [ ] 重构单活动任务模型（当前委派时父任务 dispose）
- [ ] 支持一次派多个子专家、`Promise.all` 汇总
- [ ] 上下文管理：多子专家摘要合并

**阶段二交付物**：v0.2.0，专家系统功能完整，用户可通过可视化编辑器创建工作流。

---

### 阶段三：体验打磨（P2，预计 2-3 周）

> 目标：提升用户体验，降低使用门槛。

#### 3.1 新用户 onboarding（3-4 天）

- [ ] 首次启动引导：API key 配置、模式介绍、第一个任务演示
- [ ] webview-ui welcome 组件增强

#### 3.2 工作流模板库（3-4 天）

- [ ] 预置 5-10 个通用工作流模板：
    - 代码审查工作流
    - Bug 调查工作流
    - 文档生成工作流
    - 重构工作流
    - 发布流程工作流
- [ ] 模板可一键导入

#### 3.3 用量与成本看板（2-3 天）

- [ ] 增强 cost 追踪：按任务/模式/天 统计
- [ ] webview 成本面板

#### 3.4 i18n 补全（1-2 天）

- [ ] web 工具设置文案补 zh-CN 等语言
- [ ] 专家系统相关 UI 文案 i18n

#### 3.5 性能优化（3-5 天）

- [ ] 大文件读取优化
- [ ] 大仓库搜索优化
- [ ] webview 渲染性能（长对话列表虚拟化）

**阶段三交付物**：v0.3.0，体验完善，可面向更广泛用户。

---

### 阶段四：商业化增值（P3，按需，预计 4-6 周）

> 目标：构建商业模式基础设施。视商业模式决定是否/何时做。

#### 4.1 账号与订阅系统

- [ ] 用户注册/登录
- [ ] 订阅计划管理
- [ ] API key 托管（可选，用户可托管 key 由平台统一计费）

#### 4.2 云端同步

- [ ] 配置云同步
- [ ] 任务历史云同步
- [ ] 工作流云同步与分享

#### 4.3 团队协作

- [ ] 共享模式/工作流/规则
- [ ] 团队配置管理

#### 4.4 遥测与产品分析

- [ ] opt-in 匿名使用统计
- [ ] 功能使用热度分析

**阶段四交付物**：v1.0.0，完整商业化产品。

---

## 四、推荐执行顺序与里程碑

```
Week 1-3:   阶段一（P0 上线就绪）     → v0.1.0 公开发布
Week 4-7:   阶段二（P1 核心功能补全）  → v0.2.0
Week 8-10:  阶段三（P2 体验打磨）     → v0.3.0
Week 11-16: 阶段四（P3 商业化增值）    → v1.0.0
```

### 关键路径（Critical Path）

```
品牌清洗 → 用户文档 → [v0.1.0 发布]
                ↓
Phase 3b/3c → 可视化编辑器 → [v0.2.0 发布]
                          ↓
              onboarding + 模板库 → [v0.3.0]
                          ↓
              账号/订阅 → [v1.0.0]
```

**可视化编辑器是阶段二的关键路径**——没有它，工作流功能对普通用户不可用，差异化优势无法体现。

---

## 五、风险与对策

| 风险                               | 影响                 | 对策                                                |
| ---------------------------------- | -------------------- | --------------------------------------------------- |
| 工作流引擎跨仓库依赖（AIWorkflow） | 引擎变更可能破坏集成 | 冻结接口契约（start/advance），引擎侧改动需同步测试 |
| 可视化编辑器复杂度高               | 开发周期可能超预期   | 先做最小可用版（仅 llm+condition 节点），迭代增加   |
| Roo Code 上游持续更新              | fork 维护成本        | 定期 rebase 有价值上游改动；明确 QCode 独立路线     |
| 并行子专家需重构核心模型           | 影响范围大           | 后置到阶段二末或阶段三，先验证串行场景价值          |
| 商业模式未定                       | 阶段四方向不确定     | 阶段一-三先做免费开源版验证 PMF，再定商业模式       |

---

## 六、总结

### 当前位置

QCode 的**技术底座非常扎实**（继承自 Roo Code 3.53.0 的成熟基础设施 + 5400+ 测试），**差异化功能（专家系统 + 工作流引擎）已具雏形且设计精良**。核心 agent 能力、provider 覆盖、工具体系、MCP 集成均已达到生产级。

### 距离商业化的核心差距

1. **品牌与文档**（P0）— 最紧迫，但不难，是"清洗+补写"工作
2. **工作流可视化编辑器**（P1）— 最关键的功能缺口，是差异化落地的必要条件
3. **工作流 Phase 3b/3c**（P1）— 让硬工具全通，兑现"工具隐形"价值
4. **商业化基础设施**（P3）— 视商业模式决定

### 建议策略

**先发布，再迭代**：阶段一（2-3 周）即可发布 v0.1.0 免费版，用专家系统 + Cocos Creator 集成作为差异化卖点获取早期用户。阶段二补齐工作流编辑器后，差异化壁垒成型。商业模式验证后再投入阶段四。

技术风险低（底座成熟、测试覆盖高），主要工作是**产品化包装**（品牌/文档/编辑器/onboarding）而非底层重构。
