# APK 逆向工作流设计说明

> **工作流文件**: `.roo/workflows/apk-reverse-engineering.json` > **专家 slug**: `apk-reverse-engineer` > **来源**: Hexa Away (Unity IL2CPP) / Jewel Coloring (Cocos2dx) / Meowdoku (Godot) 三个实战案例
> **目的**: 用真实逆向需求打磨专家系统工作流功能，验证 Phase 1-3c 全链路

---

## 1. 设计目标

把三个逆向项目的实战经验编码进一条工作流，让工作流引擎驱动整个逆向过程：

1. **引擎识别分流** — condition 节点根据识别结果路由到 Unity/Cocos2dx/Godot 分支
2. **经验编码** — 每个 llm 节点的 prompt 内嵌从案例提炼的规则、检查清单、止损原则
3. **全节点类型覆盖** — 用到 llm（软）、condition（分支），验证引擎控制流
4. **toolPolicy 验证** — 专家声明 `toolPolicy`，验证硬工具权限模型（Phase 3c）
5. **真实可用** — 不是 demo，是能跑真实 APK 逆向的工作流

---

## 2. 工作流结构

```
init(llm) → decompile(llm) → identify-engine(llm)
                                    │
                    ┌───────────────┼───────────────┐
                    ▼               ▼               ▼
             engine-check      cocos-check      godot-check
             (condition)       (condition)      (condition)
              true│false         true│false        true│false
                  │                │                │
    ┌─────────────┘    ┌───────────┘    ┌───────────┘
    ▼                  ▼                ▼
unity-il2cpp-dump  cocos-ida-analysis  godot-gdc-decode
    │                  │                │
    ▼                  ▼                ▼
unity-stub-analysis cocos-data-locate  godot-find-key
    │                  │                │
    ▼                  ▼                ▼
unity-data-acquire ────┼───── ──────────┘
    │                  │          │
    └──────────┬───────┘          ▼
               ▼            unknown-engine
            decrypt(llm) ◄───────┘
               │
               ▼
         extract-data(llm)
               │
               ▼
           verify(llm)
```

### 2.1 节点清单

| 节点 ID               | 类型      | exec | 作用                                |
| --------------------- | --------- | ---- | ----------------------------------- |
| `init`                | llm       | soft | 项目初始化，创建 REVERSE_MAP.md     |
| `decompile`           | llm       | soft | apktool 反编译，信息收集            |
| `identify-engine`     | llm       | soft | 引擎识别，输出 JSON `{engine, ...}` |
| `engine-check`        | condition | —    | `engine === "unity"` 分流           |
| `cocos-check`         | condition | —    | `engine === "cocos"` 分流           |
| `godot-check`         | condition | —    | `engine === "godot"` 分流           |
| `unity-il2cpp-dump`   | llm       | soft | Il2CppDumper + AssetRipper          |
| `unity-stub-analysis` | llm       | soft | C# stub 静态分析（最重要阶段）      |
| `unity-data-acquire`  | llm       | soft | 数据获取（本地/CDN/API 三路径）     |
| `cocos-ida-analysis`  | llm       | soft | IDA Pro 核心逻辑反编译              |
| `cocos-data-locate`   | llm       | soft | BigFile 数据定位与提取              |
| `godot-gdc-decode`    | llm       | soft | GDScript .gdc 解码                  |
| `godot-find-key`      | llm       | soft | 从源码找加密密钥                    |
| `unknown-engine`      | llm       | soft | 未知引擎通用分析                    |
| `decrypt`             | llm       | soft | 加密数据破解（Hex Dump First）      |
| `extract-data`        | llm       | soft | 数据提取与格式分析                  |
| `verify`              | llm       | soft | 验证与总结                          |

### 2.2 分流逻辑

三级 condition 级联实现四路分流：

```
engine-check (engine === "unity")
  ├── true  → unity-il2cpp-dump
  └── false → cocos-check (engine === "cocos")
                ├── true  → cocos-ida-analysis
                └── false → godot-check (engine === "godot")
                              ├── true  → godot-gdc-decode
                              └── false → unknown-engine
```

引擎的 `edgeEnabled` 逻辑：condition 节点 `output === true` 选 `branch:"true"` 出边，`output === false` 选 `branch:"false"` 出边。未匹配的分支节点被 `skipInactive` 标记为 skipped。

---

## 3. 经验编码

每个 llm 节点的 prompt 内嵌了从三个案例提炼的实战经验：

### 3.1 通用经验（所有节点）

| 规则                           | 来源                                   | 编码位置                     |
| ------------------------------ | -------------------------------------- | ---------------------------- |
| 逆向地图先行（REVERSE_MAP.md） | Jewel Coloring 规则1                   | init                         |
| 主从引用文档结构               | Jewel Coloring 规则2                   | init                         |
| 全面解包所有 split APK         | Jewel Coloring 规则6 / Meowdoku 规则2  | decompile                    |
| 增量验证                       | Jewel Coloring 规则10 / Meowdoku 规则9 | extract-data, verify         |
| 时间盒原则（30分钟无突破转向） | Hexa Away 教训5                        | unity-stub-analysis, decrypt |
| 问题记录表                     | Jewel Coloring 规则9                   | verify                       |

