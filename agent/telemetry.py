"""Token usage tracking — per-call JSONL log + aggregations."""
from __future__ import annotations

import json
from collections import defaultdict
from datetime import datetime
from pathlib import Path


_TOKEN_KEYS = ("input", "output", "cache_read", "cache_create")


class TokenTracker:
    def __init__(self, log_file: Path):
        self.log_file = log_file
        self.log_file.parent.mkdir(parents=True, exist_ok=True)
        self._last_input_tokens = self._load_last_input_tokens()

    def record(
        self,
        model: str,
        usage,
        *,
        provider: str | None = None,
        usage_type: str = "main_agent",
    ) -> None:
        """Append one row to tokens.jsonl from a provider usage object or dict."""
        if isinstance(usage, dict):
            input_tokens = usage.get("input", usage.get("prompt_tokens", 0)) or 0
            output_tokens = usage.get("output", usage.get("completion_tokens", 0)) or 0
            cache_read = usage.get("cache_read", usage.get("cache_read_input_tokens", 0)) or 0
            cache_create = usage.get("cache_create", usage.get("cache_creation_input_tokens", 0)) or 0
        else:
            input_tokens = getattr(usage, "input_tokens", 0) or 0
            output_tokens = getattr(usage, "output_tokens", 0) or 0
            cache_read = getattr(usage, "cache_read_input_tokens", 0) or 0
            cache_create = getattr(usage, "cache_creation_input_tokens", 0) or 0
        row = {
            "ts": datetime.now().isoformat(timespec="seconds"),
            "provider": provider or "unknown",
            "model": model,
            "usage_type": usage_type,
            "input": input_tokens,
            "output": output_tokens,
            "cache_read": cache_read,
            "cache_create": cache_create,
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

    def _load_last_input_tokens(self) -> int:
        last: dict | None = None
        for row in self._iter_rows() or []:
            last = row
        return _input_total(last or {})

    def recent_calls(self, limit: int = 20) -> list[dict[str, int | str]]:
        if limit <= 0:
            return []
        rows = [_normalize_row(r) for r in self._iter_rows()]
        return rows[-limit:][::-1]

    def recent_cache_calls(self, limit: int = 20) -> list[dict[str, int | str]]:
        if limit <= 0:
            return []
        rows = [
            row
            for row in (_normalize_row(r) for r in self._iter_rows())
            if int(row.get("cache_read", 0) or 0) > 0 or int(row.get("cache_create", 0) or 0) > 0
        ]
        return rows[-limit:][::-1]

    def stats_by_date(self) -> dict[str, dict[str, int]]:
        out: dict[str, dict[str, int]] = defaultdict(_empty_stats)
        for r in self._iter_rows():
            date = r.get("ts", "")[:10]
            _add_row(out[date], r)
        return dict(out)

    def stats_by_model(self) -> dict[str, dict[str, int]]:
        out: dict[str, dict[str, int]] = defaultdict(_empty_stats)
        for r in self._iter_rows():
            m = r.get("model", "unknown")
            _add_row(out[m], r)
        return dict(out)

    def stats_by_provider_model(self) -> dict[str, dict[str, int | str]]:
        out: dict[str, dict[str, int | str]] = defaultdict(_empty_stats)
        for r in self._iter_rows():
            provider = r.get("provider") or "unknown"
            model = r.get("model") or "unknown"
            key = f"{provider}/{model}" if provider != "unknown" else model
            bucket = out[key]
            bucket["provider"] = provider
            bucket["model"] = model
            _add_row(bucket, r)
        return dict(out)

    def stats_by_usage_type(self) -> dict[str, dict[str, int]]:
        out: dict[str, dict[str, int]] = defaultdict(_empty_stats)
        for r in self._iter_rows():
            usage_type = r.get("usage_type") or "main_agent"
            _add_row(out[usage_type], r)
        return dict(out)

    def totals(self) -> dict[str, int]:
        out = _empty_stats()
        for r in self._iter_rows():
            _add_row(out, r)
        return out

    def stats_by_date_model(self) -> dict[str, dict[str, dict[str, int | str]]]:
        out: dict[str, dict[str, dict[str, int | str]]] = defaultdict(dict)
        for r in self._iter_rows():
            date = r.get("ts", "")[:10]
            if not date:
                continue
            provider = r.get("provider") or "unknown"
            model = r.get("model") or "unknown"
            key = f"{provider}/{model}" if provider != "unknown" else model
            bucket = out[date].setdefault(key, _empty_stats())
            bucket["provider"] = provider
            bucket["model"] = model
            _add_row(bucket, r)
        return dict(out)

    def stats_by_hour(self) -> dict[str, dict[str, int]]:
        out: dict[str, dict[str, int]] = {f"{h:02d}": _empty_stats() for h in range(24)}
        for r in self._iter_rows():
            ts = r.get("ts", "")
            hour = ts[11:13] if len(ts) >= 13 else ""
            if hour not in out:
                continue
            _add_row(out[hour], r)
        return out

    def streak_metrics(self) -> dict[str, int]:
        dates = sorted({r.get("ts", "")[:10] for r in self._iter_rows() if r.get("ts")})
        if not dates:
            return {"active_days": 0, "current_streak": 0, "longest_streak": 0}

        longest = current = 1
        for prev, curr in zip(dates, dates[1:]):
            try:
                gap = (datetime.fromisoformat(curr) - datetime.fromisoformat(prev)).days
            except ValueError:
                gap = 99
            if gap == 1:
                current += 1
                longest = max(longest, current)
            else:
                current = 1

        today = datetime.now().date().isoformat()
        if dates[-1] != today:
            current_streak = 0
        else:
            current_streak = 1
            for prev, curr in zip(reversed(dates[:-1]), reversed(dates[1:])):
                try:
                    gap = (datetime.fromisoformat(curr) - datetime.fromisoformat(prev)).days
                except ValueError:
                    break
                if gap == 1:
                    current_streak += 1
                else:
                    break
        return {
            "active_days": len(dates),
            "current_streak": current_streak,
            "longest_streak": longest,
        }

    def session_count(self, gap_minutes: int = 30) -> int:
        timestamps = []
        for r in self._iter_rows():
            ts = r.get("ts", "")
            try:
                timestamps.append(datetime.fromisoformat(ts))
            except ValueError:
                continue
        if not timestamps:
            return 0
        timestamps.sort()
        sessions = 1
        gap = gap_minutes * 60
        for prev, curr in zip(timestamps, timestamps[1:]):
            if (curr - prev).total_seconds() > gap:
                sessions += 1
        return sessions


def _empty_stats() -> dict[str, int]:
    return {"calls": 0, "input": 0, "output": 0, "cache_read": 0, "cache_create": 0, "total": 0}


def _add_row(bucket: dict, row: dict) -> None:
    bucket["calls"] = int(bucket.get("calls", 0)) + 1
    total = 0
    for key in _TOKEN_KEYS:
        value = int(row.get(key, 0) or 0)
        bucket[key] = int(bucket.get(key, 0)) + value
        total += value
    bucket["total"] = int(bucket.get("total", 0)) + total


def _normalize_row(row: dict) -> dict[str, int | str]:
    input_tokens = _row_int(row, "input", "prompt_tokens")
    output_tokens = _row_int(row, "output", "completion_tokens")
    cache_read = _row_int(row, "cache_read", "cache_read_input_tokens")
    cache_create = _row_int(row, "cache_create", "cache_creation_input_tokens")
    return {
        "ts": str(row.get("ts") or ""),
        "provider": str(row.get("provider") or "unknown"),
        "model": str(row.get("model") or "unknown"),
        "usage_type": str(row.get("usage_type") or "main_agent"),
        "input": input_tokens,
        "output": output_tokens,
        "cache_read": cache_read,
        "cache_create": cache_create,
        "total": input_tokens + output_tokens + cache_read + cache_create,
    }


def _row_int(row: dict, *keys: str) -> int:
    for key in keys:
        if key in row:
            try:
                return int(row.get(key) or 0)
            except (TypeError, ValueError):
                return 0
    return 0


def _input_total(row: dict) -> int:
    input_tokens = _row_int(row, "input", "prompt_tokens")
    cache_read = _row_int(row, "cache_read", "cache_read_input_tokens")
    cache_create = _row_int(row, "cache_create", "cache_creation_input_tokens")
    return input_tokens + cache_read + cache_create
