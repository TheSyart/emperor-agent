from __future__ import annotations

import re
from pathlib import PurePosixPath
from typing import Any

from ..tools.protocol import ToolAdapter
from .models import ToolPermissionProfile

HIGH_RISK_COMMAND = re.compile(
    r"("
    r"\bgit\s+push\b|"
    r"\bgh\s+(pr\s+merge|release|workflow|run)\b|"
    r"\brm\s+(-[^\s]*r|-[^\s]*f|--recursive|--force)\b|"
    r"\bsudo\b|"
    r"\bchmod\b|\bchown\b|"
    r"\bdeploy\b|\bpublish\b|\brelease\b|"
    r"\bnpm\s+(install|publish)\b|"
    r"\bpip\s+install\b|"
    r"\bbrew\s+install\b|"
    r"\bdocker\s+(push|compose\s+up|run)\b|"
    r"\bkubectl\b|"
    r"\bterraform\s+(apply|destroy)\b"
    r")",
    re.IGNORECASE,
)

_SENSITIVE_PATH_PARTS = {
    ".git",
    ".team",
    "memory",
    "node_modules",
}

_SENSITIVE_PATH_PREFIXES = {
    "desktop/out",
    "desktop/dist",
}

_SENSITIVE_FILENAMES = {
    ".env",
    "model_config.json",
}


def resolve_tool_profile(tool_name: str, arguments: dict[str, Any], *, registry=None) -> ToolPermissionProfile:
    tool = registry.get(tool_name) if registry is not None else None
    read_only = bool(getattr(tool, "read_only", False)) if tool is not None else False
    concurrency_safe = bool(getattr(tool, "concurrency_safe", False)) if tool is not None else False
    destructive = not read_only
    path = _argument_path(arguments)

    if tool is not None:
        adapter = ToolAdapter(tool)
        try:
            read_only = adapter.is_read_only(arguments)
        except Exception:
            read_only = bool(getattr(tool, "read_only", False))
        try:
            concurrency_safe = adapter.is_concurrency_safe(arguments)
        except Exception:
            concurrency_safe = bool(getattr(tool, "concurrency_safe", False))
        destructive_method = getattr(tool, "is_destructive", None)
        if callable(destructive_method):
            try:
                destructive = bool(destructive_method(arguments))
            except Exception:
                destructive = not read_only
        else:
            destructive = not read_only
        path_method = getattr(tool, "get_path", None)
        if callable(path_method):
            try:
                path = path_method(arguments) or path
            except Exception:
                path = path

    return ToolPermissionProfile(
        name=tool_name,
        arguments=arguments,
        read_only=read_only,
        concurrency_safe=concurrency_safe,
        destructive=destructive,
        path=path,
        command=str(arguments.get("command") or ""),
        scheduler_action=scheduler_action(arguments),
    )


def is_high_risk_command(command: str) -> bool:
    return bool(HIGH_RISK_COMMAND.search(command or ""))


def is_sensitive_path(path: str | None) -> bool:
    if not path:
        return False
    normalized = path.replace("\\", "/").strip()
    parts = PurePosixPath(normalized).parts
    if any(part in _SENSITIVE_PATH_PARTS for part in parts):
        return True
    if any(normalized == prefix or normalized.startswith(f"{prefix}/") for prefix in _SENSITIVE_PATH_PREFIXES):
        return True
    if normalized.startswith("../") or "/../" in normalized:
        return True
    name = PurePosixPath(normalized).name
    return name in _SENSITIVE_FILENAMES or name.endswith(".local.md")


def scheduler_action(arguments: dict[str, Any]) -> str:
    return str(arguments.get("action") or "").strip().lower()


def _argument_path(arguments: dict[str, Any]) -> str | None:
    value = arguments.get("path") if isinstance(arguments, dict) else None
    return str(value) if value else None
