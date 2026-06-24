import pytest
from aiohttp import web
from aiohttp.test_utils import TestClient, TestServer

from agent.web.app import error_middleware
from agent.web.origin_guard import is_local_request, origin_guard_middleware


def _req(headers):
    class _R:
        pass

    r = _R()
    r.headers = headers
    return r


def test_absent_origin_loopback_host_ok():
    assert is_local_request(_req({"Host": "127.0.0.1:8765"}), port=8765) is True


def test_ipv6_loopback_ok():
    assert is_local_request(_req({"Host": "[::1]:8765"}), port=8765) is True


def test_app_scheme_origin_ok():
    assert is_local_request(_req({"Host": "localhost:8765", "Origin": "app://-"}), port=8765) is True


def test_loopback_http_origin_ok():
    assert is_local_request(
        _req({"Host": "127.0.0.1:8765", "Origin": "http://127.0.0.1:8765"}), port=8765
    ) is True


def test_foreign_origin_rejected():
    assert is_local_request(
        _req({"Host": "127.0.0.1:8765", "Origin": "https://evil.example"}), port=8765
    ) is False


def test_rebound_host_rejected():
    assert is_local_request(_req({"Host": "evil.example:8765"}), port=8765) is False


def test_wrong_port_rejected():
    assert is_local_request(_req({"Host": "127.0.0.1:9999"}), port=8765) is False


def test_port_unknown_is_lenient_on_port():
    assert is_local_request(_req({"Host": "127.0.0.1:1234"}), port=None) is True


@pytest.mark.anyio
async def test_api_foreign_origin_renders_json_403():
    # middleware order [error_middleware, origin_guard_middleware] -> /api 403 as JSON
    app = web.Application(middlewares=[error_middleware, origin_guard_middleware])
    app["webui_port"] = None  # lenient on the test server's random port

    async def ping(_request):
        return web.json_response({"ok": True})

    app.router.add_get("/api/ping", ping)

    async with TestClient(TestServer(app)) as client:
        blocked = await client.get("/api/ping", headers={"Origin": "https://evil.example"})
        assert blocked.status == 403
        assert "error" in await blocked.json()

        ok = await client.get("/api/ping")  # no Origin -> native/same-origin allowed
        assert ok.status == 200
