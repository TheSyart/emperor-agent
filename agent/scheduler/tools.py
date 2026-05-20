from __future__ import annotations

import asyncio
from contextvars import ContextVar
from datetime import datetime, timezone

from ..providers.base import run_sync
from ..tools.base import Tool
from .models import SchedulerPayload, SchedulerSchedule
from .service import SchedulerService

_IN_SCHEDULER_RUN: ContextVar[bool] = ContextVar("in_scheduler_run", default=False)


def in_scheduler_run() -> bool:
    return _IN_SCHEDULER_RUN.get()


def set_scheduler_run(value: bool):
    return _IN_SCHEDULER_RUN.set(bool(value))


def reset_scheduler_run(token) -> None:
    _IN_SCHEDULER_RUN.reset(token)


class SchedulerTool(Tool):
    """Manage local durable scheduler jobs through the shared scheduler service."""

    requires_runtime_context = True

    def __init__(self, service: SchedulerService):
        self.service = service

    @property
    def name(self) -> str:
        return "scheduler"

    @property
    def description(self) -> str:
        return (
            "Create, inspect, update, pause, resume, remove, or manually run local scheduled jobs. "
            "Use list for read-only inspection. Use add/update/remove/run only when the user has clearly asked "
            "for a durable future task. If this tool fails, report the Scheduler error instead of falling back "
            "to OS-level cron or crontab."
        )

    @property
    def parameters(self) -> dict:
        return {
            "type": "object",
            "properties": {
                "action": {
                    "type": "string",
                    "enum": ["add", "list", "update", "remove", "pause", "resume", "run"],
                    "description": "Scheduler action to perform.",
                },
                "job_id": {
                    "type": "string",
                    "description": "Existing scheduler job id for update/remove/pause/resume/run.",
                },
                "name": {
                    "type": "string",
                    "description": "Human-readable job name for add/update.",
                },
                "payload_kind": {
                    "type": "string",
                    "enum": ["agent_turn", "team_wake"],
                    "description": "What the scheduler should do when the job runs. system_event is internal only.",
                },
                "message": {
                    "type": "string",
                    "description": "Prompt/message for agent_turn, or message sent to a teammate for team_wake.",
                },
                "target": {
                    "type": "string",
                    "description": "Teammate name for team_wake jobs.",
                },
                "deliver": {
                    "type": "boolean",
                    "description": "Whether resulting output should be visible in the local runtime UI.",
                },
                "at": {
                    "type": "string",
                    "description": "ISO datetime for a one-time job, for example 2026-05-20T09:30:00+08:00.",
                },
                "every_seconds": {
                    "type": "integer",
                    "minimum": 1,
                    "description": "Interval in seconds for a recurring job.",
                },
                "cron_expr": {
                    "type": "string",
                    "description": "Cron expression for a recurring job.",
                },
                "tz": {
                    "type": "string",
                    "description": "IANA timezone for cron schedules, for example Asia/Shanghai.",
                },
                "delete_after_run": {
                    "type": "boolean",
                    "description": "Delete a one-time job after it runs.",
                },
            },
            "required": ["action"],
            "additionalProperties": False,
        }

    def execute(
        self,
        *,
        action: str,
        job_id: str | None = None,
        name: str | None = None,
        payload_kind: str | None = None,
        message: str | None = None,
        target: str | None = None,
        deliver: bool | None = None,
        at: str | None = None,
        every_seconds: int | None = None,
        cron_expr: str | None = None,
        tz: str | None = None,
        delete_after_run: bool | None = None,
        emit=None,
        loop=None,
        parent_call_id=None,
    ) -> str:
        del emit, parent_call_id
        action = (action or "").strip().lower()
        if action == "list":
            return self._format_jobs()
        if action == "add":
            if in_scheduler_run():
                return "Error: scheduler jobs cannot create new scheduler jobs while running."
            return self._add_job(
                name=name,
                payload_kind=payload_kind,
                message=message,
                target=target,
                deliver=deliver,
                at=at,
                every_seconds=every_seconds,
                cron_expr=cron_expr,
                tz=tz,
                delete_after_run=delete_after_run,
            )
        if action == "update":
            if not job_id:
                return "Error: action=update requires job_id."
            return self._update_job(
                job_id=job_id,
                name=name,
                payload_kind=payload_kind,
                message=message,
                target=target,
                deliver=deliver,
                at=at,
                every_seconds=every_seconds,
                cron_expr=cron_expr,
                tz=tz,
                delete_after_run=delete_after_run,
            )
        if action in {"remove", "pause", "resume", "run"}:
            if not job_id:
                return f"Error: action={action} requires job_id."
            if action == "remove":
                return self._remove_job(job_id)
            if action == "pause":
                return self._enable_job(job_id, enabled=False)
            if action == "resume":
                return self._enable_job(job_id, enabled=True)
            return self._run_job(job_id, loop=loop)
        return f"Error: unsupported scheduler action '{action}'."

    def _add_job(
        self,
        *,
        name: str | None,
        payload_kind: str | None,
        message: str | None,
        target: str | None,
        deliver: bool | None,
        at: str | None,
        every_seconds: int | None,
        cron_expr: str | None,
        tz: str | None,
        delete_after_run: bool | None,
    ) -> str:
        try:
            schedule = self._schedule_from_fields(at=at, every_seconds=every_seconds, cron_expr=cron_expr, tz=tz)
            payload = self._payload_from_fields(payload_kind=payload_kind, message=message, target=target, deliver=deliver)
            job = self.service.add_job(
                name=name or self._default_name(payload),
                schedule=schedule,
                payload=payload,
                delete_after_run=bool(delete_after_run),
            )
        except ValueError as exc:
            return f"Error: {exc}"
        return f"Scheduler job created: {job.name} ({job.id}). Next run: {_format_ms(job.state.next_run_at_ms)}."

    def _update_job(
        self,
        *,
        job_id: str,
        name: str | None,
        payload_kind: str | None,
        message: str | None,
        target: str | None,
        deliver: bool | None,
        at: str | None,
        every_seconds: int | None,
        cron_expr: str | None,
        tz: str | None,
        delete_after_run: bool | None,
    ) -> str:
        try:
            schedule = None
            if at or every_seconds is not None or cron_expr:
                schedule = self._schedule_from_fields(at=at, every_seconds=every_seconds, cron_expr=cron_expr, tz=tz)
            payload = None
            if payload_kind or message is not None or target is not None:
                current = self.service.get_job(job_id)
                if current is None:
                    return f"Error: scheduler job not found: {job_id}"
                payload = self._payload_from_fields(
                    payload_kind=payload_kind or current.payload.kind,
                    message=message if message is not None else current.payload.message,
                    target=target if target is not None else current.payload.target,
                    deliver=deliver if deliver is not None else current.payload.deliver,
                )
            result = self.service.update_job(
                job_id,
                name=name,
                schedule=schedule,
                payload=payload,
                delete_after_run=delete_after_run,
            )
        except ValueError as exc:
            return f"Error: {exc}"
        if result == "not_found":
            return f"Error: scheduler job not found: {job_id}"
        if result == "protected":
            return f"Error: scheduler job is protected and cannot be updated: {job_id}"
        return f"Scheduler job updated: {result.name} ({result.id}). Next run: {_format_ms(result.state.next_run_at_ms)}."

    def _remove_job(self, job_id: str) -> str:
        result = self.service.remove_job(job_id)
        if result == "not_found":
            return f"Error: scheduler job not found: {job_id}"
        if result == "protected":
            return f"Error: scheduler job is protected and cannot be removed: {job_id}"
        return f"Scheduler job removed: {result.name} ({result.id})."

    def _enable_job(self, job_id: str, *, enabled: bool) -> str:
        result = self.service.enable_job(job_id, enabled=enabled)
        if result == "not_found":
            return f"Error: scheduler job not found: {job_id}"
        state = "resumed" if enabled else "paused"
        return f"Scheduler job {state}: {result.name} ({result.id}). Next run: {_format_ms(result.state.next_run_at_ms)}."

    def _run_job(self, job_id: str, *, loop=None) -> str:
        try:
            ok = _run_coroutine(self.service.run_job(job_id, force=True), loop=loop)
        except Exception as exc:
            return f"Error: failed to run scheduler job {job_id}: {exc}"
        if not ok:
            return f"Error: scheduler job not found or disabled: {job_id}"
        job = self.service.get_job(job_id)
        label = f"{job.name} ({job.id})" if job else job_id
        return f"Scheduler job run finished: {label}."

    def _format_jobs(self) -> str:
        jobs = self.service.list_jobs(include_disabled=True)
        if not jobs:
            return "No scheduler jobs configured."
        lines = ["Scheduler jobs:"]
        for job in jobs:
            status = "enabled" if job.enabled else "paused"
            if job.protected:
                status += ", protected"
            lines.append(
                "- "
                f"{job.id} · {job.name} · {status} · {job.schedule.kind} · "
                f"next={_format_ms(job.state.next_run_at_ms)} · "
                f"last={job.state.last_status or '-'}"
            )
            if job.payload.kind == "team_wake":
                lines.append(f"  payload: team_wake target={job.payload.target or '-'} message={_trim(job.payload.message)}")
            else:
                lines.append(f"  payload: {job.payload.kind} message={_trim(job.payload.message)}")
            if job.state.last_error:
                lines.append(f"  last_error: {_trim(job.state.last_error)}")
        return "\n".join(lines)

    @staticmethod
    def _schedule_from_fields(
        *,
        at: str | None,
        every_seconds: int | None,
        cron_expr: str | None,
        tz: str | None,
    ) -> SchedulerSchedule:
        filled = [bool(at), every_seconds is not None, bool(cron_expr)]
        if sum(1 for item in filled if item) != 1:
            raise ValueError("provide exactly one schedule: at, every_seconds, or cron_expr.")
        if at:
            return SchedulerSchedule(kind="at", at_ms=_parse_datetime_ms(at))
        if every_seconds is not None:
            if every_seconds <= 0:
                raise ValueError("every_seconds must be greater than 0.")
            return SchedulerSchedule(kind="every", every_ms=int(every_seconds) * 1000)
        return SchedulerSchedule(kind="cron", expr=str(cron_expr or "").strip(), tz=tz or None)

    @staticmethod
    def _payload_from_fields(
        *,
        payload_kind: str | None,
        message: str | None,
        target: str | None,
        deliver: bool | None,
    ) -> SchedulerPayload:
        kind = str(payload_kind or "agent_turn").strip()
        if kind == "system_event":
            raise ValueError("system_event jobs are internal and cannot be created from the scheduler tool.")
        if kind not in {"agent_turn", "team_wake"}:
            raise ValueError("payload_kind must be agent_turn or team_wake.")
        body = str(message or "").strip()
        if not body:
            raise ValueError("message is required.")
        if kind == "team_wake" and not str(target or "").strip():
            raise ValueError("target teammate is required for team_wake jobs.")
        return SchedulerPayload(
            kind=kind,
            message=body,
            target=str(target or "").strip() or None,
            deliver=True if deliver is None else bool(deliver),
        )

    @staticmethod
    def _default_name(payload: SchedulerPayload) -> str:
        prefix = "Team wake" if payload.kind == "team_wake" else "Agent turn"
        return f"{prefix}: {_trim(payload.message, limit=48)}"


def _parse_datetime_ms(value: str) -> int:
    raw = str(value or "").strip()
    if not raw:
        raise ValueError("at requires an ISO datetime.")
    if raw.endswith("Z"):
        raw = raw[:-1] + "+00:00"
    try:
        dt = datetime.fromisoformat(raw)
    except ValueError:
        raise ValueError("at must be an ISO datetime, for example 2026-05-20T09:30:00+08:00.") from None
    if dt.tzinfo is None:
        dt = dt.replace(tzinfo=timezone.utc)
    return int(dt.timestamp() * 1000)


def _run_coroutine(coro, *, loop=None):
    if loop is not None:
        return asyncio.run_coroutine_threadsafe(coro, loop).result()
    return run_sync(coro)


def _format_ms(value: int | None) -> str:
    if not value:
        return "-"
    return datetime.fromtimestamp(value / 1000, tz=timezone.utc).isoformat()


def _trim(value: str, *, limit: int = 120) -> str:
    text = " ".join(str(value or "").split())
    return text if len(text) <= limit else text[: limit - 1] + "…"
