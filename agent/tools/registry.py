from __future__ import annotations
from typing import Any
from .base import Tool


class ToolRegistry:
    _HINT = "[Analyze the error above and try a different approach.]"

    def __init__(self):
        self._tools: dict[str, Tool] = {}
        self._defs_cache: list[dict] | None = None

    def register(self, tool: Tool) -> None:
        self._tools[tool.name] = tool
        self._defs_cache = None

    def get(self, name: str) -> Tool | None:
        return self._tools.get(name)

    def names(self) -> list[str]:
        return sorted(self._tools.keys())

    def get_definitions(self) -> list[dict]:
        if self._defs_cache is not None:
            return self._defs_cache
        builtin, mcp = [], []
        for name in sorted(self._tools.keys()):
            tool = self._tools[name]
            entry = {
                "name": tool.name,
                "description": tool.description,
                "input_schema": tool.parameters,
            }
            (mcp if name.startswith("mcp_") else builtin).append(entry)
        self._defs_cache = builtin + mcp
        return self._defs_cache

    def prepare_call(self, name: str, params: Any):
        if not isinstance(params, dict):
            return None, None, (
                f"Error: tool '{name}' received non-object params: "
                f"{type(params).__name__}"
            )
        tool = self._tools.get(name)
        if tool is None:
            return None, None, (
                f"Error: Unknown tool '{name}'. Available: {', '.join(self.names())}"
            )
        try:
            cast = tool.cast_params(params)
            tool.validate_params(cast)
        except (ValueError, TypeError) as e:
            return tool, None, f"Error: invalid params for '{name}': {e}"
        return tool, cast, None

    def execute(self, name: str, params: Any) -> str:
        tool, cast, err = self.prepare_call(name, params)
        if err:
            return f"{err}\n{self._HINT}"
        try:
            result = tool.execute(**cast)
            if isinstance(result, str) and result.startswith("Error"):
                return f"{result}\n{self._HINT}"
            return result
        except Exception as e:
            return f"Error executing {name}: {e}\n{self._HINT}"
