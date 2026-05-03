"""Token usage tracking — per-call JSONL log + aggregations."""
from __future__ import annotations

import json
from collections import defaultdict
from datetime import datetime
from pathlib import Path


class TokenTracker:
    def __init__(self, log_file: Path):
        self.log_file = log_file
        self.log_file.parent.mkdir(parents=True, exist_ok=True)
        self._last_input_tokens = 0

    def record(self, model: str, usage) -> None:
        """Append one row to tokens.jsonl from an anthropic Message.usage."""
        row = {
            "ts": datetime.now().isoformat(timespec="seconds"),
            "model": model,
            "input": getattr(usage, "input_tokens", 0) or 0,
            "output": getattr(usage, "output_tokens", 0) or 0,
            "cache_read": getattr(usage, "cache_read_input_tokens", 0) or 0,
            "cache_create": getattr(usage, "cache_creation_input_tokens", 0) or 0,
        }
        self._last_input_tokens = row["input"] + row["cache_read"] + row["cache_create"]
        with self.log_file.open("a", encoding="utf-8") as f:
            f.write(json.dumps(row, ensure_ascii=False) + "\n")

    def last_input_tokens(self) -> int:
        return self._last_input_tokens

    def should_compact(self, max_context: int, threshold: float = 0.7) -> bool:
        return self._last_input_tokens > max_context * threshold

    def _iter_rows(self):
        if not self.log_file.exists():
            return
        with self.log_file.open("r", encoding="utf-8") as f:
            for line in f:
                line = line.strip()
                if not line:
                    continue
                try:
                    yield json.loads(line)
                except json.JSONDecodeError:
                    continue

    def stats_by_date(self) -> dict[str, dict[str, int]]:
        out: dict[str, dict[str, int]] = defaultdict(lambda: {"input": 0, "output": 0, "cache_read": 0, "cache_create": 0})
        for r in self._iter_rows():
            date = r.get("ts", "")[:10]
            for k in ("input", "output", "cache_read", "cache_create"):
                out[date][k] += r.get(k, 0)
        return dict(out)

    def stats_by_model(self) -> dict[str, dict[str, int]]:
        out: dict[str, dict[str, int]] = defaultdict(lambda: {"input": 0, "output": 0, "cache_read": 0, "cache_create": 0})
        for r in self._iter_rows():
            m = r.get("model", "unknown")
            for k in ("input", "output", "cache_read", "cache_create"):
                out[m][k] += r.get(k, 0)
        return dict(out)
