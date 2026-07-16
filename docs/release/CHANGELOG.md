# 更新日志

本文件记录 Emperor Agent 的用户可感知变化，格式参考 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/)。当前项目尚未在这里固定公开版本段；待版本正式发布时，再把 `Unreleased` 内容移动到带日期的版本标题下。

## [Unreleased]

### Added

- 增加 Goal 长任务生命周期：Contract、Plan bridge、Evidence ledger、Completion Gate、Pause / Resume / Cancel、重启恢复与诊断。
- 增加 MCP 工具结果的不可信标记和协议 `isError` 传递。
- 增加 token 使用热日志的按月归档，同时保持聚合统计覆盖热数据与归档数据。
- 建立中文优先的文档中心、完整用户手册、当前架构与扩展指南，并为发布、安全、归档和文档维护定义统一机制。

### Changed

- 模型配置统一为 schema v2：可保存多个标准接口模型，全局只激活一个。
- Renderer 的映射 Core API 调用统一通过 `api/http.ts` 的桌面 Core bridge；普通浏览器不是受支持运行模式。
- Core runtime event 类型与 renderer 投影共用明确契约。
- Composer 的模型 / 模式菜单逻辑收敛到共享 helper。
- Chat 消息列表滚动监听改为跟踪最新可见消息签名，避免深度监听完整时间线。
- README 改为面向普通用户的产品入口，并把详细操作、架构、发布与维护内容分层到文档中心。

### Fixed

- 修复 `packages/core/src/memory/history.ts` 源码签名中的二进制 NUL 字节。
- 完成 TypeScript / Electron 迁移审计后的主线加固与 parity 收尾。

### Security

- 明确 MCP、Web 与外部消息是不可信输入，Goal 完成态只能由 Core Completion Gate 提交。
- 发布文档区分当前未签名 Preview 与尚未启用的受信 Stable 流程。
