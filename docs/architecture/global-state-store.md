# 全局私有存储根架构

> 文档状态：Active<br>
> 面向读者：用户、维护者、数据与迁移开发者<br>
> 最后核验：2026-07-23<br>
> 事实源：`packages/core/src/runtime/paths.ts`、`packages/core/src/runtime/migrate-state-root.ts`、各领域 Store

## 两个根的区分

Emperor Agent 区分两个互不重叠的根目录概念：

| 概念          | 含义                                                       | 默认值                                                   | 环境变量                        |
| ------------- | ---------------------------------------------------------- | -------------------------------------------------------- | ------------------------------- |
| `runtimeRoot` | 应用内置资源根：模板、内置技能、静态资源                   | 开发模式为仓库根；打包模式为 Electron `userData/runtime` | `--root` / `EMPEROR_AGENT_ROOT` |
| `stateRoot`   | 全局私有数据根：会话、记忆、配置、附件等一切运行期私有状态 | `~/.emperor-agent`（开发与打包模式一致）                 | `EMPEROR_CONFIG_DIR`            |

`runtimeRoot` 里的内容是只读或半只读的“应用资源”，例如 `templates/`、`skills/`、`model_config.example.json`、`mcp_config.example.json`；仓库中的两个配置示例源文件位于 `config/examples/`，打包后仍使用前述 runtime 文件名。`stateRoot` 里的内容是持续被读写的“用户私有状态”。两者刻意分离，且默认值**不再有包含关系**（旧模型里 `stateRoot` 是 `runtimeRoot/.emperor`，新模型里两者是完全独立的目录树）。

解析优先级（`packages/core/src/runtime/paths.ts` 的 `resolveRuntimePaths()`）：

- `runtimeRoot`：显式 `--root`/`root` 参数 > `EMPEROR_AGENT_ROOT` > 开发模式的仓库根 / 打包模式的 `userData/runtime`。
- `stateRoot`：显式 `stateRoot` 参数 > `EMPEROR_CONFIG_DIR` > `~/.emperor-agent`（`defaultStateRoot()`)。

## 目标目录模型

```text
~/.emperor-agent/
  emperor.local.json
  model_config.json       # schemaVersion 2；多个模型、单 active、可选显式 fallback/cost policy
  mcp_config.json
  hooks_config.json
  onboarding.json
  agents/
    agents.json           # 可选全局 user AgentDefinition source；strict schema/containment
  skills/                # 用户全局技能（Skill API 的写入目标）
  memory/
    profile/
      USER.local.md      # 用户偏好档案；由 ensureUserProfileFile() 播种/维护
    MEMORY.local.md      # 全局长期记忆；保留旧 MemoryStore 相对路径以便兼容迁移
    YYYY-MM-DD.md        # 按日情景记忆
    history.jsonl
    history_archive/
    history_index.json
    versions/
    plans/
    compaction/
    watchlist.md
    watchlist_state.json
    patch-ledger.jsonl
    tool-results/         # 截断工具结果的内容寻址完整正文与元数据
    hybrid-index/
      index.v1.json       # 可从 Markdown 权威记忆重建的派生检索索引
    attachments/<month>/
    media/<month>/
    desktop/window.json
    desktop_pet/window.json
    sidebar_state.json    # 左侧导航和右侧工作区 V3 布局
  sessions/
    index.json
    <session-id>/
      meta.jsonl
      history.jsonl
      message_graph.v2.jsonl # append-only message/branch/prompt queue sidecar
      runtime/events.jsonl # 兼容平面 V1 / EventEnvelope V2 的 renderer 回放日志
      _checkpoint.json
      turn-changes/       # 活动/暂停 turn 的私有变更基线与归因账本
      prompt-snapshots/
      file-checkpoints/
        index.json         # 受管文件工具的 before/after 元数据
        artifacts/         # 二进制或大文本的私有快照制品
  projects/
    index.json
    <project-id>/
      project.json
      AGENTS.local.md     # 全局私有项目记忆（见下方"命名易混淆点"）
      prompt-overlay.md
      team/               # 绑定项目的 Team 私有状态
  git/
    worktree-leases.json  # Emperor 创建的 session worktree owner/lease
    receipts/             # commit/push/pull/worktree/PR 的脱敏安全凭据
  code-intelligence/
    projects/
      <workspace-digest>/
        graph.v1.json.gz  # 可从 workspace 重建的受界派生符号图
    lsp/
      <owner-digest>/     # 受信 LSP 的隔离 scratch/HOME；不保存源码事实
  tasks/
    index.json
    archive/
    <task-id>/
      transcript.jsonl
      output.log          # 有界、cursor 可读的完整 task 输出
      output.meta.json    # 配额与 dropped bytes；仅发生截断后出现
  processes/
    receipts.v1.json      # 脱敏 owner/lease/PID identity/sandbox/quota 最小账本
  tokens/
    tokens.jsonl
    tokens_archive/
  scheduler/
    jobs.json             # V1 Job snapshot；可选 misfire/pending/active/run receipt 字段
    action.jsonl          # Scheduler Job 的 append-only action log
  team/
  subagent-worktrees/
    .leases.json          # 统一 GitWorktreeManager 管理的子代理隔离 lease
  control/
    state.json
    core-action.key
    turn-continuation-diagnostics.jsonl # 历史版本续跑评估诊断；新主回合不再写入
  hooks/
    audit.jsonl
    audit/
    project-trust.json
  goals/
    index.json
    diagnostics.json
    gate-facts.json
    gate-mutations.json
    blocker-causes.json
    blocker-facts.json
    post-commit-cleanup-acks.jsonl
    post-commit-cleanup-claims/
    post-commit-diagnostics.jsonl
    <goal-id>/
      events.jsonl        # hash-chained 权威事件账本
      goal.json           # 可从 events 重建的 snapshot
      observations.jsonl  # Core 捕获的工具 observation
  migrations/
    state-root-migration.json
```

