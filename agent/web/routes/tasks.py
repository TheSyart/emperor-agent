from __future__ import annotations

from aiohttp import web


def register(app: web.Application, state) -> None:
    app.router.add_get("/api/tasks", list_tasks)
    app.router.add_get("/api/tasks/{task_id}", get_task)
    app.router.add_get("/api/tasks/{task_id}/transcript", get_task_transcript)


async def list_tasks(request: web.Request) -> web.Response:
    manager = request.app["container"].task_manager
    limit = _int_query(request, "limit", default=100, minimum=1, maximum=500)
    records = sorted(manager.store.list(), key=lambda item: item.started_at, reverse=True)
    return web.json_response({"tasks": [item.to_runtime_dict() for item in records[:limit]]})


async def get_task(request: web.Request) -> web.Response:
    manager = request.app["container"].task_manager
    record = manager.store.get(request.match_info["task_id"])
    if record is None:
        raise web.HTTPNotFound(reason="task not found")
    return web.json_response({"task": record.to_runtime_dict()})


async def get_task_transcript(request: web.Request) -> web.Response:
    manager = request.app["container"].task_manager
    record = manager.store.get(request.match_info["task_id"])
    if record is None:
        raise web.HTTPNotFound(reason="task not found")
    offset = _int_query(request, "offset", default=0, minimum=0, maximum=1_000_000)
    limit = _int_query(request, "limit", default=100, minimum=1, maximum=500)
    return web.json_response({
        "task": record.to_runtime_dict(),
        "transcript": manager.read_sidechain(record.id, offset=offset, limit=limit),
    })


def _int_query(
    request: web.Request,
    key: str,
    *,
    default: int,
    minimum: int,
    maximum: int,
) -> int:
    raw = request.query.get(key)
    if raw is None:
        return default
    try:
        value = int(raw)
    except ValueError:
        return default
    return max(minimum, min(maximum, value))
