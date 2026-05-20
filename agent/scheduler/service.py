from __future__ import annotations

import asyncio
from collections.abc import Awaitable, Callable
from datetime import datetime
from typing import Any, Literal

from loguru import logger

from ..runtime import events as runtime_events
from .models import (
    SchedulerJob,
    SchedulerPayload,
    SchedulerSchedule,
    SchedulerStatus,
    now_ms,
)
from .store import SchedulerStore, SchedulerStoreCorrupt, SchedulerStoreData
from .system_jobs import default_system_jobs


def compute_next_run_ms(schedule: SchedulerSchedule, current_ms: int) -> int | None:
    if schedule.kind == "at":
        return schedule.at_ms if schedule.at_ms and schedule.at_ms > current_ms else None
    if schedule.kind == "every":
        if not schedule.every_ms or schedule.every_ms <= 0:
            return None
        return current_ms + schedule.every_ms
    if schedule.kind == "cron":
        if not schedule.expr:
            return None
        from croniter import croniter
        from zoneinfo import ZoneInfo

        tz = ZoneInfo(schedule.tz) if schedule.tz else datetime.now().astimezone().tzinfo
        base = datetime.fromtimestamp(current_ms / 1000, tz=tz)
        next_dt = croniter(schedule.expr, base).get_next(datetime)
        return int(next_dt.timestamp() * 1000)
    return None


def validate_schedule(schedule: SchedulerSchedule) -> None:
    if schedule.kind == "at":
        if not schedule.at_ms or schedule.at_ms <= 0:
            raise ValueError("at schedule requires at_ms")
        if schedule.tz:
            raise ValueError("tz can only be used with cron schedules")
        return
    if schedule.kind == "every":
        if not schedule.every_ms or schedule.every_ms <= 0:
            raise ValueError("every schedule requires every_ms > 0")
        if schedule.tz:
            raise ValueError("tz can only be used with cron schedules")
        return
    if schedule.kind == "cron":
        if not schedule.expr:
            raise ValueError("cron schedule requires expr")
        from croniter import croniter
        from zoneinfo import ZoneInfo

        if schedule.tz:
            try:
                ZoneInfo(schedule.tz)
            except Exception:
                raise ValueError(f"unknown timezone '{schedule.tz}'") from None
        if not croniter.is_valid(schedule.expr):
            raise ValueError(f"invalid cron expression '{schedule.expr}'")
        return
    raise ValueError(f"unsupported schedule kind: {schedule.kind}")


