# Emperor 全局私有存储根对齐 Claude Code Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use `superpowers:subagent-driven-development` or `superpowers:executing-plans` to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 将 Emperor 的 session、memory、runtime events、用户配置、模型配置、MCP 配置等私有运行数据迁移到全局私有目录，避免写入用户选择的项目源码目录，并保留项目内轻量协作文件。

**Architecture:** 采用 Claude Code 的分层模型：全局私有 store 保存用户态和会话态；项目源码目录只保存可协作、可提交或显式本地的项目文件。`runtimeRoot` 继续代表应用内置资源根，新增/明确 `stateRoot` 代表全局私有数据根。

**Tech Stack:** TypeScript, Electron main, Vue renderer, `@emperor/core`, Node filesystem APIs.

---

## 关键证据

### Claude Code 源码证据

- 全局根目录默认 `~/.claude`，可用 `CLAUDE_CONFIG_DIR` 覆盖：`/Users/anhuike/Documents/workspace/claude-code-source-code/src/utils/envUtils.ts:7`
- session transcript 存在全局 `projects/<sanitized-project-path>/<sessionId>.jsonl`，不是项目源码目录：`/Users/anhuike/Documents/workspace/claude-code-source-code/src/utils/sessionStorage.ts:198`、`/Users/anhuike/Documents/workspace/claude-code-source-code/src/utils/sessionStorage.ts:202`、`/Users/anhuike/Documents/workspace/claude-code-source-code/src/utils/sessionStorage.ts:436`
- 输入历史是全局共享文件 `~/.claude/history.jsonl`：`/Users/anhuike/Documents/workspace/claude-code-source-code/src/history.ts:112`
- settings 分层包含 `userSettings`、`projectSettings`、`localSettings`、`flagSettings`、`policySettings`：`/Users/anhuike/Documents/workspace/claude-code-source-code/src/utils/settings/constants.ts:7`
- user settings 在全局，project/local settings 在项目 `.claude/`：`/Users/anhuike/Documents/workspace/claude-code-source-code/src/utils/settings/settings.ts:274`、`/Users/anhuike/Documents/workspace/claude-code-source-code/src/utils/settings/settings.ts:298`
- 用户全局指令与项目指令分层：`/Users/anhuike/Documents/workspace/claude-code-source-code/src/utils/claudemd.ts:1`
- auto memory 在全局 root 下按项目分区：`/Users/anhuike/Documents/workspace/claude-code-source-code/src/memdir/paths.ts:79`、`/Users/anhuike/Documents/workspace/claude-code-source-code/src/memdir/paths.ts:223`
- agent memory 也区分 user/project/local scope：`/Users/anhuike/Documents/workspace/claude-code-source-code/src/tools/AgentTool/agentMemory.ts:12`

### Emperor 当前关键路径

- Emperor 项目根：`/Users/anhuike/Documents/workspace/emperor-agent`
- 当前 runtime path 定义：`/Users/anhuike/Documents/workspace/emperor-agent/packages/core/src/runtime/paths.ts`
- Core 初始化：`/Users/anhuike/Documents/workspace/emperor-agent/packages/core/src/agent/loop.ts`
- CoreApi 服务装配：`/Users/anhuike/Documents/workspace/emperor-agent/packages/core/src/api/core-api.ts`
- Electron packaged runtime root：`/Users/anhuike/Documents/workspace/emperor-agent/desktop/src/main/runtime-root.ts`
- Electron config/root 解析：`/Users/anhuike/Documents/workspace/emperor-agent/desktop/src/main/config.ts`
- Electron main 启动与协议注册：`/Users/anhuike/Documents/workspace/emperor-agent/desktop/src/main/index.ts`
- `app://attachments` / `app://media` 解析：`/Users/anhuike/Documents/workspace/emperor-agent/desktop/src/main/protocol.ts`
- session store：`/Users/anhuike/Documents/workspace/emperor-agent/packages/core/src/sessions/store.ts`
- project store：`/Users/anhuike/Documents/workspace/emperor-agent/packages/core/src/projects/store.ts`
- project state store：`/Users/anhuike/Documents/workspace/emperor-agent/packages/core/src/projects/state-store.ts`
- model config：`/Users/anhuike/Documents/workspace/emperor-agent/packages/core/src/config/model-config.ts`
- MCP config：`/Users/anhuike/Documents/workspace/emperor-agent/packages/core/src/mcp/config.ts`
- diagnostics：`/Users/anhuike/Documents/workspace/emperor-agent/packages/core/src/api/services/diagnostics-service.ts`
- 现有 legacy 迁移：`/Users/anhuike/Documents/workspace/emperor-agent/packages/core/src/runtime/migrate-state-root.ts`（已存在且已接入 `AgentLoop.create()`，见 `packages/core/src/agent/loop.ts:203`）
- 用户档案活文件目标路径：`ensureUserProfileFile()` 应写入 `join(stateRoot, 'memory', 'profile', 'USER.local.md')`，只从 `runtimeRoot/templates/init/USER.md` 读取种子模板：`/Users/anhuike/Documents/workspace/emperor-agent/packages/core/src/sessions/onboarding.ts:13-24`

