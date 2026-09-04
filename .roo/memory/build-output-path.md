# 打包输出路径

- 打包输出目录：`bin/`（项目根目录下）
- VSIX 文件命名：`qcode-<version>.vsix`
- 打包命令（在 `src/` 目录执行）：`npx vsce package --no-dependencies`
- 打包后复制到 bin 目录：`cp src/qcode-<version>.vsix bin/`
- 版本号在 `src/package.json` 的 `version` 字段

## 0.0.6 重打（2026-09-02 第七次，SHA 7ebe4c6af）

包含：专家专线会话 Phase 1-4（0209c30ae）+ roomodes 群组配置修正（863ba82ef）+ MCP 资源工具导入路径大小写修复（7ebe4c6af，TS1261 已清零）。验证：webview index.js 含完整 SHA `7ebe4c6af...`；extension.js 含 `expert-line` + `line-queue.json` + `cancelLineRequest`。已安装（`qcode.qcode@0.0.6`）。

## 0.0.6 重打（2026-08-30 第六次，SHA bb3ea7fae）

包含：专家/群组提示词分层重构（bb3ea7fae）——专家模式 roleDefinition 自包含、群组主程定位移入 workgroup.instructions、专家模式跳过 MODES 列表 + hidden 过滤 + lead 排除出同事列表、同事专属技能 modeSlugs 白名单。验证：webview index.js 含 SHA `bb3ea7fae`；extension.js 含 `WORKGROUP COLLEAGUES` + `WORKGROUP RULES` + `You are working as`。已安装。

## 历史

- 0.0.6（2026-08-28）：web_search 免费 Bing HTML 后端（auto 优先免费，无需 API key）
- 0.0.5（2026-07-08）：群组模式阶段 1-5 + 历史对话图片缩略图修复
- 0.0.4：内存优化 2-C + 权限审批 L1

## 0.0.6 打包实操（2026-08-28）

1. commit 功能（067c10348）→ commit 版本号+文档（ebb8ffe83）
2. `cd webview-ui && pnpm run build`（注入 SHA）
3. `cd packages/build && pnpm run build`
4. `cd src && npx vsce package --no-dependencies` → `src/qcode-0.0.6.vsix`
5. `copy src\qcode-0.0.6.vsix bin\`，删除 src 下的 vsix
6. 验证：解包检查 `extension/webview-ui/build/assets/index.js` 含完整 SHA `ebb8ffe83` 和 bing 代码（注意要精确匹配 `index.js` 而非 `.map`）
7. 安装：`code --install-extension bin\qcode-0.0.6.vsix --force`

## 0.0.6 重打（2026-08-28 第二次，SHA 9c3884a3d）

同日重打，包含：占位图固化修复（9c3884a3d）、共享文件库+GC（b4164f4ab）、删除确认面板（2a8b51074）、web-researcher 落盘协议（0897913dc）。验证要点：webview index.js 含完整 SHA；extension.js 含 `returning raw path for`（修复层1日志文案，常量名会被 esbuild 压缩不能直接搜）+ `gcSharedFiles`；webview 含 `requestTaskArtifacts`。

## 0.0.6 重打（2026-08-29 第五次，SHA c1b8b25e4）

包含：per-mode 项目规则/项目记忆注入开关（c1b8b25e4，ModeConfig.useProjectRules/useProjectMemory + ModesView 两个新勾选框 + 6 个同事模式全关三开关）。验证：webview index.js 含 SHA `c1b8b25e4` + `useProjectRules`；extension.js 含 `modeUseProjectRules` + `modeUseProjectMemory`。已安装。

## 0.0.6 重打（2026-08-29 第四次，SHA c6df0ec13）

包含：per-mode AGENTS.md 注入开关（81de58158，ModeConfig.useAgentRules + ModesView 勾选框 + 6 个同事模式关闭）、questions.hasQuestion 品牌文案 Roo→QCode（c6df0ec13，18 语言）。验证：webview index.js 含 SHA `c6df0ec13` + `QCode has a question`（无 Roo 版）；extension.js 含 `modeUseAgentRules`。已安装。

## 0.0.6 重打（2026-08-29 第三次，SHA 6466f3e6c）

包含：历史列表缩略图破图修复（587bc7397，localResourceRoots 随 customStoragePath 配置走 + 裸路径自愈）、品牌文案 Roo said→QCode said（6466f3e6c）。验证用 PowerShell `System.IO.Compression.ZipFile` 解包（本机无 adm-zip）：webview index.js 含 SHA `6466f3e6c` + `QCode said`；extension.js 含 `getStorageBasePath` + `isBareFilePath`。已 `code --install-extension` 安装。

## 0.0.6 重打（2026-08-29 第四次，SHA 764adfe6b）

包含：移除 Roo Code 最终版本公告弹窗（764adfe6b）——删除 Announcement 组件、宿主侧 latestAnnouncementId/didShowAnnouncement/shouldShowAnnouncement 全链路、18 个 locale 的 announcement/versionIndicator 键；VersionIndicator 改为纯展示 span（点击不再弹窗）。验证：webview index.js 含 SHA `764adfe6b` 且无 `finalRelease|announcement` 字符串。已安装。

## 踩坑

1. **`--out ../bin` 陷阱**：vsce 把 `../bin` 当输出文件名，在仓库根生成了一个名为 `bin` 的 39.6MB ZIP 文件（不是目录）。需手动重命名为 `bin/qcode-0.0.5.vsix`。脚本里 `mkdirp ../bin && vsce package --out ../bin` 会先建目录所以正常，手敲命令时要注意。
2. **本机内存压力**：16G 物理内存长期只剩 2-9G 时，pre-commit lint、vitest、vite build、esbuild 全部随机 OOM 崩溃（`Fatal process out of memory: Zone` / exit 0xC0000409）。等内存回升后重试即可成功。commit 可用 `--no-verify` 绕过（lint 已单独验证通过的前提下）。
3. **验证 SHA 注入**：解压 VSIX 检查 `extension/webview-ui/build/assets/index.js` 中是否包含完整 commit hash 字符串。
4. **PowerShell ConvertTo-Json 改 package.json 会重排全文件格式**（tab→空格、缩进变化），diff 污染。用 node 单行正则替换只改 version 一行。
