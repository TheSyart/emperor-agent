# W03 · Agent 核心（CORE）

依赖：W02、W04　|　子系统映射：`agent/loop.py`、`agent/runner.py`、`agent/runner_factory.py`、`agent/runner_model.py`、`agent/query_state/*`、`agent/context_pipeline/*`、`agent/context.py`。
这是整个迁移的心脏；务必逐字保真回合状态机、上下文治理与恢复策略，用 `tests/unit/test_runner_*`、`test_context_pipeline.py`、`test_query_state.py` 对账。

### MIG-CORE-001 · ModelCaller（流式 + 次模型降级）

- **功能点**：统一模型调用、流式 delta、次模型失败升主一次。
- **源(Python)**：`agent/runner_model.py`（`ModelCaller`）。
- **目标(TS)**：`packages/core/src/agent/model-caller.ts`。
- **依赖**：MIG-PROV-006、MIG-CFG-004
- **设计**：封装 provider.chat/chatStream；token 账本与 `model_call` 历史记 `route_reason`/估算输入/fallback。
- **风险/复杂度**：M。
- **验证**：移植 model caller/fallback 单测。**验收**：流式与降级路径一致。
- **状态**：todo · PR: —

### MIG-CORE-002 · context_pipeline：tool_call 配对

- **功能点**：修复/补全 tool_call↔tool_result 配对，丢孤儿 tool 消息。
- **源(Python)**：`agent/context_pipeline/pairing.py:pair_tool_calls`。
- **目标(TS)**：`packages/core/src/context/pairing.ts`。
- **依赖**：MIG-FND-001
- **设计**：返回 `[cleaned, filled, dropped]`；缺失 tool result 回填 `(tool execution interrupted)`；孤儿 tool 消息丢弃。**不变量**：输出逐字等同（见现有契约测试）。
- **风险/复杂度**：S。
- **验证**：移植 `tests/unit/test_runner_behavior_contract.py`(pair 部分)、`test_context_pipeline.py`。**验收**：相同输入输出一致。
- **状态**：todo · PR: —

### MIG-CORE-003 · context_pipeline：工具结果截断/摘要

- **功能点**：单条结果硬截断（头尾保留）、旧大结果摘要化。
- **源(Python)**：`agent/context_pipeline/tool_results.py`（`cap_tool_results` per_call_limit=8000、`shrink_old_tool_results` keep_recent=10、`DEFAULT_*`）。
- **目标(TS)**：`packages/core/src/context/tool-results.ts`。
- **依赖**：MIG-FND-001
- **设计**：截断保留头 + 尾 + `...truncated, total N chars...`；旧结果 `[shrunk] {name} → {N} chars omitted`。阈值/文案逐字保真。
- **风险/复杂度**：S。
- **验证**：移植 `test_runner_behavior_contract.py`(cap/shrink) + `test_context_pipeline.py`。**验收**：文案/阈值一致。
- **状态**：todo · PR: —

### MIG-CORE-004 · context_pipeline：microcompact

- **功能点**：超阈值时对更早历史做微压缩。
- **源(Python)**：`agent/context_pipeline/microcompact.py`（`DEFAULT_MICROCOMPACT_KEEP_RECENT`、cutoff 逻辑）。
- **目标(TS)**：`packages/core/src/context/microcompact.ts`。
- **依赖**：MIG-CORE-003
- **设计**：keep_recent 截点逻辑逐字搬。
- **风险/复杂度**：S。
- **验证**：移植 microcompact 单测。**验收**：截点一致。
- **状态**：todo · PR: —

### MIG-CORE-005 · ContextPipeline.project 编排 + ToolResultStore

- **功能点**：把 pairing→cap→shrink→microcompact 串成投影流水线。
- **源(Python)**：`agent/context_pipeline/pipeline.py`（`ContextPipeline`，`per_call_limit/keep_recent/...` 默认）、`models.py`、`ToolResultStore`。
- **目标(TS)**：`packages/core/src/context/pipeline.ts`。
- **依赖**：MIG-CORE-002,003,004
- **设计**：`project(history)` 返回 governed messages + 计数；ToolResultStore 保留被摘要原文。
- **风险/复杂度**：M。
- **验证**：移植 pipeline 端到端单测。**验收**：投影结果与 Python 一致。
- **状态**：todo · PR: —

### MIG-CORE-006 · 系统提示词构建 ContextBuilder

