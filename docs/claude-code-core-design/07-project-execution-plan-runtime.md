# 07. Project Execution / Plan Runtime

本分册专门回答一个问题：Claude Code 为什么更像“能写真实项目的工程代理”，而不只是“会调用工具的聊天模型”。结论是：它把计划、只读探索、用户批准、todo 推进、验证证据和最终答复门禁连成了一条可恢复执行链。Emperor Agent 升级时应吸收这条链路，而不是只增加提示词。

## Claude Code 源码锚点

- `src/tools/EnterPlanModeTool/EnterPlanModeTool.ts`
- `src/tools/EnterPlanModeTool/prompt.ts`
- `src/tools/ExitPlanModeTool/ExitPlanModeV2Tool.ts`
- `src/tools/ExitPlanModeTool/prompt.ts`
- `src/tools/TodoWriteTool/TodoWriteTool.ts`
- `src/tools/TodoWriteTool/prompt.ts`
- `src/commands/plan/plan.tsx`
- `src/utils/messages.ts`
- `src/utils/plans.ts`
- `src/utils/attachments.ts`
- `src/services/compact/compact.ts`
- `src/constants/prompts.ts`

## 能力本质

Claude Code 的真实项目能力不是来自某个单独工具，而是来自以下不变量：

```text
复杂实现前进入 Plan Mode
-> Plan Mode 只允许只读探索和写计划文件
-> 不确定需求必须 AskUserQuestion
-> 计划完成后只能用 ExitPlanMode 请求批准
-> 批准前不能写业务文件
-> 批准后恢复执行权限，并把批准计划注入实现回合
-> 用 TodoWrite 维护当前步骤
-> 每步完成前运行验证或留下工具证据
-> 失败时继续诊断修复，不允许把失败包装成完成
-> 最终答复必须基于验证事实
```

这套机制的重点是把“模型应该自觉”变成“运行时协议会持续提醒、限制和恢复”。

## Claude Code 执行链路拆解

### 1. 进入计划：权限模式切换，不是普通回复

`EnterPlanModeTool` 是一个 read-only、concurrency safe、deferred tool。模型在复杂实现前主动调用它，工具会把 `toolPermissionContext.mode` 切到 `plan`，并记录进入计划前的权限模式，便于退出时恢复。

关键设计点：

- 它没有业务参数，语义就是“现在切换到计划态”。
- 它不能在 agent 子上下文中使用，避免子代理私自改变主会话控制模式。
- 进入后返回的 tool result 会明确约束：专注探索和设计，不得写业务文件。
- 在 channel 场景下，如果退出计划需要终端 UI 但用户不在终端，入口也会被禁用，避免进入后无法退出。

Emperor 当前状态：

- `PlanDecisionPolicy` 已落地，能对用户请求给出 `required | recommended | proceed` 的确定性判定。
- `ControlManager.assess_plan_decision()` 会结合当前 control mode 和 pending 状态调用该策略。
- Runner 在执行非只读工具前会检查 required-plan 决策；命中时返回 `PLAN_GUARD_REQUIRED` 工具错误，避免在计划前写入文件。

后续方向：

- 将 recommended 决策投影到 WebUI 或 runtime event，作为进入 Plan 的建议，而不是硬拦截。
- 继续保持 `PlanDecisionPolicy` 不调用 LLM，复杂判断后续可在只读探索后由 PlanDraftState 补充。

### 2. Plan Mode 上下文附件：每轮都能恢复约束

Claude Code 不只在进入时说一次“不要写文件”。`utils/messages.ts` 和 `utils/attachments.ts` 会持续注入 plan mode attachment：

- full attachment：首次或必要时注入完整计划工作流。
- sparse attachment：后续回合注入短提醒，防止上下文膨胀。
- re-entry attachment：重新进入计划模式时，提示读取已有计划文件并继续修订。
- exit attachment：退出计划后一次性提醒模型已经可以执行。
- compact attachment：压缩后补回 plan mode 指令和计划文件信息，避免压缩让模型忘记当前仍处于计划态。

Emperor 对应方向：

- 当前 `ControlManager.system_prompt()` 已提供 Plan 模式硬约束，但还缺少“full/sparse/re-entry/exit”级别的计划附件。
- 应新增 `PlanContextInjector`，在每次模型请求前根据 `ControlState`、`PlanRecord`、最近 plan 事件生成短附件。
- 压缩摘要必须携带 active plan、active step、open questions、verification status，否则压缩会破坏项目执行连续性。

### 3. 只读探索和计划文件：允许写的只有计划本身

Claude Code 的 Plan Mode 允许模型读代码、搜索、询问用户，并且可以写一个 plan file。这个例外很关键：它让计划成为可恢复事实，而不是只存在于模型回复里。

`utils/plans.ts` 管理计划文件：

