"""Tests for Agent Team storage, bus, and wake orchestration."""

from __future__ import annotations

import json
from pathlib import Path

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
    def __init__(self, reply: str = "done"):
        self.reply = reply

    def step(self, history):
        history.append({"role": "assistant", "content": self.reply})
        return self.reply


def make_manager(tmp_path: Path) -> TeamManager:
    def runner_factory(**kwargs):
        return FakeRunner("fake teammate result")

    return TeamManager(
        root=tmp_path,
        parent_registry=ToolRegistry(),
        subagent_registry=FakeSubagentRegistry(),
        runner_factory=runner_factory,
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


def test_stale_working_members_become_offline(tmp_path: Path) -> None:
    store = TeamStore(tmp_path)
    store.upsert_member(TeamMember(name="alice", role="coder", agent_type="neiguan_yingzao", status="working"))

    reloaded = TeamStore(tmp_path)

    assert reloaded.get_member("alice").status == "offline"
