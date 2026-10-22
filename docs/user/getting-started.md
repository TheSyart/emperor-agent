# 首次使用

> 文档状态：Active<br>
> 面向读者：第一次安装和配置 Emperor Agent 的用户<br>
> 最后核验：2026-10-22（对照 `b4b98b8c`）<br>
> 事实源：`docs/release/stable-release-notes.md`、`desktop/electron-builder.release.cjs`、`desktop/src/renderer/src/components/settings/model/`（添加模型对话框）、`desktop/src/renderer/src/components/composer/ModelPicker.vue`、`desktop/src/renderer/src/components/sidebar/`（新对话与项目会话入口）、`desktop/src/main/recovery.ts`、`desktop/src/renderer/src/components/settings/updates/`、`packages/core/src/updates/`（检查更新）

## 1. 安装

1. 打开项目的 [GitHub Releases](https://github.com/TheSyart/emperor-agent/releases)，下载最新版本：Apple 芯片（M 系列）的 Mac 选 `Emperor-Agent-<版本>-macos-arm64.dmg`，Intel 芯片的 Mac 选 `-macos-x64.dmg`（也可以下载同名的 `.zip`）。只提供 macOS 安装包，Windows 与 Linux 不受支持。
2. Emperor Agent 的安装包是未签名的：没有 Apple Developer ID 签名，也没有经过 Apple 公证，第一次打开时 macOS 会拦下它。首次打开这样做：先用 Release 页的 `SHA256SUMS.txt` 核对下载的文件；把 Emperor Agent 拖进「应用程序」文件夹，双击打开，系统提示无法打开时点「完成」；再到「系统设置 › 隐私与安全性」，在安全性一栏找到 Emperor Agent，点「仍要打开」并输入登录密码。之后就能像其他应用一样直接打开。不要为了打开 Emperor 而关闭整机的 Gatekeeper。
3. 请从「应用程序」文件夹打开 Emperor：直接在下载位置运行时，macOS 会把它放到随机路径，电脑操作的授权每次启动都要重来。核验构建来源的方法见[未签名版本安全说明](../release/unsigned-preview-notice.md)。
4. 安装包已经包含 Electron/Node runtime，不需要另外安装 Node.js 或 Python。首次启动会离线创建 Emperor Home、校验只读 runtime 并恢复中断的安装账本；正常完成时不显示额外向导。

每个新版本的代码身份都会变：更新后，电脑操作要在「设置 › 电脑操作」重新允许「辅助功能」与「屏幕录制」，听写要在「设置 › 语音」重新允许「麦克风」与「语音识别」。系统设置里的开关看起来已经打开、Emperor 却说没有权限时，以 Emperor 设置页显示的状态为准，按提示重新授权。

如果首次启动进入恢复页，按稳定错误码处理：可以重试、打开 Emperor Home、打开日志、导出诊断包或退出。布局版本过新表示当前应用版本不能安全写入该目录，应升级应用；不要手工降低 `installation.json` 的版本号。用较旧的 Emperor 打开过新版本写入的数据时，见[诊断与排障](diagnostics-troubleshooting.md)。

不希望运行未签名版本时，可以按 [README 的源码运行说明](../../README.md#source) 启动开发版。

## 2. 添加并选择模型

首次启动、还没有任何模型时，Emperor 先显示铺满窗口的接入引导，有两种方式：

- 「使用本机模型」：Ollama、LM Studio 在本机运行时排在最前面，标「推荐」，不需要 Key；
- 「使用 API Key」：DeepSeek、Kimi、通义千问、OpenAI、Anthropic 等。

接下来的步骤和下面的「添加模型」相同：先连接，再选择模型。所有数值都已知时，选完模型就直接保存；有来源未知的数值才多一步「确认参数」。保存后显示「准备好了」，并在后台测试一次，点「开始使用」回到对话。

- 右上角的「稍后配置」（或 Esc）：以后启动不再弹出。空会话的输入框下方会显示「还没有可用模型 · 开始接入」，随时可以重新打开引导。在引导里按 Esc 是返回上一步。
- 已经有模型但用不了时（例如 Key 需要重新输入），不显示引导。那一行写明原因，并给出「去处理」。

以后添加模型，点击侧栏底部的「设置」（或菜单栏「Emperor Agent › 偏好设置…」，⌘,）打开设置弹窗，进入「模型」分区，点右上角「添加模型」；也可以从输入框模型菜单底部的「添加模型…」打开。对话框分三步：

1. **连接**：在「搜索供应商或粘贴 API 地址」里找到供应商（按国内、海外、本地、其他分组，其余在「更多」里），或直接粘贴服务商的 API 地址。填写 API Key（「获取 Key ↗」打开供应商的 Key 页面）；Ollama、LM Studio 等本机服务不需要 Key。供应商同时支持 OpenAI 兼容与 Anthropic 协议时可以在这里选；API 地址在「高级」里，一般不用改。点「连接并获取模型」，Emperor 先测试连接，再读取模型列表；Key 不对、地址不对或连不上时会写明原因。
2. **选择模型**：勾选要加入的模型。列表按家族分组，标出能力（工具、识图、思考）、上下文与输出上限和数据来源；可以搜索、筛选和排序。列表里没有的，用「找不到？＋ 手动输入模型 ID」添加。
3. **确认参数**：上下文、每次输出和思考强度已经按厂商接口与内置目录预填，并标出来源；来源未知的数值要勾选「我已核对这些数值」。显示名、温度和单价在「高级」里。可以顺便把其中一个「设为当前模型」（还没有当前模型时默认是第一个新模型）。点「添加 N 个模型」一次保存全部，Emperor 会在后台对第一个新模型做一次测试，结果显示在提示里。

之后切换模型在聊天输入框完成：点输入框右侧的模型按钮，在「模型」里按供应商选择；模型支持思考档位时，同一个菜单里还有「思考强度」。切换从下一次请求开始生效。

模型配置保存在 `stateRoot/model_config.json`，API Key 加密后写入。卡片管理、编辑、测试和备用模型见[模型、记忆与附件](models-memory-attachments.md#模型配置)。

模型测试失败时，先检查供应商、API 地址、模型 ID 和 Key 是否匹配。接口兼容不等于模型一定支持工具调用、视觉或思考。

## 3. 创建第一条会话

### Chat：普通对话

点击侧栏的「新对话」（⌘N），输入问题并发送。Chat 使用用户档案、全局长期记忆和当前会话历史，不绑定项目目录；需要写文件时，它的工作目录是 Emperor Home 下的 `workspace/`。

### Build：项目工作

点击侧栏「项目」分组标题旁的 `+`，选择「使用现有文件夹」（或「新建空白项目」）并从本机选择项目文件夹；已绑定的项目列在「项目」分组里，项目行上的 `+` 在该项目中新建会话。Build 会把该目录作为 workspace，并读取项目中的 `AGENTS.md` / `CLAUDE.md`。项目私有记忆保存在全局 `stateRoot`，不会写回项目文件。

新建时界面先创建本地草稿；发送第一条消息后，Core 才会创建真实 session 并持久化。这意味着空白草稿不会留下无用会话目录。

## 4. 确认工作正常

完成下面四项即可确认基础链路可用：

- 在 Chat 发送一个不需要工具的问题并收到模型回复。
- 在输入框输入 `/`，确认菜单只有「命令」和当前可用的「Skills」两组。
- 输入 `/model`，确认可以选择要使用的模型；已安装 Skill 应以自己的 token 出现，例如 `/agent-reach`。
- 创建 Build 后让 Agent 读取一个项目文件，确认路径属于刚才选择的 workspace。

如果模型回复正常但文件或命令被拒绝，先查看当前权限预设，而不是反复重试。新会话默认使用 `workspace-write`（可在「设置 › 常规 › 会话 › 新会话的权限」更改）：可以写当前 workspace，超出范围时会弹出一次性批准。Shell 命令受 macOS 系统沙箱（Seatbelt）限制。详见 [计划与目标](plan-goal.md) 和 [诊断与排障](diagnostics-troubleshooting.md)。

## 5. 数据与联网

会话、记忆、模型配置和附件保存在本机；默认 Emperor Home 是 `~/.emperor`。以下操作仍会把必要内容发送到外部：

- 调用已配置的模型 Provider；
- Agent 用 `web_fetch` 读取网页、用 `web_search` 搜索（两者都可以在「设置 › 高级 › 网络工具」关闭）；
- 你打开 Claude Code / Codex 子智能体后，交给它们的任务会发给对应的服务；
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
