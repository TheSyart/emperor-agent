# 全局私有存储根架构

> 文档状态：Active<br>
> 面向读者：用户、维护者、数据与迁移开发者<br>
> 最后核验：2026-10-19<br>
> 事实源：`desktop/src/main/state-directory-lock.ts`、`desktop/src/main/quit-coordinator.ts`、`desktop/src/main/index.ts`、`packages/core/src/runtime/paths.ts`、`packages/core/src/runtime/installation.ts`、`packages/core/src/runtime/migrate-state-root.ts`、`packages/core/src/harness/host/services.ts`、`packages/core/src/harness/tools/builtin/fs/fsio.ts`、`packages/core/src/session-log/store.ts`、`packages/core/src/skills/file-loader.ts`、`packages/core/src/api/services/skill-service.ts`、`packages/core/src/plugins/service.ts`、各领域 Store

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

持有者在锁文件旁写 `.<目录名>.emperor-writer.sqlite.owner.json`（0600：pid、版本、启动时间、是否打包、打包版的 `.app` 路径）。被挡住的实例只在该 pid 仍存活时读取它，恢复页写明「另一个 Emperor（版本 X，pid Y）正在使用这个数据目录」；持有者是打包版时提供「切换到它」（`/usr/bin/open` 该 `.app`，随后退出当前实例）。这个记录只用于提示，独占与否始终以 SQLite 锁为准。

默认数据目录上，打包版再持有 Electron 单实例锁：第二次启动把主窗口带到前台后退出。`EMPEROR_CONFIG_DIR` 指向其他目录的实例（测试、第二份资料）和打包冒烟不取单实例锁，仍受数据目录锁约束。恢复页「重试」前会关闭上一次启动留下的 Core、驱动与 Chrome 桥接，并移除那次注册的 IPC handler，避免重复创建与重复注册。

退出时先同步写完会话记录（`CoreApi.flushAll()`），再关闭 Core；5 秒内没关完时，同步终止进程运行时登记的全部子进程树和终端（`CoreApi.forceStop()`），然后退出。

Computer Use Helper 的 socket（`<Emperor Home>/run/cu-<uid>.sock`，路径过长时退到系统临时目录）与 `native-helpers/` 副本跟随 Emperor Home。Chrome/Edge 的 Native Messaging socket 固定在 `~/.emperor/run/nm-<uid>.sock`：浏览器拉起的 host 按设计只信任这一个位置，所以使用自定义 `EMPEROR_CONFIG_DIR` 的实例不会接管扩展连接。

