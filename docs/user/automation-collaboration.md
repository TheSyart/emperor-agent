# 定时任务、Hooks 与桌宠

> 文档状态：Active<br>
> 面向读者：使用自动化能力的用户<br>
> 最后核验：2026-09-23<br>
> 事实源：`packages/core/src/scheduler/`、`packages/core/src/harness/host/scheduler.ts`、`packages/core/src/harness/hooks/`、`packages/core/src/api/services/hooks-service.ts`、`packages/core/src/watchlist/`、DesktopPet service、`desktop/src/renderer/src/components/pages/scheduler/`、`desktop/src/renderer/src/components/settings/`（Hooks / 记忆 / 桌宠分区）

本页介绍预览阶段的自动化能力。它们都通过与普通对话相同的内核运行，不获得额外权限。

## 定时任务

点击侧栏的「定时任务」打开定时任务页（`/scheduler`），可以创建、编辑、暂停、恢复、立即运行和删除任务。Agent 也可以通过 `scheduler` 工具管理任务。

- **列表**：顶部是搜索框和“全部 / 已开启 / 已暂停 / 已完成”四个标签。每行显示任务名称、调度规则与下次运行时间（例如「星期五（时间：18:00） · 下次运行 3天后」），运行中、排队中或上次失败时带状态标记。已运行过、已停用的一次性任务归入“已完成”。
- **创建**：右上角「创建 ▾」提供「新建任务」和两个预填模板：「每日摘要」（工作日 09:00）和「每周回顾」（星期五 18:00）。模板只填好表单，保存前可以修改。
- **编辑**：点击一行打开任务对话框，查看状态、启用开关、任务详情、最近错误和运行历史，底部提供「删除」（需再次确认）、「立即运行」和「保存」。
- **行菜单**：每行右侧的 `⋯` 提供「立即运行」、「暂停」（已停用的任务显示「恢复」）和「删除」（删除前确认，任务和运行历史一并删除）。
- 受保护的系统任务可以暂停、恢复或立即运行，但不能编辑或删除。
- 列表下方显示服务状态（运行、并发和排队情况）以及关闭应用和错过触发点的处理规则。

定时任务运行完成或失败时，侧栏的通知铃铛会收到一条通知；此时正在查看定时任务页的话，这条通知直接记为已读。

任务支持：

- `at`：指定时间运行一次；
- `every`：按固定间隔运行；
- `cron`：按 cron 表达式和时区运行；
- `misfirePolicy`：应用停机期间错过触发点后的处理方式；
- `deleteAfterRun`：运行后删除一次性任务；
- `deliver`：把结果投递到会话界面。

任务类型：

- `agent_turn`：把任务消息作为一条用户消息提交到任务绑定的会话（未绑定时使用当前活动会话），并等待这一轮结束。目标会话有待回答的问题或审批时，本次运行会报错而不是跳过交互。
- `system_event`：系统任务。`watchlist-check` 会检查 Watchlist，需要时再发起一轮 `agent_turn`。

旧版本创建的 `team_wake` 任务已不再支持，运行时会报错，请删除或改为 `agent_turn`。

`misfirePolicy` 有三种：`skip`（默认）只记录错过并移到下一个未来触发点；`latest` 只补跑最后一个错过的触发点；`catch-up-one` 只补跑最早一个错过的触发点。无论错过多少次，每个任务每次启动最多补跑一次。

定时任务最多同时运行 2 个、同一目标最多 1 个，最多排队 100 个，这些上限不能从界面或任务放宽。应用退出时 Scheduler 停止接收新任务并取消进行中的工作，它不会作为系统后台服务继续运行。重启后已经开始运行的任务不会自动重放，无法确认结果时记为 `interrupted`。

## Hooks

入口是“设置 → Hooks”。Hooks 在指定事件发生时自动运行命令，配置写在 `hooks.json` 中，只支持 `command` 类型的 handler。

- 配置文件：`stateRoot/hooks.json`，按“事件 → matcher 分组 → hooks”组织，可以在“配置”标签编辑；保存时会校验并立即重新加载。
- 支持的事件：`SessionStart`、`UserPromptSubmit`、`PreToolUse`、`PostToolUse`、`Stop`、`SubagentStart`、`SubagentStop`。其他事件和非 `command` 类型的 handler 会被忽略，页面会列出被跳过的项。
- Hook 在会话工作目录中按配置顺序串行运行，多个结果取最严格的决定。环境变量 `CLAUDE_PROJECT_DIR` 指向当前项目目录，单个 Hook 默认超时 10 分钟。

| 事件               | 可以做什么                                   |
| ------------------ | -------------------------------------------- |
| `SessionStart`     | 追加上下文                                   |
| `UserPromptSubmit` | 拒绝本次提交，或追加上下文                   |
| `PreToolUse`       | 拒绝工具调用，或要求先询问你                 |
| `PostToolUse`      | 阻止结果并返回反馈，或追加上下文             |
| `Stop`             | 阻止本轮结束、让 Agent 继续（每轮最多 3 次） |
| `SubagentStart`    | 为子代理追加上下文                           |
| `SubagentStop`     | 仅观察                                       |

Hook 输出中的 `updatedInput`、`systemMessage` 和 `continue: false` 会被解析并记录警告，但不会生效。Hook 不能放宽权限预设或沙箱。

“设置 → Hooks”分为三个标签：

- **配置**：查看已加载的配置文件、加载错误和各事件的命令数，编辑 `hooks.json`，支持「还原」「校验」「保存」（⌘S 保存）。
- **测试**：选择事件并输入 matcher 查询，查看会匹配到的命令；对某条命令点击「执行」后还需「确认执行」才会真正运行，结果显示决定、退出码和耗时。编辑器中尚未保存的内容也按当前内容匹配和运行。
- **审计**：按事件和结果筛选当前会话的 Hook 运行记录，展开查看 matcher、退出码、耗时和 stderr。审计记录来自当前会话 log 中的 Hook 调用与结果事件。

项目目录中的 `.claude/settings.json` 当前不会被加载，项目信任设置接口也已下线。

## Watchlist

Watchlist 由 `memory/watchlist.md` 定义，在“设置 → 记忆”的“Watchlist”标签中编辑。可以在该标签点击右上角的「手动检查」，也可以由定时任务中的 `watchlist-check` 系统任务定期检查；判断需要处理时会发起一轮普通 Agent turn。它不提供 Slack、邮件或社交平台连接器。

## 桌宠 companion

“设置 → 桌宠”可以启用或关闭 companion，默认关闭；页面还可以预览各运行状态的动画，并显示启动方式和最近的窗口错误。窗口由主 Electron 进程托管。桌宠只投影空闲、工作等状态，不能代替真实的任务状态，也不能直接修改 Core 状态。
