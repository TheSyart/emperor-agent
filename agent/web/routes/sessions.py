"""Session CRUD endpoints. Routes are registered on the aiohttp app and
delegate to the session store already hosted on `AgentLoop`."""
from __future__ import annotations

import json as _json
from aiohttp import web


async def _body(request: web.Request) -> dict:
    if not request.can_read_body:
        return {}
    try:
        data = await request.json()
        return data if isinstance(data, dict) else {}
    except _json.JSONDecodeError:
        return {}


def register(app: web.Application, state) -> None:
    loop = state.loop

    async def list_sessions(_req: web.Request) -> web.Response:
        items = loop.session_store.list()
        return web.json_response(items, dumps=lambda v: _json.dumps(v, ensure_ascii=False))

    async def create_session(req: web.Request) -> web.Response:
        body = await _body(req)
        title = str(body.get("title", "") or "Untitled")
        entry = loop.session_store.create(title)
        return web.json_response(entry, status=201, dumps=lambda v: _json.dumps(v, ensure_ascii=False))

    async def rename_session(req: web.Request) -> web.Response:
        sid = req.match_info["id"]
        body = await _body(req)
        title = str(body.get("title", "")).strip()
        if not title:
            raise web.HTTPBadRequest(reason="title is required")
        ok = loop.session_store.rename(sid, title)
        if not ok:
            raise web.HTTPNotFound()
        items = loop.session_store.list()
        entry = next((e for e in items if e["id"] == sid), None)
        return web.json_response(entry or {}, dumps=lambda v: _json.dumps(v, ensure_ascii=False))

    async def delete_session(req: web.Request) -> web.Response:
        sid = req.match_info["id"]
        ok = loop.session_store.delete(sid)
        if not ok:
            raise web.HTTPBadRequest(reason="cannot delete session")
        return web.json_response({"deleted": True}, dumps=lambda v: _json.dumps(v, ensure_ascii=False))

    async def activate_session(req: web.Request) -> web.Response:
        sid = req.match_info["id"]
        loop.activate_session(sid)
        return web.json_response({"active": sid, "complete": True}, dumps=lambda v: _json.dumps(v, ensure_ascii=False))

    app.router.add_get("/api/sessions", list_sessions)
    app.router.add_post("/api/sessions", create_session)
    app.router.add_patch("/api/sessions/{id}", rename_session)
    app.router.add_delete("/api/sessions/{id}", delete_session)
    app.router.add_post("/api/sessions/{id}/activate", activate_session)