- 每个 session 生成稳定 slug。
- 主会话和 agent 子会话有不同 plan file path。
- `/plan` 可以进入计划模式，也可以展示或打开当前计划文件。
- 恢复会话时，如果计划文件缺失，会尝试从 file snapshot 或消息历史中恢复。
- fork session 时复制计划文件，避免原会话和分叉互相覆盖。

Emperor 对应方向：

- 当前 `PlanStore` 已把计划结构化保存在 `memory/plans/index.json`，比单纯 Markdown 更适合后端执行。
- 还应增加 `PlanWorkingDraft`：保存探索发现、相关文件、未决问题、候选方案、最终推荐方案、验证策略。它相当于 Claude Code plan file 的结构化版本。
- 如果保留 Markdown `plan_markdown`，它应是人类可读投影；运行时事实应以 `PlanRecord` / `PlanStep` / `PlanEvidence` 为准。

### 4. 计划工作流：5 阶段与迭代式面试

Claude Code 新版 Plan Mode 有两种工作流：

- 5 阶段：初始理解、设计、审查、最终计划、调用 `ExitPlanMode`。
- 迭代式面试：探索代码，发现决策点就问用户，边探索边更新计划文件，直到计划覆盖要改什么、哪些文件、复用哪些现有函数、如何验证。

共同点：

- 计划不是一次性输出，必须基于代码事实。
- 问题只问用户才能回答的内容，不能问代码里能查到的事实。
- 计划结尾必须包含验证方式。
- 请求批准只能用 `ExitPlanMode`，不能用普通文字问“这个计划可以吗”。

Emperor 对应方向：

- `propose_plan` 现在能保存结构化 steps，并已在 `PlanRecord.draft` 中维护 `PlanDraftState`。
- `PlanDraftState` 当前维护：
  - `exploring`
  - `questioning`
  - `designing`
  - `reviewing`
  - `ready_for_approval`
  - `approved`
  - `executing`
- `ask_user` 在 Plan 模式下会自动把问题写入 plan draft 的 `open_questions`；用户回答后会移动到 `resolved_questions` 并保留 freeform note。
- Plan comment 会把等待批准的计划退回 `reviewing` / `draft`，并在 metadata 中保留修订快照，下一次 `propose_plan` 会复用同一个 plan id。

### 5. ExitPlanMode：批准边界和权限恢复

`ExitPlanModeV2Tool` 不是简单“结束计划”。它承担批准边界：

- 只能在 plan mode 中调用；否则返回输入验证错误。
- 对主会话需要用户确认，权限行为是 `ask`。
- 计划内容从 plan file 读取，而不是由工具参数直接传入；远程 UI 编辑计划后会把编辑内容回写文件。
- 用户批准后恢复进入计划前的权限模式。
- 如果计划前是 auto，但 auto gate 已关闭，会降级到 default，避免绕过安全断路器。
- 对 teammate，如果配置要求 plan approval，会把审批请求写到 team lead mailbox，而不是弹本地 UI。
- 批准后的 tool result 会把 Approved Plan 注入下一轮，并提示先更新 todo list。

Emperor 对应方向：

- 当前 `ControlManager.approve()` 已把 `PlanRecord` 置为 approved/executing，恢复 previous mode，并把 plan/todos 放入 `plan_approved` runtime event。
- 批准权限增量已落地第一版：Claude Code 支持 `allowedPrompts` 这种按语义授权一类 Bash 操作；Emperor 采用更保守版本，只有 active `PlanStep.commands` 中精确匹配的非高风险 `run_command` 会得到 `plan.approved_command`，其他写/危险命令仍走 permission pipeline。

### 6. TodoWrite：把计划变成正在推进的任务列表

Claude Code 的 `TodoWriteTool` 是无需权限的结构化进度工具。它要求：

- 复杂多步骤任务主动使用。
- 开始任务前把一个 todo 标为 `in_progress`。
- 同时只能有一个 `in_progress`。
- 完成后立即标 `completed`，不能批量拖到最后。
- 遇到错误或阻塞不能标完成。
- 如果 3 个以上 todo 全部关闭但没有 verification 相关 todo，会追加验证提醒。

Emperor 已落地：

- `TodoStore` 强制最多一个 `in_progress`。
- 批准计划后 `PlanExecutionState` 激活第一个 step，并同步到 todos。
- `update_todos` 成功后，Runner 调 `ControlManager.sync_plan_from_todos()` 回写 `PlanStep.status` 和 evidence。

后续增强：

- 为 todo 增加 `active_form`、`plan_step_id`、`verification_required`、`blocked_reason`。
- 不再靠 todo index 对齐 step，改为显式 `plan_step_id`。
- `update_todos` 如果试图跳过 active step 或无 evidence 完成 step，应返回可修复工具错误。

### 7. 验证和最终答复门禁

Claude Code 在提示层明确要求：测试失败就如实说明，不能把失败说成成功；非平凡实现可要求独立 verification agent。TodoWrite 还会在任务收尾时 nudge 验证。

