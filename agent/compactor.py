"""Compactor: summarize old history into today's episode + update MEMORY.local.md / USER.local.md."""
from __future__ import annotations

import re
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Any

from .memory import MemoryStore
from .providers import LLMProvider
from .providers.base import run_sync


_UTC8 = timezone(timedelta(hours=8))

_PROMPT_FILE = Path(__file__).parent.parent / "templates" / "agent" / "compact_prompt.md"
_PROMPT_TEMPLATE = _PROMPT_FILE.read_text(encoding="utf-8")


def _extract(tag: str, text: str) -> str | None:
    m = re.search(rf"<{tag}>(.*?)</{tag}>", text, re.DOTALL)
    return m.group(1).strip() if m else None


def _messages_to_text(messages: list[dict[str, Any]]) -> str:
    """Flatten OpenAI-style history messages into a readable transcript."""
    parts: list[str] = []
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

    def compact(self, history: list[dict[str, Any]]) -> list[dict[str, Any]]:
        return run_sync(self.compact_async(history))

    async def compact_async(self, history: list[dict[str, Any]]) -> list[dict[str, Any]]:
        """Compress history[:-K]; write episode + memory + user; return history[-K:]."""
        if len(history) <= self.K:
            return history

        old = history[: -self.K]
        recent = history[-self.K :]
        await self._compact_messages(old)
        print(f"[Compacted: {len(old)} turns -> today episode + MEMORY updated]")
        return recent

    def compact_startup(self, history: list[dict[str, Any]]) -> None:
        run_sync(self.compact_startup_async(history))

    async def compact_startup_async(self, history: list[dict[str, Any]]) -> None:
        """Archive all unarchived startup history without keeping recent turns."""
        if len(history) < 2:
            return
        await self._compact_messages(history)
        print(f"[Startup compacted: {len(history)} unarchived turns -> MEMORY updated]")

    async def _compact_messages(self, messages: list[dict[str, Any]]) -> None:
        prompt = _PROMPT_TEMPLATE.format(
            old_conversation=_messages_to_text(messages),
            current_memory=self.memory.read_memory() or "(空)",
            current_user=self.memory.read_user() or "(空)",
            today_episode=self.memory.read_today_episode() or "(空)",
            now_hhmm=datetime.now(_UTC8).strftime("%H:%M"),
        )
        resp = await self.provider.chat(
            model=self.model,
            max_tokens=self.max_tokens,
            temperature=self.temperature,
            reasoning_effort=self.reasoning_effort,
            messages=[{"role": "user", "content": prompt}],
            tools=None,
        )
        if self.token_tracker and resp.usage:
            self.token_tracker.record(
                self.model,
                resp.usage,
                provider=self.provider_name,
                usage_type=self.usage_type,
            )
        text = resp.content or ""

        if episode := _extract("episode", text):
            self.memory.append_episode(episode)
        if new_memory := _extract("updated_memory", text):
            self.memory.write_memory(new_memory)
        if new_user := _extract("updated_user", text):
            self.memory.write_user(new_user)
        self.memory.append_compact_marker()
