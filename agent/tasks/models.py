from __future__ import annotations

from dataclasses import asdict, dataclass, field
from enum import StrEnum
from typing import Any


class TaskKind(StrEnum):
    TURN = "turn"
    SUBAGENT = "subagent"
    TEAM_WAKE = "team_wake"
    SCHEDULER_RUN = "scheduler_run"
    WATCHLIST = "watchlist"
    SHELL = "shell"


class TaskStatus(StrEnum):
    PENDING = "pending"
    RUNNING = "running"
    COMPLETED = "completed"
    FAILED = "failed"
    CANCELLED = "cancelled"


@dataclass(frozen=True)
class TaskRecord:
    id: str
    kind: str
    status: str
    title: str
    source: str
    started_at: float
    turn_id: str | None = None
    tool_call_id: str | None = None
    job_id: str | None = None
    ended_at: float | None = None
    output_path: str | None = None
    transcript_path: str | None = None
    progress: dict[str, Any] = field(default_factory=dict)
    metadata: dict[str, Any] = field(default_factory=dict)

    def to_dict(self) -> dict[str, Any]:
        return asdict(self)

    @classmethod
    def from_dict(cls, payload: dict[str, Any]) -> TaskRecord:
        return cls(
            id=str(payload["id"]),
            kind=str(payload["kind"]),
            status=str(payload["status"]),
            title=str(payload["title"]),
            source=str(payload["source"]),
            started_at=float(payload["started_at"]),
            turn_id=payload.get("turn_id"),
            tool_call_id=payload.get("tool_call_id"),
            job_id=payload.get("job_id"),
            ended_at=payload.get("ended_at"),
            output_path=payload.get("output_path"),
            transcript_path=payload.get("transcript_path"),
            progress=dict(payload.get("progress") or {}),
            metadata=dict(payload.get("metadata") or {}),
        )
