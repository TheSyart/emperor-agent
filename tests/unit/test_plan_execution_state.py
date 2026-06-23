from __future__ import annotations

from agent.plans.execution import PlanExecutionState
from agent.plans.models import PlanRecord, PlanStatus, PlanStep, PlanStepStatus
from agent.tools.todo import TodoStore


def sample_plan() -> PlanRecord:
    return PlanRecord(
        id="plan_1",
        title="Build feature",
        summary="Two steps",
        status=PlanStatus.APPROVED.value,
        created_at=1.0,
        updated_at=1.0,
        steps=[
            PlanStep(id="step_1", title="Edit code"),
            PlanStep(id="step_2", title="Run tests"),
        ],
    )


def test_start_next_step_marks_single_active_step() -> None:
    state = PlanExecutionState(sample_plan())

    updated = state.start_next_step()

    assert updated.status == PlanStatus.EXECUTING.value
    assert updated.steps[0].status == PlanStepStatus.ACTIVE.value
    assert updated.steps[1].status == PlanStepStatus.PENDING.value


def test_complete_active_step_moves_to_next() -> None:
    state = PlanExecutionState(sample_plan())
    running = state.start_next_step()

    completed = PlanExecutionState(running).complete_step("step_1", evidence={"command": "pytest", "exit_code": 0})

    assert completed.status == PlanStatus.EXECUTING.value
    assert completed.steps[0].status == PlanStepStatus.DONE.value
    assert completed.steps[0].evidence == [{"command": "pytest", "exit_code": 0}]
    assert completed.steps[1].status == PlanStepStatus.PENDING.value


def test_fail_step_records_failed_status_and_evidence() -> None:
    running = PlanExecutionState(sample_plan()).start_next_step()

    failed = PlanExecutionState(running).fail_step(
        "step_1",
        evidence={"command": "pytest", "passed": False},
    )

    assert failed.status == PlanStatus.FAILED.value
    assert failed.steps[0].status == PlanStepStatus.FAILED.value
    assert failed.steps[0].evidence[-1] == {"command": "pytest", "passed": False}


def test_todo_store_syncs_from_plan_steps() -> None:
    running = PlanExecutionState(sample_plan()).start_next_step()
    store = TodoStore()

    result = store.sync_from_plan_steps([step.to_dict() for step in running.steps])

    assert "todos updated" in result
    assert store.todos == [
        {"id": 1, "plan_step_id": "step_1", "content": "Edit code", "status": "in_progress"},
        {"id": 2, "plan_step_id": "step_2", "content": "Run tests", "status": "pending"},
    ]
