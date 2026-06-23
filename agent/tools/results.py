from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any


@dataclass(frozen=True)
class ToolArtifact:
    path: str
    kind: str = "text"
    bytes: int | None = None
    metadata: dict[str, Any] = field(default_factory=dict)

    def to_dict(self) -> dict[str, Any]:
        payload: dict[str, Any] = {
            "path": self.path,
            "kind": self.kind,
        }
        if self.bytes is not None:
            payload["bytes"] = self.bytes
        if self.metadata:
            payload["metadata"] = self.metadata
        return payload


@dataclass(frozen=True)
class ToolResult:
    model_content: str
    display_summary: str = ""
    raw_content: str | None = None
    artifacts: list[ToolArtifact] = field(default_factory=list)
    metadata: dict[str, Any] = field(default_factory=dict)
    is_error: bool = False

    @property
    def summary(self) -> str:
        return self.display_summary or self.model_content

    def artifact_payloads(self) -> list[dict[str, Any]]:
        return [artifact.to_dict() for artifact in self.artifacts]

    @classmethod
    def from_text(cls, text: str, *, is_error: bool = False) -> ToolResult:
        summary = text if len(text) <= 500 else f"{text[:500]}\n...[summary truncated]"
        return cls(
            model_content=text,
            display_summary=summary,
            raw_content=text,
            is_error=is_error,
        )
