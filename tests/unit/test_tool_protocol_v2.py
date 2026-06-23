from __future__ import annotations

from pathlib import Path

from agent.tools.base import Tool, tool_parameters
from agent.tools.context import ToolExecutionContext
from agent.tools.filesystem import EditFileTool, ReadFileTool, WriteFileTool
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


def test_read_file_execute_result_adds_source_artifact_metadata(tmp_path: Path) -> None:
    source = tmp_path / "app.py"
    source.write_text("def main():\n    return 1\nprint(main())\n", encoding="utf-8")
    registry = ToolRegistry()
    registry.register(ReadFileTool(tmp_path))

    result = registry.execute_result("read_file", {"path": "app.py", "offset": 1, "limit": 2})

    assert result.model_content.startswith("1| def main():")
    assert result.display_summary == "read_file app.py lines 1-2 of 3"
    assert result.raw_content == result.model_content
    assert result.artifacts[0].path == "app.py"
    assert result.artifacts[0].kind == "source_file"
    assert result.metadata == {
        "tool": "read_file",
        "path": "app.py",
        "line_start": 1,
        "line_end": 2,
        "total_lines": 3,
        "truncated": True,
    }


def test_grep_execute_result_adds_search_metadata(tmp_path: Path) -> None:
    (tmp_path / "a.py").write_text("needle = 1\n", encoding="utf-8")
    (tmp_path / "b.py").write_text("other = 2\n", encoding="utf-8")
    registry = ToolRegistry()
    registry.register(GrepTool(tmp_path))

    result = registry.execute_result(
        "grep",
        {"pattern": "needle", "path": ".", "type": "py", "output_mode": "files_with_matches"},
    )

    assert result.model_content == "a.py"
    assert result.display_summary == "grep 'needle' matched 1 file in ."
    assert result.metadata == {
        "tool": "grep",
        "pattern": "needle",
        "path": ".",
        "output_mode": "files_with_matches",
        "matched_files": 1,
        "result_lines": 1,
        "truncated": False,
    }


def test_run_command_execute_result_adds_command_metadata(tmp_path: Path) -> None:
    registry = ToolRegistry()
    registry.register(RunCommand(tmp_path))

    result = registry.execute_result("run_command", {"command": "printf ok"})

    assert result.model_content == "ok"
    assert result.display_summary == "run_command exit 0: printf ok"
    assert result.raw_content == "ok"
    assert result.metadata == {
        "tool": "run_command",
        "command": "printf ok",
        "exit_code": 0,
        "timed_out": False,
        "truncated": False,
    }


def test_write_file_execute_result_adds_file_artifact_and_diff_metadata(tmp_path: Path) -> None:
    registry = ToolRegistry()
    registry.register(WriteFileTool(tmp_path))

    result = registry.execute_result(
        "write_file",
        {"path": "generated.py", "content": "print('ok')\n"},
    )

    assert result.model_content.startswith("Successfully wrote 12 characters")
    assert result.display_summary == "write_file generated.py (12 chars)"
    assert result.artifacts[0].path == "generated.py"
    assert result.artifacts[0].kind == "source_file"
    assert result.metadata["tool"] == "write_file"
    assert result.metadata["path"] == "generated.py"
    assert result.metadata["content_chars"] == 12
    assert result.metadata["content_bytes"] == 12
    assert result.metadata["diff"].startswith("--- /dev/null\n+++ generated.py\n")
    assert "+print('ok')" in result.metadata["diff"]
    assert (tmp_path / "generated.py").read_text(encoding="utf-8") == "print('ok')\n"


def test_edit_file_execute_result_adds_file_artifact_and_diff_metadata(tmp_path: Path) -> None:
    target = tmp_path / "app.py"
    target.write_text("value = 1\nprint(value)\n", encoding="utf-8")
    registry = ToolRegistry()
    registry.register(EditFileTool(tmp_path))

    result = registry.execute_result(
        "edit_file",
        {
            "path": "app.py",
            "old_text": "value = 1",
            "new_text": "value = 2",
        },
    )

    assert result.model_content.startswith("Successfully edited")
    assert result.display_summary == "edit_file app.py (1 replacement)"
    assert result.artifacts[0].path == "app.py"
    assert result.artifacts[0].kind == "source_file"
    assert result.metadata["tool"] == "edit_file"
    assert result.metadata["path"] == "app.py"
    assert result.metadata["replacements"] == 1
    assert result.metadata["replace_all"] is False
    assert result.metadata["diff"].startswith("--- app.py (before)\n+++ app.py (after)\n")
    assert "-value = 1" in result.metadata["diff"]
    assert "+value = 2" in result.metadata["diff"]
    assert target.read_text(encoding="utf-8") == "value = 2\nprint(value)\n"
