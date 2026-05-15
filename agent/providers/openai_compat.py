from __future__ import annotations

import json
from typing import Any

from loguru import logger

from .base import LLMProvider, LLMResponse, ToolCallRequest
from .registry import ProviderSpec


class OpenAICompatProvider(LLMProvider):
    def __init__(self, *, spec: ProviderSpec | None = None, **kwargs):
        super().__init__(**kwargs)
        self.spec = spec
        from openai import AsyncOpenAI

        import httpx

        headers = self.extra_headers or None
        http_client = httpx.AsyncClient(
            limits=httpx.Limits(max_keepalive_connections=0, max_connections=50),
            timeout=httpx.Timeout(600.0, connect=30.0),
        )
        self.client = AsyncOpenAI(
            api_key=self.api_key or "no-key",
            base_url=self.api_base or (spec.default_api_base if spec else None),
            default_headers=headers,
            max_retries=0,
            http_client=http_client,
        )

    def _model_name(self, model: str | None) -> str:
        name = model or self.default_model
        if self.spec and self.spec.strip_model_prefix:
            return name.split("/")[-1]
        return name

    def _kwargs(
        self,
        *,
        messages: list[dict[str, Any]],
        tools: list[dict[str, Any]] | None,
        model: str | None,
        max_tokens: int,
        temperature: float,
        reasoning_effort: str | None,
        stream: bool,
    ) -> dict[str, Any]:
        model_name = self._model_name(model)
        kwargs: dict[str, Any] = {
            "model": model_name,
            "messages": self._sanitize_messages(
                messages,
                model_name=model_name,
                reasoning_effort=reasoning_effort,
            ),
            "stream": stream,
        }
        if not self._temperature_forbidden(model_name, reasoning_effort):
            kwargs["temperature"] = temperature
        if self.spec and self.spec.supports_max_completion_tokens:
            kwargs["max_completion_tokens"] = max(1, max_tokens)
        else:
            kwargs["max_tokens"] = max(1, max_tokens)
        if reasoning_effort and reasoning_effort != "none":
            kwargs["reasoning_effort"] = reasoning_effort
        if tools:
            kwargs["tools"] = self.anthropic_tools_to_openai(tools)
            kwargs["tool_choice"] = "auto"
        extra_body = self._extra_body_for_reasoning(reasoning_effort)
        if self.extra_body:
            extra_body.update(self.extra_body)
        if extra_body:
            kwargs["extra_body"] = extra_body
        return kwargs

    @staticmethod
    def _temperature_forbidden(model: str, reasoning_effort: str | None) -> bool:
        name = model.lower()
        return bool(reasoning_effort and reasoning_effort != "none") or any(
            token in name for token in ("gpt-5", "o1", "o3", "o4")
        )

    def _extra_body_for_reasoning(self, reasoning_effort: str | None) -> dict[str, Any]:
        if not self.spec or not self.spec.thinking_style or reasoning_effort is None:
            return {}
        enabled = reasoning_effort not in ("none", "minimal", "minimum")
        if self.spec.thinking_style == "thinking_type":
            return {"thinking": {"type": "enabled" if enabled else "disabled"}}
        if self.spec.thinking_style == "enable_thinking":
            return {"enable_thinking": enabled}
        if self.spec.thinking_style == "reasoning_split":
            return {"reasoning_split": enabled}
        return {}

    def _sanitize_messages(
        self,
        messages: list[dict[str, Any]],
        *,
        model_name: str,
        reasoning_effort: str | None,
    ) -> list[dict[str, Any]]:
        allowed = {
            "role",
            "content",
            "tool_calls",
            "tool_call_id",
            "name",
            "reasoning_content",
            "extra_content",
        }
        clean_messages = []
        for msg in messages:
            clean = {k: v for k, v in msg.items() if k in allowed}
            if clean.get("role") == "assistant" and clean.get("tool_calls"):
                clean["content"] = clean.get("content") or None
            clean_messages.append(clean)
        if self._requires_reasoning_backfill(model_name, reasoning_effort):
            for msg in clean_messages:
                if msg.get("role") == "assistant" and "reasoning_content" not in msg:
                    msg["reasoning_content"] = ""
        return clean_messages

    def _requires_reasoning_backfill(self, model_name: str, reasoning_effort: str | None) -> bool:
        effort = reasoning_effort.lower() if isinstance(reasoning_effort, str) else None
        explicit_thinking = (
            reasoning_effort is not None
            and effort not in ("none", "minimal", "minimum")
            and bool(self.spec and self.spec.thinking_style)
        )
        implicit_deepseek_thinking = (
            self.spec is not None
            and self.spec.name == "deepseek"
            and effort not in ("none", "minimal", "minimum")
            and any(token in model_name.lower() for token in ("deepseek-v4", "deepseek-reasoner"))
        )
        return explicit_thinking or implicit_deepseek_thinking

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
        response = await self.client.chat.completions.create(
            **self._kwargs(
                messages=messages,
                tools=tools,
                model=model,
                max_tokens=max_tokens,
                temperature=temperature,
                reasoning_effort=reasoning_effort,
                stream=False,
            )
        )
        choice = response.choices[0]
        message = choice.message
        tool_calls = []
        for tc in message.tool_calls or []:
            tool_calls.append(ToolCallRequest(
                id=tc.id,
                name=tc.function.name,
                arguments=self.parse_json_args(tc.function.arguments),
            ))
        usage = {}
        if getattr(response, "usage", None):
            usage = self._parse_usage(response.usage)
        return LLMResponse(
            content=message.content,
            tool_calls=tool_calls,
            finish_reason="tool_calls" if tool_calls else (choice.finish_reason or "stop"),
            usage=usage,
            reasoning_content=self._message_reasoning_content(message),
        )

    async def chat_stream(self, *, on_content_delta=None, **kwargs) -> LLMResponse:
        stream_kwargs = self._kwargs(stream=True, **kwargs)
        stream_kwargs["stream_options"] = {"include_usage": True}
        try:
            stream = await self.client.chat.completions.create(**stream_kwargs)
        except Exception as exc:
            if not self._stream_usage_unsupported(exc):
                raise
            logger.debug(f"Provider does not support stream usage, retrying without it: {exc}")
            stream_kwargs.pop("stream_options", None)
            stream = await self.client.chat.completions.create(**stream_kwargs)
        content_parts: list[str] = []
        reasoning_parts: list[str] = []
        tool_chunks: dict[int, dict[str, str]] = {}
        finish_reason = "stop"
        usage: dict[str, int] = {}
        async for chunk in stream:
            if getattr(chunk, "usage", None):
                usage = self._parse_usage(chunk.usage)
            if not chunk.choices:
                continue
            choice = chunk.choices[0]
            finish_reason = choice.finish_reason or finish_reason
            delta = choice.delta
            if delta.content:
                content_parts.append(delta.content)
                if on_content_delta:
                    await on_content_delta(delta.content)
            if reasoning := self._message_reasoning_content(delta):
                reasoning_parts.append(reasoning)
            for tc in delta.tool_calls or []:
                index = tc.index or 0
                buf = tool_chunks.setdefault(index, {"id": "", "name": "", "arguments": ""})
                if tc.id:
                    buf["id"] += tc.id
                if tc.function and tc.function.name:
                    buf["name"] += tc.function.name
                if tc.function and tc.function.arguments:
                    buf["arguments"] += tc.function.arguments

        tool_calls = [
            ToolCallRequest(
                id=buf["id"] or f"call_{idx}",
                name=buf["name"],
                arguments=self.parse_json_args(buf["arguments"]),
            )
            for idx, buf in sorted(tool_chunks.items())
            if buf["name"]
        ]
        return LLMResponse(
            content="".join(content_parts) or None,
            tool_calls=tool_calls,
            finish_reason="tool_calls" if tool_calls else finish_reason,
            usage=usage,
            reasoning_content="".join(reasoning_parts) or None,
        )

    @classmethod
    def _parse_usage(cls, usage: Any) -> dict[str, int]:
        prompt_tokens = cls._usage_int(usage, "prompt_tokens")
        completion_tokens = cls._usage_int(usage, "completion_tokens")
        details = cls._usage_field(usage, "prompt_tokens_details")
        cached_tokens = cls._usage_int(details, "cached_tokens")
        cache_create = (
            cls._usage_int(details, "cache_creation_tokens")
            or cls._usage_int(details, "cache_creation_input_tokens")
            or cls._usage_int(usage, "cache_creation_input_tokens")
        )
        input_tokens = max(0, prompt_tokens - cached_tokens - cache_create)
        return {
            "input": input_tokens,
            "output": completion_tokens,
            "cache_read": cached_tokens,
            "cache_create": cache_create,
        }

    @staticmethod
    def _usage_field(value: Any, key: str) -> Any:
        if value is None:
            return None
        if isinstance(value, dict):
            return value.get(key)
        direct = getattr(value, key, None)
        if direct is not None:
            return direct
        extra = getattr(value, "model_extra", None)
        if isinstance(extra, dict):
            return extra.get(key)
        if hasattr(value, "model_dump"):
            try:
                dumped = value.model_dump()
            except Exception:
                dumped = None
            if isinstance(dumped, dict):
                return dumped.get(key)
        return None

    @classmethod
    def _usage_int(cls, value: Any, key: str) -> int:
        raw = cls._usage_field(value, key)
        try:
            return int(raw or 0)
        except (TypeError, ValueError):
            return 0

    @staticmethod
    def _stream_usage_unsupported(exc: Exception) -> bool:
        text = str(exc).lower()
        return "stream_options" in text or "include_usage" in text

    @staticmethod
    def _message_reasoning_content(message: Any) -> str | None:
        value = getattr(message, "reasoning_content", None) or getattr(message, "reasoning", None)
        if value is None and hasattr(message, "model_extra"):
            extra = getattr(message, "model_extra") or {}
            value = extra.get("reasoning_content") or extra.get("reasoning")
        if isinstance(value, str):
            return value
        if isinstance(value, list):
            return "".join(str(item) for item in value if item is not None) or None
        return None


class AzureOpenAIProvider(OpenAICompatProvider):
    def __init__(self, *, api_base: str | None = None, **kwargs):
        base = api_base.rstrip("/") if api_base else None
        super().__init__(api_base=f"{base}/openai/v1/" if base else None, **kwargs)


class OpenAICodexProvider(OpenAICompatProvider):
    """OAuth-based 通过 ChatGPT backend-api。当前作为占位子类，
    完整 OAuth 流程留待实现。"""
    pass


class GitHubCopilotProvider(OpenAICompatProvider):
    """OAuth-based 通过 GitHub Copilot endpoint。当前作为占位子类。"""
    pass