Emperor 已落地：

- `PlanStep.commands` 中声明的命令被 `run_command` 执行时，Runner 记录 `VerificationResult`。
- 验证事件包括 `plan_verification_start`、`plan_verification_done`、`plan_runtime_update`。
- 验证失败会追加 `[PLAN_VERIFICATION_FAILED]` follow-up，要求诊断修复或 `ask_user`。
- 最终答复前有 `[PLAN_INCOMPLETE]` gate；仍有 pending/active/failed/blocked step 时继续执行。

后续增强：

- `VerificationResult` 要区分 `required`、`optional`、`manual`、`skipped_with_reason`。
- 支持一个 step 多条命令全部通过后才可完成。
- 支持“命令未在 plan 中声明但可作为 evidence”的匹配策略，但必须写回 step。
- 引入 `verification_agent` 或 reviewer subagent gate：3+ 文件、后端/API、权限/安全、调度/长期任务变更必须独立复核。

## 源码级真实项目执行状态机

Claude Code 编写真实项目时，主循环不是“收到用户需求 -> 直接改文件 -> 总结”。更准确的流程如下：

```text
用户提出实现需求
-> EnterPlanMode 判定或用户手动 /plan
-> bootstrap/app state 记录 prePlanMode、plan slug、plan exit flags
-> 每轮请求前注入 plan_mode attachment
-> 只读探索：Glob/Grep/Read/Bash read-only/Explore Agent
-> 增量写 plan file，记录文件路径、复用函数、验证命令
-> 有用户决策点时 AskUserQuestion，不能用文字问“计划是否可以”
-> ExitPlanMode 读取 plan file 并触发用户批准
-> 批准后恢复 prePlanMode 或降级到安全 default
-> initialMessage 注入 Approved Plan 和 allowedPrompts
-> TodoWrite 或 TaskCreate/TaskUpdate 建立执行清单
-> 执行工具：Edit/Write/Bash/Agent/Team
-> 每个任务完成时更新 todo/task 状态
-> 运行计划声明的验证命令或触发 verification agent
-> 失败证据进入下一轮修复，不能进入最终答复
-> 完成后最终答复只总结已验证事实、残留风险和命令结果
```

这条状态机有几个关键“硬边界”：

| 边界 | Claude Code 源码机制 | Emperor 应吸收的语义 |
|---|---|---|
| 计划入口 | `EnterPlanModeTool` 修改 `toolPermissionContext.mode`，并通过 `prepareContextForPlanMode()` 保存/剥离权限 | `ControlManager.set_mode("plan")` 不只是 UI 模式，而是工具曝光、权限、prompt attachment 的共同输入 |
| 计划事实 | `utils/plans.ts` 为 session 生成 slug，`getPlanFilePath()` 指向唯一 plan file | `PlanRecord` 是后端事实；可选 Markdown plan file 只是人类投影，必须能从 `PlanStore` 重建 |
| 计划附件 | `utils/attachments.ts` 注入 `plan_mode`、`plan_mode_reentry`、`plan_mode_exit`，`messages.ts` 区分 full/sparse/re-entry/exit 文案 | `PlanContextBuilder` 需要扩展成按阶段输出：full、sparse、reentry、approved、blocked、verification_failed |
| 审批出口 | `ExitPlanModeV2Tool` 从磁盘读取计划，`requiresUserInteraction()` 触发批准 UI，批准后返回 Approved Plan | `propose_plan` / PlanCard approval 必须是唯一批准出口，普通文字不能绕过计划批准 |
| 权限恢复 | 退出计划时恢复 `prePlanMode`，auto gate 关闭时降级 default，dangerous rules 按模式恢复 | 批准计划不能等于无限授权；只能生成计划内命令/步骤的短期许可 |
| 执行清单 | `TodoWriteTool` / `TaskCreateTool` / `TaskUpdateTool` 要求 activeForm、单 active、完成即更新、失败不完成 | `TodoStore` 与 `PlanStep` 需要一对一同步，且用 `plan_step_id` 防止靠数组下标错配 |
| 验证提醒 | Todo/Task 关闭 3+ 项且没有 verification 项时追加验证 nudge | `PlanEvidenceGate` 和 independent verification gate 应是后端门禁，不只靠提示词 |
| 恢复连续性 | plan slug、file snapshot、message recovery、plan_mode_exit attachment、pendingPlanVerification | `memory/plans/index.json`、runtime replay、compaction context、task transcript 要共同恢复 active plan |

### 端到端执行能力的核心不变量

