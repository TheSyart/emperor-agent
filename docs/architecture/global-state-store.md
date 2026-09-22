# 全局私有存储根架构

> 文档状态：Active<br>
> 面向读者：用户、维护者、数据与迁移开发者<br>
> 最后核验：2026-09-22<br>
> 事实源：`packages/core/src/runtime/paths.ts`、`packages/core/src/runtime/installation.ts`、`packages/core/src/runtime/migrate-state-root.ts`、`packages/core/src/harness/host/services.ts`、`packages/core/src/session-log/store.ts`、`packages/core/src/skills/file-loader.ts`、`packages/core/src/plugins/service.ts`、各领域 Store

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
    sidebar_state.json     # 左侧导航和右侧工作台布局
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
  migrations/
    state-root-migration.json
```

启动时仍会创建 `team/`、`tasks/`、`goals/`、`code-intelligence/` 等目录以兼容旧布局迁移，但当前内核不读写其中内容；旧的 `hooks_config.json` 与 `hooks/` 也不再使用。这些内容保留原位，不会自动删除。

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

Core 不会在项目目录下创建 session、memory、附件或 Goal 数据。只有在你把 Skill 保存或导入到项目 scope、打开项目 Skills 文件夹，或以项目 / 本地项目 scope 管理 Plugin 时，Core 才会写入上面 `.emperor/` 下的对应位置。如果旧版本留下了 `.emperor/sessions`、`.emperor/memory` 等目录，Diagnostics 只提示“检测到旧私有数据”，不会自动删除或搬移。

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
