# KernelAgentIR 本机并行开发实测（2026-10-22）

已在本机 Pi 1.4.0 安装 pi-layerfs，并用 KernelAgentIR 的完整临时副本完成真实工具基准和真实模型开发验收。原仓库未被修改。

**实测结论**

收益取决于工作区如何管理依赖。相对于每个 Git worktree 物理复制一份 4.8 GiB `.venv`，LayerFS 的四路开发批次耗时中位数减少 **64.6%**，项目数据占用减少 **72.3%**。相对于硬链接共享依赖的 Git worktree，耗时只减少约 **7.9%**，项目占用反而增加约 **9.2%**。仅源码工作区的性能与占用接近，不支持宣称普遍的大幅加速或节省磁盘。

以下均为本机三次测量的中位数，4 个并行开发分支。总耗时包含建立工作区、创建 Pi 会话、读取源码、新增回归测试、运行测试、保存提交及集成变更；首次导入、镜像准备、磁盘统计、会话关闭和清理不计入该列。

| 场景 | Git worktree 总耗时 | LayerFS 保留 Workspace 总耗时 | 本次观察到的耗时减少 | Git 项目占用 | LayerFS 项目占用 |
| --- | ---: | ---: | ---: | ---: | ---: |
| 仅源码，共享固定测试工具链 | 5.076 s | 4.981 s | 1.9% | 17.32 MiB | 17.74 MiB |
| 每个工作区物理复制完整 `.venv` | 13.474 s | 4.763 s | 64.6%（约 2.83 倍速度） | 19.04 GiB | 5.27 GiB |
| 完整 `.venv` 使用硬链接共享依赖文件 | 5.173 s | 4.763 s | 7.9% | 4.83 GiB | 5.27 GiB |

硬链接控制组使用 `cp -al` 模拟缓存中的不可变依赖文件共享，**没有运行实际的 `uv sync`**。它不能安全地独立修改已链接的依赖文件；LayerFS 的分支写入则保持隔离。因此这一行适用于依赖保持不变的开发任务。

1.9% 和 7.9% 是这三轮的观察值，不是稳定加速的统计证明。测试运行在有其他服务的工作站，未清空页缓存；未将模型推理速度归因于文件系统。

**耗时分解**

各列分别取中位数，因此列之和可能与“总耗时的中位数”略有差异。

| 后端 | 建立 4 个工作区及环境 | Pi 会话 | 并行开发和测试 | 集成 | 总耗时 |
| --- | ---: | ---: | ---: | ---: | ---: |
| 仅源码 Git | 0.0824 s | 0.0019 s | 4.933 s | 0.0581 s | 5.076 s |
| 仅源码 LayerFS 普通 Bash | 0.0015 s | 0.0410 s | 4.943 s | 0.0148 s | 5.000 s |
| 仅源码 LayerFS 保留 Workspace | 0.0015 s | 0.0417 s | 4.925 s | 0.0182 s | 4.981 s |
| 完整环境 Git 物理复制 | 8.2638 s | 0.0014 s | 5.081 s | 0.0724 s | 13.474 s |
| 完整环境 LayerFS 普通 Bash | 0.0021 s | 0.0475 s | 4.697 s | 0.0280 s | 4.797 s |
| 完整环境 LayerFS 保留 Workspace | 0.0017 s | 0.0409 s | 4.693 s | 0.0295 s | 4.763 s |
| 完整环境 Git 硬链接 | 0.5144 s | 0.0022 s | 4.589 s | 0.0528 s | 5.173 s |

主要收益来自建立工作区时避免复制依赖。pytest 本身没有数量级加速。每个 worker 在本基准只执行一条测试命令，普通 Bash 与保留 Workspace 的差距很小；没有测量长时间保留编译缓存的工作流。

**首次成本与磁盘口径**

- 源码首次导入约 **0.092 s**；完整环境首次导入约 **22.703 s**。完整环境约 34,587 个条目、5.03 GB 文件内容。公开 CA 和类型 stub 的恢复发生在导入后、派生工作分支前。
- 完整环境的“导入 + 一个稳态批次”估计约 **27.47 s**，比 Git 物理复制的单个批次慢。按本次中位数估算，需要约 3 个重新建立环境的四路批次才能摊平导入成本。这不代表长期或其他负载的测量结论。
- 硬链接控制组一次性准备共享环境约 **2.440 s**，另行记录，未混入每轮耗时。
- 表内 Git 占用包括主 checkout、worktree 的实际分配块，以及本轮 Git 元数据增量。硬链接控制组对共享环境和全部 worktree 用**同一次 `du`** 计数，链接的 inode 只计一次。
- LayerFS 占用包括 `global` Store、`home` 中的导入 backing、元数据、日志和 Docker 容器 `SizeRw`，采用首次完成四路批次后的实测值。没有仅以 SDK 的 logical/dedupe 比率代替物理占用。
- 完整环境的 LayerFS 项目数据约 **5,659,246,610 B**。其中保留的导入 backing 和全局 Store 都计入，未删除 backing 来改善数字。
- 两种后端共用的输入快照、基准日志文件和运行镜像不计入表内项目占用。测试镜像为 **1,301,434,225 B（约 1.21 GiB）**。若将整张镜像全部额外记给 LayerFS，完整环境总量约 **6.48 GiB**，相对 Git 物理复制仍节省约 **66.0%**。
- 本机原有基础运行镜像为 1,187,909,904 B；本次补入 Python 和测试工具的镜像逻辑增量约 113.5 MB。上述镜像字节是 Docker 报告的解压大小，不是注册表传输大小，也不是跨共享镜像层的精确物理归属。

