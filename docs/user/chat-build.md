# Chat 与 Build

> 文档状态：Active<br>
> 面向读者：使用普通会话或项目会话的用户<br>
> 最后核验：2026-07-19<br>
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

Agent 正在回复时，Composer 仍可输入纯文字，并显示三个独立操作：

- **排队**：保留当前任务，等它结束后把新消息作为下一轮处理。
- **插话**：在下一个模型或工具安全边界用新指令替代当前回答；不会修改正在传输中的模型请求。
- **停止**：取消当前任务。尚未消费的插话会显示“已取消”，已经排队的下一轮不会被默认删除。

消息旁会显示“已排队”“处理中”“已插话”或“已取消”。如果旧回答已经流出一部分，插话后旧内容会保留为灰色、标记“已被插话替代”，新回答单独显示，不会把两段文字混成一条。运行中的排队与插话目前只接受纯文字；附件、Skill 和 MCP 引用请等当前轮结束后正常发送。

## 权限和路径

Build 绑定目录并不意味着 Agent 可以任意访问整台机器。每次文件或命令操作仍需通过：

1. 当前权限模式；
2. workspace policy 和路径解析；
3. 工具输入 schema；
4. pending Ask/Plan 与其他 Core mutation guard。
5. 对 shell 命令，操作系统 containment capability 与实际 backend receipt。

`auto` 也不会关闭这些检查。复杂 shell、workspace 外路径或高风险 mutation 仍可能要求确认或直接被拒绝。批准命令不代表系统会假装存在 sandbox：macOS 使用 Seatbelt，Linux 需要可用的 bwrap，Windows 当前不支持 mutation sandbox；未证明只读的命令在 backend 不可用时不会启动。只读诊断允许明确的 `unsandboxed` receipt，诊断面板会显示当前平台真实能力。

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
