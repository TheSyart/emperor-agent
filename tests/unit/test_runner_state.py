from __future__ import annotations

from typing import Any

import pytest

from agent.providers.base import LLMProvider, LLMResponse, ToolCallRequest
from agent.runner import AgentRunner
from agent.runner_state import TurnPhase, TurnState
from agent.tools import Tool, ToolRegistry


class FakeProvider(LLMProvider):
    def __init__(self, responses: list[LLMResponse]) -> None:
        super().__init__(default_model="fake")
        self.responses = responses
        self.seen_messages: list[list[dict[str, Any]]] = []

    async def chat(self, **kwargs) -> LLMResponse:
        self.seen_messages.append(kwargs.get("messages") or [])
        if self.responses:
            return self.responses.pop(0)
        return LLMResponse(content="done")


class EchoTool(Tool):
    name = "echo"
    description = "Echo a value."
    parameters = {
        "type": "object",
        "properties": {"value": {"type": "string"}},
        "required": ["value"],
    }

    def execute(self, **kwargs) -> str:
        return str(kwargs["value"])


def test_turn_state_transitions_to_runtime_events() -> None:
    state = TurnState(turn_id="turn_1")
    state.start_iteration()

    event = state.transition(TurnPhase.MODEL_REQUEST, detail={"history_length": 2})

    assert event.to_runtime_event() == {
        "event": "turn_phase",
        "phase": "model_request",
        "sequence": 1,
        "iteration": 1,
        "turn_id": "turn_1",
        "detail": {"history_length": 2},
    }


@pytest.mark.anyio
async def test_runner_emits_turn_phase_sequence_for_final_reply() -> None:
    runner = AgentRunner(
        provider=FakeProvider([LLMResponse(content="done")]),
        model="fake",
        registry=ToolRegistry(),
        system_prompt="system",
    )
    emitted: list[dict[str, Any]] = []

    async def emit(event: dict[str, Any]) -> None:
        emitted.append(event)

    reply = await runner.step_async([{"role": "user", "content": "hi"}], emit=emit, turn_id="turn_1")

    assert reply == "done"
    phases = [event for event in emitted if event.get("event") == "turn_phase"]
    assert [event["phase"] for event in phases] == [
        "started",
        "model_request",
        "model_response",
        "compact_check",
        "completed",
    ]
    assert [event["sequence"] for event in phases] == [1, 2, 3, 4, 5]
    assert all(event["turn_id"] == "turn_1" for event in phases)


@pytest.mark.anyio
async def test_runner_emits_tool_batch_phases() -> None:
    registry = ToolRegistry()
    registry.register(EchoTool())
    runner = AgentRunner(
        provider=FakeProvider([
            LLMResponse(
                content="",
                tool_calls=[ToolCallRequest(id="call_1", name="echo", arguments={"value": "ok"})],
                finish_reason="tool_calls",
            ),
            LLMResponse(content="done"),
        ]),
        model="fake",
        registry=registry,
        system_prompt="system",
    )
    emitted: list[dict[str, Any]] = []

    async def emit(event: dict[str, Any]) -> None:
        emitted.append(event)

    reply = await runner.step_async([{"role": "user", "content": "hi"}], emit=emit)

    assert reply == "done"
    phases = [event for event in emitted if event.get("event") == "turn_phase"]
    assert "tool_batch_start" in [event["phase"] for event in phases]
    assert "tool_batch_done" in [event["phase"] for event in phases]
    assert [event["iteration"] for event in phases if event["phase"] == "model_request"] == [1, 2]


@pytest.mark.anyio
async def test_runner_emits_context_projection_report() -> None:
    provider = FakeProvider([LLMResponse(content="done")])
    runner = AgentRunner(
        provider=provider,
        model="fake",
        registry=ToolRegistry(),
        system_prompt="system",
    )
    emitted: list[dict[str, Any]] = []

    async def emit(event: dict[str, Any]) -> None:
        emitted.append(event)

    await runner.step_async(
        [
            {"role": "user", "content": "inspect"},
            {
                "role": "assistant",
                "content": "",
                "tool_calls": [
                    {
                        "id": "call_1",
                        "type": "function",
                        "function": {"name": "read_file", "arguments": "{}"},
                    }
                ],
            },
        ],
        emit=emit,
    )

    context_events = [event for event in emitted if event.get("event") == "context_projection"]
    assert context_events[0]["report"]["paired_missing_tool_results"] == 1
    assert context_events[0]["message_count"] == 3
    assert provider.seen_messages[0][-1]["tool_call_id"] == "call_1"
