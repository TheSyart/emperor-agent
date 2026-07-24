# Chat 与 Build

> 文档状态：Active<br>
> 面向读者：使用普通会话或项目会话的用户<br>
> 最后核验：2026-07-24<br>
> 事实源：SessionStore、ProjectStateStore、ContextBuilder、桌面会话入口

Chat（普通对话）和 Build（项目工作）是会话类型。它们决定 Agent 能看到哪些长期上下文，不决定权限级别。

## Chat

Chat 适合问答、整理资料、解释内容和不依赖固定 workspace 的轻量工具任务。

上下文通常包括：

- 系统提示词和当前生效的 Skills；
- 用户档案 `USER.local.md`；
- 全局长期记忆 `MEMORY.local.md`；
- 当前 session 的历史与 checkpoint；
- 当前请求的附件和工具结果。

Chat 不会自动读取某个 Build 项目的私有记忆。需要处理本地项目时，创建或切换到对应 Build。

## Build

Build 绑定一个本地文件夹。Agent 会在该 workspace 内读取项目文件、执行允许的命令，并装配以下项目上下文：

- workspace 中的 `AGENTS.md`；
- `stateRoot/projects/<project-id>/AGENTS.local.md` 中的项目私有记忆；
- 项目 prompt overlay、规则和项目级 Skills；
- 当前 Build session 的历史和 runtime 状态。

`<project>/AGENTS.md` 是可提交的协作说明，Core 只读，不会自动改写。`AGENTS.local.md` 是全局私有项目记忆，物理位置不在项目源码树中。

## 右侧项目工作台

Build 会话默认在消息区右上角始终显示紧凑的 Environment 浮卡，右侧宽工作区默认关闭。Chat 顶部不再保留“对话 / 正在办差 · 模型”标题栏；模型、权限和运行状态仍由 Composer、时间线与侧边栏投影表达。打开 Review、Terminal 或 Files 时，工作区在同一右侧区域原位替代 Environment；关闭工作区后 Environment 自动恢复。工作区宽度可在 520–960px 且不超过窗口 72% 的范围内拖动，关闭、宽度、Files 树宽度和当前面板会随桌面侧栏状态保存；中窄屏分别使用抽屉和全屏布局。

- **Environment**：独立浮卡汇总 Git 文件/行数、同步与瞬态状态、分支、活动 worktree、最近安全操作凭据、Plan/Goal、子代理、非空 Team、后台进程和前三项来源；空模块不占空间。Commit/Compare/PR 快捷项会打开 Review。
- **Review**：按 staged、unstaged、untracked 和 conflict 查看 Diff 与逐文件增删行，执行 stage、unstage、discard、commit、fetch、fast-forward pull、push、建分支、切分支和分支比较；还可创建/退出 Emperor 托管 worktree，并预览、发布、转 Ready、合并或关闭当前分支 PR。状态写操作携带 revision，外部改动导致状态过期时会拒绝旧操作并刷新；discard 会先建立可恢复文件检查点。PR 依赖签名工具目录中经过供应链审核的 GitHub CLI；未安装、未登录或尚未通过目录审核时只返回可操作错误，不回退到任意系统二进制。monorepo 会严格限制在当前 Build 项目子目录，项目外已有暂存内容时不会代为提交；若当前 Build 只绑定仓库子目录，影响整个工作树的 pull、切换分支和 worktree 会被拒绝，应改从仓库根项目操作。
- **Terminal**：在当前项目目录启动用户系统 Shell，支持 ANSI、交互程序、多个标签、Ctrl+C、复制粘贴和 resize。关闭工作台不结束终端，关闭标签、删除所属 session 或退出应用才会终止；应用重启不伪造恢复。
- **Files**：占满宽工作区，顶部是 session 隔离的只读文件标签，主体左侧预览、右侧为可调宽文件树；Markdown 默认渲染并可切换 source，代码/文本显示行号，图片居中预览。目录按需展开并支持文件名/相对路径搜索；`.git` 永不展示，隐藏文件和 Git ignored 文件由独立开关控制，符号链接只有目标仍在项目内时才允许读取。超大目录和仓库搜索都有硬扫描上限，达到上限时界面会明确标记当前结果不完整。

