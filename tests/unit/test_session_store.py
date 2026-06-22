from __future__ import annotations

import json
from pathlib import Path

from agent.sessions.store import SessionStore


def test_create_creates_directory_and_entry(tmp_path: Path) -> None:
    store = SessionStore(tmp_path)
    s = store.create("First Session")
    assert s["title"].startswith("First Session")
    assert s["id"]
    assert (tmp_path / "sessions" / s["id"]).is_dir()

    index_path = tmp_path / "sessions" / "index.json"
    assert index_path.exists()
    data = json.loads(index_path.read_text())
    assert len(data) == 1
    assert data[0]["title"].startswith("First Session")


def test_list_returns_ordered_by_updated_at(tmp_path: Path) -> None:
    store = SessionStore(tmp_path)
    a = store.create("A")
    b = store.create("B")
    items = store.list()
    ids = [x["id"] for x in items]
    assert a["id"] in ids
    assert b["id"] in ids
    assert len(ids) == 2


def test_delete_removes_entry_and_directory(tmp_path: Path) -> None:
    store = SessionStore(tmp_path)
    store.create("Keeper")  # so we have ≥2 — delete rejects singleton
    s = store.create("To Delete")
    sid = s["id"]
    ok = store.delete(sid)
    assert ok
    assert sid not in [x["id"] for x in store.list()]
    assert not (tmp_path / "sessions" / sid).exists()


def test_delete_nonexistent_returns_false(tmp_path: Path) -> None:
    store = SessionStore(tmp_path)
    assert store.delete("no-such-id") is False


def test_delete_last_session_returns_false(tmp_path: Path) -> None:
    """At least one session must always remain."""
    store = SessionStore(tmp_path)
    s = store.create("Only")
    assert store.delete(s["id"]) is False


def test_rename_updates_title(tmp_path: Path) -> None:
    store = SessionStore(tmp_path)
    s = store.create("Old Title")
    ok = store.rename(s["id"], "New Title")
    assert ok
    item = next(x for x in store.list() if x["id"] == s["id"])
    assert item["title"] == "New Title"


def test_rename_nonexistent_returns_false(tmp_path: Path) -> None:
    store = SessionStore(tmp_path)
    assert store.rename("noop", "X") is False


def test_corrupt_index_is_quarantined_and_rebuilt(tmp_path: Path) -> None:
    sessions_dir = tmp_path / "sessions"
    sessions_dir.mkdir(parents=True, exist_ok=True)
    (sessions_dir / "index.json").write_text("not valid json{{{")

    store = SessionStore(tmp_path)
    items = store.list()
    assert items == []

    # Corrupt backup should exist
    corrupts = sorted(sessions_dir.glob("index.corrupt-*.json"))
    assert len(corrupts) == 1
    assert "not valid json" in corrupts[0].read_text()


def test_touch_updates_preview_and_timestamp(tmp_path: Path) -> None:
    store = SessionStore(tmp_path)
    s = store.create("T")
    ok = store.touch(s["id"], "hello world")
    assert ok
    item = next(x for x in store.list() if x["id"] == s["id"])
    assert item["preview"] == "hello world"
