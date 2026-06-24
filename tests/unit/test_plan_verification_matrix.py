from __future__ import annotations

import pytest

from agent.control import ControlManager, ProposePlanTool
from agent.plans.evidence import assess_step_verification
from agent.plans.models import PlanStep
from agent.plans.verification import VerificationRequirement
from agent.tools.todo import TodoStore


def _manager_with_active_step(tmp_path, *, commands: list[str]) -> tuple[ControlManager, str]:
    manager = ControlManager(tmp_path)
    manager.set_todo_store(TodoStore())
    manager.set_mode("plan")
    ProposePlanTool(manager).execute(
        title="Verification matrix",
        summary="Require all verification requirements before completion.",
        plan_markdown="# Plan\n\n- Run matrix",
        steps=[
            {
                "id": "step_1",
                "title": "Run matrix",
                "description": "Execute required verification.",
                "files": ["agent/runner.py"],
                "commands": commands,
                "acceptance": ["verification requirements are satisfied"],
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


def test_all_required_legacy_commands_must_pass_before_completion(tmp_path) -> None:
    first = ".venv/bin/python -m pytest tests/unit/test_runner_state.py -q"
    second = ".venv/bin/python -m pytest tests/unit/test_plan_store.py -q"
    manager, plan_id = _manager_with_active_step(tmp_path, commands=[first, second])
    manager.record_plan_verification_result(
        plan_id=plan_id,
        step_id="step_1",
        result={"command": first, "passed": True, "summary": "first passed"},
    )

    with pytest.raises(ValueError, match="PLAN_EVIDENCE_REQUIRED"):
        manager.sync_plan_from_todos(
            [{"id": 1, "content": "Run matrix", "status": "completed"}],
            evidence={"source": "update_todos"},
        )

    manager.record_plan_verification_result(
        plan_id=plan_id,
        step_id="step_1",
        result={"command": second, "passed": True, "summary": "second passed"},
    )
    updated = manager.sync_plan_from_todos(
        [{"id": 1, "content": "Run matrix", "status": "completed"}],
        evidence={"source": "update_todos"},
    )

    assert updated.steps[0].status == "done"


def test_optional_command_failure_becomes_risk_note() -> None:
    step = PlanStep(
        id="step_1",
        title="Optional smoke",
        verification=[
            VerificationRequirement(
                id="optional_smoke",
                kind="command",
                required=False,
                command="npm run smoke",
                description="Optional smoke test.",
            )
        ],
        evidence=[{"command": "npm run smoke", "passed": False, "summary": "smoke failed"}],
    )

    assessment = assess_step_verification(step)

    assert assessment.blocking_errors == []
    assert assessment.risk_notes == ["optional_smoke failed: smoke failed"]


def test_manual_verification_requires_external_evidence() -> None:
    requirement = VerificationRequirement(
        id="manual_ui",
        kind="manual",
        required=True,
        description="User or reviewer confirms the UI manually.",
    )
    missing = PlanStep(id="step_1", title="Manual", verification=[requirement])
    passed = PlanStep(
        id="step_1",
        title="Manual",
        verification=[requirement],
        evidence=[{"requirement_id": "manual_ui", "passed": True, "summary": "reviewed in browser"}],
    )

    assert "manual_ui missing required evidence" in assess_step_verification(missing).blocking_errors
    assert assess_step_verification(passed).blocking_errors == []


def test_skipped_requirement_requires_reason() -> None:
    skipped_without_reason = PlanStep(
        id="step_1",
        title="Skip",
        verification=[
            VerificationRequirement(
                id="manual_skip",
                kind="manual",
                required=True,
                status="skipped",
                description="Manual check.",
            )
        ],
    )
    skipped_with_reason = PlanStep(
        id="step_1",
        title="Skip",
        verification=[
            VerificationRequirement(
                id="manual_skip",
                kind="manual",
                required=True,
                status="skipped",
                description="Manual check.",
                reason="not applicable to CLI-only change",
            )
        ],
    )

    assert "manual_skip skipped without reason" in assess_step_verification(skipped_without_reason).blocking_errors
    assert assess_step_verification(skipped_with_reason).blocking_errors == []
    assert assess_step_verification(skipped_with_reason).risk_notes == [
        "manual_skip skipped: not applicable to CLI-only change"
    ]
