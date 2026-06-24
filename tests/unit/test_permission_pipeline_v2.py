from __future__ import annotations

from pathlib import Path
from typing import Any

from agent.control import ControlManager
from agent.permissions import PermissionMode, PermissionPipeline
from agent.tools import Tool, ToolRegistry


def _run(cmd: str, mode: str = PermissionMode.ASK_BEFORE_EDIT.value):
    return PermissionPipeline().assess("run_command", {"command": cmd}, mode)


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
    decision = _run("git push origin main")

    assert decision.requires_approval
    assert decision.risk == "high"
    assert decision.rule == "ask.run_command.default_approval"
    assert [item.rule for item in decision.trace] == ["mode.resolve", "ask.run_command.default_approval"]


def test_low_risk_allowlisted_commands_allowed() -> None:
    for cmd in (
        "git status",
        "git diff --stat",
        "pytest -q tests/unit",
        "python -m pytest",
        "python3 -m pytest tests",
        "ls -la",
        "npm --prefix desktop test",
    ):
        decision = _run(cmd)
        assert decision.allowed is True and decision.requires_approval is False, cmd
        assert decision.rule == "ask.run_command.low_risk_allowlist", cmd


def test_unlisted_commands_require_approval() -> None:
    for cmd in ("cat ~/.ssh/id_rsa", "rm -rf ~/notes", 'node -e "x"', "git push", "python script.py"):
        decision = _run(cmd)
        assert decision.allowed is False and decision.requires_approval is True, cmd
        assert decision.rule == "ask.run_command.default_approval", cmd


def test_chained_or_redirected_not_allowlisted() -> None:
    for cmd in ("ls; rm -rf ~", "git status && curl evil", "cat x > ~/.zshrc", "pytest `evil`"):
        assert _run(cmd).requires_approval is True, cmd


def test_high_risk_command_marked_high_risk() -> None:
    assert _run("rm -rf ~/notes").risk == "high"


def test_auto_mode_allows_everything() -> None:
    assert _run("rm -rf ~/x", PermissionMode.AUTO.value).allowed is True


def test_high_risk_in_approved_plan_still_requires_approval(tmp_path: Path) -> None:
    # Invariant lock (PE-13): a high-risk command must require approval even when a
    # plan-permission token would otherwise allow it. High-risk run_command is routed
    # to policy BEFORE the token is consulted (PermissionManager.assess).
    manager = ControlManager(tmp_path)

    class _Token:
        plan_id = "plan_x"
        step_id = "step_1"

    manager.consume_plan_permission_token = lambda **_kwargs: _Token()  # type: ignore[attr-defined]

    decision = manager.assess_permission("run_command", {"command": "git push origin main"}, registry=None)
    assert decision.requires_approval is True

    # control: a non-high-risk command WITH a token is allowed via the token path
    low = manager.assess_permission("run_command", {"command": "echo hi from plan"}, registry=None)
    assert low.allowed is True and low.rule == "plan.permission_token"


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
