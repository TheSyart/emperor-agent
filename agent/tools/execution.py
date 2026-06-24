from __future__ import annotations

import asyncio
from collections.abc import Awaitable, Callable
from dataclasses import dataclass
from typing import Any, Literal

from loguru import logger

from ..providers import ToolCallRequest
from ..runtime import events as runtime_events
from .registry import ToolRegistry

StreamEmitter = Callable[[dict[str, Any]], Awaitable[None]]
ToolRunStatus = Literal["queued", "executing", "completed", "failed", "cancelled"]


@dataclass
class ToolRunState:
    id: str
    name: str
    arguments: dict[str, Any]
    status: ToolRunStatus = "queued"
    concurrency_safe: bool = False
    result: str | None = None
    error: str | None = None


class ToolExecutionEngine:
    def __init__(self, registry: ToolRegistry) -> None:
        self.registry = registry

    async def run_batch(
        self,
        tool_calls: list[ToolCallRequest],
        *,
        emit: StreamEmitter | None = None,
        run_one=None,
        propagate_exceptions: tuple[type[BaseException], ...] = (),
    ) -> list[dict[str, Any]]:
        states = [self._state_for_call(call) for call in tool_calls]
        if emit:
            for state in states:
                await emit(runtime_events.tool_run_queued(
                    id=state.id,
                    name=state.name,
                    arguments=state.arguments,
                ))
        results_by_id: dict[str, str] = {}
        index = 0
        while index < len(tool_calls):
            state = states[index]
            if state.concurrency_safe:
                group_calls: list[ToolCallRequest] = []
                group_states: list[ToolRunState] = []
                while index < len(tool_calls) and states[index].concurrency_safe:
                    group_calls.append(tool_calls[index])
                    group_states.append(states[index])
                    index += 1
                gathered = await asyncio.gather(
                    *[
                        self._run_state(
                            call,
                            item,
                            emit=emit,
                            run_one=run_one,
                            propagate_exceptions=propagate_exceptions,
                        )
                        for call, item in zip(group_calls, group_states, strict=True)
                    ],
                    return_exceptions=True,
                )
                for call, item, raw in zip(group_calls, group_states, gathered, strict=True):
                    if propagate_exceptions and isinstance(raw, propagate_exceptions):
                        raise raw
                    if isinstance(raw, Exception):
                        content = f"Error: {raw}"
                        item.status = "failed"
                        item.error = str(raw)
                        results_by_id[call.id] = content
                        if emit:
                            await emit(runtime_events.tool_run_failed(
                                id=call.id,
                                name=call.name,
                                message=str(raw),
                            ))
                    else:
                        results_by_id[call.id] = raw
                continue
            results_by_id[tool_calls[index].id] = await self._run_state(
                tool_calls[index],
                state,
                emit=emit,
                run_one=run_one,
                propagate_exceptions=propagate_exceptions,
            )
            index += 1
        return [
            {
                "role": "tool",
                "tool_call_id": call.id,
                "name": call.name,
                "content": results_by_id.get(call.id, ""),
            }
            for call in tool_calls
        ]

    def _state_for_call(self, call: ToolCallRequest) -> ToolRunState:
        tool = self.registry.get(call.name)
        concurrency_safe = bool(tool is not None and tool.is_concurrency_safe(call.arguments))
        return ToolRunState(
            id=call.id,
            name=call.name,
            arguments=call.arguments,
            concurrency_safe=concurrency_safe,
        )

    async def _run_state(
        self,
        call: ToolCallRequest,
        state: ToolRunState,
        *,
        emit: StreamEmitter | None,
        run_one,
        propagate_exceptions: tuple[type[BaseException], ...] = (),
    ) -> str:
        state.status = "executing"
        if emit:
            await emit(runtime_events.tool_run_started(id=state.id, name=state.name))
        try:
            if run_one is None:
                content = await asyncio.to_thread(self.registry.execute, call.name, call.arguments)
            else:
                content = await run_one(call)
        except Exception as exc:
            if propagate_exceptions and isinstance(exc, propagate_exceptions):
                raise
            logger.exception(f"Tool execution failed: {call.name}")
            state.status = "failed"
            state.error = str(exc)
            if emit:
                await emit(runtime_events.tool_run_failed(id=state.id, name=state.name, message=str(exc)))
            return f"Error: {exc}"
        state.status = "completed"
        state.result = str(content)
        if emit and not str(content).startswith("Error:"):
            await emit(runtime_events.tool_run_completed(
                id=state.id,
                name=state.name,
                summary=str(content),
            ))
        return str(content)