Review 始终保留入口；当前目录不是 Git 仓库时显示不可用。没有项目绑定的 Chat 不显示 Terminal 和 Files。Files 本轮不提供保存、重命名、删除、LSP 或内置代码编辑器。

Agent 执行受管文件修改时，Composer 或底部 Ask/Plan 面板上方会实时显示“当前步骤 · N files changed · +A −D”。统计只覆盖本次用户任务相对起点的净变化，不混入任务前脏文件；一次任务跨 Ask、Permission、Plan 审批或明确继续后仍沿用同一统计，不会拆成多张卡。点击可打开 Review 并查看本次涉及文件。最终答复下方保留静态 Changes 卡，正文也会准确写明同一组总数。已证明只读的 Shell 不会把状态污染为 partial；只有成功执行且无法精确归因的 workspace 写入才会标为“已确认的变更 / partial”。

## 会话操作

侧边栏会话支持重命名、归档和删除：

- 归档会话会从主列表移除，可以在“设置 → 已归档对话”恢复。
- 删除是持久操作。删除带有活动 Goal 的 session 时，Core 会先取消并等待 Goal 收口，再删除相关状态。
- 切换会话不会把进行中的后台 turn 重新绑定到新会话；runtime event 仍写入原 owner session。

## 运行中继续发送

Agent 正在回复时，Composer 仍可输入文字、添加附件并引用 Skill 或 MCP。每个会话只有一个用户可见队列槽：槽空闲时按 Enter 或发送按钮默认排队，已排队消息以与 Composer 同宽的附着栏显示在输入框顶部：

- **编辑消息**：取消仍在等待的原项，并把文字恢复到输入框。
- **插入当前执行**：原子替换为插话，在下一个模型或工具安全边界进入当前 turn；若当前执行刚好结束，原队列项会保留。
- **删除**：只取消尚未开始的项目。
- **停止**：取消当前任务；普通队列中的下一轮不会被默认删除。

槽已占用时仍可继续撰写下一条草稿，但 Enter 不发送，发送按钮也会禁用；文字、附件和 Skill 引用都不会被清空。若并发 IPC 提交在 Core 端撞上同一单槽，界面会恢复完整 payload 并刷新权威队列。升级前已有多条旧队列时只显示 FIFO 首项和“另有 N 条旧队列”，Core 会依次排空且期间拒绝新增。

队列项只显示在 Composer 附着栏中，不会提前生成普通用户气泡；真正收到 `user_message` 后才进入聊天时间线，因此不会重复。如果旧回答已经流出一部分，插话后旧内容会保留为灰色、标记“已被插话替代”，新回答单独显示。队列会在切换会话或重启后从 Core 恢复；Core 会对退出前处于 queued、running 或 interjected 的记录和持久聊天历史进行对账，未进入历史的消息重新排队，已经进入历史的消息不再重放。附件和显式 Skill 请求可正常排队，但不能改成插话；普通文字和已经展开为文字上下文的 MCP 引用可插入当前执行。

普通 Ask、Permission Ask 或 Plan 审批进入 waiting 后，会在底部替代 Composer；时间线中的原 Ask/Plan 卡只保留静态内容和历史状态。回答、批准、评论或取消后，Composer 连同原草稿和附件恢复并重新聚焦。Plan 流式生成期间只显示“生成中”的提案，完整 `plan_draft` 形成后才出现底部“实施此计划？”面板。

Plan 实现完成但仍需人工验证时，底部会出现 Core 决策卡，Agent 此时停止继续修改项目。你可以继续自动验证、确认自己已人工验证通过、明确“跳过验证并完成”，或取消计划。人工通过会在最终报告中注明由用户确认；跳过会留下可审计豁免，并明确写明手动验证未执行；取消不会自动撤销已经写入的文件。普通文字里的“取消、跳过、强制结束”不会被当作这些动作，只有卡片的稳定选项会改变 Plan 生命周期。Ask 和 Plan 控制工具也不会再额外显示原始 arguments/JSON 工具卡。

