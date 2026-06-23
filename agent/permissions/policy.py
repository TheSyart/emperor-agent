from __future__ import annotations

from typing import Any

from .models import PermissionDecision
from .pipeline import PermissionPipeline


class PermissionPolicy:
    """Backward-compatible facade over PermissionPipeline."""

    def __init__(self, pipeline: PermissionPipeline | None = None) -> None:
        self.pipeline = pipeline or PermissionPipeline()

    def assess(
        self,
        tool_name: str,
        arguments: dict[str, Any] | None,
        mode: str,
        *,
        registry=None,
    ) -> PermissionDecision:
        return self.pipeline.assess(tool_name, arguments, mode, registry=registry)

    def is_tool_exposed(self, tool_name: str, mode: str, *, registry=None) -> bool:
        return self.pipeline.is_tool_exposed(tool_name, mode, registry=registry)