```text
~/.emperor/
  installation.json        # layout/app/runtime revision 与首次启动、迁移状态
  settings.json            # 用户通用配置
  model_config.json        # schemaVersion 2；多个模型、单 active；apiKey 以本地密钥加密（el1:…）
  model_config.json.pre-seal-<ts>  # 第一次加密前的原文件（含明文 Key，0600，用户可删）
  mcp_config.json          # headers / env 中 key、token、secret 等值以本地密钥加密
  hooks.json               # Claude Code hooks.json 格式的 command hooks（可选）
  onboarding.json
  AGENTS.md                # 可选的全局工作区说明，用户手写
  workspace/               # Chat 会话的工作目录
  spill/                   # 超出内联上限的工具结果全文
  write-staging/           # write / edit 工具的原子写暂存区，写完即改名到目标位置
  skills/<skill-name>/SKILL.md   # 个人 Skills（也接受直接放置的 <name>.md）
  plugins/
    known_marketplaces.json
    installed_plugins.json # 已物化版本；启用意图在 settings.json
    marketplaces/
    cache/                 # 不可变版本内容
    data/                  # 跨版本持久数据
    staging/               # 有界安装预览
  environment/
    bin/                   # 受管执行环境的 PATH 首位
    tools/
    data/                  # 可重定向的第三方数据根
    downloads/
    receipts/
    registry.v1.json
  memory/
    profile/USER.local.md  # 用户档案
    MEMORY.local.md        # 全局长期记忆
    YYYY-MM-DD.md          # 按日情景记忆
    versions/              # 记忆版本快照
    watchlist.md
    watchlist_state.json
    attachments/<month>/
    media/<month>/
    desktop/window.json
    desktop_pet/window.json
    sidebar_state.json     # 左侧导航（排序、折叠、置顶会话）和文件树宽度等工作台偏好
  sessions/
    .harness-kernel-v1     # 当前内核的会话目录标记
    index.json             # 会话索引（标题、模式、项目绑定、归档）
    .scratch/
    <session-id>/
      meta.jsonl           # 会话索引元数据，用于重建 index.json
      log.jsonl            # append-only session log：会话全部事实
  sessions.legacy-<ts>/    # 首次启动新内核时移走的旧会话目录（如存在）
  projects/
    index.json
    <project-id>/
      project.json
      AGENTS.local.md      # 全局私有项目记忆
      prompt-overlay.md
  git/
    worktree-leases.json   # Emperor 创建的 worktree owner/lease
    receipts/              # commit/push/pull/worktree/PR 的脱敏凭据
  processes/
    receipts.v1.json       # 受管进程的最小账本
  tokens/
    tokens.jsonl
  scheduler/
    jobs.json
    action.jsonl
  control/
    command-invocations.json   # Slash command 幂等调用记录
    session-transitions.json   # /new 会话转换事务
  computer-use/              # 启动时创建并设为 0700；Agent 的 Shell 与文件、搜索工具都不能读取
    config.json              # 总开关、各驱动开关、下载保留天数（读到已退役的授权模式、急停快捷键、应用名单时写回一次去掉）
    retired-protected-apps.json  # 升级前「不让 Emperor 操作的应用」，设置页提示一次后删除
    grants.json              # 授权记录（会话与定时授权已退役，加载时丢弃）；不含凭据明文；损坏时隔离，从空授权开始
    screenshots.json         # 截图配额清单（附件 ID、会话、大小、时间）
    vault.json               # 凭据库（版本 2）：本地密钥加密，可再加主密码；读到钥匙串时代的版本 1 即删除
    secrets/local.key        # Emperor 本地密钥（32 字节，目录 0700、文件 0600），取代 macOS 钥匙串；也加密模型 Key 与 MCP 令牌
    browser-pairings/pairings.json  # 外部浏览器配对（版本 2，本地密钥加密，记录可带 chrome/edge）；版本 1 即删除
    external-site-rules.json # Chrome/Edge 的智能体权限（浏览、下载的默认与按网站例外）和历史记录、站点工具设置（0600）
    external-downloads.json  # 「Emperor 的下载」里来自 Chrome/Edge 的记录（最新 200 条，0600；文件留在浏览器的下载文件夹）
  browser/                   # 启动时设为 0700；受限 Shell 的 Seatbelt 规则与 Agent 的文件、搜索工具都拒绝读取整个目录
    profiles.json            # 临时与持久 profile 元数据
    profiles/<profile-id>/   # 持久 profile 的网站数据
    site-permissions.json    # 精确 origin、profile 与权限
    restorable.json          # 正常退出时记下的持久 profile 标签页（7 天）
    downloads/               # Agent 下载收件箱，按保留天数清理
      .index.json            # 下载 ID → 当前位置与所属会话（重启后仍可显示、移动）
  browser-extension/         # 随应用分发的 Chrome/Edge 扩展副本（暂存目录 + 两次改名，带版本与摘要的 emperor-bundle.json；不用符号链接）
  run/                       # 本机 Helper 和浏览器 bridge socket
  native-helpers/<cdhash>/   # 签名 Helper 的独立安装版本（macOS）
  migrations/
    state-root-migration.json
```

旧版本可能留下 `team/`、`tasks/`、`goals/`、`code-intelligence/`、`memory/history.jsonl`、`memory/tool-results/` 等目录或文件。当前内核启动时不创建、也不读写它们；旧的 `hooks_config.json` 与 `hooks/` 同样不再使用。这些内容保留原位，不会自动删除，确认不需要后可以手动删除。

Emperor Home 根目录及其主要子目录以 `0700` 创建，其他系统用户无法进入，因此其中的文件只有当前用户能访问。

## Session log

每个 session 的对话、工具调用、权限选择、Plan 模式、Goal、审批与问题记录、压缩和子代理委派都写在同一份 `sessions/<id>/log.jsonl` 中：

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
  - 后台 job → `job/finished{status:'killed', detail:'interrupted'}`；子代理 → 父会话 `subagent/settled{stopReason:'interrupted'}`；
  - 中断的 turn → 合成缺失的工具结果、step 与 turn 收尾。

  这些新增的收尾事件带 `repaired: true`。`repair-matrix.test.ts` 读取源码里全部 `SessionEventMap` 声明，新增的开始标记没有收尾步骤（也不在 `EXEMPT_OPENERS` 里）时测试失败。子代理被销毁时，日志等它的运行真正结束、写完收尾事件后才关闭。

- 子代理是独立的子 session，同样位于 `sessions/<child-id>/log.jsonl`，第一条事件记录父 session 与委派信息。

**旧会话归档**：当前内核不读取旧的 `history.jsonl`、`_checkpoint.json`、`message_graph.v2.jsonl` 或 `runtime/events.jsonl`。首次启动时，如果 `sessions/` 没有 `.harness-kernel-v1` 标记且不为空，整个目录会被移到同级的 `sessions.legacy-<时间戳>/`，然后创建新的空目录和标记。旧数据不会删除；Diagnostics 的 `kernel.archivedLegacySessions` 显示本次移动的位置。

