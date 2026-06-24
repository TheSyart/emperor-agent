from __future__ import annotations

import json
from dataclasses import dataclass, replace
from typing import Any
from uuid import uuid4

from ..permissions import PermissionManager, PlanPermissionToken
from ..plans import (
    PlanDiscovery,
    PlanDraftPhase,
    PlanDraftState,
    PlanEvidenceError,
    PlanExecutionState,
    PlanQualityGate,
    PlanRecord,
    PlanStatus,
    PlanStep,
    PlanStepStatus,
    PlanStore,
    assess_step_verification,
)
from ..tasks import TaskKind, TaskStatus
from .clarification import ClarificationAssessment, ClarificationPolicy
from .models import (
    ControlMode,
    ControlState,
    Interaction,
    InteractionKind,
    InteractionStatus,
    Question,
    now_ts,
)
from .plan_helpers import (
    _dedupe_strings,
    _first_heading,
    _is_positive_int,
    _looks_like_plan,
    _metadata_without_plan_permission_tokens,
    _parse_plan_steps,
    _plain_summary,
    _plan_status_from_todo,
    _plan_steps_finished,
    _ready_for_approval_draft,
    _step_verification_status,
    _task_status_from_plan_step,
)
from .plan_permissions import PlanPermissionTokenManager
from .plan_policy import PlanDecision, PlanDecisionPolicy
from .plan_verification import PlanVerificationManager
from .policy import ControlPolicy
from .store import ControlStore


@dataclass
class ControlResume:
    interaction: dict[str, Any]
    message: str
    event: dict[str, Any]
    resume: bool = True


