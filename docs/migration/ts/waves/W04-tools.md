# W04 · 工具（TOOL）

依赖：W00　|　子系统映射：`agent/tools/*` + `agent/permissions/resolvers.py` 的命令判定。
对账：`tests/unit/test_tool_descriptions.py`、`test_run_command_readonly.py`、各工具单测。

### MIG-TOOL-001 · Tool 基类 + 参数 schema

- **功能点**：Tool 抽象、参数 schema 构造、能力标志、只读/破坏/路径判定。
- **源(Python)**：`agent/tools/base.py`（`Tool`、`tool_parameters` 装饰器、`read_only/exclusive/concurrency_safe/requires_runtime_context/max_result_chars`、`is_read_only`/`is_destructive`/`get_path`/`is_concurrency_safe`）、`schema.py`（`StringSchema`/`IntegerSchema`/…/`tool_parameters_schema`）。
- **目标(TS)**：`packages/core/src/tools/base.ts`、`tools/schema.ts`（用 zod 或手写 JSON schema）。
- **依赖**：MIG-FND-001
- **设计**：`name/description/parameters(JSON schema)`；能力标志默认值对齐；`isReadOnly(args)` 可被子类覆写。
- **风险/复杂度**：M。
- **验证**：移植 base/schema 单测。**验收**：schema 生成与能力默认一致。
- **状态**：todo · PR: —

### MIG-TOOL-002 · ToolResult / Artifact

- **功能点**：工具结果模型（model_content/display_summary/raw/artifacts/metadata/is_error）。
- **源(Python)**：`agent/tools/results.py`（`ToolResult`、`ToolArtifact`、`artifact_payloads`）。
- **目标(TS)**：`packages/core/src/tools/results.ts`。
- **依赖**：MIG-FND-001
- **设计**：字段逐一对齐；IPC 序列化友好。
- **风险/复杂度**：S。
- **验证**：vitest：结果构造/序列化。**验收**：字段齐全。
- **状态**：todo · PR: —

### MIG-TOOL-003 · ToolRegistry

- **功能点**：注册、生成 definitions（builtin+mcp 排序）、参数校验/转型、执行 + map_result + 错误提示。
- **源(Python)**：`agent/tools/registry.py`（`ToolRegistry.get_definitions`/`prepare_call`/`execute_result`/`execute`）。
- **目标(TS)**：`packages/core/src/tools/registry.ts`。
- **依赖**：MIG-TOOL-001,002,004
- **设计**：`get_definitions` 输出 `{name,description,input_schema}`，builtin 在前、`mcp_` 在后；`prepare_call` 校验存在/转型/约束；`execute_result` 注入执行上下文、调 `map_result`、错误加 hint、按 `max_result_chars` 截断。
- **风险/复杂度**：M。
- **验证**：移植 registry 校验/执行/排序 单测。**验收**：definitions 与执行语义一致。
- **状态**：todo · PR: —

### MIG-TOOL-004 · 执行上下文 + protocol/adapter

- **功能点**：ToolExecutionContext、ToolV2 协议、ToolAdapter、PreparedToolCall、执行引擎。
- **源(Python)**：`agent/tools/context.py`、`protocol.py`（`ToolV2`/`ToolAdapter`/`PreparedToolCall`）、`execution.py`（`ToolExecutionEngine`）。
- **目标(TS)**：`packages/core/src/tools/context.ts`、`protocol.ts`、`execution.ts`。
- **依赖**：MIG-TOOL-001
- **设计**：执行上下文持 root/arguments/turn_id/parent_call_id/emit/loop；adapter 桥接 `is_read_only/is_concurrency_safe/is_destructive/get_path`。
- **风险/复杂度**：M。
- **验证**：vitest：适配器代理调用。**验收**：上下文/适配一致。
- **状态**：todo · PR: —

### MIG-TOOL-005 · 命令判定 resolvers（is_readonly / low_risk / high_risk / sensitive_path）