**真实开发验收**

另外使用本机已配置的 `magpie/auto/deepseek-v4.1-flash`，通过插件 `layerfs_agent.spawn` 启动 4 个真实模型 worker。它们分别检查源码，新增 PEAddr、BankRegion、Dtype 和 Region 回归测试，运行测试，保存独立分支。随后通过插件 merge 工具集成四个分支，并在合并后的分支运行全部新增测试。

结果：4 个 worker 均完成；合并后 **6 passed in 0.10s**；整轮约 **22.864 s**。合并分支是 `real-development-merged-3`，最终 head 是 `1259515a37ae067040ad2fac21cb9c1c181a1759770937f09f394f9ff1979dbdb4`。四个测试文件已导出到临时目录的 `real-tests/`，可直接检查。

这轮验收不用于计算性能百分比。模型凭据只由宿主机 Pi 的 ModelRuntime 解析；本地、短期、带随机令牌的回环桥传递模型上下文和事件，没有把宿主凭据导入项目、测试镜像或报告。验收结束后桥已停止。

初次任务提示的句号曾被部分 worker 作为 `pytest .` 参数执行，触发全库收集并因精简镜像缺少 numpy/CUDA 等可选依赖失败。worker 随后运行目标文件通过，最终集成检查也通过；这不是全库或 GPU 测试通过的证明。复跑脚本已补充只运行目标文件的明确要求。

固定性能回放每个四路批次执行 4 项新增回归测试及 27 项原有 CPU 测试。源码、完整独立环境及硬链接控制组均完成三轮；相关 worker 测试与变更集成校验全部通过。

**环境与原仓库保护**

- AMD Ryzen 9 5950X，32 逻辑 CPU，125 GiB RAM；Linux 6.8.0-142-generic。
- Pi 1.4.0；运行镜像 Node 24.21.0、Python 3.12.11、pytest 9.0.3、Hypothesis 6.152.9。
- KernelAgentIR 原始 revision：`897392829b73af48eed7f2752aca6aafebb17d0b`。
- 原仓库：`/home/yanweiye/Projects/KernelAgentIR`。
- 完整复制目录：`/tmp/pi-layerfs-kernelagentir-HSOK3zhe/source`。首次复制明确使用 `cp -a --reflink=never`，未在原仓库建立 worktree，也没有用原 `.venv` 运行测试。
- 对原仓库的 34,587 个条目计算相对路径、文件权限、大小、mtime、文件 SHA-256 或 symlink 目标的有序清单；前后清单完全一致。30,918 个普通文件，4 个 symlink。
- 前后清单 SHA-256 均为 `8f80923afc99bed5d6b270a07899b2d7b237557e5b31717ce4dedcefdb381903`。访问时间不在校验范围内。
- 最后的 `git status` 复核曾因创建/删除锁改变原 `.git` 目录的 mtime；仅该目录时间发生变化，索引和所有文件内容未变。已按初始清单恢复此目录时间，并重新生成 `original-restored-final.json`，与初始清单完全一致。

原 `.venv/bin/python` 指向宿主机 uv 安装的 Python。测试镜像按相同绝对路径放入该 Python，避免测试落到原仓库环境。完整环境的正式测量设置 `PYTHONPATH=.`，pytest/Hypothesis 从各工作区自己的 `.venv` 加载；源码测量使用双方共用的精简镜像依赖。

**本次发现的使用限制**

1. 同项目多个新会话同时初始化会触发 binding 锁拒绝，即使项目已经导入。正式基准依次初始化会话，随后并行执行开发命令；串行会话准备时间已计入。生产并行使用应依次建立 worker，当前版本还不支持无条件同时绑定。
2. `sensitiveFiles` 会误拒绝公开的 `certifi/cacert.pem`，还会误拒绝 pyright 类型 stub 中名为 `credentials` 的目录。仅在临时副本把证书暂存到导入树外、把 stub 目录改名；导入后通过插件恢复证书和目录，再派生 worker。Git 对照也恢复相同内容。没有改动原目录或关闭插件的检查。
3. 不同 Store 部署必须有独立 `LAYERFS_CONTAINER_PREFIX`。复用前缀及项目名会与旧 sandbox 的 Docker 名称冲突而返回 HTTP 409。最终完整环境使用独立的 `pi-lfs-kernelbench-hsok3zhe-v6-` 前缀。
4. 与 hashline 扩展的文件工具存在冲突。当前安装采用显式容器启动器，普通 Pi 会话不自动加载 LayerFS。
5. Store 为 Disposable 模式，本次测试没有验证崩溃或断电恢复。

