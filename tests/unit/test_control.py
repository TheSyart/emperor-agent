from __future__ import annotations

from pathlib import Path
from typing import Any

import pytest

from agent.control import AskUserTool, ControlManager, ControlMode, ProposePlanTool, TurnPaused
from agent.memory import MemoryStore
from agent.providers.base import LLMProvider, LLMResponse, ToolCallRequest
from agent.runner import AgentRunner
from agent.scheduler import SchedulerService, SchedulerStore, SchedulerTool
from agent.tools import ReadFileTool, ToolRegistry, WriteFileTool


class FakeProvider(LLMProvider):
    def __init__(self, responses: list[LLMResponse]):
        super().__init__(default_model="fake")
        self.responses = responses
        self.seen_tools: list[list[str]] = []
        self.seen_messages: list[list[dict[str, Any]]] = []

    async def chat(self, **kwargs) -> LLMResponse:
        self.seen_tools.append([item["name"] for item in kwargs.get("tools") or []])
        self.seen_messages.append(kwargs.get("messages") or [])
        if self.responses:
            return self.responses.pop(0)
        return LLMResponse(content="done")


def make_question() -> dict[str, Any]:
    return {
        "id": "scope",
        "header": "范围",
        "question": "本次范围怎么定？",
        "options": [
            {"label": "最小", "description": "只做核心路径"},
            {"label": "完整", "description": "连同文档测试一起做"},
        ],
    }


def make_registry(manager: ControlManager, root: Path) -> ToolRegistry:
    registry = ToolRegistry()
    registry.register(ReadFileTool(root))
    registry.register(WriteFileTool(root))
    registry.register(SchedulerTool(SchedulerService(SchedulerStore(root))))
    registry.register(AskUserTool(manager))
    registry.register(ProposePlanTool(manager))
    return registry


def test_control_store_recovers_from_corrupt_state(tmp_path: Path) -> None:
    manager = ControlManager(tmp_path)
    manager.set_mode("plan")
    assert manager.payload()["mode"] == "plan"

    (tmp_path / "memory" / "control" / "state.json").write_text("{bad", encoding="utf-8")

    assert ControlManager(tmp_path).payload()["mode"] == ControlMode.ASK_BEFORE_EDIT.value


def test_ask_user_validation_and_answer_message(tmp_path: Path) -> None:
    manager = ControlManager(tmp_path)
    interaction = manager.create_ask(questions=[make_question()], context="need scope")

    assert interaction.kind == "ask"
    assert manager.payload()["pending"]["id"] == interaction.id

    resume = manager.answer(interaction.id, {"scope": {"choice": "完整", "freeform": "包含 README"}})

    assert "本次范围怎么定" in resume.message
    assert "完整" in resume.message
    assert manager.payload()["pending"] is None


def test_propose_plan_comment_and_approve_restores_previous_mode(tmp_path: Path) -> None:
    manager = ControlManager(tmp_path)
    manager.set_mode("plan")
    interaction = manager.create_plan(
        title="实现 Ask",
        summary="先做控制层",
        plan_markdown="# Plan\n\n- Build it",
        assumptions=["v1 only"],
        risk_level="medium",
    )

    comment = manager.comment(interaction.id, "补充 CLI")
    assert "补充 CLI" in comment.message
    assert manager.payload()["pending"] is None
    assert manager.payload()["mode"] == "plan"

    revised = manager.create_plan(
        title="实现 Ask v2",
        summary="加入 CLI",
        plan_markdown="# Plan\n\n- Build CLI",
        assumptions=[],
        risk_level="low",
    )
    approval = manager.approve(revised.id)

    assert "PLAN_APPROVED" in approval.message
    assert manager.payload()["mode"] == ControlMode.ASK_BEFORE_EDIT.value
    assert manager.payload()["pending"] is None


def test_plan_approval_restores_auto_mode(tmp_path: Path) -> None:
    manager = ControlManager(tmp_path)
    manager.set_mode(ControlMode.AUTO.value)
    manager.set_mode(ControlMode.PLAN.value)
    assert manager.payload()["previous_mode"] == ControlMode.AUTO.value

    interaction = manager.create_plan(
        title="自动模式计划",
        summary="批准后回到 auto",
        plan_markdown="# Plan\n\n- Run it",
        assumptions=[],
        risk_level="low",
    )
    manager.approve(interaction.id)

    assert manager.payload()["mode"] == ControlMode.AUTO.value
    assert manager.payload()["previous_mode"] is None


def test_cancel_returns_history_message_and_clears_pending(tmp_path: Path) -> None:
    manager = ControlManager(tmp_path)
    interaction = manager.create_ask(questions=[make_question()])

    event = manager.cancel(interaction.id)

    assert event["event"] == "interaction_cancelled"
    assert "INTERACTION_CANCELLED" in event["message"]
    assert manager.payload()["pending"] is None


def test_plan_policy_filters_write_tools(tmp_path: Path) -> None:
    manager = ControlManager(tmp_path)
    registry = make_registry(manager, tmp_path)

    manager.set_mode(ControlMode.PLAN.value)

    names = [item["name"] for item in manager.tool_definitions(registry)]
    assert "read_file" in names
    assert "ask_user" in names
    assert "propose_plan" in names
    assert "scheduler" in names
    assert "write_file" not in names
    assert not manager.is_tool_allowed("write_file", registry)


