from __future__ import annotations

from agent.providers.anthropic_provider import AnthropicProvider
from agent.providers.base import DEFAULT_MAX_RETRIES
from agent.providers.bedrock_provider import BedrockProvider
from agent.providers.openai_compat import OpenAICompatProvider

_SYSTEM = "稳定系统前缀"
_MESSAGES = [
    {"role": "system", "content": _SYSTEM},
    {"role": "user", "content": "hi"},
]


# --- ISSUE-007 / ISSUE-009: every provider carries the system prompt ---


def test_anthropic_request_carries_system() -> None:
    provider = AnthropicProvider(api_key="test", default_model="claude-opus-4-8")
    kwargs = provider._kwargs(
        messages=_MESSAGES, tools=None, model=None, max_tokens=100,
        temperature=0.1, reasoning_effort=None,
    )
    system = kwargs["system"]
    # native endpoint → cached block list; the text is carried either way
    text = system[0]["text"] if isinstance(system, list) else system
    assert text == _SYSTEM


def test_openai_compat_request_carries_system() -> None:
    provider = OpenAICompatProvider(api_key="test", spec=None, default_model="gpt-x")
    kwargs = provider._kwargs(
        messages=_MESSAGES, tools=None, model=None, max_tokens=100,
        temperature=0.1, reasoning_effort=None, stream=False,
    )
    system_msgs = [m for m in kwargs["messages"] if m.get("role") == "system"]
    assert len(system_msgs) == 1
    assert system_msgs[0]["content"] == _SYSTEM


def test_bedrock_request_carries_system_and_drops_system_role() -> None:
    request = BedrockProvider._converse_request("model-x", _MESSAGES, 100, 0.5)
    assert request["system"] == [{"text": _SYSTEM}]
    assert all(m["role"] != "system" for m in request["messages"])


def test_bedrock_without_system_omits_system_key() -> None:
    request = BedrockProvider._converse_request("model-x", [{"role": "user", "content": "hi"}], 100, 0.5)
    assert "system" not in request


# --- ISSUE-008: native SDK retries are enabled ---


def test_anthropic_client_retries_enabled() -> None:
    provider = AnthropicProvider(api_key="test", default_model="claude-opus-4-8")
    assert provider.client.max_retries == DEFAULT_MAX_RETRIES


def test_openai_compat_client_retries_enabled() -> None:
    provider = OpenAICompatProvider(api_key="test", spec=None, default_model="gpt-x")
    assert provider.client.max_retries == DEFAULT_MAX_RETRIES
