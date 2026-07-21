# 模型、记忆与附件

> 文档状态：Active<br>
> 面向读者：配置模型或管理本地上下文的用户<br>
> 最后核验：2026-07-21<br>
> 事实源：ModelConfig v2、Memory/Project stores、AttachmentStore、设置页

## 模型配置

Emperor Agent 可以保存多条模型配置，但全局同时只激活一个模型。当前磁盘格式：

- 文件：`stateRoot/model_config.json`
- schema：`schemaVersion: 2`
- 激活项：`activeModelId`
- 模型数组：`models[]`

每条模型至少包含 Provider、协议、模型 ID、API Base、上下文窗口、最大输出 Token 和稳定的 `entryId`。API Key 可以为空，例如连接本地兼容服务时。

“显示名称”只保存用户明确设置的自定义别名。未设置别名时，模型列表、当前模型标题、导航栏和 Composer 都使用非空的 `effectiveDisplayName=modelId`；修改模型 ID 时界面标识自动同步。手工填写别名后停止自动同步，清空别名则恢复自动状态。旧配置迁移产生的 `default` 与 `default · Secondary` 哨兵会被清理，其他真实别名保留。

Provider 描述的是访问方式，不是固定模型清单。部分 Provider 支持模型发现；发现失败时仍可以手工填写模型 ID。`custom` 需要明确选择 `openai` 或 `anthropic` 协议。

设置 → 模型负责新增、编辑、连接测试、删除配置，以及显式执行/成本策略；它不提供激活或切换按钮。模型切换统一在聊天输入框完成；输入框会显示 Provider Logo、模型显示名和思考强度，展开后可以查看当前模型详情并选择其他已保存配置。

能力覆盖包含 `toolCall`、`vision` 和 `reasoning`。它们用于修正无法自动判断的模型能力，不会让一个本来不支持该能力的服务端获得能力。

## 备用模型与成本上限

默认行为仍是只调用当前激活模型：普通模型失败、旧配置里的 `secondaryModelId` 或模型列表顺序都不会触发暗中切换。

设置 → 模型的“执行与成本策略”可以显式配置：

- 是否启用一个具体的备用模型；
- 只在限流耗尽，或同时在服务/网络暂时失败耗尽后切换；
- 可选的“每 Agent 轮成本上限”。

每次主模型已经用完自己的重试预算后，Core 最多切换一次；认证、权限、请求格式、上下文溢出、余额/计费、模型不存在、内容过滤和未知错误不会触发备用模型。备用模型只在当前 Agent step 内保持，下一轮仍从全局激活模型开始。切换时 Core 会丢弃失败路径尚未提交的流式文本和工具片段，并从发给新模型的投影中清除 `reasoning_content`、thinking block、signature 和加密推理元数据；权威会话历史不会因此被重写。

Emperor Agent 不内置可能过期的厂商价格。要启用成本上限，先在相关模型条目填写普通输入、输出、缓存读取和缓存写入的 USD / 每百万 tokens 单价；显式 `0` 表示该项免费，留空表示未知。上限会在请求前按投影输入和输出上限收缩 `maxTokens`，并在成功响应后按实际 usage 记账、阻止下一次超预算调用。

这个上限的准确名称是 `maxUsdPerAgentTurn`：主 Agent、每个子代理和 Team runner 分别约束自己的 step，不是 session、Goal、Scheduler job 或账号级预算。Provider 可能对没有返回 usage 的失败/重试请求收费，因此账本会把这种情况标记为 incomplete，保留已知小计而不是把未知成本按 0 计算；本地上限不是 Provider 账单的硬保证。

## 模型请求会发送什么

每次请求可能包含当前消息、会话历史、系统提示词、适用的记忆、请求的 Skill、附件文本或图片，以及必要的工具结果。具体内容由当前 Chat/Build scope、压缩状态和上下文预算决定。

API Key 和本地绝对路径不应出现在普通模型上下文中。MCP、网页和外部消息被标记为不可信输入，但其中与任务相关的文本仍可能发送给模型。

## 记忆层

