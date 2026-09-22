# Agent 执行链路

> 文档状态：Active<br>
> 面向读者：Core 开发者、维护者<br>
> 最后核验：2026-09-22<br>
> 事实源：`packages/core/src/harness/host/host.ts`、`packages/core/src/harness/agent/`、`packages/core/src/session-log/`、`packages/core/src/llm/`、`packages/core/src/harness/compaction/`、`packages/core/src/mcp/`、`packages/core/src/skills/`

Emperor 的 Agent 内核是 `packages/core/src/harness/` 下的纯 TypeScript 实现，采用 deepseek-harness standard 模式的语义，但不含插件框架：各子系统在 `HarnessHost.compose()` 中把自己的处理函数压入有序的 middleware 数组。`HarnessHost` 是唯一组合根，每个 session 持有一个 `Agent`。

## 组合根

`HarnessHost.create()` 先通过 `createKeptServices()` 建立保留服务（Emperor Home bootstrap、session 索引、Memory、Projects、环境探测、Skills、Scheduler、MCP、进程运行时、模型配置），再组合内核：

| 组件                              | 位置                           |
| --------------------------------- | ------------------------------ |
| LLM client 与 model route         | `llm/`                         |
| Session log store                 | `session-log/store.ts`         |
| 系统提示词装配                    | `harness/prompt/assembler.ts`  |
| 工具注册表与执行管线              | `harness/tools/registry.ts`    |
| 沙箱策略与后端                    | `harness/sandbox/`             |
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

系统提示词由 `templates/agent/persona.md` 与各子系统登记的 prompt section 组成。提示词本身保持稳定，以维持 provider 前缀缓存；会变化的运行时信息（沙箱与审批策略、Plan 模式、Goal、委派说明）以 `form: 'snapshot'` 的上下文消息进入 log，只在内容变化时追加。

Pre-step middleware 的顺序是：工作区说明（AGENTS.md / CLAUDE.md）、长期记忆、Skill 目录、压缩、重复调用提醒、Hooks，Plan 模式与 Goal 在各自 install 时加入。请求失败时 `retryMiddleware()` 负责按 route 的重试策略重试。

## Turn 与 step

```text
turn/start
  step: 认领 inbox → pre-step middleware → step/start → user/message ×N
        → 从 log 推导请求 → assistant/chunk ×N → assistant/message
        → tool/call … tool/result（按模型顺序提交）→ step/end
  ……（直到本 step 没有工具调用、工具声明结束本 turn 或达到 max-tokens，且 next-step 为空）
turn/end
```

- **Inbox**：两个待处理列表。`next-turn` 中一条消息开启一个 turn；`next-step` 中的全部消息进入下一个 step。每次变化记录为 `agent/inbox/spliced`，恢复时从 log 精确重建。
- **Followup / steer**：普通提交是 followup（排队到 `next-turn`）；运行中的插话是 steer（进入 `next-step`）。`chat.manageQueuedPrompt` 的 `interject` 把排队项提升到 `next-step`，`cancel` 移除尚未开始的项。
- **没有最大步数**：内核不限制 step 数。turn-stopping middleware（例如 Hooks 的 Stop）可以追加一步。
- **取消**：`chat.stopRuntime` 或 `/stop` 取消当前 turn，并清理该 session 的待处理交互和子代理；由提交方 AbortSignal 触发的取消会保留 inbox。

## 模型调用

`llm/` 负责把 `model_config.json`（schemaVersion 2）中的条目解析为 route：

- `llm/catalog.ts` 是 Provider catalog，只描述访问方式（协议、默认 API Base、模型发现、reasoning 适配），不内嵌模型清单。
- `llm/route.ts` 的 `routeFromEntry()` 把条目解析为 `RouteSpec`。Provider 为 `deepseek` 时使用内置 fetch + SSE 适配器，其余 `openai` / `anthropic` 协议使用 pi-ai 适配器。
- `llm/retry-policy.ts`：默认对 `EMPTY_RESPONSE`、`RATE_LIMIT`、`SERVER`、`TIMEOUT`、`TRANSPORT` 最多重试 5 次，指数退避 500 ms 到 10 s、±10% 抖动；不大于上限的 provider Retry-After 会替换本地延迟。每次重试写入 `llm/retry` 事件。

