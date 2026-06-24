"""PE-18 Project Execution smoke gate.

Drives the full closed loop end-to-end through the real runner + control manager:
required-style plan -> approve -> execute -> verification FAIL -> repair (PASS)
-> step DONE / plan COMPLETED -> independent reviewer verdict recorded
-> simulated restart recovery.
"""

from __future__ import annotations

from pathlib import Path

import pytest

from agent.control import ControlManager, ProposePlanTool
from agent.plans.models import PlanStatus, PlanStepStatus
from agent.providers.base import LLMProvider, LLMResponse, ToolCallRequest
from agent.runner import AgentRunner
from agent.tools import Tool, ToolRegistry, UpdateTodosTool
from agent.tools.dispatch import DispatchSubagentTool
from agent.tools.todo import TodoStore

COMMAND = ".venv/bin/python -m pytest tests/unit/test_plan_store.py -q"


class FakeProvider(LLMProvider):
    def __init__(self, responses: list[LLMResponse]) -> None:
        super().__init__(default_model="fake")
        self.responses = responses

    async def chat(self, **kwargs) -> LLMResponse:
        if self.responses:
            return self.responses.pop(0)
        return LLMResponse(content="done")


class SequenceCommandTool(Tool):
    """run_command stub whose output advances per call so one command can fail then pass."""

    name = "run_command"
    description = "fake command tool"
    exclusive = True
    parameters = {
        "type": "object",
        "properties": {"command": {"type": "string"}},
        "required": ["command"],
    }

    def __init__(self, outputs: dict[str, list[str]]) -> None:
        self.outputs = {key: list(value) for key, value in outputs.items()}

    def execute(self, command: str) -> str:
        seq = self.outputs[command]
        return seq.pop(0) if len(seq) > 1 else seq[0]


def _quality_step() -> dict[str, object]:
    return {
        "id": "step_1",
        "title": "Run tests",
        "description": "Run the focused suite and verify it passes.",
        "files": ["tests/unit/test_plan_store.py"],
        "commands": [COMMAND],
        "acceptance": ["focused tests pass"],
    }


async def _noop(_event: dict) -> None:
    return None


@pytest.mark.anyio
async def test_project_execution_closed_loop(tmp_path: Path) -> None:
    # --- Stage A: propose + approve a structured plan -> first step active ---
    manager = ControlManager(tmp_path)
    todo_store = TodoStore()
    manager.set_todo_store(todo_store)
    manager.set_mode("plan")
    ProposePlanTool(manager).execute(
        title="Project work",
        summary="Implement and verify the change",
        plan_markdown="# Plan\n\n- Run tests",
        steps=[_quality_step()],
        assumptions=[],
        risk_level="low",
    )
    pending = manager.payload()["pending"]
    plan_id = pending["meta"]["plan_id"]
    manager.approve(pending["id"])

    approved = manager.plan_store.get(plan_id)
    assert approved is not None
    assert approved.status == PlanStatus.EXECUTING.value
    assert approved.steps[0].status == PlanStepStatus.ACTIVE.value

    # --- Stages B+C: one runner drives fail -> repair -> complete ---
    registry = ToolRegistry()
    registry.register(
        SequenceCommandTool({COMMAND: ["Error: command exited with code 2\nfailing", "2 passed"]})
    )
    registry.register(UpdateTodosTool(todo_store))
    runner = AgentRunner(
        provider=FakeProvider([
            # Stage B: command fails -> step FAILED + PLAN_VERIFICATION_FAILED follow-up
            LLMResponse(
                content="",
                tool_calls=[ToolCallRequest(id="c1", name="run_command", arguments={"command": COMMAND})],
                finish_reason="tool_calls",
            ),
            # Stage C1: re-activate the failed step before repairing it
            LLMResponse(
                content="",
                tool_calls=[
                    ToolCallRequest(
                        id="c2",
                        name="update_todos",
                        arguments={"todos": [{"id": 1, "content": "Run tests", "status": "in_progress"}]},
                    )
                ],
                finish_reason="tool_calls",
            ),
            # Stage C2: re-run command, now passes -> passing evidence on the active step
            LLMResponse(
                content="",
                tool_calls=[ToolCallRequest(id="c3", name="run_command", arguments={"command": COMMAND})],
                finish_reason="tool_calls",
            ),
            # Stage C3: mark the todo complete -> step DONE, plan COMPLETED
            LLMResponse(
                content="",
                tool_calls=[
                    ToolCallRequest(
                        id="c4",
                        name="update_todos",
                        arguments={"todos": [{"id": 1, "content": "Run tests", "status": "completed"}]},
                    )
                ],
                finish_reason="tool_calls",
            ),
            LLMResponse(content="all done"),
        ]),
        model="fake",
        registry=registry,
        system_prompt="system",
        control_manager=manager,
        todo_store=todo_store,
        max_turns=8,
    )
    await runner.step_async([{"role": "user", "content": "execute the approved plan"}], emit=_noop)

    completed = manager.plan_store.get(plan_id)
    assert completed is not None
    assert completed.steps[0].status == PlanStepStatus.DONE.value
    assert completed.status == PlanStatus.COMPLETED.value
    # the step carries a passing command evidence from the repair run
    assert any(item.get("passed") is True for item in completed.steps[0].evidence)

    # plan is finished -> eligible for independent review
    assert manager.reviewable_plan_id() == plan_id

    # --- Stage D: reviewer subagent verdict converges into the plan record ---
    dispatch = DispatchSubagentTool(
        client=None,
        model="fake",
        parent_registry=None,
        subagent_registry=None,
        runner_factory=None,
        control_manager=manager,
    )

    class _Spec:
        name = "verification_reviewer"

    class _Task:
        id = "subagent_rev"
        transcript_path = "memory/tasks/subagent_rev/transcript.jsonl"

    final = (
        "复核完成。\n```verdict\n"
        '{"passed": true, "summary": "all checks pass", '
        f'"commands": ["{COMMAND}"], '
        f'"command_evidence": [{{"command": "{COMMAND}", "exit_code": 0}}]}}\n```'
    )
    reviewed = dispatch._record_independent_verification(spec=_Spec(), task_record=_Task(), final=final)
    assert reviewed is not None
    latest = reviewed.metadata["independent_verification_latest"]
    assert latest["passed"] is True
    assert latest["task_id"] == "subagent_rev"
    assert latest["transcript_path"].endswith("transcript.jsonl")
    # with a PASS + command evidence on record, the reviewer nudge no longer blocks completion
    assert manager.plan_independent_verification_followup() is None

    # --- Stage E: simulated restart -> plan + verdict reload from disk (runtime replay) ---
    restarted = ControlManager(tmp_path)
    reloaded = restarted.plan_store.get(plan_id)
    assert reloaded is not None
    assert reloaded.status == PlanStatus.COMPLETED.value
    assert reloaded.steps[0].status == PlanStepStatus.DONE.value
    reloaded_latest = reloaded.metadata["independent_verification_latest"]
    assert reloaded_latest["passed"] is True
    assert reloaded_latest["task_id"] == "subagent_rev"
