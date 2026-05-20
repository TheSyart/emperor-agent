from __future__ import annotations

import re
import time
import uuid
from dataclasses import dataclass, field
from enum import StrEnum
from typing import Any, Literal


SCHEMA_VERSION = 1
_JOB_ID_RE = re.compile(r"^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,63}$")
_MAX_RUN_HISTORY = 20


class SchedulerStatus(StrEnum):
    RUNNING = "running"
    OK = "ok"
    ERROR = "error"
    SKIPPED = "skipped"
    CANCELLED = "cancelled"


def now_ms() -> int:
    return int(time.time() * 1000)


def new_job_id() -> str:
    return uuid.uuid4().hex[:12]


def validate_job_id(job_id: str) -> str:
    safe = str(job_id or "").strip()
    if not _JOB_ID_RE.match(safe):
        raise ValueError("job id must match [a-zA-Z0-9][a-zA-Z0-9_.-]{0,63}")
    return safe


def _int_or_none(value: Any) -> int | None:
    if value is None or value == "":
        return None
    try:
        return int(value)
    except (TypeError, ValueError):
        return None


def _str_or_none(value: Any) -> str | None:
    if value is None:
        return None
    text = str(value)
    return text if text else None


@dataclass
class SchedulerSchedule:
    kind: Literal["at", "every", "cron"]
    at_ms: int | None = None
    every_ms: int | None = None
    expr: str | None = None
    tz: str | None = None

    @classmethod
    def from_dict(cls, raw: dict[str, Any]) -> "SchedulerSchedule":
        kind = str(raw.get("kind") or "every")
        if kind not in {"at", "every", "cron"}:
            raise ValueError(f"unsupported schedule kind: {kind}")
        return cls(
            kind=kind,  # type: ignore[arg-type]
            at_ms=_int_or_none(raw.get("at_ms", raw.get("atMs"))),
            every_ms=_int_or_none(raw.get("every_ms", raw.get("everyMs"))),
            expr=_str_or_none(raw.get("expr")),
            tz=_str_or_none(raw.get("tz")),
        )

    def to_dict(self) -> dict[str, Any]:
        return {
            "kind": self.kind,
            "atMs": self.at_ms,
            "everyMs": self.every_ms,
            "expr": self.expr,
            "tz": self.tz,
        }


@dataclass
class SchedulerPayload:
    kind: Literal["agent_turn", "team_wake", "system_event"] = "agent_turn"
    message: str = ""
    target: str | None = None
    deliver: bool = True
    meta: dict[str, Any] = field(default_factory=dict)

    @classmethod
    def from_dict(cls, raw: dict[str, Any]) -> "SchedulerPayload":
        kind = str(raw.get("kind") or "agent_turn")
        if kind not in {"agent_turn", "team_wake", "system_event"}:
            kind = "agent_turn"
        meta = raw.get("meta") if isinstance(raw.get("meta"), dict) else {}
        return cls(
            kind=kind,  # type: ignore[arg-type]
            message=str(raw.get("message") or ""),
            target=_str_or_none(raw.get("target")),
            deliver=bool(raw.get("deliver", True)),
            meta=meta,
        )

    def to_dict(self) -> dict[str, Any]:
        return {
            "kind": self.kind,
            "message": self.message,
            "target": self.target,
            "deliver": self.deliver,
            "meta": self.meta,
        }


@dataclass
class SchedulerRunRecord:
    run_at_ms: int
    status: str
    duration_ms: int = 0
    error: str | None = None

    @classmethod
    def from_dict(cls, raw: dict[str, Any]) -> "SchedulerRunRecord":
        status = str(raw.get("status") or SchedulerStatus.SKIPPED.value)
        if status not in {item.value for item in SchedulerStatus}:
            status = SchedulerStatus.SKIPPED.value
        return cls(
            run_at_ms=int(raw.get("run_at_ms") or raw.get("runAtMs") or 0),
            status=status,
            duration_ms=int(raw.get("duration_ms") or raw.get("durationMs") or 0),
            error=_str_or_none(raw.get("error")),
        )

    def to_dict(self) -> dict[str, Any]:
        return {
            "runAtMs": self.run_at_ms,
            "status": self.status,
            "durationMs": self.duration_ms,
            "error": self.error,
        }


