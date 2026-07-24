# Scheduler、Team、Hooks 与桌宠

> 文档状态：Active<br>
> 面向读者：使用预览自动化和协作能力的用户<br>
> 最后核验：2026-07-19<br>
> 事实源：Scheduler/Team/Hooks/DesktopPet service、当前桌面路由和面板

本页介绍预览能力。它们已经有持久化和 CoreApi 链路，但入口、权限和恢复边界比 Chat/Build 更严格。

## Scheduler

“定时任务”页面可以创建、编辑、暂停、恢复、手动运行和删除任务。界面支持：

- `at`：指定时间运行一次；
- `every`：按固定分钟间隔运行；
- `cron`：按 cron 表达式和时区运行；
- `misfirePolicy`：选择应用停机期间错过触发点后的处理方式；
- `deleteAfterRun`：运行后删除一次性任务；
- `deliver`：把结果投递到会话界面。

当前创建表单生成 `agent_turn` 任务。底层还认识用于唤醒 Team member 的 payload，但普通用户表单不把它当作通用入口。

`misfirePolicy` 有三种选择：`skip`（默认）只记录错过并移到下一个未来触发点；`latest` 只补跑最后一个错过的触发点；`catch-up-one` 只补跑最早一个错过的触发点。后两种都不是无限追赶：无论停机期间错过多少次，每个 Job 每次启动最多产生一次执行。

Scheduler 不会获得独立权限。任务进入目标 session 的 runtime actor，继续受 Ask/Plan、权限、workspace、Goal mutation owner 和工具策略约束。Scheduler 自身最多同时运行 2 个 run、同一 owner 最多 1 个，最多排队 100 个；这些上限由 Core 固定，Job、模型和界面不能放宽。达到容量时，自动触发会留下 `skipped` receipt，手动触发会返回明确错误。

面板会显示 active/queued 容量、计划时间与实际时间、timer/manual/misfire 来源、missed count、run ID、Task ID，以及 `ok/error/skipped/cancelled/interrupted` 历史。暂停会取消尚未开始的 queued run，但不会暗中终止已经运行的用户任务；仍在运行时删除会被拒绝。

应用退出时 Scheduler 停止接收新 run，取消 queued/running 工作，并在生命周期时限内等待收敛；它不会作为系统后台 daemon 继续运行。重启后，可证明尚未开始的 queued run 可以恢复一次，已经进入 running 的 run 永不自动重放；无法证明终态时记录为 `interrupted`，避免重复未知副作用。这是可审计的 at-most-one 自动恢复边界，不是对任意外部副作用的 exactly-once 承诺。

## Team

Team 提供成员、Inbox、消息、唤醒和 shutdown 的 Core 能力，并允许 Agent 通过 Team tools 派发受控任务。当前独立 `/team` 路由没有开放，会重定向到 Chat；不要把它当成已经完成的独立工作台。

用户目前能看到的主要结果是会话中的 subagent/team trail，以及模型或 Scheduler 触发的协作记录。Team 仍受当前 session、workspace、permission 和 mutation guard 约束。

Team 唤醒会先写入版本化 checkpoint。应用中断后，尚未开始执行的 `prepared` turn 会安全续跑；已经得到结果的 `terminal_pending` turn 只补齐 thread、Inbox receipt 和 cursor，不会再次调用模型。处于 `running` 的 turn 可能已经执行过外部工具，默认会进入 Error 而不是自动重放，以避免重复产生非幂等副作用。维护者核对外部结果后，才可通过 `team.wakeMember` 的 `recovery: 'retry'` 显式重试。损坏、旧版本或 revision/cursor 不匹配的 checkpoint 同样 fail closed，原文件保留用于诊断。

## Agent Hooks

入口是“设置 → Hooks”。页面分为有效配置、测试、审计和高级编辑。

Hooks 可以在 Session、用户输入、工具调用、权限、Stop、压缩和配置变更等生命周期点运行确定性 handler。当前支持 `command` 与 `http` handler。

配置来源：

- 全局：`stateRoot/hooks_config.json`，可以在设置页编辑；
- 项目：`<project>/.emperor/settings.json` 与 `settings.local.json` 中的 hooks block，只读导入；
- session/agent：由受控运行时注册，不能伪装成全局配置。

项目 Hooks 必须对当前 canonical project 和当前配置 digest 建立信任。项目文件发生变化后，旧信任不会自动沿用。

Hooks 可以返回 allow、ask、deny 或 passthrough，但不能覆盖 workspace policy 或 Core deny。测试运行要求明确确认；Plan 模式或存在 pending Ask/Plan 时，Core 会在启动 handler 和写入审计前拒绝测试执行。成功运行的审计记录保存在 `stateRoot/hooks/audit.jsonl` 及相关目录。

## 桌宠 companion

“桌宠”页面可以启用或关闭 companion。默认关闭；窗口由主 Electron 进程托管，不是独立 Electron runtime。

桌宠可以投影空闲、工作、派遣队友等状态，但不能代替真实 task/Goal 状态。桌宠触发的 mutation 同样受 pending Ask/Plan 和 CoreApi guard 约束。

## Watchlist

Watchlist 供受控检查和 Scheduler 维护链路使用，不是独立用户订阅产品，也不提供 Slack、邮件或社交平台连接器。