需要独立复核的 Plan 会显示一条紧凑的“独立复核”节点。复核通过且命令证据完整后，Core 直接结算并生成一次最终交付，不再追问“是否满意”或“是否结束会话”；完成的复核默认折叠，可按需展开查看原始证据。Environment 只展示正在运行的子代理和少量最近记录，其余历史以数量汇总，避免重复 reviewer 占满侧栏。

旧任务清单不会自动劫持新的普通问答。只有当前请求确实更新了清单、刚批准 Plan、刚恢复 Permission，或你明确输入 `/continue`、`继续`、`继续执行`、`按原计划继续` 时，Agent 才续跑未完成任务。因此“我们刚刚说什么了”只会回答历史，不会顺带执行旧步骤。停止当前任务会稳定显示取消状态；已经确认取消后，迟到的模型错误不会再变成“Internal error”。

复杂任务不会再因 20/56 等固定模型轮数突然“无疾而终”。只要文件、Plan/Goal/Todo、验证或新证据仍在推进，主 Agent 就持续执行；连续 6 次没有有效进展时 Core 会要求换一条验证路径，连续 12 次仍只是重复读取、重复命令或重复错误时才以 `no_progress` 暂停。暂停卡会列出原因和剩余动作，点击“继续执行”可恢复同一 Plan；切换会话、刷新、重启或发送普通问题都不会自动恢复写操作。子代理和后台隔离执行器仍有自己的资源/轮数上限。

## 权限和路径

Build 绑定目录并不意味着 Agent 可以任意访问整台机器。每次文件或命令操作仍需通过：

1. 当前权限模式；
2. workspace policy 和路径解析；
3. 工具输入 schema；
4. pending Ask/Plan 与其他 Core mutation guard。
5. 对 shell 命令，操作系统 containment capability 与实际 backend receipt。

`full_access` 只关闭普通权限审批，不会关闭这些检查。workspace 外路径或 Core deny 仍会直接拒绝。批准命令不代表系统会假装存在 sandbox：macOS 使用 Seatbelt，Linux 需要可用的 bwrap；所有 `run_command` 都要求真实 containment receipt，backend 不可用、返回 `unsandboxed` 或平台不支持时命令不会启动。诊断面板会显示当前平台真实能力。

Agent 实际启动的命令还会绑定当前 session；子代理内的命令绑定对应 Task。取消 turn/Task、关闭 session 或退出应用会清理完整进程组，输出超过命令配额也会终止进程。Emperor 当前不提供可脱离应用长期存活的 daemon。右侧 Terminal 是另一条明确的用户直控 PTY：用户键入的命令不属于 Agent 工具调用，不进入三档 Agent 权限审批、聊天历史、模型上下文或持久 runtime event；它仍由 Core 校验 owner session、项目初始 cwd、terminal ID 和最多 8 个标签，并在 session/app 关闭时清理。

可选的文件检查点 Beta 只为 Core 受管文件工具记录 before/after，并在“设置 → 诊断”提供哈希冲突预览和显式回退。它默认关闭，不覆盖 shell、MCP 或外部编辑；启用方法和边界见[诊断与排障](diagnostics-troubleshooting.md#文件检查点与回退beta)。

## 什么时候切换类型

| 任务                           | 建议                               |
| ------------------------------ | ---------------------------------- |
| 普通问答、总结一段文本         | Chat                               |
| 修改一个明确项目中的代码或文档 | Build                              |
| 同时维护两个项目               | 为每个项目建立独立 Build           |
| 需要先审查实施方案             | 在 Chat 或 Build 中开启 Plan       |
| 需要跨多轮修复并严格验收       | 在合适的 Chat 或 Build 中创建 Goal |

Plan 和 Goal 的差异见 [Plan 与 Goal](plan-goal.md)。数据隔离细节见[全局私有存储根](../architecture/global-state-store.md)。
