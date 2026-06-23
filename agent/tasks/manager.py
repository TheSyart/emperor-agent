from __future__ import annotations

import time
from pathlib import Path
from uuid import uuid4

from .models import TaskKind, TaskRecord, TaskStatus
from .sidechain import SidechainTranscript
from .store import TaskStore


class TaskManager:
    def __init__(self, root: Path | str) -> None:
        self.root = Path(root).resolve()
        self.store = TaskStore(self.root)

    def start_task(
        self,
        *,
        kind: str,
        title: str,
        source: str,
        turn_id: str | None = None,
        tool_call_id: str | None = None,
        job_id: str | None = None,
        metadata: dict | None = None,
    ) -> TaskRecord:
        task_id = f"{self._prefix(kind)}_{uuid4().hex[:12]}"
        transcript = SidechainTranscript(self.root, task_id)
        record = TaskRecord(
            id=task_id,
            kind=kind,
            status=TaskStatus.RUNNING.value,
            title=title[:160],
            source=source,
            started_at=time.time(),
            turn_id=turn_id,
            tool_call_id=tool_call_id,
            job_id=job_id,
            transcript_path=str(transcript.path.relative_to(self.root)),
            metadata=metadata or {},
        )
        self.store.upsert(record)
        return record

    def update_task(self, task_id: str, **fields) -> TaskRecord | None:
        record = self.store.get(task_id)
        if record is None:
            return None
        payload = record.to_dict()
        allowed = {
            "turn_id",
            "tool_call_id",
            "job_id",
            "output_path",
            "transcript_path",
            "progress",
            "metadata",
        }
        for key, value in fields.items():
            if key in allowed:
                payload[key] = value
        updated = TaskRecord.from_dict(payload)
        self.store.upsert(updated)
        return updated

    def append_sidechain(self, task_id: str, message: dict) -> None:
        SidechainTranscript(self.root, task_id).append(message)

    def read_sidechain(self, task_id: str, *, offset: int = 0, limit: int = 100) -> dict:
        return SidechainTranscript(self.root, task_id).read(offset=offset, limit=limit)

    def complete_task(self, task_id: str, *, summary: str = "") -> TaskRecord | None:
        record = self.store.get(task_id)
        if record is None:
            return None
        updated = TaskRecord.from_dict({
            **record.to_dict(),
            "status": TaskStatus.COMPLETED.value,
            "ended_at": time.time(),
            "progress": {**record.progress, "summary": summary},
        })
        self.store.upsert(updated)
        return updated

    def fail_task(self, task_id: str, *, error: str) -> TaskRecord | None:
        record = self.store.get(task_id)
        if record is None:
            return None
        updated = TaskRecord.from_dict({
            **record.to_dict(),
            "status": TaskStatus.FAILED.value,
            "ended_at": time.time(),
            "progress": {**record.progress, "error": error},
        })
        self.store.upsert(updated)
        return updated

    def cancel_task(self, task_id: str, *, reason: str = "cancelled") -> TaskRecord | None:
        record = self.store.get(task_id)
        if record is None:
            return None
        updated = TaskRecord.from_dict({
            **record.to_dict(),
            "status": TaskStatus.CANCELLED.value,
            "ended_at": time.time(),
            "progress": {**record.progress, "reason": reason},
        })
        self.store.upsert(updated)
        return updated

    @staticmethod
    def _prefix(kind: str) -> str:
        return {
            TaskKind.SUBAGENT.value: "subagent",
            TaskKind.TEAM_WAKE.value: "team",
            TaskKind.SCHEDULER_RUN.value: "scheduler",
        }.get(kind, "task")
