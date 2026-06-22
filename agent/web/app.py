from __future__ import annotations

import json
import uuid
from pathlib import Path

from aiohttp import web
from loguru import logger

from .container import WebContainer
from .routes import (
    assets,
    chat,
    control,
    desktop_pet,
    diagnostics,
    external,
    memory,
    model,
    scheduler,
    sessions,
    skills,
    team,
)


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
    except Exception:
        error_id = uuid.uuid4().hex[:12]
        logger.exception("Unhandled exception in {} [{}]", request.path, error_id)
        if request.path.startswith("/api/"):
            return web.json_response(
                {"error": "Internal server error", "errorId": error_id},
                status=500,
                dumps=lambda value: json.dumps(value, ensure_ascii=False),
            )
        raise


def create_app(
    root: Path,
    *,
    webui_host: str | None = None,
    webui_port: int | None = None,
) -> web.Application:
    container = WebContainer.create(root, webui_host=webui_host, webui_port=webui_port)
    state = container.state
    app = web.Application(middlewares=[error_middleware])
    app["container"] = container
    app["state"] = state
    for register in (
        sessions.register,
        skills.register,
        assets.register,
        memory.register,
        control.register,
        diagnostics.register,
        desktop_pet.register,
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
    container: WebContainer = app["container"]
    await container.startup(app)


async def _cleanup(app: web.Application) -> None:
    container: WebContainer = app["container"]
    await container.cleanup(app)
