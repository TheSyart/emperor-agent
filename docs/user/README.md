# Emperor Agent 用户手册

> 文档状态：Active<br>
> 面向读者：安装包用户、首次使用者<br>
> 最后核验：2026-09-22<br>
> 事实源：当前桌面路由、`desktop/src/renderer/src/components/settings/settingsSections.ts` 与各设置分区、Composer 与 CoreApi 用户入口

这组文档按实际任务组织。你不需要先理解 CoreApi、runtime event 或磁盘 store。

## 推荐阅读顺序

1. [首次使用](getting-started.md)：安装、模型配置、第一次 Chat 或 Build。
2. [Chat 与 Build](chat-build.md)：会话、项目绑定、斜杠命令和上下文边界。
3. [Plan 与 Goal](plan-goal.md)：权限预设、先规划再执行和持续推进目标。
4. [模型、记忆与附件](models-memory-attachments.md)：数据怎样进入模型和怎样落盘。
5. [Tools、Skills 与 MCP](tools-skills-mcp.md)：扩展 Agent 可以调用的能力。
6. [自动化与 Hooks](automation-collaboration.md)：Scheduler、Hooks、Watchlist 和桌宠。
7. [诊断与排障](diagnostics-troubleshooting.md)：无法启动、模型失败或状态不一致时从哪里查。

## 设置弹窗

点击左侧会话栏底部的“设置”打开设置弹窗。左侧导航列出下表中的分区，右上角是当前分区的操作，例如刷新、「添加模型」「新增」或「安装」。

| 分区      | 用途                                                                         | 详细说明                                                         |
| --------- | ---------------------------------------------------------------------------- | ---------------------------------------------------------------- |
| 常规      | 运行状态、当前模型、已绑定项目数；外观（浅色 / 深色 / 跟随系统）；已归档对话 | [Chat 与 Build](chat-build.md#会话操作)                          |
| 模型      | 模型配置卡片、连通测试、执行与成本策略                                       | [模型、记忆与附件](models-memory-attachments.md#模型配置)        |
| 插件      | 安装、启用、停用和卸载 Plugin                                                | [Tools、Skills 与 MCP](tools-skills-mcp.md#plugins)              |
| Skills    | 浏览、导入、编辑和删除 Skill，查看不合格的 Skill                             | [Tools、Skills 与 MCP](tools-skills-mcp.md#skills)               |
| MCP       | 粘贴或填写配置添加 server，启停、删除和编辑原始配置                          | [Tools、Skills 与 MCP](tools-skills-mcp.md#mcp)                  |
| Hooks     | “配置 / 测试 / 审计”三个标签                                                 | [Scheduler、Hooks 与桌宠](automation-collaboration.md#hooks)     |
| 工具      | 当前注册给 Agent 的全部工具和参数                                            | [Tools、Skills 与 MCP](tools-skills-mcp.md#tools)                |
| Scheduler | 定时任务卡片、运行历史和服务汇总                                             | [Scheduler、Hooks 与桌宠](automation-collaboration.md#scheduler) |
| 记忆      | 上下文概览，以及“长期 / 用户档案 / 情景 / Watchlist / 版本”                  | [模型、记忆与附件](models-memory-attachments.md#记忆层)          |
| 用量      | Token 统计、活跃度热力图、趋势、模型排名和缓存                               | [诊断与排障](diagnostics-troubleshooting.md#常用状态入口)        |
| 桌宠      | 启用或关闭 companion，预览动画                                               | [Scheduler、Hooks 与桌宠](automation-collaboration.md)           |
| 配置      | 编辑用户档案 `memory/profile/USER.local.md`，开始或重新开始档案访谈          | [模型、记忆与附件](models-memory-attachments.md#记忆层)          |
| 诊断      | 服务、路径、环境工具、配置和上下文分组                                       | [诊断与排障](diagnostics-troubleshooting.md)                     |

## 使用前需要知道的边界

- Emperor Agent 是本地单用户 Electron 应用，不是多人服务端。
- 本地数据默认保存在 Emperor Home（`~/.emperor`），但模型请求和被调用的联网工具仍可能访问外部服务。
- 当前公开安装包属于未签名 Preview。安装前阅读[安全说明](../release/unsigned-preview-notice.md)。
- Preview 能力会保留明确限制。界面里存在组件或底层 service，不等于已经开放完整入口。
- Agent 的文件写入和命令执行受当前权限预设（`read-only`、`workspace-write`、`danger-full-access`）约束；在前两种预设下，超出范围的操作需要你逐次批准。
- 默认没有内置网页搜索或网页抓取工具；需要联网时通过 MCP、Skill 或命令完成，相关内容会离开本机。

产品首页见 [README](../../README.md)，开发者入口见 [开发指南](../development/README.md)。
