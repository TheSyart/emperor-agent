# 05. Task, Subagent, Runtime

Claude Code 的任务系统把后台 shell、子代理、主会话后台化、远程 agent、队友、workflow、monitor 都纳入统一 TaskState。它的价值不只是“能后台运行”，而是让所有长期运行单元都有统一生命周期、输出、进度、通知和恢复边界。

## TaskState 设计

核心类型在 `src/Task.ts`：

- `TaskType`
- `TaskStatus`
- `TaskStateBase`
- `TaskHandle`
- `TaskContext`
- `generateTaskId(type)`
- `createTaskStateBase(...)`

基础字段：

- `id`
- `type`
- `status`
- `description`
- `toolUseId`
- `startTime`
- `endTime`
- `totalPausedMs`
- `outputFile`
- `outputOffset`
- `notified`

设计要点：

- 每个 task 有稳定 ID 前缀，降低人类和 UI 识别成本。
- 每个 task 有 output file，长输出不必全部塞进 AppState 或模型消息。
- terminal status 有统一判断，便于清理和 UI 驱逐。
- `TaskState` 是 AppState 中的投影，不等于完整 transcript。完整消息链按 sidechain 文件恢复，UI 只在需要查看时懒加载。

Emperor 当前对照：

- `agent/runtime/active.py` 维护 active task registry，用于停止当前任务。
- Scheduler、Team、subagent、runner turn 各有自己的状态。
- WebUI runtime event 可回放，但长期任务状态没有统一 TaskState。

升级方向：

- 新增 `agent/tasks/`，先定义通用 `TaskRecord`。
- Scheduler run、subagent dispatch、team wake、shell background 都映射成 task。
- runtime event store 记录 task lifecycle，WebUI 只读 task projection。

## LocalAgentTask 与 Sidechain Transcript

`src/tasks/LocalAgentTask/LocalAgentTask.tsx` 管理本地子代理任务。重要设计：

- `agentId` 独立于主会话。
- `messages` 可用于查看 transcript，但 terminal 后可释放，避免内存泄漏。
- `pendingMessages` 允许中途向任务发送消息，在工具轮边界排出。
- `retain` 和 `diskLoaded` 支持 UI 查看时从 sidechain transcript 加载。
- `evictAfter` 控制终止任务在 panel 中保留多久。
- progress tracker 记录 tool use count、token count、recent activities。

`src/tools/AgentTool/runAgent.ts` 会把子代理消息写入 sidechain transcript：

- 初始 prompt + forked context 写入 agent transcript。
- 每条可记录消息按 UUID parent 关系追加。
- 子代理结束后清理 MCP、hooks、prompt cache tracking、file state、todos、shell tasks。
- transcript 记录带 `isSidechain=true` 和 `agentId`，主线只保留任务通知或最终摘要。
- 读取 sidechain 时从最新叶子节点反向重建链路，并带回工具结果 replacement 状态。

设计要点：

- 子代理不是主 history 的简单函数调用。
- 子代理有独立 transcript、独立 tool context、独立 permission mode、独立 MCP 增量。
- 主代理只收到摘要、通知和必要结果。

Emperor 当前对照：

- `DispatchSubagentTool` 使用独立 runner，但结果主要以字符串摘要回填主上下文。
- `TeamStore` 已经有 `.team/threads/*.json`、checkpoint、inbox。
- 子代理和 Team 是两套机制。

升级方向：

- 给所有 subagent run 创建 `TaskRecord(type='subagent')`。
- sidechain transcript 统一放入 `memory/tasks/{task_id}/transcript.jsonl`，不要混入主 history。
- 主 history 只放 task notification 和最终摘要。
- Team teammate wake 可复用同一个 Task Framework，但保留 `.team` roster/inbox 语义。
- transcript 需要支持按 offset/page 读取，避免 WebUI bootstrap 一次性加载长子代理对话。

## LocalMainSessionTask

`src/tasks/LocalMainSessionTask.ts` 支持把主会话当前 query 后台化：

