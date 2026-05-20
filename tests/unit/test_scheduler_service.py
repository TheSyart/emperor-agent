from __future__ import annotations

import asyncio
from pathlib import Path

import pytest

from agent.scheduler import (
    SchedulerPayload,
    SchedulerSchedule,
    SchedulerService,
    SchedulerStatus,
    SchedulerStore,
    SchedulerStoreCorrupt,
    compute_next_run_ms,
    validate_schedule,
)


class FakeClock:
    def __init__(self, value: int = 1_700_000_000_000):
        self.value = value

    def __call__(self) -> int:
        return self.value

    def advance(self, ms: int) -> None:
        self.value += ms


def make_service(tmp_path: Path, *, clock: FakeClock | None = None, on_job=None) -> SchedulerService:
    clock = clock or FakeClock()
    return SchedulerService(
        SchedulerStore(tmp_path),
        time_func=clock,
        on_job=on_job,
        max_sleep_ms=60_000,
    )


def test_compute_next_run_every() -> None:
    assert compute_next_run_ms(
        SchedulerSchedule(kind="every", every_ms=5_000),
        1_000,
    ) == 6_000


def test_compute_next_run_at_ignores_past() -> None:
    assert compute_next_run_ms(SchedulerSchedule(kind="at", at_ms=900), 1_000) is None
    assert compute_next_run_ms(SchedulerSchedule(kind="at", at_ms=1_200), 1_000) == 1_200


def test_validate_schedule_rejects_bad_timezone() -> None:
    with pytest.raises(ValueError, match="unknown timezone"):
        validate_schedule(SchedulerSchedule(kind="cron", expr="0 9 * * *", tz="Bad/Zone"))


def test_validate_schedule_rejects_bad_cron() -> None:
    with pytest.raises(ValueError, match="invalid cron expression"):
        validate_schedule(SchedulerSchedule(kind="cron", expr="bad cron", tz="UTC"))


def test_add_job_sets_next_run(tmp_path: Path) -> None:
    clock = FakeClock()
    service = make_service(tmp_path, clock=clock)

    job = service.add_job(
        name="ping",
        schedule=SchedulerSchedule(kind="every", every_ms=60_000),
        payload=SchedulerPayload(message="hello"),
    )

    assert job.state.next_run_at_ms == clock.value + 60_000
    assert service.status()["jobs"] == 1
    assert service.status()["enabled"] == 1


def test_manual_run_records_success(tmp_path: Path) -> None:
    clock = FakeClock()
    called: list[str] = []

    async def on_job(job):
        called.append(job.id)
        clock.advance(25)

    service = make_service(tmp_path, clock=clock, on_job=on_job)
    job = service.add_job(
        name="ping",
        schedule=SchedulerSchedule(kind="every", every_ms=60_000),
        payload=SchedulerPayload(message="hello"),
    )

    assert asyncio.run(service.run_job(job.id, force=True))
    loaded = service.get_job(job.id)

    assert called == [job.id]
    assert loaded is not None
    assert loaded.state.last_status == SchedulerStatus.OK.value
    assert loaded.state.run_history[0].duration_ms == 25


def test_job_state_is_persisted_as_running_before_callback(tmp_path: Path) -> None:
    clock = FakeClock()
    observed: list[str | None] = []

    async def on_job(job):
        loaded = service.store.get_job(job.id)
        observed.append(loaded.state.last_status if loaded else None)
        clock.advance(10)

    service = make_service(tmp_path, clock=clock, on_job=on_job)
    job = service.add_job(
        name="persist-running",
        schedule=SchedulerSchedule(kind="every", every_ms=60_000),
        payload=SchedulerPayload(message="hello"),
    )

    assert asyncio.run(service.run_job(job.id, force=True))
    loaded = service.get_job(job.id)

    assert observed == [SchedulerStatus.RUNNING.value]
    assert loaded is not None
    assert loaded.state.last_status == SchedulerStatus.OK.value


def test_start_marks_stale_running_job_as_error(tmp_path: Path) -> None:
    clock = FakeClock()
    service = make_service(tmp_path, clock=clock)
    job = service.add_job(
        name="stale",
        schedule=SchedulerSchedule(kind="every", every_ms=60_000),
        payload=SchedulerPayload(message="hello"),
    )
    job.state.last_run_at_ms = clock.value - 250
    job.state.last_status = SchedulerStatus.RUNNING.value
    service.store.upsert_job(job)
    clock.advance(500)

    asyncio.run(service.start())
    try:
        loaded = service.get_job(job.id)

        assert loaded is not None
        assert loaded.state.last_status == SchedulerStatus.ERROR.value
        assert loaded.state.last_error == "interrupted by scheduler restart"
        assert loaded.state.run_history[-1].status == SchedulerStatus.ERROR.value
    finally:
        service.stop()


