"""Session registry stored as ``memory/sessions/index.json``.

Each session entry: ``{id, title, created_at, updated_at, preview, version}``.
"""
from __future__ import annotations

import json
import shutil
import uuid
from datetime import datetime, timezone, timedelta
from pathlib import Path

_UTC8 = timezone(timedelta(hours=8))
_VERSION = 1


class SessionStore:
    def __init__(self, root: Path) -> None:
        self.sessions_dir = root / "sessions"
        self.index_path = self.sessions_dir / "index.json"

    # ── internal helpers ────────────────────────────────────────────
    def _load(self) -> list[dict]:
        if not self.index_path.exists():
            return []
        try:
            raw = self.index_path.read_text(encoding="utf-8").strip()
            if not raw:
                return []
            data = json.loads(raw)
            if not isinstance(data, list):
                raise ValueError("index.json must be a list")
            return data
        except (json.JSONDecodeError, ValueError, OSError):
            # Quarantine corrupt index, start fresh
            ts = datetime.now(_UTC8).strftime("%Y%m%dT%H%M%S")
            corrupt_path = self.sessions_dir / f"index.corrupt-{ts}.json"
            try:
                shutil.move(str(self.index_path), str(corrupt_path))
            except OSError:
                pass
            return []

    def _save(self, items: list[dict]) -> None:
        self.sessions_dir.mkdir(parents=True, exist_ok=True)
        tmp = self.index_path.with_suffix(".json.tmp")
        tmp.write_text(
            json.dumps(items, ensure_ascii=False, indent=2) + "\n",
            encoding="utf-8",
        )
        tmp.replace(self.index_path)

    def _stamp(self) -> str:
        return datetime.now(_UTC8).strftime("%Y-%m-%dT%H:%M:%S%z")

    def _dir(self, session_id: str) -> Path:
        return self.sessions_dir / session_id

    # ── public API ──────────────────────────────────────────────────
    def list(self) -> list[dict]:
        items = self._load()
        items.sort(key=lambda x: x.get("updated_at", ""), reverse=True)
        return items

    def create(self, title: str = "") -> dict:
        now = self._stamp()
        sid = uuid.uuid4().hex[:16]
        entry = {
            "id": sid,
            "title": title.strip() or "Untitled",
            "created_at": now,
            "updated_at": now,
            "preview": "",
            "version": _VERSION,
        }
        items = self._load()
        items.append(entry)
        self._save(items)
        self._dir(sid).mkdir(parents=True, exist_ok=True)
        return entry

    def delete(self, session_id: str) -> bool:
        items = self._load()
        if len(items) <= 1:
            return False
        idx = next((i for i, e in enumerate(items) if e.get("id") == session_id), None)
        if idx is None:
            return False
        del items[idx]
        self._save(items)
        shutil.rmtree(self._dir(session_id), ignore_errors=True)
        return True

    def rename(self, session_id: str, title: str) -> bool:
        items = self._load()
        for e in items:
            if e.get("id") == session_id:
                e["title"] = title.strip()
                e["updated_at"] = self._stamp()
                self._save(items)
                return True
        return False

    def touch(self, session_id: str, preview: str) -> bool:
        items = self._load()
        for e in items:
            if e.get("id") == session_id:
                e["preview"] = preview[:280]
                e["updated_at"] = self._stamp()
                self._save(items)
                return True
        return False
