from __future__ import annotations

from agent.context_pipeline.pipeline import ContextPipeline
from agent.context_pipeline.tool_results import ToolResultStore


def test_context_pipeline_repairs_missing_tool_result() -> None:
    history = [
        {"role": "user", "content": "inspect"},
        {
            "role": "assistant",
            "content": "",
            "tool_calls": [
                {
                    "id": "call_1",
                    "type": "function",
                    "function": {"name": "read_file", "arguments": "{}"},
                }
            ],
        },
    ]

    projection = ContextPipeline().project(history)

    assert projection.messages[-1]["role"] == "tool"
    assert projection.messages[-1]["tool_call_id"] == "call_1"
    assert projection.report["paired_missing_tool_results"] == 1


def test_context_pipeline_caps_large_tool_result() -> None:
    history = [
        {
            "role": "assistant",
            "content": "",
            "tool_calls": [
                {
                    "id": "call_1",
                    "type": "function",
                    "function": {"name": "grep", "arguments": "{}"},
                }
            ],
        },
        {"role": "tool", "tool_call_id": "call_1", "name": "grep", "content": "x" * 9000},
    ]

    projection = ContextPipeline(per_call_limit=8000).project(history)

    assert "truncated, total 9000 chars" in projection.messages[1]["content"]
    assert projection.report["capped_tool_results"] == 1


def test_context_pipeline_does_not_mutate_input_history() -> None:
    history = [
        {
            "role": "assistant",
            "content": "",
            "tool_calls": [
                {
                    "id": "call_1",
                    "type": "function",
                    "function": {"name": "grep", "arguments": "{}"},
                }
            ],
        },
        {"role": "tool", "tool_call_id": "call_1", "name": "grep", "content": "x" * 9000},
    ]
    original = [dict(history[0]), dict(history[1])]

    ContextPipeline(per_call_limit=8000).project(history)

    assert history == original


def test_context_pipeline_replaces_large_tool_result_with_file_reference(tmp_path) -> None:
    content = "x" * 9000
    history = [
        {
            "role": "assistant",
            "content": "",
            "tool_calls": [
                {
                    "id": "call_1",
                    "type": "function",
                    "function": {"name": "grep", "arguments": "{}"},
                }
            ],
        },
        {
            "role": "tool",
            "turn_id": "turn_1",
            "tool_call_id": "call_1",
            "name": "grep",
            "content": content,
        },
    ]
    store = ToolResultStore(tmp_path)

    pipeline = ContextPipeline(
        tool_result_store=store,
        replacement_min_bytes=2000,
        replacement_preview_chars=120,
    )

    projection = pipeline.project(history)
    projection_again = pipeline.project(history)

    tool_message = projection.messages[1]
    replacement = projection.report["tool_result_replacements"][0]
    artifact = tmp_path / replacement["artifact_path"]

    assert projection_again.messages[1]["content"] == tool_message["content"]
    assert projection_again.report["tool_result_replacements"] == projection.report["tool_result_replacements"]
    assert projection.report["replaced_tool_results"] == 1
    assert artifact.read_text(encoding="utf-8") == content
    assert "Tool result stored outside the model context" in tool_message["content"]
    assert replacement["artifact_path"] in tool_message["content"]
    assert "original_chars: 9000" in tool_message["content"]
    assert len(tool_message["content"]) < 1000


def test_context_pipeline_uses_tool_specific_result_budget(tmp_path) -> None:
    content = "x" * 3000
    history = [
        {
            "role": "assistant",
            "content": "",
            "tool_calls": [
                {
                    "id": "call_1",
                    "type": "function",
                    "function": {"name": "grep", "arguments": "{}"},
                }
            ],
        },
        {
            "role": "tool",
            "turn_id": "turn_1",
            "tool_call_id": "call_1",
            "name": "grep",
            "content": content,
        },
    ]

    projection = ContextPipeline(
        tool_result_store=ToolResultStore(tmp_path),
        replacement_min_bytes=8000,
        replacement_preview_chars=80,
        tool_result_limits={"grep": 2000},
    ).project(history)

    assert projection.report["replaced_tool_results"] == 1
    assert projection.report["tool_result_replacements"][0]["tool_name"] == "grep"
    assert "original_chars: 3000" in projection.messages[1]["content"]
