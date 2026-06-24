from __future__ import annotations

import shutil
from pathlib import Path
from typing import Any

from agent.control import ControlManager, ControlMode
from agent.permissions import PermissionMode, PermissionPipeline
from agent.skills import SkillsLoader
from agent.subagents import SubagentRegistry
from agent.tasks import SidechainTranscript, TaskKind, TaskManager, TaskStatus
from agent.tools import ToolRegistry
from agent.tools.dispatch import DispatchSubagentTool

REPO_ROOT = Path(__file__).resolve().parents[2]


class FakeRunner:
    def __init__(self, captured: dict[str, Any], final: str) -> None:
        self.captured = captured
        self.final = final

    def step(self, history: list[dict[str, Any]]) -> str:
        self.captured["history"] = history
        return self.final


def _copy_templates(tmp_path: Path) -> Path:
    target = tmp_path / "templates"
    shutil.copytree(
        REPO_ROOT / "templates",
        target,
        ignore=shutil.ignore_patterns("USER.local.md"),
    )
    return target


def _tool(
    tmp_path: Path,
    *,
    captured: dict[str, Any] | None = None,
    final: str = "结论: 发现 runner 流程\n证据: agent/runner.py:10\n风险: 无\n建议下一步: 写计划",
    control_manager: ControlManager | None = None,
) -> DispatchSubagentTool:
    docs = _copy_templates(tmp_path)
    registry = SubagentRegistry(docs / "subagents", skills_loader=SkillsLoader(tmp_path / "skills"))
    parent_registry = ToolRegistry()
    manager = TaskManager(tmp_path)
    captured = captured if captured is not None else {}

    def runner_factory(**kwargs: Any) -> FakeRunner:
        captured["factory_task"] = kwargs.get("task")
        captured["spec"] = kwargs.get("spec")
        return FakeRunner(captured, final)

    return DispatchSubagentTool(
        client=None,
        model="",
        parent_registry=parent_registry,
        subagent_registry=registry,
        runner_factory=runner_factory,
        task_manager=manager,
        control_manager=control_manager,
    )


def test_registry_marks_only_readonly_explorers_for_plan_mode(tmp_path: Path) -> None:
    registry = SubagentRegistry(_copy_templates(tmp_path) / "subagents")

    assert registry.get("sili_suitang").plan_readonly_explorer is True
    assert registry.get("verification_reviewer").plan_readonly_explorer is True
    assert registry.get("dongchang_tanshi").plan_readonly_explorer is False
    assert registry.get("neiguan_yingzao").plan_readonly_explorer is False


def test_plan_mode_dispatch_requires_readonly_explorer_contract(tmp_path: Path) -> None:
    tool = _tool(tmp_path)
    registry = ToolRegistry()
    registry.register(tool)
    pipeline = PermissionPipeline()

    assert pipeline.is_tool_exposed(
        "dispatch_subagent",
        PermissionMode.PLAN.value,
        registry=registry,
    )

    allowed = pipeline.assess(
        "dispatch_subagent",
        {
            "agent_type": "sili_suitang",
            "task": "阅读 runner",
            "scope_limit": "只读 agent/runner.py",
            "expected_output": "流程摘要",
            "evidence_required": "文件路径和行号",
        },
        PermissionMode.PLAN.value,
        registry=registry,
    )
    missing_contract = pipeline.assess(
        "dispatch_subagent",
        {"agent_type": "sili_suitang", "task": "阅读 runner"},
        PermissionMode.PLAN.value,
        registry=registry,
    )
    write_capable = pipeline.assess(
        "dispatch_subagent",
        {
            "agent_type": "neiguan_yingzao",
            "task": "实现功能",
            "scope_limit": "只读",
            "expected_output": "建议",
            "evidence_required": "文件路径和行号",
        },
        PermissionMode.PLAN.value,
        registry=registry,
    )

    assert allowed.allowed
    assert allowed.rule == "plan.read_only"
    assert not missing_contract.allowed
    assert not write_capable.allowed


def test_dispatch_rejects_plan_exploration_without_required_contract(tmp_path: Path) -> None:
    control = ControlManager(tmp_path)
    control.set_mode(ControlMode.PLAN.value)
    tool = _tool(tmp_path, control_manager=control)

    result = tool.execute(agent_type="sili_suitang", task="阅读 runner")

    assert "Error:" in result
    assert "scope_limit" in result
    assert "expected_output" in result
    assert "evidence_required" in result


def test_readonly_plan_exploration_records_sidechain_and_discovery(tmp_path: Path) -> None:
    control = ControlManager(tmp_path)
    control.set_mode(ControlMode.PLAN.value)
    captured: dict[str, Any] = {}
    tool = _tool(tmp_path, captured=captured, control_manager=control)

    result = tool.execute(
        agent_type="sili_suitang",
        task="阅读 runner 执行链路",
        purpose="runner exploration",
        scope_limit="只读 agent/runner.py",
        expected_output="执行流程摘要",
        evidence_required="文件路径和行号",
        parent_call_id="call_1",
    )

    assert "结论: 发现 runner 流程" in result
    [record] = tool._task_manager.store.list()
    assert record.kind == TaskKind.SUBAGENT.value
    assert record.status == TaskStatus.COMPLETED.value
    assert record.metadata["plan_readonly_explorer"] is True
    page = SidechainTranscript(tmp_path, record.id).read()
    assert [item["role"] for item in page["messages"]] == ["user", "assistant"]
    assert "范围限制: 只读 agent/runner.py" in page["messages"][0]["content"]

    plan = control.plan_store.latest()
    assert plan is not None
    [discovery] = plan.draft.discoveries
    assert discovery["source"] == "dispatch_subagent:sili_suitang"
    assert discovery["files"] == ["agent/runner.py"]
    assert discovery["evidence_refs"] == [f"task:{record.id}", "agent/runner.py:10"]
    assert "发现 runner 流程" in discovery["summary"]