### Hybrid Memory 派生索引

`memory/hybrid-index/index.v1.json` 不是记忆事实源。全局 `MEMORY.local.md`、项目 `AGENTS.local.md` 和相应 session/project scope 才是权威输入；索引只保存确定性分块、source/path/line provenance、source digest 和检索所需派生数据。文件损坏或被删除时，Core 忽略旧派生物并从 Markdown 重建，不会反向改写原始记忆。

索引采用同目录临时文件、file `fsync`、rename 与 directory `fsync`，文件权限为 `0600`。Chat 只可检索 global 和同 session 的 unbound session 记忆；Build 只可检索精确 project 的 project/session 记忆，不能读 global 或其他 project。模式 `off` 不创建索引，`eval` 只记录影子结果，只有 provider-bound 评估门禁通过的 `on` 才能注入 prompt。embedding 失败会自动使用 FTS，并只暴露稳定原因码与计数，不记录 provider 原始异常。

### Code Intelligence 派生数据

`code-intelligence/projects/<workspace-digest>/graph.v1.json.gz` 不是源码事实源。它只保存 workspace-relative location、content digest 与 parser revision；损坏、revision/root digest 不匹配或删除后会从项目源码重建。写入使用 `0600` 临时文件、gzip、file `fsync`、rename 与 directory `fsync`；增量事件在 single owner 内更新 COW state，并以 debounce 合并派生 cache 写入，正常关闭强制 flush。

Code Graph 最多索引 200 个受支持文件、累计 5 MiB、单文件 5 MiB；symlink、binary、unsupported、oversized、capacity 和 parse error 都只形成计数/稳定 limitation，不把原文写入 Diagnostics。`code-intelligence/lsp/<owner-digest>/` 只是 LSP 的隔离 scratch/HOME；实际项目以只读 root 提供，网络为 deny。模式 `off` 不创建这些目录；当前发行物默认关闭且没有 production LSP descriptor。

### Owned process receipt

`stateRoot/processes/receipts.v1.json` 是进程审计与启动 orphan reconcile 的最小原子账本，最多保留最近 10,000 条。每条只含随机 process/lease ID、owner、lease revision、command/cwd/workspace digest、containment receipt、输出配额计数、PID、boot marker、stable start identity 和终态；不含命令正文、argv、环境变量、输出、stdin 或无法跨重启恢复的 stream/handle。

