<p align="center">
  <img src="assets/generated/emperoragent-wordmark.png" alt="Emperor Agent product logo" width="560" />
</p>

<h1 align="center">Emperor Agent · 皇帝智能体</h1>

<p align="center">
  <b>本地运行的个人 Agent 工作台</b><br/>
  Chat / Build 多会话 · 项目级记忆 · 工具执行 · Agent Hooks · Scheduler · Electron 桌面端
</p>

Emperor Agent 是一个面向个人长期使用的本地 Agent 系统。当前主线已经完成 Python → TypeScript 迁移：Electron main 进程内托管 `@emperor/core`，renderer 通过 preload IPC 调用 CoreApi，不再启动 Python CLI、HTTP server 或 WebSocket server。

<p align="center">
  <img src="assets/generated/readme-product-hero.png" alt="Emperor Agent desktop workspace preview" width="920" />
</p>

## 产品定位

| 模式      | 用途                             | 上下文来源                                             |
| --------- | -------------------------------- | ------------------------------------------------------ |
| `chat`    | 日常问答、资料整理、轻量任务     | 系统提示词、用户档案、全局长期记忆、项目索引短摘要     |
| `build`   | 绑定本地文件夹，专注构建项目     | 系统提示词、用户档案、项目 `AGENTS.md`、当前项目工作区 |
| Scheduler | 长期自动检查、定时运行、后台维护 | 当前配置、任务 payload、权限模式和运行记录             |

核心原则：

- **本地优先**：模型配置、记忆、附件、任务和运行轨迹都落在本地文件系统。
- **会话隔离**：每个 session 都有独立 `history.jsonl`、checkpoint 和 runtime events。
- **桌面主链路**：Electron main 内创建 `CoreApi`，renderer 只通过 IPC 触达核心能力。
- **可审计自动化**：Agent Hooks 在工具、权限、停止、压缩和配置变更等生命周期点执行确定性规则。
- **可迁移数据**：TypeScript 版继续读取旧版磁盘布局；兼容性由 `packages/core/fixtures/python-runtime` 验证。

## 快速开始

需要 Node.js 22 或更高版本。

```bash
npm ci

cd desktop
npm ci
npm run dev              # 开发模式：Electron + Vite HMR + 进程内 CoreApi
npm run build            # 生产构建到 desktop/out/
npm start                # 预览生产构建
npm test                 # desktop vitest
npm run package:dir      # electron-builder unpacked dry run
```

启动不会强制配置模型。需要配置时可在设置页主动打开模型配置向导，也可以手动复制 `model_config.example.json`；未配置模型时，对话或模型测试会给出配置提示。

打包：

```bash
cd desktop
npm run dist:mac         # macOS dmg/zip
npm run dist:linux       # Linux AppImage
npm run dist:win         # Windows NSIS exe
```

安装包内含 Electron/Node runtime，不要求目标机预装 Node、npm、Python、pip、Git、ripgrep 或 `emperor-agent` 命令。只读 `runtime-defaults` 直接从应用资源目录加载，并通过 manifest、SHA-256 和发布 attestation 验证；模型配置、记忆、会话和用户安装的 Skill 只写入全局私有 `stateRoot`，升级应用不会覆盖用户内容。诊断页可探测项目或 Skill 缺失的开发工具，安装前必须展示固定 catalog 来源、许可、提权和依赖计划并由用户确认。

## 安装包与未签名 Preview Release

当前唯一公开发布通道是 `Unsigned Preview`，同批支持 macOS arm64/x64、Windows x64 和 Ubuntu x64。`.github/workflows/release-preview.yml` 只接受默认分支可达的 `v*-preview.*` annotated tag；各平台完成安装 smoke、资源检查、SHA-256、CycloneDX SBOM 和 GitHub attestation 后，最终 job 才会原子发布 GitHub Pre-release。任一平台失败都不会留下公开的半成品 Release。

### 下载与安全提示

