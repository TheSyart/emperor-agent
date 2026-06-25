from __future__ import annotations

import os
import re
import subprocess
from pathlib import Path
from typing import Any

from loguru import logger

from .base import Tool, tool_parameters
from .context import ToolExecutionContext
from .results import ToolResult
from .schema import StringSchema, tool_parameters_schema

# 危险命令模式（regex）——匹配即拒绝
_DENY_PATTERNS = (
    re.compile(r"\brm\s+-rf\s+/"),
    re.compile(r"\bmkfs\."),
    re.compile(r"\bdd\s+if="),
    re.compile(r":\s*\(\)\s*\{"),
    re.compile(r">\s*/dev/sda"),
    re.compile(r">\s*/dev/nvme"),
    re.compile(r"\bcurl\b"),
    re.compile(r"\bwget\b"),
    re.compile(r"\bpython3?\s+-c\b"),
    re.compile(r"\|.*\bsh\b"),
    re.compile(r"\|.*\bbash\b"),
)

_MAX_OUTPUT_CHARS = 20_000
_ALLOWED_ENV_KEYS = {
    "HOME",
    "LANG",
    "LC_ALL",
    "PATH",
    "TERM",
    "TMPDIR",
    "USER",
}


def _minimal_env() -> dict[str, str]:
    env = {key: value for key, value in os.environ.items() if key in _ALLOWED_ENV_KEYS}
    env.setdefault("PATH", "/usr/bin:/bin:/usr/sbin:/sbin")
    env.setdefault("LANG", "C.UTF-8")
    return env


def _cap_output(text: str) -> str:
    if len(text) <= _MAX_OUTPUT_CHARS:
        return text
    head = text[: _MAX_OUTPUT_CHARS - 200]
    return f"{head}\n...[truncated, total {len(text)} chars]..."


@tool_parameters(tool_parameters_schema(
    command=StringSchema("要执行的 shell 命令"),
))
class RunCommand(Tool):
    name = "run_command"
    description = (
        "在当前工作区终端执行一条 shell 命令并返回输出；rm -rf /、curl/wget、python -c、管道到 sh/bash 等危险模式会被安全策略直接拒绝。"
        "仅用于测试、构建、git、包管理器或必须由 shell 执行的系统操作；不要用它读写搜文件或向用户输出文本。"
        "命令运行在受限的最小环境变量（仅 HOME/PATH/LANG 等）下，依赖额外环境变量的命令可能失败；单条命令超过 120 秒会被硬超时中断。"
        "失败后先阅读 stdout/stderr 诊断根因，不要盲目重试或绕过安全检查。"
    )
    exclusive = True
    max_result_chars = 12_000

    def __init__(self, workspace: Path | object | None = None):
        self._workspace = workspace

    def _workspace_root(self) -> Path | None:
        if self._workspace is None:
            return None
        path = getattr(self._workspace, "path", None)
        if path is not None:
            return Path(path).resolve()
        return Path(self._workspace).resolve()  # type: ignore[arg-type]

    def execute(self, command: str) -> str:
        logger.info(f"[执行命令]: {command}")

        for pattern in _DENY_PATTERNS:
            if pattern.search(command):
                logger.warning(f"Blocked dangerous command: {command[:120]}")
                return f"Error: command refused by safety policy (matches dangerous pattern: {pattern.pattern!r})"

        try:
            result = subprocess.run(  # noqa: S602 - shell tool intentionally executes shell commands after policy checks.
                command,
                shell=True,
                capture_output=True,
                text=True,
                timeout=120,
                cwd=str(self._workspace_root()) if self._workspace_root() else None,
                env=_minimal_env(),
            )
            stdout = (result.stdout or "").strip()
            stderr = (result.stderr or "").strip()
            if stdout and stderr:
                output = f"stdout:\n{stdout}\n\nstderr:\n{stderr}"
            else:
                output = stdout or stderr
            output = _cap_output(output.strip())
            logger.info(f"[命令输出]: {output[:500]}")
            if result.returncode != 0:
                return f"Error: command exited with code {result.returncode}\n{output}".strip()
            return output
        except subprocess.TimeoutExpired:
            logger.warning(f"Command timed out (>120s): {command[:80]}")
            return "Error: command timed out after 120 seconds"
        except OSError as exc:
            logger.warning(f"Command failed to start: {command[:80]}: {exc}")
            return f"Error: command failed to start: {exc}"

    def map_result(self, result: Any, context: ToolExecutionContext) -> ToolResult:
        text = str(result)
        command = str((context.arguments or {}).get("command") or "")
        timed_out = "command timed out" in text
        exit_code = _extract_exit_code(text)
        is_error = text.startswith("Error:")
        if exit_code is None and not is_error:
            exit_code = 0
        summary = (
            f"run_command timed out: {_short_command(command)}"
            if timed_out
            else f"run_command exit {exit_code if exit_code is not None else 'unknown'}: {_short_command(command)}"
        )
        return ToolResult(
            model_content=text,
            display_summary=summary,
            raw_content=text,
            metadata={
                "tool": "run_command",
                "command": command,
                "exit_code": exit_code,
                "timed_out": timed_out,
                "truncated": "truncated, total" in text,
            },
            is_error=is_error,
        )


def _extract_exit_code(text: str) -> int | None:
    match = re.search(r"command exited with code (\d+)", text)
    return int(match.group(1)) if match else None


def _short_command(command: str, limit: int = 120) -> str:
    command = " ".join(command.split())
    if len(command) <= limit:
        return command
    return f"{command[:limit - 3].rstrip()}..."
