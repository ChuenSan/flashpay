# 项目工具与初始化记录

## 范围与版本

项目从空目录初始化，未创建 Git 仓库或提交，未修改个人模型或全局配置。用户确认宿主为 Pi Web，复用其 subagent 实现，未安装 pi-subagents-lite。

| 组件                | 固定版本 / 来源                                   | 项目位置                                                            |
| ------------------- | ------------------------------------------------- | ------------------------------------------------------------------- |
| 主工具 Node         | 26.13.0，初始化时官方最新 LTS                     | `.tools/node/`，声明在 `.node-version`                              |
| npm                 | 11.20.0，随主 Node 分发                           | `.tools/node/bin/npm`                                               |
| CodeGraph 专用 Node | 24.22.2，用户选择独立兼容运行时                   | `.tools/codegraph-node/`，声明在 `.pi/tools/codegraph-node-version` |
| CodeGraph           | 1.6.2                                             | `.pi/tools/package.json` 与 `package-lock.json`                     |
| skills 安装器       | 1.7.6                                             | 同上                                                                |
| Prettier            | 3.9.10                                            | 同上                                                                |
| Matt Pocock 技能    | `4ae2317ddb22b046e26455e4f9c9b3aaaf62212d`，15 项 | `.agents/skills/` 与 `skills-lock.json`                             |

宿主检测为 Pi Web 0.14.2 / pi-coding-agent 1.5.0，由宿主管理。CodeGraph 发布版内部要求 Node `>=20 <25`，因此不用主 Node 26 或包内自带的旧 Node 24.16.0，也不启用不受支持的版本绕过。

已校验的官方 macOS arm64 压缩包 SHA-256：

```text
Node 26.13.0: 6f5b3187d9df9fc007e881167905bc7d69ad26450ddc377c83d63256a2495b6e
Node 24.22.2: 1f5ac075be50bed4780ea3be19a007fda95ea4d527d28d76d0b91de47d915115
```

## 恢复与日常入口

```sh
./scripts/bootstrap-tools
./scripts/project-tool node -p 'process.execPath'
./scripts/project-tool npm --version
./scripts/codegraph version
./scripts/project-tool npm --prefix .pi/tools run format
./scripts/project-tool npm --prefix .pi/tools run format:check
./scripts/project-tool npm --prefix .pi/tools run config:check
# 初始化索引后，测试两个并发 MCP 客户端：
./scripts/project-tool npm --prefix .pi/tools run mcp:check
```

bootstrap 从 Node 官方下载两个固定运行时并核对官方 SHA-256，用主 Node 的 npm 执行 `ci --ignore-scripts` 恢复工具。支持 macOS/Linux arm64/x64，不修改 shell 或系统 Node。运行时、依赖、下载/npm 缓存、CodeGraph 状态和索引均已加入忽略规则。

VS Code 复用项目 Prettier 与根配置；GitHub Actions 使用相同的格式检查命令。当前无远端，CI 文件已准备但未在远端运行。尚无应用技术栈，Prettier 当前负责 Markdown、JSON、YAML 和工具脚本；后续应用检查按实际技术栈接入。

## 技能与 setup

安装器当前 Pi 目标实际为 `.agents/skills/`，由 Pi 原生发现，未重复复制到 `.pi/skills/`。15 项包括 setup、implement、code-review、research，以及任务拆分、分诊、测试、调试、领域建模和 agent 写作配套技能。

15 项共 46 个文件已与固定上游提交逐字节核对，格式化排除这些第三方文件。扫描时出现的 YAML 警告来自未选中的上游 in-progress 技能，不影响本项目安装。

setup 已按授权默认值生成 `docs/agents/` 的本地 Markdown 任务、默认分诊标签和单上下文领域文档规则。`.scratch/` 中的任务属于可版本化项目记录；Git 操作仍需用户授权。`GLOSSARY.md` 与 `docs/adr/` 按需生成，通用规范单独放在根 `AGENTS.md`。

## CodeGraph 的项目范围