### 已知缺口（本计划需要修的现状问题）

- `migrate-state-root.ts` 当前只搬 `memory/`、`sessions/`、`.team/`、`projects index.json` 四类（`migrateLegacyStateRoot()` 里只有 4 次 `copyTree`/`migrateLegacyProjectIndex` 调用），完全没有覆盖 `control/`、`scheduler/`、`tasks/`、`external/`、`tokens/`——这五个目录同样定义在 `RuntimePaths`（`runtime/paths.ts`）里，且已经承载真实用户状态（pending ask/plan 交互、排定的定时任务、任务记录）。本计划 Task 7 必须把这五类补进 legacy roots 列表，否则老用户升级后这些状态不会丢失，但会从 App 视角"凭空消失"（新 stateRoot 下找不到，旧 runtimeRoot 下的文件没人再读）。
- 整改前版本曾把真实的、会被持续改写的用户档案文件放在一个名叫 `templates/` 的目录下；该目录语义上应只承载内置只读种子模板。本计划要求活文件统一落到 `memory/profile/USER.local.md`，旧 `templates/USER.local.md` 只作为兼容迁移来源。

---

## 目标目录模型

新默认全局私有目录：

```text
~/.emperor-agent/
  emperor.local.json
  model_config.json
  mcp_config.json
  templates/            # 内置只读种子模板副本，不承载任何持续改写的活文件
  skills/
  memory/
    profile/
      USER.local.md      # 用户偏好档案活文件；旧 stateRoot/templates/USER.local.md 仅作为兼容迁移来源
    MEMORY.local.md      # 全局长期记忆；保留旧 MemoryStore 相对路径以便兼容迁移
    attachments/
    media/
    desktop/
    desktop_pet/
  sessions/
    index.json
    <session-id>/
      history.jsonl
      runtime/events.jsonl
      _checkpoint.json
  projects/
    index.json
    <project-id>/
      project.json
      AGENTS.local.md
      prompt-overlay.md
  tasks/
  scheduler/
  team/
  external/
  control/
  migrations/
    state-root-migration.json
```

对比原始草案的两处修正：
1. 原草案在 `memory/` 下又列了一个 `projects/`，与顶层 `projects/`（对应 `paths.ts` 里唯一的 `projectsRoot`）重复且当前代码没有任何对应实现，属于文档笔误，已删除。
2. 原草案在 `<project-id>/` 下列了 `memory/`、`runtime/` 两个子目录，但 `projects/state-store.ts` 的 `paths()` 只产出 `project.json`/`AGENTS.local.md`/`prompt-overlay.md`，本计划 10 个任务里也没有任何一项创建这两个子目录，属于超前于实现的臆测内容，已删除；如未来确有需要（例如项目级 episode），应先补任务再回写目录树。

项目源码目录只允许保留：

```text
<project>/
  AGENTS.md
  .emperor/
    settings.json
    settings.local.json
    rules/
    skills/
```

