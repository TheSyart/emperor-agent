# 权限与 Plan 架构

> 文档状态：Active<br>
> 面向读者：Core 开发者、安全审查者、维护者<br>
> 最后核验：2026-09-22<br>
> 事实源：`packages/core/src/harness/sandbox/`、`packages/core/src/harness/approval/`、`packages/core/src/harness/plan/plan-mode.ts`、`packages/core/src/harness/questions/`、`packages/core/src/harness/host/interactions.ts`、`packages/core/src/harness/tools/builtin/skill-manage.ts`、`packages/core/src/harness/tools/builtin/mcp-config.ts`、`packages/core/src/api/mutation-guard.ts`

Agent 能做什么由两个独立旋钮决定：**沙箱模式**限制文件写入范围，**审批策略**决定需要批准的操作是否询问用户。用户看到的是把两者打包在一起的**权限预设**。Plan 模式是独立的会话状态，不是第四种权限。

## 权限预设

| 预设                 | 沙箱模式             | 审批策略 | 行为                                                          |
| -------------------- | -------------------- | -------- | ------------------------------------------------------------- |
| `read-only`          | `read-only`          | `ask`    | 可以读取任何文件；任何修改都需要一次经批准的提权              |
| `workspace-write`    | `workspace-write`    | `ask`    | 可以写入当前 workspace 和系统临时目录；更大范围的重试需要批准 |
| `danger-full-access` | `danger-full-access` | `never`  | 不限制文件写入，也不弹出审批；需要审批的操作会被自动拒绝      |

新 session 固定使用默认预设 `workspace-write`。切换入口是 `/permissions <preset>`、Composer 的权限选择器和 `control.setPermissionMode`。选择记录为 session log 中的 `permission/preset`，随后只记录实际发生变化的 `sandbox/mode` 与 `approval/policy` 事件；当前预设从 log 推导。两个旋钮不对应任何预设时显示为 `custom`，该值不可选择。

权限状态完全存放在 session log 中，没有跨 session 的持久权限规则；旧版 `settings.json` 的 `permissions.rules` 在读取时被忽略。

## 沙箱模式

| 模式                 | 文件效果                                  |
| -------------------- | ----------------------------------------- |
| `read-only`          | 受限操作不能修改文件                      |
| `workspace-write`    | 只能写入 session workspace 与系统临时目录 |
| `danger-full-access` | 不限制文件效果                            |

执行方式：

- `write` / `edit` 在进程内做路径围栏：`read-only` 直接拒绝；`workspace-write` 在写入前重新解析真实路径（能发现被替换的符号链接祖先），要求目标位于可写根内。
- `bash` 在受限模式下通过 OS 沙箱运行：macOS 使用 Seatbelt（`sandbox-exec`），Linux 使用 bubblewrap（启动时做一次功能探测）。其他平台没有后端，`read-only` 与 `workspace-write` 下的 `bash` 在启动前失败（fail closed），只有 `danger-full-access` 才会执行 Shell。
- 沙箱只限制文件写入，不限制网络和读取。`read`、`glob`、`grep` 不受沙箱限制。
- `memory_edit`、`scheduler`、MCP 工具与 Skill 加载不经过文件沙箱，也不需要审批；Memory 是应用状态，MCP server 的能力由其配置决定。
- `skill_manage`（Skills 文件夹）与 `mcp_config`（`mcp_config.json`）同样不经过文件沙箱，但写入动作跟随权限预设：沙箱模式为 `danger-full-access` 时直接执行，其他模式下每次写入都通过 `ApprovalService` 询问一次，审批策略为 `never` 时被拒绝。查看类动作（`list`、`validate`、`reload`）不询问。

Chat 会话的 workspace 是 `stateRoot/workspace/` 下的可写目录；Build 会话的 workspace 是绑定的项目目录。

## 一次性提权

`bash`、`write`、`edit` 的参数都可以带 `sandbox_permissions`（`workspace-write` 或 `danger-full-access`）和一句 `justification`。请求的模式必须严格宽于当前有效模式；审批服务向用户询问一次，只有 `allowed-once` 才让这一次调用以更宽的模式执行，授权不会延续到之后的调用。

