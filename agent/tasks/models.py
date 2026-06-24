from __future__ import annotations

from dataclasses import asdict, dataclass, field
from enum import StrEnum
from typing import Any


class TaskKind(StrEnum):
    TURN = "turn"
    PLAN_STEP = "plan_step"
    SUBAGENT = "subagent"
    TEAM_WAKE = "team_wake"
    SCHEDULER_RUN = "scheduler_run"
    WATCHLIST = "watchlist"
    SHELL = "shell"


class TaskStatus(StrEnum):
    QUEUED = "queued"
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

    def to_runtime_dict(self) -> dict[str, Any]:
        return {
            "id": self.id,
            "kind": self.kind,
            "status": self.status,
            "title": self.title,
            "source": self.source,
            "startedAt": self.started_at,
            "turnId": self.turn_id,
            "toolCallId": self.tool_call_id,
            "jobId": self.job_id,
            "endedAt": self.ended_at,
            "outputPath": self.output_path,
            "transcriptPath": self.transcript_path,
            "progress": dict(self.progress),
            "metadata": dict(self.metadata),
        }

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
