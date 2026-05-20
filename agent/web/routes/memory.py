from __future__ import annotations

from aiohttp import web

from ..state import WebUIState


def register(app: web.Application, state: WebUIState) -> None:
    service = state.memory_service
    app.router.add_get("/api/memory", service.get_memory)
    app.router.add_post("/api/memory", service.post_memory)
    app.router.add_get("/api/memory/episode", service.get_memory_episode)
    app.router.add_post("/api/memory/episode", service.post_memory_episode)
    app.router.add_get("/api/watchlist", service.get_watchlist)
    app.router.add_post("/api/watchlist", service.post_watchlist)
    app.router.add_post("/api/watchlist/check", service.post_watchlist_check)
    app.router.add_get("/api/tokens", service.get_tokens)
    app.router.add_post("/api/compact", state.post_compact)