def test_manual_run_records_errors(tmp_path: Path) -> None:
    async def fail(_job):
        raise RuntimeError("boom")

    service = make_service(tmp_path, on_job=fail)
    job = service.add_job(
        name="fail",
        schedule=SchedulerSchedule(kind="every", every_ms=60_000),
        payload=SchedulerPayload(message="hello"),
    )

    assert asyncio.run(service.run_job(job.id, force=True))
    loaded = service.get_job(job.id)

    assert loaded is not None
    assert loaded.state.last_status == SchedulerStatus.ERROR.value
    assert loaded.state.last_error == "boom"


def test_manual_run_records_cancellation(tmp_path: Path) -> None:
    events: list[dict] = []

    async def cancel(_job):
        raise asyncio.CancelledError()

    async def sink(event: dict) -> None:
        events.append(event)

    service = make_service(tmp_path, on_job=cancel)
    service.event_sink = sink
    job = service.add_job(
        name="cancel",
        schedule=SchedulerSchedule(kind="every", every_ms=60_000),
        payload=SchedulerPayload(message="hello"),
    )

    assert asyncio.run(service.run_job(job.id, force=True))
    loaded = service.get_job(job.id)

    assert loaded is not None
    assert loaded.state.last_status == SchedulerStatus.CANCELLED.value
    assert loaded.state.last_error == "cancelled"
    assert [event["event"] for event in events] == ["scheduler_run_start", "scheduler_run_cancelled"]


def test_timer_runs_due_job_once_and_reschedules(tmp_path: Path) -> None:
    clock = FakeClock()
    calls: list[str] = []

    async def on_job(job):
        calls.append(job.id)

    service = make_service(tmp_path, clock=clock, on_job=on_job)
    job = service.add_job(
        name="due",
        schedule=SchedulerSchedule(kind="every", every_ms=100),
        payload=SchedulerPayload(message="hello"),
    )
    job.state.next_run_at_ms = clock.value - 1
    service.store.upsert_job(job)

    asyncio.run(service._on_timer())
    asyncio.run(service._on_timer())

    loaded = service.get_job(job.id)
    assert calls == [job.id]
    assert loaded is not None
    assert loaded.state.next_run_at_ms == clock.value + 100


def test_at_job_disables_after_timer_run(tmp_path: Path) -> None:
    clock = FakeClock()
    service = make_service(tmp_path, clock=clock)
    job = service.add_job(
        name="once",
        schedule=SchedulerSchedule(kind="at", at_ms=clock.value + 10),
        payload=SchedulerPayload(message="hello"),
    )
    clock.advance(20)

    asyncio.run(service._on_timer())
    loaded = service.get_job(job.id)

    assert loaded is not None
    assert loaded.enabled is False
    assert loaded.state.next_run_at_ms is None


def test_at_job_delete_after_run(tmp_path: Path) -> None:
    clock = FakeClock()
    service = make_service(tmp_path, clock=clock)
    job = service.add_job(
        name="delete",
        schedule=SchedulerSchedule(kind="at", at_ms=clock.value + 10),
        payload=SchedulerPayload(message="hello"),
        delete_after_run=True,
    )
    clock.advance(20)

    asyncio.run(service._on_timer())

    assert service.get_job(job.id) is None


def test_start_registers_protected_system_jobs(tmp_path: Path) -> None:
    service = make_service(tmp_path)

    asyncio.run(service.start())
    try:
        jobs = service.list_jobs(include_disabled=True)
        system_jobs = [job for job in jobs if job.protected]

        assert {job.id for job in system_jobs} >= {
            "memory-maintenance",
            "runtime-maintenance",
            "team-stale-recovery",
            "token-ledger-maintenance",
            "watchlist-check",
        }
        assert all(job.payload.kind == "system_event" for job in system_jobs)
        assert service.remove_job("memory-maintenance") == "protected"
    finally:
        service.stop()


def test_remove_protected_job_refuses(tmp_path: Path) -> None:
    service = make_service(tmp_path)
    job = service.add_job(
        name="system",
        schedule=SchedulerSchedule(kind="every", every_ms=60_000),
        payload=SchedulerPayload(kind="system_event"),
        protected=True,
    )

    assert service.remove_job(job.id) == "protected"
    assert service.get_job(job.id) is not None


def test_start_refuses_corrupt_store(tmp_path: Path) -> None:
    service = make_service(tmp_path)
    service.store.jobs_file.write_text("{bad", encoding="utf-8")

    with pytest.raises(SchedulerStoreCorrupt):
        asyncio.run(service.start())


def test_run_job_emits_start_and_done_events(tmp_path: Path) -> None:
    events: list[dict] = []

    async def sink(event: dict) -> None:
        events.append(event)

    service = make_service(tmp_path)
    service.event_sink = sink
    job = service.add_job(
        name="events",
        schedule=SchedulerSchedule(kind="every", every_ms=60_000),
        payload=SchedulerPayload(message="hello"),
    )

    assert asyncio.run(service.run_job(job.id, force=True))

    assert [event["event"] for event in events] == ["scheduler_run_start", "scheduler_run_done"]
    assert all(event["job"]["id"] == job.id for event in events)
