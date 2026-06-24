import pytest
from aiohttp import web
from aiohttp.test_utils import TestClient, TestServer

from agent.web.app import error_middleware
from agent.web.auth_guard import auth_guard_middleware, token_from_request


def _req(headers, query=None):
    class R:
        pass

    r = R()
    r.headers = headers
    r.query = query or {}
    return r


def test_token_from_header():
    assert token_from_request(_req({"X-Emperor-Auth-Token": "abc"})) == "abc"


def test_token_from_query():
    assert token_from_request(_req({}, {"token": "xyz"})) == "xyz"


def test_token_absent():
    assert token_from_request(_req({})) == ""


@pytest.mark.anyio
async def test_enforced_when_token_set():
    app = web.Application(middlewares=[error_middleware, auth_guard_middleware])
    app["auth_token"] = "secret"  # noqa: S105 - test token

    async def ping(_request):
        return web.json_response({"ok": True})

    app.router.add_get("/api/ping", ping)
    app.router.add_get("/api/bootstrap", ping)

    async with TestClient(TestServer(app)) as client:
        assert (await client.get("/api/ping")).status == 401  # missing token
        ok = await client.get("/api/ping", headers={"X-Emperor-Auth-Token": "secret"})
        assert ok.status == 200
        assert (await client.get("/api/ping?token=secret")).status == 200  # ws-style query
        assert (await client.get("/api/bootstrap")).status == 200  # exempt probe


@pytest.mark.anyio
async def test_noop_when_token_absent():
    app = web.Application(middlewares=[error_middleware, auth_guard_middleware])  # no app["auth_token"]

    async def ping(_request):
        return web.json_response({"ok": True})

    app.router.add_get("/api/ping", ping)

    async with TestClient(TestServer(app)) as client:
        assert (await client.get("/api/ping")).status == 200  # dev: token-free
