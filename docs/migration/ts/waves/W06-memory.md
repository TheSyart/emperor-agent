# W06 · 记忆 / 压缩（MEM）

依赖：W03　|　子系统映射：`agent/memory.py`、`agent/memory_versions.py`、`agent/compactor.py`、token 账本。

### MIG-MEM-001 · MemoryStore + HistoryLog + checkpoint

- **功能点**：长期记忆读写、历史 jsonl 热段、checkpoint 恢复。
- **源(Python)**：`agent/memory.py`（`MemoryStore`、HistoryLog 热段/归档、`_json_safe`）。
- **目标(TS)**：`packages/core/src/memory/store.ts`。
- **依赖**：MIG-FND-007
- **设计**：`MEMORY.local.md` 读、`history.jsonl` 热段、checkpoint 写/清/恢复。**磁盘兼容**：行 schema + checkpoint JSON 不变。**不变量**：tool_calls↔tool_result 配对（checkpoint 时机）。
- **风险/复杂度**：M。
- **验证**：移植 memory/history/checkpoint 单测。**验收**：读旧 history 一致、checkpoint 恢复一致。
- **状态**：todo · PR: —

### MIG-MEM-002 · 记忆版本快照 / diff / restore

- **功能点**：记忆快照、diff 预览、恢复。
- **源(Python)**：`agent/memory_versions.py`（`MemoryVersion`、`MemoryVersionStore`、`_atomic_write_text`）。
- **目标(TS)**：`packages/core/src/memory/versions.ts`。
- **依赖**：MIG-FND-002
- **设计**：`memory/versions/` 快照；diff 算法；restore。**磁盘兼容**：版本目录结构不变。
- **风险/复杂度**：M。
- **验证**：移植 memory_versions 单测（快照/diff/restore/原子写）。**验收**：版本读写一致。
- **状态**：todo · PR: —

### MIG-MEM-003 · Compactor（历史压缩）

- **功能点**：历史压缩、解析压缩结果 XML、更新记忆文件。
- **源(Python)**：`agent/compactor.py`（`Compactor`、`parse_compaction_result`、`CompactionResult`、`_messages_to_text`/`_content_blocks_to_text`、`CompactionParseError`）、`templates/agent/compact_prompt.md`。
- **目标(TS)**：`packages/core/src/memory/compactor.ts`。
- **依赖**：MIG-MEM-001、MIG-CORE-001
- **设计**：压缩 `history[:-K]`(K=10)，更新 `memory/YYYY-MM-DD.md`/`MEMORY.local.md`/`USER.local.md`；压缩成功后归档原始行再原子重写热 jsonl；XML 标签解析逐字（见排查清单 §11.4）。
- **风险/复杂度**：M。
- **验证**：移植 compactor 解析/压缩 单测 + `memory/compact_diagnostics.jsonl` 行为。**验收**：解析/落盘/归档一致。
- **状态**：todo · PR: —

### MIG-MEM-004 · TokenTracker + context_usage

- **功能点**：token 账本、`should_compact` 阈值、context_usage 估算与事件。
- **源(Python)**：runner/loop 中 `TokenTracker.should_compact(max_context, threshold=0.7)`、token 账本（`route_reason`/`model_role`）。
- **目标(TS)**：`packages/core/src/memory/token-tracker.ts`。
- **依赖**：MIG-CFG-004、MIG-FND-001
- **设计**：阈值 0.7、压缩触发；账本记 `model_role=main|secondary|unknown`、fallback 原因；token 估算口径**记风险**（tokenizer 选型见 README）。
- **风险/复杂度**：M（tokenizer 口径差异）。
- **验证**：移植 token tracker 单测；与 Python 估算做容差对账。**验收**：触发时机一致（容差内）。
- **状态**：todo · PR: —
