from __future__ import annotations

from dataclasses import asdict, dataclass, field
from enum import StrEnum
from typing import Any

from .verification import VerificationRequirement


class PlanStatus(StrEnum):
    DRAFT = "draft"
    WAITING_APPROVAL = "waiting_approval"
    APPROVED = "approved"
    EXECUTING = "executing"
    COMPLETED = "completed"
    FAILED = "failed"
    CANCELLED = "cancelled"


class PlanStepStatus(StrEnum):
    PENDING = "pending"
    ACTIVE = "active"
    DONE = "done"
    FAILED = "failed"
    BLOCKED = "blocked"
    SKIPPED = "skipped"


class PlanDraftPhase(StrEnum):
    EXPLORING = "exploring"
    QUESTIONING = "questioning"
    DESIGNING = "designing"
    REVIEWING = "reviewing"
    READY_FOR_APPROVAL = "ready_for_approval"
    APPROVED = "approved"
    EXECUTING = "executing"


def _valid_value(value: Any, allowed: set[str], fallback: str) -> str:
    text = str(value or "").strip()
    return text if text in allowed else fallback


def _string_list(value: Any, *, limit: int = 120) -> list[str]:
    if not isinstance(value, list):
        return []
    result: list[str] = []
    for item in value[:limit]:
        text = str(item or "").strip()
        if text:
            result.append(text)
    return result


def _dict_list(value: Any, *, limit: int = 120) -> list[dict[str, Any]]:
    if not isinstance(value, list):
        return []
    return [dict(item) for item in value[:limit] if isinstance(item, dict)]


def _optional_float(value: Any) -> float | None:
    if value is None:
        return None
    try:
        return float(value)
    except (TypeError, ValueError):
        return None


@dataclass(frozen=True)
class PlanDiscovery:
    id: str
    source: str
    summary: str
    files: list[str] = field(default_factory=list)
    symbols: list[str] = field(default_factory=list)
    evidence_refs: list[str] = field(default_factory=list)
    created_at: float = 0.0

    def to_dict(self) -> dict[str, Any]:
        return asdict(self)

    @classmethod
    def from_dict(cls, raw: dict[str, Any]) -> PlanDiscovery:
        return cls(
            id=str(raw.get("id") or ""),
            source=str(raw.get("source") or "").strip()[:80],
            summary=str(raw.get("summary") or "").strip()[:1200],
            files=_string_list(raw.get("files") or _legacy_discovery_files(raw)),
            symbols=_string_list(raw.get("symbols")),
            evidence_refs=_string_list(raw.get("evidence_refs") or raw.get("evidenceRefs")),
            created_at=float(raw.get("created_at") or raw.get("createdAt") or 0.0),
        )


@dataclass(frozen=True)
class PlanDraftState:
    phase: str = PlanDraftPhase.EXPLORING.value
    discoveries: list[dict[str, Any]] = field(default_factory=list)
    relevant_files: list[str] = field(default_factory=list)
    open_questions: list[dict[str, Any]] = field(default_factory=list)
    resolved_questions: list[dict[str, Any]] = field(default_factory=list)
    alternatives_considered: list[str] = field(default_factory=list)
    recommended_approach: str = ""
    verification_strategy: list[str] = field(default_factory=list)
    last_context_refresh_at: float | None = None

    def to_dict(self) -> dict[str, Any]:
        return asdict(self)

    @classmethod
    def from_dict(cls, raw: dict[str, Any] | None) -> PlanDraftState:
        if not isinstance(raw, dict):
            return cls()
        refresh = raw.get("last_context_refresh_at")
        return cls(
            phase=_valid_value(
                raw.get("phase"),
                {item.value for item in PlanDraftPhase},
                PlanDraftPhase.EXPLORING.value,
            ),
            discoveries=_dict_list(raw.get("discoveries")),
            relevant_files=_string_list(raw.get("relevant_files")),
            open_questions=_dict_list(raw.get("open_questions")),
            resolved_questions=_dict_list(raw.get("resolved_questions")),
            alternatives_considered=_string_list(raw.get("alternatives_considered")),
            recommended_approach=str(raw.get("recommended_approach") or "").strip()[:1200],
            verification_strategy=_string_list(raw.get("verification_strategy")),
            last_context_refresh_at=_optional_float(refresh),
        )


