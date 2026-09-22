# Plan 与 Goal

> 文档状态：Active<br>
> 面向读者：需要控制权限、审阅方案或持续推进任务的用户<br>
> 最后核验：2026-09-22<br>
> 事实源：`packages/core/src/harness/approval/presets.ts`、`packages/core/src/harness/sandbox/`、`packages/core/src/harness/tools/builtin/skill-manage.ts`、`packages/core/src/harness/tools/builtin/mcp-config.ts`、`packages/core/src/harness/plan/plan-mode.ts`、`packages/core/src/harness/goal/`、`packages/core/src/commands/builtins.ts`

权限预设决定 Agent 能写哪里；Plan（规划模式）决定 Agent 先提方案还是直接动手；Goal（目标）让 Agent 在你不再输入时继续推进同一个目标。三者可以组合使用。

## 权限预设

| 命令                                    | 写入范围                      | 审批                                 |
| --------------------------------------- | ----------------------------- | ------------------------------------ |
| `/permissions read-only`                | 不允许写入                    | 需要写入时逐次请求你批准             |
| `/permissions workspace-write`          | 当前 workspace 与系统临时目录 | 超出范围时逐次请求你批准（默认预设） |
| `/permissions danger-full-access`       | 不限制                        | 不弹出审批；需要审批的请求被自动拒绝 |
| `/permissions` 或 `/permissions status` | —                             | 打开权限面板查看当前预设             |

- 新会话总是从 `workspace-write` 开始；预设只属于当前会话，不会保存为全局规则。
- 批准只对那一次工具调用有效，下一次仍会询问。
- 沙箱只限制文件写入：读取文件和网络访问不受限制。
- Shell 命令在 macOS 上使用 Seatbelt、在 Linux 上使用 bubblewrap 执行。其他平台没有沙箱后端，`read-only` 和 `workspace-write` 下的 Shell 命令会直接失败，需要时切换到 `danger-full-access`。
- 记忆编辑、MCP 工具、Skill 加载和 Scheduler 工具不受沙箱限制，也不需要审批。
- Agent 用 `skill_manage` 新建、修改、删除或导入 Skill，或用 `mcp_config` 添加、删除、启停 MCP server 时，写入同样跟随当前预设：`danger-full-access` 下直接执行，其他预设每次写入都会请求你批准。
- 子代理继承当前会话的沙箱模式，但不能请求提权。

## Plan：先规划再执行

```text
/plan
/plan 为现有项目设计一套迁移方案
/plan off
```

- `/plan` 进入 Plan 模式；`/plan <消息>` 进入的同时把消息发给 Agent；`/plan off` 退出。
- Plan 模式下 Agent 会先只读探索、在必要时向你提问，然后提交一份以标题开头的完整计划。
- 计划出现在底部审阅面板，有两个选择：
  - **Approve**：退出 Plan 模式，Agent 从下一步开始执行计划；
  - **Keep planning**：留在 Plan 模式，你写下的意见会交给 Agent 修改计划后重新提交。
- 取消审阅或审阅不可用时仍停留在 Plan 模式。
- Plan 模式通过提示词约束 Agent，工具列表不变；实际能否写入仍由当前权限预设决定。想确保规划阶段不会改动文件，可以同时切换到 `read-only`。
- Agent 运行中切换 Plan 模式时，切换会在下一个步骤边界生效。

## Agent 提问

Agent 需要你做选择或补充信息时，会在底部显示问题卡。一次可以有多个问题；有选项的问题可能允许多选，也可以填写自己的答案。回答后 Agent 在同一轮中继续。

## Goal：持续推进一个目标

```text
/goal 让项目的全部测试通过
```

设置 Goal 后，每当 Agent 空闲，系统会自动发起一轮新的续跑，直到 Agent 判断目标完成、报告受阻，或达到轮数上限（默认 256 轮）。每个会话同时只有一个 Goal。

| 命令                | 作用                 |
| ------------------- | -------------------- |
| `/goal`             | 查看当前 Goal        |
| `/goal <目标>`      | 设置 Goal 并开始续跑 |
| `/goal edit <目标>` | 修改目标             |
| `/goal pause`       | 暂停自动续跑         |
| `/goal resume`      | 恢复自动续跑         |
| `/goal clear`       | 清除当前 Goal        |

Goal 的状态：

- `active`：正在推进；
- `paused`：已暂停，`/goal resume` 后继续；
- `blocked`：受阻，界面显示原因（例如达到轮数上限）；修改目标或恢复后可以继续；
- `complete`：已完成。

需要知道的行为：

- 你的消息总是优先：Goal 续跑只在 Agent 空闲且没有你的新消息时发起。
- 停止当前任务（`/stop`）会中断正在进行的续跑轮，Goal 转为暂停。
- 应用重启后 Goal 保留原状态，但不会自动继续续跑，需要 `/goal resume`。
- Goal 不提高权限；续跑轮与普通对话使用同一权限预设。
- Agent 只能在你直接发出消息的那一轮，或正在进行的续跑轮中把 Goal 标记为完成或受阻。
- 状态条显示当前 Goal 的阶段、目标和已用轮数。

## 选择建议

| 情况                            | 使用                 |
| ------------------------------- | -------------------- |
| 一次问答或明确的小修改          | 普通 Chat / Build    |
| 想先看方案再决定是否修改        | Plan                 |
| 希望 Agent 自己一轮轮推进到完成 | Goal                 |
| 只想定时发起普通 Agent turn     | Scheduler，不是 Goal |

Goal 的内部机制见 [Goal 架构](../architecture/goal-mode.md)，权限与 Plan 的内部机制见[权限与 Plan 架构](../architecture/control-and-permissions.md)。
