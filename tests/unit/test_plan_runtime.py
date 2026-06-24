from __future__ import annotations

from pathlib import Path

import pytest

from agent.control import ControlManager, ProposePlanTool
from agent.plans.models import PlanRecord, PlanStatus, PlanStep, PlanStepStatus
from agent.plans.store import PlanStore
from agent.providers.base import LLMProvider, LLMResponse, ToolCallRequest
from agent.runner import AgentRunner
from agent.tools import Tool, ToolRegistry, UpdateTodosTool
from agent.tools.todo import TodoStore


class FakeProvider(LLMProvider):
    def __init__(self, responses: list[LLMResponse]) -> None:
        super().__init__(default_model="fake")
        self.responses = responses
        self.seen_messages: list[list[dict]] = []

    async def chat(self, **kwargs) -> LLMResponse:
        self.seen_messages.append(kwargs.get("messages") or [])
        if self.responses:
            return self.responses.pop(0)
        return LLMResponse(content="done")


class FakeCommandTool(Tool):
    name = "run_command"
    description = "fake command tool"
    exclusive = True
    parameters = {
        "type": "object",
        "properties": {"command": {"type": "string"}},
        "required": ["command"],
    }

    def __init__(self, outputs: dict[str, str]) -> None:
        self.outputs = outputs

    def execute(self, command: str) -> str:
        return self.outputs[command]


def quality_step(
    step_id: str,
    title: str,
    *,
    command: str | None = None,
    file: str = "agent/runner.py",
) -> dict[str, object]:
    step: dict[str, object] = {
        "id": step_id,
        "title": title,
        "description": f"Concrete work for {title}.",
        "files": [file],
        "acceptance": [f"{title} has observable acceptance."],
    }
    if command:
        step["commands"] = [command]
    return step


def test_propose_plan_persists_structured_steps(tmp_path: Path) -> None:
    manager = ControlManager(tmp_path)
    manager.plan_store = PlanStore(tmp_path)
    manager.set_mode("plan")
    tool = ProposePlanTool(manager)

    result = tool.execute(
        title="Runner upgrade",
        summary="Extract context pipeline",
        plan_markdown="# Plan\n\n- Add context pipeline",
        steps=[
            {
                "id": "step_1",
                "title": "Add failing tests",
                "files": ["tests/unit/test_context_pipeline.py"],
                "commands": [".venv/bin/python -m pytest tests/unit/test_context_pipeline.py -q"],
                "acceptance": ["context pipeline tests pass"],
            }
        ],
        assumptions=["keep provider behavior unchanged"],
        risk_level="medium",
    )

    assert result.startswith("__CONTROL_PAUSE__:")
    pending = manager.payload()["pending"]
    plan_id = pending["meta"]["plan_id"]
    saved = manager.plan_store.get(plan_id)
    assert saved is not None
    assert saved.steps[0].id == "step_1"
    assert saved.steps[0].commands == [".venv/bin/python -m pytest tests/unit/test_context_pipeline.py -q"]


def test_plan_approval_marks_structured_plan_approved(tmp_path: Path) -> None:
    manager = ControlManager(tmp_path)
    manager.set_mode("plan")
    tool = ProposePlanTool(manager)

    tool.execute(
        title="Runner upgrade",
        summary="Extract context pipeline",
        plan_markdown="# Plan\n\n- Add context pipeline",
        steps=[
            quality_step(
                "step_1",
                "Add failing tests",
                file="tests/unit/test_context_pipeline.py",
            )
        ],
        assumptions=[],
        risk_level="low",
    )
    pending = manager.payload()["pending"]
    plan_id = pending["meta"]["plan_id"]

    manager.approve(pending["id"])

    saved = manager.plan_store.get(plan_id)
    assert saved is not None
    assert saved.status == "approved"
    assert saved.approved_at is not None