1. **计划必须基于源码事实**：计划里要有文件路径、既有函数/工具、复用点、测试入口。只写“实现某功能”不够。
2. **批准前只能读和写计划**：读文件、搜索、只读子代理可以并发；业务文件、配置、提交、部署都必须被 Plan Mode 拦住。
3. **批准后第一件事是任务化**：Claude Code 通过 `TodoWrite` 或 Task V2 把计划拆成可见状态；Emperor 应把 `PlanStep` 激活同步为 todo/task。
4. **完成状态必须有证据**：step 声明了命令，就必须看到通过的 `VerificationResult`；命令失败时 step 留在 failed，不允许模型口头跳过。
5. **阻塞要转成交互**：缺需求、缺凭证、需要产品取舍时，状态机进入 `ask_user`，不能在最终答复里模糊带过。
6. **最终答复是状态机出口**：只有 active plan 没有 pending/active/failed/blocked step，且独立验证满足策略时，Runner 才能结束。
7. **压缩不能抹掉项目边界**：active step、失败证据、计划文件、相关 artifact、用户评论必须进入 compact/runtime attachment。

## Emperor Plan Runtime v4 升级细化

前面 PE-1 至 PE-9 已经把计划从 Markdown 卡片推进到结构化执行态。下一阶段要补的是“真实项目编写闭环”：计划触发更稳、探索证据更强、任务推进更像工程执行、验证和 UI 更可审计。

### PE-10：Plan Entry Runtime Contract

目标：把“该不该进入 Plan”从单次写工具前 guard 升级为整轮 runtime contract。

状态：已落地第一版。当前实现兼容扩展 `agent/control/plan_policy.py` 的 `PlanDecision`，暴露 `triggers`、`suggested_questions`、`recommended_readonly_scopes` 和 `to_runtime_contract()`；Runner 在 turn 开始发送 `plan_entry_decision` runtime event，`PLAN_GUARD_REQUIRED` 工具错误会附带只读探索范围，前端 `planProjection` 保存最近入口决策，供后续 Project Execution 面板消费。

目标文件：

- `agent/control/plan_policy.py`
- `agent/control/manager.py`
- `agent/runner.py`
- `agent/runtime/events.py`
- `desktop/src/renderer/src/runtime/handlers/plans.ts`
- `tests/unit/test_plan_decision_policy.py`
- `tests/unit/test_control.py`

新增接口：

```python
@dataclass(frozen=True)
class PlanEntryDecision:
    decision: str              # required | recommended | proceed
    reason: str
    triggers: list[str]
    suggested_questions: list[str]
    recommended_readonly_scopes: list[str]
```

执行点：

1. turn 开始时根据用户消息生成 `PlanEntryDecision`，写入本轮 runtime event。
2. `required` 时，Runner 在任何非只读工具前返回 `PLAN_GUARD_REQUIRED`，并附带 recommended readonly scopes。
3. `recommended` 时不阻断，但 WebUI 和模型上下文收到轻量提示，鼓励先探索/提问。
4. 用户已给出完整实施计划时，decision 为 `proceed`，但仍要求 `update_todos` 或 `PlanRecord` 绑定。

验收：

- 高影响改造在写文件前必定出现 `PLAN_GUARD_REQUIRED`。
- 明确单文件 bugfix 不触发 required。
- WebUI replay 能展示本轮为何建议或要求计划。

### PE-11：Plan Discovery Ledger

目标：让只读探索结果进入 `PlanDraftState.discoveries`，计划质量门禁可以引用这些事实。

目标文件：

- `agent/plans/models.py`
- `agent/plans/store.py`
- `agent/control/manager.py`
- `agent/tools/subagent.py`
- `agent/tools/grep.py`
- `agent/tools/read_file.py`
- `tests/unit/test_plan_discovery_ledger.py`

新增结构：

```python
@dataclass(frozen=True)
class PlanDiscovery:
    id: str
    source: str                # read_file | grep | subagent | mcp
    summary: str
    files: list[str]
    symbols: list[str]
    evidence_refs: list[str]
    created_at: float
```

执行点：

1. Plan 模式下只读工具可以选择性上报 discovery summary。
2. 只读探索子代理结束时，把结论、证据文件、风险写入 discovery ledger。
3. `PlanQualityGate` 要求每个非平凡 step 至少引用文件、discovery 或用户决策。
4. Discovery 只保存摘要和 artifact refs，不把大段文件内容塞进 plan store。

验收：

- Plan 模式下 `read_file` / `grep` / 只读 subagent 能生成 discovery。
- 没有文件/发现依据的泛泛计划会被质量门禁拒绝。
- 压缩后 `PlanContextBuilder` 仍能注入最近 discovery 摘要。

### PE-12：只读探索扇出执行器

目标：吸收 Claude Code Explore/Plan agent 并行探索能力，但保持 Emperor 的子代理权限白名单。

目标文件：

- `agent/subagents/registry.py`
- `agent/tools/subagent.py`
- `agent/tasks/manager.py`
- `agent/tasks/sidechain.py`
- `agent/runtime/events.py`
- `tests/unit/test_plan_readonly_exploration.py`

行为：

