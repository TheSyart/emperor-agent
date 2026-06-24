# 07. 任务执行流程与可视化运行时

本分册聚焦一个更具体的问题：Claude Code 为什么在执行真实项目时显得“有步骤、有进度、有持续推进能力”，以及 Emperor Agent 如何吸收这套机制来提升复杂代码任务处理能力和 WebUI 观感。

前面分册已经覆盖入口装配、`query()` 状态机、工具协议、上下文压缩和 Task Runtime。本分册只讨论“执行中输出流程信息”的设计：计划步骤如何进入状态机，工具如何从排队到完成，长输出如何治理，子代理过程如何被父级看见，UI 如何把这些事件渲染成可理解的执行轨迹。

## 核心结论

Claude Code 的优势不是某一个工具特别强，而是形成了一个闭环：

1. 模型先把多步骤任务写入结构化计划或 task list。
2. 每一步在执行前后都更新状态，而不是只靠自然语言记忆。
3. `query()` 把模型流、工具调用、工具结果、进度消息、任务通知放进同一条可恢复循环。
4. 工具执行器维护 `queued -> executing -> completed -> yielded` 状态，UI 可以在工具还没结束时显示正在发生什么。
5. Bash 和长任务输出不直接塞满上下文，而是拆成模型可见摘要、UI 进度片段和完整 output file。
6. 子代理拥有 sidechain transcript，主线只收摘要和通知，避免污染主 history。
7. UI 渲染的是结构化投影，不是裸日志，所以用户能看懂“正在做第几步、哪个工具在跑、谁在处理、哪里失败”。

Emperor Agent 当前已经具备一部分基础：

- `agent/runner.py` 有模型和工具 follow-up 循环。
- `agent/tools/execution.py` 已有 `ToolExecutionEngine` 和 `tool_run_*` 事件。
- `agent/tools/todo.py` 已有 `update_todos`。
- `agent/runtime/events.py` 已有 `tool_run_*`、`task_*`、`subagent_*`、`team_*` 事件。
- `agent/tasks/*` 已有 `TaskRecord`、`TaskStore`、`TaskManager`、sidechain transcript。
- `desktop/src/renderer/src/components/chat/AssistantFlow.vue` 和 `ToolEvent.vue` 已有 Chat 时间线展示。

缺口在于：这些能力还没有被统一成“执行叙事层”。计划步骤、工具状态、长输出、子代理轨迹、验证闭环仍然分散，UI 看到的是工具卡片和子代理片段，还不是一个完整的“项目任务执行流程”。

## Claude Code 源码流程还原

### 1. `query()` 把执行过程变成可消费事件流

核心文件：

- `src/query.ts`
- `src/QueryEngine.ts`

Claude Code 的 `query()` 不是普通函数，而是 async generator。它持续产出 assistant message、tool result、progress、attachment、task notification、tool use summary 等消息，直到返回 terminal reason。

关键设计点：

- 每一轮模型请求前，先投影上下文和工具结果预算。
- 模型流式输出 assistant 内容时，UI 立即获得 delta。
- 一旦收集到 `tool_use` block，状态机就进入工具执行路径。
- 工具执行结束后，结果和额外 attachment 会追加进下一轮模型上下文。
- 如果工具仍在运行、任务进入后台、发生压缩或停止 hook，状态机会用显式 transition 决定继续、恢复或停止。

Emperor 对照：

- 当前 `AgentRunner.step_async()` 已经能循环处理模型响应和工具调用。
- `step_stream()` 会通过 `emit` 推送 WebSocket 事件。
- 但当前事件还是偏“工具调用完成通知”，缺少 `query()` 那种把进度、附件、任务通知统一喂回主循环的后置注入层。

升级要点：

- 保留现有 `step_async()` 行为，增加 `ExecutionRun` 作为 turn 级执行叙事。
- 在模型请求、工具批次、计划更新、子代理启动、验证完成等节点发结构化 runtime event。
- 后续实现 `PostToolContextInjector`，把任务通知、后台完成摘要、长输出引用统一转成下一轮模型可见上下文。

### 2. `StreamingToolExecutor` 管理工具生命周期

核心文件：

- `src/services/tools/StreamingToolExecutor.ts`
- `src/services/tools/toolOrchestration.ts`
- `src/services/tools/toolExecution.ts`

