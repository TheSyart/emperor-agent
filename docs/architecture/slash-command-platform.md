# Slash command 平台

> 文档状态：Active<br>
> 面向读者：维护者、Skill 作者和桌面端开发者<br>
> 最后核验：2026-09-22<br>
> 事实源：`packages/core/src/commands/`、`packages/core/src/api/services/command-application-service.ts`、CoreApi `commands.*`、`desktop/src/renderer/src/composables/useSlashCommands.ts`

Emperor 的斜杠命令由 Core 注册、解析、校验和调度。Renderer 只展示候选、补全参数、打开界面并投影结果；它不能提供 handler、Skill 路径、来源或工具范围。

## 命令类别

| 类别           | 作用                                 | 是否进入模型上下文                             |
| -------------- | ------------------------------------ | ---------------------------------------------- |
| `local_ui`     | 打开选择器或面板                     | 否                                             |
| `core_action`  | 修改会话、Plan、Goal、权限等内核状态 | 否；只返回回执。`/plan <message>` 另行提交消息 |
| `agent_prompt` | 调用一个 active Skill                | 是；提交一条 `/<skill-name> <task>` 用户消息   |

模型输出中的 `/command` 只是文字，不会执行。只有用户输入开头的 `/name` 进入命令解析；`/Users/...` 等绝对路径保持普通文本。

## Core 接口

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

`commands.list` 每次从内置目录和当前 active Skill 重新构造注册表，按 session 是否存在与调用来源计算可用性。`commands.invoke` 同时校验稳定 `commandId` 与输入中的名称。

解析器是确定性的 tokenizer，支持单引号、双引号、反斜杠、`--key=value` 和 `--`，不做任何 Shell 展开。参数先通过命令声明的 schema 才能产生副作用。未知命令返回本地错误，不会降级成普通模型请求。只有 `agent_prompt` 命令可以携带附件。

`invocationId` 是一次调用的幂等键。`stateRoot/control/command-invocations.json` 只保存 session、命令 ID、来源、输入摘要和结果；重复 IPC、双击或重试返回第一次的结果。

## 忙碌策略

- `immediate`：可在 turn 运行时执行。
- `after_turn`：当前 turn 运行时排队，在安全终态之后执行，返回 `queued` 与 request ID。
- `reject_when_busy`：运行中直接拒绝。

Desktop、Automation 和 ACP 是不同的调用来源，命令必须显式列出允许的来源，默认只有 Desktop。`/stop` 允许全部三种来源。

## 内置命令

普通用户命令只有九个，按固定顺序展示：

| 命令                                                                    | 类别          | 忙碌策略     | 行为                                                      |
| ----------------------------------------------------------------------- | ------------- | ------------ | --------------------------------------------------------- |
| `/new`                                                                  | `core_action` | `after_turn` | 在同一工作区创建新会话并切换过去                          |
| `/compact`                                                              | `core_action` | `after_turn` | 立即压缩当前会话，保留摘要                                |
| `/model [model-id]`                                                     | `local_ui`    | `immediate`  | 打开模型选择器；带参数时直接激活匹配的 entryId 或 modelId |
| `/reasoning [level]`                                                    | `local_ui`    | `immediate`  | 打开思考强度选择器；带参数时直接设置当前模型              |
| `/permissions [read-only\|workspace-write\|danger-full-access\|status]` | `local_ui`    | `immediate`  | 打开权限面板或直接切换预设；`/permission` 是隐藏别名      |
| `/plan [off\|message]`                                                  | `core_action` | `immediate`  | 进入 Plan 模式；带消息时同时提交；`off` 离开              |
| `/goal [<objective>\|clear\|edit <objective>\|pause\|resume]`           | `core_action` | `immediate`  | 见 [Goal 架构](goal-mode.md)                              |
| `/stop`                                                                 | `core_action` | `immediate`  | 停止当前任务                                              |
| `/continue`                                                             | `core_action` | `after_turn` | 向当前会话提交一条 `continue` 消息                        |

