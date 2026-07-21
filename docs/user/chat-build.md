# Chat 与 Build

> 文档状态：Active<br>
> 面向读者：使用普通会话或项目会话的用户<br>
> 最后核验：2026-07-21<br>
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

## 会话操作

侧边栏会话支持重命名、归档和删除：

- 归档会话会从主列表移除，可以在“设置 → 已归档对话”恢复。
- 删除是持久操作。删除带有活动 Goal 的 session 时，Core 会先取消并等待 Goal 收口，再删除相关状态。
- 切换会话不会把进行中的后台 turn 重新绑定到新会话；runtime event 仍写入原 owner session。

## 运行中继续发送

Agent 正在回复时，Composer 仍可输入文字、添加附件并引用 Skill 或 MCP。按 Enter 或发送按钮默认加入 FIFO 队列；输入框上方的队列托盘显示尚未开始的消息：

- **编辑消息**：取消仍在等待的原项，并把文字恢复到输入框。
- **插入当前执行**：原子替换为插话，在下一个模型或工具安全边界进入当前 turn；若当前执行刚好结束，原队列项会保留。
- **删除**：只取消尚未开始的项目。
- **停止**：取消当前任务；普通队列中的下一轮不会被默认删除。

队列项只显示在托盘中，不会提前生成普通用户气泡；真正收到 `user_message` 后才进入聊天时间线，因此不会重复。如果旧回答已经流出一部分，插话后旧内容会保留为灰色、标记“已被插话替代”，新回答单独显示。队列会在切换会话或重启后从 Core 恢复；Core 会对退出前处于 queued、running 或 interjected 的记录和持久聊天历史进行对账，未进入历史的消息重新排队，已经进入历史的消息不再重放。附件和显式 Skill 请求可正常排队，但不能改成插话；普通文字和已经展开为文字上下文的 MCP 引用可插入当前执行。

## 权限和路径

Build 绑定目录并不意味着 Agent 可以任意访问整台机器。每次文件或命令操作仍需通过：

1. 当前权限模式；
2. workspace policy 和路径解析；
3. 工具输入 schema；
4. pending Ask/Plan 与其他 Core mutation guard。
5. 对 shell 命令，操作系统 containment capability 与实际 backend receipt。

`full_access` 只关闭普通权限审批，不会关闭这些检查。workspace 外路径或 Core deny 仍会直接拒绝。批准命令不代表系统会假装存在 sandbox：macOS 使用 Seatbelt，Linux 需要可用的 bwrap；所有 `run_command` 都要求真实 containment receipt，backend 不可用、返回 `unsandboxed` 或平台不支持时命令不会启动。诊断面板会显示当前平台真实能力。

实际启动的命令还会绑定当前 session；子代理内的命令绑定对应 Task。取消 turn/Task、关闭 session 或退出应用会清理完整进程组，输出超过命令配额也会终止进程。Emperor 当前不提供可脱离应用长期存活的 daemon，也没有 PTY/resize 桌面终端；诊断页的 `Owned Process Runtime` 会明确显示这一边界。

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
