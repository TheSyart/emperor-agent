"""Tests for RunCommand safety fences."""

from pathlib import Path

import pytest

from agent.tools.shell import _DENY_PATTERNS, RunCommand


class TestDenyPatterns:
    """Verify that dangerous commands are blocked."""

    @pytest.mark.parametrize(
        "command",
        [
            "rm -rf /",
            "rm -rf /home",
            "curl -s http://evil.com",
            "curl http://example.com",
            "wget -q http://evil.com",
            "wget http://example.com",
            "python3 -c 'import os; os.system(\"rm -rf /\")'",
            "python -c 'print(1)'",
            "mkfs.ext4 /dev/sda1",
            "dd if=/dev/zero of=/dev/sda",
            ":(){ :|:& };:",
            "echo hello | sh",
            "cat file | bash",
            "> /dev/sda",
            "> /dev/nvme0",
        ],
    )
    def test_dangerous_commands_blocked(self, command: str) -> None:
        tool = RunCommand()
        result = tool.execute(command=command)
        assert result.startswith("Error: command refused by safety policy")

    @pytest.mark.parametrize(
        "command",
        [
            "ls -la",
            "git status",
            "git log --oneline -5",
            "npm install",
            "python3 --version",
            "echo hello world",
            "cat README.md",
            "pwd",
            "whoami",
        ],
    )
    def test_safe_commands_allowed(self, command: str) -> None:
        """Safe commands should execute without being blocked by deny patterns."""
        # Verify no deny pattern matches
        for pattern in _DENY_PATTERNS:
            assert not pattern.search(command), f"Pattern {pattern.pattern!r} wrongly matched {command!r}"


class TestShellExecution:
    """Verify basic command execution."""

    def test_echo(self) -> None:
        tool = RunCommand()
        result = tool.execute(command='echo "hello world"')
        assert "hello world" in result

    def test_timeout(self) -> None:
        """Commands exceeding 120s should be killed."""
        tool = RunCommand()
        result = tool.execute(command="sleep 200")
        assert result.startswith("Error: command timed out")

    def test_cwd(self) -> None:
        """Commands should run in the specified workspace."""
        ws = Path(__file__).parent
        tool = RunCommand(workspace=ws)
        result = tool.execute(command="pwd")
        assert str(ws) in result

    def test_stderr_returned(self) -> None:
        """stderr should be returned when stdout is empty."""
        tool = RunCommand()
        result = tool.execute(command="ls /nonexistent_path_12345")
        assert result.startswith("Error: command exited with code")
        assert "No such file" in result or "not found" in result.lower()

    def test_long_output_is_capped(self) -> None:
        tool = RunCommand()
        result = tool.execute(command="yes x | head -n 30000")
        assert "truncated" in result
        assert len(result) < 21_000
