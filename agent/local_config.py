from __future__ import annotations

import json
from dataclasses import dataclass
from pathlib import Path
from typing import Any
from uuid import uuid4

LOCAL_CONFIG_FILE = "emperor.local.json"


@dataclass(frozen=True)
class WebUIPreferences:
    host: str = "127.0.0.1"
    port: int = 8765
    open_browser: bool = False


@dataclass(frozen=True)
class LocalConfig:
    webui: WebUIPreferences = WebUIPreferences()


def load_local_config(root: Path) -> LocalConfig:
    path = Path(root).resolve() / LOCAL_CONFIG_FILE
    if not path.exists():
        return LocalConfig()
    try:
        raw = json.loads(path.read_text(encoding="utf-8") or "{}")
    except (json.JSONDecodeError, OSError):
        return LocalConfig()
    return parse_local_config(raw)


def parse_local_config(raw: dict[str, Any] | None) -> LocalConfig:
    data = raw if isinstance(raw, dict) else {}
    webui = data.get("webui") if isinstance(data.get("webui"), dict) else {}
    return LocalConfig(
        webui=WebUIPreferences(
            host=str(webui.get("host") or "127.0.0.1"),
            port=_valid_port(webui.get("port"), 8765),
            open_browser=bool(webui.get("openBrowser", webui.get("open_browser", False))),
        )
    )


def save_local_config(root: Path, config: LocalConfig) -> Path:
    path = Path(root).resolve() / LOCAL_CONFIG_FILE
    payload = {
        "webui": {
            "host": config.webui.host,
            "port": config.webui.port,
            "openBrowser": config.webui.open_browser,
        }
    }
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_name(f".{path.name}.{uuid4().hex}.tmp")
    tmp.write_text(json.dumps(payload, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    tmp.replace(path)
    return path


def merge_webui_overrides(
    config: LocalConfig,
    *,
    host: str | None = None,
    port: int | None = None,
    open_browser: bool | None = None,
) -> WebUIPreferences:
    return WebUIPreferences(
        host=str(host or config.webui.host or "127.0.0.1"),
        port=_valid_port(port if port is not None else config.webui.port, 8765),
        open_browser=config.webui.open_browser if open_browser is None else bool(open_browser),
    )


def local_config_path(root: Path) -> Path:
    return Path(root).resolve() / LOCAL_CONFIG_FILE


def _valid_port(value: Any, default: int) -> int:
    try:
        port = int(value)
    except (TypeError, ValueError):
        return default
    if 1 <= port <= 65535:
        return port
    return default
