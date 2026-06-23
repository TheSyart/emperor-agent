"""Compactor: summarize old history into today's episode + update MEMORY.local.md / USER.local.md."""
from __future__ import annotations

import json
import re
from collections.abc import Callable
from dataclasses import dataclass
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Any

from loguru import logger

from .memory import MemoryStore
from .providers import LLMProvider
from .providers.base import run_sync

_UTC8 = timezone(timedelta(hours=8))

_PROMPT_FILE = Path(__file__).parent.parent / "templates" / "agent" / "compact_prompt.md"
_PROMPT_TEMPLATE = _PROMPT_FILE.read_text(encoding="utf-8")
_REQUIRED_TAGS = ("episode", "updated_memory", "updated_user")
_REPAIR_PROMPT = """The previous memory compaction response was invalid.
Return only the required XML blocks, with no commentary. Required tags:
<episode>...</episode>
<updated_memory>...</updated_memory>
<updated_user>...</updated_user>

Invalid response:
<invalid_response>
{invalid_response}
</invalid_response>
"""


def _extract(tag: str, text: str) -> str | None:
    m = re.search(rf"<{tag}>(.*?)</{tag}>", text, re.DOTALL)
    return m.group(1).strip() if m else None


@dataclass(frozen=True)
class CompactionResult:
    episode: str
    updated_memory: str
    updated_user: str


@dataclass(frozen=True)
class _CompactionCall:
    provider: LLMProvider
    model: str
    provider_name: str | None
    model_role: str
    max_tokens: int
    temperature: float
    reasoning_effort: str | None
    route_reason: str
    used_fallback: bool = False
    fallback_reason: str = ""


class CompactionParseError(ValueError):
    def __init__(self, missing_tags: list[str], text: str):
        super().__init__(f"memory compaction response missing tags: {', '.join(missing_tags)}")
        self.missing_tags = missing_tags
        self.text = text


def parse_compaction_result(text: str) -> CompactionResult:
    values = {tag: _extract(tag, text) for tag in _REQUIRED_TAGS}
    missing = [tag for tag, value in values.items() if not value]
    if missing:
        raise CompactionParseError(missing, text)
    return CompactionResult(
        episode=str(values["episode"]),
        updated_memory=str(values["updated_memory"]),
        updated_user=str(values["updated_user"]),
    )


def _messages_to_text(
    messages: list[dict[str, Any]],
    runtime_context_provider: Callable[[list[dict[str, Any]]], dict[str, Any] | str | None] | None = None,
) -> str:
    """Flatten OpenAI-style history messages into a readable transcript."""
    parts: list[str] = []
    runtime_context = runtime_context_provider(messages) if runtime_context_provider is not None else None
    if runtime_context:
        if isinstance(runtime_context, dict):
            content = runtime_context.get("content")
        else:
            content = runtime_context
        if content:
            parts.append(f"[system:runtime_context] {str(content)[:4000]}")
    for msg in messages:
        role = msg.get("role", "?")
        content = msg.get("content", "")
        if role == "tool":
            snippet = str(content or "")[:500]
            name = msg.get("name") or msg.get("tool_call_id") or "tool"
            parts.append(f"[tool_result:{name}] {snippet}")
            continue
        if isinstance(content, str) and content:
            parts.append(f"[{role}] {content}")
        elif isinstance(content, list):
            parts.extend(_content_blocks_to_text(role, content))

        for tool_call in msg.get("tool_calls") or []:
            fn = tool_call.get("function") or {}
            name = fn.get("name", "")
            args = fn.get("arguments", "{}")
            parts.append(f"[assistant:tool_call] {name} {args}")

    return "\n".join(parts)


