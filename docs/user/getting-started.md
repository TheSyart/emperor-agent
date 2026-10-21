# 首次使用

> 文档状态：Active<br>
> 面向读者：第一次安装和配置 Emperor Agent 的用户<br>
> 最后核验：2026-10-21<br>
> 事实源：GitHub Releases、模型设置页、`desktop/src/renderer/src/components/sidebar/`（新对话与项目会话入口）、`desktop/src/renderer/src/components/settings/updates/`、`packages/core/src/updates/`（检查更新）

## 1. 安装

1. 打开项目的 [GitHub Releases](https://github.com/TheSyart/emperor-agent/releases)。
2. 根据操作系统和 CPU 架构选择 macOS、Windows 或 Linux 安装包。
3. 当前公开包是未签名 Preview，不是 Stable。校验摘要、GitHub 构建来源和系统提示的方法见[未签名 Preview 安全说明](../release/unsigned-preview-notice.md)。
4. 安装并启动应用。安装包已经包含 Electron/Node runtime，不需要另外安装 Node.js 或 Python。首次启动会离线创建 Emperor Home、校验只读 runtime 并恢复中断的安装账本；正常完成时不显示额外向导。

如果首次启动进入恢复页，按稳定错误码处理：可以重试、打开 Emperor Home 或退出。布局版本过新表示当前应用版本不能安全写入该目录，应升级应用；不要手工降低 `installation.json` 的版本号。

没有公开安装包或不希望运行未签名版本时，可以按 [README 的源码运行说明](../../README.md#source) 启动开发版。

## 2. 添加并选择模型

点击侧栏底部的“设置”（或菜单栏「Emperor Agent › 偏好设置…」，⌘,）打开设置弹窗，进入“模型”分区，选择“添加模型”。设置只负责管理配置；保存后回到聊天输入框选择当前要使用的模型。

按下面的顺序填写：

1. 在供应商列表中选择 Provider。列表按国内厂商、海外厂商、聚合平台、本地部署和自定义分组，可以搜索；需要自定义兼容服务时选择 `Custom`。
2. 选择 `openai` 或 `anthropic` 协议。界面只会展示该 Provider 支持的协议。
3. 填写模型 ID、API Base 和 API Key。在已有供应商的卡片上点「添加模型」时，协议和 API Base 沿用该供应商已保存的模型，API Key 留空即沿用它已保存的 Key；改动协议或 API Base 后需要重新填写 Key。
4. 填写上下文窗口与最大输出 Token。两项都必须是正整数，并应使用服务商公布的限制。
5. 按需填写显示名称、reasoning effort 和能力覆盖。显示名称留空时各处自动使用并同步模型 ID；只有手工填写时才保存自定义别名。能力覆盖只在自动探测不准确时使用。
6. 保存配置并执行模型测试。需要切换模型时，在聊天输入框右侧打开模型选择器：第一层是「模型」和「思考强度」，点进「模型」后按供应商分组列出已保存的模型。

模型配置保存在 `stateRoot/model_config.json`，磁盘 schema 为 `schemaVersion: 2`。旧配置可以由兼容读取逻辑迁移，但当前界面和文档不再使用“主模型/次模型”双角色配置。

模型测试失败时先检查 Provider、协议、API Base 和模型 ID 是否匹配。HTTP 兼容不等于模型一定支持工具调用、视觉或 reasoning。

## 3. 创建第一条会话

### Chat：普通对话

点击侧栏的「新对话」（⌘N），输入问题并发送。Chat 使用用户档案、全局长期记忆和当前会话历史，不绑定项目目录；需要写文件时，它的工作目录是 Emperor Home 下的 `workspace/`。

### Build：项目工作

点击侧栏「项目」分组标题旁的 `+`，选择「使用现有文件夹」（或「新建空白项目」）并从本机选择项目文件夹；已绑定的项目列在「项目」分组里，项目行上的 `+` 在该项目中新建会话。Build 会把该目录作为 workspace，并读取项目中的 `AGENTS.md` / `CLAUDE.md`。项目私有记忆保存在全局 `stateRoot`，不会写回项目文件。

新建时界面先创建本地草稿；发送第一条消息后，Core 才会创建真实 session 并持久化。这意味着空白草稿不会留下无用会话目录。

## 4. 确认工作正常

完成下面四项即可确认基础链路可用：

- 在 Chat 发送一个不需要工具的问题并收到模型回复。
- 在 Composer 输入 `/`，确认菜单只显示核心 `Commands` 和当前可用 `Skills`。
- 输入 `/model`，确认可以选择当前会话使用的模型；已安装 Skill 应以自己的 token 出现，例如 `/agent-reach`。
- 创建 Build 后让 Agent 读取一个项目文件，确认路径属于刚才选择的 workspace。

如果模型回复正常但文件或命令被拒绝，先查看当前权限预设，而不是反复重试。新会话默认使用 `workspace-write`：可以写当前 workspace，超出范围时会弹出一次性批准。Shell 命令在 macOS（Seatbelt）和 Linux（bubblewrap）上受系统沙箱限制；其他平台没有沙箱后端，只有切换到 `danger-full-access` 后才能运行 Shell 命令。详见 [计划与目标](plan-goal.md) 和 [诊断与排障](diagnostics-troubleshooting.md)。

## 5. 数据与联网

会话、记忆、模型配置和附件保存在本机；默认 Emperor Home 是 `~/.emperor`。以下操作仍会把必要内容发送到外部：

- 调用已配置的模型 Provider；
- 使用远程 MCP，或调用会联网的 Skill；
- 运行会主动联网的本地命令、Hook 或 MCP server；
- 检查更新：向 GitHub 请求发布列表，可以关闭，见下面的[更新](#6-更新)。

不要把“本地运行”理解为完全离线。具体数据位置见 [模型、记忆与附件](models-memory-attachments.md)。

## 6. 更新

Emperor 的安装包没有签名，不能像签名应用那样自动替换自己。它会告诉你有新版本、替你下载并核对安装包，替换旧版本由你来做。

**检查**：启动 30 秒后和之后每 24 小时，Emperor 向 GitHub 请求一次发布列表，只比较同一渠道里更高的版本：Preview 版会看到更新的 Preview 和 Stable，Stable 版只看 Stable。请求里只有版本号这样的固定信息（`Emperor-Agent/0.2.0`），不带账号、令牌或设备标识。连不上 GitHub 时不会弹出任何提示，稍后自动重试，每 24 小时最多重试 3 次。不想联网检查时，在「设置 › 常规 › 更新」关闭「检查更新」，之后 Emperor 不会为更新发出任何请求；打开时同一处有「立即检查」，下面一行写着当前版本和上次检查的结果。

**有新版本时**：「设置 › 常规」最上方和侧栏的通知里都会出现「Emperor 0.2.1 可用」，旁边是「查看更新说明」（打开 GitHub 上的发布页）和「下载」。

**下载与核对**：点「下载」后，Emperor 下载这台 Mac 架构的 DMG，显示进度，可以取消。下载完先用同一个发布里的 `SHA256SUMS.txt` 核对 SHA-256，不符就拒绝并删除下载的文件；再在装有并登录了 GitHub CLI（`gh`）时运行 `gh attestation verify`，核对它确实出自本仓库的发布流程。没有 gh 或 gh 没有登录时只核对 SHA-256，页面会写明「没有核验 GitHub 来源证明」；在终端运行 `gh auth login` 后重新下载即可核验。gh 使用你自己的登录，Emperor 不传任何令牌。

**替换旧版本**：通过核对后，DMG 放进「下载」文件夹（已有同名文件时另存为 `… (1).dmg`，不会覆盖），并在访达中选中它。然后：

1. 退出 Emperor，打开 DMG，把 Emperor Agent 拖进「应用程序」文件夹，替换旧版本。
2. 第一次打开时 macOS 会拦下它：到「系统设置 › 隐私与安全性」，在安全性一栏点「仍要打开」。
3. 重新授权：新版本的代码身份变了，电脑操作要在「设置 › 电脑操作」重新允许「辅助功能」和「屏幕录制」，听写要在「设置 › 语音」重新允许「麦克风」和「语音识别」。

Emperor 不会打开或运行下载的 DMG。会话、记忆和设置都在 `~/.emperor`，替换应用不影响它们。

**内置浏览器的版本**：「设置 › 高级 › 诊断 › 桌面」的「Electron 版本」写着内置浏览器内核的版本。检查更新时 Emperor 会顺带读到最新发布内置的 Electron 版本（来自同一份发布列表，不额外联网）；落后 2 个以上主版本时这一行变成提醒：内置浏览器可能缺少安全修复，请更新 Emperor。

**测试更新源**：开发和验收时可以用环境变量 `EMPEROR_UPDATE_FEED_URL` 让 Emperor 改读本机的测试发布源（只能是 `127.0.0.1` 或 `localhost`，`scripts/test-update-feed.mjs` 可以提供一个）。生效时「设置 › 常规 › 更新」和诊断页都会写明「正在使用测试更新源」，从它下载的安装包不核验 GitHub 来源证明。正常使用时不要设置它。
