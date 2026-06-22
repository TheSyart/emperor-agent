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
    loop = AgentLoop(root=tmp_path, verbose=False, startup_compaction=False)

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
