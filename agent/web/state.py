from __future__ import annotations

import asyncio
import json
import re
import shutil
import tempfile
import uuid
import zipfile
from pathlib import Path
from typing import Any

from aiohttp import web

from ..attachments import (
    AttachmentStore,
    ref_to_json,
)
from ..external import ExternalBridgeService
from ..logger import configure as configure_logging
from ..loop import AgentLoop
from ..mcp.config import load_mcp_config, save_mcp_config
from ..runtime import RuntimeEventStore
from ..runtime import events as runtime_events
from ..runtime.active import ActiveTaskInfo, ActiveTaskRegistry
from ..watchlist import WatchlistService
from .services import (
    ChatService,
    MainlineTurnService,
    MemoryService,
    ModelService,
    SchedulerJobExecutor,
    SchedulerWebService,
    TeamService,
)

_SKILL_RE = re.compile(r"^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,80}$")


class WebUIState:
    def __init__(self, root: Path):
        self.root = root.resolve()
        configure_logging(self.root)
        self.static_dir = self.root / "webui" / "dist"
        self._ensure_tool_config()
        self.loop = AgentLoop(root=self.root, verbose=False, startup_compaction=False)
        self.loop.init_mcp()
        self.mainline_turn_service = MainlineTurnService(self)
        self.external_bridge = ExternalBridgeService(
            submit_turn=self.mainline_turn_service.submit,
            can_accept_turn=self._external_can_accept_turn,
            event_sink=self._broadcast_event,
        )
        self.chat_service = ChatService(self)
        self.memory_service = MemoryService(self)
        self.model_service = ModelService(self)
        self.team_service = TeamService(self)
        self.scheduler_web_service = SchedulerWebService(self)
        self.scheduler_job_executor = SchedulerJobExecutor(self)
        self.history = self.loop.history
        self.attachments = AttachmentStore(self.root)
        self.lock = asyncio.Lock()
        self.clients: set[web.WebSocketResponse] = set()
        self.runtime_events = RuntimeEventStore(self.root)
        self.watchlist_service = WatchlistService(
            self.root,
            model_router=self.loop.model_router,
            token_tracker=self.loop.token_tracker,
        )
        self.broadcast_lock = asyncio.Lock()
        self.max_event_log = 5000
        self.event_log: list[dict[str, Any]] = self.runtime_events.recent(self.max_event_log)
        self.event_seq = self.runtime_events.latest_seq
        self.active_turn = False
        self.active_tasks = ActiveTaskRegistry()
        self.loop.scheduler_service.on_job = self.scheduler_job_executor.run
        self.loop.scheduler_service.event_sink = self._broadcast_scheduler_event

    async def bootstrap(self, request: web.Request) -> web.Response:
        return self._json({
            "app": "Emperor Agent",
            "model": self.loop.model,
            "provider": self.loop.provider_name,
            "providerLabel": self.loop.provider_label,
            "tools": self.tools(),
            "skills": self.skills(),
            "memory": self.memory_service.memory(),
            "modelConfig": self.model_config(),
            "team": self.team_service.team(),
            "scheduler": self.scheduler_web_service.scheduler(),
            "control": self.control(),
            "context_used": self.loop.token_tracker.last_input_tokens(),
            "unarchivedHistory": self.memory_service.unarchived_history(),
            "runtime": self.memory_service.runtime(),
        })

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
        payload, status = await self.model_service.test(await self._body(request))
        return self._json(payload, status=status)

    async def _broadcast_event(self, event: dict[str, Any], *, turn_id: str | None = None) -> None:
        async with self.broadcast_lock:
            payload = self._remember_event(event, turn_id=turn_id)
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

    def _remember_event(self, event: dict[str, Any], *, turn_id: str | None = None) -> dict[str, Any]:
        payload = self.runtime_events.append(event, turn_id=turn_id)
        self.event_seq = int(payload.get("seq") or self.event_seq)
        self.event_log.append(payload)
        if len(self.event_log) > self.max_event_log:
            self.event_log = self.event_log[-self.max_event_log:]
        return payload

    async def _broadcast_scheduler_event(self, event: dict[str, Any]) -> None:
        await self._broadcast_event(event)

    def _external_can_accept_turn(self) -> bool:
        return not self.active_turn and not bool(self.control().get("pending"))

    def compact_runtime_events(self) -> dict[str, Any]:
        stats = self.runtime_events.compact(self.loop.memory.load_unarchived_turn_ids())
        self.event_log = self.runtime_events.recent(self.max_event_log)
        self.event_seq = self.runtime_events.latest_seq
        return stats

    def ready_event(self, *, last_seq: int = 0, replay_count: int = 0) -> dict[str, Any]:
        return runtime_events.ready_event(
            model=self.loop.model,
            provider=self.loop.provider_name,
            latest_seq=self.event_seq,
            replay_count=replay_count,
            resume_from=last_seq,
            busy=self.active_turn,
            control=self.control(),
        )

    async def post_runtime_stop(self, request: web.Request) -> web.Response:
        body = await self._body(request) if request.can_read_body else {}
        task_id = str(body.get("task_id") or "") or None
        kind = str(body.get("kind") or "") or None
        if kind not in {None, "", "turn", "scheduler", "team", "watchlist"}:
            raise web.HTTPBadRequest(reason="Invalid task kind")
        cancelled = await self.active_tasks.cancel(
            task_id=task_id,
            kind=kind if kind else None,  # type: ignore[arg-type]
        )
        for info in cancelled:
            await self._broadcast_cancelled_task(info, reason="user requested stop")
        if any(info.kind == "turn" for info in cancelled):
            self.active_turn = False
        return self._json({
            "cancelled": [info.to_dict() for info in cancelled],
            "active": [info.to_dict() for info in await self.active_tasks.list()],
        })

    async def _broadcast_cancelled_task(self, info: ActiveTaskInfo, *, reason: str) -> None:
        await self._broadcast_event(
            runtime_events.runtime_task_cancelled(info.to_dict(), reason=reason),
            turn_id=info.turn_id,
        )

    async def get_tools(self, request: web.Request) -> web.Response:
        return self._json(self.tools())

    async def get_external(self, request: web.Request) -> web.Response:
        return self._json(self.external_bridge.payload())

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

    async def get_control(self, request: web.Request) -> web.Response:
        return self._json(self.control())

    async def post_control_mode(self, request: web.Request) -> web.Response:
        if self.active_turn:
            raise web.HTTPConflict(reason="Cannot change control mode while a turn is running")
        if self.control().get("pending"):
            raise web.HTTPConflict(reason="Cannot change control mode while Ask / Plan is pending")
        body = await self._body(request)
        mode = str(body.get("mode") or "")
        data = self.loop.control_manager.set_mode(mode)
        await self._broadcast_event(runtime_events.control_mode_update(data))
        return self._json(data)

    async def post_control_cancel(self, request: web.Request) -> web.Response:
        interaction_id = request.match_info.get("id", "")
        turn_id = self.new_turn_id()
        event = self.loop.control_manager.cancel(interaction_id)
        await self.chat_service.record_control_cancel(
            str(event.get("message") or ""),
            "已取消等待中的交互",
            turn_id=turn_id,
        )
        await self._broadcast_event(event, turn_id=turn_id)
        await self._broadcast_event(runtime_events.control_mode_update(self.control()))
        return self._json(self.control())

    async def get_model_config(self, request: web.Request) -> web.Response:
        return self._json(self.model_config())

    async def post_model_config(self, request: web.Request) -> web.Response:
        body = await self._body(request)
        config = body.get("config") if isinstance(body.get("config"), dict) else body
        async with self.lock:
            try:
                self.model_service.save(config)
            except ValueError as exc:
                return self._json({"error": str(exc)}, status=400)
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
                    "memory": self.memory_service.memory(),
                    "unarchivedHistory": self.memory_service.unarchived_history(),
                })

            await self.loop.compactor.compact_startup_async(unarchived)
            self.compact_runtime_events()
            self.loop.history = []
            self.history = self.loop.history
            self.loop.refresh_runtime_context()
            return self._json({
                "status": "compacted",
                "count": count,
                "message": f"已压缩 {count} 条未归档消息。",
                "memory": self.memory_service.memory(),
                "unarchivedHistory": self.memory_service.unarchived_history(),
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
            is_mcp = definition["name"].startswith("mcp_")
            server = ""
            if is_mcp:
                parts = definition["name"].split("_", 2)
                server = parts[1] if len(parts) >= 2 else ""
            out.append({
                "name": definition["name"],
                "description": definition["description"],
                "parameters": definition["input_schema"],
                "read_only": bool(getattr(tool, "read_only", False)),
                "exclusive": bool(getattr(tool, "exclusive", False)),
                "concurrency_safe": bool(getattr(tool, "concurrency_safe", False)),
                "source": "mcp" if is_mcp else "builtin",
                "server": server,
            })
        return out

    async def get_mcp_config(self, request: web.Request) -> web.Response:
        config = load_mcp_config(self.root)
        raw: dict[str, Any] = {"servers": {}, "defaults": config.defaults}
        for name, server in config.servers.items():
            raw["servers"][name] = {
                "transport": server.transport,
                "command": server.command,
                "args": list(server.args),
                "env": server.env,
                "url": server.url,
                "headers": server.headers,
                "enabled": server.enabled,
                "tool_overrides": server.tool_overrides,
            }
        return self._json(raw)

    async def post_mcp_config(self, request: web.Request) -> web.Response:
        body = await self._body(request)
        if not isinstance(body.get("servers"), dict):
            raise web.HTTPBadRequest(reason="mcp_config: 'servers' must be an object")
        save_mcp_config(self.root, body)
        # 重新加载 MCP：关闭旧连接，重新初始化
        self.loop.close_mcp()
        self.loop.registry.unregister_mcp_tools()
        self.loop.init_mcp()
        return self._json({"saved": True})

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

    def control(self) -> dict[str, Any]:
        return self.loop.control_manager.payload()

    def new_turn_id(self) -> str:
        return f"turn_{uuid.uuid4().hex[:16]}"

    def attachment_refs(self, attachment_ids: list[str]) -> list[dict[str, Any]]:
        refs: list[dict[str, Any]] = []
        for aid in attachment_ids:
            ref = self.attachments.get(aid)
            if ref is not None:
                refs.append(ref_to_json(ref))
        return refs

    @staticmethod
    def safe_int(value: str | None, fallback: int = 0) -> int:
        try:
            return int(value or fallback)
        except (TypeError, ValueError):
            return fallback

    def model_config(self) -> dict[str, Any]:
        return self.model_service.payload()

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


def _is_relative_to(path: Path, parent: Path) -> bool:
    try:
        path.relative_to(parent)
        return True
    except ValueError:
        return False
