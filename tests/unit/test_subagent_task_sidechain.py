from agent.tasks.models import TaskKind, TaskRecord, TaskStatus
from agent.tasks.store import TaskStore


def test_subagent_task_record_shape(tmp_path) -> None:
    store = TaskStore(tmp_path)
    task_id = "subagent_1"
    record = {
        "id": task_id,
        "kind": TaskKind.SUBAGENT.value,
        "status": TaskStatus.RUNNING.value,
        "title": "read files",
        "source": "dispatch_subagent",
        "started_at": 1.0,
        "turn_id": "turn_1",
        "tool_call_id": "call_1",
        "transcript_path": "memory/tasks/subagent_1/transcript.jsonl",
    }

    store.upsert(TaskRecord.from_dict(record))

    loaded = store.get(task_id)
    assert loaded is not None
    assert loaded.kind == "subagent"
    assert loaded.transcript_path.endswith("transcript.jsonl")
