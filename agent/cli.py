from __future__ import annotations

import argparse
from pathlib import Path

from rich.console import Console
from rich.panel import Panel
from rich.table import Table

from .control import ControlMode
from .local_config import load_local_config, local_config_path
from .loop import AgentLoop
from .model_config import load_model_config, validate_complete_model_entries
from .onboarding import collect_doctor_report, doctor_table, run_onboarding


def main(argv: list[str] | None = None) -> int:
    parser = build_parser()
    args = parser.parse_args(argv)
    root = Path(args.root).expanduser().resolve() if args.root else Path(__file__).parent.parent
    console = Console()
    command = args.command or "chat"

    if command == "init":
        return 0 if run_onboarding(root, console=console) else 1
    if command == "chat":
        loop = AgentLoop(root=root, verbose=False)
        loop.run()
        return 0
    if command == "web":
        from .webui import run_webui

        open_browser = None
        if args.open:
            open_browser = True
        if args.no_open:
            open_browser = False
        run_webui(
            root=root,
            host=args.host,
            port=args.port,
            open_browser=open_browser,
        )
        return 0
    if command == "status":
        print_status(root, console)
        return 0
    if command == "doctor":
        checks = collect_doctor_report(root)
        console.print(doctor_table(checks))
        return 0

    parser.print_help()
    return 2


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        prog="emperor-agent",
        description="Emperor Agent CLI",
    )
    parser.add_argument("--root", help="Project root, defaults to the installed package root")
    subparsers = parser.add_subparsers(dest="command")

    subparsers.add_parser("init", help="Open the terminal configuration wizard")
    subparsers.add_parser("chat", help="Start the CLI chat loop")
    subparsers.add_parser("status", help="Show local configuration and runtime status")
    subparsers.add_parser("doctor", help="Check local setup and suggest fixes")

    web = subparsers.add_parser("web", help="Start the WebUI server")
    web.add_argument("--host", default=None)
    web.add_argument("--port", default=None, type=int)
    web.add_argument("--open", action="store_true", help="Open browser after starting")
    web.add_argument("--no-open", action="store_true", help="Do not open browser")
    return parser


def print_status(root: Path, console: Console) -> None:
    root = Path(root).resolve()
    table = Table.grid(padding=(0, 2))
    table.add_column(style="bold cyan")
    table.add_column()
    config = load_model_config(root, create=False)
    entry = config.active_entry()
    local = load_local_config(root)
    control_mode = _control_mode(root)

    if entry:
        table.add_row("Provider", entry.provider)
        table.add_row("Entry", entry.name)
        table.add_row("Main model", entry.main_model_id)
        table.add_row("Secondary", entry.secondary_model_id or "-")
    else:
        table.add_row("Provider", "-")
        table.add_row("Entry", "未配置")
        table.add_row("Main model", "-")
        table.add_row("Secondary", "-")
    table.add_row("Control mode", control_mode)
    table.add_row("WebUI", f"http://{local.webui.host}:{local.webui.port}")
    table.add_row("Local config", str(local_config_path(root)))
    table.add_row("Model config", str(root / "model_config.json"))

    try:
        validate_complete_model_entries(config.raw)
        config_state = "[green]complete[/green]"
    except Exception as exc:
        config_state = f"[yellow]{exc}[/yellow]"
    table.add_row("Model status", config_state)
    console.print(Panel(table, title="Emperor Agent Status", border_style="cyan"))


def _control_mode(root: Path) -> str:
    try:
        from .control.store import ControlStore

        return ControlStore(root).load().mode
    except Exception:
        return ControlMode.ASK_BEFORE_EDIT.value


if __name__ == "__main__":
    raise SystemExit(main())
