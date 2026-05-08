from __future__ import annotations

import argparse
import asyncio
import base64
import copy
import json
import re
import shutil
import tempfile
import time
import zipfile
from datetime import datetime
from pathlib import Path
from typing import Any

from aiohttp import WSMsgType, web
from loguru import logger

from .attachments import (
    AttachmentRef,
    AttachmentStore,
    encode_for_openai_block,
    ref_to_json,
)
from .logger import configure as configure_logging
from .loop import AgentLoop
from .model_config import (
    build_provider_snapshot,
    load_model_config,
    mark_entry_vision,
    provider_options,
    save_model_config,
)


# 2x2 纯红 PNG（约 70 bytes base64），视觉探测样本
_PROBE_PNG_RED_BASE64 = (
    "iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAIAAAD91JpzAAAAFklEQVR4AWPwl3jzn4HhPwM2D"
    "JVAaQAJ7QgRZD2vqQAAAABJRU5ErkJggg=="
)


_SKILL_RE = re.compile(r"^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,80}$")


class WebUIState:
    def __init__(self, root: Path):
        self.root = root.resolve()
        configure_logging(self.root)
        self.static_dir = self.root / "webui" / "dist"
        self._ensure_tool_config()
        self.loop = AgentLoop(root=self.root, verbose=False, startup_compaction=False)
        self.history = self.loop.history
        self.attachments = AttachmentStore(self.root)
        self.lock = asyncio.Lock()
        self.clients: set[web.WebSocketResponse] = set()
        self.event_log: list[dict[str, Any]] = []
        self.event_seq = 0
        self.broadcast_lock = asyncio.Lock()
        self.max_event_log = 5000
        self.active_turn = False

    async def bootstrap(self, request: web.Request) -> web.Response:
        return self._json({
            "app": "Emperor Agent",
            "model": self.loop.model,
            "provider": self.loop.provider_name,
            "providerLabel": self.loop.provider_label,
            "tools": self.tools(),
            "skills": self.skills(),
            "memory": self.memory(),
            "modelConfig": self.model_config(),
            "context_used": self.loop.token_tracker.last_input_tokens(),
            "unarchivedHistory": self.unarchived_history(),
        })

    async def ws_handler(self, request: web.Request) -> web.WebSocketResponse:
        ws = web.WebSocketResponse(heartbeat=30)
        await ws.prepare(request)
        last_seq = _safe_int(request.query.get("last_seq"), 0)
        await self._attach_client(ws, last_seq)

        try:
            async for msg in ws:
                if msg.type == WSMsgType.TEXT:
                    await self._handle_ws_text(ws, msg.data)
                elif msg.type == WSMsgType.ERROR:
                    break
        finally:
            self.clients.discard(ws)
        return ws

    async def _attach_client(self, ws: web.WebSocketResponse, last_seq: int) -> None:
        async with self.broadcast_lock:
            replay = [
                event
                for event in self.event_log
                if last_seq > 0 and int(event.get("seq") or 0) > last_seq
            ]
            self.clients.add(ws)
            try:
                await self._send_ws(ws, self.ready_event(last_seq=last_seq, replay_count=len(replay)))
                for event in replay:
                    await self._send_ws(ws, event)
            except (ConnectionResetError, RuntimeError):
                self.clients.discard(ws)

    async def _handle_ws_text(self, ws: web.WebSocketResponse, raw: str) -> None:
        started = False
        try:
            payload = json.loads(raw)
            if payload.get("type") != "message":
                raise ValueError("Unsupported WebSocket message type")
            text = str(payload.get("content") or "").strip()
            attachment_ids = payload.get("attachments") or []
            if not isinstance(attachment_ids, list):
                attachment_ids = []
            attachment_ids = [str(a) for a in attachment_ids if isinstance(a, (str, int))]
            if not text and not attachment_ids:
                raise ValueError("Message is empty")
            content = self._build_user_content(text, attachment_ids)
            user_msg: dict[str, Any] = {"role": "user", "content": content}
            if attachment_ids:
                user_msg["attachments"] = attachment_ids
            async with self.lock:
                self.history.append(user_msg)
                if attachment_ids:
                    self.loop.memory.append_history(
                        "user", content, extra={"attachments": attachment_ids},
                    )
                else:
                    self.loop.memory.append_history("user", content)
                started = True
                self.active_turn = True

                async def emit(event: dict[str, Any]) -> None:
                    await self._broadcast_event(event)

                try:
                    await self.loop.runner.step_stream(self.history, emit)
                finally:
                    self.active_turn = False
        except Exception as exc:
            logger.exception("WebSocket message handler error")
            payload = {"event": "error", "message": str(exc), "partial": True}
            if started:
                await self._broadcast_event(payload)
            elif not ws.closed:
                try:
                    await self._send_ws(ws, payload)
                except ConnectionResetError:
                    pass

    def _build_user_content(self, text: str, attachment_ids: list[str]) -> Any:
        """把用户文本 + 附件 IDs 装配成内部统一格式。

        - 无附件：返回 str（不打破任何旧路径）
        - 有图片且当前 entry supports_vision：返回 OpenAI 多模态 list[block]
        - 有文档：sidecar 文本拼进 text 部分，磁盘路径附后供 read_file 兜底
        - 不支持 vision 时图片：替换为占位文字
        """
        if not attachment_ids:
            return text
        refs: list[AttachmentRef] = []
        for aid in attachment_ids:
            ref = self.attachments.get(aid)
            if ref is not None:
                refs.append(ref)
        if not refs:
            return text

        image_blocks: list[dict[str, Any]] = []
        text_pieces: list[str] = [text] if text else []
        supports_vision = bool(getattr(self.loop, "supports_vision", False))
        for ref in refs:
            if ref.kind == "image":
                if supports_vision:
                    try:
                        image_blocks.append(encode_for_openai_block(ref, self.attachments))
                    except Exception as exc:
                        logger.warning(f"failed to encode image {ref.id}: {exc}")
                        text_pieces.append(
                            f"\n[图片附件 {ref.name} 编码失败：{exc}]"
                        )
                else:
                    text_pieces.append(
                        f"\n[图片附件 {ref.name}（当前模型未标记视觉，已忽略；"
                        f"可在 /model 测试视觉激活）]"
                    )
            elif ref.has_text:
                txt = self.attachments.read_text(ref)
                if txt:
                    text_pieces.append(
                        f"\n\n[附件 {ref.name} 提取文本]\n{txt}\n[/附件 {ref.name}]"
                    )
                else:
                    text_pieces.append(
                        f"\n[附件 {ref.name} 已落盘但抽取文本为空]"
                    )
            else:
                text_pieces.append(
                    f"\n[附件 {ref.name} 已落盘: {ref.rel_path}（用 read_file 读取）]"
                )
            text_pieces.append(f"\n[已落盘: {ref.rel_path}]")

        full_text = "".join(text_pieces).strip()
        if image_blocks:
            blocks: list[dict[str, Any]] = []
            if full_text:
                blocks.append({"type": "text", "text": full_text})
            blocks.extend(image_blocks)
            return blocks
        return full_text or text

    async def upload_attachment(self, request: web.Request) -> web.Response:
        try:
            reader = await request.multipart()
        except Exception as exc:
            return self._json({"error": f"multipart parse failed: {exc}"}, status=400)
        field = await reader.next()
        if field is None or field.name != "file":
            return self._json({"error": "missing 'file' multipart field"}, status=400)
        raw = await field.read(decode=False)
        name = field.filename or "unnamed"
        mime = (field.headers.get("Content-Type") or "application/octet-stream").split(";")[0].strip()
        try:
            ref = self.attachments.save(raw=raw, name=name, mime=mime)
        except ValueError as exc:
            return self._json({"error": str(exc)}, status=400)
        return self._json(ref_to_json(ref))

    async def attachment_raw(self, request: web.Request) -> web.StreamResponse:
        att_id = request.match_info.get("id", "")
        ref = self.attachments.get(att_id)
        if ref is None:
            return web.Response(status=404, text="attachment not found")
        target = (self.attachments.root / ref.rel_path).resolve()
        if not _is_relative_to(target, self.attachments.root):
            return web.Response(status=403, text="forbidden")
        if not target.exists():
            return web.Response(status=404, text="file missing on disk")
        return web.FileResponse(target, headers={"Content-Type": ref.mime})

    async def model_test(self, request: web.Request) -> web.Response:
        body = await self._body(request)
        entry_name = str(body.get("entryName") or "").strip()
        kind = str(body.get("kind") or "text").lower()
        if kind not in {"text", "vision"}:
            return self._json(
                {"ok": False, "kind": kind, "error": "kind must be 'text' or 'vision'"},
                status=400,
            )
        if not entry_name:
            return self._json(
                {"ok": False, "kind": kind, "error": "entryName required"},
                status=400,
            )

        try:
            snap = build_provider_snapshot(self.root, model_override=entry_name)
        except Exception as exc:
            return self._json({
                "ok": False, "kind": kind,
                "error": f"snapshot failed: {exc}",
            })

        if kind == "vision":
            messages = [{
                "role": "user",
                "content": [
                    {"type": "text",
                     "text": "Reply with ONE English word only: what is the dominant color of this image?"},
                    {"type": "image_url",
                     "image_url": {"url": f"data:image/png;base64,{_PROBE_PNG_RED_BASE64}"}},
                ],
            }]
        else:
            messages = [{"role": "user", "content": "Reply with exactly one word: pong"}]

        started = time.monotonic()
        try:
            resp = await snap.provider.chat(
                messages=messages,
                tools=None,
                model=snap.model,
                max_tokens=64,
                temperature=0.0,
                reasoning_effort=None,
            )
        except Exception as exc:
            return self._json({
                "ok": False, "kind": kind,
                "error": str(exc),
                "latencyMs": int((time.monotonic() - started) * 1000),
                "model": snap.model,
                "provider": snap.provider_name,
            })

        latency = int((time.monotonic() - started) * 1000)
        sample = (resp.content or "").strip()[:200]
        if kind == "vision":
            ok = bool(sample) and any(k in sample.lower() for k in ("red", "红"))
        else:
            ok = bool(sample) and "pong" in sample.lower()

        payload: dict[str, Any] = {
            "ok": ok,
            "kind": kind,
            "latencyMs": latency,
            "model": snap.model,
            "provider": snap.provider_name,
            "sample": sample,
            "finishReason": getattr(resp, "finish_reason", "stop"),
        }

        # 视觉测试通过 → 自动把 entry.supports_vision 持久化为 true
        if kind == "vision" and ok:
            try:
                mark_entry_vision(self.root, entry_name, value=True)
                self.loop.refresh_model_config()
                payload["visionMarked"] = True
            except Exception as exc:
                logger.warning(f"failed to mark entry vision: {exc}")
                payload["visionMarked"] = False

        return self._json(payload)

    async def _broadcast_event(self, event: dict[str, Any]) -> None:
        async with self.broadcast_lock:
            payload = self._remember_event(event)
            disconnected = []
            for client in list(self.clients):
                if client.closed:
                    disconnected.append(client)
                    continue
                try:
                    await self._send_ws(client, payload)
                except (ConnectionResetError, RuntimeError):
                    disconnected.append(client)
            for client in disconnected:
                self.clients.discard(client)

    def _remember_event(self, event: dict[str, Any]) -> dict[str, Any]:
        self.event_seq += 1
        payload = dict(event)
        payload["seq"] = self.event_seq
        self.event_log.append(payload)
        if len(self.event_log) > self.max_event_log:
            self.event_log = self.event_log[-self.max_event_log:]
        return payload

    def ready_event(self, *, last_seq: int = 0, replay_count: int = 0) -> dict[str, Any]:
        return {
            "event": "ready",
            "model": self.loop.model,
            "provider": self.loop.provider_name,
            "latest_seq": self.event_seq,
            "replay_count": replay_count,
            "resume_from": last_seq,
            "busy": self.active_turn,
        }

    async def get_tools(self, request: web.Request) -> web.Response:
        return self._json(self.tools())

    async def get_skills(self, request: web.Request) -> web.Response:
        return self._json(self.skills())

    async def get_skill(self, request: web.Request) -> web.Response:
        return self._json(self.read_skill(request.query.get("name", "")))

    async def post_skill(self, request: web.Request) -> web.Response:
        body = await self._body(request)
        data = self.write_skill(str(body.get("name") or ""), str(body.get("content") or ""))
        return self._json(data)

    async def delete_skill(self, request: web.Request) -> web.Response:
        name = request.query.get("name", "")
        if not _SKILL_RE.match(name):
            raise web.HTTPBadRequest(reason="Invalid skill name")
        skill_dir = self.root / "skills" / name
        if not skill_dir.exists():
            raise web.HTTPNotFound(reason=f"Skill not found: {name}")
        shutil.rmtree(skill_dir, ignore_errors=True)
        self.loop.refresh_runtime_context()
        return self._json({"deleted": name})

    async def import_skills(self, request: web.Request) -> web.Response:
        reader = await request.multipart()
        field = await reader.next()
        if field is None or field.name != "file":
            raise web.HTTPBadRequest(reason="Expected multipart field 'file'")
        tmp = tempfile.NamedTemporaryFile(delete=False, suffix=".zip")
        try:
            while True:
                chunk = await field.read_chunk()
                if not chunk:
                    break
                tmp.write(chunk)
            tmp.close()
            with zipfile.ZipFile(tmp.name, "r") as zf:
                namelist = zf.namelist()
                if not namelist:
                    raise web.HTTPBadRequest(reason="Empty zip file")
                root = namelist[0].split("/")[0]
                if not root or root == ".":
                    raise web.HTTPBadRequest(reason="Cannot determine root directory from zip")
                skill_md = f"{root}/SKILL.md"
                if skill_md not in namelist and f"{root}SKILL.md" in namelist:
                    skill_md = f"{root}SKILL.md"
                if skill_md not in namelist:
                    raise web.HTTPBadRequest(reason=f"Missing SKILL.md in zip root ({root})")
                target = self.root / "skills" / root
                if target.exists():
                    shutil.rmtree(target, ignore_errors=True)
                zf.extractall(self.root / "skills")
            self.loop.refresh_runtime_context()
            return self._json({"imported": root})
        finally:
            Path(tmp.name).unlink(missing_ok=True)

    async def get_config(self, request: web.Request) -> web.Response:
        return self._json(self.read_user_config())

    async def post_config(self, request: web.Request) -> web.Response:
        body = await self._body(request)
        data = self.write_user_config(str(body.get("content") or ""))
        return self._json(data)

    async def get_memory(self, request: web.Request) -> web.Response:
        return self._json(self.memory())

    async def post_memory(self, request: web.Request) -> web.Response:
        body = await self._body(request)
        content = str(body.get("content") or "")
        path = self.root / "memory" / "MEMORY.local.md"
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(content.rstrip() + "\n", encoding="utf-8")
        self.loop.refresh_runtime_context()
        return self._json({"path": "memory/MEMORY.local.md", "content": path.read_text(encoding="utf-8")})

    async def get_memory_episode(self, request: web.Request) -> web.Response:
        date = request.query.get("date", "")
        if not date or ".." in date or "/" in date or "\\" in date:
            raise web.HTTPBadRequest(reason="Invalid date")
        path = self.root / "memory" / f"{date}.md"
        if not path.exists():
            raise web.HTTPNotFound(reason=f"Episode not found: {date}")
        return self._json({"date": date, "content": path.read_text(encoding="utf-8")})

    async def post_memory_episode(self, request: web.Request) -> web.Response:
        body = await self._body(request)
        date = str(body.get("date") or "")
        content = str(body.get("content") or "")
        if not date or ".." in date or "/" in date or "\\" in date:
            raise web.HTTPBadRequest(reason="Invalid date")
        path = self.root / "memory" / f"{date}.md"
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(content.rstrip() + "\n", encoding="utf-8")
        return self._json({"date": date, "content": path.read_text(encoding="utf-8")})

    async def get_tokens(self, request: web.Request) -> web.Response:
        return self._json(self.tokens())

    async def get_model_config(self, request: web.Request) -> web.Response:
        return self._json(self.model_config())

    async def post_model_config(self, request: web.Request) -> web.Response:
        body = await self._body(request)
        config = body.get("config") if isinstance(body.get("config"), dict) else body
        async with self.lock:
            existing = load_model_config(self.root).raw

            # 1) providers 兜底层：占位 "***" 还原原值
            incoming_providers = config.get("providers") or {}
            existing_providers = existing.get("providers") or {}
            for name, prov in incoming_providers.items():
                if isinstance(prov, dict) and isinstance(prov.get("apiKey"), str) and prov["apiKey"].startswith("***"):
                    original = existing_providers.get(name, {}).get("apiKey", "")
                    prov["apiKey"] = original

            # 2) models[] 条目：按 name 匹配旧条目，占位还原
            incoming_models = config.get("models") or []
            existing_models = {
                m.get("name"): m for m in (existing.get("models") or [])
                if isinstance(m, dict) and m.get("name")
            }
            for entry in incoming_models:
                if not isinstance(entry, dict):
                    continue
                ak = entry.get("apiKey")
                if isinstance(ak, str) and ak.startswith("***"):
                    name = entry.get("name")
                    original = existing_models.get(name, {}).get("apiKey", "")
                    entry["apiKey"] = original

            save_model_config(self.root, config)
            self.loop.refresh_model_config()
        return self._json(self.model_config())

    async def post_compact(self, request: web.Request) -> web.Response:
        async with self.lock:
            unarchived = self.loop.memory.load_unarchived_history()
            count = len(unarchived)
            if count < 2:
                return self._json({
                    "status": "skipped",
                    "count": count,
                    "message": "未归档消息不足 2 条，无需压缩。",
                    "memory": self.memory(),
                    "unarchivedHistory": self.unarchived_history(),
                })

            await self.loop.compactor.compact_startup_async(unarchived)
            self.loop.history = []
            self.history = self.loop.history
            self.loop.refresh_runtime_context()
            return self._json({
                "status": "compacted",
                "count": count,
                "message": f"已压缩 {count} 条未归档消息。",
                "memory": self.memory(),
                "unarchivedHistory": self.unarchived_history(),
            })

    async def static(self, request: web.Request) -> web.StreamResponse:
        if not (self.static_dir / "index.html").exists():
            return self._missing_dist_response()

        path = request.match_info.get("tail", "") or "index.html"
        target = (self.static_dir / path).resolve()
        static_root = self.static_dir.resolve()
        if not _is_relative_to(target, static_root):
            raise web.HTTPNotFound()
        if target.is_dir():
            target = target / "index.html"
        if not target.exists():
            target = static_root / "index.html"
        return web.FileResponse(target)

    def _missing_dist_response(self) -> web.Response:
        html = """<!doctype html>
<html lang="zh-CN">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>Emperor Agent WebUI 未构建</title>
    <style>
      :root { color-scheme: light; }
      body {
        margin: 0;
        min-height: 100vh;
        display: grid;
        place-items: center;
        background:
          radial-gradient(circle at 20% 10%, rgba(184, 122, 45, 0.18), transparent 34%),
          linear-gradient(135deg, #f7efde, #efe1c6);
        color: #30241d;
        font-family: "Songti SC", "STSong", Georgia, serif;
      }
      main {
        width: min(680px, calc(100vw - 32px));
        border: 1px solid rgba(151, 44, 31, 0.22);
        border-radius: 28px;
        padding: 32px;
        background: rgba(247, 239, 222, 0.78);
        box-shadow: 0 24px 70px rgba(77, 39, 22, 0.16);
      }
      .seal {
        width: 56px;
        height: 56px;
        display: grid;
        place-items: center;
        border-radius: 18px;
        background: #972c1f;
        color: #f7efde;
        font-size: 28px;
        font-weight: 900;
      }
      h1 { margin: 20px 0 8px; font-size: 34px; }
      p { color: #765b46; line-height: 1.8; }
      code {
        display: block;
        margin-top: 16px;
        padding: 16px;
        border-radius: 16px;
        background: #30241d;
        color: #f7efde;
        font-family: ui-monospace, Menlo, Monaco, Consolas, monospace;
        white-space: pre-wrap;
      }
    </style>
  </head>
  <body>
    <main>
      <div class="seal">令</div>
      <h1>WebUI 还没有构建</h1>
      <p>当前 Python 服务只托管 <strong>webui/dist</strong>。请先构建 Vue 前端，或开发时使用 Vite dev server 访问。</p>
      <code>cd webui
npm install
npm run build</code>
      <p>开发模式可使用：<strong>cd webui && npm run dev</strong>，它会代理 /api 和 /ws 到 http://127.0.0.1:8765。</p>
    </main>
  </body>
</html>"""
        return web.Response(text=html, content_type="text/html")

    def tools(self) -> list[dict[str, Any]]:
        out = []
        for definition in self.loop.registry.get_definitions():
            tool = self.loop.registry.get(definition["name"])
            out.append({
                "name": definition["name"],
                "description": definition["description"],
                "parameters": definition["input_schema"],
                "read_only": bool(getattr(tool, "read_only", False)),
                "exclusive": bool(getattr(tool, "exclusive", False)),
                "concurrency_safe": bool(getattr(tool, "concurrency_safe", False)),
            })
        return out

    def skills(self) -> list[dict[str, Any]]:
        items = []
        for name, skill in sorted(self.loop.skills.skills.items()):
            items.append({
                "name": name,
                "description": skill["meta"].get("description", ""),
                "path": self._rel(skill["path"]),
                "tags": skill["meta"].get("tags", ""),
                "always": bool(skill["meta"].get("always", False)),
            })
        return items

    def read_skill(self, name: str) -> dict[str, Any]:
        skill = self.loop.skills.skills.get(name)
        if not skill:
            raise web.HTTPNotFound(reason=f"Skill not found: {name}")
        path = Path(skill["path"])
        return {
            "name": name,
            "path": self._rel(path),
            "content": path.read_text(encoding="utf-8"),
        }

    def write_skill(self, name: str, content: str) -> dict[str, Any]:
        if not _SKILL_RE.match(name):
            raise web.HTTPBadRequest(reason="Skill name must be a safe directory name")
        skill_dir = self.root / "skills" / name
        skill_dir.mkdir(parents=True, exist_ok=True)
        path = skill_dir / "SKILL.md"
        path.write_text(content.rstrip() + "\n", encoding="utf-8")
        self.loop.refresh_runtime_context()
        return self.read_skill(name)

    def read_user_config(self) -> dict[str, str]:
        path = self._user_config_path()
        return {"path": "templates/USER.local.md", "content": path.read_text(encoding="utf-8")}

    def write_user_config(self, content: str) -> dict[str, str]:
        path = self._user_config_path()
        path.write_text(content.rstrip() + "\n", encoding="utf-8")
        self.loop.refresh_runtime_context()
        return self.read_user_config()

    def memory(self) -> dict[str, Any]:
        memory_dir = self.root / "memory"
        episodes = []
        if memory_dir.exists():
            episodes = [
                self._rel(path)
                for path in sorted(memory_dir.glob("*.md"))
                if path.name not in {"MEMORY.md", "MEMORY.local.md"}
            ]
        return {
            "long_term": self.loop.memory.read_memory(),
            "today_episode": self.loop.memory.read_today_episode(),
            "episodes": episodes,
            "tokens": self.loop.token_tracker.stats_by_date(),
            "tokensByModel": self.loop.token_tracker.stats_by_provider_model(),
            "tokensByUsageType": self.loop.token_tracker.stats_by_usage_type(),
            "tokenTotals": self.loop.token_tracker.totals(),
        }

    def tokens(self) -> dict[str, Any]:
        tracker = self.loop.token_tracker
        return {
            "totals": tracker.totals(),
            "byDate": tracker.stats_by_date(),
            "byModel": tracker.stats_by_provider_model(),
            "byUsageType": tracker.stats_by_usage_type(),
            "byDateModel": tracker.stats_by_date_model(),
            "byHour": tracker.stats_by_hour(),
            "streak": tracker.streak_metrics(),
            "sessions": tracker.session_count(),
            "messages": self._count_history_messages(),
            "generatedAt": datetime.now().isoformat(timespec="seconds"),
        }

    def _count_history_messages(self) -> int:
        history_file = self.loop.memory.history_file
        if not history_file.exists():
            return 0
        count = 0
        try:
            with history_file.open("r", encoding="utf-8") as f:
                for line in f:
                    line = line.strip()
                    if not line:
                        continue
                    try:
                        row = json.loads(line)
                    except json.JSONDecodeError:
                        continue
                    if row.get("role") in {"user", "assistant"}:
                        count += 1
        except OSError as exc:
            logger.warning(f"history.jsonl read failed: {exc}")
        return count

    def unarchived_history(self) -> list[dict[str, Any]]:
        items: list[dict[str, Any]] = []
        for item in self.loop.memory.load_unarchived_history():
            role = item.get("role")
            content = item.get("content")
            if role not in {"user", "assistant"}:
                continue
            text = self._extract_text_content(content)
            out: dict[str, Any] = {"role": role, "content": text}
            ids = item.get("attachments")
            if isinstance(ids, list) and ids:
                refs = []
                for aid in ids:
                    if not isinstance(aid, str):
                        continue
                    ref = self.attachments.get(aid)
                    if ref is not None:
                        refs.append(ref_to_json(ref))
                if refs:
                    out["attachments"] = refs
            items.append(out)
        return items

    @staticmethod
    def _extract_text_content(content: Any) -> str:
        """从 string / OpenAI 多模态 list 中抽出可读 text 部分。"""
        if isinstance(content, str):
            return content
        if isinstance(content, list):
            parts = []
            for block in content:
                if isinstance(block, dict) and block.get("type") == "text":
                    parts.append(str(block.get("text", "")))
            return "".join(parts)
        return ""

    def model_config(self) -> dict[str, Any]:
        config = load_model_config(self.root)
        # 找出当前激活 entry 用于 current 区块
        from .model_config import _resolve_active_entry
        entry = _resolve_active_entry(config, None)
        return {
            "current": {
                "provider": self.loop.provider_name,
                "providerLabel": self.loop.provider_label,
                "model": self.loop.model,
                "apiBase": self.loop.provider_snapshot.api_base,
                "maxTokens": self.loop.max_tokens,
                "temperature": self.loop.temperature,
                "reasoningEffort": self.loop.reasoning_effort,
                "contextWindowTokens": self.loop.max_context,
                "entryName": entry.name,
                "entryLabel": entry.label or entry.name,
                "supportsVision": bool(getattr(self.loop, "supports_vision", False)),
            },
            "config": self._redact_apikeys(config.raw),
            "providerOptions": provider_options(),
        }

    @staticmethod
    def _redact_apikeys(raw: dict) -> dict:
        """Deep-copy config and mask apiKey in both providers[] and models[]."""
        out = copy.deepcopy(raw)

        def _mask(key: str) -> str:
            return "***" + key[-4:] if len(key) > 4 else "***"

        for prov in out.get("providers", {}).values():
            if isinstance(prov, dict) and isinstance(prov.get("apiKey"), str) and prov["apiKey"]:
                prov["apiKey"] = _mask(prov["apiKey"])
        for entry in out.get("models", []) or []:
            if isinstance(entry, dict) and isinstance(entry.get("apiKey"), str) and entry["apiKey"]:
                entry["apiKey"] = _mask(entry["apiKey"])
        return out

    def _user_config_path(self) -> Path:
        template = self.root / "templates" / "init" / "USER.md"
        local = self.root / "templates" / "USER.local.md"
        if not local.exists() and template.exists():
            local.parent.mkdir(parents=True, exist_ok=True)
            local.write_text(template.read_text(encoding="utf-8"), encoding="utf-8")
        return local

    def _rel(self, path: str | Path) -> str:
        return Path(path).resolve().relative_to(self.root).as_posix()

    def _ensure_tool_config(self) -> None:
        path = self.root / "templates" / "TOOL.md"
        path.parent.mkdir(parents=True, exist_ok=True)
        if path.exists():
            return
        path.write_text(
            "# 工具配置\n\n"
            "记录工具使用偏好、权限边界和默认工作方式。\n\n"
            "## 默认原则\n\n"
            "- 优先使用最小权限工具。\n"
            "- 简单检索优先使用 `grep` / `glob`。\n"
            "- 修改文件前先确认目标和影响范围。\n"
            "- 子代理适合独立、可并行、上下文较重的差事。\n",
            encoding="utf-8",
        )

    @staticmethod
    async def _body(request: web.Request) -> dict[str, Any]:
        try:
            data = await request.json()
        except json.JSONDecodeError as exc:
            raise web.HTTPBadRequest(reason="Invalid JSON body") from exc
        if not isinstance(data, dict):
            raise web.HTTPBadRequest(reason="JSON body must be an object")
        return data

    @staticmethod
    async def _send_ws(ws: web.WebSocketResponse, payload: dict[str, Any]) -> None:
        await ws.send_str(json.dumps(payload, ensure_ascii=False))

    @staticmethod
    def _json(data: Any, status: int = 200) -> web.Response:
        return web.json_response(
            data,
            status=status,
            dumps=lambda value: json.dumps(value, ensure_ascii=False),
        )