禁止将以下私有运行数据写入用户项目源码目录：

```text
.emperor/sessions/
.emperor/memory/
.emperor/projects/
.emperor/attachments/
.emperor/media/
model_config.json
mcp_config.json
emperor.local.json
memory/profile/USER.local.md
```

---

## Public API / Types

- `resolveRuntimePaths(runtimeRoot, { stateRoot? })` 保持接口，但默认 `stateRoot` 改为全局 `~/.emperor-agent`。
- 新增环境变量：`EMPEROR_CONFIG_DIR`，优先级高于默认 `~/.emperor-agent`。
- `EMPEROR_AGENT_ROOT` 和 `--root` 只表示 runtime resources root，不再表示私有 state root。
- Electron `ResolvedConfig` 扩展为：
  - `runtimeRoot`
  - `stateRoot`
  - `runtimeRootSource`
  - `stateRootSource`
  - `configSource`
- `CoreApi.create()` / `createCoreHost()` 继续支持 `coreOptions.stateRoot`，Electron main 必须显式传入全局 `stateRoot`。
- diagnostics 输出必须包含 `paths.runtimeRoot`、`paths.stateRoot`、`paths.stateRootSource`、`paths.legacyStateRoots`。

---

## Task 1: 建立全局 stateRoot 解析

**Files:**

- Modify: `/Users/anhuike/Documents/workspace/emperor-agent/packages/core/src/runtime/paths.ts`
- Test: `/Users/anhuike/Documents/workspace/emperor-agent/packages/core/src/runtime/paths.test.ts`

- [ ] 添加 `defaultStateRoot()`：默认返回 `path.join(os.homedir(), '.emperor-agent')`。
- [ ] 解析优先级固定为：显式 `stateRoot` > `EMPEROR_CONFIG_DIR` > `~/.emperor-agent`。
- [ ] `runtimeRoot` 继续代表应用资源根；不得再用 `join(runtimeRoot, '.emperor')` 作为默认 state root。
- [ ] `ensureRuntimeStateDirs()` 仍创建 sessions/memory/projects/tasks/scheduler/team/external/control 等目录，但目标是新 `stateRoot`。
- [ ] 保留 `templatesDir`、`skillsDir`、`assetsDir` 默认从 `runtimeRoot` 派生。
- [ ] 测试覆盖：
  - 未传参时 stateRoot 为 `~/.emperor-agent`
  - `EMPEROR_CONFIG_DIR` 生效
  - 显式 `stateRoot` 覆盖环境变量
  - `runtimeRoot` 与 `stateRoot` 可以不同
  - `ensureRuntimeStateDirs()` 不创建 runtime resource 目录

---

## Task 2: Electron main 分离 runtimeRoot 与 stateRoot

**Files:**

- Modify: `/Users/anhuike/Documents/workspace/emperor-agent/desktop/src/main/config.ts`
- Modify: `/Users/anhuike/Documents/workspace/emperor-agent/desktop/src/main/index.ts`
- Modify: `/Users/anhuike/Documents/workspace/emperor-agent/desktop/src/main/core-host.ts`
- Test: `/Users/anhuike/Documents/workspace/emperor-agent/desktop/src/main/config.test.ts`
- Test: `/Users/anhuike/Documents/workspace/emperor-agent/desktop/src/main/core-host.test.ts`

- [ ] `resolveConfig()` 返回 `runtimeRoot` 与 `stateRoot`，不再只返回 `root`。
- [ ] packaged app 继续使用 `app.getPath('userData')/runtime` 作为 `runtimeRoot`，但私有数据写入 `~/.emperor-agent` 或 `EMPEROR_CONFIG_DIR`。
- [ ] `createCoreHost()` 调用 `CoreApi.create({ root: runtimeRoot, stateRoot })`。
- [ ] `mainBoundsPath()` 改为 `path.join(stateRoot, 'memory', 'desktop', 'window.json')`。
- [ ] desktop pet 的 runtime 资源使用 `runtimeRoot`，运行态目录使用 `stateRoot/memory/desktop_pet`。
- [ ] `createPetWindow()` 启动桌宠时同时传递 runtime root 与 state root；如果桌宠目前只理解 `--root`，先保持 `--root` 为 runtime root，并通过 `EMPEROR_CONFIG_DIR` 传递 state root。
- [ ] 测试覆盖 dev、packaged、显式 `EMPEROR_AGENT_ROOT`、显式 `EMPEROR_CONFIG_DIR` 四种组合。

