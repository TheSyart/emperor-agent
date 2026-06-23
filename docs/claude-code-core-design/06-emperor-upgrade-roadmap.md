# 06. Emperor Agent 升级路线

本路线把 Claude Code 的核心设计转化为 Emperor Agent 可逐步实施的 Epics。每个 Epic 都应独立可测、可回滚、可上线，不要求一次性重写主循环。

## 设计原则

- 不照搬 UI：不移植 React/Ink，继续使用 Vue/Electron WebUI。
- 不绑定单 provider：不把 Anthropic 专属 header、beta、thinking signature 写入核心协议。
- 不破坏现有能力：Ask/Plan、Scheduler、Team、MCP、Runtime replay 要保持兼容。
- 先加协议，再迁移行为：先让旧工具/旧 runner 通过 adapter 运行，再逐步替换内部实现。
- 后端事件为事实来源：任何长任务、工具进度、权限等待、压缩恢复都要能被 runtime event replay。

## Epic 1：Runner State Machine 拆分

目标：把 `AgentRunner.step_async()` 从单体流程拆成可测试状态机，行为保持兼容。

目标文件：

- `agent/runner.py`
- 新增 `agent/query_state/models.py`
- 新增 `agent/query_state/state_machine.py`
- 新增 `agent/query_state/transitions.py`
- 新增 `tests/test_query_state.py`

接口草案：

```python
@dataclass
class QueryState:
    history: list[dict[str, Any]]
    turn_id: str | None
    turn_count: int
    transition: str | None
    empty_retries: int = 0
    length_retries: int = 0
    paused: bool = False

@dataclass
class QueryTransition:
    reason: str
    next_state: QueryState
    emit: list[dict[str, Any]]
```

迁移顺序：

1. 抽出 transition reason 常量，不改变逻辑。
2. 抽出空响应、截断续写、todo nudge、Plan pause 的状态更新函数。
3. 为每个状态更新写单元测试。
4. `AgentRunner.step_async()` 调用这些函数，仍保留主循环。

风险：

- 暂停恢复依赖 checkpoint，拆分时容易漏写 history。
- tool_call/tool_result 配对必须保持不变。

验收：

- 现有 tests 通过。
- 新测试覆盖 empty retry、length recovery、max_turns、plan pause、todo continuation。
- WebUI 一轮普通聊天、一次工具调用、一次 Plan pause 都能恢复。

## Epic 2：Context Pipeline

目标：把请求前上下文治理从 runner 中抽出，建立分阶段预算报告。

目标文件：

- `agent/runner.py`
- 新增 `agent/context_pipeline/models.py`
- 新增 `agent/context_pipeline/pipeline.py`
- 新增 `agent/context_pipeline/tool_results.py`
- 新增 `agent/context_pipeline/pairing.py`
- 新增 `tests/test_context_pipeline.py`

接口草案：

```python
@dataclass
class ContextProjection:
    messages: list[dict[str, Any]]
    report: dict[str, Any]

class ContextPipeline:
    def project(self, history: list[dict[str, Any]]) -> ContextProjection:
        ...
```

迁移顺序：

1. 移动 `_pair_tool_calls()` 到 `pairing.py`。
2. 移动 `_cap_tool_result()` 和 `_shrink_old_tool_results()` 到 `tool_results.py`。
3. 保持默认参数完全一致。
4. 在 `AgentRunner._ask_model()` 中调用 pipeline。
5. 增加 runtime `context_projection` 事件或扩展现有 `context_usage`。
6. 增加 replacement record 持久化，确保同一工具结果在重启前后投影一致。

风险：

- 多模态 user content 不能被误截断。
- tool_calls 缺失补齐逻辑不能改变顺序。

验收：

- 同一输入 history 的模型请求消息与迁移前等价。
- 大工具结果截断、旧工具摘要、多模态保留都有测试。
- 同一 history 连续投影两次，replacement record 与模型可见消息完全一致。

## Epic 3：Tool Protocol v2

目标：为工具引入更完整协议，同时兼容现有 `Tool.execute()`。

目标文件：

- `agent/tools/base.py`
- `agent/tools/registry.py`
- 新增 `agent/tools/protocol.py`
- 新增 `agent/tools/results.py`
- 新增 `agent/tools/context.py`
- 新增 `tests/test_tool_protocol.py`

接口草案：

```python
@dataclass
class ToolResult:
    model_content: str
    display_summary: str = ""
    raw_content: str | None = None
    artifacts: list[dict[str, Any]] = field(default_factory=list)
    metadata: dict[str, Any] = field(default_factory=dict)

@dataclass
class ToolContext:
    root: Path
    turn_id: str | None
    abort_signal: Any | None
    emit: Callable[[dict[str, Any]], Awaitable[None]] | None
```