def _content_blocks_to_text(role: str, blocks: list[Any]) -> list[str]:
    parts: list[str] = []
    for block in blocks:
        btype = getattr(block, "type", None) or (block.get("type") if isinstance(block, dict) else None)
        if btype == "text":
            text = getattr(block, "text", None) or (block.get("text") if isinstance(block, dict) else "")
            parts.append(f"[{role}] {text}")
        elif btype in {"tool_use", "tool_call"}:
            name = getattr(block, "name", None) or block.get("name", "")
            parts.append(f"[{role}:tool_call] {name}")
        elif btype == "tool_result":
            c = getattr(block, "content", None) or block.get("content", "")
            if isinstance(c, list):
                c = " ".join(
                    (getattr(x, "text", None) or (x.get("text") if isinstance(x, dict) else str(x)) or "")
                    for x in c
                )
            parts.append(f"[{role}:tool_result] {str(c)[:500]}")
    return parts


class Compactor:
    K = 10

    def __init__(
        self,
        provider: LLMProvider,
        model: str,
        memory_store: MemoryStore,
        max_tokens: int = 4000,
        temperature: float = 0.1,
        reasoning_effort: str | None = None,
        provider_name: str | None = None,
        token_tracker=None,
        usage_type: str = "memory_compaction",
        model_role: str = "main",
        fallback_provider: LLMProvider | None = None,
        fallback_model: str | None = None,
        fallback_provider_name: str | None = None,
        fallback_generation: Any | None = None,
        fallback_model_role: str = "main",
        route_reason: str = "memory_compaction",
        fallback_route_reason: str = "",
        runtime_context_provider: Callable[[list[dict[str, Any]]], dict[str, Any] | str | None] | None = None,
    ):
        self.provider = provider
        self.model = model
        self.memory = memory_store
        self.max_tokens = max_tokens
        self.temperature = temperature
        self.reasoning_effort = reasoning_effort
        self.provider_name = provider_name
        self.token_tracker = token_tracker
        self.usage_type = usage_type
        self.model_role = model_role
        self.fallback_provider = fallback_provider
        self.fallback_model = fallback_model
        self.fallback_provider_name = fallback_provider_name
        self.fallback_generation = fallback_generation
        self.fallback_model_role = fallback_model_role
        self.route_reason = route_reason
        self.fallback_route_reason = fallback_route_reason or f"{route_reason}:fallback_main"
        self.runtime_context_provider = runtime_context_provider

    def compact(self, history: list[dict[str, Any]]) -> list[dict[str, Any]]:
        return run_sync(self.compact_async(history))

    async def compact_async(self, history: list[dict[str, Any]]) -> list[dict[str, Any]]:
        """Compress history[:-K]; write episode + memory + user; return history[-K:]."""
        if len(history) <= self.K:
            return history

        old = history[: -self.K]
        recent = history[-self.K :]
        if not await self._compact_messages(old):
            return history
        self.memory.append_compact_marker(active_history=recent)
        logger.info(f"[Compacted: {len(old)} turns -> today episode + MEMORY updated]")
        return recent

    def compact_startup(self, history: list[dict[str, Any]]) -> None:
        run_sync(self.compact_startup_async(history))

    async def compact_startup_async(self, history: list[dict[str, Any]]) -> None:
        """Archive all unarchived startup history without keeping recent turns."""
        if len(history) < 2:
            return
        if not await self._compact_messages(history):
            return
        self.memory.append_compact_marker(active_history=[])
        logger.info(f"[Startup compacted: {len(history)} unarchived turns -> MEMORY updated]")

    async def _compact_messages(self, messages: list[dict[str, Any]]) -> bool:
        prompt = _PROMPT_TEMPLATE.format(
            old_conversation=_messages_to_text(messages, self.runtime_context_provider),
            current_memory=self.memory.read_memory() or "(空)",
            current_user=self.memory.read_user() or "(空)",
            today_episode=self.memory.read_today_episode() or "(空)",
            now_hhmm=datetime.now(_UTC8).strftime("%H:%M"),
        )
        call, resp = await self._call_with_fallback(prompt)
        text = resp.content or ""
        try:
            parsed = parse_compaction_result(text)
        except CompactionParseError as exc:
            logger.warning("memory compaction parse failed, retrying repair: {}", exc)
            repair_prompt = _REPAIR_PROMPT.format(invalid_response=text[:12_000])
            repair_resp = await self._chat(call, repair_prompt)
            self._record_usage(call, repair_resp.usage, prompt=repair_prompt)
            try:
                parsed = parse_compaction_result(repair_resp.content or "")
            except CompactionParseError as repair_exc:
                self._record_diagnostic(repair_exc)
                logger.warning("memory compaction repair failed: {}", repair_exc)
                return False

        self.memory.append_episode(parsed.episode)
        self.memory.write_memory(parsed.updated_memory)
        self.memory.write_user(parsed.updated_user)
        return True

    async def _call_with_fallback(self, prompt: str) -> tuple[_CompactionCall, Any]:
        call = _CompactionCall(
            provider=self.provider,
            model=self.model,
            provider_name=self.provider_name,
            model_role=self.model_role,
            max_tokens=self.max_tokens,
            temperature=self.temperature,
            reasoning_effort=self.reasoning_effort,
            route_reason=self.route_reason,
        )
        try:
            resp = await self._chat(call, prompt)
            self._record_usage(call, resp.usage, prompt=prompt)
            return call, resp
        except Exception as exc:
            if not (self.fallback_provider and self.fallback_model):
                raise
            logger.warning(
                "memory compaction fallback: {} / {} -> {} because {}",
                self.provider_name,
                self.model,
                self.fallback_model,
                exc,
            )
            generation = self.fallback_generation
            fallback_call = _CompactionCall(
                provider=self.fallback_provider,
                model=self.fallback_model,
                provider_name=self.fallback_provider_name,
                model_role=self.fallback_model_role,
                max_tokens=min(
                    self.max_tokens,
                    int(getattr(generation, "max_tokens", self.max_tokens) or self.max_tokens),
                ),
                temperature=getattr(generation, "temperature", self.temperature),
                reasoning_effort=getattr(generation, "reasoning_effort", self.reasoning_effort),
                route_reason=self.fallback_route_reason,
                used_fallback=True,
                fallback_reason=str(exc),
            )
            resp = await self._chat(fallback_call, prompt)
            self._record_usage(fallback_call, resp.usage, prompt=prompt)
            return fallback_call, resp

    @staticmethod
    async def _chat(call: _CompactionCall, prompt: str):
        return await call.provider.chat(
            model=call.model,
            max_tokens=call.max_tokens,
            temperature=call.temperature,
            reasoning_effort=call.reasoning_effort,
            messages=[{"role": "user", "content": prompt}],
            tools=None,
        )

    def _record_usage(self, call: _CompactionCall, usage: dict[str, int], *, prompt: str) -> None:
        if not (self.token_tracker and usage):
            return
        self.token_tracker.record(
            call.model,
            usage,
            provider=call.provider_name,
            usage_type=self.usage_type,
            model_role=call.model_role,
            route_reason=call.route_reason,
            used_fallback=call.used_fallback,
            fallback_reason=call.fallback_reason,
            estimated_input_tokens=max(1, len(prompt) // 3),
        )

    def _record_diagnostic(self, exc: CompactionParseError) -> None:
        payload = {
            "ts": datetime.now(_UTC8).isoformat(timespec="seconds"),
            "event": "compact_parse_failed",
            "missing_tags": exc.missing_tags,
            "response_snippet": exc.text[:2000],
        }
        try:
            path = self.memory.memory_dir / "compact_diagnostics.jsonl"
            path.parent.mkdir(parents=True, exist_ok=True)
            with path.open("a", encoding="utf-8") as f:
                f.write(json.dumps(payload, ensure_ascii=False) + "\n")
        except Exception as write_exc:
            logger.warning("memory compaction diagnostic write failed: {}", write_exc)
