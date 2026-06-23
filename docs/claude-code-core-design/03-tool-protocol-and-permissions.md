# 03. Tool Protocol 与 Permissions

Claude Code 的工具系统核心在 `src/Tool.ts`、`src/tools.ts`、`src/services/tools/toolExecution.ts` 和 `src/hooks/useCanUseTool.tsx`。它的工具不是“函数表”，而是一组拥有模型 schema、运行时校验、权限、并发、进度、结果映射和 UI 元数据的对象。

## Claude Code Tool 对象协议

`Tool` 协议的高价值字段可分为八类。

### 1. 模型可见能力

- `name`
- `aliases`
- `searchHint`
- `description(input, options)`
- `prompt(options)`
- `inputSchema`
- `inputJSONSchema`
- `strict`
- `shouldDefer`
- `alwaysLoad`

含义：

- 工具 schema 不一定总出现在首轮模型请求中。
- `ToolSearchTool` 可按 `searchHint` 发现 deferred tools。
- MCP 工具可用 JSON Schema，不必都转换为本地 Zod。

Emperor 当前：

- `Tool.name`
- `Tool.description`
- `Tool.parameters`
- `ToolRegistry.get_definitions()`

升级方向：

- 增加 `search_hint`、`always_load`、`deferred`。
- 工具定义输出与工具注册分离，支持“注册但暂不暴露给模型”。

### 2. 输入校验

- `inputSchema.safeParse(input)`
- `validateInput(input, context)`
- `backfillObservableInput(input)`
- `preparePermissionMatcher(input)`
- `inputsEquivalent(a, b)`
- `getPath(input)`

工具调用链先做 schema 校验，再做工具特定语义校验。比如文件编辑会检查文件大小、路径 deny rule、old/new 是否相同、是否可匹配原内容。

Emperor 当前：

- `cast_params()` 做基本类型转换。
- `validate_params()` 做 JSON Schema 基础验证。
- 文件工具内部做路径、文件存在、大小、匹配检查。

升级方向：

- 把 schema 校验和语义校验分开：`validate_schema()`、`validate_input()`。
- 路径类工具统一实现 `get_path()` 和 permission matcher。
- 对模型发错类型时返回可重试的结构化错误，而不是只有字符串。
- 保证校验先于权限：权限系统应看到经过类型转换和语义补全后的输入，避免把无效参数误送到审批卡或安全规则。
- 增加 `observable_input` 概念：工具可以补全绝对路径、命令子动作、目标资源等供 hook/权限观察，但不必直接修改模型原始输入。

### 3. 权限与风险

- `isReadOnly(input)`
- `isDestructive(input)`
- `isOpenWorld(input)`
- `requiresUserInteraction()`
- `checkPermissions(input, context)`
- `toAutoClassifierInput(input)`

Claude Code 的工具自己负责声明风险和工具特定权限判断，但最终决策仍进入统一权限管线。

Emperor 当前：

- `read_only`
- `exclusive`
- `PermissionPolicy` 按工具名和参数粗判。
- shell 有独立 deny regex。

升级方向：

- 工具暴露 `is_read_only(args)`，不要只用类级别 `read_only`。
- 工具暴露 `is_destructive(args)`，用于 Ask/Plan/Scheduler/External 统一判断。
- Shell/File/MCP/Scheduler/Team 都实现 `check_permissions()`，再交给统一 pipeline。

### 4. 并发与中断

- `isConcurrencySafe(input)`
- `interruptBehavior()`
- `contextModifier`

Claude Code 不把“只读”等同于“可并发”，而是让工具基于输入判断。比如某些读操作可能依赖共享状态，某些 shell 命令虽然看似读但实际 open-world。

Emperor 当前：

- `concurrency_safe = read_only and not exclusive`
- shell `exclusive=True`

升级方向：

- 允许工具按参数返回并发安全性。
- 引入工具中断语义：`cancel` 或 `block`。
- 长命令、浏览器、MCP streaming 工具支持 abort signal。

### 5. 执行与进度

- `call(args, context, canUseTool, parentMessage, onProgress)`
- `ToolCallProgress`
- `renderToolUseProgressMessage`

工具执行可以持续发 progress message。`StreamingToolExecutor` 会立即 yield progress，不等工具完成。

Emperor 当前：

- 工具 `execute()` 同步返回字符串。
- 少数工具通过 `requires_runtime_context` 接收 `emit`。

升级方向：

- 新增 `execute_async(args, context) -> ToolRun` 或 async generator。
- 统一 progress event：queued、started、progress、result、error、cancelled。
- 旧 `execute()` 通过 adapter 包装。

