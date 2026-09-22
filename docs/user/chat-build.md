# Chat 与 Build

> 文档状态：Active<br>
> 面向读者：使用普通会话或项目会话的用户<br>
> 最后核验：2026-09-22<br>
> 事实源：`packages/core/src/sessions/store.ts`、`packages/core/src/harness/host/host.ts`、`packages/core/src/harness/prompt/agent-instructions.ts`、`packages/core/src/harness/memory/memory.ts`、`desktop/src/renderer/src/components/conversation/`、`desktop/src/renderer/src/components/composer/`、`desktop/src/renderer/src/components/sidebar/`

Chat（普通对话）和 Build（项目工作）是会话类型。它们决定 Agent 的工作目录和能看到哪些长期上下文，不决定权限。

## Chat

Chat 适合问答、整理资料、解释内容和不依赖固定项目的轻量任务。上下文包括：

- 系统提示词和当前可用的 Skill 目录；
- 全局工作区说明 `~/.emperor/AGENTS.md`（如存在）；
- 用户档案 `USER.local.md` 与全局长期记忆 `MEMORY.local.md`；
- 当前会话的历史、附件和工具结果。

Chat 的工作目录是 Emperor Home 下的 `workspace/`，Agent 在这里创建的文件不会落到你的项目里。Chat 不会读取任何 Build 项目的私有记忆。

## Build

Build 绑定一个本地文件夹。Agent 在该目录内读取文件、按当前权限写入和执行命令，并装配：

- 从项目根到当前目录逐级发现的 `AGENTS.md`、`CLAUDE.md`、`AGENTS.local.md`、`CLAUDE.local.md`（总预算 64 KiB，越具体的说明优先级越高）；
- `stateRoot/projects/<project-id>/AGENTS.local.md` 中的全局私有项目记忆；
- 项目级 Skills `<project>/.emperor/skills`；
- 当前 Build session 的历史。

项目中的 `AGENTS.md` 等文件由你维护，Core 只读取，不会改写。全局私有项目记忆不在项目源码树中，Agent 可以通过 `memory_edit` 更新它。

## 对话视图

会话头部有 Chat / Trajectory 两个标签，右上角按钮用于打开或收起右侧详情栏。

- **空会话**：输入框居中显示；发送后你的消息以气泡出现，Agent 的回复随即流式输出。
- **思考**：模型的思考过程显示为可折叠的「思考」行，流式输出时只显示最新一行。
- **工具调用**：每次调用占一行，格式为 `图标 标题 · 摘要`。点开后按工具类型展示：终端输出、Diff、读取片段、搜索结果、网页来源、待办清单、已回答的问题、最终 Plan，其他工具显示通用的 IN / OUT。
- **运行状态**：正在进行的 turn 只显示一行状态和已用时间。每个完成的 turn 末尾有复制按钮，悬停可看到首字耗时（TTFT）和 tok/s 等信息。
- 重试、错误、达到最大输出 token、上下文压缩等情况以单独的行插在时间线中。

悬停工具行时出现 **Inspect**：点击后在右侧详情栏的 Inspect 标签中显示该调用的工具名与状态、输入、输出、元数据和耗时。其中的「在轨迹中查看」按钮会跳到本会话的 Trajectory 标签（`/chat/:id/trajectory?call=<callId>`）并定位到这次调用。

## 轨迹（Trajectory）

Trajectory 标签把同一份会话记录按 Turn → Step 展开成账本，便于逐条核对 Agent 实际做了什么：

- **账本**：每个 Turn 下依次列出用户输入、上下文注入、每次模型请求（Step）的消息、工具调用与结果、压缩；Turn 与工具调用都可以折叠。
- **时间线**：顶部按输入、模型、工具三条泳道显示耗时；拖动选区只看这段时间内的记录，滚轮缩放，右键拖动平移，右键或 Esc 清除。
- **搜索**：工具栏搜索框在全部记录中查找，回车 / Shift+回车在命中之间跳转。
- **检查器**：选中一条记录后，右侧详情栏显示它的详情。请求头可看 System Prompt、工具目录和与上一版的 Diff；模型请求可看参数、用量（输入、缓存、输出、推理）和 TTFT / tok/s；工具调用可看参数、结果、调用时的工具 Schema 与耗时；压缩可看摘要和原始输出。
- 过大的工具参数或结果在传输时会被截断，检查器会给出提示，点「加载完整内容」可从本地会话记录读取全文。

## 子代理

子代理的工具行可以点击，在同一视图中打开子会话（`/chat/<childId>`）：

- 头部显示面包屑链（根会话 → … → 当前子会话），点击任一上级即可返回。
- 子会话的输入框是只读的，提供「返回父会话」；子代理仍在运行时可以点「停止」中断它。
- 子代理运行期间，侧栏中父会话行显示「N 个子代理运行中」。子会话本身不会出现在侧栏列表里。

## 右侧详情栏

会话头部右上角的按钮打开右侧详情栏（默认 360px，可拖动在 300–520px 之间调整；窗口过窄时自动收起）。详情栏按标签页组织：Inspect、Git、Files、Terminal、Environment，以及有预览时出现的 Browser。

