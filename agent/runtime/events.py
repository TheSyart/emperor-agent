from __future__ import annotations

from typing import Any


def runtime_event(event: str, **payload: Any) -> dict[str, Any]:
    data = {"event": event}
    data.update({key: value for key, value in payload.items() if value is not None})
    return data


def ready_event(
    *,
    model: str,
    provider: str,
    latest_seq: int,
    replay_count: int,
    resume_from: int,
    busy: bool,
    control: dict[str, Any],
) -> dict[str, Any]:
    return runtime_event(
        "ready",
        model=model,
        provider=provider,
        latest_seq=latest_seq,
        replay_count=replay_count,
        resume_from=resume_from,
        busy=busy,
        control=control,
    )


def user_message(
    *,
    content: str,
    attachments: list[dict[str, Any]],
    client_message_id: str = "",
    source: str | None = None,
    scheduler: dict[str, Any] | None = None,
) -> dict[str, Any]:
    return runtime_event(
        "user_message",
        content=content,
        attachments=attachments,
        client_message_id=client_message_id,
        source=source,
        scheduler=scheduler,
    )


def control_mode_update(control: dict[str, Any]) -> dict[str, Any]:
    return runtime_event("control_mode_update", control=control)


def error(message: str, *, partial: bool = True) -> dict[str, Any]:
    return runtime_event("error", message=message, partial=partial)


def model_route_fallback(
    *,
    from_model: str,
    to_model: str,
    reason: str,
    usage_type: str,
) -> dict[str, Any]:
    return runtime_event(
        "model_route_fallback",
        from_model=from_model,
        to_model=to_model,
        reason=reason,
        usage_type=usage_type,
    )


def session_created(session: dict[str, Any], *, client_draft_id: str | None = None) -> dict[str, Any]:
    return runtime_event(
        "session_created",
        session=session,
        client_draft_id=client_draft_id,
    )


def session_title_updated(session: dict[str, Any]) -> dict[str, Any]:
    return runtime_event("session_title_updated", session=session)


def external_inbound(message: dict[str, Any]) -> dict[str, Any]:
    return runtime_event("external_inbound", message=message)


def external_queued(message: dict[str, Any], *, reason: str) -> dict[str, Any]:
    return runtime_event("external_queued", message=message, reason=reason)


def external_outbound_queued(message: dict[str, Any]) -> dict[str, Any]:
    return runtime_event("external_outbound_queued", message=message)


def external_outbound_sent(message: dict[str, Any], *, delivery: dict[str, Any]) -> dict[str, Any]:
    return runtime_event("external_outbound_sent", message=message, delivery=delivery)


def external_outbound_error(message: dict[str, Any], *, error: str) -> dict[str, Any]:
    return runtime_event("external_outbound_error", message=message, error=error)


def scheduler_job_update(job: dict[str, Any], *, action: str) -> dict[str, Any]:
    return runtime_event("scheduler_job_update", job=job, action=action)


def scheduler_run_start(job: dict[str, Any]) -> dict[str, Any]:
    return runtime_event("scheduler_run_start", job=job)


def scheduler_run_done(job: dict[str, Any]) -> dict[str, Any]:
    return runtime_event("scheduler_run_done", job=job)


def scheduler_run_error(job: dict[str, Any], *, error: str) -> dict[str, Any]:
    return runtime_event("scheduler_run_error", job=job, error=error)


def scheduler_run_cancelled(job: dict[str, Any], *, reason: str = "cancelled") -> dict[str, Any]:
    return runtime_event("scheduler_run_cancelled", job=job, reason=reason)


def runtime_task_cancelled(task: dict[str, Any], *, reason: str = "cancelled") -> dict[str, Any]:
    return runtime_event("runtime_task_cancelled", task=task, reason=reason)


def plan_verification_start(*, plan_id: str, step_id: str, command: str) -> dict[str, Any]:
    return runtime_event("plan_verification_start", plan_id=plan_id, step_id=step_id, command=command)


def plan_verification_done(*, plan_id: str, step_id: str, result: dict[str, Any]) -> dict[str, Any]:
    return runtime_event("plan_verification_done", plan_id=plan_id, step_id=step_id, result=result)


def task_started(task: dict[str, Any]) -> dict[str, Any]:
    return runtime_event("task_started", task=task)


def task_progress(task: dict[str, Any], *, progress: dict[str, Any]) -> dict[str, Any]:
    return runtime_event("task_progress", task=task, progress=progress)


def task_output(task: dict[str, Any], *, offset: int, chunk: str) -> dict[str, Any]:
    return runtime_event("task_output", task=task, offset=offset, chunk=chunk)


def task_done(task: dict[str, Any]) -> dict[str, Any]:
    return runtime_event("task_done", task=task)


def task_error(task: dict[str, Any], *, error: str) -> dict[str, Any]:
    return runtime_event("task_error", task=task, error=error)


def task_cancelled(task: dict[str, Any], *, reason: str = "cancelled") -> dict[str, Any]:
    return runtime_event("task_cancelled", task=task, reason=reason)
