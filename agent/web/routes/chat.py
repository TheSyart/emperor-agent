from __future__ import annotations

from aiohttp import web

from ..state import WebUIState


def register(app: web.Application, state: WebUIState) -> None:
    app.router.add_get("/ws", state.chat_service.ws_handler)
    app.router.add_get("/api/bootstrap", state.bootstrap)
    app.router.add_post("/api/runtime/stop", state.post_runtime_stop)
    # API/WS-only backend: the desktop app loads the frontend locally, so any
    # other path returns a JSON 404 instead of an SPA HTML fallback. Registered
    # last so concrete /api/* routes (here and in other modules) match first.
    app.router.add_route("*", "/{tail:.*}", state.not_found)
