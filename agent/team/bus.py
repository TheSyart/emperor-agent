from __future__ import annotations

import json
from threading import Lock, RLock
from typing import Any

from .models import TeamMessage, validate_actor_name
from .store import TeamStore


class MessageBus:
    def __init__(self, store: TeamStore):
        self.store = store
        self._locks: dict[str, RLock] = {}
        self._locks_guard = Lock()

    def append(self, message: TeamMessage) -> TeamMessage:
        actor = validate_actor_name(message.to)
        with self._lock_for(actor):
            path = self.store.inbox_path(actor)
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
        safe = validate_actor_name(actor)
        with self._lock_for(safe):
            messages = self._all_messages_unlocked(safe)
            cursor = min(self.store.read_cursor(safe), len(messages))
            if limit <= 0:
                unread = messages[cursor:]
            else:
                unread = messages[cursor:cursor + limit]
            if mark_read and unread:
                self.store.write_cursor(safe, cursor + len(unread))
            return unread

    def recent(self, actor: str, *, limit: int = 50) -> list[TeamMessage]:
        safe = validate_actor_name(actor)
        with self._lock_for(safe):
            messages = self._all_messages_unlocked(safe)
            if limit <= 0:
                return messages
            return messages[-limit:]

    def unread_count(self, actor: str) -> int:
        safe = validate_actor_name(actor)
        with self._lock_for(safe):
            messages = self._all_messages_unlocked(safe)
            cursor = min(self.store.read_cursor(safe), len(messages))
            return max(0, len(messages) - cursor)

    def all_messages(self, actor: str) -> list[TeamMessage]:
        safe = validate_actor_name(actor)
        with self._lock_for(safe):
            return self._all_messages_unlocked(safe)

    def _all_messages_unlocked(self, actor: str) -> list[TeamMessage]:
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

    def _lock_for(self, actor: str) -> RLock:
        safe = validate_actor_name(actor)
        with self._locks_guard:
            if safe not in self._locks:
                self._locks[safe] = RLock()
            return self._locks[safe]