| 数据         | 默认位置                                  | 主要用途                |
| ------------ | ----------------------------------------- | ----------------------- |
| 用户档案     | `memory/profile/USER.local.md`            | 稳定偏好和个人上下文    |
| 全局长期记忆 | `memory/MEMORY.local.md`                  | Chat 可用的长期事实     |
| 项目私有记忆 | `projects/<project-id>/AGENTS.local.md`   | 绑定项目的 Build 上下文 |
| 会话历史     | `sessions/<session-id>/history.jsonl`     | 当前会话对话和工具消息  |
| checkpoint   | `sessions/<session-id>/_checkpoint.json`  | 压缩和恢复边界          |
| 文件检查点   | `sessions/<session-id>/file-checkpoints/` | 受管文件工具的本地回退  |
| 记忆版本     | `memory/versions/` 及相关索引             | 查看和恢复历史快照      |

表中路径都相对 `stateRoot`。默认 `stateRoot` 是 `~/.emperor-agent`。

`_checkpoint.json` 是 turn/压缩恢复边界，不保存项目文件内容；`file-checkpoints/` 是默认关闭的 Beta 文件快照，两者不是同一协议。文件检查点只通过诊断页的预览与确认入口使用，详见[诊断与排障](diagnostics-troubleshooting.md#文件检查点与回退beta)。

Chat 压缩主要更新全局长期记忆和用户档案；Build 压缩把项目事实写入项目私有记忆。Scope repair 会阻止项目事实误写入全局记忆。项目源码里的 `AGENTS.md` 不属于这个写入链路。

可以使用 `/memory` 查看摘要、`/memory-log` 查看版本、`/memory-restore <id>` 恢复指定快照。设置页的“记忆”也提供内容、上下文解释和版本操作。

源码中包含默认关闭的 Hybrid Memory 实验路径。`off` 不建立派生索引；`eval` 只做影子检索并在诊断页显示有效模式、检索策略、fallback 次数和索引大小，不改变发送给模型的内容。即使配置为 `on`，缺少与当前 embedding provider 绑定的通过评估时也会自动降为 `eval`。当前发行物不内置生产 embedding provider，因此这不是设置页里可直接开启的正式功能；Markdown 记忆仍是权威数据，删除 `memory/hybrid-index/` 不会删除记忆。

## 会话压缩

输入 `/compact` 会压缩当前未归档会话。压缩不会简单删除全部历史，而是：

1. 按 scope 选择可写的记忆目标；
2. 生成并校验 memory patch；
3. 写入记忆版本和 checkpoint；
4. 保留恢复当前任务所需的最近上下文。

压缩失败时不应把已经完成的模型回复改写成失败。诊断页会显示上下文和压缩相关信息。

达到 token threshold 时，Core 会在最终回复已经保存后自动执行同一套语义压缩，不需要环境变量或日志轮转触发。连续失败三次后会停止自动重试并留下 degraded 诊断；手动 `/compact` 仍是独立操作。自动压缩只处理 history 副本，不会把局部 microcompact 或 provider 请求裁剪反写到权威会话历史。

## 附件

Composer 一次最多保留 5 个待发送附件。支持：

- 图片：PNG、JPEG/JPG、WebP、GIF，单个最多 10 MiB；
- 文档和文本：PDF、JSON、CSV、纯文本、Markdown，单个最多 25 MiB。

非图片内容会尝试提取文本并保存 sidecar；内联模型上下文的文本有长度上限。图片只有在激活模型支持视觉时才按视觉内容发送，否则保留为可见附件并使用文本 fallback。

附件原文件保存在 `stateRoot/memory/attachments/<month>/`，通过受管 attachment ID 和 `app://attachments/{id}/raw` 读取。Renderer 不能用该协议读取任意本地路径。

## 备份与迁移

备份时应先完全退出应用，再复制整个 `stateRoot`。只复制 `memory/` 会遗漏 sessions、Goal、Scheduler、MCP 和模型配置。

旧布局迁移采用“只复制、不删除、不覆盖已有目标”的策略。迁移结果可在诊断页查看。不要在应用运行时手工改写 JSONL、Goal ledger 或 checkpoint。

完整目录和迁移规则见[全局私有存储根架构](../architecture/global-state-store.md)。