迁移顺序：

1. 定义 `ToolResult`，旧字符串结果通过 adapter 包装。
2. 增加 `Tool.is_read_only(args)`、`Tool.is_concurrency_safe(args)` 默认方法。
3. `ToolRegistry.prepare_call()` 返回结构化 `PreparedToolCall`。
4. 迁移 `ReadFileTool` 作为第一个 v2 工具。
5. 迁移 `RunCommand`，加入 progress 和 abort 基础。
6. 固化执行顺序：schema cast/validate -> tool validate_input -> observable input -> hook -> permission -> execute -> map_result。

风险：

- 旧 MCP tools 仍按字符串返回。
- 旧工具异常提示要保持模型可理解。

验收：

- 旧工具无需修改仍可运行。
- 新工具可返回 display_summary 与 model_content。
- WebUI tool_result 使用 summary，不展示超长原文。
- 无效参数不会触发权限 AskCard，而是返回可重试的工具输入错误。

## Epic 4：Streaming Tool Execution Engine

目标：建立工具执行器状态模型，为未来流式 tool_call 提前执行铺路。

目标文件：

- `agent/runner.py`
- 新增 `agent/tools/execution.py`
- 新增 `agent/tools/events.py`
- 新增 `tests/test_tool_execution_engine.py`

接口草案：

```python
@dataclass
class ToolRunState:
    id: str
    name: str
    status: Literal["queued", "executing", "completed", "failed", "cancelled"]
    concurrency_safe: bool
    result: ToolResult | None = None

class ToolExecutionEngine:
    async def run_batch(self, calls: list[ToolCallRequest]) -> list[dict[str, Any]]:
        ...
```

迁移顺序：

1. 复制当前 `_execute_tool_calls()` 行为到 engine，runner 只调用 engine。
2. 增加 queued/executing/completed runtime events。
3. 保持 tool message 输出顺序。
4. 加入 sibling cancellation，只先应用于 shell 类工具。
5. 为未来 partial tool_call 预留 `add_tool()` 队列接口。
6. 为 abort、fallback、TurnPaused 补 synthetic tool_result，保持 tool_use/tool_result 成对。

风险：

- 并发工具结果必须按 tool_calls 原顺序回填。
- TurnPaused 时必须为未执行工具生成 skipped tool message。

验收：

- 并发 read 工具、串行 write 工具、混合批次、工具异常、TurnPaused 都有测试。
- WebUI 不丢 `tool_call` / `tool_result`。
- provider fallback 后不会把旧 assistant/tool_use 的结果混入新一轮上下文。

## Epic 5：Permission Pipeline v2

目标：统一工具权限、模式、规则、AskCard、hooks/classifier 扩展点。

目标文件：

- `agent/permissions/models.py`
- `agent/permissions/policy.py`
- `agent/permissions/manager.py`
- 新增 `agent/permissions/pipeline.py`
- 新增 `agent/permissions/resolvers.py`
- `agent/control/manager.py`
- 新增 `tests/test_permission_pipeline.py`

接口草案：

```python
@dataclass
class PermissionRequest:
    tool_name: str
    arguments: dict[str, Any]
    tool_traits: dict[str, Any]
    mode: str

@dataclass
class PermissionDecision:
    behavior: Literal["allow", "deny", "ask"]
    reason: str = ""
    risk: str = "low"
    updated_arguments: dict[str, Any] | None = None
```

迁移顺序：

1. 保持现有 `PermissionDecision` 字段兼容，新增 `behavior`。
2. 将 shell dangerous regex 包装为 safety check reason。
3. 将 Plan 模式工具过滤与参数级 deny 都接入 pipeline。
4. WebUI/CLI resolver 仍复用 `ControlManager.create_ask()`。
5. Scheduler/Team/External 后续可使用 non-interactive resolver。
6. hook 或 classifier 的 allow 决策之后，仍执行 rule-only/safety 复查。

风险：

- Plan 模式硬门禁不能被 resolver 绕过。
- auto 模式不能自动批准 destructive safety check。

验收：

- ask_before_edit 下高风险命令仍触发 AskCard。
- plan 下写工具不可用，scheduler 仅 list。
- 用户允许后同参只放行一次。
- 用户拒绝后同参只拒绝一次。
- Scheduler/Team/External 在不可交互场景不会永久挂起，无法确认时明确 deny 或 paused。

## Epic 5.5：Project Execution / Plan Runtime v2