全局只激活一个模型。`model_config.json` 中默认关闭的执行策略由 `harness/agent/model-policy.ts` 执行：备用模型是排在重试 middleware 之后的 request-error handler，重试用尽且错误类型命中触发条件时写入 `llm/fallback`，本轮剩余请求改用备用条目，下一轮回到主模型；每轮成本上限是 pre-step handler，累计本轮已计价用量达到上限后拒绝下一个 step（`llm/cost-cap`）。

## 工具执行

`ToolRegistry.prepare()` 对单次调用依次执行：参数校验 → pre-execute middleware（取最严格的 allow / ask / deny）→ 需要时审批 → guard → 在超时内执行工具体 → post-execute middleware → 结果观察者。任何失败都变成模型可读的错误结果，不会抛到循环外。

`harness/agent/tool-calls.ts` 按模型顺序分组：连续的并发安全调用共享一个滚动池（默认最多 10 个并行），非并发安全调用单独执行并形成屏障；`tool/call` 事件和 pre-execute 按模型顺序发生，只有工具体重叠，post-execute 与 `tool/result` 严格按模型顺序提交。中止时尚未开始的调用得到合成的 `ABORTED_BEFORE_DISPATCH` 结果，保证每个调用都有结果。

Post-execute 固定包含重复调用提醒（相同工具与参数连续出现时追加提示，不否决调用）、Hooks 的 PostToolUse，以及最后执行的大结果落盘：纯文本结果超过 50,000 字节时，完整文本写入 `stateRoot/spill/`，模型只看到首尾预览和文件路径。`read` 不参与落盘；界面可以通过 `tools.readResult` 读取落盘全文。

工具清单与语义见[工具与扩展能力](../user/tools-skills-mcp.md)，权限管线见[权限与 Plan 架构](control-and-permissions.md)。

## 交互阻塞在工具调用内

`ask_user_question`、`exit_plan_mode` 的审阅和一次性提权审批都在工具调用内部等待，没有“暂停 turn 再恢复”的机制。`PendingInteractions` 把等待中的请求投影到 `control.pending`，renderer 通过 `control.answerInteraction`、`control.approvePlan`、`control.commentPlan` 或 `control.cancelInteraction` 回答。turn 被中止时等待自动以 `cancelled` 结束；应答通道不可用时以 `unavailable` 结束（fail closed）。

## 压缩

`harness/compaction/` 有三个触发点：

1. **Step 前压力**：估算的上下文 token 数达到 `floor(contextWindow × 0.8)` 时，先用无模型的 pruner 截短超过 8,192 字符的旧工具结果，再重新测量；仍超出时对头部范围生成摘要，保留约 `contextWindow × 0.16` 的尾部内容。失败会记录但不中断 turn。
2. **上下文溢出重试**：请求返回 `CONTEXT_WINDOW_EXCEEDED` 时，先剪枝并以零保留预算摘要，只有表面确实缩小才重试。
3. **手动 `/compact`**：通过 `agent.runMaintenance` 执行。

摘要使用固定的 8 个章节（Primary Request and Intent、Key Technical Concepts、Files and Code、Errors and Fixes、Pending Jobs、Current Work、Next Step、Critical Context），以一条检查点 `user/message` 替换被压缩的范围。提交顺序为 `compaction/start` → 摘要调用 → `compaction/summary` → 检查点消息 → `compaction/end`。压缩只作用于 session log 的模型可见表面，不改写长期记忆。

## 长期上下文

- **工作区说明**：`harness/prompt/agent-instructions.ts` 先读取全局 `~/.emperor/AGENTS.md`，再从项目根（最近的 `.git` 祖先，否则 cwd）到 cwd 逐级读取 `AGENTS.md`、`CLAUDE.md`、`AGENTS.local.md`、`CLAUDE.local.md`。单文件最多读 1 MiB，总预算 65,536 字节，超出时先省略最宽泛的文件再截断最具体的文件。内容以 `form: 'instructions'` 的上下文消息在首个 turn 进入，发现集合变化时下一 turn 追加替换基线。
- **长期记忆**：`harness/memory/memory.ts` 把 `USER.local.md`（用户档案）、`MEMORY.local.md`（全局长期记忆）和 Build 会话的项目私有记忆作为一条上下文基线注入，内容变化时追加替换基线；每节最多 32 KiB。模型用 `memory_edit` 对这三个目标做精确字符串替换或追加，并沿用记忆版本快照。
- **Skill 目录**：Skill 名称和描述以 `form: 'catalog'` 进入上下文，集合变化时替换；`skill` 工具加载全文。用户消息中的 `/<skill-name>` 会让对应 Skill 说明直接进入该 step。目录来自该 session 自己的 Skill loader，见下文“Skills 与 MCP”。