def test_plan_approval_activates_first_step_when_todo_store_is_attached(tmp_path: Path) -> None:
    manager = ControlManager(tmp_path)
    todo_store = TodoStore()
    manager.set_todo_store(todo_store)
    manager.set_mode("plan")
    tool = ProposePlanTool(manager)

    tool.execute(
        title="Runner upgrade",
        summary="Extract context pipeline",
        plan_markdown="# Plan\n\n- Add context pipeline\n- Run tests",
        steps=[
            quality_step("step_1", "Add failing tests", file="tests/unit/test_context_pipeline.py"),
            quality_step("step_2", "Run focused tests", file="tests/unit/test_context_pipeline.py"),
        ],
        assumptions=[],
        risk_level="low",
    )
    pending = manager.payload()["pending"]
    plan_id = pending["meta"]["plan_id"]

    resume = manager.approve(pending["id"])

    saved = manager.plan_store.get(plan_id)
    assert saved is not None
    assert saved.status == PlanStatus.EXECUTING.value
    assert saved.steps[0].status == PlanStepStatus.ACTIVE.value
    assert saved.steps[1].status == PlanStepStatus.PENDING.value
    assert todo_store.todos == [
        {"id": 1, "plan_step_id": "step_1", "content": "Add failing tests", "status": "in_progress"},
        {"id": 2, "plan_step_id": "step_2", "content": "Run focused tests", "status": "pending"},
    ]
    assert resume.event["plan"]["status"] == PlanStatus.EXECUTING.value
    assert resume.event["todos"][0]["status"] == "in_progress"


def test_plan_approval_message_contains_project_execution_contract(tmp_path: Path) -> None:
    manager = ControlManager(tmp_path)
    todo_store = TodoStore()
    manager.set_todo_store(todo_store)
    manager.set_mode("plan")
    tool = ProposePlanTool(manager)

    tool.execute(
        title="Runner upgrade",
        summary="Extract context pipeline",
        plan_markdown="# Plan\n\n- Add failing tests\n- Run focused tests",
        steps=[
            quality_step(
                "step_1",
                "Add failing tests",
                command=".venv/bin/python -m pytest tests/unit/test_context_pipeline.py -q",
                file="tests/unit/test_context_pipeline.py",
            ),
            quality_step("step_2", "Run focused tests", file="tests/unit/test_context_pipeline.py"),
        ],
        assumptions=[],
        risk_level="low",
    )
    pending = manager.payload()["pending"]

    resume = manager.approve(pending["id"])

    message = resume.message
    assert "[CONTROL:PLAN_APPROVED]" in message
    assert "active todo" in message
    assert "verification evidence" in message
    assert "failed" in message
    assert "blocked" in message
    assert "ask_user" in message
    assert "step_1 [active]" in message
    assert "commands: .venv/bin/python -m pytest tests/unit/test_context_pipeline.py -q" in message
    assert "Do not provide a final answer while any step is pending, active, failed, or blocked." in message


def test_prompt_templates_contain_project_execution_contract() -> None:
    root = Path(__file__).resolve().parents[2]
    tool_prompt = (root / "templates" / "TOOL.md").read_text(encoding="utf-8")
    soul_prompt = (root / "templates" / "SOUL.md").read_text(encoding="utf-8")

    assert "active todo" in tool_prompt
    assert "active PlanStep" in tool_prompt
    assert "verification evidence" in tool_prompt
    assert "failed" in tool_prompt
    assert "blocked" in tool_prompt
    assert "ask_user" in tool_prompt
    assert "批准计划后的执行契约" in soul_prompt


def test_control_manager_syncs_todos_back_to_plan_steps(tmp_path: Path) -> None:
    manager = ControlManager(tmp_path)
    todo_store = TodoStore()
    manager.set_todo_store(todo_store)
    manager.set_mode("plan")
    tool = ProposePlanTool(manager)
    tool.execute(
        title="Runner upgrade",
        summary="Extract context pipeline",
        plan_markdown="# Plan\n\n- Add failing tests\n- Run focused tests",
        steps=[
            quality_step("step_1", "Add failing tests", file="tests/unit/test_context_pipeline.py"),
            quality_step("step_2", "Run focused tests", file="tests/unit/test_context_pipeline.py"),
        ],
        assumptions=[],
        risk_level="low",
    )
    pending = manager.payload()["pending"]
    plan_id = pending["meta"]["plan_id"]
    manager.approve(pending["id"])

    updated = manager.sync_plan_from_todos(
        [
            {"id": 1, "content": "Add failing tests", "status": "completed"},
            {"id": 2, "content": "Run focused tests", "status": "in_progress"},
        ],
        evidence={"source": "update_todos", "summary": "todos updated"},
    )

    assert updated is not None
    assert updated.id == plan_id
    assert updated.status == PlanStatus.EXECUTING.value
    assert updated.steps[0].status == PlanStepStatus.DONE.value
    assert updated.steps[0].evidence[-1]["source"] == "update_todos"
    assert updated.steps[1].status == PlanStepStatus.ACTIVE.value


