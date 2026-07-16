# Emperor Agent 文档中心

> 文档状态：Active<br>
> 面向读者：用户、维护者、开发者<br>
> 最后核验：2026-07-16<br>
> 事实源：当前 TypeScript / Electron 主线、根目录 `README.md` 与 `AGENTS.md`

这里是 Emperor Agent 的文档入口。根目录 [README](../README.md) 负责介绍产品和最短使用路径；本目录保存操作手册、架构说明、开发指南、发布流程和历史记录。

## 我想做什么

| 目的                               | 从这里开始                                             |
| ---------------------------------- | ------------------------------------------------------ |
| 安装并完成第一次对话               | [首次使用](user/getting-started.md)                    |
| 理解 Chat 与 Build                 | [会话与项目工作](user/chat-build.md)                   |
| 先规划再执行，或持续推进长任务     | [Plan 与 Goal](user/plan-goal.md)                      |
| 配置模型、记忆和附件               | [模型、记忆与附件](user/models-memory-attachments.md)  |
| 使用 Tools、Skills 或 MCP          | [工具与扩展能力](user/tools-skills-mcp.md)             |
| 使用 Scheduler、Team、Hooks 或桌宠 | [自动化与协作](user/automation-collaboration.md)       |
| 排查启动、模型、数据或打包问题     | [诊断与排障](user/diagnostics-troubleshooting.md)      |
| 了解系统为什么这样设计             | [架构总览](architecture/overview.md)                   |
| 修改或扩展项目                     | [开发指南](development/README.md)                      |
| 构建公开 Preview                   | [Preview 发布手册](release/preview-release-runbook.md) |

## 当前维护的文档

### 用户手册

- [用户手册首页](user/README.md)
- [首次使用](user/getting-started.md)
- [Chat 与 Build](user/chat-build.md)
- [Plan 与 Goal](user/plan-goal.md)
- [模型、记忆与附件](user/models-memory-attachments.md)
- [Tools、Skills 与 MCP](user/tools-skills-mcp.md)
- [Scheduler、Team、Hooks 与桌宠](user/automation-collaboration.md)
- [诊断与排障](user/diagnostics-troubleshooting.md)

### 架构与开发

- [架构总览](architecture/overview.md)
- [Agent 执行链路](architecture/agent-runtime.md)
- [Control 与权限](architecture/control-and-permissions.md)
- [IPC 与 Runtime Events](architecture/ipc-and-runtime-events.md)
- [Goal 模式架构](architecture/goal-mode.md)
- [全局私有存储根](architecture/global-state-store.md)
- [开发指南](development/README.md)
- [扩展 Emperor Agent](development/extending-emperor.md)

### 发布与安全

- [未签名 Preview 安全说明](release/unsigned-preview-notice.md)
- [Preview 发布手册](release/preview-release-runbook.md)
- [Stable 发布手册](release/stable-release-runbook.md)
- [ToolCatalog 发布审核](release/tool-catalog-review.md)
- [Security Policy](../.github/SECURITY.md)
- [Changelog](release/CHANGELOG.md)

## 文档状态

每份当前文档的开头都应标明状态、读者、最后核验日期和主要事实源。

| 状态         | 含义                                                 |
| ------------ | ---------------------------------------------------- |
| `Active`     | 当前产品或流程的有效说明；相关行为变化时必须同步更新 |
| `Superseded` | 已被其他文档取代；必须指向新的有效入口               |

发生冲突时，以代码、schema、workflow 和自动化测试等事实源为准；随后修正文档。个人计划、审计、研究、progress 和外部源码借鉴材料统一保存在仓库根目录下被 Git 忽略的 `private-docs/` 中，不属于公共文档入口。

## 维护规则

文档分类、事实源映射、归档规则和人工验收清单见 [文档维护规范](DOCUMENTATION.md)。开发改动仍需遵守根目录 [AGENTS.md](../AGENTS.md)。
