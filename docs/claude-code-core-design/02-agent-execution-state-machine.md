# 02. Agent Execution State Machine

Claude Code 的核心执行流在 `src/query.ts`。它是一个 async generator，持续产出 `StreamEvent`、`RequestStartEvent`、`Message`、`TombstoneMessage`、`ToolUseSummaryMessage`，最后返回一个 `Terminal` reason。

Emperor Agent 当前核心执行流在 `agent/runner.py` 的 `AgentRunner.step_async()`。它也是循环状态机，但实现方式更直接：准备消息、调用模型、执行工具、追加 history、必要时压缩或暂停。

## Claude Code `query()` 的阶段化流程

入口上要先区分两层：`query()` 是生命周期包装器，负责把外部消费结束状态收口；真正的主状态机在 `queryLoop()`。因此升级 Emperor 时不应把所有逻辑继续压在 `step_async()`，而应把“外部 turn 生命周期”和“内部模型/工具 follow-up 循环”拆开。

### 阶段 0：入口参数与状态初始化

`QueryParams` 包含：

- `messages`
- `systemPrompt`
- `userContext`
- `systemContext`
- `canUseTool`
- `toolUseContext`
- `fallbackModel`
- `querySource`
- `maxOutputTokensOverride`
- `maxTurns`
- `skipCacheWrite`
- `taskBudget`
- `deps`

`State` 在循环间传递：

- `messages`：当前 query 视角的消息列表。
- `toolUseContext`：工具执行上下文，包含 AppState、工具集合、abortController、readFileState、MCP、agentId 等。
- `autoCompactTracking`：自动压缩状态。
- `maxOutputTokensRecoveryCount`：输出截断恢复次数。
- `hasAttemptedReactiveCompact`：是否已经尝试 reactive compact。
- `maxOutputTokensOverride`：当前回合是否提高输出上限。
- `pendingToolUseSummary`：上一批工具的异步摘要任务。
- `stopHookActive`：stop hook 是否处在重试路径。
- `turnCount`：工具 follow-up 轮数。
- `transition`：上一轮继续的原因，便于测试和恢复路径判定。

设计要点：

- 状态不是散落在局部变量里，而是每次 `continue` 时构造新的 `State`。这让状态转移点可审计。
- `QueryConfig` 是入口时的只读快照，`State` 是循环中的可变事实。这个分离减少了 feature gate、env、permission mode 等运行中变化对测试的影响。
- `transition` 不只是调试字段，它把“为什么继续下一轮”变成可观测状态，例如 tool follow-up、stop hook retry、token budget continuation、reactive compact retry。

### 阶段 1：每轮请求前上下文投影

每次 while 顶部都会重新生成本轮模型请求上下文：

1. `getMessagesAfterCompactBoundary(messages)`
   只取压缩边界之后的可见消息。
2. `applyToolResultBudget(...)`
   对工具结果应用聚合预算，必要时把大结果替换为路径预览。
3. `snipCompactIfNeeded(...)`
   可选裁剪历史，释放 token。
4. `microcompactMessages(...)`
   对细粒度内容做轻量压缩。
5. `contextCollapse.applyCollapsesIfNeeded(...)`
   把历史投影为折叠视图。
6. `autoCompactIfNeeded(...)`
   超过阈值时生成完整摘要消息和附件。
7. `appendSystemContext(systemPrompt, systemContext)`
   生成完整 system prompt。

这条 pipeline 的关键价值是：模型请求前的上下文不是原始 history，而是多个预算策略组合后的投影视图。

Emperor Agent 当前对应：

- `_pair_tool_calls()`
- `_cap_tool_result()`
- `_shrink_old_tool_results()`
- `Compactor.compact_async()`

升级方向：把这些从 `AgentRunner._ask_model()` 和 `_maybe_compact()` 中抽出为 `ContextPipeline`，让每个阶段有输入、输出、指标和测试。

### 阶段 2：请求发起与模型流式

`query()` 产出 `stream_request_start`，随后调用 `deps.callModel(...)`，生产实现是 `queryModelWithStreaming`。

模型请求参数包含：

- messages：`prependUserContext(messagesForQuery, userContext)`
- systemPrompt：带 systemContext 的完整 prompt
- thinkingConfig
- tools
- signal
- model / fallbackModel
- permission context getter
- querySource
- agent definitions
- MCP tools
- taskBudget

设计要点：

- `deps` 可注入，便于测试主状态机。
- `QueryConfig` 在入口快照 env/statsig 状态，避免循环中动态变化导致难测。
- 模型请求和工具执行共享 abortController。

Emperor Agent 当前对应：

- `ModelCaller.ask()`
- provider 的 `chat_stream()` / `chat()`
- `runtime_events.model_route_fallback()`

