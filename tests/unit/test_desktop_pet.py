from __future__ import annotations

from pathlib import Path
from types import SimpleNamespace

from agent.desktop_pet import DesktopPetManager
from agent.local_config import (
    DesktopPetPreferences,
    LocalConfig,
    load_local_config,
    save_local_config,
)


def _install_fake_electron(root: Path) -> None:
    app_dir = root / "desktop-pet"
    electron = app_dir / "node_modules" / ".bin" / "electron"
    electron.parent.mkdir(parents=True)
    electron.write_text("#!/bin/sh\n", encoding="utf-8")
    (app_dir / "main.js").write_text("// fake\n", encoding="utf-8")


def test_desktop_pet_start_stop_and_repeat_instance(tmp_path, monkeypatch) -> None:
    _install_fake_electron(tmp_path)
    save_local_config(
        tmp_path,
        LocalConfig(desktop_pet=DesktopPetPreferences(enabled=True, auto_start_with_webui=True)),
    )
    alive: set[int] = set()
    calls: list[dict] = []

    def fake_popen(cmd, **kwargs):
        calls.append({"cmd": cmd, "kwargs": kwargs})
        alive.add(4242)
        return SimpleNamespace(pid=4242)

    monkeypatch.setattr("agent.desktop_pet.manager._terminate_process", lambda pid: alive.discard(pid))
    manager = DesktopPetManager(tmp_path, popen_factory=fake_popen, process_alive=lambda pid: pid in alive)

    started = manager.start(host="127.0.0.1", port=8765)
    repeated = manager.start(host="127.0.0.1", port=8765)

    assert started["running"] is True
    assert started["pid"] == 4242
    assert repeated["running"] is True
    assert len(calls) == 1
    assert "--webui-url" in calls[0]["cmd"]
    assert "http://127.0.0.1:8765" in calls[0]["cmd"]

    stopped = manager.set_enabled(False)

    assert stopped["enabled"] is False
    assert stopped["running"] is False
    assert alive == set()


def test_desktop_pet_missing_electron_records_error_without_throwing(tmp_path) -> None:
    manager = DesktopPetManager(tmp_path, process_alive=lambda pid: False)

    payload = manager.set_enabled(True)

    assert payload["enabled"] is True
    assert payload["running"] is False
    assert "Electron dependency missing" in str(payload["lastError"])
    assert load_local_config(tmp_path).desktop_pet.enabled is True


def test_desktop_pet_restart_enables_preference(tmp_path, monkeypatch) -> None:
    _install_fake_electron(tmp_path)
    alive: set[int] = set()
    next_pid = 7000

    def fake_popen(cmd, **kwargs):
        nonlocal next_pid
        next_pid += 1
        alive.add(next_pid)
        return SimpleNamespace(pid=next_pid)

    monkeypatch.setattr("agent.desktop_pet.manager._terminate_process", lambda pid: alive.discard(pid))
    manager = DesktopPetManager(tmp_path, popen_factory=fake_popen, process_alive=lambda pid: pid in alive)

    payload = manager.restart()

    assert payload["enabled"] is True
    assert payload["running"] is True
    assert load_local_config(tmp_path).desktop_pet.enabled is True


def test_desktop_pet_webui_autostart_respects_preference(tmp_path) -> None:
    _install_fake_electron(tmp_path)
    calls: list[dict] = []

    def fake_popen(cmd, **kwargs):
        calls.append({"cmd": cmd, "kwargs": kwargs})
        return SimpleNamespace(pid=6060)

    save_local_config(
        tmp_path,
        LocalConfig(desktop_pet=DesktopPetPreferences(enabled=True, auto_start_with_webui=False)),
    )
    manager = DesktopPetManager(tmp_path, popen_factory=fake_popen, process_alive=lambda pid: False)

    payload = manager.start_for_webui(host="127.0.0.1", port=8765)

    assert payload["enabled"] is True
    assert payload["running"] is False
    assert calls == []


def test_desktop_pet_uses_packaged_command_without_local_electron(tmp_path, monkeypatch) -> None:
    app_dir = tmp_path / "Emperor Agent.app" / "Contents" / "MacOS"
    app_dir.mkdir(parents=True)
    executable = app_dir / "Emperor Agent"
    executable.write_text("#!/bin/sh\n", encoding="utf-8")
    monkeypatch.setenv("EMPEROR_DESKTOP_PET_CMD", f'["{executable}", "--pet-window"]')
    monkeypatch.setenv("EMPEROR_WEBUI_TOKEN", "tok-release")
    save_local_config(
        tmp_path,
        LocalConfig(desktop_pet=DesktopPetPreferences(enabled=True, auto_start_with_webui=True)),
    )
    calls: list[dict] = []
    alive: set[int] = set()

    def fake_popen(cmd, **kwargs):
        calls.append({"cmd": cmd, "kwargs": kwargs})
        alive.add(8181)
        return SimpleNamespace(pid=8181)

    manager = DesktopPetManager(tmp_path, popen_factory=fake_popen, process_alive=lambda pid: pid in alive)

    payload = manager.start(host="127.0.0.1", port=8765)

    assert payload["running"] is True
    assert calls[0]["cmd"][:2] == [str(executable), "--pet-window"]
    assert calls[0]["cmd"][-4:] == ["--webui-url", "http://127.0.0.1:8765", "--root", str(tmp_path)]
    assert calls[0]["kwargs"]["env"]["EMPEROR_WEBUI_TOKEN"] == "-".join(["tok", "release"])
    assert payload["installCommand"] == "bundled with Emperor Agent.app"


def test_desktop_pet_reports_missing_packaged_command(tmp_path, monkeypatch) -> None:
    missing = tmp_path / "Missing.app" / "Contents" / "MacOS" / "Emperor Agent"
    monkeypatch.setenv("EMPEROR_DESKTOP_PET_CMD", f'["{missing}", "--pet-window"]')
    manager = DesktopPetManager(tmp_path, process_alive=lambda pid: False)

    payload = manager.set_enabled(True)

    assert payload["enabled"] is True
    assert payload["running"] is False
    assert "Packaged desktop pet command is missing" in str(payload["lastError"])
