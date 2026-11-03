# Flashpay 项目规范

<!-- vibe-init:workflow:start -->

## 开发工作流

- 本文件是通用项目规范入口；其他宿主说明通过链接引用。
- 主 agent 将代码库研究与探索委派给 `explore`；implement 等工作流的探索阶段同样遵循此路由，局部明确修改按任务范围执行。
- `explore` 先读取本文件与相关目录规范，使用 CodeGraph MCP 查询符号、依赖、调用路径和影响范围，再以源码核对。
- 主 agent 编排 code-review，将 Standards 和 Spec 分别交给独立的 `review` 子任务；提供规范、需求、审查基准和变更范围，返回含文件位置与依据的意见。
- subagent 在当前子任务内直接探索、查询 CodeGraph；工具或索引不可用时明确报告，并将源码搜索标为回退，保持未验证项可见。
- 外部资料研究仅交给已核实具备网页及一手来源访问能力的 agent；当前 `explore` 不承担网页研究。
- 工作流定制维护在本文件，上游技能原文由安装工具管理。初始化后的重载和待验收项见 [工具说明](docs/tooling.md)。

## 工具与检查

- 项目工具通过 `./scripts/project-tool <命令>` 运行；恢复固定 Node 与锁定依赖使用 `./scripts/bootstrap-tools`。
- 格式化：`./scripts/project-tool npm --prefix .pi/tools run format`；检查：`./scripts/project-tool npm --prefix .pi/tools run format:check`。编辑器和 CI 复用同一 Prettier 配置。
- CodeGraph 通过 `./scripts/codegraph` 使用独立的兼容项目运行时。新增业务源码后运行 `./scripts/codegraph init --yes`；连接与真实源码查询分开验收，索引结果以源码核对。
- 按改动执行相关检查，报告实际结果及待完成项。仅在用户要求时建立 Git 仓库或提交，默认保留工作区供审阅。
- 提交采用 Conventional Commits；技能相关修改使用 `chore`，例如 `chore(skills): configure project workflow`。

<!-- vibe-init:workflow:end -->

## Agent skills

### Issue tracker

本地 Markdown：`.scratch/<feature>/spec.md` 和 `issues/NN-<slug>.md`。发布、读取或更新任务前，阅读 [任务约定](docs/agents/issue-tracker.md)。

### Triage labels

使用 setup 当前默认的五个标签；分诊前阅读 [标签映射](docs/agents/triage-labels.md)。

### Domain docs

单上下文：根目录 `GLOSSARY.md` 和 `docs/adr/` 按需生成。探索相关领域或命名概念、记录决策前，阅读 [领域文档规则](docs/agents/domain.md)。