@pytest.mark.anyio
async def test_runner_update_todos_emits_plan_runtime_update(tmp_path: Path) -> None:
    manager = ControlManager(tmp_path)
    todo_store = TodoStore()
    manager.set_todo_store(todo_store)
    manager.set_mode("plan")
    tool = ProposePlanTool(manager)
    tool.execute(
        title="Runner upgrade",
        summary="Extract context pipeline",
        plan_markdown="# Plan\n\n- Add failing tests\n- Run focused tests",
        steps=[
            quality_step("step_1", "Add failing tests", file="tests/unit/test_context_pipeline.py"),
            quality_step("step_2", "Run focused tests", file="tests/unit/test_context_pipeline.py"),
        ],
        assumptions=[],
        risk_level="low",
    )
    pending = manager.payload()["pending"]
    plan_id = pending["meta"]["plan_id"]
    manager.approve(pending["id"])

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
                                {"id": 1, "content": "Add failing tests", "status": "completed"},
                                {"id": 2, "content": "Run focused tests", "status": "completed"},
                            ]
                        },
                    )
                ],
                finish_reason="tool_calls",
            ),
            LLMResponse(content="done"),
        ]),
        model="fake",
        registry=registry,
        system_prompt="system",
        todo_store=todo_store,
        control_manager=manager,
    )
    emitted: list[dict] = []

    async def emit(event: dict) -> None:
        emitted.append(event)

    await runner.step_async([{"role": "user", "content": "execute approved plan"}], emit=emit)

    saved = manager.plan_store.get(plan_id)
    assert saved is not None
    assert saved.status == PlanStatus.COMPLETED.value
    plan_events = [event for event in emitted if event.get("event") == "plan_runtime_update"]
    assert plan_events[-1]["plan"]["id"] == plan_id
    assert plan_events[-1]["plan"]["status"] == PlanStatus.COMPLETED.value
    assert plan_events[-1]["plan"]["steps"][0]["evidence"][-1]["tool_call_id"] == "call_1"


@pytest.mark.anyio
async def test_runner_run_command_records_plan_verification(tmp_path: Path) -> None:
    manager = ControlManager(tmp_path)
    todo_store = TodoStore()
    manager.set_todo_store(todo_store)
    manager.set_mode("plan")
    tool = ProposePlanTool(manager)
    command = ".venv/bin/python -m pytest tests/unit/test_plan_store.py -q"
    tool.execute(
        title="Runner upgrade",
        summary="Verify plan store",
        plan_markdown="# Plan\n\n- Run tests",
        steps=[
            quality_step(
                "step_1",
                "Run tests",
                command=command,
                file="tests/unit/test_plan_store.py",
            )
        ],
        assumptions=[],
        risk_level="low",
    )
    pending = manager.payload()["pending"]
    plan_id = pending["meta"]["plan_id"]
    manager.approve(pending["id"])

    registry = ToolRegistry()
    registry.register(FakeCommandTool({command: "2 passed"}))
    runner = AgentRunner(
        provider=FakeProvider([
            LLMResponse(
                content="",
                tool_calls=[ToolCallRequest(id="call_1", name="run_command", arguments={"command": command})],
                finish_reason="tool_calls",
            ),
            LLMResponse(content="done"),
        ]),
        model="fake",
        registry=registry,
        system_prompt="system",
        control_manager=manager,
        max_turns=2,
    )
    emitted: list[dict] = []

    async def emit(event: dict) -> None:
        emitted.append(event)

    await runner.step_async([{"role": "user", "content": "execute approved plan"}], emit=emit)

    saved = manager.plan_store.get(plan_id)
    assert saved is not None
    evidence = saved.steps[0].evidence[-1]
    assert evidence["source"] == "run_command"
    assert evidence["tool_call_id"] == "call_1"
    assert evidence["command"] == command
    assert evidence["passed"] is True
    assert evidence["summary"] == "2 passed"
    assert [event["event"] for event in emitted if event["event"].startswith("plan_verification_")] == [
        "plan_verification_start",
        "plan_verification_done",
    ]
    plan_updates = [event for event in emitted if event.get("event") == "plan_runtime_update"]
    assert plan_updates[-1]["plan"]["steps"][0]["evidence"][-1]["command"] == command


