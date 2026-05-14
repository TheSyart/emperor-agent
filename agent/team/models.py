from __future__ import annotations

import re
import time
import uuid
from dataclasses import dataclass, field
from enum import StrEnum
from typing import Any


SCHEMA_VERSION = 1
LEAD_ACTOR = "lead"
_NAME_RE = re.compile(r"^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,63}$")
_RESERVED_NAMES = {LEAD_ACTOR, "config", "inbox", "threads", "checkpoints", "cursors"}


class TeamStatus(StrEnum):
    IDLE = "idle"
    WORKING = "working"
    OFFLINE = "offline"
    SHUTDOWN = "shutdown"
    ERROR = "error"


def now_ts() -> float:
    return time.time()


def new_id(prefix: str) -> str:
    return f"{prefix}_{uuid.uuid4().hex[:12]}"


def validate_member_name(name: str) -> str:
    safe = str(name or "").strip()
    if not _NAME_RE.match(safe):
        raise ValueError(
            "member name must match [a-zA-Z0-9][a-zA-Z0-9_.-]{0,63}"
        )
    if safe in _RESERVED_NAMES:
        raise ValueError(f"member name {safe!r} is reserved")
    return safe


def validate_actor_name(name: str) -> str:
    actor = str(name or "").strip()
    if actor == LEAD_ACTOR:
        return actor
    return validate_member_name(actor)


@dataclass
class TeamMember:
    name: str
    role: str
    agent_type: str
    status: str = TeamStatus.IDLE.value
    created_at: float = field(default_factory=now_ts)
    updated_at: float = field(default_factory=now_ts)
    last_error: str | None = None

    @classmethod
    def from_dict(cls, raw: dict[str, Any]) -> "TeamMember":
        name = validate_member_name(str(raw.get("name") or ""))
        status = str(raw.get("status") or TeamStatus.IDLE.value)
        if status not in {item.value for item in TeamStatus}:
            status = TeamStatus.IDLE.value
        return cls(
            name=name,
            role=str(raw.get("role") or ""),
            agent_type=str(raw.get("agent_type") or raw.get("agentType") or ""),
            status=status,
            created_at=float(raw.get("created_at") or raw.get("createdAt") or now_ts()),
            updated_at=float(raw.get("updated_at") or raw.get("updatedAt") or now_ts()),
            last_error=(
                str(raw.get("last_error") or raw.get("lastError"))
                if raw.get("last_error") or raw.get("lastError")
                else None
            ),
        )

    def to_dict(self) -> dict[str, Any]:
        return {
            "name": self.name,
            "role": self.role,
            "agent_type": self.agent_type,
            "status": self.status,
            "created_at": self.created_at,
            "updated_at": self.updated_at,
            "last_error": self.last_error,
        }

    def touch(self, *, status: str | None = None, last_error: str | None = None) -> "TeamMember":
        return TeamMember(
            name=self.name,
            role=self.role,
            agent_type=self.agent_type,
            status=status or self.status,
            created_at=self.created_at,
            updated_at=now_ts(),
            last_error=last_error,
        )


@dataclass
class TeamMessage:
    id: str
    type: str
    from_actor: str
    to: str
    content: str
    timestamp: float = field(default_factory=now_ts)
    task_id: str | None = None
    in_reply_to: str | None = None
    meta: dict[str, Any] = field(default_factory=dict)

    @classmethod
    def create(
        cls,
        *,
        from_actor: str,
        to: str,
        content: str,
        type: str = "message",
        task_id: str | None = None,
        in_reply_to: str | None = None,
        meta: dict[str, Any] | None = None,
    ) -> "TeamMessage":
        return cls(
            id=new_id("msg"),
            type=type,
            from_actor=validate_actor_name(from_actor),
            to=validate_actor_name(to),
            content=str(content or ""),
            task_id=task_id,
            in_reply_to=in_reply_to,
            meta=meta or {},
        )

    @classmethod
    def from_dict(cls, raw: dict[str, Any]) -> "TeamMessage":
        meta = raw.get("meta") if isinstance(raw.get("meta"), dict) else {}
        return cls(
            id=str(raw.get("id") or new_id("msg")),
            type=str(raw.get("type") or "message"),
            from_actor=validate_actor_name(str(raw.get("from") or raw.get("from_actor") or "")),
            to=validate_actor_name(str(raw.get("to") or "")),
            content=str(raw.get("content") or ""),
            timestamp=float(raw.get("timestamp") or now_ts()),
            task_id=str(raw.get("task_id")) if raw.get("task_id") else None,
            in_reply_to=str(raw.get("in_reply_to")) if raw.get("in_reply_to") else None,
            meta=meta,
        )

    def to_dict(self) -> dict[str, Any]:
        return {
            "id": self.id,
            "type": self.type,
            "from": self.from_actor,
            "to": self.to,
            "content": self.content,
            "timestamp": self.timestamp,
            "task_id": self.task_id,
            "in_reply_to": self.in_reply_to,
            "meta": self.meta,
        }
