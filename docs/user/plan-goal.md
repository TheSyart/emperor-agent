# Plan 与 Goal

> 文档状态：Active<br>
> 面向读者：需要控制权限、审阅方案或持续推进长任务的用户<br>
> 最后核验：2026-07-21<br>
> 事实源：slash command parser、ControlManager、PermissionPipeline、GoalCoordinator 与 Completion Gate

Plan（规划模式）和 Goal（目标模式）解决不同问题，但在 Composer 中是互斥的顶层模式。Plan 控制“先提出什么方案、何时允许执行”；Goal 管理“跨多少回合持续推进、满足什么条件才算完成”。Goal 可以在内部使用 Plan 引擎，界面仍只显示 Goal。

## 权限模式

| 界面命令       | 内部模式          | 行为                                                                                     |
| -------------- | ----------------- | ---------------------------------------------------------------------------------------- |
| `/mode ask`    | `ask_before_edit` | 只读文件、搜索与诊断直接执行；文件修改、Shell、外部写入和持久任务变更先询问              |
| `/mode edits`  | `smart_auto`      | 自动执行工作区编辑、构建测试、安全复合命令和本地非破坏性 Git；外部或高风险操作先询问     |
| `/mode auto`   | `full_access`     | 普通操作不再请求权限；显式拒绝、Plan 约束、schema、workspace 和系统 containment 继续生效 |
| `/mode status` | —                 | 查看当前模式和 pending interaction                                                       |

模式不会关闭路径安全、schema 校验、workspace policy 或 Core deny。

`smart_auto` 会直接执行常见构建、测试、格式化、本地 Git 和逐段安全的复合诊断命令；无法确定副作用时会先做一次脱敏语义分类，失败则询问。`full_access` 不再产生 Permission Ask，但普通 `ask_user` 仍可用于需求澄清；所有模式都不能绕过 OS containment 和 Core deny。

## Plan：先规划再执行

从输入框的 `/` 菜单选择 Plan 会立即开启规划模式，并在权限选择器右侧显示 Plan 标识。手动命令如下：

```text
/plan
/plan on
/plan off
/plan status
```

`/plan` 与 `/plan on` 等价。Agent 空闲时，Plan 标识右上角的关闭按钮会执行 `/plan off` 的语义；Agent 正在运行时，该按钮只显示原因，不会退出 Plan。

进入 Plan 后，Agent 可以读取信息、澄清问题并提交结构化方案，但不能执行普通写操作。权限选择器仍显示并允许修改询问确认、智能自动或完全访问；这只更新 Plan 结束后的执行权限，不会退出 Plan。用户批准后，系统按最新选择继续，Plan token 只授权与批准方案相符的执行。

如果当前已经有 Plan，再次输入 `/plan` 会立即取消旧 Plan 并开始一份新草稿。旧 Plan 会显示为“已取消/被新计划替代”，只保留审计记录；即使后来放弃新草稿，也不会恢复旧 Plan。只有 Agent 正式提交结构化方案后才会出现审批面板，普通说明文字不会覆盖或伪造一份计划。

Plan 记录步骤、依赖、验证要求和 reviewer 信息。批准后任务清单由当前 Plan 步骤自动投影；勾完清单只代表实现声明，要求验证的步骤必须取得成功证据才能完成。验证失败或缺少证据时，Plan 会保持未完成并明确列出阻塞项。步骤完成也不自动等于 Goal 完成；没有 Goal 时，Plan 只负责本次执行路径。

Plan 卡片始终是静态提案历史，不会在卡片内部不断增长执行步骤。流式方案尚未完成时卡片标记“生成中”，不会提前显示审批；完整方案进入 waiting 后，底部用“实施此计划？”决策面板替代 Composer。批准或提交修改意见后恢复保留原草稿/附件的 Composer。批准、步骤进度、验证结果和最终状态会沿聊天时间线继续向下显示，工具调用与思考按真实事件顺序穿插其中。普通 Ask 和 Permission Ask 采用相同的底部替换与恢复规则。

`/plan off` 和计划批准都会恢复 `previous_mode` 中保存的最新执行权限，不会固定回到 `ask_before_edit`。