### 3.2 Unity IL2CPP 分支经验

| 规则                     | 来源            | 编码位置            |
| ------------------------ | --------------- | ------------------- |
| C# Stub 优先策略         | Hexa Away 规则1 | unity-stub-analysis |
| Unity 资源提取三步法     | Hexa Away 规则2 | unity-il2cpp-dump   |
| IL2CPP 代码逆向四步法    | Hexa Away 规则3 | unity-il2cpp-dump   |
| 抓包优先于逆向           | Hexa Away 规则4 | unity-data-acquire  |
| 不要根据类名假设加密方式 | Hexa Away 教训1 | unity-stub-analysis |

### 3.3 Cocos2dx 分支经验

| 规则                          | 来源                 | 编码位置           |
| ----------------------------- | -------------------- | ------------------ |
| 逆向逻辑优先                  | Jewel Coloring 规则3 | cocos-ida-analysis |
| 分析文件分类系统              | Jewel Coloring 规则7 | cocos-data-locate  |
| Unicorn Engine 解决反编译偏差 | Jewel Coloring 规则4 | decrypt（间接）    |
| 密钥流模式批量解密            | Jewel Coloring 规则5 | decrypt（间接）    |

### 3.4 Godot 分支经验

| 规则                   | 来源            | 编码位置         |
| ---------------------- | --------------- | ---------------- |
| GDScript 优先策略      | Meowdoku 规则1  | godot-gdc-decode |
| GDScript 逆向四步法    | Meowdoku 规则3  | godot-gdc-decode |
| 代码分析优先于暴力破解 | Meowdoku 规则4  | godot-find-key   |
| 关注 Godot 版本差异    | Meowdoku 规则5  | godot-gdc-decode |
| 禁止暴力破解密码       | Meowdoku 规则10 | godot-find-key   |

### 3.5 加密破解经验

| 规则                         | 来源            | 编码位置 |
| ---------------------------- | --------------- | -------- |
| Hex Dump First               | Hexa Away 规则5 | decrypt  |
| 已知明文攻击                 | Hexa Away 规则6 | decrypt  |
| 编码意识（码点级 vs 字节级） | Hexa Away 规则7 | decrypt  |

---

## 4. 专家配置

```yaml
slug: apk-reverse-engineer
kind: workflow
workflow:
    workflowId: apk-reverse-engineering
groups: [read, command, edit] # 软 LLM 步骤需要的工具组
toolPolicy: # 硬工具权限（Phase 3c）
    allowedTools: [read_file, list_files, write_to_file, execute_command, search_files]
    allowedCategories: [read, edit, command]
```

### 4.1 groups vs toolPolicy 的关键区别

| 维度   | `groups`                         | `toolPolicy`                      |
| ------ | -------------------------------- | --------------------------------- |
| 作用   | 决定系统提示词里给模型看哪些工具 | 决定工作流硬节点能机械调哪些工具  |
| 可见性 | 模型可见（进系统提示词）         | 模型不可见（不进提示词，保缓存）  |
| 用途   | 软 LLM 步骤里模型自主调工具      | 硬节点宿主机械执行，不花 LLM turn |

**反模式警告**：不要为了让硬工具能跑而去加 `groups`——加了就把工具塞回系统提示词、被模型看见、击穿缓存前缀。

### 4.2 checkpoint 接入

`execute_command` 和 `write_to_file` 是有副作用的工具。Phase 3c 的 `HostToolInvoker` 会在执行前自动调 `checkpointSave` 存档点，失败时调 `checkpointRestore` 回退（影子 git）。这复用了 `presentAssistantMessage` 里模型驱动工具的同一机制。

---

## 5. 对工作流引擎的验证价值

这条工作流是 Phase 1-3c 全链路的真实测试用例：

| 引擎能力                | 验证点                                                                       | 对应节点                         |
| ----------------------- | ---------------------------------------------------------------------------- | -------------------------------- |
| **Phase 1 软步骤**      | llm 节点 nextPrompt + attempt_completion 拦截                                | 所有 llm 节点                    |
| **节点引用**            | `{{inputs.apkPath}}`、`{{init.output}}`、`{{identify-engine.output.engine}}` | 全链路                           |
| **condition 分流**      | 三级级联 condition，branch 匹配，skipInactive                                | engine/cocos/godot-check         |
| **JSON outputSchema**   | identify-engine 输出 JSON，下游 condition 引用 `.engine` 字段                | identify-engine → engine-check   |
| **多分支汇聚**          | 三条分支汇聚到 decrypt                                                       | decrypt                          |
| **Phase 3c toolPolicy** | 专家声明 toolPolicy，硬工具权限校验                                          | 专家配置                         |
| **checkpoint**          | 有副作用工具的存档/回退                                                      | decompile, init（write_to_file） |

