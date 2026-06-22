from __future__ import annotations

import asyncio

from aiohttp import web
from aiohttp.test_utils import TestClient, TestServer

from agent.web.routes.chat import register


class FakeChatService:
    async def ws_handler(self, request: web.Request) -> web.Response:
        return web.Response(text="ws")


class FakeState:
    def __init__(self) -> None:
        self.chat_service = FakeChatService()

    async def bootstrap(self, request: web.Request) -> web.Response:
        return web.json_response({"ok": True})

    async def post_runtime_stop(self, request: web.Request) -> web.Response:
        return web.json_response({"stopped": True})

    async def not_found(self, request: web.Request) -> web.Response:
        return web.json_response({"error": "not_found"}, status=404)


def test_backend_serves_api_and_does_not_fall_back_to_spa_html() -> None:
    async def scenario() -> None:
        app = web.Application()
        register(app, FakeState())  # type: ignore[arg-type]
        client = TestClient(TestServer(app))
        await client.start_server()
        try:
            ok = await client.get("/api/bootstrap")
            assert ok.status == 200
            assert (await ok.json())["ok"] is True

            # An unknown, non-api path must NOT return SPA HTML — the backend is
            # API/WS-only after the desktop migration.
            miss = await client.get("/some/deep/route")
            assert miss.status == 404
            body = await miss.text()
            assert 'id="app"' not in body
            assert "webui/dist" not in body
        finally:
            await client.close()

    asyncio.run(scenario())


def test_api_and_ws_routes_are_registered() -> None:
    app = web.Application()
    register(app, FakeState())  # type: ignore[arg-type]
    canonical = {getattr(route.resource, "canonical", None) for route in app.router.routes()}
    assert "/ws" in canonical
    assert "/api/bootstrap" in canonical
