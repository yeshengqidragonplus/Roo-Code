# unity-pro MCP 服务器设计（储备稿）

> 状态：设计稿（**储备，未排期**——需要时凭本文开工，无需回溯讨论记录）
> 日期：2026-07-07
> 基线：`QC/Wittgenstein` @ `1933c7351`（QCode 侧配套：`mcp-mode-visibility-design.md`）
> 归属：**独立项目/仓库**（QCode 不实现，先例：AIWorkflow 引擎）
> 失效条件：①开工时先核对 §6 契约与 QCode 侧模式级 MCP 可见性机制的实现是否一致；②QCode 侧机制未实现前，本文 §6 的 `modes` 声明不生效（工具会对所有模式可见，仅提示词膨胀，不影响功能）。
> 关联：`mcp-mode-visibility-design.md`（QCode 侧机制）、`freeze-2026-07.md`（决策背景）、`dev-plan-2026-07.md` §4（游戏方向分析）

## 1. 要解决的问题（自包含背景）

QCode 主用户做 Unity 游戏开发。agent 处理 Unity 工程时的核心痛点不是"读不懂 YAML"，而是**大序列化文件里的指针追踪税**：

- `.unity` 场景动辄上万行（实测参照：14000 行 ≈ 12-16 万 token），QCode 的 `read_file` 单次上限 2000 行，agent 只能 grep + 分段跳读；
- 文件内对象互指靠 `fileID`，跨文件引用靠 `{fileID, guid, type}` 三元组，每解一个引用（这个节点挂哪个脚本？OnClick 绑到谁？）就是 1-2 轮真实的工具往返；
- 典型任务"XX 按钮点了没反应，查一下"要花 **8-12 轮**在解引用上，一行业务逻辑还没看。

架构决策（2026-07-07 定）：主流程保持精干，**Unity 专业能力住在一个 MCP 服务器（unity-pro）里，由专门的子代理模式（unity-context）独占使用**。主任务 `new_task` 派单 → 子代理调 unity-pro 工具直查 → 摘要回填。子代理的"专业"必须是确定性工具，LLM 只负责理解问题和组织答案——**不允许子代理自己啃 YAML**，否则只是把税挪进了看不见的房间。

## 2. 架构选型

### 2.1 数据来源：编辑器桥 vs 静态解析

|          | A. 编辑器桥（编辑器插件 + 本地 socket/HTTP）                     | B. 静态解析（直接读工程文件）             |
| -------- | ---------------------------------------------------------------- | ----------------------------------------- |
| 数据质量 | 权威（AssetDatabase、真实层级、import 后状态、Inspector 实际值） | 需自己解 YAML；prefab instance 要手工合并 |
| 可用性   | 要求编辑器开着；编译/domain reload 期间请求会卡                  | 随时可用（CI、无人值守过夜跑）            |
| 操作能力 | 有（改属性、play mode、截图、console）——通向验证闭环             | 无（只读，写 YAML 风险高不做）            |
| 实现成本 | 编辑器 C# 插件 + MCP 适配进程；社区已有底子可扩展                | 纯 Node/TS 进程，无编辑器依赖             |

**推荐：以 A 为主体**（基于社区 Unity MCP 扩展，符合"扩展 Unity 功能"的既定方向，且日常开发编辑器本来就开着），**B 作为可选降级层**（编辑器不在线时对查询类工具静态兜底）。v1 可以只做 A，把 B 的接口留出（工具语义不变，实现可替换）。

### 2.2 进程形态

沿用社区 Unity MCP 的通用形态：**编辑器内 C# 插件**（承载真正的能力）+ **独立 MCP server 进程**（stdio 对接 QCode，转发到编辑器插件）。缓存放 MCP server 进程内（跨调用常驻）。技术栈跟随所选社区底子（多为 Python/Node + C#），不强求。

## 3. 工具清单

命名预算：QCode 生成的原生工具名为 `mcp--unity-pro--{tool}`，总长截断 64 字符，前缀占 16 → **工具名 ≤ 48 字符**，从简。每个工具的 description 第一句必须回答"何时用我"——子代理选工具全靠它。

### 3.1 M1 查询五件套（核心，先做；全部只读，建议 `alwaysAllow`）

| 工具      | 输入                                                 | 输出                                                                                                                               | 何时用                   |
| --------- | ---------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------- | ------------------------ |
| `outline` | scene/prefab 路径，可选深度                          | GameObject 层级树：名字、组件类型列表、子节点数                                                                                    | 进任何大文件前先拿全图   |
| `subtree` | 文件 + 节点路径（如 `Canvas/MainPanel/StartButton`） | 该节点及子树的组件详情：序列化字段值、**guid→资产路径、fileID→"类名 on 节点名"全部解析成明文**；UnityEvent 解析成"目标节点.方法名" | 定位到目标后看细节       |
| `resolve` | guid / 资产路径 / 脚本类名（支持批量数组）           | 双向换算结果                                                                                                                       | 单点换算，主流程也可能用 |
| `refs`    | 资产路径或 guid，可选范围                            | 引用它的资产清单（含 prefab instance 的 m_Modifications 命中）                                                                     | 改/删资产前算影响面      |
| `find`    | 名字/组件类型/标签 + 范围（单文件或全工程）          | 命中节点列表（文件 + 节点路径）                                                                                                    | 不知道东西在哪时         |