---

## Task 3: 配置文件迁移到全局 stateRoot

**Files:**

- Modify: `/Users/anhuike/Documents/workspace/emperor-agent/packages/core/src/agent/loop.ts`
- Modify: `/Users/anhuike/Documents/workspace/emperor-agent/packages/core/src/config/local-config.ts`
- Modify: `/Users/anhuike/Documents/workspace/emperor-agent/packages/core/src/config/model-config.ts`
- Modify: `/Users/anhuike/Documents/workspace/emperor-agent/packages/core/src/mcp/config.ts`
- Modify: `/Users/anhuike/Documents/workspace/emperor-agent/packages/core/src/api/services/config-service.ts`
- Modify: `/Users/anhuike/Documents/workspace/emperor-agent/packages/core/src/api/services/model-service.ts`
- Modify: `/Users/anhuike/Documents/workspace/emperor-agent/packages/core/src/api/services/diagnostics-service.ts`
- Modify: `/Users/anhuike/Documents/workspace/emperor-agent/packages/core/src/sessions/onboarding.ts`

- [ ] `emperor.local.json` 从 `stateRoot` 读取；旧 `runtimeRoot/emperor.local.json` 只作为一次性迁移来源。
- [ ] `model_config.json` 从 `stateRoot` 读取和保存；`runtimeRoot/model_config.example.json` 只作为默认模板。
- [ ] `mcp_config.json` 从 `stateRoot` 读取和保存；`runtimeRoot/mcp_config.example.json` 只作为默认模板。
- [ ] `memory/profile/USER.local.md` 由 `ensureUserProfileFile(stateRoot, runtimeRoot/templates)` 初始化；目标目录必须是 `join(stateRoot, 'memory', 'profile')`，种子内容来源（`templatesDir/init/USER.md`）不变，函数签名和调用方不变。
- [ ] `AgentLoop.create()` 中 `loadLocalConfig()`、`loadModelConfig()`、`new ModelRouter()`、`new MCPClient()` 均使用 `stateRoot` 读取用户配置。
- [ ] diagnostics 明确显示当前实际配置文件路径，避免用户误以为项目源码目录被写入。

---

## Task 4: session / memory / project state 全部落到 stateRoot

**Files:**

- Modify: `/Users/anhuike/Documents/workspace/emperor-agent/packages/core/src/agent/loop.ts`
- Modify: `/Users/anhuike/Documents/workspace/emperor-agent/packages/core/src/api/core-api.ts`
- Modify: `/Users/anhuike/Documents/workspace/emperor-agent/packages/core/src/sessions/store.ts`
- Modify: `/Users/anhuike/Documents/workspace/emperor-agent/packages/core/src/projects/store.ts`
- Modify: `/Users/anhuike/Documents/workspace/emperor-agent/packages/core/src/projects/state-store.ts`

- [ ] `SessionStore`、`ProjectStore`、`TaskManager`、`ControlManager`、`SchedulerStore`、`TeamManager`、`ExternalStore` 都只接收 `stateRoot` 或其子目录。
- [ ] `ProjectStore.resolve(path)` 只注册项目引用，不在项目源码目录写 session/memory/runtime。
- [ ] `ProjectStateStore` 的 `AGENTS.local.md`、`prompt-overlay.md`、`project.json` 写入 `stateRoot/projects/<project-id>/`。
- [ ] 项目源码中的 `AGENTS.md` 只读入作为协作上下文，不自动改写。
- [ ] 新 session 的 `history.jsonl`、`runtime/events.jsonl`、checkpoint 一律写入 `stateRoot/sessions/<session-id>/`。
- [ ] `workspaceRoot` 仍指向用户选择的项目路径，工具读写工作区文件时继续受 workspace policy 控制。