def test_clarification_policy_requires_ask_for_ambiguous_high_impact_work(tmp_path: Path) -> None:
    manager = ControlManager(tmp_path)
    assessment = manager.assess_clarification([
        {"role": "user", "content": "阅读项目找到问题作出修改，不要打补丁，要工程化实现"},
    ])

    assert assessment.required
    assert assessment.questions


def test_clarification_policy_requires_ask_for_project_level_prompt_workflow(tmp_path: Path) -> None:
    manager = ControlManager(tmp_path)
    assessment = manager.assess_clarification([
        {"role": "user", "content": "从头到尾评估项目，优化 agent 的各种提示词和思考工作流程"},
    ])

    assert assessment.required
    assert "scope" in assessment.categories


def test_clarification_policy_skips_small_optimization(tmp_path: Path) -> None:
    manager = ControlManager(tmp_path)
    assessment = manager.assess_clarification([
        {"role": "user", "content": "优化这个函数的变量命名，直接做"},
    ])

    assert not assessment.required


def test_clarification_policy_skips_decision_complete_plan(tmp_path: Path) -> None:
    manager = ControlManager(tmp_path)
    assessment = manager.assess_clarification([
        {
            "role": "user",
            "content": "# Summary\n\nPLEASE IMPLEMENT THIS PLAN:\n\n## Key Changes\n- 做 A\n\n## Test Plan\n- pytest",
        },
    ])

    assert not assessment.required


@pytest.mark.anyio
async def test_runner_pauses_on_ask_and_writes_checkpoint(tmp_path: Path) -> None:
    manager = ControlManager(tmp_path)
    registry = make_registry(manager, tmp_path)
    memory = MemoryStore(tmp_path / "memory", tmp_path / "USER.local.md")
    provider = FakeProvider([
        LLMResponse(
            content="",
            tool_calls=[
                ToolCallRequest(
                    id="call_ask",
                    name="ask_user",
                    arguments={"questions": [make_question()]},
                ),
            ],
            finish_reason="tool_calls",
        ),
    ])
    runner = AgentRunner(
        provider=provider,
        model="fake",
        registry=registry,
        system_prompt="system",
        memory_store=memory,
        control_manager=manager,
    )
    history = [{"role": "user", "content": "do work"}]
    emitted: list[dict[str, Any]] = []

    async def emit(event: dict[str, Any]) -> None:
        emitted.append(event)

    with pytest.raises(TurnPaused):
        await runner.step_async(history, emit=emit)

    assert manager.payload()["pending"]["kind"] == "ask"
    assert memory.read_checkpoint() is not None
    assert any(event.get("event") == "ask_request" for event in emitted)
    assert any(event.get("event") == "turn_paused" for event in emitted)
    assert history[-1]["role"] == "tool"
    assert "waiting for user" in history[-1]["content"]


@pytest.mark.anyio
async def test_runner_plan_mode_wraps_plain_final_as_plan(tmp_path: Path) -> None:
    manager = ControlManager(tmp_path)
    manager.set_mode(ControlMode.PLAN.value)
    registry = make_registry(manager, tmp_path)
    provider = FakeProvider([LLMResponse(content="我会先读代码，然后实现并测试。")])
    runner = AgentRunner(
        provider=provider,
        model="fake",
        registry=registry,
        system_prompt="system",
        control_manager=manager,
    )
    emitted: list[dict[str, Any]] = []

    async def emit(event: dict[str, Any]) -> None:
        emitted.append(event)

    with pytest.raises(TurnPaused):
        await runner.step_async([{"role": "user", "content": "做一个计划"}], emit=emit)

    assert manager.payload()["pending"]["kind"] == "plan"
    assert any(event.get("event") == "plan_draft" for event in emitted)
    assert not any(event.get("event") == "assistant_done" for event in emitted)


@pytest.mark.anyio
async def test_runner_ask_guard_pauses_plain_final_for_ambiguous_task(tmp_path: Path) -> None:
    manager = ControlManager(tmp_path)
    registry = make_registry(manager, tmp_path)
    provider = FakeProvider([LLMResponse(content="我直接开始改。")])
    runner = AgentRunner(
        provider=provider,
        model="fake",
        registry=registry,
        system_prompt="system",
        control_manager=manager,
    )
    emitted: list[dict[str, Any]] = []

    async def emit(event: dict[str, Any]) -> None:
        emitted.append(event)

    with pytest.raises(TurnPaused):
        await runner.step_async(
            [{"role": "user", "content": "阅读项目找到问题作出修改，不要打补丁，要工程化实现"}],
            emit=emit,
        )

    assert manager.payload()["pending"]["kind"] == "ask"
    assert any(event.get("event") == "ask_request" for event in emitted)


@pytest.mark.anyio
async def test_answer_resume_injects_user_message(tmp_path: Path) -> None:
    manager = ControlManager(tmp_path)
    interaction = manager.create_ask(questions=[make_question()])
    resume = manager.answer(interaction.id, {"scope": {"choice": "最小", "freeform": ""}})

    provider = FakeProvider([LLMResponse(content="resumed")])
    registry = make_registry(manager, tmp_path)
    history = [{"role": "user", "content": resume.message}]
    runner = AgentRunner(
        provider=provider,
        model="fake",
        registry=registry,
        system_prompt="system",
        control_manager=manager,
    )

    assert await runner.step_async(history) == "resumed"
    assert any("ASK_ANSWERED" in str(msg.get("content")) for msg in provider.seen_messages[-1])
