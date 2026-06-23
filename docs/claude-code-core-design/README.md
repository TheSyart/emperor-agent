# Claude Code Core Design Analysis

本文档组记录对 Claude Code v2.1.88 反编译源码的核心设计剖析，并把可吸收的工程机制映射到 Emperor Agent 的升级路线。目标不是照搬实现，而是提炼可长期维护的 Agent 系统设计。

## 阅读顺序

1. `01-composition-root.md`
   先理解 Claude Code 如何在入口处装配配置、模型、权限、MCP、插件、技能、终端 UI 和会话恢复。
2. `02-agent-execution-state-machine.md`
   重点阅读。这里还原 `query()` 的主执行状态机，是 Claude Code Agent 行为的核心。
3. `03-tool-protocol-and-permissions.md`
   分析工具对象协议、工具执行链和权限决策管线。
4. `04-context-memory-compaction.md`
   分析上下文预算、工具结果预算、snip、microcompact、autocompact、reactive compact、context collapse。
5. `05-task-subagent-runtime.md`
   分析 Task Framework、后台任务、子代理、sidechain transcript、队友式运行时。
6. `06-emperor-upgrade-roadmap.md`
   把前面设计归纳成 Emperor Agent 的升级 Epics、目标文件、接口草案、迁移顺序、风险和验收。
7. `07-project-execution-plan-runtime.md`
   专门分析 Claude Code 的真实项目执行链路：Plan Mode、只读探索、计划批准、TodoWrite、验证证据、失败恢复和最终答复门禁，并给出 Emperor Agent 下一阶段任务点。

对应的可执行实施计划：

- 深度任务级升级计划：`docs/superpowers/plans/2026-06-23-emperor-agent-claude-code-deep-upgrade.md`
- 早期分析版计划：`docs/superpowers/plans/2026-06-23-claude-code-core-design-upgrade.md`

## 核心结论

Claude Code 的核心不是一个简单的 “LLM + tools while loop”，而是一个围绕 `query()` 构建的流式状态机。这个状态机在每次模型调用前投影上下文，在流式响应中收集并可提前执行工具，在工具结果后注入附件、通知和记忆，再决定是否进入下一轮、压缩恢复、停止 hook 或完成。

Emperor Agent 目前已经具备多 provider、工具、MCP、Ask/Plan、Scheduler、Team、runtime replay、记忆压缩等基础能力，但很多能力仍集中在 `AgentRunner`、`ToolRegistry` 和 WebUI glue 中。Claude Code 的可借鉴之处在于把这些能力明确拆成协议层、状态机层、执行器层、权限层、任务层和投影层。

最值得优先吸收的机制有六类：

- `Tool` 对象协议：工具不只是 `execute()`，还应携带 schema、验证、权限、并发安全、只读/破坏性标记、进度、结果映射和 UI 摘要元数据。
- 流式工具执行：模型流式输出 `tool_use` 时即可入队，安全工具并发，非安全工具独占，并在 fallback 或中断时生成配对的合成结果。
- 权限决策管线：工具自身检查、规则、模式、hooks、自动分类器和交互式审批应统一返回 `allow|deny|ask` 决策，而不是散落在工具实现里。
- 真实项目执行与 Plan Runtime：Plan 不只是 Markdown 预览，而应成为持久结构化对象，绑定步骤状态、涉及文件、验证命令、执行证据和恢复边界。
- 上下文预算流水线：工具结果预算、历史裁剪、轻量压缩、完整压缩、溢出恢复应成为请求前的可组合 pipeline。
- Task Framework：后台 shell、子代理、主会话后台化、远程任务和队友都可通过统一 TaskState 管理生命周期、进度、输出和通知。
- Runtime replay 收敛：前端只做投影和交互，后端事件日志成为刷新、重启、恢复的事实来源。

## Claude Code 与 Emperor Agent 架构差异地图

