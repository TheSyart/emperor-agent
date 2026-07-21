# 诊断与排障

> 文档状态：Active<br>
> 面向读者：遇到启动、模型、会话、工具或打包问题的用户和开发者<br>
> 最后核验：2026-07-21<br>
> 事实源：DiagnosticsService、桌面诊断面板、当前构建与运行脚本

先进入“设置 → 诊断”。诊断页会集中显示生效路径、配置文件状态、workspace fence、生命周期、迁移结果、环境能力、Scheduler、External 和桌宠信息。不要先手工删除 `stateRoot`。

## 快速判断

| 现象                                   | 首先检查                                                                                                                 |
| -------------------------------------- | ------------------------------------------------------------------------------------------------------------------------ |
| 页面白屏或窗口打开后无内容             | `npm --prefix desktop run build`，再检查 `desktop/out/renderer/index.html`                                               |
| 显示“必须在 Electron 中使用”           | 当前页面没有 preload Core bridge；完整产品不能在普通浏览器独立运行                                                       |
| 模型未配置或认证失败                   | 设置 → 模型中的协议、API Base、模型 ID 和 API Key；输入框中的当前模型                                                    |
| 模型偶发重试或长时间无响应             | owner session 的 `model_attempt_*` 诊断事件、错误分类、Retry-After 与总 deadline；不会暗中切换模型                       |
| Prompt 缓存突然失效                    | `Prompt Cache Break` 行的 expected/unexpected、reason、首个 section/message 和 stable hash                               |
| 子代理取消后仍像在运行                 | 对应 `task_started` / terminal V2 事件、Task record revision 和 parent turn 是否已取消                                   |
| 子代理输出显示被截断                   | `stateRoot/tasks/<task-id>/output.meta.json` 的 limit / dropped bytes；不要手工扩大或替换 output                         |
| 命令取消后仍有子进程                   | `Owned Process Runtime` 行、`stateRoot/processes/receipts.v1.json` 的 owner/status/identity；不要直接 kill 复用 PID      |
| 模型能回复但工具失败                   | 当前权限模式、Ask/Plan 卡片、workspace 和工具输入                                                                        |
| 同类 shell 命令权限结果不同            | 权限 Ask 的 rule/source/trust/precedence 与脱敏 Shell AST reason；重点检查 flags、redirect、substitution                 |
| Build 读到错误项目                     | 当前 session 的 project path、诊断页 workspace fence、是否切错会话                                                       |
| Code Intelligence 不可用或结果 partial | `Code Intelligence` 行的 effective mode、reason、graph skipped/capacity、LSP state/restarts/protocol；默认关闭是预期状态 |
| 会话刷新后卡片缺失                     | session runtime event 日志、bootstrap replay 和 reducer 投影                                                             |
| Goal 无法 Resume                       | owner session、workspace fingerprint、Goal diagnostics 和 pending interaction                                            |
| MCP 没有工具                           | 插件页/Diagnostics 的 state、generation、auth/health、错误码，再查 `mcp_config.json`、命令/URL 和环境变量                |
| Scheduler 没执行                       | job 是否启用、next run、run history、pending Ask/Plan、owner session actor 和 Goal 全局锁                                |
| Core 暂不可用                          | `Lifecycle Supervisor` 是否 ready；具体 service 是 failed、stop_timeout 还是尚未 ready                                   |
| Hooks 不生效                           | hooks enabled、matcher、项目 trust/digest、测试结果和 audit                                                              |
| External adapter 未就绪                | `external_config.json` 的 mode/config status、owner session、`secretEnv` 环境变量、loopback 端口和 External audit reason |
| 文件回退按钮不可用                     | 文件检查点是否启用、检查点是否 ready、冲突列表和私有制品完整性                                                           |
| Git 软回退按钮不可用                   | `workspace.gitRewind.mode`、evaluation receipt、HEAD ancestor、Git operation/index/submodule/sparse/filter、无关脏路径   |

## 本地命令

查看基础状态：

```text
/status
/model
/tokens
/tools
/skills
/memory
/mode status
/plan status
/goal status
```