## Skills 与 MCP

### Skill loader 与变更检测

- `skills/file-loader.ts` 的 `SkillLoaders` 按项目根缓存 `FileSkillsLoader`：`forProject(null)` 服务 Chat 会话，每个 Build 项目根各有一个 loader，并发 session 不会互相改写共享实例。每个 loader 按 project（`<project>/.emperor/skills`）> user（`stateRoot/skills`）> Plugin > builtin 合并来源，每次读取重新扫描；未通过校验的文件夹进入 `SkillScan.invalid` 并附原因。
- `HarnessHost.skillsLoaderFor(agent)` 按 session 的 Build 项目选择 loader，Skill 目录 middleware、`skill` 工具与 `skill_manage` 共用它；CoreApi 的 `skills.*` 通过 `sessionId` 走同一选择（`skillsForSession()`）。
- Skill 名称规则只有一处：`skills/name.ts` 的 `SKILL_NAME`（`^[a-z0-9][a-z0-9._-]*$`，最多 64 个字符），loader、Skill 服务、`requestedSkills` 和 `/name` 手势共用。名称取自 frontmatter `name`，文件夹名不同只产生警告。
- `skills/validate.ts` 是宽松校验：只检查 `SKILL.md` 及其引用的相对路径文件，跳过 `node_modules`、`.venv`、`venv`、`.git`、`__pycache__`，允许指向文件夹内部的符号链接，拒绝绝对链接与越界链接，frontmatter YAML 宽松解析并以警告报告。
- 写入侧是 `skills/library.ts` 的 `SkillLibrary`（个人与项目 scope 可写，builtin 与 Plugin 只读，`copyToUser` 生成个人副本）；导入由 `skills/import.ts` 把粘贴内容、本地文件夹、本地 zip 或 https 链接（GitHub 仓库 / `tree/<ref>/<dir>` / 直接 zip）物化到私有 staging 后逐个校验、复制。
- `skills/change-detector.ts` 的 `SkillChangeDetector` 用 chokidar 监听个人、已知项目与 Plugin 的 Skill 根（深度 3，忽略依赖与 VCS 目录，300 ms 防抖），`SkillLibrary` 与 Plugin 变化也会调用 `notify()`。变化后 host 刷新运行时上下文并发送 host-only 事件 `skill_catalog_changed`（带递增的 `catalog_version`），renderer 据此重新拉取 `skills.list`。内置 Skill 根不被监听。

### MCP 连接

- `mcp/client.ts` 按 server 创建连接（`mcp/connection.ts`）：`stdio` 通过受管子进程（`owned-stdio-transport.ts`）通信；`sse` 使用 SDK 的 SSE transport；`http` 先尝试 Streamable HTTP，初始握手失败时回退到 legacy SSE，认证失败不回退，`HttpConnection.activeTransport` 记录实际使用的传输。transport 未知或缺少 `command` / `url` 的 server 得到一个不会启动进程的无效配置连接并报告原因，不会回退为 `stdio`。
- `mcp/supervisor.ts` 负责重连：传输失败按 1、4、16 秒退避，每次重建递增 generation，迟到的旧连接事件被忽略。`harness/host/mcp-tools.ts` 的 `McpToolBridge` 把已连接 server 的工具注册为 `mcp_<server>_<tool>`。
- `mcp/import.ts` 的 `normalizeMcpImport()` 把 `mcpServers`、`servers`、`mcp.servers`、单个带 `name` 的 server 或裸“名称 → 配置”映射规范为 `mcp_config.json` 的 server 形状，JSONC 与片段经修复并给出警告。`mcp/manage.ts` 在此之上提供按名称合并（新增 / 覆盖 / 跳过，支持 dry-run）、启停与删除，CoreApi `mcp.*` 与 `mcp_config` 工具共用它；写入后由调用方重载 MCP，client 按 server diff，只重建变化的连接。

