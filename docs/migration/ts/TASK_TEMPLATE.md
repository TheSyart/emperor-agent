# Task 模式（schema）

每个迁移 task 都按下面的字段填写。波次文件里用 `###` 标题起一个 task，正文是这些字段。保持紧凑但**六要素齐全**：源、目标、依赖、设计、验证、验收。

```md
### MIG-<AREA>-NNN · <一句话标题>

- **功能点**：迁移的范围，一句话。
- **源(Python)**：`agent/...py` 的具体类/函数（迁出对象）。
- **目标(TS)**：`packages/core/src/...ts` 模块路径 + 对外 API 签名（迁入形态）。
- **依赖**：前置 task ID（无则写「—」）。
- **设计**：
  - 数据模型（dataclass → TS interface/zod schema）。
  - 关键逻辑/算法（要逐字保真的分支、状态机、阈值）。
  - TS 库选型（如有）。
  - **必须保持的不变量/行为**（对账点）。
  - 边界情况 & **磁盘格式兼容点**（读旧 JSON 的字段）。
- **风险/复杂度**：S / M / L（+ 一句风险来源）。
- **验证**：
  - 移植的 Python 测试：`tests/unit/test_xxx.py`（逐条对照断言）。
  - 新增 vitest：要补的用例。
  - 行为契约/golden：必要时用 Python 输出做黄金样本。
  - **验收标准**：达到什么算 done。
- **状态**：todo · PR: —
```

## 填写示例（取自 W02 真实 task）

### MIG-PROV-004 · Anthropic provider（含 prompt caching + 重试）

- **功能点**：把 `AnthropicProvider` 迁到 TS，保留 system+tools 的 ephemeral cache_control 与原生重试。
- **源(Python)**：`agent/providers/anthropic_provider.py`（`AnthropicProvider._kwargs`、`_supports_prompt_caching`、`_convert_messages`、`_parse_response`）。
- **目标(TS)**：`packages/core/src/providers/anthropic.ts`，`class AnthropicProvider implements LLMProvider { chat(); chatStream(); }`。
- **依赖**：MIG-PROV-001（LLMProvider 基类/类型）、MIG-CFG-002（model_config）。
- **设计**：
  - 用 `@anthropic-ai/sdk` 的 `messages.create` / `messages.stream`。
  - **不变量**：原生端点（`apiBase` 空或含 `anthropic.com`）才给 `system` 与最后一个 tool 加 `cache_control:{type:'ephemeral'}`；第三方代理保持 `system` 为字符串（向后兼容）。`maxRetries=2`。
  - OpenAI 风格 messages → Anthropic blocks 转换（text/image、tool_use/tool_result、thinking blocks）逐字对齐 `_convert_messages`。
  - usage 解析含 `cache_read`/`cache_create`。
- **风险/复杂度**：M（thinking/redacted_thinking 块与流式增量需对齐）。
- **验证**：
  - 移植 `tests/unit/test_anthropic_prompt_caching.py`、`tests/unit/test_providers.py` 的 Anthropic 部分。
  - 新增 vitest：原生 vs 代理端点的 `system` 形状、最后 tool cache 标记、maxRetries。
  - **验收**：上述 vitest 全绿；与 Python 对同一 messages 产出的请求体结构一致。
- **状态**：todo · PR: —
