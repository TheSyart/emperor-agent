from __future__ import annotations

import pytest

from agent.permissions.resolvers import is_readonly_command
from agent.tools.shell import RunCommand


@pytest.mark.parametrize(
    "command",
    ["pwd", "ls", "ls -la", "git status", "git diff", "git log --oneline", "git show HEAD", "git branch"],
)
def test_inspection_commands_are_read_only(command: str) -> None:
    assert is_readonly_command(command) is True


@pytest.mark.parametrize(
    "command",
    [
        "pytest",  # executes code -> not read-only
        "python -m pytest",
        "npm test",
        "mkdir -p build",  # side effect
        "rm -rf .",
        "curl https://example.com",
        'python -c "print(1)"',
        "echo hi > out.txt",  # redirection
        "git status && rm x",  # chaining
        "git status | grep foo",  # pipe
        "",
    ],
)
def test_non_inspection_commands_are_not_read_only(command: str) -> None:
    assert is_readonly_command(command) is False


def test_run_command_tool_reports_read_only_for_inspection() -> None:
    tool = RunCommand(workspace=None)
    assert tool.is_read_only({"command": "git status"}) is True
    assert tool.is_read_only({"command": "pwd"}) is True
    assert tool.is_read_only({"command": "pytest tests/unit"}) is False
    assert tool.is_read_only({"command": "mkdir -p x"}) is False
