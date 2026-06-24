import asyncio
from typing import Any

from agent.providers.base import ToolCallRequest
from agent.tools.base import Tool, tool_parameters
from agent.tools.execution import ToolExecutionEngine
from agent.tools.registry import ToolRegistry

EVENTS: list[dict[str, Any]] = []


@tool_parameters({"type": "object", "properties": {"value": {"type": "string"}}, "required": ["value"]})
class ReadOnlyEcho(Tool):
    name = "read_echo"
    description = "read echo"
    read_only = True

    def execute(self, value: str) -> str:
        return f"read:{value}"


@tool_parameters({"type": "object", "properties": {"value": {"type": "string"}}, "required": ["value"]})
class WriteEcho(Tool):
    name = "write_echo"
    description = "write echo"
    exclusive = True

    def execute(self, value: str) -> str:
        return f"write:{value}"


async def collect(event: dict[str, Any]) -> None:
    EVENTS.append(event)


def test_engine_returns_tool_messages_in_original_order() -> None:
    messages = asyncio.run(_run_engine_order_case())

    assert [message["tool_call_id"] for message in messages] == ["1", "2", "3"]
    assert [message["content"] for message in messages] == ["read:a", "write:b", "read:c"]
    assert [event["event"] for event in EVENTS if event["event"].startswith("tool_run_")] == [
        "tool_run_queued",
        "tool_run_queued",
        "tool_run_queued",
        "tool_run_started",
        "tool_run_completed",
        "tool_run_started",
        "tool_run_completed",
        "tool_run_started",
        "tool_run_completed",
    ]


async def _run_engine_order_case() -> list[dict[str, Any]]:
    EVENTS.clear()
    registry = ToolRegistry()
    registry.register(ReadOnlyEcho())
    registry.register(WriteEcho())
    engine = ToolExecutionEngine(registry)
    calls = [
        ToolCallRequest(id="1", name="read_echo", arguments={"value": "a"}),
        ToolCallRequest(id="2", name="write_echo", arguments={"value": "b"}),
        ToolCallRequest(id="3", name="read_echo", arguments={"value": "c"}),
    ]

    return await engine.run_batch(calls, emit=collect)
