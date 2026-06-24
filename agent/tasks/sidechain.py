from __future__ import annotations

import json
import time
from pathlib import Path
from typing import Any


class SidechainTranscript:
    def __init__(self, root: Path | str, task_id: str) -> None:
        self.root = Path(root)
        self.task_id = task_id
        self.path = self.root / "memory" / "tasks" / task_id / "transcript.jsonl"

    def append(self, message: dict[str, Any]) -> None:
        self.path.parent.mkdir(parents=True, exist_ok=True)
        payload = dict(message)
        payload.setdefault("task_id", self.task_id)
        payload.setdefault("sidechain", True)
        payload.setdefault("ts", time.time())
        with self.path.open("a", encoding="utf-8") as file:
            file.write(json.dumps(payload, ensure_ascii=False) + "\n")

    def extend(self, messages: list[dict[str, Any]]) -> None:
        for message in messages:
            self.append(message)

    def read(self, *, offset: int = 0, limit: int = 100) -> dict[str, Any]:
        messages: list[dict[str, Any]] = []
        next_offset = 0
        if not self.path.exists():
            return {"messages": [], "nextOffset": 0, "path": str(self.path)}
        with self.path.open("r", encoding="utf-8") as file:
            for line_number, line in enumerate(file):
                next_offset = line_number + 1
                if line_number < offset:
                    continue
                if len(messages) >= limit:
                    break
                try:
                    payload = json.loads(line)
                except json.JSONDecodeError:
                    continue
                if isinstance(payload, dict):
                    messages.append(payload)
        return {
            "messages": messages,
            "nextOffset": min(next_offset, offset + len(messages)),
            "path": str(self.path),
        }
