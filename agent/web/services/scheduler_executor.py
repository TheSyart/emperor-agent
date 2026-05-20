from __future__ import annotations

import asyncio
from typing import TYPE_CHECKING

from loguru import logger

from ...control import TurnPaused
from ...runtime import events as runtime_events
from ...scheduler import SchedulerJob, reset_scheduler_run, set_scheduler_run

if TYPE_CHECKING:
    from ..state import WebUIState


class SchedulerJobExecutor:
    """Execute durable scheduler payloads against the local WebUI runtime."""

    def __init__(self, state: WebUIState):
        self.state = state

    async def run(self, job: SchedulerJob) -> str | None:
        token = set_scheduler_run(True)
        try:
            if job.payload.kind == "agent_turn":
                return await self._run_agent_turn(job)
            if job.payload.kind == "team_wake":
                return await self._run_team_wake(job)
            if job.payload.kind == "system_event":
                return self._run_system_event(job)
            raise ValueError(f"unsupported scheduler payload kind: {job.payload.kind}")
        finally:
            reset_scheduler_run(token)

    async def _run_agent_turn(self, job: SchedulerJob) -> str:
        message = job.payload.message.strip()
        if not message:
            raise ValueError("agent_turn scheduler job requires payload.message")
        if self.state.control().get("pending"):
            raise RuntimeError("cannot run scheduler agent_turn while Ask / Plan is pending")

        turn_id = self.state.new_turn_id()
        model_content = self._agent_turn_content(job)
        display = f"司时台触发 · {job.name}\n\n{message}"
        async with self.state.lock:
            self.state.history.append({"role": "user", "content": model_content, "turn_id": turn_id})
            self.state.loop.memory.append_history(
                "user",
                model_content,
                extra={
                    "type": "scheduler_agent_turn",
                    "turn_id": turn_id,
                    "jobId": job.id,
                    "displayContent": display,
                },
            )
            await self.state._broadcast_event(
                runtime_events.user_message(
                    content=display,
                    attachments=[],
                    client_message_id=f"scheduler:{job.id}:{turn_id}",
                ),
                turn_id=turn_id,
            )
            self.state.active_turn = True

            async def emit(event: dict) -> None:
                await self.state._broadcast_event(event, turn_id=turn_id)

            try:
                await self.state.loop.runner.step_stream(self.state.history, emit, turn_id=turn_id)
            except TurnPaused:
                return "paused waiting for user"
            finally:
                self.state.active_turn = False
        return "agent_turn completed"

    async def _run_team_wake(self, job: SchedulerJob) -> str:
        target = str(job.payload.target or "").strip()
        message = job.payload.message.strip()
        if not target:
            raise ValueError("team_wake scheduler job requires payload.target")
        if not message:
            raise ValueError("team_wake scheduler job requires payload.message")

        async def emit(event: dict) -> None:
            await self.state._broadcast_event(event)

        loop = asyncio.get_running_loop()
        return await asyncio.to_thread(
            self.state.loop.team_manager.send_message,
            to=target,
            content=message,
            wake=True,
            type="task",
            emit=emit,
            loop=loop,
        )

    def _run_system_event(self, job: SchedulerJob) -> str:
        event_name = str(job.payload.meta.get("system_event") or job.payload.message or job.id)
        if event_name == "memory-maintenance":
            stats = self.state.loop.memory.history_stats()
            return (
                "memory-maintenance checked: "
                f"hot={stats.get('active_lines', 0)} lines / {stats.get('active_bytes', 0)} bytes, "
                f"archives={stats.get('archive_files', 0)}"
            )
        if event_name == "runtime-maintenance":
            stats = self.state.runtime_events.stats(
                active_turn_ids=self.state.loop.memory.load_unarchived_turn_ids(),
            )
            return (
                "runtime-maintenance checked: "
                f"events={stats.get('events', 0)}, bytes={stats.get('bytes', 0)}, "
                f"latestSeq={stats.get('latestSeq', 0)}"
            )
        if event_name == "team-stale-recovery":
            before = [
                member.name
                for member in self.state.loop.team_manager.store.list_members()
                if member.status == "working"
            ]
            self.state.loop.team_manager.store.mark_stale_working_offline()
            return f"team-stale-recovery checked: recovered={len(before)}"
        if event_name == "token-ledger-maintenance":
            totals = self.state.loop.token_tracker.totals()
            return (
                "token-ledger-maintenance checked: "
                f"calls={totals.get('calls', 0)}, total={totals.get('total', 0)}"
            )
        logger.info("Scheduler system_event '{}' acknowledged", job.name)
        return f"system_event acknowledged: {event_name}"

    @staticmethod
    def _agent_turn_content(job: SchedulerJob) -> str:
        return "\n".join([
            "[SCHEDULER_TRIGGER]",
            f"job_id: {job.id}",
            f"job_name: {job.name}",
            f"payload_kind: {job.payload.kind}",
            "",
            "用户预先登记的本地长期任务现在触发。请把它当作一次主动 turn 处理；完成后给出简洁结果。",
            "",
            "## Scheduled Task",
            job.payload.message.strip(),
        ])