### 5.1 发现的引擎改进点（冒烟测试验证）

用真引擎冒烟测试后发现并修复了一个关键问题，验证了两个设计假设：

#### 已修复：llm 节点 JSON 输出必须声明 outputSchema

**问题**：`identify-engine` 节点要求 LLM 输出 JSON `{engine: "godot", ...}`，下游 condition 引用 `{{identify-engine.output.engine}}`。但初始版本没有声明 `outputSchema`，引擎的 `parseOutput` 不会尝试 `JSON.parse`，lastOutput（JSON 字符串）被原样存为字符串。condition 求值时 `getByPath(string, ["engine"])` → 字符串没有 `.engine` 属性 → `undefined === "unity"` → `false`，导致**所有分支都走 unknown-engine**。

**修复**：给 `identify-engine` 节点加 `outputSchema`。引擎对声明了 `outputSchema` 的 llm 节点会尝试 `JSON.parse(lastOutput)`，成功则存为对象，下游 `{{identify-engine.output.engine}}` 才能正确取到字段值。

**经验**：**llm 节点输出 JSON 且下游 condition/引用需要访问字段时，必须声明 `outputSchema`**。否则 output 是字符串，字段引用全部返回 undefined。这是引擎的一个隐含契约——`outputSchema` 不仅是文档/校验用途，更是触发 JSON 解析的开关。

#### 已验证：多分支汇聚 + skipped 节点引用

**设计假设**：`decrypt` 节点同时引用四条分支的 output，但只有一条分支执行，其余三条 skipped。skipped 节点 output 为 undefined，`resolveValue` 对 undefined 返回空字符串 `''`。

**冒烟验证**（Godot 分支）：

```
decrypt prompt snippet:
- Unity:              ← 空字符串（skipped）
- Cocos:              ← 空字符串（skipped）
- Godot: 密钥找到：meowdoku-2026  ← 有值（执行了）
- Unknown:            ← 空字符串（skipped）
```

**结论**：多分支汇聚设计可行。prompt 里列出所有分支引用，skipped 的自动为空，不影响可读性。无需条件式引用。

#### 已验证：condition 级联 skipInactive

三级 condition 级联时，`skipInactive` 正确跳过未激活的 condition 节点本身。Unity 分支测试中，`engine-check:true` 后 `cocos-check` 和 `godot-check` 都被 skipped（因为 `engine-check` 的 true 出边直接到 `unity-il2cpp-dump`，不经过 `cocos-check`）。

---

## 6. 使用方式

### 6.1 前置条件

1. QCode 配置项 `qcode.workflowEnginePath` 指向 AIWorkflow 引擎产物
2. 安装逆向工具：apktool、Il2CppDumper、AssetRipper、IDA Pro（可选）
3. 目标 APK 文件

### 6.2 启动

在 QCode 中切换到 `apk-reverse-engineer` 模式，输入：

```
请逆向分析 /path/to/game.apk，目标是提取所有关卡数据
```

工作流会自动：

1. 创建项目结构
2. 反编译 APK
3. 识别引擎
4. 分流到对应引擎的分析分支
5. 破解加密、提取数据
6. 验证并生成报告

### 6.3 输入参数

| 参数        | 必填 | 说明                            |
| ----------- | ---- | ------------------------------- |
| `apkPath`   | 是   | APK 文件路径                    |
| `goal`      | 是   | 逆向目标                        |
| `outputDir` | 否   | 输出目录（默认 reverse-output） |

---

## 7. 与案例文档的映射

| 案例文档                              | 对应工作流节点              | 编码的经验           |
| ------------------------------------- | --------------------------- | -------------------- |
| `HexaAway_案例复盘与经验总结.md`      | unity-\* 分支 + decrypt     | 9 条规则 + 6 条教训  |
| `JewelColoring_案例复盘与经验总结.md` | cocos-\* 分支 + init/verify | 11 条规则 + 4 条教训 |
| `Meowdoku_案例复盘与经验总结.md`      | godot-\* 分支               | 9 条规则 + 5 条教训  |
| `Unity_IL2CPP_逆向标准流程.md`        | unity-\* 分支               | 标准流程 6 阶段      |
| `加密数据破解指南.md`                 | decrypt                     | 7 步标准流程         |
| `Frida_环境兼容性矩阵.md`             | decompile（架构检查）       | Houdini 诊断         |
| `Frida_Hook模拟器踩坑.md`             | decompile（反检测检查）     | 反 Frida 检测        |
| `IDA_MCP_Batch_Decompiler_*.md`       | unity-il2cpp-dump           | py_eval 批量反编译   |
| `逆向提高.md`                         | 全流程                      | 方法论 + 止损决策树  |
| `Demo制作总结.md`                     | verify                      | 验证策略             |

---

> **文档版本**: v1.0 | **最后更新**: 2026-06-28
