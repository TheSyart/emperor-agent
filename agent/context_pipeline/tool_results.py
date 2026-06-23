from __future__ import annotations

import hashlib
import json
from pathlib import Path

from .models import ToolResultReplacementRecord


class ToolResultStore:
    def __init__(self, root: Path | str) -> None:
        self.root = Path(root).resolve()
        self.dir = self.root / "memory" / "tool-results"
        self.dir.mkdir(parents=True, exist_ok=True)

    def persist_large_result(
        self,
        turn_id: str,
        tool_call_id: str,
        tool_name: str,
        content: str,
        *,
        preview_chars: int = 1000,
    ) -> ToolResultReplacementRecord:
        digest = hashlib.sha256(f"{turn_id}:{tool_call_id}:{content}".encode()).hexdigest()[:16]
        artifact = self.dir / f"{digest}.txt"
        meta = self.dir / f"{digest}.json"
        if not artifact.exists():
            artifact.write_text(content, encoding="utf-8")
        record = ToolResultReplacementRecord(
            turn_id=turn_id,
            tool_call_id=tool_call_id,
            tool_name=tool_name,
            artifact_path=str(artifact.relative_to(self.root)),
            preview=content[:preview_chars],
            original_chars=len(content),
        )
        if not meta.exists():
            meta.write_text(json.dumps(record.to_dict(), ensure_ascii=False, indent=2), encoding="utf-8")
        return record