- **功能点**：命令安全判定的纯函数集（被 shell 工具与权限管线共用）。
- **源(Python)**：`agent/permissions/resolvers.py`（`_safe_command_parts`、`is_low_risk_command`、`is_readonly_command`、`is_high_risk_command`/`HIGH_RISK_COMMAND`、`is_sensitive_path`、`scheduler_action`）。
- **目标(TS)**：`packages/core/src/permissions/command-resolvers.ts`。
- **依赖**：MIG-FND-001
- **设计**：shlex→TS 分词 + 元字符门；allowlist（pwd/ls/git status…）、low_risk（+pytest/npm test）、high_risk 正则、敏感路径（.env/.git/memory…）逐字保真。
- **风险/复杂度**：M（正则/分词口径必须一致）。
- **验证**：移植 `test_run_command_readonly.py` + 权限管线相关。**验收**：判定与 Python 逐例一致。
- **状态**：todo · PR: —

### MIG-TOOL-006 · ReadFileTool

- **功能点**：工作区内安全读文本/PDF/sidecar，`行号|内容`，offset/limit。
- **源(Python)**：`agent/tools/filesystem.py`（`ReadFileTool`、`_resolve` 禁闭、行号格式）。
- **目标(TS)**：`packages/core/src/tools/filesystem/read.ts`。
- **依赖**：MIG-TOOL-001
- **设计**：`_resolve` = expanduser+resolve 规范化后 `relative_to(workspace)` 禁闭；空文件/目录返回提示；行号格式 `N| line` 逐字。
- **风险/复杂度**：M。
- **验证**：移植 read_file 单测（禁闭、分页、格式）。**验收**：路径逃逸被挡、格式一致。
- **状态**：todo · PR: —

### MIG-TOOL-007 · WriteFileTool + EditFileTool

- **功能点**：创建/覆盖；局部替换（exact/trim/normalize 回退、replace_all、唯一性）。
- **源(Python)**：`agent/tools/filesystem.py`（`WriteFileTool`、`EditFileTool` 回退匹配）。
- **目标(TS)**：`packages/core/src/tools/filesystem/write.ts`、`edit.ts`。
- **依赖**：MIG-TOOL-006
- **设计**：edit 回退匹配顺序（精确→去空白→归一）、多处命中报错、replace_all 语义逐字。
- **风险/复杂度**：M。
- **验证**：移植 edit/write 单测（多匹配、回退、replace_all）。**验收**：匹配语义一致。
- **状态**：todo · PR: —

### MIG-TOOL-008 · GlobTool

- **功能点**：glob 找文件/目录、mtime 倒序、跳过噪声目录。
- **源(Python)**：`agent/tools/search.py`（`GlobTool`）。
- **目标(TS)**：`packages/core/src/tools/search/glob.ts`（用 `fast-glob`/`globby`）。
- **依赖**：MIG-TOOL-001
- **设计**：跳过 `.git/node_modules/__pycache__`；按 mtime 倒序。
- **风险/复杂度**：S。
- **验证**：移植 glob 单测。**验收**：排序/过滤一致。
- **状态**：todo · PR: —

### MIG-TOOL-009 · GrepTool

- **功能点**：正则/纯文本内容搜索、output_mode、上下文行、跳过二进制/>2MB。
- **源(Python)**：`agent/tools/search.py`（`GrepTool`）。
- **目标(TS)**：`packages/core/src/tools/search/grep.ts`（优先调系统 ripgrep，缺失回退 JS 扫描）。
- **依赖**：MIG-TOOL-001
- **设计**：output_mode（content/files_with_matches/count）、context_before/after、二进制/2MB 跳过、glob/type 过滤逐字。
- **风险/复杂度**：M。
- **验证**：移植 grep 单测。**验收**：三种模式/上下文一致。
- **状态**：todo · PR: —

### MIG-TOOL-010 · WebFetch