账本中的 `starting` / `running` 不表示可以 resume。下次启动只会核对 live PID 的 boot marker 与 start identity：精确相同才终止进程树并验证退出；PID 消失或 identity 改变转为 `interrupted`；identity 不可验证时保留 `orphan_unverified`，避免误杀复用 PID。正常 session/app 关闭先取消 owned handle，显式 reparent 则以新 lease/revision 转移同 session owner。receipt 文件使用同目录临时文件、`fsync` 和 rename，并拒绝目标 symlink。

### 桌面工作台状态与终端

`memory/sidebar_state.json` 在原有左侧项目/会话折叠和排序字段之外保存 `right_workspace` V3：`workbenchOpen`、520–960px 的 `width`、`filesTreeWidth` 与 `launcher | review | terminal | files` 当前 pane。Environment 在桌面宽屏由布局规则常驻，不再保存可关闭偏好；打开工作区时原位替代，关闭后恢复。旧 V1/V2 状态在读取时迁移，已有 Review/Terminal/Files pane 和宽度继续保留。

活动或暂停用户任务的 `turn-changes/<session>/<executionId>.json` 只保存归因所需的受控基线，不把文件正文写入聊天或 runtime event。Ask、Permission、Plan 审批与明确继续共享原 `executionId`；普通新请求建立新账本。受管文件工具成功后，Core 相对任务起点计算净创建、修改、删除、重命名、二进制与 `+/-` 行数；恢复原状的文件退出集合。任务终态后删除基线正文，只保留有界 V2 `turn_change_snapshot` 公开统计。已证明只读的 Shell 不触碰账本，只有成功且无法精确归因的 workspace 写入才降为 `partial`，不能伪造总数。

`control/plan-execution-settlements.json` 保存 Plan 执行动作的私有 prepared/applied 事务，`control/core-action.key` 只用于本机 Core 签名。记录绑定 interaction、session、Plan、Step、审批代次和验证 requirement；不会把签名密钥、完整诊断或文件正文暴露给 renderer。启动恢复会幂等重放未完成结算，已写入 Plan metadata 的 receipt 防止同一动作重复生效。

`git/worktree-leases.json`、`subagent-worktrees/.leases.json` 与 `git/receipts/*.jsonl` 均为 Core 私有数据。Session 和子代理 worktree 都由同一个 `GitWorktreeManager` 校验仓库身份、受控路径和 lease，只允许 Emperor 创建且归属可验证的目录被自动清理。Receipt 只保存 action、branch、commit OID、脱敏 remote host、PR 编号/HTTPS URL/状态和完成时间，不保存 argv、环境变量或凭据。

用户直控 Terminal 不写入 `stateRoot`。Terminal ID、session owner、PTY handle、单调输出序号和有限滚动缓冲只存在于当前 Core 进程内；关闭工作台不会销毁，关闭标签、删除 owner session 或退出应用会终止。应用重启后 `terminals.list` 返回空集合，不根据历史 runtime event、process receipt 或 sidebar state 伪造终端恢复。终端输入和输出也不进入聊天历史、模型上下文、Diagnostics 或 runtime event 日志。

### Scheduler V1 兼容与恢复

`stateRoot/scheduler/jobs.json` 继续使用 version 1；升级只增加可选字段，不批量重写旧 Job。旧记录缺少 `misfire_policy` 时按最保守的 `skip` 读取，旧 run history 缺少 correlation 时使用 `run_id/task_id=null`、`trigger=timer` 和原 `run_at_ms` 作为计划时间。未知 policy 不能从持久数据升级为补跑；malformed pending/active identity、phase、时间或计数按现有 corrupt 隔离路径 fail closed。

每个 active run 保存 Core 生成的 run/task ID、`queued|running` phase、trigger、计划/入队/开始时间、policy、missed count，以及 owner key 的 SHA-256 digest；不保存新的 session/project owner 原文副本。公开 CoreApi/EventEnvelope 投影会移除 `owner_key_digest` 和内部的 `resume_next_run_at_ms`。run history最多保留 20 条，错误摘要有界，不包含 prompt、argv、绝对路径或完整输出。

