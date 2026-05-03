"""Three-tier memory store: raw history / daily episodes / long-term memory."""
from __future__ import annotations

import json
from datetime import datetime, timezone, timedelta
from pathlib import Path
from typing import Any


_UTC8 = timezone(timedelta(hours=8))


class MemoryStore:
    def __init__(self, memory_dir: Path, user_file: Path):
        self.memory_dir = memory_dir
        self.memory_file = memory_dir / "MEMORY.md"
        self.history_file = memory_dir / "history.jsonl"
        self.user_file = user_file
        self._ensure()

    def _ensure(self) -> None:
        self.memory_dir.mkdir(parents=True, exist_ok=True)
        if not self.memory_file.exists():
            self.memory_file.write_text("# 长期记忆\n\n此文件常驻上下文，记录核心目标、当前任务与关键事实。\n")
        if not self.history_file.exists():
            self.history_file.write_text("")

    # ── 原始层 ──────────────────────────────────────────────
    def append_history(self, role: str, content: Any) -> None:
        row = {
            "ts": datetime.now(_UTC8).isoformat(timespec="seconds"),
            "role": role,
            "content": content if isinstance(content, str) else _json_safe(content),
        }
        with self.history_file.open("a", encoding="utf-8") as f:
            f.write(json.dumps(row, ensure_ascii=False) + "\n")

    # ── 中期层（按日历日 UTC+8）────────────────────────────
    def today_episode_path(self) -> Path:
        date = datetime.now(_UTC8).strftime("%Y-%m-%d")
        return self.memory_dir / f"{date}.md"

    def read_today_episode(self) -> str:
        p = self.today_episode_path()
        return p.read_text(encoding="utf-8") if p.exists() else ""

    def append_episode(self, content: str) -> None:
        p = self.today_episode_path()
        existing = p.read_text(encoding="utf-8") if p.exists() else f"# {p.stem} 情景记忆\n"
        new_text = existing.rstrip() + "\n\n" + content.strip() + "\n"
        p.write_text(new_text, encoding="utf-8")

    # ── 长期层 ──────────────────────────────────────────────
    def read_memory(self) -> str:
        return self.memory_file.read_text(encoding="utf-8") if self.memory_file.exists() else ""

    def write_memory(self, content: str) -> None:
        self.memory_file.write_text(content.strip() + "\n", encoding="utf-8")

    # ── 归档标记 ────────────────────────────────────────────
    def append_compact_marker(self) -> None:
        row = {"ts": datetime.now(_UTC8).isoformat(timespec="seconds"), "type": "compact_event"}
        with self.history_file.open("a", encoding="utf-8") as f:
            f.write(json.dumps(row, ensure_ascii=False) + "\n")

    def load_unarchived_history(self) -> list:
        """返回最后一个 compact_event 之后的未归档对话条目。"""
        if not self.history_file.exists():
            return []
        rows = []
        with self.history_file.open("r", encoding="utf-8") as f:
            for line in f:
                line = line.strip()
                if not line:
                    continue
                try:
                    rows.append(json.loads(line))
                except json.JSONDecodeError:
                    continue
        last_marker = -1
        for i, row in enumerate(rows):
            if row.get("type") == "compact_event":
                last_marker = i
        return [
            {"role": r["role"], "content": r["content"]}
            for r in rows[last_marker + 1:]
            if "role" in r and "content" in r
        ]

    # ── 用户偏好 ────────────────────────────────────────────
    def read_user(self) -> str:
        return self.user_file.read_text(encoding="utf-8") if self.user_file.exists() else ""

    def write_user(self, content: str) -> None:
        self.user_file.write_text(content.strip() + "\n", encoding="utf-8")


def _json_safe(obj: Any) -> Any:
    """Convert anthropic content blocks (or anything) into JSON-serialisable form."""
    try:
        json.dumps(obj, ensure_ascii=False)
        return obj
    except (TypeError, ValueError):
        pass
    if isinstance(obj, list):
        return [_json_safe(x) for x in obj]
    if isinstance(obj, dict):
        return {k: _json_safe(v) for k, v in obj.items()}
    if hasattr(obj, "model_dump"):
        return obj.model_dump()
    if hasattr(obj, "__dict__"):
        return {k: _json_safe(v) for k, v in obj.__dict__.items() if not k.startswith("_")}
    return str(obj)
