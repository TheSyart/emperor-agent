# Goal 架构

> 文档状态：Active<br>
> 面向读者：Core 开发者、维护者<br>
> 最后核验：2026-09-22<br>
> 事实源：`packages/core/src/harness/goal/`、`packages/core/src/api/services/goal-service.ts`、`packages/core/src/harness/projection/projector.ts`

Goal 让同一个 session 在用户不再输入时继续推进一个目标。它是同 session 的状态：每个 session 最多一个当前 Goal，全部事实记录在该 session 的 `log.jsonl` 中，没有独立的 Goal 存储目录。

## 状态

| 字段            | 含义                                            |
| --------------- | ----------------------------------------------- |
| `objective`     | 目标文本                                        |
| `phase`         | `active`、`paused`、`blocked` 或 `complete`     |
| `maxGoalRounds` | 自动续跑轮数上限，默认 256                      |
| `roundsStarted` | 已被接纳的续跑轮数                              |
| `blockedReason` | `blocked` 时的 `{ code, message }`              |
| `activation`    | `armed` 或 `disarmed`；只存在于进程内，不持久化 |
| `revision`      | 每次持久变更递增，用于 compare-and-set          |

持久事件有两种：

- `goal/change`：每次变更携带变更后的完整快照；清除（`clear`）写入带 revision 的墓碑。
- `goal/round`：为一条特定的 inbox 消息预留一轮续跑。只有对应的 `user/message` 真正进入 step 时，该轮才被计数。

Activation 从不持久化：进程重启、恢复或 fork 后首次观察到的 session 即使 Goal 为 `active` 也处于 `disarmed`，需要显式 resume 才会继续自动续跑。

## 续跑驱动

`harness/goal/round-driver.ts` 在 Agent 空闲时检查：Goal 为 `active`、`armed` 且还有轮数时，持久预留第 `roundsStarted + 1` 轮，并通过 `agent.followup()` 排入一条 `<goal_round>` 上下文消息。预留仍对应当前 revision 时，pre-step gate 才接纳这条消息。

空闲检查点的结果：

- 被接纳的一轮正常结束 → 预留下一轮；
- 预留后从未被接纳，或被接纳的一轮被取消 → 持久 `pause`；
- 下游 pre-step 拒绝有效轮次 → `block`（`prompt-rejected`）；
- 与 Goal 无关的取消、max-tokens 或 Agent 错误 → 只 disarm；
- 达到 `maxGoalRounds` → `block`（`round-limit`）。

用户的输入始终优先：预留尚未被接纳时有新的用户消息排队，该预留作废，在下一个空闲检查点重新预留。

## 工具与授权

模型通过三个工具读写 Goal：`get_goal`、`create_goal`、`update_goal`（动作 `edit`、`pause`、`resume`、`complete`、`blocked`）。所有工具只能在调用方 Agent 的活动 turn 内执行，变更使用 `goal_id` + `revision` 做 compare-and-set。

- `create_goal`、`edit`、`pause`、`resume` 要求本 turn 中顶层 Agent 接收过用户直接输入。
- `complete` 与 `blocked` 要求用户直接输入，或本 turn 正是当前 Goal 的最新续跑轮。
- 在续跑轮中自报 `blocked`，至少要已经进行过 3 轮。
- 子代理不是顶层 Agent，不具备这些授权。

在续跑轮中完成或阻塞时，内核会追加一条收尾上下文，让模型给出简洁的总结。

## 用户入口

`/goal` 命令（`harness/goal/command.ts`）：

| 输入                     | 作用                                     |
| ------------------------ | ---------------------------------------- |
| `/goal`                  | 显示当前 Goal                            |
| `/goal <objective>`      | 创建 Goal                                |
| `/goal edit <objective>` | 修改目标                                 |
| `/goal pause`            | 暂停并 disarm                            |
| `/goal resume`           | 恢复并 arm（也用于重新 arm active 目标） |
| `/goal clear`            | 清除当前 Goal                            |

控制词只有在作为完整输入时才生效（不区分大小写），其他任何后缀都作为字面目标。命令变更使用用户授权。

CoreApi `goals.*`（`api/services/goal-service.ts`）是对同一服务的门面：`goals.start` 创建（可带 `maxRounds`），`goals.pause` / `goals.resume`，`goals.cancel` 清除，`goals.get` / `goals.list` 读取当前 session 的 Goal。Goal 替换已下线：需要换目标时先清除再创建，或用 `/goal edit`。

## 投影

`SessionProjector` 用 `harness/goal/fold.ts` 折叠 Goal 事件，产生 `goal_updated` runtime event；`HarnessHost.goalView()` 返回 GoalView，供 bootstrap、`workspace.snapshot` 和 Composer 状态条使用。Goal 与 log 一起回放，没有单独的恢复协议。

## 边界

- Goal 不提高权限，续跑轮与普通 turn 使用同一沙箱模式和审批策略。
- 续跑轮在同一 session 的 inbox 中排队，与用户消息、Scheduler 提交串行。
- 删除 session 会连同 log 一起删除其 Goal。
