from __future__ import annotations

from collections.abc import Awaitable, Callable
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

ToolEventEmitter = Callable[[dict[str, Any]], Awaitable[None]]


@dataclass
class ToolExecutionContext:
    root: Path
    arguments: dict[str, Any] = field(default_factory=dict)
    turn_id: str | None = None
    parent_call_id: str | None = None
    emit: ToolEventEmitter | None = None
    loop: Any | None = None
    abort_signal: Any | None = None
    non_interactive: bool = False
