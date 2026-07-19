# Control、Plan 与权限架构

> 文档状态：Active<br>
> 面向读者：维护者、开发者<br>
> 最后核验：2026-07-19<br>
> 事实源：`packages/core/src/control/`、`packages/core/src/permissions/`、`packages/core/src/plans/`、`packages/core/src/environment/sandbox.ts`、slash command parser

Control 系统把“模型想做什么”和“Core 允许做什么”分开。界面、模型、Goal、Scheduler、Team 和 Hook 都不能自行扩大权限；最终决定由 Core 的 permission pipeline、pending interaction、workspace policy 和 mutation guard 共同完成。

## 三种执行权限与 Plan 状态

| 内部值            | Slash command | 语义                                                                                            |
| ----------------- | ------------- | ----------------------------------------------------------------------------------------------- |
| `ask_before_edit` | `/mode ask`   | 低风险读取、普通文件写入和只读诊断命令可直接执行；敏感路径、批量替换、删除/重命名和代码执行询问 |
| `accept_edits`    | `/mode edits` | 普通文件编辑和精确 patch 可直接执行；删除/重命名、shell、高风险和非文件 mutation 仍按规则询问   |
| `auto`            | `/mode auto`  | 在既有安全策略内尽量继续；不能证明为只读的 shell 命令仍需批准                                   |

Plan 仍以内部 `mode === plan` 表示只读运行状态，但不再作为第四种用户权限。`/mode ask|edits|auto|status` 只管理执行权限；`/plan` 默认开启 Plan，`/plan on|off|status` 保留完整控制语义。Composer 的 `/` 菜单、裸命令和显式命令都经过同一个 renderer 生命周期控制器，不把命令帮助文字插入输入框。

## 决策顺序

```mermaid
flowchart TD
  Request["工具或领域 mutation"] --> Schema["Schema 与 Core deny"]
  Schema --> Rules["用户规则与高风险检查"]
  Rules --> Pending{"存在 pending Ask / Plan?"}
  Pending -->|"是"| Block["暂停或拒绝新的 mutation"]
  Pending -->|"否"| Mode["Permission mode"]
  Mode --> Workspace["Workspace path policy"]
  Workspace --> Decision{"允许执行?"}
  Decision -->|"需要确认"| Ask["持久化 Ask interaction"]
  Decision -->|"允许"| Containment["OS containment capability"]
  Containment -->|"可用"| Execute["执行并记录 receipt"]
  Containment -->|"必需但不可用"| Deny
  Decision -->|"拒绝"| Deny["返回稳定拒绝结果"]
```

用户规则和确定性高风险限制优先于模式。`auto` 不是关闭安全检查，`accept_edits` 也不是 shell 的通行证。路径操作在执行前必须 canonicalize，并受 workspace allow / deny 规则限制。

多路径文件操作不能只画像第一个参数。`rename_file` 通过 Tool contract 同时暴露 source 与 destination；permission rule 的 `pathGlob` 对任一路径匹配即生效，敏感路径检测同样扫描完整集合。`delete_file` 与 `rename_file` 在 `ask_before_edit` 和 `accept_edits` 下固定产生高风险批准，`apply_patch` 按普通精确文件编辑处理，但 `replace_all=true` 仍需批准。

默认免审命令只包含经正向证明为只读的诊断入口。`pytest`、`python -m pytest`、`npm test`、`npm run ...` 等会加载项目控制的代码，必须创建高风险权限 Ask；命令名、测试框架或日常使用频率不能替代这个边界。显式用户规则和精确 Plan permission token 仍可按既有顺序受控授权。

## Shell AST 与策略来源

`run_command` 先经过有界的 `emperor-shell-ast-v1` 分类器。它把引号拼接还原为 argv，识别 pipeline、`&&` / `||`、序列、后台、redirect/heredoc、命令或进程替换、参数/算术展开、subshell、brace group 和 control flow；嵌套命令替换中的命令也进入风险检查。解析失败、Unicode 隐蔽空白、控制字符、节点/深度/长度超限和无法证明的复杂结构一律不能晋升为只读。

