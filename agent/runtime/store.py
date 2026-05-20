from __future__ import annotations

import gzip
import json
import os
import time
from contextlib import suppress
from datetime import datetime
from pathlib import Path
from threading import RLock
from typing import Any
from uuid import uuid4


class RuntimeEventStore:
    """Hot/cold durable event log for reconstructing the WebUI chat timeline."""

    def __init__(self, root: Path):
        self.root = Path(root).resolve()
        self.runtime_dir = self.root / "memory" / "runtime"
        self.events_file = self.runtime_dir / "events.jsonl"
        self.archive_dir = self.runtime_dir / "archive"
        self.index_file = self.runtime_dir / "index.json"
        self._lock = RLock()
        self._latest_seq = 0
        self._ensure()
        self._latest_seq = self._scan_latest_seq()

    @property
    def latest_seq(self) -> int:
        return self._latest_seq

    def append(self, event: dict[str, Any], *, turn_id: str | None = None) -> dict[str, Any]:
        with self._lock:
            self._latest_seq += 1
            payload = _json_safe(dict(event))
            payload["seq"] = self._latest_seq
            payload.setdefault("ts", time.time())
            if turn_id and not payload.get("turn_id"):
                payload["turn_id"] = turn_id
            with self.events_file.open("a", encoding="utf-8") as f:
                f.write(json.dumps(payload, ensure_ascii=False) + "\n")
            self._write_index(self._stats_from_index(self._load_index()))
            return payload

    def replay_after(self, seq: int, *, limit: int | None = None) -> list[dict[str, Any]]:
        out = [event for event in self._iter_events() if int(event.get("seq") or 0) > seq]
        if limit and len(out) > limit:
            return out[-limit:]
        return out

    def recent(self, limit: int) -> list[dict[str, Any]]:
        if limit <= 0:
            return []
        events = list(self._iter_events())
        return events[-limit:]

    def events_for_turns(self, turn_ids: list[str], *, limit: int | None = None) -> list[dict[str, Any]]:
        wanted = {str(item) for item in turn_ids if item}
        if not wanted:
            return []
        out = [
            event
            for event in self._iter_events()
            if str(event.get("turn_id") or "") in wanted
        ]
        if limit and len(out) > limit:
            return out[-limit:]
        return out

    def stats(self, *, active_turn_ids: list[str] | None = None) -> dict[str, Any]:
        with self._lock:
            return self._stats_from_index(
                self._load_index(),
                active_turn_ids=active_turn_ids,
            )

    def compact(self, active_turn_ids: list[str]) -> dict[str, Any]:
        """Archive hot events that no longer belong to active turns."""
        active = {str(item) for item in active_turn_ids if item}
        with self._lock:
            events = list(self._iter_events())
            keep: list[dict[str, Any]] = []
            archive: list[dict[str, Any]] = []
            for event in events:
                turn_id = str(event.get("turn_id") or "")
                if turn_id and turn_id in active:
                    keep.append(event)
                else:
                    archive.append(event)
            if archive:
                self._append_archive(archive)
                self._rewrite_hot(keep)
            index = self._load_index()
            if archive:
                index["lastArchiveAt"] = time.time()
            self._write_index(self._stats_from_index(index, active_turn_ids=list(active)))
            return self.stats(active_turn_ids=list(active))

    def _ensure(self) -> None:
        self.runtime_dir.mkdir(parents=True, exist_ok=True)
        self.archive_dir.mkdir(parents=True, exist_ok=True)
        if not self.events_file.exists():
            self.events_file.write_text("", encoding="utf-8")
        if not self.index_file.exists():
            self._write_index(self._stats_from_index({"version": 1}))

    def _scan_latest_seq(self) -> int:
        index = self._load_index()
        latest = int(index.get("latestSeq") or index.get("latest_seq") or 0)
        for event in self._iter_events():
            latest = max(latest, int(event.get("seq") or 0))
        return latest

    def _iter_events(self):
        try:
            with self.events_file.open("r", encoding="utf-8") as f:
                for line in f:
                    line = line.strip()
                    if not line:
                        continue
                    try:
                        raw = json.loads(line)
                    except json.JSONDecodeError:
                        continue
                    if isinstance(raw, dict) and isinstance(raw.get("event"), str):
                        yield raw
        except OSError:
            return

    def _stats_from_index(
        self,
        index: dict[str, Any],
        *,
        active_turn_ids: list[str] | None = None,
    ) -> dict[str, Any]:
        events = list(self._iter_events())
        active = {str(item) for item in active_turn_ids or [] if item}
        active_events = [
            event for event in events
            if active and str(event.get("turn_id") or "") in active
        ]
        latest_ts = max(
            (self._event_ts_seconds(event) for event in events),
            default=0.0,
        )
        archives = [
            {
                "path": str(path.relative_to(self.root)),
                "bytes": path.stat().st_size,
                "updatedAt": path.stat().st_mtime,
            }
            for path in sorted(self.archive_dir.glob("*.jsonl.gz"))
        ]
        bytes_hot = self.events_file.stat().st_size if self.events_file.exists() else 0
        archive_bytes = sum(int(item["bytes"]) for item in archives)
        return {
            "version": 1,
            "path": str(self.events_file.relative_to(self.root)),
            "bytes": bytes_hot,
            "events": len(events),
            "latestSeq": max(
                self._latest_seq,
                int(index.get("latestSeq") or index.get("latest_seq") or 0),
                max((int(event.get("seq") or 0) for event in events), default=0),
            ),
            "latestTs": latest_ts or None,
            "activeTurnEvents": len(active_events),
            "activeTurns": len(active),
            "archiveFiles": len(archives),
            "archiveBytes": archive_bytes,
            "archives": archives,
            "lastArchiveAt": index.get("lastArchiveAt") or index.get("last_archive_at"),
            "hotLimitEvents": 5000,
            "hotLimitBytes": 5 * 1024 * 1024,
            "needsRotation": bytes_hot > 5 * 1024 * 1024 or len(events) > 5000,
        }

    def _load_index(self) -> dict[str, Any]:
        try:
            raw = json.loads(self.index_file.read_text(encoding="utf-8") or "{}")
        except (json.JSONDecodeError, OSError):
            return {"version": 1, "latestSeq": self._latest_seq}
        return raw if isinstance(raw, dict) else {"version": 1, "latestSeq": self._latest_seq}

    def _write_index(self, index: dict[str, Any]) -> None:
        payload = dict(index)
        payload["version"] = 1
        tmp = self.index_file.with_name(f".{self.index_file.name}.{uuid4().hex}.tmp")
        try:
            tmp.write_text(json.dumps(_json_safe(payload), ensure_ascii=False, indent=2), encoding="utf-8")
            tmp.replace(self.index_file)
        except BaseException:
            tmp.unlink(missing_ok=True)
            raise

    def _append_archive(self, events: list[dict[str, Any]]) -> None:
        grouped: dict[str, list[dict[str, Any]]] = {}
        for event in events:
            grouped.setdefault(self._archive_month(event), []).append(event)
        for month, items in grouped.items():
            path = self.archive_dir / f"{month}.jsonl.gz"
            with gzip.open(path, "at", encoding="utf-8") as f:
                for event in items:
                    f.write(json.dumps(_json_safe(event), ensure_ascii=False) + "\n")

    def _rewrite_hot(self, events: list[dict[str, Any]]) -> None:
        tmp = self.events_file.with_name(f".{self.events_file.name}.{uuid4().hex}.tmp")
        try:
            with tmp.open("w", encoding="utf-8") as f:
                for event in events:
                    f.write(json.dumps(_json_safe(event), ensure_ascii=False) + "\n")
                f.flush()
                with suppress(OSError):
                    os.fsync(f.fileno())
            tmp.replace(self.events_file)
        except BaseException:
            tmp.unlink(missing_ok=True)
            raise

    @staticmethod
    def _event_ts_seconds(event: dict[str, Any]) -> float:
        ts = event.get("ts")
        if isinstance(ts, (int, float)):
            return float(ts)
        if isinstance(ts, str):
            try:
                return datetime.fromisoformat(ts).timestamp()
            except ValueError:
                return 0.0
        return 0.0

    @classmethod
    def _archive_month(cls, event: dict[str, Any]) -> str:
        ts = event.get("ts")
        if isinstance(ts, (int, float)):
            return datetime.fromtimestamp(float(ts)).strftime("%Y-%m")
        if isinstance(ts, str) and len(ts) >= 7 and ts[4:5] == "-":
            return ts[:7]
        return datetime.now().strftime("%Y-%m")


def _json_safe(value: Any) -> Any:
    try:
        json.dumps(value, ensure_ascii=False)
        return value
    except (TypeError, ValueError):
        pass
    if isinstance(value, list):
        return [_json_safe(item) for item in value]
    if isinstance(value, dict):
        return {str(key): _json_safe(item) for key, item in value.items()}
    if hasattr(value, "model_dump"):
        return value.model_dump()
    if hasattr(value, "__dict__"):
        return {
            key: _json_safe(item)
            for key, item in value.__dict__.items()
            if not str(key).startswith("_")
        }
    return str(value)