1. Plan 模式允许 `dispatch_subagent(agent_type in readonly_explorers)`。
2. 每个探索任务必须带 `scope_limit`、`expected_output`、`evidence_required`。
3. 探索结果写入 sidechain transcript，并登记到 `PlanDiscovery`。
4. 写入型子代理、能修改文件的 teammate、scheduler mutation 在 Plan 模式继续拒绝。

验收：

- 多个只读探索任务可以并发启动并产生 task lifecycle event。
- 只读探索不能调用 `write_file` / `edit_file` / `run_command` 写入类命令。
- PlanCard 能显示“探索证据数量”和最近 discovery 摘要。

### PE-13：Approved Plan Permission Token

目标：批准计划后生成短期、可撤销、可审计的权限 token，而不是长期放宽模式。

目标文件：

- `agent/permissions/models.py`
- `agent/permissions/manager.py`
- `agent/control/manager.py`
- `agent/plans/models.py`
- `tests/unit/test_plan_permission_tokens.py`

新增结构：

```python
@dataclass(frozen=True)
class PlanPermissionToken:
    plan_id: str
    step_id: str
    tool_name: str
    argument_hash: str
    expires_at: float
    uses_remaining: int
    reason: str
```

执行点：

1. Plan approval 为每个 active step 的非高风险验证命令生成一次性 token。
2. 用户 comment、plan revision、step failed、mode 切换时撤销旧 token。
3. token 只能降低无意义重复审批，不允许绕过高风险 shell、敏感路径写入、部署、push。
4. permission runtime event 记录 token 命中或拒绝原因。

验收：

- 同一计划命令第一次执行可命中 token，第二次需要重新评估或消耗新 token。
- 修改计划后旧 token 不再生效。
- `git push`、删除、部署即使在计划里也不被 token 放行。

### PE-14：Plan Step Task Binding

目标：把 `PlanStep`、todo、TaskRecord、sidechain transcript 合并成一个可恢复执行单元。

目标文件：

- `agent/plans/execution.py`
- `agent/tasks/models.py`
- `agent/tasks/manager.py`
- `agent/tools/todo.py`
- `agent/runtime/events.py`
- `desktop/src/renderer/src/runtime/handlers/tasks.ts`
- `tests/unit/test_plan_task_binding.py`

行为：

1. 批准计划后，每个 `PlanStep` 创建或绑定一个 `TaskRecord(kind="plan_step")`。
2. active step 对应 task 进入 `running`，pending step 对应 task 进入 `queued`。
3. 工具输出、验证命令、子代理复核写入 step task sidechain。
4. `update_todos` 只更新展示清单；PlanStep 状态以 task/evidence gate 为准。

验收：

- 重启后可从 `PlanStore` + `TaskStore` 恢复 active step 和 transcript。
- WebUI Task projection 能定位到 plan id/step id。
- step done 前 transcript 至少包含修改摘要或验证证据。

### PE-15：Verification Matrix

目标：把每个 step 的验证从单条 command 升级为 required/optional/manual 矩阵。

目标文件：

- `agent/plans/verification.py`
- `agent/plans/evidence.py`
- `agent/control/manager.py`
- `agent/runner.py`
- `tests/unit/test_plan_verification_matrix.py`

新增结构：

```python
@dataclass(frozen=True)
class VerificationRequirement:
    id: str
    kind: str                  # command | manual | reviewer | smoke
    required: bool
    command: str
    description: str
    status: str                # pending | passed | failed | skipped
    evidence_refs: list[str]
```

执行点：

1. `PlanStep.commands` 兼容映射成 required command requirements。
2. `run_command` 通过时只满足匹配 requirement，不自动完成整个 step。
3. manual verification 必须有用户或 reviewer 明确记录，不能由模型自称。
4. skipped 需要 reason，并进入最终答复风险段。

验收：

- 多条 required command 必须全部 passed 才能完成 step。
- optional command 失败不会阻止 step，但会进入风险摘要。
- manual verification 缺证据时 final answer gate 阻断。

### PE-16：Reviewer Task Transcript 收敛

目标：让 independent verification 不只是 `PlanRecord.verification` 的一条 dict，而是可打开的复核任务。

目标文件：

- `agent/control/manager.py`
- `agent/subagents/registry.py`
- `agent/tasks/manager.py`
- `agent/tasks/sidechain.py`
- `desktop/src/renderer/src/components/chat/PlanCard.vue`
- `tests/unit/test_plan_reviewer_task_transcript.py`

行为：

1. final answer gate 需要复核时创建 `TaskRecord(kind="verification")`。
2. `verification_reviewer` 的输入、工具轨迹、结论写入 sidechain。
3. reviewer PASS/FAIL 转换为 `PlanRecord.verification` evidence，并保留 task id。
4. PlanCard 可以打开 reviewer transcript。

验收：

- reviewer FAIL 后 PlanRecord 保留失败原因、命令、task id。
- reviewer PASS 但无命令 evidence 时状态为 `missing_command_evidence`。
- 刷新后 PlanCard 仍能显示并打开复核 transcript。