当前公开版本是 [`v0.1.0-preview.1`](https://github.com/TheSyart/emperor-agent/releases/tag/v0.1.0-preview.1)。文件名、Release 标题、manifest 和说明均包含 `UNSIGNED-PREVIEW`；它是未签名测试版本，不是 Stable：macOS 未使用 Developer ID 且未经 Apple 公证，Windows 会显示 `Unknown publisher` 并可能触发 SmartScreen。

下载后先在 Release 目录执行 `sha256sum --check SHA256SUMS.txt`，再用 `gh attestation verify <file> --repo TheSyart/emperor-agent` 验证 GitHub 构建来源。Attestation 证明来源与完整性，不代表 Apple/Microsoft 发布者签名。确认摘要后，macOS 仅使用 **System Settings → Privacy & Security → Open Anyway** 的单应用入口，详见 [Apple 官方说明](https://support.apple.com/en-us/102445)；Windows 仅在设备策略允许时使用 **More info → Run anyway**，详见 [Microsoft 官方说明](https://learn.microsoft.com/en-us/windows/apps/package-and-deploy/publish-first-app)。不要更改整机 Gatekeeper、Defender 或 SmartScreen 安全策略。

`.github/workflows/release-internal.yml` 只允许手动生成保留 7 天的 `UNSIGNED-INTERNAL` 调试包，没有 Release 写权限，不能作为公开分发物。正式签名、Apple notarization 和 Windows publisher signing 已从当前计划取消；保留的 legacy `release.yml` 不是当前发布入口，维护者不创建无 prerelease suffix 的正式发布 tag。未来恢复签名发布时必须建立新的 Plan ID。当前策略见 [v2.2 Release 设计](docs/superpowers/specs/2026-07-10-cross-platform-environment-release-design.md)，环境工具 catalog 变更见 [`docs/release/tool-catalog-review.md`](docs/release/tool-catalog-review.md)。

## 质量检查

```bash
make check
```

`make check` 会执行：

- `git diff --check`
- `npm run format:check`
- `node scripts/check_migration_parity.mjs`
- `npm test --workspace @emperor/core`
- `npm run typecheck --workspace @emperor/core`
- Core/Desktop 零 warning ESLint
- `npm --prefix desktop run test` 与测试专用 typecheck
- `npm --prefix desktop run typecheck`
- `npm --prefix desktop run build`

涉及 UI 的改动可额外运行：

```bash
npm --prefix desktop run screenshots
```

视觉测试在 browser-only 环境中注入最小 Core bridge fixture；普通浏览器不再直连运行，也不依赖本地 HTTP/WS server。

## 项目结构

```text
packages/core/                 TypeScript Agent 核心 runtime
├── src/api/                    CoreApi 与 service 层
├── src/agent/                  AgentLoop、AgentRunner、模型调用与上下文构建
├── src/config/                 model/local config 读写和首启配置构造
├── src/providers/              OpenAI-compatible / Anthropic / Bedrock provider
├── src/tools/                  内建工具、工具协议、权限画像和执行器
├── src/hooks/                  Agent Hooks schema、配置加载、匹配、执行、审计
├── src/control/                Ask / Plan 控制流
├── src/permissions/            ask_before_edit / auto / plan 权限策略
├── src/plans/                  Plan 模型、质量门、证据门、执行态
├── src/memory/                 记忆、压缩、版本、token 账本
├── src/sessions/               多会话注册表和会话历史
├── src/runtime/                runtime events、active task registry
├── src/scheduler/              持久 Scheduler job store / executor / tool
├── src/watchlist/              Watchlist heartbeat
├── src/team/                   项目级内部 Team
├── src/external/               External Bridge 基础设施
├── src/mcp/                    MCP config / connection / adapter
└── fixtures/python-runtime/    旧 Python 数据布局兼容 fixture

desktop/                        Electron 桌面应用
├── src/main/                   CoreApi host、app:// 协议、窗口和打包 runtime 初始化
├── src/preload/                contextBridge 暴露 Core IPC / event bridge
├── src/renderer/src/api/       renderer API 与 Core operation 映射
├── src/renderer/src/runtime/   runtime event reducer / selectors / handlers
├── src/renderer/src/views/     Chat、Settings、Scheduler、Plugins 等页面
├── tests/visual/               Playwright 截图烟测
└── electron-builder.yml        三平台打包配置

desktop/src/pet/                主进程内托管的桌宠 companion 资源与逻辑
templates/                      prompt 与初始化模板
skills/                         项目技能包
assets/                         品牌、桌宠和生成素材
docs/migration/ts/              迁移状态、任务波次、parity 清单
docs/architecture/              全局私有存储根等架构文档
memory/                         旧版本地运行数据残留位置（gitignored）；当前默认写入 ~/.emperor-agent，见下方"数据存储位置"
```

## 数据存储位置

Emperor Agent 区分两个根目录（详见 `docs/architecture/global-state-store.md`）：

- **Runtime resources root**（`runtimeRoot`）：内置技能、模板等只读应用资源。开发模式是仓库根；打包模式是 Electron `userData/runtime`。可用 `--root` / `EMPEROR_AGENT_ROOT` 覆盖。
- **Global state root**（`stateRoot`）：会话、记忆、配置、附件等一切私有运行数据。**默认 `~/.emperor-agent`**，开发模式和打包模式一致（不再写入仓库或项目源码目录）。可用 `EMPEROR_CONFIG_DIR` 覆盖。

用户在 UI 里选择的 build 项目目录只保留 `AGENTS.md`（协作文档）和 `.emperor/{settings.json,settings.local.json,rules/,skills/}`；私有的 session/memory/attachments 一律保存到全局 `stateRoot`，不写入项目源码目录。

## 运行时机制

- Electron main 调用 `createCoreHost()` 初始化 `CoreApi`，并为全部 operation 注册 IPC channel。
- Renderer 中 `api/http.ts` 把旧 HTTP 语义映射到 Core operation；无 Core bridge 时快速失败，提示必须在 Electron 桌面窗口中使用。
- 附件原图通过 `app://attachments/{id}/raw` 读取，由 main process 安全解析 `stateRoot/memory/attachments` 下的真实文件（并对旧安装保留只读的 legacy 路径 fallback）。
- 每个 session 独立保存 `stateRoot/sessions/<id>/history.jsonl`、`_checkpoint.json` 和 `runtime/events.jsonl`。
- Runtime events 通过 Core event bridge 推送到 renderer，刷新后由 bootstrap replay 恢复未压缩 turn 的工具、Ask/Plan、Scheduler、Team 和标题更新细节。
- Agent Hooks 由 `@emperor/core` 内的 `HookRuntime` 执行，支持全局私有可编辑配置和项目 `.emperor/settings*.json` 只读导入。
- Scheduler、Watchlist、Team、External Bridge 都在 `@emperor/core` 内部运行，通过 CoreApi 暴露给桌面 UI。

## 模型配置

模型配置使用全局私有 `stateRoot/model_config.json`，该文件已加入 `.gitignore`。推荐用设置页的模型配置向导或模型面板编辑；`model_config.example.json` 是 `runtimeRoot` 下的只读模板资源，手动复制后仍兼容。

一个模型 entry 共享 `provider / apiKey / apiBase / extraHeaders / extraBody`，但应同时配置：

- `mainModelId`：主 Agent、复杂决策、写入型子代理/队友。
- `secondaryModelId`：记忆压缩、轻量只读/核验任务。

旧配置里的 `id` 会兼容读取为 `mainModelId`；再次保存时会补齐当前 schema。视觉测试通过后会持久化 `supportsVision=true`，Composer 会据此决定图片附件是否走视觉链路。

## 记忆与会话

以下路径均相对 `stateRoot`（默认 `~/.emperor-agent`，见"数据存储位置"）：

| 层                     | 载体                                                                                   |
| ---------------------- | -------------------------------------------------------------------------------------- |
| 会话热历史             | `sessions/<id>/history.jsonl`                                                          |
| 会话 checkpoint        | `sessions/<id>/_checkpoint.json`                                                       |
| 会话 runtime events    | `sessions/<id>/runtime/events.jsonl`                                                   |
| 全局长期记忆           | `memory/MEMORY.local.md`                                                               |
| 用户档案               | `memory/profile/USER.local.md`                                                         |
| 项目级记忆（全局私有） | `projects/<project-id>/AGENTS.local.md` 托管区块（不在项目源码目录里，见下方命名说明） |
| 项目索引               | `projects/index.json`                                                                  |
| 附件                   | `memory/attachments/YYYY-MM/{hash8}-{name}.{ext}`                                      |
| token 账本             | `tokens/tokens.jsonl`                                                                  |
| Agent Hooks 配置       | `hooks_config.json`                                                                    |
| Agent Hooks 审计       | `hooks/audit.jsonl`                                                                    |

Chat 压缩会更新全局长期记忆与用户档案；Build 压缩会更新项目私有记忆（`projects/<project-id>/AGENTS.local.md`）与项目索引摘要，**不会**改写项目源码目录里的 `AGENTS.md`（那个文件只被只读导入一次作为种子内容）。旧的单会话时代根级 `stateRoot/memory/history.jsonl`（如果存在且尚未有任何 session）会在启动时自动搬迁为一个新建的默认 session。

> 命名提醒：项目源码里的 `<project>/AGENTS.md`（协作文档，可提交）和全局私有 store 下的 `AGENTS.local.md`（压缩算法维护，不在项目源码树里）只差一个 `.local` 后缀，语义完全不同，详见 `docs/architecture/global-state-store.md`。

## 权限与控制流

| 模式              | 行为                                                           |
| ----------------- | -------------------------------------------------------------- |
| `ask_before_edit` | 默认；读操作直接执行，危险或不确定动作先审批                   |
| `auto`            | 工具层不主动审批，仍保留路径安全和 schema 校验                 |
| `plan`            | 只允许只读探索、`ask_user` 和 `propose_plan`，批准后恢复原模式 |

Ask / Plan 状态由 `packages/core/src/control/*` 管理，权限判断由 `packages/core/src/permissions/*` 管理。存在 pending Ask/Plan 时，执行型 Scheduler / Team / desktop-pet mutation 会被 CoreApi guard 拒绝，避免绕过计划门禁。

## Agent Hooks

Agent Hooks 提供本地生命周期自动化。v1 支持 `SessionStart`、`UserPromptSubmit`、`PreToolUse`、`PostToolUse`、`PostToolUseFailure`、`PermissionRequest`、`PermissionDenied`、`Stop`、`PreCompact`、`PostCompact` 和 `ConfigChange`。

配置源：

- 全局私有配置：`stateRoot/hooks_config.json`，可在 Settings → Hooks 面板编辑。
- 项目只读导入：`<project>/.emperor/settings.json` 与 `<project>/.emperor/settings.local.json` 的 `hooks` block，仅在全局 `projectHooks.enabled` 开启后加载。

handler 范围保持克制：v1 只支持 `command` 和 `http`。执行结果写入 `stateRoot/hooks/audit.jsonl`，并通过 runtime events 发出 `hook_run_started`、`hook_run_progress`、`hook_run_completed`、`hook_run_failed` 和 `hook_decision_applied`。决策聚合优先级固定为 `deny > ask > allow > passthrough`，且 hooks 不会覆盖 workspace policy 或核心 permission deny。

## 工具与子系统

内建工具包括 `run_command`、`web_fetch`、`read_file`、`write_file`、`edit_file`、`glob`、`grep`、`load_skill`、`update_todos`、`ask_user`、`propose_plan`、`scheduler`、`dispatch_subagent` 和 Team 工具。只读且非 exclusive 的工具可并发执行。

MCP server 仍通过本地 `mcp_config.json` 配置，发现到的工具统一注册为 `mcp_{server}_{tool}`。External Bridge 当前只提供 adapter/store/service 基础设施，不内置具体平台实现。

## 桌宠

桌宠 companion 默认关闭。桌宠窗口由 Electron main 进程直接管理（不再是独立 Electron 进程），通过设置页的桌宠卡片一键启停。窗口位置写入 `stateRoot/memory/desktop_pet/window.json`，状态由 CoreApi desktop-pet service 管理。生产安装包会内嵌桌宠渲染资源。

## 协作约定

不要提交（运行态默认不落在项目目录里；以下条目主要针对旧数据残留或显式把 `EMPEROR_CONFIG_DIR` 指回仓库的开发场景）：

- `memory/`
- `sessions/`
- `.emperor/`
- `.team/`
- `model_config.json`
- `mcp_config.json`
- `emperor.local.json`
- `.env`
- `desktop/node_modules/`
- `desktop/out/`
- `desktop/dist/`
- `desktop/screenshots/`
- `desktop/test-results/`
- `desktop/.uiplan-progress.json`
- 任何 `*.local.md`

扩展路径：

- 新 provider：`packages/core/src/providers/registry.ts` + `factory.ts` + provider 实现。
- 新工具：`packages/core/src/tools/` + `packages/core/src/agent/loop.ts` 注册。
- 新 CoreApi 能力：`packages/core/src/api/services/*` + `core-api.ts` + desktop IPC/renderer API 映射。
- 新 runtime event：同步 core event 构造器、renderer `types.ts`、`runtime/*` reducer/handlers 和 `useRuntime.ts`。
- 新 UI：遵循 `desktop/src/renderer/src/views`、`components`、`composables`、`runtime` 分层；图标优先用 `lucide-vue-next`。

## 素材规范

项目内位图素材生成/编辑统一使用 `$imagegen`。最终素材必须落在 `assets/` 下；分类明确则放现有分类，否则放 `assets/generated/`。每次生成/编辑完成后，把最终 prompt 记录到对应目录 `PROMPTS.md`，至少包含日期、输出文件名、工具模式和最终 prompt。

<p align="center">
  <img src="assets/generated/emperor-agent-logo-mark.png" alt="Emperor Agent mark" width="56" />
</p>
