from __future__ import annotations

import asyncio
from collections.abc import Awaitable, Callable
from typing import Any

from loguru import logger

from .providers import LLMProvider, ToolCallRequest
from .providers.base import is_truncated, run_sync
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
        usage_type: str = "main_agent",
        memory_store=None,
        token_tracker=None,
        compactor=None,
        todo_store=None,
        max_context: int = 200_000,
        compact_threshold: float = 0.7,
        max_turns: int | None = None,
    ):
        self.provider = provider
        self.model = model
        self.registry = registry
        self.system_prompt = system_prompt
        self.max_tokens = max_tokens
        self.temperature = temperature
        self.reasoning_effort = reasoning_effort
        self.provider_name = provider_name
        self.usage_type = usage_type
        self.memory_store = memory_store
        self.token_tracker = token_tracker
        self.compactor = compactor
        self.todo_store = todo_store
        self.max_context = max_context
        self.compact_threshold = compact_threshold
        self.max_turns = max_turns

    def step(self, history: list[dict[str, Any]]) -> str:
        """Run one full turn synchronously. Mutates `history` in place."""
        return run_sync(self.step_async(history))

    async def step_stream(self, history: list[dict[str, Any]], emit: StreamEmitter) -> str:
        """Run one full turn and stream UI-friendly events."""
        reply = await self.step_async(history, emit=emit)
        await emit({"event": "assistant_done", "content": reply})
        return reply

    async def step_async(
        self,
        history: list[dict[str, Any]],
        emit: StreamEmitter | None = None,
    ) -> str:
        turns = 0
        final_parts: list[str] = []
        empty_retries = 0
        length_retries = 0
        # 进入 turn 时先记一次快照，防止 LLM 还没回应就被杀
        if self.memory_store is not None:
            self.memory_store.write_checkpoint(history)
        while True:
            if self.max_turns is not None and turns >= self.max_turns:
                reply = f"（达到 max_turns={self.max_turns} 上限，未办妥；history 中已有部分进展）"
                history.append({"role": "assistant", "content": reply})
                if self.memory_store:
                    self.memory_store.append_history("assistant", reply)
                    self.memory_store.clear_checkpoint()
                return reply
            turns += 1

            response = await self._ask_model(history, emit)
            if response.usage:
                if self.token_tracker:
                    self.token_tracker.record(
                        self.model,
                        response.usage,
                        provider=self.provider_name,
                        usage_type=self.usage_type,
                    )
                if emit:
                    await emit({
                        "event": "context_usage",
                        "used": _context_used_from_usage(response.usage),
                        "max": self.max_context,
                        "threshold": int(self.max_context * self.compact_threshold),
                        "usage_type": self.usage_type,
                    })

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
                if response.reasoning_content is not None:
                    assistant_message["reasoning_content"] = response.reasoning_content
                elif self._reasoning_enabled():
                    assistant_message["reasoning_content"] = ""
                if response.thinking_blocks:
                    assistant_message["thinking_blocks"] = response.thinking_blocks
                history.append(assistant_message)
                tool_messages = await self._execute_tool_calls(response.tool_calls, emit)
                history.extend(tool_messages)
                # 工具批次刚完成 → 此刻 history 处于"tool_calls 与 tool 消息严格配对"的一致点，
                # 写入 checkpoint；如果 LLM 下一次调用前进程被杀，重启可从此处续命。
                if self.memory_store is not None:
                    self.memory_store.write_checkpoint(history)
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
                    history.append({"role": "assistant", "content": reply})
                history.append({
                    "role": "user",
                    "content": "（上一轮被 max_tokens 截断，请从中断处续写，不要重复已输出内容）",
                })
                if emit:
                    await emit({
                        "event": "tool_error",
                        "name": "_length_truncation",
                        "message": f"truncated, continuing {length_retries}/{_MAX_LENGTH_RECOVERIES}",
                    })
                continue

            final_parts.append(reply)
            final_reply = "".join(final_parts)
            assistant_message = {"role": "assistant", "content": reply}
            if response.reasoning_content is not None:
                assistant_message["reasoning_content"] = response.reasoning_content
            elif self._reasoning_enabled():
                assistant_message["reasoning_content"] = ""
            if response.thinking_blocks:
                assistant_message["thinking_blocks"] = response.thinking_blocks
            history.append(assistant_message)
            if self.memory_store:
                self.memory_store.append_history("assistant", final_reply)

            if self.todo_store and self.todo_store.todos:
                unfinished = [t for t in self.todo_store.todos if t["status"] != "completed"]
                if unfinished:
                    nudge = (
                        "差事尚未办妥，以下任务仍未完成，请按计划继续执行，"
                        "并按规矩更新 todolist 状态：\n" + _render_todos(unfinished)
                    )
                    logger.info(f"\n[计划尚未办妥，继续执行...]\n{_render_todos(self.todo_store.todos)}\n")
                    history.append({"role": "user", "content": nudge})
                    continue
                logger.info(f"\n[最终计划状态 - 全部办妥]\n{_render_todos(self.todo_store.todos)}\n")
                self.todo_store.todos = []

            await self._maybe_compact(history)
            # turn 正常落地 → 清掉 checkpoint
            if self.memory_store is not None:
                self.memory_store.clear_checkpoint()
            return final_reply

    async def _ask_model(self, history: list[dict[str, Any]], emit: StreamEmitter | None):
        governed = self._pair_tool_calls(history)
        governed = self._cap_tool_result(governed)
        governed = self._shrink_old_tool_results(governed)
        messages = [
            {"role": "system", "content": self.system_prompt},
            *governed,
        ]

        async def on_delta(delta: str) -> None:
            if emit:
                await emit({"event": "message_delta", "delta": delta})

        if emit:
            return await self.provider.chat_stream(
                messages=messages,
                tools=self.registry.get_definitions(),
                model=self.model,
                max_tokens=self.max_tokens,
                temperature=self.temperature,
                reasoning_effort=self.reasoning_effort,
                on_content_delta=on_delta,
            )
        return await self.provider.chat(
            messages=messages,
            tools=self.registry.get_definitions(),
            model=self.model,
            max_tokens=self.max_tokens,
            temperature=self.temperature,
            reasoning_effort=self.reasoning_effort,
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
    def _cap_tool_result(
        history: list[dict[str, Any]],
        per_call_limit: int = _TOOL_RESULT_BUDGET,
    ) -> list[dict[str, Any]]:
        """单条工具结果硬截断，留头尾，避免单次返回撑爆窗口。"""
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
        """把 keep_recent 之外的大体积工具消息替换为一行摘要。"""
        cutoff = max(0, len(history) - keep_recent)
        out: list[dict[str, Any]] = []
        for i, msg in enumerate(history):
            if (
                msg.get("role") == "tool"
                and i < cutoff
                and len(str(msg.get("content", ""))) > _SHRINK_MIN_BYTES
            ):
                name = msg.get("name") or msg.get("tool_call_id") or "tool"
                size = len(str(msg["content"]))
                out.append({**msg, "content": f"[shrunk] {name} → {size} chars omitted"})
            else:
                out.append(msg)
        return out

    async def _execute_tool_calls(
        self,
        tool_calls: list[ToolCallRequest],
        emit: StreamEmitter | None,
    ) -> list[dict[str, Any]]:
        async def _report_tool_error(call: ToolCallRequest, err_msg: str) -> None:
            if emit:
                await emit({
                    "event": "tool_error",
                    "id": call.id,
                    "name": call.name,
                    "message": err_msg,
                })

        async def _run_and_collect(call: ToolCallRequest) -> str:
            try:
                return await self._run_tool(call, emit)
            except Exception as exc:
                err_msg = str(exc)
                logger.exception(f"Tool execution failed: {call.name}")
                await _report_tool_error(call, err_msg)
                return f"Error: {err_msg}"

        results_by_id: dict[str, str] = {}
        i = 0
        while i < len(tool_calls):
            call = tool_calls[i]
            tool = self.registry.get(call.name)

            if tool is not None and tool.concurrency_safe:
                group: list[ToolCallRequest] = []
                while i < len(tool_calls):
                    candidate = tool_calls[i]
                    candidate_tool = self.registry.get(candidate.name)
                    if candidate_tool is None or not candidate_tool.concurrency_safe:
                        break
                    group.append(candidate)
                    i += 1

                if len(group) > 1:
                    names = ", ".join(item.name for item in group)
                    logger.info(f"[并发执行 {len(group)} 个工具]: {names}")
                    for item in group:
                        await self._emit_tool_call(item, emit)
                    tasks = [self._run_tool(item, emit) for item in group]
                    gathered = await asyncio.gather(*tasks, return_exceptions=True)
                    for item, raw in zip(group, gathered):
                        if isinstance(raw, Exception):
                            err_msg = str(raw)
                            results_by_id[item.id] = f"Error: {err_msg}"
                            await _report_tool_error(item, err_msg)
                        else:
                            results_by_id[item.id] = raw
                            await self._emit_tool_result(item, raw, emit)
                else:
                    item = group[0]
                    await self._emit_tool_call(item, emit)
                    content = await _run_and_collect(item)
                    results_by_id[item.id] = content
                    if not content.startswith("Error:"):
                        await self._emit_tool_result(item, content, emit)
                continue

            await self._emit_tool_call(call, emit)
            content = await _run_and_collect(call)
            results_by_id[call.id] = content
            if not content.startswith("Error:"):
                await self._emit_tool_result(call, content, emit)
            i += 1

        return [
            {
                "role": "tool",
                "tool_call_id": call.id,
                "name": call.name,
                "content": results_by_id.get(call.id, ""),
            }
            for call in tool_calls
        ]

    async def _run_tool(self, call: ToolCallRequest, emit: StreamEmitter | None = None) -> str:
        if emit and call.name == "dispatch_subagent":
            loop = asyncio.get_running_loop()
            return await asyncio.to_thread(
                self.registry.execute, call.name, call.arguments,
                emit=emit, loop=loop, parent_call_id=call.id,
            )
        return await asyncio.to_thread(self.registry.execute, call.name, call.arguments)

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