### 6. 结果映射与预算

- `mapToolResultToToolResultBlockParam(content, toolUseID)`
- `maxResultSizeChars`
- `mcpMeta`
- `extractSearchText`
- `isResultTruncated(output)`

工具结果面向模型、面向 UI、面向持久化是三种不同形态。Claude Code 通过工具自身的映射方法和工具结果预算层解决这个问题。

Emperor 当前：

- 旧工具仍可用字符串 `execute()`，但 `ToolRegistry.execute_result()` 已能把旧字符串和新 `ToolResult` 统一成结构化结果。
- `ToolExecutionEngine` 内部保留 `ToolResult`，tool message 使用 `model_content`，`tool_run_completed` 与 legacy `tool_result` runtime event 使用 `display_summary`，并可携带 artifacts/metadata。
- `_cap_tool_result()`、`_shrink_old_tool_results()` 和 `ContextPipeline` 继续负责请求前预算治理，`ToolResultStore` 负责大结果 artifact-backed replacement。
- `read_file`、`grep`、`run_command` 已有第一批原生 `map_result()`：分别输出源码 artifact/行号 metadata、搜索匹配 metadata、命令 exit/timeout/truncation metadata。

升级方向：

- 继续把写入/编辑类工具迁移为原生 `ToolResult`：`edit_file`、`write_file` 应输出稳定 summary、结构化 diff、涉及文件 artifact、mtime 或内容版本 metadata。
- MCP/外部工具先通过 adapter 包装，后续支持 server/tool 级预算和 artifact override。
- Runtime UI 已能保留 artifacts/metadata，下一步需要在工具卡片中展示 artifact 链接和计划验证证据。

### 7. UI 元数据

- `userFacingName`
- `getToolUseSummary`
- `getActivityDescription`
- `renderToolUseMessage`
- `renderToolResultMessage`
- `renderGroupedToolUse`

这些是 Ink TUI 所需，不应照搬 UI 实现，但背后的元数据值得吸收。

Emperor 升级方向：

- 工具协议只提供 UI-neutral metadata。
- Vue 组件根据 metadata 渲染，不让工具返回前端组件。
- 对常见工具显示 activity：`Reading file`、`Editing file`、`Running command`、`Searching pattern`。

### 8. MCP 与外部工具标识

- `isMcp`
- `mcpInfo`
- MCP server/tool name 正规化。

Emperor 当前 MCP 工具注册为 `mcp_{server}_{tool}`。Claude Code 使用 `mcp__server__tool`，并且支持 server-level permission rule。

升级方向：

- 保留现有名字兼容，但内部引入 `ToolIdentity(kind, server, name)`。
- 权限规则支持 server 级别匹配。
- WebUI MCP 页展示“模型可见名”和“原始 MCP 名”的映射。

## 工具调用链路

Claude Code 的工具调用从模型输出到结果回填大致如下：

1. `query()` 收到 assistant message 中的 `tool_use` block。
2. `StreamingToolExecutor.addTool()` 或 `runTools()` 找到工具定义。
3. 用工具 `inputSchema` 解析输入，失败则返回 `InputValidationError` tool_result。
4. 执行 `validateInput()`，失败则返回工具错误。
5. 执行 `runPreToolUseHooks()`，hook 可输出 progress、额外上下文、updatedInput、permission result、stop。
6. 调用 `resolveHookPermissionDecision()`，进入 `canUseTool` 权限管线。
7. 如果权限不是 allow，生成拒绝 tool_result，并可能运行 PermissionDenied hooks。
8. 权限允许后调用 `tool.call()`。
9. 工具执行期间通过 `onProgress` 发 progress message。
10. `tool.mapToolResultToToolResultBlockParam()` 生成模型可见 tool_result。
11. 结果经过 `processToolResultBlock()` 和工具结果预算处理。
12. `query()` 把 tool_result 放入下一轮 messages。

Emperor 当前调用链路：

1. provider 返回 `ToolCallRequest` 列表。
2. `_execute_tool_calls()` 按并发安全分组。
3. `_run_tool()` 检查 Plan 模式、Ask Guard、PermissionManager。
4. `ToolRegistry.execute()` 做参数准备、调用 `tool.execute()`、捕获异常。
5. 字符串结果进入 tool message。
6. 下一轮 `_pair_tool_calls()` 兜底配对。

核心差距：