@dataclass(frozen=True)
class PlanStep:
    id: str
    title: str
    status: str = PlanStepStatus.PENDING.value
    description: str = ""
    files: list[str] = field(default_factory=list)
    commands: list[str] = field(default_factory=list)
    acceptance: list[str] = field(default_factory=list)
    discovery_refs: list[str] = field(default_factory=list)
    verification: list[VerificationRequirement] = field(default_factory=list)
    evidence: list[dict[str, Any]] = field(default_factory=list)
    risk: str = "medium"
    risk_note: str = ""
    rollback: str = ""

    def to_dict(self) -> dict[str, Any]:
        return asdict(self)

    @classmethod
    def from_dict(cls, raw: dict[str, Any]) -> PlanStep:
        return cls(
            id=str(raw["id"]),
            title=str(raw["title"]),
            status=_valid_value(
                raw.get("status"),
                {item.value for item in PlanStepStatus},
                PlanStepStatus.PENDING.value,
            ),
            description=str(raw.get("description") or ""),
            files=[str(item) for item in raw.get("files") or []],
            commands=[str(item) for item in raw.get("commands") or []],
            acceptance=[str(item) for item in raw.get("acceptance") or []],
            discovery_refs=[
                str(item)
                for item in raw.get("discovery_refs") or raw.get("discoveryRefs") or []
                if str(item or "").strip()
            ],
            verification=[
                item if isinstance(item, VerificationRequirement) else VerificationRequirement.from_dict(item)
                for item in raw.get("verification") or raw.get("verification_requirements") or []
                if isinstance(item, (VerificationRequirement, dict))
            ],
            evidence=[item for item in raw.get("evidence") or [] if isinstance(item, dict)],
            risk=str(raw.get("risk") or "medium"),
            risk_note=str(raw.get("risk_note") or raw.get("riskNote") or ""),
            rollback=str(raw.get("rollback") or raw.get("rollback_path") or raw.get("rollbackPath") or ""),
        )


def _legacy_discovery_files(raw: dict[str, Any]) -> list[str]:
    files: list[str] = []
    for key in ("path", "file"):
        value = str(raw.get(key) or "").strip()
        if value:
            files.append(value)
    return files


@dataclass(frozen=True)
class PlanRecord:
    id: str
    title: str
    summary: str
    status: str
    created_at: float
    updated_at: float
    source_interaction_id: str | None = None
    approved_at: float | None = None
    completed_at: float | None = None
    plan_markdown: str = ""
    assumptions: list[str] = field(default_factory=list)
    steps: list[PlanStep] = field(default_factory=list)
    verification: list[dict[str, Any]] = field(default_factory=list)
    draft: PlanDraftState = field(default_factory=PlanDraftState)
    metadata: dict[str, Any] = field(default_factory=dict)

    def to_dict(self) -> dict[str, Any]:
        payload = asdict(self)
        payload["steps"] = [step.to_dict() for step in self.steps]
        payload["draft"] = self.draft.to_dict()
        return payload

    @classmethod
    def from_dict(cls, raw: dict[str, Any]) -> PlanRecord:
        metadata = dict(raw.get("metadata") or {})
        return cls(
            id=str(raw["id"]),
            title=str(raw["title"]),
            summary=str(raw["summary"]),
            status=_valid_value(raw.get("status"), {item.value for item in PlanStatus}, PlanStatus.DRAFT.value),
            created_at=float(raw["created_at"]),
            updated_at=float(raw["updated_at"]),
            source_interaction_id=raw.get("source_interaction_id"),
            approved_at=raw.get("approved_at"),
            completed_at=raw.get("completed_at"),
            plan_markdown=str(raw.get("plan_markdown") or ""),
            assumptions=[str(item) for item in raw.get("assumptions") or []],
            steps=[PlanStep.from_dict(item) for item in raw.get("steps") or [] if isinstance(item, dict)],
            verification=[item for item in raw.get("verification") or [] if isinstance(item, dict)],
            draft=PlanDraftState.from_dict(raw.get("draft") or metadata.get("draft")),
            metadata=metadata,
        )
