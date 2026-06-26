# W14 · 运行时事件 / 任务注册 / 项目（RTE）

依赖：W00　|　子系统映射：`agent/runtime/*`、`agent/tasks/*`、`agent/projects/*`。
这一波早做：scheduler/external/plan-execution 都依赖事件与 task store。

### MIG-RTE-001 · 运行时事件工厂

- **功能点**：所有 runtime 事件构造器（带 turn_id）。
- **源(Python)**：`agent/runtime/events.py`（`runtime_event`/`ready_event`/`user_message`/`control_mode_update`/`error`/`model_route_fallback`/`session_*`/`external_*`/`scheduler_*`/`record_degraded` 等）。
- **目标(TS)**：`packages/core/src/runtime/events.ts`。
- **依赖**：MIG-FND-005
- **设计**：事件名与 payload 字段**逐字保真**（前后端协议契约，见 AGENTS.md §6）。`record_degraded` 显式降级事件保留。
- **风险/复杂度**：M（协议契约面广）。
- **验证**：移植 runtime events 单测；与前端 `types.ts` 字段对账。**验收**：事件 schema 一字不差。
- **状态**：todo · PR: —

### MIG-RTE-002 · RuntimeEventStore（冷记录 + 归档 + 重放）

- **功能点**：events.jsonl append、archive 轮转、index、未压缩 turn 重放。
- **源(Python)**：`agent/runtime/store.py`（`RuntimeEventStore`、`_json_safe`）。
- **目标(TS)**：`packages/core/src/runtime/store.ts`。
- **依赖**：MIG-FND-007
- **设计**：按会话 `memory/sessions/<id>/runtime/events.jsonl`；旧事件→`archive/`；`index.json`；只返回未压缩 turn 的事件供 bootstrap 重放。**磁盘兼容**：事件存储布局不变。
- **风险/复杂度**：M。
- **验证**：移植 runtime store/重放 单测。**验收**：冷记录/重放一致。
- **状态**：todo · PR: —

### MIG-RTE-003 · ActiveTaskRegistry（进程内 active task）

- **功能点**：登记 Chat/Scheduler/Watchlist 运行任务，支持取消。
- **源(Python)**：`agent/runtime/active.py`（`ActiveTaskRegistry`/`ActiveTaskInfo`/`_ActiveTask`）。
- **目标(TS)**：`packages/core/src/runtime/active.ts`。
- **依赖**：MIG-FND-005
- **设计**：`/api/runtime/stop`(→IPC) / 停止按钮 / `/stop` 共用取消，发 `runtime_task_cancelled`。
- **风险/复杂度**：S。
- **验证**：移植 active registry 单测。**验收**：登记/取消一致。
- **状态**：todo · PR: —

### MIG-RTE-004 · TaskStore + TaskManager（归档）

- **功能点**：TaskRecord 持久、月度归档、活跃热索引。
- **源(Python)**：`agent/tasks/store.py`（`TaskStore` upsert/list/归档）、`tasks/manager.py`（`TaskManager`）、`tasks/sidechain.py`（`SidechainTranscript`）。
- **目标(TS)**：`packages/core/src/tasks/{store,manager,sidechain}.ts`。
- **依赖**：MIG-FND-002
- **设计**：终态任务按月归档到 `memory/tasks/archive/`，活跃不归档，`list()`/IPC 默认只列热索引；保护 queued/pending/running。**磁盘兼容**：index + archive 布局不变。
- **风险/复杂度**：M。
- **验证**：移植 `test_task_runtime_api.py`(store 部分)、归档单测。**验收**：归档/热索引一致。
- **状态**：todo · PR: —

### MIG-RTE-005 · ProjectStore

- **功能点**：项目索引（build 模式 AGENTS.md / index.json）。
- **源(Python)**：`agent/projects/store.py`（`ProjectStore`）。
- **目标(TS)**：`packages/core/src/projects/store.ts`。
- **依赖**：MIG-FND-002
- **设计**：`memory/projects/index.json` 读写；ContextBuilder 的 project index summary 注入（W03-006 已引用）。
- **风险/复杂度**：S。
- **验证**：移植 project store 单测。**验收**：索引读写一致。
- **状态**：todo · PR: —
