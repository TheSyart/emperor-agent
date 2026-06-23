from __future__ import annotations

import hashlib
import json
from pathlib import Path
from typing import Any

from .models import ToolResultReplacementRecord

DEFAULT_KEEP_RECENT = 10
DEFAULT_MIN_BYTES = 1500
DEFAULT_TOOL_RESULT_BUDGET = 8000
DEFAULT_TOOL_RESULT_TAIL = 200


def content_text_size(content: Any) -> int:
    if isinstance(content, str):
        return len(content)
    if isinstance(content, list):
        return sum(
            len(str(block.get("text", "")))
            for block in content
            if isinstance(block, dict) and block.get("type") == "text"
        )
    return len(str(content or ""))


def cap_tool_results(
    history: list[dict[str, Any]],
    *,
    per_call_limit: int = DEFAULT_TOOL_RESULT_BUDGET,
    tail_chars: int = DEFAULT_TOOL_RESULT_TAIL,
) -> tuple[list[dict[str, Any]], int]:
    out: list[dict[str, Any]] = []
    capped = 0
    head_chars = max(1, per_call_limit - tail_chars)
    for message in history:
        copied = dict(message)
        if copied.get("role") == "tool":
            text = str(copied.get("content", ""))
            if len(text) > per_call_limit:
                head = text[:head_chars]
                tail = text[-tail_chars:]
                copied["content"] = f"{head}\n...[truncated, total {len(text)} chars]...\n{tail}"
                capped += 1
        out.append(copied)
    return out, capped


def shrink_old_tool_results(
    history: list[dict[str, Any]],
    *,
    keep_recent: int = DEFAULT_KEEP_RECENT,
    min_bytes: int = DEFAULT_MIN_BYTES,
) -> tuple[list[dict[str, Any]], int]:
    cutoff = max(0, len(history) - keep_recent)
    out: list[dict[str, Any]] = []
    shrunk = 0
    for index, message in enumerate(history):
        copied = dict(message)
        if (
            copied.get("role") == "tool"
            and index < cutoff
            and content_text_size(copied.get("content")) > min_bytes
        ):
            name = copied.get("name") or copied.get("tool_call_id") or "tool"
            size = content_text_size(copied.get("content"))
            copied["content"] = f"[shrunk] {name} → {size} chars omitted"
            shrunk += 1
        out.append(copied)
    return out, shrunk


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
