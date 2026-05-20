from __future__ import annotations

import asyncio
import json
from typing import TYPE_CHECKING, Any

from aiohttp import WSMsgType, web
from loguru import logger

from ...attachments import AttachmentRef, encode_for_openai_block
from ...control import InteractionKind, TurnPaused
from ...runtime import events as runtime_events
from ...skill_requests import (
    SkillRequestError,
    build_requested_skills_block,
    inject_requested_skills,
    parse_requested_skills,
)

if TYPE_CHECKING:
    from ..state import WebUIState


class ChatService:
    def __init__(self, state: WebUIState):
        self.state = state

    async def ws_handler(self, request: web.Request) -> web.WebSocketResponse:
        ws = web.WebSocketResponse(heartbeat=30)
        await ws.prepare(request)
        last_seq = self.state.safe_int(request.query.get("last_seq"), 0)
        await self._attach_client(ws, last_seq)

        try:
            async for msg in ws:
                if msg.type == WSMsgType.TEXT:
                    await self._handle_ws_text(ws, msg.data)
                elif msg.type == WSMsgType.ERROR:
                    break
        finally:
            self.state.clients.discard(ws)
        return ws

    async def _attach_client(self, ws: web.WebSocketResponse, last_seq: int) -> None:
        async with self.state.broadcast_lock:
            replay = (
                self.state.runtime_events.replay_after(last_seq, limit=self.state.max_event_log)
                if last_seq > 0
                else []
            )
            self.state.clients.add(ws)
            try:
                await self.state._send_ws(
                    ws,
                    self.state.ready_event(last_seq=last_seq, replay_count=len(replay)),
                )
                for event in replay:
                    await self.state._send_ws(ws, event)
            except (ConnectionResetError, RuntimeError):
                self.state.clients.discard(ws)

    async def _handle_ws_text(self, ws: web.WebSocketResponse, raw: str) -> None:
        started = False
        turn_id = ""
        try:
            payload = json.loads(raw)
            msg_type = payload.get("type")
            if msg_type in {"interaction_answer", "plan_comment", "plan_approve", "interaction_cancel"}:
                await self._handle_control_ws_payload(payload)
                return
            if msg_type != "message":
                raise ValueError("Unsupported WebSocket message type")

            text = str(payload.get("content") or "").strip()
            attachment_ids = payload.get("attachments") or []
            if not isinstance(attachment_ids, list):
                attachment_ids = []
            attachment_ids = [str(a) for a in attachment_ids if isinstance(a, (str, int))]
            if not text and not attachment_ids:
                raise ValueError("Message is empty")

            requested_skill_names = parse_requested_skills(
                payload.get("requested_skills"),
                set(self.state.loop.skills.skills.keys()),
            )
            display_content = str(payload.get("display_content") or text).strip()
            if self.state.control().get("pending"):
                if attachment_ids:
                    raise ValueError("当前有 Ask / Plan 正在等待处理，请先回答、评论、批准或取消后再发送附件。")
                if text:
                    await self._handle_pending_text_message(
                        text,
                        client_message_id=str(payload.get("client_message_id") or ""),
                    )
                    return

            content = self._build_user_content(text, attachment_ids)
            if requested_skill_names:
                skill_block = build_requested_skills_block(
                    self.state.loop.skills,
                    requested_skill_names,
                )
                content = inject_requested_skills(content, skill_block)

            turn_id = self.state.new_turn_id()
            client_message_id = str(payload.get("client_message_id") or "")
            user_msg: dict[str, Any] = {"role": "user", "content": content, "turn_id": turn_id}
            if attachment_ids:
                user_msg["attachments"] = attachment_ids

            async with self.state.lock:
                self.state.history.append(user_msg)
                extra: dict[str, Any] = {"turn_id": turn_id}
                if requested_skill_names:
                    extra["requestedSkills"] = requested_skill_names
                if display_content != text or requested_skill_names:
                    extra["displayContent"] = display_content
                if attachment_ids:
                    extra.update({"attachments": attachment_ids})
                self.state.loop.memory.append_history("user", content, extra=extra)

                await self.state._broadcast_event(
                    runtime_events.user_message(
                        content=display_content,
                        attachments=self.state.attachment_refs(attachment_ids),
                        client_message_id=client_message_id,
                    ),
                    turn_id=turn_id,
                )
                started = True
                self.state.active_turn = True

                async def emit(event: dict[str, Any]) -> None:
                    await self.state._broadcast_event(event, turn_id=turn_id)

                try:
                    await self.state.active_tasks.run(
                        task_id=f"turn:{turn_id}",
                        kind="turn",
                        label="Chat turn",
                        awaitable=self.state.loop.runner.step_stream(
                            self.state.history,
                            emit,
                            turn_id=turn_id,
                        ),
                        turn_id=turn_id,
                    )
                except TurnPaused:
                    pass
                except asyncio.CancelledError:
                    logger.info("Chat turn {} cancelled", turn_id)
                finally:
                    self.state.active_turn = False
                    self.state.compact_runtime_events()
        except TurnPaused:
            self.state.active_turn = False
        except SkillRequestError as exc:
            payload = runtime_events.error(str(exc))
            if started:
                await self.state._broadcast_event(payload, turn_id=turn_id or None)
            elif not ws.closed:
                try:
                    await self.state._send_ws(ws, payload)
                except ConnectionResetError:
                    pass
        except Exception as exc:
            logger.exception("WebSocket message handler error")
            payload = {"event": "error", "message": str(exc), "partial": True}
            if started:
                await self.state._broadcast_event(payload, turn_id=turn_id or None)
            elif not ws.closed:
                try:
                    await self.state._send_ws(ws, payload)
                except ConnectionResetError:
                    pass

    async def _handle_control_ws_payload(self, payload: dict[str, Any]) -> None:
        msg_type = str(payload.get("type") or "")
        interaction_id = str(payload.get("interaction_id") or "")
        if not interaction_id:
            raise ValueError("interaction_id is required")
        turn_id = self.state.new_turn_id()
        client_message_id = str(payload.get("client_message_id") or "")
        if msg_type == "interaction_cancel":
            event = self.state.loop.control_manager.cancel(interaction_id)
            await self.record_control_cancel(
                str(event.get("message") or ""),
                "已取消等待中的交互",
                turn_id=turn_id,
                client_message_id=client_message_id,
            )
            await self.state._broadcast_event(event, turn_id=turn_id)
            await self.state._broadcast_event(runtime_events.control_mode_update(self.state.control()))
            return
        if msg_type == "interaction_answer":
            answers = payload.get("answers") if isinstance(payload.get("answers"), dict) else {}
            resume = self.state.loop.control_manager.answer(interaction_id, answers)
            display = "已回答澄清问题"
        elif msg_type == "plan_comment":
            resume = self.state.loop.control_manager.comment(
                interaction_id,
                str(payload.get("comment") or ""),
            )
            display = f"评论计划：{str(payload.get('comment') or '').strip()[:120]}"
        elif msg_type == "plan_approve":
            resume = self.state.loop.control_manager.approve(interaction_id)
            display = "已批准计划，开始执行"
        else:
            raise ValueError(f"Unsupported control message type: {msg_type}")
        await self.state._broadcast_event(resume.event, turn_id=turn_id)
        await self.state._broadcast_event(runtime_events.control_mode_update(self.state.control()))
        await self._resume_control_turn(
            resume.message,
            display,
            turn_id=turn_id,
            client_message_id=client_message_id,
        )

    async def _handle_pending_text_message(self, text: str, *, client_message_id: str = "") -> None:
        pending = self.state.control().get("pending") or {}
        interaction_id = str(pending.get("id") or "")
        if not interaction_id:
            raise ValueError("pending interaction is missing id")
        if pending.get("kind") == InteractionKind.ASK.value:
            resume = self.state.loop.control_manager.answer(
                interaction_id,
                {"_freeform": {"choice": "", "freeform": text}},
            )
            display = "已回答澄清问题"
        elif pending.get("kind") == InteractionKind.PLAN.value:
            if text.strip().lower() in {"approve", "批准", "执行"}:
                resume = self.state.loop.control_manager.approve(interaction_id)
                display = "已批准计划，开始执行"
            else:
                resume = self.state.loop.control_manager.comment(interaction_id, text)
                display = f"评论计划：{text[:120]}"
        else:
            raise ValueError("unknown pending interaction")
        turn_id = self.state.new_turn_id()
        await self.state._broadcast_event(resume.event, turn_id=turn_id)
        await self.state._broadcast_event(runtime_events.control_mode_update(self.state.control()))
        await self._resume_control_turn(
            resume.message,
            display,
            turn_id=turn_id,
            client_message_id=client_message_id,
        )

    async def record_control_cancel(
        self,
        message: str,
        display: str,
        *,
        turn_id: str,
        client_message_id: str = "",
    ) -> None:
        if not message:
            return
        async with self.state.lock:
            self.state.history.append({"role": "user", "content": message, "turn_id": turn_id})
            self.state.loop.memory.append_history(
                "user",
                message,
                extra={"type": "control_response", "displayContent": display, "turn_id": turn_id},
            )
            await self.state._broadcast_event(
                runtime_events.user_message(
                    content=display,
                    attachments=[],
                    client_message_id=client_message_id,
                ),
                turn_id=turn_id,
            )
            self.state.loop.memory.clear_checkpoint()

    async def _resume_control_turn(
        self,
        message: str,
        display: str,
        *,
        turn_id: str,
        client_message_id: str = "",
    ) -> None:
        async with self.state.lock:
            self.state.history.append({"role": "user", "content": message, "turn_id": turn_id})
            self.state.loop.memory.append_history(
                "user",
                message,
                extra={"type": "control_response", "displayContent": display, "turn_id": turn_id},
            )
            await self.state._broadcast_event(
                runtime_events.user_message(
                    content=display,
                    attachments=[],
                    client_message_id=client_message_id,
                ),
                turn_id=turn_id,
            )
            self.state.active_turn = True

            async def emit(event: dict[str, Any]) -> None:
                await self.state._broadcast_event(event, turn_id=turn_id)

            try:
                await self.state.active_tasks.run(
                    task_id=f"turn:{turn_id}",
                    kind="turn",
                    label="Control resume turn",
                    awaitable=self.state.loop.runner.step_stream(
                        self.state.history,
                        emit,
                        turn_id=turn_id,
                    ),
                    turn_id=turn_id,
                )
            except TurnPaused:
                pass
            except asyncio.CancelledError:
                logger.info("Control resume turn {} cancelled", turn_id)
            finally:
                self.state.active_turn = False
                self.state.compact_runtime_events()

    def _build_user_content(self, text: str, attachment_ids: list[str]) -> Any:
        if not attachment_ids:
            return text
        refs: list[AttachmentRef] = []
        for aid in attachment_ids:
            ref = self.state.attachments.get(aid)
            if ref is not None:
                refs.append(ref)
        if not refs:
            return text

        image_blocks: list[dict[str, Any]] = []
        text_pieces: list[str] = [text] if text else []
        supports_vision = bool(getattr(self.state.loop, "supports_vision", False))
        for ref in refs:
            if ref.kind == "image":
                if supports_vision:
                    try:
                        image_blocks.append(encode_for_openai_block(ref, self.state.attachments))
                    except Exception as exc:
                        logger.warning(f"failed to encode image {ref.id}: {exc}")
                        text_pieces.append(f"\n[图片附件 {ref.name} 编码失败：{exc}]")
                else:
                    text_pieces.append(
                        f"\n[图片附件 {ref.name}（当前模型未标记视觉，已忽略；"
                        f"可在 /model 测试视觉激活）]"
                    )
            elif ref.has_text:
                txt = self.state.attachments.read_text(ref)
                if txt:
                    text_pieces.append(
                        f"\n\n[附件 {ref.name} 提取文本]\n{txt}\n[/附件 {ref.name}]"
                    )
                else:
                    text_pieces.append(f"\n[附件 {ref.name} 已落盘但抽取文本为空]")
            else:
                text_pieces.append(f"\n[附件 {ref.name} 已落盘: {ref.rel_path}（用 read_file 读取）]")
            text_pieces.append(f"\n[已落盘: {ref.rel_path}]")

        full_text = "".join(text_pieces).strip()
        if image_blocks:
            blocks: list[dict[str, Any]] = []
            if full_text:
                blocks.append({"type": "text", "text": full_text})
            blocks.extend(image_blocks)
            return blocks
        return full_text or text