Claude Code 工具执行器的状态不是隐含在 promise 里，而是显式保存：

- `queued`：工具已被模型请求，但还不能执行。
- `executing`：工具正在运行。
- `completed`：工具已经产生结果，但还没按顺序 yield 给主循环。
- `yielded`：结果已经交还给 `query()`。

它还维护几个关键规则：

- 并发安全工具可以和其他并发安全工具一起运行。
- 非并发安全工具独占执行，并阻塞后续工具。
- 进度消息单独进入 `pendingProgress`，可以先于最终结果 yield。
- Bash 工具失败可以取消 sibling 工具，避免无意义并发继续跑。
- fallback、用户中断、sibling error 都会生成 synthetic tool result，保证 tool use/result 成对。

Emperor 对照：

- `agent/tools/execution.py` 已经有 `ToolRunState` 和 `run_batch()`。
- 现有状态为 `queued / executing / completed / failed / cancelled`。
- 当前主要发 `tool_run_queued`、`tool_run_started`、`tool_run_completed`、`tool_run_failed`。
- 还缺少一等 progress、长输出 delta、synthetic result 策略和“结果可按序回填但进度可提前展示”的协议。

升级要点：

- 在 `ToolExecutionEngine` 增加 `tool_run_progress`。
- 给 `ToolRunState` 增加 `started_at`、`ended_at`、`duration_ms`、`output_ref`、`activity_id`。
- 工具最终结果仍按原 tool_call 顺序回填 provider history。
- UI progress 不要求按工具结果顺序，可以实时展示。

### 3. `TaskOutput` 把长输出拆成三层

核心文件：

- `src/utils/task/TaskOutput.ts`
- `src/utils/task/diskOutput.ts`
- `src/tools/BashTool/BashTool.tsx`
- `src/tools/BashTool/UI.tsx`

Claude Code 的 Bash 输出不是简单 `capture_output`：

- 前台可见进度：定时读取 output file tail，提取最近几行、总行数、总字节数。
- 模型可见结果：工具完成后读取有限长度输出，超过预算就截断并提示完整路径。
- 完整输出：写入 task output file，供用户或后续工具读取。

这样做解决两个问题：

- 长命令执行时 UI 不会“静默卡住”。
- 大输出不会把模型上下文塞爆。

Emperor 对照：

- 当前 `agent/tools/shell.py` 的 `RunCommand.execute()` 使用 `subprocess.run(capture_output=True)`。
- 只有命令结束后才有结果。
- 输出超过 `_MAX_OUTPUT_CHARS` 时只做字符串截断，没有 output file。
- UI 无法显示命令运行期间 tail、行数、字节数或持续时间。

升级要点：

- 为 shell 工具增加 async v2 路径。
- stdout/stderr 合并写入 `memory/tasks/outputs/{turn_id}/{tool_call_id}.log`。
- 定时发送 `tool_output_delta` 或 `tool_run_progress`。
- `ToolResult.model_content` 只保留预算内摘要。
- `ToolResult.artifacts` 或 `ExecutionOutputRef` 指向完整输出文件。

### 4. Task v2 让计划步骤可显示、可分配、可阻塞

核心文件：

- `src/utils/tasks.ts`
- `src/tools/TaskCreateTool/TaskCreateTool.ts`
- `src/tools/TaskUpdateTool/TaskUpdateTool.ts`
- `src/tools/TaskListTool/TaskListTool.ts`
- `src/components/TaskListV2.tsx`
- `src/tools/TodoWriteTool/TodoWriteTool.ts`

Claude Code 保留了旧 `TodoWriteTool`，但交互场景中更偏向 Task v2。Task v2 比普通 todo 多几个关键字段：

- `subject`：短标题，用于列表扫描。
- `description`：完整要做什么。
- `activeForm`：当前进行时文案，例如 “Running tests”。
- `owner`：由哪个 agent 或 teammate 负责。
- `blocks` / `blockedBy`：任务依赖关系。
- `metadata`：扩展数据。

TaskList UI 会优先显示最近完成、正在执行、未阻塞的 pending，并折叠多余项。这个策略使用户看到的是“当前最重要的执行状态”，而不是完整流水账。

