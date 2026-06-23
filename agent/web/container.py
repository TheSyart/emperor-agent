from __future__ import annotations

from dataclasses import dataclass
from pathlib import Path

from aiohttp import web

from .state import WebUIState


@dataclass
class WebContainer:
    """Composition boundary for the aiohttp WebUI application."""

    state: WebUIState

    @property
    def plan_store(self):
        return self.state.loop.control_manager.plan_store

    @property
    def task_manager(self):
        return self.state.loop.task_manager

    @classmethod
    def create(
        cls,
        root: Path,
        *,
        webui_host: str | None = None,
        webui_port: int | None = None,
    ) -> WebContainer:
        return cls(WebUIState(root, webui_host=webui_host, webui_port=webui_port))

    async def startup(self, app: web.Application) -> None:
        await self.state.external_bridge.start()
        await self.state.loop.scheduler_service.start()
        self.state.start_desktop_pet_for_webui()

    async def cleanup(self, app: web.Application) -> None:
        self.state.desktop_pet.stop_if_owned()
        self.state.loop.scheduler_service.stop()
        await self.state.external_bridge.stop()
