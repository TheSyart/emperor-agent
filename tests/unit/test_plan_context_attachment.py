from __future__ import annotations

from dataclasses import replace
from pathlib import Path
from typing import Any

import pytest

from agent.context_pipeline.pipeline import ContextPipeline
from agent.control import ControlManager, ProposePlanTool
from agent.plans.context import PlanContextBuilder
from agent.plans.models import PlanStatus, PlanStepStatus
from agent.providers.base import LLMProvider, LLMResponse
from agent.runner import AgentRunner
from agent.tools import ToolRegistry
from agent.tools.todo import TodoStore


class CapturingProvider(LLMProvider):
    def __init__(self) -> None:
        super().__init__(default_model="fake")
        self.seen_messages: list[list[dict[str, Any]]] = []

    async def chat(self, **kwargs: Any) -> LLMResponse:
        self.seen_messages.append(kwargs.get("messages") or [])
        return LLMResponse(content="done")


def make_running_plan(manager: ControlManager, todo_store: TodoStore | None = None) -> str:
    if todo_store is not None:
        manager.set_todo_store(todo_store)
    manager.set_mode("plan")
    tool = ProposePlanTool(manager)
    tool.execute(
        title="Runtime recovery",
        summary="Keep executing plan visible after context projection",
        plan_markdown="# Plan\n\n- Continue active step\n- Fix failed step\n- Wait for credentials",
        steps=[
            {
                "id": "step_1",
                "title": "Continue active step",
                "description": "Carry active step through context projection.",
                "files": ["agent/context_pipeline/pipeline.py"],
                "commands": [".venv/bin/python -m pytest tests/unit/test_plan_context_attachment.py -q"],
                "acceptance": ["active step appears in plan runtime context"],
                "risk": "low",
            },
            {
                "id": "step_2",
                "title": "Fix failed step",
                "description": "Expose failed evidence summary.",
                "files": ["agent/plans/context.py"],
                "commands": [".venv/bin/python -m pytest tests/unit/test_plan_runtime.py -q"],
                "acceptance": ["failed evidence summary appears in context"],
                "risk": "low",
            },
            {
                "id": "step_3",
                "title": "Wait for credentials",
                "description": "Expose blocked reason.",
                "files": ["agent/control/manager.py"],
                "acceptance": ["blocked reason appears in context"],
                "risk": "low",
            },
        ],
        assumptions=[],
        risk_level="low",
    )
    pending = manager.payload()["pending"]
    plan_id = pending["meta"]["plan_id"]
    manager.approve(pending["id"])
    record = manager.plan_store.get(plan_id)
    manager.plan_store.save(replace(
        record,
        status=PlanStatus.EXECUTING.value,
        steps=[
            replace(record.steps[0], status=PlanStepStatus.ACTIVE.value),
            replace(
                record.steps[1],
                status=PlanStepStatus.FAILED.value,
                evidence=[{
                    "source": "run_command",
                    "command": ".venv/bin/python -m pytest tests/unit/test_plan_runtime.py -q",
                    "passed": False,
                    "summary": "1 failed in plan runtime",
                    "artifact_path": "memory/tool-results/failed.log",
                }],
            ),
            replace(
                record.steps[2],
                status=PlanStepStatus.BLOCKED.value,
                evidence=[{
                    "source": "update_todos",
                    "blocked_reason": "Waiting for API credentials.",
                }],
            ),
        ],
    ))
    return plan_id


def test_plan_context_builder_summarizes_executing_plan(tmp_path: Path) -> None:
    manager = ControlManager(tmp_path)
    plan_id = make_running_plan(manager)
    record = manager.plan_store.get(plan_id)
    manager.plan_store.save(replace(
        record,
        draft=replace(
            record.draft,
            open_questions=[{"id": "scope", "question": "是否包含 WebUI 恢复？"}],
            relevant_files=["agent/runner.py"],
        ),
    ))

    message = PlanContextBuilder(manager.plan_store).message_for([
        {"role": "user", "content": "continue the approved plan"}
    ])
    content = message["content"]

    assert message["role"] == "system"
    assert "[PLAN_RUNTIME_CONTEXT]" in content
    assert f"plan_id: {plan_id}" in content
    assert "title: Runtime recovery" in content
    assert "status: executing" in content
    assert "active_step: step_1 [active] Continue active step" in content
    assert "failed_step: step_2 [failed] Fix failed step" in content
    assert "latest_evidence: 1 failed in plan runtime" in content
    assert "pending_steps: 1" in content
    assert "open_question: scope 是否包含 WebUI 恢复？" in content
    assert "blocked_reason: Waiting for API credentials." in content
    assert "file: agent/runner.py" in content
    assert "file: agent/context_pipeline/pipeline.py" in content
    assert "artifact: memory/tool-results/failed.log" in content


def test_completed_plan_context_only_injected_when_user_asks(tmp_path: Path) -> None:
    manager = ControlManager(tmp_path)
    plan_id = make_running_plan(manager)
    record = manager.plan_store.get(plan_id)
    manager.plan_store.save(replace(record, status=PlanStatus.COMPLETED.value))
    builder = PlanContextBuilder(manager.plan_store)

    assert builder.message_for([{"role": "user", "content": "start a new task"}]) is None

    message = builder.message_for([{"role": "user", "content": "回顾一下刚才的计划历史"}])
    assert message is not None
    assert "status: completed" in message["content"]
    assert f"plan_id: {plan_id}" in message["content"]


def test_context_pipeline_injects_plan_context_before_history() -> None:
    projection = ContextPipeline(
        plan_context_provider=lambda history: {"role": "system", "content": "[PLAN_RUNTIME_CONTEXT]\nplan_id: plan_1"}
    ).project([{"role": "user", "content": "continue"}])

    assert projection.messages[0]["content"].startswith("[PLAN_RUNTIME_CONTEXT]")
    assert projection.messages[1] == {"role": "user", "content": "continue"}
    assert projection.report["plan_context_attached"] == 1


@pytest.mark.anyio
async def test_runner_default_pipeline_supplies_plan_context(tmp_path: Path) -> None:
    manager = ControlManager(tmp_path)
    todo_store = TodoStore()
    plan_id = make_running_plan(manager, todo_store)
    provider = CapturingProvider()

    runner = AgentRunner(
        provider=provider,
        model="fake",
        registry=ToolRegistry(),
        system_prompt="system",
        control_manager=manager,
        todo_store=todo_store,
        max_turns=1,
    )

    await runner.step_async([{"role": "user", "content": "continue approved plan"}])

    contents = [str(message.get("content") or "") for message in provider.seen_messages[0]]
    assert any("[PLAN_RUNTIME_CONTEXT]" in content and f"plan_id: {plan_id}" in content for content in contents)