class SchedulerService:
    def __init__(
        self,
        store: SchedulerStore,
        *,
        on_job: Callable[[SchedulerJob], Awaitable[str | None]] | None = None,
        event_sink: Callable[[dict[str, Any]], Awaitable[None]] | None = None,
        time_func: Callable[[], int] = now_ms,
        max_sleep_ms: int = 300_000,
    ):
        self.store = store
        self.on_job = on_job
        self.event_sink = event_sink
        self.time_func = time_func
        self.max_sleep_ms = max(1, int(max_sleep_ms))
        self._running = False
        self._timer_task: asyncio.Task | None = None
        self._timer_active = False

    async def _emit(self, event: dict[str, Any]) -> None:
        if self.event_sink:
            await self.event_sink(event)

    async def start(self) -> None:
        if self._running:
            return
        data = self.store.load(allow_last_good=False)
        self._register_system_jobs(data)
        self._mark_stale_running(data)
        self._running = True
        self._recompute_next_runs(data)
        self.store.save(data)
        self._arm_timer()
        logger.info("Scheduler service started with {} jobs", len(data.jobs))

    def stop(self) -> None:
        self._running = False
        if self._timer_task:
            self._timer_task.cancel()
            self._timer_task = None

    def list_jobs(self, *, include_disabled: bool = True) -> list[SchedulerJob]:
        return self.store.list_jobs(include_disabled=include_disabled)

    def get_job(self, job_id: str) -> SchedulerJob | None:
        return self.store.get_job(job_id)

    def status(self) -> dict[str, Any]:
        jobs = self.store.list_jobs(include_disabled=True)
        enabled = [job for job in jobs if job.enabled]
        errors = [job for job in jobs if job.state.last_status == SchedulerStatus.ERROR.value]
        return {
            "running": self._running,
            "jobs": len(jobs),
            "enabled": len(enabled),
            "nextRunAtMs": self._next_wake_ms(jobs),
            "lastError": errors[-1].state.last_error if errors else None,
        }

    def add_job(
        self,
        *,
        name: str,
        schedule: SchedulerSchedule,
        payload: SchedulerPayload,
        delete_after_run: bool = False,
        protected: bool = False,
        purpose: str | None = None,
    ) -> SchedulerJob:
        validate_schedule(schedule)
        current = self.time_func()
        job = SchedulerJob.create(
            name=name,
            schedule=schedule,
            payload=payload,
            delete_after_run=delete_after_run,
            protected=protected,
            purpose=purpose,
            now=current,
        )
        job.state.next_run_at_ms = compute_next_run_ms(schedule, current)
        self.store.upsert_job(job)
        self._arm_timer()
        return job

    def update_job(
        self,
        job_id: str,
        *,
        name: str | None = None,
        schedule: SchedulerSchedule | None = None,
        payload: SchedulerPayload | None = None,
        delete_after_run: bool | None = None,
    ) -> SchedulerJob | Literal["not_found", "protected"]:
        job = self.store.get_job(job_id)
        if job is None:
            return "not_found"
        if job.protected:
            return "protected"
        if schedule is not None:
            validate_schedule(schedule)
            job.schedule = schedule
            job.state.next_run_at_ms = compute_next_run_ms(schedule, self.time_func())
        if payload is not None:
            job.payload = payload
        if name is not None:
            job.name = str(name or "").strip() or job.name
        if delete_after_run is not None:
            job.delete_after_run = bool(delete_after_run)
        job.updated_at_ms = self.time_func()
        self.store.upsert_job(job)
        self._arm_timer()
        return job

    def enable_job(self, job_id: str, enabled: bool = True) -> SchedulerJob | Literal["not_found"]:
        job = self.store.get_job(job_id)
        if job is None:
            return "not_found"
        job.enabled = bool(enabled)
        job.updated_at_ms = self.time_func()
        job.state.next_run_at_ms = (
            compute_next_run_ms(job.schedule, self.time_func()) if job.enabled else None
        )
        self.store.upsert_job(job)
        self._arm_timer()
        return job

    def remove_job(self, job_id: str) -> SchedulerJob | Literal["not_found", "protected"]:
        job = self.store.get_job(job_id)
        if job is None:
            return "not_found"
        if job.protected:
            return "protected"
        removed = self.store.remove_job(job_id)
        self._arm_timer()
        return removed or "not_found"

    async def run_job(self, job_id: str, *, force: bool = False) -> bool:
        job = self.store.get_job(job_id)
        if job is None:
            return False
        if not force and not job.enabled:
            return False
        data = self.store.load()
        live = next((item for item in data.jobs if item.id == job.id), None)
        if live is None:
            return False
        await self._execute_job(live, data, manual=True)
        self.store.save(data)
        if self._running:
            self._arm_timer()
        return True

    def _recompute_next_runs(self, data: SchedulerStoreData) -> None:
        current = self.time_func()
        for job in data.jobs:
            if job.enabled:
                job.state.next_run_at_ms = compute_next_run_ms(job.schedule, current)
            else:
                job.state.next_run_at_ms = None

    def _register_system_jobs(self, data: SchedulerStoreData) -> None:
        current = self.time_func()
        existing = {job.id: job for job in data.jobs}
        for default in default_system_jobs(now=current):
            found = existing.get(default.id)
            if found is None:
                default.state.next_run_at_ms = compute_next_run_ms(default.schedule, current)
                data.jobs.append(default)
                continue
            found.name = default.name
            found.schedule = default.schedule
            found.payload = default.payload
            found.protected = True
            found.purpose = default.purpose
            found.delete_after_run = False
            found.updated_at_ms = current
            if found.enabled:
                found.state.next_run_at_ms = compute_next_run_ms(found.schedule, current)

    def _next_wake_ms(self, jobs: list[SchedulerJob] | None = None) -> int | None:
        jobs = jobs if jobs is not None else self.store.list_jobs(include_disabled=True)
        times = [
            job.state.next_run_at_ms for job in jobs
            if job.enabled and job.state.next_run_at_ms
        ]
        return min(times) if times else None

    def _arm_timer(self) -> None:
        if not self._running:
            return
        if self._timer_task:
            self._timer_task.cancel()
        next_wake = self._next_wake_ms()
        delay_ms = self.max_sleep_ms if next_wake is None else min(
            self.max_sleep_ms,
            max(0, next_wake - self.time_func()),
        )

        async def tick() -> None:
            try:
                await asyncio.sleep(delay_ms / 1000)
                if self._running:
                    await self._on_timer()
            except asyncio.CancelledError:
                pass

        self._timer_task = asyncio.create_task(tick())

    async def _on_timer(self) -> None:
        try:
            data = self.store.load()
        except SchedulerStoreCorrupt:
            logger.warning("Scheduler store corrupt during timer tick; keeping service alive")
            self._arm_timer()
            return
        self._timer_active = True
        try:
            current = self.time_func()
            due = [
                job for job in data.jobs
                if job.enabled and job.state.next_run_at_ms and current >= job.state.next_run_at_ms
            ]
            for job in due:
                await self._execute_job(job, data)
        finally:
            self._timer_active = False
        self._arm_timer()

    async def _execute_job(
        self,
        job: SchedulerJob,
        data: SchedulerStoreData,
        *,
        manual: bool = False,
    ) -> None:
        start = self.time_func()
        error: str | None = None
        status = SchedulerStatus.OK.value
        job.state.last_run_at_ms = start
        job.state.last_status = SchedulerStatus.RUNNING.value
        job.state.last_error = None
        job.state.next_run_at_ms = None
        job.updated_at_ms = start
        self.store.save(data)
        await self._emit(runtime_events.scheduler_run_start(job.to_dict()))
        try:
            if self.on_job:
                await self.on_job(job)
        except asyncio.CancelledError:
            status = SchedulerStatus.CANCELLED.value
            error = "cancelled"
            logger.info("Scheduler: job '{}' cancelled", job.name)
        except Exception as exc:
            status = SchedulerStatus.ERROR.value
            error = str(exc)
            logger.error("Scheduler: job '{}' failed: {}", job.name, exc)

        end = self.time_func()
        job.state.record_run(
            run_at_ms=start,
            status=status,
            duration_ms=max(0, end - start),
            error=error,
        )
        job.updated_at_ms = end

        if job.schedule.kind == "at" and not manual:
            if job.delete_after_run:
                data.jobs = [item for item in data.jobs if item.id != job.id]
            else:
                job.enabled = False
                job.state.next_run_at_ms = None
        elif job.enabled:
            job.state.next_run_at_ms = compute_next_run_ms(job.schedule, self.time_func())
        else:
            job.state.next_run_at_ms = None
        if status == SchedulerStatus.ERROR.value:
            await self._emit(
                runtime_events.scheduler_run_error(job.to_dict(), error=error or "unknown error")
            )
        elif status == SchedulerStatus.CANCELLED.value:
            await self._emit(
                runtime_events.scheduler_run_cancelled(job.to_dict(), reason=error or "cancelled")
            )
        else:
            await self._emit(runtime_events.scheduler_run_done(job.to_dict()))
        self.store.save(data)

    def _mark_stale_running(self, data: SchedulerStoreData) -> None:
        current = self.time_func()
        for job in data.jobs:
            if job.state.last_status != SchedulerStatus.RUNNING.value:
                continue
            started = job.state.last_run_at_ms or current
            error = "interrupted by scheduler restart"
            job.state.record_run(
                run_at_ms=started,
                status=SchedulerStatus.ERROR.value,
                duration_ms=max(0, current - started),
                error=error,
            )
            job.updated_at_ms = current
