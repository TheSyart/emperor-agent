from __future__ import annotations

import asyncio
from collections.abc import Awaitable, Callable
from typing import Any

from loguru import logger

from .context_pipeline import ContextPipeline
from .control import ClarificationAssessment, TurnPaused, parse_pause_result
from .providers import LLMProvider, ToolCallRequest
from .providers.base import is_truncated, run_sync
from .runner_model import ModelCaller
from .runner_state import TurnPhase, TurnState
from .tools.execution import ToolExecutionEngine
from .tools.registry import ToolRegistry

StreamEmitter = Callable[[dict[str, Any]], Awaitable[None]]


# —— 上下文治理 / 错误恢复参数 ——
_SHRINK_KEEP_RECENT = 10              # 最近 N 条工具消息保留原文
_SHRINK_MIN_BYTES = 1500              # 小于此字节的工具结果不动
_TOOL_RESULT_BUDGET = 8000            # 单条工具结果硬上限
_TOOL_RESULT_HEAD = _TOOL_RESULT_BUDGET - 200
_TOOL_RESULT_TAIL = 200
_MAX_EMPTY_RETRIES = 2
_MAX_LENGTH_RECOVERIES = 3
_ASK_GUARD_BLOCK = (
    "Error: Ask Guard requires `ask_user` before this high-impact action. "
    "Use read-only tools if needed, then ask the user to resolve the ambiguity."
)