- 程序由项目 npm 精确版本和锁文件恢复，运行时独立固定；`scripts/codegraph` 直接用项目 Node 24 启动平台包中的实际 JS CLI，绕过 npm shim 自带的旧运行时，不绕过版本安全检查。
- MCP 配置位于 `.pi/mcp.json`，从项目根目录运行 `./scripts/codegraph serve --mcp`，无需全局 PATH。最小 `/usr/bin:/bin` PATH 的实际协议测试已通过。
- 索引、socket、writer 锁在 `.codegraph/`。守护进程使用共享模式，多个子任务共用一个 writer。
- 运行进程的 HOME 与 XDG 目录隔离到 `.tools/codegraph-home/`，将上游硬编码的用户级 daemon registry 留在项目内；遥测关闭。这是 1.6.2 的兼容包装，升级时需重新核实。
- `init` 保留真实 HOME，以便上游的“拒绝索引 home 或其父目录”安全检查正确运行；在关闭遥测且使用 `--yes` 时仅写项目索引，避免对项目内 HOME 产生误判，无需 `--force`。
- `codegraph.json` 排除 `.tools/`、`.pi/`、`.agents/` 和依赖目录，第三方工具不会成为业务索引。

已读取发布版帮助与安装器源码。其主分支 README 虽已写 Pi 支持，1.6.2 安装器尚无 `pi` target，因此使用已核实的 `install --target opencode --location local --yes` 生成本地说明；保存原文后，将说明合并入工作流，并仅删除本次生成的临时 `opencode.jsonc`。实际 Pi 配置独立按其支持的格式建立。

## Subagent、权限与加载

- `explore` 复用实际注册名称，项目覆盖在 `.pi/agents/explore.md`；模型仅以该定义的字段为准。验收子任务未传模型覆盖，已从实际 session 的 `model_change` 核实使用所选模型。
- `review` 复用现有用户级只读 Review profile。跨机器恢复需先核实已注册同职责 `review`，缺少时再补充项目级定义；当前仓库不携带该用户级定义。
- 子任务不会自动加载项目 context 文件，所以 Explore 定义显式要求读取根规范，现有 Review 定义也包含此要求。
- 全局配置原先关闭内置 MCP，本项目仅通过 `.pi/settings.json` 启用它。项目 MCP 中关闭继承的 `github` / `cloudflare`，保留其全局定义和状态；当前项目只启用 CodeGraph。未来如需其他服务器，单独审阅对应项目覆盖。
- profile 的读取工具列表和 MCP 工具设置已实际检查；只读职责不等同于操作系统沙箱。CodeGraph 本身会维护自己的可再生成索引与运行状态。

## 验收与待完成

已通过：两个项目 Node 的实际版本/路径、npm 版本、CodeGraph 1.6.2 启动、最小 GUI-like PATH 下的双客户端 MCP initialize/list/call、共享 daemon 的实际 Node 24 进程与项目内 registry、技能发现/上游内容校验、shell 语法及格式检查。已实际重跑 bootstrap 的锁定依赖恢复，并再次通过 MCP 双客户端测试；`config:check` 验证运行时、包版本/锁文件、MCP 和索引配置的一致性，CI 复用此命令。

Explore 和 Review 均已实际读取 `AGENTS.md` 并调用 `mcp__codegraph__codegraph_explore`，返回 `This project has nothing indexed.`；证明子任务的 MCP 链路正常，不代表已验证业务语义。Review 提出的 CI 启动器语法检查遗漏已补齐，并新增配置一致性检查。

当前没有业务源码，初始化仅记录 CI YAML，符号和关系均为 0。真实业务符号、依赖或调用关系查询待源码建立后验证：

```sh
./scripts/codegraph init --yes
```

MCP 运行期间会监听源码变化；服务停止期间或批量变更后可先执行 `./scripts/codegraph sync`，并始终用源码核对查询结果。

本次新子任务已能加载项目工具，当前主会话仍需在 Pi Web 执行 `/reload`（必要时重新打开会话），确认项目受信任，并通过 `/mcp` 检查 CodeGraph 状态。共享配置的相对入口按会话目录解析，因此从项目根目录打开 Pi Web；子目录会话应切回根目录。无需修改全局信任或网络设置。

## 升级

仅在用户要求时升级，初始化重跑复用精确版本。

- npm 工具：修改 `.pi/tools/package.json` 的精确版本，通过项目入口运行 `npm --prefix .pi/tools install --ignore-scripts` 更新锁文件，再验证。
- 运行时：分别维护 `.node-version` 或 `.pi/tools/codegraph-node-version`，同步相关记录及主工具 engines/npm 声明，再运行 bootstrap。替换 CodeGraph 文件前先结束本项目的活跃查询和 daemon。
- 技能：通过项目入口运行 `.pi/tools/node_modules/.bin/skills update --project -y`，审阅源提交/锁文件变化；新增技能使用 `add --agent pi`。项目定制保持在根规范，上游原文保持不变。
- CodeGraph：通过 npm 精确版本和锁文件升级，复核支持的 Node、真实 JS 入口、HOME 隔离、MCP 配置及子任务调用；使用项目恢复流程，不运行全局 install/upgrade。
