from __future__ import annotations

from typing import Any

from agent.permissions import PermissionMode, PermissionPipeline
from agent.tools import Tool, ToolRegistry


class DynamicTool(Tool):
    name = "dynamic_tool"
    description = "A mixed tool whose read-only status depends on action."
    parameters = {
        "type": "object",
        "properties": {"action": {"type": "string"}},
        "required": ["action"],
    }

    def is_read_only(self, arguments: dict[str, Any]) -> bool:
        return arguments.get("action") == "inspect"

    def execute(self, **kwargs) -> str:
        return "ok"


def test_permission_pipeline_returns_rule_trace_for_high_risk_command() -> None:
    pipeline = PermissionPipeline()

    decision = pipeline.assess(
        "run_command",
        {"command": "git push origin main"},
        PermissionMode.ASK_BEFORE_EDIT.value,
    )

    assert decision.requires_approval
    assert decision.rule == "ask.high_risk_command"
    assert [item.rule for item in decision.trace] == ["mode.resolve", "ask.high_risk_command"]


def test_permission_pipeline_supports_argument_level_plan_read_only() -> None:
    registry = ToolRegistry()
    registry.register(DynamicTool())
    pipeline = PermissionPipeline()

    inspect = pipeline.assess(
        "dynamic_tool",
        {"action": "inspect"},
        PermissionMode.PLAN.value,
        registry=registry,
    )
    mutate = pipeline.assess(
        "dynamic_tool",
        {"action": "mutate"},
        PermissionMode.PLAN.value,
        registry=registry,
    )

    assert inspect.allowed
    assert inspect.rule == "plan.read_only"
    assert not mutate.allowed
    assert mutate.rule == "plan.write_block"


def test_permission_pipeline_denies_propose_plan_outside_plan_mode() -> None:
    decision = PermissionPipeline().assess(
        "propose_plan",
        {"title": "Plan", "summary": "x", "plan_markdown": "- Do it"},
        PermissionMode.ASK_BEFORE_EDIT.value,
    )

    assert not decision.allowed
    assert decision.rule == "control.propose_plan"