审批策略为 `never` 时，需要审批的请求被确定性地拒绝，系统提示词也会告诉模型不要请求提权。子代理的审批策略固定为 `never`，因此子代理内的提权总是被拒绝。

每次询问在 session log 中记录为 `approval/asked` 与 `approval/decided`。结果只可能是 `allowed-once`、`rejected`、`cancelled` 或 `unavailable`；应答方缺失或出错时 fail closed 为 `unavailable`，崩溃修复会把没有决定的询问关闭为 `unavailable`。

## 工具执行管线中的决策

单次工具调用的顺序是：参数校验 → pre-execute middleware（取最严格的 allow / ask / deny）→ 需要时审批 → guard → 工具体。当前唯一的 pre-execute 来源是 Hooks 的 `PreToolUse`，它可以返回 deny 或 ask，但不能放宽沙箱。一次性提权的审批发生在工具体内部、任何副作用之前。

## 用户问题

`ask_user_question` 可以一次提出多个问题，每个问题有稳定 `id`、可选 `header` 和选项，`multi_select: true` 时允许多选，用户也可以给出自定义回答。答案以 `{ answers: [{ id, selected, custom? }] }` 形式作为普通工具结果返回。问题在工具调用内阻塞，直到用户回答、取消或 turn 被中止。

## Plan 模式

`harness/plan/plan-mode.ts` 的 Plan 模式只通过提示词生效：

- 进入：`/plan` 或 `/plan <message>`（同时提交该消息），或 `control.setMode('plan')`。离开：`/plan off`，或 `exit_plan_mode` 获得批准。
- 进入后系统提示词加入 `plan:policy` 章节：先只读探索，不修改文件、不改配置、不提交；只对用户拥有的选择使用 `ask_user_question`；最终以 `exit_plan_mode` 提交以 `#` 标题开头的完整计划。
- 工具目录在 Plan 模式下保持不变，以维持请求缓存；没有 guard 阻止修改类工具。实际写入仍受当前沙箱模式约束。
- `exit_plan_mode` 通过问题服务发起审阅，选项为 **Approve** 与 **Keep planning**。Approve 离开 Plan 模式，从下一步开始执行计划；Keep planning 保留 Plan 模式，并把用户的反馈（`control.commentPlan`）作为工具结果返回给模型。审阅通道不可用或被取消时保持 Plan 模式。
- turn 运行中请求的切换会排队，在下一个 step 边界以一条 `plan/mode` 事件生效；用户发起的切换会以通知告知模型。

Plan 模式与权限预设相互独立：在 Plan 模式中切换预设，只改变之后的写入范围。

## CoreApi mutation guard

`packages/core/src/api/mutation-guard.ts` 保护由界面发起的状态修改（Scheduler、Skills、Plugins、模型与 MCP 配置、Task 取消等）：当前 session 有待处理交互时返回 409，处于 Plan 模式时返回 403。Git 写操作另外通过 workspace mutation coordinator 按 worktree 串行。

## 用户直控 Terminal

Build 工作台的 Terminal 是用户直接操作的系统 Shell，不属于 Agent 工具调用，不经过沙箱或审批，也不进入聊天记录、模型上下文或 session log。Core 仍校验 owner session、项目初始 cwd 和 terminal ID，并在 session 或应用关闭时清理。

## 修改时必须同步

- 新预设或旋钮：`harness/approval/presets.ts`、`commands/builtins.ts` 的 `PERMISSION_PRESET_VALUES`、renderer 权限选择器和用户文档。
- 新受限工具：复用 `harness/sandbox/escalation.ts` 的 `escalationFields` 与 `approveEscalation()`，不要自建审批通道。
- 修改应用配置而非 workspace 文件的工具：参照 `skill_manage` / `mcp_config`，在写入前按沙箱模式判断并调用注入的 `ApprovalService.request()`，拒绝、取消或通道不可用时抛出 `ToolError`。
- 新沙箱后端：`harness/sandbox/backend.ts` 的平台链、profile 生成与拒绝特征测试。
- 新交互类型：`harness/host/interactions.ts`、`harness/projection/interactions.ts`、`control.*` operation 与 renderer 底部面板。
