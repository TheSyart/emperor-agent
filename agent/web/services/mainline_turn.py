from __future__ import annotations

import asyncio
from typing import TYPE_CHECKING, Any

from loguru import logger

from ...control import TurnPaused
from ...runtime import events as runtime_events

if TYPE_CHECKING:
    from ..state import WebUIState


class MainlineTurnService:
    """Submit user-originated input into the single Emperor Agent mainline."""

    def __init__(self, state: WebUIState):
        self.state = state

    async def submit(
        self,
        *,
        content: Any,
        display_content: str,
        attachments: list[dict[str, Any]] | None = None,
        attachment_ids: list[str] | None = None,
        client_message_id: str = "",
        memory_extra: dict[str, Any] | None = None,
        turn_id: str | None = None,
        label: str = "Chat turn",
    ) -> str:
        """Append a turn to the one main history and run the agent.

        This intentionally has no session parameter. WebUI, scheduler-like
        triggers, and future external bridges all feed the same durable mainline.
        """

        resolved_turn_id = turn_id or self.state.new_turn_id()
        user_msg: dict[str, Any] = {
            "role": "user",
            "content": content,
            "turn_id": resolved_turn_id,
        }
        if attachment_ids:
            user_msg["attachments"] = list(attachment_ids)

        async with self.state.lock:
            self.state.history.append(user_msg)
            extra = dict(memory_extra or {})
            extra["turn_id"] = resolved_turn_id
            if attachment_ids:
                extra["attachments"] = list(attachment_ids)
            self.state.loop.memory.append_history("user", content, extra=extra)

            await self.state._broadcast_event(
                runtime_events.user_message(
                    content=display_content,
                    attachments=attachments or [],
                    client_message_id=client_message_id,
                ),
                turn_id=resolved_turn_id,
            )
            self.state.active_turn = True

            async def emit(event: dict[str, Any]) -> None:
                await self.state._broadcast_event(event, turn_id=resolved_turn_id)

            try:
                await self.state.active_tasks.run(
                    task_id=f"turn:{resolved_turn_id}",
                    kind="turn",
                    label=label,
                    awaitable=self.state.loop.runner.step_stream(
                        self.state.history,
                        emit,
                        turn_id=resolved_turn_id,
                    ),
                    turn_id=resolved_turn_id,
                )
            except TurnPaused:
                pass
            except asyncio.CancelledError:
                logger.info("{} {} cancelled", label, resolved_turn_id)
            finally:
                self.state.active_turn = False
                self.state.compact_runtime_events()

        return resolved_turn_id
