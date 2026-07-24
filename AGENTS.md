# AGENTS.md · Emperor Agent 协作指南

> 本文件固定保存在仓库根目录，供 Codex 和其他受控 Agent 在开发 Emperor Agent 时读取。普通用户说明以 `README.md` 和 `docs/user/` 为准；面向人工开发者的操作指南以 `docs/development/` 为准。

## 0. 沟通与原则

- 默认使用中文沟通；命令、路径、配置 key 保留英文原文。
- 这是可持续迭代的个人 Agent 工程，不是 demo。改动要优先考虑长期可维护性、可验证性和磁盘数据兼容。
- 当前主线已经退役 Python runtime：不要新增 `agent/`、`tests/`、`requirements*.txt`、`pyproject.toml` 或 Python Web/CLI fallback。

## 1. 项目定位

`Emperor Agent` 是一个本地运行的 TypeScript / Electron 智能体系统：

- Electron main 进程内托管 `@emperor/core`，renderer 通过 preload IPC 调用 CoreApi。
- Vue 3 + TypeScript + Tailwind 桌面端提供 Chat / Build 多会话、项目级记忆、工具调用、Scheduler、MCP、Team、Ask / Plan、附件与桌宠 companion。
- 运行数据落在本地全局私有目录（`stateRoot`，默认 `~/.emperor-agent`）里的 `memory/`、`model_config.json`、`mcp_config.json`、`emperor.local.json` 等文件中，不写入仓库或项目源码目录。
- 旧 Python 版只作为迁移背景，不再是可运行产品线；公共仓库不维护旧实现的任务清单或源码对账文档。

## 2. 先看哪里

1. `README.md` + `docs/README.md`
2. `docs/architecture/overview.md` + `docs/development/README.md`
3. `packages/core/src/api/core-api.ts` + `packages/core/src/api/services/*`
4. `packages/core/src/agent/loop.ts` + `packages/core/src/agent/runner.ts`
5. `packages/core/src/config/*` + `packages/core/src/model/*` + `packages/core/src/providers/*`
6. `packages/core/src/tools/*` + `packages/core/src/subagents/*` + `packages/core/src/extensions/*`
7. `packages/core/src/control/*` + `packages/core/src/permissions/*` + `packages/core/src/plans/*`
8. `packages/core/src/memory/*` + `packages/core/src/sessions/*` + `packages/core/src/runtime/*`
9. `packages/core/src/scheduler/*` + `packages/core/src/watchlist/*`
10. `packages/core/src/team/*` + `packages/core/src/mcp/*`
11. `desktop/src/main/*` + `desktop/src/preload/*`
12. `desktop/src/renderer/src/api/*` + `desktop/src/renderer/src/composables/*` + `desktop/src/renderer/src/runtime/*`
13. `desktop/src/renderer/src/components/*` + `desktop/src/renderer/src/views/*`

## 3. 关键目录

- `packages/core/`：核心 Agent runtime、CoreApi、模型/provider、工具、记忆、会话、Scheduler、Team、MCP、权限、计划与项目工作台系统。
- `desktop/`：Electron app。`src/main` 托管 CoreApi 和 `app://` 协议；`src/preload` 暴露 Core IPC；`src/renderer` 是 Vue 桌面应用。
- `desktop/src/pet/`：主进程内托管的可选桌宠 companion；生产包仅内嵌其 allowlist 资源，不存在独立桌宠 runtime。
- `templates/`：系统提示词、初始化用户档案和记忆模板。
- `skills/`：项目内技能包。少数技能自带 Python helper 脚本属于技能资产，不是主 runtime。
- `assets/`：品牌、桌宠、生成素材；生成素材必须记录到对应 `PROMPTS.md`。
- `docs/user/`：面向当前产品入口的完整用户手册。
- `docs/architecture/`：当前系统边界、执行链路、权限、Goal 与全局存储架构。
- `docs/development/`：源码开发和跨层扩展清单。
- `docs/release/`：当前 Preview、安全说明、冻结 Stable 流程和工具供应链审核。
- `private-docs/`：仓库根目录下的本地个人开发资料，保存实施计划、审计、研究、进度和外部源码借鉴材料；整个目录被 Git 忽略。
- `memory/`：旧版本地运行数据残留位置，永不提交。当前默认私有数据根是 `~/.emperor-agent`（`stateRoot`，可用 `EMPEROR_CONFIG_DIR` 覆盖），不再默认写入这里或项目源码目录，详见 `docs/architecture/global-state-store.md`。

## 4. 本地运行

```bash
npm ci
npm test --workspace @emperor/core
npm run typecheck --workspace @emperor/core

cd desktop
npm ci
npm run dev
npm test
npm run typecheck
npm run build
npm run package:dir
```

质量门禁：

```bash
make check
```

`make check` 执行 `git diff --check`、格式检查、Core/Desktop tests、typecheck、lint 和 build。涉及 UI 的改动可额外跑：

```bash
npm --prefix desktop run screenshots
```

## 5. 运行时机制

