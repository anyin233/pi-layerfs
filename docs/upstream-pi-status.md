# LayerFS 上游 Pi 插件开发情况

调查日期：2026-10-23。通过 GitHub REST/GraphQL API 检查官方仓库、PR、评审、检查记录、源码与 Release；未运行上游插件测试。

## 结论

官方仓库已有一份社区提交的、包含实现和测试的 Pi 集成 PR，但尚未合并，也未进入正式发布。不能把它称为已获官方接纳或已发布的 Pi 插件。

- 仓库：[Ephemeral-AI-Lab/layerfs](https://github.com/Ephemeral-AI-Lab/layerfs)。调查时 main 为 `1aa56ece78e2ecd71b46cf07076100345df47239`；根目录没有 `pi/` 或 `port/`。[main 根目录 API](https://api.github.com/repos/Ephemeral-AI-Lab/layerfs/contents?ref=1aa56ece78e2ecd71b46cf07076100345df47239)
- PR：[LayerFS × Pi: Pi on a LayerFS Branch, on Linux and macOS (shared port/) #382](https://github.com/Ephemeral-AI-Lab/layerfs/pull/382)。作者 `Suge8`，来自 `Suge8/layerfs:feat/pi-layerfs`，创建于 2026-10-21 17:35:54 UTC，最后更新于 2026-10-21 18:49:47 UTC。
- 状态：OPEN、非 Draft、未合并；GitHub 返回 `mergeable: false` / `mergeable_state: dirty`，即与当前基分支存在合并冲突。3 个提交、38 个文件、增加 1048 行、删除 64 行。[PR API](https://api.github.com/repos/Ephemeral-AI-Lab/layerfs/pulls/382)
- 调查时 PR 的讨论评论、行内评论、评审均为空；head 的 check-runs 为 0，commit status 记录为 0。不能据此宣称 CI 已通过，也不能把缺少检查当成测试失败。[评审](https://api.github.com/repos/Ephemeral-AI-Lab/layerfs/pulls/382/reviews)、[检查](https://api.github.com/repos/Ephemeral-AI-Lab/layerfs/commits/b0564490925cf63681c1e9772a07bbd1e2d57cdb/check-runs)
- 最新正式 Release 是 2026-10-21 的 [v1.0.0](https://github.com/Ephemeral-AI-Lab/layerfs/releases/tag/v1.0.0)，该 tag 根目录也没有 `pi/`，Release 没有附件。[tag 根目录 API](https://api.github.com/repos/Ephemeral-AI-Lab/layerfs/contents?ref=v1.0.0)

以下源码链接固定到 PR head `b0564490925cf63681c1e9772a07bbd1e2d57cdb`，避免分支后续变化影响调查依据。

## 已实现的功能

[README](https://github.com/Ephemeral-AI-Lab/layerfs/blob/b0564490925cf63681c1e9772a07bbd1e2d57cdb/pi/README.md) 与 [入口](https://github.com/Ephemeral-AI-Lab/layerfs/blob/b0564490925cf63681c1e9772a07bbd1e2d57cdb/pi/src/pi-layerfs/index.js) 描述并实现：

- `pi --layerfs PROJECT` 启用；不传此参数时保持普通 Pi 行为。
- 每个 session 从 main 创建自己的 Branch；名称由整个 session ID 的 SHA-256 前缀生成，恢复 session 时复用；可用 `--layerfs-branch` 指定名称。[session.js](https://github.com/Ephemeral-AI-Lab/layerfs/blob/b0564490925cf63681c1e9772a07bbd1e2d57cdb/pi/src/pi-layerfs/session.js)
- 替换 read/write/edit/ls/find/grep；write/edit 各用一次 `fs.apply` 提交；edit 使用 Pi 的 `edits[]` 参数，并在 Branch 当前 head 上执行。[files.js](https://github.com/Ephemeral-AI-Lab/layerfs/blob/b0564490925cf63681c1e9772a07bbd1e2d57cdb/pi/src/pi-layerfs/files.js)
- Bash 和用户 `!command` 共用 `mount → exec → commit → unmount`；普通失败退出也保存修改；同一模型消息中存在写工具时按顺序执行。[bash.js](https://github.com/Ephemeral-AI-Lab/layerfs/blob/b0564490925cf63681c1e9772a07bbd1e2d57cdb/pi/src/pi-layerfs/bash.js)、入口源码。
- `layerfs` 工具支持 status、log、diff、diff_commits、merge、publish；初始化失败会阻断项目文件工具及 `!command`，避免回落写入本地目录。来源：README、入口源码。
- Linux 直接使用仓库旁的 `sdk/js`；macOS 使用从 DSH 抽出的共享 `port/`，通过 Linux Store 容器调用 SDK。PR 同时修改 DSH 的相关导入与容器路由。[sdk.js](https://github.com/Ephemeral-AI-Lab/layerfs/blob/b0564490925cf63681c1e9772a07bbd1e2d57cdb/pi/src/pi-layerfs/sdk.js)、PR 描述。

## 验证、安装与限制

- 作者在 PR 中报告：Pi 1.3.0，Linux 和 macOS/colima 各 7/7 项真实 LayerFS E2E 测试通过；两平台使用 deepseek-flash 完成真实开发任务；做了逐例故障回注。检查到 [e2e.mjs](https://github.com/Ephemeral-AI-Lab/layerfs/blob/b0564490925cf63681c1e9772a07bbd1e2d57cdb/pi/tests/e2e.mjs) 确有 7 个测试，包含 faux provider 驱动的真实 Pi agent loop。测试通过及真实模型结果属于作者报告，本次未独立复跑。
- Docker Desktop 只做代码检查，未实测。来源：PR 的 Not tested 部分。
- 安装方式为 `pi install /path/to/layerfs/pi`，依赖完整 checkout 中相邻的 sdk/js 或 port；需要先准备 daemon、native 模块、Docker 镜像、项目 Store 和 LAYERFS_* 环境。README 明确说明根仓库 git URL 安装不可用。
- [package.json](https://github.com/Ephemeral-AI-Lab/layerfs/blob/b0564490925cf63681c1e9772a07bbd1e2d57cdb/pi/package.json) 使用名称 `pi-layerfs`、版本 `0.1.0`、`private: true`。这是源码中的版本声明，不能据此认定 npm 或独立安装包已经发布。
- 每次 Bash 都创建新 Workspace，不保留 shell 环境和工作目录；没有公开的 retained Workspace 或受管后台进程工具。后台进程导致 Busy 时保留挂载并报错；取消只能等待命令结束；提交冲突时丢弃此次 Workspace。read 仅支持文本；grep 仅区分大小写的字面搜索。来源：README Limits、bash.js、files.js。
- PR 作者明确请求维护者批准：将 AGENTS.md 中仅适用于 DSH 的 macOS Store 容器例外扩展到 Pi。没有看到维护者批准或拒绝的公开评审记录；不能推断具体未合并原因。

## 与本仓库的关系

| 方面 | 上游 PR #382 | 本仓库已发布 v0.1.0 |
| --- | --- | --- |
| 状态 | 社区 PR，未合并、有冲突 | 独立仓库，GitHub Release 已发布 |
| 名称 | pi-layerfs，private 源码包 | pi-layerfs，独立发布包；名称相同，来源不同 |
| 验证平台 | 作者报告 Linux/macOS colima | Linux x86_64；Pi 1.4.0 |
| 运行部署 | checkout + 外部部署参数 | 包含 SDK/native/daemon/Pi/镜像的离线安装包 |
| Bash | 每次调用临时 Workspace | 临时 Workspace + 显式 retained Workspace |
| 多 agent | 多 session 各有 Branch | 额外提供 lead 管理的 worker spawn/message/cancel |
| 管理界面 | Pi 工具与状态栏 | 项目管理和 Work/History/Files/Storage 仪表盘 |

本仓库信息依据 [README](../README.md)、[发布验证](release-verification.md) 及 [v0.1.0 Release](https://github.com/anyin233/pi-layerfs/releases/tag/v0.1.0)。这张表比较适配器的功能和交付方式，不是性能对测。上游 PR 比本仓库此次发布更早提交，不能把我们的独立插件称作已经进入官方仓库的实现。

相关的 [Issue #425](https://github.com/Ephemeral-AI-Lab/layerfs/issues/425) 提议将已用于 DSH 的 WSL2 Windows 路由抽为其他适配器可用的共享包，并引用 #382。截至调查时仍 OPEN、没有评论；它不是 Pi 已支持 Windows 的证据。

## 后续判断

当前可把 #382 作为轻量 Pi 原生适配及 macOS 共享路由的参考，重点关注其合并冲突处理、维护者对共享 port/ 的决定和 Pi 1.4.0 兼容性。继续使用本仓库现有发布包有明确的交付和工作流依据；在没有复跑上游和同条件对比之前，不宣称任何一方性能更好。本次没有安装、切换、修改上游代码或向上游发消息。
