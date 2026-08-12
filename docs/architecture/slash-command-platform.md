# Slash command 平台

> 文档状态：Active<br>
> 面向读者：维护者、Skill 作者和桌面端开发者<br>
> 最后核验：2026-08-12<br>
> 事实源：`packages/core/src/commands/`、CoreApi `commands.*`、`desktop/src/renderer/src/composables/useSlashCommands.ts`

Emperor 的斜杠命令由 Core 注册、解析、校验和调度。Renderer 只展示候选、补全参数、打开界面并投影结果；它不能提供 handler、Skill 路径、source、权限级别、Agent 或工具范围。

## 命令类别

| 类别           | 作用                                        | 是否进入模型历史                                 |
| -------------- | ------------------------------------------- | ------------------------------------------------ |
| `local_ui`     | 打开页面、弹层或右侧工作台                  | 否                                               |
| `core_action`  | 修改会话、Plan、Goal、权限等 Core 状态      | 否；仅显示 toast、专用投影或脱敏回执             |
| `agent_prompt` | 调用一个已解析并通过信任校验的 active Skill | 是；只保留一条用户原始 `/<skill-token> ...` 消息 |

模型输出中的 `/command` 只是文字，不能执行命令。模型需要改变系统状态时仍使用结构化工具。只有用户输入开头的 `/name` 才进入命令解析；`/Users/...` 等绝对路径保持普通文本。

## Core 接口

桌面端只通过三项 typed operation 使用命令平台：

```ts
commands.list({ sessionId, includeUnavailable?, invocationSource? })
commands.complete({ sessionId, commandId, rawArgs, cursor, invocationSource })
commands.invoke({
  sessionId,
  commandId,
  rawInput,
  invocationId,
  invocationSource,
  attachments?,
})
```

`commands.list` 每次从内置目录和当前 active Skill 重新构造注册表，并结合 session 是否存在与调用来源计算可用性。`commands.invoke` 同时校验稳定 `commandId` 与输入中的名称，避免 Renderer 用一个命令 ID 搭配另一个命令文本。

解析器是确定性的 tokenizer，支持单引号、双引号、反斜杠、`--key=value` 和 `--`，不执行变量、通配符、命令替换或其他 Shell 展开。参数必须先通过命令声明的 string、boolean、enum、id 或 relative-path schema，随后才能产生副作用。未知命令返回本地错误并提示重新打开菜单，不会降级成普通模型请求。

`invocationId` 是一次调用的幂等键。私有 `control/command-invocations.json` 只保存 session、命令 ID、来源、输入摘要和脱敏结果；重复 IPC、双击或重试返回第一次结果，不会重复创建会话或提交 Skill。敏感参数不会写入公开 runtime event、聊天历史或诊断。

## 忙碌策略

命令声明以下一种策略：

- `immediate`：可在前台 turn 运行时执行；当前普通用户命令中只有 `/stop` 使用该策略。
- `after_turn`：进入 owner Session Actor 的串行 mailbox，在当前 turn 的安全终态之后执行。
- `reject_when_busy`：运行中直接拒绝，不创建隐含队列。

命令队列和用户消息单槽队列是两类不同事实，但都由同一 Session Actor 保证顺序。`after_turn` 命令返回稳定 request ID；桌面端用原 `invocationId` 轮询最终结果，不能创建第二次调用。

Desktop、Automation 和 ACP 是不同 invocation source。命令必须显式列出来源；默认只有 Desktop。交互 UI、会话切换和高影响状态操作不会因为 `full_access` 而开放给非桌面来源。

## `/new` 与 `/compact`

`/new` 不清空 Renderer 数组。它通过 `SessionTransitionService` 执行可恢复的会话转换：

1. 等待当前前台 turn 到安全终态，并拒绝尚未回答的 Ask、Permission、Plan 和未处理消息队列。
2. 为旧 session 执行 `SessionEnd(reason=clear)`。
3. 创建带 `parent_session_id`、`lineage_root_id` 和 `transition_reason=clear` 的新 session。
4. 继承 Chat/Build 类型、项目绑定、活动 worktree、全局模型配置和当前权限档位。
5. 不继承 history、message graph、runtime timeline、checkpoint、Plan、Goal、Todo、队列、execution ledger 或附件投影。
6. 激活新 session 并让 Composer 重新获得焦点。

旧 session 不删除、不归档，后台 Task 仍归旧 session，可从侧栏找回。全局用户记忆和项目记忆继续按 Context Builder 规则装配；`/new` 创建的是新会话上下文，不是清空长期记忆库。

