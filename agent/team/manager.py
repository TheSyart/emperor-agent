from __future__ import annotations

import asyncio
import json
from collections.abc import Awaitable, Callable
from threading import Lock
from typing import Any

from loguru import logger

from ..providers.base import run_sync
from ..subagents import SubagentSpec
from ..tools.registry import ToolRegistry
from . import events
from .bus import MessageBus
from .models import LEAD_ACTOR, TeamMember, TeamMessage, TeamStatus, new_id, now_ts, validate_member_name
from .store import TeamStore


StreamEmitter = Callable[[dict[str, Any]], Awaitable[None]]


_ROLE_AGENT_TYPES = {
    "coder": "neiguan_yingzao",
    "reviewer": "shangbao_dianbu",
    "researcher": "dongchang_tanshi",
    "reader": "sili_suitang",
    "runner": "xiaohuangmen",
}


def role_to_agent_type(role: str) -> str:
    return _ROLE_AGENT_TYPES.get(str(role or "").strip().lower(), "sili_suitang")


class TeamManager:
    def __init__(
        self,
        *,
        root,
        parent_registry: ToolRegistry,
        subagent_registry,
        runner_factory,
    ):
        self.store = TeamStore(root)
        self.bus = MessageBus(self.store)
        self.parent_registry = parent_registry
        self.subagent_registry = subagent_registry
        self.runner_factory = runner_factory
        self._locks: dict[str, Lock] = {}
        self._locks_guard = Lock()

    def payload(self) -> dict[str, Any]:
        config = self.store.load_config()
        members = []
        for member in self.store.list_members():
            item = member.to_dict()
            item["unread"] = self.bus.unread_count(member.name)
            item["recent_messages"] = [msg.to_dict() for msg in self.bus.recent(member.name, limit=5)]
            item["thread_count"] = len(self.store.read_thread(member.name))
            item["tools"] = self._tool_names_for_member(member)
            members.append(item)
        return {
            "config": config,
            "members": members,
            "leadUnread": self.bus.unread_count(LEAD_ACTOR),
            "leadInbox": [msg.to_dict() for msg in self.bus.recent(LEAD_ACTOR, limit=50)],
        }

    def member_payload(self, name: str) -> dict[str, Any]:
        member = self._require_member(name)
        return {
            "member": {
                **member.to_dict(),
                "unread": self.bus.unread_count(member.name),
                "tools": self._tool_names_for_member(member),
            },
            "inbox": [msg.to_dict() for msg in self.bus.recent(member.name, limit=100)],
            "leadInbox": [msg.to_dict() for msg in self.bus.recent(LEAD_ACTOR, limit=100)],
            "thread": self._thread_summary(member.name),
        }

    def spawn_teammate(
        self,
        *,
        name: str,
        role: str,
        task: str | None = None,
        agent_type: str | None = None,
        sender: str = LEAD_ACTOR,
        emit: StreamEmitter | None = None,
        loop: asyncio.AbstractEventLoop | None = None,
        parent_call_id: str | None = None,
    ) -> str:
        safe_name = validate_member_name(name)
        resolved_agent_type = agent_type or role_to_agent_type(role)
        spec = self.subagent_registry.get(resolved_agent_type)
        if spec is None:
            return (
                f"Error: unknown agent_type '{resolved_agent_type}'. "
                f"Available: {self.subagent_registry.names(include_aliases=True)}"
            )

        existing = self.store.get_member(safe_name)
        if existing and existing.status == TeamStatus.SHUTDOWN.value:
            existing = existing.touch(status=TeamStatus.IDLE.value, last_error=None)
        member = TeamMember(
            name=safe_name,
            role=role,
            agent_type=self.subagent_registry.resolve_name(resolved_agent_type),
            status=(existing.status if existing else TeamStatus.IDLE.value),
            created_at=(existing.created_at if existing else now_ts()),
            last_error=(existing.last_error if existing else None),
        )
        self.store.upsert_member(member)
        self._emit(events.member_update(member), emit, loop)

        if not task:
            return json.dumps({"created": member.to_dict()}, ensure_ascii=False)

        task_id = new_id("task")
        msg = self.bus.send(
            from_actor=sender,
            to=member.name,
            content=task,
            type="task",
            task_id=task_id,
        )
        self._emit(events.message_event(msg), emit, loop)
        result = self.wake_teammate(
            member.name,
            emit=emit,
            loop=loop,
            parent_call_id=parent_call_id,
            purpose=task[:120],
        )
        return json.dumps(
            {"created": member.to_dict(), "message": msg.to_dict(), "result": result},
            ensure_ascii=False,
        )

    def list_teammates(self) -> str:
        return json.dumps(self.payload(), ensure_ascii=False, indent=2)

    def read_inbox(self, *, actor: str = LEAD_ACTOR, limit: int = 20, mark_read: bool = True) -> str:
        messages = self.bus.read(actor, limit=limit, mark_read=mark_read)
        return json.dumps([message.to_dict() for message in messages], ensure_ascii=False, indent=2)

    def send_message(
        self,
        *,
        to: str,
        content: str,
        sender: str = LEAD_ACTOR,
        wake: bool = True,
        type: str = "message",
        emit: StreamEmitter | None = None,
        loop: asyncio.AbstractEventLoop | None = None,
        parent_call_id: str | None = None,
    ) -> str:
        if to != LEAD_ACTOR:
            self._require_member(to)
        if sender != LEAD_ACTOR:
            self._require_member(sender)
        msg = self.bus.send(from_actor=sender, to=to, content=content, type=type)
        self._emit(events.message_event(msg), emit, loop)
        result = None
        if wake and to != LEAD_ACTOR:
            result = self.wake_teammate(
                to,
                emit=emit,
                loop=loop,
                parent_call_id=parent_call_id,
                purpose=content[:120],
            )
        return json.dumps({"message": msg.to_dict(), "result": result}, ensure_ascii=False)

    def broadcast(
        self,
        *,
        content: str,
        recipients: list[str] | None = None,
        wake: bool = True,
        emit: StreamEmitter | None = None,
        loop: asyncio.AbstractEventLoop | None = None,
        parent_call_id: str | None = None,
    ) -> str:
        members = [
            member
            for member in self.store.list_members()
            if member.status != TeamStatus.SHUTDOWN.value
        ]
        if recipients:
            wanted = {validate_member_name(name) for name in recipients}
            members = [member for member in members if member.name in wanted]
        sent = []
        results = []
        for member in members:
            msg = self.bus.send(from_actor=LEAD_ACTOR, to=member.name, content=content, type="message")
            sent.append(msg.to_dict())
            self._emit(events.message_event(msg), emit, loop)
            if wake:
                results.append({
                    "name": member.name,
                    "result": self.wake_teammate(
                        member.name,
                        emit=emit,
                        loop=loop,
                        parent_call_id=parent_call_id,
                        purpose=content[:120],
                    ),
                })
        return json.dumps({"sent": sent, "results": results}, ensure_ascii=False, indent=2)

    def shutdown_teammate(self, *, name: str, emit: StreamEmitter | None = None,
                          loop: asyncio.AbstractEventLoop | None = None) -> str:
        member = self.store.update_member(
            name,
            status=TeamStatus.SHUTDOWN.value,
            last_error=None,
        )
        self._emit(events.member_update(member), emit, loop)
        return json.dumps({"shutdown": member.to_dict()}, ensure_ascii=False)

    def wake_teammate(
        self,
        name: str,
        *,
        emit: StreamEmitter | None = None,
        loop: asyncio.AbstractEventLoop | None = None,
        parent_call_id: str | None = None,
        purpose: str = "",
    ) -> str:
        member = self._require_member(name)
        if member.status == TeamStatus.SHUTDOWN.value:
            return f"Error: teammate '{member.name}' is shutdown"
        lock = self._lock_for(member.name)
        if not lock.acquire(blocking=False):
            return f"Error: teammate '{member.name}' is already working"
        try:
            return self._wake_locked(
                member,
                emit=emit,
                loop=loop,
                parent_call_id=parent_call_id,
                purpose=purpose,
            )
        finally:
            lock.release()

    def _wake_locked(
        self,
        member: TeamMember,
        *,
        emit: StreamEmitter | None,
        loop: asyncio.AbstractEventLoop | None,
        parent_call_id: str | None,
        purpose: str,
    ) -> str:
        working = self.store.update_member(
            member.name,
            status=TeamStatus.WORKING.value,
            last_error=None,
        )
        self._emit(events.member_update(working), emit, loop)
        self._emit(events.run_start(parent_id=parent_call_id, member=working, purpose=purpose), emit, loop)

        checkpoint = self.store.read_checkpoint_payload(working.name)
        pending_cursor_start: int | None = None
        pending_cursor_end: int | None = None
        pending_message_ids: list[str] = []
        if checkpoint:
            history = checkpoint["messages"]
            pending_cursor_start = checkpoint.get("pending_cursor_start")
            pending_cursor_end = checkpoint.get("pending_cursor_end")
            pending_message_ids = list(checkpoint.get("pending_message_ids") or [])
            inbox_by_id = {msg.id: msg for msg in self.bus.all_messages(working.name)}
            unread = [inbox_by_id[msg_id] for msg_id in pending_message_ids if msg_id in inbox_by_id]
        else:
            inbox = self.bus.all_messages(working.name)
            pending_cursor_start = min(self.store.read_cursor(working.name), len(inbox))
            unread = inbox[pending_cursor_start:pending_cursor_start + 50]
            pending_cursor_end = pending_cursor_start + len(unread)
            pending_message_ids = [msg.id for msg in unread]
            history = self.store.read_thread(working.name)

        if not checkpoint and not unread:
            idle = self.store.update_member(working.name, status=TeamStatus.IDLE.value, last_error=None)
            self._emit(events.member_update(idle), emit, loop)
            self._emit(events.run_done(parent_id=parent_call_id, member=idle, summary="没有未读消息。"), emit, loop)
            return "没有未读消息。"

        if not checkpoint:
            history.append({"role": "user", "content": self._render_inbox_for_runner(working, unread)})
        self.store.write_checkpoint(
            working.name,
            history,
            pending_cursor_start=pending_cursor_start,
            pending_cursor_end=pending_cursor_end,
            pending_message_ids=pending_message_ids,
        )

        spec = self._require_spec(working.agent_type)
        sub_registry = self._registry_for_member(working, spec)
        runner = self.runner_factory(member=working, spec=spec, sub_registry=sub_registry)
        lead_before_ids = {msg.id for msg in self.bus.all_messages(LEAD_ACTOR)}

        async def team_emit(evt: dict[str, Any]) -> None:
            evt_type = str(evt.get("event") or "")
            if evt_type.startswith("team_"):
                if emit is None:
                    return
                if loop is not None:
                    self._emit(evt, emit, loop)
                    return
                await emit(evt)
                return
            mapped = self._map_runner_event(evt, working, parent_call_id)
            if mapped:
                if emit is None:
                    return
                if loop is not None:
                    self._emit(mapped, emit, loop)
                    return
                await emit(mapped)

        try:
            if emit is not None:
                final = run_sync(runner.step_stream(history, team_emit))
            else:
                final = runner.step(history)
            self.store.write_thread(working.name, history)
            self.store.clear_checkpoint(working.name)
            if pending_cursor_end is not None:
                self.store.write_cursor(working.name, pending_cursor_end)
            idle = self.store.update_member(working.name, status=TeamStatus.IDLE.value, last_error=None)
            self._emit(events.member_update(idle), emit, loop)
            explicit_reply = any(
                msg.id not in lead_before_ids and msg.from_actor == working.name
                for msg in self.bus.all_messages(LEAD_ACTOR)
            )
            if not explicit_reply:
                result_msg = self.bus.send(
                    from_actor=working.name,
                    to=LEAD_ACTOR,
                    content=final,
                    type="result",
                    in_reply_to=(pending_message_ids[-1] if pending_message_ids else None),
                    meta={"role": working.role, "agent_type": working.agent_type},
                )
                self._emit(events.message_event(result_msg), emit, loop)
            logger.info(f"[队友回禀 · {working.name}]: {final[:500]}")
            return final
        except Exception as exc:
            err = str(exc)
            logger.exception(f"team wake failed: {working.name}")
            self.store.write_checkpoint(
                working.name,
                history,
                pending_cursor_start=pending_cursor_start,
                pending_cursor_end=pending_cursor_end,
                pending_message_ids=pending_message_ids,
            )
            error_member = self.store.update_member(
                working.name,
                status=TeamStatus.ERROR.value,
                last_error=err,
            )
            self._emit(events.member_update(error_member), emit, loop)
            self._emit(events.run_error(parent_id=parent_call_id, member=error_member, message=err), emit, loop)
            error_msg = self.bus.send(
                from_actor=working.name,
                to=LEAD_ACTOR,
                content=err,
                type="error",
                meta={"role": working.role, "agent_type": working.agent_type},
            )
            self._emit(events.message_event(error_msg), emit, loop)
            return f"Error: teammate '{working.name}' raised: {err}"

    def _registry_for_member(self, member: TeamMember, spec: SubagentSpec) -> ToolRegistry:
        from .tools import TeamReadInboxTool, TeamSendMessageTool

        registry = ToolRegistry()
        for tool_name in spec.tool_names:
            tool = self.parent_registry.get(tool_name)
            if tool is not None:
                registry.register(tool)
        registry.register(TeamSendMessageTool(self, sender=member.name, allow_wake=False))
        registry.register(TeamReadInboxTool(self, actor=member.name))
        return registry

    def _tool_names_for_member(self, member: TeamMember) -> list[str]:
        spec = self.subagent_registry.get(member.agent_type)
        if spec is None:
            return []
        return [*spec.tool_names, "send_message", "read_inbox"]

    def _thread_summary(self, name: str) -> list[dict[str, Any]]:
        out = []
        for item in self.store.read_thread(name)[-20:]:
            content = item.get("content", "")
            if isinstance(content, list):
                content = "".join(
                    str(block.get("text", ""))
                    for block in content
                    if isinstance(block, dict) and block.get("type") == "text"
                )
            out.append({
                "role": item.get("role"),
                "content": str(content)[:2000],
            })
        return out

    def _require_member(self, name: str) -> TeamMember:
        member = self.store.get_member(name)
        if member is None:
            raise ValueError(f"unknown teammate: {name}")
        return member

    def _require_spec(self, agent_type: str) -> SubagentSpec:
        spec = self.subagent_registry.get(agent_type)
        if spec is None:
            raise ValueError(f"unknown agent_type: {agent_type}")
        return spec

    def _lock_for(self, name: str) -> Lock:
        safe = validate_member_name(name)
        with self._locks_guard:
            if safe not in self._locks:
                self._locks[safe] = Lock()
            return self._locks[safe]

    @staticmethod
    def _render_inbox_for_runner(member: TeamMember, messages: list[TeamMessage]) -> str:
        lines = [
            f"你是 Agent Team 队友 {member.name}，role={member.role}，agent_type={member.agent_type}。",
            "下面是你的未读 inbox。请处理这些消息，必要时调用工具，最后用 send_message(to=\"lead\", content=\"...\") 回禀，随后给出简短总结。",
            "",
            "## Inbox",
        ]
        for msg in messages:
            lines.append(
                f"- id={msg.id} type={msg.type} from={msg.from_actor} "
                f"task_id={msg.task_id or ''}: {msg.content}"
            )
        return "\n".join(lines)

    @staticmethod
    def _map_runner_event(evt: dict[str, Any], member: TeamMember,
                          parent_call_id: str | None) -> dict[str, Any] | None:
        evt_type = evt.get("event")
        if evt_type == "message_delta":
            return events.run_delta(parent_id=parent_call_id, member=member, delta=str(evt.get("delta") or ""))
        if evt_type == "tool_call":
            return events.run_tool_call(
                parent_id=parent_call_id,
                member=member,
                id=evt.get("id"),
                name=str(evt.get("name") or ""),
                arguments=evt.get("arguments") if isinstance(evt.get("arguments"), dict) else {},
            )
        if evt_type == "tool_result":
            return events.run_tool_result(
                parent_id=parent_call_id,
                member=member,
                id=evt.get("id"),
                name=evt.get("name"),
                summary=str(evt.get("summary") or ""),
            )
        if evt_type == "tool_error":
            return events.run_tool_error(
                parent_id=parent_call_id,
                member=member,
                id=evt.get("id"),
                name=evt.get("name"),
                message=str(evt.get("message") or ""),
            )
        if evt_type == "assistant_done":
            return events.run_done(parent_id=parent_call_id, member=member, summary=str(evt.get("content") or ""))
        return None

    @staticmethod
    def _emit(
        event: dict[str, Any],
        emit: StreamEmitter | None,
        loop: asyncio.AbstractEventLoop | None,
    ) -> None:
        if emit is None:
            return
        if loop is not None:
            asyncio.run_coroutine_threadsafe(emit(event), loop)
            return
        try:
            run_sync(emit(event))
        except RuntimeError:
            logger.debug(f"team event dropped outside loop: {event.get('event')}")