class AgentRunner:
    def __init__(
        self,
        provider: LLMProvider,
        model: str,
        registry: ToolRegistry,
        system_prompt: str,
        max_tokens: int = 20000,
        temperature: float = 0.1,
        reasoning_effort: str | None = None,
        provider_name: str | None = None,
        model_role: str = "main",
        route_reason: str = "",
        route_estimated_tokens: int | None = None,
        fallback_provider: LLMProvider | None = None,
        fallback_model: str | None = None,
        fallback_provider_name: str | None = None,
        fallback_generation: Any | None = None,
        fallback_model_role: str = "main",
        usage_type: str = "main_agent",
        memory_store=None,
        token_tracker=None,
        compactor=None,
        todo_store=None,
        control_manager=None,
        max_context: int = 200_000,
        compact_threshold: float = 0.7,
        max_turns: int | None = None,
        context_pipeline: ContextPipeline | None = None,
        tool_execution_engine: ToolExecutionEngine | None = None,
    ):
        self.provider = provider
        self.model = model
        self.registry = registry
        self.system_prompt = system_prompt
        self.max_tokens = max_tokens
        self.temperature = temperature
        self.reasoning_effort = reasoning_effort
        self.provider_name = provider_name
        self.model_role = model_role
        self.route_reason = route_reason
        self.route_estimated_tokens = route_estimated_tokens
        self.fallback_provider = fallback_provider
        self.fallback_model = fallback_model
        self.fallback_provider_name = fallback_provider_name
        self.fallback_generation = fallback_generation
        self.fallback_model_role = fallback_model_role
        self._last_model_call = {
            "model": model,
            "provider": provider_name,
            "model_role": model_role,
            "route_reason": route_reason,
            "route_estimated_tokens": route_estimated_tokens,
            "estimated_input_tokens": None,
            "used_fallback": False,
        }
        self._last_estimated_input_tokens: int | None = None
        self.usage_type = usage_type
        self.memory_store = memory_store
        self.token_tracker = token_tracker
        self.compactor = compactor
        self.todo_store = todo_store
        self.control_manager = control_manager
        self.max_context = max_context
        self.compact_threshold = compact_threshold
        self.max_turns = max_turns
        self.context_pipeline = context_pipeline or ContextPipeline()
        self.tool_execution_engine = tool_execution_engine or ToolExecutionEngine(registry)

    def step(self, history: list[dict[str, Any]]) -> str:
        """Run one full turn synchronously. Mutates `history` in place."""
        return run_sync(self.step_async(history))

    async def step_stream(
        self,
        history: list[dict[str, Any]],
        emit: StreamEmitter,
        *,
        turn_id: str | None = None,
    ) -> str:
        """Run one full turn and stream UI-friendly events."""
        reply = await self.step_async(history, emit=emit, turn_id=turn_id)
        await emit({"event": "assistant_done", "content": reply})
        return reply

    async def step_async(
        self,
        history: list[dict[str, Any]],
        emit: StreamEmitter | None = None,
        *,
        turn_id: str | None = None,
    ) -> str:
        turn_state = TurnState(turn_id=turn_id)
        await self._emit_turn_phase(
            turn_state,
            TurnPhase.STARTED,
            emit,
            detail={"history_length": len(history)},
        )
        turns = 0
        final_parts: list[str] = []
        empty_retries = 0
        length_retries = 0
        clarification = self._assess_clarification(history)
        # 进入 turn 时先记一次快照，防止 LLM 还没回应就被杀
        if self.memory_store is not None:
            self.memory_store.write_checkpoint(history)
            await self._emit_turn_phase(turn_state, TurnPhase.CHECKPOINT, emit, detail={"reason": "turn_start"})
        while True:
            if self.max_turns is not None and turns >= self.max_turns:
                reply = f"（达到 max_turns={self.max_turns} 上限，未办妥；history 中已有部分进展）"
                message = {"role": "assistant", "content": reply}
                if turn_id:
                    message["turn_id"] = turn_id
                history.append(message)
                if self.memory_store:
                    extra = {"turn_id": turn_id} if turn_id else None
                    self.memory_store.append_history("assistant", reply, extra=extra)
                    self.memory_store.clear_checkpoint()
                await self._emit_turn_phase(turn_state, TurnPhase.MAX_TURNS, emit, detail={"max_turns": self.max_turns})
                return reply
            turns = turn_state.start_iteration()

            await self._emit_turn_phase(turn_state, TurnPhase.MODEL_REQUEST, emit)
            response = await self._ask_model(history, emit, clarification=clarification)
            await self._emit_turn_phase(
                turn_state,
                TurnPhase.MODEL_RESPONSE,
                emit,
                detail={
                    "finish_reason": response.finish_reason,
                    "tool_call_count": len(response.tool_calls),
                    "content_chars": len(response.content or ""),
                },
            )
            if response.usage:
                call_meta = self._last_model_call
                if self.token_tracker:
                    self.token_tracker.record(
                        str(call_meta.get("model") or self.model),
                        response.usage,
                        provider=str(call_meta.get("provider") or self.provider_name or "unknown"),
                        usage_type=self.usage_type,
                        model_role=str(call_meta.get("model_role") or self.model_role),
                        route_reason=str(call_meta.get("route_reason") or self.route_reason or ""),
                        used_fallback=bool(call_meta.get("used_fallback")),
                        fallback_reason=str(call_meta.get("fallback_reason") or ""),
                        estimated_input_tokens=_optional_int(call_meta.get("estimated_input_tokens")),
                        route_estimated_tokens=_optional_int(call_meta.get("route_estimated_tokens")),
                    )
                if emit:
                    await emit({
                        "event": "context_usage",
                        "used": _context_used_from_usage(response.usage),
                        "max": self.max_context,
                        "threshold": int(self.max_context * self.compact_threshold),
                        "usage_type": self.usage_type,
                        "model_role": call_meta.get("model_role"),
                        "model": call_meta.get("model"),
                        "provider": call_meta.get("provider"),
                        "route_reason": call_meta.get("route_reason"),
                        "estimated_input_tokens": call_meta.get("estimated_input_tokens"),
                    })
            if self.memory_store:
                last_user = next((m for m in reversed(history) if m.get("role") == "user"), None)
                user_input = str(last_user.get("content", ""))[:500] if last_user else ""
                ai_output = str(response.content or "")[:500]
                cmd_event = None
                if user_input.startswith("/"):
                    cmd_event = user_input.split()[0]
                input_tokens = int(response.usage.get("input", 0) or 0) if response.usage else 0
                output_tokens = int(response.usage.get("output", 0) or 0) if response.usage else 0
                self.memory_store.append_history(
                    "model_call",
                    f"{self.model} call: input={input_tokens} output={output_tokens}",
                    extra={
                        "type": "model_call",
                        "model": self._last_model_call.get("model") or self.model,
                        "provider": self._last_model_call.get("provider") or self.provider_name,
                        "model_role": self._last_model_call.get("model_role") or self.model_role,
                        "route_reason": self._last_model_call.get("route_reason") or self.route_reason,
                        "used_fallback": bool(self._last_model_call.get("used_fallback")),
                        "fallback_reason": self._last_model_call.get("fallback_reason") or "",
                        "estimated_input_tokens": self._last_model_call.get("estimated_input_tokens"),
                        "route_estimated_tokens": self._last_model_call.get("route_estimated_tokens"),
                        "usage_type": self.usage_type,
                        "user_input": user_input,
                        "ai_output": ai_output,
                        "command_event": cmd_event,
                        "input_tokens": input_tokens,
                        "output_tokens": output_tokens,
                        **({"turn_id": turn_id} if turn_id else {}),
                    },
                )

            if response.should_execute_tools:
                empty_retries = 0
                length_retries = 0
                assistant_content = response.content or ""
                if assistant_content:
                    final_parts.append(assistant_content)
                assistant_message = {
                    "role": "assistant",
                    "content": assistant_content,
                    "tool_calls": [call.to_openai_tool_call() for call in response.tool_calls],
                }
                if turn_id:
                    assistant_message["turn_id"] = turn_id
                if response.reasoning_content is not None:
                    assistant_message["reasoning_content"] = response.reasoning_content
                elif self._reasoning_enabled():
                    assistant_message["reasoning_content"] = ""
                if response.thinking_blocks:
                    assistant_message["thinking_blocks"] = response.thinking_blocks
                history.append(assistant_message)
                await self._emit_turn_phase(
                    turn_state,
                    TurnPhase.TOOL_BATCH_START,
                    emit,
                    detail={
                        "count": len(response.tool_calls),
                        "names": [call.name for call in response.tool_calls],
                    },
                )
                try:
                    tool_messages = await self._execute_tool_calls(response.tool_calls, emit, clarification=clarification)
                except TurnPaused as pause:
                    history.extend(pause.tool_messages)
                    if self.memory_store is not None:
                        self.memory_store.write_checkpoint(history)
                    await self._emit_turn_phase(
                        turn_state,
                        TurnPhase.PAUSED,
                        emit,
                        detail={
                            "kind": pause.interaction.get("kind"),
                            "interaction_id": pause.interaction.get("id"),
                            "source": "tool",
                        },
                    )
                    if emit:
                        for msg in pause.tool_messages:
                            if msg.get("tool_call_id") == pause.interaction.get("parent_call_id"):
                                await emit({
                                    "event": "tool_result",
                                    "id": msg.get("tool_call_id"),
                                    "name": msg.get("name"),
                                    "summary": msg.get("content"),
                                })
                                break
                        await emit(_control_interaction_event(pause.interaction))
                        await emit({"event": "turn_paused", "interaction": pause.interaction})
                    raise
                history.extend(tool_messages)
                await self._emit_turn_phase(
                    turn_state,
                    TurnPhase.TOOL_BATCH_DONE,
                    emit,
                    detail={"count": len(tool_messages)},
                )
                # 工具批次刚完成 → 此刻 history 处于"tool_calls 与 tool 消息严格配对"的一致点，
                # 写入 checkpoint；如果 LLM 下一次调用前进程被杀，重启可从此处续命。
                if self.memory_store is not None:
                    self.memory_store.write_checkpoint(history)
                    await self._emit_turn_phase(turn_state, TurnPhase.CHECKPOINT, emit, detail={"reason": "tool_batch"})
                continue

            reply = response.content or ""

            # —— 空响应救援 ——
            if not reply.strip() and not response.tool_calls:
                if empty_retries < _MAX_EMPTY_RETRIES:
                    empty_retries += 1
                    history.append({
                        "role": "user",
                        "content": "（上一轮无任何输出，请继续推进或给出最终答复）",
                    })
                    await self._emit_turn_phase(
                        turn_state,
                        TurnPhase.EMPTY_RETRY,
                        emit,
                        detail={"attempt": empty_retries, "max": _MAX_EMPTY_RETRIES},
                    )
                    if emit:
                        await emit({
                            "event": "tool_error",
                            "name": "_empty_response",
                            "message": f"empty response, retry {empty_retries}/{_MAX_EMPTY_RETRIES}",
                        })
                    continue

            # —— 截断续写 ——
            if is_truncated(response.finish_reason) and length_retries < _MAX_LENGTH_RECOVERIES:
                length_retries += 1
                if reply:
                    final_parts.append(reply)
                    message = {"role": "assistant", "content": reply}
                    if turn_id:
                        message["turn_id"] = turn_id
                    history.append(message)
                history.append({
                    "role": "user",
                    "content": "（上一轮被 max_tokens 截断，请从中断处续写，不要重复已输出内容）",
                })
                await self._emit_turn_phase(
                    turn_state,
                    TurnPhase.LENGTH_RETRY,
                    emit,
                    detail={"attempt": length_retries, "max": _MAX_LENGTH_RECOVERIES},
                )
                if emit:
                    await emit({
                        "event": "tool_error",
                        "name": "_length_truncation",
                        "message": f"truncated, continuing {length_retries}/{_MAX_LENGTH_RECOVERIES}",
                    })
                continue

            if clarification.required and reply.strip():
                await self._emit_turn_phase(
                    turn_state,
                    TurnPhase.PAUSED,
                    emit,
                    detail={"kind": "ask", "source": "clarification"},
                )
                await self._pause_for_clarification(history, clarification, emit, turn_id=turn_id)

            if self._must_pause_for_plan(reply):
                await self._emit_turn_phase(
                    turn_state,
                    TurnPhase.PAUSED,
                    emit,
                    detail={"kind": "plan", "source": "plan_final"},
                )
                await self._pause_for_plan(history, reply, emit, turn_id=turn_id)

            final_parts.append(reply)
            final_reply = "".join(final_parts)
            assistant_message = {"role": "assistant", "content": reply}
            if turn_id:
                assistant_message["turn_id"] = turn_id
            if response.reasoning_content is not None:
                assistant_message["reasoning_content"] = response.reasoning_content
            elif self._reasoning_enabled():
                assistant_message["reasoning_content"] = ""
            if response.thinking_blocks:
                assistant_message["thinking_blocks"] = response.thinking_blocks
            history.append(assistant_message)
            if self.memory_store:
                extra = {"turn_id": turn_id} if turn_id else None
                self.memory_store.append_history("assistant", final_reply, extra=extra)

            if self.todo_store and self.todo_store.todos:
                unfinished = [t for t in self.todo_store.todos if t["status"] != "completed"]
                if unfinished:
                    nudge = (
                        "差事尚未办妥，以下任务仍未完成，请按计划继续执行，"
                        "并按规矩更新 todolist 状态：\n" + _render_todos(unfinished)
                    )
                    logger.info(f"\n[计划尚未办妥，继续执行...]\n{_render_todos(self.todo_store.todos)}\n")
                    history.append({"role": "user", "content": nudge})
                    await self._emit_turn_phase(
                        turn_state,
                        TurnPhase.TODO_FOLLOWUP,
                        emit,
                        detail={"unfinished": len(unfinished)},
                    )
                    continue
                logger.info(f"\n[最终计划状态 - 全部办妥]\n{_render_todos(self.todo_store.todos)}\n")
                self.todo_store.todos = []

            await self._emit_turn_phase(turn_state, TurnPhase.COMPACT_CHECK, emit)
            await self._maybe_compact(history)
            # turn 正常落地 → 清掉 checkpoint
            if self.memory_store is not None:
                self.memory_store.clear_checkpoint()
            await self._emit_turn_phase(
                turn_state,
                TurnPhase.COMPLETED,
                emit,
                detail={"content_chars": len(final_reply)},
            )
            return final_reply

    @staticmethod
    async def _emit_turn_phase(
        state: TurnState,
        phase: TurnPhase,
        emit: StreamEmitter | None,
        *,
        detail: dict[str, Any] | None = None,
    ) -> None:
        event = state.transition(phase, detail=detail)
        if emit:
            await emit(event.to_runtime_event())

    async def _ask_model(
        self,
        history: list[dict[str, Any]],
        emit: StreamEmitter | None,
        *,
        clarification: ClarificationAssessment | None = None,
    ):
        projection = self.context_pipeline.project(history)
        governed = projection.messages
        system_prompt = self.system_prompt
        if self.control_manager is not None:
            system_prompt = f"{system_prompt}\n\n---\n\n{self.control_manager.system_prompt()}"
            if clarification and clarification.required:
                system_prompt = f"{system_prompt}\n\n---\n\n{clarification.prompt()}"
            tool_definitions = self.control_manager.tool_definitions(self.registry)
        else:
            tool_definitions = self.registry.get_definitions()
        messages = [
            {"role": "system", "content": system_prompt},
            *governed,
        ]
        self._last_estimated_input_tokens = _estimate_messages_tokens(messages)

        return await ModelCaller(self).ask(
            messages=messages,
            tools=tool_definitions,
            emit=emit,
        )

    @staticmethod
    def _pair_tool_calls(history: list[dict[str, Any]]) -> list[dict[str, Any]]:
        """Ensure assistant tool_calls are 1:1 paired with following tool messages.

        Drops orphan tool messages and fills missing tool replies with a placeholder,
        so a half-completed turn (interrupted execution, bad compaction cut) cannot
        poison subsequent API calls with an "insufficient tool messages" error.
        """
        cleaned: list[dict[str, Any]] = []
        expected: list[tuple[str, str]] = []

        def flush_expected() -> None:
            for tid, tname in expected:
                cleaned.append({
                    "role": "tool",
                    "tool_call_id": tid,
                    "name": tname,
                    "content": "(tool execution interrupted)",
                })
            expected.clear()

        for msg in history:
            role = msg.get("role")
            if role == "tool":
                tid = msg.get("tool_call_id")
                idx = next((i for i, (eid, _) in enumerate(expected) if eid == tid), None)
                if idx is None:
                    continue
                cleaned.append(msg)
                expected.pop(idx)
                continue
            flush_expected()
            cleaned.append(msg)
            if role == "assistant":
                for tc in msg.get("tool_calls") or []:
                    fn = tc.get("function") or {}
                    expected.append((tc.get("id") or "", fn.get("name", "")))
        flush_expected()
        return cleaned

    @staticmethod
    def _content_text_size(content: Any) -> int:
        """按 text 实际长度估算消息体积；list 形式只算 text block，跳过 base64 image_url。"""
        if isinstance(content, str):
            return len(content)
        if isinstance(content, list):
            return sum(
                len(str(b.get("text", "")))
                for b in content
                if isinstance(b, dict) and b.get("type") == "text"
            )
        return len(str(content or ""))

    @staticmethod
    def _cap_tool_result(
        history: list[dict[str, Any]],
        per_call_limit: int = _TOOL_RESULT_BUDGET,
    ) -> list[dict[str, Any]]:
        """单条工具结果硬截断，留头尾。仅作用于 role=tool；user 多模态原样保留。"""
        out: list[dict[str, Any]] = []
        for msg in history:
            if msg.get("role") == "tool":
                text = str(msg.get("content", ""))
                if len(text) > per_call_limit:
                    head = text[:_TOOL_RESULT_HEAD]
                    tail = text[-_TOOL_RESULT_TAIL:]
                    msg = {
                        **msg,
                        "content": (
                            f"{head}\n...[truncated, total {len(text)} chars]...\n{tail}"
                        ),
                    }
            out.append(msg)
        return out

    @staticmethod
    def _shrink_old_tool_results(
        history: list[dict[str, Any]],
        keep_recent: int = _SHRINK_KEEP_RECENT,
    ) -> list[dict[str, Any]]:
        """把 keep_recent 之外的大体积工具消息替换为一行摘要。仅 role=tool；user 多模态不动。"""
        cutoff = max(0, len(history) - keep_recent)
        out: list[dict[str, Any]] = []
        for i, msg in enumerate(history):
            if (
                msg.get("role") == "tool"
                and i < cutoff
                and AgentRunner._content_text_size(msg.get("content")) > _SHRINK_MIN_BYTES
            ):
                name = msg.get("name") or msg.get("tool_call_id") or "tool"
                size = AgentRunner._content_text_size(msg.get("content"))
                out.append({**msg, "content": f"[shrunk] {name} → {size} chars omitted"})
            else:
                out.append(msg)
        return out

    async def _execute_tool_calls(
        self,
        tool_calls: list[ToolCallRequest],
        emit: StreamEmitter | None,
        *,
        clarification: ClarificationAssessment | None = None,
    ) -> list[dict[str, Any]]:
        results_by_id: dict[str, str] = {}

        async def run_one(call: ToolCallRequest) -> str:
            await self._emit_tool_call(call, emit)
            content = await self._run_tool(call, emit, clarification=clarification)
            results_by_id[call.id] = content
            self._maybe_pause_for_control(content, tool_calls, results_by_id)
            if not content.startswith("Error:"):
                await self._emit_tool_result(call, content, emit)
            return content

        return await self.tool_execution_engine.run_batch(tool_calls, emit=emit, run_one=run_one)

    async def _run_tool(
        self,
        call: ToolCallRequest,
        emit: StreamEmitter | None = None,
        *,
        clarification: ClarificationAssessment | None = None,
    ) -> str:
        if clarification and clarification.required and self._ask_guard_blocks_tool(call.name):
            return _ASK_GUARD_BLOCK
        if self.control_manager is not None:
            decision = self.control_manager.assess_permission(call.name, call.arguments, self.registry)
            if decision.requires_approval:
                return self.control_manager.permission_approval_result(decision, parent_call_id=call.id)
            if not decision.allowed:
                return f"Error: permission denied for {call.name}: {decision.reason}"
        tool = self.registry.get(call.name)
        if emit and tool is not None and getattr(tool, "requires_runtime_context", False):
            loop = asyncio.get_running_loop()
            return await asyncio.to_thread(
                self.registry.execute, call.name, call.arguments,
                emit=emit, loop=loop, parent_call_id=call.id,
            )
        return await asyncio.to_thread(self.registry.execute, call.name, call.arguments)

    def _assess_clarification(self, history: list[dict[str, Any]]) -> ClarificationAssessment:
        if self.control_manager is None:
            return ClarificationAssessment()
        try:
            return self.control_manager.assess_clarification(history)
        except Exception as exc:
            logger.warning(f"clarification assessment failed: {exc}")
            return ClarificationAssessment()

    def _ask_guard_blocks_tool(self, name: str) -> bool:
        if name in {"ask_user", "propose_plan"}:
            return False
        tool = self.registry.get(name)
        if tool is None:
            return False
        return not bool(getattr(tool, "read_only", False))

    async def _pause_for_clarification(
        self,
        history: list[dict[str, Any]],
        clarification: ClarificationAssessment,
        emit: StreamEmitter | None,
        *,
        turn_id: str | None = None,
    ) -> None:
        if self.control_manager is None:
            return
        interaction = self.control_manager.create_ask(
            questions=clarification.questions,
            context=f"Ask Guard: {clarification.reason}",
        )
        message = {
            "role": "assistant",
            "content": "需要先确认关键取舍，已触发 Ask Guard。",
        }
        if turn_id:
            message["turn_id"] = turn_id
        history.append(message)
        if self.memory_store is not None:
            self.memory_store.write_checkpoint(history)
        payload = interaction.to_dict()
        if emit:
            await emit(_control_interaction_event(payload))
            await emit({"event": "turn_paused", "interaction": payload})
        raise TurnPaused(interaction=payload, tool_messages=[])

    async def _pause_for_plan(
        self,
        history: list[dict[str, Any]],
        reply: str,
        emit: StreamEmitter | None,
        *,
        turn_id: str | None = None,
    ) -> None:
        if self.control_manager is None:
            return
        interaction = self.control_manager.create_plan_from_text(reply)
        message = {"role": "assistant", "content": reply}
        if turn_id:
            message["turn_id"] = turn_id
        history.append(message)
        if self.memory_store is not None:
            self.memory_store.write_checkpoint(history)
        payload = interaction.to_dict()
        if emit:
            await emit(_control_interaction_event(payload))
            await emit({"event": "turn_paused", "interaction": payload})
        raise TurnPaused(interaction=payload, tool_messages=[])

    def _must_pause_for_plan(self, reply: str) -> bool:
        return bool(
            self.control_manager is not None
            and self.control_manager.should_enforce_plan_final()
        )

    def _maybe_pause_for_control(
        self,
        content: str,
        tool_calls: list[ToolCallRequest],
        results_by_id: dict[str, str],
    ) -> None:
        interaction = parse_pause_result(content)
        if interaction is None:
            return
        tool_messages = self._tool_messages_for_pause(tool_calls, results_by_id, interaction)
        raise TurnPaused(interaction=interaction, tool_messages=tool_messages)

    @staticmethod
    def _tool_messages_for_pause(
        tool_calls: list[ToolCallRequest],
        results_by_id: dict[str, str],
        interaction: dict[str, Any],
    ) -> list[dict[str, Any]]:
        messages = []
        current_id = str(interaction.get("parent_call_id") or "")
        for call in tool_calls:
            content = results_by_id.get(call.id)
            if content and parse_pause_result(content):
                content = f"waiting for user ({interaction.get('kind')}:{interaction.get('id')})"
            elif content is None:
                content = "skipped because the turn paused for user input"
            messages.append({
                "role": "tool",
                "tool_call_id": call.id,
                "name": call.name,
                "content": content,
            })
            if current_id and call.id == current_id:
                current_id = ""
        return messages

    @staticmethod
    async def _emit_tool_call(call: ToolCallRequest, emit: StreamEmitter | None) -> None:
        if emit:
            await emit({
                "event": "tool_call",
                "id": call.id,
                "name": call.name,
                "arguments": call.arguments,
            })

    async def _emit_tool_result(
        self,
        call: ToolCallRequest,
        content: str,
        emit: StreamEmitter | None,
    ) -> None:
        if emit:
            payload: dict[str, Any] = {
                "event": "tool_result",
                "id": call.id,
                "name": call.name,
                "summary": _summarize_tool_result(content),
            }
            if call.name == "update_todos" and self.todo_store is not None:
                payload["todos"] = [
                    {"id": t["id"], "content": t["content"], "status": t["status"]}
                    for t in self.todo_store.todos
                ]
            await emit(payload)

    async def _maybe_compact(self, history: list[dict[str, Any]]) -> None:
        if not (self.compactor and self.token_tracker):
            return
        if not self.token_tracker.should_compact(self.max_context, self.compact_threshold):
            return
        if hasattr(self.compactor, "compact_async"):
            history[:] = await self.compactor.compact_async(history)
        else:
            history[:] = await asyncio.to_thread(self.compactor.compact, history)

    def _reasoning_enabled(self) -> bool:
        return bool(self.reasoning_effort and self.reasoning_effort.lower() not in {"none", "minimal", "minimum"})


