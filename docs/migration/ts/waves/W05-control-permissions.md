# W05 · 控制 / 计划 / 权限（CTRL）

依赖：W03　|　子系统映射：`agent/control/*`、`agent/plans/*`、`agent/permissions/*`（命令判定纯函数已在 W04-TOOL-005）。
这是行为最敏感的一波：Ask/Plan 状态机、PlanGuard、三模式权限、PE-13 不变量都在这里。对账 `tests/unit/test_control.py`、`test_plan_*`、`test_permission*`、`test_plan_guard_execution.py`。

### MIG-CTRL-001 · 控制态模型 + ControlStore

- **功能点**：ControlState/Interaction/模式枚举/pending 状态，按会话持久化。
- **源(Python)**：`agent/control/models.py`（`ControlMode`、`Interaction`、`InteractionStatus`、`now_ts`）、`agent/control/store.py`。
- **目标(TS)**：`packages/core/src/control/models.ts`、`control/store.ts`。
- **依赖**：MIG-FND-002
- **设计**：v1 同时只允许一个 pending ask/plan；状态按会话写盘。**磁盘兼容**：control state JSON schema 不变。
- **风险/复杂度**：M。
- **验证**：移植 control store/模型 单测。**验收**：pending/模式持久化一致。
- **状态**：todo · PR: —

### MIG-CTRL-002 · ControlManager 门面 + 模式管理

- **功能点**：当前模式、payload、ensure_no_pending、set_pending、模式恢复、执行/pending 期禁切换。
- **源(Python)**：`agent/control/manager.py`（`ControlManager` 门面、`set_mode`、`payload`、`ensure_no_pending`、`_set_pending`、`_restore_mode`、`_latest_executable_plan`/`_latest_reviewable_plan`/`reviewable_plan_id`、`_has_ask_interaction`）。
- **目标(TS)**：`packages/core/src/control/manager.ts`（薄门面，委托各子管理器）。
- **依赖**：MIG-CTRL-001
- **设计**：门面装配 8 个子管理器（policy/clarification/plan_decision/permission/permission_tokens/verification/drafting/execution）；执行中或有 pending 时切模式抛 409（IPC 层映射）。
- **风险/复杂度**：M。
- **验证**：移植 manager 门面/模式切换 单测。**验收**：门面委托与 409 语义一致。
- **状态**：todo · PR: —

### MIG-CTRL-003 · ClarificationPolicy（Ask guard）

- **功能点**：高影响歧义统一判断是否先 `ask_user`。
- **源(Python)**：`agent/control/clarification.py`（`assess_clarification`、`_CONTROL_RESUME_RE`）。
- **目标(TS)**：`packages/core/src/control/clarification.ts`。
- **依赖**：MIG-CTRL-001
- **设计**：大范围工程/重构/UI 取舍/提交推送/删除覆盖/发布/安全权限成本不清 → 写操作和最终答复前进入 ask；`_CONTROL_RESUME_RE` 导出供 plan-drafting 复用。
- **风险/复杂度**：M。
- **验证**：移植 clarification 单测。**验收**：判定一致。
- **状态**：todo · PR: —

### MIG-CTRL-004 · 控制工具 ask_user / propose_plan

- **功能点**：结构化提问与提交计划，暂停回合。
- **源(Python)**：`agent/control/tools.py`（`AskUserTool`、`ProposePlanTool`）。
- **目标(TS)**：`packages/core/src/control/tools.ts`。
- **依赖**：MIG-CTRL-002、MIG-TOOL-001
- **设计**：ask 1-3 题、每题 2-4 互斥选项、推荐置首；propose_plan 结构化 steps（id/title/description/files/commands/acceptance/verification）、assumptions、risk_level；二者生成 waiting tool result 并抛 TurnPaused。
- **风险/复杂度**：M。
- **验证**：移植 `test_tool_descriptions.py`(ask/propose) + 暂停单测。**验收**：暂停与结构一致。
- **状态**：todo · PR: —

### MIG-CTRL-005 · PlanDecisionPolicy（plan guard 决策）

- **功能点**：高影响请求是否必须先计划（required/recommended/proceed）。
- **源(Python)**：`agent/control/plan_policy.py`（`PlanDecisionPolicy.assess`、`_collect_signals`、`_requires_plan`、`_recommends_plan`、`PlanDecision.to_runtime_contract`、跳过条件）。
- **目标(TS)**：`packages/core/src/control/plan-policy.ts`。
- **依赖**：MIG-CTRL-001
- **设计**：信号集（architecture/refactor/multi_module/deployment/destructive/security/migration/unclear_acceptance/feature/multi_step）、hard 信号、跳过条件（plan 模式/has_pending/已给计划标记/小直改）逐字保真。
- **风险/复杂度**：M。
- **验证**：移植 plan_policy 单测。**验收**：信号与决策逐例一致。
- **状态**：todo · PR: —

### MIG-CTRL-006 · PlanDraftingManager（含 executing-plan 豁免）

