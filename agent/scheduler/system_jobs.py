from __future__ import annotations

from .models import SchedulerJob, SchedulerPayload, SchedulerSchedule


SYSTEM_JOB_IDS = {
    "memory-maintenance",
    "runtime-maintenance",
    "team-stale-recovery",
    "token-ledger-maintenance",
}


def default_system_jobs(*, now: int) -> list[SchedulerJob]:
    return [
        SchedulerJob.create(
            job_id="memory-maintenance",
            name="Memory maintenance",
            schedule=SchedulerSchedule(kind="cron", expr="17 3 * * *", tz="Asia/Shanghai"),
            payload=SchedulerPayload(
                kind="system_event",
                message="memory-maintenance",
                meta={"system_event": "memory-maintenance"},
            ),
            protected=True,
            purpose="检查热 history 与长期记忆维护状态，后续可挂载自动压缩策略。",
            now=now,
        ),
        SchedulerJob.create(
            job_id="runtime-maintenance",
            name="Runtime event maintenance",
            schedule=SchedulerSchedule(kind="cron", expr="37 3 * * *", tz="Asia/Shanghai"),
            payload=SchedulerPayload(
                kind="system_event",
                message="runtime-maintenance",
                meta={"system_event": "runtime-maintenance"},
            ),
            protected=True,
            purpose="检查 runtime/events.jsonl 冷记录规模，后续可挂载轮转策略。",
            now=now,
        ),
        SchedulerJob.create(
            job_id="team-stale-recovery",
            name="Team stale recovery",
            schedule=SchedulerSchedule(kind="every", every_ms=60 * 60 * 1000),
            payload=SchedulerPayload(
                kind="system_event",
                message="team-stale-recovery",
                meta={"system_event": "team-stale-recovery"},
            ),
            protected=True,
            purpose="检查持久队友 stale working 状态，避免下次唤醒前状态不可见。",
            now=now,
        ),
        SchedulerJob.create(
            job_id="token-ledger-maintenance",
            name="Token ledger maintenance",
            schedule=SchedulerSchedule(kind="cron", expr="47 3 * * *", tz="Asia/Shanghai"),
            payload=SchedulerPayload(
                kind="system_event",
                message="token-ledger-maintenance",
                meta={"system_event": "token-ledger-maintenance"},
            ),
            protected=True,
            purpose="检查 tokens.jsonl 账本规模与缓存统计，后续可挂载归档策略。",
            now=now,
        ),
    ]


def is_system_job(job_id: str) -> bool:
    return str(job_id or "") in SYSTEM_JOB_IDS
