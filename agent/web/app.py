from __future__ import annotations

import json
from pathlib import Path

from aiohttp import web
from loguru import logger

from .routes import assets, chat, control, external, memory, model, scheduler, skills, team
from .state import WebUIState


@web.middleware
async def error_middleware(request: web.Request, handler):
    try:
        return await handler(request)
    except web.HTTPException as exc:
        if request.path.startswith("/api/"):
            return web.json_response(
                {"error": exc.reason or exc.text},
                status=exc.status,
                dumps=lambda value: json.dumps(value, ensure_ascii=False),
            )
        raise
    except Exception as exc:
        logger.exception(f"Unhandled exception in {request.path}")
        if request.path.startswith("/api/"):
            return web.json_response(
                {"error": str(exc)},
                status=500,
                dumps=lambda value: json.dumps(value, ensure_ascii=False),
            )
        raise


def create_app(root: Path) -> web.Application:
    state = WebUIState(root)
    app = web.Application(middlewares=[error_middleware])
    app["state"] = state
    for register in (
        skills.register,
        assets.register,
        memory.register,
        control.register,
        team.register,
        scheduler.register,
        external.register,
        model.register,
        chat.register,
    ):
        register(app, state)
    app.on_startup.append(_startup)
    app.on_cleanup.append(_cleanup)
    return app


async def _startup(app: web.Application) -> None:
    state: WebUIState = app["state"]
    await state.external_bridge.start()
    await state.loop.scheduler_service.start()


async def _cleanup(app: web.Application) -> None:
    state: WebUIState = app["state"]
    state.loop.scheduler_service.stop()
    await state.external_bridge.stop()
