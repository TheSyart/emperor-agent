from __future__ import annotations

from ..permissions import PermissionPipeline
from .models import ControlMode

CONTROL_TOOL_NAMES = {"ask_user", "propose_plan"}


class ControlPolicy:
    def __init__(self, manager):
        self.manager = manager
        self.permission_pipeline = PermissionPipeline()

    def is_tool_allowed(self, name: str, registry) -> bool:
        return self.permission_pipeline.is_tool_exposed(name, self.manager.mode, registry=registry)

    def filtered_definitions(self, registry) -> list[dict]:
        definitions = registry.get_definitions()
        if self.manager.mode != ControlMode.PLAN.value:
            return [item for item in definitions if item.get("name") != "propose_plan"]
        return [item for item in definitions if self.is_tool_allowed(str(item.get("name") or ""), registry)]
