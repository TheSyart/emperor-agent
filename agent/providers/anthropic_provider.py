from __future__ import annotations

import secrets
import string
from typing import Any

from loguru import logger

from .base import DEFAULT_MAX_RETRIES, LLMProvider, LLMResponse, ToolCallRequest

_ALNUM = string.ascii_letters + string.digits
_EPHEMERAL = {"type": "ephemeral"}


def _tool_id() -> str:
    return "toolu_" + "".join(secrets.choice(_ALNUM) for _ in range(22))


class AnthropicProvider(LLMProvider):
    def __init__(self, **kwargs):
        super().__init__(**kwargs)
        from anthropic import AsyncAnthropic

        client_kwargs: dict[str, Any] = {"max_retries": DEFAULT_MAX_RETRIES}
        if self.api_key:
            client_kwargs["api_key"] = self.api_key
        if self.api_base:
            client_kwargs["base_url"] = self.api_base
        if self.extra_headers:
            client_kwargs["default_headers"] = self.extra_headers
        self.client = AsyncAnthropic(**client_kwargs)

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
        response = await self.client.messages.create(
            **self._kwargs(
                messages=messages,
                tools=tools,
                model=model,
                max_tokens=max_tokens,
                temperature=temperature,
                reasoning_effort=reasoning_effort,
            )
        )
        return self._parse_response(response)

    async def chat_stream(self, *, on_content_delta=None, **kwargs) -> LLMResponse:
        async with self.client.messages.stream(**self._kwargs(**kwargs)) as stream:
            if on_content_delta:
                async for text in stream.text_stream:
                    await on_content_delta(text)
            final = await stream.get_final_message()
        return self._parse_response(final)

    def _kwargs(
        self,
        *,
        messages: list[dict[str, Any]],
        tools: list[dict[str, Any]] | None,
        model: str | None,
        max_tokens: int,
        temperature: float,
        reasoning_effort: str | None,
    ) -> dict[str, Any]:
        system, anthropic_messages = self._convert_messages(messages)
        if self._needs_reasoning_content_backfill(reasoning_effort):
            self._backfill_reasoning_content(anthropic_messages)
        kwargs: dict[str, Any] = {
            "model": self._strip_prefix(model or self.default_model),
            "max_tokens": max(1, max_tokens),
            "messages": anthropic_messages,
            "temperature": temperature,
        }
        cache = self._supports_prompt_caching()
        if system:
            # 缓存稳定的 system 前缀：会话内提示词不变，跨轮命中可省成本/降延迟。
            kwargs["system"] = (
                [{"type": "text", "text": system, "cache_control": _EPHEMERAL}] if cache else system
            )
        anthropic_tools = self.openai_tools_to_anthropic(tools)
        if anthropic_tools:
            if cache:
                # 工具表整会话稳定，是最大的可缓存块；标记最后一个即覆盖整段。
                anthropic_tools[-1] = {**anthropic_tools[-1], "cache_control": _EPHEMERAL}
            kwargs["tools"] = anthropic_tools
            kwargs["tool_choice"] = {"type": "auto"}
        if reasoning_effort and reasoning_effort != "none":
            budget = {"low": 1024, "medium": 4096, "high": 8192}.get(reasoning_effort, 4096)
            kwargs["thinking"] = {"type": "enabled", "budget_tokens": budget}
            kwargs["temperature"] = 1.0
            kwargs["max_tokens"] = max(kwargs["max_tokens"], budget + 1024)
        return kwargs

    def _supports_prompt_caching(self) -> bool:
        # 原生 Anthropic 端点（未设 base 或 anthropic.com）支持 cache_control；
        # 第三方兼容代理可能不认该字段，跳过以保持向后兼容。
        base = (self.api_base or "").lower()
        return not base or "anthropic.com" in base

    @staticmethod
    def _strip_prefix(model: str) -> str:
        for prefix in ("anthropic/", "deepseekAnthropic/"):
            if model.startswith(prefix):
                return model[len(prefix):]
        return model

    def _convert_messages(
        self,
        messages: list[dict[str, Any]],
    ) -> tuple[str, list[dict[str, Any]]]:
        system_parts: list[str] = []
        converted: list[dict[str, Any]] = []
        for msg in messages:
            role = msg.get("role")
            content = msg.get("content")
            if role == "system":
                system_parts.append(str(content or ""))
                continue
            if role == "tool":
                self._append_tool_result(converted, msg)
                continue
            if role == "assistant":
                assistant_msg = {"role": "assistant", "content": self._assistant_blocks(msg)}
                if "reasoning_content" in msg:
                    assistant_msg["reasoning_content"] = str(msg.get("reasoning_content") or "")
                converted.append(assistant_msg)
                continue
            if role == "user":
                converted.append({
                    "role": "user",
                    "content": self._content_to_anthropic(content) or "(empty)",
                })

        return "\n\n".join(p for p in system_parts if p), self._merge_roles(converted)

    @staticmethod
    def _content_to_anthropic(content: Any) -> Any:
        """把 OpenAI 风格 content（str 或 list[block]）翻译成 Anthropic 风格。

        - str 原样返回（Anthropic 也接受 string）
        - list[block]: text → {type:text}; image_url(data:URL) → {type:image, source:{base64...}}
        - 其它类型转 str
        """
        if isinstance(content, str):
            return content
        if not isinstance(content, list):
            return str(content) if content is not None else ""
        out: list[dict[str, Any]] = []
        for block in content:
            if not isinstance(block, dict):
                continue
            btype = block.get("type")
            if btype == "text":
                out.append({"type": "text", "text": str(block.get("text", ""))})
            elif btype == "image_url":
                url = (block.get("image_url") or {}).get("url", "")
                if isinstance(url, str) and url.startswith("data:"):
                    try:
                        meta, data = url.split(",", 1)
                        media_type = meta.split(";")[0].split(":", 1)[1]
                    except (ValueError, IndexError):
                        continue
                    out.append({
                        "type": "image",
                        "source": {
                            "type": "base64",
                            "media_type": media_type,
                            "data": data,
                        },
                    })
                # 远程 URL（非 data:）暂不支持，静默丢弃
        return out

    @staticmethod
    def _append_tool_result(converted: list[dict[str, Any]], msg: dict[str, Any]) -> None:
        block = {
            "type": "tool_result",
            "tool_use_id": msg.get("tool_call_id", ""),
            "content": str(msg.get("content") or ""),
        }
        if converted and converted[-1]["role"] == "user":
            content = converted[-1]["content"]
            if isinstance(content, list):
                content.append(block)
            else:
                converted[-1]["content"] = [{"type": "text", "text": str(content)}, block]
        else:
            converted.append({"role": "user", "content": [block]})

    def _assistant_blocks(self, msg: dict[str, Any]) -> list[dict[str, Any]]:
        blocks = []
        content = msg.get("content")
        for block in msg.get("thinking_blocks") or []:
            if not isinstance(block, dict):
                continue
            if block.get("type") == "thinking":
                item = {
                    "type": "thinking",
                    "thinking": block.get("thinking", ""),
                }
                if block.get("signature"):
                    item["signature"] = block["signature"]
                blocks.append(item)
            elif block.get("type") == "redacted_thinking":
                blocks.append(dict(block))
        if content:
            blocks.append({"type": "text", "text": str(content)})
        for tc in msg.get("tool_calls") or []:
            fn = tc.get("function") or {}
            blocks.append({
                "type": "tool_use",
                "id": tc.get("id") or _tool_id(),
                "name": fn.get("name", ""),
                "input": self.parse_json_args(fn.get("arguments")),
            })
        return blocks or [{"type": "text", "text": ""}]

    @staticmethod
    def _merge_roles(messages: list[dict[str, Any]]) -> list[dict[str, Any]]:
        merged: list[dict[str, Any]] = []
        for msg in messages:
            if merged and merged[-1]["role"] == msg["role"]:
                prev = merged[-1]["content"]
                curr = msg["content"]
                if not isinstance(prev, list):
                    prev = [{"type": "text", "text": str(prev)}]
                if isinstance(curr, list):
                    prev.extend(curr)
                else:
                    prev.append({"type": "text", "text": str(curr)})
                merged[-1]["content"] = prev
            else:
                merged.append(msg)
        while merged and merged[-1]["role"] == "assistant":
            merged.pop()
        if not merged:
            merged.append({"role": "user", "content": "(conversation continued)"})
        if merged[0]["role"] == "assistant":
            merged.insert(0, {"role": "user", "content": "(conversation continued)"})
        return merged

    def _needs_reasoning_content_backfill(self, reasoning_effort: str | None) -> bool:
        if not reasoning_effort or reasoning_effort.lower() in {"none", "minimal", "minimum"}:
            return False
        base = (self.api_base or "").lower()
        return bool(base and "anthropic.com" not in base)

    @staticmethod
    def _backfill_reasoning_content(messages: list[dict[str, Any]]) -> None:
        for msg in messages:
            if msg.get("role") == "assistant" and "reasoning_content" not in msg:
                msg["reasoning_content"] = ""

    @staticmethod
    def _parse_response(response: Any) -> LLMResponse:
        parts: list[str] = []
        tools: list[ToolCallRequest] = []
        reasoning_parts: list[str] = []
        thinking_blocks: list[dict[str, Any]] = []
        response_reasoning = getattr(response, "reasoning_content", None) or getattr(response, "reasoning", None)
        if isinstance(response_reasoning, str) and response_reasoning:
            reasoning_parts.append(response_reasoning)
        for block in response.content:
            if block.type == "text":
                parts.append(block.text)
            elif block.type == "tool_use":
                tools.append(ToolCallRequest(
                    id=block.id,
                    name=block.name,
                    arguments=block.input if isinstance(block.input, dict) else {},
                ))
            elif block.type in {"thinking", "reasoning", "reasoning_content"}:
                thinking = getattr(block, "thinking", None) or getattr(block, "reasoning", None) or getattr(block, "reasoning_content", None) or ""
                if not isinstance(thinking, str):
                    thinking = str(thinking)
                reasoning_parts.append(thinking)
                thinking_block = {
                    "type": "thinking",
                    "thinking": thinking,
                }
                signature = getattr(block, "signature", "")
                if signature:
                    thinking_block["signature"] = signature
                thinking_blocks.append(thinking_block)
            elif block.type == "redacted_thinking":
                thinking_blocks.append({
                    key: value
                    for key, value in getattr(block, "__dict__", {}).items()
                    if not key.startswith("_")
                } or {"type": "redacted_thinking"})
        usage = {}
        if getattr(response, "usage", None):
            usage = {
                "input": getattr(response.usage, "input_tokens", 0) or 0,
                "output": getattr(response.usage, "output_tokens", 0) or 0,
                "cache_read": getattr(response.usage, "cache_read_input_tokens", 0) or 0,
                "cache_create": getattr(response.usage, "cache_creation_input_tokens", 0) or 0,
            }
            if usage.get("cache_read") or usage.get("cache_create"):
                logger.debug(
                    f"[prompt-cache] read={usage['cache_read']} create={usage['cache_create']} input={usage['input']}"
                )
        return LLMResponse(
            content="".join(parts) or None,
            tool_calls=tools,
            finish_reason="tool_calls" if tools else (response.stop_reason or "stop"),
            usage=usage,
            reasoning_content="".join(reasoning_parts) or None,
            thinking_blocks=thinking_blocks or None,
        )
