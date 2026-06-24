from __future__ import annotations

from agent.control import ControlManager, ProposePlanTool
from agent.permissions import permission_argument_hash
from agent.tools.todo import TodoStore


def _approve_plan_with_command(tmp_path, command: str) -> tuple[ControlManager, str]:
    manager = ControlManager(tmp_path)
    manager.set_todo_store(TodoStore())
    manager.set_mode("plan")
    ProposePlanTool(manager).execute(
        title="Plan permission token",
        summary="Issue a one-use token for the active step command.",
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
    plan = manager.plan_store.latest()
    assert plan is not None
    return manager, plan.id


def test_approval_creates_one_use_token_for_active_step_command(tmp_path) -> None:
    command = ".venv/bin/python -m pytest tests/unit/test_runner_state.py -q"
    manager, plan_id = _approve_plan_with_command(tmp_path, command)

    plan = manager.plan_store.get(plan_id)
    assert plan is not None
    [token] = plan.metadata["permission_tokens"]
    assert token["plan_id"] == plan_id
    assert token["step_id"] == "step_1"
    assert token["tool_name"] == "run_command"
    assert token["argument_hash"] == permission_argument_hash({"command": command})
    assert token["uses_remaining"] == 1


def test_plan_permission_token_is_exact_and_consumed_once(tmp_path) -> None:
    command = ".venv/bin/python -m pytest tests/unit/test_runner_state.py -q"
    manager, plan_id = _approve_plan_with_command(tmp_path, command)

    drifted = manager.assess_permission(
        "run_command",
        {"command": "  .venv/bin/python   -m pytest tests/unit/test_runner_state.py -q  "},
        registry=None,
    )
    assert drifted.allowed
    assert drifted.rule != "plan.permission_token"
    assert manager.plan_store.get(plan_id).metadata["permission_tokens"]

    first = manager.assess_permission("run_command", {"command": command}, registry=None)
    second = manager.assess_permission("run_command", {"command": command}, registry=None)

    assert first.allowed
    assert first.rule == "plan.permission_token"
    assert second.allowed
    assert second.rule != "plan.permission_token"
    assert manager.plan_store.get(plan_id).metadata["permission_tokens"] == []


def test_plan_permission_tokens_are_revoked_on_failed_step_and_mode_switch(tmp_path) -> None:
    command = ".venv/bin/python -m pytest tests/unit/test_runner_state.py -q"
    manager, plan_id = _approve_plan_with_command(tmp_path, command)

    failed = manager.record_plan_verification_result(
        plan_id=plan_id,
        step_id="step_1",
        result={"command": command, "passed": False, "summary": "failed"},
    )
    assert failed is not None
    assert failed.metadata["permission_tokens"] == []

    manager, plan_id = _approve_plan_with_command(tmp_path / "mode", command)
    manager.set_mode("auto")
    assert manager.plan_store.get(plan_id).metadata["permission_tokens"] == []


def test_high_risk_plan_command_never_receives_permission_token(tmp_path) -> None:
    manager, plan_id = _approve_plan_with_command(tmp_path, "git push origin main")

    plan = manager.plan_store.get(plan_id)
    assert plan is not None
    assert plan.metadata["permission_tokens"] == []

    decision = manager.assess_permission("run_command", {"command": "git push origin main"}, registry=None)

    assert decision.requires_approval
    assert decision.rule == "ask.run_command.default_approval"
