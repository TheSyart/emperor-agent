from __future__ import annotations

from typing import Any

from .models import PlanRecord, PlanStatus, PlanStep, PlanStepStatus
from .store import PlanStore

_ACTIVE_STATUSES = {
    PlanStatus.APPROVED.value,
    PlanStatus.EXECUTING.value,
    PlanStatus.FAILED.value,
}
_COMPLETED_HISTORY_MARKERS = (
    "plan history",
    "previous plan",
    "completed plan",
    "计划历史",
    "历史计划",
    "刚才的计划",
    "之前的计划",
    "回顾",
)


class PlanContextBuilder:
    """Builds a compact model-visible attachment for the current plan runtime."""

    def __init__(self, plan_store: PlanStore, *, max_chars: int = 4000) -> None:
        self.plan_store = plan_store
        self.max_chars = max_chars

    def message_for(self, history: list[dict[str, Any]]) -> dict[str, str] | None:
        record = self.plan_store.latest()
        if record is None:
            return None
        if record.status not in _ACTIVE_STATUSES:
            if record.status != PlanStatus.COMPLETED.value or not _asks_about_completed_plan(history):
                return None
        content = self.build_text(record)
        if not content:
            return None
        return {"role": "system", "content": content}

    def build_text(self, record: PlanRecord) -> str:
        lines = [
            "[PLAN_RUNTIME_CONTEXT]",
            "This is durable runtime state. Use it to continue the approved plan; do not treat it as user input.",
            f"plan_id: {record.id}",
            f"title: {record.title}",
            f"status: {record.status}",
        ]
        active = [step for step in record.steps if step.status == PlanStepStatus.ACTIVE.value]
        failed = [step for step in record.steps if step.status == PlanStepStatus.FAILED.value]
        blocked = [step for step in record.steps if step.status == PlanStepStatus.BLOCKED.value]
        pending = [
            step for step in record.steps
            if step.status in {PlanStepStatus.PENDING.value, PlanStepStatus.BLOCKED.value}
        ]
        for step in active[:3]:
            lines.append(f"active_step: {step.id} [{step.status}] {step.title}")
            lines.extend(_step_files(step, prefix="  file"))
            lines.extend(_step_commands(step))
        lines.append(f"pending_steps: {len(pending)}")
        for step in failed[:5]:
            lines.append(f"failed_step: {step.id} [{step.status}] {step.title}")
            evidence = _latest_evidence(step)
            if evidence:
                summary = _evidence_summary(evidence)
                if summary:
                    lines.append(f"  latest_evidence: {summary}")
                artifact = _artifact_ref(evidence)
                if artifact:
                    lines.append(f"  artifact: {artifact}")
        for step in blocked[:5]:
            lines.append(f"blocked_step: {step.id} [{step.status}] {step.title}")
            reason = _blocked_reason(step)
            if reason:
                lines.append(f"  blocked_reason: {reason}")
        for question in record.draft.open_questions[:5]:
            qid = str(question.get("id") or "").strip()
            text = str(question.get("question") or "").strip()
            if qid or text:
                lines.append(f"open_question: {qid} {text}".rstrip())
        for path in _relevant_files(record)[:20]:
            lines.append(f"file: {path}")
        return _truncate("\n".join(lines), self.max_chars)


def _asks_about_completed_plan(history: list[dict[str, Any]]) -> bool:
    latest = ""
    for message in reversed(history):
        if message.get("role") != "user":
            continue
        latest = _content_text(message.get("content")).lower()
        break
    return any(marker in latest for marker in _COMPLETED_HISTORY_MARKERS)


def _content_text(content: Any) -> str:
    if isinstance(content, str):
        return content
    if isinstance(content, list):
        parts = [
            str(item.get("text") or "")
            for item in content
            if isinstance(item, dict) and item.get("type") == "text"
        ]
        return "\n".join(parts)
    return str(content or "")


def _latest_evidence(step: PlanStep) -> dict[str, Any]:
    for item in reversed(step.evidence):
        if isinstance(item, dict):
            return item
    return {}


def _evidence_summary(evidence: dict[str, Any]) -> str:
    text = str(
        evidence.get("summary")
        or evidence.get("error")
        or evidence.get("stderr_tail")
        or evidence.get("stdout_tail")
        or ""
    ).strip()
    return _truncate_inline(text, 500)


def _artifact_ref(evidence: dict[str, Any]) -> str:
    for key in ("artifact_path", "path"):
        value = str(evidence.get(key) or "").strip()
        if value:
            return value
    artifact = evidence.get("artifact")
    if isinstance(artifact, dict):
        return str(artifact.get("path") or "").strip()
    return ""


def _blocked_reason(step: PlanStep) -> str:
    evidence = _latest_evidence(step)
    return _truncate_inline(str(evidence.get("blocked_reason") or "").strip(), 500)


def _step_files(step: PlanStep, *, prefix: str) -> list[str]:
    return [f"{prefix}: {path}" for path in step.files[:10] if str(path).strip()]


def _step_commands(step: PlanStep) -> list[str]:
    return [f"  command: {command}" for command in step.commands[:5] if str(command).strip()]


def _relevant_files(record: PlanRecord) -> list[str]:
    files: list[str] = []
    files.extend(record.draft.relevant_files)
    for discovery in record.draft.discoveries:
        if isinstance(discovery, dict):
            path = str(discovery.get("path") or discovery.get("file") or "").strip()
            if path:
                files.append(path)
    for step in record.steps:
        files.extend(step.files)
    return _dedupe(files)


def _dedupe(items: list[str]) -> list[str]:
    seen: set[str] = set()
    result: list[str] = []
    for item in items:
        text = str(item or "").strip()
        if not text or text in seen:
            continue
        seen.add(text)
        result.append(text)
    return result


def _truncate(text: str, limit: int) -> str:
    if len(text) <= limit:
        return text
    return text[: max(0, limit - 80)].rstrip() + "\n...[plan runtime context truncated]"


def _truncate_inline(text: str, limit: int) -> str:
    compact = " ".join(str(text or "").split())
    if len(compact) <= limit:
        return compact
    return compact[:limit].rstrip() + "..."
