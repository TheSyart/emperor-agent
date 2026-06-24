from __future__ import annotations

from aiohttp import web

# Packaged-only defense-in-depth on top of origin_guard. Enforced only when the app has
# an auth token (set from EMPEROR_WEBUI_TOKEN by the packaged Electron launcher); dev /
# standalone backends run token-free. /api/bootstrap stays exempt so the Electron
# readiness probe works before the token handshake.
_EXEMPT_PATHS = {"/api/bootstrap"}


def token_from_request(request) -> str:
    header = (request.headers.get("X-Emperor-Auth-Token") or "").strip()
    if header:
        return header
    return str(request.query.get("token") or "").strip()


@web.middleware
async def auth_guard_middleware(request: web.Request, handler):
    expected = request.app.get("auth_token")
    if not expected:  # dev / standalone: no enforcement
        return await handler(request)
    path = request.path
    if path in _EXEMPT_PATHS:
        return await handler(request)
    if path.startswith("/api/") or path == "/ws":
        if token_from_request(request) != expected:
            raise web.HTTPUnauthorized(reason="invalid or missing auth token")
    return await handler(request)
