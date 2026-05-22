from __future__ import annotations

import argparse
import webbrowser
from pathlib import Path

from aiohttp import web
from loguru import logger

from .local_config import load_local_config, merge_webui_overrides
from .web import WebUIState, create_app

__all__ = ["WebUIState", "create_app", "main"]


def main() -> None:
    parser = argparse.ArgumentParser(description="Run the Emperor Agent Web UI")
    parser.add_argument("--host", default=None)
    parser.add_argument("--port", default=None, type=int)
    parser.add_argument("--open", action="store_true", help="Open browser after starting")
    parser.add_argument("--no-open", action="store_true", help="Do not open browser")
    args = parser.parse_args()

    root = Path(__file__).parent.parent
    open_browser = True if args.open else False if args.no_open else None
    run_webui(root=root, host=args.host, port=args.port, open_browser=open_browser)


def run_webui(
    *,
    root: Path,
    host: str | None = None,
    port: int | None = None,
    open_browser: bool | None = None,
) -> None:
    prefs = merge_webui_overrides(
        load_local_config(root),
        host=host,
        port=port,
        open_browser=open_browser,
    )
    url = f"http://{prefs.host}:{prefs.port}"
    logger.info(f"Emperor Agent Web UI: {url}")
    if prefs.open_browser:
        webbrowser.open(url)
    web.run_app(create_app(root), host=prefs.host, port=prefs.port, print=None)


if __name__ == "__main__":
    main()
