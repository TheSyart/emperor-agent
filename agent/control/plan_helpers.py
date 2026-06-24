"""Pure plan-domain helper functions shared by ControlManager and its sub-managers.

These were extracted verbatim from control/manager.py (no behavior change). They take
plain values / PlanRecord / PlanStep and own no ControlManager state.
"""

from __future__ import annotations

from dataclasses import replace
from typing import Any

from ..plans import (
    PlanDraftPhase,
    PlanDraftState,
    PlanRecord,
    PlanStep,
    PlanStepStatus,
    VerificationRequirement,
    assess_step_verification,
)
from ..tasks import TaskStatus
from .models import now_ts

_INDEPENDENT_VERIFICATION_SOURCE = "independent_verification"
_INDEPENDENT_VERIFICATION_WAIVER_SOURCE = "independent_verification_waiver"
_INDEPENDENT_VERIFICATION_SOURCES = {
    _INDEPENDENT_VERIFICATION_SOURCE,
    "verification_reviewer",
    "reviewer",
    "verification_subagent",
}


def _first_heading(text: str) -> str:
    for line in text.splitlines():
        stripped = line.strip()
        if stripped.startswith("#"):
            return stripped.lstrip("#").strip()[:160]
    return ""


def _plain_summary(text: str) -> str:
    compact = " ".join(line.strip().lstrip("-*# ") for line in text.splitlines() if line.strip())
    return (compact or "计划待预览。")[:1200]


def _looks_like_plan(text: str) -> bool:
    return bool(
        "##" in text
        or "\n-" in text
        or "\n1." in text
        or "验收" in text
        or "Test Plan" in text
    )


def _parse_plan_steps(items: list[dict[str, Any]]) -> list[PlanStep]:
    steps: list[PlanStep] = []
    for index, item in enumerate(items, start=1):
        if not isinstance(item, dict):
            continue
        title = str(item.get("title") or "").strip()
        if not title:
            continue
        steps.append(
            PlanStep(
                id=str(item.get("id") or f"step_{index}").strip()[:64],
                title=title[:160],
                description=str(item.get("description") or "").strip()[:1000],
                files=[str(path) for path in item.get("files") or []][:30],
                commands=[str(command) for command in item.get("commands") or []][:12],
                acceptance=[str(rule) for rule in item.get("acceptance") or []][:12],
                discovery_refs=[
                    str(ref)
                    for ref in item.get("discovery_refs") or item.get("discoveryRefs") or []
                    if str(ref or "").strip()
                ][:12],
                verification=[
                    VerificationRequirement.from_dict(raw)
                    for raw in item.get("verification") or item.get("verification_requirements") or []
                    if isinstance(raw, dict)
                ][:20],
                risk=str(item.get("risk") or "medium").strip()[:24],
                risk_note=str(item.get("risk_note") or item.get("riskNote") or "").strip()[:1000],
                rollback=str(
                    item.get("rollback") or item.get("rollback_path") or item.get("rollbackPath") or ""
                ).strip()[:1000],
            )
        )
    return steps


def _ready_for_approval_draft(
    draft: PlanDraftState,
    *,
    summary: str,
    steps: list[PlanStep],
) -> PlanDraftState:
    files = list(draft.relevant_files)
    commands = list(draft.verification_strategy)
    for step in steps:
        files.extend(step.files)
        commands.extend(step.commands)
    return replace(
        draft,
        phase=PlanDraftPhase.READY_FOR_APPROVAL.value,
        relevant_files=_dedupe_strings(files),
        recommended_approach=str(summary or "").strip()[:1200],
        verification_strategy=_dedupe_strings(commands),
    )


def _dedupe_strings(items: list[str]) -> list[str]:
    seen: set[str] = set()
    result: list[str] = []
    for item in items:
        text = str(item or "").strip()
        if not text or text in seen:
            continue
        seen.add(text)
        result.append(text)
    return result


def _is_positive_int(value: Any) -> bool:
    try:
        return int(value) > 0
    except (TypeError, ValueError):
        return False


def _plan_status_from_todo(status: str) -> str:
    if status == "completed":
        return PlanStepStatus.DONE.value
    if status == "in_progress":
        return PlanStepStatus.ACTIVE.value
    if status == "blocked":
        return PlanStepStatus.BLOCKED.value
    return PlanStepStatus.PENDING.value


def _verification_state_by_command(step: PlanStep) -> dict[str, bool]:
    expected = {_normalize_command(command) for command in step.commands}
    states: dict[str, bool] = {}
    for item in step.evidence:
        if not isinstance(item, dict):
            continue
        command = _normalize_command(item.get("command"))
        if command not in expected:
            continue
        passed = item.get("passed")
        if isinstance(passed, bool):
            states[command] = passed
    return states


def _normalize_command(command: Any) -> str:
    return " ".join(str(command or "").strip().split())


def _plan_steps_finished(record: PlanRecord) -> bool:
    return bool(record.steps) and all(
        step.status in {PlanStepStatus.DONE.value, PlanStepStatus.SKIPPED.value}
        for step in record.steps
    )


def _plan_changed_files(record: PlanRecord) -> list[str]:
    files: list[str] = []
    files.extend(record.draft.relevant_files)
    for step in record.steps:
        files.extend(step.files)
    return _dedupe_strings(files)