@web.middleware
async def error_middleware(request: web.Request, handler):
    try:
        return await handler(request)
    except web.HTTPException as exc:
        if request.path.startswith("/api/"):
            return web.json_response(
                {"error": exc.reason or exc.text},
                status=exc.status,
                dumps=lambda value: json.dumps(value, ensure_ascii=False),
            )
        raise
    except Exception as exc:
        logger.exception(f"Unhandled exception in {request.path}")
        if request.path.startswith("/api/"):
            return web.json_response(
                {"error": str(exc)},
                status=500,
                dumps=lambda value: json.dumps(value, ensure_ascii=False),
            )
        raise


def create_app(root: Path) -> web.Application:
    state = WebUIState(root)
    app = web.Application(middlewares=[error_middleware])
    app["state"] = state
    app.router.add_get("/ws", state.ws_handler)
    app.router.add_get("/api/bootstrap", state.bootstrap)
    app.router.add_get("/api/tools", state.get_tools)
    app.router.add_get("/api/skills", state.get_skills)
    app.router.add_get("/api/skill", state.get_skill)
    app.router.add_post("/api/skill", state.post_skill)
    app.router.add_delete("/api/skill", state.delete_skill)
    app.router.add_post("/api/skills/import", state.import_skills)
    app.router.add_get("/api/config", state.get_config)
    app.router.add_post("/api/config", state.post_config)
    app.router.add_get("/api/memory", state.get_memory)
    app.router.add_post("/api/memory", state.post_memory)
    app.router.add_get("/api/memory/episode", state.get_memory_episode)
    app.router.add_post("/api/memory/episode", state.post_memory_episode)
    app.router.add_get("/api/tokens", state.get_tokens)
    app.router.add_get("/api/model-config", state.get_model_config)
    app.router.add_post("/api/model-config", state.post_model_config)
    app.router.add_post("/api/model-test", state.model_test)
    app.router.add_post("/api/attachments", state.upload_attachment)
    app.router.add_get("/api/attachments/{id}/raw", state.attachment_raw)
    app.router.add_post("/api/compact", state.post_compact)
    app.router.add_get("/{tail:.*}", state.static)
    return app


def _is_relative_to(path: Path, parent: Path) -> bool:
    try:
        path.relative_to(parent)
        return True
    except ValueError:
        return False


def _safe_int(value: str | None, fallback: int = 0) -> int:
    try:
        return int(value or fallback)
    except (TypeError, ValueError):
        return fallback


def main() -> None:
    parser = argparse.ArgumentParser(description="Run the Emperor Agent Web UI")
    parser.add_argument("--host", default="127.0.0.1")
    parser.add_argument("--port", default=8765, type=int)
    args = parser.parse_args()

    root = Path(__file__).parent.parent
    logger.info(f"Emperor Agent Web UI: http://{args.host}:{args.port}")
    web.run_app(create_app(root), host=args.host, port=args.port, print=None)


if __name__ == "__main__":
    main()
