# W02 · Providers（PROV）

依赖：W01　|　子系统映射：`agent/providers/*`。

### MIG-PROV-001 · LLMProvider 基类 + 类型 + 工具/消息转换

- **功能点**：provider 抽象、响应/请求类型、openai↔anthropic 工具转换、JSON 参数修复。
- **源(Python)**：`agent/providers/base.py`（`LLMProvider`、`LLMResponse`、`ToolCallRequest`、`GenerationSettings`、`DEFAULT_MAX_RETRIES`、`is_truncated`/`TRUNCATED_FINISH_REASONS`、`openai_tools_to_anthropic`/`anthropic_tools_to_openai`、`parse_json_args`+json_repair）。
- **目标(TS)**：`packages/core/src/providers/base.ts`（`interface LLMProvider`、类型、转换工具）。
- **依赖**：MIG-FND-001
- **设计**：`chat()`/`chatStream(onDelta)` 统一签名；`DEFAULT_MAX_RETRIES=2`；`parseJsonArgs` 用容错 JSON（如 `jsonrepair`）。**不变量**：finish_reason 截断集合、工具 schema 双向转换字段一致。
- **风险/复杂度**：M。
- **验证**：移植 base 的转换/截断/json 修复 相关断言。**验收**：转换与 Python 等价。
- **状态**：todo · PR: —

### MIG-PROV-002 · Provider Spec 注册表

- **功能点**：provider 规格（backend、default_api_base、thinking_style、strip_model_prefix、supports_max_completion_tokens 等）+ `find_by_name`。
- **源(Python)**：`agent/providers/registry.py`（`ProviderSpec`、`find_by_name`）。
- **目标(TS)**：`packages/core/src/providers/registry.ts`。
- **依赖**：MIG-PROV-001
- **设计**：内置 spec 表逐条搬；`require_provider_spec` 抛未知 provider。
- **风险/复杂度**：S。
- **验证**：移植 registry 查找/spec 字段断言。**验收**：spec 表与 Python 一致。
- **状态**：todo · PR: —

### MIG-PROV-003 · OpenAI-compat provider（含 Azure/Codex/Copilot 子类）

- **功能点**：OpenAI 兼容 chat/stream、消息净化、reasoning 处理、usage（含缓存命中）解析、stream usage 回退。
- **源(Python)**：`agent/providers/openai_compat.py`（`OpenAICompatProvider._kwargs`/`chat`/`chat_stream`/`_sanitize_messages`/`_requires_reasoning_backfill`/`_extra_body_for_reasoning`/`_parse_usage`/`_stream_usage_unsupported`/`_message_reasoning_content`；`AzureOpenAIProvider`/`OpenAICodexProvider`/`GitHubCopilotProvider`）。
- **目标(TS)**：`packages/core/src/providers/openai-compat.ts`（+ 子类）。
- **依赖**：MIG-PROV-002
- **设计**：用 `openai` SDK，`maxRetries=2`，自定义 httpx→fetch 超时(600s/connect30)。`temperature` 禁用判定（gpt-5/o1/o3/o4 + reasoning）、`max_completion_tokens` vs `max_tokens`、`reasoning_effort`、`extra_body`(thinking_type/enable_thinking/reasoning_split)、deepseek reasoning backfill 全部逐字对齐。usage 解析含 `prompt_tokens_details.cached_tokens`/`cache_creation_*`。stream 不支持 `stream_options` 时去掉重试。
- **风险/复杂度**：L（分支多、各家兼容差异）。
- **验证**：移植 openai_compat 相关单测（usage 解析、温度禁用、reasoning backfill、stream 回退）。**验收**：请求体与 usage 解析与 Python 一致。
- **状态**：todo · PR: —

### MIG-PROV-004 · Anthropic provider（缓存 + 重试）

- **功能点**：见 [TASK_TEMPLATE.md](../TASK_TEMPLATE.md) 的填写示例（system+tools ephemeral cache_control 端点门控、maxRetries、消息块转换、usage cache 字段）。
- **源(Python)**：`agent/providers/anthropic_provider.py`。
- **目标(TS)**：`packages/core/src/providers/anthropic.ts`。
- **依赖**：MIG-PROV-001
- **设计**：见示例；额外注意 thinking/redacted_thinking 块在 assistant 消息与流式增量的对齐、`_merge_roles`/`_append_tool_result` 规则。
- **风险/复杂度**：M。
- **验证**：移植 `tests/unit/test_anthropic_prompt_caching.py` + `test_providers.py`(Anthropic 部分)。**验收**：缓存门控/请求体一致。
- **状态**：todo · PR: —

### MIG-PROV-005 · Bedrock provider（system 透传 + 拒 tools + 重试）

- **功能点**：Converse 调用、system 透传、工具拒绝清晰报错、retries。
- **源(Python)**：`agent/providers/bedrock_provider.py`（`chat`、`_converse_request`、`_system_text`、`_messages`、boto3 `Config(retries=...)`）。
- **目标(TS)**：`packages/core/src/providers/bedrock.ts`（`@aws-sdk/client-bedrock-runtime` ConverseCommand）。
- **依赖**：MIG-PROV-001
- **设计**：`_converse_request` 携带 `system:[{text}]`；带 tools 抛清晰错误「主回合不支持 Bedrock」；AWS SDK v3 `maxAttempts`/`retryMode='standard'`。
- **风险/复杂度**：M。
- **验证**：移植 `test_providers.py`(Bedrock 部分：system 透传、拒 tools)。**验收**：与 Python 一致。
- **状态**：todo · PR: —

### MIG-PROV-006 · Provider 工厂 + snapshot/凭证解析

- **功能点**：按 backend 造 provider；激活 entry/凭证/角色模型/快照构造。
- **源(Python)**：`agent/providers/factory.py`（`create_provider`、`ProviderSnapshot`）+ `agent/model_config.py`（`build_provider_snapshot`、`_resolve_active_entry`、`_resolve_credentials`、`_entry_model_for_role`、`_fallback_spec`、`_synth_entry_from_legacy`）。
- **目标(TS)**：`packages/core/src/providers/factory.ts`、`config/provider-snapshot.ts`。
- **依赖**：MIG-PROV-003,004,005、MIG-CFG-002
- **设计**：backend switch（anthropic/azure_openai/bedrock/openai_codex/github_copilot/默认 openai_compat）；snapshot 持 provider+model+generation+context_window+vision+route_reason。
- **风险/复杂度**：M。
- **验证**：移植 snapshot/凭证解析 单测。**验收**：各 backend 构造与角色模型解析一致。
- **状态**：todo · PR: —
