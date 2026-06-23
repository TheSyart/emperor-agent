# 04. Context, Memory, Compaction

Claude Code 的上下文治理不是单点压缩，而是一个多层预算系统。它在“每次模型请求前”和“模型错误后”都有恢复策略。

Emperor Agent 当前已有三层记忆、启动压缩、turn 后压缩、工具结果截断和 checkpoint。升级重点是把这些机制从 runner 内部规则提升为可组合、可观测的 context pipeline。

## Claude Code 上下文治理层级

### 1. Tool Result Budget

位置：`src/utils/toolResultStorage.*`、`src/query.ts`

目标：

- 控制工具结果总量。
- 大结果落盘，模型只看到预览与路径。
- 对不可持久化工具设置无限预算或特殊处理。
- 记录 content replacement，保证 resume 或 sidechain transcript 能复现同样的替换，维护 prompt cache 稳定。

Claude Code 这里有两层预算：

- 单个工具执行完成后，超阈值文本结果先持久化到 `tool-results/{id}.txt/json`，消息里保留预览、路径和恢复提示。
- 每次模型请求前，再按 API 实际合并后的 user message 统计连续 tool_result 总量；超预算时优先替换最大的 fresh 结果，并冻结 replacement 决策。

冻结 replacement 很关键：重启、sidechain 读取、prompt cache 命中都依赖“同一条工具结果被替换成同一段模型可见内容”。如果只是每次请求动态截断，调试和恢复会出现不可解释的上下文漂移。

与 Emperor 对照：

- Emperor 早期 `_cap_tool_result()` 对单条 tool message 做硬截断，`_shrink_old_tool_results()` 对旧工具结果做摘要替换。
- 当前已抽出 `agent/context_pipeline/ContextPipeline`，保留 pairing、cap、shrink 的兼容行为。
- 当前已新增 `ToolResultStore` 并接入 `ContextPipeline(tool_result_store=...)`：大工具结果会落到 `memory/tool-results/`，模型请求投影只保留 preview、artifact path、原始长度和恢复提示。
- `AgentRunner` 默认请求路径已在存在 `memory_store` 时使用 store-backed `ContextPipeline`，并通过 `context_projection` runtime event 暴露 replacement 计数和记录。
- `Tool.max_result_chars` 已进入基类，`ToolRegistry.tool_result_limits()` 会把工具级预算传给 Runner 默认 `ContextPipeline`。
- `read_file`、`grep`、`glob`、`run_command`、`web_fetch` 已有首批模型上下文预算。
- `ToolRegistry.execute_result()`、`ToolExecutionEngine`、`AgentRunner` 和 WebUI runtime 类型已贯通 `ToolResult(model_content, display_summary, raw_content, artifacts, metadata)`：模型上下文使用 `model_content`，runtime summary 使用 `display_summary`，artifact metadata 可被事件 replay 保留。
- 剩余缺口是更多内置工具的原生 artifact-aware result mapping、MCP/外部工具预算标注，以及工具卡片中的 artifact 展示。

升级建议：

- `ToolResultStore`：按 turn/tool_use_id 保存大结果 artifact，并生成稳定 replacement record。
- 工具返回或被 adapter 包装为 `ToolResult(raw_content, model_content, display_summary, artifacts)`。
- `ContextPipeline` 根据全局阈值和工具级 `max_result_chars` 做文件化替换。
- `ToolResultStore` 保存 replacement record：原始 artifact path、预览文本、替换原因、预算版本、是否已冻结。
- Runtime event 使用 `display_summary`，模型消息使用 `model_content`。

### 2. Snip Compact

位置：`src/services/compact/snipCompact.*`

目标：

- 对明显可裁剪的历史片段做快速移除或边界替换。
- 在 autocompact 前先释放 token，避免不必要的大摘要。
- 与 autocompact 协同，向 token warning state 传递 freed tokens。

与 Emperor 对照：

- Emperor 当前只有基于 token tracker 阈值的完整 compactor。
- 没有请求前轻量裁剪阶段。

升级建议：

- 先实现 `HistorySnipPolicy`，只处理低风险内容：
  - 已完成的大型 read/search 工具结果。
  - 旧的重复 model_call 诊断。
  - 已归档 runtime 细节。
- snip 不写长期记忆，只影响本次请求投影。

### 3. Microcompact

位置：`src/services/compact/microCompact.*`

目标：

- 在不做完整会话摘要的情况下，对局部内容做轻量压缩。
- 可配合 prompt cache edit 或 cached microcompact。
- 边界消息可在 API 响应后根据真实 token 删除量再 yield。

与 Emperor 对照：

- Emperor 没有 microcompact 概念。
- 当前压缩由 `Compactor` 调模型生成 episode、memory、user 三块。

升级建议：

- 不急于实现复杂 cached microcompact。
- 先加入 `LocalMicrocompactStage`：把旧工具结果和重复上下文变成稳定短摘要，不调用模型。
- 再加入可选 `ModelMicrocompactStage`：只总结最近 N 个工具密集回合，不写长期记忆。

### 4. Context Collapse

位置：`src/services/contextCollapse/*`

目标：

