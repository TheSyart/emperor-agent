# 更新日志

本文件记录 Emperor Agent 的用户可感知变化，格式参考 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/)。当前项目尚未在这里固定公开版本段；待版本正式发布时，再把 `Unreleased` 内容移动到带日期的版本标题下。

## [Unreleased]

### Added

- 新增默认关闭的“电脑操作（实验）”：受控内置浏览器、profile 与网站权限、句柄式凭据代填、macOS Helper 权限与窗口观察，以及需扩展配对的 Chrome 连接；设置页逐驱动显示当前能力与缺失项。
- 电脑操作的 macOS 桌面驱动可以执行动作：默认在后台按下控件、写入文本框、执行菜单命令并向原生 App 发送按键，不移动鼠标、不切换前台；被控窗口显示系统紫色共享标记，工作台“电脑”面板显示实时缩略图，菜单栏“停止共享”等同接管；点击和拖动的落点显示虚拟指针。只能在前台完成的步骤（Electron 应用的按键与菜单、原生 App 的撤销等命令、坐标点击）在“持续允许”下直接切到前台并自动交还，逐项授权时每个任务先询问一次。
- 电脑操作设置新增：各驱动单独开关、可修改的急停快捷键（程序坞菜单与快捷键被占用时的菜单栏图标也能停止）、授权逐项收窄、截图配额与一键清除、下载保留时间，以及“保护 / 高风险 / 敏感”三类自定义应用名单；Chrome/Edge 连接可在安装版设置中一键登记。
- Agent 下载的文件可从工具行“移到工作区”或“另存为…”，重启后仍可在访达中显示；会话记录写明下载地址、文件类型与发起页面。
- 更换 Agent 内核：每个会话的对话、工具调用、审批、Plan、Goal、压缩与子代理委派都写入同一份 append-only 的 `sessions/<id>/log.jsonl`，加载时自动做崩溃修复。首次启动新内核时，旧会话目录整体移到 `sessions.legacy-<时间戳>/`，不会删除。
- 桌面端改为左侧会话栏、中间对话、右侧工作台的三栏布局；新增「轨迹」视图，按时间线查看每一步的模型调用、工具调用与耗时，选中的记录在轨迹右侧的「详情」列中查看；子代理作为独立的子会话打开，带返回父会话的路径导航。
- 增加文件系统 Skills 与受管 Plugins：裸 Skill 无需 registry，Plugin 提供来源、版本、启用、更新和卸载语义，外部 CLI 通过普通命令与独立 probe 验证。
- 增加与 Skill 无关的网络调研证据链：外部工具只登记 candidate，Core `web_fetch` 的 2xx 正文才能升级 verified source；最终答复执行逐事实单元引用校验和隔离 grounding review。
- 精简 Core 权威 Slash command 平台为九个普通用户命令；`/new` 通过可恢复事务创建真正无旧会话历史的新上下文，每个 active Skill 直接注册自己的斜杠 token，并在任务完成或菜单打开时自动刷新。
- 增加右侧工作台：启动器与「审查」（Git Review）、「终端」（应用内系统 Terminal）、「文件」（只读浏览/预览）、「浏览器」四个面板，每个面板有快捷键；前三个需要 Build 项目，浏览器任何会话都可用。
- 增加结构化 Git 仓库身份、状态/Diff、worktree、操作凭据和 PR 工作流；子代理隔离 worktree 复用同一安全管理器。
- 主 Agent 移除固定 20/56 轮终止与模型续跑评估，改用 6/12 次无进展确定性看门狗；工具调用按真实模型批次折叠。
- 增加对话右上角的「环境信息」卡：Build 会话显示变更、本地 / worktree、分支、提交或推送与「比较分支」，所有会话显示计划进度、子智能体、后台任务和来源；宽屏时对话让出位置，窄屏时覆盖显示。「文件」面板支持只读多标签、Markdown 预览、行号、右侧懒加载文件树和「筛选文件…」。
- 增加源码级 Headless ACP V1 stdio operator preview，复用 TypeScript CoreApi、持久 Build 会话、runtime event 投影、请求去重与端到端取消。
- 增加默认关闭、由用户显式配置的模型 fallback 与每 Agent 轮成本上限；支持用户单价、成本完整性和跨模型 reasoning/signature 清理。
- 增加 Goal 长任务生命周期：Contract、Plan bridge、Evidence ledger、Completion Gate、Pause / Resume / Cancel、重启恢复与诊断。
- 增加 MCP 工具结果的不可信标记和协议 `isError` 传递。
- 增加 token 使用热日志的按月归档，同时保持聚合统计覆盖热数据与归档数据。
- 建立中文优先的文档中心、完整用户手册、当前架构与扩展指南，并为发布、安全、归档和文档维护定义统一机制。
- 能力页的 MCP 标签支持粘贴 Claude Desktop、Cursor、VS Code 等客户端的 MCP 配置或用表单添加 server，导入前预览新增、覆盖与跳过；新增 Streamable HTTP（`http`）传输，首次连接失败时回退到 SSE；每个 server 可以单独启停和删除。
- 能力页的 Skills 标签支持粘贴 `SKILL.md`、导入本地文件夹、zip 或 GitHub 链接，并可打开个人或项目 Skills 文件夹；列出不合格的 Skill 及原因，只读 Skill 可以复制为个人 Skill，文件夹变化后列表自动刷新。
- 增加 `skill_manage` 与 `mcp_config` 工具，让 Agent 管理 Skills 和 Emperor 自己的 MCP 配置；写入跟随权限预设，`danger-full-access` 以外每次写入都需要批准。
- 能力页支持从本地文件夹或 zip 安装 Plugin；从 URL 安装的 Plugin 在签名验证通过前不会激活。
- 侧栏重做：顶部是收起与后退 / 前进，Emperor 标志、搜索和通知铃铛；「新对话」下新增 Pull Request、定时任务、能力、探索四个整页入口；底部是「设置」和明暗切换按钮；会话可以置顶，置顶组内可调整顺序。
- 增加应用内通知：定时任务运行结果、其他会话中等待回答的问题 / 审批 / 计划、不在屏幕上的会话完成的回复，以及 Git 操作回执；点击跳到对应会话、定时任务页或「审查」。
- 增加定时任务页：搜索、“全部 / 已开启 / 已暂停 / 已完成”标签、「创建 ▾」中的每日摘要与每周回顾模板、行菜单（立即运行 / 暂停或恢复 / 删除）和任务编辑对话框。
- 增加能力页（`/capabilities`），把插件、Skills、MCP 和工具合并为四个标签；旧的 `/plugins/*`、`/tools` 和 `?settings=tools` 链接自动跳转。
- 增加 Pull Request 页：通过本机 GitHub CLI 只读浏览与你相关的打开状态 PR（全部 / 正在审查 / 由我创建），支持搜索、草稿 / 检查失败 / 需要修改筛选和按仓库分组，查看描述、检查、改动文件和 diff，并可在 GitHub 打开。
- 增加探索页：随应用发布的一小组精选 Skills（anthropics/skills）和 MCP server，安装前走原有的预览与确认流程。
- 签名工具目录新增可选的 GitHub CLI（`gh`，要求 2.40.0 及以上），通过探测使用本机已安装的版本，并在诊断的环境工具中显示状态；安装和 `gh auth login` 由你自行完成。「审查」中的 PR 预览、发布、转 Ready、合并和关闭现在会使用它，不再总是提示没有可用的 GitHub CLI。
- 增加输入框上方的变更汇总条（Build 会话工作区的 Git 改动总计，点击打开「审查」）和对话左侧的轮次刻度。
- 增加快捷键：审查 ⌃⇧G、终端 `` ⌃` ``、文件 ⌘P、浏览器 ⌘T、开关工作台 ⌥⌘B、开关环境信息 ⌥⌘E、开关侧栏 ⌘B、新对话 ⌘N、搜索 ⌘K、后退 / 前进 ⌘[ / ⌘]；Windows / Linux 上 ⌘ 换成 Ctrl。

### Changed

- 设置删除与「记忆 › 用户档案」重复的「配置」分区，`?settings=configs` 改为打开「记忆」。诊断页改为概览加可折叠分组：顶部汇总状态、各组正常计数和需要关注的项目，标签改为中文，隐藏 Core 未返回数据的行，修正工作区范围的误报，并新增「复制报告」。
- 移除 Team 多 Agent 协作功能；需要并行处理时使用子代理。
- Prompt 动态注入产品、surface、main/plan/subagent 角色、真实 Skill 根、Plugin 解析、受管环境和 host/sandbox 边界；Skill、Plugin 与外部 CLI 必须分别报告。
- 模型工具统一为 `Skill` 按需加载；不再暴露 `load_skill`、`install_skill` 或 `manage_environment`。Skills 页面变为解析结果 inventory，版本化安装移动到用户发起的 Plugins 页面。
- Chat 移除顶部“对话 / 正在办差 · 模型”标题栏；右侧工作台可在 360–960px 之间拖动，窗口变窄时先缩窄、再自动收起，侧栏、工作台、环境信息卡和「详情」列的布局在重启后恢复。
- 删除已退役的桥接接入模块及其 API、运行事件、诊断和界面投影；旧安装私有文件不会被读取、迁移或自动删除。
- 模型配置统一为 schema v2：可保存多个标准接口模型，全局只激活一个。
- Renderer 的映射 Core API 调用统一通过 `api/http.ts` 的桌面 Core bridge；普通浏览器不是受支持运行模式。
- Core runtime event 类型与 renderer 投影共用明确契约。
- Composer 的模型 / 模式菜单逻辑收敛到共享 helper。
- Chat 消息列表滚动监听改为跟踪最新可见消息签名，避免深度监听完整时间线。
- README 改为面向普通用户的产品入口，并把详细操作、架构、发布与维护内容分层到文档中心。
- 设置弹窗的全部分区改用统一的设置组件重写：记忆按“长期 / 用户档案 / 情景 / Watchlist / 版本”切换，用量提供活跃度、趋势、模型和缓存视图，Hooks 分为配置 / 测试 / 审计，常规外观支持跟随系统。
- Skill 校验放宽为只检查 `SKILL.md` 及其引用的文件，名称以 frontmatter 为准；项目 Skills 在对应 Build 会话中可以写入，每个项目使用独立的 Skill 目录。`skills.previewInstall`、`skills.confirmInstall` 与 `skills.package` 已移除，Skill 安装统一使用 `skills.import`。
- 对话中工具行的 Inspect 改为跳到「轨迹」并在轨迹右侧的「详情」列中定位该调用；「详情」列可拖宽、收起并记住宽度。原右侧详情栏及其 Inspect / Environment 标签移除：子代理在子会话中查看和停止；后台命令和工作流的输出查看与停止移到「环境信息」卡的「后台任务」中（展开后每个任务有「输出」和「停止」，停止工作流前会确认）。
- 定时任务、插件、Skills 和 MCP 从设置弹窗移到整页，设置弹窗保留常规、模型、Hooks、工具、记忆、用量、桌宠、配置和诊断；旧的 `?settings=scheduler|plugins|skills|mcp`、`/skills/<名称>` 与 `/mcp` 链接会跳到对应页面。

### Fixed

- 桌面凭据代填结果无法确认时，仍禁止该目标继续截图；桌面动作可用时，设置页准确标为“可交互（实验）”。
- 修复新建对话后发送的消息落到之前某个历史会话的问题；Core 不再为缺少会话 id 的请求猜测目标会话。
- 修复新对话发出第一条消息后，主画面显示「没有找到这个会话」、需要到侧栏再点一次的问题；在新对话里执行斜杠命令同样会直接进入新会话。
- 修复 Agent 新增 MCP 时写进其他客户端配置的问题：MCP 只通过 Emperor 自己的 `mcp_config.json` 管理。
- 修复上次启动被强杀或断电后，残留的启动锁导致应用一直报 `installation_lock_busy` 无法启动的问题。
- write / edit 工具的原子写暂存文件改放在 Emperor Home，不再短暂出现在项目目录和 `git status` 里；在设置中打开项目 Skills 文件夹也不再为此在项目里创建目录。
- 修复 `packages/core/src/memory/history.ts` 源码签名中的二进制 NUL 字节。
- 完成 TypeScript / Electron 迁移审计后的主线加固与 parity 收尾。
- 修复进程 exit 0、搜索线索和任务完成被混为一谈的问题；重复 URL、空输出、错误页和等价命令不再重置无进展保护。
- 修复网络调研未校验草稿提前进入 UI/历史的问题。

### Security

- Git、Files 和 Terminal 由 Core 按 Build session 所有权授权；Renderer 不获得 Node/fs/shell，Git mutation 使用 revision/确认，Files 拒绝 traversal/symlink escape，Terminal 高频字节流不进入聊天或持久事件。
- Electron 主界面与桌宠现在显式运行在 renderer sandbox 中；preload 改为受构建/打包审计的最小 CommonJS，桌宠不再直接读取文件系统，packaged smoke 会真实验证 Core bridge 与受管附件协议。
- 明确 MCP、Web 与外部消息是不可信输入，Goal 完成态只能由 Core Completion Gate 提交。
- 网络调研回复只有在逐项引用本轮 verified source 并通过隔离复核后才发布；核验事件不包含 URL、正文、命令、本机路径或 reviewer prompt。
- 发布文档区分当前未签名 Preview 与尚未启用的受信 Stable 流程。
- 右侧工作台的内置浏览器运行在独立的 sandboxed `WebContentsView` 与不落盘的内存分区中，只加载你在地址栏提交的 `http(s)` 地址，拒绝权限请求、下载和应用内弹窗，关闭后清空浏览数据；旧的内嵌预览通道与 `previewId` 授权路径已删除。
- 电脑操作：页面改成明文的密码框、普通输入框里的验证码，以及代填凭据后整页的输入值都不再出现在 Agent 的观察结果中；跨源 iframe 内的动作按 iframe 自己的网站授权；接管期间弹出的窗口保持由你控制；以点结尾的可执行文件名不再绕过下载拦截；受限 Shell 不能读取 `~/.emperor/browser/`；授权记录损坏时明确显示为已暂停。
- `gh` 只以固定参数调用，仓库、PR 编号和搜索文本先经校验再作为单个参数传入；Emperor 不向 `gh` 传递 `GH_TOKEN`、`GITHUB_TOKEN` 等 token 环境变量，Pull Request 页不执行任何写操作。
