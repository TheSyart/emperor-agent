from __future__ import annotations

import json
import os
import shlex
import signal
import subprocess
import time
from collections.abc import Callable
from dataclasses import replace
from pathlib import Path
from typing import Any

from loguru import logger

from ..local_config import load_local_config, save_local_config

PopenFactory = Callable[..., subprocess.Popen]


class DesktopPetManager:
    """Manage the optional Electron desktop pet companion process."""

    def __init__(
        self,
        root: Path,
        *,
        popen_factory: PopenFactory | None = None,
        process_alive: Callable[[int], bool] | None = None,
    ) -> None:
        self.root = Path(root).resolve()
        self.runtime_dir = self.root / "memory" / "desktop_pet"
        self.pid_file = self.runtime_dir / "pid.json"
        self.state_file = self.runtime_dir / "state.json"
        self.app_dir = self.root / "desktop-pet"
        self._popen_factory = popen_factory or subprocess.Popen
        self._process_alive = process_alive or _process_alive
        self._owned_pid: int | None = None

    @property
    def install_command(self) -> str:
        if self._packaged_command_base():
            return "bundled with Emperor Agent.app"
        return "cd desktop-pet && npm install"

    def payload(self) -> dict[str, Any]:
        config = load_local_config(self.root)
        pid = self._read_pid()
        running = bool(pid and self._process_alive(pid))
        return {
            "enabled": config.desktop_pet.enabled,
            "autoStartWithWebui": config.desktop_pet.auto_start_with_webui,
            "running": running,
            "pid": pid if running else None,
            "lastError": self._read_state().get("lastError"),
            "installCommand": self.install_command,
        }

    def diagnostics(self) -> dict[str, Any]:
        payload = self.payload()
        electron = self._electron_binary()
        main_js = self.app_dir / "main.js"
        packaged = self._packaged_command_base()
        pid = self._read_pid()
        stale_pid = bool(pid and not self._process_alive(pid))
        return {
            **payload,
            "optional": True,
            "appDir": self.app_dir.as_posix(),
            "packagedCommand": packaged,
            "stateFile": self.state_file.as_posix(),
            "pidFile": self.pid_file.as_posix(),
            "electronPath": electron.as_posix(),
            "electronInstalled": bool(packaged) or electron.exists(),
            "mainJsExists": bool(packaged) or main_js.exists(),
            "stalePid": stale_pid,
        }

    def set_enabled(
        self,
        enabled: bool,
        *,
        host: str | None = None,
        port: int | None = None,
    ) -> dict[str, Any]:
        config = load_local_config(self.root)
        next_config = replace(
            config,
            desktop_pet=replace(config.desktop_pet, enabled=bool(enabled)),
        )
        save_local_config(self.root, next_config)
        if enabled:
            return self.start(host=host, port=port)
        self.stop()
        return self.payload()

    def start_for_webui(self, *, host: str, port: int) -> dict[str, Any]:
        config = load_local_config(self.root)
        if not config.desktop_pet.enabled or not config.desktop_pet.auto_start_with_webui:
            return self.payload()
        return self.start(host=host, port=port, owned=True)

    def start(
        self,
        *,
        host: str | None = None,
        port: int | None = None,
        owned: bool = False,
    ) -> dict[str, Any]:
        existing = self.payload()
        if existing["running"]:
            return existing
        self._clear_stale_pid()

        packaged_base = self._packaged_command_base()
        if packaged_base:
            executable = Path(packaged_base[0]).expanduser()
            if executable.is_absolute() and not executable.exists():
                return self._fail(f"Packaged desktop pet command is missing: {executable}")
            cmd_base = packaged_base
        else:
            electron = self._electron_binary()
            if not electron.exists():
                return self._fail(
                    f"Electron dependency missing. Run `{self.install_command}` before starting the desktop pet."
                )
            if not (self.app_dir / "main.js").exists():
                return self._fail("desktop-pet/main.js is missing.")
            cmd_base = [str(electron), str(self.app_dir)]

        config = load_local_config(self.root)
        web_host = host or config.webui.host
        web_port = port or config.webui.port
        webui_url = f"http://{web_host}:{web_port}"
        env = {
            **os.environ,
            "EMPEROR_AGENT_ROOT": str(self.root),
            "EMPEROR_WEBUI_URL": webui_url,
        }
        cmd = [
            *cmd_base,
            "--webui-url",
            webui_url,
            "--root",
            str(self.root),
        ]

        try:
            proc = self._popen_factory(
                cmd,
                cwd=str(self.app_dir),
                env=env,
                stdout=subprocess.DEVNULL,
                stderr=subprocess.DEVNULL,
                start_new_session=True,
            )
        except Exception as exc:
            logger.warning("desktop pet start failed: {}", exc)
            return self._fail(f"Failed to start desktop pet: {exc}")

        pid = int(proc.pid)
        if owned:
            self._owned_pid = pid
        self._write_pid(pid, cmd=cmd)
        self._write_state({"lastError": None, "startedAt": time.time()})
        return self.payload()

    def stop(self) -> dict[str, Any]:
        pid = self._read_pid()
        if pid and self._process_alive(pid):
            _terminate_process(pid)
        self._owned_pid = None
        self.pid_file.unlink(missing_ok=True)
        self._write_state({"lastError": None, "stoppedAt": time.time()})
        return self.payload()

    def stop_if_owned(self) -> None:
        if self._owned_pid is None:
            return
        if self._process_alive(self._owned_pid):
            _terminate_process(self._owned_pid)
        pid = self._read_pid()
        if pid == self._owned_pid:
            self.pid_file.unlink(missing_ok=True)
        self._owned_pid = None

    def restart(self) -> dict[str, Any]:
        config = load_local_config(self.root)
        if not config.desktop_pet.enabled:
            save_local_config(
                self.root,
                replace(config, desktop_pet=replace(config.desktop_pet, enabled=True)),
            )
        self.stop()
        return self.start()

    def _electron_binary(self) -> Path:
        if os.name == "nt":
            return self.app_dir / "node_modules" / ".bin" / "electron.cmd"
        return self.app_dir / "node_modules" / ".bin" / "electron"

    def _packaged_command_base(self) -> list[str]:
        raw = (os.environ.get("EMPEROR_DESKTOP_PET_CMD") or "").strip()
        if not raw:
            return []
        try:
            parsed = json.loads(raw)
        except json.JSONDecodeError:
            parsed = None
        if isinstance(parsed, list) and all(isinstance(item, str) and item for item in parsed):
            return parsed
        try:
            return shlex.split(raw)
        except ValueError:
            return []

    def _read_pid(self) -> int | None:
        try:
            raw = json.loads(self.pid_file.read_text(encoding="utf-8"))
        except (OSError, json.JSONDecodeError):
            return None
        try:
            pid = int(raw.get("pid"))
        except (TypeError, ValueError):
            return None
        return pid if pid > 0 else None

    def _write_pid(self, pid: int, *, cmd: list[str]) -> None:
        self.runtime_dir.mkdir(parents=True, exist_ok=True)
        self.pid_file.write_text(
            json.dumps({"pid": pid, "cmd": cmd, "updatedAt": time.time()}, indent=2) + "\n",
            encoding="utf-8",
        )

    def _clear_stale_pid(self) -> None:
        pid = self._read_pid()
        if pid and self._process_alive(pid):
            return
        self.pid_file.unlink(missing_ok=True)

    def _read_state(self) -> dict[str, Any]:
        try:
            raw = json.loads(self.state_file.read_text(encoding="utf-8"))
        except (OSError, json.JSONDecodeError):
            return {}
        return raw if isinstance(raw, dict) else {}

    def _write_state(self, updates: dict[str, Any]) -> None:
        self.runtime_dir.mkdir(parents=True, exist_ok=True)
        state = self._read_state()
        state.update(updates)
        self.state_file.write_text(json.dumps(state, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")

    def _fail(self, message: str) -> dict[str, Any]:
        self._write_state({"lastError": message, "lastErrorAt": time.time()})
        return self.payload()


def _process_alive(pid: int) -> bool:
    try:
        os.kill(pid, 0)
        return True
    except OSError:
        return False


def _terminate_process(pid: int) -> None:
    try:
        os.kill(pid, signal.SIGTERM)
    except OSError:
        return
    deadline = time.time() + 2
    while time.time() < deadline:
        if not _process_alive(pid):
            return
        time.sleep(0.05)
    try:
        os.kill(pid, getattr(signal, "SIGKILL", signal.SIGTERM))
    except OSError:
        pass
