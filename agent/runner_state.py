from __future__ import annotations

from dataclasses import dataclass, field
from enum import StrEnum
from typing import Any


class TurnPhase(StrEnum):
    STARTED = "started"
    CHECKPOINT = "checkpoint"
    MODEL_REQUEST = "model_request"
    MODEL_RESPONSE = "model_response"
    TOOL_BATCH_START = "tool_batch_start"
    TOOL_BATCH_DONE = "tool_batch_done"
    EMPTY_RETRY = "empty_retry"
    LENGTH_RETRY = "length_retry"
    TODO_FOLLOWUP = "todo_followup"
    COMPACT_CHECK = "compact_check"
    PAUSED = "paused"
    MAX_TURNS = "max_turns"
    COMPLETED = "completed"


@dataclass(frozen=True)
class TurnPhaseEvent:
    phase: str
    sequence: int
    iteration: int
    turn_id: str | None = None
    detail: dict[str, Any] = field(default_factory=dict)

    def to_runtime_event(self) -> dict[str, Any]:
        event: dict[str, Any] = {
            "event": "turn_phase",
            "phase": self.phase,
            "sequence": self.sequence,
            "iteration": self.iteration,
        }
        if self.turn_id:
            event["turn_id"] = self.turn_id
        if self.detail:
            event["detail"] = self.detail
        return event


@dataclass
class TurnState:
    turn_id: str | None = None
    iteration: int = 0
    sequence: int = 0
    phase: TurnPhase = TurnPhase.STARTED

    def start_iteration(self) -> int:
        self.iteration += 1
        return self.iteration

    def transition(self, phase: TurnPhase | str, *, detail: dict[str, Any] | None = None) -> TurnPhaseEvent:
        normalized = phase if isinstance(phase, TurnPhase) else TurnPhase(str(phase))
        self.phase = normalized
        self.sequence += 1
        return TurnPhaseEvent(
            phase=normalized.value,
            sequence=self.sequence,
            iteration=self.iteration,
            turn_id=self.turn_id,
            detail=detail or {},
        )
