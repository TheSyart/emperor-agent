# Emperor Agent 开发指南

> 文档状态：Active<br>
> 面向读者：贡献者、维护者<br>
> 最后核验：2026-09-22<br>
> 事实源：根目录与 `desktop/package.json`、`packages/core/package.json`、`Makefile`

这里提供源码开发的最短入口，并维护公共的工程约束、关键目录和禁止提交项；系统边界先读[架构总览](../architecture/overview.md)。

## 环境

- Node.js 22 或更高版本。
- npm；根 workspace 与 `desktop/` 各有独立 lockfile 和依赖安装。
- macOS、Windows 或 Linux 桌面环境。普通安装包用户不需要 Node.js。
- 构建桌面安装包需要可编译 Electron 原生依赖的 C/C++ 工具链；`node-pty` 在 CI 的目标平台按 Electron ABI rebuild。发布包只携带运行时 JS、目标原生 binding 和 helper，不携带其测试或构建脚本。

当前主线是 TypeScript / Electron。不要新增 Python runtime、Python CLI、HTTP / WebSocket backend 或 browser-only 产品 fallback。

## 安装与运行

```bash
npm ci
cd desktop
npm ci
npm run dev
```

`npm run dev` 启动 Electron 开发窗口和 renderer dev server。桌面主路径必须通过 preload IPC 访问 main 内的 CoreApi。

本机 ACP client 可以使用源码级的 [Headless ACP operator preview](headless-acp.md)。它通过 stdio 直接托管同一个 TypeScript Core，不是桌面 IPC fallback，也不恢复旧 HTTP / WebSocket backend。

## 质量门禁

在仓库根目录运行：

```bash
make check
```

它覆盖 diff whitespace、格式检查、Core 与 Desktop 测试、typecheck、lint 和 desktop build。按改动类型补充：

```bash
npm --prefix desktop run screenshots
npm --prefix desktop run package:verify
```

- 修改 renderer 视觉或交互时运行 `screenshots`，检查生成结果，不把临时产物混入提交。
- 修改打包、资源路径、Electron main、preload、`app://` protocol 或 release contract 时运行 `package:verify`。该命令生成本地 Preview 包并运行 schema 2 smoke，加载真实 sandboxed renderer，验证 CJS preload、Core bridge 和 attachment fetch；macOS 还在打包进程内使用生产 `LocalSandbox` 运行 18 条受限开发命令，核对实际产物和电脑操作状态拒读。只跑 `package:dir` 不构成通过证据。正式发布使用独立 release 配置。
- 修改 Terminal 时还要运行 `npm --prefix desktop run terminal:smoke`，并在目标 Electron ABI 下创建真实 PTY；afterPack 必须验证目标 platform/arch 对应的 `pty.node`（Unix 还包括可执行 `spawn-helper`），三平台 Preview candidate 必须完成 native rebuild/package smoke。
- 文档改动至少运行 `npm run format:check`、`git diff --check` 和相关 contract test。

## 修改从哪里开始

