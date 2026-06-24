from __future__ import annotations

from dataclasses import dataclass, field

from .verification import VerificationRequirement, requirements_for_step


class PlanEvidenceError(ValueError):
    def __init__(self, code: str, *, step_id: str, reason: str) -> None:
        self.code = code
        self.step_id = step_id
        self.reason = reason
        super().__init__(format_plan_evidence_error(code, step_id=step_id, reason=reason))


def format_plan_evidence_error(code: str, *, step_id: str, reason: str) -> str:
    return "\n".join([
        f"Error: {code}",
        f"step: {step_id}",
        f"reason: {reason}",
        "Repair: keep the step active or blocked; run the declared verification or ask_user before marking it done.",
    ])


@dataclass(frozen=True)
class PlanVerificationAssessment:
    requirements: list[VerificationRequirement] = field(default_factory=list)
    blocking_errors: list[str] = field(default_factory=list)
    risk_notes: list[str] = field(default_factory=list)

    @property
    def failed_required(self) -> list[str]:
        return [item for item in self.blocking_errors if "failed" in item]

    @property
    def missing_required(self) -> list[str]:
        return [item for item in self.blocking_errors if "missing required evidence" in item]


def assess_step_verification(step) -> PlanVerificationAssessment:
    requirements = requirements_for_step(step)
    blocking_errors: list[str] = []
    risk_notes: list[str] = []
    for requirement in requirements:
        if requirement.status == "skipped":
            if not requirement.reason:
                blocking_errors.append(f"{requirement.id} skipped without reason")
            else:
                risk_notes.append(f"{requirement.id} skipped: {requirement.reason}")
            continue
        if requirement.required:
            if requirement.status == "failed":
                blocking_errors.append(f"{requirement.id} failed: {_requirement_detail(requirement)}")
            elif requirement.status != "passed":
                blocking_errors.append(f"{requirement.id} missing required evidence")
            continue
        if requirement.status == "failed":
            risk_notes.append(f"{requirement.id} failed: {_requirement_detail(requirement)}")
    return PlanVerificationAssessment(
        requirements=requirements,
        blocking_errors=blocking_errors,
        risk_notes=risk_notes,
    )


def _requirement_detail(requirement: VerificationRequirement) -> str:
    return requirement.reason or requirement.description or requirement.command or requirement.kind