@pytest.mark.anyio
async def test_failed_run_command_records_plan_verification(tmp_path: Path) -> None:
    manager = ControlManager(tmp_path)
    todo_store = TodoStore()
    manager.set_todo_store(todo_store)
    manager.set_mode("plan")
    tool = ProposePlanTool(manager)
    command = ".venv/bin/python -m pytest tests/unit/test_plan_store.py -q"
    tool.execute(
        title="Runner upgrade",
        summary="Verify plan store",
        plan_markdown="# Plan\n\n- Run tests",
        steps=[
            quality_step(
                "step_1",
                "Run tests",
                command=command,
                file="tests/unit/test_plan_store.py",
            )
        ],
        assumptions=[],
        risk_level="low",
    )
    pending = manager.payload()["pending"]
    plan_id = pending["meta"]["plan_id"]
    manager.approve(pending["id"])

    registry = ToolRegistry()
    registry.register(FakeCommandTool({command: "Error: command exited with code 2\nfailed tests"}))
    provider = FakeProvider([
        LLMResponse(
            content="",
            tool_calls=[ToolCallRequest(id="call_1", name="run_command", arguments={"command": command})],
            finish_reason="tool_calls",
        ),
        LLMResponse(content="diagnosed"),
    ])
    runner = AgentRunner(
        provider=provider,
        model="fake",
        registry=registry,
        system_prompt="system",
        control_manager=manager,
        max_turns=2,
    )
    emitted: list[dict] = []

    async def emit(event: dict) -> None:
        emitted.append(event)

    await runner.step_async([{"role": "user", "content": "execute approved plan"}], emit=emit)

    saved = manager.plan_store.get(plan_id)
    assert saved is not None
    assert saved.status == PlanStatus.EXECUTING.value
    assert saved.steps[0].status == PlanStepStatus.FAILED.value
    evidence = saved.steps[0].evidence[-1]
    assert evidence["passed"] is False
    assert evidence["exit_code"] == 2
    assert evidence["summary"] == "failed tests"
    done_events = [event for event in emitted if event.get("event") == "plan_verification_done"]
    assert done_events[-1]["result"]["passed"] is False
    plan_updates = [event for event in emitted if event.get("event") == "plan_runtime_update"]
    assert plan_updates[-1]["plan"]["steps"][0]["status"] == PlanStepStatus.FAILED.value
    followup = provider.seen_messages[1][-1]
    assert followup["role"] == "user"
    assert "[PLAN_VERIFICATION_FAILED]" in followup["content"]
    assert "failed tests" in followup["content"]


@pytest.mark.anyio
async def test_runner_final_answer_gate_continues_incomplete_plan(tmp_path: Path) -> None:
    manager = ControlManager(tmp_path)
    manager.set_mode("plan")
    tool = ProposePlanTool(manager)
    tool.execute(
        title="Runner upgrade",
        summary="Verify final gate",
        plan_markdown="# Plan\n\n- Run tests",
        steps=[quality_step("step_1", "Run tests", file="tests/unit/test_plan_runtime.py")],
        assumptions=[],
        risk_level="low",
    )
    pending = manager.payload()["pending"]
    manager.approve(pending["id"])

    provider = FakeProvider([
        LLMResponse(content="premature final"),
        LLMResponse(content="still premature"),
    ])
    runner = AgentRunner(
        provider=provider,
        model="fake",
        registry=ToolRegistry(),
        system_prompt="system",
        control_manager=manager,
        max_turns=2,
    )
    emitted: list[dict] = []

    async def emit(event: dict) -> None:
        emitted.append(event)

    reply = await runner.step_async([{"role": "user", "content": "execute approved plan"}], emit=emit)

    assert reply.startswith("（达到 max_turns=2")
    assert len(provider.seen_messages) == 2
    followup = provider.seen_messages[1][-1]
    assert followup["role"] == "user"
    assert "[PLAN_INCOMPLETE]" in followup["content"]
    assert "step_1 [pending] Run tests" in followup["content"]
    assert any(
        event.get("event") == "turn_phase"
        and event.get("phase") == "plan_followup"
        for event in emitted
    )


def _completed_plan_record(plan_id: str = "plan_finished") -> PlanRecord:
    now = 1000.0
    return PlanRecord(
        id=plan_id,
        title="Finished plan",
        summary="all work done",
        status=PlanStatus.COMPLETED.value,
        created_at=now,
        updated_at=now,
        steps=[PlanStep(id="step_1", title="Do it", status=PlanStepStatus.DONE.value)],
    )


def test_reviewable_plan_id_returns_finished_plan(tmp_path: Path) -> None:
    manager = ControlManager(tmp_path)
    record = _completed_plan_record()
    manager.plan_store.save(record)
    assert manager.reviewable_plan_id() == record.id


def test_reviewable_plan_id_none_when_no_finished_plan(tmp_path: Path) -> None:
    manager = ControlManager(tmp_path)
    assert manager.reviewable_plan_id() is None
