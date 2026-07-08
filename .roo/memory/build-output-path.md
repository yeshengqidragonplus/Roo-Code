# 打包输出路径

- 打包输出目录：`bin/`（项目根目录下）
- VSIX 文件命名：`qcode-<version>.vsix`
- 打包命令（在 `src/` 目录执行）：`npx vsce package --no-dependencies`
- 打包后复制到 bin 目录：`cp src/qcode-<version>.vsix bin/`
- 版本号在 `src/package.json` 的 `version` 字段

## 历史

- 0.0.5（2026-07-08）：群组模式阶段 1-5 + 历史对话图片缩略图修复
- 0.0.4：内存优化 2-C + 权限审批 L1
