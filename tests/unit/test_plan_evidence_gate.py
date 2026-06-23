from __future__ import annotations

from pathlib import Path
from typing import Any

import pytest

from agent.control import ControlManager, ProposePlanTool
from agent.plans.models import PlanStepStatus
from agent.providers.base import LLMProvider, LLMResponse, ToolCallRequest
from agent.runner import AgentRunner
from agent.tools import ToolRegistry, UpdateTodosTool
from agent.tools.todo import TodoStore


class FakeProvider(LLMProvider):
    def __init__(self, responses: list[LLMResponse]) -> None:
        super().__init__(default_model="fake")
        self.responses = responses

    async def chat(self, **kwargs: Any) -> LLMResponse:
        if self.responses:
            return self.responses.pop(0)
        return LLMResponse(content="done")


def make_executing_plan(tmp_path: Path) -> tuple[ControlManager, TodoStore, str, str]:
    manager = ControlManager(tmp_path)
    todo_store = TodoStore()
    manager.set_todo_store(todo_store)
    manager.set_mode("plan")
    command = ".venv/bin/python -m pytest tests/unit/test_plan_evidence_gate.py -q"
    tool = ProposePlanTool(manager)
    tool.execute(
        title="Evidence gate",
        summary="Require verification before completion",
        plan_markdown="# Plan\n\n- Run verification before completion",
        steps=[
            {
                "id": "step_1",
                "title": "Run verification before completion",
                "description": "Ensure todo completion cannot outrun verification evidence.",
                "files": ["agent/control/manager.py", "tests/unit/test_plan_evidence_gate.py"],
                "commands": [command],
                "acceptance": ["completion is rejected until the command passes"],
                "risk": "low",
            }
        ],
        assumptions=[],
        risk_level="low",
    )
    pending = manager.payload()["pending"]
    plan_id = pending["meta"]["plan_id"]
    manager.approve(pending["id"])
    return manager, todo_store, plan_id, command


def test_completion_requires_passing_verification_for_command_step(tmp_path: Path) -> None:
    manager, _, plan_id, _ = make_executing_plan(tmp_path)

    with pytest.raises(ValueError, match="PLAN_EVIDENCE_REQUIRED"):
        manager.sync_plan_from_todos([
            {
                "id": 1,
                "plan_step_id": "step_1",
                "content": "Run verification before completion",
                "status": "completed",
            }
        ])

    saved = manager.plan_store.get(plan_id)
    assert saved.steps[0].status == PlanStepStatus.ACTIVE.value
    assert saved.steps[0].evidence == []


def test_failed_verification_prevents_completion(tmp_path: Path) -> None:
    manager, _, plan_id, command = make_executing_plan(tmp_path)
    manager.record_plan_verification_result(
        plan_id=plan_id,
        step_id="step_1",
        result={
            "source": "run_command",
            "command": command,
            "passed": False,
            "summary": "failed tests",
        },
    )

    with pytest.raises(ValueError, match="PLAN_EVIDENCE_FAILED"):
        manager.sync_plan_from_todos([
            {
                "id": 1,
                "plan_step_id": "step_1",
                "content": "Run verification before completion",
                "status": "completed",
            }
        ])

    saved = manager.plan_store.get(plan_id)
    assert saved.steps[0].status == PlanStepStatus.FAILED.value


def test_passing_verification_allows_completion_with_explicit_step_identity(tmp_path: Path) -> None:
    manager, _, plan_id, command = make_executing_plan(tmp_path)
    manager.record_plan_verification_result(
        plan_id=plan_id,
        step_id="step_1",
        result={
            "source": "run_command",
            "command": command,
            "passed": True,
            "summary": "1 passed",
        },
    )

    updated = manager.sync_plan_from_todos([
        {
            "id": 9,
            "plan_step_id": "step_1",
            "content": "Run verification before completion",
            "status": "completed",
        }
    ], evidence={"source": "update_todos", "summary": "todos updated"})

    assert updated.id == plan_id
    assert updated.steps[0].status == PlanStepStatus.DONE.value
    assert updated.steps[0].evidence[-1]["source"] == "update_todos"


def test_blocked_step_requires_reason(tmp_path: Path) -> None:
    manager, _, plan_id, _ = make_executing_plan(tmp_path)

    with pytest.raises(ValueError, match="PLAN_BLOCKED_REASON_REQUIRED"):
        manager.sync_plan_from_todos([
            {
                "id": 1,
                "plan_step_id": "step_1",
                "content": "Run verification before completion",
                "status": "blocked",
            }
        ])

    updated = manager.sync_plan_from_todos([
        {
            "id": 1,
            "plan_step_id": "step_1",
            "content": "Run verification before completion",
            "status": "blocked",
            "blocked_reason": "Waiting for credentials from the user.",
        }
    ])

    assert updated.id == plan_id
    assert updated.steps[0].status == PlanStepStatus.BLOCKED.value
    assert updated.steps[0].evidence[-1]["blocked_reason"] == "Waiting for credentials from the user."


@pytest.mark.anyio
async def test_runner_returns_tool_error_when_todo_completion_lacks_evidence(tmp_path: Path) -> None:
    manager, todo_store, plan_id, _ = make_executing_plan(tmp_path)
    registry = ToolRegistry()
    registry.register(UpdateTodosTool(todo_store))
    runner = AgentRunner(
        provider=FakeProvider([
            LLMResponse(
                content="",
                tool_calls=[
                    ToolCallRequest(
                        id="call_1",
                        name="update_todos",
                        arguments={
                            "todos": [
                                {
                                    "id": 1,
                                    "plan_step_id": "step_1",
                                    "content": "Run verification before completion",
                                    "status": "completed",
                                }
                            ]
                        },
                    )
                ],
                finish_reason="tool_calls",
            ),
            LLMResponse(content="我需要先运行验证。"),
        ]),
        model="fake",
        registry=registry,
        system_prompt="system",
        todo_store=todo_store,
        control_manager=manager,
        max_turns=2,
    )
    history = [{"role": "user", "content": "execute approved plan"}]
    emitted: list[dict[str, Any]] = []

    async def emit(event: dict[str, Any]) -> None:
        emitted.append(event)

    await runner.step_async(history, emit=emit)

    tool_message = next(message for message in history if message.get("role") == "tool")
    assert "PLAN_EVIDENCE_REQUIRED" in tool_message["content"]
    saved = manager.plan_store.get(plan_id)
    assert saved.steps[0].status == PlanStepStatus.ACTIVE.value
    assert todo_store.todos[0]["status"] == "in_progress"
    tool_result = next(event for event in emitted if event.get("event") == "tool_result")
    assert tool_result["todos"][0]["plan_step_id"] == "step_1"
    assert tool_result["todos"][0]["status"] == "in_progress"
