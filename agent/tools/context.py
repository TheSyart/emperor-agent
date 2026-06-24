from __future__ import annotations

from collections.abc import Awaitable, Callable
from dataclasses import dataclass
from pathlib import Path
from typing import Any

ToolEventEmitter = Callable[[dict[str, Any]], Awaitable[None]]


@dataclass
class ToolExecutionContext:
    root: Path
    turn_id: str | None = None
    parent_call_id: str | None = None
    emit: ToolEventEmitter | None = None
    loop: Any | None = None
    abort_signal: Any | None = None
    non_interactive: bool = False