**输出纪律（所有工具共守）**：面向 LLM 蒸馏——路径不给 guid、类名不给 fileID；单次响应设 token 上限（建议 ~2000 token），超限截断并注明"还有 N 项，用参数收窄"；绝不回吐原始 YAML 块。

### 3.2 M2 审计类（只读）

- `missing`：丢失引用 / missing script 扫描（范围参数）
- `unused`：未被任何场景/prefab/代码引用的资产清单（首次全量扫描较慢，结果缓存）

### 3.3 M3 操作与验证闭环（写操作走审批，不进 `alwaysAllow`）

- `set_property` / `add_component` / `remove_component`：经编辑器 API 改序列化数据（不手写 YAML）
- `play` / `stop` / `screenshot` / `console_read`：运行预览、截图、读 console——对应 dev-plan §4.1"代理自证三件套"的 Unity 版，是"改完自己验"闭环的落点
- 真机侧（adb 装包/logcat）**不进本服务器**，按原计划做成 skill

## 4. 关键技术点备忘

1. **Unity YAML 方言**（静态层用）：`--- !u!{classID} &{fileID}` 分文档，通用 YAML 库解不了；行扫描器足够——切文档、抓 fileID/类型/`m_Name`/`m_Father`/`m_Children`/`m_Component`/`m_Script`。
2. **guid 索引**：扫 `**/*.meta` 抓 `guid:` 行（正则即可），按文件 mtime 失效；脚本类名 = 文件名（Unity 强制）；贴图子资产（sprite）从 `.meta` 的 `internalIDToNameTable` 解名字。
3. **prefab instance**：场景里的 prefab 实例只存差量（`PrefabInstance` + `m_Modifications`），查询时需与源 prefab 合并展示；编辑器桥天然免此问题（拿到的就是合并后状态）——这是推荐 A 为主体的重要原因。
4. **前提检查**：`ProjectSettings` 的 Asset Serialization Mode 必须是 Force Text，二进制序列化时静态层直接报错指引；提供 `project_info` 工具做环境自检（Unity 版本、序列化模式）。
5. **编辑器桥的卡顿处理**：编译/domain reload/play mode 切换期间请求排队 + 超时返回可读错误（"编辑器编译中，稍后重试"），不能挂死子代理。
6. **缓存**：查询结果按 `文件 mtime` 为键存进程内；`refs`/`unused` 的全量索引首次构建后用文件监听或 mtime 批查增量维护。QCode 侧完全不感知缓存。

## 5. Cocos 变体备忘（以后）

同架构可复制到 Cocos Creator，差异点：`.scene`/`.prefab` 是 JSON（比 YAML 好解）；**但 3.x 自定义脚本组件的 `__type__` 是压缩 uuid**（22 位 base64 变体），必须实现 uuid 压缩/解压算法才能解出"挂了哪个脚本"——这是 Cocos 侧最硬的痛点（grep 无解）。查询工具语义与 §3 完全一致，服务器可命名 `cocos-pro`。

## 6. 与 QCode 的对接契约

1. **服务器名**：`unity-pro`（QCode 侧 `mcp_settings.json` / `.roo/mcp.json` 中的键名，也是工具名前缀来源）。
2. **可见性声明**：配置条目加 `"modes": ["unity-context"]`——依赖 QCode 侧"模式级 MCP 可见性"机制（`mcp-mode-visibility-design.md` 方案 A）。机制未实现时此字段被忽略（工具全模式可见，功能不受影响）。
3. **审批**：§3.1/§3.2 只读工具加入该服务器 `alwaysAllow`；§3.3 写操作不加，走正常审批（L1 沙盒下 MCP 从严，见 `approval-mechanism-design.md` §4）。
4. **子代理模式**：`unity-context` 模式定义见 `mcp-mode-visibility-design.md` §5.1；路由指引一行写进 `.roo/rules/rules.md`。
5. **错误消息面向 LLM**：可读、含下一步建议（子代理直接消费错误文本决定重试/换参）。

## 7. 验收标准（开工时的靶子）

拿真实工程里 ≥10000 行的场景，跑基线任务"XX 按钮点了没反应，查一下绑定链路"：

- 解引用轮数：从 ~8-12 轮降到 **≤3 轮**（outline → subtree → 开脚本）；
- 主对话（父任务）token 增量：只含派单 + 摘要回填，**不含任何 YAML 片段**；
- 编辑器编译期间调用：得到可读错误而非超时挂死。

## 变更记录

- 2026-07-07 创建（基线 `1933c7351`）：储备稿。来源：2026-07-07 子代理架构讨论（主流程精干 + 专业子代理 + 服务器侧可见性声明）。
