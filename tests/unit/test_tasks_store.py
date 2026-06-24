from agent.tasks.models import TaskKind, TaskRecord, TaskStatus
from agent.tasks.store import TaskStore


def test_task_store_round_trips_records(tmp_path) -> None:
    store = TaskStore(tmp_path)
    record = TaskRecord(
        id="task_1",
        kind=TaskKind.SUBAGENT.value,
        status=TaskStatus.RUNNING.value,
        title="inspect files",
        source="dispatch_subagent",
        turn_id="turn_1",
        started_at=123.0,
    )

    store.upsert(record)

    assert store.get("task_1") == record
    assert store.list()[0].id == "task_1"


def test_task_store_marks_corrupt_index(tmp_path) -> None:
    store = TaskStore(tmp_path)
    store.index_file.write_text("{bad json", encoding="utf-8")

    records = store.list()

    assert records == []
    assert list(store.tasks_dir.glob("index.json.corrupt-*"))
