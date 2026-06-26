# W08 · 子代理（SUB）

依赖：W05、W03　|　子系统映射：`agent/subagents/*` + dispatch runner（工具壳在 W04-TOOL-014）。

### MIG-SUB-001 · SubagentRegistry（白名单 + 规格）

- **功能点**：内置子代理白名单（工具集/max_turns/plan_readonly_explorer/description）、别名、模板加载。
- **源(Python)**：`agent/subagents/registry.py`（`SubagentRegistry`、`names`/`aliases`/`describe`）、`subagents/spec.py`（`SubagentSpec`）、`templates/subagents/*.md`。
- **目标(TS)**：`packages/core/src/subagents/registry.ts`、`subagents/spec.ts`。
- **依赖**：MIG-TOOL-012（skills 摘要注入）
- **设计**：registry 为事实来源（能力白名单在代码、模板只口吻）；身份：`xiaohuangmen`/`sili_suitang`/`dongchang_tanshi`/`shangbao_dianbu`/`verification_reviewer`/`neiguan_yingzao`；别名 `{general:neiguan_yingzao, researcher:dongchang_tanshi, reviewer:verification_reviewer}`。
- **风险/复杂度**：M。
- **验证**：移植 `test_agent_prompt_contracts.py`(subagent 部分)、`test_subagent_templates_match_registry`。**验收**：模板=registry、别名一致。
- **状态**：todo · PR: —

### MIG-SUB-002 · 子代理派遣 runner + 证据抽取

- **功能点**：用独立上下文跑子代理、回禀（结论/证据/风险/建议下一步）、证据抽取。
- **源(Python)**：`agent/tools/dispatch.py` 派遣逻辑 + `agent/runner_factory.py:build_routed_runner`。
- **目标(TS)**：`packages/core/src/subagents/dispatch-runner.ts`。
- **依赖**：MIG-CORE-010、MIG-SUB-001、MIG-TOOL-014
- **设计**：独立 registry（仅请求的工具）+ 独立 history + 压缩任务；回禀只回传一段总结；证据（文件/行号/URL）抽取；并发派遣（`run_coroutine_threadsafe`→TS Promise.all）；子代理不能再派子代理/改主 todolist。
- **风险/复杂度**：L。
- **验证**：移植 dispatch/subagent 集成单测。**验收**：派遣/证据/隔离一致。
- **状态**：todo · PR: —

### MIG-SUB-003 · 子代理模型路由接入

- **功能点**：reader/reviewer/researcher 走次模型，coder/neiguan 走主模型。
- **源(Python)**：`agent/model_router.py` 对子代理角色的路由。
- **目标(TS)**：接入 `model-router.ts`（W01）+ dispatch-runner。
- **依赖**：MIG-CFG-004、MIG-SUB-002
- **设计**：不在工具里手写主次判断，统一走 ModelRouter。
- **风险/复杂度**：S。
- **验证**：移植子代理路由单测。**验收**：角色路由一致。
- **状态**：todo · PR: —