事务记录位于 `control/session-transitions.json`，按 `prepared → ended → created → applied` 推进。启动时会重放未完成事务，创建同一个目标 session，不会产生两个空会话。旧 session 一旦进入转换屏障就不再接受新的聊天提交。

`/compact [instructions]` 则保留同一个 session 和 lineage，把旧上下文压缩为摘要；它不会新建会话，也不等同于 `/new`。

## Skill 命令

active Skill 默认继续暴露为 `/<skill-name>`。Skill 可以在 `SKILL.md` frontmatter 中细化命令行为：

```yaml
metadata:
  emperor:
    command:
      user_invocable: true
      name: review-code
      aliases: [audit-now]
      argument_hint: '[scope]'
      arguments:
        - name: scope
          type: relative_path
          required: true
          positional: true
      context: fork
      agent: sili_suitang
      allowed_tools: [read_file, grep]
      effort: high
      invocation_sources: [desktop]
      sensitive_arguments: [token]
```

没有该扩展时使用 inline 和单个可变长 task 参数。`fork` 复用受控子代理定义；Core 验证 Agent 存在，并校验 Skill 申请的工具是该 Agent 工具上限的子集。Renderer 不能改写这些字段。

Skill token 默认由解析后的 Skill 名称规范化为小写 kebab-case；frontmatter 显式 `name` 时以该名称为准。只有 `user_invocable` 未显式关闭、状态为 active 且通过 source trust 的最终生效 Skill 才进入命令表。同一 token 按 `project > user > plugin > built-in` 取最高优先级；与九个内置命令冲突时内置命令优先，该 Skill 不注册含糊入口。被拒绝的 canonical token 和 alias 会以脱敏冲突摘要出现在 Diagnostics 的 `Slash command catalog` 行。Emperor 不提供 `/skill`、`/skills`、`/skill:<name>` 或 `/<name>-skill` 中转语法，也不增加 `.emperor/commands/`，避免形成第二套动态 prompt 体系。

## 正式命令目录

普通用户命令严格只有九个，按固定顺序展示：

1. `/new`
2. `/compact`
3. `/model`
4. `/reasoning`
5. `/permissions`
6. `/plan`
7. `/goal`
8. `/stop`
9. `/continue`

`/stop` 只在任务执行中显示；`/continue` 只在 Plan 或 Goal 可恢复且当前不忙时显示。旧命令和别名不再解析，包括 `/clear`、`/reset`、`/effort`、`/help`、`/status`、`/reload`、`/skill` 与 `/skills`。对应的 Settings、Skills、Plugins、Memory、Diagnostics、Git、Files 和 Terminal 能力仍从应用导航进入，不再挤占普通用户的斜杠菜单。

`/continue` 只恢复暂停的 Plan 或 Goal；历史会话从侧栏选择。不提供 `/clear-screen`、`/branch`、`/rewind`，也不为 Emperor 没有的 CLI 能力制造占位命令。

## Renderer 投影

Composer 输入 `/` 后使用 Core descriptor 构建固定尺寸的候选列表。菜单只分为 `Commands` 与 `Skills`：内置命令使用固定顺序，Skill 按易读标题排序并显示 `Personal`、`Project`、`Built-in` 或 `Plugin` 来源。搜索覆盖标题、真实 token、描述和 Skill frontmatter 信息；上下键移动，Tab 补全，Enter 执行或插入参数提示，Escape 关闭。

Renderer 在启动、切换会话、收到 live `assistant_done` 以及每次从关闭状态打开斜杠菜单时调用 `commands.list`。刷新使用 single-flight 合并并发请求；请求期间保留上一次成功列表，失败只记录非阻塞错误。因此 Agent 或外部应用写入新的合法 `SKILL.md` 后，无需重启，最迟在当前任务完成或下次打开菜单时出现。该机制不增加文件监听、轮询、runtime event 或 IPC operation。

`local_ui` 不创建用户气泡；`core_action` 不把原始参数写进模型 history；`agent_prompt` 只显示一次原始用户命令。历史版本已经保存的命令文本按普通历史 replay，永不重新执行。

## 扩展门禁

新增或修改命令时必须同步：

1. Core descriptor、schema、可用性与执行 handler。
2. `commands.list/complete/invoke` 输入输出 schema（若协议本身变化）。
3. Electron IPC registry、preload 和 Renderer 类型 parity。
4. busy、幂等、来源白名单、附件、敏感参数与 session ownership 测试。
5. 对应 Active 用户和架构文档。

Slash command 不能覆盖显式 deny、Plan 只读、Goal Gate、Permission、workspace containment 或既有 Git/Memory/MCP 确认协议。隐藏按钮、Renderer 类型和 `full_access` 都不是放宽依据。
