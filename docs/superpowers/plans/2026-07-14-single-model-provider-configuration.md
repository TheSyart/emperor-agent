# 单模型与双协议配置重构计划

## Summary

将模型系统重构为“可保存多条、全局仅激活一条、每条只含一个模型”。彻底移除主/次模型路由，仅支持 OpenAI Chat Completions 与 Anthropic Messages 两种协议。

## Public Interfaces & Migration

- `model_config.json` 升级为 `schemaVersion: 2`：

```ts
type ModelProtocol = 'openai' | 'anthropic'

interface ModelEntryV2 {
  entryId: string
  provider: string
  protocol: ModelProtocol
  modelId: string
  displayName?: string
  apiBase: string
  apiKey: string | null
  capabilityOverrides?: {
    toolCall?: boolean
    vision?: boolean
    reasoning?: boolean
  }
  contextWindowTokens: number
  maxTokens: number
  reasoningEffort: string | null
}

interface ModelConfigV2 {
  schemaVersion: 2
  activeModelId: string | null
  models: ModelEntryV2[]
}
```

- `capabilityOverrides` 缺少字段表示“自动识别”；CoreApi 额外返回解析后的有效能力、来源和可用思考强度。
- 首次读取旧配置前生成一次 `model_config.v1-backup.json`：
  - `mainModelId` 转为原条目。
  - 不同的 `secondaryModelId` 转为未激活的独立条目；相同 ID 不重复。
  - Entry 缺少凭证或参数时，从旧 provider block、全局 defaults 复制。
  - `temperature`、`extraHeaders`、`extraBody` 转入内部兼容数据，UI 不再展示，typed CRUD 不得误删。
  - `azure_openai`、`bedrock`、`openai_codex`、`github_copilot` 不迁移为可运行条目，只保留在备份；若没有其他模型，状态变为“需要重新配置”。
- CoreApi 改为 typed CRUD：
  - 保留 `model.getConfig`、`model.discoverModels`。
  - 新增 `model.saveEntry`、`model.deleteEntry`、`model.activate`、`model.setReasoningEffort`。
  - `model.test` 改用 `{ entryId, kind }`，删除 role 参数。
  - 移除 renderer 对 `model.saveConfig`、`model.saveOnboardingConfig` 和整份脱敏配置回传的依赖。
  - API Key 未提交表示保留，显式 `null` 表示清除。
  - `getConfig` 删除 `secondary`、`routing`、`mainModelId`、`secondaryModelId`。

## Implementation Changes

### 1. Provider 与协议

- 将 Provider registry 从专用 backend 改为 `protocols`、`defaultProtocol`、`apiBases`、`iconId`、模型发现和 reasoning adapter 元数据。
- `anthropic` 仅支持 Anthropic；其余现有标准 Provider 默认 OpenAI；`custom` 必须明确二选一，不提供“自定义协议”。
- 以下预设提供已验证的双协议切换：`deepseek`、`dashscope`、`moonshot`、`zhipu`、`volcengine`、`volcengine_coding_plan`、`byteplus`、`minimax`、`stepfun`、`xiaomi_mimo`、`longcat`、`qianfan`、`siliconflow`、`custom`。Anthropic 地址使用 cc-switch 中对应的官方/代理端点；其他 Provider 不展示协议切换。
- 删除 Azure、Bedrock、Codex OAuth、Copilot 专用 Provider 实现与 registry 项。
- OpenAI 地址允许输入 base URL 或带 `/chat/completions` 的完整地址，保存时统一规范化；Anthropic 同理处理 `/v1/messages`。

### 2. 模型能力与请求参数

新增独立模型 profile/resolution 模块，参考 OpenCode `ProviderTransform.reasoningVariants`：

- 自动解析 `toolCall`、`vision`、`reasoning`、context、output 和 reasoning variants；用户覆盖优先于推断。
- 未识别模型默认：工具调用开启、视觉关闭、思考关闭、128K context、8K output。
- 思考强度保留 `none`、`minimal`、`low`、`medium`、`high`、`xhigh`、`max` 的真实差异，不再把 `xhigh` 与 `max` 混为一项。
- OpenAI 按模型族生成 `reasoning_effort` 或厂商原生 thinking 参数；Anthropic 按模型能力使用 adaptive effort 或 token budget。
- 不支持思考时完全不发送相关参数；不支持工具时不发送 tools，并阻止需要工具的 Build/自动执行流程；普通 Chat 仍可使用。
- 视觉关闭时不发送原始图片，文本型附件继续走现有解析链路。
- Context 用于压缩阈值，Output 用于生成上限。

