from __future__ import annotations

from dataclasses import dataclass
from typing import Any, Protocol

from .context import ToolExecutionContext
from .results import ToolResult


@dataclass(frozen=True)
class PreparedToolCall:
    name: str
    arguments: dict[str, Any]
    tool: Any | None = None
    error: str | None = None


class ToolV2(Protocol):
    name: str
    description: str
    parameters: dict

    def is_read_only(self, arguments: dict[str, Any]) -> bool:
        raise NotImplementedError

    def is_concurrency_safe(self, arguments: dict[str, Any]) -> bool:
        raise NotImplementedError

    def validate_input(self, arguments: dict[str, Any], context: ToolExecutionContext) -> str | None:
        raise NotImplementedError

    def check_permissions(self, arguments: dict[str, Any], context: ToolExecutionContext) -> Any:
        raise NotImplementedError

    def map_result(self, result: Any, context: ToolExecutionContext) -> ToolResult:
        raise NotImplementedError

    def execute_v2(self, arguments: dict[str, Any], context: ToolExecutionContext) -> ToolResult:
        raise NotImplementedError


class ToolAdapter:
    def __init__(self, tool: Any) -> None:
        self.tool = tool

    def is_read_only(self, arguments: dict[str, Any]) -> bool:
        method = getattr(self.tool, "is_read_only", None)
        if callable(method):
            return bool(method(arguments))
        return bool(getattr(self.tool, "read_only", False))

    def is_concurrency_safe(self, arguments: dict[str, Any]) -> bool:
        method = getattr(self.tool, "is_concurrency_safe", None)
        if callable(method):
            return bool(method(arguments))
        return bool(getattr(self.tool, "concurrency_safe", False))

    def execute_sync(self, arguments: dict[str, Any], context: ToolExecutionContext) -> ToolResult:
        validate_input = getattr(self.tool, "validate_input", None)
        if callable(validate_input):
            validation_error = validate_input(arguments, context)
            if validation_error:
                return ToolResult.from_text(f"Error: {validation_error}", is_error=True)
        result = self.tool.execute(**arguments)
        map_result = getattr(self.tool, "map_result", None)
        if callable(map_result):
            mapped = map_result(result, context)
            if isinstance(mapped, ToolResult):
                return mapped
        if isinstance(result, ToolResult):
            return result
        return ToolResult.from_text(str(result), is_error=str(result).startswith("Error"))