`queued` 表示 handler 尚未被调用，启动时可用同一 identity恢复一次；`running` 可能已经产生非幂等副作用，绝不自动 replay。Scheduler 会用 `task_id` 只读检查 Task terminal：可证明 completed/failed/cancelled/interrupted 时只补齐 Scheduler receipt，否则收敛为 `interrupted`。完成 Task 与写 Scheduler terminal 之间的崩溃因此不会触发第二次 Agent effect。`latest` 和 `catch-up-one` 的启动补跑同样每个 Job 最多一个；`skip` 只写聚合 receipt并移动到未来触发点。

`history.jsonl` 继续是旧安装和现有模型上下文读取的兼容事实源，升级时不原地重写。`message_graph.v2.jsonl` 是逐 session、append-only 的 V2 sidecar：节点先写 `partial`，对应 V1 行成功落盘后再写 `committed`；写入失败、取消、模型失败或插话替代则写 `tombstoned`。启动时，带相同 `message_id` 的 V1 行可确认已经落盘的 partial，其余孤儿 partial 被 tombstone。sidecar 还保存显式 leaf、compact boundary，以及 queued/running/interjected/completed/cancelled prompt 状态。

Sidecar 只接受 regular file，拒绝 symlink，当前上限为 16 MiB / 50,000 个有效事件；损坏行被隔离并生成不回显原文的诊断。V1→V2→V1 投影保持 legacy 行内容，compact boundary 可回到压缩前捕获的精确 leaf。不要手工删除单条 tombstone 或重排 sidecar sequence；排障时应备份整个 session 目录。

项目源码目录（用户在 UI 里选择的 build 项目路径）只允许保留：

```text
<project>/
  AGENTS.md               # 项目协作文档，可提交，Core 只读不改写
  .emperor/
    settings.json
    settings.local.json
    rules/
    skills/                # 项目级技能，只读，不由 Skill API 写入
```

Core **不会**在项目源码目录下自动创建 `.emperor/sessions`、`.emperor/memory`、`.emperor/runtime`、`.emperor/attachments`、`.emperor/media` 或 `.emperor/goals`。如果这些目录已经因为旧版本或其他工具而存在，diagnostics 只会提示"检测到旧私有数据"，不会自动删除或搬移。

## 文件检查点

文件检查点是默认关闭的 Beta 能力。启用后，`write_file`、`edit_file`、`delete_file`、`rename_file` 和 `apply_patch` 在真实 ToolRegistry 边界记录受影响路径：Core 先把 before 快照和 `prepared` 索引 durable commit，再运行工具，最后记录 after 哈希并转为 `ready`。这套能力不拦截 `run_command`、MCP、外部程序或用户在编辑器中的任意写入，因此不是全盘文件系统快照。

文本小快照可内联保存在私有索引；二进制和较大快照进入 `artifacts/`。默认单文件上限 8 MiB、单 turn 24 MiB、单 session 128 MiB；before 超限会在工具副作用前拒绝，after 超限只保留哈希并把该检查点标记为不可完整回退。索引和制品使用原子临时文件、file fsync、rename 与目录 fsync；私有目录链或制品出现 symlink、越界、长度或 SHA-256 不一致时 fail closed。

进程在工具执行后、after 提交前终止时会留下 `prepared`。诊断页首次列出当前 session 时，Core 只对账当前受信 session/workspace：当前文件等于 before 就丢弃无变化记录，否则把当前字节作为 after 完成检查点；不会继续原工具 Promise，也不会重放命令。旧 session 没有 `file-checkpoints/` 时按空集合读取且不创建目录。

回退前必须重新计算当前文件状态并与 after 精确比较；任一路径发生外部变化、变为 symlink、不可读取或制品校验失败，整组回退被否决，不发生部分写入。通过预览后仍须由 renderer 发送显式 `confirmed: true`；恢复使用原子替换并在中途失败时尽力按 after 回滚。它不会执行 `git reset --hard`。