| 维度 | Claude Code | Emperor Agent 当前设计 | 升级方向 |
|---|---|---|---|
| 入口装配 | `src/main.tsx` 是大型 composition root，集中初始化设置、权限、模型、MCP、插件、技能、会话恢复、TUI | `agent/loop.py` 装配 memory、tools、subagents、team、scheduler、runner；Web 后端另由 `agent/web/container.py` 组合 | 保持 Python 分层，但新增显式 `RuntimeComposition` 或 `AgentKernel`，把 CLI/Web/Scheduler/Team 共享装配抽出 |
| 主执行流 | `src/query.ts` 是 async generator 状态机，输出 stream events/messages/attachments | `agent/runner.py` 是 async 方法，直接变更 history 并通过 `emit` 发事件 | 把 `step_async` 拆成 query state machine、model adapter、tool executor、post-turn pipeline |
| 工具协议 | `src/Tool.ts` 定义大型对象协议，含 schema、权限、进度、UI、结果预算 | `agent/tools/base.py` 定义 `Tool`、`read_only`、`exclusive`、`execute()` 和 JSON Schema | 推出 Tool Protocol v2，兼容旧工具，逐步增加 validate、permission、progress、result mapping |
| 工具调度 | `StreamingToolExecutor` 可边流式边执行；旧路径 `toolOrchestration.ts` 支持安全批次并发 | `AgentRunner._execute_tool_calls()` 按 tool_calls 列表分组并发 | 新增 `ToolExecutionEngine`，支持 queued/executing/completed 状态、进度事件、取消语义 |
| 权限模式 | default、plan、acceptEdits、bypassPermissions、dontAsk、auto、bubble 等，统一进入 `hasPermissionsToUseTool` | ask_before_edit、auto、plan，`PermissionPolicy` 规则较集中但较粗 | 建立 `PermissionDecisionPipeline`：tool-specific -> rules -> mode -> hooks/classifier -> interaction |
| 上下文治理 | tool result budget、snip、microcompact、context collapse、autocompact、reactive compact 多层组合 | `_cap_tool_result`、`_shrink_old_tool_results`、`Compactor.K=10` 和 token 阈值压缩 | 引入 `ContextPipeline`，让预算和压缩成为可测试、可观测的阶段 |
| 子代理与任务 | AgentTool 包装 `query()`；TaskState 统一 background task、sidechain transcript、输出文件和通知 | `dispatch_subagent` 同步回填结果；Team 有持久队友、inbox、thread、checkpoint | 新增 Task Framework，把 subagent/team/scheduler/background shell 统一纳入 TaskState |
| 项目执行 / Plan Runtime | Plan Mode 切权限，只读探索，计划文件持久化，ExitPlanMode 审批，TodoWrite 推进，验证失败继续 | 已有 `PlanStore`、`PlanStep`、`plan_runtime_update`、验证 evidence、Final Answer Gate、`PlanDecisionPolicy` 写工具前置 guard | 继续补 `PlanDraftState`、Plan Runtime 恢复附件、Evidence Gate 和独立验证子代理 |
| UI/runtime | 自研 Ink TUI + AppState store + task panel；消息即 UI 数据 | Vue WebUI + WebSocket runtime event store + localStorage fallback | 不移植 Ink；吸收 AppState selector、event-sourced runtime、task panel 的状态建模 |

## 源码范围

Claude Code 源码根目录：

- `/Users/anhuike/Documents/workspace/claude-code-source-code/src`

本项目对照源码：

- `agent/runner.py`
- `agent/loop.py`
- `agent/tools/*`
- `agent/control/*`
- `agent/permissions/*`
- `agent/runtime/*`
- `agent/subagents/*`
- `agent/team/*`
- `agent/scheduler/*`
- `desktop/src/renderer/src/runtime/*`
- `desktop/src/renderer/src/composables/useRuntime.ts`

## 不直接移植的内容

- React/Ink 终端渲染栈：Emperor Agent 已经是 Vue/Electron WebUI，不应重写为 TUI。
- Anthropic 专属 beta/header/request 细节：本项目多 provider，不能把单 provider 协议放进核心状态机。
- Ant 内部 feature gate、遥测、增长实验逻辑：只能借鉴分层，不移植策略本身。
- 反编译源码中的历史兼容分支：只吸收稳定抽象，避免把产品遗留复杂度带入新系统。
