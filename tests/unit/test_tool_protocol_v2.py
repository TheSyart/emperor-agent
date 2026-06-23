from __future__ import annotations

from pathlib import Path

from agent.tools.base import Tool, tool_parameters
from agent.tools.context import ToolExecutionContext
from agent.tools.filesystem import ReadFileTool
from agent.tools.protocol import ToolAdapter
from agent.tools.registry import ToolRegistry
from agent.tools.results import ToolArtifact, ToolResult
from agent.tools.search import GlobTool, GrepTool
from agent.tools.shell import RunCommand
from agent.tools.web import WebFetch


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


@tool_parameters({
    "type": "object",
    "properties": {"value": {"type": "string"}},
    "required": ["value"],
})
class BudgetedTool(Tool):
    name = "budgeted"
    description = "budgeted output"
    read_only = True
    max_result_chars = 1234

    def execute(self, value: str) -> str:
        return value


@tool_parameters({
    "type": "object",
    "properties": {"value": {"type": "string"}},
    "required": ["value"],
})
class StructuredResultTool(Tool):
    name = "structured_result"
    description = "structured result"
    read_only = True

    def execute(self, value: str) -> ToolResult:
        return ToolResult(
            model_content=f"model:{value}",
            display_summary=f"summary:{value}",
            raw_content=f"raw:{value}",
            artifacts=[
                ToolArtifact(
                    path=f"memory/tool-results/{value}.txt",
                    kind="text",
                    bytes=42,
                    metadata={"source": "test"},
                )
            ],
            metadata={"kind": "structured"},
        )


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


def test_registry_exposes_tool_result_budgets() -> None:
    registry = ToolRegistry()
    registry.register(EchoPathTool())
    registry.register(BudgetedTool())

    assert registry.tool_result_limits() == {"budgeted": 1234}


def test_registry_execute_result_preserves_structured_tool_result(tmp_path: Path) -> None:
    registry = ToolRegistry()
    registry.register(StructuredResultTool())

    result = registry.execute_result(
        "structured_result",
        {"value": "artifact"},
        root=tmp_path,
        turn_id="turn_1",
        parent_call_id="call_1",
    )

    assert result.model_content == "model:artifact"
    assert result.display_summary == "summary:artifact"
    assert result.raw_content == "raw:artifact"
    assert result.artifacts[0].path == "memory/tool-results/artifact.txt"
    assert result.artifacts[0].metadata == {"source": "test"}
    assert result.metadata == {"kind": "structured"}
    assert registry.execute("structured_result", {"value": "artifact"}) == "model:artifact"


def test_builtin_high_output_tools_define_result_budgets(tmp_path: Path) -> None:
    registry = ToolRegistry()
    registry.register(ReadFileTool(tmp_path))
    registry.register(GrepTool(tmp_path))
    registry.register(GlobTool(tmp_path))
    registry.register(RunCommand(tmp_path))
    registry.register(WebFetch())

    assert registry.tool_result_limits() == {
        "glob": 12_000,
        "grep": 16_000,
        "read_file": 24_000,
        "run_command": 12_000,
        "web_fetch": 10_000,
    }
