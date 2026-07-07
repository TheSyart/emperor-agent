# 全局私有存储根架构

对应实施计划：`docs/superpowers/plans/2026-07-06-global-state-store-claude-code-alignment.md`。

## 两个根的区分

Emperor Agent 区分两个互不重叠的根目录概念：

| 概念 | 含义 | 默认值 | 环境变量 |
|---|---|---|---|
| `runtimeRoot` | 应用内置资源根：模板、内置技能、静态资源 | 开发模式为仓库根；打包模式为 Electron `userData/runtime` | `--root` / `EMPEROR_AGENT_ROOT` |
| `stateRoot` | 全局私有数据根：会话、记忆、配置、附件等一切运行期私有状态 | `~/.emperor-agent`（开发与打包模式一致） | `EMPEROR_CONFIG_DIR` |

`runtimeRoot` 里的内容是只读或半只读的"应用资源"，例如 `templates/`、`skills/`、`model_config.example.json`、`mcp_config.example.json`；`stateRoot` 里的内容是持续被读写的"用户私有状态"。两者刻意分离，且默认值**不再有包含关系**（旧模型里 `stateRoot` 是 `runtimeRoot/.emperor`，新模型里两者是完全独立的目录树）。

解析优先级（`packages/core/src/runtime/paths.ts` 的 `resolveRuntimePaths()`）：

- `runtimeRoot`：显式 `--root`/`root` 参数 > `EMPEROR_AGENT_ROOT` > 开发模式的仓库根 / 打包模式的 `userData/runtime`。
- `stateRoot`：显式 `stateRoot` 参数 > `EMPEROR_CONFIG_DIR` > `~/.emperor-agent`（`defaultStateRoot()`)。

## 目标目录模型

```text
~/.emperor-agent/
  emperor.local.json
  model_config.json
  mcp_config.json
  templates/            # 内置只读种子模板副本，不承载任何持续改写的活文件
  skills/                # 用户全局技能（Skill API 的写入目标）
  memory/
    profile/
      USER.local.md      # 用户偏好档案；由 ensureUserProfileFile() 播种/维护
    MEMORY.local.md      # 全局长期记忆；保留旧 MemoryStore 相对路径以便兼容迁移
    attachments/<month>/
    media/<month>/
    desktop/window.json
    desktop_pet/window.json
  sessions/
    index.json
    <session-id>/
      history.jsonl
      runtime/events.jsonl
      _checkpoint.json
      prompt-snapshots/
  projects/
    index.json
    <project-id>/
      project.json
      AGENTS.local.md     # 全局私有项目记忆（见下方"命名易混淆点"）
      prompt-overlay.md
  tasks/
  scheduler/
  team/
  external/
  control/
  migrations/
    state-root-migration.json
```

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

Core **不会**在项目源码目录下自动创建 `.emperor/sessions`、`.emperor/memory`、`.emperor/runtime`、`.emperor/attachments`、`.emperor/media`。如果这些目录已经因为旧版本或其他工具而存在，diagnostics 只会提示"检测到旧私有数据"，不会自动删除或搬移。

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
- `paths.sessionsRoot` / `paths.attachmentsRoot` / `paths.mediaRoot` / `paths.mcpConfigPath`：具体子路径（`attachmentsRoot`/`mediaRoot` 已修正为 `stateRoot/memory/{attachments,media}` 的真实落盘位置）。
- `legacyStateMigration`：本次启动检测到的旧存储位置、已复制/跳过的文件数。
- `projectLegacyPrivateData`：当前绑定项目的源码目录里检测到的私有旧数据（仅提示，不自动处理）。

桌面端设置/诊断页的"存储路径"分组（`desktop/src/renderer/src/components/panels/diagnosticsPanelModel.ts`）直接渲染这些字段。
