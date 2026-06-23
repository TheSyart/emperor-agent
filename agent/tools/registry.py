from __future__ import annotations

from typing import Any

from loguru import logger

from .base import Tool
from .protocol import PreparedToolCall
from .results import ToolResult


class ToolRegistry:
    _HINT = "[Analyze the error above and try a different approach.]"

    def __init__(self):
        self._tools: dict[str, Tool] = {}
        self._defs_cache: list[dict] | None = None

    def register(self, tool: Tool) -> None:
        self._tools[tool.name] = tool
        self._defs_cache = None

    def unregister(self, name: str) -> None:
        if name in self._tools:
            del self._tools[name]
            self._defs_cache = None

    def get(self, name: str) -> Tool | None:
        return self._tools.get(name)

    def names(self) -> list[str]:
        return sorted(self._tools.keys())

    def tool_result_limits(self) -> dict[str, int]:
        limits: dict[str, int] = {}
        for name, tool in self._tools.items():
            value = getattr(tool, "max_result_chars", None)
            if isinstance(value, int) and value > 0:
                limits[name] = value
        return limits

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

    def prepare_call(self, name: str, params: Any) -> PreparedToolCall:
        if not isinstance(params, dict):
            return PreparedToolCall(
                name=name,
                arguments={},
                error=f"Error: tool '{name}' received non-object params: {type(params).__name__}",
            )
        tool = self._tools.get(name)
        if tool is None:
            return PreparedToolCall(
                name=name,
                arguments=params,
                error=f"Error: Unknown tool '{name}'. Available: {', '.join(self.names())}",
            )
        try:
            cast = tool.cast_params(params)
            tool.validate_params(cast)
        except (ValueError, TypeError) as e:
            return PreparedToolCall(
                name=name,
                arguments=params,
                tool=tool,
                error=f"Error: invalid params for '{name}': {e}",
            )
        return PreparedToolCall(name=name, arguments=cast, tool=tool, error=None)

    def unregister_mcp_tools(self) -> None:
        """移除所有 mcp_ 前缀的工具（用于重连时刷新）。"""
        mcp_names = [name for name in self._tools if name.startswith("mcp_")]
        for name in mcp_names:
            del self._tools[name]
        if mcp_names:
            self._defs_cache = None

    def execute(self, name: str, params: Any, emit=None, loop=None, parent_call_id=None) -> str:
        prepared = self.prepare_call(name, params)
        if prepared.error:
            return f"{prepared.error}\n{self._HINT}"
        tool = prepared.tool
        cast = prepared.arguments
        try:
            if getattr(tool, "requires_runtime_context", False):
                result = tool.execute(**cast, emit=emit, loop=loop, parent_call_id=parent_call_id)
            else:
                result = tool.execute(**cast)
            if isinstance(result, ToolResult):
                return result.model_content
            if isinstance(result, str) and result.startswith("Error"):
                return f"{result}\n{self._HINT}"
            return result
        except Exception as e:
            logger.warning(f"Tool execution error: {name}: {e}")
            return f"Error executing {name}: {e}\n{self._HINT}"