如果当前是 Goal，`/plan off` 不会碰触 Goal 内部的规划状态；`/plan status` 会说明顶层模式仍是 Goal。只有独立 Plan 才能由这组命令关闭。

## Goal：持续完成一个结果

可以直接创建 Goal：

```text
/goal 完成目标，并给出明确验收证据
```

也可以从 `/` 菜单选择 Goal，或单独输入 `/goal`。Composer 会先显示 Goal 标识，并把下一条纯文字作为 Outcome。若当前是独立 Plan，系统会先退出 Plan；退出失败时不会进入 Goal。创建成功后，Core 立即启动 Goal；创建失败时输入和待输入状态都会保留，可以修改后重试。

待输入状态是 renderer 的会话级临时状态，不属于 Goal 状态机，也不会写入磁盘。切换会话或重启应用会清除它。现有 `goals.start` 只接收 Outcome，因此这个入口不接受附件、Skill 或 MCP 引用；Composer 会阻止提交，不会丢弃用户已经添加的内容。

Goal 会先固定 Outcome，再形成包含范围、约束和 Acceptance Criteria 的 Contract。Contract 锁定后，模型、renderer、Hook 和普通回复都不能改写 Outcome 或直接写入完成态。

Goal 常用命令：

| 命令                                         | 作用                                 |
| -------------------------------------------- | ------------------------------------ |
| `/goal`                                      | 等待下一条纯文字作为 Outcome         |
| `/goal <outcome>` 或 `/goal start <outcome>` | 创建当前会话的 Goal                  |
| `/goal status`                               | 读取当前 Goal                        |
| `/goals`                                     | 列出当前会话的 Goal                  |
| `/goal pause` 或 `/goal-pause`               | 安全暂停                             |
| `/goal resume` 或 `/goal-resume`             | 重新校验 session 和 workspace 后继续 |
| `/goal cancel` 或 `/goal-cancel`             | 永久取消                             |

每个 session 最多有一个非终态 Goal。Stop 在 Goal 中会转成可恢复的 Pause；Cancel 是不可恢复终态。应用重启不会自动恢复写操作，用户必须显式 Resume。

Composer 上方的 Goal 状态条会显示阶段、Outcome 和持续时间，并提供编辑、暂停/恢复与取消。编辑 Outcome 不会原地改写已锁定 Contract：Core 会取消旧 Goal，再创建带 supersession 关系的替代 Goal；旧事件和证据继续保留。替换失败时界面保留输入并显示错误，不会把失败伪装成成功。

权限选择器右侧只会显示一个 Goal 或 Plan 标识。Goal 内部处于 planning 时仍显示 Goal，状态条显示“规划中”，不会同时出现 Plan。鼠标悬浮或键盘聚焦后，右上角出现关闭按钮。待输入 Goal 的关闭按钮只退出临时状态，并保留输入框文字；正式 Goal 在暂停或等待用户时可以直接取消。Agent 运行期间，标识上的快捷关闭不可用；状态条和显式 `/goal cancel` 仍可按原有方式操作。

### 在 Plan 和 Goal 之间切换

Agent 空闲时，菜单和命令使用同一套切换规则：

| 当前状态                                    | 选择另一模式后的结果                                 |
| ------------------------------------------- | ---------------------------------------------------- |
| 普通状态 → Plan                             | 直接开启独立 Plan                                    |
| 普通状态 → Goal                             | 进入待输入 Goal，或用 `/goal <outcome>` 直接创建     |
| 独立 Plan → Goal                            | 先恢复保存的执行权限，再进入 Goal                    |
| Goal 待输入 → Plan                          | 清除待输入状态、保留 Composer 文字，再开启 Plan      |
| Goal `paused` / `awaiting_user` → Plan      | 永久取消旧 Goal，再开启 Plan；旧记录继续保留用于审计 |
| Goal 正在 Contract、规划、执行或核验 → Plan | 拒绝切换，必须先停止或暂停                           |

切换过程带互斥保护，连续点击不会重复取消 Goal 或重复发起 Core 请求。Goal 已取消后若 Plan 开启失败，系统会明确报告部分失败，不会把旧 Goal 伪装成可恢复状态。Goal 进入终态时，renderer 还会清理 Goal 内部遗留的 Plan control 投影，避免出现“幽灵 Plan”标识。

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