class ControlManager:
    def __init__(self, root):
        self.store = ControlStore(root)
        self.plan_store = PlanStore(root)
        self.policy = ControlPolicy(self)
        self.clarification_policy = ClarificationPolicy()
        self.plan_decision_policy = PlanDecisionPolicy()
        self.permission_manager = PermissionManager(self)
        self.permission_tokens = PlanPermissionTokenManager(self)
        self.verification = PlanVerificationManager(self)
        self.todo_store = None
        self.task_manager = None

    def set_todo_store(self, todo_store) -> None:
        self.todo_store = todo_store

    def set_task_manager(self, task_manager) -> None:
        self.task_manager = task_manager

    @property
    def mode(self) -> str:
        return self.store.load().mode

    def payload(self) -> dict[str, Any]:
        state = self.store.load()
        return state.to_dict()

    def set_mode(self, mode: str) -> dict[str, Any]:
        value = str(mode or "").strip().lower()
        if value in {"on", "plan"}:
            value = ControlMode.PLAN.value
        elif value in {"off", "normal", "ask", "ask_before_edit", "edit_before_ask"}:
            value = ControlMode.ASK_BEFORE_EDIT.value
        elif value in {"auto", "automatic"}:
            value = ControlMode.AUTO.value
        if value not in {item.value for item in ControlMode}:
            raise ValueError("mode must be ask_before_edit, auto or plan")
        state = self.store.load()
        old_mode = state.mode
        if value == ControlMode.PLAN.value and state.mode != ControlMode.PLAN.value:
            state.previous_mode = state.mode
        elif value != ControlMode.PLAN.value:
            state.previous_mode = None
        state.mode = value
        state.updated_at = now_ts()
        self.store.save(state)
        if value != old_mode:
            self.revoke_plan_permission_tokens(reason="control mode changed")
        return self.payload()

    def ensure_no_pending(self) -> None:
        pending = self.store.load().pending
        if pending and pending.status == InteractionStatus.WAITING.value:
            raise ValueError(f"pending interaction already exists: {pending.id}")

    def create_ask(
        self,
        *,
        questions: list[dict[str, Any]],
        context: str = "",
        parent_call_id: str | None = None,
        meta: dict[str, Any] | None = None,
    ) -> Interaction:
        self.ensure_no_pending()
        parsed = [Question.from_dict(item) for item in questions]
        interaction_meta = dict(meta or {})
        if self.mode == ControlMode.PLAN.value:
            draft = self._ensure_plan_draft()
            interaction_meta["plan_id"] = draft.id
        interaction = Interaction.ask(
            questions=parsed,
            context=context,
            parent_call_id=parent_call_id,
            meta=interaction_meta,
        )
        if interaction_meta.get("plan_id"):
            self._record_plan_open_questions(interaction)
        self._set_pending(interaction)
        return interaction

    def create_plan(
        self,
        *,
        title: str,
        summary: str,
        plan_markdown: str,
        assumptions: list[str] | None = None,
        risk_level: str = "medium",
        steps: list[dict[str, Any]] | None = None,
        parent_call_id: str | None = None,
        meta: dict[str, Any] | None = None,
        enforce_quality: bool = False,
    ) -> Interaction:
        self.ensure_no_pending()
        plan_meta = dict(meta or {})
        existing = self._plan_record_for_meta(plan_meta) or self._latest_draft_plan()
        plan_id = existing.id if existing is not None else f"plan_{uuid4().hex[:12]}"
        now = now_ts()
        structured_steps = _parse_plan_steps(steps or [])
        interaction = Interaction.plan(
            title=title,
            summary=summary,
            plan_markdown=plan_markdown,
            assumptions=assumptions,
            risk_level=risk_level,
            parent_call_id=parent_call_id,
            meta={**plan_meta, "plan_id": plan_id},
        )
        draft = _ready_for_approval_draft(
            existing.draft if existing is not None else PlanDraftState(),
            summary=interaction.summary,
            steps=structured_steps,
        )
        if enforce_quality:
            PlanQualityGate().require_ok(steps=structured_steps, draft=draft)
        self.plan_store.save(
            PlanRecord(
                id=plan_id,
                title=interaction.title,
                summary=interaction.summary,
                status=PlanStatus.WAITING_APPROVAL.value,
                created_at=existing.created_at if existing is not None else now,
                updated_at=now,
                source_interaction_id=interaction.id,
                plan_markdown=interaction.plan_markdown,
                assumptions=list(interaction.assumptions),
                steps=structured_steps,
                draft=draft,
                metadata=_metadata_without_plan_permission_tokens({
                    **(existing.metadata if existing is not None else {}),
                    "risk_level": interaction.risk_level,
                }),
            )
        )
        self._set_pending(interaction)
        return interaction

    def create_plan_from_text(self, text: str) -> Interaction:
        body = str(text or "").strip()
        if not body:
            body = "Plan 模式要求先提交可预览计划。"
        title = _first_heading(body) or "计划预览"
        summary = _plain_summary(body)
        if not _looks_like_plan(body):
            body = "\n".join([
                "# 计划预览",
                "",
                body,
                "",
                "## 验收",
                "- 用户批准后再执行任何写入或高影响操作。",
            ])
        return self.create_plan(
            title=title,
            summary=summary,
            plan_markdown=body,
            assumptions=[],
            risk_level="medium",
        )

    def assess_clarification(self, history: list[dict[str, Any]]) -> ClarificationAssessment:
        return self.clarification_policy.assess(history)

    def assess_plan_decision(self, user_message: str) -> PlanDecision:
        state = self.store.load()
        has_pending = bool(state.pending and state.pending.status == InteractionStatus.WAITING.value)
        return self.plan_decision_policy.assess(
            user_message,
            mode=state.mode,
            has_pending=has_pending,
        )

    def should_enforce_plan_final(self) -> bool:
        return self.mode == ControlMode.PLAN.value

    def _set_pending(self, interaction: Interaction) -> None:
        state = self.store.load()
        state.pending = interaction
        state.last_interaction = interaction
        state.updated_at = now_ts()
        self.store.save(state)

    def answer(self, interaction_id: str, answers: dict[str, Any]) -> ControlResume:
        interaction = self._require_pending(interaction_id, InteractionKind.ASK)
        normalized = self._normalize_answers(interaction, answers)
        updated = interaction.touch(status=InteractionStatus.ANSWERED.value)
        updated.answers = normalized
        self.permission_manager.record_answer(updated)
        self._record_plan_resolved_questions(updated)
        self._complete(updated)
        message = self._answer_message(updated)
        return ControlResume(
            interaction=updated.to_dict(),
            message=message,
            event={"event": "ask_answered", "interaction": updated.to_dict()},
        )

    def comment(self, interaction_id: str, comment: str) -> ControlResume:
        interaction = self._require_pending(interaction_id, InteractionKind.PLAN)
        text = str(comment or "").strip()
        if not text:
            raise ValueError("comment is required")
        updated = interaction.touch(status=InteractionStatus.COMMENTED.value)
        updated.comments = [
            *updated.comments,
            {"content": text[:4000], "timestamp": now_ts()},
        ]
        self._record_plan_comment(updated, text)
        self._complete(updated)
        message = self._comment_message(updated, text)
        return ControlResume(
            interaction=updated.to_dict(),
            message=message,
            event={"event": "plan_comment_added", "interaction": updated.to_dict(), "comment": text},
        )

    def approve(self, interaction_id: str) -> ControlResume:
        interaction = self._require_pending(interaction_id, InteractionKind.PLAN)
        updated = interaction.touch(status=InteractionStatus.APPROVED.value)
        self._update_plan_status(updated, PlanStatus.APPROVED.value, approved=True)
        plan_record = self._activate_approved_plan(updated)
        state = self.store.load()
        state.mode = self._restore_mode(state)
        state.previous_mode = None
        state.pending = None
        state.last_interaction = updated
        state.updated_at = now_ts()
        self.store.save(state)
        message = self._approval_message(updated, plan_record)
        return ControlResume(
            interaction=updated.to_dict(),
            message=message,
            event={
                "event": "plan_approved",
                "interaction": updated.to_dict(),
                "control": self.payload(),
                **({"plan": plan_record.to_dict()} if plan_record is not None else {}),
                **({"todos": list(self.todo_store.todos)} if self.todo_store is not None else {}),
            },
        )

    def cancel(self, interaction_id: str) -> dict[str, Any]:
        pending = self._require_pending(interaction_id)
        updated = pending.touch(status=InteractionStatus.CANCELLED.value)
        if pending.kind == InteractionKind.PLAN.value:
            self._update_plan_status(updated, PlanStatus.CANCELLED.value)
        if pending.kind == InteractionKind.PLAN.value:
            state = self.store.load()
            state.mode = self._restore_mode(state)
            state.previous_mode = None
            state.pending = None
            state.last_interaction = updated
            state.updated_at = now_ts()
            self.store.save(state)
        else:
            self._complete(updated)
        return {
            "event": "interaction_cancelled",
            "interaction": updated.to_dict(),
            "control": self.payload(),
            "message": self._cancel_message(updated),
        }

    def _complete(self, interaction: Interaction) -> None:
        state = self.store.load()
        state.pending = None
        state.last_interaction = interaction
        state.updated_at = now_ts()
        self.store.save(state)

    def _require_pending(
        self,
        interaction_id: str,
        kind: InteractionKind | None = None,
    ) -> Interaction:
        pending = self.store.load().pending
        if pending is None:
            raise ValueError("no pending interaction")
        if pending.id != str(interaction_id):
            raise ValueError(f"pending interaction mismatch: {pending.id}")
        if kind is not None and pending.kind != kind.value:
            raise ValueError(f"pending interaction is not {kind.value}")
        if pending.status != InteractionStatus.WAITING.value:
            raise ValueError(f"interaction is not waiting: {pending.status}")
        return pending

    def _normalize_answers(self, interaction: Interaction, answers: dict[str, Any]) -> dict[str, Any]:
        if not isinstance(answers, dict):
            raise ValueError("answers must be an object")
        question_ids = {q.id for q in interaction.questions}
        normalized: dict[str, Any] = {}
        for qid, value in answers.items():
            if qid not in question_ids and qid != "_freeform":
                continue
            if isinstance(value, dict):
                normalized[qid] = {
                    "choice": str(value.get("choice") or "").strip(),
                    "freeform": str(value.get("freeform") or "").strip(),
                }
            else:
                normalized[qid] = {"choice": str(value or "").strip(), "freeform": ""}
        if not normalized:
            raise ValueError("at least one answer is required")
        return normalized

    def _answer_message(self, interaction: Interaction) -> str:
        lines = [
            "[CONTROL:ASK_ANSWERED]",
            f"interaction_id: {interaction.id}",
            "用户已回答澄清问题，请结合答案继续推进。",
            "",
        ]
        for question in interaction.questions:
            answer = interaction.answers.get(question.id) or {}
            choice = answer.get("choice") if isinstance(answer, dict) else str(answer)
            freeform = answer.get("freeform") if isinstance(answer, dict) else ""
            lines.append(f"- {question.header}: {question.question}")
            if choice:
                lines.append(f"  answer: {choice}")
            if freeform:
                lines.append(f"  note: {freeform}")
        extra = interaction.answers.get("_freeform")
        if isinstance(extra, dict) and extra.get("freeform"):
            lines.append(f"- additional note: {extra['freeform']}")
        return "\n".join(lines).strip()

    def _comment_message(self, interaction: Interaction, comment: str) -> str:
        return (
            "[CONTROL:PLAN_COMMENT]\n"
            f"interaction_id: {interaction.id}\n"
            "用户对计划提出了评论，请保持 Plan 模式，只修订计划并再次调用 propose_plan。\n\n"
            f"评论：\n{comment.strip()}"
        )

    def _approval_message(self, interaction: Interaction, plan_record: PlanRecord | None = None) -> str:
        lines = [
            "[CONTROL:PLAN_APPROVED]",
            f"interaction_id: {interaction.id}",
        ]
        if plan_record is not None:
            lines.append(f"plan_id: {plan_record.id}")
            lines.append(f"plan_status: {plan_record.status}")
        lines.extend([
            "用户已批准以下计划。现在切换到执行模式，请按计划实施；执行中如出现新的高影响歧义，可再次 ask_user。",
            "",
            f"# {interaction.title}",
            "",
            interaction.plan_markdown,
            "",
            "[PLAN_EXECUTION_CONTRACT]",
            "- Convert the approved plan into todos before editing, and keep the active todo aligned with the active PlanStep.",
            "- Keep exactly one active todo / active PlanStep while executing; move to the next step only after the current step has evidence.",
            "- Before marking a step done, record verification evidence by running declared commands or producing an explicit tool-backed check result.",
            "- If verification failed, keep or mark the step failed, diagnose and repair the failure, rerun verification, then continue.",
            "- If the step is blocked by missing input, access, cost, safety, or unrecoverable ambiguity, call ask_user and keep the step blocked until resolved.",
            "- Do not provide a final answer while any step is pending, active, failed, or blocked.",
        ])
        if plan_record is not None and plan_record.steps:
            lines.extend(["", "[PLAN_STEPS]"])
            for step in plan_record.steps:
                lines.append(f"- {step.id} [{step.status}] {step.title}")
                if step.files:
                    lines.append(f"  files: {'; '.join(step.files[:5])}")
                if step.commands:
                    lines.append(f"  commands: {'; '.join(step.commands[:5])}")
                if step.acceptance:
                    lines.append(f"  acceptance: {'; '.join(step.acceptance[:5])}")
        return "\n".join(lines).strip()

    def _cancel_message(self, interaction: Interaction) -> str:
        return (
            "[CONTROL:INTERACTION_CANCELLED]\n"
            f"interaction_id: {interaction.id}\n"
            f"kind: {interaction.kind}\n"
            "用户取消了这次等待交互。不要继续等待该问题或计划；后续请以用户的新指令为准。"
        )

    def system_prompt(self) -> str:
        if self.mode == ControlMode.PLAN.value:
            return (
                "# Control Mode: Plan\n\n"
                "- 当前处于 Plan 模式。你必须先通过只读探索理解环境，不允许修改文件、运行命令执行变更、派遣子代理或创建队友。\n"
                "- 若需求存在会影响方案的偏好或取舍，调用 `ask_user` 提问。\n"
                "- 当方案足够明确时，必须调用 `propose_plan` 提交完整计划，等待用户评论或批准。\n"
                "- 用户批准前不要执行计划。\n"
                "- 不允许用普通最终回复替代计划卡；最终必须通过 `propose_plan` 进入 PlanCard。"
            )
        return (
            "# Control Tools\n\n"
            f"- 当前权限模式：{self.mode}。\n"
            "- `ask_before_edit` 模式下，危险、不确定或高影响操作会触发权限审批；低风险读操作和普通编辑可继续执行。\n"
            "- `auto` 模式下，工具层不主动审批，但仍受路径安全、schema 校验和工具自身安全策略约束。\n"
            "- 当用户目标存在高影响歧义且无法通过读文件/搜索等方式确定时，调用 `ask_user` 提出结构化问题。\n"
            "- 高影响歧义包括范围/验收不清的大改动、架构/重构/UI 取舍、提交推送、删除覆盖、发布部署、成本/权限/安全边界。\n"
            "- 可通过只读探索确认的事实先探索；但在写入、高影响操作或最终答复前仍有关键取舍时，必须提问。\n"
            "- 只有在用户显式开启 Plan 模式后，才使用 `propose_plan` 提交等待批准的计划。"
        )

    def tool_definitions(self, registry) -> list[dict]:
        return self.policy.filtered_definitions(registry)

    def is_tool_allowed(self, name: str, registry) -> bool:
        return self.policy.is_tool_allowed(name, registry)

    def assess_permission(self, name: str, arguments: dict[str, Any], registry):
        return self.permission_manager.assess(name, arguments, registry=registry)

    def permission_approval_result(self, decision, *, parent_call_id: str | None = None) -> str:
        return self.permission_manager.require_approval(decision, parent_call_id=parent_call_id)

    def sync_plan_from_todos(
        self,
        todos: list[dict[str, Any]],
        *,
        evidence: dict[str, Any] | None = None,
    ) -> PlanRecord | None:
        record = self._latest_executable_plan()
        if record is None or not record.steps:
            return None
        todo_by_step_id = {
            str(item.get("plan_step_id")): item
            for item in todos
            if isinstance(item, dict) and str(item.get("plan_step_id") or "").strip()
        }
        todo_by_index = {
            int(item.get("id")) - 1: item
            for item in todos
            if isinstance(item, dict) and _is_positive_int(item.get("id"))
        }
        now = now_ts()
        steps: list[PlanStep] = []
        for index, step in enumerate(record.steps):
            todo = todo_by_step_id.get(step.id) or todo_by_index.get(index)
            if todo is None:
                steps.append(step)
                continue
            todo_status = str(todo.get("status") or "pending")
            next_status = _plan_status_from_todo(todo_status)
            self._validate_plan_step_transition(step, todo=todo, next_status=next_status)
            step_evidence = list(step.evidence)
            if next_status == PlanStepStatus.DONE.value and step.status != PlanStepStatus.DONE.value:
                step_evidence.append({
                    **(evidence or {}),
                    "todo_id": todo.get("id"),
                    "plan_step_id": todo.get("plan_step_id") or step.id,
                    "todo_status": todo_status,
                    "synced_at": now,
                })
            if next_status == PlanStepStatus.BLOCKED.value and step.status != PlanStepStatus.BLOCKED.value:
                step_evidence.append({
                    **(evidence or {}),
                    "todo_id": todo.get("id"),
                    "plan_step_id": todo.get("plan_step_id") or step.id,
                    "todo_status": todo_status,
                    "blocked_reason": str(todo.get("blocked_reason") or "").strip(),
                    "synced_at": now,
                })
            steps.append(replace(step, status=next_status, evidence=step_evidence))

        plan_status = (
            PlanStatus.COMPLETED.value
            if steps and all(step.status in {PlanStepStatus.DONE.value, PlanStepStatus.SKIPPED.value} for step in steps)
            else PlanStatus.EXECUTING.value
        )
        updated = replace(
            record,
            status=plan_status,
            completed_at=now if plan_status == PlanStatus.COMPLETED.value else record.completed_at,
            updated_at=now,
            steps=steps,
        )
        updated = self._sync_plan_step_tasks(updated)
        self.plan_store.save(updated)
        return updated

    def _validate_plan_step_transition(
        self,
        step: PlanStep,
        *,
        todo: dict[str, Any],
        next_status: str,
    ) -> None:
        if next_status == PlanStepStatus.BLOCKED.value:
            blocked_reason = str(todo.get("blocked_reason") or "").strip()
            if not blocked_reason and not self._has_ask_interaction():
                raise PlanEvidenceError(
                    "PLAN_BLOCKED_REASON_REQUIRED",
                    step_id=step.id,
                    reason="blocked steps must include blocked_reason or be paired with ask_user",
                )
        if next_status != PlanStepStatus.DONE.value or step.status == PlanStepStatus.DONE.value:
            return
        assessment = assess_step_verification(step)
        if assessment.failed_required:
            raise PlanEvidenceError(
                "PLAN_EVIDENCE_FAILED",
                step_id=step.id,
                reason=f"declared verification failed: {'; '.join(assessment.failed_required[:3])}",
            )
        if assessment.blocking_errors:
            raise PlanEvidenceError(
                "PLAN_EVIDENCE_REQUIRED",
                step_id=step.id,
                reason=f"missing passing verification evidence for: {'; '.join(assessment.blocking_errors[:3])}",
            )

    def _has_ask_interaction(self) -> bool:
        state = self.store.load()
        interactions = [state.pending, state.last_interaction]
        return any(item is not None and item.kind == InteractionKind.ASK.value for item in interactions)

    def plan_verification_target(self, command: str) -> dict[str, str] | None:
        return self.verification.plan_verification_target(command)

    def record_plan_discovery(
        self,
        *,
        source: str,
        summary: str,
        files: list[str] | None = None,
        symbols: list[str] | None = None,
        evidence_refs: list[str] | None = None,
    ) -> PlanRecord | None:
        if self.mode != ControlMode.PLAN.value:
            return None
        text = str(summary or "").strip()
        if not text:
            return None
        now = now_ts()
        record = self._ensure_plan_draft()
        discovery = PlanDiscovery(
            id=f"disc_{uuid4().hex[:10]}",
            source=str(source or "tool").strip()[:80],
            summary=text[:1200],
            files=_dedupe_strings(files or []),
            symbols=_dedupe_strings(symbols or []),
            evidence_refs=_dedupe_strings(evidence_refs or []),
            created_at=now,
        ).to_dict()
        discoveries = [*record.draft.discoveries, discovery][-80:]
        draft = replace(
            record.draft,
            discoveries=discoveries,
            relevant_files=_dedupe_strings([*record.draft.relevant_files, *discovery["files"]]),
            last_context_refresh_at=now,
        )
        updated = replace(record, updated_at=now, draft=draft)
        self.plan_store.save(updated)
        return updated

    def record_plan_step_tool_output(
        self,
        *,
        tool_name: str,
        summary: str,
        tool_call_id: str | None = None,
        artifacts: list[dict[str, Any]] | None = None,
        metadata: dict[str, Any] | None = None,
        is_error: bool = False,
    ):
        record, step, task_id = self._active_plan_step_task()
        if record is None or step is None or task_id is None or self.task_manager is None:
            return None
        message = {
            "kind": "tool_output",
            "role": "tool",
            "plan_id": record.id,
            "plan_step_id": step.id,
            "tool_name": str(tool_name or ""),
            "tool_call_id": tool_call_id,
            "content": str(summary or "")[:2000],
            "artifacts": artifacts or [],
            "metadata": metadata or {},
            "is_error": bool(is_error),
        }
        self.task_manager.append_sidechain(task_id, message)
        task = self.task_manager.store.get(task_id)
        progress = dict(task.progress) if task is not None else {}
        progress.update({
            "last_tool": str(tool_name or ""),
            "last_summary": str(summary or "")[:500],
            "last_tool_call_id": tool_call_id,
        })
        return self.task_manager.update_task(task_id, progress=progress)

    def record_plan_verification_result(
        self,
        *,
        plan_id: str,
        step_id: str,
        result: dict[str, Any],
    ) -> PlanRecord | None:
        return self.verification.record_plan_verification_result(
            plan_id=plan_id, step_id=step_id, result=result
        )

    def _sync_plan_step_tasks(self, record: PlanRecord) -> PlanRecord:
        if self.task_manager is None or not record.steps:
            return record
        mapping = dict(record.metadata.get("plan_step_tasks") or {})
        for index, step in enumerate(record.steps, start=1):
            metadata = {
                "plan_id": record.id,
                "plan_step_id": step.id,
                "sequence": index,
                "verification_status": _step_verification_status(step),
            }
            task_id = str(mapping.get(step.id) or "")
            status = _task_status_from_plan_step(step.status)
            if task_id and self.task_manager.store.get(task_id) is not None:
                task = self.task_manager.store.get(task_id)
                progress = dict(task.progress) if task is not None else {}
                progress["verification_status"] = metadata["verification_status"]
                self.task_manager.update_task(
                    task_id,
                    status=status,
                    title=step.title,
                    metadata=metadata,
                    progress=progress,
                )
                continue
            task = self.task_manager.start_task(
                kind=TaskKind.PLAN_STEP.value,
                title=step.title,
                source="plan_step",
                status=status,
                metadata=metadata,
            )
            mapping[step.id] = task.id
        metadata = dict(record.metadata)
        metadata["plan_step_tasks"] = mapping
        return replace(record, metadata=metadata)

    def _active_plan_step_task(self) -> tuple[PlanRecord | None, PlanStep | None, str | None]:
        record = self._latest_executable_plan()
        if record is None:
            return None, None, None
        mapping = record.metadata.get("plan_step_tasks") or {}
        if not isinstance(mapping, dict):
            return record, None, None
        for step in record.steps:
            if step.status != PlanStepStatus.ACTIVE.value:
                continue
            task_id = str(mapping.get(step.id) or "")
            return record, step, task_id or None
        return record, None, None

    def _append_plan_step_verification(
        self,
        record: PlanRecord,
        *,
        step_id: str,
        result: dict[str, Any],
    ) -> None:
        if self.task_manager is None:
            return
        mapping = record.metadata.get("plan_step_tasks") or {}
        if not isinstance(mapping, dict):
            return
        task_id = str(mapping.get(step_id) or "")
        if not task_id:
            return
        passed = result.get("passed")
        verification_status = "passed" if passed is True else "failed" if passed is False else "unknown"
        self.task_manager.append_sidechain(task_id, {
            "kind": "verification",
            "role": "tool",
            "plan_id": record.id,
            "plan_step_id": step_id,
            "tool_name": str(result.get("source") or "run_command"),
            "command": str(result.get("command") or ""),
            "content": str(result.get("summary") or result.get("error") or "")[:2000],
            "passed": passed,
            "result": dict(result),
        })
        task = self.task_manager.store.get(task_id)
        progress = dict(task.progress) if task is not None else {}
        progress["verification_status"] = verification_status
        progress["last_verification"] = dict(result)
        fields: dict[str, Any] = {"progress": progress}
        if passed is False:
            fields["status"] = TaskStatus.FAILED.value
        self.task_manager.update_task(task_id, **fields)

    def _issue_plan_permission_tokens(self, record: PlanRecord) -> PlanRecord:
        return self.permission_tokens.issue(record)

    def consume_plan_permission_token(
        self,
        *,
        tool_name: str,
        arguments: dict[str, Any],
    ) -> PlanPermissionToken | None:
        return self.permission_tokens.consume(tool_name=tool_name, arguments=arguments)

    def revoke_plan_permission_tokens(
        self,
        *,
        plan_id: str | None = None,
        reason: str = "revoked",
    ) -> PlanRecord | None:
        return self.permission_tokens.revoke(plan_id=plan_id, reason=reason)

    def plan_completion_followup(self) -> dict[str, Any] | None:
        return self.verification.plan_completion_followup()

    def record_independent_verification_result(
        self,
        *,
        plan_id: str,
        result: dict[str, Any],
    ) -> PlanRecord | None:
        return self.verification.record_independent_verification_result(plan_id=plan_id, result=result)

    def waive_independent_verification(self, *, plan_id: str, reason: str) -> PlanRecord | None:
        return self.verification.waive_independent_verification(plan_id=plan_id, reason=reason)

    def plan_independent_verification_followup(
        self,
        *,
        dispatch_available: bool = False,
    ) -> dict[str, Any] | None:
        return self.verification.plan_independent_verification_followup(
            dispatch_available=dispatch_available
        )

    def _ensure_plan_draft(self) -> PlanRecord:
        existing = self._latest_draft_plan()
        if existing is not None:
            return existing
        now = now_ts()
        record = PlanRecord(
            id=f"plan_{uuid4().hex[:12]}",
            title="Plan Draft",
            summary="Plan mode draft",
            status=PlanStatus.DRAFT.value,
            created_at=now,
            updated_at=now,
            draft=PlanDraftState(phase=PlanDraftPhase.EXPLORING.value),
            metadata={"risk_level": "medium"},
        )
        self.plan_store.save(record)
        return record

    def _latest_draft_plan(self) -> PlanRecord | None:
        plans = [plan for plan in self.plan_store.list() if plan.status == PlanStatus.DRAFT.value]
        if not plans:
            return None
        return max(plans, key=lambda item: item.updated_at)

    def _plan_record_for_meta(self, meta: dict[str, Any]) -> PlanRecord | None:
        plan_id = str(meta.get("plan_id") or "")
        return self.plan_store.get(plan_id) if plan_id else None

    def _record_plan_open_questions(self, interaction: Interaction) -> None:
        record = self._plan_record_for_meta(interaction.meta)
        if record is None:
            return
        open_questions = list(record.draft.open_questions)
        for question in interaction.questions:
            open_questions.append({
                "interaction_id": interaction.id,
                "id": question.id,
                "header": question.header,
                "question": question.question,
                "options": [option.label for option in question.options],
                "context": interaction.context,
            })
        draft = replace(
            record.draft,
            phase=PlanDraftPhase.QUESTIONING.value,
            open_questions=open_questions,
        )
        self.plan_store.save(replace(record, updated_at=now_ts(), draft=draft))

    def _record_plan_resolved_questions(self, interaction: Interaction) -> None:
        record = self._plan_record_for_meta(interaction.meta)
        if record is None:
            return
        question_ids = {question.id for question in interaction.questions}
        remaining_open = [
            item for item in record.draft.open_questions
            if item.get("interaction_id") != interaction.id or item.get("id") not in question_ids
        ]
        resolved = list(record.draft.resolved_questions)
        open_by_id = {
            str(item.get("id")): item
            for item in record.draft.open_questions
            if item.get("interaction_id") == interaction.id
        }
        for question in interaction.questions:
            answer = interaction.answers.get(question.id) or {}
            choice = answer.get("choice") if isinstance(answer, dict) else str(answer)
            freeform = answer.get("freeform") if isinstance(answer, dict) else ""
            source = open_by_id.get(question.id, {})
            resolved.append({
                "interaction_id": interaction.id,
                "id": question.id,
                "header": question.header,
                "question": question.question,
                "answer": str(choice or "").strip(),
                "freeform": str(freeform or "").strip(),
                "context": str(source.get("context") or interaction.context),
            })
        draft = replace(
            record.draft,
            phase=PlanDraftPhase.DESIGNING.value,
            open_questions=remaining_open,
            resolved_questions=resolved,
        )
        self.plan_store.save(replace(record, updated_at=now_ts(), draft=draft))

    def _record_plan_comment(self, interaction: Interaction, comment: str) -> None:
        record = self._plan_record_for_meta(interaction.meta)
        if record is None:
            return
        metadata = dict(record.metadata)
        revisions = list(metadata.get("revisions") or [])
        revisions.append({
            "title": record.title,
            "summary": record.summary,
            "plan_markdown": record.plan_markdown,
            "comment": comment[:4000],
            "timestamp": now_ts(),
        })
        metadata["revisions"] = revisions[-20:]
        metadata = _metadata_without_plan_permission_tokens(metadata, reason="plan comment")
        draft = replace(record.draft, phase=PlanDraftPhase.REVIEWING.value)
        self.plan_store.save(
            replace(
                record,
                status=PlanStatus.DRAFT.value,
                updated_at=now_ts(),
                draft=draft,
                metadata=metadata,
            )
        )

    def _update_plan_status(self, interaction: Interaction, status: str, *, approved: bool = False) -> None:
        plan_id = str(interaction.meta.get("plan_id") or "")
        if not plan_id:
            return
        record = self.plan_store.get(plan_id)
        if record is None:
            return
        now = now_ts()
        draft = record.draft
        if approved:
            draft = replace(draft, phase=PlanDraftPhase.APPROVED.value)
        payload = {
            **record.to_dict(),
            "status": status,
            "updated_at": now,
            "draft": draft.to_dict(),
        }
        if approved:
            payload["approved_at"] = now
        self.plan_store.save(PlanRecord.from_dict(payload))

    def _activate_approved_plan(self, interaction: Interaction) -> PlanRecord | None:
        plan_id = str(interaction.meta.get("plan_id") or "")
        if not plan_id:
            return None
        record = self.plan_store.get(plan_id)
        if record is None:
            return None
        if self.todo_store is None or not record.steps:
            return record
        activated = PlanExecutionState(record).start_next_step()
        activated = replace(
            activated,
            draft=replace(activated.draft, phase=PlanDraftPhase.EXECUTING.value),
        )
        activated = self._issue_plan_permission_tokens(activated)
        activated = self._sync_plan_step_tasks(activated)
        self.plan_store.save(activated)
        self.todo_store.sync_from_plan_steps([step.to_dict() for step in activated.steps])
        return activated

    def _latest_executable_plan(self) -> PlanRecord | None:
        plans = [
            plan for plan in self.plan_store.list()
            if plan.status in {PlanStatus.APPROVED.value, PlanStatus.EXECUTING.value}
        ]
        if not plans:
            return None
        return max(plans, key=lambda item: item.updated_at)

    def reviewable_plan_id(self) -> str | None:
        record = self._latest_reviewable_plan()
        if record is None or not record.steps or not _plan_steps_finished(record):
            return None
        return record.id

    def _latest_reviewable_plan(self) -> PlanRecord | None:
        plans = [
            plan for plan in self.plan_store.list()
            if plan.status in {
                PlanStatus.APPROVED.value,
                PlanStatus.EXECUTING.value,
                PlanStatus.COMPLETED.value,
            }
        ]
        if not plans:
            return None
        return max(plans, key=lambda item: item.updated_at)

    @staticmethod
    def _restore_mode(state: ControlState) -> str:
        if state.previous_mode in {ControlMode.ASK_BEFORE_EDIT.value, ControlMode.AUTO.value}:
            return state.previous_mode
        return ControlMode.ASK_BEFORE_EDIT.value

    @staticmethod
    def interaction_event(interaction: Interaction) -> dict[str, Any]:
        event = "ask_request" if interaction.kind == InteractionKind.ASK.value else "plan_draft"
        return {"event": event, "interaction": interaction.to_dict()}

    @staticmethod
    def interaction_from_marker(marker: str) -> dict[str, Any] | None:
        try:
            raw = json.loads(marker)
        except json.JSONDecodeError:
            return None
        interaction = raw.get("interaction") if isinstance(raw, dict) else None
        return interaction if isinstance(interaction, dict) else None