Emperor 对照：

- `UpdateTodosTool` 只有 `id`、`content`、`status`。
- 状态只有 `pending / in_progress / completed`。
- Runner 会在最终回复前检查未完成 todo，注入 nudge 继续执行。
- 这已经能防止模型过早结束，但不足以表达“被谁阻塞、正在做什么、哪个工具证明了完成、是否失败”。

升级要点：

- 保持 `update_todos` 兼容。
- 增加 Task Step v2 字段：`title`、`active_form`、`owner`、`blocked_by`、`evidence`、`related_tool_call_ids`、`status=blocked|failed`。
- 每次 `update_todos` 同步生成 `execution_step_updated` runtime event。
- Runner 的“未完成继续执行”逻辑改为读取 step 状态，而不是只读旧 todo。

### 5. AgentTool 把子代理过程挂到父工具下

核心文件：

- `src/tools/AgentTool/AgentTool.tsx`
- `src/tools/AgentTool/runAgent.ts`
- `src/tools/AgentTool/agentToolUtils.ts`
- `src/tasks/LocalAgentTask/*`
- `src/utils/sessionStorage.ts`

Claude Code 子代理不是简单函数调用。它会：

1. 解析 agent 定义、模型、权限模式和可用工具。
2. 派生独立 tool context、read file state、abort controller。
3. 可选初始化 agent-specific MCP servers。
4. 写 sidechain transcript 和 metadata。
5. 调用同一个 `query()` 状态机。
6. 把 progress、tool use、token count、last activity 回传给父级。
7. 同步子代理结束时直接返回摘要。
8. 异步子代理注册后台 task，完成后通过 notification 回到主线。
9. finally 中清理 MCP、hooks、file cache、agent todos、background shell tasks。

Emperor 对照：

- `DispatchSubagentTool` 已有独立 runner 和 `subagent_*` WebSocket 事件。
- `TaskManager` 已能创建 subagent task 和 sidechain transcript。
- 当前 sidechain 主要记录初始 prompt 和最终 assistant，总体轨迹仍偏粗。
- `SubagentTrail.vue` 能在父工具卡片中展示子代理和其工具，但缺少统一 activity/progress 投影。

升级要点：

- `dispatch_subagent` 每次执行都映射到 `ExecutionActivity(type="subagent")`。
- 子代理内部 `message_delta`、`tool_call`、`tool_result`、`assistant_done` 同步写 sidechain。
- 父工具卡片显示：agent type、purpose、last tool、tool count、duration、summary。
- 后台化能力后续再做，v1 先把同步子代理轨迹做完整。

### 6. UI 渲染结构化投影，而不是裸日志

核心文件：

- `src/components/messages/AssistantToolUseMessage.tsx`
- `src/components/messages/GroupedToolUseContent.tsx`
- `src/components/UserToolResultMessage/*`
- `src/components/TaskListV2.tsx`
- `src/components/ToolUseLoader.tsx`
- `src/components/AgentProgressLine.tsx`

Claude Code UI 的关键不是样式，而是数据投影：

- tool use message 通过 tool 协议渲染 user-facing name、短描述、tag。
- unresolved 工具显示 loader。
- waiting permission 显示权限等待。
- progress message 由工具自定义渲染。
- grouped tool use 合并读/搜类工具，减少噪声。
- task list 根据终端空间裁剪，保留最相关项。
- agent progress line 显示 agent 当前活动、工具数、token 数、是否后台运行。

Emperor 对照：

- `AssistantFlow.vue` 已经把 assistant 输出拆成 thought/text/tool/ask/plan segment。
- `ToolEvent.vue` 已能显示工具输入、输出、todos、subagents。
- `useRuntime.ts` 已能消费 `tool_call`、`tool_result`、`subagent_*`、`task_*`。
- 目前缺少“一个 turn 的整体执行计划条”和“侧栏完整执行面板”。

升级要点：

- Chat 内新增紧凑 `ExecutionPlanStrip`：显示步骤总数、当前步骤、完成/失败/阻塞数。
- 侧栏新增 `ExecutionFlowPanel`：显示完整 run、steps、activities、tool output tail、subagent transcript link。
- `ToolEvent.vue` 增强 progress 显示，不只展示最终 summary。
- runtime projection 成为 UI 唯一事实来源，刷新后从后端事件重放。