---

## Task 5: 附件与媒体协议改用 stateRoot

**Files:**

- Modify: `/Users/anhuike/Documents/workspace/emperor-agent/packages/core/src/attachments/store.ts`
- Modify: `/Users/anhuike/Documents/workspace/emperor-agent/packages/core/src/media/store.ts`
- Modify: `/Users/anhuike/Documents/workspace/emperor-agent/desktop/src/main/protocol.ts`
- Modify: `/Users/anhuike/Documents/workspace/emperor-agent/desktop/src/main/index.ts`
- Test: `/Users/anhuike/Documents/workspace/emperor-agent/desktop/src/main/protocol.test.ts`

- [ ] 附件原图写入 `stateRoot/memory/attachments/<month>/`。
- [ ] 生成媒体写入 `stateRoot/memory/media/<month>/`。
- [ ] `app://attachments/{id}/raw` 和 `app://media/{id}/raw` resolver 接收 `stateRoot`。
- [ ] resolver 保留旧路径 fallback：先查 `stateRoot`，再查旧 `runtimeRoot/memory/...`，只读不迁移。
- [ ] 测试覆盖新路径读取、旧路径 fallback、非法路径拒绝。

---

## Task 6: 技能与模板拆分为内置资源 + 用户全局资源

**Files:**

- Modify: `/Users/anhuike/Documents/workspace/emperor-agent/packages/core/src/agent/loop.ts`
- Modify: `/Users/anhuike/Documents/workspace/emperor-agent/packages/core/src/api/services/skill-service.ts`
- Modify: `/Users/anhuike/Documents/workspace/emperor-agent/packages/core/src/agent/context-builder.ts`
- Modify: `/Users/anhuike/Documents/workspace/emperor-agent/packages/core/src/tools/builtin.ts`

- [ ] `runtimeRoot/skills` 作为内置技能，只读。
- [ ] `stateRoot/skills` 作为用户全局技能，可写。
- [ ] 可选项目技能只从 `<project>/.emperor/skills` 读取，不写入。
- [ ] 技能加载顺序：项目技能 > 用户全局技能 > 内置技能。
- [ ] Skill API 的 create/update/delete 默认只操作 `stateRoot/skills`。
- [ ] `runtimeRoot/templates` 只作为模板来源，用户私有模板写入 `stateRoot/templates`。
- [ ] `LoadSkill` 工具读取技能时与 `ContextBuilder` 使用同一套加载顺序，避免提示词与工具读取结果不一致。

---

## Task 7: 兼容迁移旧数据但不删除旧数据

**Files:**

- Modify: `/Users/anhuike/Documents/workspace/emperor-agent/packages/core/src/runtime/migrate-state-root.ts`
- Test: `/Users/anhuike/Documents/workspace/emperor-agent/packages/core/src/runtime/migrate-state-root.test.ts`

- [ ] 新增 legacy roots 探测：
  - `runtimeRoot/.emperor`
  - `runtimeRoot/memory`
  - `runtimeRoot/sessions`
  - `runtimeRoot/.team`
  - `runtimeRoot/.emperor/control`、`runtimeRoot/.emperor/scheduler`、`runtimeRoot/.emperor/tasks`、`runtimeRoot/.emperor/external`、`runtimeRoot/.emperor/tokens`——现有 `migrateLegacyStateRoot()`（`runtime/migrate-state-root.ts:22-33`）只调用了 4 次 `copyTree`/`migrateLegacyProjectIndex`，完全没有搬这五个目录；它们同样是 `RuntimePaths` 的一部分（`controlRoot`/`schedulerRoot`/`tasksRoot`/`externalRoot`/`tokensFile`），且承载真实运行状态（pending ask/plan 交互、排定的 scheduler job、任务记录、token 账本）。不补齐会导致老用户升级后这些状态从新 stateRoot 视角”凭空消失”（未被删除，只是没人再读旧位置）。
  - 用户项目源码目录中的 `.emperor`，仅当当前 project path 明确匹配时才提示，不自动搬空
