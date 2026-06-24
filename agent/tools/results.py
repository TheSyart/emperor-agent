from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any


@dataclass(frozen=True)
class ToolArtifact:
    path: str
    kind: str = "text"
    bytes: int | None = None
    metadata: dict[str, Any] = field(default_factory=dict)


@dataclass(frozen=True)
class ToolResult:
    model_content: str
    display_summary: str = ""
    raw_content: str | None = None
    artifacts: list[ToolArtifact] = field(default_factory=list)
    metadata: dict[str, Any] = field(default_factory=dict)
    is_error: bool = False

    @classmethod
    def from_text(cls, text: str, *, is_error: bool = False) -> ToolResult:
        summary = text if len(text) <= 500 else f"{text[:500]}\n...[summary truncated]"
        return cls(
            model_content=text,
            display_summary=summary,
            raw_content=text,
            is_error=is_error,
        )
