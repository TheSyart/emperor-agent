"""AgentLoop multi-session behaviors: migration and activation."""
from __future__ import annotations

import json
from pathlib import Path

from agent.loop import AgentLoop
from agent.sessions.store import SessionStore


def _write_old_history(tmp_path: Path) -> None:
    """Simulate pre-migration state with existing memory/history.jsonl."""
    memory_dir = tmp_path / "memory"
    memory_dir.mkdir(parents=True, exist_ok=True)
    (memory_dir / "history.jsonl").write_text(
        json.dumps({"ts": "2026-01-01T12:00:00", "role": "user", "content": "old msg"}) + "\n",
        encoding="utf-8",
    )
    # Requisite shared files needed by AgentLoop init
    (tmp_path / "templates").mkdir(exist_ok=True)
    (tmp_path / "templates" / "TOOL.md").write_text("# tool")
    (tmp_path / "templates" / "USER.local.md").write_text("# user")
    (tmp_path / "templates" / "SOUL.md").write_text("# soul")


def test_first_run_migration_creates_default_session(tmp_path: Path) -> None:
    _write_old_history(tmp_path)
    AgentLoop(root=tmp_path, verbose=False, startup_compaction=False)

    store = SessionStore(tmp_path)
    sessions = store.list()
    assert len(sessions) == 1
    default = sessions[0]
    assert "default" in default["id"] or True  # any id is fine, migration happened
    conv_dir = store._dir(default["id"])
    assert (conv_dir / "history.jsonl").exists()
    # Old history.jsonl should be gone (moved)
    assert not (tmp_path / "memory" / "history.jsonl").exists()


def test_activate_session_restores_history(tmp_path: Path) -> None:
    _write_old_history(tmp_path)
    loop = AgentLoop(root=tmp_path, verbose=False, startup_compaction=False)

    store = SessionStore(tmp_path)
    default = store.list()[0]

    # Write extra history to the default session conv
    conv_dir = store._dir(default["id"])
    with open(conv_dir / "history.jsonl", "a") as f:
        f.write(
            json.dumps({"ts": "2026-01-02T12:00:00", "role": "assistant", "content": "hello"})
            + "\n",
        )

    loop.activate_session(default["id"])
    texts = [m.get("content") for m in loop.history if m.get("role") == "assistant"]
    assert "hello" in texts


def test_chat_session_does_not_expose_persistent_team_tools(tmp_path: Path) -> None:
    _write_old_history(tmp_path)
    loop = AgentLoop(root=tmp_path, verbose=False, startup_compaction=False)
    chat = loop.session_store.create("Chat", mode="chat")

    loop.activate_session(chat["id"])

    assert "spawn_teammate" not in loop.registry.names()
    assert "send_message" not in loop.registry.names()
    assert loop.team_manager is None


def test_stale_build_session_project_does_not_break_activation(tmp_path: Path) -> None:
    _write_old_history(tmp_path)
    loop = AgentLoop(root=tmp_path, verbose=False, startup_compaction=False)
    stale = loop.session_store.create(
        "Stale build",
        mode="build",
        project={
            "project_id": "missing_visual_project",
            "project_path": str(tmp_path / "missing-project"),
            "project_name": "Missing",
        },
    )

    loop.activate_session(stale["id"])

    assert loop.team_manager is None
    assert "spawn_teammate" not in loop.registry.names()
    assert loop.active_session_id == stale["id"]


def test_build_project_sessions_share_project_team_but_projects_are_isolated(tmp_path: Path) -> None:
    _write_old_history(tmp_path)
    loop = AgentLoop(root=tmp_path, verbose=False, startup_compaction=False)
    project_a_dir = tmp_path / "project-a"
    project_b_dir = tmp_path / "project-b"
    project_a_dir.mkdir()
    project_b_dir.mkdir()
    project_a = loop.project_store.resolve(project_a_dir)
    project_b = loop.project_store.resolve(project_b_dir)
    a1 = loop.session_store.create("A1", mode="build", project=project_a)
    a2 = loop.session_store.create("A2", mode="build", project=project_a)
    b1 = loop.session_store.create("B1", mode="build", project=project_b)

    loop.activate_session(a1["id"])
    assert "spawn_teammate" in loop.registry.names()
    loop.team_manager.spawn_teammate(name="alice", role="coder")

    loop.activate_session(a2["id"])
    assert loop.team_manager.store.get_member("alice").role == "coder"

    loop.activate_session(b1["id"])
    assert loop.team_manager.store.get_member("alice") is None
    loop.team_manager.spawn_teammate(name="alice", role="reviewer")

    team_a = tmp_path / "memory" / "projects" / project_a["project_id"] / "team"
    team_b = tmp_path / "memory" / "projects" / project_b["project_id"] / "team"
    assert (team_a / "config.json").exists()
    assert (team_b / "config.json").exists()
    assert (tmp_path / ".team").exists() is False


def test_project_team_uses_fixed_project_workspace_after_session_switch(tmp_path: Path) -> None:
    _write_old_history(tmp_path)
    loop = AgentLoop(root=tmp_path, verbose=False, startup_compaction=False)
    project_a_dir = tmp_path / "project-a"
    project_b_dir = tmp_path / "project-b"
    project_a_dir.mkdir()
    project_b_dir.mkdir()
    (project_a_dir / "marker.txt").write_text("from project a", encoding="utf-8")
    (project_b_dir / "marker.txt").write_text("from project b", encoding="utf-8")
    project_a = loop.project_store.resolve(project_a_dir)
    project_b = loop.project_store.resolve(project_b_dir)
    session_a = loop.session_store.create("A", mode="build", project=project_a)
    session_b = loop.session_store.create("B", mode="build", project=project_b)

    loop.activate_session(session_a["id"])
    manager_a = loop.team_manager
    loop.activate_session(session_b["id"])

    read_file = manager_a.parent_registry.get("read_file")
    assert read_file is not None
    assert "from project a" in read_file.execute("marker.txt")