Diagnostics 的 `Command OS Sandbox` 行显示实际 backend 和 capability：

- `macos-seatbelt · 可用`：命令由系统 Seatbelt profile 包装；
- `linux-bwrap · 可用/不可用`：同时反映 helper 与 user namespace probe，不以文件存在冒充可执行；
- `windows-unsupported · 不支持`：当前没有 Job Object + ACL 等价实现，mutation command 会在 spawn 前拒绝；
- `run_command` 要求 `decision=sandboxed`。若 runner 异常返回 `decision=unsandboxed`，工具会把结果按失败处理；`decision=denied` 或 `containment_unavailable` 表示命令没有启动。

Sandboxed 命令默认不能访问 `stateRoot`、workspace 外文件或网络。依赖 HOME 配置、联网下载或写系统目录的命令因此失败是策略结果，不要通过 symlink、子 shell 或换解释器绕过；应改用受管安装/网络能力，或等待对应平台 backend/policy 明确开放。

Diagnostics 的 `Owned Process Runtime` 行是另一层状态：`owned · process_group/taskkill` 表示 owner/lease/reparent/orphan reconcile 已启用，不表示所有平台都有同等 sandbox。当前只提供受管 interactive stdio，没有 PTY 和 resize，也没有独立桌面终端。命令、Hook 和 MCP stdio 都有明确 output quota；普通 `run_command` 超额会终止，Hook 使用逐流尾部截断策略。应用关闭默认清理所有 owned process，不支持让 daemon 脱离 Emperor 长期存活。

## 有效配置与来源

“设置 → 诊断 → 配置”会在模型/本地配置状态之后列出 `permissions.rules`、`sandbox.runtime`、`mcp.config`、`external.signedWebhook`、`code.intelligence`、当前可见的 `skills.<name>` 和 `agentDefinitions.<name>`。每行显示最终 `layer:source`、trust、trace 层数、被拒绝候选数和生效值摘要。Build session 的项目 Skill 应显示 `project:skill:project:<name>`；切回 Chat 后应回到 user 或 builtin。AgentDefinition 冲突的低层来源会留在 trace，但不会把低层 prompt 正文送到 UI。

MCP 的 args、env、headers 和 URL，以及 External 的 owner session、`secretEnv` 名和 outbound URL，在有效配置里统一显示 `[REDACTED]`；secret source 只说明来自哪层，不返回值。该 snapshot 没有时间戳，相同事实源会产生相同 revision，适合对比两次刷新。`config.effective` 和 Diagnostics 都是只读解释面：读取损坏配置不会移动、重写或隔离原文件；正常 runtime 启动时的 corrupt recovery 仍按各 config store 的既有规则执行。

有效配置不是新配置文件，也没有统一“保存”按钮。修改仍回到原入口：权限/local 字段修改 `emperor.local.json`，MCP 使用插件页，Skill 使用对应目录/Skill 管理入口，AgentDefinition 使用受信 manifest。看到 untrusted project candidate 被拒绝时，不要通过复制到 managed/user 层伪造信任；先核对项目绑定和来源。

权限 Ask 的聊天卡片只显示脱敏工具名、风险、短原因和命令摘要，不显示 trace、explanation 或参数 JSON。完整规则候选、source/trust/precedence、Shell AST 摘要与 fingerprint 只保存在本机私有 diagnostics 元数据。`pipeline`、`redirection`、`command_substitution`、`outside_path_argument`、`dynamic_expansion`、`too_complex` 或 `parser_failure` 表示 Core 无法确定性分类；在 `smart_auto` 中语义分类失败会回退 Ask。批准只回答“本次是否尝试”，后续仍须通过 OS containment。

## 文件检查点与回退（Beta）

文件检查点默认关闭。需要试用时，在“设置 → 配置”编辑 `emperor.local.json`，加入以下字段并重启应用：

```json
{
  "workspace": {
    "fileCheckpoints": {
      "enabled": true
    },
    "gitRewind": {
      "mode": "eval"
    }
  }
}
```

