# W01 · 配置 / 模型路由（CFG）

依赖：W00　|　子系统映射：`agent/local_config.py`、`agent/model_config.py`、`agent/model_router.py`。

### MIG-CFG-001 · 本地偏好 local_config

- **功能点**：`emperor.local.json` 读写、WebUI/桌宠偏好、腐坏隔离、diagnostics。
- **源(Python)**：`agent/local_config.py`（`WebUIPreferences`/`DesktopPetPreferences`/`LocalConfig`、`load/parse/save_local_config`、`merge_webui_overrides`、`local_config_diagnostics`、`_preserve_corrupt_local_config`、`_valid_port`）。
- **目标(TS)**：`packages/core/src/config/local-config.ts`。
- **依赖**：MIG-FND-002
- **设计**：dataclass→interface + zod 校验。**无 server 后**：WebUI host/port 偏好语义弱化（仅桌面窗口/桌宠偏好保留），但**保留 JSON schema 字段读旧**避免老文件报错。腐坏→备份+默认。
- **风险/复杂度**：S。
- **验证**：移植 local_config 相关单测（端口校验、腐坏隔离、diagnostics）。**验收**：读旧 `emperor.local.json` 不丢字段。
- **状态**：todo · PR: —

### MIG-CFG-002 · model_config 数据模型 + 解析/校验/归一

- **功能点**：模型配置 schema、新旧兼容、校验、deep_merge、legacy `id`→`mainModelId`。
- **源(Python)**：`agent/model_config.py`（`AgentDefaults`/`ProviderConfig`/`ModelEntry`/`ModelConfig`、`parse_model_config`、`_parse_entry`、`validate_complete_model_entries`、`_normalized_raw`、`_deep_merge`、`_dedupe_entry_names`、`_resolve_provider_name`）。
- **目标(TS)**：`packages/core/src/config/model-config.ts`（types + `parseModelConfig`）。
- **依赖**：MIG-FND-002
- **设计**：entry 同时持 `mainModelId`/`secondaryModelId`；legacy `id` 仅作 main 兼容读。**磁盘兼容**：字段名、嵌套 `models[]/agents.defaults/providers.*` 一字不差。校验「保存时必须补齐 secondaryModelId」。
- **风险/复杂度**：M。
- **验证**：移植 model_config 解析/校验/兼容 单测。**验收**：读旧 `model_config.json` 等价解析。
- **状态**：todo · PR: —

### MIG-CFG-003 · model_config IO + 脱敏

- **功能点**：ensure/load/save、`mark_entry_vision`、返回脱敏 key、`***` 占位还原。
- **源(Python)**：`agent/model_config.py`（`ensure_model_config`/`ensure_example_config`/`load_model_config`/`save_model_config`/`mark_entry_vision`、脱敏与占位还原逻辑）。
- **目标(TS)**：`packages/core/src/config/model-config-io.ts`。
- **依赖**：MIG-CFG-002
- **设计**：`/api/model-config` 等价的 IPC 返回脱敏（`***xxxx`）；保存时收到占位 → 还原旧值。`model-test` 视觉通过 → 回写 `supportsVision=true`。
- **风险/复杂度**：M（脱敏/还原是常见 bug 源，见排查清单 §11.6）。
- **验证**：移植脱敏/还原/vision 回写 单测。**验收**：占位保存不丢真实 key。
- **状态**：todo · PR: —

### MIG-CFG-004 · 模型路由 ModelRouter

- **功能点**：main/secondary 路由 + fallback + route_reason + 粗 token 估算。
- **源(Python)**：`agent/model_router.py`（`ModelRoute`/`ModelRouter`、`_rough_token_estimate`）。
- **目标(TS)**：`packages/core/src/model/router.ts`。
- **依赖**：MIG-CFG-002
- **设计**：main_agent/memory/subagent/team 角色→主或次模型；次模型缺失/失败降级主一次并记 `model_role` 与 fallback 原因；`route_reason` 写入 token 账本/model_call 历史（见 W14/W06）。
- **风险/复杂度**：M。
- **验证**：移植 model_router 路由/fallback 单测。**验收**：各角色路由与 fallback 与 Python 一致。
- **状态**：todo · PR: —