后续（2026-10-24）：第 1、2 项已修复。已初始化项目的 binding 改为无锁校验，只有首次导入互斥，并等待仍在心跳的导入进程；预检只检查普通文件，`.pem`/`.key` 只在含私钥时拒绝。见 README 的 Crash recovery 与 [verification](verification.md#layerfs-110-upgrade)。本基准数据未重测。

失败的依赖预检、导入过滤、绑定并发、容器前缀冲突和早期共享 PYTHONPATH 试跑日志分别保留；这些试跑不进入正式统计。没有把修改 PYTHONPATH 前的完整环境结果混入最终数据。

**本机安装入口**

已执行：

```bash
npm run build
pi install /home/yanweiye/.t3/projects/pi-layerfs
```

包登记在 `~/.pi/agent/settings.json`，该包的 `extensions` 为 `[]`。安装的 `/home/yanweiye/.local/bin/pi-layerfs` 会通过已有 `.layerfs-local/env.sh`，显式加载 `dist/extension.js`，并关闭本次调用中的其他扩展。`pi-layerfs --help` 已验证能显示 LayerFS 选项。

对已按 README 配置 `.pi/layerfs.json` 的项目：

```bash
cd /path/to/disposable-project
pi-layerfs
```

此入口使用隔离的容器 Pi 设置和会话目录，容器模型认证需要按正常 Pi 流程单独配置；普通宿主 Pi 的模型凭据不会自动进入容器。本次真实模型验收使用上述宿主回环桥完成。不要在尚未复制的原 KernelAgentIR 目录中初始化实验项目。

**证据与复跑**

- [机器可读的全部轮次与汇总](kernelagentir-benchmark-receipt.json)。`summary.*.disk` 是原始工作区增量或 Store 增量；报告中的完整项目空间另见 `derived.gitProjectBytes`、`derived.fullBytes` 和 `derived.sourceBytes`，不可混用。
- [固定任务基准脚本](../scripts/kernelagentir-bench.ts)。
- [真实模型开发验收](../scripts/kernelagentir-real-development.mjs) 与 [宿主模型桥](../scripts/kernelagentir-model-bridge.mjs)。这些是本次本机实验脚本，其中路径和项目标识按本机固定。
- 原始逐 worker 日志、原目录指纹、Dockerfile、镜像构建日志和独立 JSON 保存在 `/tmp/pi-layerfs-kernelagentir-HSOK3zhe/`。
- 成功的源码 Store：`pi-layerfs-kernelbench-hsok3zhe-v3`；完整环境 Store：`pi-layerfs-kernelbench-hsok3zhe-v6`。真实开发分支和测试历史保留。

复跑应创建新的、带本次 instance 标签的独立 Docker volume 和唯一 sandbox 前缀，再在私有 `env.sh` 中指定它们；不要直接重用已完成测量的工作区名称或删除现存 Store。测试镜像所需的 Dockerfile、Python 与依赖准备上下文位于临时目录 `image/`。新 volume 先跑完整环境，再跑硬链接控制组，后者复用前者的已初始化项目：

```bash
# ENV 指向新部署的私有 env.sh；COPY 指向已按上文处理公开证书/stub 的临时副本。
bash scripts/client.sh "$ENV" --project /tmp/pi-layerfs-kernelagentir-HSOK3zhe \
  /home/yanweiye/.t3/projects/pi-layerfs/node_modules/.bin/tsx \
  /home/yanweiye/.t3/projects/pi-layerfs/scripts/kernelagentir-bench.ts "$COPY" --full

bash scripts/client.sh "$ENV" --project /tmp/pi-layerfs-kernelagentir-HSOK3zhe \
  /home/yanweiye/.t3/projects/pi-layerfs/node_modules/.bin/tsx \
  /home/yanweiye/.t3/projects/pi-layerfs/scripts/kernelagentir-bench.ts "$COPY" --full --hardlink-only
```

仅源码组在另一个全新部署运行同一脚本，省略 `--full`。首次导入必须允许脚本创建的内部 source-only 路径成为该部署的固定 binding。

已清除失败预检的 4 个专用 volume、旧完整环境 sandbox 和硬链接控制组临时环境缓存；成功历史与输入副本保留供检查。宿主原有 LayerFS 部署和其他 Docker 服务未改动。

最终检查：`npm run typecheck`、`npm run lint`、`npm run build` 均通过；`npm test` 为 43 passed / 0 failed；新增 TypeScript 基准脚本的主动 LSP 检查无错误。两个模型验收脚本和本机启动器的语法检查通过。
