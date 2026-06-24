from __future__ import annotations

from dataclasses import dataclass, field
from enum import StrEnum
from typing import Any


class TransitionReason(StrEnum):
    EMPTY_RESPONSE_RETRY = "empty_response_retry"
    LENGTH_RECOVERY = "length_recovery"
    MAX_TURNS_REACHED = "max_turns_reached"
    NEXT_TURN = "next_turn"
    PLAN_PAUSE = "plan_pause"
    ASK_PAUSE = "ask_pause"
    TOOL_FOLLOWUP = "tool_followup"


@dataclass(frozen=True)
class QueryState:
    history: list[dict[str, Any]] = field(default_factory=list)
    turn_count: int = 0
    transition: str | None = None
    empty_retries: int = 0
    length_retries: int = 0
    paused: bool = False


@dataclass(frozen=True)
class QueryTransition:
    reason: str
    next_state: QueryState
    emit: list[dict[str, Any]] = field(default_factory=list)
    final_reply: str | None = None
