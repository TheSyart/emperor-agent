from __future__ import annotations

import hashlib
import json
from dataclasses import asdict, dataclass, field
from enum import StrEnum
from typing import Any


class PermissionMode(StrEnum):
    ASK_BEFORE_EDIT = "ask_before_edit"
    AUTO = "auto"
    PLAN = "plan"


class RiskLevel(StrEnum):
    LOW = "low"
    MEDIUM = "medium"
    HIGH = "high"


@dataclass(frozen=True)
class PermissionTraceEntry:
    rule: str
    outcome: str
    detail: str = ""


@dataclass(frozen=True)
class ToolPermissionProfile:
    name: str
    arguments: dict[str, Any]
    read_only: bool = False
    concurrency_safe: bool = False
    destructive: bool = True
    path: str | None = None
    command: str = ""
    scheduler_action: str = ""


@dataclass(frozen=True)
class PlanPermissionToken:
    plan_id: str
    step_id: str
    tool_name: str
    argument_hash: str
    expires_at: float
    uses_remaining: int
    reason: str

    def to_dict(self) -> dict[str, Any]:
        return asdict(self)

    @classmethod
    def from_dict(cls, raw: dict[str, Any]) -> PlanPermissionToken:
        return cls(
            plan_id=str(raw.get("plan_id") or raw.get("planId") or ""),
            step_id=str(raw.get("step_id") or raw.get("stepId") or ""),
            tool_name=str(raw.get("tool_name") or raw.get("toolName") or ""),
            argument_hash=str(raw.get("argument_hash") or raw.get("argumentHash") or ""),
            expires_at=float(raw.get("expires_at") or raw.get("expiresAt") or 0.0),
            uses_remaining=max(0, int(raw.get("uses_remaining") or raw.get("usesRemaining") or 0)),
            reason=str(raw.get("reason") or ""),
        )


@dataclass(frozen=True)
class PermissionDecision:
    allowed: bool
    requires_approval: bool = False
    risk: str = RiskLevel.LOW.value
    reason: str = ""
    tool_name: str = ""
    arguments: dict[str, Any] | None = None
    rule: str = ""
    trace: tuple[PermissionTraceEntry, ...] = field(default_factory=tuple)

    @classmethod
    def allow(
        cls,
        *,
        tool_name: str,
        arguments: dict[str, Any] | None = None,
        rule: str = "",
        trace: tuple[PermissionTraceEntry, ...] = (),
    ) -> PermissionDecision:
        return cls(allowed=True, tool_name=tool_name, arguments=arguments or {}, rule=rule, trace=trace)

    @classmethod
    def deny(
        cls,
        *,
        tool_name: str,
        reason: str,
        arguments: dict[str, Any] | None = None,
        rule: str = "",
        trace: tuple[PermissionTraceEntry, ...] = (),
    ) -> PermissionDecision:
        return cls(
            allowed=False,
            risk=RiskLevel.HIGH.value,
            reason=reason,
            tool_name=tool_name,
            arguments=arguments or {},
            rule=rule,
            trace=trace,
        )

    @classmethod
    def approval(
        cls,
        *,
        tool_name: str,
        reason: str,
        arguments: dict[str, Any] | None = None,
        risk: str = RiskLevel.HIGH.value,
        rule: str = "",
        trace: tuple[PermissionTraceEntry, ...] = (),
    ) -> PermissionDecision:
        return cls(
            allowed=False,
            requires_approval=True,
            risk=risk,
            reason=reason,
            tool_name=tool_name,
            arguments=arguments or {},
            rule=rule,
            trace=trace,
        )


def permission_argument_hash(arguments: dict[str, Any]) -> str:
    try:
        encoded = json.dumps(arguments or {}, ensure_ascii=False, sort_keys=True, separators=(",", ":"))
    except (TypeError, ValueError):
        encoded = json.dumps(_json_safe(arguments or {}), ensure_ascii=False, sort_keys=True, separators=(",", ":"))
    return hashlib.sha256(encoded.encode("utf-8")).hexdigest()


def _json_safe(value: Any) -> Any:
    if isinstance(value, dict):
        return {str(key): _json_safe(item) for key, item in value.items()}
    if isinstance(value, list):
        return [_json_safe(item) for item in value]
    if isinstance(value, (str, int, float, bool)) or value is None:
        return value
    return str(value)
