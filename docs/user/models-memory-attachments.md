# 模型、记忆与附件

> 文档状态：Active<br>
> 面向读者：配置模型或管理本地上下文的用户<br>
> 最后核验：2026-09-22<br>
> 事实源：`packages/core/src/config/model-config.ts`、`packages/core/src/llm/`、`packages/core/src/harness/memory/memory.ts`、`packages/core/src/harness/compaction/`、`packages/core/src/attachments/store.ts`、`desktop/src/renderer/src/components/settings/`（模型 / 记忆分区）

## 模型配置

Emperor Agent 可以保存多条模型配置，但全局同时只激活一个模型：

- 文件：`stateRoot/model_config.json`
- schema：`schemaVersion: 2`
- 激活项：`activeModelId`
- 模型数组：`models[]`

每条模型至少包含 Provider、协议、模型 ID、API Base、上下文窗口、最大输出 Token 和稳定的 `entryId`。API Key 可以为空，例如连接本地兼容服务时。

Provider 描述的是访问方式，不是固定模型清单。部分 Provider 支持模型发现；发现失败时仍可以手工填写模型 ID。`custom` 需要明确选择 `openai` 或 `anthropic` 协议。Provider 为 `deepseek` 时使用内置的 DeepSeek 适配器，其他 Provider 按所选协议走 OpenAI Chat Completions 或 Anthropic Messages。

“显示名称”只保存你明确设置的自定义别名；未设置时各处使用模型 ID。

“设置 → 模型”负责新增、编辑、连接测试和删除配置。每条配置显示为一张卡片：右上角「添加模型」在列表上方展开新建卡片，「编辑」在卡片内展开编辑器（其中的「测试文本」「测试图片」使用已保存的配置发送最小请求），「删除」在卡片内确认。模型切换在聊天输入框完成，切换从下一次请求开始生效。

能力覆盖包含 `toolCall`、`vision` 和 `reasoning`，用于修正无法自动判断的模型能力，不会让本来不支持该能力的服务端获得能力。

### 重试

模型请求遇到空响应、限流、服务端错误、超时或网络错误时，最多自动重试 5 次，间隔从 0.5 秒指数增长到 10 秒；服务商返回的 Retry-After 在上限内时优先采用。认证、请求格式等错误不重试。

### 备用模型与成本上限

执行策略保存在 `model_config.json` 中，在“设置 → 模型”列表下方的“执行与成本策略”中编辑，点击「保存策略」后生效：

- **备用模型**：开启且指定了可用条目后，主模型在自动重试用尽、且错误类型命中触发条件（限流，或服务端错误、超时、网络错误、空响应）时，本轮剩余请求改用备用模型；每轮最多切换一次，下一轮回到主模型。切换会在对话中显示一条提示。
- **每轮成本上限**：按条目的 `pricing` 累计本轮用量费用，达到上限后在下一个 step 之前停止本轮，并在对话中显示原因。某个参与本轮的模型条目缺少完整 pricing 时，同样会停止，因为无法计算成本。上限在 step 之间检查，单个请求本身可能略超上限。

## 模型请求会发送什么

每次请求可能包含：系统提示词、工作区说明（`AGENTS.md` / `CLAUDE.md`）、用户档案、长期记忆、Skill 目录与被调用的 Skill 说明、会话历史（含压缩摘要）、附件文本或图片，以及工具结果。

API Key 不会出现在模型上下文中。MCP 返回的内容按不可信输入处理，但其中与任务相关的文本仍会发给模型。

## 记忆层

| 数据         | 默认位置                                | 用途                       |
| ------------ | --------------------------------------- | -------------------------- |
| 用户档案     | `memory/profile/USER.local.md`          | 稳定偏好和个人上下文       |
| 全局长期记忆 | `memory/MEMORY.local.md`                | 跨会话的长期事实           |
| 项目私有记忆 | `projects/<project-id>/AGENTS.local.md` | 绑定项目的 Build 上下文    |
| 按日情景记忆 | `memory/YYYY-MM-DD.md`                  | 在设置的“记忆”中查看和编辑 |
| 记忆版本     | `memory/versions/`                      | 查看和恢复历史快照         |
| 会话记录     | `sessions/<session-id>/log.jsonl`       | 当前会话的全部内容         |

表中路径都相对 Emperor Home（`stateRoot`），默认 `~/.emperor`。

用户档案、全局长期记忆和（Build 会话中的）项目私有记忆会作为背景信息进入每个会话，内容变化后的下一轮会重新注入。每一节最多 32 KiB。Agent 可以用 `memory_edit` 工具修改这三份记忆（精确替换或追加），修改会生成版本快照；你也可以要求它“记住”某件事。项目源码中的 `AGENTS.md` 不属于这个写入链路。

“设置 → 记忆”顶部是可展开的“上下文概览”，汇总上下文、历史 log、压缩和维护状态，需要处理时显示“需关注”。下方按“长期 / 用户档案 / 情景 / Watchlist / 版本”切换：前四个标签直接编辑对应文件（右上角「保存」或 ⌘S），“情景”按日期选择；“版本”列出记忆快照，可以查看差异并「恢复」。

## 会话压缩

- 自动：上下文估算达到模型上下文窗口的 80% 时，Agent 会先截短较早的超长工具结果，仍不够时把较早的对话压缩成一份摘要，保留最近约 16% 窗口的内容。
- 溢出：服务商报告上下文超限时，会先压缩再重试一次。
- 手动：输入 `/compact` 立即压缩当前会话。

摘要固定分为 8 个部分：主要请求与意图、关键技术概念、文件与代码、错误与修复、未完成的后台任务、当前工作、下一步和关键上下文。压缩只改变发给模型的会话内容，不会改写长期记忆，也不会删除 `log.jsonl` 中的原始记录。

## 附件

Composer 一次最多保留 5 个待发送附件：

- 图片：PNG、JPEG/JPG、WebP、GIF，单个最多 10 MiB；
- 文档和文本：PDF、JSON、CSV、纯文本、Markdown，单个最多 25 MiB。

非图片附件会提取文本并随消息发送。图片作为图像内容发送；当前模型不支持视觉时，请求中的图片会替换为一段说明文字。

附件原文件保存在 `stateRoot/memory/attachments/<month>/`，通过 `app://attachments/{id}/raw` 读取。Renderer 不能用该协议读取任意本地路径。

## 备份与迁移

备份时先完全退出应用，再复制整个 Emperor Home。只复制 `memory/` 会遗漏会话、Scheduler、MCP、用户 Skills、受管工具环境和模型配置。

首次启动当前版本时，旧版本的 `sessions/` 目录会整体移到 `sessions.legacy-<时间戳>/` 保留，新版本从空的会话列表开始；旧会话不会被删除，但也不会在界面中显示。不要在应用运行时手工修改 `log.jsonl`。

完整目录和迁移规则见[全局私有存储根架构](../architecture/global-state-store.md)。
