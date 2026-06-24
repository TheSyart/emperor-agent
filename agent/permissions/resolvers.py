from __future__ import annotations

from dataclasses import dataclass

from .models import PermissionDecision


@dataclass(frozen=True)
class PermissionResolution:
    decision: PermissionDecision
    pause_result: str | None = None


class NonInteractivePermissionResolver:
    def resolve(self, decision: PermissionDecision) -> PermissionResolution:
        if decision.requires_approval:
            denied = PermissionDecision.deny(
                tool_name=decision.tool_name,
                arguments=decision.arguments or {},
                reason=f"permission requires user approval in a non-interactive context: {decision.reason}",
            )
            return PermissionResolution(decision=denied)
        return PermissionResolution(decision=decision)