- Electron main 通过 `createCoreHost()` 初始化 `CoreApi`，不再 probe/spawn/wait 外部 Python server。
- Renderer 使用 `window.emperor.invokeCore()`；`api/http.ts` 只是历史命名的 IPC 薄封装，Core bridge 不可用时直接失败，不提供 browser HTTP/WS fallback。
- 附件原图通过 `app://attachments/{id}/raw` 读取，避免恢复旧 `/api/attachments/*` server 依赖；解析优先查 `stateRoot`，对旧安装保留只读 legacy fallback。
- 每个 session 独立持久化 `stateRoot/sessions/<id>/history.jsonl`、`_checkpoint.json` 和 `runtime/events.jsonl`（`stateRoot` 默认 `~/.emperor-agent`，与 `runtimeRoot` 是两个独立的根，见 `docs/architecture/global-state-store.md`）。
- 新增 CoreApi operation 时必须同步 IPC contract、preload bridge、renderer API 映射和相关类型/测试。
- 新增 runtime event 时必须同步 `packages/core/src/runtime/events.ts`、renderer `types.ts`、`runtime/*` reducer/handlers 和 `useRuntime.ts`。
- 当前公开 Preview 必须通过 `.github/workflows/release-preview.yml` 的三平台 candidate、receipt、SBOM、attestation 和最终聚合门禁。`.github/workflows/release.yml` 的受信 Stable 链仍为 Frozen；不得从平台 build job 直接发布，也不得混用 `UNSIGNED-INTERNAL`、`UNSIGNED-PREVIEW` 和 Stable 产物。
- `packages/core/src/environment/tool-catalog.json` 属于签名静态执行策略。修改版本、来源、摘要、publisher、参数或许可时必须执行 `docs/release/tool-catalog-review.md`，renderer/model 不得提供命令、URL 或 argv。

## 6. 扩展路径

- 新 provider：`packages/core/src/providers/registry.ts`、`factory.ts` 和对应 provider 实现。
- 新工具：`packages/core/src/tools/` 新建工具类，并在 `packages/core/src/agent/loop.ts` 注册。
- 新 AgentDefinition/source：更新 `templates/subagents/agents.json` 与 `packages/core/src/extensions/resolver.ts`；source trust 只能由 host 注入，session policy 只能收紧，并同步打包资源 allowlist、Diagnostics 和兼容测试。
- 新 CoreApi 能力：`packages/core/src/api/services/*` + `core-api.ts`，同步 `desktop/src/main/core-host.test.ts` 和 renderer API。
- 新 Control/Plan/Permission 能力：优先放在 `packages/core/src/control/*`、`plans/*`、`permissions/*`，不要把策略散落到 UI 或 prompt 文案。
- 新会话/记忆/Scheduler/Team/MCP 能力：优先在 `packages/core/src/<domain>/` 内保持 store/service/model 分层，再接 CoreApi。
- 新桌面 UI：遵循现有 Vue composable/panel/runtime 分层；图标优先用 `lucide-vue-next` 并在 `desktop/src/renderer/src/icons.ts` 统一映射。

## 7. 不应提交

运行态私有数据默认写入全局 `stateRoot`（`~/.emperor-agent`），不在项目目录里；以下条目主要防的是旧数据残留或显式把 `EMPEROR_CONFIG_DIR` 指回仓库的开发场景：

严格不要提交：

- `memory/`
- `sessions/`
- `.emperor/`
- `.team/`
- `model_config.json`
- `mcp_config.json`
- `emperor.local.json`
- `.env`
- `private-docs/`；兼容旧工具的 `docs/private/`、`docs/superpowers/`、`docs/archive/` 也不得提交
- 日期化任务计划、progress、审计、研究和外部源码借鉴材料
- `desktop/node_modules/`
- `desktop/out/`
- `desktop/dist/`
- `desktop/screenshots/`
- `desktop/test-results/`
- `desktop/.uiplan-progress.json`

## 8. 常见排查

1. 页面白屏：先跑 `cd desktop && npm run build`，再检查 `desktop/out/renderer/index.html`。
2. Core IPC 不通：看 `desktop/src/main/core-host.ts`、`desktop/src/preload/core-ipc.ts` 和 renderer `api/http.ts` operation 映射。
3. Runtime 事件异常：先看 `desktop/src/renderer/src/runtime/reducer.ts`、`handlers/*`、`useRuntime.ts`。
4. 会话/记忆错乱：看 `packages/core/src/sessions/*`、`memory/*` store 和 `python-runtime-compat.test.ts`。
5. 打包问题：看 `desktop/electron-builder.yml`、`desktop/src/main/runtime-root.ts` 和 `docs/release/preview-release-runbook.md`；Stable 签名链另见 `docs/release/stable-release-runbook.md`，生产包不包含 Python backend。

## 9. 素材生成规范

- 项目内位图素材生成/编辑统一使用 `$imagegen`。
- 最终素材必须落在 `/Users/anhuike/Documents/workspace/emperor-agent/assets` 下；分类明确则放现有分类，否则放 `assets/generated/`。
- 默认不覆盖已有文件，使用版本化命名。
- 每次生成/编辑完成后，把最终 prompt 记录到对应目录 `PROMPTS.md`，至少包含日期、输出文件名、工具模式和最终 prompt。

## 10. 文档维护

- 文档总入口是 `docs/README.md`，分类、状态和事实源映射见 `docs/DOCUMENTATION.md`。
- 公共文档只维护当前有效的 `Active` 内容；被替代但暂留原位的说明标为 `Superseded` 并链接新入口。
- Slash command、权限、模型 schema、CoreApi、runtime event、`stateRoot`、Goal、Release workflow 或 renderer 路由变化时，必须按事实源映射同步所有受影响的 Active 文档。
- 多步骤实施计划、progress、检查脚本、日期化审计、研究和外部源码借鉴材料统一写入根目录 `private-docs/`；公共文档不得链接这些材料。
- Active 文档不写固定 Preview 版本、测试数量、临时 commit 或未开放的产品入口。存在 store/service 不等于已经提供用户界面。
