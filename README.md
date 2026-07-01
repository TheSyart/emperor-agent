<p align="center">
  <img src="assets/generated/emperoragent-wordmark.png" alt="Emperor Agent product logo" width="560" />
</p>

<h1 align="center">Emperor Agent · 皇帝智能体</h1>

<p align="center">
  <b>本地运行的个人 Agent 工作台</b><br/>
  Chat / Build 多会话 · 项目级记忆 · 工具执行 · Scheduler · Electron 桌面端
</p>

Emperor Agent 是一个面向个人长期使用的本地 Agent 系统。当前主线已经完成 Python → TypeScript 迁移：Electron main 进程内托管 `@emperor/core`，renderer 通过 preload IPC 调用 CoreApi，不再启动 Python CLI、HTTP server 或 WebSocket server。

<p align="center">
  <img src="assets/generated/readme-product-hero.png" alt="Emperor Agent desktop workspace preview" width="920" />
</p>

## 产品定位

| 模式 | 用途 | 上下文来源 |
|---|---|---|
| `chat` | 日常问答、资料整理、轻量任务 | 系统提示词、用户档案、全局长期记忆、项目索引短摘要 |
| `build` | 绑定本地文件夹，专注构建项目 | 系统提示词、用户档案、项目 `AGENTS.md`、当前项目工作区 |
| Scheduler | 长期自动检查、定时运行、后台维护 | 当前配置、任务 payload、权限模式和运行记录 |

核心原则：

- **本地优先**：模型配置、记忆、附件、任务和运行轨迹都落在本地文件系统。
- **会话隔离**：每个 session 都有独立 `history.jsonl`、checkpoint 和 runtime events。
- **桌面主链路**：Electron main 内创建 `CoreApi`，renderer 只通过 IPC 触达核心能力。
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

安装包通过 `desktop/electron-builder.yml` 复制 `templates/`、`skills/`、`assets/` 和示例配置到 `runtime-defaults`，首次启动再复制到用户数据目录下的 `runtime/`。包内不包含 Python backend，也不要求目标机安装 Python、pip 或 `emperor-agent` 命令。

## 质量检查

```bash
make check
```

`make check` 会执行：

- `git diff --check`
- `node scripts/check_migration_parity.mjs`
- `npm test --workspace @emperor/core`
- `npm run typecheck --workspace @emperor/core`
- `npm --prefix desktop run test`
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

desktop-pet/                    可选 Electron 桌宠 companion
templates/                      prompt 与初始化模板
skills/                         项目技能包
assets/                         品牌、桌宠和生成素材
docs/migration/ts/              迁移状态、任务波次、parity 清单
memory/                         本地运行数据，gitignored
```

## 运行时机制

- Electron main 调用 `createCoreHost()` 初始化 `CoreApi`，并为全部 operation 注册 IPC channel。
- Renderer 中 `api/http.ts` 把旧 HTTP 语义映射到 Core operation；无 Core bridge 时快速失败，提示必须在 Electron 桌面窗口中使用。
- 附件原图通过 `app://attachments/{id}/raw` 读取，由 main process 安全解析 `memory/attachments` 下的真实文件。
- 每个 session 独立保存 `memory/sessions/<id>/history.jsonl`、`_checkpoint.json` 和 `runtime/events.jsonl`。
- Runtime events 通过 Core event bridge 推送到 renderer，刷新后由 bootstrap replay 恢复未压缩 turn 的工具、Ask/Plan、Scheduler、Team 和标题更新细节。
- Scheduler、Watchlist、Team、External Bridge 都在 `@emperor/core` 内部运行，通过 CoreApi 暴露给桌面 UI。

## 模型配置

模型配置使用本地 `model_config.json`，该文件已加入 `.gitignore`。推荐用设置页的模型配置向导或模型面板编辑；手动复制 `model_config.example.json` 仍兼容。

一个模型 entry 共享 `provider / apiKey / apiBase / extraHeaders / extraBody`，但应同时配置：

- `mainModelId`：主 Agent、复杂决策、写入型子代理/队友。
- `secondaryModelId`：记忆压缩、轻量只读/核验任务。

旧配置里的 `id` 会兼容读取为 `mainModelId`；再次保存时会补齐当前 schema。视觉测试通过后会持久化 `supportsVision=true`，Composer 会据此决定图片附件是否走视觉链路。

## 记忆与会话

| 层 | 载体 |
|---|---|
| 会话热历史 | `memory/sessions/<id>/history.jsonl` |
| 会话 checkpoint | `memory/sessions/<id>/_checkpoint.json` |
| 会话 runtime events | `memory/sessions/<id>/runtime/events.jsonl` |
| 全局长期记忆 | `memory/MEMORY.local.md` |
| 用户档案 | `templates/USER.local.md` |
| 项目级记忆 | `<project>/AGENTS.md` 托管区块 |
| 项目索引 | `memory/projects/index.json` |
| 附件 | `memory/attachments/YYYY-MM/{hash8}-{name}.{ext}` |
| token 账本 | `memory/tokens.jsonl` |

Chat 压缩会更新全局长期记忆与用户档案；Build 压缩会更新项目 `AGENTS.md` 托管区块与项目索引摘要。旧根级 `memory/history.jsonl` 会在兼容路径中迁移到默认 session。

## 权限与控制流

| 模式 | 行为 |
|---|---|
| `ask_before_edit` | 默认；读操作直接执行，危险或不确定动作先审批 |
| `auto` | 工具层不主动审批，仍保留路径安全和 schema 校验 |
| `plan` | 只允许只读探索、`ask_user` 和 `propose_plan`，批准后恢复原模式 |

Ask / Plan 状态由 `packages/core/src/control/*` 管理，权限判断由 `packages/core/src/permissions/*` 管理。存在 pending Ask/Plan 时，执行型 Scheduler / Team / desktop-pet mutation 会被 CoreApi guard 拒绝，避免绕过计划门禁。

## 工具与子系统

内建工具包括 `run_command`、`web_fetch`、`read_file`、`write_file`、`edit_file`、`glob`、`grep`、`load_skill`、`update_todos`、`ask_user`、`propose_plan`、`scheduler`、`dispatch_subagent` 和 Team 工具。只读且非 exclusive 的工具可并发执行。

MCP server 仍通过本地 `mcp_config.json` 配置，发现到的工具统一注册为 `mcp_{server}_{tool}`。External Bridge 当前只提供 adapter/store/service 基础设施，不内置具体平台实现。

## 桌宠

桌宠 companion 默认关闭。开发模式首次使用需要：

```bash
cd desktop-pet
npm install
```

生产安装包会内嵌桌宠窗口资源。桌宠窗口位置写入 `memory/desktop_pet/window.json`，启停通过桌面设置页和 CoreApi desktop-pet service 管理。

## 协作约定

不要提交：

- `memory/`
- `.team/`
- `model_config.json`
- `mcp_config.json`
- `emperor.local.json`
- `templates/USER.local.md`
- `.env`
- `desktop/node_modules/`
- `desktop/out/`
- `desktop/dist/`
- `desktop/screenshots/`
- `desktop/test-results/`
- `desktop/.uiplan-progress.json`
- `desktop-pet/node_modules/`
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