启用后进入“设置 → 诊断 → 文件检查点（Beta）”。每条记录显示工具、时间、相对路径、变化类型和已保存字节。先点击“预览回退”；Core 会重新计算当前文件哈希并检查私有制品。只有整组无冲突时才出现“确认回退这些文件”，第二次点击才提交 `confirmed: true` 并恢复。

以下情况会禁止整组回退：文件在 Agent 完成后又被编辑、路径变为符号链接或目录、before/after 内容因配额只保存了哈希、制品缺失或 SHA-256 校验失败。先保留当前工作区和 `stateRoot/sessions/<session-id>/file-checkpoints/` 做只读排查，不要手工改写索引来绕过冲突。

当前只覆盖 `write_file`、`edit_file`、`delete_file`、`rename_file` 和 `apply_patch`。Shell 命令、MCP、外部应用和用户手工编辑产生的写入不会自动获得 before 快照。纯文件按钮不会调用 Git；它是按工具调用保存的本地恢复层，不是版本控制、备份或跨进程执行续跑。

`gitRewind.mode="eval"` 只增加只读 Git capture/预览，不允许 mutation。只有发行 host 注入与本机 platform/Git version 匹配的安全评估 receipt 时，显式 `on` 才会出现“Git 软回退与文件回退”按钮；当前没有通用 production receipt，因此默认和普通本地配置都不会静默启用。Git 按钮会显示提交数、是否需要 stash 和无关脏路径，并要求独立二次确认。成功后 HEAD 只做 soft reset、index 被 unstage、文件仍走上述哈希检查；原 HEAD/index 和可选 stash 的 `refs/emperor-agent/rewind/<transaction>/...` 救援引用会显示在结果中且不会自动删除。

Git 路径绝不执行 hard reset、checkout 或 clean。目标 HEAD 不是当前 ancestor、存在 merge/rebase/cherry-pick/bisect/sequencer、unmerged index、submodule、sparse checkout、linked worktree、项目内私有 `stateRoot`，或 stash 可能触发 local filter 时会直接禁止。进程在中间阶段退出只会把 journal 标成 interrupted 并要求按救援引用人工检查，不会在下次启动时猜测式 reset/apply。

若面板提示“已隔离损坏的 Git 软回退事务日志”，Core 已停止读取该日志并将原文件改名为 `transactions.v1.json.corrupt-*`；这一步不执行任何 Git 命令。先保留面板显示的备份和仓库内 `refs/emperor-agent/rewind/` 做人工核对，不要把损坏 JSON 改名放回去，也不要据此假定某次回退已完成。

## Lifecycle Supervisor

正常启动时，诊断行显示全部 required service ready；当前集合是 `process-runtime`、`code-intelligence`、`task-runtime`、`subagent-supervisor`、`session-runtime`、`mcp`、`scheduler`。Code Intelligence 默认 `off · idle`，这不影响 lifecycle ready；`eval` 表示只允许内部评估，`on` 才可能注册 Build 工具。该行会显示 graph manager/file/cache、skipped/parse、LSP ready/restart/protocol、query/fallback/event；protocol hard failure 变红，`eval` 或降级为黄色。`Subagent Supervisor` 行另列 active/global/per-session 容量；达到容量时新派遣会被拒绝，等待或取消既有 Task，不要递归重试。出现 `core_unavailable` 表示请求在进入领域 API 前已被拒绝，并不表示 turn 已提交；等待应用完成启动后重试。若长期停在 failed，查看该行列出的 service/phase，再检查 process receipt、Code Intelligence/LSP、MCP 配置、Task 数据或 Scheduler store。`stop_timeout` 表示关闭 deadline 已到，Supervisor 已继续关闭其他服务；重启后会重新 reconcile，不能把旧 `running` 记录理解为仍在运行。

