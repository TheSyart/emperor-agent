from agent.runner import AgentRunner


def test_pair_tool_calls_fills_missing_tool_result() -> None:
    history = [
        {"role": "user", "content": "run it"},
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

    cleaned = AgentRunner._pair_tool_calls(history)

    assert cleaned[-1] == {
        "role": "tool",
        "tool_call_id": "call_1",
        "name": "read_file",
        "content": "(tool execution interrupted)",
    }


def test_pair_tool_calls_drops_orphan_tool_message() -> None:
    history = [
        {"role": "tool", "tool_call_id": "orphan", "name": "read_file", "content": "bad"},
        {"role": "user", "content": "hello"},
    ]

    cleaned = AgentRunner._pair_tool_calls(history)

    assert cleaned == [{"role": "user", "content": "hello"}]


def test_cap_tool_result_keeps_head_and_tail() -> None:
    text = "a" * 9000 + "tail"
    history = [{"role": "tool", "tool_call_id": "call_1", "name": "grep", "content": text}]

    capped = AgentRunner._cap_tool_result(history, per_call_limit=8000)

    content = capped[0]["content"]
    assert content.startswith("a" * 100)
    assert content.endswith("tail")
    assert "truncated, total 9004 chars" in content


def test_shrink_old_tool_results_keeps_recent_tool_messages() -> None:
    old_large = {"role": "tool", "tool_call_id": "old", "name": "grep", "content": "x" * 2000}
    recent_large = {"role": "tool", "tool_call_id": "recent", "name": "grep", "content": "y" * 2000}
    history = [old_large, {"role": "user", "content": "middle"}, recent_large]

    shrunk = AgentRunner._shrink_old_tool_results(history, keep_recent=2)

    assert shrunk[0]["content"] == "[shrunk] grep \u2192 2000 chars omitted"
    assert shrunk[2]["content"] == "y" * 2000
