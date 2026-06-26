# W12 · 外部桥 / Watchlist（EXT）

依赖：W14、W09　|　子系统映射：`agent/external/*`、`agent/watchlist/*`。

### MIG-EXT-001 · External 模型 + Adapter 抽象

- **功能点**：统一外部消息模型、adapter 抽象接口。
- **源(Python)**：`agent/external/models.py`（`ExternalInbound`/`ExternalOutbound`/`ExternalAttachment`/`ExternalDeliveryResult`/`_new_id`）、`external/adapter.py`（`ExternalAdapter` ABC）。
- **目标(TS)**：`packages/core/src/external/models.ts`、`external/adapter.ts`。
- **依赖**：MIG-FND-004
- **设计**：只做通用 adapter 抽象，不内置飞书/Slack/Telegram；出站仅保留 `send()` 接口与 outbox 状态，不暴露模型可调用的发送工具。
- **风险/复杂度**：S。
- **验证**：vitest：模型/抽象。**验收**：模型字段一致。
- **状态**：todo · PR: —

### MIG-EXT-002 · External durable store

- **功能点**：`state.json` 持 seen/pending/outbox/最近错误，腐坏备份。
- **源(Python)**：`agent/external/store.py`（`ExternalBridgeStore`/`ExternalBridgeState`/`_inbound_from_dict`）。
- **目标(TS)**：`packages/core/src/external/store.ts`。
- **依赖**：MIG-FND-002
- **设计**：固定写 `memory/external/state.json`；腐坏→`state.json.corrupt-*` 并进 diagnostics，不静默丢。**磁盘兼容**：state schema 不变。
- **风险/复杂度**：S。
- **验证**：移植 external store/腐坏 单测。**验收**：状态读写/隔离一致。
- **状态**：todo · PR: —

### MIG-EXT-003 · ExternalBridgeService（入站去重 + 排队）

- **功能点**：入站去重、忙碌/Ask/Plan 时排队、汇入默认会话、runtime 事件。
- **源(Python)**：`agent/external/service.py`（`ExternalBridgeService`）。
- **目标(TS)**：`packages/core/src/external/service.ts`。
- **依赖**：MIG-EXT-002、MIG-CORE-011、MIG-RTE-001
- **设计**：入站带来源上下文 + 「不可信输入」标记；经 MainlineTurnService 汇入默认会话；记 `external_inbound`/`external_queued`/`external_outbound_*` 事件。
- **风险/复杂度**：M。
- **验证**：移植 external service 去重/排队 单测。**验收**：去重/排队/事件一致。
- **状态**：todo · PR: —

### MIG-EXT-004 · Watchlist（heartbeat + 次模型 skip/run）

- **功能点**：读 `watchlist.md`，次模型先判 skip/run，仅 run 投递主动 turn。
- **源(Python)**：`agent/watchlist/store.py`（`WatchlistStore`）、`watchlist/models.py`（`WatchlistDecision`）、`watchlist/service.py`（`WatchlistService`、`_decision_prompt`/`_parse_decision`）。
- **目标(TS)**：`packages/core/src/watchlist/{store,models,service}.ts`。
- **依赖**：MIG-CORE-001、MIG-SCHED-005
- **设计**：heartbeat 用次模型做 deliverability filter；空清单/不及时→`skip` 只记录；`run`→包成本地主动 `agent_turn`。
- **风险/复杂度**：M。
- **验证**：移植 watchlist 决策/解析 单测。**验收**：skip/run 决策一致。
- **状态**：todo · PR: —