- Claude Code 把“校验、hook、权限、执行、映射、预算”拆成阶段。
- Emperor 当前把多数逻辑压在 runner 和 registry 中，工具自身协议较薄。
- Emperor 目前权限粗判发生在 runner 执行路径中，容易早于完整 schema/语义校验。Tool Protocol v2 应先稳定参数，再审批和执行。
- Claude Code 的 hook allow 不会越过 deny/ask/safety 复查；Emperor 后续加 hook 或 classifier 时也要保持 fail closed。

## 权限管线设计

Claude Code 的权限决策有两个层面。

第一层：`hasPermissionsToUseToolInner()`

- 检查 deny/allow/ask rules。
- 检查工具自身 `checkPermissions()`。
- 根据 permission mode 转换决策。
- 对 Plan、acceptEdits、bypass、dontAsk、auto 等模式做统一处理。

第二层：`useCanUseTool()`

- 如果 allow，直接返回。
- 如果 deny，记录拒绝，返回拒绝结果。
- 如果 ask，根据环境分流：
  - coordinator worker
  - swarm worker
  - speculative bash classifier
  - interactive permission dialog
  - bridge/channel callbacks

这个分层很关键：权限判断本身不绑定 UI；UI/worker/bridge 只是 ask 决策的不同解决方式。

Emperor 当前：

- `PermissionPolicy.assess()` 返回 allow/deny/approval。
- `PermissionManager.require_approval()` 创建 AskCard。
- `ControlManager` 负责 pending ask/plan。
- `run_command` 内部还有 hard deny regex。

升级方向：

- 引入 `PermissionDecision` 三态：`allow`、`deny`、`ask`，`ask` 不等同于 WebUI AskCard。
- 新增 `PermissionResolver`：CLI、WebUI、Scheduler、Team、External 可有不同 resolver。
- 工具内部 hard deny 仍可保留，但要作为 `safety_check` reason 纳入统一事件。
- `auto` 模式未来可接入轻量 classifier，但必须 fail closed，且高风险 safety check 不能被自动批准。

## Tool Protocol v2 草案

Python 侧可先以 dataclass/protocol 形式渐进引入：

```python
class ToolV2(Protocol):
    name: str
    description: str
    input_schema: dict
    max_result_chars: int

    def is_enabled(self, context: ToolContext) -> bool: ...
    def is_read_only(self, args: dict) -> bool: ...
    def is_concurrency_safe(self, args: dict) -> bool: ...
    def is_destructive(self, args: dict) -> bool: ...
    def validate_input(self, args: dict, context: ToolContext) -> ValidationResult: ...
    def backfill_observable_input(self, args: dict, context: ToolContext) -> dict: ...
    def get_path(self, args: dict) -> str | None: ...
    def to_permission_matcher(self, args: dict) -> str | None: ...
    def check_permissions(self, args: dict, context: ToolContext) -> PermissionDecision: ...
    def map_result(self, result: Any, context: ToolContext) -> ToolResult: ...
    async def execute(self, args: dict, context: ToolContext) -> ToolResult: ...
```

当前 Emperor 已向这个协议推进了一步：`Tool.max_result_chars` 作为兼容 trait 进入基类，`ToolRegistry.tool_result_limits()` 会导出正整数预算，`AgentRunner` 默认 store-backed `ContextPipeline` 会按工具名应用预算。这意味着大结果替换不再只有全局阈值；首批已给 `read_file=24000`、`grep=16000`、`glob=12000`、`run_command=12000`、`web_fetch=10000` 配置模型上下文预算，MCP 工具后续可通过协议或 overrides 补齐。

兼容策略：

- 旧 `Tool` 通过 adapter 变成 `ToolV2`。
- `ToolRegistry` 同时接受旧工具和新工具。
- Runner 只调用 execution engine，不直接关心工具版本。

## 重点工具升级顺序

优先迁移两个高收益工具族：

- `read_file` / `edit_file` / `write_file`：补齐“必须先完整读过”、mtime 或内容陈旧检测、危险路径细分、结构化 diff/result。文件工具最能体现 `get_path()`、permission matcher、result summary 的价值。
- `run_command`：把当前 regex 风险判断拆成 shell safety stage，逐步增加子命令解析、wrapper/env stripping、重定向路径校验、compound command 限制。后续如果接入 classifier，也只能作为 ask resolver 的候选决策，不能覆盖硬安全规则。

后台场景还需要一个明确策略：Scheduler、Team、External、后台子代理不能弹交互卡时，应走 non-interactive resolver。它可以使用规则、hook、已授权同参、只读安全判断；无法确定时必须返回 deny 或 paused，而不是让任务永久等待。