_TODO_ICON = {"pending": "[ ]", "in_progress": "[~]", "completed": "[x]"}


def _render_todos(todos: list[dict]) -> str:
    lines = []
    for t in todos:
        icon = _TODO_ICON.get(t.get("status", "pending"), "[?]")
        lines.append(f"  {icon} {t.get('id')}. {t.get('content', '')}")
    return "\n".join(lines)


def _summarize_tool_result(content: str, limit: int = 560) -> str:
    text = " ".join(str(content or "").split())
    if len(text) <= limit:
        return text
    return f"{text[:limit].rstrip()}..."


def _context_used_from_usage(usage: dict[str, int]) -> int:
    input_tokens = int(usage.get("input", usage.get("prompt_tokens", 0)) or 0)
    cache_read = int(usage.get("cache_read", usage.get("cache_read_input_tokens", 0)) or 0)
    cache_create = int(usage.get("cache_create", usage.get("cache_creation_input_tokens", 0)) or 0)
    return input_tokens + cache_read + cache_create


def _estimate_messages_tokens(messages: list[dict[str, Any]]) -> int:
    total_chars = 0
    for msg in messages:
        total_chars += AgentRunner._content_text_size(msg.get("content"))
        for tool_call in msg.get("tool_calls") or []:
            total_chars += len(str(tool_call))
    return max(1, total_chars // 3)


def _optional_int(value: Any) -> int | None:
    try:
        return int(value) if value is not None else None
    except (TypeError, ValueError):
        return None


def _control_interaction_event(interaction: dict[str, Any]) -> dict[str, Any]:
    event = "ask_request" if interaction.get("kind") == "ask" else "plan_draft"
    return {"event": event, "interaction": interaction}