不要在应用运行时手工编辑 `log.jsonl`。排障时先完整备份 session 目录。

## 项目源码目录

Build 项目目录只可能包含用户自己维护的内容：

```text
<project>/
  AGENTS.md / CLAUDE.md    # 工作区说明，Core 只读
  AGENTS.local.md / CLAUDE.local.md
  .emperor/
    skills/                # 项目 Skills；仅在绑定该项目的 Build 会话中可见、可写
    settings.json          # 项目 scope 的 Plugin 启用意图（选择该 scope 时写入）
    settings.local.json    # 本地项目 scope 的 Plugin 启用意图，不随仓库提交
```

Core 不会在项目目录下创建 session、memory、附件或 Goal 数据。只有在你把 Skill 保存或导入到项目 scope，或以项目 / 本地项目 scope 管理 Plugin 时，Core 才会写入上面 `.emperor/` 下的对应位置。在设置里打开项目 Skills 文件夹只是查看：目录还不存在时会提示，不会为此在项目里建目录。如果旧版本留下了 `.emperor/sessions`、`.emperor/memory` 等目录，Diagnostics 只提示“检测到旧私有数据”，不会自动删除或搬移。

Agent 按你的要求修改项目文件时，write / edit 工具先在 Emperor Home 的 `write-staging/` 写好内容，再整体改名到目标位置，项目里不会出现半写入的临时文件。如果项目和 Emperor Home 不在同一个文件系统上（例如外接盘），跨盘无法原子改名，这时退回在目标文件旁边暂存 `.<文件名>.<pid>.<uuid>.tmp` 再改名；写入依然原子，原有文件权限保留。

## Emperor Home 之外的位置

除 Emperor Home 和上面列出的项目 `.emperor/` 外，应用只会用到以下位置：

| 位置                                                                       | 内容                                                                                                                                                                                                                                     |
| -------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Electron `userData`（macOS 为 `~/Library/Application Support/<应用名>`）   | Chromium 的缓存、Cookies、Local Storage；界面主题、三栏布局和应用内通知列表等浏览器侧偏好。不含会话、记忆等业务数据。用户操作的工作台浏览器使用不落盘的内存分区；Agent 持久 profile 的网站数据另存于 Emperor Home 的 `browser/profiles/` |
| Chrome / Edge 用户级 `NativeMessagingHosts/com.emperor.agent.browser.json` | 启用外部浏览器连接时登记当前 host 路径，并为每个已配对扩展 ID 写入一条精确的 `allowed_origins`；仅在已使用的浏览器用户配置目录中登记。撤销最后一个配对后移除对应 manifest。                                                              |
| `$HOME/.emperor.bootstrap.lock`                                            | 初始化 Emperor Home 期间的启动锁，完成后删除。必须放在 Emperor Home 外，因为旧版 Home 会在此期间被整体改名                                                                                                                               |
| 系统临时目录                                                               | Skill 导入时的解压暂存，完成后删除                                                                                                                                                                                                       |

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
5. `installation.json` 的 layout version 高于当前应用时拒绝写入并进入恢复页，防止降级破坏数据。

更早的仓库内布局由 `migrate-state-root.ts` 兼容处理：只复制、不删除，不覆盖已有文件；每次迁移写入 `migrations/state-root-migration.json` 与 `migration-log.jsonl`。

`settings.json` 中旧内核的 `permissions.rules`、`workspace.fileCheckpoints`、`workspace.gitRewind`、`memory.hybridMemory` 和 `codeIntelligence` 在读取时被忽略，保存时不再写回。

## 诊断字段速查

`diagnostics.get()` 中与存储相关的字段：

- `paths.*`：当前 runtimeRoot、Emperor Home 及其来源（`explicit` / `env` / `default`）和各子路径。
- `legacyStateMigration`：本次启动检测到的旧存储位置、已复制/跳过的文件数。
- `projectLegacyPrivateData`：当前绑定项目的源码目录里检测到的旧私有数据（仅提示）。
- `kernel.archivedLegacySessions`：首次启动新内核时旧会话目录被移到的位置。
- `effectiveConfig`：从现有事实源即时计算的脱敏值与来源，不是落盘文件。

## 外部委派状态

Emperor Home 的 delegations/ 保存 conversations journal、每轮 transcript、工作区 lease、process ownership、私有 native state、内容寻址 artifacts、验收和 integration preview。它们属于私有运行数据；关闭会话或停用 profile 不删除成果。恢复先只读核验，不重放未知发送或崩溃中的 apply。[恢复语义](external-agent-delegation.md#崩溃恢复与通知)。
