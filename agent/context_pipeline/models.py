from __future__ import annotations

from dataclasses import asdict, dataclass


@dataclass(frozen=True)
class ToolResultReplacementRecord:
    turn_id: str
    tool_call_id: str
    tool_name: str
    artifact_path: str
    preview: str
    original_chars: int

    def to_dict(self) -> dict:
        return asdict(self)