- **Inspect**：查看在对话中通过 Inspect 选中的工具调用详情，见上文“对话视图”。
- **Environment**：汇总 Git 状态、分支、活动 worktree、最近的安全 Git 操作凭据、当前 Goal、后台任务、子代理和终端。
- **Git**：按 staged、unstaged、untracked 和 conflict 查看 Diff；执行 stage、unstage、discard、commit、fetch、fast-forward pull、push、建分支、切分支和分支比较；创建或退出 Emperor 托管的 worktree；预览、发布、转 Ready、合并或关闭当前分支 PR。写操作携带 revision，外部改动导致状态过期时拒绝旧操作并刷新。PR 依赖通过签名工具目录审核且已登录的 GitHub CLI。
- **Terminal**：在当前项目目录启动你的系统 Shell，支持多个标签。关闭详情栏不结束终端；关闭标签、删除所属 session 或退出应用才会终止，重启后不恢复。
- **Files**：只读的多标签文件预览与文件树，支持 Markdown 渲染、行号、图片预览和文件名搜索；`.git` 不展示，目录与搜索都有扫描上限。

当前目录不是 Git 仓库时 Git 标签不可用。没有项目绑定的 Chat 不能打开 Terminal 和 Files。

## 斜杠命令

Composer 输入 `/` 后显示 Core 返回的命令和 active Skill，分为 `Commands` 与 `Skills`：

- `/new`：在同一工作区创建新会话；旧会话保留在侧栏。新会话继承 Chat/Build 类型、项目、活动 worktree 和当前权限预设，不继承对话、Plan 模式、Goal 或排队消息。
- `/compact`：在当前会话中压缩历史并保留摘要。
- `/model`、`/reasoning`：选择模型和思考强度。
- `/permissions`：查看或切换权限预设。
- `/plan`、`/goal`：进入 Plan 模式或设置 Goal，见 [Plan 与 Goal](plan-goal.md)。
- `/stop`：停止当前任务；`/continue`：让 Agent 继续上一项工作。
- 每个 Skill 使用自己的命令，例如 `/agent-reach 搜索相关讨论`。

未知命令只显示本地错误，不会发给模型；模型回复中的斜杠文本也不会执行。只有 Skill 命令可以携带附件。完整规则见 [Slash command 平台](../architecture/slash-command-platform.md)。

## 会话操作

左侧会话栏按项目和日期分组；悬停会话行后点击 `…` 可以重命名、归档和删除（双击标题也可以重命名）。会话栏可以用左上角按钮收起为图标栏，窗口宽度小于 1024px 时自动收起。运行中的会话会显示运行状态，以及「N 个子代理运行中」。

- 归档会话从主列表移除，可以在“设置 → 常规 → 已归档对话”恢复。
- 删除会移除该会话的 log、子代理和后台任务，是持久操作。
- 切换会话不会把进行中的后台 turn 转移到新会话。
- 新建会话时界面先创建本地草稿，发送第一条消息后才创建真实会话；首条消息之后会自动生成标题。

## 运行中继续发送

Agent 正在回复时仍可输入文字、添加附件和引用 Skill：

- **发送**：消息排队，当前 turn 结束后作为下一轮开始。排队的消息显示在 Composer 顶部，不会提前出现在聊天时间线中。
- **插入当前执行**：把排队的消息提升为插话，在下一个 step 进入当前 turn。
- **删除**：取消尚未开始的排队消息。
- **停止**：取消当前 turn；排队的下一轮不会被删除。

审批、问题（支持多选）和 Plan 审阅出现时，会以卡片形式在底部接管 Composer 的位置；回答、批准、提交意见或取消后，Composer 连同原草稿恢复。

复杂任务不会因为固定的步数上限突然停止：内核不限制一个 turn 的步数。连续重复完全相同的工具调用时，Agent 会收到提醒。

## 权限和路径

Build 绑定目录并不意味着 Agent 可以任意写整台机器：

- 权限预设决定写入范围。默认的 `workspace-write` 只允许写入当前 workspace 和系统临时目录；`read-only` 不允许写入；`danger-full-access` 不限制。
- 超出范围时，Agent 可以为单次调用请求提权，由你批准或拒绝，批准只对这一次调用有效。
- `read`、`glob`、`grep` 可以读取工作区之外的文件；沙箱不限制网络访问。
- Shell 命令在 macOS 和 Linux 上由系统沙箱执行；其他平台只有 `danger-full-access` 才能运行 Shell。

右侧 Terminal 是你直接操作的 Shell，不属于 Agent 工具调用，不受权限预设约束，也不进入聊天记录或模型上下文。

## 什么时候切换类型

| 任务                           | 建议                         |
| ------------------------------ | ---------------------------- |
| 普通问答、总结一段文本         | Chat                         |
| 修改一个明确项目中的代码或文档 | Build                        |
| 同时维护两个项目               | 为每个项目建立独立 Build     |
| 需要先审查实施方案             | 在 Chat 或 Build 中进入 Plan |
| 需要 Agent 持续推进直到完成    | 在合适的会话中设置 Goal      |

Plan 和 Goal 见 [Plan 与 Goal](plan-goal.md)。数据隔离细节见[全局私有存储根](../architecture/global-state-store.md)。