## 执行真实项目的关键机制

### 先计划，再执行

Claude Code 对复杂任务的处理不是直接进入文件编辑，而是要求模型维护 task/todo。这样做的价值是：

- 用户能看到 agent 对目标的拆解。
- Runner 可以发现未完成任务并继续推进。
- 后续验证可以作为独立步骤，而不是最终回复中的一句话。
- 子代理和 Team 可以认领明确步骤。

Emperor 升级后，复杂工程任务的标准流程应是：

1. 只读探索现状。
2. 生成执行步骤。
3. 标记第一步 `in_progress`。
4. 执行相关工具。
5. 记录证据并标记完成。
6. 进入下一步。
7. 验证步骤完成后才最终回复。

### 每一步有状态，不靠自然语言记忆

旧 todo 的三态不够表达真实工程任务。建议升级为：

- `pending`：还未开始。
- `in_progress`：正在执行。
- `completed`：完成且有证据。
- `blocked`：外部条件或用户决策阻塞。
- `failed`：尝试后失败，需要修复或降级。
- `cancelled`：用户停止或计划取消。

每个步骤至少包含：

- `id`
- `title`
- `description`
- `active_form`
- `status`
- `owner`
- `blocked_by`
- `evidence`
- `related_tool_call_ids`
- `started_at`
- `updated_at`
- `completed_at`

### 工具结果必须成对、可恢复、可回放

Claude Code 很重视 tool use/result 配对，因为模型 API 对工具消息顺序敏感。Emperor 已有 `_pair_tool_calls()` 和 `ContextPipeline`，后续要把这个不变量下沉到执行器：

- 工具被跳过时生成 synthetic result。
- 工具被取消时生成 cancelled result。
- Plan/Ask 暂停时未执行工具生成 skipped result。
- provider fallback 时旧工具结果不能混入新响应。
- runtime event 和 history 都能解释这次工具调用的终态。

### 长输出不污染上下文

真实项目中 `npm test`、`pytest`、`git diff`、构建日志都可能很长。升级后应严格分层：

- 模型可见：截断摘要、关键错误、完整路径。
- UI 可见：实时 tail、行数、字节数、持续时间。
- 文件可见：完整 output file。

这样模型能继续决策，用户也能看到执行不是卡住。

### 子代理主线只收摘要，细节进入 sidechain

子代理适合处理跨文件搜索、独立验证、并行调研。主线不应吸收它全部工具 chatter。建议约束：

- 主 history 只保存子代理最终摘要和必要证据。
- sidechain 保存完整子代理消息和工具结果。
- UI 默认显示简短轨迹，可展开查看 transcript。
- 子代理失败必须有错误状态和 partial summary。

### UI 展示结构化投影

不要把所有 runtime event 直接铺到 Chat。建议两层展示：

- Chat 内紧凑流程：当前步骤、关键工具、子代理摘要、最终验证。
- 侧栏完整执行面板：全步骤、所有 activity、输出 tail、transcript link。

这能同时满足“观感好”和“可审计”。

## Emperor 当前对照

| 能力 | 当前文件 | 当前状态 | 缺口 |
|---|---|---|---|
| 主执行循环 | `agent/runner.py` | 可循环模型和工具，支持 checkpoint、Ask/Plan、todo nudge | 缺 turn 级执行叙事对象 |
| 工具执行器 | `agent/tools/execution.py` | 有 queued/started/completed/failed 事件 | 缺 progress、output ref、duration、synthetic result 完整策略 |
| Todo | `agent/tools/todo.py` | 三态全量覆盖，约束单一 in_progress | 缺 owner、active_form、blocked/failed、证据绑定 |
| Runtime events | `agent/runtime/events.py` | 有 tool/task/subagent/team/scheduler/control 事件 | 缺 execution_run、execution_step、execution_activity |
| Task store | `agent/tasks/*` | 有 TaskRecord、TaskStore、TaskManager、sidechain | 还未统一映射可见 turn、工具 output 和执行计划 |
| Subagent | `agent/tools/dispatch.py` | 独立 runner，桥接 `subagent_*` 事件 | sidechain 中间轨迹不够完整，缺 activity 统一投影 |
| Chat runtime | `desktop/src/renderer/src/composables/useRuntime.ts` | 处理 message/tool/control/subagent/team/task 事件 | 缺执行流 projection |
| Chat UI | `AssistantFlow.vue`、`ToolEvent.vue` | 已有时间线、工具卡、todo fallback、subagent trail | 缺计划步骤总览和运行中 progress |
| Task projection | `desktop/src/renderer/src/runtime/handlers/tasks.ts` | 只维护 tasks 列表 | 缺与 Chat turn 和 tool_call 的层级关系 |

