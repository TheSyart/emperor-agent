# 全局私有存储根架构

> 文档状态：Active<br>
> 面向读者：用户、维护者、数据与迁移开发者<br>
> 最后核验：2026-09-24<br>
> 事实源：`packages/core/src/runtime/paths.ts`、`packages/core/src/runtime/installation.ts`、`packages/core/src/runtime/migrate-state-root.ts`、`packages/core/src/harness/host/services.ts`、`packages/core/src/harness/tools/builtin/fs/fsio.ts`、`packages/core/src/session-log/store.ts`、`packages/core/src/skills/file-loader.ts`、`packages/core/src/api/services/skill-service.ts`、`packages/core/src/plugins/service.ts`、各领域 Store

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

```text
~/.emperor/
  installation.json        # layout/app/runtime revision 与首次启动、迁移状态
  settings.json            # 用户通用配置
  model_config.json        # schemaVersion 2；多个模型、单 active
  mcp_config.json
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
  computer-use/              # 启用电脑操作后按需创建
    config.json              # 总开关、授权模式、各驱动开关、急停快捷键、用户应用名单、下载保留天数
    grants.json              # 会话与定时授权、急停挂起状态；不含凭据明文；损坏时隔离并挂起
    screenshots.json         # 截图配额清单（附件 ID、会话、大小、时间）
    vault.json               # Electron main 加密的凭据库
    browser-pairings/pairings.json  # 加密的外部浏览器配对信息
  browser/                   # 受限 Shell 的 Seatbelt 规则拒绝读取整个目录
    profiles.json            # 临时与持久 profile 元数据
    profiles/<profile-id>/   # 持久 profile 的网站数据
    site-permissions.json    # 精确 origin、profile 与权限
    restorable.json          # 正常退出时记下的持久 profile 标签页（7 天）
    downloads/               # Agent 下载收件箱，按保留天数清理
      .index.json            # 下载 ID → 当前位置与所属会话（重启后仍可显示、移动）
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
- 写入以 200 ms 为批次按序追加，从不原地改写。
- 加载时容忍一条截断的尾行，并对中断的 turn 做崩溃修复（合成缺失的工具结果和 turn 收尾，把未决的审批与问题关闭为 `unavailable`）。修复不会重放副作用。
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
4. 内置 Skills：`runtimeRoot/skills`（只读）

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
