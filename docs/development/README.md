# Emperor Agent 开发指南

> 文档状态：Active<br>
> 面向读者：贡献者、维护者<br>
> 最后核验：2026-07-19<br>
> 事实源：根目录与 `desktop/package.json`、`packages/core/package.json`、`Makefile`、`AGENTS.md`

这里提供源码开发的最短入口。工程约束、关键目录和禁止提交项以根目录 [AGENTS.md](../../AGENTS.md) 为准；系统边界先读[架构总览](../architecture/overview.md)。

## 环境

- Node.js 22 或更高版本。
- npm；根 workspace 与 `desktop/` 各有独立 lockfile 和依赖安装。
- macOS、Windows 或 Linux 桌面环境。普通安装包用户不需要 Node.js。

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
- 修改打包、资源路径、Electron main、preload、`app://` protocol 或 release contract 时运行 `package:verify`。该命令不只检查 Core：schema 2 smoke 会加载真实 sandboxed renderer，验证 CJS preload、Core bridge 和 attachment fetch；只跑 `package:dir` 不构成通过证据。
- 文档改动至少运行 `npm run format:check`、`git diff --check` 和相关 contract test。

## 修改从哪里开始

| 目标                   | 入口                                                                       |
| ---------------------- | -------------------------------------------------------------------------- |
| CoreApi 或服务         | `packages/core/src/api/core-api.ts`、`packages/core/src/api/services/`     |
| Agent loop / runner    | `packages/core/src/agent/loop.ts`、`packages/core/src/agent/runner.ts`     |
| Provider / 模型        | `packages/core/src/providers/`、`packages/core/src/config/model-config.ts` |
| 工具                   | `packages/core/src/tools/`、`packages/core/src/agent/loop.ts`              |
| Ask / Plan / 权限      | `packages/core/src/control/`、`plans/`、`permissions/`                     |
| Session / Memory       | `packages/core/src/sessions/`、`memory/`、`projects/`                      |
| Goal                   | `packages/core/src/goals/`、`packages/core/src/agent/goal-*`               |
| Scheduler / Team / MCP | `packages/core/src/<domain>/` 与对应 API service                           |
| Electron host / IPC    | `desktop/src/main/`、`desktop/src/preload/`                                |
| Headless / ACP stdio   | `packages/core/src/acp/`、`scripts/build-acp.mjs`                          |
| Vue UI                 | `desktop/src/renderer/src/`                                                |

跨层改动请使用[扩展 Emperor Agent](extending-emperor.md)的同步清单，不要只修改最先报错的一层。

## 数据与测试隔离

运行态数据默认写入 `~/.emperor-agent`。测试必须使用临时 `stateRoot`，不能读取或覆盖开发者的真实模型配置、会话、记忆和凭证。Build workspace 也不能承载 session、附件或 Goal 私有数据。

不要提交 `memory/`、`sessions/`、`.emperor/`、`.team/`、本地配置、`.env`、`node_modules`、构建目录、screenshots 或 test results。完整清单见 [AGENTS.md](../../AGENTS.md)。

## 文档责任

行为变化不是“代码完成、文档以后再补”。根据[文档维护规范](../DOCUMENTATION.md)定位事实源和受影响文档；新增当前说明加入[文档中心](../README.md)。任务计划、审计过程、progress、研究和外部源码借鉴材料统一保存在仓库根目录下被 Git 忽略的 `private-docs/` 中。

## 提交前

- 工作树只包含本次任务需要的文件。
- 新 operation、event、schema 或 Store 均已完成跨层同步。
- 磁盘格式变化有兼容与恢复策略。
- 相关测试与 `make check` 通过。
- 用户可感知变化已进入 [`docs/release/CHANGELOG.md`](../release/CHANGELOG.md) 的 `Unreleased`。