## Emperor 升级目标设计

### ExecutionRun

`ExecutionRun` 是一个用户 turn 或后台 run 的顶层执行叙事。

建议字段：

```python
@dataclass
class ExecutionRun:
    id: str
    turn_id: str | None
    session_id: str | None
    source: str
    status: str
    title: str
    started_at: float
    ended_at: float | None = None
    summary: str = ""
    current_step_id: str | None = None
    metadata: dict[str, Any] = field(default_factory=dict)
```

状态建议：

- `running`
- `paused`
- `completed`
- `failed`
- `cancelled`

### ExecutionStep

`ExecutionStep` 是模型计划中的一项任务步骤。

建议字段：

```python
@dataclass
class ExecutionStep:
    id: str
    run_id: str
    title: str
    description: str
    active_form: str
    status: str
    owner: str | None = None
    blocked_by: list[str] = field(default_factory=list)
    evidence: list[str] = field(default_factory=list)
    related_tool_call_ids: list[str] = field(default_factory=list)
    started_at: float | None = None
    updated_at: float | None = None
    completed_at: float | None = None
```

### ExecutionActivity

`ExecutionActivity` 表示工具、子代理、Team wake、模型请求、验证等可视化活动。

建议字段：

```python
@dataclass
class ExecutionActivity:
    id: str
    run_id: str
    step_id: str | None
    kind: str
    status: str
    title: str
    detail: str = ""
    tool_call_id: str | None = None
    task_id: str | None = None
    parent_activity_id: str | None = None
    output_ref: dict[str, Any] | None = None
    started_at: float | None = None
    ended_at: float | None = None
    metadata: dict[str, Any] = field(default_factory=dict)
```

`kind` 建议：

- `model_call`
- `tool`
- `shell`
- `subagent`
- `team`
- `scheduler`
- `verification`
- `control`

### ExecutionOutputRef

`ExecutionOutputRef` 用于长输出治理。

建议字段：

```python
@dataclass
class ExecutionOutputRef:
    path: str
    kind: str
    bytes: int
    lines: int
    offset: int = 0
    preview: str = ""
    truncated: bool = False
```

### Runtime event 协议

建议新增事件：

```text
execution_run_started
execution_run_updated
execution_run_completed
execution_step_updated
execution_activity_started
execution_activity_progress
execution_activity_completed
execution_activity_failed
tool_run_progress
tool_output_delta
```

事件原则：

- 每个事件都带 `turn_id` 和 `run_id`。
- 工具类事件带 `tool_call_id`。
- 子代理类事件带 `task_id` 或 `subagent_id`。
- 输出类事件只带 delta 和 output ref，不带完整大输出。
- 终态事件必须可独立重放，不依赖 localStorage。

### 前端 projection 协议

前端新增 `ExecutionFlowProjection`：

```ts
interface ExecutionFlowProjection {
  runs: ExecutionRunView[]
  activeRunId?: string
}

interface ExecutionRunView {
  id: string
  turnId?: string
  status: string
  title: string
  steps: ExecutionStepView[]
  activities: ExecutionActivityView[]
  currentStepId?: string
}
```

UI 分层：

- `ExecutionPlanStrip.vue`：Chat 内紧凑步骤条。
- `ExecutionActivityItem.vue`：工具/子代理/验证活动行。
- `ExecutionFlowPanel.vue`：侧栏完整执行面板。
- `ToolEvent.vue`：增加 running progress 和 output tail。
- `SubagentTrail.vue`：增加 task id、last activity、transcript path。

## 详细任务清单

### Epic 1：Execution Flow 文档与事件协议设计

目标：先把执行叙事层设计固化为项目文档，不直接写代码。

目标文件：