`Agent Definitions` 行显示已 materialize 的 agent 数和 active/total source。正常安装至少有 `builtin:system`；出现 resolver 冲突/错误时该行变红。`project_untrusted`、`plugin_signature_unverified` 表示来源未激活，不是空 agent；`manifest_path_traversal`、`prompt_symlink_rejected`、`invalid_manifest_json/schema` 应先隔离对应 source 文件；`cross_source_collision` / `alias_collision` 表示低优先级候选已被拒绝。可选全局 user source 位于 `stateRoot/agents/agents.json`，当前没有项目自动扫描或未签名 plugin 安装 fallback。不要通过手改 trust/rank、软链接 prompt 或把 command/URL 塞进 manifest 绕过错误。

Lifecycle 中 `mcp=ready` 只表示 MCP 管理服务已经启动，不表示每个外部 server 都健康。具体连接以 `mcp.status` / Diagnostics 的 per-server state 为准：`auth_failed` 先修 credential；`backoff` 显示下一次有界重试；`failed` 表示重启预算已耗尽；`degraded` 表示当前 generation 的 transport/call 已异常，后续调用会先恢复连接。`mcp_connection_state` 是 diagnostic event，不会成为聊天消息或模型上下文。

刷新 bootstrap、模型、Skills、Tools 和记忆：

```text
/reload
```

`/clear` 只清空当前屏幕，不删除会话、记忆或 runtime 文件。

## Prompt Cache Break

诊断页读取最近的脱敏 `prompt-snapshots`，显示 cache-break 分类、原因、首个变化位置和 stable-prefix hash 前缀。`history_appended`、`dynamic_section_changed`、`memory_changed`、`skills_changed`、`fresh_attachment`、`tool_result_projection_changed`、`microcompact_applied` 等 expected 结果通常只是正常的上下文演进；`stable_section_changed_without_version` 或 `projected_history_rewritten` 为 unexpected，应保留相邻两个 snapshot 和对应 runtime events 排查。

快照只保存 hash tree 和计数，不包含可据此恢复的 prompt 正文。`prompt_cache_hit=false` 仅说明 provider 本次没有报告 cache read，不能据此判断回复错误；先核对 stable hash 和 cache-break reason，再检查 provider 是否支持或启用了缓存。

## 配置损坏

Model、MCP、local config 和 Hooks 使用原子写或损坏保留策略。无法解析时，Core 会尽量保留带时间或随机后缀的 corrupt backup，并使用安全默认值启动。

处理顺序：

1. 在诊断页确认文件路径和状态；
2. 退出应用；
3. 备份整个 `stateRoot`；
4. 对照 example/schema 修复配置，或通过设置页重新保存；
5. 重启并确认 diagnostics 不再报告 corrupt。

不要把包含 API Key 的原文件贴到公开 issue。

## 会话、记忆和 Goal

会话事实位于 `stateRoot/sessions/<id>/`。Goal 的 `events.jsonl` 是权威账本，snapshot 和 index 可以重建。

会话目录中的 `history.jsonl` 是兼容历史，`message_graph.v2.jsonl` 保存消息父链、当前 leaf、compact boundary、partial tombstone 和 prompt queue 状态。插话后看到 `message_tombstoned reason=interjected`、随后出现新的 assistant response 是正常收口；`orphan_partial` 表示启动恢复时发现 V1 中没有对应落盘行的半成品。不要为了隐藏旧 partial 而手工删 sidecar 行，否则会破坏 sequence、分支和 V1 双向投影。

若消息长期停在“已排队”，按同一 `prompt_id` 检查 `prompt_queued` 后是否出现 `prompt_dequeued`、`prompt_interjected` 或 `prompt_cancelled`，再检查 owner actor 是否仍 running。取消与排队竞态中，未消费的 interjection 应 cancelled，独立 queue command 应继续保留；两者一起消失属于缺陷。Sidecar 达到 16 MiB / 50,000 event 上限会 fail closed，应先完整备份 session 再处理，而不是截断正在使用的文件。

出现恢复问题时：

- 先保留相关 session 和 Goal 整个目录；
- 查看 `goals/diagnostics.json`、post-commit diagnostics 和 session runtime events；
- 修复 workspace/session 绑定后显式 Resume；
- 不要手工编辑 Goal JSONL、hash、Gate fact 或删除 diagnostics 强制继续。

任何无法证明安全的状态都会 fail closed，这不是普通 Chat fallback。