Soft Git rewind 的 transaction journal 位于 `stateRoot/git-rewind/transactions.v1.json`，scratch 也在该私有目录；项目目录只新增显式 rescue refs/reflog，以及用户选择 stash 策略时的 rescue stash。journal 先写 phase 再执行对应 Git effect，终态为 `completed`、`rolled_back` 或 `interrupted`。重启对账只读检查 FileCheckpoint status 与当前 HEAD：只有已 durable 完成的文件回退才能收敛为 completed，其余中间 phase 标记 interrupted 并保留救援引用，Core 不自动 reset、apply 或删除引用。journal 的 schema、容量、标识、OID、ref 与时间字段会在读取时完整校验；损坏文件被隔离为 `*.corrupt-*`，Diagnostics 显示计数和备份路径，不会静默把未知事务当作成功。

该路径 fail closed：bare/unborn/nested repository、linked worktree、Git metadata 或 `stateRoot` 位于不受支持边界、merge/rebase/cherry-pick/bisect/sequencer、unmerged index、submodule、sparse checkout 都不可执行。需要 stash 且 local filter 可能运行项目命令时同样拒绝。Git executable 和 version 只来自签名 tool catalog/environment probe；所有固定 argv 经 OwnedProcessRuntime、required containment、network deny 和 session owner 执行。

## Goal 私有状态

Goal 是 TypeScript-only 的新能力，所有持续状态位于 `stateRoot/goals/`。`<goal-id>/events.jsonl` 是权威源，`goal.json` 与根级 `index.json` 是可重建投影；Evidence、Plan binding、cycle/terminal receipt 通过 typed event payload 保存，工具观察写入独立 `observations.jsonl`。Gate facts、mutation epoch、typed blocker 与 post-commit cleanup 使用根级账本，防止模型、renderer 或崩溃恢复路径绕过完成门禁。

Goal store 不搬移或批量改写既有 `sessions/`、`plans/`、`control/` 与 runtime log。Session 删除时 Core 会先取消并 settle 对应 Goal，再删除 Goal 目录；删除失败会记入 Goal diagnostics 并 fail closed。完整状态机与恢复协议见 [`goal-mode.md`](goal-mode.md)。

## Team checkpoint 恢复协议

项目 Team 的私有状态位于 `stateRoot/projects/<project-id>/team/`。每次 teammate turn 使用独立的 `turn_id`，并把 `checkpoint_version`、phase、thread revision、Inbox cursor 区间、pending message ids 和最后 effect receipt 原子写入 checkpoint。恢复时先核对 durable thread revision 与 Inbox cursor/message ids，不能把 checkpoint 套到另一版 thread 或另一批消息上。

状态转换为：

```text
prepared -> running -> terminal_pending -> cleared
```

- `prepared`：模型尚未开始，可用 checkpoint 中的完整 history 自动续跑，不重新拼接 Inbox。
- `running`：进程终止点可能位于非幂等工具之后；自动恢复 fail closed。只有显式 `recovery: 'retry'` 才允许按 at-least-once 语义重试。
- `terminal_pending`：结果和 final thread revision 已落盘；恢复只执行幂等收尾。自动 result 消息携带 `team_turn_id`，重复恢复会复用已有 receipt，不重复投递。

旧版、损坏或 revision/cursor 不匹配的 checkpoint 不会被当成新任务执行。teammate 进入 Error，checkpoint 保留以便诊断。并发 shutdown 属于终态；迟到 runner 结果可以完成持久化收尾，但不能把成员状态改回 Idle。

## 命名易混淆点：两个 `AGENTS` 系文件

- `<project>/AGENTS.md`：项目源码里的协作文档，用户手写、可提交、可 code review。Core 只读取，从不自动改写。
- `~/.emperor-agent/projects/<project-id>/AGENTS.local.md`：**全局私有 store** 下的项目记忆，由压缩算法维护，用户一般不直接编辑，物理上完全不在项目源码树里。

两者只差一个 `.local` 后缀，语义完全不同。任何 diagnostics/UI 文案提到后者时必须带"全局私有项目记忆"一类限定词，不能只显示裸文件名 `AGENTS.local.md`。

## 技能与模板加载顺序

技能解析优先级（内容冲突时高优先级覆盖低优先级；列表展示时三层取并集）：