- **功能点**：create_plan/草稿生命周期/discovery/draft Q&A/assess_plan_decision 豁免。
- **源(Python)**：`agent/control/plan_drafting.py`（`create_plan`/`create_plan_from_text`/`assess_plan_decision`/`record_plan_discovery`/`_ensure_plan_draft`/`_latest_draft_plan` 等）。
- **目标(TS)**：`packages/core/src/control/plan-drafting.ts`。
- **依赖**：MIG-CTRL-005、MIG-CTRL-012
- **设计**：**executing-plan 豁免**：`_CONTROL_RESUME_RE` 命中且存在 executable plan → proceed("executing_plan")，否则走 policy。草稿质量门（W05-013）。
- **风险/复杂度**：M。
- **验证**：移植 `test_plan_guard_execution.py`、plan draft/discovery 单测。**验收**：豁免与草稿流程一致。
- **状态**：todo · PR: —

### MIG-CTRL-007 · PlanExecutionManager

- **功能点**：approved→executing 激活、todo↔step 同步、step 任务同步、状态更新、工具输出 sidechain。
- **源(Python)**：`agent/control/plan_execution.py`（`sync_plan_from_todos`/`_activate_approved_plan`/`_update_plan_status`/`_sync_plan_step_tasks`/`record_plan_step_tool_output`/`_append_plan_step_verification` 等）。
- **目标(TS)**：`packages/core/src/control/plan-execution.ts`。
- **依赖**：MIG-CTRL-006、MIG-RTE-*（task store）
- **设计**：批准后一个 active todo 对齐 active step；step 完成需 verification evidence；状态机 pending/active/failed/blocked/completed 逐字。
- **风险/复杂度**：L。
- **验证**：移植 `test_plan_execution_state.py`、`test_plan_task_binding.py`、`test_plan_runtime.py`。**验收**：执行态同步一致。
- **状态**：todo · PR: —

### MIG-CTRL-008 · PlanVerificationManager + 独立核验

- **功能点**：step 验证装配、独立验证 followup、证据评估。
- **源(Python)**：`agent/control/plan_verification.py`、`agent/plans/evidence.py`（`assess_step_verification`）、`plans/verification.py`、`plans/reviewer.py`（`parse_reviewer_verdict`）。
- **目标(TS)**：`packages/core/src/control/plan-verification.ts`、`plans/evidence.ts`。
- **依赖**：MIG-CTRL-012
- **设计**：VerificationRequirement/Command/Result、独立 reviewer 派遣触发条件、verdict 解析逐字。
- **风险/复杂度**：M。
- **验证**：移植 `test_plan_verification*.py`。**验收**：验证装配/评估一致。
- **状态**：todo · PR: —

### MIG-CTRL-009 · PlanPermissionTokenManager

- **功能点**：批准计划的命令验证 token 颁发/消费、元数据剥离。
- **源(Python)**：`agent/control/plan_permissions.py`（token 颁发、`_metadata_without_plan_permission_tokens`）。
- **目标(TS)**：`packages/core/src/control/plan-permissions.ts`。
- **依赖**：MIG-CTRL-014
- **设计**：approved plan step 声明命令的一次性 token；**PE-13 不变量**：高风险命令即便在已批准计划中仍需审批（token 不覆盖高风险）。
- **风险/复杂度**：M。
- **验证**：移植 `test_plan_permission_tokens.py`、`test_plan_command_permissions.py`。**验收**：token 语义 + PE-13 一致。
- **状态**：todo · PR: —

### MIG-CTRL-010 · plan helpers（纯函数 + 常量）

- **功能点**：plan 解析/摘要/草稿判定等纯函数。
- **源(Python)**：`agent/control/plan_helpers.py`（`_parse_plan_steps`/`_ready_for_approval_draft`/`_looks_like_plan`/`_first_heading`/`_plain_summary`/`_dedupe_strings`/`_INDEPENDENT_VERIFICATION_*` 常量）。
- **目标(TS)**：`packages/core/src/control/plan-helpers.ts`。
- **依赖**：MIG-CTRL-012
- **设计**：纯函数逐字搬。
- **风险/复杂度**：S。
- **验证**：移植 helpers 单测。**验收**：纯函数等价。
- **状态**：todo · PR: —

### MIG-CTRL-011 · Ask/Plan 交互流（create_ask/answer/comment/approve/cancel）+ resume 消息

- **功能点**：交互解析、暂停/恢复、`[CONTROL:*]` resume 消息构造。
- **源(Python)**：`agent/control/manager.py`（`create_ask`/`answer`/`comment`/`approve`/`cancel`、`_approval_message`/`_answer_message`/`_comment_message`、`ControlResume`、`[CONTROL:PLAN_APPROVED|ASK_ANSWERED|PLAN_COMMENT|INTERACTION_CANCELLED]`）、`agent/control/exceptions.py`（`TurnPaused`）。
- **目标(TS)**：`packages/core/src/control/interactions.ts`。
- **依赖**：MIG-CTRL-002,004,006,007
- **设计**：approve→activate + 恢复模式；resume 消息前缀/正文（含执行契约）逐字；TurnPaused 控制流。
- **风险/复杂度**：L。
- **验证**：移植 `test_control.py` 交互流 + 计划批准消息单测。**验收**：resume 文本/状态流转一致。
- **状态**：todo · PR: —