目标：把“计划”从一次性 Markdown 卡片升级为可恢复、可审计、可验证的项目执行状态。Claude Code 的真实项目编写能力来自 Plan Mode、TodoWrite、工具执行、验证反馈的闭环；Emperor 也应把这条链路做成后端事实，而不是只靠提示词提醒模型。

目标文件：

- `agent/control/manager.py`
- `agent/control/tools.py`
- `agent/plans/models.py`
- `agent/plans/store.py`
- `agent/plans/execution.py`
- `agent/plans/verification.py`
- `agent/tools/todo.py`
- `agent/runner.py`
- `agent/runtime/events.py`
- `desktop/src/renderer/src/runtime/handlers/plans.ts`

执行链路：

```text
Plan 模式只读探索
-> propose_plan(title, summary, plan_markdown, steps)
-> PlanStore 保存 waiting_approval 计划
-> 用户 approve PlanCard
-> PlanExecutionState 激活第一个 step
-> TodoStore 同步为 in_progress/pending
-> AgentRunner 执行工具和 update_todos
-> ControlManager.sync_plan_from_todos 回写 PlanStep.status/evidence
-> plan_runtime_update 写入 runtime event
-> WebUI replay 恢复计划执行状态
```

已落地：

- `propose_plan` 支持结构化 `steps`，每步包含 `files`、`commands`、`acceptance`、`risk`。
- `PlanStore` 持久保存 `PlanRecord`，corrupt index 会备份恢复。
- 用户批准 PlanCard 后，计划进入 `executing`，首个 step 激活并同步成 todos。
- `update_todos` 成功后，Runner 会调用 `ControlManager.sync_plan_from_todos()`，把 todo 状态回写到 `PlanStep`。
- 完成 step 会追加 evidence，所有 step 完成后 PlanRecord 进入 `completed`。
- active step 的 `commands` 被 `run_command` 执行时，Runner 会生成 `VerificationResult`，写入 PlanStep evidence，并发送 `plan_verification_start` / `plan_verification_done` / `plan_runtime_update`。
- 验证命令失败时，PlanStep 会进入 `failed`，Runner 会追加 `[PLAN_VERIFICATION_FAILED]` 诊断 follow-up，要求修复或必要时询问用户。
- 最终答复前，Runner 会通过 Final Answer Gate 检查最新 PlanRecord；若仍有 pending/active/failed step，会追加 `[PLAN_INCOMPLETE]` 并继续执行。
- 后端发送 `plan_runtime_update`，前端已有 reducer 可重放计划状态。
- PlanCard 已接入 `planProjection`，会展示 step 状态、文件/命令、验证 evidence 和失败原因；刷新后由 backend runtime replay 重建。
- 批准计划后的系统恢复消息和 `templates/TOOL.md` / `templates/SOUL.md` 已写入 Project Execution Prompt Contract：保持一个 active todo 对齐 active PlanStep，完成前记录 verification evidence，failed 先修复重跑，blocked 调用 ask_user，未完成前不最终答复。

后续任务点不要直接跳到通用 Task Framework。应先完成 `07-project-execution-plan-runtime.md` 中的 PE-1 至 PE-9：

- `PE-1 PlanDecisionPolicy`：已落地第一版，能判断何时必须进入计划、何时建议计划、何时直接执行，并在 required-plan 请求写入前返回 `PLAN_GUARD_REQUIRED`。
- `PE-2 PlanDraftState`：已落地第一版，把计划阶段、相关文件、未决/已答问题、候选方案、推荐方案、验证策略和评论修订快照结构化保存。
- `PE-3 只读探索扇出`：Plan 模式允许只读探索子代理，并把结果写入 plan draft。
- `PE-4 结构化计划质量门禁`：已落地第一版，拒绝泛泛 `propose_plan`，强制 step 具备范围、文件/发现依据、验证方式和高风险风险/回滚说明。
- `PE-5 批准后权限与命令白名单`：批准计划只降低计划内动作摩擦，不绕过危险操作审批。
- `PE-6 Step Evidence 强制一致性`：已落地第一版，无通过验证证据不能完成声明了 commands 的 step，失败验证会阻止完成，blocked step 必须有原因。
- `PE-7 独立验证子代理`：已落地第一版；非平凡项目改动最终答复前必须有 reviewer PASS + command evidence，或用户豁免。PlanCard 投影已接入，剩余工作是 task transcript 收敛。
- `PE-8 Plan Runtime 恢复附件`：已落地第一版，ContextPipeline 与 Compactor 会注入紧凑 plan runtime context，压缩、刷新、重启后继续 active step。
- `PE-9 WebUI Project Execution 面板`：已落地第一版；PlanCard 会优先显示 active step、失败验证摘要、blocked reason、open questions 和 independent verification 状态。剩余工作是独立面板页。