### 跟随权限预设的配置工具

`skill_manage` 与 `mcp_config` 修改的是应用状态而不是 workspace 文件，因此不走文件沙箱，而是直接询问 `ApprovalService`：当前 session 的沙箱模式为 `danger-full-access` 时直接执行；否则每次写入都以工具名和一句可读原因写入 `approval/asked`，只有 `allowed-once` 才继续，审批策略为 `never`（例如子代理）时被拒绝。只读动作（`list`、`validate`、`reload`）不询问。

## Session log 与恢复

每个 session 的全部事实都在 `stateRoot/sessions/<id>/log.jsonl`：首行是 header，其后每行是一个事件或打包的 chunk 行。写入以 200 ms 为批次按序追加。

- **模型可见 ⟺ 已记录**：请求只从 `session.deriveMessages()` 与已记录的 `request/header` 构造。
- **崩溃修复**：加载时容忍一条截断的尾行，并为中断的 turn 合成收尾事件：未开始的工具调用得到 `TOOL_NOT_STARTED`，结果未落盘的调用得到 `TOOL_OUTCOME_UNKNOWN`，随后补 `step/end` 和中断的 `turn/end`。审批和问题各自贡献修复，未决的请求关闭为 `unavailable`。修复不会重放任何工具副作用。
- **Fork**：只能在 turn 边界 fork，`subagent_fork` 以父会话已完成的 turn 作为子会话种子。

旧内核的 `history.jsonl`、`_checkpoint.json` 和 `runtime/events.jsonl` 已不再使用。首次启动新内核时，已有的 `sessions/` 目录会整体移到 `sessions.legacy-<时间戳>`（`harness/host/services.ts` 的 `archiveLegacySessions()`），不会删除。

## 子代理与后台任务

- `subagent` 创建不共享父上下文的子 session；`subagent_fork` 创建继承父会话已完成 turn 的子 session。两者默认后台运行并立即返回 id，结束时父会话收到通知；`run_in_background: false` 时同步等待结果。
- `send_message` 让子代理开始新一轮，`interrupt_agent` 中断，`list_agents` 列出子代理；子代理用 `report` 向父会话汇报。最大嵌套深度 3。
- 子代理的沙箱模式在创建时从父会话继承，审批策略为 `never`，提权请求被自动拒绝。
- `bash` 的 `run_in_background` 把命令交给 `JobRegistry`，用 `job_output`、`job_list`、`job_kill` 管理。每个 owner 最多 10 个运行中的 job；job 结束时空闲的 owner 会被唤醒（自上次用户输入起最多连续 3 次），运行中的 owner 在下一步收到通知。
- `workflow` / `ralph` 由 `WorkflowEngine` 执行：每次运行在一个 worker thread 里跑脚本（隔离事件循环、可强制终止，不是安全边界），脚本的 `agent()` 经 `spawn` provider 调用 `SubagentManager` 创建前台子代理（`callId` 为工具调用 id，结束后释放）；带 `schema` 的子代理通过仅对其可见的 `structured_output` 工具交付结果。运行记录以 `tool-workflow/*` 事件写入调用方 session，投影为 `workflow_started` / `workflow_progress` / `workflow_finished`。worker 入口是把自包含的工厂函数序列化后用 `new Worker(source, { eval: true })` 启动，源码模式与打包后的 `out/main` 走同一条路径。
- Task 面板（`tasks.*`）把后台 job、子代理会话与工作流运行（`kind: 'workflow'`，可看记录、取消）列在一起；`tasks.resume` 已退役，继续子代理需在对话中让主 Agent 使用 `send_message`。

## Turn 的结束语义

最终回复只表示该 turn 停止生成，不代表做过验收。需要跨多轮持续推进的任务使用 Goal，见 [Goal 架构](goal-mode.md)。

## 修改时的同步面

- 新 middleware：在 `harness/agent/middleware.ts` 的对应数组登记，并在 `HarnessHost.compose()` 中按顺序压入。
- 新 session 事件类型：通过 `declare module '../../session-log/types'` 扩展 `SessionEventMap`，需要界面可见时同步 `harness/projection/`。
- 新工具：见[扩展 Emperor Agent](../development/extending-emperor.md#新工具)。
- 改变压缩、修复或 fork 语义时，同步 session-log 与 compaction 的测试。
