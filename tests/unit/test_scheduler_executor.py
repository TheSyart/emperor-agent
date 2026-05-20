from __future__ import annotations

import asyncio
from pathlib import Path
from typing import Any

from agent.scheduler import SchedulerJob, SchedulerPayload, SchedulerSchedule
from agent.runtime.active import ActiveTaskRegistry
from agent.web.services.scheduler_executor import SchedulerJobExecutor


class FakeMemory:
    def __init__(self) -> None:
        self.rows: list[tuple[str, Any, dict[str, Any] | None]] = []

    def append_history(self, role: str, content: Any, extra: dict[str, Any] | None = None) -> None:
        self.rows.append((role, content, extra))


class FakeRunner:
    def __init__(self) -> None:
        self.seen: list[list[dict[str, Any]]] = []

    async def step_stream(self, history, emit, *, turn_id: str | None = None):
        self.seen.append(list(history))
        history.append({"role": "assistant", "content": "done", "turn_id": turn_id})
        await emit({"event": "message_delta", "delta": "done"})
        await emit({"event": "assistant_done", "content": "done"})
        return "done"


class FakeTeamManager:
    def __init__(self) -> None:
        self.calls: list[dict[str, Any]] = []

    def send_message(self, **kwargs) -> str:
        self.calls.append(kwargs)
        loop = kwargs.get("loop")
        emit = kwargs.get("emit")
        if loop and emit:
            fut = asyncio.run_coroutine_threadsafe(
                emit({"event": "team_message", "message": {"id": "msg_1", "from": "lead", "to": kwargs["to"]}}),
                loop,
            )
            fut.result(timeout=2)
        return "team woke"


class FakeLoop:
    def __init__(self) -> None:
        self.memory = FakeMemory()
        self.runner = FakeRunner()
        self.team_manager = FakeTeamManager()


class FakeState:
    def __init__(self) -> None:
        self.lock = asyncio.Lock()
        self.loop = FakeLoop()
        self.history: list[dict[str, Any]] = []
        self.events: list[dict[str, Any]] = []
        self.active_turn = False
        self.active_tasks = ActiveTaskRegistry()
        self._turn = 0
        self._pending: dict[str, Any] | None = None
        self.compact_calls = 0

    def new_turn_id(self) -> str:
        self._turn += 1
        return f"turn_{self._turn}"

    def control(self) -> dict[str, Any]:
        return {"pending": self._pending}

    async def _broadcast_event(self, event: dict[str, Any], *, turn_id: str | None = None) -> None:
        payload = dict(event)
        if turn_id:
            payload["turn_id"] = turn_id
        self.events.append(payload)

    def compact_runtime_events(self) -> dict[str, Any]:
        self.compact_calls += 1
        return {}


def make_job(payload: SchedulerPayload) -> SchedulerJob:
    return SchedulerJob.create(
        name="scheduled",
        schedule=SchedulerSchedule(kind="every", every_ms=60_000),
        payload=payload,
        now=1_000,
    )


def test_scheduler_executor_runs_agent_turn() -> None:
    state = FakeState()
    executor = SchedulerJobExecutor(state)
    job = make_job(SchedulerPayload(kind="agent_turn", message="Write a report"))

    result = asyncio.run(executor.run(job))

    assert result == "agent_turn completed"
    assert state.history[0]["role"] == "user"
    assert "SCHEDULER_TRIGGER" in state.history[0]["content"]
    assert state.loop.memory.rows[0][2]["type"] == "scheduler_agent_turn"
    user_event = next(event for event in state.events if event["event"] == "user_message")
    assert user_event["source"] == "scheduler"
    assert user_event["scheduler"] == {"jobId": job.id, "jobName": "scheduled"}
    assert any(event["event"] == "assistant_done" for event in state.events)


def test_scheduler_executor_rejects_agent_turn_while_control_pending() -> None:
    state = FakeState()
    state._pending = {"id": "ask_1", "kind": "ask"}
    executor = SchedulerJobExecutor(state)
    job = make_job(SchedulerPayload(kind="agent_turn", message="Write a report"))

    try:
        asyncio.run(executor.run(job))
    except RuntimeError as exc:
        assert "Ask / Plan" in str(exc)
    else:
        raise AssertionError("expected pending control to block scheduler agent turn")


def test_scheduler_executor_hides_agent_turn_when_deliver_false() -> None:
    state = FakeState()
    executor = SchedulerJobExecutor(state)
    job = make_job(SchedulerPayload(kind="agent_turn", message="Write quietly", deliver=False))

    result = asyncio.run(executor.run(job))

    assert result == "agent_turn completed"
    assert state.history == []
    assert state.loop.runner.seen[0][0]["role"] == "user"
    assert state.loop.memory.rows[0][2]["hidden"] is True
    assert state.events == []
    assert state.compact_calls == 1


def test_scheduler_executor_wakes_team_member() -> None:
    state = FakeState()
    executor = SchedulerJobExecutor(state)
    job = make_job(SchedulerPayload(kind="team_wake", message="Check inbox", target="alice"))

    result = asyncio.run(executor.run(job))

    assert result == "team woke"
    assert state.loop.team_manager.calls[0]["to"] == "alice"
    assert state.loop.team_manager.calls[0]["type"] == "task"
    assert any(event["event"] == "team_message" for event in state.events)


def test_scheduler_executor_hides_team_wake_events_when_deliver_false() -> None:
    state = FakeState()
    executor = SchedulerJobExecutor(state)
    job = make_job(SchedulerPayload(kind="team_wake", message="Check inbox", target="alice", deliver=False))

    result = asyncio.run(executor.run(job))

    assert result == "team woke"
    assert state.loop.team_manager.calls[0]["to"] == "alice"
    assert state.events == []
