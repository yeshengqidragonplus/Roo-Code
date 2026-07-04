# QCode 商业化状态快照

> 记录于 2026-07-01，用于后续任务快速定位项目商业化进度。

## 项目定位

QCode 是 Roo Code 3.53.0 的 fork，定位为 VS Code 插件型 AI 编程助手。当前版本 0.0.4，publisher=QCode，但品牌/文档/CHANGELOG 仍大量残留 Roo Code 内容。

## 差异化功能（相对竞品的核心壁垒）

1. **专家系统**（`src/core/expert/`）：类型 A（工作流驱动）+ 类型 B（自驱），Phase 1-3a 已实现
2. **工作流引擎**：独立仓库 AIWorkflow（`C:\WorkSpace\AIProject\AIWorkflow`），已集成
3. **Cocos Creator MCP**：全套 scene/node/component/prefab/project 工具
4. **Web 搜索**：Tavily + web_fetch 内置工具
5. **APK 逆向工作流**：Unity/Cocos2dx/Godot 三引擎分流

## 商业化差距（详见 docs/commercialization-gap-analysis.md）

- **P0 阻塞上线**：品牌清洗、用户文档、落地页、测试修复（1 个失败）
- **P1 核心缺口**：工作流可视化编辑器（最关键）、Phase 3b/3c 硬工具、并行子专家
- **P2 体验**：onboarding、模板库、i18n 补全
- **P3 商业化**：账号订阅、云同步、团队协作

## 关键路径

可视化编辑器是阶段二的关键路径——没有它，工作流功能对普通用户不可用。

## 测试规模

后端 5393 passed / 1 failed（374 文件）；UI 1267 passed。CI 有 code-qa/codeql/changeset/marketplace-publish/nightly。
