# Agent Prompt 与工作流审计（2026-06-11）

## 结论

本次审计目标是以可靠执行为优先级，精简每轮固定 system prompt，并让可见工作流展示与 Ask/Plan 控制语义保持一致。

审计后固定 prompt 不含长期记忆约 4.7KB，主要由三部分组成：

- `templates/SOUL.md` + `templates/TOOL.md` + 用户档案：轻人格、协议边界、工具偏好。
- `templates/agent/identity.md`：执行契约、todolist、最终回禀、subagent 派遣。
- `templates/agent/skills_section.md`：Skill 名称、单句描述、tags。

## 冗余与风险

- 原 identity 每轮注入长篇 workspace 表格，信息可由 README / AGENTS / 代码事实发现，不应长期占用主上下文。
- Skill 摘要原先包含绝对路径和多段 description，容易把上下文预算花在按需 Skill 正文之外。
- `完善` / `优化` 作为孤立词触发 Ask Guard 过宽，小范围明确编辑会被不必要地打断。
- WebUI 的 thought 展示应只表达阶段和耗时，不能显示 `reasoning_content`、thinking blocks 或 chain-of-thought。

## 已保留的关键规则

- 普通自然语言最终回复保留轻量李公公人格和固定前缀。
- JSON、XML、工具参数、代码块、命令、压缩输出、Ask/Plan 协议和子代理内部回禀不加人格前缀。
- Skill 正文只能通过 `load_skill` 按需加载。
- 多步骤任务继续使用 `update_todos`，复杂 subagent 派遣必须写清 `expected_output`、`evidence_required`、`scope_limit`。
- Ask Guard 仍会在项目级重构、全链路优化、删除、发布、权限、成本等高影响歧义前强制确认。

## 验证建议

- `.venv/bin/python -m pytest tests/unit/test_agent_prompt_contracts.py tests/unit/test_control.py -q`
- `npm --prefix webui run build`
- `make check`

手动路径验证时，发送一个会触发读文件和工具调用的 WebUI 任务，确认页面只展示阶段耗时、工具卡片、Ask/Plan 卡片和最终答复，不展示隐藏推理内容。
