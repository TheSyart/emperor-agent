from __future__ import annotations

import json
from pathlib import Path
from datetime import datetime, timezone, timedelta

from agent.sessions import ConversationStore

_UTC8 = timezone(timedelta(hours=8))


def test_two_stores_are_independent(tmp_path: Path) -> None:
    """Append to two different stores; each sees only its own rows."""
    a = ConversationStore(tmp_path / "a")
    b = ConversationStore(tmp_path / "b")

    a.append_history("user", "hello a")
    b.append_history("user", "hello b")

    a_rows = a.load_unarchived_history()
    b_rows = b.load_unarchived_history()

    a_texts = [r["content"] for r in a_rows if r["role"] == "user"]
    b_texts = [r["content"] for r in b_rows if r["role"] == "user"]
    assert "hello a" in a_texts
    assert "hello b" not in a_texts
    assert "hello b" in b_texts
    assert "hello a" not in b_texts


def test_append_history_round_trip(tmp_path: Path) -> None:
    store = ConversationStore(tmp_path / "s1")
    store.append_history("user", "hi")
    store.append_history("assistant", "hello", extra={"turn_id": "turn_1"})

    rows = store.load_unarchived_history()
    assert len(rows) >= 2
    user_rows = [r for r in rows if r["role"] == "user"]
    assert len(user_rows) >= 1
    assert user_rows[0]["content"] == "hi"

    asst = [r for r in rows if r["role"] == "assistant"]
    assert len(asst) >= 1
    assert asst[0].get("turn_id") == "turn_1"


def test_checkpoint_write_read_clear(tmp_path: Path) -> None:
    store = ConversationStore(tmp_path / "s2")
    assert store.read_checkpoint() is None

    store.write_checkpoint([{"role": "user", "content": "in-flight"}])
    chk = store.read_checkpoint()
    assert chk is not None
    assert len(chk) == 1
    assert chk[0]["content"] == "in-flight"

    store.clear_checkpoint()
    assert store.read_checkpoint() is None


def test_load_unarchived_turn_ids(tmp_path: Path) -> None:
    store = ConversationStore(tmp_path / "s3")
    store.append_history("user", "q1", extra={"turn_id": "t1"})
    store.append_history("assistant", "a1", extra={"turn_id": "t1"})
    store.append_history("user", "q2", extra={"turn_id": "t2"})

    ids = store.load_unarchived_turn_ids()
    assert "t1" in ids
    assert "t2" in ids
    assert len(ids) == 2
