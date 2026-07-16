# Plan 与 Goal

> 文档状态：Active<br>
> 面向读者：需要控制权限、审阅方案或持续推进长任务的用户<br>
> 最后核验：2026-07-16<br>
> 事实源：slash command parser、ControlManager、PermissionPipeline、GoalCoordinator 与 Completion Gate

Plan（规划模式）和 Goal（目标模式）不是同一层能力。Plan 控制“先提出什么方案、何时允许执行”；Goal 管理“跨多少回合持续推进、满足什么条件才算完成”。

## 权限模式

| 界面命令       | 内部模式          | 行为                                                                                     |
| -------------- | ----------------- | ---------------------------------------------------------------------------------------- |
| `/mode ask`    | `ask_before_edit` | 默认模式；低风险读取、普通文件写入和低风险命令可继续，敏感路径、批量替换和高风险操作询问 |
| `/mode edits`  | `accept_edits`    | 普通文件编辑可以直接执行，shell、Team、Scheduler 等 mutation 仍需确认                    |
| `/mode auto`   | `auto`            | 在现有权限范围内自动推进；复杂或未证明只读的 shell 仍可能询问                            |
| `/mode status` | —                 | 查看当前模式和 pending interaction                                                       |

模式不会关闭路径安全、schema 校验、workspace policy 或 Core deny。

## Plan：先规划再执行

使用下面的命令控制 Plan：

```text
/plan on
/plan off
/plan status
```

进入 Plan 后，Agent 可以读取信息、澄清问题并提交结构化方案，但不能执行普通写操作。权限选择器仍显示并允许修改询问、编辑或自动；这只更新 Plan 结束后的执行权限，不会退出 Plan。用户批准后，系统按最新选择继续，Plan token 只授权与批准方案相符的执行。

Plan 记录步骤、依赖、验证要求和 reviewer 信息。步骤完成并不自动等于 Goal 完成；没有 Goal 时，Plan 只负责本次执行路径。

`/plan off` 和计划批准都会恢复 `previous_mode` 中保存的最新执行权限，不会固定回到 `ask_before_edit`。

## Goal：持续完成一个结果

创建 Goal：

```text
/goal 完成目标，并给出明确验收证据
```

Goal 会先固定 Outcome，再形成包含范围、约束和 Acceptance Criteria 的 Contract。Contract 锁定后，模型、renderer、Hook 和普通回复都不能改写 Outcome 或直接写入完成态。

Goal 常用命令：

| 命令                                         | 作用                                 |
| -------------------------------------------- | ------------------------------------ |
| `/goal <outcome>` 或 `/goal start <outcome>` | 创建当前会话的 Goal                  |
| `/goal status`                               | 读取当前 Goal                        |
| `/goals`                                     | 列出当前会话的 Goal                  |
| `/goal pause` 或 `/goal-pause`               | 安全暂停                             |
| `/goal resume` 或 `/goal-resume`             | 重新校验 session 和 workspace 后继续 |
| `/goal cancel` 或 `/goal-cancel`             | 确认后永久取消                       |

每个 session 最多有一个非终态 Goal。Stop 在 Goal 中会转成可恢复的 Pause；Cancel 是不可恢复终态。应用重启不会自动恢复写操作，用户必须显式 Resume。

Composer 上方的 Goal 状态条会显示阶段、Outcome 和持续时间，并提供编辑、暂停/恢复与取消。编辑 Outcome 不会原地改写已锁定 Contract：Core 会取消旧 Goal，再创建带 supersession 关系的替代 Goal；旧事件和证据继续保留。替换失败时界面保留输入并显示错误，不会把失败伪装成成功。

## Goal 怎样判断完成

Plan 步骤全部结束仍不够。Completion Gate 至少会检查：

- Contract 已锁定，Goal 仍处在合法 active/verifying 状态；
- 当前 Plan 完成，依赖、verification 和 waiver 有效；
- 每条 required Acceptance Criterion 的最新证据为 PASS；
- 必需的人工确认或独立 reviewer 已有 Core 签发的 receipt；
- 没有 pending Ask/Plan、scope 不匹配、存储错误或 guard 超限。

模型文字、Todo 全绿、Plan 状态、Stop Hook 和界面按钮都不能绕过 Gate。任何缺失或损坏的事实都会 fail closed。

## 暂停、阻塞和策略停止

- `paused`：可恢复。常见原因是用户 Stop、应用关闭、恢复校验或连续无进展。
- `blocked`：不可恢复终态，必须有持久化的 blocker cause。普通测试失败不是 block。
- `stopped_by_policy`：不可恢复终态，由显式 cycle、时间、成本或其他 guard 触发。
- `cancelled`：用户明确取消，不可恢复。

默认不设置总 cycle、总时长或总成本上限。连续三个 cycle 没有可确认进展时，Coordinator 会安全暂停。

## 选择建议

| 情况                             | 使用                 |
| -------------------------------- | -------------------- |
| 一次问答或明确的小修改           | 普通 Chat / Build    |
| 想先看方案再决定是否修改         | Plan                 |
| 多阶段开发、迁移、反复修复       | Goal                 |
| 任务有严格验收条件或需要独立复核 | Goal                 |
| 只想定时发起普通 Agent turn      | Scheduler，不是 Goal |

Goal 的存储、Evidence 和恢复协议见 [Goal 模式架构](../architecture/goal-mode.md)。
