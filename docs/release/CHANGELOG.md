# 更新日志

本文件记录 Emperor Agent 的用户可感知变化，格式参考 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/)。当前项目尚未在这里固定公开版本段；待版本正式发布时，再把 `Unreleased` 内容移动到带日期的版本标题下。

## [Unreleased]

### Added

- 增加 Emperor Home（默认 `~/.emperor`）、旧根原子迁移、state layout 防降级与独立首次启动恢复页。
- 增加文件系统 Skills 与受管 Plugins：裸 Skill 无需 registry，Plugin 提供来源、版本、启用、更新和卸载语义，外部 CLI 通过普通命令与独立 probe 验证。
- 增加与 Skill 无关的网络调研证据链：外部工具只登记 candidate，Core `web_fetch` 的 2xx 正文才能升级 verified source；最终答复执行逐事实单元引用校验和隔离 grounding review。
- 精简 Core 权威 Slash command 平台为九个普通用户命令；`/new` 通过可恢复事务创建真正无旧会话历史的新上下文，每个 active Skill 直接注册自己的斜杠 token，并在任务完成或菜单打开时自动刷新。
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
- 设置 → MCP 支持粘贴 Claude Desktop、Cursor、VS Code 等客户端的 MCP 配置或用表单添加 server，导入前预览新增、覆盖与跳过；新增 Streamable HTTP（`http`）传输，首次连接失败时回退到 SSE；每个 server 可以单独启停和删除。
- 设置 → Skills 支持粘贴 `SKILL.md`、导入本地文件夹、zip 或 GitHub 链接，并可打开个人或项目 Skills 文件夹；列出不合格的 Skill 及原因，只读 Skill 可以复制为个人 Skill，文件夹变化后列表自动刷新。
- 增加 `skill_manage` 与 `mcp_config` 工具，让 Agent 管理 Skills 和 Emperor 自己的 MCP 配置；写入跟随权限预设，`danger-full-access` 以外每次写入都需要批准。
- 设置 → 插件支持从本地文件夹或 zip 安装；从 URL 安装的 Plugin 在签名验证通过前不会激活。

### Changed

- Prompt 动态注入产品、surface、main/plan/subagent 角色、真实 Skill 根、Plugin 解析、受管环境和 host/sandbox 边界；Skill、Plugin 与外部 CLI 必须分别报告。
- 模型工具统一为 `Skill` 按需加载；不再暴露 `load_skill`、`install_skill` 或 `manage_environment`。Skills 页面变为解析结果 inventory，版本化安装移动到用户发起的 Plugins 页面。
- Chat 移除顶部“对话 / 正在办差 · 模型”标题栏；Environment 在桌面宽屏常驻，Review、Terminal 或 Files 以 520–960px 宽工作区原位替代，并支持窄屏抽屉/全屏和布局状态恢复。
- 删除已退役的桥接接入模块及其 API、运行事件、诊断和界面投影；旧安装私有文件不会被读取、迁移或自动删除。
- 模型配置统一为 schema v2：可保存多个标准接口模型，全局只激活一个。
- Renderer 的映射 Core API 调用统一通过 `api/http.ts` 的桌面 Core bridge；普通浏览器不是受支持运行模式。
- Core runtime event 类型与 renderer 投影共用明确契约。
- Composer 的模型 / 模式菜单逻辑收敛到共享 helper。
- Chat 消息列表滚动监听改为跟踪最新可见消息签名，避免深度监听完整时间线。
- README 改为面向普通用户的产品入口，并把详细操作、架构、发布与维护内容分层到文档中心。
- 设置弹窗的全部分区改用统一的设置组件重写：Scheduler 改为任务卡片并在卡片内编辑，记忆按“长期 / 用户档案 / 情景 / Watchlist / 版本”切换，用量提供活跃度、趋势、模型和缓存视图，Hooks 分为配置 / 测试 / 审计，常规外观支持跟随系统。
- Skill 校验放宽为只检查 `SKILL.md` 及其引用的文件，名称以 frontmatter 为准；项目 Skills 在对应 Build 会话中可以写入，每个项目使用独立的 Skill 目录。`skills.previewInstall`、`skills.confirmInstall` 与 `skills.package` 已移除，Skill 安装统一使用 `skills.import`。

### Fixed

- 修复 `packages/core/src/memory/history.ts` 源码签名中的二进制 NUL 字节。
- 完成 TypeScript / Electron 迁移审计后的主线加固与 parity 收尾。
- 修复进程 exit 0、搜索线索和任务完成被混为一谈的问题；重复 URL、空输出、错误页和等价命令不再重置无进展保护。
- 修复网络调研未校验草稿提前进入 UI/历史，以及纯调研命令错误生成零文件 partial Changes 卡的问题。

### Security

- Git、Files 和 Terminal 由 Core 按 Build session 所有权授权；Renderer 不获得 Node/fs/shell，Git mutation 使用 revision/确认，Files 拒绝 traversal/symlink escape，Terminal 高频字节流不进入聊天或持久事件。
- Electron 主界面与桌宠现在显式运行在 renderer sandbox 中；preload 改为受构建/打包审计的最小 CommonJS，桌宠不再直接读取文件系统，packaged smoke 会真实验证 Core bridge 与受管附件协议。
- 明确 MCP、Web 与外部消息是不可信输入，Goal 完成态只能由 Core Completion Gate 提交。
- 网络调研回复只有在逐项引用本轮 verified source 并通过隔离复核后才发布；核验事件不包含 URL、正文、命令、本机路径或 reviewer prompt。
- 发布文档区分当前未签名 Preview 与尚未启用的受信 Stable 流程。