内置名称受保护，同名 Skill 不会注册斜杠入口。Settings、Skills、Plugins、Memory、Diagnostics、Git、Files 和 Terminal 从应用导航进入，不提供斜杠命令。

## `/new` 与 `/compact`

`/new` 通过 `SessionTransitionService`（`commands/session-transition.ts`）执行可恢复的会话转换：

1. 当前 turn 运行中时按 `after_turn` 排队；存在待处理交互或排队消息时拒绝（409），需要先处理。
2. 停止旧会话。
3. 创建带 `parent_session_id`、`lineage_root_id` 的新 session，继承 Chat/Build 类型、项目绑定与活动 worktree。
4. 新 session 从空白 log 开始，沿用源 session 的权限预设（记录在 transition 记录的 `source.permissionPreset` 中），Plan 模式关闭，不继承对话、Goal、Todo、队列或附件。
5. 激活新 session。

事务记录在 `stateRoot/control/session-transitions.json`，按 `prepared → ended → created → applied` 推进；启动时重放未完成的事务，不会产生两个空会话。旧 session 保留在侧栏。长期记忆和项目记忆按正常规则进入新会话。

`/compact` 在同一个 session 中立即执行压缩（见 [Agent 执行链路](agent-runtime.md#压缩)），不新建会话；当前会话无需压缩时返回 `nothing_to_compact`。

## Skill 命令

每个 active、允许用户调用的 Skill 都暴露为 `/<skill-name>`。调用时 Core 提交一条 `/<skill-name> <task>` 用户消息，内核的 Skill middleware 识别该手势，把 Skill 说明注入该 step。Skill 可以在 `SKILL.md` frontmatter 中细化命令：

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
      invocation_sources: [desktop]
      sensitive_arguments: [token]
      context: fork
      allowed_tools: [read, grep]
      effort: high
```

`context: fork` 让命令不在当前对话里内联执行，而是作为后台 fork 子代理运行：子代理的提示是渲染后的 Skill 内容加上任务文本，命令立即返回 `skill_forked` 回执和子代理 ID，结果在 Task 面板与对话中的子代理卡片里查看。仅在 fork 时生效的字段：

- `allowed_tools`：子代理可用工具的白名单，必须是已注册的工具名，否则命令被拒绝（`skill_fork_tool_scope_invalid`）。
- `effort`：子代理的推理强度，映射到当前模型路由支持的档位；路由不支持时忽略。

fork 命令不接受附件。`agent` 字段已无对应的 Agent 定义，会被忽略并在 Diagnostics 的 `commandCatalog.warnings` 中提示；内联命令上的 `allowed_tools` / `effort` 同样只产生 warning。

Token 默认由 Skill 名称规范化为小写 kebab-case；显式 `name` 时以其为准。同一 token 按 `project > user > plugin > built-in` 取最高优先级；与内置命令冲突的 Skill 不注册入口，冲突摘要出现在 Diagnostics 的 `commandCatalog` 中。Emperor 不提供 `/skill`、`/skills` 等中转语法，也不扫描 `.emperor/commands/`。

## Renderer 投影

Composer 输入 `/` 后用 Core descriptor 构建候选列表，分为 `Commands` 与 `Skills`；Skill 显示 `Personal`、`Project`、`Built-in` 或 `Plugin` 来源。上下键移动，Tab 补全，Enter 执行或插入参数提示，Escape 关闭。

Renderer 在启动、切换会话、收到 `assistant_done`、收到 `skill_catalog_changed` 以及每次打开菜单时调用 `commands.list`；刷新是 single-flight，失败时保留上一次成功的列表。

## 扩展门禁

新增或修改命令时同步：

1. `commands/builtins.ts` 的 descriptor 与 `command-application-service.ts` 的执行分支。
2. 若协议本身变化，同步 `commands.*` 的 schema、Electron registry、preload 与 renderer 类型。
3. 忙碌、幂等、来源白名单、附件和 session ownership 测试。
4. 对应的用户与架构文档。
