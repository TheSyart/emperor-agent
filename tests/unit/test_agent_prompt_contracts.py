from __future__ import annotations

import shutil
from pathlib import Path
from typing import Any

from agent.context import ContextBuilder
from agent.skills import SkillsLoader
from agent.subagents import SubagentRegistry
from agent.tools import ToolRegistry
from agent.tools.dispatch import DispatchSubagentTool

REPO_ROOT = Path(__file__).resolve().parents[2]


class FakeMemory:
    def __init__(self, text: str):
        self.text = text
        self.memory_file = Path("memory/MEMORY.local.md")

    def read_memory(self) -> str:
        return self.text


class FakeRunner:
    def __init__(self, captured: dict[str, Any]):
        self.captured = captured

    def step(self, history: list[dict[str, Any]]) -> str:
        self.captured["history"] = history
        return "结论: done\n证据: fake\n风险: none\n建议下一步: none"


def _copy_templates(tmp_path: Path) -> Path:
    target = tmp_path / "templates"
    shutil.copytree(
        REPO_ROOT / "templates",
        target,
        ignore=shutil.ignore_patterns("USER.local.md"),
    )
    return target


def _write_skill(root: Path) -> None:
    skill_dir = root / "audit"
    skill_dir.mkdir(parents=True)
    (skill_dir / "SKILL.md").write_text(
        "---\nname: audit\ndescription: Audit code.\ntags: code,quality\n---\n\n# Audit\n",
        encoding="utf-8",
    )


def test_system_prompt_uses_code_backed_skill_and_subagent_contracts(tmp_path: Path) -> None:
    docs = _copy_templates(tmp_path)
    skills_dir = tmp_path / "skills"
    _write_skill(skills_dir)
    loader = SkillsLoader(skills_dir)
    registry = SubagentRegistry(docs / "subagents", skills_loader=loader)
    builder = ContextBuilder(
        docs,
        loader,
        memory=FakeMemory("记忆-" * 120),
        memory_budget_chars=80,
    )
    builder.set_subagent_registry(registry)

    prompt = builder.build_system_prompt()
    sections = builder.build_sections()

    assert "调用 `load_skill` 工具" in prompt
    assert "read_file 工具读取其 SKILL.md" not in prompt
    assert "source=`" not in prompt
    assert str(skills_dir) not in prompt
    assert "由 `SubagentRegistry` 动态注入" in prompt
    assert "xiaohuangmen" in prompt
    assert "researcher.md" not in prompt
    assert "奉天承运皇帝诏曰" in prompt
    assert "轻量宫廷口吻" in prompt
    assert "机器可读内容不得加此前缀" in prompt
    assert "结论：直接说明办成什么" in prompt
    assert "不要向用户展示隐藏推理" in prompt
    for phrase in (
        "专用工具优先",
        "并行工具调用",
        "范围克制",
        "提示注入",
        "失败后诊断",
        "被拒工具",
        "验证后完成",
        "风险操作先确认",
        "授权范围化",
        "同一时间只许一项 `in_progress`",
    ):
        assert phrase in prompt
    assert "复杂独立任务必须写清" in prompt
    fixed_prompt_chars = sum(len(section.content) for section in sections if section.name != "long_term_memory")
    assert fixed_prompt_chars < 7_000
    memory_section = next(section for section in sections if section.name == "long_term_memory")
    assert memory_section.budget_chars == 80
    assert "clipped by ContextBuilder" in memory_section.content
    assert next(section for section in sections if section.name == "bootstrap").version


def test_subagent_templates_match_registry_fact_source(tmp_path: Path) -> None:
    docs = _copy_templates(tmp_path)
    registry = SubagentRegistry(docs / "subagents", skills_loader=SkillsLoader(tmp_path / "skills"))
    template_names = {path.stem for path in (docs / "subagents").glob("*.md")}

    assert template_names == set(registry.names())
    assert registry.aliases() == {
        "general": "neiguan_yingzao",
        "researcher": "dongchang_tanshi",
        "reviewer": "verification_reviewer",
    }


def test_dispatch_subagent_accepts_optional_task_contract_fields(tmp_path: Path) -> None:
    docs = _copy_templates(tmp_path)
    registry = SubagentRegistry(docs / "subagents")
    captured: dict[str, Any] = {}

    def runner_factory(**kwargs: Any) -> FakeRunner:
        captured["factory_task"] = kwargs.get("task")
        return FakeRunner(captured)

    tool = DispatchSubagentTool(
        client=None,
        model="",
        parent_registry=ToolRegistry(),
        subagent_registry=registry,
        runner_factory=runner_factory,
    )

    assert tool.parameters["required"] == ["agent_type", "task"]

    result = tool.execute(
        agent_type="sili_suitang",
        task="阅读核心流程",
        expected_output="模块流程清单",
        evidence_required="文件路径和行号",
        scope_limit="只读, 不改文件",
    )

    assert "结论: done" in result
    task = captured["factory_task"]
    assert "期望产物: 模块流程清单" in task
    assert "证据要求: 文件路径和行号" in task
    assert "范围限制: 只读, 不改文件" in task
    assert "最终回禀必须包含" in task
    assert captured["history"][0]["content"] == task