完成这条链路后，再把计划执行、任务运行、工具结果和上下文压缩接入 Epic 6 的统一长期任务框架。

## Epic 6：Task Framework

目标：统一长期运行单元的状态、进度、输出、停止、通知和 transcript。

目标文件：

- 新增 `agent/tasks/models.py`
- 新增 `agent/tasks/store.py`
- 新增 `agent/tasks/manager.py`
- `agent/runtime/active.py`
- `agent/subagents/*`
- `agent/team/manager.py`
- `agent/scheduler/service.py`
- `desktop/src/renderer/src/runtime/*`

接口草案：

```python
@dataclass
class TaskRecord:
    id: str
    type: str
    status: str
    title: str
    source: str
    turn_id: str | None
    started_at: float
    ended_at: float | None = None
    output_path: str | None = None
    metadata: dict[str, Any] = field(default_factory=dict)
```

迁移顺序：

1. 先让 active task registry 同步写 `TaskRecord`。
2. Scheduler run 创建 task，完成后更新状态。
3. Subagent dispatch 创建 task 和 transcript。
4. Team wake 创建 task，但 member/thread 仍由 TeamStore 管理。
5. WebUI 新增 task projection，不改变 Chat timeline。
6. 抽出 `run_local_agent(...)`，让 subagent、Team wake 和未来 background main session 共享上下文派生、sidechain 写入和 cleanup。

风险：

- 不要把 `.team` 长期身份迁入 task store。
- task transcript 可能很大，必须支持按 offset/page 读取。

验收：

- `/api/runtime/stop` 返回 task ids。
- WebUI 刷新后仍能看到未完成 task。
- Scheduler/Team/Subagent 完成事件都有统一 task lifecycle。
- 主 history 只保存任务通知和最终摘要，完整子代理工具流可通过 task transcript 懒加载。

## Epic 7：Runtime Replay 收敛

目标：后端 runtime event log 成为所有可见行为事实来源，localStorage 只做缓存。

目标文件：

- `agent/runtime/events.py`
- `agent/runtime/store.py`
- `agent/web/routes/*`
- `desktop/src/renderer/src/types.ts`
- `desktop/src/renderer/src/runtime/*`
- `desktop/src/renderer/src/composables/useRuntime.ts`

迁移顺序：

1. 为 tool execution engine 增加结构化事件。
2. 为 context pipeline 增加预算事件。
3. 为 task framework 增加 lifecycle 事件。
4. 前端 reducer 只消费事件，不从 WebSocket 分支里拼过多业务逻辑。
5. snapshot 仅保存最近投影，重连后以后端 replay 修正。

风险：

- 事件 schema 变动必须兼容旧 hot log。
- WebUI reducer 需要对未知事件宽容。

验收：

- 后端重启后 Chat 未压缩 turn 能恢复工具、任务、Ask/Plan 状态。
- localStorage 清空后仍可从 backend replay 重建当前活跃 timeline。

## 优先级建议

第一阶段：低风险结构化

1. Context Pipeline 抽出。
2. Tool Protocol v2 adapter。
3. ToolExecutionEngine 复刻当前行为。

第二阶段：用户可见能力增强

1. Tool progress event。
2. Permission Pipeline v2。
3. Runtime replay event schema 扩展。

第三阶段：长期任务与子代理升级

1. Task Framework。
2. Subagent sidechain transcript。
3. Team wake task 化。

第四阶段：高级上下文恢复

1. ToolResultStore、ContextPipeline replacement、AgentRunner 默认 store-backed 投影、工具级 `max_result_chars` 预算链路、首批内置工具预算、MCP defaults/tool override 预算，以及 `ToolResult` 在 registry/execution engine/runner/runtime 类型中的结构化贯通已落地：大工具结果可稳定落盘，模型可见消息只保留 preview 与 artifact path，runtime summary 使用 `display_summary`，artifact metadata 可随事件 replay 保留。`read_file`、`grep`、`run_command`、`write_file`、`edit_file` 已提供原生 summary/metadata mapping，Chat 工具卡片已展示 artifact/diff 证据。
2. Microcompact。
3. Reactive compact。
4. 主会话后台化。

## 不立即做的事

- 不重写整个 runner。
- 不移植 Ink。
- 不做 Anthropic-only request beta。
- 不引入无法解释的自动权限 classifier。
- 不让 Scheduler、Team、External 绕过 control/permission。
- 不把长期记忆更新和上下文压缩继续强绑定。
