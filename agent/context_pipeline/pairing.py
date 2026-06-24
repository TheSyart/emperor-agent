from __future__ import annotations

from typing import Any


def pair_tool_calls(history: list[dict[str, Any]]) -> tuple[list[dict[str, Any]], int, int]:
    cleaned: list[dict[str, Any]] = []
    expected: list[tuple[str, str]] = []
    filled = 0
    dropped = 0

    def flush_expected() -> None:
        nonlocal filled
        for tool_call_id, tool_name in expected:
            cleaned.append({
                "role": "tool",
                "tool_call_id": tool_call_id,
                "name": tool_name,
                "content": "(tool execution interrupted)",
            })
            filled += 1
        expected.clear()

    for message in history:
        copied = dict(message)
        role = copied.get("role")
        if role == "tool":
            tool_call_id = copied.get("tool_call_id")
            index = next((i for i, (expected_id, _) in enumerate(expected) if expected_id == tool_call_id), None)
            if index is None:
                dropped += 1
                continue
            cleaned.append(copied)
            expected.pop(index)
            continue
        flush_expected()
        cleaned.append(copied)
        if role == "assistant":
            for tool_call in copied.get("tool_calls") or []:
                function = tool_call.get("function") or {}
                expected.append((tool_call.get("id") or "", function.get("name", "")))
    flush_expected()
    return cleaned, filled, dropped