### PE-17：Project Execution Panel

目标：把 Chat 内 PlanCard 升级为独立项目执行视图，适合真实项目长任务。

目标文件：

- `desktop/src/renderer/src/views/ProjectExecutionView.vue`
- `desktop/src/renderer/src/components/panels/ProjectExecutionPanel.vue`
- `desktop/src/renderer/src/runtime/handlers/plans.ts`
- `desktop/src/renderer/src/runtime/handlers/tasks.ts`
- `desktop/src/renderer/src/router.ts`
- `tests` 对应前端 runtime/vitest 测试

界面信息：

- active plan、step、状态、风险。
- discovery ledger。
- step task transcript 入口。
- verification matrix。
- reviewer transcript。
- 用户 comment / approval 历史。

验收：

- 刷新后由 runtime replay 恢复完整视图。
- 长 stdout/stderr 只显示摘要和 artifact 链接。
- 用户能一眼判断：正在做哪一步、为什么卡住、还差什么验证。

### PE-18：Project Execution Smoke Gate

目标：为“真实项目编写能力”建立端到端验收，而不是只看单元测试。

目标文件：

- `tests/integration/test_project_execution_flow.py`
- `tests/unit/test_agent_prompt_contracts.py`
- `scripts/check.sh`
- `docs/claude-code-core-design/07-project-execution-plan-runtime.md`

验收场景：

1. 用户提出高影响多文件改造，系统 required plan 并阻止写入。
2. Plan 模式只读探索生成 discovery。
3. `propose_plan` 产生结构化 steps 和 verification matrix。
4. 用户批准后同步 task/todo。
5. 修改代码并运行验证命令。
6. 验证失败时 step failed，模型继续修复。
7. 验证通过且 reviewer PASS 后才允许最终答复。
8. 重启或压缩后 active plan 能恢复。

验收命令：

```bash
.venv/bin/python -m pytest tests/integration/test_project_execution_flow.py tests/unit/test_agent_prompt_contracts.py -q
npm --prefix desktop run test -- planProjection taskProjection
```

## Emperor 当前链路

当前项目已经具备以下基础：

```text
ControlManager.set_mode("plan")
-> ProposePlanTool 接收 title / summary / plan_markdown / steps
-> PlanStore 保存 PlanRecord
-> PlanCard 等待用户 comment / approve
-> approve 后 PlanExecutionState 激活首个 step
-> TodoStore.sync_from_plan_steps()
-> AgentRunner 执行工具
-> update_todos 回写 PlanStep.status/evidence
-> run_command 匹配 active step.commands
-> VerificationResult 写入 evidence
-> plan_runtime_update 进入后端 runtime log
-> WebUI planProjection 重放 PlanCard 状态
-> Final Answer Gate 阻止未完成计划直接结束
```

这已经比“计划卡片 + 提示词”前进了一大步。剩余问题主要是计划触发、计划阶段、证据强度和恢复附件。

## 下一阶段升级任务点

### PE-1：PlanDecisionPolicy

目标：让系统能判断什么时候必须计划、什么时候建议计划、什么时候直接执行。

状态：已落地第一版。当前实现位于 `agent/control/plan_policy.py`，并已接入 `ControlManager` 与 Runner 写工具前置 guard；测试见 `tests/unit/test_plan_decision_policy.py` 和 `tests/unit/test_control.py::test_runner_plan_guard_blocks_high_impact_write_before_planning`。

目标文件：

- `agent/control/plan_policy.py`
- `agent/control/manager.py`
- `agent/runner.py`
- `tests/unit/test_plan_decision_policy.py`

规则草案：

- 必须计划：多文件架构改造、权限/安全/部署/删除覆盖、用户明确要求先计划、需求明显有多个方案且影响大。
- 建议计划：预计 3+ 步、涉及新功能、多模块行为变化、验收不明确。
- 直接执行：单文件小修、明确 bugfix、纯只读问题、用户给出完整实施计划。

验收：

- 高影响写入前触发 Plan 或 Ask。
- 简单修复不被过度计划打断。
- Plan 模式下最终普通回复仍被包装为 PlanCard。

### PE-2：PlanDraftState 与 Plan Phase

目标：把 Claude Code 的 plan file 工作流变为结构化 draft。

状态：已落地第一版。当前实现位于 `agent/plans/models.py` 的 `PlanDraftState` / `PlanDraftPhase`，并已接入 `ControlManager.create_plan()`、Plan 模式 `ask_user`、`answer()` 和 `comment()`；测试见 `tests/unit/test_plan_draft_state.py`。

目标文件：

- `agent/plans/models.py`
- `agent/plans/store.py`
- `agent/control/manager.py`
- `tests/unit/test_plan_draft_state.py`

新增字段建议：

- `phase`
- `discoveries`
- `relevant_files`
- `open_questions`
- `resolved_questions`
- `alternatives_considered`
- `recommended_approach`
- `verification_strategy`
- `last_context_refresh_at`