## Task 与子代理

子代理 Task 的权威状态位于 `stateRoot/tasks/index.json`，sidechain 与完整输出分别位于 task 子目录的 `transcript.jsonl` 和 `output.log`。后台派遣会返回 Task ID；主 Agent 使用 `manage_subagent`，桌面 IPC 使用 `tasks.wait/readOutput/cancel/resume`。控制入口只接受 owner session。取消会先提交 durable `cancelled`，再 abort 内存 handle；如果模型、工具、命令或 MCP 返回迟到结果，Task revision/CAS 会拒绝它，不应出现 terminal 回退。应用在运行中崩溃后，旧 runtime-managed `running` 记录会在下次启动标为 `interrupted`，不会假装恢复原 Promise；`stateRoot/subagent-worktrees/.leases.json` 中的遗留 worktree lease 会在启动 reconcile 时重试清理。

Task metadata 中的 `agent_definition_revision` 和 `agent_source_id/kind/trust` 是本次执行实际 materialize 的来源证据。model profile、Skill、Hook、MCP server 或 sandbox 被 Definition 拒绝时会在副作用前 fail closed；不要把它误判为工具缺失后改用未受控 shell。Definition allow 也不能覆盖 Permission、workspace 或 OS sandbox deny。

`task_output_truncated` 表示输出已达到固定字节配额：已保存前缀仍可按 cursor 读取，metadata 会记录 limit 和累计 dropped bytes。它不是文件损坏。不要把 task 目录改成 symlink，也不要直接改写 `index.json`、output 或 metadata；复制整个 task 目录后再做只读分析。

## Owned process 与孤儿回收

进程最小账本位于 `stateRoot/processes/receipts.v1.json`。它只保存 owner/lease、脱敏 digest、sandbox、配额、PID/start identity 和终态，不保存命令、argv、环境变量或输出。`running` receipt 不是可恢复终端；应用重启后，Core 只在 boot marker 和 start identity 精确相同时终止并验证旧进程，PID 已消失/改变记为 `interrupted`，无法证明时记为 `orphan_unverified` 且不盲杀。不要手工把后者改成 reaped，也不要根据 receipt 中的 PID 自行批量 kill。

内部/IPC 控制使用 `processes.list/cancel/reparent`，只接受 active session。Cancel 和 reparent 都要求 receipt 当前 lease；reparent 会签发新 lease，旧 owner 的后续操作自然失败，且不能跨 session。当前 UI 主要通过 Diagnostics 观察，不提供任意命令 spawn 或原始 stdio 控制面。

## 工具调用卡住或结果缺失

在 session 的 `runtime/events.jsonl` 中，任意 `tool_run_queued` 都应按同一个 `toolCallId` 对应且只对应一个 `tool_run_completed`、`tool_run_failed` 或 `tool_run_cancelled`。流式模型撤回调用时出现 `reason=not_in_final_response` 的 cancelled tombstone 是正常收敛，不是丢数据；父 turn 取消时，尚未开始的队列项也应有 cancelled 终态。

如果同一 ID 没有终态或出现多个终态，先保留整个 session 目录和相关 Task artifact，再导出 envelope V2 replay 进行对账，不要手工补写 JSONL。正常调度中，并发安全工具可以同时运行；不安全或独占工具必须与其他调用零重叠。看到独占工具跨越另一个工具的 started/terminal 区间，说明调度屏障已被破坏，应作为 Core 缺陷处理，而不是重试 UI。

## 开发模式检查

```bash
npm run format:check
git diff --check
make check
```

UI 改动额外运行：

```bash
npm --prefix desktop run screenshots
```

打包链路：

```bash
npm --prefix desktop run package:verify
```

`make check` 失败时从第一条失败开始处理，不要只重跑最后一步。

## 提交问题

普通问题应包含：应用来源、平台与架构、复现步骤、期望结果、实际结果和脱敏日志。不要上传 API Key、环境变量、用户文档或完整 `stateRoot`。

安全漏洞不要公开披露复现细节，按 [Security Policy](../../.github/SECURITY.md) 使用私密报告入口。