| 目标                     | 入口                                                                                                           |
| ------------------------ | -------------------------------------------------------------------------------------------------------------- |
| 内核组合根               | `packages/core/src/harness/host/host.ts`、`harness/host/services.ts`                                           |
| CoreApi 或服务           | `packages/core/src/api/core-api.ts`、`api/operations.ts`、`api/services/`                                      |
| Agent loop / middleware  | `packages/core/src/harness/agent/`                                                                             |
| Session log              | `packages/core/src/session-log/`                                                                               |
| Provider / 模型          | `packages/core/src/llm/catalog.ts`、`llm/route.ts`、`llm/adapters/`、`config/model-config.ts`                  |
| 工具                     | `packages/core/src/harness/tools/builtin/`、`harness/tools/registry.ts`                                        |
| 权限 / Plan / 问题       | `packages/core/src/harness/sandbox/`、`harness/approval/`、`harness/plan/`、`harness/questions/`               |
| 压缩                     | `packages/core/src/harness/compaction/`                                                                        |
| Goal                     | `packages/core/src/harness/goal/`、`api/services/goal-service.ts`                                              |
| 子代理 / 后台任务        | `packages/core/src/harness/subagent/`、`harness/jobs/`                                                         |
| Hooks                    | `packages/core/src/harness/hooks/`、`api/services/hooks-service.ts`                                            |
| 提示词 / 工作区说明      | `packages/core/src/harness/prompt/`、`templates/agent/persona.md`                                              |
| Runtime event 投影       | `packages/core/src/harness/projection/`                                                                        |
| Session 索引 / Memory    | `packages/core/src/sessions/`、`memory/`、`projects/`、`harness/memory/memory.ts`                              |
| Scheduler / MCP / Skills | `packages/core/src/scheduler/`、`mcp/`、`skills/`、`plugins/` 与对应 API service                               |
| Snapshot / Git / Files   | `packages/core/src/workspace/`                                                                                 |
| Pull Request 查询        | `packages/core/src/workspace/pull-request-browser.ts`、`environment/tool-catalog.json` 的 `gh`                 |
| 用户 Terminal            | `packages/core/src/workspace/terminal.ts`、`desktop/src/main/terminal-*`                                       |
| Electron host / IPC      | `desktop/src/main/`、`desktop/src/preload/`                                                                    |
| Headless / ACP stdio     | `packages/core/src/acp/`、`scripts/build-acp.mjs`                                                              |
| Vue UI                   | `desktop/src/renderer/src/`                                                                                    |
| 外壳、路由与快捷键       | `renderer/src/components/shell/`（`AppFrame.vue`、`columns.ts`、`frameState.ts`）、`router.ts`、`shortcuts.ts` |
| 侧栏与通知               | `renderer/src/components/sidebar/`、`runtime/notifications.ts`、`composables/useNotifications.ts`              |
| 右侧工作台与环境信息卡   | `renderer/src/components/workspace/`、`components/conversation/environment/`                                   |
| 整页（定时任务、插件等） | `renderer/src/components/pages/`（`PageShell.vue`、`pageLifecycle.ts`）                                        |
| 受管插件 Logo            | `assets/generated/plugin-logos/`；材质、透明边界与包内引用见[插件 Logo 设计规范](../design/plugin-logos.md)    |
| 内置浏览器               | `desktop/src/main/browser-view.ts`、`browser-view-policy.ts`、`desktop-capability-ipc.ts`                      |
| 设置弹窗                 | `desktop/src/renderer/src/components/settings/`（分区、`ui/` 原语、`settingsHeader.ts`）                       |

跨层改动请使用[扩展 Emperor Agent](extending-emperor.md)的同步清单，不要只修改最先报错的一层。

Core package 只开放三个受控导入面：`@emperor/core/api`、`@emperor/core/runtime-contract` 和 `@emperor/core/host-capabilities`。Desktop、脚本与新 package consumer 不得从 `@emperor/core` root 或 `packages/core/src/*` 深路径导入；renderer 共享的 replay/type 只允许使用 browser-safe `runtime-contract`。

## 数据与测试隔离

运行态数据默认写入 Emperor Home（`~/.emperor`）。测试必须使用临时 `HOME` 和临时 `stateRoot`，不能读取、迁移或覆盖开发者的真实模型配置、会话、Skills、受管环境、记忆和凭证。Build workspace 也不能承载 session 或附件私有数据。内核测试可复用 `packages/core/src/harness/testing.ts` 中的脚本化模型适配器与内存 session store。

不要提交 `memory/`、`sessions/`、`.emperor/`、`.team/`、`private-docs/`、本地配置、`.env`、`node_modules`、构建目录、screenshots 或 test results；完整规则以仓库 `.gitignore` 为准。

## 文档责任

行为变化不是“代码完成、文档以后再补”。根据[文档维护规范](../DOCUMENTATION.md)定位事实源和受影响文档；新增当前说明加入[文档中心](../README.md)。任务计划、审计过程、progress、研究和临时对照材料统一保存在仓库根目录下被 Git 忽略的 `private-docs/` 中。

## 提交前

- 工作树只包含本次任务需要的文件。
- 新 operation、event、schema 或 Store 均已完成跨层同步。
- 磁盘格式变化有兼容与恢复策略。
- 相关测试与 `make check` 通过。
- 用户可感知变化已进入 [`docs/release/CHANGELOG.md`](../release/CHANGELOG.md) 的 `Unreleased`。