### MIG-CTRL-012 · plans 模型 + PlanStore

- **功能点**：计划领域模型与持久化。
- **源(Python)**：`agent/plans/models.py`（`PlanStatus`/`PlanStepStatus`/`PlanDraftPhase`/`PlanDiscovery`/`PlanDraftState`/`PlanStep`/`PlanRecord`）、`plans/store.py`（`PlanStore`）。
- **目标(TS)**：`packages/core/src/plans/models.ts`、`plans/store.ts`。
- **依赖**：MIG-FND-002
- **设计**：dataclass→interface；**磁盘兼容**：plan record JSON 字段不变。
- **风险/复杂度**：M。
- **验证**：移植 plan store/模型 单测。**验收**：读旧 plan JSON 等价。
- **状态**：todo · PR: —

### MIG-CTRL-013 · plan 质量门 + 执行态 + 上下文

- **功能点**：PlanQualityGate、PlanExecutionState、PlanContextBuilder。
- **源(Python)**：`agent/plans/quality.py`（`PlanQualityGate`/`PlanQualityResult`/`PlanQualityError`）、`plans/execution.py`（`PlanExecutionState`）、`plans/context.py`（`PlanContextBuilder`）。
- **目标(TS)**：`packages/core/src/plans/quality.ts`、`execution-state.ts`、`context.ts`。
- **依赖**：MIG-CTRL-012
- **设计**：质量门校验（step 具体性/验收/验证矩阵）逐字；durable plan 上下文注入文案逐字。
- **风险/复杂度**：M。
- **验证**：移植 `test_plan_quality_gate.py`、plan context 单测。**验收**：质量门/上下文一致。
- **状态**：todo · PR: —

### MIG-CTRL-014 · 权限模型

- **功能点**：权限枚举与决策/画像/token 类型。
- **源(Python)**：`agent/permissions/models.py`（`PermissionMode`/`RiskLevel`/`PermissionTraceEntry`/`ToolPermissionProfile`/`PlanPermissionToken`/`PermissionDecision`）。
- **目标(TS)**：`packages/core/src/permissions/models.ts`。
- **依赖**：MIG-FND-001
- **设计**：`PermissionDecision` 字段 `allowed/requires_approval/risk/reason/rule/trace`（无 `behavior`）逐字。
- **风险/复杂度**：S。
- **验证**：vitest：决策字段。**验收**：字段集一致。
- **状态**：todo · PR: —

### MIG-CTRL-015 · 工具画像解析

- **功能点**：从工具+参数解析权限画像（read_only/concurrency/destructive/path/command/scheduler_action）。
- **源(Python)**：`agent/permissions/resolvers.py:resolve_tool_profile`。
- **目标(TS)**：`packages/core/src/permissions/resolve-profile.ts`。
- **依赖**：MIG-CTRL-014、MIG-TOOL-004
- **设计**：经 ToolAdapter 取 `is_read_only/is_concurrency_safe/is_destructive/get_path`，异常回退属性。
- **风险/复杂度**：S。
- **验证**：移植 profile 解析单测。**验收**：画像一致。
- **状态**：todo · PR: —

### MIG-CTRL-016 · PermissionPolicy（三模式）

- **功能点**：ask_before_edit / auto / plan 三模式风险评估。
- **源(Python)**：`agent/permissions/policy.py`（`PermissionPolicy`）。
- **目标(TS)**：`packages/core/src/permissions/policy.ts`。
- **依赖**：MIG-CTRL-015
- **设计**：plan 模式只读+ask_user+propose_plan；auto schema/path/timezone/protected 校验；ask_before_edit 危险先问。
- **风险/复杂度**：M。
- **验证**：移植 policy 三模式单测。**验收**：模式语义一致。
- **状态**：todo · PR: —

### MIG-CTRL-017 · PermissionPipeline + Manager（默认审批 + 低风险白名单 + plan token）

- **功能点**：run_command 默认审批、低风险白名单免批、高风险路由、plan token、PE-13。
- **源(Python)**：`agent/permissions/pipeline.py`（`PermissionPipeline`、`_assess_ask_before_edit` 默认审批 + `is_low_risk_command` 免批 + 高风险路由 + plan token）、`permissions/manager.py`（`PermissionManager` 在 plan token 前先评估高风险）。
- **目标(TS)**：`packages/core/src/permissions/pipeline.ts`、`permissions/manager.ts`。
- **依赖**：MIG-CTRL-016、MIG-TOOL-005、MIG-CTRL-009
- **设计**：run_command 在 ask_before_edit 默认 `_approval`，仅 `is_low_risk_command` 免批；**高风险即便已批准计划仍需审批（PE-13）**；规则名 `ask.run_command.low_risk_allowlist`/`ask.run_command.default_approval` 逐字。
- **风险/复杂度**：L（安全核心）。
- **验证**：移植 `test_permissions.py`、`test_permission_pipeline_v2.py`、`test_plan_command_permissions.py`。**验收**：放行/审批逐例一致，PE-13 守住。
- **状态**：todo · PR: —
