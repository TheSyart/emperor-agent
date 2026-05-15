"""Tests for token usage normalization and cache accounting."""

from __future__ import annotations

import asyncio
import json
from pathlib import Path
from types import SimpleNamespace
from typing import Any

from agent.providers.openai_compat import OpenAICompatProvider
from agent.telemetry import TokenTracker


def test_openai_usage_normalizes_cached_tokens() -> None:
    usage = SimpleNamespace(
        prompt_tokens=1000,
        completion_tokens=50,
        prompt_tokens_details=SimpleNamespace(cached_tokens=300),
    )

    assert OpenAICompatProvider._parse_usage(usage) == {
        "input": 700,
        "output": 50,
        "cache_read": 300,
        "cache_create": 0,
    }


def test_openai_usage_reads_dict_details() -> None:
    usage = {
        "prompt_tokens": 1000,
        "completion_tokens": 50,
        "prompt_tokens_details": {"cached_tokens": 300},
    }

    assert OpenAICompatProvider._parse_usage(usage)["input"] == 700
    assert OpenAICompatProvider._parse_usage(usage)["cache_read"] == 300


def test_openai_stream_captures_final_usage() -> None:
    completions = FakeCompletions([
        FakeChunk(
            choices=[
                SimpleNamespace(
                    finish_reason=None,
                    delta=SimpleNamespace(content="hello", tool_calls=[]),
                )
            ]
        ),
        FakeChunk(
            choices=[],
            usage=SimpleNamespace(
                prompt_tokens=1000,
                completion_tokens=50,
                prompt_tokens_details=SimpleNamespace(cached_tokens=300),
            ),
        ),
    ])
    provider = make_provider(completions)

    response = asyncio.run(provider.chat_stream(
        messages=[{"role": "user", "content": "hi"}],
        tools=None,
        model="gpt-4o",
        max_tokens=64,
        temperature=0.1,
        reasoning_effort=None,
    ))

    assert completions.calls[0]["stream_options"] == {"include_usage": True}
    assert response.content == "hello"
    assert response.usage == {"input": 700, "output": 50, "cache_read": 300, "cache_create": 0}


def test_openai_stream_usage_falls_back_when_unsupported() -> None:
    completions = FakeCompletions([
        FakeChunk(
            choices=[
                SimpleNamespace(
                    finish_reason="stop",
                    delta=SimpleNamespace(content="ok", tool_calls=[]),
                )
            ]
        )
    ], fail_stream_options=True)
    provider = make_provider(completions)

    response = asyncio.run(provider.chat_stream(
        messages=[{"role": "user", "content": "hi"}],
        tools=None,
        model="gpt-4o",
        max_tokens=64,
        temperature=0.1,
        reasoning_effort=None,
    ))

    assert len(completions.calls) == 2
    assert completions.calls[0]["stream_options"] == {"include_usage": True}
    assert "stream_options" not in completions.calls[1]
    assert response.content == "ok"


def test_token_tracker_recent_calls_normalize_legacy_cache_rows(tmp_path: Path) -> None:
    log_file = tmp_path / "tokens.jsonl"
    rows = [
        {"ts": "2026-05-01T10:00:00", "model": "legacy", "prompt_tokens": 10, "completion_tokens": 2},
        {
            "ts": "2026-05-01T10:01:00",
            "provider": "anthropic",
            "model": "claude",
            "usage_type": "main_agent",
            "input": 7,
            "output": 1,
            "cache_read": 3,
        },
    ]
    log_file.write_text("\n".join(json.dumps(row) for row in rows) + "\n", encoding="utf-8")

    tracker = TokenTracker(log_file)

    assert tracker.last_input_tokens() == 10
    assert tracker.recent_calls(1)[0] == {
        "ts": "2026-05-01T10:01:00",
        "provider": "anthropic",
        "model": "claude",
        "usage_type": "main_agent",
        "input": 7,
        "output": 1,
        "cache_read": 3,
        "cache_create": 0,
        "total": 11,
    }
    assert [row["model"] for row in tracker.recent_cache_calls()] == ["claude"]


class FakeCompletions:
    def __init__(self, chunks: list["FakeChunk"], *, fail_stream_options: bool = False):
        self.chunks = chunks
        self.fail_stream_options = fail_stream_options
        self.calls: list[dict[str, Any]] = []

    async def create(self, **kwargs: Any) -> "FakeStream":
        self.calls.append(dict(kwargs))
        if self.fail_stream_options and kwargs.get("stream_options"):
            self.fail_stream_options = False
            raise ValueError("stream_options is not supported")
        return FakeStream(self.chunks)


class FakeStream:
    def __init__(self, chunks: list["FakeChunk"]):
        self.chunks = list(chunks)

    def __aiter__(self) -> "FakeStream":
        return self

    async def __anext__(self) -> "FakeChunk":
        if not self.chunks:
            raise StopAsyncIteration
        return self.chunks.pop(0)


class FakeChunk:
    def __init__(self, *, choices: list[Any], usage: Any = None):
        self.choices = choices
        self.usage = usage


def make_provider(completions: FakeCompletions) -> OpenAICompatProvider:
    provider = object.__new__(OpenAICompatProvider)
    provider.spec = None
    provider.default_model = "gpt-4o"
    provider.extra_body = {}
    provider.client = SimpleNamespace(chat=SimpleNamespace(completions=completions))
    return provider