def _plan_commands(record: PlanRecord) -> list[str]:
    commands: list[str] = []
    commands.extend(record.draft.verification_strategy)
    for step in record.steps:
        commands.extend(step.commands)
    return _dedupe_strings(commands)


def _independent_verification_risk_signals(record: PlanRecord, changed_files: list[str]) -> list[str]:
    signals: list[str] = []
    if len(changed_files) >= 3:
        signals.append("changed_files>=3")
    for path in changed_files:
        _append_file_risk_signals(signals, path)
    text = _plan_risk_text(record)
    for token, signal in (
        ("delete", "deletion"),
        ("remove", "deletion"),
        ("rm ", "deletion"),
        ("删除", "deletion"),
        ("移除", "deletion"),
        ("deploy", "deployment"),
        ("deployment", "deployment"),
        ("publish", "deployment"),
        ("release", "deployment"),
        ("部署", "deployment"),
        ("发布", "deployment"),
        ("external send", "external_send"),
        ("send_external", "external_send"),
        ("outbound", "external_send"),
        ("外发", "external_send"),
        ("外部发送", "external_send"),
        ("security", "security"),
        ("auth", "security"),
        ("secret", "security"),
        ("token", "security"),
        ("permission", "permission"),
        ("权限", "permission"),
        ("安全", "security"),
        ("migration", "data_migration"),
        ("migrate", "data_migration"),
        ("schema", "data_migration"),
        ("迁移", "data_migration"),
    ):
        if token in text:
            _append_unique(signals, signal)
    return signals


def _append_file_risk_signals(signals: list[str], path: str) -> None:
    normalized = str(path or "").strip().replace("\\", "/").lower()
    if not normalized:
        return
    checks = (
        (("agent/web/", "agent/webui.py", "webui.py", "/routes/", "/api/"), "api"),
        (("agent/permissions/", "permission"), "permission"),
        (("agent/control/",), "control"),
        (("agent/scheduler/", "scheduler"), "scheduler"),
        (("agent/runtime/", "desktop/src/renderer/src/runtime/", "/runtime/"), "runtime"),
        (("agent/external/", "external", "outbox", "outbound"), "external_send"),
        (("agent/runner.py", "agent/loop.py", "agent/tools/", "agent/tasks/", "agent/team/", "agent/mcp/"), "backend"),
        (("security", "auth", "secret", "token", "credential"), "security"),
        (("migration", "migrations", "schema"), "data_migration"),
        (("deploy", "release", "publish"), "deployment"),
        (("delete", "remove", "unlink"), "deletion"),
    )
    for needles, signal in checks:
        if any(needle in normalized for needle in needles):
            _append_unique(signals, signal)


def _plan_risk_text(record: PlanRecord) -> str:
    parts = [
        record.title,
        record.summary,
        record.plan_markdown,
        *(record.assumptions or []),
    ]
    for step in record.steps:
        parts.extend([
            step.title,
            step.description,
            step.risk_note,
            step.rollback,
            *(step.acceptance or []),
            *(step.commands or []),
            *(step.files or []),
        ])
    return "\n".join(str(item or "") for item in parts).lower()


def _latest_independent_verification_evidence(record: PlanRecord) -> dict[str, Any] | None:
    candidates = []
    for item in record.verification:
        if not isinstance(item, dict):
            continue
        source = str(item.get("source") or "")
        if source in _INDEPENDENT_VERIFICATION_SOURCES or source == _INDEPENDENT_VERIFICATION_WAIVER_SOURCE:
            candidates.append(item)
    return candidates[-1] if candidates else None


def _has_command_evidence(evidence: dict[str, Any]) -> bool:
    command = str(evidence.get("command") or "").strip()
    commands = evidence.get("commands")
    if command:
        return True
    if isinstance(commands, list) and any(str(item or "").strip() for item in commands):
        return True
    command_evidence = evidence.get("command_evidence")
    return isinstance(command_evidence, list) and any(
        isinstance(item, dict) and str(item.get("command") or "").strip()
        for item in command_evidence
    )


def _metadata_without_plan_permission_tokens(
    metadata: dict[str, Any],
    *,
    reason: str = "plan changed",
) -> dict[str, Any]:
    payload = dict(metadata or {})
    had_tokens = bool(payload.get("permission_tokens"))
    payload["permission_tokens"] = []
    if had_tokens:
        payload["permission_tokens_revoked"] = {
            "reason": str(reason or "revoked")[:240],
            "timestamp": now_ts(),
        }
    return payload


def _task_status_from_plan_step(status: str) -> str:
    if status == PlanStepStatus.ACTIVE.value:
        return TaskStatus.RUNNING.value
    if status == PlanStepStatus.PENDING.value:
        return TaskStatus.QUEUED.value
    if status in {PlanStepStatus.DONE.value, PlanStepStatus.SKIPPED.value}:
        return TaskStatus.COMPLETED.value
    if status == PlanStepStatus.FAILED.value:
        return TaskStatus.FAILED.value
    if status == PlanStepStatus.BLOCKED.value:
        return TaskStatus.PENDING.value
    return TaskStatus.PENDING.value


def _step_verification_status(step: PlanStep) -> str:
    assessment = assess_step_verification(step)
    if assessment.failed_required:
        return "failed"
    if assessment.requirements:
        if not assessment.blocking_errors:
            return "passed"
        return "pending"
    return "not_required"


def _append_unique(items: list[str], value: str) -> None:
    if value not in items:
        items.append(value)
