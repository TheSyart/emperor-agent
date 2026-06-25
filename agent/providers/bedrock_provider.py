from __future__ import annotations

import asyncio
from typing import Any

from .base import DEFAULT_MAX_RETRIES, LLMProvider, LLMResponse


class BedrockProvider(LLMProvider):
    """Minimal AWS Bedrock Converse provider.

    This keeps the same provider slot as nanobot. It supports plain text
    messages; tool calling support should use Anthropic/OpenAI-compatible
    providers until a richer Bedrock converter is needed.
    """

    def __init__(self, **kwargs):
        super().__init__(**kwargs)
        try:
            import boto3
            from botocore.config import Config
        except ImportError as exc:
            raise RuntimeError("Bedrock provider requires boto3.") from exc
        self.client = boto3.client(
            "bedrock-runtime",
            config=Config(retries={"max_attempts": DEFAULT_MAX_RETRIES + 1, "mode": "standard"}),
        )

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
        if tools:
            raise RuntimeError(
                "Bedrock backend does not support tool calling, which the main agent loop "
                "requires; use an Anthropic/OpenAI-compatible provider."
            )
        response = await asyncio.to_thread(
            self.client.converse,
            **self._converse_request(model or self.default_model, messages, max_tokens, temperature),
        )
        text = ""
        for block in response.get("output", {}).get("message", {}).get("content", []):
            text += block.get("text", "")
        usage = response.get("usage") or {}
        return LLMResponse(
            content=text,
            usage={
                "input": usage.get("inputTokens", 0),
                "output": usage.get("outputTokens", 0),
            },
        )

    @classmethod
    def _converse_request(
        cls,
        model: str,
        messages: list[dict[str, Any]],
        max_tokens: int,
        temperature: float,
    ) -> dict[str, Any]:
        request: dict[str, Any] = {
            "modelId": model,
            "messages": cls._messages(messages),
            "inferenceConfig": {"maxTokens": max_tokens, "temperature": temperature},
        }
        system = cls._system_text(messages)
        if system:
            request["system"] = [{"text": system}]
        return request

    @staticmethod
    def _system_text(messages: list[dict[str, Any]]) -> str:
        parts = [str(msg.get("content") or "") for msg in messages if msg.get("role") == "system"]
        return "\n\n".join(p for p in parts if p)

    @staticmethod
    def _messages(messages: list[dict[str, Any]]) -> list[dict[str, Any]]:
        out = []
        for msg in messages:
            role = msg.get("role")
            if role == "system":
                continue
            if role == "tool":
                role = "user"
            out.append({
                "role": "assistant" if role == "assistant" else "user",
                "content": [{"text": str(msg.get("content") or "")}],
            })
        return out or [{"role": "user", "content": [{"text": "(empty)"}]}]
