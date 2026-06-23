from __future__ import annotations


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
