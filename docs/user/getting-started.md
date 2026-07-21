# 首次使用

> 文档状态：Active<br>
> 面向读者：第一次安装和配置 Emperor Agent 的用户<br>
> 最后核验：2026-07-21<br>
> 事实源：GitHub Releases、模型设置页、Session/Project 创建入口

## 1. 安装

1. 打开项目的 [GitHub Releases](https://github.com/TheSyart/emperor-agent/releases)。
2. 根据操作系统和 CPU 架构选择 macOS、Windows 或 Linux 安装包。
3. 当前公开包是未签名 Preview，不是 Stable。校验摘要、GitHub 构建来源和系统提示的方法见[未签名 Preview 安全说明](../release/unsigned-preview-notice.md)。
4. 安装并启动应用。安装包已经包含 Electron/Node runtime，不需要另外安装 Node.js 或 Python。

没有公开安装包或不希望运行未签名版本时，可以按 [README 的源码运行说明](../../README.md#source) 启动开发版。

## 2. 添加并选择模型

进入“设置 → 模型”，选择“添加模型”。设置页只负责管理配置；保存后回到聊天输入框选择当前要使用的模型。

按下面的顺序填写：

1. 选择 Provider。需要自定义兼容服务时选择 `custom`。
2. 选择 `openai` 或 `anthropic` 协议。界面只会展示该 Provider 支持的协议。
3. 填写模型 ID、API Base 和 API Key。
4. 填写上下文窗口与最大输出 Token。两项都必须是正整数，并应使用服务商公布的限制。
5. 按需填写显示名称、reasoning effort 和能力覆盖。显示名称留空时各处自动使用并同步模型 ID；只有手工填写时才保存自定义别名。能力覆盖只在自动探测不准确时使用。
6. 保存配置并执行模型测试。需要切换模型时，在聊天输入框右侧打开模型选择器。

模型配置保存在 `stateRoot/model_config.json`，磁盘 schema 为 `schemaVersion: 2`。旧配置可以由兼容读取逻辑迁移，但当前界面和文档不再使用“主模型/次模型”双角色配置。

模型测试失败时先检查 Provider、协议、API Base 和模型 ID 是否匹配。HTTP 兼容不等于模型一定支持工具调用、视觉或 reasoning。

## 3. 创建第一条会话

### Chat：普通对话

选择“新建 Chat”，输入问题并发送。Chat 使用用户档案、全局长期记忆和当前会话历史，不绑定项目目录。

### Build：项目工作

选择“新建 Build”，再从本机选择项目文件夹。Build 会把该目录作为 workspace，并读取项目中的 `AGENTS.md`。项目私有记忆保存在全局 `stateRoot`，不会自动写回项目的 `AGENTS.md`。

新建时界面先创建本地草稿；发送第一条消息后，Core 才会创建真实 session 并持久化。这意味着空白草稿不会留下无用会话目录。

## 4. 确认工作正常

完成下面四项即可确认基础链路可用：

- 在 Chat 发送一个不需要工具的问题并收到模型回复。
- 输入 `/status`，确认显示当前模型、会话和运行状态。
- 输入 `/tools` 和 `/skills`，确认能看到当前可用能力。
- 创建 Build 后让 Agent 读取一个项目文件，确认路径属于刚才选择的 workspace。

如果模型回复正常但文件或命令被拒绝，先查看当前权限模式，而不是反复重试。详见 [Plan 与 Goal](plan-goal.md) 和 [诊断与排障](diagnostics-troubleshooting.md)。

## 5. 数据与联网

会话、记忆、模型配置和附件保存在本机；默认私有数据根是 `~/.emperor-agent`。以下操作仍会把必要内容发送到外部：

- 调用已配置的模型 Provider；
- 使用网页搜索、网页抓取或远程 MCP；
- 运行会主动联网的本地命令、Hook 或 MCP server。

不要把“本地运行”理解为完全离线。具体数据位置见 [模型、记忆与附件](models-memory-attachments.md)。
