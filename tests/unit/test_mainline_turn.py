from __future__ import annotations

import asyncio
from typing import Any

from agent.runtime.active import ActiveTaskRegistry
from agent.web.services.mainline_turn import MainlineTurnService


class FakeMemory:
    def __init__(self) -> None:
        self.rows: list[tuple[str, Any, dict[str, Any] | None]] = []

    def append_history(self, role: str, content: Any, extra: dict[str, Any] | None = None) -> None:
        self.rows.append((role, content, extra))


class FakeRunner:
    def __init__(self) -> None:
        self.calls: list[dict[str, Any]] = []

    async def step_stream(self, history, emit, *, turn_id: str | None = None):
        self.calls.append({"history": list(history), "turn_id": turn_id})
        await emit({"event": "message_delta", "delta": "ok"})
        await emit({"event": "assistant_done", "content": "ok"})
        return "ok"


class FakeLoop:
    def __init__(self) -> None:
        self.memory = FakeMemory()
        self.runner = FakeRunner()


class FakeState:
    def __init__(self) -> None:
        self.lock = asyncio.Lock()
        self.history: list[dict[str, Any]] = []
        self.loop = FakeLoop()
        self.events: list[dict[str, Any]] = []
        self.active_turn = False
        self.active_tasks = ActiveTaskRegistry()
        self.compact_calls = 0
        self._turn = 0

    def new_turn_id(self) -> str:
        self._turn += 1
        return f"turn_{self._turn}"

    async def _broadcast_event(self, event: dict[str, Any], *, turn_id: str | None = None) -> None:
        payload = dict(event)
        if turn_id:
            payload["turn_id"] = turn_id
        self.events.append(payload)

    def compact_runtime_events(self) -> dict[str, Any]:
        self.compact_calls += 1
        return {}


def test_mainline_turn_service_submits_single_mainline_turn() -> None:
    state = FakeState()
    service = MainlineTurnService(state)  # type: ignore[arg-type]

    turn_id = asyncio.run(
        service.submit(
            content="hello",
            display_content="hello",
            client_message_id="client_1",
            memory_extra={"displayContent": "hello"},
            label="Test turn",
        )
    )

    assert turn_id == "turn_1"
    assert state.history == [{"role": "user", "content": "hello", "turn_id": "turn_1"}]
    assert state.loop.memory.rows == [
        ("user", "hello", {"displayContent": "hello", "turn_id": "turn_1"})
    ]
    assert state.loop.runner.calls[0]["history"][0]["content"] == "hello"
    assert state.events[0]["event"] == "user_message"
    assert state.events[0]["client_message_id"] == "client_1"
    assert any(event["event"] == "assistant_done" for event in state.events)
    assert state.active_turn is False
    assert state.compact_calls == 1


def test_mainline_turn_service_preserves_attachment_ids_and_refs() -> None:
    state = FakeState()
    service = MainlineTurnService(state)  # type: ignore[arg-type]

    asyncio.run(
        service.submit(
            content="see file",
            display_content="see file",
            attachments=[{"id": "att_1", "name": "a.txt"}],
            attachment_ids=["att_1"],
        )
    )

    assert state.history[0]["attachments"] == ["att_1"]
    assert state.loop.memory.rows[0][2]["attachments"] == ["att_1"]
    assert state.events[0]["attachments"] == [{"id": "att_1", "name": "a.txt"}]
