# W09 · 调度器（SCHED）

依赖：W14、W07　|　子系统映射：`agent/scheduler/*` + `agent/web/services/scheduler_executor.py`。

### MIG-SCHED-001 · 调度模型 + 校验

- **功能点**：job/schedule/payload/run record 模型、id 校验、`compute_next_run_ms`、`validate_schedule`。
- **源(Python)**：`agent/scheduler/models.py`（`SchedulerJob`/`SchedulerSchedule`/`SchedulerPayload`/`SchedulerRunRecord`/`SchedulerJobState`/`SchedulerStatus`/`now_ms`/`new_job_id`/`validate_job_id`）、`scheduler/service.py`（`compute_next_run_ms`/`validate_schedule`）。
- **目标(TS)**：`packages/core/src/scheduler/models.ts`。
- **依赖**：MIG-FND-004
- **设计**：at(一次性 ISO)/every_seconds(间隔)/cron_expr(+tz)；下次运行计算用 `croner`；payload 类型 agent_turn/team_wake/system_event。**磁盘兼容**：job JSON 不变。
- **风险/复杂度**：M（cron/tz 计算口径）。
- **验证**：移植 scheduler 模型/next-run/校验 单测。**验收**：next_run 与 Python 一致（含 tz）。
- **状态**：todo · PR: —

### MIG-SCHED-002 · SchedulerStore（持久 + filelock + action log 腐坏隔离）

- **功能点**：jobs 持久化、action log 合并、坏行隔离。
- **源(Python)**：`agent/scheduler/store.py`（`SchedulerStore`/`SchedulerStoreData`/`SchedulerStoreCorrupt`）。
- **目标(TS)**：`packages/core/src/scheduler/store.ts`。
- **依赖**：MIG-FND-002,003
- **设计**：action log 合并隔离坏行/未知 action 到 `memory/scheduler/action.corrupt-*.jsonl`，合法继续；filelock 串行化。**磁盘兼容**：store JSON + action log 不变。
- **风险/复杂度**：M。
- **验证**：移植 scheduler store/腐坏隔离 单测。**验收**：合并/隔离一致。
- **状态**：todo · PR: —

### MIG-SCHED-003 · SchedulerService（timer 中枢 + 受保护任务）

- **功能点**：恢复 timer、触发、受保护系统任务。
- **源(Python)**：`agent/scheduler/service.py`（`SchedulerService`）、`scheduler/system_jobs.py`（`default_system_jobs`/`is_system_job`）。
- **目标(TS)**：`packages/core/src/scheduler/service.ts`。
- **依赖**：MIG-SCHED-001,002
- **设计**：启动恢复 timer；受保护任务 `memory-maintenance`/`runtime-maintenance`/`team-stale-recovery`/`token-ledger-maintenance`/`watchlist-check` 可见/可运行/可暂停但不可删；周期任务 7 天过期。
- **风险/复杂度**：M。
- **验证**：移植 service/system_jobs 单测。**验收**：恢复/受保护语义一致。
- **状态**：todo · PR: —

### MIG-SCHED-004 · SchedulerTool

- **功能点**：`scheduler(action=list|add|update|remove|pause|resume|run)`。
- **源(Python)**：`agent/scheduler/tools.py`（`SchedulerTool`、`in_scheduler_run`/`set_scheduler_run`、`_parse_datetime_ms`）。
- **目标(TS)**：`packages/core/src/scheduler/tool.ts`。
- **依赖**：MIG-SCHED-003、MIG-TOOL-001
- **设计**：plan 模式只允许 list；执行时设 scheduler context 禁止递归建 job。
- **风险/复杂度**：M。
- **验证**：移植 scheduler tool 单测。**验收**：动作/递归禁止一致。
- **状态**：todo · PR: —

### MIG-SCHED-005 · Scheduler executor（投递 agent_turn / team_wake）

- **功能点**：把 job payload 投递到本地主动 turn 或 Team wake。
- **源(Python)**：`agent/web/services/scheduler_executor.py`、`scheduler_service.py`。
- **目标(TS)**：`packages/core/src/scheduler/executor.ts`。
- **依赖**：MIG-SCHED-003、MIG-CORE-011、MIG-TEAM-*
- **设计**：`agent_turn` 默认写 history/runtime，`deliver=false` 后台不插当前 timeline；`team_wake` 走 TeamManager；`system_event` 仅系统注册。
- **风险/复杂度**：M。
- **验证**：移植 executor 投递单测。**验收**：三类 payload 投递一致。
- **状态**：todo · PR: —
