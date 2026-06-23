from __future__ import annotations

import json
from pathlib import Path

from agent.runtime import RuntimeEventStore
from agent.runtime import events as runtime_events


def test_runtime_event_store_appends_and_recovers_seq(tmp_path: Path) -> None:
    store = RuntimeEventStore(tmp_path)

    first = store.append({"event": "user_message", "content": "hello"}, turn_id="turn_1")
    second = store.append({"event": "tool_call", "name": "read_file"}, turn_id="turn_1")

    assert first["seq"] == 1
    assert second["seq"] == 2
    assert second["turn_id"] == "turn_1"

    restored = RuntimeEventStore(tmp_path)
    assert restored.latest_seq == 2
    assert [item["event"] for item in restored.replay_after(1)] == ["tool_call"]


def test_runtime_event_store_filters_turns_and_skips_bad_lines(tmp_path: Path) -> None:
    store = RuntimeEventStore(tmp_path)
    store.append({"event": "user_message", "content": "a"}, turn_id="turn_a")
    store.append({"event": "assistant_done", "content": "a"}, turn_id="turn_a")
    store.append({"event": "user_message", "content": "b"}, turn_id="turn_b")
    with store.events_file.open("a", encoding="utf-8") as f:
        f.write("{bad json\n")
        f.write(json.dumps({"seq": 99, "event": "assistant_done", "turn_id": "turn_b"}) + "\n")

    events = store.events_for_turns(["turn_b"])

    assert [event["event"] for event in events] == ["user_message", "assistant_done"]
    assert all(event["turn_id"] == "turn_b" for event in events)


def test_runtime_event_store_stats_include_active_turns(tmp_path: Path) -> None:
    store = RuntimeEventStore(tmp_path)
    store.append({"event": "user_message", "content": "a"}, turn_id="turn_a")
    store.append({"event": "tool_call", "name": "read_file"}, turn_id="turn_a")
    store.append({"event": "user_message", "content": "b"}, turn_id="turn_b")

    stats = store.stats(active_turn_ids=["turn_a"])

    assert stats["events"] == 3
    assert stats["latestSeq"] == 3
    assert stats["activeTurns"] == 1
    assert stats["activeTurnEvents"] == 2
    assert stats["path"] == "memory/runtime/events.jsonl"


def test_runtime_event_store_compacts_inactive_turns_to_archive(tmp_path: Path) -> None:
    store = RuntimeEventStore(tmp_path)
    store.append({"event": "user_message", "content": "a", "ts": 1_700_000_000.0}, turn_id="turn_a")
    store.append({"event": "tool_call", "name": "read_file", "ts": 1_700_000_001.0}, turn_id="turn_a")
    store.append({"event": "user_message", "content": "b", "ts": 1_700_000_002.0}, turn_id="turn_b")

    stats = store.compact(["turn_b"])

    hot = store.replay_after(0)
    assert [event["turn_id"] for event in hot] == ["turn_b"]
    assert stats["events"] == 1
    assert stats["archiveFiles"] == 1
    assert stats["archiveBytes"] > 0
    assert store.latest_seq == 3
    assert RuntimeEventStore(tmp_path).latest_seq == 3


def test_scheduler_runtime_event_payloads() -> None:
    job = {"id": "job-1", "name": "demo"}
    user = runtime_events.user_message(
        content="hello",
        attachments=[],
        client_message_id="scheduler:job-1:turn-1",
        source="scheduler",
        scheduler={"jobId": "job-1", "jobName": "demo"},
    )

    assert user["event"] == "user_message"
    assert user["source"] == "scheduler"
    assert user["scheduler"] == {"jobId": "job-1", "jobName": "demo"}
    assert runtime_events.scheduler_job_update(job, action="created") == {
        "event": "scheduler_job_update",
        "job": job,
        "action": "created",
    }
    assert runtime_events.scheduler_run_start(job)["event"] == "scheduler_run_start"
    assert runtime_events.scheduler_run_done(job)["event"] == "scheduler_run_done"
    assert runtime_events.scheduler_run_cancelled(job)["event"] == "scheduler_run_cancelled"
    error = runtime_events.scheduler_run_error(job, error="boom")
    assert error["event"] == "scheduler_run_error"
    assert error["error"] == "boom"
    cancelled = runtime_events.runtime_task_cancelled({"id": "turn:1"}, reason="stop")
    assert cancelled["event"] == "runtime_task_cancelled"
    assert cancelled["reason"] == "stop"


def test_external_runtime_event_payloads() -> None:
    message = {"platform": "fake", "external_message_id": "m1"}
    delivery = {"ok": True}

    assert runtime_events.external_inbound(message) == {
        "event": "external_inbound",
        "message": message,
    }
    queued = runtime_events.external_queued(message, reason="busy")
    assert queued["event"] == "external_queued"
    assert queued["reason"] == "busy"
    assert runtime_events.external_outbound_queued(message)["event"] == "external_outbound_queued"
    sent = runtime_events.external_outbound_sent(message, delivery=delivery)
    assert sent["event"] == "external_outbound_sent"
    assert sent["delivery"] == delivery
    error = runtime_events.external_outbound_error(message, error="boom")
    assert error["event"] == "external_outbound_error"
    assert error["error"] == "boom"


def test_session_runtime_event_payloads() -> None:
    session = {"id": "s1", "title": "新会话"}

    created = runtime_events.session_created(session, client_draft_id="draft-1")
    assert created == {
        "event": "session_created",
        "session": session,
        "client_draft_id": "draft-1",
    }

    updated = runtime_events.session_title_updated(session)
    assert updated == {
        "event": "session_title_updated",
        "session": session,
    }


def test_task_runtime_event_payloads() -> None:
    task = {
        "id": "task_1",
        "kind": "subagent",
        "status": "running",
        "title": "inspect",
        "source": "dispatch_subagent",
    }

    assert runtime_events.task_started(task) == {"event": "task_started", "task": task}
    assert runtime_events.task_progress(task, progress={"pct": 50}) == {
        "event": "task_progress",
        "task": task,
        "progress": {"pct": 50},
    }
    assert runtime_events.task_output(task, offset=1, chunk="hello") == {
        "event": "task_output",
        "task": task,
        "offset": 1,
        "chunk": "hello",
    }
    assert runtime_events.task_done(task) == {"event": "task_done", "task": task}
    assert runtime_events.task_error(task, error="boom") == {
        "event": "task_error",
        "task": task,
        "error": "boom",
    }
    assert runtime_events.task_cancelled(task, reason="stop") == {
        "event": "task_cancelled",
        "task": task,
        "reason": "stop",
    }
