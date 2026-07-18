# Scheduler、Team、Hooks 与桌宠

> 文档状态：Active<br>
> 面向读者：使用预览自动化和协作能力的用户<br>
> 最后核验：2026-07-18<br>
> 事实源：Scheduler/Team/Hooks/DesktopPet service、当前桌面路由和面板

本页介绍预览能力。它们已经有持久化和 CoreApi 链路，但入口、权限和恢复边界比 Chat/Build 更严格。

## Scheduler

“定时任务”页面可以创建、编辑、暂停、恢复、手动运行和删除任务。界面支持：

- `at`：指定时间运行一次；
- `every`：按固定分钟间隔运行；
- `cron`：按 cron 表达式和时区运行；
- `deleteAfterRun`：运行后删除一次性任务；
- `deliver`：把结果投递到会话界面。

当前创建表单生成 `agent_turn` 任务。底层还认识用于唤醒 Team member 的 payload，但普通用户表单不把它当作通用入口。

Scheduler 不会获得独立权限。存在 pending Ask/Plan、全局运行锁冲突或策略拒绝时，任务会等待、跳过或失败，并留下 run history。应用退出时不会继续在系统后台运行。

## Team

Team 提供成员、Inbox、消息、唤醒和 shutdown 的 Core 能力，并允许 Agent 通过 Team tools 派发受控任务。当前独立 `/team` 路由没有开放，会重定向到 Chat；不要把它当成已经完成的独立工作台。

用户目前能看到的主要结果是会话中的 subagent/team trail，以及模型或 Scheduler 触发的协作记录。Team 仍受当前 session、workspace、permission 和 mutation guard 约束。

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

## External Bridge 与 Watchlist

这两项目前属于基础设施：

- External Bridge 有 adapter/store/service 边界，但不内置具体外部平台 adapter；
- Watchlist 供受控检查和 Scheduler 维护链路使用，不是独立用户订阅产品。

文档和界面不得把它们描述成现成的 Slack、邮件、社交平台或任意消息连接器。
