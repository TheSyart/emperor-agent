from __future__ import annotations

import time
from pathlib import Path
from uuid import uuid4

from .models import TaskKind, TaskRecord, TaskStatus
from .sidechain import SidechainTranscript
from .store import TaskStore


class TaskManager:
    def __init__(self, root: Path | str) -> None:
        self.root = Path(root)
        self.store = TaskStore(self.root)

    def start_task(
        self,
        *,
        kind: str,
        title: str,
        source: str,
        turn_id: str | None = None,
        tool_call_id: str | None = None,
        metadata: dict | None = None,
    ) -> TaskRecord:
        prefix = {
            TaskKind.SUBAGENT.value: "subagent",
            TaskKind.TEAM_WAKE.value: "team",
            TaskKind.SCHEDULER_RUN.value: "scheduler",
        }.get(kind, "task")
        task_id = f"{prefix}_{uuid4().hex[:12]}"
        transcript = SidechainTranscript(self.root, task_id)
        record = TaskRecord(
            id=task_id,
            kind=kind,
            status=TaskStatus.RUNNING.value,
            title=title,
            source=source,
            started_at=time.time(),
            turn_id=turn_id,
            tool_call_id=tool_call_id,
            transcript_path=str(transcript.path.relative_to(self.root)),
            metadata=metadata or {},
        )
        self.store.upsert(record)
        return record

    def append_sidechain(self, task_id: str, message: dict) -> None:
        SidechainTranscript(self.root, task_id).append(message)

    def complete_task(self, task_id: str, *, summary: str = "") -> None:
        record = self.store.get(task_id)
        if record is None:
            return
        self.store.upsert(TaskRecord(
            **{
                **record.to_dict(),
                "status": TaskStatus.COMPLETED.value,
                "ended_at": time.time(),
                "progress": {"summary": summary},
            },
        ))

    def fail_task(self, task_id: str, *, error: str) -> None:
        record = self.store.get(task_id)
        if record is None:
            return
        self.store.upsert(TaskRecord(
            **{
                **record.to_dict(),
                "status": TaskStatus.FAILED.value,
                "ended_at": time.time(),
                "progress": {"error": error},
            },
        ))
