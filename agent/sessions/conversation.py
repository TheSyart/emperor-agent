"""Per-session conversation store backed by a HistoryLog.

Each ConversationStore owns the raw history, checkpoint, and archive for
one session, stored under ``memory/sessions/<id>/``. The shared
MemoryStore retains the global layers (memory, user, episodes, versions).
"""
from __future__ import annotations

from pathlib import Path

from agent.memory_history import HistoryLog


class ConversationStore:
    """Scoped conversation persistence for a single session."""

    def __init__(self, session_dir: Path) -> None:
        self.session_dir = session_dir
        self.session_dir.mkdir(parents=True, exist_ok=True)
        self.history_file = session_dir / "history.jsonl"
        self.checkpoint_file = session_dir / "_checkpoint.json"
        self.history_log = HistoryLog(session_dir, self.history_file)

    # ── history ─────────────────────────────────────────────────────
    def append_history(
        self, role: str, content: object, *, extra: dict | None = None
    ) -> None:
        from datetime import datetime, timezone, timedelta
        import json as _json

        _UTC8 = timezone(timedelta(hours=8))
        row: dict = {
            "ts": datetime.now(_UTC8).isoformat(timespec="seconds"),
            "role": role,
            "content": content if isinstance(content, str) else _json.dumps(content, ensure_ascii=False),
        }
        if extra:
            for k, v in extra.items():
                if k not in row:
                    row[k] = v
        self.history_log.append(row)

    def load_unarchived_history(self) -> list[dict]:
        return self.history_log.load_active_rows()

    def load_unarchived_turn_ids(self) -> list[str]:
        ids: list[str] = []
        seen: set[str] = set()
        for row in self.load_unarchived_history():
            if "role" in row and "content" in row:
                tid = row.get("turn_id")
                if isinstance(tid, str) and tid and tid not in seen:
                    seen.add(tid)
                    ids.append(tid)
        return ids

    def append_compact_marker(
        self, active_history: list[dict] | None = None
    ) -> None:
        if active_history is None:
            row = {"ts": "", "type": "compact_event"}
            self.history_log.append(row)
            return
        self.history_log.compact(active_history)

    def stats(self) -> dict:
        return self.history_log.stats()

    # ── checkpoint ──────────────────────────────────────────────────
    def write_checkpoint(self, history: list[dict]) -> None:
        import json as _json
        from datetime import datetime, timezone, timedelta

        _UTC8 = timezone(timedelta(hours=8))
        payload = {
            "ts": datetime.now(_UTC8).isoformat(timespec="seconds"),
            "history": history,
        }
        tmp = self.checkpoint_file.with_suffix(".json.tmp")
        tmp.write_text(_json.dumps(payload, ensure_ascii=False), encoding="utf-8")
        tmp.replace(self.checkpoint_file)

    def read_checkpoint(self) -> list[dict] | None:
        import json as _json

        if not self.checkpoint_file.exists():
            return None
        try:
            data = _json.loads(self.checkpoint_file.read_text(encoding="utf-8"))
        except (_json.JSONDecodeError, OSError):
            return None
        history = data.get("history") if isinstance(data, dict) else None
        return history if isinstance(history, list) else None

    def clear_checkpoint(self) -> None:
        self.checkpoint_file.unlink(missing_ok=True)