- [ ] `memory/profile/USER.local.md` 一次性路径迁移：旧路径 `runtimeRoot/.emperor/templates/USER.local.md` 或旧 `stateRoot/templates/USER.local.md` 如存在且新路径 `stateRoot/memory/profile/USER.local.md` 不存在，整份复制过去；这是一次路径改名，不是 `copyTree` 能自动处理的目录级搬运，需要单独一步。旧文件不删除。
- [ ] 从旧 root 复制到新 `stateRoot` 时使用”不覆盖已有文件”策略。
- [ ] 写入 `stateRoot/migrations/state-root-migration.json`，记录来源、目标、时间、复制文件数量、跳过文件数量。
- [ ] 不删除旧数据，避免破坏用户证据。
- [ ] diagnostics 暴露 `legacyStateRoots` 和 migration report。

---

## Task 8: 项目本地 `.emperor` 只保留轻量协作配置

**Files:**

- Modify: `/Users/anhuike/Documents/workspace/emperor-agent/packages/core/src/projects/store.ts`
- Modify: `/Users/anhuike/Documents/workspace/emperor-agent/packages/core/src/context/*`
- Docs: `/Users/anhuike/Documents/workspace/emperor-agent/docs/architecture/global-state-store.md`

- [ ] 允许读取 `<project>/AGENTS.md`。
- [ ] 允许读取 `<project>/.emperor/settings.json`、`settings.local.json`、`rules/*.md`、`skills/*`。
- [ ] 禁止 Core 自动创建 `<project>/.emperor/sessions`、`memory`、`runtime`、`attachments`、`media`。
- [ ] 如检测到项目目录里已有私有 `.emperor/sessions` 或 `.emperor/memory`，只在 diagnostics 中提示”旧数据未迁移/可迁移”，不自动删除。
- [ ] 文档明确：项目 `.emperor` 是项目协作层，不是私有全局 store。
- [ ] 文档与所有 UI 文案必须明确区分两个仅一字之差、性质完全不同的文件：项目源码里可提交的 `<project>/AGENTS.md`（协作文档，用户手写/可 code review）,和全局私有 store 下 `stateRoot/projects/<project-id>/AGENTS.local.md`（`projects/state-store.ts:42-46`，压缩算法写入的项目记忆，用户一般不直接编辑，也不在项目源码树里）。任何提到后者的 diagnostics/UI 文案必须带”全局私有项目记忆”一类限定词，不能只显示裸文件名 `AGENTS.local.md`。

---

## Task 9: UI / diagnostics 给用户明确解释数据位置

**Files:**

- Modify: `/Users/anhuike/Documents/workspace/emperor-agent/packages/core/src/api/services/diagnostics-service.ts`
- Modify: `/Users/anhuike/Documents/workspace/emperor-agent/desktop/src/renderer/src/views/SettingsView.vue`
- Modify: `/Users/anhuike/Documents/workspace/emperor-agent/desktop/src/renderer/src/views/ConfigsView.vue`
- Modify: `/Users/anhuike/Documents/workspace/emperor-agent/desktop/src/renderer/src/components/*`

- [ ] 设置页或 diagnostics 面板展示：
  - Runtime resources root
  - Global state root
  - Active project path
  - Sessions path
  - Attachments path
  - Model config path
  - MCP config path
- [ ] 当用户选择项目文件夹时，UI 明确显示“项目已绑定；私有会话保存到全局 Emperor store”。
- [ ] 清空 session 只清空 `stateRoot/sessions`，不碰项目源码目录。
- [ ] “打开数据目录”按钮打开 `stateRoot`。
- [ ] “打开项目目录”按钮打开 active project path。

---

## Task 10: 文档与验收

**Files:**

- Create: `/Users/anhuike/Documents/workspace/emperor-agent/docs/architecture/global-state-store.md`
- Modify: `/Users/anhuike/Documents/workspace/emperor-agent/README.md`
- Modify: `/Users/anhuike/Documents/workspace/emperor-agent/AGENTS.md`

