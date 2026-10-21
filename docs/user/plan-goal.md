# 计划与目标

> 文档状态：Active<br>
> 面向读者：需要控制权限、审阅方案或持续推进任务的用户<br>
> 最后核验：2026-10-20<br>
> 事实源：`packages/core/src/harness/approval/presets.ts`、`packages/core/src/harness/sandbox/`、`packages/core/src/harness/tools/builtin/skill-manage.ts`、`packages/core/src/harness/tools/builtin/mcp-config.ts`、`packages/core/src/harness/plan/plan-mode.ts`、`packages/core/src/harness/goal/`、`packages/core/src/commands/builtins.ts`

权限预设决定 Agent 能写哪里；计划（规划模式）决定 Agent 先提方案还是直接动手；目标（目标）让 Agent 在你不再输入时继续推进同一个目标。三者可以组合使用。

## 权限预设

| 命令                                    | 写入范围                      | 审批                                 |
| --------------------------------------- | ----------------------------- | ------------------------------------ |
| `/permissions read-only`                | 不允许写入                    | 需要写入时逐次请求你批准             |
| `/permissions workspace-write`          | 当前 workspace 与系统临时目录 | 超出范围时逐次请求你批准（默认预设） |
| `/permissions danger-full-access`       | 不限制                        | 不弹出审批；需要审批的请求被自动拒绝 |
| `/permissions` 或 `/permissions status` | —                             | 打开权限面板查看当前预设             |

- 新会话总是从 `workspace-write` 开始；预设只属于当前会话，不会保存为全局规则。
- 批准只对那一次工具调用有效，下一次仍会询问。
- 沙箱主要限制文件写入，网络访问不受限制。读取有一张固定的例外表（任何预设下都生效）：Emperor Home 的 `computer-use/`、`browser/` 与 `model_config.json`、`mcp_config.json`、`settings.json`、`hooks.json`（含它们的备份）Agent 既不能读也不能改，提权也不行；`~/.ssh`、`~/.aws`、`~/.config/gcloud`、`~/.docker/config.json`、`~/.netrc`、`~/.codex/auth.json`、`~/.claude/.credentials.json` 不能写，读取要你批准一次提权（审批卡写明文件和理由），`danger-full-access` 下可以直接读。因此在默认预设下，经 SSH 的 `git push` / `pull`、`aws`、`gcloud` 等命令需要批准一次，或在你自己的终端里执行。
- Shell 命令在 macOS 上使用 Seatbelt、在 Linux 上使用 bubblewrap 执行。其他平台没有沙箱后端，`read-only` 和 `workspace-write` 下的 Shell 命令会直接失败，需要时切换到 `danger-full-access`。
- 记忆编辑、MCP 工具、Skill 加载和定时任务工具不受沙箱限制，也不需要审批。
- Agent 用 `skill_manage` 新建、修改、删除或导入 Skill，或用 `mcp_config` 添加、删除、启停 MCP server 时，写入同样跟随当前预设：`danger-full-access` 下直接执行，其他预设每次写入都会请求你批准。
- 子智能体继承当前会话的沙箱模式，但不能请求提权。

## 计划：先规划再执行

```text
/plan
/plan 为现有项目设计一套迁移方案
/plan off
```

- `/plan` 进入计划模式；`/plan <消息>` 进入的同时把消息发给 Agent；`/plan off` 退出。
- 计划模式下 Agent 会先只读探索、在必要时向你提问，然后提交一份以标题开头的完整计划。
- 计划出现在底部审阅面板，有两个选择：
  - **Approve**：退出计划模式，Agent 从下一步开始执行计划；
  - **Keep planning**：留在计划模式，你写下的意见会交给 Agent 修改计划后重新提交。
- 取消审阅时仍停留在计划模式，本轮随即结束，等你输入自己的意见；审阅不可用时同样停留在计划模式。
- 计划模式通过提示词约束 Agent，工具列表不变；实际能否写入仍由当前权限预设决定。想确保规划阶段不会改动文件，可以同时切换到 `read-only`。
- Agent 运行中切换计划模式时，切换会在下一个步骤边界生效。

## Agent 提问

Agent 需要你做选择或补充信息时，会在底部显示问题卡。一次可以有多个问题；有选项的问题可能允许多选，也可以填写自己的答案。回答后 Agent 在同一轮中继续。

## 目标：持续推进一个目标

```text
/goal 让项目的全部测试通过
```

设置目标后，每当 Agent 空闲，系统会自动发起一轮新的续跑，直到 Agent 判断目标完成、报告受阻，或达到轮数上限（默认 256 轮）。每个会话同时只有一个目标。

| 命令                | 作用               |
| ------------------- | ------------------ |
| `/goal`             | 查看当前目标       |
| `/goal <目标>`      | 设置目标并开始续跑 |
| `/goal edit <目标>` | 修改目标           |
| `/goal pause`       | 暂停自动续跑       |
| `/goal resume`      | 恢复自动续跑       |
| `/goal clear`       | 清除当前目标       |

目标的状态：

- `active`：正在推进；
- `paused`：已暂停，`/goal resume` 后继续；
- `blocked`：受阻，界面显示原因（例如达到轮数上限）；修改目标或恢复后可以继续；
- `complete`：已完成。

需要知道的行为：

- 你的消息总是优先：目标续跑只在 Agent 空闲且没有你的新消息时发起。
- 停止当前任务（停止按钮或 `/stop`）会中断正在进行的续跑轮，目标转为「已暂停」并保存下来，用 `/goal resume` 继续。这个会话正在运行的 Claude Code / Codex 任务会一并停止。
- 应用重启后目标保留原状态，但不会自动继续续跑，需要 `/goal resume`。
- 目标不提高权限；续跑轮与普通对话使用同一权限预设。
- Agent 只能在你直接发出消息的那一轮，或正在进行的续跑轮中把目标标记为完成或受阻。
- 输入框上方的目标条显示当前目标的阶段、目标和已用轮数，可以暂停或恢复、编辑（把 `/goal edit <目标>` 放进输入框）和清除。

## 选择建议

| 情况                            | 使用               |
| ------------------------------- | ------------------ |
| 一次问答或明确的小修改          | 普通 Chat / Build  |
| 想先看方案再决定是否修改        | 计划               |
| 希望 Agent 自己一轮轮推进到完成 | 目标               |
| 只想定时发起普通 Agent turn     | 定时任务，不是目标 |

目标的内部机制见 [目标架构](../architecture/goal-mode.md)，权限与计划的内部机制见[权限与计划架构](../architecture/control-and-permissions.md)。