- **功能点**：bootstrap(SOUL/TOOL/USER)+identity+memory+skills 拼装，固定段 <7000 字符。
- **源(Python)**：`agent/context.py`（`ContextBuilder.build_system_prompt`/`build_sections`）、`templates/*`、`templates/agent/identity.md`、`skills_section.md`。
- **目标(TS)**：`packages/core/src/agent/context-builder.ts` + 模板随包打入 `apps/desktop` 资源。
- **依赖**：MIG-FND-001、MIG-CORE-009(memory 注入可后接)
- **设计**：jinja→TS 模板（如 eta/手写插值，仅 `{{workspace}}`/`{{subagents_summary}}`/`{{skills_summary}}` 三个变量）；段优先级与 `\n\n---\n\n` 连接、<7000 预算逐字保真。
- **风险/复杂度**：M。
- **验证**：移植 `tests/unit/test_agent_prompt_contracts.py`（短语命中 + 预算）。**验收**：契约短语全命中、预算达标。
- **状态**：todo · PR: —

### MIG-CORE-007 · query_state 恢复状态机

- **功能点**：空响应重试、length 续写的状态转移。
- **源(Python)**：`agent/query_state/*`（`TransitionReason`/`QueryState`/`QueryTransition`、`empty_response_retry`、`length_recovery`）。
- **目标(TS)**：`packages/core/src/agent/query-state.ts`。
- **依赖**：MIG-FND-001
- **设计**：空响应最多 2 次注入 nudge；`finish_reason=length/max_tokens` 最多 3 次续写。阈值逐字保真。
- **风险/复杂度**：M。
- **验证**：移植 `tests/unit/test_query_state.py`。**验收**：转移与上限一致。
- **状态**：todo · PR: —

### MIG-CORE-008 · AgentRunner 回合状态机

- **功能点**：单轮执行、工具循环、并发执行、plan guard / ask guard、暂停/checkpoint。
- **源(Python)**：`agent/runner.py`（`AgentRunner.step_async`、`_execute_tool_calls`、`_plan_guard_blocks_tool`、`_ask_guard_blocks_tool`、`_assess_plan_decision`、并发判定、`TurnPaused`）。
- **目标(TS)**：`packages/core/src/agent/runner.ts`。
- **依赖**：MIG-CORE-001,005,007、MIG-TOOL-003、MIG-CTRL-*（接口先用占位，W05 接入）
- **设计**：`read_only && !exclusive` 工具并发；plan guard 在权限前拦截非只读工具（含 executing-plan 豁免，由 W05 注入决策）；ask guard；回合前/工具批次后写 checkpoint，配对保证。**不变量**：INV-001（tool_use↔tool_result 配对）、INV-002（高影响命令审批）。
- **风险/复杂度**：L（核心状态机，分支最多）。
- **验证**：移植 `tests/unit/test_runner_*`、`test_plan_guard_execution.py`、并发相关。**验收**：回合行为逐项对账通过。
- **状态**：todo · PR: —

### MIG-CORE-009 · AgentRunner 错误恢复接线

- **功能点**：把 query_state 接进 runner（空响应 nudge、length 续写）。
- **源(Python)**：`agent/runner.py` 调用 query_state 的路径。
- **目标(TS)**：`runner.ts` 内恢复分支。
- **依赖**：MIG-CORE-007,008
- **设计**：恢复上限与 nudge 文案逐字保真。
- **风险/复杂度**：M。
- **验证**：移植空响应/截断恢复单测。**验收**：恢复路径一致。
- **状态**：todo · PR: —

### MIG-CORE-010 · runner_factory（路由化 runner 构造）

- **功能点**：为子代理/Team 构造带模型路由的 runner。
- **源(Python)**：`agent/runner_factory.py:build_routed_runner`。
- **目标(TS)**：`packages/core/src/agent/runner-factory.ts`。
- **依赖**：MIG-CORE-008、MIG-CFG-004
- **设计**：按角色选主/次模型构造 runner（子代理/Team 复用）。
- **风险/复杂度**：M。
- **验证**：移植 factory 单测 + W08/W10 集成。**验收**：角色 runner 构造正确。
- **状态**：todo · PR: —

### MIG-CORE-011 · AgentLoop 装配根

- **功能点**：系统装配（memory/tools/subagents/runner/scheduler/team/sessions 接线）、活跃会话绑定。
- **源(Python)**：`agent/loop.py`（`AgentLoop`）。
- **目标(TS)**：`packages/core/src/agent/loop.ts`（核心组合根；`apps/desktop` 主进程实例化它）。
- **依赖**：几乎所有核心波次（W04/W05/W06/W07…）—— 末期接线
- **设计**：注册内建工具、绑定会话、构建系统提示词、装配各子系统。**注意**：原 loop.py 在 W15 之前用占位 IPC，W15 完成后接真实 IPC。
- **风险/复杂度**：L（装配面广）。
- **验证**：核心 smoke：建 loop、发一条消息、工具循环跑通（移植 `test_project_execution_smoke.py` 思路）。**验收**：进程内核心可独立驱动一个回合。
- **状态**：todo · PR: —
