"""Plan verification: command-based step verification + independent reviewer flow.

Extracted verbatim from ControlManager (no behavior change). Operates on the shared
plan_store / control store via the owning ControlManager; cross-domain queries
(`_latest_executable_plan`, `_latest_reviewable_plan`) and the task-sidechain helper
(`_append_plan_step_verification`) remain on ControlManager and are called through it.
"""

from __future__ import annotations

from dataclasses import replace
from typing import Any

from ..plans import PlanRecord, PlanStatus, PlanStepStatus, VerificationReviewRequest
from .models import ControlMode, InteractionStatus, now_ts
from .plan_helpers import (
    _INDEPENDENT_VERIFICATION_SOURCE,
    _INDEPENDENT_VERIFICATION_WAIVER_SOURCE,
    _dedupe_strings,
    _has_command_evidence,
    _independent_verification_risk_signals,
    _latest_independent_verification_evidence,
    _metadata_without_plan_permission_tokens,
    _normalize_command,
    _plan_changed_files,
    _plan_commands,
    _plan_steps_finished,
)


class PlanVerificationManager:
    def __init__(self, control_manager) -> None:
        self._cm = control_manager

    def plan_verification_target(self, command: str) -> dict[str, str] | None:
        record = self._cm._latest_executable_plan()
        if record is None:
            return None
        requested = _normalize_command(command)
        for step in record.steps:
            if step.status != PlanStepStatus.ACTIVE.value:
                continue
            for expected in step.commands:
                if _normalize_command(expected) == requested:
                    return {
                        "plan_id": record.id,
                        "step_id": step.id,
                        "command": expected,
                    }
        return None

    def record_plan_verification_result(
        self,
        *,
        plan_id: str,
        step_id: str,
        result: dict[str, Any],
    ) -> PlanRecord | None:
        record = self._cm.plan_store.get(plan_id)
        if record is None:
            return None
        now = now_ts()
        failed = result.get("passed") is False
        steps = [
            replace(
                step,
                status=PlanStepStatus.FAILED.value if failed else step.status,
                evidence=[*step.evidence, result],
            )
            if step.id == step_id
            else step
            for step in record.steps
        ]
        metadata = (
            _metadata_without_plan_permission_tokens(record.metadata, reason="plan step failed")
            if failed
            else dict(record.metadata)
        )
        updated = replace(
            record,
            status=PlanStatus.EXECUTING.value,
            updated_at=now,
            steps=steps,
            metadata=metadata,
        )
        self._cm.plan_store.save(updated)
        self._cm._append_plan_step_verification(updated, step_id=step_id, result=result)
        return updated

    def plan_completion_followup(self) -> dict[str, Any] | None:
        record = self._cm._latest_executable_plan()
        if record is None or not record.steps:
            return None
        unfinished = [
            step for step in record.steps
            if step.status not in {PlanStepStatus.DONE.value, PlanStepStatus.SKIPPED.value}
        ]
        if not unfinished:
            return None
        lines = [
            "[PLAN_INCOMPLETE]",
            f"plan_id: {record.id}",
            f"status: {record.status}",
            "以下计划步骤仍未完成，不能直接最终答复。请继续执行、修复失败步骤，或在确实受阻时说明阻塞原因并调用 ask_user：",
            "",
        ]
        for step in unfinished:
            lines.append(f"- {step.id} [{step.status}] {step.title}")
            if step.commands:
                lines.append(f"  commands: {'; '.join(step.commands[:3])}")
            if step.evidence:
                latest = step.evidence[-1]
                summary = str(latest.get("summary") or latest.get("error") or "")[:300]
                if summary:
                    lines.append(f"  latest_evidence: {summary}")
        return {
            "plan_id": record.id,
            "unfinished_count": len(unfinished),
            "message": "\n".join(lines),
            "plan": record.to_dict(),
        }

    def record_independent_verification_result(
        self,
        *,
        plan_id: str,
        result: dict[str, Any],
    ) -> PlanRecord | None:
        record = self._cm.plan_store.get(plan_id)
        if record is None:
            return None
        now = now_ts()
        payload = dict(result or {})
        payload["source"] = str(payload.get("source") or _INDEPENDENT_VERIFICATION_SOURCE)
        payload["checked_at"] = float(payload.get("checked_at") or now)
        if "commands" in payload:
            payload["commands"] = _dedupe_strings([str(item) for item in payload.get("commands") or []])
        metadata = dict(record.metadata)
        metadata["independent_verification_latest"] = payload
        updated = replace(
            record,
            updated_at=now,
            verification=[*record.verification, payload],
            metadata=metadata,
        )
        self._cm.plan_store.save(updated)
        return updated

    def waive_independent_verification(self, *, plan_id: str, reason: str) -> PlanRecord | None:
        record = self._cm.plan_store.get(plan_id)
        if record is None:
            return None
        text = str(reason or "").strip()
        if not text:
            raise ValueError("waiver reason is required")
        now = now_ts()
        payload = {
            "source": _INDEPENDENT_VERIFICATION_WAIVER_SOURCE,
            "waived": True,
            "passed": True,
            "reason": text[:1000],
            "approved_by": "user",
            "checked_at": now,
        }
        metadata = dict(record.metadata)
        metadata["independent_verification_waiver"] = payload
        updated = replace(
            record,
            updated_at=now,
            verification=[*record.verification, payload],
            metadata=metadata,
        )
        self._cm.plan_store.save(updated)
        return updated

    def plan_independent_verification_followup(
        self,
        *,
        dispatch_available: bool = False,
    ) -> dict[str, Any] | None:
        record = self._cm._latest_reviewable_plan()
        if record is None or not record.steps or not _plan_steps_finished(record):
            return None
        request = self._independent_verification_request(record)
        if request is None:
            return None
        record = self._persist_independent_verification_request(record, request)
        latest = _latest_independent_verification_evidence(record)
        if latest is not None and latest.get("source") == _INDEPENDENT_VERIFICATION_WAIVER_SOURCE:
            return None
        if latest is not None and latest.get("passed") is False:
            return {
                "status": "failed",
                "plan_id": record.id,
                "request": request.to_dict(),
                "message": self._independent_verification_failed_message(record, request, latest),
                "plan": record.to_dict(),
            }
        if latest is not None and latest.get("passed") is True and _has_command_evidence(latest):
            return None
        status = "required" if latest is None else "missing_command_evidence"
        return {
            "status": status,
            "plan_id": record.id,
            "request": request.to_dict(),
            "message": self._independent_verification_required_message(
                record,
                request,
                dispatch_available=dispatch_available,
                missing_command_evidence=latest is not None,
            ),
            "plan": record.to_dict(),
        }

    def _independent_verification_request(self, record: PlanRecord) -> VerificationReviewRequest | None:
        changed_files = _plan_changed_files(record)
        risk_signals = _independent_verification_risk_signals(record, changed_files)
        if not risk_signals:
            return None
        existing = record.metadata.get("independent_verification_request")
        created_at = now_ts()
        if isinstance(existing, dict):
            try:
                created_at = float(existing.get("created_at") or created_at)
            except (TypeError, ValueError):
                pass
        return VerificationReviewRequest(
            plan_id=record.id,
            changed_files=changed_files,
            commands=_plan_commands(record),
            risk_signals=risk_signals,
            created_at=created_at,
            reason="; ".join(risk_signals),
        )

    def _persist_independent_verification_request(
        self,
        record: PlanRecord,
        request: VerificationReviewRequest,
    ) -> PlanRecord:
        payload = request.to_dict()
        if record.metadata.get("independent_verification_request") == payload:
            return record
        metadata = dict(record.metadata)
        metadata["independent_verification_request"] = payload
        updated = replace(record, updated_at=now_ts(), metadata=metadata)
        self._cm.plan_store.save(updated)
        return updated

    def _independent_verification_required_message(
        self,
        record: PlanRecord,
        request: VerificationReviewRequest,
        *,
        dispatch_available: bool,
        missing_command_evidence: bool,
    ) -> str:
        state = self._cm.store.load()
        has_pending = bool(state.pending and state.pending.status == InteractionStatus.WAITING.value)
        can_dispatch = bool(
            dispatch_available
            and state.mode != ControlMode.PLAN.value
            and not has_pending
        )
        lines = [
            "[PLAN_INDEPENDENT_VERIFICATION_REQUIRED]",
            f"plan_id: {record.id}",
            f"changed_files: {len(request.changed_files)}",
            f"risk_signals: {'; '.join(request.risk_signals)}",
            "",
            "该计划属于非平凡或敏感项目变更，不能在没有独立复核证据时最终答复。",
        ]
        if missing_command_evidence:
            lines.append("已有复核声明缺少 command evidence，因此不能视为 PASS。")
        if request.changed_files:
            lines.extend(["", "changed_files:"])
            for path in request.changed_files[:12]:
                lines.append(f"- {path}")
        if request.commands:
            lines.extend(["", "commands_to_spot_check:"])
            for command in request.commands[:8]:
                lines.append(f"- {command}")
        lines.append("")
        if can_dispatch:
            lines.extend([
                "请先调用 `dispatch_subagent` 派遣独立复核：",
                '- agent_type: "verification_reviewer"',
                "- task: 复核变更文件、计划证据和关键验证命令，输出 PASS/FAIL、证据和风险。",
                "复核 PASS 后，必须把 reviewer 结论和 command evidence 记录为 plan independent verification evidence；"
                "若 FAIL，先修复再重新验证。",
            ])
        else:
            lines.extend([
                "当前不能安全自动派遣 reviewer。请调用 `ask_user` 请求明确豁免，",
                "或先恢复到可派遣状态后再派 `verification_reviewer`。用户豁免必须记录为 plan verification evidence。",
            ])
        return "\n".join(lines)

    def _independent_verification_failed_message(
        self,
        record: PlanRecord,
        request: VerificationReviewRequest,
        latest: dict[str, Any],
    ) -> str:
        summary = str(latest.get("summary") or latest.get("reason") or "independent verification failed").strip()
        lines = [
            "[PLAN_INDEPENDENT_VERIFICATION_FAILED]",
            f"plan_id: {record.id}",
            f"reviewer: {latest.get('reviewer') or latest.get('source') or 'unknown'}",
            f"risk_signals: {'; '.join(request.risk_signals)}",
            f"summary: {summary[:800]}",
            "",
            "独立复核为 FAIL。不要最终答复；先按复核意见诊断并修复，再重新执行关键验证命令。",
            "修复后需要重新取得 independent verification PASS，或取得用户明确豁免并入库。",
        ]
        commands = latest.get("commands")
        if isinstance(commands, list) and commands:
            lines.extend(["", "review_commands:"])
            for command in commands[:8]:
                lines.append(f"- {command}")
        return "\n".join(lines)
