from __future__ import annotations

from dataclasses import dataclass

from .models import PlanDraftState, PlanStep


@dataclass(frozen=True)
class PlanQualityResult:
    ok: bool
    errors: list[str]


class PlanQualityError(ValueError):
    def __init__(self, errors: list[str]) -> None:
        self.errors = list(errors)
        super().__init__(format_plan_quality_error(errors))


class PlanQualityGate:
    """Rejects weak plans before they become approval cards."""

    def assess(
        self,
        *,
        steps: list[PlanStep],
        draft: PlanDraftState,
    ) -> PlanQualityResult:
        errors: list[str] = []
        if not steps:
            errors.append("plan has no structured steps")
            return PlanQualityResult(ok=False, errors=errors)

        discovery_ids = {
            str(item.get("id") or "").strip()
            for item in draft.discoveries
            if isinstance(item, dict) and str(item.get("id") or "").strip()
        }
        has_draft_verification = bool(draft.verification_strategy)
        for step in steps:
            errors.extend(_assess_step(
                step,
                discovery_ids=discovery_ids,
                has_draft_verification=has_draft_verification,
            ))
        return PlanQualityResult(ok=not errors, errors=errors)

    def require_ok(self, *, steps: list[PlanStep], draft: PlanDraftState) -> None:
        result = self.assess(steps=steps, draft=draft)
        if not result.ok:
            raise PlanQualityError(result.errors)


def format_plan_quality_error(errors: list[str]) -> str:
    lines = ["Error: plan quality gate failed"]
    lines.extend(f"- {error}" for error in errors)
    return "\n".join(lines)


def _assess_step(
    step: PlanStep,
    *,
    discovery_ids: set[str],
    has_draft_verification: bool,
) -> list[str]:
    sid = step.id
    errors: list[str] = []
    if not _has_scope(step, discovery_ids=discovery_ids):
        errors.append(f"{sid} has no target files, discovery reference, or concrete scope")
    unknown_refs = [
        ref for ref in step.discovery_refs
        if discovery_ids and ref not in discovery_ids
    ]
    if unknown_refs:
        errors.append(f"{sid} references unknown discoveries: {', '.join(unknown_refs[:3])}")
    if _has_generic_title(step):
        errors.append(f"{sid} title is too generic; add concrete acceptance")
    if not _has_verification(step, has_draft_verification=has_draft_verification):
        errors.append(f"{sid} has no verification command or manual verification rule")
    if step.risk.strip().lower() == "high":
        if not step.risk_note.strip():
            errors.append(f"{sid} is high risk but has no risk note")
        if not step.rollback.strip():
            errors.append(f"{sid} is high risk but has no rollback path")
    return errors


def _has_scope(step: PlanStep, *, discovery_ids: set[str]) -> bool:
    if step.files:
        return True
    if step.discovery_refs and (not discovery_ids or any(ref in discovery_ids for ref in step.discovery_refs)):
        return True
    if step.acceptance:
        return True
    return len(step.description.strip()) >= 24


def _has_generic_title(step: PlanStep) -> bool:
    title = " ".join(step.title.lower().strip().split())
    generic_titles = {
        "fix issue",
        "fix bug",
        "improve code",
        "update code",
        "make changes",
        "implement",
        "refactor",
        "修复问题",
        "优化代码",
        "改进代码",
    }
    return title in generic_titles and not step.acceptance


def _has_verification(step: PlanStep, *, has_draft_verification: bool) -> bool:
    return bool(step.commands or step.acceptance or has_draft_verification)
