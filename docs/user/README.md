# Emperor Agent 用户手册

> 文档状态：Active<br>
> 面向读者：安装包用户、首次使用者<br>
> 最后核验：2026-10-19<br>
> 事实源：`desktop/src/renderer/src/router.ts`、`desktop/src/renderer/src/components/sidebar/sidebarNav.ts`、`desktop/src/renderer/src/components/settings/settingsSections.ts` 与各设置分区（含 `ComputerUseSection.vue`）、Composer 与 CoreApi 用户入口

这组文档按实际任务组织。你不需要先理解 CoreApi、runtime event 或磁盘 store。

## 推荐阅读顺序

1. [首次使用](getting-started.md)：安装、模型配置、第一次 Chat 或 Build。
2. [Chat 与 Build](chat-build.md)：界面布局、会话、项目绑定、右侧工作台、斜杠命令和上下文边界。
3. [Plan 与 Goal](plan-goal.md)：权限预设、先规划再执行和持续推进目标。
4. [模型、记忆与附件](models-memory-attachments.md)：数据怎样进入模型和怎样落盘。
5. [Tools、Skills 与 MCP](tools-skills-mcp.md)：扩展 Agent 可以调用的能力。
6. [定时任务、Hooks 与桌宠](automation-collaboration.md)：定时任务、Hooks、Watchlist 和桌宠。
7. [电脑操作（实验）](computer-use.md)：受控浏览器、macOS 桌面、Chrome/Edge 连接、凭据，以及怎样让 Agent 停下。
   - 自己浏览网页、管理下载与导入登录，见 [浏览器设置与数据](chat-build.md#浏览器设置与数据)。
   - 输入框麦克风与本机识别，见 [语音听写](chat-build.md#语音听写)。
8. [诊断与排障](diagnostics-troubleshooting.md)：无法启动、模型失败或状态不一致时从哪里查。

## 侧栏入口

左侧会话栏从上到下依次是：

- 收起按钮与后退 / 前进；
- Emperor 标志与名称、搜索对话和通知铃铛；
- 「新对话」（右侧的 `+` 在项目中新建会话），以及四个整页入口：

| 入口         | 用途                                                                    | 详细说明                                                       |
| ------------ | ----------------------------------------------------------------------- | -------------------------------------------------------------- |
| Pull Request | 通过本机 GitHub CLI 只读浏览 PR；启用 GitHub 插件后还可查看 Issue 和 CI | [Chat 与 Build](chat-build.md#pull-request)                    |
| 定时任务     | 创建、编辑、暂停、恢复、立即运行和删除定时任务                          | [定时任务、Hooks 与桌宠](automation-collaboration.md#定时任务) |
| 能力         | 插件 / Skills / MCP / 工具四个标签：安装、导入、启停、删除和查看工具    | [Tools、Skills 与 MCP](tools-skills-mcp.md)                    |
| 探索         | 应用内置的精选 Skills 与 MCP server，安装前先预览                       | [Tools、Skills 与 MCP](tools-skills-mcp.md#探索)               |

再往下是「置顶」「项目」「对话」三组会话，底部是「设置」和明暗切换按钮（跟随系统在「设置 › 常规 › 外观」中选择）。侧栏和会话操作见 [Chat 与 Build](chat-build.md#侧栏与会话操作)。

## 设置弹窗

点击侧栏底部的「设置」打开设置弹窗。左侧导航分四组：「常规」，「智能」（模型、子智能体、记忆），「操控」（电脑操作、浏览器、语音），「系统」（用量、高级）。右上角是当前分区的操作，例如「添加模型」或「保存」；会自己刷新的分区（记忆、电脑操作）没有刷新按钮。分区里带「›」的行点开是二级页，标题变成「分区 › 页面」，点分区名回到上一级。

编辑中的内容（长期记忆、用户档案、Hooks 的 `hooks.json`、模型编辑、能力 › MCP 的 JSON）没有保存时，关闭弹窗、按 Esc、点遮罩、切换分区或二级页都会先问「放弃未保存的修改？」：选「放弃」才离开，「继续编辑」留在原处。后台刷新（例如一轮对话结束后记忆重新读取）只更新没有改过的草稿。

| 分区     | 用途                                                                                                                                                                                               | 详细说明                                                  |
| -------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------- |
| 常规     | 外观（主题、桌宠开关）；会话（新会话的权限、处理过程、网页链接、网站图标）；开发者（显示轨迹、显示系统步骤，默认都关闭）；「已归档对话」二级页（归档的对话和最近删除，删除的保留 30 天）           | [Chat 与 Build](chat-build.md#侧栏与会话操作)             |
| 模型     | 模型配置卡片、连通测试、执行与成本策略                                                                                                                                                             | [模型、记忆与附件](models-memory-attachments.md#模型配置) |
| 子智能体 | 本地子智能体、Claude Code、Codex 三个执行器与派工规则                                                                                                                                              | [定时任务、Hooks 与桌宠](automation-collaboration.md)     |
| 记忆     | 上下文概览，「长期记忆」「用户档案」两个编辑器；编辑器上的「历史」打开版本列表；右上角「更多」里是情景记忆和 Watchlist                                                                             | [模型、记忆与附件](models-memory-attachments.md#记忆层)   |
| 电脑操作 | 提醒卡（缺权限、Helper 未连接时）；总开关；任意应用、Chrome 和 Edge 两个驱动（Chrome 和 Edge 二级页：安装扩展、连接与配对、浏览器权限、智能体权限）；系统权限；截图                                | [电脑操作（实验）](computer-use.md)                       |
| 浏览器   | 让 Emperor 控制内置浏览器；本地 URL 打开位置、完整网址、浏览数据与浏览历史；从 Chrome/Edge 导入；密码管理器、登录状态；下载位置、下载前询问、下载历史记录与保留时间；网站设置                      | [Chat 与 Build](chat-build.md#浏览器设置与数据)           |
| 语音     | 麦克风与语音识别权限、麦克风、识别语言与听写快捷键；听写组件不可用时说明原因（macOS）                                                                                                              | [Chat 与 Build](chat-build.md#语音听写)                   |
| 用量     | Token 指标与趋势；「详细」二级页里是活跃度热力图、模型排名和缓存                                                                                                                                   | [诊断与排障](diagnostics-troubleshooting.md#常用状态入口) |
| 高级     | 网络工具：网页读取（`web_fetch`）与网页搜索（`web_search`）两个开关；「Hooks」二级页（配置 / 测试 / 审计）；「诊断」二级页（结论、需要关注的项目，可折叠的运行时、环境工具、桌面、存储路径和配置） | [Tools、Skills 与 MCP](tools-skills-mcp.md#tools)         |

定时任务、插件、Skills、MCP 和工具已从设置弹窗移到上面的整页。旧的 `?settings=scheduler`、`?settings=plugins`、`?settings=skills`、`?settings=mcp`、`?settings=tools` 链接以及 `/plugins/*`、`/skills/<名称>`、`/mcp`、`/tools` 会自动跳到对应页面；原「配置」分区并入“记忆 › 用户档案”，`?settings=configs` 会打开「记忆」。原来单独的「Hooks」「诊断」现在是「高级」的二级页，「桌宠」是「常规 › 外观」里的开关；`?settings=hooks`、`?settings=diagnostics`、`?settings=pet` 和 `/pet` 会打开新位置。

## 使用前需要知道的边界

- Emperor Agent 是本地单用户 Electron 应用，不是多人服务端。
- 本地数据默认保存在 Emperor Home（`~/.emperor`），但模型请求和被调用的联网工具仍可能访问外部服务。
- 当前公开安装包属于未签名 Preview。安装前阅读[安全说明](../release/unsigned-preview-notice.md)。
- Preview 能力会保留明确限制。界面里存在组件或底层 service，不等于已经开放完整入口。
- Agent 的文件写入和命令执行受当前权限预设（`read-only`、`workspace-write`、`danger-full-access`）约束；在前两种预设下，超出范围的操作需要你逐次批准。
- Agent 默认可以用 `web_fetch` 读取公开网页；模型使用 DeepSeek 官方 API 时还可以用 `web_search` 搜索。网址和搜索词会离开本机，两者都可以在「设置 › 高级 › 网络工具」关闭，见 [Tools、Skills 与 MCP](tools-skills-mcp.md#tools)。

产品首页见 [README](../../README.md)，开发者入口见 [开发指南](../development/README.md)。