- **功能点**：抓 URL（文本/raw），SSRF 防护，重定向逐跳再校验。
- **源(Python)**：`agent/tools/web.py`（`WebFetch`、`_validate_public_http_url`、`_is_blocked_ip`、`_SafeRedirectHandler`）。
- **目标(TS)**：`packages/core/src/tools/web.ts`（`undici`/fetch + 自定义重定向处理）。
- **依赖**：MIG-TOOL-001
- **设计**：只允许 http/https；阻塞 localhost/私网/环回/链路本地/保留/多播；IP 字面值先校验；**每次重定向再校验**。不可信输入标记。
- **风险/复杂度**：M（SSRF 必须逐项对齐）。
- **验证**：移植 web_fetch SSRF/重定向 单测。**验收**：私网/重定向绕过被挡。
- **状态**：todo · PR: —

### MIG-TOOL-011 · RunCommand

- **功能点**：执行单条 shell、危险模式拒绝、最小 env、120s 超时、只读判定。
- **源(Python)**：`agent/tools/shell.py`（`RunCommand`、`_DENY_PATTERNS`、`_minimal_env`、`_cap_output`、`is_read_only`→`is_readonly_command`、`map_result`）。
- **目标(TS)**：`packages/core/src/tools/shell.ts`（`child_process.spawn`，shell=true）。
- **依赖**：MIG-TOOL-005
- **设计**：deny 正则（`rm -rf /`、curl/wget、`python -c`、管道到 sh/bash 等）逐字；最小环境变量集；120s 超时；输出 cap 20k；`is_read_only` 复用 MIG-TOOL-005；map_result 解析 exit code/timed_out。
- **风险/复杂度**：M。
- **验证**：移植 shell deny/超时/只读 单测 + `test_run_command_readonly.py`。**验收**：拒绝集/只读判定一致。
- **状态**：todo · PR: —

### MIG-TOOL-012 · LoadSkill + SkillsLoader

- **功能点**：按名加载 Skill 正文；frontmatter 解析；摘要注入；always-skills。
- **源(Python)**：`agent/tools/skills.py`（`LoadSkill`）、`agent/skills.py`（`SkillsLoader._parse_frontmatter`/`build_skills_summary`/`load_skills_for_context`/`get_content`）。
- **目标(TS)**：`packages/core/src/skills/loader.ts`、`tools/load-skill.ts`。
- **依赖**：MIG-TOOL-001
- **设计**：YAML frontmatter（name/description/tags/always）；摘要 `- **name**: desc [tags]` 截断 180；不绕过工具直读 SKILL.md。
- **风险/复杂度**：S。
- **验证**：移植 skills loader 单测。**验收**：摘要/加载一致。
- **状态**：todo · PR: —

### MIG-TOOL-013 · UpdateTodosTool + TodoStore

- **功能点**：全量覆盖 todo 列表、单一 in_progress、状态机。
- **源(Python)**：`agent/tools/todo.py`（`UpdateTodosTool`、`TodoStore`）。
- **目标(TS)**：`packages/core/src/tools/todo.ts`。
- **依赖**：MIG-TOOL-001
- **设计**：每次全量覆盖；至多一个 in_progress；状态 pending/in_progress/completed/blocked；active_form。
- **风险/复杂度**：S。
- **验证**：移植 todo 单测。**验收**：约束一致。
- **状态**：todo · PR: —

### MIG-TOOL-014 · DispatchSubagentTool（工具壳）

- **功能点**：派遣子代理的工具入口（契约字段、证据抽取、并发、plan-mode 只读约束）。
- **源(Python)**：`agent/tools/dispatch.py`（`DispatchSubagentTool`）。
- **目标(TS)**：`packages/core/src/tools/dispatch.ts`。
- **依赖**：MIG-TOOL-003、MIG-SUB-*（W08 提供子代理 registry/runner，工具壳先定接口）
- **设计**：必填 `agent_type`/`task`，可选 `expected_output`/`evidence_required`/`scope_limit`；任务文本拼装与证据抽取（文件/行号/URL）逐字；plan 模式仅允许只读探索子代理并强制三字段；并发派遣。
- **风险/复杂度**：M。
- **验证**：移植 `test_tool_descriptions.py`(dispatch) + dispatch 契约单测。**验收**：契约字段/证据抽取一致。
- **状态**：todo · PR: —
