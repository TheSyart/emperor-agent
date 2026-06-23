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
- 下一步要补“批准权限增量”：Claude Code 支持 `allowedPrompts` 这种按语义授权一类 Bash 操作。Emperor 可以先做更保守版本：PlanStep.commands 是唯一自动可验证命令，其他写/危险命令仍走权限 pipeline。

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

目标文件：

- `agent/control/tools.py`
- `agent/control/manager.py`
- `agent/plans/models.py`
- `tests/unit/test_plan_quality_gate.py`

门禁：

- 每个 step 必须有目标、相关文件或探索依据、验收方式。
- 至少一个最终 verification command 或 manual verification。
- 高风险 step 必须有 rollback 或 risk note。
- 不允许只有泛泛描述，如“优化代码”“修复问题”。

验收：

- 低质量计划返回工具错误，要求模型修订。
- 高质量计划保存为 waiting_approval。

### PE-5：批准后权限与命令白名单

目标：批准计划不等于无限授权，只对计划内动作提供更顺滑的执行路径。

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

### PE-6：Step Evidence 强制一致性

目标：消除“todo 完成但 step 没有真实证据”的漏洞。

目标文件：

- `agent/tools/todo.py`
- `agent/runner.py`
- `agent/control/manager.py`
- `tests/unit/test_plan_evidence_gate.py`

行为：

- `update_todos` 标完成 active step 时，如果 step 要求 verification 且无 evidence，返回可修复错误。
- Runner 可以在检测到刚运行过匹配命令后允许完成。
- 完成 evidence 必须记录来源 tool、exit code、summary、timestamp。

验收：

- 未运行验证时不能完成 required verification step。
- 验证失败不能完成 step。
- 手动 evidence 必须说明原因和来源。

### PE-7：独立验证子代理

目标：对非平凡项目改动引入对抗式复核。

目标文件：

- `agent/subagents/registry.py`
- `agent/tasks/*`
- `agent/runner.py`
- `agent/control/manager.py`

触发条件：

- 3+ 文件变更。
- 后端/API/权限/调度/长期任务变更。
- 数据迁移、删除、部署、外部发送能力。

验收：

- 非平凡计划完成后，最终答复前必须有 reviewer/verification task 结果或明确用户豁免。
- verification FAIL 会生成修复 follow-up。
- verification PASS 仍要求主 Agent spot check 关键命令。

### PE-8：Plan Runtime 恢复附件

目标：压缩、刷新、重启后不丢正在执行的计划边界。

目标文件：

- `agent/context_pipeline/*`
- `agent/compactor.py`
- `agent/memory.py`
- `agent/runtime/events.py`

附件内容：

- active plan id/title/status。
- active step、pending steps、failed steps。
- 最新 verification evidence。
- open questions / blocked reason。
- 最近相关文件和 artifact refs。

验收：

- 压缩后模型仍能继续 active step。
- 重启后 WebUI 能恢复 PlanCard 和 step evidence。
- 历史摘要不会把 failed verification 写成 passed。

### PE-9：WebUI Project Execution 面板

目标：让用户能直接看到计划执行状态，而不是只从聊天日志推断。

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

## 升级优先级

优先做：

1. `PE-4 结构化计划质量门禁`：提高批准前计划质量。
2. `PE-6 Step Evidence Gate`：堵住“没验证就完成”的口子。
3. `PE-8 Plan Runtime 恢复附件`：保证长任务压缩后不断线。
4. `PE-3 只读探索扇出`：把探索发现自动写入 plan draft。

暂缓做：

- 远程 `/ultraplan` 类能力：先把本地计划执行闭环做稳。
- Anthropic 专属 auto classifier / allowedPrompts 细节：Emperor 是多 provider，先做 provider-neutral 的权限语义。
- React/Ink 计划 UI：继续用 Vue/Electron 投影。