验收：

- Plan comment 后保留旧 draft，并生成修订版本。
- `ask_user` 答案可关联到 open question。
- 重启后可从 `memory/plans/index.json` 恢复当前处于探索、提问、修订还是待批准。

### PE-3：只读探索扇出

目标：吸收 Claude Code Explore/Plan agent 并行探索思想，但不照搬其 agent 类型。

目标文件：

- `agent/subagents/registry.py`
- `agent/tools/subagent.py`
- `agent/control/manager.py`
- `agent/tasks/*`

行为：

- Plan 模式允许只读探索子代理。
- 每个探索任务必须有 scope、expected_output、evidence_required。
- 探索结果写入 `PlanDraftState.discoveries`，不是直接污染主 history。

验收：

- Plan 模式下写入型 subagent 仍被拒绝。
- 多个只读探索可以并发。
- 计划必须引用探索得到的文件路径或明确说明未找到可复用实现。

### PE-4：结构化计划质量门禁

目标：`propose_plan` 不只收 steps，还要验证每个 step 是否可执行。

状态：已落地第一版。当前实现位于 `agent/plans/quality.py`，并通过 `ProposePlanTool` 的 `enforce_quality=True` 接入模型提交计划路径；测试见 `tests/unit/test_plan_quality_gate.py`。

目标文件：

- `agent/control/tools.py`
- `agent/control/manager.py`
- `agent/plans/models.py`
- `tests/unit/test_plan_quality_gate.py`

门禁：

- 每个 step 必须有目标、相关文件或探索依据、验收方式。
- 每个 step 必须有 verification command 或 manual verification rule。
- 高风险 step 必须同时有 risk note 和 rollback path。
- 不允许只有泛泛描述，如“优化代码”“修复问题”。

验收：

- 低质量计划返回 `Error: plan quality gate failed` 工具错误，要求模型修订，且不创建 pending PlanCard。
- 高质量计划保存为 `waiting_approval`。

### PE-5：批准后权限与命令白名单

目标：批准计划不等于无限授权，只对计划内动作提供更顺滑的执行路径。

状态：已落地第一版。`PermissionManager` 在常规权限管线前识别当前 active PlanStep 的精确验证命令，返回 `plan.approved_command`；`git push`、删除、部署等 high-risk shell 即使写入计划也仍会触发审批，写文件和敏感路径不因出现在计划文件列表中自动放行。

目标文件：

- `agent/permissions/pipeline.py`
- `agent/control/manager.py`
- `agent/plans/models.py`
- `tests/unit/test_plan_permission_scope.py`

行为：

- `PlanStep.commands` 中的验证命令可降低审批摩擦，但仍经过危险命令检查。
- 计划外破坏性命令仍 Ask。
- 用户评论修改计划后，旧授权失效。

验收：

- 批准计划内 test 命令不重复弹无意义审批。
- 计划外 `rm -rf`、部署、push 不被批准计划自动放行。
- 覆盖测试：`tests/unit/test_plan_command_permissions.py`。

### PE-6：Step Evidence 强制一致性

目标：消除“todo 完成但 step 没有真实证据”的漏洞。

状态：已落地第一版。当前实现包括 `agent/plans/evidence.py`、`ControlManager.sync_plan_from_todos()` 的 transition guard、`UpdateTodosTool` 的 `plan_step_id` / `blocked_reason` 字段，以及 Runner 对 `PlanEvidenceError` 的工具错误回写；测试见 `tests/unit/test_plan_evidence_gate.py`。

目标文件：

- `agent/tools/todo.py`
- `agent/runner.py`
- `agent/control/manager.py`
- `tests/unit/test_plan_evidence_gate.py`

行为：

- `update_todos` 标完成 active step 时，如果 step 声明了 verification commands 且无通过 evidence，返回可修复错误。
- Runner 检测到匹配 `run_command` 通过证据后允许完成。
- failed verification 会阻止完成，并保持 PlanRecord 不被错误推进。
- `blocked` step 必须有 `blocked_reason` 或配套 `ask_user` 交互。
- todo 支持 `plan_step_id`，优先按显式 step id 对齐，旧 id 下标仍兼容。

验收：

- 未运行验证时不能完成 required verification step。
- 验证失败不能完成 step。
- blocked step 必须说明原因。

### PE-7：独立验证子代理

目标：对非平凡项目改动引入对抗式复核。

状态：已落地第一版。当前实现把独立验证作为 Final Answer Gate 的一部分，而不是只写在 prompt 中。非平凡或敏感计划完成后，Runner 会在最终答复前调用 `ControlManager.plan_independent_verification_followup()`；没有 reviewer PASS + command evidence，也没有用户豁免时，会追加 `[PLAN_INDEPENDENT_VERIFICATION_REQUIRED]` 让模型继续派复核或请求豁免。复核 FAIL 会追加 `[PLAN_INDEPENDENT_VERIFICATION_FAILED]`，强制回到修复循环。

