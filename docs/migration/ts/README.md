# Emperor Agent · Python → TypeScript 迁移任务目录

> 这是一个**可执行的迁移 backlog**。把当前 Python 后端（`agent/`，~21 子系统、~25k LoC、487 测试）整体迁移到 TypeScript，终态为**一个纯 TS 桌面 agent**。
> 用法：按依赖波次（W00→W17）逐个领 task，照 task 内的「设计 / 验证」开工，完成后在 [STATUS.md](STATUS.md) 勾选。

## 1. 终态架构（北极星）

- **纯 TS 桌面 agent**：只有 Electron 桌面应用一个壳。**无终端 TUI、无 Python、无本地 HTTP/WS server。**
- **进程内核心**：TS 核心（`packages/core`）跑在 Electron **主进程**内；渲染层（Vue，保留）通过 **Electron IPC** 调用核心，不再走 WebSocket/HTTP。
- **monorepo（pnpm workspaces）**：
  - `packages/core` —— 迁移后的 TS 核心库（agent runtime、providers、tools、control、memory、scheduler、team、mcp…）。
  - `apps/desktop` —— 现 `desktop/` Electron，改为进程内托管 `core` + 暴露 IPC + 现有 Vue 渲染层。
- **安全面简化**：没有 server 就没有跨站/DNS-rebinding 面，原 `web/origin_guard`、`web/auth_guard` 随之退役；IPC 只在本机主/渲染进程间，天然受 Electron 进程隔离保护。

## 2. 工具链决策（默认值，可在对应 task 内调整）

| 关注点 | 选型 |
|---|---|
| 语言/构建 | TypeScript（strict）、pnpm workspaces、tsup/vite 构建、electron-vite（沿用现有桌面构建） |
| 测试 | vitest（移植 Python 的 487 测试为对账契约） |
| LLM SDK | 官方 `@anthropic-ai/sdk`、`openai`、`@aws-sdk/client-bedrock-runtime` |
| MCP | 官方 `@modelcontextprotocol/sdk`（TS 一等公民，stdio/SSE 内置） |
| 定时 | `croner`（cron/interval）+ 原生 timer |
| 文件锁/原子写 | `proper-lockfile` + `fs.rename` 原子替换（对齐现有 `tmp.replace` 语义） |
| PDF/文本抽取 | `pdf-parse`/`unpdf` 类（**在 W13 task 内评测口径，记风险**） |
| token 估算 | `@anthropic-ai/tokenizer` / `tiktoken`（**在 W06 task 内核对口径，记风险**） |

## 3. 对账原则（不可协商）

1. **行为契约 = 487 个 Python 测试**：每个 task 的「验证」必须指明要移植成 vitest 的对应 Python 测试，逐条对账。
2. **磁盘格式字节兼容**：`memory/`（history.jsonl、checkpoint、sessions、runtime events、versions）、`model_config.json`、`mcp_config.json`、`emperor.local.json`、`.team/`、scheduler/external/tasks store 的 JSON schema **保持不变**，老用户数据零迁移即可被 TS 版读取。任何格式变化必须在 task 内显式标注并提供读旧逻辑。
3. **只换语言与拓扑，不改对外行为**：工具集、权限语义、Ask/Plan 状态机、压缩策略、事件协议等**逐字保真**；改进另开任务，不混在迁移里。

## 4. 波次路线图（依赖序）

| 波次 | 文件 | 范围 | 依赖 |
|---|---|---|---|
| W00 基础 | [waves/W00-foundation.md](waves/W00-foundation.md) | 原子存储/锁/腐坏隔离、事件总线、id/time、monorepo 骨架 | — |
| W01 配置/模型路由 | [waves/W01-config-model.md](waves/W01-config-model.md) | local_config、model_config、model_router | W00 |
| W02 Providers | [waves/W02-providers.md](waves/W02-providers.md) | base/openai/anthropic/bedrock/factory/registry | W01 |
| W03 Agent 核心 | [waves/W03-agent-core.md](waves/W03-agent-core.md) | loop、runner、context_pipeline、query_state、model caller | W02,W04 |
| W04 工具 | [waves/W04-tools.md](waves/W04-tools.md) | tools/* + resolvers | W00 |
| W05 控制/计划/权限 | [waves/W05-control-permissions.md](waves/W05-control-permissions.md) | control/*、plans/*、permissions/* | W03 |
| W06 记忆/压缩 | [waves/W06-memory.md](waves/W06-memory.md) | memory、memory_versions、compactor、token | W03 |
| W07 会话 | [waves/W07-sessions.md](waves/W07-sessions.md) | sessions/* | W06 |
| W08 子代理 | [waves/W08-subagents.md](waves/W08-subagents.md) | subagents/* + dispatch runner | W05,W03 |
| W09 调度器 | [waves/W09-scheduler.md](waves/W09-scheduler.md) | scheduler/* | W14,W07 |
| W10 Team | [waves/W10-team.md](waves/W10-team.md) | team/* | W03,W05 |
| W11 MCP | [waves/W11-mcp.md](waves/W11-mcp.md) | mcp/* | W04 |
| W12 外部桥/Watchlist | [waves/W12-external-watchlist.md](waves/W12-external-watchlist.md) | external/*、watchlist/* | W14,W09 |
| W13 附件/多模态 | [waves/W13-attachments.md](waves/W13-attachments.md) | attachments | W03 |
| W14 运行时事件/任务/项目 | [waves/W14-runtime-tasks-projects.md](waves/W14-runtime-tasks-projects.md) | runtime/*、tasks/*、projects/* | W00 |
| W15 传输与前端接线 | [waves/W15-transport-ipc.md](waves/W15-transport-ipc.md) | web/* → 进程内 API + IPC；渲染层改 IPC | 全部核心波次 |
| W16 入 GUI | [waves/W16-app-onboarding.md](waves/W16-app-onboarding.md) | onboarding、doctor/诊断、desktop_pet（终端入口退役） | W15,W03 |
| W17 打包/发布/对账 | [waves/W17-packaging-release.md](waves/W17-packaging-release.md) | electron-builder、CI、数据兼容、parity 签收、退役 Python | 全部 |

> 子系统全覆盖核对见迁移计划（21/21）。每个波次文件顶部复述本波依赖与子系统映射。

## 5. Task ID 规则与状态

- ID：`MIG-<AREA>-NNN`。AREA：`FND CFG PROV CORE TOOL CTRL MEM SESS SUB SCHED TEAM MCP EXT ATT RTE IPC APP REL`。
- 状态图例：`todo`（未开工）· `wip`（进行中）· `done`（已对账通过）· `blocked`（被依赖卡住）。
- 每个 task 模式见 [TASK_TEMPLATE.md](TASK_TEMPLATE.md)；主追踪表见 [STATUS.md](STATUS.md)。

## 6. 怎么用这个目录

1. 从 [STATUS.md](STATUS.md) 选一个依赖已满足的 `todo` task。
2. 打开它所在的波次文件，按「设计」实现到 `packages/core`（或 `apps/desktop`）。
3. 按「验证」移植对应 Python 测试为 vitest，跑绿；满足「验收标准」。
4. 在 STATUS.md 把状态改 `done`，回填 PR 链接。
5. 一个波次内全部 `done` 后，解锁下游波次。
