from __future__ import annotations

from urllib.parse import urlsplit

from aiohttp import web

# Defends the local-only aiohttp surface against DNS-rebinding / cross-site requests.
# The desktop renderer reaches the backend either same-origin (absent Origin) or via an
# app:// / file:// scheme, so those are allowed; a present foreign http(s) Origin or a
# rebound non-loopback Host is rejected.
_LOCAL_HOSTS = {"127.0.0.1", "localhost", "::1"}
_LOCAL_ORIGIN_SCHEMES = {"app", "file"}


def _split_host_port(value: str) -> tuple[str, str | None]:
    v = (value or "").strip()
    if v.startswith("["):  # [::1]:8765 / [::1]
        host, _, rest = v[1:].partition("]")
        port = rest[1:] if rest.startswith(":") else None
        return host, (port or None)
    if v.count(":") == 1:  # host:port (bare IPv6 has >1 colon and no port)
        host, _, port = v.partition(":")
        return host, (port or None)
    return v, None


def is_local_request(request, *, port: int | None = None) -> bool:
    host, host_port = _split_host_port(request.headers.get("Host") or "")
    if host and host not in _LOCAL_HOSTS:
        return False
    if port is not None and host_port is not None and host_port != str(port):
        return False
    origin = (request.headers.get("Origin") or "").strip()
    if not origin:
        return True
    parts = urlsplit(origin)
    if parts.scheme in _LOCAL_ORIGIN_SCHEMES:
        return True
    return (parts.hostname or "") in _LOCAL_HOSTS


@web.middleware
async def origin_guard_middleware(request: web.Request, handler):
    if not is_local_request(request, port=request.app.get("webui_port")):
        raise web.HTTPForbidden(reason="cross-origin request rejected")
    return await handler(request)
