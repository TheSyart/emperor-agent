"""Session CRUD API — the bootstrap?session and WS?session scoping is tested
in the E2E phase; here we cover the REST endpoints for listing / create / rename /
delete against the `session_store` on the AgentLoop."""
from __future__ import annotations

import json
from pathlib import Path

from aiohttp import web
from aiohttp.test_utils import TestClient, TestServer

from agent.loop import AgentLoop


def _make_app(loop: AgentLoop) -> web.Application:
    """Minimal app with session CRUD routes wired."""
    from agent.web.routes.sessions import register as reg_sessions

    app = web.Application()

    class FakeState:
        pass

    fake = FakeState()
    fake.loop = loop
    reg_sessions(app, fake)
    return app


def test_list_sessions(tmp_path: Path) -> None:
    _ensure_templates(tmp_path)
    loop = AgentLoop(root=tmp_path, verbose=False, startup_compaction=False)
    loop.session_store.create("Alpha")
    loop.session_store.create("Beta")

    import asyncio

    async def run() -> None:
        app = _make_app(loop)
        client = TestClient(TestServer(app))
        await client.start_server()
        try:
            resp = await client.get("/api/sessions")
            assert resp.status == 200
            data = await resp.json()
            assert isinstance(data, list)
            titles = {s["title"] for s in data}
            assert "Alpha" in titles
        finally:
            await client.close()

    asyncio.run(run())


def test_create_session(tmp_path: Path) -> None:
    _ensure_templates(tmp_path)
    loop = AgentLoop(root=tmp_path, verbose=False, startup_compaction=False)

    import asyncio

    async def run() -> None:
        app = _make_app(loop)
        client = TestClient(TestServer(app))
        await client.start_server()
        try:
            resp = await client.post(
                "/api/sessions",
                data=json.dumps({"title": "New"}),
            )
            assert resp.status == 201
            data = await resp.json()
            assert data["title"] == "New"
            assert "id" in data
        finally:
            await client.close()

    asyncio.run(run())


def test_rename_session(tmp_path: Path) -> None:
    _ensure_templates(tmp_path)
    loop = AgentLoop(root=tmp_path, verbose=False, startup_compaction=False)
    s = loop.session_store.create("Old")

    import asyncio

    async def run() -> None:
        app = _make_app(loop)
        client = TestClient(TestServer(app))
        await client.start_server()
        try:
            resp = await client.patch(
                f"/api/sessions/{s['id']}",
                data=json.dumps({"title": "Renamed"}),
            )
            assert resp.status == 200
            data = await resp.json()
            assert data["title"] == "Renamed"
        finally:
            await client.close()

    asyncio.run(run())


def test_delete_session(tmp_path: Path) -> None:
    _ensure_templates(tmp_path)
    loop = AgentLoop(root=tmp_path, verbose=False, startup_compaction=False)
    loop.session_store.create("Keeper")
    s = loop.session_store.create("Victim")

    import asyncio

    async def run() -> None:
        app = _make_app(loop)
        client = TestClient(TestServer(app))
        await client.start_server()
        try:
            resp = await client.delete(f"/api/sessions/{s['id']}")
            assert resp.status == 200
            assert (await resp.json())["deleted"] is True
        finally:
            await client.close()

    asyncio.run(run())


def _ensure_templates(tmp_path: Path) -> None:
    """Create the minimal template files AgentLoop init expects."""
    for p in ["templates/TOOL.md", "templates/USER.local.md", "templates/SOUL.md",
              "templates/init/USER.md", "templates/init/MEMORY.md"]:
        f = tmp_path / p
        f.parent.mkdir(parents=True, exist_ok=True)
        f.write_text("# placeholder")