- 将完整历史投影为折叠视图。
- 折叠信息持久化在独立存储中，而不是直接改 REPL 原始消息数组。
- prompt too long 时可以 drain 已提交折叠，尝试恢复。

本地 Claude Code 源码中，context collapse 的核心实现仍偏占位，但 `query()` 已有接入点，日志类型也预留了 commit/snapshot 语义。这说明它的目标不是“又一次摘要”，而是把原始 transcript 和模型请求视图区分开。

与 Emperor 对照：

- Emperor 的 `HistoryLog.compact()` 会把热 history 归档，热上下文只保留 recent。
- Runtime event store 也有 hot/cold 归档。

升级建议：

- Emperor 不需要立即做 Claude Code 级 context collapse。
- 可先实现“读取时投影”：`ContextViewBuilder` 根据 history、runtime、tool result store、memory 生成模型请求消息。
- 原始 history 继续保持可追溯，投影结果可丢弃。

### 5. Autocompact

位置：`src/services/compact/autoCompact.*`、`src/services/compact/compact.ts`

目标：

- 当上下文接近阈值时自动压缩。
- 输出 compact boundary、summary messages、attachments、hook results。
- 跟踪连续失败，避免压缩失败无限重试。
- 压缩后更新 task budget remaining。

与 Emperor 对照：

- `TokenTracker.should_compact(max_context, threshold=0.7)` 决定是否压缩。
- `Compactor.compact_async(history)` 压缩 `history[:-K]`，保留最近 K 条。
- 压缩写入每日 episode、长期 memory、用户档案。
- `HistoryLog.compact(active_history)` 归档热 history。

升级建议：

- `Compactor` 拆成两个职责：
  - `ConversationCompactor`：生成对话摘要消息，服务于上下文。
  - `MemoryExtractor`：更新长期记忆和用户档案。
- 不要每次上下文压缩都强制更新长期记忆。上下文压缩与记忆提取应解耦。
- 增加 compaction failure state，避免连续失败烧模型调用。
- 压缩摘要应带恢复附件：近期 read_file refs、active task refs、sidechain refs、当前 plan/todos、已用 skills、team 状态摘要。否则压缩成功也可能让 agent 丢掉正在执行的边界。

### 6. Reactive Compact

位置：`src/services/compact/reactiveCompact.*`

目标：

- 当 API 返回 prompt-too-long、media too large 等错误时，不立即失败。
- 尝试紧急压缩、剥离旧媒体、重试请求。
- 对不可恢复错误再暴露给用户。

与 Emperor 对照：

- 当前 `_maybe_compact()` 是成功 turn 后根据 token tracker 触发。
- 对 provider 报 prompt too long 的恢复不够分层。

升级建议：

- 在 `ModelCallPort` 捕获 provider context overflow 错误，返回结构化 `ModelError(kind='context_overflow')`。
- `CompletionPolicy` 对 overflow 调用 `ReactiveContextRecovery`。
- 恢复策略顺序：tool result replacement -> snip -> conversation compact -> media strip -> fail with actionable message。

## Emperor 现状总结

当前优势：

- 三层记忆模型清晰：history、daily episode、long-term memory。
- checkpoint 机制能保存 tool_calls 与 tool_result 成对边界。
- runtime event hot/cold store 已经可恢复 UI 行为流。
- compactor 有 XML tag repair，避免格式错误直接失败。

当前短板：

- 压缩粒度偏粗，长期记忆更新与上下文压缩耦合。
- 工具结果预算只在 runner 中按字符串处理。
- 没有请求前 context projection 的可测试抽象。
- prompt overflow 恢复策略少。
- 压缩诊断与 runtime event 没有统一呈现。

## 建议的 Context Pipeline

建议新增 `agent/context_pipeline/`：

- `models.py`
  `ContextStageResult`、`ContextProjection`、`ContextBudgetReport`。
- `tool_results.py`
  工具结果替换、artifact 落盘、content replacement record。
- `snip.py`
  本地轻量裁剪策略。
- `microcompact.py`
  本地或模型轻量压缩。
- `conversation_compact.py`
  历史对话摘要，不直接写长期记忆。
- `memory_extract.py`
  长期记忆提取与用户档案更新。
- `pipeline.py`
  按顺序运行 stage，输出模型请求消息和指标。

迁移顺序：

1. 先把 `_pair_tool_calls()`、`_cap_tool_result()`、`_shrink_old_tool_results()` 原样迁入 pipeline，保持行为不变。
2. 加入 `ContextBudgetReport` runtime event。
3. 已让工具结果 store 服务 `ContextPipeline`，并接入 `AgentRunner` 默认请求投影；工具级 `max_result_chars` 已进入预算链路，结构化 `ToolResult` 已贯通执行器和 runtime，下一步为内置/MCP 工具补原生 artifact mapping 与 UI artifact 展示。
4. 拆分 compactor 的上下文摘要与长期记忆更新。
5. 引入 reactive recovery。

验收标准应包含稳定性用例：同一段 history 连续投影两次，输出的 replacement records 和模型可见消息必须一致；重启后从 history + artifact store 重建投影也必须一致。
