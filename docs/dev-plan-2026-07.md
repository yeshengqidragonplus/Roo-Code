# 开发行动计划与方向建议（2026-07）

> 状态：行动清单（活文档，完成项就地勾选）
> 评估日期：2026-07-06
> 基线：`QC/Wittgenstein` @ `c5950da43`（workflow-viz MVP）+ `ceb75f526`（文档整理）
> 失效条件：以下任一发生后须修订对应章节——①编辑器归属决策落定（§2）；②§1 还债清单全部完成；③2026-08 底前无更新则整体视为过期，重新评估。
> 关联：`workflow-viz-editor.md`（问题清单细节）、`commercialization-gap-analysis.md`（长期规划）

## 0. 文档时效性约定（适用于 docs/ 全部文档）

为避免设计稿与实现漂移（先例：`workflow-dual-file-design.md` 的合并规则偏差、`workflow-editor-ownership.md` 与同提交代码矛盾），约定：

1. 每份文档头部标注：**状态**（设计稿 / 已实现 / 行动清单 / 已过期）+ **日期** + **基线 commit**。
2. 设计稿实现落地后，状态改"已实现"，实现偏差另立小节说明，不改写原设计（保留决策痕迹）。
3. 计划类文档完成项就地勾选，并在文末"变更记录"留一行（日期 + commit）。
4. 被推翻的结论不删除，就地标注"已过时：见 xxx"。

## 1. 立即：工作流编辑器还债（预计 1-2 天，先于一切新功能）

问题细节与修法见 `workflow-viz-editor.md` §5/§6，此处只列行动项：

- [ ] **P0** 修 `WorkflowView.handleSave` 丢失顶层 `inputs`、`version` 硬编码 1.0.0（保存只覆盖 `nodes/edges`）
- [ ] **P0** 修 `WorkflowRegistry.load()` 合并偏差（改回设计稿语义 `{ ...data, ...config, 架构字段覆盖 }`）
- [ ] **P0** round-trip 幂等测试：`load → save → load` 全等——一个测试同时守住上面两条
- [ ] **P1** 清死代码（`editGraph`、未用 import、sidebar 死 tab 路径、`onDone`/`t`）→ 恢复 pre-commit lint 通过
- [ ] **P1** `saveWorkflow` 入口 zod 校验，对齐 AIWorkflow 冻结的图 Schema 契约，错误回显编辑器
- [ ] **P1** `extension.ts` 移除 `process.removeAllListeners("warning")`（扩展宿主共享进程，全局副作用）
- [ ] **P2** 编辑器 UI 字符串 i18n；查看 Popover 宽度自适应 sidebar
- [ ] **P2** `requestWorkflowGraph`/`saveWorkflow` 双 handler 去重（抽 ClineProvider 公共方法）；state push 的图加载按 workflowId+mtime 缓存

## 2. 决策项：编辑器归属（阻塞编辑器方向的后续投入）

两仓现各有一份 React Flow 编辑器（AIWorkflow 里程碑 2 MVP + QCode 本实现），方案 A/B 详见 `workflow-viz-editor.md` §8（推荐 A：QCode 内嵌为产品面 + schema 单一来源）。**决策后须同步更新** `.roo/memory/workflow-editor-ownership.md` 与 `commercialization-gap-analysis.md` §2.3。

## 3. 短期主线（对齐 gap-analysis P1，顺序有调整）

1. **Phase 3b：MCP 工具硬执行**——提到最前，因为它直接解锁游戏方向价值（§4.4）
2. **错误恢复**：失败节点高亮 + 从失败节点重跑（可视化 UI 基础已具备，是 viz 的自然延伸）
3. Phase 3c 收尾（技能 + 副作用工具审批打磨）
4. 并行子专家（可后置到阶段三）

## 4. 游戏开发效率方向（2026-07-06 新增分析）

**定位前提**：QCode 的主用户是游戏开发（Cocos Creator 为主，Unity/Godot 以逆向工作流覆盖）。AI 编程代理在游戏方向的瓶颈不是"写代码"，而是**验证**——反馈回路要经过引擎编辑器和真机，代理改完代码自己看不到结果，只能等人验。按杠杆大小排序：

### 4.1 引擎验证闭环（最高杠杆）

- Cocos Creator MCP 补齐"代理自证"三件套：**运行预览/play mode**、**场景与运行画面截图**、**读编辑器 console 日志**
- 真机侧：adb 安装/启动/logcat 采集（可先做成 skill，成熟后转 workflow hard tool）
- 效果：代理从"改完等人验"变成"改完自己验、错了自己改"，这是数量级的效率差异，与 web 开发里"跑测试/curl 预览"同构

### 4.2 团队高频操作固化为技能（最快 ROI，零扩展代码）

技能系统已是数据驱动，直接写 3-5 个最高频任务的 skill：

- 新 UI 面板 / 新系统脚手架（按团队框架约定生成骨架 + 注册）
- 配表变更流水线（策划表 → JSON/代码常量 → 校验）
- 版本日志 / 提测检查单
- 方法：观察一周内自己重复做的事，重复 ≥3 次的就固化

### 4.3 引擎资产上下文

- `.scene`/`.prefab` 是大 JSON 且满是 UUID 引用，LLM 读不动：做 **uuid ↔ 资源路径解析工具**（读 `.meta` 文件），成本低价值高
- 代码索引扩展到资产引用关系（"谁引用了这个 prefab/贴图"），改资产前能算影响面

### 4.4 Phase 3b/3c 对准引擎 MCP

工作流硬执行 Cocos MCP 工具 = **确定性的批量引擎操作**（批量改 prefab、批量资源规范检查），把 P1 技术主线和游戏业务价值绑在一起——这是 §3 把 3b 提前的原因。

### 4.5 后续储备（依赖上面各项就绪）

- **发布工作流**：构建 → 装机 → 冒烟 → 采日志（依赖 3c 副作用工具 + checkpoint 回滚，机制均已具备）
- 性能审计工作流（draw call / 纹理内存 / 包体构成）
- 崩溃日志分诊专家（logcat/符号化 → 定位 → 建议）
- apk-reverse 逆向工作流继续作为标杆用例随引擎迭代

## 变更记录

- 2026-07-06 创建：基于 workflow-viz MVP 评审结论（§1-§3）+ 游戏方向效率分析（§4）。