所有主 Agent、标题、记忆压缩、Hooks、Scheduler、Team 和子代理统一解析同一个激活模型。`ModelRouter` 只保留 use-case 统计，不再选择模型或提供 fallback；新 runtime event 使用 `model_entry_id`，旧 `model_role` 仅为历史回放兼容。

### 3. 设置页与模型切换

按 Claude Design 规范把现有左右分栏改为“模型列表 + 添加/编辑共用弹窗”：

- 列表卡片显示 Provider logo、模型 ID、协议、激活状态及编辑/删除操作。
- 弹窗包含 Provider 搜索选择、协议、API 地址、API Key 显隐、模型获取/自由输入、工具/图片/思考能力、输入和输出上限、思考强度。
- Token 快捷项按参考图提供：输入 `32K/64K/128K/256K`，输出 `8K/16K/32K/64K`，同时支持直接输入。
- 能力项显示“自动/已覆盖”，支持恢复自动识别；思考强度只展示当前模型支持的选项。
- 不展示唯一 key、主次角色、Temperature、Extra JSON 或自定义协议。
- 第一条模型保存后自动激活；后续新增条目保持未激活。删除激活项时确认并激活列表中第一条剩余模型；无剩余条目时进入未配置状态。
- Composer 保留全局模型切换和思考强度快捷切换，但只显示单个 `modelId`，选项来自当前 resolved profile。

### 4. Logo 与来源记录

- 从 cc-switch 固定提交 `3d176b98cc0bfd151a42882e88ab59b62083b92f` 复制当前 Provider 对应 SVG/PNG，放入 renderer 可打包的 provider assets 目录。
- 建立 `iconId → asset` 映射；没有对应图标的本地 Provider 使用首字母 fallback。
- 在同目录增加 `NOTICE.md`，记录 cc-switch、上游 Lobe Icons、MIT 许可证、源路径和固定提交。
- OpenCode 参数规则固定参考提交 `cb8be9ba1217c2e7a2b93cf513eb21b41a7f5365`，在源码注释和 NOTICE 中标明来源，不引入运行时依赖。

## Test Plan

按模块先写失败测试，再实现：

- 配置迁移：主次相同/不同、重复名称、masked key、provider 级凭证、旧参数保留、幂等迁移、备份不覆盖、专用 backend 被拒绝。
- Provider registry：只存在两种协议、双协议端点映射、Custom 二选一、已删除 backend 不可创建。
- Profile/reasoning：GPT-5 effort 子集、Claude adaptive/budget、toggle-only Provider、未知模型默认值、用户覆盖优先级。
- Provider payload：OpenAI/Anthropic endpoint、工具和图片门控、各 effort 参数、temperature 禁用条件、无 UI-only 字段泄漏。
- 单模型运行时：所有 use case 返回同一 entry，无 secondary/fallback；Hooks、压缩、标题和子代理回归。
- CoreApi：保存、编辑、删除、激活、发现、测试、API Key 保留/清空，以及首次可用模型触发初始化流程。
- Desktop：列表/弹窗、协议联动、能力覆盖、token 快捷项、reasoning 选项、logo fallback、Composer 切换和键盘/焦点可访问性。
- 使用隔离的 `EMPEROR_CONFIG_DIR` 验收 fresh state、旧双模型配置、已移除 backend 三种启动路径，并分别连接一个 OpenAI 和 Anthropic 接口。

验证命令：

```bash
npm test --workspace @emperor/core
npm run typecheck --workspace @emperor/core
npm --prefix desktop test
npm --prefix desktop run typecheck
npm --prefix desktop run build
npm --prefix desktop run screenshots
make check
```

## Assumptions

- OpenAI 格式特指 Chat Completions，不增加 Responses API。
- 保留当前标准 Provider 预设，不接入动态 models.dev、价格目录或新的固定推荐模型 ID。
- 多条模型配置共享一个全局激活状态，不做会话级模型绑定。
- Custom Provider 保留，但只能选择 OpenAI 或 Anthropic 标准格式。
- 旧专用 backend 的运行支持按用户决定彻底删除，仅通过迁移备份保留原始数据。
