from __future__ import annotations

import time
from dataclasses import dataclass, field
from typing import Any
from uuid import uuid4


def _new_id(prefix: str) -> str:
    return f"{prefix}_{uuid4().hex[:16]}"


@dataclass(frozen=True)
class ExternalAttachment:
    name: str
    mime: str = ""
    size: int = 0
    path: str = ""
    metadata: dict[str, Any] = field(default_factory=dict)

    def to_dict(self) -> dict[str, Any]:
        return {
            "name": self.name,
            "mime": self.mime,
            "size": self.size,
            "path": self.path,
            "metadata": dict(self.metadata),
        }


@dataclass(frozen=True)
class ExternalInbound:
    platform: str
    sender_id: str
    content: str
    external_message_id: str = ""
    target_id: str = ""
    attachments: list[ExternalAttachment] = field(default_factory=list)
    metadata: dict[str, Any] = field(default_factory=dict)
    received_at: float = field(default_factory=time.time)
    id: str = field(default_factory=lambda: _new_id("ext_in"))

    @property
    def dedupe_key(self) -> tuple[str, str] | None:
        message_id = self.external_message_id.strip()
        return (self.platform, message_id) if message_id else None

    def to_dict(self) -> dict[str, Any]:
        return {
            "id": self.id,
            "platform": self.platform,
            "sender_id": self.sender_id,
            "target_id": self.target_id,
            "external_message_id": self.external_message_id,
            "content": self.content,
            "attachments": [item.to_dict() for item in self.attachments],
            "metadata": dict(self.metadata),
            "received_at": self.received_at,
        }


@dataclass(frozen=True)
class ExternalOutbound:
    platform: str
    target_id: str
    content: str
    media: list[str] = field(default_factory=list)
    metadata: dict[str, Any] = field(default_factory=dict)
    id: str = field(default_factory=lambda: _new_id("ext_out"))
    created_at: float = field(default_factory=time.time)

    def to_dict(self) -> dict[str, Any]:
        return {
            "id": self.id,
            "platform": self.platform,
            "target_id": self.target_id,
            "content": self.content,
            "media": list(self.media),
            "metadata": dict(self.metadata),
            "created_at": self.created_at,
        }


@dataclass(frozen=True)
class ExternalDeliveryResult:
    ok: bool
    external_message_id: str = ""
    error: str = ""
    metadata: dict[str, Any] = field(default_factory=dict)

    def to_dict(self) -> dict[str, Any]:
        return {
            "ok": self.ok,
            "external_message_id": self.external_message_id,
            "error": self.error,
            "metadata": dict(self.metadata),
        }
