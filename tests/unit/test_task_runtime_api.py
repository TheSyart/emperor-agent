from __future__ import annotations

import asyncio

from aiohttp import web
from aiohttp.test_utils import TestClient, TestServer

from agent.tasks import TaskKind, TaskManager
from agent.web.routes import tasks


class FakeContainer:
    def __init__(self, task_manager: TaskManager) -> None:
        self.task_manager = task_manager


def test_task_routes_list_get_and_read_transcript(tmp_path) -> None:
    async def scenario() -> None:
        manager = TaskManager(tmp_path)
        record = manager.start_task(
            kind=TaskKind.SUBAGENT.value,
            title="Inspect files",
            source="dispatch_subagent",
            turn_id="turn_1",
            tool_call_id="call_1",
            metadata={"agent_type": "reviewer"},
        )
        manager.append_sidechain(record.id, {"role": "user", "content": "inspect"})
        manager.append_sidechain(record.id, {"role": "assistant", "content": "done"})
        manager.complete_task(record.id, summary="done")

        app = web.Application()
        app["container"] = FakeContainer(manager)
        tasks.register(app, None)  # type: ignore[arg-type]
        client = TestClient(TestServer(app))
        await client.start_server()
        try:
            list_response = await client.get("/api/tasks")
            list_data = await list_response.json()
            assert list_response.status == 200
            assert list_data["tasks"][0]["id"] == record.id
            assert list_data["tasks"][0]["status"] == "completed"
            assert list_data["tasks"][0]["turnId"] == "turn_1"

            detail_response = await client.get(f"/api/tasks/{record.id}")
            detail_data = await detail_response.json()
            assert detail_response.status == 200
            assert detail_data["task"]["metadata"]["agent_type"] == "reviewer"

            transcript_response = await client.get(f"/api/tasks/{record.id}/transcript?offset=0&limit=1")
            transcript_data = await transcript_response.json()
            assert transcript_response.status == 200
            assert transcript_data["task"]["id"] == record.id
            assert transcript_data["transcript"]["messages"][0]["content"] == "inspect"
            assert transcript_data["transcript"]["nextOffset"] == 1
        finally:
            await client.close()

    asyncio.run(scenario())


def test_task_routes_return_404_for_unknown_task(tmp_path) -> None:
    async def scenario() -> None:
        app = web.Application()
        app["container"] = FakeContainer(TaskManager(tmp_path))
        tasks.register(app, None)  # type: ignore[arg-type]
        client = TestClient(TestServer(app))
        await client.start_server()
        try:
            response = await client.get("/api/tasks/missing")
            assert response.status == 404

            transcript_response = await client.get("/api/tasks/missing/transcript")
            assert transcript_response.status == 404
        finally:
            await client.close()

    asyncio.run(scenario())