@dataclass
class SchedulerJobState:
    next_run_at_ms: int | None = None
    last_run_at_ms: int | None = None
    last_status: str | None = None
    last_error: str | None = None
    run_history: list[SchedulerRunRecord] = field(default_factory=list)

    @classmethod
    def from_dict(cls, raw: dict[str, Any]) -> "SchedulerJobState":
        history = []
        for item in raw.get("run_history") or raw.get("runHistory") or []:
            if isinstance(item, dict):
                history.append(SchedulerRunRecord.from_dict(item))
        last_status = _str_or_none(raw.get("last_status", raw.get("lastStatus")))
        if last_status and last_status not in {item.value for item in SchedulerStatus}:
            last_status = None
        return cls(
            next_run_at_ms=_int_or_none(raw.get("next_run_at_ms", raw.get("nextRunAtMs"))),
            last_run_at_ms=_int_or_none(raw.get("last_run_at_ms", raw.get("lastRunAtMs"))),
            last_status=last_status,
            last_error=_str_or_none(raw.get("last_error", raw.get("lastError"))),
            run_history=history[-_MAX_RUN_HISTORY:],
        )

    def to_dict(self) -> dict[str, Any]:
        return {
            "nextRunAtMs": self.next_run_at_ms,
            "lastRunAtMs": self.last_run_at_ms,
            "lastStatus": self.last_status,
            "lastError": self.last_error,
            "runHistory": [item.to_dict() for item in self.run_history[-_MAX_RUN_HISTORY:]],
        }

    def record_run(
        self,
        *,
        run_at_ms: int,
        status: str,
        duration_ms: int = 0,
        error: str | None = None,
    ) -> None:
        if status not in {item.value for item in SchedulerStatus}:
            status = SchedulerStatus.SKIPPED.value
        self.last_run_at_ms = int(run_at_ms)
        self.last_status = status
        self.last_error = error
        self.run_history.append(SchedulerRunRecord(
            run_at_ms=int(run_at_ms),
            status=status,
            duration_ms=max(0, int(duration_ms)),
            error=error,
        ))
        self.run_history = self.run_history[-_MAX_RUN_HISTORY:]


@dataclass
class SchedulerJob:
    id: str
    name: str
    enabled: bool = True
    schedule: SchedulerSchedule = field(default_factory=lambda: SchedulerSchedule(kind="every"))
    payload: SchedulerPayload = field(default_factory=SchedulerPayload)
    state: SchedulerJobState = field(default_factory=SchedulerJobState)
    created_at_ms: int = field(default_factory=now_ms)
    updated_at_ms: int = field(default_factory=now_ms)
    delete_after_run: bool = False
    protected: bool = False
    purpose: str | None = None

    @classmethod
    def create(
        cls,
        *,
        name: str,
        schedule: SchedulerSchedule,
        payload: SchedulerPayload,
        job_id: str | None = None,
        delete_after_run: bool = False,
        protected: bool = False,
        purpose: str | None = None,
        now: int | None = None,
    ) -> "SchedulerJob":
        stamp = int(now or now_ms())
        return cls(
            id=validate_job_id(job_id or new_job_id()),
            name=str(name or "scheduled-job").strip() or "scheduled-job",
            enabled=True,
            schedule=schedule,
            payload=payload,
            state=SchedulerJobState(),
            created_at_ms=stamp,
            updated_at_ms=stamp,
            delete_after_run=delete_after_run,
            protected=protected,
            purpose=purpose,
        )

    @classmethod
    def from_dict(cls, raw: dict[str, Any]) -> "SchedulerJob":
        return cls(
            id=validate_job_id(str(raw.get("id") or "")),
            name=str(raw.get("name") or ""),
            enabled=bool(raw.get("enabled", True)),
            schedule=SchedulerSchedule.from_dict(raw.get("schedule") or {}),
            payload=SchedulerPayload.from_dict(raw.get("payload") or {}),
            state=SchedulerJobState.from_dict(raw.get("state") or {}),
            created_at_ms=int(raw.get("created_at_ms") or raw.get("createdAtMs") or now_ms()),
            updated_at_ms=int(raw.get("updated_at_ms") or raw.get("updatedAtMs") or now_ms()),
            delete_after_run=bool(raw.get("delete_after_run", raw.get("deleteAfterRun", False))),
            protected=bool(raw.get("protected", False)),
            purpose=_str_or_none(raw.get("purpose")),
        )

    def to_dict(self) -> dict[str, Any]:
        return {
            "id": self.id,
            "name": self.name,
            "enabled": self.enabled,
            "schedule": self.schedule.to_dict(),
            "payload": self.payload.to_dict(),
            "state": self.state.to_dict(),
            "createdAtMs": self.created_at_ms,
            "updatedAtMs": self.updated_at_ms,
            "deleteAfterRun": self.delete_after_run,
            "protected": self.protected,
            "purpose": self.purpose,
        }

    def touch(self, *, now: int | None = None) -> "SchedulerJob":
        data = self.to_dict()
        data["updatedAtMs"] = int(now or now_ms())
        return SchedulerJob.from_dict(data)
