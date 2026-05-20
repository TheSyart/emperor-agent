from __future__ import annotations

import asyncio
from pathlib import Path

from agent.scheduler import (
    SchedulerService,
    SchedulerStore,
    SchedulerTool,
    reset_scheduler_run,
    set_scheduler_run,
)


def make_tool(tmp_path: Path, *, on_job=None) -> SchedulerTool:
    service = SchedulerService(SchedulerStore(tmp_path), on_job=on_job)
    return SchedulerTool(service)


def test_scheduler_tool_add_list_pause_resume_remove(tmp_path: Path) -> None:
    tool = make_tool(tmp_path)

    created = tool.execute(
        action="add",
        name="daily summary",
        payload_kind="agent_turn",
        message="Summarize today",
        every_seconds=60,
    )
    assert "Scheduler job created" in created
    job = tool.service.list_jobs()[0]

    listed = tool.execute(action="list")
    assert job.id in listed
    assert "daily summary" in listed

    paused = tool.execute(action="pause", job_id=job.id)
    assert "paused" in paused
    assert not tool.service.get_job(job.id).enabled

    resumed = tool.execute(action="resume", job_id=job.id)
    assert "resumed" in resumed
    assert tool.service.get_job(job.id).enabled

    removed = tool.execute(action="remove", job_id=job.id)
    assert "removed" in removed
    assert tool.service.list_jobs() == []


def test_scheduler_tool_run_records_history(tmp_path: Path) -> None:
    ran: list[str] = []

    async def on_job(job):
        ran.append(job.id)

    tool = make_tool(tmp_path, on_job=on_job)
    tool.execute(
        action="add",
        name="manual run",
        payload_kind="agent_turn",
        message="Run once",
        every_seconds=60,
    )
    job = tool.service.list_jobs()[0]

    result = tool.execute(action="run", job_id=job.id)

    assert "run finished" in result
    assert ran == [job.id]
    assert tool.service.get_job(job.id).state.run_history[-1].status == "ok"


def test_scheduler_tool_rejects_internal_system_event(tmp_path: Path) -> None:
    tool = make_tool(tmp_path)

    result = tool.execute(
        action="add",
        name="internal",
        payload_kind="system_event",
        message="Do maintenance",
        every_seconds=60,
    )

    assert result.startswith("Error:")
    assert "system_event" in result


def test_scheduler_tool_rejects_recursive_creation(tmp_path: Path) -> None:
    tool = make_tool(tmp_path)
    token = set_scheduler_run(True)
    try:
        result = tool.execute(
            action="add",
            name="recursive",
            payload_kind="agent_turn",
            message="Create another job",
            every_seconds=60,
        )
    finally:
        reset_scheduler_run(token)

    assert result.startswith("Error:")
    assert "cannot create" in result


def test_scheduler_tool_requires_clear_schedule_and_payload(tmp_path: Path) -> None:
    tool = make_tool(tmp_path)

    no_schedule = tool.execute(
        action="add",
        payload_kind="agent_turn",
        message="Missing schedule",
    )
    no_message = tool.execute(
        action="add",
        payload_kind="agent_turn",
        every_seconds=60,
    )

    assert "provide exactly one schedule" in no_schedule
    assert "message is required" in no_message


def test_scheduler_tool_requires_team_target(tmp_path: Path) -> None:
    tool = make_tool(tmp_path)

    result = tool.execute(
        action="add",
        payload_kind="team_wake",
        message="Check inbox",
        every_seconds=60,
    )

    assert result.startswith("Error:")
    assert "target teammate" in result


def test_scheduler_tool_started_service_accepts_threaded_mutations(tmp_path: Path) -> None:
    async def scenario() -> None:
        service = SchedulerService(SchedulerStore(tmp_path), max_sleep_ms=60_000)
        tool = SchedulerTool(service)
        await service.start()
        try:
            created = await asyncio.to_thread(
                tool.execute,
                action="add",
                name="threaded",
                payload_kind="agent_turn",
                message="Run from worker thread",
                every_seconds=60,
            )
            assert "Scheduler job created" in created
            assert "no running event loop" not in created

            job = next(job for job in service.list_jobs(include_disabled=True) if job.name == "threaded")

            paused = await asyncio.to_thread(tool.execute, action="pause", job_id=job.id)
            resumed = await asyncio.to_thread(tool.execute, action="resume", job_id=job.id)
            removed = await asyncio.to_thread(tool.execute, action="remove", job_id=job.id)

            assert "paused" in paused
            assert "resumed" in resumed
            assert "removed" in removed
            assert service.get_job(job.id) is None
        finally:
            service.stop()

    asyncio.run(scenario())


def test_scheduler_tool_threaded_invalid_add_does_not_persist(tmp_path: Path) -> None:
    async def scenario() -> None:
        service = SchedulerService(SchedulerStore(tmp_path), max_sleep_ms=60_000)
        tool = SchedulerTool(service)
        await service.start()
        try:
            result = await asyncio.to_thread(
                tool.execute,
                action="add",
                name="bad-threaded",
                payload_kind="agent_turn",
                message="Missing schedule",
            )

            assert result.startswith("Error:")
            assert not any(job.name == "bad-threaded" for job in service.list_jobs(include_disabled=True))
        finally:
            service.stop()

    asyncio.run(scenario())