- `docs/claude-code-core-design/07-task-execution-flow-visual-runtime.md`
- `docs/superpowers/plans/2026-06-24-claude-code-task-flow-visual-upgrade.md`
- `docs/claude-code-core-design/README.md`
- `docs/claude-code-core-design/06-emperor-upgrade-roadmap.md`

迁移顺序：

1. 写清 Claude Code 源码机制。
2. 写清 Emperor 当前对照。
3. 定义 `ExecutionRun / ExecutionStep / ExecutionActivity / ExecutionOutputRef`。
4. 定义 runtime event 与前端 projection。
5. 把后续 Epics 拆成可验收任务。

验收：

- 文档无占位内容。
- 每个 Epic 都有目标文件、迁移顺序、风险和验收。

### Epic 2：Plan/Todo 升级为 Task Step v2

目标：把当前 `update_todos` 从三态列表升级成执行步骤模型，同时保持兼容。

目标文件：

- `agent/tools/todo.py`
- `agent/runner.py`
- 新增 `agent/execution_flow/models.py`
- 新增 `agent/execution_flow/manager.py`
- `agent/runtime/events.py`
- `desktop/src/renderer/src/types.ts`
- `desktop/src/renderer/src/runtime/handlers/executionFlow.ts`

接口草案：

```python
class StepStatus(StrEnum):
    PENDING = "pending"
    IN_PROGRESS = "in_progress"
    COMPLETED = "completed"
    BLOCKED = "blocked"
    FAILED = "failed"
    CANCELLED = "cancelled"
```

迁移顺序：

1. 先新增 `ExecutionStep`，不改旧 todo 行为。
2. `TodoStore.update()` 接受旧字段和新字段。
3. 每次更新 todo 时发 `execution_step_updated`。
4. Runner 未完成 nudge 改为优先读 step v2，旧 todo fallback。
5. 前端 Chat 内显示步骤条。

风险：

- 旧模型只会传旧 schema，不能破坏。
- 同一时间只允许一个 `in_progress` 的约束仍要保留。
- `blocked` 不能导致 Runner 无限继续 nudge。

验收：

- 旧 `update_todos` 调用仍通过。
- 新字段能进入 runtime event。
- 完成所有步骤后 Runner 不再继续 nudge。
- 有 blocked 步骤时最终回复必须说明阻塞和所需输入。

### Epic 3：Tool Progress 与长输出协议

目标：让工具运行过程可见，并把长输出拆成摘要、进度和完整文件。

目标文件：

- `agent/tools/context.py`
- `agent/tools/results.py`
- `agent/tools/execution.py`
- `agent/tools/shell.py`
- `agent/runtime/events.py`
- 新增 `agent/tasks/output.py`
- `desktop/src/renderer/src/components/chat/ToolEvent.vue`

接口草案：

```python
@dataclass
class ToolProgress:
    tool_call_id: str
    message: str
    last_lines: str = ""
    total_lines: int = 0
    total_bytes: int = 0
    output_path: str | None = None
```

迁移顺序：

1. `ToolExecutionContext` 增加 progress emitter。
2. `ToolExecutionEngine` 支持 tool 调用期间发 progress。
3. `RunCommand` 增加 async v2 路径和 output file。
4. Shell 每秒或每批输出发一次 progress。
5. 最终结果返回截断摘要和 output ref。
6. `ToolEvent.vue` 展示运行中 tail、耗时、输出路径。

风险：

- 子线程执行旧工具时不能直接 await emit。
- shell 进程取消要清理子进程。
- 大输出文件必须落在 ignored `memory/`。

验收：

- 长命令运行中 UI 有 progress。
- 模型 history 不包含完整长日志。
- 失败命令显示 exit code 和关键 tail。
- `git diff --check` 与 shell 工具单测通过。

### Epic 4：Subagent / Team 执行轨迹统一

目标：把子代理和队友运行纳入同一执行叙事，主线只看摘要，细节可展开。

目标文件：

- `agent/tools/dispatch.py`
- `agent/tasks/manager.py`
- `agent/tasks/sidechain.py`
- `agent/team/manager.py`
- `agent/runtime/events.py`
- `desktop/src/renderer/src/components/chat/SubagentTrail.vue`
- `desktop/src/renderer/src/runtime/handlers/executionFlow.ts`

