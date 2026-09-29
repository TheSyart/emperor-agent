# 文档维护规范

> 文档状态：Active<br>
> 面向读者：维护者、开发者、文档作者<br>
> 最后核验：2026-09-24<br>
> 事实源：仓库文档结构、`scripts/check.sh`、`scripts/check_public_docs.mjs`

本规范解决三个问题：一份说明应该放在哪里，什么变化必须同步哪些文档，怎样判断文档可以合并。

## 分类与职责

| 目录或文件                  | 内容                                   | 不应包含                                     |
| --------------------------- | -------------------------------------- | -------------------------------------------- |
| `README.md`                 | 产品定位、下载入口、核心路径、能力边界 | 完整 API、内部 store 细节、固定 Preview 版本 |
| `docs/user/`                | 用户可以执行的操作、结果和限制         | 未开放入口、内部类名堆砌                     |
| `docs/architecture/`        | 当前系统边界、状态机、数据流和恢复语义 | 按日期写的实施进度                           |
| `docs/development/`         | 本地开发、扩展路径和同步清单           | 用户安装步骤的重复副本                       |
| `docs/release/`             | 当前或明确冻结的发布流程、安全提示     | 与某次发布绑定的临时 receipt                 |
| `.github/SECURITY.md`       | 支持范围、漏洞报告和安全处理规则       | 普通故障排查                                 |
| `docs/release/CHANGELOG.md` | 用户可感知的版本变化                   | 提交日志、测试数量、内部过程记录             |

## 状态头

Active 文档使用下面的四行状态头：

```markdown
> 文档状态：Active
> 面向读者：用户 / 开发者 / 发布维护者
> 最后核验：YYYY-MM-DD
> 事实源：代码路径、schema、workflow 或测试
```

状态规则：

- `Active` 需要可定位的事实源。只写“代码”不够，应指出模块或配置入口。
- `Superseded` 必须给出替代文档路径，不再继续维护正文。
- `last_verified` 只在作者实际对照事实源后更新，不能把格式化日期当成核验日期。

## 事实源映射

| 变化                                 | 首要事实源                                                                                                                            | 必须检查的文档                                                                     |
| ------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------- |
| Slash command                        | `packages/core/src/commands/`、`api/services/command-application-service.ts`                                                          | README、Chat/Build、Plan/Goal、Slash command 架构                                  |
| 权限预设、沙箱或审批                 | `harness/sandbox/`、`harness/approval/`、`commands/builtins.ts`                                                                       | README、Chat/Build、Plan/Goal、工具手册、权限与 Plan 架构                          |
| Plan 模式或用户问题                  | `harness/plan/plan-mode.ts`、`harness/questions/`、`harness/host/interactions.ts`                                                     | README、Plan/Goal、权限与 Plan 架构、IPC 文档                                      |
| Agent loop、middleware 或组合根      | `harness/agent/`、`harness/host/host.ts`                                                                                              | 架构总览、Agent 执行链路、开发指南、扩展指南                                       |
| Session log、崩溃修复或 fork         | `packages/core/src/session-log/`、`harness/host/services.ts`                                                                          | Agent 执行链路、存储架构、模型记忆手册、诊断                                       |
| 压缩或长期上下文注入                 | `harness/compaction/`、`harness/memory/memory.ts`、`harness/prompt/agent-instructions.ts`                                             | 模型记忆手册、Chat/Build、Agent 执行链路                                           |
| 工具新增或语义变化                   | `harness/tools/builtin/`、`HarnessHost.compose()`                                                                                     | README、工具手册、Agent 执行链路、扩展指南                                         |
| 模型 schema 或 Provider              | `config/model-config.ts`、`llm/catalog.ts`、`llm/route.ts`、模型面板                                                                  | 首次使用、模型手册、示例配置、扩展指南                                             |
| CoreApi operation                    | `api/operations.ts`、`api/core-api.ts`、IPC contract、renderer API                                                                    | 架构总览、IPC 文档、开发扩展指南                                                   |
| Core package 导出                    | `packages/core/src/public/`、`packages/core/package.json`                                                                             | 架构总览、开发指南                                                                 |
| ACP method / capability              | `packages/core/src/acp/`、官方 ACP schema、wire test                                                                                  | README、架构总览、Headless ACP 指南                                                |
| Runtime event                        | `harness/projection/`（projector、wire 名单）、`public/runtime-contract.ts`、renderer runtime                                         | IPC 文档、Agent 执行链路、相关用户手册                                             |
| 原始 session 事件与 Chat 投影        | `session-log/history.ts`、`harness/host/session-views.ts`、`desktop/src/main/event-bridge.ts`、renderer `conversation/`               | IPC 文档、Chat/Build                                                               |
| `stateRoot` 路径或迁移               | `runtime/paths.ts`、store、`runtime/migrate-state-root.ts`、`archiveLegacySessions()`                                                 | README、数据手册、存储架构、开发指南                                               |
| Goal                                 | `harness/goal/`、`api/services/goal-service.ts`、projector                                                                            | README、Plan/Goal 手册、Goal 架构                                                  |
| 子代理或后台 job                     | `harness/subagent/`、`harness/jobs/`、CoreApi `tasks.*`                                                                               | 工具手册、Agent 执行链路、诊断                                                     |
| Scheduler、Hooks、MCP、Watchlist     | 对应 service/store/schema、`harness/hooks/`、`harness/host/scheduler.ts` 和当前 renderer 路由                                         | 自动化手册、工具手册、[可选能力生命周期](architecture/optional-capabilities.md)    |
| Skills、Plugins 或配置管理工具       | `packages/core/src/skills/`、`plugins/`、`mcp/manage.ts`、`harness/tools/builtin/skill-manage.ts` 与 `mcp-config.ts`                  | README、工具手册、Plan/Goal、Agent 执行链路、存储架构、IPC 文档                    |
| 设置弹窗分区                         | `desktop/src/renderer/src/components/settings/`（`settingsSections.ts`、各 `*Section.vue`、`ui/`）                                    | 用户手册首页的设置分区表、相关用户手册、扩展指南                                   |
| 外壳、路由、侧栏、快捷键或通知       | `renderer/src/router.ts`、`components/shell/`、`components/sidebar/`、`components/pages/`、`shortcuts.ts`、`runtime/notifications.ts` | 用户手册首页的侧栏入口表、Chat/Build、自动化手册、工具手册、架构总览、扩展指南     |
| 右侧工作台、环境信息卡或内置浏览器   | `components/workspace/`、`components/conversation/environment/`、`desktop/src/main/browser-view*.ts`、`desktop-capability-ipc.ts`     | Chat/Build、诊断、架构总览、IPC 文档、扩展指南、Changelog                          |
| 电脑操作驱动、授权、凭据或浏览器配对 | `harness/computer-use/`、`desktop/src/main/computer-use/`、`desktop/extension/`、`desktop/native/`、电脑操作设置页                    | 电脑操作手册、诊断、权限架构、IPC 文档、存储架构、Changelog                        |
| ToolCatalog 工具或 Pull Request 查询 | `environment/tool-catalog.json`、`environment/catalog.ts`、`workspace/pull-request-browser.ts`、`components/pages/pulls/`             | Chat/Build、诊断、IPC 文档、[ToolCatalog 发布审核](release/tool-catalog-review.md) |
| Release workflow                     | `.github/workflows/release*.yml` 与发布脚本                                                                                           | Preview/Stable 手册、安全说明、README                                              |
| 安全边界                             | IPC trust、沙箱与审批、network/store policy                                                                                           | SECURITY、用户安全说明、架构文档                                                   |

