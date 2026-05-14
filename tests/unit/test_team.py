"""Tests for Agent Team storage, bus, and wake orchestration."""

from __future__ import annotations

import json
from collections.abc import Callable
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path
from typing import Any

import pytest

from agent.subagents import SubagentSpec
from agent.team import MessageBus, TeamManager, TeamMember, TeamStatus, TeamStore, role_to_agent_type
from agent.team.models import TeamMessage, validate_member_name
from agent.tools import ToolRegistry


class FakeSubagentRegistry:
    def __init__(self):
        self.spec = SubagentSpec(
            name="neiguan_yingzao",
            description="fake coder",
            system_prompt="fake prompt",
            tool_names=(),
            max_turns=3,
        )

    def get(self, name: str):
        if name in {"neiguan_yingzao", "sili_suitang"}:
            return self.spec if name == "neiguan_yingzao" else SubagentSpec(
                name="sili_suitang",
                description="fake reader",
                system_prompt="fake prompt",
                tool_names=(),
                max_turns=3,
            )
        return None

    def resolve_name(self, name: str) -> str:
        return name

    def names(self, *, include_aliases: bool = False) -> list[str]:
        return ["neiguan_yingzao", "sili_suitang"]


class FakeRunner:
    def __init__(
        self,
        reply: str = "done",
        *,
        stream_events: list[dict[str, Any]] | None = None,
        on_step: Callable[[list[dict[str, Any]]], None] | None = None,
        should_raise: Callable[[], bool] | None = None,
    ):
        self.reply = reply
        self.stream_events = stream_events or []
        self.on_step = on_step
        self.should_raise = should_raise or (lambda: False)

    def step(self, history):
        if self.should_raise():
            raise RuntimeError("fake wake failure")
        if self.on_step:
            self.on_step(history)
        history.append({"role": "assistant", "content": self.reply})
        return self.reply

    async def step_stream(self, history, emit):
        if self.should_raise():
            raise RuntimeError("fake wake failure")
        for event in self.stream_events:
            await emit(event)
        if self.on_step:
            self.on_step(history)
        history.append({"role": "assistant", "content": self.reply})
        await emit({"event": "assistant_done", "content": self.reply})
        return self.reply


def make_manager(tmp_path: Path, runner_factory=None) -> TeamManager:
    if runner_factory is None:
        def runner_factory(**kwargs):
            return FakeRunner("fake teammate result")

    return TeamManager(
        root=tmp_path,
        parent_registry=ToolRegistry(),
        subagent_registry=FakeSubagentRegistry(),
        runner_factory=runner_factory,
    )


def test_team_stream_passes_through_team_message_events(tmp_path: Path) -> None:
    live_message = TeamMessage.create(from_actor="alice", to="lead", content="live reply")
    emitted: list[dict[str, Any]] = []

    async def capture(event: dict[str, Any]) -> None:
        emitted.append(event)

    def runner_factory(**kwargs):
        return FakeRunner("streamed", stream_events=[
            {"event": "team_message", "message": live_message.to_dict()},
        ])

    manager = make_manager(tmp_path, runner_factory=runner_factory)
    manager.spawn_teammate(name="alice", role="coder")
    manager.send_message(to="alice", content="work", wake=True, emit=capture)

    assert any(
        event.get("event") == "team_message"
        and event.get("message", {}).get("content") == "live reply"
        for event in emitted
    )


def test_store_initializes_private_team_tree(tmp_path: Path) -> None:
    store = TeamStore(tmp_path)
    assert (tmp_path / ".team" / "config.json").exists()
    assert store.load_config()["team_name"] == "default"
    assert (tmp_path / ".team" / "inbox").is_dir()
    assert (tmp_path / ".team" / "threads").is_dir()


@pytest.mark.parametrize("name", ["../alice", "lead", "inbox", "", "bad/name"])
def test_member_name_validation_rejects_unsafe_names(name: str) -> None:
    with pytest.raises(ValueError):
        validate_member_name(name)


def test_message_bus_cursor_read_and_mark(tmp_path: Path) -> None:
    store = TeamStore(tmp_path)
    bus = MessageBus(store)
    bus.append(TeamMessage.create(from_actor="lead", to="alice", content="one"))
    bus.append(TeamMessage.create(from_actor="lead", to="alice", content="two"))

    first = bus.read("alice", limit=1, mark_read=True)
    assert [msg.content for msg in first] == ["one"]
    assert bus.unread_count("alice") == 1

    second = bus.read("alice", limit=10, mark_read=True)
    assert [msg.content for msg in second] == ["two"]
    assert bus.unread_count("alice") == 0


def test_role_mapping_defaults_to_reader() -> None:
    assert role_to_agent_type("coder") == "neiguan_yingzao"
    assert role_to_agent_type("reviewer") == "shangbao_dianbu"
    assert role_to_agent_type("researcher") == "dongchang_tanshi"
    assert role_to_agent_type("unknown") == "sili_suitang"