- [ ] 文档写明新目录模型、环境变量、迁移策略、项目本地文件边界。
- [ ] README 补充 release app 的默认数据位置：
  - macOS: `~/.emperor-agent`
  - runtime resources: Electron `userData/runtime`
- [ ] AGENTS.md 更新“不应提交”列表，强调运行态默认不在项目目录。
- [ ] 文档引用 Claude Code 对照证据路径，保留本计划“关键证据”中的源码路径。

---

## Test Plan

Core tests：

- [ ] `npm test --workspace @emperor/core`
- [ ] `npm run typecheck --workspace @emperor/core`
- [ ] 新增测试确认 `resolveRuntimePaths()` 默认不再返回 `runtimeRoot/.emperor`。
- [ ] 新增测试确认 `SessionStore`、`ProjectStore`、`AttachmentStore`、`MediaStore` 都写入 `stateRoot`。
- [ ] 新增测试确认旧 `runtimeRoot/.emperor` 可迁移到新 `stateRoot`，且不覆盖已有文件。
- [ ] 新增测试确认 `control/`、`scheduler/`、`tasks/`、`external/`、`tokens/` 五类目录也被迁移函数覆盖（现状 `migrate-state-root.ts` 遗漏，见"已知缺口"）。
- [ ] 新增测试确认旧 `templates/USER.local.md` 迁移到新 `memory/profile/USER.local.md` 且内容逐字保留。
- [ ] 新增测试确认 `loadModelConfig()`、`saveModelConfig()`、`loadMcpConfig()`、`saveMcpConfig()` 在 Core 主链路中使用 `stateRoot`。

Desktop tests：

- [ ] `npm --prefix desktop run test`
- [ ] `npm --prefix desktop run typecheck`
- [ ] 新增测试确认 Electron main 将 `runtimeRoot` 与 `stateRoot` 同时传给 Core。
- [ ] 新增测试确认 `app://attachments` 与 `app://media` 从 `stateRoot` 读取并支持旧路径 fallback。

Full checks：

- [ ] `make check`

Manual verification：

- [ ] 清空 `~/.emperor-agent` 后启动 app，确认自动创建全局 store。
- [ ] 选择 `/Users/anhuike/Desktop/任意项目` 作为项目，发送消息，确认项目目录没有新增 `.emperor/sessions` 或 `.emperor/memory`。
- [ ] 确认 session 写入 `~/.emperor-agent/sessions/<session-id>/`。
- [ ] 确认项目 registry 写入 `~/.emperor-agent/projects/index.json`。
- [ ] 确认附件写入 `~/.emperor-agent/memory/attachments/`。
- [ ] 确认 model 和 MCP 配置写入 `~/.emperor-agent/model_config.json`、`~/.emperor-agent/mcp_config.json`。

---

## Assumptions

- 本轮不删除用户项目中已有旧 `.emperor` 数据，只迁移或提示。
- 本轮不重构 session 多实例、Plan/Todo、工具卡片 UI；只处理存储边界。
- `EMPEROR_AGENT_ROOT` 保留给 runtime resources，新增 `EMPEROR_CONFIG_DIR` 给私有 state root。
- release app 的私有数据默认写入 `~/.emperor-agent`，而不是 Electron `userData/runtime`，这样更接近 Claude Code 的 `~/.claude` 模型。
- 项目内 `AGENTS.md` 是可提交协作文件；项目内 `.emperor/settings.local.json` 可作为项目本地覆盖，但不能承载私有 session 或 memory。
- `USER.local.md` 从旧 `templates/USER.local.md` 迁移到 `memory/profile/USER.local.md` 是本轮唯一一处"路径语义修正"而非纯粹的 root 搬家：整改前版本把一份持续被模型改写的活文件放在语义上应为只读种子的 `templates/` 目录下，本计划借迁移之机一并修正，避免和 Task 6"`runtimeRoot/templates` 为内置只读资源"的定义自相矛盾。
