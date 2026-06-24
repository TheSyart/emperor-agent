# 01. Composition Root 与启动装配

## 入口层定位

Claude Code 的入口核心在 `src/main.tsx`。这个文件不是普通 CLI 参数解析器，而是一个大型 composition root。它在 CLI 真正进入 REPL 或 SDK 查询前，完成几乎所有跨系统装配：

- 启动性能预取：startup profiler、MDM 读取、macOS keychain 预取。
- 配置加载：全局设置、托管设置、环境变量、模型默认值、权限模式。
- 认证与配额：OAuth、Claude AI 订阅、Bedrock/GCP 凭证、安全限制。
- 模型与能力：主循环模型、effort、thinking、fast mode、context window。
- 工具面：内建工具、MCP 工具、插件工具、技能工具、agent definitions。
- 会话面：resume、fork、teleport、remote session、concurrent session。
- UI 面：Ink root、REPL、dialog launchers、状态栏和权限弹窗。
- 运行时面：AppState store、onChangeAppState、task registry、cleanup registry。

它的工程价值不在于“把所有东西放进一个文件”，而在于所有跨层共享资源都有一个明确装配点。复杂度被集中暴露，后续各模块通过上下文对象、store 和参数快照接收依赖。

## 关键装配路径

### 1. 入口副作用优先级

`src/main.tsx` 顶部先执行启动性能相关副作用，再导入重模块。这样做是为了隐藏 IO 延迟，例如 MDM 子进程和 keychain 读取可以与后续模块评估并行。

可借鉴点：

- 对本地 Agent 桌面应用，启动慢通常不是某个函数慢，而是多个 IO 串行。
- Emperor Agent 可在 WebUI 启动前并行预取：model config、local config、MCP config、scheduler store、runtime index、diagnostics 摘要。
- 预取应只做“读”和“缓存”，不能在 import 时产生难以测试的写操作。

### 2. Settings 与 AppState 分离

Claude Code 把用户配置和运行时状态分开：

- `src/utils/settings/*` 负责配置来源、校验和托管设置。
- `src/state/AppStateStore.ts` 定义当前会话 UI/运行时状态。
- `src/state/onChangeAppState.ts` 是状态变化副作用出口，例如权限模式变化通知远端、模型变化写回设置。

Emperor Agent 当前状态分布：

- `model_config.json` 由 `agent/model_config.py` 管理。
- `emperor.local.json` 由 `agent/local_config.py` 管理。
- Control 状态在 `memory/control/state.json`。
- Runtime 事件在 `memory/runtime/events.jsonl`。
- Scheduler、Team、External 各自有 store。

升级建议：

- 保留各业务 store，但新增一个只读 bootstrap snapshot 层，聚合当前 WebUI 首屏需要的事实。
- 把“状态变化副作用”集中到后端服务层，例如 control mode 改变后统一写 store、发 runtime event、刷新 bootstrap payload。
- 避免让 panel 直接调用多个 store 产生交叉副作用。

### 3. 工具来源统一

Claude Code 的 `src/tools.ts` 是工具集合的权威来源。它做了几类事情：

- 注册基础工具：Agent、Bash、Read/Edit/Write、Glob/Grep、WebFetch、Todo、Plan、Skill、MCP resource 等。
- 按 feature/env 条件加载可选工具。
- 按权限 deny rule 在模型看到工具前过滤工具。
- 支持 deferred tool 和 ToolSearch，避免初始提示词塞入所有 schema。

Emperor Agent 的工具注册目前在 `agent/loop.py`：

- 先注册内建工具。
- 再注册 control tools。
- 再注册 todo、subagent、team。
- MCP 初始化后向同一个 `ToolRegistry` 注册外部工具。

升级建议：

- 新增 `agent/tools/catalog.py` 作为工具注册权威来源。
- `AgentLoop` 只调用 catalog 构建 registry，不直接知道每个工具类。
- `ControlPolicy.filtered_definitions()` 扩展为工具曝光策略：Plan 模式、权限 deny、deferred、MCP server scope 都在模型看到工具前处理。

### 4. MCP、Plugin、Skill 三种扩展面

Claude Code 把 MCP、Plugin、Skill 都纳入启动装配，但它们职责不同：

- MCP 提供外部工具与资源。
- Plugin 提供可安装能力包，可能包括 MCP、skills、commands。
- Skill 是可延迟注入上下文的提示能力。

Emperor Agent 已有 MCP 和 skills，插件机制尚不是核心。当前 `/skill` 前端菜单和 `LoadSkill` 工具已经可以作为“延迟上下文注入”的基础。

升级建议：

- 先强化 Skill 生命周期：发现、选择、注入、历史记录、runtime event、撤销边界。
- MCP 保持工具层，不要让 MCP server 直接改变主状态，所有写操作仍走权限管线。
- Plugin 若未来引入，应只做能力分发，不绕过 tools/control/runtime 的核心协议。

## 与 Emperor Agent 的对照

### 当前 Emperor 装配主线

`agent/loop.py` 的 `AgentLoop.__init__()` 当前负责：

- 加载 `.env`、配置日志。
- 初始化 `MemoryStore`、`TokenTracker`、`SchedulerStore/Service`。
- 初始化 `SkillsLoader`、`ContextBuilder`。
- 创建 `ToolRegistry` 并注册工具。
- 创建 `ControlManager`、`TodoStore`。
- 初始化 `SubagentRegistry`、Team tools、MCP client。
- 调用 `refresh_model_config()` 创建 provider、compactor、runner。
- 从 checkpoint 或 history 恢复对话。

这已经具备 composition root 的雏形，但问题是对象装配和业务策略混在一起。比如工具注册、模型路由、compactor 构造、runner 更新都在同一个类里。

### 建议拆分边界

可新增三个轻量结构，而不是一次性重构所有文件：

- `AgentKernel`：持有 memory、runtime、control、registry、model_router、scheduler、team 等核心依赖。
- `ToolCatalog`：只负责注册与过滤工具。
- `RuntimeBootstrapService`：生成 WebUI/CLI 首屏状态和 diagnostics 摘要。

迁移后 `AgentLoop` 保留 CLI 交互职责，Web 后端从 kernel 获取共享依赖，Scheduler/Team 不再绕回 `AgentLoop` 读取分散属性。

## 风险提示

不要把 Claude Code 的 `main.tsx` 规模当作目标。Emperor Agent 的长期维护方向应是“有明确装配边界”，不是制造一个更大的入口文件。具体做法是把当前 `AgentLoop` 的隐式组合根显式化，而不是把所有初始化继续堆在一个类里。

