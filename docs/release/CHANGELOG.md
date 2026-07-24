# 更新日志

本文件记录 Emperor Agent 的用户可感知变化，格式参考 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/)。当前项目尚未在这里固定公开版本段；待版本正式发布时，再把 `Unreleased` 内容移动到带日期的版本标题下。

## [Unreleased]

### Added

- 增加 Chat 右侧项目工作台：Environment 聚合状态、Git Review、应用内系统 Terminal 和只读 Files 浏览/预览。
- 增加每个用户 turn 的净变更账本：执行中实时显示文件数与增删行，最终 Changes 卡和回复共享同一 Core 事实源。
- 增加结构化 Git 仓库身份、状态/Diff、worktree、操作凭据和 PR 工作流；子代理隔离 worktree 复用同一安全管理器。
- 主 Agent 移除固定 20/56 轮终止与模型续跑评估，改用 6/12 次无进展确定性看门狗；工具调用按真实模型批次折叠。
- 右侧界面拆为 Environment 浮卡与宽工作区启动器，Files 支持只读多标签、Markdown 预览、行号和右侧懒加载树。
- 增加源码级 Headless ACP V1 stdio operator preview，复用 TypeScript CoreApi、持久 Build 会话、runtime event 投影、请求去重与端到端取消。
- 增加默认关闭、由用户显式配置的模型 fallback 与每 Agent 轮成本上限；支持用户单价、成本完整性和跨模型 reasoning/signature 清理。
- 增加 Goal 长任务生命周期：Contract、Plan bridge、Evidence ledger、Completion Gate、Pause / Resume / Cancel、重启恢复与诊断。
- 增加 MCP 工具结果的不可信标记和协议 `isError` 传递。
- 增加 token 使用热日志的按月归档，同时保持聚合统计覆盖热数据与归档数据。
- 建立中文优先的文档中心、完整用户手册、当前架构与扩展指南，并为发布、安全、归档和文档维护定义统一机制。

### Changed

- Chat 移除顶部“对话 / 正在办差 · 模型”标题栏；Environment 在桌面宽屏常驻，Review、Terminal 或 Files 以 520–960px 宽工作区原位替代，并支持窄屏抽屉/全屏和布局状态恢复。
- 删除已退役的桥接接入模块及其 API、运行事件、诊断和界面投影；旧安装私有文件不会被读取、迁移或自动删除。
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

- Git、Files 和 Terminal 由 Core 按 Build session 所有权授权；Renderer 不获得 Node/fs/shell，Git mutation 使用 revision/确认，Files 拒绝 traversal/symlink escape，Terminal 高频字节流不进入聊天或持久事件。
- Electron 主界面与桌宠现在显式运行在 renderer sandbox 中；preload 改为受构建/打包审计的最小 CommonJS，桌宠不再直接读取文件系统，packaged smoke 会真实验证 Core bridge 与受管附件协议。
- 明确 MCP、Web 与外部消息是不可信输入，Goal 完成态只能由 Core Completion Gate 提交。
- 发布文档区分当前未签名 Preview 与尚未启用的受信 Stable 流程。
