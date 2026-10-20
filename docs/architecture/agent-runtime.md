# Agent 执行链路

> 文档状态：Active<br>
> 面向读者：Core 开发者、维护者<br>
> 最后核验：2026-10-20<br>
> 事实源：`packages/core/src/harness/host/host.ts`、`packages/core/src/harness/host/web-tools.ts`、`packages/core/src/harness/agent/`、`packages/core/src/session-log/`、`packages/core/src/llm/`、`packages/core/src/harness/compaction/`、`packages/core/src/mcp/`、`packages/core/src/skills/`

Emperor 的 Agent 内核是 `packages/core/src/harness/` 下的纯 TypeScript 实现，采用 deepseek-harness standard 模式的语义，但不含插件框架：各子系统在 `HarnessHost.compose()` 中把自己的处理函数压入有序的 middleware 数组。`HarnessHost` 是唯一组合根，每个 session 持有一个 `Agent`。

## 组合根

`HarnessHost.create()` 先通过 `createKeptServices()` 建立保留服务（Emperor Home bootstrap、session 索引、Memory、Projects、环境探测、Skills、Scheduler、MCP、进程运行时、模型配置），再组合内核：

| 组件                              | 位置                           |
| --------------------------------- | ------------------------------ |
| LLM client 与 model route         | `llm/`                         |
| Session log store                 | `session-log/store.ts`         |
| 系统提示词装配                    | `harness/prompt/assembler.ts`  |
| 工具注册表与执行管线              | `harness/tools/registry.ts`    |
| 沙箱策略与后端                    | `harness/sandbox/`、`sandbox/` |
| 审批服务与权限预设                | `harness/approval/`            |
| Plan 模式                         | `harness/plan/plan-mode.ts`    |
| 用户问题                          | `harness/questions/`           |
| 压缩                              | `harness/compaction/`          |
| 后台任务（jobs）                  | `harness/jobs/`                |
| Goal                              | `harness/goal/`                |
| 子代理                            | `harness/subagent/`            |
| 工作流与 Ralph                    | `harness/workflow/`            |
| Hooks                             | `harness/hooks/`               |
| 待处理交互（审批/问题/Plan 审阅） | `harness/host/interactions.ts` |
| MCP 工具桥                        | `harness/host/mcp-tools.ts`    |
| Scheduler 执行器                  | `harness/host/scheduler.ts`    |

系统提示词由 `templates/agent/persona.md` 与各子系统登记的 prompt section 组成；persona 之后固定有一段文件链接说明（`links`），让模型把希望用户点开的文件写成 Markdown 链接（可读名称加路径），对话里显示为带类型图标的链接。提示词本身保持稳定，以维持 provider 前缀缓存；persona 不写当前模型和工作目录，这两项与其他会变化的运行时信息（沙箱与审批策略、Plan 模式、Goal、委派说明）一起以 `form: 'snapshot'` 的上下文消息进入 log，只在内容变化时追加，所以切换模型不会改写提示词前缀。

每一步装配提示词（系统提示与工具列表）之前先运行 pre-assemble middleware：项目会话在这里取得所在项目的 MCP 实例，见「会话作用域」。Pre-step middleware 的顺序是：工作区说明（AGENTS.md / CLAUDE.md）、长期记忆、Skill 目录、插件引用、压缩、重复调用提醒、Hooks，Plan 模式与 Goal 在各自 install 时加入。请求失败时 `retryMiddleware()` 负责按 route 的重试策略重试。

## Turn 与 step

```text
turn/start
  step: 认领 inbox → pre-step middleware → 提交认领 → step/start → user/message ×N
        → 从 log 推导请求 → assistant/chunk ×N → assistant/message
        → tool/call … tool/result（按模型顺序提交）→ step/end
  ……（直到本 step 没有工具调用、工具声明结束本 turn 或达到 max-tokens，且 next-step 为空）
turn/end
```