目标文件：

- `agent/subagents/registry.py`
- `agent/runner.py`
- `agent/control/manager.py`
- `agent/plans/verification.py`
- `templates/subagents/verification_reviewer.md`
- `tests/unit/test_plan_independent_verification.py`

触发条件：

- 3+ 文件变更。
- 后端/API/权限/调度/长期任务变更。
- 数据迁移、删除、部署、外部发送能力。

验收：

- 非平凡计划完成后，最终答复前必须有 reviewer/verification 结果或明确用户豁免。
- verification PASS 必须带 command evidence；只给口头 PASS 仍会被视为缺证据。
- verification FAIL 会生成修复 follow-up。
- 如果 `dispatch_subagent` 不可用、仍在 Plan 模式或存在 pending Ask/Plan，门禁不会静默跳过，而是要求 `ask_user` 明确豁免。
- `verification_reviewer` 是只读复核子代理，不含 `write_file` / `edit_file` / `dispatch_subagent`。

第一版边界：

- 已完成 final answer gate、风险识别、`VerificationReviewRequest` metadata、`PlanRecord.verification` PASS/FAIL/waiver evidence、`verification_reviewer` registry/template。
- 已把复核状态投影到 PlanCard：required / passed / failed / waived / missing command evidence 均可回放。
- 尚未把 reviewer 执行结果自动映射为可打开的持久 task transcript；这部分进入 PE-16。

### PE-8：Plan Runtime 恢复附件

目标：压缩、刷新、重启后不丢正在执行的计划边界。

状态：已落地第一版。当前实现包括 `agent/plans/context.py` 的 `PlanContextBuilder`、`ContextPipeline(plan_context_provider=...)`、Runner 默认接入 `control_manager.plan_store`，以及 Compactor runtime context provider；测试见 `tests/unit/test_plan_context_attachment.py`。

目标文件：

- `agent/context_pipeline/*`
- `agent/compactor.py`
- `agent/runner.py`
- `agent/loop.py`

附件内容：

- active plan id/title/status。
- active step、pending steps、failed steps。
- 最新 verification evidence。
- open questions / blocked reason。
- 最近相关文件和 artifact refs。

验收：

- 压缩后模型仍能继续 active step。
- 重启后模型投影可从 `memory/plans/index.json` 恢复 active plan context。
- 历史摘要不会把 failed verification 写成 passed。
- completed plan 默认不注入，除非用户明确询问计划历史。

### PE-9：WebUI Project Execution 面板

目标：让用户能直接看到计划执行状态，而不是只从聊天日志推断。

状态：已落地第一版。当前实现包括 `desktop/src/renderer/src/runtime/handlers/plans.ts` 的 `planExecutionSummary()`、`plan_approved` / `plan_runtime_update` 重放合并，以及 `PlanCard.vue` 的执行态摘要区。计划正文 Markdown 退到执行摘要之后，用户先看到当前 active step、失败验证摘要、blocked reason、open questions 数量和 independent verification 状态。

目标文件：

- `desktop/src/renderer/src/runtime/handlers/plans.ts`
- `desktop/src/renderer/src/components/chat/PlanCard.vue`
- `desktop/src/renderer/src/components/panels/*`

展示：

- Plan status。
- 当前 active step。
- 涉及文件。
- 验证命令与结果。
- failed/block reason。
- 用户评论和批准历史。

验收：

- 刷新后状态不丢。
- 验证失败摘要可见，但不展示超长 stdout。
- 用户能从 UI 判断为什么还没最终完成。

第一版边界：

- 已完成 Chat 内 PlanCard 投影；尚未新增独立 Project Execution 面板页。
- 已展示 independent verification required / passed / failed / waived / missing command evidence。
- 后续 Task Framework 落地后，需要把 reviewer task transcript、sidechain 输出和 PlanCard 状态统一收敛。

## 升级优先级

优先做：

1. `PE-11 Plan Discovery Ledger` + `PE-12 只读探索扇出执行器`：让计划基于可审计的源码探索证据。
2. `PE-14 Plan Step Task Binding`：把每个计划步骤绑定到 TaskRecord 和 sidechain transcript。
3. `PE-15 Verification Matrix`：支持多命令、manual、reviewer、smoke 的验证矩阵。
4. `PE-16 Reviewer Task Transcript 收敛`：让独立复核可打开、可回放、可追溯。
5. `PE-17 Project Execution Panel`：从 Chat PlanCard 升级到独立项目执行视图。

暂缓做：

- 远程 `/ultraplan` 类能力：先把本地计划执行闭环做稳。
- Anthropic 专属 auto classifier / allowedPrompts 细节：Emperor 是多 provider，先做 provider-neutral 的权限语义。
- React/Ink 计划 UI：继续用 Vue/Electron 投影。
