from __future__ import annotations

from agent.control import ControlManager, ProposePlanTool
from agent.tasks import SidechainTranscript, TaskKind, TaskManager, TaskStatus
from agent.tools.todo import TodoStore


def _approve_two_step_plan(tmp_path):
    manager = ControlManager(tmp_path)
    manager.set_todo_store(TodoStore())
    manager.set_task_manager(TaskManager(tmp_path))
    manager.set_mode("plan")
    ProposePlanTool(manager).execute(
        title="Plan task binding",
        summary="Bind plan steps to durable tasks.",
        plan_markdown="# Plan\n\n- Edit runner\n- Run tests",
        steps=[
            {
                "id": "step_1",
                "title": "Edit runner",
                "description": "Implement the first change.",
                "files": ["agent/runner.py"],
                "acceptance": ["runner change is present"],
            },
            {
                "id": "step_2",
                "title": "Run tests",
                "description": "Verify the change.",
                "files": ["tests/unit/test_runner_state.py"],
                "commands": [".venv/bin/python -m pytest tests/unit/test_runner_state.py -q"],
                "acceptance": ["tests pass"],
            },
        ],
        assumptions=[],
        risk_level="low",
    )
    pending = manager.payload()["pending"]
    manager.approve(pending["id"])
    plan = manager.plan_store.latest()
    assert plan is not None
    return manager, plan


def test_plan_approval_creates_plan_step_tasks(tmp_path) -> None:
    manager, plan = _approve_two_step_plan(tmp_path)

    mapping = plan.metadata["plan_step_tasks"]
    assert set(mapping) == {"step_1", "step_2"}
    records = {record.metadata["plan_step_id"]: record for record in manager.task_manager.store.list()}

    assert records["step_1"].kind == TaskKind.PLAN_STEP.value
    assert records["step_1"].status == TaskStatus.RUNNING.value
    assert records["step_1"].metadata == {
        "plan_id": plan.id,
        "plan_step_id": "step_1",
        "sequence": 1,
        "verification_status": "not_required",
    }
    assert records["step_2"].status == TaskStatus.QUEUED.value
    assert records["step_2"].metadata["sequence"] == 2
    assert records["step_2"].metadata["verification_status"] == "pending"


def test_plan_step_task_mapping_survives_restart(tmp_path) -> None:
    manager, plan = _approve_two_step_plan(tmp_path)
    restarted = ControlManager(tmp_path)
    restarted.set_task_manager(TaskManager(tmp_path))

    loaded = restarted.plan_store.get(plan.id)
    assert loaded is not None
    task_id = loaded.metadata["plan_step_tasks"]["step_1"]
    record = restarted.task_manager.store.get(task_id)

    assert record is not None
    assert record.metadata["plan_id"] == plan.id
    assert record.metadata["plan_step_id"] == "step_1"
    assert record.transcript_path.endswith("transcript.jsonl")


def test_plan_verification_appends_to_step_sidechain_and_updates_task(tmp_path) -> None:
    manager, plan = _approve_two_step_plan(tmp_path)
    task_id = plan.metadata["plan_step_tasks"]["step_1"]

    updated = manager.record_plan_step_tool_output(
        tool_name="edit_file",
        summary="Edited agent/runner.py",
        tool_call_id="call_edit",
        artifacts=[{"path": "agent/runner.py", "kind": "text"}],
    )

    assert updated is not None
    page = SidechainTranscript(tmp_path, task_id).read()
    assert page["messages"][0]["tool_name"] == "edit_file"
    assert page["messages"][0]["artifacts"][0]["path"] == "agent/runner.py"

    verified = manager.record_plan_verification_result(
        plan_id=plan.id,
        step_id="step_1",
        result={
            "source": "run_command",
            "command": ".venv/bin/python -m pytest tests/unit/test_runner_state.py -q",
            "passed": True,
            "summary": "tests passed",
        },
    )

    assert verified is not None
    record = manager.task_manager.store.get(task_id)
    assert record.progress["verification_status"] == "passed"
    page = SidechainTranscript(tmp_path, task_id).read()
    assert page["messages"][-1]["kind"] == "verification"
    assert page["messages"][-1]["passed"] is True
