from __future__ import annotations

import importlib.util
from pathlib import Path
from typing import Any

from aiohttp import web

from ...local_config import local_config_diagnostics
from ...model_config import load_model_config, validate_complete_model_entries


class DiagnosticsService:
    def __init__(self, state) -> None:
        self.state = state

    async def get_diagnostics(self, request: web.Request) -> web.Response:
        return self.state._json(self.payload())

    def payload(self) -> dict[str, Any]:
        root = self.state.root
        return {
            "modelConfig": self._model_config(root),
            "localConfig": local_config_diagnostics(root),
            "scheduler": self.state.loop.scheduler_store.diagnostics(),
            "runtime": self.state.runtime_events.stats(
                active_turn_ids=self.state.loop.memory.load_unarchived_turn_ids()
            ),
            "external": self.state.external_bridge.payload().get("store", {}),
            "desktopPet": self.state.desktop_pet.diagnostics(),
            "dependencies": self._dependencies(root),
        }

    @staticmethod
    def _model_config(root: Path) -> dict[str, Any]:
        path = root / "model_config.json"
        payload: dict[str, Any] = {
            "path": path.as_posix(),
            "exists": path.exists(),
            "status": "missing" if not path.exists() else "unknown",
            "error": "",
        }
        if not path.exists():
            return payload
        try:
            config = load_model_config(root, create=False)
            validate_complete_model_entries(config.raw)
        except Exception as exc:
            payload["status"] = "invalid"
            payload["error"] = str(exc)
        else:
            payload["status"] = "ok"
            payload["models"] = len(config.models)
        return payload

    @staticmethod
    def _dependencies(root: Path) -> dict[str, Any]:
        packages = ["aiohttp", "openai", "anthropic", "mcp", "filelock", "questionary", "rich"]
        desktop_pet_modules = root / "desktop-pet" / "node_modules"
        return {
            "pythonPackages": {
                package: importlib.util.find_spec(package) is not None
                for package in packages
            },
            "desktopRenderer": (root / "desktop" / "out" / "renderer" / "index.html").exists(),
            "desktopPetNodeModules": desktop_pet_modules.exists(),
        }
