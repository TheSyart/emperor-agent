from __future__ import annotations

from typing import Any

from .models import PermissionDecision
from .policy import PermissionPolicy


class PermissionPipeline:
    def __init__(self, policy: PermissionPolicy | None = None) -> None:
        self.policy = policy or PermissionPolicy()

    def assess(
        self,
        tool_name: str,
        arguments: dict[str, Any] | None,
        *,
        mode: str,
        registry=None,
        non_interactive: bool = False,
    ) -> PermissionDecision:
        args = arguments or {}
        tool = registry.get(tool_name) if registry is not None else None
        check_permissions = getattr(tool, "check_permissions", None)
        if callable(check_permissions):
            tool_decision = check_permissions(args)
            if isinstance(tool_decision, PermissionDecision) and not tool_decision.allowed:
                return tool_decision
        decision = self.policy.assess(tool_name, args, mode, registry=registry)
        if non_interactive and decision.requires_approval:
            return PermissionDecision.deny(
                tool_name=tool_name,
                arguments=args,
                reason=f"non-interactive permission resolver cannot ask: {decision.reason}",
            )
        return decision
