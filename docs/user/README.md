# Emperor Agent 用户手册

> 文档状态：Active<br>
> 面向读者：安装包用户、首次使用者<br>
> 最后核验：2026-08-12<br>
> 事实源：当前桌面路由、设置页、Composer 与 CoreApi 用户入口

这组文档按实际任务组织。你不需要先理解 CoreApi、runtime event 或磁盘 store。

## 推荐阅读顺序

1. [首次使用](getting-started.md)：安装、模型配置、第一次 Chat 或 Build。
2. [Chat 与 Build](chat-build.md)：会话、项目绑定、斜杠命令和上下文边界。
3. [Plan 与 Goal](plan-goal.md)：权限模式、先规划再执行和长任务验收。
4. [模型、记忆与附件](models-memory-attachments.md)：数据怎样进入模型和怎样落盘。
5. [Tools、Skills 与 MCP](tools-skills-mcp.md)：扩展 Agent 可以调用的能力。
6. [自动化与协作](automation-collaboration.md)：Scheduler、Team、Hooks 和桌宠。
7. [诊断与排障](diagnostics-troubleshooting.md)：无法启动、模型失败或状态不一致时从哪里查。

## 使用前需要知道的边界

- Emperor Agent 是本地单用户 Electron 应用，不是多人服务端。
- 本地数据默认保存在 Emperor Home（`~/.emperor`），但模型请求和被调用的联网工具仍可能访问外部服务。
- 当前公开安装包属于未签名 Preview。安装前阅读[安全说明](../release/unsigned-preview-notice.md)。
- Preview 能力会保留明确限制。界面里存在组件或底层 service，不等于已经开放完整入口。
- Agent 的文件、命令和外部连接受权限模式、workspace policy 和 Core deny 约束。
- 网络调研只有在来源正文经 Core 验证、答复逐项引用并通过隔离复核后才会发布；如果来源不可用，产品会明确阻塞而不是补造事实或链接。

产品首页见 [README](../../README.md)，开发者入口见 [开发指南](../development/README.md)。
