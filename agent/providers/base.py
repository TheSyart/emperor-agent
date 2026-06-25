from __future__ import annotations

import asyncio
import json
from abc import ABC, abstractmethod
from collections.abc import Awaitable, Callable
from dataclasses import dataclass, field
from typing import Any

from loguru import logger

ContentDelta = Callable[[str], Awaitable[None]]

# SDK 自带指数退避 + 尊重 Retry-After，覆盖 429/5xx/连接错误。
# LLM 调用本身无副作用（工具执行在 runner 侧分开），重试幂等安全。
DEFAULT_MAX_RETRIES = 2


@dataclass
class ToolCallRequest:
    id: str
    name: str
    arguments: dict[str, Any]

    def to_openai_tool_call(self) -> dict[str, Any]:
        return {
            "id": self.id,
            "type": "function",
            "function": {
                "name": self.name,
                "arguments": json.dumps(self.arguments, ensure_ascii=False),
            },
        }


@dataclass
class LLMResponse:
    content: str | None
    tool_calls: list[ToolCallRequest] = field(default_factory=list)
    finish_reason: str = "stop"
    usage: dict[str, int] = field(default_factory=dict)
    reasoning_content: str | None = None
    thinking_blocks: list[dict[str, Any]] | None = None

    @property
    def should_execute_tools(self) -> bool:
        return bool(self.tool_calls) and self.finish_reason in {"tool_calls", "stop"}


TRUNCATED_FINISH_REASONS = frozenset({"length", "max_tokens", "model_max_tokens"})


def is_truncated(finish_reason: str | None) -> bool:
    return (finish_reason or "").lower() in TRUNCATED_FINISH_REASONS


@dataclass(frozen=True)
class GenerationSettings:
    max_tokens: int = 20_000
    temperature: float = 0.1
    reasoning_effort: str | None = None


class LLMProvider(ABC):
    def __init__(
        self,
        *,
        api_key: str | None = None,
        api_base: str | None = None,
        default_model: str,
        extra_headers: dict[str, str] | None = None,
        extra_body: dict[str, Any] | None = None,
    ):
        self.api_key = api_key
        self.api_base = api_base
        self.default_model = default_model
        self.extra_headers = extra_headers or {}
        self.extra_body = extra_body or {}
        self.generation = GenerationSettings()

    @abstractmethod
    async def chat(
        self,
        *,
        messages: list[dict[str, Any]],
        tools: list[dict[str, Any]] | None = None,
        model: str | None = None,
        max_tokens: int = 4096,
        temperature: float = 0.7,
        reasoning_effort: str | None = None,
    ) -> LLMResponse:
        ...

    async def chat_stream(
        self,
        *,
        messages: list[dict[str, Any]],
        tools: list[dict[str, Any]] | None = None,
        model: str | None = None,
        max_tokens: int = 4096,
        temperature: float = 0.7,
        reasoning_effort: str | None = None,
        on_content_delta: ContentDelta | None = None,
    ) -> LLMResponse:
        response = await self.chat(
            messages=messages,
            tools=tools,
            model=model,
            max_tokens=max_tokens,
            temperature=temperature,
            reasoning_effort=reasoning_effort,
        )
        if response.content and on_content_delta:
            await on_content_delta(response.content)
        return response

    @staticmethod
    def anthropic_tools_to_openai(tools: list[dict[str, Any]] | None) -> list[dict[str, Any]] | None:
        if not tools:
            return None
        converted = []
        for tool in tools:
            if tool.get("type") == "function":
                converted.append(tool)
                continue
            converted.append({
                "type": "function",
                "function": {
                    "name": tool.get("name", ""),
                    "description": tool.get("description", ""),
                    "parameters": tool.get("input_schema", {"type": "object", "properties": {}}),
                },
            })
        return converted

    @staticmethod
    def openai_tools_to_anthropic(tools: list[dict[str, Any]] | None) -> list[dict[str, Any]] | None:
        if not tools:
            return None
        converted = []
        for tool in tools:
            fn = tool.get("function", tool)
            converted.append({
                "name": fn.get("name", ""),
                "description": fn.get("description", ""),
                "input_schema": fn.get("parameters") or fn.get("input_schema") or {
                    "type": "object",
                    "properties": {},
                },
            })
        return converted

    @staticmethod
    def parse_json_args(value: Any) -> dict[str, Any]:
        if isinstance(value, dict):
            return value
        if not isinstance(value, str) or not value.strip():
            return {}
        try:
            parsed = json.loads(value)
            return parsed if isinstance(parsed, dict) else {}
        except json.JSONDecodeError:
            try:
                import json_repair

                parsed = json_repair.loads(value)
                return parsed if isinstance(parsed, dict) else {}
            except Exception:
                logger.debug(f"JSON repair failed for input: {value[:100]}")
                return {}


_shared_loop = None


def run_sync(coro):
    global _shared_loop
    try:
        asyncio.get_running_loop()
    except RuntimeError:
        if _shared_loop is not None and _shared_loop.is_running():
            # Called from a thread spawned by asyncio.to_thread while the
            # main loop is executing — create a fresh loop in this thread
            # instead of deadlocking on the already-busy main loop.
            return asyncio.run(coro)
        if _shared_loop is None or _shared_loop.is_closed():
            _shared_loop = asyncio.new_event_loop()
            asyncio.set_event_loop(_shared_loop)
        return _shared_loop.run_until_complete(coro)
    raise RuntimeError("Cannot run sync provider call inside a running event loop")