## 写作规则

- 先写用户做什么，再写限制和内部原因。
- 首次出现的界面英文名给出中文解释，例如“Build（项目工作）”。
- 不使用“强大、无缝、革命性、全自动”等无法验证的词。
- Active 文档不写测试数量、当前 commit、固定 Preview 版本或容易过期的时间判断。
- 代码标识、路径和配置 key 保留英文原文；普通说明以中文为主。
- 不把存在 store/service 的基础设施描述成已经开放的产品入口。
- 不复制大段 schema。用户文档解释稳定字段，完整结构留在代码和示例配置。
- 安全绕过步骤只允许出现在专用安全说明中，并且必须保留官方系统防护。

## 更新流程

1. 先确定文档状态和读者，不把个人实施过程写入公共文档。
2. 对照上表找到事实源，确认当前入口、默认值、失败语义和数据位置。
3. 更新所有受影响的 Active 文档；路径变化同时修正 README、开发指南和引用脚本。
4. 新增当前文档时，把入口加入 [文档中心](README.md)。个人计划、审计和研究材料不加入公共导航。
5. 运行格式、链接和相关产品测试；涉及 Release 文案时运行对应 release test。
6. 在 review 中逐项核对下面的验收清单。

## 人工验收清单

- [ ] 文档状态、读者、核验日期和事实源准确。
- [ ] 所有相对链接和图片路径存在，目录锚点可以跳转。
- [ ] `docs/` 中不存在白名单之外的已跟踪目录，公共文档没有链接本地私有材料。
- [ ] 命令、配置 key、路径和界面入口与当前代码一致。
- [ ] 当前能力、预览能力和基础设施没有与个人实施过程混写。
- [ ] 没有新增固定 Preview 版本、测试数量或退役 Python 主链路。
- [ ] 外部链接只在本次修改涉及的页面逐个验证，不因网络波动做全库阻断。
- [ ] `npm run format:check` 和 `git diff --check` 通过。
- [ ] 相关测试通过；最终提交只包含本次文档机制需要的文件。

## 公共和私有文档边界

公共仓库只保存帮助用户使用产品、解释当前架构、指导源码开发或执行发布流程的稳定文档。以下材料属于个人开发过程，必须写入 `.gitignore` 覆盖的本地目录，不能被 Git 跟踪，也不能成为公共文档的事实源：

- 多步骤任务计划、spec、progress JSON、检查脚本和阶段 receipt；
- 日期化审计、临时诊断、个人 roadmap 和未确认的 backlog；
- 临时研究、摘录、方案对照和仅对本机有意义的笔记；
- 已结束迁移的逐项对账、开发过程复盘和仅对本机有意义的记录。

个人材料统一使用仓库根目录的 `private-docs/`，与公开 `docs/` 完全分离。推荐按 `plans/`、`specs/`、`progress/`、`audit/`、`diagnostics/`、`research/`、`roadmap/` 和 `archive/` 分类。为兼容旧工具，`docs/private/`、`docs/superpowers/`、`docs/archive/`、`docs/audit/`、`docs/research/`、`docs/diagnostics/`、`docs/roadmap/`、`docs/qa/`、`docs/plans/`、`docs/specs/`、`docs/design/`、`docs/tasks/` 和 `docs/migration/` 也由仓库 `.gitignore` 保护，但不应继续作为写入目标。

如果个人材料中形成了需要公开维护的结论，应重新撰写为不依赖过程上下文的用户说明、当前架构、开发指南或发布手册，并加入[文档中心](README.md)。不要直接公开原始计划或研究记录。