- 用户将主会话 background 后，query 继续运行。
- UI 清空到新 prompt。
- 完成后通过 task notification 回到主消息队列。
- 输出写到独立 task transcript，避免 `/clear` 后后台 query 污染新主会话。

Emperor 当前对照：

- WebUI 有 `/api/runtime/stop`，但没有主 turn 后台化。
- Scheduler/Watchlist 可以后台投递 turn，但 Chat 主 turn 和后台任务边界仍相对固定。

升级方向：

- 先不要实现“主会话后台化”完整交互。
- 先把 visible turn、scheduler run、watchlist check 都登记成 `TaskRecord`，统一停止和状态展示。
- 后续再支持“把当前 Chat turn 放入后台继续跑”。
- 当主会话未来后台化时，应像 Claude Code 一样切到隔离 transcript，避免用户 `/clear` 或开启新 prompt 后，旧 turn 的工具 chatter 污染新的主线。

## runAgent 如何包装 query

`runAgent()` 做的事情远多于“传 prompt 调 query”：

1. 解析 agent model、agentId、transcriptSubdir。
2. 过滤 parent messages 中不完整 tool calls。
3. 克隆或创建 readFileState。
4. 获取 userContext 和 systemContext。
5. 对只读 agent 去掉冗余 CLAUDE.md/git status 上下文。
6. 根据 agent permissionMode 派生 getAppState。
7. 解析 agent 可用工具集合。
8. 构造 agent system prompt。
9. 决定 abortController：async agent 独立，sync agent 共享父级。
10. 执行 SubagentStart hooks。
11. 注册 agent frontmatter hooks。
12. 预加载 agent frontmatter skills。
13. 初始化 agent-specific MCP servers。
14. 创建 subagent ToolUseContext。
15. 写 sidechain transcript 和 metadata。
16. 调用 `query()`。
17. 记录 query 产出的可记录消息。
18. finally 中清理 MCP、hooks、cache tracking、file cache、todos、shell tasks。

Emperor 升级启示：

- 子代理运行上下文必须显式派生，不能隐式复用主 runner。
- 子代理权限应支持“可读、可写、后台不可弹窗、bubble 到主线程”等模式。
- 子代理清理必须集中，特别是 background shell、MCP、临时 skills、todos。
- 可以抽出 `run_local_agent(...)`，让 `dispatch_subagent`、Team wake 和未来 background main session 共用：模型路由、工具白名单、权限 resolver、runtime 事件、sidechain 写入、checkpoint、cleanup。

## Runtime 与 UI 投影

Claude Code 使用 AppState store 和 Ink 组件直接渲染任务面板。Emperor 使用 Vue runtime reducer 和后端 `RuntimeEventStore`。

Emperor 当前优势更适合长期演进：

- 后端事件日志是事实来源。
- WebUI 刷新可通过 `/api/bootstrap.runtime.events` 回放。
- localStorage 只是热缓存。

需要补齐：

- Task lifecycle event：
  - `task_created`
  - `task_started`
  - `task_progress`
  - `task_output`
  - `task_done`
  - `task_error`
  - `task_cancelled`
  - `task_evicted`
- Task projection：
  - Chat timeline 中显示摘要。
  - Task panel 中显示运行中任务。
  - 子代理/队友 transcript 可按 task_id 加载。

## 对 Team 的映射

Emperor Team 当前已有：

- `.team/config.json`
- `.team/inbox/*.jsonl`
- `.team/threads/*.json`
- `.team/checkpoints/*.json`
- `.team/cursors/*.json`
- `TeamManager.wake_teammate()`

这比 Claude Code 的 LocalAgentTask 更偏“持久队友”。升级时不要用 Task Framework 替代 Team Store，而是建立映射：

- TeamMember 是长期身份。
- 每次 wake 是一个 TaskRun。
- inbox/thread 是队友记忆和消息总线。
- task output/transcript 是某次执行的可审计记录。

这样 Team 可以同时保留“持久人格”和“每次运行可追踪”。