升级方向：保留多 provider，但让 runner 依赖一个可注入的 `ModelCallPort`，减少测试时对真实 provider 的耦合。

API 侧还有一个容易低估的状态机：`src/services/api/claude.ts` 不只是 HTTP client，它负责请求渲染、工具/结果配对修复、stream event 累积、非流式 fallback、usage/cost/requestId 记录和可恢复错误归类。Emperor 的 provider 层也应逐步从“返回 LLMResponse”升级为“返回结构化模型事件和错误分类”，否则 runner 会继续承担过多协议适配细节。

### 阶段 3：流式消息处理与 tool_use 收集

Claude Code 的流式处理有两个重点：

- 对 assistant 消息即时 yield 给 UI/SDK。
- 每当 assistant content 中出现 `tool_use` block，就加入 `toolUseBlocks`，标记 `needsFollowUp=true`。

如果启用了 `StreamingToolExecutor`，tool_use 到达时会立即 `addTool()`，而不是等整条 assistant 响应结束。这样长输出和工具启动可以重叠。

同时有 fallback 清理逻辑：

- 如果流式 fallback 发生，已 yield 的孤立 assistant 消息会通过 tombstone 移除。
- 已启动或排队的工具执行器会 `discard()`，避免旧 tool_use_id 的结果泄漏到新模型响应。

Emperor Agent 当前对应：

- provider 流式 delta 只发 `message_delta`。
- 工具调用在完整 `LLMResponse` 返回后统一执行。

升级方向：

- v1 可先不改 provider 协议，只新增 `ToolExecutionEngine` 的内部状态。
- v2 再支持 provider 侧 partial tool_call 流式，到达即可入队。

### 阶段 4：工具执行

Claude Code 有两条工具执行路径：

- 新路径：`StreamingToolExecutor`
- 旧路径：`runTools()` in `src/services/tools/toolOrchestration.ts`

旧路径按 `isConcurrencySafe(input)` 分批：

- 连续并发安全工具成组并发。
- 非并发安全工具单独串行。
- contextModifier 在安全批次后按工具顺序应用。

新路径维护每个工具的状态：

- `queued`
- `executing`
- `completed`
- `yielded`

并发规则：

- 没有工具执行时，任何工具可启动。
- 若已有工具执行，只有并发安全工具且所有执行中工具都并发安全时才可并行。
- 非并发安全工具会阻塞后续队列。

错误与取消：

- Bash 工具错误会取消 sibling subprocesses。
- 用户中断时，根据工具 `interruptBehavior()` 决定 cancel 或 block。
- streaming fallback 时生成合成错误结果。
- 所有 tool_use 都必须得到 tool_result，防止下一轮 API 格式错误。

一个关键不变量：流式 fallback 或 abort 后，已经对外 yield 的孤立 assistant/tool_use 必须 tombstone 或补 synthetic tool_result。Claude Code 用这个机制避免“UI 看到了旧 tool_use，但下一轮模型上下文已切换”的交叉污染。Emperor 现在靠 `_pair_tool_calls()` 请求前补洞，未来执行器也要把“补齐结果”作为一等职责。

Emperor Agent 当前对应：

- `Tool.concurrency_safe = read_only and not exclusive`
- `_execute_tool_calls()` 按连续 concurrency_safe 分组并发。
- `_pair_tool_calls()` 在下一次请求前补齐缺失结果。

升级方向：

- 新增显式 `ToolRunState`，不要只用临时 dict。
- 给工具结果事件增加 queued/executing/progress/completed/cancelled。
- 把 sibling cancellation 和 synthetic result 作为执行器职责，而不是散落到 runner。

### 阶段 5：工具结果后附件注入

工具执行后，Claude Code 会在进入下一轮模型调用前注入额外上下文：

- 队列中的任务通知。
- 文件变化附件。
- 相关记忆预取结果。
- 技能发现预取结果。
- 新连接 MCP 工具刷新。

注意：这些附件在 tool_result 之后统一加入，避免 tool_result 与普通用户消息交错导致 API 报错。

Emperor Agent 当前对应：

- Team/Scheduler/runtime 事件有独立通道。
- 附件上传文本在用户消息构造时内联。
- Skill 注入通过 `LoadSkill` 或 slash skill picker。

升级方向：

- 引入 `PostToolContextInjector`，负责把工具批次产生的额外上下文转为下一轮 user/attachment 消息。
- Scheduler、Team、External 的通知进入模型前也走统一 injector，避免各系统各自拼 prompt。

### 阶段 6：完成、恢复或继续

如果本轮没有 tool_use，Claude Code 会进入完成判断：