def test_spawn_teammate_persists_member(tmp_path: Path) -> None:
    manager = make_manager(tmp_path)
    raw = manager.spawn_teammate(name="alice", role="coder")
    payload = json.loads(raw)

    assert payload["created"]["name"] == "alice"
    assert manager.store.get_member("alice") is not None
    assert manager.store.get_member("alice").status == TeamStatus.IDLE.value


def test_spawn_with_task_wakes_and_writes_lead_result(tmp_path: Path) -> None:
    manager = make_manager(tmp_path)
    raw = manager.spawn_teammate(name="alice", role="coder", task="write hello")
    payload = json.loads(raw)

    assert payload["created"]["name"] == "alice"
    assert payload["result"] == "fake teammate result"
    assert manager.bus.unread_count("alice") == 0
    lead_messages = manager.bus.read("lead", limit=10, mark_read=False)
    assert [msg.type for msg in lead_messages] == ["result"]
    assert "fake teammate result" in lead_messages[0].content


def test_send_message_wake_uses_existing_thread(tmp_path: Path) -> None:
    manager = make_manager(tmp_path)
    manager.spawn_teammate(name="alice", role="coder")
    manager.send_message(to="alice", content="first", wake=True)
    manager.send_message(to="alice", content="second", wake=True)

    thread = manager.store.read_thread("alice")
    user_messages = [msg for msg in thread if msg.get("role") == "user"]
    assert len(user_messages) == 2
    assert len([msg for msg in manager.bus.all_messages("lead") if msg.type == "result"]) == 2


def test_explicit_teammate_reply_suppresses_fallback_result(tmp_path: Path) -> None:
    holder: dict[str, TeamManager] = {}

    def on_step(history: list[dict[str, Any]]) -> None:
        holder["manager"].send_message(
            to="lead",
            content="explicit teammate reply",
            sender="alice",
            wake=False,
        )

    def runner_factory(**kwargs):
        return FakeRunner("final summary", on_step=on_step)

    manager = make_manager(tmp_path, runner_factory=runner_factory)
    holder["manager"] = manager
    manager.spawn_teammate(name="alice", role="coder")
    manager.send_message(to="alice", content="work", wake=True)

    lead_messages = manager.bus.all_messages("lead")
    assert [msg.content for msg in lead_messages] == ["explicit teammate reply"]
    assert all(msg.type != "result" for msg in lead_messages)


def test_failed_wake_keeps_unread_and_reuses_checkpoint(tmp_path: Path) -> None:
    should_fail = {"value": True}

    def runner_factory(**kwargs):
        return FakeRunner("recovered", should_raise=lambda: should_fail["value"])

    manager = make_manager(tmp_path, runner_factory=runner_factory)
    manager.spawn_teammate(name="alice", role="coder")

    raw = manager.send_message(to="alice", content="fragile work", wake=True)
    payload = json.loads(raw)

    assert payload["result"].startswith("Error:")
    assert manager.bus.unread_count("alice") == 1
    checkpoint = manager.store.read_checkpoint_payload("alice")
    assert checkpoint is not None
    assert checkpoint["pending_message_ids"]

    should_fail["value"] = False
    assert manager.wake_teammate("alice") == "recovered"
    assert manager.bus.unread_count("alice") == 0
    thread = manager.store.read_thread("alice")
    user_messages = [msg for msg in thread if msg.get("role") == "user"]
    assert len(user_messages) == 1
    assert "fragile work" in user_messages[0]["content"]


def test_message_bus_concurrent_append_keeps_jsonl_intact(tmp_path: Path) -> None:
    store = TeamStore(tmp_path)
    bus = MessageBus(store)

    def send(i: int) -> None:
        bus.send(from_actor="lead", to="alice", content=f"msg-{i}")

    with ThreadPoolExecutor(max_workers=12) as pool:
        list(pool.map(send, range(80)))

    path = store.inbox_path("alice")
    rows = [json.loads(line) for line in path.read_text(encoding="utf-8").splitlines()]
    assert len(rows) == 80
    assert {row["content"] for row in rows} == {f"msg-{i}" for i in range(80)}


def test_store_concurrent_upsert_preserves_members(tmp_path: Path) -> None:
    store = TeamStore(tmp_path)

    def upsert(i: int) -> None:
        store.upsert_member(TeamMember(
            name=f"member-{i}",
            role="coder",
            agent_type="neiguan_yingzao",
        ))

    with ThreadPoolExecutor(max_workers=12) as pool:
        list(pool.map(upsert, range(40)))

    assert {member.name for member in store.list_members()} == {f"member-{i}" for i in range(40)}


def test_stale_working_members_become_offline(tmp_path: Path) -> None:
    store = TeamStore(tmp_path)
    store.upsert_member(TeamMember(name="alice", role="coder", agent_type="neiguan_yingzao", status="working"))

    reloaded = TeamStore(tmp_path)

    assert reloaded.get_member("alice").status == "offline"