- **Inbox**：两个待处理列表。`next-turn` 中一条消息开启一个 turn；`next-step` 中的全部消息进入下一个 step。每次变化记录为 `agent/inbox/spliced`，恢复时从 log 精确重建。
- **Followup / steer**：普通提交是 followup（排队到 `next-turn`）；运行中的插话是 steer（进入 `next-step`）。`chat.manageQueuedPrompt` 的 `interject` 把排队项提升到 `next-step`，`cancel` 丢弃尚未开始的项，`send` 发送一条待发送的项（见下文「消息生命周期」）。
- **步数与预算**：每个 step 开始前（认领 inbox 之前）`budget` middleware 可以结束本 turn：达到单轮步数上限，或本任务的费用已达上限，`turn/end` 原因为 `budget`，之前先写一条 `task-budget` 上下文消息告诉模型为什么停下（见下文「任务树与预算」）。每次模型请求返回后（失败后被重试的请求也算）`requestEnd` middleware 收到这次的 usage。turn-stopping middleware（例如 Hooks 的 Stop）可以追加一步。
- **回合改动记录**：根会话的 turn 改过文件时，宿主在 `turn/end` 之后追加一条 `turn/files`；撤销这一轮时追加 `turn/files-reverted`。两者都不进入模型请求，做法见 [IPC 与运行时事件](ipc-and-runtime-events.md#项目工作台-ipc)。
- **取消**：`chat.stopRuntime` 或 `/stop` 取消当前 turn，并清理该 session 的待处理交互和子代理；inbox 中等待的 harness 上下文（后台任务通知等）被丢弃，用户排队的消息保留为待发送。提交方的 AbortSignal（ACP `session/cancel`、定时任务取消）只作用于它自己的消息，见下文。`turn/end` 只记录取消原因本身的字段（`kind`，Hook 取消另带 `reason`），传输层事后附加在 abort reason 上的内容（例如 Node fetch 写入的 `stack`）不会进入 log。
- **`turn/end` 原因**：`completed`、`aborted`、`blocked`、`error`、`max-tokens`、`interrupted`（崩溃修复补写）、`plan-dismissed`（用户关闭 Plan 审阅）、`budget`（`limit: 'steps'` 带 `maxSteps`，或 `limit: 'cost'` 带 `capUsdNanos`、`spentUsdNanos`，无法计价时另带 `unpricedRoutes`）。

### 消息生命周期

一条消息只有在它的 `user/message` 写进 log 之后才算被消费。在那之前它一直在 inbox 里（log 中有插入它的 `agent/inbox/spliced`），应用崩溃或退出后重新打开会话仍能找回。

- **两阶段认领**：step 开始时 `inbox.claim()` 只预留本 step 要取的消息（全部可取的 `next-step`，新 turn 再加 `next-turn` 中第一条可取的），消息仍留在队列里，状态为 `sending`。所有 pre-step middleware 通过后才 `commit()`：被预留的消息在 `step/start` 之前以一条 `agent/inbox/spliced` 移出 inbox，紧接着写 `user/message`（同一个同步块，落在同一批写入里）。pre-step 被停止（例如压缩期间点停止）、被拒绝（UserPromptSubmit Hook 拒绝）或抛错时 `release()`：消息原样留在队首，顺序不变，log 中不会出现它的 `user/message`。被某个 middleware 从本 step 剔除的已认领消息（例如过期的 Goal 轮次）显式丢弃。
- **按消息结果**：每条消息有自己的结果（`Agent.outcome(id)`）。被消费的消息在消费它的 turn 的 `turn/end` 处得到结果，同一个 step 合并进入的多条消息（多条插话、开启 turn 的消息加上插话）得到同一个 turn；插话在 step 中途到达时进入下一个 step，结果仍是这个 turn。`HarnessHost.submit()` 据此返回 `TurnResult`（`harness/host/scope.ts`）：`completed`（带最终回复）、`error`（带错误码）、`aborted`（`by: user | timeout | system`）、`blocked`（`cost-cap`：任务费用上限；`step-limit`：单轮步数上限；`prompt-rejected`；后台 turn 另有 `interaction-rejected`、`plan-mode`、`interaction-timeout`）、`not-consumed`（带原因）；`delivery` 为 `completed` 只表示有 turn 消费了这条消息，没有被消费的消息不会报告为 `completed`。submit 在那个 turn 完全结束（驱动空闲或进入下一个排队的 turn）后才返回，但不再等后面排队的 turn。
- **待发送（held）**：turn 以 `error` 或 `blocked` 结束时，排在它后面的用户消息不会自动运行，结果为 `{ kind: 'not-consumed', reason: 'previous-turn-failed' }`，消息留在队列里，界面显示「待发送 · 上一轮失败」，用户点「发送」后像新消息一样运行，或点「丢弃」。停止时排队的用户消息（以及正在准备 step 时被停止的那条）同样保留为待发送，原因 `previous-turn-stopped`，被预算停下的 turn 后面的用户消息也是这样；重新打开会话时 inbox 中残留的用户消息都恢复为待发送，原因 `interrupted`。待发送的消息不会被后续认领取走，新发送的消息照常运行；它们也不算会话忙碌（命令照常可用），但 `/clear` 仍要求先处理。harness 上下文消息（后台任务、子代理通知等）不会被保留为待发送。
- **按消息取消**：提交方的 AbortSignal 调用 `Agent.cancelMessage(id)`：消息还在排队（或待发送）时把它丢弃，结果为 `aborted`（`turnId` 为空）；已被某个 step 预留或已被当前 turn 消费时只取消那个 turn，排在后面的消息随后照常运行。ACP 与 onboarding 的隐藏提示以 `unconsumed: 'withdraw'` 提交：没有被消费时直接丢弃，不会留在队列里等一个已经离开的提交方；ACP 此时返回 `stopReason: "refusal"` 与 `_meta.emperor.notConsumed`。
- **显式丢弃**：消息不经消费离开 inbox 时，splice 带 `outcome: 'canceled'`，随后写一条 `agent/inbox/discarded { messageIds, reason }`，`reason` 为 `user`（用户在队列里丢弃）、`cancelled`（提交方取消）、`stopped`（停止时丢弃 harness 上下文）或 `dropped`（pre-step 剔除）。不变量：每条进入过 inbox 的用户消息，要么在某条 `user/message` 里，要么仍在 inbox，要么出现在 `agent/inbox/discarded` 中。
- **队列状态**：`queue_item_state`（host-only，见 [IPC 与 Runtime Events](ipc-and-runtime-events.md#两条管线的分工)）通知每条用户消息的 `queued`、`sending`、`failed-previous`、`discarded`；`chat.listQueuedPrompts` 列出 `queued` 与 `failed-previous` 的项（带 `reason`），正在 `sending` 的项不列出。

## 会话作用域

### 选中会话只决定显示

- 界面正在看哪个会话，只决定界面显示什么。CoreApi 自己记着它（`focusedSessionId`）：只有 `activateSession()`（用户切换会话、`bootstrap({ sessionId })`、`/new` 等）写它，只有 `bootstrap()` 读它（界面的起始状态，结果的 `sessionId` 即这一项）。`HarnessHost` 没有焦点。`core-api-facade-architecture.test.ts` 断言除这两处之外没有代码读它，Core 源码里也没有 `activeSessionId`、`activeWorkspaceRoot` 一类的读取。
- 其余依赖「哪个会话」的东西都显式拿到会话。`SessionScope { sessionId, projectRoot, workspaceRoot, kind }`（`harness/host/scope.ts`）由 `HarnessHost.scopeFor(sessionId)` 从会话索引算出：Build 会话的 `projectRoot` 是项目根，Chat 会话为 null；`workspaceRoot` 是文件与 Shell 工具的工作目录（项目或 Chat 工作区）。子代理用根会话的 scope；ACP 会话是以其 cwd 为项目的 Build 会话。
- 界面发起的调用带上它显示的会话：preload 在每个 core 通道的参数前放调用上下文 `{ emperorCoreCall: 1, view: { sessionId } }`（renderer 切换会话时用 `setViewingSession` 更新，草稿为 null），main 取下后作为 `CoreOperationContext.view` 交给 operation，Core 与 main 都不记住它。Operation 的输入没写会话时用它（`tasks.*`、`skills.*`、`goals.*`、`delegations.*`、`memory.compact` 等）；mutation guard、插件列表与详情、Hooks 测试与审计、环境状态、诊断和记忆里与会话有关的字段也取它。进程内调用方（ACP、main、测试）要么写明会话，要么传 view。都没有时 Core 返回 `SESSION_REQUIRED`（`SessionRequiredError`）。`chat.stopRuntime`（不带 `taskId` 时）与 `processes.*` 只认输入里写明的 `sessionId`；renderer 停止时写明当前会话。
- Mutation guard（`assertMutation(area, action, view)`）检查调用方显示的会话有没有待处理交互、是否处于 Plan 模式；`view.sessionId` 为 null（草稿或没有会话）时不拦截，另一个会话的状态不影响它。外部子会话的控制由所属根会话自己的状态把关。

### 后台 turn

- `HarnessHost.submit()` 不改变任何焦点。定时任务、ACP 与 onboarding 走 `HarnessHost.runBackgroundTurn(scope, content, options)`：在 scope 指明的会话里运行一轮，返回 `TurnResult`。`interactionPolicy: 'auto-reject'` 时，这一轮（含它的子代理）的审批、提问、Plan 审阅和电脑操作授权卡立即按拒绝处理，审批与问题照常写入 log；一轮完成但有被拒绝的交互时结果为 `blocked`（`interaction-rejected`，Plan 审阅被拒绝时为 `plan-mode`），`detail` 列出被拒绝的工具。`wait` 时交给界面，与桌面 turn 相同。`timeoutMs` 到时取消这一轮：结果为 `aborted`（`by: 'timeout'`），当时正等待界面回答的为 `blocked`（`interaction-timeout`）。「这一轮」指根会话当前 turn 正是消费了后台消息的那个 turn：后台消息排在桌面 turn 后面等待时，桌面 turn 的交互不受影响。
- 定时任务的执行器（`harness/host/scheduler.ts`）用 `runBackgroundTurn`，默认超时 30 分钟、`auto-reject`，并把结果写进运行记录：completed → `ok`；error → `error`，记录 `errorCode`（例如 401/403 为 `AUTH`）；aborted → `cancelled`（超时的 `errorCode` 为 `TIMEOUT`）；blocked → `blocked`（界面显示「需要审批，已拒绝」，`error` 写明被拒绝的操作）；not-consumed → `error`（`NOT_CONSUMED`）。一次运行结束（包括超时）就离开 in-flight 集合，后续触发照常进行；`error` 与 `blocked` 发 `scheduler_run_error`（带 `status` 与 `code`）。没有绑定会话的旧任务在最近更新的会话（没有时新建一个）里运行，不改变界面显示；创建或编辑任务时，没有写明会话的任务绑定到创建者显示的会话（调用的 `view`）。
- ACP 通过 `chat.runBackground` 提交（policy `wait`：ACP 自己取消交互并返回 refusal）；onboarding 访谈以 `wait` 运行，用户在访谈会话里回答。Goal 的轮次由会话自己的驱动器唤醒（`agent.followup`），从不经过 host 的提交，同样按所在会话的 scope 取得 MCP 工具与 Hooks。

### MCP 与插件按 scope 生效

- 全局 server：`mcp_config.json` 的 server，以及用户范围和随 Emperor 提供的插件的 server，在 host 自己的 `MCPClient` 中运行，stdio 工作目录与沙箱写入根为 Chat 工作区，不属于任何会话。
- 项目实例：项目（`project`、`local` 范围）插件的 server 按项目根各有一个实例（`mcp/project-instances.ts` 的 `ProjectMcpInstances`；`start()` 是实例启动的唯一入口，客户端由 host 创建，只运行交给它的插件 server，不读 `mcp_config.json`），工作目录与沙箱写入根为该项目。会话的每一步在装配提示词之前（`middleware.preAssemble`）持有所在项目的实例（第一次使用时启动并等待连接结果），该 agent 空闲、子代理结束或会话删除时释放；没有任何持有者 5 分钟后停止，停止时它的工具先从所有会话的列表中移除。同一项目的多个会话共享一个实例，一个项目的实例启动失败只影响该项目。诊断的 `kernel.projectMcp` 列出各实例的项目、持有者数与状态。
- 工具按 scope 过滤：`McpToolBridge` 对每个工具名只注册一次，按调用方 agent 所在项目选出服务它的 server（项目自己的实例优先；项目用自己范围的插件替换了用户范围的同一插件时，隐藏全局那一份）。Chat 会话只看到全局工具，A 项目的会话看不到 B 项目实例的工具；同名工具的描述与参数按调用方给出。项目插件的 server 键与全局 server 的键不会重名。
- 插件 Hook 同样按 scope 计算：`ClaudeCodeHooks` 的全局集合来自用户范围和随 Emperor 提供的插件；项目会话另加该项目自己插件的集合（`setPluginHookScope`），全局集合中被项目替换的插件除外。Chat 会话不会触发任何项目的插件 Hook。`PluginActivationController` 对每个项目按需计算并缓存这些贡献，插件安装、启停、卸载后重算；切换显示的会话不触发任何重算，只发 `plugins_changed`（`reason: project`）让界面刷新列表。

## 模型调用

`llm/` 负责把 `model_config.json`（schemaVersion 2）中的条目解析为 route：

- `llm/catalog.ts` 是 Provider catalog，只描述访问方式（协议、默认 API Base、模型发现、reasoning 适配），不内嵌模型清单。
- `llm/route.ts` 的 `routeFromEntry()` 把条目解析为 `RouteSpec`，并选定适配器：Provider 为 `deepseek` 且地址是官方主机 `api.deepseek.com`（`isOfficialDeepSeekHost`）时用 `deepseek-messages`（Anthropic Messages），条目设了 `transport: 'chat-completions'` 时改用 `deepseek`；其他 `deepseek` 条目与指向 deepseek.com 的 OpenAI 协议条目用 `deepseek`（fetch + SSE 的 chat-completions）；其余 `openai` / `anthropic` 协议使用 pi-ai 适配器。两个 DeepSeek 适配器共用 off / low / high / max 的思考强度词表（`usesDeepSeekEfforts`）和 DeepSeek 的图片计价。
- 流式工具调用的 `id` 与 `name` 只取第一次出现的非空值：部分 OpenAI 兼容网关会在后续 delta 里重复发送空串或 `null`，DeepSeek 适配器、pi-ai 适配层、`BlockAssembler` 以及 renderer 的 Chat 与 Trajectory 折叠都不会用它们覆盖已有的值。
- `llm/adapters/deepseek-messages/`（KRN-07）：请求发到 `https://api.deepseek.com/anthropic/v1/messages`，带 `x-api-key` 与 `anthropic-version`。路径、beta 头（`files-api-2025-04-14`，只在请求引用了文件时发送）、上传有效期、JPEG 档位等协议常量都在 `constants.ts`，并注明出处的 DeepSeek 文档。
  - 序列化（`serialize.ts`）：`system` 放顶层；历史里的 system 消息并入 user 轮；相邻的 user 轮合并，`tool_result` 排在最前，工具结果里的图片嵌在 `tool_result.content` 里；思考强度 off → `thinking: {type: 'disabled'}`，low / high / max → `thinking: {type: 'enabled'}` + `output_config.effort`，medium 归入 high，`session-title` 与 `compaction` 用途一律关闭思考；条目旧的 `extraBody` 先合并进请求体。
  - 回放（`replay.ts`）：流结束时 `finish.replayState` 带 `{kind: 'deepseek-messages', version: 1, model, …}` 与逐块的 `{type, signature?}`，随 assistant 消息写进 session log。回放时同一模型的 thinking 带签名原样发送；没有签名的（chat-completions 时代的 `reasoning_content`，或块数对不上的信封）作为不带签名的 thinking 发给同一模型；其他模型的 thinking 一律不发，只剩思考的 assistant 轮整轮省略。pi-ai Anthropic 路由留下的 `thinkingSignature` 也能读。
  - 流解析（`sse.ts`、`translate.ts`）：thinking 与 tool_use 块一开始就开出 harness 块（工具调用先带 id 与名字），text 块在第一个非空字符时开出；`content_block_stop` 结束块，`message_stop` 时发 usage 与 finish。`input_tokens` 原样作为不含缓存的输入，`cache_read_input_tokens` 映射为 cache read，`cache_creation_input_tokens` 非零时映射为 cache write。流里的 `error` 事件按类型映射（overloaded / api → `SERVER`，rate_limit → `RATE_LIMIT`，invalid_request → `INVALID_REQUEST`），在 `message_stop` 之前断流记为 `TRANSPORT`，都交给重试策略。HTTP 错误兼容 Anthropic 与 OpenAI 两种错误体，经 `httpErrorCode` 分类（429 带 Retry-After）。
  - 图片（`files.ts`、`transcode.ts`）：视觉路由上，图片经 OpenAI 兼容的 Files API（`POST https://api.deepseek.com/files`，`purpose=user_data`，24 小时后过期）上传一次，请求里写 `{type: 'image', source: {type: 'file', file_id}}`。缓存键是「地址 + API Key 的 SHA-256」再加附件 id，只在内存里，剩余寿命不足 1 小时就重新上传。超过约 1300×1300 像素或 5 MiB 的图片先用 `/usr/bin/sips` 缩放并转成 JPEG（质量 85 → 75 → 60，取第一个不超过 5 MiB 的）。上传因账号存储满失败时，按创建时间列出文件，只删除文件名以 `emperor-` 开头的最旧 50 个后重试一次；其他失败改为内嵌 base64，并让这个地址 + Key 在 10 分钟内只走内嵌。
  - 一次修复：请求被拒（400 / 404）且还没有输出任何内容时，最多再发一次：错误提到文件时作废这次引用的 file id、图片改为内嵌；错误提到签名或 thinking 且请求里有不带签名的 thinking 时去掉它们。
- `llm/retry-policy.ts`：默认对 `EMPTY_RESPONSE`、`RATE_LIMIT`、`SERVER`、`TIMEOUT`、`TRANSPORT` 最多重试 5 次，指数退避 500 ms 到 10 s、±10% 抖动；不大于上限的 provider Retry-After 会替换本地延迟。每次重试写入 `llm/retry` 事件。

全局只激活一个模型。`model_config.json` 中默认关闭的执行策略由 `harness/agent/model-policy.ts` 执行：备用模型是排在重试 middleware 之后的 request-error handler，重试用尽且错误类型命中触发条件时写入 `llm/fallback`，本轮剩余请求改用备用条目，下一轮回到主模型；每轮成本上限是 pre-step handler，累计本轮已计价用量达到上限后拒绝下一个 step（`llm/cost-cap`）。请求的模型与上一次请求不同（用户切换了模型、备用模型接手或下一轮回到主模型）时，Agent 在这次请求之前写入一条 `model-switch` 上下文通知，告诉模型“本步起由 X 模型继续，之前的回复来自 Y”；会话的第一次请求不写。

## 工具执行

`ToolRegistry.prepare()` 对单次调用依次执行：参数校验 → pre-execute middleware（取最严格的 allow / ask / deny）→ 需要时审批 → guard → 在超时内执行工具体 → post-execute middleware → 结果观察者。任何失败都变成模型可读的错误结果，不会抛到循环外。工具体无论有没有超时都与调用的取消信号竞速：Stop 之后即使工具体不理会取消，调用也立即得到 `ABORTED` 结果；工具体真正结束之前，它持有的工作区租约不会释放。

`harness/agent/tool-calls.ts` 按模型顺序分组：连续的并发安全调用共享一个滚动池（默认最多 10 个并行），非并发安全调用单独执行并形成屏障；`tool/call` 事件和 pre-execute 按模型顺序发生，只有工具体重叠，post-execute 与 `tool/result` 严格按模型顺序提交。中止时尚未开始的调用得到合成的 `ABORTED_BEFORE_DISPATCH` 结果，保证每个调用都有结果。step 因内部故障抛错时（例如结果无法写入 log），所有还没有结果的调用在 `step/end` 之前补写错误结果：已记录 `tool/call` 的写 `TOOL_OUTCOME_UNKNOWN`（结果未知，只有只读或幂等的操作才应重试），从未开始的写 `TOOL_NOT_STARTED`；这与崩溃修复使用同一组结果（`session-log/repair.ts` 的 `ToolCallRecovery`），下一次请求因此不会带着悬空的工具调用。

Post-execute 固定包含重复调用提醒（相同工具与参数连续出现时追加提示，不否决调用）、Hooks 的 PostToolUse，以及最后执行的大结果落盘：纯文本结果超过 50,000 字节时，完整文本写入 `stateRoot/spill/`，模型只看到首尾预览和文件路径。`read` 不参与落盘；界面可以通过 `tools.readResult({ ref, page })` 分页读取落盘全文（每页最多 256 KiB，在字符边界处分页，返回 `{ content, page, pages, bytes }`）。

### 网络工具

`harness/host/web-tools.ts` 的 `WebTools` 在 `compose()` 里登记 `web_fetch` 与 `web_search`，开关来自 `settings.json` › `webTools`（默认都开），CoreApi 的 `tools.setNetworkSettings` 先保存再调用 `WebTools.update()`。两个工具都用 `ToolRegistry.register(…, { visible })` 注册：关闭或当前不可用时既不出现在工具清单（`skills.tools`、请求的 tools）里，也不能调用；对应的 `tool:web_fetch`（order 111）与 `tool:web_search`（order 110）提示段按同一可见性渲染为空，`web_search` 的说明只在 `web_fetch` 可见时提到它。

- `web_fetch` 只在宿主提供 `webFetchClient` 时注册（桌面 main 总是提供；headless ACP 不提供）。请求经 `PublicHttpClient`（DNS 结果与每一跳都拒绝本机、私网、链路本地与保留地址，不带 Cookie），`overflow: 'truncate'` 读到 10 MiB 为止并标记截断；HTML 由 `network/html-markdown.ts` 先做线性的词法预处理（去掉脚本、样式、注释等，只保留 256 KiB 标记，估算嵌套深度，过深时退回纯文本），再交给 turndown。整个结果放进 `external-content.ts` 的不可信信封，模型可见部分保持在落盘阈值之下（信封把正文编码成一行 JSON，`read` 无法分页），长页面按 `offset` 分段。
- `web_search` 在宿主注入搜索后端时总是可用，否则只在 agent 下一次请求的路由（`agent.proposedCallConfig().provider`；无 agent 时取当前活动路由）指向 `https://api.deepseek.com` 且有 API Key 时可见，每次调用用该路由的 Key 请求 DeepSeek Search API（`/v1/tools/search`），结果同样放进不可信信封。

工具清单与语义见[工具与扩展能力](../user/tools-skills-mcp.md)，权限管线见[权限与 Plan 架构](control-and-permissions.md)。

## 交互阻塞在工具调用内

`ask_user_question`、`exit_plan_mode` 的审阅和一次性提权审批都在工具调用内部等待，没有“暂停 turn 再恢复”的机制。`PendingInteractions` 把等待中的请求投影到 `control.pending`，renderer 通过 `control.answerInteraction`、`control.approvePlan`、`control.commentPlan` 或 `control.cancelInteraction` 回答。turn 被中止时等待自动以 `cancelled` 结束；应答通道不可用时以 `unavailable` 结束（fail closed）。用户关闭 Plan 审阅（改为自己输入）时，`exit_plan_mode` 返回成功结果并声明结束本 turn，`turn/end` 原因为 `plan-dismissed`，不再为等待用户多请求一次模型。

## 压缩

**预算**（`compactionBudget`）：W 为上下文窗口，O 为请求的输出上限（最多 W / 2）。触发线 `floor(min(W × 0.8, W − O − 65536))`，窗口太小（约 120K 以下）、这一项不到 `0.45 × (W − O)` 时取后者；保留尾部 `0.16 × (W − O)`；摘要输出上限 `min(65536, O)`。`CompactionConfig.modelPolicies` 可按模型（可再限定路由）覆盖比例、余量与摘要上限。

**计量**（`TokenMeter`）：文本按字符类别估算（CJK 表意文字与假名 1 字 ≈ 1 token，ASCII 4 字符 ≈ 1 token，其余 2 字符 ≈ 1 token），图片按路由计价（DeepSeek 14px patch 网格每张最多 1024；Anthropic `(w×h)/750`；OpenAI 512px tile；纯文本模型按占位文字），附件与截图的像素尺寸记在图片引用里。每次请求返回后用真实 usage 校准该会话的系数（指数平滑 α = 0.3，首个样本直接作为初值；与估算相差 4 倍以上的 usage 不采信）。上一次请求的 usage 属于未变的请求头时，它就是基线，只估算之后新增的部分。

`harness/compaction/` 有三个触发点：

1. **Step 前压力**：按下一次请求的路由（本 turn 已切到备用模型时按备用模型）计算预算，估算达到触发线时先用无模型的 pruner 截短超过 8,192 字符的旧工具结果（本 step 与上一 step 产生的结果模型还没读过，不截），再重新测量；仍超出时对头部范围生成摘要，保留尾部预算。失败会记录但不中断 turn，同一 agent 之后 3 次 step 前检查跳过；连续失败 3 次写 `compaction/warning`，界面提示「上下文接近上限，建议 /compact 或新开会话」。
2. **上下文溢出重试**：请求返回 `CONTEXT_WINDOW_EXCEEDED` 时，先剪枝并以零保留预算摘要，只有表面确实缩小才重试。
3. **手动 `/compact`**：通过 `agent.runMaintenance` 执行。

一次摘要请求放不下的范围（溢出恢复时一律）按块 map-reduce：每块不超过窗口的一半（溢出时不超过被拒请求的一半），只在没有未回填工具调用的位置切分，单条过大的消息保留头尾；各块的摘要最后合并成一份。摘要请求 `purpose: 'compaction'`，DeepSeek 与 pi-ai 路由都不开 thinking。

摘要使用固定的 8 个章节（Primary Request and Intent、Key Technical Concepts、Files and Code、Errors and Fixes、Pending Jobs、Current Work、Next Step、Critical Context），以一条检查点 `user/message` 替换被压缩的范围。提交顺序为 `compaction/start` → 摘要调用（分块时多次）→ `compaction/summary`（usage 为各次之和）→ 检查点消息 → `compaction/end`。压缩只作用于 session log 的模型可见表面，不改写长期记忆。

**图片卸载**：视觉路由的请求里图片超过该路由的内联预算（默认 base64 20 MiB，`RouteSpec.maxRequestImageBytes`）时，`buildRequest` 从最早的图片开始卸载到预算的一半，每个节点写一条 `image/offload {seq, reason}`；最新的那张不在这里卸载。`Session.deriveMessages()` 与 `deriveEventMessage()` 对已记录的节点发送占位文字，所以换模型、备用模型接手或重新打开会话后仍是卸载状态，压缩摘要看到的也一样。适配器自己的请求上限仍作为兜底。

**Token 账本**：host 为每次对话请求和每次压缩摘要写一行 `tokens.jsonl`，计数互不重叠：`input`（不含缓存）、`output`（不含 reasoning）、`cache_read`、`cache_create`、`reasoning`，另有 provider、model、`model_entry_id` 与成本（模型条目的单价，没有时用内置目录的单价；单价未知时记为成本不完整）。旧账本里的 `prompt_tokens`、`prompt_cache_hit_tokens`、`completion_tokens`、`cache_*_input_tokens` 读取时换算成这五项。

## 长期上下文

- **工作区说明**：`harness/prompt/agent-instructions.ts` 先读取全局 `~/.emperor/AGENTS.md`，再从项目根（最近的 `.git` 祖先，否则 cwd）到 cwd 逐级读取 `AGENTS.md`、`CLAUDE.md`、`AGENTS.local.md`、`CLAUDE.local.md`。单文件最多读 1 MiB，总预算 65,536 字节，超出时先省略最宽泛的文件再截断最具体的文件。内容以 `form: 'instructions'` 的上下文消息在首个 turn 进入，发现集合变化时下一 turn 追加替换基线。
- **长期记忆**：`harness/memory/memory.ts` 把 `USER.local.md`（用户档案）、`MEMORY.local.md`（全局长期记忆）和 Build 会话的项目私有记忆作为一条上下文基线注入，内容变化时追加替换基线；每节最多 32 KiB。模型用 `memory_edit` 对这三个目标做精确字符串替换或追加，并沿用记忆版本快照。
- **Skill 目录**：Skill 名称和描述以 `form: 'catalog'` 进入上下文，集合变化时替换；`skill` 工具加载全文。用户消息中的 `/<skill-name>` 会让对应 Skill 说明直接进入该 step。目录来自该 session 自己的 Skill loader，见下文“Skills 与 MCP”。

## Skills 与 MCP

### Skill loader 与变更检测

- `skills/file-loader.ts` 的 `SkillLoaders` 按项目根缓存 `FileSkillsLoader`：`forProject(null)` 服务 Chat 会话，每个 Build 项目根各有一个 loader，并发 session 不会互相改写共享实例。每个 loader 按 project（`<project>/.emperor/skills`）> user（`stateRoot/skills`）> Plugin > builtin 合并来源，每次读取重新扫描；未通过校验的文件夹进入 `SkillScan.invalid` 并附原因。
- `HarnessHost.skillsLoaderFor(agent)` 按 session 的 Build 项目选择 loader，Skill 目录 middleware、`skill` 工具与 `skill_manage` 共用它；CoreApi 的 `skills.*` 通过 `sessionId` 走同一选择（`skillsForSession()`）。
- 插件引用（`harness/host/plugin-references.ts`）：本步进入的用户消息里每个 `@插件 ID`（消息开头或空白之后，ID 可带一段 `/命名空间`），每条消息各注入一次上下文消息（producer `plugin-invocation`，`summary` 为 `plugin:<ID>`），追加在本步消息之后，不改系统提示。插件数据由 CoreApi 通过 `setPluginReferenceResolver` 提供：取生效范围的那一行；启用时读插件详情（先检查应用连接），列出 Skill、MCP（工具数）、应用连接和 Hook 各自能否使用，并附上插件可用 Skill 的说明，合计超过 16 KiB 时只给目录；停用、不存在、来源未验证或读取失败时只有一行说明，Computer Use 关闭时提示在「设置 › 电脑操作」打开。清单里的名称、描述与原因都按 JSON 字符串写入，`<`、`>`、`&` 转义，不能闭合标签。
- Skill 名称规则只有一处：`skills/name.ts` 的 `SKILL_NAME`（`^[a-z0-9][a-z0-9._-]*$`，最多 64 个字符），loader、Skill 服务、`requestedSkills` 和 `/name` 手势共用。名称取自 frontmatter `name`，文件夹名不同只产生警告。
- `skills/validate.ts` 是宽松校验：只检查 `SKILL.md` 及其引用的相对路径文件，跳过 `node_modules`、`.venv`、`venv`、`.git`、`__pycache__`，允许指向文件夹内部的符号链接，拒绝绝对链接与越界链接，frontmatter YAML 宽松解析并以警告报告。
- 写入侧是 `skills/library.ts` 的 `SkillLibrary`（个人与项目 scope 可写，builtin 与 Plugin 只读，`copyToUser` 生成个人副本）；导入由 `skills/import.ts` 把粘贴内容、本地文件夹、本地 zip 或 https 链接（GitHub 仓库 / `tree/<ref>/<dir>` / 直接 zip）物化到私有 staging 后逐个校验、复制。
- `skills/change-detector.ts` 的 `SkillChangeDetector` 用 chokidar 监听个人、已知项目与 Plugin 的 Skill 根（深度 3，忽略依赖与 VCS 目录，300 ms 防抖），`SkillLibrary` 与 Plugin 变化也会调用 `notify()`。变化后 host 刷新运行时上下文并发送 host-only 事件 `skill_catalog_changed`（带递增的 `catalog_version`），renderer 据此重新拉取 `skills.list`。内置 Skill 根不被监听。

### MCP 连接

- `mcp/client.ts` 按 server 创建连接（`mcp/connection.ts`）：`stdio` 通过受管子进程（`owned-stdio-transport.ts`）通信；`sse` 使用 SDK 的 SSE transport；`http` 先尝试 Streamable HTTP，初始握手失败时回退到 legacy SSE，认证失败不回退，`HttpConnection.activeTransport` 记录实际使用的传输。transport 未知或缺少 `command` / `url` 的 server 得到一个不会启动进程的无效配置连接并报告原因，不会回退为 `stdio`。
- stdio server 是长寿命流，不是有输出配额的命令（KRN-04）：受管进程以 `stream: 'long-lived'` 启动，运行时不挂捕获监听；`owned-stdio-transport.ts` 按行切分 stdout，单条消息上限 16 MiB（超限的那条丢弃并经 `onerror` 报告，进程继续），读速率超过 64 MiB/s 时暂停读取而不是杀进程；stderr 进 256 KiB 环形缓冲，`stderrTail()` 取最后 200 行。
- 启动与重载（KRN-04）：`MCPClient.reload()` 先停掉移除的 server，再并行连接新的和变化的 server（`Promise.allSettled`，同时最多 4 个）；每个 server 就绪后重建工具列表并调用 `onToolsChanged`，宿主据此重新同步 `McpToolBridge`。`reload()` 在所有 server 就绪或失败后才 resolve，但宿主启动（`HarnessHost.start()` 的首次 `initialize`）与 CoreApi 启动时的插件同步（`syncPlugins({ waitForMcp: false })`）都不等待它，窗口不因 server 卡住。`reload()` 是单飞的：运行中再次请求只排队一次，参数取最后一次，所有调用方等这一轮；`close()` 递增 epoch，进行中的重载不再改动 client，排队的不再运行。`settled()` 在没有运行和排队的重载时 resolve（测试用）。连接超时与 `listTools` 超时默认各 15 秒（`connectTimeoutMs`、`listToolsTimeoutMs`）。
- `mcp/supervisor.ts` 负责单个 server 的连接与重连：每次重建递增 generation，迟到的旧连接事件被忽略；`disconnect()` 递增 epoch 并立即关闭正在建立的候选连接，旧 epoch 的尝试落地时关闭自己打开的连接、不改任何状态，因此重载途中断开不会留下子进程；`reconfigure()` 遇到为旧配置进行中的尝试时先等它落地，再安装新配置（期间又有更新的 `reconfigure` 或 `disconnect` 时放弃）。健康与重启：JSON-RPC 层错误（含 unknown message id）只影响单次调用；`auth_failed` 只来自 HTTP 401/403 状态码或 SDK 的 `UnauthorizedError`，不看消息正文；重启退避 1、4、16、60 秒（之后保持 60 秒），每次 ±20% 抖动，首次失败后最多重启 5 次，第 6 次连续失败进入 `failed` 并停止自动重启；重启次数在稳定运行 60 秒后才清零。
- 工具名：`harness/host/mcp-tools.ts` 的 `McpToolBridge` 把全局 server 与各项目实例已连接 server 的工具注册为 `mcp_<server>_<tool>`，按调用方的项目决定是否可见。用户 server 的工具名由 `mcp/plugin-names.ts` 的 `userMcpToolName()` 生成（与插件工具同一套清洗与截短：`^[A-Za-z0-9_-]{1,64}$`，超长截短加哈希）；本来就合法的名字保持不变，清洗后重名的由 `distinctMcpToolName()` 加上 server 与工具名的哈希。
- 插件贡献的 server 不进 `mcp_config.json`：`plugins/activation.ts` 从生效的插件包算出配置，经 `MCPClient.setPluginServers()` 交给 client，按契约的键（`sanitize(插件名-server 名)`，与用户 server 重名时加 6 位哈希）连接。工具名由 `mcp/plugin-names.ts` 生成，最长 64 个字符；与宿主已有工具（`McpToolBridge.reservedNames()`）或先注册的工具重名时跳过并记录。执行环境变化后按名字回查配置时，插件 server 从 client 自己的列表取回。插件 stdio server 的工作目录是插件目录，进程隔离（`mcp/containment.ts` 生成的 `ContainmentPolicy`，见[统一进程隔离](control-and-permissions.md#统一进程隔离sec-08)）通过 `stateGrants` 只放行该插件的包（只读）和数据目录（读写），另有它自己的缓存目录，Emperor Home 其余内容仍不可访问；沙箱不可用时拒绝启动。插件 Hook 接在用户文件之后，每组带自己的 `PLUGIN_ROOT`、`PLUGIN_DATA` 与清单 `env` 声明的变量名，经 `harness/hooks/contained.ts` 在同一套隔离里运行（workspace 只读；环境只有安全键、声明的变量与 Emperor 给的变量；默认 30 秒、最多 120 秒），每次结果交给 `PluginHookHealth`，插件详情据此显示失败原因与可能缺的变量（SEC-07）。项目与本地项目范围插件的启用意图读自 `<stateRoot>/projects/<project-id>/plugins.json`，项目目录的 `.emperor/settings.json` 只产生建议。用户范围与随 Emperor 提供的插件进全局 client 与全局 Hook 集合，项目范围的插件进该项目的实例与 Hook 集合（见「会话作用域」）。安装、启停、卸载后 CoreApi 重新计算并应用这些贡献，对应操作在应用完成后才返回。
- `mcp/import.ts` 的 `normalizeMcpImport()` 把 `mcpServers`、`servers`、`mcp.servers`、单个带 `name` 的 server 或裸“名称 → 配置”映射规范为 `mcp_config.json` 的 server 形状，JSONC 与片段经修复并给出警告。`mcp/manage.ts` 在此之上提供按名称合并（新增 / 覆盖 / 跳过，支持 dry-run）、启停与删除，CoreApi `mcp.*` 与 `mcp_config` 工具共用它；写入后由调用方重载 MCP，client 按 server diff，只重建变化的连接。

### 跟随权限预设的配置工具

`skill_manage` 与 `mcp_config` 修改的是应用状态而不是 workspace 文件，因此不走文件沙箱，而是直接询问 `ApprovalService`：当前 session 的沙箱模式为 `danger-full-access` 时直接执行；否则每次写入都以工具名和一句可读原因写入 `approval/asked`，只有 `allowed-once` 才继续，审批策略为 `never`（例如子代理）时被拒绝。只读动作（`list`、`validate`、`reload`）不询问。

## Session log 与恢复

每个 session 的全部事实都在 `stateRoot/sessions/<id>/log.jsonl`：首行是 header，其后每行是一个事件或打包的 chunk 行。写入以 200 ms 为批次按序追加。

- **模型可见 ⟺ 已记录**：请求只从 `session.deriveMessages()` 与已记录的 `request/header` 构造。
- **崩溃修复**：加载时容忍一条截断的尾行，并为中断的 turn 合成收尾事件：未开始的工具调用得到 `TOOL_NOT_STARTED`，结果未落盘的调用得到 `TOOL_OUTCOME_UNKNOWN`，随后补 `step/end` 和中断的 `turn/end`。审批和问题各自贡献修复，未决的请求关闭为 `unavailable`。修复不会重放任何工具副作用。
- **Fork**：只能在 turn 边界 fork，`subagent_fork` 以父会话已完成的 turn 作为子会话种子。子会话的 log 不复制这段前缀：header 记下父会话、种子长度（`seedLength`）和最后一个种子事件的类型与时间（`seedRef`），打开子会话时从父会话（内存中、磁盘上或 `sessions/.trash/` 里）读出这些事件并核对最后一个；父会话已不在或不再含有这些事件时，子会话打不开（与 header 损坏同样提示）。内存里子会话仍从完整前缀开始，历史分页、种子隐藏、修复与轨迹读到的事件不变。0.2 之前写下的子会话（前缀复制在自己的 log 里）照常打开。

旧内核的 `history.jsonl`、`_checkpoint.json` 和 `runtime/events.jsonl` 已不再使用。首次启动新内核时，已有的 `sessions/` 目录会整体移到 `sessions.legacy-<时间戳>`（`harness/host/services.ts` 的 `archiveLegacySessions()`），不会删除。

## 子代理与后台任务

- `subagent` 创建不共享父上下文的子 session；`subagent_fork` 创建继承父会话已完成 turn 的子 session。两者默认后台运行并立即返回 id，结束时父会话收到通知；`run_in_background: false` 时同步等待结果。
- `send_message` 让子代理开始新一轮，`interrupt_agent` 中断，`list_agents` 列出子代理；子代理用 `report` 向父会话汇报。最大嵌套深度 3。
- 子代理的沙箱模式在创建时从父会话继承，审批策略为 `never`，提权请求被自动拒绝。
- `bash` 的 `run_in_background` 把命令交给 `JobRegistry`，用 `job_output`、`job_list`、`job_kill` 管理。每个 owner 最多 10 个运行中的 job；job 结束时空闲的 owner 会被唤醒（默认不限次数），运行中的 owner 在下一步收到通知。用户在「后台任务」里停止的 job（`tasks.cancel`）结束后，owner 在下一步收到「用户已手动停止」的通知（不唤醒）；Agent 自己 `job_kill` 的 job 不再通知。
- `workflow` / `ralph` 由 `WorkflowEngine` 执行：每次运行在一个受 SEC-08 约束的 Node 子进程里跑脚本（KRN-09，`process-worker.ts`：不读工作区与 Emperor Home、只写自己的临时目录、无网络，`--max-old-space-size` 默认 512 MB，运行超过 30 分钟以 `WORKFLOW_TIMEOUT` 结束；Electron 中以 `ELECTRON_RUN_AS_NODE` 运行应用自带的二进制；沙箱不可用时拒绝运行，不在沙箱外静默运行。脚本仍在 vm realm 内，realm 被绕过时也只能拿到这个受限进程；消息走结构化克隆的 IPC 通道），脚本的 `agent()` 经 `spawn` provider 调用 `SubagentManager` 创建前台子代理（`callId` 为工具调用 id，结束后释放）；带 `schema` 的子代理通过仅对其可见的 `structured_output` 工具交付结果。运行记录以 `tool-workflow/*` 事件写入调用方 session，投影为 `workflow_started` / `workflow_progress` / `workflow_finished`。进程入口是把自包含的工厂函数序列化后写进该次运行的临时目录、作为子进程脚本启动，源码模式与打包后的 `out/main` 走同一条路径。`run_in_background: true` 的 `workflow` 作为 `workflow` 类后台任务登记到 `JobRegistry`：调用立即返回任务编号，运行结束时按后台任务的规则通知或唤醒调用方，`job_kill` 取消运行。
- CoreApi `tasks.*` 把后台 job、子代理会话与工作流运行（`kind: 'workflow'`，可读记录、取消）列在一起；桌面端的环境信息卡用共享 `agents.list` 树显示根会话的子智能体，用 `tasks.list` 显示后台任务，用 `tasks.transcript` 查看后台命令输出和工作流记录，用 `tasks.cancel` 停止运行中的后台命令或工作流；子会话视图用 `tasks.cancel` 停止运行中的子代理。`tasks.resume` 已退役，继续子代理需在对话中让主 Agent 使用 `send_message`。

### 任务树与预算

每个根会话有一棵任务树（`harness/host/task-tree.ts`）：它和它的子代理启动的全部子代理、子会话、后台 job，以及宿主为每个子代理保留的 projector 与订阅。

- **生命周期**：子代理被 dispose（根会话停止、工作流收回它的子代理）时，它的后台 job 立即停止，驱动空闲后从宿主的 `agents`、`projectors`、`unsubscribes` 中移除，日志随后关闭。根会话卸载时整棵树一起清理。永久删除根会话（最近删除里「永久删除」或 30 天到期）时，按日志里的 `subagent/started` 递归找出全部子会话，删除它们的目录，以及根会话和子会话的 spill 目录（`spill/session-<hash>/`）。
- **任务**：用户（或定时任务）每给根会话发一条消息，就开始一个新任务，直到下一条消息为止；预算按任务计算，只保存在内存里，重启后从零开始。
- **步数**：一个 turn 最多 `maxSteps` 步（默认 400）；定时任务的 turn 与 Goal 轮次最多 `maxBackgroundSteps` 步（默认 120）。到达后下一步不再开始。
- **费用**：`model_config.json` 的 `policy.cost.maxUsdPerAgentTurn` 现在是一个任务的上限：根会话、全部子代理和失败的请求都计入，按条目的 `pricing` 在每次请求返回后累计。达到上限（或上限开启时有无法计价的用量）后，树里每个 Agent 做完当前这一步就停下，不再启动新的子代理，根会话不再被通知唤醒，直到用户的下一条消息；根会话的 Goal 被解除自动推进。
- **并发与总数**：同时运行的子代理最多 `maxActiveAgents` 个（默认 8），多出的等空位（排队，不报错）；在前台等待子代理结果的父代理把自己的名额让给子代理。一个任务最多启动 `maxTotalAgents` 个子代理（默认 64），再启动时工具返回 `AGENT_BUDGET_EXCEEDED`。工作流的 `agent()` 同样计入。
- **结果唤醒**：子代理的结果（结束通知、`report`）在父代理空闲时唤醒它，每个父代理每个任务最多 `maxNoticeWakes` 次（默认 32）；之后的结果放进父代理的下一步，第一次拒绝时在父代理的日志里写一条说明。
- **Goal**：根会话还有运行中（或排队中）的子代理或后台 job 时，Goal 不开始新一轮；它们结束后再继续。轮次提示要求模型在只剩等待时结束本轮，不要睡眠或轮询。
- 设置在 `settings.json` 的 `taskBudget`（「设置 › 高级 › 任务预算」，CoreApi `tasks.budget` / `tasks.setBudget`），修改后从每个任务的下一次判断起生效。

## Turn 的结束语义

最终回复只表示该 turn 停止生成，不代表做过验收。需要跨多轮持续推进的任务使用 Goal，见 [Goal 架构](goal-mode.md)。

## 修改时的同步面

- 新 middleware：在 `harness/agent/middleware.ts` 的对应数组登记，并在 `HarnessHost.compose()` 中按顺序压入。
- 新增依赖「哪个会话」的能力：显式接收会话或 `SessionScope`，从调用的 `view` 或输入取会话，不读 CoreApi 的 `focusedSessionId`（门面架构测试会失败）。
- 新 session 事件类型：通过 `declare module '../../session-log/types'` 扩展 `SessionEventMap`，需要界面可见时同步 `harness/projection/`。
- 新工具：见[扩展 Emperor Agent](../development/extending-emperor.md#新工具)。
- 改变压缩、修复或 fork 语义时，同步 session-log 与 compaction 的测试。

## 外部子会话

`subagent` 可显式选择 claude-code/codex；internal 保持默认。`dlg-*` 是持久会话，`dgr-*` 是单轮 task，原生 ID 独立保存。队列继续沿用原生会话，Codex steer 绑定当前 turn；输出刷新 UI，终态才投递稳定去重通知。[完整生命周期](external-agent-delegation.md)。