迁移顺序：

1. `dispatch_subagent` 创建 `ExecutionActivity(kind="subagent")`。
2. 子代理 `subagent_*` 事件同步写 sidechain。
3. 子代理 tool events 绑定到父 activity。
4. Team wake 建立 `ExecutionActivity(kind="team")`，不替代 `.team` store。
5. 前端把 subagent/team activity 统一投影。

风险：

- Team 长期身份仍属于 `.team`，不能迁入 execution flow。
- sidechain 可能很长，bootstrap 只返回摘要。

验收：

- 子代理运行时父工具卡片能显示 last tool、duration、summary。
- sidechain 可分页读取。
- Team wake 与 subagent 在 UI 上一致但身份来源可区分。

### Epic 5：WebUI 执行流可视化

目标：让用户在 Chat 中看到紧凑流程，在侧栏看到完整流程。

目标文件：

- `desktop/src/renderer/src/types.ts`
- `desktop/src/renderer/src/composables/useRuntime.ts`
- 新增 `desktop/src/renderer/src/runtime/handlers/executionFlow.ts`
- 新增 `desktop/src/renderer/src/runtime/executionFlowProjection.test.ts`
- 新增 `desktop/src/renderer/src/components/chat/ExecutionPlanStrip.vue`
- 新增 `desktop/src/renderer/src/components/panels/ExecutionFlowPanel.vue`
- 修改 `desktop/src/renderer/src/components/chat/AssistantFlow.vue`
- 修改 `desktop/src/renderer/src/components/chat/ToolEvent.vue`

迁移顺序：

1. 定义 TypeScript event 和 projection 类型。
2. 实现 reducer，支持 replay。
3. Chat 内插入 `ExecutionPlanStrip`。
4. `ToolEvent` 显示 running progress。
5. 新增侧栏 panel，读取 active run。
6. 断线重连后从 runtime events 恢复。

风险：

- Chat 时间线不能被新面板状态拖慢。
- 不要把长 output delta 全部塞进 Vue reactive 大对象。
- 移动端和窄窗口不能挤爆 Chat。

验收：

- Vitest 覆盖 event replay。
- 刷新页面后执行流状态恢复。
- 长输出只显示 tail，不造成明显卡顿。

### Epic 6：Prompt 行为约束与验收闭环

目标：让模型在真实代码任务中稳定使用计划步骤、进度更新和验证步骤。

目标文件：

- `templates/agent/identity.md`
- `templates/TOOL.md`
- `agent/control/manager.py`
- `agent/tools/todo.py`
- 相关测试文件

迁移顺序：

1. 更新系统契约：复杂任务必须先建步骤。
2. 开始某步前标记 `in_progress`。
3. 完成某步必须写 evidence 或绑定 tool_call。
4. 工程任务默认最后有验证步骤。
5. 失败时标记 `failed` 或 `blocked`，不能假装完成。
6. PlanCard 批准后第一轮执行要把计划转成步骤。

风险：

- Prompt 过强会让简单问答也过度计划。
- 验证步骤不能强迫所有任务都跑全量 `make check`。

验收：

- 简单问答不生成步骤。
- 多文件工程任务会生成步骤。
- 最终回复前步骤全部 terminal。
- 验证失败时不会总结为完成。

## 第一阶段落地边界

第一阶段只应完成设计文档和可执行计划，不改运行时代码。

不立即实现：

- provider partial tool_call 流式提前执行。
- 主会话后台化。
- 远程 agent。
- React/Ink UI 移植。
- Anthropic 专属请求 header、beta、内部 feature gate。

优先实现：

- Execution Flow 文档和事件协议。
- `update_todos` 到 Step v2 的兼容升级。
- `ToolExecutionEngine` progress。
- `RunCommand` 长输出治理。
- subagent sidechain 中间轨迹。
- Vue execution projection 和 UI。

## 验收命令

文档阶段：

```bash
rg -n "TB[D]|TO[D]O|待[定]|待[补]|placeholde[r]" docs/claude-code-core-design docs/superpowers/plans
rg -n "/Users/anhuike/Documents/workspace/claude-code-source-code/sr[c]" docs/claude-code-core-design
git diff --check
```

后续代码阶段：

```bash
make check
```
