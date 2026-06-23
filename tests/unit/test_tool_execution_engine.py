from __future__ import annotations

from typing import Any

import pytest

from agent.providers.base import ToolCallRequest
from agent.tools.base import Tool, tool_parameters
from agent.tools.execution import ToolExecutionEngine
from agent.tools.registry import ToolRegistry
from agent.tools.results import ToolArtifact, ToolResult

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


@tool_parameters({"type": "object", "properties": {"value": {"type": "string"}}, "required": ["value"]})
class ArtifactEcho(Tool):
    name = "artifact_echo"
    description = "artifact echo"
    read_only = True

    def execute(self, value: str) -> ToolResult:
        return ToolResult(
            model_content=f"model:{value}",
            display_summary=f"summary:{value}",
            artifacts=[
                ToolArtifact(
                    path=f"memory/tool-results/{value}.txt",
                    kind="text",
                    bytes=7,
                    metadata={"source": "engine-test"},
                )
            ],
            metadata={"category": "artifact"},
        )


async def collect(event: dict[str, Any]) -> None:
    EVENTS.append(event)


@pytest.mark.anyio
async def test_engine_returns_tool_messages_in_original_order() -> None:
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

    messages = await engine.run_batch(calls, emit=collect)

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


@pytest.mark.anyio
async def test_engine_uses_model_content_for_tool_message_and_summary_for_runtime() -> None:
    EVENTS.clear()
    registry = ToolRegistry()
    registry.register(ArtifactEcho())
    engine = ToolExecutionEngine(registry)
    calls = [ToolCallRequest(id="1", name="artifact_echo", arguments={"value": "large"})]

    messages = await engine.run_batch(calls, emit=collect)

    assert messages == [
        {
            "role": "tool",
            "tool_call_id": "1",
            "name": "artifact_echo",
            "content": "model:large",
        }
    ]
    completed = [event for event in EVENTS if event["event"] == "tool_run_completed"][0]
    assert completed["summary"] == "summary:large"
    assert completed["artifacts"] == [
        {
            "path": "memory/tool-results/large.txt",
            "kind": "text",
            "bytes": 7,
            "metadata": {"source": "engine-test"},
        }
    ]
    assert completed["metadata"] == {"category": "artifact"}
