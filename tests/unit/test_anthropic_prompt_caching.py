from __future__ import annotations

from agent.providers.anthropic_provider import AnthropicProvider

_MESSAGES = [
    {"role": "system", "content": "稳定系统前缀"},
    {"role": "user", "content": "hi"},
]
_TOOLS = [
    {"name": "t1", "description": "d1", "input_schema": {"type": "object", "properties": {}}},
    {"name": "t2", "description": "d2", "input_schema": {"type": "object", "properties": {}}},
]


def _kwargs(provider: AnthropicProvider) -> dict:
    return provider._kwargs(
        messages=_MESSAGES,
        tools=_TOOLS,
        model=None,
        max_tokens=100,
        temperature=0.1,
        reasoning_effort=None,
    )


def test_native_endpoint_marks_system_and_last_tool_cacheable() -> None:
    provider = AnthropicProvider(api_key="test", default_model="claude-opus-4-8")

    kwargs = _kwargs(provider)

    system = kwargs["system"]
    assert isinstance(system, list)
    assert system[0]["text"] == "稳定系统前缀"
    assert system[0]["cache_control"] == {"type": "ephemeral"}

    tools = kwargs["tools"]
    assert tools[-1]["cache_control"] == {"type": "ephemeral"}
    assert "cache_control" not in tools[0]


def test_third_party_proxy_stays_uncached_for_backward_compat() -> None:
    provider = AnthropicProvider(
        api_key="test",
        api_base="https://proxy.example.com/v1",
        default_model="claude-opus-4-8",
    )

    kwargs = _kwargs(provider)

    assert kwargs["system"] == "稳定系统前缀"
    assert all("cache_control" not in tool for tool in kwargs["tools"])
