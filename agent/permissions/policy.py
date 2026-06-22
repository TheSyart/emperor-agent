from __future__ import annotations

import re
from pathlib import PurePosixPath
from typing import Any

from .models import PermissionDecision, PermissionMode, RiskLevel

_HIGH_RISK_COMMAND = re.compile(
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


class PermissionPolicy:
    """Claude-style execution-mode policy for high-impact tools."""

    def assess(
        self,
        tool_name: str,
        arguments: dict[str, Any] | None,
        mode: str,
        *,
        registry=None,
    ) -> PermissionDecision:
        args = arguments or {}
        if mode == PermissionMode.AUTO.value:
            return PermissionDecision.allow(tool_name=tool_name, arguments=args)
        if mode == PermissionMode.PLAN.value:
            return self._assess_plan(tool_name, args, registry=registry)
        if mode in {"normal", PermissionMode.ASK_BEFORE_EDIT.value, ""}:
            return self._assess_ask_before_edit(tool_name, args)
        return PermissionDecision.deny(
            tool_name=tool_name,
            arguments=args,
            reason=f"unknown permission mode: {mode}",
        )

    def _assess_plan(
        self,
        tool_name: str,
        arguments: dict[str, Any],
        *,
        registry=None,
    ) -> PermissionDecision:
        if tool_name == "ask_user" or tool_name == "propose_plan":
            return PermissionDecision.allow(tool_name=tool_name, arguments=arguments)
        if tool_name == "scheduler":
            if _scheduler_action(arguments) == "list":
                return PermissionDecision.allow(tool_name=tool_name, arguments=arguments)
            return PermissionDecision.deny(
                tool_name=tool_name,
                arguments=arguments,
                reason="Plan mode only allows scheduler(action='list'); durable job changes require an approved plan.",
            )
        tool = registry.get(tool_name) if registry is not None else None
        if tool is not None and bool(getattr(tool, "read_only", False)):
            return PermissionDecision.allow(tool_name=tool_name, arguments=arguments)
        return PermissionDecision.deny(
            tool_name=tool_name,
            arguments=arguments,
            reason="Plan mode only allows read-only tools plus ask_user/propose_plan.",
        )

    def _assess_ask_before_edit(
        self,
        tool_name: str,
        arguments: dict[str, Any],
    ) -> PermissionDecision:
        if tool_name == "run_command":
            command = str(arguments.get("command") or "")
            if _HIGH_RISK_COMMAND.search(command):
                return PermissionDecision.approval(
                    tool_name=tool_name,
                    arguments=arguments,
                    reason=f"high-impact shell command: {command[:160]}",
                )
        if tool_name in {"spawn_teammate", "broadcast", "shutdown_teammate"}:
            return PermissionDecision.approval(
                tool_name=tool_name,
                arguments=arguments,
                reason="Agent Team roster or broadcast operation can affect persistent teammates.",
            )
        if tool_name == "send_message" and bool(arguments.get("wake", True)):
            return PermissionDecision.approval(
                tool_name=tool_name,
                arguments=arguments,
                reason="waking a teammate can run tools in a persistent teammate context.",
            )
        if tool_name == "scheduler":
            action = _scheduler_action(arguments)
            if action == "list":
                return PermissionDecision.allow(tool_name=tool_name, arguments=arguments)
            if action in {"add", "update", "remove", "pause", "resume", "run"}:
                return PermissionDecision.approval(
                    tool_name=tool_name,
                    arguments=arguments,
                    reason="scheduler jobs persist and may run later outside the current user turn.",
                    risk=RiskLevel.HIGH.value if action in {"add", "update", "remove", "run"} else RiskLevel.MEDIUM.value,
                )
        if tool_name in {"write_file", "edit_file"}:
            path = str(arguments.get("path") or "")
            if _is_sensitive_path(path):
                return PermissionDecision.approval(
                    tool_name=tool_name,
                    arguments=arguments,
                    reason=f"sensitive or runtime path: {path}",
                )
            if tool_name == "edit_file" and bool(arguments.get("replace_all")):
                return PermissionDecision.approval(
                    tool_name=tool_name,
                    arguments=arguments,
                    reason=f"bulk replace requested in {path}",
                    risk=RiskLevel.MEDIUM.value,
                )
        return PermissionDecision.allow(tool_name=tool_name, arguments=arguments)


def _is_sensitive_path(path: str) -> bool:
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


def _scheduler_action(arguments: dict[str, Any]) -> str:
    return str(arguments.get("action") or "").strip().lower()