- withheld prompt-too-long：先尝试 context collapse drain，再尝试 reactive compact。
- withheld media size error：尝试 reactive compact strip-retry。
- max_output_tokens：先可能提升输出上限，再最多注入恢复 message 重试。
- API 错误：跳过 stop hooks，直接返回。
- stop hooks：可能阻止完成，或注入 blocking errors 后继续。
- token budget：如果低于预算完成阈值，注入 nudge 继续；若收益递减则停止。
- 正常完成：返回 `{ reason: 'completed' }`。

如果有 tool_use，则工具结果、附件、刷新后的 context 会进入下一轮：

```text
messagesForQuery + assistantMessages + toolResults -> State.messages
turnCount + 1
transition = next_turn
```

这个表达式还隐含一个边界：下一轮 `State.messages` 不是全局热 history，而是本轮投影消息加 assistant/tool_result 的结果。Emperor 当前 `AgentLoop.history` 同时承担事实日志和请求输入，升级后应让 `HistoryLog` 继续做事实来源，让 `ContextPipeline` 生成模型请求投影。

Emperor Agent 当前对应：

- 空响应重试。
- `finish_reason` 截断续写。
- todo 未完成 nudge 继续。
- Ask Guard / Plan pause。
- token tracker 超阈值后 compactor。

升级方向：

- 把恢复原因建模成 `TransitionReason`。
- 每个 `continue` 点都产出结构化 runtime event，便于 WebUI 和调试。
- 对 prompt-too-long、tool mismatch、max-output、context overflow 建立不同恢复策略，不再只有“压缩或续写”。

## Project Execution / Plan 能力链路

Claude Code 能稳定编写真实项目，不只靠 tool loop，而是靠一条强约束执行链：

```text
进入 Plan 模式
-> 只读探索项目
-> 产出可审阅计划
-> 用户批准
-> 退出 Plan 模式
-> 用 TodoWrite 固定执行步骤
-> 每步执行工具
-> 更新 todo/step 状态
-> 运行验证命令
-> 把验证证据写回计划
-> 未完成则继续，失败则诊断恢复
```

Emperor Agent 对应升级后的链路应是：

```text
ControlManager.set_mode("plan")
-> ProposePlanTool.create_plan(...)
-> PlanStore 保存 PlanRecord / PlanStep
-> ControlManager.approve(...)
-> PlanExecutionState 激活第一个 step
-> TodoStore.sync_from_plan_steps(...)
-> AgentRunner 执行 update_todos
-> ControlManager.sync_plan_from_todos(...)
-> PlanStep 写入 evidence
-> runtime_events.plan_runtime_update(...)
-> WebUI replay 重建计划执行状态
```

已落地的关键约束：

- Plan 模式仍由 `agent/control/` 控制，写工具和高影响操作不能绕过批准。
- `propose_plan` 不再只是 Markdown 预览，可以保存结构化 `steps`、`files`、`commands`、`acceptance`。
- 用户批准后，结构化 plan 会同步成 todos，并保持单个 `in_progress` 步骤。
- `update_todos` 成功后，Runner 会把 todo 状态回写到 `PlanStep.status`，完成步骤会追加 `evidence`。
- active PlanStep 中声明的 `commands` 被 `run_command` 执行时，Runner 会记录 `VerificationResult`，并发出 `plan_verification_start`、`plan_verification_done`、`plan_runtime_update`。
- 验证失败时，PlanStep 会被标记为 `failed`，Runner 会向下一轮模型注入 `[PLAN_VERIFICATION_FAILED]` 诊断指令，要求先修复或必要时 `ask_user`。
- 后端发送 `plan_runtime_update`，前端可通过 runtime replay 恢复计划状态。

下一步应补齐的部分：

- 最终答复前应检查最新 PlanRecord：若还有 active/pending/failed step，必须继续执行或说明阻塞原因。

## Emperor Runner 拆分建议

`AgentRunner.step_async()` 当前同时承担：

- 写 checkpoint。
- 评估 Ask Guard。
- 调模型。
- 记录 token。
- 记录 model_call history。
- 处理 tool_calls。
- 处理 TurnPaused。
- 空响应/截断恢复。
- Plan 模式最终回复拦截。
- todo nudge。
- 触发 compaction。
- 清 checkpoint。

建议拆成以下组件：

- `AgentQueryState`：保存本 turn 状态和 transition reason。
- `ContextPipeline`：请求前消息治理。
- `ModelCallPort`：模型调用与 fallback。
- `ToolExecutionEngine`：工具执行、进度、取消、合成结果。
- `PostToolInjector`：工具结果后的附件/通知/技能/记忆注入。
- `CompletionPolicy`：判断完成、继续、暂停、恢复、压缩。
- `HistoryCommitter`：checkpoint/history/runtime 的一致性写入。

迁移策略应保持行为兼容：先引入组件但由 `AgentRunner` 调用，再逐步把逻辑移出。
