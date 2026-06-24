from pathlib import Path

from agent.tools.base import Tool, tool_parameters
from agent.tools.context import ToolExecutionContext
from agent.tools.protocol import ToolAdapter
from agent.tools.registry import ToolRegistry
from agent.tools.results import ToolResult


@tool_parameters({
    "type": "object",
    "properties": {"path": {"type": "string"}},
    "required": ["path"],
})
class EchoPathTool(Tool):
    name = "echo_path"
    description = "echo path"
    read_only = True

    def execute(self, path: str) -> str:
        return f"path={path}"


def test_tool_adapter_wraps_string_result(tmp_path: Path) -> None:
    context = ToolExecutionContext(root=tmp_path, turn_id="turn_1")
    result = ToolAdapter(EchoPathTool()).execute_sync({"path": "a.txt"}, context)

    assert isinstance(result, ToolResult)
    assert result.model_content == "path=a.txt"
    assert result.display_summary == "path=a.txt"


def test_registry_prepare_call_returns_structured_call() -> None:
    registry = ToolRegistry()
    registry.register(EchoPathTool())

    prepared = registry.prepare_call("echo_path", {"path": "a.txt"})

    assert prepared.error is None
    assert prepared.name == "echo_path"
    assert prepared.arguments == {"path": "a.txt"}


def test_invalid_params_do_not_execute_tool() -> None:
    registry = ToolRegistry()
    registry.register(EchoPathTool())

    prepared = registry.prepare_call("echo_path", {})

    assert prepared.error is not None
    assert "missing required field 'path'" in prepared.error
