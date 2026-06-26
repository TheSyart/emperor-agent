# W10 · Agent Team（TEAM）

依赖：W03、W05　|　子系统映射：`agent/team/*`。

### MIG-TEAM-001 · Team 模型 + 校验 + 事件

- **功能点**：成员/消息模型、状态、id/名校验、team_* 事件工厂。
- **源(Python)**：`agent/team/models.py`（`TeamMember`/`TeamMessage`/`TeamStatus`/`now_ts`/`new_id`/`validate_member_name`/`validate_actor_name`）、`team/events.py`（`member_update`/`message_event`/`run_*`）。
- **目标(TS)**：`packages/core/src/team/models.ts`、`team/events.ts`。
- **依赖**：MIG-FND-004、MIG-FND-005
- **设计**：事件字段（member_update/message/run_start/delta/tool_call/tool_result/tool_error/done/error）逐字。
- **风险/复杂度**：S。
- **验证**：移植 team 模型/事件 单测。**验收**：事件 schema 一致。
- **状态**：todo · PR: —

### MIG-TEAM-002 · TeamStore + MessageBus（inbox 总线）

- **功能点**：roster、append-only inbox、thread 上下文持久。
- **源(Python)**：`agent/team/store.py`（`TeamStore`）、`team/bus.py`（`MessageBus`）。
- **目标(TS)**：`packages/core/src/team/store.ts`、`team/bus.ts`。
- **依赖**：MIG-FND-007
- **设计**：`.team/config.json` roster、`.team/inbox/*.jsonl` append-only、`.team/threads/*.json` 上下文。**磁盘兼容**：`.team/` 布局不变。
- **风险/复杂度**：M。
- **验证**：移植 team store/bus 单测。**验收**：roster/inbox/thread 读写一致。
- **状态**：todo · PR: —

### MIG-TEAM-003 · TeamManager（按消息唤醒 + stale 恢复）

- **功能点**：spawn/wake、按消息驱动一次、stale working→offline。
- **源(Python)**：`agent/team/manager.py`（`TeamManager`、`role_to_agent_type`）。
- **目标(TS)**：`packages/core/src/team/manager.ts`。
- **依赖**：MIG-TEAM-002、MIG-CORE-010
- **设计**：v1 按消息唤醒（`send_message(wake=true)`/`broadcast(wake=true)`），不常驻轮询；启动 stale `working`→`offline`，下次 wake 恢复；Team runner 经 ModelRouter 选主/次（reader/reviewer/researcher/runner→次，coder→主）。
- **风险/复杂度**：L。
- **验证**：移植 team manager 单测。**验收**：唤醒/恢复/路由一致。
- **状态**：todo · PR: —

### MIG-TEAM-004 · Team 工具（6 个）

- **功能点**：spawn/list/send/read_inbox/broadcast/shutdown。
- **源(Python)**：`agent/team/tools.py`（`_TeamTool` + `TeamSpawnTool`/`TeamListTool`/`TeamSendMessageTool`/`TeamReadInboxTool`/`TeamBroadcastTool`/`TeamShutdownTool`）。
- **目标(TS)**：`packages/core/src/team/tools.ts`。
- **依赖**：MIG-TEAM-003、MIG-TOOL-001
- **设计**：teammate 仅用自身白名单工具 + send/read_inbox，不能再派子代理/建队友；Lead 可 wake，teammate 不递归 wake。
- **风险/复杂度**：M。
- **验证**：移植 `test_tool_descriptions.py`(team) + team 工具单测。**验收**：工具语义/权限一致。
- **状态**：todo · PR: —