只读不是“命令名白名单”。当前正向证明范围刻意很窄：受限 flags 的 `pwd`、只查看当前目录的 `ls`，以及拒绝输出文件、external diff/textconv、帮助执行路径和 branch mutation flags 的少量 Git 查询。管道、重定向、环境赋值、动态展开、workspace 外/UNC/parent-traversal 参数都会失去免审资格。旧 resolver 只作为收紧高风险结果的 fallback，不能授予 allow。

每个 `PermissionDecision.explanation` 都包含所有规则候选的 action、source、trust、是否匹配与稳定 precedence，以及最终选中项。来源 trust 由加载层注入，不接受规则 JSON 自报。匹配候选按 `deny > ask > allow` 排序，同 action 再按 `system > managed > user > project > runtime > unknown`、specificity 和稳定输入顺序排序；低信任 allow 不能放宽高信任 ask/deny，Core 的 Plan、Auto 未证明只读、项目代码执行和高风险 shell 约束也不能被本地 allow 绕过。命令解释只保存结构、reason code、计数和 SHA-256 fingerprint，不保存 argv 或命令正文。

规则层先通过共享 `ConfigResolver` 归一化，再进入 Permission precedence。builtin/user/project/session/managed 的次序与输入数组无关；managed 规则最后进入约束面。标记为 untrusted 的 project layer 只能贡献 `ask` / `deny`，其中的 `allow` 在解析阶段就被拒绝，不会依靠后续碰巧出现的 deny 兜底。这个层只适配旧规则输入，不把规则搬到新文件，也不接受 manifest 或远程 campaign 自报 trust。

子代理 `AgentDefinition` 是 Permission 前的额外能力上限，不是新的 allow 来源。Extension source 的 trust 由 resolver loader 注入；session definition policy 只能求交集或选择更严格的 memory/sandbox/turn 上限。即使高优先级 manifest 声明某工具、网络或进程可用，Permission、workspace fence 或 OS containment 的 ask/deny/required 仍可继续收紧；manifest 和低层 session 数据不能覆盖这些 Core 约束。

分类器是可替换 capability，但调用边界必须使用 fail-closed wrapper。分类器抛异常或返回无效结果时，`run_command` 转为 Ask；获准使用 Bash 的 command hook 也会在 spawn 前拒绝。新的 terminal/进程入口必须复用同一能力，而不是另写字符串 allowlist。

## Permission 与 OS containment 是两份事实

Permission decision 只回答“Core 是否授权尝试这个 effect”，不等于操作系统已经把进程隔离。`run_command` 在获准后还要经过 `OsSandboxController`：macOS 使用系统 Seatbelt (`sandbox-exec`)，Linux 使用已通过 user-namespace probe 的 `bwrap`，Windows 当前明确报告 `windows-unsupported`。每次执行都产生独立 containment receipt，包含实际 backend、capability status、filesystem/network/process-tree 能力和 policy hash；receipt 不含 profile 原文、HOME 或完整 PATH。`OwnedProcessRunner` 在 spawn 前提交 receipt；提交失败时不启动进程，避免先产生副作用再丢失 containment 事实。

未证明只读的命令把 OS containment 设为 required。backend 缺失、probe 失败或平台不支持时，Core 在 spawn 前 fail closed，并返回 `containment_unavailable`，不会把权限批准伪装成 sandbox。严格只读诊断使用 preferred：backend 不可用时可以运行，但 receipt 必须明确标为 `unsandboxed`。当前 sandbox 只允许 workspace 和每次执行的私有临时目录写入，隐藏/拒绝 `stateRoot`，阻断 workspace 外读写、symlink/子进程逃逸和网络；读取系统运行库与受控 PATH root 只读放行。

Linux 的生产 backend 当前只有 bwrap：probe 不只检查文件存在，还实际启动最小 namespace。直接 Landlock 需要经过审核的 native helper，当前未随包提供，因此 capability matrix 把它视为“尚无实现”，不能用 kernel 版本推测 available。Windows 同理保留 Job Object + ACL 研究项，但在实现、攻击测试和 package receipt 完成前保持 unsupported。

## Ask 生命周期

Ask 是持久的用户交互，不是普通 assistant 文本：

1. Core 创建带 operation、风险和上下文的 pending interaction。
2. Runner 暂停当前 turn；renderer 展示允许的选择。
3. 用户决定由 CoreApi 提交，Core 验证 interaction 与 session 的归属。
4. 一次性允许只对对应请求生效；拒绝不会被 Goal continuation 或后台任务跳过。
5. 重启后 pending interaction 仍按 Store 状态恢复。

