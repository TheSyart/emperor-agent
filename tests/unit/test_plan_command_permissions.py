from __future__ import annotations

from agent.control import ControlManager, ProposePlanTool
from agent.tools.todo import TodoStore


def approve_plan_with_command(tmp_path, command: str) -> ControlManager:
    manager = ControlManager(tmp_path)
    manager.set_todo_store(TodoStore())
    manager.set_mode("plan")
    tool = ProposePlanTool(manager)
    tool.execute(
        title="Plan command permission",
        summary="Allow approved verification command without repeated approval.",
        plan_markdown="# Plan\n\n- Run focused verification",
        steps=[
            {
                "id": "step_1",
                "title": "Run focused verification",
                "description": "Execute the exact verification command from the approved plan.",
                "files": ["agent/runner.py"],
                "commands": [command],
                "acceptance": ["the focused verification command runs"],
                "risk": "low",
            }
        ],
        assumptions=[],
        risk_level="low",
    )
    pending = manager.payload()["pending"]
    manager.approve(pending["id"])
    return manager


def test_approved_plan_command_gets_explicit_permission_rule(tmp_path) -> None:
    command = ".venv/bin/python -m pytest tests/unit/test_runner_state.py -q"
    manager = approve_plan_with_command(tmp_path, command)

    decision = manager.assess_permission(
        "run_command",
        {"command": "  .venv/bin/python   -m pytest tests/unit/test_runner_state.py -q  "},
        registry=None,
    )

    assert decision.allowed
    assert decision.rule == "plan.approved_command"


def test_approved_plan_command_does_not_bypass_high_risk_shell_approval(tmp_path) -> None:
    manager = approve_plan_with_command(tmp_path, "git push origin main")

    decision = manager.assess_permission(
        "run_command",
        {"command": "git push origin main"},
        registry=None,
    )

    assert decision.requires_approval
    assert decision.rule == "ask.high_risk_command"


def test_approved_plan_files_do_not_auto_allow_sensitive_writes(tmp_path) -> None:
    manager = approve_plan_with_command(tmp_path, ".venv/bin/python -m pytest tests/unit/test_runner_state.py -q")

    decision = manager.assess_permission(
        "write_file",
        {"path": "memory/secret.txt", "content": "x"},
        registry=None,
    )

    assert decision.requires_approval
    assert decision.rule == "ask.sensitive_path"
