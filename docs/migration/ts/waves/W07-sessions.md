# W07 · 会话（SESS）

依赖：W06　|　子系统映射：`agent/sessions/*`。

### MIG-SESS-001 · ConversationStore（按会话持久化）

- **功能点**：按会话存 `history.jsonl` + `_checkpoint.json`，复用 HistoryLog。
- **源(Python)**：`agent/sessions/conversation.py`（`ConversationStore`、`SessionMemoryStore`、`ProjectSessionMemoryStore`）。
- **目标(TS)**：`packages/core/src/sessions/conversation.ts`。
- **依赖**：MIG-MEM-001
- **设计**：`memory/sessions/<id>/{history.jsonl,_checkpoint.json}`；项目会话记忆分层。**磁盘兼容**：目录布局/文件名不变。
- **风险/复杂度**：M。
- **验证**：移植 conversation store 单测。**验收**：按会话读写一致。
- **状态**：todo · PR: —

### MIG-SESS-002 · SessionStore（注册表 + 腐坏隔离）

- **功能点**：`index.json` 会话注册表 CRUD + 腐坏隔离。
- **源(Python)**：`agent/sessions/store.py`（`SessionStore`）。
- **目标(TS)**：`packages/core/src/sessions/store.ts`。
- **依赖**：MIG-FND-002
- **设计**：CRUD + 单条腐坏隔离不影响其他会话。**磁盘兼容**：index.json schema 不变。
- **风险/复杂度**：S。
- **验证**：移植 session store 单测。**验收**：CRUD/腐坏隔离一致。
- **状态**：todo · PR: —

### MIG-SESS-003 · 首启迁移（旧主线→默认会话）

- **功能点**：首次启动把旧主线 history 迁到默认会话。
- **源(Python)**：`agent/loop.py` 绑定活跃会话 + 首启迁移逻辑。
- **目标(TS)**：`packages/core/src/sessions/migrate.ts`。
- **依赖**：MIG-SESS-001,002
- **设计**：检测旧 `memory/history.jsonl` → 迁到 `sessions/default/`；幂等。
- **风险/复杂度**：M（一次性迁移要幂等且不丢）。
- **验证**：移植首启迁移单测。**验收**：旧数据迁移后可读、重复执行不重复迁。
- **状态**：todo · PR: —

### MIG-SESS-004 · 会话标题服务

- **功能点**：用次模型生成会话标题、清洗、回退。
- **源(Python)**：`agent/sessions/title.py`（`SessionTitleService`、`sanitize_session_title`、`fallback_session_title`、`_truncate_title`、`_visible_len`）。
- **目标(TS)**：`packages/core/src/sessions/title.ts`。
- **依赖**：MIG-CORE-001、MIG-SESS-002
- **设计**：次模型生成 + 禁止前缀剥离 + 长度截断（可见宽度计算，中英混排）逐字。
- **风险/复杂度**：S。
- **验证**：移植 title 清洗/截断/回退 单测。**验收**：标题处理一致。
- **状态**：todo · PR: —
