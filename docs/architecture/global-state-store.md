# 全局私有存储根架构

> 文档状态：Active<br>
> 面向读者：用户、维护者、数据与迁移开发者<br>
> 最后核验：2026-10-22（对照 `7798011a`）<br>
> 事实源：`desktop/src/main/state-directory-lock.ts`、`desktop/src/main/single-instance.ts`、`desktop/src/main/logging/log-location.ts`、`desktop/src/main/quit-coordinator.ts`、`desktop/src/main/user-downloads.ts`、`packages/core/src/workspace/turn-snapshots.ts`、`packages/core/src/workspace/delegation-workspaces.ts`、`packages/core/src/harness/delegation/`、`desktop/src/main/index.ts`、`packages/core/src/runtime/paths.ts`、`packages/core/src/runtime/installation.ts`、`packages/core/src/runtime/data-version.ts`、`packages/core/src/store/persistence/version.ts`、`packages/core/src/storage/data-files.ts`、`packages/core/src/storage/backup.ts`、`packages/core/src/migrations/`、`desktop/src/main/home-backup.ts`、`packages/core/src/runtime/migrate-state-root.ts`、`packages/core/src/harness/host/services.ts`、`packages/core/src/harness/tools/builtin/fs/fsio.ts`、`packages/core/src/session-log/store.ts`、`packages/core/src/skills/file-loader.ts`、`packages/core/src/api/services/skill-service.ts`、`packages/core/src/plugins/service.ts`、各领域 Store、`packages/core/src/updates/service.ts`

## 两个根的区分

| 概念                        | 含义                                                      | 默认值                                                        | 覆盖方式                        |
| --------------------------- | --------------------------------------------------------- | ------------------------------------------------------------- | ------------------------------- |
| `runtimeRoot`               | 应用内置资源根：模板、内置 Skills、静态资源               | 开发模式为仓库根；Release 为只读 `resources/runtime-defaults` | `--root` / `EMPEROR_AGENT_ROOT` |
| Emperor Home（`stateRoot`） | 全局私有数据根：会话、记忆、配置、附件、Skills 与受管环境 | `~/.emperor`                                                  | `EMPEROR_CONFIG_DIR`            |

`runtimeRoot` 里是只读或半只读的应用资源，例如 `templates/`（含 `templates/agent/persona.md`）、`skills/`、`model_config.example.json`、`mcp_config.example.json`；仓库中的两个配置示例源文件位于 `config/examples/`。`stateRoot` 里是持续读写的用户私有状态。两者互不包含。

解析优先级（`resolveRuntimePaths()`）：

- `runtimeRoot`：显式 `root` 参数 > `EMPEROR_AGENT_ROOT` > 开发模式的仓库根 / Release 的 `resources/runtime-defaults`。
- Emperor Home：显式 `stateRoot` 参数 > `EMPEROR_CONFIG_DIR` > `~/.emperor`。

## 目录模型

桌面 App 在迁移、凭据库和 Core 初始化之前，按规范化的 Emperor Home 路径取得进程级独占锁。不同安装位置、开发或预览包，以及不同 Chromium 用户目录不能绕过同一数据目录的锁；符号链接别名归并到实际路径。不同 Emperor Home 可以独立运行。

锁存储位于数据目录同级的 `.<目录名>.emperor-writer.sqlite`，使用 Electron 内置 SQLite 的独占事务持有系统文件锁，不用于存储聊天内容。锁文件不删除，不按 PID、时间或心跳强行接管；连接持有到进程真正退出，包括退出钩子，进程崩溃后由系统释放。首次取得锁不创建 Emperor Home 本身，以保留旧目录迁移语义；可能迁移旧目录时，在任何迁移写入前同时保留新位置和旧位置的独占权，包括尚不存在的旧目录及符号链接目标。取得锁后重新解析路径，覆盖迁移期间身份变化；反复变化时阻止启动。正常退出先等待 Core 关闭和记录刷新。

未取得锁的桌面实例只显示独立恢复页，不初始化迁移、Core 或本地写入服务。关闭占用目录的实例后可以重试；锁存储损坏或不可写时保持阻止启动。不要在 App 运行期间删除锁文件。

