from __future__ import annotations

import json
from typing import Any

from .models import TeamMessage, validate_actor_name
from .store import TeamStore


class MessageBus:
    def __init__(self, store: TeamStore):
        self.store = store

    def append(self, message: TeamMessage) -> TeamMessage:
        validate_actor_name(message.to)
        path = self.store.inbox_path(message.to)
        path.parent.mkdir(parents=True, exist_ok=True)
        with path.open("a", encoding="utf-8") as f:
            f.write(json.dumps(message.to_dict(), ensure_ascii=False) + "\n")
        return message

    def send(
        self,
        *,
        from_actor: str,
        to: str,
        content: str,
        type: str = "message",
        task_id: str | None = None,
        in_reply_to: str | None = None,
        meta: dict[str, Any] | None = None,
    ) -> TeamMessage:
        return self.append(TeamMessage.create(
            from_actor=from_actor,
            to=to,
            content=content,
            type=type,
            task_id=task_id,
            in_reply_to=in_reply_to,
            meta=meta,
        ))

    def read(self, actor: str, *, limit: int = 20, mark_read: bool = True) -> list[TeamMessage]:
        messages = self.all_messages(actor)
        cursor = min(self.store.read_cursor(actor), len(messages))
        if limit <= 0:
            unread = messages[cursor:]
        else:
            unread = messages[cursor:cursor + limit]
        if mark_read and unread:
            self.store.write_cursor(actor, cursor + len(unread))
        return unread

    def recent(self, actor: str, *, limit: int = 50) -> list[TeamMessage]:
        messages = self.all_messages(actor)
        if limit <= 0:
            return messages
        return messages[-limit:]

    def unread_count(self, actor: str) -> int:
        messages = self.all_messages(actor)
        cursor = min(self.store.read_cursor(actor), len(messages))
        return max(0, len(messages) - cursor)

    def all_messages(self, actor: str) -> list[TeamMessage]:
        path = self.store.inbox_path(actor)
        if not path.exists():
            return []
        out: list[TeamMessage] = []
        with path.open("r", encoding="utf-8") as f:
            for line in f:
                line = line.strip()
                if not line:
                    continue
                try:
                    raw = json.loads(line)
                    if isinstance(raw, dict):
                        out.append(TeamMessage.from_dict(raw))
                except (json.JSONDecodeError, ValueError):
                    continue
        return out
