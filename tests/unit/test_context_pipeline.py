from agent.context_pipeline.pipeline import ContextPipeline


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
    history = [{"role": "tool", "tool_call_id": "call_1", "name": "grep", "content": "x" * 9000}]
    original = [dict(history[0])]

    ContextPipeline(per_call_limit=8000).project(history)

    assert history == original
