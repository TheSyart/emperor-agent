from __future__ import annotations

import json
import os
from contextlib import suppress
from pathlib import Path
from threading import RLock
from uuid import uuid4

from .models import WatchlistDecision


DEFAULT_WATCHLIST = """# Watchlist

记录希望 Emperor Agent 主动定期检查的事项。每行写一个明确目标，暂不需要的项可用 HTML 注释包住。

- 示例：每天下午检查是否有需要整理的项目跟进事项。
"""


class WatchlistStore:
    def __init__(self, root: Path):
        self.root = Path(root).resolve()
        self.path = self.root / "memory" / "watchlist.md"
        self.state_path = self.root / "memory" / "watchlist_state.json"
        self._lock = RLock()
        self._ensure()

    def read(self) -> str:
        with self._lock:
            self._ensure()
            return self.path.read_text(encoding="utf-8")

    def write(self, content: str) -> str:
        with self._lock:
            self._atomic_write_text(self.path, str(content or "").rstrip() + "\n")
            return self.path.read_text(encoding="utf-8")

    def read_state(self) -> dict:
        with self._lock:
            if not self.state_path.exists():
                return {}
            try:
                raw = json.loads(self.state_path.read_text(encoding="utf-8") or "{}")
                return raw if isinstance(raw, dict) else {}
            except json.JSONDecodeError:
                return {}

    def write_decision(self, decision: WatchlistDecision) -> None:
        with self._lock:
            self._atomic_write_json(self.state_path, {"lastDecision": decision.to_dict()})

    def payload(self) -> dict:
        state = self.read_state()
        return {
            "content": self.read(),
            "lastDecision": state.get("lastDecision") if isinstance(state.get("lastDecision"), dict) else None,
        }

    def active_items(self) -> list[str]:
        items: list[str] = []
        for line in self.read().splitlines():
            stripped = line.strip()
            if not stripped or stripped.startswith("#") or stripped.startswith("<!--"):
                continue
            if stripped.startswith("- [ ]"):
                stripped = stripped[5:].strip()
            elif stripped.startswith("-"):
                stripped = stripped[1:].strip()
            else:
                continue
            if stripped and not stripped.startswith("示例："):
                items.append(stripped)
        return items

    def _ensure(self) -> None:
        self.path.parent.mkdir(parents=True, exist_ok=True)
        if not self.path.exists():
            self._atomic_write_text(self.path, DEFAULT_WATCHLIST)

    @staticmethod
    def _atomic_write_text(path: Path, content: str) -> None:
        path.parent.mkdir(parents=True, exist_ok=True)
        tmp = path.with_name(f".{path.name}.{uuid4().hex}.tmp")
        try:
            tmp.write_text(content, encoding="utf-8")
            tmp.replace(path)
        except BaseException:
            tmp.unlink(missing_ok=True)
            raise

    @staticmethod
    def _atomic_write_json(path: Path, payload: dict) -> None:
        path.parent.mkdir(parents=True, exist_ok=True)
        tmp = path.with_name(f".{path.name}.{uuid4().hex}.tmp")
        try:
            with tmp.open("w", encoding="utf-8") as f:
                f.write(json.dumps(payload, ensure_ascii=False, indent=2) + "\n")
                f.flush()
                with suppress(OSError):
                    os.fsync(f.fileno())
            tmp.replace(path)
        except BaseException:
            tmp.unlink(missing_ok=True)
            raise
