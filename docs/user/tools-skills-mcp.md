# Tools、Skills 与 MCP

> 文档状态：Active<br>
> 面向读者：希望扩展 Agent 能力的用户<br>
> 最后核验：2026-07-20<br>
> 事实源：ToolRegistry、SkillManager、MCP config/client、插件页

“插件”页面分成 Skills、Tools 和 MCP 三个标签。三者作用不同：Tool 是可执行接口，Skill 是按需加载的工作说明和资源包，MCP 把外部 server 暴露的工具接入当前 ToolRegistry。

## Tools

内建工具主要分为：

- 文件与搜索：`read_file`、`write_file`、`edit_file`、`apply_patch`、`delete_file`、`rename_file`、`glob`、`grep`；
- 命令与网页：`run_command`、`web_search`、`web_fetch`；
- 控制与计划：`ask_user`、`propose_plan`、`request_plan_mode`、`update_todos`；
- 长任务与协作：Goal tools、Scheduler、subagent 和 Team tools；
- 上下文：`load_skill`、用户档案和其他受控管理工具。

源码中还包含默认关闭的 `code_intelligence` 实验工具。只有当前配置请求 `on`、parser-bound 真实仓库评估 receipt 通过且 Build session 绑定项目时，它才会注册；Chat 不可调用。它支持按符号查定义/引用和按文件位置跳转，输出会标明 `graph`、`lsp` 或 `graph_fallback`，以及是否因容量、大文件、symlink 或 parse error 形成 partial result。当前发行物没有 production LSP descriptor/发行 receipt，因此普通用户的 `/tools` 不会看到它，也没有设置页开关。

实际可用列表取决于会话类型、Goal 状态、已加载 MCP 和权限模式。输入 `/tools` 或打开“插件 → 工具”查看当前注册结果。

只读、可并发和是否需要确认由 Core 决定。工具卡显示的是执行投影，不能替代实际 store、command receipt 或 Goal evidence。

`read_file`、`edit_file`、`apply_patch` 和 PDF 文本 sidecar 共用 8 MiB 单文件读取上限，超限会在完整载入或写回前拒绝，并响应 turn 取消。`edit_file` 拒绝空 needle；精确和 trim 匹配失败后可按空白差异定位真实源码跨度，多处命中仍要求更多上下文或 `replace_all=true`，实际内容不变时不会写盘或生成修改事件。`apply_patch` 是单文件精确文本 patch，不做模糊匹配；`delete_file` 只删除普通文件，`rename_file` 不覆盖既有目标，两者都拒绝目录和符号链接。删除与重命名即使在 `accept_edits` 下也需要显式批准；rename 的来源和目标会同时进入权限 path rule 与 workspace 检查。可选文件检查点启用后，这五种写工具会在执行边界保存 before/after。

## Skills

Skill 至少包含一个带 frontmatter 的 `SKILL.md`，可以附带 `scripts/`、`references/` 和 `assets/`。

加载优先级：

1. Build 项目的 `<project>/.emperor/skills`；
2. 用户全局 `stateRoot/skills`；
3. 应用内置 `runtimeRoot/skills`。

同名时高优先级覆盖低优先级。项目和内置 Skill 是只读来源；插件页的新建、编辑、删除默认作用于用户全局 Skill。

当前生效来源可在“设置 → 诊断 → 配置”的 `skills.<name>` 行核对。它使用与 `load_skill` 相同的活动 session 解析结果，不会出现诊断说 user、实际却加载 project 的双轨状态；切换 Build/Chat session 会相应改变 project candidate 是否参与。诊断只显示来源与路径，不显示 Skill 正文。

### 调用 Skill

- 在 Composer 的能力选择器中选择；
- 输入 `/<skill-name> 任务内容`；
- 让 Agent 在需要时调用 `load_skill`。

Blocked 或 invalid Skill 不会出现在可调用快捷方式中。

### 安装 Skill

插件页支持本地 `.zip` / `.skill`，以及公开 GitHub repo/tree 或 HTTPS `.zip` / `.skill` 链接。安装采用两步流程：

1. 预览来源、候选目录、文件摘要、依赖和脚本风险；
2. 用户确认精确候选和 digest 后安装。

缺少 binary、runtime 或环境变量的 Skill 会以 `blocked` 状态安装，依赖满足并刷新后才能激活。安装 Skill 不等于自动执行其中的脚本。

## MCP

MCP 配置保存在 `stateRoot/mcp_config.json`。入口是“插件 → MCP”；旧 `/mcp` 和设置页 integrations 路径会重定向到这里。

当前支持：

- `stdio`：启动本地命令作为 MCP server；
- `sse`：连接远程 SSE server；
- `enabled`：按 server 启停；
- `${ENV_NAME}`：从执行环境展开环境变量；
- `tool_overrides` 和 defaults：补充只读、独占等工具属性。
- `call_timeout_ms`：为全部或单个工具设置请求 deadline；未配置时为 60 秒。

保存配置后，Core 按 server 配置 diff：未变化且健康的连接保留原 generation，变化的连接先建立 replacement 并取得工具快照，再关闭旧 client。插件页会明确显示“已连接、连接中、等待重试、认证失败、连接异常、连接失败或未连接”、generation 和工具数；零工具不再等同于连接正常。

传输失败后的连接重启会合并并发请求，按 1、4、16 秒最多三次退避。认证失败不会无限重试；修正 credential 或配置并再次保存才会重新连接。取消当前 turn 会取消仍在等待的 MCP 请求，timeout 也不会自动重放可能产生副作用的 tool call。超出结果上限时只把有界预览交给模型，完整结果保存在本机私有 tool-result artifact。

## 安全边界

- MCP server 名称、命令和 URL 来自用户配置，不接受模型动态改写。
- `stdio` server 可以启动本地进程，应像命令执行一样审查来源和参数。
- 远程 MCP、网页和 Skill 下载内容都按不可信输入处理。
- MCP 工具仍经过 schema、权限和 workspace policy；它不能因为来自 server 就绕过 Core deny。
- 不要把 API Key 直接写进可提交的项目文件。MCP header 可以引用环境变量；插件页读取编辑配置时保留 `${ENV_NAME}`，并把 args、env、headers、URL 中其余字面字符串显示为 `[REDACTED]`，renderer 不会取得磁盘中的字面 credential。
- 保存时未改动的 `[REDACTED]` 只会从同一 server 和同一字段位置回填；没有旧值的掩码会被拒绝。输入新值会替换旧值，清空字段或删除 server 也会真实保存。
- `config.effective` / Diagnostics 会把 MCP args、env、headers、URL 整段脱敏，只显示 secret 来源；它与插件页的逐叶编辑掩码是两个不同的只读投影。

需要排查加载问题时，先看“插件 → MCP”的明确 state 与错误码，再检查配置 JSON、执行环境、server 日志和“设置 → 诊断”。