恢复页只显示稳定的错误代码；完整原因（调用栈与底层原因）写在 `main.log`（默认 `~/Library/Logs/Emperor Agent/`，设置 `EMPEROR_CONFIG_DIR` 时在该目录的 `logs/` 下），页上显示这个位置并提供「打开日志」和「导出诊断包」（见[日志、崩溃转储与诊断包](ipc-and-runtime-events.md#日志崩溃转储与诊断包)）。

持有者在锁文件旁写 `.<目录名>.emperor-writer.sqlite.owner.json`（0600：pid、版本、启动时间、是否打包、打包版的 `.app` 路径）。被挡住的实例只在该 pid 仍存活时读取它，恢复页写明「另一个 Emperor（版本 X，pid Y）正在使用这个数据目录」；持有者是打包版时提供「切换到它」（`/usr/bin/open` 该 `.app`，随后退出当前实例）。这个记录只用于提示，独占与否始终以 SQLite 锁为准。

默认数据目录上，应用（开发版与打包版都一样）再持有 Electron 单实例锁：第二次启动把主窗口带到前台后退出。`EMPEROR_CONFIG_DIR` 指向其他目录的实例（测试、第二份资料）和打包冒烟不取单实例锁，仍受数据目录锁约束。恢复页「重试」前会关闭上一次启动留下的 Core、驱动与 Chrome 桥接，并移除那次注册的 IPC handler，避免重复创建与重复注册。

退出时先同步写完会话记录（`CoreApi.flushAll()`），再关闭 Core；5 秒内没关完时，同步终止进程运行时登记的全部子进程树和终端（`CoreApi.forceStop()`），然后退出。

Computer Use Helper 的 socket（`<Emperor Home>/run/cu-<uid>.sock`，由 main 每次启动 Helper 前监听，先移走上次留下的、属于当前用户的 socket，其他类型的文件则拒绝；Helper 证明了一次性密钥后即删除；路径过长时退到系统临时目录）、传递该密钥的 FIFO（同目录 `cu-<uid>-<随机>.in`，0600，握手结束即删除）与 `native-helpers/` 副本跟随 Emperor Home。Chrome/Edge 的 Native Messaging socket 固定在 `~/.emperor/run/nm-<uid>.sock`：浏览器拉起的 host 按设计只信任这一个位置，所以使用自定义 `EMPEROR_CONFIG_DIR` 的实例不会接管扩展连接。

```text
~/.emperor/
  installation.json        # layout/app/runtime revision、首次启动与迁移状态；lastRunVersion / previousRunVersion（降级提示）与 dataVersion（数据迁移）
  settings.json            # 用户通用配置（version 1）；updates.check 是「检查更新」开关（默认开）
  model_config.json        # schemaVersion 2；多个模型、单 active；apiKey 以本地密钥加密（el1:…）；单条坏条目只跳过该条（MOD-03）
  model_config.json.pre-seal-<ts>  # 第一次加密前的原文件（含明文 Key，0600，用户可删）
  model_tests.json         # 每条模型最近一次连接测试（「设置 › 模型」卡片的连接状态；运行状态，不是配置，没有版本号）
  mcp_config.json          # 用户自己的文件，不带 Emperor 的版本号；headers / env 中 key、token、secret 等值以本地密钥加密
  mcp_config.json.pre-seal-<ts>    # 第一次加密前的原文件（0600，用户可删）
  hooks.json               # 用户自己的文件：Claude Code hooks.json 格式的 command hooks（可选；按用户写的原文保存）
  onboarding.json
  migration-log.jsonl      # 旧的仓库内布局迁移记录（migrate-state-root.ts，只在发生过这类迁移时存在）
  AGENTS.md                # 可选的全局工作区说明，用户手写
  workspace/               # Chat 会话的工作目录
  spill/                   # 超出内联上限的工具结果全文与命令输出：session-<hash>/ 按会话；直接在 spill/ 下的散文件（旧版本的 shell-*.log、没有会话的调用）不属于会话
  write-staging/           # write / edit 工具的原子写暂存区，写完即改名到目标位置
  skills/<skill-name>/SKILL.md   # 个人 Skills（也接受直接放置的 <name>.md）
  skills/installed.v1.json       # 从旧运行时迁移 Skill 的记录
  skills/.staging/               # 导入时的暂存目录
  plugins/
    known_marketplaces.json
    installed_plugins.json # 已物化版本；用户范围的启用意图在 settings.json，项目的在 projects/<project-id>/plugins.json
    managed.json           # 随 Emperor 提供的插件的开关
    project-intents-migration.json  # 0.2 首次启动把旧项目启用意图搬到 stateRoot 后写下，只搬一次（SEC-07）
    marketplaces/
    cache/                 # 不可变版本内容
    data/                  # 跨版本持久数据
    tmp/<插件名>/          # 插件 Hook 的 TMPDIR
    staging/               # 有界安装预览
  environment/
    bin/                   # 受管执行环境的 PATH 首位
    tools/
    data/                  # 可重定向的第三方数据根
    downloads/
    receipts/
    registry.v1.json
    installations/
    jobs/
    environment.lock
  memory/
    profile/USER.local.md  # 用户档案
    MEMORY.local.md        # 全局长期记忆
    YYYY-MM-DD.md          # 按日情景记忆
    versions/              # 记忆版本快照；修剪到 300 个时被移出的快照文件一起删除
    watchlist.md
    watchlist_state.json
    attachments/<month>/
    media/<month>/
    desktop/window.json
    desktop_pet/window.json
    sidebar_state.json     # 左侧导航（排序、折叠、置顶会话）和文件树宽度等工作台偏好
  sessions/
    .harness-kernel-v1     # 当前内核的会话目录标记
    index.json             # 会话索引（标题、模式、项目绑定、归档）；启动时建一次，之后常驻内存
    index.legacy-backup.json / index.corrupt-<ts>.json  # 旧索引与读不出的索引（保留，不再读取）
    .scratch/
    .trash/<session-id>/   # 「最近删除」的会话（30 天），trash.json 记删除时间
    <session-id>/
      meta.jsonl           # 会话索引元数据，用于重建 index.json；超过 1000 行时压缩为最新一条快照
      log.jsonl            # append-only session log：会话全部事实
  sessions.legacy-<ts>/    # 首次启动新内核时移走的旧会话目录（如存在）
  projects/
    index.json
    <project-id>/
      project.json
      AGENTS.local.md      # 全局私有项目记忆
      prompt-overlay.md
      plugins.json         # 这个项目的插件启用意图（项目与本地项目两个范围，SEC-07）
  git/
    worktree-leases.json   # Emperor 创建的 worktree owner/lease
    worktrees/<session>/<branch>/  # Emperor 为会话创建的托管 worktree
    receipts/              # commit/push/pull/worktree/PR 的脱敏凭据
    turn-index/            # 回合快照用的临时 index（turn-index-<hex>，用完即删）
    runtime-home/          # Emperor 内部 git 的私有 HOME / XDG 目录（不读用户的全局 git 配置）
  processes/
    receipts.v1.json       # 受管进程的最小账本
    unsandboxed-consent.v1.json  # 沙箱不可用时，用户对自己的 MCP server「允许在沙箱外运行」的答复（按 server 与命令指纹）
  tokens/
    tokens.jsonl           # 每次模型调用一行；超过 5000 行时把最旧的行归档，留下 4000 行
    tokens_archive/<YYYY-MM>.jsonl.gz
  scheduler/
    jobs.json
    jobs.rejected.json     # 读不出来的任务条目（原样保留，带原因），其余任务照常加载
    action.jsonl
    scheduler.lock         # 运行定时任务的进程（pid）；另一个活着的进程持有时本进程不启动
  control/
    command-invocations.json   # Slash command 幂等调用记录
    session-transitions.json   # /new 会话转换事务
  computer-use/              # 启动时创建并设为 0700；Agent 的 Shell 与文件、搜索工具都不能读取
    config.json              # 总开关、各驱动开关、下载保留天数（读到已退役的授权模式、急停快捷键、应用名单时写回一次去掉）
    retired-protected-apps.json  # 升级前「不让 Emperor 操作的应用」，设置页提示一次后删除
    grants.json              # 授权记录（会话与定时授权已退役，加载时丢弃）；不含凭据明文；损坏时隔离，从空授权开始
    screenshots.json         # 截图配额清单（附件 ID、会话、大小、时间）
    vault.json               # 凭据库（版本 3）：本地密钥加密，可再加主密码；每个字段以条目的 {handleId, bindings, fillMode, field} 为关联数据；版本 2 可解封时迁移；读到钥匙串时代的版本 1 即删除；读不出或版本更高时原样保留，只读降级
    vault.json.v2-backup-<ms>        # 版本 2 → 3 迁移前的原文件（0600）
    vault.json.unreadable-<ms>       # 「重新开始（先备份）」或导入时移开的损坏文件（0600）；更高版本的为 .newer-<ms>，能读的为 .backup-<ms>
    vault.json.before-import-<ms>    # 导入凭据备份前的凭据库（0600）
    secrets/local.key        # Emperor 本地密钥（32 字节；文件与目录须属于当前用户且 (mode & 0o077) == 0，组和其他人有权限时停用，等用户「修复权限」；link(2) 发布后 fsync 目录），取代 macOS 钥匙串；也加密模型 Key 与 MCP 令牌
    browser-pairings/pairings.json  # 外部浏览器配对（版本 2，本地密钥加密，记录可带 chrome/edge）；版本 1 即删除
    external-site-rules.json # Chrome/Edge 的智能体权限（浏览、下载的默认与按网站例外）和历史记录、站点工具设置（0600）
    external-downloads.json  # 「Emperor 的下载」里来自 Chrome/Edge 的记录（最新 200 条，0600；文件留在浏览器的下载文件夹）
  browser/                   # 启动时设为 0700；受限 Shell 的 Seatbelt 规则与 Agent 的文件、搜索工具都拒绝读取整个目录
    user-downloads.json      # 你自己在内置浏览器里的下载记录（main 写，0600，最多 200 条，不含下载地址）
    profiles.json            # 临时与持久 profile 元数据
    profiles/<profile-id>/   # 持久 profile 的网站数据（Chromium 默认方式保存；已排除出 Time Machine）
      imported-cookies.el1   # 从 Chrome/Edge 导入的 Cookie，本地密钥加密并绑定该 profile（0600）；使用时只放进内存
    site-permissions.json    # 精确 origin、profile 与权限
    restorable.json          # 正常退出时记下的持久 profile 标签页（7 天）
    downloads/               # Agent 下载收件箱，按保留天数清理；完成的文件带 com.apple.quarantine
      .index.json            # 下载 ID → 当前位置与所属会话（重启后仍可显示、移动），以及未能写上来源标记的文件
  browser-extension/         # 随应用分发的 Chrome/Edge 扩展副本（暂存目录 + 两次改名，带版本与摘要的 emperor-bundle.json；不用符号链接；0700，启动时重新计算实际文件摘要，不符即重装）
  delegations/               # Claude Code / Codex 子智能体（见文末「外部委派状态」）
    config.json              # 子智能体设置（schemaVersion 1）
    consent.json             # 「以后都允许」
    credentials.json         # 「使用 API Key」保存的 Claude Code API Key（本地密钥加密，0600）；升级时删除旧版本保存的 Claude 令牌，并在这里记一次提示
    claude-code/             # Claude Code 的专用目录（AGT-12，0700，跨运行持久；Emperor 不读其中的登录）
      config/                # 每次运行、claude auth status、登录与退出登录共用的 CLAUDE_CONFIG_DIR：Claude Code 自己的设置、会话记录（projects/）与登录（钥匙串条目以此目录为键，钥匙串不可用时为 .credentials.json）；settings.json 由 Emperor 写，只含模型设置
      home/                  # 它们共用的 HOME（与 XDG_CONFIG_HOME、XDG_CACHE_HOME）
    runtime-facts.json       # 能力验证事实
    model-catalog-cache.json # Claude Code / Codex 的模型候选缓存
    conversations/<dlg-id>/  # journal.jsonl、snapshot.json、runs/
    workspaces/<lease>/      # 成果所在的隔离 worktree 或文件夹副本（副本另有 <lease>.git）
    runtime/<profile>/<dlg-id>/  # 每个委派私有的临时目录；Codex 另有私有 HOME、CODEX_HOME（旧版本的 Claude 委派在这里还有 HOME、CLAUDE_CONFIG_DIR，会话记录在下一次准备时复制到 claude-code/config）
    leases/、receipts/、baselines/、patches/、artifacts/、acceptance/、integrations/、processes/、inspections/
  run/                       # 本机 Helper 和浏览器 bridge socket
  native-helpers/<cdhash>/   # 签名 Helper 的独立安装版本（macOS）
  logs/                      # 只在设置了 EMPEROR_CONFIG_DIR 时：main.log、core.log、Crashpad/（默认在 ~/Library/Logs/Emperor Agent/）
  migrations/
    state-root-migration.json
    log.jsonl                # 数据迁移与恢复，每次一行（kind、status：applied / rolled_back / rollback_failed、backup、files / categories、error）
    conflicts/emperor.local.<ts>.json  # 旧 emperor.local.json 与 settings.json 并存时移开的旧文件
    backup-<ts>/             # 迁移前复制、恢复前移走的文件（相对路径不变）；不自动删除
    restore-pending/         # 已确认、待下次启动应用的恢复（restore.json 为标记）
    restore-failed-<ts>/     # 应用失败后留下的恢复内容（已回滚）
    .restore-<id>/           # 「从备份恢复」打开后、确认前的解压目录（关闭即删）
```

### 保留与存储占用（KRN-12）

`storage/retention.ts` 的 `RetentionService` 在 Core 启动后于后台运行一次，「设置 › 高级 › 存储」的「清理」也调用它（CoreApi `storage.clean`，受 plan 模式与待决交互的变更守卫）。每一步单独进行，失败只记入结果、不中断其他步骤：

- 「最近删除」里超过 30 天的会话经会话服务永久删除（连同子会话、spill 与 turn 快照）。
- `spill/` 下不属于任何会话的内容：散文件（旧版本的 `shell-*.log`、没有会话的落盘结果；现在命令输出也写进会话自己的目录）与 `session-<hash>/` 目录（其会话既不在 `sessions/`，也不在 `sessions/.trash/`，子会话也算），其中所有文件 30 天没有变化时删除。会话自己的 spill 目录在会话永久删除时删除（KRN-03）。
- `memory/versions/snapshots/` 里索引不再列出的快照，以及原子写留下的临时文件（超过一小时）。
- `delegations/runtime/<profile>/<delegation-id>/`（外部子智能体的临时目录、Codex 的隔离 HOME 与 `CODEX_HOME` 等）：委派空闲或已关闭、且所属会话已不存在时删除；没有任何委派记录的目录 30 天后删除；旧版本每次检查新建的 `dlg-probe-*`（各含一份令牌副本）与 `indexes/`、`snapshot-temp/`、`artifact-temp/` 的临时内容一天后删除。删除从不跟随符号链接（`CODEX_HOME/auth.json` 是指向用户文件的链接，只删链接）。成果 worktree 与用户仓库里的 `refs/emperor/delegations/*` 由委派流程自己清理（AGT-06）。

`storage.usage` 遍历一次 Emperor Home，按会话、附件（`memory/attachments`、`memory/media`）、溢出文件、记忆版本、用量账本、委派与其他汇总磁盘占用（按块计算，硬链接只算一次，不跟随链接，与 `du` 的口径一致）。

旧版本可能留下 `team/`、`tasks/`、`goals/`、`code-intelligence/`、`memory/history.jsonl`、`memory/tool-results/` 等目录或文件。当前内核不读写它们（只有启动时的旧布局迁移 `migrate-state-root.ts` 还会把仓库里更早的 `.team`、`tasks` 复制进来）；旧的 `hooks_config.json` 与 `hooks/` 同样不再使用。这些内容保留原位，不会自动删除，确认不需要后可以手动删除。

Emperor Home 根目录及其主要子目录以 `0700` 创建，其他系统用户无法进入，因此其中的文件只有当前用户能访问。

## Session log

每个 session 的对话、工具调用、权限选择、Plan 模式、Goal、审批与问题记录、压缩和子智能体委派都写在同一份 `sessions/<id>/log.jsonl` 中：

- 首行是 header（`{"type":"session",…}`），其后每行是一个事件或打包的 chunk 行。
- 写入以 200 ms 为批次按序追加，从不原地改写。每批要么完整写入，要么一点不留：写入失败或只写了一部分时，文件被截回这批开始前的长度，重试不会写出重复的 seq。
- 有人在等的事件立即写入并 `fdatasync`：`turn/end`（含崩溃修复写入的 `interrupted`）、`question/asked`、`approval/asked`。其余事件只按批写入，不逐批 sync。
- 退出时主进程先同步调用 `CoreApi.flushAll()`（写完并 sync 所有会话的待写事件），再异步关闭 Core；关闭超过 5 秒仍未完成时照样退出（`quit-coordinator.ts`）。
- 写入失败（例如磁盘已满 `ENOSPC`）时会话进入暂停写入：事件留在内存，每 2 秒重试一次，界面提示一次；写入恢复后再提示一次。
- 打开会话时先修复文件，再做崩溃修复：
  - 最后一行没有换行且不是完整记录（追加到一半断电）：截到最后一个换行，截下的字节另存为 `log.jsonl.tail-<毫秒时间戳>`；
  - 最后一行是完整记录、只缺换行：补上换行，不丢内容；
  - 中间某行损坏：保留它之前能读的部分，原文件改名为 `log.jsonl.corrupt-<毫秒时间戳>`，用保留部分重写 `log.jsonl`；
  - header 损坏或为空：会话无法打开，文件保持原样，界面提示「记录头已损坏」。

  截掉半行和保留前缀两种修复会通过 `session_log_state` 事件提示界面（补换行不提示）。备份文件同名时追加 `-1`、`-2`……，永不覆盖。只读快照（`readSnapshot`，会话列表用）跳过损坏部分但从不写文件。

- 崩溃修复只追加、不改写，也不重放副作用。每一对「开始／结束」标记都有收尾步骤（`harness/host/repair-contributors.ts`），按开始标记的先后补写，turn 收尾最后：
  - 审批、提问 → `unavailable`；Computer Use 动作、授权、标签页 → 取消／结果未知／拒绝／关闭；
  - `compaction/start` → `compaction/end{error:'interrupted'}`（摘要已写入时不带 error），之后可以再次压缩；
  - 工作流 run 与成员 → 成员 `agent-end{outcome:'cancelled'}`，run `run-end{stopReason:'interrupted'}`；
  - 后台 job → `job/finished{status:'killed', detail:'interrupted'}`；子智能体 → 父会话 `subagent/settled{stopReason:'interrupted'}`；
  - 中断的 turn → 合成缺失的工具结果、step 与 turn 收尾。

  这些新增的收尾事件带 `repaired: true`。`repair-matrix.test.ts` 读取源码里全部 `SessionEventMap` 声明，新增的开始标记没有收尾步骤（也不在 `EXEMPT_OPENERS` 里）时测试失败。子智能体被销毁时，日志等它的运行真正结束、写完收尾事件后才关闭。

- 子智能体是独立的子 session，同样位于 `sessions/<child-id>/log.jsonl`，第一条事件记录父 session 与委派信息。

**旧会话归档**：当前内核不读取旧的 `history.jsonl`、`_checkpoint.json`、`message_graph.v2.jsonl` 或 `runtime/events.jsonl`。首次启动时，如果 `sessions/` 没有 `.harness-kernel-v1` 标记且不为空，整个目录会被移到同级的 `sessions.legacy-<时间戳>/`，然后创建新的空目录和标记。旧数据不会删除；Diagnostics 的 `kernel.archivedLegacySessions` 显示本次移动的位置。

不要在应用运行时手工编辑 `log.jsonl`。排障时先完整备份 session 目录。

## 项目源码目录

Build 项目目录里，除了 Git 仓库内部（见下文）之外，只可能有用户自己维护的内容：

```text
<project>/
  AGENTS.md / CLAUDE.md    # 工作区说明，Core 只读
  AGENTS.local.md / CLAUDE.local.md
  .emperor/
    skills/                # 项目 Skills；仅在绑定该项目的 Build 会话中可见、可写
    settings.json          # 只读：其中的 enabledPlugins 只是「建议」，见下
```

Core 不会在项目目录下创建 session、memory、附件或 Goal 数据。

项目是 Git 仓库时，Emperor 在它的 `.git` 里写对象和隐藏引用，不碰你的分支、暂存区和工作区：

- `refs/emperor/turns/<会话>/<turn>/`：每个回合前后的项目快照（两个提交，用于「已编辑 N 个文件」与撤销），每个会话保留最近 50 轮，删除会话时一起删除；应用子智能体成果时另有 `refs/emperor/turns/<会话>/applied/<run>/{before,after}`，供撤销。
- `refs/emperor/delegations/<lease>/base` 与 `…/runs/<run>`：子智能体任务的起点快照与成果；应用或丢弃成果时删除。
- 通过「审查」创建的 worktree 在 Git 里登记（目录在 Emperor Home 的 `git/worktrees/`）。只有在你把 Skill 保存或导入到项目 scope 时，Core 才会写入上面 `.emperor/skills/`。在设置里打开项目 Skills 文件夹只是查看：目录还不存在时会提示，不会为此在项目里建目录。如果旧版本留下了 `.emperor/sessions`、`.emperor/memory` 等目录，Diagnostics 只提示“检测到旧私有数据”，不会自动删除或搬移。

项目与本地项目范围的 Plugin 启用意图不在项目目录里（SEC-07）：项目目录 Agent 能写，克隆来的仓库也自带内容，所以意图记在 `<stateRoot>/projects/<project-id>/plugins.json`（`{ schemaVersion: 1, workspace, enabledPlugins: { project, local } }`，`<project-id>` 按项目的真实路径计算，经符号链接或 `/var` 与 `/private/var` 打开同一个文件夹时共用一份）。仓库 `.emperor/settings.json` 的 `enabledPlugins` 只作为建议：其中列出、已按项目范围安装、而你还没有为这个项目做过选择的插件，在能力页显示「该项目建议启用 X」，你选「启用」或「忽略」后写入 stateRoot，之后仓库文件再怎么改都不影响。`settings.local.json` 不再读取。升级到 0.2 后第一次启动时，Emperor 已经知道的项目（`projects/index.json`）里旧 `.emperor/settings.json`、`settings.local.json` 记下的启用意图（只限已在对应范围安装的插件）搬到 stateRoot、保持原样，并写下 `plugins/project-intents-migration.json`，以后不再搬；这两个旧文件不会被修改或删除。

Agent 按你的要求修改项目文件时，write / edit 工具先在 Emperor Home 的 `write-staging/` 写好内容，再整体改名到目标位置，项目里不会出现半写入的临时文件。如果项目和 Emperor Home 不在同一个文件系统上（例如外接盘），跨盘无法原子改名，这时退回在目标文件旁边暂存 `.<文件名>.<pid>.<uuid>.tmp` 再改名；写入依然原子，原有文件权限保留。

## Emperor Home 之外的位置

除 Emperor Home 和上面列出的项目 `.emperor/skills/` 外，应用只会用到以下位置。模型元数据随应用发布（`packages/core/src/model/metadata/models-dev.snapshot.json`），不在本机另存缓存文件；Claude Code / Codex 的模型候选缓存在 `delegations/model-catalog-cache.json`。

| 位置                                                                       | 内容                                                                                                                                                                                                                                     |
| -------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Electron `userData`（macOS 为 `~/Library/Application Support/<应用名>`）   | Chromium 的缓存、Cookies、Local Storage；界面主题、三栏布局和应用内通知列表等浏览器侧偏好。不含会话、记忆等业务数据。用户操作的工作台浏览器使用不落盘的内存分区；Agent 持久 profile 的网站数据另存于 Emperor Home 的 `browser/profiles/` |
| Chrome / Edge 用户级 `NativeMessagingHosts/com.emperor.agent.browser.json` | 启用外部浏览器连接时登记当前 host 路径，并为每个已配对扩展 ID 写入一条精确的 `allowed_origins`；仅在已使用的浏览器用户配置目录中登记。撤销最后一个配对后移除对应 manifest。                                                              |
| `$HOME/.emperor.bootstrap.lock`                                            | 初始化 Emperor Home 期间的启动锁，完成后删除。必须放在 Emperor Home 外，因为旧版 Home 会在此期间被整体改名                                                                                                                               |
| `~/Library/Logs/Emperor Agent/`                                            | `main.log`、`core.log`（各 5 MB × 5 份轮转）与 `Crashpad/` 崩溃转储；设置 `EMPEROR_CONFIG_DIR` 时改在该目录的 `logs/` 下                                                                                                                 |
| Emperor Home 同级的 `.<目录名>.emperor-writer.sqlite` 与 `.owner.json`     | 数据目录锁（上文「目录模型」）                                                                                                                                                                                                           |
| 项目的 `.git`                                                              | 隐藏引用与对象（上文「项目源码目录」）                                                                                                                                                                                                   |
| 系统临时目录                                                               | Skill 导入时的解压暂存、备份与诊断包的整理目录、截图暂存，完成后删除；下载更新时的 `emperor-update-*`（DMG 在这里核对，无论成败都删除）；Emperor Home 路径过长时的 Computer Use socket（`$TMPDIR/emperor-<uid>/`）                       |
| 你选择的位置                                                               | 「导出备份」的 `.emperor-backup.zip`、导出的诊断包和凭据备份；你自己在内置浏览器里的下载（默认系统下载文件夹）                                                                                                                           |
| 「下载」文件夹                                                             | 用户点「下载」并通过校验的更新 DMG（`Emperor-Agent-<版本>-macos-<arch>.dmg`，同名时加 ` (1)`，带 `com.apple.quarantine`）；Emperor 不再管理它                                                                                            |

启动锁记录持有者的进程号和心跳时间。如果上次启动被强杀或断电导致锁残留，下次启动发现持有进程已退出或心跳过期，会自动接管并记录警告；只有持有者仍在运行且心跳新鲜时，才会报 `installation_lock_busy`。

`runtimeRoot` 只读：开发模式下它就是仓库根，应用不会向其中写入任何内容。

## 命名易混淆点：两个 `AGENTS` 系文件

- `<project>/AGENTS.md`（以及 `AGENTS.local.md`、`CLAUDE.md`、`CLAUDE.local.md`）：项目源码里的工作区说明，Core 只读取，按层级作为工作区说明注入。
- `~/.emperor/projects/<project-id>/AGENTS.local.md`：全局私有 store 下的项目记忆，物理上不在项目源码树里，模型可以通过 `memory_edit` 的 `project` 目标修改。

任何界面文案提到后者时都应带“全局私有项目记忆”一类限定词。

## Skill 加载顺序

1. 项目 Skills：`<project>/.emperor/skills`（仅绑定该项目的 Build 会话，可写）
2. 个人 Skills：`~/.emperor/skills`（可写）
3. 已启用并激活的 Plugin 内的 Skills（只读）
4. 内置 Skills：`runtimeRoot/skills`（只读，目前只有 `skill-creator`；`computer-use` 由 Computer Use 插件提供，从旧运行时迁移 Skill 时不会把它复制成个人 Skill）

同名时高优先级覆盖低优先级。`SkillLoaders` 为每个项目根缓存一个 `FileSkillsLoader`（Chat 会话使用无项目的 loader），同一 session 的 Skill 目录注入、`skill` 工具、`skill_manage` 与 `skills.*` 共用该 session 的 loader。只读来源可以通过 `skills.copyToUser` 或“复制为个人 Skill”得到个人副本。

## 迁移策略

Release 在创建 Core 前由 `bootstrapEmperorHome()` 执行默认根迁移：

1. 设置 `EMPEROR_CONFIG_DIR` 或显式 `stateRoot` 时不探测默认旧根。
2. `~/.emperor` 不存在而 `~/.emperor-agent` 存在时，先写 prepared receipt，再原子 rename，随后规范化配置并写 applied receipt。
3. 两个默认根并存时只使用 `~/.emperor`，不合并、不删除旧根，Diagnostics 报告遗留目录。
4. 旧 `emperor.local.json` 在没有 `settings.json` 时原子改名；两者并存时新文件优先。
5. `installation.json` 的 layout version 高于当前应用时拒绝写入并进入恢复页，防止降级破坏数据。单个文件版本更高时只读降级，见下文「数据版本与只读降级」。

更早的仓库内布局由 `migrate-state-root.ts` 兼容处理：只复制、不删除，不覆盖已有文件；每次迁移写入 `migrations/state-root-migration.json` 与 `migration-log.jsonl`。

`settings.json` 的 `sessions.defaultPermission`（`read-only` / `workspace-write` / `danger-full-access`，默认 `workspace-write`）是新会话起始的权限预设；已经有日志的会话保留自己的预设。不认识的值读作默认值。

`settings.json` 中旧内核的 `permissions.rules`、`workspace.fileCheckpoints`、`workspace.gitRewind`、`memory.hybridMemory` 和 `codeIntelligence` 在读取时被忽略，保存时不再写回。

## 数据版本与只读降级（REL-03）

Emperor 自己的持久文件写明自己的版本（`model_tests.json` 这类运行状态与 `plugins/managed.json` 等小文件不在清单里）。版本键沿用各文件的历史：0.2 之前没有版本的文件写 `version`（由迁移 0-1 或下一次保存补上），已有 `schemaVersion` 的继续用它（旧版本已经在检查这个键），会话索引是数组，每条记录带 `version`。清单在 `storage/data-files.ts`（`DATA_FILES`）：

| 文件                                                                                  | 版本键          | 当前版本 | 写入方 |
| ------------------------------------------------------------------------------------- | --------------- | -------- | ------ |
| `installation.json`                                                                   | `schemaVersion` | 1        | Core   |
| `settings.json`、`scheduler/jobs.json`                                                | `version`       | 1        | Core   |
| `model_config.json`                                                                   | `schemaVersion` | 2        | Core   |
| `sessions/index.json`                                                                 | 每条 `version`  | 1        | Core   |
| `plugins/installed_plugins.json`、`plugins/known_marketplaces.json`                   | `schemaVersion` | 1        | Core   |
| `delegations/config.json`、`delegations/consent.json`、`delegations/credentials.json` | `schemaVersion` | 1        | Core   |
| `browser/profiles.json`、`browser/site-permissions.json`、`browser/restorable.json`   | `schemaVersion` | 1        | Core   |
| `computer-use/vault.json`                                                             | `version`       | 3        | main   |
| `browser/user-downloads.json`、`browser/downloads/.index.json`                        | `version`       | 1        | main   |

用户自己的 `mcp_config.json` 与 `hooks.json`（`USER_OWNED_FILES`）不在清单里：Emperor 只在用户保存时按用户写的内容写它们，不写入版本号，也不读取其中的 `version`（那是用户自己的键，不会让文件变成只读），任何迁移都不碰它们（插件契约 PL-10：插件的 MCP server 与 Hook 不写入这两个文件；FIX-08）。

持久化内核（`store/persistence`）的 snapshot codec 声明 `versionKey`。读到的版本高于本构建写入的版本时：

- 按本构建的版本尽量解码（解不出来时用默认值），回执是 `newer_version_read_only`；**不隔离**（不改名为 `*.corrupt-*`），也不重写；
- 之后对这个文件的任何写入都抛 `DataFileNewerError`（code `data_file_newer`，消息「这个文件来自更新版本的 Emperor，当前版本只读：<文件名>」，经 IPC 原样到达界面）。写前检查按文件的 size + mtime 缓存，同一文件重复写入时只 `stat` 一次；
- 不走 snapshot 的写入方（插件服务写 `settings.json`、子智能体授权、main 的两个下载记录）各自先检查版本；会话索引更新版时只在内存中维护（目录本来就从各会话的 `meta.jsonl` 重建）；定时任务文件更新版时定时任务服务启动失败并写明原因，不会运行任务；委派授权更新版时不记住「以后都允许」；`delegations/config.json` 版本未知时本来就拒绝读写。

`installation.json` 记录 `lastRunVersion`（本次运行的版本）与 `previousRunVersion`（上一次）；只有正式版本号（`x.y.z[-pre]`，不含 `0.0.0-*`、`development`）才记录。本次版本低于上一次时为降级：CoreApi `storage.versions` 返回 `downgradedFrom`，界面启动时显示提示。`installation.json` 的 `schemaVersion` 更高时不重写它。`storage.versions` 同时返回数据版本、清单中每个存在的文件的状态（`ok` / `newer` / `unversioned` / `unreadable`）和最近一次恢复。

## 数据迁移（REL-03）

`installation.json` 的 `dataVersion` 是 Emperor Home 的数据版本（新建目录直接是当前版本；旧目录没有这个字段即为 0）。迁移步骤是 `packages/core/src/migrations/<from>-<to>.ts`，`DATA_MIGRATIONS` 按顺序排成一条链；只有数据版本落后时才加载迁移代码（`runPendingDataMigrations`，main 在 bootstrap 之后、Core 创建之前调用，headless Core 在自己的 bootstrap 之后调用）。每一步：

1. 把这一步列出的文件复制到 `migrations/backup-<ts>/`（相对路径与权限不变）；
2. 运行，成功后 `dataVersion` 前进，`migrations/log.jsonl` 写一行 `status: "applied"`；
3. 失败时把复制的文件放回、删除这一步新建的文件，日志写 `rolled_back`（放回也失败时写 `rollback_failed`），数据版本不变，下次启动再试。

步骤必须可以重复执行：旧版本运行后会去掉 `dataVersion`，再次升级时步骤会再跑一遍。迁移 `0-1` 给旧版本留下的 `settings.json` 补上 `"version": 1`；用户的 `mcp_config.json`、`hooks.json` 不列入任何步骤，迁移前后逐字节不变。版本更高的数据版本不做任何迁移。

## 备份与恢复（REL-03）

「设置 › 高级 › 存储 › 备份与恢复」由 main（`desktop/src/main/home-backup.ts`，按需加载）与 Core（`storage/backup.ts`，经 `loadHomeBackupModule()` 按需加载，不进入主 bundle）完成。IPC 见 [IPC 与运行时事件](ipc-and-runtime-events.md#备份与恢复)。

备份按部分组织：设置与配置（`settings.json`、`model_config.json`、`mcp_config.json`、`hooks.json`、`onboarding.json`、`delegations/config.json`、`delegations/consent.json`）、记忆（`memory/`，附件与媒体除外）、Skills / 插件 / 智能体（`skills/` 除 `.staging`、`agents/`（当前版本不再写入，存在时一并备份）、`plugins/` 除 `staging`）、项目与定时任务（`projects/`、`scheduler/` 除锁），可选的会话（`sessions/` 除 `.scratch`、`memory/attachments`、`memory/media`、`tokens/`）。任何深度的锁文件、临时文件、`*.corrupt-*`、符号链接和特殊文件都不复制。备份从不包含 `installation.json`、`computer-use/`（凭据库与本地密钥）、`browser/`、`environment/`、`logs/`、`run/`、`spill/`、`write-staging/`、`git/`、委派的运行目录和 `migrations/`。

导出：有备份口令时先由凭据库导出 SEC-09 的口令封装文件（条目与本地密钥，AES-256-GCM，scrypt 派生），作为 `credentials.emperor-vault`，同时带上 `delegations/credentials.json`（用本地密钥封装的 Claude Code API Key；`delegations/claude-code/` 里 Claude Code 自己的登录与会话从不进备份）；没有口令时这三者都不在备份里。Core 把备份范围复制到 main 的私有临时目录（0700，文件 0600），复制件里的明文模型 Key 与 MCP 密钥用本地密钥封装（无法封装时去掉），写 `emperor-backup.json`（format `emperor-backup`、version 1、createdAt、appVersion、dataVersion、categories、credentials、files、bytes），main 用 `ditto -c -k --keepParent` 打包为 `.emperor-backup.zip`（先写 `<文件>.partial-<随机>`，0600，再改名），然后删除临时目录。

恢复：main 用 `ditto -x -k` 解压到 `<home>/migrations/.restore-<id>/`，Core 校验 manifest（格式更新的备份拒绝）和每一个路径（只允许 manifest 声明的部分里的普通文件与目录，符号链接与范围外路径一律拒绝）。用户确认后，有口令时 main 先导入凭据库（全部字段打开后才改动本地状态；口令错误时什么都不变）；然后 Core 把解压目录改名为 `migrations/restore-pending/`（同一磁盘，原子），去掉 `credentials.emperor-vault`，没有导入凭据库时也去掉 `delegations/credentials.json`，最后写标记 `restore.json`；main 重新启动。下次启动在取得数据目录锁之后、bootstrap 之前（`applyPendingHomeRestore`）：

1. 当前数据中备份所含部分的条目（文件，或带排除项目录的子项）改名到 `migrations/backup-<ts>/`；
2. 备份里的条目改名到原位，`dataVersion` 设为备份的数据版本（随后的数据迁移会补齐）；
3. 删除 `restore-pending/`，`log.jsonl` 写 `kind: "restore"` `status: "applied"`；任何一步失败时按相反顺序移回，`restore-pending/` 改名为 `restore-failed-<ts>/`，日志写 `rolled_back`。

`storage.versions` 的 `lastRestore` 让界面在恢复后的第一次启动提示一次。

## 诊断字段速查

`diagnostics.get()` 中与存储相关的字段：

- `paths.*`：当前 runtimeRoot、Emperor Home 及其来源（`explicit` / `env` / `default`）和各子路径。
- `legacyStateMigration`：本次启动检测到的旧存储位置、已复制/跳过的文件数。
- `projectLegacyPrivateData`：当前绑定项目的源码目录里检测到的旧私有数据（仅提示）。
- `kernel.archivedLegacySessions`：首次启动新内核时旧会话目录被移到的位置。
- `effectiveConfig`：从现有事实源即时计算的脱敏值与来源，不是落盘文件。

## 外部委派状态

Emperor Home 的 `delegations/` 保存 conversations journal、每轮 transcript、工作区 lease、process ownership、私有 native state、成果工作区、内容寻址 artifacts、验证和 integration preview。它们属于私有运行数据；关闭会话或停用 profile 不删除成果，应用、丢弃或会话彻底删除时清理（「设置 › 高级 › 存储」的「清理」与每次启动的保留检查也会删掉已无主的运行目录）。恢复先只读核验，不重放未知发送或崩溃中的 apply。[恢复语义](external-agent-delegation.md#崩溃恢复与通知)。
