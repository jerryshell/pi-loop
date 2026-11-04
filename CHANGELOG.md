# 变更记录

## 0.2.0 - 2026-11-05

### 变更

- 上下文超限判定改用宿主 `isContextOverflow()`，覆盖所有服务商文案，并支持静默溢出检测。原先的 8 条本地正则删除。
- 宿主自动压缩失败（`session_compact_failed`，`reason: "overflow"`）时不再重复压缩，直接停止并带上宿主的失败原因。
- 宿主自动完成超限恢复（`session_compact`，`reason: "overflow"`）时给出提示，不再静默。
- 状态栏新增上下文占用（50% 起显示，80% 变黄，92% 变红）与会话累计花费（含目录估算时前置 `~`）。

### 依赖

- 新增宿主包 `@earendil-works/pi-ai`，用于 `isContextOverflow()`。
- `@earendil-works/pi-coding-agent`、`@earendil-works/pi-tui` 下限提升至 `^1.5.0`。

### 打包

- 包管理统一为 bun：只维护 `bun.lock`，移除 `package-lock.json` 并加入 `.gitignore`，`package.json` 增加 `packageManager`。
- 新增 `files` 白名单，只随包发布 `index.ts` 与 `CHANGELOG.md`；`README`、`LICENSE` 由 npm 自动包含。

## 0.1.0 - 2026-11-04

首个版本：`/loop`、`/loop-off`、`/loop-off-now` 三个命令，四道点火机制，迭代指令注入与状态栏。