`ask_user` 是模型向用户补充信息的交互入口；权限 Ask 则由 Core 决策产生。两者都必须通过正式 interaction 解决，不能从普通回复推断“用户已经同意”。

## Plan 生命周期

进入 Plan 时，Core 把当前执行权限保存在 `previous_mode`。Plan 阶段允许只读探索、`ask_user` 和 `propose_plan`；用户仍可调用 `control.setPermissionMode` 修改 `previous_mode`，而不退出 Plan。批准方案或执行 `/plan off` 后，Core 使用最新保存的权限继续。

Renderer 还维护一个会话级 Goal capture 投影，表示“已经选择 Goal，正在等待 Outcome”。它不是 Core control mode，也不是持久 Goal。裸 `/goal` 和 Composer 菜单共用这个投影；下一条纯文字才会调用 `goals.start`。会话切换、应用重启或用户关闭标识都会清除该投影。Goal 创建失败时投影回到待输入状态，避免把失败当成已启动。

### Composer 顶层生命周期互斥

Renderer 将 active Goal、Goal capture 和独立 Plan 投影为单一 `goal | plan | null` 状态。判定时 Goal 优先：只要 Goal 或 capture 存在，即使 Core 因 Goal 内部规划而处于 `mode === plan`，Composer 也只显示 Goal。

生命周期控制器串行处理所有切换：

- Plan → Goal：先恢复 `previous_mode`，成功后才能进入 capture 或创建 Goal。
- Goal capture → Plan：先清除 capture，再开启 Plan；Composer 草稿不属于 capture，因此不会被清空。
- `paused` / `awaiting_user` Goal → Plan：以 `user_switch_to_plan` 原因永久取消 Goal，再开启独立 Plan。
- `contract` / `planning` / `executing` / `verifying` Goal → Plan：拒绝切换。
- 普通 Agent turn、Goal 启动或另一次生命周期转换进行中：拒绝新的切换。

Goal 取消成功但 Plan 开启失败属于不可回滚的部分成功：旧 Goal 保持终态，renderer 报告明确错误。Goal 通过其他路径进入终态时，renderer 会恢复残留的 `previous_mode`；由 Goal → Plan 切换产生的终态带去重标记，避免终态监听器误关刚开启的独立 Plan。

Plan 保存步骤、依赖和验证要求。Plan permission token 只授权与已批准方案匹配的执行，不覆盖高风险限制、workspace policy 或新的 Ask。方案被修改、替换或失效后，旧 token 不能继续使用。

Plan 可以独立用于一次任务，也可被 Goal 绑定。绑定到 Goal 的 Plan 是内部阶段，不构成第二个 Composer 顶层模式。Goal 中 Plan 完成只表示步骤执行完毕；Goal 还要通过 Acceptance Criteria、Evidence 和 Completion Gate。

## 领域 mutation guard

CoreApi 对 Scheduler、Team、Goal、Hooks 和其他领域 mutation 使用统一 guard。存在 pending Ask / Plan，或者当前权限不允许时，后台入口也必须暂停或拒绝。Renderer 不能通过调用另一条 operation 绕开正在等待的交互。

具体边界：

- Goal 不提高权限，恢复 Goal 也不会自动批准旧请求。
- Scheduler 到时触发的 turn 与普通 turn 使用同一套权限约束。
- Team / subagent 输出是输入或证据候选，不是授权决定。
- Hook 可以观察和提出动作，不能直接写入 Goal 终态。
- `hooks.testRun` 即使已有显式执行确认，也必须在解析或启动 handler 前通过 Plan/pending mutation guard。
- Todo、Plan 卡片和普通 assistant 最终回复都没有领域终态写权限。

## 修改时必须同步

- 权限模式：slash parser、command palette、Core 类型、持久化与用户文档。
- 新工具风险：tool metadata、permission pipeline、只读判定、测试。
- Plan 语义：Plan Store、token 验证、renderer interaction 与 Goal bridge。
- 新领域 mutation：CoreApi guard、pending interaction 行为、重启恢复与诊断。

用户操作说明见[Plan 与 Goal](../user/plan-goal.md)，执行链路见[Agent runtime](agent-runtime.md)。