1. 项目技能：`<project>/.emperor/skills`（只读，仅 build 会话且绑定了项目时生效）
2. 用户全局技能：`stateRoot/skills`（可读写，Skill API 的默认操作目标）
3. 内置技能：`runtimeRoot/skills`（只读）

`ContextBuilder`（系统提示词装配）与 `LoadSkill` 工具共用同一个 `FileSkillsLoader` 实例，因此提示词里看到的技能摘要与工具实际加载到的内容永远一致。

## 迁移策略

见 `packages/core/src/runtime/migrate-state-root.ts`。每次 `AgentLoop.create()` 启动都会尝试迁移，规则：

1. **只复制，不删除**：旧数据永远保留在原位置。
2. **不覆盖已有文件**：目标路径已存在文件时跳过。
3. **两代旧布局都处理**：
   - 更早的"裸 runtimeRoot"布局（`runtimeRoot/memory`、`runtimeRoot/sessions`、`runtimeRoot/.team`，`.team` 改名为 `team`）。
   - 上一版默认布局（`runtimeRoot/.emperor/*` 整体是旧的 `stateRoot`），整体搬迁到新 `stateRoot`，但排除 `templates/` 子目录。
4. **`USER.local.md` 路径改名单独处理**：旧路径 `runtimeRoot/.emperor/templates/USER.local.md` 复制到新路径 `stateRoot/memory/profile/USER.local.md`（这是一次路径改名，不是原样搬运，所以第 3 步特意排除了 `templates/`）。
5. 每次迁移写入两份审计材料：`stateRoot/migrations/state-root-migration.json` 是稳定 JSON report，`stateRoot/migration-log.jsonl` 是逐文件明细日志；CoreApi diagnostics 暴露 `legacyStateMigration`（检测到的旧目录列表、复制/跳过的文件数、report/log 路径）。

## 与 Claude Code 的对照证据

本设计参考 Claude Code CLI 的分层模型：

- 全局根目录默认 `~/.claude`，可用 `CLAUDE_CONFIG_DIR` 覆盖：`src/utils/envUtils.ts:7`
- session transcript 存在全局 `projects/<sanitized-project-path>/<sessionId>.jsonl`，不是项目源码目录：`src/utils/sessionStorage.ts:198,202,436`
- 输入历史是全局共享文件 `~/.claude/history.jsonl`：`src/history.ts:112`
- settings 分层包含 `userSettings`、`projectSettings`、`localSettings`、`flagSettings`、`policySettings`：`src/utils/settings/constants.ts:7`
- user settings 在全局，project/local settings 在项目 `.claude/`：`src/utils/settings/settings.ts:274,298`
- auto memory 在全局 root 下按项目分区：`src/memdir/paths.ts:79,223`
- agent memory 也区分 user/project/local scope：`src/tools/AgentTool/agentMemory.ts:12`

（路径相对 `claude-code-source-code` checkout；具体行号可能随上游版本漂移，仅作架构对照参考。）

## 诊断字段速查

`CoreApi.diagnostics.get()` 返回的 payload 里，与本文档相关的字段：

- `paths.runtimeRoot` / `paths.stateRoot` / `paths.stateRootSource`：当前生效的两个根及 `stateRoot` 的来源（`explicit` / `env` / `default`）。
- `paths.sessionsRoot` / `paths.tasksRoot` / `paths.processesRoot` / `paths.attachmentsRoot` / `paths.mediaRoot` / `paths.mcpConfigPath`：具体子路径（`attachmentsRoot`/`mediaRoot` 已修正为 `stateRoot/memory/{attachments,media}` 的真实落盘位置）。
- `legacyStateMigration`：本次启动检测到的旧存储位置、已复制/跳过的文件数。
- `projectLegacyPrivateData`：当前绑定项目的源码目录里检测到的私有旧数据（仅提示，不自动处理）。
- `effectiveConfig`：从现有 local/MCP/Skill/AgentDefinition 事实源即时计算的脱敏值、source/trust 与覆盖轨迹；它不是落盘文件，snapshot revision 可重现，secret 值不在 payload 中。

桌面端设置/诊断页的"存储路径"分组（`desktop/src/renderer/src/components/panels/diagnosticsPanelModel.ts`）直接渲染这些字段。
